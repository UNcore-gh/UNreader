import { App, TFile } from "obsidian";
import { decodeTxt, titleFromFileName } from "./txtBook";
import { htmlPreview, isHtmlExt } from "./htmlBook";

/** 书架卡片按需加载的预览数据；无封面时 excerpt 必须能独立撑起左侧封面位。 */
export interface BookPreview {
	coverUrl: string | null;
	excerpt: string | null;
	title: string | null;
	author: string | null;
}

interface FoliatePreviewBook {
	metadata?: Record<string, unknown>;
	getCover?: () => Promise<Blob | null>;
	sections?: Array<{
		createDocument?: () => Document | Promise<Document>;
	}>;
	destroy?: () => void;
}

interface PreviewCacheEntry {
	key: string;
	preview: BookPreview;
}

const PREVIEW_CONCURRENCY = 2;
const PREVIEW_CACHE_LIMIT = 48;
const TXT_EXCERPT_CHARS = 160;
const EXCERPT_SCAN_SECTIONS = 4;

const previewCache = new Map<string, PreviewCacheEntry>();
const previewPending = new Map<string, Promise<BookPreview>>();
const previewQueue: Array<() => void> = [];
let previewActive = 0;

function cacheKey(file: TFile): string {
	return `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}`;
}

function releasePreview(preview: BookPreview): void {
	if (!preview.coverUrl) return;
	try { URL.revokeObjectURL(preview.coverUrl); } catch { /* ignore */ }
}

function evictPreviewCache(): void {
	while (previewCache.size > PREVIEW_CACHE_LIMIT) {
		const next = previewCache.keys().next();
		if (next.done) return;
		const oldest = next.value;
		const entry = previewCache.get(oldest);
		if (entry) releasePreview(entry.preview);
		previewCache.delete(oldest);
	}
}

function withPreviewSlot<T>(task: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const run = (): void => {
			previewActive++;
			void task().then(resolve, reject).finally(() => {
				previewActive--;
				const next = previewQueue.shift();
				if (next) next();
			});
		};
		if (previewActive < PREVIEW_CONCURRENCY) run();
		else previewQueue.push(run);
	});
}

function localizeValue(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(localizeValue).filter(Boolean).join(", ");
	if (typeof value === "object") {
		return Object.values(value as Record<string, unknown>)
			.map(v => typeof v === "string" ? v : "")
			.filter(Boolean)
			.join(", ")
			.trim();
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value).trim();
	}
	return "";
}

function normalizeLine(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstTextLine(doc: Document): string | null {
	const root = doc.body ?? doc.documentElement;
	if (!root) return null;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const text = normalizeLine(node.nodeValue);
			if (!text) return NodeFilter.FILTER_REJECT;
			const parent = node.parentElement;
			if (parent?.closest("script, style, noscript, svg")) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let node = walker.nextNode();
	while (node) {
		const line = normalizeLine(node.nodeValue);
		if (line) return line.slice(0, TXT_EXCERPT_CHARS);
		node = walker.nextNode();
	}
	return null;
}

async function firstExcerpt(book: FoliatePreviewBook): Promise<string | null> {
	const sections = book.sections ?? [];
	for (let i = 0; i < Math.min(sections.length, EXCERPT_SCAN_SECTIONS); i++) {
		const createDocument = sections[i]?.createDocument;
		if (typeof createDocument !== "function") continue;
		try {
			const doc = await createDocument();
			const line = firstTextLine(doc);
			if (line) return line;
		} catch {
			// 单章解析失败不应拖垮整张卡片；继续看下一章。
		}
	}
	return null;
}

function firstTxtExcerpt(text: string): string | null {
	for (const raw of text.split("\n", 80)) {
		const line = normalizeLine(raw);
		if (line) return line.slice(0, TXT_EXCERPT_CHARS);
	}
	return null;
}

async function buildPreview(app: App, file: TFile): Promise<BookPreview> {
	const buffer = await app.vault.readBinary(file);
	const ext = file.extension.toLowerCase();
	if (ext === "txt") {
		const { text } = decodeTxt(buffer);
		const fallback = titleFromFileName(file.name || "未命名");
		return {
			coverUrl: null,
			excerpt: firstTxtExcerpt(text),
			title: fallback.title || null,
			author: fallback.author || null,
		};
	}
	// 本地 HTML：与 TXT 同路 —— 不建合成书（卡片只要标题 + 一行摘要），
	// 由 htmlBook 的轻量预览通道解析（同一套净化，见其文件头）。
	if (isHtmlExt(ext)) {
		const preview = htmlPreview(buffer, file.name || "未命名");
		return {
			coverUrl: null,
			excerpt: preview.excerpt,
			title: preview.title || null,
			author: preview.author || null,
		};
	}

	const blob = new File([buffer], file.name, { type: "application/octet-stream" });
	const viewModule = await import("../../vendor/foliate-js/view.js") as unknown as {
		makeBook?: (input: File) => Promise<FoliatePreviewBook>;
	};
	if (typeof viewModule.makeBook !== "function") throw new Error("foliate makeBook unavailable");
	const book = await viewModule.makeBook(blob);
	try {
		const meta = book.metadata ?? {};
		const title = localizeValue(meta.title) || null;
		const author = localizeValue(meta.author) || null;
		let coverUrl: string | null = null;
		if (typeof book.getCover === "function") {
			try {
				const cover = await book.getCover();
				if (cover && cover.size > 0) coverUrl = URL.createObjectURL(cover);
			} catch {
				// 没有封面或封面损坏时，走正文首行兜底。
			}
		}
		return {
			coverUrl,
			excerpt: coverUrl ? null : await firstExcerpt(book),
			title,
			author,
		};
	} finally {
		try { book.destroy?.(); } catch { /* ignore */ }
	}
}

/** 读取一本尚未缓存的书。仅取封面与正文首行，不整本渲染，也不常驻书籍对象。 */
export function loadBookPreview(app: App, file: TFile): Promise<BookPreview> {
	const key = cacheKey(file);
	const cached = previewCache.get(key);
	if (cached) {
		previewCache.delete(key);
		previewCache.set(key, cached);
		return Promise.resolve(cached.preview);
	}
	const pending = previewPending.get(key);
	if (pending) return pending;
	const task = withPreviewSlot(async (): Promise<BookPreview> => {
		try {
			const preview = await buildPreview(app, file);
			previewCache.set(key, { key, preview });
			evictPreviewCache();
			return preview;
		} catch {
			const preview: BookPreview = { coverUrl: null, excerpt: null, title: null, author: null };
			previewCache.set(key, { key, preview });
			evictPreviewCache();
			return preview;
		}
	});
	previewPending.set(key, task);
	return task.finally(() => previewPending.delete(key));
}

export function clearBookPreviewCache(): void {
	for (const entry of previewCache.values()) releasePreview(entry.preview);
	previewCache.clear();
	previewPending.clear();
}
