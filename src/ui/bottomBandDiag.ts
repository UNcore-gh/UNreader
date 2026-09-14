/** 手机端「屏幕最底那条窄带」的定向诊断（取数用，不参与任何功能）。
 *
 *  ## 它要回答的问题
 *
 *  用户报障（2026-09-14）：「手机最底部的元素可以隐藏掉，但**承载这些元素的白色背景板
 *  依然存在**」。两个已探明的事实：① 那条带**跟着主题变深**（浅色白、深色黑）→ 画它的
 *  是 app 内部某个用 `--background-primary` 的东西；② 与官方「悬浮导航」有关。
 *
 *  ## 为什么必须真机取数，不能靠读 CSS 推
 *
 *  这是本仓库用五轮修复换来的结论（见 AGENTS.md「桌面端页首背景板」段）：官方底栏区域
 *  至少有四个长得一模一样的候选家具 —— `.mobile-navbar` 自己的 `padding-bottom:
 *  var(--navbar-bottom-offset)`、`.mobile-toolbar-spacer`（整宽 + `--background-primary`）、
 *  `.view-content` 的 `padding-bottom: max(--safe-area-inset-bottom, --size-4-8)`、
 *  以及容器比窗口矮时露出的**下层**。它们都是「主题色、贴底」，读 CSS 只能得到
 *  「四个都像」，而修法互不相同。
 *
 *  ## 两条硬要求（第一版踩过的坑）
 *
 *  1. **每条日志 ≤ `debugLog.MAX_MSG`（2000 字符）**：第一版把整份快照塞成一条，
 *     结果被截断在 2000 字符处，「哪几个元素叠在底带上」这几行**正好被切掉**——
 *     取了个寂寞。现在逐条写（`logBottomBandFacts`），单条远小于上限。
 *  2. **不能只用 `elementsFromPoint`**：它按**命中测试**返回，会跳过
 *     `pointer-events: none` 的元素 —— 而阅读区容器正是 `pointer-events: none`
 *     （点按要落到书页 frame 上）。第一版因此在底带上只测到 `.app-container` 就断了。
 *     现在两条都记：`elementsFromPoint`（谁能被点到）+ **绘制覆盖扫描**
 *     （谁在底部 100px 内画了底/阴影/边框，按 DOM 顺序列全）。
 *
 *  ## 输出
 *
 *  `[nav-bottom] …` 抬头 + 若干条事实，进调试日志（设置 → 诊断 → 保存日志到库根，
 *  随库同步回桌面端即可直接读盘）。关闭调试日志时**零成本**：调用点先判
 *  `isDebugEnabled`，里面的 DOM 读取一次都不会发生。 */

import * as debugLog from "../core/debugLog";

/** 一次性安全区探针（量 safe-area-inset-bottom）：固定样式提常量，满足官方 lint。 */
const SAFE_AREA_PROBE_CSS = "position:fixed;left:-9999px;top:0;width:0;height:var(--safe-area-inset-bottom, 0px)";

/** 与「底部带」有关的候选元素（selector，用于逐个量几何/底色） */
const CANDIDATES: ReadonlyArray<readonly [string, string]> = [
	[".app-container", "app 容器（官方）"],
	[".mobile-navbar", "底栏（官方）"],
	[".mobile-toolbar", "工具条（官方）"],
	[".mobile-toolbar-spacer", "工具条占位（官方）"],
	[".workspace", "工作区"],
	[".workspace-leaf-content", "叶子"],
	[".view-content", "本视图内容盒"],
	[".view-header", "页首"],
	[".unreader-root", "阅读区根"],
	[".unreader-body", "阅读区主体"],
	[".unreader-stage", "阅读区舞台"],
	[".unreader-continuous", "连续滚动容器"],
];

/** 在视口最底那一段的纵向取几个采样点（距底 px），问「这个点上谁可被点到」 */
const PROBE_FROM_BOTTOM = [4, 20, 40] as const;

