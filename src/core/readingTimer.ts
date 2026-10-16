/** 阅读计时器：把「某条目当前正在被阅读」翻译成累计时长。
 *
 *  ## 计时口径
 *
 *  · **按 key 记账**：`book:<path>` / `feed:<feedId>:<entryId>` / `note:<path>`，
 *    与侧边栏卡片、`readerView.sourceKey()` 同一套 key（见 `readingStatsStore.ts`）。
 *  · **只有「真的在读」才计时**：以下任一条件成立即**暂停**（暂停时先把已过去的时间结算掉）：
 *      ① 文档不可见（`visibilitychange` → hidden，移动端切后台/锁屏）
 *      ② 窗口失焦（`window.blur`，桌面端切到别的 App）
 *      ③ 长时间无输入（默认 3 分钟没有任何 pointer/key/scroll 事件 —— 人走了没关页面）
 *    恢复时重新起算，**不补记**暂停期间的时间。
 *  · **结算粒度**：每 `intervalMs`（默认 15 秒）结算一次，每次计入的增量被
 *    `MAX_SETTLE_MS` 夹住（见 `readingStatsStore.add`）—— 定时器被系统冻结后
 *    一次性补齐时不会把整段挂机时间记成阅读时间。
 *
 *  ## 为什么不做「单次会话上限」
 *
 *  连续读 3 小时是真实场景，不该被截断；真正需要防的是**没有输入的空转**，
 *  而那由上面的 ③ 直接解决（3 分钟无输入即暂停）。所以上限只放在
 *  「单次结算增量」这一层，不放会话层。
 */

import { MAX_SETTLE_MS, ReadingStatsStore } from "./readingStatsStore"

/** 结算间隔。选 15 秒：足够细（丢一次也只丢 15 秒），又不会给主线程添频次。 */
const DEFAULT_INTERVAL_MS = 15_000

/** 无输入多久算「人走了」。 */
const IDLE_PAUSE_MS = 180_000

/** 认作「用户还在」的输入事件。全部 passive，不干预滚动性能。 */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focusin"] as const

export class ReadingTimer {
	/** key → 本段起算时刻（`performance.now()` 域，只用差值） */
	private active = new Map<string, number>()
	private tickTimer: number | null = null
	private idleTimer: number | null = null
	/** 暂停原因（可见性 / 失焦 / 闲置）——任一成立即暂停，全部解除才恢复 */
	private pausedByVisibility = false
	private pausedByFocus = false
	private pausedByIdle = false
	private listening = false

	constructor(
		private stats: ReadingStatsStore,
		private intervalMs = DEFAULT_INTERVAL_MS,
	) {}

	/** 开始为某个条目计时（重复调用同一 key 是幂等的）。
	 *  **换内容请先 `stop` 旧的** —— 本方法不会替你停掉别的 key（分屏里两个视图
	 *  可以同时是真的在读，此时两条都该计时）。 */
	start(key: string): void {
		if (!key || this.active.has(key)) return
		this.settleAll()
		this.active.set(key, this.now())
		this.ensureListening()
		this.scheduleTick()
		this.scheduleIdleCheck()
	}

	/** 停止计时并**立刻结算**这一段。 */
	stop(key: string): void {
		if (!this.active.has(key)) return
		this.settleAll()
		this.active.delete(key)
		if (this.active.size === 0) this.stopTimers()
	}

	/** 停掉全部并结算（视图关闭 / 应用退出）。 */
	stopAll(): void {
		if (this.active.size) this.settleAll()
		this.active.clear()
		this.stopTimers()
	}

	/** 当前正在计时的条目（诊断 / 测试用）。 */
	get activeKeys(): string[] {
		return [...this.active.keys()]
	}

	/** 结算所有在跑的条目（不改变「在跑」这个状态）：tick、暂停、停止都走它。 */
	private settleAll(): void {
		if (!this.active.size) return
		const now = this.now()
		for (const [key, startedAt] of this.active) {
			const elapsed = now - startedAt
			this.active.set(key, now)
			if (elapsed <= 0) continue
			this.stats.add(key, Math.min(elapsed, MAX_SETTLE_MS))
		}
	}

	private get suspended(): boolean {
		return this.pausedByVisibility || this.pausedByFocus || this.pausedByIdle
	}

	private suspend(reason: "visibility" | "focus" | "idle"): void {
		this.settleAll()
		if (reason === "visibility") this.pausedByVisibility = true
		else if (reason === "focus") this.pausedByFocus = true
		else this.pausedByIdle = true
		this.clearTick()
	}

	private resume(reason: "visibility" | "focus" | "activity"): void {
		if (reason === "visibility") this.pausedByVisibility = false
		else if (reason === "focus") this.pausedByFocus = false
		else this.pausedByIdle = false
		if (this.suspended || !this.active.size) return
		// 重新起算：暂停期间的时间不补记。
		const now = this.now()
		for (const key of this.active.keys()) this.active.set(key, now)
		this.scheduleTick()
		this.scheduleIdleCheck()
	}

	private scheduleTick(): void {
		if (this.tickTimer != null || !this.active.size || this.suspended) return
		this.tickTimer = window.setTimeout(() => {
			this.tickTimer = null
			if (!this.active.size || this.suspended) return
			this.settleAll()
			this.scheduleTick()
		}, this.intervalMs)
	}

	private clearTick(): void {
		if (this.tickTimer != null) {
			window.clearTimeout(this.tickTimer)
			this.tickTimer = null
		}
	}

	private stopTimers(): void {
		this.clearTick()
		if (this.idleTimer != null) {
			window.clearTimeout(this.idleTimer)
			this.idleTimer = null
		}
	}

	/** 闲置计时：每次真实输入都重置；到点即暂停，下一次输入再恢复。 */
	private scheduleIdleCheck(): void {
		if (this.idleTimer != null) return
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null
			if (!this.active.size) return
			this.suspend("idle")
		}, IDLE_PAUSE_MS)
	}

	private onActivity = (): void => {
		if (this.pausedByIdle) this.resume("activity")
		else this.scheduleIdleCheck()
	}

	private onVisibility = (): void => {
		if (typeof document === "undefined") return
		if (document.visibilityState === "hidden") this.suspend("visibility")
		else this.resume("visibility")
	}

	private onBlur = (): void => this.suspend("focus")

	private onFocus = (): void => this.resume("focus")

	/** 监听只在「有条目在计时」时挂上，空闲期不占任何监听器。 */
	private ensureListening(): void {
		if (this.listening) return
		this.listening = true
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.onVisibility)
			for (const type of ACTIVITY_EVENTS) {
				document.addEventListener(type, this.onActivity, { passive: true, capture: true })
			}
		}
		if (typeof window !== "undefined") {
			window.addEventListener("blur", this.onBlur)
			window.addEventListener("focus", this.onFocus)
		}
		// 挂监听的那一刻状态可能已经是「不可见 / 失焦」，先对齐一次。
		this.onVisibility()
	}

	dispose(): void {
		this.stopAll()
	}

	private now(): number {
		return typeof performance !== "undefined" ? performance.now() : Date.now()
	}
}
