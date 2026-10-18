import { App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { UnreaderModal } from "./modalSkin";
import { t } from "../core/i18n";

export class PresetNameModal extends UnreaderModal {
	private name: string;
	private onSubmit: (name: string | null) => void;

	constructor(app: App, defaultName: string, onSubmit: (name: string | null) => void) {
		super(app);
		this.name = defaultName;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		// 移动端：键盘弹起时整个弹窗上移到键盘之上（见 keyboardInset 与 styles.css 的 .unreader-kb-safe）
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText(this.name ? t("presetRenameTitle") : t("presetSaveTitle"));
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: this.name ? t("presetRenameDesc") : t("presetSaveDesc"),
		});

		let submitted = false;
		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "text",
			attr: { placeholder: t("presetNamePlaceholder") },
		});
		input.value = this.name;
		input.select();

		const submit = (): void => {
			if (submitted) return;
			submitted = true;
			const val = input.value.trim();
			this.onSubmit(val || null);
			this.close();
		};
		const cancel = (): void => {
			if (submitted) return;
			submitted = true;
			this.onSubmit(null);
			this.close();
		};

		input.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
		});

		const btnRow = this.contentEl.createDiv({ cls: "unreader-tag-buttons" });
		btnRow.createEl("button", { text: t("cancel") }).addEventListener("click", cancel);
		btnRow.createEl("button", { text: this.name ? t("presetRenameAction") : t("presetSaveAction"), cls: "mod-cta" }).addEventListener("click", submit);

		window.setTimeout(() => input.focus(), 50);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}
}
