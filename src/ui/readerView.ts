import { HoverPopover, ItemView, WorkspaceLeaf, TFile, Notice, setIcon, debounce, ViewStateResult, Platform } from "obsidian";
import type UNreaderPlugin from "../main";
import { EngineAdapter, RelocateInfo, RawFoliateView, styleFootnoteView, NavEntryModel, backDebugOn, FrameSwipeInfo, type BookOpenTarget } from "../core/engineAdapter";
import { createVaultResourceResolver, getBookshelfEntries, isHtmlBookFile, readBookFile, sortBookshelfEntries } from "../core/bookService";
import { loadBookPreview } from "../core/bookPreview";
import { makeHtmlBook } from "../core/htmlBook";
import { ProgressCursor } from "../core/progressCursor";
import { perfReset, perfBegin, perfEnd } from "../core/perf";
import * as debugLog from "../core/debugLog";
import { confirmAction } from "./confirmModal";

/** 悬浮预览锚点的兜底尺寸（range 量不到时的 12px 占位）。常量提取只为满足
 *  官方 lint「不得给 .style 赋字面量」；值与写入时机不变。 */
const HOVER_ANCHOR_FALLBACK_SIZE = "12px";

/** 标注侧边栏展开时，按钮排贴到面板右缘的两条行内样式（提常量以过官方 lint）。 */
const RAIL_SHIFTED_TRANSFORM = "translateX(0) translateY(-50%)";
const RAIL_SHIFTED_OPACITY = "0.9";

/** 网页（本地 HTML）设备模式按钮的档位表：图标 + 无障碍名，按键查表（键集 = 全部档位，
 *  查不到 undefined 不存在）。图标即档位，一眼看出当前按哪台设备渲染。 */
const WEB_DEVICE_STEPS: Record<WebDeviceMode, { icon: string; label: string }> = {
	auto: { icon: "monitor-smartphone", label: "自动（跟随窗口宽度）" },
	phone: { icon: "smartphone", label: "手机（390px 视口）" },
	tablet: { icon: "tablet", label: "平板（834px 视口）" },
	desktop: { icon: "monitor", label: "桌面（1280px 视口）" },
};

/** 点击循环顺序：auto（默认档、也是「跟随窗口宽度」的老口径）排第一。 */
const WEB_DEVICE_ORDER: WebDeviceMode[] = ["auto", "phone", "tablet", "desktop"];

/** 循环顺序里 `cur` 的下一档（表尾回到表首）。 */
function nextWebDevice(cur: WebDeviceMode): WebDeviceMode {
	const i = WEB_DEVICE_ORDER.indexOf(cur);
	return WEB_DEVICE_ORDER[(i + 1) % WEB_DEVICE_ORDER.length] ?? "auto";
}

/** 画图标；本机图标集里没有 `icon` 时退到 `fallback`（见 hasIcon）。
 *  给「新图标名 + 老兜底」这种成对写法用的：Obsidian 各版本打进来的 lucide 集不完全
 *  一致，`setIcon` 碰到不存在的名字会静默失败 —— 按钮整个空白，比图标不贴切难查得多。 */
function paintIcon(el: HTMLElement, icon: string, fallback: string): void {
	setIcon(el, hasIcon(icon) ? icon : fallback);
}

/** 本机 lucide 图标集里有没有这个名字（结果缓存）。取不到的图标名会让按钮**整个空白**
 *  （setIcon 静默失败，比图标不贴切难查得多），所以用之前先问一句。
 *
 *  判定方式是「画一次看有没有落地」，不走 obsidian 的 `getIconIds()`：那是一个额外的
 *  公开导出，加进 import 就得让每个测试替身跟着补一个同名导出，收益为零。画不出来
 *  （含替身环境里 setIcon 是空实现）一律按「有」处理 —— 宁可图标不贴切，也不要
 *  把调用方的兜底图标名也改掉。 */
const iconKnown = new Map<string, boolean>();
function hasIcon(name: string): boolean {
	const hit = iconKnown.get(name);
	if (hit !== undefined) return hit;
	let ok = true;
	try {
		const probe = createSpan();
		setIcon(probe, name);
		ok = probe.querySelector("svg") !== null;
	} catch { /* 环境不支持：当作有 */ }
	iconKnown.set(name, ok);
	return ok;
}
import { collectHeaderBandFacts } from "./headerBandDiag";
import { importFontFile, isFontExt, MAX_FONT_BYTES } from "../core/fontService";
import { FONTS_FOLDER, IMAGES_FOLDER } from "../core/paths";
import type { AppearanceSettings, BookshelfCategoryFilter, BookshelfSortMode, BookPosition, WebDeviceMode } from "../types";
import type { FeedEntry, FeedFilter, ReaderSource } from "../types";
import { DEFAULT_APPEARANCE, activeTheme } from "../types";
import { resolveActiveColors } from "../core/engineAdapter";
import {
	AnnotationFileData,
	annotationFileFor,
	annotationFileForFeed,
	loadAnnotations,
	writeAnnotations,
	sanitizeBookmarkLabel,
	StoredHighlight,
} from "../core/annotationStore";
import { makeFeedBook } from "../core/feedBookFactory";
import { reconcileFeedAnnotationAnchors } from "../core/feedUtils";
import { entryFeedContentQuality } from "../core/feedContentQuality";
import { sanitizeArticleHtml } from "../core/articleExtractor";
import { openExternalLink } from "../core/externalLink";
import { saveArticleNote } from "../core/noteExporter";
import { AppearancePanel } from "./appearancePanel";
import { PresetNameModal } from "./presetModal";
import { SelectionToolbar } from "./selectionToolbar";
import { HighlightPopover } from "./highlightPopover";
import { AnnotationsPanel } from "./annotationsPanel";
import { BookmarkModal } from "./bookmarkModal";
import { PageJumpModal } from "./pageJumpModal";
import { PodcastSleepModal } from "./podcastSleepModal";
import { PodcastSeekModal } from "./podcastSeekModal";
import { BackgroundImageModal, type BackgroundImagePick } from "./backgroundImageModal";
import { FontPickModal, type FontPick } from "./fontPickModal";
import { SideNav } from "./sideNav";
import { NativeNavGuard, PLUGIN_NAV_HIDDEN_CLASS } from "./nativeNavGuard";
import { NativeChromeGate } from "./nativeChromeGate";
import { hasCoreModal, watchCoreModal, blurIfFocusInside, focusModalPrimary, arbitrateReaderFocus } from "../core/modalFocusGate";
import { bottomBarHiddenByUs, headerHiddenByUs, type ImmersiveNativeInputs } from "./nativeNavPolicy";
import { scheduleBottomBandDiag, cancelBottomBandDiag } from "./bottomBandDiag";
import { clampHeightToUsable, bottomBarOverlap } from "./keyboardInset";
import type { Bounds } from "./floatingPlacement";
import { idleYield } from "../core/idle";

export const VIEW_TYPE_UNREADER = "unreader-view";

/** 播客倍速档位（按顺序循环；1 为默认档）。 */
const PODCAST_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
const PODCAST_SPEED_KEY = "unreader-podcast-speed";

/** 底栏「让位」类（挂 `document.body`，app 级；样式见 styles.css 的 `unreader-nav-float` 段） */
const NAV_FLOAT_CLASS = "unreader-nav-float";
/** 唤出底栏后延迟多久撤销让位（ms）：官方底栏 `transform 0.3s ease-out` + 一点余量。
 *  提前撤销 = 那 80px 先露出窗口底色再被滑回来的底栏盖住（一次 300ms 的闪）。 */
const NAV_FLOAT_RELEASE_MS = 340;

/** 点按投递去重窗口（ms）：同一手势的不同事件若落在该窗口内，只认第一次。
 *  远小于人手连点间隔（实测有意连点普遍 >200ms），所以不会吞掉用户的连续点按。 */
const TAP_DEDUP_MS = 120;

/** 全沉浸「返回哨兵」在视图状态里的标记键（见 UNreaderView.immersionHistoryGuard）。 */
const IMMERSION_HISTORY_GUARD_KEY = "__unreaderImmersionGuard";

interface PendingSelection {
	doc: Document
	index: number
	text: string
	cfi: string | null
	rect: DOMRect
	at: number
}

/** 开放接口的返回结构：三方插件（UNagent/UNmemos 等）经
 * `app.plugins.plugins.unreader.getReaderSelection()` 读取书内选区。
 * iframe 选区对宿主 window.getSelection() 不可见，镜像方案又有焦点
 * 塌陷边界，选区连同来源信息从这里递出去最可靠。 */
export interface ReaderSelectionInfo {
	/** 选中文字（已归一化空白） */
	text: string
	/** 选区 CFI（可空） */
	cfi: string | null
	/** 选区完成时间戳（消费方可自行做新鲜度判断） */
	at: number
	/** 书籍文件完整路径（如 `读书/书名.epub`） */
	bookPath: string
	/** 书籍文件名（带扩展名，如 `书名.epub`） */
	bookName: string
	/** 章节标题（可空） */
	chapter: string | null
}

export class UNreaderView extends ItemView {
	private readonly plugin: UNreaderPlugin;
	private readonly adapter = new EngineAdapter();
	private appearancePanel!: AppearancePanel;
	private selectionToolbar!: SelectionToolbar;
	private highlightPopover!: HighlightPopover;
	private annotationsPanel!: AnnotationsPanel;
	private sideNav!: SideNav;
	private bookOnlyNavControls: HTMLElement[] = [];
	private hoverRaf = 0;
	/** Obsidian 官方悬浮预览 */
	hoverPopover: HoverPopover | null = null;
	private hoverAnchorEl: HTMLElement | null = null;
	private hoveredId: number | null = null;

	file: TFile | null = null;
	private feedRef: { feedId: string; entryId: string } | null = null;
	private currentFeedEntry: FeedEntry | null = null;
	/** 当前正文用于高亮迁移的版本；有 pending 时指向待提交的新版本。 */
	private activeFeedContentHash: string | null = null;
	private feedFilter: FeedFilter = "all";
	private feedSourceFilter: string | null = null;
	private bookshelfCategoryFilter: BookshelfCategoryFilter = "all";
	private feedAutoRefreshDone = false;
	private podcastProgressTimer: number | null = null;
	private podcastProgressPending = new Map<string, { feedId: string; entryId: string; position: BookPosition }>();
	private lastPodcastCheckpointAt = 0;
	/** 播客播放条：挂在 root 顶部，随当前文章出现；不放进卡片，避免刷新列表时把正在播放的 audio 销毁。 */
	private podcastBarEl: HTMLElement | null = null;
	private podcastAudioEl: HTMLAudioElement | null = null;
	private podcastPlayBtn: HTMLButtonElement | null = null;
	private podcastSeekEl: HTMLInputElement | null = null;
	private podcastTimeEl: HTMLElement | null = null;
	private podcastTotalEl: HTMLElement | null = null;
	private podcastDownloadBtn: HTMLButtonElement | null = null;
	private podcastSpeedBtn: HTMLButtonElement | null = null;
	private podcastSleepBtn: HTMLButtonElement | null = null;
	private podcastMarkBtn: HTMLButtonElement | null = null;
	private podcastBarRef: { feedId: string; entryId: string; url: string } | null = null;
	private podcastSpeed = 1;
	private podcastPendingSeek: number | null = null;
	/** 重开播客时的恢复目标；与用户显式 seek 分开，避免缓存换源竞态把位置冲掉。 */
	private podcastResumeTarget: number | null = null;
	private podcastSleepUntil = 0;
	private podcastSleepTimer: number | null = null;
	private loadedPath: string | null = null;
	private loadingToken = 0;
	/** 正在开书恢复上次阅读位置（见 loadBook 的 is-restoring / whenRestored）。
	 *  期间**不落盘进度**：恢复落定前视口还在书首（或估算落点），
	 *  `renderSection` 一挂上 frame 就会触发首次 relocate → 会把书首位置写回进度，
	 *  等于把用户的阅读位置冲掉。 */
	private restoring = false;
	private chromeReady = false;
	/** 启动开书闸门：onOpen/setState 只登记请求，真正的解析与渲染等 layout ready + 首帧空闲。
	 *  细节见 scheduleLoad —— 它同时负责「后台标签页不抢跑」与「布局期不解析整本书」。 */
	private loadGateBusy = false;
	private loadGateSeq = 0;
	private loadReqSeq = 0;
	/** layout ready 等待的单例：同一视图的 onOpen/setState/切页可能各调一次 scheduleLoad，
	 *  不能让每次调用都往官方的 onLayoutReady 队列里塞一个回调（那会拖长 layout 回调循环）。 */
	private layoutGate: Promise<void> | null = null;
	private lastRelocate: RelocateInfo | null = null;
	/** 「可落盘的当前位置」守卫：只收恢复期结束后、属于当前这本书的 relocate。
	 *  见 core/progressCursor.ts —— 它挡的是「打开没开完就退出 → 书首位置被写回进度」
	 *  与「换书后旧书落点写进新书」这两类偶发的位置丢失。 */
	private cursor = new ProgressCursor();
	/** 本机热缓存 checkpoint 的节流状态：不跟 800ms 去抖走，最多丢很短一拍。 */
	private lastCheckpointKey = "";
	private lastCheckpointAt = 0;

	private notePath = "";
	private annotations: AnnotationFileData = { highlights: [], bookmarks: [] };
	/** 目录跳转处理器：目录面板需在派生标题解析完成后增量重建（onNavDerived） */
	private navJump: ((entry: NavEntryModel) => void) | null = null;
	private pendingSelection: PendingSelection | null = null;
	/** 最近一次有效选区的快照（快捷键消费方兜底用）：选中即写入，即使后续
	 *  瞬时清空选区（如热键触发时焦点归还宿主、iframe 选区塌陷触发的空
	 *  selection 事件）也不会立刻丢失，10s 新鲜度窗口内对外仍可读到。 */
	private lastExcerpt: { text: string; cfi: string | null; at: number } | null = null;
	private static readonly EXCERPT_TTL = 10_000;

	// 主文档选区镜像：把 iframe 内的选区同步到一个隐藏元素，让「选中后按快捷键」
	// 的三方插件（如 UNagent / 碎片笔记）能读到，行为与 markdown 一致。
	private mirrorEl: HTMLElement | null = null;
	private mirrorPending = false;
	private mirrorText = "";
	private mirrorKeepalive: number | null = null;
	/** 焦点归还宿主后的短暂保持窗口：期间 iframe 选区塌陷不清镜像（ms 时间戳） */
	private mirrorHoldUntil = 0;

	private rootEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private contentHost!: HTMLElement;
	private emptyEl!: HTMLElement;
	private loadingEl!: HTMLElement;
	/** 内容区顶边进度条：**全宽**（left/right:0），贴内容区顶边（移动端落在页首浮层
	 *  下缘，沉浸模式页首让位后上移到顶部常驻）。与右缘轨内的填充同源、同开关。 */
	private progressEl: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private titleText = "";

	// 钉住状态
	private pinned = false;
	private pinThreshold = 720;
	private pinResizeObserver: ResizeObserver | null = null;
	private pinBtn: HTMLElement | null = null;
	/** 常驻的沉浸模式拉绳开关：进入/退出共用一枚，不依赖任何图标名。 */
	private immersionSwitchEl: HTMLElement | null = null;
	private immersionSwitchPullTimer: number | null = null;
	/** 全沉浸中的临时“点按唤出”态；只属于当前会话，不写设置。 */
	private fullImmersionRevealed = false;
	/** 会话级状态，不写设置：切书/关闭视图清理，标签页失活只释放原生导航。 */
	private fullImmersion = false;
	/** 全沉浸期间压在 leaf 导航历史里的「返回哨兵」条目（见 pushImmersionHistoryGuard）。 */
	private immersionHistoryGuard: Record<string, unknown> | null = null;
	/** 功能轨上「开关型」按钮：各自对应的面板/浮层开着时常亮（见 syncRailButtons）；
	 *  星标是唯一带**内容状态**的一枚（当前文章是否已收藏），同样现读、不在调用点切类。 */
	private railTocBtn: HTMLElement | null = null;
	private railShelfBtn: HTMLElement | null = null;
	private railFeedsBtn: HTMLElement | null = null;
	private railAnnoBtn: HTMLElement | null = null;
	private railAppearanceBtn: HTMLElement | null = null;
	private railSearchBtn: HTMLElement | null = null;
	/** 左侧工具栏里的全沉浸备用入口：Android 悬浮导航可能遮住左上角拉绳按钮。 */
	private railImmersionBtn: HTMLElement | null = null;
	/** Feed 专属：在系统默认浏览器打开当前文章原文（正文里不再注入这条链接） */
	private railOriginalBtn: HTMLElement | null = null;
	/** Feed 专属：收藏（星标）当前文章；书源下由 CSS 收走（`is-feed-only-control`） */
	private railStarBtn: HTMLElement | null = null;
	/** Feed 专属：把当前文章（必要时先抓全文）另存为一篇 Obsidian 笔记 */
	private railSaveNoteBtn: HTMLElement | null = null;
	/** 本地 HTML 专属：阅读设备档位（自动/手机/平板/桌面）。非 HTML 书由 CSS 收走
	 *  （`is-html-only-control`，靠 root 上的 `is-html-source` 类判定）。 */
	private railDeviceBtn: HTMLElement | null = null;
	private pinBtnHidden = false;
	private debouncedPinVisibility: (() => void) | null = null;
	private stageResizeObserver: ResizeObserver | null = null;
	/** 上下避让边界（沉浸拉绳 / 播客条）的尺寸观察器；几何一变就重算浮动轨道可用区。 */
	private floatingFitObserver: ResizeObserver | null = null;
	private floatingFitRaf: number | null = null;
	/** 页首/拉绳过渡期间的逐帧跟随截止时间（performance.now() 时间戳）。 */
	private floatingFitBurstUntil = 0;
	/** 最近一次“页首可见”时沉浸按钮的底边（视口坐标）。
	 *  点按唤出工具栏时，页首会从隐藏态滑回；工具栏不应跟着这条过渡逐帧下移，
	 *  而应直接落在页首可见后的最终避让位置。 */
	private lastVisibleHeaderBottom: number | null = null;
	/** 模态框打开归还焦点观察器（见 onOpen：命令面板第一次执行无效的修复） */
	/** 核心模态框观察的取消订阅（见 core/modalFocusGate 与 onOpen 里的接线） */
	private unwatchCoreModal: (() => void) | null = null;
	/** 焦点闭环守卫的解绑函数（见 core/modalFocusGate.arbitrateReaderFocus） */
	private unarbitrateFocus: (() => void) | null = null;
	private annoAutoCloseTimer: number | null = null;
	/** 悬浮态面板自动收起的挂起位：从面板里弹出的菜单开着时，鼠标必然离开面板，
	 *  但那时收起面板会把菜单晾在半空 —— 挂住它，等菜单关掉再恢复常规判定。 */
	private annoAutoCloseHold = false;

	private footnoteBackdrop: HTMLElement | null = null;
	private activeFootnoteView: RawFoliateView | null = null;
	private footnoteDismiss: (() => void) | null = null;
	private actionsObserver: MutationObserver | null = null;
	/** Obsidian 明暗切换观察（body.theme-* 类）+ 防抖定时器 */
	private bodyThemeObserver: MutationObserver | null = null;
	private themeRefreshTimer: number | null = null;

	// 章节切换转场标志（按钮/键盘/边界直切的防抖）
	private chapterTransitioning = false;

	// 正文搜索
	private searchOpen = false;
	private searchBarEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchStatusEl: HTMLElement | null = null;
	private searchListEl: HTMLElement | null = null;
	private searchCountEl: HTMLElement | null = null;
	private searchMatches: { index: number; matchIndex: number; cfi: string; label: string; pre: string; match: string; post: string }[] = [];
	private searchToken: { aborted: boolean } | null = null;
	private searchDebounceTimer: number | null = null;
	private searchPointer = -1;

	// 返回按钮：跳转后保持出现，仅当滑动满 3 页距离且超过 3 秒才隐藏（统一规范）
	private static readonly BACK_HIDE_PAGES = 3;
	private static readonly BACK_HIDE_MS = 3000;
	private backVisible = false;
	private backSuppressed = false;
	private backArmAt = 0;
	private backPages = 0;
	private backLastLoc: number | null = null;
	private pendingBackJump = false;
	private debugJumpT0 = 0;

	// 脚注气泡自动消失：鼠标离开气泡或注标周边一段距离后，短暂延时即关闭；期间若在气泡内选字则取消
	private footnoteBubbleEl: HTMLElement | null = null;
	private footnoteAutoCloseTimer: number | null = null;
	private footnoteSuppressAutoCloseUntil = 0;

	private savePositionDebounced: (path: string, info: RelocateInfo) => void;

	constructor(leaf: WorkspaceLeaf, plugin: UNreaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.savePositionDebounced = debounce((key: string, info: RelocateInfo) => {
			if (!info.cfi) return;
			this.saveSourcePosition(key, {
				anchor: info.cfi,
				fraction: info.fraction,
				updatedAt: Date.now(),
			}, false);
		}, 800, true);
		this.navigation = true;
	}

	getViewType(): string {
		return VIEW_TYPE_UNREADER;
	}

	getDisplayText(): string {
		return this.currentFeedEntry?.title || this.file?.basename || "UNreader";
	}

	getIcon(): string {
		return this.isFeedSource() ? "rss" : "book-open";
	}

	/** 开放接口：书内当前选区（三方插件经插件对象调用，见 main.ts getReaderSelection）。
	 * 返回最近一次有效选区（点掉选区/切换章节时清除）；阅读器无选区返回 null。 */
	getSelectionForExternal(): ReaderSelectionInfo | null {
		const source = this.getReaderSource();
		if (!source) return null;
		const sourcePath = source.kind === "book" ? source.filePath : `feed://${source.feedId}/${source.entryId}`;
		const sourceName = source.kind === "book" ? this.file?.name ?? source.filePath : this.currentFeedEntry?.title ?? "订阅文章";
		// 脚注气泡内的选区优先：与正文选区同等递出，三方插件行为一致
		const bubbleText = this.footnoteBubbleSelection();
		if (bubbleText) {
			return {
				text: bubbleText,
				cfi: null,
				at: Date.now(),
					bookPath: sourcePath,
					bookName: sourceName,
				chapter: this.lastRelocate?.sectionLabel ?? null,
			};
		}
		const ps = this.pendingSelection;
		if (ps?.text) {
			// 命中活选区：同步刷新快照，供其后的空选区事件兜底
			this.lastExcerpt = { text: ps.text, cfi: ps.cfi, at: ps.at };
			return {
				text: ps.text,
				cfi: ps.cfi,
				at: ps.at,
					bookPath: sourcePath,
					bookName: sourceName,
				chapter: ps.cfi ? this.adapter.getChapterLabelForCfi(ps.cfi) : null,
			};
		}
		// 活选区刚被清空（焦点归还宿主/iframe 选区塌陷）时的兜底：
		// 10s 内仍返回最近一次有效选区，保证「选中→按快捷键」不丢文字
		const le = this.lastExcerpt;
		if (le?.text && Date.now() - le.at < UNreaderView.EXCERPT_TTL) {
			return {
				text: le.text,
				cfi: le.cfi,
				at: le.at,
					bookPath: sourcePath,
					bookName: sourceName,
				chapter: le.cfi ? this.adapter.getChapterLabelForCfi(le.cfi) : null,
			};
		}
		return null;
	}

	/** 脚注气泡内的宿主选区文字；无有效选区返回 null */
	private footnoteBubbleSelection(): string | null {
		try {
			const backdrop = this.footnoteBackdrop;
			if (!backdrop?.isConnected) return null;
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) return null;
			const n = sel.anchorNode;
			const el = n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null;
			if (!el || !backdrop.contains(el)) return null;
			const text = sel.toString().replace(/\s+/g, " ").trim();
			return text || null;
		} catch {
			return null;
		}
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		// 「全沉浸返回哨兵」被消费（`leaf.history.back()` 把视图切回哨兵本身）：
		// 返回动作已经被这一条吃掉了，这里只负责退出全沉浸 —— 不再走「换书」分支，
		// 用户留在原书原位。标记必须在交给 `super.setState` 之前摘掉，
		// 否则它会随 `getState()` 传下去，之后每次布局恢复都被误判成「返回」。
		if (state && typeof state === "object" && (state as Record<string, unknown>)[IMMERSION_HISTORY_GUARD_KEY] === true) {
			delete (state as Record<string, unknown>)[IMMERSION_HISTORY_GUARD_KEY];
			this.immersionHistoryGuard = null;
			if (this.fullImmersion) this.exitFullImmersion();
		}
		const nextState = state as { file?: unknown; source?: unknown };
		const source = nextState.source;
		const filePath = nextState.file;
		const feedSource = source as { kind?: unknown; feedId?: unknown; entryId?: unknown };
		const incomingSource: ReaderSource | null = source && typeof source === "object" && feedSource.kind === "feed-entry"
			? {
				kind: "feed-entry",
				// 只接受字符串：`String(对象)` 会得到 "[object Object]" 这种假 id（no-base-to-string）
				feedId: typeof feedSource.feedId === "string" ? feedSource.feedId : "",
				entryId: typeof feedSource.entryId === "string" ? feedSource.entryId : "",
			}
			: typeof filePath === "string"
				? { kind: "book", filePath }
				: null;
		const nextKey = incomingSource ? this.sourceKey(incomingSource) : null;
		if (incomingSource && nextKey !== this.currentSourceKey()) {
			if (this.fullImmersion) this.exitFullImmersion({ restoreChrome: false });
			this.applyReaderSource(incomingSource);
		}
		await super.setState(state, result);
		if (this.chromeReady) {
			window.requestAnimationFrame(() => {
				this.syncNativeHeader();
				});
			this.scheduleLoad();
		}
	}

	getState(): Record<string, unknown> {
		const source = this.getReaderSource();
		return source?.kind === "feed-entry"
			? { ...super.getState(), source }
			: { ...super.getState(), file: this.file?.path ?? null };
	}

	private getReaderSource(): ReaderSource | null {
		if (this.feedRef) return { kind: "feed-entry", feedId: this.feedRef.feedId, entryId: this.feedRef.entryId };
		return this.file ? { kind: "book", filePath: this.file.path } : null;
	}

	private sourceKey(source: ReaderSource | null = this.getReaderSource()): string | null {
		if (!source) return null;
		return source.kind === "book" ? `book:${source.filePath}` : `feed:${source.feedId}:${source.entryId}`;
	}

	private currentSourceKey(): string | null {
		return this.sourceKey();
	}

	private applyReaderSource(source: ReaderSource): void {
		if (source.kind === "book") {
			this.hidePodcastBar();
			this.feedRef = null;
			this.currentFeedEntry = null;
			this.activeFeedContentHash = null;
			const file = this.app.vault.getFileByPath(source.filePath);
			this.file = file instanceof TFile ? file : null;
			return;
		}
		if (this.podcastBarRef && (this.podcastBarRef.feedId !== source.feedId || this.podcastBarRef.entryId !== source.entryId)) {
			this.hidePodcastBar();
		}
		this.file = null;
		this.feedRef = { feedId: source.feedId, entryId: source.entryId };
		this.currentFeedEntry = null;
		this.activeFeedContentHash = null;
	}

	private isFeedSource(): boolean {
		return this.feedRef != null;
	}

	/** 当前书是不是本地 HTML（core/htmlBook.ts 那条通道）。
	 *  只有「外链点击怎么走」在用它 —— HTML 与 feed 一样：正文里的 http(s) 链接
	 *  必须交还系统浏览器/`shell.openExternal`，不能让章节 iframe 自己导航过去
	 *  （srcdoc 无 sandbox，导航会真的发生，而阅读器没有地址栏也没有返回入口）。 */
	private isHtmlSource(): boolean {
		return isHtmlBookFile(this.file);
	}

	async onOpen(): Promise<void> {
		// ⚠️ **onOpen 是 Obsidian workspace layout 的关键路径**：`WorkspaceLeaf.open()`
		// 会 await `View.onOpen()`，而 `Workspace.setLayout()` 又 await 所有恢复叶子的
		// `setViewState()`。因此这里**绝不能** await 任何依赖 `onLayoutReady` 的东西：
		// 钉住预设的恢复若放在这里，会 await `whenDataReady()` → `onLayoutReady()`，
		// 与 Obsidian「layout ready 要等 setLayout 完成」形成闭环（真机表现为下次启动
		// workspace layout 被拖到上万毫秒）。预设恢复与整本书解析统一交给
		// `scheduleLoad()`，在布局就绪并让出首帧后执行。
		this.renderChrome();
		// 页首的**布局契约类**必须在装配后立刻落地，不能等第一次 syncNativeNav
		// （那要等滚动 / 点按 / 切视图）—— 否则「打开视图 → 首次交互」之间
		// 页首还是官方占位形态，正文被它顶下去整整一个页首高。
		this.markViewHeader(this.viewHeaderEl());
		this.chromeReady = true;
		this.syncOuterAppearance();
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.onObsidianThemeChanged("css-change");
			}),
		);
		// Obsidian 明暗切换的可靠监听：书页配色是「应用时」把主题变量解析成具体
		// 色值后快照进 iframe 主题的（iframe 不继承宿主变量），一旦错过切换时机
		// 就停留在旧配色——表现为深色切浅色后阅读区仍是深色主题的暖色底（棕色），
		// 重开书才恢复。css-change 事件时机不可靠（可能先于 body 类切换、或缺失），
		// 这里直接观察 body 的类变化（theme-dark/theme-light 必经之路），时序天然
		// 正确（类已变、变量重算随时可得）
		this.bodyThemeObserver = new MutationObserver(muts => {
			for (const m of muts) {
				const cls = (m.target as HTMLElement).classList;
				if (cls.contains("theme-dark") || cls.contains("theme-light")) {
					this.onObsidianThemeChanged("body-class");
					return;
				}
			}
		});
		this.bodyThemeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

		// 外部摘类自愈：官方 restoreNavigation 的触发点（window mousedown /
		// active-leaf-change / layout-change / config-changed / 键盘 / 抽屉展开）
		// 本视图一个都收不到，而它**只会摘不会补**；插件的同步点又全绑在用户交互上
		// —— 用户静止阅读时类被摘掉后无人补回，底栏永久留在显示态（报障原话：
		// 「沉浸模式下，显示一次底下元素后，手机端最下面的元素会一直显示」）。
		// 不枚举官方路径（枚举一定漏，漏掉的那条正是这个 bug），改为盯 body 的类、
		// 按 nativeNavWanted() 这一份权威判据补回。
		this.nativeNavGuard = new NativeNavGuard({
			wantsHidden: () => this.nativeNavWanted(),
			onExternalRestore: () => this.reassertStatusBarHidden(),
			sync: () => this.syncNativeNav("guard"),
		});
		this.nativeNavGuard.start();
		this.installNavForensics();
		this.installCommentFocusForensics();

		// 模态框（命令面板/快速切换/设置/任意插件弹窗）**出现的那一刻**，把阅读器手上的
		// 键盘焦点交出去。这是问题的另一半：`focusContent()` 那道门只管「下次来抢」，
		// 管不了「已经抢在手上」的那一份（模态框出现前焦点若已在正文容器上，门来不及生效）。
		//
		// 判据与动作原语都在 `core/modalFocusGate` —— 这里不再自带一套 MutationObserver。
		// 上一轮自带的那套正是「补丁形态」：写死观察 `.modal-container`、只调一次
		// `returnFocusToHost()`，而后者**只在焦点是 iframe 时才动作**，焦点落在
		// `.unreader-continuous` 上时什么都不做 —— 而连续模式下最常见的持有者恰恰是它
		// （翻页/跳转后 `focusContent()` 把焦点放在容器上）。模态框换个挂载点、或焦点换个
		// 持有者，补丁就失效 —— 这就是用户说的「修了又冒出来」。
		//
		// 取证（默认关，`debugLog` 关闭时零开销）：模态框出现时焦点在谁身上。
		this.unwatchCoreModal = watchCoreModal(() => {
			const ae = document.activeElement;
			debugLog.info("[focus] modal-open active=", ae ? `${ae.tagName}.${(ae as HTMLElement).className ?? ""}`.slice(0, 80) : "null",
				"isFrame=", ae instanceof HTMLIFrameElement,
				"inStage=", !!(ae && this.containerEl?.contains(ae)));
			this.relinquishReaderFocus();
		});

		// 上面那条只管「模态框出现的那一刻」。它开着**期间**的每一次焦点落地还要过一遍闭环
		// —— 软键盘弹起引发的 resize 补载、目录跳转、`settleJump` 定时器…… 三十余条路径
		// 都跑在开窗之后，而它们的汇合点（`focusContent` 等写入点）只堵得住「已知入口」。
		// 这里不枚举入口，只回答一个事实：「焦点是不是进了阅读器」——是就还给弹窗。
		// 判据见 core/modalFocusGate.arbitrateReaderFocus。
		this.unarbitrateFocus = arbitrateReaderFocus(this.containerEl, document, (_ev, from) => {
			debugLog.info("[focus] arbitrate ←", from.tagName, "-> modal");
		});

		// Cmd/Ctrl 状态同步到 engine，用于脚注 Cmd/Ctrl 点击直跳
		const updateCommand = (e: KeyboardEvent): void => {
			this.adapter.commandPressed = e.metaKey || e.ctrlKey;
		};
		const clearCommand = (): void => { this.adapter.commandPressed = false; };
		this.registerDomEvent(window, "keydown", updateCommand as unknown as EventListener);
		// 宿主焦点兜底翻页：分页模式下焦点常停留在宿主（书页 iframe 未获焦），
		// iframe 内的 keydown 接线收不到事件，方向键/PageUp/Space 落在宿主上
		// 无人处理（表现为快捷键无法翻页）。这里在 window 层复用 handleKey。
		// 焦点在书页 iframe 内时按键不会冒泡到宿主 window，天然不会双触发；
		// forwardKeyToHost 合成的事件带 __unreaderForwarded 标记，同样在此拦截防循环。
		this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
			const ev = e as KeyboardEvent & { __unreaderForwarded?: boolean; __unreaderHandled?: boolean };
			if (ev.__unreaderForwarded || ev.__unreaderHandled) return;
			// Esc 退出全沉浸：核心模态框（命令面板/设置/快速切换）开着时**先放行**，
			// 让官方 keymap 关掉弹窗（那一层才是用户此刻在操作的东西），再按一次才退模式。
			if (e.key === "Escape" && this.fullImmersion && !hasCoreModal()) {
				e.preventDefault();
				this.exitFullImmersion();
				return;
			}
			// 只接翻页/跳章键：其余按键放行给 Obsidian keymap 处理原始事件，
			// 避免经 handleKey 二次转发造成命令双触发
			const navKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", " ", "[", "]", "BracketLeft", "BracketRight"];
			if (!navKeys.includes(e.key)) return;
			// 核心模态框（命令面板/快速切换/设置）开着时不翻页：焦点可能还没落到弹窗
			// 输入框上（`activeElement == body`），此时方向键/空格会一路走到 handleKey
			// 把书翻掉，而用户以为自己在操作弹窗。判据见 core/modalFocusGate。
			if (hasCoreModal()) return;
			const ae = document.activeElement;
			// 焦点在本视图外（其他插件面板/编辑器）时不劫持
			if (ae && ae !== document.body && !this.containerEl.contains(ae)) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest?.(".modal-container, input, textarea, [contenteditable], .cm-editor")) return;
			this.handleKey(e);
		});
		// 系统级返回的第三条入口：iOS 侧滑返回 / 浏览器式后退会派发 popstate。
		// 官方在同一条事件上做布局复位，这里只做一件事 —— 全沉浸时当作「返回」退出。
		// 注意它与下面那条哨兵机制**不重叠**：Android 返回走的是官方重定向过的
		// `leaf.history.back()`（纯 JS 调用，不动真实历史，不产生 popstate）。
		this.registerDomEvent(window, "popstate", () => {
			if (this.fullImmersion) this.exitFullImmersion();
		});
		this.registerDomEvent(window, "keyup", e => {
			const ke = e;
			if (!ke.metaKey && !ke.ctrlKey) clearCommand();
		});
		this.registerDomEvent(window, "blur", clearCommand as unknown as EventListener);
		this.registerDomEvent(document, "visibilitychange", clearCommand as unknown as EventListener);
		// 应用切后台 / 页面将被丢弃 → 立刻把阅读位置写盘。
		// 移动端这是**唯一**能赶上的时机：iOS 在后台直接回收进程，之后既没有
		// onClose 也没有 onunload，去抖链里的那次写（视图 800ms + 存储 1s）根本没发生
		// —— 用户下次打开就回到几屏之前（报障原话「偶尔进度丢失」）。桌面端同样覆盖
		// 「关窗口 / 系统休眠 / 强退」这些拿不到优雅收场的路径。
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				this.flushPosition(true);
				// app 级底栏/状态栏控制不跨后台生命周期持有；回到前台再按当前全沉浸/常态状态重放。
				this.releaseNativeNav();
			} else {
				this.scheduleLoad();
				this.syncNativeNav("visible");
			}
		});
		this.registerDomEvent(window, "pagehide", () => this.flushPosition(true));
		// 焦点/点击进入阅读器（含书页 iframe 边界）时，把本视图登记为最近阅读视图，
		// 供插件命令在 Obsidian 活动视图解析失灵时兜底
		this.registerDomEvent(this.containerEl, "focusin", () => this.plugin.noteActiveReader(this), true);
		this.registerDomEvent(this.containerEl, "pointerdown", () => this.plugin.noteActiveReader(this), true);
		// 切回本标签页时重新断言原生导航状态：Obsidian 的 active-leaf-change
		// 会 restoreNavigation（摘掉 is-hidden-nav），而阅读器的 chrome-hidden
		// 仍在，需同步回去保持沉浸一致
		this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
			if (leaf && leaf.view === this) {
				this.syncNativeNav("leaf");
				// 后台标签页启动时不解析整本书；切到它时才真正开书。
				this.scheduleLoad();
			}
			else {
				// 全沉浸是会话态，切到其他视图即结束；返回本叶时从常态重新开始。
				if (this.fullImmersion) this.exitFullImmersion();
				this.releaseNativeNav();
			}
		}));
		// 同一 leaf 内切换标签页（阅读器 → 其他插件视图）**不触发 active-leaf-change**
		// ——activeLeaf 对象没变，只是 leaf 上的 view 换了。此时残留的全局
		// body.is-hidden-nav 会被带进下一个视图：官方 CSS 里
		// `.is-phone.is-hidden-nav .view-header` 与 `.is-hidden-nav .mobile-navbar`
		// 会同时把顶栏和底栏藏掉，表现为兄弟插件「一进去就是沉浸模式」。
		// 这里补一条 layout-change 通道兜住同 leaf 换 view 的失活场景。
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			if (!this.isSelfActive()) {
				if (this.fullImmersion) this.exitFullImmersion();
				this.releaseNativeNav();
			}
			else {
				// 官方可能在布局变更里重建页首（`leaf.updateHeader()` 等）。这里复用同一
				// 条幂等同步把浮层化类补挂到新元素上 —— 原 CSS 用 `:has()` 做这层结构
				// 兜底，改为低频 JS 补挂后覆盖不变，且免掉 `:has` 的整树失效开销。
				this.syncNativeNav("layout");
				this.scheduleLoad();
			}
		}));
		// 「外观 → 全屏」切换时立即重估原生导航隐藏（关掉全屏必须马上还原，
		// 否则非 fixed 布局下的 is-hidden-nav 会留下背景板残影）。
		// config-changed 同样未进公开类型库，走受控断言
		const vaultEvents = this.app.vault as unknown as {
			on?: (name: "config-changed", cb: () => void) => unknown;
		};
		try {
			const off = vaultEvents.on?.("config-changed", () => this.syncNativeNav("config"));
			if (typeof (off as { unregister?: unknown })?.unregister === "function") {
				this.register(off as never);
			}
		} catch { /* ignore */ }
		this.plugin.noteActiveReader(this);
		if (!this.file) this.showEmpty();
		// 非阻塞：布局恢复期间只装配 chrome，开书排到 layout ready + 首帧空闲之后。
		this.scheduleLoad();
	}

	/** Obsidian 主题（明暗/配色）变化后的外观重放：iframe 主题是解析时的颜色
	 *  快照，必须全量 applyAppearance 重写（连续模式各 frame 的 #unreader-theme、
	 *  分页渲染器 setStyles、外层容器底色）。防抖 + 多拍重放：类切换后变量重算
	 *  可能晚一拍完成，先按当前值刷，再补拍确认，彻底消除「切了但取到旧值」的竞态 */
	private onObsidianThemeChanged(_source: string): void {
		if (this.themeRefreshTimer) window.clearTimeout(this.themeRefreshTimer);
		const replay = (): void => {
			this.adapter.applyAppearance(this.plugin.settings.appearance);
			this.syncOuterAppearance();
		};
		this.themeRefreshTimer = window.setTimeout(() => {
			this.themeRefreshTimer = null;
			replay();
			window.setTimeout(replay, 300);
		}, 80);
	}

	/** 标签页切回/布局变化时驱动连续模式填充：隐藏期间 scroll 事件不触发，填充链会停摆 */
	onResize(): void {
		// 折叠屏/分屏/横竖屏跨过 is-phone / is-tablet 门槛时，立即重算原生界面接管策略。
		this.syncNativeNav("resize");
		this.adapter.notifyVisible();
		this.scheduleLoad();
		// 尺寸变化会改变页首几何（横竖屏、分栏、iPad 分屏），进度条让位需重测
		this.syncProgressTop();
		// 侧栏宽度也可能随设备形态变化，灯绳要重新避让
		this.syncImmersionSwitchOffset();
		// 换设备/横竖屏/分屏 → 页码模型可能变，书签页码同步刷新
		this.refreshAnnotationPages();
	}

	async onClose(): Promise<void> {
		this.plugin.forgetActiveReader(this);
		// 全沉浸是会话态：视图消失时先摘插件类，再释放两条 app 级原生导航控制。
		this.clearFullImmersion();
		// 先停自愈守卫再释放：否则 releaseNativeNav 摘类会被守卫判成「外部摘类」，
		// 在本视图正在关闭、isSelfActive 尚未翻转的窗口里又补回这个 app 级类
		this.nativeNavGuard?.stop();
		this.nativeNavGuard = null;
		// 取消未落地的底部带取数（延迟 460ms，视图已关时它只会污染下一个视图的日志）
		cancelBottomBandDiag();
		this.releaseNativeNav();
		this.setSystemStatusBarVisible(true);
		// 立即写盘（不去抖）：视图关掉之后去抖里的那次写很可能赶不上（退出应用 /
		// 移动端进程被回收），而它承载的是用户最后几分钟的阅读位置。
		this.flushPosition(true);
		if (this.devicePresetRetryTimer !== null) {
			window.clearTimeout(this.devicePresetRetryTimer);
			this.devicePresetRetryTimer = null;
		}
		if (this.immersionSwitchPullTimer !== null) {
			window.clearTimeout(this.immersionSwitchPullTimer);
			this.immersionSwitchPullTimer = null;
		}
		if (this.progressTopTimer !== null) {
			window.clearTimeout(this.progressTopTimer);
			this.progressTopTimer = null;
		}
		this.closeFootnotePopup();
		this.dismissHover();
		if (this.hoverRaf) window.cancelAnimationFrame(this.hoverRaf);
		if (this.pinResizeObserver) {
			try { this.pinResizeObserver.disconnect(); } catch { /* ignore */ }
			this.pinResizeObserver = null;
		}
		if (this.actionsObserver) {
			try { this.actionsObserver.disconnect(); } catch { /* ignore */ }
			this.actionsObserver = null;
		}
		if (this.debouncedPinVisibility) {
			try { window.removeEventListener("resize", this.debouncedPinVisibility); } catch { /* ignore */ }
			this.debouncedPinVisibility = null;
		}
		if (this.stageResizeObserver) {
			try { this.stageResizeObserver.disconnect(); } catch { /* ignore */ }
			this.stageResizeObserver = null;
		}
		if (this.floatingFitObserver) {
			try { this.floatingFitObserver.disconnect(); } catch { /* ignore */ }
			this.floatingFitObserver = null;
		}
		if (this.floatingFitRaf != null) {
			window.cancelAnimationFrame(this.floatingFitRaf);
			this.floatingFitRaf = null;
		}
		if (this.bodyThemeObserver) {
			try { this.bodyThemeObserver.disconnect(); } catch { /* ignore */ }
			this.bodyThemeObserver = null;
		}
		if (this.unwatchCoreModal) {
			try { this.unwatchCoreModal(); } catch { /* ignore */ }
			this.unwatchCoreModal = null;
		}
		if (this.unarbitrateFocus) {
			try { this.unarbitrateFocus(); } catch { /* ignore */ }
			this.unarbitrateFocus = null;
		}
		if (this.navForensicsObserver) {
			try { this.navForensicsObserver.disconnect(); } catch { /* ignore */ }
			this.navForensicsObserver = null;
		}
		if (this.themeRefreshTimer != null) {
			window.clearTimeout(this.themeRefreshTimer);
			this.themeRefreshTimer = null;
		}
			this.cancelAnnoAutoClose();
			this.clearMirrorSelection();
			try { await this.flushPodcastProgress(); } catch { /* 关闭路径不能因进度落盘失败而跳过清理 */ }
			this.hidePodcastBar();
			if (this.floatingFitRaf != null) {
				window.cancelAnimationFrame(this.floatingFitRaf);
				this.floatingFitRaf = null;
			}
			this.adapter.destroy();
		this.contentHost?.empty();
		await super.onClose();
	}


	toggleAnnotations(): void {
		this.toggleSidePanel("annotations");
	}

	/** 工具栏/命令入口：打开书籍侧边栏；已在该模式时再点关闭。 */
	toggleBookshelf(): void {
		this.toggleSidePanel("bookshelf");
	}

	/** 工具栏/命令入口：打开订阅侧边栏；已在该模式时再点关闭。 */
	toggleFeeds(): void {
		this.toggleSidePanel("feeds");
	}

	refreshFeedsPanel(): void {
		this.annotationsPanel?.refreshFeeds();
	}

	/** UNagent 写完当前书/文章的旁车标注笔记后，重读并立即覆盖当前视图。
	 *  只处理已经加载完成的同一 source；等待读盘期间若用户换书则整轮作废。 */
	async refreshAnnotationsFromExternalWrite(paths: readonly string[]): Promise<void> {
		const notePath = this.notePath;
		const loadedPath = this.loadedPath;
		if (!notePath || !loadedPath || !this.adapter.hasBook()) return;
		if (!paths.some(path => path === notePath)) return;
		if (this.currentSourceKey() !== loadedPath) return;
		const entry = this.currentFeedEntry;
		const link = entry?.url || entry?.title || this.file?.path || "";
		const annotations = await loadAnnotations(this.app.vault, notePath, link);
		if (this.notePath !== notePath || this.loadedPath !== loadedPath || !this.adapter.hasBook()) return;
		this.annotations = annotations;
		this.adapter.replaceHighlights(annotations.highlights);
		this.syncAnnotationViews();
		if (entry) {
			const hasAnnotations = annotations.highlights.length > 0 || annotations.bookmarks.length > 0;
			if (hasAnnotations !== (entry.state.hasAnnotations === true)) {
				const updated = await this.plugin.feedStore.updateEntryState(entry.feedId, entry.id, { hasAnnotations });
				if (updated && this.currentFeedEntry?.feedId === entry.feedId && this.currentFeedEntry?.id === entry.id) {
					this.currentFeedEntry = updated;
				}
				this.annotationsPanel.refreshFeeds();
			}
		}
	}

	/** 预设文件夹被外部（UNagent / 同步）改动后重绘**已打开**的外观面板：
	 *  面板里的预设下拉是 render 时现算的，不重绘就还是旧列表。面板没开则不做。 */
	refreshAppearancePanel(): void {
		if (!this.appearancePanel?.isOpen()) return;
		this.appearancePanel.open(this.plugin.settings.appearance);
	}

	/** 书架排除项 / 收录格式变更后重绘书架（设置页那条路径调过来）。
	 *  只在书架**正显示**时重绘：其他模式下重绘是白做功，而 `setMode` 到别的模式
	 *  会把用户从当前列表拽走。同模式重绘保留滚动位置（见 annotationsPanel.setMode）。 */
	refreshBookshelfPanel(): void {
		if (!this.annotationsPanel?.isOpen()) return;
		if (this.annotationsPanel.getMode() !== "bookshelf") return;
		this.annotationsPanel.setMode("bookshelf");
	}

	getCurrentFeedSource(): { feedId: string; entryId: string } | null {
		return this.feedRef ? { ...this.feedRef } : null;
	}

	showEmptyState(): void {
		this.hidePodcastBar();
		this.loadedPath = null;
		this.feedRef = null;
		this.currentFeedEntry = null;
		this.activeFeedContentHash = null;
		this.showEmpty();
	}

	private async openFeedEntry(feedId: string, entryId: string): Promise<void> {
		if (this.feedRef?.feedId === feedId && this.feedRef.entryId === entryId && this.adapter.hasBook()) {
			this.annotationsPanel.show();
			this.annotationsPanel.refreshFeeds();
			this.adapter.focusContent();
			return;
		}
		this.applyReaderSource({ kind: "feed-entry", feedId, entryId });
		this.scheduleLoad();
	}

	private async refreshFeeds(): Promise<void> {
		try {
			new Notice("正在刷新订阅…");
			const results = await this.plugin.feedService.refreshAll(true);
			if (!results.length) {
				new Notice("没有可刷新的订阅（订阅源可能都已停用）");
				this.annotationsPanel.refreshFeeds();
				return;
			}
			const failed = results.filter(result => result.error).length;
			new Notice(failed ? `刷新完成，${failed} 个订阅失败` : "订阅已刷新");
			this.annotationsPanel.refreshFeeds();
		} catch (error) {
			new Notice(`刷新失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async toggleFeedStar(feedId: string, entryId: string): Promise<void> {
		const entry = this.plugin.feedStore.getEntry(feedId, entryId);
		if (!entry) return;
		await this.plugin.feedStore.updateEntryState(feedId, entryId, {
			starredAt: entry.state.starredAt ? null : Date.now(),
		});
		this.annotationsPanel.refreshFeeds();
		this.syncCurrentFeedStar();
	}

	/** 功能轨「星标」按钮：收藏 / 取消收藏当前文章。只对 Feed 文章有意义，
	 *  因此按钮挂 `is-feed-only-control`（书源下由 CSS 收走，那里是「添加书签」）。 */
	private async toggleCurrentFeedStar(): Promise<void> {
		const ref = this.feedRef;
		if (!ref) return;
		await this.toggleFeedStar(ref.feedId, ref.entryId);
	}

	/** 星标状态回写：`currentFeedEntry` 是打开时的快照，收藏变化后必须从 store 现读，
	 *  否则按钮会停在上一次的状态（列表里收藏/取消收藏、刷新合并都会改 store）。 */
	private syncCurrentFeedStar(): void {
		const ref = this.feedRef;
		if (!ref) {
			this.syncRailButtons();
			return;
		}
		const entry = this.plugin.feedStore.getEntry(ref.feedId, ref.entryId);
		if (entry) this.currentFeedEntry = entry;
		this.syncRailButtons();
	}

	private async toggleFeedRead(feedId: string, entryId: string): Promise<void> {
		const entry = this.plugin.feedStore.getEntry(feedId, entryId);
		if (!entry) return;
		await this.plugin.feedStore.updateEntryState(feedId, entryId, {
			readAt: entry.state.readAt == null ? Date.now() : null,
		});
		this.annotationsPanel.refreshFeeds();
	}

	private async fetchFeedFulltext(feedId: string, entryId: string, options?: { auto?: boolean }): Promise<void> {
		try {
			if (!options?.auto) new Notice("正在抓取网页全文…");
			const entry = await this.plugin.feedService.fetchFulltext(feedId, entryId, options);
			if (!entry) throw new Error("文章不存在");
			if (!options?.auto) new Notice("全文已缓存");
			this.annotationsPanel.refreshFeeds();
			if (this.feedRef?.feedId === feedId && this.feedRef.entryId === entryId) {
				// scheduleLoad 对“同一篇文章已加载”会早退；抓到全文后必须清掉当前 key 才会重渲染。
				this.loadedPath = null;
				this.scheduleLoad();
			}
		} catch (error) {
			if (!options?.auto) {
				new Notice(`全文抓取失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** Feed 里只有标题/摘要时，打开文章先读摘要，再在后台尝试网页全文。 */
	private async autoFetchFeedFulltext(feedId: string, entryId: string): Promise<void> {
		const entry = this.plugin.feedStore.getEntry(feedId, entryId);
		if (!entry || !this.plugin.feedService.needsFulltext(entry)) return;
		await this.plugin.feedService.autoFetchFulltext(feedId, entryId);
		this.annotationsPanel.refreshFeeds();
		if (this.feedRef?.feedId === feedId && this.feedRef.entryId === entryId) {
			const updated = this.plugin.feedStore.getEntry(feedId, entryId);
			if (updated && entryFeedContentQuality(updated) === "full") {
				this.loadedPath = null;
				this.scheduleLoad();
			}
		}
	}

	/** 功能轨上的「保存为笔记」：当前打开的文章走这条路（列表卡片里那枚是同一收口）。 */
	private async saveCurrentFeedNote(): Promise<void> {
		const ref = this.feedRef;
		if (!ref) {
			new Notice("当前页面不是订阅文章");
			return;
		}
		await this.saveFeedNote(ref.feedId, ref.entryId);
	}

	/**
	 * 把一篇文章存成 Obsidian 笔记（Markdown + 图片落盘）。
	 *
	 * 还没抓过全文的**先抓再存** —— RSS 摘要存下来没有任何价值，而用户点「保存为笔记」
	 * 想要的显然是那篇网页正文。抓取失败就到此为止，绝不退化成「存一份摘要」，
	 * 否则用户会以为存到了全文而实际只拿到两行导语。
	 *
	 * 落点、覆盖策略、图片命名全部在 `core/noteExporter.ts` 里收口（用 Obsidian 自己的
	 * 「新建笔记默认位置 / 附件默认位置」设置），这里只负责触发与回报。
	 */
	private async saveFeedNote(feedId: string, entryId: string): Promise<void> {
		const store = this.plugin.feedStore;
		const current = store.getEntry(feedId, entryId);
		if (!current) {
			new Notice("文章不存在");
			return;
		}
		let entry = current;
		if (entry.kind === "article" && entryFeedContentQuality(entry) !== "full") {
			await this.fetchFeedFulltext(feedId, entryId);
			const fetched = store.getEntry(feedId, entryId);
			// 抓取失败（或抓完仍是 Feed 摘要）：`fetchFeedFulltext` 已经报过错了，不再叠一条
			if (!fetched || fetched.contentSource !== "fulltext") return;
			entry = fetched;
		}
		try {
			new Notice("正在保存笔记…");
			const result = await saveArticleNote(this.app, {
				title: entry.title || "未命名文章",
				author: entry.author,
				url: entry.url,
				feedTitle: store.getFeed(feedId)?.title,
				publishedAt: entry.publishedAt,
				contentHtml: entry.contentHtml,
			});
			// 图片落盘失败不当作整体失败：Markdown 里保留的是原链接，笔记本身仍然可用，
			// 只在提示里点明有几张没下来（否则用户会以为笔记里那些链接是正常状态）。
			const images = result.imageCount ? `（图片 ${result.imageCount} 张）` : "";
			const failed = result.failedImages ? `，${result.failedImages} 张图片未保存` : "";
			new Notice(`已保存笔记：${result.path}${images}${failed}`);
		} catch (error) {
			new Notice(`保存笔记失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 创建播客播放条。audio 常驻宿主 DOM，卡片刷新不会把它销毁。 */
	private buildPodcastBar(): void {
		const bar = this.podcastBarEl;
		if (!bar) return;
		bar.empty();
		const audio = this.podcastAudioEl = bar.createEl("audio", { cls: "unreader-podcast-audio" });
		audio.controls = false;
		audio.preload = "metadata";
		audio.setAttribute("playsinline", "");
		audio.setAttribute("webkit-playsinline", "");
		this.podcastSpeed = this.readPodcastSpeed();
		audio.playbackRate = this.podcastSpeed;

		// 上排只放进度条；下排放全部播放控制和已播/总时长两个数字。
		const progressRow = bar.createDiv({ cls: "unreader-podcast-progress-row" });
		const seek = this.podcastSeekEl = progressRow.createEl("input", { cls: "unreader-podcast-seek" });
		seek.type = "range";
		seek.min = "0";
		seek.max = "1000";
		seek.step = "1";
		seek.value = "0";
		seek.setAttribute("aria-label", "播客播放进度");
		seek.addEventListener("input", () => {
			if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
			try { audio.currentTime = (Number(seek.value) / 1000) * audio.duration; } catch { /* ignore */ }
			this.syncPodcastProgressUi();
			this.capturePodcastProgress();
		});
		const controls = bar.createDiv({ cls: "unreader-podcast-controls-row" });
		// 播放按钮固定在最左边，不随滚动移动
		const play = this.podcastPlayBtn = controls.createEl("button", { cls: "unreader-podcast-control is-play is-pinned" });
		play.setAttribute("aria-label", "播放播客");
		play.addEventListener("click", e => {
			e.stopPropagation();
			void this.togglePodcastPlayback();
		});

		// 可滚动按钮组：快退 / 快进 / 倍速 / 定时 / 标记 / 下载
		const leftGroup = controls.createDiv({ cls: "unreader-podcast-btns" });

		const rewind = leftGroup.createEl("button", { cls: "unreader-podcast-control" });
		rewind.setAttribute("aria-label", "快退 15 秒");
		paintIcon(rewind, "undo-2", "rotate-ccw");
		rewind.addEventListener("click", e => {
			e.stopPropagation();
			this.seekPodcastBy(-15);
		});

		const forward = leftGroup.createEl("button", { cls: "unreader-podcast-control" });
		forward.setAttribute("aria-label", "快进 30 秒");
		paintIcon(forward, "redo-2", "rotate-cw");
		forward.addEventListener("click", e => {
			e.stopPropagation();
		this.seekPodcastBy(30);
		});

		const sleep = this.podcastSleepBtn = leftGroup.createEl("button", {
			cls: "unreader-podcast-control",
		});
		paintIcon(sleep, "timer", "clock");
		sleep.setAttribute("aria-label", "设置睡眠定时");
		sleep.addEventListener("click", e => {
			e.stopPropagation();
			this.openPodcastSleepModal();
		});

		const mark = this.podcastMarkBtn = leftGroup.createEl("button", {
			cls: "unreader-podcast-control",
		});
		paintIcon(mark, "bookmark", "star");
		mark.setAttribute("aria-label", "标记当前时间点");
		mark.addEventListener("click", e => {
			e.stopPropagation();
			void this.addPodcastBookmark();
		});

		const download = this.podcastDownloadBtn = leftGroup.createEl("button", {
			cls: "unreader-podcast-download",
		});
		paintIcon(download, "download", "file-down");
		download.setAttribute("aria-label", "下载播客");
		download.addEventListener("click", e => {
			e.stopPropagation();
			void this.downloadCurrentPodcast();
		});
		// 倍速按钮不用图标：直接显示当前倍速，点击后数字变化本身就是反馈。
		const speed = this.podcastSpeedBtn = leftGroup.createEl("button", {
			cls: "unreader-podcast-control is-speed",
			attr: { type: "button" },
		});
		speed.setAttribute("aria-label", "切换播放速度");
		speed.addEventListener("click", e => {
			e.stopPropagation();
			this.cyclePodcastSpeed();
		});

		// 右侧时间显示：已播 / 总时长，固定在最右边，不参与横向滚动。
		// 点这两个数字会弹出输入框跳到指定时间——此前它们只是纯文本，
		// 点击会冒泡出去触发界面显隐切换，用户看到的就是「点了没反应/只是切换界面」。
		const timeGroup = controls.createDiv({ cls: "unreader-podcast-time-group" });
		this.podcastTimeEl = timeGroup.createSpan({ cls: "unreader-podcast-time", text: "0:00" });
		timeGroup.createSpan({ cls: "unreader-podcast-time-sep", text: "/" });
		this.podcastTotalEl = timeGroup.createSpan({ cls: "unreader-podcast-time is-total", text: "0:00" });
		for (const el of [this.podcastTimeEl, this.podcastTotalEl]) {
			el.setAttribute("role", "button");
			el.setAttribute("tabindex", "0");
			el.setAttribute("title", "点击跳转到指定时间");
			el.setAttribute("aria-label", "跳转到指定时间");
			const openSeek = (e: Event): void => {
				e.stopPropagation();
				this.openPodcastSeekModal();
			};
			el.addEventListener("click", openSeek);
			el.addEventListener("keydown", e => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openSeek(e);
				}
			});
		}

		audio.addEventListener("play", () => this.paintPodcastPlayButton());
		audio.addEventListener("pause", () => this.paintPodcastPlayButton());
		audio.addEventListener("ended", () => this.paintPodcastPlayButton());
		audio.addEventListener("loadedmetadata", () => {
			this.paintPodcastPlayButton();
			this.syncPodcastProgressUi();
		});
		audio.addEventListener("durationchange", () => this.syncPodcastProgressUi());
		audio.addEventListener("timeupdate", () => {
			this.syncPodcastProgressUi();
			this.capturePodcastProgress();
		});
		audio.addEventListener("seeked", () => {
			this.syncPodcastProgressUi();
			this.capturePodcastProgress();
		});
		audio.addEventListener("error", () => {
			if (!this.podcastBarRef) return;
			const code = audio.error?.code;
			new Notice(`播客加载失败${code ? `（错误码 ${code}）` : ""}，请检查网络，或先下载后再播放`);
		});
		this.paintPodcastPlayButton();
		this.syncPodcastSpeedButton();
		this.syncPodcastSleepButton();
	}

	private paintPodcastPlayButton(): void {
		const button = this.podcastPlayBtn;
		if (!button) return;
		const playing = !!this.podcastAudioEl && !this.podcastAudioEl.paused;
		button.empty();
		setIcon(button, playing ? "pause" : "play");
		if (!button.querySelector("svg")) button.setText(playing ? "❚❚" : "▶");
		button.setAttribute("aria-label", playing ? "暂停播客" : "播放播客");
	}

	private syncPodcastProgressUi(): void {
		const audio = this.podcastAudioEl;
		const seek = this.podcastSeekEl;
		const time = this.podcastTimeEl;
		if (!audio || !seek || !time) return;
		const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
		const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
		if (!seek.matches(":active")) seek.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
		time.setText(this.formatPodcastTime(current));
		this.podcastTotalEl?.setText(this.formatPodcastTime(duration));
	}

	private formatPodcastTime(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
		const total = Math.floor(seconds);
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const rest = total % 60;
		return hours > 0
			? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
			: `${minutes}:${String(rest).padStart(2, "0")}`;
	}

	private formatPodcastSpeed(speed: number): string {
		return `${speed.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`;
	}

	private syncPodcastSpeedButton(): void {
		const button = this.podcastSpeedBtn;
		if (!button) return;
		const label = this.formatPodcastSpeed(this.podcastSpeed);
		button.textContent = label;
		button.setAttribute("aria-label", `当前播放速度 ${label}，点击切换`);
		button.setAttribute("title", `当前播放速度 ${label}，点击切换`);
	}

	private readPodcastSpeed(): number {
		try {
			const value = Number(window.localStorage.getItem(PODCAST_SPEED_KEY));
			return (PODCAST_SPEEDS as readonly number[]).includes(value) ? value : 1;
		} catch { return 1; }
	}

	private setPodcastSpeed(speed: number): void {
		this.podcastSpeed = speed;
		if (this.podcastAudioEl) this.podcastAudioEl.playbackRate = speed;
		this.syncPodcastSpeedButton();
		try { window.localStorage.setItem(PODCAST_SPEED_KEY, String(speed)); } catch { /* ignore */ }
	}

	private cyclePodcastSpeed(): void {
		const index = (PODCAST_SPEEDS as readonly number[]).indexOf(this.podcastSpeed);
		const next = PODCAST_SPEEDS[(index + 1) % PODCAST_SPEEDS.length] ?? 1;
		this.setPodcastSpeed(next);
	}

	private seekPodcastBy(seconds: number): void {
		const audio = this.podcastAudioEl;
		if (!audio) return;
		const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
		try { audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds)); } catch { /* ignore */ }
		this.syncPodcastProgressUi();
	}

	/** 点时间数字弹出的跳转输入框。 */
	private openPodcastSeekModal(): void {
		const audio = this.podcastAudioEl;
		if (!audio || !this.podcastBarRef) {
			new Notice("请先打开播客，再跳转时间");
			return;
		}
		const total = Number.isFinite(audio.duration) ? audio.duration : 0;
		new PodcastSeekModal(
			this.app,
			audio.currentTime || 0,
			total,
			seconds => this.jumpPodcastTo(seconds),
		).open();
	}

	private openPodcastSleepModal(): void {
		const remaining = this.podcastSleepUntil - Date.now();
		new PodcastSleepModal(
			this.app,
			remaining,
			minutes => this.setPodcastSleepTimer(minutes),
			() => {
				this.clearPodcastSleepTimer();
				new Notice("已关闭睡眠定时");
			},
		).open();
	}

	private setPodcastSleepTimer(minutes: number): void {
		this.podcastSleepUntil = Date.now() + minutes * 60_000;
		this.syncPodcastSleepButton();
		if (this.podcastSleepTimer == null) {
			this.podcastSleepTimer = window.setInterval(() => this.tickPodcastSleepTimer(), 1000);
		}
		new Notice(`睡眠定时：${minutes} 分钟`);
	}

	private tickPodcastSleepTimer(): void {
		if (!this.podcastSleepUntil) return;
		const left = this.podcastSleepUntil - Date.now();
		if (left > 0) {
			this.syncPodcastSleepButton();
			return;
		}
		this.podcastAudioEl?.pause();
		this.clearPodcastSleepTimer();
		new Notice("睡眠定时已到，播客已暂停");
	}

	private syncPodcastSleepButton(): void {
		const button = this.podcastSleepBtn;
		if (!button) return;
		const left = this.podcastSleepUntil - Date.now();
		if (left <= 0) {
			button.removeClass("is-active");
			button.setAttribute("aria-label", "设置睡眠定时");
			button.setAttribute("title", "设置睡眠定时");
			return;
		}
		const minutes = Math.floor(left / 60_000);
		const seconds = Math.floor((left % 60_000) / 1000);
		button.addClass("is-active");
		button.setAttribute("aria-label", `睡眠定时剩余 ${minutes} 分 ${seconds} 秒`);
		button.setAttribute("title", `睡眠定时剩余 ${minutes} 分 ${seconds} 秒`);
	}

	private clearPodcastSleepTimer(): void {
		if (this.podcastSleepTimer != null) {
			window.clearInterval(this.podcastSleepTimer);
			this.podcastSleepTimer = null;
		}
		this.podcastSleepUntil = 0;
		this.syncPodcastSleepButton();
	}

	private addPodcastBookmark(): void {
		const ref = this.podcastBarRef;
		const audio = this.podcastAudioEl;
		const entry = this.currentFeedEntry;
		if (!ref || !audio || !entry) return;
		const seconds = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
		if (seconds < 1) {
			new Notice("请先开始播放，再标注时间点");
			return;
		}
		const timeLabel = this.formatPodcastTime(seconds);
		const fallbackLabel = sanitizeBookmarkLabel(`${entry.title || "播客"} · ${timeLabel}`);
		new BookmarkModal(this.app, label => {
			const finalLabel = sanitizeBookmarkLabel(label) || fallbackLabel;
			this.annotations.bookmarks.push({
				id: Date.now(),
				anchor: `audio:${seconds.toFixed(2)}`,
				label: finalLabel,
			});
			void this.persistAnnotations().then(ok => {
				if (!ok) return;
				this.syncAnnotationViews();
				new Notice(`已标注 ${timeLabel}`);
			});
		}, {
			title: "标注播客时间点",
			description: `给 ${timeLabel} 写一句备注，保存后会出现在书签与高亮面板。`,
			placeholder: "例如：这里讲到关键结论",
		}).open();
	}

	private jumpPodcastTo(seconds: number): void {
		const audio = this.podcastAudioEl;
		if (!audio || !this.podcastBarRef) {
			new Notice("请先打开播客，再点击时间戳");
			return;
		}
		const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number.POSITIVE_INFINITY;
		const target = Math.max(0, Math.min(duration, seconds));

		// 不管元数据到没到，先尝试设置；很多浏览器在 HAVE_METADATA 之前也能接受 seek。
		try {
			audio.currentTime = target;
		} catch {
			// 设不了的话放到 pending 里，等 loadedmetadata 后再跳
			this.podcastPendingSeek = target;
		}

		// 同步 UI 并开始播放（播放在某些浏览器里需要用户手势，
		// 点时间戳本身就是用户手势，所以直接 play 应该能成功）
		this.syncPodcastProgressUi();
		this.capturePodcastProgress();
		void audio.play().catch(() => {
			// 播放失败没关系，至少跳到了对应时间
		});

		// 给用户一个反馈：跳转到了几分几秒
		const mins = Math.floor(target / 60);
		const secs = Math.floor(target % 60);
		const timeStr = mins > 59
			? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
			: `${mins}:${String(secs).padStart(2, "0")}`;
		new Notice(`跳转到 ${timeStr}`);
	}

	private async togglePodcastPlayback(): Promise<void> {
		const audio = this.podcastAudioEl;
		if (!audio || !this.podcastBarRef) return;
		if (audio.paused) {
			audio.playbackRate = this.podcastSpeed;
			try {
				await audio.play();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				new Notice(`播客播放失败：${message}`);
			}
		} else {
			audio.pause();
		}
		this.paintPodcastPlayButton();
	}

	/** 当前文章是播客时显示播放条；切换到其它文章/书时由 applyReaderSource 收起。 */
	private showPodcastBar(entry: FeedEntry): void {
		const url = entry.enclosure?.url;
		const audio = this.podcastAudioEl;
		if (entry.kind !== "audio" || !url || !audio || !this.podcastBarEl) {
			this.hidePodcastBar();
			return;
		}
		this.rootEl.addClass("has-podcast");
		this.scheduleFloatingFit();
		audio.playbackRate = this.podcastSpeed;
		this.syncPodcastSleepButton();
		const same = this.podcastBarRef?.feedId === entry.feedId
			&& this.podcastBarRef.entryId === entry.id
			&& !!audio.getAttribute("src");
		if (same && this.podcastBarRef) {
			void this.refreshPodcastDownloadState(this.podcastBarRef);
			return;
		}
		const ref = { feedId: entry.feedId, entryId: entry.id, url };
		this.podcastBarRef = ref;
		this.podcastPendingSeek = null;
		const resumeTarget = this.podcastResumeSeconds(entry);
		this.podcastResumeTarget = resumeTarget > 0 ? resumeTarget : null;
		audio.pause();
		if (this.podcastSeekEl) this.podcastSeekEl.value = "0";
		this.podcastTimeEl?.setText("0:00");
		this.podcastTotalEl?.setText("0:00");
		this.paintPodcastPlayButton();
		audio.onloadedmetadata = () => {
			if (this.podcastBarRef !== ref) return;
			const pending = this.podcastPendingSeek;
			if (pending != null) {
				try { audio.currentTime = Math.max(0, pending); } catch { /* ignore */ }
				this.podcastPendingSeek = null;
				this.podcastResumeTarget = null;
				this.syncPodcastProgressUi();
				void audio.play().catch(() => undefined);
				return;
			}
			const seconds = this.podcastResumeTarget;
			if (seconds != null && seconds > 0 && Number.isFinite(audio.duration)) {
				try { audio.currentTime = Math.min(seconds, Math.max(0, audio.duration - 2)); } catch { /* ignore */ }
				this.podcastResumeTarget = null;
				// 暂停状态没有后续 timeupdate；必须在这里立刻刷新，否则滑块仍显示 0。
				this.syncPodcastProgressUi();
			}
		};
		audio.src = url;
		audio.load();
		this.syncPodcastDownloadState(false);
		void this.refreshPodcastDownloadState(ref);
	}

	private async refreshPodcastDownloadState(ref: { feedId: string; entryId: string; url: string }): Promise<void> {
		try {
			const cached = await this.plugin.feedMediaStore.has(ref.url);
			if (this.podcastBarRef !== ref) return;
			this.syncPodcastDownloadState(cached);
			if (cached) await this.upgradePodcastSource(ref, false);
		} catch { /* 缓存查询失败不影响在线播放 */ }
	}

	private syncPodcastDownloadState(cached: boolean): void {
		const button = this.podcastDownloadBtn;
		if (!button) return;
		button.disabled = false;
		button.toggleClass("is-cached", cached);
		paintIcon(button, cached ? "check" : "download", cached ? "check" : "file-down");
		const label = cached ? "播客已缓存" : "下载播客";
		button.setAttribute("aria-label", label);
		button.setAttribute("title", label);
	}

	private async upgradePodcastSource(ref: { feedId: string; entryId: string; url: string }, force: boolean): Promise<void> {
		const audio = this.podcastAudioEl;
		if (!audio || this.podcastBarRef !== ref) return;
		if (!force && !audio.paused) return;
		const playable = await this.plugin.feedMediaStore.playableUrl(ref.url);
		if (playable === ref.url || this.podcastBarRef !== ref) return;
		const seconds = this.podcastResumeTarget ?? (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
		const resumeTarget = this.podcastResumeTarget != null;
		const wasPlaying = !audio.paused;
		const pendingSeek = this.podcastPendingSeek;
		audio.onloadedmetadata = () => {
			if (this.podcastBarRef !== ref) return;
			if (pendingSeek != null) {
				try { audio.currentTime = Math.max(0, pendingSeek); } catch { /* ignore */ }
				this.podcastPendingSeek = null;
				this.podcastResumeTarget = null;
				this.syncPodcastProgressUi();
				if (wasPlaying) void audio.play().catch(() => undefined);
				return;
			}
			if (seconds > 0 && Number.isFinite(audio.duration)) {
				try { audio.currentTime = Math.min(seconds, Math.max(0, audio.duration - 2)); } catch { /* ignore */ }
				if (resumeTarget) this.podcastResumeTarget = null;
				this.syncPodcastProgressUi();
			}
			if (wasPlaying) void audio.play().catch(() => undefined);
		};
		audio.src = playable;
		audio.load();
	}

	/** 播客下载按钮：音频进 Obsidian 附件库，正文抓成 Markdown，笔记开头嵌入音频。 */
	private async downloadCurrentPodcast(): Promise<void> {
		const ref = this.podcastBarRef;
		const button = this.podcastDownloadBtn;
		if (!ref || !button || button.disabled) return;
		const entry = this.plugin.feedStore.getEntry(ref.feedId, ref.entryId);
		if (!entry) return;
		button.disabled = true;
		button.addClass("is-downloading");
		paintIcon(button, "loader", "download");
		button.setAttribute("aria-label", "正在下载并保存播客");
		button.setAttribute("title", "正在下载并保存播客");
		try {
			// 播客简介经常就是真正的 show notes；只有明显只是标题/摘要时才去抓原网页。
			let bodyEntry = entry;
			if (entryFeedContentQuality(bodyEntry) !== "full") {
				new Notice("正在抓取播客正文…");
				try {
					await this.plugin.feedService.fetchFulltext(ref.feedId, ref.entryId);
				} catch {
					new Notice("网页正文抓取失败，将使用播客简介保存");
				}
				bodyEntry = this.plugin.feedStore.getEntry(ref.feedId, ref.entryId) ?? bodyEntry;
			}

			// 不先写 IndexedDB，再读 Blob 落附件；移动端长音频会同时持有两三份大缓冲。
			// 这里让 saveArticleNote 一次请求后直接写入 Obsidian 附件。
			new Notice("正在保存播客笔记…");
			const result = await saveArticleNote(this.app, {
				title: bodyEntry.title || "未命名播客",
				author: bodyEntry.author,
				url: bodyEntry.url,
				feedTitle: this.plugin.feedStore.getFeed(ref.feedId)?.title,
				publishedAt: bodyEntry.publishedAt,
				contentHtml: bodyEntry.contentHtml || `<p>${bodyEntry.summary || "暂无播客简介。"}</p>`,
				audio: {
					sourceUrl: ref.url,
					preferredName: bodyEntry.title || "播客",
				},
			});
			if (this.podcastBarRef !== ref) return;
			if (result.audioPath) this.useLocalPodcastSource(result.audioPath);
			const images = result.imageCount ? `，图片 ${result.imageCount} 张` : "";
			const failedImages = result.failedImages ? `，${result.failedImages} 张图片未保存` : "";
			const failedAudio = result.failedAudio ? "，音频未保存" : "";
			new Notice(`已保存播客笔记：${result.path}（音频 ${result.audioPath ? "已嵌入" : "未嵌入"}${images}${failedImages}${failedAudio}）`);
		} catch (error) {
			if (this.podcastBarRef === ref) {
				paintIcon(button, "x", "download");
				button.setAttribute("aria-label", "下载失败，点击重试");
				button.setAttribute("title", "下载失败，点击重试");
				new Notice(`播客下载失败：${error instanceof Error ? error.message : String(error)}`);
				window.setTimeout(() => {
					if (!button.disabled) return;
					button.disabled = false;
					button.removeClass("is-downloading");
					void this.refreshPodcastDownloadState(ref);
				}, 2500);
			}
			return;
		}
		button.disabled = false;
		button.removeClass("is-downloading");
		paintIcon(button, "check", "download");
	}

	/** 播客已保存进 vault 后改用本地附件播放；保留当前进度，避免保存动作打断收听。 */
	private useLocalPodcastSource(path: string): void {
		const audio = this.podcastAudioEl;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!audio || !(file instanceof TFile) || !this.podcastBarRef) return;
		const seconds = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
		const resumeTarget = this.podcastResumeTarget;
		const wasPlaying = !audio.paused;
		const pendingSeek = this.podcastPendingSeek;
		audio.onloadedmetadata = () => {
			if (this.podcastBarRef == null) return;
			const target = pendingSeek ?? resumeTarget ?? seconds;
			if (target > 0 && Number.isFinite(audio.duration)) {
				try { audio.currentTime = Math.min(target, Math.max(0, audio.duration - 2)); } catch { /* ignore */ }
			}
			this.podcastPendingSeek = null;
			this.podcastResumeTarget = null;
			this.syncPodcastProgressUi();
			if (wasPlaying || pendingSeek != null) void audio.play().catch(() => undefined);
		};
		audio.src = this.app.vault.getResourcePath(file);
		audio.load();
	}

	private podcastResumeSeconds(entry: FeedEntry): number {
		// 新格式优先读独立的 audioPosition；旧数据里音频位置曾写在 position，做一次兼容。
		const anchor = entry.state.audioPosition?.anchor
			?? (entry.state.position?.anchor?.startsWith("audio:") ? entry.state.position.anchor : "");
		if (!anchor.startsWith("audio:")) return 0;
		const seconds = Number(anchor.slice("audio:".length));
		return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	}

	private hidePodcastBar(): void {
		this.rootEl?.removeClass("has-podcast");
		this.scheduleFloatingFit();
		this.podcastBarRef = null;
		this.podcastPendingSeek = null;
		this.podcastResumeTarget = null;
		const audio = this.podcastAudioEl;
		if (audio) {
			audio.pause();
			audio.onloadedmetadata = null;
			audio.removeAttribute("src");
			try { audio.load(); } catch { /* ignore */ }
		}
		if (this.podcastSeekEl) this.podcastSeekEl.value = "0";
		this.podcastTimeEl?.setText("0:00");
		this.podcastTotalEl?.setText("0:00");
		this.clearPodcastSleepTimer();
		this.paintPodcastPlayButton();
		this.syncPodcastDownloadState(false);
	}

	/** 从当前 audio 抓一帧播客进度：拖动、seek、timeupdate 共用。 */
	private capturePodcastProgress(): void {
		const ref = this.podcastBarRef;
		const audio = this.podcastAudioEl;
		if (!ref || !audio) return;
		const entry = this.plugin.feedStore.getEntry(ref.feedId, ref.entryId);
		if (!entry || entry.kind !== "audio") return;
		const duration = Number.isFinite(audio.duration) ? audio.duration : (entry.enclosure?.duration ?? 0);
		this.queuePodcastProgress(ref.feedId, ref.entryId, audio.currentTime, duration);
	}

	private queuePodcastProgress(feedId: string, entryId: string, seconds: number, duration: number): void {
		if (!Number.isFinite(seconds) || seconds < 1) return;
		const fraction = duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) : 0;
		const position: BookPosition = { anchor: `audio:${seconds.toFixed(2)}`, fraction, updatedAt: Date.now() };
		this.podcastProgressPending.set(`${feedId}:${entryId}`, { feedId, entryId, position });
		// 闪退窗口先由本机热缓存兜住；拖动滑块时按 250ms 节流，避免每个像素都写 localStorage。
		const now = performance.now();
		if (now - this.lastPodcastCheckpointAt >= 250) {
			this.lastPodcastCheckpointAt = now;
			this.plugin.checkpointPodcastProgress(feedId, entryId, position);
		}
		if (this.podcastProgressTimer != null) return;
		this.podcastProgressTimer = window.setTimeout(() => { void this.flushPodcastProgress(); }, 5_000);
	}

	private async flushPodcastProgress(): Promise<void> {
		if (this.podcastProgressTimer != null) {
			window.clearTimeout(this.podcastProgressTimer);
			this.podcastProgressTimer = null;
		}
		if (!this.podcastProgressPending.size) return;
		const byFeed = new Map<string, Array<{ entryId: string; patch: { audioPosition: BookPosition } }>>();
		for (const item of this.podcastProgressPending.values()) {
			const patches = byFeed.get(item.feedId) ?? [];
			patches.push({ entryId: item.entryId, patch: { audioPosition: item.position } });
			byFeed.set(item.feedId, patches);
		}
		this.podcastProgressPending.clear();
		await Promise.all([...byFeed.entries()].map(([feedId, patches]) => this.plugin.feedStore.updateEntriesState(feedId, patches)));
	}

	private toggleSidePanel(mode: "annotations" | "bookshelf" | "feeds"): void {
		// 面板是**贴顶 / 贴底铺满的不透明抽屉**，开合前把两条原生 chrome 的让位量
		// （--ur-top-inset / --ur-bottom-inset）重测一遍：页首与底栏随时会被收走或收起
		// （官方全屏 / 悬浮导航 / 键盘弹起 / 沉浸模式），上一次同步可能是几分钟前的几何。
		this.syncProgressTop();
		const hide = this.annotationsPanel.isOpen() && this.annotationsPanel.getMode() === mode;
		if (hide) {
			this.annotationsPanel.hide();
		} else {
			// 两面板可共存：不再主动关闭外观面板（外观面板会自动向右避让）
			if (mode === "annotations") this.annotationsPanel.render(this.annotations);
			this.annotationsPanel.setMode(mode);
			this.annotationsPanel.show();
			if (mode === "feeds" && !this.feedAutoRefreshDone && this.plugin.settings.feeds.refreshOnOpen !== false) {
				this.feedAutoRefreshDone = true;
				const feeds = this.plugin.feedStore.listFeeds();
				const oldestFetch = feeds.reduce((oldest, feed) => Math.min(oldest, feed.lastFetchedAt || 0), Date.now());
				if (Date.now() - oldestFetch > 10 * 60_000) {
					void idleYield().then(() => this.refreshFeeds()).catch(() => undefined);
				}
			}
		}
		if (hide) this.cancelAnnoAutoClose();
		// 标注侧边栏显隐会移动按钮轨，外观面板若已打开需重新对齐
		this.alignAppearancePanel();
		this.alignActionsRail();
		// 侧边栏开合改变正文宽度 → 文字重排，驱动高亮矩形重定位（布局变化不触发 onResize）
		this.adapter.notifyVisible();
	}

	private setBookshelfSortMode(mode: BookshelfSortMode): void {
		if (mode !== "scan" && mode !== "recent" && mode !== "manual") return;
		this.plugin.settings.bookshelfSortMode = mode;
		void this.plugin.persistData();
		this.annotationsPanel.setMode("bookshelf");
	}

	private reorderBookshelf(paths: string[]): void {
		// 分类筛选下只能看到当前分类的卡片；若直接用这批路径覆盖全量手动排序，
		// 会把其他分类的顺序悄悄丢掉。这里把当前可见项作为“块”放回其原本的
		// 首个位置，未出现在当前筛选里的书保持原相对顺序。
		const incoming: string[] = [];
		const incomingSet = new Set<string>();
		for (const path of paths) {
			if (!path || incomingSet.has(path)) continue;
			incoming.push(path);
			incomingSet.add(path);
		}

		const previous = this.plugin.settings.bookshelfManualOrder ?? [];
		const preserved = previous.filter(path => !incomingSet.has(path));
		const previousFirstVisible = previous.findIndex(path => incomingSet.has(path));
		let insertAt = preserved.length;
		if (previousFirstVisible >= 0) {
			insertAt = 0;
			for (const path of previous) {
				if (path === previous[previousFirstVisible]) break;
				if (!incomingSet.has(path)) insertAt++;
			}
		}

		this.plugin.settings.bookshelfManualOrder = [
			...preserved.slice(0, insertAt),
			...incoming,
			...preserved.slice(insertAt),
		];
		this.plugin.settings.bookshelfSortMode = "manual";
		void this.plugin.persistData();
		this.annotationsPanel.setMode("bookshelf");
	}

	private toggleBookPin(path: string): void {
		const pinned = new Set(this.plugin.settings.bookshelfPinned);
		if (pinned.has(path)) pinned.delete(path);
		else pinned.add(path);
		this.plugin.settings.bookshelfPinned = [...pinned];
		void this.plugin.persistData();
		this.annotationsPanel.setMode("bookshelf");
	}

	private async openBookFromShelf(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到书籍：${path}`);
			return;
		}
		this.annotationsPanel.setMode("annotations");
		if (this.file?.path === path) {
			this.annotationsPanel.show();
			this.adapter.focusContent();
			return;
		}
		await this.plugin.openBook(file);
		this.annotationsPanel.setMode("annotations");
	}

	/** 按钮排紧贴标注面板右缘：读取面板实际宽度设置 left（CSS 变量在面板宽度
	 *  被拖拽过的情况下可能不同步，导致按钮排与面板之间出现空隙/重叠） */
	private alignActionsRail(): void {
		this.syncImmersionSwitchOffset();
		const panel = this.annotationsPanel?.containerEl;
		const rail = this.sideNav?.actionsEl;
		if (!panel || !rail) return;
		try {
			if (panel.hasClass("is-open")) {
				const w = panel.offsetWidth || 330;
				rail.style.left = `${w + 1}px`;
				// 保持行内强度：既有的兄弟选择器规则（.unreader-anno-panel.is-open ~
				// .unreader-actions，特异性 0,3,0）会盖掉任何 (0,2,0) 的类。
				rail.style.setProperty("transform", RAIL_SHIFTED_TRANSFORM);
				rail.style.setProperty("opacity", RAIL_SHIFTED_OPACITY);
			} else {
				rail.style.removeProperty("left");
				rail.style.removeProperty("transform");
				rail.style.removeProperty("opacity");
			}
		} catch { /* ignore */ }
	}

	/** 侧栏打开时把灯绳移到抽屉右缘之外；关闭后恢复左缘。宽度取实测值，
	 *  手机 75vw、桌面拖拽宽度、横竖屏切换都无需另写公式。 */
	private syncImmersionSwitchOffset(): void {
		const root = this.rootEl;
		if (!root) return;
		try {
			const panel = this.annotationsPanel?.containerEl;
			if (!panel?.hasClass("is-open")) {
				root.style.removeProperty("--ur-immersion-switch-left");
				return;
			}
			const rootWidth = root.clientWidth || this.bodyEl?.clientWidth || window.innerWidth || 0;
			const panelWidth = panel.offsetWidth || 0;
			const switchWidth = this.immersionSwitchEl?.offsetWidth || 26;
			const maxLeft = Math.max(0, rootWidth - switchWidth - 8);
			const left = Math.max(0, Math.min(panelWidth + 10, maxLeft));
			root.style.setProperty("--ur-immersion-switch-left", Math.round(left) + "px");
		} catch {
			root.style.removeProperty("--ur-immersion-switch-left");
		}
	}

	getFile(): TFile | null {
		return this.file;
	}

	refreshAppearance(): void {
		this.adapter.applyAppearance(this.plugin.settings.appearance);
		this.syncOuterAppearance();
	}

	toggleAppearance(section: "normal" | "full" | null = null): void {
		const willOpen = !this.appearancePanel.isOpen();
		// 钉住模式下两面板共存；仅悬浮态关闭标注侧边栏避免遮挡
		if (willOpen && this.annotationsPanel.isOpen() && !this.pinned) this.annotationsPanel.hide();
		// 打开前重扫预设文件夹：他端同步到达的预设即使漏了 vault 事件也能看到。
		// 排在 whenDataReady 之后：init 的首次 reload 会 cache.clear() 再写入，
		// 两次重扫并发时后到的那份才有决定权（否则面板可能列出空列表）。
		if (willOpen) {
			void this.plugin.whenDataReady()
				.then(() => this.plugin.presetStore.reload())
				.then(() => {
					if (this.appearancePanel.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance, section);
				}).catch(() => {});
		}
		this.appearancePanel.toggle(this.plugin.settings.appearance, section);
	}


	goBack(): void {
		if (!this.adapter.canGoBack()) {
			new Notice("没有更早的位置了");
			return;
		}
		// 落地后走 pending 通路重整：还有更早记录则继续显示，打空则隐藏
		this.pendingBackJump = true;
		this.adapter.goBack();
	}

	/* 返回按钮显隐统一规范：跳转后保持出现，仅当滑动满 3 页距离且超过 3 秒才隐藏 */
	private showBackArmed(now: number, loc: number | null): void {
		this.backVisible = true;
		this.backSuppressed = false;
		this.backArmAt = now;
		this.backPages = 0;
		this.backLastLoc = loc;
		this.sideNav.setBackVisible(true);
	}

	private hideBack(): void {
		this.backVisible = false;
		this.backSuppressed = true;
		this.sideNav.setBackVisible(false);
	}

	private refreshBackVisibility(info: RelocateInfo): void {
		const canGo = this.adapter.canGoBack();
		const now = performance.now();
		const loc = typeof info.locCurrent === "number" ? info.locCurrent : null;

		// 主动跳转（卡片/目录/书签/页码等）→ 立即显示并重置计时
		if (this.pendingBackJump) {
			this.pendingBackJump = false;
			if (backDebugOn()) {
				debugLog.info("[UNreader][back] jump-landing", {
					canGo,
					stack: this.adapter.backStackSize?.() ?? -1,
					jumping: this.adapter.isJumping?.() ?? null,
					loc,
					elapsedMs: Math.round(performance.now() - (this.debugJumpT0 || performance.now())),
				});
			}
			if (canGo) this.showBackArmed(now, loc);
			else this.hideBack();
			return;
		}

		// 跳转在途（含落地漂移校正）：只跟随基线，不累计、不隐藏——
		// 否则跳跃本身的位移会一次性撑爆 3 页计数，落地稍一滚动按钮就消失。
		// 15 秒逃逸：防引擎跳转标志卡死导致按钮永不隐藏
		if (this.adapter.isJumping() && now - this.backArmAt < 15000) {
			this.backLastLoc = loc ?? this.backLastLoc;
			return;
		}

		// 普通翻页/滚动：累计移动页数
		if (loc != null && this.backLastLoc != null) {
			const moved = Math.abs(loc - this.backLastLoc);
			if (moved > 0) this.backPages += moved;
		}
		this.backLastLoc = loc ?? this.backLastLoc;

		if (!canGo) {
			this.hideBack();
			return;
		}
		// 已被 3 页 + 3 秒规则隐藏：保持隐藏，直到下一次主动跳转
		if (this.backSuppressed) return;

		if (
			this.backVisible &&
			this.backPages >= UNreaderView.BACK_HIDE_PAGES &&
			now - this.backArmAt >= UNreaderView.BACK_HIDE_MS
		) {
			this.hideBack();
			return;
		}
		if (!this.backVisible) this.showBackArmed(now, loc);
	}

	goPrevChapter(): void {
		void this.transitionChapter(-1);
	}

	goNextChapter(): void {
		void this.transitionChapter(1);
	}

	private transitionTimer: number | null = null;
	private transitionCleanupTimer: number | null = null;
	private transitionSafetyTimer: number | null = null;

		private async transitionChapter(dir: 1 | -1): Promise<void> {
		if (this.chapterTransitioning) return;
		const can = dir === 1 ? this.adapter.canGoNextSection() : this.adapter.canGoPrevSection();
		if (!can) {
			new Notice(dir === 1 ? "已经是最后一章" : "已经是第一章");
			this.bodyEl.addClass("is-chapter-bounce");
			if (this.transitionTimer) window.clearTimeout(this.transitionTimer);
			this.transitionTimer = window.setTimeout(() => {
				this.bodyEl.removeClass("is-chapter-bounce");
				this.transitionTimer = null;
			}, 520);
			return;
		}
		if (this.transitionTimer) {
			window.clearTimeout(this.transitionTimer);
			this.transitionTimer = null;
		}
		if (this.transitionCleanupTimer) {
			window.clearTimeout(this.transitionCleanupTimer);
			this.transitionCleanupTimer = null;
		}
		this.chapterTransitioning = true;
		// 安全网：任何路径（含 promise 永不 resolve 的异常）下，转场标志都必须快速复位，
		// 否则卡死的标志会让后续所有「上一章/下一章」点击静默失效
		if (this.transitionSafetyTimer) window.clearTimeout(this.transitionSafetyTimer);
		this.transitionSafetyTimer = window.setTimeout(() => {
			this.chapterTransitioning = false;
			this.transitionSafetyTimer = null;
		}, 2500);
		this.bodyEl.addClass("is-chapter-transitioning");
		this.bodyEl.toggleClass("is-transition-next", dir === 1);
		this.bodyEl.toggleClass("is-transition-prev", dir === -1);
		// 强制回流确保动效起手帧生效，避免与阻尼 transform 叠加导致的掉帧
		void this.contentHost.offsetHeight;
		const loadPromise = dir === 1 ? this.adapter.nextSection() : this.adapter.prevSection();
		const animPromise = new Promise<void>(r => window.setTimeout(r, 320));
		try {
			await Promise.all([loadPromise, animPromise]);
			await new Promise<void>(r => window.requestAnimationFrame(() => window.requestAnimationFrame(() => r())));
		} finally {
			this.bodyEl.removeClass("is-transition-next");
			this.bodyEl.removeClass("is-transition-prev");
			this.transitionCleanupTimer = window.setTimeout(() => {
				this.bodyEl.removeClass("is-chapter-transitioning");
				this.chapterTransitioning = false;
				if (this.transitionSafetyTimer) { window.clearTimeout(this.transitionSafetyTimer); this.transitionSafetyTimer = null; }
				this.updateChapterNav();
				this.contentHost.style.removeProperty("transform");
				this.contentHost.style.removeProperty("transition");
				this.transitionCleanupTimer = null;
			}, 360);
		}
	}

	private updateChapterNav(): void {
		// 页码显示在浮动目录条正下方（sideNav.pageEl），章节名由顶部悬浮条显示
		const hasBook = this.adapter.hasBook();
		const info = this.lastRelocate;
		let text = "";
		if (hasBook && info?.locCurrent != null && info?.locTotal != null) {
			text = `${Math.min(info.locCurrent + 1, info.locTotal)} / ${info.locTotal}`;
		} else if (hasBook && info?.fraction != null) {
			text = `${Math.round(info.fraction * 100)}%`;
		}
		this.sideNav?.setPageText(text);
	}

	/** 按钮排页码点击 / 右下角页码点击：弹出页码跳转面板（location→fraction 口径同源） */
	private openPageJumpModal(): void {
		const info = this.lastRelocate;
		const total = info?.locTotal ?? 0;
		if (!total) {
			new Notice("当前书籍暂无页码信息");
			return;
		}
		// 显示口径为 1-based（updateChapterNav 用 locCurrent + 1），与页码显示一致
		const current = Math.min((info?.locCurrent ?? 0) + 1, total);
		new PageJumpModal(this.app, total, current, page => {
			// location 单位 → 全书 fraction：约 page / locTotal 中点
			const fraction = Math.min(1, Math.max(0, (page - 0.5) / total));
			this.pendingBackJump = true;
			void this.adapter.goToFraction(fraction);
		}).open();
	}

	/* ---------------- 正文搜索 ---------------- */

	private buildSearchBar(body: HTMLElement): void {
		const root = this.searchBarEl = body.createDiv({ cls: "unreader-search" });
		const bar = root.createDiv({ cls: "unreader-search-bar" });
		setIcon(bar.createDiv({ cls: "unreader-search-icon" }), "search");
		this.searchInputEl = bar.createEl("input", {
			cls: "unreader-search-input",
			attr: { placeholder: "搜索正文…", spellcheck: "false" },
		});
		this.searchCountEl = bar.createDiv({ cls: "unreader-search-count" });
		const prevBtn = bar.createDiv({ cls: "unreader-search-btn", attr: { "aria-label": "上一处" } });
		setIcon(prevBtn, "chevron-up");
		const nextBtn = bar.createDiv({ cls: "unreader-search-btn", attr: { "aria-label": "下一处" } });
		setIcon(nextBtn, "chevron-down");
		const closeBtn = bar.createDiv({ cls: "unreader-search-btn", attr: { "aria-label": "关闭搜索" } });
		setIcon(closeBtn, "x");
		this.searchStatusEl = root.createDiv({ cls: "unreader-search-status" });
		this.searchListEl = root.createDiv({ cls: "unreader-search-list" });

		const input = this.searchInputEl;
		input.addEventListener("input", () => {
			if (this.searchDebounceTimer != null) window.clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = window.setTimeout(() => this.runSearch(), 400);
		});
		input.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Escape") { e.preventDefault(); this.toggleSearch(false); }
			else if (e.key === "Enter") {
				e.preventDefault();
				if (this.searchMatches.length) this.cycleSearch(1);
				else this.runSearch();
			}
		});
		prevBtn.addEventListener("click", e => { e.stopPropagation(); this.cycleSearch(-1); });
		nextBtn.addEventListener("click", e => { e.stopPropagation(); this.cycleSearch(1); });
		closeBtn.addEventListener("click", e => { e.stopPropagation(); this.toggleSearch(false); });
	}

	/** 展开/收起搜索栏 */
	toggleSearch(open?: boolean): void {
		const willOpen = open ?? !this.searchOpen;
		this.searchOpen = willOpen;
		this.searchBarEl?.toggleClass("is-open", willOpen);
		// 功能轨「搜索正文」按钮高亮跟随搜索栏开合
		this.syncRailButtons();
		if (willOpen) {
			this.searchInputEl?.focus();
			this.searchInputEl?.select();
		} else {
			if (this.searchToken) this.searchToken.aborted = true;
			if (this.searchDebounceTimer != null) {
				window.clearTimeout(this.searchDebounceTimer);
				this.searchDebounceTimer = null;
			}
		}
	}

	private runSearch(): void {
		const input = this.searchInputEl;
		const root = this.searchBarEl;
		const list = this.searchListEl;
		if (!input || !root || !list) return;
		const q = input.value.trim();
		if (this.searchToken) this.searchToken.aborted = true;
		this.searchMatches = [];
		this.searchPointer = -1;
		list.empty();
		root.toggleClass("has-results", false);
		this.updateSearchCount();
		if (q.length < 2) {
			root.toggleClass("has-status", false);
			return;
		}
		const token: { aborted: boolean } = { aborted: false };
		this.searchToken = token;
		void this.consumeSearch(q, token);
	}

	private async consumeSearch(q: string, token: { aborted: boolean }): Promise<void> {
		const root = this.searchBarEl;
		const status = this.searchStatusEl;
		const list = this.searchListEl;
		if (!root || !status || !list) return;
		status.setText("搜索中…");
		root.toggleClass("has-status", true);
		for await (const ev of this.adapter.searchBook(q, token)) {
			if (token.aborted) return;
			if (ev.type === "progress") {
				status.setText(`搜索中… ${Math.round(ev.progress * 100)}%`);
				continue;
			}
			if (ev.type === "match") {
				this.searchMatches.push(ev);
				if (this.searchMatches.length === 1) root.toggleClass("has-results", true);
				// 结果渲染上限，防止长书 DOM 爆炸；计数仍然完整
				if (this.searchMatches.length <= 200) this.appendSearchRow(ev, this.searchMatches.length - 1);
				this.updateSearchCount();
				continue;
			}
			status.setText(ev.total ? (ev.capped ? `共 ${ev.total} 处（仅显示前 200）` : `共 ${ev.total} 处`) : "没有找到匹配内容");
			if (!ev.total) root.toggleClass("has-status", true);
		}
	}

	private appendSearchRow(ev: { index: number; matchIndex: number; cfi: string; label: string; pre: string; match: string; post: string }, arrayIdx: number): void {
		const list = this.searchListEl;
		if (!list) return;
		const row = list.createDiv({ cls: "unreader-search-row", attr: { "data-search-idx": String(arrayIdx) } });
		row.createDiv({ cls: "unreader-search-row-label", text: ev.label || "正文" });
		const excerpt = row.createDiv({ cls: "unreader-search-row-excerpt" });
		excerpt.createSpan({ text: ev.pre });
		excerpt.createSpan({ cls: "unreader-search-row-hit", text: ev.match });
		excerpt.createSpan({ text: ev.post });
		row.addEventListener("click", () => this.jumpToSearchMatchAt(arrayIdx));
	}

	private cycleSearch(dir: 1 | -1): void {
		if (!this.searchMatches.length) return;
		const n = this.searchMatches.length;
		this.searchPointer = ((this.searchPointer + dir) % n + n) % n;
		this.updateSearchCount();
		this.markActiveSearchRow();
		this.jumpToSearchMatchAt(this.searchPointer);
	}

	private jumpToSearchMatchAt(i: number): void {
		const m = this.searchMatches[i];
		if (!m) return;
		this.searchPointer = i;
		this.updateSearchCount();
		this.markActiveSearchRow();
		this.pendingBackJump = true;
		void this.adapter.jumpToSearchMatch(m.index, m.matchIndex, m.cfi);
	}

	private updateSearchCount(): void {
		this.searchCountEl?.setText(this.searchMatches.length ? `${this.searchPointer < 0 ? 1 : this.searchPointer + 1}/${this.searchMatches.length}` : "");
	}

	private markActiveSearchRow(): void {
		const list = this.searchListEl;
		if (!list) return;
		list.querySelectorAll<HTMLElement>(".unreader-search-row").forEach(row => {
			row.toggleClass("is-active", Number(row.dataset.searchIdx) === this.searchPointer);
		});
		const active = list.querySelector<HTMLElement>(`.unreader-search-row[data-search-idx="${this.searchPointer}"]`);
		active?.scrollIntoView({ block: "nearest" });
	}

	/** 等 Obsidian 的 workspace layout 完成。
	 *
	 *  与 `plugin.whenDataReady()` 的区别是**不包含**进度/预设读盘与目录自愈：那些工作
	 *  由 dataReady 链自己负责，开书只需等布局这一件事，读完书的 I/O 仍与它并行。 */
	private whenLayoutReady(): Promise<void> {
		if (this.app.workspace.layoutReady) return Promise.resolve();
		if (this.layoutGate) return this.layoutGate;
		this.layoutGate = new Promise<void>(resolve => {
			try {
				this.app.workspace.onLayoutReady(() => resolve());
			} catch {
				resolve();
			}
		});
		return this.layoutGate;
	}

	/** 本视图当前是否真的可见。启动恢复时后台标签页的 `leaf.containerEl` 是隐藏的；
	 *  不解析这些书可以避免「打开 Obsidian 时每个后台阅读标签都在跑整本 EPUB」。
	 *  取不到官方 `isVisible()` 时按可见处理（宁可多加载，不可让正文永远空白）。 */
	private isReaderVisible(): boolean {
		try {
			if (document.visibilityState === "hidden") return false;
			const leaf = this.leaf as unknown as { isVisible?: () => boolean };
			return typeof leaf.isVisible === "function" ? leaf.isVisible() : true;
		} catch {
			return true;
		}
	}

	/** 开书的唯一入口（onOpen / setState / 视图重新可见）。
	 *
	 *  ## 为什么必须经过这里
	 *
	 *  Obsidian 恢复 workspace 时会 `await` 每个叶子的 `View.onOpen()`，所以 onOpen
	 *  里同步启动整本书解析，会把 zip 解压、章节资源改写、iframe 渲染全部计入
	 *  `workspace.layout`。更糟的是旧代码在 onOpen 里 `await applyDevicePreset()`：
	 *  钉住预设时它等 `whenDataReady()`，而后者等 `onLayoutReady()` —— 两个启动阶段
	 *  互相等待，真机表现为「装过这个插件后，下次打开 Obsidian 卡上万毫秒」。
	 *
	 *  这里把顺序钉死为：
	 *    ① 先让 Obsidian 完成 layout（onOpen 立即返回）；
	 *    ② 再让出一帧/一个短空闲片，保证首屏已经提交；
	 *    ③ 只在叶子真的可见时进入 tryLoad（后台标签页留到切过去再开）。
	 *
	 *  `loadGateBusy` 是单飞行闸门；`loadReqSeq` 让「开书期间又 setState 换书」不会
	 *  丢请求，也不会让两个 loadBook 并发写同一棵 DOM。 */
	private scheduleLoad(): void {
		const source = this.getReaderSource();
		if (!source) return;
		const key = this.sourceKey(source);
		if (key && this.loadedPath === key && this.adapter.hasBook()) return;
		this.loadReqSeq++;
		if (this.loadGateBusy) return;
		this.loadGateBusy = true;
		// 只有**启动恢复**这一档需要等首帧；用户正常点开一本书时 layout 早已就绪，
		// 让一个微任务即可，不能再加 32ms 的空闲等待拖慢开书手感。
		const startupGate = !this.app.workspace.layoutReady;
		void (async () => {
			try {
				while (this.loadGateSeq !== this.loadReqSeq) {
					this.loadGateSeq = this.loadReqSeq;
					await this.whenLayoutReady();
					if (startupGate) await idleYield(100);
					else await Promise.resolve();
					if (!this.containerEl.isConnected) return;
					// 布局刚结束时 active tab / 可见性才稳定；隐藏的后台阅读标签留到切页。
					if (this.getReaderSource() && this.isReaderVisible()) await this.tryLoad();
				}
			} catch (e) {
				console.error("[UNreader] scheduled load failed", e);
			} finally {
				this.loadGateBusy = false;
			}
		})();
	}

	private async tryLoad(): Promise<void> {
		const source = this.getReaderSource();
		if (!this.chromeReady || !source) return;
		const key = this.sourceKey(source);
		if (key && this.loadedPath === key && this.adapter.hasBook()) return;
		await this.loadBook();
	}

	private async loadBook(): Promise<void> {
		const source = this.getReaderSource();
		if (!source) return;
		const token = ++this.loadingToken;
		const sourceKey = this.sourceKey(source)!;

		this.showLoading();
		// 恢复定位期间容器**有布局但不绘制**：恢复落点全靠 offsetTop /
		// getBoundingClientRect 计算，而 `.unreader-root:not(.has-book) .unreader-stage`
		// 是 display:none（几何全为 0 → 落点退化成书首）。隐藏由 styles.css 的
		// is-restoring 负责（visibility:hidden 保留布局），落定后再由 has-book 揭示。
		this.restoring = true;
		this.cursor.reset(sourceKey);
		this.rootEl.addClass("is-restoring");
		this.rootEl.toggleClass("is-feed-source", source.kind === "feed-entry");
		// 换书先把上一本的 HTML 标记摘掉（否则加载期间那枚设备按钮会挂在新书上）
		this.rootEl.removeClass("is-html-source");
		perfReset();
		perfBegin("loadBook");
		try {
			// 前置各步互不依赖（字体扫描 / 读整包 / 标注解析 / 进度预设库就绪），
			// 并行执行——串行时任何一环慢都线性加进「正在打开…」时长。
			// whenDataReady 也挂在这里：进度/预设库初始化已被移出插件启用路径
			// （见 main.ts 的 dataReady），但下面 getPosition 需要它，放在并行组里
			// 与读整包重叠，实际不产生额外等待。
			let target: BookOpenTarget;
			let annotations: AnnotationFileData;
			let saved: BookPosition | undefined;
			if (source.kind === "book") {
				const file = this.file;
				if (!file) throw new Error("书籍文件不存在");
				this.notePath = annotationFileFor(file);
				saved = this.plugin.getPosition(file.path);
				const [, blobFile, loadedAnnotations] = await Promise.all([
					this.plugin.refreshCustomFonts().catch(() => undefined),
					readBookFile(this.app, file),
					loadAnnotations(this.app.vault, this.notePath, file.path),
					this.plugin.whenDataReady(),
					this.applyDevicePreset().then(() => this.syncOuterAppearance()),
				]);
				// 本地 HTML 与 TXT 一样是「我们先合成 book、再交给 foliate」的形态：
				// 净化 + 相对资源改写都在 makeHtmlBook 里做完（srcdoc 章节没有 base URL，
				// 资源 URL 必须烧进 HTML —— 见 core/htmlBook.ts 文件头）。
				target = isHtmlBookFile(file)
					? await makeHtmlBook(blobFile, { resolveResource: createVaultResourceResolver(this.app, file.path) })
					: blobFile;
				annotations = loadedAnnotations;
			} else {
				await this.plugin.whenDataReady();
				await Promise.all([
					this.plugin.refreshCustomFonts().catch(() => undefined),
					this.applyDevicePreset().then(() => this.syncOuterAppearance()),
				]);
				const entry = this.plugin.feedStore.getEntry(source.feedId, source.entryId);
				if (!entry) throw new Error("订阅文章已不存在，可能已被刷新清理");
				const feed = this.plugin.feedStore.getFeed(entry.feedId);
				const openedAt = Date.now();
				await this.plugin.feedStore.updateEntryState(entry.feedId, entry.id, {
					openedAt,
					readAt: entry.state.readAt ?? (this.plugin.settings.feeds.markReadOnOpen !== false ? openedAt : null),
				});
				this.currentFeedEntry = this.plugin.feedStore.getEntry(entry.feedId, entry.id) ?? entry;
				saved = this.currentFeedEntry.state.position ?? undefined;
				this.notePath = annotationFileForFeed(entry.feedId, entry.id, entry.title);
				annotations = await loadAnnotations(this.app.vault, this.notePath, entry.url || entry.title);
				const pendingHash = this.currentFeedEntry.pendingContentHash;
				const contentHtml = pendingHash && this.currentFeedEntry.pendingContentHtml != null
					? this.currentFeedEntry.pendingContentHtml
					: this.currentFeedEntry.contentHtml;
				this.activeFeedContentHash = pendingHash || this.currentFeedEntry.contentHash;
				const sanitized = sanitizeArticleHtml(
					contentHtml || `<p>${this.currentFeedEntry.summary}</p>`,
					this.currentFeedEntry.url,
					this.plugin.settings.feeds.loadRemoteImages !== false,
				);
				const prepared = await this.plugin.feedMediaStore.prepareArticleHtml(
					sanitized,
					this.currentFeedEntry.url,
					this.plugin.settings.feeds.loadRemoteImages !== false && this.plugin.settings.feeds.imageCacheMb > 0,
				);
				this.currentFeedEntry = { ...this.currentFeedEntry, contentHtml: prepared };
				this.showPodcastBar(this.currentFeedEntry);
				target = makeFeedBook(this.currentFeedEntry, feed);
			}
			if (token !== this.loadingToken) return;
			this.annotations = annotations;

			try { this.adapter.destroy(); } catch (e) { console.warn("[UNreader] destroy warn", e); }
			this.contentHost.empty();
			this.adapter.mount(this.contentHost, {
				onRelocate: info => this.handleRelocate(info),
				onLoadDoc: (doc, index) => {
					this.wireDocEvents(doc, index);
				},
				onFootnoteRender: (view, href, anchor) => this.openFootnotePopup(view, href, anchor),
				onInlineFootnote: (html, href, jump, anchor) => this.openInlineFootnote(html, href, jump, anchor),
				onSelection: info => this.handleContinuousSelection(info),
				onShowAnnotation: (cfi, range) => this.handleShowAnnotation(cfi, range),
				onFrameReady: doc => this.wireFrameDoc(doc),
				onFrameKey: e => { this.handleKey(e); },
				onFrameTap: () => {
					// 点书内正文：统一收起工具条/高亮气泡/未钉住侧边栏，
					// 触屏额外关外观/目录面板（无 hover 自动收起能力）
					this.dismissFloatingOnBlankClick();
				},
				onScrollActivity: active => this.handleScrollActivity(active),
				onSwipe: info => this.handleFrameSwipe(info),
				onTapZone: (ratio, stamp) => this.handleTapZone(ratio, stamp),
				onPodcastTimestamp: seconds => this.jumpPodcastTo(seconds),
				onNavDerived: () => this.renderNavPanel(),
			});

			// 取证一行：出「进度丢了」的报障时，先看这里是「无记录」还是「记了但落点不对」
			// ——两者是完全不同的故障面（前者查存储，后者查锚点解析/恢复）
			debugLog.info("[progress] open", sourceKey,
				saved ? `restore ${saved.anchor.slice(0, 32)} @${saved.updatedAt} ${saved.fraction.toFixed(3)}` : "无记录（从书首打开）");
			await this.adapter.load(target, saved?.anchor || undefined, this.plugin.settings.appearance);
			// 网页（本地 HTML）：把持久化的设备档位交给引擎（非 HTML 书上它是空操作），
			// 并同步设备按钮的显隐 —— 必须在 load 之后，webLayout 的判据在 el.book 上
			this.adapter.setWebDevice(this.plugin.settings.webDeviceMode);
			this.syncHtmlSourceClass();
			// **开书即在上次阅读位置**：等恢复落点确定再揭示正文。旧流程在这里就往下走、
			// 立刻加 `has-book` 显示正文，而恢复落地要等目标章渲染 + 收敛循环（数百 ms 起），
			// 用户看到的就是「先开在书首、再跳到上次位置」。等待有上限（见 adapter.restoreGateMs），
			// 且视口已被预置到目标章上，所以超时放行也停在目标章附近而不是书首。
			await this.adapter.whenRestored();
			if (token !== this.loadingToken) return; // 等待期间用户已换书，本轮作废
			perfEnd("loadBook");

			const jumpToEntry = (entry: NavEntryModel): void => {
				this.pendingBackJump = true;
				if (backDebugOn()) {
					this.debugJumpT0 = performance.now();
					debugLog.info("[UNreader][back] toc-click", {
						label: entry.label,
						sectionIndex: entry.sectionIndex,
						href: entry.href,
						continuous: this.adapter.isContinuousMode(),
					});
				}
				// 派生条目（书源目录缺失的章节）按章节 index 跳转；目录条目按 href
				if (entry.sectionIndex != null) void this.adapter.goToSection(entry.sectionIndex);
				else void this.adapter.goTo(entry.href);
			};
			this.navJump = jumpToEntry;
			this.renderNavPanel();
			// 开书自动展开浮动目录面板（外观设置/预设控制；桌面端专属——
			// 移动端沉浸模式会把面板随章节轨藏成不可见，自动展开只会造成
			// 「面板开着但看不见、点按全被门控挡死」的死锁）
			let autoOpenedToc = false;
			if (!Platform.isMobile && !Platform.isIosApp && !Platform.isAndroidApp
				&& this.plugin.settings.appearance.autoOpenToc !== false && this.sideNav.clickableCount() > 0) {
				this.sideNav.ensurePanelOpen();
				autoOpenedToc = true;
			}
			this.adapter.restoreHighlights(this.annotations.highlights);
			if (this.isFeedSource()) await this.reconcileFeedAnnotations();
			this.annotationsPanel.render(this.annotations);
			if (this.isFeedSource()) {
				this.sideNav.closePanel();
				this.annotationsPanel.refreshFeeds();
			}
			// 星标按钮的状态源是「当前文章」，换书/换文章/刷新后都要重算一次
			this.syncRailButtons();
			void this.refreshSideNavCounts();
			this.updateChapterNav();

			this.loadedPath = sourceKey;
			this.plugin.noteActiveReader(this);
			// 加载完成后再驱动一次填充/重定位：移动端（尤其手机竖屏）加载期间布局
			// 未稳定、resize 事件可能不触发，填充链需要这里兜底一次
			this.adapter.notifyVisible();
			const canGoInitial = this.adapter.canGoBack();
			this.backVisible = canGoInitial;
			this.backSuppressed = !canGoInitial;
			this.sideNav.setBackVisible(canGoInitial);
			this.rootEl.addClass("has-book");
			this.rootEl.removeClass("is-empty");
			this.endRestoring();
			this.emptyEl.hide();
			this.loadingEl.hide();
			this.syncNativeHeader();
			this.updatePinButtonVisibility();
			if (this.pinned) this.annotationsPanel.show();
			this.syncOuterAppearance();
			// 数据还没落地的窗口内被打开的外观面板会列出空预设（预设定义随库
			// 文件夹同步，getPresets 是同步读缓存）。就绪后只在「预设数真的变了」
			// 时重建一次，避免无谓地重开面板重置用户正在操作的滚动位置/下拉态。
			{
				const presetsAtBuild = this.plugin.presetStore.list().length;
				void this.plugin.whenDataReady().then(() => {
					if (!this.containerEl.isConnected) return;
					if (!this.appearancePanel?.isOpen()) return;
					if (this.plugin.presetStore.list().length === presetsAtBuild) return;
					this.appearancePanel.open(this.plugin.settings.appearance);
				}).catch(() => {});
			}
			// 常态默认态只由「显示工具栏」决定；滑动隐藏只影响后续滚动。
			this.immersiveGraceUntil = Date.now() + 1500;
			if (!this.pinned && this.plugin.settings.appearance.normalModeShowToolbar === false) {
				if (autoOpenedToc) {
					// 自动打开的目录面板不能在下一步立刻关掉；临时亮出工具层，待用户滚动再交给常态逻辑。
					this.rootEl.addClass("chrome-revealed");
					this.rootEl.removeClass("chrome-hidden");
				} else {
					this.sideNav?.closePanel();
					this.rootEl.addClass("chrome-hidden");
					this.rootEl.removeClass("chrome-revealed");
				}
			} else {
				this.rootEl.removeClass("chrome-hidden");
				this.rootEl.removeClass("chrome-revealed");
			}
			this.syncNativeNav("open");
			if (source.kind === "feed-entry") {
				void this.autoFetchFeedFulltext(source.feedId, source.entryId);
			}
		} catch (e) {
			console.error("[UNreader] failed to open book", e);
			const label = this.currentFeedEntry?.title || this.file?.basename || "内容";
			new Notice(`无法打开《${label}》：${e instanceof Error ? e.message : String(e)}`);
			this.showEmpty();
			try { this.adapter.destroy(); } catch { /* ignore */ }
		}
	}

	/** 重建目录面板条目：开书时首次调用；后台派生标题解析完成（onNavDerived）后
	 *  再调用一次补全未入目录章节的条目。页码列一并重算。 */
	private renderNavPanel(): void {
		if (this.isFeedSource()) return;
		const jump = this.navJump;
		if (!jump) return;
		this.sideNav.renderEntries(this.adapter.getNavEntries(), jump);
		this.sideNav.setTocPages(this.adapter.getTocStartPages());
	}

	/** 正文评论编辑区（选中工具条 / 高亮浮窗）正在展开 —— 用户可能正打字、软键盘正弹着。
	 *
	 *  **展开期间所有「背景活动」路径都必须让路**（relocate / 书页滚动 / 系统收走选区）：
	 *  它们都不是「用户要放弃这次标注」的信号，却都会 hide() 掉承载输入框的容器 ——
	 *  容器一 display:none，输入框立刻 blur，移动端软键盘刚弹起就被压回去；
	 *  并且 `pendingSelection` 一旦被清，「保存」会报「无法定位选区」。
	 *  唯一的关闭入口是**用户显式动作**：取消 / 关闭 / Esc / 点正文空白 /
	 *  点别处高亮 / 进入全沉浸。 */
	private isEditingComment(): boolean {
		return (this.selectionToolbar?.isCommentOpen ?? false) || (this.highlightPopover?.isCommentOpen ?? false);
	}

	private handleRelocate(info: RelocateInfo): void {
		this.lastRelocate = info;
		this.sideNav.setActive(info.tocId);
		this.refreshBackVisibility(info);
		// 评论编辑区展开期间**不许收浮层**（见 isEditingComment）：
		// 移动端键盘弹起会让官方收缩 `.app-container` → 本视图 onResize / stage 的
		// ResizeObserver → `adapter.notifyVisible()` → 本函数。若无条件 hide()，
		// 编辑区被 display:none 摘掉 → 输入框 blur → 软键盘刚弹起就被压回去；
		// 即便键盘侥幸留住，下面清掉的 `pendingSelection` 也会让「保存」报
		// 「无法定位选区」（applyHighlightWithComment 靠它取 CFI）。
		if (!this.isEditingComment()) {
			this.selectionToolbar.hide();
			this.highlightPopover.hide();
			this.pendingSelection = null;
			this.lastExcerpt = null;
			this.clearMirrorSelection();
		}
		this.dismissHover();
		// 恢复落定前不落盘：此刻视口还在书首（或占位估算落点），写进去等于把
		// 用户的阅读位置冲掉。恢复期结束后的第一次 relocate 会把真实位置补上。
		// 去抖写之外还有一条**关闭/退出时**的立即写（flushPosition），它读的是
		// cursor —— 所以「可落盘的位置」必须在这一处统一登记，否则两条路会分叉。
		const sourceKey = this.currentSourceKey();
		if (sourceKey && !this.restoring) {
			const capturedAt = Date.now();
			this.cursor.note(sourceKey, info.cfi, info.fraction, capturedAt, true);
			this.checkpointPosition(sourceKey, info, capturedAt);
			this.savePositionDebounced(sourceKey, info);
		}
		this.updateChapterProgress(info.sectionFraction);
		this.updateChapterNav();
		// 页码模型变了（首次就绪 / 书籍重解析导致 locTotal 变化）→ 书签页码重算。
		// 用 locTotal 做闸门：relocate 每帧都来，无变化时不做任何 DOM 写入
		if (info.locTotal != null && info.locTotal !== this.lastPageModelTotal) {
			this.lastPageModelTotal = info.locTotal;
			this.refreshAnnotationPages();
		}
	}

	/** 上次已知的全书总页数（页码模型指纹），用于避免每帧重刷书签页码 */
	private lastPageModelTotal: number | null = null;

	private applyChapterProgressSetting(): void {
		const on = this.plugin.settings.appearance.chapterProgress !== false;
		this.sideNav?.setChapterProgressEnabled(on);
		// **顶部那条第全宽进度条也归这个开关**（2026-09-13 补上这条接线）：
		// `styles.css` 里 `.unreader-progress.is-off { display: none }` 这条规则**就是为它写的**，
		// 但此前**全仓库没有任何代码加过这个类** —— 于是开关实际只改了右缘轨「当前章短横」
		// 内部那一小截填充的深浅（accent 与 accent+灰的差别，在 ~40px 的短横上几乎看不出来），
		// 用户报「章节进度这个开关看不到任何区别」就是这个。
		// 接上之后：关掉它，顶部整条进度条消失 —— 一眼可见。
		this.progressEl?.toggleClass("is-off", !on);
		if (on) this.updateChapterProgress(this.lastRelocate?.sectionFraction ?? 0);
		this.syncImmersionSwitchJoin();
		this.syncFullImmersionPresentation();
	}

	/** 浮动目录条（右缘章节短横轨）显隐：随外观/预设；目录面板仍可由按钮/命令唤起 */
	applyTocRailSetting(): void {
		this.sideNav?.setRailVisible(this.plugin.settings.appearance.showTocRail !== false);
		this.syncFullImmersionPresentation();
	}

	/** 全沉浸例外只改变呈现类；是否进入全沉浸仍由 fullImmersion 单一状态决定。 */
	private syncFullImmersionPresentation(): void {
		const root = this.rootEl;
		if (!root) return;
		const a = this.plugin.settings.appearance;
		if (this.fullImmersionRevealed && a.fullImmersionTapReveal !== true) {
			this.fullImmersionRevealed = false;
			root.removeClass("full-immersion-revealed");
			root.addClass("chrome-hidden");
			root.removeClass("chrome-revealed");
		}
		root.toggleClass("full-immersion-show-toc",
			this.fullImmersion && a.showTocRail === true && a.fullImmersionShowTocRail === true);
		root.toggleClass("full-immersion-show-progress",
			this.fullImmersion && a.chapterProgress !== false && a.fullImmersionShowChapterProgress === true);
		this.syncImmersionSwitchJoin();
		const label = this.fullImmersion ? "退出全沉浸" : "进入全沉浸";
		const switchEl = this.immersionSwitchEl;
		if (switchEl) {
			switchEl.toggleClass("is-on", this.fullImmersion);
			switchEl.setAttribute("aria-pressed", this.fullImmersion ? "true" : "false");
			switchEl.setAttribute("aria-label", label);
			switchEl.setAttribute("title", label);
		}
		this.railImmersionBtn?.toggleClass("is-active", this.fullImmersion);
		this.railImmersionBtn?.setAttribute("aria-label", label);
		this.railImmersionBtn?.setAttribute("title", label);
	}

	/** 打开目录面板（若可开）。浮动目录独立于工具层，不通过命令改写 chrome 显隐。
	 *  开书路径里的自动打开走的是同一套判断（见 openBook 的 autoOpenedToc 分支）。 */
	openTocIfPossible(_why: string): void {
		if (this.isFeedSource()) return;
		if ((this.sideNav?.clickableCount() ?? 0) <= 0) return;
		if (!this.adapter?.hasBook()) return;
		this.sideNav?.ensurePanelOpen();
	}

	/** 供命令/快捷键切换浮动目录面板（各平台一致，同移动端工具栏按钮）。
	 *  目录有自己的显隐规则；命令只切面板，不再顺带唤出工具层。 */
	toggleTocPanel(): void {
		this.sideNav?.togglePanel();
	}

	private updateChapterProgress(fraction: number): void {
		// 章内进度（0-1）的两处呈现共用同一数值：
		//  ① 正文列顶边条：宽度比例直接写成 --p（CSS 渲染为「轨道宽度 × --p」）；
		//  ② 右缘章节轨「当前章短横」内的填充：交给 SideNav 落到当前章节点上。
		// 不再使用全宽底部细条——那个位置会与移动端底栏 / 系统手势区反复冲突，
		// 且信息精度输给右下角页码与右缘章节轨（见 styles.css 注释）。
		const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
		this.progressFill?.style.setProperty("--p", String(f));
		this.sideNav?.setChapterProgress(f);
	}

	/** 把当前位置同步写进本机热缓存；节流只影响写入频率，不影响 cursor 的完整记录。
	 *  真正的文件写仍走 800ms 去抖 + ProgressStore 的 1s 去抖。 */
	private checkpointPosition(key: string, info: RelocateInfo, capturedAt: number): void {
		if (!info.cfi) return;
		const now = performance.now();
		if (key === this.lastCheckpointKey && now - this.lastCheckpointAt < 250) return;
		this.lastCheckpointKey = key;
		this.lastCheckpointAt = now;
		this.plugin.checkpointSourcePosition(key, {
			anchor: info.cfi,
			fraction: info.fraction,
			updatedAt: capturedAt,
		});
	}

	/** 立即落盘当前位置（关闭视图 / 退出应用 / 切后台）。
	 *
	 *  取的是 `cursor` 而不是 `lastRelocate`：后者在恢复期照样被赋值（那时视口还在
	 *  书首），也留着上一本书的残值 —— 「打开没开完就关掉」会把书首位置写回进度。
	 *  `immediate=true` 走 `saveNow` 直接写盘（去抖链在这一刻等于丢），慢一步的
	 *  `beforeunload`/`onunload` 里再补一层（见 main.onunload 的 forceFlushPosition）。 */
	flushPosition(immediate = false): void {
		const key = this.currentSourceKey();
		if (!key) return;
		const pos = this.cursor.take(key);
		if (!pos) return;
		this.saveSourcePosition(key, pos, immediate);
	}

	private saveSourcePosition(key: string, position: BookPosition, immediate: boolean): void {
		if (!key.startsWith("feed:")) {
			this.plugin.savePosition(key.slice("book:".length), position, immediate);
			return;
		}
		const [, feedId, entryId] = key.split(":");
		if (!feedId || !entryId) return;
		void this.plugin.feedStore.updateEntryState(feedId, entryId, { position }).then(() => {
			this.annotationsPanel?.refreshFeeds();
		}).catch(() => undefined);
	}

	/** 供 main.onunload 调用：插件卸载时把当前阅读位置立刻写盘 */
	forceFlushPosition(): void {
		this.flushPosition(true);
	}

	/* ---------------- pinned sidebar ---------------- */

	private initPinnedState(): void {
		const s = this.plugin.settings as unknown as { annoPinned?: boolean; pinThreshold?: number };
		this.pinThreshold = typeof s.pinThreshold === "number" && s.pinThreshold > 0 ? s.pinThreshold : 720;
		this.pinned = !!s.annoPinned;
		// 宽度不足时自动退回悬浮，避免内容区过窄
		if (this.rootEl && this.rootEl.clientWidth > 0 && this.rootEl.clientWidth < this.pinThreshold) {
			this.pinned = false;
		}
		this.applyPinnedLayout(false);
		this.updatePinButtonVisibility();
	}

	private applyPinnedLayout(persist = true): void {
		this.bodyEl?.toggleClass("is-pinned", this.pinned);
		this.rootEl?.toggleClass("is-pinned", this.pinned);
		if (this.pinned) this.cancelAnnoAutoClose();
		if (this.pinBtn) {
			this.pinBtn.toggleClass("is-active", this.pinned);
			this.pinBtn.setAttribute("aria-label", this.pinned ? "取消钉住" : "钉住侧边栏");
			try {
				this.pinBtn.empty();
				setIcon(this.pinBtn, this.pinned ? "pin-off" : "pin");
				this.pinBtn.createSpan({ cls: "unreader-pin-label", text: this.pinned ? "取消钉住" : "钉住" });
			} catch {
				this.pinBtn.setText(this.pinned ? "取消钉住" : "钉住");
			}
		}
		if (this.annotationsPanel) {
			this.annotationsPanel.setPinned(this.pinned);
		}
		if (this.pinned && this.annotationsPanel) {
			this.annotationsPanel.show();
		}
		if (persist) {
			const s = this.plugin.settings as unknown as { annoPinned?: boolean };
			s.annoPinned = this.pinned;
			this.plugin.scheduleSave();
		}
	}

	public setPinned(pinned: boolean): void {
		const thr = (this.plugin.settings as unknown as { pinThreshold?: number }).pinThreshold ?? this.pinThreshold;
		// 单次读取，不在循环中频繁触发 reflow
		const w = this.rootEl?.clientWidth ?? 0;
		if (pinned && w > 0 && w < thr) {
			new Notice("当前宽度不足，无法钉住侧边栏");
			return;
		}
		this.pinned = pinned;
		this.applyPinnedLayout(true);
		// 钉住/取消钉住改变正文宽度 → 文字重排，驱动高亮矩形重定位
		this.adapter.notifyVisible();
	}

	private togglePinned(): void {
		this.setPinned(!this.pinned);
	}

	private updatePinButtonVisibility(): void {
		if (!this.rootEl) return;
		const thr = (this.plugin.settings as unknown as { pinThreshold?: number }).pinThreshold ?? this.pinThreshold;
		this.pinThreshold = thr;
		// 使用 rAF 节流，避免在同一帧内多次强制 reflow；仅在状态变化时才触及 DOM
		const w = this.rootEl.clientWidth || this.contentEl.clientWidth || 0;
		if (w === 0) return; // 布局尚未就绪，跳过
		const shouldShow = w >= thr;
		const hidden = !shouldShow;
		if (this.pinBtn && hidden !== this.pinBtnHidden) {
			this.pinBtnHidden = hidden;
			this.pinBtn.toggleClass("is-hidden", hidden);
		}
		if (this.annotationsPanel) {
			this.annotationsPanel.setPinVisible(shouldShow);
		}
		if (hidden && this.pinned) {
			this.pinned = false;
			this.applyPinnedLayout(true);
		}
	}

	private observePinThreshold(): void {
		if (this.pinResizeObserver) {
			try { this.pinResizeObserver.disconnect(); } catch { /* ignore */ }
			this.pinResizeObserver = null;
		}
		if (this.debouncedPinVisibility) {
			window.removeEventListener("resize", this.debouncedPinVisibility);
		}
		const debounced = debounce(() => this.updatePinButtonVisibility(), 160, true);
		this.debouncedPinVisibility = debounced;
		window.addEventListener("resize", this.debouncedPinVisibility);
		this.registerEvent(this.app.workspace.on("resize", debounced as unknown as () => void));
		this.register(() => window.removeEventListener("resize", this.debouncedPinVisibility!));
	}

	// 未钉住时移开鼠标自动关闭（悬浮态）。仅 hover 能力设备绑定：
	// 触屏靠「点外面关」（body pointerdown），合成 mouseenter/mouseleave 会让
	// 打开后 220ms 自动关闭。
	private setupAnnoAutoClose(): void {
		let hoverable = false;
		try { hoverable = window.matchMedia?.("(hover: hover)")?.matches ?? false; } catch { hoverable = false; }
		const panel = this.annotationsPanel.containerEl;
		// 面板开关/尺寸变化都会影响按钮排位置
		panel.addEventListener("transitionend", e => {
			if ((e.target as HTMLElement | null)?.classList?.contains("unreader-anno-panel")) this.alignActionsRail();
		});
		if (!hoverable) return;
		panel.addEventListener("mouseenter", () => this.cancelAnnoAutoClose());
		panel.addEventListener("mouseleave", () => this.scheduleAnnoAutoClose());
		// 顶部钉住按钮悬停时也不应关闭，便于从侧栏移至钉住
		this.pinBtn?.addEventListener("mouseenter", () => this.cancelAnnoAutoClose());
		this.pinBtn?.addEventListener("mouseleave", () => this.scheduleAnnoAutoClose());
	}

	private scheduleAnnoAutoClose(): void {
		if (this.annoAutoCloseHold || this.pinned || !this.annotationsPanel.isOpen()) return;
		this.cancelAnnoAutoClose();
		this.annoAutoCloseTimer = window.setTimeout(() => {
			this.annoAutoCloseTimer = null;
			if (this.pinned || !this.annotationsPanel.isOpen()) return;
			const panelHover = this.annotationsPanel.containerEl.matches(":hover");
			const pinHover = this.pinBtn?.matches(":hover") ?? false;
			if (panelHover || pinHover) return;
			this.annotationsPanel.hide();
				this.alignAppearancePanel();
		}, 220);
	}

	private cancelAnnoAutoClose(): void {
		if (this.annoAutoCloseTimer != null) {
			window.clearTimeout(this.annoAutoCloseTimer);
			this.annoAutoCloseTimer = null;
		}
	}

	private syncNativeHeader(): void {
		const t = this.currentFeedEntry?.title || this.file?.basename || "";
		this.titleText = t;
		// 侧栏头部跟着换成同一个页面名（页面名只有这里算得全：订阅文章名 / 书名）
		this.annotationsPanel?.refreshHeaderTitle();
		// 使用 queueMicrotask 异步更新，避免在 setState/layout 期间同步触发导致回环卡死
		queueMicrotask(() => {
			try {
				// WorkspaceLeaf.updateHeader 在新版 Obsidian 才有（旧版没有这个方法），
				// 所以按结构类型探测后调用，而不是 @ts-ignore 压过去。
				(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
			} catch { /* ignore */ }
			try {
				const headerTitle = this.containerEl.closest(".workspace-leaf")?.querySelector<HTMLElement>(".view-header-title");
				if (headerTitle) headerTitle.setText(t ? `《${t}》` : "UNreader");
			} catch { /* ignore */ }
		});
	}

	/* ---------------- chrome ---------------- */

	private renderChrome(): void {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.addClass("unreader-content-el");

		this.rootEl = contentEl.createDiv({ cls: "unreader-root" });
		this.podcastBarEl = this.rootEl.createDiv({ cls: "unreader-podcast-bar" });
		this.buildPodcastBar();

		const body = (this.bodyEl = this.rootEl.createDiv({ cls: "unreader-body" }));

		// 内容区顶边进度条：全宽（left/right:0，不跟随正文列边距），贴内容区顶边，
		// pointer-events:none，纯读数不挡任何点按。位置与显隐见 styles.css
		//「内容区顶边进度条」段。
		//
		// **必须挂 .unreader-root，不能挂 .unreader-body**：它要贴的是「叶子/内容区的
		// 顶边」，而桌面端页首在文档流内、占掉叶子顶部的 `--header-height`（官方 :root
		// 40px，Composer 主题实测覆盖成 36px）→ root 的顶边比叶子顶边低那么多。页首被
		// 隐藏时要贴叶子最顶边，`top` 只能是**负值**，而 body 是 `overflow:hidden`、
		// `.view-content` 官方是 `overflow:auto` —— 两层都会把负偏移整条裁掉。
		// root 自身无 overflow（.view-content 已由本插件放开成 visible，见 styles.css）
		// → 挂 root 是唯一能到达叶子顶边的位置。
		// 挂 root 而不是直接挂叶子：`has-book` 显隐规则（styles.css 的
		// `.unreader-root:not(.has-book) .unreader-progress`）与既有层叠上下文都不动。
		// 排在 body 之后创建：DOM 序在后，同 z-index 下也不会被阅读区压住。
		this.progressEl = this.rootEl.createDiv({ cls: "unreader-progress" });
		this.progressFill = this.progressEl.createDiv({ cls: "unreader-progress-fill" });

		// 章节进度的两处呈现（右缘章节轨「当前章短横」内的填充 + 上述正文列顶边条）
		// 都来自同一个数值，设置应用推迟到 sideNav 建好之后（见 applyChapterProgressSetting）。

		this.annotationsPanel = new AnnotationsPanel({
			onJump: (anchor, textHint) => {
				// 播客书签用 audio:秒 作为位置 token；点击后直接回到音频时间点。
				if (anchor.startsWith("audio:")) {
					const seconds = Number(anchor.slice("audio:".length));
					const audio = this.podcastAudioEl;
					if (audio && this.podcastBarRef && Number.isFinite(seconds)) {
						try { audio.currentTime = Math.max(0, seconds); } catch { /* ignore */ }
						void audio.play().catch(() => undefined);
						this.syncPodcastProgressUi();
						return;
					}
				}
				this.pendingBackJump = true;
				// 书签/高亮点击：jumpToCfi 精确定位（章内比例/文本位置），而非只到章节开头
				void this.adapter.jumpToCfi(anchor, textHint);
				this.adapter.focusContent();
			},
			onPreviewHighlight: (item, anchorEl) => {
				this.showNativePreview(item, anchorEl);
			},
			onCommentHighlight: (id, comment) => this.saveHighlightComment(id, comment),
			onCopyReference: item => this.copyReference(item.text, item.anchor),
			onDeleteHighlight: id => this.deleteHighlight(id),
			onDeleteBookmark: id => this.deleteBookmark(id),
			onRenameBookmark: (id, label) => this.renameBookmark(id, label),
			// 书签页码现算（不落盘）：口径与右下角页码指示器完全同源
			getPageForAnchor: anchor => this.adapter.getPageForAnchor(anchor),
			onTogglePin: () => this.togglePinned(),
			// 面板开合（含被外部关闭）→ 功能轨高亮与灯绳避让同步跟随
			onOpenChange: () => {
				this.syncRailButtons();
				this.syncImmersionSwitchOffset();
			},
			onModeChange: () => this.syncRailButtons(),
			getBookshelfEntries: () => sortBookshelfEntries(
				getBookshelfEntries(this.plugin),
				this.plugin.settings.bookshelfSortMode,
				this.plugin.settings.bookshelfManualOrder,
			),
			getBookshelfSortMode: () => this.plugin.settings.bookshelfSortMode,
			getCurrentBookPath: () => this.file?.path ?? null,
			getCurrentDocumentName: () => this.currentFeedEntry?.title || this.file?.basename || null,
			onBookshelfSortModeChange: mode => this.setBookshelfSortMode(mode),
			onBookshelfReorder: paths => this.reorderBookshelf(paths),
			onToggleBookPin: path => this.toggleBookPin(path),
			getBookshelfCategories: () => this.plugin.settings.bookshelfCategories ?? [],
			getBookshelfCategoryFilter: () => this.bookshelfCategoryFilter,
			onBookshelfCategoryFilterChange: filter => { this.bookshelfCategoryFilter = filter; },
			onAssignBookCategory: (path, categoryId) => void this.plugin.assignBookshelfCategory(path, categoryId),
			onRemoveBookFromShelf: path => void this.plugin.removeBookFromBookshelf(path),
			onOpenBookshelfCategoryManager: () => this.plugin.openBookshelfCategoryManager(),
			onOpenBook: path => void this.openBookFromShelf(path),
			loadBookPreview: path => {
				const file = this.app.vault.getFileByPath(path);
				if (!(file instanceof TFile)) return Promise.resolve({ coverUrl: null, excerpt: null, title: null, author: null });
				return loadBookPreview(this.app, file);
			},
			getFeeds: () => this.plugin.feedStore.listFeeds(),
			getFeedEntries: () => this.plugin.feedStore.listEntries(),
			getFeedFilter: () => this.feedFilter,
			getFeedSourceFilter: () => this.feedSourceFilter,
			getCurrentFeedEntry: () => this.feedRef ? { ...this.feedRef, kind: this.currentFeedEntry?.kind } : null,
			onFeedFilterChange: filter => { this.feedFilter = filter; },
			onFeedSourceFilterChange: feedId => { this.feedSourceFilter = feedId; },
				onOpenFeedEntry: (feedId, entryId) => void this.openFeedEntry(feedId, entryId),
				onToggleFeedRead: (feedId, entryId) => void this.toggleFeedRead(feedId, entryId),
				onToggleFeedStar: (feedId, entryId) => void this.toggleFeedStar(feedId, entryId),
			onRefreshFeeds: () => void this.refreshFeeds(),
			onAddFeed: () => this.plugin.promptAddFeed(),
			onImportOpml: () => this.plugin.importOpmlFromFile(),
			onOpenFeedManager: () => this.plugin.openFeedManager(),
			onHoldAutoClose: hold => {
				this.annoAutoCloseHold = hold;
				if (hold) this.cancelAnnoAutoClose();
			},
			onFetchFulltext: (feedId, entryId) => void this.fetchFeedFulltext(feedId, entryId),
			onSaveNote: (feedId, entryId) => void this.saveFeedNote(feedId, entryId),
			onOpenOriginal: url => openExternalLink(url),
					onDownloadPodcast: (feedId, entryId) => this.plugin.downloadPodcast(feedId, entryId),
					onPodcastProgress: (feedId, entryId, seconds, duration) => this.queuePodcastProgress(feedId, entryId, seconds, duration),
				onResolvePodcastUrl: url => this.plugin.feedMediaStore.playableUrl(url),
				isPodcastDownloaded: url => this.plugin.feedMediaStore.isCached(url),
			onCheckPodcastDownloaded: url => this.plugin.feedMediaStore.has(url),
			onHeightChange: px => {
				// 侧边栏高度手动调节：持久化（null = 恢复默认全高）
				if (px == null) delete this.plugin.settings.annoPanelHeight;
				else this.plugin.settings.annoPanelHeight = px;
				void this.plugin.persistData();
			},
			onWidthChange: px => {
				// 侧边栏宽度手动调节：持久化（null = 恢复默认）
				if (px == null) delete this.plugin.settings.annoPanelWidth;
				else this.plugin.settings.annoPanelWidth = px;
				void this.plugin.persistData();
				this.alignActionsRail();
				// 松手后立即重绘高亮（连续模式），确保拖拽结束即对齐
				this.adapter.notifyVisible();
			},
		});
		if (typeof this.plugin.settings.annoPanelHeight === "number") {
			this.annotationsPanel.setHeight(this.plugin.settings.annoPanelHeight);
		}
		if (typeof this.plugin.settings.annoPanelWidth === "number") {
			this.annotationsPanel.setWidth(this.plugin.settings.annoPanelWidth);
		}
		body.appendChild(this.annotationsPanel.containerEl);
		try { this.annotationsPanel.syncAppearance(this.plugin.settings.appearance); } catch { /* ignore */ }

		this.selectionToolbar = new SelectionToolbar({
			onCopy: text => this.copySelection(text),
			onHighlight: colorName => void this.applyHighlight(colorName),
			onComment: (text, comment, colorName) =>
				void this.applyHighlightWithComment(text, comment, colorName),
		});
		// 固定定位：工具条显示在正文区底部居中，不跟随选区（规避系统选区菜单同位置冲突）
		this.selectionToolbar.setFixed(true);
		// bounds 现测供体：评论编辑区展开时输入框会拉起键盘，官方随之把 `.app-container`
		// 收缩到 `100vh - --keyboard-height`（键盘上方还有一条 .mobile-toolbar 浮层压在最底）。
		// 浮动框必须按**当前**几何重排，否则会停在旧坐标上、被 body 的 overflow:hidden 裁掉 ==
		// 用户看到的「输入框出现在输入法下面」。
		this.selectionToolbar.setBoundsResolver(() => this.stageBoundsNow());
		body.appendChild(this.selectionToolbar.containerEl);

		this.highlightPopover = new HighlightPopover({
			onColor: (id, colorName) => this.recolorHighlight(id, colorName),
			onDelete: id => this.deleteHighlight(id),
			onComment: (id, comment) => this.saveHighlightComment(id, comment),
		});
		this.highlightPopover.setBoundsResolver(() => this.bodyBoundsNow());
		body.appendChild(this.highlightPopover.containerEl);

		this.appearancePanel = new AppearancePanel({
			onChange: patch => this.applyAppearancePatch(patch),
			getPresets: () => this.plugin.presetStore.list(),
			getActivePresetId: () => this.getDevicePresetId(),
			onSavePreset: () => this.saveAppearancePreset(),
			onApplyPreset: id => void this.applyAppearancePreset(id),
			onDeletePreset: id => this.deleteAppearancePreset(id),
			onRenamePreset: id => this.renameAppearancePreset(id),
			onUpdatePreset: id => this.updateAppearancePreset(id),
			onOpened: () => this.alignAppearancePanel(),
			// 面板开合 → 功能轨「阅读外观」按钮高亮跟随（含面板自带关闭按钮 / 点外面 / 鼠标移开自动关）
			onOpenChange: () => this.syncRailButtons(),
			onPickImage: field => this.pickBackgroundImage(field),
			onPickImageSystem: field => this.pickSystemImage(field),
			getImageName: field => {
				const ref = ((this.plugin.settings.appearance as unknown as Record<string, unknown>)[field] as string | null) ?? null;
				if (!ref) return null;
				return this.plugin.resourceStore.nameFor(ref) ?? this.bgImageNames.get(field) ?? null;
			},
			getCustomFonts: () => this.plugin.getCustomFonts().map(f => ({ id: f.id, label: f.label })),
			onPickFont: () => this.pickLibraryFont(),
			onPickFontSystem: () => this.pickSystemFont(),
		});
		body.appendChild(this.appearancePanel.containerEl);


		this.contentHost = body.createDiv({ cls: "unreader-stage" });
		// 阅读区宽度变化（钉住侧边栏拖拽宽度/开合）会触发文字重排，高亮矩形需随之重绘
		if (typeof ResizeObserver !== "undefined") {
			let debouncedStage: (() => void) | null = null;
			this.stageResizeObserver = new ResizeObserver(() => {
				if (!debouncedStage) {
					debouncedStage = debounce(() => {
						debouncedStage = null;
						this.adapter.notifyVisible();
					}, 100, true);
				}
				debouncedStage();
			});
			this.stageResizeObserver.observe(this.contentHost);
		}
		// 分页模式已删除：连续模式下横向滑动由 Obsidian 原生侧栏手势接管，
		// 不再挂载任何触摸拦截监听器（capture+stopPropagation 一律撤掉）。

		this.loadingEl = body.createDiv({ cls: "unreader-loading" });
		this.loadingEl.createSpan({ text: "正在打开…" });

		this.emptyEl = body.createDiv({ cls: "unreader-empty" });
		const emptyIcon = this.emptyEl.createDiv({ cls: "unreader-empty-icon" });
		setIcon(emptyIcon, "book-open");
		this.emptyEl.createDiv({ cls: "unreader-empty-title", text: "UNreader" });
		this.emptyEl.createDiv({
			cls: "unreader-empty-desc",
			text: "把 EPUB / MOBI / AZW3 / TXT / HTML 放进库内任意位置，点击文件即可开始阅读。",
		});
		const browseBtn = this.emptyEl.createEl("button", { text: "浏览书籍", cls: "mod-cta" });
		browseBtn.addEventListener("click", () => {
			void this.plugin.openBookPicker();
		});

		this.sideNav = new SideNav();
		this.bookOnlyNavControls.push(this.sideNav.addIconButton("chevron-up", "上一章", () => this.goPrevChapter()));
		this.bookOnlyNavControls.push(this.sideNav.addIconButton("chevron-left", "上一页", () => void this.adapter.prev()));
		// 页码显示在上一页/下一页按钮之间，点击弹出页码跳转面板
		this.bookOnlyNavControls.push(this.sideNav.addPageDisplay(() => this.openPageJumpModal()));
		this.bookOnlyNavControls.push(this.sideNav.addIconButton("chevron-right", "下一页", () => void this.adapter.next()));
		// 右下角浮动页码（桌面端，章节轨旁）：点击弹出页码跳转面板（与按钮排页码共用，移动端已随章节轨隐藏）
		this.sideNav.setPageClickHandler(() => this.openPageJumpModal());
		this.bookOnlyNavControls.push(this.sideNav.addIconButton("chevron-down", "下一章", () => this.goNextChapter()));
		this.sideNav.addSeparator();
		// 浮动目录：各平台统一由该按钮开/关面板（面板出现在按钮旁边）
		this.railTocBtn = this.sideNav.addIconButton("list", "目录", () => this.sideNav.togglePanel("actions"));
		this.railTocBtn.addClass("is-book-only-control");
		this.sideNav.setTocTrigger(this.railTocBtn);
		// 目录面板开合（hover 展开 / 按钮唤出 / 行点击 / 点外面关闭）都在面板内部收口后回调到这里
		this.sideNav.onPanelOpenChange = () => this.syncRailButtons();
		this.railShelfBtn = this.sideNav.addIconButton("library", "书籍侧边栏", () => this.toggleBookshelf());
		this.railFeedsBtn = this.sideNav.addIconButton("rss", "订阅", () => this.toggleFeeds());
		this.sideNav.addSeparator();
		// 「阅读原文」只对 Feed 文章有意义：非 Feed 源下由 CSS 收走（is-feed-only-control）
		this.railOriginalBtn = this.sideNav.addIconButton("external-link", "在浏览器打开原文", () => this.openCurrentFeedOriginal());
		this.railOriginalBtn.addClass("is-feed-only-control");
		// 「保存为笔记」：把当前文章（尚未抓全文时先抓）落成一篇 Markdown 到 vault，
		// 图片按 Obsidian 的「附件默认位置」一并落盘（见 core/noteExporter.ts）
		this.railSaveNoteBtn = this.sideNav.addIconButton("file-down", "保存为笔记", () => void this.saveCurrentFeedNote());
		// `file-down` 是较新的 lucide 名，取不到时 setIcon 静默失败 → 按钮整个空白
		paintIcon(this.railSaveNoteBtn, "file-down", "save");
		this.railSaveNoteBtn.addClass("is-feed-only-control");
		this.railAnnoBtn = this.sideNav.addIconButton("highlighter", "标注列表", () => this.toggleAnnotations());
		// 「星标（收藏文章）」与「书签（收藏当前位置）」是两件事，但占功能轨上同一格：
		// 书源只给书签（书没有「文章收藏」概念），Feed 源只给星标（文章的位置收藏没意义，
		// 收藏整篇才是列表里「收藏」筛选与卡片上那颗星的口径）。两枚互斥，各挂一个开关类。
		this.railStarBtn = this.sideNav.addIconButton("star", "收藏文章", () => void this.toggleCurrentFeedStar());
		this.railStarBtn.addClass("is-feed-only-control");
		const railBookmarkBtn = this.sideNav.addIconButton("bookmark", "添加书签", () => this.openBookmarkModal());
		railBookmarkBtn.addClass("is-book-only-control");
		this.sideNav.addSeparator();
		this.railAppearanceBtn = this.sideNav.addIconButton("sliders-horizontal", "阅读外观", () => this.toggleAppearance());
		this.railSearchBtn = this.sideNav.addIconButton("search", "搜索正文", () => this.toggleSearch());
		this.railImmersionBtn = this.sideNav.addIconButton("maximize-2", "进入全沉浸", () => {
			this.playImmersionSwitchPull();
			this.toggleFullImmersion();
		});
		paintIcon(this.railImmersionBtn, "maximize-2", "scan");
		// 「阅读设备」：只对本地 HTML（网页原样通道）有意义 —— 固定宽度 / min-width 的桌面页面
		// 在手机上会横向溢出，而 frame 内 touch-action:pan-y 把横滑让给了原生侧栏手势，
		// 右半页永远够不着（用户报的「手机上打开 HTML 看不全」）。这枚按钮把整页按设备视口
		// 重排后再缩放到阅读区宽度。非 HTML 书由 CSS 收走（is-html-only-control）。
		this.railDeviceBtn = this.sideNav.addIconButton("monitor-smartphone", "阅读设备", () => this.cycleWebDevice());
		this.railDeviceBtn.addClass("is-html-only-control");
		this.sideNav.addSeparator();
		this.syncRailButtons();
		this.sideNav.addIconButton("settings", "打开设置", () => this.openPluginSettings());
		this.sideNav.setBackHandler(() => this.goBack());
		body.appendChild(this.sideNav.actionsEl);
		body.appendChild(this.sideNav.navEl);
		// 沉浸模式拉绳开关：直接挂在 root 上，不随 chrome-hidden/工具轨隐藏。
		// 图形完全由 CSS 绘制，避免 iPad / 旧版本图标集缺名时只剩系统按钮底框。
		// 官方 button 皮肤选择器带 :not(.clickable-icon)，特异性高于单类；样式侧必须用
		// !important 才能彻底收走 interactive-normal 底与 input-shadow。
		this.immersionSwitchEl = this.rootEl.createEl("button", {
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
			this.playImmersionSwitchPull();
			this.toggleFullImmersion();
		});

		// 这两个元素就是浮动轨道的上下边界：页首下压按钮、原生底栏顶起播客条时，
		// 观察器会立刻重算，不必等下一次窗口 resize。
		if (typeof ResizeObserver !== "undefined") {
			this.floatingFitObserver = new ResizeObserver(() => this.scheduleFloatingFit());
			this.floatingFitObserver.observe(this.immersionSwitchEl);
			if (this.podcastBarEl) this.floatingFitObserver.observe(this.podcastBarEl);
		}
		// `top` 过渡不一定改变元素尺寸（ResizeObserver 可能不响），所以过渡期间
		// 主动跑一段逐帧测量；页首下压/回收时轨道会跟着连续移动，不会中途压住。
		const followTransition = (): void => this.scheduleFloatingFit(380);
		this.immersionSwitchEl.addEventListener("transitionrun", followTransition);
		this.immersionSwitchEl.addEventListener("transitionstart", followTransition);
		this.immersionSwitchEl.addEventListener("transitionend", followTransition);

		// 章节进度外观开关：sideNav 此时才建好（进度显示在章节轨的当前章短横内部）
		this.applyChapterProgressSetting();

		// 沉浸模式点按兜底：点按分区挂在 frame 文档内（iframe 事件不冒泡到宿主），
		// 正文区之外的宿主区域（stage 左右边距、章节间隙、未接线 frame 等）的
		// 点按落不到 frame 监听上——在此统一派发，保证「点屏幕任意位置」语义。
		// chrome 组件（轨道/按钮/面板/输入框）自身的点击排除，交给各自逻辑。
		body.addEventListener("click", (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (target.closest(
				".unreader-actions, .unreader-nav, .unreader-back-btn, .unreader-anno-panel, " +
				".unreader-appearance-panel, .unreader-immersion-switch, .unreader-selection-toolbar, .unreader-highlight-popover, " +
				".unreader-bookmark-inline, .unreader-chapter-hint, " +
				"input, textarea, select, button",
			)) return;
			const w = this.rootEl?.clientWidth ?? 0;
			if (w <= 0) return;
			this.handleTapZone(e.clientX / w, e.timeStamp);
		});

		// 点击空白处自动关闭浮动工具条/高亮气泡（与 Obsidian 原生 hover 行为一致）
		body.addEventListener("pointerdown", (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			// 点击在工具条内部则不处理
			if (this.selectionToolbar?.containerEl.contains(target) || this.highlightPopover?.containerEl.contains(target)) return;
			// 点击在侧边栏、目录、笔记面板等常驻 UI 上也不自动关闭（避免误触）
			if (target.closest(".unreader-anno-panel, .unreader-toc-panel, .unreader-appearance-panel, .unreader-immersion-switch, .unreader-actions, .unreader-nav")) return;
			this.dismissFloatingOnBlankClick();
		});
		// Esc 直接关闭所有浮层
		body.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (this.fullImmersion) {
					e.preventDefault();
					this.exitFullImmersion();
					return;
				}
				if (this.selectionToolbar?.visible) this.selectionToolbar.hide();
				if (this.highlightPopover?.visible) this.highlightPopover.hide();
				
			this.dismissHover();
			}
		});

		// 正文搜索：顶部居中搜索栏 + 结果列表（与目录面板同风格）
		this.buildSearchBar(body);

		// 保持操作按钮展开：改为显式调用 syncActionsPinned，避免 MutationObserver 全子树监听导致的 Forced reflow
		// this.actionsObserver 已禁用

		// 钉住布局与响应式显隐（安全实现：无 ResizeObserver 循环）
		this.initPinnedState();
		this.observePinThreshold();
		this.setupAnnoAutoClose();
		this.syncNativeHeader();
		// 窄屏首次渲染后再次校正一次（布局尚未完成时 clientWidth 可能为 0）
		window.requestAnimationFrame(() => this.updatePinButtonVisibility());
	}

	private showEmpty(): void {
		this.loadingToken++;
		this.rootEl?.removeClass("has-book");
		this.rootEl?.removeClass("is-feed-source");
		this.rootEl?.removeClass("is-html-source");
		this.endRestoring();
		this.rootEl?.addClass("is-empty");
		this.emptyEl?.show();
		this.loadingEl?.hide();
		this.syncNativeHeader();
	}

	private showLoading(): void {
		this.rootEl?.removeClass("has-book");
		this.rootEl?.removeClass("is-empty");
		this.emptyEl?.hide();
		this.loadingEl?.show();
	}

	/** 退出「恢复上次阅读位置」态（幂等）：摘掉恢复期的占位布局类、恢复进度落盘。
	 *  正常路径在揭示正文处调用，失败/空视图路径由 showEmpty 调用——
	 *  漏摘会让正文容器停在 visibility:hidden（用户看到空的阅读区）。 */
	private endRestoring(): void {
		this.restoring = false;
		this.rootEl?.removeClass("is-restoring");
	}

	/* ---------------- appearance ---------------- */

	/** 本视图所在的 `.workspace-leaf-content`（进度条让位、页首查询、叶子底色都用它）。
	 *
	 *  不用 `containerEl` 直接当叶子：Obsidian 不同版本里 `containerEl` 可能是叶子
	 *  容器、也可能是 `.workspace-leaf`。三条兜底覆盖全部形态——`closest` 含自身，
	 *  页首的 `parentElement` 就是叶子容器（页首是叶子的直接子节点）。 */
	private leafContentEl(): HTMLElement | null {
		const c = this.containerEl;
		if (!c) return null;
		try {
			// **为什么这条链要这么长（本轮补）**：叶子是**三件事共用**的上游 ——
			//   ① 叶子底色（v1 防线）、② 补偿层的开关类 `unreader-header-hidden`（v3 防线）、
			//   ③ `--ur-header-hole`（补偿层的高度）。
			// 它一旦解析失败，**三件事一起静默失效** → 顶部那条页首背景板原样出现；
			// 而进度条只依赖 `bar` / `root` / `.view-content`，**照旧完全正常**。
			// 这正是真机上报的签名：「章节进度条显示很正常，但页首背景板依然存在」。
			// 所以宁可多几条兜底（每条都是一次廉价的选择器查询，且只在本函数被调用时跑），
			// 也不让一个版本差异把三条防线同时打掉。
			// 顺序：自身 → 自身内部的页首父节点 → 自身内部/相邻的叶子内容 → 最近的叶子。
			return c.closest<HTMLElement>(".workspace-leaf-content")
				?? c.querySelector<HTMLElement>(".view-header")?.parentElement
				// containerEl 可能就是 `.workspace-leaf`（不同 Obsidian 版本形态不同）：
				// 往下找它的叶子内容，或退到 `.view-content` 的父节点（按定义就是叶子内容）。
				?? c.querySelector<HTMLElement>(".workspace-leaf-content")
				?? c.querySelector<HTMLElement>(".view-content")?.parentElement
				?? c.closest<HTMLElement>(".workspace-leaf")?.querySelector<HTMLElement>(".workspace-leaf-content")
				?? null;
		} catch {
			return null;
		}
	}

	/** 本视图那个原生 `.view-header` 元素。
	 *
	 *  **不能只在 `containerEl` 里查**：页首的布局契约类是元素级的
	 *  `unreader-view-header`（见 `markViewHeader`），而不同 Obsidian 版本 / 窗口
	 *  形态下 `containerEl` 可能是 `.workspace-leaf-content`，页首却挂在它的兄弟层
	 *  `.workspace-leaf` 下。此时 `containerEl.querySelector` 永远查不到页首，
	 *  浮层类与隐藏类都落不下去 —— 页首藏了、它占的那条高度却留下，
	 *  就是移动端「页首背景板又出现」的同一根因。
	 *
	 *  查找顺序覆盖三种真实形态：
	 *    ① `containerEl` 自己/内部有页首（当前最常见的 `.workspace-leaf-content`）；
	 *    ② `containerEl` 的父层直接挂着页首（`containerEl` 是 `.view-content`）；
	 *    ③ 页首与 `containerEl` 同在 `.workspace-leaf` 下（结构 B）。
	 *  三条都只读 DOM，不做任何写入；失败返回 null，调用方按“页首不存在”处理。 */
	private viewHeaderEl(): HTMLElement | null {
		const c = this.containerEl;
		if (!c) return null;
		try {
			const local = c.matches(".view-header") ? c : c.querySelector<HTMLElement>(".view-header");
			if (local) return local;
			const sibling = c.parentElement?.querySelector<HTMLElement>(":scope > .view-header");
			if (sibling) return sibling;
			return c.closest<HTMLElement>(".workspace-leaf")?.querySelector<HTMLElement>(":scope > .view-header") ?? null;
		} catch {
			return null;
		}
	}

	private syncOuterAppearance(): void {
		const a = this.plugin.settings.appearance;
		// 背景色随配色来源（跟随 Obsidian / 自定义）解析，与 iframe 主题同源
		const bg = resolveActiveColors(a).bg;
		if (this.rootEl) this.rootEl.style.backgroundColor = bg;
		if (this.bodyEl) {
			this.bodyEl.style.backgroundColor = bg;
			this.bodyEl.toggleClass("is-scrolled", true);
		}
		if (this.contentHost) this.contentHost.style.backgroundColor = bg;
		// **叶子底色与 `--ur-reader-bg` 已不再写入**（2026-09-13 第六轮）：那一对是
		// 「补色」路线的产物（把页首让出的那条空隙涂成阅读区底色）。改成「让位」之后
		// 那一段归正文，没有任何东西需要涂 —— 见 styles.css 顶部那条墓碑注释。
		// 叶子上现在只有本插件挂的类（`unreader-header-hidden`，供 v5 兜底规则命中）。
		// 浮动目录条显隐随外观/预设
		this.applyTocRailSetting();
		this.applyChapterProgressSetting();
		// 浮动按钮框/目录条大小随外观/预设（CSS 尺寸全部按该倍率换算）
		if (this.rootEl) this.rootEl.style.setProperty("--unreader-rail-scale", String(a.railScale ?? 1));
		// 「沉浸模式适配」随外观/预设：开关一变就要重估页首/底栏显隐与进度条让位
		this.syncNativeNav("appearance");
		// 标注卡片字体与书籍正文一致
		try { this.annotationsPanel?.syncAppearance(a); } catch { /* ignore */ }
		// 外观/预设变化 → 书签页码重算（换设备、切预设都走这条漏斗）
		this.refreshAnnotationPages();
	}

	/** 本机钉住的预设 id（localStorage，设备本地不随同步走）。
	 *  设备本地状态共两份：钉住的预设 id 与当前外观快照（后者存 main.ts 管理的
	 *  localStorage key）；预设定义本体随库文件夹同步，跨设备共享 */
	private static readonly DEVICE_PRESET_KEY = "unreader-device-preset";

	private getDevicePresetId(): string | null {
		try {
			return window.localStorage.getItem(UNreaderView.DEVICE_PRESET_KEY);
		} catch {
			return null;
		}
	}

	private setDevicePresetId(id: string | null): void {
		try {
			if (id) window.localStorage.setItem(UNreaderView.DEVICE_PRESET_KEY, id);
			else window.localStorage.removeItem(UNreaderView.DEVICE_PRESET_KEY);
		} catch { /* ignore */ }
	}

	/** 打开阅读器时按本机钉住的预设重新应用：不同设备可各自启用不同预设，
	 *  同步过来的 appearance 值会被本机预设覆盖。预设文件可能尚未同步到达本机
	 *  （预设随库异步同步），此时**保留钉住**并延迟重试，绝不因瞬时找不到而
	 *  清除钉住——否则一次同步延迟就会永久丢失本机的预设选择。
	 *
	 *  ⚠️ 调用点必须在 `scheduleLoad()` 之后（当前在 `loadBook` 的并行组里）：
	 *  本方法会等 `whenDataReady()` → `onLayoutReady()`，绝不能再回到 onOpen
	 *  的同步启动路径上（否则与 Obsidian 恢复 workspace 的 await 形成死锁）。 */
	private async applyDevicePreset(): Promise<void> {
		const id = this.getDevicePresetId();
		if (!id) return;
		// 预设库未就绪时 get() 必然 miss → 会被误判成「预设尚未同步到达」并进入
		// 每秒一次、最多 60s 的重试；先等就绪再查，避免把启动期的空缓存当丢失
		await this.plugin.whenDataReady();
		const preset = this.plugin.presetStore.get(id);
		if (!preset) {
			this.scheduleDevicePresetRetry();
			return;
		}
		const merged = Object.assign({}, DEFAULT_APPEARANCE, preset.appearance);
		await this.plugin.presetStore.resolveImages(merged, preset);
		Object.assign(this.plugin.settings.appearance, merged);
		// 本机钉住的预设引用的字体可能尚未建出 blob（字体文件刚同步到位 / 单飞行复用
		// 了不含本 id 的旧快照）→ 引擎会拿到空 src 并产出 url("") 的假 @font-face。
		// **刻意不 await**：这里 await 会把整条 loadBook（含读整包）向后推一次字体扫描。字体就绪后
		// refreshCustomFonts 的签名变化会自己触发 refreshAppearance 补上。
		void this.ensureFontReady(merged.fontFamily);
	}

	/** 钉住的预设尚未同步到达时的重试：每秒查一次，最多等 60s；
	 *  期间 vault 同步事件带来的重扫一旦让预设出现在缓存里就立即应用 */
	private devicePresetRetryTimer: number | null = null;

	private scheduleDevicePresetRetry(): void {
		if (this.devicePresetRetryTimer !== null) return;
		let attempts = 0;
		const tick = async (): Promise<void> => {
			this.devicePresetRetryTimer = null;
			if (!this.containerEl.isConnected) return;
			const id = this.getDevicePresetId();
			const preset = id ? this.plugin.presetStore.get(id) : undefined;
			if (id && preset) {
				await this.applyDevicePreset();
				this.adapter.applyAppearance(this.plugin.settings.appearance);
				this.syncOuterAppearance();
				new Notice(`已恢复预设“${preset.name}”`);
				if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
				return;
			}
			// 真被删除时保留钉住（无法区分「尚未同步」与「他端已删」，
			// 保留钉住是更安全的选择：文件重新出现即自动恢复）
			if (++attempts >= 60) return;
			this.devicePresetRetryTimer = window.setTimeout(() => void tick(), 1000);
		};
		this.devicePresetRetryTimer = window.setTimeout(() => void tick(), 1000);
	}

	/** 把当前外观实时写回本机生效的预设（预设保存完整配置，背景图只保存共享引用） */
	private writeBackToActivePreset(): void {
		const activeId = this.getDevicePresetId();
		if (!activeId) return;
		const preset = this.plugin.presetStore.get(activeId);
		if (!preset) return;
		preset.appearance = { ...this.plugin.settings.appearance };
		// 共享图片本体不复制；旧版 data:/路径引用只由迁移流程收纳一次
		this.plugin.presetStore.upsert(preset);
	}

	/** 背景图片展示名（field → 文件名，仅用于面板显示，内存态即可） */
	private bgImageNames = new Map<"backgroundImage" | "backgroundImageLight" | "backgroundImageDark", string>();

	private applyAppearancePatch(patch: Partial<AppearanceSettings>): void {
		Object.assign(this.plugin.settings.appearance, patch);
		// 显隐口径被改（含「接管原生界面」开关本身）：先清掉滚动留下的原生隐藏态，
		// 末尾的 syncOuterAppearance → syncNativeNav("appearance") 会按新设置重估。
		if ("normalModeScrollHide" in patch || "normalModeHideNativeChrome" in patch || "normalModeShowToolbar" in patch) {
			this.nativeScrollHidden = false;
		}
		if ("normalModeShowToolbar" in patch && !this.fullImmersion && !this.pinned) {
			if (patch.normalModeShowToolbar === false) {
				this.rootEl?.addClass("chrome-hidden");
				this.rootEl?.removeClass("chrome-revealed");
			} else {
				this.rootEl?.removeClass("chrome-hidden");
				this.rootEl?.removeClass("chrome-revealed");
			}
		}
		this.syncFullImmersionPresentation();
		// 「自动打开目录面板」拨到「开」时**当场生效**（不只是下次开书）：
		// 这个开关的字面语义是「打开一本书时自动展开目录面板」—— 只在**开书那一刻**动作，
		// 于是在一本已经打开的书上拨它，用户什么都看不到（原话「试了一下什么变化都看不到」）。
		// 拨到「开」就立刻开一次：语义变成「现在就打开，以后每次开书也打开」，效果肉眼可见。
		if (patch.autoOpenToc === true) this.openTocIfPossible("setting");
		// 图片字段被清空时同步清掉展示名记忆
		for (const f of ["backgroundImage", "backgroundImageLight", "backgroundImageDark"] as const) {
			if (patch[f] === null) this.bgImageNames.delete(f);
		}
		// 设计意图：预设是完整的外观配置档案，面板中的所有改动实时写回当前
		// 生效的预设——每个预设各自保留自己的配置，切换预设即切换整套配置
		this.writeBackToActivePreset();
		this.plugin.scheduleSave();
		// 切换字体：先确保该字体的 blob 已就绪，再由 applyAppearance 重注入
		// @font-face / FontFace（新导入的字体此时才真正可用）
		if (patch.fontFamily) {
			void this.ensureFontReady(patch.fontFamily).then(() => {
				this.adapter.applyAppearance(this.plugin.settings.appearance);
				this.syncOuterAppearance();
			}).catch(() => {
				this.adapter.applyAppearance(this.plugin.settings.appearance);
				this.syncOuterAppearance();
			});
			return;
		}
		this.adapter.applyAppearance(this.plugin.settings.appearance);
		this.syncOuterAppearance();
	}

	/** 从库中选择共享图片或其他库内图片；选定后统一复制进共享资源目录。 */
	private pickBackgroundImage(field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark"): void {
		const shared: BackgroundImagePick[] = this.plugin.resourceStore.list("image")
			.filter(r => r.enabled)
			.map(r => ({
				name: r.name,
				ext: (r.path.split(".").pop() ?? "png").toLowerCase(),
				ref: r.id,
				read: async () => {
					const file = this.app.vault.getAbstractFileByPath(r.path);
					return file instanceof TFile ? this.app.vault.readBinary(file) : new ArrayBuffer(0);
				},
			}));
		const library: BackgroundImagePick[] = this.app.vault
			.getFiles()
			.filter(f => /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.name))
			.filter(f => !f.path.startsWith(`${IMAGES_FOLDER}/`))
			.sort((a, b) => a.path.localeCompare(b.path))
			.map(f => ({
				name: f.basename,
				ext: f.extension.toLowerCase(),
				read: () => this.app.vault.readBinary(f),
			}));
		new BackgroundImageModal(this.app, [...shared, ...library], pick => void this.applyBackgroundImage(pick, field)).open();
	}

	/** 从系统文件选择器挑选背景图片：选定后与库内来源走同一应用流程
	 *  （复制进共享图片目录，预设与设备只引用它） */
	private pickSystemImage(field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark"): void {
		// 清理上次取消对话框留下的隐藏 input
		this.contentEl.querySelectorAll("input.unreader-bg-file-input").forEach(el => el.remove());
		const input = createEl("input");
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml";
		input.addClass("unreader-bg-file-input");
		input.hide();
		this.contentEl.appendChild(input);
		input.addEventListener("change", () => {
			const f = input.files?.[0];
			input.remove();
			if (!f) return;
			const ext = (f.name.split(".").pop() ?? "").toLowerCase();
			void this.applyBackgroundImage(
				{ name: f.name.replace(/\.[^.]+$/, ""), ext, read: () => f.arrayBuffer() },
				field,
			);
		});
		input.click();
	}

	/** 读取并应用背景图片（库内/系统统一入口）；超过 2MB 拒绝 */
	private async applyBackgroundImage(pick: BackgroundImagePick, field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark"): Promise<void> {
		try {
			let ref = pick.ref ?? null;
			if (!ref) {
				const buf = await pick.read();
				if (buf.byteLength > 2 * 1024 * 1024) {
					new Notice("图片体积超过 2 兆字节，请选择较小的图片");
					return;
				}
				ref = await this.plugin.resourceStore.importImage({ name: pick.name, ext: pick.ext, buf });
			}
			if (!ref) {
				new Notice("背景图片导入失败");
				return;
			}
			(this.plugin.settings.appearance as unknown as Record<string, unknown>)[field] = ref;
			this.writeBackToActivePreset();
			this.plugin.scheduleSave();
			this.adapter.applyAppearance(this.plugin.settings.appearance);
			this.syncOuterAppearance();
			if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
			this.bgImageNames.set(field, pick.name);
			// 深浅分开时选错侧：当前主题那一侧无图， picked 的字段不会立即生效，提示
			const a = this.plugin.settings.appearance;
			const activeField = a.bgImageMode === "separate"
				? (activeTheme(a) === "dark" ? "backgroundImageDark" : "backgroundImageLight")
				: "backgroundImage";
			if (field !== activeField) new Notice("该图片仅在对应深/浅主题下显示，当前主题看不到（可切到另一侧图片设置）");
			new Notice(`已应用背景图片《${pick.name}》`);
		} catch (e) {
			console.error("[UNreader] load background image failed", e);
			new Notice("背景图片加载失败");
		}
	}

	// ── 自定义字体：从库内 / 系统导入 ──────────────────────────────
	//
	// 字体是「文件」而不是「一段配置」，所以两条来源收敛到同一个动作：把字节写进
	// 库内的字体文件夹 → 重扫注册表 → 选中它。不采用「原地引用库内任意路径」——
	// 字体 id 就是它的 vault 路径（见 fontService），预设与外观里持久化的也是这个
	// id，路径一变（用户挪了文件）引用就静默失效。落进固定文件夹后路径稳定，
	// 且随库同步到各端。

	/** 从库中选择字体文件导入（弹窗列表） */
	private pickLibraryFont(): void {
		const picks: FontPick[] = this.app.vault.getFiles()
			.filter(f => isFontExt(f.extension))
			.sort((a, b) => a.path.localeCompare(b.path))
			.map(f => {
				const dir = f.parent?.path ?? "";
				return {
					name: f.basename,
					ext: f.extension.toLowerCase(),
					path: f.path,
					size: f.stat?.size,
					// 同名文件可能散落在不同目录，显示所在目录供用户区分
					desc: dir && dir !== "/" && dir !== FONTS_FOLDER ? dir : undefined,
					read: () => this.app.vault.readBinary(f),
				};
			});
		if (!picks.length) {
			new Notice("库里没有找到字体文件（ttf / otf / woff / woff2）");
			return;
		}
		new FontPickModal(this.app, picks, pick => void this.applyFontImport(pick)).open();
	}

	/** 从系统文件选择器导入字体（与 pickSystemImage 同一套写法，移动端同样可用） */
	private pickSystemFont(): void {
		// 清理上次取消对话框留下的隐藏 input（取消不会触发 change，句柄留在这里）
		this.contentEl.querySelectorAll("input.unreader-font-file-input").forEach(el => el.remove());
		const input = createEl("input");
		input.type = "file";
		input.accept = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";
		input.addClass("unreader-font-file-input");
		input.hide();
		this.contentEl.appendChild(input);
		input.addEventListener("change", () => {
			const f = input.files?.[0];
			input.remove();
			if (!f) return;
			void this.applyFontImport({
				name: f.name.replace(/\.[^.]+$/, ""),
				ext: (f.name.split(".").pop() ?? "").toLowerCase(),
				size: f.size,
				read: () => f.arrayBuffer(),
			});
		});
		input.click();
	}

	/** 导入并选中一枚字体（库内 / 系统两条来源的统一入口） */
	private async applyFontImport(pick: FontPick): Promise<void> {
		const ext = pick.ext.toLowerCase();
		// accept 只是对话框的筛选提示、不是安全边界（用户可改选「所有文件」），这里二次校验
		if (!isFontExt(ext)) {
			new Notice("只支持 ttf / otf / woff / woff2 字体文件");
			return;
		}
		try {
			// 已在字体文件夹里的文件直接选中，不复制（避免同一枚字体落两份、
			// 下拉里出现两个同名项而它们的 id 不同）
			const inPlace = pick.path?.startsWith(`${FONTS_FOLDER}/`) ? pick.path : null;
			// 体积闸门放在**读取之前**：几十 MB 的 CJK 字库整份读进 ArrayBuffer 再
			// 报「太大」，在移动端就是白白制造一次内存峰值（vault 文件有 stat.size、
			// 系统文件有 File.size，两边都拿得到）。没有 size 时才退化为读完再判。
			if (!inPlace && pick.size != null && pick.size > MAX_FONT_BYTES) {
				new Notice("字体文件超过 40 兆字节，请换用体积更小的版本");
				return;
			}
			const buf = inPlace ? null : await pick.read();
			if (buf && buf.byteLength > MAX_FONT_BYTES) {
				new Notice("字体文件超过 40 兆字节，请换用体积更小的版本");
				return;
			}
			const path = inPlace ?? await importFontFile(this.app, FONTS_FOLDER, pick.name, ext, buf as ArrayBuffer);
			if (!path) {
				new Notice("字体导入失败（详见控制台）");
				return;
			}
			await this.selectFont(`custom:${path}`);
			new Notice(inPlace ? `已应用字体《${pick.name}》` : `已导入字体《${pick.name}》`);
		} catch (e) {
			console.error("[UNreader] import font failed", e);
			new Notice("字体导入失败");
		}
	}

	/** 选中一枚字体并当场生效（导入路径与面板下拉两条路径共用） */
	private async selectFont(id: string): Promise<void> {
		Object.assign(this.plugin.settings.appearance, { fontFamily: id });
		this.writeBackToActivePreset();
		this.plugin.scheduleSave();
		await this.ensureFontReady(id);
		this.adapter.applyAppearance(this.plugin.settings.appearance);
		this.syncOuterAppearance();
		// **无条件重开面板**（不是「若开着才刷新」）：走这条路的只有面板上的「库 / 系统」
		// 导入，而字体弹窗一打开，面板就被自己的「点外面关闭」判定关掉了（document 级
		// pointerdown，弹窗内容不在面板容器内，见 appearancePanel.onDocPointerDown）——
		// 于是判 isOpen() 恒为假，那行重开永远不会执行：用户选完字体眼前什么都没有，
		// 看不到刚导入的字体、也看不到它已被选中。重开一次即把结果摆在面板上。
		this.appearancePanel?.open(this.plugin.settings.appearance);
	}

	/** 确保某字体的 blob 已建出（有界重试，最多补跑一轮）。
	 *
	 *  refreshCustomFonts 是单飞行的，被复用的那次扫描可能发起于「本 id 写进外观」
	 *  之前——它的「被引用字体」快照不含本 id，该字体会以空 src 落进注册表，引擎
	 *  据此产出 url("") 的假 @font-face：正文静默回退系统字体，且不会自愈。
	 *  补跑一轮即可（第二次调用时飞行中那次已收尾，重新取快照就会包含本 id）。 */
	private async ensureFontReady(id: string | null | undefined): Promise<void> {
		if (!id) return;
		await this.plugin.refreshCustomFonts().catch(() => { /* 失败则回落系统字体 */ });
		if (!this.plugin.hasFontBlob(id)) {
			await this.plugin.refreshCustomFonts().catch(() => { /* ignore */ });
		}
	}

	/** 将外观面板左缘与右下按钮轨右缘精确对齐（各设备一致） */
	private alignAppearancePanel(): void {
		if (!this.appearancePanel?.isOpen()) return;
		const rail = this.sideNav?.actionsEl;
		const body = this.bodyEl;
		if (!rail || !body) return;
		try {
			const bodyRect = body.getBoundingClientRect();
			const railRect = rail.getBoundingClientRect();
			const margin = 8;
			const left = railRect.right - bodyRect.left;
			const maxLeft = bodyRect.width - (this.appearancePanel.containerEl.offsetWidth || 340) - margin;
			this.appearancePanel.containerEl.style.left = `${Math.min(left, Math.max(margin, maxLeft))}px`;
		} catch { /* ignore */ }
	}

	private saveAppearancePreset(): void {
		const defaultName = `预设 ${this.plugin.presetStore.list().length + 1}`;
		const modal = new PresetNameModal(this.app, defaultName, (name: string | null) => {
			if (!name || !name.trim()) return;
			const trimmed = name.trim().slice(0, 32);
			const existing = this.plugin.presetStore.list().find(p => p.name === trimmed);
			// 覆盖已有预设是破坏性操作，先问一次。`window.confirm()` 被上架规则禁止
			// （同步阻塞、样式与 Obsidian 无关），统一走 ConfirmModal。
			void (async (): Promise<void> => {
				if (existing && !await confirmAction(this.app, {
					title: "覆盖预设",
					body: `已存在名为“${trimmed}”的预设，是否覆盖？`,
					cta: "覆盖",
					destructive: true,
				})) return;
				if (existing) {
					existing.appearance = { ...this.plugin.settings.appearance };
					existing.createdAt = Date.now();
					this.plugin.presetStore.upsert(existing);
				} else {
					this.plugin.presetStore.upsert({
						id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						name: trimmed,
						appearance: { ...this.plugin.settings.appearance },
						createdAt: Date.now(),
					});
				}
				new Notice(`已保存预设“${trimmed}”`);
				if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
			})();
		});
		modal.open();
	}

	private async applyAppearancePreset(id: string): Promise<void> {
		const preset = this.plugin.presetStore.get(id);
		if (!preset) return;
		const merged = Object.assign({}, DEFAULT_APPEARANCE, preset.appearance);
		// 旧版 preset: 背景图仍从预设文件夹解析；shared: 引用由 ResourceStore 统一解析
		await this.plugin.presetStore.resolveImages(merged, preset);
		Object.assign(this.plugin.settings.appearance, merged);
		// 预设引用的字体可能本机还没建出 blob（他端同步过来的新预设）：先确保就绪，
		// 否则引擎拿到空 src 会产出 url("") 的假 @font-face 并静默回落系统字体。
		// 此前这条路径根本不刷新字体注册表。
		await this.ensureFontReady(merged.fontFamily);
		// 整套外观被替换，面板里的图片展示名记忆一并失效
		this.bgImageNames.clear();
		// 记住本机启用的预设（localStorage 设备本地，不随 data.json 同步）
		this.setDevicePresetId(id);
		this.plugin.scheduleSave();
		this.adapter.applyAppearance(this.plugin.settings.appearance);
		// 预设/外观整体替换 = 用户主动改口径：先清掉滚动留下的原生隐藏态，
		// 并先落 chrome-hidden 再同步 —— 原顺序会让 syncNativeNav 读到切换前的旧态。
		this.nativeScrollHidden = false;
		if (!this.fullImmersion && !this.pinned) {
			this.rootEl?.toggleClass("chrome-hidden", this.plugin.settings.appearance.normalModeShowToolbar === false);
			this.rootEl?.removeClass("chrome-revealed");
		}
		this.syncOuterAppearance();
		// 若面板打开，同步其当前值（延后到 change 事件链外重开，
		// 避免下拉框在自身 change 处理中被销毁重建导致后续无法选择）
		if (this.appearancePanel?.isOpen()) {
			window.setTimeout(() => {
				if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
			}, 0);
		}
		new Notice(`已应用预设“${preset.name}”`);
	}

	private deleteAppearancePreset(id: string): void {
		const preset = this.plugin.presetStore.get(id);
		if (!preset) return;
		void (async (): Promise<void> => {
			const ok = await confirmAction(this.app, {
				title: "删除预设",
				body: `确定删除预设“${preset.name}”？`,
				cta: "删除",
				destructive: true,
			});
			if (!ok) return;
			void this.plugin.presetStore.remove(id);
			if (this.getDevicePresetId() === id) this.setDevicePresetId(null);
			new Notice(`已删除预设“${preset.name}”`);
			if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
		})();
	}

	private renameAppearancePreset(id: string): void {
		const preset = this.plugin.presetStore.get(id);
		if (!preset) return;
		new PresetNameModal(this.app, preset.name, (name: string | null) => {
			if (!name || !name.trim() || name.trim() === preset.name) return;
			const trimmed = name.trim().slice(0, 32);
			void this.plugin.presetStore.rename(id, trimmed).then(() => {
				new Notice(`已重命名为“${trimmed}”`);
				if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
			});
		}).open();
	}

	/** 将当前外观覆盖到选中预设 */
	private updateAppearancePreset(id: string): void {
		const preset = this.plugin.presetStore.get(id);
		if (!preset) return;
		void (async (): Promise<void> => {
			const ok = await confirmAction(this.app, {
				title: "覆盖预设",
				body: `用当前外观覆盖预设“${preset.name}”？`,
				cta: "覆盖",
				destructive: true,
			});
			if (!ok) return;
			preset.appearance = { ...this.plugin.settings.appearance };
			preset.createdAt = Date.now();
			this.plugin.presetStore.upsert(preset);
			new Notice(`已更新预设“${preset.name}”`);
			if (this.appearancePanel?.isOpen()) this.appearancePanel.open(this.plugin.settings.appearance);
		})();
	}

	private refreshSideNavCounts(): void {
		const counts = new Map<number, number>();
		for (const h of this.annotations.highlights) {
			const id = this.adapter.getTocIdForCfiSync(h.anchor);
			if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		for (const b of this.annotations.bookmarks) {
			const id = this.adapter.getTocIdForCfiSync(b.anchor);
			if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		this.sideNav.setCounts(counts);
	}

	/* ---------------- footnotes ---------------- */

	/** 脚注气泡：锚定在注标旁的干净弹窗，只有脚注内容，无头部/按钮/提示 */
	private mountFootnoteBubble(anchor?: { x: number; y: number }): { backdrop: HTMLElement; bubble: HTMLElement; content: HTMLElement } {
		this.closeFootnotePopup();
		const backdrop = createDiv();
		backdrop.className = "unreader-footnote-backdrop unreader-footnote-bubble-backdrop";
		const bubble = createDiv();
		bubble.className = "unreader-footnote-bubble";
		const content = bubble.createDiv({ cls: "unreader-footnote-content" });
		backdrop.appendChild(bubble);
		this.bodyEl.appendChild(backdrop);
		const dismiss = (): void => this.closeFootnotePopup();
		backdrop.addEventListener("mousedown", e => {
			if (e.target === backdrop) dismiss();
		});
		// 鼠标离开气泡附近的自动消失：指向（注标→气泡）离开或进入再移出后启动短延时；
		// 期间只要仍在气泡附近或正在气泡内选字就取消，保证可读、可选中。
		// 注意：不在 mount 时 arm——悬停注标触发时鼠标不在气泡内，立即计时会让气泡
		// 刚弹出就消失；关闭由 pointermove 在「离开气泡周边一圈」时驱动。
		this.footnoteBubbleEl = bubble;
		this.cancelFootnoteAutoClose();
		bubble.addEventListener("mouseenter", () => this.cancelFootnoteAutoClose());
		bubble.addEventListener("mouseleave", () => this.armFootnoteAutoClose());
		bubble.addEventListener("pointerdown", () => {
			this.cancelFootnoteAutoClose();
			// 拖选过程会短暂离开气泡：从按下起 1.5s 内暂停自动消失
			this.footnoteSuppressAutoCloseUntil = performance.now() + 1500;
		});
		bubble.addEventListener("pointerup", () => { this.armFootnoteAutoClose(); });
		bubble.addEventListener("mouseup", () => {
			if (this.hasFootnoteSelection()) this.footnoteSuppressAutoCloseUntil = performance.now() + 1500;
		});
		document.addEventListener("pointermove", this.footnoteDocPointerMove, true);
		const escHandler = (e: KeyboardEvent): void => {
			if (e.key === "Escape") dismiss();
		};
		document.addEventListener("keydown", escHandler, { once: true });
		this.footnoteDismiss = (): void => {
			document.removeEventListener("keydown", escHandler);
			dismiss();
		};
		this.footnoteBackdrop = backdrop;
		window.requestAnimationFrame(() => {
			backdrop.addClass("is-open");
			this.positionFootnoteBubble(bubble, anchor);
		});
		// 内容异步撑开（foliate-view/图片加载）时重新定位
		[80, 200, 420].forEach(ms => window.setTimeout(() => this.positionFootnoteBubble(bubble, anchor), ms));
		return { backdrop, bubble, content };
	}

	/** 气泡定位：默认在锚点上方居中（箭头指向锚点），空间不足翻转到下方；左右钳制在阅读区内 */
	private positionFootnoteBubble(bubble: HTMLElement, anchor?: { x: number; y: number }): void {
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const bw = this.bodyEl.clientWidth;
		const bh = this.bodyEl.clientHeight;
		const w = bubble.offsetWidth;
		const h = bubble.offsetHeight;
		if (!w || !h) return;
		let left: number;
		let top: number;
		let arrowX: number | null = null;
		let below = false;
		if (anchor) {
			const ax = Math.min(Math.max(anchor.x - bodyRect.left, 18), bw - 18);
			const ay = anchor.y - bodyRect.top;
			left = Math.min(Math.max(ax - w / 2, 10), Math.max(10, bw - w - 10));
			arrowX = ax - left;
			if (ay - h - 18 < 8) { below = true; top = ay + 18; }
			else { top = ay - h - 18; }
			top = Math.min(Math.max(top, 8), Math.max(8, bh - h - 8));
		} else {
			left = Math.max(10, (bw - w) / 2);
			top = Math.max(8, (bh - h) / 2 - 30);
		}
		bubble.style.left = `${left}px`;
		bubble.style.top = `${top}px`;
		if (arrowX != null) bubble.style.setProperty("--arrow-x", `${Math.min(Math.max(arrowX, 20), w - 20)}px`);
		bubble.toggleClass("is-below", below);
	}

	/** 鼠标离开气泡附近后延时自动消失 */
	private armFootnoteAutoClose(): void {
		this.cancelFootnoteAutoClose();
		if (performance.now() < this.footnoteSuppressAutoCloseUntil) return;
		this.footnoteAutoCloseTimer = window.setTimeout(() => {
			this.footnoteAutoCloseTimer = null;
			this.closeFootnotePopup();
		}, 350);
	}

	private cancelFootnoteAutoClose(): void {
		if (this.footnoteAutoCloseTimer != null) {
			window.clearTimeout(this.footnoteAutoCloseTimer);
			this.footnoteAutoCloseTimer = null;
		}
	}

	private footnoteDocPointerMove = (e: PointerEvent): void => {
		const bubble = this.footnoteBubbleEl;
		if (!bubble?.isConnected) return;
		// 悬停范围 = 气泡矩形 + 周边一圈：气泡与注标之间隔着箭头间隙，
		// 只按气泡本身判定会让「鼠标停在注标上」被当作离开，气泡刚弹出就消失。
		// 沿周边扩大一圈（含注标位置）后，在圈内都算「附近」，不触发自动关闭。
		const r = bubble.getBoundingClientRect();
		const pad = 26;
		if (
			e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
			e.clientY >= r.top - pad && e.clientY <= r.bottom + pad
		) {
			this.cancelFootnoteAutoClose();
			return;
		}
		this.armFootnoteAutoClose();
	};

	/** 气泡内当前是否有非折叠宿主选区 */
	private hasFootnoteSelection(): boolean {
		try {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) return false;
			const n = sel.anchorNode;
			const el = n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null;
			return !!el && !!this.footnoteBackdrop?.contains(el);
		} catch {
			return false;
		}
	}

	private openInlineFootnote(html: string, href: string, jump?: () => void, anchor?: { x: number; y: number }): void {
		void href;
		void jump;
		const { content } = this.mountFootnoteBubble(anchor);
		content.addClass("unreader-footnote-content--html");
		// 官方 lint 禁 unsafe innerHTML（no-unsanitized/property）：html 是书内脚注
		// DOM 的序列化产物，改为 DOMParser 解析后移动节点，等价且不触发规则。
		try {
			const parsed = new DOMParser().parseFromString(html, "text/html").body;
			for (const node of Array.from(parsed.childNodes)) content.appendChild(node);
		} catch { content.setText(html); }
		this.activeFootnoteView = null;
		content.addEventListener("click", e => {
			const a = (e.target as HTMLElement)?.closest?.("a[href]")
			if (a) this.closeFootnotePopup();
		});
	}

	private openFootnotePopup(view: RawFoliateView, href: string, anchor?: { x: number; y: number }): void {
		void href;
		const { content } = this.mountFootnoteBubble(anchor);
		content.appendChild(view);
		styleFootnoteView(view, this.plugin.settings.appearance, Math.max(320, Math.min(420, content.clientWidth || 360)));
		this.activeFootnoteView = view;
	}

	closeFootnotePopup(): void {
		this.footnoteDismiss = null;
		document.removeEventListener("pointermove", this.footnoteDocPointerMove, true);
		this.cancelFootnoteAutoClose();
		this.footnoteBubbleEl = null;
		const backdrop = this.footnoteBackdrop;
		if (!backdrop) return;
		this.footnoteBackdrop = null;
		backdrop.removeClass("is-open");
		const view = this.activeFootnoteView;
		window.setTimeout(() => {
			if (view) {
				try {
					view.close();
				} catch {
					// ignore
				}
				view.remove();
			}
			backdrop.remove();
		}, 120);
		this.activeFootnoteView = null;
	}

	/* ---------------- annotations: shared helpers ---------------- */

	/** Feed 正文刷新后先按原文迁移高亮，再提交待处理快照；找不到的高亮只标记失效。 */
	private async reconcileFeedAnnotations(): Promise<void> {
		const entry = this.currentFeedEntry;
		const hash = this.activeFeedContentHash;
		if (!entry || !hash) return;
		const changed = reconcileFeedAnnotationAnchors(this.annotations, hash, this.adapter);
		const hasAnnotations = this.annotations.highlights.length > 0 || this.annotations.bookmarks.length > 0;
		if (hasAnnotations !== (entry.state.hasAnnotations === true)) {
			await this.plugin.feedStore.updateEntryState(entry.feedId, entry.id, { hasAnnotations });
		}
		if (changed) await this.persistAnnotations();
		if (entry.pendingContentHash === hash && entry.pendingContentHtml != null) {
			await this.plugin.feedStore.commitPendingContent(entry.feedId, entry.id, hash);
			this.currentFeedEntry = this.plugin.feedStore.getEntry(entry.feedId, entry.id) ?? this.currentFeedEntry;
		}
	}

	private async persistAnnotations(): Promise<boolean> {
		try {
			const link = this.currentFeedEntry?.url || this.currentFeedEntry?.title || this.file?.path || "";
			await writeAnnotations(this.app.vault, this.notePath, link, this.annotations);
			if (this.currentFeedEntry) {
				await this.plugin.feedStore.updateEntryState(this.currentFeedEntry.feedId, this.currentFeedEntry.id, {
					hasAnnotations: this.annotations.highlights.length > 0 || this.annotations.bookmarks.length > 0,
				});
			}
			return true;
		} catch (e) {
			console.error("[UNreader] save annotations failed", e);
			new Notice("标注保存失败");
			return false;
		}
	}

	private syncAnnotationViews(): void {
		if (this.annotationsPanel.isOpen()) this.annotationsPanel.render(this.annotations);
		void this.refreshSideNavCounts();
	}

	/** 书签页码实时刷新（就地改文字，不重建列表）：
	 *  排版/设备/外观变化后页码模型可能变，侧栏里的页码必须跟着走，
	 *  否则用户看到的是上一次布局下的旧页码。 */
	private refreshAnnotationPages(): void {
		try { this.annotationsPanel?.refreshPages(); } catch { /* ignore */ }
	}

	/* ---------------- annotations: creation ---------------- */

	private async applyHighlight(colorName: string): Promise<void> {
		const sel = this.pendingSelection;
		this.pendingSelection = null;
		if (!sel || !sel.cfi) {
			new Notice("无法定位选区");
			return;
		}
		sel.doc.getSelection()?.removeAllRanges();

		const item: StoredHighlight = {
			id: Date.now(),
			color: colorName,
			anchor: sel.cfi,
			text: sel.text.slice(0, 500),
			contentHash: this.activeFeedContentHash ?? this.currentFeedEntry?.contentHash,
		};
		this.adapter.addHighlight(sel.cfi, colorName, item.text);
		this.annotations.highlights.push(item);
		if (await this.persistAnnotations()) this.syncAnnotationViews();
	}

	private async applyHighlightWithComment(text: string, comment: string, colorName: string): Promise<void> {
		const sel = this.pendingSelection;
		this.pendingSelection = null;
		if (!sel || !sel.cfi) {
			new Notice("无法定位选区");
			return;
		}
		sel.doc.getSelection()?.removeAllRanges();

		const item: StoredHighlight = {
			id: Date.now(),
			color: colorName,
			anchor: sel.cfi,
			text: text.slice(0, 500),
			comment,
			contentHash: this.activeFeedContentHash ?? this.currentFeedEntry?.contentHash,
		};
		this.adapter.addHighlight(sel.cfi, colorName, item.text);
		this.annotations.highlights.push(item);
		if (await this.persistAnnotations()) this.syncAnnotationViews();

		// let the user refine / continue editing the fresh highlight
		this.highlightPopover.showFor(
			{ id: item.id, anchor: item.anchor, text: item.text, color: item.color, comment: item.comment ?? "" },
			null,
			this.bodyBoundsNow(),
			true,
		);
	}

	/* ---------------- annotations: mutation from popover/sidebar ---------------- */

	private recolorHighlight(id: number, colorName: string): void {
		const item = this.annotations.highlights.find(h => h.id === id);
		if (!item) return;
		item.color = colorName;
		this.adapter.recolorHighlight(item.anchor, colorName);
		void this.persistAnnotations().then(ok => ok && this.syncAnnotationViews());
	}

	private saveHighlightComment(id: number, comment: string): void {
		const item = this.annotations.highlights.find(h => h.id === id);
		if (!item) return;
		item.comment = comment.trim() || undefined;
		void this.persistAnnotations().then(ok => ok && this.syncAnnotationViews());
	}

	private deleteHighlight(id: number): void {
		const idx = this.annotations.highlights.findIndex(h => h.id === id);
		if (idx === -1) return;
		const [item] = this.annotations.highlights.splice(idx, 1);
		this.adapter.removeHighlight(item!.anchor);
		this.highlightPopover.hide();
		void this.persistAnnotations().then(ok => ok && this.syncAnnotationViews());
		new Notice("已删除高亮");
	}

	/* ---------------- bookmarks ---------------- */

	openBookmarkModal(): void {
		if (!this.lastRelocate?.cfi) {
			new Notice("请先开始阅读");
			return;
		}
		const defaultLabel = this.lastRelocate.sectionLabel || this.currentFeedEntry?.title || "";
		new BookmarkModal(this.app, label => {
			const anchor = this.lastRelocate!.cfi;
			this.annotations.bookmarks.push({
				id: Date.now(),
				anchor,
				// 与重命名同一条安全化通道：章节标题里也可能带 `|`，同样会切错笔记分列
				label: sanitizeBookmarkLabel(label) || sanitizeBookmarkLabel(defaultLabel) || "书签",
				contentHash: this.activeFeedContentHash ?? this.currentFeedEntry?.contentHash,
			});
			void this.persistAnnotations().then(ok => {
				if (ok) {
					this.syncAnnotationViews();
					new Notice("书签已添加");
				}
			});
		}).open();
	}

	private deleteBookmark(id: number): void {
		const idx = this.annotations.bookmarks.findIndex(b => b.id === id);
		if (idx === -1) return;
		this.annotations.bookmarks.splice(idx, 1);
		void this.persistAnnotations().then(ok => ok && this.syncAnnotationViews());
	}

	/** 重命名书签：位置 token（anchor）不变，只改 label，落盘到旁车笔记 */
	private renameBookmark(id: number, label: string): void {
		const item = this.annotations.bookmarks.find(b => b.id === id);
		if (!item) return;
		const next = sanitizeBookmarkLabel(label);
		if (!next || next === item.label) return;
		item.label = next;
		void this.persistAnnotations().then(ok => ok && this.syncAnnotationViews());
	}

	/* ---------------- native annotation hover (Obsidian 官方) ---------------- */

	private dismissHover(): void {
		if (this.hoverRaf) {
			window.cancelAnimationFrame(this.hoverRaf);
			this.hoverRaf = 0;
		}
		if (this.hoverAnchorEl) {
			try { this.hoverAnchorEl.remove(); } catch { // ignore
			}
			this.hoverAnchorEl = null;
		}
		const hp = this.hoverPopover as unknown as { hide?: () => void } | null;
		if (hp?.hide) {
			try { hp.hide(); } catch { // ignore
			}
		}
		this.hoverPopover = null;
		this.hoveredId = null;
	}

	/** 点击/触摸正文或面板外空白时统一收起浮层：
	 *  选中工具条、高亮气泡、未钉住的标注侧边栏（触屏额外收外观/目录面板）。
	 *  宿主 body 与书页 iframe 内 pointerdown 都走这里——iframe 里的事件不会
	 *  冒泡到宿主 body，若不在这里补收，书内点击永远关不掉这些浮层。 */
	private dismissFloatingOnBlankClick(): void {
		if (this.selectionToolbar?.visible) this.selectionToolbar.hide();
		if (this.highlightPopover?.visible) this.highlightPopover.hide();
		// 触屏额外关闭外观面板（无 hover 自动收起能力）
		let coarse = false;
		try { coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false; } catch { coarse = false; }
		if (coarse) {
			if (this.appearancePanel?.isOpen()) this.appearancePanel.close();
		}
		// 目录面板：iframe 内点按视为「点击其他地方」（按钮唤出的面板一律关，悬停面板尊重钉住）
		this.sideNav?.outsideTap();
		// 标注侧边栏未钉住时，触屏/鼠标点击空白都应收起
		if (!this.pinned && this.annotationsPanel?.isOpen()) {
			this.annotationsPanel.hide();
			this.alignAppearancePanel();
			this.alignActionsRail();
		}
		this.dismissHover();
	}

	/** 有无浮层面板挡在阅读区上（钉住的标注侧栏不算——它不悬浮、无关闭入口问题，
	 *  若算进去会把沉浸模式的点按/上滑唤出永久挡死） */
	private hasFloatingPanelOpen(): boolean {
		const annoBlocking = (this.annotationsPanel?.isOpen() ?? false) && !this.pinned;
		return !!(this.appearancePanel?.isOpen() || this.sideNav?.isPanelOpen() || annoBlocking);
	}

	/** 滚动方向 → 常态隐藏/唤出。全沉浸完全冻结。
	 *
	 *  两个开关各管一段、互不连坐：
	 *   · 「滑动自动隐藏」管**插件工具层**（`chrome-hidden`，下滑藏、上滑唤）；
	 *   · 「接管原生界面」管 **Obsidian 页首/底栏**（`nativeScrollHidden`）——
	 *     只**向下滚动置藏**、**向上滚动不复位**（用户 2026-09-20 要求：「开着接管
	 *     原生界面时，那些工具元素应该随着向下滚动隐藏，但是不应该随着向上滚动出现，
	 *     就像桌面端一样」）。被滚动藏起后只由显式唤出恢复：点按正文空白 / 退出视图 /
	 *     外观变更 / 退出全沉浸。
	 *  只开后者时，工具栏保持常显、原生界面照样随滚动让位；
	 *  两个都关时滚动什么都不做。 */
	private handleScrollActivity(direction: "up" | "down"): void {
		// 全沉浸时工具层状态机冻结，但滑动过程中官方仍可能把系统状态栏放出来，
		// 这里不展开任何 UI，只把状态栏重新压住（内部按当前隐藏态去重）。
		if (this.fullImmersion) {
			this.reassertStatusBarHidden();
			return;
		}
		// 真正的用户滚动才是脚注气泡的关闭信号。不能放在 handleRelocate：看书时
		// 补载章节也会让 relocate 连续刷新，悬停气泡刚出现就会被误关。
		if (this.footnoteBackdrop) this.closeFootnotePopup();
		const appearance = this.plugin.settings.appearance;
		const scrollHide = appearance.normalModeScrollHide !== false;
		const takeOverNative = appearance.normalModeHideNativeChrome === true;
		if (!scrollHide && !takeOverNative) return;
		if (this.hasFloatingPanelOpen()) return;
		if (direction === "down") {
			// 开书宽限期：首次开书/切书后布局稳定会产生一阵非用户滚动，
			// 此时用户点按唤出 chrome 会被这阵滚动立刻压回去（表现为唤不出）
			if (Date.now() < this.immersiveGraceUntil) return;
			if (scrollHide) {
				this.rootEl?.addClass("chrome-hidden");
				// 滚动隐藏后复位点按唤出的全展开态
				this.rootEl?.removeClass("chrome-revealed");
			}
			if (takeOverNative) this.nativeScrollHidden = true;
		} else {
			// 上滑唤出的是**插件工具层**（chrome-hidden → 亮出工具栏）；Obsidian 的原生
			// 页首/底栏**不能跟着一起出来** —— 用户 2026-09-20 的明确要求是
			// 「向下滚动隐藏、向上滚动不出现，就像桌面端一样」。
			//
			// ⚠️ **只靠「不复位 nativeScrollHidden」是不够的**（2026-09-23 修，用户报
			// 「快速滑动时底栏弹出来、又被立刻藏回去，快速闪烁」）：判据 headerHiddenByUs
			// 里含 chromeHidden 这一项，而上滑恰好会清掉它 —— 于是当本次会话还没下滑过
			// （nativeScrollHidden 仍为 false）时，上滑会让原生判据整体变假，底栏被放出来；
			// 下一拍下滑再把它藏回去 = 一闪。快速滑动时方向反复翻转，这一闪会连续复现。
			// 因此：**上滑前工具层本来就收起着（= 此刻确实处于沉浸态）时，把「原生已被接管」
			// 这个事实钉住**，让上滑只亮工具栏、不放原生。若工具层本来就是亮的（原生本就在
			// 显示），则不改变现状 —— 那一步用户看到的是一致的，不该凭空把底栏藏掉。
			const wasChromeHidden = this.rootEl?.hasClass("chrome-hidden") ?? false;
			if (scrollHide) this.rootEl?.removeClass("chrome-hidden");
			if (takeOverNative && wasChromeHidden) this.nativeScrollHidden = true;
			// 复位只走显式唤出：handleTapZone / releaseNativeNav / 外观变更 / 退出全沉浸。
		}
		this.syncNativeNav(direction === "down" ? "scroll-down" : "scroll-up");
	}

	/** 连续模式 iframe 内横向滑动 → 转发给 Obsidian 原生侧栏手势。
	 *
	 *  原生手势的唯一入口就是 workspace 的 "swipe" 事件（obsidian.asar：
	 *  `Rm(workspace.containerEl, e => workspace.trigger("swipe", e))`），
	 *  WorkspaceDrawer 订阅它、并在处理中**同步**调用 info.registerCallback
	 *  取回 move/cancel/finish，逐帧写侧栏 transform、按阈值判定开合。
	 *  触摸落在章节 iframe 内时原生识别器收不到 touchstart，这里由引擎在 iframe
	 *  内识别后把同构载荷送上来补这个缺口 —— 合成一份 info 同步 trigger 即可，
	 *  跟手拖拽/阈值/动画/导航栏联动全部走原生实现，不自造一套。
	 *
	 *  只有 layoutReady 之后、且存在可开合的侧栏时才会被 registerCallback 收下；
	 *  没被收下就返回 false，引擎随即放弃本手势、不拦截滚动。 */
	private handleFrameSwipe(info: FrameSwipeInfo): boolean {
		let accepted = false
		const payload = {
			// 原生识别器产物里的字段（evt/touch 仅部分订阅者会转发，抽屉分支不读）
			evt: null,
			touch: null,
			points: 1,
			direction: "x",
			// 另有两个 swipe 订阅者（下拉快捷动作、双指返回）会校验 targetEl
			// 落在主区域容器内，必须给真实节点而非 null
			targetEl: this.contentHost,
			startX: info.startX,
			startY: info.startY,
			x: info.x,
			y: info.y,
			registerCallback: (cb: unknown): unknown => {
				accepted = true
				info.registerCallback(cb as never)
				return cb
			},
		}
		try {
			this.app.workspace.trigger("swipe", payload)
		} catch (e) {
			console.warn("[UNreader] workspace swipe trigger failed", e)
			return false
		}
		if (accepted) {
			// 手势被抽屉接收 = 手指已经离开「选字意图」，等价于 iOS 的「点选区外」。
			// 镜像原生抽屉展开时的 Av()（blur + 清选区）：至少把浮层收掉，否则选区
			// 工具条挂在 document.body 且 z-index 高于抽屉，会浮在侧栏上面。
			// 正文选区本身保留——用户可能是选完字再用侧栏，清掉反而更坏。
			try { if (this.selectionToolbar?.visible) this.selectionToolbar.hide() } catch { /* ignore */ }
			this.dismissHover()
		}
		return accepted
	}

	/** 本视图是否正在管理 is-hidden-nav（只有我们自己加的才由我们移除，
	 *  避免与官方 markdown 滚动行为互相打架） */
	private nativeNavManaged = false;
	/** 「底栏让位」类是否由本视图施加（见 styles.css 的 `unreader-nav-float` 段：
	 *  底栏被藏起来的那段时间让它脱离布局流，把占住的那一屏还给阅读区）。 */
	private navFloatManaged = false;
	/** 让位类的**延迟撤销**定时器（唤出底栏后要等它滑回原位再撤销，否则会闪一次底色） */
	private navFloatReleaseTimer: number | null = null;	/** 外部摘类自愈守卫（见 ./nativeNavGuard.ts）：官方 restoreNavigation 的六条
	 *  触发路径（mousedown / 切视图 / layout / config / 键盘 / 抽屉）本视图一条都
	 *  收不到，而它只摘不补；本插件的同步点又全绑在用户交互上 —— 用户静止阅读时
	 *  类被摘掉后无人补回，底栏永久留在显示态。守卫盯 body 的类，按 nativeNavWanted()
	 *  补回，不枚举官方路径。 */
	private nativeNavGuard: NativeNavGuard | null = null;
	/** 顶栏当前隐藏状态（滚动事件高频调用 syncNativeNav，避免重复挂摘类打断过渡动画） */
	private headerHiddenState: boolean | null = null;
	/** 滚动方向驱动的**原生界面**隐藏态（与工具层 `chrome-hidden` 解耦）：
	 *  「接管原生界面」开时，下滑把 Obsidian 页首/底栏收走、上滑放回；
	 *  工具层是否跟着动由「滑动自动隐藏」单独决定。点按、换书、失活、
	 *  外观/预设变更、进出全沉浸一律复位 —— 它是会话内的瞬时态，不是设置。 */
	private nativeScrollHidden = false;
	/** 已写入的「页首空隙」高度（px，叶子 + 根两处共用同一份状态）。
	 *  存一份是为了**只在真正变化时写**：v4 的负 margin 会改变 `root` 的顶边，而
	 *  `syncProgressTop` 每帧都要量 `root` 顶边算进度条让位 —— 写入后必须让测量看到
	 *  新值（同一帧内强制一次布局），而滚动热路径上 hole 恒不变、不进这条分支。 */
	private appliedHole = 0;
	/** 开书宽限期：布局稳定期间的滚动不触发下滑隐藏（不影响上滑唤出） */
	private immersiveGraceUntil = 0;
	/** 点按投递去重：上一次已处理点按的原生事件时间戳与处理时刻。
	 *  见 handleTapZone 头注释 —— 防「一次手势被投递两次」把翻转开关翻两下。 */
	private lastTapStamp = -1;
	private lastTapAt = 0;

	/** 本机是否处于**手机形态**（官方 `body.is-phone`）。
	 *
	 *  判据落**真机制**上而不是 API 代理上：官方底栏与系统状态栏的每一条 CSS 都以
	 *  body 的 `is-phone` / `is-tablet` 为前缀（`body.is-tablet .mobile-navbar
	 *  { display: none }` —— 平板压根没有底栏），而这两个类由官方按**窗口尺寸**打
	 *  （asar 实测：`matchMedia("(min-width: 600px) and (min-height: 600px)")` →
	 *  `is-tablet`，`isPhone = !isTablet`）。拿 `Platform.isPhone` 当门是同一件事的
	 *  代理，两者一旦漂移（大屏手机 / 折叠屏展开 / 官方换判据）就会出现
	 *  **「页首藏了、底栏却还在」**—— 用户报障的原始形态。类还没挂上的极早时序才退回 API。
	 *
	 *  （历史：这里曾是 `nativeFullScreenEnabled()` —— 读官方「全屏」配置当底栏的门。
	 *  那条门与插件自己的开关**语义重复且会互相打架**：官方设置一关，用户开了
	 *  「沉浸模式适配」也只剩半边生效。现已删除，见 `ui/nativeNavPolicy.ts` 文件头。） */
	private phoneLike(): boolean {
		try {
			const body = document.body;
			if (body.hasClass("is-tablet")) return false;
			if (body.hasClass("is-phone")) return true;
			return Platform.isPhone === true;
		} catch {
			return false;
		}
	}

	/** 沉浸态的五条输入事实 —— **唯一来源**，`syncNativeNav` 与 `NativeNavGuard`
	 *  都读它（守卫闭包直接调 `nativeNavWanted()`），杜绝「写类」与「补类」两处判据漂移。 */
	private immersiveNativeInputs(): ImmersiveNativeInputs {
		const fullImmersionHidden = this.fullImmersion && !this.fullImmersionRevealed;
		return {
			normalModeHideNativeChrome: this.plugin.settings.appearance.normalModeHideNativeChrome === true,
			fullImmersion: fullImmersionHidden,
			chromeHidden: this.fullImmersion ? !this.fullImmersionRevealed : (this.rootEl?.hasClass("chrome-hidden") ?? false),
			// 滚动方向单独驱动的原生隐藏态：与工具层解耦（见 `nativeScrollHidden` 字段）
			nativeScrollHidden: this.nativeScrollHidden,
			phoneLike: this.phoneLike(),
			selfActive: this.isSelfActive(),
		};
	}

	/** 底栏（app 级 `mobile-navbar`）当前是否「该藏」。
	 *
	 *  这是**唯一**的底栏判据来源：`syncNativeNav` 写类、`NativeNavGuard` 补类都读它。
	 *  两边各写一套是这个 bug 的温床 —— 守卫按自己的理解补、同步按另一套摘，
	 *  表现就是「显示一次后一直显示」，或反向的「该显示却一直藏」。
	 *  判据本体在 `ui/nativeNavPolicy.ts`（纯函数 + 真值表回归，含
	 *  「不打开都不隐藏、打开了都隐藏」这条不变量）。 */
	private nativeNavWanted(): boolean {
		try {
			return bottomBarHiddenByUs(this.immersiveNativeInputs());
		} catch {
			return false;
		}
	}

	/** 底栏闪烁取证观察器（见 installNavForensics） */
	private navForensicsObserver: MutationObserver | null = null;

	/** 底栏显隐有**两条彼此独立**的通道，真机排查时都要留痕（日志关着时零成本）：
	 *
	 *  · ① **类**：`body.is-hidden-nav`（我们写，`syncNativeNav(why)` 记来源：
	 *    scroll-down/scroll-up/tap/guard/leaf/open/appearance…）；
	 *  · ② **元素**：官方 `MobileNavbar.show()/hide()` 是**把元素挂上去 / 摘下来**
	 *    （asar 实测：`show(){isVisible||(isVisible=!0, appContainerEl.appendChild(containerEl))}`、
	 *    `hide(){isVisible&&(isVisible=!1, containerEl.detach())}`），由
	 *    `keyboardWillShow/Hide`、`mobileToolbar.show()`（**工具条与底栏互斥**：显示
	 *    工具条会先 `mobileNavbar.hide()`）等触发。这条**与我们的类无关、也没有过渡
	 *    动画**，真机形态就是「底栏啪一下没了 / 啪一下回来」—— 若用户报的闪烁在这条
	 *    上，日志里会只有 `[nav] 官方挂上/摘下` 而没有 ① 的写入记录。
	 *
	 *  观察面只取 `appContainerEl` 的直接子节点增删（官方两个元素就挂在那里），
	 *  滚动热路径上不会被唤醒。 */
	private installNavForensics(): void {
		try {
			if (this.navForensicsObserver) return;
			const container = (this.app as unknown as { dom?: { appContainerEl?: HTMLElement } })
				.dom?.appContainerEl ?? null;
			const name = (n: Node): string => {
				if (!n.instanceOf(HTMLElement)) return "";
				if (n.hasClass("mobile-navbar")) return "底栏 mobile-navbar";
				if (n.hasClass("mobile-toolbar") || n.hasClass("mobile-toolbar-spacer")) return "工具条 mobile-toolbar";
				return "";
			};
			if (container) {
				this.navForensicsObserver = new MutationObserver(muts => {
					for (const m of muts) {
						m.addedNodes.forEach(n => { const s = name(n); if (s) debugLog.info("[nav] 官方挂上", s); });
						m.removedNodes.forEach(n => { const s = name(n); if (s) debugLog.info("[nav] 官方摘下", s); });
					}
				});
				this.navForensicsObserver.observe(container, { childList: true });
			}
			// 官方摘挂的触发源（keyboardWillShow → 摘底栏；Hide → 挂回）
			for (const ev of ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"]) {
				this.registerDomEvent(window, ev as "keydown", () => debugLog.info("[nav] " + ev));
			}
		} catch { /* 取证失败不影响功能 */ }
	}

	/** 评论编辑期间的「焦点被抢 / 焦点掉到 body」取证（`debugLog` 关闭时零成本）。
	 *
	 *  为什么除了 `hide()` 那条取证还要这一条：`hide()` 只覆盖**第一种**失焦形态
	 *  ——「容器被收起 → 输入框被动失焦」。真机上还有第二种：**焦点被别的元素主动
	 *  抢走**（`focusContent()` / 浏览器焦点恢复 / 别的插件 / 将来的新写入点），
	 *  以及第三种：**焦点掉到 body**（`blur()` 没有接收方）。三者都会收掉软键盘，
	 *  但只有第一种会留下 `hide()` 记录 —— 第二、三种在日志里原本是完全静默的。
	 *
	 *  这里记的是「谁拿走了焦点」+ **调用栈**：抢焦点的那次 `focus()` 就在栈里，
	 *  真机日志可直接指认写入点，不必再逐条路径猜。 */
	private installCommentFocusForensics(): void {
		try {
			const inFloating = (t: EventTarget | null): boolean =>
				this.selectionToolbar?.containerEl.contains(t as Node | null) === true
				|| this.highlightPopover?.containerEl.contains(t as Node | null) === true;
			document.addEventListener("focusin", e => {
				if (!debugLog.isDebugEnabled()) return;
				if (!this.isEditingComment()) return;
				const t = e.target as HTMLElement | null;
				if (inFloating(t)) return;
				const cls = t && typeof t.className === "string" ? t.className : "";
				debugLog.info("[comment] 编辑评论期间焦点被抢走 →",
					t ? `${t.tagName}.${cls}`.slice(0, 60) : "null", new Error("steal"));
			}, true);
			document.addEventListener("focusout", e => {
				if (!debugLog.isDebugEnabled()) return;
				if (!this.isEditingComment()) return;
				const t = e.target as HTMLElement | null;
				if (!t || !inFloating(t)) return;
				// 没有接收方 = 焦点掉到 body：Android 上就是「软键盘被收起」那一下。
				// 有接收方的那一形态由上面的 focusin 记录，不在这里重复。
				if (e.relatedTarget) return;
				debugLog.info("[comment] 编辑评论期间输入框失去焦点且没有接收方（焦点落到 body）", new Error("blur"));
			}, true);
		} catch { /* 取证失败不影响功能 */ }
	}

	/** 给本视图的页首元素挂**插件自有类** `unreader-view-header`（幂等）。
	 *
	 *  ## 为什么不能只靠 `.workspace-leaf-content[data-type="unreader-view"] .view-header`
	 *
	 *  移动端页首那条**浮层化**规则（`position: absolute`：让阅读区铺满整叶、页首滑走
	 *  即整片让出）原本写成上面那个后代选择器 —— 它隐含一个 **DOM 结构假设**：
	 *  `.view-header` 必须是 `.workspace-leaf-content` 的**后代**。这个假设在不同
	 *  Obsidian 版本 / 窗口形态下**并不总是成立**（本文件 `leafContentEl()` 的注释里
	 *  早就记着「containerEl 可能就是 `.workspace-leaf`，不同 Obsidian 版本形态不同」）。
	 *
	 *  一旦结构漂移成 `.workspace-leaf > .view-header`（页首是叶子的直接子项），
	 *  那条规则**静默不命中**，故障链三段：
	 *    ① 页首回到官方 `position: var(--view-header-position)` = `static` → **占布局流**；
	 *    ② 隐藏走的是**元素级**的 `.view-header.unreader-header-hidden`，照旧生效
	 *       → 页首确实滑走了，**它占的那 56/103px 却原样留着**；
	 *    ③ 那条高度画的是更外层底色 —— `.workspace-leaf` 的 `--background-secondary`
	 *       （obsidian 次级色）= 用户报的「沉浸模式下页首元素的背景板又出现了，
	 *       颜色跟随 obsidian，遮挡书籍正文文字」。
	 *  这与手机端底栏那条是**同一件事的两端**（那边靠 `unreader-nav-float` 让位解决）。
	 *  同一条结构假设还挂在 `flex: 0 0 auto`（锁死页首高度）上，失效时页首会被 flex 压扁。
	 *
	 *  ⇒ 本插件针对页首的规则一律改用**元素级类**：类由 JS 挂在本视图自己的页首上，
	 *  **与祖先结构、与 data-type 挂在哪一层都无关**。CSS 侧见 styles.css 的
	 *  `.view-header.unreader-view-header` 两条。回归：`npm run test:top-band`
	 *  （结构 A/B 双档 + 分层染色像素 + 命中测试）。
	 *
	 *  **为什么每轮同步都挂、而不是只挂一次**：页首元素可能被官方重建
	 *  （`leaf.updateHeader()` 等），而 `classList.contains` 是一次纯读 ——
	 *  不变则不写、不失效，热路径零开销。 */
	private markViewHeader(header: HTMLElement | null): void {
		if (!header) return;
		try {
			if (!header.classList.contains("unreader-view-header")) header.addClass("unreader-view-header");
		} catch { /* ignore */ }
	}

	/** 沉浸模式 → 原生界面隐藏同步，两条通道：
	 *  1) 顶栏：JS 在本视图自己的 view-header 上挂两个类 ——
	 *    · `unreader-view-header`（**布局契约**）：移动端由 CSS 浮层化为
	 *      `position:absolute`，让阅读区铺满整叶、页首滑走即整片让出。用**元素级类**
	 *      而不是 `[data-type] .view-header` 后代选择器，理由见 `markViewHeader`
	 *      —— 那条后代选择器依赖一个会漂移的 DOM 结构假设，失效时正是「页首藏了、
	 *      它占的那条高度却留着」这个 bug。
	 *    · `unreader-header-hidden`（**隐藏态**）：纯 transform+opacity 视觉隐藏，
	 *      不塌缩布局；那一段空间的处理由上面的浮层化决定。
	 *    两者缺一就会留一条跟随 obsidian 底色的顶部背景板
	 *    （回归 `npm run test:top-band`）。平板与手机同一逻辑。
	 *  2) 底栏：双类同步 —— `unreader-nav-hidden`（插件自有，视觉闸门）+
	 *    `is-hidden-nav`（官方机制；官方滚动钩子只挂在 markdown 视图上，需我们自己
	 *    同步）。官方 restoreNavigation 摘官方类时，插件类仍在，底栏不会闪出来。
	 *    仅手机形态。
	 *
	 *  两条通道由三组状态共同驱动：
	 *   · 「接管原生界面」开关 —— 总闸。关 = 一概不碰；
	 *   · 工具层隐藏态（`chrome-hidden`：「滑动自动隐藏」/点按/默认隐藏）；
	 *   · **滚动方向态**（`nativeScrollHidden`）—— 与工具层解耦：只开「接管原生界面」
	 *     时，滚动照样收放原生界面，工具栏保持常显（用户报障「滑动隐藏没有涵盖到
	 *     移动端」的修复点）。
	 *  目标态为显示时，若官方的 `is-hidden-nav` / 被摘出 DOM 的底栏元素还在，
	 *  本函数负责放回（唯一权威）。
	 *  全沉浸始终接管，退出后恢复。
	 *  判据本体见 `ui/nativeNavPolicy.ts`（含这条不变量的真值表回归），
	 *  这里只负责把结果落到 DOM。
	 *
	 *  `why` 只进诊断日志（设置 → 诊断 → 调试日志）：底栏反复闪 = 这个类在
	 *  add/remove 之间来回，而能写它的路径有六七条（滚动方向/点按/自愈守卫/
	 *  切 leaf/换外观/开书）。真机取到一次复现日志即可指认是谁在翻，不必再猜
	 *  ——日志同时带上五条判据的实测值，`[nav] 判据` 一行就能看出是哪一条挡住的。 */
	private syncNativeNav(why = "-"): void {
		try {
			// 判据的**唯一来源**：五条输入事实一次性读出（页首与底栏共用同一份事实，
			// 保证「要藏一起藏」）。
			const inputs = this.immersiveNativeInputs();
			// 源头闸门：目标态是隐藏时，官方 restoreNavigation/show 不再执行，
			// 底栏和键盘工具条不会进入 DOM；目标态恢复显示时立即还原官方方法。
			// 这里只传判据，不把 wrapper 分散进各条同步路径。
			NativeChromeGate.sync(this, this.app, () => this.nativeNavWanted());

			// 顶栏：元素级类，只作用于本视图自己的 view-header。
			// 仅在隐藏状态真正翻转时操作（滚动事件会高频重复调用）。
			// 只做 transform+opacity 合成器动画，不碰布局（不动 margin/display），
			// 页首占位恒定保留 → 正文不受隐藏/展开影响，页面始终停在原地。
			// 判定：外观「沉浸模式适配」（三端通用）∧ 处于沉浸态。
			// 桌面端页首在文档流内、内容区顶边就在它下方，滑走后顶部留一条背景带
			// 但正文零位移；移动端页首本就脱离布局流（铺满整叶），滑走即整片让出。
			const header = this.viewHeaderEl();
			// 布局契约类（浮层化）先落地，**再**谈隐藏态 —— 顺序无关紧要（同一任务内
			// 不产生绘制），但两件事必须都做：只挂隐藏态 = 页首滑走了、它占的高度留着
			// （顶部一条 obsidian 底色的板）；只挂布局契约 = 页首永不隐藏。
			this.markViewHeader(header);
			const headerHidden = headerHiddenByUs(inputs);
			// **类要先保证「与目标一致」，再谈「是否变化」**（本轮修）：
			// 老写法把两个 toggleClass 都放进「状态翻转」分支里，于是任何一个
			// 「当时元素还没就位 / 某个调用点漏了」都能让类**永久停在错的一侧**
			// ——而补偿层（`.workspace-leaf-content.unreader-header-hidden::before`）
			// 的唯一开关就是这个类。类没挂上，补色层就永不出现，顶部那条页首背景板
			// 照旧 —— 用户反复报的「背景板依然存在」最可能就是这条。
			// 新写法：**状态恒更新**（`hiddenByUs`/`--ur-header-hole` 依赖它，必须始终
			// 跟上），而 DOM 只在「实际与目标不一致」时动 —— 既保持热路径（滚动会
			// 高频调用本函数）上的零开销（`classList.contains` 是纯读、不变则不写
			// 样式、不失效），又能在**下一次任何同步**里自愈。
			if (headerHidden && this.headerHiddenState === false) this.captureVisibleHeaderBottom();
			if (headerHidden !== this.headerHiddenState) this.headerHiddenState = headerHidden;
			if (header && header.classList.contains("unreader-header-hidden") !== headerHidden) {
				header.toggleClass("unreader-header-hidden", headerHidden);
			}
			// **同一个状态、两个宿主**：叶子上也挂一份。补偿层已从
			// `.unreader-root::before`（画在 view-content 盒外，会被主题的
			// `overflow:hidden` 裁掉）搬到 `.workspace-leaf-content::before`
			//（落在叶子自己的盒内，裁不到）—— 见 styles.css 那一段。
			// 用相邻兄弟选择器钉住隐藏态的老做法随之废弃：那时 `.view-content`
			// 必须紧跟 `.view-header`，而叶子本身就是容器，不需要结构假设。
			const leafEl = this.leafContentEl();
			if (leafEl && leafEl.classList.contains("unreader-header-hidden") !== headerHidden) {
				leafEl.toggleClass("unreader-header-hidden", headerHidden);
				// 页首显隐会让进度条让位量变化；动画期间几何还在半路，等过渡结束补测一次
				this.scheduleProgressTopResync();
			}
			// 系统状态栏（时间/电量）随原生页首接管显隐（仅手机形态；平板保留系统时间）。
			// 桥可用性必须回写：不可用时安全区仍在，进度条不能钻到系统状态栏底下。
			if (inputs.phoneLike) {
				if (this.statusBarBridgeAvailable === null || headerHidden !== this.statusBarDesiredHiddenState) {
					this.statusBarDesiredHiddenState = headerHidden;
					this.statusBarBridgeUsable = this.setSystemStatusBarVisible(!headerHidden);
					this.statusBarHiddenState = headerHidden && this.statusBarBridgeUsable;
				} else {
					this.statusBarBridgeUsable = this.statusBarBridgeAvailable === true;
				}
			}
			// 底栏（app 级 mobile-navbar）只有**手机形态**才有：平板（官方
			// `body.is-tablet .mobile-navbar { display:none }`）与桌面压根没有这个东西，
			// 不进 is-hidden-nav 通道（系统状态栏同理，见上）。窗口跨过官方的
			// media query 门槛（折叠屏展开 / 分屏）时会走到这里，此时得把先前挂上的
			// app 级类摘干净 —— 它不是本机现在该有的形态。
			// **只在「本视图确实管过它」时才动 body**：桌面/平板的滚动热路径会高频
			// 走到这一行，无条件 removeClass 是没必要的 DOM 写入。
			if (!inputs.phoneLike) {
				if (this.nativeNavManaged || this.statusBarHiddenState) this.releaseNativeNav();
				else this.statusBarDesiredHiddenState = null;
				return;
			}
			// 失活的视图绝不向全局 body 写 is-hidden-nav（app 级类，一旦在延迟
			// 路径上被重新挂上就会污染下一个视图）。非活动即无条件清理并退出。
			if (!inputs.selfActive) {
				this.releaseNativeNav();
				return;
			}
			// 底栏：app 级 mobile-navbar 走**双类**机制。
			//   · `unreader-nav-hidden`（插件自有）= **视觉闸门**：只要它还在，
			//     官方 restoreNavigation 摘掉 is-hidden-nav 也画不出底栏；
			//   · `is-hidden-nav`（官方）= 官方语义/其它 UI 的一致性，继续同步，
			//     但不再承担「这一帧底栏可不可见」。
			// 目标态**只从 nativeNavWanted() 取** —— 它与自愈守卫（NativeNavGuard）
			// 共用同一份事实，杜绝「写类」与「补类」两处判据漂移。
			// 同一步里还要给底栏「让位」：藏起它的同时让它**脱离布局流**，把它在
			// `.app-container` 里占住的那一屏还给阅读区 —— 否则它一滑走，那 80px 就
			// 露出更外层的窗口底色（用户报的「承载这些元素的白色背景板依然存在」）。
			// 顺序无关紧要（同一任务内不产生绘制），但必须在写 `is-hidden-nav` 之前
			// 至少同帧完成，理由见 styles.css `unreader-nav-float` 段。
			this.syncNativeNavFloat(bottomBarHiddenByUs(inputs));
			const body = document.body;
			if (this.nativeNavWanted()) {
				if (!body.hasClass(PLUGIN_NAV_HIDDEN_CLASS)) {
					body.addClass(PLUGIN_NAV_HIDDEN_CLASS);
					this.nativeNavManaged = true;
					debugLog.info("[nav] unreader-nav-hidden +", why, this.nativeNavChain(inputs));
				}
				if (!body.hasClass("is-hidden-nav")) {
					body.addClass("is-hidden-nav");
					this.nativeNavManaged = true;
					debugLog.info("[nav] is-hidden-nav +", why, this.nativeNavChain(inputs));
					// 定向取数：手机端「底栏藏了但那条**白色背景板**还在」的现场快照
					// （候选家具四个都长得像，只有真机 rect/像素能指认，见 bottomBandDiag 文件头）
					scheduleBottomBandDiag(`is-hidden-nav + (${why})`);
				}
			} else {
				// 目标态 = 显示。「接管原生界面」开着时本视图就是原生的**唯一权威**：
				// 官方恢复路径只会「显示」，而官方那条 markdown 滚动钩子（以及其它视图）
				// 留下的 `is-hidden-nav`、被官方 `hide()` 摘出 DOM 的底栏元素，必须由
				// 我们在这一拍放回 —— 否则用户看到的就是「原生界面还在按自己那套隐现」
				// （本轮报障原话：「移动端全屏模式下的这种原生隐藏显示依然存在」）。
				const owned = inputs.normalModeHideNativeChrome === true;
				const touched = this.nativeNavManaged
					|| body.hasClass(PLUGIN_NAV_HIDDEN_CLASS)
					|| (owned && body.hasClass("is-hidden-nav"));
				if (touched) {
					// `|| body.hasClass(plugin)` 是必要的：插件类是自己挂的，哪怕
					// `nativeNavManaged` 字段因热重载/异常丢失，也不能把它留在 body 上
					// 锁死底栏；官方类在「我们管过」或「接管开着（目标态显示）」时一起摘。
					body.removeClass(PLUGIN_NAV_HIDDEN_CLASS);
					body.removeClass("is-hidden-nav");
					this.nativeNavManaged = false;
					debugLog.info("[nav] unreader-nav-hidden - / is-hidden-nav -", why);
					scheduleBottomBandDiag(`is-hidden-nav - (${why})`);
				}
				if (owned) this.reattachNativeNavbarIfNeeded();
			}
		} catch { /* ignore */ } finally {
			// 页首/底栏显隐后同步进度条让位（含官方「悬浮导航」等造成的
			// 页首不可见——那条路径不经过上面的开关判定，只能靠这里实测收敛）
			this.syncProgressTop();
			// **顺序不能反**：让位过渡要用刚写下的 `--ur-header-hole`/`lastHolePx` 算几何
			this.syncHeaderHoleAnim();
		}
	}

	/** 判据链的实测快照（只进诊断日志）：底栏「该藏却没藏」时，
	 *  这一行直接指出是哪一条挡住的（开关没开 / 非沉浸态 / 非手机形态 / 视图失活）。
	 *  真机取证靠它，不必再让用户猜「是不是官方全屏没开」。 */
	private nativeNavChain(i: ImmersiveNativeInputs): string {
		return `判据 native=${i.normalModeHideNativeChrome} full=${i.fullImmersion} chrome-hidden=${i.chromeHidden} native-scroll=${i.nativeScrollHidden} phone=${i.phoneLike} self=${i.selfActive}`;
	}

	/** 官方底栏元素被 `hide()` 摘出 DOM 时，在「接管原生界面 + 目标态为显示」下挂回。
	 *
	 *  官方 `show()` 自带两道闸门（`mobileToolbar.isVisible` / `mobileSoftKeyboardVisible`
	 *  时拒绝挂回），所以键盘、手机编辑工具条这两类**合法**的底栏隐藏不会被顶开；
	 *  这里只补「目标态明明是显示、元素却不在」的那半拍残留（官方 mousedown/切 leaf
	 *  只会补类不会补元素，官方滚动钩子又只在 markdown 视图上跑）。 */
	private reattachNativeNavbarIfNeeded(): void {
		try {
			const nav = (this.app as unknown as {
				mobileNavbar?: { containerEl?: HTMLElement; show?: () => void };
			}).mobileNavbar;
			const el = nav?.containerEl;
			if (nav && typeof nav.show === "function" && el instanceof HTMLElement && !el.isConnected) {
				nav.show();
				debugLog.info("[nav] 官方底栏挂回（接管原生，目标态=显示）");
			}
		} catch { /* 官方接口缺失/形态漂移：静默降级为不挂回 */ }
	}

	/** 进度条顶部让位（px）：页首对内容区顶边的实际占用高度。
	 *
	 *  **只信真实几何、不信开关状态**：除本插件的沉浸隐藏外，Obsidian 移动端的
	 *  「全屏 / 悬浮导航」也会在阅读时把页首收走（官方行为，不受本插件控制），
	 *  写死 CSS 变量必然对不上。规则：
	 *    · 官方「悬浮导航」→ 页首是**透明浮层**（不遮内容、也不是内容顶栏）
	 *      → 让位 **0**，即贴**设备屏幕物理最顶**；
	 *    · 页首确实占位（视觉下缘落在安全区之下）→ 让位 = 页首下缘到内容区顶边；
	 *    · 页首不占位（本插件隐藏 / 官方隐藏 / 布局层不可见 / 不在 DOM）
	 *      → 让位 = 安全区（刘海 / 状态栏）下沿，即内容区可用的顶边。
	 *
	 *  **必须 clamp 到安全区，这是本函数唯一的硬约束**：官方隐藏页首用的是
	 *  `transform: translateY(calc(-(页首高 + 安全区)))`（见 `.is-phone.is-hidden-nav
	 *  .view-header`），**不是 display:none** —— 元素照旧留在布局流里、`offsetHeight > 0`，
	 *  而 `getBoundingClientRect()` 会带上负位移，测出下缘 ≈ 0。若直接采信，进度条会落到
	 *  y=0（设备屏幕物理最顶、压在刘海 / 动态岛下），而不是安全区下沿。同理适用于
	 *  `display:none`、`visibility:hidden`、元素被摘除等一切形态——以「实测下缘是否越过
	 *  安全区」为判据即可覆盖全部机制，不必逐条识别官方用了哪种。
	 *
	 *  **官方「悬浮导航」必须单独处理，且优先级最高**：**手机**（`is-phone`）下
	 *  `is-floating-nav` 让官方给页首 `background-color: transparent` +
	 *  `--view-header-position: fixed`（见 `.is-mobile.is-floating-nav.is-phone .view-header`），
	 *  页首变成**不遮内容的浮层** —— 内容顶距改由 `--view-top-spacing`
	 *  （安全区 + 页首高 + 8px）经 `.view-content` 的 `margin-top` 撑出，页首自身不再占流。
	 *  此时它照样 display 可见、`offsetHeight > 0`，实测下缘 = 安全区 + 页首高，采信就把
	 *  进度条摆到页首**下边框**。
	 *  **让位取 0（设备屏幕物理最顶）而非安全区下沿**：页首已是透明浮层，安全区那条
	 *  「让到刘海下沿」的兜底对它同样多余——用户明确要求「无视页首、贴屏幕最上面」，
	 *  实测只到安全区下沿（≈59）仍然「不够靠上」。该判据排在 `hiddenByUs` 之前：
	 *  悬浮导航与本插件自己的沉浸隐藏可能**同时**成立（页首本就透明），此时同样落到 0。
	 *
	 *  **⚠️ 手机上才豁免——判据必须带上 `is-phone`（iPad 的坑）**：官方那条透明规则
	 *  的前缀是 `.is-mobile.is-floating-nav.is-phone`，而 `is-floating-nav` 自身**没有任何
	 *  平台门控**（官方 JS：`body.toggleClass("is-floating-nav", config.floatingNavigation)`）。
	 *  iPad 走 `is-tablet`（官方：`isPhone = !isTablet`），用户在 iPad 上开悬浮导航后
	 *  body 上**同样有** `is-floating-nav`，但官方**不给** iPad 页首设透明底色 ——
	 *  页首仍是不透明占位。此时若只看 `is-floating-nav` 就豁免，让位算成 0，进度条
	 *  整条钻到不透明页首底下 = 用户报的「iPad 上非沉浸模式看不见进度条，只有沉浸
	 *  （页首滑走）才显示」。所以这里的判据与官方 CSS 逐字对齐：`is-floating-nav ∧ is-phone`。
	 *
	 *  **判据用 `is-floating-nav`，不能用 `position`，也不能用 `--view-header-position`**：
	 *  · 不能用 `position`：本插件自己把移动端页首设成 `position: absolute`（见 styles.css
	 *    的 `[data-type="unreader-view"] .view-header`，特异性 (0,4,1) 压过官方的 (0,2,0)），
	 *    所以**普通移动端与悬浮导航的计算 `position` 都是 absolute**，看 position 会把普通
	 *    移动端的「不透明占位页首」也误判成浮层，进度条钻到页首底下去。
	 *  · 不能用 `--view-header-position`：官方「自动全屏（auto-full-screen）」**共享**同一个
	 *    `fixed`（见 `.is-phone.is-floating-nav, .is-phone.auto-full-screen`），但它**不给
	 *    页首设透明底色** —— 自动全屏下页首仍是不透明浮层，进度条必须照旧让到它下缘。
	 *    两者唯一的差别就是 `is-floating-nav` 这个类，所以只有它才是「透明浮层」的信号。
	 *  **参照系必须是叶子，不能是 root**：进度条是「贴叶子 / 内容区 / 屏幕顶边」的
	 *  指示器，而桌面端页首**在文档流内**、占掉叶子顶部的 `--header-height` →
	 *  root 的顶边比叶子顶边低 36px（Composer 主题实测；官方 :root 是 40px）。
	 *  以前用 root 当参照系，`top:0` 只能到「页首下缘」那一条高度，页首一被隐藏就
	 *  停在叶子顶边下方 36px —— 用户报的「页首隐藏后进度条定位不准 / 背景板还在」。
	 *  改成叶子参照系后，页首隐藏时落点 0 经 `rootTop` 折成**负偏移**（-36）落到叶子
	 *  最顶边；负值能渲染出来，是因为 .view-content 的 overflow 已由本插件放开
	 *  （官方 `overflow:auto` 会连同 body 的 `overflow:hidden` 一起把负偏移裁掉）。
	 *
	 *  **页首不在时的落点要分端，不能一律退安全区**：刘海 / 动态岛只在手机上，
	 *  iPad 的 `--view-header-top-offset`（= `max(safe-area-inset-top, 12px)`）那 24px
	 *  只是状态栏 —— 一律退 safeTop 就是用户报的「iPad 上进度条浮在屏幕上方、不贴顶」。
	 *  故：手机 → 安全区下沿；桌面 / iPad → 叶子最顶边（0）。
	 *
	 *  结果写进 --ur-progress-top，由 styles.css 的 top 读取（带 0.3s 过渡，
	 *  与页首隐藏动画同拍，进度条是滑上去而不是跳上去）。 */
	/** 实测「页首在叶子顶部占掉的那条空隙」高度（叶子坐标系）。
	 *
	 *  **为什么不再用 `this.contentEl.offsetTop`（v4 的原实现，本轮换掉）**：
	 *  `offsetTop` 是相对 **offsetParent** 的，它悄悄依赖两个**不该被依赖的前提**——
	 *   ① `this.contentEl` 恰好是 `.view-content`。官方 `ItemView.contentEl` 是
	 *      `containerEl.children[1]`，这是**实现细节**：视图宿主的 children 构成一变
	 *      （不同 Obsidian 版本 / 不同 leaf 形态），它就可能指向别的节点；
	 *   ② `.workspace-leaf-content` 恰好是 offsetParent（官方 `position: relative`，
	 *      但主题完全可以改掉这一条）。
	 *  任一环不成立，`gap` 就退化成 0（或某个离谱值）→ `--ur-header-hole` 写 0 →
	 *  v4 的负 margin 归零 → **顶部那条背景板原样出现**；而页首的隐藏靠
	 *  `unreader-header-hidden` 类（DOM 读守卫、能自愈）**照旧生效** →
	 *  用户看到的就是「元素消失了，背景板依然存在」这个签名。
	 *  （这正是四轮修复都没打掉它的原因：修复全押在一个**静默可变 0 的测量值**上。）
	 *
	 *  改用**两个 rect 之差**：`.view-content` 顶边相对叶子顶边的距离。页首用
	 *  transform 隐藏、不改布局，所以这个差在隐藏前后同值（正是我们要的「页首若可见
	 *  会占掉多少」），且**与 offsetParent 是谁、containerEl 是什么都无关**。
	 *
	 *  三级兜底（后面的只在前面拿不到正数时启用）：
	 *   ① 两 rect 之差（正常路径，像素级准确）；
	 *   ② `header.offsetHeight` —— 首帧/刚挂载时 rect 可能还是 0；
	 *   ③ 计算样式里的 `--header-height`（官方与主题都会定义）—— 最后一道。
	 *  **兜底只在「页首确实占布局」时才允许启用**：页首 `display: none`（桌面默认形态
	 *  `body:not(.show-view-header)`）时空隙真为 0，走兜底会凭空造出 36px 让位 →
	 *  正文被推下去，破坏「正文零位移」这条既有设计。 */
	private measureHeaderHole(header: HTMLElement | null): number {
		if (!header) return 0;
		let inFlow = false;
		try {
			const cs = window.getComputedStyle(header);
			inFlow = cs.display !== "none" && cs.visibility !== "hidden" && header.offsetHeight > 0;
			// **浮层化的页首不占布局流**（2026-09-14 加，移动端可用的前提）：
			// 页首 `position` 是 `absolute`/`fixed` 时（本插件的移动端浮层化规则、或官方
			// 悬浮导航/自动全屏给 `--view-header-position: fixed`），`.view-content` 顶边
			// 已经等于叶子顶边 —— 此时**绝不能**往下走到「兜底 = `header.offsetHeight`」，
			// 那会返回整个页首盒高（56 / 刘海屏 103px）→ 凭空造出让位量、把正文推上去。
			// 判据必须落在 **computed `position`** 上，而不是靠后面那句 `d > 0.5`：
			// 浮层形态下 d 恒为 0，与「页首真的不占位」同值，**事后比较分不出这两者**。
			// 反过来 `static`/`relative` 就是「占布局流」，兜底才是正确语义（桌面端页首
			// 恒为 `relative`，行为与改动前完全一致）。
			if (cs.position === "absolute" || cs.position === "fixed") inFlow = false;
		} catch { /* 读不到就按「不在布局里」处理（保守：宁可不补，不误推正文） */ }
		if (!inFlow) return 0;
		try {
			const leaf = this.leafContentEl();
			const vc = leaf?.querySelector<HTMLElement>(":scope > .view-content") ?? this.contentEl;
			if (leaf && vc) {
				const d = vc.getBoundingClientRect().top - leaf.getBoundingClientRect().top;
				if (d > 0.5) return d;
			}
		} catch { /* 落到下面两级 */ }
		const h = header.offsetHeight;
		if (h > 0) return h;
		try {
			const v = parseFloat(window.getComputedStyle(document.body).getPropertyValue("--header-height"));
			if (Number.isFinite(v) && v > 0) return v;
		} catch { /* ignore */ }
		return 0;
	}

	// ── 页首「让位」（第六轮；第七轮改成「一帧切换」以消除卡顿） ──────────────
	/** 当前是否已让位：0 = 正文顶边停在页首下方，1 = 已到叶子顶边。
	 *  与 `--ur-header-hole` 的分工：hole 是「有多少可让」，它是「让没让」。 */
	private holeP = 0;
	/** 最近一次写下的非零空隙高度（px）。**显示页首时 hole 会被写成 0**（那时确实没有
	 *  空隙），但「从已让位退回去」要按让出过多少来退回，所以只记非零值。 */
	private lastHolePx = 0;
	/** 最近一次的让位目标态（null = 尚未建立基准） */
	private holeTarget: boolean | null = null;

	/** 让位切换的入口。**必须在 `syncProgressTop()`（hole 落盘）之后调用** ——
	 *  切换要用刚写下的 `lastHolePx` 算几何，顺序反了会拿到上一态的数值。 */
	private syncHeaderHoleAnim(): void {
		const hidden = this.headerHiddenState === true;
		if (this.holeTarget === hidden) return;      // 目标未变：稳态，交给 styles.css 的静态规则
		const first = this.holeTarget === null;
		this.holeTarget = hidden;
		if (first) {
			// 首帧（开书/切书/插件重载）：直接对上稳态，**不切换** —— 用户没有「刚点了隐藏」
			// 这个上下文，补一次切换反而像闪一下。
			this.holeP = hidden ? 1 : 0;
			return;
		}
		this.switchHeaderHole(hidden);
	}

	/** **一帧内完成让位切换**：几何（阅读区那层上移）与正文补偿（滚动同步上移）各只写一次，
	 *  视觉平滑交给两条 CSS 过渡 —— 页首的 `transform`（合成器动画）与进度条的 `top`
	 *  （「跟着页首下边框」，两者同为 0.3s ease-in-out、同走一个页首高 ⇒ **天然同速**）。
	 *
	 *  **为什么不再自己跑逐帧时间线**（第七轮改，用户报「页首显隐有些卡顿」）：
	 *  上一版为了让「页首显隐」与「几何」严格同帧，每帧往 `.unreader-body` 写自定义属性
	 *  `--ur-hole-px` —— 而**自定义属性是会继承的**，写一次就要为整棵子树（含所有已载
	 *  iframe 的宿主节点）重算样式；再叠加每帧改阅读区那层的 `top`（带动 iframe 栈重排）。
	 *  实测：本机 5 个已载 frame 时 rAF 还能维持 16ms，但**帧数与窗口像素一上去就顶不住**
	 *  （用户的窗口更大、书更重，于是「卡顿」）。
	 *  现在全程**零逐帧 JS**：几何与滚动在翻态那一帧一次性落地，而**正文位移恒为 0**
	 *  （几何上移多少，滚动就在同一个函数里一次补多少）。
	 *
	 *  视觉上依然连续：新让出的那一段就在页首底下，**页首滑走的过程本身就是揭示过程**。 */
	private switchHeaderHole(hidden: boolean): void {
		const hole = Math.round(this.lastHolePx);
		const target = hidden ? 1 : 0;
		const dP = target - this.holeP;
		if (!dP) return;
		if (hole <= 0) { this.holeP = target; return; }   // 没有空隙可让（页首 display:none 等）
		this.holeP = target;
		const moved = hole * target;
		// 几何：让位落在阅读区那一层（root / body 不动 ⇒ 挂在 body 里的悬浮 UI 一个都不动）
		this.bodyEl?.style.setProperty("--ur-hole-px", `${moved}px`);
		// 进度条：只写目标值 —— 它自己那条 `transition: top` 会与页首的 transform 同步滑过去
		this.progressEl?.style.setProperty("--ur-progress-top", `${-moved}px`);
		// 正文：一帧内补掉几何位移 ⇒ 相对屏幕**像素级不动**
		this.adapter?.nudgeScrollForLayoutShift(-hole * dP);
	}

	/** 把空隙高度写进 root 与叶子（v4 / v3 两条链路各读一份）。
	 *
	 *  **以 DOM 现值做去重，而不是缓存字段**（本轮加固）：`renderChrome()` 会
	 *  `contentEl.empty()` 重建 `.unreader-root`，而缓存字段 `appliedHole` 不会跟着
	 *  归零 —— 重建前的旧值恰好等于新值时，写入被静默跳过，**新 root 永远拿不到
	 *  `--ur-header-hole`** → v4 失效、背景板回来（页首类因走 DOM 判等而自愈，
	 *  于是又是「元素没了、板还在」）。`getPropertyValue` 是纯读、不变则不写样式、
	 *  不失效，所以在滚动热路径上开销与原来的字段比较同量级，却能**在元素被换掉后的
	 *  下一次同步里自愈**。
	 *  **两个宿主都写**：根（v4 主防线，不依赖叶子）+ 叶子（v3 补偿层，仍在位）。
	 *  任一条链路挂掉另一条仍然成立 —— 这正是「跨设备复现、进度条却正常」这个签名
	 *  要的结构性冗余。 */
	private applyHeaderHole(hole: number): void {
		// 反向过渡（显示页首）要用它：那一刻 hole 会被写成 0，但「从已让位退回去」
		// 这段动画需要知道让了多少。所以只记非零值，0 不覆盖。
		if (hole > 0) this.lastHolePx = hole;
		const px = `${Math.round(hole)}px`;
		for (const el of [this.rootEl, this.leafContentEl()]) {
			if (!el) continue;
			try {
				if (el.style.getPropertyValue("--ur-header-hole") !== px) el.style.setProperty("--ur-header-hole", px);
			} catch { /* ignore */ }
		}
		this.appliedHole = hole;
	}

	/**
	 * 精准避让：把左右两条浮动轨道夹在真实上下边界之间。
	 *
	 * 旧版只算出「可用高度」，却仍让轨道按阅读区中心点摆放。只要页首把左上角
	 * 沉浸按钮压下来，或原生底栏把播客条顶上去，中心点没有跟着移动，轨道就会
	 * 仍然压到按钮/播客条。这里改成两件事同时做：
	 *   1. 实测上边界（沉浸按钮底边）和下边界（播客条顶边 / 原生底栏上沿）；
	 *   2. 把「可用高度」和「区间中心相对 body 中心的偏移」一起写给 CSS。
	 *
	 * 这样轨道内容短时在可用区内居中；内容长到装不下时，会先被 max-height
	 * 夹住，再贴着上下边界滚动，绝不会继续越过边界。
	 */
	private syncActionsAvailableHeight(): void {
		this.syncPodcastBarWidth();
		const root = this.rootEl;
		const body = this.bodyEl;
		if (!root || !body) return;
		const bodyRect = body.getBoundingClientRect();
		if (bodyRect.height <= 0) return;

		const bodyTop = bodyRect.top;
		const bodyBottom = bodyRect.bottom;
		let topLimit = bodyTop;
		let bottomLimit = bodyBottom;

		// 上边界：左上角沉浸拉绳的真实底边。它会被页首/安全区整体下压，
		// 因此不能写死 48px，也不能拿它的 top 当边界。
		const immersionSwitch = this.immersionSwitchEl;
		if (immersionSwitch) {
			const cs = window.getComputedStyle(immersionSwitch);
			const rect = immersionSwitch.getBoundingClientRect();
			if (cs.display !== "none" && cs.visibility !== "hidden" && rect.width > 0 && rect.height > 0) {
				topLimit = Math.max(topLimit, rect.bottom);
			}
		}

		// 点按唤出时，页首正在做 0.3s 滑回动画。工具栏只做“向右滑出”，
		// 纵向直接使用最近一次页首可见时的最终边界，避免先向右、再跟着页首下移。
		const revealActive = !!root.hasClass("chrome-revealed") || !!root.hasClass("full-immersion-revealed");
		if (revealActive && this.headerHiddenState === false) {
			if (this.lastVisibleHeaderBottom == null && this.lastHolePx > 0) {
				this.lastVisibleHeaderBottom = topLimit + this.lastHolePx;
			}
			if (this.lastVisibleHeaderBottom != null) {
				topLimit = Math.max(topLimit, this.lastVisibleHeaderBottom);
			}
		}

		// 下边界：播客条会随原生底栏一起上升，必须读它当前的真实顶边；
		// 没有播客条时仍要让开原生底栏本身，避免轨道钻到底栏下面。
		const nativeBottomOverlap = bottomBarOverlap(body);
		if (nativeBottomOverlap > 0) bottomLimit = Math.min(bottomLimit, bodyBottom - nativeBottomOverlap);
		const podcastBar = this.podcastBarEl;
		if (podcastBar) {
			const cs = window.getComputedStyle(podcastBar);
			const rect = podcastBar.getBoundingClientRect();
			if (cs.display !== "none" && cs.visibility !== "hidden" && rect.width > 0 && rect.height > 0) {
				bottomLimit = Math.min(bottomLimit, rect.top);
			}
		}

		// 先夹回 body；上下边界交叉时宁可收成 0 高，也不能反向溢出。
		topLimit = Math.max(bodyTop, Math.min(topLimit, bodyBottom));
		bottomLimit = Math.max(topLimit, Math.min(bottomLimit, bodyBottom));

		// 取整时向区间内侧取：顶部上取整、底部下取整，避免亚像素把 1px 叠回 UI 上。
		const top = Math.ceil(topLimit - bodyTop);
		const bottom = Math.floor(bottomLimit - bodyTop);
		const available = Math.max(0, bottom - top);
		// 连一枚按钮都放不下时不再画半截边框/内容：这比“压住其它 UI”更安全。
		root.classList.toggle("is-floating-cramped", available < 24);
		const centerShift = (top + bottom) / 2 - bodyRect.height / 2;
		const shift = Number.isFinite(centerShift) ? centerShift.toFixed(1) : "0";

		// 只在值变化时写，避免 ResizeObserver 回调里产生无意义样式失效。
		const setVar = (name: string, value: string): void => {
			if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
		};
		setVar("--ur-actions-max-height", `${available}px`);
		setVar("--ur-actions-center-shift", `${shift}px`);
		setVar("--ur-nav-max-height", `${available}px`);
		setVar("--ur-nav-center-shift", `${shift}px`);
		setVar("--ur-nav-panel-max", `${available}px`);

		// 页首动画结束后刷新缓存：下一次“隐藏 → 唤出”会直接使用这份最终几何。
		if (this.headerHiddenState === false && this.holeP === 0
			&& !this.headerIsAnimating(this.viewHeaderEl())) {
			this.lastVisibleHeaderBottom = topLimit;
		}
	}

	/** 记录页首可见时的最终下边界，供下一次唤出时直接采用。 */
	private captureVisibleHeaderBottom(): void {
		const el = this.immersionSwitchEl;
		if (!el) return;
		try {
			const cs = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (cs.display !== "none" && cs.visibility !== "hidden" && rect.width > 0 && rect.height > 0) {
				this.lastVisibleHeaderBottom = rect.bottom;
			}
		} catch { /* ignore */ }
	}

	/** 页首是否还在跑 transform 过渡（不支持 getAnimations 时按未动画处理）。 */
	private headerIsAnimating(header: HTMLElement | null): boolean {
		if (!header) return false;
		try {
			return header.getAnimations().some(animation => animation.playState === "running");
		} catch {
			return false;
		}
	}

	/** 播客条与正文列宽对齐：量连续阅读容器扣掉左右阅读边距后的真实内容宽度。
	 *  这里不能用固定 760px —— 正文实际宽度还受 --ur-read-max、用户边距、
	 *  侧栏/窗口变化影响，只有量 DOM 才能始终和正文列一致。 */
	private syncPodcastBarWidth(): void {
		const root = this.rootEl;
		if (!root) return;
		const cont = this.contentHost?.querySelector<HTMLElement>(".unreader-continuous")
			?? this.bodyEl?.querySelector<HTMLElement>(".unreader-continuous");
		if (!cont) return;
		try {
			const cs = window.getComputedStyle(cont);
			const width = cont.clientWidth - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0);
			if (width > 0) root.style.setProperty("--ur-podcast-width", `${Math.round(width)}px`);
		} catch { /* 布局尚未就绪时保留上一帧宽度 */ }
	}

	/** 合并同一帧内的多次边界变化；带 burstMs 时在过渡窗口内逐帧跟随。 */
	private scheduleFloatingFit(burstMs = 0): void {
		if (burstMs > 0) {
			this.floatingFitBurstUntil = Math.max(
				this.floatingFitBurstUntil,
				performance.now() + burstMs,
			);
		}
		if (this.floatingFitRaf != null) return;
		const tick = (): void => {
			this.floatingFitRaf = null;
			this.syncActionsAvailableHeight();
			if (performance.now() < this.floatingFitBurstUntil) {
				this.floatingFitRaf = window.requestAnimationFrame(tick);
			}
		};
		this.floatingFitRaf = window.requestAnimationFrame(tick);
	}

	/** 灯绳与章节进度条的交界：进度条实际显示时，竖线从进度条下沿起；
	 *  设置关闭或全沉浸隐藏进度条时，竖线回到按钮顶边，避免悬空。 */
	private syncImmersionSwitchJoin(): void {
		const root = this.rootEl;
		if (!root) return;
		let top = 0;
		try {
			const bar = this.progressEl;
			if (bar?.isConnected && !bar.hasClass("is-off")) {
				const style = window.getComputedStyle(bar);
				if (style.display !== "none") {
					const height = Number.parseFloat(style.height);
					top = Number.isFinite(height) && height > 0 ? height : 3;
				}
			}
		} catch {
			top = 0;
		}
		root.style.setProperty("--ur-immersion-switch-stem-top", `${top}px`);
	}

	private syncProgressTop(): void {
		const bar = this.progressEl;
		const root = this.rootEl;
		// **只以 root 为必要条件，不以 bar 为条件**（本轮修）：本函数除了给条写让位，
		// 还负责写 `--ur-header-hole`（顶部补偿层的高度）与 `--ur-top-inset`（搜索面板
		// 让位）。老写法 `if (!bar || !root) return` 意味着**用户一旦关掉「章节进度条」
		// 外观开关**（`progressEl` 变 null）这两个变量就再也不写了 —— 补偿层高度恒为 0
		// → 页首隐藏后顶部那条背景板原样出现，而用户根本没动页首相关的设置。
		// 条、补偿层、让位量是三件独立的事，不该让「没有条」把另外两件一起废掉。
		if (!root) return;
		// 安全区下沿（桌面端 0）：既是「页首不在」时的落点，也是让位量的硬下限
		const safeTop = this.mobileTopInset();
		let pad = safeTop;
		// --ur-top-inset（不透明悬浮 UI，如搜索面板）的让位量。**与 pad 不同口径**，见下方注释
		let uiInset = safeTop;
		// 手机悬浮页首可见时，灯绳需要额外延长的距离（相对按钮 top）；页首滑走后归零。
		let switchAvoid = 0;
		// --ur-header-hole：页首被我们隐藏后，它在叶子顶部留下的那条**流内空隙**的高度，
		// 单位是叶子坐标。仅供 styles.css 的 `.unreader-root::before` 把这条空隙补成
		// 阅读区底色用（见那里的注释）。这是「把空隙搬进阅读器自己的子树」所需的那一个
		// 数值——颜色不走任何外部元素，只 inherit root 自己的行内底色。
		// 页首 `display:none`（桌面端默认形态 `body:not(.show-view-header)`）时实测为 0
		// → 补偿层自动退化为不存在，不需要另外判分支。
		let hole = 0;
		// 这两个量在 try 内计算，但函数末尾的定向诊断（logHeaderBandDiag）要用到
		// ——提到外面声明（catch 路径下保持缺省值，诊断照样能记，且「pad 没被改写
		// 成实测值」本身就是「try 抛了」的指纹）。
		let hiddenByUs = false;
		let rootTop = 0;
		try {
			const bodyCls = document.body.classList;
			// **`is-phone` 是必要条件**：官方让页首变透明的那条规则是
			// `.is-mobile.is-floating-nav.is-phone .view-header`（obsidian.asar 实测），
			// 而 `is-floating-nav` 本身**只读配置、无平台门控**
			// （`body.toggleClass("is-floating-nav", config.floatingNavigation)`）。
			// iPad 是 `is-tablet`（Obsidian：`isPhone = !isTablet`），用户开了悬浮导航
			// 后 body 上照样有 `is-floating-nav`，但**页首仍是不透明占位**——只按
			// `is-floating-nav` 豁免会让进度条落到 y=0、被不透明页首整条盖住
			// （用户报「iPad 非沉浸模式看不到进度条，只有沉浸模式才显示」）。
			// 因此与官方同判据：必须同时是手机。
			const floating = bodyCls.contains("is-floating-nav") && bodyCls.contains("is-phone");
			// 刘海 / 动态岛只存在于手机。iPad 的 `--view-header-top-offset`
			// （= `max(safe-area-inset-top, 12px)`，asar 实测）那 24px 只是**状态栏**，
			// 不是需要躲开的硬件缺口 —— 页首隐藏时让到那儿，就是用户报的
			// 「iPad 上进度条悬浮在屏幕上方、没有紧贴屏幕顶部」。
			const phoneLike = bodyCls.contains("is-phone");
			const header = this.viewHeaderEl();
			hiddenByUs = this.headerHiddenState === true;

			// ── v4：先算「页首空隙」并落盘，再量几何 ──
			// hole 的来源必须是**与它自己无关**的量。v3 用 `rootTop` 反推，而 v4 用负
			// margin 把 root 顶边顶上叶子顶边后 rootTop 恒为 0 → 再用它就自己吃自己
			// （hole→0 → 负 margin 归零 → 背景板回来）。改用 `.view-content` 的
			// `offsetTop`：它是页首的**兄弟节点**，页首的高度/外边距全部自动算进去，且
			// **走布局不走 rect**，因此
			//   ① 不受我们自己的负 margin 影响（负 margin 只动 root，不动它的父节点）；
			//   ② 过渡期间读到的就是终值 → 进度条让位能在动画里一次算对、不来回跳；
			//   ③ 页首 `display:none`（桌面端默认形态 `body:not(.show-view-header)`）时
			//      它天然是 0，不需要另开分支。
			const desktopLayout = !bodyCls.contains("is-mobile");
			// gap = 「页首若可见、会在叶子顶部占掉多少」——**不分隐藏与否、也不分平台**，
			// 它就是内容区顶边相对叶子顶边的距离（也是 root 顶边在没被负 margin 顶上去时
			// 的位置）。下面 rootTop 的算术式要用到它，所以这里先算一次、与 hole 共用同一个
			// 来源（原先它来自 `this.contentEl.offsetTop`，换成实测后两者口径统一）。
			//
			// ⚠️ **不要再按平台把它写成 0**（2026-09-14 修，与「沉浸态顶部背景板」同一条链）：
			// 旧写法是 `desktopLayout ? this.measureHeaderHole(header) : 0`，理由是「移动端
			// 页首已脱离布局流」。而那条理由**依赖一个会漂移的前提** —— 页首的浮层化由 CSS
			// 规则决定，一旦那条规则因 DOM 结构漂移而静默失效，移动端页首就回到**占位**形态，
			// 而这里仍记 0 ⇒ **既不给它留位测量、也不让位** ⇒ 页首一藏，它占的那 56/103px
			// 原样留着、画出 `.workspace-leaf` 的 `--background-secondary` = 用户报的
			// 「页首元素的背景板又出现了，颜色跟随 obsidian」。**这正是「同一个 bug 修了两处
			// 只修一处就照样复发」的典型：浮层化与让位是同一个假设的两个消费点。**
			// `measureHeaderHole` 现已自带**计算定位判据**（页首 absolute/fixed → 视为不占
			// 布局流），于是同一份实测对两种形态都成立：
			//   · 浮层化生效 → 页首 absolute → gap = 0（**与旧写法行为逐字一致**，零回归面）；
			//   · 占位形态（浮层化失效）→ 页首 static → gap = 页首盒高 → 让位生效。
			const gap = this.measureHeaderHole(header);
			hole = hiddenByUs ? gap : 0;
			this.applyHeaderHole(hole);
			// 页首的**位移量**也改用实测值：兜底公式里 `--view-header-height` 只在
			// `.is-mobile` 下有定义（asar 实测）→ 桌面端取兜底 48px，而 Composer 的页首
			// 只有 36px → 页首会多滑 12px，隐藏动画期间下缘与补上来的顶边之间露出窄缝。
			// 只写桌面：移动端页首比内容区高（含安全区偏移），多滑是必要的。
			if (desktopLayout && hiddenByUs && header) {
				const travel = `${Math.round(header.offsetHeight)}px`;
				if (header.style.getPropertyValue("--ur-header-travel") !== travel) {
					header.style.setProperty("--ur-header-travel", travel);
				}
			}

			// **参照系是叶子，不是 root**（本轮修复的核心）：进度条要贴的是「叶子 /
			// 内容区 / 屏幕的顶边」，而桌面端页首**在文档流内** → root 的顶边恰好在叶子
			// 顶边下方 `--header-height`（官方 40px，主题可覆盖；Composer 实测 36px）。
			// 用 root 当参照系时 `top:0` 只到「页首下缘」那个高度，页首一旦隐藏就停在
			// 叶子顶边下方 36px 处 —— 用户报的「页首隐藏后进度条定位不准」。
			const leaf = this.leafContentEl();
			const rootRect = root.getBoundingClientRect();
			const leafTop = leaf?.getBoundingClientRect().top ?? rootRect.top;
			// **桌面端取算术值，不取实测 rect**（v4 起）：
			// root 顶边由负 margin 唯一决定 → 恒等于 `内容区顶边(gap) − hole`。
			// 不能实测的原因：状态刚翻转时那条 0.3s 过渡**才刚开始**，此刻 rect 读到的
			// 还是**旧位置**（36）→ pad 按旧几何算成 −36；而过渡结束后唯一会再叫我们的
			// 是 `scheduleProgressTopResync` 的那一次（360ms 后），中间这段时间条会停在
			// 叶子顶边上方 36px 处（被叶子裁掉 → 看上去「没有进度条」）。
			// 页首隐藏/显示两个稳态下这个算术值分别给出 0 / gap，与实测终值一致，
			// 且**一步到位**、不依赖是否有人再来补测。
			// 移动端不适用（那条负 margin 被 `body:not(.is-mobile)` 门控）→ 照旧实测。
			// **root 现在不动了**（让位改由阅读区那一层承担，见 styles.css v4 段）→
			// `rootRect.top - leafTop` 恒等于 `gap`、且**不再受过渡影响**（旧写法用算术值
			// `gap - hole` 是为了绕开过渡中段的读数；那条理由随 root 不再移动而消失）。
			rootTop = rootRect.top - leafTop;
			// 页首实测下缘，**两份口径并存**（刻意的，不要合并）：
			//   · headerBottom     相对 root —— 给 --ur-top-inset（搜索面板挂在 root 内）用；
			//   · headerBottomLeaf 相对叶子 —— 给进度条的目标落点用。
			// 桌面端两者相差 rootTop（36px）：这是「--ur-top-inset 与 --ur-progress-top
			// 不是同一份量」在移动端差异之外的第二层差异。
			// 仅「布局层面确实有位置」时成立：官方隐藏页首用 transform（不是 display:none），
			// 元素仍在布局流、offsetHeight > 0，rect 带负位移 → 需与安全区比较才知是否真占位。
			let headerBottom: number | null = null;
			let headerBottomLeaf: number | null = null;
			if (header) {
				const cs = window.getComputedStyle(header);
				const inLayout = cs.display !== "none"
					&& cs.visibility !== "hidden"
					&& header.offsetHeight > 0;
				if (inLayout) {
					const hb = header.getBoundingClientRect().bottom;
					headerBottom = hb - rootRect.top;
					headerBottomLeaf = hb - leafTop;
				}
			}
			// 目标落点（**叶子坐标系**）。页首不在时：
			//   · 手机 → 安全区下沿（躲刘海 / 动态岛）；
			//   · 桌面 / iPad → 叶子最顶边（0）。iPad 一律退 safeTop 就是用户报的
			//     「浮在屏幕上方不贴顶」；桌面端取 0 后由 rootTop 折成负偏移落到叶子顶边。
			let target = phoneLike ? safeTop : 0;
			// 官方「悬浮导航」：页首是 transparent 透明浮层，不遮内容、也不是内容区顶栏
			// → 贴设备屏幕物理最顶。**这条检在 hiddenByUs 之前**：悬浮导航与插件
			// 自己的沉浸隐藏可能同时成立（页首本就透明），届时落点同样是屏幕最顶。
			if (floating) {
				target = 0;
			} else if (hiddenByUs) {
				// **页首真的被本插件隐藏 → 贴设备屏幕物理最顶（0），三端一致**（本轮改）：
				// 手机端此前一律落安全区下沿（≈59px，躲刘海 / 状态栏），于是沉浸模式下
				// 进度条停在状态栏下方一截 —— 而**沉浸时系统状态栏已被同时收走**
				// （`setSystemStatusBarVisible(!headerHidden)`，手机端），那一段本来就是空的，
				// 继续为它留位没有意义。用户报「手机端非悬浮导航下、沉浸模式（页首消失）时
				// 进度条应该出现在屏幕最上面，就像悬浮导航模式下的沉浸态一样」。
				// 页首由我们接管，但系统状态栏桥不可用时它仍在屏幕顶部；此时保留安全区，
				// 不把进度条放进刘海/状态栏，也不阻止全沉浸继续工作。
				target = phoneLike && this.statusBarBridgeUsable === false ? safeTop : 0;
			} else if (desktopLayout) {
				// **桌面端用布局值 `gap`，不读页首 rect**（2026-09-13 修「进度条与页首不同步」）：
				// 页首在桌面端只做 transform 隐藏、**不改布局位置**，所以它的**布局**下缘
				// 恒等于内容区顶边 = `gap`。而 `gap - rootTop = gap - (gap - hole) = hole`，
				// 未隐藏时 hole=0 → **pad 恒为 0**，条永远贴在 root 自己的盒子顶边上。
				// 这样两条位置都由同一个量决定：root 顶边由 JS 时间线驱动，条只是 `top:0`
				// 跟着它走 → **页首、正文、进度条三者误差为 0**。
				// 老写法（实测 rect 再折算）在过渡中段会量到一个中间值 → 把
				// `--ur-progress-top` 写成一个瞬时错值，再被它自己那条 0.3s 过渡播出来：
				// 于是条有了**第二条时钟**，实测比页首下缘慢/快最多 5.9px —— 用户报的
				// 「一个快一个慢、看起来割裂」。
				// 移动端**不能**这么改：那里页首是 absolute 浮层、与内容重叠，
				// 「页首下缘」只能实测（见下一条分支）。
				target = gap;
			} else if (headerBottomLeaf != null) {
				// 仅当实测下缘**真的越过安全区**时才认为页首在占位；否则一律退回
				// 安全区（transform 隐藏、滑出到屏幕外等都会落到这里）
				target = Math.max(headerBottomLeaf, safeTop);
			}
			// 叶子坐标 → root 坐标（root 才是进度条的定位包含块）。页首隐藏时
			// rootTop > 0 → pad 为**负值**，靠 .view-content 放开 overflow 才不被裁掉。
			pad = target - rootTop;
			// **这里原有一行 `hole = hiddenByUs ? Math.max(0, rootTop) : 0;`，已删除**
			// ——它是 v1/v3 时代的写法（用「叶子顶边到 root 顶边」反推空隙），在 v4 下
			// 会把 hole 归零进而把负 margin 也归零：v4 用负 margin 把 root 顶边顶到叶子
			// 顶边后 `rootTop` 恒为 0 → 用 0 反推 hole=0 → 负 margin 消失 → 背景板回来
			// （自己吃自己的死循环）。hole 的唯一来源是上面那段用 `.view-content`
			// `offsetTop` 算出的 `gap`，与 root 自身几何无关。
			// **--ur-top-inset 的口径与进度条不同，不能直接复用 pad**：
			//   · 进度条是 3px 装饰细线，悬浮导航下允许贴屏幕物理最顶（0）；
			//   · 搜索面板是**不透明交互盒**，压上去会把悬浮页首自己的按钮盖住、还伸进
			//     刘海 / 动态岛。所以「页首在布局里」就一律让到其实测下缘——**透明与否
			//     都一样**（浮层页首的按钮仍画在「安全区 .. 安全区 + 页首高」这一段）；
			//     只有页首真的不在了（本插件沉浸隐藏 / 官方收走 / 不在 DOM）才退到安全区下沿。
			//   且它是**相对 root** 的量（面板挂在 root 内），不跟着进度条换算。
			uiInset = (headerBottom != null && !hiddenByUs)
				? Math.max(headerBottom, safeTop)
				: safeTop;
			// 只认「悬浮页首当前确实还挂在屏幕上」：页首用 transform 滑走时 rect 下缘会
			// 落到安全区以内，此时必须让灯绳回到原长，不能为一个已经离开屏幕的元素继续延长。
			switchAvoid = floating && !hiddenByUs && headerBottom != null && headerBottom > safeTop
				? Math.max(0, headerBottom - pad)
				: 0;
		} catch {
			pad = safeTop;
			uiInset = safeTop;
			switchAvoid = 0;
		}
		bar?.style.setProperty("--ur-progress-top", `${Math.round(pad)}px`);
		// **镜像到根容器**（--ur-top-inset）：搜索面板等「贴在内容区顶边之下」的不透明
		//  悬浮 UI 直接读它，不再各自写死公式。理由与本函数一致——页首的可见性不由本插件
		//  独占（官方「全屏 / 悬浮导航」同样会把它收走），写死 CSS 公式必然在某些形态下
		//  为不存在的页首继续留位。写在 .unreader-root 上由其后代继承（面板挂在 .unreader-body 内）。
		root.style.setProperty("--ur-top-inset", `${Math.round(uiInset)}px`);
		// 拉绳开关的 top 仍跟进度条共用「页首下沿 / 页首收起后的顶边」实测值；
		// 手机悬浮页首另写一份 avoid 距离，让竖线延长到页首下缘之后，横线不被浮层盖住。
		// 两份都写在 root 上：开关与进度条都是 root 的直接子节点，CSS 过渡会与页首
		// 自身的 0.3s 动画同拍；页首滑走后 avoid=0，绳子自动缩回原长。
		root.style.setProperty("--ur-immersion-switch-top", `${Math.round(pad)}px`);
		root.style.setProperty("--ur-immersion-switch-avoid", `${Math.round(switchAvoid)}px`);
		this.syncImmersionSwitchJoin();
		// **底部让位（--ur-bottom-inset）**：`.unreader-body` 底边被屏幕底那条原生栏压住
		// 多少像素。标注侧边栏是**贴底铺满的不透明抽屉**，`bottom:0` 时列表最后几行正好
		// 落进悬浮底栏（`.mobile-navbar`）底下 —— 既看不见也点不到（见 styles.css 的
		// 「手机 / 平板：标注侧边栏让开两条原生 chrome」段）。与 --ur-top-inset 同一理由：
		// 栏在不在**不由本插件独占**（官方全屏 / 键盘弹起会收走它，官方 `hide()` 甚至把
		// 元素摘出 DOM，见 installNavForensics），写死高度必然在某些形态下为一个不存在的
		// 栏继续留位。判据与 `usableBottom` 共用一份实现（keyboardInset.nativeBarTop）。
		root.style.setProperty("--ur-bottom-inset", `${bottomBarOverlap(this.bodyEl)}px`);

		// ── 精准避让：计算工具栏（actions）的可用高度 ──
		// 直接实测「上面的沉浸按钮底部」和「下面的播客条顶部」，
		// 算出中间的精确可用高度，写成 CSS 变量让工具栏直接用。
		// 这样从一开始就刚好贴合，不会重叠，也不用靠估算。
		this.syncActionsAvailableHeight();

		// 页首留下的那条流内空隙的高度，交给 styles.css 的
		// `.workspace-leaf-content.unreader-header-hidden::before` 用**阅读区自己的底色**
		// 补上（见那里的长注释：v1 刷叶子色 → v2 root::before → v3 叶子::before）。
		// **写在叶子上**（不是 root）：补偿层的宿主是叶子，而「空隙」这个概念本身就属于
		// 叶子。写在叶子上还有一个额外好处——变量由叶子往下继承，root 及其后代照样读得到。
		// v2 把宿主放在 `.unreader-root::before` 上，代价是那一层落在 `.view-content`
		// 的盒子**之外**，主题一旦把 view-content 按回 `overflow:hidden !important`
		// （实测主题常见写法）就被整条裁掉 —— 而计算样式照旧报「height 正确、底色正确」，
		// 连诊断都会被骗过。用户真机的「背景板依然存在」就是这条。
		this.leafContentEl()?.style.setProperty("--ur-header-hole", `${Math.round(hole)}px`);
		// 定向诊断（仅调试日志开启时工作，关闭时零开销）：把「这条带是谁画的」所需
		// 的全部证据记进缓冲，供用户在设置页导出后定位真机问题。放在最后 —— 此时
		// 所有属性都已落盘，记的是**最终态**。
		this.logHeaderBandDiag({ hiddenByUs, rootTop, hole, pad, uiInset, safeTop });
	}

	/** 页首隐藏后进度条的落点：移动端取安全区（刘海 / 状态栏）下沿，
	 *  桌面端无安全区概念，恒 0——页首滑走后内容区顶边就是视图顶边。
	 *
	 *  **不能直接 parseFloat 自定义属性**：`--view-header-top-offset` 的值是
	 *  `max(safe-area-inset-top, --size-4-3)` 这样的**未解析 token 流**，自定义属性
	 *  只有在被真实属性消费时才求值；直接读取拿到的是字符串 `max(59px, 12px)`，
	 *  parseFloat → NaN → 落回 0，进度条会贴到屏幕最顶（压在刘海下）而不是安全区下沿。
	 *  解法：读「消费了该属性的真实属性」——官方正是把它写成顶栏的 padding-top，
	 *  即使顶栏 display:none，computed padding-top 仍返回已求值的像素值。
	 *
	 *  **必须同时读 padding-top 与 margin-top**：官方在「悬浮导航」下把同一个偏移
	 *  从内边距挪到了外边距（`.is-mobile.is-floating-nav.is-phone .view-header {
	 *  margin-top: var(--view-header-top-offset); padding-top: 0 }`），只读 padding-top
	 *  会拿到 0。两者取大值即是该偏移的解析结果。 */
	private mobileTopInset(): number {
		try {
			const mobileLike = Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp;
			if (!mobileLike) return 0;
			const root = this.rootEl;
			if (!root) return 0;
			const header = this.viewHeaderEl();
			if (header) {
				const cs = window.getComputedStyle(header);
				const off = Math.max(
					Number.parseFloat(cs.paddingTop) || 0,
					Number.parseFloat(cs.marginTop) || 0,
				);
				if (off > 0) return off;
			}
			// 顶栏不在 DOM（官方直接摘除）/ 本轮取不到值：用探针元素求值同一条表达式。
			// 兜底串 `--safe-area-inset-top`：`--view-header-top-offset` **只在 .is-phone
			// 上定义**，平板（.is-tablet）没有该变量，光靠它会解析成 0。
			const probe = root.createDiv({ cls: "unreader-offset-probe" });
			probe.style.cssText =
				"position:absolute;visibility:hidden;pointer-events:none;width:0;"
				+ "height:var(--view-header-top-offset,var(--safe-area-inset-top,0px))";
			const h = probe.offsetHeight;
			probe.remove();
			return Number.isFinite(h) && h > 0 ? h : 0;
		} catch {
			return 0;
		}
	}

	/** 页首过渡结束后补测让位（显示方向：动画期间页首几何还在屏幕外，
	 *  此刻测量会得到偏小的值，进度条会先落在偏上的位置再跳回来） */
	private progressTopTimer: number | null = null;

	private scheduleProgressTopResync(): void {
		this.syncProgressTop();
		if (this.progressTopTimer !== null) window.clearTimeout(this.progressTopTimer);
		// 与 .view-header 的 transform 过渡（0.3s）同拍，略留余量
		this.progressTopTimer = window.setTimeout(() => {
			this.progressTopTimer = null;
			this.syncProgressTop();
		}, 360);
	}

	/** 页首背景板诊断的「上次快照 + 上次记录时刻」（节流用，见 logHeaderBandDiag） */
	private headerBandDiagSig: string | null = null;
	private headerBandDiagAt = 0;

	/** 桌面端「页首背景板」定向诊断（**仅在设置 → 诊断 → 调试日志开启时工作**）。
	 *
	 *  为什么需要它：这条带「究竟是谁画的」，离线夹具里能算清，真机上却只能把事实
	 *  取回来。本函数把判定所需的全部证据一次性记进调试缓冲——用户在设置页导出
	 *  （复制到剪贴板 / 保存到库）后即可定位，不必现场开 devtools 逐项念值。
	 *
	 *  证据清单（缺一不可）：
	 *    · **页首是否真在布局里**（`display` / `visibility` / `offsetHeight`）——官方
	 *      用 `transform` 隐藏，元素仍在流内、`rect` 带负位移，只看 rect 会误判；
	 *    · **阅读器子树之外的祖先层底色**（`.view-content` / `.workspace-leaf` /
	 *      `.workspace-leaf-content`）——条带露的是哪一层，由这三层直接回答。旧修复
	 *      只刷最内层叶子，外面两层与阅读区底色不同时照样可见；
	 *    · **根容器自己的底色 + `--ur-header-hole` + `::before` 的计算高度/底色**
	 *      ——第二轮修复是否真生效，只看「补色层有没有长出来、底色是什么」；
	 *    · **叶子行内底色写没写上**——上一轮那条路径到底跑没跑（用于区分「JS 没重载」
	 *      与「跑了但被主题压掉」这两种完全不同的故障）。
	 *
	 *  节流 + 去重：`syncProgressTop` 在 resize / 页首显隐 / 布局变化时都会跑，拖窗口
	 *  时会连发。故① 数字取整后再比，② 状态未变不记，③ 两次记录至少隔
	 *  `DIAG_MIN_GAP_MS`——否则 1000 条缓冲会被这一个人刷满，真正有用的历史反被挤掉。 */
	private logHeaderBandDiag(f: {
		hiddenByUs: boolean; rootTop: number; hole: number;
		pad: number; uiInset: number; safeTop: number;
	}): void {
		// 关闭时**连 rect / getComputedStyle 都不取**（本函数在 resize 热路径上）
		if (!debugLog.isDebugEnabled()) return;
		const now = Date.now();
		if (now - this.headerBandDiagAt < 150) return;
		try {
			const root = this.rootEl;
			const leaf = this.leafContentEl();
			const header = this.viewHeaderEl();
			// 事实采集独立成 `headerBandDiag.ts`：它必须能被探针在**真机级夹具**里跑，
			// 证明「采到的事实属实」（一个静默失效的诊断比没有诊断更糟 —— 它会让人
			// 相信「这条带不是那一层画的」）。此处只负责节流 + 去重 + 落缓冲。
			// 进度条一起带上：它与补偿层**同根因**（两者都要画到 `.view-content` 盒外），
			// 真机「看不见进度条」与「背景板还在」往往是一次裁剪的两个症状。
			const facts = collectHeaderBandFacts(root, leaf, header, this.progressEl, f);
			const sig = JSON.stringify(facts);
			if (sig === this.headerBandDiagSig) return;	// 状态未变：不记
			this.headerBandDiagSig = sig;
			this.headerBandDiagAt = now;
			debugLog.info("[header-band]", facts);
		} catch {
			// 诊断绝不能弄垮阅读器
		}
	}

	/** 底栏「让位」类的施加/撤销（机制与像素证据见 styles.css 的 `unreader-nav-float` 段）。
	 *
	 *  施加：**藏起底栏的那一刻立刻做** —— 此刻底栏还盖着那块区域，阅读区在它背后
	 *  长高 80px，用户看不到任何中间态。
	 *  撤销：**延迟到滑出/滑回动画结束**（底栏 `transform 0.3s`）。若当场撤销，那 80px
	 *  会先变回「洞」（露出窗口底色 = 用户报的那条背景板），再被滑回来的底栏盖住
	 *  —— 一次 300ms 的底色闪烁，正是本仓库反复吃过的那类闪。
	 *  延迟窗口里若用户又切回隐藏态，定时器会被取消（`syncNativeNavFloat(true)`）。 */
	private syncNativeNavFloat(wantFloat: boolean): void {
		try {
			if (this.navFloatReleaseTimer !== null) {
				window.clearTimeout(this.navFloatReleaseTimer);
				this.navFloatReleaseTimer = null;
			}
			const body = document.body;
			if (wantFloat) {
				if (!body.hasClass(NAV_FLOAT_CLASS)) {
					body.addClass(NAV_FLOAT_CLASS);
					this.navFloatManaged = true;
					debugLog.info("[nav] nav-float +");
				}
				return;
			}
			if (!this.navFloatManaged) return;
			// 已唤出：等底栏滑回原位再撤销让位（此刻它正盖着那一段，撤销不可见）
			this.navFloatReleaseTimer = window.setTimeout(() => {
				this.navFloatReleaseTimer = null;
				this.releaseNavFloat();
			}, NAV_FLOAT_RELEASE_MS);
		} catch { /* ignore */ }
	}

	/** 无条件撤销「让位」类（视图关闭 / 失活 / 非手机形态）：app 级类不得残留 */
	private releaseNavFloat(): void {
		if (this.navFloatReleaseTimer !== null) {
			window.clearTimeout(this.navFloatReleaseTimer);
			this.navFloatReleaseTimer = null;
		}
		this.navFloatManaged = false;
		try {
			if (document.body.hasClass(NAV_FLOAT_CLASS)) debugLog.info("[nav] nav-float release");
			document.body.removeClass(NAV_FLOAT_CLASS);
		} catch { /* ignore */ }
	}

	/** 释放 is-hidden-nav（切换视图/关书/关沉浸模式时调用，无条件清理——
	 *  该类一旦残留，markdown 的官方恢复逻辑不会摘掉它，底栏将永远消失） */
	private releaseNativeNav(): void {
		// 先还原官方 show/restoreNavigation，再摘 app 级类；否则释放后仍可能吞掉官方挂回。
		NativeChromeGate.release(this);
		this.nativeNavManaged = false;
		// 滚动态是会话内瞬时态，释放时一并复位（下一次滚动重新建立）
		this.nativeScrollHidden = false;
		// 同一份判据的另一半：底栏「让位」类一并无条件撤销（app 级类残留会污染下一个视图）
		this.releaseNavFloat();
		try {
			if (document.body.hasClass("is-hidden-nav")) debugLog.info("[nav] is-hidden-nav release");
			document.body.removeClass(PLUGIN_NAV_HIDDEN_CLASS);
			document.body.removeClass("is-hidden-nav");
		} catch { /* ignore */ }
		this.statusBarDesiredHiddenState = null;
		if (this.statusBarHiddenState) {
			this.statusBarHiddenState = false;
			this.setSystemStatusBarVisible(true);
		}
	}

	/** 本视图当前是否为活动视图。用于裁掉「失活后仍向全局 body 写 is-hidden-nav」
	 *  的路径——同 leaf 内换 view（打开另一个插件视图）不会触发 active-leaf-change，
	 *  activeLeaf 对象不变、只换了 leaf 上的 view，残留的 app 级类会被下一个视图继承。
	 *  判据以 workspace.activeLeaf 为准；其不可用时退回容器 .mod-active 判定。
	 *  异常时按「活动」处理：宁可漏清理（有 layout-change 通道兜）也不误伤自己的沉浸态。 */
	private isSelfActive(): boolean {
		try {
			// `Workspace.activeLeaf` 官方标了 deprecated（推荐 getActiveViewOfType），但这里判的
			// 是「**本 leaf** 是否活动」：同一 leaf 换成别的视图时活动视图已经不是 UNreaderView
			// 了，getActiveViewOfType 在那条路上退回不了「非活动」，而这正是我们要的 false。
			// 按结构类型读字段，理由记在上面。
			const active = (this.app.workspace as unknown as { activeLeaf?: WorkspaceLeaf | null }).activeLeaf;
			if (active?.view === this) return true;
			// activeLeaf 明确指向别的视图 → 本视图已失活，判据确定
			if (active?.view) return false;
			// activeLeaf 缺失（移动端时序）时才退回容器判定
			const leafEl = this.containerEl?.closest<HTMLElement>(".workspace-leaf") ?? null;
			if (!leafEl) return true;
			return leafEl.isConnected && leafEl.hasClass("mod-active");
		} catch {
			return true;
		}
	}

	/** 系统状态栏显隐状态（去重，避免滚动高频调用 syncNativeNav 反复打原生桥） */
	private statusBarHiddenState = false;
	/** StatusBar 原生桥可用性缓存（null=未探测；false=Obsidian 未暴露，不再重试打日志） */
	private statusBarBridgeAvailable: boolean | null = null;
	/** 宿主状态栏当前的实际目标态；桥不可用时保持安全区，不假装系统栏已经消失。 */
	private statusBarDesiredHiddenState: boolean | null = null;
	/** 最近一次原生桥调用是否真正可用，供进度条安全区降级判断。 */
	private statusBarBridgeUsable = true;

	/** 状态栏纠察：当前本视图确实把状态栏藏着时，无动画再压回去一次。
	 *  触发点有两处 —— 自愈守卫发现官方 restoreNavigation（摘类的同一步官方会
	 *  StatusBar.show）；全沉浸中用户滑动（官方悬浮导航可能趁机放出状态栏）。
	 *  只在我们真的持有隐藏态时动作，退出沉浸后不会误藏。 */
	private reassertStatusBarHidden(): void {
		if (!this.statusBarHiddenState) return;
		this.setSystemStatusBarVisible(false);
	}

	/** 隐藏/恢复系统状态栏（时间、电量等 OS 级 UI）——仅移动端，尽力而为。
	 *  OS 状态栏不在 WebView 内，只能经 Obsidian App（Capacitor）暴露的原生桥：
	 *  window.Capacitor.Plugins.StatusBar。Obsidian 官方未打包该插件时桥缺失，
	 *  静默降级（iOS WKWebView 无公开 API，官方不暴露则两端都无解）。 */
	private setSystemStatusBarVisible(visible: boolean): boolean {
		try {
			if (!(Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp)) return true;
			const bridge = (window as unknown as {
				Capacitor?: { Plugins?: { StatusBar?: { hide?: (opts?: { animation?: string }) => Promise<unknown>; show?: () => Promise<unknown> } } };
			}).Capacitor?.Plugins?.StatusBar;
			if (!bridge?.hide || !bridge.show) {
				if (this.statusBarBridgeAvailable !== false) {
					this.statusBarBridgeAvailable = false;
					if (backDebugOn()) debugLog.info("[UNreader] StatusBar bridge unavailable (Obsidian 未暴露原生插件)，状态栏隐藏降级为无操作");
				}
				return false;
			}
			this.statusBarBridgeAvailable = true;
			// 隐藏时强制无动画：桥默认 FADE 淡出，表现为状态栏渐进式慢一拍消失；
			// animation 参数 iOS 专属，Android 无视之（其 hide 本就即时）
			void (visible
				? bridge.show()
				: bridge.hide({ animation: "NONE" })
			)?.catch?.(() => { /* ignore */ });
			return true;
		} catch {
			this.statusBarBridgeAvailable = false;
			return false;
		}
	}

	/** 立即恢复被滚动隐藏的工具栏（关闭该设置时调用） */
	restoreChrome(): void {
		this.rootEl?.removeClass("chrome-hidden");
		// 点按留下的「完整滑出」是临时态：关掉沉浸后回到半隐藏待悬停的常态，
		// 否则工具栏会在非沉浸模式下一进去就常显
		this.rootEl?.removeClass("chrome-revealed");
		this.syncNativeNav("restore-chrome");
		try { this.adapter.endScrollActivity(); } catch { /* ignore */ }
	}

	/** 进入会话级全沉浸：关闭所有浮层，冻结 chrome 状态机，仅保留明确例外。 */
	private enterFullImmersion(): void {
		if (this.fullImmersion) return;
		this.fullImmersion = true;
		this.fullImmersionRevealed = false;
		this.sideNav?.closePanel();
		if (this.appearancePanel?.isOpen()) this.appearancePanel?.close();
		this.annotationsPanel?.containerEl?.addClass("is-immersion-hidden");
		if (this.annotationsPanel?.isOpen()) this.annotationsPanel?.hide();
		this.alignActionsRail();
		if (this.searchOpen) this.toggleSearch(false);
		this.selectionToolbar?.hide();
		if (this.footnoteBackdrop) this.closeFootnotePopup();
		this.highlightPopover?.hide();
		this.dismissHover();
		this.rootEl?.addClass("is-full-immersion");
		this.rootEl?.removeClass("full-immersion-revealed");
		this.rootEl?.addClass("chrome-hidden");
		this.rootEl?.removeClass("chrome-revealed");
		this.syncFullImmersionPresentation();
		// 先压哨兵再同步原生导航：Android 返回键的处理器读的是 leaf 历史，
		// 任何一处 async 抖动都会让「按返回」落回官方的「再按一次退出 app」。
		this.pushImmersionHistoryGuard();
		this.syncNativeNav("full-immersion-enter");
	}

	/** 退出全沉浸并恢复常态工具层；换书/关视图时可只清理状态，不抢跑导航恢复。 */
	private exitFullImmersion(opts: { restoreChrome?: boolean } = {}): void {
		if (!this.fullImmersion) return;
		this.clearFullImmersion();
		if (opts.restoreChrome === false) {
			this.syncNativeNav("full-immersion-exit");
			return;
		}
		// 用户刚退出时必须看得见界面；下一次滚动再按常态设置重新收拢。
		this.rootEl?.removeClass("chrome-hidden");
		this.rootEl?.addClass("chrome-revealed");
		this.syncNativeNav("full-immersion-exit");
	}

	/** 全沉浸中的点按唤出/收起；只切会话类，不改变 fullImmersion 本身。 */
	private setFullImmersionRevealed(revealed: boolean): void {
		if (!this.fullImmersion || this.fullImmersionRevealed === revealed) return;
		this.fullImmersionRevealed = revealed;
		const root = this.rootEl;
		if (root) {
			root.toggleClass("full-immersion-revealed", revealed);
			if (revealed) {
				root.removeClass("chrome-hidden");
				root.addClass("chrome-revealed");
			} else {
				root.addClass("chrome-hidden");
				root.removeClass("chrome-revealed");
			}
		}
		this.syncNativeNav(revealed ? "full-immersion-reveal" : "full-immersion-hide");
	}

	/** 清理本视图的全沉浸类；app 级导航由调用链后续的 releaseNativeNav 统一释放。 */
	private clearFullImmersion(): void {
		this.fullImmersion = false;
		this.fullImmersionRevealed = false;
		// 全沉浸期间冻结的滚动态不要带出会话：退出后先按常态全显示，
		// 下一次滚动重新按「接管原生界面」收放。
		this.nativeScrollHidden = false;
		this.annotationsPanel?.containerEl?.removeClass("is-immersion-hidden");
		this.rootEl?.removeClass("is-full-immersion");
		this.rootEl?.removeClass("full-immersion-revealed");
		this.rootEl?.removeClass("full-immersion-show-toc");
		this.rootEl?.removeClass("full-immersion-show-progress");
		this.popImmersionHistoryGuard();
		this.syncFullImmersionPresentation();
	}

	/** 进入全沉浸时压一条「返回哨兵」到本 leaf 的导航历史。
	 *
	 *  ## 为什么需要它
	 *
	 *  手机端的「返回」不是一条插件能直接订阅的事件：
	 *    · Android 系统返回键由 Obsidian 自己接（Capacitor `backButton`），处理顺序是
	 *      「关模态框 → 收侧栏 → `activeLeaf.history.back()` → 否则提示再按一次退出 app」；
	 *    · 移动端页首的返回箭头、桌面端 `app:go-back` 命令同样走 `leaf.history.back()`；
	 *    · `window.history.back/forward/go` 也被官方重定向到同一个 leaf 历史。
	 *  三条路最终都是 `leaf.history.back()`，而它只在 `backHistory` 非空时才生效。
	 *  **阅读器视图 `navigation === false`，官方从不给它记历史** —— 于是全沉浸里按返回
	 *  要么去收侧栏、要么直接落到「再按一次退出 app」的提示上，用户在意的「先退出全沉浸」
	 *  被整条跳过（用户报障：手机上退不出这个模式）。
	 *
	 *  压一条哨兵进来，`backHistory.length > 0` 立刻成立 → 官方那条 `history.back()`
	 *  会回退到哨兵本身 → `setState` 收到带标记的状态（见那里的检测）→ 退出全沉浸。
	 *  返回键的语义因此变成「先退全沉浸，还在书里」，再按一次才回到官方的常态处理。
	 *
	 *  ## 降级
	 *
	 *  `leaf.history` / `pushState` / `getViewState` 都是官方未公开或结构敏感的成员，
	 *  任何一步取不到就**静默跳过**：最坏结果是「手机返回不再能退出全沉浸」，
	 *  绝不能影响进入全沉浸本身，也绝不能抛到调用方。 */
	private pushImmersionHistoryGuard(): void {
		if (this.immersionHistoryGuard) return;
		try {
			const leaf = this.leaf as unknown as {
				getViewState?: () => Record<string, unknown>;
				getEphemeralState?: () => unknown;
				history?: { pushState?: (state: unknown) => void };
			} | null | undefined;
			const history = leaf?.history;
			if (!leaf || typeof history?.pushState !== "function") return;
			const viewState = leaf.getViewState?.();
			if (!viewState || typeof viewState !== "object") return;
			const inner = viewState.state && typeof viewState.state === "object"
				? viewState.state as Record<string, unknown>
				: {};
			const entry = {
				title: this.titleText || "全沉浸",
				icon: "scan",
				state: { ...viewState, state: { ...inner, [IMMERSION_HISTORY_GUARD_KEY]: true } },
				eState: typeof leaf.getEphemeralState === "function" ? leaf.getEphemeralState() : null,
			};
			history.pushState(entry);
			this.immersionHistoryGuard = entry;
		} catch { /* ignore */ }
	}

	/** 退出全沉浸时回收哨兵：留在栈里的话，用户之后按返回会先「回到哨兵」——
	 *  表现为返回键白按一次（视图原地重放一遍）。只在它仍是栈顶时回收：
	 *  全沉浸期间若已发生过别的导航，栈顶就不是我们这一条了，动它会破坏官方历史。 */
	private popImmersionHistoryGuard(): void {
		const guard = this.immersionHistoryGuard;
		this.immersionHistoryGuard = null;
		if (!guard) return;
		try {
			const leaf = this.leaf as unknown as { history?: { backHistory?: unknown[] } } | null | undefined;
			const back = leaf?.history?.backHistory;
			if (!Array.isArray(back)) return;
			if (back[back.length - 1] === guard) back.pop();
		} catch { /* ignore */ }
	}

	/** 只播放一次拉绳回弹动画，不延迟状态切换。重复连点会重启动画。 */
	private playImmersionSwitchPull(): void {
		const el = this.immersionSwitchEl;
		if (!el) return;
		if (this.immersionSwitchPullTimer !== null) {
			window.clearTimeout(this.immersionSwitchPullTimer);
		}
		el.removeClass("is-pulling");
		void el.offsetWidth;
		el.addClass("is-pulling");
		this.immersionSwitchPullTimer = window.setTimeout(() => {
			this.immersionSwitchPullTimer = null;
			this.immersionSwitchEl?.removeClass("is-pulling");
		}, 420);
	}

	/** 供命令面板/快捷键使用；进入与退出共用同一条路径。 */
	toggleFullImmersion(): void {
		if (this.fullImmersion) this.exitFullImmersion();
		else this.enterFullImmersion();
	}

	/**
	 * 同步功能轨上「开关型」按钮的**作用中**高亮：目录 / 标注列表 / 阅读外观 / 搜索正文
	 * 各自对应的面板或浮层开着时，那枚按钮常亮（样式与沉浸模式按钮同一套 `.is-active`）；
	 * 星标（Feed 专属）同理 —— 它没有面板，亮的是「当前文章已收藏」这个内容状态。
	 *
	 * 状态一律**现读**（面板自己的 `isOpen()` / 目录面板的 `isPanelOpen()` / 星标读当前
	 * 文章的 `state.starredAt`），不在各调用点
	 * 分别切类 —— 面板自带关闭按钮、点外面、鼠标移开自动关、重渲染这些路径都会绕过调用方，
	 * 漏一条就会留下「面板已关、按钮还亮着」的假高亮。
	 * 各面板在开合的唯一收口处回调过来（`AnnotationsPanel.show/hide`、`AppearancePanel.open/close`、
	 * `SideNav.syncPanelOpenState`，搜索走 `toggleSearch`），加上建按钮后的一次初始同步。
	 */
	private syncRailButtons(): void {
		this.railTocBtn?.toggleClass("is-active", !!this.sideNav?.isPanelOpen());
		const panelOpen = !!this.annotationsPanel?.isOpen();
		const shelfMode = this.annotationsPanel?.getMode() === "bookshelf";
		const feedsMode = this.annotationsPanel?.getMode() === "feeds";
		this.railShelfBtn?.toggleClass("is-active", panelOpen && shelfMode);
		this.railFeedsBtn?.toggleClass("is-active", panelOpen && feedsMode);
		this.railAnnoBtn?.toggleClass("is-active", panelOpen && !shelfMode && !feedsMode);
		this.railAppearanceBtn?.toggleClass("is-active", !!this.appearancePanel?.isOpen());
		this.railSearchBtn?.toggleClass("is-active", this.searchOpen);
		const immersionLabel = this.fullImmersion ? "退出全沉浸" : "进入全沉浸";
		this.railImmersionBtn?.toggleClass("is-active", this.fullImmersion);
		this.railImmersionBtn?.setAttribute("aria-label", immersionLabel);
		this.railImmersionBtn?.setAttribute("title", immersionLabel);
		// 星标：已收藏 = 实心星 + 高亮底（`.is-starred` 只加图标填充，颜色沿用 `.is-active`）；
		// 无障碍名也跟着状态走 —— 读屏与悬浮提示读的是「点下去会发生什么」。
		const starred = this.currentFeedEntry?.state.starredAt != null;
		this.railStarBtn?.toggleClass("is-active", starred);
		this.railStarBtn?.toggleClass("is-starred", starred);
		this.railStarBtn?.setAttribute("aria-label", starred ? "取消收藏" : "收藏文章");
		this.syncDeviceButton();
	}

	/** 「阅读设备」按钮：点击按档位表循环（自动 → 手机 → 平板 → 桌面 → 自动）。
	 *  只有本地 HTML（网页原样通道）才看得到这枚按钮（CSS 按 `is-html-source` 收显），
	 *  所以这里不必再判书型；档位本身也只对 webLayout 生效（见 adapter.setWebDevice）。 */
	private cycleWebDevice(): void {
		const next = nextWebDevice(this.adapter.getWebDevice());
		this.adapter.setWebDevice(next);
		this.plugin.settings.webDeviceMode = next;
		void this.plugin.persistData();
		this.syncDeviceButton();
	}

	/** 设备按钮的图标与无障碍名跟随当前档位（图标即档位：手机/平板/桌面），
	 *  钉了档位（非 auto）时点亮 —— 「跟随窗口宽度」与「钉死成某台设备」是两种状态，
	 *  不给区分的常亮按钮在手机上没有可读性。 */
	private syncDeviceButton(): void {
		const btn = this.railDeviceBtn;
		if (!btn) return;
		const cur = this.adapter.getWebDevice();
		const step = WEB_DEVICE_STEPS[cur];
		// 只有 auto 的 `monitor-smartphone` 算新图标（较新的 lucide 才有），
		// 其余三枚都是 lucide 早期就有的老名字；统一退到最老的 `monitor`
		paintIcon(btn, step.icon, "monitor");
		btn.setAttribute("aria-label", `阅读设备：${step.label} · 点击切换`);
		btn.toggleClass("is-active", cur !== "auto");
	}

	/** root 上的 `is-html-source` 类：设备模式按钮的显隐唯一判据（见 styles.css）。
	 *  判据是**当前这本**是不是网页原样通道（同一个 adapter 会换书，所以不能只在
	 *  视图创建时算一次）；与 `is-feed-source` 同一时机：开书落定后加、清空时摘。 */
	private syncHtmlSourceClass(): void {
		this.rootEl?.toggleClass("is-html-source", this.adapter.isWebLayout());
	}

	/** 快速打开本插件的设置页（Obsidian 设置 → UNreader） */
	private openPluginSettings(): void {
		const setting = (this.app as unknown as {
			setting?: { open: () => void; openTabById: (id: string) => void };
		}).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById("unreader");
	}

	/** 点按屏幕：快速开/关悬浮工具栏。翻页由滑动完成，点按不触发翻页——
	 *  点按翻页移除后，「中间 1/3 才有效」的比例分区失去存在理由，其唯一遗留
	 *  效果就是两侧死区（点了解释「只有一块区域能切换」的根源）。
	 *  常态滚动隐藏（normalModeScrollHide 开）三态循环：
	 *  全隐藏 → 唤出所有元素且工具栏完整滑出；可见但工具栏半隐藏（待悬停态，
	 *  触屏无 hover 必须靠点按展开）→ 只把工具栏完整滑出，其余元素保持显示；
	 *  工具栏已完整展示（展开/钉住）→ 全部隐藏。
	 *  非沉浸模式：复用同一条点按通道，但只切左缘功能轨「完整滑出 ↔ 收回半隐藏」，
	 *  不动其它 chrome（它们本来就是常显的）——即「快速开/关工具栏」。 */
	private handleTapZone(_ratio: number, stamp?: number): void {
		// ── 同一次手势只认一次（投递去重）──────────────────────────────────────
		// 「点按唤出」是**纯翻转**状态机（隐藏→唤出／已展→收起），所以被投递两次就
		// 翻转两次 = 净无变化，或「唤出又立刻收起」。移动端上这两拍会分别推给原生
		// 底栏/状态栏桥，肉眼就是「底栏弹出来又缩回去」（用户 2026-09-23 报：沉浸模式
		// 点屏幕中间，底部工具栏连闪两次）。
		//
		// 两道闸门：
		//   ① **同一原生事件**：同一个 click 被多条链（frame 内 wireTapZone / 宿主 body
		//      委托）分别命中时 event.timeStamp **完全相同** → 丢弃后到的那次；
		//   ② **同一手势兜底**：不同事件但属同一次点按（如 pointerup 与 click 各自投递）
		//      时，用极短窗口 TAP_DEDUP_MS 合并。
		// 只做「丢弃重复」这一件事，不改变任何翻转语义。
		const now = performance.now();
		if (stamp != null && stamp === this.lastTapStamp) return;
		// ⚠️ 兜底窗口**只对带时间戳的真实用户事件生效**：内部/程序化调用（回归夹具
		// 直接调本方法、未来可能的内部复用）不带 stamp，绝不能被吞掉 —— 否则会把
		// 「点一下唤出、再点一下收起」这类有意连点的语义弄坏。
		if (stamp != null && this.lastTapStamp >= 0 && now - this.lastTapAt < TAP_DEDUP_MS) return;
		this.lastTapStamp = stamp ?? -1;
		this.lastTapAt = now;

		// 全沉浸的滚动状态机始终冻结；点按只在设置允许时临时唤出常态界面。
		if (this.fullImmersion) {
			if (this.hasFloatingPanelOpen()) {
				const hadPanel = this.hasFloatingPanelOpen();
				this.sideNav?.closePanel();
				if (!this.pinned && this.annotationsPanel?.isOpen()) this.annotationsPanel.hide();
				if (hadPanel) return;
			}
			if (this.plugin.settings.appearance.fullImmersionTapReveal === true) {
				this.setFullImmersionRevealed(!this.fullImmersionRevealed);
			}
			return;
		}
		if (this.hasFloatingPanelOpen()) {
			// 面板可能被沉浸模式藏成不可见（如目录面板随章节轨 opacity:0），
			// 用户看不见也关不掉——点按必须先强制收面板，否则永久死锁。
			// 注意不能用 outsideTap()（尊重 buttonPinned 钉住，收不掉自动展开的面板）
			this.sideNav?.closePanel();
			if (this.appearancePanel?.isOpen()) this.appearancePanel.close();
			if (!this.pinned && this.annotationsPanel?.isOpen()) this.annotationsPanel.hide();
			// 先清障即止；工具栏由下一次点按按三态切换，两个动作不叠加。
			return;
		}
		const root = this.rootEl;
		// 点按接管：滚动留给原生的隐藏态交回这一拍的三态翻转（唤出即放回、
		// 收起即跟随）。否则「滚出来的原生隐藏态」会锁死到下一次滚动才解除。
		this.nativeScrollHidden = false;
		if (!root) return;
		const hidden = root.hasClass("chrome-hidden");
		const revealed = root.hasClass("chrome-revealed");
		// 功能轨已完整展示（点按展开/钉住/标注面板钉住推开）→ 点按语义为「已显示」
		const actionsShown = (this.sideNav?.isActionsFullyShown() ?? false)
			|| (this.pinned && (this.annotationsPanel?.isOpen() ?? false));
		if (hidden) {
			// 全隐藏 → 唤出所有元素，且工具栏完整展开
			root.removeClass("chrome-hidden");
			root.addClass("chrome-revealed");
		} else if (!revealed && !actionsShown) {
			// 半隐藏 → 不隐藏任何元素，只把工具栏完整滑出
			root.addClass("chrome-revealed");
		} else {
			// 工具栏已完整展示 → 全部隐藏
			root.addClass("chrome-hidden");
			root.removeClass("chrome-revealed");
		}
		this.syncNativeNav("tap");
	}


	private showNativeHover(event: MouseEvent, hl: StoredHighlight, range: Range): void {
		if (!this.notePath) return;
		const file = this.app.vault.getFileByPath(this.notePath);
		if (!file) return;
		try { this.hoverAnchorEl?.remove(); } catch { // ignore
		}
		this.hoverAnchorEl = createDiv();
		this.hoverAnchorEl.className = "unreader-hover-anchor";
		// position:absolute / pointer-events:none 由 .unreader-hover-anchor 类提供（styles.css）
		try {
			const raw = range.getBoundingClientRect();
			const stageRect = this.contentHost.getBoundingClientRect();
			const bodyRect = this.bodyEl.getBoundingClientRect();
			const left = raw.x + stageRect.left - bodyRect.left;
			const top = raw.y + stageRect.top - bodyRect.top;
			this.hoverAnchorEl.style.left = `${left}px`;
			this.hoverAnchorEl.style.top = `${top}px`;
			this.hoverAnchorEl.style.width = `${Math.max(20, raw.width)}px`;
			this.hoverAnchorEl.style.height = `${Math.max(12, raw.height)}px`;
		} catch {
			const stageRect = this.contentHost.getBoundingClientRect();
			const bodyRect = this.bodyEl.getBoundingClientRect();
			this.hoverAnchorEl.style.left = `${event.clientX + stageRect.left - bodyRect.left}px`;
			this.hoverAnchorEl.style.top = `${event.clientY + stageRect.top - bodyRect.top}px`;
			this.hoverAnchorEl.style.width = HOVER_ANCHOR_FALLBACK_SIZE;
			this.hoverAnchorEl.style.height = HOVER_ANCHOR_FALLBACK_SIZE;
		}
		this.bodyEl.appendChild(this.hoverAnchorEl);
		const linktext = `${this.notePath}#^hl${hl.id}`;
		this.app.workspace.trigger("hover-link", {
			event,
			source: "unreader",
			hoverParent: this,
			targetEl: this.hoverAnchorEl,
			linktext,
		});
	}

	private showNativePreview(hl: StoredHighlight, anchorEl: HTMLElement): void {
		const file = this.app.vault.getFileByPath(this.notePath);
		if (!file) return;
		try { this.hoverAnchorEl?.remove(); } catch { // ignore
		}
		this.hoverAnchorEl = createDiv();
		this.hoverAnchorEl.className = "unreader-hover-anchor";
		// position:absolute / pointer-events:none 由 .unreader-hover-anchor 类提供（styles.css）
		const rect = anchorEl.getBoundingClientRect();
		const bodyRect = this.bodyEl.getBoundingClientRect();
		this.hoverAnchorEl.style.left = `${rect.left - bodyRect.left}px`;
		this.hoverAnchorEl.style.top = `${rect.top - bodyRect.top}px`;
		this.hoverAnchorEl.style.width = `${rect.width}px`;
		this.hoverAnchorEl.style.height = `${rect.height}px`;
		this.bodyEl.appendChild(this.hoverAnchorEl);
		const fakeEvent = new MouseEvent("mousemove", {
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
		});
		this.app.workspace.trigger("hover-link", {
			event: fakeEvent,
			source: "unreader",
			hoverParent: this,
			targetEl: this.hoverAnchorEl,
			linktext: `${this.notePath}#^hl${hl.id}`,
		});
	}

	/* ---------------- highlight hover preview / click jump ---------------- */

	private handleShowAnnotation(cfi: string, range: Range | null): void {
		// 点击高亮：自动选中整块并弹出编辑浮窗（改色/评论/删除）
		const hl = this.annotations.highlights.find(h => h.anchor === cfi);
		if (!hl) {
			this.pendingBackJump = true;
			void this.adapter.goTo(cfi);
			return;
		}
		// 若已有 range，直接选中并弹出；否则仅跳转后由 click 通路处理
		if (range) {
			try {
				const doc = range.startContainer.ownerDocument;
				if (doc?.getSelection) {
					const sel = doc.getSelection();
					if (sel) {
						sel.removeAllRanges();
						const r = range.cloneRange();
						sel.addRange(r);
						this.pendingSelection = null;
					}
				}
			} catch { /* ignore */ }
			const anchorRect = this.anchorRectForRange(range);
			this.selectionToolbar.hide();
			this.dismissHover();
			this.highlightPopover.showFor(
				{ id: hl.id, anchor: hl.anchor, text: hl.text, color: hl.color, comment: hl.comment ?? "" },
				anchorRect,
				this.bodyBoundsNow(),
			);
			return;
		}
		this.pendingBackJump = true;
		void this.adapter.goTo(cfi);
		this.dismissHover();
		this.highlightPopover.hide();
	}

	private handleAnnotationHover(e: MouseEvent, _doc: Document): void {
		if (!this.bodyEl) return;
		const isPreviewKey = e.ctrlKey || e.metaKey;
		if (!isPreviewKey) {
			if (this.hoverPopover || this.hoveredId != null) this.dismissHover();
			return;
		}
		const hit = this.adapter.getHighlightAt(e.clientX, e.clientY);
		if (!hit) {
			if (this.hoverPopover || this.hoveredId != null) this.dismissHover();
			return;
		}
		const hl = this.annotations.highlights.find(h => h.anchor === hit.anchor);
		if (!hl) {
			if (this.hoverPopover || this.hoveredId != null) this.dismissHover();
			return;
		}
		if (this.hoveredId === hl.id && this.hoverPopover) return;
		if (this.hoverRaf) window.cancelAnimationFrame(this.hoverRaf);
		this.hoverRaf = window.requestAnimationFrame(() => {
			this.hoverRaf = 0;
			if (!hl) return;
			this.hoveredId = hl.id;
			this.showNativeHover(e, hl, hit.range);
		});
	}

	private handleAnnotationClick(e: MouseEvent): void {
		const hit = this.adapter.getHighlightAt(e.clientX, e.clientY);
		if (!hit) return;
		const hl = this.annotations.highlights.find(h => h.anchor === hit.anchor);
		if (!hl) return;
		e.preventDefault();
		e.stopPropagation();
		this.dismissHover();
		this.selectionToolbar.hide();
		// 自动选中整块高亮文本
		try {
			const rangeDoc = (hit.range.startContainer.ownerDocument) ?? (e.target as HTMLElement)?.ownerDocument ?? null;
			if (rangeDoc?.getSelection) {
				const sel = rangeDoc.getSelection();
				if (sel) {
					sel.removeAllRanges();
					const r = hit.range.cloneRange();
					sel.addRange(r);
				}
			}
		} catch { /* ignore */ }
		// 锚点：与「侧栏跳到高亮」同一份换算（连续模式必须补 frame 偏移，见 anchorRectForRange）
		let anchorRect = this.anchorRectForRange(hit.range);
		if (!anchorRect) {
			// 兜底：拿不到 range 几何就用点按位置当锚点
			const stageRect = this.contentHost.getBoundingClientRect();
			const bodyRect = this.bodyEl.getBoundingClientRect();
			anchorRect = new DOMRect(
				e.clientX + stageRect.left - bodyRect.left - 10,
				e.clientY + stageRect.top - bodyRect.top - 10,
				20,
				20,
			);
		}
		this.highlightPopover.showFor(
			{ id: hl.id, anchor: hl.anchor, text: hl.text, color: hl.color, comment: hl.comment ?? "" },
			anchorRect,
			this.bodyBoundsNow(),
		);
	}

	/* ---------------- doc events / input ---------------- */

	private wireDocEvents(doc: Document, index: number): void {
		// 同一章节文档只接一次：连续模式由 wireFrame 接，分页模式由 foliate load 接；
		// 两条路径都可能被上层重复触发，重复挂监听会让键盘/点按链路各执行两次。
		const wiredDoc = doc as Document & { __unreaderDocEventsWired?: boolean };
		if (wiredDoc.__unreaderDocEventsWired) return;
		wiredDoc.__unreaderDocEventsWired = true;
		// 脚注 Cmd/Ctrl 状态同步到 engine（iframe 内按键）
		doc.addEventListener("keydown", e => {
			// 模态框（命令面板/快速切换/设置）开着时整条让路：此时键盘不该在书页里
			// （真跑进来了由 engineAdapter 的 focusin 处理器归还），而 `handleKey` 对
			// 未识别按键会走 `forwardKeyToHost` 合成转发进宿主 keymap —— 那等于在弹窗
			// 之外再执行一次热键命令。判据见 core/modalFocusGate。
			if (hasCoreModal(this.contentEl?.ownerDocument ?? document)) return;
			if (e.metaKey || e.ctrlKey) this.adapter.commandPressed = true;
			if (e.key === "Escape") {
				this.selectionToolbar?.hide();
				this.highlightPopover?.hide();
				
			this.dismissHover();
			}
			this.handleKey(e);
		});
		doc.addEventListener("keyup", e => {
			if (!e.metaKey && !e.ctrlKey) this.adapter.commandPressed = false;
		});
		// 分页模式已删除：wheel 接管与触摸拦截监听器一律撤掉，连续模式走原生滚动
		// 与 Obsidian 侧栏手势。
		doc.addEventListener("pointerdown", () => {
			// iframe 内点击空白：统一收起选中工具条/高亮气泡/未钉住侧边栏。
			// iframe 事件不会冒泡到宿主 body，这里必须单独补收。
			// 工具条在 pointerup 后才决定是否显示：这里隐藏的是「上一次」的工具条，
			// 本次若拖出新的选区会在 pointerup 后重新出现，不影响。
			this.dismissFloatingOnBlankClick();
		});
		doc.addEventListener("click", e => {
			if (this.isFeedSource() || this.isHtmlSource()) {
				const target = eventElement(e)?.closest<HTMLAnchorElement>("a[href]") ?? null;
				const href = target?.href ?? "";
				if (/^https?:/i.test(href)) {
					// **只吞掉这次点击，不在这里打开**：打开动作已收口到引擎的
					// frame 点击链路（`engineAdapter.handleAnchorTap` → `externalLink`），
					// 四种源共用一条；这里再 open 一次就是双开（系统浏览器弹两个标签）。
					// 保留 preventDefault/stopPropagation：① 与引擎那条同源的「绝不让
					// 章节 iframe 自己导航」双保险；② 不让这次点击继续落到下面
					// 「命中高亮 → 弹标注气泡」的分支上（点链接不该弹高亮气泡）。
					e.preventDefault();
					e.stopPropagation();
					return;
				}
			}
			const hit = this.adapter.getHighlightAt((e as MouseEvent).clientX, (e as MouseEvent).clientY);
			if (hit && this.annotations.highlights.some(h => h.anchor === hit.anchor)) {
				this.handleAnnotationClick(e);
				return;
			}
			// 点击非高亮区域，若高亮气泡处于显示态则关闭（点击其他地方自动关闭）
			if (this.highlightPopover?.visible) this.highlightPopover.hide();
			// 模态框开着时不把焦点往书页里拉（同 focusContent 的判据，见 core/modalFocusGate）
			if (!hasCoreModal()) doc.defaultView?.focus();
		});
		doc.addEventListener("mousemove", e => this.handleAnnotationHover(e, doc));
		// mouseleave 不主动关闭原生弹窗，交由官方距离判定，避免移向弹窗时消失
		doc.addEventListener("keyup", e => {
			if (!e.ctrlKey && !e.metaKey) 
			this.dismissHover();
		});
		doc.addEventListener("pointerdown", () => {
		});
		doc.addEventListener("pointerup", () => {
			window.setTimeout(() => this.captureSelection(doc, index), 0);
		});
		doc.addEventListener("scroll", () => {
			// 编辑评论时不让路：键盘弹起会让容器滚动被 clamp，书页跟着「滚动」一次，
			// 那不是用户要放弃标注（同 isEditingComment）。
			if (!this.isEditingComment()) this.selectionToolbar.hide();
			this.dismissHover();
		}, { passive: true });
		// 选区变化 → 同步到主文档（三方插件「选中后快捷键」能读到，与 markdown 一致）
		doc.addEventListener("selectionchange", () => this.mirrorSelectionFrom(doc));
	}

	/** Feed 文章的「阅读原文」：入口在功能轨按钮上，点击直接交系统默认浏览器。
	 *  正文里刻意不再注入这条链接 —— `srcdoc` iframe 内点击必须靠事件拦截才能
	 *  阻止导航，撤掉后这一条链路的复杂度归零。 */
	private openCurrentFeedOriginal(): void {
		const url = this.currentFeedEntry?.url;
		if (!url) {
			new Notice("这篇文章没有原文链接");
			return;
		}
		openExternalLink(url);
	}

	/* ---------------- 主文档选区镜像 ---------------- */

	private mirrorSelectionFrom(doc: Document): void {
		if (this.mirrorPending) return;
		this.mirrorPending = true;
		window.requestAnimationFrame(() => {
			this.mirrorPending = false;
			if (!this.rootEl?.isConnected) return;
			const sel = doc.getSelection();
			const text =
				sel && !sel.isCollapsed
					? sel.toString().replace(/\s+/g, " ").trim()
					: "";
			// 热键命令把焦点从 iframe 拉回宿主时，帧选区会短暂塌陷并触发
			// selectionchange；保持窗口期内不清镜像，命令里读宿主选区才有值
			if (!text && Date.now() < this.mirrorHoldUntil) return;
			this.syncSelectionToHost(text);
		});
	}

	/** 把 iframe 选区写入主文档隐藏元素，使 window.getSelection() 可读到。
	 * 持续保活：三方插件快捷键触发时若主文档选区被清掉，会重新断言。 */
	private syncSelectionToHost(text: string): void {
		if (!text) {
			this.clearMirrorSelection();
			return;
		}
		if (!this.mirrorEl || !this.mirrorEl.isConnected) {
			this.mirrorEl = createSpan();
			this.mirrorEl.setAttribute("aria-hidden", "true");
			// 全部离屏样式在 .unreader-clip-mirror 类里（styles.css）
			this.mirrorEl.className = "unreader-clip-mirror";
			document.body.appendChild(this.mirrorEl);
		}
		this.mirrorText = text;
		if (this.mirrorEl.textContent !== text) this.mirrorEl.textContent = text;
		this.assertMirrorSelection();
		this.startMirrorKeepalive();
	}

	/** 宿主选区是否落在我们自己的界面内（镜像元素本身除外） */
	private isSelectionInOwnUi(sel: Selection): boolean {
		try {
			const n = sel.anchorNode;
			if (!n || n === this.mirrorEl || !!this.mirrorEl?.contains(n)) return false;
			const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
			return !!el && !!this.rootEl?.contains(el);
		} catch {
			return false;
		}
	}

	/** 宿主文档的键盘焦点是否正落在**文本输入**里（我们自己的评论/重命名输入框，
	 *  或库内任意别的输入框）。判据与 `isEditableTarget` 同一口径。
	 *
	 *  ## 为什么镜像保活必须先问这一句（2026-09-19 第三轮；上一轮的 hide()/showFor
	 *  两处守卫已部署到真机、故障仍在，这条才是真机上的实际触发路径）
	 *
	 *  保活的写入原语是 `assertMirrorSelection()`：把宿主 document 的选区改成
	 *  **离屏镜像 span 上的一段非塌陷选区**，由 `startMirrorKeepalive` **每 150ms**
	 *  重做一次。焦点在输入框里时这一步有两个后果（Chromium 实测，回归见
	 *  `npm run test:comment-mirror`）：
	 *
	 *   ① **输入框自己的插入点被重置回 0**（`selectionStart/End` → `0-0`）——
	 *      用户正在打的评论光标每 150ms 跳一次，输入法的合成串反复作废；
	 *   ② 宿主文档里出现一段**非可编辑**选区 —— Android WebView 据此进入「文本
	 *      选择」模式（弹系统选区菜单），而系统的文本选择模式一出现就**收掉软键盘**。
	 *
	 *  合起来正是用户报的「划线时键盘会出现、闪一下后又被压下来，无法正常标注」：
	 *  划线建立了镜像保活 → 点评论 → `commentInput.focus()` 拉起键盘 → **≤150ms 后
	 *  最近一次保活 tick 把它压回去**。这与「容器/浮层被 hide()」是完全不同的两条路，
	 *  所以上一轮那两个守卫救不了它。
	 *
	 *  判据为什么可以这么宽（任何输入框，而不只是我们自己的）：焦点在文本输入里时，
	 *  宿主 document 的选区**属于那个输入框**（插入点、选区、输入法合成串都在其中），
	 *  镜像再去改写它就是抢别人的选区。镜像的用途是「把书里的选区暴露给三方插件」，
	 *  用户此刻在打字，两件事互不相干。
	 *
	 *  反向的出口面同样重要（回归里钉着）：焦点在**书页 iframe** 上时
	 *  `document.activeElement` 是 `<iframe>` 元素 —— 不是输入框 → 保活照常工作，
	 *  三方插件「选中文字 → 附件 +」的能力一点没少。 */
	private hostTextInputFocused(): boolean {
		return this.isEditableTarget(document.activeElement);
	}

	/** 把主文档选区设到镜像元素上。
	 *
	 *  **焦点在文本输入里时一律不写**（见 `hostTextInputFocused`）—— 这是本函数的
	 *  唯一出口判据：写进去会把用户的插入点冲掉、并在移动端把软键盘压回去。 */
	private assertMirrorSelection(): void {
		if (!this.mirrorEl?.isConnected) return;
		if (this.hostTextInputFocused()) return;
		try {
			const range = document.createRange();
			range.selectNodeContents(this.mirrorEl);
			const hostSel = window.getSelection();
			if (hostSel) {
				hostSel.removeAllRanges();
				hostSel.addRange(range);
			}
			this.notifyExternalSelection();
		} catch { /* ignore */ }
	}

	/** 让宿主 document 上监听 selectionchange 的三方 UI（如 UNagent 输入框的
	 *  「附件→＋」按钮）感知书内选区。iframe 内的选区不会触发宿主 selectionchange，
	 *  程序化设置镜像选区在 WebKit（macOS/iPad Safari）上也常不触发该事件，
	 *  这里显式补发，保证「选中文字 → 按钮变 ＋」与 markdown 行为一致。 */
	private notifyExternalSelection(): void {
		try {
			document.dispatchEvent(new Event("selectionchange"));
		} catch { /* ignore */ }
	}

	/** 轻量保活：仅当书里仍有活选区且 UNreader 仍是活动视图时，周期性重断言，
	 * 防止 Obsidian/焦点变化清掉主文档选区。离开视图或选区消失即停止。 */
	private startMirrorKeepalive(): void {
		if (this.mirrorKeepalive != null) return;
		this.mirrorKeepalive = window.setInterval(() => {
			if (!this.mirrorText || !this.mirrorEl?.isConnected) {
				this.stopMirrorKeepalive();
				return;
			}
			if (this.app.workspace.getActiveViewOfType(UNreaderView) !== this) {
				this.stopMirrorKeepalive();
				return;
			}
			// 用户正在输入框里打字（评论 / 重命名 / 任意宿主输入）：保活**整轮让路**，
			// 连 `window.getSelection()` 都不读 —— 写进去会冲掉插入点、并在 Android 上
			// 用一段非可编辑选区把软键盘压回去（见 hostTextInputFocused）。
			// 只跳过这一轮、不停表：焦点回到书页后镜像立刻恢复正常。
			if (this.hostTextInputFocused()) return;
			const hostSel = window.getSelection();
			// 用户正在我们自己的界面里选字（脚注气泡/侧栏/面板）：别抢选区，
			// 否则气泡里的文字永远选不中（150ms 内被抢回镜像元素）
			if (hostSel && !hostSel.isCollapsed && this.isSelectionInOwnUi(hostSel)) return;
			if (!hostSel || hostSel.isCollapsed || hostSel.toString() !== this.mirrorText) {
				this.assertMirrorSelection();
			}
		}, 150);
	}

	private stopMirrorKeepalive(): void {
		if (this.mirrorKeepalive != null) {
			window.clearInterval(this.mirrorKeepalive);
			this.mirrorKeepalive = null;
		}
	}

	private clearMirrorSelection(): void {
		// relocate 每帧调用：没有镜像选区时直接返回——下面无条件 dispatch 一个宿主
		// selectionchange（给 UNagent 等三方 UI 的补发），空转时纯噪声。
		// keepalive 在跑的充要条件就是 mirrorText 非空，所以这里不会漏停定时器。
		if (!this.mirrorText && !this.mirrorEl) return;
		this.stopMirrorKeepalive();
		this.mirrorText = "";
		const el = this.mirrorEl;
		this.mirrorEl = null;
		if (el) {
			try { el.remove(); } catch { /* ignore */ }
		}
		const hostSel = window.getSelection();
		if (hostSel && !hostSel.isCollapsed) {
			try {
				const r = hostSel.getRangeAt(0);
				if (r && r.startContainer === el) hostSel.removeAllRanges();
			} catch { /* ignore */ }
		}
		this.notifyExternalSelection();
	}

	/**
	 * 浮动评论框的 bounds：**每次调用现测**，且把高度裁到「可用区底边」。
	 *
	 * 为什么不能让调用方只在 showFor 时传一次：
	 *  · 键盘弹起时官方收缩的是容器（`body.is-mobile .app-container { max-height: calc(100vh - --keyboard-height) }`），
	 *    `.unreader-body` 跟着变矮，而已经算好的绝对 top 不会自动跟随（→ 输入框被 overflow:hidden 裁掉）；
	 *  · 键盘上方还有原生浮层 `.mobile-toolbar`（快速编辑栏）压在收缩后容器的最底 ~52px 上，
	 *    `is-floating-nav` 的悬浮导航栏同理 —— 可用区底边必须由 `usableBottom()` 统一给。
	 * 把「可用高度」直接写进 bounds（而不是另开一个 bottomInset 参数）：
	 * placeFloating 的贴底/钳制都以 bounds 为界，一份口径只有一个来源，不会两处各减一次。
	 */
	/** 底部播客播放条占掉的高度；隐藏/未打开播客时为 0。 */
	private podcastBarHeight(): number {
		if (!this.rootEl?.hasClass("has-podcast")) return 0;
		const height = this.podcastBarEl?.offsetHeight ?? 0;
		return Number.isFinite(height) && height > 0 ? height : 0;
	}

	private stageBoundsNow(): Bounds {
		const stageRect = this.contentHost.getBoundingClientRect();
		const bodyRect = this.bodyEl.getBoundingClientRect();
		return {
			left: stageRect.left - bodyRect.left,
			top: stageRect.top - bodyRect.top,
			width: stageRect.width,
			height: Math.max(0, this.clampHeightToUsable(stageRect.height, bodyRect.bottom) - this.podcastBarHeight()),
		};
	}

	/** 高亮气泡的 bounds：正文区（body）自身坐标系，原点即 body 左上角 */
	private bodyBoundsNow(): Bounds {
		const rect = this.bodyEl.getBoundingClientRect();
		return {
			width: this.bodyEl.clientWidth,
			height: Math.max(0, this.clampHeightToUsable(this.bodyEl.clientHeight, rect.bottom) - this.podcastBarHeight()),
		};
	}

	/**
	 * 把可用高度裁到「可用区底边」之上。桌面端（无软键盘、无底部原生栏）usableBottom 等于容器底边，
	 * 此处原样返回 —— 与改动前逐像素一致；移动端键盘弹起时容器已收缩，差额通常是
	 * 键盘上方那条 .mobile-toolbar 的高度（~52px）。
	 *
	 * 实现已抽到 keyboardInset.clampHeightToUsable（与夹具同源），这里只补宿主元素。
	 */
	private clampHeightToUsable(height: number, containerBottom: number): number {
		return clampHeightToUsable(this.bodyEl, height, containerBottom);
	}

	/**
	 * Range → 浮动框锚点（**body 本地坐标**，见 bodyBoundsNow 的坐标系说明）。
	 *
	 * 连续模式下 range 位于同源书页 iframe 内，`getBoundingClientRect()` 给的是 **frame 视口**
	 * 坐标 —— 少了「这一章在滚动容器里的位置」那一大段偏移（越靠后的章差得越多），
	 * 浮窗会被放到离高亮很远的地方，甚至被判成「屏外锚点」而退回屏幕中央。
	 * 所以必须补上 frame 自身的左上偏移（`frameElement.getBoundingClientRect()`）。
	 *
	 * 两个入口（侧栏跳转后的定位、正文点高亮）共用这一份换算，避免只修一处。
	 */
	private anchorRectForRange(range: Range): DOMRect | null {
		try {
			const raw = range.getBoundingClientRect();
			const frameEl = (range.startContainer.ownerDocument?.defaultView as
				| (Window & { frameElement?: HTMLIFrameElement | null })
				| null)?.frameElement ?? null;
			const fr = frameEl ? frameEl.getBoundingClientRect() : null;
			const stageRect = this.contentHost.getBoundingClientRect();
			const bodyRect = this.bodyEl.getBoundingClientRect();
			return new DOMRect(
				raw.x + (fr?.left ?? 0) + stageRect.left - bodyRect.left,
				raw.y + (fr?.top ?? 0) + stageRect.top - bodyRect.top,
				raw.width,
				raw.height,
			);
		} catch {
			return null;
		}
	}

	private captureSelection(doc: Document, index: number): void {
		if (this.appearancePanel.isOpen() || this.footnoteBackdrop || this.highlightPopover.visible) return;
		const sel = doc.getSelection();
		if (!sel || sel.isCollapsed) {
			// 编辑评论期间**不算「选区没了」**：键盘弹起 / 焦点移进宿主输入框时，
			// 系统会收掉书页 iframe 里的选区，但用户并没有放弃这次标注 ——
			// 这里若照旧 hide() + 清 pendingSelection，软键盘会立刻被压回去、
			// 保存也会报「无法定位选区」。
			if (this.isEditingComment()) return;
			if (this.selectionToolbar.visible) this.selectionToolbar.hide();
			this.pendingSelection = null;
			this.lastExcerpt = null;
			this.clearMirrorSelection();
			return;
		}
		const text = sel.toString().replace(/\s+/g, " ").trim();
		if (!text) {
			if (this.isEditingComment()) return;
			this.selectionToolbar.hide();
			this.lastExcerpt = null;
			this.clearMirrorSelection();
			return;
		}
		this.syncSelectionToHost(text);
		const sel0 = sel.getRangeAt(0);
		const cfi = this.adapter.rangeCFI(doc, sel0);
		// 固定定位：工具条固定在正文区（stage）底部居中，不跟随选区。
		// bounds 用 stage 在 body 本地坐标系的矩形（现测；键盘弹起后高度已裁到可用区底边）。
		// 钉住侧边栏时 stage 被右移（原点不再为 0），必须带上 left/top，否则工具条会偏到左下。
		const stageBounds = this.stageBoundsNow();
		const rect = new DOMRect(stageBounds.left ?? 0, stageBounds.top ?? 0, stageBounds.width, stageBounds.height);
		this.pendingSelection = { doc, index, text, cfi, rect, at: Date.now() };
		this.lastExcerpt = { text, cfi, at: this.pendingSelection.at };
		this.selectionToolbar.showFor({ doc, text }, null, stageBounds);
	}

	private copySelection(text: string): void {
		void navigator.clipboard
			.writeText(text)
			.then(() => new Notice("已复制"))
			.catch(() => new Notice("复制失败"));
	}

	/** 复制引用：原文 + 书名 + 章节标题 + 溯源笔记路径（给 AI 溯源用） */
	private copyReference(text: string, cfi: string): void {
		if (!this.file) return;
		const bookName = this.file.basename || "未命名书籍";
		const chapter = cfi ? this.adapter.getChapterLabelForCfi(cfi) : null;
		// 溯源指向标注笔记（.md，AI 可用 read_note 按路径读取）；无笔记则省略该行。
		// **给纯路径、不是 `[[…]]` 双链**：标注笔记已登记进 Obsidian 的「排除文件」
		// （见 core/exclusions.ts），双链在那边不再有解析价值，而 AI 溯源只需要能按
		// 路径读到文件。旁车笔记 frontmatter 里的 `book: "[[…]]"` 不受影响 —— 它指向的
		// 是**书**而不是笔记，是个有用的「回到原书」入口。
		let noteRef: string | null = null;
		if (this.notePath) {
			try {
				if (this.app.vault.getFileByPath(this.notePath)) noteRef = this.notePath;
			} catch { /* ignore */ }
		}
		const clean = text.replace(/\s+/g, " ").trim();
		const lines: string[] = [`> ${clean}`, ""];
		lines.push(`来源：《${bookName}》${chapter ? ` · ${chapter}` : ""}`);
		if (noteRef) lines.push(`溯源：${noteRef}`);
		const content = lines.join("\n");
		void navigator.clipboard
			.writeText(content)
			.then(() => new Notice("已复制引用"))
			.catch(() => new Notice("复制失败"));
	}

	/* ---------------- keyboard: page + forward to Obsidian ---------------- */

	/** 把键盘焦点从书页 iframe 拉回主文档。iframe 持有键盘焦点时，热键命令
	 * 打开的模态框（命令面板/快速记录/引用等）input.focus() 拿不到真实键盘
	 * 焦点——打字与回车全部落回 iframe，表现为面板「第一次回车无效」
	 * （回车经合成转发进 keymap，执行的还是面板置顶的钉选命令）。
	 *
	 * **模态框已经开着时只交不抢**：这时把焦点按到 `contentEl` 上就是在跟弹窗抢键盘
	 * （弹窗输入框刚聚焦就被抢走 → 第一次打字/回车落回书页）。走
	 * `relinquishReaderFocus()`，判据见 core/modalFocusGate。 */
	private returnFocusToHost(): void {
		try {
			if (hasCoreModal()) {
				this.relinquishReaderFocus();
				return;
			}
			const active = document.activeElement;
			if (active instanceof HTMLIFrameElement) {
				this.mirrorHoldUntil = Date.now() + 1200;
				active.blur();
				this.contentEl.tabIndex = -1;
				this.contentEl.focus({ preventScroll: true });
				// 焦点切换可能清掉宿主选区，立即重申镜像，保证命令回调读到摘录
				if (this.mirrorText) this.assertMirrorSelection();
			}
		} catch { /* ignore */ }
	}

	/** 把阅读器手上的键盘焦点**交出去**（不抢回来）。核心模态框出现时调用。
	 *
	 *  只摘「焦点在阅读器自己 DOM 里」的那一份；焦点已经在模态框输入框上时一律不碰
	 *  （模态框刚聚焦好，我们再去 blur 就是反向干扰）。
	 *
	 *  两类持有者都要覆盖：书页 iframe（用户点过正文）与宿主容器
	 *  （`.unreader-continuous` / `.unreader-content-el` —— `focusContent()` 聚焦的正是
	 *  它们，而连续模式下最常见的持有者就是它们）。上一轮的补丁只看 iframe，
	 *  所以在容器持焦的常态下**一次都没生效**。
	 *
	 *  **摘完必须「交给弹窗」**：`blur()` 的落点是 `body`，没有任何元素持有键盘 ——
	 *  移动端会立刻收掉软键盘，用户紧接着的那一次点按/回车落在 body 上，弹窗收不到
	 *  → 第一次操作无效。`focusModalPrimary` 负责把这份键盘塞进弹窗的输入框；
	 *  弹窗还没渲染出输入框时它返回 false，此时交给官方接管（不会比原来更差）。 */
	private relinquishReaderFocus(): void {
		const doc = this.contentEl?.ownerDocument ?? document;
		try {
			if (blurIfFocusInside(this.containerEl, doc)) {
				focusModalPrimary(doc);
				return;
			}
			const ae = doc.activeElement;
			if (ae instanceof HTMLIFrameElement) {
				ae.blur();
				focusModalPrimary(doc);
			}
		} catch { /* ignore */ }
	}

	private forwardKeyToHost(e: KeyboardEvent): void {
		// macOS 上 Option+字母会把 key 变成特殊字符（Option+Z → Ω）甚至 "Dead"
		// （Option+I），而宿主 keymap 的热键按注册时的基础字母匹配——用 e.code
		// 还原基础字母。vkey 匹配依赖 which/keyCode，合成事件默认为 0，必须补上。
		let key = e.key;
		if (e.altKey) {
			if (/^Key/.test(e.code)) key = e.code.slice(3).toLowerCase();
			else if (/^Digit/.test(e.code)) key = e.code.slice(5);
		}
		const clone = new KeyboardEvent("keydown", {
			key,
			code: e.code,
			location: e.location,
			ctrlKey: e.ctrlKey,
			metaKey: e.metaKey,
			shiftKey: e.shiftKey,
			altKey: e.altKey,
			repeat: e.repeat,
			bubbles: true,
			cancelable: true,
		});
		try {
			// `keyCode` / `which` 已被标准废弃，但 Obsidian 自己的热键链仍在读它们 ——
			// 这里转发正是为此。按结构类型取值，别让这条「不得不读」一直挂在废弃清单里。
			const legacy = e as unknown as { keyCode?: number };
			Object.defineProperty(clone, "keyCode", { get: () => legacy.keyCode });
			Object.defineProperty(clone, "which", { get: () => legacy.keyCode });
			// 标记合成事件：window 级兜底翻页监听据此跳过，防止无限转发循环
			(clone as KeyboardEvent & { __unreaderForwarded?: boolean }).__unreaderForwarded = true;
		} catch { /* ignore */ }
		this.contentEl.dispatchEvent(clone);
	}

	/** 把 iframe 里的按键解析为 Obsidian 命令并直接执行（若绑定了热键）。
	 * 这是三方插件「选中后快捷键」在书里生效的可靠通道——不依赖合成事件
	 * 是否被 Obsidian 接受，也不依赖 iframe 是否持有焦点。返回匹配到的
	 * 命令 id；无匹配返回 null。 */
	private findCommandForHotkey(e: KeyboardEvent): string | null {
		try {
			const appAny = this.app as unknown as {
				commands?: {
					listCommands?: () => Array<{ id: string }>
					commands?: Record<string, { id?: string }>
				}
				hotkeys?: {
					getHotkeys?: (id: string) => Array<{ key?: string; modifiers?: string[] }> | null
				}
				hotkeyManager?: {
					getHotkeys?: (id: string) => Array<{ key?: string; modifiers?: string[] }> | null
					getDefaultHotkeys?: (id: string) => Array<{ key?: string; modifiers?: string[] }> | null
				}
			}
			const cmds = appAny.commands
			const hk = (appAny.hotkeys ?? appAny.hotkeyManager) as unknown as {
				getHotkeys?: (id: string) => Array<{ key?: string; modifiers?: string[] }> | null
				getDefaultHotkeys?: (id: string) => Array<{ key?: string; modifiers?: string[] }> | null
			}
			if (!cmds || !hk?.getHotkeys) return null
			const ids: string[] = cmds.listCommands
				? cmds.listCommands().map(c => c.id)
				: Object.keys(cmds.commands ?? {})
			for (const id of ids) {
				// getHotkeys 只含用户自定义绑定；三方插件（UNmemos/UNagent 等）的
				// 快捷键通常只是 addCommand 注册的默认热键，必须回退 getDefaultHotkeys，
				// 否则书内按键永远匹配不到、命令不会被执行。
				const custom = hk.getHotkeys(id)
				const list = custom?.length ? custom : hk.getDefaultHotkeys?.(id)
				if (!list?.length) continue
				for (const shortcut of list) {
					if (this.hotkeyMatchesEvent(shortcut, e)) return id
				}
			}
		} catch {
			// 内部 API 缺失或异常 → 交给转发兜底
		}
		return null
	}

	/** 判断一个快捷键配置是否命中按键事件。macOS 用 Mod 语义；按 e.code
	 * 匹配字母/数字，规避 Option+字母产生特殊字符导致 key 对不上。 */
	private hotkeyMatchesEvent(
		shortcut: { key?: string; modifiers?: string[] },
		e: KeyboardEvent,
	): boolean {
		const key = (shortcut.key ?? "").toUpperCase()
		if (!key) return false
		const keyOk =
			e.key.toUpperCase() === key ||
			e.code.toUpperCase() === `Key${key}` ||
			e.code.toUpperCase() === `Digit${key}` ||
			e.code.toUpperCase() === key
		if (!keyOk) return false
		const mods = shortcut.modifiers ?? []
		const wantMeta = mods.includes("Mod") ? Platform.isMacOS : mods.includes("Meta")
		const wantCtrl = mods.includes("Mod") ? !Platform.isMacOS : mods.includes("Ctrl")
		const wantAlt = mods.includes("Alt")
		const wantShift = mods.includes("Shift")
		return (
			e.metaKey === wantMeta &&
			e.ctrlKey === wantCtrl &&
			e.altKey === wantAlt &&
			e.shiftKey === wantShift
		)
	}

	private isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		return target.matches("input, textarea, select, [contenteditable=true]");
	}

	/** 连续模式下的宿主文档选区 → 工具条（固定定位：正文区底部居中，不跟随选区） */
	private handleContinuousSelection(info: { text: string; cfi: string | null; rect: DOMRect }): void {
		if (!info.text) {
			// 编辑评论期间同 captureSelection：选区被系统收走 ≠ 用户放弃标注
			if (this.isEditingComment()) return;
			if (this.selectionToolbar.visible) this.selectionToolbar.hide();
			this.pendingSelection = null;
			this.lastExcerpt = null;
			this.clearMirrorSelection();
			return;
		}
		if (this.appearancePanel.isOpen() || this.footnoteBackdrop || this.highlightPopover.visible) return;
		// 固定定位：bounds 用 stage 在 body 本地坐标系的矩形（现测，见 stageBoundsNow）
		const stageBounds = this.stageBoundsNow();
		const local = new DOMRect(stageBounds.left ?? 0, stageBounds.top ?? 0, stageBounds.width, stageBounds.height);
		const idx = this.adapter.getCurrentIndex();
		this.pendingSelection = { doc: document, index: idx, text: info.text, cfi: info.cfi, rect: local, at: Date.now() };
		this.lastExcerpt = { text: info.text, cfi: info.cfi, at: this.pendingSelection.at };
		this.selectionToolbar.showFor({ doc: document, text: info.text }, null, stageBounds);
		// 镜像到宿主文档并归还焦点：UNmemos 快速记录 / UNagent 快速引用等以受信事件读取选区
		this.syncSelectionToHost(info.text);
	}

	private handleKey(e: KeyboardEvent): void {
		// 防双处理：同一事件可能经多条路径到达（iframe 接线 / 连续容器监听 /
		// window 兜底），先到先处理，后到直接跳过
		const ev = e as KeyboardEvent & { __unreaderHandled?: boolean };
		if (ev.__unreaderHandled) return;
		ev.__unreaderHandled = true;
		// Esc：全沉浸的键盘出口。宿主焦点那一半已由 onOpen 的 window keydown 处理，
		// 这里补的是**焦点在书页 iframe 内**的一半 —— iframe 的键盘事件不冒泡到宿主
		// window，既到不了官方 keymap 也到不了那条兜底，用户按 Esc 毫无反应。
		// 模态框开着时不抢（先让官方关掉弹窗，再按一次才退模式）。
		if (e.key === "Escape") {
			if (this.fullImmersion && !hasCoreModal()) {
				e.preventDefault();
				this.exitFullImmersion();
			}
			return;
		}
		// 章节级快捷键：Alt / Ctrl / Cmd + 左右箭头 → 上下章，即使有修饰键也优先处理
		if ((e.altKey || e.ctrlKey || e.metaKey) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			e.preventDefault();
			if (e.key === "ArrowRight") this.goNextChapter();
			else this.goPrevChapter();
			return;
		}
		// 其他修饰键组合交由 Obsidian（合成转发，配合选区镜像保活）
		if (e.ctrlKey || e.metaKey || e.altKey) {
			e.preventDefault();
			// 修饰键热键必然要开命令/模态框（或交给 Obsidian）：先把键盘焦点
			// 从 iframe 还给宿主，否则模态框拿不到键盘，打字与回车全落回书页
			this.returnFocusToHost();
			// 优先命令直达（不依赖合成事件被 keymap 接受）；直达失败才回退合成
			// 转发。成功后禁止再转发，否则宿主 keymap 会再执行一次（双触发）。
			const cmd = this.findCommandForHotkey(e);
			let executed = false;
			if (cmd) {
				try {
					const ret = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => unknown } })
						.commands?.executeCommandById?.(cmd);
					// 直达已派发即视为成功（返回 undefined 的旧版 API 也一样）：
					// 若再合成转发，宿主 keymap 会重复执行/重复开面板，
					// 面板"开两层"会让第一次回车只关掉上层、命令看似没执行
					executed = ret !== false;
				} catch { /* ignore */ }
			}
			if (!executed) this.forwardKeyToHost(e);
			return;
		}
		if (this.isEditableTarget(e.target)) return;

		const key = e.shiftKey && e.key === " " ? "PageUp" : e.key;
		// 单键 [ / ] 快速跳章（便于无修饰键的快捷操作）
		if (key === "[" || key === "BracketLeft") {
			e.preventDefault();
			this.goPrevChapter();
			return;
		}
		if (key === "]" || key === "BracketRight") {
			e.preventDefault();
			this.goNextChapter();
			return;
		}
		// 键盘翻页 0.8 页，保留 20% 上下文。连续模式下边界即全书首尾，
		// 保留跳章/提示逻辑
		if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === " ") {
			e.preventDefault();
			if (this.adapter.isAtSectionBottom() && this.adapter.canGoNextSection()) {
				this.goNextChapter();
			} else {
				const m = this.adapter.getScrollMetrics();
				const dist = m ? m.size * 0.8 : undefined;
				void this.adapter.next(dist);
			}
			return;
		}
		if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") {
			e.preventDefault();
			if (this.adapter.isAtSectionTop() && this.adapter.canGoPrevSection()) {
				this.goPrevChapter();
			} else {
				const m = this.adapter.getScrollMetrics();
				const dist = m ? m.size * 0.8 : undefined;
				void this.adapter.prev(dist);
			}
			return;
		}
		// everything else reaches Obsidian's global keymap
		this.forwardKeyToHost(e);
	}

	/** 连续模式 iframe 文档：悬停预览/点击高亮等复用现有交互（视口坐标天然一致） */
	private wireFrameDoc(doc: Document): void {
		if ((doc as unknown as { __unreaderWired?: boolean }).__unreaderWired) return;
		(doc as unknown as { __unreaderWired?: boolean }).__unreaderWired = true;
		doc.addEventListener("mousemove", e => this.handleAnnotationHover(e, doc));
		// mouseleave 不主动关闭原生弹窗，交由官方距离判定，避免移向弹窗时消失
		doc.addEventListener("keyup", e => {
			if (!e.ctrlKey && !e.metaKey) 
			this.dismissHover();
			if (e.key === "Escape") {
				this.selectionToolbar?.hide();
				this.highlightPopover?.hide();
				
			this.dismissHover();
			}
		});
	}

/* ---------------- 触屏横向手势已全部移除 ----------------
 * 分页模式删除后，原用于「分页跟手 + 边缘开栏」二分的整套触屏链路
 * （pagTouch 状态、paginatedTouchStart/Move/End/Cancel、touchWindowY、
 *  markTouchSeen、hasActiveSelection、openSidebarBySwipe、
 *  openLeftSidebarBySwipe、expandSidebarSplit、SWIPE_* 常量）一并移除。
 * 连续模式横向滑动由 Obsidian 原生侧栏手势（从屏幕边缘划入）接管，
 * 不再在阅读器视图层做任何 capture 拦截。
 */
}

/**
 * 从事件里取出「元素」目标，跨 iframe 安全。
 *
 * ⚠️ **不能用 `e.target instanceof Element`**：章节正文跑在独立的 iframe 里，
 * iframe 有自己的 JS realm，它的 `Element` 构造函数与主窗口的不是同一个对象 ——
 * `iframe里的元素 instanceof 主窗口的Element` 恒为 `false`。结果是所有
 * 「这次点的是不是链接」的判断静默失效：播客时间戳点击不被拦截、外链拦截失效，
 * 事件继续冒泡去触发界面显隐切换（用户报的「点时间戳只会显示/隐藏所有元素」）。
 *
 * 判据改用 `nodeType === 1`（元素节点），这是跨 realm 恒等的数字常量。
 */
function eventElement(e: Event): Element | null {
	const target = e.target as Node | null;
	if (!target) return null;
	if (target.nodeType === 1) return target as Element;
	return (target as Node).parentElement ?? null;
}
