/** 在页首自身的显隐动画期间，逐帧同步跟随它的阅读进度条和沉浸灯绳。
 *
 *  对 transition 做短暂采样，而不是猜一个固定延迟：CSS 动画结束后连续两帧
 *  没有运行中的动画就收尾；无动画时最多运行约 50ms，异常情况下 700ms 强制收口。
 *  返回的函数可用于换页或卸载时立即取消，避免旧视图的回调碰到新页面。
 */
export function followHeaderMotion(
	header: HTMLElement | null,
	sync: () => void,
	onFinish: () => void,
): () => void {
	const win = header?.ownerDocument.defaultView ?? window;
	const startedAt = win.performance.now();
	let frame: number | null = null;
	let stopped = false;
	let quietFrames = 0;

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		if (frame != null) win.cancelAnimationFrame(frame);
		frame = null;
	};

	const tick = (): void => {
		if (stopped) return;
		try { sync(); } catch { /* 同步失败不能让跟随循环泄漏 */ }
		const now = win.performance.now();
		let animating = false;
		try {
			animating = !!header?.isConnected
				&& header.getAnimations().some(animation => animation.playState === "running" || animation.pending);
		} catch { /* 老 WebView 无法枚举动画时使用安静帧兜底 */ }
		quietFrames = animating ? 0 : quietFrames + 1;
		if (now - startedAt >= 700 || (now - startedAt >= 48 && quietFrames >= 2)) {
			try { sync(); } catch { /* ignore */ }
			stop();
			try { onFinish(); } catch { /* 清理回调不能向外抛错 */ }
			return;
		}
		frame = win.requestAnimationFrame(tick);
	};

	try { sync(); } catch { /* 首帧同步失败时仍允许后续帧自愈 */ }
	frame = win.requestAnimationFrame(tick);
	return stop;
}
