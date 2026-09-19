/**
 * HTML → foliate「合成 book」。
 *
 * 与 TXT（`txtBook.ts`）共用一条通道：返回一个鸭子类型的 book 对象
 * （`sections[i] = { id:number, load(): blobURL, createDocument(), size }` + 扁平 `toc`），
 * `view.open()` 的三条鸭子判据（字符串 / 有 `arrayBuffer` / `isDirectory`）一条都不命中
 * → 原样赋给 `view.book`，不走 makeBook。于是 engineAdapter 里「非 EPUB」的整套能力
 * （连续滚动、fake CFI 基准、`epubcfi(/6/N!,/1:pct)` 进度、标注、目录、章节轨）对 HTML
 * **零改动**继承 —— 判据写法一律是 `!== "epub"`（见 engineAdapter.bookFormat 的注释）。
 *
 * `__unreaderTxt` 是 detectFormat 分流的**唯一**标记，语义是「我们造的合成书」而非
 * 「这个文件是 txt」（feed 文章同样打着它，见 feedBookFactory.ts）—— 这里照打。
 *
 * ## 三条硬约束（与 txtBook 完全一致，改动前先读那边的文件头）
 *  ① `resolveHref` 必须**同步**；② section 绝不能带 `cfi` 字段（会与 fake CFI 基准分叉）；
 *  ③ `toc` 必须**扁平**（带 subitems 会被 mergePartTitles 当成 EPUB 分部标题页）。
 *
 * ## 净化是红线，不是可选项
 * 章节 iframe 用 `srcdoc` 注入、与本插件**同源**，且**没有 `sandbox` 属性**，Obsidian 的
 * CSP 也不限制 `script-src`（见 engineAdapter.renderSection 的注释）。也就是说文件里一段
 * `<script>` 就等于在 vault 里以完整同源权限执行任意代码 —— 本地 HTML 往往来自「别人给的
 * 文件」或「网页剪藏」，这是**不可信输入**。所以进 body 的每个节点都要过两步：先按元素/
 * 属性白名单手工摘（脚本、事件处理器、表单、iframe…），再由 DOMPurify 收尾
 * （与 feed 文章同一条净化链，见 articleExtractor.ts）。
 *
 * ## 作者 CSS 一律丢弃（刻意，不是偷懒）
 * `<style>` / `<link rel=stylesheet>` / 内联 `style` 全部摘掉，只保留语义结构（标题、段落、
 * 列表、表格、图片、锚点）。理由按重要性排序：
 *  ① **安全**：样式表是 `url()`、`@import`、旧式 `expression()` 的载体，留着等于开一条
 *     我们控制不了的取图/取字链路；
 *  ② **外观系统**：字号/行距/字体/主题是本插件的产品核心，而作者 CSS 的选择器特异性普遍
 *     高于阅读器的元素选择器（`injectFrameCss` 后插入只赢平局）→ 保留它等于「打开某些
 *     文件时外观设置部分失灵」，深浅色覆盖也会被作者硬编码颜色顶掉；
 *  ③ **一致性**：feed 文章走的正是这条路（`sanitizeArticleHtml` 同样不留 style/link）。
 *  代价是版式类信息（浮动、分栏、居中、缩进）丢失，正文按阅读器自己的版心重排 —— 这是
 *  「阅读」而不是「复刻网页」。语义标签全留，所以 `<pre>`、表格、图注仍然可读
 *  （必要的语义基线由 section 自带的 `HTML_BASE_CSS` 兜住，见下）。
 *
 * ## 相对资源必须在这里改写掉
 * 章节是 srcdoc（`about:srcdoc`）→ **没有 base URL**，`<img src="assets/a.png">` 直接裂图；
 * 而 EPUB/MOBI 那套资源改写（foliate 的 zip loader / `rewriteResourcesLocal`）对本模块不
 * 适用（`book.loadBlob` 不存在，那道闸门一进就 early return）。故资源解析由调用方注入
 * （`HtmlBookOptions.resolveResource`），**在合成阶段就把 URL 烧进 HTML**。解析不到的资源
 * 按 feed 的做法直接摘掉（留个裂图占位不如不显示）。
 *
 * 本模块**不依赖 Obsidian**（与 txtBook 一致）：vault 侧的解析器由调用方注入
 * （见 `bookService.createVaultResourceResolver`），所以这里全套是纯函数 + DOM API。
 */
