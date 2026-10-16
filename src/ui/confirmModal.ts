import type { App } from "obsidian";
import { UnreaderModal } from "./modalSkin";

export interface ConfirmOptions {
	title: string;
	body: string;
	/** 主按钮文案（默认「确定」） */
	cta?: string;
	/** 破坏性操作：主按钮标红（走 `mod-warning` 类，不用 1.13 才有的 setDestructive） */
	destructive?: boolean;
}

/** 破坏性操作确认框 —— `window.confirm()` 的替代品。
 *
 *  为什么必须换掉：`confirm()` 同步阻塞渲染进程，在移动端 WebView 上是出了名的卡顿源，
 *  样式也与 Obsidian 无关；官方上架规则（`no-alert`）明确禁止。
 *  返回 Promise<boolean>，调用方 `await` 即可，语义与 `confirm()` 一一对应
 *  （关掉弹窗 / 按 ESC = false）。 */
export class ConfirmModal extends UnreaderModal {
	private settled = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly settle: (value: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		this.contentEl.createEl("p", { text: this.options.body });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(false));
		const cta = buttons.createEl("button", { text: this.options.cta ?? "确定", cls: "mod-cta" });
		if (this.options.destructive) cta.addClass("mod-warning");
		cta.addEventListener("click", () => this.finish(true));
	}

	onClose(): void {
		this.contentEl.empty();
		// 直接关掉（ESC / 点遮罩）= 取消，不能悬着那个 Promise
		if (!this.settled) this.settle(false);
	}

	private finish(value: boolean): void {
		this.settled = true;
		this.settle(value);
		this.close();
	}
}

/** 打开确认框并等待用户选择。 */
export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		new ConfirmModal(app, options, resolve).open();
	});
}
