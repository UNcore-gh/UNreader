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

/**
 * 探针的「阴性对照」开关：把「自家浮层栈 / 铺满整屏的背板不算外部遮挡」
 * 这两条排除注回旧行为（生产恒 false）。
 *
 * 只有 `test:comment-mobile` 会设这个键（`?break=occself`）。开了它，
 * 高亮浮窗评论弹框那块 `inset:-4000px` 的 `.unreader-comment-scrim` 会被重新
 * 当成「压住我的那条栏」⇒ 工具条被无理由顶到屏幕顶部 —— 用同一条断言一绿一红
 * 证明这两条排除是真的在承重（2026-10-12）。
 */
function occluderBackdropBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_OCC_SELF === true;
	} catch {
		return false;
	}
}

/**
 * **命中测试**这条路的阴性总闸（生产恒 false）：关掉后 `occlusionCeiling` 直接返回
 * `null`（= 什么都没被挡住）。
 *
 * 为什么单独留一个总闸（2026-10-12 第三次真机报障后补）：现在的「不被官方栏盖住」
 * 有**两条互相独立**的保障 ——
 *   ① `occlusionCeiling`（`elementFromPoint` 命中测试，受绘制顺序 / `pointer-events`
 *      / 层叠上下文裁剪影响，**实现相关**）；
 *   ② `keyboardInset.nativeBarOverlapTop`（纯 `getBoundingClientRect` 相交，
 *      **实现无关**，见 `selectionToolbar.clampAboveNativeBars`）。
 * 要证明 ② 自己承重（不是搭 ① 的便车），就必须把 ① 关掉；否则任何「② 失效」的档
 * 都会被 ① 救回来 ⇒ 断言假绿、② 悄悄烂掉也没人知道。
 * 只有 `test:md-kb` 会设这个键（`?break=occhit`）。
 */
function occlusionHitBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_OCC_HIT === true;
	} catch {
		return false;
	}
}

/**
 * 浮层自己的宿主根：`.unreader-comment-scrim` 这类**自家背板**与浮层挂在
 * 同一个根下（正文浮层的 `.unreader-body`、md 寄生层的 `.unreader-md-root`）。
 * 从元素往上找最近的这一个，就得到「我们自己的浮层栈」的边界。
 */
const OWN_SCOPE_SELECTOR = ".unreader-md-root, .unreader-root, .unreader-body";

/**
 * **实测遮挡**：浮层已经摆好后，量「它的中心/底边到底是谁」。
 *
 * 为什么不能只靠几何推算（2026-10-12 真机二次报障「实时编辑档划词工具条仍被
 * Obsidian 快速编辑栏压住」）：
 *   Obsidian 移动端的 `.mobile-toolbar`（快速编辑栏）由核心在**编辑器聚焦时**
 *   动态 `appendChild` 到 `.app-container`（asar app.js 实测 `mobileToolbar.show()`），
 *   同时追加一条 `.mobile-toolbar-spacer`（`height:var(--mobile-toolbar-height)`，
 *   流内 flex 子项）把 `.workspace` 顶上去 52px；`hide()` 再整组 `detach()`。
 *   两次变更**都不发任何 resize / visualViewport 事件**，而且它自己的位置由
 *   `top: calc(100vh - var(--keyboard-height) - var(--mobile-toolbar-height))` 决定，
 *   还会被 `animateToKeyboardHeight()` 用内联 `translateY` 动画补一次位移。
 *   ⇒ 任何「按事件算一次」的几何模型都可能与最终像素不一致。
 *
 * 所以这里不再猜：把浮层摆下去，用 `elementFromPoint` **问浏览器谁在上面**。
 * 采两条线（底边内侧 6px + 垂直中点），任一条命中的不是自身子树就说明被压住，
 * 返回遮挡物的顶边（视口坐标 y）——调用方把可用区底边收到它之上再排一次即可。
 *
 * 返回 `null` = 没被任何东西遮住（含取不到几何、`elementFromPoint` 不可用）。
 */
