import { App, Notice, Setting, setIcon } from "obsidian";
import { UnreaderModal } from "./modalSkin";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { confirmAction } from "./confirmModal";
import { getBookshelfEntries, getRemovedBookshelfEntries } from "../core/bookService";
import type UNreaderPlugin from "../main";
import type { BookshelfCategory } from "../types";

/** 分类名输入弹窗：新建和重命名共用一套键盘行为与按钮层级。 */
export class BookshelfCategoryNameModal extends UnreaderModal {
	private value: string;

	constructor(
		app: App,
		private title: string,
		private submitLabel: string,
		initialValue: string,
		private onSubmit: (value: string) => void,
	) {
		super(app);
		this.value = initialValue;
	}

	onOpen(): void {
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText(this.title);
		new Setting(this.contentEl)
			.setName("分类名称")
			.addText(input => {
				input.setPlaceholder("例如：小说 / 技术 / 待读");
				input.setValue(this.value);
				input.onChange(value => { this.value = value; });
				input.inputEl.addEventListener("keydown", event => {
					if (event.key === "Enter") {
						event.preventDefault();
						this.submit();
					}
				});
				window.setTimeout(() => { input.inputEl.focus(); input.inputEl.select(); }, 30);
			});
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: this.submitLabel, cls: "mod-cta" })
			.addEventListener("click", () => this.submit());
	}

	private submit(): void {
		const value = this.value.trim();
		if (!value) {
			new Notice("请输入分类名称");
			return;
		}
		this.close();
		this.onSubmit(value);
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}
}

/** 书籍分类管理面板。视觉和操作结构对齐 RSS 的订阅管理面板。 */
export class BookshelfCategoryManagerModal extends UnreaderModal {
	constructor(app: App, private plugin: UNreaderPlugin) {
		super(app);
	}

	onOpen(): void {
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("分类管理");
		this.render();
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const categories = this.plugin.settings.bookshelfCategories ?? [];
		const entries = getBookshelfEntries(this.plugin);
		const counts = new Map<string, number>();
		let uncategorized = 0;
		for (const entry of entries) {
			if (!entry.categoryId) uncategorized++;
			else counts.set(entry.categoryId, (counts.get(entry.categoryId) ?? 0) + 1);
		}

		const bar = contentEl.createDiv({ cls: "unreader-feed-manager-bar" });
		const barAction = (label: string, icon: string, onClick: () => void, cta = false): void => {
			const button = bar.createEl("button", cta ? { cls: "mod-cta" } : {});
			const iconEl = button.createSpan({ cls: "unreader-feed-manager-bar-icon" });
			try { setIcon(iconEl, icon); } catch { iconEl.remove(); }
			button.createSpan({ text: label });
			button.addEventListener("click", () => onClick());
		};
		barAction("新建分类", "plus", () => {
			new BookshelfCategoryNameModal(this.app, "新建分类", "创建", "", value => {
				void this.plugin.createBookshelfCategory(value).then(() => this.rerender());
			}).open();
		}, true);
		barAction("已移除书籍", "archive-restore", () => {
			new RemovedBooksModal(this.app, this.plugin, () => this.rerender()).open();
		});

		const list = contentEl.createDiv({ cls: "unreader-feed-manager-list" });
		new Setting(list)
			.setName("未分类")
			.setDesc(`${uncategorized} 本`)
			.setClass("unreader-feed-manager-row");
		for (const category of categories) {
			this.renderCategoryRow(list, category, counts.get(category.id) ?? 0);
		}

		contentEl.createDiv({
			cls: "unreader-feed-manager-hint",
			text: "删除分类不会删除书；原来在里面的书会回到「未分类」。",
		});
	}

	private renderCategoryRow(list: HTMLElement, category: BookshelfCategory, count: number): void {
		new Setting(list)
			.setName(category.name)
			.setDesc(`${count} 本`)
			.addExtraButton(button => button
				.setIcon("pencil")
				.setTooltip("重命名分类")
				.onClick(() => {
					new BookshelfCategoryNameModal(this.app, "重命名分类", "保存", category.name, value => {
						void this.plugin.renameBookshelfCategory(category.id, value).then(() => this.rerender());
					}).open();
				}))
			.addExtraButton(button => button
				.setIcon("trash-2")
				.setTooltip("删除分类")
				.onClick(() => {
					void confirmAction(this.app, {
						title: "删除分类",
						body: `要删除「${category.name}」吗？这个分类里的书不会被删除，会回到「未分类」。`,
						cta: "删除分类",
						destructive: true,
					}).then(confirmed => {
						if (!confirmed) return;
						void this.plugin.deleteBookshelfCategory(category.id).then(() => this.rerender());
					});
				}))
			.setClass("unreader-feed-manager-row");
	}

	private rerender(): void {
		if (!this.containerEl.isConnected) return;
		this.render();
	}
}

/** 手动移除书籍的找回入口；这里添加回书架不会移动或改写书籍文件。 */
export class RemovedBooksModal extends UnreaderModal {
	constructor(
		app: App,
		private plugin: UNreaderPlugin,
		private onChanged?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("已移除书籍");
		this.render();
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const entries = getRemovedBookshelfEntries(this.plugin);
		if (!entries.length) {
			contentEl.createDiv({
				cls: "unreader-feed-manager-empty",
				text: "没有已移除的书籍。从书架移除的书会出现在这里，随时可以添加回来。",
			});
			return;
		}

		const list = contentEl.createDiv({ cls: "unreader-feed-manager-list" });
		for (const entry of entries) {
			new Setting(list)
				.setName(entry.name)
				.setDesc(entry.path)
				.addButton(button => button
					.setButtonText("添加回书架")
					.onClick(() => {
						void this.plugin.restoreBookToBookshelf(entry.path).then(() => this.rerender());
					}))
				.setClass("unreader-feed-manager-row");
		}
		contentEl.createDiv({
			cls: "unreader-feed-manager-hint",
			text: "添加回书架只恢复列表显示；书籍文件、阅读进度和标注一直保留。",
		});
	}

	private rerender(): void {
		if (!this.containerEl.isConnected) return;
		this.render();
	}
}
