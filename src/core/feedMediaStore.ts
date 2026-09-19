import { requestUrl } from "obsidian";
import { normalizeHttpUrl, stableHash } from "./feedUtils";

interface MediaRecord {
	key: string
	url: string
	type: string
	blob: Blob
	size: number
	updatedAt: number
}

const DB_NAME = "unreader-feed-media";
const STORE = "media";
const IMAGE_LIMIT = 12 * 1024 * 1024;
const MEDIA_LIMIT = 1024 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("无法打开 RSS 媒体缓存"));
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("RSS 媒体缓存写入失败"));
		tx.onabort = () => reject(tx.error ?? new Error("RSS 媒体缓存写入中止"));
	});
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("RSS 媒体缓存读取失败"));
	});
}

export class FeedMediaStore {
	private sessionUrls = new Map<string, string>();
	private memory = new Map<string, MediaRecord>();

	constructor(private limits?: () => { imageCacheMb: number; mediaCacheMb: number }) {}

	async get(url: string): Promise<Blob | null> {
		const key = stableHash(url);
		const mem = this.memory.get(key);
		if (mem) {
			await this.touch(mem);
			return mem.blob;
		}
		try {
			const db = await openDb();
			const tx = db.transaction(STORE, "readwrite");
			const done = txDone(tx);
			const store = tx.objectStore(STORE);
			const record = await requestResult(store.get(key) as IDBRequest<MediaRecord | undefined>);
			if (record?.blob) {
				record.updatedAt = Date.now();
				store.put(record);
			}
			await done;
			db.close();
			if (record?.blob) {
				this.memory.set(key, record);
				return record.blob;
			}
		} catch { /* IndexedDB 不可用时退回网络 */ }
		return null;
	}

	/** 访问命中时刷新 LRU 时间；缓存写失败时仍保留内存读取结果。 */
	private async touch(record: MediaRecord): Promise<void> {
		record.updatedAt = Date.now();
		this.memory.set(record.key, record);
		try {
			const db = await openDb();
			const tx = db.transaction(STORE, "readwrite");
			const done = txDone(tx);
			tx.objectStore(STORE).put(record);
			await done;
			db.close();
		} catch { /* IndexedDB 不可用时仅保留本次会话内存缓存 */ }
	}

	/** 同步判断当前会话中是否已有缓存；用于侧栏按钮初值，不等待 IndexedDB。 */
	isCached(url: string): boolean {
		return this.memory.has(stableHash(url)) || this.sessionUrls.has(stableHash(url));
	}

	/** 异步查询持久化缓存；用于侧栏显示重启前已经下载的播客。 */
	async has(url: string): Promise<boolean> {
		if (this.isCached(url)) return true;
		const key = stableHash(url);
		try {
			const db = await openDb();
			const tx = db.transaction(STORE, "readonly");
			const record = await requestResult(tx.objectStore(STORE).get(key) as IDBRequest<MediaRecord | undefined>);
			db.close();
			return !!record?.blob;
		} catch {
			return false;
		}
	}

	async put(url: string, blob: Blob, type = blob.type): Promise<void> {
		const key = stableHash(url);
		const record: MediaRecord = { key, url, type, blob, size: blob.size, updatedAt: Date.now() };
		this.memory.set(key, record);
		try {
			const db = await openDb();
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(record);
			await txDone(tx);
			db.close();
			await this.prune(type);
		} catch { /* 缓存失败不影响在线播放 */ }
	}

	async fetchAndPut(url: string, limit = IMAGE_LIMIT): Promise<Blob | null> {
		if (limit <= 0) return null;
		const cached = await this.get(url);
		if (cached) return cached;
		try {
			const response = await requestUrl({ url, throw: false });
			if (response.status >= 400 || response.arrayBuffer.byteLength > limit) return null;
			const type = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "application/octet-stream";
			const blob = new Blob([response.arrayBuffer], { type });
			await this.put(url, blob, type);
			return blob;
		} catch {
			return null;
		}
	}

	async objectUrl(url: string, allowFetch = true, limit = IMAGE_LIMIT): Promise<string> {
		const key = stableHash(url);
		const existing = this.sessionUrls.get(key);
		if (existing) return existing;
		const blob = allowFetch ? await this.fetchAndPut(url, limit) : await this.get(url);
		if (!blob) return url;
		const objectUrl = URL.createObjectURL(blob);
		this.sessionUrls.set(key, objectUrl);
		return objectUrl;
	}

