/** 外部摘类自愈守卫 —— 盯 `document.body` 的 `is-hidden-nav`。
 *
 *  ## 为什么需要它
 *
 *  Obsidian 官方的 `is-hidden-nav` 是一个**严重不对称**的开关：
 *
 *  · **加类只有一条路径** —— `MobileNavbar.onScroll(el, top)`，而它的滚动钩子只挂在
 *    **markdown 视图**上（`Gl.isPhone && !mobileSoftKeyboardVisible && autoFullScreen`）。
 *    UNreader 视图吃不到这条，必须自己同步。
 *  · **减类（restoreNavigation）有六条** —— `window.mousedown`、`active-leaf-change`、
 *    `layout-change`、`vault.config-changed`、`keyboardWillShow/Hide`、抽屉 `expand()`。
 *    每一条都是「摘」，没有一条会把类补回来。
 *
 *  反编译取证的官方实现（obsidian.asar）：
 *  ```
 *  restoreNavigation(e = true): if (Gl.isPhone && body.hasClass("is-hidden-nav")) {
 *      body.removeClass("is-hidden-nav"); Dm && Dm.show({ animation: e }) }
 *  ```
 *
 *  插件的同步点（滚动方向变化 / 点按 / 切视图 / 外观变更）**全部绑在用户交互上**。
 *  于是有一段致命的空窗：官方摘掉类 → 用户回到静止阅读 → 没有任何事件再触发
 *  `syncNativeNav()` → 类不被补回 → 底栏（`mobile-navbar`）**永久留在显示态**。
 *  这就是用户报的「沉浸模式下，显示一次底下元素后，手机端最下面的元素会一直显示」。
 *
 *  ## 为什么是 MutationObserver，而不是再枚举几条官方路径
 *
 *  枚举一定会漏：官方六个触发点只是**当前版本**的实现细节，换个版本就漂移，而漏掉
 *  的那一条恰好就是这个 bug。这里换一个不依赖枚举的判据 —— **body 的类是不是
 *  目标态**：被摘掉、而本视图仍然要求隐藏，就补回。官方将来加多少条撤销路径都不影响。
 *
 *  ## 三条硬约束
 *
 *  1. **只看 `class` 属性，不看子树**：底栏的隐藏由两个 body 类驱动 ——
 *     本插件自己的 `unreader-nav-hidden`（**视觉闸门**，CSS 带 `!important`）与
 *     官方的 `is-hidden-nav`（官方语义一致性）。插件类在即底栏不可见，不必观察
 *     任何后代节点 —— 观察范围越小越不容易在滚动热路径上被唤醒。
 *  2. **正常路径立即补官方类，延迟一拍只留给降级路径**：插件视觉类还在、只缺
 *     官方类时，MutationObserver 在**同一微任务**里把官方类补回（早于浏览器绘制，
 *     所以 mask / 主题 / 官方任何消费者都看不到中间态）。只有插件类本身也缺失
 *     （旧产物、热重载、外部误删）才等一拍（`delay`，默认 90ms）：用户点屏幕唤出
 *     chrome 时，官方 `mousedown` 会**先**摘类、插件的 `click` 委托**后**跑三态；
 *     这段延迟让 click 快路先把最终语义问清楚，避免把用户刚唤出的底栏又按回去。
 *  3. **不自激**：补类本身会再触发一次回调，但那时 `classList` 已是目标态、
 *     `wanted()` 直接返回 false —— 不会写成 addClass/removeClass 的死循环。
 *
 *  ## 为什么延迟断言之外还要一条「点击快路」
 *
 *  官方摘类里有一条是 `window.mousedown`：**宿主上每一次点按**都摘类并
 *  `Dm.show()` 让底栏滑出来。若这次点按**并不改变沉浸态**（点面板/按钮/输入框：
 *  阅读器宿主 click 委托的排除清单会把这些点按挡在 `handleTapZone` 之外），
 *  90ms 的延迟断言就落在底栏滑出动画（`transform 0.3s`）的约 1/3 处 ——
 *  用户看到「底栏冒出来又被按回去」的闪烁，点几下闪几下（手机端报障）。
 *
 *  修法是加一条**只读 body 类、只写同一个目标态**的快路：摘类被观察到时，顺手
 *  在 `document` 的**捕获阶段**挂一个一次性 `click`，在同一个任务里先把类补回去。
 *  捕获阶段早于宿主 click 委托的冒泡阶段，于是两种语义都不闪：
 *    · 这次点按**不**改变沉浸态 → 类当场补回，底栏只滑出不到一帧；
 *    · 这次点按**要唤出** chrome → 随后的 `handleTapZone` 在同一任务内再摘掉它，
 *      中间不产生绘制（浏览器只在任务结束后合成）。
 *  延迟断言照旧保留 —— 非点按的摘类路径（键盘、切 leaf、抽屉）没有 click 可等。
 *
 *  ## 它**不做**什么
 *
 *  只负责「该藏而没藏」这一个方向。不主动摘类（那是 `syncNativeNav` 与
 *  `releaseNativeNav` 的职责），因此不会与官方争夺「用户主动唤出」的语义。 */

