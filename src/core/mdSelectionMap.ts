/** markdown 阅读模式「选区 → 源码字符偏移」的映射算法（纯函数，无 DOM / Obsidian 依赖）。
 *
 *  **为什么需要它**：官方阅读视图是 `MarkdownRenderer` **渲染后**的 DOM，与源码之间隔着
 *  一层标记 —— `**粗体**` 到了 DOM 里只剩 `<strong>`，星号根本不存在。所以没有任何 API
 *  能把 DOM 选区直接换算成源码偏移，只能走「把源码去标记投影成纯文本，再在投影结果里
 *  找选区文字」这条近似路线。
 *
 *  **三条设计原则**：
 *  ① 投影要**尽量像渲染结果**（否则匹配不上）—— 剥掉所有会被渲染器吃掉的块级/行内标记；
 *  ② 匹配要**容忍空白差异**（渲染把软换行显示成空格）—— 用 `looseFind` 按非空白片段顺序
 *     匹配，而不是朴素 `indexOf`；
 *  ③ 拿不准就**不写**（返回 null）—— 错写一处高亮比漏写严重得多。
 */

/** 会被渲染器吃掉的**行首块级前缀**（标题 / 引用 / 列表 / 有序列表）。 */
const BLOCK_PREFIX_RE = /^(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/;

/** 官方彩色高亮的 emoji → 色名（无 emoji = 黄，即官方默认档）。 */
const EMOJI_COLORS: Record<string, string> = {
	"🔴": "red",
	"🟠": "orange",
	"🟢": "green",
	"🔵": "blue",
	"🟣": "purple",
};

/** 色名 → 官方彩色高亮 emoji（黄没有 emoji，是默认档）。 */
export const COLOR_EMOJI: Record<string, string> = {
	red: "🔴",
	orange: "🟠",
	green: "🟢",
	blue: "🔵",
	purple: "🟣",
	yellow: "",
};

export interface Demarked {
	/** 去标记后的正文文本 */
	plain: string
	/** map[i] = plain[i] 在源码里的码元偏移（与 Obsidian `Editor.offsetToPos` 同口径） */
	map: number[]
	/** 不参与高亮语法识别的源码区间（frontmatter / 代码围栏 / 行内代码），左闭右开 */
	skip: Array<[number, number]>
	/**
	 * `skip` 里**块级**禁区的子集（frontmatter / 代码围栏 / 块公式 `$$` / 表格分隔行）。
	 * 与**行内**禁区（行内代码 / 行内数学 / HTML 注释 / 嵌入 / 图片）的区别决定了
	 * `planHighlight` 的处置方式：
	 *  · 块级：整体丢弃（这些区间里的字符根本不是正文，包进 `==` 必坏）；
	 *  · 行内：端点外收即可 —— `==` **可以**跨过一整颗行内代码（官方 `mark` 规则的
	 *    body 会重新走 `tokenizeInline`，见 obsidian.asar 的 `Qp(e,"mark",...)`），
	 *    所以「选中一句含 `` `code` `` 的话」这种最常见的选区必须能写进去。
	 */
	skipHard: Array<[number, number]>
}

function inSkip(skip: Array<[number, number]>, idx: number): boolean {
	for (const [s, e] of skip) if (idx >= s && idx < e) return true;
	return false;
}

/** 从 `[from, to)` 里挖掉 `cuts` 覆盖的部分，返回剩下的连续片段（按序）。 */
function subtractSpans(from: number, to: number, cuts: Array<[number, number]>): Array<[number, number]> {
	if (to <= from) return [];
	const sorted = cuts.filter(([s, e]) => e > from && s < to).slice().sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	let cur = from;
	for (const [s, e] of sorted) {
		const a = Math.max(s, from);
		if (a > cur) out.push([cur, a]);
		cur = Math.max(cur, Math.min(e, to));
	}
	if (cur < to) out.push([cur, to]);
	return out;
}

/** 源码位置 `i` 的字符是否被奇数个反斜杠转义（`\==` 不算标记）。 */
function isEscapedAt(src: string, i: number): boolean {
	let n = 0;
	let k = i - 1;
	while (k >= 0 && src[k] === "\\") { n += 1; k -= 1; }
	return n % 2 === 1;
}

/**
 * `[from, to)` 内是否残留**真正的**「已有高亮标记」`==`。
 *
 * 与朴素的 `/(?<!\\)==/.test(body)` 的差别：**跳过 skip 区间**。行内代码 / 公式里出现的
 * `==` 是代码内容、不是高亮标记（`` `a==b` `` 不该让整次高亮中止）—— 放宽边界判据后，
 * 「选中一句含代码的话」会把整颗代码带进 body，若不跳过 skip 就会把这类选区误判成
 * 「区间内含未配对 `==`」而中止（旧判据下这些 run 直接被丢，反而躲过了这一条）。
 */
function hasUnescapedMarker(src: string, from: number, to: number, skip: Array<[number, number]>): boolean {
	for (let i = from; i < to - 1; i += 1) {
		if (src[i] !== "=" || src[i + 1] !== "=") continue;
		if (inSkip(skip, i)) continue;
		if (isEscapedAt(src, i)) continue;
		return true;
	}
	return false;
}

/**
 * 探针的阴性对照开关：注回旧判据「端点沾到**任一** skip 就丢整段」。
 * 生产路径恒为 false —— 只有 `test:md-selection` 会设 `__UR_BREAK_SKIP_EDGE`。
 */
function skipEdgeBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_SKIP_EDGE === true;
	} catch {
		return false;
	}
}

/** 表格分隔行（`|---|---|` / `|:-:|--:|`）：纯装饰，渲染结果里没有对应文本。 */
const TABLE_DIVIDER_RE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

/**
 * 探针的阴性对照开关：注回「不切表格格线」的旧行为。
 * 生产路径恒为 false —— 只有 `test:md-selection-map` 会设 `__UR_BREAK_TABLE_BAR`。
 */
function tableBarBreak(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_TABLE_BAR === true;
	} catch {
		return false;
	}
}

/**
 * 探针的阴性对照开关（生产路径恒为 false，只有 `test:md-selection` 会设）。
 *
 * 注回**旧投影**：脚注引用 `[^1]` 原样留在投影里、行内数学 `$...$` 整段丢弃。
 * 旧行为下，这两类块的 `sameTokens(渲染文本, 投影)` 恒不成立 ⇒ 锚定整条失效 ⇒
 * 退化成全文搜索 ⇒ 选区只要稍有重复、或含有「渲染口径与源码口径不一致」的片段
 * （`[1]` vs `[^1]`、`x+y` vs `$x+y$`）就写不进去（用户报障「高亮无法写入」）。
 * 阴性档用来证明 P15 / P17 真有牙口。
 */
function legacyDemark(): boolean {
	try {
		return (globalThis as unknown as Record<string, unknown>).__UR_BREAK_DEMARK_LEGACY === true;
	} catch {
		return false;
	}
}

