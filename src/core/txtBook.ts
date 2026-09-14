/**
 * TXT → foliate「合成 book」。
 *
 * 为什么走合成 book 而不是新造渲染通道：`vendor/foliate-js/fb2.js` 的 `makeFB2`
 * 已经给出先例 —— 返回一个鸭子类型的 book 对象（`sections[i] = { id:number,
 * load(): blobURL, createDocument(), size }` + `toc` + `resolveHref/splitTOCHref/
 * getTOCFragment`，**没有** `book.loadText/loadBlob`），`view.open()` 的三条鸭子判据
 * （字符串 / 有 `arrayBuffer` / `isDirectory`）都不命中 → 原样赋给 `view.book`。
 * MOBI 走的正是同一形状的路径，所以 engineAdapter 里「非 EPUB」的整套能力
 * （`sec.load()` 取章、fake CFI 基准、`epubcfi(/6/N!,/1:pct)` 进度）对 TXT 天然可用。
 *
 * 本模块**不依赖 Obsidian**，是纯函数 + DOM API；所有产物都不落盘。
 *
 * 三个硬约束（改动前先读）：
 *  ① `resolveHref` 必须是**同步**的。`resolveTocHrefToSection` / `rewriteAnchors` /
 *     `mergePartTitles` 全是同步调用链，KF8（AZW3）的 async `resolveHref` 正是
 *     「章节标题全为 null」的根因（见 engineAdapter.resolveMobiHrefSync 的注释）。
 *  ② section **绝不能带 `cfi` 字段**。`view.getCFI` 是 `sec.cfi ?? CFI.fake.fromIndex(i)`，
 *     一旦带上真 CFI，engineAdapter 建 `contBaseCfi` 的三处口径（fake.fromIndex /
 *     sectionIndexFromCfi 的 itemStep/2-1 / resolveCFI 的 fake.toIndex）就会分叉。
 *  ③ `toc` 必须**扁平**（不带 subitems）。带 subitems 的顶层目录项会被
 *     `mergePartTitles` 当成 EPUB 分部标题页，尝试合并并把该节标成 `linear="no"`
 *     —— 那条路径为 EPUB 的分部页几何设计，TXT 不引入。
 */

/** TOC 条目（与 engineAdapter 的 TocItem 同构；此处独立声明避免反向 import） */
interface TxtTocItem {
	label: string
	href: string
}

/** 合成 section：形状对齐 fb2.js 的 sectionData，engineAdapter 只读这四个字段 */
interface TxtSection {
	id: number
	size: number
	load: () => string
	createDocument: () => Document
}

export interface TxtBook {
	/** engineAdapter.detectFormat 据此把 bookFormat 判成 "txt"（id 是 number 无法区分 MOBI） */
	readonly __unreaderTxt: true
	metadata: { title: string; author: string; language: string }
	toc: TxtTocItem[]
	sections: TxtSection[]
	resolveHref: (href: string) => { index: number } | null
	splitTOCHref: (href: string) => [number, number]
	getTOCFragment: (doc: Document, id: string) => Element | null
	isExternal: (uri: string) => boolean
	destroy: () => void
}

/* ---------------- 可调常量 ---------------- */

/** 定长模式下每个目标节长（字）。仅用于「这本书没有任何章节标记」的情况。 */
const SEGMENT_CHARS = 6000
/** 单节硬上限：超过就在段落边界再切。中文网文单章 2000~4000 字，正常不触发；
 *  触发它的是「整本一个 txt、通篇没有换行」这类病态输入 —— 那样若合成单节，
 *  整本书会变成同一个 iframe，开书即卡死。 */
const MAX_SECTION_CHARS = 12000
/** heading 候选的最大长度（含「第xxx章 标题」这类） */
const HEADING_MAX_LEN = 40

/* ---------------- 编码判定 ---------------- */

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/

function detectBom(buf: Uint8Array): { encoding: string; skip: number } | null {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: "utf-8", skip: 3 }
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf-16le", skip: 2 }
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf-16be", skip: 2 }
	return null
}

/** 无 BOM 的 UTF-16 探测：前 4KB 里 NUL 集中在奇数位是 LE、偶数位是 BE。
 *  纯文本里出现 NUL 字节本身就几乎只可能是 UTF-16 的零高位。 */
