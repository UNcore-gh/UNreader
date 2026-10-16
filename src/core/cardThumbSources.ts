/** 列表卡片缩略图的**取数实现**（书架 / 订阅 / 笔记三类共用的两个 resolver）。
 *
 *  为什么必须抽成一份：阅读器与 Markdown 阅读模式各装配一次 `AnnotationsPanel`
 *  （`ui/readerView.ts` 内联 `new AnnotationsPanel({…})` + `ui/sidePanels.ts` 的
 *  `createSidePanel`），回调要各接一次。若这两个 resolver 各写一份，任何一处改口径
 *  （比如「关掉远程图片时算不算缓存」「失败要不要回退原始 url」）都会让两个宿主的卡片
 *  表现分裂 —— 这正是本项目「两宿主行为不一致」的老病根，故收敛到这里。
 *
 *  两条红线：
 *  · **卡片绝不直连远程图**。所有网络请求只走 `feedMediaStore`（受设置约束、按 hash 去重、
 *    带 Referer 兜底），因此这里只认 `blob:` 结果；拿不到就是「这张卡没有图」。
 *  · **笔记只认库内图片**。`app://` 资源 URL 由 `vault.getResourcePath` 给，不产生外链请求。 */

import type { App } from "obsidian";
import type UNreaderPlugin from "../main";
import { firstImageUrl } from "./feedThumb";
import { resolveNoteThumb } from "./noteThumb";

export type FeedThumbResolver = (feedId: string, entryId: string) => Promise<string | null>;
export type NoteThumbResolver = (path: string) => Promise<string | null>;

/** 订阅文章卡片缩略图：`enclosure`（元数据里现成）→ 正文第一张 `<img>`，都要过一次
 *  媒体缓存的下载/命中判定。 */
export function createFeedThumbResolver(plugin: UNreaderPlugin): FeedThumbResolver {
	return async (feedId, entryId) => {
		const entry = plugin.feedStore.getEntry(feedId, entryId);
		if (!entry) return null;
		const { loadRemoteImages, imageCacheMb } = plugin.settings.feeds;
		// 「关掉加载远程图片」或缓存上限设成 0 ⇒ 只认已经缓存的图，绝不联网。
		const allowFetch = loadRemoteImages !== false && imageCacheMb > 0;
		const budget = Math.max(0, Number(imageCacheMb) || 0) * 1024 * 1024;

		const pick = async (url: string): Promise<string | null> => {
			if (!allowFetch && !plugin.feedMediaStore.isCached(url)) return null;
			// referer 用文章地址：不少图床「Referer 为空即 403」，媒体库自带兜底通道。
			const out = await plugin.feedMediaStore.objectUrl(url, allowFetch, budget, entry.url);
			// ⚠️ `objectUrl` 抓不到时会**回传原始 url**（见 feedMediaStore.objectUrl 末尾）。
			// 这里必须只认 `blob:` —— 否则卡片会直连远程图，等于绕过用户的「加载远程图片」
			// 开关，而且断网时还会闪一下裂图。
			return out.startsWith("blob:") ? out : null;
		};

		// ① enclosure 本身就是图片：元数据里已有，省一次读盘（播客的 enclosure 是音频，不命中）。
		const enclosure = entry.enclosure;
		if (enclosure?.url && /^image\//i.test(enclosure.type ?? "")) return pick(enclosure.url);

		// ② 读正文缓存（`ensureEntryContent` 会**就地**水合 `entry.contentHtml`）→ 第一张图。
		await plugin.feedStore.ensureEntryContent(feedId, entryId);
		const src = firstImageUrl(entry.contentHtml ?? "", entry.url);
		return src ? pick(src) : null;
	};
}

/** 笔记卡片缩略图：库内 frontmatter 封面 → 正文首图（`noteThumb` 自带缓存与并发去重）。 */
export function createNoteThumbResolver(app: App): NoteThumbResolver {
	return path => resolveNoteThumb(app, path);
}