/** 行内投影：剥掉强调/代码/链接/HTML 等标记，只把**会被渲染出来的字符**推入 plain。 */
function inlineDemark(
	line: string,
	base: number,
	push: (ch: string, at: number) => void,
	skip: Array<[number, number]>,
): void {
	let i = 0;
	// 行首块级前缀：渲染时被吃掉，我们既不出现在 plain 里，也不记进 skip（它不是代码区）
	const pre = BLOCK_PREFIX_RE.exec(line);
	if (pre) i = pre[0].length;
	// callout 的类型标记 `> [!note]`（可带 `+` / `-` 折叠符）：渲染成 callout 头部，
	// 标记串本身不出现在正文里。它后面的自定义标题照旧投影。
	const callout = /^\[![^\]]*\][+-]?[ \t]*/.exec(line.slice(i));
	if (callout) i += callout[0].length;
	// 任务列表的复选框 `- [ ]` / `- [x]`：渲染成 checkbox，方括号不显示为正文
	const task = /^\[[ xX]\][ \t]*/.exec(line.slice(i));
	if (task) i += task[0].length;
	// 脚注定义 `[^1]:` → 渲染成脚注条目上的回链序号，冒号前的这串不显示为正文
	const footnote = /^\[\^[^\]]*\]:[ \t]*/.exec(line.slice(i));
	if (footnote) i += footnote[0].length;

	while (i < line.length) {
		const at = base + i;
		const rest = line.slice(i);

		// 转义：`\x` → 输出 `x`
		if (line[i] === "\\" && i + 1 < line.length) {
			push(line[i + 1]!, at + 1);
			i += 2;
			continue;
		}

		// 行尾块 ID `^abc123` → 渲染时被吃掉（不显示为正文）
		if (line[i] === "^" && /^\^[A-Za-z0-9-]+$/.test(rest)) break;

		// 行内代码：反引号个数任意，内部**原样**保留（不剥标记），内容进 skip
		const fence = /^(`+)([\s\S]*?)\1/.exec(rest);
		if (fence) {
			const inner = fence[2]!;
			const innerStart = at + fence[1]!.length;
			skip.push([at, at + fence[0].length]);
			for (let k = 0; k < inner.length; k++) push(inner[k]!, innerStart + k);
			i += fence[0].length;
			continue;
		}

		// 高亮标记 `==`（含紧随的颜色 emoji）→ 丢弃
		if (rest.startsWith("==")) {
			i += 2;
			const maybeEmoji = line.slice(i, i + 2);
			if (EMOJI_COLORS[maybeEmoji]) i += 2;
			continue;
		}

		// HTML 注释 `<!-- ... -->` → 整体丢弃（`<` 那条只认标签，注释不以字母开头）
		if (rest.startsWith("<!--")) {
			const end = line.indexOf("-->", i + 4);
			const stop = end < 0 ? line.length : end + 3;
			skip.push([at, base + stop]);
			i = stop;
			continue;
		}

		// 注释 `%%...%%` → 整体丢弃（阅读模式不渲染注释内容）
		if (rest.startsWith("%%")) {
			const end = line.indexOf("%%", i + 2);
			const stop = end < 0 ? line.length : end + 2;
			skip.push([at, base + stop]);
			i = stop;
			continue;
		}

		// 删除线 `~~x~~` → 丢弃标记
		if (rest.startsWith("~~")) { i += 2; continue; }

		// 行内数学 `$x$`：渲染成公式，**公式内容是有字形的** —— MathJax v4 CHTML 把
		// 每个字符各放进一个 <mjx-c>，其 textContent 就是那个字符本身（Obsidian 自己
		// 就靠它重建 MathML，见 obsidian.asar 的 reconstructMathMLFromMjx：读
		// `mjx-c.textContent`，而 mjx-strut / mjx-line / mjx-spacer / mjx-break /
		// mjx-mark 这些结构元素**不产文字**）。所以渲染口径的正文 = 公式内容去掉
		// `\` `_` `^` `{}` 这些不产生字形的 TeX 命令符。
		//
		// 旧实现把整段 `$...$` 丢弃 ⇒ 含公式的段落 `sameTokens(渲染文本, 投影)` 恒不
		// 成立 ⇒ 锚定整条失效 ⇒ 退化成全文搜索 ⇒ 选区只要**含公式**（渲染里是 `x+y`、
		// 源码里是 `$x+y$`）就搜不到 ⇒ 直接拒绝写入（用户报障「高亮无法写入」的另一类，
		// 与脚注引用同根）。
		//
		// 现在把公式内容按渲染口径投影（每个字符仍逐位指回自己的源码偏移），整段
		// `$...$` 仍记 skip：选区**恰含**公式时 `planHighlight` 会拒写（`$==x==$` 是
		// 坏公式），选区跨过公式则照常包 `==` —— 与脚注引用同一套口径。
		// 阴性对照 `__UR_BREAK_DEMARK_LEGACY` 注回「整段丢弃」的旧行为。
		if (line[i] === "$" && !rest.startsWith("$$")) {
			const math = /^\$(?![\s$])([^$\n]+?)\$/.exec(rest);
			if (math && !legacyDemark()) {
				const inner = math[1]!;
				const innerStart = at + 1;
				for (let k = 0; k < inner.length; k++) {
					const ch = inner[k]!;
					if (ch === "\\" || ch === "_" || ch === "^" || ch === "{" || ch === "}") continue;
					push(ch, innerStart + k);
				}
				skip.push([at, at + math[0].length]);
				i += math[0].length;
				continue;
			}
			// 旧行为（仅阴性档）：整段丢弃，正文里不留任何对应字符
			if (math) {
				skip.push([at, at + math[0].length]);
				i += math[0].length;
				continue;
			}
		}

		// 表格的竖线：渲染成单元格边界（视觉上是间隔），投影成一个空格，
		// 免得相邻单元格的文字在投影里粘成一坨、匹配错位
		if (line[i] === "|") { push(" ", at); i += 1; continue; }

		// 嵌入 `![[目标]]` → 整体丢弃：渲染出来的是**被嵌入文档的正文**，与这串源码
		// 字符毫无对应关系；留在投影里只会让跨嵌入的选区把 `![[...]]` 包进 `==`（实测
		// 会直接写坏笔记）。必须赶在图片分支之前 —— `![` 那条正则吃不下 `![[`。
		if (/^!\[\[/.test(rest)) {
			const emb = /^!\[\[[^\]]*\]\]/.exec(rest);
			if (emb) {
				skip.push([at, at + emb[0].length]);
				i += emb[0].length;
				continue;
			}
		}

		// 图片 `![alt](url)` → 整体丢弃（渲染成 <img>，alt 不显示为正文）
		if (rest.startsWith("![")) {
			const img = /^!\[[^\]]*\]\([^)]*\)/.exec(rest);
			if (img) {
				skip.push([at, at + img[0].length]);
				i += img[0].length;
				continue;
			}
		}

		if (line[i] === "[") {
			// 脚注**引用** `[^label]` → 阅读视图把它渲染成 `[label]`（本机 app.asar 的
			// `fnRef` 变换取证：丢 `^`、保留方括号，textValue = `"["+l+"]"`）。
			// 投影必须跟上这个字面，否则整块的 `sameTokens` 等式失败 → 锚定退化成全文
			// 搜索 → 选区稍重复即「高亮无法写入」（2026-10-11 报障根因之一）。
			// 整段标进 skip：脚注引用**不能**被 `==` 包住（写了会损坏 `[^1]`）。
			const fn = /^\[\^([^\]]*)\]/.exec(rest);
			if (fn && !legacyDemark()) {
				const label = fn[1]!;
				const labelStart = at + 2;
				push("[", at);                                        // 映射到源码的 `[`
				for (let k = 0; k < label.length; k++) push(label[k]!, labelStart + k);
				push("]", at + fn[0].length - 1);                     // 映射到源码的 `]`
				skip.push([at, at + fn[0].length]);
				i += fn[0].length;
				continue;
			}
			// 链接 `[text](url)` → 只留 text
			const ln = /^\[([^\]]*)\]\([^)]*\)/.exec(rest);
			if (ln) {
				const text = ln[1]!;
				const textStart = at + 1;
				for (let k = 0; k < text.length; k++) push(text[k]!, textStart + k);
				i += ln[0].length;
				continue;
			}
			// wiki 链接 `[[a|b]]` / `[[a#h]]` / `[[a]]` → 留显示名
			const wk = /^\[\[([^\]]*)\]\]/.exec(rest);
			if (wk) {
				const raw = wk[1]!;
				const bar = raw.indexOf("|");
				const alias = bar >= 0 ? raw.slice(bar + 1) : raw.replace(/#.*$/, "");
				const textStart = at + 2 + (bar >= 0 ? bar + 1 : 0);
				for (let k = 0; k < alias.length; k++) push(alias[k]!, textStart + k);
				i += wk[0].length;
				continue;
			}
		}

		// HTML 标签 → 丢弃
		if (line[i] === "<") {
			const tag = /^<\/?[a-zA-Z][^>]*>/.exec(rest);
			if (tag) {
				skip.push([at, at + tag[0].length]);
				i += tag[0].length;
				continue;
			}
		}

		// 强调标记 → 丢弃
		if (rest.startsWith("**") || rest.startsWith("__")) { i += 2; continue; }
		if (line[i] === "*" || line[i] === "_") { i += 1; continue; }

		push(line[i]!, at);
		i += 1;
	}
}

/**
 * 把 markdown 源码投影成「渲染后会看到的正文」+ 逐字符的源码偏移映射。
 *
 * frontmatter 与代码围栏整块跳过（不投影、记入 skip）；块级前缀丢弃；行内标记按
 * `inlineDemark` 处理。换行一律保留（跨行匹配与窗口计算都要靠它）。
 */
export function demark(src: string): Demarked {
	const chars: string[] = [];
	const map: number[] = [];
	const skip: Array<[number, number]> = [];
	// 块级禁区（frontmatter / 代码围栏 / 块公式 / 表格分隔行）：与行内 skip 分开记账，
	// 供 planHighlight 决定「整段丢弃」还是「端点外收」。见 Demarked.skipHard 注释。
	const skipHard: Array<[number, number]> = [];
	const markHard = (s: number, e: number): void => { skip.push([s, e]); skipHard.push([s, e]); };
	const push = (ch: string, at: number): void => { chars.push(ch); map.push(at); };

	let lineStart = 0;
	let inFence = false;
	let inFrontmatter = false;
	let inMath = false;
	let isFirstLine = true;

	while (lineStart <= src.length) {
		let lineEnd = src.indexOf("\n", lineStart);
		const hasNewline = lineEnd >= 0;
		if (!hasNewline) lineEnd = src.length;
		const line = src.slice(lineStart, lineEnd);

		if (isFirstLine && /^---[ \t]*$/.test(line)) {
			inFrontmatter = true;
			markHard(lineStart, lineEnd);
		} else if (inFrontmatter) {
			markHard(lineStart, lineEnd);
			// 闭合标记：`---` 或 `...`
			if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) inFrontmatter = false;
		} else if (/^[ \t]*(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			markHard(lineStart, lineEnd);
		} else if (inFence) {
			markHard(lineStart, lineEnd);
		} else if (/^[ \t]*\$\$[ \t]*$/.test(line)) {
			// 块级公式围栏 `$$`：整行不投影，内部同代码围栏处理
			inMath = !inMath;
			markHard(lineStart, lineEnd);
		} else if (inMath) {
			markHard(lineStart, lineEnd);
		} else if (TABLE_DIVIDER_RE.test(line)) {
			// 表格分隔行 `|---|---|`：渲染不出来，投影里留着它只会让上下单元格连错
			markHard(lineStart, lineEnd);
		} else {
			inlineDemark(line, lineStart, push, skip);
		}

		if (!hasNewline) break;
		push("\n", lineEnd);
		lineStart = lineEnd + 1;
		isFirstLine = false;
	}

	return { plain: chars.join(""), map, skip, skipHard };
}

/** 第 `line` 行（0 基）的起始字符偏移。越界钳到 0 / 文本末。 */
export function lineOffsetAt(src: string, line: number): number {
	if (line <= 0) return 0;
	let seen = 0;
	let i = 0;
	while (i < src.length) {
		const nl = src.indexOf("\n", i);
		if (nl < 0) return src.length;
		seen += 1;
		if (seen >= line) return nl + 1;
		i = nl + 1;
	}
	return src.length;
}

/**
 * 在 haystack 里按「非空白片段顺序出现」查找 needle（容忍空白差异）。
 *
 * 渲染会把源码里的软换行显示成空格、把多个空格并成一个，所以朴素 `indexOf` 会大面积失败。
 * 按非空白 token 顺序匹配可以绕开这一点，代价是位置精度由首个/末个 token 决定。
 * 返回 haystack 的 `[start, end)` 码元区间；找不到返回 null。
 */
export function looseFind(hay: string, needle: string, from = 0): [number, number] | null {
	const tokens = needle.split(/\s+/).filter(t => t.length > 0);
	if (!tokens.length) return null;
	let pos = from;
	let start = -1;
	for (const t of tokens) {
		const idx = hay.indexOf(t, pos);
		if (idx < 0) return null;
		if (start < 0) start = idx;
		pos = idx + t.length;
	}
	return [start, pos];
}

/** `looseFind` 的全部候选（按出现顺序），去重后最多 `limit` 个。 */
export function findLooseCandidates(hay: string, needle: string, limit = 64): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let from = 0;
	while (out.length < limit) {
		const hit = looseFind(hay, needle, from);
		if (!hit) break;
		out.push(hit);
		from = hit[0] + 1;
	}
	return out;
}

/** 左端收缩到正文（跳过行首缩进、块前缀与表格竖线），右端去尾部空白。 */
function trimToBody(src: string, from: number, to: number): [number, number] | null {
	let s = from;
	let e = to;
	// 左端：先收掉空白 —— **含换行**。块级禁区（围栏 / frontmatter）的切点会把段首留在
	// `\n` 之后（`src[s-1]` 是围栏的 `` ` `` 而不是换行），只按 `src[s-1] === "\n"` 判断
	// 会漏掉这一档，写出 `==\n\n后文==` 这种畸形（与右端已收 `\n` 的做法对齐）。
	while (s < e && (src[s] === " " || src[s] === "\t" || src[s] === "\n" || src[s] === "\r")) s += 1;
	// 剥块前缀的前提是**确实处在一行开头**（收完空白后往回看）：
	if (s === 0 || src[s - 1] === "\n") {
		const pre = BLOCK_PREFIX_RE.exec(src.slice(s, e));
		if (pre) s += pre[0].length;
		// callout 类型标记 / 任务复选框 / 表格竖线：和块前缀同一性质，留在 `==` 里会渲染失败
		const extra = /^(?:\[![^\]]*\][+-]?[ \t]*|\[[ xX]\][ \t]*|\|[ \t]*)/.exec(src.slice(s, e));
		if (extra) s += extra[0].length;
	}
	// 右端：空白、表格竖线与**换行**都要收掉 —— 块切点留下的换行跟着进 `==` 会写出
	// `==第一段\n\n==` 这种跨块畸形（旧实现只按空行切，段尾恰好不含单换行才躲过）
	while (e > s && (src[e - 1] === " " || src[e - 1] === "\t" || src[e - 1] === "|"
		|| src[e - 1] === "\n" || src[e - 1] === "\r")) e -= 1;
	if (e <= s) return null;
	return [s, e];
}

/**
 * 表格行里 markdown-it 会当作**单元格分隔符**的 `|` 的源码位置（升序）。
 *
 * **判据必须与 markdown-it 对齐**：表格是**块级** tokenizer，先把整行按 `|` 裸切成单元格，
 * **再**对每格做 inline 解析。它的切分器（asar 里的 `escapedSplit`）**只**跳过反斜杠转义的
 * `\|`，**不认识行内代码 / 公式** —— 所以 `` | `a|b` | 说明 | `` 里的 `|` 照样被当格线切。
 * 由此得两条结论：
 *  · `==a | b==` 会被切成 `==a` 与 `b==` 两格、两侧各缺一个 `==` ⇒ 渲染成字面量并写坏表格；
 *    故跨格线的 run 必须在此处再切、各格各自成段（`==a== | ==b==`）。
 *  · 若格线**落在某段行内构造内部**（如上例的反引号里），该行源码本身就被 markdown-it 切坏、
 *    渲染与投影对不上 —— 这种行**无法安全写入**，调用方应整次拒写（返回 null），而不是硬切。
 *
 * 只认**表格行**（该行行首非空白后是 `|`）里的 `|`；反斜杠转义的 `\|` 不算（与
 * `escapedSplit` 一致）。判「表格行」时用**源码真实行首**（不是传入的 `from` —— 它可能已被
 * `trimToBody` 剥掉了行首 `|`，按 `from` 起判会漏掉整行）。
 */
function tableBarCuts(src: string, from: number, to: number): number[] {
	if (tableBarBreak()) return [];
	const cuts: number[] = [];
	for (let k = from; k < to; k++) {
		if (src[k] !== "|") continue;
		if (isEscapedAt(src, k)) continue;
		const lineStart = src.lastIndexOf("\n", k - 1) + 1;
		let lineEnd = src.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = src.length;
		if (!/^[ \t]*\|/.test(src.slice(lineStart, lineEnd))) continue;
		cuts.push(k);
	}
	return cuts;
}

/** 「这一行是不是一个新块的开头」（可缩进）：标题 / 引用 / 列表项 / 有序项 / 表格行。 */
const BLOCK_START_RE = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+|\|)/;

/**
 * `seg` 内部所有「新段起点」的下标（升序、去重，首段必为 0）。
 *
 * 判据两条：空行之后（跨段落）；以及行首是新块开头（跨列表项 / 引用行 / 标题 / 表格行）。
 */
function collectBlockStarts(seg: string): number[] {
	const starts = [0];
	let lineStart = 0;
	let blankRun = false;
	while (lineStart <= seg.length) {
		let nl = seg.indexOf("\n", lineStart);
		if (nl < 0) nl = seg.length;
		const line = seg.slice(lineStart, nl);
		const isBlank = /^[ \t]*$/.test(line);
		if (lineStart > 0 && !isBlank && (blankRun || BLOCK_START_RE.test(line))) {
			if (starts[starts.length - 1] !== lineStart) starts.push(lineStart);
		}
		blankRun = isBlank;
		if (nl >= seg.length) break;
		lineStart = nl + 1;
	}
	return starts;
}

/**
 * 把源码区间按**块边界**切成若干可各自包一对 `==` 的段。
 *
 * 官方的 `==` **不能跨空行**（跨了会渲染成字面量），也不能把 `> ` / `- ` 这类块前缀包进去。
 * 所以跨段落/跨列表项的选区必须逐段包裹，段间的空行与原前缀原样保留。
 */
export function splitRuns(src: string, from: number, to: number): Array<[number, number]> {
	const seg = src.slice(from, to);
	const parts: Array<[number, number]> = [];
	// 切点 = ① 空行（跨段落）② 任何「新块开头行」的行首（跨列表项 / 跨引用行 /
	// 跨标题 / 跨表格行）。只按空行切是不够的：列表项之间只隔一个换行，旧实现会把
	// 「- a\n- b」当成一整段 → 写出 `==a\n- b==`，`- ` 被包进高亮里，列表直接渲染坏。
	const starts = collectBlockStarts(seg);
	for (let n = 0; n < starts.length; n++) {
		const s = starts[n]!;
		const e = (n + 1 < starts.length ? starts[n + 1]! : seg.length);
		parts.push([s, e] as [number, number]);
	}

	const out: Array<[number, number]> = [];
	for (const [s, e] of parts) {
		const trimmed = trimToBody(src, from + s, from + e);
		if (trimmed) out.push(trimmed);
	}
	return out.length ? out : [[from, to]];
}

export interface ResolvedRange {
	/** 源码码元区间，左闭右开 */
	from: number
	to: number
	/** 逐段可包裹区间（单段时与 [from, to) 一致或更紧） */
	runs: Array<[number, number]>
	confidence: "exact" | "window" | "heuristic"
}

/**
 * 把渲染层拿到的选区文字解析成源码区间。
 *
 * `window` 是消歧用的源码窗口（由调用方用官方渲染分节的行号算出，见 mdOverlay）——
 * 同一段文字在文中出现多次时，先按窗口过滤能唯一化绝大多数情况；窗口缺失时退回
 * 「取第一个候选」。**任何一步失败都返回 null（宁可不写）**。
 */
export function resolveSelection(
	src: string,
	dem: Demarked,
	selText: string,
	window?: [number, number] | null,
): ResolvedRange | null {
	const needle = selText.trim();
	if (!needle) return null;

	const cands = findLooseCandidates(dem.plain, needle);
	if (!cands.length) return null;

	let picked: [number, number] | null = null;
	let confidence: ResolvedRange["confidence"] = "heuristic";

	if (window) {
		const inWindow: Array<[number, number]> = [];
		for (const c of cands) {
			const s = dem.map[c[0]];
			const lastIdx = c[1] - 1;
			const e0 = lastIdx >= 0 ? dem.map[lastIdx] : undefined;
			if (s == null || e0 == null) continue;
			if (s >= window[0] && e0 + 1 <= window[1]) inWindow.push(c);
		}
		// 消歧后仍有多处 → **拒绝**。旧实现在这里 break 取第一个：同一句话在文里出现
		// 三次时高亮就落在第一处，用户看到的是「我点这儿，别处亮了」。
		if (inWindow.length === 1) {
			picked = inWindow[0]!;
			confidence = "window";
		} else if (inWindow.length > 1) {
			return null;
		}
	}
	if (!picked) {
		// 没有窗口（老版本没有 renderer.sections）或窗口没兜住：全文档唯一才敢写
		if (cands.length !== 1) return null;
		picked = cands[0]!;
		confidence = "exact";
	}

	const firstIdx = picked[0];
	const lastIdx = picked[1] - 1;
	const from = dem.map[firstIdx];
	const lastAt = lastIdx >= 0 ? dem.map[lastIdx] : undefined;
	if (from == null || lastAt == null) return null;
	const to = lastAt + 1;
	if (to <= from) return null;

	return { from, to, runs: splitRuns(src, from, to), confidence };
}

export type HighlightKind = "none" | "exact" | "inside" | "partial";

export interface HighlightHit {
	kind: HighlightKind
	/** 命中 span 的源码区间（kind !== "none" 时有效），左闭右开 */
	spanStart?: number
	spanEnd?: number
	/** 内容区间（已跳过开 `==` 与其后的颜色 emoji） */
	contentStart?: number
	contentEnd?: number
	/** "yellow" = 无 emoji 的默认档，其余为 emoji 对应的色名 */
	color?: string
}

interface HlSpan {
	openStart: number
	closeEnd: number
	contentStart: number
	contentEnd: number
	color: string
}

/** 一个已配对的官方 `==...==` 高亮（含彩色 emoji 前缀）。 */
export interface MdHighlightSpan extends HlSpan {
	/** 去标记后的投影正文（渲染口径，与屏幕上看到的一致）。 */
	plain: string
}

/**
 * 枚举笔记源码里所有合法的官方高亮（供侧边栏「高亮」列表使用）。
 * 与划词写入共用同一套配对规则，保证「所见即所删」。
 */
export function collectHighlights(src: string): MdHighlightSpan[] {
	const dem = demark(src)
	return collectHighlightSpans(src, dem.skip).map(sp => {
		let plain = ""
		for (let i = 0; i < dem.map.length; i++) {
			const off = dem.map[i]
			if (off == null) continue
			if (off >= sp.contentStart && off < sp.contentEnd) plain += dem.plain[i] ?? ""
		}
		return { ...sp, plain: plain.trim() }
	})
}

/** 扫描出源码里所有合法的 `==...==` 配对（按出现顺序两两配对，跳过代码区）。 */
function collectHighlightSpans(src: string, skip: Array<[number, number]>): HlSpan[] {
	const positions: number[] = [];
	let i = 0;
	while (i < src.length - 1) {
		if (src[i] === "=" && src[i + 1] === "=") {
			if (!inSkip(skip, i)) {
				// 反斜杠转义的 `\==` 不算标记
				let backslashes = 0;
				let k = i - 1;
				while (k >= 0 && src[k] === "\\") { backslashes += 1; k -= 1; }
				if (backslashes % 2 === 0) positions.push(i);
			}
			i += 2;
			continue;
		}
		i += 1;
	}

	const out: HlSpan[] = [];
	for (let n = 0; n + 1 < positions.length; n += 2) {
		const open = positions[n]!;
		const close = positions[n + 1]!;
		let contentStart = open + 2;
		let color = "yellow";
		const maybeEmoji = src.slice(contentStart, contentStart + 2);
		if (EMOJI_COLORS[maybeEmoji]) {
			color = EMOJI_COLORS[maybeEmoji]!;
			contentStart += 2;
		}
		// 跨空行的配对是畸形（官方 `==` 不跨空行）→ 不当作高亮，避免误删
		const inner = src.slice(contentStart, close);
		if (/\n[ \t]*\n/.test(inner)) continue;
		out.push({ openStart: open, closeEnd: close + 2, contentStart, contentEnd: close, color });
	}
	return out;
}

/** 判断选区相对已有高亮的位置：完全等于内容 / 落在某个高亮内部 / 部分重叠 / 无关。 */
export function analyzeHighlight(src: string, dem: Demarked, from: number, to: number): HighlightHit {
	const spans = collectHighlightSpans(src, dem.skip);
	for (const sp of spans) {
		const partial: HighlightHit = {
			kind: "partial",
			spanStart: sp.openStart,
			spanEnd: sp.closeEnd,
			contentStart: sp.contentStart,
			contentEnd: sp.contentEnd,
			color: sp.color,
		};
		if (from === sp.contentStart && to === sp.contentEnd) {
			return { ...partial, kind: "exact" };
		}
		if (from >= sp.openStart && to <= sp.closeEnd) {
			return { ...partial, kind: "inside" };
		}
		if (from < sp.closeEnd && to > sp.openStart) {
			return partial;
		}
	}
	return { kind: "none" };
}

export interface EditPlan {
	from: number
	to: number
	replacement: string
}

/**
 * 源码区间 `[a, b)` 里是否存在**会渲染出字形**的字符（判据走投影本身）。
 *
 * `dem.map[i]` 是 `plain[i]` 的源码位置 ⇒ 若某个 `map[i] ∈ [a,b)` 且 `plain[i]` 不是
 * 空白，就说明这段源码里有用户**看得见**的内容。行内构造的**定界符**（反引号 / `$` /
 * `%%` / `![[` / `![`）不产字形 —— 它们要么不在 `map` 里，要么只映射出一个空格
 * （表格 `|` 走 `push(" ", at)`）。这正好把两件必须区分的事分开：
 *  · 端点**恰好压在标记串上**（`[S, bs)` 一个字形都没有）⇒ 用户选中的就是这颗行内
 *    构造的**全部内容** ⇒ 应把整颗（含标记）包进 `==`（官方 `mark` 的 body 会重新走
 *    `tokenizeInline`，`==` 可以跨过一整颗行内代码 / 公式，见 `Demarked.skipHard`）；
 *  · 端点**切进了正文**（`[S, bs)` 含字形）⇒ 构造被劈成一半，只能整颗收掉（旧行为）。
 *
 * `map` 是扫描源码时顺序 push 出来的（非递减），故用二分找下界后线性扫到 `b` 为止，
 * 不必每次从头扫（真机 100KB 笔记 × 每个 skip 都从头的代价不可接受）。
 */
function hasGlyphIn(dem: Demarked, a: number, b: number): boolean {
	if (b <= a) return false;
	const m = dem.map;
	let lo = 0;
	let hi = m.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (m[mid]! < a) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < m.length && m[i]! < b; i += 1) {
		const ch = dem.plain[i];
		if (ch != null && !/\s/.test(ch)) return true;
	}
	return false;
}

