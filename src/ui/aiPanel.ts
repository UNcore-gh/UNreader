import { App, Notice, setIcon } from "obsidian";
import {
	OFFICIAL_TOOLS,
	AI_LANGUAGE_TOKEN,
	applyLanguageToken,
	extractBlockElements,
	applyTypographyWriteBack,
	applyTypographyChunkWriteBack,
	restoreTypographyChunk,
	applyTranslationWriteBack,
	planTypographyUnits,
	runAiTaskOnBlocks,
	TYPOGRAPHY_CHUNK_INSTRUCTION,
	TYPOGRAPHY_BLOCK_INSTRUCTION,
	SEGMENTED_TRANSLATION_INSTRUCTION,
	type AiBlock,
} from "../core/aiTasks";
import { detectUnagent, unagentGuidance } from "../core/unagentBridge";
import { VersionBar, type AiVersion } from "./versionBar";
import type { Bounds } from "./floatingPlacement";
import type { AiCustomFunction, AiFunctionScope, AiSettings, AiToolEntry, UnagentAIApi } from "../types";

/** 「选中文字」类任务的结果卡片（真机 = readerView 的译文卡片，与划词翻译同一张）：
 *  chunk/finish/fail 由面板在同一次请求的生命周期里调用。 */
export interface AiResultCard {
	chunk: (delta: string) => void
	finish: (text: string) => void
	fail: (message: string) => void
}

export interface AIPanelCallbacks {
	/** Obsidian app 实例（检测 UNagent 与打开设置页用） */
	app: App
	/** 实时读取（面板每次 render 现查，不缓存 getAI 的结论） */
	getSettings: () => AiSettings
	/** 合并写回并持久化（readerView 收口 persistData） */
	onPatch: (patch: Partial<AiSettings>) => void
	/** 全文类任务（官方两枚 + 自定义「全文」作用域）的操作根：Feed/书都是**当前渲染帧**
	 *  的 body。**写回必须走 writeBlock**（若提供）：它在写入前后做「高亮范围重锚」，
	 *  保证 AI 替换正文（以及「原文 / AI 版本」来回切）时高亮不丢、跟随新文本；
	 *  取不到时调用方退回直接写 textContent。无打开内容 = null */
	getFullTextRoot: () => {
		title: string
		root: HTMLElement
		onApplied: () => void
		writeBlock?: (block: AiBlock, writer: () => boolean) => boolean
	} | null
	/** 「选中文字」作用域的自定义功能取当前选区（getReaderSelection 同源，含 10s 兜底） */
	getSelectionText: () => string | null
	/** 正文区底部「原文 / AI 版本」切换条的挂载点（readerView：append 到 `.unreader-body`，
	 *  与面板同一份 chrome-hidden 豁免）。缺省 = 不挂（探针/无正文宿主）。 */
	mountVersionBar?: (containerEl: HTMLElement) => void
	/** 版本切换条的可用区现测供体（真机 = stageBoundsNow：已裁键盘与键盘上方原生栏） */
	versionBarBounds?: () => Bounds
	/** 选区类任务的结果落**正文区的贴底卡片**（面板不再展示 AI 输出内容）。不提供 = 无处展示 */
	showResultCard?: (opts: { title: string; sourceText: string; modelLabel: string; onRetry: () => void }) => AiResultCard | null
	/** 面板展开后定位（左缘对齐功能轨），镜像外观面板的 onOpened */
	onOpened?: () => void
	onOpenChange?: (open: boolean) => void
}

interface SettingAppApi {
	setting?: {
		open: () => void
		openTabById: (id: string) => unknown
	}
	plugins?: {
		manifests?: Record<string, unknown>
		enablePlugin?: (id: string) => Promise<void>
	}
}

export const AI_LANGUAGES = ["简体中文", "繁體中文", "English", "日本語", "한국어", "Français", "Deutsch", "Español", "Русский", "Português"];
const CUSTOM_LIMIT = 20;
const CUSTOM_PROMPT_MAX = 4000;
const OFFICIAL_PROMPT_MAX = 6000;

type AiRunState = "idle" | "running" | "done" | "error" | "cancelled";

/** 逐块快照：**改写前**的原文、AI 输出、以及是否真的写进了正文。两个版本的文本都是
 *  **不可变快照**（写回只改 DOM，从不回写这两个字段），所以「原文 / AI 版本」可以来回
 *  切而不丢内容，切多少次都是同两份文本。 */
interface AiRunBlock {
	/** 写回目标。排版路径的 `block.textNodes` 是逐节点原文，两个方向都据此保结构；
	 *  排版组通道的 block 是组单元（`chunkEls` = 组内原块元素）。 */
	block?: AiBlock
	/** 排版组通道：组内原块元素（写回 = 注入 AI 结果兄弟节点 + 隐藏原块；
	 *  切换 = 增删该节点 + 解除/恢复隐藏，原块 DOM 一字不动）。 */
	chunk?: { els: HTMLElement[] }
	/** 本次运行前的块文本（去掉首尾空白） */
	original: string
	/** AI 输出；null = 还没跑到（取消 / 失败前尚未处理）→ 不参与版本切换 */
	result: string | null
	/** AI 文本是否真的写进过这块（排版优化的逐字守卫拒绝、未跑到 → false，永不参与切换） */
	applied: boolean
}

/** 正文当前的版本状态：**只由全文任务改写**（选区任务不动正文，也就不能顶掉它 ——
 *  否则跑一次选区工具就把上一轮全文的「原文」丢了）。会话级内存态，不落盘。 */
interface AiBodyVersions {
	title: string
	blocks: AiRunBlock[]
	version: AiVersion
	/** 用户用版本条的 ✕ 收起过：之后的进度/重绘不许再自动弹出来（面板里的入口可再唤出） */
	dismissed: boolean
}

interface AiRun {
	title: string
	state: AiRunState
	done: number
	total: number
	/** 失败原因 */
	error?: string
	/** 本运行是否改写了正文：决定状态行文案与是否给「版本切换」入口（选区任务 → false） */
	wroteBody: boolean
}

