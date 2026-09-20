import { App } from "obsidian";
import { UnreaderModal } from "./modalSkin";
import type { SharedResource, SharedResourceKind } from "../core/resourceStore";
import { markModalKeyboardSafe, unmarkModalKeyboardSafe } from "./keyboardInset";

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
		this.titleEl.setText(this.kind === "font" ? "字体资源管理" : "图片资源管理");
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "unreader-tag-desc",
			text: "资源存放在库内并随库同步。保留使用 = 所有设备和预设都可使用；移除 = 在所有设备上停用，文件与引用仍保留，重新保留即可恢复；删除文件 = 清理资源本体并清除所有引用。",
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
			list.createDiv({ cls: "unreader-bg-empty", text: this.kind === "font" ? "暂无字体资源" : "暂无图片资源" });
			return;
		}
		for (const resource of this.resources) {
			const row = list.createDiv({ cls: "unreader-resource-row" });
			if (!resource.enabled) row.addClass("is-disabled");

			const info = row.createDiv({ cls: "unreader-resource-info" });
			info.createDiv({ cls: "unreader-resource-name", text: resource.name });
			info.createDiv({
				cls: "unreader-resource-meta",
				text: `${resource.path}${resource.usedBy ? ` · ${resource.usedBy} 处使用` : ""}`,
			});

			const toggleLabel = row.createEl("label", { cls: "unreader-resource-toggle" });
			const toggle = toggleLabel.createEl("input", { type: "checkbox" });
			toggle.checked = resource.enabled;
			toggleLabel.createSpan({ text: resource.enabled ? "保留使用" : "已移除" });
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
				text: "删除文件",
				attr: { title: "删除库内资源文件" },
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
