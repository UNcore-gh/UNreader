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

/**
 * 探针的「阴性对照」开关：关掉**布局视口兜底**这一路（生产恒 false）。
 *
 * 用来证明 Android `adjustResize` 档的断言真的有牙口 —— 关掉后
 * `usableBottom` 会退回「设备底」，贴底浮层整块沉到键盘下 ⇒ 那一档必须变红。
 * 只有 `test:md-kb` 会设这个键（见 test/md-kb-probe.ts 的 `?break=layoutvp`）。
 */
function layoutVpBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_LAYOUT_VP === true;
	} catch {
		return false;
	}
}

/**
 * 探针的「阴性对照」开关：把**贴底判据的基准**注回旧值（容器底边，生产恒 false）。
 *
 * 只有 `test:md-kb` 会设这个键（`?break=dockbase`）。它压的是「基准换成 limit」这一改
 * —— 开了它就退回「拿容器底当基准」⇒ 动画档 / Android 档里键盘上方那条原生栏被误判成
 * 浮动栏而拒收 ⇒ 工具条落进栏带内被遮挡（G 档必须变红）。
 */
function dockBaseBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_DOCK_BASE === true;
	} catch {
		return false;
	}
}

/**
 * 探针的「阴性对照」开关：关掉**原生栏迟到入场**的三条兜底（生产恒 false）。
 *
 * 关掉后订阅只认 resize / visualViewport / 键盘事件 —— 而官方快速编辑栏
 * （`.mobile-toolbar` + `.mobile-toolbar-spacer`）由核心在编辑器聚焦时**动态追加**、
 * 收起时整组 `detach()`，全程**一个事件都不发** ⇒ 关掉后几何订阅收不到那次变化，
 * `--ur-kb-inset` 停在旧值（`test:md-kb` 的 H 档必须变红）。
 */
function barWatchBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_BAR_WATCH === true;
	} catch {
		return false;
	}
}

/**
 * 「原生栏**实测相交**」这条路的阴性总闸（生产恒 false）。
 *
 * 关掉后 {@link nativeBarOverlapTop} 一律返回 `null`（= 两条带没压在一起）。
 * 它是「不被官方栏盖住」的**第二条独立保障**（第一条是 `occlusionCeiling` 的命中测试，
 * 那条的阴性闸是 `floatingPlacement` 的 `__UR_BREAK_OCC_HIT`）。`test:md-kb` 的 R 档
 * 两条一起用作**成对证据**：只关命中测试时工具条仍被矩形闸救回栏顶边之上；
 * 再关矩形闸就落进栏带里被盖住。
 */
function barRectBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_BAR_RECT === true;
	} catch {
		return false;
	}
}

/**
 * 探针计数：订阅回调**实际跑了几次**（生产环境恒为 no-op）。
 *
 * 只有测试全局被创建时才累加（`test:md-kb` 的 `?ticks=1`）。用途：直接证明
 * 「官方快速编辑栏**静默**入场（无 resize / visualViewport / 键盘事件）之后，
 * 几何订阅确实被唤醒了一次」—— 用 `--ur-kb-inset` 观察不到这一点（那条栏一入场，
 * `.mobile-toolbar-spacer` 就把宿主顶上去 52px，让位量前后都是 0）。
 */
function bumpTickProbe(): void {
	try {
		const g = globalThis as unknown as { __UR_GEOM_TICKS?: unknown };
		if (typeof g.__UR_GEOM_TICKS === "number") g.__UR_GEOM_TICKS += 1;
	} catch {
		/* ignore */
	}
}

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

/** 一条**当前真实可见**的原生栏：它的选择器与实测矩形。 */
interface NativeBarRect {
	selector: string;
	rect: DOMRect;
}

/**
 * 屏幕底那两条原生栏（`.mobile-toolbar` 快速编辑栏 / `.mobile-navbar` 底栏）里
 * **当前真实可见**的那些。
 *
 * 可见性判据照抄 UNmemos 已在真机跑通的实现（`UNmemos-src/src/ui/editor.ts` 的
 * `visibleBottomBarTop()`，2026-10-12 用户点名「UNmemos 的展开输入框功能也做了，
 * 你可以借鉴一下」）：
 *   · 官方 `MobileToolbar.hide()` 走 `wrapperEl.detach()`（整组摘出 DOM）——不在 DOM
 *     里自然查不到，这一半靠 `querySelector` 天然成立；
 *   · 但也可能只留一个 `display:none` / `visibility:hidden` / `opacity:0` 的**占位**。
 *     只按 rect 判断会把一条**看不见的栏**当成基线，可用区凭空缩短一片。
 * ⇒ 逐条过 computed style，再用 `height>0 && top>0` 排掉「还没有几何 / 被推到屏外」。
 */
function visibleNativeBars(doc: Document): NativeBarRect[] {
	const win = doc.defaultView ?? window;
	const out: NativeBarRect[] = [];
	for (const sel of NATIVE_BARS) {
		const el = doc.querySelector<HTMLElement>(sel);
		if (!el) continue;
		if (typeof win.getComputedStyle === "function") {
			const cs = win.getComputedStyle(el);
			if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
		}
		const r = el.getBoundingClientRect();
		if (r.height > 0 && r.top > 0) out.push({ selector: sel, rect: r });
	}
	return out;
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
	for (const { rect } of visibleNativeBars(doc)) {
		if (top == null || rect.top < top) top = rect.top;
	}
	return top;
}

