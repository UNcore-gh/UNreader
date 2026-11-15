import { TFile, Vault, normalizePath } from "obsidian";
import { NOTES_FOLDER } from "./paths";
import { stableHash } from "./feedUtils";

export interface StoredHighlight {
	id: number
	color: string
	/** 位置 token：EPUB=CFI / MOBI=filepos（与 BookPosition.anchor 同义） */
	anchor: string
	text: string
	comment?: string
	/** Feed 文章正文版本；正文更新后可用于提示标注重定位风险。 */
	contentHash?: string
	/** 正文更新且无法按原文重新定位时，仅作为本次会话的提示，不写入旁车笔记。 */
	stale?: boolean
}

export interface StoredBookmark {
	id: number
	anchor: string
	label: string
	contentHash?: string
	/** 正文更新后书签 CFI 无法可靠迁移时为 true；不做持久化。 */
	stale?: boolean
}

export interface AnnotationFileData {
	highlights: StoredHighlight[]
	bookmarks: StoredBookmark[]
}

const HEAD_HL = "## 高亮";
const HEAD_BM = "## 书签";
const MANAGED_START = "<!-- unreader:annotations:start -->";
const MANAGED_END = "<!-- unreader:annotations:end -->";

export interface AnnotationReadResult {
	data: AnnotationFileData
	/** 本次读到的原文；写入时会以它为三方合并基线。 */
	raw: string
	exists: boolean
}

export class AnnotationReadError extends Error {
	constructor(readonly path: string, readonly cause: unknown) {
		super(`无法读取标注笔记：${path}`);
		this.name = "AnnotationReadError";
	}
}

export class AnnotationConflictError extends Error {
	constructor(readonly path: string) {
		super("标注已在其他位置发生变化，请刷新后重试");
		this.name = "AnnotationConflictError";
	}
}

/** 旁车笔记目录：固定在插件目录下（见 core/paths.ts 的 NOTES_FOLDER 注释）。
 *
 *  书允许放在库里任意位置，因此笔记不跟随路径。稳定书籍身份负责把移动/改名后的书
 *  继续指向同一条笔记；真正同名时由 bookIdentity 追加短 ID，绝不再让两本书共用一份。
 *
 *  该目录默认登记进官方的「排除文件」（见 `core/exclusions.ts`）：它只是不参与搜索/
 *  图谱，**文件本身与所有读写路径都不受影响**（本模块按路径 `getFileByPath` 取文件）。
 *  这个登记可由用户关掉（设置 → 库内文件 → 标注笔记不参与搜索）。 */
function notesDirFor(): string {
	return NOTES_FOLDER;
}

