import { setIcon } from "obsidian";
import { placeFloating, type Bounds } from "./floatingPlacement";

/** 正文里正在显示的那一版：`original` = AI 动手前的原文，`ai` = 本次 AI 结果。 */
export type AiVersion = "original" | "ai";

export interface VersionBarCallbacks {
	/** 用户点了另一版：调用方负责把正文写回那一版（走宿主 writeBlock），再 update 回状态 */
	onSwitch: (version: AiVersion) => void
	/** 收起切换条（正文保留当前这一版）。之后可用 AIPanel 里的入口再唤出 */
	onClose: () => void
}

export interface VersionBarOptions {
	/** 左侧标题：本次运行是谁（如「全文翻译 · 第一章」）。窄档会被收走 */
	title: string
	version: AiVersion
}

const LABELS: Record<AiVersion, string> = { original: "原文", ai: "AI 版本" };

/** 正文区底部的**版本切换条**（2026-09-28 用户要求「不同版本的切换要在正文里面显示」）：
 *  AI 全文工具就地改写了正文，用户是在**正文里读**的，版本切换就该在正文里 —— 面板
 *  只留进度与状态，不再展示 AI 输出内容。
 *
 *  形态：贴正文区底部居中的一条胶囊（标题 + 「原文 / AI 版本」分段 + 关闭），与译文卡片
 *  同一套定位口径（placeFloating fixed + bounds 现测供体 stageBoundsNow：已裁键盘与键盘
 *  上方原生栏）。本组件**只管展示**：切换动作由 AIPanel 执行（逐块写回 + 高亮重锚），
 *  执行完再 update 选中态 —— 组件不持有版本数据，避免两处状态。
 *
 *  生命周期：换书/换章/视图关闭由 AIPanel 的 cancelTask 收走（记录清了就 hide）；
 *  点正文空白 / 滚动**不收**（它是「我现在读的是哪一版」的指示器，不是弹出层）；
 *  真正的出口是关闭键与宿主来源变化。 */
export class VersionBar {
	readonly containerEl: HTMLElement;
	private readonly callbacks: VersionBarCallbacks;
	private titleEl!: HTMLElement;
	private segEl!: HTMLElement;
	private readonly buttons = new Map<AiVersion, HTMLButtonElement>();
	private boundsResolver: (() => Bounds) | null = null;

	constructor(callbacks: VersionBarCallbacks) {
		this.callbacks = callbacks;
		this.containerEl = createDiv();
		this.containerEl.className = "unreader-version-bar";
		this.render();
		this.containerEl.addEventListener("pointerdown", e => e.stopPropagation());
	}

	setBoundsResolver(fn: () => Bounds): void {
		this.boundsResolver = fn;
	}

	private render(): void {
		this.titleEl = this.containerEl.createDiv({ cls: "unreader-version-title" });
		this.segEl = this.containerEl.createDiv({ cls: "unreader-version-seg" });
		for (const version of ["original", "ai"] as const) {
			const button = this.segEl.createEl("button", {
				cls: "unreader-version-btn",
				text: LABELS[version],
				attr: {
					title: version === "original" ? "已替换的段落显示原文" : "已替换的段落显示 AI 版本",
					"data-version": version,
				},
			});
			button.addEventListener("click", () => this.callbacks.onSwitch(version));
			this.buttons.set(version, button);
		}
		const closeBtn = this.containerEl.createDiv({ cls: "unreader-version-close", attr: { "aria-label": "关闭版本切换" } });
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.callbacks.onClose();
		});
	}

	/** 显示（已显示则只更新内容，不重排：切换时重复调用不该让条跳动）。 */
	show(options: VersionBarOptions): void {
		this.update(options);
		if (this.visible) return;
		this.containerEl.addClass("is-visible");
		this.reposition();
	}

	/** 选中态 / 标题更新（切换完成后由调用方回填）。 */
	update(options: VersionBarOptions): void {
		this.titleEl.setText(options.title);
		for (const [version, button] of this.buttons) {
			const active = version === options.version;
			button.toggleClass("is-active", active);
			button.setAttribute("aria-pressed", active ? "true" : "false");
		}
	}

	/** 幂等：来源变化等高频路径可能反复调用，已经收干净时一个副作用都不做。 */
	hide(): void {
		if (!this.visible) return;
		this.containerEl.removeClass("is-visible", "is-tight", "is-measuring");
	}

	get visible(): boolean {
		return this.containerEl.hasClass("is-visible");
	}

	/** 贴正文区底部居中（与译文卡片同一份几何口径）。 */
	private reposition(): void {
		const bounds = this.boundsResolver?.() ?? { width: window.innerWidth, height: window.innerHeight };
		this.containerEl.addClass("is-measuring");
		void this.containerEl.offsetHeight;
		// 窄档收标题（保住分段控件与关闭键）——判据与译文卡片的 is-tight 同形但阈值独立：
		// 这条本身只有一行高，250px 就只装得下分段
		this.containerEl.toggleClass("is-tight", bounds.width < 250);
		void this.containerEl.offsetHeight;
		const width = this.containerEl.offsetWidth || 240;
		const height = this.containerEl.offsetHeight || 36;
		this.containerEl.removeClass("is-measuring");
		const placement = placeFloating(null, { width, height }, bounds, { margin: 8, gap: 8, vertical: "bottom" });
		this.containerEl.style.left = `${placement.left}px`;
		this.containerEl.style.top = `${placement.top}px`;
		this.containerEl.style.transformOrigin = placement.origin;
	}
}