/** 统一工具编辑器状态：官方工具（查看/改/重置）与自定义工具（新增/编辑）共用一套表单。 */
type AiEditor =
	| { kind: "official"; toolId: "translate" | "typography"; scope: AiFunctionScope; enabled: boolean }
	| { kind: "custom-new"; scope: AiFunctionScope; enabled: boolean }
	| { kind: "custom-edit"; fnId: string; scope: AiFunctionScope; enabled: boolean }
	| null;

/** AI 助手停靠面板（与外观/目录面板同一形态）：挂 `.unreader-body`、功能轨按钮开合、
 *  `is-open` 显隐、点外面关闭。
 *
 *  统一工具模型：官方「全文翻译 / 排版优化」与用户自定义工具同构 —— 都是
 *  「提示词 + 作用域（全文/选中文字）」，点击即运行。官方工具不可删除，但可点开
 *  查看/修改提示词与作用域、重置回官方默认（改动存 settings.ai.toolOverrides，
 *  默认词活在代码里、升级不丢）；自定义工具可增删改。提示词里的 `{目标语言}` 占位
 *  在运行时替换为面板选择的语言。
 *
 *  全文类任务的结果**替换到正文当中**：对当前渲染帧的文档逐块写回；正文里「原文 / AI
 *  版本」的切换由**正文区底部的版本条**提供（`src/ui/versionBar.ts`）—— 面板只放工具、
 *  进度与状态，**不再展示 AI 输出内容**（2026-09-28 用户要求）。「选中文字」作用域的
 *  结果落在正文区的贴底卡片（由宿主提供，与划词翻译同一张）。 */
export class AIPanel {
	readonly containerEl: HTMLElement;
	private readonly callbacks: AIPanelCallbacks;
	private statusTextEl!: HTMLElement;
	private statusDotEl!: HTMLElement;
	private statusActionBtn!: HTMLElement;
	private customListEl!: HTMLElement;
	private addBtn!: HTMLElement;
	private formEl!: HTMLElement;
	private formNameRow!: HTMLElement;
	private formNameEl!: HTMLInputElement;
	private formPromptEl!: HTMLTextAreaElement;
	private formScopeEl!: HTMLElement;
	private formButtonsEl!: HTMLElement;
	private runEl!: HTMLElement;
	private progressBarEl: HTMLElement | null = null;
	private editor: AiEditor = null;
	private run: AiRun | null = null;
	/** 正文版本状态（全文任务写，选区任务不碰）+ 正文区里的切换条 */
	private versions: AiBodyVersions | null = null;
	private readonly versionBar: VersionBar;
	private abort: AbortController | null = null;
	private ignoreOutsideUntil = 0;
	/** 阴性对照（`?legacy-no-original=1`）：关掉逐块原文快照 = 本特性之前的形态（跑完只有
	 *  正文里那一版，没有版本条也就切不回去）。G7 的断言在阴性档必须变红、其余组仍绿。
	 *  接缝先例 = translationCard 的 `?legacy-no-stream=1`（组件内读 URL 参数）。 */
	private readonly originalDisabled = typeof window !== "undefined"
		&& new URLSearchParams(window.location.search).has("legacy-no-original");
	/** 阴性对照（`?legacy-flatten=1`）：翻译的结构块退回旧的 textContent 整体替换
	 *  （链接/强调/图片被抹平 = 用户报障的形态），验证「翻译保结构」断言有辨别力。 */
	private readonly flattenDisabled = typeof window !== "undefined"
		&& new URLSearchParams(window.location.search).has("legacy-flatten");
	/** 阴性对照（`?legacy-no-chunk=1`）：排版不做组规划，全部块走逐块空白通道
	 *  （= v2 之前「只改空白」的形态），验证「排版组通道」断言有辨别力。 */
	private readonly chunkDisabled = typeof window !== "undefined"
		&& new URLSearchParams(window.location.search).has("legacy-no-chunk");

	private onDocPointerDown = (ev: PointerEvent): void => {
		// 打开后的短窗口内忽略外部指针（打开点击的同一次事件链不再关自己）
		if (performance.now() < this.ignoreOutsideUntil) return;
		const target = ev.target as HTMLElement | null;
		if (!target) return;
		if (this.containerEl.contains(target)) return;
		// 功能轨上的点击归开合按钮自己处理，这里不抢
		if (target.closest(".unreader-actions")) return;
		this.close();
	};

	constructor(callbacks: AIPanelCallbacks) {
		this.callbacks = callbacks;
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-ai-panel";
		// 正文区底部的版本切换条：面板自建（状态在面板），宿主只给挂载点与可用区几何
		this.versionBar = new VersionBar({
			onSwitch: version => this.switchVersion(version),
			onClose: () => {
				if (this.versions) this.versions.dismissed = true;
				this.versionBar.hide();
				this.updateRunArea();
			},
		});
		if (callbacks.versionBarBounds) this.versionBar.setBoundsResolver(callbacks.versionBarBounds);
		callbacks.mountVersionBar?.(this.versionBar.containerEl);
		this.render();
		this.containerEl.addEventListener("pointerdown", e => e.stopPropagation());
	}

	getSettings(): AiSettings {
		return this.callbacks.getSettings();
	}

	open(): void {
		this.ignoreOutsideUntil = performance.now() + 300;
		this.render();
		this.containerEl.addClass("is-open");
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
		this.callbacks.onOpened?.();
		this.callbacks.onOpenChange?.(true);
	}

	close(): void {
		if (!this.containerEl.hasClass("is-open")) return;
		this.containerEl.removeClass("is-open");
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		this.callbacks.onOpenChange?.(false);
	}

	toggle(): boolean {
		if (this.containerEl.hasClass("is-open")) this.close();
		else this.open();
		return this.containerEl.hasClass("is-open");
	}

	isOpen(): boolean {
		return this.containerEl.hasClass("is-open");
	}

