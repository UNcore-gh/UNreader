/** markdown 阅读视图叠加层 —— 插件不接管 .md 文件，只在 Obsidian **原生**
 *  markdown 阅读视图（`MarkdownView.getMode() === "preview"`）上叠加四件东西：
 *  顶边章节进度条、右缘章节浮动目录条（复用阅读器的 `SideNav`）、沉浸模式会话，
 *  以及只承载插件自身组件的侧边工具栏（星标当前笔记 / 目录条 / 进度条 / 沉浸）。
 *
 *  ## 产品边界（2026-10-01 决策，见 AGENTS.md）
 *
 *  · md 由 Obsidian 原生编辑器管理，本插件**不注册** `md` 扩展名、不做 mdBook、
 *    不进书架（`test:book-filter` 钉死）——这里的叠加热是纯寄生，宿主是官方视图；
 *  · ⚠️ 2026-10-10 起**阅读模式与编辑模式都挂**（编辑含实时预览与源码 —— 官方
 *    `getMode()` 把两者都算作 `"source"`）：编辑侧没有渲染好的标题 DOM、也没有
 *    `previewMode.renderer.sections`，定位改走 CM6 的行块坐标
 *    （`editor.cm.lineBlockAt`）+ metadataCache 的标题行号，见 `posMode === "lines"`。
 *    阅读模式两条老路径（sections / dom）原样保留，互不干扰。
 *  · 进度**不做持久化**：官方阅读模式自带滚动位置记忆，这里只做实时显示；
 *  · 沉浸互斥：与阅读器的全沉浸共用一对 app 级 body 类
 *    （官方 `is-hidden-nav`），写入守 nativeNavPolicy 的
 *    「selfActive 才写」不变量；切到别的内容 leaf 自动退出（复用
 *    `immersionSession.ts` 的纯判据）。
 *  · 工具栏不碰正文排版：字体、字号、行距、页宽全部由 Obsidian 原生渲染器与主题
 *    控制；插件只暴露目录条、进度条、沉浸与星标这几项自己的组件状态。
 *
 *  ## 数据源与对齐（为什么用 DOM 而不是 metadataCache.headings）
 *
 *  目录、跳转、当前章判定统一以**预览 DOM 里的标题元素**为唯一事实来源：
 *  metadataCache.headings 与实际渲染可能数量不一致（内联标记 / frontmatter /
 *  渲染差异），按下标对齐会静默错位；DOM 直读则目录=跳转=判定天然同源。
 *  metadataCache 的 `changed` 事件只用作「该重建目录了」的触发器。
 *  嵌入（`![[…]]`）内部的标题用 `closest(".markdown-embed")` 排除——它们不是本文档
 *  的章节。条目取**该文件实际最外层级别 + 其下一级**（只两级，控制短横轨密度），
 *  深度 **0 起算**（最外层 = depth 0 = 最长那条，与阅读器/EPUB 侧同语义）——
 *  详见 `pickTocHeadings` / `tocDepth` 的注释（2026-10-13 报障「没有层级显示」）。
 *
 *  ## 生命周期
 *
 *  `MdOverlayManager` 照 `ExplorerHeal` 形态：插件 onload 里 new + start +
 *  `register(() => stop())`。manager 监听 `active-leaf-change` + `layout-change`
 *  双通道（同一 leaf 内换视图 / 切模式不派发 active-leaf-change，layout-change 补，
 *  见 readerView 同款注释），对每个 markdown leaf 的会话做挂载 / 卸载决策。
 *  卸载必须**零残留**：ResizeObserver、scroll 监听、host 元素、leaf 容器类、
 *  app 级 body 类全部摘干净——宿主是官方视图，脏了就是污染用户的编辑器。 */

import { Component, MarkdownRenderer, MarkdownView, Notice, setIcon, TFile, type App, type HeadingCache, type Workspace, type WorkspaceLeaf } from "obsidian";
import { SideNav } from "./sideNav";
import { SideHoverKeepAlive } from "./sideHoverKeepAlive";
import type { AnnotationsPanel } from "./annotationsPanel";
import { MdAppearancePanel, type MdAppearanceState } from "./mdAppearancePanel";
import { AIPanel } from "./aiPanel";
import { TranslationCard } from "./translationCard";
import { createSidePanel, toggleFeedStarState } from "./sidePanels";
import { filterSidePanelModes } from "../core/readableFormats";
import { isMarkdownNoteFile } from "../core/fileGate";
import { saveFeedEntryAsMarkdown } from "../core/feedNoteSave";
import type { Bounds } from "./floatingPlacement";
import { MdSelectionController } from "./mdSelection";
import { MdAnnotationAdapter } from "./mdAnnotations";
import type { FeedFilter, BookshelfCategoryFilter } from "../types";
import type { NavEntryModel } from "../core/engineAdapter";
import { endsImmersionOnActiveLeafChange, isSidePanelLeaf } from "./immersionSession";
import { headerHiddenByUs, bottomBarHiddenByUs } from "./nativeNavPolicy";
import { NativeNavGuard } from "./nativeNavGuard";
import { NativeChromeGate } from "./nativeChromeGate";
import { followHeaderMotion } from "./headerMotion";
import { PLUGIN_NAV_HIDDEN_CLASS } from "./nativeNavGuard";
import { bottomBarOverlap, floatingBottomInset, subscribeKeyboardGeometry, usableBottom } from "./keyboardInset";
import type UNreaderPlugin from "../main";

/** 「滚动到多近算抵达本章」的余量（px）：比页首高略大，章标题刚被页首压住时
 *  就算进入本章 —— 与章内进度的 0 点（标题贴滚动容器顶）保持同一观感。 */
const ACTIVE_EPS = 72;

/** 阅读视图底部的**反向链接区域**选择器：它由官方附加在正文之后、不属于笔记
 *  源内容（1.13 阅读模式尾部渲染），进度计算（分母/终点/标题收集）必须排除，
 *  否则滚到反链区进度条还在走、且 100% 的位置被反链列表的高度推后。多候选
 *  兜底官方类名漂移，真机 1.13.7 取证见 AGENTS.md。 */
const BACKLINKS_SEL = ".embedded-backlinks, .backlinks";

/** 官方渲染器分节的形状（`previewMode.renderer.sections` 的字段是内部的，
 *  只取我们用到的三个，全部容错读 —— 结构漂移时自然降级 DOM 模式）。 */
interface RendererSection {
	start?: { line?: number };
	end?: { line?: number };
	height?: number;
	/** 1.13+ 的虚拟渲染器给每节带一个 DOM 元素；有它就能用 `contains` 精确定位，
	 *  不必靠高度累积（高度口径在虚拟渲染下会漂）。老结构没有 → 自然降级。 */
	el?: unknown;
}

/** CM6 `EditorView` 的最小结构面 —— 编辑 / 源码模式下行块坐标的唯一来源。
 *  官方 `Editor` 接口不暴露它，靠 `editor.cm` 结构化取用（同 `tryGetActiveLeaf`
 *  的既有先例）；只读两样：文档行信息、`lineBlockAt` 给的行块像素坐标。
 *  结构漂移时自然降级（topsViaLines 返回 null → 只保留全文进度）。 */
interface EditorViewLike {
	state: {
		doc: {
			lines: number
			length: number
			line(n: number): { from: number }
		}
	}
	lineBlockAt(pos: number): { top: number; height: number }
}

/** 目录条取哪些标题 + 每条归到哪一级（sections 与 dom 两个数据源共用这一份，防两处漂移）。
 *
 *  两条规矩（2026-10-13 报障「markdown 笔记里浮动目录条没有层级显示，长度都一个样子」）：
 *
 *  ① **基准 = 该文件实际出现的最浅标题级别**，只取「基准」与「基准 + 1」两级 ——
 *     「只取两级、控制短横轨密度」这个既定产品口径不变，变的只是把它**锚到文件自己的
 *     结构上**。旧写法写死 `level <= 2`（没有 H1 才降级 `<= 3`）：对「只有 `##` 和 `###`」
 *     的笔记（Obsidian 里极常见 —— H1 就是文件名、正文从 `##` 起）只会选中 `##` 一级，
 *     于是所有短横落在同一个 `data-depth` 上、长度完全一样，层级彻底看不见。
 *  ② **深度 0 起算**（`level - base`）。阅读器侧 `engineAdapter.getNavEntries` 的 depth 就是
 *     0 起（最外层 = depth 0 = 最长那条），md 侧旧写法 `Math.max(1, level - min + 1)` 把最外层
 *     也算成「二级」，整条阶梯被压到 16 / 11 两档、最长那档 21u 永远用不上，看上去更「平」。 */
function pickTocHeadings<T>(items: T[], levelOf: (x: T) => number): { picks: T[]; base: number } {
	const base = items.length ? Math.min(...items.map(levelOf)) : 1;
	return { picks: items.filter(x => levelOf(x) <= base + 1), base };
}

/** 标题级别 → 短横层级（0 起，封顶 3 —— 与 `SideNav.renderEntries` 的 `Math.min(depth, 3)` 同口径）。 */
function tocDepth(level: number, base: number): number {
	return Math.max(0, Math.min(3, level - base));
}

/** 单个 markdown leaf 的叠加会话：挂载/卸载本 leaf 的全部叠加 UI。
 *  导出仅为探针（test/md-overlay-probe.ts）可 patch 原型注回旧行为做阴性对照。 */
export class MdOverlaySession {
	/** 叠加层根：absolute 铺满 leaf 容器，承载 CSS 变量与沉浸态类。 */
	private host: HTMLElement | null = null;
	private progressEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private sideNav: SideNav | null = null;
	private railTocBtn: HTMLElement | null = null;
	private railSideBtn: HTMLElement | null = null;
	private railStarBtn: HTMLElement | null = null;
	private railAppearanceBtn: HTMLElement | null = null;
	private railAIBtn: HTMLElement | null = null;
	private railHighlightsBtn: HTMLElement | null = null;
	private railImmersionBtn: HTMLElement | null = null;
	/** 左上角灯绳（全沉浸开关）：与阅读器同一个 CSS 类、同一套纯 CSS 图形。 */
	private immersionSwitchEl: HTMLElement | null = null;
	/** 灯绳回弹动画的 420ms 收尾定时器（卸载时必须清，避免操作已移除元素）。 */
	private immersionSwitchPullTimer: number | null = null;
	/** 「页首可见时」的下缘让位量（px，host 坐标系）。
	 *  md 全沉浸是 `display:none` 页首，隐藏后**再也量不到**可见时的下缘；
	 *  而除灯绳与**进度条**外的所有 UI 都要求位置固定（见 syncProgressTop），
	 *  所以在可见态采一次存下来，隐藏态继续沿用。0 = 从未在可见态采到（退化为旧行为）。 */
	private lastVisibleHeaderInset = 0;
	/** md 官方 `==` 高亮 → 标注侧边栏适配器（data 现算、跳转、删除、复制引用）。 */
	private mdAnnotations: MdAnnotationAdapter | null = null;
	/** 侧边抽屉：与阅读器**同一个** `AnnotationsPanel`、同一套接线（`sidePanels.ts`）。
	 *  只裁掉标注页（那是「当前这本书」的高亮/书签，Markdown 没有对应上下文）。 */
	private sidePanel: AnnotationsPanel | null = null;
	/** 过滤版「阅读外观」：只留对 Markdown 生效的项（目录条 / 进度条 / 沉浸）。 */
	private appearancePanel: MdAppearancePanel | null = null;
	/** AI 助手面板：与阅读器同一个 `AIPanel`（全文翻译 / 排版优化 / 选中文字工具）。 */
	private aiPanel: AIPanel | null = null;
	/** AI「选中文字」的结果卡片：与划词翻译同一张 `TranslationCard`。 */
	private translationCard: TranslationCard | null = null;
	/** 阅读模式的划词工具条控制器：把选中文字写成官方 `==高亮==`。
	 *  只在 **preview** 模式工作（编辑模式内部早退），生命周期随本会话。 */
	private selection: MdSelectionController | null = null;
	/** 渲染 AI 结果 markdown 用的短生命周期 Component（**不能**拿 plugin 当 Component：
	 *  它的生命周期跟着插件走，会让每次渲染注册的子组件永远不被回收）。会话卸载时 unload。 */
	private readonly renderComponent = new Component();
	/** 抽屉各页的本地筛选态（与阅读器各自持有，互不串）。 */
	private readonly sideState = {
		bookshelfCategoryFilter: "all" as BookshelfCategoryFilter,
		feedFilter: "all" as FeedFilter,
		feedSourceFilter: null as string | null,
	};
	/** 抽屉上次停留的页（纯开合语义的按钮重开时回到它）。 */
	/** 抽屉关闭时停留的**选内容页**（书架/订阅/笔记）；高亮页不算 —— 与阅读器同语义：
	 *  侧边栏按钮只负责选内容页之间的导航，「高亮」由专门的按钮直达。 */
	/** 默认落「笔记」页：这个宿主上正在读的就是一份 markdown 笔记 —— 与阅读器同口径
	 *  （侧边栏展开 = 当前阅读内容的**选择界面**：书→书架、RSS→订阅、笔记→笔记）。 */
	private lastSideMode: "bookshelf" | "feeds" | "notes" = "notes";
	private entries: NavEntryModel[] = [];
	/** 与 entries 一一对应的标题元素（DOM 定位模式；见 posMode 注释） */
	private headingEls: HTMLElement[] = [];
	/** sections 定位模式下与 entries 对齐的文档行号（HeadingCache.position.start.line） */
	private headingLines: number[] = [];
	/** 与 headingLines/headingEls 一一对应的标题级别（进度条分段粒度用：
	 *  scope=N 时只取 level<=N 的条目作为分段边界）。 */
	private headingLevels: number[] = [];
	/** 标题定位模式。
	 *  · **sections**（阅读模式）：官方渲染器把全文解析成有序分节
	 *    （`previewMode.renderer.sections`，节高累积 ≈ 文档布局，真机 1.13.7 实测
	 *    Σheight 与 sizer 仅差 1px）—— 1.13 起阅读视图是**滚动窗口虚拟渲染**（任一
	 *    时刻 DOM 只有窗口附近的几节，实测滚到文末 heading 数为 0），DOM 直读拿不到
	 *    完整目录，必须走分节累积 + metadataCache 的标题行号；
	 *  · **dom**（全渲染的老版本 Obsidian / 探针夹具）：直读标题元素，
	 *    目录 = 跳转 = 判定天然同源；
	 *  · **lines**（编辑 / 源码模式，2026-10-10 加）：那边没有渲染好的标题 DOM、也没有
	 *    `renderer.sections`，唯一可用的事实来源是 metadataCache 的标题行号，像素坐标
	 *    由 CM6 的 `lineBlockAt` 现算（见 topsViaLines）。 */
	private posMode: "sections" | "dom" | "lines" = "dom";
	/** 本会话上次见到的视图模式：换模式要重挑滚动容器并重建目录。 */
	private mode: MdViewMode | null = null;
	private scrollEl: HTMLElement | null = null;
	private ro: ResizeObserver | null = null;
	private scrollHandler: (() => void) | null = null;
	private rafPending = false;
	private rebuildTimer: number | null = null;
	private lastProgressTop = -1;
	/** `syncProgressTop` 的写入去重缓存：CSS 变量值没变就**不写**。
	 *
	 *  为什么必须去重（2026-10-11 用户报障「章节进度条很卡顿，没有电子书 / RSS 丝滑」）：
	 *  `syncProgressTop` 每帧都被 `update` 调到，原先**无条件**对叠加根写 4 个自定义属性。
	 *  叠加根是 `inset:0` 的寄生层、子树很大（导轨 / 抽屉 / 进度条），每帧都写样式会让
	 *  样式失效 + 重排蔓延到整棵子树 —— 滚动时肉眼可见掉帧。值不变就不碰 DOM，成本归零。 */
	private lastTopInset = Number.NaN;
	private lastBottomInset = Number.NaN;
	/** 贴底浮层（手机 AI 面板 sheet / 译文卡）的让位量（px，取 usableBottom 口径）。
	 *  与 `--ur-bottom-inset` **不是一个口径**，别合并：
	 *  · `--ur-bottom-inset` 只含原生栏（抽屉用：容器已随键盘收缩，再减键盘 = 重复计）；
	 *  · 本变量取 usableBottom 口径（容器底 / 键盘上沿 / 可视视口 / 键盘上方原生栏取 min）
	 *    ⇒ 稳态值 = 键盘上方那条原生栏高（~52px，把 sheet 抬到栏之上）；键盘收起回 0。
	 *    ⚠️ 稳态下**不是**「键盘」在起作用：宿主底边实测**随键盘收缩**（见下条注释）；
	 *    真正含键盘的是 `keyboard-animating` 档与 iPad 浮动键盘档。
	 *  见 keyboardInset.floatingBottomInset 的注释。 */
	private lastKbInset = Number.NaN;
	private lastSwitchTop = Number.NaN;
	private lastSwitchAvoid = Number.NaN;
	/** 页首动效跟随器与 Obsidian 布局类观察器。 */
	private nativeHeaderObserver: MutationObserver | null = null;
	private nativeHeaderSignature = "";
	private nativeHeaderHiddenState: boolean | null = null;
	private progressTopFollowStop: (() => void) | null = null;
	private progressTopFollowToken = 0;
	/** 键盘 / 原生栏几何订阅（只服务 `--ur-kb-inset` 的现测写入）。 */
	private unwatchKb: (() => void) | null = null;
	/** `.view-header` 元素引用缓存：`syncProgressTop` 每帧都要它，别每帧 querySelector。 */
	private headerEl: HTMLElement | null = null;
	/** 正文底（内容坐标系）缓存：它只随**布局**变化，与滚动无关 ——
	 *  两个 rect 同向平移，差值恒定（见 contentBottom）。布局变化由 ResizeObserver 通知，
	 *  所以可以缓存；每帧重算等于每帧多两次强制同步布局。 */
	private contentBottomCache: number | null = null;
	private contentBottomCached = false;
	/** 沉浸会话态（与呈现分离：切到侧栏时保持会话、只放掉 app 级类） */
	private immersed = false;
	/** 点按显隐会话态（用户 2026-10-16 要求：阅读模式点屏幕收/放**全部**元素，
	 *  语义同 RSS/电子书）。与 `immersed`（灯绳全沉浸）相互独立、可同时开；
	 *  只在阅读模式（preview）有效，切编辑态由 syncMode 强制收起。 */
	private chromeHidden = false;
	private chromeRevealed = false;
	private normalModeShowToolbar: boolean | null = null;
	private nativeNavGuard: NativeNavGuard | null = null;
	/** 点按显隐的指针起落监听（挂 view.contentEl）。tapEl 存的是**挂载时那个**
	 *  contentEl 引用 —— 卸载必须按同一引用摘，靠 `this.view?.contentEl` 现取会在
	 *  popout/重建场景取到另一个元素而漏摘。 */
	private tapEl: HTMLElement | null = null;
	/** 快照监听（pointerdown 捕获）挂的那份 document —— 与 tapEl 同理，摘监听必须
	 *  按挂载时那个引用（popout 窗口里 host.ownerDocument 会变）。 */
	private tapDoc: Document | null = null;
	private tapDownHandler: ((e: PointerEvent) => void) | null = null;
	private tapClickHandler: ((e: MouseEvent) => void) | null = null;
	/** pointerdown 那一刻是否已有非空选区：有 ⇒ 这一拍是「点掉选区」，
	 *  不该顺带切 chrome（否则用户永远陷在「选词→点掉→界面忽隐」里）。 */
	private tapHadSelection = false;
	/** pointerdown 那一刻是否有悬浮面板开着：抽屉/AI/外观是 **pointerdown 相位**
	 *  就被「点外面关」收掉的 —— 等 click 时再问 isOpen 只会得到 false，那一拍会被
	 *  误判成普通点按、顺带把 chrome 也翻了。所以开合态必须在按下那一刻记快照。 */
	private tapPanelOpen = false;
	/** 悬浮自动关闭的待执行定时器 / 临时挂起（抽屉内菜单打开期间用）。 */
	private sideAutoCloseTimer: number | null = null;
	private sideAutoCloseHold = false;
	/** 「指针还在抽屉 / 左缘功能轨那条带子里吗」的判定器（见 sideHoverKeepAlive.ts）。 */
	private sideKeepAlive: SideHoverKeepAlive | null = null;
	/** document 级「点抽屉外面就关」的监听（触屏没有 hover，靠它关 —— iPad 报障）。 */
	private outsidePointerHandler: ((e: PointerEvent) => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: UNreaderPlugin,
		private readonly leaf: WorkspaceLeaf,
	) {}

