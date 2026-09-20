import { setIcon, Notice } from "obsidian";
import { HIGHLIGHT_COLORS, highlightColorOf } from "../types";
import * as debugLog from "../core/debugLog";
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
	/** 弹框标题（「添加评论」/「编辑评论」） */
	private commentTitle!: HTMLElement;
	/** 弹框顶部的原文引用（两行截断）：背板压暗了正文，这一行是「别写错地方」的锚点 */
	private commentQuote!: HTMLElement;
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
		this.containerEl = createDiv();
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

		// 背板：盖住正文（点击 = 收起编辑区，与「取消」等价）
		const scrim = this.containerEl.createDiv({ cls: "unreader-comment-scrim" });
		scrim.addEventListener("pointerdown", e => {
			e.stopPropagation();
			e.preventDefault();
			this.closeCommentEditor();
		});

		// 弹框的标题行：说清「在给什么写评论」，右侧关闭键与「取消」等价
		const head = this.commentWrap.createDiv({ cls: "unreader-comment-head" });
		this.commentTitle = head.createDiv({ cls: "unreader-comment-title", text: "添加评论" });
		const dialogCloseBtn = head.createDiv({ cls: "unreader-comment-close", attr: { "aria-label": "关闭" } });
		setIcon(dialogCloseBtn, "x");
		dialogCloseBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.closeCommentEditor();
		});
		this.commentQuote = this.commentWrap.createDiv({ cls: "unreader-comment-quote" });

		const ta = this.commentWrap.createEl("textarea", {
			cls: "unreader-hl-pop-comment",
			attr: { placeholder: "写下你对这段文字的评论…" },
		});
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
		// 弹框态：容器退成透明的定位盒，内容 = 背板 + 评论卡片（样式见 styles.css 第 6 节）
		this.containerEl.addClass("is-comment-open");
		// 已有评论 = 编辑既有内容，否则是这条高亮的「补写评论」——两种语境的文案与落点不同
		this.commentTitle.setText(this.target.comment ? "编辑评论" : "添加评论");
		this.commentQuote.setText(this.target.text ?? "");
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
		window.requestAnimationFrame(() => {
			place();
			this.commentInput.focus();
		});
		this.watchGeometry();
		window.setTimeout(() => this.commentInput.focus(), 30);
	}

	/** 可用高度装不下整张评论卡片时（手机横屏、iPad 分屏 + 键盘）压缩输入区，
	 *  而不是把「保存 / 取消」按钮行沉到键盘下面。桌面端可用高度充裕 → 值恒为 CSS 上限。
	 *
	 *  2026-09-20 这一格变成**弹框卡片**（标题行 + 引用行 + 输入区 + 按钮行）之后，
	 *  「非输入区高度」必须把新增的标题行与引用行一起量进去；实在装不下时先让引用行退场。
	 *
	 *  口径与 `SelectionToolbar.fitCommentHeight` **逐字同源**（`test:comment-mobile` 同一套
	 *  断言同时覆盖两处），改一处必须同步改另一处。 */
	private fitCommentHeight(available: number): void {
		const rowH = this.commentWrap.querySelector<HTMLElement>(".unreader-hl-pop-comment-row")?.offsetHeight ?? 32;
		const headH = this.commentWrap.querySelector<HTMLElement>(".unreader-comment-head")?.offsetHeight ?? 22;
		const quoteH = this.commentWrap.querySelector<HTMLElement>(".unreader-comment-quote")?.offsetHeight ?? 0;
		// 极窄可用区（实测 ~172px：手机横屏 / iPad 分屏 + 键盘）：卡片自己的固定开销
		// （标题行 + 引用行 + 按钮行 + 内边距与行距）就要吃掉 ~150px，硬压输入区只会把按钮行
		// 顶到键盘下面。所以先让**引用行退场**——它只是「别写错地方」的锚点，输入框与按钮行
		// 才是必须留住的（`is-tight` 同时把内边距与行距收一档，见 styles.css 第 6 节）。
		const tight = available < 240;
		this.commentWrap.toggleClass("is-tight", tight);
		// 卡片上下 padding(12+12) + 三段 10px 行距 + 上下 16px 余量；紧凑档 = padding(10+10)
		// + 两段 8px 行距 + 16px 余量。
		const chrome = rowH + headH + (tight ? 0 : quoteH) + (tight ? 58 : 70);
		const next = Math.max(44, Math.min(200, Math.floor(available - chrome)));
		// min/max 必须一起写：CSS 给的 min-height(88px) 在 min > max 时会**反过来压过**内联
		// max-height（CSS 的 min/max 冲突规则），只写 max-height 的实现在极窄档压不下去
		// （实测卡片 213px > 可用 172px，按钮行照旧被裁）。
		this.commentInput.style.minHeight = `${Math.min(next, 88)}px`;
		this.commentInput.style.maxHeight = `${next}px`;
	}

	/** 清掉 `fitCommentHeight` 写下的内联尺寸与紧凑档标记（收起 / 重投编辑态时都要回到 CSS 口径）。
	 *  与它配对，别只清 max-height：留下 `is-tight` 会让下一次展开少一行引用。 */
	private resetCommentMetrics(): void {
		this.commentInput?.style.removeProperty("min-height");
		this.commentInput?.style.removeProperty("max-height");
		this.commentWrap?.removeClass("is-tight");
	}

	private closeCommentEditor(): void {
		this.commentOpen = false;
		this.containerEl.removeClass("is-comment-open");
		this.stopWatching();
		this.commentWrap.hide();
		this.barRow.removeClass("is-hidden");
		this.resetCommentMetrics();
		this.commentQuote.setText("");
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
		// 弹框态照旧贴锚点（理由与 SelectionToolbar.reposition 同段：UN 系列刻意不做「居中
		// 弹窗」——`UNmemos/src/styles.css` 的 `.memos-editor-is-expanded` 段写明「avoids the
		// visual 'jump' of a centered modal and keeps the input box where the user expects
		// it」。弹框换的是「面 / 圆角 / 投影 + 背板」这一层观感，落点不动；锚点失效时
		// `placeFloating` 自己会退到可用区居中。
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
		// 评论编辑区展开期间，**同一条高亮的选区/定位事件重投**不得重置编辑态
		// （机理与判据同 `SelectionToolbar.showFor`：重置会 `commentWrap.hide()` =
		// `display:none` → 输入框 blur → 移动端软键盘刚弹起就被压回去，且已输入文字被清）。
		// `focusComment` 显式要求（重新）展开编辑区时一律放行 —— 那是调用方的明确意图。
		if (!focusComment && this.commentOpen && this.target && this.target.id === target.id) {
			this.target = { ...target };
			this.lastAnchorRect = anchorRect;
			const freshBounds = this.boundsResolver?.() ?? bounds;
			this.lastBounds = freshBounds;
			this.reposition(anchorRect, freshBounds);
			debugLog.info("[comment] 高亮浮窗的选区事件重投已让路（评论编辑区保持展开）", String(target.id));
			return;
		}
		this.target = { ...target };
		if (!this.barRow) this.render();
		this.syncDots();
		this.commentOpen = false;
		this.containerEl.removeClass("is-comment-open");
		this.stopWatching();
		this.commentWrap.hide();
		this.barRow.removeClass("is-hidden");
		this.commentInput.value = this.target.comment ?? "";
		this.resetCommentMetrics();
		this.commentQuote.setText("");

		this.lastAnchorRect = anchorRect;
		// 有供体就用现测值：侧栏触发 / 展开评论时键盘已经弹起，传入的 bounds 可能已过期
		const fresh = this.boundsResolver?.() ?? bounds;
		this.lastBounds = fresh;
		this.reposition(anchorRect, fresh);

		if (focusComment) this.openCommentEditor();
	}

	hide(): void {
		// 取证同 SelectionToolbar.hide：编辑区还开着时被后台路径收起 = 软键盘被压回去的真凶。
		if (this.commentOpen) debugLog.info("[comment] hide() 在编辑评论期间收起高亮浮窗 ←", new Error("fold"));
		this.target = null;
		this.lastAnchorRect = null;
		this.lastBounds = null;
		this.commentOpen = false;
		this.containerEl.removeClass("is-comment-open");
		this.stopWatching();
		if (this.commentInput) {
			this.commentInput.value = "";
			this.resetCommentMetrics();
		}
		this.commentQuote?.setText("");
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
