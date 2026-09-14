/**
 * 空闲调度：把「非关键路径的批量主线程工作」排到浏览器空闲时段。
 *
 * 为什么需要它而不是 `setTimeout(0)`：setTimeout 回到的是**普通任务队列**，
 * 与渲染、输入同优先级 —— 开书时它会在首帧绘制与恢复定位之间插队，两边都慢。
 * requestIdleCallback 明确只在「当前帧已绘制且仍有空闲」时回调，天然让路。
 *
 * ⚠️ WebKit（iOS / iPadOS 的 WKWebView，即 Obsidian 移动端）**没有
 * requestIdleCallback**，必须回落 —— 回落值取一个短宏任务（4ms），
 * 既保留「让出主线程」的语义，又不会像 0ms 那样连发抢占。
 */

/** 让出主线程：优先等浏览器空闲，但**最多等一帧多**就继续。
 *
 *  为什么两条腿走路：只用 requestIdleCallback 会在页面持续忙碌（滚动、
 *  动画、连续补载）时被无限期饿死 —— 时间片永远等不到，后台任务（如目录
 *  派生标题）迟迟完不成；只用定时器又退化成「与渲染抢优先级」。
 *  竞速的结果是：空闲时立刻跑（不占关键帧），忙碌时按帧节流继续推进。 */
export function idleYield(timeoutMs = 100): Promise<void> {
	return new Promise<void>(resolve => {
		let done = false;
		const finish = (): void => { if (!done) { done = true; resolve(); } };
		const ric = (globalThis as unknown as {
			requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
		}).requestIdleCallback;
		if (typeof ric === "function") ric(() => finish(), { timeout: timeoutMs });
		// 忙碌兜底：一帧多一点后无论如何继续，避免被饿死
		window.setTimeout(finish, 32);
	});
}

/** 等下一次真正的绘制提交（连续两帧），用于「等关键路径渲染收工」。 */
export function nextPaint(): Promise<void> {
	return new Promise<void>(resolve => {
		const raf = (cb: () => void): void => {
			if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(cb);
			else window.setTimeout(cb, 16);
		};
		raf(() => raf(() => resolve()));
	});
}
