import { FileManager, Platform, TFile, TFolder, Vault } from "obsidian"
import { AppearancePreset, AppearanceSettings, DEFAULT_APPEARANCE, adoptLegacyAppearance, platformAppearanceDefaults } from "../types"

/** 单个预设文件的磁盘格式 */
interface PresetFile {
	id: string
	name: string
	dir: string
	createdAt: number
	appearance: AppearanceSettings
}

/**
 * 外观预设文件化持久化（多端同步）：
 * 每个预设一个文件夹（UNreader/Data/Presets/<预设名>/），内含 preset.json；
 * 新版背景图只保存 `shared:image/<文件>` 引用，资源本体由 ResourceStore 统一管理。
 * 旧版预设内的 "preset:background.<ext>" 仍可读取，并由 main 的迁移流程收纳为共享资源。
 */
export class PresetStore {
	/** id → 预设（内存缓存，启动时从库内加载） */
	private cache = new Map<string, AppearancePreset & { dir: string }>()
	/** 每个预设独立的写盘去抖 timer */
	private writeTimers = new Map<string, number>()
	/** 旧数据迁移进行中标记：避免迁移写入与后续写回竞争 */
	private ready = false
	/** preset.json 的**已落盘内容签名**（path → 文本）：内容未变就不再写盘。
	 *  往 UNreader/ 写文件是库里的结构性事件，会触发官方文件列表重算该子树 ——
	 *  移动端抽屉隐藏窗口里的那次重算会把条目永久打上 hidden（见 explorerHeal.ts）。 */
	private writtenSigs = new Map<string, string>()
	/** 旧版预设内图片的记忆：dir → 字段 → 源引用与目标文件名（避免重复复制） */
	private materialized = new Map<string, Map<string, { source: string; file: string }>>()

	/** 外观中的背景图字段 → 预设文件夹内文件名（不含扩展名） */
	static readonly IMAGE_FIELDS = ["backgroundImage", "backgroundImageLight", "backgroundImageDark"] as const
	static readonly IMAGE_FILES: Record<string, string> = {
		backgroundImage: "background",
		backgroundImageLight: "background-light",
		backgroundImageDark: "background-dark",
	}

	constructor(
		private vault: Vault,
		private folder: string,
		private fileManager: FileManager,
	) {}

