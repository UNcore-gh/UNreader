import { TFile, TFolder, Vault } from "obsidian"
import { BookPosition } from "../types"
import { info as debugInfo, warn as debugWarn } from "./debugLog"

/** 单个进度文件的磁盘格式（book 字段冗余存储书路径，
 *  同步冲突副本（-conflict 文件）也能按 updatedAt 合并） */
interface ProgressFile {
	book: string
	/** 新格式位置 token（EPUB=CFI / MOBI=filepos），见 types.ts: BookPosition.anchor */
	anchor: string
	/** @deprecated 老格式字段（cfi=anchor），读取时自动迁移 */
	cfi?: string
	fraction: number
	updatedAt: number
}

/** 本机热缓存 key 前缀：`<前缀>:<库 scope>:<URL 编码后的书路径>`。
 *  三段都用 encodeURIComponent 编码，冒号在段内不可能出现，枚举时可直接切分。 */
const HOT_PREFIX = "unreader-pos-hot"
/** 全局 localStorage 键数超过它才做一次淘汰扫描（绝大多数库一辈子也到不了） */
const HOT_SCAN_AT = 300
/** 淘汰后保留的新鲜条目数 */
const HOT_KEEP = 200
/** 「已有进度文件但读不出来」时的重试次数与间隔（见 writeNow） */
const WRITE_RETRY_MAX = 3
const WRITE_RETRY_MS = 3000

/** 老格式位置字段（`BookPosition.cfi` / `ProgressFile.cfi` 都标了 `@deprecated`）。
 *  这里用一个**不含 deprecated 标注**的结构类型来读它：全模块只有「吸收旧数据」
 *  这一个用途，走 helper 收口后就不必在每个调用点重复触发 `no-deprecated`。
 *  写入路径一律只写新名 `anchor`。 */
function legacyAnchor(source: { anchor?: unknown; cfi?: unknown } | null | undefined): string {
	if (!source) return ""
	if (typeof source.anchor === "string" && source.anchor) return source.anchor
	if (typeof source.cfi === "string" && source.cfi) return source.cfi
	return ""
}

/** 从 ProgressFile 抽取位置 token，兼容新旧两种字段名 */
function pickAnchor(parsed: Partial<ProgressFile>): string {
	return legacyAnchor(parsed)
}

/**
 * 阅读进度持久化（多端同步）：
 * 进度按书写入库内小 JSON 文件（UNreader/Data/Progress/<书名>-<hash>.json），
 * 随 Obsidian Sync / iCloud 自然同步到各端；每书一个文件，冲突粒度小，
 * 同书冲突副本按 updatedAt 取最新，避免 data.json 整体覆盖丢进度。
 *
 * **库内文件之外还有一份「本机热缓存」（localStorage，2026-09-14 加）**：
 * 库内文件的写入是**异步 + 去抖**的（视图 800ms + 本模块 1s），而写盘这件事
 * 在真机上有一串会掉链子的窗口 —— ① 应用被系统杀掉 / 崩溃 / 强制退出（移动端
 * 后台被回收是最常见的一种），去抖里的那次写盘根本没发生；② 启动时进度文件
 * 读不出来（iCloud 占位文件未下载、他端正在写、同步中间态），init 只当它不存在；
 * ③ 文件刚由 `adapter.write` 建出来，Obsidian 的文件索引还没收录，`folder.children`
 * 里看不到它。三种都表现为同一个用户可见后果：**开书回到书首（进度「丢了」）**，
 * 而后续的落盘还会把书首位置写回文件，把真实进度永久覆盖掉。
 *
 * 所以：`save()` 在**返回前同步**把位置写进 localStorage（每书一键，与库内文件
 * 同一份 payload）。它只在本机读（取位置时与库内记录比 `updatedAt`，新的胜出），
 * **不参与多端合并**，因此不会把本机的位置推给他端，只是「本机最后已知位置」的兜底。
 * 代价：用户手动删掉某本书的进度文件想重读时，热缓存会在下次开书时把它补回来
 * （同一台设备，同 `updatedAt` 语义；多端场景下他端的更靠后位置仍然会赢）。
 */
