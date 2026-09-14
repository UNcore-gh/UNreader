import { PluginSettingTab, App, Setting, Notice, Platform } from "obsidian";
import type UNreaderPlugin from "./main";
import * as debugLog from "./core/debugLog";
import { saveDebugReportToVault } from "./core/debugReport";
import qqChannelQr from "./assets/qq-channel-qr.jpg";

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

		// 「资料库」一栏已撤下：路径全部由 core/paths.ts 的常量决定，用户无需配置；
		// 字体改在外观面板里「库 / 系统」两个入口导入（见 appearancePanel.buildFontSelect）。
		// 撤掉这一栏也顺带消掉了「路径填错 → 书读不到 / 笔记换地方」这类失败面。

		// ── 库内文件 ──
		// 这一栏与撤下的「资料库」栏的区别值得写清楚：**它不改任何落点**，只往官方的
		// 「排除文件」里登记几条（见 core/exclusions.ts）—— 因此没有迁移面、没有失败面，
		// 用户随时能在 设置 → 文件与链接 → 排除文件 里看见并撤回。
		// 「目录被改名/挪走」不在这里处理：那是目录自愈（core/libraryFolders.ts）的事，
		// 因为那件事本来就不该由用户配置。
		new Setting(containerEl).setName("库内文件").setHeading();

		new Setting(containerEl)
			.setName("标注笔记不参与搜索")
			.setDesc("把 UNreader/Notes 登记进 Obsidian 的「排除文件」：高亮 / 书签旁车笔记不再出现在搜索、关系图谱与快速切换里（笔记文件与高亮功能本身不受影响）。代价是搜不到高亮原文。进度 / 预设 / 字体目录始终登记，书籍文件夹不受影响。")
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

	/** 把日志报告写到库根目录 `unreader-debug-log-<时间戳>.txt`（重名自动加序号）。
	 *  实现收敛在 `core/debugReport.ts` —— 命令「导出诊断日志」共用同一份，避免
	 *  两处各写一份后漂移（漂移的后果是「报告写到别处 / 覆盖上一份」，恰好发生在
	 *  最需要证据的时候）。 */
	private saveReportToVault(): Promise<string> {
		return saveDebugReportToVault(this.app);
	}
}

