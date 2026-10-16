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

/** 播客时间戳格式：90 / 90s / 1m30s / 1h2m3s / mm:ss / hh:mm:ss。 */
function parseTimestampValue(raw: string | null | undefined): number | null {
	const value = (raw ?? "").trim();
	if (!value) return null;

	const secondsOnly = /^(\d+(?:\.\d+)?)s?$/i.exec(value);
	if (secondsOnly) {
		const seconds = Number(secondsOnly[1]);
		return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
	}

	const compact = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(value);
	if (compact && (compact[1] || compact[2] || compact[3])) {
		const hours = Number(compact[1] ?? 0);
		const minutes = Number(compact[2] ?? 0);
		const seconds = Number(compact[3] ?? 0);
		const total = hours * 3600 + minutes * 60 + seconds;
		return Number.isFinite(total) && total >= 0 ? total : null;
	}

	const parts = value.split(":").map(part => part.trim());
	if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return null;
	const numbers = parts.map(part => Number(part));
	if (numbers.some(number => !Number.isFinite(number) || number < 0)) return null;
	const total = numbers.length === 2
		? numbers[0]! * 60 + numbers[1]!
		: numbers[0]! * 3600 + numbers[1]! * 60 + numbers[2]!;
	return Number.isFinite(total) && total >= 0 ? total : null;
}

/** 判断链接文字本身是否是时间点，避免把普通站点的 `?start=...` 分页链接误当播客进度。 */
function isTimestampText(value: string): boolean {
	return /^\s*(?:\[\s*)?(?:(?:\d{1,3}):)?(?:\d{1,3}):\d{2}(?:\.\d+)?(?:\s*\])?\s*$/.test(value);
}

/** 从常见播客/视频站的时间链接里取秒数：`?t=90`、`&t=1m30s`、`#t=01:02:03`。 */
function safeDecode(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

function timestampFromHref(rawHref: string, baseUrl: string): number | null {
	try {
		const url = new URL(rawHref, baseUrl || "https://unreader.invalid/");
		const candidates: string[] = [];
		for (const key of ["t", "timestamp", "time", "at"]) {
			candidates.push(...url.searchParams.getAll(key));
		}
		const hash = safeDecode(url.hash.replace(/^#/, ""));
		if (/^t=/i.test(hash)) candidates.push(hash.slice(2));
		else if (hash) candidates.push(hash);
		for (const candidate of candidates) {
			const seconds = parseTimestampValue(candidate);
			if (seconds != null) return seconds;
		}
	} catch { /* 解析不了的链接不转换 */ }
	return null;
}

/** 把播客正文里的 12:34 / 01:02:03 变成内部时间点链接。
 *  同时处理站点生成的时间链接（`?t=90`、`#t=1m30s`）和裸文本时间；
 *  但不改代码块里的时间，也不碰普通外链。 */
function linkPodcastTimestamps(html: string, baseUrl = ""): string {
	try {
		const doc = new DOMParser().parseFromString(`<div id="ur-feed-timestamp-root">${html}</div>`, "text/html");
		const root = doc.getElementById("ur-feed-timestamp-root");
		if (!root) return html;

		// 先处理“网站已经包好的时间链接”。这类简介常写成 01:30 / 章节标题 指向
		// `?t=90`，如果保留原 href，阅读器只会把它当普通外链，无法接进播放器。
		//
		// **必须连没有 href 的 `<a class="timestamp">02:20</a>` 一起扫**：
		// 小宇宙等中文播客的 show notes 大量使用这种形态，只有文字、没有地址。
		// 旧实现只查 `a[href]`，随后裸文本扫描又把 `<a>` 内的文字全部跳过，
		// 于是这些看起来像时间戳的链接永远不会进入播放器。
		for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>("a"))) {
			if (anchor.closest("code, pre, script, style, audio, video")) continue;
			const href = anchor.getAttribute("href") ?? "";
			if (href.startsWith("#ur-audio-")) continue;
			const text = (anchor.textContent ?? "").trim();
			let seconds = href ? timestampFromHref(href, baseUrl) : null;
			if (seconds == null && isTimestampText(text)) seconds = parseTimestampValue(text);
			// `?start=` 的语义太泛，只有在链接文字本身就是时间点时才转换。
			if (seconds == null && href && isTimestampText(text)) {
				try {
					const url = new URL(href, baseUrl || "https://unreader.invalid/");
					for (const start of url.searchParams.getAll("start")) {
						seconds = parseTimestampValue(start);
						if (seconds != null) break;
					}
				} catch { /* ignore */ }
			}
			if (seconds == null || seconds < 0) continue;
			anchor.setAttribute("href", `#ur-audio-${seconds}`);
			anchor.classList.add("ur-feed-timestamp");
			anchor.removeAttribute("target");
			anchor.removeAttribute("rel");
		}

		// 再处理裸文本：12:34 / 01:02:03。代码块、链接内文字和媒体标签内不处理。
		const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				const parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				return parent.closest("a, code, pre, script, style, audio, video")
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT;
			},
		});
		const nodes: Text[] = [];
		while (walker.nextNode()) nodes.push(walker.currentNode as Text);
		for (const node of nodes) {
			const text = node.nodeValue ?? "";
			const re = /(\d{1,3}):(\d{2})(?::(\d{2}))?(?!\d)/g;
			let match: RegExpExecArray | null;
			let last = 0;
			let changed = false;
			// 用 Range 片段在解析出的独立文档里建节点，避免宿主 createEl 把节点带到错误 realm。
			const frag = doc.createRange().createContextualFragment("");
			while ((match = re.exec(text))) {
				const index = match.index;
				if (index > 0 && /\d/.test(text[index - 1] ?? "")) continue;
				const raw = match[0] ?? "";
				const seconds = parseTimestampValue(raw);
				if (seconds == null) continue;
				changed = true;
				frag.appendChild(doc.createTextNode(text.slice(last, index)));
				const link = doc.createRange().createContextualFragment("<a></a>").firstElementChild as HTMLAnchorElement;
				link.setAttribute("href", `#ur-audio-${seconds}`);
				link.className = "ur-feed-timestamp";
				link.textContent = raw;
				frag.appendChild(link);
				last = index + raw.length;
			}
			if (!changed) continue;
			frag.appendChild(doc.createTextNode(text.slice(last)));
			node.parentNode?.replaceChild(frag, node);
		}
		return root.innerHTML;
	} catch {
		return html;
	}
}

function articleHtml(entry: FeedEntry, feed: FeedSubscription | null): string {
	const title = escapeHtml(entry.title || "未命名文章");
	const source = escapeHtml(feed?.title || entry.feedId);
	const author = escapeHtml(entry.author || feed?.title || "");
	const published = escapeHtml(formatDate(entry.publishedAt));
	const rawBody = entry.contentHtml.trim()
		? entry.contentHtml
		: `<p>${escapeHtml(entry.summary || "这篇文章没有可显示的正文。")}</p>`;
	const body = entry.kind === "audio" ? linkPodcastTimestamps(rawBody, entry.url) : rawBody;
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
		`.ur-feed-timestamp{color:inherit;text-decoration:underline dotted;text-underline-offset:.18em;font-variant-numeric:tabular-nums;cursor:pointer}` +
		`.ur-feed-timestamp:hover{opacity:.72}` +
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
