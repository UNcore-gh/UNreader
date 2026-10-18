/** 官方 markdown 视图的划词控制器。
 *
 *  只做三件事：把 `SelectionToolbar` 挂上叠加根、把**宿主 document 选区**喂给它、把
 *  高亮动作落到笔记源文件的官方 `==` 语法。视图生命周期与浮层收口由 `MdOverlaySession`
 *  负责，本类只认它注入的这几个依赖（便于在没有 Obsidian 的环境里单独驱动）。
 *
 *  **两种形态都接管**（2026-10-11 修正：此前只认 `preview`，实时渲染下工具条根本不出现）：
 *  · 阅读模式：正文是渲染后的 DOM，选区与源码隔着一层标记 → 走 token 锚定 / 文本搜索；
 *  · 实时渲染 / 源码模式：CM6 的选区锚点本来就是源码坐标 → 直接用，零误差。
 *
 *  ⚠️ 与阅读器（readerView）的差异：md 的正文在宿主同一 document 里（不像书页在 iframe），
 *  所以选区直接用 `document.getSelection()` 拿；也**不需要** iframe 那两路补收口。
 *
 *  定位的三条通道与降级顺序见 `resolveRange`；端到端回归见 `test:md-selection`。
 */

import { MarkdownView, Notice, type App } from "obsidian";
import type { AiToolEntry } from "../types";
import type { Bounds } from "./floatingPlacement";
import { NativeChromeGate } from "./nativeChromeGate";
import { nodeChain, recordCaptureDiag } from "./selectionDiag";
import { SelectionToolbar } from "./selectionToolbar";
import {
	analyzeHighlight, demark, demarkWindow, lineOffsetAt, planHighlight,
	countNonSpace, resolveByCharSpan, resolveByCharSpanInBlock, resolveByTokens,
	resolveSelection, sameTokens, splitRuns,
	tokenIndexAtVisible, tokenize,
	type Demarked, type ResolvedRange,
} from "../core/mdSelectionMap";
import { applyEditPlan } from "../core/mdHighlightWrite";
import { supportsColorHighlight } from "../core/obsidianCapabilities";
import { t } from "../core/i18n";

export interface MdSelectionDeps {
	app: App
	view(): MarkdownView | null
	/** 叠加层根（`.unreader-md-root`）：工具条挂它下面，也是定位坐标系原点 */
	host(): HTMLElement | null
	/** 选区所在**渲染分节**对应的源码行范围（0 基闭区间），用作消歧窗口；null = 无约束 */
	windowFor(range: Range, rect: DOMRect): [number, number] | null
	/** 工具条可用区，**host 本地坐标** */
	bounds(): Bounds
	aiTools(): AiToolEntry[]
	/** text = 点击瞬间缓存的选中文字（iPad 触摸点按后活选区会塌，必须带着走） */
	runAiTool(id: string, text: string): void
	/** 未提供 = md 侧没有翻译链路 → 工具条隐藏翻译入口（不给死按钮） */
	translate?(text: string): void
	/** 阅读模式下写文件会触发官方重渲染；调用方给出「记住滚动位置」的取还器，
	 *  写入后照原样还回去（拿不到 = 不保位，不影响正确性）。 */
	holdScroll?(): (() => void) | null
}

/** 选区事件合并后的去抖（与 readerView 的选区采集同量级）。 */
const CAPTURE_DEBOUNCE_MS = 120;

/** 官方快速编辑栏让位窗口的**安全网**（见 syncAnnotationChrome）。
 *  正常路径由「手指按压正文 / 正文里刚有过选区活动」两条驱动上报开合，每次上报都重新计时；
 *  只有**整整 4 秒没有任何驱动事件**这种「抬手事件整条丢了」的失联情况才自动放行 ——
 *  它不是任何正常路径的出口。
 *
 *  为什么从 20s 降到 4s（2026-10-13 用户逐字报障：「选中文字后……obsidian 原生快速编辑
 *  工具栏……可能要等二十多秒才会出现」）：20s 那个值定在「工具条可见也算驱动」的年代，
 *  而那条驱动**没有收口事件**（工具条不收，闸门就一直在），一旦它撑着，安全网就成了
 *  唯一出口 —— 用户看到的就是「干等二十多秒」。那条驱动已摘掉（见
 *  shouldGateAnnotationChrome 里 ① 的说明），安全网回到它本来的角色：兜底。
 *  真机教训是**兜底的时长会被当成正常路径的时长**，所以它必须短到不像功能、只像保险。
 *  划词期间每次 selectionchange / pointer 事件都会重新计时，真在划词时它不会被触发。 */
const CHROME_GATE_MAX_MS = 4000;

/**
 * 判据 ③（正文里刚有过选区活动）的**活动尾巴**：最后一次 `selectionchange` 之后还能扣住
 * 官方栏多久。
 *
 * 为什么是 300ms（2026-10-14 用户报「打开还有一秒左右的延迟」）：它只需要覆盖
 * 「抬手那一刻系统还会补一两记 selectionchange / 手柄刚开始被拖」这一段 —— 真机上
 * `selectionchange` 以 **~120ms 的节流**连续触发（见文件里那条注释），300ms = 2.5 个节拍
 * 的余量：拖手柄期间一直被续上，一旦真的停手就 300ms 放行。旧的 900ms 是拿「点一下按钮」
 * 那条链的尾部语义定的，用户等到的就是那 0.9s。
 *
 * ⚠️ **续命只允许发生在外部事件里**（`onSelectionChange` → `noteSelectionActivity`），
 * 不许写进 `shouldGateAnnotationChrome` 内部：到期复查定时器也走那个判据，写在里面就是
 * 「自己喂自己」，闸门永远不放。阴性对照 `__UR_BREAK_GATE_STICKY` 注回「③ 永不过期」。
 */
const SELECTION_GATE_GRACE_MS = 300;

/** 「采集跑完、工具条最终却没出现」的裁决延迟（见 `armNoShowWatch`）。
 *
 *  为什么必须是有限延迟而不是立即判定：采集本身有一条 `CAPTURE_DEBOUNCE_MS`(120ms) 去抖，
 *  `pointerup` 那条路还要先过 `setTimeout(0)`；键盘弹起后 `repositionAlways` 的重排也在
 *  之后几帧。判早了会把「还没轮到显示」误报成故障。700ms 覆盖完整条收敛链，
 *  又远小于用户感知的「怎么还没出来」。 */
const NO_SHOW_VERDICT_MS = 700;

/**
 * 视图形态。
 *
 * `source` 一条覆盖**实时渲染**与**纯源码**两种形态 —— Obsidian 的 `getMode()` 对它们
 * 都返回 `"source"`。旧实现只认 `"preview"`，等于实时渲染下划词工具条**根本不出现**，
 * 而那恰恰是很多人默认的编辑形态。
 */
type MdMode = "preview" | "source" | "unknown";

/**
 * 探针的「阴性对照」开关：把某条通道打回旧行为，用来证明断言真的有牙口
 * （断了就必须变红）。生产路径恒为 false —— 只有 `test:md-selection` 会设这几个键。
 */
function breakFlag(name: string): boolean {
	try {
		return (window as unknown as Record<string, unknown>)[name] === true;
	} catch {
		return false;
	}
}

function modeOf(view: MarkdownView | null): MdMode {
	// 阴性对照：注回旧行为「只认 preview」
	if (breakFlag("__UR_BREAK_PREVIEW_ONLY")) {
		try {
			return (view as unknown as { getMode?: () => string })?.getMode?.() === "preview" ? "preview" : "unknown";
		} catch {
			return "unknown";
		}
	}
	try {
		const m = (view as unknown as { getMode?: () => string })?.getMode?.();
		if (m === "preview") return "preview";
		if (m === "source") return "source";
	} catch { /* 取不到 → unknown */ }
	return "unknown";
}

/** 选区所在**渲染块**（`.markdown-preview-sizer` 的直接子元素；没有 sizer 时按标签兜底）。 */
function blockAncestor(node: Node | null, sizer: Element | null): HTMLElement | null {
	let el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
	if (!el) return null;
	if (sizer) {
		let cur: HTMLElement | null = el;
		while (cur && cur.parentElement && cur.parentElement !== sizer) cur = cur.parentElement;
		return cur && cur.parentElement === sizer ? cur : null;
	}
	while (el && !/^(?:P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|TD|TH|DD|DIV)$/.test(el.tagName)) {
		el = el.parentElement;
	}
	return el;
}

/** `node` 的 `offset` 位置在 `root` 的**纯文本**里排第几个字符（-1 = 不在 root 内）。 */
function textOffsetIn(root: HTMLElement, node: Node, offset: number): number {
	if (node === root) {
		let acc = 0;
		for (let i = 0; i < offset && i < root.childNodes.length; i++) {
			acc += root.childNodes[i]?.textContent?.length ?? 0;
		}
		return acc;
	}
	const doc = node.ownerDocument ?? root.ownerDocument;
	if (!doc) return -1;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let acc = 0;
	let cur = walker.nextNode();
	while (cur) {
		if (cur === node) return acc + Math.min(Math.max(offset, 0), cur.nodeValue?.length ?? 0);
		acc += cur.nodeValue?.length ?? 0;
		cur = walker.nextNode();
	}
	return -1;
}

