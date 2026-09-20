import { Vault, normalizePath } from "obsidian";
import type { FeedEntry, FeedEntryState, FeedFileData, FeedIndexFile, FeedSubscription } from "../types";
import { FEEDS_FOLDER } from "./paths";
import type { ParsedFeedEntry } from "./feedParser";
import { emptyFeedEntryState, mergeFeedEntries, stableFeedId } from "./feedUtils";

const INDEX_FILE = "index.json";

function feedFileName(feedId: string): string {
	return `${feedId.replace(/[^a-z0-9_-]/gi, "_")}.json`;
}

function normalizeSubscription(value: Partial<FeedSubscription>): FeedSubscription | null {
	if (!value.feedUrl || typeof value.feedUrl !== "string") return null;
	return {
		id: typeof value.id === "string" && value.id ? value.id : stableFeedId(value.feedUrl),
		title: typeof value.title === "string" && value.title ? value.title : new URL(value.feedUrl).hostname,
		siteUrl: typeof value.siteUrl === "string" ? value.siteUrl : "",
		feedUrl: value.feedUrl,
		description: typeof value.description === "string" ? value.description : "",
		addedAt: typeof value.addedAt === "number" ? value.addedAt : Date.now(),
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
		lastFetchedAt: typeof value.lastFetchedAt === "number" ? value.lastFetchedAt : 0,
		lastError: typeof value.lastError === "string" ? value.lastError : null,
		etag: typeof value.etag === "string" ? value.etag : null,
		lastModified: typeof value.lastModified === "string" ? value.lastModified : null,
		// 旧库没有这个字段 → 一律按「启用」读；只有显式写了 false 才算停用
		enabled: value.enabled !== false,
	};
}

function normalizeState(value: Partial<FeedEntryState> | undefined): FeedEntryState {
	const base = emptyFeedEntryState();
	if (!value) return base;
	return {
		readAt: typeof value.readAt === "number" ? value.readAt : null,
		starredAt: typeof value.starredAt === "number" ? value.starredAt : null,
		openedAt: typeof value.openedAt === "number" ? value.openedAt : 0,
		position: value.position ?? null,
		hasAnnotations: value.hasAnnotations === true,
		stateUpdatedAt: typeof value.stateUpdatedAt === "number" ? value.stateUpdatedAt : base.stateUpdatedAt,
	};
}

function normalizeEntry(value: Partial<FeedEntry>, feedId: string): FeedEntry | null {
	if (!value.id || !value.title) return null;
	const contentHtml = typeof value.contentHtml === "string" ? value.contentHtml : "";
	return {
		id: value.id,
		feedId,
		guid: typeof value.guid === "string" ? value.guid : value.id,
		kind: value.kind === "audio" ? "audio" : "article",
		title: value.title,
		url: typeof value.url === "string" ? value.url : "",
		author: typeof value.author === "string" ? value.author : "",
		publishedAt: typeof value.publishedAt === "number" ? value.publishedAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		summary: typeof value.summary === "string" ? value.summary : "",
		contentHtml,
		contentSource: value.contentSource === "fulltext" ? "fulltext" : "feed",
		contentHash: typeof value.contentHash === "string" ? value.contentHash : "",
		pendingContentHtml: typeof value.pendingContentHtml === "string" ? value.pendingContentHtml : undefined,
		pendingContentHash: typeof value.pendingContentHash === "string" ? value.pendingContentHash : undefined,
		pendingContentSource: value.pendingContentSource === "fulltext" ? "fulltext" : value.pendingContentSource === "feed" ? "feed" : undefined,
		enclosure: value.enclosure ?? null,
		state: normalizeState(value.state),
	};
}

export class FeedStore {
	private feeds = new Map<string, FeedSubscription>();
	private entries = new Map<string, Map<string, FeedEntry>>();
	private initialized = false;

	constructor(private vault: Vault) {}

	async init(): Promise<void> {
		this.feeds.clear();
		this.entries.clear();
		const index = await this.readJson<Partial<FeedIndexFile>>(`${FEEDS_FOLDER}/${INDEX_FILE}`);
		for (const raw of Array.isArray(index?.feeds) ? index.feeds : []) {
			const feed = normalizeSubscription(raw);
			if (feed) this.feeds.set(feed.id, feed);
		}
		const loads = [...this.feeds.values()].map(async feed => {
			const data = await this.readJson<Partial<FeedFileData>>(`${FEEDS_FOLDER}/${feedFileName(feed.id)}`);
			const map = new Map<string, FeedEntry>();
			for (const raw of Array.isArray(data?.entries) ? data.entries : []) {
				const entry = normalizeEntry(raw, feed.id);
				if (entry) map.set(entry.id, entry);
			}
			this.entries.set(feed.id, map);
		});
		await Promise.all(loads);
		this.initialized = true;
	}

