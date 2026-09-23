import { TFile, App, normalizePath } from "obsidian";
import type UNreaderPlugin from "../main";
import type { BookshelfEntry, BookshelfSortMode } from "../types";
import { createBookPathExcluder } from "./bookExclusions";
import { isHtmlExt } from "./htmlBook";

/** 插件支持的书格式：EPUB（重排） + MOBI/AZW3（KF8，重排） + TXT（纯文本，切分后重排）
 *  + HTML/HTM（本地网页，净化后切分重排，见 core/htmlBook.ts）。
 *  PDF 已整体移除——Obsidian 核心内置 PDF 查看器且占用了 `pdf` 扩展名，
 *  插件无法在文件浏览器里成为默认打开方式，为它自建渲染通道属重复建设。 */
const BOOK_EXTS = new Set(["epub", "mobi", "azw3", "txt", "html", "htm"]);

/** 书籍管理界面展示的格式白名单（按用户可读顺序书写）：设置页文案与空态提示都读它。
 *  **这是唯一事实来源**，`BOOK_EXTS` 只是它在扫描时的形态 —— 加格式时改这里 +
 *  `BOOK_MIME` + `main.ts` 的 `registerExtensions` 三处，不要只改一处。 */
export const SUPPORTED_BOOK_FORMATS = ["EPUB", "AZW3", "MOBI", "TXT", "HTML"] as const;

/** 该扩展名（不含点，大小写不限）是不是插件支持的书。 */
export function isSupportedBookExt(ext: string): boolean {
	return BOOK_EXTS.has(ext.toLowerCase());
}

/** 按扩展名给出 MIME（foliate-js 的 makeBook 实际用 magic 字节识别，
 *  这里设的值仅作兜底——某些环境拿不到 magic 字节时仍可走扩展名路径）。
 *  TXT 不经过 makeBook：engineAdapter 按扩展名直接走 `makeTxtBook`（见 txtBook.ts）。
 *  HTML 也不经过它：readerView 在建 target 时走 `makeHtmlBook`（见 core/htmlBook.ts）。 */
const BOOK_MIME: Record<string, string> = {
	epub: "application/epub+zip",
	mobi: "application/x-mobipocket-ebook",
	azw3: "application/x-mobipocket-ebook",
	txt: "text/plain",
	html: "text/html",
	htm: "text/html",
};

/** 这本书是不是本地 HTML（阅读器侧需要按它分流：合成 book 的构造、外链行为）。 */
export function isHtmlBookFile(file: TFile | null | undefined): boolean {
	return !!file && isHtmlExt(file.extension);
}

/**
 * 造一个「相对路径 → vault 资源 URL」的解析器，供 `makeHtmlBook` 注入
 * （见 core/htmlBook.ts 文件头：srcdoc 没有 base URL，资源必须在合成阶段烧进 HTML）。
 *
 * 解析顺序：与源文件同目录的相对路径 → 库根相对路径 → Obsidian 的链接解析兜底。
 * 全部失败返回 null，调用方会把该资源摘掉（裂图不如不显示）。
 *
 * 只读不写；越界路径由 `normalizePath` + `getAbstractFileByPath` 收敛在库内
 * （库外路径拿不到 TFile，天然拒绝）。
 */
export function createVaultResourceResolver(app: App, sourcePath: string): (raw: string) => string | null {
	const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
	return raw => {
		let rel = (raw.split("#")[0] ?? "").split("?")[0]!.trim();
		if (!rel) return null;
		// 绝对 URL / 协议链接不归这一层（调用方已先放行 http(s)/data/blob）
		if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith("//")) return null;
		try { rel = decodeURIComponent(rel); } catch { /* 保留原样（非法百分号转义） */ }
		const candidates: string[] = [];
		if (rel.startsWith("/")) candidates.push(rel.slice(1));
		else {
			if (dir) candidates.push(`${dir}/${rel}`);
			candidates.push(rel);
		}
		for (const candidate of candidates) {
			const normalized = normalizePath(candidate);
			const file = app.vault.getAbstractFileByPath(normalized);
			if (file instanceof TFile) return app.vault.getResourcePath(file);
		}
		// 兜底：官方链接解析（能处理「同名文件在别处」这类库内引用）
		const dest = app.metadataCache.getFirstLinkpathDest(rel, sourcePath);
		return dest instanceof TFile ? app.vault.getResourcePath(dest) : null;
	};
}

