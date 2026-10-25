/** Markdown 笔记卡片渲染（阅读器的「笔记」页 / Markdown 阅读模式的笔记抽屉共用一份）。
 *
 *  抽出来的原因有两条：
 *  · 行为只有一份 —— 卡片点开、置顶往返、空态文案在两处必须逐字一致，复制两份必然漂移；
 *  · 架构边界 —— `mdOverlay` 不该 import `annotationsPanel`（那条链会拉进
 *    engineAdapter / foliate 等整个阅读器引擎），共享渲染器是更细的接缝。 */

import type { MarkdownNoteListItem } from "../types";
import { createCardActionButton } from "./cardActions";
import { mountCardThumb, type CardThumb } from "./cardThumb";
import { attachCardDetails, type CardDetailRow, type CardDetailSection, type CardDetailsContent } from "./cardDetailsPopover";
import { formatReadingDuration, getReadingStat, noteStatKey } from "../core/readingStatsStore";
import { formatWordCount } from "../core/wordCount";

export interface MarkdownNoteData {
	recent: MarkdownNoteListItem[]
	starred: MarkdownNoteListItem[]
}

export interface MarkdownNoteCardActions {
	onOpen?: (path: string) => void
	onTogglePin?: (path: string) => void
	onOpenAnnotations?: (path: string) => void
	onContextMenu?: (path: string, event: MouseEvent) => void
	/** 在 Obsidian 的文件浏览器里定位到这篇笔记（`app.showInFolder`）。
	 *  不给 = 不渲染那枚按钮（宿主没有「定位」能力时不留死按钮）。 */
	onRevealInFolder?: (path: string) => void
	/** 字数供给：读盘统计后回填底栏最左的字数位。**异步**是必须的 —— 笔记正文在磁盘上，
	 *  渲染是同步的；解析不到时显示占位符，绝不阻塞列表。
	 *  不给 = 字数位恒显示占位（宿主拿不到 vault 时不留假数字）。 */
	resolveWordCount?: (path: string) => Promise<number | null>
	/** 缩略图接线：由调用方负责「可见即加载 + 取图 + 显示」并**自己建**缩略图列。
	 *  不给 = 笔记卡不做缩略图（连列都不建，卡片就是纯文字全宽）。
	 *  之所以让调用方建列：本模块拿不到抽屉的滚动容器（`IntersectionObserver` 的 root），
	 *  而取图又必须走调用方的懒加载观察器 —— 这里只暴露接缝，不塞第二套默认实现。 */
	attachThumb?: (card: HTMLElement, path: string, thumb: CardThumb) => void
	/** 正文预览供给：返回一段 **Markdown 源文本**（不是纯文本）。异步是必须的 —— 正文在
	 *  磁盘上，渲染是同步的。不给 = 笔记卡不留预览行（标题下面就是空，与旧版一致）。 */
	resolveExcerpt?: (path: string) => Promise<string | null>
	/** 预览渲染器：宿主注入 `MarkdownRenderer.render(app, md, el, path, component)`。
	 *  本模块**不 import obsidian 渲染器** —— 一是不该把「文档渲染」拉进纯 DOM 层，
	 *  二是探针夹具的 stub 里没有它。不给 = 预览退化成纯文本（语法符号会露出来，只作兜底）。 */
	renderMarkdown?: (el: HTMLElement, markdown: string, sourcePath: string) => void | Promise<void>
}

