/**
 * 本地 HTML → foliate「合成 book」（**网页原样**通道）。
 *
 * ## 口径（2026-09-20 改版，之前是「切章 + 丢作者 CSS 的书本化重排」）
 * HTML **不**按书的形态重排，而是「网页打开什么样就什么样」：
 *  ① **整篇 = 一节**，绝不按标题切章。切章会把一篇网页拆进多个 iframe —— 跨段 CSS
 *     选择器（`body > .wrap + .foot`、`.post p:first-child`）、`position:fixed/sticky`
 *     页头、文档级背景、页内锚点的天然连续性全部失真，而且「一章」这个切分对网页
 *     本来就无意义（`<h2>` 是排版层级，不是书的分卷）；
 *  ② **作者 CSS 一律保留**：`<style>` / `<link rel=stylesheet>` / 内联 `style` 全部原样
 *     进入章节文档。阅读器的字体/字号/行距/配色只作为 **`:where()` 零特异性兜底**
 *     （见 engineAdapter 的 WebFrameCss）—— 作者写过任何一条相关声明，作者赢；
 *  ③ 宿主容器在网页模式下**取消版心封顶与左右内边距**（见 engineAdapter.applyWebHostLayout），
 *     页面自己的 `max-width`/`margin:auto` 说了算。
 *
 * 外壳仍是「合成书」（与 txtBook.ts / feedBookFactory.ts 同形状，标 `__unreaderWebLayout`），
 * 所以**阅读器能力照旧**：连续滚动、进度、位置恢复、标注与高亮全都可用 —— 放弃的只是
 * 「把网页重排成书」。engineAdapter 侧凡是「非 EPUB」的判据一律写 `!== "epub"`。
 *
 * ## 仍然不执行脚本（安全红线，不是排版取舍）
 * 章节 iframe 用 `srcdoc` 注入、与本插件**同源**，且**没有 `sandbox` 属性**，Obsidian
 * 的 CSP 也不限制 `script-src`（见 engineAdapter.renderSection 的注释）。本地 HTML 是
 * 不可信输入（剪藏 / 别人给的文件 / 下载的页面），执行里面的 `<script>` 等于「打开一份
 * 文件 = 让它在 vault 里以完整同源权限运行」。所以 `<script>`、`on*`、表单控件、
 * `<meta http-equiv=refresh>`（会把 iframe 整个导航走）一律摘掉。
 * 代价：靠 JS 渲染正文的页面（SPA、无限滚动、懒加载图）只能看到静态骨架。
 * 样式表**不在此列** —— CSS 不构成代码执行面，且「网页原样」本来就以它为核心。
 *
 * ## 相对资源必须在合成阶段烧进 HTML
 * 章节是 `about:srcdoc` → **没有 base URL**，`<img src="assets/a.png">` 直接裂图。
 * 所以 `<img>`（惰性属性与 `srcset` 候选都算在内）、`<link rel=stylesheet>`、媒体 `<source>`/`<track>`、
 * SVG 的 `<image>`/`<feImage>`，以及 `<style>` 与内联 `style` 里的 `url()`/`@import` 都在这里
 * 改写成 vault 资源 URL（解析器由调用方注入，见 bookService.createVaultResourceResolver）。
 * **`#foo` 形态的 CSS 引用（SVG 滤镜/渐变）必须原样保留**，否则会把图形打散。
 *
 * 本模块**不依赖 Obsidian**（与 txtBook 一致）：全套是纯函数 + DOM API。
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
	/** **网页原样**标记：engineAdapter 据此换掉 frame 样式与宿主版心（见文件头） */
	readonly __unreaderWebLayout: true
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
	 *  返回 null / 不注入 = 解析不到 → 该 `<img>` 会被摘掉（CSS 里的引用保持原样）。 */
	resolveResource?: (raw: string) => string | null
}

export interface HtmlPreview {
	title: string
	author: string
	excerpt: string | null
}

