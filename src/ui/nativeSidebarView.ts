import { ItemView, type WorkspaceLeaf } from "obsidian";
import type UNreaderPlugin from "../main";
import { createSidePanel, toggleFeedStarState, type NativeSidebarContext, type SidePanelMode } from "./sidePanels";
import { isRssFormatEnabled } from "../core/readableFormats";
import { normalizeNativeSidebarMode } from "../core/nativeSidebarState";
import { saveFeedEntryAsMarkdown } from "../core/feedNoteSave";

export const VIEW_TYPE_UNREADER_SIDEBAR = "unreader-sidebar";

/** Obsidian 原生侧栏里的 UNreader 面板。正文阅读页与面板互相独立。 */
export class UNreaderSidebarView extends ItemView {
	private readonly plugin: UNreaderPlugin;
	private panel: ReturnType<typeof createSidePanel> | null = null;
	private panelState = { bookshelfCategoryFilter: "all" as const, feedFilter: "all" as const, feedSourceFilter: null as string | null };
	private context: NativeSidebarContext | null = null;
	private annotationTarget: NativeSidebarContext | null = null;
	private annotationReturnMode: Exclude<SidePanelMode, "annotations"> = "bookshelf";
	private suppressModePersistence = true;

	constructor(leaf: WorkspaceLeaf, plugin: UNreaderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_UNREADER_SIDEBAR; }
	getDisplayText(): string { return "UNreader"; }
	getIcon(): string { return "book-open"; }

	async onOpen(): Promise<void> {
		this.contentEl.addClass("unreader-native-sidebar");
		this.context = this.plugin.getNativeSidebarContext();
		const modes: SidePanelMode[] = isRssFormatEnabled(this.plugin.settings.disabledFormats)
			? ["bookshelf", "feeds", "notes", "annotations"] : ["bookshelf", "notes", "annotations"];
		this.panel = createSidePanel({
			app: this.app,
			plugin: this.plugin,
			modes,
			state: this.panelState,
			getCurrentDocumentName: () => this.panel?.getMode() === "annotations"
				? this.annotationTarget?.title ?? this.context?.title ?? null
				: this.context?.title ?? null,
			getCurrentBookPath: () => this.context?.bookPath ?? null,
			getCurrentFeedEntry: () => this.context?.feedRef ?? null,
			getAnnotationContext: () => this.annotationTarget?.annotation ?? this.context?.annotation ?? null,
			onRequestHome: () => {
				this.annotationTarget = null;
				this.plugin.clearNativeSidebarAnnotationTarget();
				this.panel?.setAnnotationBrowseTarget(null);
				this.panel?.openPickerPage(this.annotationReturnMode);
			},
			onOpenChange: () => this.plugin.syncNativeSidebarToolbarButtons(),
			onModeChange: mode => {
				if (mode === "annotations") {
					this.plugin.syncNativeSidebarToolbarButtons();
					return;
				}
				if (this.suppressModePersistence) return;
				this.plugin.settings.lastSidebarMode = mode;
				this.plugin.settings.lastSidebarModeExplicit = true;
				void this.plugin.persistData();
				this.plugin.syncNativeSidebarToolbarButtons();
			},
			openBook: path => { void this.plugin.openBookFromNativeSidebar(path); },
			openMarkdownNote: path => { void this.plugin.openMarkdownNoteFromNativeSidebar(path); },
			openFeedEntry: (feedId, entryId) => { void this.plugin.openFeedEntryFromNativeSidebar(feedId, entryId); },
			toggleFeedStar: (feedId, entryId, panel) => {
				void toggleFeedStarState(this.plugin, feedId, entryId).then(() => panel.refreshFeeds());
			},
			refreshFeeds: panel => { void this.plugin.refreshAllFeeds().then(() => panel.refreshFeeds()); },
			saveNote: (feedId, entryId, panel) => {
				void saveFeedEntryAsMarkdown({
					app: this.app,
					store: this.plugin.feedStore,
					fetchFulltext: (id, entry) => this.plugin.feedService.fetchFulltext(id, entry),
				}, feedId, entryId).then(result => { if (result) panel.refreshFeeds(); });
			},
			queuePodcastProgress: (feedId, entryId, seconds, duration) => {
				if (!Number.isFinite(seconds) || seconds < 1) return;
				const fraction = duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) : 0;
				this.plugin.checkpointPodcastProgress(feedId, entryId, {
					anchor: `audio:${seconds.toFixed(2)}`,
					fraction,
					updatedAt: Date.now(),
				});
			},
		});
		this.contentEl.appendChild(this.panel.containerEl);
		this.panel.setPinVisible(false);
		this.panel.setPinEnabled(false);
		this.panel.syncAppearance(this.plugin.settings.appearance);
		this.panel.setMode(normalizeNativeSidebarMode(
			this.plugin.settings.lastSidebarMode,
			isRssFormatEnabled(this.plugin.settings.disabledFormats),
		));
		this.panel.show();
		this.suppressModePersistence = false;
		// FeedStore 的首次读盘属于 dataReady 异步链：侧栏可能先按空缓存画出订阅页。
		// 数据到齐后主动重画当前订阅页，避免必须切走再切回来才出现文章。
		const openedPanel = this.panel;
		void this.plugin.whenDataReady().then(() => {
			if (this.panel !== openedPanel) return;
			this.refreshFeeds();
		});
	}

	async onClose(): Promise<void> {
		this.panel?.hide();
		this.panel?.dispose();
		this.panel = null;
		this.contentEl.removeClass("unreader-native-sidebar");
		await super.onClose();
	}

	showMode(mode?: SidePanelMode, persistMode = true): void {
		if (!this.panel) return;
		const wasSuppressing = this.suppressModePersistence;
		if (!persistMode) this.suppressModePersistence = true;
		try {
			if (mode === "annotations" && this.panel.getMode() !== "annotations") {
				const current = this.panel.getMode();
				if (current !== "annotations") this.annotationReturnMode = current;
			}
			if (mode && this.panel.getMode() !== mode) this.panel.setMode(mode);
			this.panel.show();
		} finally {
			this.suppressModePersistence = wasSuppressing;
		}
	}

	setContext(context: NativeSidebarContext | null): void {
		this.context = context;
		if (!this.panel) return;
		if (this.panel.getMode() === "annotations" && this.annotationTarget) this.panel.refreshHeaderTitle();
		else if (this.panel.getMode() === "annotations") this.panel.refreshAnnotations();
		else this.panel.updateContentContext(context?.key ?? null);
	}

	refreshAnnotations(key?: string): void {
		if (key && this.context?.key !== key) return;
		this.panel?.refreshAnnotations();
	}

	setAnnotationLoading(key: string | null, title?: string, error?: string): void { this.panel?.setAnnotationLoading(key, title, error); }

	setAnnotationTarget(target: NativeSidebarContext | null): void {
		this.annotationTarget = target;
		this.panel?.setAnnotationBrowseTarget(target?.annotation.data() ?? null);
	}

	refreshBookshelf(): void {
		if (this.panel?.getMode() === "bookshelf") this.panel.setMode("bookshelf");
	}

	refreshFeeds(): void { this.panel?.refreshFeeds(); }

	refreshNotes(): void {
		if (this.panel?.getMode() === "notes") this.panel.setMode("notes");
	}

	getPanelMode(): SidePanelMode | null { return this.panel?.getMode() ?? null; }
	isPanelOpen(): boolean { return this.panel?.isOpen() ?? false; }
}