import DOMPurify from "dompurify";
import { decodeTxt, titleFromFileName } from "./txtBook";

/* ---------------- 对外契约 ---------------- */

/** 目录条目（与 txtBook 同构；独立声明避免反向 import） */
interface HtmlTocItem {
	label: string
	href: string
}

/** 合成 section：形状对齐 fb2.js 的 sectionData，engineAdapter 只读这四个字段 */
interface HtmlSection {
	id: number
	size: number
	load: () => string
	createDocument: () => Document
}

export interface HtmlBook {
	/** 见文件头：这是「合成书」标记，不是「这个文件是 txt」 */
	readonly __unreaderTxt: true
	metadata: { title: string; author: string; language: string }
	toc: HtmlTocItem[]
	sections: HtmlSection[]
	resolveHref: (href: string) => { index: number } | null
	splitTOCHref: (href: string) => [number, number]
	getTOCFragment: (doc: Document, id: string) => Element | null
	isExternal: (uri: string) => boolean
	destroy: () => void
}

export interface HtmlBookOptions {
	/** 把文档里的**相对**路径解析成可用 URL（vault 侧实现）。
	 *  返回 null / 不注入 = 解析不到 → 该资源会被摘掉。 */
	resolveResource?: (raw: string) => string | null
}

export interface HtmlPreview {
	title: string
	author: string
	excerpt: string | null
}

/* ---------------- 可调常量 ---------------- */

/** 单节硬上限（字）：超过就在块边界再切。与 txtBook 同因 —— 每节一个 iframe，
 *  整本书塞进一个 iframe 会在开书时卡死主线程（详见 txtBook.MAX_SECTION_CHARS）。 */
const MAX_SECTION_CHARS = 12000

/** 参与切章的标题级别。h1/h2 当「章」；h3+ 太碎，只作块内结构（与 txtBook 的
 *  「章/回/节」一级口径对齐，否则一篇带 30 个小标题的文章会被切成 30 个假章节）。 */
const SECTION_HEADINGS = new Set(["H1", "H2"])

/** `contentRoot` 允许下钻的容器标签与最大层数。
 *  网页剪藏/导出工具的主流形态是 `<body><div id="content">…全部正文…</div></body>`；
 *  不下钻就永远找不到顶层标题 → 切不出章节、目录全空、整篇塞进一个 iframe。 */
const WRAPPER_TAGS = new Set(["DIV", "MAIN", "ARTICLE", "SECTION"])
const WRAPPER_MAX_DEPTH = 4

/** 惰性图片的真图属性（网页剪藏里非常常见，`src` 往往只是 1px 占位）。 */
const LAZY_SRC_ATTRS = ["data-src", "data-original", "data-lazy-src"]

/** 整棵摘掉的元素：可执行 / 可联网 / 与正文无关。
 *  `<svg>` 与 `<math>` 也在列 —— 保它们要把整套 SVG 标签与属性白名单搬进来，
 *  而阅读场景里 SVG 绝大多数是图标（真图是 `<img>`），收益不抵风险面。 */
const DROP_SELECTOR = [
	"script", "style", "link", "meta", "base", "title", "noscript", "template",
	"iframe", "frame", "frameset", "object", "embed", "applet",
	"form", "input", "button", "select", "option", "optgroup", "textarea",
	"canvas", "dialog", "slot", "svg", "math",
].join(",")

/** DOMPurify 收尾白名单：比 feed 那套宽一档（多了 figure/details/表格语义），
 *  但**不含** style/link/script/iframe —— 白名单是最后一道，收窄永远比放宽安全。 */
const ALLOWED_TAGS = [
	"article", "section", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6",
	"ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "code", "kbd", "samp", "var",
	"hr", "br", "figure", "figcaption", "picture",
	"img", "audio", "video", "source",
	"table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
	"strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "span",
	"a", "details", "summary", "abbr", "cite", "q", "time", "address", "aside", "footer", "header", "main", "nav",
]

