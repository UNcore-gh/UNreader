/** 左右浮动轨道（功能轨 + 章节短横轨）纵向边界的**冻结判据** —— 纯函数，可单测。
 *
 *  ## 要解决什么（用户 2026-10-16 报障「chrome 显隐时左右轨道上下抖动」，同类问题修过两轮）
 *
 *  两条轨的纵向位置是 `top:50% + translateY(-50%) + margin-top:var(--ur-*-center-shift)`，
 *  而 center-shift 由 `readerView.syncActionsAvailableHeight` 写。只要它在 chrome 过渡期间
 *  被逐帧改写成不同值，轨道就会跟着上下抖（margin-top 不参与过渡 ⇒ 是跳变不是滑动）。
 *
 *  两个会随过渡逐帧变化的量：
 *   · **上边界 = 灯绳实测底边**。灯绳是唯一「允许跟随页首」的元素，页首/灯绳滑动的 0.3s 里
 *     它的 rect.bottom 一直在变；
 *   · **下边界 = 原生底栏 / 播客条的让位量**。两者都用 transform 滑动，过渡期间实测值在变。
 *
 *  历史上的修法都是「按元素内省」：`Element.getAnimations()` 看谁在跑动画。
 *  ⚠️ 那条路在**移动端 WebView 上不可靠**（iOS/Android 的系统 WebView 对
 *  `getAnimations()` 返回 CSS 过渡的支持与桌面 Chromium 有差异），一旦内省漏判，
 *  「页首已稳定」就会被误判成真，缓存被跳过、实时值直接写进轨道 —— 正是这个报障的形态。
 *  因此本模块把主判据换成**确定性时间窗口**：chrome 可见性被改动的随后一段时间内
 *  （`RAIL_FREEZE_MS`，覆盖官方 0.3s 过渡 + 余量），无论内省说什么，一律沿用缓存值。
 *  内省结果仍然参与（作为附加闸），只是不再独自承重。
 *
 *  ## 设计契约（与旧实现逐条对应，别随意改）
 *
 *   · **两态同一个数**：页首可见态与隐藏态下，轨道可用区算出同一个 top/bottom
 *     （缓存只在「可见且稳定」时刷新）—— 这是「除拉绳外所有元素固定」的实现。
 *   · **稳态自愈**：不冻结且两处都稳定时，缓存跟随实测值刷新（视口/布局真的变了要跟上）。
 *   · **播客条离场立刻归还空间**：display:none / visibility:hidden / 卸载 ⇒ 缓存清空。
 *   · 全部输入由调用方给（body 坐标），本函数不碰 DOM —— 照 `nativeNavPolicy.ts` 的先例。
 */

/** 冻结窗口：官方页首/底栏 transform 过渡 0.3s + 灯绳/轨道 0.2~0.3s + 余量。
 *  ⚠️ 不能短于 0.3s：窗口早于过渡结束就会放进半个过渡的实测值（轨道的跳变源）。
 *  也不能长得离谱：窗口内合法的布局变化（播客条入场等）会被延迟到窗口结束。 */
export const RAIL_FREEZE_MS = 420;

/** 探针阴性开关：关掉**时间窗口**这条主判据（生产恒 false）。
 *
 *  只有 `test:chrome-motion` 的 railBounds 档会设这个键（`?break=railfreeze`）。
 *  它模拟的是「内省漏判 + 无时间窗口」= 旧实现的失败形态：过渡期间实测值被逐帧写进
 *  轨道 ⇒ 那一档必须变红，用来证明时间窗口真的在承重（不是搭内省那条路的便车）。 */
function railFreezeBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_RAIL_FREEZE === true;
	} catch {
		return false;
	}
}