/**
 * 生成「把选中区间变成高亮（或取消/换色）」的一次性编辑计划。
 *
 * 返回 null = **不做任何写入**（语法会被写坏、或定位不可靠时的唯一正确处置）。
 *
 * 行为矩阵：
 * - 未高亮 → 新建；跨段则逐段各包一对 `==`；
 * - 已是**同色** → 取消（去掉 `==` 与 emoji，保留正文）；
 * - 已是**异色** → 换色（只替换 emoji）；
 * - 落在高亮内部/部分重叠 → 作用于**整个高亮**（`==` 不允许嵌套）。
 *
 * `emojiEnabled` = 宿主支持官方彩色高亮（见 obsidianCapabilities.supportsColorHighlight）。
 * 为 false 时一律只写裸 `==`（= 官方默认黄），**绝不写 emoji**（旧版会裸露成文字）。
 */
export function planHighlight(
	src: string,
	dem: Demarked,
	range: ResolvedRange,
	hit: HighlightHit,
	colorName: string,
	emojiEnabled: boolean,
): EditPlan | null {
	const emoji = emojiEnabled ? (COLOR_EMOJI[colorName] ?? "") : "";

	// ① 已高亮 → 作用于整个 span
	if (
		hit.kind !== "none" &&
		hit.spanStart != null && hit.spanEnd != null &&
		hit.contentStart != null && hit.contentEnd != null
	) {
		const body = src.slice(hit.contentStart, hit.contentEnd);
		if (!body.trim()) return null;
		// 同色 → 取消；旧版（写不出 emoji）点黄同样等价于"同色"
		const sameColor = hit.color === colorName || (!emojiEnabled && hit.color === "yellow");
		if (sameColor) return { from: hit.spanStart, to: hit.spanEnd, replacement: body };
		return { from: hit.spanStart, to: hit.spanEnd, replacement: `==${emoji}${body}==` };
	}

	// ② 未高亮 → 新建
	const breakEdge = skipEdgeBreak();
	const rawRuns = range.runs.length ? range.runs : ([[range.from, range.to]] as Array<[number, number]>);
	const bodies: Array<{ span: [number, number]; text: string }> = [];
	for (const [s0, e0] of rawRuns) {
		if (s0 >= e0) continue;
		// ① 端点收边：行内 skip（行内代码 / 公式 / 注释 / 嵌入 / 图片）只把**跨越端点
		// 的标记**收回去。`==` 可以跨过一整颗行内代码（官方 `mark` 规则把 body 交回
		// `tokenizeInline` 重新分词，见 obsidian.asar 的 `Qp(e,"mark",…)`），所以
		// 「选中一句含 `` `code` `` 的话」是**合法**选区；只有端点半截进标记（反引号 /
		// `$` 被劈开）时才收到标记之外。整颗标记完整落在 run 内时两端都不越界 ⇒ 保留。
		let bs = s0;
		let be = e0;
		let guard = 0;
		while (guard++ < 16) {
			let moved = false;
			for (const [S, E] of dem.skip) {
				if (E <= bs || S >= be) continue;
				// 块级禁区（frontmatter / 围栏 / 块公式 / 表格分隔行）**绝不可外扩**：它的
				// 「标记」是整块的定界符（`---` / ``` ``` ``` / `$$`），包进 `==` 必坏。
				// 只有**行内**构造（行内代码 / 行内数学 / 注释 / 嵌入 / 图片）才允许「整颗包进来」。
				const block = inSkip(dem.skipHard, S);
				if (S < bs) {
					// 端点**恰好落在标记串上**（`[S, bs)` 一个字形都没有）⇒ 用户选的是这颗
					// 行内构造的全部内容 ⇒ 把整颗（含定界符）包进来，而不是把它整颗丢掉。
					// 这是「选中整格 `` `git status` `` 却只高亮了邻格」的根因：锚定给出的
					// `from` 是**首个可见字符**（`g`），比标记串起点（开引号）晚一格，旧判据
					// 一律 `bs = E` ⇒ 整颗代码被丢。
					bs = (!block && !hasGlyphIn(dem, S, bs)) ? S : E;
					moved = true;
				}
				if (E > be) {
					// 右端镜像同理：终点落在闭引号之后 ⇒ 把这颗构造收进 `==`。
					be = (!block && !hasGlyphIn(dem, be, E)) ? E : S;
					moved = true;
				}
			}
			if (!moved) break;
		}
		if (be <= bs) continue;
		// ② 块级禁区（frontmatter / 围栏 / 块公式 / 表格分隔行）按**边界切开**（不整段丢：
		// 跨围栏的大选区，围栏两侧的正文仍应各自成段）。切点落在行首/行尾，故切完要再
		// `trimToBody` 收掉残留的空白与换行（与 splitRuns 同一套收边，避免写出 `==前文\n\n==`）。
		let segs: Array<[number, number]>;
		if (breakEdge) {
			segs = [[bs, be]];
		} else {
			let unsafe = false;
			segs = subtractSpans(bs, be, dem.skipHard).flatMap(([a, b]) => {
				// 表格行：markdown-it 的表格是**块级** tokenizer，先把整行按 `|` 裸切格
				// （只跳 `\|`，**不认识行内代码**）、再对每格 inline 解析。于是：
				//  · 格线在 `==` 内 ⇒ 被切成两半、各缺一个 `==` ⇒ 写坏表格 —— 须在此再切
				//    一刀、各格各自成段（`==a== | ==b==`），与块级行为对齐；
				//  · 格线落在某段行内构造内部（如 `` `a|b` `` 的反引号里）⇒ 该行源码本就被
				//    markdown-it 切错、渲染与投影对不上 ⇒ **无法安全写入**（整次拒写）。
				const bars = tableBarCuts(src, a, b);
				if (bars.some(k => inSkip(dem.skip, k))) { unsafe = true; return []; }
				return subtractSpans(a, b, bars.map(k => [k, k + 1] as [number, number]));
			}).map(([a, b]) => trimToBody(src, a, b))
				.filter((x): x is [number, number] => x != null);
			if (unsafe) return null;
		}
		for (const [segS, segE] of segs) {
			if (breakEdge) {
				// 阴性对照：旧判据 —— 端点沾到任一 skip 即整段丢弃。
				if (inSkip(dem.skip, segS) || inSkip(dem.skip, Math.max(segS, segE - 1))) continue;
			}
			const body = src.slice(segS, segE);
			if (!body.trim()) continue;
			// 内部已经有**真正的高亮标记** `==` → 不双包（会写坏语法）。
			// 跳过 skip：行内代码 / 公式里的 `==` 是代码内容，不该中止整次高亮。
			if (hasUnescapedMarker(src, segS, segE, dem.skip)) return null;
			bodies.push({ span: [segS, segE], text: `==${emoji}${body}==` });
		}
	}
	if (!bodies.length) return null;
	if (bodies.length === 1) {
		const b = bodies[0]!;
		return { from: b.span[0], to: b.span[1], replacement: b.text };
	}

	// 多段：整段替换，段间原文（空行 / 前缀）原样保留
	const first = bodies[0]!.span[0];
	const last = bodies[bodies.length - 1]!.span[1];
	let replacement = "";
	let cursor = first;
	for (const b of bodies) {
		replacement += src.slice(cursor, b.span[0]) + b.text;
		cursor = b.span[1];
	}
	replacement += src.slice(cursor, last);
	return { from: first, to: last, replacement };
}

