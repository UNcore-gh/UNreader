import { PluginSettingTab, App, Setting, Notice, Platform, FuzzySuggestModal, TFolder, Modal } from "obsidian";
import type UNreaderPlugin from "./main";
import * as debugLog from "./core/debugLog";
import { saveDebugReportToVault } from "./core/debugReport";
import qqChannelQr from "./assets/qq-channel-qr.jpg";
import { DATA_DIR_NAME, DEFAULT_ROOT, UNREADER_ROOT, dataRootOf, normalizeDataFolder } from "./core/paths";
import type { SharedResourceKind } from "./core/resourceStore";
import type { LibraryMigrationPlan } from "./core/libraryMigration";

/** 反馈渠道（与 UNmemos 同一套联系方式） */
const FEEDBACK_EMAIL = "2414942469@qq.com";
const QQ_CHANNEL_URL = "https://pd.qq.com/s/9etkz9gqz?b=5";
const BILIBILI_URL = "https://space.bilibili.com/1640219370";

/** 在系统默认浏览器打开 URL：桌面端走 Electron shell.openExternal，
 *  避免 window.open 被 Obsidian WebView 拦成空白新窗口 */
function openExternalLink(url: string): void {
	if (Platform.isDesktopApp) {
		try {
			const { shell } = require("electron") as { shell: { openExternal: (url: string) => Promise<void> } };
			void shell.openExternal(url);
			return;
		} catch { /* Electron 不可用时回退 */ }
	}
	window.open(url, "_blank");
}

export class UNreaderSettingTab extends PluginSettingTab {
	private plugin: UNreaderPlugin;

