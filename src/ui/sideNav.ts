import { setIcon, Platform } from "obsidian";

/** 数字/页码自适应压缩用的常量（官方 lint 禁止给 .style 赋字面量，值不变）。 */
const PAGE_TIGHT_LETTER_SPACING = "-0.10em";
const NAV_ROW_PAD_RIGHT = "10px";
import type { NavEntryModel } from "../core/engineAdapter";

/**
 * 左右双轨导航：
 * - navEl：右缘章节轨 —— 一条短横对应一章（从右缘向左生长，长度编码层级、
 *   间距固定、整体半透明），悬停 / 触屏点按弹出全量章节面板；悬停某条短横时
 *   面板里对应行同步高亮并滚到中央。条数超出「阅读区高度 3/4」时轨道内部滚动，
 *   当前章短横按「先下移、能居中后固定居中、到边缘再继续下移」的规则跟随。
 * - pageEl：页码显示，独立钉在阅读区右下角；点击弹出页码跳转面板（与按钮排页码共用同一弹窗）。
 * - actionsEl：左下功能轨 —— 目录 / 返回 / 标记 / 外观等图标按钮。
 * - backEl：右下角返回按钮（智能显隐，位于页码下方）
 */
export class SideNav {
	readonly navEl: HTMLElement;
	readonly actionsEl: HTMLElement;
	readonly backEl: HTMLElement;
	readonly pageEl: HTMLElement;

	private nodesEl!: HTMLElement;
	private clusterEl!: HTMLElement;
	/** 悬停通路桥：短横轨与目录面板之间那条 22u 宽的缝（见 styles.css 该段）。
	 *  只为「鼠标从短横平移到面板」保留 hover，不承载任何交互。 */
	private bridgeEl!: HTMLElement;
	/** 当前设备是否有 hover 能力（构造时读一次）。触屏走「短横 = 激活 + 划动预览」，
	 *  hover 设备走「短横 = 悬停预览 / 点击直接跳转」。 */
	private hoverable = false;
	/** 触屏正在划动短横轨（pointerdown→pointerup 之间） */
	private touchScrub = false;
	private pageText = "";
	private tocPages = new Map<number, number>();
	private onPageClick: (() => void) | null = null;
	private panelEl: HTMLElement | null = null;
	private actionsPanel!: HTMLElement;
	private pinTrigger!: HTMLElement;
	private pageActionEl: HTMLElement | null = null;
	/** 页码自适应收缩缓存（元素 → 上次测量键），避免 relocate 高频调用时重复读写触发重排 */
	private pageFitKey = new WeakMap<HTMLElement, string>();

	private entries: NavEntryModel[] = [];
	private onSelect: ((entry: NavEntryModel) => void) | null = null;
	private activeIndex = -1;
	private open = false;
	private buttonPinned = false;
	/** 右缘章节短横轨显隐（随外观/预设；隐藏时目录面板仍可由按钮/命令唤起） */
	private railVisible = true;
	private counts = new Map<number, number>();
	// 目录面板锚点：rail=右缘章节轨旁（悬停/命令/自动展开），actions=左缘功能按钮排旁（按钮唤出）
	private panelAnchor: "rail" | "actions" = "rail";
	private tocTrigger: HTMLElement | null = null;
	/** 当前章内部阅读进度 0-1，显示为**当前章短横内部的填充**（替代原全宽底部细条） */
	private chapterProgress = 0;
	/** 「章节进度」外观开关（关掉则当前章短横退回纯高亮，不显示填充） */
	private chapterProgressOn = true;

	/** 目录面板开 / 合（含换锚）回调：宿主用它同步功能轨上「目录」按钮的「作用中」高亮。
	 *  挂在面板内部而不是宿主各调用点 —— `syncPanelOpenState` 是开合的唯一收口
	 *  （hover 展开、按钮唤出、行点击、点外面关闭都汇到它）。 */
	onPanelOpenChange: ((open: boolean) => void) | null = null;

