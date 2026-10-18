import { setIcon } from "obsidian";

export interface CardActionButtonOptions {
	cls: string
	icon: string
	fallback: string
	label: string
	pressed?: boolean
}

/** 三类卡片共用的 28px 图标按钮；不依赖浏览器/主题对 button 的默认盒尺寸。 */
export function createCardActionButton(parent: HTMLElement, options: CardActionButtonOptions): HTMLButtonElement {
	const button = parent.createEl("button", { cls: `unreader-card-action ${options.cls}` });
	button.type = "button";
	button.setAttribute("aria-label", options.label);
	button.setAttribute("title", options.label);
	if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
	try { setIcon(button, options.icon); } catch { /* 下方检查 SVG，静默失败也有可见兜底 */ }
	const svg = button.querySelector<SVGElement>("svg");
	if (!svg || svg.childElementCount === 0) {
		button.empty();
		button.setText(options.fallback);
		button.dataset.iconFallback = options.icon;
	}
	return button;
}