function round(n: number): number {
	return Math.round(n * 10) / 10;
}

function tagOf(el: Element): string {
	const cls = (el as HTMLElement).className;
	const c = typeof cls === "string" && cls.trim()
		? "." + cls.trim().split(/\s+/).slice(0, 4).join(".")
		: "";
	return el.tagName.toLowerCase() + c;
}

/** 读一个元素的关键几何与底色（够定位即可，不追求全量） */
function describeEl(el: Element): string {
	try {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return `${tagOf(el)} → rect=[t ${round(r.top)} b ${round(r.bottom)} h ${round(r.height)} w ${round(r.width)}]`
			+ ` bg=${cs.backgroundColor} pos=${cs.position} z=${cs.zIndex}`
			+ ` pad=[t ${cs.paddingTop} b ${cs.paddingBottom}] mar=[t ${cs.marginTop} b ${cs.marginBottom}]`
			+ ` op=${cs.opacity} vis=${cs.visibility} pe=${cs.pointerEvents}`
			+ (cs.transform !== "none" ? ` tf=${cs.transform.slice(0, 60)}` : "");
	} catch (e) {
		return `(读取失败: ${String(e).slice(0, 40)})`;
	}
}

/** 绘制覆盖扫描：在**最底 100px** 内画了背景/阴影/底边框的元素，按 DOM 顺序列出来。
 *  这是唯一能抓到「pointer-events:none 的阅读区容器」的手法（见文件头第 2 条）。 */
function paintCandidates(vh: number, max = 10): string[] {
	const out: string[] = [];
	try {
		const nodes = document.querySelectorAll<HTMLElement>(".app-container, .app-container *");
		for (const el of Array.from(nodes)) {
			if (out.length >= max) break;
			let r: DOMRect;
			let cs: CSSStyleDeclaration;
			try {
				r = el.getBoundingClientRect();
				if (r.height < 1 || r.width < 1) continue;
				// 只关心「伸进最底 100px」的元素
				if (r.bottom <= vh - 100 || r.top >= vh) continue;
				cs = getComputedStyle(el);
			} catch { continue; }
			const bg = cs.backgroundColor;
			const hasBg = !!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
			// box-shadow / 底边框也算「画了东西」（浮起的底栏就是靠阴影形成那条带的观感）
			const shadow = cs.boxShadow;
			const hasShadow = !!shadow && shadow !== "none";
			const hasBorder = cs.borderBottomWidth !== "0px" && cs.borderBottomStyle !== "none";
			const hasBlur = cs.backdropFilter && cs.backdropFilter !== "none";
			if (!hasBg && !hasShadow && !hasBorder && !hasBlur) continue;
			out.push(
				`${tagOf(el)} [t ${round(r.top)} b ${round(r.bottom)} h ${round(r.height)} w ${round(r.width)} z=${cs.zIndex} pos=${cs.position}]`
				+ (hasBg ? ` bg=${bg}` : "")
				+ (hasBlur ? ` blur=${cs.backdropFilter}` : "")
				+ (hasShadow ? ` shadow=${shadow.slice(0, 48)}` : "")
				+ (hasBorder ? ` borderB=${cs.borderBottomWidth} ${cs.borderBottomColor}` : ""),
			);
		}
	} catch { /* ignore */ }
	return out;
}

