/**
 * UNreader 的界面语言层（中英双语）。
 *
 * 取词方式是**中央字典**（不是 UNagent 那种内联 `t("中","英")`）：1139 条文案
 * 全部收在这里，好处是
 *  ① 可被 `test:i18n` 完整枚举审计 —— UI 代码里残留裸中文字面量即报红；
 *  ② `readerView.ts`（7471 行）这类大文件不会因为翻译继续膨胀；
 *  ③ 新增文案漏翻英文时，字典缺键在类型层面就过不去。
 *
 * 语言档与 UNagent 一致：`'auto'` 跟随 Obsidian 软件语言，`'zh'` / `'en'` 钉死。
 * 与 UNmemos（只有 zh/en）的差别就是多一个「自动」；默认值同样取 `'auto'`，
 * 所以中文 Obsidian 用户看到的界面与本功能上线前**逐字相同**。
 *
 * 用法：非 React 的普通代码直接 `t('key')` / `tf('key', { n })`；需要响应语言
 * 变化的视图（阅读器、标注面板等）用 `onLangChange()` 订阅，在回调里重画。
 */
import { moment } from "obsidian";

/** 实际生效的界面语言。 */
export type Lang = "zh" | "en"

/** 设置项里存的语言偏好：`auto` = 跟随 Obsidian 软件语言。 */
export type LangPref = "auto" | "zh" | "en"

/** 语言偏好取值的收口：老数据 / 脏数据一律回落到 `auto`（= 跟软件，行为不变）。 */
export function normalizeLangPref(value: unknown): LangPref {
	return value === "zh" || value === "en" ? value : "auto"
}

let current: Lang = "zh"
const listeners = new Set<(lang: Lang) => void>()

/**
 * locale 字符串 → 界面语言。**纯函数**，不碰任何全局，所以可以单独被探针喂
 * 各种地区写法（这正是容易出错的地方：zh-Hant / zh-TW / zh-HK / zh-CN…）。
 *
 * 判据（与 UNagent 一致）：
 *  - `zh` / `zh-*`（**含繁体**：zh-TW / zh-HK / zh-Hant 都是中文界面）→ `zh`
 *  - `en` / `en-*` → `en`
 *  - 其他任何语言（日 / 法 / 德 / 韩…）→ `en`。本插件只提供中英两套文案，
 *    没有第三套可选，与其落到 `zh` 让看不懂的用户面对中文，不如给英文。
 *  - 空 / 拿不到 → `zh`（兜底见 `detectAppLang`）
 */
export function langFromLocale(locale: string | null | undefined): Lang {
	const tag = String(locale ?? "").trim().toLowerCase()
	if (!tag) return "zh"
	// 只看主语言子标签：`zh-Hant-TW` / `zh_TW` / `ZH-cn` 都收敛到 `zh`。
	const primary = tag.replace(/[_-].*$/, "")
	return primary === "zh" ? "zh" : "en"
}

/**
 * 读到 Obsidian 当前界面语言的原始 locale 字符串（如 `zh-cn` / `zh-TW`）。
 *
 * 单独开一个口是因为设置页的 auto 档要把**解析链**显示出来（`zh-TW → 中文`）：
 * 只给「解析后的 zh/en」用户看不到判据，出了分歧也无从核对。拿不到时返回
 * 空串，由调用方决定怎么兜底显示。
 */
export function detectAppLocale(): string {
	try {
		return String(moment.locale() ?? "").trim()
	} catch {
		return ""
	}
}

/**
 * 探测 Obsidian 软件语言（auto 档的唯一判据）。
 *
 * 数据源是 `moment.locale()`：Obsidian 会把 moment 的 locale 设成界面语言，
 * 这是权威来源（同 UNagent 的口径）。刻意避开 `obsidian.getLanguage()` ——
 * 它 1.8.7 才加入，而本插件 `minAppVersion` 是 1.7.2，上架检查会拒。
 *
 * 拿不到 moment 时兜底 `zh`，且**刻意不用 `navigator.language`**：它跟的是操作
 * 系统语言而非 Obsidian 界面语言，「英文系统 + 中文 Obsidian 界面」会被误判成
 * 英文；更糟的是无头 Chromium 里它恒为 `en-US`，会让所有 test:* 探针（它们硬
 * 断言中文 UI 文案）在默认档下集体变红。
 *
 * 兜底选 `zh` 而不是 `en`：本插件面向中文用户，UNmemos 的默认值也是 `zh`。
 */
export function detectAppLang(): Lang {
	const locale = detectAppLocale()
	if (locale) return langFromLocale(locale)
	// locale 是唯一有判别力的来源：Obsidian 在真实运行时一定会设置它，
	// 而其余候选要么不可靠（navigator 跟系统语言），要么与兜底同值
	// （html[lang]）。所以到这里直接返回默认值，不做无意义的判断。
	return "zh"
}

/** 把设置里的偏好解析成实际语言。 */
export function resolveLang(pref: LangPref): Lang {
	return pref === "auto" ? detectAppLang() : pref
}

/** 当前界面语言。 */
export function getLang(): Lang {
	return current
}

/**
 * 切换界面语言并通知订阅者。传入值非法时按 `zh` 收口。
 *
 * 注意这是**无条件的**：即使语言没变也照常返回 `true`，由调用方决定要不要重画
 * （设置页需要重画来更新开关的高亮态，视图侧自己比对新旧语言即可）。
 */
export function setLang(lang: Lang): void {
	const next: Lang = lang === "en" ? "en" : "zh"
	const changed = next !== current
	current = next
	if (changed) {
		for (const listener of listeners) {
			try {
				listener(next)
			} catch {
				// 单个订阅者抛错不能连累其他人（旧版本里逐个 try 是踩过的坑）。
			}
		}
	}
}

