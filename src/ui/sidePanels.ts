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

import { Menu, Notice, Platform, TFile, type App, type TAbstractFile } from "obsidian";
import { AnnotationsPanel, type AnnotationsPanelActions } from "./annotationsPanel";
import { getBookshelfEntries, sortBookshelfEntries } from "../core/bookService";
import { loadBookPreview } from "../core/bookPreview";
import { createFeedThumbResolver, createNoteThumbResolver } from "../core/cardThumbSources";
import { resolveNoteExcerpt } from "../core/noteExcerpt";
import { revealFileInFolder } from "../core/fileReveal";
import { openExternalLink } from "../core/externalLink";
import { canApplyNativeSidebarAnnotationAction } from "../core/nativeSidebarState";
import type { AnnotationFileData, StoredBookmark, StoredHighlight } from "../core/annotationStore";
import type { BookshelfCategoryFilter, FeedEntryKind, FeedFilter } from "../types";
import type UNreaderPlugin from "../main";

interface NativeFileExplorerMenuView {
	onFileContextMenu?: (event: MouseEvent, file: TFile) => void
}

/** 拆掉原生菜单的「锚元素」——**移动端「⋯ 菜单打开后自己关掉」的根因**（2026-10-17 真机报障）。
 *
 *  从 asar（`/Applications/Obsidian.app/Contents/Resources/obsidian.asar` 的 `app.js`）里挖出来的
 *  实际调用链，File Explorer 的 `onFileContextMenu` 做三件事：
 *    ```js
 *    workspace.trigger("file-menu", menu, file, "file-explorer-context-menu", null);
 *    const item = this.fileItems[file.path];
 *    item && menu.setParentElement(item.selfEl);     // ← 锚到文件树里那一项
 *    menu.showAtMouseEvent(event);
 *    ```
 *  而 `Menu.showAtPosition` 里：
 *    ```js
 *    this.parentEl && (this.parentEl.addClass("has-active-menu"), fE(this.parentEl, 500, () => this.hide()));
 *    ```
 *  `fE(el, 500, cb)` 的实现是 **`setInterval(…, 500)` 轮询** `!el.isShown()` —— 锚元素一旦
 *  不可见就 `hide()`。桌面端文件浏览器里那一项通常可见，所以看不出问题；我们的卡片是从
 *  抽屉里弹菜单的，文件树里的对应项常常不可见（文件夹折叠 / 移动端文件抽屉已收起）⇒
 *  **菜单 0.5 秒后自己消失**。电子书与 Markdown 走同一条路，所以两处一起中招；
 *  ⋯ 按钮与长按（contextmenu）也是同一个出口，所以两种打开方式都一样。
 *
 *  修法只作用于**我们弹出的这一个实例**：包一层 `showAtMouseEvent` / `showAtPosition`，
 *  在原生实现执行前把 `parentEl` 清掉（原生是**假值判断**，清成 null 即跳过整段轮询）。
 *  不改 `Menu.prototype`，不碰别的菜单；菜单的关闭仍由面板遮罩（移动端）/
 *  全局点外部（桌面端）负责，那是另一条路径，与 `parentEl` 无关。
 *
 *  ⚠️ 这是**上游实现细节**的适配：升级 Obsidian 后要重新对一遍 asar。判据不是「菜单能开」，
 *  而是「**0.5 秒后它还开着**」—— 只断前者会把这条静默回归放过去。 */
export function detachNativeMenuAnchor(menu: Menu): void {
	const clear = (): void => {
		// 官方类型是 `setParentElement(el: HTMLElement)`，不接受 null；但实现里是
		// `this.parentEl && …` 的假值判断 ⇒ 传 null 既安全、也是唯一能清掉它的方式。
		menu.setParentElement(null as unknown as HTMLElement);
	};
	const nativeMouse = menu.showAtMouseEvent.bind(menu);
	menu.showAtMouseEvent = (event: MouseEvent) => {
		clear();
		return nativeMouse(event);
	};
	// 兜底：万一上游哪天改成直接调 `showAtPosition`（当前不是），这一层同样拦住。
	const nativePosition = menu.showAtPosition.bind(menu);
	menu.showAtPosition = (position, doc) => {
		clear();
		return nativePosition(position, doc);
	};
}

/** 运行时才有的 FileManager 方法（公开 typings 里没有；Obsidian 自己的「重命名」面板就走它，
 *  见 asar 里 `e.prototype.promptForFileRename` + 链接右键菜单 `fileManager.promptForFileRename(file)`）。
 *  按可选能力探测：拿不到就不渲染那一项，绝不留死按钮。 */
