/** AI 全文类任务（全文翻译 / 排版优化 / 自定义功能）的内容提取、执行与**正文替换**。
 *
 * 替换口径：直接对**当前渲染帧的文档**做块级 textContent 替换 —— 书与 Feed 共用
 * 一条路（Feed 的合成书也是单节帧）；图片/样式元素不动，只换块内文字；原正文
 * 存在于 store/源文件中，重开文章或换章重渲染即自然恢复原文，不做存储改写。
 *
 * 分块口径：按块级元素（p / li / h1-h6 / blockquote / td）切，块是翻译、进度与
 * 并发管理的最小单元；`pre`（代码块）刻意排除，两类任务都不改写代码内容。
 * 并发受控（默认 3，任务书 §3.4），完成一块就**立即应用到正文**并回报进度；
 * AbortSignal 贯穿块间隙与单个请求。单次输入上限由 UNagent 保证（超限抛错，
 * message 已 friendlyMessage 化）。
 *
 * 两条保结构通道（2026-09-29）：
 * - 翻译：含内联元素（链接/强调/图片…）的块走「分段标记」——逐个文字片段编号进
 *   prompt，AI 逐段译、逐段回，写回只改文本节点值，内联结构原样保留（旧的整体
 *   `textContent` 替换会把链接抹平成纯文本，用户报障）。纯文本块仍走整体替换。
 * - 排版：从「只改空白」升级为「跨块重组 + markdown 美化」——相邻纯文本 p 结成
 *   组（见 planTypographyUnits），AI 输出 markdown（重分段/标注小标题/列表），经
 *   renderTypographyMarkdown 落成 DOM 注入为原块组的**兄弟节点**、原块隐藏不删
 *   （切回原文 = 摘掉节点、解除隐藏，零高亮丢失）；逐字守卫升级为「去空白后全文
 *   逐字相等」，AI 改一个字整组拒绝。含内联元素的块与 li/td/标题留在逐块空白通道
 *   （applyTypographyWriteBack，保结构能力不变）。 */
import type { AiFunctionScope, UnagentAIApi } from "../types";

export interface AiTaskProgress {
	done: number
	total: number
	/** 已应用块按**原顺序**拼出的部分结果（完成一块长一块）。 */
	partial: string
}

/** 一个正文块（或排版组通道的一个「组单元」）：元素引用 + 提取时的原文。
 *  `textNodes`：排版逐块通道 + 翻译结构块的逐节点原文，供保结构写回/还原用。
 *  `structured` / `segments`：翻译保结构通道——块内有内联元素时，把可翻译的文字
 *  片段编号送出（见 applyTranslationWriteBack）。
 *  `chunkEls` / `chunkAiEl`：排版组通道——组单元持有组内全部原块元素与当前注入的
 *  AI 结果容器（见 applyTypographyChunkWriteBack / restoreTypographyChunk）。 */
export interface AiBlock {
	el: HTMLElement
	text: string
	textNodes?: { node: Text; value: string }[]
	structured?: boolean
	segments?: { node: Text; value: string }[]
	chunkEls?: HTMLElement[]
	chunkAiEl?: HTMLElement | null
}

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td";

/** 收集块内全部文本节点（按文档序）。跨 realm 安全：只走 childNodes/nodeType，
 *  绝不 instanceof（章节 iframe 是独立 realm，跨 realm 判定恒 false）。 */
function collectTextNodes(el: HTMLElement): { node: Text; value: string }[] {
	const out: { node: Text; value: string }[] = [];
	const walk = (parent: Node): void => {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === 3) out.push({ node: child as Text, value: child.nodeValue ?? "" });
			else if (child.nodeType === 1) walk(child);
		}
	};
	walk(el);
	return out;
}

/** 从渲染中的根元素提取正文块。嵌套块（blockquote > p、li > ul > li）只收最内层，
 *  避免同一段文字以父块形态重复出现；`pre` 内的块整体跳过（代码不改写）。
 *  `rawWhitespace`：保留原始空白（换行/连续空格原样进 prompt）——排版优化必须
 *  让 AI 看到真实断行才能修整它；翻译走默认的空白折叠（干净输入）。
 *  ⚠️ root 可能来自章节 iframe 的**独立 realm**（见 core/iframeDomCompat.ts）——
 *  元素判定必须用 nodeType，**绝不能用 `instanceof HTMLElement`**（跨 realm 恒 false，
 *  真机上全部块被跳过 = 「没有可提取的正文」）。 */
