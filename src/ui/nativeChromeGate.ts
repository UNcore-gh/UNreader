/** Obsidian 移动端原生底栏的“源头闸门”。
 *
 *  原来的修复靠 `body.unreader-nav-hidden` 挡视觉，再由 MutationObserver 补回
 *  `is-hidden-nav`。它已经能阻止大多数闪现，但仍有一个时序残留：
 *  Obsidian 的 `restoreNavigation()` 会**先**移类并调用 `MobileNavbar.show()`，
 *  `show()` 还会把底栏元素重新 `appendChild()` 进 app 容器；同时
 *  `MobileToolbar.show()` 也会挂载键盘工具条和占位。我们随后虽然能压回去，
 *  但调用本身已经发生过。
 *
 *  这里改成在阅读器要求隐藏 native chrome 的期间，直接接管三个入口：
 *    · `mobileNavbar.restoreNavigation()` —— 不再摘类、不再触发 show；
 *    · `mobileNavbar.show()` —— 不再把底栏挂回 DOM；
 *    · `mobileToolbar.show()` —— 不再挂出键盘工具条。
 *  这样官方后续新增多少条“恢复导航”的触发路径，只要最终走这几个方法，
 *  就无法把底栏放进渲染树；不是“画出来再隐藏”。
 *
 *  闸门是 app 级资源的单一所有者：活动阅读器进入隐藏态时接管，退出隐藏态 /
 *  失活 / 关闭视图时释放。若另一个阅读器接管，旧闸门会先完整还原，避免多层
 *  wrapper 叠罗汉。方法签名按 unknown 参数透传，不依赖 Obsidian 未公开类型。
 */

type ChromeMethod = (...args: unknown[]) => unknown;
type ChromeHost = Record<string, unknown>;

interface PatchedMethod {
	readonly host: ChromeHost;
	readonly key: string;
	readonly original: ChromeMethod;
	readonly wrapped: ChromeMethod;
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

let activeGate: NativeChromeGate | null = null;

export class NativeChromeGate {
	private patches: PatchedMethod[] = [];

	private constructor(
		/** 当前所有者（通常是 readerView 实例），用来防止失活视图释放别人的闸门。 */
		readonly owner: object,
		private readonly app: object,
		private readonly wantsHidden: () => boolean,
	) {
		const chrome = app as {
			mobileNavbar?: object;
			mobileToolbar?: object;
		};
		const nav = chrome.mobileNavbar;
		const toolbar = chrome.mobileToolbar;
		if (nav) {
			// restoreNavigation 是官方所有“顺手恢复底栏”路径的总闸；
			// show 是 keyboardWillHide 等不经 restoreNavigation 的直连路径。
			patchChromeMethod(nav, "restoreNavigation", this.wantsHidden, this.patches);
			patchChromeMethod(nav, "show", this.wantsHidden, this.patches);
			// 接管瞬间可能已有底栏/工具条挂着；源头闸门建立后立刻归位。
			const hide = readChromeMethod(nav, "hide");
			if (hide) hide.call(nav);
		}
		if (toolbar) {
			patchChromeMethod(toolbar, "show", this.wantsHidden, this.patches);
			const hide = readChromeMethod(toolbar, "hide");
			if (hide) hide.call(toolbar);
		}
	}

	/** 按目标态同步闸门。owner 只是身份标记，用于跨阅读器切换时不互相踩踏。 */
	static sync(owner: object, app: object, wantsHidden: () => boolean): void {
		if (!wantsHidden()) {
			NativeChromeGate.release(owner);
			return;
		}
		if (activeGate?.owner === owner) return;
		activeGate?.release();
		activeGate = new NativeChromeGate(owner, app, wantsHidden);
	}

	static release(owner: object): void {
		if (activeGate?.owner !== owner) return;
		activeGate.release();
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