/** 相对时间（「刚刚 / N 分钟前 / N 天前 / X月X日」）。 */
export function formatRecentRead(updatedAt: number): string {
	if (!updatedAt || !Number.isFinite(updatedAt)) return "尚未阅读";
	const delta = Math.max(0, Date.now() - updatedAt);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (delta < minute) return "刚刚";
	if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
	if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
	if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
	const date = new Date(updatedAt);
	return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 置顶笔记在面板里**默认露出的条数**：超过就把置顶组限高、内部滚动，避免置顶多了
 *  把「最近阅读」整组顶到很下面（用户 2026-10-10：置顶最多显示 5 个，再多可滚动）。 */
export const STARRED_NOTE_VISIBLE_LIMIT = 5;
const starredLayoutCleanup = new WeakMap<HTMLElement, () => void>();
const markdownNoteSignatures = new WeakMap<HTMLElement, string>();

export function markdownNoteSignature(card: HTMLElement): string | undefined {
	return markdownNoteSignatures.get(card);
}

export function disposeMarkdownNotesLayout(container: HTMLElement): void {
	starredLayoutCleanup.get(container)?.();
	starredLayoutCleanup.delete(container);
}

export function refreshMarkdownNotesLayout(container: HTMLElement): void {
	disposeMarkdownNotesLayout(container);
	const group = container.querySelector<HTMLElement>(".unreader-note-group-starred");
	if (!group || group.children.length <= STARRED_NOTE_VISIBLE_LIMIT) return;
	const win = container.ownerDocument.defaultView ?? window;
	win.requestAnimationFrame(() => capStarredGroupHeight(group));
	const ResizeObserverCtor = win.ResizeObserver;
	if (!ResizeObserverCtor) return;
	let frame = 0;
	const observer = new ResizeObserverCtor(() => {
		if (frame) win.cancelAnimationFrame(frame);
		frame = win.requestAnimationFrame(() => { frame = 0; capStarredGroupHeight(group); });
	});
	for (const card of Array.from(group.children)) observer.observe(card);
	starredLayoutCleanup.set(container, () => { observer.disconnect(); if (frame) win.cancelAnimationFrame(frame); });
}

/** 字数还没算出来 / 算不出来时的占位。**不写 0** —— 0 是一个「这篇笔记是空的」的断言，
 *  而「还没读盘」不构成这个断言。 */
const WORDS_PENDING = "…";
const WORDS_UNKNOWN = "—";

/** 把「置顶 + 最近阅读」两组渲染进容器（会先清空容器）。
 *  置顶在上、最近阅读在下；置顶超过 {@link STARRED_NOTE_VISIBLE_LIMIT} 条时，置顶组
 *  限高为前 N 张卡片的实测总高，超出部分组内滚动（不写死像素 —— 卡片高随标题折行变）。
 *  两组都空时只留一句空态说明 —— 这里**不**扫描全库笔记，只列索引里有的。 */
export function renderMarkdownNotes(
	container: HTMLElement,
	data: MarkdownNoteData,
	actions: MarkdownNoteCardActions,
): void {
	disposeMarkdownNotesLayout(container);
	container.empty();
	const { recent, starred } = data;
	if (!recent.length && !starred.length) {
		container.createDiv({
			cls: "unreader-toc-empty",
			text: "还没有最近阅读的笔记。用 Obsidian 原生阅读模式打开 Markdown 笔记后，这里会保留最近 12 篇；点笔记卡片上的图钉可置顶。",
		});
		return;
	}
	// 置顶组排在最上面（用户 2026-10-10）。
	if (starred.length) {
		container.createDiv({ cls: "unreader-note-group-title", text: `置顶笔记 · ${starred.length}` });
		const group = container.createDiv({ cls: "unreader-note-group unreader-note-group-starred" });
		for (const item of starred) appendCard(group, item, "starred", actions);
		group.toggleClass("is-scrollable", starred.length > STARRED_NOTE_VISIBLE_LIMIT);
		// 超过露出上限才限高：用前 N 张卡片的实测高度（含组内 gap），rAF 里量 ——
		// 此刻卡片刚插入、宽度已由打开的面板决定，offsetHeight 可用；预览和缩略图异步落定后
		// 由 ResizeObserver 再量一次，避免滚动区仍沿用加载前的旧高度。
		if (starred.length > STARRED_NOTE_VISIBLE_LIMIT) refreshMarkdownNotesLayout(container);
	}
	if (recent.length) {
		container.createDiv({ cls: "unreader-note-group-title", text: `最近阅读 · ${recent.length}` });
		const group = container.createDiv({ cls: "unreader-note-group" });
		for (const item of recent) appendCard(group, item, "recent", actions);
	}
}

/** 把置顶组的 max-height 钉在「前 N 张卡片 + 间隙」的实测高度上，超出由组内滚动呈现。 */
function capStarredGroupHeight(group: HTMLElement): void {
	const cards = Array.from(group.children).filter(el => el instanceof HTMLElement) as HTMLElement[];
	const isScrollable = cards.length > STARRED_NOTE_VISIBLE_LIMIT;
	group.toggleClass("is-scrollable", isScrollable);
	if (!isScrollable) {
		group.style.removeProperty("max-height");
		return;
	}
	const cap = cards.slice(0, STARRED_NOTE_VISIBLE_LIMIT);
	if (!cap.length) return;
	const gap = Number.parseFloat(getComputedStyle(group).rowGap || getComputedStyle(group).gap || "0") || 0;
	const total = cap.reduce((sum, el) => sum + el.offsetHeight, 0) + gap * (cap.length - 1);
	const win = group.ownerDocument.defaultView ?? window;
	const mobileLimit = win.matchMedia?.("(max-width: 600px)").matches ? win.innerHeight * 0.38 : Number.POSITIVE_INFINITY;
	group.style.maxHeight = `${Math.ceil(Math.min(total, mobileLimit))}px`;
}

function appendCard(
	group: HTMLElement,
	item: MarkdownNoteListItem,
	source: "recent" | "starred",
	actions: MarkdownNoteCardActions,
): void {
	const card = group.createDiv({ cls: "unreader-note-card" });
	markdownNoteSignatures.set(card, JSON.stringify({ item, source }));
	card.dataset.path = item.path;
	card.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); actions.onContextMenu?.(item.path, e); });
	card.setAttribute("role", "button");
	card.setAttribute("tabindex", "0");
	card.setAttribute("aria-label", `打开笔记：${item.title}`);
	card.addEventListener("click", e => {
		const target = e.target as HTMLElement | null;
		if (target?.closest(".unreader-note-actions, button, a")) return;
		actions.onOpen?.(item.path);
	});
	card.addEventListener("keydown", e => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		actions.onOpen?.(item.path);
	});

	// 骨架与书架 / 订阅卡同构：文字全在第 1 列（`.unreader-note-body` 是**唯一**在流内的
	// 直接子元素），缩略图列在第 2 列且默认隐藏。
	// 卡片 = 网格 2 行：第 1 行 = 标题 + 正文预览（钳 2 行，第 1 列）｜缩略图（第 2 列，固定 3:4）；
	// 第 2 行 = **通栏底栏** `.unreader-card-foot`（最左字数 + 最右动作钮）。
	const body = card.createDiv({ cls: "unreader-note-body" });
	body.createDiv({ cls: "unreader-note-title", text: item.title || "未命名笔记" });
	// 正文预览（用户 2026-10-17）：「标题下面那段空白里写上笔记最强的一些字，用来预览，
	// 要渲染 markdown 格式」—— 与 RSS 卡「订阅名 + 简介」占的是**同一格**（第 1 行第 1 列），
	// 三张卡扫下来行数才齐。渲染走宿主注入的 `MarkdownRenderer`（这里只建容器），
	// 所以 `**粗体**` / 列表 / `==高亮==` 在卡片上就是真的粗体和列表，不是语法符号。
	// 有正文供给时先预留最终两行预览的高度，避免读盘 / Markdown 渲染完成后
	// 突然把整组等高卡片一起撑高。还不知道结果时保持不可见；空笔记和失败会撤掉预留。
	const excerpt = body.createDiv({ cls: `unreader-note-excerpt ${actions.resolveExcerpt ? "is-pending" : "is-hidden"}` });
	if (actions.resolveExcerpt) {
		void actions.resolveExcerpt(item.path).then(markdown => {
			const text = (markdown ?? "").trim();
			// 卡片可能已被重绘移除（切页 / 星标都整体重绘一次）：先确认还挂在文档里再写。
			if (!excerpt.isConnected) return;
			if (!text) {
				excerpt.removeClass("is-pending");
				excerpt.addClass("is-hidden");
				resettleStarredGroupHeight(card);
				return;
			}
			excerpt.empty();
			const render = actions.renderMarkdown;
			// 先显形再渲染：渲染器（MathJax / mermaid）在 `display:none` 里可能量不到宽。
			const done = render ? render(excerpt, text, item.path) : undefined;
			if (!render) excerpt.setText(text);
			// 渲染是异步的（`MarkdownRenderer.render` 返回 Promise），高度要等它落定才知道 ——
			// 置顶组是限高 + 组内滚动，新高度不重钉就会被裁掉（与缩略图同一条规矩）。
			return Promise.resolve(done).then(() => {
				if (!excerpt.isConnected) return;
				// 渲染完再清一遍：剩下的每个节点都必须真的有字，否则整块藏起来（卡片不留空行）。
				if (!pruneNotePreview(excerpt)) {
					excerpt.empty();
					excerpt.removeClass("is-pending");
					excerpt.addClass("is-hidden");
					resettleStarredGroupHeight(card);
					return;
				}
				excerpt.removeClass("is-pending");
				excerpt.addClass("has-preview");
				resettleStarredGroupHeight(card);
			});
		}).catch(() => {
			// 读盘或渲染失败都撤掉加载占位，避免留一块空白或半截预览。
			if (!excerpt.isConnected) return;
			excerpt.empty();
			excerpt.removeClass("is-pending");
			excerpt.addClass("is-hidden");
			resettleStarredGroupHeight(card);
		});
	}

	// 底栏最左**不再是进度环**（用户 2026-10-13：「markdown 格式不需要阅读进度环，
	// 然后把字数放在进度环的位置」）：Markdown 笔记的阅读位置由官方阅读模式自己记，
	// 插件本来就没有可信的百分比，硬造一个假环不如给一个真实数字。
	const foot = card.createDiv({ cls: "unreader-card-foot" });
	const words = foot.createDiv({ cls: "unreader-note-words", text: WORDS_PENDING });
	words.setAttribute("aria-label", "字数统计中");
	// 详情看板要现读这个数字，用闭包变量托住（resolve 是异步的，看板可能之后才开）。
	let wordCount: number | null = null;
	if (actions.resolveWordCount) {
		void actions.resolveWordCount(item.path).then(count => {
			// 卡片可能已被重绘移除：先确认还挂在文档里再写。
			if (!words.isConnected) return;
			wordCount = count;
			const text = count == null ? WORDS_UNKNOWN : formatWordCount(count);
			words.setText(text);
			words.setAttribute("aria-label", count == null ? "字数未知" : `字数 ${text}`);
		}).catch(() => {
			if (words.isConnected) words.setText(WORDS_UNKNOWN);
		});
	} else {
		words.setText(WORDS_UNKNOWN);
		words.setAttribute("aria-label", "字数未知");
	}

	// 动作钮：查看标注 + 复制路径 + 定位到文件夹 + 置顶 + ⋯（原生文件菜单）。
	// 三类卡里笔记最少动作 —— 它没有「抓全文 / 存笔记」这类内容加工动作。
	// 2026-10-13 曾删掉过一枚「⋯ 菜单」（当时菜单里那几项各自都有了按钮）；
	// 2026-10-17 用户要求加回来，但**语义不同**：这枚弹的是 Obsidian 原生文件菜单
	// （重命名 / 移动 / 删除 / 打开方式…），只有 vault 里真实存在的文件才配拥有它。
	const pinned = item.starredAt != null;
	const actionsEl = foot.createDiv({ cls: "unreader-note-actions" });
	const annotations = createNoteAction(actionsEl, "unreader-card-annotations", "highlighter", "▰", "查看标注");
	annotations.addEventListener("click", e => { e.stopPropagation(); actions.onOpenAnnotations?.(item.path); });

	const copy = createNoteAction(actionsEl, "unreader-note-copy", "copy", "复", "复制路径");
	copy.addEventListener("click", e => {
		e.stopPropagation();
		void copyNotePath(item.path);
	});

	if (actions.onRevealInFolder) {
		const reveal = createNoteAction(actionsEl, "unreader-note-reveal", "folder-open", "位", "在文件浏览器中定位");
		reveal.addEventListener("click", e => {
			e.stopPropagation();
			actions.onRevealInFolder?.(item.path);
		});
	}

	const pin = createNoteAction(actionsEl, "unreader-note-pin", pinned ? "pin-off" : "pin", pinned ? "撤" : "置", pinned ? "取消置顶" : "置顶笔记", pinned);
	pin.toggleClass("is-pinned", pinned);
	pin.addEventListener("click", e => {
		e.stopPropagation();
		actions.onTogglePin?.(item.path);
	});

	// 「⋯」：弹 Obsidian 的**原生文件菜单**（用户 2026-10-17：「三个点按钮应该在
	// markdown 笔记和电子书两种存在，因为这两个在笔记文件库中存在所以可以有右键菜单，
	// rss 没有所以 rss 不要三个点按钮」）。位置固定在动作组**最后**= 最右。
	// 宿主没给 `onContextMenu` 就不渲染 —— 绝不留「点了没反应」的死按钮。
	if (actions.onContextMenu) {
		const more = createNoteAction(actionsEl, "unreader-note-more", "ellipsis-vertical", "⋯", "更多操作（Obsidian 原生文件菜单）");
		more.addEventListener("click", e => {
			e.stopPropagation();
			actions.onContextMenu?.(item.path, e);
		});
	}

	// 悬停看板：路径 / 时间 / frontmatter 元数据 / 阅读时长 —— 底栏里被拿掉的信息都在这。
	// 锚点用字数位（原来那枚环的位置）：点它同样是「看详情」。
	attachCardDetails(card, () => noteDetailsContent(item, source, wordCount), words);

	// 缩略图列：末子节点。宿主没给 `attachThumb` 就连列都不建（纯文字全宽）。
	if (actions.attachThumb) actions.attachThumb(card, item.path, mountCardThumb(card));
}

