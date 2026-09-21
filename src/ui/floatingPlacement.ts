/**
 * 统一的浮窗定位：同时服务于 SelectionToolbar 与 HighlightPopover
 * 目标：在“多种可能”下都能稳定贴附锚点、避免遮挡与溢出
 *
 * 覆盖场景：
 * - 锚点在视口四边/四角（顶部、底部、左侧、右侧、角落）
 * - 锚点为多行大包围盒 vs 单行小矩形
 * - 工具条中等高度（44px）vs 评论展开后高尺寸（~160px）
 * - 窄屏/宽屏、单栏/双栏、侧边栏钉住时可用宽度变化
 * - 底部存在章节快捷导航等常驻浮层时的避让
 * - 无锚点（侧边栏点击）时的居中回退
 */

export interface Bounds {
	/** 区域在定位坐标系中的原点偏移（默认 0）。正文区被钉住的侧边栏
	 *  右移时，bounds 需带上 left/top，居中/贴底才不偏到左下。 */
	left?: number
	top?: number
	width: number
	height: number
}

export interface Size {
	width: number
	height: number
}

export interface Placement {
	left: number
	top: number
	origin: string
}

function clamp(v: number, min: number, max: number): number {
	if (max < min) return min
	return Math.max(min, Math.min(v, max))
}