interface FileManagerInternals {
	promptForFileRename?: (file: TAbstractFile) => unknown
}

async function copyPlainText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		/* 无剪贴板权限 / 非安全上下文：静默（卡片上的「复制路径」同一口径） */
	}
}

/** 菜单打开期间让卡片的动作组保持显形（指针移开后按钮不会缩回去）。
 *  原生路径与兜底路径**都要调用** —— 少一处就是「同一个按钮，两种打开方式两个样子」。 */
function markCardMenuOpen(menu: Menu, event: MouseEvent): void {
	const card = (event.target as HTMLElement | null)?.closest<HTMLElement>(".unreader-shelf-card, .unreader-note-card, .unreader-feed-card");
	if (!card) return;
	card.classList.add("unreader-card-menu-open");
	menu.onHide(() => card.classList.remove("unreader-card-menu-open"));
}

/** 文件浏览器不在时复刻的原生菜单项（图标名与 asar 里原生实现对齐）。
 *
 *  只复刻**文件菜单里真的存在、且用户在这里用得上**的项：打开 / 新标签页 / 在右侧打开 /
 *  复制路径 / 重命名 / 在文件浏览器中显示 / 删除。不搬「新建笔记 / 新建文件夹 / 排序方式」
 *  那些**属于文件树本身**的项 —— 它们在一张书籍卡上点出来只会是噪声。 */
function addFallbackFileItems(app: App, menu: Menu, file: TFile): void {
	menu.addItem(item => item
		.setSection("open")
		.setTitle("打开")
		.setIcon("file")
		.onClick(() => { void app.workspace.openLinkText(file.path, "", false); }));
	menu.addItem(item => item
		.setSection("open")
		.setTitle("在新标签页中打开")
		.setIcon("file-plus")
		.onClick(() => { void app.workspace.openLinkText(file.path, "", "tab"); }));
	if (!Platform.isMobile) {
		// 原生也有 `Qy.canSplit` 闸门：手机上没有「在右侧打开」这回事。
		menu.addItem(item => item
			.setSection("open")
			.setTitle("在右侧打开")
			.setIcon("separator-vertical")
			.onClick(() => { void app.workspace.openLinkText(file.path, "", "split"); }));
	}
	menu.addItem(item => item
		.setSection("action")
		.setTitle("复制文件路径")
		.setIcon("copy")
		.onClick(() => { void copyPlainText(file.path); }));
	const rename = (app.fileManager as unknown as FileManagerInternals | undefined)?.promptForFileRename;
	if (typeof rename === "function") {
		menu.addItem(item => item
			.setSection("action")
			.setTitle("重命名")
			.setIcon("pencil")
			.onClick(() => { void rename.call(app.fileManager, file); }));
	}
	menu.addItem(item => item
		.setSection("action")
		.setTitle("在文件浏览器中显示")
		.setIcon("folder-open")
		.onClick(() => { revealFileInFolder(app, file.path); }));
	menu.addItem(item => item
		.setSection("danger")
		.setTitle("删除")
		.setIcon("trash-2")
		.setWarning(true)
		.onClick(() => { void app.fileManager.promptForDeletion(file); }));
}

/** 兜底菜单的**可测入口**（`test:menu-anchor` 直接构造它并逐项核对）。
 *  导出的理由：`showFileMenu` 是私有函数，而「文件浏览器不在时菜单还有哪些项」是这次
 *  修法的核心契约 —— 靠源码字符串断言不出「项真的齐」。 */
export function buildFallbackFileMenu(app: App, file: TFile): Menu {
	const menu = new Menu();
	addFallbackFileItems(app, menu, file);
	return menu;
}

/** ⋯ / 右键菜单的**唯一出口**（书卡与笔记卡共用）。
 *  ① 文件浏览器在 → 借它构造**原生**菜单（项最全，与文件树右键逐项一致）；
 *  ② 文件浏览器不在 → **自己构造等价菜单**（见下方 `if` 里的分支）。
 *
 *  ② 存在的理由（用户 2026-10-17：「obsidian 可能文件列表没打开，所以三个点的功能实现失败」）：
 *  旧实现硬依赖 `getLeavesOfType("file-explorer")[0]`，而那条 leaf 在移动端（文件抽屉不常驻）
 *  和桌面（文件面板换成别的标签、或从没打开过）都可能**根本不存在** —— 于是 ⋯ 只能弹一句
 *  「请确认文件浏览器已启用」，一个用户明明能用的功能被判死。
 *  菜单内容本来就不需要那个 view：Obsidian 自己的「链接右键菜单」也是在任意视图里
 *  `new Menu()` + 自己 addItem + `trigger("file-menu", …)`，这里照同一条路复刻常用项。 */
