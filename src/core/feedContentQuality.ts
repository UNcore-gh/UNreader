/** Feed 自带正文的完整度判定。
 *
 * RSS 生态里“description”有时是标题、有时是摘要、有时就是全文；不能只看字段名。
 * 这里用正文的结构和体量做保守判断：宁可把一篇短札标成“摘要”让网页兜底再抓一次，
 * 也不要把标题/两行导语误当成全文直接给用户读。 */
export type FeedContentQuality = "full" | "summary" | "empty";

const TRUNCATION_PATTERN = /(?:阅读全文|继续阅读|查看全文|Read more|全文共\d+字|登录后查看|会员专享)/i;

interface FeedContentMetrics {
	textLength: number
	blockCount: number
	mediaCount: number
	linkTextLength: number
}

function metricsOf(root: Element): FeedContentMetrics {
	for (const noise of Array.from(root.querySelectorAll("script, style, nav, header, footer, aside, form"))) noise.remove();
	const text = (root.textContent ?? "").replace(/\s+/g, " ").trim();
	return {
		textLength: text.length,
		blockCount: root.querySelectorAll("p, li, blockquote, pre, h1, h2, h3, h4, h5, h6, td").length,
		mediaCount: root.querySelectorAll("img, picture, audio, video").length,
		linkTextLength: Array.from(root.querySelectorAll("a")).reduce((sum, anchor) => sum + (anchor.textContent?.length ?? 0), 0),
	};
}

export function evaluateFeedContentQuality(rawHtml: string): FeedContentQuality {
	const html = rawHtml.trim();
	if (!html) return "empty";
	try {
		const doc = new DOMParser().parseFromString(html, "text/html");
		const metrics = metricsOf(doc.body);
		if (metrics.textLength < 40 && metrics.mediaCount === 0) return "empty";

		// 中文博客 500 字 + 两段，已经不太可能是“标题党”RSS；更长的单段/纯文本也放行。
		// 链接合集类长文不因链接密度降级，否则阮一峰科技爱好者周刊这类正文会被误判。
		const isFull = (metrics.textLength >= 500 && metrics.blockCount >= 2)
			|| metrics.textLength >= 1200
			|| (metrics.mediaCount > 0 && metrics.textLength >= 300);
		if (isFull) return "full";

		// 截断提示主要用来救“300 字导语 + 阅读全文”的中间地带；长文里偶尔出现的字样不作为否决项。
		if (metrics.textLength < 900 && TRUNCATION_PATTERN.test(html)) return "summary";
		return "summary";
	} catch {
		return rawHtml.length >= 1200 ? "full" : "summary";
	}
}

/** 不同字段的正文候选可能一好一坏：有的 Feed 在 content:encoded 只放标题，
 *  却把全文塞在 description。按完整度优先、同档再比正文长度，避免“字段优先级”误伤。 */
export function chooseRicherFeedContent(first: string, second: string): string {
	const firstQuality = evaluateFeedContentQuality(first);
	const secondQuality = evaluateFeedContentQuality(second);
	const rank = (quality: FeedContentQuality): number => quality === "full" ? 2 : quality === "summary" ? 1 : 0;
	const firstRank = rank(firstQuality);
	const secondRank = rank(secondQuality);
	if (secondRank > firstRank) return second;
	if (firstRank > secondRank) return first;
	return second.trim().length > first.trim().length ? second : first;
}

/** 旧库没有 quality 字段时在这里补算；fulltext 本身就是网页提取产物，不再重复评估。 */
export function entryFeedContentQuality(entry: {
	contentHtml: string
	contentSource: "feed" | "fulltext"
	contentQuality?: FeedContentQuality
	kind?: "article" | "audio"
}): FeedContentQuality {
	if (entry.contentSource === "fulltext") return "full";
	return entry.contentQuality ?? evaluateFeedContentQuality(entry.contentHtml);
}
