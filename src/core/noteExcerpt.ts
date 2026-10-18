import { App, TFile } from "obsidian";

/** Markdown 笔记卡片的**正文预览**：从源文件里挑一段有信息量的开头，交给宿主注入的
 *  `MarkdownRenderer` 渲染成真实排版（用户 2026-10-17：「标题下面那段空白里写上笔记最强的
 *  一些字，要渲染 markdown 格式」）。
 *
 *  为什么单独一层：与 `noteThumb` 同因 —— 列表最多 17 篇，按需读盘就够；但读盘 + 解析要
 *  缓存与并发去重，否则每次切页重绘都把同一批文件重读一遍。
 *
 *  **挑什么**：正文开头若干块，跳过 frontmatter、纯标题块、代码围栏、分割线、图片、裸 HTML、
 *  表格行。裸图片必须去掉：预览是 2 行文字，混进一张图会把卡片撑成缩略图大小。
 *
 *  **返回的是 Markdown 源文本**（不是纯文本）：卡片要用官方渲染器画出 `**粗体**` / 列表 /
 *  `==高亮==` —— 纯文本预览等于把语法符号直接怼到用户脸上。截断在合法边界上收口，
 *  未闭合的行内标记会被补齐（否则卡片上会出现半截 `**`）。 */

/** 预览字符上限。2 行中文 ≈ 40～50 字，200 字符只负责「别读整本笔记」，最终高度由 CSS 钳。 */
const EXCERPT_CHARS = 200;
/** 缓存条数上限：列表最多 17 篇，给两轮富余（与 noteThumb 同量级）。 */
const CACHE_LIMIT = 24;

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function cacheKey(file: TFile): string {
	return `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}`;
}

function touchCache(key: string, value: string | null): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

function countOf(text: string, token: string): number {
	if (!token) return 0;
	return text.split(token).length - 1;
}

/** 去掉「渲染不出来 / 渲染了也是占位」的东西：图片嵌入、块级公式、行内公式。
 *
 *  ⚠️ 图片与嵌入（`![[a.png]]`、`![[另一篇笔记]]`、`![](url)`）必须**删干净**：
 *  留着会让 `MarkdownRenderer` 生成 `<img>` / 转写块，在 2 行摘要里既读不懂又把高度吃光
 *  （用户 2026-10-18：「遇到图片或者类似的无法渲染内容时，跳过」）。
 *  块级公式同理：`$$…$$` 渲染出来是一整块 MathJax，卡片上只会留一片空白。
 *  行内 `$…$` 不删 —— 「价格 $100 和 $200」这种误伤比收益大，而且行内公式本来就一行高。 */
function stripEmbeds(text: string): string {
	return text
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\$\$[\s\S]*?\$\$/g, "")
		.replace(/[ \t]{2,}/g, " ")
		// 删图之后可能留下空行：用户 2026-10-18「空行不要渲染」⇒ 块内也不留空行。
		.replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n")
		.trim();
}

/** 整篇先剥掉围栏代码块（含**跨空行**的块）。
 *
 *  ⚠️ 必须在**分块之前**做：按空行切块时，一段代码中间的空行会把它切成两块 —— 第二块
 *  在块内从「不在围栏里」开始，代码行就会被当成正文混进预览（2026-10-17 自查发现的真 bug：
 *  技术笔记几乎都有空行分隔的代码，这一条不修的话预览里会冒出 `const b = 2;`）。
 *  围栏语法：同字符、≥3 个、闭合行长度 ≥ 开启行；这里宽松到「同字符即可」。 */
const FENCED_BLOCK = /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm;

/** 一个块是否值得进预览；值得就返回清洗后的文本（已去掉标题 / 引用 / 分隔线 / 表格行）。
 *
 *  ⚠️ **引用块（含 callout）整块跳过**（用户 2026-10-18：「文字渲染的不太合适」）：
 *  笔记开头最常见的形态就是 `> [!info] 来源` / `> 说明：…`，渲染出来是一个带图标和边框的
 *  callout；在 2 行预览里它会把真正的正文全挤掉，截断后还会剩一个孤零零的 `>`。
 *  预览要的是「正文的话」，不是文档结构。
 *
 *  ⚠️ **标题一律不进预览**：卡片标题已经显示过一次文件名，正文里的 `## 一、首次配置`
 *  再占一行只是把预算吃光。 */