	constructor() {
		this.navEl = document.createElement("div");
		this.navEl.className = "unreader-nav is-empty";
		// 移动端：右下角独立页码与桌面一致常显（曾被 .is-mobile 隐藏，但页码所在的
		// 功能按钮排半隐藏于左缘、触屏无 hover 唤不出，等于移动端没有页码）；
		// 右缘章节短横轨默认显示，随「浮动目录条」开关（is-rail-off）显隐
		try {
			if (Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp) {
				this.navEl.addClass("is-mobile");
			}
		} catch { /* ignore */ }

		// **原生 swipe 的官方退出开关**（obsidian.asar 的 `Rm` 识别器：touchstart 时从
		// targetNode 往上逐级找祖先，任一元素带 `data-ignore-swipe` 就整条手势不认）。
		// 右缘浮动目录轨上「按住下滑/上滑」是插件自己的划动预览，若不退出，Obsidian 的
		// 原生下滑手势会同时触发（用户报的「按住浮动目录向下时，面板跟着预览，但原生
		// 下滑快速打开目录也一起叠加」）。轨只有 32u 宽、且那一片区域本就是本插件的独占
		// 交互面（点按/划动/预览全在这里），退出原生手势没有副作用 —— 而**不能**把这条
		// 属性挂到 .unreader-root 上：那会把「正文区横滑开侧栏」的原生手势一并废掉。
		this.nodesEl = this.navEl.createDiv({
			cls: "unreader-nav-nodes",
			attr: { "data-ignore-swipe": "true" },
		});
		// 仅 hover 能力设备用悬停开/关面板：触屏合成 mouseenter/mouseleave 会在
		// pointerdown 打开后立即触发 mouseleave 关掉，改用「点一下开 / 点外面关」。
		// 同一个能力位还决定**短横是不是跳转按钮**，见 tapNode 的注释。
		try { this.hoverable = window.matchMedia?.("(hover: hover)")?.matches ?? false; } catch { this.hoverable = false; }
		if (this.hoverable) {
			this.nodesEl.addEventListener("mouseenter", () => {
				if (!this.railVisible) return;
				this.openPanel();
			});
			this.nodesEl.addEventListener("mouseleave", () => this.setPanel(false));
		}
		this.nodesEl.addEventListener("contextmenu", e => e.preventDefault());
		this.nodesEl.addEventListener("pointerdown", e => {
			if (e.pointerType !== "touch") return;
			const target = e.target as HTMLElement;
			if (target.closest(".unreader-nav-panel")) return;
			if (target.closest(".unreader-nav-page")) return;
			if (target.closest(".unreader-nav-bridge")) return;
			this.openAtRail();
			if (!this.hoverable) {
				// 触屏：按下即「激活面板 + 把摸到的那条带进面板」。
				// 触屏没有 hover 可以二次确认，短横离面板又只有十几像素，
				// 直接跳转太容易误触 —— 跳转只能点面板里的行（用户 2026-09-13 的报点）。
				this.touchScrub = true;
				this.previewTouchAt(e.clientX, e.clientY);
			}
		});
		// 划动短横轨 = 桌面「悬停 + 上下移动」：面板预览跟着指尖走，同样不跳转。
		// 触屏指针有**隐式捕获**，指尖划出轨道后 pointermove 仍会派发到这里，
		// 所以只需按坐标判「指尖下是不是一条短横」，划出去就保持上一个预览。
		if (!this.hoverable) {
			this.nodesEl.addEventListener("pointermove", e => {
				if (e.pointerType !== "touch" || !this.touchScrub) return;
				this.previewTouchAt(e.clientX, e.clientY);
			});
			const endScrub = (e: PointerEvent): void => {
				if (e.pointerType === "touch") this.touchScrub = false;
			};
			this.nodesEl.addEventListener("pointerup", endScrub);
			this.nodesEl.addEventListener("pointercancel", endScrub);
		}

		// 章节短横轨：只有「一章一短横」，不再挂载上下步进箭头
		// （原 up/down step 按钮已按设计移除，逐章步进改由目录面板点击完成）
		// —— 悬停通路桥：补在短横轨与目录面板之间那条缝上（见 styles.css 该段）。
		// DOM 上必须排在 cluster **之前**：两者都是定位元素、z-index 同为 auto，
		// 命中顺序按 DOM 顺序走 —— 短横的命中盒（含 ::before 外扩 3u）必须压在桥上，
		// 否则面板一开、桥一激活，短横的悬停联动与点按跳转就被桥吞掉。
		// 激活态由 nodesEl 上的 is-panel-live 收口（面板未开时它完全隐形）。
		this.bridgeEl = this.nodesEl.createDiv({ cls: "unreader-nav-bridge" });
		this.bridgeEl.setAttribute("aria-hidden", "true");
		this.clusterEl = this.nodesEl.createDiv({ cls: "unreader-nav-cluster" });

		// 页码显示：独立钉在阅读区右下角，不随章节条宽度/位置变化；点击弹出页码跳转面板（与按钮排页码共用）
		this.pageEl = this.navEl.createDiv({ cls: "unreader-nav-page" });
		this.pageEl.setAttribute("aria-label", "点击跳转页码");
		this.pageEl.addEventListener("click", e => {
			e.stopPropagation();
			this.onPageClick?.();
		});
		this.renderPageText();

		this.actionsEl = document.createElement("div");
		this.actionsEl.className = "unreader-actions";
		this.actionsPanel = this.actionsEl.createDiv({ cls: "unreader-actions-panel" });
		const trigger = this.actionsEl.createDiv({ cls: "unreader-actions-trigger", attr: { "aria-label": "阅读工具" } });
		setIcon(trigger, "ellipsis");
		trigger.addEventListener("click", e => {
			e.stopPropagation();
			this.actionsEl.toggleClass("is-expanded", !this.actionsEl.hasClass("is-expanded"));
		});

		this.actionsEl = document.createElement("div");
		this.actionsEl.className = "unreader-actions";
		this.actionsPanel = this.actionsEl.createDiv({ cls: "unreader-actions-panel" });
		this.pinTrigger = this.actionsEl.createDiv({ cls: "unreader-actions-trigger", attr: { "aria-label": "钉住按钮组（不自动隐藏）" } });
		setIcon(this.pinTrigger, "pin");
		this.pinTrigger.addEventListener("click", e => {
			e.stopPropagation();
			this.toggleActionsPin();
		});
		// 与右缘轨道悬停行为统一：鼠标离开「按钮框 + 目录面板」区域后
		// 自动关闭面板，按钮框随之回到半隐藏待悬停态。
		// 面板是按钮框的子元素，在两者之间移动不会触发 mouseleave；
		// 触屏无 mouseleave，仍由点书页/点外部关闭。
		this.actionsEl.addEventListener("mouseleave", () => {
			if (this.open && this.panelAnchor === "actions") this.closePanel();
		});

		this.backEl = document.createElement("div");
		this.backEl.className = "unreader-back-btn";
		this.backEl.setAttr("aria-label", "返回上一位置");
		setIcon(this.backEl, "undo-2");
		this.backEl.addClass("is-hidden");
	}