	/** 取消在飞任务。`keepRecord` 的两种口径分开：
	 *  · 面板「取消」按钮（keepRecord）——**保留正文版本状态**：已替换的段落仍能在正文里
	 *    切回原文（旧实现把运行记录整个丢掉，取消之后那半篇被替换过的正文就再也回不去了）；
	 *  · 换书/换章/关视图（readerView，默认）——连版本状态一起清掉：块元素马上 detach，
	 *    留着只会误导（切换写不进任何可见的正文），此时重开文章就是原文。
	 *  已写回正文的块保持替换后的内容，不做自动回滚。 */
	cancelTask(opts?: { keepRecord?: boolean }): void {
		this.abort?.abort();
		this.abort = null;
		this.containerEl.removeClass("is-running");
		if (this.run?.state === "running") {
			if (opts?.keepRecord) {
				this.run.state = "cancelled";
			} else {
				this.run = null;
				this.versions = null;
			}
			this.updateRunArea();
			return;
		}
		if (!opts?.keepRecord) {
			// 记录已经收尾（done/error）也要清：来源变了，正文里的版本条目已是死数据
			this.versions = null;
			this.syncVersionBar();
		}
	}

	/** 正文卡片被关掉（Esc / 点正文空白 / 换书）时由 readerView 调：**选区任务**的在飞请求
	 *  跟着 abort（它的结果只活在卡片里，卡片没了就没有展示位）；全文任务与正文里的版本
	 *  切换一律不动 —— 它写的是正文，跟卡片没有关系。 */
	abortSelectionTask(): void {
		if (!this.run || this.run.wroteBody) return;
		this.abort?.abort();
		this.abort = null;
		this.run = null;
		this.containerEl.removeClass("is-running");
		this.updateRunArea();
	}

	private detection(): ReturnType<typeof detectUnagent> {
		return detectUnagent(this.callbacks.app);
	}

	/** 官方工具的生效形态 = 官方默认 + 用户改动（toolOverrides）。 */
	private resolveOfficial(toolId: "translate" | "typography"): {
		id: "translate" | "typography"
		name: string
		icon: string
		description: string
		prompt: string
		scope: AiFunctionScope
		enabled: boolean
		overridden: boolean
	} {
		const base = OFFICIAL_TOOLS.find(t => t.id === toolId)!;
		const override = this.getSettings().toolOverrides[toolId];
		return {
			id: base.id,
			name: base.name,
			icon: base.icon,
			description: base.description,
			prompt: override?.prompt ?? base.defaultPrompt,
			scope: override?.scope ?? base.defaultScope,
			enabled: override?.enabled !== false,
			// 「已修改」标记只反映提示词/作用域偏离；单纯的停用由置灰态表达
			overridden: !!override && (override.prompt != null || override.scope != null),
		};
	}

	private render(): void {
		this.containerEl.empty();
		const head = this.containerEl.createDiv({ cls: "unreader-ai-head" });
		head.createDiv({ cls: "unreader-ai-title", text: "AI 助手" });
		const closeBtn = head.createDiv({ cls: "unreader-ai-close", attr: { "aria-label": "关闭" } });
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.close());

		const body = this.containerEl.createDiv({ cls: "unreader-ai-body" });

		// ① UNagent 状态行：实时检测 + 按状态给唯一下一步动作
		const detection = this.detection();
		const status = body.createDiv({ cls: "unreader-ai-status" });
		this.statusDotEl = status.createDiv({ cls: "unreader-ai-status-dot" });
		this.statusTextEl = status.createDiv({ cls: "unreader-ai-status-text" });
		this.statusActionBtn = status.createDiv({ cls: "unreader-ai-status-action", attr: { "aria-label": "下一步" } });
		this.renderStatus(detection);

		// ② 官方工具：固定两枚，点击即运行；铅笔进编辑器（查看/改提示词与作用域/重置）
		body.createDiv({ cls: "unreader-ai-section-title", text: "功能" });
		const official = body.createDiv({ cls: "unreader-ai-official" });
		for (const tool of OFFICIAL_TOOLS) {
			this.renderOfficialTool(official, tool.id);
		}

		// 目标语言（提示词里的 {目标语言} 占位在运行时替换）
		const langRow = body.createDiv({ cls: "unreader-ai-lang" });
		langRow.createDiv({ cls: "unreader-ai-lang-label", text: "翻译目标语言" });
		const select = langRow.createEl("select", { cls: "unreader-ai-lang-select" });
		const current = this.getSettings().targetLanguage;
		for (const lang of AI_LANGUAGES) {
			const option = select.createEl("option", { text: lang, attr: { value: lang } });
			if (lang === current) option.selected = true;
		}
		if (!AI_LANGUAGES.includes(current)) {
			const option = select.createEl("option", { text: current, attr: { value: current } });
			option.selected = true;
		}
		select.addEventListener("change", () => this.callbacks.onPatch({ targetLanguage: select.value }));

		// ③ 自定义工具：用户增删改，按钮形式
		const customHead = body.createDiv({ cls: "unreader-ai-custom-head" });
		customHead.createDiv({ cls: "unreader-ai-section-title", text: "自定义工具" });
		this.addBtn = customHead.createDiv({ cls: "unreader-ai-add", attr: { "aria-label": "添加工具" } });
		setIcon(this.addBtn, "plus");
		this.addBtn.addEventListener("click", () => this.openEditor({ kind: "custom-new", scope: "full", enabled: true }));
		this.customListEl = body.createDiv({ cls: "unreader-ai-custom-list" });
		this.renderCustomList();
		this.renderForm(body);