/** 笔记卡动作钮与书架/RSS共用实际 button 元素、键盘行为和图标兜底。 */
function createNoteAction(
	parent: HTMLElement,
	cls: string,
	icon: string,
	fallback: string,
	label: string,
	pressed?: boolean,
): HTMLButtonElement {
	return createCardActionButton(parent, { cls, icon, fallback, label, pressed });
}

/** 复制笔记路径。剪贴板不可用时静默失败 —— 侧栏里弹一条错误提示比「没复制上」更打扰；
 *  用户可再用系统菜单复制。 */
async function copyNotePath(path: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(path);
	} catch {
		/* 无剪贴板权限 / 非安全上下文：忽略 */
	}
}

/** 笔记卡的详情看板内容。元数据（frontmatter）单独成段 —— 用户 2026-10-13 明确要求。 */
function noteDetailsContent(
	item: MarkdownNoteListItem,
	source: "recent" | "starred",
	wordCount: number | null,
): CardDetailsContent {
	const read = item.openedAt != null;
	const stat = getReadingStat(noteStatKey(item.path));
	const reading: CardDetailRow[] = [];
	if (wordCount != null) reading.push({ label: "字数", value: formatWordCount(wordCount), tone: "accent" });
	reading.push({ label: "阅读状态", value: read ? "已读" : "未读", tone: read ? "muted" : "accent" });
	reading.push({ label: "累计阅读", value: stat?.ms ? (formatReadingDuration(stat.ms) || "不足 1 分钟") : "暂无记录" });
	if (stat?.lastAt) reading.push({ label: "上次阅读", value: formatRecentRead(stat.lastAt) });
	if (item.openedAt) reading.push({ label: "最近打开", value: formatRecentRead(item.openedAt) });
	if (stat?.sessions) reading.push({ label: "阅读次数", value: `${stat.sessions} 次`, tone: "muted" });

	const file: CardDetailRow[] = [
		{ label: "修改于", value: formatRecentRead(item.mtime) },
		{ label: "路径", value: item.path, tone: "muted" },
	];
	if (item.starredAt) file.push({ label: "置顶于", value: formatRecentRead(item.starredAt) });
	file.push({ label: "来源", value: source === "starred" ? "置顶笔记" : "最近阅读", tone: "muted" });

	const sections: CardDetailSection[] = [{ title: "阅读", rows: reading }, { title: "文件", rows: file }];

	const meta = item.meta;
	if (meta && (meta.tags?.length || meta.aliases?.length || meta.extra?.length)) {
		const rows: CardDetailRow[] = [];
		if (meta.aliases?.length) rows.push({ label: "别名", value: meta.aliases.join("、") });
		for (const pair of meta.extra ?? []) rows.push({ label: pair.key, value: pair.value });
		sections.push({ title: "元数据", rows, chips: meta.tags });
	}
	return {
		title: item.title || "未命名笔记",
		subtitle: wordCount != null ? formatWordCount(wordCount) : (read ? "已读" : "未读"),
		sections,
	};
}