/** 视口/容器层面的环境事实（含 `--keyboard-height` 这类「可能是别人留下的」变量）。 */
function envFacts(): string[] {
	const out: string[] = [];
	try {
		const vv = window.visualViewport;
		out.push(
			`视口 inner=${window.innerWidth}×${window.innerHeight}`
			+ (vv ? ` visual=${round(vv.width)}×${round(vv.height)} offsetTop=${round(vv.offsetTop)}` : " visual=(无)")
			+ ` dpr=${window.devicePixelRatio}`,
		);
		out.push(`body 类 = ${document.body.className}`);
		const cs = getComputedStyle(document.documentElement);
		const kbd = cs.getPropertyValue("--keyboard-height").trim();
		out.push(`--keyboard-height = ${kbd || "(未定义 → 按 0 算)"}`);
		// 安全区：官方把 safe-area-inset 消费进 padding，自定义属性本身是未解析 token 流，
		// 所以用一次性探针元素**量成 px**（同 engineAdapter.spacingPx 的手法）
		try {
			const probe = document.createElement("div");
			probe.style.cssText = SAFE_AREA_PROBE_CSS;
			document.body.appendChild(probe);
			const h = probe.getBoundingClientRect().height;
			probe.remove();
			out.push(`--safe-area-inset-bottom ≈ ${round(h)}px`);
		} catch { /* 探针失败不影响其余取数 */ }
	} catch { /* ignore */ }
	return out;
}

/** 采集一次底部带的事实（每条一个字符串，**逐条**进日志以免被 2000 字符上限截断） */
export function collectBottomBandFacts(): string[] {
	const lines: string[] = [];
	try {
		lines.push(...envFacts());
		const vh = window.innerHeight;
		for (const [sel, label] of CANDIDATES) {
			try {
				const el = document.querySelector(sel);
				lines.push(`${label} ${sel}: ${el ? describeEl(el) : "(不在 DOM)"}`);
			} catch { /* ignore */ }
		}
		const paint = paintCandidates(vh);
		lines.push(`── 最底 100px 内画了背景/阴影/边框的元素（共 ${paint.length} 个，DOM 序）`);
		lines.push(...paint.map((s, i) => `  ${i + 1}. ${s}`));
		const x = Math.round(window.innerWidth / 2);
		for (const dy of PROBE_FROM_BOTTOM) {
			const y = Math.max(1, vh - dy);
			try {
				const hits = document.elementsFromPoint(x, y).slice(0, 4);
				lines.push(`── (${x}, ${y}) 距底 ${dy}px 处**可被点到**的: ${hits.map(tagOf).join(" > ") || "(无)"}`);
			} catch { /* ignore */ }
		}
	} catch (e) {
		lines.push(`(采集失败: ${String(e).slice(0, 80)})`);
	}
	return lines;
}

/** 已排队的延迟采集（同一次翻转里重复调用只留一条；视图关闭时由调用点 clear）。 */
let pending: number | null = null;
/** 本次视图里的采样次数上限：沉浸态下滑/上滑会来回翻转，没有上限时一次复现
 *  就能刷出几十份几乎相同的快照，把日志里真正有用的那几行淹掉。 */
const MAX_SAMPLES = 4;
let samples = 0;

/** 排一次采集：官方底栏的显隐过渡是 `transform 0.3s + opacity 0.2s`，
 *  立刻采会量到动画半路的几何（当年桌面端就是这么量出「假绿」的），所以延后到
 *  过渡结束再采 —— 那时**用户在屏幕上看到的就是这一帧**。 */
export function scheduleBottomBandDiag(why: string): void {
	if (!debugLog.isDebugEnabled()) return;
	if (samples >= MAX_SAMPLES) return;
	if (pending !== null) window.clearTimeout(pending);
	pending = window.setTimeout(() => {
		pending = null;
		if (samples >= MAX_SAMPLES) return;
		samples++;
		logBottomBandFacts(why);
	}, 460);
}

/** 写日志：**抬头一行 + 每条事实一行**（单条远小于 MAX_MSG，不会被截断） */
function logBottomBandFacts(why: string): void {
	try {
		debugLog.info(`[nav-bottom] ${why}`);
		for (const line of collectBottomBandFacts()) debugLog.info(`[nav-bottom] ${line}`);
	} catch { /* 诊断绝不弄垮阅读器 */ }
}

/** 视图关闭时取消未落地的采集（避免迟到的一次写入污染下一个视图的日志）
 *  并复位采样计数（下次开书重新计）。 */
export function cancelBottomBandDiag(): void {
	if (pending !== null) {
		window.clearTimeout(pending);
		pending = null;
	}
	samples = 0;
}