export function extractBlockElements(root: HTMLElement, opts?: { rawWhitespace?: boolean }): AiBlock[] {
	const blocks: AiBlock[] = [];
	const nodes = root.querySelectorAll(BLOCK_SELECTOR);
	for (const node of Array.from(nodes)) {
		if (node.nodeType !== 1) continue;
		const el = node as HTMLElement;
		if (el.closest("pre")) continue;
		if (el.querySelector(BLOCK_SELECTOR)) continue;
		const textNodes = collectTextNodes(el);
		const raw = textNodes.map(n => n.value).join("");
		if (opts?.rawWhitespace) {
			const text = raw.trim();
			if (text) blocks.push({ el, text, textNodes });
			continue;
		}
		const { structured, segments } = analyzeInlineStructure(el);
		const text = structured ? numberedSegmentText(segments) : raw.replace(/\s+/g, " ").trim();
		if (text) {
			blocks.push({
				el,
				text,
				textNodes: structured ? textNodes : undefined,
				structured,
				segments: structured ? segments : undefined,
			});
		}
	}
	return blocks;
}

/** 块的内联结构分析：有元素后代（链接/强调/图片…，`br` 不算）且存在可翻译文字片段
 *  → structured（走分段标记通道）；`code`/`kbd`/`samp` 内的文本节点不送译（代码保持
 *  原文），也不计入 structured 的判据。跨 realm 安全：只走 childNodes/nodeType/tagName。 */
function analyzeInlineStructure(el: HTMLElement): { structured: boolean; segments: { node: Text; value: string }[] } {
	const segments: { node: Text; value: string }[] = [];
	let hasElement = false;
	const walk = (parent: Node, inCode: boolean): void => {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === 3) {
				const value = child.nodeValue ?? "";
				if (!inCode && value.trim()) segments.push({ node: child as Text, value });
			} else if (child.nodeType === 1) {
				hasElement = true;
				walk(child, inCode || /^(code|kbd|samp)$/i.test((child as Element).tagName));
			}
		}
	};
	walk(el, false);
	return { structured: hasElement && segments.length > 0, segments };
}

/** 结构块的用户消息：每个文字片段一行「[n] 内容」，行内空白折叠（与旧的整体提取一致）。 */
function numberedSegmentText(segments: { value: string }[]): string {
	return segments.map((seg, i) => `[${i + 1}] ${seg.value.replace(/\s+/g, " ").trim()}`).join("\n");
}

/** 全文翻译：目标语言由面板设置（settings.ai.targetLanguage）。逐块翻译保住段落结构。
 *  官方默认提示词用 `{目标语言}` 占位（运行时替换），这样用户改提示词时仍能引用语言设置。 */
export const AI_LANGUAGE_TOKEN = "{目标语言}";

export function translateSystemPrompt(targetLanguage: string): string {
	return `你是专业的图书翻译引擎。把用户给出的内容翻译成${targetLanguage}，保持原文的段落结构与语气，专有名词保留原文。只输出译文：不要解释、不要前言结语、不要用引号包裹。`;
}

/** 排版优化基座提示词（v2，2026-09-29 用户要求「不仅要解决格式错乱，还要提供一定的
 *  格式美化，对不合理的布局要调整使其合理」）：从「只允许改空白」放宽为「允许跨块
 *  重组与结构标注」，但逐字保留全部非空白字符的铁律不变——这是内容不被 AI 改写的
 *  底线（2026-09-27 用户要求「尽可能保留原文」），两条通道的写回守卫都按它执行。
 *  序号/编号（「1.」「1、」）与链接文字是重灾区（阮一峰周刊类文章）：列表 marker
 *  由 CSS 绘制、不在文本里，AI 看不到编号就会自己补 → 写回后 marker+编号双重序号
 *  对不上；这里在基座里显式禁止，配合两条写回通道的守卫兜底。 */
export const TYPOGRAPHY_SYSTEM_PROMPT = [
	"你是图书排版引擎。只做排版整理，逐字保留全部文字内容：不得增、删、改任何非空白字符（文字/标点/数字/序号/链接文字一字不动），不得删除任何行，不改变语言。",
	"允许的操作只有：合并被硬换行或错误分段切断的同一句话与同一段落、删除多余空行与空格、在语义合理处重新分段。",
].join("\n");