	private get view(): MarkdownView | null {
		const view = this.leaf.view;
		return view instanceof MarkdownView ? view : null;
	}

	isMounted(): boolean {
		return this.host != null;
	}

	isImmersed(): boolean {
		return this.immersed;
	}

	/** 同一 leaf 内换了文件后，只刷新工具栏状态（星标按钮跟的是当前 file.path），
	 *  不做整轮设置重放与进度重算 —— 换文件的滚动复位由官方视图负责。 */
	refreshToolbar(): void {
		this.syncToolbarButtons();
	}

	/** 按设置挂载/补挂叠加层；幂等（已挂载直接返回）。 */
	mount(): void {
		const view = this.view;
		if (!view || this.host) return;
		const container = view.containerEl;
		if (!container) return;
		this.mode = modeOf(view);
		container.addClass("unreader-md-view");
		this.host = createDiv("unreader-md-root");
		container.appendChild(this.host);
		// 新叠加根 = 内联样式全空：把「值没变就不写」的写入去重缓存一并作废，
		// 否则复用的会话实例会因「值没变」而漏写这批 CSS 变量（见 syncProgressTop）。
		this.lastProgressTop = -1;
		this.lastTopInset = Number.NaN;
		this.lastBottomInset = Number.NaN;
		this.lastKbInset = Number.NaN;
		this.lastSwitchTop = Number.NaN;
		this.lastSwitchAvoid = Number.NaN;
		this.headerEl = null;
		this.contentBottomCached = false;
		// 键盘 / 原生栏几何订阅：只在收到信号时重写 `--ur-kb-inset`（值没变就不碰样式，
		// 与 syncProgressTop 的去重同一理由）。回调不整轮 requestUpdate —— 键盘弹起
		// 只影响贴底浮层的让位量，与滚动进度无关。
		this.unwatchKb?.();
		this.unwatchKb = subscribeKeyboardGeometry(this.host, () => {
			if (!this.host) return;
			const kbInset = floatingBottomInset(this.host);
			if (kbInset === this.lastKbInset) return;
			this.lastKbInset = kbInset;
			this.host.style.setProperty("--ur-kb-inset", `${kbInset}px`);
		});

		// 进度条：总是建，用 is-off 控显隐（与阅读器 applyChapterProgressSetting 同款，
		// 设置开关即时生效不需要拆建 DOM）
		const showProgress = this.plugin.settings.mdOverlayShowProgress !== false;
		this.progressEl = this.host.createDiv({ cls: showProgress ? "unreader-progress" : "unreader-progress is-off" });
		this.progressFillEl = this.progressEl.createDiv({ cls: "unreader-progress-fill" });

		// 左上角灯绳（全沉浸开关）：与阅读器同一个 CSS 类、同一套纯 CSS 图形
		// （pull/stem/bar-mid/bar-long/bar-short/hit 六个 span）。md 视图此前只有
		// 侧轨里的 maximize-2 图标钮，左上角没有灯绳（用户 2026-10-11 报障）。
		this.buildImmersionSwitch();

		// 目录条：SideNav 构造零依赖、回调注入。md 侧只挂 navEl + actionsEl：
		// actionsEl 里只放插件自己的阅读组件开关，正文排版（行距/字体/页宽）全部交给
		// Obsidian 原生渲染器与主题，不在这里复制一套。
		this.sideNav = new SideNav();
		this.host.appendChild(this.sideNav.navEl);
		this.host.appendChild(this.sideNav.actionsEl);
		// 「回到之前阅读」是 UNreader 内容轨的导航语义，对官方 Markdown 阅读模式没有
		// 对应动作；不带着一个点了无反应的按钮。
		this.sideNav.backEl.remove();
		this.sideNav.setRailVisible(this.plugin.settings.mdOverlayShowTocRail !== false);
		this.sideNav.setActionsVisible(true);
		this.buildToolbarButtons();
		this.mountPanels();
		this.rebuildToc();

		this.chromeHidden = this.plugin.settings.appearance.normalModeShowToolbar === false;
		this.normalModeShowToolbar = this.plugin.settings.appearance.normalModeShowToolbar !== false;
		this.applySettings();
		this.syncChromeHidden();
		this.nativeNavGuard = new NativeNavGuard({
			document: this.host.ownerDocument,
			wantsHidden: () => this.nativeNavWanted(),
			sync: () => this.syncNativeNavClasses(),
		});
		this.nativeNavGuard.start();
		const ownerDoc = this.host.ownerDocument;
		this.nativeHeaderSignature = this.nativeHeaderLayoutSignature(ownerDoc);
		this.nativeHeaderObserver = new MutationObserver(() => {
			const next = this.nativeHeaderLayoutSignature(ownerDoc);
			if (next === this.nativeHeaderSignature) return;
			this.nativeHeaderSignature = next;
			this.scheduleProgressTopResync();
		});
		this.nativeHeaderObserver.observe(ownerDoc.body, { attributes: true, attributeFilter: ["class"] });

		// 划词工具条：选中文字 → 官方 `==高亮==` 写回源文件。监听统一挂上，由 controller
		// 内部按模式早退（编辑 / 源码模式不接管，官方那边有自己的选区行为）。
		this.selection = new MdSelectionController({
			app: this.app,
			view: () => this.view,
			host: () => this.host,
			windowFor: (range, rect) => this.windowForSelection(range, rect),
			bounds: () => this.selectionBounds(),
			aiTools: () => this.aiPanel?.selectionToolEntries() ?? [],
			runAiTool: (id, text) => this.aiPanel?.runToolById(id, text),
			holdScroll: () => this.holdScrollPosition(),
		});
		this.selection.attach();
		// 划词控制器此刻才建好：把自定义按钮首帧同步进去（侧栏槽在 buildToolbarButtons
		// 阶段已同步过，这里再调一次是幂等全量重推）。
		this.syncCustomButtons();

		// 点按显隐全部元素（阅读模式专属；监听挂 contentEl —— 宿主 chrome 是它的
		// **兄弟**子树，点插件 widget 不会冒泡到这里，天然不用排除自家元素）。
		this.attachTapToggle();

		// 模式刚切到 preview 时官方可能还没完成首次排版，探测留一拍
		// （window. 前缀：md 视图可能住在 popout 窗口，要用那个 window 的帧回调）
		window.requestAnimationFrame(() => {
			if (!this.host) return;
			this.resolveScrollEl();
			this.observeSizing();
			if (this.scrollEl && !this.scrollHandler) {
				this.scrollHandler = () => this.requestUpdate();
				this.scrollEl.addEventListener("scroll", this.scrollHandler, { passive: true });
			}
			this.requestUpdate();
		});
	}

	/** 左上角灯绳（全沉浸开关）：DOM / 事件照搬 readerView 3467-3488 —— 同一个
	 *  `.unreader-immersion-switch` 类、同一套六 span 纯 CSS 图形、同一段回弹动画。
	 *  挂在 host 上（与抽屉 / 轨道同一定位包含块），跟随 host 卸载零残留。
	 *  按钮本体 pointer-events:none，只有底部 `-hit` 灯绳结可点（全局 CSS），透明的
	 *  上半段不会抢走悬浮页首按钮的触摸。 */
	private buildImmersionSwitch(): void {
		if (!this.host) return;
		this.immersionSwitchEl = this.host.createEl("button", {
			cls: "unreader-immersion-switch",
			attr: {
				type: "button",
				"aria-label": "进入全沉浸",
				"aria-pressed": "false",
				title: "进入全沉浸",
			},
		});
		const pull = this.immersionSwitchEl.createSpan({ cls: "unreader-immersion-switch-pull" });
		pull.createSpan({ cls: "unreader-immersion-switch-stem" });
		pull.createSpan({ cls: "unreader-immersion-switch-bar-mid" });
		pull.createSpan({ cls: "unreader-immersion-switch-bar-long" });
		pull.createSpan({ cls: "unreader-immersion-switch-bar-short" });
		this.immersionSwitchEl.createSpan({ cls: "unreader-immersion-switch-hit" });
		this.immersionSwitchEl.addEventListener("pointerdown", e => e.stopPropagation());
		this.immersionSwitchEl.addEventListener("click", e => {
			e.preventDefault();
			e.stopPropagation();
			if (this.plugin.settings.mdOverlayImmersive === false) return;
			this.playImmersionSwitchPull();
			this.toggleImmersion();
		});
	}

	/** 只播放一次拉绳回弹动画，不延迟状态切换。重复连点重启动画（阅读器同款）。 */
	private playImmersionSwitchPull(): void {
		const el = this.immersionSwitchEl;
		if (!el) return;
		if (this.immersionSwitchPullTimer !== null) window.clearTimeout(this.immersionSwitchPullTimer);
		el.removeClass("is-pulling");
		void el.offsetWidth;
		el.addClass("is-pulling");
		this.immersionSwitchPullTimer = window.setTimeout(() => {
			this.immersionSwitchPullTimer = null;
			this.immersionSwitchEl?.removeClass("is-pulling");
		}, 420);
	}

	/** 换视图形态（阅读 ↔ 编辑；编辑含实时预览与源码）后的重算：滚动容器与标题
	 *  数据源都换了人。幂等 —— 形态没变直接返回（syncAll 每次都会调它）。 */
	syncMode(): void {
		if (!this.host) return;
		const next = modeOf(this.view);
		if (next === this.mode) return;
		this.mode = next;
		// 点按显隐是**阅读模式**语义：切到编辑/实时预览先收干净。编辑态里「点一下
		// 隐掉全部界面」不是阅读交互而是事故（光标落点、工具条全没了）。
		if (next !== "preview") this.setChromeHidden(false);
		else if (!this.normalModeShowToolbar) {
			this.chromeHidden = true;
			this.chromeRevealed = false;
			this.syncChromeHidden();
		}
		this.rebindScrollTarget();
	}

	/** 外部 / 兜底通道（vault.process）改了当前文件，metadataCache.changed 到达：
	 *  重建目录，并在标注页开着时按最新源码重算。 */
	onFileExternallyChanged(): void {
		this.rebuildTocDebounced();
		void this.refreshAnnotationList();
	}

	/** 编辑 / 源码模式下内容变化（workspace 的 `editor-change`）→ 重算几何。
	 *  目录重建另走 400ms 去抖：跟着每一次按键重建目录是实打实的卡顿。 */
	onEditorChanged(): void {
		if (!this.host) return;
		this.requestUpdate();
		this.rebuildTocDebounced();
		// 用户正划新词 / 删除标记时，若标注页开着就按最新源码重算（refresh 内部已校验
		// 「开着且停在标注页」）；预览模式写入 `==` 同样走编辑器通道，会触发这里。
		void this.refreshAnnotationList();
	}

	/** 标注列表刷新：先按**文件**重读一次权威源码，再让面板重算重绘。
	 *  读盘这一步不能省 —— 真机阅读模式下 `view.editor` 是幽灵实例、不跟随写盘
	 *  （见 mdAnnotations.sourceOf 注释），少了它就是「删了 / 划了，列表却原样回来」。
	 *  面板没开或不在标注页时 `refreshAnnotations` 内部自会早退。 */
	private async refreshAnnotationList(): Promise<void> {
		await this.mdAnnotations?.refresh();
		this.sidePanel?.refreshAnnotations();
	}

	/** 滚动目标换人（`.markdown-preview-view` ↔ `.cm-scroller`）：摘旧监听、重探、
	 *  重建 ResizeObserver，并立刻重算一次。 */
	private rebindScrollTarget(): void {
		if (this.scrollEl && this.scrollHandler) {
			this.scrollEl.removeEventListener("scroll", this.scrollHandler);
		}
		this.scrollEl = null;
		this.ro?.disconnect();
		this.ro = null;
		this.lastProgressTop = -1;
		this.rebuildToc();
		window.requestAnimationFrame(() => {
			if (!this.host) return;
			this.resolveScrollEl();
			this.observeSizing();
			if (this.scrollEl) {
				if (!this.scrollHandler) this.scrollHandler = () => this.requestUpdate();
				// 同 handler 同类型重复 addEventListener 由引擎去重，不必先摘。
				this.scrollEl.addEventListener("scroll", this.scrollHandler, { passive: true });
			}
			this.requestUpdate();
		});
	}

	/** 卸载并清场：任何路径（切模式/关 leaf/插件停用）都必须零残留。 */
	unmount(): void {
		this.nativeNavGuard?.stop();
		this.nativeNavGuard = null;
		this.nativeHeaderObserver?.disconnect();
		this.nativeHeaderObserver = null;
		if (this.immersed) this.exitImmersion();
		// 点按显隐的类同样一个都不许残留（leaf 容器类会粘在下一个视图上）
		if (this.chromeHidden) this.setChromeHidden(false);
		this.stopProgressTopFollow();
		NativeChromeGate.release(this);
		this.detachTapToggle();
		try {
			this.leaf.view?.containerEl?.removeClass("unreader-header-hidden");
			this.leaf.view?.containerEl?.querySelector(".view-header")?.removeClass("unreader-header-hidden");
			const doc = this.host?.ownerDocument ?? this.view?.containerEl.ownerDocument ?? document;
			doc.body.removeClass(PLUGIN_NAV_HIDDEN_CLASS); // 兼容旧版本残留
		} catch { /* ignore */ }
		if (this.rebuildTimer != null) {
			window.clearTimeout(this.rebuildTimer);
			this.rebuildTimer = null;
		}
		if (this.immersionSwitchPullTimer != null) {
			window.clearTimeout(this.immersionSwitchPullTimer);
			this.immersionSwitchPullTimer = null;
		}
		this.ro?.disconnect();
		this.ro = null;
		if (this.scrollEl && this.scrollHandler) {
			this.scrollEl.removeEventListener("scroll", this.scrollHandler);
		}
		this.scrollHandler = null;
		this.scrollEl = null;
		try {
			this.sideNav?.closePanel();
			// 摘掉触屏展开态挂在 document 上的 pointerdown 监听（SideNav 自管）。
			this.sideNav?.destroy();
		} catch { /* ignore */ }
		this.sideNav = null;
		this.railTocBtn = null;
		this.railSideBtn = null;
		this.railStarBtn = null;
		this.railAppearanceBtn = null;
		this.railAIBtn = null;
		this.railHighlightsBtn = null;
		this.railImmersionBtn = null;
		this.immersionSwitchEl = null;
		this.mdAnnotations = null;
		// 面板都挂在本视图的叠加根里：卸载必须连 document 级监听一起摘干净。
		this.sidePanel?.containerEl.remove();
		this.sidePanel = null;
		this.appearancePanel?.dispose();
		this.appearancePanel = null;
		this.translationCard?.containerEl.remove();
		this.translationCard = null;
		// AI 结果卡片的「点外面收」监听：与 host 同生命周期，摘在 host 置空之前
		// （host 一空就退回外层 document，popout 窗口里会漏摘）。
		(this.host?.ownerDocument ?? document).removeEventListener("pointerdown", this.onBodyCardPointerDown, true);
		try { this.renderComponent.unload(); } catch { /* ignore */ }
		this.aiPanel?.cancelTask();
		this.aiPanel?.close();
		this.aiPanel = null;
		// 划词工具条：必须在 host 清空**之前** detach —— 它按 host.ownerDocument 摘监听，
		// host 置空后就退回外层 document，会漏摘（popout 窗口里尤其明显）。
		this.selection?.detach();
		this.selection = null;
		this.progressEl = null;
		this.progressFillEl = null;
		// 键盘几何订阅：必须在 host 置空之前退订（回调里要读 host 几何）。
		this.unwatchKb?.();
		this.unwatchKb = null;
		this.host?.remove();
		this.host = null;
		this.entries = [];
		this.headingEls = [];
		this.headingLines = [];
		this.headingLevels = [];
		this.posMode = "dom";
		// 侧边抽屉的会话态与监听全部摘干净（宿主是官方视图，残留就是污染用户编辑器）
		this.setOutsideCloseActive(false);
		this.cancelSideAutoClose();
		this.sideAutoCloseHold = false;
		this.sideKeepAlive?.detach();
		this.sideKeepAlive = null;
		try {
			this.leaf.view?.containerEl?.removeClass("unreader-md-view");
			this.leaf.view?.containerEl?.removeClass("is-full-immersion");
			// 防御性清理：旧版本可能在容器上留过 is-side-pinned（新版本已不再写它）。
			this.leaf.view?.containerEl?.removeClass("is-side-pinned");
		} catch { /* ignore */ }
	}