	/** 预设名 → 安全文件夹名（跨端一致：仅清洗文件系统非法字符，不做 hash） */
	static dirNameFor(name: string): string {
		const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, "_").trim().slice(0, 80)
		return safe || "preset"
	}

	/** 从库内加载全部预设；legacy 为旧 data.json appearancePresets，缺失的迁移为文件 */
	async init(legacy: AppearancePreset[]): Promise<void> {
		this.cache.clear()
		await this.reload()
		this.ready = true
		// 旧 data.json 里的预设迁移为文件夹（按 id 去重，重复执行幂等）
		for (const p of legacy ?? []) {
			if (!p || typeof p.name !== "string" || !p.appearance) continue
			if (this.cache.has(p.id)) continue
			// id 必须跨端确定（按预设名派生）：两台设备各自迁移同一个旧预设时，
			// 随机 id 会写进同一个文件夹互相覆盖，导致另一端钉住的 id 失配
			const rawLegacy = { ...(p.appearance as unknown as Record<string, unknown>) }
			adoptLegacyAppearance(rawLegacy, platformAppearanceDefaults(
				Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp,
			))
			const migrated: AppearancePreset & { dir: string } = {
				id: p.id || `legacy-${PresetStore.dirNameFor(p.name)}`,
				name: p.name,
				dir: PresetStore.dirNameFor(p.name),
				appearance: Object.assign({}, DEFAULT_APPEARANCE, rawLegacy),
				createdAt: p.createdAt ?? Date.now(),
			}
			this.cache.set(migrated.id, migrated)
			await this.writeNow(migrated).catch(() => {})
		}
	}

	/** 从磁盘重扫预设文件夹（他端同步到达的新增/修改/删除即时生效）。
	 *  本机有未落盘写回（去抖中）的预设保留内存版本，避免被磁盘旧值覆盖。 */
	async reload(): Promise<void> {
		const found = new Map<string, AppearancePreset & { dir: string }>()
		try {
			const folder = this.vault.getAbstractFileByPath(this.folder)
			if (folder instanceof TFolder) {
				// ⚠️ 读取并行化（同 ProgressStore.init）：预设数随用户增长，
				// 串行 vault.read 会让插件启用耗时线性叠加 —— 移动端单次读
				// 25~120ms 时，6 个预设就是 150~720ms。
				const candidates = folder.children
					.filter((child): child is TFolder => child instanceof TFolder)
					.map(child => ({
						child,
						json: child.children.find(f => f instanceof TFile && f.name === "preset.json"),
					}))
					.filter((c): c is { child: TFolder; json: TFile } => c.json instanceof TFile)
				const results = await Promise.all(candidates.map(async ({ child, json }) => {
					try {
						return { child, parsed: JSON.parse(await this.vault.read(json)) as Partial<PresetFile> }
					} catch {
						return { child, parsed: null } // 单个 preset.json 损坏不拖垮整体
					}
				}))
				for (const { child, parsed } of results) {
					if (!parsed || typeof parsed.name !== "string" || !parsed.appearance) continue
					// id 缺失时按文件夹名派生确定 id（不能随机：随机 id 只进内存
					// 不落盘，每次重扫都变，本机钉住会永久失配）
					// 旧字段迁移在合并默认值之前；缺失的平台相关常态项按当前设备形态补充。
					const rawAppearance = { ...(parsed.appearance as unknown as Record<string, unknown>) }
					adoptLegacyAppearance(rawAppearance, platformAppearanceDefaults(
						Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp,
					))
					const preset: AppearancePreset & { dir: string } = {
						id: typeof parsed.id === "string" && parsed.id ? parsed.id : `dir-${child.name}`,
						name: parsed.name,
						dir: typeof parsed.dir === "string" && parsed.dir ? parsed.dir : child.name,
						appearance: Object.assign({}, DEFAULT_APPEARANCE, rawAppearance),
						createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
					}
					found.set(preset.id, preset)
				}
			}
		} catch (e) {
			console.warn("[UNreader] 重扫预设文件夹失败", e)
			return
		}
		for (const [id, p] of found) {
			if (!this.writeTimers.has(id)) this.cache.set(id, p)
		}
		// 他端已删除（磁盘上不存在）且本机无未写盘更新的预设同步移除
		for (const id of [...this.cache.keys()]) {
			if (!found.has(id) && !this.writeTimers.has(id)) this.cache.delete(id)
		}
	}

	list(): (AppearancePreset & { dir: string })[] {
		return [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt)
	}

	get(id: string): (AppearancePreset & { dir: string }) | undefined {
		return this.cache.get(id)
	}

	/** 新建/更新预设（内存即时生效，写盘去抖 600ms） */
	upsert(preset: AppearancePreset & { dir?: string }): void {
		const dir = preset.dir ?? PresetStore.dirNameFor(preset.name)
		const entry: AppearancePreset & { dir: string } = {
			...preset,
			dir,
			appearance: preset.appearance,
		}
		this.cache.set(entry.id, entry)
		const prev = this.writeTimers.get(entry.id)
		if (prev) window.clearTimeout(prev)
		this.writeTimers.set(entry.id, window.setTimeout(() => {
			this.writeTimers.delete(entry.id)
			void this.writeNow(entry).catch(e => console.warn("[UNreader] 写入预设文件失败", e))
		}, 600))
	}

	/** 重命名：复制整个预设文件夹到新名下，再删除旧文件夹 */
	async rename(id: string, newName: string): Promise<void> {
		const preset = this.cache.get(id)
		if (!preset) return
		const oldDir = preset.dir
		const newDir = PresetStore.dirNameFor(newName)
		preset.name = newName
		preset.dir = newDir
		if (oldDir === newDir) {
			await this.writeNow(preset)
			return
		}
		try {
			await this.ensureFolder(this.folder)
			// 复制 preset.json 与背景图
			const oldJson = `${this.folder}/${oldDir}/preset.json`
			if (await this.adapterExists(oldJson)) {
				const raw = await this.vault.adapter.read(oldJson)
				const parsed = JSON.parse(raw) as Partial<PresetFile>
				parsed.name = newName
				parsed.dir = newDir
				await this.writeText(`${this.folder}/${newDir}/preset.json`, JSON.stringify(parsed, null, "\t"))
			} else {
				await this.writeNow(preset)
			}
			for (const name of await this.listFiles(`${this.folder}/${oldDir}`)) {
				if (name === "preset.json") continue
				const buf = await this.vault.adapter.readBinary(`${this.folder}/${oldDir}/${name}`)
				await this.writeBinary(`${this.folder}/${newDir}/${name}`, buf)
			}
			await this.removeDir(`${this.folder}/${oldDir}`)
		} catch (e) {
			console.warn("[UNreader] 重命名预设文件夹失败", e)
		}
	}

	/** 删除预设文件夹（走系统回收站，失败则直接删除） */
	async remove(id: string): Promise<void> {
		const preset = this.cache.get(id)
		if (!preset) return
		this.cache.delete(id)
		const t = this.writeTimers.get(id)
		if (t) {
			window.clearTimeout(t)
			this.writeTimers.delete(id)
		}
		try {
			const folder = this.vault.getAbstractFileByPath(`${this.folder}/${preset.dir}`)
			if (folder instanceof TFolder) {
				// 删除预设目录走用户的删除偏好（上架规则禁止 Vault.trash/delete）
				await this.fileManager.trashFile(folder)
				return
			}
		} catch { /* 回收站失败转直接删除 */ }
		try {
			await this.removeDir(`${this.folder}/${preset.dir}`)
		} catch (e) {
			console.warn("[UNreader] 删除预设文件夹失败", e)
		}
	}

	/** 旧版预设内背景图（preset:background.xxx）→ data URI；shared:/远程引用原样返回 */
	async resolveImages(appearance: AppearanceSettings, preset: AppearancePreset & { dir?: string }): Promise<void> {
		const dir = (preset).dir ?? PresetStore.dirNameFor(preset.name)
		for (const field of PresetStore.IMAGE_FIELDS) {
			const ref = ((appearance as unknown as Record<string, unknown>)[field] as string ?? "").trim()
			if (!ref.startsWith("preset:")) continue
			const file = ref.slice("preset:".length)
			const path = `${this.folder}/${dir}/${file}`
			try {
				if (!await this.adapterExists(path)) {
					;(appearance as unknown as Record<string, unknown>)[field] = null
					continue
				}
				const buf = await this.vault.adapter.readBinary(path)
				const ext = (file.split(".").pop() || "png").toLowerCase()
				const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`
				;(appearance as unknown as Record<string, unknown>)[field] = `data:${mime};base64,${arrayBufferToBase64(buf)}`
			} catch (e) {
				console.warn("[UNreader] 读取预设背景图失败", path, e)
			}
		}
	}

	/** 仅迁移旧版 data:/库内路径背景图到预设文件夹；shared: 全局引用不再复制副本 */
	private async materializeImage(preset: AppearancePreset & { dir: string }): Promise<void> {
		const a = preset.appearance
		for (const field of PresetStore.IMAGE_FIELDS) {
			const ref = ((a as unknown as Record<string, unknown>)[field] as string ?? "").trim()
			// `shared:` 是全局资源引用，不复制进任何单个预设；只迁移旧版 preset:/data:/路径引用。
			if (!ref || ref.startsWith("preset:") || ref.startsWith("shared:") || /^https?:\/\//i.test(ref)) continue
			const done = this.materialized.get(preset.dir)?.get(field)
			if (done && done.source === ref) {
				;(a as unknown as Record<string, unknown>)[field] = `preset:${done.file}`
				continue
			}
			let buf: ArrayBuffer | null = null
			let ext = "png"
			const dataUri = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(ref)
			if (dataUri) {
				const mime = dataUri[1]!.toLowerCase()
				ext = mime === "image/svg+xml" ? "svg" : mime === "image/jpeg" ? "jpg" : mime.split("/")[1]!.split(".")[0]!
				buf = base64ToArrayBuffer(dataUri[2]!)
			} else if (!ref.includes(":")) {
				// 视为库内路径，读取原文件复制
				try {
					buf = await this.vault.adapter.readBinary(ref)
					const m = /\.([a-z0-9]+)$/i.exec(ref)
					ext = (m?.[1] ?? "png").toLowerCase()
				} catch {
					continue // 原图读不到，保留原引用
				}
			} else {
				continue // 未知协议（app:// 等），保留原引用
			}
			if (!buf) continue
			const file = `${PresetStore.IMAGE_FILES[field]}.${ext}`
			await this.ensureFolder(`${this.folder}/${preset.dir}`)
			await this.writeBinary(`${this.folder}/${preset.dir}/${file}`, buf)
			;(a as unknown as Record<string, unknown>)[field] = `preset:${file}`
			if (!this.materialized.has(preset.dir)) this.materialized.set(preset.dir, new Map())
			this.materialized.get(preset.dir)!.set(field, { source: ref, file })
		}
	}

	private async writeNow(preset: AppearancePreset & { dir: string }): Promise<void> {
		const payload: PresetFile = {
			id: preset.id,
			name: preset.name,
			dir: preset.dir,
			createdAt: preset.createdAt,
			appearance: preset.appearance,
		}
		const text = JSON.stringify(payload, null, "\t")
		// **内容没变就不写盘、也不物化图片**（2026-09-13）：本插件的外观写回会在每次
		// 微调时被调用，而往 UNreader/ 里写文件是**库里的结构性事件** —— Obsidian 官方
		// 文件列表会因此重算那一棵子树（`computed = !1` + `requestSort()` → `compute()`）。
		// 移动端该文件夹的容器在抽屉收起时是 `display:none`，那一趟测量会把条目永久打成
		// `hidden`（「夹子在、内容不显示」，见 src/ui/explorerHeal.ts 的逐行取证）。
		// 少写一次 = 少一次触发机会，且对用户零影响（写下去的字节完全一样）。
		const path = `${this.folder}/${preset.dir}/preset.json`
		if (this.writtenSigs.get(path) === text) return
		await this.materializeImage(preset)
		await this.ensureFolder(`${this.folder}/${preset.dir}`)
		await this.writeText(path, text)
		this.writtenSigs.set(path, text)
	}

	async flush(): Promise<void> {
		const ids = [...this.writeTimers.keys()]
		for (const id of ids) {
			const t = this.writeTimers.get(id)
			if (t) {
				window.clearTimeout(t)
				this.writeTimers.delete(id)
			}
			const preset = this.cache.get(id)
			if (preset) await this.writeNow(preset).catch(() => {})
		}
	}

	private async adapterExists(path: string): Promise<boolean> {
		try {
			return await this.vault.adapter.exists(path)
		} catch {
			return false
		}
	}

	private async listFiles(path: string): Promise<string[]> {
		try {
			const listed = await this.vault.adapter.list(path)
			return listed.files.map(f => f.split("/").pop() ?? f)
		} catch {
			return []
		}
	}

	private async writeText(path: string, text: string): Promise<void> {
		await this.ensureFolder(path.split("/").slice(0, -1).join("/"))
		try {
			await this.vault.adapter.write(path, text)
		} catch (e) {
			console.warn("[UNreader] 写入文件失败", path, e)
		}
	}

	private async writeBinary(path: string, buf: ArrayBuffer): Promise<void> {
		await this.ensureFolder(path.split("/").slice(0, -1).join("/"))
		try {
			await this.vault.adapter.writeBinary(path, buf)
		} catch (e) {
			console.warn("[UNreader] 写入图片失败", path, e)
		}
	}

	private async removeDir(path: string): Promise<void> {
		try {
			for (const name of await this.listFiles(path)) {
				try { await this.vault.adapter.remove(`${path}/${name}`) } catch { /* ignore */ }
			}
			await this.vault.adapter.remove(path)
		} catch (e) {
			console.warn("[UNreader] 删除文件夹失败", path, e)
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/").filter(Boolean)
		let cur = ""
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part
			try {
				const f = this.vault.getAbstractFileByPath(cur)
				if (f instanceof TFolder) continue
				await this.vault.createFolder(cur)
			} catch { /* 已存在或并发创建失败可忽略 */ }
		}
	}
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const bin = window.atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return bytes.buffer
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf)
	let bin = ""
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return window.btoa(bin)
}
