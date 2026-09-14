/**
 * 相邻界面快照 —— 专为「插件在 App 里出现后，**别的界面**（最典型：官方文件列表）
 * 渲染异常」这类故障取证。
 *
 * ## 为什么需要它
 *
 * 这类故障的现场**不在插件自己的 DOM 里**：插件的元素全都正常，坏的是 Obsidian 自己的
 * 视图。而真机（尤其移动端）没有 devtools，只靠"用户描述"永远定不了案 —— 到底是
 *   ① 列表根本没渲染（DOM 里没有条目 = 数据/索引侧），
 *   ② 条目在 DOM 里但被样式压没（display/opacity/height = CSS 侧），
 *   还是 ③ 条目正常、只是合成层被拖累（几何正常、肉眼闪烁 = 合成/性能侧）？
 * 这三条指向完全不同的修法。本模块把判据**一次拍全**，导出后由开发者读盘区分。
 *
 * ## 采集口径的三条约束
 *
 * 1. **只读，不写**：不点开抽屉、不改任何类、不触发折叠/展开（否则快照本身会改变现场，
 *    与 `.workbuddy` 预览页「拍到的永远是健康的病人」是同一类坑）。
 * 2. **不依赖"我猜到的那一个选择器"**：官方不同版本/不同端（手机抽屉 vs 平板侧栏）
 *    的容器类名会漂移，所以按**多组候选选择器**扫，并把命中的容器一并记下来；
 *    条目选择器同理（`.nav-file` / `.nav-folder` / `.tree-item` 全记计数）。
 * 3. **不包含大字段**：字体/样式表只记「数量 + family 名 + style 标签 id」，绝不把
 *    @font-face 的 src（可能是 20MB 级 blob/data）写进报告。
 */
import { Platform } from "obsidian";

/** 文件浏览器的容器候选（覆盖手机抽屉与平板/桌面侧栏两种形态） */
const EXPLORER_ROOTS = [
	'[data-type="file-explorer"]',
	".workspace-drawer .nav-files-container",
	".nav-files-container",
];

function styleOf(el: Element | null): Record<string, string> {
	if (!el) return {};
	const cs = getComputedStyle(el as HTMLElement);
	return {
		display: cs.display,
		visibility: cs.visibility,
		opacity: cs.opacity,
		height: cs.height,
		transform: cs.transform,
		overflow: cs.overflow,
		contentVisibility: cs.contentVisibility,
	};
}

function rectOf(el: Element | null): Record<string, number> | null {
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

/** 取一个元素的「第一个条目」样本：DOM 里有条目却看不见时，它的计算样式就是铁证。
 *  `sel` 由调用方给 —— **文件夹与文件必须分开采样**：用户原话的形态正是
 *  「文件夹还在、里面的（文件）不显示」，只看「第一个条目」会正好采到文件夹而漏掉它。 */
function firstItemSample(root: Element | null, sel: string): Record<string, unknown> {
	if (!root) return {};
	const item =
		root.querySelector(sel) ??
		root.querySelector(".nav-file-title, .nav-folder-title");
	if (!item) return { found: false };
	const title = item.querySelector(".nav-file-title, .nav-folder-title") ?? item;
	return {
		found: true,
		cls: String((item as HTMLElement).className || "").slice(0, 120),
		titleText: (title.textContent ?? "").trim().slice(0, 40),
		rect: rectOf(item),
		style: styleOf(item),
		titleStyle: styleOf(title),
	};
}

export function collectNeighborFacts(rootEl: HTMLElement | null): Record<string, unknown> {
	const doc = document;
	const out: Record<string, unknown> = {};

	try {
		out.platform = {
			isPhone: Platform.isPhone === true,
			isTablet: Platform.isTablet === true,
			isMobile: Platform.isMobile === true,
			isIosApp: Platform.isIosApp === true,
			isAndroidApp: Platform.isAndroidApp === true,
			w: window.innerWidth,
			h: window.innerHeight,
			dpr: window.devicePixelRatio,
			hoverNone: matchMedia("(hover: none)").matches,
			pointerCoarse: matchMedia("(pointer: coarse)").matches,
		};
		out.bodyClasses = String(doc.body.className || "");
		out.docHasReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

		// 宿主文档里的 <style>（插件会往 <head> 补 @font-face；**扫描整篇文档**而不是只扫
		// <head> —— 样式元素允许出现在 body 里，只扫 head 会漏）。只记 id/字节数/规则数，
		// 绝不记内容：@font-face 的 src 可能是 20MB 级的 blob/data。
		out.styles = [...doc.querySelectorAll("style")].map(el => {
			let rules = -1;
			try { rules = (el as HTMLStyleElement).sheet?.cssRules?.length ?? -1 } catch { rules = -1 }
			return { id: el.id || null, bytes: (el.textContent ?? "").length, rules };
		});

		// 宿主字体集：插件会把自定义字体注册进 document.fonts（含 20MB 级 CJK 字库）
		try {
			const families: string[] = [];
			doc.fonts.forEach(f => { if (f.family) families.push(f.family) });
			out.hostFonts = { count: doc.fonts.size, families: [...new Set(families)].slice(0, 12) };
		} catch { /* ignore */ }

		// 插件自己的视图（与相邻界面同时采样，便于对照）
		try {
			out.ownView = rootEl
				? {
					cls: String(rootEl.className || "").slice(0, 160),
					rect: rectOf(rootEl),
					frames: rootEl.querySelectorAll("iframe").length,
					style: styleOf(rootEl),
				}
				: { present: false };
		} catch { /* ignore */ }

		// 相邻界面：文件浏览器（多种容器候选，逐个采样）
		const roots: Record<string, unknown>[] = [];
		for (const sel of EXPLORER_ROOTS) {
			let nodes: Element[] = [];
			try { nodes = [...doc.querySelectorAll(sel)] } catch { continue }
			if (!nodes.length) continue;
			roots.push({
				selector: sel,
				count: nodes.length,
				samples: nodes.slice(0, 2).map(n => ({
					cls: String((n as HTMLElement).className || "").slice(0, 160),
					rect: rectOf(n),
					style: styleOf(n),
					scroll: {
						scrollHeight: (n as HTMLElement).scrollHeight,
						clientHeight: (n as HTMLElement).clientHeight,
						scrollTop: Math.round((n as HTMLElement).scrollTop),
					},
					// 三类条目计数分开记：」有数据但没渲染」与「渲染了但被压没」要靠这个分
					items: {
						navFile: n.querySelectorAll(".nav-file").length,
						navFolder: n.querySelectorAll(".nav-folder").length,
						treeItem: n.querySelectorAll(".tree-item").length,
						navFileTitle: n.querySelectorAll(".nav-file-title").length,
					},
					// 文件/文件夹分开采（用户报的形态是「夹子在、文件不显示」）
						firstFolder: firstItemSample(n, ".nav-folder, .nav-folder-title"),
						firstFile: firstItemSample(n, ".nav-file, .nav-file-title"),
						firstAny: firstItemSample(n, ".nav-file, .nav-folder, .tree-item"),
				})),
			});
		}
		out.explorer = roots.length ? roots : { found: false };

		// 抽屉/侧栏的显隐状态（手机端文件列表在抽屉里，这一行能区分「抽屉没开」）
		out.drawers = [...doc.querySelectorAll(".workspace-drawer")].slice(0, 3).map(d => ({
			cls: String((d as HTMLElement).className || "").slice(0, 160),
			rect: rectOf(d),
			style: styleOf(d),
		}));
	} catch (e) {
		out.error = String(e);
	}
	return out;
}
