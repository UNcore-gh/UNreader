import type { App } from "obsidian";
import { getLang, t } from "../core/i18n";
import { releaseNoteForVersion, type ReleaseNoteEntry } from "../core/releaseNotes";
import { UnreaderModal } from "./modalSkin";

/** 可再次打开的版本说明；所有文案来自 `src/release-notes.json`。 */
export class ReleaseNotesModal extends UnreaderModal {
	constructor(
		app: App,
		private readonly versions: readonly string[],
		private readonly currentVersion: string,
		private readonly onDismiss?: () => void,
	) {
		super(app);
		this.modalEl.addClass("unreader-release-notes-modal");
	}

	onOpen(): void {
		const language = getLang();
		const locale = language === "en" ? "en" : "zh";
		this.titleEl.setText(t("releaseNotesTitle"));
		this.contentEl.empty();
		this.contentEl.addClass("unreader-release-notes");
		this.contentEl.createDiv({
			cls: "unreader-release-notes-hint",
			text: locale === "zh"
				? "这些说明会按版本保存；之后可在命令面板搜索「查看更新说明」再次打开。"
				: "Release notes are saved by version. Search “View release notes” in the Command Palette to open them again.",
		});

		let count = 0;
		for (const version of this.versions) {
			const note = releaseNoteForVersion(version);
			if (!note) continue;
			this.renderEntry(version, note, locale, version === this.currentVersion);
			count++;
		}
		if (!count) {
			this.contentEl.createDiv({
				cls: "unreader-release-notes-empty",
				text: locale === "zh" ? "当前版本暂时没有更新说明。" : "No release notes are available for this version yet.",
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss?.();
	}

	private renderEntry(version: string, note: ReleaseNoteEntry, locale: "zh" | "en", current: boolean): void {
		const section = this.contentEl.createDiv({ cls: "unreader-release-note" });
		const header = section.createDiv({ cls: "unreader-release-note-header" });
		header.createEl("h3", { text: note.title[locale] });
		const versionTag = header.createSpan({ cls: "unreader-release-note-version", text: `v${version}` });
		if (current) versionTag.addClass("is-current");
		section.createDiv({ cls: "unreader-release-note-summary", text: note.summary[locale] });
		const items = note.items[locale];
		if (items.length) {
			const list = section.createEl("ul", { cls: "unreader-release-note-items" });
			for (const item of items) list.createEl("li", { text: item });
		}
	}
}