/**
 * **屏幕上的原生栏与给定矩形真的叠在同一片像素上**时，返回最上面那条栏的顶边
 * （**视口坐标** y）；没有相交 → `null`。
 *
 * 与 `floatingPlacement.occlusionCeiling` 的分工（两条**独立**保障，不可互相替代）：
 *   · `occlusionCeiling` 问「这个点最上面是谁」—— 命中测试受绘制顺序、`pointer-events`、
 *     层叠上下文裁剪影响，是**实现相关**的；
 *   · 本函数只做 `getBoundingClientRect` 相交 —— 两条带在屏幕上真的压在一起就一定算得出，
 *     与「谁盖谁」「能不能点」全都无关。
 *
 * 为什么需要它（2026-10-12 **第三次**真机报障「仍然重叠」后定稿）：
 * 前两轮修复各自建立在「可用区算得对」（`usableBottom` 把原生栏折进可用区）或
 * 「命中测试看得见」（`occlusionCeiling`）之上。只要真机上有一处让这两个前提**同时**
 * 失效，工具条就会**又一次**落进那条 52px 的栏带里 —— 已知的实现细节里至少有四处
 * 能造成这种错位：
 *   ① `.app-container` 在移动端**不是**定位元素（官方 CSS 只有
 *      `body:not(.is-mobile) .app-container{position:relative}`）⇒ `.mobile-toolbar`
 *      （`position:absolute`）的包含块其实是 `body.is-mobile{position:relative}`；
 *   ② 栏的位置还被 `MobileToolbar.animateToKeyboardHeight()` 的内联 `translateY`
 *      动画叠一次（iOS 300ms / Android 350ms），中途取值与 `top` 算出来的不一致；
 *   ③ 宿主到底跟不跟 `.mobile-toolbar-spacer` 缩，取决于整条
 *      `workspace(-split/-tabs/-tab-container) → leaf(-content) → view-content` 链；
 *   ④ Android 上 `--keyboard-height` / `100vh` / `visualViewport` 三路信号可能同时缺席。
 * 这一条是**不做任何假设的最后一道闸**：不看模型算得对不对，只看两条带在不在同一片像素上。
 *
 * 阴性开关 `__UR_BREAK_BAR_RECT`（`?break=barrect`）注回「不查相交」——
 * `test:md-kb` 的 R 档用它证明这条闸自己承重（不是搭命中测试的便车）。
 */
export function nativeBarOverlapTop(
	rect: { top: number; bottom: number; left: number; right: number },
	doc: Document,
): number | null {
	if (barRectBreak()) return null;
	if (!(rect.bottom > rect.top)) return null;
	let top: number | null = null;
	for (const { rect: br } of visibleNativeBars(doc)) {
		if (!(br.height > 0)) continue;
		// 纵向真的压住；横向也要有交集（栏是整幅宽的，横向几乎恒成立 —— 留这条是为了
		// 不在「栏宽 0 / 只有一列按钮」这类异常几何上误判）。
		if (br.bottom <= rect.top + 0.5 || br.top >= rect.bottom - 0.5) continue;
		if (br.right <= rect.left + 0.5 || br.left >= rect.right - 0.5) continue;
		if (top == null || br.top < top) top = br.top;
	}
	return top;
}

function dockedBarTopAgainst(bottom: number, doc: Document): number | null {
	let top: number | null = null;
	for (const { rect } of visibleNativeBars(doc)) {
		const overlap = bottom - rect.top;
		if (overlap < 0 || overlap > rect.height + 24) continue;
		if (top == null || rect.top < top) top = rect.top;
	}
	return top;
}

/**
 * 真正**压在容器底边上**的原生栏顶边（视口坐标）；没有则 null。
 *
 * 与 {@link nativeBarTop} 的区别（2026-10-11 iPad 浮动键盘报障）：
 * iPad 的**浮动键盘**（可拖动、不贴底）出现时，官方**不收缩** `.app-container`，
 * 但仍写 `--keyboard-height` 并把 `.mobile-toolbar` 摆到
 * `top = 100vh - kbd - 52px` —— 那条栏此时浮在屏幕**中部**、离容器底几百 px。
 * 若拿它当「压底栏」，`bottomBarOverlap` 会算出几百 px 让位、`usableBottom`
 * 会把可用区裁到屏幕半腰，贴底浮层（划词工具条 / AI 面板 / 标注抽屉）全部
 * 稳态停在「非常高的位置」。判据：栏与给定底边的重叠量不得超过栏自身高度 + 24px
 * 余量 —— 正常贴底态（悬浮 navbar ~50px、键盘上方 mobile-toolbar 52px）恰好
 * 等于栏高，浮动键盘档的几百 px 被挡掉。
 *
 * ⚠️ `bottom` 传什么由调用方决定（两处口径**故意不同**，别统一）：
 *   · `bottomBarOverlap`（抽屉用）传**容器底边** —— 抽屉本就活在容器内、随容器收缩；
 *   · `usableBottom`（贴底浮层用）传**已收敛的 limit** —— 见该处的注释（动画档容器
 *     故意满高，拿容器底当基准会把「键盘上方原生栏」误判成浮动而拒收）。
 */