	async playableUrl(url: string): Promise<string> {
		return this.objectUrl(url, false, MEDIA_LIMIT);
	}

	async downloadMedia(url: string, maxBytes = MEDIA_LIMIT): Promise<boolean> {
		if (maxBytes <= 0) return false;
		return !!(await this.fetchAndPut(url, maxBytes));
	}

	async prepareArticleHtml(html: string, baseUrl: string, cacheImages: boolean): Promise<string> {
		const doc = new DOMParser().parseFromString(html, "text/html");
		// `srcset` 会让浏览器绕过已经换成 blob URL 的 `src`，继续直连远程图片。
		// picture/source 的分支无法逐候选安全缓存，因此缓存图片时统一回退到 img.src。
		if (cacheImages) {
			for (const source of Array.from(doc.querySelectorAll<HTMLSourceElement>("picture source"))) source.remove();
			for (const image of Array.from(doc.querySelectorAll<HTMLImageElement>("img[srcset]"))) {
				image.removeAttribute("srcset");
				image.removeAttribute("sizes");
			}
		}
		const targets = Array.from(doc.querySelectorAll<HTMLElement>("img[src], audio[src], video[src], video[poster]"));
		await Promise.all(targets.map(async element => {
			const attr = element.tagName === "VIDEO" && element.hasAttribute("poster") ? "poster" : "src";
			const raw = element.getAttribute(attr) ?? "";
			const url = normalizeHttpUrl(raw, baseUrl);
			if (!url) return;
			const isAudio = element.tagName === "AUDIO" || element.tagName === "VIDEO";
			if (isAudio) {
				const playable = await this.playableUrl(url);
				element.setAttribute(attr, playable);
				return;
			}
			if (!cacheImages) return;
			const cached = await this.objectUrl(url, true, IMAGE_LIMIT);
			element.setAttribute(attr, cached);
		}));
		return doc.body.innerHTML;
	}

	private cacheLimitBytes(type: string): number {
		const limits = this.limits?.() ?? { imageCacheMb: 100, mediaCacheMb: 500 };
		const isMedia = /^(?:audio|video)\//i.test(type) || type === "application/octet-stream";
		const mb = isMedia ? limits.mediaCacheMb : limits.imageCacheMb;
		return Math.max(0, Number(mb) || 0) * 1024 * 1024;
	}

	private async prune(incomingType: string): Promise<void> {
		const maxBytes = this.cacheLimitBytes(incomingType);
		try {
			const db = await openDb();
			const tx = db.transaction(STORE, "readonly");
			const records = await requestResult(tx.objectStore(STORE).getAll() as IDBRequest<MediaRecord[]>);
			db.close();
			const mediaKind = (type: string): boolean => /^(?:audio|video)\//i.test(type) || type === "application/octet-stream";
			const sameKind = records.filter(record => mediaKind(record.type) === mediaKind(incomingType));
			if (maxBytes <= 0) {
				await this.deleteRecords(sameKind);
				return;
			}
			let total = sameKind.reduce((sum, record) => sum + (record.size || 0), 0);
			if (total <= maxBytes) return;
			sameKind.sort((a, b) => a.updatedAt - b.updatedAt);
			const remove: MediaRecord[] = [];
			for (const record of sameKind) {
				if (total <= maxBytes) break;
				remove.push(record);
				total -= record.size || 0;
			}
			await this.deleteRecords(remove);
		} catch { /* IndexedDB 不可用时无需淘汰 */ }
	}

	private async deleteRecords(records: MediaRecord[]): Promise<void> {
		if (!records.length) return;
		try {
			const deleteDb = await openDb();
			const deleteTx = deleteDb.transaction(STORE, "readwrite");
			const store = deleteTx.objectStore(STORE);
			for (const record of records) {
				store.delete(record.key);
				this.memory.delete(record.key);
				const objectUrl = this.sessionUrls.get(record.key);
				if (objectUrl) {
					try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
					this.sessionUrls.delete(record.key);
				}
			}
			await txDone(deleteTx);
			deleteDb.close();
		} catch { /* IndexedDB 不可用时仅清理内存态 */ }
	}

	async clear(): Promise<void> {
		this.releaseSessionUrls();
		this.memory.clear();
		try {
			const db = await openDb();
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).clear();
			await txDone(tx);
			db.close();
		} catch { /* ignore */ }
	}

	releaseSessionUrls(): void {
		for (const url of this.sessionUrls.values()) {
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
		}
		this.sessionUrls.clear();
	}
}
