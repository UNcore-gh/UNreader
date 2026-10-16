/** markdown 笔记 → 标注侧边栏（annotations 页）的适配器。
 *
 *  与书 / RSS 的区别：那边的高亮存在旁车笔记里（annotationStore），这边的高亮就是
 *  笔记源文件里的**官方 `==文本==` 语法**（含彩色 emoji 前缀）——没有第二份存储，
 *  侧边栏列表每次打开 / 切页都从源文件**现算**（collectHighlights），删除 = 去掉那对
 *  `==` 标记（正文原样保留），复用 mdHighlightWrite 的 editor / vault 双通道写入。
 *
 *  因此：
 *  · id 是「本次枚举的序号」（1 基），只在当前 data() 快照内有效；删除时重新读最新
 *    源码、重新枚举后按同一序号取段（删除任一条都只影响其后段落的偏移与序号，按序号
 *    重新取恰好绕开偏移失效，且 applyEditPlan 还有原文复核兜底）；
 *  · **源码真源是文件**（vault.read），不是 `view.editor` —— 阅读模式下 editor 是幽灵
 *    实例、不跟随写盘，拿它现算会出现「删了但列表原样回来」（见 sourceOf 注释）；
 *  · anchor 编码源码区间 `md:<contentStart>:<contentEnd>`，供宿主跳转（宿主有
 *    renderer.sections / CM6 坐标，能从偏移定位到渲染节或编辑器行）；
 *  · 不支持书签 / 评论 / 页码（书签区恒空、评论按钮由 isCommentEnabled=false 藏掉、
 *    页码胶囊在 getPageForAnchor 返回 null 时自动隐藏），不留死按钮。
 */

import { MarkdownView, Notice, type App } from "obsidian";
import { collectHighlights } from "../core/mdSelectionMap";
import { applyEditPlan } from "../core/mdHighlightWrite";
import type { AnnotationFileData, StoredHighlight } from "../core/annotationStore";

/** anchor 前缀；后接 `:内容起:内容止`（内容坐标，已跳过开 `==` 与颜色 emoji）。 */
const ANCHOR_PREFIX = "md:";

export interface MdAnnotationDeps {
	app: App
	view(): MarkdownView | null
	/** 跳转到源码偏移所在位置（宿主掌握渲染节 / CM6 两套定位坐标）。 */
	jumpTo(sourceOffset: number, textHint: string): void
	/** 删除成功后回调：宿主据此重算并重绘打开着的标注列表。 */
	onChanged?: () => void
}

export class MdAnnotationAdapter {
	constructor(private readonly deps: MdAnnotationDeps) {}

	/** 最新一次**权威源码**及其所属路径（真源是文件，不是编辑器 —— 见 sourceOf 注释）。
	 *  由 `refresh()`（读盘）或 `onDeleteHighlight` 成功后（自算）写入；换文件 / 外部
	 *  改动后必须重新 refresh，否则会拿上一份文件的源码给当前文件枚举。 */
	private srcCache: { path: string; src: string } | null = null;

	/** 对外（mdOverlay.jumpToHighlight）的权威源码快照：缓存命中当前文件才给，
	 *  否则 null —— 绝不回退幽灵编辑器（见 sourceOf 注释：阅读模式下它不跟随写盘，
	 *  拿它换算行号就是「标注列表点高亮跳转会偏」的根因）。调用方拿 null 自行走
	 *  DOM 文本兜底。 */
	sourceSnapshot(): string | null {
		const path = this.deps.view()?.file?.path ?? "";
		return this.srcCache && this.srcCache.path === path ? this.srcCache.src : null;
	}

	/** 同步读当前源码：只在**缓存还没建立**时兜底用（见 sourceOf）；失败回 null。
	 *  ⚠️ 阅读模式下 `view.editor` 是幽灵实例，它的值**不等价**于文件内容，不能当真源。 */
	private readSourceSync(view: MarkdownView): string | null {
		const ed = (view as unknown as { editor?: { getValue?: () => string } }).editor;
		if (ed && typeof ed.getValue === "function") {
			try {
				return ed.getValue();
			} catch { /* 落到读盘 */ }
		}
		return null;
	}

	/** 取当前该认的源码：**文件优先**。
	 *
	 *  ⚠️ 为什么不能只信 `view.editor.getValue()`（2026-10-12 修「点删除没反应」）：
	 *  真机**阅读模式**下 `view.editor` 是一个隐藏的 CM6 实例（幽灵编辑器），对它写入
	 *  既不刷新预览也不落盘（见 `mdHighlightWrite` 的 channel 注释）—— 它同样**不跟随**
	 *  外部写盘。于是「列表按 editor 现算」+「删除按文件通道写」成了两个真源：删除明明
	 *  成功、正文预览也刷新了，列表却按幽灵编辑器的旧内容重算回原样，用户眼里就是
	 *  「按钮点了没反应」（顺带：阅读模式下刚划的新高亮也进不了列表）。
	 *  真源统一为**文件**：有缓存用缓存，没缓存（首帧）才退回编辑器同步值。 */
	private sourceOf(view: MarkdownView): string | null {
		const path = view.file?.path ?? "";
		if (this.srcCache && this.srcCache.path === path) return this.srcCache.src;
		// 缓存尚未建立（面板第一次打开、refresh 的读盘还没回来）：编辑器同步值兜底
		// （source 模式下它就是权威），拿不到就给 null——不猜内容。
		return this.readSourceSync(view);
	}

