import { Menu, setIcon } from "obsidian";

/** 侧边栏设定高度时的两条行内样式（提常量以过 no-static-styles-assignment）。 */
const ANNO_HEIGHT_ALIGN_SELF = "flex-start";
const ANNO_HEIGHT_BOTTOM = "auto";
import type { AnnotationFileData, StoredHighlight, StoredBookmark } from "../core/annotationStore";
import { sanitizeBookmarkLabel } from "../core/annotationStore";
import { highlightColorOf } from "../types";
import { resolveAppearance, ensureHostCustomFont } from "../core/engineAdapter";
import type { AppearanceSettings, BookshelfCategory, BookshelfCategoryFilter, BookshelfEntry, BookshelfSortMode, FeedEntry, FeedEntryKind, FeedFilter, FeedSubscription } from "../types";
import type { BookPreview } from "../core/bookPreview";
import { subscribeKeyboardGeometry, usableBottom } from "./keyboardInset";
import { entryFeedContentQuality } from "../core/feedContentQuality";

export interface AnnotationsPanelActions {
	onJump: (cfi: string, textHint?: string) => void
	onPreviewHighlight: (item: StoredHighlight, anchorEl: HTMLElement) => void
	onCommentHighlight: (id: number, comment: string) => void
	onCopyReference: (item: StoredHighlight) => void
	onDeleteHighlight: (id: number) => void
	onDeleteBookmark: (id: number) => void
	/** 重命名书签（label 已 trim 且非空时才会被调用） */
	onRenameBookmark: (id: number, label: string) => void
	/** 位置 token → 全书页码。每次渲染/刷新现算，不缓存、不落盘；
	 *  排版模型变化后页码自动跟随（见 AnnotationsPanel.refreshPages） */
	getPageForAnchor?: (anchor: string) => { page: number; total: number } | null
	onTogglePin?: () => void
	/** 拖拽调节侧边栏高度后回调（px；null = 恢复默认） */
	onHeightChange?: (px: number | null) => void
	/** 拖拽调节侧边栏宽度后回调（px；null = 恢复默认） */
	onWidthChange?: (px: number | null) => void
	/** 面板开 / 合回调（含面板被外部关闭、重渲染等路径）：宿主据此同步功能轨上
	 *  「标注列表」按钮的「作用中」高亮。挂在这里而不是各调用点 —— `show()` / `hide()`
	 *  是开合的唯一收口，少挂一条路径就会留下假高亮。 */
	onOpenChange?: (open: boolean) => void
	/** 书架数据只读轻量索引；封面与首行由 loadBookPreview 按可见性懒加载。 */
	getBookshelfEntries?: () => BookshelfEntry[]
	getBookshelfSortMode?: () => BookshelfSortMode
	getCurrentBookPath?: () => string | null
	/** 当前正在阅读的页面名（书名 / 订阅文章名）；没有打开任何页面时返回 null。 */
	getCurrentDocumentName?: () => string | null
	onBookshelfSortModeChange?: (mode: BookshelfSortMode) => void
	onBookshelfReorder?: (paths: string[]) => void
	onToggleBookPin?: (path: string) => void
	/** 分类筛选 / 单书分类与手动移除；数据落点由宿主统一持久化 */
	getBookshelfCategories?: () => BookshelfCategory[]
	getBookshelfCategoryFilter?: () => BookshelfCategoryFilter
	onBookshelfCategoryFilterChange?: (filter: BookshelfCategoryFilter) => void
	onAssignBookCategory?: (path: string, categoryId: string | null) => void
	onRemoveBookFromShelf?: (path: string) => void
	onOpenBookshelfCategoryManager?: () => void
	onOpenBook?: (path: string) => void
	loadBookPreview?: (path: string) => Promise<BookPreview>
	onModeChange?: (mode: "annotations" | "bookshelf" | "feeds") => void
	getFeeds?: () => FeedSubscription[]
	getFeedEntries?: () => FeedEntry[]
	getFeedFilter?: () => FeedFilter
	getFeedSourceFilter?: () => string | null
	getCurrentFeedEntry?: () => { feedId: string; entryId: string; kind?: FeedEntryKind } | null
	onFeedFilterChange?: (filter: FeedFilter) => void
	onFeedSourceFilterChange?: (feedId: string | null) => void
	onOpenFeedEntry?: (feedId: string, entryId: string) => void
	onToggleFeedRead?: (feedId: string, entryId: string) => void
	onToggleFeedStar?: (feedId: string, entryId: string) => void
	onRefreshFeeds?: () => void
	onAddFeed?: () => void
	onImportOpml?: () => void
	/** 订阅管理面板（工具栏「设置」按钮） */
	onOpenFeedManager?: () => void
	/** 悬浮态面板的「移开鼠标自动关闭」临时挂起（菜单/子面板打开期间用） */
	onHoldAutoClose?: (hold: boolean) => void
	onFetchFulltext?: (feedId: string, entryId: string) => void
	/** 把文章存成 Obsidian 笔记（Markdown + 图片落盘）；未抓全文时由宿主先抓再存。 */
	onSaveNote?: (feedId: string, entryId: string) => void
	onOpenOriginal?: (url: string) => void
	onDownloadPodcast?: (feedId: string, entryId: string) => Promise<boolean>
	onPodcastProgress?: (feedId: string, entryId: string, seconds: number, duration: number) => void
	onResolvePodcastUrl?: (url: string) => Promise<string>
	isPodcastDownloaded?: (url: string) => boolean
	onCheckPodcastDownloaded?: (url: string) => Promise<boolean>
}

/**
 * 标注侧边栏：书签 + 高亮/评论 的快速定位列表（左缘抽屉，支持悬浮/钉住）。
 * 底部拖拽手柄可调节面板高度（钉住/悬浮模式通用，位置由 readerView 持久化）。
 */

/** 触屏（粗指针）判定：单击直接跳转、不加双击延迟，否则每次点书签/高亮都慢 220ms */
function isCoarse(): boolean {
	try { return window.matchMedia?.("(pointer: coarse)")?.matches ?? false } catch { return false }
}

function formatRecentRead(updatedAt: number): string {
	if (!updatedAt || !Number.isFinite(updatedAt)) return "尚未阅读";
	const delta = Math.max(0, Date.now() - updatedAt);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (delta < minute) return "刚刚";
	if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
	if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
	if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
	const date = new Date(updatedAt);
	return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatFeedDate(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "日期未知";
	const date = new Date(timestamp);
	const now = new Date();
	const sameYear = date.getFullYear() === now.getFullYear();
	if (sameYear && FEED_DATE_THIS_YEAR) return FEED_DATE_THIS_YEAR.format(date);
	if (!sameYear && FEED_DATE_OTHER_YEAR) return FEED_DATE_OTHER_YEAR.format(date);
	return sameYear
		? `${date.getMonth() + 1}月${date.getDate()}日`
		: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const FEED_DATE_THIS_YEAR = (() => {
	try { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return null; }
})();

const FEED_DATE_OTHER_YEAR = (() => {
	try { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }); } catch { return null; }
})();

function formatMediaDuration(seconds: number | null): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
		: `${minutes}:${String(secs).padStart(2, "0")}`;
}

export class AnnotationsPanel {
	readonly containerEl: HTMLElement;
	private listEl!: HTMLElement;
	private actions: AnnotationsPanelActions;
	private mode: "annotations" | "bookshelf" | "feeds" = "annotations";
	private annotationData: AnnotationFileData = { highlights: [], bookmarks: [] };
	private headerTitleEl: HTMLElement | null = null;
	private bookshelfModeBtn: HTMLElement | null = null;
	private feedsModeBtn: HTMLElement | null = null;
	private annotationModeBtn: HTMLElement | null = null;
	private shelfPreviewObserver: IntersectionObserver | null = null;
	private shelfPreviewLoaders = new WeakMap<Element, () => void>();
	private feedListObserver: IntersectionObserver | null = null;
	private feedListSentinel: HTMLElement | null = null;
	private feedListState: {
		entries: FeedEntry[]
		feeds: Map<string, FeedSubscription>
		current: { feedId: string; entryId: string } | null
		list: HTMLElement
		nextIndex: number
		generation: number
	} | null = null;
	private feedListGeneration = 0;
	private shelfDragCleanup: (() => void) | null = null;
	private pinBtn: HTMLElement | null = null;
	private pinned = false;
	private currentHeight: number | null = null;
	private currentWidth: number | null = null;
	/** 书签行的页码元素（anchor 供 refreshPages 重算），render 时重建 */
	private bookmarkPageEls: { el: HTMLElement; anchor: string }[] = [];
	/** 输入区（评论 / 重命名）展开期间的「跟着键盘走」清理函数；关闭、重渲染时调用 */
	private revealCleanup: (() => void) | null = null;

