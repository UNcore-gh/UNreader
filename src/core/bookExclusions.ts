/**
 * 书架的「排除文件夹」判定：哪些文件夹里的书**不进书籍管理界面**。
 *
 * ## 两种来源，语义不同（这是本文件最需要读的一段）
 *
 * 1. **跟随 Obsidian 的「排除文件」**（`userIgnoreFilters`，默认开）—— 用户已经在官方
 *    设置里维护过一份「不关心」的目录（附件、模板、别人的资料……），让他再抄一遍没有
 *    道理。判定**优先走官方实现** `metadataCache.isUserIgnored(path)`：官方以后改匹配
 *    规则我们自动跟随；拿不到（内部 API 变动）才回落到自实现，且自实现照抄官方规则 ——
 *    全 `/…/` 形态按正则、其余 `^` + `escapeRegExp` **大小写不敏感前缀匹配**（论证见
 *    `core/exclusions.ts` 文件头，那里是往这份配置里**写**，这里是**读**）。
 *
 *    注意官方语义是**纯前缀**：条目 `Books` 会连 `Books-old/` 一起命中。这是官方的选择，
 *    我们原样继承 —— 我们只是「跟随」，没有立场替用户收紧它。
 *
 * 2. **插件自己的排除列表**（`settings.bookshelfExcludedFolders`）—— 由设置页的文件夹
 *    选择器产生，条目都是**目录路径**。这里按**目录边界**匹配（`X/Y` 或 `X/Y/…`），
 *    不能沿用官方的纯前缀：用户在设置里选的是「这个文件夹」，命中 `X/Y-old/` 就是误伤。
 *
 * ## 只影响列表，不影响文件与数据
 *
 * 被排除的书**照常打开**（文件树、链接、命令面板的原生入口都在），进度 / 标注 / 置顶
 * 全部保留 —— 排除纯粹是「别在我的书架里占位」。所以判定只挂在**收集书籍**这一层
 * （`bookService.collectBookFiles`），不许下渗到 `openBook` / 进度 / 笔记任何一处。
 * 用户把书移出排除目录后，置顶与进度自然回来（它们按路径存，与排除无关）。
 *
 * ## 全部失败方向都指向「不排除」
 *
 * 配置读取异常、正则条目非法、官方内部 API 抛错 —— 一律当作「这条不生效」继续判下一条。
 * 反过来的失败（读不到配置就把用户的书藏起来）是不可解释的：用户会以为书丢了。
 */
import { App } from "obsidian";
import * as debugLog from "./debugLog";

/** 排除设置的两个来源；调用方从 `plugin.settings` 组装。 */
export interface BookExclusionPrefs {
	/** 是否跟随 Obsidian 的「排除文件」（`userIgnoreFilters`） */
	followObsidian: boolean
	/** 插件自己的排除文件夹（库内相对路径，不带尾斜杠） */
	folders: readonly string[]
}

/** `userIgnoreFilters` 未进公开类型库、运行时可用（读的先例见 `main.ts` 的诊断报告）。 */
interface ConfigHost {
	getConfig?: (key: string) => unknown
}

/** 官方内部判定（存在时无条件优先，语义与官方设置页所见完全一致）。 */
interface IgnoreHost {
	isUserIgnored?: (path: string) => boolean
}

const CONFIG_KEY = "userIgnoreFilters";

