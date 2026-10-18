import { Menu, setIcon } from "obsidian";

/** 侧边栏设定高度时的两条行内样式（提常量以过 no-static-styles-assignment）。 */
const ANNO_HEIGHT_ALIGN_SELF = "flex-start";
const ANNO_HEIGHT_BOTTOM = "auto";
import type { AnnotationFileData, StoredHighlight, StoredBookmark } from "../core/annotationStore";
import { sanitizeBookmarkLabel } from "../core/annotationStore";
import { highlightColorOf } from "../types";
import { resolveAppearance, ensureHostCustomFont } from "../core/engineAdapter";
import type { AppearanceSettings, BookshelfCategory, BookshelfCategoryFilter, BookshelfEntry, BookshelfSortMode, FeedEntry, FeedEntryKind, FeedFilter, FeedSubscription, MarkdownNoteListItem } from "../types";
import type { BookPreview } from "../core/bookPreview";
import { subscribeKeyboardGeometry, usableBottom } from "./keyboardInset";
import { entryFeedContentQuality } from "../core/feedContentQuality";
import { canSaveFeedEntry } from "../core/feedUtils";
import { disposeMarkdownNotesLayout, formatRecentRead, markdownNoteSignature, refreshMarkdownNotesLayout, renderMarkdownNotes, resettleStarredGroupHeight } from "./markdownNoteCards";
import { CardThumbObserver, mountCardThumb, showCardThumb, type CardThumb } from "./cardThumb";
import { createProgressRing } from "./progressRing";
import { attachCardDetails, hideCardDetails, type CardDetailRow, type CardDetailSection, type CardDetailsContent } from "./cardDetailsPopover";
import { bookStatKey, feedStatKey, formatReadingDuration, getReadingStat } from "../core/readingStatsStore";
import { adjustNativeSidebarScrollTop } from "../core/nativeSidebarState";
import { createCardActionButton } from "./cardActions";

type PanelMode = "annotations" | "bookshelf" | "feeds" | "notes";

interface PanelScrollPosition {
	scrollTop: number
	anchorKey: string | null
	anchorOffset: number
}

interface StableCardSnapshot {
	cards: Map<string, HTMLElement>
	scroll: PanelScrollPosition
	focusedKey: string | null
	focusedClasses: string[]
}

const CARD_SELECTOR = ".unreader-shelf-card,.unreader-feed-card,.unreader-note-card";
const cardRenderSignatures = new WeakMap<HTMLElement, string>();

