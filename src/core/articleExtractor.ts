import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import { normalizeHttpUrl, stableHash, stripHtml } from "./feedUtils";

export interface ExtractedArticle {
	title: string
	byline: string
	html: string
	hash: string
	text: string
	/** 分页文章的"下一页"（仅认正文里的 `a[rel=next]` 且与当前页同文章的形态，见 findNextPageUrl） */
	nextPageUrl?: string
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

const LAZY_IMAGE_URL_ATTRS = [
	"data-src", "data-original", "data-lazy-src", "data-lazyload", "data-actualsrc", "data-url", "data-image",
];

const LAZY_IMAGE_SET_ATTRS = ["data-srcset", "data-lazy-srcset", "data-original-srcset"];

const ARTICLE_CANDIDATE_SELECTORS = [
	"article",
	"[itemprop~='articleBody']",
	"[role='main']",
	"main",
	".post-content",
	".article-content",
	".entry-content",
	".post-body",
	".article-body",
	".story-body",
	".content-body",
	"#article",
	"#content",
];

const ARTICLE_NOISE_SELECTOR = [
	"script", "style", "noscript", "template", "nav", "header", "footer", "aside", "form",
	"[role='navigation']", "[role='banner']", "[role='contentinfo']", "[aria-hidden='true']",
	".advertisement", ".advert", ".ads", ".ad", ".sponsor", ".newsletter", ".subscribe",
	".social-share", ".share-buttons", ".related-posts", ".comments", "#comments",
].join(",");

function firstString(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function primaryImageUrl(image: HTMLImageElement): string {
	const current = image.getAttribute("src")?.trim() ?? "";
	const currentLooksPlaceholder = !current
		|| current.startsWith("data:")
		|| current.startsWith("about:")
		|| /(?:^|[/_-])(?:blank|spacer|transparent|placeholder|loading)(?:[._/-]|$)/i.test(current)
		|| current === "[image omitted]";
	if (!currentLooksPlaceholder) return current;
	for (const attr of LAZY_IMAGE_URL_ATTRS) {
		const value = image.getAttribute(attr)?.trim();
		if (value && !value.startsWith("data:")) return value;
	}
	return current;
}

/** 把常见懒加载属性提升为标准 src/srcset，避免 Readability 和后续清洗丢掉正文图片。 */
function promoteLazyMedia(doc: Document): void {
	for (const noscript of Array.from(doc.querySelectorAll("noscript"))) {
		const markup = noscript.textContent?.trim() ?? "";
		if (!/<(?:img|picture|source)\b/i.test(markup)) continue;
		// 用 DOMParser 而不是 `template.innerHTML = markup`：后者是「把外部标记赋给 innerHTML」
		// 的典型写法，上架规则（no-unsanitized/property）会判为不安全注入。
		const parsed = new DOMParser().parseFromString(markup, "text/html");
		if (parsed.querySelector("img, picture, source")) noscript.replaceWith(...Array.from(parsed.body.childNodes));
	}
	for (const image of Array.from(doc.querySelectorAll<HTMLImageElement>("img"))) {
		const src = primaryImageUrl(image);
		if (src) image.setAttribute("src", src);
		const currentSet = image.getAttribute("srcset")?.trim() ?? "";
		if (!currentSet || currentSet.includes("data:")) {
			for (const attr of LAZY_IMAGE_SET_ATTRS) {
				const value = image.getAttribute(attr)?.trim();
				if (value) {
					image.setAttribute("srcset", value);
					break;
				}
			}
		}
	}
	for (const source of Array.from(doc.querySelectorAll<HTMLSourceElement>("source"))) {
		const src = source.getAttribute("src")?.trim() || source.getAttribute("data-src")?.trim() || "";
		if (src) source.setAttribute("src", src);
		const srcset = source.getAttribute("srcset")?.trim() || source.getAttribute("data-srcset")?.trim() || "";
		if (srcset) source.setAttribute("srcset", srcset);
	}
}

function htmlFromPlainText(text: string): string {
	const doc = document.implementation.createHTMLDocument("");
	for (const paragraph of text.split(/\n{2,}/).map(value => value.trim()).filter(Boolean)) {
		// 裸全局 `createEl`（Obsidian 挂在 window 上的那层助手）造的是**游离**元素，
		// 之后手动 append 进这份合成文档。别写成 `doc.createEl("p")` —— 那走的是
		// `Node.prototype.createEl`，它把 `this` 当父节点，往 Document 上 append
		// 第 2 个元素会直接抛 HierarchyRequestError。
		const p = createEl("p");
		p.textContent = paragraph;
		doc.body.appendChild(p);
	}
	return doc.body.innerHTML;
}

function structuredArticleFromJsonLd(doc: Document): { html: string; title: string; byline: string } | null {
	const queue: unknown[] = [];
	for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
		try { queue.push(JSON.parse(script.textContent ?? "")); } catch { /* 忽略站点损坏的 JSON-LD */ }
	}
	while (queue.length) {
		const value = queue.shift();
		if (Array.isArray(value)) {
			// `Array.isArray` 对 `unknown` 的收窄结果是 `any[]`，显式落回 `unknown[]`：
			// 只是摊平 JSON-LD 的数组，别让 any 顺着一路传下去。
			queue.push(...(value as unknown[]));
			continue;
		}
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		const graph = record["@graph"];
		if (Array.isArray(graph)) queue.push(...(graph as unknown[]));
		const rawType = record["@type"];
		const types = (Array.isArray(rawType) ? rawType : [rawType]).map(type => String(type ?? ""));
		if (!types.some(type => /(?:Article|BlogPosting|NewsArticle|Report|review)/i.test(type))) continue;
		const body = firstString(record, ["articleBody", "text"]);
		if (!body) continue;
		const authorValue = record.author;
		const author = typeof authorValue === "string"
			? authorValue
			: Array.isArray(authorValue)
				? authorValue.map(item => item && typeof item === "object" ? firstString(item as Record<string, unknown>, ["name"]) : String(item ?? "")).filter(Boolean).join("、")
				: authorValue && typeof authorValue === "object"
					? firstString(authorValue as Record<string, unknown>, ["name"])
					: "";
		return {
			html: /<\/?(?:p|h[1-6]|div|section|article|ul|ol|li|blockquote)\b/i.test(body) ? body : htmlFromPlainText(body),
			title: firstString(record, ["headline", "name"]),
			byline: author,
		};
	}
	return null;
}

interface HtmlMetrics {
	textLength: number
	paragraphs: number
	headings: number
	linkTextLength: number
	images: number
}

function metricsOf(root: Element): HtmlMetrics {
	const textLength = (root.textContent ?? "").replace(/\s+/g, " ").trim().length;
	let linkTextLength = 0;
	for (const anchor of Array.from(root.querySelectorAll("a"))) linkTextLength += anchor.textContent?.length ?? 0;
	return {
		textLength,
		paragraphs: root.querySelectorAll("p").length,
		headings: root.querySelectorAll("h2, h3, h4").length,
		linkTextLength,
		images: root.querySelectorAll("img, figure, video").length,
	};
}

/** 候选打分。**链接密度是乘性惩罚而不是减分** —— 减分挡不住"一整屏导航链接 + 两段正文"
 *  这类页面（导航文本可以长到几万字，减分永远填不满）；乘性惩罚能把列表页 / 归档页 /
 *  相关阅读块整体压到正文之下。图片只记一张权重（图文混排文章通常图多，但不该让
 *  "图片墙"压过真正文）。 */
function scoreMetrics(metrics: HtmlMetrics): number {
	if (metrics.textLength <= 0) return 0;
	const linkDensity = metrics.linkTextLength / Math.max(1, metrics.textLength);
	const penalty = linkDensity > 0.3 ? Math.max(0.04, 1 - (linkDensity - 0.3) * 2.4) : 1;
	const base = metrics.textLength
		+ metrics.paragraphs * 80
		+ metrics.headings * 30
		+ Math.min(metrics.images, 12) * 60;
	return base * penalty;
}

function articleHtmlScore(raw: string): number {
	if (!raw.trim()) return 0;
	try {
		const doc = new DOMParser().parseFromString(raw, "text/html");
		return scoreMetrics(metricsOf(stripNoise(doc.body)));
	} catch {
		return 0;
	}
}

/** 容器里常混着"相关阅读 / 频道导航 / 页脚"这类**整块几乎全是链接**的子块。它们不删的话，
 *  外层大 div 会靠几千字链接文本"骗"到最高分，把真正的正文挤下去。段落（p）不参与判定：
 *  一段话里带个链接是正常行文，不是导航。 */
function dropLinkBlocks(clone: Element): void {
	for (const block of Array.from(clone.querySelectorAll("div, section, ul, ol, aside, nav"))) {
		if (!block.parentNode) continue;
		const textLength = (block.textContent ?? "").replace(/\s+/g, " ").trim().length;
		if (textLength < 40) continue;
		let linkTextLength = 0;
		for (const anchor of Array.from(block.querySelectorAll("a"))) linkTextLength += anchor.textContent?.length ?? 0;
		if (linkTextLength / textLength > 0.8) block.remove();
	}
}

function stripNoise(clone: Element): Element {
	for (const noise of Array.from(clone.querySelectorAll(ARTICLE_NOISE_SELECTOR))) noise.remove();
	dropLinkBlocks(clone);
	return clone;
}

/** 清完噪声后正文"没了"的两种情况必须区分开：① 清掉的全是导航 → 用清理结果；
 *  ② **文章本身就是链接合集**（每周精选 / 资源索引 / 目录型长文）→ 清掉的就是正文，
 *  这时宁可保留原样，也不能把它判成"没有可提取的正文"。 */
function pruneOrKeep(cleaned: Element, raw: Element): string {
	if (metricsOf(cleaned).textLength < 80) return (raw as HTMLElement).innerHTML;
	return (cleaned as HTMLElement).innerHTML;
}

function pruneArticleHtml(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const body = doc.body;
	const before = metricsOf(body).textLength;
	if (before === 0) return html;
	const cleaned = stripNoise(body);
	if (metricsOf(cleaned).textLength < Math.min(80, before)) return html;
	return (cleaned as HTMLElement).innerHTML;
}

/** 正文容器候选：① 语义选择器（快、准，覆盖绝大多数站点）；② 结构容器的"文本密度"扫描
 *  —— 专门救那些 div 套 div 却不带任何语义 class 的站点（国内门户、老 CMS 最常见）。
 *  ②先粗筛（文本量 / 段落数 / 链接密度）再只对前几名做克隆精算，避免整页 clone。 */
function collectArticleContainers(doc: Document): Element[] {
	const containers = new Set<Element>();
	for (const selector of ARTICLE_CANDIDATE_SELECTORS) {
		for (const element of Array.from(doc.querySelectorAll(selector)).slice(0, 12)) containers.add(element);
	}
	const byDensity: Array<{ element: Element; textLength: number }> = [];
	for (const element of Array.from(doc.querySelectorAll("article, main, section, div, td")).slice(0, 400)) {
		if (containers.has(element)) continue;
		const textLength = element.textContent?.length ?? 0;
		if (textLength < 240) continue;
		if (element.querySelectorAll("p").length < 2) continue;
		const linkTextLength = Array.from(element.querySelectorAll("a"))
			.reduce((sum, anchor) => sum + (anchor.textContent?.length ?? 0), 0);
		if (linkTextLength / Math.max(1, textLength) >= 0.45) continue;
		byDensity.push({ element, textLength });
	}
	byDensity.sort((a, b) => b.textLength - a.textLength);
	for (const item of byDensity.slice(0, 6)) containers.add(item.element);
	return Array.from(containers);
}

function candidateArticleHtml(doc: Document): string {
	let bestHtml = "";
	let bestScore = 0;
	for (const element of collectArticleContainers(doc)) {
		const raw = element.cloneNode(true) as Element;
		const cleaned = stripNoise(raw.cloneNode(true) as Element);
		const score = scoreMetrics(metricsOf(cleaned));
		if (score > bestScore) {
			bestHtml = pruneOrKeep(cleaned, raw);
			bestScore = score;
		}
	}
	return bestHtml;
}

function metaContent(doc: Document, selectors: string[]): string {
	for (const selector of selectors) {
		const value = doc.querySelector<HTMLMetaElement>(selector)?.content?.trim();
		if (value) return value;
	}
	return "";
}

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

/** 嵌入媒体的站点标签。只认这批常见平台：其余 iframe 仍然被净化删掉（广告位大多也是
 *  iframe，不能无差别保留成链接）。 */
function embedLabel(url: string): string {
	if (/(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)/i.test(url)) return "YouTube 视频";
	if (/(?:^|\.)bilibili\.com/i.test(url)) return "哔哩哔哩视频";
	if (/(?:^|\.)vimeo\.com/i.test(url)) return "Vimeo 视频";
	if (/(?:^|\.)spotify\.com/i.test(url)) return "Spotify 音频";
	if (/(?:^|\.)soundcloud\.com/i.test(url)) return "SoundCloud 音频";
	if (/(?:^|\.)(?:twitter\.com|x\.com)/i.test(url)) return "X / Twitter 帖子";
	if (/(?:^|\.)instagram\.com/i.test(url)) return "Instagram 帖子";
	return "";
}

/** 把嵌入播放器链接还原成"给人看"的原始地址（/embed/ID → /watch?v=ID），
 *  否则阅读器里点出去落在播放器壳页上。 */
function canonicalEmbedUrl(url: string): string {
	const youtube = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/i.exec(url) ?? /youtu\.be\/([\w-]{6,})/i.exec(url);
	if (youtube?.[1]) return `https://www.youtube.com/watch?v=${youtube[1]}`;
	const bilibili = /bilibili\.com\/(?:player\.html\?(?:[^#]*&)?bvid=|video\/)(BV[\w]{6,})/i.exec(url);
	if (bilibili?.[1]) return `https://www.bilibili.com/video/${bilibili[1]}`;
	return url;
}

/** 正文里的嵌入媒体（iframe/embed）在净化时整段被删 —— 读者只看到"少了一块"。
 *  对已知平台的播放器改成一行链接占位，代价是多一个 `<p>`，收益是内容不再静默消失。 */
function promoteEmbeds(doc: Document): void {
	for (const frame of Array.from(doc.querySelectorAll("iframe[src], embed[src]"))) {
		const url = normalizeHttpUrl(frame.getAttribute("src"));
		const label = url ? embedLabel(url) : "";
		if (!url || !label) continue;
		// 用 Obsidian 的 DOM 助手造游离节点，再交给目标文档收养：跨文档 append
		// 会按 DOM 规范自动 adopt，节点最终仍属于 doc（`doc` 是 DOMParser 产物，
		// `doc.win` 为 null，不能走 `doc.win.createEl()` 那条形式）。
		const holder = createEl("p");
		const link = createEl("a");
		link.setAttribute("href", canonicalEmbedUrl(url));
		link.setAttribute("rel", "noopener noreferrer");
		link.textContent = `▶ ${label}`;
		holder.appendChild(link);
		frame.replaceWith(holder);
	}
}

export function sanitizeArticleHtml(raw: string, baseUrl: string, loadRemoteImages = true): string {
	const doc = new DOMParser().parseFromString(raw || "", "text/html");
	promoteEmbeds(doc);
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

/** 付费墙 / 登录墙的页面特征。只在"提取不到正文"时才用它给错误信息定性：正常文章正文里
 *  出现"订阅"二字太常见，不能拿它反过来判定失败原因。 */
const PAYWALL_PATTERN = /(?:付费(?:阅读|专享|内容|文章)|开通会员|会员专享|订阅后(?:继续|阅读|可读)|仅限?订阅(?:者|用户)|登录后(?:继续|阅读|查看)|扫码登录|subscribe to continue|subscribers? only|subscription required|sign in to continue|log ?in to (?:continue|read)|create a free account to continue|register to continue|become a member to|this (?:article|story|post) is for (?:subscribers|members))/i;

const PAGINATION_PAGE_PARAMS = new Set(["page", "paged", "p", "pg", "pagenum", "pageno", "start", "offset", "pageindex"]);

/** 判定 `a[rel=next]` 指向的是**同一篇文章的续页**而不是"下一篇推荐文章"。
 *  只认两种形态：① `/post/slug` → `/post/slug/2`（含 `/page/2`）；② 路径相同、只差分页参数。
 *  博客 head 里那个语义为"下一篇"的 `<link rel=next>` 不属于这两类，因此不会被误接。 */
function sameArticlePage(current: URL, next: URL): boolean {
	if (next.host !== current.host) return false;
	const strip = (path: string): string => path.replace(/\/+$/, "");
	const currentPath = strip(current.pathname);
	const nextPath = strip(next.pathname);
	if (!currentPath || !nextPath) return false;
	if (nextPath !== currentPath && strip(nextPath.replace(/\/(?:page\/?)?\d+$/i, "")) === currentPath) return true;
	if (nextPath === currentPath) {
		const changed = new Set<string>();
		for (const [key, value] of next.searchParams) {
			if (current.searchParams.get(key) !== value) changed.add(key.toLowerCase());
		}
		if (changed.size > 0 && Array.from(changed).every(key => PAGINATION_PAGE_PARAMS.has(key))) return true;
	}
	return false;
}

function findNextPageUrl(doc: Document, currentUrl: string): string {
	let current: URL;
	try { current = new URL(currentUrl); } catch { return ""; }
	for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[rel][href]"))) {
		if (!/(?:^|\s)next(?:\s|$)/i.test(anchor.getAttribute("rel") ?? "")) continue;
		const href = normalizeHttpUrl(anchor.getAttribute("href"), currentUrl);
		if (!href) continue;
		try {
			if (sameArticlePage(current, new URL(href))) return href;
		} catch { /* 解析不了的链接直接略过 */ }
	}
	return "";
}

/** 多页文章：把后续页的正文接在首页后面（`<hr>` 分隔）。正文 hash 由合并结果重算，
 *  因此"后又抓到了第 2 页"也会被正文更新检测（pendingContentHash）正确识别。 */
export function mergeExtractedArticles(pages: ExtractedArticle[]): ExtractedArticle {
	if (pages.length === 0) throw new Error("没有可合并的正文");
	if (pages.length === 1) return pages[0]!;
	const html = pages.map(page => page.html).join('<hr class="ur-fulltext-page-break">');
	return {
		title: pages[0]!.title,
		byline: pages[0]!.byline,
		html,
		text: pages.map(page => page.text).join("\n\n"),
		hash: stableHash(html),
		nextPageUrl: pages[pages.length - 1]!.nextPageUrl,
	};
}

export function extractFulltext(pageHtml: string, url: string): ExtractedArticle {
	const doc = new DOMParser().parseFromString(pageHtml, "text/html");
	promoteLazyMedia(doc);
	// 必须赶在 Readability 之前：它会把 iframe 当噪声丢掉，之后就再没有"这里原本有个播放器"的信息了
	promoteEmbeds(doc);
	// 同上：游离的 <base>，随后挂到合成文档的 head 上。
	const base = createEl("base");
	base.href = url;
	doc.head.appendChild(base);
	const structured = structuredArticleFromJsonLd(doc);
	let parsed: ReturnType<Readability["parse"]> = null;
	try {
		parsed = new Readability(doc.cloneNode(true) as Document, {
			charThreshold: 80,
			disableJSONLD: true,
		}).parse();
	} catch { /* 回退到正文容器 / JSON-LD */ }

	type CandidateSource = "readability" | "jsonld" | "container";
	const rawCandidates: Array<{ html: string; source: CandidateSource }> = [
		{ html: parsed?.content ?? "", source: "readability" },
		{ html: structured?.html ?? "", source: "jsonld" },
		{ html: candidateArticleHtml(doc), source: "container" },
	];
	const candidates = rawCandidates.map<{ html: string; source: CandidateSource }>(candidate => ({
		html: sanitizeArticleHtml(candidate.html, url),
		source: candidate.source,
	}));
	let html = "";
	let fallbackHtml = "";
	let bestScore = 0;
	let source: CandidateSource = "readability";
	for (const candidate of candidates) {
		// 全是链接的合集型文章在清理后分数会归零 —— 留一份未清理的兜底，别判成"没有正文"
		if (!fallbackHtml && candidate.html.trim()) fallbackHtml = candidate.html;
		const score = articleHtmlScore(candidate.html);
		if (score > bestScore) {
			html = candidate.html;
			bestScore = score;
			source = candidate.source;
		}
	}
	if (!html) html = fallbackHtml;
	// 选中的候选（尤其 Readability 的整块输出）同样可能带着"相关阅读"链接块，产出前再清一次
	if (html) html = pruneArticleHtml(html);
	if (!html.trim() || stripHtml(html).length < 80) {
		// 失败原因分三档说清楚：用户看到的 Notice 直接决定他"要不要换浏览器打开"。
		const pageText = stripHtml(doc.body.innerHTML);
		if (PAYWALL_PATTERN.test(pageText)) throw new Error("该网页需要登录或订阅会员，暂时抓不到正文");
		if (pageText.length < 400) throw new Error("网页正文由脚本渲染，静态抓取不到内容");
		throw new Error("网页没有可提取的正文");
	}
	const text = stripHtml(html);
	return {
		title: (source === "jsonld" ? structured?.title : "") || parsed?.title?.trim() || metaContent(doc, ["meta[property='og:title']", "meta[name='twitter:title']"]) || doc.title.trim(),
		byline: (source === "jsonld" ? structured?.byline : "") || parsed?.byline?.trim() || metaContent(doc, ["meta[name='author']", "meta[property='article:author']"]),
		html,
		hash: stableHash(html),
		text,
		nextPageUrl: findNextPageUrl(doc, url),
	};
}