function isValidAnchor(r: DOMRect | null, bounds: Bounds): r is DOMRect {
	if (!r) return false
	if (!Number.isFinite(r.top) || !Number.isFinite(r.left) || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return false
	// 至少 1px 在视口内才视为有效锚点，否则按无锚点居中处理，避免在屏幕外产生随缘定位
	if (r.bottom < 0 || r.top > bounds.height || r.right < 0 || r.left > bounds.width) return false
	if (r.width < 0 || r.height < 0) return false
	return true
}

export function placeFloating(
	anchor: DOMRect | null,
	size: Size,
	bounds: Bounds,
	opts?: { margin?: number; gap?: number; vertical?: "center" | "bottom" },
): Placement {
	const margin = opts?.margin ?? 8
	const gap = opts?.gap ?? 8
	const vertical = opts?.vertical ?? "center"
	const tw = Math.max(0, size.width)
	const th = Math.max(0, size.height)
	const bw = Math.max(0, bounds.width)
	const bh = Math.max(0, bounds.height)
	const originX = bounds.left ?? 0
	const originY = bounds.top ?? 0

	// 尺寸异常或容器过小：直接居中并钳制
	if (tw === 0 || th === 0 || bw === 0 || bh === 0) {
		return { left: originX + margin, top: originY + margin, origin: "center center" }
	}

	// 无锚点：垂直居中或贴底（vertical:"bottom" 供选区工具条固定定位使用），
	// 侧栏打开等场景沿用旧 HighlightPopover 的居中逻辑
	if (!isValidAnchor(anchor, bounds)) {
		const left = originX + (bw - tw) / 2
		const top = vertical === "bottom"
			? originY + Math.max(margin, bh - th - margin)
			: originY + Math.max(margin, bh / 2 - th / 2 - 40)
		return {
			left: clamp(left, originX + margin, Math.max(originX + margin, originX + bw - tw - margin)),
			top: clamp(top, originY + margin, Math.max(originY + margin, originY + bh - th - margin)),
			origin: "center center",
		}
	}

	const r = anchor
	const centerX = r.left + r.width / 2
	const centerY = r.top + r.height / 2

	// 预计算可用空间，用于候选排序（空间越大越优先，避免先选“上方”却在上方空间极小时仍强行尝试）
	const spaceAbove = r.top - margin
	const spaceBelow = bh - r.bottom - margin

	// 候选生成：前 6 为“不遮挡锚点”的外置位（上方/下方 × 居中/左对齐/右对齐），后 4 为重叠回退
	type Candidate = { left: number; top: number; origin: string; priority: number; overlaps: boolean }
	const candidates: Candidate[] = []

	// 外置 - 居中（最符合阅读习惯：不遮挡正文）
	candidates.push({ left: centerX - tw / 2, top: r.top - th - gap, origin: "center bottom", priority: 0, overlaps: false })
	candidates.push({ left: centerX - tw / 2, top: r.bottom + gap, origin: "center top", priority: 1, overlaps: false })
	// 外置 - 锚点左对齐（锚点靠右时避免右侧溢出）
	candidates.push({ left: r.left, top: r.top - th - gap, origin: "left bottom", priority: 2, overlaps: false })
	candidates.push({ left: r.left, top: r.bottom + gap, origin: "left top", priority: 3, overlaps: false })
	// 外置 - 锚点右对齐（锚点靠左时避免左侧溢出）
	candidates.push({ left: r.right - tw, top: r.top - th - gap, origin: "right bottom", priority: 4, overlaps: false })
	candidates.push({ left: r.right - tw, top: r.bottom + gap, origin: "right top", priority: 5, overlaps: false })

	// 重叠回退：锚点过大、或上下均无空间时的兜底（允许覆盖锚点，但保证视口内可见）
	candidates.push({ left: centerX - tw / 2, top: r.top, origin: "center top", priority: 6, overlaps: true })
	candidates.push({ left: centerX - tw / 2, top: centerY - th / 2, origin: "center center", priority: 7, overlaps: true })
	candidates.push({ left: r.left, top: centerY - th / 2, origin: "left center", priority: 8, overlaps: true })
	candidates.push({ left: r.right - tw, top: centerY - th / 2, origin: "right center", priority: 9, overlaps: true })

	// 智能排序：若上方空间明显小于下方，优先尝试下方，避免“上方优先”导致频繁溢出后才回退
	// 但保持左/中/右的相对顺序，仅在“整组”层面交换上下
	if (spaceBelow > spaceAbove + 32) {
		// 下方空间充裕得多：把所有“下方”候选提前
		candidates.sort((a, b) => {
			const aIsBelow = a.top > r.bottom
			const bIsBelow = b.top > r.bottom
			if (aIsBelow !== bIsBelow) return aIsBelow ? -1 : 1
			return a.priority - b.priority
		})
	}

	// 阶段一：首个完全在视口内的候选（不依赖钳制）
	for (const c of candidates) {
		const fitsX = c.left >= margin && c.left + tw <= bw - margin
		const fitsY = c.top >= margin && c.top + th <= bh - margin
		if (fitsX && fitsY) {
			// 若候选是外置但因水平居中导致轻微溢出，可通过钳制挽救的情况，阶段一会判为不匹配；
			// 此时阶段二的最小溢出评估会将其钳制后选中，所以这里严格要求“无需钳制”
			return { left: c.left, top: c.top, origin: c.origin }
		}
	}

	// 阶段二：无完全匹配时，评估“钳制后”的溢出与遮挡，选综合代价最小者
	// 代价 = 溢出面积 + 重叠惩罚 + 优先级微调，溢出通过钳制后的位移距离近似
	let best: Candidate | null = null
	let bestCost = Infinity
	for (const c of candidates) {
		const clampedLeft = clamp(c.left, margin, Math.max(margin, bw - tw - margin))
		const clampedTop = clamp(c.top, margin, Math.max(margin, bh - th - margin))
		const overflowX = Math.abs(c.left - clampedLeft)
		const overflowY = Math.abs(c.top - clampedTop)
		// 水平溢出权重略低（钳制后仍可接受），垂直溢出权重更高（容易遮挡或出屏）
		const overflowCost = overflowX * 1.0 + overflowY * 1.2
		// 重叠惩罚：外置候选被钳制后若仍覆盖锚点，会产生遮挡，适当惩罚；但若所有外置均溢出，仍需接受重叠
		const rectAfter = { left: clampedLeft, top: clampedTop, right: clampedLeft + tw, bottom: clampedTop + th }
		const overlapsAfter = !(rectAfter.right < r.left || rectAfter.left > r.right || rectAfter.bottom < r.top || rectAfter.top > r.bottom)
		const overlapPenalty = overlapsAfter ? (c.overlaps ? 120 : 240) : 0
		// 优先级微调：保持原本的阅读习惯排序
		const cost = overflowCost + overlapPenalty + c.priority * 2
		if (cost < bestCost) {
			bestCost = cost
			best = c
		}
	}

	if (best) {
		return {
			left: clamp(best.left, margin, Math.max(margin, bw - tw - margin)),
			top: clamp(best.top, margin, Math.max(margin, bh - th - margin)),
			origin: best.origin,
		}
	}

	// 兜底：视口居中钳制（理论上不会走到）
	return {
		left: clamp(bw / 2 - tw / 2, margin, Math.max(margin, bw - tw - margin)),
		top: clamp(bh / 2 - th / 2, margin, Math.max(margin, bh - th - margin)),
		origin: "center center",
	}
}
