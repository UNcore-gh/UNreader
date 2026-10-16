/** 文件隔离墙 —— 插件只允许「检索到」和「打开」自己真正适配过的格式。
 *
 *  ## 为什么需要这一层（2026-10-13 用户报障）
 *
 *  本插件适配的格式只有三类：电子书（EPUB / MOBI / AZW3 / TXT / 本地 HTML）、
 *  RSS 订阅文章、以及**寄生在官方阅读视图上的 Markdown 笔记**。
 *  但「Markdown 笔记」不等于「扩展名是 md 的文件」——不少插件拿 `.md` 当**自己的
 *  数据容器**：Excalidraw 默认把绘图存成 `*.excalidraw.md`（兼容模式干脆就是
 *  `*.md`），文件里的内容是一段绘图 JSON，不是给人读的 markdown。
 *
 *  旧实现把「扩展名 md」这**一个**判据散写在六处（笔记索引 / 笔记卡列表 / 字数统计 /
 *  阅读计时 / md 叠加层挂载 / 打开笔记），于是绘图文件一路漏进插件的「笔记」视图，
 *  点开还会被强塞进官方 markdown 视图 —— 用户看到的就是「插件打开了它没适配的格式，
 *  然后崩了」。
 *
 *  ## 口径：白名单 + 已知数据文件的显式黑名单，不做「猜」
 *
 *  · 不是 `.md` → 不是笔记（`isMarkdownNoteFile` 的第一道门，与旧行为一致）；
 *  · 文件名以 `.excalidraw` 结尾（`画.excalidraw.md`）→ 是绘图数据，不是笔记；
 *  · frontmatter 带 `excalidraw-plugin` 键 → 是绘图数据（兼容模式下文件名只以 `.md`
 *    结尾，后缀判据失效，但 Excalidraw 无论哪种模式都会写这个标记位）。
 *
 *  判据失败时**一律当作「不是笔记」**（保守方向 = 插件少管一个文件），绝不放行：
 *  放行的代价是把别人的数据文件当笔记读写，那是不可逆的内容事故。
 *
 *  ⚠️ 以后再遇到「别的插件也用 .md 存数据」，往 `DATA_MARKDOWN_SUFFIXES` /
 *  `DATA_MARKDOWN_FRONTMATTER_KEYS` 各加一条即可 —— **不要在调用点各写一份判据**，
 *  散落的判据正是这次漏进来的原因。新增格式前先读本文件与 `bookService` 的
 *  `READER_BOOK_EXT_ORDER`（阅读视图那半边的事实来源）。
 */

import { App, TFile } from "obsidian";
import type { MarkdownNoteRecentEntry } from "../types";

/** 已知「伪 markdown」的后缀：命中即视为别的插件的数据文件。
 *  比较对象是**不含扩展名的 basename**（`画.excalidraw.md` → `画.excalidraw`）。 */
const DATA_MARKDOWN_SUFFIXES = [".excalidraw"];

/** 已知「伪 markdown」的 frontmatter 标记位（键名 = 插件的所有权声明）。
 *  Excalidraw 关掉「`.excalidraw.md` 扩展名」开关后文件名只以 `.md` 结尾，后缀判据
 *  失效 —— 但正文首段 frontmatter 里始终有 `excalidraw-plugin: parsed`。 */
const DATA_MARKDOWN_FRONTMATTER_KEYS = ["excalidraw-plugin"];

/** 扩展名是不是 markdown（大小写不限）。写成类型谓词，调用点顺带完成收窄。 */
function isMarkdownExt(file: TFile | null | undefined): file is TFile {
	return !!file && typeof file.extension === "string" && file.extension.toLowerCase() === "md";
}

