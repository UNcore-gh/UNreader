/** 阅读统计：**按条目累计的阅读时长**（单篇文章 / 单本书 / 单篇笔记各一条）。
 *
 *  ## 为什么单独一份存储
 *
 *  侧边栏卡片要显示「总阅读时长 / 上次阅读」这类统计，而插件此前**只记录位置**
 *  （`ProgressStore`：`anchor + fraction + updatedAt`），没有任何「读了多久」的概念。
 *  把时长塞进进度文件是不行的：进度文件是「一本书一个文件、冲突粒度小」的同步单元，
 *  而统计是**高频追加**的（每 15 秒一次 tick），追加写会把进度文件的冲突面放大。
 *  所以单开一份 `Data/Stats/reading.json`：整个库一个文件、只在去抖窗口结束时整体重写。
 *
 *  ## 冲突语义（说清楚，别指望它精确）
 *
 *  单一文件 = 整体覆盖。两端同时读同一篇时，后写的那端会把先写的增量冲掉
 *  （误差上限 = 一次会话的时长）。这里选择**不做行级合并**：统计只是「大概读了多少」，
 *  为它引入 CRDT 级别的复杂度不划算。读取时按 `ms` 取大值合并，尽量吸收他端结果。
 *
 *  ## 落点
 *
 *  `<数据根>/Data/Stats/reading.json`（`core/paths.ts` 的活绑定）。同时写一份
 *  `localStorage` 热缓存 —— 与 `ProgressStore` 同样的理由：去抖里的那次写盘
 *  在「应用被杀 / 后台被系统回收」时不会发生，而统计是**只增不减**的累计值，
 *  丢掉一次结算就永久少一截。热缓存在读取时与库内文件按 `ms` 取大。
 */

import { normalizePath, Vault } from "obsidian"
import { info as debugInfo, warn as debugWarn } from "./debugLog"

/** 统计文件所在目录（由 `main.ts` 传入 `core/paths.ts` 的活绑定值）。 */
export const READING_STATS_FILE = "reading.json"

/** 单次结算的最大计入值。tick 间隔是 15 秒，正常结算远小于它；
 *  取 90 秒是为了兜住「定时器被系统冻结一整段后一次性补齐」这类异常，
 *  不至于把一小时的挂机时间记成一篇文章的阅读时长。 */
export const MAX_SETTLE_MS = 90_000

/** 去抖写盘间隔：统计是低频只读展示，不需要像进度那样 1 秒级落地。 */
const WRITE_DEBOUNCE_MS = 4000

/** 热缓存 key 前缀（与 `ProgressStore` 的 `unreader-pos-hot` 并列，互不干扰）。 */
const HOT_PREFIX = "unreader-stats-hot"

export interface ReadingStat {
	/** 累计阅读毫秒 */
	ms: number
	/** 最后一次结算的时刻（≈「上次阅读」） */
	lastAt: number
	/** 结算过几次（会话数） */
	sessions: number
}

interface StatsFile {
	version: number
	items: Record<string, ReadingStat>
}

export function bookStatKey(path: string): string {
	return `book:${path}`
}

export function feedStatKey(feedId: string, entryId: string): string {
	return `feed:${feedId}:${entryId}`
}

export function noteStatKey(path: string): string {
	return `note:${path}`
}

function emptyStat(): ReadingStat {
	return { ms: 0, lastAt: 0, sessions: 0 }
}

function saneStat(raw: unknown): ReadingStat | null {
	if (!raw || typeof raw !== "object") return null
	const value = raw as Partial<ReadingStat>
	const ms = typeof value.ms === "number" && Number.isFinite(value.ms) ? Math.max(0, value.ms) : 0
	const lastAt = typeof value.lastAt === "number" && Number.isFinite(value.lastAt) ? value.lastAt : 0
	const sessions = typeof value.sessions === "number" && Number.isFinite(value.sessions) ? Math.max(0, Math.floor(value.sessions)) : 0
	if (ms <= 0 && sessions <= 0) return null
	return { ms, lastAt, sessions }
}

/** 把毫秒渲染成「3 小时 12 分 / 12 分 / 40 秒」；0 由调用方决定显示什么。 */
export function formatReadingDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return ""
	const totalSeconds = Math.round(ms / 1000)
	if (totalSeconds < 60) return `${totalSeconds} 秒`
	const totalMinutes = Math.floor(totalSeconds / 60)
	if (totalMinutes < 60) return `${totalMinutes} 分钟`
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60
	return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}

export class ReadingStatsStore {
	private cache = new Map<string, ReadingStat>()
	private timer: number | null = null
	/** 串行化整体重写：并发触发时后发先至会让旧 payload 覆盖新 payload。 */
	private chain: Promise<void> = Promise.resolve()
	private loaded = false

	constructor(
		private vault: Vault,
		/** 统计目录（`STATS_FOLDER`）。构造期捕获，切换数据根后由 `main` 重建。 */
		private folder: string,
		/** 库作用域，用于隔离同机多库的热缓存（与 `ProgressStore` 同一套语义）。 */
		private scope = "default",
	) {}

	get filePath(): string {
		return normalizePath(`${this.folder}/${READING_STATS_FILE}`)
	}

	private hotKey(): string {
		return `${HOT_PREFIX}:${encodeURIComponent(this.scope)}`
	}