/** 插件自己写在库根的诊断产物（见 core/debugReport.ts 与 ui/explorerDiag.ts）。
 *  它们也是 .txt，但显然不是书——不加白名单会把「保存到库」生成的日志混进打开列表。 */
const DIAG_TXT = /^unreader-(?:debug-log|neighbor)-/;

/** 书籍路径集合；手动移除 / 分类只针对真实存在的书。 */
function hiddenBookPaths(plugin: UNreaderPlugin): Set<string> {
	return new Set(plugin.settings.bookshelfHiddenBooks ?? []);
}

/** 打开书籍列表可读取的书：**全库扫描**，按书名排序。
 *
 *  书籍不限位置（「资料文件夹」是插件**数据**的落点，不是书的落点，见 core/paths.ts）；
 *  跳过 0 字节文件、插件自己写在库根的诊断 .txt、**被排除文件夹命中的书**以及
 *  **用户手动从书架移除的书**（后者可在书架的“已移除书籍”里添加回来）。
 */
export function getBookFiles(plugin: UNreaderPlugin): TFile[] {
	const hidden = hiddenBookPaths(plugin);
	return collectBookFiles(plugin, true).filter(file => !hidden.has(file.path));
}

/** 书架使用全库扫描（同样应用排除与手动移除），并保留 Vault 返回的顺序作为默认排名。 */
export function getLibraryBookFiles(plugin: UNreaderPlugin): TFile[] {
	const hidden = hiddenBookPaths(plugin);
	return collectBookFiles(plugin, false).filter(file => !hidden.has(file.path));
}

/** “已移除书籍”管理列表：只列真实存在、被手动隐藏的书，不包含排除文件夹的常规过滤结果。 */
export function getRemovedBookFiles(plugin: UNreaderPlugin): TFile[] {
	const hidden = hiddenBookPaths(plugin);
	return collectBookFiles(plugin, true)
		.filter(file => hidden.has(file.path));
}

/** 轻量书架数据：只读文件索引与进度缓存，不在这里读封面或解析正文。 */
export function getBookshelfEntries(plugin: UNreaderPlugin): BookshelfEntry[] {
	const pinned = new Set(plugin.settings.bookshelfPinned ?? []);
	const categories = plugin.settings.bookshelfCategories ?? [];
	const categoryIds = new Set(categories.map(category => category.id));
	const assignments = plugin.settings.bookshelfCategoryAssignments ?? {};
	return getLibraryBookFiles(plugin).map(file => {
		const pos = plugin.getPosition(file.path);
		const progress = typeof pos?.fraction === "number" && Number.isFinite(pos.fraction)
			? Math.max(0, Math.min(1, pos.fraction))
			: 0;
		const assigned = assignments[file.path];
		return {
			path: file.path,
			name: file.basename,
			extension: file.extension.toLowerCase(),
			progress,
			updatedAt: typeof pos?.updatedAt === "number" && Number.isFinite(pos.updatedAt) ? pos.updatedAt : 0,
			pinned: pinned.has(file.path),
			categoryId: assigned && categoryIds.has(assigned) ? assigned : null,
		};
	});
}