/* =========================================================================
 * token 锚定：把「渲染层选区」精确映射成源码区间
 * -------------------------------------------------------------------------
 * 上面那条「投影 + 宽松搜索」的路子有个先天缺陷：它是在**猜**位置 —— 同一句话在
 * 文中出现几次就有几个候选，窗口糊了就静默取第一个（实测：三处重复时高亮落在第
 * 一处）。锚定换了个问法：不问「这句话在源码里第几次出现」，而问「用户手指落下的
 * 那个位置，是这段渲染文本里的第几个词」。
 *
 * 渲染文本（DOM 的 textContent）与源码投影（demark 的 plain）虽然字符数不同，但
 * **词的序列应当逐条相同** —— 这正是可以校验的判据。校验通过后，第 k 个词 → 源码
 * 偏移就是一一对应的，没有任何歧义可言。
 * ========================================================================= */

/** 一个非空白片段及其在原文里的字符区间（左闭右开）。 */
export interface TokenSpan {
	start: number
	end: number
}

/** 按空白切出片段序列（渲染把换行显示成空格，所以只认空白，不认标点）。 */
export function tokenize(text: string): TokenSpan[] {
	const out: TokenSpan[] = [];
	const re = /\S+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
	return out;
}

/** 字符偏移落在第几个片段上（落在空白里 = 它前面已结束的片段数）。 */
export function tokenIndexAt(text: string, offset: number): number {
	if (offset <= 0) return 0;
	const slice = text.slice(0, offset);
	const toks = tokenize(slice);
	if (!toks.length) return 0;
	const last = toks[toks.length - 1]!;
	// 偏移正好压在这个片段内部 → 序号算它自己（用户是从这个词里开始拖的）
	return last.end >= offset ? toks.length - 1 : toks.length;
}

