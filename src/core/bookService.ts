import { TFile, App } from "obsidian";
import type UNreaderPlugin from "../main";

/** 插件支持的书格式：EPUB（重排） + MOBI/AZW3（KF8，重排） + TXT（纯文本，切分后重排）。
 *  PDF 已整体移除——Obsidian 核心内置 PDF 查看器且占用了 `pdf` 扩展名，
 *  插件无法在文件浏览器里成为默认打开方式，为它自建渲染通道属重复建设。 */
const BOOK_EXTS = new Set(["epub", "mobi", "azw3", "txt"]);

/** 按扩展名给出 MIME（foliate-js 的 makeBook 实际用 magic 字节识别，
 *  这里设的值仅作兜底——某些环境拿不到 magic 字节时仍可走扩展名路径）。
 *  TXT 不经过 makeBook：engineAdapter 按扩展名直接走 `makeTxtBook`（见 txtBook.ts）。 */
const BOOK_MIME: Record<string, string> = {
	epub: "application/epub+zip",
	mobi: "application/x-mobipocket-ebook",
	azw3: "application/x-mobipocket-ebook",
	txt: "text/plain",
};

/** 插件自己写在库根的诊断产物（见 core/debugReport.ts 与 ui/explorerDiag.ts）。
 *  它们也是 .txt，但显然不是书——不加白名单会把「保存到库」生成的日志混进打开列表。 */
const DIAG_TXT = /^unreader-(?:debug-log|neighbor)-/;

/** 库内全部书籍（含子文件夹）——**不按文件夹过滤**。
 *
 *  理由：读书的硬条件从来只是「文件是库内 vault 文件」（registerExtensions 把
 *  三个扩展名绑到阅读视图，库里任何位置双击都由本插件打开）。列表再按「书籍
 *  文件夹」过滤，只会制造「我的书明明在库里，插件却说没找到」这一类困惑 ——
 *  而那个文件夹路径用户根本无从得知（设置页那一栏已撤下，见 core/paths.ts）。
 *  Books/ 仍作为建目录时的落点与空态提示里的建议位置，但不再参与筛选。
 *
 *  两条附加过滤（**都不是**位置过滤）：① 跳过 0 字节文件（空 txt 打开必然报错）；
 *  ② 跳过插件自己写在库根的诊断 .txt（`unreader-debug-log-*` / `unreader-neighbor-*`，
 *  它们扩展名同为 .txt，不加白名单会被当成书混进列表）。 */
export function getBookFiles(plugin: UNreaderPlugin): TFile[] {
	return plugin.app.vault
		.getFiles()
		.filter(f => BOOK_EXTS.has(f.extension.toLowerCase()))
		.filter(f => f.stat.size > 0)
		.filter(f => !(f.extension.toLowerCase() === "txt" && DIAG_TXT.test(f.basename)))
		.sort((a, b) => a.basename.localeCompare(b.basename));
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
		const oldest = bookFileCache.keys().next().value as string | undefined;
		if (!oldest || oldest === file.path) break;
		bookFileCache.delete(oldest);
	}
	return f;
}