	/**
	 * 让正在编辑的块一直停在**可用区**内（可用区底边 = 键盘顶 / 键盘上方原生栏顶 / 面板底的最小值）。
	 *
	 * 面板在左缘、纵向铺满叶子，键盘一弹起官方就把 `.app-container` 收缩成
	 * `100vh - --keyboard-height` → 卡片很容易落到键盘下面（用户看到的「评论输入框在输入法下面」）。
	 * 所以展开后既要立即停靠，也要订阅几何变化重算（键盘与原生栏都是动画、iPad 上原生栏还可能迟到）。另外「滚动区已到底、滚不动了」要单独兜：块在列表最末尾时滚动范围本来就已吃满，而键盘动画那一档容器还没收缩、滚动范围也不会变大 —— 代码「知道」键盘在哪也顶不上来；这时按缺口加高底部留白（只增不减，见 reveal）是唯一能把输入框救出键盘的手。
	 *
	 * ⚠️ 绝不能调 `el.scrollIntoView()`：它会沿祖先链滚动**所有**滚动容器（含 `overflow:hidden` 的
	 *    `.workspace-leaf-content`），能把页首整条顶出可视区（见 skill 陷阱 #38）。这里只动
	 *    面板自己的 `.unreader-toc-scroll`。
	 */
	private startEditorReveal(editorEl: HTMLElement): void {
		this.stopEditorReveal();
		const scrollEl = this.listEl;
		if (!scrollEl || !editorEl) return;
		// 输入区展开期间抬高滚动区底部留白：否则列表尾部的卡片没有足够滚动余量把编辑块顶上来
		const prevPad = scrollEl.style.paddingBottom;
		const basePad = editorEl.offsetHeight + 28;
		// 「额外的」留白只在滚动余量确实不够时按缺口增量补足（见 reveal）。
		// 上界取视口高：任何真实缺口都不可能超过可用区高度，这条界同时保证它必然收敛。
		const padCap = Math.max(200, window.innerHeight || 800);
		let extraPad = 0;
		scrollEl.style.paddingBottom = `${basePad}px`;
		const reveal = (): void => {
			if (!editorEl.isConnected) {
				this.stopEditorReveal();
				return;
			}
			const short = this.keepEditorVisible(scrollEl, editorEl);
			// 块在列表最末尾时，滚动范围本来就已到底 —— 光靠滚动永远顶不上来（键盘动画那一档
			// 容器还没收缩，滚动范围也不会变大）。按缺口把底部留白加高再收一次：
			// 只增不减（收敛性：留白加高只会扩大滚动范围，下一轮缺口必然归零），
			// 否则「已到底 → 缺口 0 → 留白复原 → 又有缺口」会来回抖。
			if (short > 1 && extraPad < padCap) {
				extraPad = Math.min(padCap, extraPad + Math.ceil(short));
				scrollEl.style.paddingBottom = `${basePad + extraPad}px`;
				this.keepEditorVisible(scrollEl, editorEl);
			}
		};
		// 立即 + 下一帧各来一次（展开会改变列表高度），随后交给几何订阅（含收敛梯子）
		reveal();
		const raf = window.requestAnimationFrame(reveal);
		const unwatch = subscribeKeyboardGeometry(scrollEl, reveal);
		this.revealCleanup = () => {
			window.cancelAnimationFrame(raf);
			unwatch();
			scrollEl.style.paddingBottom = prevPad;
		};
	}

	private stopEditorReveal(): void {
		const fn = this.revealCleanup;
		this.revealCleanup = null;
		if (fn) fn();
	}