function showFileMenu(
	app: App,
	file: TFile,
	event: MouseEvent,
	addPluginItems?: (menu: Menu) => void,
): void {
	const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
	const view = leaf?.view as unknown as NativeFileExplorerMenuView | undefined;
	if (!view?.onFileContextMenu) {
		// ② 兜底：与原生菜单走**同一个事件名**，其它插件照样能把项加进来
		// （只少了文件浏览器 view 自己那几项 —— 那些由 `buildFallbackFileMenu` 复刻）。
		const fallback = buildFallbackFileMenu(app, file);
		addPluginItems?.(fallback);
		markCardMenuOpen(fallback, event);
		app.workspace.trigger("file-menu", fallback, file, "file-explorer-context-menu", null);
		fallback.showAtMouseEvent(event);
		return;
	}
	const workspace = app.workspace;
	const nativeTrigger = workspace.trigger.bind(workspace);
	workspace.trigger = ((name: string, ...args: unknown[]) => {
		const result = nativeTrigger(name as never, ...args as never[]);
		if (name === "file-menu" && args[1] === file && args[2] === "file-explorer-context-menu") {
			// 这里拿到的 `args[0]` 就是原生刚建好的那个 Menu 实例 —— 原生紧接着才会
			// `setParentElement(...)` 并 `showAtMouseEvent(...)`，所以在这一刻拆锚有效。
			detachNativeMenuAnchor(args[0] as Menu);
			// 菜单由 Obsidian 挂到 body，指针离开卡片后仍保留动作组，直到原生菜单关闭。
			markCardMenuOpen(args[0] as Menu, event);
			addPluginItems?.(args[0] as Menu);
		}
		return result;
	}) as typeof workspace.trigger;
	try {
		view.onFileContextMenu.call(view, event, file);
	} catch (error) {
		console.error("[UNreader] 打开 Obsidian 原生文件菜单失败", error);
		new Notice("无法打开 Obsidian 原生文件菜单");
	} finally {
		workspace.trigger = nativeTrigger;
	}
}

/** 抽屉里可以出现哪几页。 */
export type SidePanelMode = "annotations" | "bookshelf" | "feeds" | "notes";

export interface SidePanelAnnotationContext {
	key?: string
	data: () => AnnotationFileData
	onJump: (anchor: string, textHint?: string) => void
	onPreview: (item: StoredHighlight, anchorEl: HTMLElement) => void
	onComment: (id: number, comment: string) => void
	onCopyReference: (item: StoredHighlight) => void
	onDeleteHighlight: (id: number) => void
	onDeleteBookmark: (id: number) => void
	onRenameBookmark: (id: number, label: string) => void
	getPageForAnchor: (anchor: string) => { page: number; total: number } | null
	commentEnabled?: () => boolean
}

export interface NativeSidebarContext {
	key: string
	kind: "book" | "feed" | "markdown"
	title: string
	pickerMode: Exclude<SidePanelMode, "annotations">
	bookPath?: string
	feedRef?: { feedId: string; entryId: string; kind?: FeedEntryKind }
	markdownPath?: string
	annotation: SidePanelAnnotationContext
}

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
	/** 原生侧栏标注适配器会随当前内容变化；Markdown 宿主可继续提供固定适配器。 */
	getAnnotationContext?: () => SidePanelAnnotationContext | null
	onRequestHome?: () => void
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
	openMarkdownNote?: (path: string) => void
	/** 打开书籍前的收尾（阅读器：记住停留页）。 */
	beforeOpenBook?: () => void

	// ── 订阅页 ──
	openFeedEntry?: (feedId: string, entryId: string) => void
	toggleFeedStar?: (feedId: string, entryId: string, panel: AnnotationsPanel) => void
	refreshFeeds?: (panel: AnnotationsPanel) => void
	saveNote?: (feedId: string, entryId: string, panel: AnnotationsPanel) => void
	queuePodcastProgress?: (feedId: string, entryId: string, seconds: number, duration: number) => void

	// ── 标注页（阅读器给全量；markdown 宿主只给高亮相关项）──
	annotation?: SidePanelAnnotationContext
}