/* ---------------- 可调常量 ---------------- */

/** 整棵摘掉：可执行 / 可自导航 / 与「看网页」无关。
 *  ⚠️ `style` 与 `link[rel=stylesheet]` **刻意不在列** —— 保留作者 CSS 是本通道的核心。
 *  `svg` / `math` 也不在列：它们交给 DOMPurify 的 svg / mathMl profile 兜底
 *  （手工按标签名摘会把整棵子树连同图形一起删掉，而 SVG 图标在剪藏里极常见）。 */
const DROP_SELECTOR = [
	"script", "base", "noscript", "template",
	"iframe", "frame", "frameset", "object", "embed", "applet",
	"form", "input", "button", "select", "option", "optgroup", "textarea",
	"dialog", "slot",
].join(",")

/** `<head>` 里允许保留的 `meta` 白名单（其余一律丢）。
 *  `meta[http-equiv]` 全部不要：`refresh` 会导航、`Content-Security-Policy` 会拦住我们
 *  注入的样式。`color-scheme` 留（它确实影响 UA 默认配色，属于「网页原样」的一部分）。
 *  **`meta[charset]` 刻意不留**：文本已经过 `decodeTxt` 的字节嗅探解码，产物恒为 UTF-8
 *  字符串；作者那份声明则常与实际字节不符（老中文站点保存下来的页面写 `gb2312` 是常态，
 *  而我们为了保真把 `<meta charset>` 照搬进 srcdoc，等于**用一个错误编码去解析 UTF-8 字节**
 *  —— 整页乱码）。统一交给 headString 声明 `utf-8`。 */
const HEAD_META_KEEP = new Set(["color-scheme"])

/** `html` / `body` 上允许保留的属性。`style` 在列（作者可能整页设底色）。 */
const ROOT_ATTRS = new Set(["class", "id", "style", "lang", "dir"])

/** DOMPurify 收尾时额外放行的属性：资源改写阶段由我们写上去的那些
 *  （svg profile 的默认表不一定覆盖 `loading` / `decoding` / `referrerpolicy`）。 */
const EXTRA_ATTR = [
	"loading", "decoding", "referrerpolicy", "srcset", "sizes", "media", "type",
	"controls", "preload", "poster", "colspan", "rowspan", "start", "reversed",
	"datetime", "cite", "open", "target", "rel", "download",
]

/**
 * URI 白名单：DOMPurify 默认只认 `http(s)/mailto/tel/callto/sms/cid/xmpp` 与相对路径，
 * **`app://` 会被当作非法协议直接把属性摘掉** —— 而「相对资源 → vault 资源 URL」这条
 * 链路改写出来的正是 `app://local/…`（桌面）与 `capacitor://localhost/…`（移动端），
 * 于是「改写成功但属性被净化掉」＝ 图片全部裂图。
 * **刻意不放 `file:`**：桌面端 `file://` 能读本地磁盘，没有放行它的理由。
 */
const ALLOWED_URI_REGEXP =
	/^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|data|blob|app|capacitor):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

/** 惰性图片的真图属性（剪藏里非常常见，`src` 往往只是 1px 占位）。 */
const LAZY_SRC_ATTRS = ["data-src", "data-original", "data-lazy-src"]

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const EXCERPT_CHARS = 160
const TITLE_MAX_CHARS = 80

/** 预览取正文时忽略的元素（保留 `<style>` 之后，`textContent` 会把 CSS 一起带出来）。 */
const TEXT_SKIP = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "TITLE", "HEAD"])

/* ---------------- 小工具 ---------------- */

/** 折叠空白并 trim（HTML 里的换行/缩进不是内容） */
function pick(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim()
}

