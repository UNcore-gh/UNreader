import { setIcon } from "obsidian";
import { HIGHLIGHT_COLORS, highlightColorOf } from "../types";
import * as debugLog from "../core/debugLog";
import { placeFloating, type Bounds } from "./floatingPlacement";
import { subscribeKeyboardGeometry } from "./keyboardInset";

export interface SelectionSnapshot {
	doc: Document
	text: string
}

export interface SelectionActions {
	onCopy: (text: string) => void
	onHighlight: (colorName: string) => void
	onComment: (text: string, comment: string, colorName: string) => void
}

/**
 * 选中文字后的浮动工具条：与 HighlightPopover 保持一致的工具条形态与定位。
 * 坐标为 body 本地坐标（readerView 已做宿主原点校正），通过 placeFloating 统一处理多边界场景。
 */
export class SelectionToolbar {
	readonly containerEl: HTMLElement;
	private actions: SelectionActions;
	private snapshot: SelectionSnapshot | null = null;
	private barRow!: HTMLElement;
	private commentWrap!: HTMLElement;
	private commentInput!: HTMLTextAreaElement;
	private pickedColor = "yellow";
	private lastAnchorRect: DOMRect | null = null;
	private lastBounds: Bounds | null = null;
	/** 固定模式：工具条固定在正文区底部居中，不跟随选区（规避系统选区菜单同位置冲突） */
	private fixed = false;
	/** 评论编辑区是否展开（只有展开时才需要「贴键盘」重排与高度压缩） */
	private commentOpen = false;
	/** bounds 现测供体（readerView 注入）：键盘弹起后容器被官方收缩，
	 *  必须按**当前**几何重算，绝不能吃展开前那份 bounds（那就是「输入框沉到键盘下面」的根因） */
	private boundsResolver: (() => Bounds) | null = null;
	/** 键盘 / 原生栏几何订阅（仅评论编辑区展开期间挂着） */
	private unwatchGeometry: (() => void) | null = null;

	/** readerView 注入：返回正文区**当前**可用矩形（已裁掉键盘与键盘上方原生栏） */
	setBoundsResolver(fn: () => Bounds): void {
		this.boundsResolver = fn;
	}

	private watchGeometry(): void {
		this.stopWatching();
		this.unwatchGeometry = subscribeKeyboardGeometry(this.containerEl.parentElement, () => {
			this.replaceWithFreshBounds();
		});
	}

	private stopWatching(): void {
		const fn = this.unwatchGeometry;
		this.unwatchGeometry = null;
		if (fn) fn();
	}

	/** 用现测 bounds 重排（键盘动画期间会被多次调用，内部按帧合并） */
	private replaceWithFreshBounds(): void {
		if (!this.commentOpen) return;
		const bounds = this.boundsResolver?.() ?? this.lastBounds;
		if (!bounds) return;
		this.reposition(this.lastAnchorRect, bounds);
	}

	constructor(actions: SelectionActions) {
		this.actions = actions;
		this.containerEl = document.createElement("div");
		this.containerEl.className = "unreader-selection-toolbar";
		this.render();
		this.hide();
		this.containerEl.addEventListener("pointerdown", e => e.stopPropagation());
	}