export function annotationFileFor(bookFile: TFile, bookId?: string): string {
	const base = bookFile.basename.replace(/[\\/:*?"<>|#^[\]]/g, "_");
	const suffix = bookId ? `--${bookId.replace(/^book-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 12)}` : "";
	return normalizePath(`${notesDirFor()}/${base}${suffix}.md`);
}

/** Feed 文章旁车笔记的稳定路径：只由 feedId + entryId 派生，标题变化不会换文件。 */
export function annotationFileForFeed(feedId: string, entryId: string, _title = ""): string {
	const suffix = stableHash(`${feedId}:${entryId}`).slice(0, 10);
	return normalizePath(`${notesDirFor()}/订阅/feed-${suffix}.md`);
}

/**
 * 兼容行解析（v0.3 起字段名 anchor，之前是 cfi）：
 *   v0.3+ :  `- 12 | yellow | /6/4[...] | 选中文本`  (高亮)
 *   v0.2  :  `- 12 | yellow | /6/4[...] | 选中文本`  （同格式，token 名 cfi）
 *   注解位置 token 仍是同一字符串（EPUB CFI 或 MOBI filepos），仅头部/侧栏文案变了
 *   这里不区分两种列名——反正就是 token，本计划把内部字段从 cfi 改为 anchor
 *   落到磁盘上序列化时统一用 anchor 字段（写在 `| ${anchor} |` 那一列）。
 */
const HL_LINE = /^- (\d+) \| (\w+) \| ([^|\n]+) \| (.*)$/;
const BM_LINE = /^- (\d+) \| ([^|\n]+) \| (.*)$/;
const COMMENT_LINE = /^\s+- (.*)$/;
const BLOCK_REF = /(\s+\^hl\d+|\s+\^bm\d+)?\s*$/;

function stripBlockRef(raw: string): string {
	return raw.replace(BLOCK_REF, "").trim();
}

/**
 * 书签名的落盘安全化。
 *
 * 旁车笔记是**按行 + `|` 分列**的（`- id | anchor | label ^bmN`），标签里出现
 * `|` 或换行会在下一次解析时把该行切错列 → `BM_LINE` 不匹配 → **这条书签直接
 * 从列表里消失**（不是显示成乱码，是静默丢失）。所以「添加」与「重命名」两条
 * 用户输入路径都必须过这里，就地替换成全角字符（观感几乎不变）。
 * 长度上限与重命名输入框的 maxlength 对齐。
 */
export function sanitizeBookmarkLabel(raw: string): string {
	return raw.replace(/\|/g, "｜").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
}

function decodeComment(raw: string): string {
	return raw.replace(/\\n/g, "\n").trim();
}

function encodeComment(raw: string): string {
	return raw.replace(/\n/g, "\\n").trim();
}

export function parseAnnotations(raw: string): AnnotationFileData {
	const result: AnnotationFileData = { highlights: [], bookmarks: [] };
	let section: "hl" | "bm" | null = null;
	let lastHighlight: StoredHighlight | null = null;
	const start = raw.indexOf(MANAGED_START);
	const end = start < 0 ? -1 : raw.indexOf(MANAGED_END, start + MANAGED_START.length);
	const source = start >= 0 && end > start
		? raw.slice(start + MANAGED_START.length, end)
		: raw;
	for (const line of source.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === HEAD_HL) {
			section = "hl";
			lastHighlight = null;
			continue;
		}
		if (trimmed === HEAD_BM) {
			section = "bm";
			lastHighlight = null;
			continue;
		}
		// 缩进续行（评论）判据必须看**原始行的前导空白**，不能看 trimmed：
		// 评论序列化为 `  - 正文`，trim 后是 `- 正文`，照样 startsWith("- ")，用
		// trimmed 判据会把评论行当成顶层条目 → HL_LINE 不匹配 → **评论被静默丢弃**，
		// 而 writeAnnotations 是「按内存全量重写」，下一次任何写盘（加书签/改颜色/删高亮）
		// 就把磁盘上的评论**永久抹掉**。顶层条目一律顶格写（serialize 不加缩进）。
		const isContinuation = /^[ \t]/.test(line);
		if (isContinuation || !trimmed.startsWith("- ")) {
			if (section === "hl" && lastHighlight) {
				const cm = COMMENT_LINE.exec(line);
				if (cm && cm[1]) lastHighlight.comment = decodeComment(cm[1]);
			}
			continue;
		}

		if (section === "hl") {
			const m = HL_LINE.exec(trimmed);
			if (m) {
				const hashMatch = /\s+\|\s*([0-9a-f]{16})\s*$/i.exec(m[4]!);
				const rawText = hashMatch ? m[4]!.slice(0, hashMatch.index) : m[4]!;
				lastHighlight = {
					id: Number(m[1]),
					color: m[2]!,
					anchor: m[3]!.trim(),
					text: stripBlockRef(rawText),
					contentHash: hashMatch?.[1],
				};
				result.highlights.push(lastHighlight);
			}
		} else if (section === "bm") {
			const m = BM_LINE.exec(trimmed);
			if (m) {
				const hashMatch = /\s+\|\s*([0-9a-f]{16})\s*$/i.exec(m[3] ?? "");
				const rawLabel = hashMatch ? (m[3] ?? "").slice(0, hashMatch.index) : (m[3] ?? "");
				result.bookmarks.push({
					id: Number(m[1]),
					anchor: m[2]!.trim(),
					label: stripBlockRef(rawLabel),
					contentHash: hashMatch?.[1],
				});
			}
		}
	}
	return result;
}

function managedBody(data: AnnotationFileData): string {
	const lines: string[] = [MANAGED_START];
	lines.push(HEAD_HL, "");
	for (const h of data.highlights) {
		lines.push(`- ${h.id} | ${h.color} | ${h.anchor} | ${h.text} ^hl${h.id}${h.contentHash ? ` | ${h.contentHash}` : ""}`);
		if (h.comment) lines.push(`  - ${encodeComment(h.comment)}`);
	}
	lines.push("", HEAD_BM, "");
	for (const b of data.bookmarks) {
		lines.push(`- ${b.id} | ${b.anchor} | ${b.label} ^bm${b.id}${b.contentHash ? ` | ${b.contentHash}` : ""}`);
	}
	lines.push("", MANAGED_END);
	return lines.join("\n");
}

interface NoteParts {
	before: string
	after: string
	frontmatter: string[]
	bodyLines: string[]
}

function splitNote(raw: string): NoteParts {
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	const frontmatter: string[] = [];
	let bodyStart = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (end > 0) {
			frontmatter.push(...lines.slice(0, end + 1));
			bodyStart = end + 1;
		}
	}
	const bodyLines = lines.slice(bodyStart);
	const start = bodyLines.findIndex(line => line.trim() === MANAGED_START);
	const end = start < 0 ? -1 : bodyLines.findIndex((line, index) => index > start && line.trim() === MANAGED_END);
	if (start >= 0 && end > start) {
		return {
			before: bodyLines.slice(0, start).join("\n").trimEnd(),
			after: bodyLines.slice(end + 1).join("\n").trimStart(),
			frontmatter,
			bodyLines,
		};
	}

	// 旧版没有标记：只移除由本插件生成的标题、条目和评论行。其余内容视为用户正文，
	// 原样保留在受管理区域之外，避免升级后的第一次保存把用户手写内容抹掉。
	const before: string[] = [];
	const preserved: string[] = [];
	let inManagedSection = false;
	let lastWasHighlight = false;
	for (const line of bodyLines) {
		const trimmed = line.trim();
		if (trimmed === HEAD_HL) {
			inManagedSection = true;
			lastWasHighlight = false;
			continue;
		}
		if (trimmed === HEAD_BM) {
			inManagedSection = true;
			lastWasHighlight = false;
			continue;
		}
		if (!inManagedSection) {
			before.push(line);
			continue;
		}
		if (HL_LINE.test(trimmed)) {
			lastWasHighlight = true;
			continue;
		}
		if (BM_LINE.test(trimmed)) {
			lastWasHighlight = false;
			continue;
		}
		if (lastWasHighlight && COMMENT_LINE.test(line) && /^[ \t]/.test(line)) continue;
		if (!trimmed) continue;
		preserved.push(line);
	}
	return {
		before: before.join("\n").trimEnd(),
		after: preserved.join("\n").trimStart(),
		frontmatter,
		bodyLines,
	};
}