/** 组通道（相邻纯文本 p 结成的块组）追加指令：AI 输出 markdown，由
 *  renderTypographyMarkdown 落成 DOM。只开这三类结构语法，其余一律禁止——
 *  每多开一类，逐字守卫的误拒绝面就宽一分。 */
export const TYPOGRAPHY_CHUNK_INSTRUCTION = [
	"本次输入是正文的连续片段（块与块之间以空行分隔，段内可能有硬换行）。输出整理后的 markdown：",
	"- 段落之间空一行，每个段落只占一行（段内不要再硬换行）；",
	"- 明显的小标题行（短、独立、概括后文）用 ##～###### 标注；",
	"- 本来就是并列短行的列表项可以用 - 列表；文字里已有的「1.」式序号保持原样，不要转成列表；",
	"- 不要使用表格/图片/链接/引用/代码块/分隔线，不要加粗，不要输出任何解释。",
].join("\n");

/** 逐块通道（li/td/标题/含内联元素的块）追加指令：写回是「只改空白」的逐字守卫
 *  （applyTypographyWriteBack），提示词必须与守卫能力严格一致，否则 AI 的输出
 *  全被拒绝。 */
export const TYPOGRAPHY_BLOCK_INSTRUCTION = [
	"本次按单个块整理：只修整该块内部的空白（硬换行/多余空格/空行），不要合并或拆分段落，不要输出任何 Markdown 语法。",
].join("\n");

/** 官方预设工具（固定两枚，用户不可增删；提示词/作用域可改、可重置回这里的默认值）。
 *  全文翻译的默认提示词带 `{目标语言}` 占位符，运行时替换为面板选择的语言。 */
export interface AiOfficialTool {
	id: "translate" | "typography"
	name: string
	icon: string
	description: string
	defaultPrompt: string
	defaultScope: AiFunctionScope
}

export const OFFICIAL_TOOLS: AiOfficialTool[] = [
	{
		id: "translate",
		name: "全文翻译",
		icon: "languages",
		description: "翻译当前文章/章节并替换正文",
		defaultPrompt: translateSystemPrompt(AI_LANGUAGE_TOKEN),
		defaultScope: "full",
	},
	{
		id: "typography",
		name: "排版优化",
		icon: "align-left",
		description: "重排断行断段、美化结构并替换正文",
		defaultPrompt: TYPOGRAPHY_SYSTEM_PROMPT,
		defaultScope: "full",
	},
];

/** 运行时把提示词里的 `{目标语言}` 占位替换为面板选择的语言（对官方与自定义工具一视同仁）。 */
export function applyLanguageToken(prompt: string, targetLanguage: string): string {
	return prompt.split(AI_LANGUAGE_TOKEN).join(targetLanguage);
}

const isWsChar = (ch: string | undefined): boolean => ch != null && /\s/.test(ch);

/** 结构块（含链接/强调等内联元素）的追加指令：逐段编号进、逐段编号出。
 *  只对 structured 块按请求追加（用户改过的官方提示词不受影响）。 */
export const SEGMENTED_TRANSLATION_INSTRUCTION = [
	"本次输入按 [编号] 分段：每行开头的 [n] 对应原文中一个连续的文字片段（可能位于链接、强调、代码或普通文字中）。",
	"逐段翻译、逐段输出：每行以相同的 [n] 开头，编号一一对应、顺序不变；不得合并、拆分或增删编号；无需翻译的片段（编号、公式、代码）原样输出。",
	"只输出「[n]译文」行：不要解释、不要用引号包裹、不要 Markdown 代码块。",
].join("\n");

/** 解析分段译文：行首标记（[n] / 【n】，容忍加粗与引用前缀）为主、全文扫描兜底。
 *  只接受从 1 开始逐个 +1 的编号——译文内容里偶然出现的 [2023] 之类不会被当成标记。
 *  返回 编号 → 译文；一个标记都没认出 → null（调用方决定回退/拒绝）。 */