		// ④ 运行区：进度 / 结果 / 复制
		this.runEl = body.createDiv({ cls: "unreader-ai-run" });
		this.updateRunArea();
	}

	private renderStatus(detection: ReturnType<typeof detectUnagent>): void {
		this.statusDotEl.removeClass("is-ok", "is-bad");
		if (detection.available) {
			this.statusDotEl.addClass("is-ok");
			this.statusTextEl.setText(`UNagent 已连接 · ${detection.api?.describeModel() ?? "未知模型"}`);
			this.statusActionBtn.show();
			setIcon(this.statusActionBtn, "settings");
			this.statusActionBtn.onclick = () => this.openUnagentSettings();
			return;
		}
		this.statusDotEl.addClass("is-bad");
		const reason = detection.reason ?? "not-installed";
		this.statusTextEl.setText(unagentGuidance(reason));
		const appApi = this.callbacks.app as unknown as SettingAppApi;
		const installed = !!appApi.plugins?.manifests?.unagent;
		if (reason === "not-installed" && installed) {
			// 已安装但被禁用：齿轮变「启用」
			this.statusActionBtn.show();
			setIcon(this.statusActionBtn, "play");
			this.statusActionBtn.onclick = () => {
				const enabled = appApi.plugins?.enablePlugin?.("unagent");
				void enabled?.then(() => {
					new Notice("UNagent 已启用");
					this.render();
				}).catch(() => new Notice("启用失败：请到 设置 → 第三方插件 手动启用"));
			};
			return;
		}
		this.statusActionBtn.show();
		setIcon(this.statusActionBtn, "settings");
		this.statusActionBtn.onclick = () => this.openNextStep(reason);
	}

	/** 按检测状态给出唯一的设置页去向。 */
	private openNextStep(reason: string): void {
		const appApi = this.callbacks.app as unknown as SettingAppApi;
		const openTab = (tabId: string, fallback: string): void => {
			try {
				appApi?.setting?.open();
				appApi?.setting?.openTabById(tabId);
			} catch {
				new Notice(fallback);
			}
		};
		if (reason === "not-installed") openTab("community-plugins", "请到 设置 → 第三方插件 安装 UNagent");
		else if (reason === "no-method") openTab("community-plugins", "请到 设置 → 第三方插件 更新 UNagent");
		else openTab("unagent", "请到 设置 → UNagent 配置模型");
	}

	private openUnagentSettings(): void {
		this.openNextStep("not-configured");
	}

	private renderOfficialTool(parent: HTMLElement, toolId: "translate" | "typography"): void {
		const tool = this.resolveOfficial(toolId);
		const button = parent.createDiv({ cls: "unreader-ai-func-btn", attr: { "data-task": tool.id } });
		const iconEl = button.createDiv({ cls: "unreader-ai-func-icon" });
		setIcon(iconEl, tool.icon);
		const textWrap = button.createDiv({ cls: "unreader-ai-func-text" });
		textWrap.createDiv({ cls: "unreader-ai-func-label", text: tool.name });
		textWrap.createDiv({ cls: "unreader-ai-func-desc", text: tool.description });
		button.addEventListener("click", () => this.runTool({
			id: tool.id,
			name: tool.name,
			prompt: tool.prompt,
			scope: tool.scope,
			enabled: tool.enabled,
		}));
		// 编辑入口：点开查看/修改提示词与作用域（官方工具不可删除，可重置默认）
		const edit = button.createDiv({ cls: "unreader-ai-tool-edit", attr: { "aria-label": `编辑「${tool.name}」提示词` } });
		setIcon(edit, "pencil");
		edit.addEventListener("click", e => {
			e.stopPropagation();
			this.openEditor({ kind: "official", toolId: tool.id, scope: tool.scope, enabled: tool.enabled });
		});
		if (tool.overridden) {
			button.addClass("is-overridden");
		}
		if (!tool.enabled) {
			button.addClass("is-disabled");
		}
	}

	private renderCustomList(): void {
		this.customListEl.empty();
		const functions = this.getSettings().customFunctions;
		if (!functions.length) {
			this.customListEl.createDiv({ cls: "unreader-ai-custom-empty", text: "还没有自定义工具，点右上角 + 添加" });
			return;
		}
		for (const fn of functions) {
			const enabled = fn.enabled !== false;
			const row = this.customListEl.createDiv({ cls: "unreader-ai-custom-row" });
			if (!enabled) row.addClass("is-disabled");
			const runBtn = row.createDiv({ cls: "unreader-ai-custom-run", attr: { title: fn.prompt.slice(0, 120) } });
			runBtn.setText(fn.name);
			runBtn.createSpan({
				cls: "unreader-ai-custom-scope",
				text: fn.scope === "selection" ? (enabled ? "选区" : "选区 · 已停用") : (enabled ? "全文" : "全文 · 已停用"),
			});
			runBtn.addEventListener("click", () => this.runTool({
				id: fn.id,
				name: fn.name,
				prompt: fn.prompt,
				scope: fn.scope,
				enabled,
			}));
			const edit = row.createDiv({ cls: "unreader-ai-custom-edit", attr: { "aria-label": `编辑 ${fn.name}` } });
			setIcon(edit, "pencil");
			edit.addEventListener("click", () => this.openEditor({
				kind: "custom-edit",
				fnId: fn.id,
				scope: fn.scope,
				enabled,
			}));
			const del = row.createDiv({ cls: "unreader-ai-custom-del", attr: { "aria-label": `删除 ${fn.name}` } });
			setIcon(del, "trash-2");
			del.addEventListener("click", () => {
				const rest = this.getSettings().customFunctions.filter(f => f.id !== fn.id);
				this.callbacks.onPatch({ customFunctions: rest });
				if (this.editor?.kind === "custom-edit" && this.editor.fnId === fn.id) this.editor = null;
				this.render();
			});
		}
	}

	/** 统一编辑器：官方工具（名称只读 + 重置默认）与自定义工具（新增/编辑）共用。 */
	private renderForm(parent: HTMLElement): void {
		this.formEl = parent.createDiv({ cls: "unreader-ai-form" });
		const editor = this.editor;
		if (!editor) {
			this.formEl.hide();
			this.formScopeEl = this.formEl.createDiv();
			this.formNameRow = this.formEl.createDiv();
			this.formNameEl = this.formEl.createEl("input");
			this.formPromptEl = this.formEl.createEl("textarea");
			this.formButtonsEl = this.formEl.createDiv();
			return;
		}
		this.formEl.show();
		this.formEl.addClass("is-visible");

		// 功能开关（两侧都有）：关掉后不运行、划词工具栏不出现
		const enabledRow = this.formEl.createDiv({ cls: "unreader-ai-form-switch" });
		const enabledBox = enabledRow.createEl("input", { attr: { type: "checkbox", id: "unreader-ai-tool-enabled" } });
		enabledBox.checked = editor.enabled;
		const enabledLabel = enabledRow.createEl("label", { text: "启用该工具", attr: { for: "unreader-ai-tool-enabled" } });
		enabledLabel.addEventListener("click", () => {
			enabledBox.checked = !enabledBox.checked;
			this.editor = { ...this.editor!, enabled: enabledBox.checked } as AiEditor;
		});
		enabledBox.addEventListener("change", () => {
			this.editor = { ...this.editor!, enabled: enabledBox.checked } as AiEditor;
		});

		// 作用域（两选一）
		this.formEl.createDiv({ cls: "unreader-ai-form-label", text: "作用方法" });
		this.formScopeEl = this.formEl.createDiv({ cls: "unreader-ai-form-scope" });
		this.renderScopeButtons();

		// 名称（官方工具名称固定，不开放修改）
		this.formNameRow = this.formEl.createDiv({ cls: "unreader-ai-form-label" });
		if (editor.kind === "official") {
			this.formNameRow.setText(`工具：${OFFICIAL_TOOLS.find(t => t.id === editor.toolId)?.name ?? ""}`);
		} else {
			this.formNameRow.setText("名称");
			this.formNameEl = this.formEl.createEl("input", {
				cls: "unreader-ai-form-input",
				attr: { type: "text", placeholder: "如：摘要要点", maxlength: "40" },
			});
		}

		// 提示词
		this.formEl.createDiv({ cls: "unreader-ai-form-label", text: "提示词（希望 AI 帮你做什么）" });
		this.formPromptEl = this.formEl.createEl("textarea", { cls: "unreader-ai-form-prompt", attr: { maxlength: editor.kind === "official" ? String(OFFICIAL_PROMPT_MAX) : String(CUSTOM_PROMPT_MAX) } });
		this.formEl.createDiv({
			cls: "unreader-ai-form-hint",
			text: `提示词里的 ${AI_LANGUAGE_TOKEN} 会在运行时替换为下方选择的目标语言；全文作用域的结果将替换正文，选中文字作用域的结果在面板展示。两类工具都会出现在划词工具栏的统一 AI 入口里（悬浮该入口列出全部工具名）。`,
		});

		// 按钮：重置默认（官方且有改动）+ 取消 + 保存
		this.formButtonsEl = this.formEl.createDiv({ cls: "unreader-ai-form-row" });
		if (editor.kind === "official") {
			const tool = this.resolveOfficial(editor.toolId);
			if (tool.overridden) {
				const resetBtn = this.formButtonsEl.createEl("button", { text: "重置默认" });
				resetBtn.addEventListener("click", () => this.resetOfficialTool(editor.toolId));
			}
		}
		const cancelBtn = this.formButtonsEl.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => {
			this.editor = null;
			this.render();
		});
		const saveBtn = this.formButtonsEl.createEl("button", { text: "保存", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => this.saveEditor());

		// 回填现值
		const fill = (prompt: string, name?: string): void => {
			this.formPromptEl.value = prompt;
			if (name != null && this.formNameEl) this.formNameEl.value = name;
		};
		if (editor.kind === "official") {
			const tool = this.resolveOfficial(editor.toolId);
			fill(tool.prompt);
		} else if (editor.kind === "custom-edit") {
			const fn = this.getSettings().customFunctions.find(f => f.id === editor.fnId);
			if (fn) fill(fn.prompt, fn.name);
		}
	}

	private renderScopeButtons(): void {
		this.formScopeEl.empty();
		if (!this.editor) return;
		const scopes: { key: AiFunctionScope; label: string }[] = [
			{ key: "full", label: "全文生效" },
			{ key: "selection", label: "选中文字触发" },
		];
		for (const scope of scopes) {
			const button = this.formScopeEl.createEl("button", {
				text: scope.label,
				cls: this.editor.scope === scope.key ? "is-active" : "",
			});
			button.addEventListener("click", () => {
				this.editor = { ...this.editor!, scope: scope.key } as AiEditor;
				this.renderScopeButtons();
			});
		}
	}

	private openEditor(editor: NonNullable<AiEditor>): void {
		this.editor = editor;
		this.render();
		if (this.formPromptEl) this.formPromptEl.focus();
	}

	private saveEditor(): void {
		const editor = this.editor;
		if (!editor) return;
		const prompt = this.formPromptEl.value.trim();
		if (!prompt) {
			new Notice("提示词不能为空");
			return;
		}
		if (editor.kind === "official") {
			if (prompt.length > OFFICIAL_PROMPT_MAX) {
				new Notice(`提示词过长（上限 ${OFFICIAL_PROMPT_MAX} 字符）`);
				return;
			}
			const overrides = { ...this.getSettings().toolOverrides };
			overrides[editor.toolId] = { prompt, scope: editor.scope, enabled: editor.enabled };
			this.callbacks.onPatch({ toolOverrides: overrides });
		} else if (editor.kind === "custom-new") {
			const name = this.formNameEl.value.trim();
			if (!name) {
				new Notice("名称不能为空");
				return;
			}
			const functions = this.getSettings().customFunctions;
			if (functions.length >= CUSTOM_LIMIT) {
				new Notice(`自定义工具最多 ${CUSTOM_LIMIT} 个`);
				return;
			}
			const fn: AiCustomFunction = {
				id: `fn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
				name,
				prompt: prompt.slice(0, CUSTOM_PROMPT_MAX),
				scope: editor.scope,
				enabled: editor.enabled,
			};
			this.callbacks.onPatch({ customFunctions: [...functions, fn] });
		} else {
			const name = this.formNameEl.value.trim();
			if (!name) {
				new Notice("名称不能为空");
				return;
			}
			const functions = this.getSettings().customFunctions.map(f => f.id === editor.fnId
				? {
					...f, name,
					prompt: prompt.slice(0, CUSTOM_PROMPT_MAX),
					scope: editor.scope,
					enabled: editor.enabled,
				}
				: f);
			this.callbacks.onPatch({ customFunctions: functions });
		}
		this.editor = null;
		this.render();
	}

	/** 官方工具重置：删掉对应 override 即回到代码里的官方默认提示词、作用域与启用态。 */
	private resetOfficialTool(toolId: "translate" | "typography"): void {
		const overrides = { ...this.getSettings().toolOverrides };
		delete overrides[toolId];
		this.callbacks.onPatch({ toolOverrides: overrides });
		if (this.editor?.kind === "official" && this.editor.toolId === toolId) {
			this.editor = { ...this.editor, scope: OFFICIAL_TOOLS.find(t => t.id === toolId)!.defaultScope, enabled: true };
		}
		this.render();
	}

	/** 点一下即运行：官方与自定义工具共用。提示词统一过 {目标语言} 占位替换。
	 *  `typography`：排版优化走「保结构」通道——原始空白提取 + 逐字守卫写回
	 *  （AI 只能动空白，改一个字就整块拒绝，链接/代码/序号原样保留）。
	 *  停用的工具不运行（来源入口已在 UI 置灰，这里兜底）。 */
	private runTool(tool: { id?: string; name: string; prompt: string; scope: AiFunctionScope; enabled?: boolean }, selectionText?: string): void {
		if (tool.enabled === false) {
			new Notice(`「${tool.name}」已停用：在 AI 面板里点铅笔重新启用`);
			return;
		}
		const effectivePrompt = applyLanguageToken(tool.prompt, this.getSettings().targetLanguage || "简体中文");
		const typography = tool.id === "typography";
		if (tool.scope === "selection") void this.startSelectionTask(tool.name, effectivePrompt, selectionText);
		else void this.startFullTask(tool.name, effectivePrompt, typography);
	}

	/** 划词工具栏「统一 AI 入口」的悬浮名单：**只列对选中文字可用的工具**
	 *  （生效作用域 = `selection`），每项只有名称 —— 2026-09-28 用户要求「没有图标，只有标题」，
	 *  随后又定口径：「ai 功能只展现选中文字后可以使用的工具，类似全文翻译、全文排版这些
	 *  不要展现」。官方两枚默认作用域都是 `full` → 默认不进名单；用户把某枚的作用域改成
	 *  「选中文字触发」后它才进来（官方与自定义一视同仁）。停用的工具不列。 */
	selectionToolEntries(): AiToolEntry[] {
		const entries: AiToolEntry[] = [];
		for (const official of OFFICIAL_TOOLS) {
			const tool = this.resolveOfficial(official.id);
			if (tool.enabled && tool.scope === "selection") entries.push({ id: tool.id, name: tool.name });
		}
		for (const fn of this.getSettings().customFunctions) {
			if (fn.enabled !== false && fn.scope === "selection") entries.push({ id: fn.id, name: fn.name });
		}
		return entries;
	}

	/** 划词工具栏入口按 id 触发：官方工具（translate / typography）与自定义工具共用一条路。
	 *  **刻意不打开面板**（2026-09-28 用户要求「使用功能的时候，侧边栏的 ai 功能面板不要出现」）：
	 *  选中文字的进度与结果落在**正文区的贴底结果卡片**（`callbacks.showResultCard`），
	 *  面板不是这条路的必需品；面板由功能轨那枚 AI 按钮自己开合。
	 *
	 *  `selectionText`：划词工具条/高亮气泡在**点击那一刻**捕获的选中文字。iPad 触摸点按
	 *  非输入元素会让活选区塌陷，等 startSelectionTask 再回头读 `getSelectionText()` 常拿到
	 *  空串 → 弹「先选中文字」。有传入就以它为准；缺省（面板内运行按钮）走旧的现取路径。 */
	runToolById(id: string, selectionText?: string): void {
		const official = OFFICIAL_TOOLS.find(t => t.id === id);
		if (official) {
			const tool = this.resolveOfficial(official.id);
			this.runTool({ id: tool.id, name: tool.name, prompt: tool.prompt, scope: tool.scope, enabled: tool.enabled }, selectionText);
			return;
		}
		const fn = this.getSettings().customFunctions.find(f => f.id === id);
		if (!fn) return;
		this.runTool({ id: fn.id, name: fn.name, prompt: fn.prompt, scope: fn.scope, enabled: fn.enabled !== false }, selectionText);
	}

	/** 全文类任务：从当前渲染帧提取正文块 → 受控并发 → 逐块写回正文。 */
	private async startFullTask(title: string, system: string, typography = false): Promise<void> {
		const api = this.requireApi();
		if (!api) return;
		const source = this.callbacks.getFullTextRoot();
		if (!source) {
			new Notice("先打开一本书或文章，再运行 AI 工具");
			return;
		}
		const extracted = extractBlockElements(source.root, { rawWhitespace: typography });
		if (!extracted.length) {
			new Notice("没有可提取的正文");
			return;
		}
		this.abort?.abort();
		const controller = new AbortController();
		this.abort = controller;
		// 排版组规划（v2）：相邻纯文本 p 结组走「跨块重组 + markdown 美化」通道，其余块
		// 留在逐块空白通道。变量名保持 blocks：原文快照必须紧邻块提取、先于任何写回
		// （runner 源码不变量钉住这一顺序）。
		const blocks = typography && !this.chunkDisabled ? planTypographyUnits(extracted) : extracted;
		// 逐块快照要在**任何写回之前**拍完：写回会就地改掉块元素里的文本（组通道则是
		// 隐藏原块、注入兄弟节点），快照是之后在正文里「原文 / AI 版本」来回切的唯一
		// 数据源。按块对象做键（并发完成顺序打乱也不影响对应关系）。
		const records = this.originalDisabled ? undefined : blocks.map(block => this.snapshotBlock(block));
		const recordOf = new Map<AiBlock, AiRunBlock>();
		blocks.forEach((block, index) => {
			const record = records?.[index];
			if (record) recordOf.set(block, record);
		});
		// 新的全文任务顶掉上一轮的正文版本条目：正文现在的内容就是本轮改的
		// （第二轮工具的「原文」= 第一轮工具的结果，这是正文的真实状态）
		this.versions = records
			? { title: `${title} · ${source.title}`, blocks: records, version: "ai", dismissed: false }
			: null;
		this.run = { title: `${title} · ${source.title}`, state: "running", done: 0, total: blocks.length, wroteBody: true };
		this.containerEl.addClass("is-running");
		this.updateRunArea();
		try {
			await runAiTaskOnBlocks(api, blocks, {
				system,
				// 按单元定制 system：翻译的结构块追加「分段标记」指令（链接等内联元素
				// 靠它保住）；排版的组块/落单块各追加一套与写回守卫能力严格一致的指令。
				perUnitSystem: typography
					? unit => system + (unit.chunkEls?.length ? TYPOGRAPHY_CHUNK_INSTRUCTION : TYPOGRAPHY_BLOCK_INSTRUCTION)
					: unit => (unit.structured ? system + SEGMENTED_TRANSLATION_INSTRUCTION : system),
				signal: controller.signal,
				// 三条写回路径都包上「高亮范围重锚」（writeBlock 由 readerView 提供）：
				// 排版逐块走逐字守卫、排版组走「注入 + 隐藏」、翻译的纯文本块走整体替换、
				// 翻译的结构块走分段写回；守卫拒绝（返回 false = 保留原文）时不重锚。
				// 切换版本走的是同一条路（switchVersion）。
				writeBack: (block, value) => {
					const write = (): boolean => {
						if (typography) {
							return block.chunkEls?.length
								? applyTypographyChunkWriteBack(block, value)
								: applyTypographyWriteBack(block, value);
						}
						if (block.structured && !this.flattenDisabled) return applyTranslationWriteBack(block, value);
						block.el.textContent = value;
						return true;
					};
					const ok = source.writeBlock ? source.writeBlock(block, write) : write();
					// 处置结果进快照：只有真的写进过正文的块才参与版本切换
					// （排版优化被逐字守卫拒绝的块保持原文，切哪个版本都不动它）
					const record = recordOf.get(block);
					if (record) {
						record.result = value;
						record.applied = ok;
					}
					return ok;
				},
				onProgress: progress => {
					if (controller.signal.aborted || !this.run) return;
					this.run.done = progress.done;
					this.run.total = progress.total;
					this.updateRunArea();
					// 每块写回后通知宿主重算帧高（notifyVisible 内部有节流）
					source.onApplied();
				},
			});
			if (controller.signal.aborted || !this.run) return;
			this.run.state = "done";
			this.updateRunArea();
			source.onApplied();
		} catch (error) {
			if (controller.signal.aborted || !this.run) return;
			this.run.state = "error";
			this.run.error = error instanceof Error ? error.message : String(error);
			this.updateRunArea();
		} finally {
			if (this.abort === controller) this.abort = null;
			if (this.run?.state !== "running") this.containerEl.removeClass("is-running");
		}
	}

	/** 「选中文字」作用域：取当前选区单次调用，结果只在面板展示（不动正文）。
	 *  `injectedText` 来自划词工具条/高亮气泡点击瞬间捕获的文字（iPad 触摸点按后活选区
	 *  会塌陷，不能再靠 getSelectionText 现取）；非空时以它为准，空则回退现取活选区。 */
	private async startSelectionTask(title: string, system: string, injectedText?: string): Promise<void> {
		const api = this.requireApi();
		if (!api) return;
		const injected = injectedText?.trim();
		const live = this.callbacks.getSelectionText()?.trim();
		const selection = injected && injected.length ? injected : (live ?? "");
		if (!selection) {
			new Notice("先在书内选中文字，再运行该工具");
			return;
		}
		this.abort?.abort();
		const controller = new AbortController();
		this.abort = controller;
		// 结果落**正文区的贴底卡片**（宿主提供，与划词翻译同一张）：面板不再展示 AI 输出内容。
		// 卡片里的「重试」= 重跑这一次工具（重跑要再花一次 token，所以默认不给，见 showResultCard）。
		const card = this.callbacks.showResultCard?.({
			title,
			sourceText: selection,
			modelLabel: api.describeModel(),
			// 重试沿用本次已锁定的文本（活选区此刻早已塌陷），不能再走现取
			onRetry: () => void this.startSelectionTask(title, system, selection),
		}) ?? null;
		// 选区任务不动正文：版本状态（上一轮全文任务的）原样留着
		this.run = { title: `${title} · 选中文字`, state: "running", done: 0, total: 1, wroteBody: false };
		this.containerEl.addClass("is-running");
		this.updateRunArea();
		try {
			const result = await api.complete({
				system,
				user: selection,
				signal: controller.signal,
				onChunk: delta => {
					if (!controller.signal.aborted) card?.chunk(delta);
				},
			});
			if (controller.signal.aborted || !this.run) return;
			this.run.state = "done";
			this.updateRunArea();
			card?.finish(result.text);
		} catch (error) {
			if (controller.signal.aborted || !this.run) return;
			this.run.state = "error";
			this.run.error = error instanceof Error ? error.message : String(error);
			this.updateRunArea();
			card?.fail(this.run.error);
		} finally {
			if (this.abort === controller) this.abort = null;
			if (this.run?.state !== "running") this.containerEl.removeClass("is-running");
		}
	}

	/** 检测 + 取 api；不可用三态直接给指引，不静默。 */
	private requireApi(): UnagentAIApi | null {
		const detection = this.detection();
		if (detection.available && detection.api) return detection.api;
		new Notice(unagentGuidance(detection.reason ?? "not-installed"));
		return null;
	}

	/** 运行区：进度 / 状态 / 取消 / 「在正文中切换版本」。
	 *  **不放 AI 输出内容**（2026-09-28 用户要求）：正文工具的结果就在正文里，版本切换
	 *  也在正文里（版本条），面板只报进度与状态。每次进度回调整块重绘，状态全从
	 *  `this.run` 现取，DOM 上不留状态。 */
	private updateRunArea(): void {
		if (!this.runEl) return;
		const run = this.run;
		this.runEl.empty();
		if (!run || run.state === "idle") {
			this.runEl.hide();
			this.progressBarEl = null;
			this.syncVersionBar();
			return;
		}
		this.runEl.show();
		const head = this.runEl.createDiv({ cls: "unreader-ai-run-head" });
		head.createDiv({ cls: "unreader-ai-run-title", text: run.title });
		if (run.state === "running") {
			head.createDiv({ cls: "unreader-ai-run-progress", text: `${run.done}/${run.total} 段` });
			const cancelBtn = head.createEl("button", { text: "取消" });
			// 取消**保留**正文版本状态：已替换的段落仍能在正文里切回原文
			cancelBtn.addEventListener("click", () => this.cancelTask({ keepRecord: true }));
			const bar = this.runEl.createDiv({ cls: "unreader-ai-run-bar" });
			this.progressBarEl = bar.createDiv({ cls: "unreader-ai-run-bar-fill" });
			const ratio = run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
			this.progressBarEl.style.width = `${ratio}%`;
		} else {
			this.runEl.createDiv({ cls: `unreader-ai-run-status${run.state === "error" ? " is-error" : ""}`, text: this.statusText(run) });
			// 版本入口跟着**正文版本状态**走（不是当前这次运行）：跑完一轮全文工具后又跑选区
			// 工具，上一轮的正文版本仍要能切。按钮是开合：条被收起时把它唤回来。
			// 形态取 `dismissed`（状态）而不是 versionBar.visible —— syncVersionBar 在本次重绘
			// 末尾才跑，读实时可见性会让文案慢一拍。
			if (this.appliedCount() > 0) {
				const barShown = !!this.versions && !this.versions.dismissed;
				this.runEl.createEl("button", { text: barShown ? "收起版本切换" : "在正文中切换版本", cls: "unreader-ai-version-btn" })
					.addEventListener("click", () => {
						if (!this.versions) return;
						this.versions.dismissed = barShown;
						this.updateRunArea();
					});
			}
		}
		this.syncVersionBar();
	}

	/** 非运行态的状态行文案（面板里唯一的「结果」表述 —— 只有事实，没有内容）。 */
	private statusText(run: AiRun): string {
		if (run.state === "error") return run.error || "任务失败";
		if (run.state === "cancelled") return `已取消 · ${run.done}/${run.total} 段`;
		if (!run.wroteBody) return "结果已显示在正文卡片里";
		const applied = this.appliedCount();
		return applied > 0 ? `已替换正文 ${applied} 段` : "没有可替换的正文";
	}

	/** 已真的写进过正文的块数（= 能参与版本切换的段落）。 */
	private appliedCount(): number {
		return (this.versions?.blocks ?? []).filter(block => block.applied).length;
	}

	/** 把正文版本状态推到正文区底部的切换条：有已替换的段落、不在运行中、没被用户收起
	 *  （阴性对照档没有快照 → 一律不出现）。幂等，进度回调里反复调也不会让条跳动。 */
	private syncVersionBar(): void {
		const versions = this.versions;
		const show = !!versions && !versions.dismissed && this.run?.state !== "running"
			&& versions.blocks.some(block => block.applied);
		if (!show) {
			this.versionBar.hide();
			return;
		}
		this.versionBar.show({ title: versions.title, version: versions.version });
	}

	/** 提取后立刻给块拍快照（**写回之前**）。排版路径同时记下逐节点原文（`textNodes[].value`
	 *  是取值时的原文，写回只改 node.nodeValue，不会改它），版本来回切都据此保结构；
	 *  排版组通道的原文 = 组内合并文本（写回不动原块 DOM，快照只作记录与判 detached）。 */
	private snapshotBlock(block: AiBlock): AiRunBlock {
		if (block.chunkEls?.length) {
			return { block, chunk: { els: block.chunkEls }, original: block.text.trim(), result: null, applied: false };
		}
		const original = block.textNodes?.length
			? block.textNodes.map(node => node.value).join("")
			: (block.el.textContent ?? block.text);
		return { block, original: original.trim(), result: null, applied: false };
	}

	/** 在正文里切换正在显示的版本（`original` / `ai`）：逐块写回那一版的文本。
	 *  必须走宿主的 writeBlock（= 引擎的写回重锚通道）—— 与正向写回同一条路，落在块内的
	 *  高亮范围跟着新文本重锚，来回切不会留下指向旧版文本的范围。
	 *  两个版本的文本都是**不可变快照**，所以想切几次切几次、内容不会丢也不会串。
	 *  块已不在当前视图（换章/被卸载/已重开）时跳过；那时重开文章就是原文。 */
	switchVersion(version: AiVersion): void {
		const versions = this.versions;
		if (!versions || this.run?.state === "running") return;
		if (versions.version === version) return;
		const source = this.callbacks.getFullTextRoot();
		if (!source) {
			new Notice("正文已不在当前视图：重开文章或换章即回原文");
			return;
		}
		let written = 0;
		let detached = 0;
		let failed = 0;
		for (const record of versions.blocks) {
			if (!record.applied || !record.block) continue;
			// 排版组通道：切换 = 增删注入节点 + 原块显隐（原块 DOM 一字不动，零重锚）
			if (record.chunk) {
				const anchor = record.chunk.els[0];
				if (!anchor || !anchor.isConnected) {
					detached += 1;
					continue;
				}
				const write = (): boolean => version === "original"
					? restoreTypographyChunk(record.block!)
					: applyTypographyChunkWriteBack(record.block!, record.result ?? "");
				const ok = source.writeBlock ? source.writeBlock(record.block, write) : write();
				if (ok) written += 1;
				else failed += 1;
				continue;
			}
			const text = version === "original" ? record.original : record.result;
			if (text == null) continue;
			if (!record.block.el.isConnected) {
				detached += 1;
				continue;
			}
			const write = (): boolean => this.writeBlockText(record, text);
			const ok = source.writeBlock ? source.writeBlock(record.block, write) : write();
			if (ok) written += 1;
			else failed += 1;
		}
		// 帧高随正文变化 → 通知宿主重算；切换成功才记状态（全 detached 时保持原版本）
		source.onApplied();
		if (written > 0) versions.version = version;
		this.updateRunArea();
		const parts: string[] = [];
		if (!written) parts.push("没有可切换的段落");
		if (detached) parts.push(`${detached} 段已不在当前视图，重开文章即回原文`);
		if (failed) parts.push(`${failed} 段切换失败`);
		if (parts.length) new Notice(parts.join("；"));
	}

	/** 一块的文本写回。排版路径**两个方向都保结构**：转 AI = 逐字守卫按节点分发空白
	 *  （与正向写回同一个函数），回原文 = 逐节点还原原值（一字不差，含首尾空白）；
	 *  翻译路径：纯文本块整体替换（无结构可保）；结构块 = 分段写回（转 AI 按编号分发
	 *  到文本节点、回原文逐节点还原，链接/强调/图片全程不丢）。 */
	private writeBlockText(record: AiRunBlock, text: string): boolean {
		const block = record.block;
		if (!block) return false;
		if (block.textNodes?.length) {
			if (text === record.original) {
				for (const node of block.textNodes) node.node.nodeValue = node.value;
				return true;
			}
			if (block.structured) return applyTranslationWriteBack(block, text);
			return applyTypographyWriteBack(block, text);
		}
		block.el.textContent = text;
		return true;
	}
}