export interface RailBoundsInput {
	/** body 顶边（视口坐标） */
	readonly bodyTop: number;
	/** body 底边（视口坐标） */
	readonly bodyBottom: number;
	/** 上边界实测候选（视口坐标）：max(bodyTop, 灯绳实时底边) */
	readonly measuredTop: number;
	/** 页首「可见且稳定」：状态字段 + 无过渡动画（内省结果参与，但不再独自承重） */
	readonly headerStableVisible: boolean;
	/** 原生栏 / 播客条「稳定」：无隐藏类、无过渡动画 */
	readonly barsStable: boolean;
	/** 距最近一次 chrome 可见性改动的毫秒数（Infinity = 从未改动） */
	readonly sinceMotionMs: number;
	/** 冻结窗口时长（传 RAIL_FREEZE_MS；探针可传小值加速） */
	readonly freezeMs: number;
	/** 缓存：页首可见时捕获的上边界（视口坐标；null = 尚未捕获） */
	readonly cachedTop: number | null;
	/** 缓存：原生底栏让位量（px） */
	readonly cachedNativeInset: number | null;
	/** 实测：原生底栏让位量（px） */
	readonly measuredNativeInset: number;
	/** 缓存：播客条让位量（px） */
	readonly cachedPodcastInset: number | null;
	/** 实测：播客条让位量（px；null = 当前没有可测的播客条几何） */
	readonly measuredPodcastInset: number | null;
	/** 播客条是否「在场」（元素在 DOM 且未被 display/visibility 关掉）。
	 *  与 measuredPodcastInset 的区别：过渡中段 rect 可能暂时量不到，但栏仍在场 ⇒ 缓存要留。 */
	readonly podcastPresent: boolean;
}

export interface RailBoundsResult {
	/** 上边界（视口坐标，已与缓存合并） */
	readonly top: number;
	/** 下边界（视口坐标，已扣让位） */
	readonly bottom: number;
	/** 回写：上边界缓存 */
	readonly nextCachedTop: number | null;
	/** 回写：原生底栏让位缓存 */
	readonly nextCachedNativeInset: number | null;
	/** 回写：播客条让位缓存 */
	readonly nextCachedPodcastInset: number | null;
}

export function resolveRailBounds(i: RailBoundsInput): RailBoundsResult {
	// 主判据：确定性时间窗口。内省（headerStableVisible / barsStable）是附加闸 ——
	// 两条一路取或，任何一条说「别动」就不动。
	const frozen = !railFreezeBreak() && i.sinceMotionMs < i.freezeMs;
	const topFrozen = frozen || !i.headerStableVisible;
	const bottomFrozen = frozen || !i.barsStable;

	const top = topFrozen && i.cachedTop != null
		? Math.max(i.measuredTop, i.cachedTop)
		: i.measuredTop;

	const nativeInset = bottomFrozen && i.cachedNativeInset != null
		? i.cachedNativeInset
		: i.measuredNativeInset;
	let bottom = i.bodyBottom - nativeInset;

	let nextPodcast = i.cachedPodcastInset;
	if (!i.podcastPresent) {
		// 播客条确实关闭/卸载：立刻归还空间，不等窗口结束
		nextPodcast = null;
	} else if (i.measuredPodcastInset != null) {
		const inset = bottomFrozen && i.cachedPodcastInset != null
			? i.cachedPodcastInset
			: i.measuredPodcastInset;
		bottom = Math.min(bottom, i.bodyBottom - inset);
		if (!bottomFrozen) nextPodcast = inset;
	}
	// else：栏在场但此刻量不到几何（过渡中段/首帧）⇒ 留缓存、不刷新

	// 缓存刷新：仅「窗口已过 + 两处都稳定」时。稳态才采样，过渡中段不采 ——
	// 把半路上的值写进缓存，窗口结束后它会变成新的「稳定值」，轨道就真的歪了。
	const canRefresh = !frozen && i.headerStableVisible && i.barsStable;
	return {
		top,
		bottom,
		nextCachedTop: canRefresh ? top : i.cachedTop,
		nextCachedNativeInset: canRefresh ? nativeInset : i.cachedNativeInset,
		nextCachedPodcastInset: nextPodcast,
	};
}