function sniffUtf16(buf: Uint8Array): "utf-16le" | "utf-16be" | null {
	const n = Math.min(buf.length, 4096)
	if (n < 16) return null
	let odd = 0
	let even = 0
	for (let i = 0; i < n; i++) {
		if (buf[i] !== 0) continue
		if (i % 2 === 0) even++
		else odd++
	}
	const total = Math.floor(n / 2)
	if (odd > total * 0.3 && odd > even * 4) return "utf-16le"
	if (even > total * 0.3 && even > odd * 4) return "utf-16be"
	return null
}

/** 解码 + 换行归一。返回的 text 已剥掉 BOM、换行统一为 `\n`。
 *
 *  判定顺序是有意为之：BOM → UTF-16 嗅探 → UTF-8 **严格**解码 → GB18030 →
 *  windows-1252。中文 txt 的现实分布里 GBK/GB18030 占比很高（老式网文下载站、
 *  Windows 记事本另存），而 UTF-8 严格解码失败正是「这份字节不是合法 UTF-8」的
 *  强证据 —— 比按替换字符占比去猜更可靠。windows-1252 只作为最后一档兜底
 *  （Latin-1 英文文本会被 GB18030 解出满屏 U+FFFD，用它收敛）。 */
export function decodeTxt(buffer: ArrayBuffer): { text: string; encoding: string } {
	const bytes = new Uint8Array(buffer)
	const bom = detectBom(bytes)
	if (bom) {
		const body = bytes.subarray(bom.skip)
		try {
			const text = new TextDecoder(bom.encoding).decode(body)
			return { text: normalizeNewlines(text), encoding: bom.encoding }
		} catch { /* 落到下面的通用路径 */ }
	}
	const u16 = sniffUtf16(bytes)
	if (u16) {
		try {
			const text = new TextDecoder(u16).decode(bytes)
			return { text: normalizeNewlines(text), encoding: u16 }
		} catch { /* ignore */ }
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		return { text: normalizeNewlines(text), encoding: "utf-8" }
	} catch { /* 不是合法 UTF-8，继续试中文编码 */ }
	for (const enc of ["gb18030", "windows-1252"]) {
		try {
			const text = new TextDecoder(enc).decode(bytes)
			// 替换字符占比过高说明这个编码也不对，交给下一档
			const bad = (text.match(/�/g) ?? []).length
			if (text.length && bad / text.length > 0.001) continue
			return { text: normalizeNewlines(text), encoding: enc }
		} catch { /* 该编码在本环境不可用 */ }
	}
	// 全都不合适：退回非严格 UTF-8，至少不抛错（会出现替换字符）
	return { text: normalizeNewlines(new TextDecoder("utf-8").decode(bytes)), encoding: "utf-8?" }
}

function normalizeNewlines(s: string): string {
	// 用显式转义而不是字面量 BOM 字符：后者在源码里不可见、且会被不少工具/编辑器吃掉
	return s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
}

/* ---------------- 行归并（硬折行 → 段落） ---------------- */

/** 空白行判定：只含空白（含全角空格 U+3000） */
function isBlank(line: string): boolean {
	return !line.trim().replace(/　/g, "").trim()
}

/** 段落收尾标点 —— 用来区分「一行一段」与「硬折行」 */
const SENT_END = /[。！？…”』」》〉）)\]!?"'.　]$/