function elementOf(node: Node | null): Element | null {
	return node && node.nodeType === Node.ELEMENT_NODE ? node as Element : null
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

function attrString(el: Element | null, allowed: Set<string>): string {
	if (!el) return ""
	let out = ""
	for (const attr of Array.from(el.attributes)) {
		const name = attr.name.toLowerCase()
		if (!allowed.has(name)) continue
		out += ` ${name}="${escapeAttr(attr.value)}"`
	}
	return out
}

/**
 * 相对/绝对/内联资源 → 可直接写进 `src`/`href` 的 URL；解析不到返回 null。
 *
 * `#foo` 必须原样返回：它是**页内引用**（SVG 的 `filter="url(#blur)"`、
 * `fill="url(#grad)"`、页内锚点），当成相对路径去 vault 里找必然找不到，
 * 替换掉就会把图形/锚点打断。
 */
function resolveUrl(raw: string | null, resolveResource?: (raw: string) => string | null): string | null {
	const value = (raw ?? "").trim()
	if (!value) return null
	if (value.startsWith("#")) return value
	if (/^(?:data:|blob:|about:)/i.test(value)) return value
	if (/^https?:/i.test(value)) return value
	if (value.startsWith("//")) return `https:${value}`
	// 其余一律当相对路径：只有上层注入了 vault 解析器才可能成功
	if (!resolveResource) return null
	try { return resolveResource(value) } catch { return null }
}

/** CSS 里的 `url(...)`：三种引号形态（双引号 / 单引号 / 裸） */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi
/** `@import "x.css"`（`@import url(x.css)` 已被上面的 url() 规则覆盖） */
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi

/**
 * 改写一段 CSS 文本里的资源引用（`<style>` 正文与内联 `style` 属性共用）。
 *
 * **解析不到时保持原样**，不替换成 `none`：`url()` 出现在逗号列表里
 * （`background-image:url(a),url(b)`、`cursor:url(x),auto`）时替换成 `none`
 * 会改变语义结构；留着原样只是这一条加载失败，浏览器自己会放弃。
 */
function rewriteCss(raw: string, resolveResource?: (raw: string) => string | null): string {
	if (!resolveResource || !raw) return raw
	let out = raw.replace(CSS_URL_RE, (match, dq, sq, bare) => {
		const value = String(dq ?? sq ?? bare ?? "").trim()
		if (!value || value.startsWith("#")) return match
		const url = resolveUrl(value, resolveResource)
		return url && url !== value ? `url("${url}")` : match
	})
	out = out.replace(CSS_IMPORT_RE, (match, dq, sq) => {
		const value = String(dq ?? sq ?? "").trim()
		if (!value) return match
		const url = resolveUrl(value, resolveResource)
		return url && url !== value ? `@import "${url}"` : match
	})
	return out
}

/** `srcset` 拆成候选（`"a.png 1x, b.png 2x"` → `{url, descriptor}` 列表）。
 *  拆出来是为了两用：逐条改写（下面），以及「`src` 全不可解析时从候选里找一条生路」
 *  （见 cleanDocument ④）—— 后者需要的是**候选本身**，不是改写后的字符串。 */
function srcsetParts(value: string): Array<{ url: string; descriptor: string }> {
	const out: Array<{ url: string; descriptor: string }> = []
	for (const part of value.split(",").map(s => s.trim()).filter(Boolean)) {
		const space = part.search(/\s/)
		if (space === -1) out.push({ url: part, descriptor: "" })
		else out.push({ url: part.slice(0, space), descriptor: part.slice(space) })
	}
	return out
}

/** `srcset="a.png 1x, b.png 2x"` → 逐候选改写（多倍图在网页里是常态）。
 *  解析不到的**单条候选**原样留着：整串丢给浏览器，它自己会跳过取不到的候选。 */
function rewriteSrcset(value: string, resolveResource?: (raw: string) => string | null): string {
	if (!resolveResource || !value.trim()) return value
	const parts = srcsetParts(value)
	if (!parts.length) return value
	return parts.map(p => (resolveUrl(p.url, resolveResource) ?? p.url) + p.descriptor).join(", ")
}

/** SVG 里会引用**外部资源**的元素。用 `localName` 比对而不是选择器：`feImage` 是驼峰，
 *  而类型选择器对**外来元素**是大小写敏感的，写死容易在某条路径上静默漏掉。
 *  `use` **刻意不在列**：DOMPurify 把它放进了 `svgDisallowed`（上游针对 mXSS 的加固，
 *  见 purify 的 ALL_SVG_TAGS），走到净化那一步整棵都会被摘掉 —— 给它做改写只是写一段
 *  永远看不见的代码。代价是 sprite 图标在这个通道里会缺失，这是**已知取舍**，
 *  不为它去放开上游的安全默认值（探针 H9 用一条断言把这个取舍钉住）。 */
const SVG_REF_TAGS = new Set(["image", "feImage"])

function guessLanguage(text: string): string {
	const sample = text.slice(0, 20000)
	if (!sample) return "zh"
	let cjk = 0
	for (const ch of sample) if (CJK_RE.test(ch)) cjk++
	return cjk / sample.length > 0.05 ? "zh" : "en"
}

/* ---------------- 解析 + 元数据 ---------------- */

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
 * 解码好的字符串），所以只能靠字节嗅探。产物一侧的声明由 headString 统一写成 utf-8
 *  （见 HEAD_META_KEEP）—— 作者那份声明常与实际字节不符，留着只会让 srcdoc 按错编码解析。
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

/* ---------------- 净化（只去代码面，不去样式） ---------------- */

/**
 * 就地清理：摘掉可执行 / 可导航 / 与正文无关的节点，改写资源 URL。
 *
 * 顺序无关紧要，但**都必须在 DOMPurify 收尾之前**做完：收尾那一步是
 * 「按白名单重写字符串」，重写之后手上的 DOM 就与产物无关了。
 */
function cleanDocument(doc: Document, resolveResource?: (raw: string) => string | null): void {
	const head = doc.head

	// ① 整棵摘掉危险/无关元素（head 与 body 一起扫；`script` 也会命中 SVG 里的同名节点）
	for (const el of Array.from(doc.querySelectorAll(DROP_SELECTOR))) el.remove()

	// ② head 收敛到白名单：title / charset / color-scheme / style / link[rel~=stylesheet]
	if (head) {
		for (const el of Array.from(head.children)) {
			const tag = el.tagName
			if (tag === "STYLE" || tag === "TITLE") continue
			if (tag === "LINK") {
				const rel = (el.getAttribute("rel") ?? "").toLowerCase()
				if (rel.split(/\s+/).includes("stylesheet")) continue
			}
			if (tag === "META") {
				// `meta[charset]` 不在白名单里 ⇒ 落入下面的 `el.remove()`（见 HEAD_META_KEEP）
				const name = (el.getAttribute("name") ?? "").toLowerCase()
				if (HEAD_META_KEEP.has(name)) continue
			}
			el.remove()
		}
	}

	// ③ 属性：`on*` 是「留下的标签」重新变成可执行代码的唯一通道；
	//    `srcdoc`/`formaction`/`ping` 是残留的注入与信标面；`autoplay` 让开书即出声。
	for (const el of Array.from(doc.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase()
			if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "ping" || name === "autoplay") {
				el.removeAttribute(attr.name)
			}
		}
	}

	// ④ 图片：src / 惰性属性 / `srcset` 候选里取第一个能解析的当 `src`；
	//    三处都解析不到才摘掉整个 <img>（少看一条通道就会把浏览器里看得见的图弄没）。
	//    `srcset`/`sizes` 另外逐候选改写（直接丢掉会让响应式图退化成单倍图）。
	for (const img of Array.from(doc.querySelectorAll("img"))) {
		let url: string | null = null
		for (const raw of [img.getAttribute("src"), ...LAZY_SRC_ATTRS.map(a => img.getAttribute(a))]) {
			url = resolveUrl(raw, resolveResource)
			if (url) break
		}
		const srcset = img.getAttribute("srcset") ?? ""
		// `src` 与惰性属性全不可解析时**不能直接判死**：`srcset` 才是候选来源。
		// 只有 `srcset` 的 <img> 是合法写法（响应式图的常见形态），「src 指向本地缺失
		// 路径、真图在 CDN 的 srcset 里」在剪藏里也常见 —— 浏览器里两张都看得见，
		// 老实现却把它们整张摘掉。取第一个可解析的候选当 `src`，其余候选照旧逐条改写。
		if (!url) {
			for (const candidate of srcsetParts(srcset)) {
				url = resolveUrl(candidate.url, resolveResource)
				if (url) break
			}
		}
		if (!url) { img.remove(); continue }
		img.setAttribute("src", url)
		for (const lazy of LAZY_SRC_ATTRS) img.removeAttribute(lazy)
		if (srcset) img.setAttribute("srcset", rewriteSrcset(srcset, resolveResource))
		img.setAttribute("loading", "lazy")
		img.setAttribute("decoding", "async")
		img.setAttribute("referrerpolicy", "no-referrer")
	}

	// ⑤ <picture><source srcset>：按 srcset 改写；video/audio 的 <source src> 与
	//    <track src>（字幕/章节）都按媒体资源处理
	for (const source of Array.from(doc.querySelectorAll("source, track"))) {
		const srcset = source.getAttribute("srcset")
		if (srcset) source.setAttribute("srcset", rewriteSrcset(srcset, resolveResource))
		const raw = source.getAttribute("src")
		if (raw == null) continue
		const url = resolveUrl(raw, resolveResource)
		if (url) source.setAttribute("src", url)
		else source.removeAttribute("src")
	}

	// ⑥ SVG 里的资源引用：`<image>` / `<feImage>` 的 `href` 与 `xlink:href`
	//    （`<use>` 见 SVG_REF_TAGS 的注释：上游净化会整棵摘掉它）。
	//    相对路径在 srcdoc 里同样没有 base URL ⇒ 不改写就是裂图；
	//    `#frag` 是**页内引用**（渐变、滤镜、符号），resolveUrl 原样返回 ⇒ 不动它。
	//    解析不到时摘掉该属性：留着就是一条永远取不到的引用（浏览器只会画一个空位）。
	for (const el of Array.from(doc.querySelectorAll("svg *"))) {
		if (!SVG_REF_TAGS.has(el.localName)) continue
		for (const attr of ["href", "xlink:href"]) {
			const raw = (el.getAttribute(attr) ?? "").trim()
			if (!raw || raw.startsWith("#")) continue
			const url = resolveUrl(raw, resolveResource)
			if (url) el.setAttribute(attr, url)
			else el.removeAttribute(attr)
		}
	}

	// ⑦ 媒体：直接挂在 video/audio 上的 src / poster
	for (const media of Array.from(doc.querySelectorAll("video, audio"))) {
		const raw = media.getAttribute("src")
		if (raw != null) {
			const url = resolveUrl(raw, resolveResource)
			if (url) media.setAttribute("src", url)
			else media.removeAttribute("src")
		}
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
		if (media.querySelector("source[src], source[srcset]")) continue
		media.remove()
	}

	// ⑧ 样式表链接：相对路径必须在这里改写（srcdoc 无 base URL）。
	//    `rel` 已由第 ② 步收敛，这里只处理 href；解析不到就摘掉整条 link
	//    （留着只会去请求一个不存在的地址，白等一次网络超时）。
	for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
		const url = resolveUrl(link.getAttribute("href"), resolveResource)
		if (url) link.setAttribute("href", url)
		else link.remove()
	}

	// ⑨ CSS 文本里的 url()/@import：<style> 正文 + 内联 style 属性
	for (const style of Array.from(doc.querySelectorAll("style"))) {
		style.textContent = rewriteCss(style.textContent ?? "", resolveResource)
	}
	for (const el of Array.from(doc.querySelectorAll("[style]"))) {
		const css = el.getAttribute("style")
		if (css) el.setAttribute("style", rewriteCss(css, resolveResource))
	}

	// ⑩ 链接：只留「页内锚点 + 绝对协议」。
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

