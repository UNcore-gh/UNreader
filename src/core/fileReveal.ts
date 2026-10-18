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
 *  只走应用内文件浏览器。运行期入口不可用、文件不存在或调用失败时，明确告知用户；
 *  不把打开系统文件管理器伪装成应用内定位成功。 */

import { Notice, TFile, type App } from "obsidian";

/** 运行期才有、公开 typings 里没有的那两块（见文件头）。全部按可选能力探测。 */
interface FileExplorerBridge {
	revealInFolder?: (file: TFile) => void
	instance?: {
		revealInFolder?: (file: TFile) => void
	}
}
interface InternalPluginsBridge {
	getPluginById?: (id: string) => FileExplorerBridge | null
}
interface AppWithReveal extends App {
	internalPlugins?: InternalPluginsBridge
}

export function revealFileInFolder(app: App, path: string): boolean {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile)) { new Notice("文件已移动或删除，请刷新侧栏"); return false; }
	const bridge = app as AppWithReveal;
	// ① 应用内文件浏览器（桌面 + 移动端）。
	try {
		const explorer = bridge.internalPlugins?.getPluginById?.("file-explorer");
		const revealInFolder = explorer?.revealInFolder ?? explorer?.instance?.revealInFolder;
		if (revealInFolder) {
			revealInFolder.call(explorer?.instance ?? explorer, file);
			return true;
		}
	} catch {
		/* 内部结构变化会由下方的明确失败提示接住 */
	}
	new Notice("当前 Obsidian 文件浏览器无法定位此文件；请检查文件浏览器是否启用");
	return false;
}
