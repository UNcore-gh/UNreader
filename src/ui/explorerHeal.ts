/**
 * 移动端左抽屉展开 → 让官方文件列表**重新测量**一次（自愈守卫）。
 *
 * ## 为什么需要它（2026-09-13，官方 app.js 逐行取证）
 *
 * 官方文件列表（`FileExplorerView`）用 `InfinityScroll` 虚拟化，其条目测量有两条硬逻辑：
 *
 * ```js
 * // JH.prototype.measure —— 条目 offsetParent 为空（容器 display:none / 已 detach）
 * if (n.offsetParent) { i.hidden = !1; … } else { i.hidden = !0 }
 * // JH.prototype._measure —— 紧接着**无条件**写 computed
 * this.measure(e, r); r.info.computed = !0
 * // JH.prototype._layout —— computed 的条目直接早退，再也不会被重测
 * if (o.computed) return !1
 * // JH.prototype.update —— hidden 的条目**跳过子项挂载**（它自己那行仍由父层挂上）
 * if (h.parentNode) { if (s.hidden) return; … }
 * ```
 *
 * 于是：**只要在容器不可见时跑过一次 `compute()`，当趟参与测量的条目（每趟 ≤
 * `renderBlockSize = 50`）就被永久打成 `hidden`** —— 表现为「**文件夹还在，里面的内容
 * 不显示**」，而且滚动只走 `updateVirtualDisplay`（不重测）、`onResize` 也因为
 * 文件列表构造时写了 `infinityScroll.setWidth = !0` 而永远走不到 `invalidateAll()`
 * （宽度变化/旋转/分屏都救不回来）。用户看到的「条目要滑动才闪出来、滚动发飘」正是
 * `update()` 随滚动窗口反复 attach/detach，而 `hidden` 那批永不出现。
 *
 * **为什么只在手机/平板发病**：官方手机/平板的文件列表住在 `.workspace-drawer` 里，
 * 抽屉创建时就是 `hide()`（`display:none`）、收起动画结束仍 `hide()` —— 收起期间任何一次
 * `compute()` 都会污染；桌面端文件列表在常显的 split 里，`offsetParent` 永不为空 ⇒ 同一条
 * 代码不发病。全 app 用 `InfinityScroll` 的只有 文件列表/搜索/大纲/反链，而挂在移动端抽屉里的
 * **只有文件列表** —— 这解释了「只坏文件列表」。
 *
 * ## 本守卫做什么、不做什么
 *
 * **做**：移动端「左抽屉由收起变展开」后延迟两帧，调一次官方文件列表的
 * `tree.infinityScroll.invalidateAll()` —— 这正是官方「显示不支持的文件」开关内部做的
 * 动作（`updateShowUnsupportedFiles()`），是**受官方自己使用**且幂等的全量重测。
 * 于是用户只要打开抽屉，列表就自愈，症状不再需要「重启 App」才能消。
 *
 * **不做**：不去猜「谁在抽屉关着时触发了 compute」（可能是任意插件的一次 vault 事件、
 * 折叠操作或配置变更，不在本插件控制范围内）。本守卫对**任何**触发源都有效 —— 与
 * `nativeNavGuard`「不管谁摘的类，我按目标态补回」是同一个设计姿态。
 *
 * 官方内部结构变了就静默降级（全程 try + 可选链），绝不参与别人的渲染。
 */
import type { App } from "obsidian";

interface InfinityScrollLike {
	invalidateAll?: () => void;
}
interface ExplorerViewLike {
	tree?: { infinityScroll?: InfinityScrollLike };
}

/** 移动端判定：官方手机/平板才有 `.workspace-drawer`。用 Platform 而不是 matchMedia ——
 *  与「抽屉存在」这个事实同源（桌面端即使窗口很窄也不该挂本守卫）。 */
function isMobileApp(Platform: { isMobile?: boolean; isIosApp?: boolean; isAndroidApp?: boolean }): boolean {
	return Platform.isMobile === true || Platform.isIosApp === true || Platform.isAndroidApp === true;
}

const DRAWER_SELECTOR = ".workspace-drawer.mod-left";
const COLLAPSED_CLASS = "is-collapsed";

export class ExplorerHeal {
	private drawerMo: MutationObserver | null = null;
	private bootTimer: number | null = null;
	private expanded = false;
	private started = false;

