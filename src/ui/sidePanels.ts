/** 侧边抽屉的**共享接线**（标注 / 书架 / 订阅 / 笔记四页）。
 *
 *  阅读器与 Markdown 阅读模式用的是**同一个** `AnnotationsPanel`、同一套页面、同一份接线；
 *  差异只在 `SidePanelsHost` 适配器里：
 *  · `modes` 决定哪几页出现 —— Markdown 侧没有「当前这本书的标注」上下文，那一页不出现
 *    （用户 2026-10-09：能适配的适配上，不能适配的就去掉）；
 *  · 每个动作都由 host 给实现。宿主给不出实现 = 这一项不适配，就**别把它放进 modes**，
 *    绝不允许出现「按钮在、点了没反应」。
 *
 *  ⚠️ 这里只做「接线」不做「逻辑」：抓全文、保存笔记、刷新订阅这些重活仍走
 *  `core/` 里的既有实现（宿主注入），避免两处各写一份迟早漂移。 */

import { TFile, type App } from "obsidian";
import { AnnotationsPanel, type AnnotationsPanelActions } from "./annotationsPanel";
import { getBookshelfEntries, sortBookshelfEntries } from "../core/bookService";
import { loadBookPreview } from "../core/bookPreview";
import { createFeedThumbResolver, createNoteThumbResolver } from "../core/cardThumbSources";
import { revealFileInFolder } from "../core/fileReveal";
import { openExternalLink } from "../core/externalLink";
import type { AnnotationFileData, StoredBookmark, StoredHighlight } from "../core/annotationStore";
import type { BookshelfCategoryFilter, FeedEntryKind, FeedFilter } from "../types";
import type UNreaderPlugin from "../main";

/** 抽屉里可以出现哪几页。 */
export type SidePanelMode = "annotations" | "bookshelf" | "feeds" | "notes";

export interface SidePanelsHost {
	app: App
	plugin: UNreaderPlugin
	/** 这个宿主上允许出现的页（顺序即按钮顺序）。 */
	modes: SidePanelMode[]
	/** 宿主的本地筛选态（阅读器与 Markdown 各自持有，互不串）。 */
	state: {
		bookshelfCategoryFilter: BookshelfCategoryFilter
		feedFilter: FeedFilter
		feedSourceFilter: string | null
	}
	/** 当前正在看的文档名（头部标题；没有打开内容时返回 null）。 */
	getCurrentDocumentName?: () => string | null
	/** 当前正打开的书籍路径（书架卡片高亮；Markdown 侧恒 null）。 */
	getCurrentBookPath?: () => string | null
	/** 当前正打开的订阅文章（订阅卡片高亮；Markdown 侧恒 null）。 */
	getCurrentFeedEntry?: () => { feedId: string; entryId: string; kind?: FeedEntryKind } | null
	/** 面板开合（宿主据此同步工具栏高亮 / 轨道位置）。 */
	onOpenChange?: (open: boolean) => void
	onModeChange?: (mode: SidePanelMode) => void
	/** 鼠标悬浮自动关闭的临时挂起（菜单打开期间用）。 */
	onHoldAutoClose?: (hold: boolean) => void
	onHeightChange?: (px: number | null) => void
	onWidthChange?: (px: number | null) => void
	/** 钉住（置顶）侧边栏。面板只负责转发「点了钉子」；**钉住后的布局是宿主各自的事**
	 *  （阅读器让 `.unreader-body` 变 flex 行，md 侧走 `.unreader-md-view.is-side-pinned`）。
	 *  不给 = 钉子点了没反应，但面板仍会渲染它（与 `AnnotationsPanel` 的可选回调同义）。 */
	onTogglePin?: () => void

	// ── 书架页 ──
	/** 打开一本书。不给 = 书架卡片点了没反应，此时别把 bookshelf 放进 modes。 */
	openBook?: (path: string) => void
	/** 打开书籍前的收尾（阅读器：记住停留页）。 */
	beforeOpenBook?: () => void

	// ── 订阅页 ──
	openFeedEntry?: (feedId: string, entryId: string) => void
	toggleFeedStar?: (feedId: string, entryId: string, panel: AnnotationsPanel) => void
	refreshFeeds?: (panel: AnnotationsPanel) => void
	saveNote?: (feedId: string, entryId: string, panel: AnnotationsPanel) => void
	queuePodcastProgress?: (feedId: string, entryId: string, seconds: number, duration: number) => void