/** 渲染后清场：删掉预览里**不显示 / 没内容**的节点，保证内容区没有「占着却不显示」的空档。
 *
 *  为什么提取层已经过滤过、渲染后还要清一遍：`MarkdownRenderer` 会把源码变成 DOM ——
 *  图片被删后可能留下空 `<p>`、`<br>` 会连着出现、`$$…$$` 会变成一整块 MathJax、
 *  `%%注释%%` 会变成一个空节点。这些在 `display:none` 下不占**布局**，但会让「预览到底
 *  有没有内容」失真（`:empty`、高度、主题描边都可能被它们带偏），而且删完之后
 *  `resettleStarredGroupHeight` 量到的才是真实高度（用户 2026-10-18：「确保没有浪费的空间」）。
 *
 *  返回 false = 清完什么都不剩 —— 调用方据此把整块藏起来，卡片不留一行空白。 */
export function pruneNotePreview(root: HTMLElement): boolean {
	// ① 媒体 / 结构类：预览里根本不显示它们，直接删（而不是只 display:none）。
	root.querySelectorAll("img, picture, video, audio, iframe, canvas, svg, pre, table, hr")
		.forEach(node => node.remove());
	// ② 空盒子（图被删后留下的 `<p></p>`）：没有子元素也没有字，删。
	//    ⚠️ 必须**倒序**（从内到外）：正序时先访问 `<p><span><svg/></span></p>` 里的 p，此刻
	//    它还有子元素 ⇒ 跳过；等轮到 span 被删空，p 已经遍历过了，于是留下一个空 `<p>`
	//    （2026-10-18 探针实测：`math-only` 清完还剩一个 p，卡片上就是一条空白）。
	const empties = Array.from(root.querySelectorAll("p, div, span, li, blockquote"));
	for (let index = empties.length - 1; index >= 0; index--) {
		const node = empties[index];
		if (!node || !node.isConnected) continue;
		if (node.querySelector("*")) continue;
		if ((node.textContent ?? "").trim()) continue;
		node.remove();
	}
	// ③ 多余的 `<br>`：行首、连续、以及**紧跟在块元素后面**的（块自己就会换行）。
	//    正文中间的真硬换行（`文字<br>接着`）必须留 —— 一刀切会把整段挤成一行。
	const BLOCKISH = new Set(["P", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "TABLE"]);
	for (const br of Array.from(root.querySelectorAll("br"))) {
		if (!br.isConnected) continue;
		const previous = br.previousSibling;
		const atLineStart = !previous
			|| (previous.nodeType === 3 && !(previous.textContent ?? "").trim());
		const afterBlock = previous?.nodeType === 1 && BLOCKISH.has(previous.nodeName);
		if (atLineStart || afterBlock || previous?.nodeName === "BR") br.remove();
	}
	return !!(root.textContent ?? "").trim();
}

/** 缩略图异步就位后卡片会变高：若这张卡在**限高**的置顶组里，必须重新钉一次组高，
 *  否则新高度会溢出组外（`max-height` 是按前 N 张卡片的实测高度算的）。 */
export function resettleStarredGroupHeight(card: HTMLElement): void {
	const group = card.parentElement;
	if (!group?.hasClass("unreader-note-group-starred")) return;
	if (group.children.length > STARRED_NOTE_VISIBLE_LIMIT) capStarredGroupHeight(group);
}