/**
 * DOMPurify 按白名单重写一遍 body 片段。
 *
 * 为什么手工摘过还要它：上面那遍是「按元素名/属性名删」的节点级清理，而**解析差异**
 * （属性名大小写与命名空间变体、嵌套畸形标签被浏览器重新解析成别的结构、mXSS 那类
 * 「净化后再次解析才现形」的构造）恰恰是这类清理的固有盲区 —— SVG/MathML 命名空间里
 * 尤其多。白名单重写能兜住它们，而且与 feed 文章用的是同一个库同一套用法。
 *
 * `svg` / `svgFilters` / `mathMl` 三个 profile 是**刻意开**的：网页原样就要求 SVG 图标
 * 能显示。它们的标签/属性白名单由 DOMPurify 维护（含 `foreignObject`、`<use>` 等
 * 已知构造的处理），比我们自己搬一份 SVG 白名单可靠。
 *
 * `style` 用 `ADD_TAGS` 放行：DOMPurify 默认表里没有它，而它的内容（CSS 文本）
 * DOMPurify **不做净化** —— 这没问题，CSS 不构成代码执行面，风险只有 `url()` 取图，
 * 而作者 CSS 本来就要保留（见文件头）；URL 已在 cleanDocument 里改写。
 */
function sanitizeBody(inner: string): string {
	const clean = DOMPurify.sanitize(inner, {
		USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
		ADD_TAGS: ["style"],
		ADD_ATTR: EXTRA_ATTR,
		FORBID_TAGS: [
			"script", "base", "noscript", "template", "iframe", "frame", "frameset",
			"object", "embed", "applet", "form", "input", "button", "select", "option",
			"optgroup", "textarea", "dialog", "slot", "link", "meta", "title", "html", "head",
		],
		FORBID_ATTR: ["srcdoc", "formaction", "ping", "autoplay", "http-equiv"],
		ALLOWED_URI_REGEXP,
	});
	return String(clean);
}

