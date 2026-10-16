import type { FeedContentQuality } from "./core/feedContentQuality";
import type { LangPref } from "./core/i18n";
import type { ReadableFormatId } from "./core/readableFormats";

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
	/** 常态模式：Obsidian 页首是否默认参与显示。关闭后默认隐藏，点击正文临时唤出（与工具栏同一套显隐生命周期）。 */
	normalModeShowHeader: boolean
	/** 常态模式：Obsidian 底部工具栏（手机底栏）是否默认参与显示。关闭后默认隐藏、点击正文临时唤出；
	 *  手机端官方 CSS 把页首与底栏绑在同一开关上，页首隐藏时底栏随之隐藏。桌面无底栏，此开关不生效。 */
	normalModeShowBottomBar: boolean
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
	normalModeShowHeader: true,
	normalModeShowBottomBar: true,
	normalModeScrollHide: true,
	normalModeHideNativeChrome: true,
	fullImmersionShowTocRail: false,
	fullImmersionShowChapterProgress: false,
	fullImmersionTapReveal: false,
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

/** 书架分类：路径级轻量元数据；一本书至多属于一个分类。 */
export interface BookshelfCategory {
	id: string
	name: string
	createdAt: number
}

/** 书架分类筛选值：`all` / `uncategorized` / 某个分类 id。 */
export type BookshelfCategoryFilter = "all" | "uncategorized" | (string & {})

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
	/** 所属分类 id；缺省 / null = 未分类。 */
	categoryId?: string | null
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
	/** 已把这篇正文抓成 Markdown 存进 vault 的时间（null / 缺省 = 没保存过）。
	 *  与 `starredAt` 同级：**两者的豁免语义必须一致** —— 都是「长期保留」标记，
	 *  刷新裁剪（`isPinnedFeedEntry`）与订阅链接失效都不该让它从列表里消失。 */
	savedAt?: number | null
	openedAt: number
	position: BookPosition | null
	/** 播客音频进度；与正文滚动位置分开保存，避免两者互相覆盖。 */
	audioPosition?: BookPosition | null
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
	/** Feed 自带正文是否足以当全文；旧数据缺省时由 FeedStore 现算补齐。 */
	contentQuality?: FeedContentQuality
	/** 刷新拿到的新正文。已有标注时先暂存，打开文章完成重定位后再提升为当前正文。 */
	pendingContentHtml?: string
	pendingContentHash?: string
	pendingContentSource?: "feed" | "fulltext"
	pendingContentQuality?: FeedContentQuality
	enclosure: FeedEnclosure | null
	state: FeedEntryState
}

export interface FeedIndexFile {
	version: 1
	feeds: FeedSubscription[]
	updatedAt: number
}

/** v2（2026-09-29）：正文 HTML 拆出独立文件（2026-10-10 起落点是**插件目录缓存**
 *  `<插件目录>/cache/feeds/…`，之前是库内 `Feeds/Content/`），本文件只留元数据与
 *  阅读状态（瘦文件）——状态类更新不再触发整库正文重写。 */
export interface FeedFileData {
	version: 2
	feedId: string
	entries: FeedEntry[]
	updatedAt: number
}

/** 单篇文章正文文件（`<插件目录>/cache/feeds/<feedId>/<entryId>.json`）。
 *  ⚠️ 它**不随库同步**、也不出现在文件树里 —— 正文是可再生的抓取缓存，
 *  换设备重新刷新订阅即可（见 `core/feedStore.ts` 文件头）。 */
export interface FeedEntryContentFile {
	version: 1
	contentHtml: string
	/** 刷新拿到、等待标注重定位确认的新正文（与 FeedEntry.pendingContentHtml 同源）。 */
	pendingContentHtml?: string
}