function usableBlock(block: string): string | null {
	const kept: string[] = [];
	for (const raw of block.split(/\r?\n/)) {
		const line = raw.trimEnd();
		// 兜底：剥过围栏之后还见到围栏行 = 未闭合的代码块。整块不要（宁可少一句预览，
		// 也不要把代码当正文画到卡片上）。
		if (/^\s*(?:`{3,}|~{3,})/.test(line)) return null;
		// 引用 / callout 的每一行（`> [!NOTE]`、`> 正文`）都丢。
		if (/^\s*>/.test(line)) continue;
		if (/^\s*#{1,6}\s/.test(line)) continue;
		if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
		if (/^\s*%%[\s\S]*%%\s*$/.test(line)) continue;
		if (/^\s*<(?:div|table|img|iframe|video|!--|br)/i.test(line)) continue;
		// Admonition / 折叠块（`!!! note`、`+++ 标题`、`=== "标题"`）：渲染出来是带标题栏的块，
		// 标题栏在 2 行预览里只是噪声。`===` 也正好是 setext 标题的下划线，一起丢不影响正文。
		if (/^\s*(?:!!!|\+\+\+|===)/.test(line)) continue;
		if (/^\s*\|/.test(line)) continue;
		if (!line.trim()) continue;
		kept.push(line);
	}
	const text = stripEmbeds(kept.join("\n"));
	return text || null;
}

/** 这一块是不是列表（`- x` / `1. x`）：列表必须独立起段，不能与前一句粘成一行。 */
function isListBlock(text: string): boolean {
	return /^\s*(?:[-*+]|\d+[.)])\s/.test(text);
}

/** 署名 / 来源行（公众号、博客导出笔记的固定开头）：
 *  `原创极小昼[极昼工作室](https://…)`、`*2025年11月26日 10:30*`。
 *
 *  它们占掉 2 行预览里的**第一行**却没有任何正文信息 —— 用户 2026-10-18 那张卡片
 *  「只有一行『原创极小昼』」就是它们（+ 下面那个 `[` 误删 bug）拼出来的。
 *  判据刻意保守：**短块**（< 60 字）且「带外链」或「整块是一个斜体短语」；
 *  正文里的长引用、带链接的正经句子都不会命中。 */
function isBylineBlock(text: string): boolean {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length > 60) return false;
	return /\]\(https?:/i.test(flat) || /^\*[^*\n]{1,40}\*$/.test(flat);
}

/** 在合法边界收口：往回找句末 / 空格 / 换行，再补齐未闭合的行内标记。 */
function clampMarkdown(text: string, limit: number): string {
	if (text.length <= limit) return balanceInline(text);
	let cut = limit;
	const boundary = /[。！？；…，、,.!?;\n\s）)】」』]/;
	const floor = Math.max(0, limit - 48);
	while (cut > floor && !boundary.test(text[cut] ?? "")) cut--;
	if (cut <= floor) cut = limit;
	let head = text.slice(0, cut).trimEnd();
	// 悬空的开启符（`[`、`(`、`**` 的后半段）一律削掉，别让预览以半个语法开头。
	head = head.replace(/[（(【「『[，、,;；:：\s]+$/, "");
	// 未闭合的引用式链接：截断点落在 `[文字` 里，抹掉这一段（否则渲染出裸 `[`）。
	//
	// ⚠️ 判据必须是「最后一个 `[` **之后没有** `]`」（2026-10-18 真机 bug：正则
	// `/\[[^[]*$/` 只要见到任何 `[` 就删到结尾 —— 正文里一个**已闭合**的
	// `[极昼工作室](https://…)` 会让它把后面 150 字的正文整段吃掉，卡片只剩「原创极小昼…」）。
	// 用一个显式比较代替正则：`]` 在 `[` 之后 = 这个链接是完整的，不该动。
	const openBracket = head.lastIndexOf("[");
	if (openBracket >= 0 && openBracket > head.lastIndexOf("]")) head = head.slice(0, openBracket);
	// 截断点正好落在列表标记之后（`-` / `1.` 后面没内容）：连标记一起削掉，
	// 否则卡片最后会多出一个孤零零的 `•` 或 `1.`。
	head = head.replace(/(?:\n{2}|[ \t]{2}\n)\s*(?:[-*+]|\d+[.)])\s*$/, "");
	if (!head) return "";
	return `${balanceInline(head)}…`;
}

/** 补齐被截断打断的行内标记 —— 奇数个开启符补一个闭合，避免卡片上出现裸 `**` / 反引号。 */
function balanceInline(text: string): string {
	if (!text) return text;
	let out = text;
	const doubled: Array<[string, string]> = [["**", "**"], ["~~", "~~"], ["==", "=="], ["`", "`"]];
	for (const [open, close] of doubled) {
		if (countOf(out, open) % 2 === 1) out += close;
	}
	// 单星号在 `**` 之外单独数：`replace` 成占位符，避免把粗体算成两个斜体。
	const singleStars = countOf(out.replace(/\*\*/g, "\u0000\u0000"), "*");
	if (singleStars % 2 === 1) out += "*";
	return out;
}

/** 从 Markdown 源文里抽一段预览（纯函数，测试与调用方都可直接用）。 */
export function extractNoteExcerpt(body: string): string | null {
	if (!body) return null;
	// frontmatter 先剥掉：YAML 里的 `title:` / `tags:` 不是正文（渲染出来会是一堆 `---`）。
	const withoutFront = body.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	// 块注释 `%%…%%`（可跨行）：渲染器**什么都不画**，但源码会占掉字符预算、还会把
	// 一段真正的正文挤掉。跟围栏代码一样必须在分块前整段剥。
	const withoutComments = withoutFront.replace(/%%[\s\S]*?%%/g, "");
	// 围栏代码块必须**在分块之前**整段剥掉（跨空行的块，见 {@link FENCED_BLOCK} 注释）。
	const withoutCode = withoutComments.replace(FENCED_BLOCK, "");
	const picked: string[] = [];
	let total = 0;
	for (const block of withoutCode.split(/\r?\n\s*\r?\n/)) {
		const text = usableBlock(block);
		if (!text) continue;
		// 署名 / 来源行只出现在**开头**（公众号、博客导出笔记的第一块）。只在「还没收集到
		// 任何正文」时过滤 —— 否则正文中间一句「详见[官网](https://…)」也会被当成署名删掉。
		if (!picked.length && isBylineBlock(text)) continue;
		picked.push(text);
		total += text.length + 1;
		if (total >= EXCERPT_CHARS) break;
	}
	if (!picked.length) return null;
	// 用户 2026-10-18：「空行不要渲染（空行省略掉）」—— 块之间不再用空行（`\n\n` 会被渲染成
	// 两个 `<p>`，中间空出一档），改用 **Markdown 硬换行**（行尾两个空格 + `\n` ⇒ `<br>`）：
	// 段落感还在，空档没了。纯软换行（单 `\n`）会把两句话并成一条长句，中文读起来更糊。
	// 列表块例外：它必须独立起段，否则 `- 项` 会粘在前一句尾巴上被当成普通文本。
	const hardBreak = " ".repeat(2) + "\n";
	const joined = picked.reduce((acc, current, index) => {
		if (!index) return current;
		const previous = picked[index - 1] ?? "";
		const needsBlank = isListBlock(current) || isListBlock(previous);
		return `${acc}${needsBlank ? "\n\n" : hardBreak}${current}`;
	}, "");
	return clampMarkdown(joined, EXCERPT_CHARS);
}

/** 取一篇笔记的预览（Markdown 源片段，无则 null）。带缓存 + 同文件并发去重。
 *  读盘用 `cachedRead`：列表重绘频繁，`read` 会把磁盘打满。 */
export function resolveNoteExcerpt(app: App, path: string): Promise<string | null> {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile)) return Promise.resolve(null);
	const key = cacheKey(file);
	if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
	const inflight = pending.get(key);
	if (inflight) return inflight;

	const task = app.vault.cachedRead(file)
		.then(body => extractNoteExcerpt(body))
		.catch(() => null)
		.then(excerpt => {
			// 读盘期间文件被改（或被删）时不要写进缓存 —— 键是按 stat 算的，旧结果会污染新键。
			const current = app.vault.getFileByPath(path);
			if (current instanceof TFile && cacheKey(current) === key) touchCache(key, excerpt);
			return excerpt;
		})
		.finally(() => pending.delete(key));

	pending.set(key, task);
	return task;
}

/** 清空缓存（插件卸载 / 库切换时收口）。 */
export function clearNoteExcerptCache(): void {
	cache.clear();
	pending.clear();
}
