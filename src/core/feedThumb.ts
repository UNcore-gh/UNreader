import { normalizeHttpUrl } from "./feedUtils";

/** 列表卡片缩略图：从 RSS 正文 HTML 里挑出**第一张可下载的图**。
 *
 *  为什么单独成模块：`ensureEntryContent` 水合出来的 `contentHtml` 是整篇正文（可能几百 KB），
 *  列表卡片只要一个 URL —— 解析逻辑必须与「阅读视图渲染全文」解耦，避免以后有人在渲染
 *  通道里顺手改净化规则，把卡片的取图口径也一起改掉。
 *
 *  与 `articleExtractor.sanitizeArticleHtml` 的分工：那边负责**是否允许**远程图（净化/摘除），
 *  这里只负责**找哪一张**。下载与缓存全交给 `feedMediaStore`，本模块不发任何请求。 */

/** 惰性加载属性：不少站点把真实地址放在 data-src 上，src 是占位图。 */
const LAZY_ATTRS = ["src", "data-src", "data-original", "data-lazy-src", "data-actualsrc"];

/** 取出第一张 http(s) 图片的绝对地址；没有则 null。
 *
 *  · 只认 http(s)：`data:`（内联 base64）在缩略图尺寸下既浪费内存又常常是埋点像素，直接跳过；
 *  · 相对路径按 `baseUrl` 归一（正文里 `src="/img/a.png"` 是常态）；
 *  · 解析失败（HTML 畸形）返回 null —— 卡片退化成「全宽文字」，不抛错。 */
export function firstImageUrl(html: string, baseUrl: string): string | null {
	if (!html) return null;
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, "text/html");
	} catch {
		return null;
	}
	const images = Array.from(doc.querySelectorAll("img"));
	for (const image of images) {
		for (const attr of LAZY_ATTRS) {
			const raw = image.getAttribute(attr);
			if (!raw) continue;
			const url = normalizeHttpUrl(raw, baseUrl || undefined);
			if (url) return url;
		}
	}
	return null;
}