/** 属性白名单：保留 `id`（页内锚点跳转要用）与 `class`（无 CSS 时无害，且便于将来
 *  接入作者样式）；`style` **不在列**（见文件头「作者 CSS 一律丢弃」）。 */
const ALLOWED_ATTR = [
	"id", "class", "href", "src", "alt", "title", "width", "height", "colspan", "rowspan",
	"datetime", "cite", "controls", "preload", "poster", "type", "loading", "decoding",
	"referrerpolicy", "start", "reversed", "value", "span", "open", "lang", "dir", "role",
]

/**
 * URI 白名单：DOMPurify 默认只认 `http(s)/mailto/tel/callto/sms/cid/xmpp` 与相对路径，
 * **`app://` 会被当作非法协议直接把属性摘掉** —— 而「相对资源 → vault 资源 URL」这条
 * 链路改写出来的正是 `app://local/…`（桌面）与 `capacitor://localhost/…`（移动端），
 * 于是「改写成功但属性被净化掉」＝ 图片全部裂图（探针 H3 抓到过的真实故障）。
 * 这里在默认白名单基础上只放行这两个 Obsidian 自己的资源协议。
 * **刻意不放 `file:`**：桌面端 `file://` 能读本地磁盘，没有放行它的理由。
 */
const ALLOWED_URI_REGEXP =
	/^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|data|blob|app|capacitor):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

/** 章节自带的语义基线：只补「阅读器主题没覆盖、而丢掉作者 CSS 后浏览器默认样式又难看」
 *  的那几处。主题 CSS（contFrameCss）用 `!important` 管字体/字号/行距/颜色/段距，
 *  永远盖在本表之上；这里只碰它没表态的元素。 */
const HTML_BASE_CSS = `
pre{white-space:pre-wrap;overflow-wrap:anywhere}
code,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
pre code{font-size:1em}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
th,td{padding:.32em .62em;border:1px solid color-mix(in srgb,currentColor 22%,transparent);text-indent:0!important}
caption{caption-side:top;font-size:.9em;opacity:.75;padding:.3em 0}
figure{margin:1.2em 0}
figcaption{font-size:.86em;opacity:.72;text-indent:0!important}
hr{border:0;border-top:1px solid color-mix(in srgb,currentColor 20%,transparent);margin:1.6em 0}
blockquote{margin:1em 0;padding:.15em 0 .15em 1em;border-left:3px solid color-mix(in srgb,currentColor 24%,transparent);opacity:.92}
ul,ol{padding-inline-start:1.5em}
dd{margin-inline-start:1.5em}
details{margin:1em 0}
summary{cursor:default;font-weight:600}
audio,video{max-width:100%}
`;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const EXCERPT_CHARS = 160
const TITLE_MAX_CHARS = 80

/* ---------------- 小工具 ---------------- */

/** 折叠空白并 trim（HTML 里的换行/缩进不是内容） */
function pick(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim()
}

function elementOf(node: Node | null): Element | null {
	return node && node.nodeType === Node.ELEMENT_NODE ? node as Element : null
}

/** 相对/绝对/内联资源 → 可直接写进 src 的 URL；解析不到返回 null。 */
function resolveUrl(raw: string | null, resolveResource?: (raw: string) => string | null): string | null {
	const value = (raw ?? "").trim()
	if (!value) return null
	if (/^(?:data:|blob:)/i.test(value)) return value
	if (/^https?:/i.test(value)) return value
	if (value.startsWith("//")) return `https:${value}`
	// 其余一律当相对路径：只有上层注入了 vault 解析器才可能成功（见文件头）
	return resolveResource ? resolveResource(value) : null
}

function guessLanguage(text: string): string {
	const sample = text.slice(0, 20000)
	if (!sample) return "zh"
	let cjk = 0
	for (const ch of sample) if (CJK_RE.test(ch)) cjk++
	return cjk / sample.length > 0.05 ? "zh" : "en"
}

/* ---------------- 解析 + 净化 ---------------- */