	constructor(app: App, plugin: UNreaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("unreader-settings");

		// 说明：所有阅读外观（字体/排版/主题/颜色/背景图/玻璃/预设……）
		// 均可在阅读界面右上角的「阅读外观」面板中实时调节，不再在设置页重复。
		// 设置页只保留阅读界面无法调整的全局项；沉浸模式（功能轨按钮）与
		// 标注钉住（标注面板钉住按钮）同理，只在书页内设置。

		new Setting(containerEl).setName("数据").setHeading();

		const dataLabel = this.dataFolderLabel();
		const dataSetting = new Setting(containerEl)
			.setName("数据文件夹")
			.setDesc(`你选择的是外层资料文件夹。插件会固定在其中创建 ${DEFAULT_ROOT}/${DATA_DIR_NAME}/，把阅读进度 / 外观预设 / 字体 / 共享资源 / 标注笔记 / 订阅数据都收进这个数据目录（外层目录里不会散落任何插件文件）。切换位置时会把这几类文件整体迁过去；书籍不搬，一律留在原来的文件夹 —— 书放在库内任何位置都能打开，所以进度、书架顺序、笔记链接都不受影响。当前：${dataLabel}`);
		dataSetting.addText(input => {
			input.setValue(dataLabel);
			input.inputEl.readOnly = true;
			input.inputEl.addClass("unreader-materials-folder-input");
		});
		dataSetting.addButton(button =>
			button.setButtonText("选择文件夹").onClick(() => {
				new DataFolderModal(this.app, path => {
					void this.chooseDataFolder(path);
				}).open();
			}),
		);
		if (this.plugin.settings.dataFolder) {
			dataSetting.addButton(button =>
				button.setButtonText("使用默认位置").onClick(() => void this.chooseDataFolder(null)),
			);
		}

		new Setting(containerEl).setName("阅读").setHeading();

		new Setting(containerEl)
			.setName("钉住可用最小宽度")
			.setDesc("当阅读区宽度小于此阈值时，钉住按钮自动隐藏并退回悬浮模式，避免内容过窄。范围 400-1200px，便捷默认值 720px。")
			.addSlider(sl =>
				sl
					.setLimits(400, 1200, 10)
					.setValue(this.plugin.settings.pinThreshold)
					.setDynamicTooltip()
					.onChange(v => {
						this.plugin.settings.pinThreshold = v;
						this.plugin.scheduleSave();
					}),
			)
			.addButton(btn =>
				btn.setIcon("rotate-ccw").setTooltip("恢复默认 720").onClick(() => {
					this.plugin.settings.pinThreshold = 720;
					void this.plugin.persistData();
					this.display();
				}),
			);

		new Setting(containerEl).setName("订阅").setHeading();
		new Setting(containerEl)
			.setName("打开订阅板块时自动刷新")
			.setDesc("只在用户首次打开订阅侧边栏时触发一次受控刷新；插件启动、布局恢复和后台标签不会发起网络请求。")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.feeds.refreshOnOpen)
				.onChange(value => {
					this.plugin.settings.feeds.refreshOnOpen = value;
					void this.plugin.persistData();
				}));
		new Setting(containerEl)
			.setName("打开文章即标记已读")
			.setDesc("打开文章或播客详情时写入已读时间；关闭后仍可通过文章卡片手动管理。")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.feeds.markReadOnOpen)
				.onChange(value => {
					this.plugin.settings.feeds.markReadOnOpen = value;
					void this.plugin.persistData();
				}));
		new Setting(containerEl)
			.setName("加载远程图片")
			.setDesc("关闭后文章正文中的远程图片会被移除，适合移动网络或隐私敏感场景。")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.feeds.loadRemoteImages)
				.onChange(value => {
					this.plugin.settings.feeds.loadRemoteImages = value;
					void this.plugin.persistData();
				}));
		new Setting(containerEl)
			.setName("每个订阅保留文章数")
			.setDesc("刷新后按发布时间保留最新文章；历史文章和标注保留在缓存范围内。")
			.addSlider(slider => slider
				.setLimits(20, 1000, 20)
				.setValue(this.plugin.settings.feeds.entryLimit)
				.setDynamicTooltip()
				.onChange(value => {
					this.plugin.settings.feeds.entryLimit = value;
					void this.plugin.persistData();
				}));
		new Setting(containerEl)
			.setName("图片缓存上限")
			.setDesc("文章图片保存在本机 IndexedDB，不随库同步。单位 MB，0 表示不落盘缓存。")
			.addSlider(slider => slider
				.setLimits(0, 1024, 25)
				.setValue(this.plugin.settings.feeds.imageCacheMb)
				.setDynamicTooltip()
				.onChange(value => {
					this.plugin.settings.feeds.imageCacheMb = value;
					void this.plugin.persistData();
				}));
		new Setting(containerEl)
			.setName("播客缓存上限")
			.setDesc("播客默认流式播放，只有显式下载才写入本机缓存。单位 MB。")
			.addSlider(slider => slider
				.setLimits(0, 4096, 100)
				.setValue(this.plugin.settings.feeds.mediaCacheMb)
				.setDynamicTooltip()
				.onChange(value => {
					this.plugin.settings.feeds.mediaCacheMb = value;
					void this.plugin.persistData();
				}))
			.addButton(button => button.setButtonText("清空媒体缓存").setWarning().onClick(async () => {
				await this.plugin.feedMediaStore.clear();
				new Notice("RSS 图片和播客缓存已清空");
			}));

		// 资源管理只属于设置层：外观面板负责选择“用哪一项”，这里负责保留、移除
		// 与删除资源本体。两者共用 ResourceStore，但不再让外观面板承担管理职责。
		new Setting(containerEl).setName("资源管理").setHeading();

		this.addResourceRow("font", "字体资源", "库内字体文件；可选择保留使用，或在所有设备上停用（不删除文件）。");
		this.addResourceRow("image", "图片资源", "库内共享背景图；可选择保留使用，或在所有设备上停用（不删除文件）。");

		// ── 库内文件 ──
		// 这一栏与撤下的「资料库」栏的区别值得写清楚：**它不改任何落点**，只往官方的
		// 「排除文件」里登记几条（见 core/exclusions.ts）—— 因此没有迁移面、没有失败面，
		// 用户随时能在 设置 → 文件与链接 → 排除文件 里看见并撤回。
		// 「目录被改名/挪走」不在这里处理：那是目录自愈（core/libraryFolders.ts）的事，
		// 因为那件事本来就不该由用户配置。
		new Setting(containerEl).setName("库内文件").setHeading();

		new Setting(containerEl)
			.setName("标注笔记不参与搜索")
			.setDesc(`把插件数据目录登记进 Obsidian 的「排除文件」。开启（默认）：整个 ${DEFAULT_ROOT}/${DATA_DIR_NAME}/ 登记为一条，高亮 / 书签旁车笔记不再出现在搜索、关系图谱与快速切换里（笔记文件与高亮功能本身不受影响），代价是搜不到高亮原文。关闭：改为逐个子目录登记并放过 Notes —— 笔记可以被搜索到。书籍从不登记。`)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.excludeNotesFromSearch !== false)
					.onChange(v => {
						this.plugin.settings.excludeNotesFromSearch = v;
						void this.plugin.persistData();
						void this.plugin.syncExclusions();
					}),
			);

		// ── 诊断：可选的内存调试日志，导出后发给开发者排查 ──
		new Setting(containerEl).setName("诊断").setHeading();

		new Setting(containerEl)
			.setName("调试日志")
			.setDesc("插件异常需要排查时开启：捕获插件报错与关键事件到内存（关闭时零捕获零存储，重启即清空）。开启后复现问题，再导出发给开发者。")
			.addToggle(toggle =>
				toggle
					.setValue(!!this.plugin.settings.debugLog)
					.onChange(v => {
						this.plugin.settings.debugLog = v;
						void this.plugin.persistData();
						this.display();
					}),
			);

		const exportRow = new Setting(containerEl)
			.setName("导出日志")
			.setDesc(`当前已记录 ${debugLog.entryCount()} 条。复制到剪贴板或保存为库内文件后发给开发者。`);
		exportRow.addButton(btn =>
			btn.setButtonText("复制日志").onClick(async () => {
				if (debugLog.entryCount() === 0) {
					new Notice("暂无日志");
					return;
				}
				try {
					await navigator.clipboard.writeText(debugLog.buildReport());
					new Notice("日志已复制到剪贴板");
				} catch {
					new Notice("复制失败");
				}
			}),
		);
		exportRow.addButton(btn =>
			btn.setButtonText("保存到库").onClick(async () => {
				if (debugLog.entryCount() === 0) {
					new Notice("暂无日志");
					return;
				}
				try {
					const path = await this.saveReportToVault();
					new Notice(`日志已保存到 ${path}`);
				} catch {
					new Notice("保存失败");
				}
			}),
		);
		exportRow.addButton(btn =>
			btn.setButtonText("清空").onClick(() => {
				debugLog.clear();
				this.display();
			}),
		);

		// ── 反馈渠道：与 UNmemos 同一套联系方式 ──
		new Setting(containerEl).setName("反馈渠道").setHeading();

		containerEl.createEl("p", {
			text: "遇到问题、想提建议或参与内测，欢迎通过以下渠道联系我们。",
			cls: "setting-item-description",
		});

		const feedback = containerEl.createDiv("unreader-feedback");

		const qqItem = feedback.createDiv("unreader-feedback-item");
		qqItem.createEl("img", {
			cls: "unreader-feedback-qr",
			attr: { src: qqChannelQr, alt: "QQ 频道二维码" },
		});
		const qqBody = qqItem.createDiv("unreader-feedback-body");
		qqBody.createDiv({ text: "QQ 频道", cls: "unreader-feedback-title" });
		qqBody.createDiv({ text: "用手机 QQ 扫码，或点下方链接加入官方频道。", cls: "unreader-feedback-desc" });
		const qqBtn = qqBody.createEl("a", {
			text: "打开加入链接",
			cls: "unreader-feedback-link",
			attr: { href: QQ_CHANNEL_URL, rel: "noopener", target: "_blank" },
		});
		qqBtn.addEventListener("click", e => {
			e.preventDefault();
			openExternalLink(QQ_CHANNEL_URL);
		});

		const mail = feedback.createDiv("unreader-feedback-row");
		mail.createDiv({ text: "QQ 邮箱", cls: "unreader-feedback-label" });
		const mailLink = mail.createEl("a", {
			text: FEEDBACK_EMAIL,
			cls: "unreader-feedback-link",
			attr: { href: `mailto:${FEEDBACK_EMAIL}` },
		});
		mailLink.addEventListener("click", e => {
			e.preventDefault();
			openExternalLink(`mailto:${FEEDBACK_EMAIL}`);
		});

		const bili = feedback.createDiv("unreader-feedback-row");
		bili.createDiv({ text: "B站主页", cls: "unreader-feedback-label" });
		const biliLink = bili.createEl("a", {
			text: "space.bilibili.com/1640219370",
			cls: "unreader-feedback-link",
			attr: { href: BILIBILI_URL, rel: "noopener", target: "_blank" },
		});
		biliLink.addEventListener("click", e => {
			e.preventDefault();
			openExternalLink(BILIBILI_URL);
		});
	}

	/** 设置页显示数据落点：把用户选中的外层目录和实际数据根同时写出来。 */
	private dataFolderLabel(): string {
		const selected = normalizeDataFolder(this.plugin.settings.dataFolder);
		const data = `${dataRootOf(selected)}/${DATA_DIR_NAME}`;
		return selected ? `${selected} → ${data}` : `默认位置（${data}）`;
	}

	/** 切换数据落点：预检 → 确认 → 迁移 → 重建存储。书一律不搬。 */
	private async chooseDataFolder(nextValue: string | null): Promise<void> {
		const current = normalizeDataFolder(this.plugin.settings.dataFolder);
		const next = normalizeDataFolder(nextValue);
		if (current === next) return;
		// 等首次读盘完成：迁移前要先 flush 去抖写入，而 flush 依赖存储已 init
		await this.plugin.whenDataReady();
		const plan = this.plugin.planDataFolder(next);
		if (plan.collisions.length) {
			const example = plan.collisions[0];
			new Notice(`未迁移：目标位置已有 ${plan.collisions.length} 个同名文件（如「${example}」），请先处理冲突`);
			return;
		}
		// 没有可搬的文件（新库 / 已经手工搬过）：直接切落点，不弹确认框
		if (!plan.moves.length) {
			const result = await this.plugin.applyDataFolder(next, { migrate: false });
			this.display();
			new Notice(result.ok
				? `数据文件夹已设为「${dataRootOf(next)}/${DATA_DIR_NAME}」；没有需要迁移的数据文件`
				: result.error ?? "切换失败");
			return;
		}

		const switchOnly = async (): Promise<void> => {
			const result = await this.plugin.applyDataFolder(next, { migrate: false });
			this.display();
			new Notice(result.ok
				? `数据文件夹已设为「${dataRootOf(next)}/${DATA_DIR_NAME}」，但这 ${plan.moves.length} 个数据文件仍留在「${plan.from}」，插件不会再去读它们 —— 请自行移动，或改用「迁移并切换」`
				: result.error ?? "切换失败");
		};

		new DataFolderMigrationModal(
			this.app,
			plan,
			async () => {
				const result = await this.plugin.applyDataFolder(next, { migrate: true });
				if (!result.ok) {
					new Notice(result.error ?? "迁移失败");
					return false;
				}
				this.display();
				new Notice(`已迁移 ${result.moved} 个数据文件到「${dataRootOf(next)}/${DATA_DIR_NAME}」；书籍与书架顺序未动`);
				return true;
			},
			switchOnly,
		).open();
	}

	/** 设置层的资源入口；实际启用/移除/删除逻辑统一在插件层执行。 */
	private addResourceRow(kind: SharedResourceKind, label: string, description: string): void {
		const count = this.plugin.resourceStore?.list(kind).length ?? 0;
		new Setting(this.containerEl)
			.setName(label)
			.setDesc(`${description} 当前 ${count} 项。`)
			.addButton(button =>
				button.setButtonText("管理").onClick(() => {
					void this.plugin.openResourceManager(kind, () => this.display());
				}),
			);
	}

	/** 把日志报告写到库根目录 `unreader-debug-log-<时间戳>.txt`（重名自动加序号）。
	 *  实现收敛在 `core/debugReport.ts` —— 命令「导出诊断日志」共用同一份，避免
	 *  两处各写一份后漂移（漂移的后果是「报告写到别处 / 覆盖上一份」，恰好发生在
	 *  最需要证据的时候）。 */
	private saveReportToVault(): Promise<string> {
		return saveDebugReportToVault(this.app);
	}
}

class DataFolderMigrationModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private plan: LibraryMigrationPlan,
		private onConfirm: () => Promise<boolean>,
		private onSwitchOnly: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("迁移数据文件夹");
		this.contentEl.createEl("p", { text: `将把 ${this.plan.moves.length} 个数据文件从「${this.plan.from}」迁移到「${this.plan.to}/${DATA_DIR_NAME}」。` });
		this.contentEl.createEl("p", {
			text: `范围只有插件自己的数据（阅读进度 / 外观预设 / 字体 / 共享资源 / 标注笔记 / 订阅数据），统一收进新位置的 ${DATA_DIR_NAME}/ 数据目录、原目录结构保留。书籍不在其中：它们留在各自原来的文件夹，照样能打开 —— 所以阅读进度、书架顺序与置顶状态都不需要改动。迁移前会检查重名文件，绝不覆盖；中途失败会自动回滚。`,
		});

		// 让用户看清要动的是哪些文件，别盲确认。
		const preview = this.plan.moves.slice(0, 12);
		if (preview.length) {
			const list = this.contentEl.createEl("ul", { cls: "unreader-migration-list" });
			for (const move of preview) list.createEl("li", { text: move.from });
			if (this.plan.moves.length > preview.length) {
				list.createEl("li", { text: `…另有 ${this.plan.moves.length - preview.length} 个` });
			}
		}

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "取消" });
		const switchOnly = buttons.createEl("button", { text: "仅切换，不迁移" });
		const confirm = buttons.createEl("button", { text: "迁移并切换", cls: "mod-cta" });
		cancel.addEventListener("click", () => this.close());
		switchOnly.addEventListener("click", async () => {
			if (this.busy) return;
			this.busy = true;
			switchOnly.disabled = true;
			confirm.disabled = true;
			await this.onSwitchOnly();
			this.close();
		});
		confirm.addEventListener("click", async () => {
			if (this.busy) return;
			this.busy = true;
			cancel.disabled = true;
			confirm.disabled = true;
			confirm.setText("迁移中…");
			if (await this.onConfirm()) this.close();
			else {
				this.busy = false;
				cancel.disabled = false;
				confirm.disabled = false;
				confirm.setText("迁移并切换");
			}
		});
	}
}