/**
 * 第 `visibleIndex` 个（0 基）**可见字符**落在第几个片段上。
 *
 * 与 `tokenIndexAt` 的分工：那个按**字符偏移**数，而偏移是坐标系相关的 ——
 * `anchorRange` 里的 `off` 来自 `textOffsetIn`（`textContent` 口径，树遍历累加文本节点），
 * 要拿它去 `innerText` 文本里数词，中间隔着块级子元素补的 `\n`（`<li>` / `<p>` /
 * `<td>` 边界）就会整体错位，词级锚定于是落到**错误的词**上 —— 对连写文字就是
 * 「高亮了整个块」。这里改用**可见字符计数**（两侧同一套口径，与 innerText/textContent
 * 的差异无关），彻底绕开坐标系混用。
 */
export function tokenIndexAtVisible(text: string, visibleIndex: number): number {
	const toks = tokenize(text);
	if (!toks.length) return 0;
	if (visibleIndex <= 0) return 0;
	let seen = 0;
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!;
		const len = t.end - t.start;
		if (visibleIndex < seen + len) return i;
		seen += len;
	}
	return toks.length;
}

/** 两段文本的片段序列是否逐段同文本（空白差异不算差异）。 */
export function sameTokens(a: string, b: string): boolean {
	const ta = tokenize(a);
	const tb = tokenize(b);
	if (ta.length !== tb.length) return false;
	for (let i = 0; i < ta.length; i++) {
		const x = ta[i]!;
		const y = tb[i]!;
		if (a.slice(x.start, x.end) !== b.slice(y.start, y.end)) return false;
	}
	return true;
}

