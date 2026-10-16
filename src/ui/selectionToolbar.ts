import { setIcon } from "obsidian";
import { HIGHLIGHT_COLORS, highlightColorOf } from "../types";
import type { AiToolEntry } from "../types";
import * as debugLog from "../core/debugLog";
import { occlusionCeiling, placeFloating, type Bounds } from "./floatingPlacement";
import { keyboardBandOverlapTop, nativeBarOverlapTop, hardBottomEdge, subscribeKeyboardGeometry } from "./keyboardInset";
import { recordSelectionDiag } from "./selectionDiag";

/**
 * 「实测遮挡 → 抬高重排」的**阴性对照**开关（生产恒 false）。
 *
 * 关掉后浮层只按几何模型落位、不再用 `elementFromPoint` 复核 —— 于是
 * 「Obsidian 快速编辑栏迟到入场（无任何事件）把工具条压住」那一档会重新变红。
 * 只有 `test:md-kb` 会设这个键（`?break=avoid`）。
 */
function avoidOcclusionEnabled(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_AVOID !== true;
	} catch {
		return true;
	}
}

/**
 * 「横向滑动提示」的**阴性对照**开关（生产恒 false，只有 `test:selbar-fit` 会设）。
 * 关掉后右缘不再渐隐 —— 用来证明「has-more-right 只在真有余量时出现」这条断言自己承重。
 */
function scrollHintEnabled(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_SCROLL_HINT !== true;
	} catch {
		return true;
	}
}

/**
 * 横滑带的「还能往右滑」提示：有余量时给右缘加渐隐（`.has-more-right`，样式见 styles.css），
 * 滑到底或本就装得下时摘掉。工具条与高亮气泡共用 —— 两处的横滑带是同一套 DOM/CSS。
 */
export function syncRowScrollHint(scrollEl: HTMLElement | null | undefined): void {
	if (!scrollEl) return;
	const more = scrollHintEnabled() && scrollEl.scrollWidth - scrollEl.clientWidth - scrollEl.scrollLeft > 1;
	scrollEl.toggleClass("has-more-right", more);
}

/**
 * 「隐藏测量」的**阴性对照**开关（生产恒 false）。
 *
 * `is-measuring` 的作用是「先量后显」—— 首次落位前工具条还没有 `left/top`，
 * 不藏起来会在默认位置闪一帧。但它的代价是 `visibility:hidden`，而 CSS 把
 * `.is-measuring` 排在 `.is-visible` **之后**（必然压住）且基础规则带着
 * `visibility 110ms` 的 transition ⇒ **每次重排都会走一遍 110ms 的淡出/淡入**。
 *
 * 键盘收敛窗口内有三个源同时在推食用 `reposition()`：
 * `subscribeKeyboardGeometry` 的 8 记收敛阶梯 + 250ms 原生栏指纹轮询 + 最多 4 轮
 * `avoidOcclusion` —— 几百毫秒里重排几十次，用户看到的就是
 * 「工具栏会闪烁好一会儿，才会显示稳定」（2026-10-12 用户逐字报障）。
 *
 * 正解：`is-measuring` **只在首次落位**用（位置已摆好后再量就无需隐藏），
 * 与 `TranslationCard.reposition()` 同一份口径。本开关注回「每次都藏」，
 * 供 `test:md-kb` 的 M 档证明「不闪烁」这条断言自己承重（`?break=measure-all`）。
 */
function measureAllBreaks(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_MEASURE_ALL === true;
	} catch {
		return false;
	}
}

/**
 * 「贴底重合」的**阴性对照**开关（生产恒 false）。
 *
 * 关掉后浮层即便正贴着官方快速编辑栏，也照旧留 `placeFloating` 的 8px 呼吸位
 * ⇒ 「官方栏的上边框与工具条的下边框之间恒有 8px 缝」（用户 2026-10-13 逐字报障的
 * 症状③）。只有 `test:md-kb` 的 S 档会设这个键（`?break=snap`），用来证明
 * 「重合」这条断言自己承重，而不是搭别的机制（比如实测避让那趟 0 间隙）的便车。
 */
function snapBottomBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_SNAP === true;
	} catch {
		return false;
	}
}

export interface SelectionSnapshot {
	doc: Document
	text: string
}

export interface SelectionActions {
	onCopy: (text: string) => void
	onHighlight: (colorName: string) => void
	onComment: (text: string, comment: string, colorName: string) => void
	/** 选区翻译（M2）：readerView 负责检测 UNagent、开译文卡片；不可用时给出指引 */
	onTranslate: (text: string) => void
	/** 统一 AI 入口名单里点中某项：按 id 转给 AI 面板运行（官方与自定义工具同一条路）。
	 *  `text` = 点击那一刻工具条缓存的选中文字：iPad 触摸点按后活选区会被系统收走，
	 *  必须由这里把文本直接递到面板，不能等面板回头再读 `getSelection()`。 */
	onRunAiTool?: (id: string, text: string) => void
}

/** 划词工具栏与高亮气泡**共用**的「统一 AI 入口」（2026-09-29 用户要求两种工具条
 *  完全一致、共用一套代码）：一枚按钮 + 悬浮/点按展开的工具名单。名单内容、开合
 *  两通道与定位数学只有这一份实现，挂在哪个工具条上行为都一样。
 *  `host` = 工具条容器（定位名单时取它的父级作可用区）；`onRun` = 名单项点中回调。 */
export class SelbarAiMenu {
	readonly el: HTMLElement;
	private readonly host: HTMLElement;
	private readonly onRun: (id: string) => void;
	private entryBtn: HTMLElement | null = null;
	private menuEl: HTMLElement | null = null;
	private aiMenuOpen = false;
	/** 名单当前由「悬浮」开出（而非点按）：悬停开出的名单要吃掉紧随的那次点按，
	 *  否则鼠标下「悬浮刚展开 → 点按又关掉」就是两套开合互相打架。 */
	private aiMenuOpenedByHover = false;
	private aiMenuCloseTimer: number | null = null;
	/** 名单指纹：内容没变就**不重绘**。
	 *
	 *  为什么必须去重（2026-10-11 用户报障「选中文字的功能很卡顿」）：`setTools` 会
	 *  `el.empty()` 后整块重建（入口按钮 + 悬浮菜单 + 每行一个工具项，各自挂监听）。
	 *  而 `MdSelectionController.capture` **每次选区采集**都调 `setAiTools` —— 拖动选择时
	 *  `selectionchange` 会以 ~120ms 的节流连续触发，等于每次拖动都在重建一遍 AI 菜单
	 *  DOM。名单在会话内基本恒定，指纹一致时直接返回，重建成本归零。 */
	private toolsSig: string | null = null;

	constructor(host: HTMLElement, onRun: (id: string) => void) {
		this.host = host;
		this.onRun = onRun;
		this.el = createDiv({ cls: "unreader-selbar-tools" });
		this.el.hide();
	}

