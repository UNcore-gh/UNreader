/** 「定位到文件夹」的唯一实现（笔记卡三枚按钮之一，用户 2026-10-13 定稿）。
 *
 *  为什么要有这一层：这件事在 Obsidian 里有**两条**互不替代的通路，而两条都不在公开
 *  typings 里（`obsidian.d.ts` 既没有 `internalPlugins` 也没有 `App.showInFolder`，
 *  它们只存在于运行期）——把这段探测写在两处调用点必然漂移，也会让「哪条先走」变成
 *  两处各自的口径，所以收口成一个函数：
 *
 *  ① **应用内文件浏览器**（`internalPlugins.getPluginById("file-explorer").revealInFolder`）——
 *     官方右键菜单里的「在文件浏览器中显示」走的就是它；**桌面与移动端都有**，展开侧栏
 *     并把那一行滚进视野，用户在应用里就能看到「这篇在哪个文件夹」。
 *  ② **系统文件管理器**（`App.showInFolder`）—— 桌面端在 Finder / 资源管理器里选中该文件；
 *     移动端该方法是 no-op（运行期第一句就是 `if (isDesktopApp)`）。
 *
 *  所以顺序是「先在文件浏览器里定位、再退到系统」，而 ① 取不到（老版本 / 内部插件停用 /
 *  探查抛错）才走 ②；两条都拿不到就**什么都不做** —— 这是「定位」，失败没有可执行的动作，
 *  弹一条报错只会打扰（与笔记卡的复制路径同一姿态）。 */

import { TFile, type App } from "obsidian";

/** 运行期才有、公开 typings 里没有的那两块（见文件头）。全部按可选能力探测。 */
interface FileExplorerBridge {
	revealInFolder?: (file: TFile) => void
}
interface InternalPluginsBridge {
	getPluginById?: (id: string) => FileExplorerBridge | null
}
interface AppWithReveal extends App {
	internalPlugins?: InternalPluginsBridge
	showInFolder?: (path: string) => unknown
}

export function revealFileInFolder(app: App, path: string): void {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile)) return;
	const bridge = app as AppWithReveal;
	// ① 应用内文件浏览器（桌面 + 移动端）。
	try {
		const explorer = bridge.internalPlugins?.getPluginById?.("file-explorer");
		if (explorer?.revealInFolder) {
			explorer.revealInFolder(file);
			return;
		}
	} catch {
		/* 内部结构变了 → 退到下一条，不打断调用方 */
	}
	// ② 系统文件管理器（仅桌面；移动端静默无操作）。
	try {
		bridge.showInFolder?.(file.path);
	} catch {
		/* 两条都没有：什么都不做 */
	}
}
