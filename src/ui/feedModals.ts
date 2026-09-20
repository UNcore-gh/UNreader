import { App, Notice, Setting, setIcon } from "obsidian";
import { UnreaderModal } from "./modalSkin";
import type UNreaderPlugin from "../main";
import type { DiscoveredFeed } from "../core/feedParser";
import type { FeedSubscription } from "../types";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";

export class AddFeedModal extends UnreaderModal {
	private busy = false;
	private value = "";

	constructor(app: App, private plugin: UNreaderPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("添加订阅");
		this.contentEl.createEl("p", {
			text: "输入订阅源地址，或输入普通网站地址自动发现订阅源。",
		});
		const setting = new Setting(this.contentEl)
			.setName("Feed 或网站地址")
			.addText(input => {
				input.setPlaceholder("https://example.com/feed.xml");
				input.onChange(value => { this.value = value; });
				input.inputEl.addEventListener("keydown", event => {
					if (event.key === "Enter") void this.submit();
				});
				window.setTimeout(() => input.inputEl.focus(), 30);
			});
		setting.addButton(button => button.setButtonText("添加").setCta().onClick(() => void this.submit()));
		const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
		const importButton = footer.createEl("button", { text: "导入 .opml…" });
		importButton.addEventListener("click", () => {
			this.close();
			this.plugin.importOpmlFromFile();
		});
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		const input = this.value.trim();
		if (!input) {
			new Notice("请输入订阅源或网站地址");
			return;
		}
		this.busy = true;
		const buttons = Array.from(this.contentEl.querySelectorAll("button"));
		for (const button of buttons) (button).disabled = true;
		try {
			const resolution = await this.plugin.feedService.resolveInput(input);
			if (resolution.feed && resolution.feedUrl) {
				await this.plugin.addResolvedFeed({
					title: resolution.feed.title,
					url: resolution.feedUrl,
					type: "application/feed+json",
				});
				this.close();
				return;
			}
			if (resolution.discovered.length > 1) {
				new FeedCandidateModal(this.app, this.plugin, resolution.discovered).open();
				this.close();
				return;
			}
			throw new Error("没有找到可用的订阅源");
		} catch (error) {
			new Notice(`添加失败：${error instanceof Error ? error.message : String(error)}`);
			this.busy = false;
			for (const button of buttons) (button).disabled = false;
		}
	}
}

export class FeedCandidateModal extends UnreaderModal {
	constructor(
		app: App,
		private plugin: UNreaderPlugin,
		private candidates: DiscoveredFeed[],
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("选择订阅源");
		this.contentEl.createEl("p", { text: "这个网站提供了多个订阅源，请选择要添加的一个：" });
		const list = this.contentEl.createDiv({ cls: "unreader-feed-candidate-list" });
		for (const candidate of this.candidates) {
			const button = list.createEl("button", { cls: "unreader-feed-candidate" });
			button.createDiv({ cls: "unreader-feed-candidate-title", text: candidate.title || candidate.url });
			button.createDiv({ cls: "unreader-feed-candidate-url", text: candidate.url });
			button.addEventListener("click", () => {
				void (async (): Promise<void> => {
					button.disabled = true;
					try {
						await this.plugin.addResolvedFeed(candidate);
						this.close();
					} catch (error) {
						button.disabled = false;
						new Notice(`添加失败：${error instanceof Error ? error.message : String(error)}`);
					}
				})();
			});
		}
	}
}

export class RenameFeedModal extends UnreaderModal {
	private value: string;

	constructor(app: App, title: string, private onRename: (value: string) => void) {
		super(app);
		this.value = title;
	}

	onOpen(): void {
		this.titleEl.setText("重命名订阅");
		new Setting(this.contentEl)
			.setName("显示名称")
			.addText(input => {
				input.setValue(this.value);
				input.onChange(value => { this.value = value; });
				window.setTimeout(() => { input.inputEl.focus(); input.inputEl.select(); }, 30);
			});
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "保存", cls: "mod-cta" }).addEventListener("click", () => {
			const value = this.value.trim();
			if (!value) return;
			this.onRename(value);
			this.close();
		});
	}
}

export class DeleteFeedModal extends UnreaderModal {
	constructor(app: App, title: string, private onConfirm: () => void) {
		super(app);
		this.titleEl.setText("删除订阅");
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: "删除订阅会移除本地订阅索引和文章快照；已保存的旁车笔记会保留。此操作不可撤销。" });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		buttons.createEl("button", { text: "删除", cls: "mod-warning" }).addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}
}

export class ImportOpmlModal extends UnreaderModal {
	private file: File | null = null;
	private statusEl!: HTMLElement;
	private busy = false;