	isReady(): boolean {
		return this.initialized;
	}

	listFeeds(): FeedSubscription[] {
		return [...this.feeds.values()].sort((a, b) => a.title.localeCompare(b.title));
	}

	getFeed(feedId: string): FeedSubscription | null {
		return this.feeds.get(feedId) ?? null;
	}

	getFeedByUrl(feedUrl: string): FeedSubscription | null {
		const normalized = feedUrl.trim();
		for (const feed of this.feeds.values()) if (feed.feedUrl === normalized) return feed;
		return null;
	}

	listEntries(feedId?: string): FeedEntry[] {
		const values = feedId
			? [...(this.entries.get(feedId)?.values() ?? [])]
			: [...this.entries.values()].flatMap(map => [...map.values()]);
		return values.sort((a, b) => (b.publishedAt - a.publishedAt) || a.title.localeCompare(b.title));
	}

	getEntry(feedId: string, entryId: string): FeedEntry | null {
		return this.entries.get(feedId)?.get(entryId) ?? null;
	}

	async addSubscription(input: {
		feedUrl: string
		siteUrl?: string
		title?: string
		description?: string
	}): Promise<FeedSubscription> {
		const feedUrl = input.feedUrl.trim();
		const id = stableFeedId(feedUrl);
		const existing = this.feeds.get(id);
		if (existing) return existing;
		const now = Date.now();
		const feed: FeedSubscription = {
			id,
			title: input.title?.trim() || new URL(feedUrl).hostname,
			siteUrl: input.siteUrl?.trim() || "",
			feedUrl,
			description: input.description?.trim() || "",
			addedAt: now,
			updatedAt: now,
			lastFetchedAt: 0,
			lastError: null,
			etag: null,
			lastModified: null,
			enabled: true,
		};
		this.feeds.set(id, feed);
		this.entries.set(id, new Map());
		await this.writeIndex();
		await this.writeFeed(id);
		return feed;
	}

	async removeSubscription(feedId: string): Promise<void> {
		if (!this.feeds.delete(feedId)) return;
		this.entries.delete(feedId);
		await this.writeIndex();
		try {
			await this.vault.adapter.remove(normalizePath(`${FEEDS_FOLDER}/${feedFileName(feedId)}`));
		} catch { /* 文件可能尚未创建 */ }
	}

	async renameSubscription(feedId: string, title: string): Promise<void> {
		const feed = this.feeds.get(feedId);
		if (!feed) return;
		feed.title = title.trim() || feed.title;
		feed.updatedAt = Date.now();
		await Promise.all([this.writeIndex(), this.writeFeed(feedId)]);
	}

	/** 启用 / 停用订阅。停用只改索引里的一位（文章快照原样保留，随时可再启用）。 */
	async setSubscriptionEnabled(feedId: string, enabled: boolean): Promise<void> {
		const feed = this.feeds.get(feedId);
		if (!feed || feed.enabled === enabled) return;
		feed.enabled = enabled;
		feed.updatedAt = Date.now();
		await this.writeIndex();
	}

	async updateFetchMetadata(
		feedId: string,
		patch: Partial<Pick<FeedSubscription, "title" | "siteUrl" | "description" | "lastFetchedAt" | "lastError" | "etag" | "lastModified">>,
	): Promise<void> {
		const feed = this.feeds.get(feedId);
		if (!feed) return;
		Object.assign(feed, patch, { updatedAt: Date.now() });
		await this.writeIndex();
	}

	async mergeFeedEntries(feedId: string, parsed: ParsedFeedEntry[], limit: number): Promise<FeedEntry[]> {
		const map = this.entries.get(feedId) ?? new Map<string, FeedEntry>();
		const now = Date.now();
		const incoming: FeedEntry[] = parsed.map(item => ({
			...item,
			feedId,
			state: emptyFeedEntryState(now),
		}));
		const merged = mergeFeedEntries([...map.values()], incoming, limit);
		this.entries.set(feedId, new Map(merged.map(entry => [entry.id, entry])));
		await this.writeFeed(feedId);
		return merged;
	}

