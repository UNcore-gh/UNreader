import { TFile, Vault, normalizePath } from "obsidian";
import { annotationBookIdFromRaw, annotationBookLinkFromRaw, annotationFileFor } from "./annotationStore";
import { BOOK_IDENTITY_INDEX, IDENTITY_FOLDER, NOTES_FOLDER } from "./paths";
import { idleYield } from "./idle";

export interface BookIdentityRecord {
	id: string
	aliases: string[]
	displayName: string
	size: number
	mtime: number
	fingerprint: string | null
	/** 数据目录内笔记的相对 Notes/ 路径；null = 用户把笔记移到了库内其他位置。 */
	noteRelativePath: string | null
	notePath: string
	createdAt: number
	updatedAt: number
}

interface BookIdentityIndex {
	version: 2
	books: Record<string, BookIdentityRecord>
}

export interface ResolvedBookIdentity {
	record: BookIdentityRecord
	/** true = 本次通过内容指纹把新路径重新认回旧身份。 */
	recovered: boolean
	/** 可用来迁移旧进度文件的旧路径。 */
	recoveredFrom: string | null
	/** 有多个内容相同的候选，按“副本独立”规则没有自动合并。 */
	ambiguousRecovery: boolean
}

export interface BookIdentityPathChange {
	id: string
	oldPath: string
	newPath: string
}

function normalizeAliases(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return [...new Set(values.filter((value): value is string => typeof value === "string" && !!value).map(normalizePath))];
}

function normalizeRecord(value: unknown): BookIdentityRecord | null {
	const raw = value && typeof value === "object" ? value as Partial<BookIdentityRecord> : null;
	if (!raw || typeof raw.id !== "string" || !raw.id) return null;
	const aliases = normalizeAliases(raw.aliases);
	if (typeof raw.notePath !== "string" || !raw.notePath) return null;
	const inferredRelative = typeof raw.noteRelativePath === "string"
		? normalizePath(raw.noteRelativePath)
		: (() => {
			const marker = `/${DATA_NOTES_SUFFIX}/`;
			const index = normalizePath(raw.notePath).lastIndexOf(marker);
			return index >= 0 ? normalizePath(raw.notePath).slice(index + marker.length) : null;
		})();
	return {
		id: raw.id,
		aliases,
		displayName: typeof raw.displayName === "string" ? raw.displayName : "",
		size: typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : 0,
		mtime: typeof raw.mtime === "number" && Number.isFinite(raw.mtime) ? raw.mtime : 0,
		fingerprint: typeof raw.fingerprint === "string" && raw.fingerprint ? raw.fingerprint : null,
		noteRelativePath: inferredRelative,
		notePath: normalizePath(raw.notePath),
		createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
	};
}

const DATA_NOTES_SUFFIX = "Data/Notes";

function noteRelativePathOf(path: string): string | null {
	const root = normalizePath(NOTES_FOLDER);
	const normalized = normalizePath(path);
	if (!normalized.startsWith(`${root}/`)) return null;
	return normalized.slice(root.length + 1);
}

function notePathFromRelative(relativePath: string): string {
	return normalizePath(`${NOTES_FOLDER}/${relativePath}`);
}

function uniqueId(): string {
	const cryptoApi = typeof window !== "undefined" ? window.crypto : crypto;
	if (cryptoApi?.randomUUID) return `book-${cryptoApi.randomUUID()}`;
	const random = Math.random().toString(36).slice(2, 12);
	return `book-${Date.now().toString(36)}-${random}`;
}