	/** 在功能按钮排中添加一枚图标按钮。 */
	addIconButton(icon: string, label: string, onClick: () => void): HTMLElement {
		const btn = document.createElement("div");
		btn.className = "unreader-nav-action";
		btn.setAttribute("aria-label", label);
		setIcon(btn, icon);
		btn.addEventListener("click", e => {
			e.stopPropagation();
			onClick();
		});
		this.actionsPanel.appendChild(btn);
		return btn;
	}

	/** 在功能按钮排中插入一条分隔线。 */
	addSeparator(): void {
		this.actionsPanel.createDiv({ cls: "unreader-nav-sep" });
	}

	/**
	 * 在功能按钮排中添加页码显示（位于「上一页/下一页」按钮之间），
	 * 点击弹出页码跳转面板。页码文字由 setPageText 同步更新。
	 */
	addPageDisplay(onClick: () => void): HTMLElement {
		const el = document.createElement("div");
		el.className = "unreader-nav-action is-page-btn";
		el.setAttribute("aria-label", "跳转到页码");
		el.addEventListener("click", e => {
			e.stopPropagation();
			onClick();
		});
		this.actionsPanel.appendChild(el);
		this.pageActionEl = el;
		this.renderActionPageText();
		return el;
	}

	/** 按钮排中的页码只显示当前页；总页数放进悬停提示 */
	private renderActionPageText(): void {
		if (!this.pageActionEl) return;
		const slash = this.pageText.indexOf("/");
		const cur = slash >= 0 ? this.pageText.slice(0, slash).trim() : this.pageText.trim();
		const total = slash >= 0 ? this.pageText.slice(slash + 1).trim() : "";
		this.pageActionEl.setText(cur || "–");
		this.pageActionEl.toggleClass("is-visible", !!this.pageText);
		if (total) this.pageActionEl.setAttribute("aria-label", `第 ${cur} 页，共 ${total} 页 · 点击跳转`);
		else this.pageActionEl.setAttribute("aria-label", "跳转到页码");
		this.fitPageText(this.pageActionEl);
	}

	/**
	 * 页码自适应收缩：位数撞到 max-width 上限（右下角 56u / 按钮排 42u）时不再溢出。
	 * 两级降级，均不损可读性：
	 *  ① 二次收紧字距（CSS 基线已是 -0.05em，越界时压到 -0.10em）；
	 *  ② 仍越界则横向压缩字形 scaleX（数字变瘦高、纵向不缩，字号高度不变），下限 minScale。
	 * 注：正常位数下这里是空转 —— CSS `width: max-content` 让盒子随内容伸缩，
	 * `scrollWidth == clientWidth` 恒成立；只有内容被 `max-width` 夹住才有真实溢出。
	 * 元素未布局（父链 display:none / 尚未插入 DOM）时读不到宽度，下一帧重试若干次。
	 */
	private fitPageText(el: HTMLElement | null, minScale = 0.7, tries = 3): void {
		if (!el) return;
		const measure = (): boolean => {
			// 先读后写：稳态（文本/宽高未变）下只做一次读，不产生样式失效 → 不触发重排
			const avail = el.clientWidth;
			// 未布局：宽度读不到，等下一帧再试
			if (!avail) return false;
			const key = `${avail}|${el.textContent ?? ""}`;
			if (this.pageFitKey.get(el) === key) return true;
			this.pageFitKey.set(el, key);
			el.style.removeProperty("letter-spacing");
			el.style.removeProperty("--ur-page-sx"); // 等价于设回 1：CSS 用 var(--ur-page-sx, 1) 兜底
			let need = el.scrollWidth;
			if (need > avail + 0.5) {
				// ① 二次收紧字距（数字间距再压缩一档）
				el.style.setProperty("letter-spacing", PAGE_TIGHT_LETTER_SPACING);
				need = el.scrollWidth;
			}
			// ② 仍越界：横向压缩（数字拉长变瘦），下限保护可读性
			if (need > avail + 0.5) {
				el.style.setProperty("--ur-page-sx", String(Math.max(minScale, avail / need)));
			}
			return true;
		};
		if (measure()) return;
		const retry = (left: number): void => {
			if (left <= 0) return;
			window.requestAnimationFrame(() => {
				if (!measure()) retry(left - 1);
			});
		};
		retry(tries);
	}