	constructor(app: App, private plugin: UNreaderPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("导入 .opml 文件");
		this.contentEl.createEl("p", { text: "选择 .opml 文件，导入其中的订阅源。" });
		const input = this.contentEl.createEl("input", { type: "file", cls: "unreader-opml-file-input" });
		input.accept = ".opml,.xml,text/xml,application/xml";
		input.addEventListener("change", () => {
			this.file = input.files?.[0] ?? null;
			this.statusEl.setText(this.file ? this.file.name : "尚未选择文件");
		});
		this.statusEl = this.contentEl.createDiv({ cls: "unreader-opml-status", text: "尚未选择文件" });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		const submit = buttons.createEl("button", { text: "导入", cls: "mod-cta" });
		submit.addEventListener("click", () => {
			void (async (): Promise<void> => {
				if (this.busy || !this.file) {
					if (!this.file) new Notice("请先选择 .opml 文件");
					return;
				}
				this.busy = true;
				submit.disabled = true;
					this.statusEl.setText("正在导入并刷新订阅…");
					try {
						await this.plugin.whenDataReady();
						const result = await this.plugin.feedService.importOpml(await this.file.text());
					new Notice(`已导入 ${result.imported} 个订阅，刷新成功 ${result.refreshed} 个${result.failed ? `，失败 ${result.failed} 个` : ""}`);
					this.close();
				} catch (error) {
					this.busy = false;
					submit.disabled = false;
					this.statusEl.setText(`导入失败：${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		});
	}
}

/**
 * 订阅管理面板（订阅侧栏工具栏「设置」按钮的落点）。
 *
 * 侧栏工具栏上只留「订阅源选择 / 刷新 / 设置」三枚控件：新建、导入导出、逐条
 * 停用与删除这些低频操作全收进这里，列表本身只做一件事 —— 管好每一条订阅。
 * 面板复用官方 Setting 行的排版（标题 + 地址 + 一行控件），深浅色主题自动跟随。
 */
export class FeedManagerModal extends UnreaderModal {
	constructor(app: App, private plugin: UNreaderPlugin) {
		super(app);
	}

	onOpen(): void {
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText("订阅管理");
		this.render();
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const feeds = this.plugin.feedStore.listFeeds();

		const bar = contentEl.createDiv({ cls: "unreader-feed-manager-bar" });
		const barAction = (label: string, icon: string, onClick: () => void, cta = false): void => {
			const button = bar.createEl("button", cta ? { cls: "mod-cta" } : {});
			const iconEl = button.createSpan({ cls: "unreader-feed-manager-bar-icon" });
			try { setIcon(iconEl, icon); } catch { iconEl.remove(); }
			button.createSpan({ text: label });
			button.addEventListener("click", () => onClick());
		};
		barAction("新建订阅", "plus", () => {
			this.close();
			this.plugin.promptAddFeed();
		}, true);
		barAction("导入 .opml", "file-up", () => {
			this.close();
			this.plugin.importOpmlFromFile();
		});
		barAction("导出 .opml", "file-down", () => void this.plugin.exportOpmlToVault());

		if (!feeds.length) {
			contentEl.createDiv({
				cls: "unreader-feed-manager-empty",
				text: "还没有订阅。点「新建订阅」填一个 Feed 或网站地址即可开始。",
			});
			return;
		}

		const list = contentEl.createDiv({ cls: "unreader-feed-manager-list" });
		for (const feed of feeds) this.renderRow(list, feed);
		contentEl.createDiv({
			cls: "unreader-feed-manager-hint",
			text: "停用的订阅不再刷新，已缓存的文章仍可阅读。",
		});
	}

	private renderRow(list: HTMLElement, feed: FeedSubscription): void {
		const enabled = feed.enabled !== false;
		const row = new Setting(list)
			.setName(feed.title)
			.setDesc(feed.feedUrl)
			.addToggle(toggle => toggle
				.setTooltip(enabled ? "停用该订阅" : "启用该订阅")
				.setValue(enabled)
				.onChange(value => void this.toggleFeed(feed.id, value)))
			.addExtraButton(button => button
				.setIcon("refresh-cw")
				.setTooltip("刷新该订阅")
				.onClick(() => void this.plugin.refreshFeed(feed.id)))
			.addExtraButton(button => button
				.setIcon("pencil")
				.setTooltip("重命名")
				.onClick(() => this.plugin.renameFeed(feed.id, feed.title, () => this.rerender())))
			.addExtraButton(button => button
				.setIcon("trash-2")
				.setTooltip("删除订阅")
				.onClick(() => void this.plugin.deleteFeed(feed.id, () => this.rerender())));
		row.settingEl.addClass("unreader-feed-manager-row");
		if (!enabled) row.settingEl.addClass("is-disabled");
		if (feed.lastError) {
			row.descEl.createDiv({ cls: "unreader-feed-manager-error", text: `上次刷新失败：${feed.lastError}` });
		}
	}

	private async toggleFeed(feedId: string, enabled: boolean): Promise<void> {
		await this.plugin.setFeedEnabled(feedId, enabled);
		this.rerender();
	}

	/** 重命名 / 删除由另一个弹窗完成后回调到这里：条目可能已经不在了，整表重画。 */
	private rerender(): void {
		if (!this.containerEl.isConnected) return;
		this.render();
	}
}
