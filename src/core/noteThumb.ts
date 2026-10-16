import { App, TFile } from "obsidian";

/** 笔记卡片缩略图：从一篇 Markdown 笔记里挑出**第一张库内图片**，转成可显示的资源 URL。
 *
 *  为什么值得单独一层：侧边「笔记」页只索引「最近阅读 + 星标」那 ≤17 篇（见
 *  `main.getMarkdownNoteListItems`），数量小到可以按需读正文；但读正文 + 链接解析都要
 *  缓存与去重，否则每次切页重绘都会把同一批文件重新读一遍。
 *
 *  取值优先级：frontmatter 的显式封面字段 → 正文第一处图片嵌入。
 *  只认**库内**图片（`app.vault.getResourcePath` 能给的资源 URL）：笔记里指向远程的图片
 *  不在这里下载 —— 列表卡片的网络请求只允许来自 RSS 那条受设置约束的通道，否则一本
 *  笔记抽屉会凭空产生一堆不可控的外链请求。 */

/** 能当缩略图渲染的扩展名（svg 也算：`<img>` 能画它）。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

/** frontmatter 里常见的封面色字段名。 */
const COVER_KEYS = ["cover", "thumbnail", "image", "banner"];

/** 缓存条数上限：列表最多 17 篇，给两轮富余。 */
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

/** 从一段「链接写法」里抽出真正的路径：`[[a/b.png]]` / `![[a.png|300]]` / `![](a.png)` / `"a.png"`。 */
function linkToken(raw: string): string | null {
	const value = raw.trim();
	if (!value) return null;
	const embed = /!?\[\[([^\]|#]+)/.exec(value);
	if (embed?.[1]) return embed[1].trim();
	const md = /!?\[[^\]]*\]\(([^)\s]+)/.exec(value);
	if (md?.[1]) return md[1].trim();
	return value.replace(/^['"]|['"]$/g, "").trim();
}

/** frontmatter 的封面字段（只扫文件头部那段 YAML，不全文正则）。 */
function frontmatterCover(body: string): string | null {
	const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
	if (!block?.[1]) return null;
	for (const line of block[1].split(/\r?\n/)) {
		const field = /^\s*([A-Za-z_-]+)\s*:\s*(.+?)\s*$/.exec(line);
		if (!field) continue;
		if (!COVER_KEYS.includes(field[1]!.toLowerCase())) continue;
		const token = linkToken(field[2]!);
		if (token) return token;
	}
	return null;
}

/** 正文第一处图片嵌入（wikilink 与标准 markdown 两种写法取更靠前的那处）。 */
function firstImageEmbed(body: string): string | null {
	const wiki = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/.exec(body);
	const markdown = /!\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/.exec(body);
	const candidates: Array<{ index: number; token: string }> = [];
	if (wiki?.[1]) candidates.push({ index: wiki.index, token: wiki[1].trim() });
	if (markdown?.[1]) candidates.push({ index: markdown.index, token: markdown[1].trim() });
	if (!candidates.length) return null;
	candidates.sort((a, b) => a.index - b.index);
	return candidates[0]!.token;
}

/** 库内图片链接 → 资源 URL；解析不到、或目标不是图片（如 `![[另一篇笔记]]` 的转写）返回 null。 */
function resolveVaultImage(app: App, link: string, sourcePath: string): string | null {
	const cleaned = link.split("#")[0]!.split("?")[0]!.replace(/^\.\//, "").trim();
	if (!cleaned) return null;
	let decoded = cleaned;
	try { decoded = decodeURIComponent(cleaned); } catch { /* 非法百分号转义：按原样试 */ }
	const target = app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
	if (!(target instanceof TFile)) return null;
	if (!IMAGE_EXTS.has(target.extension.toLowerCase())) return null;
	return app.vault.getResourcePath(target);
}

/** 取一篇笔记的缩略图 URL（无则 null）。带缓存 + 同文件并发去重。
 *
 *  读盘用 `cachedRead`：面板重绘频繁（切页/星标/开合），直接 `read` 会把磁盘打满；
 *  `cachedRead` 命中 Obsidian 的读缓存，且文件被外部改动时由 stat 变化触发重新解析。 */
export function resolveNoteThumb(app: App, path: string): Promise<string | null> {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile)) return Promise.resolve(null);
	const key = cacheKey(file);
	if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
	const inflight = pending.get(key);
	if (inflight) return inflight;

	const task = app.vault.cachedRead(file)
		.then(body => {
			const link = frontmatterCover(body) ?? firstImageEmbed(body);
			if (!link) return null;
			return resolveVaultImage(app, link, file.path);
		})
		.catch(() => null)
		.then(url => {
			// 读盘期间文件被改（或被删）时不要写进缓存 —— 键是按 stat 算的，旧结果会污染新键。
			const current = app.vault.getFileByPath(path);
			if (current instanceof TFile && cacheKey(current) === key) touchCache(key, url);
			return url;
		})
		.finally(() => pending.delete(key));

	pending.set(key, task);
	return task;
}

/** 清空缓存（插件卸载 / 库切换时收口）。 */
export function clearNoteThumbCache(): void {
	cache.clear();
	pending.clear();
}
