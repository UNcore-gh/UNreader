import { TFile, TFolder, Vault } from "obsidian";
import { FONTS_FOLDER, IMAGES_FOLDER, RESOURCE_MANIFEST, RESOURCES_FOLDER } from "./paths";

const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);
const SHARED_IMAGE_PREFIX = "shared:image/";

export type SharedResourceKind = "font" | "image";

export interface SharedResource {
	/** 持久化引用：字体为兼容历史的 `custom:<path>`，图片为 `shared:image/<file>` */
	id: string;
	kind: SharedResourceKind;
	name: string;
	path: string;
	enabled: boolean;
	hash?: string;
}

interface ManifestEntry {
	name?: string;
	enabled?: boolean;
	hash?: string;
}

interface ResourceManifest {
	version: 1;
	resources: Record<string, ManifestEntry>;
}

export interface ImageImport {
	name: string;
	ext: string;
	buf?: ArrayBuffer;
	read?: () => Promise<ArrayBuffer>;
	sourcePath?: string;
}

interface ImageBytes {
	buf: ArrayBuffer;
	ext: string;
	name: string;
}

let activeStore: ResourceStore | null = null;

/** 引擎解析外观中的共享资源引用时走这里（同步；资源初始化后才有 URL）。 */
export function resolveResourceReference(ref: string | null | undefined): string {
	const value = (ref ?? "").trim();
	if (!value) return "";
	if (!value.startsWith(SHARED_IMAGE_PREFIX)) return value;
	return activeStore?.resolve(value) ?? value;
}

/** 资源是否允许当前设备使用。资源库尚未就绪时按启用处理，避免启动竞态把旧配置误判为停用。 */
export function isResourceEnabled(id: string | null | undefined): boolean {
	return activeStore?.isEnabled(id) ?? true;
}

export function setActiveResourceStore(store: ResourceStore | null): void {
	activeStore = store;
}

export function isSharedImageReference(ref: string | null | undefined): boolean {
	return !!ref && ref.trim().startsWith(SHARED_IMAGE_PREFIX);
}

/**
 * 库内共享资源收纳。
 *
 * 资源本体（字体/图片）只落在一处并随库同步；外观预设与各设备配置只保存引用。
 * 因此：
 *  - 同一张图可被多个预设同时引用，不再在每个预设文件夹复制一份；
 *  - A 设备导入后，B 设备同步到文件即可使用；
 *  - 当前设备的外观、启用的预设仍由 data.json/localStorage 管理，不会随资源索引同步。
 */
export class ResourceStore {
	private entries = new Map<string, SharedResource>();
	private imageUrls = new Map<string, string>();
	private manifest: ResourceManifest = { version: 1, resources: {} };
	private manifestSig = "";
	private ready = false;

	constructor(
		private vault: Vault,
		private fontFolder: string = FONTS_FOLDER,
		private imageFolder: string = IMAGES_FOLDER,
		private manifestPath: string = RESOURCE_MANIFEST,
	) {}

	async init(): Promise<void> {
		await this.reload();
		this.ready = true;
	}

	get isReady(): boolean {
		return this.ready;
	}

	async reload(): Promise<void> {
		this.manifest = await this.readManifest();
		const next = new Map<string, SharedResource>();

		const previousUrls = this.imageUrls;
		this.imageUrls = new Map();

		for (const file of this.vault.getFiles()) {
			const ext = file.extension.toLowerCase();
			if (this.isUnder(file.path, this.fontFolder) && FONT_EXT.has(ext)) {
				const id = `custom:${file.path}`;
				const meta = this.manifest.resources[this.manifestKey("font", file.path)];
				next.set(id, {
					id,
					kind: "font",
					name: meta?.name || file.basename,
					path: file.path,
					enabled: meta?.enabled !== false,
					hash: meta?.hash,
				});
				continue;
			}
			if (this.isUnder(file.path, this.imageFolder) && IMAGE_EXT.has(ext)) {
				const id = `${SHARED_IMAGE_PREFIX}${file.name}`;
				const meta = this.manifest.resources[id];
				next.set(id, {
					id,
					kind: "image",
					name: meta?.name || file.basename,
					path: file.path,
					enabled: meta?.enabled !== false,
					hash: meta?.hash,
				});
			}
		}

		this.entries = next;
		await this.prepareImageUrls();
		for (const url of previousUrls.values()) {
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
		}
	}