function median(nums: number[]): number {
	if (!nums.length) return 0
	const s = [...nums].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * 硬折行判定：块内多行、行长中位数 ≥ 40、多数行长度贴近中位数、且**多数行不以
 * 句末标点收尾**。
 *
 * 最后一条是关键判据：中文网文的「一行一段」格式里每行都是一段、必然以
 * `。！？` 收尾，而硬折行是在版面宽度处断开的、几乎从不落在句末。只按行长分布判
 * 会把「一行一段」误并成一大段（每段恰好等长时更容易中招）。
 *
 * **已知边界（有意不处理）**：按列硬切（`fold -w` 那类）会把词切断，拼回时按
 * 「两侧都是 ASCII 词字符则补空格」的规则会切出 `lazy d og` 这种。区分它与按词折行
 * 只能靠「行长是否恒等于列宽」，而行尾空白在不同来源里被规范化掉的程度不一，
 * 实测该信号不可靠（一条以空格开头的行经 trim 就与其余行等长，比例从 0.83 掉到 0.5）
 * —— 判错的代价是把整个块拼成一串没有空格的连体词，比多一个空格糟得多。
 * 列切在真实 txt（网文一行一段 / Gutenberg 按词折行）里是少数，故只保按词折行。
 */
function isHardWrapped(lines: string[]): boolean {
	if (lines.length < 3) return false
	const lens = lines.map(l => l.length).filter(n => n > 0)
	if (lens.length < 3) return false
	const med = median(lens)
	if (med < 40) return false
	const near = lens.filter(n => Math.abs(n - med) <= med * 0.2).length
	if (near / lens.length < 0.6) return false
	const endPunct = lines.filter(l => SENT_END.test(l)).length
	return endPunct / lines.length < 0.5
}

function isAsciiWordChar(ch: string | undefined): boolean {
	return !!ch && /[A-Za-z0-9]/.test(ch)
}

/** 把硬折行的多行拼成一段：断点在空格处（原空格已被 trim 掉），两侧都是 ASCII
 *  词字符时补回一个空格；行尾连字符按断词处理、去掉。中文折行不补空格。 */
function joinWrapped(lines: string[]): string {
	let out = ""
	for (const raw of lines) {
		const line = raw.trim()
		if (!line) continue
		if (!out) { out = line; continue }
		if (out.endsWith("-") && isAsciiWordChar(line[0])) out = out.slice(0, -1) + line
		else if (isAsciiWordChar(out[out.length - 1]) && isAsciiWordChar(line[0])) out += " " + line
		else out += line
	}
	return out
}

/* ---------------- 章节标记 ---------------- */

const HEAD_LEVEL0 = /^第\s*[0-9０-９〇零一二三四五六七八九十百千两]{1,12}\s*[卷部篇]/
const HEAD_LEVEL1 = /^第\s*[0-9０-９〇零一二三四五六七八九十百千两]{1,12}\s*[章节回]/
const HEAD_SPECIAL = /^(?:序章|序言|序|楔子|引子|前言|后记|尾声|终章|尾章|番外|外传|附录|作者的话|内容简介|简介)/
/** 英文标题**只认 chapter/part/book**：`Section 3 of the act says…` 这类句子在英文正文里
 *  太常见，收进来会让一本本来没有章节标记的英文书被误判成章节模式、切口全错。 */
const HEAD_LATIN = /^(?:chapter|part|book)\s+(?:[0-9]+|[ivxlcdm]+)\b/i

/** 句中标点：标题里几乎不出现，正文里随处可见 —— 用来压掉误判 */
const HEAD_EXCLUDE = /[，。；！？、]/

/** 判定一行是否为章节标题；返回层级（0=卷/部/篇，1=章/回/节/特殊篇名），非标题返回 -1。
 *
 *  调用方必须保证传入的是**块首行**（文件首行，或前一行为空行）—— 这条约束挡掉了
 *  正文里绝大多数「他翻到第三章的时候…」式的误判，比任何正则都有效。 */
export function headingLevel(line: string): number {
	const t = line.trim()
	if (!t || t.length > HEADING_MAX_LEN) return -1
	if (HEAD_EXCLUDE.test(t)) return -1
	if (HEAD_LEVEL0.test(t)) return 0
	if (HEAD_LEVEL1.test(t)) return 1
	if (HEAD_SPECIAL.test(t)) return 1
	if (HEAD_LATIN.test(t)) return 1
	return -1
}

/* ---------------- 块模型 ---------------- */

interface Block {
	/** 块内原始行（已 trim 右端）；块 = 连续的非空行 */
	lines: string[]
	/** 本块之前的空行数（≥1；文件首块为 0） */
	blankBefore: number
}

function toBlocks(lines: string[]): Block[] {
	const blocks: Block[] = []
	let blanks = 0
	let cur: string[] = []
	for (const line of lines) {
		if (isBlank(line)) {
			if (cur.length) { blocks.push({ lines: cur, blankBefore: blocks.length ? blanks : 0 }); cur = []; blanks = 0 }
			blanks++
			continue
		}
		cur.push(line.replace(/\s+$/, ""))
	}
	if (cur.length) blocks.push({ lines: cur, blankBefore: blocks.length ? blanks : 0 })
	return blocks
}

/* ---------------- 段落 → HTML ---------------- */

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** 段落两端的空白剥掉。中文 txt 常用全角空格 `　　` 做首行缩进，而缩进由主题 CSS 的
 *  `paragraphIndent` 统一给，不剥就会缩进翻倍。 */
function trimPara(s: string): string {
	return s.replace(/^[\s　]+/, "").replace(/[\s　]+$/, "")
}

const SECTION_STYLE =
	`p{margin:0}` +
	`.ur-txt-title{text-align:center}` +
	`.ur-txt-blank{text-indent:0 !important}`

function sectionHtml(title: string | null, paras: string[]): string {
	const body: string[] = []
	if (title) body.push(`<h2 class="ur-txt-title">${escapeHtml(title)}</h2>`)
	for (const p of paras) {
		if (p === "") body.push(`<p class="ur-txt-blank"><br></p>`)
		else body.push(`<p>${escapeHtml(p)}</p>`)
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SECTION_STYLE}</style></head>`
		+ `<body>${body.join("")}</body></html>`
}

/* ---------------- 段落收集 ---------------- */

/** 把一组块摊平成段落数组：硬折行块并成一段，其余每行一段；
 *  块间空行 ≥2 时插入一个空段占位（保留场景间隔；1 个空行是常规段距，
 *  由主题的段落间距表达，不重复占位）。 */
function blocksToParas(blocks: Block[]): string[] {
	const paras: string[] = []
	for (const b of blocks) {
		if (paras.length && b.blankBefore >= 2) paras.push("")
		const lines = b.lines.map(trimPara).filter(Boolean)
		if (!lines.length) continue
		if (isHardWrapped(lines)) {
			const joined = trimPara(joinWrapped(lines))
			if (joined) paras.push(joined)
		} else {
			paras.push(...lines)
		}
	}
	return paras
}

const PARA_SENT_SPLIT = /(?<=[。！？…”』」》〉])/

/** 单段超长（病态输入：整本一个 txt、通篇没有换行）时按句末标点切成若干段，
 *  切不动就按字数硬切 —— 目的是让单节字符数落在 MAX_SECTION_CHARS 以内。 */
function splitLongPara(text: string): string[] {
	if (text.length <= MAX_SECTION_CHARS) return [text]
	const out: string[] = []
	let buf = ""
	for (const piece of text.split(PARA_SENT_SPLIT)) {
		if (buf.length + piece.length > MAX_SECTION_CHARS && buf) { out.push(buf); buf = "" }
		if (piece.length > MAX_SECTION_CHARS) {
			if (buf) { out.push(buf); buf = "" }
			for (let i = 0; i < piece.length; i += MAX_SECTION_CHARS) out.push(piece.slice(i, i + MAX_SECTION_CHARS))
			continue
		}
		buf += piece
	}
	if (buf) out.push(buf)
	return out
}

/* ---------------- 节切分 ---------------- */

interface RawSection {
	title: string | null
	/** true = 标题已渲染成 <h2>（章节模式）；false = 标题只进目录（定长模式） */
	renderTitle: boolean
	paras: string[]
}

/** 按字数把段落数组切成若干节（段落边界处切，不切段） */
function chunkParas(paras: string[], target: number): string[][] {
	const out: string[][] = []
	let cur: string[] = []
	let size = 0
	for (const p of paras) {
		const pieces = p === "" ? [""] : splitLongPara(p)
		for (const piece of pieces) {
			if (cur.length && size + piece.length > target) { out.push(cur); cur = []; size = 0 }
			cur.push(piece)
			size += piece.length
		}
	}
	if (cur.length) out.push(cur)
	return out
}

function firstLineLabel(paras: string[]): string {
	for (const p of paras) {
		const t = p.trim()
		if (!t) continue
		return t.length > 24 ? t.slice(0, 24) + "…" : t
	}
	return ""
}

/** 章节模式：每个 heading 起一节，heading 之前的前言自成一节 */
function splitByHeadings(blocks: Block[], level: number, bookTitle: string): RawSection[] {
	const marks: { block: number; title: string; consumed: boolean }[] = []
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!
		const t = trimPara(b.lines[0] ?? "")
		if (headingLevel(t) === level) marks.push({ block: i, title: t, consumed: b.lines.length === 1 })
	}
	const out: RawSection[] = []
	// 前言：第一个 heading 之前的内容。标题用书名 —— 这段通常是书名页/简介/作者的话
	const head = blocks.slice(0, marks.length ? marks[0]!.block : blocks.length)
	const headParas = blocksToParas(head)
	if (headParas.length) out.push({ title: bookTitle, renderTitle: false, paras: headParas })
	for (let i = 0; i < marks.length; i++) {
		const m = marks[i]!
		const end = i + 1 < marks.length ? marks[i + 1]!.block : blocks.length
		const body = blocks.slice(m.block, end)
		// heading 独占一块时整块吃掉，否则只吃掉首行
		if (m.consumed) body[0] = { lines: [], blankBefore: 0 }
		else body[0] = { lines: [...body[0]!.lines.slice(1)], blankBefore: body[0]!.blankBefore }
		const paras = blocksToParas(body.filter(b => b.lines.length))
		// 空章（只有标题没有正文）保留标题即可，否则目录里会出现点不动的空条目
		out.push({ title: m.title, renderTitle: true, paras })
	}
	return out
}

/** 定长模式：无章节标记时按字数切。
 *  **每一节**的标题都取首行（不在正文里凭空造 h2）—— 包括第一节：它是普通正文，
 *  挂上书名会让目录里出现一个指向正文的「书名」条目。书名只在章节模式的**前言**
 *  一节上使用（那是真正的书名页/简介）。 */
function splitByLength(blocks: Block[]): RawSection[] {
	const paras = blocksToParas(blocks)
	const chunks = chunkParas(paras, SEGMENT_CHARS)
	return chunks.map(c => ({
		title: firstLineLabel(c),
		renderTitle: false,
		paras: c,
	}))
}

/* ---------------- 元数据 ---------------- */

/** 文件名 → { 书名, 作者 }。只做两条最稳的规则：`《书名》…` 与 `书名 - 作者`
 *  （或下划线分隔，尾部 ≤12 字才当作者）。更激进的切分（如按 `-` 无条件劈开）
 *  会把《The Lost World-A Novel》这类英文书名切错。 */
export function titleFromFileName(name: string): { title: string; author: string } {
	const base = name.replace(/\.[^.]+$/, "").trim()
	const guillemet = /^《(.+?)》\s*(.*)$/.exec(base)
	if (guillemet) return { title: guillemet[1]!.trim(), author: guillemet[2]!.trim() }
	const sep = /^(.+?)\s*[-—_]\s*(\S{1,12})$/.exec(base)
	if (sep) {
		const tail = sep[2]!.trim()
		// 尾部含书名标点/空白不像作者名，宁可不拆
		if (!/[，。；：！？《》]/.test(tail)) return { title: sep[1]!.trim(), author: tail }
	}
	return { title: base, author: "" }
}

const META_TITLE = /^(?:书名|标题|作品名)\s*[：:]\s*(.+)$/
const META_AUTHOR = /^(?:作者|著者|作\s*者)\s*[：:]\s*(.+)$/

/** 从正文头部若干行里找「书名：」「作者：」覆盖文件名推断（有则优先）。
 *  只看前 40 个非空行/前 2000 字，避免正文里偶然出现的同形字符串改掉书名。 */
function metaFromBody(text: string, fallback: { title: string; author: string }): { title: string; author: string } {
	let title = fallback.title
	let author = fallback.author
	let seen = 0
	for (const raw of text.split("\n", 60)) {
		const line = trimPara(raw)
		if (!line) continue
		if (++seen > 40 || line.length > 200) break
		const t = META_TITLE.exec(line)
		if (t) { title = t[1]!.trim() || title; continue }
		const a = META_AUTHOR.exec(line)
		if (a) author = a[1]!.trim() || author
	}
	return { title, author }
}

function guessLanguage(text: string): string {
	const sample = text.slice(0, 20000)
	if (!sample) return "zh"
	let cjk = 0
	for (const ch of sample) if (CJK_RE.test(ch)) cjk++
	return cjk / sample.length > 0.05 ? "zh" : "en"
}

/* ---------------- 主入口 ---------------- */

export function isTxtFile(file: File): boolean {
	return /\.txt$/i.test(file.name || "")
}

/**
 * 把 TXT 的 File 变成 foliate 可用的合成 book。
 *
 * @param file 源自 vault 的文件（`bookService.readBookFile` 产出，name 带 .txt）
 */
export async function makeTxtBook(file: File): Promise<TxtBook> {
	const buffer = await file.arrayBuffer()
	if (!buffer.byteLength) throw new Error("TXT 文件为空")
	const { text } = decodeTxt(buffer)
	if (!text.trim()) throw new Error("TXT 文件没有可读文本")

	const meta = metaFromBody(text, titleFromFileName(file.name || "未命名"))

	const blocks = toBlocks(text.split("\n"))
	// 章节标记统计 → 决定用哪套切分策略。
	// level 1（章/回/节）优先；一本只有「卷」没有「章」的书退到 level 0；两者都没有
	// 才用定长切分。阈值 3 是为了挡掉「正文里偶然出现一两处『第一章』」的误判。
	let lvl1 = 0
	let lvl0 = 0
	for (const b of blocks) {
		const t = trimPara(b.lines[0] ?? "")
		if (t.length > HEADING_MAX_LEN) continue
		const lv = headingLevel(t)
		if (lv === 1) lvl1++
		else if (lv === 0) lvl0++
	}

	let raw: RawSection[]
	if (lvl1 >= 3) raw = splitByHeadings(blocks, 1, meta.title)
	else if (lvl0 >= 3) raw = splitByHeadings(blocks, 0, meta.title)
	else raw = splitByLength(blocks)

	// 空节丢弃（全空白输入、或前言恰好为空）
	const kept = raw.filter(s => s.paras.some(p => p.trim() !== ""))
	if (!kept.length) throw new Error("TXT 文件没有可读文本")

	// 安全阀：单节超限时在段落边界再切（见 MAX_SECTION_CHARS 的注释）。
	// 续节不再带标题、也**不建目录条目** —— 目录条目由 contBaseCfi/tocIdBySection 按
	// 「最近前驱目录条目」归到同一个章名下，与 MOBI 分节的行为一致。
	const final: RawSection[] = []
	for (const s of kept) {
		const chunks = chunkParas(s.paras, MAX_SECTION_CHARS)
		if (chunks.length <= 1) { final.push(s); continue }
		final.push({ title: s.title, renderTitle: s.renderTitle, paras: chunks[0]! })
		for (let i = 1; i < chunks.length; i++) final.push({ title: null, renderTitle: false, paras: chunks[i]! })
	}

	const urls: string[] = []
	const sections: TxtSection[] = final.map((s, i) => {
		const html = sectionHtml(s.renderTitle ? s.title : null, s.paras)
		const size = s.paras.reduce((n, p) => n + p.length, 0) || 1
		let url: string | null = null
		const urlOf = (): string => {
			if (!url) { url = URL.createObjectURL(new Blob([html], { type: "text/html" })); urls.push(url) }
			return url
		}
		return {
			id: i,
			size,
			// 与 fb2.js 一致：同步返回 blob URL（engineAdapter 用 `await` 接收，
			// 对字符串同样成立；这里**不要**改成 async —— 见文件头的同步约束）
			load: urlOf,
			createDocument: () => new DOMParser().parseFromString(html, "text/html"),
		}
	})

	// 目录：只给**带标题的节**建条目（安全阀切出来的续节不建，见上）
	const toc: TxtTocItem[] = []
	for (let i = 0; i < final.length; i++) {
		const s = final[i]!
		if (s.title) toc.push({ label: s.title, href: String(i) })
	}

	const resolveHref = (href: string): { index: number } | null => {
		const a = href.split("#")[0] ?? ""
		const n = Number(a)
		if (!Number.isInteger(n) || n < 0 || n >= sections.length) return null
		return { index: n }
	}

	return {
		__unreaderTxt: true,
		metadata: {
			title: meta.title || file.name || "未命名",
			author: meta.author,
			language: guessLanguage(text),
		},
		toc,
		sections,
		resolveHref,
		splitTOCHref: (href: string) => {
			const [a, b] = href.split("#")
			return [Number(a), b == null ? 0 : Number(b)]
		},
		getTOCFragment: (doc: Document, id: string) => doc.getElementById(String(id)),
		isExternal: (uri: string) => /^\w+:/i.test(uri),
		destroy: () => {
			for (const u of urls) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
			urls.length = 0
		},
	}
}