	/** 设置名单（官方两枚 + 全部启用的自定义工具，见 AIPanel.selectionToolEntries）。
	 *  每次全量重绘；名单为空时整块收起。入口只有**一枚按钮**（图标即图标，不写字），
	 *  工具名走「悬浮展开」的名单 —— 2026-09-28 用户要求：原先「逐工具配图标/样式、
	 *  一工具一枚按钮」改为「统一入口 + 悬浮列出所有工具名（一行一个，超出可滚动）」。 */
	setTools(tools: AiToolEntry[]): void {
		// 名单没变 → 不重绘（拖动选择时本函数每 ~120ms 被调一次，见 toolsSig 注释）。
		const sig = tools.map(t => `${t.id}\u0000${t.name}`).join("\u0001");
		if (sig === this.toolsSig) return;
		this.toolsSig = sig;
		this.close();
		this.el.empty();
		this.entryBtn = null;
		this.menuEl = null;
		if (!tools.length) {
			this.el.hide();
			return;
		}
		this.el.show();

		const btn = this.el.createDiv({
			cls: "unreader-selbar-btn unreader-selbar-ai",
			// 形态由用户定：**只留图标**（「AI」字样与展开箭头都不要）；`title` 是唯一的
			// 文字线索（原生悬浮提示），别删。开合两通道都写进提示：触屏点按、鼠标悬浮。
			attr: {
				"aria-label": `AI 工具（${tools.length} 个）：点按或悬浮展开`,
				"aria-haspopup": "menu",
				title: `AI 工具（${tools.length} 个）：点按或悬浮展开`,
			},
		});
		setIcon(btn, "sparkles");
		this.entryBtn = btn;

		const menu = this.el.createDiv({ cls: "unreader-selbar-ai-menu" });
		menu.hide();
		this.menuEl = menu;
		for (const tool of tools) {
			// 名单行只有名称（用户要求「没有图标，只有标题」）；一行一个，长名省略号
			const item = menu.createDiv({
				cls: "unreader-selbar-ai-item",
				text: tool.name,
				attr: { "aria-label": `运行 ${tool.name}`, title: tool.name },
			});
			item.addEventListener("click", e => {
				e.stopPropagation();
				this.close();
				this.onRun(tool.id);
			});
		}

		// 开合的两条通道（2026-09-29 用户要求「点按展开或者关闭，悬浮也是一个展开或者
		// 关闭，两者兼容不打架」）：
		//   · 触屏（手机/iPad 没有 hover）：点按开合 —— 这是手机上「点 AI 按钮没反应」
		//     报障的修复；2026-09-28 的「点按刻意不接线」只对鼠标成立，触屏必须开合。
		//   · 鼠标：悬浮照旧开合（enter 开、离开延迟收）。
		//   兼容判据 = **所有权**：悬浮把名单从关开出时记 `aiMenuOpenedByHover`，此后
		//   指针还压在按钮上的那次 click（鼠标 click 前必然先 pointerenter → 名单已被
		//   悬浮开出）被吃掉 —— 不然「悬浮刚展开、点按又关掉」就是两套开合打架（这正是
		//   前一版「点击无作用」要防的事）。名单由点按开出（触屏）时所有权不在悬浮，
		//   点按照常切换开合。悬浮在名单已开时只续期（取消延迟收起），不抢所有权。
		//   工具条本身不因这次点按收起（容器在 pointerdown 上 stopPropagation，
		//   readerView 的空白点按路径也放行）。
		btn.addEventListener("click", e => {
			e.stopPropagation();
			if (this.aiMenuOpen && this.aiMenuOpenedByHover) return;
			if (this.aiMenuOpen) this.close();
			else this.openAiMenu();
		});
		btn.addEventListener("pointerenter", e => {
			if ((e as PointerEvent).pointerType === "touch") return;
			if (this.aiMenuOpen) {
				this.cancelAiMenuClose();
				return;
			}
			this.aiMenuOpenedByHover = true;
			this.openAiMenu();
		});
		btn.addEventListener("pointerleave", e => {
			if ((e as PointerEvent).pointerType === "touch") return;
			this.scheduleAiMenuClose();
		});
		// 指针从按钮移进名单要继续保持展开（两者间有一条小缝）
		menu.addEventListener("pointerenter", () => this.cancelAiMenuClose());
		menu.addEventListener("pointerleave", () => this.scheduleAiMenuClose());
	}

	private openAiMenu(): void {
		const menu = this.menuEl;
		if (!menu || !menu.childElementCount) return;
		this.cancelAiMenuClose();
		menu.show();
		menu.addClass("is-open");
		this.aiMenuOpen = true;
		this.positionAiMenu();
	}

	/** 收起名单（换名单 / 工具条隐藏 / 展开评论编辑区时都要调）。 */
	close(): void {
		this.cancelAiMenuClose();
		this.aiMenuOpen = false;
		this.aiMenuOpenedByHover = false;
		if (!this.menuEl) return;
		this.menuEl.removeClass("is-open");
		this.menuEl.removeClass("is-below");
		this.menuEl.style.removeProperty("left");
		this.menuEl.hide();
	}

	private scheduleAiMenuClose(): void {
		this.cancelAiMenuClose();
		this.aiMenuCloseTimer = window.setTimeout(() => {
			this.aiMenuCloseTimer = null;
			this.close();
		}, 180);
	}

	private cancelAiMenuClose(): void {
		if (this.aiMenuCloseTimer == null) return;
		window.clearTimeout(this.aiMenuCloseTimer);
		this.aiMenuCloseTimer = null;
	}

	/** 名单默认开在入口按钮**上方**（贴底工具条：向上展开不挡正文）；上方放不下
	 *  （工具条贴着正文区顶边）时翻到按钮下方 —— 否则会被 `.unreader-body` 的
	 *  `overflow: hidden` 裁掉。横向以按钮为中心，按正文区宽度夹住。 */
	private positionAiMenu(): void {
		const menu = this.menuEl;
		const btn = this.entryBtn;
		const wrap = this.el;
		if (!menu || !btn || !wrap) return;
		const btnRect = btn.getBoundingClientRect();
		const hostRect = this.host.parentElement?.getBoundingClientRect();
		const menuH = menu.offsetHeight || 0;
		const spaceAbove = btnRect.top - (hostRect?.top ?? 0);
		menu.toggleClass("is-below", spaceAbove < menuH + 12);
		// 横向：目标 = 菜单中心对齐按钮中心，再夹进正文区（`left` 相对名单的定位父级 wrap）
		const menuW = menu.offsetWidth || 0;
		const wrapRect = wrap.getBoundingClientRect();
		const minX = (hostRect?.left ?? 0) + 4;
		const maxX = (hostRect?.right ?? window.innerWidth) - menuW - 4;
		const wantX = btnRect.left + btnRect.width / 2 - menuW / 2;
		const left = Math.max(minX, Math.min(wantX, Math.max(minX, maxX))) - wrapRect.left;
		menu.style.left = `${Math.round(left)}px`;
	}
}

/**
 * 选中文字后的浮动工具条：与 HighlightPopover 保持一致的工具条形态与定位。
 * 坐标为 body 本地坐标（readerView 已做宿主原点校正），通过 placeFloating 统一处理多边界场景。
 */
