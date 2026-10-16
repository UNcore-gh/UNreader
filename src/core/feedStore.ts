import { Vault, normalizePath } from "obsidian";
import type { FeedEntry, FeedEntryState, FeedEntryContentFile, FeedFileData, FeedIndexFile, FeedSubscription } from "../types";
import { FEEDS_FOLDER, FEEDS_LEGACY_CONTENT_FOLDER } from "./paths";
import type { ParsedFeedEntry } from "./feedParser";
import { emptyFeedEntryState, mergeFeedEntries, stableFeedId } from "./feedUtils";
import { evaluateFeedContentQuality, type FeedContentQuality } from "./feedContentQuality";

const INDEX_FILE = "index.json";
/** 订阅条目阅读进度的本机热缓存前缀（按库 scope 隔离）。 */
const FEED_HOT_PREFIX = "unreader-feed-pos-hot";
/** 元数据去抖写盘窗口：滚动/标读这类高频小状态更新合并成一次写，减少同步端的重传次数。 */
const METADATA_SAVE_DELAY_MS = 1500;
/** 孤儿正文清理的年龄门槛：比这更新的文件一律不删 —— 排除「清理与刷新并发」时
 *  误删刷新刚写进来的那一份（见 sweepOrphanContent 的安全闸③）。 */
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;
/** 正文文件/元数据迁移时的并行读取与写入批量。 */
const IO_CHUNK = 32;

function sanitizeIdPart(value: string): string {
	return value.replace(/[^a-z0-9_-]/gi, "_");
}

function feedFileName(feedId: string): string {
	return `${sanitizeIdPart(feedId)}.json`;
}

/** 序列化元数据用的瘦条目：把两块 HTML 大字段剥掉（正文按篇存在插件目录缓存里，见类头）。
 *  contentHash / contentSource / contentQuality / pendingContentHash 等小字段**必须留下**
 *  —— 刷新合并要在不读正文文件的情况下做内容裁决。 */
function stripEntryContent(entry: FeedEntry): FeedEntry {
	const { contentHtml: _content, pendingContentHtml: _pending, ...rest } = entry;
	return rest as FeedEntry;
}

/** 元数据持久化指纹：剥掉两块 HTML 与各处时间戳（stateUpdatedAt 会被每次刷新的
 *  incoming 空状态顶成 now；updatedAt 目前没有任何读取方、还会在刷新时被
 *  incoming 的值回写 —— 两者都不能参与"有没有实质变化"的判断），按 id 排序后
 *  整体字符串化。刷新前后指纹相同 ⇒ 这次刷新没有任何值得写盘的变化。 */
function persistenceFingerprint(map: Map<string, FeedEntry>): string {
	const rows = [...map.values()]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(entry => {
			const slim = stripEntryContent(entry);
			return { ...slim, updatedAt: 0, state: { ...slim.state, stateUpdatedAt: 0 } };
		});
	return JSON.stringify(rows);
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
		// 旧库没有这个字段 → 一律按「没保存过」读（与 starredAt 同一口径）。
		savedAt: typeof value.savedAt === "number" ? value.savedAt : null,
		openedAt: typeof value.openedAt === "number" ? value.openedAt : 0,
		position: value.position ?? null,
		audioPosition: value.audioPosition ?? null,
		hasAnnotations: value.hasAnnotations === true,
		stateUpdatedAt: typeof value.stateUpdatedAt === "number" ? value.stateUpdatedAt : base.stateUpdatedAt,
	};
}

function normalizeContentQuality(value: unknown, fallbackHtml: string, fulltext = false): FeedContentQuality {
	if (fulltext) return "full";
	if (value === "full" || value === "summary" || value === "empty") return value;
	return evaluateFeedContentQuality(fallbackHtml);
}

function normalizeEntry(value: Partial<FeedEntry>, feedId: string): FeedEntry | null {
	if (!value.id || !value.title) return null;
	const contentHtml = typeof value.contentHtml === "string" ? value.contentHtml : "";
	const contentSource = value.contentSource === "fulltext" ? "fulltext" as const : "feed" as const;
	const pendingContentHtml = typeof value.pendingContentHtml === "string" ? value.pendingContentHtml : undefined;
	const pendingContentSource = value.pendingContentSource === "fulltext" ? "fulltext" as const : value.pendingContentSource === "feed" ? "feed" as const : undefined;
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
		contentSource,
		contentHash: typeof value.contentHash === "string" ? value.contentHash : "",
		contentQuality: normalizeContentQuality(value.contentQuality, contentHtml, contentSource === "fulltext"),
		pendingContentHtml,
		pendingContentHash: typeof value.pendingContentHash === "string" ? value.pendingContentHash : undefined,
		pendingContentSource,
		pendingContentQuality: pendingContentHtml
			? normalizeContentQuality(value.pendingContentQuality, pendingContentHtml, pendingContentSource === "fulltext")
			: undefined,
		enclosure: value.enclosure ?? null,
		state: normalizeState(value.state),
	};
}