/** Range 端点的「节点 + 偏移」归一成文本节点口径（端点可能是元素 + 子节点索引）。 */
function normalizePoint(node: Node, offset: number): { node: Node; offset: number } {
	if (node.nodeType === Node.TEXT_NODE) return { node, offset };
	const kids = node.childNodes;
	if (offset < kids.length) return { node: kids[offset] ?? node, offset: 0 };
	// 指向末尾：退到最后一个子节点之后
	let last: Node = node;
	while (last.lastChild) last = last.lastChild;
	return { node: last, offset: last.nodeType === Node.TEXT_NODE ? (last.nodeValue?.length ?? 0) : 0 };
}

/** 元素的渲染口径文本：`innerText` 优先（会按块级补换行），拿不到再退 `textContent`。 */
function renderTextOf(el: HTMLElement): string {
	try {
		const it = (el as HTMLElement & { innerText?: string }).innerText;
		if (typeof it === "string" && it.length > 0) return it;
	} catch { /* 部分环境读 innerText 会抛 */ }
	return el.textContent ?? "";
}

interface Pending {
	text: string
	/**
	 * 选区跨了几个词（片段）。**必须用 `Selection.toString()` 口径**：它在块边界会补
	 * 换行（跨两个列表项得到「苹果\n香蕉」= 2 个词），而 `Range.toString()` 只拼接
	 * 文本节点（得到「苹果香蕉」= 1 个词）—— 用后者会让跨块选区只高亮第一块。
	 */
	tokenCount: number
	rect: DOMRect
	/** 采集时的 Range（克隆）：锚定要用它的端点，只存 rect 不够 */
	range: Range | null
	/** source 模式下由编辑器直接给出的源码区间（无需反查） */
	editor?: { from: number; to: number }
}

export class MdSelectionController {
	private readonly toolbar: SelectionToolbar;
	/** 最近一次有效选区（点色点那一刻 DOM 选区往往已被系统清掉，必须提前缓存）。 */
	private pending: Pending | null = null;
	private attached = false;
	private rafId = 0;
	private timer = 0;
	/** 官方快速编辑栏的让位窗口是否开着（见 syncAnnotationChrome） */
	private chromeGateOn = false;
	private chromeGateTimer = 0;
	/** **本次交互还允许落闸吗**（2026-10-14 反闪烁的唯一开关）。
	 *  开闸只有两个入口：**手指按下正文**（beginChromeGesture）与**选区从空变成非空**
	 *  （noteSelectionActivity 的「新选区会话」）。放过一次即关，直到下一次这两个入口之一
	 *  —— 于是同一条选区被反复 `selectionchange` 续命时，闸门**不可能**开了又关、关了又开
	 *  （那正是用户报的「工具栏闪烁」：每开合一次就 hide/show 一次官方栏，52px 的 spacer
	 *  跟着撤掉再挂回，正文上下跳）。 */
	private gateLatched = false;
	/** 上一次求值时的「正文里有非空选区」事实（用来认出**新选区会话**，见 noteSelectionActivity）。 */
	private selectionWasLive = false;
	/** ③（正文里刚有过选区活动）的**起算时刻**（`performance.now()`）；0 = 未起算。
	 *  只由外部 `selectionchange` 续命（见 `noteSelectionActivity`），见
	 *  `SELECTION_GATE_GRACE_MS`。 */
	private selectionGateAt = 0;
	/** ③ 到期复查定时器（只有「②都退了、单靠 ③ 撑着」时才排）。 */
	private selectionGateTimer = 0;
	/** 手指/笔正压在**笔记正文**上的手势（见 onPointerDown / shouldGateAnnotationChrome） */
	private gesture: { pointerId: number } | null = null;
	/** 最近一次采集的**自述结论**（见 `narrate` / `armNoShowWatch`）：
	 *  `null` = 成功走到 `showFor`；否则 = 早退原因（`view-null` / `no-text` / `scope-miss`…）。
	 *  真机报「选中了文字但工具条不出现」时，这一个字段就指认了断在哪一环。 */
	private lastCaptureNote: string | null = null;
	/** 伴随 `lastCaptureNote` 的关键事实（选区落在哪一层、正文容器找没找到…），落盘时带走。 */
	private lastCaptureFacts: Record<string, unknown> = {};
	/** 「采集跑完但工具条最终不可见」的裁决定时器（见 armNoShowWatch）。 */
	private noShowTimer = 0;

	constructor(private readonly deps: MdSelectionDeps) {
		this.toolbar = new SelectionToolbar({
			onCopy: text => this.copy(text),
			// 色点高亮 = 执行「高亮选中文本」命令的**同一实现**（`highlightCurrent` 就是
			// main.ts 那条 `highlight-selection-*` 命令调用的入口，见下方方法注释）。
			// 2026-10-11 用户要求「用命令替换按钮的功能实现逻辑」：按钮不再自己调
			// `applyHighlight`，改走命令入口 —— 高亮这件事从此只有一份实现。
			// ⚠️ 不能真去 `executeCommandById("unreader:highlight-selection-*")`：
			// 命令回调按 `getActiveReader()` 解题主，它的兜底是「最近聚焦、仍挂在 DOM 上
			// 的阅读器」；分屏（书 + 笔记同开）下会把这枚笔记里的色点派发到那本书上。
			// 按钮**明确知道自己在哪个宿主**，所以直接调该宿主的命令入口，语义等价且不串台。
			// 阴性对照 `__UR_BREAK_DOT_DIRECT` 注回旧行为（直连 applyHighlight）→
			// test:md-selection 的 P13 必须变红。
			onHighlight: name => {
				if (breakFlag("__UR_BREAK_DOT_DIRECT")) { void this.applyHighlight(name); return; }
				// 命令入口在「选区缓存已被清掉、现采也采不到」时返回 false。命令层
				// （main.ts）此时会弹 noticeNoSelectionToHighlight；色点是同一实现的
				// 另一个调用方，必须给出同一句提示 —— 绝不静默收场。
				if (!this.highlightCurrent(name)) new Notice(t("noticeNoSelectionToHighlight"));
			},
			// md 没有旁车笔记可落评论；按钮已被 setCommentEnabled(false) 收起，这里只是防御
			onComment: () => undefined,
			onTranslate: text => this.deps.translate?.(text),
			onRunAiTool: (id, text) => {
				// 先把点击瞬间的文本攥在手里：hide() 会清工具条快照，之后再也拿不到
				this.toolbar.hide();
				this.deps.runAiTool(id, text);
			},
		});
		// 与阅读器同一套口径：贴底居中（固定定位），避开系统选区菜单的原地弹出
		this.toolbar.setFixed(true);
		this.toolbar.setBoundsResolver(() => this.deps.bounds());
		// md 视图：source 模式键盘可能正开着，工具条出现后还要跟随键盘动画 /
		// .mobile-toolbar 迟到（iPad 实测可晚 ~2s）重排（阅读器侧不打开，旧契约不变）。
		this.toolbar.setRepositionAlways(true);
		// 症状③（2026-10-13 用户逐字报障）：「obsidian 工具栏显示后，工具栏的上边框和
		// 插件工具栏的下边框没有重合」⇒ 本宿主打开「与实测到的官方栏顶边逐像素重合」。
		// 只开 md 侧：阅读器那条 8px 由 `test:comment-mobile` 四条断言（含阴性档 A2）钉住，
		// 不在这一轮里一起动。开关本身是一条**路由**，阴性 `?break=snap` 单独关它。
		this.toolbar.setSnapToHardBottom(true);
		this.toolbar.setCommentEnabled(false);
		if (!this.deps.translate) this.toolbar.setTranslateEnabled(false);
		// 划词期间让官方快速编辑栏从源头消失（原因见 syncAnnotationChrome）。
		// **只订阅状态**：工具条自身的收口出口有十几条，逐条挂钩必然漏。
		// 订阅回调不读参数 —— 它现在**不是驱动**（工具条可见不再是判据，见
		// shouldGateAnnotationChrome 里 ① 的说明），只是一条「重新求值」的廉价时机：
		// 工具条收起那一刻顺手判一次，能更早把闸门放掉。
		this.toolbar.setOnVisibilityChange(() => this.syncAnnotationChrome());
	}

	// ---------- 官方快速编辑栏的让位（2026-10-12） ----------