export interface AnnotationsPanelActions {
	onJump: (cfi: string, textHint?: string, contextKey?: string | null) => void
	onPreviewHighlight: (item: StoredHighlight, anchorEl: HTMLElement, contextKey?: string | null) => void
	onCommentHighlight: (id: number, comment: string, contextKey?: string | null) => void
	onCopyReference: (item: StoredHighlight, contextKey?: string | null) => void
	onDeleteHighlight: (id: number, contextKey?: string | null) => void
	onDeleteBookmark: (id: number, contextKey?: string | null) => void
	/** 重命名书签（label 已 trim 且非空时才会被调用） */
	onRenameBookmark: (id: number, label: string, contextKey?: string | null) => void
	/** 位置 token → 全书页码。每次渲染/刷新现算，不缓存、不落盘；
	 *  排版模型变化后页码自动跟随（见 AnnotationsPanel.refreshPages） */
	getPageForAnchor?: (anchor: string, contextKey?: string | null) => { page: number; total: number } | null
	/** 高亮评论能力位：不给 = 支持（书 / RSS 旁车笔记）；显式返回 false = 本宿主
	 *  没有评论落点（如 markdown 笔记的官方 `==` 高亮），卡片上不渲染评论按钮。 */
	isCommentEnabled?: () => boolean
	/** 标注数据「现算」供给：markdown 笔记的官方高亮没有旁车文件，给了它之后，
	 *  面板在打开 / 切到标注页时会先调用它重取数据再渲染，避免列表过期。 */
	provideAnnotationData?: () => AnnotationFileData
	getAnnotationContextKey?: () => string | null
	/** 高亮页头部「← 返回列表」：**不离开当前书/文章**，只把抽屉切回来源选内容层
	 *  （书架/订阅）。不给 = 不显示返回钮（md 宿主）。 */
	onRequestHome?: () => void
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
	onOpenCardAnnotations?: (key: string) => void
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
	onOpenBookAnnotations?: (path: string) => void
	/** 只展示这几页（缺省 = 四页全开）。由 `sidePanels.ts` 的共享接线传入 ——
	 *  宿主给不出某页所需上下文时，那一页**整个不出现在界面里**，不留死按钮。 */
	modes?: PanelMode[]
	/** 「笔记」页只读当前 vault 的最近阅读 / 置顶索引；不开放全库笔记扫描。 */
	getMarkdownNotes?: () => { recent: MarkdownNoteListItem[]; starred: MarkdownNoteListItem[] }
	onOpenMarkdownNote?: (path: string) => void
	onOpenMarkdownAnnotations?: (path: string) => void
	onOpenFeedAnnotations?: (feedId: string, entryId: string) => void
	onFeedContextMenu?: (feedId: string, entryId: string, event: MouseEvent) => void
	onFileContextMenu?: (path: string, event: MouseEvent, kind: "markdown" | "book") => void
	onToggleMarkdownNotePin?: (path: string) => void
	/** 在文件浏览器里定位到这篇笔记（`app.showInFolder`）。不给 = 笔记卡不渲染那枚按钮。 */
	onRevealMarkdownNote?: (path: string) => void
	/** 笔记卡的字数供给（读盘统计后回填底栏）。不给 = 字数位显示占位符。 */
	resolveNoteWordCount?: (path: string) => Promise<number | null>
	/** 笔记卡的正文预览供给（Markdown 源片段）。不给 = 卡片不留预览行。 */
	resolveNoteExcerpt?: (path: string) => Promise<string | null>
	/** 笔记卡预览的渲染器（真机 = `MarkdownRenderer.render(app, md, el, path, component)`）。
	 *  不给 = 预览退化成纯文本（语法符号会露出来，只作兜底）。 */
	renderNoteMarkdown?: (el: HTMLElement, markdown: string, sourcePath: string) => void | Promise<void>
	loadBookPreview?: (path: string) => Promise<BookPreview>
	/** 订阅卡缩略图供给：返回可直接塞进 `<img src>` 的地址（blob:），null = 这张卡没有图。
	 *  **不给就整个不做缩略图** —— 面板自己绝不直连远程图，网络请求必须来自宿主的受控通道
	 *  （`createFeedThumbResolver`，受 `feeds.loadRemoteImages` / `imageCacheMb` 约束）。 */
	resolveFeedThumb?: (feedId: string, entryId: string) => Promise<string | null>
	/** 笔记卡缩略图供给：返回库内图片的资源 URL（`app://…`）。不给 = 笔记卡不做缩略图。 */
	resolveNoteThumb?: (path: string) => Promise<string | null>
	onModeChange?: (mode: "annotations" | "bookshelf" | "feeds" | "notes") => void
	getFeeds?: () => FeedSubscription[]
	getFeedEntries?: () => FeedEntry[]
	getFeedFilter?: () => FeedFilter
	getFeedSourceFilter?: () => string | null
	getCurrentFeedEntry?: () => { feedId: string; entryId: string; kind?: FeedEntryKind } | null
	onFeedFilterChange?: (filter: FeedFilter) => void
	onFeedSourceFilterChange?: (feedId: string | null) => void
	onOpenFeedEntry?: (feedId: string, entryId: string) => void
	onToggleFeedStar?: (feedId: string, entryId: string) => void
	onRefreshFeeds?: () => void
	onAddFeed?: () => void
	onImportOpml?: () => void
	/** 订阅管理面板（工具栏「设置」按钮） */
	onOpenFeedManager?: () => void
	/** 悬浮态面板的「移开鼠标自动关闭」临时挂起（菜单/子面板打开期间用） */
	onHoldAutoClose?: (hold: boolean) => void
	/** 把文章存成 Markdown 笔记（图片一并落盘）；未抓全文时由宿主先抓再存。
	 *  （原先还有一枚 `onFetchFulltext`「只抓不存」，2026-10-13 八轮随那枚按钮一起退役。） */
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

/** 「累计阅读」一行的取值：没有任何统计时给一句人话，不要显示「0 分钟」。 */
function readingDurationText(ms: number | undefined): string {
	if (!ms) return "暂无记录";
	return formatReadingDuration(ms) || "不足 1 分钟";
}

/** 书籍卡标题下那一行（用户 2026-10-17：「显示作者和书籍格式」）= `作者 · 格式`。
 *  作者缺失时只留格式（格式是同步就有的），两者都没有返回空串（调用方据此不建这一行）。 */
function bookMetaLine(extension: string | null | undefined, author: string | null | undefined): string {
	const format = (extension ?? "").trim().toUpperCase();
	const writer = (author ?? "").trim();
	if (writer && format) return `${writer} · ${format}`;
	return writer || format;
}

/** 书籍卡的详情看板内容。`preview` 是懒加载来的（作者名只有它知道），没加载完就没有那一行。 */
function shelfDetailsContent(entry: BookshelfEntry, preview: BookPreview | null, isCurrent: boolean): CardDetailsContent {
	const percent = Math.round(Math.max(0, Math.min(1, entry.progress)) * 100);
	const stat = getReadingStat(bookStatKey(entry.path));
	const reading: CardDetailRow[] = [
		{ label: "阅读进度", value: percent > 0 ? `${percent}%` : "尚未阅读", tone: "accent" },
		{ label: "累计阅读", value: readingDurationText(stat?.ms) },
		{ label: "上次阅读", value: entry.updatedAt ? formatRecentRead(entry.updatedAt) : "尚未阅读" },
	];
	if (stat?.sessions) reading.push({ label: "阅读次数", value: `${stat.sessions} 次`, tone: "muted" });
	const file: CardDetailRow[] = [
		{ label: "格式", value: entry.extension.toUpperCase() },
		{ label: "路径", value: entry.path, tone: "muted" },
	];
	if (isCurrent) file.unshift({ label: "状态", value: "正在阅读", tone: "accent" });
	else if (entry.pinned) file.unshift({ label: "状态", value: "已置顶", tone: "muted" });
	const sections: CardDetailSection[] = [{ title: "阅读", rows: reading }, { title: "文件", rows: file }];
	if (preview?.author) {
		sections[1]!.rows.unshift({ label: "作者", value: preview.author });
	}
	if (preview?.excerpt) {
		sections.push({ title: "正文开头", rows: [], text: preview.excerpt });
	}
	return { title: entry.name || "未命名书籍", subtitle: percent > 0 ? `已读 ${percent}%` : "尚未开始", sections };
}

/** RSS 卡的详情看板内容。 */
function feedDetailsContent(entry: FeedEntry, feed: FeedSubscription | null): CardDetailsContent {
	const isAudio = entry.kind === "audio";
	const position = isAudio ? (entry.state.audioPosition ?? entry.state.position) : entry.state.position;
	const percent = Math.round(Math.max(0, Math.min(1, position?.fraction ?? 0)) * 100);
	const stat = getReadingStat(feedStatKey(entry.feedId, entry.id));
	const reading: CardDetailRow[] = [
		{ label: "阅读进度", value: percent > 0 ? `${percent}%` : "尚未阅读", tone: "accent" },
		{ label: "累计阅读", value: readingDurationText(stat?.ms) },
	];
	if (stat?.lastAt) reading.push({ label: "上次阅读", value: formatRecentRead(stat.lastAt) });
	reading.push({ label: "阅读状态", value: entry.state.readAt == null ? "未读" : "已读", tone: entry.state.readAt == null ? "accent" : "muted" });
	if (entry.state.openedAt) reading.push({ label: "最近打开", value: formatRecentRead(entry.state.openedAt) });
	if (stat?.sessions) reading.push({ label: "阅读次数", value: `${stat.sessions} 次`, tone: "muted" });

	const source: CardDetailRow[] = [
		{ label: "订阅源", value: feed?.title || "未知订阅" },
		{ label: "类型", value: isAudio ? "播客" : "文章" },
		{ label: "发布于", value: formatFeedDate(entry.publishedAt) },
	];
	if (entry.author) source.splice(1, 0, { label: "作者", value: entry.author });
	if (entry.enclosure?.duration) source.push({ label: "音频时长", value: formatMediaDuration(entry.enclosure.duration) });
	if (entry.state.starredAt) source.push({ label: "收藏于", value: formatRecentRead(entry.state.starredAt) });
	// 「已保存全文」与「收藏」是两枚平行的长期保留标记（用户 2026-10-13）：都要能一眼看到
	// 这篇为什么没被清理掉。保存时间写在这里，卡片上那枚按钮只表达「保存过 / 没保存过」。
	if (entry.state.savedAt) source.push({ label: "已存 Markdown 于", value: formatRecentRead(entry.state.savedAt) });

	const sections: CardDetailSection[] = [{ title: "阅读", rows: reading }, { title: "来源", rows: source }];
	if (!isAudio) {
		const quality = entryFeedContentQuality(entry);
		const content: CardDetailRow[] = [{
			label: "正文",
			value: entry.contentSource === "fulltext" ? "已抓取全文"
				: quality === "full" ? "Feed 全文"
					: quality === "summary" ? "仅摘要" : "无正文",
			tone: quality === "empty" ? "warn" : "muted",
		}];
		if (entry.pendingContentHash) content.push({ label: "更新", value: "正文有更新", tone: "accent" });
		if (entry.state.savedAt) content.push({ label: "Markdown", value: "已保存进 vault（长期保留）" });
		const section: CardDetailSection = { title: "正文", rows: content };
		const summary = entry.summary?.trim();
		if (summary) section.text = summary;
		sections.push(section);
	}
	if (entry.url) sections.push({ title: "链接", rows: [{ label: "原文", value: entry.url, tone: "muted" }] });
	return { title: entry.title || "未命名文章", subtitle: feed?.title || "未知订阅", sections };
}

export class AnnotationsPanel {
	readonly containerEl: HTMLElement;
	private listEl!: HTMLElement;
	private actions: AnnotationsPanelActions;
	private mode: PanelMode = "annotations";
	/** 本实例允许出现的页（构造参数 modes；缺省四页全开）。 */
	private readonly modes: PanelMode[];
	private annotationData: AnnotationFileData = { highlights: [], bookmarks: [] };
	private headerTitleEl: HTMLElement | null = null;
	private annotationLoadingKey: string | null = null;
	private annotationLoadingTitle: string | null = null;
	private bookshelfModeBtn: HTMLElement | null = null;
	private feedsModeBtn: HTMLElement | null = null;
	private notesModeBtn: HTMLElement | null = null;
	/** 页签组容器（书架/订阅/笔记 三页的切换器）：高亮页整组隐藏，见 syncModeChrome。 */
	private modeSwitchEl: HTMLElement | null = null;
	private backBtn: HTMLElement | null = null;
	/** 三类卡片（书架 / 订阅 / 笔记）共用的缩略图「可见即加载」观察器。
	 *  root 取 `listEl`（抽屉滚动容器）—— 与旧的封面观察器同口径：切页会重建滚动容器，
	 *  所以每次渲染前都要 `reset()`（`disconnectShelfPreviews` 收口）。 */
	private cardThumbs = new CardThumbObserver(() => this.listEl);
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
	/** 每个内容页**上次离开时的滚动位置**（用户 2026-10-13：「侧边栏按钮打开要落在
	 *  上次退出的位置」）。切页 / 重新展开时由 `setMode` 落回去，见那里的注释。
	 *  键由 `scrollKey()` 给：书架 / 订阅 / 笔记是全局列表 → 按页记；高亮页按**文档**记
	 *  （换书 / 换文章后列表内容整批换掉，沿用上一篇的偏移只会落在一个无意义的位置）。 */
	private readonly scrollMemo = new Map<string, PanelScrollPosition>();
	private captureListScrollPosition(): PanelScrollPosition {
		const scrollRect = this.listEl.getBoundingClientRect();
		const items = [...this.listEl.querySelectorAll<HTMLElement>(".unreader-shelf-card, .unreader-feed-card, .unreader-note-card, .unreader-anno-row")];
		const anchor = items.find(item => {
			const rect = item.getBoundingClientRect();
			return rect.bottom > scrollRect.top + 1 && rect.top < scrollRect.bottom - 1;
		});
		const anchorKey = anchor ? this.scrollItemKey(anchor) : null;
		const anchorOffset = anchor ? anchor.getBoundingClientRect().top - scrollRect.top : 0;
		return { scrollTop: this.listEl.scrollTop, anchorKey, anchorOffset };
	}

	private scrollItemKey(item: HTMLElement): string | null {
		if (item.classList.contains("unreader-note-card")) return this.cardKey(item);
		if (item.dataset.path) return `path:${item.dataset.path}`;
		if (item.dataset.feedId && item.dataset.entryId) return `feed:${item.dataset.feedId}:${item.dataset.entryId}`;
		if (item.dataset.scrollKey) return item.dataset.scrollKey;
		return null;
	}

	private cardKey(card: HTMLElement): string | null {
		if (card.classList.contains("unreader-shelf-card") && card.dataset.path) return `book:${card.dataset.path}`;
		if (card.classList.contains("unreader-feed-card") && card.dataset.feedId && card.dataset.entryId) return `feed:${card.dataset.feedId}:${card.dataset.entryId}`;
		if (card.classList.contains("unreader-note-card") && card.dataset.path) {
			const group = card.closest(".unreader-note-group-starred") ? "starred" : "recent";
			return `markdown:${group}:${card.dataset.path}`;
		}
		return null;
	}

	private beginStableCardUpdate(): StableCardSnapshot {
		const cards = new Map<string, HTMLElement>();
		for (const card of this.listEl.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
			const key = this.cardKey(card);
			if (key) cards.set(key, card);
		}
		const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const focusedCard = focused?.closest<HTMLElement>(CARD_SELECTOR) ?? null;
		return {
			cards,
			scroll: this.captureListScrollPosition(),
			focusedKey: focusedCard ? this.cardKey(focusedCard) : null,
			focusedClasses: focused && focused !== focusedCard ? [...focused.classList] : [],
		};
	}

	/** 只替换确实变化/新增/删除的卡片；身份和内容相同的卡片节点原样保留。 */
	private finishStableCardUpdate(snapshot: StableCardSnapshot): void {
		for (const fresh of this.listEl.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
			const key = this.cardKey(fresh);
			const old = key ? snapshot.cards.get(key) : null;
			const oldSignature = fresh.classList.contains("unreader-note-card") ? markdownNoteSignature(old ?? fresh) : cardRenderSignatures.get(old ?? fresh);
			const freshSignature = fresh.classList.contains("unreader-note-card") ? markdownNoteSignature(fresh) : cardRenderSignatures.get(fresh);
			if (!old || old.outerHTML !== fresh.outerHTML || oldSignature !== freshSignature) continue;
			fresh.replaceWith(old);
		}
		refreshMarkdownNotesLayout(this.listEl);
		this.reattachCardThumbObservers();
		this.restoreListScrollPosition(snapshot.scroll);
		if (snapshot.focusedKey) {
			const card = [...this.listEl.querySelectorAll<HTMLElement>(CARD_SELECTOR)].find(item => this.cardKey(item) === snapshot.focusedKey);
			const target = snapshot.focusedClasses.length
				? [...(card?.querySelectorAll<HTMLElement>("*") ?? [])].find(item => snapshot.focusedClasses.every(cls => item.classList.contains(cls)))
				: card;
			target?.focus({ preventScroll: true });
		}
	}

