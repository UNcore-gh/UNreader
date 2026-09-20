/**
 * Reader appearance. `null` means "follow the current Obsidian theme"
 * and gets resolved at runtime (matching reading-mode typography).
 */
export interface AppearanceSettings {
	/** 字体 id：`custom:<库内字体文件路径>`（见 fontService）；null = 跟随 Obsidian 主题字体。
	 *  历史上曾用过内置预设 id（sans/song/kai/lxgw），现已不再产生，引擎只认自定义注册表。 */
	fontFamily: string | null
	fontSize: number | null      // px
	lineHeight: number | null    // unitless
	letterSpacing: number | null // em
	paragraphSpacing: number | null // em, gap between <p> blocks
	/** 段首缩进字符数（em 计，随字号自动缩放；0 = 不缩进，默认 2） */
	paragraphIndent: number
	marginLeft: number | null    // px, null = 48
	marginRight: number | null   // px
	/** 阅读区配色：浅色/深色分别保存，用户可在外观设置中自定义 */
	theme: "light" | "dark" | "auto" // auto = 跟随 Obsidian 明暗
	/** 配色来源：obsidian = 背景与文字直接跟随 Obsidian 主题变量；
	 *  custom = 使用下面四项自定义色值 */
	colorMode: "obsidian" | "custom"
	backgroundColor: string | null // 浅色背景 hex
	textColor: string | null       // 浅色文字 hex
	darkBackgroundColor: string | null // 深色背景
	darkTextColor: string | null       // 深色文字
	/** 背景图片（shared:image/<文件> / http URL；旧版兼容 data URI / 库内路径），null = 纯色背景；深浅共用 */
	backgroundImage: string | null
	/** 背景图片作用范围：shared=深浅共用 backgroundImage；separate=深浅分别用下面两个字段 */
	bgImageMode: "shared" | "separate"
	/** 浅色模式背景图（bgImageMode=separate 时生效） */
	backgroundImageLight: string | null
	/** 深色模式背景图（bgImageMode=separate 时生效） */
	backgroundImageDark: string | null
	/** 图片模糊度（px），仅模糊图片层，不影响文字 */
	imageBlur: number
	/** 玻璃效果：文字层半透明 + backdrop blur，保证图片上文字可读 */
	glassEnabled: boolean
	/** 玻璃模糊半径（px） */
	glassBlur: number
	/** 玻璃底色不透明度（0-1） */
	glassOpacity: number
	/** 是否显示右侧章节短横轨（浮动目录条）；目录面板始终可由按钮/命令唤起 */
	showTocRail: boolean
	/** 是否显示章节进度条（页面顶部的极简细条） */
	chapterProgress: boolean
	/** 常态模式：工具栏默认参与显示。关闭后默认完全隐藏，但点击正文仍可临时唤出。 */
	normalModeShowToolbar: boolean
	/** 常态模式：滚动方向是否自动隐藏/唤出工具层。 */
	normalModeScrollHide: boolean
	/** 常态模式滚动隐藏时，是否连 Obsidian 页首/底栏一起接管。 */
	normalModeHideNativeChrome: boolean
	/** 全沉浸模式：是否保留浮动目录短轨及其面板。 */
	fullImmersionShowTocRail: boolean
	/** 全沉浸模式：是否保留章节进度条。 */
	fullImmersionShowChapterProgress: boolean
	/** 全沉浸模式：点击正文时是否临时显示常态工具层与原生界面。 */
	fullImmersionTapReveal: boolean
	/** 打开书籍时自动展开浮动目录面板（默认关闭，只打开正文） */
	autoOpenToc: boolean
	/** 浮动按钮框/目录条大小倍率（1 = 标准；作用于左缘功能按钮排与右缘章节短横轨） */
	railScale: number
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
	// 默认跟随 Obsidian 系统字体（null）；用户可从 Fonts 文件夹选自定义字体
	fontFamily: null,
	fontSize: 17,
	lineHeight: 1.65,
	letterSpacing: 0.02,
	paragraphIndent: 2,
	paragraphSpacing: 1,
	marginLeft: 36,
	marginRight: 36,
	theme: "auto",
	colorMode: "obsidian",
	backgroundColor: "#ffffff",
	textColor: "#222222",
	darkBackgroundColor: "#1e1e1e",
	darkTextColor: "#d4d4d4",
	backgroundImage: null,
	bgImageMode: "shared",
	backgroundImageLight: null,
	backgroundImageDark: null,
	imageBlur: 0,
	glassEnabled: false,
	glassBlur: 12,
	glassOpacity: 0.55,
	showTocRail: false,
	chapterProgress: true,
	normalModeShowToolbar: true,
	normalModeScrollHide: true,
	normalModeHideNativeChrome: true,
	fullImmersionShowTocRail: false,
	fullImmersionShowChapterProgress: false,
	fullImmersionTapReveal: false,
	autoOpenToc: false,
	railScale: 1,
}

