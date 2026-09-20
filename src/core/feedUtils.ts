import type { FeedEntry, FeedEnclosure } from "../types";

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
		openedAt: 0,
		position: null,
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

/** 「长期保留」的判据：星标，或动过笔（高亮 / 批注 / 书签，由 readerView 同步进
 *  `state.hasAnnotations`）。**已读刻意不算** —— readAt 一旦参与豁免，读过的老文章
 *  就会永久常驻，保留上限等于形同虚设。 */
export function isPinnedFeedEntry(entry: FeedEntry): boolean {
	return entry.state.starredAt != null || entry.state.hasAnnotations === true;
}

function byRecency(a: FeedEntry, b: FeedEntry): number {
	return (b.publishedAt - a.publishedAt) || a.title.localeCompare(b.title);
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
			|| prev.state.position || next.state.position
		);
		const keepOldContent = contentChanged && hasAnnotationsOrProgress;
		const keepPending = !contentChanged && !!prev.pendingContentHash;
		byId.set(next.id, {
			...next,
			contentHtml: keepOldContent ? prev.contentHtml : next.contentHtml,
			contentSource: keepOldContent ? prev.contentSource : next.contentSource,
			contentHash: keepOldContent ? prev.contentHash : next.contentHash,
			pendingContentHtml: keepOldContent
				? next.contentHtml
				: keepPending ? prev.pendingContentHtml : undefined,
			pendingContentHash: keepOldContent
				? next.contentHash
				: keepPending ? prev.pendingContentHash : undefined,
			pendingContentSource: keepOldContent
				? next.contentSource
				: keepPending ? prev.pendingContentSource : undefined,
			state: {
				...prev.state,
				readAt: next.state.readAt ?? prev.state.readAt,
				starredAt: next.state.starredAt ?? prev.state.starredAt,
				openedAt: Math.max(prev.state.openedAt, next.state.openedAt),
				position: prev.state.position ?? next.state.position,
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