	private reattachCardThumbObservers(): void {
		this.cardThumbs.reset();
		for (const card of this.listEl.querySelectorAll<HTMLElement>(".unreader-shelf-card")) {
			const root = card.querySelector<HTMLElement>(".unreader-card-thumb");
			const img = root?.querySelector<HTMLImageElement>("img");
			const title = card.querySelector<HTMLElement>(".unreader-shelf-title");
			const excerpt = card.querySelector<HTMLElement>(".unreader-shelf-excerpt");
			if (!root || !img || !title || !excerpt || !card.dataset.path) continue;
			this.observeShelfThumb(card, card.dataset.path, { root, img, revealed: !root.hasClass("is-hidden") }, excerpt, title, card.dataset.extension ?? "");
		}
		for (const card of this.listEl.querySelectorAll<HTMLElement>(".unreader-feed-card")) {
			const root = card.querySelector<HTMLElement>(".unreader-card-thumb");
			const img = root?.querySelector<HTMLImageElement>("img");
			if (!root || !img || !card.dataset.feedId || !card.dataset.entryId) continue;
			this.observeFeedThumb(card, card.dataset.feedId, card.dataset.entryId, { root, img, revealed: !root.hasClass("is-hidden") });
		}
		for (const card of this.listEl.querySelectorAll<HTMLElement>(".unreader-note-card")) {
			const root = card.querySelector<HTMLElement>(".unreader-card-thumb");
			const img = root?.querySelector<HTMLImageElement>("img");
			if (root && img && card.dataset.path) this.attachNoteThumb(card, card.dataset.path, { root, img, revealed: !root.hasClass("is-hidden") });
		}
	}

	private restoreListScrollPosition(position: PanelScrollPosition): void {
		this.listEl.scrollTop = position.scrollTop;
		if (!position.anchorKey) return;
		const anchor = [...this.listEl.querySelectorAll<HTMLElement>(".unreader-shelf-card, .unreader-feed-card, .unreader-note-card, .unreader-anno-row")]
			.find(item => this.scrollItemKey(item) === position.anchorKey);
		if (!anchor) return;
		const listTop = this.listEl.getBoundingClientRect().top;
		const currentOffset = anchor.getBoundingClientRect().top - listTop;
		this.listEl.scrollTop = adjustNativeSidebarScrollTop(this.listEl.scrollTop, currentOffset, position.anchorOffset);
	}

	/** 记账键（见 scrollMemo）：选内容页 = 页名；高亮页 = `annotations:<当前文档名>`。 */
	private scrollKey(mode: PanelMode): string {
		if (mode !== "annotations") return mode;
		return `annotations:${this.actions.getCurrentDocumentName?.() ?? ""}`;
	}
	/** 书签行的页码元素（anchor 供 refreshPages 重算），render 时重建 */
	private bookmarkPageEls: { el: HTMLElement; anchor: string; contextKey: string | null }[] = [];
	/** 输入区（评论 / 重命名）展开期间的「跟着键盘走」清理函数；关闭、重渲染时调用 */
	private revealCleanup: (() => void) | null = null;
	/** 展开按钮「实测重定」的合并帧句柄（见 scheduleSettleExpand） */
	private settleRaf: number | null = null;

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
		this.modes = actions.modes && actions.modes.length
			? [...actions.modes]
			: ["annotations", "bookshelf", "feeds", "notes"];
		this.mode = this.modes[0] ?? "annotations";
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-anno-panel";