function parseNumberedSegments(aiText: string, expected: number): Map<number, string> | null {
	let cleaned = aiText.trim();
	// 模型偶尔自带 ``` 围栏：剥掉首行 ```lang 与收尾 ```（内容里再出现围栏行的概率可忽略）
	if (cleaned.startsWith("```")) {
		const inner = cleaned.slice(3).replace(/^[\w-]*\n/, "");
		const endIndex = inner.lastIndexOf("```");
		if (endIndex >= 0) cleaned = inner.slice(0, endIndex).trim();
	}
	const lineRe = /^\s*(?:>\s*)?(?:\*\*)?\s*[[【]\s*(\d{1,4})\s*[\]】]\s*(?:\*\*)?\s*[:：、.]?\s*/;
	const map = new Map<number, string>();
	let expect = 1;
	let lastAccepted: number | null = null;
	for (const rawLine of cleaned.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			lastAccepted = null;
			continue;
		}
		const m = line.match(lineRe);
		if (m && Number(m[1]) === expect) {
			const text = line.slice(m[0].length).trim();
			if (text) map.set(expect, text);
			lastAccepted = expect;
			expect += 1;
			continue;
		}
		// 非标记行：续接上一段（模型把一段译文折行时内容不丢）；首段之前的散文行（前言）丢弃
		if (lastAccepted != null && map.has(lastAccepted)) map.set(lastAccepted, map.get(lastAccepted) + " " + line);
	}
	if (map.size) return map;
	// 兜底：标记不独行（如「[1]译文一[2]译文二」挤在一行）→ 全文扫描，同样只收递增序列
	const marks: { n: number; start: number; end: number }[] = [];
	for (const m of cleaned.matchAll(/[[【]\s*(\d{1,4})\s*[\]】]/g)) {
		marks.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
	}
	let next = 1;
	const accepted: { n: number; start: number; end: number }[] = [];
	for (const mark of marks) {
		if (mark.n === next && mark.n <= expected) {
			accepted.push(mark);
			next += 1;
		}
	}
	for (let k = 0; k < accepted.length; k++) {
		const end = k + 1 < accepted.length ? accepted[k + 1]!.start : cleaned.length;
		const text = cleaned.slice(accepted[k]!.end, end).trim();
		if (text) map.set(accepted[k]!.n, text);
	}
	return map.size ? map : null;
}

/** 结构块的分段写回：只改文本节点值，链接/强调/图片等内联元素原样保留。
 *  首尾空白跟随原节点（避免「see <a>x</a> now」译后粘连）；`code` 片段没送译、自然原样。
 *  某段没解析出 → 该段保留原文（其余照写）；整体没解析出且只有一个片段 → 整个输出
 *  视为该片段译文（单片段块不存在「分发失败」一说，标记失败也安全）。
 *  返回 false = 完全没写（调用方保留原块，块不参与版本切换）。 */
export function applyTranslationWriteBack(block: AiBlock, aiText: string): boolean {
	const segments = block.segments;
	if (!segments?.length) return false;
	const parsed = parseNumberedSegments(aiText, segments.length);
	if (!parsed) {
		if (segments.length !== 1) return false;
		const only = aiText.trim();
		if (!only) return false;
		writeTranslatedSegment(segments[0]!, only);
		return true;
	}
	let applied = 0;
	segments.forEach((seg, i) => {
		const translated = parsed.get(i + 1);
		if (!translated) return;
		writeTranslatedSegment(seg, translated);
		applied += 1;
	});
	return applied > 0;
}

function writeTranslatedSegment(seg: { node: Text; value: string }, translated: string): void {
	const lead = seg.value.match(/^\s*/)?.[0] ?? "";
	const trail = seg.value.match(/\s*$/)?.[0] ?? "";
	seg.node.nodeValue = lead + translated + trail;
}

/** 排版优化专用写回：把 AI 的**空白决策**映射回原文本节点序列，非空白字符一概取原文。
 *
 *  守卫（逐字核对）：原文非空白字符序列与 AI 输出必须完全一致（含顺序）——AI 一旦
 *  改字/补编号/重排，立即拒绝并返回 false，**调用方保留原块**（宁可不动也不二次编辑，
 *  2026-09-27 用户要求「尽可能保留原文」）。
 *
 *  通过守卫时的收益：按节点分发写回，块内的链接/代码/图片等**内联结构原样保留**
 *  （旧的 `el.textContent = 结果` 整体替换会把它们全部抹平）；列表 marker 是 CSS
 *  绘制、不在文本节点里，AI 想补的编号也会被守卫拦下 → 双重序号从机制上消失。 */