interface ParsedDocument {
	doc: Document
	title: string
	author: string
}

/**
 * 读字节 → 解析成 Document → 抽出元数据。
 *
 * 编码走 `decodeTxt` 那套（BOM → UTF-16 嗅探 → 严格 UTF-8 → GB18030 → windows-1252）：
 * 中文 HTML 里 GBK/GB18030 存量不小，而 `<meta charset>` 常年与实际字节不符、
 * **且在「先解码成字符串再 DOMParser」这条路上根本不起作用**（DOMParser 拿到的是已经
 * 解码好的字符串），所以只能靠字节嗅探。
 *
 * 元数据必须在净化**之前**读：净化会摘掉 `<title>`/`<meta>`。
 */
function parseDocument(buffer: ArrayBuffer, fallbackName: string): ParsedDocument {
	const { text } = decodeTxt(buffer)
	const doc = new DOMParser().parseFromString(text, "text/html")
	const fromName = titleFromFileName(fallbackName)
	const title = pick(doc.querySelector("title")?.textContent)
		|| pick(doc.querySelector('meta[property="og:title"]')?.getAttribute("content"))
		|| pick(doc.querySelector("h1")?.textContent)
		|| fromName.title
	const author = pick(doc.querySelector('meta[name="author"]')?.getAttribute("content"))
		|| pick(doc.querySelector('meta[property="article:author"]')?.getAttribute("content"))
		|| pick(doc.querySelector('[rel="author"]')?.textContent)
		|| fromName.author
	return { doc, title: title.slice(0, TITLE_MAX_CHARS), author: author.slice(0, TITLE_MAX_CHARS) }
}

/**
 * 就地净化 + 资源改写。两步都必须在切章**之前**做完：
 *  - 净化后 DOM 里不再有 `on*` 属性/脚本，后续任何序列化都不可能带出去；
 *  - 资源 URL 要烧进 HTML 文本（srcdoc 没有 base URL，见文件头）。
 */
function cleanDocument(doc: Document, resolveResource?: (raw: string) => string | null): void {
	const body = doc.body
	if (!body) return

	// ① 整棵摘掉危险/无关元素
	for (const el of Array.from(doc.querySelectorAll(DROP_SELECTOR))) el.remove()

	// ② 属性：`on*` 是「留下的标签」重新变成可执行代码的唯一通道，style 见文件头
	for (const el of Array.from(body.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase()
			if (name.startsWith("on") || name === "style" || name === "srcdoc" || name === "formaction") {
				el.removeAttribute(attr.name)
			}
		}
	}

	// ③ 图片：src / 惰性属性 里取第一个能解析的；一个都解析不到就摘掉整个 <img>。
	//    `srcset`/`sizes` 一律去掉 —— 候选列表里全是原始相对路径，留着就是裂图源。
	for (const img of Array.from(doc.querySelectorAll("img"))) {
		let url: string | null = null
		for (const raw of [img.getAttribute("src"), ...LAZY_SRC_ATTRS.map(a => img.getAttribute(a))]) {
			url = resolveUrl(raw, resolveResource)
			if (url) break
		}
		if (!url) { img.remove(); continue }
		img.setAttribute("src", url)
		img.removeAttribute("srcset")
		img.removeAttribute("sizes")
		for (const lazy of LAZY_SRC_ATTRS) img.removeAttribute(lazy)
		img.setAttribute("loading", "lazy")
		img.setAttribute("decoding", "async")
		img.setAttribute("referrerpolicy", "no-referrer")
	}

	// ④ <picture><source srcset=…></picture>：source 只有 srcset（上一步已被丢），
	//    留着是死节点；<img> 兜底节点还在，摘掉 source 不影响显示。
	//    <video>/<audio> 的 <source src> 则要按媒体处理。
	for (const source of Array.from(doc.querySelectorAll("source"))) {
		const parent = source.parentElement
		if (parent && parent.tagName === "PICTURE") { source.remove(); continue }
		const url = resolveUrl(source.getAttribute("src"), resolveResource)
		if (!url) { source.remove(); continue }
		source.setAttribute("src", url)
		source.removeAttribute("srcset")
	}

	// ⑤ 媒体：直接挂在 video/audio 上的 src / poster
	for (const media of Array.from(doc.querySelectorAll("video[src], audio[src]"))) {
		const url = resolveUrl(media.getAttribute("src"), resolveResource)
		if (url) media.setAttribute("src", url)
		else media.removeAttribute("src")
		media.setAttribute("preload", "none")
	}
	for (const video of Array.from(doc.querySelectorAll("video[poster]"))) {
		const url = resolveUrl(video.getAttribute("poster"), resolveResource)
		if (url) video.setAttribute("poster", url)
		else video.removeAttribute("poster")
	}
	// 既没有 src 也没有可播放子源的播放器：空壳，摘掉（否则正文里一块空白控件）
	for (const media of Array.from(doc.querySelectorAll("video, audio"))) {
		if (media.getAttribute("src")) continue
		if (media.querySelector("source[src]")) continue
		media.remove()
	}

	// ⑥ 链接：只留「页内锚点 + http(s) + mailto/tel」。
	//    库内相对链接（别的 .md/.html/图片）没有通路 —— 点下去只会把章节 iframe 导航走
	//    （srcdoc 无 sandbox，导航真实发生，且没有返回入口），所以摘掉 href 留文字。
	for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
		const raw = (anchor.getAttribute("href") ?? "").trim()
		if (!raw) { anchor.removeAttribute("href"); continue }
		if (raw.startsWith("#")) continue
		if (/^(?:https?:|mailto:|tel:)/i.test(raw)) {
			anchor.setAttribute("rel", "noopener noreferrer")
			continue
		}
		anchor.removeAttribute("href")
	}
}