	/**
	 * 手机上「滑动选词」时官方 `.mobile-toolbar`（快速编辑栏）会插进 `.app-container` 底部，
	 * 并靠流内的 `spacerEl`（52px）把整条 flex 链顶上去。它与我们的划词工具条是**两个宿主
	 * 两套皮**，几何上必然互相压（用户 2026-10-12 报障：「滑动选词容易误触、取消选中，或者
	 * 不小心打开 obsidian 如图所示的工具栏（限制行宽 / 页面内标题）」—— 手指落点正好落在
	 * 那栏按钮上）。
	 *
	 * 它由「编辑器聚焦」驱动（asar 实测 `q8.update()`：`workspace.activeEditor?.editor.hasFocus()`，
	 * Android 上再与 `hasKeyboardVisible || isMultiWindowMode` 相与），会**迟到**且中途不发任何
	 * 事件 ⇒ 前三轮「几何避让」都治不了根（见 `test:md-kb` 的 `dockbase` 档与库根取证通道）。
	 * 这里换掉问题本身：划词窗口内从**源头**不让它出现 —— 用 `NativeChromeGate` 只接管
	 * `mobileToolbar.show`（**`navbar:false`**：底栏显隐是沉浸模式的事，划词无权干预）。
	 *
	 * ## 窗口必须从「手指按下」就开始（2026-10-12 补，用户报「看不到区别」后复核发现）
	 *
	 * 第一版只在**我们自己的划词工具条显示之后**才落闸。但官方那栏的门控是「编辑器是否聚焦」、
	 * **不是**「有没有选区」：手指一按下、编辑器一聚焦，它就已经 `show()` 了 ——
	 * 落闸晚一步，52px 的 `spacerEl` 早把正文顶上去、按钮也早就在那儿等着被误触。
	 * ⇒ 判据必须包含「按下」这一刻。
	 *
	 * ## 窗口**只**包含「手指还压着」＋「刚刚还在动选区」（2026-10-13 收敛）
	 *
	 * 旧判据有三条驱动：① 我们的划词工具条在屏上；② 手指/笔正压在**笔记正文**上
	 * （含 0 位移的点按）；③ 正文里存在**非空选区**。其中 ① **已于 2026-10-13 摘除**：
	 * 它是唯一没有收口事件的一条（工具条不收，判据恒真），用户报障的「原生快速编辑栏
	 * 要等二十多秒才出现」就是它撑着闸门、只能等安全网放行 —— 详见
	 * `shouldGateAnnotationChrome` 的 ① 说明。
	 *
	 * 现行判据只有两条：**② 手指/笔正压在正文上**（唯一真有误触风险的一段）与
	 * **③ 刚刚还在动选区**（抬手后 300ms 的尾巴，见 SELECTION_GATE_GRACE_MS）。
		 * 点按行为不变：按下即拦住官方那栏的 `show()`（点按收口后再放行），
	 * 抬手后判据为假 ⇒ 释放并补一次官方 `update()`，那栏照常出现。
	 *
	 * 释放后补一次官方 `update()`：官方只在焦点/键盘事件上求值，不补这一次，用户会遇到
	 * 「工具条回来了、快速编辑栏却再也不出现」。
	 * 阴性对照 `__UR_BREAK_ANNO_CHROME`（整条不发闸门）⇒ `test:md-selection` 的 P24 必须红。
	 */
	private syncAnnotationChrome(): void {
		if (breakFlag("__UR_BREAK_ANNO_CHROME")) return;
		try {
			const on = this.shouldGateAnnotationChrome();
			if (this.chromeGateTimer) {
				window.clearTimeout(this.chromeGateTimer);
				this.chromeGateTimer = 0;
			}
			if (this.selectionGateTimer) {
				window.clearTimeout(this.selectionGateTimer);
				this.selectionGateTimer = 0;
			}
			if (on) {
				// 每次驱动都重新计时：只有「4 秒完全没有任何驱动事件」才允许自动放行
				this.chromeGateTimer = window.setTimeout(() => {
					this.chromeGateTimer = 0;
					this.applyChromeGate(false);
				}, CHROME_GATE_MAX_MS);
				// ③ 是唯一「靠计时收敛」的驱动 ⇒ 它必须自己带一个到点复查。
				// 不排这一次，抬手之后要干等安全网，官方那栏才回来。
				const remain = this.selectionGateRemaining();
				if (remain > 0) {
					this.selectionGateTimer = window.setTimeout(() => {
						this.selectionGateTimer = 0;
						this.syncAnnotationChrome();
					}, remain);
				}
			} else {
				this.selectionGateAt = 0;
			}
			this.applyChromeGate(on);
		} catch { /* 让位失败只影响观感，绝不打断划词 */ }
	}

	private applyChromeGate(on: boolean): void {
		const was = this.chromeGateOn;
		this.chromeGateOn = on;
		if (on) {
			NativeChromeGate.sync(
				this,
				this.deps.app as unknown as object,
				// ⚠️ 判据必须是**实测**（手指是否按在正文上 / 正文里选区刚刚活没活过），
				// 不能只是闩住的意图布尔量（2026-10-12 加固）：`chromeGateOn` 依赖「每一次变化
				// 都上报」这条不变量，而驱动它的出口有十几条（工具条各收口按钮 / Esc / 点空白 /
				// 高亮完成 / 全沉浸 / 宿主主动 hide / 手势中断…）。漏报一条，闸门就会**超出划词
				// 窗口**继续屏蔽官方快速编辑栏；而闸门替换的是挂在 **App 实例**上的入口 ⇒ 症状
				// 不是「划词时被压住」，而是「**所有视图里原生快速编辑栏都不再出现**」。
				// 复用同一个 `shouldGateAnnotationChrome()`，闸门在物理上不可能活得比「窗口」更久。
				() => this.chromeGateOn && this.shouldGateAnnotationChrome(),
				{ navbar: false },
					this.deps.host()?.ownerDocument ?? document,
			);
			return;
		}
		// **放过一次 = 本次交互结束**：关掉开闸闩，直到下一次「手指按下」或「新选区成型」。
		// 这一行是反闪烁的另一半（见 gateLatched / shouldGateAnnotationChrome 的不变式二）：
		// 没有它，同一条选区后续的每一记 selectionchange 都会把闸门重新装上、官方栏再闪一次。
		this.gateLatched = false;
		if (!was) return;
		NativeChromeGate.release(this);
		// 阴性对照 `__UR_BREAK_ANNO_CHROME_PULSE`：只打断这一记补值（闸门本体照常），
		// 用来给「释放后必须补一次 update()」那条断言单独上牙口 —— 否则它在
		// 「整条闸门不发」的档里也会红，分不出是哪一个源头的错。
		if (breakFlag("__UR_BREAK_ANNO_CHROME_PULSE")) return;
		const toolbar = (this.deps.app as unknown as { mobileToolbar?: { update?: () => void } }).mobileToolbar;
		try {
			toolbar?.update?.();
		} catch { /* 补一次求值而已，失败不影响功能 */ }
	}

	/** 让位窗口的**唯一判据**。两条不变式，缺一条就会退回用户报的两个毛病：
	 *
	 *  ## 不变式一：官方栏已挂在屏上时不拦截它
	 *
	 *  `officialBarMounted()` 为真（官方栏已经挂着）⇒ 立刻放行、一次都不碰。
	 *  为什么（2026-10-14 用户报「工具栏闪烁」）：`NativeChromeGate` 从源头拦住官方
	 *  `show()`。当官方栏已经在屏上时，再装闸会让后续官方重求值被吞掉，栏的显隐状态
	 *  会与焦点/布局脱节。已可见的栏没有「突然插入到手指底下」的风险，所以应直接放行，
	 *  不接管它。
	 *
	 *  ## 不变式二：一次交互**最多**进入一次抑制窗口（`gateLatched`）
	 *
	 *  开闸只认两个入口：手指按下正文 / 选区从空变成非空。放过一次就关，直到下一个入口。
	 *  真机上 `selectionchange` 以 ~120ms 节流连发（拖手柄、编辑器自身的选区同步都会发），
	 *  旧判据每次都重新落闸 ⇒ 官方 `show()` 被反复拦截 ⇒ 显示时机与选区交互脱节。
	 *
	 *  ## 窗口本身只剩「手指还压着」+ 一小段选区尾巴
	 *
	 *  ①（我们自己的工具条在屏上）已于 2026-10-13 摘除：它是唯一没有收口事件的一条，
	 *  一旦撑着就只能等安全网，用户报的「等二十多秒」就是它。而「两条栏共存」本来就是
	 *  既定设计（10-13 用户要求「obsidian 工具栏显示后，工具栏的上边框和插件工具条的下边框
	 *  要重合」，`setSnapToHardBottom` 就是为它开的）。
	 *
	 *  负面对照：`__UR_BREAK_GATE_BARVISIBLE`（把 ① 注回）⇒ P28 必红；
	 *  `__UR_BREAK_GATE_YANK`（注回上面两条不变式之前的行为）⇒ P29 两条必红。 */
	private shouldGateAnnotationChrome(): boolean {
		// 桌面端没有官方快速编辑栏：asar 逐字 —— `Ql.isMobile && (this.mobileToolbar = new q8(this))`
		// ⇒ 桌面 `app.mobileToolbar` 恒为 null。没有可接管的对象就别建闸门，
		// 省得每次按下都装一遍补丁又拆一遍（也保证桌面端零行为变化）。
		if (!(this.deps.app as unknown as { mobileToolbar?: unknown }).mobileToolbar) return false;
		// 阴性对照：把已摘除的 ①「我们的工具条在屏上」注回判据。
		if (this.toolbar.visible && breakFlag("__UR_BREAK_GATE_BARVISIBLE")) return true;
		const legacyYank = breakFlag("__UR_BREAK_GATE_YANK");
		// 不变式一：已经挂在屏上的官方栏一律不碰（注回旧行为时跳过这一条）。
		if (!legacyYank && this.officialBarMounted()) return false;
		// 不变式二：本次交互已经放过一次 ⇒ 不再落闸（注回旧行为时跳过这一条）。
		if (!legacyYank && !this.gateLatched) return false;
		// ② 手指/笔正压在笔记正文上（含 0 位移的点按：它同样会触发官方那栏的「聚焦即显示」）。
		//    这是**唯一**真有误触风险的一段 —— 官方那栏会插进屏幕底、把正文顶上去 52px，
		//    手指落点正好落在它的按钮上。收口事件：pointerup / pointercancel / touches 清空
		//    / 页面转后台（见 attach 里那几条补通道）。
		if (this.gesture) return true;
		// ③ 正文里「刚刚还在动选区」的活动尾巴（见 SELECTION_GATE_GRACE_MS）。
		//    ⚠️ **只读不写**：起算时刻只由外部 `selectionchange` 续（`noteSelectionActivity`），
		//    写在这里就等于「到期复查定时器自己给自己续命」，闸门永远不放。
		if (!this.bodySelectionLive()) {
			this.selectionGateAt = 0;
			return false;
		}
		// 阴性对照：注回「③ 永不过期」的旧行为（`test:md-selection` P26）
		if (breakFlag("__UR_BREAK_GATE_STICKY")) return true;
		if (this.selectionGateAt === 0) return false;
		return performance.now() - this.selectionGateAt < SELECTION_GATE_GRACE_MS;
	}