export class SelectionToolbar {
	readonly containerEl: HTMLElement;
	private actions: SelectionActions;
	private snapshot: SelectionSnapshot | null = null;
	private barRow!: HTMLElement;
	/** 横滑带：所有可左右滑动的按钮都住在这里（见 render 的注释）。 */
	private scrollEl!: HTMLElement;
	private commentWrap!: HTMLElement;
	private commentInput!: HTMLTextAreaElement;
	/** 弹框标题（「添加评论」/「编辑评论」） */
	private commentTitle!: HTMLElement;
	/** 弹框顶部的原文引用（两行截断）：背板压暗了正文，这一行是「别写错地方」的锚点 */
	private commentQuote!: HTMLElement;
	private pickedColor = "yellow";
	private lastAnchorRect: DOMRect | null = null;
	private lastBounds: Bounds | null = null;
	private translateBtn: HTMLElement | null = null;
	private translateDivider: HTMLElement | null = null;
	/** 「高亮并添加评论」按钮及其前方分隔线（md 阅读模式没有落点，需整组收起）。 */
	private commentBtn: HTMLElement | null = null;
	private commentDivider: HTMLElement | null = null;
	private commentEnabled = true;
	/** 关闭钮（住在钉住区，不随横滑移动）。 */
	private closeBtn: HTMLElement | null = null;
	/** 自定义按钮槽（「命令 → 按钮」绑定）。空配置时不进 DOM（懒创建）。 */
	private customWrap: HTMLElement | null = null;
	/** 统一 AI 入口（与高亮气泡共用同一份实现，见 SelbarAiMenu）。 */
	private aiMenu: SelbarAiMenu | null = null;
	/** 固定模式：工具条固定在正文区底部居中，不跟随选区（规避系统选区菜单同位置冲突） */
	private fixed = false;
	/** 评论编辑区是否展开（只有展开时才需要「贴键盘」重排与高度压缩） */
	private commentOpen = false;
	/** bounds 现测供体（readerView 注入）：键盘弹起后容器被官方收缩，
	 *  必须按**当前**几何重算，绝不能吃展开前那份 bounds（那就是「输入框沉到键盘下面」的根因） */
	private boundsResolver: (() => Bounds) | null = null;
	/** 非评论态也跟随键盘 / 原生栏几何重排（md 视图用：source 模式键盘开着划词，
	 *  工具条出现时可能正卡在键盘动画中间态）。阅读器侧保持默认 false —— 它的工具条
	 *  生命周期与重排契约由 comment-mobile / comment-relocate 两条回归锁死，不改变。 */
	private repositionAlways = false;
	/** 贴底时是否与**实测到的官方原生栏顶边**逐像素重合（md 视图打开，见 setSnapToHardBottom）。
	 *  默认 false：阅读器侧「精确贴回可用区底边 −8px」由 `test:comment-mobile` 四条断言
	 *  钉死，不在这里一起改（改就得上牙口，见该文件的注释）。 */
	private snapToHardBottom = false;
	/** 键盘 / 原生栏几何订阅（评论编辑区展开期间，或 repositionAlways 时挂着） */
	private unwatchGeometry: (() => void) | null = null;
	/** 「实测遮挡 → 抬高」的 rAF 句柄（见 scheduleAvoidOcclusion） */
	private avoidRaf = 0;
	/** 首次落位 visibility 过渡（110ms）结束后的**补检**定时器：
	 *  过渡期间 occlusionCeiling 主动不检测（会穿过 hidden 的自身误命中正文），
	 *  过渡结束必须补一趟，否则真正的遮挡（迟到的官方栏）无人兜底。 */
	private transitionAvoidTimer = 0;
	/** 避让重排进行中：期间 `reposition` 不得再排队（否则自激） */
	private inAvoidPass = false;
	/** 显隐变化上报（见 `setOnVisibilityChange`） */
	private visibilityListener: ((visible: boolean) => void) | null = null;

	/** 订阅「工具条是否可见」的变化。
	 *
	 *  为什么要有这一枚信号：本组件的收口出口有**十几条**（关闭钮 / 取消 / Esc / 点正文空白 /
	 *  高亮完成 / 全沉浸 / 宿主主动 hide / 点别处高亮…），逐个在调用点挂钩必然漏 ——
	 *  2026-10-12 报障「手机上划词时官方快速编辑栏又冒出来压在工具条上（还会误触）」，
	 *  根因就是宿主那边的「让位窗口」在漏挂的出口上没被及时关掉。
	 *  ⇒ 只在这里上报一次**状态**，由宿主决定做什么；实现侧不再重复枚举出口。
	 *  `hide()` 的早退守卫（无状态可清时直接返回）不会走到这里 —— 那种情况本来就没有状态变化。 */
	setOnVisibilityChange(fn: ((visible: boolean) => void) | null): void {
		this.visibilityListener = fn;
	}

	private notifyVisibility(): void {
		try {
			this.visibilityListener?.(this.visible);
		} catch { /* 订阅方抛错不影响工具条自身 */ }
	}

	/** readerView 注入：返回正文区**当前**可用矩形（已裁掉键盘与键盘上方原生栏） */
	setBoundsResolver(fn: () => Bounds): void {
		this.boundsResolver = fn;
	}

	/** md 视图打开：工具条可见期间（非仅评论态）也订阅键盘几何并重排。 */
	setRepositionAlways(on: boolean): void {
		this.repositionAlways = on;
	}

	/** md 视图打开：可用区底边**就是一条官方原生栏**时，贴底不再留呼吸位。
	 *
	 *  为什么单独立一枚开关而不是全局改 `placeFloating` 的 `margin`（2026-10-13）：
	 *  阅读器侧的落点契约（`test:comment-mobile` 的「精确贴回可用区底边 −8px」四条断言，
	 *  含阴性档 A2）是**既有回归钉住的**，它那条 8px 是给「评论弹框贴在正文区底边」用的
	 *  桌面/通用口径。用户报障的是**笔记实时编辑**档（`.unreader-md-root`，工具条贴底居中、
	 *  正压在官方快速编辑栏上方）——那一档才需要「两条边框重合、视觉更紧凑」。
	 *  一枚具名开关 = 一条**路由**：断言可以钉在它上面，阴性档能单独关它（`?break=snap`），
	 *  不改阅读器的任何一个像素。 */
	setSnapToHardBottom(on: boolean): void {
		this.snapToHardBottom = on;
	}

	private watchGeometry(): void {
		// 已在订阅就复用：`showFor` 在拖动选择期间每 ~120ms 调一次，若每次都
		// stopWatching + 重建，会反复创建/销毁 ResizeObserver / MutationObserver 与
		// 一整串 setTimeout 收敛阶梯（见 showFor 注释）。订阅参数（parentElement）在
		// 可见期间不会变 —— 换宿主必经 detach → hide → stopWatching 这条出口。
		if (this.unwatchGeometry) return;
		this.unwatchGeometry = subscribeKeyboardGeometry(this.containerEl.parentElement, () => {
			this.replaceWithFreshBounds();
		});
	}

	private stopWatching(): void {
		const fn = this.unwatchGeometry;
		this.unwatchGeometry = null;
		if (fn) fn();
		const win = this.containerEl.ownerDocument?.defaultView ?? window;
		if (this.avoidRaf) {
			win.cancelAnimationFrame(this.avoidRaf);
			this.avoidRaf = 0;
		}
		if (this.transitionAvoidTimer) {
			win.clearTimeout(this.transitionAvoidTimer);
			this.transitionAvoidTimer = 0;
		}
	}

	/** 排一次「实测遮挡」复核（同一帧内合并；避让进行中或已排队时不再排）。 */
	private scheduleAvoidOcclusion(): void {
		if (!avoidOcclusionEnabled() || this.inAvoidPass || this.avoidRaf) return;
		const win = this.containerEl.ownerDocument?.defaultView ?? window;
		this.avoidRaf = win.requestAnimationFrame(() => {
			this.avoidRaf = 0;
			this.avoidOcclusion();
		});
	}