/** 从全量投影里裁出 `[from, to)` 那一段（map 仍是**绝对**源码偏移）。 */
export function demarkWindow(src: string, from: number, to: number): Demarked {
	const dem = demark(src);
	const map = dem.map;
	// 第一个 map[i] >= from
	let lo = 0;
	let hi = map.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((map[mid] ?? 0) < from) lo = mid + 1;
		else hi = mid;
	}
	const s = lo;
	// 最后一个 map[i] < to
	lo = s;
	hi = map.length - 1;
	let e = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((map[mid] ?? 0) < to) { e = mid; lo = mid + 1; }
		else hi = mid - 1;
	}
	if (e < s) return { plain: "", map: [], skip: [], skipHard: [] };
	const skip: Array<[number, number]> = [];
	for (const [a, b] of dem.skip) {
		const x = Math.max(a, from);
		const y = Math.min(b, to);
		if (y > x) skip.push([x, y]);
	}
	const skipHard: Array<[number, number]> = [];
	for (const [a, b] of dem.skipHard) {
		const x = Math.max(a, from);
		const y = Math.min(b, to);
		if (y > x) skipHard.push([x, y]);
	}
	return {
		plain: dem.plain.slice(s, e + 1),
		map: map.slice(s, e + 1),
		skip,
		skipHard,
	};
}