		const header = this.containerEl.createDiv({ cls: "unreader-toc-header" });
		// 标注页「← 返回」：默认隐藏，仅在**当前页 = 高亮与书签**且宿主提供了
		// onRequestHome 时出现（见 syncModeChrome —— 显隐的唯一真源是当前页，不是外部层）。
		// 放在标题左侧，是标注页回选内容列表（书架/订阅/笔记）的显式出口。
		this.backBtn = header.createDiv({ cls: "unreader-clickable-icon unreader-anno-back is-hidden" });
		this.backBtn.setAttribute("aria-label", "返回列表");
		this.backBtn.setAttribute("title", "返回列表");
		try { setIcon(this.backBtn, "arrow-left"); } catch { this.backBtn.setText("←"); }
		if (!this.backBtn.querySelector("svg")) this.backBtn.setText("←");
		this.backBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onRequestHome?.();
		});
		// 头部只显示**正在阅读的页面名**（书名 / 文章名），没有打开页面时才退回模式名。
		// 原来这里挂的是固定品牌字样「UNreader」，在侧栏里等于没信息量。
		this.headerTitleEl = header.createDiv({ cls: "unreader-anno-title" });
		const headerRight = header.createDiv({ cls: "unreader-toc-header-right" });
		this.modeSwitchEl = headerRight.createDiv({ cls: "unreader-anno-mode-switch" });
		// 页签组只含**选内容**的三页（书架/订阅/笔记）。「高亮与书签」**没有**页签：
		// 它是「打开一份内容」才出现的页面，入口是阅读卡片 / 功能轨高亮按钮，
		// 绝不允许与三个内容页签同框出现（用户 2026-10-11 报障：它偶尔漏到那三个旁边）。
		// 显隐真源 = 当前页（syncModeChrome）：停在高亮页 → 整组隐藏；停在内容页 → 整组显示。
		for (const mode of this.modes) {
			if (mode === "bookshelf") this.buildModeButton(this.modeSwitchEl, "bookshelf", "library", "书架", "书");
			else if (mode === "feeds") this.buildModeButton(this.modeSwitchEl, "feeds", "rss", "订阅", "RSS");
			else if (mode === "notes") this.buildModeButton(this.modeSwitchEl, "notes", "file-text", "笔记", "笔");
			// annotations：不建页签（见上）
		}
		// display:flex/align-items/gap 全部在 .unreader-toc-header-right 的 CSS 类里给
		// （官方 lint 禁止行内字面量样式）
		this.pinBtn = headerRight.createDiv({ cls: "unreader-clickable-icon unreader-anno-pin" });
		this.pinBtn.setAttribute("aria-label", "钉住侧边栏");
		try { setIcon(this.pinBtn, "pin"); } catch { this.pinBtn.setText("钉"); }
		this.pinBtn.addEventListener("click", e => {
			e.stopPropagation();
			// 禁用态（md 宿主不支持钉住）：点了什么都不做，不死等 onTogglePin。
			if (this.pinBtn?.hasClass("is-disabled")) return;
			this.actions.onTogglePin?.();
		});

		this.listEl = this.containerEl.createDiv({ cls: "unreader-toc-scroll" });
		// 「上次退出的位置」的**持续记账**：面板开着时用户每滚一下就把这一页的位置记下来。
		// ⚠️ 只在面板开着时记账：各 render* 都会先 `listEl.empty()`，浏览器会把 scrollTop
		// 夹回 0 并派发一次 scroll 事件 —— 不设闸门，这次夹取就会把用户真实的位置覆盖成 0
		// （宿主在面板关着时刷新列表也走同一路径）。切页那一次由 setMode 的**同步**记账兜底。
		this.listEl.addEventListener("scroll", () => {
			if (!this.isOpen()) return;
			this.scrollMemo.set(this.scrollKey(this.mode), this.captureListScrollPosition());
		}, { passive: true });

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

	/** 建一枚**选内容页**页签（书架 / 订阅 / 笔记）并把引用记到对应字段。
	 *  `modes` 里没有的页不建 = 不出现；annotations 不建页签（见构造函数）。
	 *  图标名在旧版 Obsidian 可能不存在（setIcon 不抛错、只是不画），所以逐个兜底到汉字。 */
	private buildModeButton(
		parent: HTMLElement,
		mode: PanelMode,
		icon: string,
		label: string,
		fallbackText: string,
	): void {
		const btn = parent.createDiv({ cls: "unreader-anno-mode-btn" });
		btn.setAttribute("aria-label", label);
		btn.setAttribute("title", label);
		try { setIcon(btn, icon); } catch { btn.setText(fallbackText); }
		if (!btn.querySelector("svg")) btn.setText(fallbackText);
		btn.addEventListener("click", e => {
			e.stopPropagation();
			this.setMode(mode);
		});
		if (mode === "bookshelf") this.bookshelfModeBtn = btn;
		else if (mode === "feeds") this.feedsModeBtn = btn;
		else if (mode === "notes") this.notesModeBtn = btn;
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
		// 手机端：宽度由 CSS 定死为 75vw（见 styles.css 的 --ur-anno-w 段）。这里必须
		// **清掉行内宽度与变量**且不再写回 —— 行内样式优先级高于样式表，留着它手机档
		// 就永远拿不到 75vw（拖拽把手也已隐藏，用户改不了，只会以为坏了）。
		if (this.isPhoneLayout()) {
			el.style.removeProperty("width");
			this.writeHostWidthVar();
			// 宽度换了 → 每行容纳的字数换了 → 截断行数跟着变，展开按钮必须重定
			this.scheduleSettleExpand();
			return;
		}
		if (px == null) el.style.removeProperty("width");
		else el.style.width = `${px}px`;
		this.writeHostWidthVar();
		this.scheduleSettleExpand();
	}

	/** 把**有效宽度**写到宿主的 `--unreader-anno-w` 上。
	 *
	 *  为什么必须落在宿主而不是面板自己：这个变量喂的是**面板以外**的三族消费者 ——
	 *  · 阅读器：钉住形态的 `flex: 0 0 var(--ur-anno-w)`、空态让位、外观面板左缘；
	 *  · md：`.unreader-md-root.is-side-open .unreader-actions`（`left: calc(var(--ur-anno-w) + 1px)`）
	 *    与灯绳避让。
	 *  只写面板自己的行内 `width` 管不到它们。
	 *
	 *  ⚠️ **必须可重放**（2026-10-13 报障「md 侧展开侧边栏时工具栏离抽屉一条缝」的根因）：
	 *  两个宿主都在 `appendChild` **之前**调 `setWidth`（readerView 装配抽屉 / mdOverlay.mountPanels）
	 *  —— 那一刻 `parentElement` 还是 null，旧实现直接静默跳过 ⇒ 面板按行内宽度渲染、
	 *  宿主变量却停在上次的值（默认 330px）。拖窄过（<330）就裂出一条缝、拖宽过就被
	 *  抽屉盖住。所以：① 拖拽 / 恢复设置时照写；② `show()`（此刻必然已进 DOM）再补写一次。
	 *  幂等 —— 值没变时重复写只是再来一次 setProperty。 */
	private writeHostWidthVar(): void {
		const parent = this.containerEl.parentElement;
		if (!parent) return;
		if (!this.isPhoneLayout() && this.currentWidth != null) {
			parent.style.setProperty("--unreader-anno-w", `${this.currentWidth}px`);
		} else {
			parent.style.removeProperty("--unreader-anno-w");
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

	/** 钉住按钮的**禁用态**：元素保留、可见，但浅色置灰、点击无效
	 *  （md 宿主不支持钉住 —— 布局主人是 Obsidian，硬让位四处对不上）。
	 *  与「隐藏」是两种语义：隐藏=根本不占头部位置；禁用=占着位置但明确不可用，
	 *  避免用户以为「这个视图少了功能 / 按钮坏了没渲染」。 */
	setPinEnabled(enabled: boolean): void {
		if (!this.pinBtn) return;
		this.pinBtn.toggleClass("is-disabled", !enabled);
		this.pinBtn.setAttribute("aria-disabled", enabled ? "false" : "true");
		this.pinBtn.setAttribute("aria-label", enabled ? "钉住侧边栏" : "Markdown 视图不支持钉住");
		this.pinBtn.setAttribute("title", enabled ? "钉住侧边栏" : "Markdown 视图不支持钉住");
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

	getMode(): PanelMode {
		return this.mode;
	}

	/** 当前模式的兜底标题（没有任何页面打开时显示，保证头部不空着）。 */
	private modeLabel(): string {
		return this.mode === "bookshelf" ? "书架"
			: this.mode === "feeds" ? "订阅"
				: this.mode === "notes" ? "笔记"
					: "标注";
	}

	/** 头部标题 = 当前页面名；换书 / 换文章 / 回到空白态时由宿主调用重读。
	 *  取值是现读的（`getCurrentDocumentName` 每次现算），不做缓存。 */
	refreshHeaderTitle(): void {
		const el = this.headerTitleEl;
		if (!el) return;
		if (this.annotationLoadingKey) {
			const title = this.annotationLoadingTitle?.trim();
			el.setText(title ? `正在加载“${title}”的标注…` : "正在加载标注…");
			el.removeClass("is-placeholder");
			el.setAttribute("title", title ? `正在加载“${title}”的标注…` : "正在加载标注…");
			return;
		}
		const name = (this.actions.getCurrentDocumentName?.() ?? "").trim();
		el.setText(name || this.modeLabel());
		el.toggleClass("is-placeholder", !name);
		el.setAttribute("title", name || this.modeLabel());
	}

	setAnnotationLoading(key: string | null, title?: string, error?: string): void {
		this.annotationLoadingKey = key;
		this.annotationLoadingTitle = title ?? null;
		this.containerEl.toggleClass("is-loading-annotations", !!key);
		this.refreshHeaderTitle();
		if (this.mode === "annotations") {
			this.listEl.empty();
			this.listEl.createDiv({
				cls: "unreader-toc-empty",
				text: error ?? (key ? (title ? `正在读取“${title}”的标注…` : "正在读取标注…") : ""),
			});
		}
	}

	setAnnotationBrowseTarget(data: AnnotationFileData | null): void {
		this.annotationLoadingKey = null;
		this.annotationLoadingTitle = null;
		this.containerEl.removeClass("is-loading-annotations");
		this.refreshHeaderTitle();
		if (data && this.mode === "annotations") this.render(data);
	}

	/** 上下文切换只更新可见状态，保留列表节点、滚动、焦点与展开状态。 */
	updateContentContext(key: string | null): void {
		this.refreshHeaderTitle();
		for (const card of this.listEl.querySelectorAll<HTMLElement>(".unreader-shelf-card,.unreader-feed-card,.unreader-note-card")) {
			const cardKey = card.classList.contains("unreader-shelf-card") ? `book:${card.dataset.path ?? ""}`
				: card.classList.contains("unreader-note-card") ? `markdown:${card.dataset.path ?? ""}`
					: `feed:${card.dataset.feedId ?? ""}:${card.dataset.entryId ?? ""}`;
			card.classList.toggle("is-current", !!key && cardKey === key);
		}
	}

	/** 四种内容共用同一抽屉、钉住状态、尺寸与开合状态，只切换列表主体。 */
	setMode(mode: PanelMode): void {
		this.shelfDragCleanup?.();
		const changed = this.mode !== mode;
		const previousPosition = this.captureListScrollPosition();
		// 换页前**同步**把当前页的位置记下来（不能等 scroll 事件：那是下一帧才派的，
		// 而这一刻的 scrollTop 马上就要被 `empty()` 冲成 0）。见 scrollMemo 字段注释。
		if (changed) this.scrollMemo.set(this.scrollKey(this.mode), previousPosition);
		this.mode = mode;
		// markdown 宿主的标注是现算的：切到标注页前先重取数据（书 / RSS 不给此回调，
		// 沿用既有 render() 喂入的内存数据，行为不变）。
		if (mode === "annotations" && this.actions.provideAnnotationData) {
			this.annotationData = this.actions.provideAnnotationData();
		}
		this.syncModeChrome();
		if (mode === "bookshelf") this.renderBookshelf();
		else if (mode === "feeds") this.renderFeeds();
		else if (mode === "notes") this.renderNotes();
		else if (this.annotationLoadingKey) {
			this.setAnnotationLoading(this.annotationLoadingKey, this.annotationLoadingTitle ?? undefined);
		} else this.renderAnnotations();
		// 切换模式回到**该页上次离开时的位置**（用户 2026-10-13：「侧边栏按钮打开要落
		// 在上次退出的位置」—— 书架滚到中间翻了一半、关掉抽屉再打开，不该被弹回顶部）。
		// 同一模式内的重绘（排序 / 置顶 / 拖动 / 刷新）仍保留当前滚动位置；
		// 没记过账的页（首次进入）落 0 = 顶部，与改动前逐像素一致。
		// ⚠️ 取值必须在渲染**之后**、且在这一次赋值里完成：赋值与渲染之间读到的
		// scrollTop 已被 `empty()` 夹成 0，拿它当兜底会把位置丢掉。
		const targetPosition = changed
			? this.scrollMemo.get(this.scrollKey(mode)) ?? { scrollTop: 0, anchorKey: null, anchorOffset: 0 }
			: previousPosition;
		this.restoreListScrollPosition(targetPosition);
		if (changed) this.actions.onModeChange?.(mode);
	}

	private syncModeChrome(): void {
		const shelf = this.mode === "bookshelf";
		const feeds = this.mode === "feeds";
		const notes = this.mode === "notes";
		const annotations = this.mode === "annotations";
		this.containerEl.toggleClass("is-bookshelf", shelf);
		this.containerEl.toggleClass("is-feeds", feeds);
		this.containerEl.toggleClass("is-notes", notes);
		this.containerEl.toggleClass("is-annotations", annotations);
		this.refreshHeaderTitle();
		this.bookshelfModeBtn?.toggleClass("is-active", shelf);
		this.feedsModeBtn?.toggleClass("is-active", feeds);
		this.notesModeBtn?.toggleClass("is-active", notes);
		// 页签组显隐 + 返回钮显隐 —— 唯一收口，禁止在各调用点单独切类。
		// **真源只有一个：当前页**（不再有独立的「层」状态，那是本 bug 的根源 ——
		// 页签显隐有两个真源（mode + docLayer）必然漂移，docLayer 从未被驱动时
		// 「高亮与书签」页签就会漏到三个内容页签旁边）。
		//  · 停在高亮与书签页 → 整组内容页签隐藏（该页的出口是「← 返回」）；
		//  · 停在书架/订阅/笔记 → 整组显示。
		this.modeSwitchEl?.toggleClass("is-hidden", annotations);
		// 返回钮：仅高亮与书签页 + 宿主提供了回调时出现（md 宿主不给回调 → 永不出现）。
		const showBack = annotations && !!this.actions.onRequestHome;
		this.backBtn?.toggleClass("is-hidden", !showBack);
		this.backBtn?.setAttribute("aria-hidden", showBack ? "false" : "true");
	}

	/** 打开「高亮与书签」页（当前书 / 文章的高亮与书签）。宿主在文档落定后调用。
	 *  本实例没有这一页时（自定义宿主）直接忽略，防误调。当前已在该页则不动。 */
	openAnnotationsPage(): void {
		if (!this.modes.includes("annotations")) return;
		if (this.mode !== "annotations") this.setMode("annotations");
	}

	/** 回选内容页（书架 / 订阅 / 笔记）。pickerMode 有且本实例有该页就落它，否则落
	 *  第一个非标注页。放这里是为了让宿主不必各自重复「选哪一页」的兜底逻辑。 */
	openPickerPage(pickerMode?: Exclude<PanelMode, "annotations">): void {
		const target = pickerMode && this.modes.includes(pickerMode)
			? pickerMode
			: this.modes.find(m => m !== "annotations") ?? "bookshelf";
		if (this.mode !== target) this.setMode(target);
	}

	dispose(): void {
		disposeMarkdownNotesLayout(this.listEl);
		this.stopFeedListRendering();
		this.disconnectShelfPreviews();
		this.stopEditorReveal();
	}

	/** 切页 / 重绘时收口缩略图观察器（保留旧方法名，四个调用点不动）。 */
	private disconnectShelfPreviews(): void {
		this.cardThumbs.reset();
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
		const contextKey = this.actions.getAnnotationContextKey?.() ?? null;
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
			const hasContentContext = !this.actions.getAnnotationContextKey || contextKey !== null;
			this.listEl.createDiv({
				cls: "unreader-toc-empty",
				text: !hasContentContext
					? "先打开一本书、订阅文章或 Markdown 笔记，再查看对应的高亮和书签。"
					: podcast
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
				ul.appendChild(this.bookmarkRow(b, contextKey));
			}
		}

		if (data.highlights.length) {
			this.listEl.createDiv({ cls: "unreader-anno-section unreader-anno-section--highlight", text: `高亮与评论 · ${data.highlights.length}` });
			const ul = this.listEl.createEl("ul", { cls: "unreader-anno-list" });
			for (const h of data.highlights) {
				ul.appendChild(this.highlightRow(h, contextKey));
			}
		}
		// 行已插入列表 → 下一帧按**实测**重定展开按钮（渲染时量不出高度，只能兜底）。
		this.scheduleSettleExpand();
	}

	private renderBookshelf(): void {
		const stableCards = this.beginStableCardUpdate();
		this.disconnectShelfPreviews();
		// 重渲染会让旧卡片连同它的悬停接线一起消失：浮层是 body 上的单例、用 fixed 定位，
		// 不主动收就会留在屏幕上（列表换了，看板还写着上一批卡片的数据）。
		hideCardDetails();
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
		managerBtn.setAttribute("aria-label", "打开分类管理：可筛选、排序和管理书籍分类");
		managerBtn.setAttribute("title", "打开分类管理：可筛选、排序和管理书籍分类");
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
			this.finishStableCardUpdate(stableCards);
			return;
		}
		this.listEl.toggleClass("is-manual", sortMode === "manual");
		const pinned = entries.filter(entry => entry.pinned);
		const regular = entries.filter(entry => !entry.pinned);
		if (pinned.length) this.renderShelfGroup(pinned, "置顶", sortMode, currentPath);
		this.renderShelfGroup(regular, pinned.length ? sourceLabel : "", sortMode, currentPath);
		this.finishStableCardUpdate(stableCards);
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

	// `showBookshelfCardMenu` 已删除（2026-10-17）：书卡 ⋯ 与卡片右键统一走
	// `onFileContextMenu` → `sidePanels.showVaultFileMenu` 的**原生文件菜单**，
	// 自建那份「未分类 / 各分类 / 从书架移除」是用户否掉的「老版本」。
	// 分类与移除没有丢 —— `showVaultFileMenu` 的 book 分支照样把它们追加在原生菜单后面。

	/** 重建第三板块。所有数据从缓存读取，不在这里发网络请求。 */
	renderFeeds(): void {
		const stableCards = this.beginStableCardUpdate();
		this.disconnectShelfPreviews();
		this.stopFeedListRendering();
		this.stopEditorReveal();
		hideCardDetails();
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
		refreshBtn.setAttribute("aria-label", "刷新全部启用的订阅源");
		refreshBtn.setAttribute("title", "刷新全部启用的订阅源");
		try { setIcon(refreshBtn, "refresh-cw"); } catch { refreshBtn.setText("刷"); }
		refreshBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onRefreshFeeds?.();
		});
		const settingsBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-feed-action" });
		settingsBtn.setAttribute("aria-label", "打开订阅管理：添加、导入导出或停用订阅");
		settingsBtn.setAttribute("title", "打开订阅管理：添加、导入导出或停用订阅");
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
			this.finishStableCardUpdate(stableCards);
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
			this.finishStableCardUpdate(stableCards);
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
		if (done) { this.finishStableCardUpdate(stableCards); return; }
		if (typeof IntersectionObserver === "undefined") {
			while (!this.appendFeedChunk()) { /* 旧环境一次性完成，保持功能可用 */ }
			this.finishStableCardUpdate(stableCards);
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
		this.finishStableCardUpdate(stableCards);
	}

	/** 第四板块：只列最近阅读与星标 Markdown 笔记，不扫描/展示全库。
	 *  卡片本体在 `markdownNoteCards.renderMarkdownNotes`（与 Markdown 阅读模式的笔记抽屉共用一份，
	 *  避免两处行为漂移）。正文仍交给 Obsidian 原生阅读模式，本页只负责「找到并打开」。 */
	private renderNotes(): void {
		const stableCards = this.beginStableCardUpdate();
		this.disconnectShelfPreviews();
		this.stopFeedListRendering();
		this.stopEditorReveal();
		hideCardDetails();
		this.listEl.empty();
		this.bookmarkPageEls = [];
		renderMarkdownNotes(this.listEl, this.actions.getMarkdownNotes?.() ?? { recent: [], starred: [] }, {
			onOpen: path => this.actions.onOpenMarkdownNote?.(path),
			onOpenAnnotations: path => this.actions.onOpenMarkdownAnnotations?.(path),
			onContextMenu: (path, event) => this.actions.onFileContextMenu?.(path, event, "markdown"),
			onTogglePin: path => this.actions.onToggleMarkdownNotePin?.(path),
			onRevealInFolder: this.actions.onRevealMarkdownNote
				? path => this.actions.onRevealMarkdownNote?.(path)
				: undefined,
			resolveWordCount: this.actions.resolveNoteWordCount,
			// 正文预览（2026-10-17）：标题下面那截空白填「笔记最强的字」，按 Markdown 渲染。
			resolveExcerpt: this.actions.resolveNoteExcerpt,
			renderMarkdown: this.actions.renderNoteMarkdown,
			// 缩略图接线只在宿主给了 resolver 时才存在 —— 不给就整卡不建缩略图列（不留空档）。
			attachThumb: this.actions.resolveNoteThumb
				? (card, path, thumb) => this.attachNoteThumb(card, path, thumb)
				: undefined,
		});
		this.finishStableCardUpdate(stableCards);
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
		card.dataset.feedId = entry.feedId;
		card.dataset.entryId = entry.id;
		cardRenderSignatures.set(card, JSON.stringify({ entry, feed }));
		card.toggleClass("is-unread", entry.state.readAt == null);
		card.toggleClass("is-starred", entry.state.starredAt != null);
		card.toggleClass("is-audio", entry.kind === "audio");
		card.toggleClass("is-current", current?.feedId === entry.feedId && current.entryId === entry.id);
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");
		card.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); this.actions.onFeedContextMenu?.(entry.feedId, entry.id, e); });
		const open = (): void => this.actions.onOpenFeedEntry?.(entry.feedId, entry.id);
		card.addEventListener("click", e => {
			const target = e.target as HTMLElement | null;
			if (target?.closest("button, audio, select, a, .unreader-feed-card-actions")) return;
			open();
		});
		card.addEventListener("keydown", e => {
			if (e.key !== "Enter" && e.key !== " ") return;
			const target = e.target as HTMLElement | null;
			if (target && target !== card && target.closest("button, a, [role=button], audio, select")) return;
			e.preventDefault();
			open();
		});

		// 卡片 = 网格 2×2（2026-10-13 用户 wireframe）：第 1 行 = 文字块（标题 + 简介，
		// 第 1 列）｜缩略图（第 2 列，固定 3:4）；第 2 行 = **通栏底栏** `.unreader-card-foot`
		// （特殊信息 + 按钮，横跨两列）。动作钮位置只由「卡片底部」决定，与卡片多高、
		// 有没有缩略图无关。见 styles.css「三类列表卡片统一外壳」段。
		const main = card.createDiv({ cls: "unreader-card-main" });
		main.createDiv({ cls: "unreader-feed-card-title", text: entry.title || "未命名文章" });
		// 订阅名：**简介这一行之内**的浅色前缀（用户 2026-10-13 六轮原话：「简介内容前面加上
		// 一个 RSS 名，**不是多加一行**」）。五轮曾做成「标题与简介之间的独立一行」—— 那会凭空
		// 多啃一行高度、还把标题与摘要割开，正是用户要消掉的「信息太多」，所以退回来。
		// 现在它是 `.unreader-feed-card-summary` 的**第一个子节点**（行内 `span`），摘要文字紧随其后；
		// 纯展示，不做筛源入口（筛源仍在工具栏的源选择钮，一处入口就够）。取不到订阅
		// （源已被删除 / 条目是聚合而来）时**整段不建** —— 只跳过这一个 span，摘要里也不会
		// 多出前导分隔符（分隔符由 CSS `::after` 挂在 span 上，span 不在就没有）。
		const sourceName = (feed?.title ?? "").trim();
		const summaryEl = main.createDiv({ cls: "unreader-feed-card-summary" });
		if (sourceName) summaryEl.createSpan({ cls: "unreader-feed-card-source-name", text: sourceName });
		// 用原生文本节点而不是 obsidian 的 `appendText()`：那个扩展在三个探针的 stub 里没有
		// （2026-10-13 实测：`summaryEl.appendText is not a function` 直接把 `test:feed` 打成 0/0）。
		summaryEl.appendChild(document.createTextNode(entry.summary || "暂无摘要"));

		// 底栏只放两样东西：**最左一枚阅读进度环** + **最右一组动作钮**。
		// 其余信息（订阅源 / 作者 / 日期 / 正文状态 / 音频时长 / 进度文字）全部移进
		// 悬停看板（`feedDetailsContent`）—— 底栏是「一眼扫过」的位置，塞满文字正是
		// 用户报的「信息太多导致卡片排版混乱」（2026-10-13）。
		const progress = entry.kind === "audio"
			? (entry.state.audioPosition ?? entry.state.position)
			: entry.state.position;
		const progressPercent = Math.round(Math.max(0, Math.min(1, progress?.fraction ?? 0)) * 100);
		const foot = card.createDiv({ cls: "unreader-card-foot" });
		const ring = createProgressRing({
			fraction: progress?.fraction ?? 0,
			label: entry.state.readAt == null && progressPercent === 0
				? "未读 · 阅读进度 0%"
				: `阅读进度 ${progressPercent}%`,
			cls: "unreader-feed-ring",
		});
		foot.appendChild(ring);

		// 操作按钮在通栏底栏末端 —— 三类卡同一位置（书架 ⋯/钉、笔记三钮同在此栏）。
		// **这里没有「标记已读 / 未读」**：用户 2026-10-13 定稿「RSS 文章的标记为已读的
		// 功能取消掉，有阅读记录环就可以了」—— 读态由最左那枚进度环表达，「未读」只由
		// 打开文章自动记录（`feeds.markReadOnOpen`），不再需要用户手动翻面的按钮。
		// （那枚按钮的历史包袱也一并卸掉：它的读态图标反复与进度环撞脸，五轮六轮都在
		//  修「卡片上有两个圈」，根因就是「一个状态被画了两次」。）
		const cardActions = foot.createDiv({ cls: "unreader-feed-card-actions" });
		const annotations = createCardActionButton(cardActions, { cls: "unreader-feed-inline-action unreader-card-annotations", icon: "highlighter", fallback: "▰", label: "查看标注" });
		annotations.addEventListener("click", e => { e.stopPropagation(); this.actions.onOpenFeedAnnotations?.(entry.feedId, entry.id); });
		const star = createCardActionButton(cardActions, { cls: "unreader-feed-inline-action", icon: "star", fallback: "★", label: entry.state.starredAt ? "取消收藏" : "收藏文章", pressed: entry.state.starredAt != null });
		star.toggleClass("is-starred", entry.state.starredAt != null);
		// 图标**恒为 `star`**，靠 `is-starred` 填充（与笔记卡、功能轨同一套读数）——
		// 换成 `star-off`（带斜杠的星）是第三套画法，同一件事在三处长成三个样子。
		star.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onToggleFeedStar?.(entry.feedId, entry.id);
		});
		if (entry.url) {
			const original = createCardActionButton(cardActions, { cls: "unreader-feed-inline-action", icon: "external-link", fallback: "↗", label: "在系统浏览器打开原文" });
			original.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onOpenOriginal?.(entry.url);
			});
		}
		// 「保存为 Markdown」= 把这篇正文取成 Markdown 存进 vault（`readerView.saveFeedNote`，
		// 内含「没抓过全文就先抓」）。**这是底栏里唯一的内容加工动作**：原先并排的
		// 「抓取网页全文」（只抓不存、缓存到本地）已被用户 2026-10-13 八轮要求去掉 ——
		// 「这个按钮去掉，然后统一弄成保存为 markdown 就行」：抓全文本来就是保存的
		// 第一步，单列一枚只会让用户在两枚长得很像的按钮之间猜。真正需要「只抓不存」的
		// 场合由打开文章时的自动抓取覆盖（`feeds.autoFulltext`）。
		// 保存成功后置 `state.savedAt` ⇒ 与星标**同权**地长期保留（见 feedUtils
		// `isPinnedFeedEntry`）：订阅链接失效、刷新裁剪都不会让这篇从列表里消失。
		if (canSaveFeedEntry(entry)) {
			const saved = entry.state.savedAt != null;
			const save = createCardActionButton(cardActions, { cls: "unreader-feed-inline-action", icon: saved ? "file-check" : "file-down", fallback: "存", label: saved ? "已保存为 Markdown，再次点击重新保存" : "保存为 Markdown", pressed: saved });
			save.toggleClass("is-saved", saved);
			save.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onSaveNote?.(entry.feedId, entry.id);
			});
		}

		// 这里**没有 ⋯**（用户 2026-10-17 定稿）：RSS 条目只是缓存里的一条记录，vault 里
		// 没有对应文件，弹不出 Obsidian 原生文件菜单；给它一枚 ⋯ 只能点出一堆通用项。
		// 条目操作仍走卡片**右键**（`sidePanels.showFeedEntryMenu`，两宿主共用一份）。
		// 书籍卡 / 笔记卡才有 ⋯ —— 它们是真实文件，详见 `markdownNoteCards` 与 `appendShelfCard`。

		// 缩略图列（末子节点，默认 is-hidden）。宿主没给 resolver 就不建这一列。
		if (this.actions.resolveFeedThumb) {
			const thumb = mountCardThumb(card);
			this.observeFeedThumb(card, entry.feedId, entry.id, thumb);
		}
		// 悬停看板：底栏里被拿掉的那些信息（源 / 作者 / 日期 / 状态 / 时长）都在这里。
		attachCardDetails(card, () => feedDetailsContent(entry, feed), ring);
		return card;
	}

	/** 订阅卡：可见时才去解析缩略图（宿主侧受 `loadRemoteImages` / `imageCacheMb` 约束，
	 *  关闭联网时只认已缓存的图；解析不到或抓取失败都静默保持「全宽文字」，不重试）。 */
	private observeFeedThumb(card: HTMLElement, feedId: string, entryId: string, thumb: CardThumb): void {
		const resolve = this.actions.resolveFeedThumb;
		if (!resolve) return;
		this.cardThumbs.observe(card, () => {
			void resolve(feedId, entryId).then(url => {
				if (!card.isConnected || !url) return;
				showCardThumb(thumb, url);
			}).catch(() => { /* 无图 → 保持全宽文字 */ });
		});
	}

	private renderShelfGroup(entries: BookshelfEntry[], label: string, sortMode: BookshelfSortMode, currentPath: string | null): void {
		if (!entries.length) return;
		if (label) this.listEl.createDiv({ cls: "unreader-shelf-group-title", text: `${label} · ${entries.length}` });
		const group = this.listEl.createDiv({ cls: "unreader-shelf-group" });
		for (const entry of entries) this.appendShelfCard(group, entry, sortMode, currentPath);
	}

	private appendShelfCard(group: HTMLElement, entry: BookshelfEntry, sortMode: BookshelfSortMode, currentPath: string | null): void {
		const card = group.createDiv({ cls: "unreader-shelf-card" });
		cardRenderSignatures.set(card, JSON.stringify(entry));
		card.dataset.path = entry.path;
		// 格式要在「缩略图观察器被重挂」时还能读到（`reattachCardThumbObservers` 只拿到 DOM，
		// 拿不到 `BookshelfEntry`）—— 作者补写的那一行就靠它拼「作者 · 格式」。
		card.dataset.extension = entry.extension;
		card.toggleClass("is-current", entry.path === currentPath);
		card.toggleClass("is-pinned", entry.pinned);
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");
		card.addEventListener("click", e => {
			if ((e.target as HTMLElement | null)?.closest(".unreader-shelf-card-actions,button,a")) return;
			const draggedAt = Number(card.dataset.draggedAt ?? 0);
			if (draggedAt && Date.now() - draggedAt < 320) return;
			// 不再在此提前切页：文档落定后由宿主 openAnnotationsPage() 统一切到高亮页，
			// 避免加载期间短暂显示上一本书的标注。
			this.actions.onOpenBook?.(entry.path);
		});
		card.addEventListener("keydown", e => {
			if (e.key !== "Enter" && e.key !== " ") return;
			const target = e.target as HTMLElement | null;
			if (target && target !== card && target.closest("button, a, [role=button], select")) return;
			e.preventDefault();
			this.actions.onOpenBook?.(entry.path);
		});
		card.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); this.actions.onFileContextMenu?.(entry.path, e, "book"); });

		if (sortMode === "manual") {
			const drag = card.createDiv({ cls: "unreader-shelf-drag" });
			drag.setAttribute("aria-label", "拖拽调整顺序");
			try { setIcon(drag, "grip-vertical"); } catch { drag.setText("⋮"); }
			this.attachShelfDrag(group, card, drag);
		}

	// 卡片 = 网格 2 行：第 1 行 = 标题 + 「作者 · 格式」（第 1 列）｜缩略图
	// （第 2 列，固定 3:4）；第 2 行 = **通栏底栏** `.unreader-card-foot`
	// （最左进度环 + 最右动作钮）。拖拽把手绝对定位、被 CSS 排除。
	const body = card.createDiv({ cls: "unreader-shelf-body" });
	const title = body.createDiv({ cls: "unreader-shelf-title", text: entry.name });
	// 标题下那一行（用户 2026-10-17：「书籍文件的话，这里显示作者和书籍格式」）：
	// 与 RSS 卡的「订阅名 + 简介」、笔记卡的正文预览占**同一格**，三类卡扫下来行数一致。
	// 格式是同步的（`entry.extension`），作者只有懒加载的 `BookPreview` 知道 ⇒ 先写格式、
	// 作者到了再补。**不再与封面互斥**：有封面时这一行照样显示（旧的「无封面才显示正文首行」
	// 是拿这一格当封面兜底，现在这一格有自己的信息了）。
	const excerpt = body.createDiv({ cls: "unreader-shelf-excerpt", text: bookMetaLine(entry.extension, null) });

		// 底栏只留「进度环（最左）+ 动作钮（最右）」—— 进度**文字**、格式、日期、
		// 「正在阅读」标记全部移进悬停看板（`shelfDetailsContent`）。正文列里原来那条
		// 细进度条同时删掉：环已经表达同一件事，两处重复正是「信息太多」的来源。
		const percent = Math.round(Math.max(0, Math.min(1, entry.progress)) * 100);
		const foot = card.createDiv({ cls: "unreader-card-foot" });
		const ring = createProgressRing({
			fraction: entry.progress,
			label: percent > 0 ? `阅读进度 ${percent}%` : "尚未阅读",
			cls: "unreader-shelf-ring",
		});
		foot.appendChild(ring);
		const cardActions = foot.createDiv({ cls: "unreader-shelf-card-actions" });
		const annotations = createCardActionButton(cardActions, { cls: "unreader-card-annotations", icon: "highlighter", fallback: "▰", label: "查看标注" });
		annotations.addEventListener("click", e => { e.stopPropagation(); this.actions.onOpenBookAnnotations?.(entry.path); });
		const pin = createCardActionButton(cardActions, { cls: "unreader-shelf-pin", icon: entry.pinned ? "pin-off" : "pin", fallback: entry.pinned ? "顶" : "钉", label: entry.pinned ? "取消置顶" : "置顶书籍", pressed: entry.pinned });
		pin.toggleClass("is-active", entry.pinned);
		pin.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onToggleBookPin?.(entry.path);
		});
		// 「⋯」**必须是动作组最后一个**（用户 2026-10-17：「位置在最右边」）——
		// 旧实现把它排在置顶钮前面，同一枚按钮在书卡和笔记卡上位置不一致。
		// 它现在弹的是**和文件浏览器里右键这本书完全一样**的原生菜单
		// （用户 2026-10-17：「相当于在文件菜单点击对应文件鼠标右键，从而打开的菜单栏」）。
		// 走的就是卡片右键同一条路：`onFileContextMenu(path, event, "book")` →
		// `sidePanels.showVaultFileMenu`（原生菜单 + UNreader 的分类/移除项）。
		// 因此**不能再弹自建的 `showBookshelfCardMenu`** —— 那正是用户说的「老版本」。
		// 宿主没给这个回调就不渲染（绝不留下点了没反应的死按钮）。
		if (this.actions.onFileContextMenu) {
			const more = createCardActionButton(cardActions, { cls: "unreader-shelf-more", icon: "ellipsis-vertical", fallback: "⋯", label: "更多操作（与文件右键菜单相同）" });
			more.addEventListener("click", e => {
				e.stopPropagation();
				this.actions.onFileContextMenu?.(entry.path, e, "book");
			});
		}

		// 缩略图列必须是**最后一个子节点**（CSS 靠 `grid-column: 2` 定位，与 DOM 序无关，
		// 但保持一致便于阅读，也避免以后有人在它后面插元素时误判第 2 列会被占）。
		const thumb = mountCardThumb(card);
		this.observeShelfThumb(card, entry.path, thumb, excerpt, title, entry.extension);
		// 悬停看板：作者名只有懒加载的 `BookPreview` 知道，所以内容**现取**（见 shelfPreview）。
		attachCardDetails(card, () => shelfDetailsContent(entry, this.shelfPreviews.get(card) ?? null, entry.path === currentPath), ring);
	}

	/** 卡片 → 已加载的书籍预览。作者名 / 正文开头只在看板里用，没必要留在 DOM 里。 */
	private shelfPreviews = new WeakMap<HTMLElement, BookPreview>();

	/** 书籍卡：可见时才 `loadBookPreview`（读封面 + 作者）。
	 *  封面 → 右列缩略图；作者 → 标题下那行「作者 · 格式」（格式在卡片创建时就同步写好了，
	 *  这里只补作者）。两件事**都做**，不再互斥 —— 这一行现在有自己的信息，不再是封面兜底。
	 *  加载失败也不写「未知作者」占位：卡片本来就该是「只有书名 + 格式」的形态，
	 *  多一行灰字只是噪声。 */
	private observeShelfThumb(card: HTMLElement, path: string, thumb: CardThumb, excerpt: HTMLElement, title: HTMLElement, extension: string): void {
		const loader = this.actions.loadBookPreview;
		if (!loader) return;
		this.cardThumbs.observe(card, () => {
			void loader(path).then(preview => {
				if (!card.isConnected) return;
				this.shelfPreviews.set(card, preview);
				if (preview.title) title.setText(preview.title);
				const line = bookMetaLine(extension, preview.author);
				if (line) {
					excerpt.setText(line);
					excerpt.removeClass("is-hidden");
				}
				if (preview.coverUrl) showCardThumb(thumb, preview.coverUrl);
			}).catch(() => { /* 读不出来就当这本书没有封面也没有作者 */ });
		});
	}

	/** 笔记卡：可见时才读正文找图（`resolveNoteThumb` 自带缓存 + 并发去重）。 */
	private attachNoteThumb(card: HTMLElement, path: string, thumb: CardThumb): void {
		const resolve = this.actions.resolveNoteThumb;
		if (!resolve) return;
		this.cardThumbs.observe(card, () => {
			void resolve(path).then(url => {
				if (!card.isConnected || !url) return;
				// 缩略图就位会让卡片变高：置顶组是限高 + 组内滚动，不重钉一次组高就会溢出。
				showCardThumb(thumb, url, () => resettleStarredGroupHeight(card));
			}).catch(() => { /* 无图 → 保持全宽文字 */ });
		});
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
		for (const rec of this.bookmarkPageEls) this.paintBookmarkPage(rec.el, rec.anchor, rec.contextKey);
	}

	/** 把现算页码写进书签行的页码胶囊；算不出（书未就绪/畸形 token）时整块隐藏。 */
	private paintBookmarkPage(el: HTMLElement, anchor: string, contextKey: string | null = null): void {
		if (anchor.startsWith("audio:")) {
			const seconds = Number(anchor.slice("audio:".length));
			const label = formatMediaDuration(Number.isFinite(seconds) ? seconds : 0);
			el.setText(label || "时间点");
			el.setAttribute("aria-label", `播客时间点 ${label}`);
			el.removeClass("is-hidden");
			return;
		}
		let res: { page: number; total: number } | null = null;
		try { res = this.actions.getPageForAnchor?.(anchor, contextKey) ?? null; } catch { res = null; }
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

	/** 数据是宿主「现算」的（markdown 笔记的官方高亮没有旁车文件）：外部数据变化
	 *  （删除 / 新划高亮 / 切换笔记）后调用，仅当面板开着且正停在标注页才重算重绘。 */
	refreshAnnotations(data?: AnnotationFileData): void {
		if (!this.isOpen() || this.mode !== "annotations" || this.annotationLoadingKey) return;
		if (data) this.annotationData = data;
		else if (this.actions.provideAnnotationData) this.annotationData = this.actions.provideAnnotationData();
		this.renderAnnotations();
	}

	private highlightRow(h: StoredHighlight, contextKey: string | null): HTMLElement {
		const li = this.listEl.createEl("li", { cls: "unreader-anno-row unreader-anno-row--highlight" });
		li.dataset.scrollKey = `highlight:${contextKey ?? ""}:${h.id}`;
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
				this.actions.onJump(h.anchor, h.text, contextKey);
				return;
			}
			if (me.metaKey || me.ctrlKey) {
				e.stopPropagation();
				clearClickTimer();
				this.actions.onJump(h.anchor, h.text, contextKey);
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
				this.actions.onJump(h.anchor, h.text, contextKey);
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
		expandBtn.setAttribute("aria-label", "展开高亮全文和评论");
		expandBtn.setAttribute("title", "展开高亮全文和评论");
		const needsExpand = (h.text && h.text.length > 90) || !!h.comment;
		// ⚠️ 上面的字符数阈值只是**插入前的兜底**，真正说了算的是 `settleExpandButtons()`
		// 的**实测**判据。原因：截断来自 CSS 的 `-webkit-line-clamp: 3`，行数随抽屉宽度与
		// 字号变化 —— 330px 抽屉 / 13px 字号下 3 行只有 ~66~72 字，于是 72~90 字的高亮
		// **已经被截断，却因为「没超过 90 字」永远拿不到 ∨**（2026-10-12 用户报「电子书 /
		// RSS 的高亮卡片都能展开，markdown 的不能」）。md 侧没有旁车评论、判据只剩长度，
		// 阅读器侧常有评论兜底 ⇒ 同一段文字在两边表现分裂，看着就是"md 不能展开"。
		// 用字符数猜"有没有被截断"在原理上就不可能对：宽度不同、字号可调、中英文混排。
		if (!needsExpand) expandBtn.addClass("is-hidden");
		expandBtn.addEventListener("click", e => {
			e.stopPropagation();
			const expanded = li.classList.toggle("is-expanded");
			li.toggleClass("is-collapsed", !expanded);
			expandBtn.setAttribute("aria-label", expanded ? "收起高亮全文和评论" : "展开高亮全文和评论");
			expandBtn.setAttribute("title", expanded ? "收起高亮全文和评论" : "展开高亮全文和评论");
			try { setIcon(expandBtn, expanded ? "chevron-up" : "chevron-down"); } catch { expandBtn.setText(expanded ? "∧" : "∨"); }
			expandBtn.toggleClass("is-active", expanded);
		});
		// 评论按钮：点击后在高亮卡片内部嵌入评论框（与卡片同为一体，但又清晰区分）。
		// 宿主显式声明不支持评论（markdown 官方 `==` 高亮无旁车评论落点）时整颗不渲染，
		// 不留「点了没反应」的死按钮；已有评论文本仍照常显示（数据兼容）。
		const commentsEnabled = this.actions.isCommentEnabled?.() ?? true;
		let commentBtn: HTMLElement | null = null;
		if (commentsEnabled) {
			commentBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
			try { setIcon(commentBtn, "message-square"); } catch { commentBtn.setText("评"); }
			commentBtn.setAttribute("aria-label", "编辑这条高亮的评论");
			commentBtn.setAttribute("title", "编辑这条高亮的评论");
			commentBtn.addEventListener("click", e => {
				e.stopPropagation();
				this.toggleCommentEditor(li, h, contextKey);
			});
		}
		// 复制按钮：复制高亮文字（含评论）
		const copyBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		setIcon(copyBtn, "copy");
		copyBtn.setAttribute("aria-label", "复制高亮文字和评论");
		copyBtn.setAttribute("title", "复制高亮文字和评论");
		copyBtn.addEventListener("click", e => {
			e.stopPropagation();
			const content = h.comment ? `${h.text}\n\n${h.comment}` : h.text;
			void this.copyText(content, copyBtn);
		});
		// 复制引用：原文 + 书名 + 章节标题 + 溯源笔记链接（给 AI 溯源用）
		const refBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		try { setIcon(refBtn, "quote"); } catch { refBtn.setText("引"); }
		refBtn.setAttribute("aria-label", "复制高亮引用（含书名和章节）");
		refBtn.setAttribute("title", "复制高亮引用（含书名和章节）");
		refBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onCopyReference(h, contextKey);
		});
		const delBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action is-danger" });
		setIcon(delBtn, "trash-2");
		delBtn.setAttribute("aria-label", "立即删除此高亮及其评论");
		delBtn.setAttribute("title", "立即删除此高亮及其评论");
		delBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onDeleteHighlight(h.id, contextKey);
		});
		footer.addEventListener("click", e => e.stopPropagation());
		dot.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onJump(h.anchor, h.text, contextKey);
		});
		return li;
	}

	/** 按**实测溢出**重定每行的展开按钮：渲染后 / 面板打开后 / 抽屉宽度变化后都会调。
	 *
	 *  判据与 CSS 同口径（**度量口径必须跟实现走**）：摘录被 3 行 `-webkit-line-clamp`
	 *  截断 ⇔ `scrollHeight > clientHeight`。带评论的行恒可展开（评论本身也被 clamp 2 行）。
	 *  元素未参与布局（面板没开 / `display:none`）时两个高度都是 0 ⇒ **保持**渲染时按
	 *  长度兜底给出的结果，既不误藏也不误显。已经展开的行不碰 —— 按钮要留给用户收起。
	 *
	 *  2026-10-12 修复「电子书 / RSS 的高亮卡片都能展开，markdown 的不能」：旧判据是
	 *  `text.length > 90`，而真机 330px 抽屉 / 13px 字号下 3 行只有 ~70 字，72~90 字
	 *  的高亮明明被截断却拿不到 ∨。字符数猜不准截断（宽度可变、字号可调、中英混排），
	 *  只有实测才对。 */
	private settleExpandButtons(): void {
		for (const row of Array.from(this.listEl.querySelectorAll<HTMLElement>(".unreader-anno-row--highlight"))) {
			if (row.classList.contains("is-expanded")) continue;
			const btn = row.querySelector<HTMLElement>(".unreader-anno-expand");
			const ex = row.querySelector<HTMLElement>(".unreader-anno-excerpt");
			if (!btn || !ex) continue;
			const ch = ex.clientHeight;
			const sh = ex.scrollHeight;
			if (ch <= 0 || sh <= 0) continue; // 未布局：保持现值，别把按钮误藏
			const hasComment = !!row.querySelector(".unreader-anno-comment");
			btn.toggleClass("is-hidden", !(hasComment || sh > ch + 1));
		}
	}

	/** 把实测重定合并到下一帧（拖拽宽度时 `applyWidth` 每帧都会被调）。 */
	private scheduleSettleExpand(): void {
		if (this.settleRaf !== null) return;
		const win = this.containerEl.ownerDocument?.defaultView ?? window;
		this.settleRaf = win.requestAnimationFrame(() => {
			this.settleRaf = null;
			this.settleExpandButtons();
		});
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
	private toggleCommentEditor(li: HTMLElement, h: StoredHighlight, contextKey: string | null): void {
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
			this.actions.onCommentHighlight(h.id, ta.value, contextKey);
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
	private bookmarkRow(b: StoredBookmark, contextKey: string | null): HTMLElement {
		const isAudioBookmark = b.anchor.startsWith("audio:");
		const li = this.listEl.createEl("li", { cls: "unreader-anno-row unreader-anno-row--bookmark" });
		li.dataset.scrollKey = `bookmark:${contextKey ?? ""}:${b.id}`;
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
				this.actions.onJump(b.anchor, undefined, contextKey);
				return;
			}
			if (me.metaKey || me.ctrlKey) {
				e.stopPropagation();
				clearBmTimer();
				this.actions.onJump(b.anchor, undefined, contextKey);
				return;
			}
			if (bmTimer != null) {
				clearBmTimer();
				this.selectRowText(li);
				return;
			}
			bmTimer = window.setTimeout(() => {
				bmTimer = null;
				this.actions.onJump(b.anchor, undefined, contextKey);
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
		this.paintBookmarkPage(pageEl, b.anchor, contextKey);
		this.bookmarkPageEls.push({ el: pageEl, anchor: b.anchor, contextKey });
		// 与高亮卡片的色点同理：点页码也直接跳到该书签位置
		pageEl.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onJump(b.anchor, undefined, contextKey);
		});

		const actions = footer.createDiv({ cls: "unreader-anno-footer-actions" });
		const renameBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action" });
		try { setIcon(renameBtn, "pencil"); } catch { renameBtn.setText("改"); }
		renameBtn.setAttribute("aria-label", "重命名此书签");
		renameBtn.setAttribute("title", "重命名此书签");
		renameBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.toggleRenameEditor(li, b, contextKey);
		});
		const delBtn = actions.createDiv({ cls: "unreader-clickable-icon unreader-anno-action is-danger" });
		setIcon(delBtn, "trash-2");
		delBtn.setAttribute("aria-label", "立即删除此书签");
		delBtn.setAttribute("title", "立即删除此书签");
		delBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onDeleteBookmark(b.id, contextKey);
		});
		footer.addEventListener("click", e => e.stopPropagation());
		return li;
	}

	/** 就地重命名：把名称行换成输入框，Enter/失焦保存、Esc 取消。
	 *  与注释编辑同套路——不弹窗、不打断列表上下文。 */
	private toggleRenameEditor(li: HTMLElement, b: StoredBookmark, contextKey: string | null): void {
		const existing = li.querySelector<HTMLElement>(".unreader-anno-rename");
		if (existing) { this.finishRename(li, b, null, contextKey); return; }
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
				this.finishRename(li, b, input.value, contextKey);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.finishRename(li, b, null, contextKey);
			}
		});
		// 失焦即保存（点击列表其他位置时不用额外点一下「保存」）。
		// 无需防重入：finishRename 先摘掉编辑器，行已不存在时直接返回
		input.addEventListener("blur", () => this.finishRename(li, b, input.value, contextKey));
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
	private finishRename(li: HTMLElement, b: StoredBookmark, label: string | null, contextKey: string | null): void {
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
		this.actions.onRenameBookmark(b.id, next, contextKey);
	}

	isOpen(): boolean {
		return this.containerEl.hasClass("is-open");
	}

	show(): void {
		// 打开即停在标注页（md 宿主的常见路径）时现算一次数据再绘制。
		if (this.mode === "annotations" && this.actions.provideAnnotationData) {
			this.annotationData = this.actions.provideAnnotationData();
			this.renderAnnotations();
		}
		// 此刻面板必然已经进了 DOM ⇒ 补写一次宿主宽度变量。构造期两个宿主都在
		// `appendChild` 之前调 `setWidth`，那一次 parentElement 还是 null、写不进去，
		// 宿主变量会停在默认 330px（md 侧表现为「工具栏离抽屉一条缝」）。见 writeHostWidthVar。
		this.writeHostWidthVar();
		this.containerEl.addClass("is-open");
		this.actions.onOpenChange?.(true);
		// 面板可见后再实测一次：渲染那一帧元素若还没参与布局，展开按钮停在长度兜底值上。
		this.scheduleSettleExpand();
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
