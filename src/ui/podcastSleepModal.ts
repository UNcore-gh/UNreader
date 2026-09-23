import { Notice } from "obsidian";
import type { App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { UnreaderModal } from "./modalSkin";

/** 播客睡眠定时的上限：足够覆盖长音频，又能拦住明显误输入。 */
const MAX_SLEEP_MINUTES = 720;

/** 播客睡眠定时输入框。已有定时时不只提示，还允许直接取消或替换。 */
export class PodcastSleepModal extends UnreaderModal {
	private settled = false;

	constructor(
		app: App,
		private readonly remainingMs: number,
		private readonly onSubmit: (minutes: number) => void,
		private readonly onCancel: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		// 手机上键盘会把官方弹窗压住；这个标记让弹窗参与 UNreader 的键盘让位。
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("睡眠定时");
		this.contentEl.empty();

		const remaining = this.remainingMs > 0 ? this.formatRemaining(this.remainingMs) : "";
		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: remaining
				? `当前定时还剩 ${remaining}。输入新的分钟数会替换它，范围为 1–${MAX_SLEEP_MINUTES} 分钟。`
				: `输入分钟后自动暂停播客，范围为 1–${MAX_SLEEP_MINUTES} 分钟。`,
		});

		let submitted = false;
		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "number",
			attr: {
				min: "1",
				max: String(MAX_SLEEP_MINUTES),
				step: "1",
				inputmode: "numeric",
				placeholder: "例如：30",
				"aria-label": "睡眠定时分钟数",
			},
		});

		const submit = (): void => {
			if (submitted) return;
			const value = Number(input.value);
			const minutes = Math.floor(value);
			if (!input.value.trim() || !Number.isFinite(value) || minutes < 1 || minutes > MAX_SLEEP_MINUTES) {
				new Notice(`请输入 1–${MAX_SLEEP_MINUTES} 的整数分钟`);
				input.focus();
				return;
			}
			submitted = true;
			this.onSubmit(minutes);
			this.close();
		};

		input.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});

		const buttons = this.contentEl.createDiv({ cls: "unreader-tag-buttons" });
		if (remaining) {
			buttons.createEl("button", { text: "取消定时" }).addEventListener("click", () => {
				if (this.settled) return;
				this.settled = true;
				this.onCancel();
				this.close();
			});
		}
		buttons.createEl("button", { text: "开始定时", cls: "mod-cta" }).addEventListener("click", submit);

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 50);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}

	private formatRemaining(ms: number): string {
		const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes} 分 ${seconds} 秒`;
	}
}