	/** 设置页码点击行为（弹窗跳转）。 */
	setPageClickHandler(onClick: () => void): void {
		this.onPageClick = onClick;
	}

	/** 更新页码文字；空串时隐藏。 */
	setPageText(text: string): void {
		this.pageText = text;
		this.renderActionPageText();
		this.renderPageText();
	}

	/** 目录面板每行右侧的起始页码（tocId → 页码）；面板未开时仅暂存，展开时套用 */
	setTocPages(pages: Map<number, number>): void {
		this.tocPages = new Map(pages);
		this.applyTocPages();
	}

	private applyTocPages(): void {
		if (!this.panelEl) return;
		this.panelEl.querySelectorAll<HTMLElement>(".unreader-nav-row").forEach(row => {
			const idx = Number(row.dataset.navIndex);
			const entry = this.entries[idx];
			const span = row.querySelector<HTMLElement>(".unreader-nav-row-page");
			if (!span || !entry) return;
			const page = entry.id != null ? this.tocPages.get(entry.id) : undefined;
			if (page != null) {
				span.setText(String(page));
				span.show();
			} else {
				span.hide();
			}
		});
	}

	private renderPageText(): void {
		this.pageEl.empty();
		// 只显示当前页；总页码放进悬停提示（Obsidian 原生 tooltip）
		const slash = this.pageText.indexOf("/");
		let label = "点击跳转页码";
		if (slash >= 0) {
			const cur = this.pageText.slice(0, slash).trim();
			const total = this.pageText.slice(slash + 1).trim();
			this.pageEl.createSpan({ cls: "unreader-nav-page-cur", text: cur });
			label = `第 ${cur} 页，共 ${total} 页 · 点击跳转`;
		} else if (this.pageText) {
			this.pageEl.createSpan({ cls: "unreader-nav-page-cur", text: this.pageText });
		}
		this.pageEl.setAttribute("aria-label", label);
		this.pageEl.toggleClass("is-visible", !!this.pageText);
		this.fitPageText(this.pageEl);
	}

	/** 钉住按钮：切换按钮排是否自动隐藏 */
	toggleActionsPin(): void {
		this.setActionsPinned(!this.actionsEl.hasClass("is-pinned"));
	}

	/** 设置按钮排钉住态（常显、不自动隐藏）。类名与触发钮图标一并同步：
	 *  外部路径（如非沉浸模式点按「快速关闭工具栏」）改钉住态时必须走这里，
	 *  只 toggleClass 会让图标停留在旧态，表现为「明明取消了钉住，按钮还显示已钉住」。 */
	setActionsPinned(pinned: boolean): void {
		if (this.actionsEl.hasClass("is-pinned") === pinned) return;
		this.actionsEl.toggleClass("is-pinned", pinned);
		this.actionsEl.toggleClass("is-pinned-active", pinned);
		try {
			this.pinTrigger.empty();
			setIcon(this.pinTrigger, pinned ? "pin-off" : "pin");
		} catch { /* ignore */ }
	}

	/** 功能轨是否已完整展示（展开/钉住）：沉浸模式点按语义里视为「已显示」。
	 *  半隐藏待悬停态（默认滑出留 6px）不算——触屏无 hover，点按要负责把它完整滑出 */
	isActionsFullyShown(): boolean {
		return this.actionsEl.hasClass("is-expanded") || this.actionsEl.hasClass("is-pinned");
	}

	setBackHandler(onBack: () => void): void {
		this.backEl.onclick = e => {
			e.stopPropagation();
			onBack();
		};
	}

	setBackVisible(visible: boolean): void {
		this.backEl.toggleClass("is-visible", visible);
		this.backEl.toggleClass("is-hidden", !visible);
	}