	/** 刷新权威源码：从**文件**读一次。打开标注页 / 切页 / 外部改动 / 删除后刷新前都要
	 *  先跑它，面板那一帧才拿得到盘上的最新内容（读盘是异步的，故单独成方法）。 */
	async refresh(): Promise<void> {
		const view = this.deps.view();
		const file = view?.file;
		if (!file) {
			this.srcCache = null;
			return;
		}
		try {
			this.srcCache = { path: file.path, src: await this.deps.app.vault.read(file) };
		} catch {
			// 读不到（文件被删 / 正在写）就保留旧缓存，比清空列表更接近用户所见。
		}
	}

	/** 现算标注数据（面板打开 / 切到标注页 / 删除后刷新都会调）。无文件时返回空表。 */
	data(): AnnotationFileData {
		const view = this.deps.view();
		if (!view?.file) return { highlights: [], bookmarks: [] };
		const src = this.sourceOf(view);
		if (src == null) return { highlights: [], bookmarks: [] };
		const spans = collectHighlights(src);
		const highlights: StoredHighlight[] = spans.map((sp, i) => ({
			id: i + 1,
			color: sp.color,
			anchor: `${ANCHOR_PREFIX}${sp.contentStart}:${sp.contentEnd}`,
			text: sp.plain,
		}));
		return { highlights, bookmarks: [] };
	}

	/** 评论能力位：md 官方高亮没有旁车评论落点。 */
	commentEnabled(): boolean {
		return false;
	}

	onJump(anchor: string, textHint?: string): void {
		const offset = parseAnchor(anchor);
		if (offset == null) return;
		this.deps.jumpTo(offset, textHint ?? "");
	}

	onPreview(): void {
		// 桌面悬停预览（hover-link）依赖旁车笔记块锚点，md 侧没有；单击直接跳转已够用。
	}

	onComment(): void {
		// 评论按钮已隐藏（commentEnabled=false），不会被调到。
	}

	/** 复制引用：Obsidian 块引用形态 `> 原文` + 笔记链接（无章节标题，只带来源）。 */
	onCopyReference(item: StoredHighlight): void {
		const view = this.deps.view();
		const link = view?.file ? `\n\n— [[${view.file.basename}]]` : "";
		const quoted = item.text.split(/\r?\n/).map(l => `> ${l}`).join("\n");
		const content = `${quoted}${link}`;
		void navigator.clipboard?.writeText(content).then(
			() => new Notice("已复制引用"),
			() => new Notice("复制失败"),
		);
	}

	/** 删除高亮 = 去掉那对 `==`（含颜色 emoji），正文原样保留。
	 *  返回是否成功写入（供宿主决定是否刷新列表 / 提示）。
	 *  ⚠️ 通道选择与划词写入（mdSelection）严格同口径：source 走 editor（可撤销），
	 *  preview 必须强制 vault —— 真机上预览视图的 view.editor 是隐藏 CM6 实例，对它
	 *  replaceRange 既不刷新预览也不落盘（见 applyEditPlan 的 channel 注释）。 */
	async onDeleteHighlight(id: number): Promise<boolean> {
		const view = this.deps.view();
		if (!view?.file) return false;
		const isSource = (() => {
			try { return view.getMode?.() === "source"; } catch { return false; }
		})();
		let src: string | null = isSource ? this.readSourceSync(view) : null;
		let channel: "auto" | "vault" = isSource ? "auto" : "vault";
		if (src == null) {
			// preview 恒走读盘（与 vault.process 复核同一内容）；source editor 取不到也兜底读盘。
			try {
				src = await this.deps.app.vault.read(view.file);
			} catch {
				return false;
			}
			channel = "vault";
		}
		const spans = collectHighlights(src);
		const sp = spans[id - 1];
		if (!sp) return false;
		const body = src.slice(sp.contentStart, sp.contentEnd);
		// 区间是整个 `==...==`（含首尾标记），替换成裸正文即「去高亮」。
		const plan = { from: sp.openStart, to: sp.closeEnd, replacement: body };
		const expected = src.slice(plan.from, plan.to);
		const res = await applyEditPlan(this.deps.app, view, plan, expected, channel);
		if (!res.ok) {
			new Notice("删除失败（笔记可能已被改动）");
			return false;
		}
		// 写入成功 → 把**自算出的新源码**钉进缓存，再让宿主重绘。
		// 为什么不在此处重新 `vault.read`：编辑通道（source 模式）的改动到 vault 有一道
		// debounce，立刻读盘读到的还是旧内容 —— 列表会「删了又回来」。自算值与两条通道
		// 的写入结果逐字一致，且下一次 refresh() 会用盘上真值覆盖它。
		this.srcCache = {
			path: view.file.path,
			src: src.slice(0, plan.from) + plan.replacement + src.slice(plan.to),
		};
		this.deps.onChanged?.();
		return true;
	}

	onDeleteBookmark(): void {
		// 无书签，不会被调到。
	}

	onRenameBookmark(): void {
		// 无书签，不会被调到。
	}

	getPageForAnchor(): null {
		return null;
	}
}

/** `md:123:456` → 123（内容起始源码偏移）；非法返回 null。 */
function parseAnchor(anchor: string): number | null {
	if (!anchor.startsWith(ANCHOR_PREFIX)) return null;
	const rest = anchor.slice(ANCHOR_PREFIX.length);
	const m = /^(\d+):\d+$/.exec(rest);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}
