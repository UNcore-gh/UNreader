import { Notice } from "obsidian";
import type { App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { UnreaderModal } from "./modalSkin";

/** 把用户输入解析成秒数。支持：90 / 90s / 1m30s / 1h2m3s / mm:ss / hh:mm:ss。 */
export function parseSeekInput(raw: string): number | null {
	const value = (raw ?? "").trim();
	if (!value) return null;

	// 纯数字（含小数）= 秒
	const secondsOnly = /^(\d+(?:\.\d+)?)s?$/i.exec(value);
	if (secondsOnly) {
		const seconds = Number(secondsOnly[1]);
		return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
	}

	// 1h2m3s 这类紧凑写法
	const compact = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(value);
	if (compact && (compact[1] || compact[2] || compact[3])) {
		const total = Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0);
		return Number.isFinite(total) && total >= 0 ? total : null;
	}

	// mm:ss / hh:mm:ss
	const parts = value.split(":").map(part => part.trim());
	if (parts.length < 2 || parts.length > 3) return null;
	if (parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return null;
	const numbers = parts.map(part => Number(part));
	if (numbers.some(n => !Number.isFinite(n) || n < 0)) return null;
	return numbers.length === 2
		? numbers[0]! * 60 + numbers[1]!
		: numbers[0]! * 3600 + numbers[1]! * 60 + numbers[2]!;
}

/** 播客跳转时间输入框：输入 12:34 或 754，跳到对应时间点。 */
export class PodcastSeekModal extends UnreaderModal {
	constructor(
		app: App,
		private readonly currentSeconds: number,
		private readonly totalSeconds: number,
		private readonly onSubmit: (seconds: number) => void,
	) {
		super(app);
	}

	onOpen(): void {
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("跳转到时间");
		this.contentEl.empty();

		const hint = Number.isFinite(this.totalSeconds) && this.totalSeconds > 0
			? `输入时间点后跳过去。支持 12:34、1:02:03 或 754（秒）。总时长 ${this.formatTime(this.totalSeconds)}。`
			: "输入时间点后跳过去。支持 12:34、1:02:03 或 754（秒）。";
		this.contentEl.createDiv({ cls: "unreader-tag-desc", text: hint });

		let submitted = false;
		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "text",
			attr: {
				inputmode: "numeric",
				placeholder: "例如：12:34",
				"aria-label": "跳转时间点",
			},
		});
		// 当前进度预填，用户改一改就能跳，省得从零敲
		if (this.currentSeconds > 0) input.value = this.formatTime(this.currentSeconds);

		const submit = (): void => {
			if (submitted) return;
			const seconds = parseSeekInput(input.value);
			if (seconds == null) {
				new Notice("时间格式看不懂，试试 12:34 或 754");
				input.focus();
				input.select();
				return;
			}
			submitted = true;
			this.onSubmit(seconds);
			this.close();
		};

		input.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});

		const buttons = this.contentEl.createDiv({ cls: "unreader-tag-buttons" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "跳转", cls: "mod-cta" }).addEventListener("click", submit);

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 50);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}

	private formatTime(seconds: number): string {
		const total = Math.max(0, Math.floor(seconds));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const secs = total % 60;
		return hours > 0
			? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
			: `${minutes}:${String(secs).padStart(2, "0")}`;
	}
}
