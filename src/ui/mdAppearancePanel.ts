/** Markdown 阅读模式的**过滤版外观面板**。
 *
 *  产品口径（2026-10-09 用户要求）：Markdown 正文的字体 / 字号 / 行距 / 页宽 / 背景由
 *  **Obsidian 原生渲染器与主题**控制，插件不复制一套；所以阅读器那块「阅读外观」面板
 *  在 Markdown 模式下只保留**真正起作用**的那几项 —— 浮动目录条、章节进度条（含分段）、
 *  沉浸阅读本身、以及沉浸态里是否保留目录条/进度条。
 *
 *  两个"不"：
 *  · **不另起一套皮肤**：容器 / 行 / 开关 / 下拉全部复用 `.unreader-appearance-*` 类，
 *    与阅读器那块面板同一视觉语言（深浅主题都已被 `test:theme-audit` 覆盖）。
 *  · **不把它拆成工具栏上的散按钮**：目录条/进度条的显隐归属「外观」，工具栏只留入口。
 *
 *  交互与阅读器那块保持一致：`open/close/toggle` 是唯一收口（按钮高亮经 `onOpenChange`
 *  回调），点面板外关闭。这里**不做**鼠标移开自动关 —— Markdown 阅读时鼠标常在正文里移动，
 *  跟着关会一直闪；触屏本来也只靠「点按钮开、点外面关」。 */

import { t, type StrKey } from "../core/i18n";

export interface MdAppearanceState {
	/** 右缘浮动目录条显隐（`mdOverlayShowTocRail`） */
	showTocRail: boolean
	/** 顶部章节进度条显隐（`mdOverlayShowProgress`） */
	showProgress: boolean
	/** 进度分段粒度：0 = 全文一根，1-6 = 按该级标题分段（`mdOverlayProgressScope`） */
	progressScope: number
	/** 是否提供「切换笔记沉浸阅读」命令（`mdOverlayImmersive`） */
	immersive: boolean
	/** 沉浸态是否保留浮动目录条（`appearance.fullImmersionShowTocRail`） */
	immersionKeepToc: boolean
	/** 沉浸态是否保留章节进度条（`appearance.fullImmersionShowChapterProgress`） */
	immersionKeepProgress: boolean
}

export interface MdAppearancePanelOptions {
	/** 现读当前状态（每次 render 现取，避免面板里显示旧值）。 */
	read: () => MdAppearanceState
	/** 写回一项；宿主负责落盘 + 同步所有 Markdown 会话。 */
	write: (patch: Partial<MdAppearanceState>) => void
	/** 开 / 合回调：宿主据此同步工具栏按钮的「作用中」高亮。 */
	onOpenChange?: (open: boolean) => void
}

const SCOPE_OPTION_KEYS: Array<{ value: number; labelKey: StrKey }> = [
	{ value: 0, labelKey: "mdApWhole" },
	{ value: 1, labelKey: "mdApHeading1" },
	{ value: 2, labelKey: "mdApHeading2" },
	{ value: 3, labelKey: "mdApHeading3" },
	{ value: 4, labelKey: "mdApHeading4" },
	{ value: 5, labelKey: "mdApHeading5" },
	{ value: 6, labelKey: "mdApHeading6" },
];

export class MdAppearancePanel {
	readonly containerEl: HTMLElement;
	private readonly options: MdAppearancePanelOptions;
	/** 打开后的短窗口内忽略外部 pointerdown（覆盖点击触发按钮时的同一次指针事件链）。 */
	private ignoreOutsideUntil = 0;

	constructor(options: MdAppearancePanelOptions) {
		this.options = options;
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-appearance-panel";
	}

	open(): void {
		this.ignoreOutsideUntil = performance.now() + 300;
		this.render();
		this.containerEl.addClass("is-open");
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
		this.options.onOpenChange?.(true);
	}