/* ---------------- 序列化 ---------------- */

/** `<head>` 产物：只序列化第 ② 步留下的那几类元素（顺序保持原样）。
 *  `charset` 由我们**统一声明并放在最前**（作者的已在第 ② 步摘掉，见 HEAD_META_KEEP）：
 *  产物是 UTF-8 字符串，作者写的是 gb2312 也好 utf-8 也好都不作数；
 *  而且必须在前 1024 字节内才被编码嗅探认到，所以不能追加在队尾。 */
function headString(doc: Document): string {
	const out: string[] = ['<meta charset="utf-8">']
	const head = doc.head
	if (head) {
		for (const el of Array.from(head.children)) {
			const tag = el.tagName
			if (tag === "STYLE" || tag === "TITLE" || tag === "LINK" || tag === "META") out.push(el.outerHTML)
		}
	}
	return out.join("\n")
}

/**
 * 一份完整文档 → 合成 section 的 HTML。
 *
 * **整篇一个文档，不做任何包装/切分**：`<head>` 原样带上（作者 CSS 就在里面），
 * `<html>`/`<body>` 的属性原样带上（作者的 `class`/`style` 常挂在它们上面）。
 *
 * 拼字符串而不是操作 DOM：`innerHTML` 赋值会踩官方 lint 的 `no-unsanitized/method`
 * （见 engineAdapter 里 `insertAdjacentHTML` 的同类处理）。所有片段要么来自 DOMPurify
 * 的产物、要么是我们自己序列化的白名单元素；`html`/`body` 属性走 `attrString`
 * 转义（值里带引号也不会破坏结构）。
 */
