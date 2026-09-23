import { PluginSettingTab, App, Setting, Notice, FuzzySuggestModal, TFolder, ButtonComponent } from "obsidian";
import type { SettingDefinitionGroup, SettingDefinitionItem } from "obsidian";
import type UNreaderPlugin from "./main";
import * as debugLog from "./core/debugLog";
import { saveDebugReportToVault } from "./core/debugReport";
import qqChannelQr from "./assets/qq-channel-qr.jpg";
import { DATA_DIR_NAME, DEFAULT_ROOT, UNREADER_ROOT, dataRootOf, normalizeDataFolder } from "./core/paths";
import { SUPPORTED_BOOK_FORMATS } from "./core/bookService";
import { excludedFolderKey, normalizeExcludedFolder } from "./core/bookExclusions";
import type { SharedResourceKind } from "./core/resourceStore";
import type { LibraryMigrationPlan } from "./core/libraryMigration";
import { openExternalLink } from "./core/externalLink";
import { UnreaderModal } from "./ui/modalSkin";

/** 反馈渠道（与 UNmemos 同一套联系方式） */
const FEEDBACK_EMAIL = "2414942469@qq.com";
const QQ_CHANNEL_URL = "https://pd.qq.com/s/9etkz9gqz?b=5";
const BILIBILI_URL = "https://space.bilibili.com/1640219370";

/** 设置页的单一事实来源。1.13+ 的声明式 API 与 <=1.12 的本地渲染器都消费它，
 *  设置项的名称 / 描述 / 行为因此只维护一处，不会随两条渲染路径漂移。
 *  · row：一条标准 Setting 行（名称 + 描述 + render 里挂控件）；
 *  · custom：整块自定义 DOM（反馈卡），声明式下会清空官方给的 Setting 壳。
 */
type UNreaderSettingBlock =
	| { kind: "heading"; name: string }
	| { kind: "row"; name: string; desc?: string; render?: (setting: Setting) => void }
	| { kind: "custom"; name: string; render: (root: HTMLElement) => void };

/** `SliderComponent.setDynamicTooltip()` 自 1.13 起废弃 —— 官方说法是「滑块当前值改为
 *  常显」。但本插件 `manifest.minAppVersion` 是 **1.7.2**：在 1.7–1.12 上「拖动时看到
 *  当前值」只有这一条路，删掉就是旧版本上的可见退化。所以保留调用，只是按结构类型取用，
 *  别让它一直挂在废弃清单里。 */
function keepSliderValueTooltip<T extends object>(slider: T): T {
	(slider as { setDynamicTooltip?: () => unknown }).setDynamicTooltip?.();
	return slider;
}

/** `ButtonComponent.setWarning()` 自 1.13 起废弃，官方替代是 `setDestructive()`；
 *  而 `setDestructive()` 在 1.7–1.12 的运行时里**不存在**，直接换过去会把旧版本点崩。
 *  所以两条路都留着：新版本走官方推荐，旧版本走原 API，视觉结果一致（破坏性按钮配色）。 */
function markDestructive(button: ButtonComponent): ButtonComponent {
	const compat = button as unknown as { setDestructive?: () => unknown; setWarning?: () => unknown };
	if (compat.setDestructive) compat.setDestructive();
	else compat.setWarning?.();
	return button;
}

export class UNreaderSettingTab extends PluginSettingTab {
	private plugin: UNreaderPlugin;
	/** 见 `renderSettings()` 的声明式分支：`update()` 重入保险。 */
	private declarativeRefreshing = false;

	constructor(app: App, plugin: UNreaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.renderSettings();
	}