	close(): void {
		if (!this.containerEl.hasClass("is-open")) return;
		this.containerEl.removeClass("is-open");
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		this.options.onOpenChange?.(false);
	}

	toggle(): boolean {
		if (this.isOpen()) this.close();
		else this.open();
		return this.isOpen();
	}

	isOpen(): boolean {
		return this.containerEl.hasClass("is-open");
	}

	/** 设置变化后重绘（工具栏按钮改开关、快捷键改设置都要让面板跟上）。 */
	refresh(): void {
		if (this.isOpen()) this.render();
	}

	/** 卸载清场：面板被拆掉时必须摘掉 document 级监听（宿主是官方视图，不能留残留）。 */
	dispose(): void {
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		this.containerEl.remove();
	}

	private onDocPointerDown = (ev: PointerEvent): void => {
		if (performance.now() < this.ignoreOutsideUntil) return;
		const target = ev.target as HTMLElement | null;
		if (!target) return;
		if (this.containerEl.contains(target)) return;
		// 点工具栏那枚按钮交给它自己的 click 处理（否则会「关了又开」）
		if (target.closest(".unreader-actions")) return;
		this.close();
	};

	private render(): void {
		const prevScroll = this.containerEl.querySelector(".unreader-appearance-scroll")?.scrollTop ?? 0;
		this.containerEl.empty();
		const scrollEl = this.containerEl.createDiv({ cls: "unreader-appearance-scroll" });
		scrollEl.createDiv({ cls: "unreader-appearance-header" }).createSpan({ text: t("apTitle") });

		// 说明为什么这里比阅读器那块面板短：正文排版归 Obsidian，插件只管自己的组件。
		scrollEl.createDiv({
			cls: "unreader-appearance-hint",
			text: t("mdApDescription"),
		});

		const s = this.options.read();
		scrollEl.appendChild(this.toggleRow(t("apFloatingToc"), s.showTocRail, v => this.options.write({ showTocRail: v })));
		scrollEl.appendChild(this.toggleRow(t("apChapterProgress"), s.showProgress, v => this.options.write({ showProgress: v })));
		scrollEl.appendChild(this.selectRow(t("mdApProgressScope"), SCOPE_OPTION_KEYS.map(option => ({
			value: option.value,
			label: t(option.labelKey),
		})), s.progressScope, v => this.options.write({ progressScope: v })));

		scrollEl.createDiv({ cls: "unreader-appearance-header" }).createSpan({ text: t("apFullImmersion") });
		scrollEl.appendChild(this.toggleRow(t("mdApImmersionCommand"), s.immersive, v => this.options.write({ immersive: v })));
		scrollEl.appendChild(this.toggleRow(t("mdApKeepToc"), s.immersionKeepToc, v => this.options.write({ immersionKeepToc: v })));
		scrollEl.appendChild(this.toggleRow(t("mdApKeepProgress"), s.immersionKeepProgress, v => this.options.write({ immersionKeepProgress: v })));

		if (prevScroll) scrollEl.scrollTop = prevScroll;
	}

	private toggleRow(label: string, checked: boolean, onToggle: (v: boolean) => void): HTMLElement {
		const row = createDiv();
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label is-label-wide", text: label });
		const input = row.createEl("input", { type: "checkbox" });
		input.checked = checked;
		input.className = "unreader-appearance-toggle";
		input.addEventListener("change", () => onToggle(input.checked));
		return row;
	}

	private selectRow(label: string, options: Array<{ value: number; label: string }>, active: number, onPick: (v: number) => void): HTMLElement {
		const row = createDiv();
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label", text: label });
		const control = row.createDiv({ cls: "unreader-appearance-control" });
		const select = control.createEl("select", { cls: "dropdown" });
		for (const opt of options) select.createEl("option", { value: String(opt.value), text: opt.label });
		select.value = String(active);
		select.addEventListener("change", () => {
			const picked = options.find(o => String(o.value) === select.value);
			if (picked) onPick(picked.value);
		});
		return row;
	}
}