function bytesHex(bytes: Uint8Array): string {
	return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 只在路径别名缺失时计算。正常开书不会走这里，因此不会给所有书增加读盘和哈希成本。
 * 浏览器支持 SubtleCrypto 时用 SHA-256；测试或老 WebView 用四个独立 FNV 流组成
 * 64 位后备值，仍比路径 hash 稳定且不受文件名变化影响。
 */
async function fingerprintBytes(buffer: ArrayBuffer, size: number): Promise<string> {
	const subtle = typeof window !== "undefined" ? window.crypto?.subtle : crypto?.subtle;
	if (subtle) {
		const digest = await subtle.digest("SHA-256", buffer);
		return `sha256:${bytesHex(new Uint8Array(digest))}`;
	}
	const bytes = new Uint8Array(buffer);
	const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
	for (let i = 0; i < bytes.length; i++) {
		const value = bytes[i]!;
		seeds[0] = Math.imul(seeds[0]! ^ value, 0x01000193);
		seeds[1] = Math.imul(seeds[1]! ^ (value + i), 0x85ebca6b);
		seeds[2] = Math.imul(seeds[2]! ^ (value + (i << 1)), 0xc2b2ae35);
		seeds[3] = Math.imul(seeds[3]! ^ (value + (i << 2)), 0x27d4eb2f);
	}
	return `fnv64:${seeds.map(seed => (seed >>> 0).toString(16).padStart(8, "0")).join("")}:${size}`;
}

export class BookIdentityStore {
	private books = new Map<string, BookIdentityRecord>();
	private byAlias = new Map<string, string>();
	/** 并发首次解析同名书时，先占住将要使用的笔记路径，避免两个调用同时选中同一份。 */
	private reservedNotes = new Set<string>();
	private initPromise: Promise<void> | null = null;
	private writeChain: Promise<void> = Promise.resolve();
	private corruptRaw: string | null = null;
	private migratedSchema = false;

	constructor(private vault: Vault) {}

	init(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.load();
		return this.initPromise;
	}

	private async load(): Promise<void> {
		this.books.clear();
		this.byAlias.clear();
		this.reservedNotes.clear();
		this.corruptRaw = null;
		this.migratedSchema = false;
		const file = this.vault.getFileByPath(BOOK_IDENTITY_INDEX);
		if (!file) return;
		try {
			const raw = await this.vault.read(file);
			const parsed = JSON.parse(raw) as { version?: number; books?: unknown };
			if ((parsed.version !== 1 && parsed.version !== 2) || !parsed.books || typeof parsed.books !== "object") {
				throw new Error("unsupported identity index");
			}
			for (const value of Object.values(parsed.books)) {
				const record = normalizeRecord(value);
				if (record) {
					const normalized = noteRelativePathOf(record.notePath);
					if (record.noteRelativePath == null && normalized) record.noteRelativePath = normalized;
					if (parsed.version === 1 || record.notePath !== this.runtimeNotePath(record)) this.migratedSchema = true;
					this.put(record);
				}
			}
			if (this.migratedSchema) this.scheduleWrite();
		} catch (error) {
			// 索引损坏不能让阅读器整体不可用。保留损坏原文，第一次真正写入身份时先备份。
			this.corruptRaw = await this.vault.read(file).catch(() => "");
			console.error("[UNreader] 书籍身份索引读取失败；本次先使用临时身份", error);
		}
	}

	private put(record: BookIdentityRecord): void {
		if (record.noteRelativePath != null) record.notePath = this.runtimeNotePath(record);
		this.books.set(record.id, record);
		for (const alias of record.aliases) this.byAlias.set(alias, record.id);
	}

	private runtimeNotePath(record: BookIdentityRecord): string {
		return record.noteRelativePath == null ? record.notePath : notePathFromRelative(record.noteRelativePath);
	}

	private recordForAlias(path: string): BookIdentityRecord | null {
		const id = this.byAlias.get(normalizePath(path));
		return id ? this.books.get(id) ?? null : null;
	}

	private aliasExists(path: string): boolean {
		return !!this.vault.getFileByPath(normalizePath(path));
	}

	private async chooseNotePath(file: TFile, id: string, recovered: BookIdentityRecord | null): Promise<string> {
		if (recovered?.notePath) return this.runtimeNotePath(recovered);
		const legacy = annotationFileFor(file);
		const alreadyClaimed = this.reservedNotes.has(legacy)
			|| [...this.books.values()].some(record => record.id !== id && record.notePath === legacy);
		if (alreadyClaimed) return annotationFileFor(file, id);
		const existing = this.vault.getFileByPath(legacy);
		if (!existing) {
			this.reservedNotes.add(legacy);
			return legacy;
		}
		try {
			const raw = await this.vault.read(existing);
			const linkedId = annotationBookIdFromRaw(raw);
			const linkedPath = annotationBookLinkFromRaw(raw);
			if (linkedId === id || (!linkedId && (!linkedPath || normalizePath(linkedPath) === file.path))) {
				// 两次 resolve 可能都通过了入口判据并在 read 处交错；落点必须再抢一次。
				const claimedAfterRead = this.reservedNotes.has(legacy)
					|| [...this.books.values()].some(record => record.id !== id && record.notePath === legacy);
				if (!claimedAfterRead) {
					this.reservedNotes.add(legacy);
					return legacy;
				}
			}
		} catch {
			// 读不到旧笔记时保留旧路径：读取层会明确报错，绝不再造一份空笔记顶替。
			const claimedAfterRead = this.reservedNotes.has(legacy)
				|| [...this.books.values()].some(record => record.id !== id && record.notePath === legacy);
			if (!claimedAfterRead) {
				this.reservedNotes.add(legacy);
				return legacy;
			}
		}
		return annotationFileFor(file, id);
	}

	getKnown(path: string): BookIdentityRecord | null {
		return this.recordForAlias(path);
	}

	getNotePath(path: string): string | null {
		const record = this.recordForAlias(path);
		return record ? this.runtimeNotePath(record) : null;
	}

	/** 是否存在“旧路径已全部消失”的身份；只有这时才值得在开书前做指纹恢复。 */
	hasLostAliases(): boolean {
		return [...this.books.values()].some(record =>
			// 没有指纹的旧身份无法按内容认回；仍然预读整本只会白付一次性能成本。
			record.fingerprint != null
			&& record.aliases.length > 0
			&& record.aliases.every(alias => !this.aliasExists(alias)),
		);
	}

	async resolve(file: TFile, buffer?: ArrayBuffer): Promise<ResolvedBookIdentity> {
		await this.init();
		const exact = this.recordForAlias(file.path);
		if (exact) {
			if (exact.size !== file.stat.size || exact.mtime !== file.stat.mtime || exact.displayName !== file.basename) {
				exact.size = file.stat.size;
				exact.mtime = file.stat.mtime;
				exact.displayName = file.basename;
				exact.updatedAt = Date.now();
				this.scheduleWrite();
			}
			return { record: exact, recovered: false, recoveredFrom: null, ambiguousRecovery: false };
		}

		const digest = buffer
			? await fingerprintBytes(buffer, file.stat.size)
			: null;
		const candidates = [...this.books.values()].filter(record =>
			digest != null
			&& record.fingerprint === digest
			&& record.size === file.stat.size
			&& record.aliases.every(alias => !this.aliasExists(alias)),
		);
		if (candidates.length === 1) {
			const record = candidates[0]!;
			const recoveredFrom = record.aliases[0] ?? null;
			record.aliases = [...new Set([...record.aliases, file.path])];
			record.displayName = file.basename;
			record.mtime = file.stat.mtime;
			record.updatedAt = Date.now();
			this.put(record);
			this.scheduleWrite();
			return { record, recovered: true, recoveredFrom, ambiguousRecovery: false };
		}

		const id = uniqueId();
		const notePath = await this.chooseNotePath(file, id, null);
		const noteRelativePath = noteRelativePathOf(notePath);
		const record: BookIdentityRecord = {
			id,
			aliases: [file.path],
			displayName: file.basename,
			size: file.stat.size,
			mtime: file.stat.mtime,
			fingerprint: digest,
			noteRelativePath,
			notePath,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.put(record);
		this.scheduleWrite();
		return { record, recovered: false, recoveredFrom: null, ambiguousRecovery: candidates.length > 1 };
	}

	/** 首屏已经显示后再补指纹，失败只重试下一次同名恢复，不阻断阅读。 */
	async ensureFingerprint(file: TFile, id: string, buffer: ArrayBuffer): Promise<void> {
		const record = this.books.get(id);
		if (!record || record.fingerprint) return;
		await idleYield();
		if (!this.books.has(id) || record.fingerprint) return;
		record.fingerprint = await fingerprintBytes(buffer, file.stat.size);
		record.updatedAt = Date.now();
		this.scheduleWrite();
	}

	/** 文件或文件夹 rename：全部旧别名按前缀重映射。 */
	remap(oldPath: string, newPath: string): BookIdentityPathChange[] {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (!from || !to || from === to) return [];
		const changed: BookIdentityPathChange[] = [];
		for (const record of this.books.values()) {
			const paths: BookIdentityPathChange[] = [];
			const next = [...new Set(record.aliases.map(alias => {
				const mapped = alias === from ? to : alias.startsWith(`${from}/`) ? `${to}${alias.slice(from.length)}` : alias;
				if (mapped !== alias) paths.push({ id: record.id, oldPath: alias, newPath: mapped });
				return mapped;
			}))];
			if (JSON.stringify(next) !== JSON.stringify(record.aliases)) {
				for (const alias of record.aliases) if (this.byAlias.get(alias) === record.id) this.byAlias.delete(alias);
				record.aliases = next;
				record.displayName = (next[0] ?? record.displayName).split("/").pop()?.replace(/\.[^.]+$/, "") ?? record.displayName;
				record.updatedAt = Date.now();
				this.put(record);
				changed.push(...paths);
			}
		}
		if (changed.length) this.scheduleWrite();
		return changed;
	}

	remapNotePath(oldPath: string, newPath: string): boolean {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (!from || !to || from === to) return false;
		let changed = false;
		for (const record of this.books.values()) {
			const current = this.runtimeNotePath(record);
			const mapped = current === from
				? to
				: current.startsWith(`${from}/`)
					? `${to}${current.slice(from.length)}`
					: current;
			if (mapped === current) continue;
			record.notePath = mapped;
			record.noteRelativePath = noteRelativePathOf(mapped);
			record.updatedAt = Date.now();
			changed = true;
		}
		if (changed) this.scheduleWrite();
		return changed;
	}

	/** 文件/文件夹删除时只摘路径别名；身份记录留在索引里，文件恢复后仍可按指纹认回。 */
	detach(path: string): void {
		const from = normalizePath(path);
		let changed = false;
		for (const record of this.books.values()) {
			const next = record.aliases.filter(alias => alias !== from && !alias.startsWith(`${from}/`));
			if (next.length === record.aliases.length) continue;
			for (const alias of record.aliases) if (this.byAlias.get(alias) === record.id) this.byAlias.delete(alias);
			record.aliases = next;
			record.updatedAt = Date.now();
			changed = true;
		}
		if (changed) this.scheduleWrite();
	}

	async flush(): Promise<void> {
		if (this.migratedSchema) {
			this.migratedSchema = false;
			this.scheduleWrite();
		}
		await this.writeChain;
	}

	private scheduleWrite(): void {
		this.writeChain = this.writeChain.catch(() => undefined).then(() => this.writeNow());
	}

	private async writeNow(): Promise<void> {
		const dir = IDENTITY_FOLDER;
		if (!this.vault.getAbstractFileByPath(dir)) {
			try { await this.vault.createFolder(dir); } catch { /* 并发创建 */ }
		}
		if (this.corruptRaw) {
			const backup = normalizePath(`${IDENTITY_FOLDER}/books.corrupt-${Date.now()}.json`);
			await this.vault.adapter.write(backup, this.corruptRaw).catch(() => undefined);
			this.corruptRaw = null;
		}
		const current = this.vault.getFileByPath(BOOK_IDENTITY_INDEX);
		if (current) {
			const previous = await this.vault.read(current).catch(() => "");
			if (previous) await this.vault.adapter.write(`${BOOK_IDENTITY_INDEX}.bak`, previous).catch(() => undefined);
		}
		const payload: BookIdentityIndex = {
			version: 2,
			books: Object.fromEntries([...this.books.entries()].sort(([a], [b]) => a.localeCompare(b))),
		};
		await this.vault.adapter.write(BOOK_IDENTITY_INDEX, JSON.stringify(payload, null, "\t"));
	}
}
