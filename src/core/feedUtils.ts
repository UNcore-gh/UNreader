import type { BookPosition, FeedEntry, FeedEnclosure } from "../types";
import { evaluateFeedContentQuality, type FeedContentQuality } from "./feedContentQuality";

export function stableHash(input: string): string {
	let a = 0x811c9dc5;
	let b = 0x9e3779b9;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		a ^= c;
		a = Math.imul(a, 0x01000193);
		b ^= c + ((b << 6) ^ (b >>> 2));
		b = Math.imul(b, 0x85ebca6b);
	}
	return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function stableFeedId(feedUrl: string): string {
	return `feed-${stableHash(feedUrl.trim().toLowerCase())}`;
}

export function stableEntryId(parts: {
	guid?: string | null
	url?: string | null
	publishedAt?: number | null
	title?: string | null
}): string {
	const identity = (parts.guid || parts.url || `${parts.publishedAt ?? 0}|${parts.title ?? ""}`).trim();
	return `entry-${stableHash(identity.toLowerCase())}`;
}

export function normalizeHttpUrl(raw: string | null | undefined, base?: string | null): string {
	const value = (raw ?? "").trim();
	if (!value) return "";
	try {
		const url = base ? new URL(value, base) : new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		url.hash = "";
		return url.toString();
	} catch {
		return "";
	}
}

export function isSafeRemoteUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export function stripHtml(raw: string): string {
	if (!raw) return "";
	try {
		const doc = new DOMParser().parseFromString(raw, "text/html");
		return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
	} catch {
		return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	}
}

export function emptyFeedEntryState(now = Date.now()): FeedEntry["state"] {
	return {
		readAt: null,
		starredAt: null,
		savedAt: null,
		openedAt: 0,
		position: null,
		audioPosition: null,
		hasAnnotations: false,
		stateUpdatedAt: now,
	};
}

export interface FeedAnnotationAnchor {
	anchor: string
	color: string
	text: string
	contentHash?: string
	stale?: boolean
}

export interface FeedBookmarkAnchor {
	anchor: string
	contentHash?: string
	stale?: boolean
}

export interface FeedAnnotationAnchorAdapter {
	findTextForAnnotation(text: string): { cfi: string } | null
	removeHighlight(cfi: string): void
	addHighlight(cfi: string, colorName: string, textHint?: string): void
}

/** Feed 阅读态正文快照。 */
export function activeFeedContent(entry: Pick<FeedEntry, "contentHtml" | "contentHash" | "pendingContentHtml" | "pendingContentHash">): { html: string; hash: string | null } {
	if (entry.pendingContentHtml?.trim() && entry.pendingContentHash) {
		return { html: entry.pendingContentHtml, hash: entry.pendingContentHash };
	}
	return { html: entry.contentHtml, hash: entry.contentHtml.trim() ? entry.contentHash || null : null };
}

/** Feed 正文更新后迁移标注锚点，并让已渲染的高亮同步落到新位置。 */
export function reconcileFeedAnnotationAnchors(
	annotations: { highlights: FeedAnnotationAnchor[]; bookmarks: FeedBookmarkAnchor[] },
	contentHash: string,
	adapter: FeedAnnotationAnchorAdapter,
): boolean {
	let changed = false
	for (const highlight of annotations.highlights) {
		highlight.stale = false
		if (!highlight.contentHash || highlight.contentHash === contentHash) continue
		const found = highlight.text ? adapter.findTextForAnnotation(highlight.text) : null
		if (!found) {
			highlight.stale = true
			changed = true
			continue
		}
		// 旧 CFI 在新正文里可能仍能解析，但重绘必须走重新定位后的位置；
		// 先删再画避免同一高亮在旧、新两处同时存在。
		adapter.removeHighlight(highlight.anchor)
		highlight.anchor = found.cfi
		highlight.contentHash = contentHash
		adapter.addHighlight(found.cfi, highlight.color, highlight.text)
		changed = true
	}
	for (const bookmark of annotations.bookmarks) {
		const stale = !!bookmark.contentHash && bookmark.contentHash !== contentHash
		bookmark.stale = stale
		if (stale) changed = true
	}
	return changed
}

export function normalizeEnclosure(value: FeedEnclosure | null | undefined): FeedEnclosure | null {
	if (!value?.url || !isSafeRemoteUrl(value.url)) return null;
	return {
		url: value.url,
		type: value.type || "application/octet-stream",
		length: typeof value.length === "number" && Number.isFinite(value.length) ? value.length : null,
		duration: typeof value.duration === "number" && Number.isFinite(value.duration) ? value.duration : null,
	};
}

/** 「长期保留」的判据：星标、已保存全文，或动过笔（高亮 / 批注 / 书签，由 readerView 同步进
 *  `state.hasAnnotations`）。**已读刻意不算** —— readAt 一旦参与豁免，读过的老文章
 *  就会永久常驻，保留上限等于形同虚设。
 *
 *  ⚠️ 「保存全文」与「星标」在这里**必须同权**（用户 2026-10-13 定稿：星标功能和保存全文
 *  功能要一致）：两者都是用户显式表达的「这篇我要留下」，谁被清理掉都是数据损失 ——
 *  订阅链接失效、刷新裁剪都只能清掉没被标记的那些。 */
export function isPinnedFeedEntry(entry: FeedEntry): boolean {
	return entry.state.starredAt != null || entry.state.savedAt != null || entry.state.hasAnnotations === true;
}