export function applyTypographyWriteBack(block: AiBlock, aiText: string): boolean {
	const nodes = block.textNodes;
	if (!nodes?.length) return false;
	const origFull = nodes.map(n => n.value).join("");
	const stripWs = (s: string): string => s.replace(/\s+/g, "");
	if (stripWs(origFull) !== stripWs(aiText)) return false;
	const skipWs = (s: string, from: number): number => {
		let e = from;
		while (e < s.length && isWsChar(s[e])) e++;
		return e;
	};
	let j = 0;
	const outs = nodes.map(() => [] as string[]);
	for (let k = 0; k < nodes.length; k++) {
		const value = nodes[k]!.value;
		for (let i = 0; i < value.length; i++) {
			const c = value[i]!;
			if (isWsChar(c)) {
				// 原空白 run：整段换成 AI 对应位置上的空白（可能为空 = AI 决定删除）
				let i2 = i;
				while (i2 < value.length && isWsChar(value[i2])) i2++;
				const j2 = skipWs(aiText, j);
				outs[k]!.push(aiText.slice(j, j2));
				j = j2;
				i = i2 - 1;
			} else {
				// 非空白字符：AI 加在它前面的空白照收，字符本身**必须逐字相等**，否则拒绝
				const j2 = skipWs(aiText, j);
				if (j2 >= aiText.length || aiText[j2] !== c) return false;
				outs[k]!.push(aiText.slice(j, j2));
				outs[k]!.push(c);
				j = j2 + 1;
			}
		}
	}
	// 尾部：AI 剩余必须全是空白（非空白早就该被逐字核对消费掉）
	const rest = aiText.slice(j);
	if (stripWs(rest) !== "") return false;
	if (outs.length) outs[outs.length - 1]!.push(rest);
	for (let k = 0; k < nodes.length; k++) nodes[k]!.node.nodeValue = outs[k]!.join("");
	return true;
}

/* ===================== 排版 v2：跨块重组 + markdown 美化（组通道） ===================== */

/** 组通道的字数预算与成员上限：组太大 → 一次请求的输出上限容易截断（截断 = 守卫
 *  必拒 = 整组白跑），组太小 → 跨块断段修复不了。1200 字 ≈ 中文 2-4 段。 */
const TYPO_CHUNK_CHAR_BUDGET = 1200;
const TYPO_CHUNK_MAX_BLOCKS = 8;
// 书页 frame 里没有插件的样式表（book 自带 CSS），隐藏原块只能走内联样式
// （engineAdapter 同款做法）；还原 = 摘属性，原块 DOM 一字不动。
const AI_HIDDEN_DISPLAY = "none";

/** 排版组规划：把逐块提取的结果重排成「组单元 + 落单块」两路。
 *  组单元（chunkEls）：**相邻兄弟**的纯文本 p（无任何非 br 元素后代、不在表格里）——
 *  只有它们能安全地「合并断段/重分段/标注小标题」；相邻性（nextElementSibling 链）
 *  保证组内没有 hr/figure 之类夹层，同父保证不会跨容器（引用/列表/表格）乱合并。
 *  其余块（含链接/强调/图片的 p、li、td、标题）留在逐块空白通道——它们要么有
 *  结构要保（v1 通道按节点分发空白，链接不丢），要么块型不适合重组。
 *  单个纯文本 p 也成组（单块组）：享有重分段与小标题标注能力，这正是「美化」的一部分。 */
export function planTypographyUnits(blocks: AiBlock[]): AiBlock[] {
	const units: AiBlock[] = [];
	let run: AiBlock[] = [];
	const flush = (): void => {
		if (run.length) units.push(chunkUnitOf(run));
		run = [];
	};
	for (const block of blocks) {
		if (!isChunkEligible(block)) {
			flush();
			units.push(block);
			continue;
		}
		const prev = run[run.length - 1];
		const adjacent = !!prev
			&& prev.el.parentElement === block.el.parentElement
			&& prev.el.nextElementSibling === block.el;
		const budget = run.reduce((n, b) => n + b.text.length, 0) + block.text.length;
		if (!prev || !adjacent || budget > TYPO_CHUNK_CHAR_BUDGET || run.length >= TYPO_CHUNK_MAX_BLOCKS) flush();
		run.push(block);
	}
	flush();
	return units;
}