	/** 1.13+ 的声明式入口。官方在它返回非空数组时**不再调用** `display()`；
	 *  <=1.12 的基类不认识这个方法，也不会读它。 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const groups: SettingDefinitionGroup[] = [];
		for (const block of this.settingBlocks()) {
			if (block.kind === "heading") {
				groups.push({ type: "group", heading: block.name, items: [] });
				continue;
			}
			const group = groups[groups.length - 1];
			if (!group) continue; // 定义表以 heading 开头；这里只是类型兜底
			const items = (group.items ??= []);
			if (block.kind === "custom") {
				items.push({
					name: block.name,
					render: setting => {
						// 自定义区块整行重绘：先清空官方给的 Setting 壳，再交给同一份
						// 渲染函数；`unreader-settings-custom` 负责去掉 setting-item
						// 的横向排布（见 styles.css）。
						setting.settingEl.empty();
						setting.settingEl.addClass("unreader-settings", "unreader-settings-custom");
						block.render(setting.settingEl);
					},
				});
				continue;
			}
			items.push({
				name: block.name,
				...(block.desc ? { desc: block.desc } : {}),
				render: setting => {
					setting.settingEl.addClass("unreader-settings");
					block.render?.(setting);
				},
			});
		}
		return groups;
	}

	/** 设置页重绘的唯一入口（display 与各设置项的 onChange 都会调它）：
	 *  1.13+ 的 DOM 归官方声明式渲染管，这里只能请求 `update()` 重算定义；
	 *  <=1.12 没有 `update()`，走本地命令式渲染器。 */
	private renderSettings(): void {
		if (this.usesDeclarativeSettings()) {
			// 重入闸门：官方契约是 `update()` 只重算定义表并重绘，但它内部**若**再走回
			// `display()`，没有这道闸就是 display → update → display 的无限递归
			// （设置页直接卡死）。见 test:settings 的 C11（去掉闸门必 RangeError）。
			if (this.declarativeRefreshing) return;
			this.declarativeRefreshing = true;
			try {
				(this as unknown as { update?: () => void }).update?.();
			} finally {
				this.declarativeRefreshing = false;
			}
			return;
		}
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("unreader-settings");
		for (const block of this.settingBlocks()) {
			if (block.kind === "heading") {
				new Setting(containerEl).setName(block.name).setHeading();
				continue;
			}
			if (block.kind === "custom") {
				block.render(containerEl);
				continue;
			}
			const setting = new Setting(containerEl).setName(block.name);
			if (block.desc) setting.setDesc(block.desc);
			// 两条渲染路径统一挂同一个容器类：styles.css 的按钮 / 下拉皮肤靠它
			// 命中，而官方声明式容器上没有我们的类可挂。
			setting.settingEl.addClass("unreader-settings");
			block.render?.(setting);
		}
	}

	/** 运行时能力探针：`update()` 是 1.13 起才有的 PluginSettingTab 成员。 */
	private usesDeclarativeSettings(): boolean {
		return typeof (this as unknown as { update?: unknown }).update === "function";
	}