	/** 由引擎提供展平条目（目录树 + 书源目录缺失章节的派生标题），按阅读顺序 */
	renderEntries(entries: NavEntryModel[], onSelect: (entry: NavEntryModel) => void): void {
		// **重建条目不能把「已经开着的面板」关掉**（2026-09-13 修）：
		// 这个方法由 `readerView.renderNavPanel()` 进，而后者除了开书时调一次，还会被
		// 适配器的 `onNavDerived` 回调再调一次 —— **派生条目（书源目录缺失章节的标题）
		// 是异步到达的**，于是「开书时自动打开的目录面板」刚建好就被这一次重建拆掉：
		// `panelEl.remove() / panelEl = null / open = false`，用户看到的是「自动打开目录面板
		// 这个开关完全没作用」。同样的道理，用户**手动**开着面板时来一次重渲染也会被关掉。
		// 面板必须重建（条目变了），但「开着 + 钉住」这个状态要延续下去。
		const wasOpen = this.open || this.buttonPinned;
		this.entries = entries;
		this.onSelect = onSelect;
		this.activeIndex = -1;
		this.detachDocListener();
		this.panelEl?.remove();
		this.panelEl = null;
		this.open = false;
		this.buttonPinned = false;
		// 与其它关闭路径同一收口（面板已摘掉，宿主侧的「作用中」高亮与按钮排展开态都要复位）
		this.syncPanelOpenState();


		this.clusterEl.querySelectorAll(".unreader-nav-node").forEach(el => el.remove());
		this.entries.forEach((entry, i) => {
			const node = document.createElement("span");
			node.className = "unreader-nav-node";
			node.dataset.navIndex = String(i);
			node.dataset.depth = String(Math.min(entry.depth, 3));
			node.setAttribute("aria-label", entry.label);
			node.createSpan({ cls: "unreader-nav-dash", attr: { "aria-hidden": "true" } });
			node.addEventListener("click", () => this.tapNode(i));
			// 悬停某条短横：在已展开的目录面板里同步高亮并滚动到对应行，
			// 让「摸到哪一条 = 面板里看到哪一章标题」（点击仍为跳转）
			node.addEventListener("mouseenter", () => this.preview(i));
			node.addEventListener("mouseleave", () => this.clearPreview());
			this.clusterEl.appendChild(node);
		});
		this.navEl.toggleClass("is-empty", !this.entries.length);
		this.actionsEl.toggleClass("is-visible", this.entries.length > 0);
		// 条目重建完成 → 把之前「开着」的状态接回去（见方法开头注释）
		if (wasOpen && this.entries.length) {
			this.buttonPinned = true;
			this.setPanel(true);
		}
	}

	setActive(tocId: number | null): void {
		let index = -1;
		if (tocId != null) index = this.entries.findIndex(e => e.navKey != null && e.navKey === tocId);
		this.setActiveIndex(index, true);
	}

	/** 更新每章的批注综合数量（高亮+书签），显示在面板行右侧。 */
	setCounts(counts: Map<number, number>): void {
		this.counts = new Map(counts);
		if (!this.panelEl) return;
		this.panelEl.querySelectorAll<HTMLElement>(".unreader-nav-row").forEach(row => {
			const idx = Number(row.dataset.navIndex);
			const entry = this.entries[idx];
			if (!entry) return;
			const badge = row.querySelector<HTMLElement>(".unreader-nav-count");
			if (!badge) return;
			const n = entry.id != null ? (this.counts.get(entry.id) ?? 0) : 0;
			if (n > 0) {
				badge.setText(String(n));
				badge.show();
			} else {
				badge.hide();
			}
		});
	}

	private setActiveIndex(index: number, scrollCluster: boolean): void {
		this.activeIndex = index;
		this.clusterEl.querySelectorAll(".unreader-nav-node").forEach(el => {
			el.toggleClass(
				"is-active",
				Number((el as HTMLElement).dataset.navIndex) === index,
			);
		});
		this.applyChapterProgress();
		if (scrollCluster && index >= 0) {
			const node = this.nodeAt(index);
			if (node) this.centerChild(this.clusterEl, node);
		}
		if (this.open && this.panelEl && index >= 0) {
			const row = this.panelEl.querySelector<HTMLElement>(
				`.unreader-nav-row[data-nav-index="${index}"]`,
			);
			if (row) this.centerChild(this.panelEl, row);
		}
	}

	/** 章节进度（0-1）：写进**当前章短横**的 `--p`，由 CSS 渲染为「轨道 + 填充」。
	 *  章节轨本身已用短横长度编码层级、accent 高亮编码当前章，唯独缺「本章读到哪」——
	 *  该数值正是这个缺口。故不再使用全宽底部细条（那个位置会和底栏/系统手势区
	 *  反复冲突，见 styles.css 注释）。 */
	setChapterProgress(fraction: number): void {
		this.chapterProgress = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
		this.applyChapterProgress();
	}

	/** 「章节进度」外观开关：关掉后当前章短横不再显示进度填充（仍是纯高亮） */
	setChapterProgressEnabled(on: boolean): void {
		this.chapterProgressOn = on;
		this.navEl.toggleClass("progress-off", !on);
	}