	/** 布局 / 官方导航形态变化后的轻量重排。
	 *
	 *  `is-floating-nav` 是 body 级类，切设置时不一定伴随滚动，也不保证由页面
	 *  resize 触发；挂载会话必须在这里主动重跑一次 `syncProgressTop`，否则进度条会
	 *  等到用户下一次滚动才从「页首下缘」跳到屏幕最顶。 */
	refreshLayout(): void {
		this.requestUpdate();
	}

	/** 设置变化后的即时生效（设置页 onChange → manager → 全部会话）。 */
	applySettings(): void {
		const s = this.plugin.settings;
		const showToolbar = s.appearance?.normalModeShowToolbar !== false;
		if (this.normalModeShowToolbar !== showToolbar) {
			this.normalModeShowToolbar = showToolbar;
			this.chromeHidden = !showToolbar;
			this.chromeRevealed = false;
			this.syncChromeHidden();
		}
		this.progressEl?.toggleClass("is-off", s.mdOverlayShowProgress === false);
		this.sideNav?.setRailVisible(s.mdOverlayShowTocRail !== false);
		this.host?.style.setProperty("--unreader-rail-scale", String(s.appearance?.railScale ?? 1));
		if (s.mdOverlayImmersive === false && this.immersed) this.exitImmersion();
		else this.syncImmersionSwitch();
		this.syncNativeNavClasses();
		this.syncToolbarButtons();
		// 阅读外观（字体 / 字号 / 行距 / 字距）改了要同步进抽屉：与书 / RSS 抽屉共用
		// 同一枚 syncAppearance，否则 md 侧高亮正文会停在 CSS 默认字号上。
		try { this.sidePanel?.syncAppearance(s.appearance); } catch { /* ignore */ }
		// 星标 / 最近阅读索引可能刚变过：抽屉开着就按当前页重绘（同页重绘保留滚动位置）。
		if (this.sidePanel?.isOpen()) this.sidePanel.setMode(this.sidePanel.getMode());
		// 分段粒度只影响计算不涉 DOM，现读即可；这里只触发一次立即重算
		this.requestUpdate();
	}

	/** **只**重刷阅读外观（字体 / 字号 / 行距 / 字距）进抽屉 —— 与阅读器
	 *  `refreshAppearance()` 同语义，但**不做** `applySettings` 的全量重算（字体晚到 /
	 *  外部资源同步会频繁触发它，把沉浸态等一并重估既无必要、也可能闪一下）。
	 *
	 *  为什么必须单独有一条（用户 2026-10-12 报「md 高亮侧栏的字体应该跟插件设置一致、
	 *  现在却跟笔记字体一致」）：`resolveAppearance` 在该字体 id 尚未进
	 *  `customFontRegistry` 时会**静默回落**到 `--font-text`（= 笔记字体），而注册表的
	 *  填充是异步的（启动预热至少 1.2s）。阅读器由
	 *  `main.doRefreshCustomFonts → getActiveReader()?.refreshAppearance()` 自愈，
	 *  但**只读 markdown 笔记、根本没开阅读器**的用户 `getActiveReader()` 恒为 null
	 *  ⇒ md 抽屉会永远停在回落值上。这条给 md 补上同一针。 */
	refreshAppearance(): void {
		try { this.sidePanel?.syncAppearance(this.plugin.settings.appearance); } catch { /* ignore */ }
	}

	// ---------- 工具栏 + 面板（与阅读器同一套组件、同一套接线） ----------

	/** 工具栏 = 阅读器那一条**适配后**的结果：能用的都留下，用不了的才去掉。
	 *  留下：目录 / 侧边栏 / 星标 / 外观 / AI 助手 / 沉浸。
	 *  去掉：搜索正文（那是书内引擎的搜索，Markdown 用官方 Ctrl+F）、添加书签与阅读进度
	 *  （单篇笔记很短，记位置没有意义 —— 用户 2026-10-09 的原话）、
	 *  保存为笔记 / 阅读原文（Feed 专属）、阅读设备（HTML 专属）。
	 *  ⚠️ 目录条与进度条的**显隐**不在这里：那是「外观」面板里的开关，不是工具栏按钮。 */
	private buildToolbarButtons(): void {
		if (!this.sideNav) return;
		this.railTocBtn = this.sideNav.addIconButton("list", "打开目录", () => this.sideNav?.togglePanel("actions"));
		this.sideNav.setTocTrigger(this.railTocBtn);
		this.railSideBtn = this.sideNav.addIconButton("panel-left", "打开侧边栏", () => this.toggleSidePanel());
		// 直达「本页高亮」：一键打开抽屉并落在标注页（再点且正停在标注页则收起）。
		this.railHighlightsBtn = this.sideNav.addIconButton("highlighter", "打开本页高亮列表", () => this.toggleAnnotationsPanel());
		this.sideNav.addSeparator();
		this.railStarBtn = this.sideNav.addIconButton("star", "星标当前笔记", () => {
			const path = this.currentPath();
			if (path) this.plugin.toggleMarkdownNoteStar(path);
		});
		this.railAppearanceBtn = this.sideNav.addIconButton("sliders-horizontal", "打开阅读外观", () => {
			this.appearancePanel?.toggle();
		});
		this.railAIBtn = this.sideNav.addIconButton("sparkles", "打开 AI 助手", () => {
			this.aiPanel?.toggle();
			this.syncToolbarButtons();
		});
		this.railImmersionBtn = this.sideNav.addIconButton("maximize-2", "进入沉浸阅读", () => {
			if (this.plugin.settings.mdOverlayImmersive === false) return;
			this.toggleImmersion();
		});
		this.syncToolbarButtons();
	}

	/** 自定义命令按钮同步到侧栏槽与划词条槽（空配置时两槽不进 DOM）。 */
	syncCustomButtons(): void {
		const buttons = this.plugin.settings.customButtons ?? [];
		const onRun = (commandId: string): void => this.plugin.runCustomButtonCommand(commandId);
		const exists = (commandId: string): boolean => this.plugin.commandExists(commandId);
		this.sideNav?.setCustomButtons(
			buttons.filter(b => b.showInRail !== false).map(b => ({ id: b.id, commandId: b.commandId, label: b.label, icon: b.icon })),
			onRun,
		);
		this.selection?.setCustomButtons(
			buttons.filter(b => b.showInSelbar !== false).map(b => ({ id: b.id, commandId: b.commandId, label: b.label, icon: b.icon })),
			onRun,
			exists,
		);
	}

	/** 「高亮选中文本」命令入口（md 阅读模式），返回是否成功执行。 */
	highlightCurrentSelection(colorName: string): boolean {
		return this.selection?.highlightCurrent(colorName) ?? false;
	}

	/** 面板都挂在本视图的叠加根里（不是 body）—— 会话卸载时随 host 一起清掉。 */
	private mountPanels(): void {
		if (!this.host) return;

		// 当前笔记的官方 `==` 高亮 → 标注页适配器（data 每次从源码现算，见 mdAnnotations）。
		this.mdAnnotations = new MdAnnotationAdapter({
			app: this.app,
			view: () => this.view,
			jumpTo: (offset, hint) => this.jumpToHighlight(offset, hint),
			// 删除成功：面板若正开在标注页就按最新源码重算重绘（刷新内部已做开合/页签校验）。
			onChanged: () => { this.sidePanel?.refreshAnnotations(); },
		});

		// 侧边抽屉：与阅读器**同一个组件、同一套接线**。标注页接当前笔记的官方 `==` 高亮
		// （annotations 放第一页：高亮是这份笔记最直接的标注语义），其余三页全部接满，
		// 不留「按钮在、点了没反应」。RSS 停用（设置 → 阅读格式）时摘掉「订阅」页签
		// —— 与阅读器装配路径同一个 filterSidePanelModes 判据。
		this.sidePanel = createSidePanel({
			app: this.app,
			plugin: this.plugin,
			annotation: this.mdAnnotations,
			modes: filterSidePanelModes(["annotations", "bookshelf", "feeds", "notes"], this.plugin.settings.disabledFormats),
			state: this.sideState,
			getCurrentDocumentName: () => (this.currentPath() ? (this.view?.file?.basename ?? null) : null),
			onOpenChange: open => {
				if (!open) {
					// 关闭路径统一收口：任何一条（点外面 / 按钮 / 切页）都要把待关闭的
					// 悬浮定时器摘掉，否则下一次打开会被上一轮的残留定时器立刻关掉。
					this.cancelSideAutoClose();
					// 只记住**选内容页**：高亮页的出口是「高亮」按钮，不该成为侧边栏
					// 按钮的下次落点（见 lastSideMode 注释）。
					const mode = this.sidePanel?.getMode();
					if (mode && mode !== "annotations") this.lastSideMode = mode;
				}
				// 灯绳与左缘功能轨避让抽屉都靠这个 host 类（见 styles.css md 段 is-side-open
				// 规则）。单独成方法：它是一条**可被测试注回**的产品契约（阴性对照把本方法
				// patch 成 noop = 复刻「没有让位规则」的旧形态）。
				this.setSideOpenClass(open);
				this.setOutsideCloseActive(open);
				this.syncToolbarButtons();
			},
			onModeChange: () => this.syncToolbarButtons(),
			// 悬浮自动关闭的临时挂起（抽屉里打开菜单/子面板期间不许被关掉）
			onHoldAutoClose: hold => {
				this.sideAutoCloseHold = hold;
				if (hold) this.cancelSideAutoClose();
			},
			openBook: path => void this.openBookFromPanel(path),
			beforeOpenBook: () => this.sidePanel?.hide(),
			openFeedEntry: (feedId, entryId) => {
				this.sidePanel?.hide();
				void this.plugin.openFeedEntry(feedId, entryId);
			},
			toggleFeedStar: (feedId, entryId, panel) => {
				void toggleFeedStarState(this.plugin, feedId, entryId).then(() => panel.refreshFeeds());
			},
			refreshFeeds: panel => void this.refreshFeeds(panel),
			saveNote: (feedId, entryId, panel) => void this.saveFeedNote(feedId, entryId, panel),
			onHeightChange: px => {
				if (px == null) delete this.plugin.settings.annoPanelHeight;
				else this.plugin.settings.annoPanelHeight = px;
				void this.plugin.persistData();
			},
			onWidthChange: px => {
				if (px == null) delete this.plugin.settings.annoPanelWidth;
				else this.plugin.settings.annoPanelWidth = px;
				void this.plugin.persistData();
			},
		});
		if (typeof this.plugin.settings.annoPanelHeight === "number") this.sidePanel.setHeight(this.plugin.settings.annoPanelHeight);
		if (typeof this.plugin.settings.annoPanelWidth === "number") this.sidePanel.setWidth(this.plugin.settings.annoPanelWidth);
		// 高亮 / 书签正文的字号与字体必须跟书 / RSS 抽屉**逐字一致**（用户 2026-10-12
		// 报「md 侧高亮条目的文字大小和字体跟电子书不一样」）：阅读器在 applySettings
		// 里调同一枚 syncAppearance，md 侧此前漏了它 → 面板的 --anno-font-* 全部回落
		// 到 CSS 默认值（13px / --font-text），看着就是两套排版。
		this.sidePanel.syncAppearance(this.plugin.settings.appearance);
		// md 侧不支持钉住：布局主人是 Obsidian（正文居中枢 / file-line-width / 进度条坐标系
		// 都不归插件管），硬改 .view-content 让位只会四处对不上。常驻需求应走官方右侧栏。
		// 钉子**保留可见但置灰禁用**（而不是藏掉）：与书 / RSS 抽屉头部保持一致的组件位置，
		// 用户一眼能看出「这里本有钉住、只是 md 视图不支持」，不会以为按钮没渲染 / 坏了。
		this.disableSidePin();
		this.host.appendChild(this.sidePanel.containerEl);
		// 移开鼠标自动关闭：md 侧没有 readerView 的 setupAnnoAutoClose，
		// 过去这里整块缺失 —— 表现为「从抽屉挪开鼠标面板赖着不走」（2026-10-10 报障）。
		this.setupSideAutoClose();

		this.appearancePanel = new MdAppearancePanel({
			read: () => this.readMdAppearance(),
			write: patch => this.writeMdAppearance(patch),
			onOpenChange: () => this.syncToolbarButtons(),
		});
		this.host.appendChild(this.appearancePanel.containerEl);

		// AI：结果卡片（贴底）先建，面板的 showResultCard 要用它。
		this.translationCard = new TranslationCard({
			onCopy: text => {
				try { void navigator.clipboard?.writeText(text); } catch { /* 复制失败不阻断 */ }
			},
			// ⚠️ 这里**必须真收卡**（2026-10-11 报障「AI 框弹出来后关不掉」）。
			// 旧实现写的是空 no-op，注释还写着「收起即可」—— 与实现不符：TranslationCard
			// 的叉号只调 `actions.onClose()`，宿主不给动作它就永远留着；而 md 侧当时
			// 又没有「点别处关卡片」的通路，整张卡只剩 unmount 一条出路，用户只能切视图。
			// 口径与阅读器的 `hideTranslation()` 对齐：先收卡，再让面板 abort 那次
			// 「选中文字」任务（卡片没了，结果已无处展示）。
			onClose: () => this.hideAiResultCard(),
		});
		this.translationCard.setBoundsResolver(() => this.hostBounds());
		this.translationCard.setMarkdownRenderer((el, markdown) => {
			el.empty();
			return MarkdownRenderer.render(this.app, markdown, el, this.currentPath() ?? "", this.renderComponent).catch(() => undefined);
		});
		this.host.appendChild(this.translationCard.containerEl);

		this.aiPanel = new AIPanel({
			app: this.app,
			getSettings: () => this.plugin.settings.ai,
			onPatch: patch => {
				this.plugin.settings.ai = { ...this.plugin.settings.ai, ...patch };
				void this.plugin.persistData();
			},
			getFullTextRoot: () => this.getFullTextRoot(),
			getSelectionText: () => this.getSelectionText(),
			showResultCard: opts => this.showToolResultCard(opts),
			onOpenChange: () => this.syncToolbarButtons(),
		});
		this.host.appendChild(this.aiPanel.containerEl);

		// AI 结果卡片的「点外面收」：宿主是官方视图，监听必须挂在**宿主 document** 上
		// （popout 窗口里 md 正文在另一个 document），且与 host 同生命周期 —— 摘在 unmount。
		(this.host?.ownerDocument ?? document).addEventListener("pointerdown", this.onBodyCardPointerDown, true);
	}

	/** AI 的「选中文字」结果落到贴底卡片（与划词翻译同一张，形态随本次调用走）。 */
	private showToolResultCard(opts: { title: string; sourceText: string; modelLabel: string; onRetry: () => void }) {
		const card = this.translationCard;
		if (!card) return null;
		card.show({
			title: opts.title,
			sourceText: opts.sourceText,
			modelLabel: opts.modelLabel,
			copyLabel: "复制结果",
			loadingText: "正在生成…",
			retry: opts.onRetry,
			renderMarkdown: true,
		});
		return {
			chunk: (delta: string) => card.appendChunk(delta),
			finish: (text: string) => card.finish(text),
			fail: (message: string) => card.fail(message),
		};
	}

	/**
	 * 收起 AI 结果卡片 —— 与阅读器 `hideTranslation()` 同口径：先收卡，再 abort 面板里
	 * 那次「选中文字」任务（卡片没了，结果已无处展示，在飞请求留着只是白烧 token）。
	 *
	 * 出口有两个，都必须走这里：① 卡片自己的叉号（`onClose`）；② 点卡片外面
	 * （`onBodyCardPointerDown`）。阅读器两个出口都收（`dismissFloatingOnBlankClick`），
	 * md 侧原先只有 ① 且还是空的 → 用户报障「点别处也不收、叉号也不管用」。
	 */
	private hideAiResultCard(): void {
		if (!this.translationCard?.visible) return;
		this.translationCard.hide();
		this.aiPanel?.abortSelectionTask();
	}

	/**
	 * 「点卡片外面就收」：与阅读器 `dismissFloatingOnBlankClick` 对齐。
	 *
	 * 用捕获阶段 pointerdown（在滚动/拖拽前就收口）。判据只有一条：点在 `.unreader-md-root`
	 * 子树**外**且卡片开着才收 —— 卡片自己的 `pointerdown` 虽有 stopPropagation，但那是
	 * 冒泡阶段、挡不住我们这条捕获监听，所以必须显式放行 md 子树（工具条 / 面板 / 抽屉
	 * 都住在这里，它们不是「卡片外面」）。
	 */
	private onBodyCardPointerDown = (e: PointerEvent): void => {
		if (!this.translationCard?.visible) return;
		const target = e.target;
		if (target instanceof Element && target.closest(".unreader-md-root")) return;
		if (this.sideAutoCloseHold || target instanceof Element && target.closest(".menu")) return;
		this.hideAiResultCard();
	};

