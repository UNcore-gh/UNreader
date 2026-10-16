/** Markdown 笔记卡片渲染（阅读器的「笔记」页 / Markdown 阅读模式的笔记抽屉共用一份）。
 *
 *  抽出来的原因有两条：
 *  · 行为只有一份 —— 卡片点开、星标往返、空态文案在两处必须逐字一致，复制两份必然漂移；
 *  · 架构边界 —— `mdOverlay` 不该 import `annotationsPanel`（那条链会拉进
 *    engineAdapter / foliate 等整个阅读器引擎），共享渲染器是更细的接缝。 */

import { setIcon } from "obsidian";
import type { MarkdownNoteListItem } from "../types";
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
	onToggleStar?: (path: string) => void
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

/** 星标笔记在面板里**默认露出的条数**：超过就把星标组限高、内部滚动，避免收藏多了
 *  把「最近阅读」整组顶到很下面（用户 2026-10-10：星标最多显示 5 个，再多可滚动）。 */
export const STARRED_NOTE_VISIBLE_LIMIT = 5;

/** 字数还没算出来 / 算不出来时的占位。**不写 0** —— 0 是一个「这篇笔记是空的」的断言，
 *  而「还没读盘」不构成这个断言。 */
const WORDS_PENDING = "…";
const WORDS_UNKNOWN = "—";

/** 把「星标 + 最近阅读」两组渲染进容器（会先清空容器）。
 *  星标在上、最近阅读在下；星标超过 {@link STARRED_NOTE_VISIBLE_LIMIT} 条时，星标组
 *  限高为前 N 张卡片的实测总高，超出部分组内滚动（不写死像素 —— 卡片高随标题折行变）。
 *  两组都空时只留一句空态说明 —— 这里**不**扫描全库笔记，只列索引里有的。 */
export function renderMarkdownNotes(
	container: HTMLElement,
	data: MarkdownNoteData,
	actions: MarkdownNoteCardActions,
): void {
	container.empty();
	const { recent, starred } = data;
	if (!recent.length && !starred.length) {
		container.createDiv({
			cls: "unreader-toc-empty",
			text: "还没有最近阅读的笔记。用 Obsidian 原生阅读模式打开 Markdown 笔记后，这里会保留最近 12 篇；点笔记卡片上的星标可加入收藏。",
		});
		return;
	}
	// 星标组排在最上面（用户 2026-10-10）。
	if (starred.length) {
		container.createDiv({ cls: "unreader-note-group-title", text: `星标笔记 · ${starred.length}` });
		const group = container.createDiv({ cls: "unreader-note-group unreader-note-group-starred" });
		for (const item of starred) appendCard(group, item, "starred", actions);
		// 超过露出上限才限高：用前 N 张卡片的实测高度（含组内 gap），rAF 里量 ——
		// 此刻卡片刚插入、宽度已由打开的面板决定，offsetHeight 可用；字体/图片异步撑高
		// 不影响笔记卡（只有文字单行省略）。
		if (starred.length > STARRED_NOTE_VISIBLE_LIMIT) {
			const win = container.ownerDocument.defaultView ?? window;
			win.requestAnimationFrame(() => capStarredGroupHeight(group));
		}
	}
	if (recent.length) {
		container.createDiv({ cls: "unreader-note-group-title", text: `最近阅读 · ${recent.length}` });
		const group = container.createDiv({ cls: "unreader-note-group" });
		for (const item of recent) appendCard(group, item, "recent", actions);
	}
}

/** 把星标组的 max-height 钉在「前 N 张卡片 + 间隙」的实测高度上，超出由组内滚动呈现。 */
function capStarredGroupHeight(group: HTMLElement): void {
	const cards = Array.from(group.children).filter(el => el instanceof HTMLElement) as HTMLElement[];
	const cap = cards.slice(0, STARRED_NOTE_VISIBLE_LIMIT);
	if (!cap.length) return;
	const gap = Number.parseFloat(getComputedStyle(group).rowGap || getComputedStyle(group).gap || "0") || 0;
	const total = cap.reduce((sum, el) => sum + el.offsetHeight, 0) + gap * (cap.length - 1);
	group.style.maxHeight = `${Math.ceil(total)}px`;
}