	// ── 标注页（阅读器给全量；markdown 宿主只给高亮相关项）──
	annotation?: {
		data: () => AnnotationFileData
		onJump: (anchor: string, textHint?: string) => void
		onPreview: (item: StoredHighlight, anchorEl: HTMLElement) => void
		onComment: (id: number, comment: string) => void
		onCopyReference: (item: StoredHighlight) => void
		onDeleteHighlight: (id: number) => void
		onDeleteBookmark: (id: number) => void
		onRenameBookmark: (id: number, label: string) => void
		getPageForAnchor: (anchor: string) => { page: number; total: number } | null
		/** 不给 = 评论可用（书 / RSS）；md 官方高亮无旁车评论 → false。 */
		commentEnabled?: () => boolean
	}
}

/** 建好一个接满线、不会出现死按钮的侧边抽屉。调用方负责 append `containerEl` 与开合。 */
export function createSidePanel(host: SidePanelsHost): AnnotationsPanel {
	const { app, plugin } = host;
	// 标注页只有给出 annotation 适配器时才允许出现（否则整页都是死按钮）。
	const modes: SidePanelMode[] = host.modes.filter(m => m !== "annotations" || !!host.annotation);
	const a = host.annotation;

	const actions: AnnotationsPanelActions = {
		// 只开 host 允许、且适配器给得出的页；标注页缺 `annotation` 适配器时整页不出现
		// （哪怕 host.modes 里写了它）—— 这是「不许出现死按钮」的硬闸门。
		modes,

		// —— 标注页（没必要就不出现，回调给空实现只是为了让类型成立）——
		onJump: (anchor, hint) => a?.onJump(anchor, hint),
		onPreviewHighlight: (item, el) => a?.onPreview(item, el),
		onCommentHighlight: (id, comment) => a?.onComment(id, comment),
		onCopyReference: item => a?.onCopyReference(item),
		onDeleteHighlight: id => a?.onDeleteHighlight(id),
		onDeleteBookmark: id => a?.onDeleteBookmark(id),
		onRenameBookmark: (id, label) => a?.onRenameBookmark(id, label),
		getPageForAnchor: anchor => a?.getPageForAnchor(anchor) ?? null,
		// md 宿主：标注页打开 / 切页时现算 `==` 高亮；书 / RSS 不给（用 render() 喂数据）。
		provideAnnotationData: a ? () => a.data() : undefined,
		isCommentEnabled: a?.commentEnabled
			? () => (a.commentEnabled as () => boolean)()
			: undefined,

		// —— 书架页 ——
		getBookshelfEntries: () => sortBookshelfEntries(
			getBookshelfEntries(plugin),
			plugin.settings.bookshelfSortMode,
			plugin.settings.bookshelfManualOrder,
		),
		getBookshelfSortMode: () => plugin.settings.bookshelfSortMode,
		getCurrentBookPath: () => host.getCurrentBookPath?.() ?? null,
		onBookshelfSortModeChange: mode => {
			plugin.settings.bookshelfSortMode = mode;
			void plugin.persistData();
			panel.setMode("bookshelf");
		},
		onBookshelfReorder: paths => {
			plugin.settings.bookshelfManualOrder = paths;
			void plugin.persistData();
			panel.setMode("bookshelf");
		},
		onToggleBookPin: path => {
			const pinned = new Set(plugin.settings.bookshelfPinned);
			if (pinned.has(path)) pinned.delete(path);
			else pinned.add(path);
			plugin.settings.bookshelfPinned = [...pinned];
			void plugin.persistData();
			panel.setMode("bookshelf");
		},
		getBookshelfCategories: () => plugin.settings.bookshelfCategories ?? [],
		getBookshelfCategoryFilter: () => host.state.bookshelfCategoryFilter,
		onBookshelfCategoryFilterChange: filter => { host.state.bookshelfCategoryFilter = filter; },
		onAssignBookCategory: (path, categoryId) => void plugin.assignBookshelfCategory(path, categoryId),
		onRemoveBookFromShelf: path => void plugin.removeBookFromBookshelf(path),
		onOpenBookshelfCategoryManager: () => plugin.openBookshelfCategoryManager(),
		onOpenBook: path => {
			host.beforeOpenBook?.();
			host.openBook?.(path);
		},
		loadBookPreview: path => {
			const file = app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) return Promise.resolve({ coverUrl: null, excerpt: null, title: null, author: null });
			return loadBookPreview(app, file);
		},

		// —— 笔记页 ——
		getMarkdownNotes: () => plugin.getMarkdownNoteListItems(),
		onOpenMarkdownNote: path => void plugin.openMarkdownNote(path),
		onToggleMarkdownNoteStar: path => plugin.toggleMarkdownNoteStar(path),
		// 「定位到文件夹」：先在应用内文件浏览器里定位、再退到系统文件管理器 ——
		// 两条通路的能力探测收口在 `core/fileReveal`（运行期 API，公开 typings 里没有）。
		onRevealMarkdownNote: path => revealFileInFolder(app, path),
		// 字数要读盘，所以是异步供给；卡片先渲染占位、拿到再回填（见 markdownNoteCards）。
		resolveNoteWordCount: path => plugin.countMarkdownNoteWords(path),
		// 两类卡片的缩略图取数：书/RSS/笔记**同一套实现**，两条装配路径都从
		// `core/cardThumbSources` 取（阅读器内联那份见 readerView.ts），避免行为分裂。
		resolveNoteThumb: createNoteThumbResolver(app),

		// —— 订阅页 ——
		getFeeds: () => plugin.feedStore.listFeeds(),
		getFeedEntries: () => plugin.feedStore.listEntries(),
		getFeedFilter: () => host.state.feedFilter,
		getFeedSourceFilter: () => host.state.feedSourceFilter,
		getCurrentFeedEntry: () => host.getCurrentFeedEntry?.() ?? null,
		onFeedFilterChange: filter => { host.state.feedFilter = filter; },
		onFeedSourceFilterChange: feedId => { host.state.feedSourceFilter = feedId; },
		resolveFeedThumb: createFeedThumbResolver(plugin),
		onOpenFeedEntry: (feedId, entryId) => host.openFeedEntry?.(feedId, entryId),
		onToggleFeedStar: (feedId, entryId) => host.toggleFeedStar?.(feedId, entryId, panel),
		onRefreshFeeds: () => host.refreshFeeds?.(panel),
		onAddFeed: () => plugin.promptAddFeed(),
		onImportOpml: () => plugin.importOpmlFromFile(),
		onOpenFeedManager: () => plugin.openFeedManager(),
		onHoldAutoClose: hold => host.onHoldAutoClose?.(hold),
		onSaveNote: (feedId, entryId) => host.saveNote?.(feedId, entryId, panel),
		onOpenOriginal: url => openExternalLink(url),
		onDownloadPodcast: (feedId, entryId) => plugin.downloadPodcast(feedId, entryId),
		onPodcastProgress: (feedId, entryId, seconds, duration) => host.queuePodcastProgress?.(feedId, entryId, seconds, duration),
		onResolvePodcastUrl: url => plugin.feedMediaStore.playableUrl(url),
		isPodcastDownloaded: url => plugin.feedMediaStore.isCached(url),
		onCheckPodcastDownloaded: url => plugin.feedMediaStore.has(url),

		// —— 通用 ——
		getCurrentDocumentName: () => host.getCurrentDocumentName?.() ?? null,
		onOpenChange: open => host.onOpenChange?.(open),
		onModeChange: mode => host.onModeChange?.(mode),
		onTogglePin: () => host.onTogglePin?.(),
		onHeightChange: px => host.onHeightChange?.(px),
		onWidthChange: px => host.onWidthChange?.(px),
	};

	const panel = new AnnotationsPanel(actions);
	return panel;
}

/** 供宿主复用的小工具：把「收藏」这类纯状态写入收在一处，避免两处各写一份。
 *  （「标记已读」原来也在这里，2026-10-13 随卡片上那枚按钮一起退役：读态只由打开
 *  文章自动记录，不再有第二条写入路径。） */
export async function toggleFeedStarState(plugin: UNreaderPlugin, feedId: string, entryId: string): Promise<void> {
	const entry = plugin.feedStore.getEntry(feedId, entryId);
	if (!entry) return;
	await plugin.feedStore.updateEntryState(feedId, entryId, {
		starredAt: entry.state.starredAt ? null : Date.now(),
	});
}

/** 「标注数据」由宿主注入版本：这里给 `AnnotationsPanel` 用的空实现占位类型。 */
export type { StoredBookmark, StoredHighlight };