	/** 全文类 AI 任务的正文根 = 官方阅读模式的渲染区（`.markdown-preview-sizer`）。 */
	private getFullTextRoot(): { title: string; root: HTMLElement; onApplied: () => void } | null {
		const reading = this.view?.contentEl?.querySelector(".markdown-reading-view");
		if (!(reading instanceof HTMLElement)) return null;
		const root = reading.querySelector(".markdown-preview-sizer");
		if (!(root instanceof HTMLElement)) return null;
		return {
			title: this.view?.file?.basename ?? "笔记",
			root,
			// 官方渲染器自己负责重排；这里没有额外的锚点要迁移。
			onApplied: () => { /* noop */ },
		};
	}

	/** 选区文本。Markdown 阅读视图与宿主同一文档（不像书页在 iframe 里），可直接取。 */
	private getSelectionText(): string | null {
		try {
			const doc = this.view?.containerEl?.ownerDocument ?? document;
			const text = doc.getSelection()?.toString() ?? "";
			return text.trim() ? text : null;
		} catch {
			return null;
		}
	}

	/** 贴底卡片的可用区。卡片 append 在 `.unreader-md-root`（inset:0 的定位祖先）下，
	 *  placeFloating 算出的 left/top 直接写成相对 host 的偏移 —— 所以这里必须给
	 *  **host 本地坐标**（原点 0,0），不能返回 hostRect 的视口坐标（会把宿主原点
	 *  重复计一次，卡片整体右下偏移，有侧栏时横向也偏）。底边同样裁到 usableBottom：
	 *  source 模式开着键盘点选区 AI 工具时，贴底卡片要落在键盘 / 原生栏之上。 */
	private hostBounds(): Bounds {
		const el = this.host ?? this.view?.containerEl ?? null;
		const r = el?.getBoundingClientRect();
		if (!r) return { top: 0, left: 0, width: 0, height: 0 };
		const limit = usableBottom(el);
		return {
			top: 0,
			left: 0,
			width: r.width,
			height: Math.max(120, Math.min(r.height, limit - r.top)),
		};
	}

	/** 划词工具条的可用区：与 `hostBounds` 不同，这里必须给**叠加根本地坐标** ——
	 *  工具条 append 在 `.unreader-md-root` 下（`inset:0` 的定位祖先），`placeFloating`
	 *  算出的 left/top 是相对它的偏移；传视口坐标会重复计入宿主原点（浮层被推下去）。 */
	private selectionBounds(): Bounds {
		const hostRect = this.host?.getBoundingClientRect();
		if (!hostRect) return { left: 0, top: 0, width: 0, height: 0 };
		// 「可视容器」按形态取，且**必须过滤掉零几何的节点**。
		//
		// 为什么不能只看「元素在不在」（2026-10-11 真机报障「实时预览划完词，工具条被顶到
		// 屏幕最上方、点不到」）：官方 MarkdownView 在**构造时就把两个模式的容器都建出来了**
		// —— `previewMode` 的构造函数无条件 `contentEl.createDiv("markdown-reading-view")`，
		// `editMode` 建 `.markdown-source-view`（asar app.js 实测）。切实时预览走
		// `setMode` → `n.hide(); e.show()`，而 `hide()` 只是 `style.display="none"`
		// （**元素仍留在 DOM 里**）。所以 `.markdown-reading-view` 在实时预览下
		// **querySelector 照样命中**，只是 rect 全 0。
		// 旧的 `??` 链就栽在这里：第一档命中隐藏节点 → 可用区 = `{top:0,height:0,width:0}`
		// → placeFloating 走「尺寸异常」兜底分支 `originY + margin` → 工具条被钉在
		// host 左上角（≈ 屏幕最上方、官方页首底下），点不到也测不了。
		//
		// 判据用 rect 而非 `display`：官方 hide/show 只改内联 display，而 `offsetParent`
		// 在 `position:fixed` 祖先下会给出错误答案；rect 全 0（宽或高为 0）就是「不在屏幕上」。
		// 顺序仍按形态排（阅读模式优先），两条都取不到时兜回 host 本身。
		const contentEl = this.view?.contentEl;
		const cands: Array<HTMLElement | null> = [
			contentEl?.querySelector<HTMLElement>(".markdown-reading-view") ?? null,
			contentEl?.querySelector<HTMLElement>(".cm-scroller") ?? null,
			contentEl?.querySelector<HTMLElement>(".cm-content") ?? null,
		];
		const limit = usableBottom(this.host ?? this.view?.containerEl ?? null);
		let r: DOMRect | null = null;
		for (const el of cands) {
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			// 隐藏节点（display:none）rect 全 0；真实在场但被官方排版挤扁的容器高度也趋 0。
			// 两种都当「不在屏幕上」，继续试下一档。
			if (!(rect.width > 0) || !(rect.height > 0)) continue;
			r = rect;
			break;
		}
		// 三档都取不到（极早的渲染帧 / 结构异常）：兜回 host 自身，至少不会退化成零尺寸。
		if (!r) {
			const h = Math.max(120, Math.min(hostRect.height, limit - hostRect.top));
			return { left: 0, top: 0, width: hostRect.width, height: h };
		}
		// 底边必须裁到**可用区**：官方 `.mobile-navbar` / `.mobile-toolbar` 是悬浮在
		// 内容之上的原生浮层，照容器的 rect 贴底 → 工具条最后一条正好落进底栏底下，
		// 移动端表现为「划完词，工具条少半截 / 压根看不见」。
		const height = Math.max(120, Math.min(r.height, limit - r.top));
		return {
			left: r.left - hostRect.left,
			top: r.top - hostRect.top,
			width: r.width,
			height,
		};
	}

	/** 选区所在**渲染分节**对应的源码行范围（0 基闭区间），给划词高亮作消歧窗口：
	 *  同一段文字在文中出现多次时，只要它们分属不同节就能被唯一化。
	 *  取不到（老版本没有 `renderer.sections`）返回 null —— controller 会退回文本搜索
	 *  并在仍有歧义时拒绝写入，所以这里失手只是消歧能力下降，不会写错位置。
	 *
	 *  先试**分节 DOM 命中**（`sections[i].el`，1.13+ 有），不中再退回高度累积。 */
	private windowForSelection(range: Range, rect: DOMRect): [number, number] | null {
		const sections = this.rendererSections();
		if (!sections) return null;
		const node = range.commonAncestorContainer;
		for (const sec of sections) {
			const el = sec.el;
			if (el instanceof HTMLElement && el.contains(node)) {
				const a = sec.start?.line;
				const b = sec.end?.line;
				if (typeof a === "number" && typeof b === "number") return [Math.min(a, b), Math.max(a, b)];
				return null;
			}
		}
		const scroll = this.scrollEl;
		if (!scroll) return null;
		const scrollRect = scroll.getBoundingClientRect();
		// 选区在「内容坐标系」里的纵向位置（与 sections 的高度累积同一套口径）
		const y = rect.top - scrollRect.top + scroll.scrollTop;
		let acc = 0;
		for (const sec of sections) {
			const h = typeof sec.height === "number" ? sec.height : 0;
			if (y >= acc && y < acc + h) {
				const a = sec.start?.line;
				const b = sec.end?.line;
				if (typeof a === "number" && typeof b === "number") {
					return [Math.min(a, b), Math.max(a, b)];
				}
				return null;
			}
			acc += h;
		}
		return null;
	}

	/**
	 * 记住当前滚动位置，返回一个「还回去」的函数。
	 *
	 * 阅读模式没有编辑器通道，高亮只能改文件 → 官方整篇重渲染，滚动常被带走。
	 * 「点完高亮、页面跳到别处」和「高亮写错位置」在用户眼里是同一种故障
	 * （看着就像没划中），所以这里必须兜住。重渲染的时机不由我们掌握，
	 * 所以还位要试两次（下一帧 + 60ms 后），且只在**真的漂了**时才动。
	 */
	private holdScrollPosition(): (() => void) | null {
		const el = this.scrollEl;
		if (!el) return null;
		const top = el.scrollTop;
		const left = el.scrollLeft;
		const back = (): void => {
			try {
				if (Math.abs(el.scrollTop - top) > 2) el.scrollTop = top;
				if (Math.abs(el.scrollLeft - left) > 2) el.scrollLeft = left;
			} catch { /* 元素可能已被官方换掉 */ }
		};
		let tries = 0;
		return () => {
			if (tries >= 2) return;
			tries += 1;
			back();
			if (tries === 1) window.setTimeout(back, 60);
		};
	}