/**
 * 用 token 锚定把选区解析成**唯一**源码区间。
 *
 * `domText` = 选区所在渲染块的 textContent；`anchorToken` = 选区起点在这个文本里是
 * 第几个片段；`tokenCount` = 选区本身跨了几个片段。三者齐全时位置是算出来的，不是
 * 搜出来的。任何一条对不上都返回 null（调用方退回搜索路径）。
 */
export function resolveByTokens(
	src: string,
	dem: Demarked,
	domText: string,
	anchorToken: number,
	tokenCount: number,
): ResolvedRange | null {
	if (!sameTokens(domText, dem.plain)) return null;
	const toks = tokenize(dem.plain);
	if (tokenCount <= 0 || anchorToken < 0 || anchorToken + tokenCount > toks.length) return null;
	const head = toks[anchorToken]!;
	const tail = toks[anchorToken + tokenCount - 1]!;
	const from = dem.map[head.start];
	const lastAt = dem.map[tail.end - 1];
	if (from == null || lastAt == null) return null;
	const to = lastAt + 1;
	if (to <= from) return null;
	return { from, to, runs: splitRuns(src, from, to), confidence: "exact" };
}

/** 去掉全部空白。字符级对齐只看**可见字符**（渲染会把软换行显示成空格、把源码里的
 *  `\n` 吃掉，空白逐字对齐本来就不可能）。 */