function bottomDockedBarTop(containerRect: DOMRect, doc: Document): number | null {
	return dockedBarTopAgainst(containerRect.bottom, doc);
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
		const rect = containerEl.getBoundingClientRect();
		// 用「贴底」判据：浮动键盘档的 .mobile-toolbar 浮在屏幕中部，不是压底栏
		// （见 bottomDockedBarTop 注释，2026-10-11 iPad 报障）。
		const top = bottomDockedBarTop(rect, containerEl.ownerDocument ?? document);
		if (top == null) return 0;
		return rect.bottom > top ? Math.round(rect.bottom - top) : 0;
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

	const vv = doc.defaultView?.visualViewport ?? window.visualViewport;
	const vvBottom = vv && Number.isFinite(vv.height) ? vv.offsetTop + vv.height : null;

	// 键盘上沿（官方变量）：常规收缩档恒等、动画档兜底（见文件头第 3 条）。
	// ⚠️ iPad **浮动键盘**（可拖动、不贴底的小键盘）是第四档：官方同样写 --keyboard-height，
	// 但不收缩容器、键盘只挡住屏幕中间一块 —— 若照样把可用区裁到「100vh − 键盘高」，
	// 贴底浮层会稳态停在屏幕半腰（2026-10-11 报障「键盘一打开工具条跑到非常高的位置」）。
	// 判据：只有 ① 容器已收缩到键盘上沿（常规档）② 可视视口也被裁到那里（动画档，
	// iOS vv 有效）③ 根本没有 vv 信息（部分 Android WebView，沿用旧行为）三条之一成立，
	// 键盘变量才参与裁切；容器满高 + vv 也满高 = 浮动键盘 → 跳过。
	const kbd = keyboardHeightPx(doc);
	if (kbd > 0) {
		const viewportH = doc.documentElement?.clientHeight || doc.defaultView?.innerHeight || 0;
		if (viewportH > 0) {
			const keyboardTop = Math.max(0, viewportH - kbd);
			const containerShrunk = limit <= keyboardTop + 2;
			const vvShrunk = vvBottom != null && vvBottom <= keyboardTop + 2;
			// 动画档：官方给 body 挂 keyboard-animating 类、容器故意回到满高（文件头第 3 条），
			// 这是 ~250ms 的临时态，变量是唯一信号，必须认。iPad 浮动键盘稳态没有这个类。
			const animating = (doc.body?.classList?.contains("keyboard-animating")) === true;
			// 无 vv 的旧 WebView：沿用旧行为（信任变量），无法识别浮动键盘但那种设备罕见
			if (containerShrunk || vvShrunk || animating || vvBottom == null) limit = Math.min(limit, keyboardTop);
			// **分裂态**（2026-10-13 并入，见下方长注释）：上面四条前提**一条都不成立** ——
			// 变量写了，而容器 / 可视视口 / 动画类三路全没缩。此时「键盘上沿」不是可用区底边，
			// 官方那条快速编辑栏（`top = 100vh − 键盘高 − 栏高`）才是 ⇒ 必须再往上收一条栏高。
			else if (!usableKbBandBreak()) {
				const band = keyboardBandCeiling(doc);
				if (band != null) limit = Math.min(limit, band);
			}
		}
	}

	// 可视视口：键盘动画期间它比 --keyboard-height 更早反映真实可用高度
	if (vvBottom != null) limit = Math.min(limit, vvBottom);

	// 布局视口（`innerHeight` / `clientHeight`）：**Android WebView 走 adjustResize 时的唯一
	// 可用信号**（2026-10-12 真机报障「Android 上划词工具条 / AI 面板不抬到键盘之上」）。
	//
	// 机制：Android 原生层把 WebView 本身缩小（`innerHeight` 844 → 524），而
	//   ① `--keyboard-height` **常常不写**（asar 实测：该变量在 app.js 里只有读、没有写，
	//      写入方是原生层，Android 靠 adjustResize 就不必再写它）；
	//   ② 宿主 `.unreader-md-root` 是 `inset:0` 的绝对层，其包含块未必跟着缩（真机实测
	//      rect.bottom 仍停在 844）；
	//   ③ `visualViewport` 在部分 Android WebView 上同样不缩。
	//   → 上面「容器底 / 键盘上沿 / vv 底」三路**全部缺席**，可用区被判成整屏底，
	//   贴 `bottom:0` 的浮层整块沉到键盘下面（用户报障的 ①②）。
	//
	// 为什么取 min 是安全的恒等变换：
	//   · 桌面端在本函数开头 `!isMobileLike()` 已早退，走不到这里；
	//   · 常规收缩档（iOS / 容器跟着缩）：`innerHeight` == 容器底 == vv 底，取 min 不改变结果；
	//   · iOS 键盘档：`innerHeight` 不缩（844）、vv 缩（524）、kbd 已写 → 上面几路已把
	//     limit 压到 524，这里 min(524, 844) 仍 524，**不干扰 iPad 浮动键盘的跳过判据**。
	//   只有「视口缩了、而容器/vv/变量都没提供信号」这一档才真正生效 —— 那正是 Android。
	const layoutEl = doc.documentElement;
	const innerH = doc.defaultView?.innerHeight;
	const clientH = layoutEl?.clientHeight;
	const layoutBottom = Math.min(
		typeof innerH === "number" && Number.isFinite(innerH) && innerH > 0 ? innerH : Infinity,
		typeof clientH === "number" && Number.isFinite(clientH) && clientH > 0 ? clientH : Infinity,
	);
	if (Number.isFinite(layoutBottom) && !layoutVpBreak()) limit = Math.min(limit, layoutBottom);

	// **键盘带**（第五条独立信号）已经在上面 `kbd > 0` 的**分裂态**分支里并入了 ——
	// 为什么必须是那里、而不是在这里无条件取 min（2026-10-13 定稿的判据，别搬回来）：
	//
	// 真机实测（Android 手机 / 笔记实时编辑 / 引用块，库根 `unreader-selbar-noshow-*.txt`）：
	//   · `--keyboard-height` = **325.33px**（原生层写了）；
	//   · 而 `innerHeight` / `clientHeight` / `visualViewport.height` **三路全是 914**、
	//     宿主 `.unreader-md-root` 的 rect.bottom 同样 **914.3**、两条原生栏都不在 DOM；
	//   · `keyboardBandCeiling` 这一路是 **536.7**。
	//   ⇒ 「容器底 / 键盘上沿 / 可视视口 / 布局视口 / 原生栏」五路**全部缺席**，可用区被
	//   自信地判成整屏底（914）⇒ 贴底浮层整条落进输入法底下（用户报的「被输入法遮挡」）。
	//   输入法不是 DOM 节点（命中测试物理上看不见它）、`nativeBarOverlapTop` 又只认两条
	//   **已知原生栏**（那一刻都不在场）⇒ 唯一看得见它的就是这条纯算术的带。
	//
	// ⚠️ 但它**只在分裂态生效**，绝不无条件取 min：常规收缩档（阅读视图，官方那条栏的
	// 门控是「编辑器聚焦」⇒ 阅读档**根本不会出现**）里，容器底 = 键盘上沿，而「键盘带」
	// 还要再往上一整条栏高 —— 无条件并进去就是**凭空留出 52px 空洞**（`test:md-kb` 的
	// B 档「让位量 0」会立刻变红）。只有「变量写了、而容器/vv 都没缩」这一档，那条栏才
	// 真的会出现在键盘上方，让位才有对象。
	//
	// 恒等性：常规收缩档 / 动画档 / 无 vv 档**都走不到这里**（走的是上面的 `keyboardTop`），
	// 平板（`Platform.isTablet`）→ `keyboardBandCeiling` 返回 `null`（iPad 浮动键盘不贴底），
	// 桌面端在本函数开头已早退 ⇒ 三档都逐像素零变化。

	// 键盘上方那两条原生浮层；非悬浮形态下 .mobile-navbar 是内容区**下方的流内兄弟**，
	// 其 top ≈ 容器底，取 min 无副作用（见 nativeBarTop 的注释）。
	//
	// ⚠️ 「贴底」判据的基准是**已收敛的 limit**，不是容器底边（2026-10-12 修「实时编辑档
	// 工具条被官方快速编辑栏遮挡」）。机理：`keyboard-animating` 与 Android adjustResize
	// 两档里官方**故意**让容器保持满高（前者把 `.app-container` 放回 100vh、后者布局视口
	// 自缩但 CSS `100vh` 不缩），而键盘上方的 `.mobile-toolbar` 顶边 = `100vh − 键盘高 − 52`
	// —— 于是它离容器底有整整一个「键盘高」的距离。拿容器底当基准，overlap 远超栏高
	// ⇒ 被当成「iPad 浮动键盘那种浮在屏幕中部的栏」而**拒收** ⇒ limit 停在键盘上沿
	// ⇒ 贴底工具条正好落进那条栏的带内、被它盖住（用户报障「被 obsidian 移动端快速工具栏
	// 遮挡」；`test:md-kb` 的 G 档 elementFromPoint 实测命中 `.mobile-toolbar`）。
	//   换成 limit 基准后：**真浮动键盘**那一档（官方不收缩容器、limit 没被键盘裁过
	// ⇒ 基准仍等于容器底）判据逐字不变，只有「已收敛、栏正贴在新底边附近」这一档被正确收下。
	const barTop = rect
		? (dockBaseBreak() ? bottomDockedBarTop(rect, doc) : dockedBarTopAgainst(limit, doc))
		: nativeBarTop(doc);
	if (barTop != null) limit = Math.min(limit, barTop);
	return limit;
}