	private async openBookFromPanel(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到书籍：${path}`);
			return;
		}
		this.sidePanel?.hide();
		await this.plugin.openBook(file);
	}

	private async refreshFeeds(panel: AnnotationsPanel): Promise<void> {
		try {
			new Notice("正在刷新订阅…");
			const results = await this.plugin.feedService.refreshAll(true);
			if (!results.length) {
				new Notice("没有可刷新的订阅（订阅源可能都已停用）");
				panel.refreshFeeds();
				return;
			}
			const failed = results.filter(result => result.error).length;
			new Notice(failed ? `刷新完成，${failed} 个订阅失败` : "订阅已刷新");
			panel.refreshFeeds();
		} catch (error) {
			new Notice(`刷新失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 与阅读器**同一份实现**（`core/feedNoteSave`）：先抓再存、抓不到就不存、
	 *  落盘成功才置 `savedAt`。这里只负责刷新抽屉列表。 */
	private async saveFeedNote(feedId: string, entryId: string, panel: AnnotationsPanel): Promise<void> {
		const result = await saveFeedEntryAsMarkdown({
			app: this.app,
			store: this.plugin.feedStore,
			fetchFulltext: (id, entry) => this.plugin.feedService.fetchFulltext(id, entry),
		}, feedId, entryId);
		if (result) panel.refreshFeeds();
	}

	private readMdAppearance(): MdAppearanceState {
		const s = this.plugin.settings;
		return {
			showTocRail: s.mdOverlayShowTocRail !== false,
			showProgress: s.mdOverlayShowProgress !== false,
			progressScope: Math.max(0, Math.min(6, Math.floor(Number(s.mdOverlayProgressScope) || 0))),
			immersive: s.mdOverlayImmersive !== false,
			immersionKeepToc: s.appearance?.fullImmersionShowTocRail === true,
			immersionKeepProgress: s.appearance?.fullImmersionShowChapterProgress === true,
		};
	}

	/** 面板写回：内存 → 去抖落盘 → 全部 md 会话即时同步（含各会话的面板回读）。 */
	private writeMdAppearance(patch: Partial<MdAppearanceState>): void {
		const s = this.plugin.settings;
		if (patch.showTocRail !== undefined) s.mdOverlayShowTocRail = patch.showTocRail;
		if (patch.showProgress !== undefined) s.mdOverlayShowProgress = patch.showProgress;
		if (patch.progressScope !== undefined) s.mdOverlayProgressScope = Math.max(0, Math.min(6, Math.floor(patch.progressScope)));
		if (patch.immersive !== undefined) s.mdOverlayImmersive = patch.immersive;
		if (patch.immersionKeepToc !== undefined) s.appearance.fullImmersionShowTocRail = patch.immersionKeepToc;
		if (patch.immersionKeepProgress !== undefined) s.appearance.fullImmersionShowChapterProgress = patch.immersionKeepProgress;
		this.plugin.scheduleSave();
		this.plugin.mdOverlay?.applySettingsAll();
		this.appearancePanel?.refresh();
	}

	// ---------- 侧边抽屉：悬浮自动关闭（md 侧不做钉住） ----------
	//
	// ⚠️ 阅读器里自动关闭由 `readerView.setupAnnoAutoClose` 实现、钉住走
	// `applyPinnedLayout`；md 侧只保留**自动关闭**：宿主是官方视图，没有
	// `.unreader-body` 那一层，「钉住 = 改 .view-content 让位」会与官方正文排版
	// （居中枢 / file-line-width / 进度条坐标系）四处对不上，2026-10-10 决定砍掉。
	// 常驻需求应走官方右侧栏（workspace right leaf），而不是在 md 里硬造。

	/** 钉住按钮置灰禁用（可见、浅色、点击无效）。单独成方法是为了让探针能 patch
	 *  原型注回旧行为（「钉子仍是可点的普通按钮」）做阴性对照。 */
	private disableSidePin(): void {
		this.sidePanel?.setPinEnabled(false);
	}

	/** 抽屉开合 → host 的 is-side-open 类（左缘功能轨与左上灯绳据此让位到抽屉右缘外，
	 *  CSS 见 styles.css md 段；阅读器那边是同语义的 `~` 兄弟选择器，md 因 DOM 顺序
	 *  用不上兄弟选择器，因此改由这一类承载）。单独成方法便于测试注回旧形态。 */
	private setSideOpenClass(open: boolean): void {
		this.host?.toggleClass("is-side-open", open);
	}

	/** 「点抽屉外面就关」的总开关：随抽屉开合订阅 / 摘除 document 监听。
	 *  触屏（iPad）没有 hover，鼠标移出关闭那条路在非 hover 设备根本不绑 —— 只能靠它。 */
	private setOutsideCloseActive(active: boolean): void {
		const doc = this.host?.ownerDocument ?? document;
		if (active) {
			if (this.outsidePointerHandler) return;
			this.outsidePointerHandler = (e: PointerEvent): void => {
				if (!this.sidePanel?.isOpen()) return;
				const target = e.target;
				if (!(target instanceof Element)) return;
				// 点在叠加层自己的任何浮层内（抽屉 / 右缘工具栏 / 外观·AI 面板 / 贴底卡片，
				// 它们都在 .unreader-md-root 子树）一律放行；正文不在该子树 → 判为「外面」。
				if (target.closest(".unreader-md-root")) return;
				// Obsidian 菜单挂在 body 上（.menu），抽屉自动关闭挂起期间也不许误关。
				if (this.sideAutoCloseHold || target.closest(".menu")) return;
				this.sidePanel.hide();
				this.syncToolbarButtons();
			};
			// pointerdown 而非 click：在滚动 / 拖拽前就收口，且与抽屉内 resize 手柄同事件类型。
			doc.addEventListener("pointerdown", this.outsidePointerHandler, true);
		} else {
			if (this.outsidePointerHandler) {
				doc.removeEventListener("pointerdown", this.outsidePointerHandler, true);
				this.outsidePointerHandler = null;
			}
		}
	}

	/** 移开鼠标自动关闭。仅 hover 能力设备绑定 —— 触屏靠「点外面关」，
	 *  合成 mouseleave 会在打开后立刻把面板关掉（阅读器同款判据）。
	 *
	 *  ⚠️ 「指针还在不在抽屉上」的判定**不只看抽屉盒子**：抽屉与左缘功能轨是兄弟节点、
	 *  中间只隔 1px，用户横穿过去点轨上按钮时指针一离开抽屉右缘就不再属于任何抽屉元素。
	 *  判定收口在 `SideHoverKeepAlive`（抽屉 ∪ 功能轨 ∪ 容错边距），见其文件头。 */
	private setupSideAutoClose(): void {
		const panel = this.sidePanel?.containerEl;
		if (!panel) return;
		let hoverable = false;
		try { hoverable = window.matchMedia?.("(hover: hover)")?.matches ?? false; } catch { hoverable = false; }
		if (!hoverable) return;
		panel.addEventListener("mouseenter", () => this.cancelSideAutoClose());
		panel.addEventListener("mouseleave", () => this.scheduleSideAutoClose());
		this.sideKeepAlive = new SideHoverKeepAlive({
			panel: () => this.sidePanel?.containerEl ?? null,
			rail: () => this.sideNav?.actionsEl ?? null,
			isActive: () => !!this.sidePanel?.isOpen(),
			onChange: tier => {
				if (tier === "away") this.scheduleSideAutoClose();
				// 还在带子里：**不取消**定时器，而是保证「有一发在飞」——
				// 指针若接着滑进正文（宿主再也收不到 pointermove），只有轮询能收敛到关。
				else if (this.sideAutoCloseTimer == null) this.scheduleSideAutoClose();
			},
		});
		this.sideKeepAlive.attach(this.host?.ownerDocument ?? document);
	}

	private scheduleSideAutoClose(): void {
		if (this.sideAutoCloseHold) return;
		if (!this.sidePanel?.isOpen()) return;
		this.cancelSideAutoClose();
		this.sideAutoCloseTimer = window.setTimeout(() => {
			this.sideAutoCloseTimer = null;
			if (this.sideAutoCloseHold) return;
			if (!this.sidePanel?.isOpen()) return;
			// 面板自己弹出的菜单盖在上面时不许关。
			if (this.sidePanel.containerEl.querySelector(".menu:not(.is-hidden)")) return;
			// 指针仍在抽屉 / 左缘功能轨那条带子里（或坐标还新鲜但测不准，比如刚滑进正文 iframe）
			// → **续一次轮询**而不是就此收手：轮询才是「指针其实已经走了」的收敛出口。
			if (this.sideKeepAlive?.tier() !== "away") {
				this.scheduleSideAutoClose();
				return;
			}
			this.sidePanel.hide();
			this.syncToolbarButtons();
		}, 220);
	}

	private cancelSideAutoClose(): void {
		if (this.sideAutoCloseTimer != null) {
			window.clearTimeout(this.sideAutoCloseTimer);
			this.sideAutoCloseTimer = null;
		}
	}

	/** 侧边栏开关：只导航**选内容页**（书架/订阅/笔记）——
	 *  · 关着 → 开（落回上次停留的选内容页）；
	 *  · 开着且停在**高亮页** → 切到选内容页（保留当前笔记，不整条关）；
	 *  · 开着且停在选内容页 → 整条关。
	 *  与阅读器 `toggleSidePanelOpen` 同语义（用户 2026-10-11 定稿）。 */
	private toggleSidePanel(): void {
		const panel = this.sidePanel;
		if (!panel) return;
		const switchToPicker = !panel.isOpen() || panel.getMode() === "annotations";
		if (switchToPicker) {
			// 打开前先实测一遍两条让位量，别依赖「此前滚动过 update 已写过」——
			// 挂载后没滚动就开抽屉，旧 inset 可能缺失或过期，头部/尾部又会被压。
			this.syncProgressTop();
			panel.setMode(this.defaultPickerMode());
			panel.show();
		} else {
			panel.hide();
		}
		this.syncToolbarButtons();
	}

	/** 展开侧边栏时该落的**选内容页**：当前读的是 markdown 笔记 → 「笔记」页
	 *  （与阅读器同语义：书 → 书架、RSS → 订阅）。修复前 md 侧恒落书架，用户
	 *  2026-10-12 报「展开的不是当前内容的选择界面」。单独成方法便于测试注回旧值。
	 *
	 *  2026-10-13 补：先落**上次退出时停留的那一页**（`lastSideMode`，只在关闭选内容页
	 *  时更新，高亮页的出口是高亮按钮、不参与记账）—— 用户在「订阅」里翻到一半关掉抽屉，
	 *  再用侧边栏按钮打开应当回到订阅（用户原话「然后是上次退出的位置」），恒落笔记页会把
	 *  这一页踢走。没有任何记账（首次打开）时才落「当前内容的选择界面」= 笔记页。 */
	private defaultPickerMode(): "bookshelf" | "feeds" | "notes" {
		return this.lastSideMode;
	}

	/** 直达当前笔记的「高亮」页：开着且正停在标注页 → 收起；否则打开并切到标注页。
	 *  数据由 provideAnnotationData 在 setMode/show 时现算，这里不必先喂。 */
	private async toggleAnnotationsPanel(): Promise<void> {
		const panel = this.sidePanel;
		if (!panel) return;
		if (panel.isOpen() && panel.getMode() === "annotations") {
			panel.hide();
		} else {
			this.syncProgressTop();
			// 打开前先按文件重读一次权威源码：真机阅读模式下幽灵 editor 不跟随写盘，
			// 少了这一步，阅读模式里刚划的新高亮进不了列表（见 mdAnnotations.sourceOf）。
			await this.mdAnnotations?.refresh();
			panel.setMode("annotations");
			panel.show();
		}
		this.syncToolbarButtons();
	}

	/** 图标与无障碍名跟随当前状态；不改变正文/主题样式。 */
	private syncToolbarButtons(): void {
		const s = this.plugin.settings;

		const tocOpen = !!this.sideNav?.isPanelOpen();
		this.railTocBtn?.toggleClass("is-active", tocOpen);
		const tocLabel = tocOpen ? "关闭目录" : "打开目录";
		this.railTocBtn?.setAttribute("aria-label", tocLabel);
		this.railTocBtn?.setAttribute("title", tocLabel);

		const sideOpen = !!this.sidePanel?.isOpen();
		const sideOnAnnotations = sideOpen && this.sidePanel?.getMode() === "annotations";
		// 无障碍名读「点下去会发生什么」：高亮页上点它 = 切到内容列表（保留当前笔记）。
		const sideLabel = !sideOpen ? "打开侧边栏" : (sideOnAnnotations ? "切换到内容列表" : "关闭侧边栏");
		this.paintToolbarIcon(this.railSideBtn, "panel-left", "侧栏");
		this.railSideBtn?.toggleClass("is-active", sideOpen);
		this.railSideBtn?.setAttribute("aria-label", sideLabel);
		this.railSideBtn?.setAttribute("title", sideLabel);

		const annoActive = sideOnAnnotations;
		this.paintToolbarIcon(this.railHighlightsBtn, "highlighter", "高亮");
		this.railHighlightsBtn?.toggleClass("is-active", annoActive);
		const highlightsLabel = annoActive ? "关闭本页高亮列表" : "打开当前笔记的高亮列表";
		this.railHighlightsBtn?.setAttribute("aria-label", highlightsLabel);
		this.railHighlightsBtn?.setAttribute("title", highlightsLabel);

		const path = this.currentPath();
		const starred = !!path && this.plugin.isMarkdownNoteStarred(path);
		this.paintToolbarIcon(this.railStarBtn, "star", "星");
		this.railStarBtn?.toggleClass("is-active", starred);
		this.railStarBtn?.toggleClass("is-starred", starred);
		this.railStarBtn?.setAttribute("aria-label", starred ? "取消星标当前笔记" : "星标当前笔记");
		this.railStarBtn?.setAttribute("title", starred ? "取消星标当前笔记" : "星标当前笔记");

		const appearanceOpen = !!this.appearancePanel?.isOpen();
		this.paintToolbarIcon(this.railAppearanceBtn, "sliders-horizontal", "外观");
		this.railAppearanceBtn?.toggleClass("is-active", appearanceOpen);
		const appearanceLabel = appearanceOpen ? "关闭阅读外观" : "打开阅读外观";
		this.railAppearanceBtn?.setAttribute("aria-label", appearanceLabel);
		this.railAppearanceBtn?.setAttribute("title", appearanceLabel);

		const aiOpen = !!this.aiPanel?.isOpen();
		this.paintToolbarIcon(this.railAIBtn, "sparkles", "AI");
		this.railAIBtn?.toggleClass("is-active", aiOpen);
		this.railAIBtn?.setAttribute("aria-label", aiOpen ? "关闭 AI 助手" : "打开 AI 助手");
		this.railAIBtn?.setAttribute("title", aiOpen ? "关闭 AI 助手" : "打开 AI 助手");

		const immersionOn = this.immersed && s.mdOverlayImmersive !== false;
		this.paintToolbarIcon(this.railImmersionBtn, "maximize-2", "沉浸");
		this.railImmersionBtn?.toggleClass("is-active", immersionOn);
		this.railImmersionBtn?.setAttribute("aria-label", immersionOn ? "退出沉浸阅读" : "进入沉浸阅读");
		this.railImmersionBtn?.setAttribute("title", immersionOn ? "退出沉浸阅读" : "进入沉浸阅读");

		// 工具栏/设置页改了设置后，打开着的过滤面板要跟上（值可能已变）。
		this.appearancePanel?.refresh();
	}

	private paintToolbarIcon(btn: HTMLElement | null, icon: string, fallback: string): void {
		if (!btn) return;
		try {
			btn.empty();
			setIcon(btn, icon);
			if (!btn.querySelector("svg")) btn.setText(fallback);
		} catch {
			btn.setText(fallback);
		}
	}

	private currentPath(): string | null {
		return this.view?.file?.path ?? null;
	}

	// ---------- 目录条 ----------

	/** 重建目录：优先 sections 模式（metadataCache 标题行号 + 渲染器分节高度），
	 *  渲染器不可用（老版本 / 探针）降级 DOM 直读。两种模式各自保证
	 *  目录 = 跳转 = 当前章判定 同源。 */
	rebuildToc(): void {
		if (!this.host || !this.sideNav) return;
		const preview = this.isPreviewMode();
		const secs = preview ? this.rendererSections() : null;
		const cacheHeads = this.cacheHeadings();
		// 阅读模式（有 renderer.sections）或编辑 / 源码模式（没有 sections、走 lines）
		// 都用 metadataCache 的标题行号建条目 —— 它与渲染进度无关，虚拟渲染下依然完整。
		if (cacheHeads.length && (!!secs || !preview)) {
			// sections 模式：条目来自 metadataCache（与渲染进度无关，虚拟渲染下完整）
			const levelOf = (h: { level: number }): number => h.level || 6;
			const { picks, base } = pickTocHeadings(cacheHeads, levelOf);
			// 阅读模式 → sections（分节高度累积）；编辑 / 源码 → lines（CM6 行块）
			this.posMode = secs ? "sections" : "lines";
			this.headingLines = picks.map(h => h.position.start.line);
			this.headingLevels = picks.map(h => levelOf(h));
			this.headingEls = [];
			this.entries = picks.map((h, i) => ({
				label: h.heading || "（无标题）",
				href: "",
				id: null,
				navKey: i,
				depth: tocDepth(levelOf(h), base),
				sectionIndex: null,
			}));
		} else {
			const els = this.collectHeadingEls();
			const levelOf = (el: HTMLElement): number => Number(el.tagName.slice(1)) || 6;
			const { picks, base } = pickTocHeadings(els, levelOf);
			this.posMode = "dom";
			this.headingLines = [];
			this.headingEls = picks;
			this.headingLevels = picks.map(levelOf);
			this.entries = picks.map((el, i) => ({
				label: (el.getText() || "").trim() || "（无标题）",
				href: "",
				id: null,
				navKey: i,
				depth: tocDepth(levelOf(el), base),
				sectionIndex: null,
			}));
		}
		this.sideNav.renderEntries(this.entries, entry => this.jumpToEntry(entry));
		// Markdown 文档可能没有标题，但工具栏仍要能开关进度/目录/沉浸；覆盖 SideNav
		// 按目录条目数自动显隐的通用行为。
		this.sideNav.setActionsVisible(true);
		this.requestUpdate();
	}

	/** 文件被编辑（另一 pane / 换内容）后防抖重建。 */
	rebuildTocDebounced(): void {
		if (!this.host) return;
		if (this.rebuildTimer != null) window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			this.rebuildToc();
		}, 400);
	}

	/** 阅读视图的**正文内容底**（滚动内容坐标系；不含反向链接区域）。
	 *  反链区存在时返回它的顶边，否则返回 null（调用点退回 scrollHeight）。 */
	private contentBottom(): number | null {
		if (this.contentBottomCached) return this.contentBottomCache;
		const el = this.scrollEl;
		const backlinks = this.view?.contentEl?.querySelector(BACKLINKS_SEL);
		let value: number | null = null;
		if (backlinks instanceof HTMLElement && el) {
			// 两个 rect 随滚动同向平移 ⇒ 差值恒定，所以这个值**只随布局变化**，
			// 可以跨帧缓存（每帧重算 = 每帧多两次强制同步布局，滚动掉帧的元凶之一）。
			const top = backlinks.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
			value = top > 0 ? top : null;
		}
		this.contentBottomCache = value;
		this.contentBottomCached = true;
		return value;
	}

	/** DOM 定位模式的标题元素：`.markdown-embed` 内部的（`![[…]]` 嵌入）与反向链接
	 *  区域内部的都不算 —— 后者的「链接标题」不是本文档的章节。
	 *  ⚠️ 1.13+ 阅读视图是滚动窗口虚拟渲染，这里拿到的只是当前窗口附近的内容 ——
	 *  所以它只服务老版本 / 探针夹具（posMode === "dom"），真机 1.13+ 走 sections。 */
	private collectHeadingEls(): HTMLElement[] {
		const reading = this.view?.contentEl?.querySelector(".markdown-reading-view");
		if (!reading) return [];
		const all = Array.from(reading.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
		return all.filter(el =>
			el.closest(".markdown-embed") === null
			&& el.closest(BACKLINKS_SEL) === null);
	}

	/** metadataCache 里的标题树（文件级完整、与渲染进度无关）。空文本的条目剔除
	 *  （frontmatter 附近会产生 heading 文本为空的假条目，目录里显示成「（无标题）」）。 */
	private cacheHeadings(): HeadingCache[] {
		const file = this.view?.file;
		if (!file) return [];
		try {
			return (this.app.metadataCache.getFileCache(file)?.headings ?? [])
				.filter(h => typeof h.heading === "string" && h.heading.trim().length > 0);
		} catch {
			return [];
		}
	}

	/** 官方渲染器的全文档分节数据（1.13+；节高累积 ≈ 文档布局，见 posMode 注释）。 */
	private rendererSections(): RendererSection[] | null {
		try {
			const secs = (this.view as unknown as { previewMode?: { renderer?: { sections?: unknown } } })
				?.previewMode?.renderer?.sections;
			if (Array.isArray(secs) && secs.length > 0) return secs as RendererSection[];
		} catch { /* ignore */ }
		return null;
	}

	/** 当前是不是阅读模式。取不到模式时算 true（保守：走渲染器那条既有路径）。 */
	private isPreviewMode(): boolean {
		return modeOf(this.view) === "preview";
	}

	/** CM6 的 EditorView（编辑 / 源码模式的真实排版与滚动引擎）。取不到返回 null。 */
	private editorView(): EditorViewLike | null {
		try {
			const cm = (this.view as unknown as { editor?: { cm?: EditorViewLike } })?.editor?.cm;
			if (cm && typeof cm.lineBlockAt === "function" && cm.state?.doc) return cm;
		} catch { /* ignore */ }
		return null;
	}

	/** lines 模式的标题像素坐标：行号 → CM6 行块顶边。
	 *
	 *  `lineBlockAt().top` 用的是**文档内容坐标系**（与 `scroller.scrollTop` 同一套），
	 *  所以可以直接与 scrollTop 比较，不需要再减 rect。拿不到 CM6 时返回 null ——
	 *  调用点退回「只有全文进度、不显示章节进度」，宁可少显示也不给错位置。 */
	private topsViaLines(): number[] | null {
		if (this.posMode !== "lines" || !this.headingLines.length) return null;
		const cm = this.editorView();
		const doc = cm?.state?.doc;
		if (!cm || !doc) return null;
		try {
			const total = doc.lines;
			return this.headingLines.map(line => {
				// metadataCache 的行号是 0 基；CM6 的 doc.line() 是 1 基。
				const lineNo = Math.min(Math.max(1, line + 1), total);
				return cm.lineBlockAt(doc.line(lineNo).from).top;
			});
		} catch {
			return null;
		}
	}

	/** DOM 直读模式的标题内容坐标（服务老版本 Obsidian / 探针夹具）。
	 *
	 *  返回 **null = 「这套几何不可用」** —— 调用点退回「只有全文进度、不显示章节进度」，
	 *  与 {@link topsViaLines} 同一契约：宁可少显示，不给错位置。
	 *
	 *  判据是「标题元素真的渲染过」。编辑 / 源码模式下官方把 `.markdown-reading-view`
	 *  整个 `display:none`（元素仍留在 DOM 里），此时每个 `getBoundingClientRect()`
	 *  恒为 0，而 `el.getBoundingClientRect().top` 是滚动容器自己的**视口**位置 ⇒
	 *  `r.top - elRect.top + scrollTop` 退化成「scrollTop − 常量」，每个「章顶」都跟着
	 *  滚动一起跑。后果不是显示不准，而是**分段进度彻底失真**：所有 H1 边界塌成同一个
	 *  随滚动移动的假值，段内进度变成 `48 / (文档高 + 48)` 这种垃圾值
	 *  （2026-10-11 实测 0.0098 → 0.0194，且短横的「当前章」恒判成最后一章）。
	 *
	 *  目录**条目**不受影响：那些元素本身是真实的文档标题，列表照常列出，只是不再拿
	 *  它们的（无效）几何当内容坐标。 */
	private domHeadingTops(el: HTMLElement, scrollTop: number): number[] | null {
		if (!this.headingEls.length) return null;
		const rects = this.headingEls.map(h => h.getBoundingClientRect());
		if (!rects.some(r => r.width > 0 || r.height > 0)) return null;
		const scrollRect = el.getBoundingClientRect();
		return rects.map(r => r.top - scrollRect.top + scrollTop);
	}

	/** sections 模式的标题像素坐标：行号 → 所在分节 → 节前高度累积。
	 *  每帧现算（431 节只是几百次加法），不缓存 —— 渲染器重解析会换数组内容，
	 *  缓存签名比现算更贵。heading 落在节中部时节首近似（Obsidian 的分节以
	 *  heading 开头，绝大多数精确；系统误差 = 节间距 24px，远小于 ACTIVE_EPS）。 */
	private topsViaSections(): number[] | null {
		const secs = this.rendererSections();
		if (!secs || this.posMode !== "sections" || !this.headingLines.length) return null;
		const tops: number[] = [];
		let acc = 0;
		let si = 0;
		for (const line of this.headingLines) {
			while (si < secs.length) {
				const s = secs[si];
				if (!s) break;
				const sStart = s.start?.line ?? Number.MAX_SAFE_INTEGER;
				if (sStart > line) break;
				if (line <= (s.end?.line ?? sStart)) break;
				acc += s.height ?? 0;
				si++;
			}
			tops.push(acc);
		}
		return tops;
	}

	private jumpToEntry(entry: NavEntryModel): void {
		const idx = entry.navKey != null ? entry.navKey : -1;
		if (!this.scrollEl || idx < 0) return;
		let target: number | null = null;
		// sections（阅读模式）与 lines（编辑 / 源码模式）都直接给出文档坐标；
		// dom 模式没有这种坐标，落到下面的标题元素 rect 路径。
		const tops = this.topsViaSections() ?? this.topsViaLines();
		if (tops) target = tops[idx] ?? null;
		if (target == null) {
			const el = this.headingEls[idx] ?? null;
			if (!el) return;
			const scrollRect = this.scrollEl.getBoundingClientRect();
			target = el.getBoundingClientRect().top - scrollRect.top + this.scrollEl.scrollTop - this.headerPad();
		}
		this.scrollEl.scrollTo({ top: Math.max(0, target), behavior: "auto" });
		this.requestUpdate();
	}

	/** 标注页「跳转到高亮」：sourceOffset 是**源码偏移**（collectHighlights 直接扫源文件，
	 *  与 editor.getValue() 同源），不是渲染投影偏移。三条定位通道，与目录跳转同一套几何，
	 *  只滚 scrollEl、不用 scrollIntoView（后者会连动 overflow:hidden 祖先，见面板注释）。 */
	private jumpToHighlight(sourceOffset: number, textHint: string): void {
		if (!this.scrollEl || sourceOffset < 0) {
			// 挂载早期 scrollEl 还没探到：下一拍再试一次，别把跳转吞掉。
			window.requestAnimationFrame(() => this.jumpToHighlight(sourceOffset, textHint));
			return;
		}
		// ① 编辑 / 源码（CM6）：偏移就是 CM6 doc 位置，lineBlockAt 直接给内容坐标。
		const cm = this.editorView();
		if (cm && this.posMode === "lines") {
			try {
				const pos = Math.min(Math.max(0, sourceOffset), cm.state.doc.length);
				const block = cm.lineBlockAt(pos);
				this.scrollEl.scrollTo({ top: Math.max(0, block.top - this.headerPad()), behavior: "auto" });
				this.requestUpdate();
				return;
			} catch { /* 落到 sections / DOM 兜底 */ }
		}

		// ② 阅读模式：偏移 → 0 基行号 → renderer.sections 累积高度（同 topsViaSections 口径）。
		const src = this.readSourceSync();
		const line = src == null ? null : countLineBefore(src, sourceOffset);
		const secs = this.rendererSections();
		let target: number | null = null;
		let hitSec: RendererSection | null = null;
		if (line != null && secs) {
			let acc = 0;
			for (const s of secs) {
				const sStart = s.start?.line ?? Number.MAX_SAFE_INTEGER;
				const sEnd = s.end?.line ?? sStart;
				if (line >= sStart && line <= sEnd) { hitSec = s; break; }
				if (line < sStart) break;
				acc += s.height ?? 0;
			}
			if (hitSec) target = acc;
		}

		// 节内精修：该节 DOM 已挂载（虚拟渲染只挂窗口附近几节）时，用高亮正文在节内的
		// 实际位置修正节首的粗定位 —— 长节里节首与目标行可能差几百 px。
		if (hitSec && hitSec.el instanceof HTMLElement && hitSec.el.isConnected) {
			const inner = this.locateTextInSection(hitSec.el, textHint);
			if (inner != null) {
				const scrollRect = this.scrollEl.getBoundingClientRect();
				target = inner - scrollRect.top + this.scrollEl.scrollTop - this.headerPad();
			}
		}

		// ③ 兜底：阅读模式但 sections 不可用（老版本 / 探针）→ 直接在渲染 DOM 里按文本找。
		if (target == null) {
			const el = this.locateHighlightInDom(textHint);
			if (el) {
				const scrollRect = this.scrollEl.getBoundingClientRect();
				target = el.getBoundingClientRect().top - scrollRect.top + this.scrollEl.scrollTop - this.headerPad();
			}
		}
		if (target == null) return;
		this.scrollEl.scrollTo({ top: Math.max(0, target), behavior: "auto" });
		this.requestUpdate();
	}

	/** 同步读当前源码（偏移定位用）。**按模式分流真源**：
	 *  · 预览模式 → mdAnnotations 的文件缓存（sourceSnapshot）：真机阅读模式下
	 *    `view.editor` 是幽灵实例、不跟随写盘（见 mdAnnotations.sourceOf 注释），
	 *    旧实现直接读它 ⇒ 行号按陈旧内容换算，标注列表「跳转到高亮」会偏；
	 *    缓存没建立就给 null，jumpToHighlight 自行走 DOM 文本兜底。
	 *  · 编辑 / 源码模式 → 编辑器同步值就是权威（sourceOf 同口径）。 */
	private readSourceSync(): string | null {
		if (this.mode === "preview") {
			return this.mdAnnotations?.sourceSnapshot() ?? null;
		}
		const ed = (this.view as unknown as { editor?: { getValue?: () => string } } | null)?.editor;
		if (ed && typeof ed.getValue === "function") {
			try { return ed.getValue(); } catch { /* ignore */ }
		}
		return null;
	}

	/** 在一个渲染节内按正文找目标相对 scrollEl 内容顶的 Y；找不到返回 null。 */
	private locateTextInSection(sectionEl: HTMLElement, hint: string): number | null {
		const el = this.findDeepestElementWithText(sectionEl, hint);
		return el ? el.getBoundingClientRect().top : null;
	}

	/** 老版本 / 探针（无 sections）：在整个渲染区按高亮正文找元素。 */
	private locateHighlightInDom(hint: string): HTMLElement | null {
		const reading = this.view?.contentEl?.querySelector(".markdown-reading-view");
		if (!(reading instanceof HTMLElement)) return null;
		return this.findDeepestElementWithText(reading, hint);
	}

	/** 在 root 内找 textContent 命中 hint、且自身最深（DOM 层级最大）的块 —— 命中的外层
	 *  容器（节、段落）与内层 <mark> 都会包含该文本，取最深者定位最准。
	 *  hint 取前 12 个非空白字符做键，容忍空白 / 跨行差异。 */
	private findDeepestElementWithText(root: HTMLElement, hint: string): HTMLElement | null {
		const key = normalizeText(hint).slice(0, 12);
		if (!key) return null;
		const all = Array.from(root.querySelectorAll<HTMLElement>("mark, [class*=highlight], p, li, h1,h2,h3,h4,h5,h6, blockquote, td"));
		let best: HTMLElement | null = null;
		let bestDepth = -1;
		for (const el of all) {
			// 排除反向链接区与嵌入块（不是本文内容）。
			if (el.closest(BACKLINKS_SEL) || el.closest(".markdown-embed")) continue;
			if (!normalizeText(el.textContent ?? "").includes(key)) continue;
			let d = 0;
			for (let n: Node | null = el; n && n !== root; n = n.parentNode) d++;
			if (d > bestDepth) { bestDepth = d; best = el; }
		}
		return best;
	}

	/** 目标标题被浮层页首（手机端）盖住时预留的空档；文档流页首（桌面）不占内容区，给 0。 */
	private headerPad(): number {
		const header = this.view?.containerEl?.querySelector(".view-header");
		if (!(header instanceof HTMLElement) || header.offsetHeight <= 0) return 0;
		try {
			if (getComputedStyle(header).position === "absolute") return header.offsetHeight + 8;
		} catch { /* ignore */ }
		return 0;
	}

	// ---------- 进度与滚动 ----------

	/** 滚动容器探测：优先「真的在滚」的元素（scrollHeight 明显大于 clientHeight），
	 *  探不到可滚的再退回第一个存在的候选。缓存复用；⚠️ 缓存条件必须是
	 *  「还连着**且仍可滚**」——真机 1.13.7 实测滚动容器是 `.markdown-preview-view`
	 *  自身（overflow-y:auto），`.markdown-reading-view` 只是 overflow:visible 的壳；
	 *  而挂载那一拍 preview 往往还没渲染（两层都不可滚），若只查 isConnected 会把
	 *  壳永久缓存住，渲染完成后进度永远停在 0。重探时把 scroll 监听一并迁到新层。
	 *
	 *  `force` = 连「仍可滚」一起重判。**滚动主循环不要传 true**：
	 *  `scrollHeight - clientHeight` 是强制同步布局读，每帧一次就是实打实的掉帧源。
	 *  换人场景（挂载那拍不可滚 → 渲染完成后才可滚）由 {@link observeSizing} 的
	 *  ResizeObserver 覆盖 —— 内容撑高那一刻 RO 必然触发，那里用 force=true 重探。 */
	private resolveScrollEl(force = false): void {
		if (this.scrollEl?.isConnected) {
			if (!force) return;
			if (this.scrollEl.scrollHeight - this.scrollEl.clientHeight > 4) return;
		}
		const prev = this.scrollEl;
		this.scrollEl = null;
		const contentEl = this.view?.contentEl;
		const reading = contentEl?.querySelector(".markdown-reading-view");
		// 编辑 / 源码模式（Live Preview / source）：滚动层是 CM6 自己的 `.cm-scroller`。
		// 三条候选按「阅读模式优先」排列 —— 同一个 leaf 在任一时刻只有一种模式在场。
		const cmScroller = contentEl?.querySelector(".cm-scroller");
		const cands = [reading?.querySelector(".markdown-preview-view"), reading, cmScroller];
		let fallback: HTMLElement | null = null;
		for (const c of cands) {
			if (!(c instanceof HTMLElement)) continue;
			if (!fallback) fallback = c;
			if (c.scrollHeight - c.clientHeight > 4) {
				this.scrollEl = c;
				break;
			}
		}
		if (!this.scrollEl && fallback) this.scrollEl = fallback;
		if (this.scrollEl !== prev) {
			// 滚动层换人 ⇒ 坐标系变了，正文底缓存作废
			this.contentBottomCached = false;
			this.headerEl = null;
		}
		if (this.scrollEl && this.scrollEl !== prev && this.scrollHandler) {
			prev?.removeEventListener("scroll", this.scrollHandler);
			this.scrollEl.addEventListener("scroll", this.scrollHandler, { passive: true });
		}
	}

	/** 内容高度 / 视口尺寸变化都走这里（图片、嵌入异步撑高会让进度分母漂移，
	 *  RSS 图片塌缩的同款教训 —— 分母必须跟着内容走）。挂载早于 preview 渲染完成时
	 *  目录是空的，而渲染完成**不会**派发 metadataCache 事件 —— 趁 sizing 元素第一次
	 *  撑高（= 渲染完成）把空目录补建出来，此后内容的增删仍归 metadataCache 触发。 */
	private observeSizing(): void {
		if (!this.host || typeof ResizeObserver === "undefined") return;
		if (!this.ro) {
			this.ro = new ResizeObserver(() => {
			// 内容尺寸变化时滚动层可能换人（挂载那一拍 preview 未渲染，渲染完成后
			// 可滚性出现），顺带重探；DOM 模式下目录若还空着，补一次重建（渲染完成
			// 不派发 metadataCache 事件；sections / lines 模式的目录不依赖渲染，
			// 走 mount 与 metadataCache changed 两条既有路径）。
			// force=true：这里是**唯一**重判「是否可滚」的入口（滚动主循环不再每帧读
			// scrollHeight/clientHeight，见 resolveScrollEl 注释）。
			this.resolveScrollEl(true);
			// 布局变了 ⇒ 正文底缓存与页首元素缓存一并作废（坐标系依赖二者）
			this.contentBottomCached = false;
			this.headerEl = null;
				if (this.host && this.posMode === "dom" && this.entries.length === 0 && this.collectHeadingEls().length > 0) {
					this.rebuildToc();
					return;
				}
				this.requestUpdate();
			});
		}
		const contentEl = this.view?.contentEl;
		const reading = contentEl?.querySelector(".markdown-reading-view");
		const sizer = reading?.querySelector(".markdown-preview-sizer");
		if (sizer instanceof HTMLElement) this.ro.observe(sizer);
		// 编辑 / 源码模式：内容高度变化的真实元素是 CM6 的 `.cm-content`
		// （图片 / 代码块 / 折行变化都会撑高它，进度分母必须跟着走）。
		const cmContent = contentEl?.querySelector(".cm-content");
		if (cmContent instanceof HTMLElement) this.ro.observe(cmContent);
		if (this.scrollEl instanceof HTMLElement) this.ro.observe(this.scrollEl);
	}

	private requestUpdate(): void {
		if (this.rafPending) return;
		this.rafPending = true;
		window.requestAnimationFrame(() => {
			this.rafPending = false;
			this.update();
		});
	}

	/** 滚动驱动的主更新：进度条 --p = **分段进度**（设置 mdOverlayProgressScope：
	 *  0=全文一根；N=按 N 级标题分段，相邻同级标题间走完 0→1、跨段回零）；
	 *  短横填充 = 条目章内进度（阅读器语义，与 --p 解耦）。反向链接区域不计入
	 *  任何进度（分母/终点都取正文底）。rAF 节流。 */
	private update(): void {
		if (!this.host) return;
		this.resolveScrollEl();
		const el = this.scrollEl;
		if (!el) return;
		this.syncProgressTop();

		const scrollTop = el.scrollTop;
		const clientH = el.clientHeight;
		// 物理可滚高度（含反链区）——只作反链区不存在时的兜底终点
		const rawMax = Math.max(0, el.scrollHeight - clientH);
		// 正文底（滚动内容坐标系）：反链区存在时取它的顶边 —— 反链不是正文，
		// 进度分母与「读完」判定都以此为准（探针夹具与真机 1.13.7 均验证）。
		const contentBottom = this.contentBottom();
		const progressMax = Math.max(0, (contentBottom ?? el.scrollHeight) - clientH);
		// 滚到正文底 = 读完：末章之后内容不足一屏时末标题坐标够不到「抵达判定线」，
		// 不强制则最后一章的高亮/进度永远到不了位（实测桌面档 p 停在 0.85）。
		const atEnd = progressMax > 0 && scrollTop >= progressMax - 2;

		// 标题内容坐标：sections 模式纯数值（虚拟渲染下 DOM 只有窗口碎片）；
		// DOM 模式连续读一遍 rect 再统一写样式，避免读写穿插抖动 layout。
		// 阅读模式走分节累积；编辑 / 源码模式走 CM6 行块（posMode 决定谁生效）。
		// 三条来源都取不到真坐标时 hasTops=false —— 退回「只有全文进度」，宁少不给错。
		const tops = this.topsViaSections() ?? this.topsViaLines();
		const domTops = tops ? null : this.domHeadingTops(el, scrollTop);
		const resolved = tops ?? domTops ?? [];
		const hasTops = (tops ?? domTops) != null && resolved.length > 0;

		// ---- 当前条目（目录高亮 + 短横的条内进度）----
		let cur = -1;
		if (hasTops) {
			for (let i = 0; i < resolved.length; i++) {
				// noUncheckedIndexedAccess：缺位当 Infinity 处理（循环 break，语义不变）
				if ((resolved[i] ?? Infinity) <= scrollTop + ACTIVE_EPS) cur = i;
				else break;
			}
		}
		let chapterFrac = 0;
		if (atEnd && hasTops) {
			cur = resolved.length - 1;
			chapterFrac = 1;
		} else if (cur >= 0) {
			const start = resolved[cur] ?? scrollTop;
			const next = cur + 1 < resolved.length ? resolved[cur + 1] : undefined;
			// 末条目的终点 = 正文底（反链区不算正文）
			const end = next != null ? Math.max(start + 1, next - ACTIVE_EPS) : Math.max(start + 1, contentBottom ?? rawMax);
			chapterFrac = clamp01((scrollTop - start) / Math.max(1, end - start));
		} else if (!hasTops) {
			// 无标题文档：单章语义，条内进度 = 全文进度
			chapterFrac = progressMax > 0 ? clamp01(scrollTop / progressMax) : 0;
		}

		// ---- 进度条的分段进度（用户可配置粒度）----
		const scope = Math.max(0, Math.min(6, Math.floor(Number(this.plugin.settings.mdOverlayProgressScope) || 0)));
		let segFrac: number;
		if (scope <= 0 || !hasTops) {
			// 全文一根：0 → 正文底
			segFrac = progressMax > 0 ? clamp01(scrollTop / progressMax) : 0;
		} else {
			// 分段边界 = [文档起点, 恰好 scope 级标题的 top, 正文底]。
			// 分段级别**优先取恰好 scope 级**（用户选二级就是按二级分段，哪怕文里
			// 还有 H1）；scope 级在文中不存在时**自适应降到 ≤scope 的实际最高级别**
			// （用户的心智模型：「全文最高级的标题是二级，就从第一个二级到第二个
			// 二级一段」）；连候选都没有（选三级但全文只有 H4 以下）→ 退回全文。
			let segLevel = 0;
			for (const lv of this.headingLevels) {
				if (lv === scope) { segLevel = scope; break; }
				if (lv < scope && (segLevel === 0 || lv < segLevel)) segLevel = lv;
			}
			const bounds: number[] = [0];
			if (segLevel > 0) {
				for (let i = 0; i < resolved.length; i++) {
					if (this.headingLevels[i] === segLevel) {
						const t = resolved[i] ?? 0;
						if (bounds[bounds.length - 1] !== t) bounds.push(t);
					}
				}
			}
			if (bounds.length <= 1) {
				segFrac = progressMax > 0 ? clamp01(scrollTop / progressMax) : 0;
			} else {
				// 当前段 = 最后一个「top ≤ scrollTop+余量」的边界（与目录高亮同一抵达判据）
				let seg = 0;
				for (let i = 0; i < bounds.length; i++) {
					if ((bounds[i] ?? 0) <= scrollTop + ACTIVE_EPS) seg = i;
					else break;
				}
				const start = bounds[seg] ?? 0;
				const next = seg + 1 < bounds.length ? bounds[seg + 1] : undefined;
				// 末段的终点是正文底；非末段在下一边界前 ACTIVE_EPS 处切段（回零重来）
				const end = next != null
					? Math.max(start + 1, next - ACTIVE_EPS)
					: Math.max(start + 1, contentBottom ?? el.scrollHeight);
				segFrac = atEnd ? 1 : clamp01((scrollTop - start) / Math.max(1, end - start));
			}
		}

		this.progressFillEl?.style.setProperty("--p", String(segFrac));
		this.sideNav?.setActive(cur >= 0 ? cur : null);
		this.sideNav?.setChapterProgress(chapterFrac);
	}

	/** 进度条顶边让位（md 简化版）：页首可见 → 贴页首下缘（桌面文档流 / 手机浮层
	 *  两种形态统一用 rect 差值）；页首缺失或 display:none → 0。
	 *
	 *  ⚠️ 手机 + 官方「悬浮导航」是唯一例外：官方把页首做成透明浮层，正文与
	 *  插件叠加层都要铺到屏幕最顶；此时若仍按页首 rect 让位，进度条会被压到
	 *  页首下缘，和书籍阅读器的行为不一致。这里与 readerView.syncProgressTop
	 *  使用同一对判据（`is-floating-nav` + `is-phone`）并同样落到 0。
	 *
	 *  ## 沉浸态：除左上角灯绳与**章节进度条**外全部冻结（2026-10-11 立，10-12 微调）
	 *
	 *  md 全沉浸是 `display:none` 页首，隐藏后实测 `headerInset` 恒为 0 ——
	 *  旧写法直接用它，于是进入/退出全沉浸时抽屉让位整体跳一截。
	 *  现在可见态采一次存进 `lastVisibleHeaderInset`，**抽屉让位**读那份冻结值；
	 *  进度条与灯绳继续读**当前**下缘（进度条：冻结会悬空；灯绳：它是进出全沉浸的
	 *  唯一入口，见函数末尾）。
	 *
	 *  ## 同时写抽屉的两条让位量（2026-10-10 补，修「iPad 抽屉内容显示不全」）
	 *
	 *  平板 / 手机抽屉 CSS（styles.css「手机·平板」段）用 `padding-top/bottom:
	 *  var(--ur-top-inset/--ur-bottom-inset)` 躲开悬浮页首与屏幕底原生栏。阅读器那两个
	 *  变量由 readerView 写进 `.unreader-root`；**md host 上从没有人写** → 恒回落 0，
	 *  iPad 上抽屉头部被页首压、列表尾部落进 `.mobile-navbar` 底下看不见也点不到。
	 *  host 贴满整个 leaf（inset:0），与进度条同一参照系，在这里一并实测写入：
	 *   · `--ur-top-inset` = 页首下缘（**悬浮导航也照给**：透明页首的按钮仍占这条带，
	 *     抽屉是不透明盒子不能压按钮——这与进度条「可贴 0」是两件事，口径不同）；
	 *   · `--ur-bottom-inset` = host 底边被原生栏压住多少（复用 keyboardInset，
	 *     栏被官方收走时自然为 0，不写死高度）。 */
	private syncProgressTop(): void {
		const fill = this.progressEl;
		const host = this.host;
		const container = this.view?.containerEl;
		if (!fill || !host || !container) return;
		let top = 0;
		let headerInset = 0;
		const bodyCls = document.body.classList;
		const floatingPhone = bodyCls.contains("is-floating-nav") && bodyCls.contains("is-phone");
		// `.view-header` 每帧都要：缓存引用（换滚动层 / 布局变化时由 RO 置空重查），
		// 别每帧 `container.querySelector(".view-header")` 一遍。
		let header = this.headerEl;
		if (!header || !header.isConnected) {
			const q = container.querySelector(".view-header");
			header = q instanceof HTMLElement ? q : null;
			this.headerEl = header;
		}
		// 判据**只认 rect**（宽高 > 0 = 真的画在屏幕上），既不用 `display` 也不用
		// `offsetParent` 当可见性代理 —— 后者是这条链上的一次真实故障（2026-10-13）：
		// **`offsetParent` 对 `position: fixed` 元素恒为 null**，而官方悬浮导航 /
		// 自动全屏正是把页首设成 fixed（obsidian-app.css 实测）：
		//   `.is-phone.is-floating-nav, .is-phone.auto-full-screen { --view-header-position: fixed }`
		//   `.is-phone .view-header { position: var(--view-header-position); … }`
		// 于是老判据在**悬浮导航档**把整份实测丢掉（`headerInset` 恒 0）⇒
		// `--ur-immersion-switch-avoid` 归零、灯绳横线停在默认 30u 处，被不透明页首
		// 整个盖住（用户报障：「绳子偏短、被手机端页首遮挡」，且**只在悬浮导航模式下**
		// 复现 —— 普通手机档页首是 static/absolute、`offsetParent` 非 null，所以那几档
		// 看起来是好的）。同一个 `offsetParent` 坑本文件 :855 与 mdSelection :816 都已
		// 记录过（「判据用 rect 而非 offsetParent」），只有这里漏改。
		if (header) {
			const rect = header.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				const headerBottom = rect.bottom - container.getBoundingClientRect().top;
				if (headerBottom > 0) headerInset = headerBottom;
			}
		}
		// 可见态采样一次「页首可见时的下缘」，隐藏态沿用它（见字段注释）。
		// ⚠️ **过渡中段不采样**：退出沉浸那一拍官方页首正从屏外滑回，rect 读到的还是
		// 过渡起点附近的小值 —— 写进缓存就是「冻结值被污染」，抽屉的 `--ur-top-inset`
		// 会长期停在几像素上（比不更新更坏）。稳态值由 scheduleProgressTopResync 补测。
		if (headerInset > 0 && !this.headerIsAnimating(header)) this.lastVisibleHeaderInset = headerInset;
		// **抽屉一律冻结在可见态的位置**（用户明示：全沉浸不得带动不透明交互盒位移）。
		// 隐藏态下 headerInset 实测恒为 0（页首 display:none），直接用会让抽屉让位
		// 在进入/退出全沉浸时整体跳一截。⚠️ 进度条**不读**这份（见上面），别改回去。
		const frozenInset = this.lastVisibleHeaderInset;
		// 进度条：**跟随页首**（2026-10-12 微调，推翻 10-11 的全量冻结）—— 用户实测
		// 「冻结过头」：页首藏起后进度条若留在页首可见时的下缘，会在让出来的空白里**悬空**。
		// 故这里读**当前**实测下缘：隐藏态页首 display:none ⇒ headerInset = 0 = 贴 leaf 顶，
		// 与函数末尾的灯绳完全同口径。`frozenInset` 不再喂进度条，只继续服务不透明抽屉。
		top = floatingPhone ? 0 : headerInset;
		if (Math.abs(top - this.lastProgressTop) > 1) {
			this.lastProgressTop = top;
			fill.style.setProperty("--ur-progress-top", `${top}px`);
		}
		// 抽屉让位：顶部跟页首下缘（悬浮也给），底部实测原生栏重叠。
		// ⚠️ 四个变量都**值变了才写** —— `syncProgressTop` 每帧都跑，无条件写会让叠加根
		// （inset:0 的寄生层，子树含导轨 / 抽屉）每帧样式失效 + 重排，滚动肉眼可见掉帧。
		// 这份是**冻结值**（lastVisibleHeaderInset）：抽屉是不透明交互盒，必须留在页首
		// 可见时的原位，不能跟着页首走 —— 与进度条「跟随」是两件事，不要合并口径。
		const topInset = Math.round(frozenInset);
		if (topInset !== this.lastTopInset) {
			this.lastTopInset = topInset;
			host.style.setProperty("--ur-top-inset", `${topInset}px`);
		}
		const bottomInset = bottomBarOverlap(host);
		if (bottomInset !== this.lastBottomInset) {
			this.lastBottomInset = bottomInset;
			host.style.setProperty("--ur-bottom-inset", `${bottomInset}px`);
		}
		// 贴底浮层（手机 AI 面板 sheet / 译文卡）的让位量（取 usableBottom 口径，**别**与
		// 上面只含原生栏的 --ur-bottom-inset 混用）。
		// 稳态值 = 键盘上方那条原生栏高（`.mobile-toolbar`，52px）：把贴 `bottom:0` 的
		// AI 面板抬到那条栏之上 —— 正是用户要的「在键盘和 obsidian 原生工具栏上面」。
		// ⚠️ 别再按「宿主底边不动」推理：实测（390×844 + 键盘 320）宿主底边**确实**
		// 随键盘收缩（844→524），因为官方 `body.is-mobile .app-container` 收缩的是整条
		// flex 链、`.unreader-md-root` 就挂在里面。真正含键盘的是 `keyboard-animating`
		// 档（官方把容器放回满高、贴底 sheet 会整块沉到键盘下）与 iPad 浮动键盘档。
		// 键盘收起时这一路自然回 0 ⇒ 落回屏幕底部（正是用户要的「收起就收到下面」）。
		const kbInset = floatingBottomInset(host);
		if (kbInset !== this.lastKbInset) {
			this.lastKbInset = kbInset;
			host.style.setProperty("--ur-kb-inset", `${kbInset}px`);
		}
		// 左上角灯绳：host inset:0 铺满 leaf，坐标原点即 leaf 顶，无需像 readerView 那样
		// 换算 root 偏移。**灯绳是唯一允许跟随页首上移的元素** —— 它是进入 / 退出全沉浸
		// 的唯一入口，页首藏起来后若还停在原位，用户既看不见也够不着。所以这里刻意用
		// **当前**（非冻结）的下缘 —— 与进度条同一份（2026-10-12 起两者一起跟随页首）。
		// 手机悬浮页首是透明浮层（进度条可贴 0），但灯绳横线不能被浮层页首按钮压住 ——
		// 用 avoid 把竖线延长到页首下缘之外（grip-top 取 max(30u, avoid + 余量)，
		// 余量在 styles.css 的 `--ur-immersion-switch-grip-top` 里）；桌面 / 平板页首
		// 在文档流里，灯绳整体 top 让到页首下缘即可（avoid = 0）。
		const switchTop = Math.round(floatingPhone ? 0 : headerInset);
		if (switchTop !== this.lastSwitchTop) {
			this.lastSwitchTop = switchTop;
			host.style.setProperty("--ur-immersion-switch-top", `${switchTop}px`);
		}
		const switchAvoid = floatingPhone ? Math.round(headerInset) : 0;
		if (switchAvoid !== this.lastSwitchAvoid) {
			this.lastSwitchAvoid = switchAvoid;
			host.style.setProperty("--ur-immersion-switch-avoid", `${switchAvoid}px`);
		}
	}

	private nativeHeaderLayoutSignature(doc: Document): string {
		const body = doc.body?.classList;
		if (!body) return "";
		return ["is-hidden-nav", "show-view-header", "is-floating-nav", "is-phone", "is-tablet", "is-mobile", "auto-full-screen"]
			.map(name => body.contains(name) ? "1" : "0")
			.join("");
	}

	/** 页首动画期间逐帧跟随灯绳与进度条，结束时重测一次稳定值；抽屉继续留在原位。 */
	private stopProgressTopFollow(): void {
		this.progressTopFollowToken++;
		this.progressTopFollowStop?.();
		this.progressTopFollowStop = null;
		this.host?.removeClass("is-header-following");
	}

	private scheduleProgressTopResync(): void {
		this.stopProgressTopFollow();
		const host = this.host;
		if (!host) return;
		const token = this.progressTopFollowToken;
		host.addClass("is-header-following");
		this.syncProgressTop();
		this.progressTopFollowStop = followHeaderMotion(this.headerEl,
			() => this.syncProgressTop(),
			() => {
				if (token !== this.progressTopFollowToken) return;
				this.syncProgressTop();
				host.removeClass("is-header-following");
				this.progressTopFollowStop = null;
			},
		);
	}

	/** 页首是否还在跑过渡（transition / animation）。取不到动画信息时按「未动画」处理
	 *  —— 宁可存一个中间值，也不要让冻结缓存永远不更新。 */
	private headerIsAnimating(header: HTMLElement | null): boolean {
		if (!header) return false;
		try {
			return header.getAnimations().some(animation => animation.playState === "running");
		} catch {
			return false;
		}
	}

	// ---------- 沉浸会话 ----------

	toggleImmersion(): void {
		if (this.immersed) this.exitImmersion();
		else this.enterImmersion();
	}

	private enterImmersion(): void {
		if (this.immersed || !this.host) return;
		this.immersed = true;
		this.syncImmersion();
		this.syncToolbarButtons();
	}

	exitImmersion(): void {
		if (!this.immersed) return;
		this.immersed = false;
		// 防御：点按显隐与沉浸共用一份 chrome 类，退出时必须把冗余标志收干净，
		// 否则「沉浸中点过正文」会把隐藏态泄漏到退出后的普通阅读里。
		if (this.chromeHidden || this.chromeRevealed) {
			this.chromeHidden = false;
			this.chromeRevealed = false;
			this.syncChromeHidden();
		}
		this.syncImmersion();
		this.syncToolbarButtons();
	}

	/** 沉浸呈现同步：类挂两处 —— leaf 容器（`.unreader-md-view.is-full-immersion`
	 *  的后代选择器负责收官方 view-header）+ 叠加层根（收插件自己的 widget，
	 *  例外类 full-immersion-show-toc/progress 复用阅读器同款外观设置的语义）。 */
	private syncImmersion(): void {
		try {
			this.leaf.view?.containerEl?.toggleClass("is-full-immersion", this.immersed);
		} catch { /* ignore */ }
		this.host?.toggleClass("is-full-immersion", this.immersed);
		const appearance = this.plugin.settings.appearance;
		this.host?.toggleClass("full-immersion-show-toc", appearance?.fullImmersionShowTocRail === true);
		this.host?.toggleClass("full-immersion-show-progress", appearance?.fullImmersionShowChapterProgress === true);
		this.syncImmersionSwitch();
		this.syncNativeNavClasses();
		// 沉浸类挂上的同一拍页首 display:none（.unreader-md-view.is-full-immersion
		//  .view-header），灯绳 / 进度条的让位量必须立刻重测收回 0，不能等下次滚动
		// （requestUpdate 是滚动驱动的）。`getBoundingClientRect` 强制同步样式，此刻
		// 读到的就是页首已隐藏的几何。⚠️ 抽屉（--ur-top-inset）读的是冻结值
		// lastVisibleHeaderInset，这一拍刻意**不**动它 —— 不透明交互盒不许跟着跳。
		// 用 resync 而不是裸调：**退出**沉浸方向页首是滑回来的（transform 0.3s），
		// 这一拍量到的是过渡起点值，需补测一次收敛（见 scheduleProgressTopResync）。
		this.scheduleProgressTopResync();
	}

	/** 灯绳按下态 / 无障碍属性跟随沉浸会话；沉浸功能被设置关掉时整根藏掉（不留死按钮）。 */
	private syncImmersionSwitch(): void {
		const el = this.immersionSwitchEl;
		if (!el) return;
		const enabled = this.plugin.settings.mdOverlayImmersive !== false;
		el.toggleClass("is-on", this.immersed);
		el.setAttribute("aria-pressed", this.immersed ? "true" : "false");
		const label = this.immersed ? "退出全沉浸" : "进入全沉浸";
		el.setAttribute("aria-label", label);
		el.setAttribute("title", label);
		el.style.display = enabled ? "" : "none";
	}

	/** app 级官方状态由 NativeChromeGate 汇总各 view owner 后统一写；
	 *  本方法只提交自己的需求，inactive session 不能写 false 去覆盖活动视图：
	 *  nativeNavPolicy 的 selfActive 不变量，防止失活会话把隐藏态带进别的视图。
	 *  本会话把灯绳全沉浸（immersed）与点按显隐（chromeHidden）折算成一个 owner 意图；
	 *  app 级类由共享协调器汇总后统一落盘。 */
	private syncNativeNavClasses(): void {
		const inputs = this.nativeNavInputs();
		const headerHidden = inputs.selfActive && headerHiddenByUs(inputs);
		try {
			const doc = this.host?.ownerDocument ?? this.view?.containerEl.ownerDocument ?? document;
			// 底栏是 app 级状态，不能由每个 inactive Markdown 叶子直接写 true/false。
			// NativeChromeGate 汇总 Reader、Markdown 与划词 owner 后统一写官方类。
			NativeChromeGate.sync(this, this.app, () => this.nativeNavWanted(), { navbar: true, toolbar: false }, doc);
			this.leaf.view?.containerEl?.toggleClass("unreader-header-hidden", headerHidden);
			this.leaf.view?.containerEl?.querySelector(".view-header")?.toggleClass("unreader-header-hidden", headerHidden);
			if (this.nativeHeaderHiddenState !== headerHidden) {
				this.nativeHeaderHiddenState = headerHidden;
				this.scheduleProgressTopResync();
			}
		} catch { /* ignore */ }
	}

	private nativeNavInputs() {
		return {
			normalModeHideNativeChrome: this.plugin.settings.appearance.normalModeHideNativeChrome === true,
			normalModeShowHeader: this.plugin.settings.appearance.normalModeShowHeader !== false,
			normalModeShowBottomBar: this.plugin.settings.appearance.normalModeShowBottomBar !== false,
			fullImmersion: this.immersed && this.plugin.settings.mdOverlayImmersive !== false,
			chromeHidden: this.chromeHidden,
			chromeRevealed: this.chromeRevealed,
			nativeScrollHidden: false,
			phoneLike: !!(this.host?.ownerDocument.body.classList.contains("is-phone")),
			selfActive: this.selfActive(),
		};
	}

	private nativeNavWanted(): boolean {
		try { return bottomBarHiddenByUs(this.nativeNavInputs()); } catch { return false; }
	}

	private selfActive(): boolean {
		return tryGetActiveLeaf(this.app.workspace) === this.leaf;
	}

	// ---------- 点按显隐全部元素（阅读模式，语义同 RSS/电子书） ----------

	/** 挂/摘点按监听。click 挂 `view.contentEl`（冒泡）：宿主 chrome
	 *  （`.unreader-md-root`）是它的**兄弟**子树，点插件 widget 不冒泡到这里，天然不用
	 *  排除自家元素；官方页首/底栏同样是兄弟，也进不来。于是判据只剩「点的是不是
	 *  官方交互元素」。快照（pointerdown）挂 **document 捕获相位**，理由见方法体内注释。
	 *
	 *  为什么是 pointerdown(capture) + click(bubble) 两条：
	 *   · pointerdown **捕获相位**先记一笔「这一刻有没有选区 / 有没有面板开着」——
	 *   之后官方会在 mousedown 里把选区收掉、抽屉的「点外面关」也会把它收掉，等 click
	 *   时再读就永远是空/已关，「点掉选区」「点外面收抽屉」会被误判成一次普通点按；
	 *   · click 只在「按下抬起基本没动」时触发（拖动选词/滚动手势都不产生 click），
	 *    天然就是点按判据，不必自己算位移阈值。 */
	private attachTapToggle(): void {
		this.detachTapToggle();
		const el = this.view?.contentEl;
		if (!el) return;
		this.tapDownHandler = (e: PointerEvent): void => {
			this.tapHadSelection = this.hasTextSelection();
			this.tapPanelOpen = this.anyPanelOpen();
		};
		this.tapClickHandler = (e: MouseEvent): void => {
			if (!this.shouldToggleChrome(e)) return;
			this.toggleChromeByTap();
		};
		// ⚠️ 快照监听挂 **document 捕获相位**，不是 contentEl：抽屉的「点外面就关」
		// 同样挂在 document 捕获相位，而它是**随抽屉开合才注册**的 —— 挂 contentEl 会
		// 排在它后面（捕获相位按路径由外向内），快照读到的是「抽屉已被收掉」的状态，
		// 守卫整个失效（2026-10-16 实测：那一发真的把 chrome 也翻了）。document 上
		// 按注册次序：本监听（mount 时）早于抽屉监听（开抽屉时）⇒ 快照必赶在收抽屉之前。
		const doc = this.host?.ownerDocument ?? document;
		doc.addEventListener("pointerdown", this.tapDownHandler, true);
		el.addEventListener("click", this.tapClickHandler);
		this.tapEl = el;
		this.tapDoc = doc;
	}

	/** 按挂载时那个引用摘（见 tapEl 字段注释）：popout 窗口里 `this.view` 可能
	 *  已经换了 contentEl，现取会摘错元素、把监听漏在 DOM 上。 */
	private detachTapToggle(): void {
		const el = this.tapEl;
		const doc = this.tapDoc;
		if (this.tapDownHandler && doc) doc.removeEventListener("pointerdown", this.tapDownHandler, true);
		if (this.tapClickHandler && el) el.removeEventListener("click", this.tapClickHandler);
		this.tapEl = null;
		this.tapDoc = null;
		this.tapDownHandler = null;
		this.tapClickHandler = null;
		this.tapHadSelection = false;
		this.tapPanelOpen = false;
	}

	/** 当前是否有非空文本选区（点按显隐的排除项：先让官方把选区收掉）。 */
	private hasTextSelection(): boolean {
		try {
			const sel = this.host?.ownerDocument.defaultView?.getSelection()
				?? window.getSelection();
			return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
		} catch {
			return false;
		}
	}

	/** 三个悬浮面板此刻是否开着（点按显隐的同刻快照用；与 toggleChromeByTap 里
	 *  click 时刻的那道复查是同一口径，一个记 down、一个兜 up）。 */
	private anyPanelOpen(): boolean {
		return !!this.sidePanel?.isOpen()
			|| !!this.appearancePanel?.isOpen()
			|| !!this.aiPanel?.isOpen();
	}

	/** 这一拍算不算「点屏幕」：阅读模式 ∧ 非官方交互元素 ∧ 不是点掉选区。
	 *  官方交互元素逐个排除（链接/按钮/输入/勾选/菜单项/页首）—— 点它们的语义
	 *  是它们自己，不该顺带把界面收起来。 */
	private shouldToggleChrome(e: MouseEvent): boolean {
		if (this.mode !== "preview") return false;
		// 全沉浸态下灯绳独占显隐真源：此刻点正文若去翻 chromeHidden，视觉上
		// 什么都没有（沉浸 CSS 仍藏着），却会把标志留到退出沉浸之后才冒出来。
		if (this.immersed) return false;
		if (this.tapHadSelection) return false;
		// 按下那刻有面板开着 ⇒ 这一拍的语义是「点外面收面板」（pointerdown 已经
		// 收了），click 不该再补一刀切 chrome。
		if (this.tapPanelOpen) return false;
		const target = e.target as Element | null;
		if (!target || typeof target.closest !== "function") return false;
		if (target.closest(".unreader-md-root")) return false; // 自家 widget（防御性）
		return !target.closest(
			"a, button, input, textarea, select, [contenteditable='true'],"
			+ " [role='button'], [role='link'], [role='checkbox'], [role='menuitem'],"
			+ " [role='option'], [data-popover], .view-header, .mobile-navbar, .status-bar",
		);
	}

	private toggleChromeByTap(): void {
		// 面板开着先收面板（与阅读器点按同语义：先清障，不把两件事叠在一拍上）。
		// 触屏没有 hover，抽屉/外观/AI 只能靠点外面收 —— 那一拍不该顺带切 chrome。
		// （常态下 shouldToggleChrome 的 tapPanelOpen 快照已挡住；这里是对手势中途
		// 面板才弹开的兜底。）
		if (this.anyPanelOpen()) {
			this.sidePanel?.hide();
			this.appearancePanel?.close();
			this.aiPanel?.close();
			return;
		}
		if (this.chromeHidden) {
			this.chromeHidden = false;
			this.chromeRevealed = true;
		} else if (this.chromeRevealed) {
			this.chromeHidden = true;
			this.chromeRevealed = false;
		} else {
			this.chromeHidden = true;
		}
		this.syncChromeHidden();
	}

	private setChromeHidden(hidden: boolean): void {
		if (this.chromeHidden === hidden && !this.chromeRevealed) return;
		this.chromeHidden = hidden;
		this.chromeRevealed = false;
		this.syncChromeHidden();
	}

	/** 点按显隐的呈现：类挂三处 —— 宿主（收插件 chrome）+ leaf 容器（收官方页首，
	 *  与全沉浸同一招）+ app 级 body 类（收手机底栏，与全沉浸同一套、同一
	 *  selfActive 门控）。官方 chrome 只有一套 DOM 类，不造第二真源。 */
	private syncChromeHidden(): void {
		this.host?.toggleClass("chrome-hidden", this.chromeHidden);
		this.host?.toggleClass("chrome-revealed", this.chromeRevealed);
		this.syncNativeNavClasses();
	}

	/** 活动叶子变化的三分支（复用阅读器的纯判据，语义完全对齐）：
	 *  切到别的内容 leaf → 结束会话；切到侧栏 → 保持会话但放掉 app 级类
	 *  （侧栏里的视图要靠官方页首/工具条）；切回自己 → 补写 app 级类。 */
	onActiveLeafChange(newLeaf: WorkspaceLeaf | null): void {
		if (!newLeaf) return;
		const facts = {
			self: newLeaf === this.leaf,
			sidePanel: isSidePanelLeaf(newLeaf, this.app.workspace),
		};
		if (this.immersed && endsImmersionOnActiveLeafChange(facts)) this.exitImmersion();
		else this.syncNativeNavClasses();
	}
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 源码偏移 → 0 基行号（= 该偏移之前的换行个数）。越界裁到末行。 */
function countLineBefore(src: string, offset: number): number {
	const end = Math.min(Math.max(0, offset), src.length);
	let line = 0;
	for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++;
	return line;
}

