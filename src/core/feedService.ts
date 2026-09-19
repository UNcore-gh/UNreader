import type { FeedEntry, FeedSettings } from "../types";
import { extractFulltext } from "./articleExtractor";
import { fetchPageForExtraction, fetchParsedFeed, resolveFeedInput, type FeedResolution } from "./feedFetcher";
import type { FeedStore } from "./feedStore";
import { parseOpml, type ParsedOpmlFeed } from "./feedParser";

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

export interface FeedRefreshResult {
	feedId: string
	addedOrUpdated: number
	notModified: boolean
	error: string | null
}

/** Feed 网络与合并服务。所有方法只在用户显式操作或打开文章时调用。 */
export class FeedService {
	private inFlight = new Map<string, Promise<FeedRefreshResult>>();
	private retryAt = new Map<string, { at: number; attempt: number }>();
	private closed = false;

	constructor(
		private store: FeedStore,
		private getSettings: () => FeedSettings,
	) {}

	async resolveInput(input: string): Promise<FeedResolution> {
		this.assertOpen();
		return resolveFeedInput(input);
	}

	async addSubscription(input: {
		feedUrl: string
		siteUrl?: string
		title?: string
		description?: string
	}, refresh = true): Promise<FeedRefreshResult> {
		this.assertOpen();
		const feed = await this.store.addSubscription(input);
		if (!refresh) return { feedId: feed.id, addedOrUpdated: 0, notModified: false, error: null };
		return this.refreshFeed(feed.id, true);
	}

	async removeSubscription(feedId: string): Promise<void> {
		this.assertOpen();
		this.retryAt.delete(feedId);
		await this.store.removeSubscription(feedId);
	}

	async importOpml(raw: string): Promise<{ imported: number; refreshed: number; failed: number }> {
		this.assertOpen();
		const feeds = parseOpml(raw);
		let imported = 0;
		let refreshed = 0;
		let failed = 0;
		for (const item of feeds) {
			try {
				const before = this.store.getFeedByUrl(item.feedUrl);
				const feed = await this.store.addSubscription(item);
				if (!before) imported++;
				const result = await this.refreshFeed(feed.id, false, true);
				if (result.error) failed++;
				else refreshed++;
			} catch {
				failed++;
			}
		}
		return { imported, refreshed, failed };
	}

	exportOpml(): string {
		const esc = (value: string): string => value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
		const lines = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<opml version="2.0"><head><title>UNreader 订阅</title></head><body>',
		];
		for (const feed of this.store.listFeeds()) {
			lines.push(
				`  <outline type="rss" text="${esc(feed.title)}" title="${esc(feed.title)}" xmlUrl="${esc(feed.feedUrl)}" htmlUrl="${esc(feed.siteUrl)}" />`,
			);
		}
		lines.push("</body></opml>");
		return lines.join("\n");
	}

	async refreshAll(force = false): Promise<FeedRefreshResult[]> {
		this.assertOpen();
		const feeds = this.store.listFeeds();
		const results: FeedRefreshResult[] = [];
		for (const feed of feeds) results.push(await this.refreshFeed(feed.id, force));
		return results;
	}

	async refreshFeed(feedId: string, force = false, ignoreBackoff = false): Promise<FeedRefreshResult> {
		this.assertOpen();
		const existing = this.inFlight.get(feedId);
		if (existing) return existing;
		const run = this.doRefresh(feedId, force, ignoreBackoff);
		this.inFlight.set(feedId, run);
		try {
			return await run;
		} finally {
			if (this.inFlight.get(feedId) === run) this.inFlight.delete(feedId);
		}
	}

	private async doRefresh(feedId: string, force: boolean, ignoreBackoff: boolean): Promise<FeedRefreshResult> {
		const feed = this.store.getFeed(feedId);
		if (!feed) return { feedId, addedOrUpdated: 0, notModified: false, error: "订阅不存在" };
		const retry = this.retryAt.get(feedId);
		if (!force && !ignoreBackoff && retry && retry.at > Date.now()) {
			return { feedId, addedOrUpdated: 0, notModified: false, error: `请求暂时退避中，${Math.ceil((retry.at - Date.now()) / 1000)} 秒后可重试` };
		}
		try {
			const { feed: parsed, response } = await fetchParsedFeed(feed);
			// 刷新期间用户可能删除了订阅；此时不能再把结果写回，否则会留下无索引的文章文件。
			if (!this.store.getFeed(feedId)) {
				return { feedId, addedOrUpdated: 0, notModified: false, error: "订阅已删除" };
			}
			if (response.notModified) {
				await this.store.updateFetchMetadata(feedId, {
					lastFetchedAt: Date.now(),
					lastError: null,
					etag: response.etag ?? feed.etag,
					lastModified: response.lastModified ?? feed.lastModified,
				});
				this.retryAt.delete(feedId);
				return { feedId, addedOrUpdated: 0, notModified: true, error: null };
			}
			const merged = await this.store.mergeFeedEntries(feedId, parsed.entries, this.limit());
			await this.store.updateFetchMetadata(feedId, {
				title: parsed.title || feed.title,
				siteUrl: parsed.siteUrl || feed.siteUrl,
				description: parsed.description || feed.description,
				lastFetchedAt: Date.now(),
				lastError: null,
				etag: response.etag,
				lastModified: response.lastModified,
			});
			this.retryAt.delete(feedId);
			return { feedId, addedOrUpdated: merged.length, notModified: false, error: null };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const attempt = (this.retryAt.get(feedId)?.attempt ?? 0) + 1;
			const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 6));
			this.retryAt.set(feedId, { at: Date.now() + delay, attempt });
			await this.store.updateFetchMetadata(feedId, { lastError: message }).catch(() => undefined);
			return { feedId, addedOrUpdated: 0, notModified: false, error: message };
		}
	}

	async fetchFulltext(feedId: string, entryId: string): Promise<FeedEntry | null> {
		this.assertOpen();
		const entry = this.store.getEntry(feedId, entryId);
		if (!entry?.url) throw new Error("这篇文章没有可抓取的原文地址");
		const html = await fetchPageForExtraction(entry.url);
		const extracted = extractFulltext(html, entry.url);
		return this.store.replaceEntryContent(feedId, entryId, extracted.html, extracted.hash);
	}

	private limit(): number {
		const value = Math.floor(this.getSettings().entryLimit);
		return Number.isFinite(value) ? Math.max(20, Math.min(2000, value)) : 200;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Feed 服务已关闭");
	}

	close(): void {
		this.closed = true;
		this.inFlight.clear();
		this.retryAt.clear();
	}
}

export type { ParsedOpmlFeed };