/**
 * **贴底浮层**该为「键盘 + 键盘上方原生栏」让出多少像素（0 = 不用让）。
 *
 * 与 {@link bottomBarOverlap} 的分工（两者不可互换，也别合并）：
 *   · `bottomBarOverlap` = **只含原生栏**（`.mobile-navbar` / `.mobile-toolbar`），
 *     给「抽屉 / 侧边栏的 padding」用 —— 那些盒子本来就活在容器内，键盘弹起时
 *     官方已经把 `.app-container` 收缩、它们跟着变矮，再减一次键盘就是重复计算。
 *   · 本函数 = **取 usableBottom 口径**，给「`position:absolute; bottom:0` 贴在宿主底边的
 *     浮层」用（手机上的 AI 面板 sheet、译文 / 结果卡）。
 *
 * ⚠️ 关于「宿主底边会不会随键盘收缩」（夹具实测结论，别再按推理下断言）：
 * 官方 `body.is-mobile .app-container{max-height:calc(100vh - var(--keyboard-height))}`
 * 收缩的是**整条 flex 链**，而 md 宿主 `.unreader-md-root` 是 `inset:0`、挂在
 * `.workspace-leaf-content`（flex:1）里 ⇒ **稳态下宿主底边确实跟着收缩**
 * （390×844 + 键盘 320 实测：844 → 524）。所以「键盘」这一段在稳态下**不需要**再让。
 *
 * 那本函数在稳态下为什么还是有值？—— 因为它取的是 `usableBottom` 口径，其中还压着
 * **键盘上方那条原生栏**（`.mobile-toolbar`，顶边 = 100vh − 键盘高 − 52）：
 * 宿主底边（= 键盘上沿）减去栏顶边 ⇒ 稳态值恒为 **52**，正好把 sheet 抬到那条栏之上
 * （用户要的「在键盘和 obsidian 原生工具栏上面」）。键盘收起时栏不在 ⇒ 回 0 ⇒ 落回屏幕底。
 *
 * 真正需要「键盘」那一段兜底的是另两档：
 *   · `body.is-mobile.keyboard-animating`（官方把容器放回满高，~250ms）：宿主底边回到
 *     屏幕底，而键盘已经在显示中 ⇒ 贴 `bottom:0` 的 sheet 整块沉到键盘下面；
 *   · iPad **浮动键盘**（官方不收缩容器；`usableBottom` 里另有判据处理，本函数顺带受益）。
 *
 * ⇒ 一句话：稳态值 = 原生栏高；动画档 / 浮动键盘档才含键盘。两段都自洽，收敛到 0 无副作用。
 *
 * 实现零新判据：直接复用 {@link usableBottom}（它已经把容器底 / 键盘上沿 /
 * 可视视口 / 键盘上方原生栏四路取过 min），换算成**宿主内坐标**的让位量。
 * 桌面端 `usableBottom` 等于宿主底边 ⇒ 恒为 0，逐像素零变化。
 *
 * ⚠️ 别拿它去算 `--ur-bottom-inset`（抽屉用）：抽屉是**不透明交互盒**，键盘弹起时
 * 容器已收缩，再让一次键盘会把它顶到屏幕半腰（与 iPad 浮动键盘那次报障同型）。
 */