/** 平台相关的常态模式默认值。移动端/平板优先接管原生界面，桌面保持窗口导航。 */
export function platformAppearanceDefaults(mobileLike: boolean): Pick<AppearanceSettings,
	"normalModeScrollHide" | "normalModeHideNativeChrome"> {
	return {
		normalModeScrollHide: mobileLike,
		normalModeHideNativeChrome: mobileLike,
	}
}

/** 在合并默认值之前迁移旧外观对象。
 *
 *  必须操作原始对象：`Object.assign({}, DEFAULT_APPEARANCE, raw)` 会先给所有新字段
 *  填上布尔默认值，合并后再看 `typeof` 永远为真，旧 `hideHeader/immersiveAdapt` 就被静默
 *  盖掉。`normalModeScrollHide` 的旧来源在顶层设置 `hideChromeOnScroll`，由 main.ts 在调用
 *  本函数前写入 raw；缺失时按调用方传入的平台默认值补齐。新字段已存在时永远以新字段为准。
 *  旧键一律删除，防止快照或预设继续落盘旧字段。 */
/** 旧版顶层“滚动隐藏”迁移输入。只有用户显式设置过时才覆盖平台新默认。 */
export interface LegacyScrollHideSource {
	value?: unknown
	explicitlySet?: unknown
}

export function adoptLegacyAppearance(
	raw: Record<string, unknown>,
	defaults: Pick<AppearanceSettings, "normalModeScrollHide" | "normalModeHideNativeChrome">,
	legacyScroll?: LegacyScrollHideSource,
): void {
	const legacyScrollSet = legacyScroll?.explicitlySet === true || raw.hideChromeOnScrollSet === true
	const legacyScrollValue = typeof legacyScroll?.value === "boolean"
		? legacyScroll.value
		: raw.hideChromeOnScroll
	if (typeof raw.normalModeScrollHide !== "boolean" && legacyScrollSet && typeof legacyScrollValue === "boolean") {
		raw.normalModeScrollHide = legacyScrollValue
	}
	if (typeof raw.normalModeHideNativeChrome !== "boolean") {
		if (typeof raw.immersiveAdapt === "boolean") raw.normalModeHideNativeChrome = raw.immersiveAdapt
		else if (typeof raw.hideHeader === "boolean") raw.normalModeHideNativeChrome = raw.hideHeader
		else raw.normalModeHideNativeChrome = defaults.normalModeHideNativeChrome
	}
	if (typeof raw.normalModeScrollHide !== "boolean") raw.normalModeScrollHide = defaults.normalModeScrollHide
	delete raw.immersiveAdapt
	delete raw.hideHeader
	delete raw.hideChromeOnScroll
	delete raw.hideChromeOnScrollSet
}

export function normalizeHexColor(input: string | null | undefined, fallback: string): string {
	if (!input) return fallback
	const v = input.trim()
	if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
	if (/^#[0-9a-fA-F]{3}$/.test(v)) {
		const r = v[1]!, g = v[2]!, b = v[3]!
		return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
	}
	return fallback
}

export function isObsidianDark(): boolean {
	try {
		return document.body.classList.contains("theme-dark");
	} catch {
		return false;
	}
}

/** 当前生效的主题：auto 跟随 Obsidian 明暗切换（仅决定用哪组颜色，颜色本身始终取外观设置） */
export function activeTheme(a: AppearanceSettings): "light" | "dark" {
	if (a.theme === "auto") return isObsidianDark() ? "dark" : "light";
	return a.theme === "dark" ? "dark" : "light";
}

/** 背景绝对遵从外观设置：auto 模式按 Obsidian 明暗选用浅色/深色组 */
export function activeBackground(a: AppearanceSettings): string {
	return activeTheme(a) === "dark"
		? normalizeHexColor(a.darkBackgroundColor, "#1e1e1e")
		: normalizeHexColor(a.backgroundColor, "#ffffff")
}

export function activeTextColor(a: AppearanceSettings): string {
	return activeTheme(a) === "dark"
		? normalizeHexColor(a.darkTextColor, "#d4d4d4")
		: normalizeHexColor(a.textColor, "#222222")
}

/** 当前主题生效的背景图：shared 共用一张；separate 按深浅取各自字段 */
export function activeBackgroundImage(a: AppearanceSettings): string | null {
	if (a.bgImageMode === "separate") {
		const v = activeTheme(a) === "dark" ? a.backgroundImageDark : a.backgroundImageLight
		return (v ?? "").trim() || null
	}
	return (a.backgroundImage || "").trim() || null
}