/** 订阅语言变化，返回退订函数。用于重画已打开的视图。 */
export function onLangChange(listener: (lang: Lang) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

const STRINGS = {
	zh: {
		/* ── 通用 / 设置页框架 ───────────────────────────────── */
		langLabel: "界面语言",
		langDesc:
			"「自动」跟随 Obsidian 软件语言：软件是中文（含繁体）就用中文，软件是其他任何语言就用英文。「中文」与「English」则无视软件语言固定下来。",
		langAuto: "自动",
		langZh: "中文",
		langEn: "EN",
		langAutoResolved: "当前 Obsidian 语言是 {locale}，界面用{lang}。",
		secGeneral: "通用",

		/* ── 反馈渠道 ─────────────────────────────────────────── */
		feedbackTitle: "反馈与支持",
		feedbackDesc: "有问题、建议或想吐槽，都欢迎联系。",
		feedbackEmail: "邮箱",
		feedbackQQChannel: "QQ 频道",
		feedbackBilibili: "B站主页",

		/* ── 数据文件夹 ───────────────────────────────────────── */
		secData: "数据",
		dataFolderName: "数据文件夹",
		dataFolderDesc:
			"你选择的是外层资料文件夹。插件会固定在其中创建 {root}/{data}/，把阅读进度 / 外观预设 / 字体 / 共享资源 / 标注笔记 / 订阅数据都收进这个数据目录（外层目录里不会散落任何插件文件）。切换位置时会把这几类文件整体迁过去；书籍不搬，一律留在原来的文件夹 —— 书放在库内任何位置都能打开，所以进度、书架顺序、笔记链接都不受影响。当前：{label}",
		dataFolderPick: "选择文件夹",
		dataFolderUseDefault: "使用默认位置",
		dataFolderCurrent: "当前：{label}",

		/* ── 阅读 ─────────────────────────────────────────────── */
		secReading: "阅读",

		/* ── 自定义按钮 ───────────────────────────────────────── */
		secCustomButtons: "自定义按钮",
		customButtonAddName: "添加按钮",
		customButtonAddDesc:
			"把任意 Obsidian 命令（含本插件与其他插件的命令）绑定成按钮。每个按钮可独立选择出现在「侧边工具栏」或「划词工具条」（选中文字后出现），也可两处都显示。数量不限：侧边工具栏按钮过多时区域内上下滚动，划词工具条按钮过多时横向滚动。提示：本插件已提供「高亮选中文本（黄/橙/绿/蓝/红/紫）」六条命令，可直接绑定到划词工具条。",
		customButtonAdd: "添加按钮",
		customButtonLabel: "按钮名称",
		customButtonLabelDesc: "显示在按钮上的文字。留空则用命令名。",
		customButtonIcon: "图标",
		customButtonIconDesc: "lucide 图标名，如 star。留空则用命令自带图标。",
		customButtonSide: "侧边工具栏",
		customButtonSideDesc: "在阅读器与笔记阅读视图的左侧浮动工具栏中显示。",
		customButtonSel: "划词工具条",
		customButtonSelDesc: "选中文字后，在弹出的划词工具条中显示。",
		customButtonRemove: "移除",
		/* 卡片里的分区小标题（每行都带字段标签，窄屏才读得懂） */
		cbCommandLabel: "命令",
		cbFieldLabel: "名称",
		cbFieldIcon: "图标",
		cbFieldShowIn: "出现位置",
		/* 位置开关：点亮式 chip 的短字（不用「显示在侧边工具栏」这种长句） */
		cbChipRail: "工具栏",
		cbChipRailTip: "点一下在侧边工具栏显示，再点一下取消",
		cbChipSelbar: "划词",
		cbChipSelbarTip: "点一下在划词工具条显示，再点一下取消",

		/* ── 阅读格式管理（2026-10-16）────────────────────────── */
		secFormatManager: "阅读格式",
		fmtManagerName: "停用不需要的格式",
		fmtManagerDesc:
			"某种格式的阅读功能出问题时，把它关掉即可：该格式不再由 UNreader 打开（双击会落到 Obsidian 的默认处理），也不再出现在书架，避免影响其他格式与插件整体。进度、标注、置顶等数据按路径保存，重新打开后全部还在。改动需要重载插件或重启 Obsidian 后完全生效。",
		fmtNameEpub: "EPUB 电子书",
		fmtDescEpub: "可重排的 EPUB 电子书（阅读器主力格式）。关闭后不再注册 .epub 打开方式，书架也不再列出。",
		fmtNameMobi: "MOBI 电子书",
		fmtDescMobi: "KF8 格式的 MOBI 电子书（重排阅读）。关闭后不再注册 .mobi 打开方式，书架也不再列出。",
		fmtNameAzw3: "AZW3 电子书",
		fmtDescAzw3: "KF8 格式的 AZW3 电子书（重排阅读）。关闭后不再注册 .azw3 打开方式，书架也不再列出。",
		fmtNameTxt: "TXT 纯文本",
		fmtDescTxt: "纯文本电子书（自动识别并切分章节后重排）。关闭后不再注册 .txt 打开方式，书架也不再列出。",
		fmtNameHtml: "HTML 网页",
		fmtDescHtml: "本地 HTML/HTM 网页文件（只做阅读强化，不进书架）。关闭后不再注册 .html / .htm 打开方式。",
		fmtNameMd: "Markdown 笔记",
		fmtDescMd:
			"Markdown 笔记的阅读增强：官方阅读模式下的进度条、章节目录条与沉浸阅读。.md 文件本身仍由 Obsidian 管理；关闭后这些叠加元素不再出现（ Obsidian 自带的阅读功能不受影响）。",
		fmtNameRss: "RSS 订阅",
		fmtDescRss: "RSS/Atom/JSON Feed 订阅与文章阅读。关闭后订阅命令、订阅管理面板与侧边栏「订阅」页都不再出现，已有订阅数据保留。",
		fmtOffReload: "已停用「{name}」的阅读。重载插件或重启 Obsidian 后完全生效。",

		mdRecentTitle: "最近读过的笔记",
		mdRecentDesc: "「笔记」侧边页顶部的最近打开列表（最多 12 条）。",
		mdStarredTitle: "置顶笔记",
		mdStarredDesc: "在 Markdown 笔记阅读视图里置顶的笔记，会显示在「笔记」侧边页顶部。",
		mdClearRecent: "清空最近列表",
		mdUnstar: "取消置顶",

		/* ── AI（经 UNagent 桥）──────────────────────────────── */
		secAi: "AI",
		aiBridgeDesc:
			"AI 能力由 UNagent 提供，本插件只做入口开关。模型与 API key 在 UNagent 中配置。",
		aiSelTranslateName: "选区翻译",
		aiSelTranslateDesc:
			"选中文字后，划词工具条出现翻译入口。译文以卡片形式显示，不改动原文。",
		aiTargetLangName: "翻译目标语言",
		aiTargetLangDesc: "全文翻译与选区翻译的目标语言，写进提示词。",
		aiCustomTitle: "自定义功能",
		aiCustomDesc: "自定义提示词，接在划词工具条与 AI 面板里。",
		aiCustomAdd: "添加功能",
		aiCustomName: "功能名称",
		aiCustomPrompt: "提示词",
		aiToolsTitle: "AI 工具",
		aiToolsDesc: "划词工具条「统一 AI 入口」里的条目。停用的工具不会出现在工具条上。",
		aiToolReset: "恢复默认",
		aiToolScopeFull: "全文",
		aiToolScopeSel: "选区",

		/* ── 侧边栏 / 书架 ───────────────────────────────────── */
		secShelf: "书架",
		shelfSortName: "排序方式",
		shelfSortScan: "扫描顺序",
		shelfSortRecent: "最近阅读",
		shelfSortManual: "手动排序",
		shelfManualUp: "上移",
		shelfManualDown: "下移",
		shelfPin: "置顶",
		shelfUnpin: "取消置顶",
		shelfCategoryTitle: "分类",
		shelfCategoryAdd: "新建分类",
		shelfCategoryRename: "重命名",
		shelfCategoryDelete: "删除分类",
		shelfCategoryDeleteConfirm: "删除分类「{name}」？其中的书会回到「未分类」，书本身不受影响。",
		shelfUncategorized: "未分类",
		shelfHiddenTitle: "已从书架移除",
		shelfHiddenDesc: "从书架隐藏的书籍。隐藏不影响阅读进度与标注。",
		shelfRestore: "恢复到书架",
		shelfExcludeFolders: "排除的文件夹",
		shelfExcludeFoldersDesc:
			"命中的文件夹不出现在书架与「打开书籍」列表里，但文件本身不受任何影响：文件树 / 链接照常能打开，进度、标注、置顶全部保留。",
		shelfExcludeAdd: "添加文件夹",
		shelfExcludeRemove: "移除",
		shelfExcludePick: "选择文件夹",

		/* ── 外观（设置页内仅存全局项）───────────────────────── */
		secAppearance: "外观",
		appearanceNote:
			"字体、排版、主题色、背景图等阅读外观，全部在阅读界面右上角的「阅读外观」面板里实时调节，不在这里重复。",
		webDeviceName: "本地 HTML 设备模式",
		webDeviceDesc: "本地 HTML 书在手机 / 平板 / 桌面上模拟的视口宽度。",
		webDeviceAuto: "自动",
		webDevicePhone: "手机",
		webDeviceTablet: "平板",
		webDeviceDesktop: "桌面",

		/* ── 数据与调试 ───────────────────────────────────────── */
		secDataDebug: "数据与调试",
		debugLogName: "诊断日志",
		debugLogDesc:
			"记录插件运行中的关键事件与耗时，用于排查问题。默认关闭，开启后完全无捕获开销。",
		debugLogExport: "导出诊断报告",
		debugLogExportDesc: "把诊断日志整理成一份报告存进库内，便于发给开发者。",
		debugLogExported: "诊断报告已保存到 {path}",

		/* ── 书籍格式 ─────────────────────────────────────────── */
		secFormats: "支持格式",
		formatNote:
			"EPUB / MOBI / AZW3 / TXT / 本地 HTML / RSS。PDF 已整体移除。",

		/* ── Notice / 通用动作 ───────────────────────────────── */
		ok: "好",
		cancel: "取消",
		save: "保存",
		delete: "删除",
		confirm: "确定",
		close: "关闭",
		rename: "重命名",
		copy: "复制",
		copied: "已复制到剪贴板",
		copyFailed: "复制失败",
		remove: "移除",
		add: "添加",
		edit: "编辑",
		reset: "恢复默认",
		loading: "加载中…",
		unknownError: "出错了：{error}",

		/* ── 命令名称（命令 ID 与 main.ts 注册点对应）────────── */
		cmdOpenReader: "打开阅读器面板",
		cmdReleaseNotes: "UNreader：查看更新说明",
		releaseNotesTitle: "更新说明",
		cmdOpenBook: "全库：选择并打开书籍",
		cmdToggleAnnotations: "当前阅读器：切换标注侧栏",
		cmdToggleBookshelf: "当前阅读器：切换书架侧栏",
		cmdToggleFeeds: "当前阅读器：切换订阅侧栏",
		cmdToggleSidebarSide: "侧栏位置：在左侧 / 右侧之间切换（没打开时落在右侧）",
		cmdRefreshFeeds: "刷新全部启用的订阅",
		cmdAddFeed: "添加订阅源",
		cmdNextUnreadFeed: "打开一篇未读文章（全部订阅）",
		cmdToggleToc: "当前书籍：切换目录面板",
		cmdToggleMdImmersion: "当前笔记：切换沉浸阅读",
		cmdAddBookmark: "当前书籍：添加阅读位置书签",
		cmdTranslateSelection: "翻译当前书籍选区",
		cmdHighlightSelection: "当前选区：标为{color}高亮",
		cmdToggleAppearance: "当前阅读器：切换外观面板",
		cmdToggleFullImmersion: "当前阅读器：切换全沉浸",
		cmdSnapshotNeighborUi: "诊断：保存相邻界面快照到库根",
		cmdExportDebugLog: "诊断：导出日志到库根目录",

		/* ── 命令执行时的提示 ─────────────────────────────────── */
		noticeNoActiveReader: "未找到正在使用的阅读器：请先打开一本书再执行此命令",
		noticeMdOverlayOff: "笔记沉浸阅读已在笔记阅读视图的外观面板中关闭",
		noticeNoMdReadingView: "未找到处于阅读模式的 markdown 笔记（此命令只作用于阅读视图）",
		noticeUnsupportedFile: "《{name}》不是 UNreader 支持的格式（EPUB / MOBI / AZW3 / TXT / HTML），已阻止打开",
		noticeFormatDisabled: "《{name}》的阅读功能已在设置中停用（设置 → UNreader → 阅读格式），已阻止打开",
		noticeMdFormatDisabled: "Markdown 笔记阅读增强已在设置中停用（设置 → UNreader → 阅读格式）",
		noticeRssFormatDisabled: "RSS 订阅阅读已在设置中停用（设置 → UNreader → 阅读格式）",
		noticeNotMarkdownNote: "《{name}》由其它插件管理（如 Excalidraw），不是 Markdown 笔记，UNreader 已跳过",
		noticeNoSelectionToTranslate: "没有可翻译的选中文本：先在书内选中文字再执行本命令",
		noticeNoSelectionToHighlight: "先在书或笔记的阅读视图里选中文字，再执行高亮命令",
		noticeSnapshotSaved: "相邻界面快照已保存到 {path}",
		noticeSnapshotFailed: "快照失败（详见控制台）",
		noticeDebugLogEmpty: "暂无诊断日志：请先在插件设置里打开「调试日志」，复现问题后再执行本命令",
		noticeDebugLogSaved: "诊断日志已保存到 {path}",
		noticeDebugLogExportFailed: "导出诊断日志失败（详见控制台）",

		/* ── 高亮色标签（显示层用；持久化键在别处）───────────── */
		colorYellow: "黄",
		colorOrange: "橙",
		colorGreen: "绿",
		colorBlue: "蓝",
		colorRed: "红",
		colorPurple: "紫",

		/* ── UNagent 桥的三态指引（reason 键由 unagentBridge 拼出）── */
		guidanceNotInstalled:
			"未安装或已禁用 UNagent：安装并在其设置中配置模型后，即可使用选区翻译",
		guidanceNoMethod: "UNagent 版本过旧：请升级 UNagent 后重试",
		guidanceNotConfigured: "UNagent 尚未配置模型：请打开 UNagent 设置选择模型",

		/* ── 书架 ─────────────────────────────────────────────── */
		secFeed: "订阅",
		shelfSecTitle: "书架",
		shelfFormatsName: "收录的格式",
		shelfFormatsDesc:
			"书架与「打开书籍」只列出 {formats}。HTML、PDF、Markdown、FB2 等不进书籍管理界面 —— 文件在文件树中原样保留，其中 HTML 双击仍会用 UNreader 阅读（只是不再当作书管理）。",
		shelfFollowObsidianName: "跟随 Obsidian 的排除文件夹",
		shelfFollowObsidianDesc:
			"把官方「设置 → 文件与链接 → 排除文件」里的条目也用来过滤书架。官方那边加一条（如某个附件或资料目录），书架里就少一批书 —— 当前官方共 {count} 条排除项。排除只影响书籍列表：文件本身、阅读进度与标注都不受影响。",
		shelfExtraExcludeName: "额外排除的文件夹",
		shelfExtraExcludeSome: "以下文件夹里的书不会出现在书架与「打开书籍」列表里。",
		shelfExtraExcludeNone:
			"还没有额外排除的文件夹。需要把某个目录（下载、附件、别人的资料……）从书架里摘掉时在这里添加。",
		shelfExcludeAddFolder: "添加文件夹",
		shelfExcludeRemoveFolder: "移除",

		/* ── 订阅设置行 ───────────────────────────────────────── */
		feedRefreshOnOpenName: "打开订阅板块时自动刷新",
		feedRefreshOnOpenDesc:
			"只在用户首次打开订阅侧边栏时触发一次受控刷新；插件启动、布局恢复和后台标签不会发起网络请求。",
		feedMarkReadName: "打开文章即标记已读",
		feedMarkReadDesc: "打开文章或播客详情时写入已读时间；关闭后仍可通过文章卡片手动管理。",
		feedFulltextName: "自动抓取网页全文",
		feedFulltextDesc: "订阅源只给标题或摘要时，打开文章会尝试读取原网页正文；网页抓取失败仍保留摘要。",
		feedRemoteImagesName: "加载远程图片",
		feedRemoteImagesDesc: "关闭后文章正文中的远程图片会被移除，适合移动网络或隐私敏感场景。",
		feedEntryLimitName: "每个订阅保留文章数",
		feedEntryLimitDesc:
			"刷新后按发布时间保留最新文章，超出上限的旧文章会被清理以控制体积；星标文章、已保存全文的文章与有笔记（高亮/批注/书签）的文章长期保留，不参与清理。",
		feedImageCacheName: "图片缓存上限",
		feedImageCacheDesc: "文章图片保存在本机的离线缓存里，不随库同步。单位为兆字节，0 表示不落盘缓存。",
		feedMediaCacheName: "播客缓存上限",
		feedMediaCacheDesc: "播客默认流式播放，只有显式下载才写入本机缓存。单位为兆字节。",
		feedClearMediaCache: "清空媒体缓存",
		feedCachesCleared: "RSS 图片和播客缓存已清空",

		/* ── 资源管理 ─────────────────────────────────────────── */
		resSecTitle: "资源管理",
		resFontName: "字体资源",
		resFontDesc: "库内字体文件；可选择保留使用，或在所有设备上停用（不删除文件）。",
		resImageName: "图片资源",
		resImageDesc: "库内共享背景图；可选择保留使用，或在所有设备上停用（不删除文件）。",
		resCountDesc: "{desc} 当前 {count} 项。",
		resManage: "管理",
		resManagerFontTitle: "字体资源管理",
		resManagerImageTitle: "图片资源管理",
		resManagerDesc:
			"资源存放在库内并随库同步。保留使用 = 所有设备和预设都可使用；移除 = 在所有设备上停用，文件与引用仍保留；删除文件 = 清理资源本体并清除所有引用。",
		resManagerEmptyFonts: "暂无字体资源",
		resManagerEmptyImages: "暂无图片资源",
		resManagerReferenceCount: " · 被引用 {count} 处",
		resManagerKeep: "保留使用",
		resManagerRemoved: "已移除",
		resManagerDelete: "删除文件",
		resManagerDeleteTitle: "删除库内资源文件",
		resDeleteConfirmTitle: "删除资源",
		resDeleteConfirmBody:
			"删除库内资源文件“{name}”后，它会随库同步删除；{count} 处配置会清除对此资源的引用，之后需要重新选择文件才能恢复。确定删除？",
		resDeleteFailed: "资源删除失败",
		resDeleted: "已删除资源“{name}”",

		/* ── 阅读外观面板与相关弹窗 ─────────────────────────────── */
		apTitle: "阅读外观",
		apOpen: "打开阅读外观",
		apClose: "关闭阅读外观",
		apFontSize: "字号",
		apMarginLeft: "左边距",
		apMarginRight: "右边距",
		apMarginHint: "左右边距是下限：窗口够宽时正文列会居中（留白按阅读宽度算），边距要超过那份留白才推得动；窄窗口与手机上完全生效。",
		apLineHeight: "行距",
		apParagraphSpacing: "段间距",
		apFirstLineIndent: "首行缩进",
		apCharacterUnit: "{count} 字符",
		apLetterSpacing: "字间距",
		apColorsHeading: "界面颜色",
		apColorSource: "配色来源",
		apFollowObsidian: "跟随 Obsidian",
		apCustom: "自定义",
		apResetFollowObsidian: "恢复默认：跟随 Obsidian",
		apTheme: "主题",
		apAuto: "自动",
		apLight: "浅色",
		apDark: "深色",
		apResetAuto: "恢复默认：自动",
		apColorFollowHint: "背景与文字颜色跟随 Obsidian 当前主题（明暗切换自动同步）。切换「配色来源」为「自定义」可单独设置颜色。",
		apBackgroundColor: "背景色",
		apTextColor: "文字颜色",
		apBackgroundImagesHeading: "背景图片",
		apImageScope: "作用范围",
		apSharedLightDark: "深浅共用",
		apSeparateLightDark: "深浅分别",
		apResetShared: "恢复默认：深浅共用",
		apLightImage: "浅色图片",
		apDarkImage: "深色图片",
		apImage: "图片",
		apImageBlur: "图片模糊",
		apGlassEffect: "玻璃效果",
		apGlassBlur: "玻璃模糊",
		apGlassOpacity: "玻璃不透明",
		apGlassEnabledHint: "已启用玻璃效果，文字浮于图片之上，可通过“玻璃不透明”调节可读性。",
		apGlassHint: "建议开启玻璃效果或提高图片模糊，避免文字与图片对比不足。",
		apNormalMode: "常态模式",
		apShowToolbar: "显示工具栏",
		apScrollAutoHide: "滑动自动隐藏",
		apFloatingToc: "浮动目录条",
		apChapterProgress: "章节进度条",
		apTakeOverNativeUi: "接管原生界面",
		apShowHeader: "显示页首",
		apShowBottomToolbar: "显示底部工具栏",
		apToolbarSize: "按钮/目录条大小",
		apNormalModeHint: "点击正文空白始终可临时唤出工具栏；“滑动自动隐藏”只管插件工具层（下滑收起按钮，左缘仍留 6px 把手；上滑/悬停/点把手可唤出），“接管原生界面”让 Obsidian 的页首/底栏向下滚动时收起、向上滚动不再自动出现（点按正文空白才唤出；关闭后完全不碰原生界面）。浮动目录与章节进度按各自开关显示，不受工具栏显隐影响。",
		apFullImmersion: "全沉浸模式",
		apShowFloatingToc: "显示浮动目录",
		apShowProgress: "显示章节进度条",
		apTapScreenReveal: "点击屏幕显示界面",
		apImmersionHint: "全沉浸默认隐藏所有界面，仅保留左上角半透明退出图标；开启“点击屏幕显示界面”后，点击正文可临时唤出常态工具层与原生界面。目录与进度只有在上方全局开关开启时才可作为例外保留。",
		apResetAll: "重置全部为默认",
		apResetDefault: "恢复默认",
		apFont: "字体",
		apCustomFonts: "自定义字体",
		apFontMissing: "字体已停用或丢失：{name}",
		apFontWithExtension: "{name}（{ext}）",
		apVault: "库",
		apSystem: "系统",
		apPickFontVault: "从库中选择字体文件导入",
		apPickFontSystem: "从系统选择本地字体文件导入",
		apPreset: "预设",
		apChoosePreset: "选择预设…",
		apNoPresets: "暂无预设",
		apSelectPresetFirst: "请先在下拉框选择一个预设",
		apSavePresetTooltip: "已选中预设时更新该预设，未选中时存为新预设",
		apRenamePresetTooltip: "重命名选中预设",
		apDeletePresetTooltip: "删除选中预设",
		apImageManualInput: "图片地址（手动输入）",
		apImageSet: "已设置图片",
		apPresetImage: "预设内图片",
		apPickImageVault: "从库中选择图片",
		apPickImageSystem: "从系统选择本地图片",
		apRemoveBackgroundImage: "移除背景图片",
		mdApDescription: "Markdown 的字体、行距、页宽与背景由 Obsidian 和主题控制；此处只设置插件提供的阅读组件。",
		mdApProgressScope: "进度分段",
		mdApWhole: "全文一根进度条",
		mdApHeading1: "按一级标题分段",
		mdApHeading2: "按二级标题分段",
		mdApHeading3: "按三级标题分段",
		mdApHeading4: "按四级标题分段",
		mdApHeading5: "按五级标题分段",
		mdApHeading6: "按六级标题分段",
		mdApImmersionCommand: "提供沉浸阅读命令",
		mdApKeepToc: "沉浸时保留浮动目录条",
		mdApKeepProgress: "沉浸时保留章节进度条",
		fontPickTitle: "选择字体文件",
		fontPickDesc: "从库中选择一个字体文件（ttf / otf / woff / woff2）。选中的文件会复制到插件字体文件夹，之后所有设备都能使用。",
		fontPickSearch: "搜索字体文件名…",
		fontPickNoMatches: "没有匹配的字体",
		bgPickTitle: "选择背景图片",
		bgPickDesc: "从库中选择一张图片作为阅读背景（最大 2MB）。",
		bgPickSearch: "搜索图片文件名…",
		bgPickNoMatches: "没有匹配的图片",
		presetRenameTitle: "重命名预设",
		presetSaveTitle: "保存预设",
		presetRenameDesc: "修改预设名称",
		presetSaveDesc: "为当前外观保存为新预设，请输入名称",
		presetNamePlaceholder: "预设名称，例如：夜间护眼",
		presetRenameAction: "重命名",
		presetSaveAction: "保存",
		presetOverwriteTitle: "覆盖预设",
		presetOverwriteBody: "已存在名为“{name}”的外观预设。覆盖会替换其中保存的整套外观设置；当前阅读外观不会因此改变。",
		presetOverwriteAction: "覆盖",
		presetSaved: "已保存预设“{name}”",
		presetApplied: "已应用预设“{name}”",
		presetDeleteTitle: "删除预设",
		presetDeleteBody: "删除外观预设“{name}”？这只删除已保存的预设，不会改动当前阅读外观或书籍。",
		presetDeleteAction: "删除",
		presetDeleted: "已删除预设“{name}”",
		presetRenamed: "已重命名为“{name}”",
		presetUpdateBody: "用当前阅读外观替换已保存的预设“{name}”？原来保存在该预设里的设置将被覆盖。",
		presetUpdated: "已更新预设“{name}”",

		/* ── 库内文件 ─────────────────────────────────────────── */
		filesSecTitle: "库内文件",
		excludeNotesName: "标注笔记不参与搜索",
		excludeNotesDesc:
			"把插件数据目录登记进 Obsidian 的「排除文件」。开启（默认）：整个 {root}/{data}/ 登记为一条，高亮 / 书签旁车笔记不再出现在搜索、关系图谱与快速切换里（笔记文件与高亮功能本身不受影响），代价是搜不到高亮原文。关闭：改为逐个子目录登记并放过 Notes —— 笔记可以被搜索到。书籍从不登记。",

		/* ── 诊断 ─────────────────────────────────────────────── */
		diagSecTitle: "诊断",
		diagLogName: "调试日志",
		diagLogDesc:
			"插件异常需要排查时开启：捕获插件报错与关键事件到内存（关闭时零捕获零存储，重启即清空）。开启后复现问题，再导出发给开发者。",
		diagExportName: "导出日志",
		diagExportDesc: "当前已记录 {count} 条。复制到剪贴板或保存为库内文件后发给开发者。",
		diagCopyLog: "复制日志",
		diagSaveToVault: "保存到库",
		diagClear: "清空",
		diagNoLog: "暂无日志",
		diagLogCopied: "日志已复制到剪贴板",
		diagLogSaved: "日志已保存到 {path}",
		diagLogSaveFailed: "保存失败",

		/* ── 反馈卡 ───────────────────────────────────────────── */
		feedbackSecTitle: "反馈渠道",
		feedbackCardTitle: "反馈渠道",
		feedbackCardDesc: "遇到问题、想提建议或参与内测，欢迎通过以下渠道联系我们。",
		feedbackQrAlt: "QQ 频道二维码",
		feedbackQQTitle: "QQ 频道",
		feedbackQQDesc: "用手机 QQ 扫码，或点下方链接加入官方频道。",
		feedbackQQJoin: "打开加入链接",
		feedbackMailLabel: "QQ 邮箱",
		feedbackBiliLabel: "B站主页",

		/* ── 自定义按钮行内文案 ───────────────────────────────── */
		cbCommandDesc: "命令：{id}",
		cbIconPlaceholder: "图标名",
		cbIconAria: "Lucide 图标名",
		cbLabelPlaceholder: "按钮名称",
		cbShowInRailTip: "显示在侧边工具栏",
		cbShowInSelbarTip: "显示在划词工具条",

		/* ── 数据文件夹标签 ───────────────────────────────────── */
		dataLabelDefault: "默认位置（{path}）",
		dataLabelSelected: "{from} → {to}",

		/* ── 数据文件夹切换提示 ───────────────────────────────── */
		dataCollisionNotice:
			"未迁移：目标位置已有 {count} 个同名文件（如「{example}」），请先处理冲突",
		dataSetNoMigrate: "数据文件夹已设为「{path}」；没有需要迁移的数据文件",
		dataSetLeaveBehind:
			"数据文件夹已设为「{path}」，但这 {count} 个数据文件仍留在「{from}」，插件不会再去读它们 —— 请自行移动，或改用「迁移并切换」",
		dataSwitchFailed: "切换失败",
		dataMigrateFailed: "迁移失败",
		dataMigratedDone: "已迁移 {count} 个数据文件到「{path}」；书籍与书架顺序未动",

		/* ── 数据文件夹迁移弹窗 ───────────────────────────────── */
		migrateModalTitle: "迁移数据文件夹",
		migrateModalLead: "将把 {count} 个数据文件从「{from}」迁移到「{to}/{data}」。",
		migrateModalBody:
			"范围只有插件自己的数据（阅读进度 / 外观预设 / 字体 / 共享资源 / 标注笔记 / 订阅数据），统一收进新位置的 {data}/ 数据目录、原目录结构保留。书籍不在其中：它们留在各自原来的文件夹，照样能打开 —— 所以阅读进度、书架顺序与置顶状态都不需要改动。迁移前会检查重名文件，绝不覆盖；中途失败会自动回滚。",
		migrateModalMore: "…另有 {count} 个",
		migrateSwitchOnly: "仅切换，不迁移",
		migrateAndSwitch: "迁移并切换",
		migrateInProgress: "迁移中…",

		/* ── 选择器占位符 ─────────────────────────────────────── */
		pickExcludedFolder: "选择要从书架里排除的文件夹…",
		pickDataFolder: "选择外层文件夹（插件会在其中创建 {root}/{data}）…",
		pickCommand: "选择要绑定为按钮的命令…",
		pickRootDefault: "默认位置（{path}）",
		pickRootTarget: "{path} → 数据存入 {to}/{data}",
		cmdFlairAdded: "{id}（已添加）",
		cmdAlreadyBound: "该命令已经绑定过一个按钮：同一命令不能重复添加",
	},
	en: {
		/* ── Common / settings shell ─────────────────────────── */
		langLabel: "Interface language",
		langDesc:
			"“Auto” follows the Obsidian app language: Chinese apps (including Traditional) get Chinese, every other language gets English. “中文” and “English” ignore the app language and stay pinned.",
		langAuto: "Auto",
		langZh: "中文",
		langEn: "EN",
		langAutoResolved:
			"The Obsidian app language is {locale}, so the interface is in {lang}.",
		secGeneral: "General",

		/* ── Feedback ────────────────────────────────────────── */
		feedbackTitle: "Feedback & support",
		feedbackDesc: "Questions, ideas or plain complaints — all welcome.",
		feedbackEmail: "Email",
		feedbackQQChannel: "QQ channel",
		feedbackBilibili: "Bilibili",

		/* ── Data folder ─────────────────────────────────────── */
		secData: "Data",
		dataFolderName: "Data folder",
		dataFolderDesc:
			"You pick the outer materials folder. The plugin always creates {root}/{data}/ inside it and keeps reading progress, appearance presets, fonts, shared resources, annotation notes and feed data in that directory (nothing is scattered in the outer folder). Switching locations migrates those files as a whole; books are never moved — a book opens from anywhere in the vault, so progress, shelf order and note links are unaffected. Current: {label}",
		dataFolderPick: "Choose folder",
		dataFolderUseDefault: "Use default location",
		dataFolderCurrent: "Current: {label}",

		/* ── Reading ─────────────────────────────────────────── */
		secReading: "Reading",

		/* ── Custom buttons ──────────────────────────────────── */
		secCustomButtons: "Custom buttons",
		customButtonAddName: "Add a button",
		customButtonAddDesc:
			"Bind any Obsidian command (this plugin's or other plugins') to a button. Each button can appear in the side toolbar, in the selection toolbar (shown after you select text), or both. Unlimited: an overflowing side toolbar scrolls vertically, an overflowing selection toolbar scrolls horizontally. Tip: this plugin already ships six “highlight selection (yellow/orange/green/blue/red/purple)” commands you can bind straight to the selection toolbar.",
		customButtonAdd: "Add button",
		customButtonLabel: "Button label",
		customButtonLabelDesc: "Text shown on the button. Leave empty to use the command name.",
		customButtonIcon: "Icon",
		customButtonIconDesc: "A lucide icon name such as star. Leave empty to use the command's own icon.",
		customButtonSide: "Side toolbar",
		customButtonSideDesc: "Show it in the floating toolbar on the left of the reader and of the note reading view.",
		customButtonSel: "Selection toolbar",
		customButtonSelDesc: "Show it in the toolbar that pops up after you select text.",
		customButtonRemove: "Remove",
		cbCommandLabel: "Command",
		cbFieldLabel: "Label",
		cbFieldIcon: "Icon",
		cbFieldShowIn: "Show in",
		cbChipRail: "Toolbar",
		cbChipRailTip: "Tap to show it in the side toolbar, tap again to turn it off",
		cbChipSelbar: "Select",
		cbChipSelbarTip: "Tap to show it in the selection toolbar, tap again to turn it off",

		/* ── Reading format management (2026-10-16) ───────────── */
		secFormatManager: "Reading formats",
		fmtManagerName: "Turn off formats you do not need",
		fmtManagerDesc:
			"When the reading of a format breaks, turn it off here: UNreader will no longer open that format (double-clicking falls back to Obsidian's default handling) and it disappears from the bookshelf, so one broken format cannot take down the rest. Progress, highlights and pins are stored by path and all come back when you turn it on again. Changes take full effect after reloading the plugin or restarting Obsidian.",
		fmtNameEpub: "EPUB books",
		fmtDescEpub: "Reflowable EPUB books (the reader's main format). When off, .epub is no longer registered for opening and the bookshelf stops listing it.",
		fmtNameMobi: "MOBI books",
		fmtDescMobi: "KF8 MOBI books (reflowed while reading). When off, .mobi is no longer registered for opening and the bookshelf stops listing it.",
		fmtNameAzw3: "AZW3 books",
		fmtDescAzw3: "KF8 AZW3 books (reflowed while reading). When off, .azw3 is no longer registered for opening and the bookshelf stops listing it.",
		fmtNameTxt: "TXT plain text",
		fmtDescTxt: "Plain-text books (chapters are detected and split, then reflowed). When off, .txt is no longer registered for opening and the bookshelf stops listing it.",
		fmtNameHtml: "HTML pages",
		fmtDescHtml: "Local HTML/HTM pages (reading enhancement only; never listed on the bookshelf). When off, .html / .htm are no longer registered for opening.",
		fmtNameMd: "Markdown notes",
		fmtDescMd:
			"Reading enhancements for Markdown notes: the progress bar, the chapter rail and immersive reading on top of Obsidian's own reading mode. The .md files themselves stay managed by Obsidian; when off, these overlays simply do not appear (Obsidian's built-in reading is untouched).",
		fmtNameRss: "RSS feeds",
		fmtDescRss: "RSS/Atom/JSON Feed subscriptions and article reading. When off, the feed commands, the subscription manager and the \"Feeds\" side-panel page disappear; existing subscription data is kept.",
		fmtOffReload: "Reading of \"{name}\" is now off. Reload the plugin or restart Obsidian for it to take full effect.",

		mdRecentTitle: "Recently read notes",
		mdRecentDesc: "The recently-opened list at the top of the “Notes” side page (up to 12 entries).",
		mdStarredTitle: "Pinned notes",
		mdStarredDesc: "Notes pinned in the Markdown reading view appear at the top of the Notes side page.",
		mdClearRecent: "Clear the recent list",
		mdUnstar: "Unpin",

		/* ── AI (bridged from UNagent) ─────────────────────────── */
		secAi: "AI",
		aiBridgeDesc:
			"AI features are provided by UNagent; this plugin only controls where their entry points show up. Model and API key live in UNagent.",
		aiSelTranslateName: "Selection translation",
		aiSelTranslateDesc:
			"A translate entry appears in the selection toolbar after you select text. The translation is shown as a card and never rewrites the original.",
		aiTargetLangName: "Translation target language",
		aiTargetLangDesc: "Target language for both full-text and selection translation; goes into the prompt.",
		aiCustomTitle: "Custom functions",
		aiCustomDesc: "Custom prompts, available in the selection toolbar and in the AI panel.",
		aiCustomAdd: "Add function",
		aiCustomName: "Function name",
		aiCustomPrompt: "Prompt",
		aiToolsTitle: "AI tools",
		aiToolsDesc: "Entries in the unified AI menu of the selection toolbar. Disabled tools are hidden from the toolbar.",
		aiToolReset: "Reset to default",
		aiToolScopeFull: "Full text",
		aiToolScopeSel: "Selection",

		/* ── Shelf ────────────────────────────────────────────── */
		secShelf: "Bookshelf",
		shelfSortName: "Sort order",
		shelfSortScan: "Scan order",
		shelfSortRecent: "Recently read",
		shelfSortManual: "Manual order",
		shelfManualUp: "Move up",
		shelfManualDown: "Move down",
		shelfPin: "Pin",
		shelfUnpin: "Unpin",
		shelfCategoryTitle: "Categories",
		shelfCategoryAdd: "New category",
		shelfCategoryRename: "Rename",
		shelfCategoryDelete: "Delete category",
		shelfCategoryDeleteConfirm: 'Delete the category “{name}”? Its books fall back to “Uncategorized”; the books themselves are untouched.',
		shelfUncategorized: "Uncategorized",
		shelfHiddenTitle: "Removed from the shelf",
		shelfHiddenDesc: "Books hidden from the shelf. Hiding affects neither reading progress nor annotations.",
		shelfRestore: "Restore to shelf",
		shelfExcludeFolders: "Excluded folders",
		shelfExcludeFoldersDesc:
			"Books under these folders do not appear in the shelf or the “Open book” list, but the files themselves are unaffected: the file tree and links open them as usual, and progress, annotations and pins are all preserved.",
		shelfExcludeAdd: "Add folder",
		shelfExcludeRemove: "Remove",
		shelfExcludePick: "Choose folder",

		/* ── Appearance ───────────────────────────────────────── */
		secAppearance: "Appearance",
		appearanceNote:
			"Fonts, typography, theme colour, background image and the rest of the reading appearance are all adjusted live in the “Reading appearance” panel at the top right of the reader — they are not repeated here.",
		webDeviceName: "Local HTML device mode",
		webDeviceDesc: "The viewport width a local HTML book is rendered at on phone / tablet / desktop.",
		webDeviceAuto: "Auto",
		webDevicePhone: "Phone",
		webDeviceTablet: "Tablet",
		webDeviceDesktop: "Desktop",

		/* ── Data & diagnostics ───────────────────────────────── */
		secDataDebug: "Data & diagnostics",
		debugLogName: "Diagnostic log",
		debugLogDesc:
			"Record key events and timings inside the plugin to troubleshoot problems. Off by default, and while off nothing is captured at all.",
		debugLogExport: "Export a diagnostic report",
		debugLogExportDesc:
			"Tidy the diagnostic log into a report saved in your vault, ready to send to the developer.",
		debugLogExported: "Diagnostic report saved to {path}",

		/* ── Formats ──────────────────────────────────────────── */
		secFormats: "Supported formats",
		formatNote:
			"EPUB / MOBI / AZW3 / TXT / local HTML / RSS. PDF support was removed entirely.",

		/* ── Notices / generic actions ────────────────────────── */
		ok: "OK",
		cancel: "Cancel",
		save: "Save",
		delete: "Delete",
		confirm: "Confirm",
		close: "Close",
		rename: "Rename",
		copy: "Copy",
		copied: "Copied to clipboard",
		copyFailed: "Copy failed",
		remove: "Remove",
		add: "Add",
		edit: "Edit",
		reset: "Reset to default",
		loading: "Loading…",
		unknownError: "Something went wrong: {error}",

		/* ── Command names (IDs match registrations in main.ts) ─ */
		cmdOpenReader: "Open reader panel",
		cmdReleaseNotes: "UNreader: View release notes",
		releaseNotesTitle: "Release notes",
		cmdOpenBook: "Vault: choose and open a book",
		cmdToggleAnnotations: "Current reader: toggle annotations sidebar",
		cmdToggleBookshelf: "Current reader: toggle bookshelf sidebar",
		cmdToggleFeeds: "Current reader: toggle feeds sidebar",
		cmdToggleSidebarSide: "Sidebar position: toggle between left and right (opens on the right when hidden)",
		cmdRefreshFeeds: "Refresh all enabled feeds",
		cmdAddFeed: "Add a feed subscription",
		cmdNextUnreadFeed: "Open an unread article (all feeds)",
		cmdToggleToc: "Current book: toggle table of contents",
		cmdToggleMdImmersion: "Current note: toggle immersive reading",
		cmdAddBookmark: "Current book: bookmark reading position",
		cmdTranslateSelection: "Translate current book selection",
		cmdHighlightSelection: "Current selection: highlight in {color}",
		cmdToggleAppearance: "Current reader: toggle appearance panel",
		cmdToggleFullImmersion: "Current reader: toggle full immersion",
		cmdSnapshotNeighborUi: "Diagnostics: save neighbouring view snapshot to vault root",
		cmdExportDebugLog: "Diagnostics: export log to vault root",

		/* ── Notices raised while running a command ──────────── */
		noticeNoActiveReader:
			"No reader in use: open a book first, then run this command",
		noticeMdOverlayOff:
			"Immersive note reading is turned off in the note reading view's appearance panel",
		noticeNoMdReadingView:
			"No markdown note in reading mode found (this command only applies to reading views)",
		noticeUnsupportedFile:
			"\"{name}\" is not a format UNreader supports (EPUB / MOBI / AZW3 / TXT / HTML), so opening it was blocked",
		noticeFormatDisabled:
			"Reading of \"{name}\" is turned off in settings (Settings → UNreader → Reading formats), so opening it was blocked",
		noticeMdFormatDisabled:
			"Markdown note reading enhancements are turned off in settings (Settings → UNreader → Reading formats)",
		noticeRssFormatDisabled:
			"RSS feed reading is turned off in settings (Settings → UNreader → Reading formats)",
		noticeNotMarkdownNote:
			"\"{name}\" is managed by another plugin (e.g. Excalidraw) and is not a Markdown note, so UNreader skipped it",
		noticeNoSelectionToTranslate:
			"Nothing to translate: select some text inside the book first",
		noticeNoSelectionToHighlight:
			"Select some text in a book or note reading view first, then run the highlight command",
		noticeSnapshotSaved: "Neighbouring-UI snapshot saved to {path}",
		noticeSnapshotFailed: "Snapshot failed (see the console)",
		noticeDebugLogEmpty:
			"No diagnostic log yet: enable the diagnostic log in the plugin settings, reproduce the problem, then run this command",
		noticeDebugLogSaved: "Diagnostic log saved to {path}",
		noticeDebugLogExportFailed: "Exporting the diagnostic log failed (see the console)",

		/* ── Highlight colour labels ─────────────────────────── */
		colorYellow: "yellow",
		colorOrange: "orange",
		colorGreen: "green",
		colorBlue: "blue",
		colorRed: "red",
		colorPurple: "purple",

		/* ── UNagent bridge guidance (reason key is assembled by unagentBridge) ── */
		guidanceNotInstalled:
			"UNagent is not installed or is disabled: install it and configure a model in its settings, then selection translation becomes available",
		guidanceNoMethod: "UNagent is too old: upgrade UNagent and try again",
		guidanceNotConfigured:
			"UNagent has no model configured yet: open UNagent's settings and pick a model",

		/* ── Bookshelf ────────────────────────────────────────── */
		secFeed: "Feeds",
		shelfSecTitle: "Bookshelf",
		shelfFormatsName: "Recognised formats",
		shelfFormatsDesc:
			"The bookshelf and “Open book” only list {formats}. HTML, PDF, Markdown, FB2 and the like do not appear in book management — the files stay in the file tree as they are, and opening an HTML file twice still reads it in UNreader (it is just no longer managed as a book).",
		shelfFollowObsidianName: "Follow Obsidian's excluded folders",
		shelfFollowObsidianDesc:
			"Also use the entries from Obsidian's “Settings → Files & links → Excluded files” to filter the shelf. Add one over there (an attachment or materials folder, say) and a batch of books disappears from the shelf — Obsidian currently has {count} exclusion(s). Exclusion only affects the book list: the files themselves, your reading progress and annotations are untouched.",
		shelfExtraExcludeName: "Additionally excluded folders",
		shelfExtraExcludeSome:
			"Books inside these folders do not show up in the shelf or the “Open book” list.",
		shelfExtraExcludeNone:
			"No additionally excluded folders yet. Add one here when you want to take a directory out of the shelf (downloads, attachments, someone else's materials…).",
		shelfExcludeAddFolder: "Add folder",
		shelfExcludeRemoveFolder: "Remove",

		/* ── Feed settings rows ────────────────────────────────── */
		feedRefreshOnOpenName: "Refresh when the feed view opens",
		feedRefreshOnOpenDesc:
			"Triggers one controlled refresh the first time you open the feeds sidebar; plugin startup, layout restore and background tabs never hit the network.",
		feedMarkReadName: "Mark as read on open",
		feedMarkReadDesc:
			"Writes a read timestamp when you open an article or a podcast entry; with this off you can still manage it by hand from the article card.",
		feedFulltextName: "Fetch full text automatically",
		feedFulltextDesc:
			"When a feed only carries a title or an excerpt, opening the article tries to read the original page body; if the fetch fails the excerpt is kept.",
		feedRemoteImagesName: "Load remote images",
		feedRemoteImagesDesc:
			"Turn this off to strip remote images from article bodies — useful on mobile data or when privacy matters.",
		feedEntryLimitName: "Articles kept per feed",
		feedEntryLimitDesc:
			"After a refresh the newest articles are kept by publish time and older ones beyond the limit are pruned to keep the footprint small; starred articles, articles saved as Markdown and articles with notes (highlights, annotations, bookmarks) are kept long-term and never pruned.",
		feedImageCacheName: "Image cache limit",
		feedImageCacheDesc:
			"Article images live in an offline cache on this device and are not synced with your vault. In megabytes; 0 means no cache on disk.",
		feedMediaCacheName: "Podcast cache limit",
		feedMediaCacheDesc:
			"Podcasts stream by default and only hit the local cache when you explicitly download them. In megabytes.",
		feedClearMediaCache: "Clear media cache",
		feedCachesCleared: "RSS image and podcast caches cleared",

		/* ── Resource management ──────────────────────────────── */
		resSecTitle: "Resource management",
		resFontName: "Font resources",
		resFontDesc:
			"Font files inside your vault; you can keep them in use or disable them on all devices (without deleting the file).",
		resImageName: "Image resources",
		resImageDesc:
			"Background images shared across the vault; you can keep them in use or disable them on all devices (without deleting the file).",
		resCountDesc: "{desc} Currently {count} item(s).",
		resManage: "Manage",
		resManagerFontTitle: "Font resources",
		resManagerImageTitle: "Image resources",
		resManagerDesc:
			"Resources are stored in your vault and synced with it. Keep in use to make them available across devices and presets. Remove to disable them everywhere while keeping files and references. Delete file to remove the resource and clear all references.",
		resManagerEmptyFonts: "No font resources",
		resManagerEmptyImages: "No image resources",
		resManagerReferenceCount: " · referenced in {count} places",
		resManagerKeep: "Keep in use",
		resManagerRemoved: "Removed",
		resManagerDelete: "Delete file",
		resManagerDeleteTitle: "Delete resource file from vault",
		resDeleteConfirmTitle: "Delete resource",
		resDeleteConfirmBody:
			"Deleting “{name}” will remove the file from the vault and sync that deletion. {count} saved appearance settings or presets will lose this reference, and you will need to choose a file again to restore it. Delete?",
		resDeleteFailed: "Could not delete resource",
		resDeleted: "Deleted resource “{name}”",

		/* ── Appearance panel and related dialogs ──────────────── */
		apTitle: "Reading appearance",
		apOpen: "Open reading appearance",
		apClose: "Close reading appearance",
		apFontSize: "Font size",
		apMarginLeft: "Left margin",
		apMarginRight: "Right margin",
		apMarginHint: "Left and right margins are minimums. On a wide window the text column is centered, so a margin must exceed the centered whitespace to move it; margins take full effect in narrow windows and on phones.",
		apLineHeight: "Line height",
		apParagraphSpacing: "Paragraph spacing",
		apFirstLineIndent: "First-line indent",
		apCharacterUnit: "{count} characters",
		apLetterSpacing: "Letter spacing",
		apColorsHeading: "Interface colors",
		apColorSource: "Color source",
		apFollowObsidian: "Follow Obsidian",
		apCustom: "Custom",
		apResetFollowObsidian: "Reset to default: Follow Obsidian",
		apTheme: "Theme",
		apAuto: "Auto",
		apLight: "Light",
		apDark: "Dark",
		apResetAuto: "Reset to default: Auto",
		apColorFollowHint: "Background and text colors follow the current Obsidian theme and update when it switches between light and dark. Choose Custom under Color source to set them separately.",
		apBackgroundColor: "Background color",
		apTextColor: "Text color",
		apBackgroundImagesHeading: "Background images",
		apImageScope: "Apply to",
		apSharedLightDark: "Share between light and dark",
		apSeparateLightDark: "Set separately for light and dark",
		apResetShared: "Reset to default: Share between light and dark",
		apLightImage: "Light image",
		apDarkImage: "Dark image",
		apImage: "Image",
		apImageBlur: "Image blur",
		apGlassEffect: "Glass effect",
		apGlassBlur: "Glass blur",
		apGlassOpacity: "Glass opacity",
		apGlassEnabledHint: "Glass effect is on. Text appears above the image; adjust Glass opacity to improve readability.",
		apGlassHint: "Turn on Glass effect or increase image blur to keep text readable against the image.",
		apNormalMode: "Normal mode",
		apShowToolbar: "Show toolbar",
		apScrollAutoHide: "Hide on scroll",
		apFloatingToc: "Floating table of contents",
		apChapterProgress: "Chapter progress bar",
		apTakeOverNativeUi: "Control Obsidian's navigation bars",
		apShowHeader: "Show header",
		apShowBottomToolbar: "Show bottom toolbar",
		apToolbarSize: "Toolbar and chapter rail size",
		apNormalModeHint: "Tap blank reading space to show the toolbar temporarily. Hide on scroll only controls the plugin toolbar: scrolling down retracts it, leaving a 6px handle; scrolling up, hovering or tapping the handle reveals it. Control Obsidian's navigation bars lets the header and bottom bar retract while scrolling down and stay hidden while scrolling up; tap blank reading space to show them. Turn it off to leave Obsidian's bars untouched. The table of contents and progress bar follow their own switches.",
		apFullImmersion: "Full immersion",
		apShowFloatingToc: "Show floating table of contents",
		apShowProgress: "Show chapter progress bar",
		apTapScreenReveal: "Tap screen to show interface",
		apImmersionHint: "Full immersion hides the interface by default, leaving only a translucent exit button in the upper-left corner. When Tap screen to show interface is on, tapping the text temporarily reveals the normal toolbar and Obsidian's navigation bars. The table of contents and progress bar can stay visible only when their switches above are enabled.",
		apResetAll: "Reset all to defaults",
		apResetDefault: "Reset to default",
		apFont: "Font",
		apCustomFonts: "Custom fonts",
		apFontMissing: "Font disabled or missing: {name}",
		apFontWithExtension: "{name} ({ext})",
		apVault: "Vault",
		apSystem: "System",
		apPickFontVault: "Choose a font file from the vault",
		apPickFontSystem: "Choose a local font file from your system",
		apPreset: "Preset",
		apChoosePreset: "Choose a preset…",
		apNoPresets: "No presets",
		apSelectPresetFirst: "Choose a preset from the list first",
		apSavePresetTooltip: "Update the selected preset, or save as a new preset when none is selected",
		apRenamePresetTooltip: "Rename the selected preset",
		apDeletePresetTooltip: "Delete the selected preset",
		apImageManualInput: "Image address (enter manually)",
		apImageSet: "Image set",
		apPresetImage: "Image in preset",
		apPickImageVault: "Choose an image from the vault",
		apPickImageSystem: "Choose a local image from your system",
		apRemoveBackgroundImage: "Remove background image",
		mdApDescription: "Obsidian and your theme control Markdown fonts, line spacing, page width and background. This panel only controls reading components provided by the plugin.",
		mdApProgressScope: "Progress segments",
		mdApWhole: "One bar for the whole document",
		mdApHeading1: "Split by level 1 headings",
		mdApHeading2: "Split by level 2 headings",
		mdApHeading3: "Split by level 3 headings",
		mdApHeading4: "Split by level 4 headings",
		mdApHeading5: "Split by level 5 headings",
		mdApHeading6: "Split by level 6 headings",
		mdApImmersionCommand: "Provide an immersive reading command",
		mdApKeepToc: "Keep floating table of contents during immersion",
		mdApKeepProgress: "Keep chapter progress bar during immersion",
		fontPickTitle: "Choose a font file",
		fontPickDesc: "Choose a font file from the vault (ttf / otf / woff / woff2). It will be copied into the plugin's font folder and made available on your other devices.",
		fontPickSearch: "Search font file names…",
		fontPickNoMatches: "No matching fonts",
		bgPickTitle: "Choose a background image",
		bgPickDesc: "Choose an image from the vault for your reading background (up to 2 MB).",
		bgPickSearch: "Search image file names…",
		bgPickNoMatches: "No matching images",
		presetRenameTitle: "Rename preset",
		presetSaveTitle: "Save preset",
		presetRenameDesc: "Change the preset name",
		presetSaveDesc: "Enter a name for this appearance preset",
		presetNamePlaceholder: "Preset name, for example: Night reading",
		presetRenameAction: "Rename",
		presetSaveAction: "Save",
		presetOverwriteTitle: "Replace preset",
		presetOverwriteBody: "An appearance preset named “{name}” already exists. Replacing it will overwrite all settings saved in that preset; it will not change the current reading appearance.",
		presetOverwriteAction: "Replace",
		presetSaved: "Saved preset “{name}”",
		presetApplied: "Applied preset “{name}”",
		presetDeleteTitle: "Delete preset",
		presetDeleteBody: "Delete the appearance preset “{name}”? This only removes the saved preset and will not change the current reading appearance or books.",
		presetDeleteAction: "Delete",
		presetDeleted: "Deleted preset “{name}”",
		presetRenamed: "Renamed to “{name}”",
		presetUpdateBody: "Replace the saved appearance preset “{name}” with the current appearance? All settings in the preset will be overwritten.",
		presetUpdated: "Updated preset “{name}”",

		/* ── Vault files ──────────────────────────────────────── */
		filesSecTitle: "Vault files",
		excludeNotesName: "Keep annotation notes out of search",
		excludeNotesDesc:
			"Register the plugin's data directory in Obsidian's “Excluded files”. On (the default): the whole {root}/{data}/ is registered as a single entry, so highlight and bookmark sidecar notes no longer show up in search, the graph or quick switcher (the note files and the highlighting feature itself are unaffected) — the trade-off is that you cannot search for highlight text. Off: subdirectories are registered individually and Notes is spared, so notes become searchable. Books are never registered.",

		/* ── Diagnostics ──────────────────────────────────────── */
		diagSecTitle: "Diagnostics",
		diagLogName: "Diagnostic log",
		diagLogDesc:
			"Turn this on when a plugin error needs investigating: it captures plugin errors and key events in memory (zero capture and zero storage while off, and it is cleared on restart). Reproduce the problem, then export and send it to the developer.",
		diagExportName: "Export the log",
		diagExportDesc:
			"{count} entries recorded so far. Copy it to the clipboard or save it as a vault file and send it to the developer.",
		diagCopyLog: "Copy log",
		diagSaveToVault: "Save to vault",
		diagClear: "Clear",
		diagNoLog: "No log entries yet",
		diagLogCopied: "Log copied to clipboard",
		diagLogSaved: "Log saved to {path}",
		diagLogSaveFailed: "Save failed",

		/* ── Feedback card ────────────────────────────────────── */
		feedbackSecTitle: "Feedback",
		feedbackCardTitle: "Feedback",
		feedbackCardDesc:
			"Hit a problem, want to suggest something or join the beta? Reach us through any of these channels.",
		feedbackQrAlt: "QQ channel QR code",
		feedbackQQTitle: "QQ channel",
		feedbackQQDesc: "Scan with the QQ app on your phone, or open the link below to join.",
		feedbackQQJoin: "Open the join link",
		feedbackMailLabel: "QQ mail",
		feedbackBiliLabel: "Bilibili",

		/* ── Custom button row ────────────────────────────────── */
		cbCommandDesc: "Command: {id}",
		cbIconPlaceholder: "Icon name",
		cbIconAria: "Lucide icon name",
		cbLabelPlaceholder: "Button label",
		cbShowInRailTip: "Show in the side toolbar",
		cbShowInSelbarTip: "Show in the selection toolbar",

		/* ── Data folder label ────────────────────────────────── */
		dataLabelDefault: "Default location ({path})",
		dataLabelSelected: "{from} → {to}",

		/* ── Data folder switch notices ───────────────────────── */
		dataCollisionNotice:
			"Not migrated: the target already holds {count} file(s) with the same name (e.g. “{example}”) — resolve the conflict first",
		dataSetNoMigrate:
			"Data folder set to “{path}”; there were no data files to migrate",
		dataSetLeaveBehind:
			"Data folder set to “{path}”, but those {count} data file(s) are still in “{from}” and the plugin will not read them any more — move them yourself, or use “Migrate and switch” instead",
		dataSwitchFailed: "Switching failed",
		dataMigrateFailed: "Migration failed",
		dataMigratedDone:
			"Migrated {count} data file(s) to “{path}”; books and shelf order untouched",

		/* ── Data folder migration modal ──────────────────────── */
		migrateModalTitle: "Migrate data folder",
		migrateModalLead:
			"{count} data file(s) will move from “{from}” to “{to}/{data}”.",
		migrateModalBody:
			"Only the plugin's own data is affected (reading progress, appearance presets, fonts, shared resources, annotation notes, feed data); it all goes into the {data}/ directory at the new location while the original structure is kept. Books are not involved: they stay in their own folders and keep opening as before, so reading progress, shelf order and pins need no changes. Files with clashing names are checked before anything moves and are never overwritten; a failure midway rolls back automatically.",
		migrateModalMore: "…and {count} more",
		migrateSwitchOnly: "Switch only, don't migrate",
		migrateAndSwitch: "Migrate and switch",
		migrateInProgress: "Migrating…",

		/* ── Picker placeholders ───────────────────────────────── */
		pickExcludedFolder: "Pick a folder to exclude from the shelf…",
		pickDataFolder: "Pick the outer folder (the plugin creates {root}/{data}/ inside it)…",
		pickCommand: "Pick the command to bind to a button…",
		pickRootDefault: "Default location ({path})",
		pickRootTarget: "{path} → data goes to {to}/{data}",
		cmdFlairAdded: "{id} (already added)",
		cmdAlreadyBound:
			"This command already has a button bound: the same command cannot be added twice",
	},
} as const

export type StrKey = keyof (typeof STRINGS)["zh"]

/** 当前语言的文案。缺键回落英文，再缺返回 key 本身（便于一眼看出漏翻）。 */
export function t(key: StrKey): string {
	return STRINGS[current][key] ?? STRINGS.en[key] ?? key
}

/** 带 `{placeholder}` 替换的文案。 */
export function tf(key: StrKey, vars: Record<string, string | number>): string {
	let s = t(key)
	for (const k of Object.keys(vars)) {
		s = s.split(`{${k}}`).join(String(vars[k]))
	}
	return s
}

/** 显式按指定语言取词（写死文案的场景，如双语文档标题）。 */
export function tt(lang: Lang, key: StrKey): string {
	return STRINGS[lang][key] ?? STRINGS.en[key] ?? key
}

/** 全部 key。测试脚本用它审计「字典已建但没接线」的情况。 */
export function allKeys(): StrKey[] {
	return Object.keys(STRINGS.zh) as StrKey[]
}

/**
 * 高亮色的**本地化**标签。刻意不复用 `HighlightColor.label`：后者是中文单字，
 * 也是持久化旁车笔记里 `- id | color | anchor` 之外的显示快照来源；这里按色名查
 * 字典，中文下与原 label 逐字相同（黄/橙/绿/蓝/红/紫），英文下给英文单词。
 * 未知色名回落到原 label，不让它显示成空白。
 */
export function highlightColorLabel(name: string, fallback: string): string {
	const key = `color${name.charAt(0).toUpperCase()}${name.slice(1)}` as StrKey
	// 用 Record 取而不是索引 STRINGS：key 是运行时拼出来的，TS 只能按字面量联合
	// 索引，直接下标会被当成「永不为 undefined」而误判成不可比。
	const table = STRINGS[current] as Record<string, string>
	const fallbackTable = STRINGS.en as Record<string, string>
	const value = table[key] ?? fallbackTable[key]
	return value ?? fallback
}