export function floatingBottomInset(hostEl: HTMLElement | null): number {
	if (!hostEl) return 0;
	try {
		const rect = hostEl.getBoundingClientRect();
		const limit = usableBottom(hostEl);
		if (!Number.isFinite(limit) || !Number.isFinite(rect.bottom)) return 0;
		const inset = rect.bottom - limit;
		return inset > 0.5 ? Math.round(inset) : 0;
	} catch {
		return 0;
	}
}

/**
 * 可用区底边是不是被一条**原生栏**定住的 —— 是则返回该栏的顶边（**视口坐标** y），
 * 否则 `null`。**「智能检测」这一步就落在这里**。
 *
 * 给「贴底浮层要与官方栏**逐像素重合**」用（2026-10-13 用户逐字要求：
 * 「obsidian 工具栏显示后，工具栏的上边框和插件工具栏的下边框没有重合，
 *  这个要智能检测，然后重合，这样视觉效果更佳紧凑」）。
 *
 * 两条来源**都算硬边**，取更靠上的那条：
 *   · `nativeBarTop`：实测几何（`getBoundingClientRect`）—— 官方栏真的在场时最硬；
 *   · `keyboardBandCeiling`：官方自己的算术（`100vh − 键盘高 − 栏高`）——**官方栏不在
 *     DOM 里时唯一能指认它上边框的人**（划词窗口内那条栏正被源头闸门收走；
 *     `test:md-kb` 的 S 档夹具也是 `hideBar()` 之后才量的）。
 *
 * ⚠️ 返回值只说明「哪里有一条硬边」，**不代表调用方该去贴它**：调用方还要自证
 * 「我的可用区底边**就是**这条边」（差 ≤1.5px）。那条等式只在**分裂态**成立
 * （见 `usableBottom` 里 `kbd > 0` 分支的分裂态注释）——常规收缩档里可用区底边是
 * 容器底（= 键盘上沿），比这条带低一整条栏高，等式不成立 ⇒ 恒不触发。
 * 所以「没有原生栏时回落键盘带」是安全的，不会在阅读档里凭空贴出一条 52px 空洞。
 */
export function hardBottomEdge(doc: Document = document): number | null {
	try {
		if (!isMobileLike()) return null;
		const bar = nativeBarTop(doc);
		const band = keyboardBandCeiling(doc);
		if (bar == null) return band;
		if (band == null) return bar;
		return Math.min(bar, band);
	} catch {
		return null;
	}
}