export interface BookPosition {
	/**
	 * 阅读位置 token（格式不可知）：
	 *   - EPUB: CFI 字符串（`/6/4[...]`）
	 *   - MOBI/AZW3: filepos 字符串（`filepos:12345`）
	 * 插件层不解析其内容，统一经 foliate-js 的 `book.resolveHref` 处理。
	 * 老版本使用 `cfi` 字段，progressStore 读取时兼容、写入时统一用新名。
	 */
	anchor: string
	fraction: number
	updatedAt: number
	/** @deprecated 老格式位置 token，读取时自动迁移到 anchor；不要新写 */
	cfi?: string
}

export type BookshelfSortMode = "scan" | "recent" | "manual"

/** 本地 HTML（网页原样通道）的**设备模式**：给 frame 一个固定的布局视口宽度，
 *  再把整页按比例缩放到阅读区宽度 —— 模拟「以这台设备打开这个网页」。
 *  `auto` = 不给固定视口，跟随阅读区宽度（老口径）。见 engineAdapter.setWebDevice。 */
export type WebDeviceMode = "auto" | "phone" | "tablet" | "desktop"

/** 书架卡片所需的轻量数据；封面与无封面时的首行文字另行按需加载。 */
export interface BookshelfEntry {
	path: string
	name: string
	extension: string
	progress: number
	updatedAt: number
	pinned: boolean
}

/** 当前阅读区的统一内容源。电子书继续使用真实文件路径，RSS 文章/播客使用稳定条目键。 */
export type ReaderSource =
	| { kind: "book"; filePath: string }
	| { kind: "feed-entry"; feedId: string; entryId: string }

export type FeedEntryKind = "article" | "audio"
export type FeedFilter = "all" | "unread" | "starred"

export interface FeedSubscription {
	id: string
	title: string
	siteUrl: string
	feedUrl: string
	description: string
	addedAt: number
	updatedAt: number
	lastFetchedAt: number
	lastError: string | null
	etag: string | null
	lastModified: string | null
	/** 停用的订阅不参与刷新，文章也不再进入「全部」聚合列表（缺省 = 启用）。 */
	enabled: boolean
}

export interface FeedEnclosure {
	url: string
	type: string
	length: number | null
	duration: number | null
}

/** 每个条目的可同步状态。单独的 updatedAt 让各字段可以按设备做后写胜出。 */
export interface FeedEntryState {
	readAt: number | null
	starredAt: number | null
	openedAt: number
	position: BookPosition | null
	/** 这篇文章是否已有高亮/书签；刷新时用于保护旧快照并等待重定位。 */
	hasAnnotations?: boolean
	stateUpdatedAt: number
}

export interface FeedEntry {
	id: string
	feedId: string
	guid: string
	kind: FeedEntryKind
	title: string
	url: string
	author: string
	publishedAt: number
	updatedAt: number
	summary: string
	contentHtml: string
	contentSource: "feed" | "fulltext"
	contentHash: string
	/** 刷新拿到的新正文。已有标注时先暂存，打开文章完成重定位后再提升为当前正文。 */
	pendingContentHtml?: string
	pendingContentHash?: string
	pendingContentSource?: "feed" | "fulltext"
	enclosure: FeedEnclosure | null
	state: FeedEntryState
}

export interface FeedIndexFile {
	version: 1
	feeds: FeedSubscription[]
	updatedAt: number
}

export interface FeedFileData {
	version: 1
	feedId: string
	entries: FeedEntry[]
	updatedAt: number
}

export interface FeedSettings {
	refreshOnOpen: boolean
	markReadOnOpen: boolean
	loadRemoteImages: boolean
	entryLimit: number
	imageCacheMb: number
	mediaCacheMb: number
}

export interface AppearancePreset {
	id: string
	name: string
	appearance: AppearanceSettings
	createdAt: number
	/** 预设文件夹名（文件化存储时使用）；省略时按 name 推导 */
	dir?: string
}