function frontmatterWithIdentity(existing: readonly string[], bookLink: string, bookId?: string): string[] {
	if (!existing.length) {
		return [
			"---",
			`book: "[[${bookLink}]]"`,
			...(bookId ? [`unreader-book-id: "${bookId}"`] : []),
			"---",
		];
	}
	const out = [...existing];
	let bookIndex = -1;
	let idIndex = -1;
	for (let i = 1; i < out.length - 1; i++) {
		const line = out[i] ?? "";
		if (/^book\s*:/.test(line)) {
			if (bookIndex < 0) bookIndex = i;
			else out.splice(i--, 1);
		} else if (/^unreader-book-id\s*:/.test(line)) {
			if (idIndex >= 0) out.splice(i--, 1);
			else idIndex = i;
		}
	}
	const bookLine = `book: "[[${bookLink}]]"`;
	if (bookIndex >= 0) {
		out[bookIndex] = bookLine;
	} else {
		bookIndex = Math.max(1, out.length - 1);
		out.splice(bookIndex, 0, bookLine);
		if (idIndex >= bookIndex) idIndex++;
	}
	// 未传 bookId 时只更新书籍链接，不能顺手删掉别处已经写入的身份字段。
	// Feed 笔记本来就没有该字段；书籍调用方漏传时也必须保持幂等。
	if (bookId !== undefined) {
		const line = `unreader-book-id: "${bookId}"`;
		if (idIndex >= 0) out[idIndex] = line;
		else out.splice(Math.max(1, out.length - 1), 0, line);
	}
	return out;
}