/** 「保存为 Markdown」是否对这篇有意义。
 *
 *  保存 = **把这篇的正文取成 Markdown 落进 vault**，所以唯一的判据就是「有正文可取」：
 *  · Feed 自带全文 / 已抓过全文 → 直接转，不必联网；
 *  · 只有摘要 → 必须能去抓原文（有 http(s) 原文地址），抓不到就没有可保存的内容
 *    （宁可不出这枚按钮，也不让用户点了才吃一条「保存失败」）。
 *
 *  ⚠️ **刻意不看 `kind`**（2026-10-13 八轮报障：「还有一些博客文章依旧没有显示保存为
 *  markdown 的这个按钮，需要提供（录音嵌入到文章中）」）：`kind` 的唯一来源是
 *  `feedParser` 里的 `enclosure.type.startsWith("audio/")` —— 那是「这条有没有音频附件」，
 *  **不是「这条是不是播客」**。博客文章里嵌一段录音同样会被标成 `audio`，而它的正文是
 *  正经文章，凭什么不给存？所以这里回到真正该问的问题：有没有正文可取。
 *  纯播客（正文只有节目简介、又没给网页地址）自然还是不满足条件，按钮也就不出现。 */
export function canSaveFeedEntry(entry: FeedEntry): boolean {
	if (entry.contentSource === "fulltext") return true;
	if ((entry.contentQuality ?? evaluateFeedContentQuality(entry.contentHtml)) === "full") return true;
	return !!entry.url && isSafeRemoteUrl(entry.url);
}

function byRecency(a: FeedEntry, b: FeedEntry): number {
	return (b.publishedAt - a.publishedAt) || a.title.localeCompare(b.title);
}

/** fulltext 是网页提取结果，天然当全文；Feed 自带正文则按体量/结构保守评级。 */
function qualityOf(entry: FeedEntry): FeedContentQuality {
	if (entry.contentSource === "fulltext") return "full";
	return entry.contentQuality ?? evaluateFeedContentQuality(entry.contentHtml);
}

function qualityRank(quality: FeedContentQuality): number {
	return quality === "full" ? 2 : quality === "summary" ? 1 : 0;
}

function newerPosition(a: BookPosition | null | undefined, b: BookPosition | null | undefined): BookPosition | null {
	if (!a) return b ?? null;
	if (!b) return a;
	return (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b;
}

export function mergeFeedEntries(existing: FeedEntry[], incoming: FeedEntry[], limit: number): FeedEntry[] {
	const byId = new Map<string, FeedEntry>();
	for (const entry of existing) byId.set(entry.id, entry);
	for (const next of incoming) {
		const prev = byId.get(next.id);
		if (!prev) {
			byId.set(next.id, next);
			continue;
		}
		const contentChanged = prev.contentHash !== next.contentHash;
		const hasAnnotationsOrProgress = !!(
			prev.state.hasAnnotations || next.state.hasAnnotations
			||
			prev.state.starredAt || next.state.starredAt
			|| prev.state.savedAt || next.state.savedAt
			|| prev.state.position || next.state.position
		);
		const prevQuality = qualityOf(prev);
		const nextQuality = next.contentQuality ?? evaluateFeedContentQuality(next.contentHtml);
		// 已抓全文 / 已有完整 Feed 正文时，绝不能被下一次刷新拿到的标题或摘要覆盖。
		// 有标注/进度时仍保留现有“旧正文 + pending 新正文”的迁移机制。
		const keepOldContent = contentChanged && (hasAnnotationsOrProgress || qualityRank(nextQuality) < qualityRank(prevQuality));
		const shouldPending = keepOldContent && qualityRank(nextQuality) >= qualityRank(prevQuality);
		const keepPending = !contentChanged && !!prev.pendingContentHash;
		byId.set(next.id, {
			...next,
			contentHtml: keepOldContent ? prev.contentHtml : next.contentHtml,
			contentSource: keepOldContent ? prev.contentSource : next.contentSource,
			contentHash: keepOldContent ? prev.contentHash : next.contentHash,
			contentQuality: keepOldContent ? prevQuality : nextQuality,
			pendingContentHtml: shouldPending
				? next.contentHtml
				: keepPending ? prev.pendingContentHtml : undefined,
			pendingContentHash: shouldPending
				? next.contentHash
				: keepPending ? prev.pendingContentHash : undefined,
			pendingContentSource: shouldPending
				? next.contentSource
				: keepPending ? prev.pendingContentSource : undefined,
			pendingContentQuality: shouldPending
				? nextQuality
				: keepPending ? prev.pendingContentQuality : undefined,
			state: {
				...prev.state,
				readAt: next.state.readAt ?? prev.state.readAt,
				starredAt: next.state.starredAt ?? prev.state.starredAt,
				savedAt: next.state.savedAt ?? prev.state.savedAt,
				openedAt: Math.max(prev.state.openedAt, next.state.openedAt),
				position: newerPosition(prev.state.position, next.state.position),
				audioPosition: newerPosition(prev.state.audioPosition, next.state.audioPosition),
				hasAnnotations: !!(prev.state.hasAnnotations || next.state.hasAnnotations),
				stateUpdatedAt: Math.max(prev.state.stateUpdatedAt, next.state.stateUpdatedAt),
			},
		});
	}
	// 裁剪：先按发布时间取最新的 N 篇，再把剩下的里面**星标 / 有笔记**的那些捞回来。
	// 捞回来的条目可能与最新那段在时间上交错，所以合并后要重排一次，列表顺序仍严格按时间。
	const sorted = [...byId.values()].sort(byRecency);
	const keepCount = Math.max(1, limit);
	return [...sorted.slice(0, keepCount), ...sorted.slice(keepCount).filter(isPinnedFeedEntry)].sort(byRecency);
}
