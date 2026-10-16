/** Obsidian 移动端原生底栏的“源头闸门”。
 *
 *  原来的修复同时由 `readerView`、Markdown 叠加层和 CSS 视觉闸门写隐藏状态，
 *  多个视图不活跃时也会把全局类摘掉；官方的 `restoreNavigation()` 又会调用
 *  `MobileNavbar.show()`。这让一次点按在多个互相独立的状态机之间来回交接。
 *
 *  这里把所有 owner 的隐藏意图汇总成**唯一一份官方 `is-hidden-nav` 状态**，并在
 *  需要隐藏时从源头挡住对应的官方恢复调用：
 *    · `mobileNavbar.restoreNavigation()` —— 不再摘类、不再触发 show；
 *    · `mobileNavbar.show()` —— 不再把底栏挂回 DOM；
 *    · `mobileToolbar.show()` —— 不再挂出键盘工具条。
 *  这样官方后续新增多少条“恢复导航”的触发路径，只要最终走这几个方法，
 *  隐藏只由 Obsidian 自己的 `is-hidden-nav` 样式完成；不额外 detach 底栏，也不再
 *  叠一层插件 CSS 去盖住它。这样一次状态变化只有一条底栏显隐通道。
 *
 *  ## 多所有者 + 作用域（2026-10-12）
 *
 *  闸门原本是「单一所有者」：谁最后要求隐藏就归谁。md 寄生层也要用同一条闸门
 *  （划词期间让官方快速编辑栏让位），而**它只要压工具条、绝不能碰底栏** ——
 *  单所有者语义下两边会互相顶掉（md 一 sync 就把阅读器的沉浸闸门还原了）。
 *  于是改成注册表：每个 owner 一条 demand，闸门按「任一 demand 要求隐藏」生效，
 *  补丁集合取所有 demand 作用域的并集；owner 释放时只摘自己那条。
 *
 *  ⚠️ 官方 `MobileToolbar`（asar 1.14.4，混淆名 `q8`）只有 `show()` 一个入口是
 *  插件可控的：`update()` 的门控是 `workspace.activeEditor?.editor.hasFocus()`
 *  （Android 上再与 `hasKeyboardVisible || isMultiWindowMode` 相与），`show()` 内部
 *  只做 `mobileNavbar.hide()` + 挂元素 + `body.mod-toolbar-open`。**不要**绕开它自己
 *  detach 元素：那样官方 `isVisible` 会留在 true，之后再也不 show ⇒ 用户彻底失去工具条。
 */

type ChromeMethod = (...args: unknown[]) => unknown;
type ChromeHost = Record<string, unknown>;

/** 要接管哪几个官方入口。缺省两者都管（阅读器语义不变）。 */
export interface ChromeScope {
	/** 官方底栏（`mobileNavbar`）：沉浸隐藏用 */
	navbar?: boolean;
	/** 官方键盘快速编辑栏（`mobileToolbar`）：划词让位用 */
	toolbar?: boolean;
}

interface PatchedMethod {
	readonly host: ChromeHost;
	readonly key: string;
	readonly original: ChromeMethod;
	readonly wrapped: ChromeMethod;
}

interface Demand {
	owner: object;
	app: object;
	doc: Document;
	wantsHidden: () => boolean;
	navbar: boolean;
	toolbar: boolean;
	/** 上一次求值结果：让热路径（滚动每帧 sync）不重建闸门 */
	lastWanted: boolean;
}

function readChromeMethod(host: object, key: string): ChromeMethod | null {
	const value = (host as ChromeHost)[key];
	return typeof value === "function" ? value as ChromeMethod : null;
}

/** 替换实例方法。官方把 `mobileNavbar` / `mobileToolbar` 挂在 App 实例上，
 *  实例属性优先于 prototype，因此这里是官方调用链会实际经过的入口。 */
function patchChromeMethod(
	host: object,
	key: string,
	wantsHidden: () => boolean,
	patches: PatchedMethod[],
): void {
	const original = readChromeMethod(host, key);
	if (!original) return;
	const wrapped: ChromeMethod = (...args: unknown[]): unknown => {
		if (wantsHidden()) return undefined;
		return original.apply(host, args);
	};
	(host as ChromeHost)[key] = wrapped;
	patches.push({ host: host as ChromeHost, key, original, wrapped });
}