	/** 把进度值落到当前章节点上；无激活章则清除所有残留 */
	private applyChapterProgress(): void {
		const active = this.activeIndex >= 0 ? this.nodeAt(this.activeIndex) : null;
		this.clusterEl.querySelectorAll<HTMLElement>(".unreader-nav-node").forEach(el => {
			if (el === active) el.style.setProperty("--p", String(this.chapterProgress));
			else el.style.removeProperty("--p");
		});
	}

	private nodeAt(index: number): HTMLElement | null {
		return this.clusterEl.querySelector<HTMLElement>(
			`.unreader-nav-node[data-nav-index="${index}"]`,
		);
	}

	private jump(index: number): void {
		const entry = this.entries[index];
		if (!entry || !this.onSelect) return;
		this.onSelect(entry);
	}

	/** 点一条短横：hover 设备直接跳转；触屏设备只把该章带进面板（预览），**不跳转**。
	 *  触屏上短横与面板行只隔十几像素、又没有 hover 做二次确认，点一下就换章太容易
	 *  误触（用户 2026-09-13 报点）；触屏的跳转入口唯一 —— 点面板里的行。 */
	private tapNode(index: number): void {
		if (!this.hoverable) {
			this.preview(index);
			return;
		}
		this.jump(index);
	}

	/** 触屏划动/按下时的预览：按**坐标**找指尖下的那条短横（隐式捕获下 pointermove
	 *  会持续派发，划出轨道时不更新预览、也不清空 —— 保持上一次的预览行，
	 *  抬指后正好接着点它）。与 hover 的 preview 共用同一条面板联动通路。 */
	private previewTouchAt(x: number, y: number): void {
		const el = document.elementFromPoint(x, y) as HTMLElement | null;
		const node = el?.closest<HTMLElement>(".unreader-nav-node");
		if (!node) return;
		const i = Number(node.dataset.navIndex);
		if (Number.isFinite(i) && i >= 0) this.preview(i);
	}

	/** 悬停某条章节短横：目录面板已展开时，把对应行标成预览态并滚到面板中央，
	 *  完成「摸到哪一条 = 看到哪一章标题」的联动（面板未开则什么也不做）。 */
	private preview(index: number): void {
		if (!this.open || !this.panelEl) return;
		this.panelEl.querySelectorAll<HTMLElement>(".unreader-nav-row").forEach(row => {
			row.toggleClass("is-preview", Number(row.dataset.navIndex) === index);
		});
		const row = this.panelEl.querySelector<HTMLElement>(
			`.unreader-nav-row[data-nav-index="${index}"]`,
		);
		if (row) this.centerChild(this.panelEl, row);
	}

	/** 离开短横：清掉预览态，面板滚回当前章所在行。
	 *  **指针已经进到面板里时不回滚**：那正是「从短横平移到面板去点某一行」的过程，
	 *  此时把面板拉回当前章 = 光标底下的行当场被换掉（用户报的「拖到面板时对不上」），
	 *  点击就会落到另一章。清掉预览类不影响观感 —— 预览底色与行 hover 底色同色
	 *  （--background-modifier-hover），指针压在该行时看起来一模一样。 */
	private clearPreview(): void {
		if (!this.panelEl) return;
		this.stripPreview();
		if (!this.open || this.activeIndex < 0) return;
		try {
			if (this.panelEl.matches(":hover")) return;
		} catch { /* ignore */ }
		const row = this.panelEl.querySelector<HTMLElement>(
			`.unreader-nav-row[data-nav-index="${this.activeIndex}"]`,
		);
		if (row) this.centerChild(this.panelEl, row);
	}

	/** 清掉面板里所有悬停预览高亮（面板收起 / 重建时调用，避免残留）。 */
	private stripPreview(): void {
		this.panelEl
			?.querySelectorAll<HTMLElement>(".unreader-nav-row.is-preview")
			.forEach(row => row.removeClass("is-preview"));
	}

	private openPanel(): void {
		if (this.buttonPinned) return;
		if (window.matchMedia("(hover: none)").matches) return;
		// 悬停在页码上时不展开目录面板，避免面板遮挡页码
		try {
			if (this.pageEl.matches(":hover")) return;
		} catch { /* ignore */ }
		// 悬停触发：面板带到轨道旁 —— 若当前锚在按钮侧（actions）则原地换锚
		// （setPanel 对已开面板会 early-return，必须在这里处理换锚）
		if (this.open && this.panelAnchor === "actions") {
			this.panelAnchor = "rail";
			this.buttonPinned = false;
			this.applyAnchor();
			return;
		}
		this.panelAnchor = "rail";
		this.setPanel(true);
	}

	/** 右缘轨道触发展开（触摸点按轨道 / 触屏长按）：面板出现在轨道旁。
	 *  若面板当前锚在左侧按钮（actions），原地换锚到轨道旁 —— 两种触发方式
	 *  各自把面板带到自己附近，而不是固定在同一侧。 */
	private openAtRail(): void {
		if (this.open && this.panelAnchor === "actions") {
			this.panelAnchor = "rail";
			this.buttonPinned = false;
			this.applyAnchor();
			return;
		}
		this.panelAnchor = "rail";
		this.setPanel(true);
	}