	async updateEntryState(feedId: string, entryId: string, patch: Partial<FeedEntryState>): Promise<FeedEntry | null> {
		const entry = this.entries.get(feedId)?.get(entryId);
		if (!entry) return null;
		const next: FeedEntryState = {
			...entry.state,
			...patch,
			stateUpdatedAt: Date.now(),
		};
		entry.state = next;
		entry.updatedAt = Math.max(entry.updatedAt, next.stateUpdatedAt);
		await this.writeFeed(feedId);
		return entry;
	}

	/** 一次写入多条阅读状态，供播客进度等高频小更新合并落盘。 */
	async updateEntriesState(feedId: string, patches: Array<{ entryId: string; patch: Partial<FeedEntryState> }>): Promise<void> {
		const map = this.entries.get(feedId);
		if (!map || !patches.length) return;
		let changed = false;
		for (const { entryId, patch } of patches) {
			const entry = map.get(entryId);
			if (!entry) continue;
			const next: FeedEntryState = {
				...entry.state,
				...patch,
				stateUpdatedAt: Date.now(),
			};
			entry.state = next;
			entry.updatedAt = Math.max(entry.updatedAt, next.stateUpdatedAt);
			changed = true;
		}
		if (changed) await this.writeFeed(feedId);
	}

	async replaceEntryContent(
		feedId: string,
		entryId: string,
		contentHtml: string,
		contentHash: string,
		metadata?: { title?: string; author?: string },
	): Promise<FeedEntry | null> {
		const entry = this.entries.get(feedId)?.get(entryId);
		if (!entry) return null;
		entry.contentHtml = contentHtml;
		entry.contentHash = contentHash;
		entry.contentSource = "fulltext";
		if (metadata?.title?.trim()) entry.title = metadata.title.trim();
		if (!entry.author && metadata?.author?.trim()) entry.author = metadata.author.trim();
		entry.pendingContentHtml = undefined;
		entry.pendingContentHash = undefined;
		entry.pendingContentSource = undefined;
		entry.updatedAt = Date.now();
		await this.writeFeed(feedId);
		return entry;
	}

	/** 完成一次正文更新：只有当前待处理哈希仍匹配时才提交，避免两个刷新结果互相覆盖。 */
	async commitPendingContent(feedId: string, entryId: string, expectedHash: string): Promise<FeedEntry | null> {
		const entry = this.entries.get(feedId)?.get(entryId);
		if (!entry || !entry.pendingContentHtml || entry.pendingContentHash !== expectedHash) return entry ?? null;
		entry.contentHtml = entry.pendingContentHtml;
		entry.contentHash = entry.pendingContentHash;
		entry.contentSource = entry.pendingContentSource ?? "feed";
		entry.pendingContentHtml = undefined;
		entry.pendingContentHash = undefined;
		entry.pendingContentSource = undefined;
		entry.updatedAt = Date.now();
		await this.writeFeed(feedId);
		return entry;
	}

	async flush(): Promise<void> {
		await Promise.all([...this.feeds.keys()].map(feedId => this.writeFeed(feedId)));
		if (this.feeds.size > 0 || this.initialized) await this.writeIndex();
	}

	private async readJson<T>(path: string): Promise<T | null> {
		try {
			const raw = await this.vault.adapter.read(normalizePath(path));
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	private async ensureFolder(): Promise<void> {
		const path = normalizePath(FEEDS_FOLDER);
		if (await this.vault.adapter.exists(path)) return;
		try { await this.vault.createFolder(path); } catch { /* 并发创建 */ }
	}

	private async writeIndex(): Promise<void> {
		await this.ensureFolder();
		const payload: FeedIndexFile = {
			version: 1,
			feeds: this.listFeeds(),
			updatedAt: Date.now(),
		};
		await this.vault.adapter.write(normalizePath(`${FEEDS_FOLDER}/${INDEX_FILE}`), JSON.stringify(payload, null, "\t"));
	}

	private async writeFeed(feedId: string): Promise<void> {
		await this.ensureFolder();
		const payload: FeedFileData = {
			version: 1,
			feedId,
			entries: this.listEntries(feedId),
			updatedAt: Date.now(),
		};
		await this.vault.adapter.write(
			normalizePath(`${FEEDS_FOLDER}/${feedFileName(feedId)}`),
			JSON.stringify(payload, null, "\t"),
		);
	}
}