function isChunkEligible(block: AiBlock): boolean {
	const el = block.el;
	if (!/^p$/i.test(el.tagName)) return false;
	if (el.closest("table")) return false;
	// 纯文本判据：块内除 <br> 外不许有任何元素后代——链接/强调/图片留在逐块通道保结构
	for (const child of Array.from(el.querySelectorAll("*"))) {
		if (!/^br$/i.test(child.tagName)) return false;
	}
	return true;
}

function chunkUnitOf(members: AiBlock[]): AiBlock {
	return {
		el: members[0]!.el,
		text: members.map(b => b.text).join("\n\n"),
		chunkEls: members.map(b => b.el),
		chunkAiEl: null,
	};
}

/** 组通道写回：AI 的 markdown → DOM（realm 安全，元素全部建在块所在的 frame 文档里）
 *  → 逐字守卫（去空白后与组原文逐字相等，AI 改一个字整组拒绝）→ 注入为原块的**兄弟
 *  节点** + 隐藏原块。隐藏而非删除：原块及其文本节点、落在其中的高亮 range 全部存活，
 *  「切回原文」= 摘掉注入节点 + 解除隐藏，零重锚、零丢失。 */
export function applyTypographyChunkWriteBack(unit: AiBlock, aiText: string): boolean {
	const els = unit.chunkEls;
	if (!els?.length || unit.chunkAiEl?.isConnected) return false;
	const anchor = els[0]!;
	const parent = anchor.parentElement;
	if (!parent) return false;
	const doc = anchor.ownerDocument;
	const rendered = renderTypographyMarkdown(aiText, doc);
	if (!rendered || !rendered.els.length) return false;
	const squeeze = (s: string): string => s.replace(/\s+/g, "");
	if (squeeze(rendered.text) !== squeeze(unit.text)) return false;
	const wrap = doc.createElement("div");
	wrap.className = "unreader-ai-typeset";
	for (const el of rendered.els) wrap.appendChild(el);
	parent.insertBefore(wrap, anchor);
	for (const el of els) el.style.display = AI_HIDDEN_DISPLAY;
	unit.chunkAiEl = wrap;
	return true;
}

/** 组通道还原（版本切换「原文」方向）：摘注入节点、解除隐藏。原块 DOM 从未被改写，
 *  还原是纯 DOM 增删，可无限次来回。 */
export function restoreTypographyChunk(unit: AiBlock): boolean {
	const els = unit.chunkEls;
	if (!els?.length) return false;
	unit.chunkAiEl?.remove();
	unit.chunkAiEl = null;
	for (const el of els) el.style.removeProperty("display");
	return true;
}

/** 排版 markdown → 块级元素。刻意只认组通道提示词里开的三类语法：
 *  - 标题 `#{1,6}`（`#` 与文字间空格可省，模型常省）；
 *  - 无序列表 `- `/`• `（`*` 不认——与加粗冲突）；文字里已有的「1.」式序号是内容，
 *  刻意不认有序列表语法（认了就会把序号吃掉 → 守卫必拒）；
 *  - 段落（连续非空行合并为一段：模型偶尔仍会折行，合并比拒绝温柔；CJK 直接拼接、
 *  西文按词补空格——拼接引入的只是空白，逐字守卫对空白不敏感）。
 *  行首 `>` 前缀剥掉（引用语境由原 DOM 结构保留，AI 多标的 > 不该害死整组）。
 *  行内只认 `` `code` `` 与 `**加粗**`。返回顶层元素与合成文本（守卫用）。 */
