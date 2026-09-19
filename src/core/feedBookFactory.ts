import type { FeedEntry, FeedSubscription } from "../types";

export interface FeedBook {
	readonly __unreaderTxt: true
	readonly __unreaderFeed: true
	metadata: { title: string; author: string; language: string }
	toc: { label: string; href: string }[]
	sections: {
		id: number
		size: number
		load: () => string
		createDocument: () => Document
	}[]
	resolveHref: (href: string) => { index: number } | null
	splitTOCHref: (href: string) => [number, number]
	getTOCFragment: (doc: Document, id: string) => Element | null
	isExternal: (uri: string) => boolean
	destroy: () => void
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatDate(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(timestamp));
	} catch {
		return new Date(timestamp).toLocaleString();
	}
}

function articleHtml(entry: FeedEntry, feed: FeedSubscription | null): string {
	const title = escapeHtml(entry.title || "未命名文章");
	const source = escapeHtml(feed?.title || entry.feedId);
	const author = escapeHtml(entry.author || feed?.title || "");
	const published = escapeHtml(formatDate(entry.publishedAt));
	const body = entry.contentHtml.trim()
		? entry.contentHtml
		: `<p>${escapeHtml(entry.summary || "这篇文章没有可显示的正文。")}</p>`;
	const original = entry.url
		? `<footer class="ur-feed-source-link"><a href="${escapeHtml(entry.url)}" rel="noopener noreferrer">阅读原文</a></footer>`
		: "";
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${escapeHtml(entry.url || "")}"><style>` +
		`html,body{margin:0;padding:0;background:transparent}` +
		`.ur-feed-article{box-sizing:border-box;max-width:760px;margin:0 auto}` +
		`.ur-feed-header{margin:0 0 1.8em;padding:0 0 1.2em;border-bottom:1px solid color-mix(in srgb,currentColor 16%,transparent)}` +
		`.ur-feed-title{margin:0 0 .55em;font-size:1.65em;line-height:1.28;text-align:left}` +
		`.ur-feed-meta{display:flex;flex-wrap:wrap;gap:.35em .85em;font-size:.82em;opacity:.68}` +
		`.ur-feed-content{line-height:inherit}` +
		`.ur-feed-content img,.ur-feed-content video{max-width:100%;height:auto;border-radius:6px}` +
		`.ur-feed-content pre{white-space:pre-wrap;overflow-wrap:anywhere}` +
		`.ur-feed-content table{display:block;max-width:100%;overflow:auto}` +
		`.ur-feed-content blockquote{margin:1em 0;padding:.2em 0 .2em 1em;border-left:3px solid color-mix(in srgb,currentColor 24%,transparent);opacity:.86}` +
		`.ur-feed-source-link{margin-top:2.2em;padding-top:1.1em;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);font-size:.86em}` +
		`</style></head><body><article class="ur-feed-article"><header class="ur-feed-header">` +
		`<h1 class="ur-feed-title">${title}</h1><div class="ur-feed-meta">` +
		(author ? `<span>${author}</span>` : "") + `<span>${source}</span>` +
		(published ? `<span>${published}</span>` : "") +
		`</div></header><div class="ur-feed-content">${body}</div>${original}</article></body></html>`;
}

/** 把一篇 Feed 文章包装成 foliate 可消费的单节合成书。 */
export function makeFeedBook(entry: FeedEntry, feed: FeedSubscription | null = null): FeedBook {
	const html = articleHtml(entry, feed);
	let url: string | null = null;
	const urlOf = (): string => {
		if (!url) url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
		return url;
	};
	return {
		__unreaderTxt: true,
		__unreaderFeed: true,
		metadata: {
			title: entry.title || "未命名文章",
			author: entry.author || feed?.title || "",
			language: /[㐀-鿿]/.test(entry.contentHtml || entry.summary || entry.title) ? "zh" : "en",
		},
		toc: [],
		sections: [{
			id: 0,
			size: Math.max(1, (entry.contentHtml || entry.summary || entry.title).length),
			load: urlOf,
			createDocument: () => new DOMParser().parseFromString(html, "text/html"),
		}],
		resolveHref: href => {
			const base = href.split("#")[0] ?? "";
			return base === "" || base === "0" ? { index: 0 } : null;
		},
		splitTOCHref: href => {
			const [section, fragment] = href.split("#");
			return [Number(section || 0), fragment == null ? 0 : Number(fragment)];
		},
		getTOCFragment: (doc, id) => doc.getElementById(String(id)),
		isExternal: uri => /^https?:/i.test(uri),
		destroy: () => {
			if (!url) return;
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
			url = null;
		},
	};
}

