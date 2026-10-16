/** 全沉浸**会话**的边界判据 —— 纯函数，不碰 DOM，可单测。
 *
 *  ## 它回答的问题
 *
 *  「这一次活动叶子变化算不算**切到了别的视图**」—— 全沉浸是会话态，只有真的换视图
 *  才结束（`exitFullImmersion`）、才释放原生导航（`releaseNativeNav`）。
 *
 *  ## 为什么需要单独一条判据（2026-09-29 报障）
 *
 *  用户报障原话：「iPad 上，固定侧边栏，然后聚焦侧边栏 ai 的输入框时，会自动从
 *  沉浸模式退出」。
 *
 *  根因在**官方**（obsidian.asar 实测反编译，不是猜的）：`WorkspaceLeaf` 的构造函数
 *  给**每一个** leaf 的容器都挂了这两条：
 *  ```js
 *  r.addEventListener("focusin", () => i.app.workspace.setActiveLeaf(i));
 *  r.addEventListener("pointerdown", () => i.app.workspace.setActiveLeaf(i), { capture: true });
 *  ```
 *  而 `setActiveLeaf` 一旦发现 `activeLeaf` 换人就会派发 `active-leaf-change`。
 *  ⇒ 用户**只是往侧栏的输入框里点一下 / 聚焦一次**，活动叶子就换成了侧栏那个 leaf，
 *  本视图按旧判据（「活动叶子不是自己」）当成「切到了别的视图」→ `exitFullImmersion()`
 *  + `releaseNativeNav()` —— 用户看到的正是「打字打到一半，界面全回来了」。
 *
 *  iPad 上最容易撞上，两个条件都齐：① 移动端抽屉可以**钉住**
 *  （`WorkspaceMobileDrawer.isPinned`，就是用户说的「固定侧边栏」），钉住后它与阅读器
 *  并存可见、随手就能点；② pad 形态下本插件不接管 app 级底栏（`phoneLike()` 为 false，
 *  见 nativeNavPolicy），侧栏里的 AI 面板在沉浸态里照常能点能聚焦。
 *
 *  ## 判据
 *
 *  侧栏（左右 sidedock / 移动端抽屉）里拿到的活动位**不是**换视图：阅读器仍是内容区
 *  那个视图、还在屏幕上，只是焦点被侧栏拿走了。因此两条出口的语义对齐：
 *  · `exitFullImmersion()` —— 不结束会话；
 *  · `releaseNativeNav()` —— 同样不动（它会清 `nativeScrollHidden`，页首/底栏会跟着
 *    回来 = 同一个「自动退出沉浸」的观感，只是少了一半界面）。
 *
 *  ## 与 `isSelfActive()` 的分工（别合并）
 *
 *  `isSelfActive()` 答的是**另一件事**：「本视图有没有资格写 app 级类
 *  （官方 `body.is-hidden-nav`）」。焦点在侧栏期间本视图确实不再是
 *  `workspace.activeLeaf`，app 级类照老规矩释放 —— 否则「藏底栏」会被带进侧栏那个
 *  视图，正是 `nativeNavGuard.ts` 文件头记的污染事故（手机形态尤甚：侧栏里的编辑器
 *  要靠官方 `mobileToolbar` 才有的键盘工具条，闸门不能替它扣着）。
 *  所以这条判据只放宽**会话**边界，不动写类资格。 */

/** 活动叶子变化的两条事实（readerView 现取，判据本体不碰 DOM）。 */
export interface ActiveLeafChangeFacts {
	/** 新的活动叶子就是本视图自己的叶子。 */
	readonly self: boolean;
	/** 新叶子在**侧栏**里（左右 sidedock / 移动端抽屉），见 `isSidePanelLeaf`。 */
	readonly sidePanel: boolean;
}

/** 这次活动叶子变化是否结束全沉浸会话。
 *
 *  · `self`（切回本视图）：不结束 —— 会话继续；
 *  · `sidePanel`（焦点落进侧栏）：不结束 —— 理由见文件头；
 *  · 其余（活动叶子换成了**别的内容视图**）：结束。 */
export function endsImmersionOnActiveLeafChange(i: ActiveLeafChangeFacts): boolean {
	return !i.self && !i.sidePanel;
}

/** 该叶子是不是「侧栏面板」里的叶子（桌面左右 sidedock / 移动端抽屉）。
 *
 *  **只用公开 API 判身份，不枚举 DOM 结构**：`WorkspaceLeaf.getRoot()`
 *  （`WorkspaceItem` 自带，≥0.10.2）返回叶子所在的那个「坞」—— 内容区叶子给
 *  `workspace.rootSplit`，侧栏叶子给 `workspace.leftSplit` / `rightSplit`
 *  （桌面的 `WorkspaceSidedock`、移动端的 `WorkspaceMobileDrawer` 都在这个位置上），
 *  弹出窗口给 `floatingSplit`。比身份即可，不需要 instanceof、不需要平台判断，
 *  窗口跨过 media query 门槛（折叠屏展开 / 分屏 / 台前调度）也不漂移。
 *
 *  取不到 `getRoot`（老版本 / 形态漂移）时退回**容器包含**判据（`containerEl` 同为
 *  公开 API；`side` 既接受 sidedock 对象也接受裸容器元素 —— 只认前者会让这条兜底在
 *  形态漂移时静默失效）；两者都拿不到就返回 `false` —— **退回旧行为**（把侧栏也当
 *  换视图），最坏只是回到这次修之前的观感，绝不误伤「真的换了视图」那一路。 */
export function isSidePanelLeaf(leaf: unknown, workspace: unknown): boolean {
	if (!leaf || typeof leaf !== "object") return false;
	try {
		const ws = workspace as { leftSplit?: unknown; rightSplit?: unknown; mobileDrawer?: unknown } | null;
		// 老版本把移动端抽屉单独挂在 `workspace.mobileDrawer` 上（现已并入 leftSplit），
		// 一并认；新版本取到 undefined 自然跳过。
		const sides = [ws?.leftSplit, ws?.rightSplit, ws?.mobileDrawer];
		const root = (leaf as { getRoot?: () => unknown }).getRoot?.();
		if (root) return sides.includes(root);
		const leafEl = (leaf as { containerEl?: unknown }).containerEl as Node | undefined;
		if (!leafEl || typeof leafEl.nodeType !== "number") return false;
		for (const side of sides) {
			const splitEl = ((side as { containerEl?: unknown } | undefined)?.containerEl ?? side) as Node | undefined;
			if (splitEl && typeof splitEl.nodeType === "number" && splitEl.contains(leafEl)) return true;
		}
		return false;
	} catch {
		return false;
	}
}