	constructor(
		private readonly app: App,
		private readonly platform: { isMobile?: boolean; isIosApp?: boolean; isAndroidApp?: boolean },
	) {}

	/** 开始盯防（视图 onOpen 时调用）。重复调用安全；非移动端直接不挂（零开销）。 */
	start(): void {
		if (this.started) return;
		if (!isMobileApp(this.platform)) return;
		this.started = true;
		if (!this.attachDrawer()) {
			// 抽屉此刻还没挂载（workspace 正在恢复）。**不要**用 document.body 的
			// 子树观察器等它出现：那会让本插件进入 Obsidian 的布局热路径，移动端
			// 启动时整个 workspace 的每次插入/移动都会唤醒一次全文档 querySelector。
			// layout ready 之后抽屉一定已经在 DOM 里，在这里补挂即可；再留一个
			// 有界兜底，覆盖官方将来把抽屉改成懒加载的版本差异。
			try {
				this.app.workspace.onLayoutReady(() => {
					if (!this.started || this.drawerMo) return;
					if (this.attachDrawer()) this.stopBootWatch();
				});
			} catch { /* 官方 API 不可用时由下面的定时器兜底 */ }
			// 有界兜底：只查一次，不再观察整个 body。
			this.bootTimer = window.setTimeout(() => {
				this.bootTimer = null;
				if (!this.drawerMo) this.attachDrawer();
			}, 4000);
		}
	}

	private attachDrawer(): boolean {
		const drawer = document.querySelector<HTMLElement>(DRAWER_SELECTOR);
		if (!drawer) return false;
		try {
			this.drawerMo = new MutationObserver(() => this.onDrawerClass());
			this.drawerMo.observe(drawer, { attributes: true, attributeFilter: ["class"] });
		} catch {
			this.drawerMo = null;
			return false;
		}
		this.expanded = !drawer.classList.contains(COLLAPSED_CLASS);
		return true;
	}

	private stopBootWatch(): void {
		if (this.bootTimer !== null) { window.clearTimeout(this.bootTimer); this.bootTimer = null; }
	}

	/** 抽屉类变化：只在「收起 → 展开」这一跳动作。延迟两帧等展开自身的过渡与布局落定
	 *  —— 与 `nativeNavGuard` 的「延迟一拍再断言」同因：过渡窗口内测量拿到的几何是错的。 */
	private onDrawerClass(): void {
		const drawer = document.querySelector<HTMLElement>(DRAWER_SELECTOR);
		if (!drawer) return;
		const expanded = !drawer.classList.contains(COLLAPSED_CLASS);
		const was = this.expanded;
		this.expanded = expanded;
		if (!expanded || was) return;
		// **要打两次**，且第二次必须等展开过渡结束 —— 这一点是踩过的坑：
		// 抽屉展开是「摘 is-collapsed + 过渡动画」，动画期间容器**可见但宽度还在从 0 长开**
		// （官方 CSS `.workspace-drawer.is-collapsed .workspace-drawer-inner { width: 0 }`）。
		// 而 InfinityScroll 用**相邻兄弟 rect 之差**算行高（`i.height = (c - l) / a`）——
		// 在宽度收缩态测量，会让每个标题折行、行高被算成几十倍，视口外条目全部被 detach。
		// 所以：① 两帧后先补一次（覆盖「展开即已到位」的常见情况）；
		// ② 过渡结束后（~320ms，与官方抽屉过渡同量级）再补一次，覆盖动画窗口。
		// 两次都是幂等的全量重测，代价是一次 re-measure。
		window.requestAnimationFrame(() => window.requestAnimationFrame(() => this.heal()));
		window.setTimeout(() => this.heal(), 320);
	}

	/** 调官方文件列表的全量重测。结构不符 / 权限异常一律静默 —— 帮忙重测，不夺权。 */
	private heal(): void {
		try {
			const leaves = this.app.workspace?.getLeavesOfType?.("file-explorer") ?? [];
			for (const leaf of leaves as { view?: ExplorerViewLike }[]) {
				leaf?.view?.tree?.infinityScroll?.invalidateAll?.();
			}
		} catch { /* ignore */ }
	}

	/** 停止盯防（视图 onClose 时调用）。 */
	stop(): void {
		this.stopBootWatch();
		if (this.drawerMo) { try { this.drawerMo.disconnect(); } catch { /* ignore */ } this.drawerMo = null; }
		this.started = false;
	}
}