/** 建好一个接满线、不会出现死按钮的侧边抽屉。调用方负责 append `containerEl` 与开合。 */
export function createSidePanel(host: SidePanelsHost): AnnotationsPanel {
	const { app, plugin } = host;
	const getAnnotation = (): SidePanelAnnotationContext | null => host.getAnnotationContext?.() ?? host.annotation ?? null;
	// 原生侧栏有动态供给器，即使当前没有正文，也能显示清楚的空标注页。
	const modes: SidePanelMode[] = host.modes.filter(m => m !== "annotations" || !!host.annotation || !!host.getAnnotationContext);
	const guardAnnotation = (key: string | null | undefined): SidePanelAnnotationContext | null => {
		const current = getAnnotation();
		if (!current || (key != null && !canApplyNativeSidebarAnnotationAction(key, current.key ?? null))) return null;
		return current;
	};

	const actions: AnnotationsPanelActions = {
		// 只开 host 允许、且适配器给得出的页；标注页缺 `annotation` 适配器时整页不出现
		// （哪怕 host.modes 里写了它）—— 这是「不许出现死按钮」的硬闸门。
		modes,

		// —— 标注页（没必要就不出现，回调给空实现只是为了让类型成立）——
		onJump: (anchor, hint, key) => guardAnnotation(key)?.onJump(anchor, hint),
		onPreviewHighlight: (item, el, key) => guardAnnotation(key)?.onPreview(item, el),
		onCommentHighlight: (id, comment, key) => guardAnnotation(key)?.onComment(id, comment),
		onCopyReference: (item, key) => guardAnnotation(key)?.onCopyReference(item),
		onDeleteHighlight: (id, key) => guardAnnotation(key)?.onDeleteHighlight(id),
		onDeleteBookmark: (id, key) => guardAnnotation(key)?.onDeleteBookmark(id),
		onRenameBookmark: (id, label, key) => guardAnnotation(key)?.onRenameBookmark(id, label),
		getPageForAnchor: (anchor, key) => guardAnnotation(key)?.getPageForAnchor(anchor) ?? null,
		getAnnotationContextKey: host.getAnnotationContext ? () => getAnnotation()?.key ?? null : undefined,
		// md 宿主 / 原生侧栏：标注页打开或重绘时现算；书 / RSS 由调用方 render() 喂数据。
		provideAnnotationData: host.annotation || host.getAnnotationContext
			? () => getAnnotation()?.data() ?? { highlights: [], bookmarks: [] }
			: undefined,
		isCommentEnabled: () => getAnnotation()?.commentEnabled?.() ?? true,
		onRequestHome: host.onRequestHome,

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
		onOpenBookAnnotations: path => void plugin.openAnnotationsFromNativeSidebar(`book:${path}`),
		loadBookPreview: path => {
			const file = app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) return Promise.resolve({ coverUrl: null, excerpt: null, title: null, author: null });
			return loadBookPreview(app, file);
		},

		// —— 笔记页 ——
		getMarkdownNotes: () => plugin.getMarkdownNoteListItems(),
		onOpenMarkdownNote: path => {
			if (host.openMarkdownNote) host.openMarkdownNote(path);
			else void plugin.openMarkdownNote(path);
		},
		onOpenMarkdownAnnotations: path => void plugin.openAnnotationsFromNativeSidebar(`markdown:${path}`),
		onFileContextMenu: (path, event, kind) => {
			showVaultFileMenu(app, plugin, path, event, kind);
		},
		onToggleMarkdownNotePin: path => plugin.toggleMarkdownNotePin(path),
		// 「定位到文件夹」：先在应用内文件浏览器里定位、再退到系统文件管理器 ——
		// 两条通路的能力探测收口在 `core/fileReveal`（运行期 API，公开 typings 里没有）。
		onRevealMarkdownNote: path => revealFileInFolder(app, path),
		// 字数要读盘，所以是异步供给；卡片先渲染占位、拿到再回填（见 markdownNoteCards）。
		resolveNoteWordCount: path => plugin.countMarkdownNoteWords(path),
		// 笔记卡标题下的正文预览（2026-10-17）：读盘抽一段 markdown + 官方渲染器画出来。
		// 两条装配路径（这里与 readerView 内联那份）都必须接，否则分屏时两处卡片会分裂。
		resolveNoteExcerpt: path => resolveNoteExcerpt(app, path),
		renderNoteMarkdown: (el, markdown, path) => plugin.renderNotePreview(el, markdown, path),
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
		onOpenFeedAnnotations: (feedId, entryId) => void plugin.openAnnotationsFromNativeSidebar(`feed:${feedId}:${entryId}`),
		onFeedContextMenu: (feedId, entryId, event) => {
			showFeedEntryMenu(plugin, feedId, entryId, event, {
				refreshFeeds: () => panel.refreshFeeds(),
				holdAutoClose: host.onHoldAutoClose,
				saveNote: (id, entry) => host.saveNote?.(id, entry, panel),
			});
		},
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

/** 电子书 / Markdown 笔记卡片：右键与卡片最右那枚 ⋯ **共用这一份菜单**。
 *
 *  为什么这两类有 ⋯ 而 RSS 没有（用户 2026-10-17 定稿）：书本和笔记在 vault 里是真实
 *  文件，能弹 Obsidian 的**原生文件菜单**；RSS 条目只是缓存里的一条记录，没有可右键的
 *  文件，给它一枚 ⋯ 只会点出一堆无意义的通用项 —— 所以 RSS 卡不渲染 ⋯。
 *  只有电子书追加 UNreader 的分类/移除项（标记文件靠它管理书架归属）。 */
export function showVaultFileMenu(
	app: App,
	plugin: UNreaderPlugin,
	path: string,
	event: MouseEvent,
	kind: "book" | "markdown",
): void {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile)) { new Notice("文件已移动或删除，请刷新侧栏"); return; }
	showFileMenu(app, file, event, kind === "book" ? menu => {
		menu.addSeparator();
		const pinned = new Set(plugin.settings.bookshelfPinned ?? []);
		menu.addItem(item => item.setTitle(pinned.has(path) ? "取消 UNreader 置顶" : "UNreader 置顶").setIcon("pin").onClick(() => {
			const next = new Set(plugin.settings.bookshelfPinned ?? []);
			if (next.has(path)) next.delete(path); else next.add(path);
			plugin.settings.bookshelfPinned = [...next]; void plugin.persistData(); plugin.refreshNativeSidebarBookshelf();
		}));
		const categories = plugin.settings.bookshelfCategories ?? [];
		for (const category of categories) menu.addItem(item => item.setTitle(`UNreader 分类：${category.name}`).setIcon("folder").onClick(() => void plugin.assignBookshelfCategory(path, category.id)));
		menu.addItem(item => item.setTitle("UNreader：取消分类").setIcon("folder-minus").onClick(() => void plugin.assignBookshelfCategory(path, null)));
		menu.addItem(item => item.setTitle("UNreader：从书架移除（保留文件）").setIcon("eye-off").onClick(() => void plugin.removeBookFromBookshelf(path)));
	} : undefined);
}