/** 已移除书籍的轻量数据；分类字段照常保留，方便添加回来后立刻显示正确归属。 */
export function getRemovedBookshelfEntries(plugin: UNreaderPlugin): BookshelfEntry[] {
	const pinned = new Set(plugin.settings.bookshelfPinned ?? []);
	const categories = plugin.settings.bookshelfCategories ?? [];
	const categoryIds = new Set(categories.map(category => category.id));
	const assignments = plugin.settings.bookshelfCategoryAssignments ?? {};
	return getRemovedBookFiles(plugin).map(file => {
		const pos = plugin.getPosition(file.path);
		const progress = typeof pos?.fraction === "number" && Number.isFinite(pos.fraction)
			? Math.max(0, Math.min(1, pos.fraction))
			: 0;
		const assigned = assignments[file.path];
		return {
			path: file.path,
			name: file.basename,
			extension: file.extension.toLowerCase(),
			progress,
			updatedAt: typeof pos?.updatedAt === "number" && Number.isFinite(pos.updatedAt) ? pos.updatedAt : 0,
			pinned: pinned.has(file.path),
			categoryId: assigned && categoryIds.has(assigned) ? assigned : null,
		};
	});
}

/** 书架排序：置顶书籍始终在前；非手动模式保持扫描顺序作为稳定同分后缀。 */
export function sortBookshelfEntries(
	entries: BookshelfEntry[],
	mode: BookshelfSortMode,
	manualOrder: readonly string[],
): BookshelfEntry[] {
	const indexed = entries.map((entry, index) => ({ entry, index }));
	const manualRank = new Map<string, number>();
	for (let i = 0; i < manualOrder.length; i++) manualRank.set(manualOrder[i]!, i);
	if (mode === "recent") {
		indexed.sort((a, b) => (b.entry.updatedAt - a.entry.updatedAt) || (a.index - b.index));
	} else if (mode === "manual") {
		indexed.sort((a, b) => {
			const ar = manualRank.get(a.entry.path);
			const br = manualRank.get(b.entry.path);
			if (ar == null && br == null) return a.index - b.index;
			if (ar == null) return 1;
			if (br == null) return -1;
			return (ar - br) || (a.index - b.index);
		});
	}
	const ordered = indexed.map(x => x.entry);
	return [
		...ordered.filter(entry => entry.pinned),
		...ordered.filter(entry => !entry.pinned),
	];
}

function collectBookFiles(plugin: UNreaderPlugin, alphabetical: boolean): TFile[] {
	// 排除文件夹（默认跟随 Obsidian 的「排除文件」，见 core/bookExclusions.ts）：
	// 判定只在这一层生效 —— 被排除的书照常能打开，进度 / 标注 / 置顶一个字不动。
	const excluded = createBookPathExcluder(plugin.app, {
		followObsidian: plugin.settings.bookshelfFollowObsidianExclusions !== false,
		folders: plugin.settings.bookshelfExcludedFolders ?? [],
	});
	const files = plugin.app.vault
		.getFiles()
		.filter(f => BOOK_EXTS.has(f.extension.toLowerCase()))
		.filter(f => f.stat.size > 0)
		.filter(f => !(f.extension.toLowerCase() === "txt" && DIAG_TXT.test(f.basename)))
		.filter(f => !excluded(f.path));
	if (alphabetical) files.sort((a, b) => a.basename.localeCompare(b.basename));
	return files;
}

/** EPUB 文件缓存：重开同一本书跳过整包重读（移动端读几 MB 压缩包要 1-2s）。
 *  以 path+mtime+size 判定有效性，LRU 上限 2 本防移动端内存压力。 */
const bookFileCache = new Map<string, { mtime: number; size: number; file: File }>()

export async function readBookFile(app: App, file: TFile): Promise<File> {
	const c = bookFileCache.get(file.path);
	if (c && c.mtime === file.stat.mtime && c.size === file.stat.size) return c.file;
	const buf = await app.vault.readBinary(file);
	const ext = file.extension.toLowerCase();
	const mime = BOOK_MIME[ext] ?? "application/octet-stream";
	const f = new File([buf], file.name, { type: mime });
	bookFileCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, file: f });
	while (bookFileCache.size > 2) {
		const next = bookFileCache.keys().next();
		if (next.done) break;
		const oldest = next.value;
		if (oldest === file.path) break;
		bookFileCache.delete(oldest);
	}
	return f;
}