/** basename 是否命中「伪 markdown」后缀（大小写不限）。 */
export function isDataMarkdownBasename(basename: string | null | undefined): boolean {
	const lower = String(basename ?? "").trim().toLowerCase();
	if (!lower) return false;
	return DATA_MARKDOWN_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/** 读官方索引里的 frontmatter（拿不到 / 抛错一律返回 null = 「没有证据」）。 */
function frontmatterOf(app: App | null | undefined, file: TFile): Record<string, unknown> | null {
	try {
		const frontmatter = (app?.metadataCache?.getFileCache?.(file) as { frontmatter?: unknown } | null | undefined)
			?.frontmatter;
		return frontmatter && typeof frontmatter === "object" ? frontmatter as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/** frontmatter 是否带「这是别的插件的数据文件」标记位。 */
export function frontmatterMarksDataFile(frontmatter: Record<string, unknown> | null | undefined): boolean {
	if (!frontmatter) return false;
	return DATA_MARKDOWN_FRONTMATTER_KEYS.some(key => key in frontmatter);
}

/** 是不是「别的插件拿 .md 当数据容器」的文件（Excalidraw 绘图等）。 */
export function isMarkdownDataFile(app: App | null | undefined, file: TFile | null | undefined): boolean {
	if (!isMarkdownExt(file)) return false;
	if (isDataMarkdownBasename(file.basename)) return true;
	return frontmatterMarksDataFile(frontmatterOf(app, file));
}

/**
 * 插件允许「检索 / 索引 / 打开」的 Markdown 笔记。
 *
 * 这是**唯一判据**：笔记索引（最近阅读 / 星标）、笔记卡列表、字数统计、阅读计时、
 * md 叠加层挂载、`openMarkdownNote` 路由，全部走它。`file` 不是 `TFile`、不是 `.md`、
 * 或命中数据文件黑名单时一律返回 false。
 */
export function isMarkdownNoteFile(app: App | null | undefined, file: TFile | null | undefined): boolean {
	if (!(file instanceof TFile) || !isMarkdownExt(file)) return false;
	return !isMarkdownDataFile(app, file);
}

/** 阅读视图能打开的格式（六种电子书 / 网页）。转出 `bookService` 的口径，
 *  这里只做转发，方便调用点从同一个模块取两类判据。 */
export { isReaderBookFile } from "./bookService";

/** 笔记索引（最近阅读 + 星标）的清洗结果。 */
export interface NoteIndexPruneResult {
	recent: MarkdownNoteRecentEntry[]
	starred: Record<string, number>
	/** 被剔除的条目数（0 = 索引本来干净，调用方不必写盘、不必重绘）。 */
	removed: number
}

/** 路径的**形态归一 key**：跨端同步后 `vault.getFileByPath` 可能失配 ——
 *  macOS（HFS+ 时代起）会有 NFD 形态的文件名、iOS/Android 侧多是 NFC，Windows /
 *  安卓某些形态还带大小写差异。**失配不等于文件不在**，所以解析要带一层归一化回退。 */
export function normalizeNotePathKey(path: string): string {
	return String(path ?? "").normalize("NFC").toLowerCase();
}

/** 笔记路径解析器：先精确命中，未命中再按归一化 key 在全库 md 里回退查一次。
 *
 *  **只服务「显示」与「判定」两件事**，不做任何写入 —— 命中归一化形态时返回的是**真实
 *  文件**（调用方用 `file.path` 当身份），这样跨端路径形态漂移也不会让卡片消失、更不会被
 *  误判成「文件已删除」。表是懒建的，一次渲染/一次清理最多扫一遍 `getMarkdownFiles()`。 */
export interface NoteFileResolver {
	resolve(path: string): TFile | null
}

export function createNoteFileResolver(app: App | null | undefined): NoteFileResolver {
	let byKey: Map<string, TFile> | null = null;
	return {
		resolve(path: string): TFile | null {
			const raw = String(path ?? "");
			if (!raw) return null;
			try {
				const exact = app?.vault?.getFileByPath?.(raw) ?? null;
				if (exact instanceof TFile) return exact;
			} catch { /* 取不到就继续走归一化回退 */ }
			if (!byKey) {
				byKey = new Map<string, TFile>();
				try {
					for (const file of app?.vault?.getMarkdownFiles?.() ?? []) {
						if (!(file instanceof TFile)) continue;
						const key = normalizeNotePathKey(file.path);
						if (!byKey.has(key)) byKey.set(key, file);
					}
				} catch { /* 拿不到文件清单 ⇒ 表为空，解析结果为 null（调用方按「看不见」处理） */ }
			}
			return byKey.get(normalizeNotePathKey(raw)) ?? null;
		},
	};
}

/** 一次性解析（渲染点用；同一批条目请复用 `createNoteFileResolver` 的实例，别每条建一张表）。 */
export function resolveNoteFile(app: App | null | undefined, path: string): TFile | null {
	return createNoteFileResolver(app).resolve(path);
}

/** 笔记索引的**运行时收口**（脏 `data.json` / 手改 / 老版本或他端写下的形态）。
 *
 *  ⚠️ **这里曾经把字段形态不符的条目整条丢掉**（`openedAt` 非有限正数 ⇒ `return null`）。
 *  那等于用「字段跟我们预期的不一样」判定「这篇笔记不存在」：升级到带这一层的版本那一刻，
 *  他端/旧版本写下的整份「最近阅读」会被静默清空（2026-10-14 报障：手机端显示
 *  「还没有最近阅读的笔记」，桌面端也只剩当时正在读的那一篇 —— 而同一台机器的阅读统计
 *  里明明有最近 24h 的 10 篇笔记）。时间戳只用于排序与「N 天前」文案，缺失/非法时归 0
 *  即可（渲染成「尚未阅读」、排到最后），没有任何理由因此删数据。
 *
 *  仍然会做的事：裁空白路径、按路径去重（保留首条）、按 `openedAt` 降序、截断到上限。 */
export function normalizeNoteIndex(
	recent: readonly MarkdownNoteRecentEntry[] | null | undefined,
	starred: Record<string, number> | null | undefined,
	limit: number,
): { recent: MarkdownNoteRecentEntry[]; starred: Record<string, number> } {
	const kept = new Map<string, MarkdownNoteRecentEntry>();
	for (const entry of asRecentList(recent)) {
		const path = typeof entry?.path === "string" ? entry.path.trim() : "";
		if (!path) continue;
		const openedAt = Number(entry?.openedAt);
		const safeOpenedAt = Number.isFinite(openedAt) && openedAt > 0 ? openedAt : 0;
		if (!kept.has(path)) kept.set(path, { path, openedAt: safeOpenedAt });
	}
	const nextRecent = [...kept.values()]
		.sort((a, b) => b.openedAt - a.openedAt)
		.slice(0, Math.max(0, limit));
	const nextStarred: Record<string, number> = {};
	for (const [path, starredAt] of Object.entries(asNumberMap(starred))) {
		const trimmed = path.trim();
		if (!trimmed) continue;
		const time = Number(starredAt);
		nextStarred[trimmed] = Number.isFinite(time) && time > 0 ? time : 0;
	}
	return { recent: nextRecent, starred: nextStarred };
}

/** 索引条目的**运行时**收口：`data.json` 被手改 / 同步冲突后可能是任意形态。
 *  写成显式断言而不是直接 `Array.isArray(...) ? recent : []` —— 那个写法会把
 *  `readonly T[]` 收窄成 `any[]`（tsc 的已知行为），整条链路的类型就丢了。 */
function asRecentList(value: unknown): MarkdownNoteRecentEntry[] {
	return Array.isArray(value) ? value as MarkdownNoteRecentEntry[] : [];
}

/** 同上，星标索引（路径 → 星标时间）的收口。 */
function asNumberMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, number>;
}

/**
 * 隔离墙对**已有索引**的清理：历史版本可能已经把绘图文件写进「最近阅读 / 星标」，
 * 光靠入口判据挡不住存量数据（用户会看到旧记录一直在笔记列表里）。
 *
 *  ⚠️ **只有「正面证据」才剔除，拿不到就当「不知道」**（2026-10-14 报障后重定的口径）：
 *   · 路径是空的 → 剔除（确定的脏数据）；
 *   · 文件**确实在库里**、但按判据它不是真笔记（Excalidraw 这类拿 `.md` 当数据容器）
 *     → 剔除（这就是隔离墙的正事，与库/索引就绪与否无关）；
 *   · **找不到文件 → 一律保留**。旧实现在这里把「解析不到」当成「文件已删除」，
 *     于是手机端启动期（插件 onload 后 500ms / metadataCache 首批事件，正是官方索引
 *     还没建好的窗口）或跨端同步的路径形态漂移，就能**一次把整份索引清空**，而且立刻
 *     写盘、随同步扩散到其他端 —— 用户看到的就是「笔记卡片全没了」。
 *     这些路径**不会**出现在列表里：渲染层（`getMarkdownNoteListItems`）本来就按同一份
 *     判据过滤；真正的删除 / 改名由 `vault.on("delete"|"rename")` 在事件发生时精确同步。
 *
 *  纯函数、不动 settings —— 写盘由调用方收口。
 */
export function pruneNoteIndex(
	app: App | null | undefined,
	recent: readonly MarkdownNoteRecentEntry[] | null | undefined,
	starred: Record<string, number> | null | undefined,
): NoteIndexPruneResult {
	const before = asRecentList(recent);
	const beforeStarred = asNumberMap(starred);
	const resolver = createNoteFileResolver(app);
	/** 是否剔除：空/空白路径（确定脏数据）或「文件在、但不是笔记」（正面证据）。 */
	const shouldDrop = (path: string): boolean => {
		if (!path || !path.trim()) return true;
		let file: TFile | null = null;
		try {
			file = resolver.resolve(path);
		} catch {
			file = null;
		}
		if (!file) return false;   // 看不见 ≠ 不在 ⇒ 保留
		try {
			return !isMarkdownNoteFile(app, file);
		} catch {
			return false;          // 判据自己抛了也不能当「该删」
		}
	};
	const nextRecent = before.filter(entry => !shouldDrop(entry?.path));
	const nextStarred: Record<string, number> = {};
	for (const [path, starredAt] of Object.entries(beforeStarred)) {
		if (!shouldDrop(path)) nextStarred[path] = starredAt;
	}
	return {
		recent: nextRecent,
		starred: nextStarred,
		removed: (before.length - nextRecent.length)
			+ (Object.keys(beforeStarred).length - Object.keys(nextStarred).length),
	};
}
