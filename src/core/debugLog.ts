/**
 * 可选的诊断日志（参考 UNmemos 的 logger 实现）：
 * 关闭时完全静默——不捕获、不存储，所有调用立即返回；开启后 `debugLog.*`
 * 调用与 main.ts 挂的全局 window error / unhandledrejection 钩子追加进
 * 有上限的内存环形缓冲，用户在设置页导出（复制 / 存库内文件）发给开发者。
 * 缓冲从不自动落盘。新代码的诊断请走本模块而非裸 console.*，
 * warn/error 仍镜像到控制台，本地 devtools 调试不受影响。
 */

export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
	/** 记录时间（epoch millis） */
	t: number
	level: LogLevel
	msg: string
}

/** 环形缓冲上限：够一次完整复现，内存占用极小 */
const MAX_ENTRIES = 1000
/** 单条消息上限，超长截断 */
const MAX_MSG = 2000

const entries: LogEntry[] = []
let enabled = false
let envProvider: (() => Record<string, string>) | null = null

export function isDebugEnabled(): boolean {
	return enabled
}

/** 当前缓冲条数（设置页计数用） */
export function entryCount(): number {
	return entries.length
}

/** 缓冲快照（拷贝，调用方可安全渲染） */
export function getEntries(): LogEntry[] {
	return entries.slice()
}

/**
 * 切换捕获开关。开启时记一条环境快照，导出报告始终带版本/平台上下文；
 * 关闭时清空缓冲——关即静默且为空。
 */
export function setDebugEnabled(value: boolean): void {
	if (value === enabled) return
	enabled = value
	if (value) {
		append("info", ["debug logging enabled"])
		if (envProvider) {
			try {
				append("info", ["env", envProvider()])
			} catch {
				// 环境采集绝不能弄垮插件
			}
		}
	} else {
		entries.length = 0
	}
}

/** 注入版本/平台/设置上下文（开启快照与导出报告用），main.ts 里装一次 */
export function setEnvProvider(fn: () => Record<string, string>): void {
	envProvider = fn
}

// info 只进缓冲（生命周期轨迹刷控制台纯属噪音）；warn/error 照旧镜像控制台
export function info(...parts: unknown[]): void {
	append("info", parts)
}

export function warn(...parts: unknown[]): void {
	console.warn("[UNreader]", ...parts)
	append("warn", parts)
}

export function error(...parts: unknown[]): void {
	console.error("[UNreader]", ...parts)
	append("error", parts)
}

export function clear(): void {
	entries.length = 0
}

/** console 劫持桥接入口（main.ts）：本插件带 [UNreader] 前缀的
 *  warn/error 进缓冲，模块名与级别按来源标注 */
export function appendConsole(level: Exclude<LogLevel, "info">, msg: string): void {
	append(level, [msg])
}

function append(level: LogLevel, parts: unknown[]): void {
	if (!enabled) return
	let msg = parts.map(fmt).join(" ")
	if (msg.length > MAX_MSG) msg = `${msg.slice(0, MAX_MSG)}…(truncated)`
	// 丢弃连续重复：卡死的循环不能把真正有用的历史刷出缓冲
	const last = entries[entries.length - 1]
	if (last && last.level === level && last.msg === msg) return
	if (entries.length >= MAX_ENTRIES) entries.shift()
	entries.push({ t: Date.now(), level, msg })
}

function fmt(v: unknown): string {
	if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`
	if (typeof v === "string") return v
	try {
		return JSON.stringify(v) ?? String(v)
	} catch {
		return String(v)
	}
}

/**
 * 生成可分享报告：头部带导出时间与实时环境上下文，随后是带时间戳的完整缓冲。
 * 去向（剪贴板 / 库内文件）由调用方决定。
 */
export function buildReport(): string {
	const lines: string[] = []
	lines.push("=== UNreader — debug log ===")
	lines.push(`exported at: ${new Date().toISOString()}`)
	if (envProvider) {
		try {
			for (const [k, v] of Object.entries(envProvider())) {
				lines.push(`${k}: ${v}`)
			}
		} catch {
			// 同上——环境采集不能弄垮导出
		}
	}
	lines.push(`entries: ${entries.length}`)
	lines.push("--------------------------------------")
	for (const e of entries) {
		lines.push(`[${new Date(e.t).toISOString()}] [${e.level}] ${e.msg}`)
	}
	return lines.join("\n")
}