/** 数据文件夹选择器：选择的是外层目录，实际数据固定落在其下的 `UNreader/Data/`。 */
class DataFolderModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onChoose: (path: string | null) => void,
	) {
		super(app);
		this.setPlaceholder(`选择外层文件夹（插件会在其中创建 ${DEFAULT_ROOT}/${DATA_DIR_NAME}）…`);
	}

	getItems(): TFolder[] {
		const root = this.app.vault.getRoot();
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((item): item is TFolder => item instanceof TFolder && item !== root)
			// 排除当前数据根自身及其内部：把数据落点选进自己的数据目录只会套娃
			// （`UNreader/Data` → `UNreader/Data/Data`），没有任何合理用法。
			.filter(folder => folder.path !== UNREADER_ROOT && !folder.path.startsWith(`${UNREADER_ROOT}/`))
			.sort((a, b) => a.path.localeCompare(b.path));
		return [root, ...folders];
	}

	getItemText(folder: TFolder): string {
		if (folder === this.app.vault.getRoot()) return `默认位置（${DEFAULT_ROOT}/${DATA_DIR_NAME}）`;
		return `${folder.path} → 数据存入 ${dataRootOf(folder.path)}/${DATA_DIR_NAME}`;
	}

	onChooseItem(folder: TFolder): void {
		const path = folder === this.app.vault.getRoot() ? null : normalizeDataFolder(folder.path);
		this.onChoose(path);
	}
}