	/** 启动加载：库内文件 + 本机热缓存，按 `ms` 取大合并（见文件头「冲突语义」）。 */
	async init(): Promise<void> {
		this.cache.clear()
		try {
			const raw = await this.vault.adapter.read(this.filePath)
			const parsed = JSON.parse(raw) as Partial<StatsFile>
			const items = parsed?.items
			if (items && typeof items === "object") {
				for (const [key, value] of Object.entries(items)) {
					const stat = saneStat(value)
					if (stat) this.cache.set(key, stat)
				}
			}
		} catch {
			// 文件不存在 / 解析失败都当作「还没有统计」——统计是可再生的近似值，
			// 不像进度那样丢了会让用户回到书首，因此不重试、不告警。
		}
		const hot = this.readHot()
		for (const [key, stat] of hot) {
			const current = this.cache.get(key)
			if (!current) {
				this.cache.set(key, stat)
				continue
			}
			// 取大合并：热缓存里可能是「库内文件没写成」的那一段。
			const merged: ReadingStat = {
				ms: Math.max(current.ms, stat.ms),
				lastAt: Math.max(current.lastAt, stat.lastAt),
				sessions: Math.max(current.sessions, stat.sessions),
			}
			this.cache.set(key, merged)
		}
		this.loaded = true
	}

	get(key: string): ReadingStat | null {
		return this.cache.get(key) ?? null
	}

	/** 累计一次阅读时长。`ms` 会被夹到 `[0, MAX_SETTLE_MS]`，返回累计后的快照。 */
	add(key: string, ms: number, at = Date.now()): ReadingStat {
		const delta = Math.max(0, Math.min(MAX_SETTLE_MS, Math.round(ms)))
		const current = this.cache.get(key) ?? emptyStat()
		if (delta > 0) {
			current.ms += delta
			current.sessions += 1
		}
		current.lastAt = Math.max(current.lastAt, at)
		this.cache.set(key, current)
		if (delta > 0) {
			this.writeHot()
			this.scheduleWrite()
		}
		return current
	}

	/** 本库累计阅读时长（可选按 key 前缀过滤，如 `book:` / `feed:` / `note:`）。 */
	total(prefix?: string): number {
		let sum = 0
		for (const [key, stat] of this.cache) {
			if (prefix && !key.startsWith(prefix)) continue
			sum += stat.ms
		}
		return sum
	}

	/** 条目数（诊断用）。 */
	get size(): number {
		return this.cache.size
	}

	/** 立即落盘（去抖窗口内的那次写）。关闭视图 / 退出应用 / 数据根切换时调用。 */
	async flush(): Promise<void> {
		if (this.timer != null) {
			window.clearTimeout(this.timer)
			this.timer = null
		}
		if (!this.loaded) return
		await this.enqueueWrite()
	}

	dispose(): void {
		if (this.timer != null) {
			window.clearTimeout(this.timer)
			this.timer = null
		}
	}

	private scheduleWrite(): void {
		if (this.timer != null) return
		this.timer = window.setTimeout(() => {
			this.timer = null
			void this.enqueueWrite()
		}, WRITE_DEBOUNCE_MS)
	}

	private enqueueWrite(): Promise<void> {
		const next = this.chain.catch(() => undefined).then(() => this.writeNow())
		this.chain = next
		return next
	}

	private async writeNow(): Promise<void> {
		try {
			await this.ensureFolder()
			const items: Record<string, ReadingStat> = {}
			for (const [key, stat] of this.cache) items[key] = stat
			const payload: StatsFile = { version: 1, items }
			await this.vault.adapter.write(this.filePath, JSON.stringify(payload))
		} catch (error) {
			debugWarn("[stats] 写盘失败", error)
		}
	}

	private async ensureFolder(): Promise<void> {
		const existing = this.vault.getAbstractFileByPath(this.folder)
		if (existing) return
		try {
			await this.vault.createFolder(this.folder)
		} catch {
			// 并发创建 / 已存在：交给随后的 write 报错（它有自己的 try）
		}
	}

	private readHot(): Map<string, ReadingStat> {
		const out = new Map<string, ReadingStat>()
		try {
			if (typeof window.localStorage === "undefined") return out
			const raw = window.localStorage.getItem(this.hotKey())
			if (!raw) return out
			const parsed = JSON.parse(raw) as Record<string, unknown>
			if (!parsed || typeof parsed !== "object") return out
			for (const [key, value] of Object.entries(parsed)) {
				const stat = saneStat(value)
				if (stat) out.set(key, stat)
			}
		} catch {
			// 热缓存坏掉不影响功能，只是少了「库内文件没写成」的兜底
		}
		return out
	}

	private writeHot(): void {
		try {
			if (typeof window.localStorage === "undefined") return
			const items: Record<string, ReadingStat> = {}
			for (const [key, stat] of this.cache) items[key] = stat
			window.localStorage.setItem(this.hotKey(), JSON.stringify(items))
		} catch (error) {
			debugInfo("[stats] 热缓存写入失败（忽略）", error)
		}
	}
}

/** 全局单例：卡片渲染器（`annotationsPanel` / `markdownNoteCards`）直接在渲染时读它，
 *  不必把统计穿过两条装配路径的 actions 接口 —— 与 `setActiveResourceStore` 同一套做法。 */
let activeStore: ReadingStatsStore | null = null

export function setActiveReadingStats(store: ReadingStatsStore | null): void {
	activeStore = store
}

export function getReadingStat(key: string): ReadingStat | null {
	return activeStore?.get(key) ?? null
}

export function getReadingTotal(prefix?: string): number {
	return activeStore?.total(prefix) ?? 0
}
