import { App } from "obsidian";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { UnreaderModal } from "./modalSkin";

/** 字体来源：库内文件（path 用于判断是否已在字体夹内）或系统文件选择器。 */
export interface FontPick {
	/** 展示名（不含扩展名） */
	name: string;
	/** 扩展名（小写） */
	ext: string;
	/** 库内选中时的完整路径；系统选择器来源没有 */
	path?: string;
	/** 次要说明（库内选中时显示所在文件夹，用于区分同名文件） */
	desc?: string;
	/** 字节数（有则用于**读取前**拒绝超大字体，避免几十 MB 先整份读进内存再报错） */
	size?: number;
	/** 读取原始字节 */
	read: () => Promise<ArrayBuffer>;
}

/** 从库中选择字体文件导入。
 *
 *  结构与 backgroundImageModal 同构（同一套 .unreader-bg-* 样式与搜索交互），
 *  **故意不抽公共件**：图片选择器在 test/ 下零覆盖，为了少 79 行去重构它只有风险
 *  没有收益。两者的差异只在文案与「字体要显示所在文件夹」这一点。 */
export class FontPickModal extends UnreaderModal {
	constructor(
		app: App,
		private picks: FontPick[],
		private onSubmit: (pick: FontPick) => void,
	) {
		super(app);
	}

	onOpen(): void {
		// 移动端：键盘弹起时整个弹窗上移到键盘之上（见 keyboardInset 与 styles.css 的 .unreader-kb-safe）
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("选择字体文件");
		this.contentEl.empty();

		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: "从库中选择一个字体文件（ttf / otf / woff / woff2）。选中的文件会复制到插件的字体文件夹，之后所有设备都能用。",
		});

		let submitted = false;
		const submit = (pick: FontPick): void => {
			if (submitted) return;
			submitted = true;
			this.onSubmit(pick);
			this.close();
		};

		const input = this.contentEl.createEl("input", {
			cls: "unreader-tag-input",
			type: "text",
			attr: { placeholder: "搜索字体文件名…" },
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
				if (p.desc) row.createSpan({ cls: "unreader-bg-row-ext", text: p.desc });
				row.createSpan({ cls: "unreader-bg-row-ext", text: p.ext.toUpperCase() });
				row.addEventListener("click", () => submit(p));
			}
			if (!shown) listEl.createDiv({ cls: "unreader-bg-empty", text: "没有匹配的字体" });
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