export class ProgressStore {
	/** 书路径 → 进度（内存缓存，启动时从库内加载） */
	private cache = new Map<string, BookPosition>()
	/** 每本书独立的写盘 timer（去抖写 + 读失败重试共用） */
	private writeTimers = new Map<string, number>()
	/** 「已有文件但读不出来」连续跳过的次数（写成功后清零），见 writeNow */
	private writeRetries = new Map<string, number>()

	constructor(
		private vault: Vault,
		private folder: string,
		/** 本机库作用域（vault 名/appId 派生，见 main.ts deviceScope）。
		 *  localStorage 是 Obsidian 全局共享的，同一台机器上的多个库必须各自隔离，
		 *  否则 A 库里读同一路径的书会取到 B 库的位置。 */
		private scope = "default",
	) {}

	/** 书路径 → 进度文件名：可读书名 + 路径 hash（同书移动路径后 hash 变化即视为新书） */
	static fileNameFor(bookPath: string): string {
		const base = bookPath.split("/").pop() ?? bookPath
		const stem = base.replace(/\.[^.]+$/, "")
		// djb2 hash，保证跨端稳定
		let h = 5381
		for (let i = 0; i < bookPath.length; i++) h = ((h << 5) + h + bookPath.charCodeAt(i)) | 0
		const hex = (h >>> 0).toString(16).padStart(8, "0")
		// 文件名做保守清洗：仅保留常见安全字符
		const safe = stem.replace(/[\\/:*?"<>|#^[\]]/g, "_").slice(0, 80) || "book"
		return `${safe}-${hex}.json`
	}

	/** 启动加载：读取库内全部进度文件 + 与旧 data.json positions 合并迁移 */
	/** 读进度文件夹 + 迁移旧 data.json 里的 positions。
	 *  **返回值 = 本次真正迁移并落盘的条数** —— 调用方据此把 `settings.positions` 清空，
	 *  否则旧字段永远留着、他端一旦把它的 updatedAt 推得更新，**每次插件加载都会把这批
	 *  进度文件重写一遍**（2026-09-13 真机故障的触发源：手机端启动瞬间往 `UNreader/`
	 *  一次写 11 个文件 = 库里一口结构性事件，官方文件列表随即重算那棵子树，
	 *  而移动端该容器在抽屉隐藏窗口里 → 虚拟化的条目被永久 `hidden`，见 explorerHeal.ts）。 */
	async init(legacyPositions: Record<string, BookPosition>): Promise<number> {
		this.cache.clear()
		try {
			const folder = this.vault.getAbstractFileByPath(this.folder)
			if (folder instanceof TFolder) {
				// ⚠️ 读取必须并行。进度文件数 = 用户读过的书数（实测 14 个），
				// 原先的串行 for-await 让「读进度」耗时 ≈ 文件数 × 单次读延迟：
				// 桌面 SSD 上微不足道，移动端 iCloud 单次 25ms→350ms、120ms→1.7s，
				// 而这段曾经同步阻塞在插件 onload 上（见 main.ts 的 dataReady）。
				// 并行安全：mergeIn 取 updatedAt 最大者，与读入顺序无关。
				const targets = folder.children.filter(
					(child): child is TFile => child instanceof TFile && child.extension === "json",
				)
				const parsedList = await Promise.all(targets.map(async child => {
					try {
						const raw = await this.vault.adapter.read(`${this.folder}/${child.name}`)
						return JSON.parse(raw) as Partial<ProgressFile>
					} catch {
						return null // 单个文件损坏/读取失败不拖垮整体
					}
				}))
				for (const parsed of parsedList) {
					if (!parsed || typeof parsed.book !== "string") continue
					const anchor = pickAnchor(parsed)
					if (!anchor) continue
					const pos: BookPosition = {
						anchor,
						fraction: typeof parsed.fraction === "number" ? parsed.fraction : 0,
						updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
					}
					this.mergeIn(parsed.book, pos)
				}
			}
		} catch (e) {
			console.warn("[UNreader] 读取进度文件夹失败", e)
		}
		// 并入本机热缓存：库内文件读不到的（iCloud 占位没下载 / 他端正在写 / 索引还没
		// 收录这个文件）与上次没能落盘的（应用被杀时去抖里的那次写没发生），这里都还在。
		// **只进内存缓存、不在这里回写库内文件** —— 启动瞬间批量写文件正是 2026-09-13
		// 那次官方文件列表故障的触发源（见上方 init 注释）；文件等用户下次开这本书、
		// 由正常的去抖写回补上（那时 payload 的 updatedAt 更新，writeNow 会照写）。
		let hotUsed = 0
		for (const bookPath of this.hotBooks()) {
			const hot = this.hotRead(bookPath)
			if (!hot) continue
			hotUsed++
			this.mergeIn(bookPath, hot)
		}
		debugInfo("[progress] init", `files=${this.cache.size}`, `hot=${hotUsed}`)
		// 旧 data.json 里的 positions 迁移到文件（仅在比文件记录新时写入）
		let migrated = 0
		for (const [bookPath, pos] of Object.entries(legacyPositions ?? {})) {
			const legacy = legacyAnchor(pos)
			if (typeof legacy !== "string" || !legacy) continue
			const existing = this.cache.get(bookPath)
			if (existing && existing.updatedAt >= (pos.updatedAt ?? 0)) continue
			this.mergeIn(bookPath, { anchor: legacy, fraction: pos.fraction ?? 0, updatedAt: pos.updatedAt ?? 0 })
			void this.writeNow(bookPath)
			migrated++
		}
		return migrated
	}

	private mergeIn(bookPath: string, pos: BookPosition): void {
		const existing = this.cache.get(bookPath)
		if (!existing || (pos.updatedAt ?? 0) >= existing.updatedAt) {
			this.cache.set(bookPath, pos)
		}
	}

	get(bookPath: string): BookPosition | undefined {
		const cached = this.cache.get(bookPath)
		if (cached) return cached
		// 内存缓存没有 ≈ 启动时那个文件压根没读到（见类注释的三种窗口）。
		// 热缓存是同一台设备上最后已知的位置，比「回到书首」正确得多。
		const hot = this.hotRead(bookPath)
		if (hot) this.mergeIn(bookPath, hot)
		return hot ?? undefined
	}

	/** 书籍路径变化时迁移进度身份键（资料库文件夹迁移使用）。
	 *  先写新键、再删旧键；任一步失败都保留旧记录。 */
	async move(oldPath: string, newPath: string): Promise<boolean> {
		if (!oldPath || !newPath || oldPath === newPath) return false
		this.clearWriteTimer(oldPath)

		const oldFile = `${this.folder}/${ProgressStore.fileNameFor(oldPath)}`
		let diskPosition: BookPosition | null = null
		let oldReadable = true
		try {
			const raw = await this.vault.adapter.read(oldFile)
			const parsed = JSON.parse(raw) as Partial<ProgressFile>
			const anchor = pickAnchor(parsed)
			if (anchor) {
				diskPosition = {
					anchor,
					fraction: typeof parsed.fraction === "number" ? parsed.fraction : 0,
					updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
				}
			}
		} catch {
			// 文件不存在是正常的；存在但读失败时仍可迁移缓存值，只是暂不删旧文件。
			try { oldReadable = !(await this.vault.adapter.exists(oldFile)) } catch { oldReadable = false }
		}

		const cached = this.cache.get(oldPath) ?? this.hotRead(oldPath) ?? undefined
		const position = !diskPosition
			? cached
			: !cached || diskPosition.updatedAt >= cached.updatedAt
				? diskPosition
				: cached
		if (!position) return false

		const newFile = `${this.folder}/${ProgressStore.fileNameFor(newPath)}`
		let current = position
		try {
			const raw = await this.vault.adapter.read(newFile)
			const parsed = JSON.parse(raw) as Partial<ProgressFile>
			const anchor = pickAnchor(parsed)
			if (anchor && (typeof parsed.updatedAt !== "number" || parsed.updatedAt > current.updatedAt)) {
				current = {
					anchor,
					fraction: typeof parsed.fraction === "number" ? parsed.fraction : 0,
					updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
				}
			}
		} catch {
			let exists = false
			try { exists = await this.vault.adapter.exists(newFile) } catch { /* 判定不了按存在处理 */ exists = true }
			if (exists) throw new Error(`新路径已有进度文件但暂时读不出来：${newFile}`)
		}

		await this.ensureFolder()
		const payload: ProgressFile = {
			book: newPath,
			anchor: current.anchor,
			fraction: current.fraction,
			updatedAt: current.updatedAt,
		}
		await this.vault.adapter.write(newFile, JSON.stringify(payload, null, "\t"))

		if (oldReadable && oldFile !== newFile) {
			try { await this.vault.adapter.remove(oldFile) } catch { /* 旧文件清理失败不影响新键 */ }
		}
		this.cache.delete(oldPath)
		this.mergeIn(newPath, current)
		this.hotWrite(newPath, current)
		try { window.localStorage.removeItem(this.hotKey(oldPath)) } catch { /* ignore */ }
		return true
	}

	/* ---------------- 本机热缓存（localStorage） ---------------- */

	private hotKey(bookPath: string): string {
		return `${HOT_PREFIX}:${encodeURIComponent(this.scope)}:${encodeURIComponent(bookPath)}`
	}

	/** 同步写热缓存。**必须在 save() 返回前完成** —— 它存在的全部理由是
	 *  「写盘那一拍赶不上」（应用被杀 / 崩溃），异步化就等于没写。 */
	private hotWrite(bookPath: string, pos: BookPosition): void {
		try {
			if (typeof window.localStorage === "undefined") return
			const payload: ProgressFile = {
				book: bookPath,
				anchor: pos.anchor,
				fraction: pos.fraction ?? 0,
				updatedAt: pos.updatedAt ?? 0,
			}
			window.localStorage.setItem(this.hotKey(bookPath), JSON.stringify(payload))
			if (window.localStorage.length > HOT_SCAN_AT) this.hotPrune()
		} catch { /* 配额满 / 隐私模式：热缓存尽力而为，绝不打断主链 */ }
	}

	private hotRead(bookPath: string): BookPosition | null {
		try {
			if (typeof window.localStorage === "undefined") return null
			const raw = window.localStorage.getItem(this.hotKey(bookPath))
			if (!raw) return null
			const parsed = JSON.parse(raw) as Partial<ProgressFile>
			const anchor = pickAnchor(parsed)
			if (!anchor) return null
			return {
				anchor,
				fraction: typeof parsed.fraction === "number" ? parsed.fraction : 0,
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			}
		} catch {
			return null
		}
	}

	/** 本库热缓存里出现过的书路径（key 里编码了路径，解回来即可） */
	private hotBooks(): string[] {
		const out: string[] = []
		try {
			if (typeof window.localStorage === "undefined") return out
			const prefix = `${HOT_PREFIX}:${encodeURIComponent(this.scope)}:`
			for (let i = 0; i < window.localStorage.length; i++) {
				const key = window.localStorage.key(i)
				if (!key || !key.startsWith(prefix)) continue
				try {
					out.push(decodeURIComponent(key.slice(prefix.length)))
				} catch { /* 坏 key 跳过 */ }
			}
		} catch { /* 同上 */ }
		return out
	}

	/** 淘汰旧条目（只在键数超过 HOT_SCAN_AT 时调用）：保留 updatedAt 最新的 HOT_KEEP 条。
	 *  条目数 = 用户在这个库读过的书数，正常永远到不了阈值；设它是为了不让
	 *  「换过很多次库/很多本书」的设备把 localStorage 配额吃光（配额满会波及其他功能）。 */
	private hotPrune(): void {
		const entries: Array<{ key: string; updatedAt: number }> = []
		const books = this.hotBooks()
		for (const bookPath of books) {
			entries.push({ key: this.hotKey(bookPath), updatedAt: this.hotRead(bookPath)?.updatedAt ?? 0 })
		}
		if (entries.length <= HOT_KEEP) return
		entries.sort((a, b) => b.updatedAt - a.updatedAt)
		for (const e of entries.slice(HOT_KEEP)) {
			try { window.localStorage.removeItem(e.key) } catch { /* ignore */ }
		}
	}

	/** 写入进度（去抖 1s；调用方同步返回，不阻塞翻页/滚动）。
	 *  热缓存是**同步**写的 —— 应用在这一拍之后被杀也不丢位置。 */
	save(bookPath: string, pos: BookPosition): void {
		const anchor = legacyAnchor(pos)
		if (!anchor) return
		// 统一进新格式（老 cfi 字段也吸收）
		const normalized: BookPosition = { anchor, fraction: pos.fraction ?? 0, updatedAt: pos.updatedAt ?? 0 }
		this.mergeIn(bookPath, normalized)
		// 热缓存写的是**合并后**的内存值，不是传进来的那个：传进来的可能是本视图
		// 早就捕获的旧位置（见 readerView 的 ProgressCursor），直接写会把更靠后的
		// 热条目冲掉 —— 而热缓存恰恰是「库内文件没写成」时唯一的证据。
		this.hotWriteCache(bookPath)
		this.scheduleWrite(bookPath, 1000)
	}

	/** 立即写盘（不去抖）：关闭视图 / 退出应用 / 应用切后台时用。
	 *  去抖链（视图 800ms + 本模块 1s）在「打开着书直接退出」这条路上是纯损失。 */
	saveNow(bookPath: string, pos: BookPosition): void {
		const anchor = legacyAnchor(pos)
		if (!anchor) return
		const normalized: BookPosition = { anchor, fraction: pos.fraction ?? 0, updatedAt: pos.updatedAt ?? 0 }
		this.mergeIn(bookPath, normalized)
		this.hotWriteCache(bookPath)
		this.clearWriteTimer(bookPath)
		void this.writeNow(bookPath)
	}

	/** 把内存缓存里的当前值同步进热缓存（见 save 里的说明） */
	private hotWriteCache(bookPath: string): void {
		const cur = this.cache.get(bookPath)
		if (cur) this.hotWrite(bookPath, cur)
	}

	private clearWriteTimer(bookPath: string): void {
		const t = this.writeTimers.get(bookPath)
		if (t) {
			window.clearTimeout(t)
			this.writeTimers.delete(bookPath)
		}
	}

	private scheduleWrite(bookPath: string, delay: number): void {
		this.clearWriteTimer(bookPath)
		this.writeTimers.set(
			bookPath,
			window.setTimeout(() => {
				this.writeTimers.delete(bookPath)
				void this.writeNow(bookPath)
			}, delay),
		)
	}

	async flush(bookPath?: string): Promise<void> {
		const targets = bookPath ? [bookPath] : [...this.writeTimers.keys()]
		for (const p of targets) this.clearWriteTimer(p)
		await Promise.all(targets.map(p => this.writeNow(p)))
	}

	private async writeNow(bookPath: string): Promise<void> {
		const pos = this.cache.get(bookPath)
		if (!pos) return
		const payload: ProgressFile = {
			book: bookPath,
			anchor: pos.anchor,
			fraction: pos.fraction,
			updatedAt: pos.updatedAt,
		}
		const fileName = ProgressStore.fileNameFor(bookPath)
		const filePath = `${this.folder}/${fileName}`
		const text = JSON.stringify(payload, null, "\t")
		try {
			await this.ensureFolder()
			// 直接走 adapter 落盘（覆盖写），绕开 vault.create 的「索引未跟上/他端
			// 刚同步落盘 → File already exists」竞态；新文件随后由 Obsidian 文件
			// 监视器自动收进索引。磁盘内容比自己新就不覆盖（另一端刚写回）
			let existed = false
			let raw: string | null = null
			try {
				raw = await this.vault.adapter.read(filePath)
			} catch {
				// **读失败有两种，不能混为一谈**：① 文件本来就不存在（新书，正常路径，
				// 往下直接覆盖写）；② 文件在，但这一拍读不出来 —— iCloud 占位文件还没
				// 下载、他端正在写、同步中间态。②当①处理就是**覆盖掉一条真实存在的
				// 记录**，而它往往比我们手里的更靠后（用户在上一个设备上读得更远）→
				// 进度归零观感。所以先问一句 exists：在 → 跳过本次写入并重试。
				if (await this.fileExists(filePath)) {
					existed = true
					const tries = this.writeRetries.get(bookPath) ?? 0
					if (tries < WRITE_RETRY_MAX) {
						this.writeRetries.set(bookPath, tries + 1)
						debugWarn("[progress] 已有进度文件读不出来，跳过本次写入并重试", filePath, tries + 1)
						this.scheduleWrite(bookPath, WRITE_RETRY_MS)
					} else {
						debugWarn("[progress] 进度文件持续读不出来，放弃本次写入", filePath)
					}
					return
				}
			}
			if (raw !== null) {
				try {
					existed = true
					const disk = JSON.parse(raw) as Partial<ProgressFile>
					if (typeof disk.updatedAt === "number" && disk.updatedAt > payload.updatedAt) return
					// **位置没变就不写盘**（2026-09-13）：写一次 = 库里一次文件事件，官方文件列表
					// 会因此重算 UNreader/ 那一棵子树；移动端在抽屉隐藏窗口里的那次重算会把条目
					// 永久打成 hidden（「夹子在、内容不显示」）。滚动停下的每一拍都写一遍毫无必要 ——
					// 锚点与比例都没动，落盘字节除了 updatedAt 之外完全一样。
					if (pickAnchor(disk) === payload.anchor && (disk.fraction ?? 0) === payload.fraction) return
				} catch {
					// 字节读到了、只是解析不出来 = **文件本身损坏**（与上面的「读不到」是两件事）：
					// 它没有任何可用内容，覆盖写是唯一能把这本书记录修回来的动作。
					debugWarn("[progress] 进度文件损坏，按覆盖处理", filePath)
				}
			}
			await this.vault.adapter.write(filePath, text)
			this.writeRetries.delete(bookPath)
			debugInfo("[progress] write", bookPath, payload.anchor.slice(0, 24), payload.fraction.toFixed(3),
				existed ? "overwrite" : "create")
		} catch (e) {
			console.warn("[UNreader] 写入进度文件失败", filePath, e)
		}
	}

	/** 文件是否真的存在（判定不了就**当它存在** —— 宁可不写，也不覆盖一条读不出来的记录） */
	private async fileExists(filePath: string): Promise<boolean> {
		try {
			return await this.vault.adapter.exists(filePath)
		} catch {
			return true
		}
	}

	private async ensureFolder(): Promise<void> {
		const parts = this.folder.split("/").filter(Boolean)
		let cur = ""
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : `${cur}/${part}`
			const f = this.vault.getAbstractFileByPath(cur)
			if (f instanceof TFolder) continue
			try {
				await this.vault.createFolder(cur)
			} catch { /* 已存在或并发创建失败可忽略 */ }
		}
	}
}