function stripSpace(s: string): string {
	return s.replace(/\s+/g, "");
}

/** 第 `n` 个（1 基）非空白字符在 `s` 里的下标；`n <= 0` → 0，超出 → `s.length`。 */
function nthNonSpace(s: string, n: number): number {
	if (n <= 0) return 0;
	let seen = 0;
	for (let i = 0; i < s.length; i++) {
		if (/\s/.test(s[i]!)) continue;
		seen += 1;
		if (seen === n) return i;
	}
	return s.length;
}

/** `s` 前 `upto` 个码元里有几个非空白字符。 */
export function countNonSpace(s: string, upto: number): number {
	let seen = 0;
	const end = Math.min(Math.max(upto, 0), s.length);
	for (let i = 0; i < end; i++) if (!/\s/.test(s[i]!)) seen += 1;
	return seen;
}

/**
 * **字符级**锚定（2026-10-11 新增）：把选区的**字符区间**直接落到源码偏移上。
 *
 * 为什么必须补这条通道（用户报障「阅读模式下点高亮，不高亮选中文字，而是高亮**整个
 * 段落**」、且「还是不行」）：`resolveByTokens` 的锚点粒度是**词**（`tokenize` 按
 * `/\S+/` 切），而中文/日文这类**不用空格分词**的文字里，整段就是一个词 —— 于是
 * 「段中间划了七个字」被解析成「第 0 个词 → 第 0 个词」，写进笔记的 `==` 包住**整段**。
 * 词级锚点对空格语言（英文）够用，对连写文字必然退化成整段，所以这里并列一条字符级
 * 通道：`anchorRange` **先试它**，失败再退回词级（词级是英文主力，也是本通道对不上时的兜底）。
 *
 * 对齐判据（比 `sameTokens` 严在「逐字符」，宽在「空白完全不参与」）：
 * 两侧**去掉全部空白后必须逐字符相同**。demark 已经把标记（`**` / `[](...)` / `==`）
 * 剥掉，剩下的可见字符两侧应当一致；不满足就返回 null，**绝不猜**。
 *
 * `anchorOffset` / `spanLength` 必须与 `domText` **同一坐标系** —— 都用元素的
 * `textContent` 口径（与 `textOffsetIn` 的树遍历一致）；不要混 `innerText`（它会在块级
 * 子元素之间补 `\n`，与 `textContent` 的偏移对不上）。
 */
export function resolveByCharSpan(
	src: string,
	dem: Demarked,
	domText: string,
	anchorOffset: number,
	spanLength: number,
): ResolvedRange | null {
	if (anchorOffset < 0 || spanLength <= 0) return null;
	const off = Math.min(anchorOffset, domText.length);
	const end = Math.min(off + spanLength, domText.length);
	// 两侧可见字符序列必须逐字符相同（唯一的对齐凭据）
	const stripped = stripSpace(domText);
	if (!stripped || stripped !== stripSpace(dem.plain)) return null;
	const kFrom = countNonSpace(domText, off);   // 选区起点前有 kFrom 个可见字符
	const kTo = countNonSpace(domText, end);     // 选区终点前有 kTo 个可见字符
	if (kTo <= kFrom || kTo > stripped.length) return null;
	const iFrom = nthNonSpace(dem.plain, kFrom + 1); // 第 kFrom+1 个可见字符
	const iTo = nthNonSpace(dem.plain, kTo);         // 第 kTo 个可见字符（区间右端取它 +1）
	const from = dem.map[iFrom];
	const lastAt = dem.map[iTo];
	if (from == null || lastAt == null) return null;
	const to = lastAt + 1;
	if (to <= from) return null;
	return { from, to, runs: splitRuns(src, from, to), confidence: "exact" };
}

/**
 * **块内字符级锚定（窗口可能比块大时）**（2026-10-12 新增）。
 *
 * 与 `resolveByCharSpan` 的分工：那个函数要求 `dem`（窗口投影）**恰好就是这一块**
 * （`stripSpace(两侧) 全等`）。可真机上 `windowForSelection` 给出的分节行范围经常
 * **比块大** —— 一个分节含多个块（多段引用 / 整个列表）、或节定位落到了邻节。
 * 此时「块文本 == 窗口投影」的全等必然不成立 ⇒ 字符级锚定失败 ⇒ 只剩词级锚定，
 * 而词级对中文/日文这种连写文字会把**整块当一个词** ⇒ 「点了标题里三个字，
 * 高亮了整个标题」（2026-10-12 用户报障 A）。
 *
 * 换一个问法：**先在窗口投影里定位这块文本**（去空白后整块作为子串，且必须唯一），
 * 再把选区的字符区间按「块内第几个可见字符 → 窗口内第几个可见字符」平移过去。
 * 窗口取不到时调用方传整篇投影（`demark(src)`）同样成立 —— 只要这块文本在全篇唯一。
 *
 * 定位不唯一 / 定位不到 ⇒ 返回 null（宁可不写，不猜）。
 */
export function resolveByCharSpanInBlock(
	src: string,
	dem: Demarked,
	domText: string,
	anchorOffset: number,
	spanLength: number,
): ResolvedRange | null {
	if (anchorOffset < 0 || spanLength <= 0) return null;
	const blockStripped = stripSpace(domText);
	if (!blockStripped) return null;
	const winStripped = stripSpace(dem.plain);
	// 这块文本在窗口投影里的起点（可见字符坐标）
	const at = winStripped.indexOf(blockStripped);
	if (at < 0) return null;
	// 唯一性：同一块文本在窗口里出现多次 ⇒ 位置不可判定，绝不猜
	if (winStripped.indexOf(blockStripped, at + 1) >= 0) return null;
	const kFrom = at + countNonSpace(domText, Math.min(anchorOffset, domText.length));
	const kTo = at + countNonSpace(domText, Math.min(anchorOffset + spanLength, domText.length));
	if (kTo <= kFrom || kTo > winStripped.length) return null;
	const iFrom = nthNonSpace(dem.plain, kFrom + 1);
	const iTo = nthNonSpace(dem.plain, kTo);
	const from = dem.map[iFrom];
	const lastAt = dem.map[iTo];
	if (from == null || lastAt == null) return null;
	const to = lastAt + 1;
	if (to <= from) return null;
	return { from, to, runs: splitRuns(src, from, to), confidence: "exact" };
}