function renderNote(raw: string, data: AnnotationFileData, bookLink: string, bookId?: string): string {
	const parts = splitNote(raw);
	const chunks = [
		frontmatterWithIdentity(parts.frontmatter, bookLink, bookId).join("\n"),
		parts.before,
		managedBody(data),
		parts.after,
	].filter(chunk => chunk.trim().length > 0);
	return `${chunks.join("\n\n")}\n`;
}

/** 从旁车笔记 frontmatter 取书籍链接；书籍身份迁移用。 */
export function annotationBookLinkFromRaw(raw: string): string | null {
	const match = /^book\s*:\s*"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"\s*$/m.exec(raw);
	return match?.[1]?.trim() || null;
}

export function annotationBookIdFromRaw(raw: string): string | null {
	const match = /^unreader-book-id\s*:\s*"([^"]+)"\s*$/m.exec(raw);
	return match?.[1]?.trim() || null;
}

const baselines = new WeakMap<Vault, Map<string, string>>();
const BASELINE_LIMIT = 128;

function baselineFor(vault: Vault): Map<string, string> {
	let map = baselines.get(vault);
	if (!map) {
		map = new Map();
		baselines.set(vault, map);
	}
	return map;
}

function rememberBaseline(vault: Vault, path: string, raw: string): void {
	const map = baselineFor(vault);
	map.delete(path);
	map.set(path, raw);
	while (map.size > BASELINE_LIMIT) {
		const oldest = map.keys().next().value;
		if (typeof oldest !== "string") break;
		map.delete(oldest);
	}
}

