// 开书/定位性能打点：localStorage["unreader-perf"]="1" 开启，默认零开销。
// 用法：perfBegin(tag) → perfEnd(tag) 输出耗时；perfPoint(tag) 输出距开书起点的毫秒。
let enabled: boolean | null = null

const isOn = (): boolean => {
	if (enabled == null) {
		try { enabled = window.localStorage.getItem("unreader-perf") === "1" } catch { enabled = false }
	}
	return enabled
}

const beginAt = new Map<string, number>()
let bootAt = 0

/** 重置计时起点（每次开书调用一次） */
export function perfReset(): void {
	if (!isOn()) return
	bootAt = performance.now()
	beginAt.clear()
	console.debug("[UNreader][perf] ---- open book ----")
}

/** 距开书起点打一个时间点 */
export function perfPoint(tag: string): void {
	if (!isOn()) return
	console.debug(`[UNreader][perf] +${Math.round(performance.now() - bootAt)}ms ${tag}`)
}

/** 开始一段计时 */
export function perfBegin(tag: string): void {
	if (!isOn()) return
	beginAt.set(tag, performance.now())
}

/** 结束一段计时，输出耗时 */
export function perfEnd(tag: string): void {
	if (!isOn()) return
	const t0 = beginAt.get(tag)
	if (t0 == null) return
	beginAt.delete(tag)
	console.debug(`[UNreader][perf] ${tag}: ${Math.round(performance.now() - t0)}ms`)
}
