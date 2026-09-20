/**
 * 把抓到的全文**另存为一篇 Obsidian 笔记**（Markdown + 图片落盘）。
 *
 * 落点全部交给 Obsidian 自己的规则，插件不另造一套：
 * - 笔记位置：`fileManager.getNewFileParent()`（= 用户「新建笔记的默认位置」设置）
 * - 图片位置：`fileManager.getAvailablePathForAttachment()`（= 用户「附件默认位置」设置，
 *   含"与当前文件同目录 / 指定子文件夹 / 根目录"等所有形态与重名避让）
 *
 * 重复保存同一篇文章时**覆盖原文件**（前提是那份笔记带我们的 `unreader` 标记，即确实是
 * 本功能生成的）—— 否则用户在正文里的批注会被无声冲掉，这时改为新建带序号的文件。
 */
import { App, TFile, normalizePath, requestUrl } from "obsidian";
import { htmlToMarkdown, safeNoteFileName } from "./htmlToMarkdown";

export interface ArticleNoteInput {
	title: string
	author?: string
	url?: string
	feedTitle?: string
	publishedAt?: number
	contentHtml: string
}

export interface ArticleNoteResult {
	path: string
	created: boolean
	imageCount: number
	failedImages: number
}

/** 用来识别「这篇笔记是本功能生成的」：只有它才允许被覆盖。 */
const NOTE_MARKER_KEY = "unreader";
const NOTE_MARKER_VALUE = "feed-article";

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"image/bmp": "bmp",
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp"]);

function yamlString(value: string): string {
	return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

function formatTimestamp(value: number | undefined): string {
	if (!Number.isFinite(value) || !value || value <= 0) return "";
	const date = new Date(value);
	const pad = (input: number): string => String(input).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 远程图片 → 附件文件名。取不到合法名字（纯目录、压缩包等）就返回空串，调用方保留原链接。 */
function attachmentNameFor(src: string, contentType = ""): string {
	let base = "";
	try {
		const url = new URL(src);
		base = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
	} catch {
		return "";
	}
	const cleaned = base.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
	if (!cleaned) return "";
	const dot = cleaned.lastIndexOf(".");
	const extension = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : "";
	const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
	if (!stem) return "";
	if (IMAGE_EXTENSIONS.has(extension)) return `${stem}.${extension}`;
	const fromType = EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0]?.trim().toLowerCase() ?? ""];
	return fromType ? `${stem}.${fromType}` : "";
}

function directoryOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

/** 同名附件已存在时直接复用，避免每次保存都在附件目录里堆一份重复图片。 */
async function attachmentTarget(app: App, fileName: string, notePath: string): Promise<string | null> {
	const candidate = await app.fileManager.getAvailablePathForAttachment(fileName, notePath);
	const directory = directoryOf(candidate);
	const preferred = normalizePath(directory ? `${directory}/${fileName}` : fileName);
	if (app.vault.getAbstractFileByPath(preferred)) return preferred;
	return candidate;
}

async function saveRemoteImage(app: App, src: string, notePath: string): Promise<string | null> {
	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({ url: src, throw: false });
	} catch {
		return null;
	}
	if (response.status !== 200 || !response.arrayBuffer || response.arrayBuffer.byteLength === 0) return null;
	const contentType = response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "";
	const fileName = attachmentNameFor(src, contentType);
	if (!fileName) return null;
	const target = await attachmentTarget(app, fileName, notePath);
	if (!target) return null;
	const existing = app.vault.getAbstractFileByPath(target);
	if (existing) return target;
	try {
		await app.vault.createBinary(target, response.arrayBuffer);
		return target;
	} catch {
		return null;
	}
}

function collectImageSources(html: string): string[] {
	const doc = new DOMParser().parseFromString(html || "", "text/html");
	const found = new Set<string>();
	for (const image of Array.from(doc.querySelectorAll("img[src]"))) {
		const src = image.getAttribute("src")?.trim() ?? "";
		if (/^https?:/i.test(src)) found.add(src);
	}
	return Array.from(found);
}

function isGeneratedNote(content: string): boolean {
	return new RegExp(`^${NOTE_MARKER_KEY}:\\s*${NOTE_MARKER_VALUE}\\s*$`, "m").test(content.split(/^---\s*$/m)[1] ?? "");
}

async function resolveNotePath(app: App, baseName: string): Promise<{ path: string; exists: TFile | null; created: boolean }> {
	const parent = app.fileManager.getNewFileParent("");
	const folder = parent?.path ?? "";
	const candidate = normalizePath(folder ? `${folder}/${baseName}.md` : `${baseName}.md`);
	const existing = app.vault.getAbstractFileByPath(candidate);
	// 目标路径空着：直接用。这一条必须在下面的循环之前 —— 否则「没有冲突」也会走到
	// 「另起序号」那一支，每存一次都换一个文件名（探针实测踩过）。
	if (!existing) return { path: candidate, exists: null, created: true };
	if (existing instanceof TFile) {
		const content = await app.vault.read(existing).catch(() => "");
		if (isGeneratedNote(content)) return { path: existing.path, exists: existing, created: false };
	}
	// 撞上用户自己的同名笔记（或者我们生成过一份后又手改过、或那里是个同名文件夹）：
	// 退让，另起一个带序号的名字 —— 覆盖用户的笔记是不可逆的，退让只会多一个文件。
	for (let index = 2; index < 100; index += 1) {
		const next = normalizePath(folder ? `${folder}/${baseName} ${index}.md` : `${baseName} ${index}.md`);
		if (!app.vault.getAbstractFileByPath(next)) return { path: next, exists: null, created: true };
	}
	return { path: candidate, exists: existing instanceof TFile ? existing : null, created: !(existing instanceof TFile) };
}

export async function saveArticleNote(app: App, input: ArticleNoteInput): Promise<ArticleNoteResult> {
	const baseName = safeNoteFileName(input.title);
	const { path, exists, created } = await resolveNotePath(app, baseName);

	let imageCount = 0;
	let failedImages = 0;
	const resolved = new Map<string, string>();
	for (const src of collectImageSources(input.contentHtml)) {
		const saved = await saveRemoteImage(app, src, path);
		if (saved) {
			resolved.set(src, saved);
			imageCount += 1;
		} else {
			failedImages += 1;
		}
	}

	const body = htmlToMarkdown(input.contentHtml, {
		imageResolver: src => resolved.get(src) ?? src,
	});
	const frontmatter = [
		"---",
		`${NOTE_MARKER_KEY}: ${NOTE_MARKER_VALUE}`,
		`title: ${yamlString(input.title)}`,
		input.author ? `author: ${yamlString(input.author)}` : "",
		input.url ? `source: ${yamlString(input.url)}` : "",
		input.feedTitle ? `feed: ${yamlString(input.feedTitle)}` : "",
		input.publishedAt ? `published: ${formatTimestamp(input.publishedAt)}` : "",
		`saved: ${formatTimestamp(Date.now())}`,
		"---",
	].filter(Boolean).join("\n");
	const payload = `${frontmatter}\n\n${input.url ? `> 原文：${input.url}\n\n` : ""}${body}\n`;

	if (exists) await app.vault.modify(exists, payload);
	else await app.vault.create(path, payload);
	return { path, created, imageCount, failedImages };
}
