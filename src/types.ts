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
	/** 背景图片（data URI / http URL / 库内路径），null = 纯色背景；深浅共用 */
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
	/** 沉浸模式适配：沉浸（滚动下滑藏工具栏）时是否连 **Obsidian 原生界面**一起收起。
	 *  开 = 页首（三端）+ 手机端底栏 / 系统状态栏一起藏；关 = 只收本插件自己的悬浮 UI，
	 *  Obsidian 的界面保持原样。默认值按平台给（移动端开、桌面端关，见 `main.ts` 迁移块）。
	 *  页首一旦隐藏，内容区顶部整片让出，章节进度条随之上移到屏幕最上面
	 *  （不再为不存在的页首留位，见 readerView.syncProgressTop）。
	 *  判据在 `ui/nativeNavPolicy.ts`（纯函数，带真值表回归）。随外观预设保存。
	 *  旧字段名 `hideHeader`（只藏页首）由 `adoptLegacyAppearance` 迁移。 */
	immersiveAdapt: boolean
	/** 打开书籍时自动展开浮动目录面板 */
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
	showTocRail: true,
	chapterProgress: true,
	immersiveAdapt: false,
	autoOpenToc: true,
	railScale: 1,
}

/** 旧字段就地迁移：`hideHeader` → `immersiveAdapt`（2026-09-14 改名）。
 *
 *  为什么必须**在合并默认值之前**对原始对象调用：`Object.assign({}, DEFAULT_APPEARANCE, raw)`
 *  总会给出一个布尔值（默认 false），合并后再判 `typeof === "boolean"` 就永远为真 ——
 *  旧快照里 `hideHeader: true` 会被默认值盖掉，用户升级后「沉浸时隐藏页首」静默失灵。
 *  调用方：`main.ts`（设备快照 / data.json 中的外观）、`presetStore`（预设文件）、
 *  `main.ts` 的旧预设迁移。新字段已存在时以新字段为准（用户在新版里改过），旧键一律删除。 */
export function adoptLegacyAppearance(raw: Record<string, unknown>): void {
	if (typeof raw.immersiveAdapt === "boolean") {
		delete raw.hideHeader
		return
	}
	if (typeof raw.hideHeader === "boolean") raw.immersiveAdapt = raw.hideHeader
	delete raw.hideHeader
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

export interface AppearancePreset {
	id: string
	name: string
	appearance: AppearanceSettings
	createdAt: number
	/** 预设文件夹名（文件化存储时使用）；省略时按 name 推导 */
	dir?: string
}

export interface UNreaderSettings {
	positions: Record<string, BookPosition>
	appearance: AppearanceSettings
	appearancePresets: AppearancePreset[]
	/** 高亮侧边栏是否钉住（常驻左侧，不再悬浮） */
	annoPinned: boolean
	/** 高亮侧边栏手动调节后的高度（px）；未设置 = 跟随默认全高 */
	annoPanelHeight?: number
	/** 高亮侧边栏手动调节后的宽度（px）；未设置 = 默认 330px */
	annoPanelWidth?: number
	/** 触发钉住按钮显示的最小宽度阈值（px），高于此值才显示“钉住” */
	pinThreshold: number
	/** 沉浸模式：开书即隐藏工具栏，下滑隐藏/上滑唤出，点屏幕中间切换显隐（移动端默认开） */
	hideChromeOnScroll: boolean
	/** 用户是否显式设置过沉浸模式（未设置时每次启动按平台重设默认值，
	 *  防止桌面端写入的默认值经同步压住移动端的默认开启） */
	hideChromeOnScrollSet?: boolean
	/** 调试日志（诊断用，可开关的可选内存环形缓冲，设置页导出） */
	debugLog: boolean
	/** 把标注笔记登记进 Obsidian 的「排除文件」：高亮/书签旁车笔记不再出现在搜索、
	 *  关系图谱与快速切换里（笔记文件本身与高亮功能不受影响）。
	 *
	 *  **默认开**，与平台无关，因此不需要 `hideChromeOnScrollSet` 那种
	 *  「用户是否显式设置过」标记（那个标记存在是因为它的默认值按平台分叉，
	 *  桌面端写入的默认值会经同步压住移动端的默认开启）。 */
	excludeNotesFromSearch: boolean
}

export const DEFAULT_SETTINGS: UNreaderSettings = {
	positions: {},
	appearance: { ...DEFAULT_APPEARANCE },
	appearancePresets: [],
	annoPinned: false,
	pinThreshold: 720,
	hideChromeOnScroll: false,
	debugLog: false,
	excludeNotesFromSearch: true,
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
