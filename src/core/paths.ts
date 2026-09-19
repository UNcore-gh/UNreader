/**
 * 插件在库内的落点（唯一事实源）。
 *
 * ## 两层结构：可配置的「根」+ 固定的 `Data/` 容器（2026-09-19）
 *
 * 用户要求设置页能选「资料文件夹」，指的是**插件数据文件放哪儿**（阅读进度 / 外观预设 /
 * 字体 / 共享资源 / 标注笔记 / 订阅数据）。但一堆各自为政的数据目录会让库内文件树
 * 变得难懂（用户要的减法），所以：根可配置（`settings.dataFolder`，null = 默认库根
 * `UNreader/`），根下固定一个 `Data/` 容器，六个数据子目录**全部收在它里面**：
 *
 *     <数据根>/Data/{Progress,Presets,Fonts,Resources,Notes,Feeds}
 *
 * 换根时由 `core/libraryMigration.ts` 把这几个数据目录整树搬过去，**书籍一律不搬**
 * （书在库里任何位置都能读，见 `bookService.getBookFiles`）；旧版平铺在根下的六个
 * 目录由同一模块收进 `Data/`。
 *
 * ## `Books/` 已退役（2026-09-19）
 *
 * 它曾经只是「建议落点」：插件从不往里写文件，书放库里任何位置都能读。一个没人必须
 * 使用的空文件夹只会让用户困惑，所以插件**不再创建它**；已有目录里**有书 / 有用户文件
 * 就原样保留、空的空壳由迁移清理回收**。`Books` 只剩识别用途（自愈的内容证据、旧目录
 * 空壳清理），见 `BOOKS_DIR_NAME` —— 不再有活绑定路径。
 *
 * 这些路径用 `export let` + `setLibraryRoot()` 做**活绑定**：所有 import 点在读取时拿到的
 * 都是当前根下的路径，不必把每个调用方改成函数调用，切根后同一会话内立即生效。
 * ⚠️ 因此**不要在模块顶层缓存这些值**（`const X = [FONTS_FOLDER]` 在切根后就过期了），
 * 要派生值就写成函数、或每次读取。
 *
 * `Data/` 里的内部数据都被登记进官方的「排除文件」（`core/exclusions.ts`），
 * 只为消掉搜索/图谱里的噪音 —— **不改落点、不影响同步**；书从来不登记
 * （书是用户的资产，要靠快速切换找得到）。
 *
 * 另外这套路径**会被自愈**：被改名/挪走时由 `core/libraryFolders.ts` 搬回，
 * 而不是在旧路径重建一个空壳（静默的「数据全没了」观感）。
 */

/** 数据根的名字。它同时承担两个角色（2026-09-19）：
 *
 *  1. **用户没选资料库文件夹时**的默认落点 —— 数据就在库根的 `UNreader/`；
 *  2. **用户选了资料库文件夹时**，数据统一收进 `<用户选的文件夹>/UNreader/`。
 *
 *  也就是说 `settings.dataFolder` 存的是**父目录**（用户真正选中的那个），
 *  真正的数据根一律是 `dataRootOf(...)` 算出来的 `UNreader` 文件夹。理由见
 *  `normalizeDataFolder` / `dataRootOf` 的注释。 */
export const DEFAULT_ROOT = "UNreader"

/** 数据容器名（2026-09-19）：六个数据子目录统一收在它下面。
 *
 *  刻意**不加点前缀**：点目录是 Obsidian 里唯一「真隐藏」的手段（不进索引、文件树里
 *  不存在），但 **Obsidian Sync 会整体跳过点前缀目录**（官方帮助「同步设置与选择性同步」），
 *  而这些数据全是「他端同步到达即生效」的刚需 —— 用点目录 = 对 Sync 用户静默丢数据。
 *  完整论证见 `core/exclusions.ts` 文件头。 */
export const DATA_DIR_NAME = "Data"

/** `Books` 的名字。**仅用于识别**：自愈的内容证据（改名后的根里有没有我们的书）、
 *  旧目录空壳清理。不再是活绑定路径 —— 插件不建它、不往里写，书也不归它管。 */
export const BOOKS_DIR_NAME = "Books"

/** 数据目录的子目录名（相对 `Data/`）。换根时整树搬的就是这几个。 */
export const DATA_SUBFOLDERS = ["Progress", "Presets", "Fonts", "Resources", "Notes", "Feeds"] as const

export let UNREADER_ROOT = DEFAULT_ROOT

/** 数据容器：插件内部数据统一收在这里（见文件头）。 */
export let DATA_FOLDER = `${UNREADER_ROOT}/${DATA_DIR_NAME}`

/** 字体落点：外观面板里的「库 / 系统」导入都往这里落盘 */
export let FONTS_FOLDER = `${DATA_FOLDER}/Fonts`

/** 共享资源索引与插件自有素材。字体沿用历史目录 Fonts/，图片统一收纳在这里；
 *  两类资源都随库同步，预设只保存引用，不再各自复制一份图片。 */
export let RESOURCES_FOLDER = `${DATA_FOLDER}/Resources`

/** 共享图片资源落点 */
export let IMAGES_FOLDER = `${RESOURCES_FOLDER}/Images`

