/** Obsidian 宿主能力与主题探测。
 *
 *  两件事：
 *
 *  ① **版本闸门**：官方彩色高亮（`==🔴文字==` 的 emoji 语法）是 Obsidian **1.14** 才有的。
 *     低于该版本写 emoji 不会静默降级 —— 会**裸露成文字**（🔴 直接躺在正文里）。所以
 *     「写不写 emoji」必须由运行时探测决定，且**故意不提供用户开关**（开关只会制造
 *     「手滑打开 → 旧版正文被污染」的事故面）。
 *
 *  ② **高亮色板探测**：官方 1.13+ 的彩色高亮从调色板变量派生（`color-mix(in oklch,
 *     var(--color-red) 20%, transparent)`，见 Obsidian 开发者文档 Foundations/Colors.md），
 *     所以「跟随主题」= 把这些变量读出来用，而不是抄一份固定色值。书页在 iframe 里、
 *     CSS 变量不跨文档继承，故必须在**宿主文档**读成字面量再交给渲染层。
 *
 *  本模块**不依赖 engineAdapter**（后者 import 本模块），探针自己实现。 */

import * as obsidianModule from "obsidian";
import { HIGHLIGHT_COLORS, HIGHLIGHT_THEME_VARS, HIGHLIGHT_ALPHA, setHighlightPalette } from "../types";

/** 与 engineAdapter 的 COLOR_PROBE_CSS 同款：离屏、不可见、不拦事件。 */
const COLOR_PROBE_CSS = "position:absolute;visibility:hidden;pointer-events:none";

/** ---------- 版本闸门 ---------- */

/** 解析形如 `"1.12.4"` 的版本串（允许缺补丁号）；失败返回 null。 */
export function parseVersion(v: unknown): [number, number, number] | null {
	if (typeof v !== "string") return null;
	const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** 运行时 API 版本串；拿不到返回 ""。
 *
 *  **用 `Reflect.get` 而不是 `mod.apiVersion`**：esbuild 对命名空间导入的属性访问会做静态
 *  分析，探针的 obsidian 替身（薄 stub）里没有这个导出时会报
 *  `[import-is-undefined] will always be undefined` 并把它折叠掉 —— 噪声之外更糟的是
 *  「看起来这条路径在测试里永远是 false」。`Reflect.get` 是动态访问，拿不到就自然 undefined。
 *  （生产构建把 obsidian 列为 external，两种写法都能拿到真值；这里只是让探针链路干净。） */
function readApiVersion(): string {
	try {
		const v = Reflect.get(obsidianModule as object, "apiVersion");
		return typeof v === "string" ? v : "";
	} catch {
		return "";
	}
}

/** 版本串是否支持官方彩色高亮。**纯函数**，便于回归（`supportsColorHighlight` 是它的环境包装）。 */
export function versionSupportsColorHighlight(v: unknown): boolean {
	const p = parseVersion(v);
	if (!p) return false;
	return p[0] > 1 || (p[0] === 1 && p[1] >= 14);
}

/** 当前 Obsidian 是否支持官方彩色高亮（`==🔴文字==`）。取不到版本一律 false。 */
export function supportsColorHighlight(): boolean {
	return versionSupportsColorHighlight(readApiVersion());
}

/** ---------- 主题色板探测 ---------- */

/** 读一个 CSS 自定义属性经浏览器解析后的颜色串（任何颜色格式都会被归一成 rgb()/rgba()）。 */
function readComputedColor(name: string, forceTheme: "light" | "dark" | null): string {
	try {
		const probe = document.createElement("div");
		if (forceTheme) probe.className = forceTheme === "dark" ? "theme-dark" : "theme-light";
		probe.style.cssText = COLOR_PROBE_CSS;
		probe.style.backgroundColor = `var(${name})`;
		document.body.appendChild(probe);
		const c = getComputedStyle(probe).backgroundColor.trim();
		probe.remove();
		return c;
	} catch {
		return "";
	}
}

/** 把计算色归一成 **带 alpha 的 `rgba(r, g, b, a)`（a < 1）**；解析失败回退 fallback。
 *
 *  ⚠️ 出口**必须**是 a < 1 的 rgba：三处 UI 色点会做 `.replace(/[\d.]+\)$/, "1)")` 把半透明
 *  拨到不透明，若给不透明的 `rgb(r, g, b)`，正则会命中末尾蓝色分量（`rgb(233, 49, 71)`
 *  → `rgb(233, 49, 1)`），颜色彻底写坏。 */
function toTranslucentRgba(computed: string, fallback: string, alpha: number): string {
	const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(computed);
	if (!m) return fallback;
	const a = m[4] != null ? Number(m[4]) : 1;
	// 变量缺失时是透明 → 回退（与 engineAdapter.obsidianVarColor 同口径）
	if (a === 0) return fallback;
	// 本身半透明（如官方 --text-highlight-bg 的 0.4）→ 原样保留；不透明（--color-*）→ 套我们的 alpha
	const out = a >= 1 ? alpha : a;
	return `rgba(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${out})`;
}

/**
 * 探测宿主主题的高亮色板并写入 `types` 的全局色板（供 `highlightColorOf` 取用）。
 *
 * `forceTheme` 语义与 `engineAdapter.resolveActiveColors` 一致：null = 直接继承 body
 * （跟随 Obsidian 明暗）；"light"/"dark" = 阅读区强制了明暗、借用对应主题类取色。
 *
 * 返回探测结果（含回退项），便于调用方/测试观测。
 */
export function refreshHighlightPalette(forceTheme: "light" | "dark" | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of HIGHLIGHT_COLORS) {
		const varName = HIGHLIGHT_THEME_VARS[c.name];
		if (!varName) continue;
		out[c.name] = toTranslucentRgba(readComputedColor(varName, forceTheme), c.color, HIGHLIGHT_ALPHA);
	}
	setHighlightPalette(out);
	return out;
}