/**
 * RSS 订阅存储。落盘分两层（2026-09-29，为修「同步很久」）：
 *
 * - `Feeds/feed-<id>.json`：订阅元数据 + 每篇文章的标题/摘要/哈希/**阅读状态**（瘦文件，
 *   一两百 KB 量级）。标读、星标、阅读位置这类高频小更新只重写它（还有 1.5s 去抖合并）。
 * - **插件目录下的缓存**（2026-10-10 改落点）：单篇文章正文（含 pending），写粒度 = 篇，
 *   抓一次全文只动一篇文章的几 KB～几百 KB，刷新只写新文章的文件，不再是整库 MB 级重写。
 *
 * ## 正文为什么搬进插件目录（2026-10-10）
 *
 * 正文原来落在库内的 `Feeds/Content/`，代价是**用户在文件树里看到上千个文件**（实测
 * 1916 个，占整个插件数据 98%），而且这些文件还会被同步端逐个重传。但正文是**从网上
 * 抓来的、可再生的缓存** —— 换台设备重新刷新订阅就能拿到同样的内容，跨端本就没有价值。
 * 真正需要跨端的是「读到哪、哪些已读、哪些星标」这些状态，它们全在瘦元数据文件里。
 *
 * 所以正文落到**插件目录**（`.obsidian/plugins/unreader/cache/feeds/`，由 `main.ts` 从
 * `manifest.dir` 解析后注入）：点目录在 Obsidian 里不进索引、**文件树里根本不存在**，
 * 且官方 Sync 会整体跳过它（见 `core/exclusions.ts` 文件头对「真隐藏 = 不跨端」的论证）。
 * 这与图片/播客缓存走 IndexedDB（`feedMediaStore`，同样「不随库同步」）是同一个设计姿态；
 * 选插件目录而不是 IndexedDB 是因为它不需要改写读写层、也没有移动端配额风险。
 *
 * ⚠️ 落点**必须与数据根解耦**：切换「资料文件夹」时只搬 `Data/` 里的数据目录，缓存原地不动
 * （缓存不属于任何一份数据，留在插件目录里最不需要操心）。
 *
 * 配套口径：
 * - 旧落点（`Feeds/Content/`）由 `migrateLegacyContent` 在 init 时**一次性幂等搬走**：
 *   优先整目录 `adapter.rename`，失败退化为逐文件「先写新位置、再删旧文件」，绝不先删后写；
 *   搬完把手清理掉空掉的旧目录骨架（`pruneEmptyDir`）。
 * - 缓存藏在用户看不见的地方，所以**插件必须自己当清洁工**：`sweepOrphanContent` 清理
 *   没有对应条目的正文文件（裁剪/删除订阅时已即时清，这里是闪退后的兜底）。
 * - 无变化刷新**零写盘**（persistenceFingerprint 前后比对，旧实现每次刷新全量重写所有订阅）。
 * - 正文按需进内存：init 只读元数据（启动从 15MB 级解析降到 KB 级），后台分批水合；
 *   任何要读正文的入口（打开文章 / 存笔记 / 抓全文）先 `ensureEntryContent`。
 * - 未加载的条目 `contentHtml` 为空，**任何写正文文件的路径都必须先确认加载**，
 *   否则会用空正文盖掉盘上的真正文（writeEntryContent 里还有一道空正文保险）。
 * - 旧格式（正文内联在订阅文件里）在 init 时自动迁移：拆出正文文件 + 重写瘦元数据，
 *   迁移先写正文文件后改元数据，中途崩溃下次 init 会幂等重做，不丢数据。
 */