/** 资源启用状态索引（只保存资源管理信息，不保存任何设备外观配置） */
export let RESOURCE_MANIFEST = `${RESOURCES_FOLDER}/resources.json`

/** 外观预设（每个预设一个子文件夹：preset.json；新版背景图引用共享资源） */
export let PRESETS_FOLDER = `${DATA_FOLDER}/Presets`

/** 阅读进度（每书一个 JSON，随库同步、冲突粒度小） */
export let PROGRESS_FOLDER = `${DATA_FOLDER}/Progress`

/** 高亮/书签旁车笔记落点。
 *  固定在插件目录下，不再跟随书籍位置推导 —— 书籍一旦允许放在库里任意位置，
 *  「笔记跟着书走」就没有确定解了（同名不同目录的两本书会撞同一个笔记文件；
 *  而按路径 hash 命名又会让笔记文件名变得不可读）。 */
export let NOTES_FOLDER = `${DATA_FOLDER}/Notes`

/** RSS 订阅索引、文章快照与每条订阅的阅读状态。 */
export let FEEDS_FOLDER = `${DATA_FOLDER}/Feeds`

/** 规范化**用户选的资料库文件夹**（库内相对路径，即数据根的**父目录**）：
 *  空值 / `.` / 与默认根等价 → null（= 库根下的默认 `UNreader/`）。
 *
 *  ## 为什么要把「用户选中的目录」和「数据根」分开（2026-09-19）
 *
 *  用户原话：「选择资料库文件夹后，资料应该存放在这个文件夹，但是要把所有资料文件夹存放在
 *  一个 UNreader 的文件夹之中，而不是任他们飘落在选择的文件夹中」。所以选中项 = **父目录**，
 *  数据落点固定是它下面的 `UNreader/`。设置页因此显示两个概念：选中的父目录 + 实际数据根。
 *
 *  ## 为什么要剥掉尾部的 `UNreader`（而不是直接拼）
 *
 *  文件选择器里 `4-配置文件/UNreader` 是**看得见**的，用户完全可能直接选中它。直接拼就会
 *  得到 `4-配置文件/UNreader/UNreader` —— 数据忽然「不见了」（其实是被套了一层）。
 *  所以这里循环剥掉尾部若干层 `UNreader`，保证 `dataRootOf` 的幂等：
 *  `dataRootOf("x") === dataRootOf("x/UNreader") === "x/UNreader"`。
 *
 *  代价说清楚：想真的把数据放进 `x/UNreader/UNreader` 是**做不到**的 —— 那是套娃，
 *  没有合理用法（把落点选进自己的数据目录只会让路径无限长）。 */
export function normalizeDataFolder(path: string | null | undefined): string | null {
	let value = (path ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
	if (!value || value === ".") return null
	const suffix = `/${DEFAULT_ROOT}`
	while (value.endsWith(suffix)) value = value.slice(0, -suffix.length)
	// 库根下的 `UNreader` 就是默认根本身（不是「默认根下面的 UNreader」）
	if (!value || value === DEFAULT_ROOT) return null
	return value
}

/** 用户选的资料库文件夹 → **实际数据根**（`null` = 库根下的默认根）。
 *  自选目录一律追加一层 `UNreader`，见上面的长注释。 */
export function dataRootOf(folder: string | null | undefined): string {
	const parent = normalizeDataFolder(folder)
	return parent ? `${parent}/${DEFAULT_ROOT}` : DEFAULT_ROOT
}

/** 把设置里的**外层资料文件夹**应用到活绑定，并返回实际数据根。
 *
 *  启动恢复和设置页迁移都必须走这里；直接 `setLibraryRoot(settings.dataFolder)` 会把外层
 *  目录误当成数据根，导致 `Progress/`、`Presets/` 等散落在用户选中的文件夹里。 */
export function setConfiguredDataFolder(folder: string | null | undefined): string {
	const root = dataRootOf(folder)
	setLibraryRoot(root)
	return root
}

/** `path` 是不是**当前数据根**、或它里面的东西（数据根自身的子目录 / 文件）。
 *  用于两处：文件夹选择器排除自己（选进自己的数据目录只会套娃），以及文件列表隐藏。 */
export function insideDataRoot(path: string): boolean {
	return path === UNREADER_ROOT || path.startsWith(`${UNREADER_ROOT}/`)
}

/** 切换数据根。**只改落点**：搬文件、改引用、重建缓存都由调用方负责（见 main.applyDataFolder）。 */
export function setLibraryRoot(root: string | null): void {
	UNREADER_ROOT = root ?? DEFAULT_ROOT
	DATA_FOLDER = `${UNREADER_ROOT}/${DATA_DIR_NAME}`
	FONTS_FOLDER = `${DATA_FOLDER}/Fonts`
	RESOURCES_FOLDER = `${DATA_FOLDER}/Resources`
	IMAGES_FOLDER = `${RESOURCES_FOLDER}/Images`
	RESOURCE_MANIFEST = `${RESOURCES_FOLDER}/resources.json`
	PRESETS_FOLDER = `${DATA_FOLDER}/Presets`
	PROGRESS_FOLDER = `${DATA_FOLDER}/Progress`
	NOTES_FOLDER = `${DATA_FOLDER}/Notes`
	FEEDS_FOLDER = `${DATA_FOLDER}/Feeds`
}
