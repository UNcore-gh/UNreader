import { App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { UnreaderModal } from "./modalSkin";

export class BookmarkModal extends UnreaderModal {
	constructor(
		app: App,
		private onSubmit: (label: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		// 移动端：键盘弹起时整个弹窗上移到键盘之上（见 keyboardInset 与 styles.css 的 .unreader-kb-safe）
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("添加书签");
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: "为当前阅读位置添加书签，可填写备注便于识别（可选）。",
		});

		let submitted = false;
		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "text",
			attr: { placeholder: "备注（可选），如：重点章节" },
		});
		const submit = (): void => {
			if (submitted) return;
			submitted = true;
			this.onSubmit(input.value.trim());
			this.close();
		};
		input.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});

		const btnRow = this.contentEl.createDiv({ cls: "unreader-tag-buttons" });
		btnRow.createEl("button", { text: "添加", cls: "mod-cta" }).addEventListener("click", submit);

		window.setTimeout(() => input.focus(), 50);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}
}