	/** 官方快速编辑栏此刻是不是**已经挂在屏上**。
	 *
	 *  asar 实测：官方 `MobileToolbar` 就一个状态位 —— `show()` 里 `isVisible||(isVisible=!0,
	 *  appContainerEl.appendChild(containerEl))`，`hide()` 里 `isVisible&&(isVisible=!1,
	 *  containerEl.detach())`。所以「`isVisible` 为真」与「`.mobile-toolbar` 在 DOM 里」
	 *  是同一件事，两个都读（字段万一被官方改名，退回 DOM 判据；两条都拿不到 ⇒ 当作
	 *  「不在屏上」，闸门行为与本次改动之前一致，最坏只是闪烁回来，不会扣住那栏）。 */
	private officialBarMounted(): boolean {
		try {
			const toolbar = (this.deps.app as unknown as { mobileToolbar?: { isVisible?: unknown } }).mobileToolbar;
			if (toolbar?.isVisible === true) return true;
			return !!this.ownerDoc().querySelector(".mobile-toolbar");
		} catch {
			return false;
		}
	}

	/** 正文里当前那份选区是不是「我们管的」那一份：非空 ∧ 锚点落在本视图正文内。 */
	private bodySelectionLive(): boolean {
		try {
			const sel = this.ownerDoc().getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
			const content = this.deps.view()?.contentEl as Node | undefined;
			const anchor = sel.anchorNode;
			return !!content && !!anchor && content.contains(anchor);
		} catch {
			return false;
		}
	}

	/** 选区事件的**活力刷新**：外部 `selectionchange` 一到，就把 ③ 的起算时刻拨到现在；
	 *  选区空了 / 不在正文里 ⇒ 归零（立刻失去 ③）。
	 *
	 *  顺带认出**新选区会话**（选区从「空 / 不在正文里」变成「非空」）：只有这一刻才允许
	 *  重新开闸（`gateLatched`）。同一条选区的持续变化**不许**开闸 —— 那是闪烁的来源。
	 *
	 *  ⚠️ **只许在外部事件里调**（见 `SELECTION_GATE_GRACE_MS`）：到期复查定时器走的也是
	 *  `syncAnnotationChrome`，若把续命写进判据内部，③ 就会自己喂自己、闸门永不放行。 */
	private noteSelectionActivity(): void {
		const live = this.bodySelectionLive();
		if (live && !this.selectionWasLive) this.gateLatched = true;
		this.selectionWasLive = live;
		this.selectionGateAt = live ? performance.now() : 0;
	}

	/** ③ 还剩多少毫秒到期；0 = 「当前不是单靠 ③ 撑着」或已到期（见 SELECTION_GATE_GRACE_MS）。 */
	private selectionGateRemaining(): number {
		if (this.selectionGateAt === 0) return 0;
		// ② 成立时不排复查：它有确定的收口事件，而且**不给它加时限** ——
		// 长按拖动选词中途把官方那栏放出来，就是回到「手指落到它按钮上」那个原 bug。
		if (this.gesture) return 0;
		const remain = SELECTION_GATE_GRACE_MS - (performance.now() - this.selectionGateAt);
		return remain > 0 ? remain : 0;
	}