	private setPanel(open: boolean): void {
		if (open === this.open) return;
		if (!open) {
			// Hover 触发的关闭不应打断通过目录按钮钉住的状态
			if (this.buttonPinned) return;
			this.open = false;
			this.panelEl?.removeClass("is-open");
			this.stripPreview();
			this.detachDocListener();
			this.syncPanelOpenState();
			return;
		}
		if (!this.entries.length) return;
		this.open = true;
		const panel = this.ensurePanel();
		this.applyAnchor();
		panel.addClass("is-open");
		this.syncPanelOpenState();
		panel.querySelectorAll(".unreader-nav-row").forEach(row =>
			row.toggleClass("is-active", Number((row as HTMLElement).dataset.navIndex) === this.activeIndex),
		);
		if (this.activeIndex >= 0) {
			const row = panel.querySelector<HTMLElement>(`.unreader-nav-row[data-nav-index="${this.activeIndex}"]`);
			if (row) this.centerChild(panel, row);
		}
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
	}

	/** 按钮框内挂有展开的面板时，功能轨保持完全展开（is-panel-open）：
	 *  否则鼠标离开按钮区后按钮框回到半隐藏位移，会把面板一起拽出屏幕外。
	 *  不用 :has() 选择器，行为由 JS 显式控制、各路径统一收口。 */
	private syncPanelOpenState(): void {
		this.actionsEl.toggleClass("is-panel-open", this.open && this.panelAnchor === "actions");
		this.syncBridge();
		this.onPanelOpenChange?.(this.open);
	}

	/** 悬停通路桥的激活闸门：只有「面板正开在右缘轨旁 + 轨可见」才让它接管指针。
	 *  其余情形（面板没开 / 开在功能按钮排旁 / 轨被外观设置关掉）必须完全隐形 ——
	 *  桥是一块不可见的命中区，误激活就等于右缘那条缝在吞点按。 */
	private syncBridge(): void {
		this.nodesEl.toggleClass(
			"is-panel-live",
			this.open && this.panelAnchor === "rail" && this.railVisible,
		);
	}

	/** 目录面板挂载点随锚点切换：rail → nodesEl（右缘），actions → 功能按钮排内（面板出现在按钮旁） */
	private applyAnchor(): void {
		if (!this.panelEl) return;
		if (this.panelAnchor === "actions") {
			this.actionsEl.appendChild(this.panelEl);
			this.panelEl.addClass("is-at-actions");
			// 垂直对准「目录」按钮中心（offsetParent 是 absolute 定位的 actionsEl）
			const t = this.tocTrigger;
			if (t) this.panelEl.style.top = `${t.offsetTop + t.offsetHeight / 2}px`;
		} else {
			this.nodesEl.appendChild(this.panelEl);
			this.panelEl.removeClass("is-at-actions");
			this.panelEl.style.removeProperty("top");
		}
		this.syncPanelOpenState();
	}

	isPanelOpen(): boolean {
		return this.open;
	}

	/** 强制关闭目录面板（触屏点正文/外部时调用），绕过 buttonPinned 钉住拦截 */
	closePanel(): void {
		if (!this.open) return;
		this.buttonPinned = false;
		this.open = false;
		this.panelEl?.removeClass("is-open");
		this.stripPreview();
		this.detachDocListener();
		this.syncPanelOpenState();
	}

	/** 确保面板处于**打开**态（已开着就什么都不做）。
	 *  给「打开」语义的调用方用 —— `togglePanel()` 是二态切换，拿它去「打开」一个
	 *  已经开着的面板会**把它关掉**（实测：在有书的窗口里把「自动打开目录面板」拨到
	 *  「开」，面板本来开着、结果被关掉，用户看到的是反向效果）。 */
	ensurePanelOpen(): void {
		if (this.open) return;
		this.buttonPinned = true;
		this.setPanel(true);
	}

	togglePanel(anchor: "rail" | "actions" = "rail"): void {
		// 已开面板且锚点变化（如按钮唤出时悬停面板还开着）→ 原地换锚点，保持展开
		if (this.open && this.panelAnchor !== anchor) {
			this.panelAnchor = anchor;
			this.buttonPinned = true;
			this.applyAnchor();
			return;
		}
		this.panelAnchor = anchor;
		if (this.buttonPinned) {
			this.buttonPinned = false;
			this.setPanel(false);
		} else {
			this.buttonPinned = true;
			this.setPanel(true);
		}
	}

	/** 记录「目录」触发按钮：外部点击关闭逻辑需放行该按钮（否则 pointerdown 先关、click 再开，表现为关不掉） */
	setTocTrigger(el: HTMLElement): void {
		this.tocTrigger = el;
	}

