import { setIcon, Notice } from "obsidian";
import { HIGHLIGHT_COLORS, highlightColorOf } from "../types";
import { placeFloating, type Bounds } from "./floatingPlacement";
import { subscribeKeyboardGeometry } from "./keyboardInset";

export interface HighlightPopoverTarget {
	id: number
	anchor: string
	text: string
	color: string
	comment: string
}

export interface HighlightPopoverActions {
	onColor: (id: number, colorName: string) => void
	onDelete: (id: number) => void
	onComment: (id: number, comment: string) => void
}

/**
 * 点击已有高亮后弹出的浮窗：与 SelectionToolbar 保持完全一致的工具条形态与定位。
 * - 不展示高亮原文（与正文重复，且会导致浮窗过高）
 * - 结构与 SelectionToolbar 对齐：复制 + 颜色点 + 评论/删除，评论为可展开输入区
 * - 定位复用 placeFloating，覆盖多边界场景
 */
export class HighlightPopover {
	readonly containerEl: HTMLElement;
	private actions: HighlightPopoverActions;
	private target: HighlightPopoverTarget | null = null;
	private barRow!: HTMLElement;
	private commentWrap!: HTMLElement;
	private commentInput!: HTMLTextAreaElement;
	private lastAnchorRect: DOMRect | null = null;
	private lastBounds: Bounds | null = null;
	/** 评论编辑区是否展开（只有展开时才需要「贴键盘」重排与高度压缩） */
	private commentOpen = false;
	/** bounds 现测供体（readerView 注入）。与 SelectionToolbar 同因：键盘弹起时官方收缩
	 *  `.app-container`，用展开前的旧 bounds 定位会让编辑区停在键盘下面被裁掉。 */
	private boundsResolver: (() => Bounds) | null = null;
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

	constructor(actions: HighlightPopoverActions) {
		this.actions = actions;
		this.containerEl = document.createElement("div");
		this.containerEl.className = "unreader-highlight-popover";
		this.render();
		this.hide();
		this.containerEl.addEventListener("pointerdown", e => e.stopPropagation());
	}

	private render(): void {
		this.containerEl.empty();

		this.barRow = this.containerEl.createDiv({ cls: "unreader-selbar-row" });

		const copyBtn = this.barRow.createDiv({
			cls: "unreader-selbar-btn",
			attr: { "aria-label": "复制高亮文字" },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (!this.target?.text) {
				new Notice("无可复制的文本");
				return;
			}
			void navigator.clipboard
				.writeText(this.target.text)
				.then(() => new Notice("已复制"))
				.catch(() => new Notice("复制失败"));
		});

		this.barRow.createDiv({ cls: "unreader-selbar-divider" });

		for (const c of HIGHLIGHT_COLORS) {
			const dot = this.barRow.createDiv({
				cls: "unreader-selbar-dot",
				attr: { "aria-label": `高亮（${c.label}）`, "data-color": c.name },
			});
			dot.style.backgroundColor = highlightColorOf(c.name).replace(/[\d.]+\)$/, "1)");
			dot.addEventListener("click", e => {
				e.stopPropagation();
				if (!this.target || this.target.color === c.name) return;
				this.target.color = c.name;
				this.barRow.querySelectorAll(".unreader-selbar-dot.is-active").forEach(el => el.removeClass("is-active"));
				dot.addClass("is-active");
				this.actions.onColor(this.target.id, c.name);
			});
		}

		this.barRow.createDiv({ cls: "unreader-selbar-divider" });