/** RSS 条目操作菜单：**只由卡片右键触发**（2026-10-17 用户：RSS 条目不是 vault 文件，
 *  卡片上不给 ⋯，右键菜单留着即可）。
 *
 *  两个宿主的装配路径不同（原生侧栏走 `createSidePanel`、阅读器抽屉走 readerView 内联
 *  装配），菜单内容在这里收口，避免两处各写一份迟早漂移。
 *  定位用 `showAtMouseEvent` —— 右键事件本身就是 MouseEvent。 */
export function showFeedEntryMenu(
	plugin: UNreaderPlugin,
	feedId: string,
	entryId: string,
	event: MouseEvent,
	ctx: {
		refreshFeeds: () => void
		holdAutoClose?: (hold: boolean) => void
		saveNote?: (feedId: string, entryId: string) => void
	},
): void {
	const entry = plugin.feedStore.getEntry(feedId, entryId);
	if (!entry) { new Notice("文章不存在或已被清理，请刷新订阅列表"); return; }
	const menu = new Menu();
	const card = (event.target as HTMLElement | null)?.closest<HTMLElement>(".unreader-feed-card");
	if (card) card.classList.add("unreader-card-menu-open");
	ctx.holdAutoClose?.(true);
	menu.addItem(item => item
		.setTitle(entry.state.starredAt ? "取消收藏" : "收藏文章")
		.setIcon("star")
		.onClick(() => { void toggleFeedStarState(plugin, feedId, entryId).then(ctx.refreshFeeds); }));
	if (entry.url) menu.addItem(item => item
		.setTitle("在系统浏览器打开原文")
		.setIcon("external-link")
		.onClick(() => openExternalLink(entry.url!)));
	menu.addItem(item => item
		.setTitle("保存为 Markdown")
		.setIcon("file-down")
		.onClick(() => ctx.saveNote?.(feedId, entryId)));
	menu.onHide(() => {
		ctx.holdAutoClose?.(false);
		card?.classList.remove("unreader-card-menu-open");
	});
	menu.showAtMouseEvent(event);
}

/** 「标注数据」由宿主注入版本：这里给 `AnnotationsPanel` 用的空实现占位类型。 */
export type { StoredBookmark, StoredHighlight };