	/** 定义表的唯一来源（见文件顶部的 UNreaderSettingBlock 说明）。 */
	private settingBlocks(): UNreaderSettingBlock[] {
		const blocks: UNreaderSettingBlock[] = [];
		const heading = (name: string): void => {
			blocks.push({ kind: "heading", name });
		};
		const row = (name: string, desc?: string, render?: (setting: Setting) => void): void => {
			blocks.push({ kind: "row", name, desc, render });
		};

		// 说明：所有阅读外观（字体/排版/主题/颜色/背景图/玻璃/预设……）
		// 均可在阅读界面右上角的「阅读外观」面板中实时调节，不再在设置页重复。
		// 设置页只保留阅读界面无法调整的全局项；沉浸模式（功能轨按钮）与
		// 标注钉住（标注面板钉住按钮）同理，只在书页内设置。

		heading("数据");

		const dataLabel = this.dataFolderLabel();
		row(
			"数据文件夹",
			`你选择的是外层资料文件夹。插件会固定在其中创建 ${DEFAULT_ROOT}/${DATA_DIR_NAME}/，把阅读进度 / 外观预设 / 字体 / 共享资源 / 标注笔记 / 订阅数据都收进这个数据目录（外层目录里不会散落任何插件文件）。切换位置时会把这几类文件整体迁过去；书籍不搬，一律留在原来的文件夹 —— 书放在库内任何位置都能打开，所以进度、书架顺序、笔记链接都不受影响。当前：${dataLabel}`,
			setting => {
				setting.addText(input => {
					input.setValue(dataLabel);
					input.inputEl.readOnly = true;
					input.inputEl.addClass("unreader-materials-folder-input");
				});
				setting.addButton(button =>
					button.setButtonText("选择文件夹").onClick(() => {
						new DataFolderModal(this.app, path => {
							void this.chooseDataFolder(path);
						}).open();
					}),
				);
				if (this.plugin.settings.dataFolder) {
					setting.addButton(button =>
						button.setButtonText("使用默认位置").onClick(() => void this.chooseDataFolder(null)),
					);
				}
			},
		);

		heading("阅读");

		row(
			"钉住可用最小宽度",
			"当阅读区宽度小于此阈值时，钉住按钮自动隐藏并退回悬浮模式，避免内容过窄。范围 400-1200px，便捷默认值 720px。",
			setting => {
				setting
					.addSlider(sl =>
						keepSliderValueTooltip(sl
							.setLimits(400, 1200, 10)
							.setValue(this.plugin.settings.pinThreshold))
							.onChange(v => {
								this.plugin.settings.pinThreshold = v;
								this.plugin.scheduleSave();
							}),
					)
					.addButton(btn =>
						btn.setIcon("rotate-ccw").setTooltip("恢复默认 720").onClick(() => {
							this.plugin.settings.pinThreshold = 720;
							void this.plugin.persistData();
							this.renderSettings();
						}),
					);
			},
		);

		// ── 书架（书籍管理侧边栏）──
		// 这一栏管的是「哪些文件算书」的两条边界：**格式**（写死五种，见
		// bookService.SUPPORTED_BOOK_FORMATS）与**位置**（排除文件夹，默认跟随官方
		// 「排除文件」）。两者都只影响列表 —— 被排除的书照常能打开，进度 / 标注 /
		// 置顶一个字都不动，所以这里没有迁移面、也没有数据风险。
		heading("书架");

		row(
			"收录的格式",
			`书架与「打开书籍」只列出 ${SUPPORTED_BOOK_FORMATS.join(" / ")}（含 .htm）。其它格式（PDF、Markdown、FB2 等）不会出现在书籍管理界面里 —— 它们在文件树中原样保留、也能由别的程序打开，只是不当作书。`,
		);

		const followObsidian = this.plugin.settings.bookshelfFollowObsidianExclusions !== false;
		row(
			"跟随 Obsidian 的排除文件夹",
			`把官方「设置 → 文件与链接 → 排除文件」里的条目也用来过滤书架。官方那边加一条（如某个附件或资料目录），书架里就少一批书 —— 当前官方共 ${this.obsidianExclusionCount()} 条排除项。排除只影响书籍列表：文件本身、阅读进度与标注都不受影响。`,
			setting => {
				setting.addToggle(toggle =>
					toggle
						.setValue(followObsidian)
						.onChange(value => {
							this.plugin.settings.bookshelfFollowObsidianExclusions = value;
							void this.saveBookshelfExclusions();
						}),
				);
			},
		);

		const excludedFolders = this.plugin.settings.bookshelfExcludedFolders ?? [];
		row(
			"额外排除的文件夹",
			excludedFolders.length
				? "以下文件夹里的书不会出现在书架与「打开书籍」列表里。"
				: "还没有额外排除的文件夹。需要把某个目录（下载、附件、别人的资料……）从书架里摘掉时在这里添加。",
			setting => {
				setting.addButton(button =>
					button
						.setButtonText("添加文件夹")
						.setCta()
						.onClick(() => {
							new ExcludedFolderModal(this.app, new Set(excludedFolders.map(excludedFolderKey)), path => {
								void this.saveBookshelfExclusions([...excludedFolders, path]);
							}).open();
						}),
				);
			},
		);

		for (const folder of excludedFolders) {
			row(folder, undefined, setting => {
				setting.addButton(button =>
					button
						.setButtonText("移除")
						.onClick(() => {
							void this.saveBookshelfExclusions(excludedFolders.filter(f => excludedFolderKey(f) !== excludedFolderKey(folder)));
						}),
				);
			});
		}

		heading("订阅");
		row(
			"打开订阅板块时自动刷新",
			"只在用户首次打开订阅侧边栏时触发一次受控刷新；插件启动、布局恢复和后台标签不会发起网络请求。",
			setting => {
				setting.addToggle(toggle => toggle
					.setValue(this.plugin.settings.feeds.refreshOnOpen)
					.onChange(value => {
						this.plugin.settings.feeds.refreshOnOpen = value;
						void this.plugin.persistData();
					}));
			},
		);
		row(
			"打开文章即标记已读",
			"打开文章或播客详情时写入已读时间；关闭后仍可通过文章卡片手动管理。",
			setting => {
				setting.addToggle(toggle => toggle
					.setValue(this.plugin.settings.feeds.markReadOnOpen)
					.onChange(value => {
						this.plugin.settings.feeds.markReadOnOpen = value;
						void this.plugin.persistData();
					}));
			},
		);
		row(
			"自动抓取网页全文",
			"订阅源只给标题或摘要时，打开文章会尝试读取原网页正文；网页抓取失败仍保留摘要。",
			setting => {
				setting.addToggle(toggle => toggle
					.setValue(this.plugin.settings.feeds.autoFulltext)
					.onChange(value => {
						this.plugin.settings.feeds.autoFulltext = value;
						void this.plugin.persistData();
					}));
			},
		);
		row(
			"加载远程图片",
			"关闭后文章正文中的远程图片会被移除，适合移动网络或隐私敏感场景。",
			setting => {
				setting.addToggle(toggle => toggle
					.setValue(this.plugin.settings.feeds.loadRemoteImages)
					.onChange(value => {
						this.plugin.settings.feeds.loadRemoteImages = value;
						void this.plugin.persistData();
					}));
			},
		);
		row(
			"每个订阅保留文章数",
			"刷新后按发布时间保留最新文章，超出上限的旧文章会被清理以控制体积；星标文章与有笔记（高亮/批注/书签）的文章长期保留，不参与清理。",
			setting => {
				setting.addSlider(slider => keepSliderValueTooltip(slider
					.setLimits(20, 1000, 20)
					.setValue(this.plugin.settings.feeds.entryLimit))
					.onChange(value => {
						this.plugin.settings.feeds.entryLimit = value;
						void this.plugin.persistData();
					}));
			},
		);
		row(
			"图片缓存上限",
			"文章图片保存在本机的离线缓存里，不随库同步。单位为兆字节，0 表示不落盘缓存。",
			setting => {
				setting.addSlider(slider => keepSliderValueTooltip(slider
					.setLimits(0, 1024, 25)
					.setValue(this.plugin.settings.feeds.imageCacheMb))
					.onChange(value => {
						this.plugin.settings.feeds.imageCacheMb = value;
						void this.plugin.persistData();
					}));
			},
		);
		row(
			"播客缓存上限",
			"播客默认流式播放，只有显式下载才写入本机缓存。单位为兆字节。",
			setting => {
				setting
					.addSlider(slider => keepSliderValueTooltip(slider
						.setLimits(0, 4096, 100)
						.setValue(this.plugin.settings.feeds.mediaCacheMb))
						.onChange(value => {
							this.plugin.settings.feeds.mediaCacheMb = value;
							void this.plugin.persistData();
						}))
					.addButton(button => markDestructive(button.setButtonText("清空媒体缓存")).onClick(async () => {
						await this.plugin.feedMediaStore.clear();
						new Notice("RSS 图片和播客缓存已清空");
					}));
			},
		);

		// 资源管理只属于设置层：外观面板负责选择“用哪一项”，这里负责保留、移除
		// 与删除资源本体。两者共用 ResourceStore，但不再让外观面板承担管理职责。
		heading("资源管理");

		blocks.push(this.resourceRow(
			"font",
			"字体资源",
			"库内字体文件；可选择保留使用，或在所有设备上停用（不删除文件）。",
		));
		blocks.push(this.resourceRow(
			"image",
			"图片资源",
			"库内共享背景图；可选择保留使用，或在所有设备上停用（不删除文件）。",
		));

		// ── 库内文件 ──
		// 这一栏与撤下的「资料库」栏的区别值得写清楚：**它不改任何落点**，只往官方的
		// 「排除文件」里登记几条（见 core/exclusions.ts）—— 因此没有迁移面、没有失败面，
		// 用户随时能在 设置 → 文件与链接 → 排除文件 里看见并撤回。
		// 「目录被改名/挪走」不在这里处理：那是目录自愈（core/libraryFolders.ts）的事，
		// 因为那件事本来就不该由用户配置。
		heading("库内文件");

		row(
			"标注笔记不参与搜索",
			`把插件数据目录登记进 Obsidian 的「排除文件」。开启（默认）：整个 ${DEFAULT_ROOT}/${DATA_DIR_NAME}/ 登记为一条，高亮 / 书签旁车笔记不再出现在搜索、关系图谱与快速切换里（笔记文件与高亮功能本身不受影响），代价是搜不到高亮原文。关闭：改为逐个子目录登记并放过 Notes —— 笔记可以被搜索到。书籍从不登记。`,
			setting => {
				setting.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.excludeNotesFromSearch !== false)
						.onChange(v => {
							this.plugin.settings.excludeNotesFromSearch = v;
							void this.plugin.persistData();
							void this.plugin.syncExclusions();
						}),
				);
			},
		);

		// ── 诊断：可选的内存调试日志，导出后发给开发者排查 ──
		heading("诊断");

		row(
			"调试日志",
			"插件异常需要排查时开启：捕获插件报错与关键事件到内存（关闭时零捕获零存储，重启即清空）。开启后复现问题，再导出发给开发者。",
			setting => {
				setting.addToggle(toggle =>
					toggle
						.setValue(!!this.plugin.settings.debugLog)
						.onChange(v => {
							this.plugin.settings.debugLog = v;
							void this.plugin.persistData();
							this.renderSettings();
						}),
				);
			},
		);

		row(
			"导出日志",
			`当前已记录 ${debugLog.entryCount()} 条。复制到剪贴板或保存为库内文件后发给开发者。`,
			setting => {
				setting.addButton(btn =>
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
				setting.addButton(btn =>
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
				setting.addButton(btn =>
					btn.setButtonText("清空").onClick(() => {
						debugLog.clear();
						this.renderSettings();
					}),
				);
			},
		);

		// ── 反馈渠道：与 UNmemos 同一套联系方式 ──
		heading("反馈渠道");
		blocks.push({ kind: "custom", name: "反馈渠道", render: root => this.renderFeedback(root) });

		return blocks;
	}

	/** 反馈卡：命令式与声明式两条渲染路径共用同一份 DOM 构建。 */
	private renderFeedback(root: HTMLElement): void {
		root.createEl("p", {
			text: "遇到问题、想提建议或参与内测，欢迎通过以下渠道联系我们。",
			cls: "setting-item-description",
		});

		const feedback = root.createDiv("unreader-feedback");

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
			text: "Space.bilibili.com/1640219370",
			cls: "unreader-feedback-link",
			attr: { href: BILIBILI_URL, rel: "noopener", target: "_blank" },
		});
		biliLink.addEventListener("click", e => {
			e.preventDefault();
			openExternalLink(BILIBILI_URL);
		});
	}

	/** 官方「排除文件」的条目数。只读、只用于设置页文案（用户得知道跟随了多少条）。 */
	private obsidianExclusionCount(): number {
		try {
			const host = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
			const raw = host.getConfig?.("userIgnoreFilters");
			return Array.isArray(raw) ? raw.filter(x => typeof x === "string" && x !== "").length : 0;
		} catch {
			return 0;
		}
	}

	/** 落盘排除文件夹并让已打开的书架当场跟随（书架正显示时重绘，模式与滚动位置不变）。 */
	private async saveBookshelfExclusions(next?: string[]): Promise<void> {
		if (next) {
			// 归一化 + 去重（比较用小写键）：手写 `Books/` 与 `books` 是同一条，
			// 与 `main.loadSettingsData` 同一口径 —— 否则读盘后被收敛、设置页显示与
			// 落盘内容不一致。空条目直接丢掉（选文件夹不可能产生，但手改 data.json 会）。
			this.plugin.settings.bookshelfExcludedFolders = [
				...new Map(
					next
						.map(f => normalizeExcludedFolder(f))
						.filter(f => f !== "")
						.map(f => [excludedFolderKey(f), f] as const),
				).values(),
			];
		}
		await this.plugin.persistData();
		this.plugin.refreshBookshelfPanel();
		// 只有列表变动才重绘设置页（重绘会把滚动位置带回顶部）；开关本身不用重绘 ——
		// 状态已在控件上，描述里的条目数是次要信息，下次进设置页自然刷新。
		if (next) this.renderSettings();
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
			this.renderSettings();
			new Notice(result.ok
				? `数据文件夹已设为「${dataRootOf(next)}/${DATA_DIR_NAME}」；没有需要迁移的数据文件`
				: result.error ?? "切换失败");
			return;
		}

		const switchOnly = async (): Promise<void> => {
			const result = await this.plugin.applyDataFolder(next, { migrate: false });
			this.renderSettings();
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
				this.renderSettings();
				new Notice(`已迁移 ${result.moved} 个数据文件到「${dataRootOf(next)}/${DATA_DIR_NAME}」；书籍与书架顺序未动`);
				return true;
			},
			switchOnly,
		).open();
	}

	/** 设置层的资源入口；实际启用/移除/删除逻辑统一在插件层执行。 */
	private resourceRow(kind: SharedResourceKind, label: string, description: string): UNreaderSettingBlock {
		const count = this.plugin.resourceStore?.list(kind).length ?? 0;
		return {
			kind: "row",
			name: label,
			desc: `${description} 当前 ${count} 项。`,
			render: setting => {
				setting.addButton(button =>
					button.setButtonText("管理").onClick(() => {
						void this.plugin.openResourceManager(kind, () => this.renderSettings());
					}),
				);
			},
		};
	}

	/** 把日志报告写到库根目录 `unreader-debug-log-<时间戳>.txt`（重名自动加序号）。
	 *  实现收敛在 `core/debugReport.ts` —— 命令「导出诊断日志」共用同一份，避免
	 *  两处各写一份后漂移（漂移的后果是「报告写到别处 / 覆盖上一份」，恰好发生在
	 *  最需要证据的时候）。 */
	private saveReportToVault(): Promise<string> {
		return saveDebugReportToVault(this.app);
	}
}

class DataFolderMigrationModal extends UnreaderModal {
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
		switchOnly.addEventListener("click", () => {
			void (async (): Promise<void> => {
				if (this.busy) return;
				this.busy = true;
				switchOnly.disabled = true;
				confirm.disabled = true;
				await this.onSwitchOnly();
				this.close();
			})();
		});
		confirm.addEventListener("click", () => {
			void (async (): Promise<void> => {
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
			})();
		});
	}
}

/** 书架排除文件夹选择器：只列库内目录，已经排除的不再出现（避免重复条目）。
 *  **库根不在列**：选中它等于把整库排除、书架瞬间空掉 —— 那不是「排除文件夹」的意图，
 *  真要做也不该从一个下拉里一步达成（与 `DataFolderModal` 挡住库根同一个道理）。 */
class ExcludedFolderModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private taken: Set<string>,
		private onChoose: (path: string) => void,
	) {
		super(app);
		this.setPlaceholder("选择要从书架里排除的文件夹…");
	}

	getItems(): TFolder[] {
		const root = this.app.vault.getRoot();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((item): item is TFolder => item instanceof TFolder && item !== root)
			.filter(folder => !this.taken.has(excludedFolderKey(folder.path)))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder.path);
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
