import { App, Modal, Notice, Setting } from "obsidian";
import type UNreaderPlugin from "../main";
import type { DiscoveredFeed } from "../core/feedParser";

export class AddFeedModal extends Modal {
	private busy = false;
	private value = "";

	constructor(app: App, private plugin: UNreaderPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("添加订阅");
		this.contentEl.createEl("p", {
			text: "输入 RSS / Atom / JSON Feed 地址，或输入普通网站地址自动发现订阅源。",
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
		const importButton = footer.createEl("button", { text: "导入 OPML…" });
		importButton.addEventListener("click", () => {
			this.close();
			this.plugin.importOpmlFromFile();
		});
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		const input = this.value.trim();
		if (!input) {
			new Notice("请输入 Feed 或网站地址");
			return;
		}
		this.busy = true;
		const buttons = Array.from(this.contentEl.querySelectorAll("button"));
		for (const button of buttons) (button as HTMLButtonElement).disabled = true;
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
			for (const button of buttons) (button as HTMLButtonElement).disabled = false;
		}
	}
}

export class FeedCandidateModal extends Modal {
	constructor(
		app: App,
		private plugin: UNreaderPlugin,
		private candidates: DiscoveredFeed[],
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("选择订阅源");
		this.contentEl.createEl("p", { text: "这个网站提供了多个 Feed，请选择要添加的一个：" });
		const list = this.contentEl.createDiv({ cls: "unreader-feed-candidate-list" });
		for (const candidate of this.candidates) {
			const button = list.createEl("button", { cls: "unreader-feed-candidate" });
			button.createDiv({ cls: "unreader-feed-candidate-title", text: candidate.title || candidate.url });
			button.createDiv({ cls: "unreader-feed-candidate-url", text: candidate.url });
			button.addEventListener("click", async () => {
				button.disabled = true;
				try {
					await this.plugin.addResolvedFeed(candidate);
					this.close();
				} catch (error) {
					button.disabled = false;
					new Notice(`添加失败：${error instanceof Error ? error.message : String(error)}`);
				}
			});
		}
	}
}

export class RenameFeedModal extends Modal {
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

export class DeleteFeedModal extends Modal {
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

export class ImportOpmlModal extends Modal {
	private file: File | null = null;
	private statusEl!: HTMLElement;
	private busy = false;

	constructor(app: App, private plugin: UNreaderPlugin) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("导入 OPML");
		this.contentEl.createEl("p", { text: "选择 OPML 文件，导入其中的 RSS / Atom / JSON Feed 订阅。" });
		const input = this.contentEl.createEl("input", { type: "file", cls: "unreader-opml-file-input" }) as HTMLInputElement;
		input.accept = ".opml,.xml,text/xml,application/xml";
		input.addEventListener("change", () => {
			this.file = input.files?.[0] ?? null;
			this.statusEl.setText(this.file ? this.file.name : "尚未选择文件");
		});
		this.statusEl = this.contentEl.createDiv({ cls: "unreader-opml-status", text: "尚未选择文件" });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		const submit = buttons.createEl("button", { text: "导入", cls: "mod-cta" });
		submit.addEventListener("click", async () => {
			if (this.busy || !this.file) {
				if (!this.file) new Notice("请先选择 OPML 文件");
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
		});
	}
}
