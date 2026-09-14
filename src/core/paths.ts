/**
 * 插件在库内的固定落点（唯一事实源）。
 *
 * 这些路径原先是设置项（资料库根 / 书籍文件夹 / 字体文件夹 / 预设文件夹），但用户
 * 正常使用中从不接触它们 —— 设置页那一栏只是把「约定」重复暴露一遍，还额外制造了
 * 「路径填错 → 书读不到 / 笔记换地方」的失败面。撤掉那栏之后收敛到这里。
 *
 * 顺带解决此前字面量已经开始漂移的问题：main.ts 的进度/预设目录与 annotationStore
 * 的笔记目录各自硬编码过 "UNreader/…"，三处不同源，改一处就会分叉。
 *
 * 除 `BOOKS_FOLDER` 外的四个都被登记进官方的「排除文件」（`core/exclusions.ts`），
 * 只为消掉搜索/图谱里的噪音 —— **不改落点、不影响同步**。`BOOKS_FOLDER` 刻意不在列：
 * 书是用户的资产，要靠快速切换找得到。
 *
 * 另外这套常量路径**会被自愈**：被改名/挪走时由 `core/libraryFolders.ts` 搬回，
 * 而不是在旧路径重建一个空壳（静默的「数据全没了」观感）。
 */
export const UNREADER_ROOT = "UNreader"

/** 书籍的**建议**落点（不是限制）：书放在库里任何位置都能读，这里只是给用户一个
 *  明确的「放这儿」与插件建目录时的落点，见 bookService.getBookFiles 的注释。 */
export const BOOKS_FOLDER = `${UNREADER_ROOT}/Books`

/** 字体落点：外观面板里的「库 / 系统」导入都往这里落盘 */
export const FONTS_FOLDER = `${UNREADER_ROOT}/Fonts`

/** 外观预设（每个预设一个子文件夹：preset.json + 复制的背景图） */
export const PRESETS_FOLDER = `${UNREADER_ROOT}/Presets`

/** 阅读进度（每书一个 JSON，随库同步、冲突粒度小） */
export const PROGRESS_FOLDER = `${UNREADER_ROOT}/Progress`

/** 高亮/书签旁车笔记落点。
 *  固定在插件目录下，不再跟随书籍位置推导 —— 书籍一旦允许放在库里任意位置，
 *  「笔记跟着书走」就没有确定解了（同名不同目录的两本书会撞同一个笔记文件；
 *  而按路径 hash 命名又会让笔记文件名变得不可读）。 */
export const NOTES_FOLDER = `${UNREADER_ROOT}/Notes`
