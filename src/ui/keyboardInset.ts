/**
 * 移动端「键盘 / 原生栏」几何 —— 供所有「可能被输入法盖住」的浮层与输入框共用。
 *
 * 为什么需要它（两条非显然事实，均取自 obsidian.asar 官方 app.css 实测）：
 *
 * 1. **键盘弹起时官方收缩的是「容器」，不是「视口」**：
 *    `body.is-mobile .app-container { max-height: calc(100vh - var(--keyboard-height)) }`
 *    （动画期间 `body.is-mobile.keyboard-animating .app-container { max-height: 100vh }`）。
 *    插件视图（`.unreader-body`）跟着变矮，但**任何用「展开前测得的 bounds」算出的绝对
 *    top/height 都不会自动跟随** —— 元素停在旧坐标上，被 `.unreader-body { overflow: hidden }`
 *    裁掉，用户看到的就是「输入框跑到输入法下面去了」。
 *    → 展开输入区之后，必须用**现测**几何重排，而不能复用展开前那份 bounds。
 *
 * 2. **键盘上方还有原生浮层，会盖住收缩后容器的最后一段**：
 *    · `.mobile-toolbar`（快速编辑栏）＝ `position: absolute; top: calc(100vh - var(--keyboard-height) - var(--mobile-toolbar-height))`，
 *      即键盘上沿往上 52px，正好压在收缩后的容器底部；
 *    · `is-floating-nav` 下的 `.mobile-navbar`（悬浮导航栏）同理浮在屏幕底部。
 *    → 可用区底边 = min(容器底, 可视视口底, 这两条栏的**顶边**)。
 *
 * 3. **⚠️ 有整整一档，容器是「故意不收缩」的**（asar 实测，真机上最容易复现「输入框跑到
 *    输入法下面」的窗口）：
 *    `body.is-mobile.keyboard-animating .app-container { max-height: 100vh }`
 *    —— 键盘**动画期间**官方把上面那条收缩规则让开，容器回到满高；而这一段里
 *    **没有任何 resize 事件**（几何要到动画结束才变），`.mobile-toolbar` 在阅读视图里又是
 *    隐藏的（官方只在校验器聚焦时才显示它），`.mobile-navbar` 在 `keyboardWillShow` 时被收掉。
 *    于是「容器收缩」「原生栏」两路信号**全部缺席**，只剩：
 *      · `visualViewport`（iOS 有效；Android WebView 不收缩布局视口时它同样不缩）；
 *      · 官方变量 `--keyboard-height`（原生层写的，:`root` 上的默认值是 `0px`）。
 *    → 所以变量必须当成**第三条独立信号**并进可用区底边：
 *      键盘上沿 ＝ 布局视口高（`documentElement.clientHeight`）− 键盘高。
 *      在容器已按官方规则收缩的常规档位上，它算出来恒等于容器底边（整屏高 − 键盘高），
 *      取 min 是**恒等变换、不改变任何结果**；只有上面那一档才会真正生效。
 *      反面例子（务必保留这条推理）：如果布局视口本身已经被 WebView 收缩，而原生层仍然写了
 *      非零键盘高，就会重复减一次键盘 —— 那种组合会让官方自己的 `.app-container`
 *      收缩到 `(100vh − 键盘高) − 键盘高`、整个 app 打字时被压扁，所以现实中不存在。
 *
 * 4. 变量由原生层写入，官方自己两处读法并存（`documentElement` 与 `body` 的计算样式）。
 *    本模块只读 `body` 的计算值：变量写在哪一层都拿得到；只读 `documentElement` 会在
 *    「变量落在 body 上」时拿到 `:root` 的默认 0px。**插件只读不写这个变量。**
 *
 * 用法：
 *   · 定位/滚动之前：`usableBottom(host)` 取可用区底边（视口坐标）。
 *   · **贴底铺满的不透明面板**（标注侧边栏）：`bottomBarOverlap(host)` 取它该为
 *     屏幕底那条原生栏让出多少像素 —— 与 `usableBottom` 共用 `nativeBarTop` 一份判据。
 *   · 展开输入区之后：`subscribeKeyboardGeometry(host, cb)`，在 cb 里用**现测**的 bounds 重算。
 *     订阅里带一小段收敛梯子 —— 键盘收缩与原生栏入场都是**动画**，iPad 上快速编辑栏还可能
 *     比键盘晚 ~2s 才显示（期间没有任何 resize 事件），所以既挂 ResizeObserver，
 *     也在启用后的一段时间内按固定节奏重测几次；另外单独盯 `--keyboard-height` 的写入
 *     （第 3 条那一档里，那是**唯一**会来的信号，见 subscribeKeyboardGeometry）。
 */