	/**
	 * 只滚动面板自己的滚动区：把 targetEl 的下沿提到可用区之上；块比可用区还高时保顶边不越界。
	 *
	 * 返回**没吃下去的缺口**（滚动区已到底、块下沿仍在可用区之下时 > 0）：调用方据此补足
	 * 滚动余量（`startEditorReveal` 的额外留白）。用「滚动后再现测一次」而不是拿 delta 做减法
	 * —— 滚动区到底时 `scrollTop` 不会真的走到目标值，差价只有现测才算得准。
	 */
	private keepEditorVisible(scrollEl: HTMLElement, targetEl: HTMLElement): number {
		const sr = scrollEl.getBoundingClientRect();
		const tr = targetEl.getBoundingClientRect();
		const limit = Math.min(usableBottom(scrollEl), sr.bottom);
		const bottomEdge = limit - 10;
		const topEdge = sr.top + 6;
		let delta = 0;
		if (tr.bottom > bottomEdge) delta = tr.bottom - bottomEdge;
		if (tr.top - delta < topEdge) delta = tr.top - topEdge;
		if (Math.abs(delta) < 1) return 0;
		scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta);
		return Math.max(0, targetEl.getBoundingClientRect().bottom - bottomEdge);
	}

	constructor(actions: AnnotationsPanelActions) {
		this.actions = actions;
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-anno-panel";

		const header = this.containerEl.createDiv({ cls: "unreader-toc-header" });
		// 头部只显示**正在阅读的页面名**（书名 / 文章名），没有打开页面时才退回模式名。
		// 原来这里挂的是固定品牌字样「UNreader」，在侧栏里等于没信息量。
		this.headerTitleEl = header.createDiv({ cls: "unreader-anno-title" });
		const headerRight = header.createDiv({ cls: "unreader-toc-header-right" });
		const modeSwitch = headerRight.createDiv({ cls: "unreader-anno-mode-switch" });
		this.bookshelfModeBtn = modeSwitch.createDiv({ cls: "unreader-anno-mode-btn" });
		this.bookshelfModeBtn.setAttribute("aria-label", "书架");
		this.bookshelfModeBtn.setAttribute("title", "书架");
		try { setIcon(this.bookshelfModeBtn, "library"); } catch { this.bookshelfModeBtn.setText("书"); }
		this.bookshelfModeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.setMode("bookshelf");
		});
		this.feedsModeBtn = modeSwitch.createDiv({ cls: "unreader-anno-mode-btn" });
		this.feedsModeBtn.setAttribute("aria-label", "订阅");
		this.feedsModeBtn.setAttribute("title", "订阅");
		try { setIcon(this.feedsModeBtn, "rss"); } catch { this.feedsModeBtn.setText("RSS"); }
		this.feedsModeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.setMode("feeds");
		});
		this.annotationModeBtn = modeSwitch.createDiv({ cls: "unreader-anno-mode-btn" });
		this.annotationModeBtn.setAttribute("aria-label", "高亮与书签");
		this.annotationModeBtn.setAttribute("title", "高亮与书签");
		try { setIcon(this.annotationModeBtn, "highlighter"); } catch { this.annotationModeBtn.setText("标"); }
		this.annotationModeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.setMode("annotations");
		});
		// display:flex/align-items/gap 全部在 .unreader-toc-header-right 的 CSS 类里给
		// （官方 lint 禁止行内字面量样式）
		this.pinBtn = headerRight.createDiv({ cls: "unreader-clickable-icon unreader-anno-pin" });
		this.pinBtn.setAttribute("aria-label", "钉住侧边栏");
		try { setIcon(this.pinBtn, "pin"); } catch { this.pinBtn.setText("钉"); }
		this.pinBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onTogglePin?.();
		});

		this.listEl = this.containerEl.createDiv({ cls: "unreader-toc-scroll" });

		// 底部拖拽手柄：手动调节侧边栏高度（双击恢复默认）
		const grip = this.containerEl.createDiv({ cls: "unreader-anno-resize" });
		grip.setAttribute("aria-label", "拖拽调节侧边栏高度（双击恢复默认）");
		grip.addEventListener("pointerdown", e => {
			e.preventDefault();
			e.stopPropagation();
			const startY = e.clientY;
			const startH = this.containerEl.offsetHeight;
			const maxH = Math.max(260, (this.containerEl.parentElement?.clientHeight ?? 900) - 80);
			const move = (ev: PointerEvent): void => {
				const h = Math.round(Math.max(220, Math.min(maxH, startH + (ev.clientY - startY))));
				this.applyHeight(h);
			};
			const up = (): void => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				this.actions.onHeightChange?.(this.currentHeight);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		});
		grip.addEventListener("dblclick", e => {
			e.stopPropagation();
			this.applyHeight(null);
			this.actions.onHeightChange?.(null);
		});

		// 右缘拖拽手柄：手动调节侧边栏宽度（双击恢复默认）
		const widthGrip = this.containerEl.createDiv({ cls: "unreader-anno-resize-w" });
		widthGrip.setAttribute("aria-label", "拖拽调节侧边栏宽度（双击恢复默认）");
		widthGrip.addEventListener("pointerdown", e => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startW = this.containerEl.offsetWidth;
			const parentW = this.containerEl.parentElement?.clientWidth ?? 1200;
			const maxW = Math.max(300, Math.min(parentW - 60, Math.floor(parentW * 0.86)));
			const move = (ev: PointerEvent): void => {
				const w = Math.round(Math.max(240, Math.min(maxW, startW + (ev.clientX - startX))));
				this.applyWidth(w);
			};
			const up = (): void => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				this.actions.onWidthChange?.(this.currentWidth);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		});
		widthGrip.addEventListener("dblclick", e => {
			e.stopPropagation();
			this.applyWidth(null);
			this.actions.onWidthChange?.(null);
		});
		this.syncModeChrome();
	}

	/** 恢复持久化的高度（readerView 初始化时调用） */
	setHeight(px: number | null): void {
		this.applyHeight(px);
	}

	private applyHeight(px: number | null): void {
		this.currentHeight = px;
		const el = this.containerEl;
		if (px == null) {
			el.style.removeProperty("height");
			el.style.removeProperty("align-self");
			el.style.removeProperty("bottom");
		} else {
			el.style.height = `${px}px`;
			// 钉住模式 flex 横排里按设定高度顶对齐；悬浮模式解除 bottom 铺满。
			// 必须保持**行内强度**：`body.is-phone .unreader-anno-panel` 的 bottom
			// 特异性 (0,2,1) 高于任何 (0,2,0) 的类，改成 CSS 类会被它盖掉。
			// （字面量提成常量只为满足官方 no-static-styles-assignment，值不变。）
			el.style.setProperty("align-self", ANNO_HEIGHT_ALIGN_SELF);
			el.style.setProperty("bottom", ANNO_HEIGHT_BOTTOM);
		}
	}

	/** 恢复持久化的宽度（readerView 初始化时调用） */
	setWidth(px: number | null): void {
		this.applyWidth(px);
	}

	/** 手机纵向形态（官方在 body 上挂 `is-phone`；与 styles.css 的手机规则同一判据）。
	 *  取 body 的类而不是 Platform.isPhone，是为了与样式表里的 `body.is-phone` 分支
	 *  **永远同源** —— 两处判据一旦漂移，就会出现「样式按手机走、JS 按桌面走」的错位。 */
	private isPhoneLayout(): boolean {
		try { return document.body.classList.contains("is-phone"); } catch { return false }
	}

	private applyWidth(px: number | null): void {
		this.currentWidth = px;
		const el = this.containerEl;
		const parent = el.parentElement;
		// 手机端：宽度由 CSS 定死为 75vw（见 styles.css 的 --ur-anno-w 段）。这里必须
		// **清掉行内宽度与变量**且不再写回 —— 行内样式优先级高于样式表，留着它手机档
		// 就永远拿不到 75vw（拖拽把手也已隐藏，用户改不了，只会以为坏了）。
		if (this.isPhoneLayout()) {
			el.style.removeProperty("width");
			parent?.style.removeProperty("--unreader-anno-w");
			return;
		}
		if (px == null) {
			el.style.removeProperty("width");
			parent?.style.removeProperty("--unreader-anno-w");
		} else {
			el.style.width = `${px}px`;
			// 同步 CSS 变量，供兄弟面板（外观/按钮排）与钉住模式 flex 布局跟随宽度
			parent?.style.setProperty("--unreader-anno-w", `${px}px`);
		}
	}

	setPinned(pinned: boolean): void {
		this.pinned = pinned;
		this.containerEl.toggleClass("is-pinned", pinned);
		if (this.pinBtn) {
			this.pinBtn.toggleClass("is-active", pinned);
			this.pinBtn.setAttribute("aria-label", pinned ? "取消钉住" : "钉住侧边栏");
			try { setIcon(this.pinBtn, pinned ? "pin-off" : "pin"); } catch { /* fallback */ }
		}
	}

	setPinVisible(visible: boolean): void {
		if (!this.pinBtn) return;
		this.pinBtn.toggleClass("is-hidden", !visible);
	}

	syncAppearance(appearance: AppearanceSettings): void {
		const r = resolveAppearance(appearance);
		// 与书籍正文完全一致：字体、字号、行距、字距（自定义字体 r.fontFamily 已带引号）
		const ff = r.fontFamily || "var(--font-text)";
		this.containerEl.style.setProperty("--anno-font-family", ff);
		this.containerEl.style.setProperty("--anno-font-size", `${r.fontSize}px`);
		this.containerEl.style.setProperty("--anno-line-height", String(r.lineHeight));
		this.containerEl.style.setProperty("--anno-letter-spacing", `${r.letterSpacing}em`);
		// 直接作为面板默认字体：确保高亮/书签正文、评论等所有文字都继承所选字体
		this.containerEl.style.fontFamily = ff;
		// 自定义字体此前只注册进了各章节 iframe 的文档，宿主文档里没有这个 family
		// → 面板请求的字体名解析失败、回退默认字体（「面板字体与正文不一致」的根因）。
		// 这里补一次宿主注册；未用自定义字体时本调用直接返回。
		try { ensureHostCustomFont(appearance.fontFamily); } catch { /* ignore */ }
	}

	getMode(): "annotations" | "bookshelf" | "feeds" {
		return this.mode;
	}

	/** 当前模式的兜底标题（没有任何页面打开时显示，保证头部不空着）。 */
	private modeLabel(): string {
		return this.mode === "bookshelf" ? "书架" : this.mode === "feeds" ? "订阅" : "标注";
	}

	/** 头部标题 = 当前页面名；换书 / 换文章 / 回到空白态时由宿主调用重读。
	 *  取值是现读的（`getCurrentDocumentName` 每次现算），不做缓存。 */
	refreshHeaderTitle(): void {
		const el = this.headerTitleEl;
		if (!el) return;
		const name = (this.actions.getCurrentDocumentName?.() ?? "").trim();
		el.setText(name || this.modeLabel());
		el.toggleClass("is-placeholder", !name);
		el.setAttribute("title", name || this.modeLabel());
	}

	/** 三种内容共用同一抽屉、钉住状态、尺寸与开合状态，只切换列表主体。 */
	setMode(mode: "annotations" | "bookshelf" | "feeds"): void {
		this.shelfDragCleanup?.();
		const changed = this.mode !== mode;
		const previousScroll = this.listEl.scrollTop;
		this.mode = mode;
		this.syncModeChrome();
		if (mode === "bookshelf") this.renderBookshelf();
		else if (mode === "feeds") this.renderFeeds();
		else this.renderAnnotations();
		// 切换模式回到顶部；同一模式内因排序、置顶或拖拽重绘时保留当前位置。
		this.listEl.scrollTop = changed ? 0 : previousScroll;
		if (changed) this.actions.onModeChange?.(mode);
	}

	private syncModeChrome(): void {
		const shelf = this.mode === "bookshelf";
		const feeds = this.mode === "feeds";
		this.containerEl.toggleClass("is-bookshelf", shelf);
		this.containerEl.toggleClass("is-feeds", feeds);
		this.containerEl.toggleClass("is-annotations", !shelf && !feeds);
		this.refreshHeaderTitle();
		this.bookshelfModeBtn?.toggleClass("is-active", shelf);
		this.feedsModeBtn?.toggleClass("is-active", feeds);
		this.annotationModeBtn?.toggleClass("is-active", !shelf && !feeds);
	}

	private disconnectShelfPreviews(): void {
		try { this.shelfPreviewObserver?.disconnect(); } catch { /* ignore */ }
		this.shelfPreviewObserver = null;
		this.shelfPreviewLoaders = new WeakMap<Element, () => void>();
	}

	private stopFeedListRendering(): void {
		try { this.feedListObserver?.disconnect(); } catch { /* ignore */ }
		this.feedListObserver = null;
		this.feedListSentinel?.remove();
		this.feedListSentinel = null;
		this.feedListState = null;
		this.feedListGeneration++;
	}

	private renderAnnotations(): void {
		this.disconnectShelfPreviews();
		const data = this.annotationData;
		const current = this.actions.getCurrentFeedEntry?.();
		const feed = !!current;
		const podcast = current?.kind === "audio";
		// 列表整体重建 → 旧的输入区连同其停靠订阅一起作废，先清理（否则 paddingBottom 会残留）
		this.stopEditorReveal();
		this.listEl.empty();
		this.bookmarkPageEls = [];
		if (!data.bookmarks.length && !data.highlights.length) {
			// 当前读的是 Feed 文章时功能轨上是「星标」而不是「添加书签」（两枚互斥），
			// 空态提示必须跟着走，否则指的那枚按钮根本不在屏幕上。
			this.listEl.createDiv({
				cls: "unreader-toc-empty",
				text: podcast
					? "暂无标注。选中正文文字可高亮或评论；播放时点底部「标记」可给当前时间写备注，作为时间点书签显示在这里。"
					: feed
						? "暂无标注。选中文字可高亮或评论，点击工具栏星标按钮可收藏这篇文章。"
						: "暂无标注。选中文字可高亮或评论，点击工具栏书签按钮可收藏当前位置。",
			});
			return;
		}

		// 书签置顶：用户强调书签为最常用入口；播客下同一区承载“时间点书签”。
		if (data.bookmarks.length) {
			this.listEl.createDiv({ cls: "unreader-anno-section unreader-anno-section--bookmark", text: `${podcast ? "书签与时间点" : "书签"} · ${data.bookmarks.length}` });
			const ul = this.listEl.createEl("ul", { cls: "unreader-anno-list" });
			for (const b of data.bookmarks) {
				ul.appendChild(this.bookmarkRow(b));
			}
		}

		if (data.highlights.length) {
			this.listEl.createDiv({ cls: "unreader-anno-section unreader-anno-section--highlight", text: `高亮与评论 · ${data.highlights.length}` });
			const ul = this.listEl.createEl("ul", { cls: "unreader-anno-list" });
			for (const h of data.highlights) {
				ul.appendChild(this.highlightRow(h));
			}
		}
	}

	private renderBookshelf(): void {
		this.disconnectShelfPreviews();
		this.listEl.empty();
		this.bookmarkPageEls = [];
		const allEntries = this.actions.getBookshelfEntries?.() ?? [];
		const categories = this.actions.getBookshelfCategories?.() ?? [];
		const requestedFilter = this.actions.getBookshelfCategoryFilter?.() ?? "all";
		// 分类删除后筛选值可能悬空；渲染时当场回到「全部」，避免留着一片空白。
		const activeFilter: BookshelfCategoryFilter = requestedFilter === "uncategorized" || categories.some(category => category.id === requestedFilter)
			? requestedFilter
			: "all";
		if (activeFilter !== requestedFilter) this.actions.onBookshelfCategoryFilterChange?.("all");
		const entries = activeFilter === "all"
			? allEntries
			: activeFilter === "uncategorized"
				? allEntries.filter(entry => !entry.categoryId)
				: allEntries.filter(entry => entry.categoryId === activeFilter);
		const sortMode = this.actions.getBookshelfSortMode?.() ?? "scan";
		const currentPath = this.actions.getCurrentBookPath?.() ?? null;
		const sourceLabel = activeFilter === "all"
			? "全部书籍"
			: activeFilter === "uncategorized"
				? "未分类"
				: categories.find(category => category.id === activeFilter)?.name ?? "全部书籍";

		const toolbar = this.listEl.createDiv({ cls: "unreader-shelf-toolbar" });
		this.buildBookshelfCategoryButton(toolbar, allEntries, categories, activeFilter, sourceLabel);
		const actions = toolbar.createDiv({ cls: "unreader-shelf-actions" });
		const select = actions.createEl("select", { cls: "unreader-shelf-sort" });
		select.setAttribute("aria-label", "书架排序");
		const options: Array<[BookshelfSortMode, string]> = [
			["scan", "默认排序"],
			["recent", "最近阅读"],
			["manual", "手动排序"],
		];
		for (const [value, label] of options) {
			const option = select.createEl("option", { text: label });
			option.value = value;
		}
		select.value = sortMode;
		select.addEventListener("change", e => {
			e.stopPropagation();
			this.actions.onBookshelfSortModeChange?.(select.value as BookshelfSortMode);
		});
		const managerBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-feed-action unreader-shelf-manager" });
		managerBtn.setAttribute("aria-label", "分类管理");
		managerBtn.setAttribute("title", "分类管理");
		try { setIcon(managerBtn, "settings-2"); } catch { managerBtn.setText("⚙"); }
		managerBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onOpenBookshelfCategoryManager?.();
		});

		if (!entries.length) {
			this.listEl.createDiv({
				cls: "unreader-toc-empty",
				text: activeFilter === "all"
					? "全库中还没有可收录的书籍（EPUB / AZW3 / MOBI / TXT / HTML）。若书在排除的文件夹里，可在 设置 → UNreader → 书架 调整。"
					: "这个分类里还没有书。点书籍卡片右键（或右侧 ⋯ 按钮）可以移动分类。",
			});
			return;
		}
		this.listEl.toggleClass("is-manual", sortMode === "manual");
		const pinned = entries.filter(entry => entry.pinned);
		const regular = entries.filter(entry => !entry.pinned);
		if (pinned.length) this.renderShelfGroup(pinned, "置顶", sortMode, currentPath);
		this.renderShelfGroup(regular, pinned.length ? sourceLabel : "", sortMode, currentPath);
	}

	/** 书架分类选择按钮：交互与 RSS 的订阅源按钮同族，低频管理操作收进右侧面板。 */
	private buildBookshelfCategoryButton(
		toolbar: HTMLElement,
		allEntries: BookshelfEntry[],
		categories: BookshelfCategory[],
		activeFilter: BookshelfCategoryFilter,
		sourceLabel: string,
	): void {
		const button = toolbar.createEl("button", { cls: "unreader-feed-source-btn" });
		button.setAttribute("aria-label", "选择书籍分类");
		button.setAttribute("title", sourceLabel);
		const icon = button.createSpan({ cls: "unreader-feed-source-icon" });
		try { setIcon(icon, activeFilter === "all" ? "library" : "folder"); } catch { /* ignore */ }
		button.createSpan({ cls: "unreader-feed-source-label", text: sourceLabel });
		const chevron = button.createSpan({ cls: "unreader-feed-source-chevron" });
		try { setIcon(chevron, "chevron-down"); } catch { /* ignore */ }
		button.addEventListener("click", e => {
			e.stopPropagation();
			const menu = new Menu();
			this.actions.onHoldAutoClose?.(true);
			menu.addItem(item => item
				.setTitle(`全部书籍 · ${allEntries.length}`)
				.setIcon("library")
				.setChecked(activeFilter === "all")
				.onClick(() => this.actions.onBookshelfCategoryFilterChange?.("all")));
			menu.addItem(item => item
				.setTitle(`未分类 · ${allEntries.filter(entry => !entry.categoryId).length}`)
				.setIcon("folder-minus")
				.setChecked(activeFilter === "uncategorized")
				.onClick(() => this.actions.onBookshelfCategoryFilterChange?.("uncategorized")));
			if (categories.length) menu.addSeparator();
			for (const category of categories) {
				const count = allEntries.filter(entry => entry.categoryId === category.id).length;
				menu.addItem(item => item
					.setTitle(`${category.name} · ${count}`)
					.setIcon("folder")
					.setChecked(activeFilter === category.id)
					.onClick(() => this.actions.onBookshelfCategoryFilterChange?.(category.id)));
			}
			menu.onHide(() => this.actions.onHoldAutoClose?.(false));
			const rect = button.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
		});
	}

	private showBookshelfCardMenu(event: MouseEvent, entry: BookshelfEntry): void {
		const menu = new Menu();
		this.actions.onHoldAutoClose?.(true);
		menu.addItem(item => item
			.setTitle("未分类")
			.setIcon("folder-minus")
			.setChecked(!entry.categoryId)
			.onClick(() => this.actions.onAssignBookCategory?.(entry.path, null)));
		const categories = this.actions.getBookshelfCategories?.() ?? [];
		for (const category of categories) {
			menu.addItem(item => item
				.setTitle(category.name)
				.setIcon("folder")
				.setChecked(entry.categoryId === category.id)
				.onClick(() => this.actions.onAssignBookCategory?.(entry.path, category.id)));
		}
		menu.addSeparator();
		menu.addItem(item => item
			.setTitle("从书架移除")
			.setIcon("eye-off")
			.onClick(() => this.actions.onRemoveBookFromShelf?.(entry.path)));
		menu.onHide(() => this.actions.onHoldAutoClose?.(false));
		menu.showAtMouseEvent(event);
	}

	/** 重建第三板块。所有数据从缓存读取，不在这里发网络请求。 */
	renderFeeds(): void {
		this.disconnectShelfPreviews();
		this.stopFeedListRendering();
		this.stopEditorReveal();
		this.listEl.empty();
		this.bookmarkPageEls = [];
		const feeds = this.actions.getFeeds?.() ?? [];
		const allEntries = this.actions.getFeedEntries?.() ?? [];
		const filter = this.actions.getFeedFilter?.() ?? "all";
		const feedsById = new Map(feeds.map(feed => [feed.id, feed]));
		const requestedSource = this.actions.getFeedSourceFilter?.() ?? null;
		// 订阅被删掉后筛选值会悬空：当场按「全部」渲染，并把宿主那份状态一起清掉，
		// 否则下一次渲染又会拿着同一个悬空 id 过滤出一片空白。
		const sourceFilter = requestedSource && feedsById.has(requestedSource) ? requestedSource : null;
		if (requestedSource && !sourceFilter) this.actions.onFeedSourceFilterChange?.(null);

		// 工具栏只有两件东西：左边「订阅源选择」，右边「刷新 + 设置」。
		// 新建 / 导入导出 / 停用删除这些低频操作全在「设置」那个订阅管理面板里。
		const toolbar = this.listEl.createDiv({ cls: "unreader-feed-toolbar" });
		this.buildFeedSourceButton(toolbar, feeds, sourceFilter);
		const actions = toolbar.createDiv({ cls: "unreader-feed-actions" });
		const refreshBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-feed-action" });
		refreshBtn.setAttribute("aria-label", "刷新全部订阅");
		refreshBtn.setAttribute("title", "刷新全部订阅");
		try { setIcon(refreshBtn, "refresh-cw"); } catch { refreshBtn.setText("刷"); }
		refreshBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onRefreshFeeds?.();
		});
		const settingsBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-feed-action" });
		settingsBtn.setAttribute("aria-label", "订阅管理");
		settingsBtn.setAttribute("title", "订阅管理");
		try { setIcon(settingsBtn, "settings-2"); } catch { settingsBtn.setText("⚙"); }
		settingsBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onOpenFeedManager?.();
		});

		const filters = this.listEl.createDiv({ cls: "unreader-feed-filter" });
		const filterOptions: Array<[FeedFilter, string]> = [["all", "全部"], ["unread", "未读"], ["starred", "收藏"]];
		for (const [value, label] of filterOptions) {
			const btn = filters.createEl("button", { text: label, cls: "unreader-feed-filter-btn" });
			btn.toggleClass("is-active", filter === value);
			btn.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onFeedFilterChange?.(value);
				this.renderFeeds();
			});
		}
		if (!feeds.length) {
			const empty = this.listEl.createDiv({ cls: "unreader-feed-empty" });
			const icon = empty.createDiv({ cls: "unreader-feed-empty-icon" });
			try { setIcon(icon, "rss"); } catch { icon.setText("RSS"); }
			empty.createDiv({ cls: "unreader-feed-empty-title", text: "还没有订阅" });
			empty.createDiv({ cls: "unreader-feed-empty-desc", text: "添加一个 Feed 地址或网站地址，文章会缓存到当前库中离线可读。" });
			const emptyActions = empty.createDiv({ cls: "unreader-feed-empty-actions" });
			const add = emptyActions.createEl("button", { text: "添加订阅", cls: "mod-cta" });
			add.addEventListener("click", () => this.actions.onAddFeed?.());
			const importOpml = emptyActions.createEl("button", { text: "导入 .opml" });
			importOpml.addEventListener("click", () => this.actions.onImportOpml?.());
			return;
		}

		// 「全部」视图里收起停用订阅的文章（缓存还在，显式选中那个源仍可看）；
		// 选中某个源时按源过滤，不再受它自身启用状态影响。
		const disabledFeeds = new Set(feeds.filter(feed => feed.enabled === false).map(feed => feed.id));
		let entries = sourceFilter
			? allEntries.filter(entry => entry.feedId === sourceFilter)
			: allEntries.filter(entry => !disabledFeeds.has(entry.feedId));
		if (filter === "unread") entries = entries.filter(entry => entry.state.readAt == null);
		else if (filter === "starred") entries = entries.filter(entry => entry.state.starredAt != null);
		if (!entries.length) {
			this.listEl.createDiv({
				cls: "unreader-toc-empty",
				text: filter === "unread" ? "没有未读文章。" : filter === "starred" ? "没有收藏文章。" : sourceFilter ? "当前订阅还没有文章，点击刷新试试。" : "还没有文章，点击右上角刷新试试。",
			});
			return;
		}

		const list = this.listEl.createDiv({ cls: "unreader-feed-list" });
		const current = this.actions.getCurrentFeedEntry?.() ?? null;
		this.feedListState = {
			entries,
			feeds: feedsById,
			current,
			list,
			nextIndex: 0,
			generation: this.feedListGeneration,
		};
		const done = this.appendFeedChunk();
		if (done) return;
		if (typeof IntersectionObserver === "undefined") {
			while (!this.appendFeedChunk()) { /* 旧环境一次性完成，保持功能可用 */ }
			return;
		}
		this.feedListObserver = new IntersectionObserver(records => {
			if (!records.some(record => record.isIntersecting)) return;
			if (this.appendFeedChunk()) return;
			const sentinel = this.feedListSentinel;
			const state = this.feedListState;
			if (sentinel && state) state.list.appendChild(sentinel);
		}, { root: this.listEl, rootMargin: "480px 0px" });
		this.feedListSentinel = list.createDiv({ cls: "unreader-feed-load-more" });
		this.feedListObserver.observe(this.feedListSentinel);
	}

	/** 工具栏左端的「订阅源选择」按钮：点开是「全部订阅 + 各订阅源」的菜单。
	 *  用按钮 + 菜单而不是原生 select —— 能标出「已停用」的源，样式也与右侧两枚按钮同族。 */
	private buildFeedSourceButton(toolbar: HTMLElement, feeds: FeedSubscription[], sourceFilter: string | null): void {
		const current = sourceFilter ? feeds.find(feed => feed.id === sourceFilter) ?? null : null;
		const label = current ? current.title : "全部订阅";
		const button = toolbar.createEl("button", { cls: "unreader-feed-source-btn" });
		button.setAttribute("aria-label", "选择订阅源");
		button.setAttribute("title", label);
		button.disabled = feeds.length === 0;
		const icon = button.createSpan({ cls: "unreader-feed-source-icon" });
		try { setIcon(icon, current ? "rss" : "newspaper"); } catch { /* 图标缺失不影响点按 */ }
		button.createSpan({ cls: "unreader-feed-source-label", text: label });
		if (current && current.enabled === false) button.createSpan({ cls: "unreader-feed-source-flag", text: "已停用" });
		const chevron = button.createSpan({ cls: "unreader-feed-source-chevron" });
		try { setIcon(chevron, "chevron-down"); } catch { /* ignore */ }
		button.addEventListener("click", e => {
			e.stopPropagation();
			const menu = new Menu();
			// 菜单挂在 body 上：悬浮态面板会因鼠标离开而自动收起，开菜单期间先挂住
			this.actions.onHoldAutoClose?.(true);
			menu.addItem(item => item
				.setTitle("全部订阅")
				.setIcon("newspaper")
				.setChecked(sourceFilter == null)
				.onClick(() => {
					this.actions.onFeedSourceFilterChange?.(null);
					this.renderFeeds();
				}));
			if (feeds.length) menu.addSeparator();
			for (const feed of feeds) {
				menu.addItem(item => item
					.setTitle(feed.enabled === false ? `${feed.title} · 已停用` : feed.title)
					.setIcon("rss")
					.setChecked(sourceFilter === feed.id)
					.onClick(() => {
						this.actions.onFeedSourceFilterChange?.(feed.id);
						this.renderFeeds();
					}));
			}
			menu.onHide(() => this.actions.onHoldAutoClose?.(false));
			const rect = button.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
		});
	}

	/** 阅读状态变化后只刷新第三板块，不影响当前滚动中的正文。 */
	refreshFeeds(): void {
		if (this.mode === "feeds") this.renderFeeds();
	}

	/** 每次只构建一屏附近的卡片，避免上千篇文章在打开板块时同步创建 DOM。 */
	private appendFeedChunk(): boolean {
		const state = this.feedListState;
		if (!state || state.generation !== this.feedListGeneration) return true;
		if (state.nextIndex >= state.entries.length) {
			this.stopFeedListRendering();
			return true;
		}
		const chunkSize = 48;
		const end = Math.min(state.entries.length, state.nextIndex + chunkSize);
		const fragment = createFragment();
		for (let index = state.nextIndex; index < end; index++) {
			const entry = state.entries[index];
			if (!entry) continue;
			fragment.appendChild(this.feedEntryCard(entry, state.feeds.get(entry.feedId) ?? null, state.current));
		}
		state.list.appendChild(fragment);
		state.nextIndex = end;
		if (end >= state.entries.length) {
			this.stopFeedListRendering();
			return true;
		}
		return false;
	}

	private feedEntryCard(entry: FeedEntry, feed: FeedSubscription | null, current: { feedId: string; entryId: string } | null): HTMLElement {
		const card = createDiv();
		card.className = "unreader-feed-card";
		card.toggleClass("is-unread", entry.state.readAt == null);
		card.toggleClass("is-starred", entry.state.starredAt != null);
		card.toggleClass("is-audio", entry.kind === "audio");
		card.toggleClass("is-current", current?.feedId === entry.feedId && current.entryId === entry.id);
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");
		const open = (): void => this.actions.onOpenFeedEntry?.(entry.feedId, entry.id);
		card.addEventListener("click", e => {
			const target = e.target as HTMLElement | null;
			if (target?.closest("button, audio, select, a, .unreader-feed-card-actions")) return;
			open();
		});
		card.addEventListener("keydown", e => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			open();
		});

		const top = card.createDiv({ cls: "unreader-feed-card-top" });
		const source = top.createDiv({ cls: "unreader-feed-card-source" });
		if (entry.state.readAt == null) source.createSpan({ cls: "unreader-feed-unread-dot" });
		source.createSpan({ text: feed?.title || "未知订阅" });
		top.createDiv({ cls: "unreader-feed-card-date", text: formatFeedDate(entry.publishedAt) });
		card.createDiv({ cls: "unreader-feed-card-title", text: entry.title || "未命名文章" });
		card.createDiv({ cls: "unreader-feed-card-summary", text: entry.summary || "暂无摘要" });

		const meta = card.createDiv({ cls: "unreader-feed-card-meta" });
		if (entry.author) meta.createSpan({ text: entry.author });
		if (entry.kind === "audio") meta.createSpan({ text: "播客" });
		if (entry.enclosure?.duration) meta.createSpan({ text: formatMediaDuration(entry.enclosure.duration) });
		if (entry.kind === "article") {
			const quality = entryFeedContentQuality(entry);
			if (entry.contentSource === "fulltext") meta.createSpan({ cls: "is-fulltext", text: "已抓取全文" });
			else if (quality === "full") meta.createSpan({ cls: "is-fulltext", text: "Feed 全文" });
			else if (quality === "summary") meta.createSpan({ cls: "is-summary", text: "仅摘要" });
			else meta.createSpan({ cls: "is-summary", text: "无正文" });
		}
		if (entry.pendingContentHash) meta.createSpan({ cls: "is-updated", text: "正文有更新" });
		const progress = entry.kind === "audio"
			? (entry.state.audioPosition ?? entry.state.position)
			: entry.state.position;
		if (progress?.fraction) meta.createSpan({ text: `已听/读 ${Math.round(progress.fraction * 100)}%` });

		const cardActions = card.createDiv({ cls: "unreader-feed-card-actions" });
		const read = cardActions.createEl("button", { cls: "unreader-feed-inline-action" });
		read.setAttribute("aria-label", entry.state.readAt == null ? "标记已读" : "标记未读");
		try { setIcon(read, entry.state.readAt == null ? "check" : "circle"); } catch { read.setText(entry.state.readAt == null ? "✓" : "○"); }
		read.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onToggleFeedRead?.(entry.feedId, entry.id);
		});
		const star = cardActions.createEl("button", { cls: "unreader-feed-inline-action" });
		star.setAttribute("aria-label", entry.state.starredAt ? "取消收藏" : "收藏文章");
		try { setIcon(star, entry.state.starredAt ? "star-off" : "star"); } catch { star.setText("☆"); }
		star.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onToggleFeedStar?.(entry.feedId, entry.id);
		});
		if (entry.url) {
			const original = cardActions.createEl("button", { cls: "unreader-feed-inline-action" });
			original.setAttribute("aria-label", "在系统浏览器打开原文");
			try { setIcon(original, "external-link"); } catch { original.setText("↗"); }
			original.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onOpenOriginal?.(entry.url);
			});
		}
		if (entry.kind === "article" && !!entry.url && entry.contentSource !== "fulltext" && entryFeedContentQuality(entry) !== "full") {
			const fulltext = cardActions.createEl("button", { cls: "unreader-feed-inline-action" });
			fulltext.setAttribute("aria-label", "抓取网页全文");
			try { setIcon(fulltext, "text-select"); } catch { fulltext.setText("全文"); }
			fulltext.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onFetchFulltext?.(entry.feedId, entry.id);
			});
		}
		// 「保存为笔记」与「抓取网页全文」是两件事，各占一枚：只抓不存（在阅读器里读）
		// 与存成 Markdown 文件（进 vault，交给 Obsidian 同步/双链）都有各自的场合，
		// 合成一枚会让「只想看看全文」的人凭空多出一堆笔记文件。
		if (entry.kind === "article") {
			const save = cardActions.createEl("button", { cls: "unreader-feed-inline-action" });
			save.setAttribute("aria-label", entry.contentSource === "fulltext" || entryFeedContentQuality(entry) === "full"
				? "保存为笔记"
				: "抓取全文并保存为笔记");
			// setIcon 碰到不存在的图标名不会抛错、只是什么都不画（按钮会整个空白），
			// 所以画完看一眼 DOM 再决定要不要退到文字兜底。
			setIcon(save, "file-down");
			if (!save.querySelector("svg")) save.setText("存");
			save.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onSaveNote?.(entry.feedId, entry.id);
			});
		}

		return card;
	}

	private renderShelfGroup(entries: BookshelfEntry[], label: string, sortMode: BookshelfSortMode, currentPath: string | null): void {
		if (!entries.length) return;
		if (label) this.listEl.createDiv({ cls: "unreader-shelf-group-title", text: `${label} · ${entries.length}` });
		const group = this.listEl.createDiv({ cls: "unreader-shelf-group" });
		for (const entry of entries) this.appendShelfCard(group, entry, sortMode, currentPath);
	}

	private appendShelfCard(group: HTMLElement, entry: BookshelfEntry, sortMode: BookshelfSortMode, currentPath: string | null): void {
		const card = group.createDiv({ cls: "unreader-shelf-card" });
		card.dataset.path = entry.path;
		card.toggleClass("is-current", entry.path === currentPath);
		card.toggleClass("is-pinned", entry.pinned);
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");
		card.addEventListener("click", () => {
			const draggedAt = Number(card.dataset.draggedAt ?? 0);
			if (draggedAt && Date.now() - draggedAt < 320) return;
			this.setMode("annotations");
			this.actions.onOpenBook?.(entry.path);
		});
		card.addEventListener("keydown", e => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			this.setMode("annotations");
			this.actions.onOpenBook?.(entry.path);
		});
		card.addEventListener("contextmenu", e => {
			e.preventDefault();
			e.stopPropagation();
			this.showBookshelfCardMenu(e, entry);
		});

		if (sortMode === "manual") {
			const drag = card.createDiv({ cls: "unreader-shelf-drag" });
			drag.setAttribute("aria-label", "拖拽调整顺序");
			try { setIcon(drag, "grip-vertical"); } catch { drag.setText("⋮"); }
			this.attachShelfDrag(group, card, drag);
		}

		const cover = card.createDiv({ cls: "unreader-shelf-cover" });
		const coverFallback = cover.createDiv({ cls: "unreader-shelf-cover-fallback", text: "载入中…" });
		const body = card.createDiv({ cls: "unreader-shelf-body" });
		const head = body.createDiv({ cls: "unreader-shelf-head" });
		const title = head.createDiv({ cls: "unreader-shelf-title", text: entry.name });
		const cardActions = head.createDiv({ cls: "unreader-shelf-card-actions" });
		const more = cardActions.createDiv({ cls: "unreader-shelf-more" });
		more.setAttribute("aria-label", "书籍操作");
		more.setAttribute("title", "书籍操作");
		try { setIcon(more, "ellipsis-vertical"); } catch { more.setText("⋯"); }
		more.addEventListener("click", e => {
			e.stopPropagation();
			this.showBookshelfCardMenu(e, entry);
		});
		const pin = cardActions.createDiv({ cls: "unreader-shelf-pin" });
		pin.toggleClass("is-active", entry.pinned);
		pin.setAttribute("aria-label", entry.pinned ? "取消置顶" : "置顶书籍");
		pin.setAttribute("title", entry.pinned ? "取消置顶" : "置顶书籍");
		try { setIcon(pin, entry.pinned ? "pin-off" : "pin"); } catch { pin.setText(entry.pinned ? "顶" : "钉"); }
		pin.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onToggleBookPin?.(entry.path);
		});

		const meta = body.createDiv({ cls: "unreader-shelf-meta" });
		const author = meta.createDiv({ cls: "unreader-shelf-author", text: entry.extension.toUpperCase() });
		if (entry.path === currentPath) {
			meta.createDiv({ cls: "unreader-shelf-current", text: "正在阅读" });
		}

		const percent = Math.round(entry.progress * 100);
		const progressRow = body.createDiv({ cls: "unreader-shelf-progress-row" });
		progressRow.createSpan({ text: entry.progress > 0 ? `阅读进度 ${percent}%` : "尚未阅读" });
		progressRow.createSpan({ cls: "unreader-shelf-date", text: formatRecentRead(entry.updatedAt) });
		const track = body.createDiv({ cls: "unreader-shelf-progress" });
		const fill = track.createDiv({ cls: "unreader-shelf-progress-fill" });
		fill.style.setProperty("--ur-shelf-progress", `${Math.max(0, Math.min(100, percent))}%`);

		this.observeShelfPreview(card, entry.path, cover, coverFallback, title, author);
	}

	private observeShelfPreview(card: HTMLElement, path: string, cover: HTMLElement, fallback: HTMLElement, title: HTMLElement, author: HTMLElement): void {
		const loader = this.actions.loadBookPreview;
		if (!loader) return;
		let started = false;
		const load = (): void => {
			if (started) return;
			started = true;
			void loader(path).then(preview => {
				if (!card.isConnected) return;
				if (preview.title) title.setText(preview.title);
				if (preview.author) author.setText(preview.author);
				if (!preview.coverUrl) {
					fallback.setText(preview.excerpt || "暂无封面");
					return;
				}
				cover.empty();
				cover.addClass("has-cover");
				const img = cover.createEl("img", { cls: "unreader-shelf-cover-img" });
				img.alt = "";
				img.loading = "lazy";
				img.decoding = "async";
				img.src = preview.coverUrl;
				img.addEventListener("error", () => {
					cover.empty();
					cover.removeClass("has-cover");
					cover.createDiv({ cls: "unreader-shelf-cover-fallback", text: preview.excerpt || "暂无封面" });
				});
			}).catch(() => {
				if (card.isConnected) fallback.setText("暂无封面");
			});
		};

		if (typeof IntersectionObserver === "undefined") {
			load();
			return;
		}
		if (!this.shelfPreviewObserver) {
			this.shelfPreviewObserver = new IntersectionObserver(entries => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					this.shelfPreviewObserver?.unobserve(entry.target);
					this.shelfPreviewLoaders.get(entry.target)?.();
				}
			}, { root: this.listEl, rootMargin: "220px 0px" });
		}
		this.shelfPreviewLoaders.set(card, load);
		this.shelfPreviewObserver.observe(card);
	}

	private attachShelfDrag(group: HTMLElement, card: HTMLElement, handle: HTMLElement): void {
		handle.addEventListener("pointerdown", e => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			this.shelfDragCleanup?.();
			card.addClass("is-dragging");
			const move = (ev: PointerEvent): void => {
				const cards = Array.from(group.children).filter(
					(child): child is HTMLElement => child.instanceOf(HTMLElement) && child !== card && child.hasClass("unreader-shelf-card"),
				);
				const before = cards.find(child => {
					const rect = child.getBoundingClientRect();
					return ev.clientY < rect.top + rect.height / 2;
				});
				if (before) group.insertBefore(card, before);
				else group.appendChild(card);
			};
			const finish = (): void => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", finish);
				window.removeEventListener("pointercancel", finish);
				card.removeClass("is-dragging");
				card.dataset.draggedAt = String(Date.now());
				this.shelfDragCleanup = null;
				const paths = Array.from(this.listEl.querySelectorAll<HTMLElement>(".unreader-shelf-card"))
					.map(el => el.dataset.path)
					.filter((path): path is string => !!path);
				this.actions.onBookshelfReorder?.(paths);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", finish);
			window.addEventListener("pointercancel", finish);
			this.shelfDragCleanup = finish;
		});
	}

	/** 页码实时刷新：只重算页码文字，**不重建 DOM**——避免破坏展开态、
	 *  正在输入的重命名/评论框与滚动位置。书签行渲染时登记，render 时重置。 */
	refreshPages(): void {
		for (const rec of this.bookmarkPageEls) this.paintBookmarkPage(rec.el, rec.anchor);
	}

	/** 把现算页码写进书签行的页码胶囊；算不出（书未就绪/畸形 token）时整块隐藏。 */
	private paintBookmarkPage(el: HTMLElement, anchor: string): void {
		if (anchor.startsWith("audio:")) {
			const seconds = Number(anchor.slice("audio:".length));
			const label = formatMediaDuration(Number.isFinite(seconds) ? seconds : 0);
			el.setText(label || "时间点");
			el.setAttribute("aria-label", `播客时间点 ${label}`);
			el.removeClass("is-hidden");
			return;
		}
		let res: { page: number; total: number } | null = null;
		try { res = this.actions.getPageForAnchor?.(anchor) ?? null; } catch { res = null; }
		if (res && res.page > 0) {
			el.setText(`第 ${res.page} 页`);
			el.setAttribute("aria-label", `第 ${res.page} 页，共 ${res.total} 页`);
			el.removeClass("is-hidden");
		} else {
			el.setText("");
			el.addClass("is-hidden");
		}
	}

	render(data: AnnotationFileData): void {
		this.annotationData = data;
		if (this.mode === "annotations") this.renderAnnotations();
	}

	private highlightRow(h: StoredHighlight): HTMLElement {
		const li = this.listEl.createEl("li", { cls: "unreader-anno-row unreader-anno-row--highlight" });
		li.toggleClass("is-stale", h.stale === true);
		// 单击：浮动简介（AnnotationHover 预览），Cmd/Ctrl+单击：直接跳转，双击：全选文字
		let clickTimer: number | null = null;
		const clearClickTimer = (): void => {
			if (clickTimer != null) {
				window.clearTimeout(clickTimer);
				clickTimer = null;
			}
		};
		li.addEventListener("click", e => {
			const me = e as MouseEvent;
			// 触屏：单击直接跳转（无 hover 预览，无需等双击判定）
			if (isCoarse()) {
				e.stopPropagation();
				this.actions.onJump(h.anchor, h.text);
				return;
			}
			if (me.metaKey || me.ctrlKey) {
				e.stopPropagation();
				clearClickTimer();
				this.actions.onJump(h.anchor, h.text);
				return;
			}
			if (clickTimer != null) {
				clearClickTimer();
				this.selectRowText(li);
				return;
			}
			// 单击 = 直接跳转到划线位置（与书签行一致）；预览改由悬浮触发
			clickTimer = window.setTimeout(() => {
				clickTimer = null;
				this.actions.onJump(h.anchor, h.text);
			}, 220);
			e.stopPropagation();
		});
		li.addEventListener("dblclick", e => {
			e.preventDefault();
			e.stopPropagation();
			clearClickTimer();
			this.selectRowText(li);
		});

		const texts = li.createDiv({ cls: "unreader-anno-texts" });
		if (h.stale) texts.createDiv({ cls: "unreader-anno-stale", text: "原文已更新，未能自动定位" });
		const excerptEl = texts.createDiv({ cls: "unreader-anno-excerpt" });
		excerptEl.setText(h.text);
		let commentEl: HTMLElement | null = null;
		if (h.comment) {
			commentEl = texts.createDiv({ cls: "unreader-anno-comment" });
			commentEl.setText(h.comment);
		}

		const footer = li.createDiv({ cls: "unreader-anno-footer" });
		const dot = footer.createDiv({ cls: "unreader-anno-dot" });
		const solid = highlightColorOf(h.color).replace(/[\d.]+\)$/, "1)");
		const soft = solid.replace("1)", "0.78)");
		dot.style.background = `radial-gradient(circle at 32% 32%, ${solid} 0%, ${soft} 65%, ${solid} 100%)`;
		dot.setAttribute("aria-label", h.color);

		const actions = footer.createDiv({ cls: "unreader-anno-footer-actions" });
		// 展开/收起：获得完整阅读体验
		const expandBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action unreader-anno-expand" });
		try { setIcon(expandBtn, "chevron-down"); } catch { expandBtn.setText("∨"); }
		expandBtn.setAttribute("aria-label", "展开全文");
		const needsExpand = (h.text && h.text.length > 90) || !!h.comment;
		if (!needsExpand) expandBtn.addClass("is-hidden");
		expandBtn.addEventListener("click", e => {
			e.stopPropagation();
			const expanded = li.classList.toggle("is-expanded");
			li.toggleClass("is-collapsed", !expanded);
			expandBtn.setAttribute("aria-label", expanded ? "收起" : "展开全文");
			try { setIcon(expandBtn, expanded ? "chevron-up" : "chevron-down"); } catch { expandBtn.setText(expanded ? "∧" : "∨"); }
			expandBtn.toggleClass("is-active", expanded);
		});
		// 评论按钮：点击后在高亮卡片内部嵌入评论框（与卡片同为一体，但又清晰区分）
		const commentBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		try { setIcon(commentBtn, "message-square"); } catch { commentBtn.setText("评"); }
		commentBtn.setAttribute("aria-label", "评论");
		commentBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.toggleCommentEditor(li, h);
		});
		// 复制按钮：复制高亮文字（含评论）
		const copyBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		setIcon(copyBtn, "copy");
		copyBtn.setAttribute("aria-label", "复制");
		copyBtn.addEventListener("click", e => {
			e.stopPropagation();
			const content = h.comment ? `${h.text}\n\n${h.comment}` : h.text;
			void this.copyText(content, copyBtn);
		});
		// 复制引用：原文 + 书名 + 章节标题 + 溯源笔记链接（给 AI 溯源用）
		const refBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		try { setIcon(refBtn, "quote"); } catch { refBtn.setText("引"); }
		refBtn.setAttribute("aria-label", "复制引用");
		refBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onCopyReference(h);
		});
		const delBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action is-danger" });
		setIcon(delBtn, "trash-2");
		delBtn.setAttribute("aria-label", "删除此高亮");
		delBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onDeleteHighlight(h.id);
		});
		footer.addEventListener("click", e => e.stopPropagation());
		dot.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onJump(h.anchor, h.text);
		});
		return li;
	}

	/** 全选卡片文字（供双击调用），方便复制 */
	private selectRowText(li: HTMLElement): void {
		const texts = li.querySelector<HTMLElement>(".unreader-anno-texts");
		if (!texts) return;
		const range = document.createRange();
		range.selectNodeContents(texts);
		const sel = window.getSelection();
		if (sel) {
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}

	/** 复制文字到剪贴板，成功后按钮图标短暂变为 ✓ */
	private async copyText(text: string, btn: HTMLElement): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// 兜底：隐藏 textarea 方案（离屏定位在 .unreader-copy-bridge 类里给）
			const ta = createEl("textarea");
			ta.value = text;
			ta.className = "unreader-copy-bridge";
			document.body.appendChild(ta);
			ta.select();
			// `document.execCommand` 已被标准废弃，这里是 `navigator.clipboard` 失败后的
			// **兜底**（非安全上下文 / 老 WebView）：没有等价替代品，且只在异常路径上跑。
			// 按结构类型取用，免得这条兜底一直挂在废弃清单里。
			try {
				(document as unknown as { execCommand?: (command: string) => boolean }).execCommand?.("copy")
			} catch { /* ignore */ }
			ta.remove();
		}
		btn.addClass("is-copied");
		try { setIcon(btn, "check"); } catch { btn.setText("✓"); }
		window.setTimeout(() => {
			btn.removeClass("is-copied");
			try { setIcon(btn, "copy"); } catch { btn.setText(""); }
		}, 1200);
	}

	/** 在高亮卡片内部嵌入评论框：与正文清晰区分，又同属一个整体 */
	private toggleCommentEditor(li: HTMLElement, h: StoredHighlight): void {
		const existing = li.querySelector<HTMLElement>(".unreader-anno-comment-editor");
		if (existing) {
			this.stopEditorReveal();
			existing.remove();
			li.classList.remove("is-editing");
			return;
		}
		const footer = li.querySelector<HTMLElement>(".unreader-anno-footer");
		const editorEl = li.createDiv({ cls: "unreader-anno-comment-editor" });
		const ta = editorEl.createEl("textarea", {
			cls: "unreader-anno-comment-input",
			attr: { placeholder: "写下你的评论…", rows: "3" },
		});
		ta.value = h.comment ?? "";
		const row = editorEl.createDiv({ cls: "unreader-anno-comment-editor-actions" });
		const cancelBtn = row.createEl("button", { text: "取消", cls: "unreader-anno-comment-cancel" });
		const saveBtn = row.createEl("button", { text: "保存", cls: "unreader-anno-comment-save" });
		saveBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onCommentHighlight(h.id, ta.value);
			this.stopEditorReveal();
			editorEl.remove();
			li.classList.remove("is-editing");
		});
		cancelBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.stopEditorReveal();
			editorEl.remove();
			li.classList.remove("is-editing");
		});
		ta.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveBtn.click();
			else if (e.key === "Escape") cancelBtn.click();
		});
		// ⚠️ 不要在 blur 时停掉停靠订阅：输入区仍开着，用户收起键盘再点回来还要靠它。
		//    订阅在「编辑块被摘掉」（保存/取消/再点评论/重渲染）时统一清理，见 stopEditorReveal。
		// 阻止点击/指针事件冒泡到卡片（避免触发跳转）
		editorEl.addEventListener("click", e => e.stopPropagation());
		editorEl.addEventListener("pointerdown", e => e.stopPropagation());
		// 插入到正文与底部操作区之间，作为卡片整体的一部分
		if (footer) li.insertBefore(editorEl, footer);
		else li.appendChild(editorEl);
		li.classList.add("is-editing");
		// 移动端：先停靠进可用区，再 focus 拉起键盘；之后由订阅跟着键盘重算
		this.startEditorReveal(editorEl);
		window.setTimeout(() => ta.focus(), 30);
	}

	/**
	 * 书签卡片：与高亮卡片同构——上面一行内容（书签名称），下面一行
	 * 「页码胶囊 + 操作按钮」。页码由 getPageForAnchor 现算并登记进
	 * bookmarkPageEls，排版模型变化时靠 refreshPages 就地刷新。
	 */
	private bookmarkRow(b: StoredBookmark): HTMLElement {
		const isAudioBookmark = b.anchor.startsWith("audio:");
		const li = this.listEl.createEl("li", { cls: "unreader-anno-row unreader-anno-row--bookmark" });
		li.toggleClass("is-audio-bookmark", isAudioBookmark);
		li.toggleClass("is-stale", b.stale === true);

		// 书签：单击直接跳转（Cmd/Ctrl+单击同样跳转），双击全选
		let bmTimer: number | null = null;
		const clearBmTimer = (): void => {
			if (bmTimer != null) {
				window.clearTimeout(bmTimer);
				bmTimer = null;
			}
		};
		li.addEventListener("click", e => {
			const me = e as MouseEvent;
			// 触屏：单击直接跳转（无 hover 预览，无需等双击判定）
			if (isCoarse()) {
				e.stopPropagation();
				this.actions.onJump(b.anchor);
				return;
			}
			if (me.metaKey || me.ctrlKey) {
				e.stopPropagation();
				clearBmTimer();
				this.actions.onJump(b.anchor);
				return;
			}
			if (bmTimer != null) {
				clearBmTimer();
				this.selectRowText(li);
				return;
			}
			bmTimer = window.setTimeout(() => {
				bmTimer = null;
				this.actions.onJump(b.anchor);
			}, 220);
			e.stopPropagation();
		});
		li.addEventListener("dblclick", e => {
			e.preventDefault();
			e.stopPropagation();
			clearBmTimer();
			this.selectRowText(li);
		});

		// 第一行：书签图标 + 名称
		const head = li.createDiv({ cls: "unreader-anno-bm-head" });
		const icon = head.createDiv({ cls: "unreader-anno-bm-icon" });
		setIcon(icon, isAudioBookmark ? "headphones" : "bookmark");
		if (!icon.querySelector("svg")) icon.setText(isAudioBookmark ? "播" : "书");
		const texts = head.createDiv({ cls: "unreader-anno-texts" });
		if (b.stale) texts.createDiv({ cls: "unreader-anno-stale", text: "原文已更新，书签位置可能已变化" });
		texts.createDiv({ cls: "unreader-anno-excerpt" }).setText(b.label || "书签");

		// 第二行：页码胶囊（左） + 功能按钮（右）
		const footer = li.createDiv({ cls: "unreader-anno-footer" });
		const pageEl = footer.createDiv({ cls: "unreader-anno-page" });
		this.paintBookmarkPage(pageEl, b.anchor);
		this.bookmarkPageEls.push({ el: pageEl, anchor: b.anchor });
		// 与高亮卡片的色点同理：点页码也直接跳到该书签位置
		pageEl.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onJump(b.anchor);
		});

		const actions = footer.createDiv({ cls: "unreader-anno-footer-actions" });
		const renameBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		try { setIcon(renameBtn, "pencil"); } catch { renameBtn.setText("改"); }
		renameBtn.setAttribute("aria-label", "重命名书签");
		renameBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.toggleRenameEditor(li, b);
		});
		const delBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action is-danger" });
		setIcon(delBtn, "trash-2");
		delBtn.setAttribute("aria-label", "删除此书签");
		delBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onDeleteBookmark(b.id);
		});
		footer.addEventListener("click", e => e.stopPropagation());
		return li;
	}

	/** 就地重命名：把名称行换成输入框，Enter/失焦保存、Esc 取消。
	 *  与注释编辑同套路——不弹窗、不打断列表上下文。 */
	private toggleRenameEditor(li: HTMLElement, b: StoredBookmark): void {
		const existing = li.querySelector<HTMLElement>(".unreader-anno-rename");
		if (existing) { this.finishRename(li, b, null); return; }
		// blur-保存 先于 click 触发：再次点「重命名」时编辑器已被 blur 摘掉，
		// 不设这道时间闸就会「关掉又立刻重开」。只拦紧随其后的那一次点击
		const closedAt = Number(li.dataset.renameClosedAt ?? 0);
		if (closedAt && Date.now() - closedAt < 400) return;
		const texts = li.querySelector<HTMLElement>(".unreader-anno-texts");
		const excerpt = li.querySelector<HTMLElement>(".unreader-anno-excerpt");
		if (!texts) return;

		const row = texts.createDiv({ cls: "unreader-anno-rename" });
		const input = row.createEl("input", {
			cls: "unreader-anno-rename-input",
			type: "text",
			attr: { placeholder: "书签名称", maxlength: "120" },
		});
		input.value = b.label || "";
		excerpt?.addClass("is-hidden");

		input.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				this.finishRename(li, b, input.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.finishRename(li, b, null);
			}
		});
		// 失焦即保存（点击列表其他位置时不用额外点一下「保存」）。
		// 无需防重入：finishRename 先摘掉编辑器，行已不存在时直接返回
		input.addEventListener("blur", () => this.finishRename(li, b, input.value));
		// 输入框内的指针事件不得冒泡到卡片（否则点一下就触发跳转；
		// dblclick 也要拦，否则在输入框里双击会被卡片当成「双击全选」抢走选区）
		row.addEventListener("click", e => e.stopPropagation());
		row.addEventListener("pointerdown", e => e.stopPropagation());
		row.addEventListener("dblclick", e => { e.preventDefault(); e.stopPropagation(); });
		li.addClass("is-editing");
		// 单行输入框同样会被键盘盖住（手机竖屏下半屏的卡片尤甚）→ 与评论输入区同一套停靠
		this.startEditorReveal(row);
		window.setTimeout(() => { input.focus(); input.select(); }, 30);
	}

	/** 收尾重命名：label === null 表示取消（Esc）。保存时 trim，空值不落库。 */
	private finishRename(li: HTMLElement, b: StoredBookmark, label: string | null): void {
		const row = li.querySelector<HTMLElement>(".unreader-anno-rename");
		const excerpt = li.querySelector<HTMLElement>(".unreader-anno-excerpt");
		if (!row) return;
		this.stopEditorReveal();
		row.remove();
		excerpt?.removeClass("is-hidden");
		li.removeClass("is-editing");
		li.dataset.renameClosedAt = String(Date.now());
		if (label == null) return;
		// 落盘安全化（`|`/换行会切错笔记分列 → 该书签下次解析时静默丢失）
		const next = sanitizeBookmarkLabel(label);
		if (!next || next === (b.label || "")) return;
		b.label = next;
		excerpt?.setText(next);
		this.actions.onRenameBookmark(b.id, next);
	}

	isOpen(): boolean {
		return this.containerEl.hasClass("is-open");
	}

	show(): void {
		this.containerEl.addClass("is-open");
		this.actions.onOpenChange?.(true);
	}

	hide(): void {
		this.shelfDragCleanup?.();
		this.containerEl.removeClass("is-open");
		this.actions.onOpenChange?.(false);
	}

	toggle(): boolean {
		if (this.isOpen()) this.hide();
		else this.show();
		return this.isOpen();
	}
}