export class FeedStore {
	private feeds = new Map<string, FeedSubscription>();
	private entries = new Map<string, Map<string, FeedEntry>>();
	private initialized = false;
	/** 正文已进内存的条目（feedId → entryId 集合）。 */
	private loadedContent = new Map<string, Set<string>>();
	/** 每个订阅的正文水合任务；init 后台跑，ensureEntryContent 等它。 */
	private hydration = new Map<string, Promise<void>>();
	/** 元数据脏订阅集合 + 去抖计时器。 */
	private dirty = new Set<string>();
	private saveTimers = new Map<string, number>();
	/** 订阅级（索引）变更标记：flush 只在确实动过订阅列表时才重写 index.json。 */
	private indexDirty = false;

	/** `pluginDir` = 插件目录的**库内相对路径**（`.obsidian/plugins/unreader`），由 `main.ts`
	 *  从 `manifest.dir` 解析后注入 —— 正文缓存的落点由它派生，见 `contentRoot()`。
	 *  取不到时传 null（退回库内点目录兜底，功能不变，只是会随数据根搬家）。 */
	constructor(private vault: Vault, private scope = "default", private pluginDir: string | null = null) {}

	/** 正文缓存根（唯一事实源）：
	 *
	 *  - 有插件目录 → `<插件目录>/cache/feeds`（真隐藏 + 不参与同步 + 与数据根解耦，首选）；
	 *  - 否则 → `<数据根>/Data/Feeds/.content`（点目录，同样真隐藏、官方 Sync 也跳过，
	 *    只是会跟着数据根走）。
	 *
	 *  两者都以 `.` 开头或落在配置目录里 —— 这正是「用户看不见 + 不跨端」的来源，
	 *  见文件头「正文为什么搬进插件目录」。 */
	private contentRoot(): string {
		const base = this.pluginDir?.trim();
		return normalizePath(base ? `${base}/cache/feeds` : `${FEEDS_FOLDER}/.content`);
	}