/** 插件自有的底栏隐藏类。**视觉隐藏的真实闸门**。
 *
 *  官方的 `is-hidden-nav` 只在「官方想藏」时可靠；它的 `restoreNavigation` 会在
 *  `mousedown / active-leaf-change / layout-change / config-change / 键盘 / 抽屉`
 *  六条路径上先摘类并 `MobileNavbar.show()` —— 摘类那一帧底栏就开始滑出，
 *  等守卫 90ms 后补回时已经在屏幕里露出半截。用户看到的就是「隐藏后偶发闪烁
 *  出现再关闭」。
 *
 *  这个类由 readerView 在底栏该藏的**整个生命周期**里持有：官方摘多少次
 *  `is-hidden-nav`，它都还在，CSS 的 `opacity: 0 !important` 保证底栏不会重新画出；
 *  同时它还锁住官方那条底部 fade mask（`--view-bottom-fade-mask`）——那是
 *  `is-hidden-nav` 的**第三个消费点**，之前正是它让「底栏看不见了、底部却仍在闪」。
 *  `is-hidden-nav` 仍照旧同步（官方 header / 主题 / 其它逻辑的一致性兜底），
 *  但不再是我们的视觉判据。 */
export const PLUGIN_NAV_HIDDEN_CLASS = "unreader-nav-hidden";

export interface NativeNavGuardOptions {
	/** 当前是否要求隐藏底栏。由读者视图算好**全部**判据
	 *  （「接管原生界面」∧（工具层 chrome-hidden 或滚动方向态 nativeScrollHidden）∧ 手机形态 ∧ 自活，
	 *  见 readerView.nativeNavWanted() / ui/nativeNavPolicy.ts），
	 *  守卫不重复实现任何一条。 */
	readonly wantsHidden: () => boolean;
	/** 权威重断言：按目标态写 `is-hidden-nav`（读者视图传 `syncNativeNav`）。 */
	readonly sync: () => void;
	/** 检测到 Obsidian 官方偷偷 `restoreNavigation()` 时的附加纠察：
	 *  官方恢复导航类的同一步会 `StatusBar.show()` 把系统状态栏放出来，
	 *  读者视图用它把状态栏无动画重新压回去（见 readerView.reassertStatusBarHidden）。 */
	readonly onExternalRestore?: () => void;
	/** 自愈前的等待（ms），默认 90 —— 让同一次交互里的 tap/click 链先跑完。 */
	readonly delay?: number;
}

export class NativeNavGuard {
	private mo: MutationObserver | null = null;
	private timer: number | null = null;
	private clickHandler: (() => void) | null = null;
	private readonly delay: number;

	constructor(private readonly opts: NativeNavGuardOptions) {
		this.delay = opts.delay ?? 90;
	}