/* ---------------- 切章 ---------------- */

interface RawSection {
	blocks: Element[]
	title: string | null
}

/** 正文根：body 只有「单个容器子元素且无游离文本」时逐层下钻（见 WRAPPER_TAGS 注释）。 */
function contentRoot(body: HTMLElement): HTMLElement {
	let cur: HTMLElement = body
	for (let depth = 0; depth < WRAPPER_MAX_DEPTH; depth++) {
		const kids = Array.from(cur.children)
		const only = kids.length === 1 ? kids[0] : undefined
		if (!only || !WRAPPER_TAGS.has(only.tagName)) break
		const strayText = Array.from(cur.childNodes).some(
			n => n.nodeType === Node.TEXT_NODE && pick(n.nodeValue) !== "",
		)
		if (strayText) break
		cur = only as HTMLElement
	}
	return cur
}

function blockChars(el: Element): number {
	return (el.textContent ?? "").length || 1
}

function titleOfBlocks(blocks: Element[]): string | null {
	const first = blocks[0]
	if (!first || !SECTION_HEADINGS.has(first.tagName)) return null
	const label = pick(first.textContent).slice(0, TITLE_MAX_CHARS)
	return label || null
}

/** 按块预算贪心分组：单块超限时它独占一节（与 txtBook 的安全阀同口径 —— 宁可一节
 *  超限，也不把块切开，切开会在块中间制造假的分节边界）。 */
function chunkBlocks(blocks: Element[]): RawSection[] {
	const out: RawSection[] = []
	let current: Element[] = []
	let chars = 0
	for (const block of blocks) {
		const n = blockChars(block)
		if (current.length && chars + n > MAX_SECTION_CHARS) {
			out.push({ blocks: current, title: titleOfBlocks(current) })
			current = []
			chars = 0
		}
		current.push(block)
		chars += n
	}
	if (current.length) out.push({ blocks: current, title: titleOfBlocks(current) })
	return out
}

function splitIntoSections(blocks: Element[]): RawSection[] {
	if (!blocks.length) return []
	let headings = 0
	for (const block of blocks) if (SECTION_HEADINGS.has(block.tagName)) headings++
	// 阈值 2：只有一个 h1 的文档（文章正文就是这样）不该被切成「一章」
	const useHeadings = headings >= 2
	const groups: Element[][] = []
	let current: Element[] = []
	for (const block of blocks) {
		if (useHeadings && current.length && SECTION_HEADINGS.has(block.tagName)) {
			groups.push(current)
			current = []
		}
		current.push(block)
	}
	if (current.length) groups.push(current)
	return groups.flatMap(chunkBlocks)
}

