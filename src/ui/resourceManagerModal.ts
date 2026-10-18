import { App } from "obsidian";
import { UnreaderModal } from "./modalSkin";
import type { SharedResource, SharedResourceKind } from "../core/resourceStore";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";
import { t, tf } from "../core/i18n";

export interface ManagedResource extends SharedResource {
	usedBy: number;
}

export interface ResourceManagerCallbacks {
	onToggle: (id: string, enabled: boolean) => Promise<void>;
	onDelete: (resource: ManagedResource) => Promise<void>;
}

export class ResourceManagerModal extends UnreaderModal {
	constructor(
		app: App,
		private kind: SharedResourceKind,
		private resources: ManagedResource[],
		private callbacks: ResourceManagerCallbacks,
	) {
		super(app);
	}

	onOpen(): void {
		markModalKeyboardSafe(this.containerEl);
		this.titleEl.setText(this.kind === "font" ? t("resManagerFontTitle") : t("resManagerImageTitle"));
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: t("resManagerDesc"),
		});
		this.renderList();
	}

	onClose(): void {
		unmarkModalKeyboardSafe(this.containerEl);
		this.contentEl.empty();
	}

	private renderList(): void {
		this.contentEl.querySelector(".unreader-resource-list")?.remove();
		const list = this.contentEl.createDiv({ cls: "unreader-resource-list" });
		if (!this.resources.length) {
			list.createDiv({
				cls: "unreader-bg-empty",
				text: this.kind === "font" ? t("resManagerEmptyFonts") : t("resManagerEmptyImages"),
			});
			return;
		}
		for (const resource of this.resources) {
			const row = list.createDiv({ cls: "unreader-resource-row" });
			if (!resource.enabled) row.addClass("is-disabled");

			const info = row.createDiv({ cls: "unreader-resource-info" });
			info.createDiv({ cls: "unreader-resource-name", text: resource.name });
			info.createDiv({
				cls: "unreader-resource-meta",
				text: `${resource.path}${resource.usedBy ? tf("resManagerReferenceCount", { count: resource.usedBy }) : ""}`,
			});

			const toggleLabel = row.createEl("label", { cls: "unreader-resource-toggle" });
			const toggle = toggleLabel.createEl("input", { type: "checkbox" });
			toggle.checked = resource.enabled;
			toggleLabel.createSpan({ text: resource.enabled ? t("resManagerKeep") : t("resManagerRemoved") });
			toggle.addEventListener("change", () => {
				void (async (): Promise<void> => {
					toggle.disabled = true;
					await this.callbacks.onToggle(resource.id, toggle.checked);
					toggle.disabled = false;
					this.renderList();
				})();
			});

			const del = row.createEl("button", {
				cls: "unreader-appearance-preset-btn",
				text: t("resManagerDelete"),
				attr: { title: t("resManagerDeleteTitle") },
			});
			del.addEventListener("click", () => {
				void (async (): Promise<void> => {
					del.disabled = true;
					await this.callbacks.onDelete(resource);
					this.renderList();
				})();
			});
		}
	}
}