export function occlusionCeiling(doc: Document, el: HTMLElement, inset = 6): number | null {
	if (typeof doc.elementFromPoint !== "function") return null;
	if (occlusionHitBreak()) return null;
	// **自身尚未真正可见时不做命中**（2026-10-13 真机/桌面复现的工具栏闪烁根因）：
	// 工具条首次落位要走 110ms 的 `visibility:hidden → visible` 过渡（基础规则
	// `transition: visibility 110ms`；Chrome 对 visibility 的离散插值在**终点**才跳到
	// visible，过渡期间 computed 仍是 hidden）。此刻 elementFromPoint 会**穿过工具条**
	// 命中正文行（.cm-line / 正文段落），被误判成「外部遮挡物」，避让逻辑于是连续几轮
	// 把工具条往屏幕顶部抬（554→412→208），过渡结束检测恢复又被 geometry 拉回底部
	// —— 用户看到工具条快速窜到顶部再回来（闪烁）。visibility 真正可见后再检测
	// （过渡结束的补检见 SelectionToolbar.reposition）。
	// 阴性对照出口（?break=visguard）：注回旧行为——transition 中继续做命中，
	// 必须重新穿过工具条误命中正文（md-kb M3 档的牙口）。
	if (doc.defaultView?.getComputedStyle(el).visibility !== "visible"
		&& !(globalThis as unknown as { __UR_BREAK_VIS_GUARD?: boolean }).__UR_BREAK_VIS_GUARD) return null;
	const r = el.getBoundingClientRect();
	if (!(r.width > 0) || !(r.height > 0)) return null;
	const cx = r.left + r.width / 2;
	// 底边内侧优先：浮层被「下沿压住一截」时中心点往往还在自己身上，只看中心会漏判
	const lines = [r.bottom - Math.min(inset, r.height / 2), r.top + r.height / 2];
	/** 我们自己的浮层栈（见 OWN_SCOPE_SELECTOR）：这层里的东西不是「外部遮挡」 */
	const ownScope = el.closest(OWN_SCOPE_SELECTOR);
	const vh = doc.defaultView?.innerHeight ?? 0;
	const breakBackdrop = occluderBackdropBreak();
	let ceiling: number | null = null;
	for (const y of lines) {
		let hit: Element | null = null;
		try {
			hit = doc.elementFromPoint(cx, y);
		} catch {
			hit = null;
		}
		if (!hit || hit === el || el.contains(hit)) continue;
		// 命中的是**祖先**（宿主 / 正文滚动层）时不是遮挡：那说明这条线上压根没有
		// 别的东西，`elementFromPoint` 落回了背景。收它的顶边会把浮层无理由地顶到
		// 屏幕左上角（祖先的 top 通常是 0）。
		if (hit.contains(el)) continue;
		const hr = hit.getBoundingClientRect();
		if (!(hr.height > 0)) continue;
		// ⚠️ 两条「不是外部遮挡」的排除（2026-10-12，`test:comment-mobile` 暴露）：
		//
		// ① **自家浮层栈**：`.unreader-comment-scrim` 这类背板与浮层共享同一个宿主根
		//    （工具条 / 高亮浮窗都挂在 `.unreader-body` 或 `.unreader-md-root` 下）。
		//    它是**我们自己的弹框背板**，不是「Obsidian 压在我上面的那条栏」。
		//    把它当遮挡物 → 收到它那负到屏外（`inset:-4000px`）的顶边 → 可用区被压到
		//    下界 120px → 浮层被钳到 `top:8px`：**浮层无理由地跳到屏幕顶部**。
		//    危害不止是位置错：它会**沉默地**把「贴底 / 越界」类断言变成恒真
		//    （`bottom:141 <= limit:172` 照样过）—— 这正是当时 3 条断言假绿的来源。
		// ② **铺满整屏的背板**：遮挡物必须是一条**落在视口内**的「带」——
		//    原生栏恒满足 `top > 0` 且高度只有几十 px。顶边在视口之上、或高度覆盖整屏的，
		//    是遮罩 / 背板；抬到它之上没有意义（整屏都被盖住），一律不算。
		if (!breakBackdrop) {
			if (ownScope && ownScope !== el && ownScope.contains(hit)) continue;
			if (vh > 0 && (hr.top < 0 || hr.height >= vh)) continue;
		}
		// 遮挡物必须**真的压住这条采样线**（顶边不高于线、底边不低于线）。
		// 否则命中的只是同层的背景/祖先，收它顶边会把浮层无理由地顶上去。
		if (hr.top > y + 1 || hr.bottom < y - 1) continue;
		if (ceiling == null || hr.top < ceiling) ceiling = hr.top;
	}
	return ceiling;
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