function appendCard(
	group: HTMLElement,
	item: MarkdownNoteListItem,
	source: "recent" | "starred",
	actions: MarkdownNoteCardActions,
): void {
	const card = group.createDiv({ cls: "unreader-note-card" });
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
	// 卡片 = 网格 2 行：第 1 行 = 标题（钳 2 行，第 1 列）｜缩略图（第 2 列，固定 3:4）；
	// 第 2 行 = **通栏底栏** `.unreader-card-foot`（最左字数 + 最右动作钮）。
	const body = card.createDiv({ cls: "unreader-note-body" });
	body.createDiv({ cls: "unreader-note-title", text: item.title || "未命名笔记" });

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

	// 动作钮：复制路径 + 定位到文件夹 + 星标（用户 2026-10-13 定稿）。
	// 三类卡里笔记最少动作 —— 它没有「抓全文 / 存笔记」这类内容加工动作；原来的
	// 「⋯ 菜单」与「已读/未读」两枚已删：菜单里那几项现在各有自己的按钮，而读态
	// 由「最近阅读」索引表达，不需要用户手动切换。
	const starred = item.starredAt != null;
	const actionsEl = foot.createDiv({ cls: "unreader-note-actions" });

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

	const star = createNoteAction(actionsEl, "unreader-note-star", "star", "★", starred ? "取消星标" : "星标笔记");
	star.toggleClass("is-starred", starred);
	star.addEventListener("click", e => {
		e.stopPropagation();
		actions.onToggleStar?.(item.path);
	});

	// 悬停看板：路径 / 时间 / frontmatter 元数据 / 阅读时长 —— 底栏里被拿掉的信息都在这。
	// 锚点用字数位（原来那枚环的位置）：点它同样是「看详情」。
	attachCardDetails(card, () => noteDetailsContent(item, source, wordCount), words);

	// 缩略图列：末子节点。宿主没给 `attachThumb` 就连列都不建（纯文字全宽）。
	if (actions.attachThumb) actions.attachThumb(card, item.path, mountCardThumb(card));
}

/** 造一枚笔记卡动作钮（`div` 而非 `<button>`：与书架 / 笔记卡既有的图标钮同族，
 *  不吃官方 `button:not(.clickable-icon)` 皮肤，也就不会有「定宽按钮被内边距压塌」那类坑）。 */
function createNoteAction(
	parent: HTMLElement,
	cls: string,
	icon: string,
	fallback: string,
	label: string,
): HTMLElement {
	const el = parent.createDiv({ cls });
	el.setAttribute("role", "button");
	el.setAttribute("tabindex", "0");
	el.setAttribute("aria-label", label);
	el.setAttribute("title", label);
	paintIcon(el, icon, fallback);
	el.addEventListener("keydown", e => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		// 卡片自己也监听 Enter/Space（打开笔记）—— 不拦住的话，在按钮上按回车会连开两次。
		e.stopPropagation();
		// 键盘等价于点一下：直接转发 click，免得每个按钮各写一份动作。
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	return el;
}

/** 图标名不存在时 `setIcon` 不抛错、只是什么都不画（按钮会整个空白）——
 *  画完看一眼 DOM 再决定要不要退到字形兜底（与 `annotationsPanel.feedEntryCard` 同口径）。 */
function paintIcon(el: HTMLElement, icon: string, fallback: string): void {
	try { setIcon(el, icon); } catch { /* 落到文字兜底 */ }
	if (!el.querySelector("svg")) el.setText(fallback);
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
	if (item.starredAt) file.push({ label: "星标于", value: formatRecentRead(item.starredAt) });
	file.push({ label: "来源", value: source === "starred" ? "星标笔记" : "最近阅读", tone: "muted" });

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

/** 缩略图异步就位后卡片会变高：若这张卡在**限高**的星标组里，必须重新钉一次组高，
 *  否则新高度会溢出组外（`max-height` 是按前 N 张卡片的实测高度算的）。 */
export function resettleStarredGroupHeight(card: HTMLElement): void {
	const group = card.parentElement;
	if (!group?.hasClass("unreader-note-group-starred")) return;
	if (group.children.length > STARRED_NOTE_VISIBLE_LIMIT) capStarredGroupHeight(group);
}
