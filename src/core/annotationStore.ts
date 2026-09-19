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

/** 旁车笔记目录：固定在插件目录下（见 core/paths.ts 的 NOTES_FOLDER 注释）。
 *
 *  **为什么不再跟随书籍位置**：书允许放在库里任意位置之后，「笔记跟着书走」就没有
 *  确定解 —— 同名不同目录的两本书会撞同一个笔记文件；而按路径 hash 命名又会把
 *  「UNreader/Data/Notes/书名.md」这种可读、可手动编辑的形态毁掉。代价是多本同名书共用
 *  一份笔记（此前同一个笔记文件夹内也有同样的问题）。
 *
 *  该目录默认登记进官方的「排除文件」（见 `core/exclusions.ts`）：它只是不参与搜索/
 *  图谱，**文件本身与所有读写路径都不受影响**（本模块按路径 `getFileByPath` 取文件）。
 *  这个登记可由用户关掉（设置 → 库内文件 → 标注笔记不参与搜索）。 */
function notesDirFor(): string {
	return NOTES_FOLDER;
}

export function annotationFileFor(bookFile: TFile): string {
	const base = bookFile.basename.replace(/[\\/:*?"<>|#^[\]]/g, "_");
	return normalizePath(`${notesDirFor()}/${base}.md`);
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
	for (const line of raw.split(/\r?\n/)) {
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

function serialize(data: AnnotationFileData, bookLink: string): string {
	const lines: string[] = ["---", `book: "[[${bookLink}]]"`, "---", ""];
	lines.push(HEAD_HL, "");
	for (const h of data.highlights) {
		lines.push(`- ${h.id} | ${h.color} | ${h.anchor} | ${h.text} ^hl${h.id}${h.contentHash ? ` | ${h.contentHash}` : ""}`);
		if (h.comment) lines.push(`  - ${encodeComment(h.comment)}`);
	}
	lines.push("", HEAD_BM, "");
	for (const b of data.bookmarks) {
		lines.push(`- ${b.id} | ${b.anchor} | ${b.label} ^bm${b.id}${b.contentHash ? ` | ${b.contentHash}` : ""}`);
	}
	lines.push("");
	return lines.join("\n");
}

async function ensureNote(vault: Vault, path: string, bookLink: string): Promise<TFile | null> {
	const existing = vault.getFileByPath(path);
	if (existing) return existing;
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
	try {
		await vault.createFolder(dir);
	} catch {
		// already exists
	}
	try {
		return await vault.create(path, serialize({ highlights: [], bookmarks: [] }, bookLink));
	} catch (e) {
		console.error("[UNreader] create annotation note failed", e);
		return null;
	}
}

/** Rewrite the sidecar note from in-memory state. */
export async function writeAnnotations(
	vault: Vault,
	path: string,
	bookLink: string,
	data: AnnotationFileData,
): Promise<void> {
	const file = await ensureNote(vault, path, bookLink);
	if (!file) throw new Error("annotation note unavailable");
	await vault.process(file, () => serialize(data, bookLink));
}

export async function loadAnnotations(
	vault: Vault,
	path: string,
	bookLink: string,
): Promise<AnnotationFileData> {
	try {
		const file = vault.getFileByPath(path);
		if (!file) return { highlights: [], bookmarks: [] };
		const raw = await vault.read(file);
		const parsed = parseAnnotations(raw);
		// 迁移：老笔记缺少块锚点（^hl/^bm）时自动重写，避免原生预览无法定位到目标块
		const hasHL = /\^hl\d+/.test(raw);
		const needsRewrite = (parsed.highlights.length > 0 && !hasHL) || (parsed.bookmarks.length > 0 && !/\^bm\d+/.test(raw));
		if (needsRewrite) {
			queueMicrotask(() => void writeAnnotations(vault, path, bookLink, parsed).catch(e => console.error("[UNreader] migrate block anchors failed", e)));
		}
		return parsed;
	} catch (e) {
		console.error("[UNreader] load annotations failed", e);
		return { highlights: [], bookmarks: [] };
	}
}
