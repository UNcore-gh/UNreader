import { Modal, App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";

export class PageJumpModal extends Modal {
	constructor(
		app: App,
		private total: number,
		private current: number,
		private onSubmit: (page: number) => void,
	) {
		super(app);
	}

	onOpen(): void {
		// 移动端：键盘弹起时整个弹窗上移到键盘之上（见 keyboardInset 与 styles.css 的 .unreader-kb-safe）
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("跳转到页码");
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: `输入 1 – ${this.total} 之间的页码，回车跳转。`,
		});

		let submitted = false;
		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "number",
			attr: {
				min: "1",
				max: String(this.total),
				step: "1",
				placeholder: String(this.current),
			},
		});
		input.value = String(this.current);

		const submit = (): void => {
			if (submitted) return;
			submitted = true;
			const n = Math.floor(Number(input.value));
			const clamped = Math.max(1, Math.min(this.total, Number.isFinite(n) ? n : this.current));
			this.onSubmit(clamped);
			this.close();
		};

		input.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});

		const btnRow = this.contentEl.createDiv({ cls: "unreader-tag-buttons" });
		btnRow.createEl("button", { text: "跳转", cls: "mod-cta" }).addEventListener("click", submit);

		setTimeout(() => {
			input.focus();
			input.select();
		}, 50);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}
}