/**
 * **纯「还在屏幕上吗」的底线**（视口坐标 y）：布局视口高 / 可视视口底 三路取最小。
 *
 * 与 {@link usableBottom} 的**根本区别**（别把它俩合并）：
 *   · `usableBottom` 是**模型**：读 `--keyboard-height`、还要推断「容器有没有跟着缩」、
 *     判断是常规档 / 动画档 / iPad 浮动键盘档 —— 它对官方实现的假设越多，越可能在
 *     没覆盖到的那一档上算错；
 *   · 本函数**不读任何官方变量、不做任何推断**，只回答一句客观事实：
 *     「一个浮层的底边画到这条线以下，就**已经不在屏幕上了**」。
 *   键盘、地址栏、视口收缩都会把这条线顶上去，而且**与谁盖谁、能不能点无关**。
 *
 * 为什么需要它（2026-10-12 真机报障「键盘展开后插件工具条上边框与输入法上边框对齐，
 * 整条刚好被输入法遮挡」）：既有的两条遮挡判据都**认不出软键盘**——
 *   · `floatingPlacement.occlusionCeiling` 是 `elementFromPoint` 命中测试，而软键盘
 *     **不是 DOM 节点**（命中测试物理上看不见它）；iOS 上布局视口还不缩，采样点照样命中正文；
 *   · `keyboardInset.nativeBarOverlapTop` 只认 `.mobile-toolbar` / `.mobile-navbar`
 *     两条**已知原生栏** —— 而划词窗口内那条快速编辑栏正被源头闸门收走 ⇒ 两条同时缺席。
 * ⇒ 「键盘本身」成了唯一的遮挡源，却没有任何一条判据看得见它。本函数补的就是这一格。
 *
 * 取不到任何有效值时返回 `null`（调用方据此**不做判断**，绝不瞎猜一个数出来）。
 */
export function viewportFloor(doc: Document = document): number | null {
	try {
		const win = doc.defaultView;
		const parts: number[] = [];
		const ih = win?.innerHeight;
		if (typeof ih === "number" && Number.isFinite(ih) && ih > 0) parts.push(ih);
		const ch = doc.documentElement?.clientHeight;
		if (typeof ch === "number" && Number.isFinite(ch) && ch > 0) parts.push(ch);
		const vv = win?.visualViewport;
		if (vv && Number.isFinite(vv.height) && vv.height > 0) parts.push(vv.offsetTop + vv.height);
		if (!parts.length) return null;
		return Math.min(...parts);
	} catch {
		return null;
	}
}

/**
 * 探针的「阴性对照」开关：关掉**键盘带**这条实测闸（生产恒 false）。
 *
 * 只有 `test:md-kb` 的 S 档会设这个键（`?break=kblin`）。关掉后
 * {@link keyboardBandOverlapTop} 一律返回 `null`（= 认为工具条不在键盘带里）⇒
 * S 档复刻的那台真机（`--keyboard-height` 写了、但**容器与可视视口都不缩**）上，
 * 工具条会落回键盘带里被输入法盖住 —— 用同一条断言一绿一红，证明这条闸真的承重。
 */
function kbLineBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_KB_LINE === true;
	} catch {
		return false;
	}
}

/**
 * 探针的「阴性对照」开关：关掉 {@link usableBottom} 里**新并入的「键盘带」**那一路
 * （生产恒 false）。
 *
 * 只有 `test:md-kb` 的 Android 分裂档会设这个键（`?break=kbband`）。那一档复刻的真机
 * 状态是「`--keyboard-height` 写了 325px，而容器 / 可视视口 / 布局视口 / 宿主 rect
 * **四路全没缩**」⇒ 关掉本路后 `usableBottom` 退回整屏底，贴底工具条沉到输入法下面 ——
 * 用同一条断言一绿一红，证明这条带真的在承重（不是搭 `keyboardBandOverlapTop` 的便车）。
 *
 * ⚠️ 它与 {@link kbLineBreak}（`?break=kblin`，关掉**遮挡判据**那条带）**不是同一个开关**：
 * 那条是「摆好之后再问有没有压住」，这条是「一开始就把让位量算出来」。两条各自承重，
 * 所以必须能分别关。 */
function usableKbBandBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_KB_BAND === true;
	} catch {
		return false;
	}
}

/**
 * 键盘**上方那条官方快速编辑栏**的占高（px）：读官方变量 `--mobile-toolbar-height`
 * （`= var(--touch-size-l)`），缺失/非法时回落 52（手机档实测 52）。
 *
 * 为什么要读官方变量而不是写死 52：`.mobile-toolbar` 的 `top` 与 `.mobile-toolbar-spacer`
 * 的 `height` 都消费这个变量，写死一个数就是「文档说 52、渲染是 48」这类错位的温床。
 */
function mobileToolbarBandPx(doc: Document): number {
	const win = doc.defaultView ?? window;
	const el = doc.body ?? doc.documentElement;
	if (!el || typeof win.getComputedStyle !== "function") return 52;
	const raw = (win.getComputedStyle(el).getPropertyValue("--mobile-toolbar-height") || "").trim();
	if (!raw) return 52;
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) && n > 0 ? n : 52;
}

