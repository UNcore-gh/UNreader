import { isDebugEnabled } from "../core/debugLog";
/** 划词现场只在调试日志开启时留在有限内存中，供用户手动导出。 */
import { floatingBottomInset, keyboardBandCeiling, nativeBarOverlapTop, nativeBarTop, usableBottom, viewportFloor } from "./keyboardInset";

/** 关键祖先链：从工具条往外一直到 `body`，覆盖「谁给谁定高」的每一层 */
const ANCESTORS = [
	".unreader-md-root",
	".workspace-leaf-content",
	".workspace-leaf",
	".workspace-tab-container",
	".workspace-tabs",
	".workspace-split",
	".workspace",
	".horizontal-main-container",
	".app-container",
];

/** 正文候选链：`mdOverlay.selectionBounds()` 就是在这几个里挑可用区 */
const CANDIDATES = [
	".markdown-reading-view",
	".markdown-source-view",
	".cm-editor",
	".cm-scroller",
	".cm-content",
];

/** 屏幕底那两条原生栏（按官方类名逐个查，含 `.mobile-toolbar-spacer` —— 它是**流内**的，
 *  「宿主底边被顶上去 52px」这件事的直接证据就是它） */
const BARS = [".mobile-toolbar", ".mobile-toolbar-spacer", ".mobile-navbar"];

const MAX_RECORDS = 8;

export interface SelectionDiagRecord {
	/** 自增序号（判断「哪条是最后一次」） */
	seq: number;
	/** 记录时间（epoch millis） */
	t: number;
	/** 触发来源：`avoid` = 避让复核跑完那一刻 */
	kind: string;
	[section: string]: unknown;
}

const records: SelectionDiagRecord[] = [];
let seq = 0;
let lastSig = "";
let lastSigAt = 0;

function r1(v: number): number {
	return Math.round(v * 10) / 10;
}

/** 实测矩形（视口坐标，保留 0.1px —— 让位量常常是 52/44 这种整数差，取整会看不出差） */
function rectOf(el: Element | null | undefined): Record<string, number> | null {
	if (!el) return null;
	try {
		const r = el.getBoundingClientRect();
		return {
			top: r1(r.top), bottom: r1(r.bottom), left: r1(r.left), right: r1(r.right),
			w: r1(r.width), h: r1(r.height),
		};
	} catch {
		return null;
	}
}

/** 关键计算样式（只取少数几条，避免把报告撑大） */
function styleOf(el: Element | null | undefined, props: string[]): Record<string, string> {
	if (!el) return {};
	try {
		const cs = getComputedStyle(el);
		const out: Record<string, string> = {};
		for (const p of props) out[p] = cs.getPropertyValue(p);
		return out;
	} catch {
		return {};
	}
}

const RECT_PROPS = ["position", "display", "visibility", "overflow", "z-index"];

/** 每个选择器一条：存在与否 + rect + 关键样式。**不存在也记**（那本身就是证据：
 *  例如真机上根本没有 `.horizontal-main-container`，说明我们照抄的结构过期了）。 */
function sectionFor(doc: Document, selectors: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const sel of selectors) {
		let el: HTMLElement | null = null;
		try {
			el = doc.querySelector<HTMLElement>(sel);
		} catch {
			out[sel] = { error: "bad selector" };
			continue;
		}
		out[sel] = el
			? { found: true, rect: rectOf(el), style: styleOf(el, RECT_PROPS) }
			: { found: false };
	}
	return out;
}

/** 命中链：`elementFromPoint` 返回的是谁，往上数 4 层。用来直接读出「采样点上站着的
 *  到底是不是官方那条栏」—— 比任何推算都硬。 */