/** 文本归一化做包含匹配：折叠所有连续空白为一个空格，去首尾空白。不强制小写
 *  （高亮正文可能含英文专名，大小写敏感更准）。 */
function normalizeText(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** 结构化取用「当前活动叶子」。**不能只靠 `getActiveLeaf()`**：它在 1.13 typings
 *  已移除，且真机 1.13.7 实测**运行时也恒空**（CDP/命令面板场景都拿不到）——
 *  按可靠性级联：老 API（旧版本仍在）→ `activeLeaf` 字段 → `getMostRecentLeaf()`
 *  （后两者在 1.13.7 实测一致且正确）。全空/抛错返回 null，调用点按「非活动」处理。
 *  项目先例同款：main.ts 的 registerHoverLinkSource 也是 `as unknown as` 结构化取用。 */
function tryGetActiveLeaf(ws: Workspace): WorkspaceLeaf | null {
	try {
		const w = ws as unknown as {
			getActiveLeaf?: () => WorkspaceLeaf | null;
			activeLeaf?: WorkspaceLeaf | null;
			getMostRecentLeaf?: () => WorkspaceLeaf | null;
		};
		const viaMethod = w.getActiveLeaf?.() ?? null;
		if (viaMethod) return viaMethod;
		return w.activeLeaf ?? w.getMostRecentLeaf?.() ?? null;
	} catch {
		return null;
	}
}

/** 官方 markdown 视图的两种形态。
 *  ⚠️ **不区分「实时预览」与「源码」**：`MarkdownView.getMode()` 只返回
 *  `"source" | "preview"` —— 实时预览在官方口径里就是 source（渲染与否由
 *  `editorLivePreviewField` 决定）。两者的 DOM、滚动容器（`.cm-scroller`）与
 *  标题数据源完全相同，叠加层没必要分家。 */
type MdViewMode = "preview" | "edit";

/** 该 leaf 是不是 markdown 视图 —— **三种模式都算**。
 *  2026-10-10 之前这里只认 `getMode() === "preview"`，编辑 / 源码模式的叠加层因此
 *  整体不挂载（用户报「编辑模式下进度条、沉浸按钮、目录条全都不出现」）。
 *
 *  ⚠️ 这里只看**视图类型**。文件是不是「真笔记」由 `MdOverlayManager.isOverlayLeaf`
 *  再过一道隔离墙（`core/fileGate.ts`）—— Excalidraw 的 `*.excalidraw.md` 在
 *  Excalidraw 插件把自己的视图换上来之前，会**先由官方 markdown 视图承载一瞬**，
 *  只看视图类型就会在那个窗口里挂上叠加层（用户 2026-10-13 报障）。 */
function isMarkdownLeaf(leaf: WorkspaceLeaf): boolean {
	try {
		return leaf?.view instanceof MarkdownView;
	} catch {
		return false;
	}
}

/** 读当前模式。取不到 / 抛错时按 `preview` 处理（保守：走渲染器那条既有路径）。 */
function modeOf(view: MarkdownView | null): MdViewMode {
	try {
		return view?.getMode() === "preview" ? "preview" : "edit";
	} catch {
		return "preview";
	}
}

/** 叠加层管理器：`ExplorerHeal` 形态（new + start/stop + plugin.register 兜底清理），
 *  内部按 leaf 维护会话表。事件经 `plugin.registerEvent` 注册，插件卸载时自动摘。 */
export class MdOverlayManager {
	private readonly sessions = new Map<WorkspaceLeaf, MdOverlaySession>();
	private started = false;
	private retryTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: UNreaderPlugin,
	) {}

	/** 隔离墙（core/fileGate.ts）：该 leaf 是不是「可以挂叠加层的真 markdown 笔记」。
	 *
	 *  两个条件缺一不可：① 视图是官方 markdown 视图；② 文件**不是**别的插件的
	 *  `.md` 数据文件。第 ② 条不能省 —— Excalidraw 的 `*.excalidraw.md` 在 Excalidraw
	 *  把 leaf 换成自己的视图之前，会先由官方 markdown 视图承载；那一刻若挂上我们的
	 *  进度条 / 目录条 / 灯绳，用户看到的就是「UNreader 叠在绘图上面」。
	 *  `view.file` 为空（新建的空视图）时按可挂处理，与改动前一致。 */
	private isOverlayLeaf(leaf: WorkspaceLeaf): boolean {
		if (!isMarkdownLeaf(leaf)) return false;
		try {
			const view = leaf.view;
			const file = view instanceof MarkdownView ? view.file : null;
			return !file || isMarkdownNoteFile(this.app, file);
		} catch {
			return false;
		}
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		// 双通道：active-leaf-change 管换 leaf，layout-change 管「同一 leaf 内换视图 /
		// 切阅读模式」（它不派发 active-leaf-change，readerView 同款注释）
		this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
			this.syncAll(leaf);
		}));
		this.plugin.registerEvent(this.app.workspace.on("layout-change", () => {
			this.syncAll(null);
		}));
		// 官方「悬浮导航」切换会改 body 上的 is-floating-nav，并派发 css-change；
		// 同一次也要让已挂载的 md 会话重算进度条顶边（不依赖用户下一次滚动）。
		this.plugin.registerEvent(this.app.workspace.on("css-change", () => {
			this.refreshAllLayouts();
		}));
		// 同一个 leaf 内换文件不一定派发 active-leaf-change；file-open 只负责把
		// 「当前正在看哪篇」记进最近列表，叠加层挂载仍由上面两条布局事件收口。
		this.plugin.registerEvent(this.app.workspace.on("file-open", file => {
			if (!file) return;
			// 隔离墙：伪 markdown（Excalidraw 绘图等）连「最近阅读」都不记。
			if (!isMarkdownNoteFile(this.app, file)) return;
			window.setTimeout(() => {
				const current = tryGetActiveLeaf(this.app.workspace);
				const view = current?.view;
				if (current && this.isOverlayLeaf(current) && view instanceof MarkdownView
					&& view.file?.path === file.path) {
					// 「最近阅读」只在阅读模式记录（编辑 / 源码下是在写，不是在读）
					if (modeOf(view) === "preview") this.plugin.recordMarkdownNoteOpened(file.path);
					// 同一 leaf 换文件时 host 不会重建；星标按钮要按新 file.path 重算。
					this.sessions.get(current)?.refreshToolbar();
				}
			}, 0);
		}));
		// 文档被编辑（另一 pane / 换源）→ 预览重渲染后标题集合可能变化
		this.plugin.registerEvent(this.app.metadataCache.on("changed", file => {
			this.onFileChanged(file);
		}));
		// 编辑 / 源码模式的内容变化**不派发** metadataCache.changed（那只在索引更新时
		// 来，且是去抖的）—— 打字期间标题行号会漂移，靠这条把几何重算接上；
		// 目录重建在会话里另做去抖（跟着每一次按键重建目录才是真卡顿）。
		this.plugin.registerEvent(this.app.workspace.on("editor-change", () => {
			for (const session of this.sessions.values()) session.onEditorChanged();
		}));
		this.syncAll(null);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		if (this.retryTimer != null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		for (const session of this.sessions.values()) session.unmount();
		this.sessions.clear();
	}

	/** 设置页的三个开关变化后调用：全部会话即时生效。 */
	applySettingsAll(): void {
		for (const session of this.sessions.values()) session.applySettings();
	}

	/** 阅读外观（字体 / 字号 / 行距 / 字距）变化后调用：全部 md 会话即时重刷抽屉排版。
	 *
	 *  只有这一处专门给「外观」用（`applySettingsAll` 是设置页三开关的全量重算）。
	 *  `main` 的字体/资源刷新路径此前只 `getActiveReader()?.refreshAppearance()` ——
	 *  纯 markdown 用户没有活动阅读器，字体晚到后抽屉**永久**停在 `--font-text` 回落上
	 *  （用户 2026-10-12 报障）。与阅读器那针一样落在同一次刷新漏斗里。 */
	refreshAppearanceAll(): void {
		for (const session of this.sessions.values()) session.refreshAppearance();
	}

	/** 自定义按钮配置变更后：全部会话的侧栏槽与划词条槽即时重推。 */
	refreshCustomButtonsAll(): void {
		for (const session of this.sessions.values()) session.syncCustomButtons();
	}

	/** 「高亮选中文本」命令在活动 md 阅读会话上执行。返回 false 让 main 给 Notice。 */
	highlightSelectionOnActiveLeaf(colorName: string): boolean {
		const leaf = tryGetActiveLeaf(this.app.workspace);
		const session = leaf ? this.sessions.get(leaf) : null;
		if (!session || !session.isMounted()) return false;
		return session.highlightCurrentSelection(colorName);
	}

	/** 官方布局 / CSS 形态变化后，让已挂载叠加层重算自身几何。 */
	private refreshAllLayouts(): void {
		for (const session of this.sessions.values()) session.refreshLayout();
	}

	/** 沉浸命令入口：活动 leaf 必须是已挂叠加层的 markdown 阅读视图。
	 *  返回 false 让 main.ts 的命令兜底 Notice（命令面板回车静默失效的老坑）。 */
	toggleImmersionOnActiveLeaf(): boolean {
		const leaf = tryGetActiveLeaf(this.app.workspace);
		const session = leaf ? this.sessions.get(leaf) : null;
		if (!session || !session.isMounted()) return false;
		session.toggleImmersion();
		return true;
	}

	private syncAll(activeLeaf: WorkspaceLeaf | null): void {
		if (!this.started) return;
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		// 先清已关闭的 leaf（layout-change 不保证先派发关闭事件）
		for (const [leaf, session] of [...this.sessions]) {
			if (!leaves.includes(leaf) || !leaf.view) {
				session.unmount();
				this.sessions.delete(leaf);
			}
		}
		for (const leaf of leaves) {
			const session = this.sessions.get(leaf);
			if (this.isOverlayLeaf(leaf)) {
				if (session) {
					// 已挂载：同一个 leaf 内可能换过模式（阅读 ↔ 实时预览 ↔ 源码），
					// 每次 sync 都让它自查一遍（模式没变是空操作）。
					session.syncMode();
					session.mount();
				} else {
					const created = new MdOverlaySession(this.app, this.plugin, leaf);
					this.sessions.set(leaf, created);
					created.mount();
				}
			} else if (session) {
				// 不是可挂的 markdown 笔记了（换成别的视图类型，或文件是伪 markdown）：
				// 叠加层整体退场（含未退出的沉浸会话）
				session.unmount();
				this.sessions.delete(leaf);
			}
		}
		// layout-change 也会覆盖官方导航形态变化：已挂载会话重跑一次几何同步。
		if (!activeLeaf) this.refreshAllLayouts();
		if (activeLeaf) {
			for (const session of this.sessions.values()) session.onActiveLeafChange(activeLeaf);
		}
		const currentLeaf = activeLeaf ?? tryGetActiveLeaf(this.app.workspace);
		if (currentLeaf && this.isOverlayLeaf(currentLeaf)) {
			const view = currentLeaf.view;
			// 「最近阅读」只记阅读模式：编辑 / 源码下用户是在写，不是在读。
			if (view instanceof MarkdownView && view.file && modeOf(view) === "preview") {
				this.plugin.recordMarkdownNoteOpened(view.file.path);
			}
		}
		// 「应挂未挂」的滞后复查：openFile 替换 view 的事件时序里，sync 可能跑在
		// 新 view 就绪**之前**（读到旧视图 / getMode 还没就位），而之后再无事件
		// → 这片叶子永远挂不上（真机 1.13.7 实测）。短重试直到挂上或条件消失，间隔轻量、自然收敛。
		if (leaves.some(l => this.isOverlayLeaf(l) && !this.sessions.has(l))) {
			this.scheduleRetrySync();
		}
	}

	/** 打开瞬间的滞后重试（250ms 一拍，条件消失即止）。 */
	private scheduleRetrySync(): void {
		if (!this.started || this.retryTimer != null) return;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			this.syncAll(null);
		}, 250);
	}

	private onFileChanged(file: TFile): void {
		for (const [leaf, session] of this.sessions) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				session.onFileExternallyChanged();
			}
		}
	}
}