/**
 * **「键盘带」的上沿**（视口坐标 y）＝ `布局视口高 − --keyboard-height − 键盘上方原生栏高`。
 * 键盘没弹起 / 取不到有效值 / 平板端 → `null`。
 *
 * 与 {@link usableBottom} 的关系：**不是**它的替代品，而是它**外面**的一道实测闸。
 * `usableBottom` 是模型（读变量 + 推断容器有没有跟着缩 + 区分四档键盘形态），
 * 本函数只做一条**与模型无关**的算术，用来回答一句客观事实：
 * 「工具条的下沿落在这条线以下，就已经压进输入法（或输入法上方那条官方栏）的带里了」。
 *
 * 为什么必须补这一格（2026-10-12 用户逐字报障：「键盘展开，obsidian 原生输入框没了，
 * 然后插件工具栏，则上边框和输入法上边框对齐，导致刚好被输入法遮挡掉」）：
 *   · 机身几何确实变了、但**模型吃的四个信号都没变**：容器底（`.app-container` 的
 *     `max-height` 由同一个变量推）、`--keyboard-height`、可视视口、布局视口 —— 当
 *     `100vh − 变量` 恰好等于容器底时（这正是官方 CSS 的定义），模型会自信地返回容器底，
 *     而**输入法真正的可见上沿在它的上方**（键盘自带的候选词条 / 机型状态条那一带，
 *     官方变量并不计入）。此时模型「自洽且错」：所有内部判据都成立，落点却压在输入法上。
 *   · 既有的两条遮挡判据也都认不出输入法：`occlusionCeiling` 是 `elementFromPoint`
 *     命中测试（软键盘**不是 DOM 节点**，命中测试物理上看不见它）；`nativeBarOverlapTop`
 *     只认 `.mobile-toolbar` / `.mobile-navbar` 两条**已知原生栏**（划词窗口内那条栏正被
 *     源头闸门收走 ⇒ 它也不在场）。
 * ⇒ 补一条不需要任何前提的兜底，并且**按官方自己的口径**把键盘上方那条栏的带一起让开
 *   （用户的原话就是「工具栏的下边框和 obsidian 原生工具栏的上边框对齐」）。
 *
 * 取 `布局视口高 − 键盘高 − 栏高` **而不是**容器底，还有一个决定性好处：
 * 稳态（官方栏 + 它的流内 spacer 成对在场）下宿主底边本来就等于
 * `100vh − 键盘高 − 栏高`（spacer 把 `.workspace` 顶上去 52px）⇒ 这条线与
 * **既有已被回归钉住的落点**（`bottom = 宿主底边 − 8`）逐像素重合 ⇒ 本闸在一切
 * 已经正确的档位上**恒为 no-op**，只在那台「容器/vv 都没缩」的真机上生效。
 *
 * ⚠️ 平板（`Platform.isTablet`）直接返回 `null`：iPad 的**浮动键盘**可能浮在屏幕中部、
 * 根本不挡底边，而官方照样写变量（把那条栏摆到 `100vh − 键盘高 − 52`，离屏幕底很远）
 * ⇒ 这个变量在平板上不具备「挡住了底边多少」的语义。手机（含 `test:md-kb` 的
 * 390×844 档）软键盘恒停靠屏幕底，这条线才是可靠的。**别把这条门禁当"少管一档"**：
 * 它换来的正是「不会把 iPad 浮动键盘档的工具条错误地顶到屏幕半腰」（2026-10-11 报障）。
 *
 * ⚠️ 自保：`布局视口 − 键盘高` 若不到布局视口的一半，说明布局视口**自己已经被键盘
 * 收缩过**（Android `adjustResize` + 原生层又写了变量），此时再减一次键盘就会把整条
 * 线抬到屏幕中部。那种组合官方自己的 `.app-container` 会被压扁，现实中不存在；
 * 这里只是自保 —— 判据不成立就返回 `null`（不参与），绝不瞎猜。
 */
export function keyboardBandCeiling(doc: Document = document): number | null {
	if (kbLineBreak()) return null;
	if (!isMobileLike()) return null;
	try {
		if ((Platform as unknown as { isTablet?: boolean }).isTablet === true) return null;
		const kbd = keyboardHeightPx(doc);
		if (kbd <= 0) return null;
		const layoutH = doc.documentElement?.clientHeight || doc.defaultView?.innerHeight || 0;
		if (!(layoutH > 0)) return null;
		if (layoutH - kbd < layoutH / 2) return null;
		const top = layoutH - kbd - mobileToolbarBandPx(doc);
		return top > 0 ? top : null;
	} catch {
		return null;
	}
}

/**
 * **实测**：工具条**当前渲染出来的**矩形已经伸进「键盘带」时，返回该带的上沿
 * （**视口坐标** y）；没伸进去 / 取不到键盘带 → `null`。
 *
 * 形态与职责刻意与 {@link nativeBarOverlapTop} 对齐（同为「不做任何前提假设、
 * 只看两条带在不在同一片像素上」的最后一道闸），只是这次被量的是**输入法**：
 * 输入法不是 DOM 节点，唯一能看见它的方式是「我的底沿 vs 键盘带的上沿」。
 *
 * 返回 `null` 的两种情形都不改变任何行为 —— 调用方把 `null` 当「没被挡」处理。
 */