/** 所有者的注册表（顺序 = 注册顺序，求值是 OR）。 */
const demands: Demand[] = [];
let activeGate: NativeChromeGate | null = null;
const navbarBaselines = new WeakMap<Document, { hiddenBeforeOwnership: boolean }>();

function wantsOf(demand: Demand): boolean {
	try {
		return demand.wantsHidden() === true;
	} catch {
		// 判据本身出错时按「不要求隐藏」处理：宁可漏压一次，也不能把底栏永久扣住。
		return false;
	}
}

function anyWantsHidden(): boolean {
	return demands.some(demand => wantsOf(demand) && (demand.navbar || demand.toolbar));
}

function anyWantsNavbarHidden(doc: Document): boolean {
	return demands.some(demand => demand.doc === doc && demand.navbar && wantsOf(demand));
}

function anyWantsToolbarHidden(): boolean {
	return demands.some(demand => demand.toolbar && wantsOf(demand));
}

/** 官方类是所有阅读视图共用的唯一显隐状态；任一不活跃 owner 都不能单独摘掉它。 */
function syncOfficialNavbarClass(doc: Document): void {
	try {
		const body = doc.body;
		const wanted = anyWantsNavbarHidden(doc);
		let baseline = navbarBaselines.get(doc);
		if (wanted) {
			if (!baseline) {
				baseline = { hiddenBeforeOwnership: body.classList.contains("is-hidden-nav") };
				navbarBaselines.set(doc, baseline);
			}
			if (!body.classList.contains("is-hidden-nav")) body.classList.add("is-hidden-nav");
			return;
		}
		// 没有插件 owner 持有时，不动 Obsidian 自己或其他插件留下的官方状态。
		if (!baseline) return;
		navbarBaselines.delete(doc);
		if (baseline.hiddenBeforeOwnership) body.classList.add("is-hidden-nav");
		else body.classList.remove("is-hidden-nav");
	} catch { /* document 尚未就绪时由下一次 owner sync 重试 */ }
}

export class NativeChromeGate {
	private patches: PatchedMethod[] = [];

	private constructor(
		/** 当前所有者（通常是 readerView / MdSelectionController 实例） */
		readonly owner: object,
		private readonly app: object,
		private readonly wantsNavbarHidden: () => boolean,
		private readonly wantsToolbarHidden: () => boolean,
		private readonly scope: Required<ChromeScope>,
	) {
		const chrome = app as {
			mobileNavbar?: object;
			mobileToolbar?: object;
		};
		if (this.scope.navbar) {
			const nav = chrome.mobileNavbar;
			if (nav) {
				// restoreNavigation 是官方所有“顺手恢复底栏”路径的总闸；
				// show 是 keyboardWillHide 等不经 restoreNavigation 的直连路径。
				patchChromeMethod(nav, "restoreNavigation", this.wantsNavbarHidden, this.patches);
				patchChromeMethod(nav, "show", this.wantsNavbarHidden, this.patches);
			}
		}
		if (this.scope.toolbar) {
			const toolbar = chrome.mobileToolbar;
			if (toolbar) {
				patchChromeMethod(toolbar, "show", this.wantsToolbarHidden, this.patches);
			}
		}
	}

	/** 已装好的补丁是否就够用（app 与作用域都没变就不用拆了重建）。 */
	private matches(app: object, scope: Required<ChromeScope>): boolean {
		return this.app === app && this.scope.navbar === scope.navbar && this.scope.toolbar === scope.toolbar;
	}

	/** 按目标态同步本 owner 的 demand，再按全体 demand 的并集重建闸门。
	 *
	 *  `owner` 是身份标记：同一 owner 反复 sync 只更新它自己那条（阅读器滚动路径每帧都调）。
	 *  `scope` 缺省 = 两者都管。 */
	static sync(owner: object, app: object, wantsHidden: () => boolean, scope?: ChromeScope, doc: Document = document): void {
		const next: Required<ChromeScope> = {
			navbar: scope?.navbar !== false,
			toolbar: scope?.toolbar !== false,
		};
		const wanted = wantsOf({ owner, app, doc, wantsHidden, navbar: next.navbar, toolbar: next.toolbar, lastWanted: false });
		const index = demands.findIndex(demand => demand.owner === owner);
		const current = index >= 0 ? demands[index] : null;
		// 热路径：同一 owner 的判据值与作用域都没变 —— 什么都不用做（滚动期间绝大多数调用走这里）。
		if (current && current.app === app && current.doc === doc
			&& current.navbar === next.navbar && current.toolbar === next.toolbar && current.lastWanted === wanted) {
			current.app = app;
			current.doc = doc;
			current.wantsHidden = wantsHidden;
			syncOfficialNavbarClass(doc);
			return;
		}
		if (current) {
			current.app = app;
			current.doc = doc;
			current.wantsHidden = wantsHidden;
			current.navbar = next.navbar;
			current.toolbar = next.toolbar;
			current.lastWanted = wanted;
		} else {
			demands.push({ owner, app, doc, wantsHidden, navbar: next.navbar, toolbar: next.toolbar, lastWanted: wanted });
		}
		NativeChromeGate.recompose(app);
		syncOfficialNavbarClass(doc);
	}