	private render(): void {
		this.containerEl.empty();

		this.barRow = this.containerEl.createDiv({ cls: "unreader-selbar-row" });

		const copyBtn = this.barRow.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "复制选中文字" } });
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (this.snapshot) this.actions.onCopy(this.snapshot.text);
			this.hide();
		});

		this.barRow.createDiv({ cls: "unreader-selbar-divider" });

		for (const color of HIGHLIGHT_COLORS) {
			const dot = this.barRow.createDiv({
				cls: "unreader-selbar-dot",
				attr: { "aria-label": `高亮（${color.label}）` },
			});
			dot.style.backgroundColor = highlightColorOf(color.name).replace(/[\d.]+\)$/, "1)");
			dot.addEventListener("click", e => {
				e.stopPropagation();
				this.pickedColor = color.name;
				if (this.snapshot) this.actions.onHighlight(color.name);
				this.hide();
			});
		}

		this.barRow.createDiv({ cls: "unreader-selbar-divider" });

		const commentBtn = this.barRow.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "高亮并添加评论" } });
		setIcon(commentBtn, "message-square-text");
		commentBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.openCommentEditor();
		});

		this.barRow.createDiv({ cls: "unreader-selbar-divider" });

		const closeBtn = this.barRow.createDiv({ cls: "unreader-selbar-btn", attr: { "aria-label": "关闭" } });
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.hide();
		});

		this.commentWrap = this.containerEl.createDiv({ cls: "unreader-selbar-comment" });
		this.commentWrap.hide();

		const ta = this.commentWrap.createEl("textarea", {
			cls: "unreader-hl-pop-comment",
			attr: { placeholder: "写下评论，将与高亮一同保存…" },
		}) as HTMLTextAreaElement;
		this.commentInput = ta;
		ta.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.submitComment();
		});

		const row = this.commentWrap.createDiv({ cls: "unreader-hl-pop-comment-row" });
		row.createEl("button", { text: "取消" }).addEventListener("click", e => {
			e.stopPropagation();
			this.hide();
		});
		row.createEl("button", { text: "保存", cls: "mod-cta" }).addEventListener("click", e => {
			e.stopPropagation();
			this.submitComment();
		});
	}

	private openCommentEditor(): void {
		this.commentOpen = true;
		this.commentWrap.show();
		this.barRow.addClass("is-hidden");
		// 先在「展开态 + 当前 bounds」下排一次（reposition 内会读 offsetHeight 强制布局，尺寸已就绪），
		// 再挂键盘订阅：输入框 focus 会拉起键盘 → 官方把 .app-container 收缩到
		// `100vh - --keyboard-height`，之后每次几何变化都必须重排，
		// 否则编辑区会停在键盘下面、被 .unreader-body 的 overflow:hidden 裁掉。
		this.replaceWithFreshBounds();
		requestAnimationFrame(() => {
			this.replaceWithFreshBounds();
			this.commentInput.focus();
		});
		this.watchGeometry();
		setTimeout(() => this.commentInput.focus(), 30);
	}

	/** 可用高度装不下整个评论框时（手机横屏、iPad 分屏 + 键盘）压缩输入区，
	 *  而不是把「保存 / 取消」按钮行沉到键盘下面。桌面端可用高度充裕 → 值恒为 CSS 的上限 160px。 */
	private fitCommentHeight(available: number): void {
		const rowH = this.commentWrap.querySelector<HTMLElement>(".unreader-hl-pop-comment-row")?.offsetHeight ?? 32;
		// 容器上下 padding(6+6) + 边框(1+1) + 输入区上 padding(8) + gap(8) ≈ 30
		const chrome = rowH + 30;
		const next = Math.max(44, Math.min(160, Math.floor(available - 16 - chrome)));
		this.commentInput.style.maxHeight = `${next}px`;
	}

	private reposition(anchorRect: DOMRect | null, bounds: Bounds): void {
		this.containerEl.addClass("is-measuring");
		this.containerEl.addClass("is-visible");
		void this.containerEl.offsetHeight;
		let tw = this.containerEl.offsetWidth || 240;
		let th = this.containerEl.offsetHeight || 44;
		if (this.commentOpen) {
			this.fitCommentHeight(bounds.height);
			th = this.containerEl.offsetHeight || th;
			tw = this.containerEl.offsetWidth || tw;
		}
		this.containerEl.removeClass("is-measuring");
		// 固定模式：忽略锚点，正文区底部居中。
		// 「避开键盘 / 键盘上方原生栏」不再是这里的 bottomInset，而是由 bounds 本身就是
		// 可用矩形来保证（readerView 注入的 boundsResolver 已把高度裁到可用区底边）——
		// 一份口径只留一个来源，避免两处各减一次。
		const { left, top, origin } = placeFloating(anchorRect, { width: tw, height: th }, bounds, {
			margin: 8,
			gap: 8,
			vertical: this.fixed ? "bottom" : "center",
		});
		this.containerEl.style.left = `${left}px`;
		this.containerEl.style.top = `${top}px`;
		this.containerEl.style.transformOrigin = origin;
		this.containerEl.addClass("is-visible");
	}

	private submitComment(): void {
		if (!this.snapshot) return;
		this.actions.onComment(this.snapshot.text, this.commentInput.value.trim(), this.pickedColor);
		this.hide();
	}

	showFor(snapshot: SelectionSnapshot, anchorRect: DOMRect | null, bounds: Bounds): void {
		// 评论编辑区展开期间，**选区事件重投**不得重置编辑态（2026-09-19 真机回归的第二条路径）。
		//
		// 移动端软键盘弹起会让官方收缩 `.app-container` → 书页回流，浏览器常把同一段选区
		// **重新上报一次**（`pointerup` 的 `setTimeout(0)` 与 `selectionchange` 的 260ms 去抖
		// 两条路）。此刻选区仍是**非空**的，所以走不到「选区被系统收走」那条守卫，会一路
		// 落到这里。旧实现无条件执行下面那串重置：
		//   `commentOpen = false` + `commentWrap.hide()`（= `display:none`）
		//   → 输入框立刻 blur（已用 Chromium 实测：`display:none` / `visibility:hidden`
		//     都会让聚焦中的 textarea 失焦）→ 软键盘刚弹起就被系统压回去；
		//   并且 `commentInput.value = ""` 把用户已经打好的评论一起清掉。
		//
		// 判据为什么可以只看 `commentOpen`：**任何**「用户重新划选另一段」的意图，其起点
		// 必然是书页 iframe 或正文空白上的 `pointerdown`，而那条路一律先经
		// `dismissFloatingOnBlankClick()` → `hide()`（编辑区已关，`commentOpen === false`）。
		// 所以编辑区还开着时收到的选区事件，只可能是同一次划选的重投，不是新意图。
		if (this.commentOpen) {
			this.snapshot = snapshot;
			this.lastAnchorRect = this.fixed ? null : anchorRect;
			const freshBounds = this.boundsResolver?.() ?? bounds;
			this.lastBounds = freshBounds;
			this.reposition(this.lastAnchorRect, freshBounds);
			debugLog.info("[comment] 选区事件重投已让路（评论编辑区保持展开、已输入文字保留）",
				JSON.stringify(snapshot.text.slice(0, 24)));
			return;
		}
		this.snapshot = snapshot;
		this.lastAnchorRect = this.fixed ? null : anchorRect;
		this.commentOpen = false;
		this.stopWatching();
		this.pickedColor = "yellow";
		this.commentInput.value = "";
		this.commentInput.style.removeProperty("max-height");
		this.commentWrap.hide();
		this.barRow.removeClass("is-hidden");

		// 有供体就用现测值（选中时传入的 bounds 是当次快照，展开评论时可能已过期）
		const fresh = this.boundsResolver?.() ?? bounds;
		this.lastBounds = fresh;
		this.reposition(this.lastAnchorRect, fresh);
	}

	/** 切换固定定位模式：固定后工具条不跟随选区，固定在正文区底部居中 */
	setFixed(fixed: boolean): void {
		this.fixed = fixed;
	}

	hide(): void {
		// 取证：只有在**编辑区还开着**的时候收起才算故障路径 —— 它会 `visibility:hidden`
		// 掉承载输入框的容器，移动端软键盘随即被系统收走。带上调用栈，真机日志可直接指认
		// 是哪条路径动的手（正常出口：取消 / 关闭 / Esc / 点正文空白 / 点别处高亮 / 全沉浸）。
		if (this.commentOpen) debugLog.info("[comment] hide() 在编辑评论期间收起工具条 ←", new Error("fold"));
		this.snapshot = null;
		this.lastAnchorRect = null;
		this.lastBounds = null;
		this.commentOpen = false;
		this.stopWatching();
		if (this.commentInput) {
			this.commentInput.value = "";
			this.commentInput.style.removeProperty("max-height");
		}
		this.commentWrap?.hide();
		this.barRow?.removeClass("is-hidden");
		this.containerEl.removeClass("is-visible");
		this.containerEl.style.removeProperty("transform-origin");
	}

	get visible(): boolean {
		return this.containerEl.hasClass("is-visible");
	}

	/** 评论编辑区是否展开（其间用户可能正在打字、软键盘可能正弹着）。
	 *
	 *  readerView 的「背景活动」路径（relocate / 书页滚动 / 选区被系统收走）据此让路：
	 *  收起容器会把正在编辑的输入框一起 blur 掉 —— 移动端表现为软键盘弹起又立刻被压回去
	 *  （用户报的「划线时键盘闪一下就没法标注了」）。 */
	get isCommentOpen(): boolean {
		return this.commentOpen;
	}
}