export interface UNreaderSettings {
	/** 书架排序：扫描顺序 / 最近阅读 / 手动。置顶书籍始终排在各自顺序之前。 */
	bookshelfSortMode: BookshelfSortMode
	/** 手动排序中的书籍路径；新书未收录时追加到末尾。 */
	bookshelfManualOrder: string[]
	/** 置顶书籍路径。 */
	bookshelfPinned: string[]
	/** 书架（书籍管理侧边栏）与「打开书籍」列表要**排除的文件夹**（库内相对路径）。
	 *
	 *  命中者不出现在这两个列表里，**但文件本身不受任何影响**：文件树 / 链接 / 原生入口
	 *  照常能打开，进度、标注、置顶也全部保留 —— 排除只是「别在书籍列表里占位」。
	 *  判定在 `core/bookExclusions.ts`，只挂在收集书籍这一层。 */
	bookshelfExcludedFolders: string[]
	/** 是否把 Obsidian「排除文件」里的条目也当作书架的排除项（**默认开**）。
	 *
	 *  默认值与平台无关、恒为 true，所以不需要 `hideChromeOnScrollSet` 那种「用户是否
	 *  显式设置过」标记（那个标记存在是因为它的默认值按平台分叉，桌面端写入的默认值会经
	 *  同步压住移动端的默认开启）；读法统一写 `!== false` 即可兼容老数据。 */
	bookshelfFollowObsidianExclusions: boolean
	positions: Record<string, BookPosition>
	appearance: AppearanceSettings
	appearancePresets: AppearancePreset[]
	/** 资料文件夹（库内相对路径，null = 默认库根 `UNreader/`）：**插件数据文件的落点** ——
	 *  阅读进度 / 外观预设 / 字体 / 共享资源 / 标注笔记都存在这里。
	 *  切换时由 `core/libraryMigration.ts` 把这五个数据目录整树搬到新根；
	 *  **书籍不受影响**（书在库里任何位置都能读，永远留在各自原来的文件夹）。 */
	dataFolder: string | null
	/** 高亮侧边栏是否钉住（常驻左侧，不再悬浮） */
	annoPinned: boolean
	/** 高亮侧边栏手动调节后的高度（px）；未设置 = 跟随默认全高 */
	annoPanelHeight?: number
	/** 高亮侧边栏手动调节后的宽度（px）；未设置 = 默认 330px */
	annoPanelWidth?: number
	/** 触发钉住按钮显示的最小宽度阈值（px），高于此值才显示“钉住” */
	pinThreshold: number
	/** 调试日志（诊断用，可开关的可选内存环形缓冲，设置页导出） */
	debugLog: boolean
	/** 把标注笔记登记进 Obsidian 的「排除文件」：高亮/书签旁车笔记不再出现在搜索、
	 *  关系图谱与快速切换里（笔记文件本身与高亮功能不受影响）。
	 *
	 *  **默认开**，与平台无关，因此不需要 `hideChromeOnScrollSet` 那种
	 *  「用户是否显式设置过」标记（那个标记存在是因为它的默认值按平台分叉，
	 *  桌面端写入的默认值会经同步压住移动端的默认开启）。 */
	excludeNotesFromSearch: boolean
	/** 本地 HTML 阅读时的设备模式（布局视口档位）。HTML 之外的书型忽略此项。 */
	webDeviceMode: WebDeviceMode
	/** RSS/Atom/JSON Feed 阅读设置。 */
	feeds: FeedSettings
}

export const DEFAULT_SETTINGS: UNreaderSettings = {
	bookshelfSortMode: "scan",
	bookshelfManualOrder: [],
	bookshelfPinned: [],
	bookshelfExcludedFolders: [],
	bookshelfFollowObsidianExclusions: true,
	positions: {},
	appearance: { ...DEFAULT_APPEARANCE },
	appearancePresets: [],
	dataFolder: null,
	annoPinned: false,
	pinThreshold: 720,
	debugLog: false,
	excludeNotesFromSearch: true,
	webDeviceMode: "auto",
	feeds: {
		refreshOnOpen: true,
		markReadOnOpen: true,
		loadRemoteImages: true,
		entryLimit: 200,
		imageCacheMb: 100,
		mediaCacheMb: 500,
	},
}

/** 自定义字体：库内字体文件扫描结果 */
export interface CustomFont {
	/** 稳定 id：`custom:<文件名>` */
	id: string
	/** 显示名：去掉扩展名的文件名 */
	label: string
	/** 字体文件路径 */
	path: string
}

export interface HighlightColor {
	name: string
	label: string
	color: string
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
	{ name: "yellow", label: "黄", color: "rgba(255, 224, 102, 0.5)" },
	{ name: "green", label: "绿", color: "rgba(129, 199, 132, 0.45)" },
	{ name: "blue", label: "蓝", color: "rgba(100, 181, 246, 0.4)" },
	{ name: "red", label: "红", color: "rgba(239, 154, 154, 0.45)" },
	{ name: "purple", label: "紫", color: "rgba(186, 148, 230, 0.42)" },
]

export function highlightColorOf(name: string): string {
	return HIGHLIGHT_COLORS.find(c => c.name === name)?.color ?? HIGHLIGHT_COLORS[0]!.color;
}