	/** 注销该 owner 的 demand（其它 owner 不受影响）。 */
	static release(owner: object): void {
		const index = demands.findIndex(demand => demand.owner === owner);
		if (index < 0) return;
		const removed = demands[index];
		demands.splice(index, 1);
		if (activeGate) NativeChromeGate.recompose(activeGate.app);
		if (removed) syncOfficialNavbarClass(removed.doc);
	}

	/** 按全体 demand 的并集重建（只在「需要 / 不需要」或补丁集合变化时动）。 */
	private static recompose(app: object): void {
		if (!anyWantsHidden()) {
			activeGate?.release();
			activeGate = null;
			return;
		}
		const scope: Required<ChromeScope> = {
			navbar: demands.some(demand => demand.navbar && wantsOf(demand)),
			toolbar: demands.some(demand => demand.toolbar && wantsOf(demand)),
		};
		if (activeGate?.matches(app, scope)) return;
		activeGate?.release();
		const navbarDoc = demands.find(demand => demand.app === app && demand.navbar)?.doc ?? document;
		activeGate = new NativeChromeGate(
			demands[0]?.owner ?? {},
			app,
			() => anyWantsNavbarHidden(navbarDoc),
			anyWantsToolbarHidden,
			scope,
		);
	}

	/** **诊断出口（只读，零副作用）**：把闸门当前的**全部 demand 与生效作用域**读出来。
	 *
	 *  为什么非要有它：闸门替换的是 `app.mobileToolbar.show` 这类挂在 **App 实例**上的
	 *  入口 —— 一旦装好，它是**全局**的：任一 owner 的判据为 true，官方快速编辑栏就在
	 *  **所有视图**（含纯 markdown 笔记）里都不出现。真机上「原生快速编辑栏消失」与
	 *  「我们的划词工具条不出现」同时发生时，光看产品代码分不出是哪种：
	 *    · 某个 owner 的 demand 泄漏（判据恒真 / 该 release 时没 release）⇒ 永久屏蔽；
	 *    · 闸门本体压根没装 / 装错作用域 ⇒ 与现象无关。
	 *  只有把这张注册表原样落盘才能分辨。由 `mdSelection` 的取证通道带进报告
	 *  （`selectionDiag.recordCaptureDiag` 的 `gate` 字段）。 */
	static debugState(): {
		active: { navbar: boolean; toolbar: boolean } | null;
		patched: string[];
		demands: Array<{ owner: string; navbar: boolean; toolbar: boolean; wanted: boolean }>;
	} {
		try {
			return {
				active: activeGate ? { navbar: activeGate.scope.navbar, toolbar: activeGate.scope.toolbar } : null,
				patched: activeGate ? activeGate.patches.map(p => p.key) : [],
				demands: demands.map(d => ({
					// owner 是实例，名字（readerView / MdSelectionController…）就是「谁在要求隐藏」
					owner: (d.owner as { constructor?: { name?: string } })?.constructor?.name ?? "?",
					navbar: d.navbar,
					toolbar: d.toolbar,
					wanted: wantsOf(d),
				})),
			};
		} catch {
			return { active: null, patched: [], demands: [] };
		}
	}

	/** 还原所有实例方法。只还原仍是自己 wrapper 的项；如果后续被别人改写，则不回写旧引用。 */
	release(): void {
		for (let index = this.patches.length - 1; index >= 0; index--) {
			const patch = this.patches[index];
			if (!patch) continue;
			if (patch.host[patch.key] === patch.wrapped) {
				patch.host[patch.key] = patch.original;
			}
		}
		this.patches = [];
		if (activeGate === this) activeGate = null;
	}
}