function itemEqual<T extends { id: number }>(a: T | undefined, b: T | undefined): boolean {
	if (!a || !b) return a === b;
	const normalize = (item: T): unknown => {
		const { stale: _stale, ...rest } = item as T & { stale?: boolean };
		return rest;
	};
	return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function mergeItems<T extends { id: number }>(
	base: readonly T[],
	desired: readonly T[],
	current: readonly T[],
): T[] {
	const ids = new Set<number>([
		...base.map(item => item.id),
		...desired.map(item => item.id),
		...current.map(item => item.id),
	]);
	const baseMap = new Map(base.map(item => [item.id, item] as const));
	const desiredMap = new Map(desired.map(item => [item.id, item] as const));
	const currentMap = new Map(current.map(item => [item.id, item] as const));
	const merged = new Map<number, T>();
	for (const id of ids) {
		const b = baseMap.get(id);
		const d = desiredMap.get(id);
		const c = currentMap.get(id);
		if (itemEqual(d, b)) {
			if (c) merged.set(id, c);
			continue;
		}
		if (itemEqual(c, b) || itemEqual(c, d)) {
			if (d) merged.set(id, d);
			continue;
		}
		throw new AnnotationConflictError("");
	}
	const order = [
		...desired.map(item => item.id),
		...current.map(item => item.id).filter(id => !desiredMap.has(id)),
	];
	return [...new Set(order)].flatMap(id => {
		const item = merged.get(id);
		return item ? [item] : [];
	});
}

function mergeAnnotationData(base: AnnotationFileData, desired: AnnotationFileData, current: AnnotationFileData): AnnotationFileData {
	return {
		highlights: mergeItems(base.highlights, desired.highlights, current.highlights),
		bookmarks: mergeItems(base.bookmarks, desired.bookmarks, current.bookmarks),
	};
}

async function ensureNote(vault: Vault, path: string, bookLink: string, bookId?: string): Promise<TFile> {
	const existing = vault.getFileByPath(path);
	if (existing) return existing;
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
	try {
		await vault.createFolder(dir);
	} catch {
		// already exists
	}
	try {
		const file = await vault.create(path, renderNote("", { highlights: [], bookmarks: [] }, bookLink, bookId));
		rememberBaseline(vault, path, await vault.read(file));
		return file;
	} catch (e) {
		const raced = vault.getFileByPath(path);
		if (raced) return raced;
		throw new AnnotationReadError(path, e);
	}
}

/** Rewrite the sidecar note from in-memory state. */
export async function writeAnnotations(
	vault: Vault,
	path: string,
	bookLink: string,
	data: AnnotationFileData,
	expectedRaw?: string,
	bookId?: string,
): Promise<void> {
	const known = vault.getFileByPath(path);
	const file = expectedRaw === undefined && !known
		? await ensureNote(vault, path, bookLink, bookId)
		: known;
	if (!file) throw new Error("annotation note unavailable");
	const baseRaw = expectedRaw ?? baselineFor(vault).get(path) ?? await vault.read(file).catch(error => {
		throw new AnnotationReadError(path, error);
	});
	const baseData = parseAnnotations(baseRaw);
	let written = "";
	await vault.process(file, raw => {
		let merged: AnnotationFileData;
		try {
			merged = mergeAnnotationData(baseData, data, parseAnnotations(raw));
		} catch (error) {
			if (error instanceof AnnotationConflictError) throw new AnnotationConflictError(path);
			throw error;
		}
		written = renderNote(raw, merged, bookLink, bookId);
		return written;
	});
	rememberBaseline(vault, path, written);
}

export async function readAnnotations(
	vault: Vault,
	path: string,
	bookLink: string,
): Promise<AnnotationReadResult> {
	const file = vault.getFileByPath(path);
	if (!file) {
		rememberBaseline(vault, path, "");
		return { data: { highlights: [], bookmarks: [] }, raw: "", exists: false };
	}
	try {
		const raw = await vault.read(file);
		rememberBaseline(vault, path, raw);
		const data = parseAnnotations(raw);
		// 老笔记的条目行可能没有 `^hl` / `^bm` 块锚点。解析仍能读出来，但原生预览
		// 无法定位到目标块；沿用旧版的自动迁移，并且写盘仍走受管理区块与三方合并，
		// 不覆盖用户正文。
		const needsRewrite = (data.highlights.length > 0 && !/\^hl\d+/.test(raw))
			|| (data.bookmarks.length > 0 && !/\^bm\d+/.test(raw));
		if (needsRewrite) {
			const bookId = annotationBookIdFromRaw(raw) ?? undefined;
			queueMicrotask(() => {
				void writeAnnotations(vault, path, bookLink, data, raw, bookId)
					.catch(error => console.warn("[UNreader] 迁移旧标注块锚点失败", error));
			});
		}
		return { data, raw, exists: true };
	} catch (e) {
		throw new AnnotationReadError(path, e);
	}
}

/** 兼容入口：读失败现在会明确抛出，不再伪装成“没有标注”。 */
export async function loadAnnotations(
	vault: Vault,
	path: string,
	bookLink: string,
): Promise<AnnotationFileData> {
	return (await readAnnotations(vault, path, bookLink)).data;
}