function hitChain(doc: Document, x: number, y: number): string {
	try {
		let el: Element | null = doc.elementFromPoint(x, y);
		const parts: string[] = [];
		let depth = 0;
		while (el && depth < 4) {
			const cls = String((el as HTMLElement).className || "")
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 4)
				.join(".");
			parts.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${el.id ? "#" + el.id : ""}`);
			el = el.parentElement;
			depth++;
		}
		return parts.join(" < ") || "(null)";
	} catch {
		return "(err)";
	}
}

function pxVar(doc: Document, name: string): string {
	try {
		const el = doc.body ?? doc.documentElement;
		if (!el) return "";
		return (getComputedStyle(el).getPropertyValue(name) || "").trim();
	} catch {
		return "";
	}
}

/** 原生栏原始状态：逐个记「在不在 / rect / 关键样式 / 内联 transform」。
 *
 *  `.mobile-toolbar` 的位置还会被官方 `animateToKeyboardHeight()` 用内联 `translateY`
 *  动画补一次位移 ⇒ 内联 transform 必须记，否则 rect 与 `top` 算出来的对不上时无从解释。
 *
 *  **两个取证入口共用这一份**（「最终落点仍相交」与「划词后工具条压根没出现」）：
 *  原生栏的在场与否是两者的共因，口径必须逐字一致，否则两份报告没法互相对照。 */
function collectBars(doc: Document): Record<string, unknown> {
	const bars: Record<string, unknown> = {};
	for (const sel of BARS) {
		const el = doc.querySelector<HTMLElement>(sel);
		bars[sel] = el
			? {
				found: true,
				rect: rectOf(el),
				style: styleOf(el, ["position", "display", "visibility", "opacity", "z-index", "height"]),
				inlineTransform: el.style.transform || "",
				inlineTop: el.style.top || "",
			}
			: { found: false };
	}
	return bars;
}

/** 各路「可用区」信号。`usableBottom` 的取值是历次修复的核心假设，必须原样记下来，
 *  好让开发者核对「模型算出来的 limit」与「原生栏实测 rect」到底谁对。 */
function collectSignals(doc: Document, host: HTMLElement | null): Record<string, unknown> {
	const vv = doc.defaultView?.visualViewport;
	return {
		kbdVar: pxVar(doc, "--keyboard-height"),
		mtbHeightVar: pxVar(doc, "--mobile-toolbar-height"),
		mtbHeightVarTouchL: pxVar(doc, "--touch-size-l"),
		innerHeight: doc.defaultView?.innerHeight ?? -1,
		innerWidth: doc.defaultView?.innerWidth ?? -1,
		clientHeight: doc.documentElement?.clientHeight ?? -1,
		scrollY: doc.defaultView?.scrollY ?? -1,
		docElScrollTop: doc.documentElement?.scrollTop ?? -1,
		visualViewport: vv ? { height: r1(vv.height), offsetTop: r1(vv.offsetTop), scale: vv.scale } : null,
		bodyClasses: String(doc.body?.className || ""),
		htmlClasses: String(doc.documentElement?.className || ""),
		activeElement: (() => {
			const a = doc.activeElement as HTMLElement | null;
			return a ? `${a.tagName.toLowerCase()}.${String(a.className || "").slice(0, 60)}` : "(none)";
		})(),
		usableBottom: host ? r1(usableBottom(host)) : null,
		floatingBottomInset: host ? r1(floatingBottomInset(host)) : null,
		// 「与实现无关」的两条客观底线（2026-10-12 用户报「工具条上边框与输入法上边框对齐」
		// 后补）：模型算出来的 limit 对不对，靠这两条来判 —— 它们不读任何官方变量、
		// 也不做任何推断，输入法 / 视口收缩都会把它们顶上去。
		//   · viewportFloor = 「还在屏幕上吗」的底线（布局视口 / 可视视口取最小）；
		//   · keyboardBandCeiling = 「键盘带」的上沿（布局视口 − 键盘变量 − 官方栏高）。
		viewportFloor: (() => { const v = viewportFloor(doc); return v == null ? null : r1(v); })(),
		keyboardBandCeiling: (() => { const v = keyboardBandCeiling(doc); return v == null ? null : r1(v); })(),
		nativeBarTop: (() => {
			const v = nativeBarTop(doc);
			return v == null ? null : r1(v);
		})(),
	};
}

/**
 * 记一条现场快照。**在「工具条落到最终位置」那一刻调**（`avoidOcclusion` 的 finally）。
 *
 * @param kind 触发来源（目前只有 `avoid`）
 * @param containerEl 划词工具条容器
 * @param avoid 避让复核的结果（`hit`/`rect`/`cap`/`rounds`），用来分辨「是几何模型算错」
 *              还是「两条遮挡判据都是瞎的」
 */
export function recordSelectionDiag(
	kind: string,
	containerEl: HTMLElement,
	avoid?: Record<string, unknown>,
): void {
	if (!isDebugEnabled()) return;
	try {
		const doc = containerEl.ownerDocument ?? document;

		// —— 便宜指纹先做去重：拖动选词时本函数每 ~120ms 被调一次，位置没变就不必再采一遍。
		const sig = `${kind}|${containerEl.style.top}|${containerEl.style.left}|${containerEl.offsetWidth}x${containerEl.offsetHeight}`;
		const now = Date.now();
		if (sig === lastSig && now - lastSigAt < 1000) return;

		const host = doc.querySelector<HTMLElement>(".unreader-md-root");
		const tRect = containerEl.getBoundingClientRect();
		const cx = tRect.left + tRect.width / 2;

		const rec: SelectionDiagRecord = { seq: ++seq, t: now, kind };

		rec.host = host
			? { rect: rectOf(host), style: styleOf(host, ["position", "top", "left", "width", "height", "z-index", "pointer-events"]) }
			: { found: false };

		rec.toolbar = {
			rect: rectOf(containerEl),
			inlineTop: containerEl.style.top,
			inlineLeft: containerEl.style.left,
			offsetW: containerEl.offsetWidth,
			offsetH: containerEl.offsetHeight,
			style: styleOf(containerEl, RECT_PROPS),
		};

		rec.ancestors = sectionFor(doc, ANCESTORS);
		rec.candidates = sectionFor(doc, CANDIDATES);

		// 原生栏与可用区信号：与「工具条压根没出现」那条取证通道共用同一份实现
		// （见 collectBars / collectSignals —— 共因必须同一口径，两份报告才能互相印证）
		rec.bars = collectBars(doc);
		rec.signals = collectSignals(doc, host);

		// 避让复核的结果：`hit` = 命中测试（实现相关）、`rect` = 原生栏实测相交（实现无关）。
		// 若两个都是 null 而用户仍看到重叠 ⇒ 两条判据在真机上**同时**瞎了，问题在取样口径。
		rec.avoid = avoid ?? null;

		// 采样点：底边内侧 6px（`occlusionCeiling` 的第一条线）+ 垂直中点。
		// 还有「正对着原生栏顶边往上一像素」这个点 —— 它最能说明工具条是不是刚好骑在栏边线上。
		rec.hits = {
			bottomInset6: hitChain(doc, cx, tRect.bottom - 6),
			middle: hitChain(doc, cx, tRect.top + tRect.height / 2),
			justAboveOwnBottom: hitChain(doc, cx, tRect.bottom - 1),
		};

		// ★ 决定性信号：**最终落点**上，工具条与「当前可见的原生栏」是否仍相交。
		// 这是「用户看到的重叠」与「我们以为算对了」之间的唯一判据 ——
		// 不看模型、不看命中测试，只看两条带在不在同一片像素上。
		// 相交表示这一帧可能是故障现场。
		const overlapTop = nativeBarOverlapTop(tRect, doc);
		rec.stillOverlapping = overlapTop != null;
		rec.overlapTop = overlapTop == null ? null : r1(overlapTop);
		// 重叠了多少像素：栏顶边到工具条底边。> 0 才叫「被压住一截」。
		rec.overlapPx = overlapTop == null ? null : r1(tRect.bottom - overlapTop);

		// ⚠️ **不受判据门控**的兜底信号：`.mobile-toolbar` 是否真的在 DOM 且没被 display:none。
		//
		// 为什么必须独立再算一次：`stillOverlapping` 走的是 `nativeBarOverlapTop` →
		// `visibleNativeBars`，那里除了 rect 还过一遍 computed style（display / visibility /
		// opacity 与 `top > 0`）。**真机键盘动画期间**那条栏完全可能 `opacity:0` 淡入
		// 或 `top` 短暂 ≤0 —— 于是判据 ② 判它「不可见」⇒ `stillOverlapping` 恒 false
		// ⇒ 常规判据可能遗漏这次故障。
		// 这里只问「元素在不在 + display 是不是 none」，与产品那两套判据**不共享任何门控**。
		const rawBar = doc.querySelector<HTMLElement>(".mobile-toolbar");
		const rawBarPresent = !!rawBar && (() => {
			try {
				return getComputedStyle(rawBar).display !== "none";
			} catch {
				return false;
			}
		})();
		const rawBarTop = rawBar ? r1(rawBar.getBoundingClientRect().top) : null;
		rec.rawBarPresent = rawBarPresent;
		rec.rawBarTop = rawBarTop;

		records.push(rec);
		while (records.length > MAX_RECORDS) records.shift();
		lastSig = sig;
		lastSigAt = now;

		// 故障标记取两条信号的并集，供手动导出的报告分析。
		//   · `stillOverlapping`：判据 ② 认定相交（我们**确信**重叠）。
		//   · 无门控兜底：栏确实在场（非 display:none）且工具条底边越过栏顶边
		//     （判据 ② 可能因 opacity/瞬态 top 而漏判，但几何关系客观存在）。
		// 并集保证「判据瞎了也能取证」—— 反正写出去的是**原始几何**，开发者自己会判。
		const failure = overlapTop != null
			|| (rawBarPresent && rawBarTop != null && tRect.bottom > rawBarTop);
		rec.failure = failure;

	} catch {
		/* 取证绝不能弄垮插件 */
	}
}

/** 读快照（拷贝，调用方可安全序列化）。**最新一条在数组末尾**。 */
export function readSelectionDiag(): SelectionDiagRecord[] {
	return records.slice();
}

/** 清空（测试用；生产只在需要重置现场时调）。 */
export function clearSelectionDiag(): void {
	records.length = 0;
	seq = 0;
	lastSig = "";
	lastSigAt = 0;
}

/** 元素的「标签.类名#id」描述串（最多 4 个类名） */
function describeEl(el: Element): string {
	const cls = String((el as HTMLElement).className || "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4)
		.join(".");
	return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${el.id ? "#" + el.id : ""}`;
}

/** 节点的祖先链描述（最多 4 层）——「选区端点落在哪一层」是「正文容器判据没命中」
 *  最直接的证据：真机上如果选区落在 `.cm-content` 之外（例如官方换了编辑器骨架、
 *  或者选区是原生 selection handle 造出来的临时节点），这一行会立刻显示出来。
 *  `mdSelection.capture` 也用它给每次采集带上端点位置（两条口径同一份实现）。 */
export function nodeChain(node: Node | null): string {
	try {
		let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
		const parts: string[] = [];
		let depth = 0;
		while (el && depth < 4) {
			parts.push(describeEl(el));
			el = el.parentElement;
			depth++;
		}
		return parts.join(" < ") || "(none)";
	} catch {
		return "(err)";
	}
}

/**
 * 「选中了文字，我们的划词工具条**却压根没出现**」的**上游自述取证**。
 *
 * ## 为什么必须补这一条通道（2026-10-12 真机报障）
 *
 * `recordSelectionDiag`（上面那条）记录工具条落到最终位置时的现场。
 * 用户报的是**上游故障**：`「现在 obsidian 原生工具栏不出现了，但是即便如此，那个选中
 * 文字工具栏还是没有出现」` —— 工具条根本不出现时，那条通道**永不触发**，
 * 复现再多次也是空手而归。
 *
 * 于是这里从 `capture()` 的**每一步早退**与「采集跑完但工具条最终不可见」的裁决里取数：
 *  · 划词事件到底有没有调到采集（`reason` 里区分「压根没进来」与「进来了但早退」）；
 *  · 早退卡在哪一条判据（视图形态 / 选区为空 / 落在自家浮层 / **正文容器没命中**）；
 *  · 那一刻工具条容器自己的显隐与几何（`display` / `visibility` / `opacity` / 尺寸）
 *    —— 「显示了但看不见」与「压根没显示」指向完全不同的修法；
 *  · `NativeChromeGate.debugState()` 的闸门注册表 —— 闸门是**全局** patch，任一 owner
 *    判据恒真都会让官方快速编辑栏在所有视图里消失，这张表能直接指认是谁。
 *
 * 沿用与 `recordSelectionDiag` 相同的三条约束：**只读、不假设选择器、低开销**。
 * 两条通道均受调试开关控制，记录只保存在有限内存中，由用户手动导出。
 */
export interface CaptureDiagInput {
	/** 早退原因 / 裁决结论（调用点见 `mdSelection.capture` 的 `narrate()`） */
	reason: string;
	/** 视图形态：`preview` / `source` / `unknown` */
	mode: string;
	attached: boolean;
	viewOk: boolean;
	hostFound: boolean;
	/** 宿主 document 的选区数（`getSelection().rangeCount`） */
	rangeCount: number;
	/** 选中文字长度（去首尾空白后） */
	selLength: number;
	selCollapsed: boolean | null;
	/** 本形态认的正文容器选择器（`source` → `.cm-content`，`preview` → `.markdown-reading-view`） */
	scopeSelector: string | null;
	scopeFound: boolean;
	scopeContainsAnchor: boolean;
	/** 本视图里同名容器的**份数**（2026-10-13 加：真机实测一个 leaf 里 `.cm-content` 有多份）。
	 *  `-1` = 该字段缺席（旧记录）。 */
	scopeCandidates?: number;
	/** 这些副本里**真的装住锚点**的有几份；`-1` = 缺席。0 份 = 容器归属/结构已变。 */
	scopeContaining?: number;
	/** 最终挑了哪一路：`contains` / `visible` / `nearest` / `naive` / `none`（见 `resolveScope`） */
	scopePick?: string | null;
	/** 选区是否落在我们自己的叠加根里（命中的话采集会主动放弃） */
	inOwnHost: boolean;
	/** 闸门注册表快照：`NativeChromeGate.debugState()` */
	gate?: unknown;
	/** 划词工具条容器（可能为 null） */
	containerEl?: HTMLElement | null;
	/** 从 `capture()` 带出来的其它关键事实 */
	facts?: Record<string, unknown>;
}

export function recordCaptureDiag(input: CaptureDiagInput): void {
	if (!isDebugEnabled()) return;
	try {
		const containerEl = input.containerEl ?? null;
		const doc = containerEl?.ownerDocument ?? document;
		const host = doc.querySelector<HTMLElement>(".unreader-md-root");
		const now = Date.now();

		const rec: SelectionDiagRecord = { seq: ++seq, t: now, kind: "capture" };
		rec.reason = input.reason;
		rec.capture = {
			mode: input.mode,
			attached: input.attached,
			viewOk: input.viewOk,
			hostFound: input.hostFound,
			rangeCount: input.rangeCount,
			selLength: input.selLength,
			selCollapsed: input.selCollapsed,
			scopeSelector: input.scopeSelector,
			scopeFound: input.scopeFound,
			scopeContainsAnchor: input.scopeContainsAnchor,
			scopeCandidates: input.scopeCandidates ?? -1,
			scopeContaining: input.scopeContaining ?? -1,
			scopePick: input.scopePick ?? null,
			inOwnHost: input.inOwnHost,
			// 选区端点的祖先链：scope 判据没命中时，这一行直接说明它落在哪
			anchorChain: input.facts?.anchorChain ?? null,
			...(input.facts ?? {}),
		};
		rec.gate = input.gate ?? null;

		rec.host = host
			? { rect: rectOf(host), style: styleOf(host, ["position", "top", "left", "width", "height", "z-index", "pointer-events"]) }
			: { found: false };

		// 「显示了但看不见」与「压根没显示」必须能分开：这里把容器自己的三条显隐样式、
		// 两个状态类与实测几何一起记下 —— 只记 rect 会被 `visibility:hidden` 骗过。
		rec.toolbar = containerEl
			? {
				rect: rectOf(containerEl),
				inlineTop: containerEl.style.top,
				inlineLeft: containerEl.style.left,
				offsetW: containerEl.offsetWidth,
				offsetH: containerEl.offsetHeight,
				style: styleOf(containerEl, ["position", "display", "visibility", "opacity", "z-index", "pointer-events", "contain"]),
				hasIsVisible: containerEl.hasClass("is-visible"),
				hasIsMeasuring: containerEl.hasClass("is-measuring"),
				inDocument: !!containerEl.parentElement,
				parentChain: nodeChain(containerEl.parentElement),
			}
			: { found: false };

		rec.candidates = sectionFor(doc, CANDIDATES);
		rec.bars = collectBars(doc);
		rec.signals = collectSignals(doc, host);

		records.push(rec);
		while (records.length > MAX_RECORDS) records.shift();
		lastSig = "";
		lastSigAt = now;

	} catch {
		/* 取证绝不能弄垮插件 */
	}
}