function documentHtml(doc: Document): string {
	const cleanBody = sanitizeBody(doc.body?.innerHTML ?? "")
	const htmlAttrs = attrString(doc.documentElement, ROOT_ATTRS)
	const bodyAttrs = attrString(doc.body, ROOT_ATTRS)
	return '<!DOCTYPE html>'
		+ `<html${htmlAttrs}><head>${headString(doc)}</head>`
		+ `<body${bodyAttrs}>${cleanBody}</body></html>`
}

/* ---------------- 书架预览 ---------------- */

/** 可见文本（跳过 style/script 等，见 TEXT_SKIP） */
function visibleText(el: Element): string {
	let out = ""
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue ?? ""; continue }
		const child = elementOf(node)
		if (!child || TEXT_SKIP.has(child.tagName)) continue
		out += visibleText(child)
	}
	return out
}

function firstExcerpt(doc: Document): string | null {
	for (const el of Array.from(doc.querySelectorAll("p, li, td, dd"))) {
		const line = pick(el.textContent)
		if (line.length >= 8) return line.slice(0, EXCERPT_CHARS)
	}
	const body = doc.body
	if (!body) return null
	for (const node of Array.from(body.childNodes)) {
		const line = pick(node.textContent)
		if (line) return line.slice(0, EXCERPT_CHARS)
	}
	const fallback = pick(visibleText(body))
	return fallback ? fallback.slice(0, EXCERPT_CHARS) : null
}