import { Platform } from "obsidian";

/** Obsidian 在键盘状态变化时派发到 window 的事件（核心 app.js 实测） */
const KEYBOARD_EVENTS = ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"];

/**
 * 收敛梯子：输入区展开后的一小段时间内按这些延时重测。
 * 覆盖「键盘动画（~250ms）→ 原生栏入场（iPad 实测可迟到 ~2s）」的整个窗口。
 */
const CONVERGE_LADDER = [60, 140, 260, 420, 650, 950, 1400, 2000];

/** 会被键盘覆盖的原生浮层：顶边高者优先（取 min） */
const NATIVE_BARS = [".mobile-toolbar", ".mobile-navbar"];

/** 原生层写入键盘高度的官方变量（官方默认值见 `:root { --keyboard-height: 0px }`） */
const KEYBOARD_VAR = "--keyboard-height";

export function isMobileLike(): boolean {
	return Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp;
}

/**
 * 键盘高度（px）。缺失 / 空 / 非法 / 非正一律回落到 0（= 没有软键盘）。
 *
 * 读 `body` 的计算样式而不是 `documentElement`：官方两处读法并存（变量写在哪一层都有可能），
 * 而自定义属性是**向下继承**的 —— 从 body 读两种写法都能拿到，从 documentElement 读则会在
 * 「变量落在 body」时拿到 `:root` 的默认 0px。
 */
