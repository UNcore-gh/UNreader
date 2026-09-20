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
	// 文末的「在默认浏览器打开原文」：用户 2026-09-20 要求「文章最下面也加一个跳转
	// 默认浏览器的按钮」。入口从正文里挂回来是**有意的反转** —— 当初撤掉它是因为
	// 「srcdoc 里的链接只能靠事件拦截才不导航」，而那条拦截现在是引擎层唯一的收口
	// （engineAdapter 的 frame 点击链路 + foliate `external-link`），正文里再放一个
	// `<a href>` 与功能轨那枚按钮走的是**同一条**外链通道，没有额外的链路成本。
	// 挂 `<a>`（不是 `<button>`）：四种阅读源与 foliate 自己的链接处理都认它。
	// 没有原文地址（纯本地内容）时整块不渲染，不留空壳。
	const original = entry.url
		? `<footer class="ur-feed-original"><a class="ur-feed-original-link" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">在默认浏览器打开原文</a></footer>`
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
		// 文末「在默认浏览器打开原文」：样式跟着正文（继承 currentColor/行高），
		// 不引任何外部资源，深浅色主题都不用另外覆盖。
		`.ur-feed-original{margin:2.4em 0 0;padding:1.1em 0 0;border-top:1px solid color-mix(in srgb,currentColor 16%,transparent)}` +
		`.ur-feed-original-link{display:inline-block;padding:.5em 1em;border:1px solid color-mix(in srgb,currentColor 26%,transparent);border-radius:999px;font-size:.88em;line-height:1.4;text-decoration:none;opacity:.85}` +
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