	async init(): Promise<void> {
		this.feeds.clear();
		this.entries.clear();
		this.loadedContent.clear();
		this.hydration.clear();
		this.dirty.clear();
		this.indexDirty = false;
		for (const timer of this.saveTimers.values()) window.clearTimeout(timer);
		this.saveTimers.clear();
		const index = await this.readJson<Partial<FeedIndexFile>>(`${FEEDS_FOLDER}/${INDEX_FILE}`);
		for (const raw of Array.isArray(index?.feeds) ? index.feeds : []) {
			const feed = normalizeSubscription(raw);
			if (feed) this.feeds.set(feed.id, feed);
		}
		const loads = [...this.feeds.values()].map(async feed => {
			const data = await this.readJson<Partial<FeedFileData>>(`${FEEDS_FOLDER}/${feedFileName(feed.id)}`);
			const map = new Map<string, FeedEntry>();
			const inline = new Set<string>();
			for (const raw of Array.isArray(data?.entries) ? data.entries : []) {
				const entry = normalizeEntry(raw, feed.id);
				if (!entry) continue;
				this.mergeHotState(entry);
				map.set(entry.id, entry);
				// 元数据里还带着正文 = 旧格式，拆出去（迁移在 init 内 await，保证落盘一致）
				if (entry.contentHtml) inline.add(entry.id);
			}
			this.entries.set(feed.id, map);
			this.loadedContent.set(feed.id, inline);
			if (inline.size) await this.migrateInlineContent(feed.id, map, inline);
		});
		await Promise.all(loads);
		// 旧落点（`Feeds/Content/`）搬家：**必须排在正文水合之前** —— 否则水合会去新位置
		// 读还没搬过去的文件，全部读空。搬家本身幂等（见 migrateLegacyContent）。
		await this.migrateLegacyContent();
		this.initialized = true;
		// 正文水合不阻塞 init：列表/状态/刷新合并只需要元数据；打开文章走 ensureEntryContent。
		void Promise.all([...this.feeds.keys()].map(feedId => this.hydrateFeed(feedId)));
		// 缓存落在用户看不见的地方，所以孤儿清理只能由插件兜底（裁剪/删订阅已即时清，
		// 这里补闪退留下的残留）。不阻塞 init，失败静默。
		void this.sweepOrphanContent().catch(() => undefined);
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

	/** 打开文章 / 存笔记 / 抓全文之前调用：保证这篇的正文已从 Content 文件读进内存。 */
	async ensureEntryContent(feedId: string, entryId: string): Promise<FeedEntry | null> {
		const entry = this.getEntry(feedId, entryId);
		if (!entry) return null;
		if (this.loadedContent.get(feedId)?.has(entryId)) return entry;
		await this.hydrateFeed(feedId);
		if (this.loadedContent.get(feedId)?.has(entryId)) return entry;
		// 水合是按元数据逐篇找文件的；这里再兜一次单篇读取，覆盖水合后才落盘的边角。
		await this.readEntryContent(feedId, entry);
		return entry;
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
		this.loadedContent.set(id, new Set());
		this.indexDirty = true;
		await this.writeIndex();
		await this.writeFeed(id);
		return feed;
	}

	async removeSubscription(feedId: string): Promise<void> {
		if (!this.feeds.delete(feedId)) return;
		const map = this.entries.get(feedId);
		this.entries.delete(feedId);
		this.loadedContent.delete(feedId);
		this.hydration.delete(feedId);
		this.dirty.delete(feedId);
		const timer = this.saveTimers.get(feedId);
		if (timer) window.clearTimeout(timer);
		this.saveTimers.delete(feedId);
		this.indexDirty = true;
		await this.writeIndex();
		try {
			await this.vault.adapter.remove(normalizePath(`${FEEDS_FOLDER}/${feedFileName(feedId)}`));
		} catch { /* 文件可能尚未创建 */ }
		// 正文文件一并清掉，否则成为永久孤儿；顺手把空掉的缓存目录骨架也回收
		// （缓存在用户看不见的地方，留下的空目录没有任何人能看见 / 清理）
		if (map) {
			await Promise.all([...map.keys()].map(entryId =>
				this.vault.adapter.remove(this.entryContentPath(feedId, entryId)).catch(() => undefined)));
		}
		await this.pruneEmptyDir(this.contentDir(feedId));
	}

	async renameSubscription(feedId: string, title: string): Promise<void> {
		const feed = this.feeds.get(feedId);
		if (!feed) return;
		feed.title = title.trim() || feed.title;
		feed.updatedAt = Date.now();
		this.indexDirty = true;
		await Promise.all([this.writeIndex(), this.writeFeed(feedId)]);
	}

	/** 启用 / 停用订阅。停用只改索引里的一位（文章快照原样保留，随时可再启用）。 */
	async setSubscriptionEnabled(feedId: string, enabled: boolean): Promise<void> {
		const feed = this.feeds.get(feedId);
		if (!feed || feed.enabled === enabled) return;
		feed.enabled = enabled;
		feed.updatedAt = Date.now();
		this.indexDirty = true;
		await this.writeIndex();
	}

	async updateFetchMetadata(
		feedId: string,
		patch: Partial<Pick<FeedSubscription, "title" | "siteUrl" | "description" | "lastFetchedAt" | "lastError" | "etag" | "lastModified">>,
	): Promise<void> {
		const feed = this.feeds.get(feedId);
		if (!feed) return;
		Object.assign(feed, patch, { updatedAt: Date.now() });
		this.indexDirty = true;
		await this.writeIndex();
	}

	async mergeFeedEntries(feedId: string, parsed: ParsedFeedEntry[], limit: number): Promise<FeedEntry[]> {
		const map = this.entries.get(feedId) ?? new Map<string, FeedEntry>();
		const now = Date.now();
		const beforeFingerprint = persistenceFingerprint(map);
		const incoming: FeedEntry[] = parsed.map(item => ({
			...item,
			feedId,
			state: emptyFeedEntryState(now),
		}));
		const merged = mergeFeedEntries([...map.values()], incoming, limit);
		this.entries.set(feedId, new Map(merged.map(entry => [entry.id, entry])));

		// 正文文件只写真正变化的；被裁掉的条目把正文文件一并删掉（否则成为永久孤儿）。
		const loaded = this.loadedContent.get(feedId) ?? new Set<string>();
		this.loadedContent.set(feedId, loaded);
		const afterById = new Map(merged.map(entry => [entry.id, entry]));
		const contentWrites: FeedEntry[] = [];
		for (const [entryId, entry] of afterById) {
			const old = map.get(entryId);
			// 加载态记账：正文非空 = 内存里是真内容（网络新拿的 / 旧条目本来就加载过）。
			if (entry.contentHtml) loaded.add(entryId);
			else loaded.delete(entryId);
			const contentChanged = !old || old.contentHash !== entry.contentHash;
			const pendingChanged = !!old && (
				(old.pendingContentHash ?? null) !== (entry.pendingContentHash ?? null)
				|| !!entry.pendingContentHtml !== !!old.pendingContentHtml);
			if (contentChanged && entry.contentHtml) {
				contentWrites.push(entry);
			} else if (pendingChanged) {
				// 待处理正文变了但正文还没加载过：先读盘补齐，否则会把空正文写进文件。
				if (!loaded.has(entryId)) await this.readEntryContent(feedId, entry);
				if (loaded.has(entryId)) contentWrites.push(entry);
			}
		}
		await Promise.all(contentWrites.map(entry => this.writeEntryContent(feedId, entry).catch(() => undefined)));
		const removed = [...map.keys()].filter(entryId => !afterById.has(entryId));
		await Promise.all(removed.map(entryId =>
			this.vault.adapter.remove(this.entryContentPath(feedId, entryId)).catch(() => undefined)));

		// 合并（内容级、低频）立即落盘：崩溃不能丢掉刚刷新到的文章；去抖只留给
		// 高频的状态更新。无变化刷新在这里就被指纹拦截，不会产生任何写盘。
		if (persistenceFingerprint(afterById) !== beforeFingerprint) await this.writeFeed(feedId);
		return merged;
	}

	private nextStateUpdatedAt(previous: number): number {
		const now = Date.now();
		return now > previous ? now : previous + 1;
	}

	async updateEntryState(feedId: string, entryId: string, patch: Partial<FeedEntryState>): Promise<FeedEntry | null> {
		const entry = this.entries.get(feedId)?.get(entryId);
		if (!entry) return null;
		const next: FeedEntryState = {
			...entry.state,
			...patch,
			stateUpdatedAt: this.nextStateUpdatedAt(entry.state.stateUpdatedAt),
		};
		entry.state = next;
		entry.updatedAt = Math.max(entry.updatedAt, next.stateUpdatedAt);
		// 文件写是异步的；先把同一份状态同步写进本机热缓存，闪退时下一轮 init 能救回。
		this.hotWrite(feedId, entryId, next);
		this.scheduleFeedWrite(feedId);
		return entry;
	}

	/** 只更新内存 + 本机热缓存，不等待订阅文件写盘。
	 *  供阅读视图每次可信 relocate 调用，避免 800ms/异步写窗口里闪退丢位置。 */
	checkpointEntryState(feedId: string, entryId: string, patch: Partial<FeedEntryState>): void {
		const entry = this.entries.get(feedId)?.get(entryId);
		if (!entry) return;
		const next: FeedEntryState = {
			...entry.state,
			...patch,
			stateUpdatedAt: this.nextStateUpdatedAt(entry.state.stateUpdatedAt),
		};
		entry.state = next;
		entry.updatedAt = Math.max(entry.updatedAt, next.stateUpdatedAt);
		this.hotWrite(feedId, entryId, next);
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
				stateUpdatedAt: this.nextStateUpdatedAt(entry.state.stateUpdatedAt),
			};
			entry.state = next;
			entry.updatedAt = Math.max(entry.updatedAt, next.stateUpdatedAt);
			this.hotWrite(feedId, entryId, next);
			changed = true;
		}
		if (changed) this.scheduleFeedWrite(feedId);
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
		entry.contentQuality = "full";
		if (metadata?.title?.trim()) entry.title = metadata.title.trim();
		if (!entry.author && metadata?.author?.trim()) entry.author = metadata.author.trim();
		entry.pendingContentHtml = undefined;
		entry.pendingContentHash = undefined;
		entry.pendingContentSource = undefined;
		entry.pendingContentQuality = undefined;
		entry.updatedAt = Date.now();
		this.loadedContent.get(feedId)?.add(entryId);
		await this.writeEntryContent(feedId, entry);
		this.scheduleFeedWrite(feedId);
		return entry;
	}

	/** 完成一次正文更新：只有当前待处理哈希仍匹配时才提交，避免两个刷新结果互相覆盖。 */
	async commitPendingContent(feedId: string, entryId: string, expectedHash: string): Promise<FeedEntry | null> {
		const entry = this.entries.get(feedId)?.get(entryId);
		if (!entry || !entry.pendingContentHtml || entry.pendingContentHash !== expectedHash) return entry ?? null;
		entry.contentHtml = entry.pendingContentHtml;
		entry.contentHash = entry.pendingContentHash;
		entry.contentSource = entry.pendingContentSource ?? "feed";
		entry.contentQuality = entry.pendingContentQuality ?? evaluateFeedContentQuality(entry.contentHtml);
		entry.pendingContentHtml = undefined;
		entry.pendingContentHash = undefined;
		entry.pendingContentSource = undefined;
		entry.pendingContentQuality = undefined;
		entry.updatedAt = Date.now();
		this.loadedContent.get(feedId)?.add(entryId);
		await this.writeEntryContent(feedId, entry);
		this.scheduleFeedWrite(feedId);
		return entry;
	}

	/** 后台水合：把每个订阅的正文文件分批读进内存。失败按篇吞掉（文件缺失 = 本来就没有）。 */
	private hydrateFeed(feedId: string): Promise<void> {
		const existing = this.hydration.get(feedId);
		if (existing) return existing;
		const run = (async () => {
			const map = this.entries.get(feedId);
			if (!map) return;
			const loaded = this.loadedContent.get(feedId) ?? new Set<string>();
			this.loadedContent.set(feedId, loaded);
			const pending = [...map.values()].filter(entry => !loaded.has(entry.id));
			for (let i = 0; i < pending.length; i += IO_CHUNK) {
				await Promise.all(pending.slice(i, i + IO_CHUNK).map(entry => this.readEntryContent(feedId, entry)));
			}
		})();
		const guarded = run.catch(() => undefined);
		this.hydration.set(feedId, guarded);
		return guarded;
	}

	private async readEntryContent(feedId: string, entry: FeedEntry): Promise<boolean> {
		try {
			const raw = await this.vault.adapter.read(this.entryContentPath(feedId, entry.id));
			const data = JSON.parse(raw) as Partial<FeedEntryContentFile>;
			if (typeof data.contentHtml === "string" && data.contentHtml) entry.contentHtml = data.contentHtml;
			if (typeof data.pendingContentHtml === "string") entry.pendingContentHtml = data.pendingContentHtml;
			this.loadedContent.get(feedId)?.add(entry.id);
			return true;
		} catch {
			return false;
		}
	}

	private async writeEntryContent(feedId: string, entry: FeedEntry): Promise<void> {
		// 空正文不落盘也不覆盖：没东西可写时保住盘上可能已有的真正文
		if (!entry.contentHtml && !entry.pendingContentHtml) return;
		await this.ensureContentFolder(feedId);
		const payload: FeedEntryContentFile = {
			version: 1,
			contentHtml: entry.contentHtml,
			pendingContentHtml: entry.pendingContentHtml,
		};
		await this.vault.adapter.write(this.entryContentPath(feedId, entry.id), JSON.stringify(payload));
	}

	private contentDir(feedId: string): string {
		return normalizePath(`${this.contentRoot()}/${sanitizeIdPart(feedId)}`);
	}

	private entryContentPath(feedId: string, entryId: string): string {
		return normalizePath(`${this.contentDir(feedId)}/${sanitizeIdPart(entryId)}.json`);
	}

	/** 旧格式（正文内联在订阅文件里）→ 拆出每篇正文文件 + 重写瘦元数据。
	 *  先写正文文件再改元数据：中途崩溃时元数据还是旧格式，下次 init 幂等重做。 */
	private async migrateInlineContent(feedId: string, map: Map<string, FeedEntry>, inlineIds: Set<string>): Promise<void> {
		const entries = [...inlineIds].map(entryId => map.get(entryId)).filter((e): e is FeedEntry => !!e);
		for (let i = 0; i < entries.length; i += IO_CHUNK) {
			await Promise.all(entries.slice(i, i + IO_CHUNK).map(entry =>
				this.writeEntryContent(feedId, entry).catch(() => undefined)));
		}
		await this.writeFeed(feedId);
	}

	private hotKey(feedId: string, entryId: string): string {
		return `${FEED_HOT_PREFIX}:${encodeURIComponent(this.scope)}:${encodeURIComponent(feedId)}:${encodeURIComponent(entryId)}`;
	}

	private hotWrite(feedId: string, entryId: string, state: FeedEntryState): void {
		try {
			if (typeof window.localStorage === "undefined") return;
			window.localStorage.setItem(this.hotKey(feedId, entryId), JSON.stringify(state));
		} catch { /* 隐私模式 / 配额满：尽力而为，不打断主链 */ }
	}

	private hotRead(feedId: string, entryId: string): FeedEntryState | null {
		try {
			if (typeof window.localStorage === "undefined") return null;
			const raw = window.localStorage.getItem(this.hotKey(feedId, entryId));
			if (!raw) return null;
			return normalizeState(JSON.parse(raw) as Partial<FeedEntryState>);
		} catch {
			return null;
		}
	}

	private mergeHotState(entry: FeedEntry): void {
		const hot = this.hotRead(entry.feedId, entry.id);
		if (!hot || hot.stateUpdatedAt <= entry.state.stateUpdatedAt) return;
		entry.state = hot;
		entry.updatedAt = Math.max(entry.updatedAt, hot.stateUpdatedAt);
	}

	async flush(): Promise<void> {
		for (const timer of this.saveTimers.values()) window.clearTimeout(timer);
		this.saveTimers.clear();
		await Promise.all([...this.dirty].map(feedId => this.writeFeed(feedId).catch(() => undefined)));
		if (this.indexDirty && (this.feeds.size > 0 || this.initialized)) await this.writeIndex();
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

	/** 逐级建目录。`adapter.mkdir` 不递归、`vault.createFolder` 只在库内**可见**路径上可靠 ——
	 *  而正文现在落在插件目录（不进 vault 索引），所以一律用 adapter 逐级判 + 建。 */
	private async ensureDirs(path: string): Promise<void> {
		const parts = normalizePath(path).split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (await this.vault.adapter.exists(current)) continue;
			try { await this.vault.adapter.mkdir(current); } catch { /* 并发创建 */ }
		}
	}

	private async ensureContentFolder(feedId: string): Promise<void> {
		await this.ensureDirs(this.contentDir(feedId));
	}

	/** 旧落点 `Feeds/Content/` → 新缓存目录的**一次性幂等**搬家。
	 *
	 *  三条硬约束：
	 *  ① **先写后删**：整目录 rename 失败时退化到逐文件「目标写成功才删源」，任何一刻新位置
	 *     都保有已搬完的那一份；中途失败只是留下没搬完的文件，下次 init 接着搬。
	 *  ② **绝不合并、绝不覆盖**：目标已有同名文件时直接丢弃源（正文是可再生缓存）。
	 *  ③ **只搬旧目录里的文件**，用户的其它东西一律不碰；搬空后回收旧目录骨架。
	 *
	 *  旧目录不存在（新装 / 已搬完 / 本就落在新位置）时只做一次 `exists` 判断，零副作用。 */
	private async migrateLegacyContent(): Promise<void> {
		try {
			const legacy = normalizePath(FEEDS_LEGACY_CONTENT_FOLDER);
			const target = this.contentRoot();
			if (legacy === target) return;
			if (!(await this.vault.adapter.exists(legacy))) return;
			const slash = target.lastIndexOf("/");
			if (slash > 0) await this.ensureDirs(target.slice(0, slash));
			if (!(await this.vault.adapter.exists(target))) {
				try {
					await this.vault.adapter.rename(legacy, target);
					return;
				} catch { /* 个别平台不支持跨目录整树 rename，走逐文件兜底 */ }
			}
			await this.moveDirContents(legacy, target);
			await this.pruneEmptyDir(legacy);
		} catch {
			// 搬家失败绝不阻断 init（下次启动幂等重试）：没搬过去的那几篇正文读到空，
			// 列表与阅读状态不受影响（它们在瘦元数据里），正文重新抓一次即可。
		}
	}

	/** 逐层搬目录内容（`adapter.list` 递归）：每个文件都是「先落地成功，再删源」。 */
	private async moveDirContents(from: string, to: string): Promise<void> {
		const listed = await this.vault.adapter.list(from).catch(() => null);
		if (!listed) return;
		if (listed.files.length > 0) await this.ensureDirs(to);
		for (const file of listed.files) {
			const name = file.split("/").pop();
			if (!name) continue;
			const dest = `${to}/${name}`;
			try {
				if (await this.vault.adapter.exists(dest)) await this.vault.adapter.remove(file);
				else await this.vault.adapter.rename(file, dest);
			} catch {
				try {
					const raw = await this.vault.adapter.read(file);
					await this.vault.adapter.write(dest, raw);
					await this.vault.adapter.remove(file);
				} catch { /* 这一份留在原地，下次 init 再来 */ }
			}
		}
		for (const dir of listed.folders) {
			const name = dir.split("/").pop();
			if (name) await this.moveDirContents(dir, `${to}/${name}`);
		}
	}

	/** 自底向上删掉**空**目录（只删目录，一个文件都不碰）。返回「处理完之后是空的吗」。 */
	private async pruneEmptyDir(dir: string): Promise<boolean> {
		const listed = await this.vault.adapter.list(dir).catch(() => null);
		if (!listed || listed.files.length > 0) return false;
		let empty = true;
		for (const sub of listed.folders) {
			if (!(await this.pruneEmptyDir(sub))) empty = false;
		}
		if (!empty) return false;
		try {
			await this.vault.adapter.rmdir(dir, false);
			return true;
		} catch {
			return false; // 删不掉就留着空壳，不影响功能
		}
	}

	/** 清掉缓存里**没有对应条目**的正文文件（裁剪 / 删订阅已即时清过，这里是崩溃后的兜底）。
	 *
	 *  缓存落在用户看不见的地方、用户没法手动打扫，所以这层自洁是必须的。
	 *
	 *  安全闸（三个都不能少）：
	 *  ① 一个订阅都没加载出来（index 读失败 / 空库）→ **整体不清理**：那种状态下「所有条目」
	 *     看起来都像孤儿，真删了就是把用户的缓存全抹掉；
	 *  ② 只清**已加载出条目的**订阅目录，且只删文件名对不上任何条目 id 的 `.json`；
	 *  ③ **只删「够旧」的文件**：`mergeFeedEntries` 会在本函数并行期间写入新条目的正文，
	 *     现读 id 集合也拦不住「算完之后才写进来」的那一份 —— 用 mtime 年龄排除刚写的文件。 */
	private async sweepOrphanContent(): Promise<void> {
		if (this.feeds.size === 0) return;
		const listed = await this.vault.adapter.list(this.contentRoot()).catch(() => null);
		if (!listed) return; // 还没抓过正文 / 目录不存在
		const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
		const byDirName = new Map<string, string>();
		for (const feedId of this.feeds.keys()) byDirName.set(sanitizeIdPart(feedId), feedId);
		for (const dir of listed.folders) {
			const name = dir.split("/").pop();
			const feedId = name ? byDirName.get(name) : undefined;
			if (!feedId) continue; // 认不出的目录不动手
			const map = this.entries.get(feedId);
			if (!map || map.size === 0) continue; // 安全闸②
			const known = new Set([...map.keys()].map(sanitizeIdPart));
			const inner = await this.vault.adapter.list(dir).catch(() => null);
			if (!inner) continue;
			for (const file of inner.files) {
				const base = file.split("/").pop() ?? "";
				if (!base.toLowerCase().endsWith(".json")) continue;
				if (known.has(base.replace(/\.json$/i, ""))) continue;
				try {
					const stat = await this.vault.adapter.stat(file);
					if (!stat || stat.mtime > cutoff) continue; // 安全闸③
				} catch {
					continue; // 拿不到年龄就不删
				}
				await this.vault.adapter.remove(file).catch(() => undefined);
			}
		}
	}

	private scheduleFeedWrite(feedId: string): void {
		this.dirty.add(feedId);
		const timer = this.saveTimers.get(feedId);
		if (timer) window.clearTimeout(timer);
		this.saveTimers.set(feedId, window.setTimeout(() => {
			this.saveTimers.delete(feedId);
			void this.writeFeed(feedId).catch(() => undefined);
		}, METADATA_SAVE_DELAY_MS));
	}

	private async writeIndex(): Promise<void> {
		await this.ensureFolder();
		const payload: FeedIndexFile = {
			version: 1,
			feeds: this.listFeeds(),
			updatedAt: Date.now(),
		};
		await this.vault.adapter.write(normalizePath(`${FEEDS_FOLDER}/${INDEX_FILE}`), JSON.stringify(payload, null, "\t"));
		this.indexDirty = false;
	}

	/** 订阅元数据写盘（瘦格式，不含正文 HTML）。 */
	private async writeFeed(feedId: string): Promise<void> {
		await this.ensureFolder();
		const payload: FeedFileData = {
			version: 2,
			feedId,
			entries: this.listEntries(feedId).map(stripEntryContent),
			updatedAt: Date.now(),
		};
		await this.vault.adapter.write(
			normalizePath(`${FEEDS_FOLDER}/${feedFileName(feedId)}`),
			JSON.stringify(payload, null, "\t"),
		);
		this.dirty.delete(feedId);
	}
}