/** 页内锚点跨节改写：`#foo` → `「foo 所在节的 index」#foo`。
 *
 *  为什么要改：切章后每个 `#foo` 只在**本节的文档**里找（engineAdapter.scrollToAnchorIn），
 *  而脚注/尾注/文中「见上文」这类锚点的目标常常落在别的节 —— 不改写就点了没反应。
 *  改写后的形态 `3#foo` 走 rewriteAnchors 的常规路径：resolveHref 取到 3 → 目标节内
 *  按 id 定位。查不到目标 id 的保持 `#foo` 原样（节内锚点仍然可用）。 */
function rewriteCrossSectionAnchors(sections: RawSection[]): void {
	const idToSection = new Map<string, number>()
	// 注意包含**块自身**的 id：`#foo` 的常见目标是独占一段的 `<p id="foo">`，
	// 而 querySelectorAll 只返回后代 —— 漏掉它会让整张映射表为空、锚点一条也改不掉
	// （探针 H6 抓到过的真实故障）。
	const scanIds = (block: Element, index: number): void => {
		const own = block.getAttribute("id")
		if (own && !idToSection.has(own)) idToSection.set(own, index)
		for (const el of Array.from(block.querySelectorAll("[id]"))) {
			const id = el.getAttribute("id")
			if (id && !idToSection.has(id)) idToSection.set(id, index)
		}
	}
	sections.forEach((section, index) => {
		for (const block of section.blocks) scanIds(block, index)
	})
	if (!idToSection.size) return
	sections.forEach((section, index) => {
		for (const block of section.blocks) {
			for (const anchor of Array.from(block.querySelectorAll('a[href^="#"]'))) {
				const raw = anchor.getAttribute("href") ?? ""
				const id = raw.slice(1)
				if (!id) continue
				const target = idToSection.get(id)
				if (target == null || target === index) continue
				anchor.setAttribute("href", `${target}#${id}`)
			}
		}
	})
}

/* ---------------- 序列化 ---------------- */

/**
 * 最后一道网：DOMPurify 按白名单重写一遍正文 HTML。
 *
 * 为什么手工摘过还要它：上面那遍是「按元素名/属性名删」的节点级清理，而**解析差异**
 * （属性名大小写与命名空间变体、嵌套畸形标签被浏览器重新解析成别的结构、mXSS 那类
 * 「净化后再次解析才现形」的构造）恰恰是这类清理的固有盲区。白名单重写能兜住它们，
 * 而且与 feed 文章用的是同一个库同一套用法（见 articleExtractor.ts）。
 *
 * 只处理**片段**（WHOLE_DOCUMENT:false）：这里拿到的就是若干块的 outerHTML 拼接，
 * 外壳由 sectionHtml 自己拼 —— 让 DOMPurify 补 `<html>/<head>` 会把我们的基线样式
 * 挤到它自己生成的 head 之外。
 */
function sanitizeBlocks(blocks: Element[]): string {
	const inner = blocks.map(b => b.outerHTML).join("\n")
	const clean = DOMPurify.sanitize(inner, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOWED_URI_REGEXP,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	});
	return String(clean);
}

function sectionHtml(blocks: Element[]): string {
	const inner = sanitizeBlocks(blocks)
	return '<!DOCTYPE html><html><head><meta charset="utf-8">'
		+ `<style id="unreader-html-base">${HTML_BASE_CSS}</style>`
		+ `</head><body>${inner}</body></html>`
}

/* ---------------- 书架预览 ---------------- */

function firstExcerpt(doc: Document): string | null {
	for (const el of Array.from(doc.querySelectorAll("p, li, td, dd"))) {
		const line = pick(el.textContent)
		if (line.length >= 8) return line.slice(0, EXCERPT_CHARS)
	}
	const body = doc.body
	if (!body) return null
	for (const node of Array.from(body.childNodes)) {
		const el = elementOf(node)
		if (el && /^H[1-6]$/.test(el.tagName)) continue
		const line = pick(node.textContent)
		if (line) return line.slice(0, EXCERPT_CHARS)
	}
	const fallback = pick(body.textContent)
	return fallback ? fallback.slice(0, EXCERPT_CHARS) : null
}