/** 书架卡片用的轻量预览：不建合成书、不留 blob URL、不注入资源解析器
 *  （卡片只显示文字，图片一律摘掉）。 */
export function htmlPreview(buffer: ArrayBuffer, fallbackName = "未命名"): HtmlPreview {
	const parsed = parseDocument(buffer, fallbackName)
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
 * **整篇一节**（见文件头口径①）：`sections` 恒为长度 1、`toc` 恒为空数组 ——
 * 侧栏会走「从章节文档派生条目」那条路（与单 h1 的 TXT 行为一致）。
 * 两个副产品是刻意的：① 目录面板对 HTML 没有多章导航；② 超长网页（几 MB 的剪藏）
 * 整篇进一个 iframe，开书那一下比切章版本慢（换来的是一次渲染、零跨章缝隙）。
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
	if (!parsed.doc.body) throw new Error("HTML 文件没有可读正文")
	if (!pick(parsed.doc.body.textContent ?? "")) throw new Error("HTML 文件没有可读文本")
	const html = documentHtml(parsed.doc)

	const urls: string[] = []
	let url: string | null = null
	const urlOf = (): string => {
		if (!url) {
			url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
			urls.push(url)
		}
		return url
	}

	return {
		__unreaderTxt: true,
		__unreaderWebLayout: true,
		metadata: {
			title: parsed.title || file.name || "未命名",
			author: parsed.author,
			language: pick(parsed.doc.documentElement.getAttribute("lang")) || guessLanguage(text),
		},
		// 整篇一节 ⇒ 没有目录条目：单条目的目录没有导航价值，交给侧栏的派生条目
		toc: [],
		sections: [{
			id: 0,
			size: html.length || 1,
			// 与 txtBook/fb2 一致：**同步**返回 blob URL（engineAdapter 用 `await` 接收，
			// 对字符串同样成立；这里不要改成 async —— 见 txtBook.ts 文件头的同步约束）
			load: urlOf,
			createDocument: () => new DOMParser().parseFromString(html, "text/html"),
		}],
		resolveHref: (href: string) => {
			// 合成书只有一节：任何指向本节的形态都落到 0，其余（越界）交给空值
			const head = (href.split("#")[0] ?? "").trim()
			return head === "" || head === "0" ? { index: 0 } : null
		},
		splitTOCHref: (href: string) => {
			const [a, b] = href.split("#")
			return [Number(a), b == null ? 0 : Number(b)]
		},
		getTOCFragment: (doc: Document, id: string) => doc.getElementById(String(id)),
		isExternal: (uri: string) => /^\w+:/i.test(uri),
		destroy: () => {
			for (const u of urls) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
			urls.length = 0
			url = null
		},
	}
}
