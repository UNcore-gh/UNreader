/**
 * 阅读格式管理（设置页 → 阅读格式）的**唯一事实来源**。
 *
 * 产品口径（2026-10-16 用户要求）：插件默认能读多种格式，但某种格式的阅读功能
 * 受损时，用户需要能单独把它关掉，避免拖垮整个插件。每个格式一枚开关，关掉后：
 *  · 书籍类（epub / mobi / azw3 / txt / html）：**不注册扩展名**（onload 的
 *    `registerExtensions` 循环读这里过滤）+ 书架不再列出（`bookService.collectBookFiles`）
 *    + 打开链路的隔离墙拒绝（`main.openBook` / `readerView.loadBook` 各一道）；
 *  · md：不启动 `MdOverlayManager` 叠加层（.md 文件本身仍由 Obsidian 原生管理，
 *    进度条 / 目录条 / 沉浸阅读不再出现）；
 *  · rss：订阅相关命令与管理入口全部拒绝，侧边抽屉的「订阅」页不再出现。
 *
 * ⚠️ 两条硬约束：
 *  ① **扩展名注册表仍以 `bookService.READER_BOOK_EXT_ORDER` 为事实来源**，本模块
 *     只做「用户允许哪些」的策略层，不内联第二份扩展名数组（`test:file-gate` 的
 *     源码不变量钉着这一点）；
 *  ② **本模块不许 import bookService**（bookService 要 import 本模块做书架过滤，
 *     反向 import 会成环）—— 格式 id 与扩展名的对应关系在本模块内自足。
 *
 * 读法一律 `!== false` 风格不适用这里：缺省 / 空数组 = **全部开启**（与上线前行为
 * 逐字节相同），只有显式写进 `settings.disabledFormats` 的 id 才被关掉。
 */

import type { StrKey } from "./i18n";

/** 一种可被开关的阅读格式。html 一枚同时管 .html 与 .htm（同一阅读通道）。 */
export type ReadableFormatId = "epub" | "mobi" | "azw3" | "txt" | "html" | "md" | "rss";

/** 全部格式（顺序即设置页展示顺序）：四种书 + 本地 HTML + Markdown + RSS。 */
export const READABLE_FORMAT_IDS: readonly ReadableFormatId[] = [
	"epub", "mobi", "azw3", "txt", "html", "md", "rss",
];

/**
 * 设置页「阅读格式」区的展示注册表：一行一枚开关（名称 + 说明 + toggle）。
 * 文案键指向 `core/i18n.ts`（中英各一套），别在这里写死任何语言文字。
 */
export interface ReadableFormatDef {
	id: ReadableFormatId
	/** 设置页行名（i18n key） */
	nameKey: StrKey
	/** 设置页行说明（i18n key） */
	descKey: StrKey
}

export const READABLE_FORMATS: readonly ReadableFormatDef[] = [
	{ id: "epub", nameKey: "fmtNameEpub", descKey: "fmtDescEpub" },
	{ id: "mobi", nameKey: "fmtNameMobi", descKey: "fmtDescMobi" },
	{ id: "azw3", nameKey: "fmtNameAzw3", descKey: "fmtDescAzw3" },
	{ id: "txt", nameKey: "fmtNameTxt", descKey: "fmtDescTxt" },
	{ id: "html", nameKey: "fmtNameHtml", descKey: "fmtDescHtml" },
	{ id: "md", nameKey: "fmtNameMd", descKey: "fmtDescMd" },
	{ id: "rss", nameKey: "fmtNameRss", descKey: "fmtDescRss" },
];

const READABLE_FORMAT_ID_SET = new Set<string>(READABLE_FORMAT_IDS);

/** 该格式 id 是否合法（脏数据收口用）。 */
export function isReadableFormatId(value: unknown): value is ReadableFormatId {
	return typeof value === "string" && READABLE_FORMAT_ID_SET.has(value);
}

/**
 * 落盘的 `disabledFormats` 收口：只认合法 id，小写化、去重。
 * 非数组 / 脏数据一律回空数组（= 全部开启，与上线前一致）。
 */
export function normalizeDisabledFormats(value: unknown): ReadableFormatId[] {
	if (!Array.isArray(value)) return [];
	const out: ReadableFormatId[] = [];
	for (const item of value) {
		if (!isReadableFormatId(item)) continue;
		if (!out.includes(item)) out.push(item);
	}
	return out;
}

/** 某个格式当前是否**启用**（缺省禁用列表 = 全开）。 */
export function isFormatEnabled(id: string, disabled: readonly string[] | undefined | null): boolean {
	if (!disabled || disabled.length === 0) return true;
	return !disabled.includes(id);
}

/** 某个扩展名（不含点，大小写不限）对应的阅读格式是否启用。
 *   registry 覆盖之外的扩展名返回 true —— 它只做「用户显式关过吗」的策略判断，
 *   「这个扩展名算不算书」仍由 `bookService.isReaderBookExt` 负责。 */
export function isBookExtEnabled(ext: string, disabled: readonly string[] | undefined | null): boolean {
	const lower = String(ext ?? "").toLowerCase();
	// html 一枚管两个扩展名；其余一对一
	if (lower === "htm") return isFormatEnabled("html", disabled);
	return isFormatEnabled(lower, disabled);
}

/** Markdown 阅读增强（md 叠加层）是否启用。 */
export function isMdFormatEnabled(disabled: readonly string[] | undefined | null): boolean {
	return isFormatEnabled("md", disabled);
}

/** RSS 订阅阅读是否启用。 */
export function isRssFormatEnabled(disabled: readonly string[] | undefined | null): boolean {
	return isFormatEnabled("rss", disabled);
}

/**
 * 侧边抽屉页签过滤：RSS 停用时摘掉「订阅」页。
 * 两个装配路径（`readerView` 内联 + `sidePanels.createSidePanel`）共用，
 * 避免「按钮在、点了没反应」——`sidePanels.ts` 文件头的死闸门原则。
 */
export function filterSidePanelModes<M extends string>(
	modes: readonly M[],
	disabled: readonly string[] | undefined | null,
): M[] {
	if (isRssFormatEnabled(disabled)) return [...modes];
	// 走字符串比较而不是把 "feeds" 断言成 M：调用方的 M 未必含 "feeds"（只接两页的宿主），
	// 泛型断言会变成编译错误。
	return modes.filter(m => (m as string) !== "feeds");
}