	/**
	 * 首次落位：安排 visibility 过渡（110ms）结束后**补一趟**遮挡检测。
	 *
	 * 为什么必须补：过渡期间 occlusionCeiling 因自身 computed visibility 仍是
	 * hidden 而直接返回 null（见该函数注释：不补就会穿过自身误命中正文、把工具条
	 * 往顶部抬 = 闪烁）；可过渡结束后若没有新事件，就再没人检测，真正的遮挡
	 * （迟到的官方快速编辑栏）会漏掉。120ms（略大于 110ms 过渡）后跑一趟，
	 * 无遮挡立即收敛，成本一次命中测试。
	 */
	private scheduleTransitionAvoid(): void {
		if (this.transitionAvoidTimer) return;
		const win = this.containerEl.ownerDocument?.defaultView ?? window;
		this.transitionAvoidTimer = win.setTimeout(() => {
			this.transitionAvoidTimer = 0;
			if (this.visible && !this.inAvoidPass) this.avoidOcclusion();
		}, 120);
	}

	/**
	 * 「我现在被谁压住了吗」—— **三条独立判据取最小**：
	 *   ① `occlusionCeiling`：`elementFromPoint` 命中测试（**实现相关**，但能认出**任何**
	 *      外部浮层，不限于已知选择器）；
	 *   ② `nativeBarOverlapTop`：原生栏**实测相交**（**实现无关**，只认 `.mobile-toolbar` /
	 *      `.mobile-navbar` 两条已知栏，但它不做任何「谁盖谁 / 能不能点」的前提假设）；
	 *   ③ `keyboardBandOverlapTop`：**输入法带实测相交**（同理**实现无关**）—— 量的是
	 *      `布局视口 − --keyboard-height − 键盘上方原生栏高`。输入法**不是 DOM 节点**，
	 *      命中测试物理上看不见它；而划词窗口内那条官方栏正被源头闸门收走 ⇒ ① ② 同时缺席。
	 *      （2026-10-12 用户逐字报障：「键盘展开……插件工具栏，则上边框和输入法上边框对齐，
	 *      导致刚好被输入法遮挡掉」—— 那台真机上容器底与可视视口都没缩，模型会自信地
	 *      返回容器底，② 又因为「栏不在场」而返回 null，于是**只剩输入法这一个遮挡源、
	 *      却没有任何一条判据看得见它**。）
	 *
	 * 为什么要三条（2026-10-12 **第三次**真机报障「仍然重叠」后定稿）：
	 *   ① 会被层叠上下文 / `pointer-events` / 绘制顺序骗过（我们自己的工具条正好盖住采样点、
	 *      或宿主 `.unreader-md-root` 有 `pointer-events:none` 导致命中落到别的祖先上时，
	 *      它都会返回「没被挡」）；
	 *   ② 只认已知选择器，但**不依赖任何命中测试前提** —— 矩形相交是纯几何事实；
	 *   ③ 只认「键盘带」这一个被动带宽，但同样不依赖任何前提，且是**唯一**能看见输入法的路。
	 * 任一条命中就抬；三条的阴性闸各自独立（`?break=occhit` / `?break=barrect` /
	 * `?break=kblin`），这样 `test:md-kb` 的 R 档 / S 档能把三条各自的承重分别钉住。
	 */
	private occlusionCeilingNow(
		doc: Document,
		/** 取证出口：把三条判据各自的**原始取值**带出去（`selectionDiag` 用）。
		 *  必须分开记 —— 「几何模型算错」与「三条判据同时瞎了」指向完全不同的修法。 */
		out?: { hit?: number | null; rect?: number | null; kb?: number | null },
	): number | null {
		const box = this.containerEl.getBoundingClientRect();
		const byHit = occlusionCeiling(doc, this.containerEl);
		const byRect = nativeBarOverlapTop(box, doc);
		const byKb = keyboardBandOverlapTop(box, doc);
		if (out) {
			out.hit = byHit;
			out.rect = byRect;
			out.kb = byKb;
		}
		let ceiling: number | null = null;
		for (const v of [byHit, byRect, byKb]) {
			if (v == null) continue;
			if (ceiling == null || v < ceiling) ceiling = v;
		}
		return ceiling;
	}

	/**
	 * **智能避让**：摆好之后问浏览器「这个点上是谁」—— 被压住就把可用区底边收到
	 * 遮挡物顶边之上再排一次（最多 4 轮，单调收紧、无进展即停）。
	 *
	 * 为什么不能只靠算（2026-10-12 真机二次报障）：
	 *   Obsidian 的 `.mobile-toolbar`（快速编辑栏）**由核心在编辑器聚焦时动态追加**
	 *   到 `.app-container`（并随附一条 `height:var(--mobile-toolbar-height)` 的
	 *   `.mobile-toolbar-spacer` 把 `.workspace` 顶上去），收起时整组 `detach()`；
	 *   它的落点还由 `animateToKeyboardHeight()` 用内联 `translateY` 动画补位移。
	 *   这些变更**全程不发 resize / visualViewport 事件** ⇒ 任何「按事件算一次」的
	 *   几何模型都可能与最终像素差一条栏。实测遮挡是与实现无关的兜底：
	 *   不管官方怎么摆、什么时候摆，只要它压住我，我就抬。
	 *
	 * 每轮都从 {@link boundsResolver} 取**现测** bounds 起算 —— 原生栏收走时
	 * 自动回落，不会把「被压过」这个状态粘住。
	 */
	private avoidOcclusion(): void {
		if (!this.visible || this.inAvoidPass) return;
		if (!this.boundsResolver && !this.lastBounds) return;
		const doc = this.containerEl.ownerDocument ?? document;
		this.inAvoidPass = true;
		/** 现场取证载体（见 `selectionDiag`）：把这一趟避让的**原始判据取值**留给
		 *  「快照相邻界面」命令落盘。真机没有 devtools，这是唯一能拿到「那一刻到底
		 *  谁在什么位置」的通道。纯读、零副作用。 */
		const diag: {
			hit?: number | null;
			rect?: number | null;
			kb?: number | null;
			cap?: number | null;
			rounds: number;
		} = { rounds: 0 };
		try {
			/** 视口 y → bounds 本地 y 的换算原点的**视口坐标**。
			 *  `occlusionCeiling` 给的是视口 y，而 `bounds.top` 是宿主本地坐标 —— 两套
			 *  口径混着用会整体偏掉宿主原点（阅读器在 iframe 里、md 有页首偏移时都会）。
			 *  宿主原点 = 容器当前视口顶 − 容器当前写下的本地 top。 */
			const cRect = this.containerEl.getBoundingClientRect();
			const localTop = Number.parseFloat(this.containerEl.style.top || "0");
			const hostTop = cRect.top - (Number.isFinite(localTop) ? localTop : 0);
			/** 累计收紧后的可用区底边（**视口坐标**）；null = 还没测到遮挡 */
			let cap: number | null = null;
			for (let i = 0; i < 4; i++) {
				diag.rounds = i + 1;
				const fresh = this.boundsResolver?.() ?? this.lastBounds;
				if (!fresh) break;
				let bounds = fresh;
				// 自然落位留 8px 呼吸位（桌面 / 阅读器既有契约）；
				// **被实测遮挡后收紧的那一趟要 0 间隙重合** —— 用户要的就是
				// 「插件工具条的下边框 = 官方快速编辑栏的上边框」。
				//
				// ⚠️ 旧实现在这里又减了一个 8，叠加 `placeFloating` 的 `margin:8`
				// ⇒ 抬升后工具条底边恒落在 `cap − 16`，而 `cap` 恰恰是遮挡物的**上边框**：
				// 两条边框之间永远差 16px，肉眼看得出来「没重合」（2026-10-12 逐字报障）。
				// 而既有断言（md-kb S 档）当时把容忍带放到 64px ⇒ 这条空隙一直「合法」。
				let edgeMargin = 8;
				if (cap != null) {
					const h = Math.floor(cap - hostTop - (fresh.top ?? 0));
					if (h >= fresh.height - 0.5) break;
					bounds = { ...fresh, height: Math.max(120, h) };
					edgeMargin = 0;
				}
				this.lastBounds = bounds;
				this.reposition(this.lastAnchorRect, bounds, { edgeMargin });
				const ceiling = this.occlusionCeilingNow(doc, diag);
				if (ceiling == null) break;
				const next: number = cap == null ? ceiling : Math.min(cap, ceiling);
				// 收起后遮挡物顶边没变 = 已经到极限（例如可用区下界 120px 挡住）
				if (cap != null && next >= cap - 0.5) break;
				cap = next;
				diag.cap = cap;
			}
		} finally {
			this.inAvoidPass = false;
			// 取证放在 finally：无论正常收敛、提前 break 还是抛错，**最后一帧的真实几何**
			// 都必须落进缓冲 —— 真机上这一次可能就是用户看到重叠的那一次。
			recordSelectionDiag("avoid", this.containerEl, diag as unknown as Record<string, unknown>);
		}
	}

