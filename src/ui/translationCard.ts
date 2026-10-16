import { setIcon } from "obsidian";
import { placeFloating, type Bounds } from "./floatingPlacement";

export interface TranslationCardActions {
	onCopy: (text: string) => void
	onClose: () => void
}

/** 每次 show 的形态：标题/按钮文案/重试回调都随这一次调用走 —— 本卡片现在同时承载
 *  两件事：划词翻译（标题「译文」+ 重试同一次翻译）与 AI 面板「选中文字」类工具的结果
 *  （标题 = 工具名、复制 = 复制结果、**不给重试**：重跑要再花一次 token，由用户自己再点
 *  工具）。`retry` 传 null/缺省 = 这一次没有重试入口（按钮由 `.is-no-retry` 收走）。 */
export interface TranslationShowOptions {
	sourceText: string
	modelLabel: string
	title?: string
	copyLabel?: string
	loadingText?: string
	retry?: (() => void) | null
	/** 结果按 markdown 渲染（AI 工具输出用；划词翻译保持纯文本，免得把译文里的
	 *  `*` / `#` 当语法吃掉）。渲染器由宿主注入（见 setMarkdownRenderer）。 */
	renderMarkdown?: boolean
}

type TranslationState = "hidden" | "loading" | "streaming" | "done" | "error";

/** 选中文字后的译文卡片（M2）：与评论弹框同族的贴底卡片，不用 Obsidian Modal
 *  （modalFocusGate 是已知雷区，且模态打断阅读）。本组件只管展示与状态，请求由
 *  readerView 驱动：show() → appendChunk()×N → finish()/fail()；关闭一律走 hide()
 *  （readerView 的 hideTranslation 据此 abort 在飞请求）。
 *
 *  定位与 SelectionToolbar 同一份口径：placeFloating fixed 贴底 + bounds 现测供体
 *  （stageBoundsNow，已裁键盘与键盘上方原生栏）。无输入框 → 不拉键盘，但极窄可用区
 *  （手机横屏/分屏）仍走 is-tight 档：先让原文引用行退场，保住按钮行 —— 与
 *  fitCommentHeight 同形但独立实现（只读输出没有输入框 min/max-height 那一对）。 */
export class TranslationCard {
	readonly containerEl: HTMLElement;
	private readonly actions: TranslationCardActions;
	private titleEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private quoteEl!: HTMLElement;
	private modelEl!: HTMLElement;
	private copyBtn!: HTMLButtonElement;
	private retryBtn!: HTMLButtonElement;
	private state: TranslationState = "hidden";
	private resultText = "";
	private retry: (() => void) | null = null;
	private boundsResolver: (() => Bounds) | null = null;
	private repositionScheduled = false;
	/** 本次 show 是否按 markdown 渲染结果（AI 工具输出 true，划词翻译 false）。 */
	private renderMarkdown = false;
	/** 宿主注入的 markdown 渲染器（app / Component / sourcePath 都在宿主那层，
	 *  卡片本身只 import setIcon，不碰 Obsidian 渲染管线）。返回 Promise 时会在
	 *  渲染完成后重排一次（渲染是异步的，卡片高度届时才最终确定）。 */
	private markdownRenderer: ((el: HTMLElement, markdown: string) => void | Promise<void>) | null = null;
	/** 流式期间的重排节流：每帧重排会把 class/几何写爆（半透明窗口下就是成片闪烁）
	 *  —— 卡片底边固定、内容向上长，70ms 一次足够跟手。 */
	private lastRepositionAt = 0;
	private static readonly STREAM_REPOSITION_MS = 70;
	/** 阴性对照接缝（`?legacy-no-stream=1`）：appendChunk 变 no-op，G2 的「流式增量」
	 *  断言必须变红 —— 证明 DOM 增量断言有辨别力（先例 = engineAdapter 的 hllegacy 档）。 */
	private readonly streamDisabled = new URLSearchParams(window.location.search).has("legacy-no-stream");

	constructor(actions: TranslationCardActions) {
		this.actions = actions;
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-translate-card";
		this.containerEl.dataset.state = "hidden";
		this.render();
		this.containerEl.addEventListener("pointerdown", e => e.stopPropagation());
	}

