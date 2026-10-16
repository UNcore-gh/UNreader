import { PluginSettingTab, App, Setting, Notice, FuzzySuggestModal, TFolder, ButtonComponent } from "obsidian";
import type { SettingDefinitionGroup, SettingDefinitionItem } from "obsidian";
import type UNreaderPlugin from "./main";
import type { CustomButton } from "./types";
import * as debugLog from "./core/debugLog";
import { saveDebugReportToVault } from "./core/debugReport";
import qqChannelQr from "./assets/qq-channel-qr.jpg";
import { DATA_DIR_NAME, DEFAULT_ROOT, UNREADER_ROOT, dataRootOf, normalizeDataFolder } from "./core/paths";
import { SUPPORTED_BOOK_FORMATS } from "./core/bookService";
import { READABLE_FORMATS, normalizeDisabledFormats } from "./core/readableFormats";
import { excludedFolderKey, normalizeExcludedFolder } from "./core/bookExclusions";
import type { SharedResourceKind } from "./core/resourceStore";
import type { LibraryMigrationPlan } from "./core/libraryMigration";
import { openExternalLink } from "./core/externalLink";
import { t, tf, getLang, resolveLang, normalizeLangPref, detectAppLocale, type LangPref } from "./core/i18n";
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

/** 破坏性按钮配色的**裸 `<button>`** 版本：自绘卡片里没有 ButtonComponent 可用
 *  （ButtonComponent.setDestructive 只改自己的类），所以按官方语义类 `mod-warning`
 *  直接挂 class —— 两条渲染路径（≤1.12 / 1.13+）拿到的都是同一个 DOM，效果一致。 */
