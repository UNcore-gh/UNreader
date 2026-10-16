/**
 * 网页字节 → 字符串的解码。
 *
 * 为什么不能直接用 `requestUrl` 的 `text`：Obsidian 那层固定按 UTF-8 解码，而中文站点
 * （尤其新闻 / 博客 / 政务）至今大量是 GBK / GB18030 / Big5。按 UTF-8 硬解的结果不是
 * "报错"而是**满屏乱码**——正文提取照样"成功"，只是整篇不可读，用户看到的是"抓全文
 * 抓了个乱码回来"。所以抓取侧一律拿 `arrayBuffer` 自己解码：先信响应头声明的 charset，
 * 没有再嗅 `<meta charset>`，都没有才 UTF-8。
 */

/** 常见 charset 别名 → TextDecoder 能认的标签。gb2312/gbk 统一落 gb18030（超集）。 */
const CHARSET_ALIASES: Record<string, string> = {
	"utf8": "utf-8",
	"utf-8": "utf-8",
	"unicode-1-1-utf-8": "utf-8",
	"gb2312": "gb18030",
	"gbk": "gb18030",
	"gb18030": "gb18030",
	"x-gbk": "gb18030",
	"big5": "big5",
	"big5-hkscs": "big5",
	"shift_jis": "shift_jis",
	"sjis": "shift_jis",
	"x-sjis": "shift_jis",
	"windows-31j": "shift_jis",
	"euc-jp": "euc-jp",
	"euc-kr": "euc-kr",
	"iso-8859-1": "windows-1252",
	"latin1": "windows-1252",
	"windows-1252": "windows-1252",
	"windows-1251": "windows-1251",
	"koi8-r": "koi8-r",
};

function normalizeCharsetLabel(raw: string): string {
	const value = raw.trim().toLowerCase().replace(/^["']|["']$/g, "");
	if (!value) return "";
	return CHARSET_ALIASES[value] ?? value;
}

/** 从 `Content-Type` 里取 charset（`text/html; charset=gbk` → `gbk`）。 */
export function charsetFromContentType(contentType: string): string {
	const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? "");
	return match?.[1] ? normalizeCharsetLabel(match[1]) : "";
}

/** 前 4KB 按 latin1 读（ASCII 部分逐字节等价，不受编码影响），再找 meta/XML 声明。 */
function asciiHead(bytes: Uint8Array, limit: number): string {
	const end = Math.min(bytes.length, limit);
	let out = "";
	for (let i = 0; i < end; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
	return out;
}

/** 嗅探 `<meta charset>` / `<meta http-equiv=Content-Type>` / XML 声明里的编码。 */
export function sniffHtmlCharset(bytes: Uint8Array): string {
	const head = asciiHead(bytes, 4096);
	const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
	if (direct?.[1]) return normalizeCharsetLabel(direct[1]);
	const equiv = /<meta[^>]+http-equiv\s*=\s*["']?\s*content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.-]+)/i.exec(head);
	if (equiv?.[1]) return normalizeCharsetLabel(equiv[1]);
	const xml = /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)["']/i.exec(head);
	if (xml?.[1]) return normalizeCharsetLabel(xml[1]);
	return "";
}

function decodeWith(label: string, bytes: Uint8Array): string | null {
	if (!label) return null;
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		// 未知标签（站点乱写 charset 时很常见）：交给调用方回退 UTF-8。
		return null;
	}
}

/** 替换字符占比：用来判定"这次解码明显选错了编码"。 */
function replacementRatio(text: string): number {
	let count = 0;
	for (const char of text) if (char === "\uFFFD") count += 1;
	return count / Math.max(1, text.length);
}

/**
 * 字节 → 文本。优先级：响应头 charset → 页面 meta 嗅探 → UTF-8。
 *
 * 两个兜底都必要：
 * - 原生 `TextDecoder` 对未知标签会抛错（站点乱写 charset 时很常见）→ 逐级回退；
 * - **声明与内容不符**的站点真实存在（头里写 utf-8、字节却是 GBK）。硬解不会报错，
 *   只会得到满屏 `\uFFFD` —— 这里按替换字符占比识别，再拿 meta 声明的编码重试一次。
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType = ""): string {
	if (!bytes.length) return "";
	const declared = charsetFromContentType(contentType);
	const sniffed = sniffHtmlCharset(bytes);
	const order = [declared, sniffed, "utf-8"].filter((label, index, list) => !!label && list.indexOf(label) === index);
	let fallback = "";
	for (const label of order) {
		const text = decodeWith(label, bytes);
		if (text == null) continue;
		if (!fallback) fallback = text;
		if (replacementRatio(text) < 0.002) return text;
	}
	return fallback;
}
