/** 卡片底栏左端的阅读进度环（三类列表卡共用一枚）。
 *
 *  两种形态，同一套 DOM / 同一尺寸，靠类名区分：
 *  · **比例环**（电子书 / RSS）：`fraction ∈ [0,1]`，环按比例填充；
 *  · **二态环**（markdown 笔记）：`state` = `read` / `unread`，即满环 / 空环
 *    （官方阅读模式自带滚动记忆、插件不落库，硬造一个假百分比没有意义 ——
 *    用户 2026-10-13 定稿）。
 *
 *  ## 为什么是 SVG 而不是 conic-gradient
 *
 *  ① `conic-gradient` 的圆心/起角在各引擎里表现一致但**无法在自定义属性里逐像素断言**
 *     （圆环在测试里要量「填了多少」只能读 stroke 的 dash 值）；② 深色主题下
 *  `conic-gradient` 的过渡端点会出现硬边，需要额外 `mask` 修；③ `svg` 的
 *  `stroke-dasharray` 可以被 `getComputedStyle` 直接读到 —— 这是回归断言的抓手。
 *
 *  `pathLength="100"` 把周长归一到 100，于是 `stroke-dasharray: <pct> 100` 就是
 *  「填 pct%」，不必算 2πr。
 *
 *  ⚠️ 本模块**不 import obsidian**（连 `setTooltip` 都不用，直接写原生 `title`）：
 *  它是卡片渲染链上最底层的一个小件，而三个探针的 obsidian stub 并没有导出全部 API
 *  （2026-10-13 实测：加了 `setTooltip` 直接让 `test:feed` / `test:rail-active` /
 *  `test:md-overlay` 三个探针**打包失败**）。少一个依赖 = 少一类「真机能跑、探针打不出来」。
 */

export interface ProgressRingOptions {
	/** 0~1；null / undefined = 不适用（既不画填充也不画空环，只留轨道） */
	fraction?: number | null
	/** 二态环：已读 / 未读。给了它就忽略 `fraction` */
	state?: "read" | "unread"
	/** 无障碍标签（必给，环本身没有文字） */
	label: string
	/** 鼠标悬停提示；不给就用 `label` */
	tooltip?: string
	/** 额外类名（如 `unreader-shelf-ring`），便于按卡片类型定向微调 */
	cls?: string
}

const SVG_NS = "http://www.w3.org/2000/svg"

/** 建一枚进度环。返回的元素就是底栏里的第一个子节点（CSS 靠类名定位）。 */
export function createProgressRing(options: ProgressRingOptions): HTMLElement {
	const doc = document
	const ring = doc.createElement("div")
	ring.className = options.cls ? `unreader-ring ${options.cls}` : "unreader-ring"

	const twoState = options.state != null
	const percent = twoState
		? (options.state === "read" ? 100 : 0)
		: Math.round(Math.max(0, Math.min(1, options.fraction ?? 0)) * 100)

	ring.classList.toggle("is-unread", twoState ? options.state === "unread" : percent === 0)
	ring.classList.toggle("is-complete", percent >= 100)
	ring.setAttribute("role", "img")
	ring.setAttribute("aria-label", options.label)
	// 读数出口：回归断言读它，比解析 SVG 属性稳。
	ring.dataset.ringPercent = String(percent)
	ring.dataset.ringState = twoState ? (options.state as string) : "fraction"

	// 自绘 SVG（不用 obsidian 的 setIcon：内置图标集里没有可控的进度环）。
	const svg = doc.createElementNS(SVG_NS, "svg")
	svg.setAttribute("viewBox", "0 0 36 36")
	svg.setAttribute("aria-hidden", "true")
	svg.setAttribute("focusable", "false")
	const track = doc.createElementNS(SVG_NS, "circle")
	track.setAttribute("class", "unreader-ring-track")
	track.setAttribute("cx", "18")
	track.setAttribute("cy", "18")
	track.setAttribute("r", "16")
	track.setAttribute("fill", "none")
	svg.appendChild(track)
	const fill = doc.createElementNS(SVG_NS, "circle")
	fill.setAttribute("class", "unreader-ring-fill")
	fill.setAttribute("cx", "18")
	fill.setAttribute("cy", "18")
	fill.setAttribute("r", "16")
	fill.setAttribute("fill", "none")
	fill.setAttribute("pathLength", "100")
	fill.setAttribute("stroke-dasharray", `${percent} 100`)
	svg.appendChild(fill)
	ring.appendChild(svg)

	// 原生 title 而不是 obsidian 的 setTooltip：见文件头（探针 stub 没有那个导出）
	ring.setAttribute("title", options.tooltip ?? options.label)
	return ring
}

/** 就地更新一枚已存在的环（卡片原地刷新时不必重建 DOM）。 */
export function updateProgressRing(ring: HTMLElement, percent: number): void {
	const clamped = Math.round(Math.max(0, Math.min(100, percent)))
	const fill = ring.querySelector(".unreader-ring-fill")
	if (fill) fill.setAttribute("stroke-dasharray", `${clamped} 100`)
	ring.classList.toggle("is-unread", clamped === 0)
	ring.classList.toggle("is-complete", clamped >= 100)
	ring.dataset.ringPercent = String(clamped)
}
