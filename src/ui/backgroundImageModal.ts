import { App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { UnreaderModal } from "./modalSkin";

/** 统一的图片来源：库内文件或系统文件选择器，由宿主负责读取。 */
export interface BackgroundImagePick {
	/** 展示名（不含扩展名） */
	name: string;
	/** 扩展名（小写，决定 MIME） */
	ext: string;
	/** 读取原始字节 */
	read: () => Promise<ArrayBuffer>;
	/** 已是共享资源时直接复用引用，避免再次复制 */
	ref?: string;
}

/** 选择背景图片（库内文件列表，逐张即时生效；系统文件选择器由面板行「系统」按钮承担）。 */
export class BackgroundImageModal extends UnreaderModal {
	constructor(
		app: App,
		private picks: BackgroundImagePick[],
		private onSubmit: (pick: BackgroundImagePick) => void,
	) {
		super(app);
	}

	onOpen(): void {
		// 移动端：键盘弹起时整个弹窗上移到键盘之上（见 keyboardInset 与 styles.css 的 .unreader-kb-safe）
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("选择背景图片");
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: "从库中选择一张图片作为阅读背景（2MB 以内）。",
		});

		let submitted = false;
		const submit = (pick: BackgroundImagePick): void => {
			if (submitted) return;
			submitted = true;
			this.onSubmit(pick);
			this.close();
		};

		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "text",
			attr: { placeholder: "搜索图片文件名…" },
		});

		const listEl = this.contentEl.createDiv({ cls: "unreader-bg-list" });

		const render = (query: string): void => {
			listEl.empty();
			const q = query.trim().toLowerCase();
			let shown = 0;
			for (const p of this.picks) {
				if (q && !p.name.toLowerCase().includes(q)) continue;
				shown++;
				const row = listEl.createDiv({ cls: "unreader-bg-row" });
				row.createSpan({ cls: "unreader-bg-row-name", text: p.name });
				row.createSpan({ cls: "unreader-bg-row-ext", text: p.ext.toUpperCase() });
				row.addEventListener("click", () => submit(p));
			}
			if (!shown) listEl.createDiv({ cls: "unreader-bg-empty", text: "没有匹配的图片" });
		};
		render("");

		input.addEventListener("input", () => render(input.value));

		const btnRow = this.contentEl.createDiv({ cls: "unreader-tag-buttons" });
		btnRow.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());

		window.setTimeout(() => input.focus(), 50);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}
}