	/** 书页内点击外部（iframe 事件不冒泡到 document，宿主统一转调）：
	 *  按钮唤出的面板一律关闭；轨道悬停面板尊重钉住状态 */
	outsideTap(): void {
		if (!this.open) return;
		if (this.panelAnchor === "actions") this.closePanel();
		else this.setPanel(false);
	}

	/** 章节短横轨显隐：隐藏仅收起短横轨，目录面板仍可由工具栏按钮/命令唤起 */
	setRailVisible(visible: boolean): void {
		if (this.railVisible === visible) return;
		this.railVisible = visible;
		this.nodesEl.toggleClass("is-rail-off", !visible);
		if (!visible) this.setPanel(false);
		// 轨重新出现而面板还开着时，桥要跟着激活（上面的早退分支不会走到这里）
		else this.syncBridge();
	}

	clickableCount(): number {
		return this.entries.length;
	}

	private ensurePanel(): HTMLElement {
		if (this.panelEl) return this.panelEl;
		const panel = this.nodesEl.createDiv({ cls: "unreader-nav-panel" });
		panel.setAttribute("role", "menu");
		// 面板可能被搬到功能按钮排内锚定（见 setPanelAnchor）：无论挂在哪一侧，
		// 在章节列表里上下划动都只该滚动列表，不该把原生抽屉划出来
		panel.setAttribute("data-ignore-swipe", "true");
		this.entries.forEach((entry, i) => {
			const row = document.createElement("button");
			row.type = "button";
			row.setAttribute("role", "menuitem");
			row.className = "unreader-nav-row";
			row.dataset.navIndex = String(i);
			const depth = Math.min(entry.depth, 3);
			row.dataset.depth = String(depth);
			row.style.paddingLeft = `${10 + depth * 18}px`;
			row.style.paddingRight = NAV_ROW_PAD_RIGHT;
			row.createSpan({ cls: "unreader-nav-row-text", text: entry.label });
			const badge = row.createSpan({ cls: "unreader-nav-count" });
			{
				const n = entry.id != null ? (this.counts.get(entry.id) ?? 0) : 0;
				if (n > 0) badge.setText(String(n));
				else badge.hide();
			}
			// 行最右侧：该章起始页码（全书字节估算，与页码显示同口径）
			const pageSpan = row.createSpan({ cls: "unreader-nav-row-page" });
			{
				const page = entry.id != null ? this.tocPages.get(entry.id) : undefined;
				if (page != null) pageSpan.setText(String(page));
				else pageSpan.hide();
			}
			row.addEventListener("click", () => {
				this.jump(i);
				this.buttonPinned = false;
				this.open = false;
				this.panelEl?.removeClass("is-open");
				this.detachDocListener();
				this.syncPanelOpenState();
			});
			panel.appendChild(row);
		});
		this.panelEl = panel;
		return panel;
	}

	private onDocPointerDown = (ev: PointerEvent): void => {
		const target = ev.target as HTMLElement | null;
		if (!target) return;
		if (this.panelEl?.contains(target)) return;
		// 「目录」按钮本身放行：让按钮的 click 走 toggle 关闭，而不是这里强关后再被 click 重开
		if (this.tocTrigger?.contains(target)) return;
		// 通路桥只是悬停保留区（视觉上是正文右缘那条空白缝），命中它等同点外面；
		// 必须在下面的 nodesEl 放行**之前**拦掉，否则这块缝会吞掉「点空白关面板」
		if (this.nodesEl.contains(target) && !this.bridgeEl.contains(target)) return;
		if (this.pageEl.contains(target)) return;
		this.buttonPinned = false;
		// 强制关闭，绕过 buttonPinned 拦截
		this.open = false;
		this.panelEl?.removeClass("is-open");
		this.detachDocListener();
		// 必须走收口：先前漏了这一步，`is-panel-open` 会留在按钮排上
		// （按钮排保持完全滑出、且宿主侧「目录」按钮的高亮不复位）
		this.syncPanelOpenState();
	};

	private detachDocListener(): void {
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
	}

	/**
	 * 把 child 滚到 container 垂直中央 —— 即「高亮条居中跟随」的核心：
	 * 目标章在首/尾附近时会被 clamp 在 0 / maxScroll，于是高亮条从顶部
	 * 逐步下移，走到能居中之后固定在中间（整条滚动），直到滚到末端再继续
	 * 往下走完。章节轨与目录面板共用这一套逻辑。
	 */
	private centerChild(container: HTMLElement, child: HTMLElement): void {
		const containerRect = container.getBoundingClientRect();
		const childRect = child.getBoundingClientRect();
		const delta =
			childRect.top + childRect.height / 2 - (containerRect.top + containerRect.height / 2);
		if (Math.abs(delta) < 1) return;
		const max = Math.max(0, container.scrollHeight - container.clientHeight);
		const next = Math.max(0, Math.min(max, container.scrollTop + delta));
		if (next !== container.scrollTop) container.scrollTop = next;
	}
}
