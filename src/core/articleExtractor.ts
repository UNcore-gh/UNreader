import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import { normalizeHttpUrl, stableHash, stripHtml } from "./feedUtils";

export interface ExtractedArticle {
	title: string
	byline: string
	html: string
	hash: string
	text: string
}

const ALLOWED_TAGS = [
	"article", "section", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6",
	"ul", "ol", "li", "blockquote", "pre", "code", "hr", "br", "figure", "figcaption",
	"img", "picture", "source", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
	"strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "span",
	"a", "audio", "video", "details", "summary",
];

const ALLOWED_ATTR = [
	"href", "src", "srcset", "sizes", "alt", "title", "width", "height", "colspan", "rowspan",
	"datetime", "cite", "controls", "preload", "poster", "type", "loading", "decoding", "referrerpolicy",
];

function sanitizeSrcset(raw: string | null, baseUrl: string): string {
	if (!raw) return "";
	const candidates: string[] = [];
	for (const candidate of raw.split(",")) {
		const parts = candidate.trim().split(/\s+/);
		const url = normalizeHttpUrl(parts.shift(), baseUrl);
		if (url) candidates.push([url, ...parts].join(" "));
	}
	return candidates.join(", ");
}

export function sanitizeArticleHtml(raw: string, baseUrl: string, loadRemoteImages = true): string {
	const doc = new DOMParser().parseFromString(raw || "", "text/html");
	for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
		const href = anchor.getAttribute("href") ?? "";
		const resolved = normalizeHttpUrl(href, baseUrl) || (href.startsWith("#") ? href : "");
		if (resolved) anchor.setAttribute("href", resolved);
		else anchor.removeAttribute("href");
		anchor.setAttribute("rel", "noopener noreferrer");
	}
	for (const image of Array.from(doc.querySelectorAll<HTMLImageElement>("img"))) {
		const srcset = sanitizeSrcset(image.getAttribute("srcset"), baseUrl);
		const src = normalizeHttpUrl(image.getAttribute("src"), baseUrl) || srcset.split(",", 1)[0]?.split(/\s+/, 1)[0] || "";
		if (!src || (!loadRemoteImages && /^https?:/i.test(src))) {
			image.remove();
			continue;
		}
		image.setAttribute("src", src);
		if (srcset) image.setAttribute("srcset", srcset);
		else image.removeAttribute("srcset");
		image.setAttribute("loading", "lazy");
		image.setAttribute("decoding", "async");
		image.setAttribute("referrerpolicy", "no-referrer");
	}
	for (const source of Array.from(doc.querySelectorAll<HTMLSourceElement>("source[src], source[srcset]"))) {
		const src = normalizeHttpUrl(source.getAttribute("src"), baseUrl);
		const srcset = sanitizeSrcset(source.getAttribute("srcset"), baseUrl);
		if (!loadRemoteImages || (!src && !srcset)) {
			source.remove();
			continue;
		}
		if (src) source.setAttribute("src", src);
		else source.removeAttribute("src");
		if (srcset) source.setAttribute("srcset", srcset);
		else source.removeAttribute("srcset");
	}
	for (const media of Array.from(doc.querySelectorAll<HTMLMediaElement>("audio[src], video[src]"))) {
		const src = normalizeHttpUrl(media.getAttribute("src"), baseUrl);
		if (src) media.setAttribute("src", src);
		else media.removeAttribute("src");
		media.setAttribute("preload", "none");
	}
	for (const video of Array.from(doc.querySelectorAll<HTMLVideoElement>("video[poster]"))) {
		const poster = normalizeHttpUrl(video.getAttribute("poster"), baseUrl);
		if (!poster || !loadRemoteImages) video.removeAttribute("poster");
		else video.setAttribute("poster", poster);
	}
	for (const element of Array.from(doc.querySelectorAll<HTMLElement>("[style], [onclick], [onerror], [onload], form, input, button, textarea, select, iframe, object, embed, script"))) {
		if (element.tagName === "SCRIPT" || element.tagName === "IFRAME" || element.tagName === "OBJECT" || element.tagName === "EMBED") {
			element.remove();
			continue;
		}
		element.removeAttribute("style");
		element.removeAttribute("onclick");
		element.removeAttribute("onerror");
		element.removeAttribute("onload");
		if (["FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(element.tagName)) element.remove();
	}
	const clean = DOMPurify.sanitize(doc.body.innerHTML, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	});
	return String(clean);
}

export function extractFulltext(pageHtml: string, url: string): ExtractedArticle {
	const doc = new DOMParser().parseFromString(pageHtml, "text/html");
	const base = doc.createElement("base");
	base.href = url;
	doc.head.appendChild(base);
	const parsed = new Readability(doc, { charThreshold: 120 }).parse();
	const html = sanitizeArticleHtml(parsed?.content ?? "", url);
	if (!html.trim()) throw new Error("网页没有可提取的正文");
	const text = stripHtml(html);
	return {
		title: parsed?.title?.trim() || "",
		byline: parsed?.byline?.trim() || "",
		html,
		hash: stableHash(html),
		text,
	};
}