export interface FeedSettings {
	refreshOnOpen: boolean
	markReadOnOpen: boolean
	/** Feed 只给摘要时，打开文章是否自动尝试抓网页全文。 */
	autoFulltext: boolean
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

/** Markdown 笔记阅读索引里的一条最近阅读记录。
 *  只存路径和时间，笔记正文仍由 Obsidian 原生编辑器负责；文件删改后读取端会按当前
 *  vault 过滤，路径属性也只用于列表定位，不复制任何正文内容。 */
export interface MarkdownNoteRecentEntry {
	path: string
	openedAt: number
}

/** 笔记 frontmatter 的摘要（看板展示用）。
 *  只留「人一眼能读」的几个字段，不把整份 YAML 原样搬进来 —— 看板是窄浮层，
 *  长值会被截断，与其丢一半不如只取常用项 + 其余键值对（值过长由渲染端裁）。 */
export interface NoteMetaSummary {
	/** frontmatter 的 tags（数组或逗号串都已归一为数组） */
	tags?: string[]
	/** 别名 */
	aliases?: string[]
	/** 其余一级键值（已剔除 tags/aliases 与封面类键），最多若干条 */
	extra?: Array<{ key: string; value: string }>
}

/** 「笔记」侧边页的一项；由当前 vault 文件与最近/星标索引在渲染时合并。 */
export interface MarkdownNoteListItem {
	path: string
	title: string
	mtime: number
	openedAt?: number
	starredAt?: number
	/** frontmatter 摘要（读不到就没有这一项，看板相应少一段） */
	meta?: NoteMetaSummary
}

export interface UNreaderSettings {
	/** 书架排序：扫描顺序 / 最近阅读 / 手动。置顶书籍始终排在各自顺序之前。 */
	bookshelfSortMode: BookshelfSortMode
	/** 手动排序中的书籍路径；新书未收录时追加到末尾。 */
	bookshelfManualOrder: string[]
	/** 置顶书籍路径。 */
	bookshelfPinned: string[]
	/** 书架自定义分类；删除分类时其书自动回到「未分类」。 */
	bookshelfCategories: BookshelfCategory[]
	/** 书籍路径 → 分类 id；没有记录 = 未分类。 */
	bookshelfCategoryAssignments: Record<string, string>
	/** 手动从书架移除的书籍路径；只影响列表，不删除文件、进度或标注。 */
	bookshelfHiddenBooks: string[]
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
	/** AI 能力（经 UNagent 桥，M2 = 选区翻译）的本地开关。
	 *  模型与 API key 一律活在 UNagent 内部，这里只有「入口显隐」级别的控制。 */
	ai: AiSettings
	/** markdown 阅读视图叠加层：顶边章节进度条（**默认开**，读法 `!== false`）。
	 *  只作用于 Obsidian 原生阅读模式（getMode()==="preview"）的 markdown 视图，
	 *  编辑 / Live Preview 不出现；进度不做持久化（官方阅读模式自带滚动位置记忆）。 */
	mdOverlayShowProgress?: boolean
	/** markdown 进度条的**分段粒度**：0 = 全文一根进度条（**默认**），1-6 = 按该级别
	 *  标题分段 —— 相邻两个同级标题之间走完一根 0→1，跨段回零重来。选中的级别在
	 *  文档里不存在时退回全文。分段计算**排除阅读视图底部的反向链接区域**（那不是
	 *  正文）。读法：整数 clamp 到 0-6，非法值回 0。 */
	mdOverlayProgressScope?: number
	/** markdown 阅读视图叠加层：右缘章节浮动目录条（**默认开**）。数据源是视图内
	 *  渲染出来的标题元素（H1∪H2，无 H1 降级 H2∪H3），与阅读器的 SideNav 同一组件。 */
	mdOverlayShowTocRail?: boolean
	/** markdown 阅读视图叠加层：「切换笔记沉浸阅读」命令（**默认开**）。沉浸例外
	 *  （保留目录/进度）复用阅读器外观设置 fullImmersionShowTocRail / ShowChapterProgress。 */
	mdOverlayImmersive?: boolean
	/** 最近在 Obsidian 原生阅读模式打开过的 Markdown 笔记（MRU，最多 12 条）。
	 *  只影响「笔记」侧边页的最近列表；不接管 .md 文件、不持久化正文。 */
	markdownNoteRecent: MarkdownNoteRecentEntry[]
	/** 用户星标的 Markdown 笔记路径 → 星标时间（升序时间戳只在排序时使用）。 */
	markdownNoteStarred: Record<string, number>
	/** 自定义按钮：把任意 Obsidian 命令绑成按钮，放到侧边浮动工具栏 / 划词工具条。
	 *  **无数量上限**；默认空数组 —— 空时两处按钮槽不进 DOM，既有布局零影响。 */
	customButtons: CustomButton[]
	/** 界面语言（2026-10-11 起）：`'auto'` 跟随 Obsidian 软件语言，`'zh'` / `'en'` 钉死。
	 *  默认 `'auto'` ⇒ 中文 Obsidian 用户看到的界面与本功能上线前逐字相同；读法走
	 *  `normalizeLangPref()`，脏数据 / 老数据一律回落到 `'auto'`。 */
	language: LangPref
	/** 阅读格式管理（设置页 → 阅读格式）：被用户**关掉**的阅读格式（小写扩展名或
	 *  `"md"` / `"rss"`，见 `core/readableFormats.ts`）。缺省 / 空数组 = 全部开启
	 *  （与本功能上线前逐字节相同）；关掉后该格式不再进阅读链路 —— 书籍类不注册
	 *  扩展名 + 书架不再列出，md 不启动叠加层，rss 入口全拒。
	 *  ⚠️ 「不注册扩展名」发生在 onload，**改动需重载插件 / 重启 Obsidian 后完全生效**；
	 *  重载前已打开的阅读器会当场拒绝装载被关格式（不白屏、不崩）。 */
	disabledFormats?: ReadableFormatId[]
}

/** 一枚「命令 → 按钮」绑定（见 UNreaderSettings.customButtons）。
 *  命令执行统一走 `app.commands.executeCommandById(commandId)`，可绑核心命令、
 *  本插件命令或其他插件命令；命令不存在时按钮置灰（见组件层 setCustomButtons）。 */
export interface CustomButton {
	/** 稳定 id（设置页增删的键，`cb-<time36>-<rand>`）。 */
	id: string
	/** 完整命令 id（如 `unreader:highlight-selection-yellow`、`editor:toggle-bold`）。 */
	commandId: string
	/** 按钮显示名：aria-label / title / 设置页列表名（≤40 字）。默认快照命令名。 */
	label: string
	/** lucide 图标名（≤64 字）；取不到时由组件兜底成通用图标，不显示空白。 */
	icon: string
	/** 出现在侧边浮动工具栏（阅读器与 md 阅读视图共用的 SideNav）。 */
	showInRail: boolean
	/** 出现在选中文字后的划词工具条（SelectionToolbar）。 */
	showInSelbar: boolean
}

export interface AiSettings {
	/** 选区工具条上的「翻译」按钮。**默认开**；读法写 `!== false` 兼容老数据。 */
	translateSelection: boolean
	/** 全文翻译的目标语言（AI 面板下拉框）。 */
	targetLanguage: string
	/** 用户自定义 AI 工具（面板按钮形式，可编辑/删除）。官方的「全文翻译 / 排版优化」
	 *  不在此列：它们不可删除，改动存 toolOverrides，可重置回官方默认。 */
	customFunctions: AiCustomFunction[]
	/** 官方工具的改动（提示词/作用域），键 = 官方工具 id。只存**偏离项** —— 官方默认
	 *  提示词活在代码里，升级改进默认词不会丢；重置 = 删除对应键。 */
	toolOverrides: Record<string, AiToolOverride>
}

export interface AiCustomFunction {
	/** 稳定 id（面板内增删的键，随机生成） */
	id: string
	/** 工具名（≤40 字符）：面板列表与划词工具栏的**统一 AI 入口名单**都只显示它 ——
	 *  2026-09-28 用户要求「没有图标，只有标题」，逐工具的按钮样式/图标设置已移除。 */
	name: string
	/** 发给模型的 system 指令（≤4000 字符） */
	prompt: string
	/** 作用域：full = 对整篇/当前章生效（结果**替换正文**）；selection = 对选中文字触发（结果在面板展示）。
	 *  两者都进划词工具栏的统一 AI 入口名单（见 AIPanel.selectionToolEntries）。 */
	scope: AiFunctionScope
	/** 功能开关（默认开，缺省读法 `!== false`）。停用后：面板里置灰不可运行、入口名单里不出现。 */
	enabled?: boolean
}

export type AiFunctionScope = "full" | "selection"

/** 划词工具栏「统一 AI 入口」悬浮名单里的一行：**只有名称**（用户要求「没有图标，只有标题」）。
 *  官方工具（全文翻译 / 排版优化）与自定义工具同列，官方在前。 */
export interface AiToolEntry {
	/** 官方工具是 `translate` / `typography`；自定义工具是 `fn-…`（见 AIPanel.runToolById） */
	id: string
	name: string
}

/** 官方工具的用户改动。逐字段可选：只存偏离项，「有键 = 已修改」呈现重置入口。 */
export interface AiToolOverride {
	prompt?: string
	scope?: AiFunctionScope
	/** 官方工具的停用开关（缺省 = 启用） */
	enabled?: boolean
}

export const DEFAULT_SETTINGS: UNreaderSettings = {
	bookshelfSortMode: "scan",
	bookshelfManualOrder: [],
	bookshelfPinned: [],
	bookshelfCategories: [],
	bookshelfCategoryAssignments: {},
	bookshelfHiddenBooks: [],
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
		autoFulltext: true,
		loadRemoteImages: true,
		entryLimit: 200,
		imageCacheMb: 100,
		mediaCacheMb: 500,
	},
	ai: {
		translateSelection: true,
		targetLanguage: "简体中文",
		customFunctions: [],
		toolOverrides: {},
	},
	mdOverlayShowProgress: true,
	mdOverlayProgressScope: 0,
	mdOverlayShowTocRail: true,
	mdOverlayImmersive: true,
	markdownNoteRecent: [],
	markdownNoteStarred: {},
	customButtons: [],
	language: "auto",
	disabledFormats: [],
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
	/** ⚠️ 持久化键：写进旁车笔记的 `- id | color | anchor`，**禁止改名**（只能改取色来源）。 */
	name: string
	label: string
	/** 内置兜底色值（rgba，alpha < 1）。运行时优先用宿主主题探测值（见 setHighlightPalette）。 */
	color: string
}