export function keyboardBandOverlapTop(
	rect: { top: number; bottom: number; left: number; right: number },
	doc: Document = document,
): number | null {
	const line = keyboardBandCeiling(doc);
	if (line == null) return null;
	if (!(rect.bottom > rect.top)) return null;
	// 底沿真的伸进带里才算：留 0.5px 容差（子像素排版下相等的两值不该被判成重叠）。
	if (!(rect.bottom > line + 0.5)) return null;
	return line;
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
			if (!disposed) {
				bumpTickProbe();
				cb();
			}
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
	/** 已经盯上的原生栏：`.mobile-toolbar` 是**迟到入场**的（见 resyncBars） */
	const observedBars = new Set<Element>();
	const resyncBars = (): void => {
		if (!ro) return;
		for (const sel of NATIVE_BARS) {
			const el = doc.querySelector<HTMLElement>(sel);
			if (!el || observedBars.has(el)) continue;
			observedBars.add(el);
			ro.observe(el);
		}
	};
	if (typeof ResizeObserver !== "undefined") {
		ro = new ResizeObserver(schedule);
		if (hostEl) ro.observe(hostEl);
		// 原生栏「从 0 变 52」不会改变 host 的尺寸（它是浮层）→ 必须单独盯它们自己。
		// ⚠️ 但 `.mobile-toolbar` 在**编辑器聚焦前根本不在 DOM 里**（官方 `show()` 才
		// `appendChild`，`hide()` 又 `detach()`），订阅那一刻查不到它就永远盯不上 ——
		// 这是 UNmemos 用「每拍重挂观察器」解决的问题（`syncExpandedObservers`）。
		resyncBars();
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

	/**
	 * 几何指纹：把这几个「决定可用区」的实测值串起来。
	 *
	 * 为什么要它（2026-10-12 二次真机报障；UNmemos 的 COMMENT 已经写死了这条教训）：
	 * 官方快速编辑栏**比键盘晚出现**，而且出现/位移/收起**全程不发任何事件** ——
	 * 既不写 `--keyboard-height`，也不触发 `visualViewport.resize`，`ResizeObserver`
	 * 在订阅那一刻又还没盯上它（它那时不在 DOM 里）。于是「凭空出现」这一类变化
	 * 没有任何事件可以依赖，只能低频轮询。
	 * 指纹比对把轮询成本压到几乎为零：**值没变就不回调**，只有真变化才走一次重排。
	 */
	const geometrySignature = (): string => {
		const parts: string[] = [];
		if (hostEl) {
			const r = hostEl.getBoundingClientRect();
			parts.push(`${r.top.toFixed(1)},${r.bottom.toFixed(1)}`);
		}
		for (const { selector, rect } of visibleNativeBars(doc)) {
			parts.push(`${selector}:${rect.top.toFixed(1)},${rect.height.toFixed(1)}`);
		}
		parts.push(`kbd:${keyboardHeightPx(doc)}`);
		const v = win.visualViewport;
		if (v) parts.push(`vv:${v.height.toFixed(1)},${v.offsetTop.toFixed(1)}`);
		parts.push(`ih:${win.innerHeight},ch:${doc.documentElement?.clientHeight ?? 0}`);
		return parts.join("|");
	};
	let geomSeen = geometrySignature();
	const onGeometryMaybeChanged = (): void => {
		resyncBars();
		const next = geometrySignature();
		if (next === geomSeen) return;
		geomSeen = next;
		schedule();
	};

	let mo: MutationObserver | null = null;
	let mo2: MutationObserver | null = null;
	if (typeof MutationObserver !== "undefined") {
		// ① 变量落点：`--keyboard-height` 被写进 html/body 的 style（键盘动画档的唯一信号）
		mo = new MutationObserver(onStyleMutate);
		for (const el of [doc.documentElement, doc.body]) {
			if (el) mo.observe(el, { attributes: true, attributeFilter: ["style"] });
		}
		// ② 结构/类变化：`.mobile-toolbar` / `.mobile-toolbar-spacer` 是 `.app-container` 的
		// **直属子项**，官方 `show()` 追加、`hide()` detach —— 盯 childList 就能**事件驱动**
		// 地捕获这次结构变化（比纯轮询更早、更省）。body 的 class（`mod-toolbar-open` 等）
		// 一并盯上。
		// ⚠️ 必须用**另一个** observer：回调要是 `onGeometryMaybeChanged`（重算指纹），
		// 不能复用 `onStyleMutate`（那只认 `--keyboard-height` 变化 ⇒ 结构变化会被它整个吞掉，
		// 观察器形同虚设 —— 这正是「栏迟到入场仍被盖住」的第二个来源）。
		if (!barWatchBreak()) {
			mo2 = new MutationObserver(onGeometryMaybeChanged);
			const appc =
				hostEl?.closest?.(".app-container") ??
				doc.querySelector<HTMLElement>(".app-container") ??
				doc.body;
			if (appc) mo2.observe(appc, { childList: true });
			mo2.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
		}
	}

	// 低频指纹轮询：兜「原地静默位移 / 迟到入场」这类**没有任何事件**的变化
	// （UNmemos 的 `EXPAND_FOLLOW_MS = 200` 同款结论）。值没变时不产生任何回调。
	const followTimer = barWatchBreak() ? 0 : win.setInterval(onGeometryMaybeChanged, 250);

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
		if (followTimer) win.clearInterval(followTimer);
		observedBars.clear();
		ro?.disconnect();
		mo?.disconnect();
		mo2?.disconnect();
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
