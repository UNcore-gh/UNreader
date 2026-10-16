import { Platform } from "obsidian";

/**
 * 在系统默认浏览器打开一个外部链接。
 *
 * 桌面端（Electron）走 `shell.openExternal`：不用顶层 `import … from "electron"`
 * （移动端没有该模块，加载期就抛错），也不用裸 `require()`（上架规则
 * no-require-imports / no-undef 禁止）；`window.require` 是 Obsidian 桌面端暴露的
 * 同一个 require，移动端为 undefined。取不到 Electron 时回退 `window.open(_blank)`。
 *
 * 用途：**所有**"跳到浏览器/外部应用"的入口都调这里（设置页反馈渠道、阅读器里
 * 正文外链、Feed 的"阅读原文"），不要各写一份 —— 移动端与桌面端的分支只有这一处。
 */
export function openExternalLink(url: string): void {
	if (Platform.isDesktopApp) {
		try {
			const electron = (window as unknown as {
				require?: (id: string) => { shell: { openExternal: (value: string) => Promise<void> } };
			}).require?.("electron");
			if (!electron) throw new Error("electron unavailable");
			void electron.shell.openExternal(url);
			return;
		} catch { /* Electron 不可用时回退浏览器 */ }
	}
	window.open(url, "_blank", "noopener,noreferrer");
}
