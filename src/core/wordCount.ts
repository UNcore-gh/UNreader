/** 笔记「字数」统计（Markdown 笔记卡片底栏用，替代原先的二态进度环 —— 用户 2026-10-13：
 *  「markdown 格式不需要阅读进度环，然后把字数放在进度环的位置」）。
 *
 *  口径（用户 2026-10-13 选定）：**中文字符按 1 字、英文按单词计**。
 *  · 中日韩表意文字 / 假名 / 韩文音节：一个字算一个（`你好` = 2 字）；
 *  · 其余语言的连续字母数字串算一个词（`hello world` = 2、`don't` = 1）。
 *  标点、空白、Markdown 记号都不计入 —— 它们不是「字」。
 *
 *  纯函数、无 IO：读盘在调用方（`main.countMarkdownNoteWords`），这样口径可以单独被
 *  探针钉住，也不会把 vault 依赖引进渲染层。 */

/** CJK 统一表意文字（含扩展 A / 兼容区）、假名、韩文音节 —— 逐字计数的那一批。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
/** 拉丁 / 西里尔 / 阿拉伯等「词」形态：允许词内撇号与连字符（`don't`、`state-of-art`）。 */
const WORD = /[A-Za-z0-9\u00c0-\u024f\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]+(?:['’-][A-Za-z0-9\u00c0-\u024f\u0400-\u04ff]+)*/g;

/** 文件开头的 YAML frontmatter 块（`---` 起、`---` 或 `...` 止）要排除：
 *  它属于元数据（标签 / 别名 / 位置），算进「字数」会让每篇笔记凭空多出几十字。 */
const FRONTMATTER = /^\ufeff?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Markdown 里不会出现在正文中的围栏代码块？**不排除** —— 代码也是这篇笔记的内容，
 *  用户看字数时不会想把代码段扣掉（这与「排除 frontmatter」不同：那是元数据，不是内容）。 */
export function countWords(text: string): number {
	if (!text) return 0;
	const body = text.replace(FRONTMATTER, "");
	const cjk = body.match(CJK)?.length ?? 0;
	const latin = body.match(WORD)?.length ?? 0;
	return cjk + latin;
}

/** 卡片底栏上的显示形态：短数字直接给、上万折成「万字」保持一行放得下。
 *  （底栏最左原本是 18px 的进度环，现在换成文字，宽度得自己收着点。） */
export function formatWordCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0 字";
	if (count >= 10000) {
		const wan = count / 10000;
		return `${wan >= 100 ? Math.round(wan) : Number(wan.toFixed(1))} 万字`;
	}
	return `${Math.round(count)} 字`;
}
