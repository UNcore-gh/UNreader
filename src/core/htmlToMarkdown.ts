/**
 * 正文 HTML → Markdown（给「保存为笔记」用）。
 *
 * 为什么自己写而不是引 turndown：插件体积与离线构建都要付代价，而这里只需要覆盖
 * **Readability 净化后的那批标签**（见 articleExtractor 的 ALLOWED_TAGS）——脚本、表单、
 * 事件在进到这里之前已经没了。转换里唯一的要求是"别丢内容"：不认识的标签一律递归子节点，
 * 而不是整块跳过。
 */

export interface MarkdownContext {
	/** 图片地址改写（保存笔记时把远程图换成刚落盘的附件路径）。返回空串表示该图不保留。 */
	imageResolver?: (src: string, alt: string) => string
}

/** 需要**独占一段**的标签：父元素里只要出现它们，父元素就不能当"段落"渲染。 */
const BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIV", "DL", "FIGURE", "FIGCAPTION",
	"FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL",
	"P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED"]);

/** 文本转义：只处理**会破坏 Markdown 结构**的几个字符。全量转义（把 `*` `_` 都写成 `\*`）
 *  会让中文正文里到处是反斜杠，可读性反而更差。 */
function escapeText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/([`[\]])/g, "\\$1")
		.replace(/\*/g, "\\*");
}

/** 行首标记（`#` `-` `>` `|`）只有在段首才有语法意义，单独兜一层。 */
function escapeLineStart(line: string): string {
	return line.replace(/^(\s*)([#>|]|[-+]\s|\d+\.\s)/, (_match, indent: string, marker: string) => `${indent}\\${marker}`);
}

function isInlineOnly(el: Element): boolean {
	for (const child of Array.from(el.children)) {
		if (BLOCK_TAGS.has(child.tagName)) return false;
	}
	return true;
}

function linkFor(path: string): string {
	return /[\s()<>]/.test(path) ? `<${path}>` : path;
}

function renderInline(node: Node, ctx: MarkdownContext): string {
	if (node.nodeType === 3) return escapeText(node.nodeValue ?? "");
	if (node.nodeType !== 1) return "";
	const el = node as Element;
	if (SKIP_TAGS.has(el.tagName)) return "";
	const inner = Array.from(el.childNodes).map(child => renderInline(child, ctx)).join("");
	switch (el.tagName) {
		case "BR":
			return "\n";
		case "IMG": {
			const raw = el.getAttribute("src")?.trim() ?? "";
			if (!raw) return "";
			const alt = el.getAttribute("alt")?.trim() ?? "";
			const src = ctx.imageResolver ? ctx.imageResolver(raw, alt) : raw;
			if (!src) return "";
			return `![${escapeText(alt).replace(/\n/g, " ")}](${linkFor(src)})`;
		}
		case "STRONG":
		case "B":
			return inner.trim() ? `**${inner.trim()}**` : "";
		case "EM":
		case "I":
			return inner.trim() ? `*${inner.trim()}*` : "";
		case "DEL":
		case "S":
		case "STRIKE":
			return inner.trim() ? `~~${inner.trim()}~~` : "";
		case "MARK":
			return inner.trim() ? `==${inner.trim()}==` : "";
		case "CODE":
			return inner.trim() ? `\`${inner.trim().replace(/`/g, "\\`")}\`` : "";
		case "A": {
			const href = el.getAttribute("href")?.trim() ?? "";
			const text = inner.trim() || href;
			return href && text ? `[${text}](${linkFor(href)})` : text;
		}
		case "AUDIO":
		case "VIDEO": {
			const src = el.getAttribute("src")?.trim() ?? "";
			if (!src) return inner;
			const rewritten = ctx.imageResolver ? ctx.imageResolver(src, "") : src;
			return rewritten ? `[${el.tagName === "AUDIO" ? "音频" : "视频"}](${linkFor(rewritten)})` : inner;
		}
		default:
			return inner;
	}
}

function renderTable(el: Element, ctx: MarkdownContext): string {
	const cell = (node: Node | undefined): string => (node ? renderInline(node, ctx).replace(/\n+/g, " ").trim() : "");
	const rows = Array.from(el.querySelectorAll("tr")).map(row => ({
		header: row.parentElement?.tagName === "THEAD" || Array.from(row.children).every(child => child.tagName === "TH"),
		cells: Array.from(row.children).map(child => cell(child)),
	}));
	if (!rows.length) return "";
	const width = Math.max(...rows.map(row => row.cells.length));
	if (!width) return "";
	const pad = (cells: string[]): string => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
	// GFM 表格必须有表头行：原表没有 thead 时补一行空表头，否则整张表会退化成一行文本
	const first = rows[0]!;
	const head = first.header ? first.cells : Array.from({ length: width }, () => "");
	const body = first.header ? rows.slice(1) : rows;
	return [pad(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(row => pad(row.cells))].join("\n");
}

function renderBlocks(el: Element, ctx: MarkdownContext, out: string[]): void {
	if (SKIP_TAGS.has(el.tagName)) return;
	switch (el.tagName) {
		case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
			const text = renderInline(el, ctx).trim();
			if (text) out.push(`${"#".repeat(Number(el.tagName[1]))} ${text}`);
			return;
		}
		case "HR":
			out.push("---");
			return;
		case "PRE": {
			const code = el.textContent?.replace(/\n+$/, "") ?? "";
			if (code.trim()) out.push(`\`\`\`\n${code}\n\`\`\``);
			return;
		}
		case "BLOCKQUOTE": {
			const inner: string[] = [];
			for (const child of Array.from(el.children)) renderBlocks(child, ctx, inner);
			if (!inner.length) {
				const text = renderInline(el, ctx).trim();
				if (text) inner.push(text);
			}
			const quoted = inner.join("\n\n").split("\n").map(line => (line ? `> ${line}` : ">")).join("\n");
			if (quoted.trim()) out.push(quoted);
			return;
		}
		case "UL":
		case "OL": {
			let index = 1;
			for (const item of Array.from(el.children)) {
				if (item.tagName !== "LI") continue;
				const marker = el.tagName === "OL" ? `${index++}.` : "-";
				const nested: string[] = [];
				let text = "";
				for (const child of Array.from(item.childNodes)) {
					if (child.nodeType === 1 && (child as Element).tagName === "UL") {
						renderBlocks(child as Element, ctx, nested);
						continue;
					}
					if (child.nodeType === 1 && (child as Element).tagName === "OL") {
						renderBlocks(child as Element, ctx, nested);
						continue;
					}
					if (child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName)) {
						const blocks: string[] = [];
						renderBlocks(child as Element, ctx, blocks);
						text += (text ? " " : "") + blocks.join(" ");
						continue;
					}
					text += renderInline(child, ctx);
				}
				const line = text.replace(/\s*\n+\s*/g, " ").trim();
				out.push(`${marker} ${line}`);
				for (const entry of nested) {
					out.push(entry.split("\n").map(sub => `  ${sub}`).join("\n"));
				}
			}
			return;
		}
		case "TABLE": {
			const table = renderTable(el, ctx);
			if (table) out.push(table);
			return;
		}
		case "FIGURE": {
			const media = el.querySelector("img");
			if (media) {
				const image = renderInline(media, ctx).trim();
				if (image) out.push(image);
			}
			const caption = el.querySelector("figcaption");
			const captionText = caption ? renderInline(caption, ctx).trim() : "";
			if (captionText) out.push(`*${captionText}*`);
			if (!media && !captionText) {
				for (const child of Array.from(el.children)) renderBlocks(child, ctx, out);
			}
			return;
		}
		case "DT":
		case "DD": {
			const text = renderInline(el, ctx).trim();
			if (text) out.push(el.tagName === "DT" ? `**${text}**` : `: ${text}`);
			return;
		}
		case "IMG": {
			const image = renderInline(el, ctx).trim();
			if (image) out.push(image);
			return;
		}
		case "BR":
			return;
		default: {
			if (isInlineOnly(el)) {
				const text = renderInline(el, ctx);
				const lines = text.split("\n").map(line => escapeLineStart(line.trim())).filter(line => line.length > 0);
				if (lines.length) out.push(lines.join("\n"));
				return;
			}
			for (const child of Array.from(el.childNodes)) {
				if (child.nodeType === 3) {
					const text = (child.nodeValue ?? "").trim();
					if (text) out.push(escapeLineStart(text));
					continue;
				}
				if (child.nodeType === 1) renderBlocks(child as Element, ctx, out);
			}
		}
	}
}

export function htmlToMarkdown(html: string, ctx: MarkdownContext = {}): string {
	const doc = new DOMParser().parseFromString(html || "", "text/html");
	const out: string[] = [];
	for (const child of Array.from(doc.body.childNodes)) {
		if (child.nodeType === 3) {
			const text = (child.nodeValue ?? "").trim();
			if (text) out.push(escapeLineStart(text));
			continue;
		}
		if (child.nodeType === 1) renderBlocks(child as Element, ctx, out);
	}
	return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 笔记文件名：整段标题做文件名风险太大（斜杠会被当路径、超长会被系统拒）。 */
export function safeNoteFileName(title: string, fallback = "未命名文章"): string {
	const cleaned = (title || "")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	const value = cleaned || fallback;
	return value.length > 80 ? value.slice(0, 80).trim() : value;
}
