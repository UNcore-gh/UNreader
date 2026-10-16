/** 「保存为 Markdown」的**唯一实现**（订阅卡片那枚按钮、功能轨那枚按钮、md 侧边抽屉里的同一枚）。
 *
 *  为什么必须收口到一处：这段逻辑原先在 `readerView` 与 `mdOverlay` 里各写了一份，
 *  结果**当场漂移** —— md 那份既没置 `state.savedAt`（于是从 md 侧存的文章不会长期保留），
 *  又留着 `kind === "article"` 的旧判据（于是「文章里嵌了录音」的条目存不了）。
 *  两份实现迟早会再一次分叉，所以这里只留一份，宿主只负责「传依赖 + 刷新界面」。
 *
 *  四条口径（与用户历次要求绑定）：
 *  ① **没抓过全文的先抓再存**，抓取失败**不降级成存摘要** —— RSS 摘要存下来没有任何价值，
 *     而用户会以为存到了全文。判据只看「正文够不够」，**不看 `kind`**（见 feedUtils
 *     `canSaveFeedEntry` 里关于「录音嵌入文章」的说明）。
 *  ② **不可保存时先挡掉**（`canSaveFeedEntry`：没有正文可取也没有原文地址），并说清原因，
 *     而不是让 `noteExporter` 落一份空壳。
 *  ③ **落盘成功才置 `state.savedAt`** ⇒ 这篇从此与星标同权长期保留（订阅链接失效 / 刷新
 *     裁剪都不清）。失败绝不置标记：没有 Markdown 备份却显示「已保存」比没保存更坏。
 *  ④ 落点 / 覆盖策略 / 图片命名 / 音频嵌入全部由 `core/noteExporter` 说了算 —— 这里不碰。 */

import { Notice, type App } from "obsidian";
import { canSaveFeedEntry } from "./feedUtils";
import { entryFeedContentQuality } from "./feedContentQuality";
import { saveArticleNote, type ArticleNoteResult } from "./noteExporter";
import type { FeedStore } from "./feedStore";

export interface SaveFeedNoteDeps {
	app: App
	store: FeedStore
	/** 抓网页全文（宿主各自的入口：阅读器走 `fetchFeedFulltext`）。失败由实现方提示，
	 *  这里只按「抓完仍是 Feed 摘要 ⇒ 不保存」处理。 */
	fetchFulltext: (feedId: string, entryId: string) => Promise<unknown> | void
}

/** 成功返回落盘结果（宿主据此刷新界面 / 同步功能轨状态），未保存返回 null。 */
export async function saveFeedEntryAsMarkdown(
	deps: SaveFeedNoteDeps,
	feedId: string,
	entryId: string,
): Promise<ArticleNoteResult | null> {
	const { app, store } = deps;
	const current = store.getEntry(feedId, entryId);
	if (!current) {
		new Notice("文章不存在");
		return null;
	}
	if (!canSaveFeedEntry(current)) {
		new Notice("这篇文章没有可保存的正文（也没有原文地址可抓）");
		return null;
	}
	// 正文可能尚未从 Content 文件水合（按文章分文件存盘）：落盘前确保拿到真正文。
	await store.ensureEntryContent(feedId, entryId);
	let entry = store.getEntry(feedId, entryId) ?? current;
	if (entryFeedContentQuality(entry) !== "full") {
		try {
			await deps.fetchFulltext(feedId, entryId);
		} catch { /* 抓取失败已由实现方提示，这里不再叠一条 */ }
		const fetched = store.getEntry(feedId, entryId);
		// 抓取失败（或抓完仍是 Feed 摘要）：到此为止，绝不退化成「存一份摘要」。
		if (!fetched || fetched.contentSource !== "fulltext") return null;
		entry = fetched;
	}
	try {
		new Notice("正在保存为 Markdown…");
		const result = await saveArticleNote(app, {
			title: entry.title || "未命名文章",
			author: entry.author,
			url: entry.url,
			feedTitle: store.getFeed(feedId)?.title,
			publishedAt: entry.publishedAt,
			contentHtml: entry.contentHtml,
		});
		// 图片落盘失败不当作整体失败：Markdown 里保留的是原链接，笔记本身仍然可用，
		// 只在提示里点明有几张没下来（否则用户会以为笔记里那些链接是正常状态）。
		const images = result.imageCount ? `（图片 ${result.imageCount} 张）` : "";
		const failed = result.failedImages ? `，${result.failedImages} 张图片未保存` : "";
		new Notice(`已保存为 Markdown：${result.path}${images}${failed}`);
		// 存盘成功才置标记（保存时间取首次，重复保存不刷新它）。
		await store.updateEntryState(feedId, entryId, { savedAt: entry.state.savedAt ?? Date.now() });
		return result;
	} catch (error) {
		new Notice(`保存为 Markdown 失败：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}