/** 书架卡片用的轻量预览：不建合成书、不留 blob URL、不注入资源解析器
 *  （卡片只显示文字，图片一律摘掉）。 */
export function htmlPreview(buffer: ArrayBuffer, fallbackName = "未命名"): HtmlPreview {
	const parsed = parseDocument(buffer, fallbackName)
	cleanDocument(parsed.doc)
	return { title: parsed.title, author: parsed.author, excerpt: firstExcerpt(parsed.doc) }
}

/* ---------------- 主入口 ---------------- */

export function isHtmlExt(ext: string): boolean {
	const normalized = ext.toLowerCase().replace(/^\./, "")
	return normalized === "html" || normalized === "htm"
}

export function isHtmlFile(file: File): boolean {
	return isHtmlExt(file.name || "")
}

/**
 * 把本地 HTML 的 File 变成 foliate 可用的合成 book。
 *
 * @param file 源自 vault 的文件（`bookService.readBookFile` 产出，name 带 .html/.htm）
 * @param options.resolveResource vault 侧注入的相对路径解析器（见文件头）
 */
export async function makeHtmlBook(file: File, options: HtmlBookOptions = {}): Promise<HtmlBook> {
	const buffer = await file.arrayBuffer()
	if (!buffer.byteLength) throw new Error("HTML 文件为空")
	const parsed = parseDocument(buffer, file.name || "未命名")
	const text = parsed.doc.body?.textContent ?? ""
	cleanDocument(parsed.doc, options.resolveResource)

	const body = parsed.doc.body
	if (!body) throw new Error("HTML 文件没有可读正文")
	const raw = splitIntoSections(Array.from(contentRoot(body).children))
	const kept = raw.filter(section => pick(section.blocks.map(b => b.textContent ?? "").join(" ")) !== "")
	if (!kept.length) throw new Error("HTML 文件没有可读文本")
	rewriteCrossSectionAnchors(kept)

	const urls: string[] = []
	const sections: HtmlSection[] = kept.map((section, index) => {
		const html = sectionHtml(section.blocks)
		const size = section.blocks.reduce((n, b) => n + blockChars(b), 0) || 1
		let url: string | null = null
		const urlOf = (): string => {
			if (!url) {
				url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
				urls.push(url)
			}
			return url
		}
		return {
			id: index,
			size,
			// 与 txtBook/fb2 一致：**同步**返回 blob URL（engineAdapter 用 `await` 接收，
			// 对字符串同样成立；这里不要改成 async —— 见文件头的同步约束）
			load: urlOf,
			createDocument: () => new DOMParser().parseFromString(html, "text/html"),
		}
	})

	// 目录：每个「以 h1/h2 开头」的节一条（安全阀切出的续节不建条目，靠
	// 「最近前驱目录条目」归到同一个章名下，与 MOBI/TXT 分节行为一致）。
	const toc: HtmlTocItem[] = []
	kept.forEach((section, index) => {
		if (section.title) toc.push({ label: section.title, href: String(index) })
	})
	// 单节单条目的目录没有导航价值：整篇一节的文档（最常见形态）直接不留目录，
	// 让侧栏走「从章节文档派生」那条路。
	const flatToc = sections.length > 1 ? toc : []

	const resolveHref = (href: string): { index: number } | null => {
		const head = (href.split("#")[0] ?? "").trim()
		if (!head) return { index: 0 }
		const n = Number(head)
		if (!Number.isInteger(n) || n < 0 || n >= sections.length) return null
		return { index: n }
	}

	return {
		__unreaderTxt: true,
		metadata: {
			title: parsed.title || file.name || "未命名",
			author: parsed.author,
			language: pick(parsed.doc.documentElement.getAttribute("lang")) || guessLanguage(text),
		},
		toc: flatToc,
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