		const commentBtn = this.barRow.createDiv({
			cls: "unreader-selbar-btn",
			attr: { "aria-label": "评论" },
		});
		setIcon(commentBtn, "message-square-text");
		commentBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.openCommentEditor();
		});

		const deleteBtn = this.barRow.createDiv({
			cls: "unreader-selbar-btn",
			attr: { "aria-label": "删除高亮" },
		});
		setIcon(deleteBtn, "trash-2");
		deleteBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (this.target) this.actions.onDelete(this.target.id);
			this.hide();
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
			attr: { placeholder: "写下你对这段文字的评论…" },
		}) as HTMLTextAreaElement;
		this.commentInput = ta;
		ta.addEventListener("keydown", e => {
			e.stopPropagation();
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.submitComment();
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeCommentEditor();
			}
		});

		const row = this.commentWrap.createDiv({ cls: "unreader-hl-pop-comment-row" });
		row.createEl("button", { text: "取消" }).addEventListener("click", e => {
			e.stopPropagation();
			this.closeCommentEditor();
		});
		row.createEl("button", { text: "保存", cls: "mod-cta" }).addEventListener("click", e => {
			e.stopPropagation();
			this.submitComment();
		});
	}

	private syncDots(): void {
		if (!this.target || !this.barRow) return;
		this.barRow.querySelectorAll(".unreader-selbar-dot").forEach(el => {
			const name = (el as HTMLElement).getAttribute("data-color");
			el.toggleClass("is-active", name === this.target!.color);
		});
	}

	private openCommentEditor(): void {
		if (!this.target) return;
		this.commentInput.value = this.target.comment ?? "";
		this.commentOpen = true;
		this.commentWrap.show();
		this.barRow.addClass("is-hidden");
		const place = (): void => {
			const bounds = this.boundsResolver?.() ?? this.lastBounds;
			if (!bounds) return;
			this.reposition(this.lastAnchorRect, bounds);
		};
		// 先按展开态排一次，再挂键盘订阅：focus 会拉起键盘 → 官方收缩容器 → 必须跟着重排
		place();
		requestAnimationFrame(() => {
			place();
			this.commentInput.focus();
		});
		this.watchGeometry();
		setTimeout(() => this.commentInput.focus(), 30);
	}

	/** 可用高度装不下整个评论框时压缩输入区（保住「保存 / 取消」按钮行）。
	 *  桌面端可用高度充裕 → 计算结果恒为 CSS 上限 160px，与改动前一致。 */
	private fitCommentHeight(available: number): void {
		const rowH = this.commentWrap.querySelector<HTMLElement>(".unreader-hl-pop-comment-row")?.offsetHeight ?? 32;
		const chrome = rowH + 30;
		const next = Math.max(44, Math.min(160, Math.floor(available - 16 - chrome)));
		this.commentInput.style.maxHeight = `${next}px`;
	}

	private closeCommentEditor(): void {
		this.commentOpen = false;
		this.stopWatching();
		this.commentWrap.hide();
		this.barRow.removeClass("is-hidden");
		this.commentInput.style.removeProperty("max-height");
		const bounds = this.boundsResolver?.() ?? this.lastBounds;
		if (bounds) this.reposition(this.lastAnchorRect, bounds);
	}

	private submitComment(): void {
		if (!this.target) return;
		const next = this.commentInput.value.trim();
		this.target.comment = next;
		this.actions.onComment(this.target.id, next);
		this.closeCommentEditor();
	}

	private reposition(anchorRect: DOMRect | null, bounds: Bounds): void {
		this.containerEl.addClass("is-measuring");
		this.containerEl.addClass("is-visible");
		void this.containerEl.offsetHeight;
		let tw = this.containerEl.offsetWidth || 260;
		let th = this.containerEl.offsetHeight || 44;
		if (this.commentOpen) {
			this.fitCommentHeight(bounds.height);
			th = this.containerEl.offsetHeight || th;
			tw = this.containerEl.offsetWidth || tw;
		}
		this.containerEl.removeClass("is-measuring");
		const { left, top, origin } = placeFloating(anchorRect, { width: tw, height: th }, bounds, { margin: 8, gap: 8 });
		this.containerEl.style.left = `${left}px`;
		this.containerEl.style.top = `${top}px`;
		this.containerEl.style.transformOrigin = origin;
		this.containerEl.addClass("is-visible");
	}

	showFor(
		target: HighlightPopoverTarget,
		anchorRect: DOMRect | null,
		bounds: Bounds,
		focusComment = false,
	): void {
		this.target = { ...target };
		if (!this.barRow) this.render();
		this.syncDots();
		this.commentOpen = false;
		this.stopWatching();
		this.commentWrap.hide();
		this.barRow.removeClass("is-hidden");
		this.commentInput.value = this.target.comment ?? "";
		this.commentInput.style.removeProperty("max-height");

		this.lastAnchorRect = anchorRect;
		// 有供体就用现测值：侧栏触发 / 展开评论时键盘已经弹起，传入的 bounds 可能已过期
		const fresh = this.boundsResolver?.() ?? bounds;
		this.lastBounds = fresh;
		this.reposition(anchorRect, fresh);

		if (focusComment) this.openCommentEditor();
	}

	hide(): void {
		this.target = null;
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
}