function renderTypographyMarkdown(markdown: string, doc: Document): { els: HTMLElement[]; text: string } | null {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const els: HTMLElement[] = [];
	let para: string[] = [];
	let list: string[] = [];
	const flushPara = (): void => {
		if (!para.length) return;
		const p = doc.createElement("p");
		fillTypographyInline(p, joinTypoLines(para), doc);
		els.push(p);
		para = [];
	};
	const flushList = (): void => {
		if (!list.length) return;
		const ul = doc.createElement("ul");
		for (const item of list) {
			const li = doc.createElement("li");
			fillTypographyInline(li, item, doc);
			ul.appendChild(li);
		}
		els.push(ul);
		list = [];
	};
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			flushPara();
			flushList();
			continue;
		}
		const heading = line.match(/^#{1,6}\s*(.+)$/);
		if (heading?.[1] && heading[1].trim()) {
			flushPara();
			flushList();
			const h = doc.createElement(`h${(heading[0].match(/^#+/) ?? ["#"])[0]!.length}`);
			fillTypographyInline(h, heading[1].trim(), doc);
			els.push(h);
			continue;
		}
		const item = line.match(/^[-•]\s+(.+)$/);
		if (item?.[1]) {
			flushPara();
			list.push(item[1].trim());
			continue;
		}
		flushList();
		para.push(line.replace(/^>+\s?/, ""));
	}
	flushPara();
	flushList();
	if (!els.length) return null;
	const text = els.map(el => el.textContent ?? "").join("\n");
	return { els, text };
}

function fillTypographyInline(el: HTMLElement, text: string, doc: Document): void {
	const pattern = /(`[^`]+`)|(\*\*[^*]+?\*\*)/g;
	let last = 0;
	for (const m of text.matchAll(pattern)) {
		const start = m.index ?? 0;
		if (start > last) el.appendChild(doc.createTextNode(text.slice(last, start)));
		if (m[1]) {
			const code = doc.createElement("code");
			code.textContent = m[1].slice(1, -1);
			el.appendChild(code);
		} else if (m[2]) {
			const strong = doc.createElement("strong");
			strong.textContent = m[2].slice(2, -2);
			el.appendChild(strong);
		}
		last = start + m[0].length;
	}
	if (last < text.length) el.appendChild(doc.createTextNode(text.slice(last)));
}

function joinTypoLines(lines: string[]): string {
	let out = "";
	for (const line of lines) {
		if (!out) {
			out = line;
			continue;
		}
		const needSpace = /[A-Za-z0-9,.;:!?'")\]]$/.test(out) && /^[A-Za-z0-9([:'"]/.test(line);
		out += (needSpace ? " " : "") + line;
	}
	return out;
}

/** 执行一个全文类任务：受控并发、完成一块立即写回正文元素、进度与部分结果回调。
 *  取消（signal）会让未开始/进行中的块抛 AbortError，由调用方按「用户放弃」静默收场
 *  （已写回的块保持替换后的内容 —— 已发生的替换不做回滚，重渲染即回原文）。
 *  `perUnitSystem`：按块定制 system prompt——翻译的结构块要追加「分段标记」指令、
 *  排版的组块/落单块各有一套与写回守卫能力严格一致的追加指令（见本文件两条通道）。 */
export async function runAiTaskOnBlocks(
	api: UnagentAIApi,
	blocks: AiBlock[],
	options: {
		system: string
		perUnitSystem?: (block: AiBlock) => string
		signal?: AbortSignal
		concurrency?: number
		onProgress?: (progress: AiTaskProgress) => void
		/** 排版优化等「只改空白」任务的自定义写回：返回 false = AI 结果被守卫拒绝，
		 *  调用方必须保留原块（不走默认的 textContent 整体替换）。 */
		writeBack?: (block: AiBlock, text: string) => boolean
	},
): Promise<string> {
	const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3));
	const results = new Array<string | null>(blocks.length).fill(null);
	let done = 0;
	let next = 0;
	const partial = (): string => results.filter((t): t is string => t != null).join("\n\n");

	const emit = (): void => {
		options.onProgress?.({ done, total: blocks.length, partial: partial() });
	};
	emit();

	const worker = async (): Promise<void> => {
		while (next < blocks.length) {
			if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const index = next++;
			const block = blocks[index]!;
			const result = await api.complete({
				system: options.perUnitSystem ? options.perUnitSystem(block) : options.system,
				user: block.text,
				signal: options.signal,
			});
			// 立即写回正文：用户在阅读视图里看着内容一段段被替换。
			// writeBack 全权接管落盘决策（含「拒绝 = 保留原文」）；无 writeBack 走整体替换。
			if (options.writeBack) options.writeBack(block, result.text);
			else block.el.textContent = result.text;
			results[index] = result.text;
			done += 1;
			emit();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, blocks.length) }, () => worker()));
	return partial();
}