	list(kind?: SharedResourceKind): SharedResource[] {
		const values = [...this.entries.values()].filter(v => !kind || v.kind === kind);
		values.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
		return values;
	}

	get(id: string | null | undefined): SharedResource | undefined {
		return id ? this.entries.get(id) : undefined;
	}

	isEnabled(id: string | null | undefined): boolean {
		if (!id) return true;
		// 初始化完成前无法区分「尚未加载」与「引用已失效」；此时放行，避免启动竞态
		// 把旧配置误判为停用。就绪后悬空引用必须判为不可用，与删除后的降级语义一致。
		if (!this.ready) return true;
		return this.entries.get(id)?.enabled === true;
	}

	nameFor(id: string | null | undefined): string | null {
		if (!id) return null;
		return this.entries.get(id)?.name ?? null;
	}

	resolve(id: string | null | undefined): string {
		const ref = (id ?? "").trim();
		if (!ref.startsWith(SHARED_IMAGE_PREFIX)) return ref;
		if (!this.isEnabled(ref)) return "";
		return this.imageUrls.get(ref) ?? "";
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.enabled = enabled;
		const key = entry.kind === "font" ? this.manifestKey("font", entry.path) : entry.id;
		this.manifest.resources[key] = {
			...this.manifest.resources[key],
			name: entry.name,
			enabled,
			hash: entry.hash,
		};
		await this.writeManifest();
	}

	async importImage(input: ImageImport): Promise<string | null> {
		try {
			const bytes = await this.readImage(input);
			if (!bytes) return null;
			const hash = hashBytes(new Uint8Array(bytes.buf));
			const existing = this.list("image").find(e => e.hash === hash);
			if (existing) {
				if (!existing.enabled) await this.setEnabled(existing.id, true);
				return existing.id;
			}

			const ext = IMAGE_EXT.has(bytes.ext) ? bytes.ext : "png";
			const clean = sanitizeName(bytes.name) || "image";
			const path = this.uniquePath(clean, ext, hash);
			await this.ensureFolder(this.imageFolder);
			try {
				await this.vault.createBinary(path, bytes.buf);
			} catch {
				await this.vault.adapter.writeBinary(path, bytes.buf);
			}

			const id = `${SHARED_IMAGE_PREFIX}${path.split("/").pop() ?? `${clean}.${ext}`}`;
			const entry: SharedResource = {
				id,
				kind: "image",
				name: bytes.name || clean,
				path,
				enabled: true,
				hash,
			};
			this.entries.set(id, entry);
			this.manifest.resources[id] = { name: entry.name, enabled: true, hash };
			await this.writeManifest();
			await this.attachImageUrl(entry);
			return entry.id;
		} catch (e) {
			console.warn("[UNreader] 导入共享图片失败", e);
			return null;
		}
	}