/** `^` + 转义：官方对非正则条目的处理（此处只需照抄，见文件头）。 */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 目录路径归一化：去首尾空白与斜杠、统一分隔符（比较时再小写）。 */
export function normalizeExcludedFolder(raw: string): string {
	return String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** 设置页 / 迁移共用的比较键：去尾斜杠 + 小写（官方匹配大小写不敏感）。 */
export function excludedFolderKey(raw: string): string {
	return normalizeExcludedFolder(raw).toLowerCase();
}

/** 从官方配置读条目；拿不到（无 `getConfig`、抛错、形态不符）一律当空数组。 */
function readObsidianFilters(app: App): string[] {
	try {
		const host = app.vault as unknown as ConfigHost;
		const raw = host.getConfig?.(CONFIG_KEY);
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
	} catch (e) {
		debugLog.warn("[bookExclusions] 读取 Obsidian 排除项失败，按「不排除」处理", e);
		return [];
	}
}

/** 官方判定函数；拿不到就返回 null。**只作并集兜底**，不替代配置读取：
 *  配置条目（`userIgnoreFilters`）才是用户在官方设置页里看得见的那份事实，必须自实现；
 *  这个内部方法存在时再取一次并集 —— 万一官方把某些忽略项放在配置之外，我们也不会漏。 */
function obsidianJudge(app: App): ((path: string) => boolean) | null {
	for (const host of [app.metadataCache as unknown as IgnoreHost, app.vault as unknown as IgnoreHost]) {
		try {
			if (typeof host?.isUserIgnored === "function") {
				const fn = host.isUserIgnored.bind(host);
				// 逐次 try：官方内部实现抛错不该让整个书架渲染失败
				return p => { try { return !!fn(p); } catch { return false; } };
			}
		} catch { /* 试下一个宿主 */ }
	}
	return null;
}

/** 按官方口径自实现的条目匹配器 —— 配置条目（`userIgnoreFilters`）是**主路径**，
 *  也是唯一能断言「与官方设置页所见一致」的那一份（见文件头）。 */
function fallbackJudge(filters: readonly string[]): (path: string) => boolean {
	const tests: Array<(path: string) => boolean> = [];
	for (const entry of filters) {
		if (!entry) continue;
		// 全 `/…/` 形态 = 正则（官方口径）
		if (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/")) {
			try {
				const re = new RegExp(entry.slice(1, -1));
				tests.push(p => re.test(p));
			} catch {
				// 非法正则：官方同样会静默失效，这里跟着忽略（失败方向指向「不排除」）
			}
			continue;
		}
		// 其余 = `^` + 转义 + 大小写不敏感前缀（官方口径）
		try {
			const re = new RegExp("^" + escapeRegExp(entry), "i");
			tests.push(p => re.test(p));
		} catch { /* 转义后不可能非法，兜底 */ }
	}
	return path => tests.some(t => t(path));
}

/** 插件自己的条目：目录边界匹配（`X/Y` 或 `X/Y/…`）。 */
export function isUnderExcludedFolder(path: string, folder: string): boolean {
	const dir = normalizeExcludedFolder(folder).toLowerCase();
	if (!dir) return false;
	const p = path.toLowerCase();
	return p === dir || p.startsWith(`${dir}/`);
}

/**
 * 造一个「这个路径该不该从书籍列表里摘掉」的判定器。
 *
 * 每次收集书籍时造一次（构造代价 = 读一次官方配置 + 编译几条正则），
 * **不做跨调用缓存** —— 用户在官方设置里改了排除项，下次渲染必须当场生效。
 */
export function createBookPathExcluder(app: App, prefs: BookExclusionPrefs): (path: string) => boolean {
	const folders = (prefs.folders ?? []).filter(f => normalizeExcludedFolder(f) !== "");
	// **两者取并集**（不是二选一）：配置条目按官方口径自实现（与设置页所见一致、可测），
	// 官方内部判定器存在时再兜一层。理由见 `obsidianJudge` 的注释。
	const fromConfig = prefs.followObsidian === false ? null : fallbackJudge(readObsidianFilters(app));
	const fromOfficial = prefs.followObsidian === false ? null : obsidianJudge(app);
	if (!fromConfig && !fromOfficial && folders.length === 0) return () => false;
	return path => {
		if (fromConfig?.(path) || fromOfficial?.(path)) return true;
		return folders.some(f => isUnderExcludedFolder(path, f));
	};
}