function markDestructiveSettingButton(el: HTMLElement): void {
	el.addClass("mod-warning");
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

		// 界面语言放最前面：它是「其余所有文案」的开关，用户改语言后本页要整页
		// 重画，放在页首才不会让人误以为下半页没跟着变。
		blocks.push({
			kind: "custom",
			name: t("langLabel"),
			render: root => this.renderLanguageSwitch(root),
		});

		heading(t("secData"));

		const dataLabel = this.dataFolderLabel();
		row(
			t("dataFolderName"),
			tf("dataFolderDesc", { root: DEFAULT_ROOT, data: DATA_DIR_NAME, label: dataLabel }),
			setting => {
				setting.addText(input => {
					input.setValue(dataLabel);
					input.inputEl.readOnly = true;
					input.inputEl.addClass("unreader-materials-folder-input");
				});
				setting.addButton(button =>
					button.setButtonText(t("dataFolderPick")).onClick(() => {
						new DataFolderModal(this.app, path => {
							void this.chooseDataFolder(path);
						}).open();
					}),
				);
				if (this.plugin.settings.dataFolder) {
					setting.addButton(button =>
						button.setButtonText(t("dataFolderUseDefault")).onClick(() => void this.chooseDataFolder(null)),
					);
				}
			},
		);

		heading(t("secReading"));

		row(
			t("pinThresholdName"),
			t("pinThresholdDesc"),
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
						btn.setIcon("rotate-ccw").setTooltip(t("pinThresholdReset")).onClick(() => {
							this.plugin.settings.pinThreshold = 720;
							void this.plugin.persistData();
							this.renderSettings();
						}),
					);
			},
		);

		// ── 自定义按钮（命令 → 按钮）──
		// 同一区块里动态行数会被 test:settings 的「声明式/命令式逐字一致」冒烟覆盖：
		// 所有行都走 row()，且数量只依赖 settings.customButtons（同一定义表喂两条路径）。
		heading(t("secCustomButtons"));

		row(
			t("customButtonAddName"),
			t("customButtonAddDesc"),
			setting => {
				setting.addButton(button =>
					button
						.setButtonText(t("customButtonAdd"))
						.setCta()
						.onClick(() => {
							new CommandPickerModal(this.app, this.plugin.settings.customButtons, picked => {
								void this.addCustomButton(picked);
							}).open();
						}),
				);
			},
		);

		// 渲染层再兜一道：探针/极端脏数据可能绕过 loadSettingsData 的收口，
		// 使 customButtons 为 undefined（同 bookshelfExcludedFolders 的 ?? [] 口径）。
		const customButtons = Array.isArray(this.plugin.settings.customButtons)
			? this.plugin.settings.customButtons
			: [];
		for (const btn of customButtons) {
			this.customButtonRows(blocks, btn);
		}

		// ── 阅读格式管理（2026-10-16）────────────────────────────
		// 每个格式一枚开关：某种格式的阅读功能受损时单独关掉它，不拖累其他格式。
		// 关掉的效果分三层——书籍类不再注册扩展名（onload，需重载生效）+ 书架过滤
		// + 打开链路隔离墙；md 不启动叠加层；rss 入口全拒。细节与硬约束见
		// core/readableFormats.ts 文件头。
		heading(t("secFormatManager"));

		row(t("fmtManagerName"), t("fmtManagerDesc"));

		const disabledFormats = normalizeDisabledFormats(this.plugin.settings.disabledFormats);
		for (const fmt of READABLE_FORMATS) {
			const enabled = !disabledFormats.includes(fmt.id);
			row(
				t(fmt.nameKey),
				t(fmt.descKey),
				setting => {
					setting.addToggle(toggle =>
						toggle.setValue(enabled).onChange(value => {
							// 同一页面上的其他格式可能已经被改过。不能用渲染时捕获的旧数组，
							// 否则连续切换时后一次会覆盖前一次；每次都从当前设置读最新值。
							const current = normalizeDisabledFormats(this.plugin.settings.disabledFormats);
							const next = value
								? current.filter(id => id !== fmt.id)
								: [...current, fmt.id];
							this.plugin.settings.disabledFormats = normalizeDisabledFormats(next);
							void this.plugin.persistData();
							// 关的那一刻必须说清「要重载才完全生效」——否则用户会以为
							// 双击行为立刻变了（扩展名注册只发生在 onload）。
							if (!value) new Notice(tf("fmtOffReload", { name: t(fmt.nameKey) }));
						}),
					);
				},
			);
		}

		// ── 书架（书籍管理侧边栏）──
		// 这一栏管的是「哪些文件算书」的两条边界：**格式**（书架白名单四种，见
		// bookService.SUPPORTED_BOOK_FORMATS）与**位置**（排除文件夹，默认跟随官方
		// 「排除文件」）。两者都只影响列表 —— 被排除的书照常能打开，进度 / 标注 /
		// 置顶一个字都不动，所以这里没有迁移面、也没有数据风险。
		heading(t("shelfSecTitle"));

		row(
			t("shelfFormatsName"),
			tf("shelfFormatsDesc", { formats: SUPPORTED_BOOK_FORMATS.join(" / ") }),
		);

		const followObsidian = this.plugin.settings.bookshelfFollowObsidianExclusions !== false;
		row(
			t("shelfFollowObsidianName"),
			tf("shelfFollowObsidianDesc", { count: this.obsidianExclusionCount() }),
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
			t("shelfExtraExcludeName"),
			excludedFolders.length
				? t("shelfExtraExcludeSome")
				: t("shelfExtraExcludeNone"),
			setting => {
				setting.addButton(button =>
					button
						.setButtonText(t("shelfExcludeAddFolder"))
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
						.setButtonText(t("shelfExcludeRemoveFolder"))
						.onClick(() => {
							void this.saveBookshelfExclusions(excludedFolders.filter(f => excludedFolderKey(f) !== excludedFolderKey(folder)));
						}),
				);
			});
		}

		heading(t("secFeed"));
		row(
			t("feedRefreshOnOpenName"),
			t("feedRefreshOnOpenDesc"),
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
			t("feedMarkReadName"),
			t("feedMarkReadDesc"),
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
			t("feedFulltextName"),
			t("feedFulltextDesc"),
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
			t("feedRemoteImagesName"),
			t("feedRemoteImagesDesc"),
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
			t("feedEntryLimitName"),
			t("feedEntryLimitDesc"),
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
			t("feedImageCacheName"),
			t("feedImageCacheDesc"),
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
			t("feedMediaCacheName"),
			t("feedMediaCacheDesc"),
			setting => {
				setting
					.addSlider(slider => keepSliderValueTooltip(slider
						.setLimits(0, 4096, 100)
						.setValue(this.plugin.settings.feeds.mediaCacheMb))
						.onChange(value => {
							this.plugin.settings.feeds.mediaCacheMb = value;
							void this.plugin.persistData();
						}))
					.addButton(button => markDestructive(button.setButtonText(t("feedClearMediaCache"))).onClick(async () => {
						await this.plugin.feedMediaStore.clear();
						new Notice(t("feedCachesCleared"));
					}));
			},
		);

		// 资源管理只属于设置层：外观面板负责选择“用哪一项”，这里负责保留、移除
		// 与删除资源本体。两者共用 ResourceStore，但不再让外观面板承担管理职责。
		heading(t("resSecTitle"));

		blocks.push(this.resourceRow(
			"font",
			t("resFontName"),
			t("resFontDesc"),
		));
		blocks.push(this.resourceRow(
			"image",
			t("resImageName"),
			t("resImageDesc"),
		));

		// ── 库内文件 ──
		// 这一栏与撤下的「资料库」栏的区别值得写清楚：**它不改任何落点**，只往官方的
		// 「排除文件」里登记几条（见 core/exclusions.ts）—— 因此没有迁移面、没有失败面，
		// 用户随时能在 设置 → 文件与链接 → 排除文件 里看见并撤回。
		// 「目录被改名/挪走」不在这里处理：那是目录自愈（core/libraryFolders.ts）的事，
		// 因为那件事本来就不该由用户配置。
		heading(t("filesSecTitle"));

		row(
			t("excludeNotesName"),
			tf("excludeNotesDesc", { root: DEFAULT_ROOT, data: DATA_DIR_NAME }),
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
		heading(t("diagSecTitle"));

		row(
			t("diagLogName"),
			t("diagLogDesc"),
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
			t("diagExportName"),
			tf("diagExportDesc", { count: debugLog.entryCount() }),
			setting => {
				setting.addButton(btn =>
					btn.setButtonText(t("diagCopyLog")).onClick(async () => {
						if (debugLog.entryCount() === 0) {
							new Notice(t("diagNoLog"));
							return;
						}
						try {
							await navigator.clipboard.writeText(debugLog.buildReport());
							new Notice(t("diagLogCopied"));
						} catch {
							new Notice(t("copyFailed"));
						}
					}),
				);
				setting.addButton(btn =>
					btn.setButtonText(t("diagSaveToVault")).onClick(async () => {
						if (debugLog.entryCount() === 0) {
							new Notice(t("diagNoLog"));
							return;
						}
						try {
							const path = await this.saveReportToVault();
							new Notice(tf("diagLogSaved", { path }));
						} catch {
							new Notice(t("diagLogSaveFailed"));
						}
					}),
				);
				setting.addButton(btn =>
					btn.setButtonText(t("diagClear")).onClick(() => {
						debugLog.clear();
						this.renderSettings();
					}),
				);
			},
		);

		// ── 反馈渠道：与 UNmemos 同一套联系方式 ──
		heading(t("feedbackSecTitle"));
		blocks.push({ kind: "custom", name: t("feedbackCardTitle"), render: root => this.renderFeedback(root) });

		return blocks;
	}

	/** 语言开关：自动 / 中文 / EN 三段。点一下就落盘 + 重画整页 + 重注册命令，
	 *  不需要重载插件。
	 *
	 *  走 `custom` 块而不是普通 row：分段控件要占满整行，做成 row 会被官方
	 *  「名称 | 控件」的横向排布挤到右侧窄栏里。
	 *
	 *  「自动」这一档把**探测到的源 locale 与解析结果**都写在标签上。理由：
	 *  auto 档唯一的信息盲区就是「我到底会看到什么」——用户改的是 Obsidian 软件
	 *  语言，而结果取决于 moment.locale() 这个他看不到的值。把 `zh-TW → 中文`
	 *  这条解析链显式写出来，用户才能确认「繁体也算中文」这类规则生效了，
	 *  而不是只能靠切过去看结果。 */
	private renderLanguageSwitch(root: HTMLElement): void {
		root.createEl("p", { text: t("langDesc"), cls: "setting-item-description" });
		const seg = root.createDiv("unreader-lang-switch");
		const current: LangPref = normalizeLangPref(this.plugin.settings.language);
		// 三档标签一律用**语言自身的名字**（中文 / English），不跟界面语言变 ——
		// 否则英文界面下「自动」档会显示成 "Auto (currently: 中文)"，中英混排很别扭。
		const options: Array<[LangPref, string]> = [
			["auto", t("langAuto")],
			["zh", "中文"],
			["en", "English"],
		];
		for (const [value, label] of options) {
			const btn = seg.createEl("button", {
				cls: `unreader-lang-btn${current === value ? " is-active" : ""}`,
				text: label,
				attr: { type: "button" },
			});
			btn.addEventListener("click", () => {
				if (current === value) return;
				void this.plugin.applyLanguage(value).then(() => this.renderSettings());
			});
		}
		// 仅在 auto 档下方补一行解析说明，钉死档不需要（它就是自己）。
		if (current === "auto") {
			const locale = detectAppLocale();
			const resolved = resolveLang("auto");
			root.createEl("p", {
				text: tf("langAutoResolved", { locale, lang: resolved === "zh" ? "中文" : "English" }),
				cls: "setting-item-description unreader-lang-hint",
			});
		}
	}

	/** 反馈卡：命令式与声明式两条渲染路径共用同一份 DOM 构建。 */
	private renderFeedback(root: HTMLElement): void {
		root.createEl("p", {
			text: t("feedbackCardDesc"),
			cls: "setting-item-description",
		});

		const feedback = root.createDiv("unreader-feedback");

		const qqItem = feedback.createDiv("unreader-feedback-item");
		qqItem.createEl("img", {
			cls: "unreader-feedback-qr",
			attr: { src: qqChannelQr, alt: t("feedbackQrAlt") },
		});
		const qqBody = qqItem.createDiv("unreader-feedback-body");
		qqBody.createDiv({ text: t("feedbackQQTitle"), cls: "unreader-feedback-title" });
		qqBody.createDiv({ text: t("feedbackQQDesc"), cls: "unreader-feedback-desc" });
		const qqBtn = qqBody.createEl("a", {
			text: t("feedbackQQJoin"),
			cls: "unreader-feedback-link",
			attr: { href: QQ_CHANNEL_URL, rel: "noopener", target: "_blank" },
		});
		qqBtn.addEventListener("click", e => {
			e.preventDefault();
			openExternalLink(QQ_CHANNEL_URL);
		});

		const mail = feedback.createDiv("unreader-feedback-row");
		mail.createDiv({ text: t("feedbackMailLabel"), cls: "unreader-feedback-label" });
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
		bili.createDiv({ text: t("feedbackBiliLabel"), cls: "unreader-feedback-label" });
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

	/** 添加一枚自定义按钮：默认两处位置都开、图标闪电；落盘后同步到已打开视图并重绘设置页。 */
	private async addCustomButton(picked: CommandPick): Promise<void> {
		const btn: CustomButton = {
			id: `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			commandId: picked.id,
			label: picked.name.slice(0, 40),
			icon: "zap",
			showInRail: true,
			showInSelbar: true,
		};
		this.plugin.settings.customButtons.push(btn);
		await this.plugin.persistData();
		this.plugin.refreshCustomButtons();
		this.renderSettings();
	}

	/** 删除一枚按钮（按稳定 id）。 */
	private async removeCustomButton(id: string): Promise<void> {
		this.plugin.settings.customButtons = this.plugin.settings.customButtons.filter(b => b.id !== id);
		await this.plugin.persistData();
		this.plugin.refreshCustomButtons();
		this.renderSettings();
	}

	/** 单枚按钮的编辑卡（2026-10-11 重做：官方 Setting 的横向排布在手机窄屏上会把
	 *  标题挤成竖排单字、输入框压到看不见、toggle 没有文字标签，所以这里**清空官方壳
	 *  自绘一张多行卡片**：命令名 + 完整命令 id 占一行、两个带标签的输入框一行、
	 *  两个「点亮式」位置 chip 一行（点一下亮=显示，再点一下灭）、移除按钮收尾。
	 *  每个字段都有可见文字标签，不靠 placeholder 猜（手机端 placeholder 常被压没）。
	 *
	 *  仍然是 `kind: "row"`（不是 custom）：test:settings 的 C5b 断言 custom 块数
	 *  恰好为 1（反馈卡），多一块就会红；而且 row 的 name/desc 仍进声明式搜索索引。
	 *  字段改动只落盘 + 同步视图，**不整页重绘**（避免输入时焦点与滚动位置丢失）；
	 *  删除才整页重绘（行数变了），同 saveBookshelfExclusions 的口径。 */
	private customButtonRows(blocks: UNreaderSettingBlock[], btn: CustomButton): void {
		const patch = async (change: Partial<CustomButton>): Promise<void> => {
			const target = this.plugin.settings.customButtons.find(b => b.id === btn.id);
			if (!target) return;
			Object.assign(target, change);
			await this.plugin.persistData();
			this.plugin.refreshCustomButtons();
		};
		blocks.push({
			kind: "row",
			// 行名/描述仍要写实：声明式下这是设置项在搜索索引里的名字，也是命令式下
			// 官方壳的内容（虽然下面 render 里会被清空重建，但不能留空）。
			name: btn.label || btn.commandId,
			desc: tf("cbCommandDesc", { id: btn.commandId }),
			render: setting => {
				// 清空官方给的横向壳，整块改成自己的卡片（两条渲染路径都走到这里，
				// 所以 ≤1.12 与 1.13+ 视觉一致；C3 的名字一致性比对读的是定义表，不受影响）。
				setting.settingEl.empty();
				setting.settingEl.addClass("unreader-cb-card", "unreader-settings");

				// ── 第一行：命令 id（完整显示，允许换行；用户要能确认到底绑了哪条命令）──
				const cmdRow = setting.settingEl.createDiv({ cls: "unreader-cb-cmd" });
				cmdRow.createSpan({ cls: "unreader-cb-cmd-label", text: t("cbCommandLabel") });
				cmdRow.createSpan({ cls: "unreader-cb-cmd-id", text: btn.commandId });

				// ── 第二行：名称 + 图标两个带标签的输入框 ──
				const fieldRow = setting.settingEl.createDiv({ cls: "unreader-cb-fields" });
				const labelField = fieldRow.createDiv({ cls: "unreader-cb-field" });
				labelField.createDiv({ cls: "unreader-cb-field-label", text: t("cbFieldLabel") });
				const labelInput = labelField.createEl("input", { type: "text", cls: "unreader-cb-input" });
				labelInput.value = btn.label;
				labelInput.setAttribute("aria-label", t("cbFieldLabel"));
				labelInput.addEventListener("input", () => {
					void patch({ label: labelInput.value.trim().slice(0, 40) || btn.commandId });
				});

				const iconField = fieldRow.createDiv({ cls: "unreader-cb-field" });
				iconField.createDiv({ cls: "unreader-cb-field-label", text: t("cbFieldIcon") });
				const iconInput = iconField.createEl("input", { type: "text", cls: "unreader-cb-input" });
				iconInput.value = btn.icon;
				iconInput.setAttribute("aria-label", t("cbIconAria"));
				iconInput.addEventListener("input", () => {
					void patch({ icon: iconInput.value.trim().slice(0, 64) || "zap" });
				});

				// ── 第三行：两个「点亮式」位置 chip（短字，不用长句 toggle）──
				const showRow = setting.settingEl.createDiv({ cls: "unreader-cb-show" });
				showRow.createSpan({ cls: "unreader-cb-show-label", text: t("cbFieldShowIn") });
				const chip = (
					label: string,
					tip: string,
					on: boolean,
					onToggle: (next: boolean) => void,
				): HTMLElement => {
					const b = showRow.createDiv({
						cls: `unreader-cb-chip${on ? " is-on" : ""}`,
						attr: { "aria-pressed": on ? "true" : "false", title: tip, "aria-label": tip },
						text: label,
					});
					b.addEventListener("click", e => {
						e.stopPropagation();
						const next = !b.classList.contains("is-on");
						b.classList.toggle("is-on", next);
						b.setAttribute("aria-pressed", next ? "true" : "false");
						onToggle(next);
					});
					return b;
				};
				chip(
					t("cbChipRail"),
					t("cbChipRailTip"),
					btn.showInRail !== false,
					v => void patch({ showInRail: v }),
				);
				chip(
					t("cbChipSelbar"),
					t("cbChipSelbarTip"),
					btn.showInSelbar !== false,
					v => void patch({ showInSelbar: v }),
				);

				// ── 第四行：移除（破坏性，与其它移除钮同口径）──
				const removeRow = setting.settingEl.createDiv({ cls: "unreader-cb-remove-row" });
				const removeBtn = removeRow.createEl("button", {
					cls: "unreader-cb-remove",
					text: t("customButtonRemove"),
					attr: { "aria-label": t("customButtonRemove") },
				});
				markDestructiveSettingButton(removeBtn);
				removeBtn.addEventListener("click", e => {
					e.stopPropagation();
					void this.removeCustomButton(btn.id);
				});
			},
		});
	}

	/** 落盘排除文件夹并让已打开的书架当场跟随（书架正显示时重绘，模式与滚动位置不变）。 */
	private async saveBookshelfExclusions(next?: string[]): Promise<void> {		if (next) {
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
		return selected
			? tf("dataLabelSelected", { from: selected, to: data })
			: tf("dataLabelDefault", { path: data });
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
			const example = plan.collisions[0] ?? "";
			new Notice(tf("dataCollisionNotice", { count: plan.collisions.length, example }));
			return;
		}
		// 没有可搬的文件（新库 / 已经手工搬过）：直接切落点，不弹确认框
		if (!plan.moves.length) {
			const result = await this.plugin.applyDataFolder(next, { migrate: false });
			this.renderSettings();
			new Notice(result.ok
				? tf("dataSetNoMigrate", { path: `${dataRootOf(next)}/${DATA_DIR_NAME}` })
				: result.error ?? t("dataSwitchFailed"));
			return;
		}

		const switchOnly = async (): Promise<void> => {
			const result = await this.plugin.applyDataFolder(next, { migrate: false });
			this.renderSettings();
			new Notice(result.ok
				? tf("dataSetLeaveBehind", {
					path: `${dataRootOf(next)}/${DATA_DIR_NAME}`,
					count: plan.moves.length,
					from: plan.from,
				})
				: result.error ?? t("dataSwitchFailed"));
		};

		new DataFolderMigrationModal(
			this.app,
			plan,
			async () => {
				const result = await this.plugin.applyDataFolder(next, { migrate: true });
				if (!result.ok) {
					new Notice(result.error ?? t("dataMigrateFailed"));
					return false;
				}
				this.renderSettings();
				new Notice(tf("dataMigratedDone", {
					count: result.moved,
					path: `${dataRootOf(next)}/${DATA_DIR_NAME}`,
				}));
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
			desc: tf("resCountDesc", { desc: description, count }),
			render: setting => {
				setting.addButton(button =>
					button.setButtonText(t("resManage")).onClick(() => {
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
		this.titleEl.setText(t("migrateModalTitle"));
		this.contentEl.createEl("p", {
			text: tf("migrateModalLead", {
				count: this.plan.moves.length,
				from: this.plan.from,
				to: this.plan.to,
				data: DATA_DIR_NAME,
			}),
		});
		this.contentEl.createEl("p", { text: tf("migrateModalBody", { data: DATA_DIR_NAME }) });

		// 让用户看清要动的是哪些文件，别盲确认。
		const preview = this.plan.moves.slice(0, 12);
		if (preview.length) {
			const list = this.contentEl.createEl("ul", { cls: "unreader-migration-list" });
			for (const move of preview) list.createEl("li", { text: move.from });
			if (this.plan.moves.length > preview.length) {
				list.createEl("li", { text: tf("migrateModalMore", { count: this.plan.moves.length - preview.length }) });
			}
		}

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: t("cancel") });
		const switchOnly = buttons.createEl("button", { text: t("migrateSwitchOnly") });
		const confirm = buttons.createEl("button", { text: t("migrateAndSwitch"), cls: "mod-cta" });
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
				confirm.setText(t("migrateInProgress"));
				if (await this.onConfirm()) this.close();
				else {
					this.busy = false;
					cancel.disabled = false;
					confirm.disabled = false;
					confirm.setText(t("migrateAndSwitch"));
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
		this.setPlaceholder(t("pickExcludedFolder"));
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
class DataFolderModal extends FuzzySuggestModal<TFolder> {	constructor(
		app: App,
		private onChoose: (path: string | null) => void,
	) {
		super(app);
		this.setPlaceholder(tf("pickDataFolder", { root: DEFAULT_ROOT, data: DATA_DIR_NAME }));
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
		if (folder === this.app.vault.getRoot()) {
			return tf("pickRootDefault", { path: `${DEFAULT_ROOT}/${DATA_DIR_NAME}` });
		}
		return tf("pickRootTarget", {
			path: folder.path,
			to: dataRootOf(folder.path),
			data: DATA_DIR_NAME,
		});
	}

	onChooseItem(folder: TFolder): void {
		const path = folder === this.app.vault.getRoot() ? null : normalizeDataFolder(folder.path);
		this.onChoose(path);
	}
}

/** 命令选择器的一行：完整命令 id + 显示名。 */
interface CommandPick {
	id: string
	name: string
}

/** 命令选择器：列出 Obsidian 当前注册的全部命令（核心 + 各插件），供自定义按钮绑定。
 *  已绑定过的命令默认仍列出（允许同一命令只放一个位置时重建），但选择时由调用方查重并提示；
 *  默认按使用场景排列并在组内按显示名排序，搜索文本同时覆盖命令名与 id。 */
export class CommandPickerModal extends FuzzySuggestModal<CommandPick> {
	private readonly items: CommandPick[];
	private readonly taken: Set<string>;

	constructor(
		app: App,
		existing: CustomButton[] | undefined,
		private readonly onChoose: (pick: CommandPick) => void,
	) {
		super(app);
		this.setPlaceholder(t("pickCommand"));
		this.taken = new Set((existing ?? []).map(b => b.commandId));
		const taken = this.taken;
		const raw = CommandPickerModal.listCommands(app);
		const daily = [
			"open-reader", "open-book", "toggle-toc", "toggle-annotations", "toggle-bookshelf",
			"toggle-feeds", "add-bookmark", "translate-selection", "toggle-appearance",
			"toggle-full-immersion", "toggle-md-immersion",
		];
		const management = ["open-next-unread-feed", "refresh-feeds", "add-feed"];
		const diagnostics = ["snapshot-neighbor-ui", "export-debug-log"];
		this.items = raw
			.filter(c => c.id && c.name)
			// 默认先列日常阅读，再列订阅管理，最后列诊断；其它插件命令仍按名称排列。
			// FuzzySuggestModal 输入搜索词后会按匹配度展示，下面的顺序只用于默认列表/同分项。
			.sort((a, b) => {
				const order = (id: string): number => {
					if (!id.startsWith("unreader:")) return 100;
					const shortId = id.slice("unreader:".length);
					const dailyIndex = daily.indexOf(shortId);
					if (dailyIndex >= 0) return dailyIndex;
					if (shortId.startsWith("highlight-selection-")) return daily.indexOf("translate-selection") + 0.5;
					const managementIndex = management.indexOf(shortId);
					if (managementIndex >= 0) return 20 + managementIndex;
					const diagnosticsIndex = diagnostics.indexOf(shortId);
					if (diagnosticsIndex >= 0) return 30 + diagnosticsIndex;
					return 40;
				};
				return order(a.id) - order(b.id)
					|| a.name.localeCompare(b.name, getLang() === "zh" ? "zh-Hans-CN" : "en");
			})
			// 已绑定的沉到列表末尾但不隐藏：用户看得见「哪些已加过」，选择时再查重拒绝
			.sort((a, b) => Number(taken.has(a.id)) - Number(taken.has(b.id)));
	}

	private static listCommands(app: App): CommandPick[] {
		const cmds = (app as unknown as {
			commands?: {
				listCommands?: () => Array<{ id: string; name: string }>;
				commands?: Record<string, { name?: string }>;
			};
		}).commands;
		try {
			if (typeof cmds?.listCommands === "function") {
				return cmds.listCommands().map(c => ({ id: c.id, name: c.name ?? c.id }));
			}
		} catch { /* 退回字典 */ }
		return Object.entries(cmds?.commands ?? {}).map(([id, c]) => ({ id, name: c?.name ?? id }));
	}

	getItems(): CommandPick[] {
		return this.items;
	}

	getItemText(item: CommandPick): string {
		return `${item.name} ${item.id}`;
	}

	renderItem(item: CommandPick, el: HTMLElement): void {
		const used = this.taken.has(item.id);
		el.createDiv({ text: item.name, cls: "suggestion-content" });
		el.createDiv({
			cls: "suggestion-flair unreader-command-flair",
			text: used ? tf("cmdFlairAdded", { id: item.id }) : item.id,
		});
	}

	onChooseItem(item: CommandPick): void {
		if (this.taken.has(item.id)) {
			new Notice(t("cmdAlreadyBound"));
			return;
		}
		this.onChoose(item);
	}
}