/** 高亮色 → 宿主主题变量。
 *  黄走官方默认档 `--text-highlight-bg`（本身就是半透明 rgba）；其余五色走调色板
 *  `--color-*`（不透明，探测时按 HIGHLIGHT_ALPHA 上透明度）。
 *  依据：官方 1.13+ 用 `color-mix(in oklch, var(--color-red) 20%, transparent)` 派生彩色高亮
 *  （Obsidian 开发者文档 Foundations/Colors.md），所以吃这六个变量即与官方同源且跟随主题。 */
export const HIGHLIGHT_THEME_VARS: Record<string, string> = {
	yellow: "--text-highlight-bg",
	orange: "--color-orange",
	green: "--color-green",
	blue: "--color-blue",
	red: "--color-red",
	purple: "--color-purple",
}

/** 主题色块不透明度，与官方 `--text-highlight-bg` 默认档（0.4）对齐。 */
export const HIGHLIGHT_ALPHA = 0.4

/** 高亮色板。色值取自官方默认主题实测（app.css），顺序对齐官方「红橙黄绿蓝紫」的语义分组。
 *  ⚠️ 色点的「去 alpha」正则 `/[\d.]+\)$/` 要求本表所有 color 都含 alpha 分量（a < 1）：
 *  若给不含 alpha 的 `rgb(r, g, b)`，正则会命中末尾蓝色分量（`rgb(233, 49, 71)` → `rgb(233, 49, 1)`）。 */