	/** 起手点是否落在**笔记正文**里（工具栏、我们自己的浮层都不算）。 */
	private isNoteBodyTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Node)) return false;
		const content = this.deps.view()?.contentEl as Node | undefined;
		return !!content && content.contains(target);
	}

	/** 手指/笔落在正文上 → 立刻落闸（不能等 `selectionchange`：官方那栏在**聚焦**时就 show 了）。
	 *  这里也是「本次交互允许落闸」的**主入口**（见 `gateLatched`）：一次按下 = 一次开闸机会。 */
	private beginChromeGesture(e: PointerEvent): void {
		if (e.pointerType === "mouse") return; // 鼠标没有「滑动选词」这件事
		if (!this.isNoteBodyTarget(e.target)) return;
		this.gesture = { pointerId: e.pointerId };
		this.gateLatched = true;
		this.syncAnnotationChrome();
	}

	/** 抬手 / 手势被系统中断 → 手势这一条不再成立；选区还在的话判据仍为真（③）。 */
	private endChromeGesture(e: PointerEvent): void {
		if (!this.gesture || this.gesture.pointerId !== e.pointerId) return;
		this.gesture = null;
		this.syncAnnotationChrome();
	}

	// ---------- 「选中了字、工具条却没出现」的上游自述取证（2026-10-12） ----------

	/** 记下这次采集的结果与关键事实。每条早退都写一次；成功走到 `showFor` 用
	 *  `narrateShown` 清成「不是早退」。
	 *
	 *  为什么值得为它写满每一条出口：真机没有 devtools，而「工具条不出现」有**七种**成因
	 *  （视图形态取不到 / 选区为空 / 选区落在自家浮层 / 正文容器判据没命中 / range 取不到 /
	 *  采集根本没被调到 / 采集成功但随后被收掉）。没有这一串自述，只能靠猜。 */
	private narrate(note: string, facts: Record<string, unknown> = {}): void {
		this.lastCaptureNote = note;
		this.lastCaptureFacts = facts;
	}

	/** 采集成功（走到了 `showFor`）：自述清空 = 「这次没有早退」。
	 *  此时若裁决仍发现工具条不可见，那就是「显示了又被收掉」，另记一类（见 `verdictNoShow`）。 */
	private narrateShown(facts: Record<string, unknown>): void {
		this.lastCaptureNote = null;
		this.lastCaptureFacts = facts;
	}

	/** 每次采集都挂一次「工具条最终出现了吗」的裁决（见 `NO_SHOW_VERDICT_MS`）。
	 *
	 *  为什么不能只在**早退**时落盘：另一种同样常见的形态是「采集成功、工具条也显示了，
	 *  但随后被某条出口收掉」—— 用户看到的就是「闪一下 / 完全不出现」，只挂在早退上会漏掉。
	 *  所以这里统一回看**最终状态**。
	 *
	 *  同一次拖动里的多次采集共用同一个定时器：采集 ~120ms 一次，若每次都重新计时，
	 *  拖动期间永远等不到裁决。 */
	private armNoShowWatch(): void {
		if (this.noShowTimer) return;
		this.noShowTimer = window.setTimeout(() => {
			this.noShowTimer = 0;
			this.verdictNoShow();
		}, NO_SHOW_VERDICT_MS);
	}

	/** 裁决「跑完采集链、工具条仍不可见」是不是故障，是则落盘（被 `armNoShowWatch` 调）。 */
	private verdictNoShow(): void {
		try {
			if (!this.attached) return;
			if (this.toolbar.visible) return;
			// 「用户只是点了一下、压根没选字」是正常路径，不是故障 —— 不豁免它的话，
			// 每次点屏都会写一份盘。**只有 `no-text` 享受这个豁免**：其余每一条早退
			// 都意味着「有字可选却没抓到」，都是要修的东西。
			if (this.lastCaptureNote === "no-text") return;
			const view = this.deps.view();
			const facts = this.lastCaptureFacts;
			recordCaptureDiag({
				// `null` 自述 = 采集成功 ⇒ 这一类是「显示了又被收掉」
				reason: this.lastCaptureNote ?? "shown-then-hidden",
				mode: modeOf(view),
				attached: this.attached,
				viewOk: !!view,
				hostFound: !!this.deps.host(),
				rangeCount: typeof facts.rangeCount === "number" ? facts.rangeCount : -1,
				selLength: typeof facts.selLength === "number" ? facts.selLength : -1,
				selCollapsed: typeof facts.selCollapsed === "boolean" ? facts.selCollapsed : null,
				scopeSelector: typeof facts.scopeSelector === "string" ? facts.scopeSelector : null,
				scopeFound: facts.scopeFound === true,
				scopeContainsAnchor: facts.scopeContainsAnchor === true,
				// 2026-10-13 补：真机上「同一个 leaf 里有几份同名容器 / 我最终挑了哪一份」
				// 是 `scope-miss` 这一类故障的**唯一**可判读依据（见 resolveScope）。
				scopeCandidates: typeof facts.scopeCandidates === "number" ? facts.scopeCandidates : -1,
				scopeContaining: typeof facts.scopeContaining === "number" ? facts.scopeContaining : -1,
				scopePick: typeof facts.scopePick === "string" ? facts.scopePick : null,
				inOwnHost: facts.inOwnHost === true,
				selPreview: typeof facts.selPreview === "string" ? facts.selPreview : "",
				// 闸门是**全局** patch：这张注册表能直接指认「是不是某个 owner 判据恒真，
				// 把官方快速编辑栏在所有视图里一起屏蔽掉了」（见 NativeChromeGate.debugState）
				gate: NativeChromeGate.debugState(),
				containerEl: this.toolbar.containerEl,
				facts,
			});
		} catch {
			/* 取证绝不能弄脏划词本身 */
		}
	}

	/** 当前文档（popout 窗口里是另一个 Document）。 */
	private ownerDoc(): Document {
		return this.deps.host()?.ownerDocument ?? document;
	}

	attach(): void {
		const host = this.deps.host();
		if (!host || this.attached) return;
		this.attached = true;
		host.appendChild(this.toolbar.containerEl);

		const doc = this.ownerDoc();
		doc.addEventListener("selectionchange", this.onSelectionChange);
		doc.addEventListener("pointerup", this.onPointerUp);
		doc.addEventListener("pointercancel", this.onPointerCancel);
		// 捕获阶段：工具条自身的 pointerdown 已 stopPropagation，但仍要在文档层兜住外点
		doc.addEventListener("pointerdown", this.onPointerDown, true);
		doc.addEventListener("keydown", this.onKeyDown, true);
		// scroll 不冒泡，用捕获阶段才能收到阅读区自己的滚动
		doc.addEventListener("scroll", this.onScroll, true);
		// ---- ② 的**收口补通道**（2026-10-13 加固，见 shouldGateAnnotationChrome 的 ②）----
		// ② 一旦漏收口就会把官方那栏扣到安全网（用户报障的那种「等二十多秒」），所以「抬手」
		// 这件事用四条彼此独立的信号认：doc 上的 pointerup/cancel（上面两条）、**window 捕获**
		// （事件目标被摘出 DOM / 事件只到 window 时 doc 收不到）、**touches 清空**（触摸通道，
		// pointer 事件被系统吞掉时它仍在）、**页面转后台**（切走那一刻手指不可能还压着）。
		// 全部只做「结清手势」这一件事，幂等，重复到达无副作用。
		const win = doc.defaultView ?? window;
		// 阴性对照 `__UR_BREAK_GATE_COMPAT_RELEASE`：不注册这三条补通道（= 只有 doc 上那两条
		// pointerup/cancel 收口）⇒ `test:md-selection` 的 P28「touchend 清空后放行」必须变红，
		// 其余断言必须仍绿 —— 证明这条通道真的有承重，而不是被别的路径顺带覆盖。
		if (!breakFlag("__UR_BREAK_GATE_COMPAT_RELEASE")) {
			win.addEventListener("pointerup", this.onWindowRelease, true);
			win.addEventListener("pointercancel", this.onWindowRelease, true);
			doc.addEventListener("touchend", this.onTouchRelease, true);
			doc.addEventListener("touchcancel", this.onTouchRelease, true);
			doc.addEventListener("visibilitychange", this.onDocVisibility);
		}
	}

	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		const doc = this.ownerDoc();
		doc.removeEventListener("selectionchange", this.onSelectionChange);
		doc.removeEventListener("pointerup", this.onPointerUp);
		doc.removeEventListener("pointercancel", this.onPointerCancel);
		doc.removeEventListener("pointerdown", this.onPointerDown, true);
		doc.removeEventListener("keydown", this.onKeyDown, true);
		doc.removeEventListener("scroll", this.onScroll, true);
		const win = doc.defaultView ?? window;
		win.removeEventListener("pointerup", this.onWindowRelease, true);
		win.removeEventListener("pointercancel", this.onWindowRelease, true);
		doc.removeEventListener("touchend", this.onTouchRelease, true);
		doc.removeEventListener("touchcancel", this.onTouchRelease, true);
		doc.removeEventListener("visibilitychange", this.onDocVisibility);
		if (this.rafId) { window.cancelAnimationFrame(this.rafId); this.rafId = 0; }
		if (this.timer) { window.clearTimeout(this.timer); this.timer = 0; }
		if (this.noShowTimer) { window.clearTimeout(this.noShowTimer); this.noShowTimer = 0; }
		this.pending = null;
		this.toolbar.hide();
		this.toolbar.containerEl.remove();
		// 视图关闭 / 切模式：让位窗口必须跟着散 —— 否则官方快速编辑栏在本会话里再也出不来
		if (this.chromeGateTimer) {
			window.clearTimeout(this.chromeGateTimer);
			this.chromeGateTimer = 0;
		}
		if (this.selectionGateTimer) {
			window.clearTimeout(this.selectionGateTimer);
			this.selectionGateTimer = 0;
		}
		this.selectionGateAt = 0;
		this.selectionWasLive = false;
		this.gesture = null;
		this.applyChromeGate(false);
	}

	/** 主动收起（由宿主在某些时机调用，例如切模式、打开别的面板）。 */
	hide(): void {
		this.toolbar.hide();
	}

	/** 自定义命令按钮 → 划词工具条槽（配置变更时全量重推，空数组摘槽）。 */
	setCustomButtons(
		buttons: Array<{ id: string; commandId: string; label: string; icon: string }>,
		onRun: (commandId: string) => void,
		commandExists?: (commandId: string) => boolean,
	): void {
		this.toolbar.setCustomButtons(buttons, onRun, commandExists);
	}

	/** 「高亮选中文本」命令入口：pending 选区有效直接高亮；已被 onPointerDown
	 *  清掉时（点左缘按钮等）现场重采一次当前宿主选区再高亮。返回是否成功执行，
	 *  供命令层决定是否给 Notice。
	 *
	 *  这是高亮的**唯一实现入口**：main.ts 注册的 `highlight-selection-*` 命令
	 *  （经 `mdOverlay.highlightSelectionOnActiveLeaf`）与划词工具条的色点都调它
	 *  （2026-10-11 用户要求「用命令替换按钮的功能实现逻辑」）。 */
	highlightCurrent(colorName: string): boolean {
		if (!this.pending) {
			this.capture();
			if (!this.pending) return false;
		}
		void this.applyHighlight(colorName);
		return true;
	}

	// ---------- 选区采集 ----------

	private readonly onSelectionChange = (): void => {
		if (!this.attached) return;
		// ③（正文里刚有过选区活动）的**续命点**：必须在 rafId 早退之前 ——
		// 拖动过程中的高频 selectionchange 会在「已排队」时被整批跳过，而 ③ 就靠它续。
		this.noteSelectionActivity();
		this.syncAnnotationChrome();
		if (this.rafId) return;
		this.rafId = window.requestAnimationFrame(() => {
			this.rafId = 0;
			this.scheduleCapture();
		});
	};

	/** pointerup 后再取一次：iOS 上 `selectionchange` 可能先于选区落定。
	 *
	 *  ⚠️ **必须放行「落在工具条自身上的 pointerup」**（2026-10-11 报障
	 *  「markdown 阅读界面高亮后 / 点工具条后，选中工具栏关不掉」的根因）。
	 *
	 *  阅读器侧不存在这个问题：它的正文在 **iframe** 里、工具条在宿主 document，
	 *  点工具条按钮的那次 pointerup 根本进不了 iframe 的监听，两层天然隔离。
	 *  md 的正文与工具条在**同一个 document**，这层隔离没有了，于是：
	 *    点关闭按钮 → `pointerdown`（在工具条内，不 hide）→ `pointerup`
	 *    （调度 `capture()` @t+0）→ `click`（closeBtn 的 `hide()`）
	 *    → **timeout 到期，`capture()` 读到选区仍然非空**（点按钮不会让原生选区塌陷）
	 *    → `showFor()` 又把它重新显示出来。
	 *  用户看到的就是「点叉号 / 点别处，工具条闪一下又回来 → 压根关不掉」。
	 *
	 *  判据与 `onPointerDown` 同源：工具条子树里的 pointerup 是「在用工具条」，
	 *  不是「在划新词」。阴性对照 `__UR_BREAK_STICKY_BAR` 注回旧行为
	 *  （不看 target 无条件重采）→ `test:md-selection` 的 P11 必须变红。 */
	private readonly onPointerUp = (e: PointerEvent): void => {
		if (!this.attached) return;
		// 手势这一条先结清：**工具条子树内的 pointerup 也要结清**，否则一次点按会把
		// 手势挂到安全网（`CHROME_GATE_MAX_MS`）才放行（用户会看到「点一下之后那栏半天不回来」）。
		this.endChromeGesture(e);
		if (!breakFlag("__UR_BREAK_STICKY_BAR")) {
			const target = e.target;
			if (target instanceof Node && this.toolbar.containerEl.contains(target)) return;
		}
		window.setTimeout(() => this.capture(), 0);
	};

	private scheduleCapture(): void {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = 0;
			this.capture();
		}, CAPTURE_DEBOUNCE_MS);
	}

	private capture(): void {
		// 每次采集都挂一次「最终出现了吗」的裁决。**必须放在最前** —— 下面每一条早退
		// 都可能正是故障本身，而裁决还要覆盖「一条早退都没走到、工具条却也没出现」那种。
		this.narrate("pending");
		this.armNoShowWatch();

		const view = this.deps.view();
		const mode = modeOf(view);
		if (!view || mode === "unknown") {
			this.narrate(view ? "mode-unknown" : "view-null", { mode });
			return;
		}
		const doc = this.ownerDoc();
		let sel: Selection | null = null;
		let range: Range | null = null;
		try {
			sel = doc.getSelection();
			if (sel && sel.rangeCount > 0) range = sel.getRangeAt(0);
		} catch {
			this.narrate("range-error", { mode });
			return;
		}
		const text = sel?.toString().trim() ?? "";
		// 这一组事实是后面所有早退报告与裁决报告的公共底座：**先备好再判**，
		// 否则「为什么早退」这件事本身就没被记下来。
		const baseFacts: Record<string, unknown> = {
			mode,
			rangeCount: sel?.rangeCount ?? 0,
			selLength: text.length,
			selCollapsed: sel ? sel.isCollapsed : null,
			selPreview: text.slice(0, 24),
			anchorChain: range ? nodeChain(range.commonAncestorContainer) : null,
		};
		if (!text || !range || sel?.isCollapsed) {
			this.narrate("no-text", baseFacts);
			return;
		}

		// 不要理会落在我们自己浮层里的选区
		const host = this.deps.host();
		const anchorEl = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? (range.commonAncestorContainer as HTMLElement)
			: range.commonAncestorContainer.parentElement;
		if (host && anchorEl && host.contains(anchorEl)) {
			this.narrate("in-own-host", { ...baseFacts, inOwnHost: true });
			return;
		}

		// 选区必须落在本视图的正文里（阅读区 / 编辑器，按形态各认各的容器）。
		//
		// ⚠️ 这里**不能**用裸 `querySelector`（2026-10-13 真机取证后改；这是「夹具全绿而
		// 真机红」的差异点本身）。真机（Android 手机 / 笔记实时编辑 / 引用块，见库根
		// `unreader-selbar-noshow-20261012174339.txt`）实测：
		//   · 选中的字**确实**在一个 `div.cm-content` 里 —— `anchorChain` 末两节就是
		//     `div.cm-content.cm-lineWrapping < div.cm-contentContainer`；
		//   · 而 `view.contentEl.querySelector(".cm-content")` 拿到的那个**不装锚点**
		//     （`scopeContainsAnchor: false`），并且它连同 `.markdown-source-view` /
		//     `.cm-editor` / `.cm-scroller` 的 rect **全是 0**（宽高皆 0 = 不在屏幕上）；
		//   · ⇒ `capture()` 一路早退成 `scope-miss`：**字选得上、工具条永远不出现**，
		//     而同一份代码在夹具里（只有一个编辑器）恒绿。
		// 判据改成「**谁真的把锚点装在肚子里**」，并把挑选过程记进证据
		// （`scopeCandidates` / `scopeContaining` / `scopePick`），下一轮不必再猜。
		const pick = this.resolveScope(view, mode, range, anchorEl);
		if (!pick.el) {
			// 这一档最值得留证据：真机上官方若换了编辑器骨架（或选区端点落在
			// `.cm-content` 之外），症状就是「字选得上、工具条永远不出现」。
			this.narrate("scope-miss", {
				...baseFacts,
				scopeSelector: pick.selector,
				scopeFound: pick.found > 0,
				scopeContainsAnchor: pick.containing > 0,
				scopeCandidates: pick.found,
				scopeContaining: pick.containing,
				scopePick: pick.source,
			});
			return;
		}

		// 实时渲染 / 源码模式：编辑器直接给出源码偏移，一字节都不用猜
		const ed = mode === "source" ? this.editorOffsets(view) : null;
		let cloned: Range | null = null;
		try {
			cloned = range.cloneRange();
		} catch { /* 某些浏览器对跨影子的 range 会抛 */ }

		this.pending = {
			text,
			tokenCount: tokenize(text).length,
			rect: range.getBoundingClientRect(),
			range: cloned,
			editor: ed ?? undefined,
		};
		this.toolbar.setAiTools(this.deps.aiTools());
		try {
			this.toolbar.showFor({ doc, text }, null, this.deps.bounds());
		} catch (e) {
			// 显示本身抛错 ⇒ 工具条一定不出现，而这一档此前**完全静默**
			// （异常直接冒到事件回调里，用户侧只是「什么都没发生」）。留一条自述再原样抛。
			this.narrate("show-throw", { ...baseFacts, error: String((e as Error)?.message ?? e) });
			throw e;
		}
		// 采集成功：自述清空。（若裁决时工具条仍不可见 ⇒ 记成 `shown-then-hidden`）
		this.narrateShown(baseFacts);
	}

	/**
	 * 挑「本视图正文」的那一个容器（阅读区 / 编辑器，按形态各认各的选择器）。
	 *
	 * 真机上同一个 leaf 里同名容器会有**多份**（隐藏 leaf 的副本、内嵌笔记自己的
	 * CM6 编辑器、官方两套模式容器并存…），文档序在前的那一份常常 rect 全 0。
	 * 挑选顺序（**先准后保底**，全程只读不改）：
	 *   ① `view.contentEl` 里**真的装住锚点**的那一份 —— 最可信：既在视图内、又装着选区；
	 *   ② 仍在 `view.contentEl` 里、**有几何**（rect 宽高 > 0）的那一份；
	 *   ③ 锚点自己最近的同名祖先 —— **保底**：真机上「视图归属」与「选区所在」可能有偏差
	 *      （官方在构造时就把两套模式容器都建出来、`hide()` 只写 `display:none`；
	 *      见 `mdOverlay.selectionBounds` 的同类注释）。宁可让工具条出现（选区已经被系统
	 *      判定成一段有效文本了），也不要因为容器归属算错而让功能彻底哑掉。
	 *
	 * 阴性对照 `__UR_BREAK_SCOPE_NAIVE`（注回裸 `querySelector` 取第一份）⇒
	 * `test:md-selection` 的 P27（夹具造「零尺寸副本排在文档序前面」）必须变红。
	 */
	private resolveScope(
		view: MarkdownView,
		mode: MdMode,
		range: Range,
		anchorEl: HTMLElement | null,
	): { el: HTMLElement | null; selector: string; found: number; containing: number; source: string } {
		const selector = mode === "preview" ? ".markdown-reading-view" : ".cm-content";
		const anchor = range.commonAncestorContainer;
		const root = view.contentEl ?? view.containerEl;
		let all: HTMLElement[] = [];
		try {
			if (root) all = Array.from(root.querySelectorAll<HTMLElement>(selector));
		} catch { /* 选择器异常 / 影子边界：当作一份都没有 */ }
		if (breakFlag("__UR_BREAK_SCOPE_NAIVE")) {
			// ⚠️ 必须**逐字复刻旧实现的两段守卫**（`!scopeFound || !scopeContains`）。
			// 只实现「取第一份」而漏掉「还必须装住锚点」这半句，阴性档就**永远是绿的**：
			// 第一份副本非 null ⇒ 新守卫 `!pick.el` 不成立 ⇒ 一路走下去、工具条照样出现。
			// 2026-10-13 实测踩过：`snCaught:false`，而 P27 里「工具条照样出现」
			// 「高亮照样写进源文件」两条在阴性档读到的都是 true（该红没红）。
			const first = all[0] ?? null;
			let firstContains = false;
			try { firstContains = !!first && first.contains(anchor); } catch { firstContains = false; }
			return {
				el: firstContains ? first : null,
				selector,
				found: all.length,
				containing: firstContains ? 1 : 0,
				source: "naive",
			};
		}
		let containing = 0;
		let holder: HTMLElement | null = null;
		let visible: HTMLElement | null = null;
		for (const el of all) {
			try {
				if (el.contains(anchor)) {
					containing++;
					if (!holder) holder = el;
				}
			} catch { /* 跨影子/断开节点：跳过 */ }
			if (visible) continue;
			// 判据用 rect 而非 `display`：官方 hide/show 只改内联 display，而 `offsetParent`
			// 在 `position:fixed` 祖先下会给出错误答案；rect 全 0 就是「不在屏幕上」。
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) visible = el;
		}
		if (holder) return { el: holder, selector, found: all.length, containing, source: "contains" };
		if (visible) return { el: visible, selector, found: all.length, containing, source: "visible" };
		let near: HTMLElement | null = null;
		try {
			const n = anchorEl?.closest?.(selector);
			near = n instanceof HTMLElement ? n : null;
		} catch { near = null; }
		return { el: near, selector, found: all.length, containing, source: near ? "nearest" : "none" };
	}

	/**
	 * 从编辑器取当前选区的源码偏移（实时渲染 / 源码模式）。
	 *
	 * CM6 的选区锚点本来就是**源码文档坐标**，所以这里拿到的是精确值 —— 不必再走
	 * 「把源码投影成纯文本再去文本里搜」那条近似路子。
	 */
	private editorOffsets(view: MarkdownView): { from: number; to: number } | null {
		if (breakFlag("__UR_BREAK_EDITOR")) return null;
		try {
			const ed = (view as unknown as {
				editor?: {
					listSelections?: () => Array<{ anchor: unknown; head: unknown }>
					posToOffset?: (pos: unknown) => number
				}
			}).editor;
			if (!ed || typeof ed.posToOffset !== "function" || typeof ed.listSelections !== "function") return null;
			const sels = ed.listSelections();
			const first = sels?.[0];
			if (!first) return null;
			const a = ed.posToOffset(first.anchor);
			const b = ed.posToOffset(first.head);
			if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
			const from = Math.min(a, b);
			const to = Math.max(a, b);
			return to > from ? { from, to } : null;
		} catch {
			return null;
		}
	}

	// ---------- 收口 ----------

	private readonly onPointerDown = (e: PointerEvent): void => {
		const target = e.target;
		if (target instanceof Node && this.toolbar.containerEl.contains(target)) return;
		this.toolbar.hide();
		// 落闸必须发生在**这一次 pointerdown 的同步阶段**：官方那栏在编辑器聚焦时就 show()，
		// 用 microtask / timeout 都会晚一步（那时 52px 的 spacerEl 已经把正文顶上去了）。
		this.beginChromeGesture(e);
	};

	/** 手势被系统中断（来电、返回手势、系统选区菜单抢走指针…）：与 pointerup 同样结清。 */
	private readonly onPointerCancel = (e: PointerEvent): void => {
		if (!this.attached) return;
		this.endChromeGesture(e);
	};

	/** ② 的收口补通道之一：**window 捕获**阶段的 pointerup / cancel。
	 *
	 *  doc 上那两条只在「事件目标还在文档树里、事件真的走到 doc」时才到；而系统接管的
	 *  手势（长按进选区模式后抬手）在个别机型上会把事件只投到 window，或目标已被摘出 DOM。
	 *  这一条只做「结清手势」，不碰采集（那两条该做的事照旧），所以与它们重复到达也无副作用。 */
	private readonly onWindowRelease = (e: PointerEvent): void => {
		if (!this.attached) return;
		this.endChromeGesture(e);
	};

	/** ② 的收口补通道之二：**触摸通道的 touches 清空**。
	 *
	 *  为什么值得单开一条：pointer 事件与 touch 事件是两条独立的投递链，浏览器接管选区手势时
	 *  可能吞掉其中一条。`touches.length === 0` 是「手指已全部离开屏幕」的**物理事实**
	 *  （多指也覆盖），拿它结清手势不会误伤 —— 还有手指压着时一律不动。 */
	private readonly onTouchRelease = (e: TouchEvent): void => {
		if (!this.attached || !this.gesture) return;
		if (e.touches.length > 0) return;
		this.gesture = null;
		this.syncAnnotationChrome();
	};

	/** ② 的收口补通道之三：**页面转后台**（切应用 / 锁屏 / 系统返回）。
	 *  转后台那一刻手指不可能还压在正文上，而系统通常也不再补 pointerup/cancel ⇒ 直接结清。 */
	private readonly onDocVisibility = (): void => {
		if (!this.attached || !this.gesture) return;
		if (this.ownerDoc().visibilityState !== "hidden") return;
		this.gesture = null;
		this.syncAnnotationChrome();
	};

	private readonly onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && this.toolbar.visible) this.toolbar.hide();
	};

	/** 滚动时收起工具条：阅读模式下锚点在正文流里，跟着滚会飘到别处 —— 收起最干净。
	 *
	 *  **实时渲染 / 源码模式例外**（2026-10-11 用户报障：「实时渲染模式下，选中文字后
	 *  自动出现键盘，这种情况下选中文字工具栏不会出现」）：工具条在 source 模式是
	 *  **贴底居中的固定定位**，与锚点无关、不需要跟着滚；而移动端软键盘弹起会让 CM6 的
	 *  滚动层（`.cm-scroller`）连同 `visualViewport` 一起平移一次，这一记 scroll 正好
	 *  落在「刚 capture 出工具条」之后 → 刚显示就被收掉，用户看到的就是「选完字、
	 *  键盘弹出、工具条没了」。source 模式的收口交给「点空白 / Esc / 关闭钮 / 高亮完成」
	 *  这几条明确出口，scrolling 不再参与。 */
	private readonly onScroll = (e: Event): void => {
		if (!this.toolbar.visible) return;
		// **工具条自己的横滑带不算「阅读区滚动」**（2026-10-14 单行横滑改版）：
		// 这条监听挂在 document 的**捕获阶段**（scroll 不冒泡，只有捕获收得到阅读区的滚动），
		// 于是工具条内部 `.unreader-selbar-scroll` 的左右滑动也会被它收到 —— 不挡掉的话
		// 手指一滑工具条就没了，正是用户要的「左右滑动按钮」的反面。判据只看事件目标
		// 是否落在工具条子树内（与上方空白点按路径同一套「容器内不算外部」口径）。
		const t = e.target;
		if (t instanceof Node && this.toolbar.containerEl.contains(t)) return;
		// 阴性对照 `__UR_BREAK_SCROLL_HIDE`：注回旧行为「任何滚动都收起」→
		// test:md-selection 的 P16（source 模式键盘引发的滚动不得收工具条）必须变红。
		if (!breakFlag("__UR_BREAK_SCROLL_HIDE") && modeOf(this.deps.view()) === "source") return;
		this.toolbar.hide();
	};

	// ---------- 动作 ----------

	private copy(text: string): void {
		try {
			void navigator.clipboard?.writeText(text);
			new Notice("已复制");
		} catch {
			new Notice("复制失败");
		}
	}

	/**
	 * 读当前源码：**必须与写入通道同源**（source 读编辑器 / preview 读文件）。
	 *
	 * ⚠️ 2026-10-12 用户报障「第一次点高亮可能成功，第二次、第三次就显示**高亮写入失败**」
	 * 的根因就是这个函数的**真源与写入通道不一致**：
	 *
	 *  · 阅读模式（preview）下 `view.editor` 是**幽灵 CM6**（隐藏实例）：写它不落盘、不刷新
	 *    预览，**外部写盘它也不跟随** —— 它手里永远是**打开这个视图那一刻**的旧内容
	 *    （同一坑已在 `mdAnnotations.sourceOf` 的注释里记过：那里叫「幽灵编辑器的旧内容」）。
	 *  · 写入通道对 preview **强制走 vault（文件）**（见 `mdHighlightWrite` 的 channel 注释）。
	 *
	 * 于是旧实现（有 editor 就读 editor）是「**按幽灵算计划、按文件写**」两个真源：
	 *  第 1 次：盘上还没被我们动过 ⇒ 幽灵 == 文件 ⇒ 计划正确 ⇒ 写入成功；
	 *  落盘后盘变了、幽灵没变 ⇒ 第 2 次起计划里的 `from/to/expected` 全部按**旧内容**算，
	 *  写入时 `verify(盘上最新内容, …)` 必然失配 ⇒ `ok:false`
	 *  ⇒ Notice「写入高亮失败（笔记可能已被改动）」（连点几次都一样，看着像功能坏了）。
	 *
	 * 真源与通道保持一致：**source 模式下编辑器就是真源**（同步、最新，且写入也走它）；
	 * **preview 模式以文件为真源**。读盘失败时退回编辑器当最后的兜底（比直接报「读取笔记
	 * 失败」强 —— 写入前的 `verify` 仍会兜住任何错位）。
	 *
	 * 阴性对照 `__UR_BREAK_READ_GHOST`（注回「有 editor 就读 editor」）：
	 * `test:md-selection` 的 P23（连续高亮两处）必须变红。
	 */
	private async readSource(view: MarkdownView): Promise<string | null> {
		const ed = (view as unknown as { editor?: { getValue?: () => string } }).editor;
		const readEd = ed && typeof ed.getValue === "function" ? ed.getValue.bind(ed) : null;
		const fromEditor = (): string | null => {
			if (!readEd) return null;
			try {
				return readEd();
			} catch {
				return null;
			}
		};
		// source（实时渲染 / 源码）：编辑器即真源，与写入通道一致
		if (readEd && (modeOf(view) === "source" || breakFlag("__UR_BREAK_READ_GHOST"))) {
			const s = fromEditor();
			if (s != null) return s;
		}
		// preview（阅读）：文件即真源，与写入通道一致
		const file = view.file;
		if (file) {
			try {
				return await this.deps.app.vault.read(file);
			} catch { /* 读盘失败 → 退回编辑器兜底 */ }
		}
		return fromEditor();
	}

	private clearSelection(): void {
		try {
			this.ownerDoc().getSelection()?.removeAllRanges();
		} catch { /* ignore */ }
	}

	/**
	 * 选区 → 源码区间。三条通道，从准到糊依次降级：
	 *
	 *  ① **编辑器**（实时渲染 / 源码）：CM6 给的就是源码坐标，零误差。
	 *  ② **token 锚定**（阅读模式）：拿选区在渲染块里的「第几个词」去窗口投影里对位，
	 *     位置算出来的，同一句话出现十次也不会认错。
	 *  ③ **文本搜索**（兜底）：老路子。窗口消歧后仍有多个候选就直接**拒绝** ——
	 *     静默挑一个是「我点这儿、别处亮了」的根源，宁可不写。
	 */
	private resolveRange(src: string, dem: Demarked, pend: Pending): ResolvedRange | null {
		if (pend.editor) {
			const { from, to } = pend.editor;
			if (from >= 0 && to <= src.length && to > from) {
				return { from, to, runs: splitRuns(src, from, to), confidence: "exact" };
			}
		}
		const anchored = this.anchorRange(src, pend);
		if (anchored) return anchored;

		const lineRange = pend.range ? this.deps.windowFor(pend.range, pend.rect) : null;
		const window: [number, number] | null = lineRange
			? [lineOffsetAt(src, lineRange[0]), lineOffsetAt(src, lineRange[1] + 1)]
			: null;
		const found = resolveSelection(src, dem, pend.text, window);
		if (!found) {
			const needle = pend.text.trim();
			const times = needle ? src.split(needle).length - 1 : 0;
			new Notice(times > 1
				? "笔记里有 " + times + " 处相同的文字，无法确定你指的是哪一处（未改动笔记）"
				: "未能在源文件中定位选区，未改动笔记");
			return null;
		}
		return found;
	}

	/** ② token 锚定：算不出（DOM 变了 / 投影与渲染对不上）就返回 null，交给兜底。 */
	private anchorRange(src: string, pend: Pending): ResolvedRange | null {
		if (breakFlag("__UR_BREAK_ANCHOR")) return null;
		const range = pend.range;
		if (!range) return null;
		try {
			const view = this.deps.view();
			const sizer = view?.contentEl?.querySelector(".markdown-preview-sizer") ?? null;
			const start = normalizePoint(range.startContainer, range.startOffset);
			const block = blockAncestor(start.node, sizer);
			if (!block || !block.isConnected) return null;
			const lineRange = this.deps.windowFor(range, pend.rect);
			// 窗口取不到（老版本没有 renderer.sections / 节定位落空）时**不放弃锚定**：
			// 退回「整篇投影当窗口」。此时「块文本 == 窗口」的全等必然不成立，①② 两条
			// 老路径一步都匹配不上，但下面的 ③ 块内定位仍能靠「这块文本在全篇唯一」
			// 把位置算出来 —— 比直接退化全文搜索（选区稍重复就拒绝写入）强得多。
			const w0 = lineRange ? lineOffsetAt(src, lineRange[0]) : 0;
			const w1 = lineRange ? lineOffsetAt(src, lineRange[1] + 1) : src.length;
			if (w1 <= w0) return null;
			const win = demarkWindow(src, w0, w1);
			if (!win.plain.trim()) return null;
			const count = pend.tokenCount > 0 ? pend.tokenCount : tokenize(range.toString()).length;
			if (count <= 0) return null;
			// 从选区所在块起逐级向上：段落自己就能对上的最常见；列表项要升到 `<ul>`
			// 才与「整个列表」这一节对得上。最多走 6 层，别顺着 DOM 爬到根上去。
			// ⚠️ **没有真窗口时 ①② 不进场**（root 置空 ⇒ 循环体一步都不走）：它们
			// 要求「某一级 DOM 的文本 == 窗口投影」这个全等，窗口都没有时这个全等纯属
			// 巧合 —— 实测把「整篇投影当窗口」后，sizer 的 innerText 会意外全等命中，
			// 于是「无窗口 + 多处重复 ⇒ 拒绝写入」这条既定契约（P5/P12）被直接推翻。
			// 无窗口档只走 ③：它问的是「这块文本在投影里是否唯一」，不靠任何一级全等。
			let root: HTMLElement | null = lineRange ? block : null;
			for (let step = 0; root && step < 6; step++) {
				// `innerText` 是**渲染口径**的文本：`<li>` 之间会补换行、`<td>` 之间会补制表符，
				// 与用户在屏幕上看到的（也就是选区里那份）一致。`textContent` 会把
				// 「苹果」「香蕉」两个列表项粘成 「苹果香蕉」一个词，对不上投影。
				const text = renderTextOf(root);
				if (text.trim() && sameTokens(text, win.plain)) {
					const off = textOffsetIn(root, start.node, start.offset);
					if (off >= 0) {
						// ① **字符级**锚定（优先）：中文/日文这类不用空格分词的语言里，
						//    整段就是一个「词」，词级锚点会把段内局部选区解成整段 ——
						//    这正是「点高亮却高亮整个段落」的根因。这里用「选区在块内的
						//    字符区间」直接对位，粒度是字符，连写文字也能精确圈出一小段。
						//    阴性对照 `__UR_BREAK_CHARSPAN` 注回旧行为（只走词级）→
						//    `test:md-selection` 的 P14 必须变红。
						if (!breakFlag("__UR_BREAK_CHARSPAN")) {
							// domText 必须与 `textOffsetIn` 同坐标系（都是 textContent 口径）；
							// `range.toString()` 也是「拼接文本节点」口径，天然是 textContent 的子串。
							const domText = root.textContent ?? "";
							const span = range.toString().length;
							const exact = resolveByCharSpan(src, win, domText, off, span);
							if (exact) return exact;
						}
					// ② **词级**锚定（英文主力，也是字符级对不上时的兜底）。
					// ⚠️ 锚点序号必须按**可见字符计数**算：`off` 是 `textOffsetIn` 给的
					// `textContent` 口径偏移，而 `text` 是 `innerText` 口径 —— 块级子元素
					// （`<li>` / `<p>` / `<td>` 边界）会让两者长度不同，直接拿 `off` 去
					// `innerText` 里数词会整体错位，词级锚定于是落到错误的词上。
					const domText0 = root.textContent ?? "";
					const anchorToken = tokenIndexAtVisible(text, countNonSpace(domText0, off));
					const hit = resolveByTokens(src, win, text, anchorToken, count);
					if (hit) return hit;
					}
				}
				if (root === sizer) break;
				root = root.parentElement;
			}

			// ③ **块内字符级定位**（窗口比分块大 / 取不到窗口时唯一还能精确定位的通路）。
			// ①②都要求「某一级 DOM 的文本 == 窗口投影」这个**全等**；可分节行范围常常比块大
			// （一个分节含多个块：多段引用 / 整个列表），或节定位落到邻节，于是全等在任何一级
			// 都不成立 ⇒ 锚定整体失效 ⇒ 只剩全文搜索（选区稍重复就「高亮无法写入」），
			// 或退到词级把整块当一个词（「点了标题里三个字、高亮了整个标题」）。
			// 这里换一个问法：先在窗口投影里**定位这块文本**（唯一才认），再把选区按字符平移。
			// ⚠️ 无窗口档传进来的 `win` 是**整篇投影**，于是「唯一」的门槛比有窗口时更高
			// （要在全篇唯一）—— 这正是 P5/P12「无窗口 + 多处重复 ⇒ 拒绝写入」的实现处：
			// ③ 返回 null ⇒ 锚定失败 ⇒ 兜底搜索同样因多候选而拒绝，宁可不写。
			// 阴性对照 `__UR_BREAK_CHARSPAN`（连它一起注回）与 `__UR_BREAK_BLOCKSPAN`（只注回它）。
			if (!breakFlag("__UR_BREAK_CHARSPAN") && !breakFlag("__UR_BREAK_BLOCKSPAN")) {
				const domText = block.textContent ?? "";
				const off = textOffsetIn(block, start.node, start.offset);
				const span = range.toString().length;
				// 选区**跨出这块**时不猜：③ 的「按字符平移」只在选区委在这块内才有定义
				// （`span` 是 Range.toString 的 textContent 口径，块内选区恒有
				// off + span ≤ domText.length）。越界时旧代码会 clamp 成「从选区头写到
				// 块尾」—— 那正是用户报障 A 的「高亮了没选的文字」。交给兜底：跨块选区的
				// needle 按 token 顺序匹配（looseFind），本来就跨得过块边界。
				if (off >= 0 && off + span <= domText.length) {
					const hit = resolveByCharSpanInBlock(src, win, domText, off, span);
					if (hit) return hit;
				}
			}
		} catch { /* 锚定是增强，出错就走兜底 */ }
		return null;
	}

	private async applyHighlight(colorName: string): Promise<void> {
		const view = this.deps.view();
		const pend = this.pending;
		if (!view || !pend || !view.file) {
			new Notice("无法定位选区");
			return;
		}

		const src = await this.readSource(view);
		if (src == null) {
			new Notice("读取笔记失败");
			return;
		}

		const dem = demark(src);
		const range = this.resolveRange(src, dem, pend);
		if (!range) return;

		const hit = analyzeHighlight(src, dem, range.from, range.to);
		const plan = planHighlight(src, dem, range, hit, colorName, supportsColorHighlight());
		if (!plan) {
			new Notice("该选区无法安全写入高亮，未改动笔记");
			return;
		}

		const expected = src.slice(plan.from, plan.to);
		// 阅读模式没有编辑器通道，只能改文件 → 官方会整篇重渲染，滚动位置常被带走。
		// 先把位置攥住，写完还回去（编辑器通道原地改，本来就不跳，多调一次也无害）。
		const hold = this.deps.holdScroll?.() ?? null;
		// preview 模式必须强制文件通道：真机上 view.editor 是隐藏的 CM 实例，
		// replaceRange 写了不刷新预览也不落盘（见 applyEditPlan 的 channel 参数）。
		// 阴性对照 __UR_BREAK_GHOST_EDITOR：注回旧行为（preview 也自动走 editor），
		// test:md-selection 的通道断言必须变红，否则这条修复是假绿。
		const ghostBreak = breakFlag("__UR_BREAK_GHOST_EDITOR");
		const channel = (modeOf(view) === "source" || ghostBreak) ? "auto" as const : "vault" as const;
		const res = await applyEditPlan(this.deps.app, view, plan, expected, channel);
		// 重渲染是异步的：立刻写回会被官方的重置盖掉，留一帧再还。
		if (hold) window.requestAnimationFrame(() => hold());
		if (!res.ok) {
			new Notice("写入高亮失败（笔记可能已被改动）");
			return;
		}
		if (res.via === "vault") {
			// 文件通道不进撤销栈，明确告知（编辑器通道不提示，Cmd+Z 可用）
			new Notice("已写入高亮（本次无法用撤销恢复，请留意）");
		}
		this.clearSelection();
		this.toolbar.hide();
		this.pending = null;
	}
}
