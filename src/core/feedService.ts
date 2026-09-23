import type { FeedEntry, FeedSettings } from "../types";
import { extractFulltext, mergeExtractedArticles, type ExtractedArticle } from "./articleExtractor";
import { fetchPageForExtraction, fetchParsedFeed, resolveFeedInput, type FeedResolution } from "./feedFetcher";
import type { FeedStore } from "./feedStore";
import { parseOpml, type ParsedOpmlFeed } from "./feedParser";
import { entryFeedContentQuality } from "./feedContentQuality";
import { stripHtml } from "./feedUtils";

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
/** 多页文章最多接几页、单页正文下限（低于此长度视为"抓错了/抓到了列表页"）。 */
const MAX_FULLTEXT_PAGES = 3;
const MIN_CONTINUATION_LENGTH = 200;
/** 合并后正文的兜底上限：防止被"永远有下一页"的站点拖着无限抓。 */
const MAX_FULLTEXT_TEXT_LENGTH = 300_000;
/** 自动抓全文失败的安静期；避免用户每次点开同一篇都重复打一次站点。 */
const AUTO_FULLTEXT_RETRY_MS = 10 * 60_000;
/** 自动模式下的收益门槛：网页提取结果至少要比 Feed 摘要明显更长才替换。 */
const AUTO_FULLTEXT_MIN_GAIN_RATIO = 1.2;
const AUTO_FULLTEXT_MIN_TEXT_LENGTH = 240;

export interface FeedRefreshResult {
	feedId: string
	addedOrUpdated: number
	notModified: boolean
	error: string | null
}

/** Feed 网络与合并服务。所有方法只在用户显式操作或打开文章时调用。 */
export class FeedService {
	private inFlight = new Map<string, Promise<FeedRefreshResult>>();
	private fulltextInFlight = new Map<string, Promise<FeedEntry | null>>();
	private autoFulltextFailures = new Map<string, number>();
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

	/** 启用 / 停用订阅。停用时清掉退避计时器，重新启用后立即可刷新。 */
	async setSubscriptionEnabled(feedId: string, enabled: boolean): Promise<void> {
		this.assertOpen();
		if (!enabled) this.retryAt.delete(feedId);
		await this.store.setSubscriptionEnabled(feedId, enabled);
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
		// 停用的订阅不参与批量刷新（单条 refreshFeed 仍可显式调用，方便「启用前先试一把」）
		const feeds = this.store.listFeeds().filter(feed => feed.enabled !== false);
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

	/** Feed 只给标题/摘要时，打开文章自动走网页兜底。失败后短暂退避，
	 *  且提取结果必须明显比摘要更丰富，避免把广告/验证页缓存成“全文”。 */
	async autoFetchFulltext(feedId: string, entryId: string): Promise<FeedEntry | null> {
		this.assertOpen();
		const entry = this.store.getEntry(feedId, entryId);
		if (!entry) return null;
		if (this.getSettings().autoFulltext === false) return entry;
		if (!this.needsFulltext(entry)) return entry;
		const key = `${feedId}:${entryId}`;
		const failedAt = this.autoFulltextFailures.get(key) ?? 0;
		if (Date.now() - failedAt < AUTO_FULLTEXT_RETRY_MS) return entry;
		try {
			const updated = await this.fetchFulltext(feedId, entryId, { auto: true });
			// 提取结果不够丰富时 doFetchFulltext 不落盘，但也不能让每次打开都重新打站点。
			if (updated && this.needsFulltext(updated)) this.autoFulltextFailures.set(key, Date.now());
			else this.autoFulltextFailures.delete(key);
			return updated ?? entry;
		} catch {
			this.autoFulltextFailures.set(key, Date.now());
			return entry;
		}
	}

	needsFulltext(entry: FeedEntry): boolean {
		return entry.kind === "article"
			&& !!entry.url
			&& entry.contentSource !== "fulltext"
			&& entryFeedContentQuality(entry) !== "full";
	}

	async fetchFulltext(feedId: string, entryId: string, options?: { auto?: boolean }): Promise<FeedEntry | null> {
		this.assertOpen();
		const key = `${feedId}:${entryId}`;
		const running = this.fulltextInFlight.get(key);
		if (running) return running;
		const run = this.doFetchFulltext(feedId, entryId, options);
		this.fulltextInFlight.set(key, run);
		try {
			return await run;
		} finally {
			if (this.fulltextInFlight.get(key) === run) this.fulltextInFlight.delete(key);
		}
	}

	private async doFetchFulltext(feedId: string, entryId: string, options?: { auto?: boolean }): Promise<FeedEntry | null> {
		const entry = this.store.getEntry(feedId, entryId);
		if (!entry?.url) throw new Error("这篇文章没有可抓取的原文地址");
		const extracted = await this.collectFulltext(entry.url);
		// 自动兜底必须比已有摘要“值得换”；手动点“全文”仍按用户意图直接替换。
		if (options?.auto) {
			const beforeLength = stripHtml(entry.contentHtml || entry.summary).length;
			if (extracted.text.length < AUTO_FULLTEXT_MIN_TEXT_LENGTH
				|| extracted.text.length < beforeLength * AUTO_FULLTEXT_MIN_GAIN_RATIO) {
				return entry;
			}
		}
		return this.store.replaceEntryContent(feedId, entryId, extracted.html, extracted.hash, {
			title: extracted.title,
			author: extracted.byline,
		});
	}

	/** 抓正文：首页，外加同一篇文章的续页（判定见 articleExtractor.findNextPageUrl —— 只认
	 *  `/slug` → `/slug/2` 与"仅差分页参数"两种形态，不会把"下一篇推荐文章"接进来）。
	 *  续页任何一步失败都只是**提前收工**，不影响首页已抓到的正文。 */
	private async collectFulltext(url: string): Promise<ExtractedArticle> {
		const pages: ExtractedArticle[] = [extractFulltext(await fetchPageForExtraction(url), url)];
		const visited = new Set<string>([url]);
		let total = pages[0]!.text.length;
		while (pages.length < MAX_FULLTEXT_PAGES && total < MAX_FULLTEXT_TEXT_LENGTH) {
			const next = pages[pages.length - 1]!.nextPageUrl;
			if (!next || visited.has(next)) break;
			visited.add(next);
			let page: ExtractedArticle;
			try {
				page = extractFulltext(await fetchPageForExtraction(next), next);
			} catch {
				break;
			}
			const previous = pages[pages.length - 1]!.text;
			// 三道防呆：续页太短（抓到列表页/空页）、与上一页重复（站点把全文放回首页）、
			// 明显小于首页的一个零头（抓到了"相关阅读"）。
			if (page.text.length < MIN_CONTINUATION_LENGTH) break;
			if (previous.includes(page.text.slice(0, 60))) break;
			if (page.text.length < previous.length * 0.15) break;
			pages.push(page);
			total += page.text.length;
		}
		return mergeExtractedArticles(pages);
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
		this.fulltextInFlight.clear();
		this.autoFulltextFailures.clear();
		this.retryAt.clear();
	}
}

export type { ParsedOpmlFeed };