export const HIGHLIGHT_COLORS: HighlightColor[] = [
	{ name: "yellow", label: "黄", color: "rgba(255, 208, 0, 0.4)" },   // 官方 --text-highlight-bg
	{ name: "orange", label: "橙", color: "rgba(236, 117, 0, 0.4)" },   // --color-orange #ec7500
	{ name: "green", label: "绿", color: "rgba(8, 185, 78, 0.4)" },     // --color-green  #08b94e
	{ name: "blue", label: "蓝", color: "rgba(8, 109, 221, 0.4)" },     // --color-blue   #086ddd
	{ name: "red", label: "红", color: "rgba(233, 49, 71, 0.4)" },      // --color-red    #e93147
	{ name: "purple", label: "紫", color: "rgba(120, 82, 238, 0.4)" },  // --color-purple #7852ee
]

/** 宿主主题探测结果（name → rgba 字面量）。空 = 尚未探测或预览环境，回退内置色值。 */
let highlightPalette: Record<string, string> = {}

/**
 * 写入宿主主题探测结果（由 engineAdapter 在外观解析路径里调用，见 probeHighlightPalette）。
 *
 * ⚠️ 每个值**必须是带 alpha 的 `rgba(r, g, b, a)` 且 a < 1** —— 三处 UI 色点会做
 * `.replace(/[\d.]+\)$/, "1)")` 把半透明拨到不透明；传不透明的 `rgb(...)` 会把末尾
 * 分量替换成 `1)`（`rgb(233, 49, 71)` → `rgb(233, 49, 1)`，颜色彻底写坏）。
 * 传 null / 非对象 = 清空（回退内置色值）。
 */
export function setHighlightPalette(p: Record<string, string> | null): void {
	highlightPalette = p && typeof p === "object" ? p : {}
}

/** 取某个高亮色的当前色值（优先主题探测值，回退内置色值）。
 *  未知色名回退到色板首项（黄），与旧行为一致。 */
export function highlightColorOf(name: string): string {
	const themed = highlightPalette[name]
	if (themed) return themed
	return HIGHLIGHT_COLORS.find(c => c.name === name)?.color ?? HIGHLIGHT_COLORS[0]!.color;
}

/** ---------- UNagent AI 桥契约（《UNreader接入UNagent-AI设计任务书》§1.2） ----------
 *  方法命名由 UNagent 侧 M1 定稿（结构勿大改，定稿后同步双方 AGENTS.md）。
 *  这里是纯结构类型：UNreader 侧绝不 import UNagent 的任何模块（依赖方向单向），
 *  也绝不读 UNagent 的设置或 data.json（安全边界，core/unagentBridge.ts 是唯一口子）。 */

export interface UnagentCompleteRequest {
	system?: string
	user: string
	temperature?: number
	onChunk?: (delta: string) => void
	signal?: AbortSignal
}

export interface UnagentCompleteResult {
	text: string
	model: string
}

export interface UnagentAIApi {
	describeModel(): string
	complete(req: UnagentCompleteRequest): Promise<UnagentCompleteResult>
}

export type UnagentUnavailableReason = "not-installed" | "no-method" | "not-configured"

export interface UnagentDetection {
	available: boolean
	reason?: UnagentUnavailableReason
	api?: UnagentAIApi
}