function keyboardHeightPx(doc: Document): number {
	const win = doc.defaultView ?? window;
	const el = doc.body ?? doc.documentElement;
	if (!el || typeof win.getComputedStyle !== "function") return 0;
	const raw = (win.getComputedStyle(el).getPropertyValue(KEYBOARD_VAR) || "").trim();
	if (!raw) return 0;
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 屏幕底那两条原生栏（底栏 / 快速编辑栏）中**最靠上**那条的顶边（**视口坐标** y）；
 * 两条都不在（或都不可见）时返回 `null`。
 *
 * 抽成独立函数是为了让「可用区底边」与「让位量」两个消费点共用**同一份判据**
 * （`usableBottom` 与 `bottomBarOverlap`）—— 同一件事在两处各写一遍就是
 * 「读完文档说栏在、算让位时说栏不在」这类错位的温床。
 */
export function nativeBarTop(doc: Document = document): number | null {
	let top: number | null = null;
	for (const sel of NATIVE_BARS) {
		const el = doc.querySelector<HTMLElement>(sel);
		if (!el) continue;
		const r = el.getBoundingClientRect();
		// height>0 才算真的可见（工具栏被插件/核心隐藏时 rect 全 0）；
		// top<=0 的是「不在屏幕里」（被推到视口上方 / 还没有几何）
		if (r.height > 0 && r.top > 0 && (top == null || r.top < top)) top = r.top;
	}
	return top;
}

/**
 * 容器底边被屏幕底原生栏**压住**多少像素（0 = 没被压）。
 *
 * 给「贴底铺满的不透明 UI」（标注侧边栏）让位用：`bottom:0` 的面板最后几行会落进
 * 悬浮底栏底下 —— 用户既看不见也点不到。量的是**重叠**而不是栏高：栏顶边在容器
 * 底边之上多少，就让多少。
 *
 * 桌面端与「底栏不悬浮」的形态天然返回 0，不需要在消费点里分平台写死高度 ——
 * 官方 `.mobile-navbar` 的 `position: var(--navbar-position)` 在非悬浮导航下
 * **整条声明失效**（变量未定义 → 回落到 static，asar 实测）→ 它是内容区**下方**的
 * 流内兄弟（`.app-container` 的最后一个 flex 子项），容器底边本就在它上面。
 * 写死「底栏高 80px」的实现会在这两种形态下凭空留出一条带。
 *
 * 判据与 `usableBottom` 的「原生栏」那一路逐字同源（都走 {@link nativeBarTop}）：
 * 官方 `MobileNavbar.hide()` 是**把元素摘出 DOM**、键盘弹起时也会收走它 →
 * 不在屏幕上就恒为 0，不给一个不存在的栏留位。
 */
export function bottomBarOverlap(containerEl: HTMLElement | null): number {
	if (!containerEl) return 0;
	try {
		if (!isMobileLike()) return 0;
		const top = nativeBarTop(containerEl.ownerDocument ?? document);
		if (top == null) return 0;
		const bottom = containerEl.getBoundingClientRect().bottom;
		return bottom > top ? Math.round(bottom - top) : 0;
	} catch {
		return 0;
	}
}

/**
 * 可用区底边（**视口坐标** y）：
 * 容器底边 / 键盘上沿（官方变量推出）/ 可视视口底边 / 键盘上方原生栏顶边 的最小值。
 *
 * 桌面端（非移动 WebView）直接返回容器底边 —— 没有软键盘、没有这两条栏，行为与改动前一致。
 */
export function usableBottom(containerEl: HTMLElement | null): number {
	const doc = containerEl?.ownerDocument ?? document;
	const rect = containerEl?.getBoundingClientRect();
	let limit = rect ? rect.bottom : doc.defaultView?.innerHeight ?? window.innerHeight;
	if (!isMobileLike()) return limit;

	// 键盘上沿（官方变量）：唯一在「容器故意没收缩」的那一档里仍然可靠的信号（见文件头第 3 条）。
	// 常规档位上容器已收缩成 `整屏高 − 键盘高`，本式算出的值与容器底边**恒等** → 取 min 是恒等变换。
	const kbd = keyboardHeightPx(doc);
	if (kbd > 0) {
		const viewportH = doc.documentElement?.clientHeight || doc.defaultView?.innerHeight || 0;
		if (viewportH > 0) limit = Math.min(limit, Math.max(0, viewportH - kbd));
	}

	// 可视视口：键盘动画期间它比 --keyboard-height 更早反映真实可用高度
	const vv = doc.defaultView?.visualViewport ?? window.visualViewport;
	if (vv && Number.isFinite(vv.height)) limit = Math.min(limit, vv.offsetTop + vv.height);

	// 键盘上方那两条原生浮层；非悬浮形态下 .mobile-navbar 是内容区**下方的流内兄弟**，
	// 其 top ≈ 容器底，取 min 无副作用（见 nativeBarTop 的注释）
	const barTop = nativeBarTop(doc);
	if (barTop != null) limit = Math.min(limit, barTop);
	return limit;
}

/**
 * 把容器高度裁到「可用区底边」之上。
 *
 * 桌面端（`usableBottom` 等于容器底边）原样返回 —— 与改动前逐像素一致；
 * 移动端键盘弹起时容器已被官方收缩，差额通常是键盘上方那条 `.mobile-toolbar`
 * 的高度（~52px）—— 不裁的话浮动框会把按钮行放进这条被原生浮层压住的带里。
 *
 * 下界 120px：极端窄的下半屏也不让 `placeFloating` 的钳制区退化到装不下一行按钮。
 *
 * 抽成导出函数而非留在 readerView：夹具要靠它算出与线上同源的 bounds，
 * 复制一份到测试里就是一份会漂移的假副本（see test/comment-mobile-probe.ts）。
 */
export function clampHeightToUsable(hostEl: HTMLElement, height: number, containerBottom: number): number {
	const limit = usableBottom(hostEl);
	if (!Number.isFinite(limit) || limit >= containerBottom) return height;
	return Math.max(120, height - (containerBottom - limit));
}

/**
 * 订阅「键盘 / 原生栏几何」变化；返回取消函数。
 *
 * 回调在一个 rAF 内合并（同一帧内 resize + visualViewport + RO 同时到达只跑一次），
 * 避免键盘动画期间每帧多次强制同步布局。
 *
 * @param hostEl 观测对象：几何会随键盘变化的那个盒子（正文区 / 面板滚动区）。
 *               监听它自身的尺寸即可覆盖「官方收缩容器」这条主路径。
 */
export function subscribeKeyboardGeometry(hostEl: HTMLElement | null, cb: () => void): () => void {
	const doc = hostEl?.ownerDocument ?? document;
	const win = doc.defaultView ?? window;
	let disposed = false;
	let raf = 0;

	const schedule = (): void => {
		if (disposed || raf) return;
		raf = win.requestAnimationFrame(() => {
			raf = 0;
			if (!disposed) cb();
		});
	};

	win.addEventListener("resize", schedule);
	const vv = win.visualViewport;
	if (vv) {
		vv.addEventListener("resize", schedule);
		// iOS 上键盘弹起会把可视视口平移（scroll），只监听 resize 会漏掉回落那一次
		vv.addEventListener("scroll", schedule);
	}
	for (const ev of KEYBOARD_EVENTS) win.addEventListener(ev, schedule);

	let ro: ResizeObserver | null = null;
	if (typeof ResizeObserver !== "undefined") {
		ro = new ResizeObserver(schedule);
		if (hostEl) ro.observe(hostEl);
		// 原生栏「从 0 变 52」不会改变 host 的尺寸（它是浮层）→ 必须单独盯它们自己
		for (const sel of NATIVE_BARS) {
			const el = doc.querySelector<HTMLElement>(sel);
			if (el) ro.observe(el);
		}
	}

	// 键盘动画那一档（`.keyboard-animating`，容器故意不收缩）**一次 resize 都不会来** ——
	// 整段窗口里唯一的信号就是官方变量 `--keyboard-height` 被写进 html/body 的 style。
	// 不盯它，注释区会在动画期间停在旧坐标上，等动画结束才跳上来（用户看到的就是
	// 「输入框先出现在输入法下面」）。只认变量**真的变了**的那一次：
	// 桌面端 `--zoom-factor` 与主题对 html/body 的其它 style 写入一律忽略。
	let kbdSeen = keyboardHeightPx(doc);
	const onStyleMutate = (): void => {
		const next = keyboardHeightPx(doc);
		if (next === kbdSeen) return;
		kbdSeen = next;
		schedule();
	};
	let mo: MutationObserver | null = null;
	if (typeof MutationObserver !== "undefined") {
		mo = new MutationObserver(onStyleMutate);
		for (const el of [doc.documentElement, doc.body]) {
			if (el) mo.observe(el, { attributes: true, attributeFilter: ["style"] });
		}
	}

	const timers = CONVERGE_LADDER.map(ms => win.setTimeout(schedule, ms));

	return () => {
		disposed = true;
		if (raf) win.cancelAnimationFrame(raf);
		win.removeEventListener("resize", schedule);
		if (vv) {
			vv.removeEventListener("resize", schedule);
			vv.removeEventListener("scroll", schedule);
		}
		for (const ev of KEYBOARD_EVENTS) win.removeEventListener(ev, schedule);
		for (const t of timers) win.clearTimeout(t);
		ro?.disconnect();
		mo?.disconnect();
	};
}

/* ---------------- Obsidian 弹窗（Modal）的键盘安全区 ----------------
 *
 * 官方对弹窗**完全不做**键盘适配（asar 实测）：`--keyboard-height` 只被
 * `.app-container` 的 `max-height`、`.workspace-drawer-inner` 的 `padding-bottom`、
 * `.mobile-navbar` 的 `margin-bottom`、`.mobile-toolbar` 的 `top` 消费，**没有一条**落在弹窗上；
 * 而 `.modal-container` 是挂在 `body` 上的 `position:absolute; top:0; bottom:0` 浮层
 * ——弹窗不在 `.app-container` 里，**不随它收缩而变矮**，`.modal` 自身也只有
 * `max-height: var(--dialog-max-height)`（85vh，同样按布局视口算）＋ `overflow:auto`。
 * → 键盘弹起时弹窗仍按**整屏高度**居中：小屏（667 高）与横屏下，输入框下面那行
 *   「保存 / 添加 / 跳转」会落进键盘区（用户报的「输入法盖住输入框和保存按钮」）。
 *
 * 修法只用一条 CSS（styles.css 的 `.unreader-kb-safe`）：把该类的 `bottom` 抬到
 * `var(--keyboard-height)` → 居中发生在「键盘之上」的区域，输入框与按钮行一起让开键盘。
 * 用 CSS 而不是 JS 实测几何：这正是官方自己的机制（同一个变量、同一个消费口径），
 * 而且 `.modal-container` 是 `body` 的子元素 —— 变量无论写在 `documentElement` 还是 `body` 上，
 * 这里的 `var()` 都能求到值（不必像 JS 那样先决定读哪一层的计算样式）。
 * 桌面端该变量为 `0px` → 逐像素零变化。
 */

/** 弹窗容器（`Modal.containerEl`）上的键盘安全类，规则见 styles.css */
export const MODAL_KB_SAFE_CLASS = "unreader-kb-safe";

/** 弹窗打开时挂类（在 `Modal.onOpen` 里调） */
export function markModalKeyboardSafe(containerEl: HTMLElement | null | undefined): void {
	try { containerEl?.addClass(MODAL_KB_SAFE_CLASS); } catch { /* ignore */ }
}

/** 弹窗关闭时摘类（在 `Modal.onClose` 里调；容器被复用时不留下这个类） */
export function unmarkModalKeyboardSafe(containerEl: HTMLElement | null | undefined): void {
	try { containerEl?.removeClass(MODAL_KB_SAFE_CLASS); } catch { /* ignore */ }
}