	/** 用现测 bounds 重排（键盘动画期间会被多次调用，内部按帧合并） */
	private replaceWithFreshBounds(): void {
		// 评论态始终重排；非评论态只有 md 侧显式打开 repositionAlways 才跟随
		// （阅读器非评论态不订阅，这个函数根本不会被调到）。
		if (!this.commentOpen && !(this.repositionAlways && this.visible)) return;
		const bounds = this.boundsResolver?.() ?? this.lastBounds;
		if (!bounds) return;
		this.lastBounds = bounds;
		this.reposition(this.lastAnchorRect, bounds);
	}

	constructor(actions: SelectionActions) {
		this.actions = actions;
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-selection-toolbar";
		this.render();
		this.hide();
		this.containerEl.addEventListener("pointerdown", e => e.stopPropagation());
	}

	private render(): void {
		this.containerEl.empty();

		// 一行两区（2026-10-14 用户：「按钮多的话会变成多行……改成可以左右滑动按钮」）：
		//   左 = `.unreader-selbar-scroll` 横滑带（按钮再多也只在带内左右滑，不换行）；
		//   右 = `.unreader-selbar-pinned` 钉住区（分隔线 + AI 入口 + 关闭钮，**不进横滑带**，
		//        滑到哪儿都在屏幕内）。
		// 钉住 AI 入口还有一个硬技术原因：它的悬浮名单（`.unreader-selbar-ai-menu`）是
		// 绝对定位、向上/下溢出工具条的浮层，而横滑带是 `overflow-x: auto` 的滚动容器
		// —— 名单住在里面会被**裁掉**。钉住区没有 overflow，浮层正常溢出。
		this.barRow = this.containerEl.createDiv({ cls: "unreader-selbar-row" });
		this.scrollEl = this.barRow.createDiv({ cls: "unreader-selbar-scroll" });

		const copyBtn = this.scrollEl.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "复制选中文字" } });
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (this.snapshot) this.actions.onCopy(this.snapshot.text);
			this.hide();
		});

		// 翻译入口常驻（UNagent 未装/未配时点击给指引，见 readerView.translateSelection）：
		// 验收要求「入口可见但点击给出明确指引」，不能按可用性隐藏按钮。
		// 唯一的显隐开关是用户在 AI 面板里关掉的 translateSelection（setTranslateEnabled）。
		this.translateDivider = this.scrollEl.createDiv({ cls: "unreader-selbar-divider" });
		const translateBtn = this.scrollEl.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "翻译选中文字" } });
		setIcon(translateBtn, "languages");
		translateBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (this.snapshot) this.actions.onTranslate(this.snapshot.text);
		});
		this.translateBtn = translateBtn;

		this.scrollEl.createDiv({ cls: "unreader-selbar-divider" });

		// 色板整体包一层：窄屏（换行时代）时 6 枚色点作为**一个原子组**挪走，
		// 而不是在行中段被拆成「4 枚在上、2 枚在下」（见 styles.css 的 .unreader-selbar-colors）。
		const colorGroup = this.scrollEl.createDiv({ cls: "unreader-selbar-colors" });

		for (const color of HIGHLIGHT_COLORS) {
			const dot = colorGroup.createDiv({
				cls: "unreader-selbar-dot",
				attr: { "aria-label": `高亮（${color.label}）` },
			});
			dot.style.backgroundColor = highlightColorOf(color.name).replace(/[\d.]+\)$/, "1)");
			dot.addEventListener("click", e => {
				e.stopPropagation();
				this.pickedColor = color.name;
				if (this.snapshot) this.actions.onHighlight(color.name);
				this.hide();
			});
		}

		this.commentDivider = this.scrollEl.createDiv({ cls: "unreader-selbar-divider" });

		const commentBtn = this.scrollEl.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "高亮并添加评论" } });
		setIcon(commentBtn, "message-square-text");
		commentBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.openCommentEditor();
		});
		this.commentBtn = commentBtn;

		// ---- 钉住区：不进横滑带，横滑时纹丝不动 ----
		const pinned = this.barRow.createDiv({ cls: "unreader-selbar-pinned" });
		pinned.createDiv({ cls: "unreader-selbar-divider" });

		// 统一 AI 入口（一枚按钮 + 悬浮展开的工具名单，见 setAiTools）：
		// 名单为空时整个容器收起，不占位、不动原有布局。
		// 与高亮气泡共用同一份实现（SelbarAiMenu，2026-09-29 用户「共用一套代码」）。
		// 点击瞬间把当前快照文本一并递出（不能等面板回头读活选区 —— iPad 触摸点按后选区已塌）
		this.aiMenu = new SelbarAiMenu(this.containerEl, id => this.actions.onRunAiTool?.(id, this.snapshot?.text ?? ""));
		pinned.appendChild(this.aiMenu.el);

		const closeBtn = pinned.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "关闭" } });
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.hide();
		});
		this.closeBtn = closeBtn;

		// 横滑提示（右缘渐隐）随内容与滚动更新
		this.scrollEl.addEventListener("scroll", () => {
			this.closeAiMenu();
			this.refreshScrollHint();
		}, { passive: true });

		this.commentWrap = this.containerEl.createDiv({ cls: "unreader-selbar-comment" });
		this.commentWrap.hide();

		// 背板：盖住正文（点击 = 取消），点击事件见下方 wiring
		const scrim = this.containerEl.createDiv({ cls: "unreader-comment-scrim" });
		scrim.addEventListener("pointerdown", e => {
			e.stopPropagation();
			e.preventDefault();
			this.hide();
		});

		// 弹框的标题行：说清「在给什么写评论」，右侧关闭键与「取消」等价
		const head = this.commentWrap.createDiv({ cls: "unreader-comment-head" });
		this.commentTitle = head.createDiv({ cls: "unreader-comment-title", text: "添加评论" });
		const dialogCloseBtn = head.createDiv({ cls: "unreader-comment-close", attr: { "aria-label": "关闭" } });
		setIcon(dialogCloseBtn, "x");
		dialogCloseBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.hide();
		});
		this.commentQuote = this.commentWrap.createDiv({ cls: "unreader-comment-quote" });

		const ta = this.commentWrap.createEl("textarea", {
			cls: "unreader-hl-pop-comment",
			attr: { placeholder: "写下评论，将与高亮一同保存…" },
		});
		this.commentInput = ta;
		ta.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.submitComment();
		});

		const row = this.commentWrap.createDiv({ cls: "unreader-hl-pop-comment-row" });
		row.createEl("button", { text: "取消" }).addEventListener("click", e => {
			e.stopPropagation();
			this.hide();
		});
		row.createEl("button", { text: "保存", cls: "mod-cta" }).addEventListener("click", e => {
			e.stopPropagation();
			this.submitComment();
		});

		// 重复 render 时把「评论按钮显隐」的既有状态补回来（render 只由构造函数调用，
		// 这行是防御性的：将来若新增重渲染入口，状态不会丢）
		this.syncCommentButton();
	}

	private openCommentEditor(): void {
		this.closeAiMenu();
		this.commentOpen = true;
		// 弹框态：容器退成透明的定位盒，内容 = 背板 + 评论卡片（样式见 styles.css 第 6 节）
		this.containerEl.addClass("is-comment-open");
		// 标题与原文：选中文字就是这次标注的对象（背板压暗正文后，这一行是唯一的位置锚点）
		this.commentTitle.setText("添加评论");
		this.commentQuote.setText(this.snapshot?.text ?? "");
		this.commentWrap.show();
		this.barRow.addClass("is-hidden");
		// 先在「展开态 + 当前 bounds」下排一次（reposition 内会读 offsetHeight 强制布局，尺寸已就绪），
		// 再挂键盘订阅：输入框 focus 会拉起键盘 → 官方把 .app-container 收缩到
		// `100vh - --keyboard-height`，之后每次几何变化都必须重排，
		// 否则编辑区会停在键盘下面、被 .unreader-body 的 overflow:hidden 裁掉。
		this.replaceWithFreshBounds();
		window.requestAnimationFrame(() => {
			this.replaceWithFreshBounds();
			this.commentInput.focus();
		});
		this.watchGeometry();
		window.setTimeout(() => this.commentInput.focus(), 30);
	}

	/** 可用高度装不下整张评论卡片时（手机横屏、iPad 分屏 + 键盘）压缩输入区，
	 *  而不是把「保存 / 取消」按钮行沉到键盘下面。桌面端可用高度充裕 → 值恒为 CSS 上限。
	 *
	 *  2026-09-20 这一格变成**弹框卡片**（标题行 + 引用行 + 输入区 + 按钮行）之后，
	 *  「非输入区高度」必须把新增的标题行与引用行一起量进去；实在装不下时先让引用行退场。
	 *
	 *  口径与 `HighlightPopover.fitCommentHeight` **逐字同源**（`test:comment-mobile` 同一套
	 *  断言同时覆盖两处），改一处必须同步改另一处。 */
	private fitCommentHeight(available: number): void {
		const rowH = this.commentWrap.querySelector<HTMLElement>(".unreader-hl-pop-comment-row")?.offsetHeight ?? 32;
		const headH = this.commentWrap.querySelector<HTMLElement>(".unreader-comment-head")?.offsetHeight ?? 22;
		const quoteH = this.commentWrap.querySelector<HTMLElement>(".unreader-comment-quote")?.offsetHeight ?? 0;
		// 极窄可用区（实测 ~172px：手机横屏 / iPad 分屏 + 键盘）：卡片自己的固定开销
		// （标题行 + 引用行 + 按钮行 + 内边距与行距）就要吃掉 ~150px，硬压输入区只会把按钮行
		// 顶到键盘下面。所以先让**引用行退场**——它只是「别写错地方」的锚点，输入框与按钮行
		// 才是必须留住的（`is-tight` 同时把内边距与行距收一档，见 styles.css 第 6 节）。
		const tight = available < 240;
		this.commentWrap.toggleClass("is-tight", tight);
		// 卡片上下 padding(12+12) + 三段 10px 行距 + 上下 16px 余量；紧凑档 = padding(10+10)
		// + 两段 8px 行距 + 16px 余量。
		const chrome = rowH + headH + (tight ? 0 : quoteH) + (tight ? 58 : 70);
		const next = Math.max(44, Math.min(200, Math.floor(available - chrome)));
		// min/max 必须一起写：CSS 给的 min-height(88px) 在 min > max 时会**反过来压过**内联
		// max-height（CSS 的 min/max 冲突规则），只写 max-height 的实现在极窄档压不下去
		// （实测卡片 213px > 可用 172px，按钮行照旧被裁）。
		this.commentInput.style.minHeight = `${Math.min(next, 88)}px`;
		this.commentInput.style.maxHeight = `${next}px`;
	}

	/** 清掉 `fitCommentHeight` 写下的内联尺寸与紧凑档标记（收起 / 重投编辑态时都要回到 CSS 口径）。
	 *  与它配对，别只清 max-height：留下 `is-tight` 会让下一次展开少一行引用。 */
	private resetCommentMetrics(): void {
		this.commentInput?.style.removeProperty("min-height");
		this.commentInput?.style.removeProperty("max-height");
		this.commentWrap?.removeClass("is-tight");
	}

	/**
	 * @param opts.edgeMargin 传给 `placeFloating` 的边距。**只有「被实测遮挡后收紧」
	 *   的那一趟传 0** —— 用户要求「插件工具条的下边框与官方快速编辑栏的上边框
	 *   **重合**」（2026-10-12 逐字报障）。自然落位恒为 8px：那是桌面 / 阅读器的既有
	 *   回归契约（`test:comment-mobile` 的「精确贴回可用区底边 −8px」），不许一起改。
	 */
	private reposition(anchorRect: DOMRect | null, bounds: Bounds, opts?: { edgeMargin?: number }): void {
		// 「隐藏测量」只在**首次落位**用：工具条还没写 left/top，不藏会在默认位置闪一帧。
		// 之后每次重排都 add/remove 的话，CSS 的 `.is-measuring{visibility:hidden}`
		// （排在 `.is-visible` 之后 ⇒ 必然压住）配合 `visibility 110ms` 的 transition，
		// 会把每一次几何微调都放大成一次淡出/淡入 —— 键盘收敛窗口内重排几十次，
		// 用户看到的就是「工具栏闪烁好一会儿才稳定」（2026-10-12 逐字报障）。
		// 已经摆好位置后再量无需隐藏，口径与 `TranslationCard.reposition()` 逐字同源。
		const firstPlacement = !this.containerEl.hasClass("is-visible");
		if (firstPlacement || measureAllBreaks()) this.containerEl.addClass("is-measuring");
		this.containerEl.addClass("is-visible");
		void this.containerEl.offsetHeight;
		let tw = this.containerEl.offsetWidth || 240;
		let th = this.containerEl.offsetHeight || 44;
		if (this.commentOpen) {
			this.fitCommentHeight(bounds.height);
			th = this.containerEl.offsetHeight || th;
			tw = this.containerEl.offsetWidth || tw;
		}
		this.containerEl.removeClass("is-measuring");
		// 固定模式：忽略锚点，正文区底部居中。
		// 「避开键盘 / 键盘上方原生栏」不再是这里的 bottomInset，而是由 bounds 本身就是
		// 可用矩形来保证（readerView 注入的 boundsResolver 已把高度裁到可用区底边）——
		// 一份口径只留一个来源，避免两处各减一次。
		//
		// ⚠️ **评论弹框态照旧走同一套定位**（2026-09-20 改成弹框时特意没动它）：弹框只是
		// 换了 `--ur-` 那套「面 / 圆角 / 投影 + 背板」，落点仍是「贴正文区底边」。
		// 为什么不学 Obsidian 弹窗那样居中：UNmemos 的编辑器注释写得很直白 ——
		// 「avoids the visual 'jump' of a centered modal and keeps the input box where
		// the user expects it」（`UNmemos/src/styles.css` 的 `.memos-editor-is-expanded`
		// 段），同一套设计体系里「原地/锚点定位」是刻意的选择。另外居中会立刻推翻三条
		// 既有回归契约（`test:comment-mobile` 的「精确贴回可用区底边 −8px」「极窄可用区
		// 整框落在可用区之上」「桌面档精确贴回 −8px」），而键盘避让的判据本身就是基于
		// 「贴可用区底边」推导的。
		const placed = placeFloating(anchorRect, { width: tw, height: th }, bounds, {
			margin: opts?.edgeMargin ?? 8,
			gap: 8,
			vertical: this.fixed ? "bottom" : "center",
		});
		const left = placed.left;
		let top = placed.top;
		const origin = placed.origin;
		// **贴底重合**（症状③，2026-10-13 用户逐字报障）：
		// 「obsidian 工具栏显示后，工具栏的上边框和插件工具栏的下边框没有重合，
		//   这个要智能检测，然后重合，这样视觉效果更佳紧凑」。
		//
		// 「智能检测」= `hardBottomEdge`：它**实测**官方原生栏的顶边（`getBoundingClientRect`，
		// 与谁盖谁、能不能点无关），而不是拿我们自己的模型自证。判据三条，缺一不可：
		//   ① 宿主显式打开了这枚开关（md 视图；阅读器的 8px 契约不动）；
		//   ② 真的**量到**一条在场原生栏（不在场时返回 null ⇒ 保留呼吸位，绝不对着
		//      「键盘带」这个模型贴死 —— 那会在栏回来之前先留出一整条 52px 空洞）；
		//   ③ 可用区底边**就是**那条栏的顶边（差 >1.5px 说明定住底边的是容器 / 键盘，
		//      不是那条栏，此时贴死没有对象）。
		// 阴性对照 `?break=snap` 注回旧行为（恒留 8px）⇒ S 档「0 间隙」那条必须变红。
		if (this.snapToHardBottom && !snapBottomBreak()) {
			const hard = hardBottomEdge(this.containerEl.ownerDocument ?? document);
			if (hard != null) {
				// 换算口径：`bounds` 是**宿主本地坐标**（原点 = 宿主 box 左上），
				// 加回宿主原点才是视口 y（与 `avoidOcclusion` 里那套算法同源）。
				const hostTop = this.containerEl.parentElement?.getBoundingClientRect().top ?? 0;
				const bottomVp = hostTop + (bounds.top ?? 0) + bounds.height;
				if (Math.abs(bottomVp - hard) <= 1.5) {
					top = Math.max(bounds.top ?? 0, (bounds.top ?? 0) + bounds.height - th);
				}
			}
		}
		this.containerEl.style.left = `${left}px`;
		this.containerEl.style.top = `${top}px`;
		this.containerEl.style.transformOrigin = origin;
		this.containerEl.addClass("is-visible");
		// 几何模型给出的落点只是「预算」，落位后再实测一次遮挡（见 avoidOcclusion）。
		// 官方快速编辑栏的追加/位移全程无事件，这是唯一与实现无关的兜底。
		this.scheduleAvoidOcclusion();
		// 首次落位：紧接着的这趟检测会落在 visibility 过渡中（occlusionCeiling 主动
		// 返回 null，不误判），再安排过渡（110ms）结束后补一趟真正的检测。
		if (firstPlacement) this.scheduleTransitionAvoid();
	}

	private submitComment(): void {
		if (!this.snapshot) return;
		this.actions.onComment(this.snapshot.text, this.commentInput.value.trim(), this.pickedColor);
		this.hide();
	}

	showFor(snapshot: SelectionSnapshot, anchorRect: DOMRect | null, bounds: Bounds): void {
		// 新一次显示不该带着上一次悬浮留下的 AI 名单（它不是编辑态，收起无副作用）
		this.closeAiMenu();
		// 新一次划词从横滑带**最左**开始（上次滑到哪与这次无关）。只在「由隐到显」那一拍复位：
		// md 侧拖动选择时 showFor 每 ~120ms 被调一次，无条件复位会把用户正滑到一半的带子拽回去。
		if (!this.visible && this.scrollEl) this.scrollEl.scrollLeft = 0;
		// 评论编辑区展开期间，**选区事件重投**不得重置编辑态（2026-09-19 真机回归的第二条路径）。
		//
		// 移动端软键盘弹起会让官方收缩 `.app-container` → 书页回流，浏览器常把同一段选区
		// **重新上报一次**（`pointerup` 的 `setTimeout(0)` 与 `selectionchange` 的 260ms 去抖
		// 两条路）。此刻选区仍是**非空**的，所以走不到「选区被系统收走」那条守卫，会一路
		// 落到这里。旧实现无条件执行下面那串重置：
		//   `commentOpen = false` + `commentWrap.hide()`（= `display:none`）
		//   → 输入框立刻 blur（已用 Chromium 实测：`display:none` / `visibility:hidden`
		//     都会让聚焦中的 textarea 失焦）→ 软键盘刚弹起就被系统压回去；
		//   并且 `commentInput.value = ""` 把用户已经打好的评论一起清掉。
		//
		// 判据为什么可以只看 `commentOpen`：**任何**「用户重新划选另一段」的意图，其起点
		// 必然是书页 iframe 或正文空白上的 `pointerdown`，而那条路一律先经
		// `dismissFloatingOnBlankClick()` → `hide()`（编辑区已关，`commentOpen === false`）。
		// 所以编辑区还开着时收到的选区事件，只可能是同一次划选的重投，不是新意图。
		if (this.commentOpen) {
			this.snapshot = snapshot;
			this.lastAnchorRect = this.fixed ? null : anchorRect;
			const freshBounds = this.boundsResolver?.() ?? bounds;
			this.lastBounds = freshBounds;
			this.reposition(this.lastAnchorRect, freshBounds);
			debugLog.info("[comment] 选区事件重投已让路（评论编辑区保持展开、已输入文字保留）",
				JSON.stringify(snapshot.text.slice(0, 24)));
			return;
		}
		this.snapshot = snapshot;
		this.lastAnchorRect = this.fixed ? null : anchorRect;
		this.commentOpen = false;
		this.containerEl.removeClass("is-comment-open");
		// 只有「订阅之后不会马上重建」时才退订（阅读器非评论态：不再跟随几何）。
		// md 侧（repositionAlways）下面会 watchGeometry 复用同一份订阅 —— 那里每 ~120ms
		// 被 showFor 调一次，先摘后建等于每次拖动都重建 ResizeObserver/MutationObserver
		// 和一串 setTimeout 收敛阶梯（用户报障「选中文字很卡顿」的直接来源）。
		if (!this.repositionAlways) this.stopWatching();
		this.pickedColor = "yellow";
		this.commentInput.value = "";
		this.resetCommentMetrics();
		this.commentQuote.setText("");
		this.commentWrap.hide();
		this.barRow.removeClass("is-hidden");

		// 有供体就用现测值（选中时传入的 bounds 是当次快照，展开评论时可能已过期）
		const fresh = this.boundsResolver?.() ?? bounds;
		this.lastBounds = fresh;
		this.reposition(this.lastAnchorRect, fresh);
		// md 侧（repositionAlways）：键盘动画 / 原生栏迟到期间工具条跟着重排，
		// 否则 capture 那一刻的 bounds 会把它钉在旧位置。hide() 里统一退订。
		if (this.repositionAlways) this.watchGeometry();
		this.notifyVisibility();
		this.refreshScrollHint();
	}

	/** 切换固定定位模式：固定后工具条不跟随选区，固定在正文区底部居中 */
	setFixed(fixed: boolean): void {
		this.fixed = fixed;
	}

	/** 「翻译」按钮显隐开关（AI 面板的选区翻译开关驱动）。连同它前面的分隔线一起
	 *  收起，避免留下两根相邻的竖线。 */
	setTranslateEnabled(enabled: boolean): void {
		if (!this.translateBtn) return;
		if (enabled) {
			this.translateBtn.show();
			this.translateDivider?.show();
		} else {
			this.translateBtn.hide();
			this.translateDivider?.hide();
		}
		this.refreshScrollHint();
	}

	/** 「高亮并添加评论」按钮显隐开关。**md 阅读模式必须关掉**：那里的高亮直接落成
	 *  官方 `==` 语法、没有旁车笔记，评论无处安放。连同它前面的分隔线一起收起，
	 *  避免留下一根孤零零的竖线（与 setTranslateEnabled 同款口径）。 */
	setCommentEnabled(enabled: boolean): void {
		this.commentEnabled = enabled;
		this.syncCommentButton();
	}

	private syncCommentButton(): void {
		if (!this.commentBtn) return;
		if (this.commentEnabled) {
			this.commentBtn.show();
			this.commentDivider?.show();
		} else {
			this.commentBtn.hide();
			this.commentDivider?.hide();
		}
		this.refreshScrollHint();
	}

	/** 设置划词工具条上的**自定义命令按钮**（数据见 settings.customButtons 中
	 *  showInSelbar 的项）。空数组 → 整个槽（含分隔线）摘除，DOM 回到零配置形态。
	 *
	 *  槽本身**不再自带滚动**（2026-10-14 改）：按钮挂进横滑带 `.unreader-selbar-scroll`
	 *  的末尾，与外层一起左右滑动 —— 嵌套两条横滑带时手指落在里面先滚内层、落在外层
	 *  滚外层，用户只会觉得「有时候滑不动」。按钮点击**不**统一收起工具条 ——
	 *  大多数命令（高亮/加粗等）自己会收口选区；是否隐藏交给命令本身。
	 *  `commandExists` 由视图层注入（组件不直接依赖 app.commands），返回 false 时置灰。 */
	setCustomButtons(
		buttons: Array<{ id: string; commandId: string; label: string; icon: string }>,
		onRun: (commandId: string) => void,
		commandExists?: (commandId: string) => boolean,
	): void {
		this.customWrap?.remove();
		this.customWrap = null;
		if (!buttons.length || !this.scrollEl) return;
		const wrap = this.scrollEl.createDiv({ cls: "unreader-selbar-custom-wrap" });
		wrap.createDiv({ cls: "unreader-selbar-divider" });
		const strip = wrap.createDiv({ cls: "unreader-selbar-custom" });
		for (const b of buttons) {
			const exists = commandExists ? commandExists(b.commandId) : true;
			const btn = strip.createDiv({
				cls: `unreader-selbar-btn is-custom${exists ? "" : " is-disabled"}`,
				attr: {
					"aria-label": exists ? (b.label || b.commandId) : `${b.label || b.commandId}（命令不可用）`,
					title: exists ? (b.label || b.commandId) : `命令不可用：${b.commandId}`,
					"aria-disabled": exists ? "false" : "true",
				},
			});
			setIcon(btn, b.icon || "zap");
			if (!btn.querySelector("svg")) setIcon(btn, "zap");
			btn.addEventListener("click", e => {
				e.stopPropagation();
				if (!exists) return;
				onRun(b.commandId);
			});
		}
		// 追加到横滑带末尾：自定义按钮始终位于「内置动作」之后、钉住的关闭钮之前
		this.scrollEl.appendChild(wrap);
		this.customWrap = wrap;
		this.refreshScrollHint();
	}

	/** 内容变了（按钮增减）或刚显示时重算「还能往右滑」的提示。宽度要到下一帧才落定，
	 *  所以统一走 rAF；重复排队无副作用（幂等 class 切换）。 */
	private refreshScrollHint(): void {
		window.requestAnimationFrame(() => syncRowScrollHint(this.scrollEl));
	}

	/** 设置划词工具栏上的**统一 AI 入口**名单（官方两枚 + 全部启用的自定义工具，见
	 *  AIPanel.selectionToolEntries）。实现与高亮气泡共用同一份（SelbarAiMenu）：
	 *  名单内容、开合两通道（悬浮 + 点按）与定位数学完全一致 —— 点已有高亮弹出的
	 *  工具条与划词工具条从此是同一套 AI 入口（2026-09-29 用户「共用一套代码」）。 */
	setAiTools(tools: AiToolEntry[]): void {
		this.aiMenu?.setTools(tools);
		// 入口出现/消失都会改变横滑带的余量
		this.refreshScrollHint();
	}

	private closeAiMenu(): void {
		this.aiMenu?.close();
	}

	hide(): void {
		// relocate 每帧调用：已经收干净时直接返回。下面每个 removeClass/removeProperty 都会
		// 碰样式或 class，空转时纯噪声（guard 不改变任何可观察状态：三个条件覆盖了 hide 的全部副作用）。
		if (!this.snapshot && !this.commentOpen && !this.visible) return;
		// 工具条一收，悬浮 AI 名单必须一起收：它是工具条的子元素，留下会浮在正文上
		this.closeAiMenu();
		// 取证：只有在**编辑区还开着**的时候收起才算故障路径 —— 它会 `visibility:hidden`
		// 掉承载输入框的容器，移动端软键盘随即被系统收走。带上调用栈，真机日志可直接指认
		// 是哪条路径动的手（正常出口：取消 / 关闭 / Esc / 点正文空白 / 点别处高亮 / 全沉浸）。
		if (this.commentOpen) debugLog.info("[comment] hide() 在编辑评论期间收起工具条 ←", new Error("fold"));
		this.snapshot = null;
		this.lastAnchorRect = null;
		this.lastBounds = null;
		this.commentOpen = false;
		this.containerEl.removeClass("is-comment-open");
		this.stopWatching();
		if (this.commentInput) {
			this.commentInput.value = "";
			this.resetCommentMetrics();
		}
		this.commentQuote?.setText("");
		this.commentWrap?.hide();
		this.barRow?.removeClass("is-hidden");
		this.containerEl.removeClass("is-visible");
		this.containerEl.style.removeProperty("transform-origin");
		this.notifyVisibility();
	}

	get visible(): boolean {
		return this.containerEl.hasClass("is-visible");
	}

	/** 评论编辑区是否展开（其间用户可能正在打字、软键盘可能正弹着）。
	 *
	 *  readerView 的「背景活动」路径（relocate / 书页滚动 / 选区被系统收走）据此让路：
	 *  收起容器会把正在编辑的输入框一起 blur 掉 —— 移动端表现为软键盘弹起又立刻被压回去
	 *  （用户报的「划线时键盘闪一下就没法标注了」）。 */
	get isCommentOpen(): boolean {
		return this.commentOpen;
	}
}