	/** 兼容旧版：把 data URI / 预设内图片 / 库内路径迁移为共享资源。远程 URL 保持原样。 */
	async importImageReference(ref: string | null | undefined, fallbackName = "图片"): Promise<string | null> {
		const value = (ref ?? "").trim();
		if (!value || value.startsWith(SHARED_IMAGE_PREFIX) || /^https?:\/\//i.test(value)) return null;
		if (value.startsWith("data:")) {
			const parsed = parseDataUri(value);
			if (!parsed) return null;
			return this.importImage({ name: fallbackName, ext: parsed.ext, buf: parsed.buf });
		}
		const file = this.vault.getAbstractFileByPath(value);
		if (file instanceof TFile) {
			return this.importImage({
				name: file.basename,
				ext: file.extension.toLowerCase(),
				sourcePath: file.path,
			});
		}
		return null;
	}

	async remove(id: string): Promise<boolean> {
		const entry = this.entries.get(id);
		if (!entry) return false;
		const url = this.imageUrls.get(id);
		if (url) {
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
			this.imageUrls.delete(id);
		}
		try {
			const file = this.vault.getAbstractFileByPath(entry.path);
			if (file instanceof TFile) {
				try {
					await this.vault.trash(file, true);
				} catch {
					await this.vault.adapter.remove(entry.path);
				}
			} else {
				await this.vault.adapter.remove(entry.path);
			}
		} catch (e) {
			console.warn("[UNreader] 删除共享资源失败", entry.path, e);
			return false;
		}
		this.entries.delete(id);
		delete this.manifest.resources[entry.kind === "font" ? this.manifestKey("font", entry.path) : id];
		await this.writeManifest();
		return true;
	}

	dispose(): void {
		for (const url of this.imageUrls.values()) {
			try { URL.revokeObjectURL(url); } catch { /* ignore */ }
		}
		this.imageUrls.clear();
		if (activeStore === this) activeStore = null;
	}

	private async readImage(input: ImageImport): Promise<ImageBytes | null> {
		let buf: ArrayBuffer | null = input.buf ?? null;
		if (!buf && input.sourcePath) {
			const file = this.vault.getAbstractFileByPath(input.sourcePath);
			if (file instanceof TFile) buf = await this.vault.readBinary(file);
		}
		if (!buf && input.read) buf = await input.read();
		if (!buf) return null;
		return {
			buf,
			ext: (input.ext || "png").toLowerCase(),
			name: input.name || "图片",
		};
	}

	private async prepareImageUrls(): Promise<void> {
		const pending: Promise<void>[] = [];
		for (const entry of this.entries.values()) {
			if (entry.kind === "image") pending.push(this.attachImageUrl(entry));
		}
		await Promise.all(pending);
	}

	private async attachImageUrl(entry: SharedResource): Promise<void> {
		try {
			const file = this.vault.getAbstractFileByPath(entry.path);
			if (!(file instanceof TFile)) return;
			const buf = await this.vault.readBinary(file);
			const mime = mimeForImage(file.extension);
			const url = URL.createObjectURL(new Blob([buf], { type: mime }));
			this.imageUrls.set(entry.id, url);
		} catch (e) {
			console.warn("[UNreader] 读取共享图片失败", entry.path, e);
		}
	}

	private uniquePath(base: string, ext: string, hash: string): string {
		const suffix = hash.slice(0, 8);
		let candidate = `${this.imageFolder}/${base}-${suffix}.${ext}`;
		let n = 2;
		while (this.vault.getAbstractFileByPath(candidate)) {
			candidate = `${this.imageFolder}/${base}-${suffix}-${n}.${ext}`;
			n++;
		}
		return candidate;
	}

	private async readManifest(): Promise<ResourceManifest> {
		const empty: ResourceManifest = { version: 1, resources: {} };
		try {
			if (!await this.vault.adapter.exists(this.manifestPath)) return empty;
			const raw = await this.vault.adapter.read(this.manifestPath);
			this.manifestSig = raw;
			const parsed = JSON.parse(raw) as Partial<ResourceManifest>;
			if (!parsed || typeof parsed !== "object" || !parsed.resources || typeof parsed.resources !== "object") return empty;
			return { version: 1, resources: parsed.resources };
		} catch {
			return empty;
		}
	}

	private async writeManifest(): Promise<void> {
		const text = JSON.stringify(this.manifest, null, "\t");
		if (text === this.manifestSig) return;
		await this.ensureFolder(RESOURCES_FOLDER);
		await this.vault.adapter.write(this.manifestPath, text);
		this.manifestSig = text;
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			const existing = this.vault.getAbstractFileByPath(cur);
			if (existing instanceof TFolder) continue;
			try { await this.vault.createFolder(cur); } catch { /* 已存在或并发创建 */ }
		}
	}

	private isUnder(path: string, folder: string): boolean {
		const root = folder.replace(/\/+$/, "");
		return path === root || path.startsWith(`${root}/`);
	}

	private manifestKey(kind: SharedResourceKind, path: string): string {
		return `${kind}:${path}`;
	}
}

function sanitizeName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "_").trim().slice(0, 80);
}

function mimeForImage(ext: string): string {
	const e = ext.toLowerCase();
	if (e === "svg") return "image/svg+xml";
	if (e === "jpg" || e === "jpeg") return "image/jpeg";
	if (e === "webp") return "image/webp";
	if (e === "gif") return "image/gif";
	if (e === "bmp") return "image/bmp";
	return "image/png";
}

function hashBytes(bytes: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i] as number;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function parseDataUri(uri: string): { buf: ArrayBuffer; ext: string } | null {
	const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(uri);
	if (!match) return null;
	const mime = match[1]!.toLowerCase();
	const ext = mime === "svg+xml" ? "svg" : mime === "jpeg" ? "jpg" : mime.split("+")[0]!;
	try {
		const bin = window.atob(match[2]!);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return { buf: bytes.buffer, ext };
	} catch {
		return null;
	}
}