	/** 开始盯防（视图 onOpen 时调用）。重复调用安全（幂等）。 */
	start(): void {
		if (this.mo) return;
		try {
			this.mo = new MutationObserver(() => this.onBodyClassChange());
			this.mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		} catch {
			// 观察器不可用（极端环境）则静默降级为「无自愈」——不影响其余同步点
			this.mo = null;
		}
	}

	/** 停止盯防（视图 onClose 时调用，**必须先于** releaseNativeNav）：
	 *  否则 releaseNativeNav 摘类会被守则当成「外部摘类」，在本视图关闭、
	 *  自活判据尚未翻转的窗口里又补回去 —— app 级类残留会污染下一个视图。 */
	stop(): void {
		if (this.mo) {
			try { this.mo.disconnect(); } catch { /* ignore */ }
			this.mo = null;
		}
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.disarmClick();
	}

	/** body 的类变了：只有「该藏而没藏」才排队，且同批变化合并为一次。 */
	private onBodyClassChange(): void {
		if (!this.wanted()) return;
		// 能走到这里说明「该藏却被外部摘掉了」——官方 restoreNavigation 在摘类的
		// 同一步还把系统状态栏 show 了出来，顺手通知读者视图做状态栏纠察。
		try { this.opts.onExternalRestore?.(); } catch { /* ignore */ }
		const body = document.body;
		// **插件视觉闸门还在、只缺官方类**：立即在同一微任务里补回，绝不跨帧。
		// MutationObserver 回调发生在浏览器绘制之前，所以官方类不存在的窗口长度是 0 ——
		// mask、主题规则、未来新增的任何 `is-hidden-nav` 消费点都不会看到中间态。
		// 这里不调整套 `sync()`：mousedown 每次都会走这条，轻量补一个类即可；
		// 插件类本身也缺时才进下面的延迟/点击快路（那才需要等 tap 语义落定）。
		if (body.classList.contains(PLUGIN_NAV_HIDDEN_CLASS)) {
			if (!body.classList.contains("is-hidden-nav")) body.classList.add("is-hidden-nav");
			return;
		}
		this.armClick();
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			// 延迟窗口内用户可能已经唤出 chrome（wantsHidden 翻转）——重新判定，
			// 不能拿排队时的结论直接写类
			if (!this.wanted()) return;
			try { this.opts.sync(); } catch { /* ignore */ }
		}, this.delay);
	}

	/** 挂一次性捕获阶段 click 快路（见文件头「为什么延迟断言之外还要一条点击快路」）。
	 *  **捕获阶段**是这条快路成立的关键：它早于宿主 click 委托的冒泡阶段，补类与
	 *  「点按要唤出」的摘类落在同一个任务里，中间不产生绘制。 */
	private armClick(): void {
		if (this.clickHandler) return;
		const handler = (): void => {
			this.disarmClick();
			if (!this.wanted()) return;
			try { this.opts.sync(); } catch { /* ignore */ }
		};
		this.clickHandler = handler;
		try { document.addEventListener("click", handler, true); } catch { /* ignore */ }
	}

	private disarmClick(): void {
		if (!this.clickHandler) return;
		try { document.removeEventListener("click", this.clickHandler, true); } catch { /* ignore */ }
		this.clickHandler = null;
	}

	/** 是否处于「该藏而没藏」：视图要求隐藏 ∧（插件视觉类或官方类缺失）。
	 *
	 *  插件类是**硬目标**：它缺了，底栏会真的可见（哪怕官方类还在，官方 CSS 仍会
	 *  把它藏住，但视觉契约已经破了一半）；官方类缺了也补，因为它承载官方的
	 *  mask/header 等一致性语义。两者都在才返回 false，守卫只补不撤。 */
	private wanted(): boolean {
		try {
			if (!this.opts.wantsHidden()) return false;
			const cls = document.body.classList;
			// 目标态 = 视觉闸门（插件类）∧ 官方类都到位。插件类没到位是真正的
			// 「该藏却没藏」；官方类没到位也要补回，但补回过程不再影响可见性。
			return !cls.contains(PLUGIN_NAV_HIDDEN_CLASS) || !cls.contains("is-hidden-nav");
		} catch {
			return false;
		}
	}
}