	setBoundsResolver(fn: () => Bounds): void {
		this.boundsResolver = fn;
	}

	/** 宿主注入 markdown 渲染器（真机 = `MarkdownRenderer.render(app, md, el, path, component)`）。
	 *  注入后由 `show({ renderMarkdown: true })` 决定这一次是否使用。 */
	setMarkdownRenderer(fn: (el: HTMLElement, markdown: string) => void | Promise<void>): void {
		this.markdownRenderer = fn;
	}

	private render(): void {
		const head = this.containerEl.createDiv({ cls: "unreader-comment-head" });
		this.titleEl = head.createDiv({ cls: "unreader-comment-title", text: "译文" });
		this.modelEl = head.createDiv({ cls: "unreader-translate-model" });
		const closeBtn = head.createDiv({ cls: "unreader-comment-close", attr: { "aria-label": "关闭译文" } });
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onClose();
		});
		// 原文引用行：与评论弹框的「别写错地方」锚点同一行样式（两行截断 + 强调色竖条）
		this.quoteEl = this.containerEl.createDiv({ cls: "unreader-comment-quote" });
		this.bodyEl = this.containerEl.createDiv({ cls: "unreader-translate-body" });
		const row = this.containerEl.createDiv({ cls: "unreader-hl-pop-comment-row" });
		this.retryBtn = row.createEl("button", { text: "重试", cls: "unreader-translate-retry" });
		this.retryBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.retry?.();
		});
		this.copyBtn = row.createEl("button", { text: "复制译文", cls: "unreader-translate-copy mod-cta" });
		this.copyBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.actions.onCopy(this.resultText);
		});
	}

	/** 打开/重开卡片：重置为 loading 态并按当前 bounds 落位。 */
	show(options: TranslationShowOptions): void {
		this.state = "loading";
		this.resultText = "";
		this.retry = options.retry ?? null;
		this.renderMarkdown = options.renderMarkdown === true;
		this.lastRepositionAt = 0;
		this.containerEl.dataset.state = "loading";
		this.containerEl.toggleClass("is-no-retry", !this.retry);
		this.titleEl.setText(options.title ?? "译文");
		this.modelEl.setText(options.modelLabel);
		this.quoteEl.setText(options.sourceText);
		this.copyBtn.setText(options.copyLabel ?? "复制译文");
		this.bodyEl.setText(options.loadingText ?? "正在翻译…");
		this.bodyEl.removeClass("is-error");
		// 渲染档的版面类由卡片自己管（`.markdown-rendered` = 官方排版 + 收口空白，见 styles.css）：
		// 宿主注入的渲染器只管往里填内容，纯文本档必须摘掉它（否则 pre-wrap 被关掉、换行丢失）。
		this.bodyEl.toggleClass("markdown-rendered", this.renderMarkdown);
		this.reposition();
	}

	/** 流式追加一段。首段到达时把「正在翻译…」占位替换掉。 */
	appendChunk(delta: string): void {
		if (this.streamDisabled || !delta) return;
		if (this.state !== "loading" && this.state !== "streaming") return;
		if (this.state === "loading") {
			this.state = "streaming";
			this.containerEl.dataset.state = "streaming";
			this.bodyEl.setText("");
		}
		this.bodyEl.appendText(delta);
		this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
		this.scheduleReposition();
	}

	/** 完成：以完整结果为准覆盖流式内容（底层拼接可能有微小差异）。
	 *  `renderMarkdown` 档（AI 工具输出）在这里把结果按 **markdown** 渲染 —— 流式期间
	 *  仍是纯文本快追加（每帧重渲 markdown 又慢又跳），完成后一次成渲染。 */
	finish(text: string): void {
		this.resultText = text || "(模型没有返回内容)";
		this.state = "done";
		this.containerEl.dataset.state = "done";
		this.bodyEl.setText(this.resultText);
		this.bodyEl.removeClass("is-error");
		this.bodyEl.scrollTop = 0;
		this.reposition();
		if (!this.renderMarkdown || !this.markdownRenderer) return;
		const body = this.bodyEl;
		const md = this.resultText;
		// 渲染是异步的：期间用户可能关掉卡片或重开（state 变了就不要回写 DOM）。
		Promise.resolve(this.markdownRenderer(body, md)).then(() => {
			if (this.state !== "done" || this.bodyEl !== body) return;
			this.reposition();
		}).catch(() => undefined);
	}

	/** 失败：展示 friendlyMessage；重试按钮由 data-state 驱动显隐。 */
	fail(message: string): void {
		this.state = "error";
		this.containerEl.dataset.state = "error";
		this.bodyEl.setText(message || "翻译失败");
		this.bodyEl.addClass("is-error");
		this.reposition();
	}

	/** 幂等：relocate/滚动等高频路径可能反复调用，已经收干净时一个副作用都不做。 */
	hide(): void {
		if (this.state === "hidden" && !this.containerEl.hasClass("is-visible")) return;
		this.state = "hidden";
		this.containerEl.dataset.state = "hidden";
		this.resultText = "";
		// 每次 show 带来的形态全部复位：下一张卡片不会继承上一张的标题/按钮文案/重试
		this.retry = null;
		this.titleEl.setText("译文");
		this.copyBtn.setText("复制译文");
		this.quoteEl.setText("");
		this.bodyEl.setText("");
		this.bodyEl.removeClass("is-error");
		this.bodyEl.removeClass("markdown-rendered");
		this.bodyEl.style.removeProperty("max-height");
		this.containerEl.removeClass("is-tight", "is-visible", "is-no-retry");
	}

	get visible(): boolean {
		return this.containerEl.hasClass("is-visible");
	}

	/** 流式期间的重排调度：**按时间节流**（`STREAM_REPOSITION_MS`）而不是逐帧。
	 *  卡片底边固定、内容向上长，70ms 一次已经跟手；逐帧重排会每帧量一次布局、
	 *  每帧写一次 class/几何 —— 半透明窗口（Obsidian translucency）下合成器会
	 *  反复重建图层，用户看到的就是「窗口不断闪烁」（2026-09-28 报障）。 */
	private scheduleReposition(): void {
		if (this.repositionScheduled) return;
		const wait = Math.max(0, TranslationCard.STREAM_REPOSITION_MS - (performance.now() - this.lastRepositionAt));
		this.repositionScheduled = true;
		window.setTimeout(() => {
			this.repositionScheduled = false;
			if (this.state !== "loading" && this.state !== "streaming") return;
			this.reposition();
		}, wait);
	}

	private reposition(): void {
		const bounds = this.boundsResolver?.() ?? { width: window.innerWidth, height: window.innerHeight };
		this.lastRepositionAt = performance.now();
		// 「隐藏测量」只在**首次落位**用：卡片还没摆到正确位置，先量后显可避免闪一下。
		// 流式期间每帧都会重排，若每帧 hide→show，卡片会逐帧闪烁（2026-09-28 报障的
		// 「窗口不断闪烁」）；已经摆好位置后再量就无需隐藏。
		const firstPlacement = !this.containerEl.hasClass("is-visible");
		if (firstPlacement) this.containerEl.addClass("is-measuring");
		this.containerEl.addClass("is-visible");
		void this.containerEl.offsetHeight;
		// 先按可用高度定档（is-tight 会摘掉引用行、收一档 padding，本身改布局），
		// 再量固定开销压译文区上限，压完重读一次总高供 placeFloating 用。
		const usable = bounds.height - 16;
		this.containerEl.toggleClass("is-tight", usable < 240);
		void this.containerEl.offsetHeight;
		const chrome = this.containerEl.offsetHeight - this.bodyEl.offsetHeight;
		this.bodyEl.style.maxHeight = `${Math.max(48, Math.min(260, usable - chrome))}px`;
		void this.containerEl.offsetHeight;
		const tw = this.containerEl.offsetWidth || 320;
		const th = this.containerEl.offsetHeight || 120;
		this.containerEl.removeClass("is-measuring");
		const placement = placeFloating(null, { width: tw, height: th }, bounds, { margin: 8, gap: 8, vertical: "bottom" });
		this.containerEl.style.left = `${placement.left}px`;
		this.containerEl.style.top = `${placement.top}px`;
		this.containerEl.style.transformOrigin = placement.origin;
	}
}
