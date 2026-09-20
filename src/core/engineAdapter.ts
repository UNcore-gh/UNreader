// 必须在 foliate 模块前求值：插件重载时其 customElements.define 会重复注册抛错
import "./foliateGuard";
import "../../vendor/foliate-js/view.js";
// 格式支持模块：动态格式分派时 view.js 通过 magic 字节加载；
// 静态引入确保 bundle 已注册对应 class 并避免 foliate 动态 import 报错
// 注意：**不要**静态引入 vendor/foliate-js/pdf.js —— PDF 已整体移除，静态引入会把
// pdf.js（约 400KB）连同其文本层样式打进 bundle，且 pdf.js 顶层曾在 CJS 下用
// import.meta.url 求值导致插件加载崩溃（历史事故）。view.js 对它的引用是
// esbuild `external` 的动态 import，运行期不会触达（插件不再允许打开 PDF）。
import "../../vendor/foliate-js/mobi.js";
import "../../vendor/foliate-js/fixed-layout.js";
import { Overlayer } from "../../vendor/foliate-js/overlayer.js";
import * as CFI from "../../vendor/foliate-js/epubcfi.js";
import { FootnoteHandler } from "../../vendor/foliate-js/footnotes.js";
import { searchMatcher } from "../../vendor/foliate-js/search.js";
import { textWalker } from "../../vendor/foliate-js/text-walker.js";
import { Platform } from "obsidian";
import type { AppearanceSettings, WebDeviceMode } from "../types";
import { highlightColorOf, activeBackground, activeTextColor, activeTheme, activeBackgroundImage } from "../types";
import { perfBegin, perfEnd, perfPoint } from "./perf";
import { idleYield, nextPaint } from "./idle";
import { info as debugInfo, warn as debugWarn } from "./debugLog";
import { isTxtFile, makeTxtBook } from "./txtBook";
import { hasCoreModal, focusModalPrimary } from "./modalFocusGate";
import { OBSIDIAN_IFRAME_DOM_COMPAT_JS } from "./iframeDomCompat";
import { isResourceEnabled, resolveResourceReference } from "./resourceStore";
import { openExternalLink } from "./externalLink";

/* —— 一次性测量探针/引擎宿主层的固定样式：官方 lint 禁止 `el.style.x = "字面量"`，
   统一收敛成模块常量后按变量赋值（值与注入时机逐字节不变，只是不再触发规则）。 —— */
const SPACING_PROBE_CSS = "position:absolute;visibility:hidden;pointer-events:none;margin-top:var(--p-spacing, 1rem)";
const COLOR_PROBE_CSS = "position:absolute;visibility:hidden;pointer-events:none";
const DISPLAY_BLOCK = "block";
const DISPLAY_NONE = "none";
const SCROLL_BEHAVIOR_AUTO = "auto";
const OVERFLOW_HIDDEN = "hidden";
/** 章节 frame 的基础样式。宽度走 `--ur-frame-w` 变量（默认 100% = 跟随阅读区）：
 *  设备模式只需覆盖这一个变量，摘档时删掉它就自动回到 100% —— 不必在代码里
 *  再写一份 `100%` 字面量，也就不会有「两处宽度各改一半」的经典走样。 */
const CONT_FRAME_BASE_CSS = "width:var(--ur-frame-w,100%);border:0;display:block;min-height:60vh;background:transparent;overflow:hidden;pointer-events:none;";
/** 设备模式覆盖 frame 宽度的变量名（见 CONT_FRAME_BASE_CSS / applyWebDevice）。 */
const FRAME_WIDTH_VAR = "--ur-frame-w";
const COLOR_SCHEME_NORMAL = "normal";
const FRAME_MIN_HEIGHT_CLEARED = "0";
/** 网页设备模式的**布局视口宽度**（CSS px）—— 模拟「以这台设备打开这个网页」。
 *  `auto` 不在此表：它的语义是「不给固定视口，跟随阅读区宽度」（老口径）。 */
const WEB_DEVICE_WIDTH: Record<Exclude<WebDeviceMode, "auto">, number> = { phone: 390, tablet: 834, desktop: 1280 };
const POINTER_EVENTS_AUTO = "auto";
const LAYER_SHELL_CSS = "position:fixed;inset:0;z-index:-1;pointer-events:none;";

/** 把主题的 `--p-spacing` **量成 px**（自定义属性读出来是未解析 token 流，如 `"1rem"`，
 *  直接 parseFloat 会把它当成 1 —— 见 resolveAppearance 里段落间距那一段）。
 *  读不到时退回 16px（= Obsidian 的默认值）。探针只用一帧、随即移除。 */
function spacingPx(): number {
	try {
		const probe = createDiv();
		probe.style.cssText = SPACING_PROBE_CSS;
		document.body.appendChild(probe);
		const px = parseFloat(window.getComputedStyle(probe).marginTop);
		probe.remove();
		return Number.isFinite(px) && px >= 0 ? px : 16;
	} catch {
		return 16;
	}
}

export interface TocItem {
	label?: string;
	href?: string;
	subitems?: TocItem[];
	id?: number;
}

export interface BookMetadata {
	title: string
	author: string
	language: string
}

export interface ResolvedAppearance extends AppearanceSettings {
	fontFamily: string
	fontSize: number
	lineHeight: number
	letterSpacing: number
	paragraphSpacing: number
	/** 段首缩进字符数（em，随各元素自身字号缩放） */
	paragraphIndent: number
	marginLeft: number
	marginRight: number
	backgroundColor: string
	textColor: string
	darkBackgroundColor: string
	darkTextColor: string
	/** 自定义字体 @font-face 规则（注入主题 CSS，供 iframe 内使用 blob: 字体） */
	customFontRules?: string
}

/** 自定义字体注册表：plugin 扫描字体文件夹后注入，供 resolveAppearance 生成
 *  @font-face 规则并把自定义字体 id 解析为对应 family 名。
 *  src 由 main 的字体扫描注入为 blob URL，避免大体量字体以 base64 重复膨胀每章 CSS。 */
const customFontRegistry = new Map<string, { label: string; src: string; format: string }>()

/** 阅读器**当前正在使用**的自定义字体 id 集合。由 applyAppearance 写入（那是
 *  「引擎已切到这套外观」的唯一权威信号）。
 *
 *  `null` = 尚未应用过外观 → 保守不过滤（全量输出，等同改动前行为，避免任何
 *  调用顺序意外导致字体静默失效）；空 Set = 外观未用自定义字体。
 *
 *  为什么要过滤：一个外观同一时刻只引用一个 `fontFamily`，而此前
 *  `customFontRulesCss()` / `registerCustomFontsIn()` 无差别处理注册表里的
 *  **全部**字体——每渲染一章都要把 N 个 CJK 字体各自 `new FontFace` + `load()`
 *  一遍（实测 3 字体 ≈200ms/帧，占开书期字体开销的绝大部分），实际只用到 1 个。
 *
 *  ⚠️ 为什么**不能**改由 resolveAppearance 写入：外观面板会用草稿态
 *  `this.current` 调用 resolveAppearance（appearancePanel.buildFontSelect 回显），
 *  若那时写全局，面板开着时新加载的章节会按草稿字体注册，与正文实际渲染的字体
 *  不一致。applyAppearance 只在外观真正落地时调用，语义干净。 */
let activeFontIds: Set<string> | null = null

/** 声明阅读器正在使用的自定义字体 id（applyAppearance 调用）。 */
export function setActiveFontIds(ids: Set<string> | null): void {
	activeFontIds = ids
}

/** 按当前使用中的字体过滤列表。未应用过外观时不过滤（见 activeFontIds 注释）。 */
function filterActiveFonts<T extends { id: string }>(list: T[]): T[] {
	if (!activeFontIds) return list
	return list.filter(f => activeFontIds!.has(f.id))
}

/** 由插件注入自定义字体（id → blob URL + 格式）。调用前应确保旧 URL 已回收。 */
export function setCustomFonts(fonts: { id: string; label: string; src: string; format: string }[]): void {
	// 回收旧 blob URL —— **只回收新注册表里不再出现的那些**。
	// 不能无条件全量 revoke：main 的 fontBlobCache 会跨轮复用同一个 blob URL（按
	// mtime+size 命中缓存），而这里收到的新列表里那些「沿用旧 URL」的项一旦被
	// revoke，就变成已被回收的地址 —— 此后 @font-face / FontFace 全部加载失败、
	// 字体静默回落到系统字体，且缓存里存的还是那个死 URL，不会自愈。
	// 真正该回收的 URL（字体被删/不再被引用）由 main 侧的缓存清理负责 revoke。
	const keep = new Set(fonts.map(f => f.src));
	for (const f of customFontRegistry.values()) {
		if (f.src.startsWith("blob:") && !keep.has(f.src)) {
			try { URL.revokeObjectURL(f.src) } catch { /* ignore */ }
		}
	}
	customFontRegistry.clear()
	for (const f of fonts) customFontRegistry.set(f.id, { label: f.label, src: f.src, format: f.format })
}

/** 生成 @font-face 规则。`ids` = 本次外观实际引用的字体 id（null = 不过滤）。
 *  只输出被引用的字体：一个外观同一时刻只用一个 family，其余规则纯属噪音。 */
export function customFontRulesCss(ids: Set<string> | null): string {
	let out = ""
	for (const [id, f] of customFontRegistry) {
		if (ids && !ids.has(id)) continue
		// src 为空 = 该字体本轮没有建 blob（未被引用时的惰性登记）。**必须跳过**：
		// 否则会输出 src:url("") 的 @font-face —— 浏览器把 family 名注册成一个
		// 永远加载不出来的空面，比「没有这条规则」更糟（同 ensureHostCustomFont 的守卫）。
		if (!f.src) continue
		const name = f.label.replace(/[\\"]/g, "")
		out += `@font-face{font-family:"${name}";src:url("${f.src}") format("${f.format}");font-display:swap;}\n`
	}
	return out
}

/** 释放全部自定义字体 blob URL（插件卸载/重载时调用，防泄漏） */
export function clearCustomFonts(): void {
	for (const f of customFontRegistry.values()) {
		if (f.src.startsWith("blob:")) { try { URL.revokeObjectURL(f.src) } catch { /* ignore */ } }
	}
	customFontRegistry.clear()
}

/** 自定义字体清单（供 wireFrame 用 FontFace API 注册进每个 frame 文档）。
 *  只返回当前外观实际引用的字体，避免逐帧重复构建用不到的字体。 */
export function customFontEntries(): { id: string; name: string; src: string; format: string }[] {
	const all: { id: string; name: string; src: string; format: string }[] = []
	for (const [id, f] of customFontRegistry) {
		// src 为空 = 本轮没建 blob 的惰性登记项：不能进这个清单，
		// 否则逐帧会 `new FontFace(name, 'url("")')` —— 一个注定失败的假注册。
		if (!f.src) continue
		all.push({ id, name: f.label.replace(/[\\"]/g, ""), src: f.src, format: f.format })
	}
	return filterActiveFonts(all)
}

/** 宿主文档里已注册成功的自定义字体（id → `family|src` 签名）。 */
const hostFontSigs = new Map<string, string>()
/** 正在 load() 中的签名（字体解码是异步的，期间重入会重复解析几 MB 字体二进制）。 */
const hostFontPending = new Set<string>()

/**
 * 把某个自定义字体注册进**宿主文档**（宿主 = 高亮/书签侧边栏所在的文档）。
 *
 * 为什么必须有这一步：章节正文在各章 iframe 里渲染，`@font-face` 与 FontFace
 * 只注册进了**那些 frame 的文档**；而标注侧边栏挂在宿主文档上，它请求的 family 名
 * （如 "思源宋体"）在宿主里从未定义 → 静默回退默认字体。表现为
 * 「侧边栏字体与正文不一致」——只在自定义字体下出现，跟随 Obsidian 系统字体时
 * 两侧同源、看不出差异。
 *
 * 只处理当前外观引用的那一个；按 `family|src` 签名去重（换字号/边距/配色都会
 * 触发外观刷新重入本函数），src 变化（重扫字体文件夹、blob URL 重建）才重注册。
 * 同族旧面先摘除：旧 blob 已 revoke 的 face 留在集合里会持续被选中 → 字体静默失效。
 */
export function ensureHostCustomFont(id: string | null | undefined): void {
	if (!id) return
	const f = customFontRegistry.get(id)
	if (!f) return
	// src 为空 = 该字体本轮没有建 blob（未被任何外观/预设引用，见 main.referencedFontIds）。
	// 此时绝不能往下走：会注入 `url("")` 的 @font-face —— 静默失效的假注册。
	if (!f.src) return
	const family = f.label.replace(/[\\"]/g, "")
	const sig = `${family}|${f.src}`
	if (hostFontSigs.get(id) === sig || hostFontPending.has(sig)) return
	hostFontPending.add(sig)
	const src = f.src.startsWith("blob:") ? `url(${f.src})` : `url("${f.src}")`
	// 摘掉同族旧面（上一次注册、blob 已回收的那一个）
	try {
		const stale: FontFace[] = []
		document.fonts.forEach(face => {
			if (face.family.replace(/["']/g, "") === family) stale.push(face)
		})
		for (const face of stale) { try { document.fonts.delete(face) } catch { /* ignore */ } }
	} catch { /* ignore */ }
	try {
		const face = new FontFace(family, src, { display: "swap" })
		void face.load().then(() => {
			hostFontPending.delete(sig)
			try {
				document.fonts.add(face)
				hostFontSigs.set(id, sig)
			} catch { /* ignore */ }
		}).catch(() => { hostFontPending.delete(sig) })
	} catch { hostFontPending.delete(sig) }
	// （曾有「宿主 <style> 补 @font-face」的旧内核兜底 —— 官方 lint 禁止运行时
	//   创建 style 元素，已移除；FontFace API 在桌面 Electron / iOS / Android
	//   全部可用，兜底从未在现代内核上生效。）
}

/** 自定义字体 id → family 名（带引号，避免含空格的文件名插入 CSS 后被拆词）。
 *  仅支持自定义字体；其余（含历史遗留的内置字体 id）一律返回空 → 跟随 Obsidian 系统字体。 */
function resolveFontFamily(id: string): string {
	const c = customFontRegistry.get(id)
	if (c) return `"${c.label.replace(/[\\"]/g, "")}"`
	return ""
}

export function resolveAppearance(a: AppearanceSettings): ResolvedAppearance {
	const style = getComputedStyle(document.body);
	const num = (v: string, fb: number) => {
		const n = Number.parseFloat(v);
		return Number.isFinite(n) ? n : fb;
	};
	// 配色来源：obsidian 模式把主题变量解析成具体色值（iframe 内不继承宿主的
	// CSS 变量，必须落到字面量）；自定义模式沿用用户色值
	const { bg, fg } = resolveActiveColors(a)
	// 本次外观引用的自定义字体 id（只用于生成本次的 @font-face；不影响全局
	// activeFontIds —— 那个只由 applyAppearance 声明，见其注释）。
	// 注意判据是「id 存在」而非「解析成功」：注册表尚未填充时 @font-face 也生成
	// 不出来（遍历注册表），两者天然一致；main.refreshCustomFonts 完成后会
	// refreshAppearance() 重新走一遍本函数。
	// 停用的资源不参与解析，即使它仍是当前配置值；删除后的悬空引用也走同一降级路径。
	const ruleIds = new Set<string>()
	const fontId = isResourceEnabled(a.fontFamily) ? a.fontFamily : null
	const customFamily = (fontId && resolveFontFamily(fontId)) || ""
	if (fontId) ruleIds.add(fontId)
	return {
		fontFamily: customFamily || v_themeFont(style),
		fontSize: a.fontSize ?? num(style.getPropertyValue("--font-text-size"), 16),
		lineHeight: a.lineHeight ?? num(style.getPropertyValue("--line-height-normal"), 1.5),
		letterSpacing: a.letterSpacing ?? 0,
		// **段落间距（em）：`null` = 跟随主题的 `--p-spacing`**（types.ts 的契约）。
		// 坑：`getPropertyValue("--p-spacing")` 返回的是**未解析的 token 流**（实测就是
		// `"1rem"`），老写法 `num("1rem")` 得到 1、再除以字号 16 → **0.0625em** ——
		// 于是「点段间距那行的『恢复默认』」把段落间距从 1em 打到 0.06em（≈1px，肉眼即 0），
		// 而面板显示与落地都是 0.06em：一致，但**不是默认值**（默认 1em）。
		// 正确做法是先把自定义属性**量成 px**（挂个探针读 computed margin），再除以字号；
		// 这样 rem / em / px / calc 全都能算对，结果 = 16px/16px = 1em = DEFAULT_APPEARANCE。
		paragraphSpacing: a.paragraphSpacing ?? (spacingPx() / Math.max(1, num(style.getPropertyValue("--font-text-size"), 16))),
		paragraphIndent: Math.max(0, a.paragraphIndent ?? 2),
		marginLeft: a.marginLeft ?? 48,
		marginRight: a.marginRight ?? 48,
		theme: a.theme ?? "light",
		backgroundColor: bg,
		textColor: fg,
		darkBackgroundColor: (a).darkBackgroundColor ?? "#1e1e1e",
		darkTextColor: (a).darkTextColor ?? "#d4d4d4",
		backgroundImage: resolveResourceReference(activeBackgroundImage(a)),
		imageBlur: (a).imageBlur ?? 0,
		glassEnabled: !!(a).glassEnabled,
		glassBlur: (a).glassBlur ?? 12,
		glassOpacity: (a).glassOpacity ?? 0.55,
		customFontRules: customFontRulesCss(ruleIds),
	} as unknown as ResolvedAppearance;
}

/** 阅读区实际生效的背景/文字色：obsidian 模式解析主题变量，
 *  custom 模式用用户色值。宿主 UI（rootEl/stage 底色）与 iframe 主题共用，
 *  保证阅读区与 Obsidian 界面底色一致。 */
export function resolveActiveColors(a: AppearanceSettings): { bg: string; fg: string } {
	if (a.colorMode !== "custom") {
		// theme 为 auto 时变量直接继承 body（天然跟随明暗）；强制浅/深时借用对应
		// 主题类取变量，保证「强制浅色 + Obsidian 深色」等组合仍取到正确的调色板
		const forceTheme = a.theme === "auto" ? null : activeTheme(a)
		return {
			bg: obsidianVarColor("--background-primary", forceTheme, activeBackground(a)),
			fg: obsidianVarColor("--text-normal", forceTheme, activeTextColor(a)),
		}
	}
	return { bg: activeBackground(a), fg: activeTextColor(a) }
}

/** 读取 Obsidian 主题变量并解析为 #rrggbb 字面量；解析失败回退 fallback。
 *  forceTheme 非空时给探针挂对应主题类（Obsidian 的变量定义在 .theme-* 作用域），
 *  用于「阅读主题强制浅/深而 Obsidian 相反」的组合。 */
function obsidianVarColor(name: string, forceTheme: "light" | "dark" | null, fallback: string): string {
	try {
		const probe = createDiv();
		if (forceTheme) probe.className = forceTheme === "dark" ? "theme-dark" : "theme-light";
		probe.style.cssText = COLOR_PROBE_CSS;
		probe.style.backgroundColor = `var(${name})`;
		document.body.appendChild(probe);
		const c = getComputedStyle(probe).backgroundColor.trim();
		probe.remove();
		const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(c);
		if (!m) return fallback;
		// 变量缺失时透明 → 回退
		if (m[4] != null && Number(m[4]) === 0) return fallback;
		const hex = (v: string) => Math.max(0, Math.min(255, parseInt(v))).toString(16).padStart(2, "0");
		return `#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`;
	} catch {
		return fallback;
	}
}

function v_themeFont(style: CSSStyleDeclaration): string {
	return (
		style.getPropertyValue("--font-text").trim() ||
		`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
	);
}

export interface RelocateInfo {
	cfi: string
	fraction: number
	/** 当前章节内部进度 0-1（连续滚动=视口顶边章内占比 localTop，按归属窗口归一，
	 *  100% 与切章对齐；翻页/原生滚动=foliate fraction） */
	sectionFraction: number
	tocId: number | null
	sectionLabel: string
	locCurrent: number | null
	locTotal: number | null
}

/** 连续滚动模式：章节进度条填充值 0-1（纯函数，便于单测/回归）。
 *
 * 章节**归属**（切章）判定用视口中心：中心越过章尾才切走，即
 * `scrollTop = sectionTop + h - viewportHeight/2`。而进度锚点用视口**顶边**
 * （顶边=当前正读到的行，章首贴屏幕顶 = 0%，比中心锚更符合阅读直觉）。
 * 两者口径不同：若进度直接除以章高 h，切章那一刻只走到 `(h - vh/2) / h`
 * （章高 ≈ 2 屏时正好 **3/4**）就归零——表现为「进度条走不满就跳下一章」。
 *
 * 故按「本章归属窗口」归一，保证切章那一刻恰好 100%：
 *  · 章高 > 半屏：起点 = 章首贴屏幕顶（0%），到切章点需滚 `h - vh/2`
 *  · 章高 ≤ 半屏：章首永远到不了屏幕顶（归属窗口整体落在章首之前），改用整段
 *    窗口映射（窗口起点 0% → 窗口终点 100%），否则这类短章进度恒为 0
 * 分母以 1 兜底防除零（零高占位章）。 */
export function sectionProgressFraction(
	scrollTop: number,
	sectionTop: number,
	sectionHeight: number,
	viewportHeight: number,
): number {
	const h = Math.max(1, sectionHeight)
	const halfView = viewportHeight / 2
	const tall = h > halfView
	const origin = tall ? sectionTop : sectionTop - halfView
	const span = Math.max(1, tall ? h - halfView : h)
	return Math.max(0, Math.min(1, (scrollTop - origin) / span))
}

/** 浮动目录条目：目录条目 + 从章节文档派生的补充条目（书源目录缺失时） */
export interface NavEntryModel {
	label: string
	/** 目录原始 href；派生条目为空串（走 sectionIndex 跳转） */
	href: string
	/** 真实目录 id；派生条目为 null（批注数/页码等按 id 索引的数据不适用） */
	id: number | null
	/** 高亮匹配键 = id ?? 合成负数 id（派生条目） */
	navKey: number | null
	depth: number
	/** 派生条目对应的章节 index；目录条目为 null（按 href 跳转） */
	sectionIndex: number | null
}

export interface EngineHandlers {
	onRelocate: (info: RelocateInfo) => void
	onSelection?: (info: { text: string; cfi: string | null; rect: DOMRect }) => void
	onLoadDoc: (doc: Document, index: number) => void
	onFootnoteRender: (view: RawFoliateView, href: string, anchor?: { x: number; y: number }) => void
	onInlineFootnote: (html: string, href: string, jump?: () => void, anchor?: { x: number; y: number }) => void
	onShowAnnotation: (cfi: string, range: Range | null) => void
	onFrameReady?: (doc: Document) => void
	/** iframe 内键盘全量上抛：复用 handleKey（命令热键执行 + 宿主转发 + 翻页） */
	onFrameKey?: (e: KeyboardEvent) => void
	/** iframe 内指针按下（触屏点正文）：宿主据此关闭浮动面板。
	 *  iframe 内 pointerdown 不会冒泡到宿主 document，桌面 hover 自动关在触屏不生效，
	 *  必须由引擎把 iframe 内点击桥接上来。 */
	onFrameTap?: () => void
	/** 连续滚动方向通知：scrollTop 变化时报告方向（"down"=下滑隐藏工具栏，
	 *  "up"=上滑唤出工具栏，与 Obsidian 移动端 markdown 阅读一致）。 */
	onScrollActivity?: (direction: "up" | "down") => void
	/** 沉浸模式点按：zone 为点击位置在视口中的横向比例（0~1）。
	 *  仅中间 1/3 被宿主采用（切换工具栏显隐）；点按不用于翻页。 */
	onTapZone?: (ratio: number) => void
	/** 派生目录标题（buildSectionNav 后台解析）完成后通知宿主增量刷新目录面板。
	 *  开书不再等待全书章节标题解析（首屏提速），此回调保证目录最终完整。 */
	onNavDerived?: () => void
	/** 连续模式 iframe 内识别到横向滑动（srcdoc 同源内识别后直接函数调用上来）。
	 *  宿主把它原样转发给 Obsidian 原生 swipe（workspace.trigger("swipe", info)），
	 *  即可完整复用原生跟手开合侧栏。返回是否被接收——未被接收时引擎立即放弃
	 *  本手势、放行默认滚动。 */
	onSwipe?: (info: FrameSwipeInfo) => boolean | void
}

/** 连续模式 iframe 内横向手势 → 宿主原生侧栏手势的桥接载荷。
 *  字段与 Obsidian 原生 `swipe` 事件同构（obsidian.asar 的 Rm 识别器产物），
 *  宿主只需补上 evt/targetEl 等无关键即可直接 trigger，无需另造手势协议。
 *
 *  **坐标系：全部是宿主视口坐标**（与原生 Rm 在宿主 document 上读到的一致）。
 *  iframe 局部的 clientX/clientY 已由桥加上 frame 元素的视口矩形左上角换算过来——
 *  原生订阅者（尤其抽屉的 `window.innerHeight - e.startY < safeAreaBottom` 闸）
 *  按宿主视口解释这些数，传 iframe 局部坐标会让闸恒真、整个手势被静默丢弃。 */
export interface FrameSwipeInfo {
	/** 起手点（touchstart 坐标，宿主视口坐标系） */
	startX: number
	startY: number
	/** 当前点（触发定轴的那一帧坐标，宿主视口坐标系） */
	x: number
	y: number
	/** 同步注册接收方回调：原生 WorkspaceDrawer 收到 swipe 事件时会立即调用它，
	 *  取回 move/cancel/finish 逐帧驱动侧栏。未被调用即视为「无人接收」。 */
	registerCallback: (cb: FrameSwipeCallback) => void
}

/** 原生手势回调协议（与 obsidian.asar 内 `e.registerCallback({move,cancel,finish})`
 *  完全一致，以便把原生抽屉实现直接当实现用） */
export interface FrameSwipeCallback {
	move: (x: number, y: number) => void
	cancel: () => void
	/** v = 位移 + 1000×速度（原生 touchend 的合成量，抽屉据此判定开/合阈值） */
	finish: (x: number, y: number, v: number) => void
}

interface FoliateRenderer extends HTMLElement {
	goTo(target: unknown): Promise<void>
	prev(distance?: number): Promise<void>
	next(distance?: number): Promise<void>
	setStyles(styles: string): void
	getContents(): { index: number; doc: Document }[]
}

/* paginated 模式已删除：跟手翻页阈值常量（DRAG_PAGE_RATIO/DRAG_FLING_VELOCITY）随整组移除 */

interface FoliateBook {
	metadata: Record<string, unknown>
	toc: TocItem[]
	sections?: { resolveHref?: (href: string) => unknown; id?: string }[]
}

/** 我们自己造的「合成 book」：TXT（core/txtBook.ts）、feed 文章
 *  （core/feedBookFactory.ts）、本地 HTML（core/htmlBook.ts）三者共用同一形状。
 *  对齐 vendor/foliate-js/fb2.js 的产物，`view.open()` 的三条鸭子判据（字符串 /
 *  有 `arrayBuffer` / `isDirectory`）一条都不命中 → 原样赋给 `view.book`，不走 makeBook。
 *  这里只声明 engineAdapter 真正读到的字段，别照抄成完整契约。 */
export interface SyntheticBook {
	readonly __unreaderTxt?: true
	readonly __unreaderFeed?: true
	/** 「网页原样」标记（本地 HTML 专属，见 core/htmlBook.ts 文件头）：
	 *  frame 样式换成零特异性兜底、宿主取消版心封顶。与 `__unreaderTxt` 正交 ——
	 *  后者只说「这是我们造的合成书」，本标记才说「按网页而不是按书排版」。 */
	readonly __unreaderWebLayout?: true
	metadata?: Record<string, unknown>
	toc?: TocItem[]
	sections?: {
		id?: number
		size?: number
		linear?: string
		cfi?: string
		load?: () => string | Promise<string>
		createDocument?: () => Document | Promise<Document>
	}[]
	resolveHref?: (href: string) => { index?: number } | null
	splitTOCHref?: (href: string) => unknown
	getTOCFragment?: (doc: Document, id: string) => Element | null
	isExternal?: (uri: string) => boolean
	destroy?: () => void
}

/** `view.open()` 的入参：文件本身，或我们造的合成书 */
export type BookOpenTarget = File | Blob | SyntheticBook

export interface RawFoliateView extends HTMLElement {
	book: FoliateBook
	renderer: FoliateRenderer
	history: {
		back(): void
		forward(): void
		canGoBack: boolean
		canGoForward: boolean
	}
	open(book: BookOpenTarget): Promise<void>
	init(opts: { lastLocation?: string; showTextStart?: boolean }): Promise<void>
	close(): void
	goTo(target: string | number | { fraction: number }): Promise<unknown>
	goToFraction(fraction: number): Promise<void>
	prev(distance?: number): Promise<void>
	next(distance?: number): Promise<void>
	addAnnotation(annotation: { value: string; color?: string }): Promise<unknown>
	deleteAnnotation(annotation: { value: string }): void
	getCFI(index: number, range: Range): string
	resolveCFI(cfi: string): { index: number }
}

/** foliate-js 的 view 用 `CustomEvent` 把 relayout / load / link 等事件推回来，但
 *  `detail` 在类型上是 `any` —— 直接解构就会连带把 70+ 处成员访问变成
 *  `no-unsafe-member-access`。这里统一收成 `unknown`，再按下面的接口逐字段
 *  做运行时判定：这些字段来自第三方视图，本来就可能缺，判定是**真需要**的，不是
 *  为了哄 lint。 */
/** 外链协议白名单：只有这些进系统默认应用/浏览器。 */
const EXTERNAL_URL_SCHEMES = /^(?:https?|ftp|mailto|tel):/i;

/** 把正文里 `<a href>` 的原始写法解成可交给系统的绝对 URL（解不出来返回 null）。
 *
 *  `href_` 是**属性原文**（foliate `#handleLinks` 只给这个），相对地址要靠锚点自己的
 *  `baseURI` 兜 —— Feed 文章的 `<base href="原文地址">` 正是这么让正文里的相对链接
 *  变成对外链接的。命中不了白名单（相对地址、`javascript:`、`obsidian://` 等）返回
 *  null，调用方**不接管**，把行为留给 foliate 自己。 */
function externalUrlOf(raw: unknown, anchor: unknown): string | null {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return null;
	const base = (anchor as HTMLElement | null)?.baseURI;
	let absolute = text;
	try {
		absolute = base ? new URL(text, base).href : new URL(text).href;
	} catch { /* 解不出来就用原文试白名单 */ }
	return EXTERNAL_URL_SCHEMES.test(absolute) ? absolute : null;
}

function foliateDetail<T extends object>(ev: Event): Partial<T> {
	const raw: unknown = (ev as CustomEvent<unknown>).detail
	if (raw === null || typeof raw !== "object") return {}
	return raw
}

/** `relocate`：当前位置。fraction/location 由 foliate 给，cfi 只有分页流给。 */
interface FoliateRelocateDetail {
	fraction?: unknown
	cfi?: unknown
	tocItem?: { id?: unknown; label?: unknown } | null
	location?: { current?: unknown; total?: unknown } | null
}
/** `load`：一帧文档挂好了（`doc` 是 iframe 内的 Document）。 */
interface FoliateLoadDetail {
	doc?: unknown
	index?: unknown
}
/** `draw-annotation`：foliate 要求宿主自己把标注画到覆盖层上。 */
interface FoliateDrawAnnotationDetail {
	draw?: ((overlayer: unknown, options?: { color?: unknown }) => void) | null
	annotation?: { color?: unknown } | null
}
/** `create-overlay`：某一帧的覆盖层新建好了。 */
interface FoliateCreateOverlayDetail {
	index?: unknown
}
/** `link`：正文里的链接被点了（脚注走这条）。 */
interface FoliateLinkDetail {
	a?: unknown
}
/** `external-link`：正文里点的是**外链**（`book.isExternal(href)` 为真）。
 *  foliate 收到 `preventDefault()` 就放弃自己那次 `globalThis.open(href_, "_blank")`。 */
interface FoliateExternalLinkDetail {
	a?: unknown
	href_?: unknown
}
/** `show-annotation`：视图要求把某条标注显示出来。 */
interface FoliateShowAnnotationDetail {
	value?: unknown
	range?: unknown
}
/** 脚注气泡渲染回执（FootnoteHandler 自带事件）。 */
interface FoliateFootnoteRenderDetail {
	view?: unknown
	href?: unknown
}

function localizeValue(value: unknown): string {
	if (!value) return ""
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map(localizeValue).filter(Boolean).join(", ")
	if (typeof value === "object") {
		const values = Object.values(value as Record<string, unknown>)
			.map(v => (typeof v === "string" ? v : ""))
			.filter(Boolean)
		return values.join(", ")
	}
	// 只字符串化原始类型：`String(object)` 会得到 "[object Object]"，对标签毫无意义
	// （上架规则 no-base-to-string）。
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
	return ""
}

/* ---------------- 行内注释（脚注/尾注/评注）正文隐藏 ---------------- */
// 对齐 Apple Books / Readest 的做法：章内 <aside epub:type="footnote"> 等注释正文
// 不直接渲染在正文流里（否则臃肿且混在正文中很怪），只保留上标编号，靠悬浮窗/点击展示；
// ⌘/Ctrl+点击跳转时通过 .unreader-note-reveal 临时显形目标注释。
// 属性选择器需要两种写法并存（参考 Readest #4438 教训）：
//  - XHTML 解析（分页模式 foliate 按 application/xhtml+xml 解析）：epub:type 是带命名空间的属性，
//    只能用 [epub|type~="..."]，且 @namespace 必须位于整张样式表最顶端（前面出现任何 style 规则会被静默丢弃）。
//  - HTML 解析（连续滚动 iframe 用 DOMParser text/html）：属性名是字面量 "epub:type"，
//    需要转义冒号的 [epub\:type~="..."] 形式。
const NOTE_HIDE_CSS = `@namespace epub "http://www.idpf.org/2007/ops";
aside[epub|type~="footnote"],aside[epub|type~="endnote"],aside[epub|type~="rearnote"],aside[epub|type~="note"],aside[epub|type~="annotation"],
aside[epub\\:type~="footnote"],aside[epub\\:type~="endnote"],aside[epub\\:type~="rearnote"],aside[epub\\:type~="note"],aside[epub\\:type~="annotation"],
aside[role~="doc-footnote"],aside[role~="doc-endnote"],.epubtype-footnote,.epub-footnote-item,
.duokan-footnote-content,.duokan-footnote-item{display:none!important}
.unreader-note-reveal{display:block!important;visibility:visible!important}
.unreader-note-flash{outline:2px solid rgba(245,197,24,0.9)!important;outline-offset:3px;background:rgba(245,197,24,0.18)!important;border-radius:4px}`

/** 注释弹窗（二级 foliate-view）内需要把被隐藏的注释体强制显示回来 */
const NOTE_REVEAL_CSS = `aside[epub|type~="footnote"],aside[epub|type~="endnote"],aside[epub|type~="rearnote"],aside[epub|type~="note"],aside[epub|type~="annotation"],
aside[epub\\:type~="footnote"],aside[epub\\:type~="endnote"],aside[epub\\:type~="rearnote"],aside[epub\\:type~="note"],aside[epub\\:type~="annotation"],
aside[role~="doc-footnote"],aside[role~="doc-endnote"],.epubtype-footnote,.epub-footnote-item,
.duokan-footnote-content,.duokan-footnote-item{display:block!important;margin:0}`

/** 注释宿主元素匹配串（frame 文档均为 HTML 解析，统一用字面属性转义形式） */
const NOTE_ANCESTOR_SELECTOR = [
	"footnote", "endnote", "rearnote", "note", "annotation",
].map(t => `aside[epub\\:type~="${t}"]`).join(",") +
	',aside[role~="doc-footnote"],aside[role~="doc-endnote"],.epubtype-footnote,.epub-footnote-item,.duokan-footnote-item'

/* 给 foliate 自建的元素打一个插件自有类名。
   为什么不用标签名选择器：`foliate-view` 是我们无法定义的自定义元素，stylelint 的
   `selector-type-no-unknown` 会把 `foliate-view { … }` 判为「未知类型选择器」并报
   上架预警；而 `:is(foliate-view)` 只是把这条搬进函数式伪类里，规则照样报。
   类名只在「元素由我们接管」的两个入口打：① 主视图（本文件的创建点）；
   ② foliate 内部为脚注气泡新建的二级视图（`footnote` 的 render 事件）。
   **改这里必须同步 styles.css 的 `.unreader-foliate-view` 与 test/readwidth.html 的探针** ——
   类名一旦漏打，`display:block/width:100%/height:100%` 整条规则失效，正文布局当场塌。 */
const FOLIATE_VIEW_CLASS = "unreader-foliate-view"

/** 解析 #rgb/#rrggbb/rgb()/rgba() 为相对亮度（0-1）；无法解析返回 null */
function luminanceOf(color: string): number | null {
	const s = (color ?? "").trim().toLowerCase();
	let r = -1, g = -1, b = -1;
	const h3 = /^#([0-9a-f]{3})$/.exec(s);
	const h6 = /^#([0-9a-f]{6})$/.exec(s);
	if (h3) {
		const h = h3[1]!;
		r = parseInt(h[0]! + h[0]!, 16);
		g = parseInt(h[1]! + h[1]!, 16);
		b = parseInt(h[2]! + h[2]!, 16);
	} else if (h6) {
		const h = h6[1]!;
		r = parseInt(h.slice(0, 2), 16);
		g = parseInt(h.slice(2, 4), 16);
		b = parseInt(h.slice(4, 6), 16);
	} else {
		const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
		if (!m) return null;
		r = Number(m[1]); g = Number(m[2]); b = Number(m[3]);
		if (![r, g, b].every(Number.isFinite)) return null;
	}
	const lin = (c: number): number => {
		const v = Math.max(0, Math.min(255, c)) / 255;
		return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 解析出的阅读底色是否为深色：亮度法优先，解析失败回退到主题标记 */
function isDarkReading(app: ResolvedAppearance, bg: string): boolean {
	const lum = luminanceOf(bg);
	if (lum != null) return lum < 0.45;
	return activeTheme(app) === "dark";
}

/**
 * 深色模式专用覆盖：强制统一书籍自带的硬编码文字色（标题/引用块/表格/色块盒子等）。
 * 只在阅读底色为深色时启用；浅色下保持原书样式不动。
 * - 文本元素 color !important：覆盖 EPUB 外部 CSS / <style> / 内联 style 的深色字
 * - 结构容器背景透明化：书内浅底盒子若保留，会与强制浅色字叠加成白底白字，
 *   因此同步去掉其背景（图片/音视频等媒体元素不受影响）
 * - 高亮混合改为 normal：multiply 在深底上会把高亮压成黑色
 */
export function darkTextOverrideCss(fg: string, accent: string, scheme: "dark" | "normal" = "dark"): string {
	return `
/* 深色阅读：覆盖书籍硬编码颜色，保证可读。
   color-scheme：深底时用 dark；但有背景图时必须 normal——html 需保持透明让
   宿主图片层透出，而 Chromium 在 iframe 根背景透明且 color-scheme=dark 时
   会用深色「画布色」填充整个 iframe，把背后的图片盖成黑色（正文黑、
   图片只在无 iframe 的两侧空白露出的根因） */
html { color-scheme: ${scheme} !important; }
body, body p, body div, body span, body li, body td, body th, body dd, body dt,
body h1, body h2, body h3, body h4, body h5, body h6,
body blockquote, body figcaption, body caption, body section, body article,
body header, body footer, body aside, body pre, body code,
body small, body em, body strong, body b, body i, body u, body s, body sub, body sup {
	color: ${fg} !important;
	-webkit-text-fill-color: ${fg} !important;
}
body, body div, body section, body article, body p, body blockquote, body aside,
body header, body footer, body table, body td, body th, body pre {
	background-color: transparent !important;
	background-image: none !important;
}
a, a * { color: ${accent} !important; -webkit-text-fill-color: ${accent} !important; }
.unreader-hl-rect { mix-blend-mode: normal !important; }
`.trim();
}

/** 返回按钮调试日志门控：localStorage["unreader-debug-back"] === "1" 时开启 */
export function backDebugOn(): boolean {
	try {
		return window.localStorage.getItem("unreader-debug-back") === "1";
	} catch {
		return false;
	}
}

/** 手机/平板等移动环境：布局按触屏优化（隐藏章节轨、不压缩左右边距等） */
export function isMobileLike(): boolean {
	try {
		return Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp;
	} catch {
		return false;
	}
}

/** 只有手机形态才使用固定小边距。iPad 虽然属于移动端，但屏幕仍可能很宽，
 *  正文布局应与桌面采用同一档：窗口变窄时先释放侧边距，再压缩正文宽度。 */
export function isPhoneLike(): boolean {
	try {
		const body = document.body;
		if (body?.hasClass("is-tablet")) return false;
		if (body?.hasClass("is-phone")) return true;
	} catch { /* ignore */ }
	try {
		return Platform.isPhone === true;
	} catch {
		return false;
	}
}

/** srcdoc 专用序列化：必须用 HTML 序列化器（innerHTML），不能用 XMLSerializer。
 *  XML 序列化会把 <style> 文本里的 >、& 转义成 &gt;/&amp;，而 srcdoc 按 HTML
 *  解析时 <style> 是 raw text（不解码实体）→ 书内含子选择器/转义符的 CSS 规则
 *  静默失效（表现为排版设置全部丢失、字体间距回退默认）。HTML 序列化器对
 *  style/script 原文段不转义，连续模式 `renderSection` 共用此序列化。 */
export function serializeFrameHtml(doc: Document): string {
	try {
		const inner = (doc.documentElement as HTMLElement | null)?.innerHTML
		if (inner && inner.trim()) return `<!DOCTYPE html><html>${inner}</html>`
	} catch { /* ignore */ }
	return `<!DOCTYPE html><html><body>${doc.body?.innerHTML ?? ""}</body></html>`
}

export function buildThemeCss(app: ResolvedAppearance): string {
	// 阅读区配色：默认纯白底（#ffffff）+ 深灰字（#222222），用户可在外观设置中自定义。
	// 其余装饰色仍跟随 Obsidian 主题变量，确保与高亮、链接等风格协调。
	const style = getComputedStyle(document.body);
	const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;

	const bg = app.backgroundColor || "#ffffff";
	const fg = app.textColor || "#222222";
	const muted = v("--text-faint", "#8a8a8a");
	const accent = v("--interactive-accent", "#4c6ef5");
	const font = app.fontFamily || v("--font-text", "") ||
		`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

	const paraRule =
		app.paragraphSpacing > 0
			? `p { margin-block-start: ${app.paragraphSpacing}em !important; margin-block-end: 0 !important; }`
			: "";

	// 大标题页单独成页时的兜底居中（已被合并逻辑处理，保留以防未合并的标题页）
	const titleCenterRule = `
body:has(#CHP2) {
	display: flex !important;
	flex-direction: column !important;
	justify-content: center !important;
	align-items: center !important;
	min-height: 60vh !important;
	padding-top: 10vh !important;
	padding-bottom: 10vh !important;
	box-sizing: border-box !important;
}
body:has(#CHP2) .calibre1 { width: 100%; }
body:has(#CHP2) h2.calibre9 {
	margin: 0 0 0.6em 0 !important;
	font-size: 1.9em !important;
	letter-spacing: 0.18em !important;
	line-height: 1.3 !important;
}
body:has(#CHP2) .calibre5 {
	margin: 0 !important;
	font-size: 1.1em !important;
	letter-spacing: 0.12em !important;
	opacity: 0.86;
}
/* 合并后的 Part 标题块：显示在小章节顶部，弱化层级 */
.unreader-part-header {
	margin: 0 0 1.2em 0 !important;
	padding: 1.1em 0 0.9em 0 !important;
	border-bottom: 1px solid var(--background-modifier-border, rgba(0,0,0,0.08)) !important;
	text-align: center !important;
	opacity: 0.92;
}
.unreader-part-header h1, .unreader-part-header h2 {
	margin: 0 !important;
	font-size: 1.55em !important;
	letter-spacing: 0.16em !important;
	font-weight: 700 !important;
	line-height: 1.35 !important;
}
.unreader-part-header h1 .calibre3, .unreader-part-header h2 .calibre3,
.unreader-part-header h1 .calibre10, .unreader-part-header h2 .calibre10 {
	font-size: 1em !important;
}
`;

	const image = (app.backgroundImage || "").trim();
	// 连续模式背景图：iframe 内透明 + ::before 固定图片层；无图走纯色底
	const imageRule = image
		? `
html { background-color: transparent !important; }
html::before {
	content: "";
	position: fixed;
	inset: 0;
	z-index: -1;
	background-image: url("${image.replace(/"/g, "%22")}");
	background-size: cover;
	background-position: center;
	background-repeat: no-repeat;
	background-attachment: fixed;
	${app.imageBlur > 0 ? `filter: blur(${app.imageBlur}px); transform: scale(1.06);` : ""}
}`
		: `html { background-color: ${bg} !important; }`;

	// 玻璃效果：半透明底色 + backdrop blur 的全视口薄层（html::after），
	// 画在图片层(::before)之上、正文之下——放 body 会受 8px 默认边距限制，
	// 呈现"只在文字区域生效"的碎块感
	const glassRule =
		image && app.glassEnabled
			? `
html::after {
	content: "";
	position: fixed;
	inset: 0;
	z-index: -1;
	pointer-events: none;
	background-color: ${hexToRgba(bg, app.glassOpacity)} !important;
	-webkit-backdrop-filter: blur(${app.glassBlur}px) !important;
	backdrop-filter: blur(${app.glassBlur}px) !important;
}`
			: "";

	// 边距：连续（上下滚动）模式，左右留白直接采用用户设定值。
	// 最小 8px 下限，桌面额外限制 25% 防止过小窗口下挤没正文
	const mobile = isPhoneLike();
	const calcPad = (m: number): string => {
		if (mobile) return `max(8px, ${m}px)`
		return `max(0px, min(${m}px, 25%))`
	}
	const leftPad = calcPad(app.marginLeft)
	const rightPad = calcPad(app.marginRight)
	
	// 段落样式：首行缩进 N 字 + 两端对齐（与连续模式统一）
	// 缩进必须落在各块级元素上：text-indent 的 em 按「声明元素」的字号解析，
	// 若放在 body 上靠继承，子元素拿到的是解析好的绝对值——段落字号比 body 大时
	// 缩进就不足 N 字（用户报告的「字号变大后缩进变窄」）。em 直接在元素上
	// 声明才随该元素字号自动缩放。
	const indentBlocks = "body, body p, body div, body li, body dd, body dt, body blockquote, body section, body article";
	// 缩进补偿字间距：开字间距后每字符实际占位 = font-size + letter-spacing，
	// N 个缩进字符的落点 = N×(1em+ls)，否则缩进比第二行前 N 字窄 N×ls。
	// 同一组元素上字间距与本缩进用同一个 em 基准，补偿精确成立
	const indentEm = app.paragraphIndent * (1 + app.letterSpacing);
	const indentRule = `text-indent: ${indentEm.toFixed(4)}em !important;`;
	const paraIndentRule = `${indentBlocks} {
	text-align: justify !important;
	${indentRule}
}
h1, h2, h3, h4, h5, h6 { text-indent: 0 !important; }`;
	// NOTE_HIDE_CSS 自带 @namespace 且必须位于整表最顶端，因此拼接在最前
	// imageRule：有背景图时 html 透明 + ::before 图片层；无图时纯色底
	// glassRule：玻璃开启时 html::after 全视口半透明薄层，否则为空
	return `${NOTE_HIDE_CSS}
${app.customFontRules ?? ""}
${imageRule}
${glassRule}
${paraIndentRule}
body {
	background-color: transparent !important;
	color: ${fg} !important;
	font-family: ${font};
	font-size: ${app.fontSize}px !important;
	padding-left: ${leftPad} !important;
	padding-right: ${rightPad} !important;
	text-align: justify;
	box-sizing: border-box !important;
}
/* 强制全书正文使用所选字体，覆盖书籍自身样式（标题仍可被书籍样式覆盖字号，但字体统一）；
   行距/字间距同理必须落到各元素上——EPUB 内 p/div 自带 line-height 会覆盖 body 的继承值 */
html, body, body p, body div, body span, body li, body td, body th, body blockquote, body section, body article,
body dd, body dt, body figcaption, body caption, body small, body em, body strong, body b, body i {
	font-family: ${font} !important;
	line-height: ${app.lineHeight} !important;
	${app.letterSpacing ? `letter-spacing: ${app.letterSpacing}em !important;` : ""}
}
a { color: ${accent}; }
h1, h2, h3, h4, h5, h6 { color: inherit; }
hr { border-color: ${muted}; }
blockquote { color: ${muted}; }
sup, sub { font-size: 75% !important; line-height: 0 !important; }
sup img, sub img { height: 1em !important; width: auto !important; max-height: none !important; max-width: none !important; vertical-align: baseline; }
/* 确保正文可选：覆盖书籍可能设置的 user-select:none */
body, p, div, span, li, td, th, blockquote, section, article, dd, dt {
	user-select: text !important;
	-webkit-user-select: text !important;
}
/* 封面页特殊处理：仅针对首页封面 SVG，避免影响正文插图 */
body:has(svg[viewBox="0 0 573 800"]) {
	padding-left: 0 !important;
	padding-right: 0 !important;
	text-align: center !important;
}
/* 封面页块级元素同样居中且不缩进（盖过上面的缩进/两端对齐规则） */
body:has(svg[viewBox="0 0 573 800"]) :is(p, div, li, dd, dt, blockquote, section, article) {
	text-align: center !important;
	text-indent: 0 !important;
}
body:has(svg[viewBox="0 0 573 800"]) .calibre {
	margin: 0 !important;
	padding: 0 !important;
}
/* 图片自适应：保持比例（不强制覆盖封面原始尺寸，交由 paginator 的 setImageSize 按容器自适应） */
img, svg, image {
	max-width: 100%;
	height: auto;
	object-fit: contain;
}
body:has(svg[viewBox="0 0 573 800"]) img, body:has(svg[viewBox="0 0 573 800"]) svg {
	max-height: 88vh;
	margin: 0 auto;
	display: block;
}
${paraRule}
${titleCenterRule}
${isDarkReading(app, bg) ? darkTextOverrideCss(fg, accent, image ? "normal" : "dark") : ""}
`.trim();
}

/** #rrggbb → rgba() */
function hexToRgba(hex: string, alpha: number): string {
	const v = hex.trim();
	let r = 255, g = 255, b = 255;
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
	if (m) {
		r = parseInt(m[1]!, 16);
		g = parseInt(m[2]!, 16);
		b = parseInt(m[3]!, 16);
	} else {
		const m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
		if (m3) {
			r = parseInt(m3[1]! + m3[1]!, 16);
			g = parseInt(m3[2]! + m3[2]!, 16);
			b = parseInt(m3[3]! + m3[3]!, 16);
		}
	}
	return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

// 常驻 frame 生命周期（合成器压力根因修复）：
// 同源 iframe 每个都是独立合成面，半透明窗口（Obsidian translucency）下，
// 多达 10+ 个活 frame 会与同窗侧边栏抢合成器资源，触发闪烁/滚动拖影
// （macOS 26 + Electron 已知伪影类别，UNagent 聊天面板受害）。
// 因此按「当前章邻域」严格收缩：稳态约 5 个活 frame，滚动停顿 400ms 后
// 回收 ±2 章 / ±3 屏以外的远章（minHeight 占位保 offsetTop，可回补）。
// **性能优化：减少移动端的 frame 数量**，连续模式改为按需预载（±1 章），
// 而非一次性堆叠大量 frame；移动端触摸滑动更跟手，减少卡顿和掉帧。
// 调试可用 localStorage["unreader-keep-frames"] 覆盖阈值。
const CONT_KEEP_FRAMES = 6 // 最大常驻 frame 数上限
const CONT_UNLOAD_MIN_DIST = 2 // 至少保留当前章前后 N 章不回收
const CONT_UNLOAD_MIN_SCREENS = 3 // 或±N 屏以内的 frame
// **移动端优化：减少预载范围**，避免滑动时卡死
// （原实现用 navigator.userAgent 正则，官方 lint 禁用 navigator 判平台；
//   改为复用文件内既有的 isMobileLike()——Platform API，判据同手机/平板口径）
const IS_MOBILE_LIKE_THRESHOLD = isMobileLike()

// 滚动方向判定（宿主据此藏/唤沉浸态 chrome）：
// 老实现拿**相邻两次 scroll 事件的 scrollTop 差值**直接定方向，等于零阈值 —— 手指
// 微回抖、iOS 触底/触顶回弹、Chrome 滚动锚定（章节补载令上方高度变化时浏览器静默
// 调 scrollTop）都会被读成一次方向翻转。宿主每收到一次翻转就翻一次 chrome-hidden，
// 底栏（.mobile-navbar）带 0.3s transform + 0.2s opacity 过渡 → 手机端肉眼就是
// 「出现—消失—出现—消失」的闪烁（用户报障原话）。官方 onScroll 的判据是
// `Math.abs(delta) < .125`（同样≈零阈值），但它只挂在 markdown 视图上。
// 改为**锚点累积位移 + 反向闸**：攒不满阈值的小抖动永不进状态机；方向刚翻转后的
// 一小段时间内不接受反向上报，把「一次滑动的尾部回弹」并成一次翻转。
// 调试可用 localStorage["unreader-scroll-dir-px"] / ["unreader-scroll-dir-dwell"] 覆盖
// （px 设 0 = 关掉阈值，等价于修复前行为，回归里当阴性对照用）。
const CONT_DIR_MIN_PX = 10 // 方向判定最小累积位移（px）
const CONT_DIR_DWELL_MS = 150 // 翻转后反向闸时长（ms）
// 选中文字期间的滚动**不算阅读滚动**：手机端长按选词/拖选区手柄时，浏览器会把
// 选区与手柄滚进可视区（容器又是 scroll-behavior:smooth，这一段会变成一串带动画的
// scroll 事件，位移轻松超过上面的阈值），宿主据此翻转 chrome-hidden → 底栏（0.3s
// 过渡）当场滑出/滑回，用户报的「点选文本时概率触发底栏闪烁」正是它，且「概率」
// 取决于选区是否落在需要滚动才能露出的位置。选区的 selectionchange / pointerup 一到
// 就设这个抑制窗口（引擎在 iframe 内直接挂，不经 260ms 的 debounce），窗口内只推进
// 锚点、不上报方向；窗口尾（默认 500ms）留出「抬手后浏览器的收尾动画」。
// 与 contProgScrollUntil 同构：都是「这段 scroll 不是用户意图」的一次性窗口。
const CONT_SEL_SUPPRESS_MS = 500
// 版面补偿（`nudgeScrollForLayoutShift`）每次调用要续上的抑制窗口。取得比一帧长得多，
// 是因为页首让位的过渡会**连续多帧**调用（每帧续一次，所以整段动画都被罩住），
// 而动画一结束它很快失效、用户滚动立刻恢复正常判定 —— 太短会中途漏出一次假方向、
// 太长会让「过渡刚结束就滚」的第一下被吞掉。
const SCROLL_LAYOUT_COMP_SUPPRESS_MS = 220

interface ContAnchorRef { index: number; hash: string | null }
/** 高亮覆盖矩形（`DOMRect` 的可写副本：`getClientRects()` 返回的 DOMRect 是只读的，
 *  同一行碎片要合并就得拷贝出来改）。 */
interface CoverRect {
	left: number
	top: number
	right: number
	bottom: number
	width: number
	height: number
}

interface ContFrame {
	idx: number
	iframe: HTMLIFrameElement
	doc: Document | null
	pageUrl: string
	anchors: Map<string, ContAnchorRef>
	lastHeight: number
	timers: number[]
	ro: ResizeObserver | null
	sizePending?: boolean
	loaded?: boolean
	/** 点按/键盘/测量等已接线（wireFrame 幂等守卫：提前接线后 load 兜底不再重复挂） */
	wired?: boolean
	/** 长按直跳后跟进 click 的消费标记（见 wireFrame 长按逻辑） */
	longPressConsumed?: () => string
	/** 已完成 FontFace 注册的字体签名（id 列表）。主题刷新循环会遍历所有 frame
	 *  重跑注册，签名不变即跳过，避免反复解析同一份字体二进制。 */
	fontSig?: string
	/** 已落地的设备视口签名（`宽|缩放比`）：重算路径每帧都跑，签名不变就不写样式。 */
	deviceSig?: string
}

/** 连续模式 iframe 内侧栏手势桥（内联进 srcdoc 末尾的 <script>）。
 *
 *  为什么必须放进 iframe：连续模式每章渲成一个 srcdoc iframe，触摸落在 iframe
 *  里的**不会冒泡到宿主 document**，Obsidian 挂在 workspace.containerEl 上的
 *  swipe 识别器（obsidian.asar 的 Rm）拿不到 touchstart → 正文区域的左右滑动
 *  永远开不出侧栏。宿主侧的「边缘热区」只能覆盖屏幕最外侧一条，覆盖不了正文。
 *
 *  为什么用直接函数调用而非 postMessage：srcdoc 与本插件同源（allow-same-origin），
 *  iframe 内可直接访问 window.parent.__unreaderSwipe。跳过结构化克隆与异步投递，
 *  每帧 move 的开销与原生 touch 监听同级 —— 跟手拖拽不掉帧。postMessage 的版本
 *  每帧一次跨文档消息 + 事件对象序列化，实测迟滞明显。
 *
 *  **上报坐标必须换算到「宿主视口坐标系」，不能直接传 touch 的 clientX/clientY**：
 *  iframe 内拿到的 touch 坐标是相对 **iframe 自身视口**的，而原生 Rm 跑在宿主
 *  document 上、拿到的是**宿主视口**坐标，原生所有订阅者都按宿主视口解释这些数
 *  （抽屉的 `--safe-area-inset-bottom` 闸直接写 `window.innerHeight - e.startY`）。
 *  连续模式第一章之后的每个 frame 顶端都在视口上方（读到半截时 rect.top 可达
 *  -2000+），两者能差出成百上千 px。不换算的后果不是「略有偏差」而是**整条链路失效**：
 *  手机（isPhone）上抽屉首行守卫 `if (innerHeight - e.startY < safeAreaBottom) return`
 *  恒真 → 连 registerCallback 都不会被调用 → 插件判「无人接收」放弃手势 →
 *  在正文区域横滑永远开不出侧栏。故每次上报前加上 frame 元素的视口矩形左上角。
 *
 *  **换算必须连带缩放比 k（设备模式）**：网页设备模式会给 frame 一个固定的布局视口
 *  再用 zoom 整体缩到阅读区宽度（engineAdapter.setWebDevice），此时帧内 CSS px ≠ 宿主 px，
 *  差一个 k。k 由宿主给出（`B.scale()`，non-webLayout 恒为 1 ⇒ 与旧行为逐字节一致），
 *  **起手时读一次**：手势期间读会受祖先 transform（抽屉推出式开合）影响，
 *  而 getBoundingClientRect 是含 transform 的，反推出的 k 会随动画漂移。
 *  漏乘 k 不会让手势失效，但抽屉会以 1/k 的速度脱离手指（k≈0.3 时快 3 倍多），
 *  8px 死区也缩成 2~3 个物理 px（纵向滚动的微抖就能锁成横滑、误开侧栏）。
 *
 *  识别逻辑对齐原生 Rm()：首个有效位移定轴（|dx|>|dy| → 横向），定轴前完全放行
 *  （纵向滚动照旧由浏览器合成器处理），定轴后才向宿主上报序列。8px 触控死区比
 *  原生更稳：原生拿第一个 touchmove 定轴，手指微抖就会锁死成纵向。
 *
 *  **选区闸必须用「手势期间选区有没有变长」判据，不能照抄原生的 `getSelection()`**：
 *  原生 Rm 跑在宿主 document 上，它读到的是宿主选区——而 iframe 内的选区对宿主
 *  `window.getSelection()` 永远不可见（见 getReaderSelection 的存在理由）。也就是说
 *  原生的这行判据在正文 iframe 场景里**恒为假、从不生效**。我们的桥跑在 iframe 内部，
 *  同一个调用读到的是**整个正文的选区**，照抄过来就变成：只要正文里有任何选中文字，
 *  之后每一次横滑都被判成「划词」直接放弃 → 侧栏再也滑不出来（实机 bug）。
 *  正确判据：起手时快照选区文本 sel0，定轴时只在选区**变长（或从无到有）**时才放弃——
 *  拖选区手柄拉长、从空选区划出新选区都命中；而「已有选区但没动它」放行，这正是
 *  用户要的：选完字再横滑调侧栏。只比长度不比相等：部分平台的 touchstart 会把选区
 *  归一化到词边界（等长或变短），用 `!==` 判等会误杀正常横滑。
 *
 *  350ms 长按闸：起手后超过 350ms 才产生首个位移的，判为长按（划词/放大镜/
 *  上下文菜单）而非滑动，直接放弃。原生 Rm 用 200ms 做同样的事；这里放宽是因为
 *  200ms 会误杀「手先落稳再滑」的慢起手。
 *
 *  监听器全部 passive、绝不 preventDefault：横向分量由宿主侧冻结滚动容器接管，
 *  纵向分量留给浏览器。这样不会把 iframe 内的滚动从合成器快路径拖回主线程
 *  （原生识别器用的是 non-passive touchmove，代价是整段滚动都要等主线程）；
 *  在宿主里加 non-passive 监听反而会明显拖慢纵向滚动。 */
const SIDEBAR_SWIPE_BRIDGE_JS = `(function(){
var W;try{W=window.parent}catch(e){return}
var B=W&&W.__unreaderSwipe;
if(!B||!B.active)return;
var D=document;
var id=null,sx=0,sy=0,lx=0,ly=0,t0=0,lt=0,vx=0,axis="",dead=false,sel0="",kk=1;
/* 宿主给的本帧缩放比（设备模式；非网页通道恒为 1）。起手读一次并缓存整个手势：
   手势期间祖先会被抽屉 transform，而 rect 含 transform，逐帧重读会得到漂移的值。 */
function kOf(){try{var f=B.scale;if(typeof f==="function"){var v=f();if(v>0&&v<=1)return v}}catch(e){}return 1}
/* iframe 左上角在**宿主视口**中的偏移。原生订阅者（抽屉 safe-area 闸、下拉动作）
   都按宿主视口解释 startX/startY/x/y，iframe 局部的 clientX/clientY 必须加上它。
   每次上报都重读：侧栏推出式开合会把 frame 连同祖先一起 transform，偏移随之变化
   （手势期间祖先只会被 transform 推动，transform 不脏布局 → 这次重读只做样式计算，
   不触发重排，开销与原生监听同级）。加减的都是同一个偏移量，故位移量不受影响。 */
function ox(){var f=null;try{f=window.frameElement}catch(e){}if(!f||!f.getBoundingClientRect)return null;try{var r=f.getBoundingClientRect();return {x:r.left,y:r.top}}catch(e){return null}}
function pick(e){
  var i,a=e.changedTouches;
  for(i=0;i<a.length;i++){if(a[i].identifier===id)return a[i]}
  a=e.touches;
  for(i=0;i<a.length;i++){if(a[i].identifier===id)return a[i]}
  return null;
}
function ignored(e){
  var n=e.target;
  while(n&&n.nodeType===1){
    if(n.dataset&&n.dataset.ignoreSwipe)return true;
    n=n.parentNode;
  }
  return false;
}
function selText(){
  try{var s=window.getSelection?window.getSelection():null;return s?String(s).trim():""}catch(e){return ""}
}
function stop(){id=null;axis="";dead=false;vx=0;sel0=""}
function onStart(e){
  if(e.touches.length>1){if(axis==="x")B.cancel();stop();return}
  if(ignored(e))return;
  var t=e.touches[0];
  kk=kOf();
  id=t.identifier;sx=lx=t.clientX;sy=ly=t.clientY;t0=lt=Date.now();vx=0;axis="";dead=false;sel0=selText();
}
function onMove(e){
  if(id===null||dead)return;
  var t=pick(e);if(!t)return;
  var x=t.clientX,y=t.clientY;
  if(!axis){
    /* 死区与位移一律换算到宿主 px（= 手指物理位移的量级）：帧内 px 在设备模式下
       是物理位移的 1/k 倍，直接拿帧内 px 比 8 会让死区缩成 2~3 个物理 px。 */
    var dx=(x-sx)*kk,dy=(y-sy)*kk,ax=Math.abs(dx),ay=Math.abs(dy);
    if(ay>=8&&ay>ax){dead=true;return}
    if(ax<8||ax<=ay)return;
    if(Date.now()-t0>350){dead=true;B.note&&B.note("longpress");return}
    var cur=selText();
    if(cur&&cur.length>(sel0?sel0.length:0)){dead=true;B.note&&B.note("selection");return}
    var o0=ox(),hx=o0?o0.x:0,hy=o0?o0.y:0;
    if(!B.begin({startX:hx+sx*kk,startY:hy+sy*kk,x:hx+x*kk,y:hy+y*kk})){dead=true;B.note&&B.note("rejected");return}
    axis="x";
  }
  var now=Date.now(),dt=now-lt;
  if(dt>0)vx=vx*0.8+((x-lx)/dt)*0.2;
  lt=now;lx=x;ly=y;
  var o=ox(),px=o?o.x:0,py=o?o.y:0;
  B.move(px+x*kk,py+y*kk);
}
function onEnd(e){
  if(axis==="x"&&!dead){
    var t=pick(e),x=t?t.clientX:lx,y=t?t.clientY:ly;
    var o=ox(),px=o?o.x:0,py=o?o.y:0;
    /* 收尾速度同样在帧内坐标系里（vx = Δpx/ms），一并换算 —— 抽屉内部的
       开/合阈值拿它跟宿主 px 比。 */
    B.finish(px+x*kk,py+y*kk,((x-sx)+1000*vx)*kk);
  }
  stop();
}
function onCancel(){if(axis==="x"&&!dead)B.cancel();stop()}
D.addEventListener("touchstart",onStart,{passive:true});
D.addEventListener("touchmove",onMove,{passive:true});
D.addEventListener("touchend",onEnd,{passive:true});
D.addEventListener("touchcancel",onCancel,{passive:true});
})();`

export class EngineAdapter {
	/** 渐进式加载批次大小：初始与每批预取的章节数 */
	private el: RawFoliateView | null = null
	private handlers: EngineHandlers | null = null
	private highlights = new Map<string, string>()
	private footnoteHandler: FootnoteHandler | null = null
	private currentIndex = -1
	/**
	 * 当前 book 格式（load() 完成后由 detectFormat 设置）：
	 *   - "epub"：EPUB 走 book.loadText(secId) + rewriteResourcesLocal
	 *   - "mobi"：MOBI/AZW3 走 sec.load()（已含资源改写）+ 跳过 rewriteResourcesLocal
	 *   - "txt" ：合成书（TXT / feed 文章 / 本地 HTML，见 SyntheticBook）走 sec.load()
	 *  区分依据：book.sections[0].id 类型（number = MOBI/TXT，string = EPUB），
	 *  再按合成书的 `__unreaderTxt` 标记把合成书从 MOBI 里分出来（这个标记的语义是
	 *  「我们造的合成书」，不是「这个文件是 txt」）。
	 *
	 *  ⚠️ `"mobi" | "txt"` 的**共同语义**是「章节由 foliate（或我们）预先生成，
	 *  section 是数字下标、没有真实 CFI」。凡是只关心这层语义的分支，判据应写成
	 *  `!== "epub"` 而不是 `=== "mobi"` —— 否则新增格式时会静默漏掉（fake CFI 基准、
	 *  sec.load() 取章这两条都是「漏了就整条功能链失效」）。
	 *  注：PDF 已整体移除（见 git 历史 / 记忆日志），不再作为受支持格式
	 */
	private bookFormat: "epub" | "mobi" | "txt" = "epub"
	/** 本次开书若走合成书（TXT / feed 文章 / 本地 HTML），这里持有它以便 destroy()
	 *  回收章节的 blob URL。三种来源的产物形状完全一致（见 SyntheticBook），回收策略
	 *  也一样；**只回收合成书** —— 不去调 EPUB/MOBI 的 book.destroy（那会 revoke
	 *  书内资源 URL，影响面远超本特性所需）。 */
	private syntheticBook: SyntheticBook | null = null
	/** 当前这本是不是「网页原样」通道（本地 HTML，见 core/htmlBook.ts 文件头）。
	 *
	 *  写成 getter 而不是字段：它的唯一事实来源是 `el.book` 上的标记，开书/换书/
	 *  destroy 都不需要额外的重置路径。字段形态要在三处同步赋值，漏一处就会出现
	 *  最恶心的一类故障 —— 「上一本 HTML 的零特异性样式残留到下一本 EPUB」，
	 *  表现是书排版忽然不受外观设置控制，且只在「先看 HTML 再看书」的顺序下复现。 */
	private get webLayout(): boolean {
		return (this.el?.book as SyntheticBook | null)?.__unreaderWebLayout === true
	}
	/** 网页原样通道给 iframe **元素**设的 `color-scheme`（由阅读器明暗决定）。
	 *  设在宿主侧的 iframe 元素上而不是 frame 内部：内嵌文档自己的 `color-scheme`
	 *  （CSS 声明或 `<meta name=color-scheme>`）优先级更高，作者声明天然赢 —— 网页
	 *  自己声明了配色方案时我们不该覆盖它。空串 = 书本模式（沿用原逻辑）。 */
	private webColorScheme = ""
	/** 网页（本地 HTML）设备模式，见 setWebDevice / applyWebDevice。只对 webLayout 生效。 */
	private webDevice: WebDeviceMode = "auto"
	private tocIdBySection = new Map<number, number>()
	private sortedTocSections: number[] = []
	/** 由外层 readerView 同步的 Cmd/Ctrl 按下状态，用于 Cmd+点击直接跳转 */
	public commandPressed = false

	/* ---------------- 连续滚动（无感换章） ---------------- */
	private continuousEl: HTMLElement | null = null
	/** 宿主容器（mount 传入的 stage）：分页模式固定背景图层挂载点 */
	private hostEl: HTMLElement | null = null
	private isContinuous = false
	private continuousRendered = false
	/** 最近一次应用的外观（连续模式 resize 重估列数 / 字号计算用） */
	private lastAppearance: AppearanceSettings | null = null
	private contSectionEls = new Map<number, HTMLElement>()
	private contFrames = new Map<number, ContFrame>()
	/** 渲染在途的章节（`renderSection` 尚未返回）。
	 *  占位记录没有 iframe，仅凭 `contFrames` 里有记录无法判断「renderSection 还在跑」还是
	 *  「上一轮静默夭折」：把在途当陈旧会重复渲染出双 iframe，把陈旧当在途则目标章永远等不到。
	 *  跳转期间的陈旧回收（`loadSections`）靠它区分。 */
	private contRendering = new Set<number>()
	private contAnchorSeq = 0
	private contOrder: number[] = []
	private contFailed = new Set<number>()
	private contFrameCss = ""
	/** 当前是否有生效背景图（frame 的 color-scheme 画布填充开关，见 loadContinuousTheme） */
	private contImgActive = false

	/* ---------------- 侧栏手势桥（连续模式 iframe → Obsidian 原生 swipe） ----------------
	 * 触摸落在 srcdoc iframe 内不会冒泡到宿主，原生识别器收不到 touchstart；
	 * 由 SIDEBAR_SWIPE_BRIDGE_JS 在 iframe 内识别横向手势、直接函数调用回来，
	 * 这里再转交 readerView → workspace.trigger("swipe", ...)，复用原生抽屉。 */
	/** 原生抽屉（或其它 swipe 订阅者）在 trigger 中同步注册的跟手回调 */
	private swipeCb: FrameSwipeCallback | null = null
	/** 手势期间的连续容器滚动快照。**起手只读、不写样式**：给装着 N 个 iframe 的
	 *  滚动容器改 overflow 会强制整棵子树重排，而手势起手那一帧正是侧栏刚现身、
	 *  原生也在改布局的时刻，任何重排都肉眼可见（实机「划出侧栏一刻卡一下」）。
	 *  只有真的检测到漂移才升级为冻结——纯横向手势下这里全程零写入。 */
	private swipeScroll: { el: HTMLElement; top: number; frozen: boolean; behavior: string } | null = null
	private contBaseCfi = new Map<number, string>()
	/** 连续模式已渲染的高亮：`range` 是与覆盖矩形同源的**真实文档 Range**（CFI 还原），
	 *  点高亮/按坐标命中时以它为准 —— 别再退回按文本反查（见 renderHighlightIn 注释）。 */
	private contHL = new Map<string, { text: string; color: string; els: HTMLElement[]; range?: Range | null }>()
	private contHLByIndex = new Map<number, string[]>()
	private contRaf = 0
	/** 最近一次点击/悬停注标在宿主视口中的位置（脚注气泡锚点） */
	private lastNoteAnchor: { x: number; y: number } | null = null
	private contPruneTimer = 0
	private contBlobCache = new Map<string, string>()
	private contBlobs: string[] = []
	/** 恢复位置的目标章（nearestRenderedSection 映射后）：初始补载优先载它，
	 *  替代「文档序前 3 章」——否则恢复到远章时先载开头几章再逐步走向目标，定位极慢 */
	private contRestoreTarget: number | null = null
	/** 章节渲染产物缓存（会话内 LRU）：srcdoc html + 锚点映射。
	 *  章节回收后重访（往返滚动/深位置恢复）目前要走完整「解压→解析→改写→序列化」
	 *  流水线（单章数十 ms～百 ms 级），缓存后近乎零成本。css 变化即整体失效。 */
	private contHtmlCache = new Map<number, { css: string; html: string; anchors: Map<string, ContAnchorRef>; blobs: Set<string> }>()
	private static readonly CONT_HTML_CACHE_MAX = 24
	/** srcdoc 挂起重试计数（就绪看门狗用）：同一章连续挂起 2 次进黑名单防 livelock */
	private contHangRetries = new Map<number, number>()
	/** 首帧接线打点（perf）：每次开书只记一次 */
	private firstFrameLogged = false
	/** 开书序号：每进一次 loadContinuous 自增。后台任务（目录标题派生）据此判断
	 *  「我这次开书还算不算数」——用户连开两本时，旧书的派生结果必须整体作废，
	 *  否则迟到的旧标题会写进新书的目录缓存 */
	private openSeq = 0
	/** blob 缓存上限：超过后回收最旧且无活帧引用的条目，防长书/图片书 blob 无限膨胀 */
	private static readonly CONT_BLOB_CACHE_MAX = 160

	/** 回收超出上限的 blob：仅回收「无任何活 frame 的 document 引用」的条目 */
	private pruneBlobCache(): void {
		const max = EngineAdapter.CONT_BLOB_CACHE_MAX
		if (this.contBlobCache.size <= max) return
		const referenced = new Set<string>()
		this.contFrames.forEach(f => {
			try {
				const d = f.doc
				if (!d) return
				d.querySelectorAll("[src], [poster], [data], [href]").forEach(el => {
					const u = el.getAttribute("src") ?? el.getAttribute("poster") ?? el.getAttribute("data") ?? el.getAttribute("href") ?? ""
					if (u.startsWith("blob:")) referenced.add(u)
				})
			} catch { /* ignore */ }
		})
		// srcdoc 渲染缓存里的 blob 引用视同活引用：缓存命中重载的帧把这些 URL 写进
		// 新 iframe 的属性要等下一轮查询才能覆盖，这里提前保护防 revoke 后图片裂掉
		this.contHtmlCache.forEach(c => { c.blobs.forEach(u => referenced.add(u)) })
		let excess = this.contBlobCache.size - max
		for (const [resolved, url] of this.contBlobCache) {
			if (excess <= 0) break
			if (referenced.has(url)) continue // 仍被活帧引用：不可回收
			this.contBlobCache.delete(resolved)
			try { URL.revokeObjectURL(url) } catch { /* ignore */ }
			excess--
		}
	}

	mount(container: HTMLElement, handlers: EngineHandlers): void {
		this.destroy()
		// 宿主容器（分页模式的固定背景图层挂这里；连续模式挂在 continuousEl）
		this.hostEl = container
		const cont = createDiv()
		cont.className = "unreader-continuous"
		container.appendChild(cont)
		this.continuousEl = cont
		const el = createEl("foliate-view" as keyof HTMLElementTagNameMap, { cls: FOLIATE_VIEW_CLASS }) as unknown as RawFoliateView
		// 必须在 addEventListener 之前赋值：listener 内通过 this.el?.book 探测格式
		this.el = el
		this.handlers = handlers
		// 侧栏手势桥（host 侧）：srcdoc iframe 与本插件同源，iframe 内识别到横向
		// pan 后直接函数调用进来（无 postMessage 序列化/异步延迟）。仅移动端启用；
		// 桌面保持原样（Obsidian 原生 Rm 本身就 `if(!Gl.isMobile) return`）。
		const hostWin = window as unknown as { __unreaderSwipe?: unknown }
		hostWin.__unreaderSwipe = {
			active: isMobileLike(),
			begin: (p: { startX: number; startY: number; x: number; y: number }) => this.beginFrameSwipe(p),
			move: (x: number, y: number) => this.moveFrameSwipe(x, y),
			finish: (x: number, y: number, v: number) => this.finishFrameSwipe(x, y, v),
			cancel: () => this.cancelFrameSwipe(),
			// 设备模式（网页原样通道）的缩放比：帧内 CSS px → 宿主 px 的换算系数，
			// 见 SIDEBAR_SWIPE_BRIDGE_JS。非网页通道恒为 1。
			scale: () => this.webDeviceScale(),
			// iframe 侧放弃手势时回报原因（长按/选区/无人接收）。仅进调试缓冲，
			// 开关关闭时是空调用——实机排查「滑了没反应」时唯一能定位断点的信号。
			note: (reason: string) => debugInfo("[swipe] iframe abandon:", reason),
		}
		el.addEventListener("relocate", ev => {
			const d = foliateDetail<FoliateRelocateDetail>(ev)
			// 第一次 relocate 时确定书格式（el.book 在 open 之后才可访问，open 后第一次推回正常字段）
			const b = this.el?.book
			if (b) this.bookFormat = this.detectFormat(b)
			const nativeFrac = typeof d.fraction === "number" && Number.isFinite(d.fraction)
				? Math.min(1, Math.max(0, d.fraction))
				: 0
			// foliate 对未收录进目录的章节不给 tocItem：回退到派生条目 / 最近的前一个目录条目
			const cfi = typeof d.cfi === "string" ? d.cfi : ""
			const nativeTocId = typeof d.tocItem?.id === "number" ? d.tocItem.id : null
			const nativeTocLabel = typeof d.tocItem?.label === "string" ? d.tocItem.label : null
			const tocId = nativeTocId ?? (cfi ? this.navKeyForCfi(cfi) : null)
			handlers.onRelocate({
				cfi,
				fraction: typeof d.fraction === "number" ? d.fraction : 0,
				sectionFraction: nativeFrac,
				tocId,
				sectionLabel: nativeTocId != null && nativeTocLabel != null
					? nativeTocLabel
					: (tocId != null ? this.getTocEntryLabel(tocId) ?? "" : ""),
				locCurrent: typeof d.location?.current === "number" ? Math.floor(d.location.current) : null,
				locTotal: typeof d.location?.total === "number" ? Math.ceil(d.location.total) : null,
			})
		})
		el.addEventListener("load", ev => {
			const d = foliateDetail<FoliateLoadDetail>(ev)
			if (d.doc) {
				this.currentIndex = typeof d.index === "number" ? d.index : -1
				// 分页流 iframe 由 foliate 内部创建、无逐帧回调，沉浸模式点按
				// 唤出工具栏在这里补接（连续流已在 renderSection 内逐帧接入）
				if (!this.isContinuous) {
					this.wireTapZone(d.doc as Document)
					handlers.onLoadDoc(d.doc as Document, d.index as number)
				}
				handlers.onLoadDoc(d.doc as Document, d.index as number)
			}
		})
		el.addEventListener("draw-annotation", ev => {
			const { draw, annotation } = foliateDetail<FoliateDrawAnnotationDetail>(ev)
			if (typeof draw === "function") draw(Overlayer.highlight.bind(Overlayer), { color: annotation?.color })
		})
		el.addEventListener("create-overlay", ev => {
			this.redrawSection(foliateDetail<FoliateCreateOverlayDetail>(ev).index as number)
		})
		// 正文里的**外链**（`book.isExternal(href)`）：foliate 自己在 `#handleLinks` 里对这类
		// 链接执行 `globalThis.open(href_, "_blank")` —— **没有 features 参数**，而这个形态
		// 在 Obsidian 里既不是弹系统浏览器、也不是新开 Obsidian 窗口：桌面端 `setWindowOpenHandler`
		// 直接 deny，随后那次导航落到**章节 iframe 自己身上**（正文被网页顶掉、没有任何返回入口）。
		// 实测（2026-09-20，真机 CDP）：Feed 文章与 EPUB 章节里点 http 外链，
		// `about:srcdoc` 帧的 URL 当场变成目标网址 —— 用户报的「还是在 Obsidian 中打开」就是这个。
		//
		// **只有** preventDefault 掉这个 CustomEvent 才能拦住（`#emit` 把 `dispatchEvent` 的
		// 返回值当开关：false ⇒ 不调 `globalThis.open`）。在 `doc` 上再挂一个 click 监听
		// 是拦不住的 —— 那只能阻止默认导航，拦不了 foliate 自己的这段代码。
		// 于是「外链一律交系统默认浏览器」这条口径在**引擎层收口一次**，书 / Feed / HTML / TXT
		// 四种源共用（`openExternalLink` 是唯一实现）。
		this.wireExternalLinkElement(el)
		el.addEventListener("link", ev => {
			if (!this.el || !this.footnoteHandler) return
			const detail = foliateDetail<FoliateLinkDetail>(ev)
			const aEl = (detail.a ?? null) as HTMLElement | null
			// 注标在宿主视口中的位置（脚注气泡锚点）
			this.lastNoteAnchor = this.elementHostAnchor(aEl)
			try {
				const raw = aEl?.getAttribute?.("href") ?? ""
				if (!raw) return

				let resolvedHref: string | null = null
				let preTarget: unknown
				if (this.currentIndex >= 0) {
					const section = this.el.book?.sections?.[this.currentIndex]
					try {
						const sec = section?.resolveHref?.(raw)
						if (typeof sec === "string") {
							resolvedHref = sec
							const t = (this.el.book as unknown as { resolveHref?: (h: string) => unknown })?.resolveHref?.(sec)
							if (t && typeof (t as { index?: unknown }).index === "number") preTarget = t
						} else if (sec && typeof (sec as { index?: unknown }).index === "number") {
							preTarget = sec
						}
					} catch {
						// ignore
					}
				}
				const hrefForHandler = resolvedHref ?? raw

				// Heuristic: does this look like a footnote reference?
				const looksLikeNoteRef =
					!!aEl?.querySelector?.("sup") ||
					!!aEl?.parentElement?.querySelector?.("sup") ||
					!!aEl?.innerHTML?.includes("<sup") ||
					raw.includes("footnote") ||
					/\[ *\d+ *\]/.test(aEl?.innerHTML ?? "")

				// Try inline extraction first (reliable, no secondary view sizing issues).
				// Works for both same-file and cross-file footnotes when we have a resolved target.
				if (looksLikeNoteRef && preTarget && typeof (preTarget as { index?: unknown }).index === "number") {
					// Cmd/Ctrl+点击：直接跳转，不弹面板
					if (this.commandPressed) {
						;(ev as CustomEvent).preventDefault()
						void this.goToTarget(preTarget as { index: number; anchor?: unknown })
						return
					}
					const targetIdx = (preTarget as { index: number }).index
					const anchorFn = (preTarget as { anchor?: (doc: Document) => unknown }).anchor
					const sec = this.el.book?.sections?.[targetIdx] as
						| { createDocument?: () => Promise<Document> }
						| undefined
					if (sec?.createDocument && typeof anchorFn === "function") {
						;(ev as CustomEvent).preventDefault()
						void sec
							.createDocument()
							.then(doc => {
								try {
									const rawEl = anchorFn(doc)
									let container: HTMLElement | null = null
									if (rawEl instanceof Element) container = rawEl as HTMLElement
									else if (rawEl instanceof Range) {
										const c = rawEl.commonAncestorContainer as unknown
										container = c instanceof Element ? (c as HTMLElement) : (c as Node)?.parentElement ?? null
										// Range case: try to find the footnote container around the range
										if (container && !container.closest?.("aside, li, .fnote, p")) {
											container = (rawEl).startContainer.parentElement
										}
									}
									if (!container) throw new Error("anchor produced no element")
									const closest = container.closest?.("aside, li, .duokan-footnote-item, .fnote, p.fnote, p")
									if (closest && closest !== container) {
										// Prefer the note paragraph / list item over a tiny anchor
										const isAnchorOnly = container.tagName === "A" && (container.textContent?.trim()?.length ?? 0) < 6
										if (isAnchorOnly) container = closest as HTMLElement
									}
									if (container.tagName === "A" && container.parentElement) {
										const parentTextLen = container.parentElement.textContent?.trim()?.length ?? 0
										if (parentTextLen > 20) container = container.parentElement
									}
									const html = (container).outerHTML || (container).innerHTML
									this.handlers?.onInlineFootnote?.(html, raw, undefined, this.lastNoteAnchor ?? undefined)
								} catch (e) {
									console.warn("[UNreader] inline footnote extract failed, fallback to jump", e)
									void this.goToTarget(preTarget as { index: number; anchor?: unknown })
								}
							})
							.catch(() => {
								void this.goToTarget(preTarget as { index: number; anchor?: unknown })
							})
						return
					}
				}

				let rendered = false
				this.footnoteHandler.addEventListener(
					"render",
					() => {
						rendered = true
					},
					{ once: true },
				)
				const wrapped = {
					detail: { a: aEl, href: hrefForHandler, target: preTarget },
					preventDefault: () => (ev as CustomEvent).preventDefault(),
				}
				void this.footnoteHandler.handle(this.el.book, wrapped as unknown as Event)

				if (!(ev as CustomEvent).defaultPrevented) return

				window.setTimeout(() => {
					if (!rendered && this.el) {
						if (preTarget) void this.goToTarget(preTarget as { index: number; anchor?: unknown })
						else if (resolvedHref) void this.goTo(resolvedHref)
						else void this.goTo(raw)
					}
				}, 600)
			} catch (e) {
				console.error("[UNreader] footnote handling failed", e)
			}
		})
		el.addEventListener("show-annotation", ev => {
			const d = foliateDetail<FoliateShowAnnotationDetail>(ev)
			const value = typeof d.value === "string" ? d.value : ""
			if (!value || value.startsWith("foliate-search:")) return
			handlers.onShowAnnotation(value, (d.range as Range | undefined) ?? null)
		})
		container.appendChild(el)
	}


	/** 「正文外链交系统默认浏览器」这条口径的**唯一挂载点**：主视图，以及脚注气泡里
	 *  foliate 自己新建的二级视图（`FootnoteHandler` 造的那个 `<foliate-view>` 有它自己的
	 *  `#handleLinks`，事件只在它自己身上派发 —— 不挂，脚注里的外链就还是会走
	 *  `globalThis.open` 那条把 iframe 导航走的老路）。 */
	private wireExternalLinkElement(target: RawFoliateView): void {
		target.addEventListener("external-link", ev => {
			const detail = foliateDetail<FoliateExternalLinkDetail>(ev)
			const anchor = (detail.a ?? null) as HTMLElement | null
			const url = externalUrlOf(detail.href_ ?? anchor?.getAttribute?.("href"), anchor)
			if (!url) return
			;(ev as CustomEvent).preventDefault()
			openExternalLink(url)
		})
	}

	private async loadContinuous(target: BookOpenTarget, lastLocation: string | undefined, appearance: AppearanceSettings): Promise<BookMetadata> {
		const el = this.el
		if (!el) throw new Error("Engine not mounted")
		this.highlights.clear()
		this.tocIdBySection.clear()
		this.sortedTocSections = []
		this.restorePending = null
		perfBegin("open")
		await this.openBook(el, target)
		// 解析完成后判别格式：EPUB / MOBI 的 book 接口差异（loadText、loadBlob、sec.id 类型）
		// foliate-js view 没有直接暴露 format 字段，靠 sections[0].id 类型推断
		this.bookFormat = this.detectFormat(el.book)
		perfEnd("open")
		this.buildTocSectionMap()
		// mergePartTitles 会把分部标题页改 linear="no"，renderContinuous 据此建占位，
		// 必须保持在首屏渲染前执行；其解析对象只有 depth-0 分部页，量小不拖开书
		try { await this.mergePartTitles() } catch (e) { console.warn("[UNreader] mergePartTitles failed", e) }
		this.buildTocSectionMap()
		// buildSectionNav 逐章解析全书未入目录章节（长书时主线程数百 ms～秒级），
		// 但只是给目录面板派生标题 —— 既不阻塞开书，也不该和开书抢主线程：
		// 整体延后到「首屏可见 + 恢复定位落地」之后再分块跑，完成后 onNavDerived
		// 增量刷新目录（实测它曾与 restore 完全重叠，把两者都拖慢一倍以上）。
		const openSeq = ++this.openSeq
		void (async () => {
			await this.waitForFirstScreen(openSeq)
			if (this.openSeq !== openSeq) return // 用户已开了别的书，本次派生作废
			await this.buildSectionNav(openSeq)
		})().catch(e => console.warn("[UNreader] buildSectionNav failed", e))
		// 恢复目标章必须在 ensureContinuous（触发初始补载）之前算好：
		// 初始补载优先载目标章而非文档序前 3 章，深位置恢复提速的关键。
		// **只解一次**：同一个下标还要喂给「视口预置」与 scrollToIndex。
		const restoreIdx = lastLocation ? this.resolveRestoreIndex(lastLocation) : null
		this.contRestoreTarget = restoreIdx
		// 落定闸门：视图层据此把「显示正文」推迟到恢复落点确定之后
		// （否则用户看到的是「先开在书首、再跳到上次位置」）
		this.openRestoreGate(restoreIdx)
		this.footnoteHandler = new FootnoteHandler()
		this.footnoteHandler.addEventListener("render", ev => {
			const detail = foliateDetail<FoliateFootnoteRenderDetail>(ev)
			if (detail.view && this.handlers) {
				// href 由 foliate 推回来（无类型定义）：只要字符串，别让 `String(unknown)`
				// 把意外对象变成 "[object Object]" 塞进脚注气泡。
				const href = typeof detail.href === "string" ? detail.href : ""
				const view = detail.view as RawFoliateView
				view.classList.add(FOLIATE_VIEW_CLASS)
				this.wireExternalLinkElement(view)
				this.handlers.onFootnoteRender(view, href, this.lastNoteAnchor ?? undefined)
			}
		})
		this.isContinuous = true
		perfPoint("layoutReady")
		await this.ensureContinuous(appearance, restoreIdx)
		if (restoreIdx != null) {
			let frac: number | undefined
			try {
				const inner = /^epubcfi\((.*)\)$/.exec(lastLocation!.trim())?.[1] ?? ""
				const segs = inner.split("!")
				const local = segs.length > 1 ? (segs[segs.length - 1] ?? "") : inner
				const mOff = /:(\d+)\s*$/.exec(local)
				if (mOff) {
					const pct = parseInt(mOff[1]!, 10)
					if (pct >= 2 && pct <= 1000) frac = (pct - 1) / 1000
				}
			} catch { /* ignore */ }
			// 恢复上次阅读位置：瞬时定位，不做平滑滚动动画。
			// 落定（或收敛超时放弃）即关闸门，视图层随即揭示正文。
			// `restorePending`：万一此刻容器还没有真实视口（叶子未上屏/布局未就绪 →
			// 几何全为 0，落点算不出来），把这次恢复挂起，`notifyVisible` 拿到尺寸后补落。
			perfBegin("restore")
			this.restorePending = { idx: restoreIdx, frac }
			this.scrollToIndex(restoreIdx, "start", frac, true, () => this.closeRestoreGate())
			// MOBI 模式 lastLocation 是 `mobi:N` 合成串，没有 frac（章节内百分比）：
			// scrollToIndex 在 frac 为 undefined 时只补载路径章不真滚目标——这里补一次
			// 让打开后视口确实落在目标章节顶部（章节粒度，不做亚章节定位）。
			// 用 scrollContInstant 而不是直接写 scrollTop：容器 CSS 是 scroll-behavior:smooth，
			// 直接赋值会被当成平滑滚动（恢复是瞬移语义）；预置落点已在这里时它是空操作。
			if (lastLocation!.startsWith("mobi:")) {
				const top0 = this.sectionScrollTop(restoreIdx)
				if (top0 != null) this.scrollContInstant(top0, "restorePre")
				// 紧接着触发 jumpToSection 在背景跑漂移校正链：后续章/字体重排时
				// 它会补偿内容高度差，让打开后短时间内的滚动保持稳定
				this.jumpToSection(restoreIdx, (_d, _f, _ridx) => this.sectionScrollTop(restoreIdx))
			}
		} else if (this.currentIndex < 0) {
			this.currentIndex = 0
		}
		return this.getMetadata()
	}

	/**
	 * 打开一本书：TXT 先合成 book 再交给 foliate，其余格式直接把 File 交给它。
	 *
	 *  TXT 必须在这里分流而不是让 foliate 自己识别：`view.js` 的 `makeBook` 靠 magic
	 *  字节分派，纯文本一条都不命中 → 抛 `UnsupportedTypeError`。合成书是纯对象，
	 *  `view.open()` 的三条鸭子判据（字符串 / `arrayBuffer` / `isDirectory`）不命中
	 *  → 原样赋给 `view.book`，不走 makeBook（见 txtBook.ts 文件头）。
	 */
	private openBook(el: RawFoliateView, bookOrFile: BookOpenTarget): Promise<void> {
		if (!(bookOrFile instanceof Blob)) {
			// 合成书：TXT 由本适配器造、feed 文章与本地 HTML 由 readerView 造（见
			// core/feedBookFactory.ts / core/htmlBook.ts）。三种都是「每节一个 blob URL」，
			// 一律记下来交给 destroy() 回收 —— 漏记就是每开一次书漏一份常驻内存
			// （HTML 是每节一个 URL，比 feed 的单节形态更容易累积）。
			if ((bookOrFile as SyntheticBook | null)?.__unreaderTxt) {
				this.syntheticBook = bookOrFile
			}
			return this.openWithTimeout(el, () => el.open(bookOrFile))
		}
		if (!isTxtFile(bookOrFile as File)) {
			return this.openWithTimeout(el, () => el.open(bookOrFile))
		}
		return this.openWithTimeout(el, async () => {
			const book = await makeTxtBook(bookOrFile as File)
			// 记住它：destroy() 时回收章节 blob URL（见 syntheticBook 字段注释）
			this.syntheticBook = book
			await el.open(book)
		})
	}

	/** open 加超时兜底：zip 损坏/超大书解析悬挂时不再永久卡在「正在打开」
	 *  （分页 init 早有 15s race，这里给两个模式的 open 补齐对称保护）。
	 *  入参是 thunk 而非 File —— TXT 那条路要先做一次异步合成才能拿到 open 的目标。 */
	private openWithTimeout(el: RawFoliateView, open: () => Promise<void>, ms = 15000): Promise<void> {
		const p = open()
		void p.catch(() => { /* 超时胜出后迟到的拒绝也消费掉，避免 unhandledrejection */ })
		let timer = 0
		return Promise.race([
			p,
			new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error("书籍解析超时")), ms)
			}),
		]).finally(() => { if (timer) window.clearTimeout(timer) })
	}

	/**
	 * 探测当前 book 格式：EPUB / MOBI / TXT 三者在 foliate-js 里有关键差异
	 *   - `book.loadText` / `book.loadBlob`：EPUB 有，MOBI 与合成书都没有
	 *   - `book.sections[i].id`：EPUB 是 string（href），MOBI 与合成书是 number（章节下标）
	 *   - `book.sections[i].load`：EPUB 没有，MOBI 与合成书有（返回已渲染好的 blob URL）
	 * 区分依据：`sections[0].id` 类型（number → 非 EPUB），再按合成书的
	 * `__unreaderTxt` 标记把 TXT 从 MOBI 里分出来 —— id 类型区分不了这两者。
	 */
	private detectFormat(book: unknown): "epub" | "mobi" | "txt" {
		if ((book as SyntheticBook | null)?.__unreaderTxt) return "txt"
		const sec = (book as { sections?: { id?: unknown }[] } | null)?.sections?.[0]
		return typeof sec?.id === "number" ? "mobi" : "epub"
	}

	async load(target: BookOpenTarget, lastLocation: string | undefined, appearance: AppearanceSettings): Promise<BookMetadata> {
		const el = this.el
		if (!el) throw new Error("Engine not mounted")
		this.highlights.clear()
		// 当前唯一支持的阅读模式：连续滚动（分页模式已删除）
		return this.loadContinuous(target, lastLocation, appearance)
	}

	/** 恢复位置 token → 目标**渲染**章节下标（跳过 `linear="no"` 的分部标题页——
	 *  它们没有渲染占位，几何上永远归不到自己名下）。解析规则与 `renderContinuous`
	 *  建占位时一致：优先向后找，找不到再向前。 */
	private resolveRestoreIndex(pos: string): number | null {
		const raw = this.sectionIndexFromPos(pos)
		if (raw == null) return null
		const secs = (this.el?.book as unknown as { sections?: { linear?: string }[] } | null)?.sections ?? []
		const included = (i: number): boolean => { const s = secs[i]; return !!s && s.linear !== "no" }
		let target: number | null = null
		for (let i = raw; i < secs.length; i++) if (included(i)) { target = i; break }
		if (target == null) for (let i = raw - 1; i >= 0; i--) if (included(i)) { target = i; break }
		return target
	}

	/* ---------------- 开书「恢复上次阅读位置」的落定闸门 ----------------
	 *
	 *  为什么需要：恢复落点靠 `absContentTop` / `offsetHeight` 计算，而开书期间
	 *  `.unreader-root` 还没有 `has-book`（CSS 里 `.unreader-stage` 是 display:none）
	 *  → 几何全是 0，落不了地。旧流程却在 `load()` 一返回就揭示正文，于是用户看到
	 *  「先开在书首、再跳到上次位置」。视图层现在 `await whenRestored()` 之后再揭示。
	 *
	 *  闸门必须**有上限**：目标章迟迟渲染不出来（超大书/慢设备）时不能让用户永远
	 *  停在「正在打开…」。上限到点即放行——此时视口已被「视口预置」放在目标章上，
	 *  放行也停在目标章附近，而不是书首。 */

	private restoreGate: Promise<void> = Promise.resolve()
	private restoreGateDone: (() => void) | null = null
	/** 闸门开启期间的目标章：**补载一律收敛到它**（见 ensureFilled / pumpLoadToward）。
	 *  恢复落定只需要目标章自己的几何，而每多装一章都要占主线程 —— 实测 144 章书
	 *  开书期并发 6 章时 `getSectionDoc` 各 610~640ms（wall clock 几乎同时结束 =
	 *  它们在原地排队），把「目标章就绪」从 ~100ms 拖到 ~640ms，再由收敛循环
	 *  等它稳定 → 揭示被推到 1.5s 量级。邻章留到落定后由视口参照补载接手。 */
	private restoreFocusIdx: number | null = null

	/** 还没落定的恢复定位（开书时容器没有真实视口 → 落点算不出来）：
	 *  由 `notifyVisible()` 在拿到尺寸后补落一次。用户一旦自己滚动过就作废（不抢控制权）。 */
	private restorePending: { idx: number; frac?: number } | null = null

	/** 本次开书恢复定位的落定信号（无恢复位置时立即 resolve）。 */
	whenRestored(): Promise<void> {
		return this.restoreGate
	}

	/** 打开闸门（`loadContinuous` 调用）。先把上一本还没关的闸门放行，
	 *  避免「恢复等待期间用户换了本书」时上一个 await 永久悬挂。 */
	private openRestoreGate(restoreIdx: number | null): void {
		this.closeRestoreGate()
		if (restoreIdx == null) { this.restoreGate = Promise.resolve(); return }
		this.restoreFocusIdx = restoreIdx
		let resolve: () => void = () => { /* noop */ }
		const p = new Promise<void>(r => { resolve = r })
		const close = (): void => {
			// **超时也必须解开「只载目标章」的收敛**（这条曾经漏掉，代价是整本书再也不会补载）：
			// 超时路径不经过 closeRestoreGate，只 resolve 的话 `restoreFocusIdx` 会永久留着
			// → `ensureFilled` / `pumpLoadToward` 永远只装那一章，用户滚动过去全是空白占位，
			// 但容器高度/翻页照常 —— 表现为「能翻页、没有正文」（iPad 重载 Obsidian 时启动期
			// CPU 饱和，5s 闸门很容易超时，正是这个场景）。按**代际**清：只有本轮的目标章
			// 与当前 focus 一致时才清，别把新书（换代）的收敛目标误清。
			if (this.restoreFocusIdx === restoreIdx) this.restoreFocusIdx = null
			if (this.restoreGateDone === close) this.restoreGateDone = null
			resolve() // 幂等：重复 resolve 无害，但能让超时与落地两条通路互不干扰
		}
		this.restoreGate = p
		this.restoreGateDone = close
		window.setTimeout(close, this.restoreGateMs())
	}

	/** 关闸门（幂等）：恢复落地、被新跳转取代、或上限到点都走这里。
	 *  同时解除「只载目标章」的收敛（落定后邻章立刻照常补载）。
	 *  只关「当前」闸门——上一轮的超时定时器不会误关新一轮。 */
	private closeRestoreGate(): void {
		this.restoreFocusIdx = null
		const done = this.restoreGateDone
		this.restoreGateDone = null
		done?.()
	}

	/** 「恢复期只载目标章」当前是否有效：**必须同时有闸门在等待**。
	 *  这是那条收敛的**自愈守卫**——闸门无论以哪条路径收场（落地/被取代/超时），
	 *  `restoreGateDone` 都会置空，收敛随即失效，不可能永久卡住补载
	 *  （补齐「超时忘记清 focus」那类漏网：宁可少省一点，也不能让整本书不渲染）。 */
	private restoreFocusActive(): boolean {
		return this.restoreFocusIdx != null && this.restoreGateDone != null && this.restoreFocusEnabled()
	}

	/** 闸门上限（ms）。调试开关 `localStorage["unreader-restore-gate-ms"]`：
	 *  设 0 = 立即放行 = 改动前的揭示时机（回归的阴性对照）。 */
	private restoreGateMs(): number {
		try {
			const v = window.localStorage.getItem("unreader-restore-gate-ms")
			if (v != null) {
				const n = Number(v)
				if (Number.isFinite(n) && n >= 0) return n
			}
		} catch { /* ignore */ }
		return IS_MOBILE_LIKE_THRESHOLD ? 5000 : 3500
	}

		/** 连续模式位置历史：跳转/翻页前压栈当前 CFI，「回到上一位置」弹出恢复。
	 *  foliate 自身 history 只记录走 renderer 的导航，连续模式全部绕过它 → 按钮永不显示 */
	private contHistory: string[] = []
	private contHistoryLock = false
	private contLastCfi: string | null = null

	private pushContHistory(): void {
		if (this.contHistoryLock) return
		// 同步回退：relocate 是 rAF 节流的，连点跳转时 contLastCfi 可能还是旧值，
		// 直接按当前视口现算，保证每次跳转都有可返回的位置
		const cfi = this.contLastCfi ?? this.currentContCfi()
		if (backDebugOn()) {
			debugInfo("[UNreader][back] push", {
				hasCfi: !!cfi,
				hasLast: !!this.contLastCfi,
				before: this.contHistory.length,
			})
		}
		if (!cfi) return
		if (this.contHistory[this.contHistory.length - 1] === cfi) return
		this.contHistory.push(cfi)
		if (this.contHistory.length > 60) this.contHistory.shift()
	}

	/** 返回栈深度（调试日志用） */
	backStackSize(): number {
		return this.contHistory.length
	}

	/** 是否有程序化跳转在途（落地 + 漂移校正中）：视图层据此暂停返回按钮的隐藏计数 */
	isJumping(): boolean {
		return this.isContinuous && this.jumpPending
	}

	canGoBack(): boolean {
		if (this.isContinuous && this.continuousRendered) return this.contHistory.length > 0
		return !!this.el?.history?.canGoBack
	}

	goBack(): void {
		if (this.isContinuous && this.continuousRendered) {
			const cfi = this.contHistory.pop()
			if (!cfi) return
			this.contHistoryLock = true
			void this.jumpToCfi(cfi).finally(() => { this.contHistoryLock = false })
			return
		}
		try {
			this.el?.history.back()
		} catch (e) {
			console.error("[UNreader] go back failed", e)
		}
	}

	applyAppearance(appearance: AppearanceSettings): void {
		this.lastAppearance = appearance
		const el = this.el
		if (!el?.renderer) return
		// 唯一支持的阅读模式：连续滚动（分页已删除）
		if (!this.isContinuous) {
			this.isContinuous = true
		}
		const r = el.renderer as unknown as HTMLElement & { render?: () => void }
		if (!r?.setAttribute) return
		r.setAttribute("flow", "scrolled")
		r.removeAttribute("animated")
		r.setAttribute("max-inline-size", "720px")
		this.applyThemeStyles(appearance)
		this.loadContinuousTheme(appearance)
	}


	applyThemeStyles(appearance: AppearanceSettings): void {
		const r = this.el?.renderer as unknown as { setStyles?: (s: string) => void } | undefined
		if (!r?.setStyles) return
		try {
			r.setStyles(buildThemeCss(resolveAppearance(appearance)))
		} catch (e) {
			console.error("[UNreader] apply theme styles failed", e)
		}
	}

	getMetadata(): BookMetadata {
		const meta = this.el?.book?.metadata ?? {}
		return {
			title: localizeValue(meta.title),
			author: localizeValue(meta.author),
			language: localizeValue(meta.language),
		}
	}

	getToc(): TocItem[] {
		return this.el?.book?.toc ?? []
	}

	/** href -> 章节 index：先走 foliate resolveHref，退化为路径后缀匹配 */
	/** MOBI/AZW3 的 href → 章节 index（**同步**）。
	 *
	 *  背景（踩过的坑）：KF8（=AZW3）的 `book.resolveHref` 是 `async`（mobi.js:1205），
	 *  内部只有 `getIndexByFID(fid)` 是同步的，其余是「读 frag 字节 + 解出选择器」的真 I/O。
	 *  上层的 href→section 映射（目录标题归属、filepos 位置解析）全是同步调用链，
	 *  于是 KF8 书在所有同步路径上取 `.index` 恒为 undefined → tocIdBySection 空 →
	 *  **章节标题全为 null**（标注侧栏无章节名、复制引用章节名为空），文件名兜底也不命中
	 *  （MOBI 的 section 是数字 id，没有 href 可供字符串比对）。
	 *
	 *  两个 MOBI 类都实现了同步的 `splitTOCHref`（mobi.js:880 / 1219），KF8 版直接
	 *  返回 `[getIndexByFID(fid), pos]`——正好是我们要的那一半，且不触发任何 I/O。
	 *  MOBI6 的 `resolveHref` 本就是同步的（mobi.js:872），先走它。 */
	private resolveMobiHrefSync(href: string): number | null {
		const book = this.el?.book as unknown as {
			resolveHref?: (h: string) => unknown
			splitTOCHref?: (h: string) => [unknown, unknown] | undefined
		} | null
		if (!book) return null
		// MOBI6 同步 resolveHref（异步版会返回 Promise，不是对象 → 落空）
		try {
			const r = book.resolveHref?.(href) as { index?: unknown } | undefined
			if (r && typeof r.index === "number" && r.index >= 0) return r.index
		} catch { /* ignore */ }
		// KF8：splitTOCHref 同步，命中即用
		try {
			const r = book.splitTOCHref?.(href)
			const idx = Array.isArray(r) ? r[0] : undefined
			if (typeof idx === "number" && idx >= 0) return idx
		} catch { /* ignore */ }
		return null
	}

	private resolveTocHrefToSection(href: string): number | null {
		const book = this.el?.book as unknown as
			| { resolveHref?: (href: string) => unknown; sections?: { href?: string }[] }
			| null
		if (!book) return null
		let idx: number | null = null
		try {
			const resolved = book.resolveHref?.(href)
			if (resolved && typeof (resolved as { index?: unknown }).index === "number") idx = (resolved as { index: number }).index
		} catch {
			// ignore
		}
		// MOBI/AZW3：KF8 的 resolveHref 是 async（同步取 .index 必然落空），
		// 用同步的 getIndexByFID 通道补上，否则目录项全无章节归属
		// 非 EPUB（MOBI 的 KF8 与 TXT 合成书）：section.id 是数字下标、没有 href 可做
		// 路径比对，归属只能靠同步的 resolveHref/splitTOCHref
		if (idx == null && this.bookFormat !== "epub") idx = this.resolveMobiHrefSync(href)
		if (idx == null) {
			const path = href.split("#")[0] ?? ""
			const secs = book.sections
			if (path && secs) {
				for (let i = 0; i < secs.length; i++) {
					const sh = secs[i]?.href ?? ""
					if (!sh) continue
					if (sh === path || sh.endsWith("/" + path) || path.endsWith("/" + sh)) {
						idx = i
						break
					}
				}
			}
		}
		return idx
	}

	private buildTocSectionMap(): void {
		this.tocIdBySection.clear()
		this.sortedTocSections = []
		const book = this.el?.book as unknown as { toc?: TocItem[] } | null
		if (!book?.toc) return
		const flat: TocItem[] = []
		const collect = (items: TocItem[]): void => {
			for (const it of items) {
				flat.push(it)
				if (it.subitems?.length) collect(it.subitems)
			}
		}
		collect(book.toc)
		for (const item of flat) {
			if (!item.href || typeof item.id !== "number") continue
			const idx = this.resolveTocHrefToSection(item.href)
			if (idx != null && !this.tocIdBySection.has(idx)) {
				this.tocIdBySection.set(idx, item.id)
			}
		}
		this.sortedTocSections = [...this.tocIdBySection.keys()].sort((a, b) => a - b)
	}

	/** 未被目录覆盖章节的派生标题 / 合成高亮键（负数，不与目录 id 冲突） */
	private sectionNavTitles = new Map<number, string>()
	/** 其中**标题来自真 h1-h6** 的子集：仅这个子集可作为标注章节名首选 */
	private sectionNavHeadingTitles = new Map<number, string>()
	private sectionNavKeys = new Map<number, number>()

	/** 等「首屏真正可见」：本次开书的补载已建立（continuousRendered）且首个章节
	 *  frame 已接线渲染完成（firstFrameLogged）。
	 *
	 *  为什么必须等：buildSectionNav 要逐章 createDocument()（整章 HTML 解析），
	 *  是本次开书里最重的后台任务。实测（test:openperf，CPU 4× 节流）它与
	 *  restore 完全重叠 —— 17 章书里 sectionNav 813ms、restore 1462ms，144 章长书
	 *  里 sectionNav 461ms 落在 firstFrame（1047ms）之前，两者互相拖慢，
	 *  表现就是「书已经显示了，但头一两秒滑不动 / 点不动」。
	 *
	 *  ⚠️ 判据不能用 jumpPending：无恢复位置时它全程为 false（只在 scrollToIndex /
	 *  goToSection 里置位），后台任务会在解析期就直接抢跑（实测 sectionNav 461ms
	 *  结束时 firstFrame 还没到）。seq 用于「用户已开了别的书」时整体放弃。
	 *  上限 maxWaitMs 兜底，慢设备上目录最终仍会补全。 */
	private async waitForFirstScreen(seq: number, maxWaitMs = 8000): Promise<void> {
		const t0 = performance.now()
		while (performance.now() - t0 < maxWaitMs) {
			if (this.openSeq !== seq) return
			if (this.continuousRendered && this.firstFrameLogged) break
			await new Promise<void>(r => window.setTimeout(r, 50))
		}
		await this.waitForBookSettled(maxWaitMs)
	}

	/** 等「恢复/跳转落地」（jumpPending 落回 false），再等两帧绘制提交。 */
	private async waitForBookSettled(maxWaitMs = 6000): Promise<void> {
		const t0 = performance.now()
		while (performance.now() - t0 < maxWaitMs) {
			if (!this.jumpPending) break
			await new Promise<void>(r => window.setTimeout(r, 150))
		}
		// 落地后仍有一次重排（邻章占位换实测高度），等两帧确保首屏已提交
		await nextPaint()
	}

	/** 书源目录缺失子章节时（如"唐璜主义"只存在于正文而无 navPoint），
	 *  为未覆盖章节从文档首个标题派生目录条目，供浮动目录条补全。
	 *  后台分块执行：每解析一章检查耗时预算，超 12ms 让路给浏览器空闲；
	 *  且**整体延后到首屏可见之后**才开跑（见 waitForFirstScreen），
	 *  不与首帧渲染/恢复定位抢主线程。完成后 onNavDerived 通知宿主增量刷新目录。 */
	private async buildSectionNav(seq: number): Promise<void> {
		this.sectionNavTitles.clear()
		this.sectionNavHeadingTitles.clear()
		this.sectionNavKeys.clear()
		const book = this.el?.book as unknown as
			| { sections?: ({ linear?: string; createDocument?: () => Promise<Document> })[] }
			| null
		const secs = book?.sections
		if (!secs) return
		perfBegin("sectionNav")
		// 先让路一次：确保调用点即使没走 waitForFirstScreen（如 relayout 重入）
		// 也不会把首帧挤到后面
		await idleYield()
		let chunkStart = performance.now()
		for (let i = 0; i < secs.length; i++) {
			if (this.openSeq !== seq) return // 换书了，立即收手（也别 perfEnd 污染新书日志）
			if (this.tocIdBySection.has(i)) continue
			const sec = secs[i]
			if (!sec || sec.linear === "no" || !sec.createDocument) continue
			// 期间若发生跳转/恢复（用户点目录、恢复重入），立刻让路 ——
			// 后台派生标题永远不该与用户的跳转争主线程
			if (this.jumpPending) {
				await this.waitForBookSettled(3000)
				chunkStart = performance.now()
			}
			try {
				const doc = await sec.createDocument()
				const derived = this.deriveSectionTitle(doc)
				if (derived) {
					this.sectionNavTitles.set(i, derived.text)
					if (derived.fromHeading) this.sectionNavHeadingTitles.set(i, derived.text)
					this.sectionNavKeys.set(i, -(i + 1))
				}
			} catch {
				// ignore
			}
			// 让出主线程到浏览器空闲：连续大量 DOMParser 同步解析会卡住首帧渲染与滚动。
			// 用 idleYield 而非 setTimeout(0) —— 后者与渲染同优先级，会插队到
			// 首帧绘制与滚动帧之间（实测滚动帧 p95 因此抬高）
			if (performance.now() - chunkStart > 12) {
				await idleYield()
				chunkStart = performance.now()
			}
		}
		perfEnd("sectionNav")
		this.handlers?.onNavDerived?.()
	}

	/** 从章节文档提取标题：首个非空 h1-h6，退化为 <title>。
	 *  `fromHeading` 区分来源——退化到 <title> 时拿到的常常是**书名**或 Calibre
	 *  转换残留的整段正文（实测《呐喊》标题是 40 字段落），只能当兜底，不能当准。 */
	private deriveSectionTitle(doc: Document): { text: string; fromHeading: boolean } | null {
		let t = ""
		try {
			for (const sel of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
				for (const h of Array.from(doc.querySelectorAll(sel))) {
					const s = (h.textContent ?? "").replace(/\s+/g, " ").trim()
					if (s) { t = s; break }
				}
				if (t) break
			}
			if (t) return { text: t.length > 60 ? t.slice(0, 60) + "…" : t, fromHeading: true }
			const dt = (doc.title ?? "").replace(/\s+/g, " ").trim()
			if (!dt) return null
			return { text: dt.length > 60 ? dt.slice(0, 60) + "…" : dt, fromHeading: false }
		} catch {
			// ignore
		}
		return null
	}

	/** 浮动目录条目：目录树按阅读顺序展平，未覆盖章节的派生条目插入其间 */
	getNavEntries(): NavEntryModel[] {
		const book = this.el?.book as unknown as { toc?: TocItem[]; sections?: unknown[] } | null
		if (!book?.toc) return []
		const flat: { label: string; href: string; id: number | null; depth: number; sec: number | null }[] = []
		const collect = (items: TocItem[], depth: number): void => {
			for (const it of items) {
				if (it.href) {
					flat.push({
						label: (it.label ?? "").trim() || "（无标题）",
						href: it.href,
						id: typeof it.id === "number" ? it.id : null,
						depth: Math.min(depth, 3),
						sec: this.resolveTocHrefToSection(it.href),
					})
				}
				if (it.subitems?.length) collect(it.subitems, depth + 1)
			}
		}
		collect(book.toc, 0)
		const total = book.sections?.length ?? 0
		const out: NavEntryModel[] = []
		let lastSec = -1
		let lastDepth = 0
		let prevDerived = ""
		const pushDerived = (from: number, to: number, coverLabel: string, depth: number): void => {
			for (let i = from; i < to; i++) {
				const title = this.sectionNavTitles.get(i)
				// 与所属目录条目或相邻派生条目同名时跳过（Calibre 拆分页共用 <title> 会产生重复行）
				if (!title || title === coverLabel || title === prevDerived) continue
				prevDerived = title
				out.push({ label: title, href: "", id: null, navKey: this.sectionNavKeys.get(i) ?? null, depth: Math.min(3, depth + 1), sectionIndex: i })
			}
		}
		for (const t of flat) {
			if (t.sec != null && t.sec > lastSec) {
				pushDerived(lastSec + 1, t.sec, t.label, t.depth)
				lastSec = t.sec
			}
			lastDepth = Math.max(lastDepth, t.depth)
			out.push({ label: t.label, href: t.href, id: t.id, navKey: t.id, depth: t.depth, sectionIndex: null })
		}
		pushDerived(lastSec + 1, total, "", lastDepth)
		return out
	}

	/** 按章节 index 跳转（派生目录条目走这里） */
	async goToSection(idx: number): Promise<void> {
		if (this.isContinuous && this.continuousRendered) {
			this.jumpToSection(idx, (_d, _f, ridx) => this.sectionScrollTop(ridx))
			this.focusContent()
			return
		}
		try {
			await this.el?.goTo(idx)
		} catch {
			// ignore
		}
		this.focusContent()
	}

	/** 分部标题页（只含标题的独立页面）处理：
	 *  ① 标记 `linear="no"` 从阅读流移除（renderContinuous / findAdjacentIndex /
	 *     buildSectionNav / 搜索 / 字节统计 / 位置恢复全链路据此跳过）；
	 *  ② 把它的标题内容并入该部**首个实章节的开头**——否则用户点目录「荒诞推理」
	 *     只会看到子章「荒诞与自杀」的正文，大标题彻底消失（实测 section 4/9/14
	 *     inOrder=false、wrapH=null，标题在阅读体验中不存在）。 */
	private partHeadHtml = new Map<number, string>()

	private async mergePartTitles(): Promise<void> {
		const book = this.el?.book as unknown as {
			toc?: TocItem[]
			sections?: { href?: string; linear?: string }[]
			resolveHref?: (href: string) => { index?: number }
		} | null
		if (!book?.toc || !book.sections) return
		// 只对 EPUB 生效。判据里的 `p.calibre5` 是 Calibre 转换 EPUB 的专有 class，对
		// 非 EPUB 的书恒为 0，于是「有 h1/h2 + 正文 < 400 字 + 该目录项有子项」就足以让
		// 一节被判成分部标题页 → 标 `linear="no"`（该章从阅读流里消失、内容并进下一章）。
		// 目前 TXT 合成书的目录是扁平的（无 subitems）天然短路，但这条启发式不该靠运气。
		if (this.bookFormat !== "epub") return
		this.partHeadHtml.clear()
		const parts: { idx: number; headHtml: string }[] = []
		const flatWithDepth: { item: TocItem; depth: number }[] = []
		const collectDepth = (items: TocItem[], d: number): void => {
			for (const it of items) {
				flatWithDepth.push({ item: it, depth: d })
				if (it.subitems?.length) collectDepth(it.subitems, d + 1)
			}
		}
		collectDepth(book.toc, 0)
		// 判定：只有「顶层 + 带子项」的目录项才可能是分部标题页，再以内容特征确证
		// （含 h1/h2、正文极短、几乎没有段落）。**此处不得再写书级特判**——
		// 「带子项」这条已天然排除无子项的普通章节（如《西西弗神话》的 chapter_00002），
		// 曾经那行 `label.includes(...)` 既是死代码，又会误伤任何标题含该串的书。
		for (const { item, depth } of flatWithDepth) {
			if (depth !== 0 || !item.subitems?.length || !item.href) continue
			let idx: number | null = null
			try {
				const r = book.resolveHref?.(item.href)
				if (r && typeof r.index === "number") idx = r.index
			} catch { /* ignore */ }
			if (idx == null) continue
			try {
				const sec = book.sections[idx] as unknown as { createDocument?: () => Promise<Document> }
				if (!sec?.createDocument) continue
				const doc = await sec.createDocument()
				const textLen = (doc.body?.textContent || "").trim().length
				const hasH1 = !!doc.querySelector("h1, h2")
				const longParas = doc.querySelectorAll("p.calibre5").length
				if (hasH1 && textLen < 400 && longParas <= 1) {
					parts.push({ idx, headHtml: this.extractPartHeadHtml(doc) })
				}
			} catch { /* ignore */ }
		}
		for (const { idx, headHtml } of parts) {
			const partItem = flatWithDepth.find(f => {
				try { return book.resolveHref?.(f.item.href ?? "")?.index === idx } catch { return false }
			})?.item
			const firstChildHref = partItem?.subitems?.[0]?.href
			if (!firstChildHref) continue
			let childIdx: number | null = null
			try {
				const r = book.resolveHref?.(firstChildHref)
				if (r && typeof r.index === "number") childIdx = r.index
			} catch { /* ignore */ }
			if (childIdx == null || childIdx <= idx) continue
			// 该部标题页不再独立成页：线性翻页/搜索/字节统计/位置恢复全程跳过它
			const sec = book.sections[idx] as unknown as { linear?: string }
			if (sec.linear !== "no") (sec).linear = "no"
			// 标题内容改并入首个子章（buildSectionHtml 注入），一个子章只吃一次
			if (headHtml && !this.partHeadHtml.has(childIdx)) this.partHeadHtml.set(childIdx, headHtml)
		}
		// 注意：**不需要**把 part 的 tocId 重映射到 childIdx。紧随其后的第二次
		// buildTocSectionMap 会用 part 自己的 href 重建出「part idx → part tocId」；
		// 目录高亮由 contStickySection 拿**原始目标章索引**直接命中那一项，
		// 子章也用自己原有的 tocId——两者互不干扰。（旧代码在此 delete/set，
		// 随即被第二次 buildTocSectionMap 覆盖，是一段从未生效的死代码。）
	}

	/** 提取分部标题页的可见正文（并入子章开头用）。
	 *  必须用 `innerHTML`（HTML 序列化器）：`XMLSerializer` 会把 `<style>` 文本里的
	 *  `>`/`&` 转义成实体，插入后按 HTML 解析时 style 是 raw text、不解码实体 →
	 *  书内 CSS 规则静默失效（与 serializeFrameHtml 同一个坑）。 */
	private extractPartHeadHtml(doc: Document): string {
		const body = doc.body
		if (!body) return ""
		const clone = body.cloneNode(true) as HTMLElement
		for (const el of Array.from(clone.querySelectorAll("script, style, link, nav"))) el.remove()
		return clone.innerHTML.trim()
	}

	private getSectionIndexForCfi(cfi: string): number | null {
		// MOBI/AZW3 必须走我们自己的 step 反推，不能用 view.resolveCFI 的兜底：
		// book 没有 resolveCFI → 落进 `CFI.fake.toIndex((parts.parent ?? parts).shift())`，
		// 而 .shift() 只取到 parent 数组的**首元素** {index:6}（不是 itemref 那一级），
		// fake.toIndex 对它算出常量 2 → 任何 CFI 都反解成第 2 章 →
		// 章节标题永远显示同一章（probe 实测 section 0/1/2 标签完全相同）。
		// sectionIndexFromCfi 的 itemStep/2-1 与 rangeCFI 生成端（contBaseCfi）同口径。
		// TXT 合成书同理（它也没有 book.resolveCFI，CFI 全部由 contBaseCfi 合成）。
		if (this.bookFormat !== "epub") return this.sectionIndexFromCfi(cfi)
		try {
			const v = this.el as unknown as { resolveCFI?: (c: string) => { index: number } } | null
			const r = v?.resolveCFI?.(cfi)
			if (r && typeof r.index === "number") return r.index
		} catch {
			// ignore
		}
		try {
			const b = this.el?.book as unknown as { resolveCFI?: (c: string) => { index: number } } | null
			const r = b?.resolveCFI?.(cfi)
			if (r && typeof r.index === "number") return r.index
		} catch {
			// ignore
		}
		// 末位兜底：CFI 解析失败（旧数据/畸形）时按 step 反推，比直接 null 好
		return this.sectionIndexFromCfi(cfi)
	}

	/** 同步版：CFI -> 所属章节 tocId，不创建 Document，不会卡死。 */
	getTocIdForCfiSync(cfi: string): number | null {
		const idx = this.getSectionIndexForCfi(cfi)
		if (idx == null) return null
		return this.nearestTocIdForSection(idx)
	}

	/** CFI -> 目录条高亮键：派生条目优先（更精确），回退最近前驱目录条目 */
	private navKeyForCfi(cfi: string): number | null {
		const idx = this.getSectionIndexForCfi(cfi)
		if (idx == null) return null
		return this.sectionNavKeys.get(idx) ?? this.nearestTocIdForSection(idx)
	}

	/** 章节 index -> tocId：优先精确映射；未收录章节回退到「最近的前一个目录条目」，
	 *  保证目录条在全书任何位置都能指示当前阅读位置。 */
	private nearestTocIdForSection(idx: number): number | null {
		let best: number | null = null
		for (const sec of this.sortedTocSections) {
			if (sec <= idx) best = sec
			else break
		}
		if (best != null) return this.tocIdBySection.get(best) ?? null
		if (this.sortedTocSections.length) {
			const first = this.sortedTocSections[0]!
			if (idx < first) return this.tocIdBySection.get(first) ?? null
		}
		return null
	}


	/** 同步版：CFI -> 所属章节标题（目录原文），不创建 Document，不会卡死。 */
	getChapterLabelForCfi(cfi: string): string | null {
		const idx = this.getSectionIndexForCfi(cfi)
		// 1) 真标题（h1-h6）最准：目录未覆盖的章节（封面/版权页/前言）拿不到 toc 条目，
		//    而 nearestTocIdForSection 会把它们一律归到「第一个目录条目」上 → 前页全部
		//    显示成第 1 章标题。派生标题是该章正文首个 h1/h2，天然更准。
		if (idx != null) {
			const heading = this.sectionNavHeadingTitles.get(idx)?.trim()
			if (heading) return heading
		}
		const tocId = this.getTocIdForCfiSync(cfi)
		if (tocId == null) {
			// 2) 无任何目录归属时退到宽松派生标题（可能来自 <title>：书名/转换残留），
			//    总比 null 好，但排在 toc 标签之后
			return idx != null ? (this.sectionNavTitles.get(idx)?.trim() || null) : null
		}
		const flat: TocItem[] = []
		const collect = (items: TocItem[]): void => {
			for (const it of items) {
				flat.push(it)
				if (it.subitems?.length) collect(it.subitems)
			}
		}
		collect(this.getToc())
		const found = flat.find(it => it.id === tocId)
		const label = found?.label?.trim()
		return label ? label : null
	}

	hasBook(): boolean {
		return !!this.el?.book
	}

	getScrollMetrics(): { start: number; end: number; viewSize: number; size: number } | null {
		const cont = this.continuousEl
		if (this.isContinuous && cont && this.continuousRendered) {
			return { start: cont.scrollTop, end: cont.scrollTop + cont.clientHeight, viewSize: cont.scrollHeight, size: cont.clientHeight }
		}
		const r = this.el?.renderer as unknown as
			| { start?: number; end?: number; viewSize?: number; size?: number }
			| undefined
		if (!r || typeof r.start !== "number" || typeof r.end !== "number") return null
		const start = r.start
		const end = r.end
		const viewSize = typeof r.viewSize === "number" ? r.viewSize : 0
		const size = typeof r.size === "number" ? r.size : 0
		return { start, end, viewSize, size }
	}

	isAtSectionTop(): boolean {
		if (this.isContinuous) return !!(this.continuousEl && this.continuousEl.scrollTop <= 4)
		const m = this.getScrollMetrics()
		if (!m) return false
		if (m.viewSize <= m.size + 4) return true
		return m.start <= 4
	}

	isAtSectionBottom(): boolean {
		if (this.isContinuous) {
			const cont = this.continuousEl
			return !!cont && (cont.scrollHeight - (cont.scrollTop + cont.clientHeight) <= 4)
		}
		const m = this.getScrollMetrics()
		if (!m) return false
		if (m.viewSize <= m.size + 4) return true
		return m.viewSize - m.end <= 4
	}

	/** 是否存在上一章/下一章（基于 book.sections 的线性章节）。 */
	canGoPrevSection(): boolean {
		return this.findAdjacentIndex(-1) != null
	}

	canGoNextSection(): boolean {
		return this.findAdjacentIndex(1) != null
	}

	getCurrentIndex(): number {
		return this.currentIndex
	}


	private findAdjacentIndex(dir: -1 | 1): number | null {
		const sections = this.el?.book?.sections as unknown as { linear?: string }[] | undefined
		if (!sections) return null
		for (let i = this.currentIndex + dir; i >= 0 && i < sections.length; i += dir) {
			if (sections[i]?.linear !== "no") return i
		}
		return null
	}

	async nextSection(): Promise<void> {
		const idx = this.findAdjacentIndex(1)
		if (idx != null) {
			if (this.isContinuous && this.continuousRendered) { this.scrollToIndex(idx); this.focusContent(); return }
			await this.goTo(idx)
			return
		}
		await this.next()
	}

	async prevSection(): Promise<void> {
		const idx = this.findAdjacentIndex(-1)
		if (idx != null) {
			// 上一章定位到上一章「开头」（与下一章对称，也符合连续滚动下的阅读预期）；
			// 旧的章尾定位是分页模式「向前翻」语义的遗留
			if (this.isContinuous && this.continuousRendered) { this.scrollToIndex(idx); this.focusContent(); return }
			await this.goTo(idx)
			return
		}
		await this.prev()
	}

	async goTo(target: string | number): Promise<void> {
		if (this.isContinuous && this.continuousRendered) {
			if (typeof target === "number") {
				this.jumpToSection(target, (_d, _f, idx) => this.sectionScrollTop(idx))
				this.focusContent()
				return
			}
			const t = String(target)
			// href（可含 #fragment）优先走 book.resolveHref 拿 {index, anchor}；
			// CFI 只能取到章节号（章内精确定位交给标注/高亮点击通路）
			let resolved: { index: number; anchor?: unknown } | null = null
			const book = this.el?.book as unknown as { resolveHref?: (h: string) => unknown } | null
			try {
				// 必须 await：KF8(AZW3) 的 resolveHref 是 async（mobi.js:1205），同步取
				// `.index` 恒为 undefined → resolved 落空 → 退到 foliate 分页 renderer.goTo，
				// 连续模式下表现为「点了目录不跳 / 整页渲染错乱」
				const r = await Promise.resolve(book?.resolveHref?.(t))
				if (r && typeof (r as { index?: unknown }).index === "number") resolved = r as { index: number; anchor?: unknown }
			} catch { /* ignore */ }
			if (!resolved) {
				// 位置 token 统一走 sectionIndexFromPos（自动识别 CFI/filepos）
				const i = this.sectionIndexFromPos(t)
				if (i != null) resolved = { index: i }
			}
			// KF8 的 kindle:pos / kindle:embed 不在 sectionIndexFromPos 的 token 表内：
			// 走同步的 splitTOCHref 通道补章节号（否则 AZW3 目录点击必落空）。
			// TXT 合成书的 toc href 是纯章节下标字符串，sectionIndexFromPos 同样不认，
			// 也靠这条（它的 resolveHref/splitTOCHref 都是同步的）。
			if (!resolved && this.bookFormat !== "epub") {
				const i = this.resolveMobiHrefSync(t)
				if (i != null) resolved = { index: i }
			}
			// book.resolveHref 解析不了的裸相对路径：退化为章节级匹配
			if (!resolved && !/^epubcfi\(/.test(t)) {
				const i = this.resolveHrefToIndex(t)
				if (i != null) resolved = { index: i }
			}
			if (resolved) {
				const anchorFn = typeof resolved.anchor === "function" ? resolved.anchor as (doc: Document) => unknown : undefined
				if (anchorFn) void this.scrollToAnchorIn(resolved.index, anchorFn)
				else this.jumpToSection(resolved.index, (_d, _f, idx) => this.sectionScrollTop(idx))
				this.focusContent()
				return
			}
		}
		await this.el?.goTo(target)
		this.focusContent()
	}

	/** 跳转到已解析的目标 {index, anchor}（用于纯锚点链接的兜底导航）。 */
	async goToTarget(resolved: { index: number; anchor?: unknown }): Promise<void> {
		if (!this.el) return
		if (this.isContinuous && this.continuousRendered) {
			const anchorFn = resolved.anchor as ((doc: Document) => unknown) | undefined
			if (typeof anchorFn === "function") void this.scrollToAnchorIn(resolved.index, anchorFn)
			else this.jumpToSection(resolved.index, (_d, _f, idx) => this.sectionScrollTop(idx))
			this.focusContent()
			return
		}
		await this.el.renderer.goTo(resolved)
		// 目标可能是被 display:none 隐藏的注释体：在当前已渲染文档里临时显形
		try {
			const d = (this.el.renderer as unknown as {
				getContents?: () => { doc?: Document }[]
			}).getContents?.()?.[0]?.doc
			const anchorFn = resolved.anchor as ((doc: Document) => unknown) | undefined
			if (d && typeof anchorFn === "function") {
				const raw = anchorFn(d)
				let elx: Element | null = null
				if (raw instanceof Element) elx = raw
				else if (raw instanceof Range) {
					const c = raw.commonAncestorContainer
					elx = c.nodeType === 1 ? (c as Element) : (c.parentElement ?? null)
				}
				this.revealNoteAround(elx)
			}
		} catch { /* ignore */ }
		this.focusContent()
	}

	/** 连续模式：在目标 frame 文档内按锚点函数/文本定位并精确滚动 */
	private async scrollToAnchorIn(idx: number, anchorFn: (doc: Document) => unknown): Promise<void> {
		this.jumpToSection(idx, (d, _f, ridx) => {
			try {
				const raw = anchorFn(d)
				let elx: Element | null = null
				let text = ""
				let rect: DOMRect | null = null
				if (raw instanceof Element) { elx = raw; text = (raw.textContent ?? "").trim().slice(0, 80) }
				else if (raw instanceof Range) {
					text = raw.toString().trim().slice(0, 80)
					rect = raw.getBoundingClientRect()
					const c = raw.commonAncestorContainer
					elx = c.nodeType === 1 ? (c as Element) : (c.parentElement ?? null)
				}
				if (elx) this.revealNoteAround(elx)
				if (rect) return this.locateScrollTop(ridx, rect)
				if (elx) return this.locateScrollTop(ridx, elx.getBoundingClientRect())
				if (text) {
					const found = this.findRangeInElement(d.body, text)
					if (found) return this.locateScrollTop(ridx, found.getBoundingClientRect())
				}
			} catch { /* retry */ }
			return null
		})
	}

	async goToFraction(fraction: number): Promise<void> {
		const f = Math.min(1, Math.max(0, fraction))
		this.pushContHistory()
		// 取代进行中的章节跳转，避免其漂移校正循环把视图拽回旧目标
		this.jumpSeq++
		this.endJump()
		if (this.isContinuous && this.continuousRendered && this.continuousEl) {
			// 与 relocate 页码估算完全同源：fraction（页码中点）→ 目标字节位置 → 章节 + 章内字节占比。
			// 落点用「视口中心对齐目标点」，保证落地后 relocate 估算出的页码 == 输入页码
			// （此前把目标点对齐视口顶部，页码估算却按视口中心，落点整体超前半个视口 ≈ 1-2 页）
			const sizes = this.bookByteSizes()
			if (sizes) {
				const locTotal = Math.max(1, Math.ceil(sizes.total / 1500))
				const page = f * locTotal
				const targetPos = Math.min(sizes.total - 0.5, Math.max(0, (page - 0.5) * 1500))
				const hit = this.sectionByBytePos(targetPos)
				if (hit) {
					const { idx, secFrac } = hit
					this.jumpToSection(idx, (_d, _f, ridx) => {
						const cont = this.continuousEl
						const wrap = this.contSectionEls.get(ridx)
						if (!cont || !wrap || wrap.offsetHeight <= 0) return null
						const top = this.absContentTop(ridx, wrap)
						if (top == null) return null
						return top + wrap.offsetHeight * Math.min(0.98, secFrac) - cont.clientHeight / 2
					}, () => this.correctPageLanding(targetPos, 0))
					this.focusContent()
					return
				}
			}
			const cont = this.continuousEl
			this.contProgScrollUntil = performance.now() + 1000
			cont.scrollTo({ top: f * Math.max(0, cont.scrollHeight - cont.clientHeight), behavior: "smooth" })
			this.focusContent()
			return
		}
		await this.el?.goToFraction(f)
		this.focusContent()
	}

	async next(distance?: number): Promise<void> {
		if (this.isContinuous && this.continuousRendered) { await this.scrollContinuous(1, distance); this.focusContent(); return }
		await this.el?.next(distance)
		this.focusContent()
	}

	async prev(distance?: number): Promise<void> {
		if (this.isContinuous && this.continuousRendered) { await this.scrollContinuous(-1, distance); this.focusContent(); return }
		await this.el?.prev(distance)
		this.focusContent()
	}

	/* 分页模式已删除，原跟手翻页链路（beginPaginatedDrag/dragPaginated/endPaginatedDrag/
	   glideToPage/runPaginatedGlide/cancelPaginatedGlide/tryGlideTurn 等）全部移除。
	   翻页仅靠 foliate 原生 this.el?.next/prev（连续模式 scrollContinuous 仍保留）。 */

	/** 键盘翻页：连续模式原生滚动 0.8 页；分页模式已删，保留走 foliate 原生翻页。 */
	async scrollPage(dir: 1 | -1): Promise<void> {
		if (this.isContinuous && this.continuousRendered) { await this.scrollContinuous(dir); return }
		const m = this.getScrollMetrics()
		const dist = m ? m.size * 0.8 : undefined
		if (dir === 1) await this.next(dist)
		else await this.prev(dist)
	}

	/** 连续模式翻一屏（0.8 页）：先把滑动区间涉及的章节预载到真实高度，
	 *  再起滑——否则途中「占位(12vh)→真实高度」的膨胀会把阅读位置整体平移
	 *  （表现为第一次点上一页多退一页）。预载有界等待，超时照常起滑由补偿兜底 */
	private async scrollContinuous(dir: 1 | -1, distance?: number): Promise<void> {
		const cont = this.continuousEl
		if (!cont) return
		const amount = distance ?? cont.clientHeight * 0.8
		// 普通翻页不记历史：返回栈只收录主动跳转（目录/书签/搜索/脚注/页码等），
		// 与分页模式 foliate（next/prev 不 pushState）语义对齐；否则阅读几十页就会冲掉跳转记录
		const vpTop = cont.scrollTop
		const target = Math.max(0, Math.min(cont.scrollHeight - cont.clientHeight, vpTop + dir * amount))
		const rangeTop = Math.min(vpTop, target)
		const rangeBottom = Math.max(vpTop, target)
		const pending: number[] = []
		this.contSectionEls.forEach((w, i) => {
			if (w.classList.contains("unreader-loaded") || this.contFrames.get(i)?.doc) return
			const top = w.offsetTop
			const bottom = top + Math.max(1, w.offsetHeight)
			if (bottom >= rangeTop && top <= rangeBottom) pending.push(i)
		})
		if (pending.length) {
			void this.loadSections(pending)
			for (let n = 0; n < 25; n++) {
				if (pending.every(i => this.contFrames.get(i)?.doc)) break
				await new Promise(r => window.setTimeout(r, 100))
			}
			// 让出帧使刚渲染的章节完成首轮测高
			await new Promise(r => window.requestAnimationFrame(() => r(null)))
		}
		this.beginGlide(target)
		cont.scrollBy({ top: dir * amount, behavior: "smooth" })
	}

	/* 平滑滑动记录：滚动途中若视口上方章节补载/图片撑高，绝对目标值对应的内容点
	   会被平移（表现为翻页第一步多滚一页），补偿时需要据此恢复滑动 */
	private smoothGlide: { targetTop: number; timer: number } | null = null

	private clearGlide(): void {
		if (this.smoothGlide) {
			window.clearTimeout(this.smoothGlide.timer)
			this.smoothGlide = null
		}
	}

	private beginGlide(targetTop: number): void {
		this.clearGlide()
		const timer = window.setTimeout(() => { this.smoothGlide = null }, 1500)
		this.smoothGlide = { targetTop, timer }
	}

	/** 章节(iframe)高度变化时保持视觉位置稳定：
	 *  视口上方内容增删会平移当前阅读位置，按变化区域相对视口的位置比例补偿
	 *  scrollTop；若补偿打断了进行中的平滑滑动，则以平移后的目标重新起滑 */
	private compensateHeightShift(wrap: HTMLElement, oldWrapH: number, newWrapH: number, firstRender = false): void {
		const cont = this.continuousEl
		if (!cont || newWrapH === oldWrapH) return
		// 程序化跳转在途：视口正被驱动到目标，此时的补偿会与落地滚动打架（跳转抖动的主因）；
		// 落地精度由各跳转自带的漂移校正负责。用户翻页/阅读时的后台补载补偿不受影响
		// （翻页滑动不设 jumpPending，仍走补偿保稳定）。
		if (this.jumpPending) return
		const delta = newWrapH - oldWrapH
		const vpTop = cont.scrollTop
		const wrapTop = wrap.offsetTop
		const wrapBottom = wrapTop + oldWrapH
		let shift: number
		if (wrapBottom <= vpTop) {
			shift = delta // 整章在视口上方
		} else if (firstRender && wrapTop < vpTop) {
			// 未载占位章（12vh）跨视口顶膨胀为真实高度：占位区本身没有可读内容，
			// 其「视口上方那一段」不构成锚点，用户实际读的是后面章的内容——它们
			// 随本章底部整体下移 delta。必须全量补偿，否则表现为滑到该处时画面
			// 突然跳掉一整章（书末/深位置恢复后继续下滑时最明显）。
			// 跳转落地由上方 jumpPending 守卫，不会走到这里。
			shift = delta
		} else if (!firstRender && wrapTop < vpTop) {
			// 跨视口顶：按上方占比（适用于已渲染章节的内容增量：只补偿涨在视口上方那段）
			shift = delta * ((vpTop - wrapTop) / Math.max(1, oldWrapH))
		} else {
			return // 变化发生在视口内/下方，不影响阅读位置
		}
		if (!Number.isFinite(shift) || Math.abs(shift) < 1) return
		const glide = this.smoothGlide
		this.scrollContInstant(Math.max(0, vpTop + shift), "comp")
		if (glide) {
			const t = Math.max(0, glide.targetTop + shift)
			this.beginGlide(t)
			this.contProgScrollUntil = performance.now() + 1000
			cont.scrollTo({ top: t, behavior: "smooth" })
		}
	}

	/** **页首显隐「让位」的滚动补偿**（第六轮，桌面端沉浸模式）。
	 *
	 *  背景：沉浸模式隐藏页首时，`styles.css` 会把 `.unreader-root` 的盒子用负 margin
	 *  顶到叶子顶边、并**去掉原来那个等量 `padding-top`** —— 于是**内容盒顶边上移了
	 *  页首那一段（hole）**，那一段真的归正文了（用户原话：「那 36px 归正文」）。
	 *  但顶边上移会让正文**跟着往上跳一行**，而用户当初就是嫌这个才要求「隐藏页首、
	 *  正文不动」。解法：宿主在过渡的每一帧，把「内容顶边向上的位移」交给这里，
	 *  滚动位置同步上移同样的量 ⇒ 正文相对屏幕**像素级不动**，多出来的 hole
	 *  从顶部露出来（原先被视口顶边裁掉的那一段）。
	 *
	 *  三个要点（少一个就会「抖」）：
	 *   ① **瞬时定位，不用平滑滚动**：这是布局补偿，必须与几何变化同帧生效；平滑会让
	 *      文字在补偿期间自身漂移，反而看得见抖。**注意必须显式写 `behavior:"instant"`**：
	 *      容器的 CSS 是 `scroll-behavior: smooth`，直接给 `scrollTop` 赋值会被浏览器当成
	 *      平滑滚动 —— 于是每帧设的新目标都在打断上一帧的动画，净效果是**几乎不移动**
	 *      （实测 hide 方向位移为 0），而这一条用肉眼完全看不出来（几何在动、正文跟着动）。
	 *   ② **必须延长程序化滚动抑制窗口**（`contProgScrollUntil`）：补偿本身就在改
	 *      `scrollTop`，不抑制的话 `notifyScrollActive` 会把这段位移读成用户「向上滚」
	 *      → 宿主唤出工具栏 → 页首又回来 → 再补偿……**直接自激成抖**。抑制窗口内它
	 *      只推进锚点、不报方向，所以窗口一过也不会攒出一个假位移（见该函数的注释）。
	 *   ③ 平滑滑动（翻页按钮驱动的 `smoothGlide`）在途时，把同一个位移折进它的目标，
	 *      与 `compensateHeightShift` 同策；否则补偿会被那次滑动吃掉。
	 *
	 *  返回**实际**生效的位移（在书最开头 `scrollTop` 会被 clamp 到 0，补偿因此不足）——
	 *  调用方据此知道「这一帧没能完全补偿」，不必自己猜。 */
	/** 让位补偿的**理想滚动位置**（= 把每帧 delta 累加起来的值）。
	 *  为什么不直接逐帧 `scrollTop += delta`：`scrollTo({behavior:"instant"})` 会把目标
	 *  吸附到整数设备像素，逐帧叠加时这点舍入会**累加**（实测整段 ~1px），而且两个方向
	 *  不对称 → 反复显隐会缓慢漂移。记一个理想值、每帧用「差值」把它校正回去，
	 *  整段误差上限就只有最后一次吸附的那半个设备像素，且天然对称。 */
	private scrollCompIdeal = -1

	nudgeScrollForLayoutShift(delta: number): number {
		const cont = this.continuousEl
		if (!cont || !Number.isFinite(delta) || delta === 0) return 0
		const real = cont.scrollTop
		// 首帧，或真实位置与理想值偏离超过吸附量级（用户自己滚了 / 别的路径改了滚动位置）
		// → 以真实位置为新基准，绝不把位移「抢」回来
		if (this.scrollCompIdeal < 0 || Math.abs(real - this.scrollCompIdeal) > 1.5) {
			this.scrollCompIdeal = real
		}
		const want = Math.max(0, this.scrollCompIdeal + delta)
		const applied = want - real
		if (applied === 0) return 0
		this.scrollCompIdeal = want
		// 抑制窗口：比一帧长得多（多帧连续补偿时会不断被续上），动画结束后很快失效
		this.contProgScrollUntil = performance.now() + SCROLL_LAYOUT_COMP_SUPPRESS_MS
		// **必须 `behavior:"instant"`**：容器 CSS 是 `scroll-behavior:smooth`（见 styles.css
		// 的 .unreader-continuous），直接赋值 `scrollTop` 会变成平滑滚动 → 每帧被下一帧
		// 的目标打断 → 净位移接近于 0，而正文会老老实实跟着几何移动（正是要修的那个 bug）。
		cont.scrollTo({ top: want, behavior: "instant" as ScrollBehavior })
		// 被容器范围 clamp（书最开头/最末）时理想值要跟着落地值走，否则下一帧会拿一个
		// 永远达不到的目标反复空转
		if (Math.abs(cont.scrollTop - want) > 1) this.scrollCompIdeal = cont.scrollTop
		const glide = this.smoothGlide
		if (glide) {
			const t = Math.max(0, glide.targetTop + applied)
			this.beginGlide(t)
			this.contProgScrollUntil = performance.now() + 1000
			cont.scrollTo({ top: t, behavior: "smooth" })
		}
		return applied
	}

	/** 把焦点送回书页（连续模式 = 宿主滚动容器），保证键盘/滚轮交互一致。
	 *
	 *  **核心模态框（命令面板/快速切换/设置）开着时直接返回** —— 见 `core/modalFocusGate`
	 *  的文件头。这是「阅读器抢焦点」的**主写入点**：三十余条调用路径（翻页/上下章/
	 *  目录跳转/恢复落点/settleJump 定时器/resize 补落…）全部汇合到这里，所以门设在这里
	 *  就能一次性覆盖，包括将来新增的路径。 */
	focusContent(): void {		if (this.isContinuous && this.continuousEl && this.continuousRendered) {
			// ⚠️ 核心模态框开着时**不抢**焦点（见 core/modalFocusGate 文件头）：
			// 命令面板/快速切换的输入框刚拿到焦点就被我们抢走 → 打字与回车落回书页、
			// 软键盘被收起，用户看到「第一次用不了、要开两次」。
			// 判据放在这个**唯一汇合点**上而不是逐条调用路径上：本函数有三十余处调用，
			// 路径枚举追不完，一漏就又复发（用户的「每次解决之后又冒出来」）。
			if (hasCoreModal(this.continuousEl.ownerDocument)) return
			try { this.continuousEl.focus({ preventScroll: true }) } catch { /* ignore */ }
		}
	}

	rangeCFI(doc: Document, range: Range): string | null {
		if (this.isContinuous) {
			const rootDoc = ((range.commonAncestorContainer as Node | null)?.nodeType === 3
				? (range.commonAncestorContainer as Text).parentElement
				: (range.commonAncestorContainer as Element | null))?.ownerDocument ?? null
			let idx: number | null = null
			this.contFrames.forEach((f, i) => { if (f.doc && f.doc === rootDoc) idx = i })
			if (idx === null) return null
			const base = this.contBaseCfi.get(idx)
			const body = this.contFrames.get(idx)?.doc?.body
			if (!base || !body) return null
			try {
				const { start, end } = this.toEpubcfiPair(range, body)
				return `epubcfi(${base}!${start},${end})`
			} catch { return null }
		}
		const el = this.el
		if (!el) return null
		const contents = el.renderer.getContents().find(c => c.doc === doc)
		if (!contents) return null
		try {
			return el.getCFI(contents.index, range)
		} catch (e) {
			console.error("[UNreader] CFI failed", e)
			return null
		}
	}

	/** Feed 正文更新后，按保存的原文在已渲染内容中寻找新位置。 */
	findTextForAnnotation(text: string): { cfi: string; range: Range } | null {
		const needle = text.replace(/\s+/g, " ").trim();
		if (!needle) return null;
		const docs: Document[] = [];
		if (this.isContinuous) {
			for (const frame of this.contFrames.values()) if (frame.doc) docs.push(frame.doc);
		} else {
			try {
				for (const content of this.el?.renderer?.getContents?.() ?? []) if (content.doc) docs.push(content.doc);
			} catch { /* ignore */ }
		}
		for (const doc of docs) {
			const body = doc.body as HTMLElement | null;
			if (!body) continue;
			const range = this.findRangeInElement(body, needle);
			if (!range) continue;
			const cfi = this.rangeCFI(doc, range);
			if (cfi) return { cfi, range };
		}
		return null;
	}

	addHighlight(cfi: string, colorName: string, textHint?: string): void {
		if (!cfi) return
		if (this.isContinuous && this.continuousRendered) {
			this.highlights.set(cfi, colorName)
			const idx = this.sectionIndexFromPos(cfi)
			if (idx == null) return
			void this.renderHighlightIn(idx, cfi, colorName, textHint)
			return
		}
		if (!this.el) return
		this.highlights.set(cfi, colorName)
		void this.el.addAnnotation({ value: cfi, color: highlightColorOf(colorName) }).catch(() => {})
	}

	recolorHighlight(cfi: string, colorName: string): void {
		if (!cfi) return
		if (this.isContinuous && this.continuousRendered) {
			// 换色走「删掉重画」：必须把判据文本带上，否则重画时两种 CFI 口径的取舍
			// 退回「无判据」（旧格式高亮可能被插件口径解到别处 → 换色后位置漂移）
			const hint = this.contHL.get(cfi)?.text
			this.removeHighlight(cfi)
			this.addHighlight(cfi, colorName, hint)
			return
		}
		if (!this.el) return
		this.highlights.set(cfi, colorName)
		this.removeAnnotationSafe(cfi)
		void this.el.addAnnotation({ value: cfi, color: highlightColorOf(colorName) }).catch(() => {})
	}

	private removeAnnotationSafe(cfi: string): void {
		if (!this.el) return
		try {
			void this.el.deleteAnnotation({ value: cfi })
		} catch {
			// ignore
		}
	}

	removeHighlight(cfi: string): void {
		if (!cfi) return
		this.highlights.delete(cfi)
		if (this.isContinuous) {
			const data = this.contHL.get(cfi)
			if (data) {
				for (const r of data.els) r.remove()
				this.contHL.delete(cfi)
				for (const [k, arr] of this.contHLByIndex) {
					const next = arr.filter(x => x !== cfi)
					if (next.length) this.contHLByIndex.set(k, next)
					else this.contHLByIndex.delete(k)
				}
			}
			return
		}
		if (!this.el) return
		this.removeAnnotationSafe(cfi)
	}

	/** 在当前可视内容中命中高亮：用于 hover 预览与点击跳转。 */
	getHighlightAt(clientX: number, clientY: number): { anchor: string; range: Range } | null {
		if (this.isContinuous && this.continuousRendered) return this.continuousHitTest(clientX, clientY)
		const el = this.el
		if (!el?.renderer?.getContents) return null
		let contents: { overlayer?: { hitTest: (p: { x: number; y: number }) => unknown } }[] = []
		try {
			contents = el.renderer.getContents() as unknown as typeof contents
		} catch {
			return null
		}
		for (const c of contents) {
			const ov = (c).overlayer
			if (!ov?.hitTest) continue
			const hit = ov.hitTest({ x: clientX, y: clientY })
			if (Array.isArray(hit) && hit.length >= 2 && typeof hit[0] === "string" && hit[1] instanceof Range) {
				return { anchor: hit[0], range: hit[1] }
			}
		}
		return null
	}

	/** 连续模式命中高亮：基于覆盖矩形的几何测试。
	 *  覆盖矩形是 iframe 文档内坐标，宿主 clientX/Y 须先减去 frame 的视口偏移。 */
	private continuousHitTest(clientX: number, clientY: number): { anchor: string; range: Range } | null {
		for (const [cfi, data] of this.contHL) {
			for (const r of data.els) {
				const rect = r.getBoundingClientRect()
				const f = this.contFrames.get(this.frameIndexByDoc(r.ownerDocument) ?? -1)
				let x = clientX
				let y = clientY
				if (f) {
					try {
						const fr = f.iframe.getBoundingClientRect()
						x = clientX - fr.left
						y = clientY - fr.top
					} catch { /* 退化为原坐标比较 */ }
				}
				if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
					const idx = this.sectionIndexFromPos(cfi)
					const d = idx != null ? this.contFrames.get(idx)?.doc : null
					if (!d) continue
					// 与点覆盖矩形走同一条还原链（CFI 优先）：此前这里也按文本反查，
					// 于是同一次点击换条路径命中就得到不同范围（实测真实 AZW3 多选 2 字符）
					const range = this.highlightRangeFor(cfi, d, data.range, data.text)
					if (range) return { anchor: cfi, range }
					return { anchor: cfi, range: new Range() }
				}
			}
		}
		return null
	}

	/** 由覆盖矩形所属文档反查章节 frame 序号 */
	private frameIndexByDoc(d: Document | null): number | null {
		if (!d) return null
		for (const [idx, f] of this.contFrames) if (f.doc === d) return idx
		return null
	}


	/** 恢复持久化的高亮。`text` 是笔记里存的选中文本，作为 CFI 还原的**判据**
	 *  （旧格式 CFI 两种口径都解得出来时靠它挑对的那个，见 rangeFromAnyCfi）。 */
	restoreHighlights(list: { anchor: string; color: string; text?: string }[]): void {
		for (const item of list) {
			if (!item.anchor) continue
			this.highlights.set(item.anchor, item.color)
			this.addHighlight(item.anchor, item.color, item.text)
		}
	}

	/** 用一份新标注集合替换当前高亮（外部写入后的即时刷新用）。
	 *  `restoreHighlights` 只追加，直接复用会把同一 CFI 的旧矩形和新矩形叠在一起；
	 *  先按当前索引逐条移除，再走正常恢复链路按新数据重画。 */
	replaceHighlights(list: { anchor: string; color: string; text?: string }[]): void {
		for (const anchor of Array.from(this.highlights.keys())) this.removeHighlight(anchor)
		this.restoreHighlights(list)
	}

	private redrawSection(index: number): void {
		const el = this.el
		if (!el) return
		for (const [cfi, color] of this.highlights) {
			try {
				if (el.resolveCFI(cfi)?.index !== index) continue
				void el.addAnnotation({ value: cfi, color: highlightColorOf(color) })
			} catch {
				continue
			}
		}
	}

	destroy(): void {
		const el = this.el
		this.el = null
		this.handlers = null
		// 合成书（TXT / feed / HTML）的章节内容是 blob URL（每节一个）。`view.close()`
		// 只销毁 renderer、不会回调 `book.destroy`，不在这里回收就会随每次开书累积
		// （一本 500 章的书 ≈ 10MB 常驻，直到页面重载）。只回收合成书 —— 不去动
		// EPUB/MOBI 的 book.destroy，那会 revoke 书内资源的 URL，影响面远超本特性所需。
		try { this.syntheticBook?.destroy?.() } catch { /* ignore */ }
		this.syntheticBook = null
		this.bookFormat = "epub"
		// 侧栏手势桥：撤掉全局入口并还原被冻结的滚动容器（view 关闭/换书时）
		const hostWin = window as unknown as { __unreaderSwipe?: unknown }
		try { delete hostWin.__unreaderSwipe } catch { /* ignore */ }
		this.cancelFrameSwipe()
		this.highlights.clear()
		this.footnoteHandler = null
		if (this.contPruneTimer) { try { window.clearTimeout(this.contPruneTimer) } catch { /* ignore */ } this.contPruneTimer = 0 }
		this.contSectionEls.clear()
		this.contFrames.forEach(f => {
			try { f.ro?.disconnect() } catch { /* ignore */ }
			for (const id of f.timers) { try { window.clearTimeout(id) } catch { /* ignore */ } }
		})
		this.contFrames.clear()
		this.contBaseCfi.clear()
		this.contHL.clear()
		this.contHLByIndex.clear()
		this.continuousRendered = false
		this.isContinuous = false
		this.contRestoreTarget = null
		this.contHangRetries.clear()
		this.contHtmlCache.clear()
		this.firstFrameLogged = false
		for (const u of this.contBlobs) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
		this.contBlobs = []
		this.contBlobCache.clear()
		// 注意：不在此清理自定义字体注册表——字体是插件级资源，由 main 在插件卸载时
		// 通过 clearCustomFonts 释放；reader destroy 只是单个阅读器实例关闭，
		// 清掉注册表会让后续打开书籍时字体失效（桌面切字体没效果的根因）
		if (this.continuousEl) { try { this.continuousEl.replaceChildren() } catch { /* ignore */ } }
		if (this.hostEl) this.removeHostBgLayers(this.hostEl)
		if (!el) return
		try {
			el.close()
		} catch {
			// ignore
		}
		el.remove()
	}

	/* ---------------- continuous scroll implementation ---------------- */

	isContinuousMode(): boolean { return this.isContinuous }

	/** 轻量解析 epubcfi：返回 package-doc 第一个间接层的数字步骤序列 */
	private cfiStepIndices(cfi: string): number[] | null {
		try {
			// 宽松解析：兼容旧数据缺右括号的 CFI（严格正则会解析失败，
			// 导致 addHighlight 静默不渲染、书签/高亮跳转定位不到章节）
			let inner = cfi.trim()
			if (inner.startsWith("epubcfi(")) inner = inner.slice(8)
			if (inner.endsWith(")")) inner = inner.slice(0, -1)
			if (!inner) return null
			const parent = inner.split(",")[0] ?? ""
			const firstIndir = parent.split("!")[0] ?? ""
			const idx = [...firstIndir.matchAll(/\/(\d+)(?:\[[^\]]*\])?/g)].map(m => parseInt(m[1]!, 10))
			return idx.length ? idx : null
		} catch { return null }
	}

	private async ensureContinuous(appearance: AppearanceSettings, restoreIdx: number | null = null): Promise<void> {
		if (this.continuousRendered) {
			if (this.continuousEl) this.continuousEl.style.display = DISPLAY_BLOCK
			if (this.el) (this.el as unknown as HTMLElement).style.display = DISPLAY_NONE
			this.loadContinuousTheme(appearance)
			return
		}
		const el = this.el
		if (!el?.book) throw new Error("book not opened")
		await this.renderContinuous(el.book)
		this.continuousRendered = true;
		if (this.continuousEl) this.continuousEl.style.display = DISPLAY_BLOCK;
		(el as unknown as HTMLElement).style.display = DISPLAY_NONE
		this.loadContinuousTheme(appearance)
		// 恢复开书：**在触发初始补载之前**把视口预置到目标章的（估算）顶端。
		// 占位高度是「已测章真高 + 未测章按字节外推」的合成，目标章的占位框就是它的落点。
		// 换来两件事：①「以视口为参照」的补载链（ensureFilled）从第一帧就朝目标章走，
		// 不会去载书首几章跟目标章抢主线程（旧实现视口停在 0，`contRestoreTarget` 那条
		// 「目标章优先」甚至被 `clientHeight <= 0` 兜底分支整个架空）；② `--ur-pxb`
		// 校准时的视口锚定恰好锚在目标章上，校准只会把落点钉得更稳。
		// 精确落点仍由 scrollToIndex 的收敛循环给——这里只是把起点从书首挪到目标。
		if (restoreIdx != null && this.restorePreEnabled()) {
			const pre = this.sectionScrollTop(restoreIdx)
			if (pre != null) this.scrollContInstant(pre, "restorePre")
		}
		this.ensureFilled()
	}

	/** 当前生效的「占位高度 = px/字节 × 字节数」比例（CSS 变量 `--ur-pxb`），0 = 未校准 */
	private contPxb = 0
	private contPxbUpdates = 0
	/** 上次校准所用的**样本字节总量**（单调闸门：样本只会因回收缩小，比例不得据此回跳） */
	private contPxbSampleBytes = 0

	/** 未载章节的占位高度：按**字节数成比例**（比例由已测量章校准，见 `recalibratePlaceholders`）。
	 *
	 *  连续模式只渲染视口邻域，其余章节是占位。旧实现占位统一 12vh：文档总高远小于真实高度，
	 *  于是**远距离跳转的目标 scrollTop 超过 `scrollHeight - clientHeight`，`scrollTo` 被
	 *  clamp 到「当前能滚到的底部」**（实测目标真实顶端 112,466，只能滚到 53,565）——
	 *  落地必然错位，只能靠后续补载反复修正：表现为「点目录先闪到别处再跳回来」，
	 *  长距离时补载来不及干脆跳不过去。
	 *  占位高度对齐字节比例后，文档从打开起就具备接近真实的高度：远跳可一次直达、
	 *  滚动条/进度可信、占位→正文切换几乎无位移（高度本就接近）。
	 *
	 *  写法用 `min(max(12vh, pxb*bytes), 60屏)`：`--ur-pxb` 未校准时退化为 12vh（旧行为），
	 *  校准后所有占位**一次 CSS 变量写入**整体重算，无需逐元素改写。 */
	private applyEstimateHeight(wrap: HTMLElement, idx: number, sizes?: { sizes: number[] } | null): void {
		const sz = (sizes ?? this.bookByteSizes())?.sizes[idx] ?? 0
		if (sz <= 0) return
		wrap.style.minHeight = `min(max(12vh, calc(var(--ur-pxb, 0px) * ${sz})), 6000vh)`
	}

	/** 用**已测量章节**校准占位高度比例。
	 *
	 *  口径必须是「按字节加权的平均 px/字节」= Σh / Σsize，**不是**逐章比例的中位数。
	 *  中位数对逐章离群抗性强，但它的用途是「估计一章的典型密度」；而占位高度的用途是
	 *  **外推总和**（`Σ 未测章字节 × px/字节`），对求和而言无偏估计量是加权平均。
	 *  用中位数的后果实测：Moby Dick 144 章、总高约 100 万 px 的书，抢跑落点偏 21%
	 *  （209k px ≈ 250 屏），用户点目录先落到远处空白占位、约 1s 后才跳到目标。
	 *  加权平均把同一批样本的偏差压到 2~3% 量级。
	 *
	 *  样本少时更新频繁，比例趋于稳定后停止写入——每次写入都会让整容器重排一次。
	 *  防抖靠下面 **8% 死区**（样本口径稳定后自然不再写入）。**不能**再叠一个「最多更新
	 *  N 次」的硬上限：打开书的最初几章往往是版权页/目录页，密度与正文差异很大，
	 *  硬上限会在这些坏样本上把配额耗光并**永久锁死**错误比例（实测 Moby Dick 有一半
	 *  概率落在这种状态，抢跑偏差恒为 21%）。 */
	private recalibratePlaceholders(): void {
		// 调试开关 `localStorage["unreader-pxb-freeze"]="1"`：恢复旧行为「跳转在途不校准」，
		// 用于回归阴性对照。旧行为下「打开书 → 立刻点远处目录」整个跳转过程都拿不到比例
		// （此刻只有 0~1 章量到高度），全书占位停在 CSS 的 12vh、文档总高只有真实的 6%，
		// 跳转按这个畸形布局落地；等收工后 `--ur-pxb` 首次校准，文档总高瞬间涨数十倍而
		// `scrollTop` 不跟随 → 用户看到「点第 143 章、结果落在第 2 章」。
		if (this.pxbFreezeEnabled() && this.jumpPending) return
		const sizes = this.bookByteSizes()
		if (!sizes) return
		let sumH = 0
		let sumSz = 0
		for (const [idx, w] of this.contSectionEls) {
			if (!w.classList.contains("unreader-loaded")) continue
			// 用**宿主视觉高**（见 frameVisualHeight）：`--ur-pxb` 直接驱动未载章的
			// minHeight，量到的样本却是帧内 CSS px，设备模式下两者差一个缩放比，
			// 不换算就会把全书占位放大 1/k 倍（auto 档 k 恒为 1，逐字节等价）。
			const h = this.frameVisualHeight(this.contFrames.get(idx)?.lastHeight ?? 0)
			const sz = sizes.sizes[idx] ?? 0
			if (h > 0 && sz > 0) { sumH += h; sumSz += sz }
		}
		if (sumSz <= 0) return
		// **只接受来自更大样本的估计**：远章回收（prune）会让样本集缩小，用缩小后的样本
		// 反算出的比例可能大幅回跳（实测 0.499 → 0.449 → 0.499 抖动），而比例一变整本书
		// 的占位高度就整体重排。样本只会因回收而缩小，用「样本字节数不得倒退」做单调闸门
		// 即可消除这类抖动，同时保留「样本越大越准」的正常收敛。
		if (sumSz < this.contPxbSampleBytes) return
		const pxb = Math.min(8, Math.max(1 / 64, sumH / sumSz))
		// 变化 < 8% 不值得让整容器重排
		if (this.contPxb > 0 && Math.abs(pxb - this.contPxb) <= this.contPxb * 0.08) return
		const cont = this.continuousEl
		if (!cont) return
		this.contPxb = pxb
		this.contPxbUpdates++
		this.contPxbSampleBytes = sumSz
		this.pxbLog.push({ t: Math.round(performance.now()), pxb: +pxb.toFixed(4), sumH: Math.round(sumH), sumSz, sh: Math.round(this.continuousEl?.scrollHeight ?? 0) })
		// **写 `--ur-pxb` 会同时改变所有未载章的占位高度**（一个 CSS 变量驱动全部 min-height），
		// 于是文档总高与「视口里那一段内容」的绝对位置一起平移——必须把视口顶端的那一章
		// （含章内偏移）钉回原屏幕位置，否则用户读到哪儿就被整体挪走。
		//
		// 这条补偿是**「跳转期间禁校准」的正确替代**。旧实现用 `if (jumpPending) return`
		// 回避冲突，代价是：打开书立刻点目录时（此刻只有 0~1 章量到高度、pxb 仍为 0），
		// 整个跳转过程都拿不到比例 → 全书占位停在 CSS 的 12vh → 文档总高只有真实的
		// **6%**（实测 Moby Dick：18,348px vs 约 100 万 px）；跳转按这个畸形布局落地，
		// 等跳转收工、`--ur-pxb` 首次校准，文档总高瞬间涨 55×、而 `scrollTop` 不跟随 →
		// 用户看到的就是「点第 143 章，结果落在第 2 章」（用户报的「跳转好多章只能成功几章」）。
		// 改成补偿后，跳转期间可以照常校准：比例越早生效，落点越接近真实位置。
		// 调试开关 `localStorage["unreader-pxb-anchor"]="0"` 关掉补偿（回归阴性对照用）：
		// 关掉即复现旧故障——校准把文档总高从 12vh 假高放大到真实高度，而 scrollTop 不跟随，
		// 视口相对内容整体上移（用户报的「跳转好多章只能成功几章」）。
		const anchor = this.pxbAnchorEnabled() ? this.viewportAnchor() : null
		cont.style.setProperty("--ur-pxb", `${pxb}px`)
		if (anchor) this.restoreViewportAnchor(anchor)
	}

	/** 校准后的视口锚定保持（默认开）。调试开关 `localStorage["unreader-pxb-anchor"]="0"` 关闭。 */
	private pxbAnchorEnabled(): boolean {
		try {
			return window.localStorage.getItem("unreader-pxb-anchor") !== "0"
		} catch {
			return true
		}
	}

	/** 跳转在途是否冻结校准（默认**否**）。调试开关 `localStorage["unreader-pxb-freeze"]="1"` 恢复旧行为。 */
	private pxbFreezeEnabled(): boolean {
		try {
			return window.localStorage.getItem("unreader-pxb-freeze") === "1"
		} catch {
			return false
		}
	}

	/** 恢复开书是否**预置视口**到目标章（默认开）。调试开关
	 *  `localStorage["unreader-restore-pre"]="0"` 关掉（回归阴性对照用）：关掉后视口停在
	 *  书首，补载链与 `--ur-pxb` 校准的视口锚定都锚在书首，闸门超时放行时揭示的是书首。 */
	private restorePreEnabled(): boolean {
		try {
			return window.localStorage.getItem("unreader-restore-pre") !== "0"
		} catch {
			return true
		}
	}

	/** 恢复开书是否**就绪即落**（默认开）。调试开关
	 *  `localStorage["unreader-restore-fast"]="0"` 退回「连续两次 top 不变才落」的旧判据
	 *  （阴性对照用）：旧判据下 Moby Dick 要多等 ~500ms 才揭示。影响面仅恢复开书——
	 *  目录远跳的 `scrollToIndex` 不带 `onLanded`，判据不变。 */
	private restoreFastLand(): boolean {
		try {
			return window.localStorage.getItem("unreader-restore-fast") !== "0"
		} catch {
			return true
		}
	}

	/** 恢复开书期间是否把补载**收敛到目标章**（默认开）。调试开关
	 *  `localStorage["unreader-restore-focus"]="0"` 关掉（= 旧的「目标章 + 邻章」批次），
	 *  用于 A/B 量「并发装多章在主线程上排队」值多少毫秒（`npm run test:openperf`）。 */
	private restoreFocusEnabled(): boolean {
		try {
			return window.localStorage.getItem("unreader-restore-focus") !== "0"
		} catch {
			return true
		}
	}

	/** 视口顶端的「布局锚点」：哪一章、章内偏移多少。
	 *  从章首顺序扫描到第一个越过视口顶的章即停（O(视口位置)，不遍历全书）。
	 *  视口落在首章之前 / 末章之后时取最近的可锚章（章内偏移可为负/超章高，
	 *  `restoreViewportAnchor` 会照原样加回，保证语义是「同一段内容回同一屏幕位置」）。 */
	private viewportAnchor(): { idx: number; intra: number } | null {
		const cont = this.continuousEl
		if (!cont || !this.contOrder.length) return null
		const vpTop = cont.scrollTop
		let prev: { idx: number; intra: number } | null = null
		for (const i of this.contOrder) {
			const w = this.contSectionEls.get(i)
			if (!w) continue
			const top = w.offsetTop
			if (top > vpTop) return prev ?? { idx: i, intra: vpTop - top }
			prev = { idx: i, intra: vpTop - top }
		}
		return prev
	}

	/** 把 `viewportAnchor` 记录的那一段内容钉回原来的屏幕位置。
	 *  `offsetTop` 读的是布局真值，因此这次写入等价的语义是「把全局高度变化中落在
	 *  锚点之上的那一份整体补进 scrollTop」。 */
	private restoreViewportAnchor(a: { idx: number; intra: number }): void {
		const cont = this.continuousEl
		const w = this.contSectionEls.get(a.idx)
		if (!cont || !w) return
		const target = w.offsetTop + a.intra
		if (Math.abs(target - cont.scrollTop) < 1) return
		this.scrollContInstant(target, "pxbAnchor")
	}

	private async renderContinuous(book: unknown): Promise<void> {
		const cont = this.continuousEl
		if (!cont) return
		const sections = (book as { sections?: { id?: string; cfi?: string; linear?: string }[] }).sections ?? []
		cont.replaceChildren()
		this.contSectionEls.clear()
		this.contBaseCfi.clear()
		this.contOrder = []
		this.contFailed.clear()
		// 占位高度估算的比例是「按书的排版密度」定标，换书必须重新校准
		this.contPxb = 0
		this.contPxbUpdates = 0
		this.contPxbSampleBytes = 0
		const byteSizes = this.bookByteSizes()
		for (let i = 0; i < sections.length; i++) {
			const sec = sections[i]
			if (!sec || sec.linear === "no") continue
			const wrap = createEl("section")
			wrap.className = "unreader-continuous-section"
			wrap.dataset.secIndex = String(i)
			this.applyEstimateHeight(wrap, i, byteSizes)
			if (sec.cfi) {
				const steps = this.cfiStepIndices(sec.cfi)
				if (steps) this.contBaseCfi.set(i, steps.map(n => `/${n}`).join(""))
			} else if (this.bookFormat !== "epub") {
				// 没有 sec.cfi 的书 = MOBI/AZW3（foliate mobi.js 完全不实现 CFI）与 TXT
				// 合成书。不给基准 → rangeCFI 拿不到 base 返回 null → 选区建不了高亮/书签
				// （表现为「无法定位选区」），currentContCfi 也返回 null（连带「回到上一位置」
				// 永远灰）。兜底用 view.getCFI 的 fake 索引（epubcfi(/6/(i+1)*2)，
				// 与 CFI.fake.fromIndex 同构），与 sectionIndexFromCfi 的 itemStep/2-1 反推、
				// view.resolveCFI 的 fake.toIndex 三方口径一致。
				//
				// 判据保留 `!== "epub"` 而不是单纯的 `else`：EPUB 的 sec.cfi 来自
				// `resources.cfis[index]`（epub.js:1018），理论上可能为空 —— 那种情况下
				// 塞一个 fake 基准会让高亮用假 CFI 落盘、与书的真实 resolveCFI 口径分叉。
				// 宁可维持「EPUB 缺 CFI 就没有基准」的旧行为，也不去动它。
				// 前提：TXT 合成书**不得**给 section 加 cfi 字段（否则 getCFI 优先返回它、口径分叉）。
				try {
					const gv = this.el as unknown as { getCFI?: (index: number) => string } | null
					const fake = gv?.getCFI?.(i)
					const steps = fake ? this.cfiStepIndices(fake) : null
					if (steps) this.contBaseCfi.set(i, steps.map(n => `/${n}`).join(""))
				} catch { /* ignore */ }
			}
			cont.appendChild(wrap)
			this.contSectionEls.set(i, wrap)
			this.contOrder.push(i)
		}
		cont.addEventListener("scroll", () => { this.emitContinuousRelocateSoon(); this.ensureFilledSoon(); this.schedulePruneSoon(); this.notifyScrollActive() }, { passive: true })
		// 用户显式输入 = 已离开跳转落点：撤销「身份章」粘滞（见 contStickySection）。
		// 不能用 scroll 事件当信号——补载/远章回收/漂移校正都会派发 scroll，
		// 会把刚落地的跳转身份误判成「用户滚动」而提前释放。
		for (const evName of ["wheel", "touchstart", "pointerdown", "keydown"]) {
			cont.addEventListener(evName, () => { this.contStickySection = null }, { passive: true })
		}
		// ⚠️ 这里**不能**再挂 click → onTapZone。历史实现挂过，理由是「未接线 frame
		// 的点按兜底」并断言「已接线 frame 自行消费事件，不会落到这里（无双触发）」——
		// 该断言只对「落在 iframe 上的点按」成立。正文容器的**左右 padding 带**
		// （`--ur-pad-left/right`，桌面 64/42）与未接线 frame 覆盖不到的位置，点按
		// 的目标元素就是容器本身 → 既命中本监听、又继续冒泡到宿主挂在 .unreader-body
		// 上的同一委托（readerView.renderChrome）→ **一次点按投递两次**，而
		// handleTapZone 是纯翻转：两次 = 净无变化（全区沉浸态「点了没反应」）、
		// 半隐藏态反而「点一下全藏」，且两个方向会在同一 tick 推给原生状态栏/底栏桥
		// （移动端「闪一下又回隐藏」）。右缘浮动目录栏的短横盒正压在右侧 padding 带上，
		// 所以实测症状就是「点击接近浮动目录栏时隐藏元素闪一下」。
		// 归口：容器外与容器 padding 带、iframe 内全部由宿主委托（+ iframe 内 wireTapZone）
		// 投递，一次点按只允许一个 owner。回归见 `npm run test:taproute`。
		cont.tabIndex = 0
		cont.addEventListener("keydown", e => {
			// 标记已处理：宿主 window 级兜底翻页监听据此跳过，防止双翻页
			(e as KeyboardEvent & { __unreaderHandled?: boolean }).__unreaderHandled = true;
			if (this.handleChapterKeys(e)) return
			if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") {
				if ((e.target as HTMLElement | null)?.closest("input, textarea")) return
				e.preventDefault()
				void this.scrollPage(1)
			} else if (e.key === "ArrowUp" || e.key === "PageUp") {
				if ((e.target as HTMLElement | null)?.closest("input, textarea")) return
				e.preventDefault()
				void this.scrollPage(-1)
			}
		})
		// 键盘：容器或页面获得焦点时（如点击正文后 focus 落在 iframe body），
		// 宿主 keydown 监听兜底翻页
		this.handlers && cont.addEventListener("wheel", () => { this.ensureFilledSoon() }, { passive: true })
		// 用户滚轮/按住内容 = 接管滚动，进行中的程序化平滑滑动作废
		cont.addEventListener("wheel", () => { this.clearGlide() }, { passive: true })
		cont.addEventListener("pointerdown", () => { this.clearGlide() })
	}

	/** 已渲染章节直接出内容；未渲染则触发加载（渲染真正完成后才打 loaded 标记） */
	private async loadSections(indices: number[]): Promise<void> {
		for (const idx of indices) {
			const wrap = this.contSectionEls.get(idx)
			const f = this.contFrames.get(idx)
			if (!wrap || this.contFailed.has(idx)) continue
			if (f) {
				// 「在途」判据必须同时看三个信号：loaded 类、iframe 是否已入 DOM、renderSection 是否
				// 还在跑。只看 `f.loaded`（旧实现）会把**陈旧占位**也当在途 —— renderSection 抛错被
				// catch 吞掉或提前 return 时，占位记录留在 map 里没人清，此后 loadSections 对它永久
				// 去重跳过；只剩 8s 看门狗能回收，而跳转等待窗口通常更短 → 点击目录「远距离跳转失败」。
				// 跳转/恢复期间（jumpPending）立即回收陈旧占位重试；其余场景维持原行为（交给看门狗），
				// 避免日常滚动补载路径引入重试风暴。
				const live = wrap.classList.contains("unreader-loaded") || !!f.iframe?.isConnected || this.contRendering.has(idx)
				if (live) { f.loaded = true; continue }
				if (!this.jumpPending) { f.loaded = true; continue }
				this.contFrames.delete(idx)
			}
			const fr: ContFrame = { idx, iframe: null as unknown as HTMLIFrameElement, doc: null, pageUrl: "", anchors: new Map(), lastHeight: 0, timers: [], ro: null, loaded: true }
			this.contFrames.set(idx, fr) // 占位去重；renderSection 完成后替换为真 frame 记录
			// 看门狗：renderSection 挂起（资源解析卡住等）会让 doc 永远为 null，
			// 占位无法被任何补载路径重试（表现为点击目录永远无法跳转）。
			// 超时后回收占位，使本章回到待载队列自动重试。
			fr.timers.push(window.setTimeout(() => {
				if (this.contFrames.get(idx) === fr && !fr.doc) {
					this.contFrames.delete(idx)
				}
			}, 8000))
			void this.renderSection(idx, wrap, fr)
		}
	}

	private contFillRaf = 0
	private ensureFilledSoon(): void {
		if (this.contFillRaf) return
		this.contFillRaf = window.requestAnimationFrame(() => {
			this.contFillRaf = 0
			this.ensureFilled()
		})
	}

	/** 确定性填充：以视口为参照补载。
	 *  不能用「已载边界」（lastBottom/firstTop）做门控：恢复位置/跳转落在远章后，
	 *  两端边界都离视口很远，边界判断会永久卡死——视口邻域的空白章永远等不到补载。
	 *  这里直接检查视口上下缓冲带内是否存在未载章，有则按距视口远近优先补载。 */
	private ensureFilled(): void {
		const cont = this.continuousEl
		if (!cont || !this.continuousRendered || !this.contOrder.length) return
		const vpTop = cont.scrollTop
		const vpBottom = vpTop + cont.clientHeight
		const trigger = vpTop + cont.clientHeight * 2.5
		const upTrigger = vpTop - cont.clientHeight * 1.5
		const isDone = (i: number): boolean => {
			const w = this.contSectionEls.get(i)
			const f = this.contFrames.get(i)
			return !!w && (w.classList.contains("unreader-loaded") || !!f?.doc || !!f?.loaded)
		}
		const pending = this.contOrder.filter(i => !isDone(i) && !this.contFailed.has(i))
		if (!pending.length) return
		// 恢复开书期间：补载**收敛到目标章**（唯一在关键路径上的章）。
		// 每多装一章都要占主线程：实测 144 章书开书期并发 6 章时各章 `getSectionDoc`
		// 610~640ms（wall clock 几乎同时结束 = 排队），把「目标章就绪」从 ~100ms 拉到 ~640ms；
		// 而落定只用目标章自己的几何（上方未载章按字节占位估算）。邻章留到落定后由
		// 正常的视口参照补载接手 —— 那时已经可见，不在关键路径上。
		// 开关 `localStorage["unreader-restore-focus"]="0"` 关掉（= 旧的「目标章 + 邻章」）。
		const focus = this.restoreFocusIdx
		if (focus != null && this.restoreFocusActive()) {
			if (!isDone(focus) && this.contSectionEls.has(focus) && !this.contFailed.has(focus)) void this.loadSections([focus])
			this.schedulePruneSoon()
			return
		}
		// 容器尚无高度（移动端布局未稳定/切后台回来瞬间）：无法以视口为参照，
		// 退化按文档顺序补载，避免永远等不到任何一章
		if (cont.clientHeight <= 0) {
			void this.loadSections(pending.slice(0, IS_MOBILE_LIKE_THRESHOLD ? 2 : 3))
			return
		}
		// 起始状态（尚无任何已载章）：占位 offsetTop 全为 0 无法算距离。
		// 有恢复目标时优先载目标章 + 下一章（旧逻辑按文档序载前 3 章，恢复到远章时
		// 要从书头开始逐步 pump 走向目标，定位动辄数秒）；无目标再按文档序补前 3 章
		if (!this.contOrder.some(isDone)) {
			const t = this.contRestoreTarget
			if (t != null && this.contSectionEls.has(t) && !this.contFailed.has(t)) {
				const batch = [t]
				const next = this.contOrder[this.contOrder.indexOf(t) + 1]
				if (next != null && this.contSectionEls.has(next)) batch.push(next)
				void this.loadSections(batch)
				this.contRestoreTarget = null
				return
			}
			// **移动端优化：减少初始预载数量**
			void this.loadSections(pending.slice(0, IS_MOBILE_LIKE_THRESHOLD ? 1 : 3))
			return
		}
		const below: number[] = [] // 视口内或下方 2.5 屏内的空洞
		const above: number[] = [] // 视口上方 1.5 屏内的空洞
		for (const i of pending) {
			const w = this.contSectionEls.get(i)
			if (!w) continue
			const top = w.offsetTop
			const bottom = top + w.offsetHeight
			if (top < trigger && bottom > vpTop) below.push(i)
			else if (bottom <= vpTop && (w.offsetHeight > 0 ? bottom : top) > upTrigger) above.push(i)
		}
		// 补载后追加一次卸载调度：初始恢复/跳转落点填充不受 scroll 事件驱动，
		// 没有这一步时初始态活 frame 可超阈值且永不回收（半透明窗口下即闪烁源）
		if (below.length || above.length) this.schedulePruneSoon()
		// **移动端优化：减少单次预载数量**，避免卡顿和掉帧
		const mobileBatchSize = IS_MOBILE_LIKE_THRESHOLD ? 2 : 4 // 下方章节
		const mobileAboveBatchSize = IS_MOBILE_LIKE_THRESHOLD ? 1 : 2 // 上方章节
		if (below.length) {
			below.sort((a, b) => Math.abs((this.contSectionEls.get(a)?.offsetTop ?? 0) - vpTop) - Math.abs((this.contSectionEls.get(b)?.offsetTop ?? 0) - vpTop) || a - b)
			void this.loadSections(below.slice(0, mobileBatchSize))
			return
		}
		if (above.length) {
			above.sort((a, b) => (this.contSectionEls.get(b)?.offsetTop ?? 0) - (this.contSectionEls.get(a)?.offsetTop ?? 0))
			void this.loadSections(above.slice(0, mobileAboveBatchSize))
			return
		}
		// 兜底（仅向下、且仅在视口已抵达容器底部时）：补载链断裂的救援。
		// 成因：滚到底时前方章节仍是 12vh 占位 → scrollHeight 偏小、滚动条先到底；随后异步
		// 补载令 scrollHeight 暴涨而 scrollTop 不跟随 → 视口相对内容「上移」→ 末尾未载章落到
		// trigger（2.5 屏）之外 → below 恒空 → 再无任何路径补载它们（实测《傲慢与偏见》滚到
		// 底：pending 71 章、below=[]、末尾 8 章全未载，用户看到大片 12vh 占位空白；直接
		// loadSections 强制补载这 8 章全部成功，证明既非书内空白、也非 renderSection 失败）。
		//
		// **必须限定「已在底部」**：无条件兜底会让每次 ensureFilled（滚轮、补载回调、
		// 回收调度、notifyVisible…）都补一个「下方最近的」章，链式把整本书补完 ——
		// 实测帧数 7→77、4→144、6→159，远超距离生命周期 4-6 帧的稳态（半透明窗口下
		// 10+ 活帧即抢合成器资源、触发闪烁/拖影）。
		// 限在底部后：补载令 scrollHeight 增长、视口随即离开底部 → 本次兜底自然停止；
		// 用户上滚也不再触发。未到底时的补载仍完全由 below/above 分支按视口缓冲带负责。
		const maxScroll = cont.scrollHeight - cont.clientHeight
		if (cont.scrollTop < maxScroll - 2) return
		let downBest = -1
		let downDist = Infinity
		for (const i of pending) {
			const w = this.contSectionEls.get(i)
			if (!w) continue
			const top = w.offsetTop
			if (top < vpBottom) continue
			const d = top - vpBottom
			if (d < downDist) { downDist = d; downBest = i }
		}
		if (downBest >= 0) void this.loadSections([downBest])
	}

	/** leaf 重新可见（切回标签页/布局变化）时驱动一次填充与进度上报：
	 *  隐藏期间 scrollTop 不变、scroll 事件不触发，填充链条会停摆 */
	notifyVisible(): void {
		// 恢复位置还没落定过（开书时叶子/容器还没有尺寸，几何全是 0，落点算不出来）：
		// 现在有真实视口了，补落一次。**用户已经自己滚过就不动**（尊重用户操作）。
		// 阅读区宽度可能刚变过（横竖屏 / 分屏 / 侧栏开合 / 移动端地址栏伸缩）：
		// 设备模式的缩放比挂在宽度上，先重算再走后面的填充与定位。
		this.syncWebDevice()
		const rp = this.restorePending
		if (rp && this.continuousEl && this.continuousEl.clientHeight > 0) {
			this.restorePending = null
			this.scrollToIndex(rp.idx, "start", rp.frac, true)
		}
		this.ensureFilledSoon()
		this.emitContinuousRelocateSoon()
		// 移动端布局可能晚于首次填充才稳定（容器高度/宽度变化），分几拍再补：
		// 避免「打开即空白，滚动才出内容」
		for (const ms of [50, 150, 400]) {
			window.setTimeout(() => {
				if (!this.isContinuous) return
				this.ensureFilledSoon()
			}, ms)
		}
		// 布局变化（侧边栏开合导致正文宽度变化 → 文字重排）后，高亮矩形必须按新
		// 布局重新定位，否则标注停在旧位置、与文字脱节。等一帧让 reflow 落定再重绘。
		window.requestAnimationFrame(() => {
			if (!this.isContinuous) return
			this.contFrames.forEach((_, idx) => this.refreshHighlightsFor(idx))
		})
	}

	/** 方向锚点（px）。**只在真正上报过方向时推进**，见 notifyScrollActive 与
	 *  CONT_DIR_MIN_PX 那段注释：它挡住的是「攒不满阈值的抖动」。 */
	private contDirAnchor = -1
	/** 上一次真正上报的方向（配合 contDirDwellUntil 做反向闸） */
	private contDirLast: "up" | "down" | null = null
	/** 反向闸截止时刻：翻转后这段时间内的**反向**上报被丢弃（同向不限），
	 *  把「一次滑动尾部的回弹」并成一次翻转。 */
	private contDirDwellUntil = 0
	/** 程序化滚动抑制窗口：scrollContInstant/平滑跳转后 1s 内的 scroll 事件
	 *  （恢复位置、跳转补偿、首次开书布局稳定）不向宿主报告方向——否则开书
	 *  初期的滚动会把刚唤出的沉浸模式 chrome 立刻压回去（表现为唤不出） */
	private contProgScrollUntil = 0
	/** 选期滚动抑制窗口（见 CONT_SEL_SUPPRESS_MS）：选区活动后这段时间内的
	 *  scroll 事件同样不报方向 —— 那不是阅读滚动，是浏览器把选区/手柄滚进可视区。 */
	private contSelectionScrollUntil = 0
	/** 标记「刚发生了选区活动」（iframe 内 selectionchange / pointerup，以及宿主侧
	 *  主动调用）。只推抑制窗口，不做任何其他事。 */
	noteSelectionActivity(): void {
		this.contSelectionScrollUntil = performance.now() + CONT_SEL_SUPPRESS_MS
	}
	/** 跳转/恢复落点的「身份章」（= 本次请求的**原始**目标章节，未做 linear="no" 归并）。
	 *
	 *  背景：章节归属按**视口中心**判定（viewportSection），而跳转把目标章**顶边**对齐
	 *  到视口顶。目标章比半屏还短时（标题页、极短分节），视口中心直接落到**下一章** →
	 *  点目录里的「A」却把高亮/章节名报成「A+1」，标注侧栏也会记到下一章名下。
	 *
	 *  修法：跳转/恢复期间用「身份章」报目录高亮与章节名；**几何量**（进度、CFI、页码）
	 *  仍按视口实际所在章算——不动 sectionProgressFraction 那套归属窗口口径，位置持久化
	 *  与进度条零改动。用户一有显式输入（滚轮/触摸/按下/按键）即释放，回到几何归属。 */
	private contStickySection: number | null = null
	/** 方向判定最小累积位移（px）。localStorage 覆盖仅供调试/回归做阴性对照
	 *  （设 0 = 关阈值，回到「任何 1px 变化都翻转」的修复前行为）。
	 *  **每次判定现读**（与 `unreader-keep-frames` 同一约定）：localStorage.getItem
	 *  是内存表查找级别，滚动热路径上两次调用远小于本函数已有的开销；换成缓存则
	 *  「改覆盖值要重载插件」，回归里的阴性对照也得再多一个只有测试用的私有字段。 */
	private scrollDirThreshold(): number {
		try {
			const raw = window.localStorage.getItem("unreader-scroll-dir-px")
			if (raw != null && raw !== "") {
				const v = parseInt(raw, 10)
				if (Number.isFinite(v) && v >= 0) return v
			}
		} catch { /* ignore */ }
		return CONT_DIR_MIN_PX
	}

	/** 反向闸时长（ms），同样支持 localStorage 覆盖（设 0 = 关闸）。 */
	private scrollDirDwell(): number {
		try {
			const raw = window.localStorage.getItem("unreader-scroll-dir-dwell")
			if (raw != null && raw !== "") {
				const v = parseInt(raw, 10)
				if (Number.isFinite(v) && v >= 0) return v
			}
		} catch { /* ignore */ }
		return CONT_DIR_DWELL_MS
	}

	/** 滚动方向通知：按**累积位移**报告 "down"/"up"，供宿主隐藏/唤出工具栏。
	 *  判据四层（缺一不可，见 CONT_DIR_MIN_PX / CONT_SEL_SUPPRESS_MS 处注释）：
	 *   ① 抑制窗口内不报方向，但**锚点必须跟上** —— 否则窗口一过，第一帧会拿
	 *      「跳转前」的锚点算出一个几百 px 的假位移（表现为跳完目录工具栏莫名藏起）；
	 *   ② 位移攒够阈值才进状态机（抖动永不触发）；
	 *   ③ 刚翻转后的反向闸内丢弃反向上报（同向照常放行，避免把长距离滚动憋住）；
	 *   ④ 选区活动窗口内同样只推锚点（长按选词/拖手柄引发的滚动不是阅读滚动）。 */
	private notifyScrollActive(): void {
		const cont = this.continuousEl
		const st = cont?.scrollTop ?? 0
		const now = performance.now()
		if (now < this.contProgScrollUntil || now < this.contSelectionScrollUntil) {
			this.contDirAnchor = st
			return
		}
		// 首次（或 endScrollActivity 重置后）：只建立基准，不判定方向
		if (this.contDirAnchor < 0) {
			this.contDirAnchor = st
			return
		}
		const delta = st - this.contDirAnchor
		// 用户真的自己滚了（已排除程序化滚动/选区活动窗口）：放弃「等视口就绪再补落恢复
		// 位置」的待办 —— 否则之后任何一次 resize（转屏、开合侧栏）都会把用户拽回去
		if (delta !== 0) this.restorePending = null
		if (delta === 0 || Math.abs(delta) < this.scrollDirThreshold()) return
		const dir: "up" | "down" = delta > 0 ? "down" : "up"
		if (this.contDirLast !== null && dir !== this.contDirLast && now < this.contDirDwellUntil) return
		this.contDirAnchor = st
		this.contDirLast = dir
		this.contDirDwellUntil = now + this.scrollDirDwell()
		// 真机取证：底栏闪烁时，这条日志能直接指认「是不是滚动方向在翻、翻了多少」
		debugInfo("[scroll] dir", dir, "delta", Math.round(delta))
		this.handlers?.onScrollActivity?.(dir)
	}

	/** 供宿主主动重置滚动基准（如恢复工具栏时） */
	endScrollActivity(): void {
		this.contDirAnchor = -1
		this.contDirLast = null
		this.contDirDwellUntil = 0
	}

	/** 沉浸模式点按：快速点按（未产生选区、非长按、非链接）按横向比例回调宿主，
	 *  宿主仅用中间 1/3 切换工具栏显隐。用 click 事件而非 pointerup——
	 *  iOS 沙箱 iframe 里 pointerup 偶发不派发，click 由浏览器统一判定
	 *  「真点按」（拖动/滚动后不触发），天然免疫这些坑。连续/分页两条流共用。
	 *  注意：iframe 内事件的 clientX 相对 iframe 自身视口，与顶层窗口坐标
	 *  （getBoundingClientRect）不同系——ratio 必须用 iframe 视口宽度自算，
	 *  否则 pane 有偏移时（Obsidian 桌面分栏）正中点击会被算到侧区丢弃。 */
	/* ---------------- 侧栏手势桥实现（连续模式） ---------------- */

	/** iframe 内横向手势定轴：同步转发给宿主（readerView → workspace.trigger("swipe")）。
	 *  原生抽屉会在 trigger 调用栈内同步执行 registerCallback；只有拿到回调才算
	 *  被接收。返回 false 表示无人接收（双侧栏都已展开/侧栏被钉住/非移动端），
	 *  iframe 侧随即放弃本手势、不拦截任何默认行为。 */
	private beginFrameSwipe(p: { startX: number; startY: number; x: number; y: number }): boolean {
		this.cancelFrameSwipe()
		let cb: FrameSwipeCallback | null = null
		try {
			this.handlers?.onSwipe?.({
				startX: p.startX,
				startY: p.startY,
				x: p.x,
				y: p.y,
				registerCallback: c => { cb = c },
			})
		} catch (e) {
			debugWarn("[swipe] onSwipe threw", e)
		}
		// 这一行是实机排查的分水岭：有 begin 无 accepted → 载荷到了宿主但没人接收
		// （双侧栏都已展开 / 侧栏被钉住 / 非移动端）；连 begin 都没有 → iframe 侧
		// 就没识别到（脚本没注入、触控没进 iframe，或被我自己的闸拦下，后者会
		// 由 note 回报 longpress/selection）
		debugInfo("[swipe] begin", `(${Math.round(p.startX)},${Math.round(p.startY)})`, "accepted=", !!cb)
		if (!cb) return false
		this.swipeCb = cb
		// 只读快照，不写任何样式——起手这一帧正是抽屉登场帧，宿主布局最重，
		// 此刻再往祖先链上写 overflow 会与原生重排叠加成一次可见卡顿。
		this.beginScrollPin()
		return true
	}

	/** 跟手帧：先钉回连续容器的滚动位置（若漂了），再驱动侧栏 */
	private moveFrameSwipe(x: number, y: number): void {
		this.pinScroll()
		try { this.swipeCb?.move(x, y) } catch { /* ignore */ }
	}

	/** 抬手收尾：还原容器（与原生 touchend 里先 C() 再 finish 的顺序一致），
	 *  再交还抽屉做开/合收尾动画（阈值判定在抽屉内部，用的是我们传入的 v）。 */
	private finishFrameSwipe(x: number, y: number, v: number): void {
		this.releaseScrollPin()
		const cb = this.swipeCb
		this.swipeCb = null
		debugInfo("[swipe] finish", Math.round(x), Math.round(y), "v=", Math.round(v))
		try { cb?.finish(x, y, v) } catch { /* ignore */ }
	}

	/** 手势作废（多指、touchcancel、新起手、view 销毁）：还原容器 + 抽屉回弹 */
	private cancelFrameSwipe(): void {
		this.releaseScrollPin()
		const cb = this.swipeCb
		this.swipeCb = null
		if (cb) debugInfo("[swipe] cancel")
		try { cb?.cancel() } catch { /* ignore */ }
	}

	/** 起手快照滚动位置（纯读，不碰样式） */
	private beginScrollPin(): void {
		const cont = this.continuousEl
		this.swipeScroll = cont ? { el: cont, top: cont.scrollTop, frozen: false, behavior: "" } : null
	}

	/** 只在真的漂移时才动容器：首次漂移升级为冻结（overflow-y:hidden）并钉回原位，
	 *  之后每帧只做一次读数比较。斜向手势把正文带滚时靠这里兜住。
	 *  冻结时必须同时把 scroll-behavior 压成 auto：容器 CSS 是 `smooth`，
	 *  程序化写 scrollTop 会走补间——跟手期间容器自己在缓动，正文看起来在抖，
	 *  而且下一帧读到的仍不是目标值，pinScroll 会反复触发。 */
	private pinScroll(): void {
		const s = this.swipeScroll
		if (!s || s.el.scrollTop === s.top) return
		if (!s.frozen) {
			s.frozen = true
			s.behavior = s.el.style.scrollBehavior
			s.el.style.scrollBehavior = SCROLL_BEHAVIOR_AUTO
			s.el.style.overflowY = OVERFLOW_HIDDEN
		}
		s.el.scrollTop = s.top
	}

	private releaseScrollPin(): void {
		const s = this.swipeScroll
		this.swipeScroll = null
		if (!s || !s.frozen) return
		try {
			s.el.scrollTop = s.top
			s.el.style.removeProperty("overflow-y")
			s.el.style.scrollBehavior = s.behavior
		} catch { /* ignore */ }
	}

	private wireTapZone(d: Document): void {
		const doc = d as Document & { __unreaderTapWired?: boolean }
		if (doc.__unreaderTapWired) return
		doc.__unreaderTapWired = true
		let tapT0 = 0
		d.addEventListener("pointerdown", () => { tapT0 = performance.now() }, { passive: true })
		d.addEventListener("click", (e: MouseEvent) => {
			// 长按（脚注跳转/iOS 放大镜）不算点按
			if (tapT0 && performance.now() - tapT0 > 450) return
			// 产生了文字选区 → 是选择操作，不翻页
			const selText = (d.getSelection?.()?.toString() ?? "").trim()
			if (selText) return
			// 落在链接上（脚注/目录）→ 交给链接处理
			const tgt = e.target as Element | null
			if (tgt?.closest?.("a[href]")) return
			// 比例必须用 frame 元素的宿主视觉矩形换算：分页模式 foliate 内部
			// 多列布局/横向平移，文档坐标（clientX/documentElement.clientWidth/
			// innerWidth）都可能与视觉位置错位（实测正中点按算出 0.24/0.82）。
			// frame 视口与 iframe 元素盒子 1:1 对应：宿主视觉 x = rect.left + clientX
			const frameEl = d.defaultView?.frameElement as HTMLElement | null
			let ratio = 0.5
			if (frameEl) {
				const r = frameEl.getBoundingClientRect()
				ratio = r.width > 0 ? (r.left + e.clientX) / r.width : 0.5
			} else {
				const w = d.defaultView?.innerWidth ?? 0
				if (w <= 0) return
				ratio = e.clientX / w
			}
			this.handlers?.onTapZone?.(ratio)
		})
	}

	/**
	 * 取章节 Document（统一 EPUB / MOBI / TXT 接口差异）：
	 *   - EPUB: `book.loadText(secId)` → 字符串 → DOMParser
	 *   - MOBI / TXT: `book.sections[idx].load()` 返回 blob URL 字符串 → fetch → DOMParser
	 *          （MOBI 的 sec.load 内部已调 `replaceResources`，所以后面 rewriteResourcesLocal
	 *          自动跳过——它检查 `book.loadBlob` 不存在就直接 return；TXT 的没有资源可改写）
	 *           失败时回退 `sec.createDocument()` + 引擎侧补图（见 createMobiDoc）
	 * **判据必须带书格式**（`sec.load` 三者都有，见方法内注释）。
	 * 返回 null：book 没 sections、章节对象不存在、loadText 失败（EPUB）、
	 *           fetch 失败（MOBI/TXT）等情况
	 */
	private async getSectionDoc(idx: number, secIdStr: string): Promise<Document | null> {
		const book = this.el?.book as unknown as {
			loadText?: (p: string) => Promise<string>
			sections?: {
				load?: () => Promise<string>
				createDocument?: () => Promise<Document>
			}[]
		} | null
		if (!book?.sections) return null
		const sec = book.sections[idx]
		if (!sec) return null
		try {
			let rawStr: string
			if (this.bookFormat !== "epub" && sec.load) {
				// MOBI/AZW3 与 TXT 合成书: sec.load() 返回 blob URL 字符串
				// （MOBI 的那份已含资源改写；TXT 的没有资源可改写）
				//
				// ⚠️ 判据**必须**带书格式，不能只看 `sec.load` 存不存在：EPUB 的 section
				// 也有 `load`（epub.js:1014 `load: () => this.#loader.loadItem(item)`），
				// 且它返回的**也是** blob URL —— 但那是 EPUB loader **自己那套改写管线**
				// 的产物（loadReplaced → 内联改写资源 → createURL → createObjectURL），
				// 与 EPUB 既定路径（`book.loadText` + 本文件的 rewriteResourcesLocal）
				// 完全是两条链。走它会：① 让 `rewriteResourcesLocal` 在已改写过的 doc 上
				// 二次改写（EPUB 的 book 有 loadBlob，那道早返回闸门不生效）；
				// ② 章节 blob URL 被登记进 loader 的引用计数缓存（#cache/#refCount），
				// 而释放只走 loader 的 unload/destroy —— 插件从不调 → 只增不减。
				// 所以 EPUB 必须留在下面那条 loadText 分支。
				try {
					const blobUrl = await sec.load()
					if (!blobUrl) throw new Error("empty section url")
					// 读的是 blob: URL（章节内容），**不是**网络请求 —— 官方的 `requestUrl` 只发 HTTP，
					// 读不了 blob，这里只能 fetch。显式写 `window.fetch` 以免被上架规则误判成网络调用。
					const resp = await window.fetch(blobUrl)
					rawStr = await resp.text()
				} catch (e) {
					// AZW3(KF8) 的 sec.load() 内部 replaceResources 会为每个 `kindle:flow:`
					// 资源调 loadFlow → 依赖 FDST 表；而 mobi.js:965 的 FDST 解析被 try/catch
					// 静默吞掉，表缺失时全章抛 "Cannot read properties of undefined" →
					// 这本书每一章都拿不到 doc（实测整本 0 帧）。回退 createDocument()：
					// 只做解压+拼装、不做资源改写，正文一定可渲染，图片由 createMobiDoc 补。
					// （TXT 合成书也有 createDocument，走这条同样安全。）
					debugWarn("[UNreader] MOBI sec.load failed, fallback to createDocument:", e)
					return await this.createMobiDoc(idx, sec)
				}
			} else if (book.loadText) {
				// EPUB: 走 foliate 的 zip loader
				rawStr = await book.loadText(secIdStr)
			} else {
				return null
			}
			if (!rawStr || !rawStr.trim()) throw new Error("empty chapter source")
			// 宽松解析：杜绝严格 XHTML 报错导致的整章失败
			return new DOMParser().parseFromString(rawStr, "text/html")
		} catch (e) {
			console.warn("[UNreader] getSectionDoc failed for idx", idx, e)
			return null
		}
	}

	/** MOBI/AZW3 兜底取章：`sec.load()` 依赖的 FDST 表缺失时改走 `createDocument()`
	 *  （只解压不改写资源），并在这里补回图片 —— `recindex` 与 `kindle:embed:`
	 *  两条通道都走 `mobi.loadResource`，不经过 FDST，因此不受该缺陷影响。
	 *  `kindle:flow:`（CSS）仍不可用：直接丢弃，章节样式由 injectFrameCss 的主题接管。 */
	private async createMobiDoc(
		idx: number,
		sec: { createDocument?: () => Promise<Document> },
	): Promise<Document | null> {
		if (!sec.createDocument) return null
		let doc: Document | null = null
		try {
			doc = await sec.createDocument()
		} catch (e) {
			console.warn("[UNreader] MOBI createDocument failed for idx", idx, e)
			return null
		}
		if (!doc?.body) return null
		const book = this.el?.book as unknown as {
			loadRecindex?: (n: string) => Promise<string>
			loadResource?: (s: string) => Promise<string>
		} | null
		if (book) {
			// <img recindex="N"> —— MOBI 图片的标准通道
			await Promise.all(Array.from(doc.querySelectorAll("[recindex]")).map(async el => {
				try {
					const n = el.getAttribute("recindex")
					if (!n || el.getAttribute("src")) return
					const url = await book.loadRecindex?.(n)
					if (url) el.setAttribute("src", url)
				} catch { /* 单图失败不影响整章 */ }
			}))
			// src="kindle:embed:XXXX?mime=..."（KF8 资源）
			await Promise.all(Array.from(doc.querySelectorAll("img[src], image")).map(async el => {
				try {
					const raw = el.getAttribute("src")
						?? el.getAttribute("href")
						?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href")
					if (!raw?.startsWith("kindle:embed:")) return
					const url = await book.loadResource?.(raw)
					if (!url) return
					try { el.setAttribute("src", url) } catch { /* ignore */ }
					try { el.setAttribute("href", url) } catch { /* ignore */ }
				} catch { /* ignore */ }
			}))
		}
		return doc
	}

	/** 章节 html 产物构建（含会话缓存）：解压→宽松解析→资源改写→锚点→主题注入→序列化。
	 *  缓存 key 为章节 idx，主题 CSS 变化即整体失效；命中时跳过整条流水线
	 *  （章节回收后重访、往返滚动、深位置恢复的重复渲染直接受益）。
	 *
	 *  MOBI 适配：
	 *   - `book.loadText(secId)` MOBI 没有，改走 `sec.load()`（返回已改写资源的 blob URL）
	 *   - `secId` 改为 `string | number` 兼容（MOBI 章节 id 是 number）
	 *   - `rewriteResourcesLocal` 对 MOBI 自动跳过（book.loadBlob 不存在，方法早 return）
	 *   - flattenEpubSwitches 只对 EPUB 有意义，MOBI 不走 */
	private async buildSectionHtml(idx: number, secId: string | number): Promise<{ html: string; anchors: Map<string, ContAnchorRef>; blobs: Set<string> } | null> {
		const cached = this.contHtmlCache.get(idx)
		if (cached && cached.css === this.contFrameCss) {
			// LRU 触达：删了重插，保持 Map 插入序（最旧的在首位）
			this.contHtmlCache.delete(idx)
			this.contHtmlCache.set(idx, cached)
			return cached
		}
		if (cached) this.contHtmlCache.clear() // 主题/外观变化：旧产物全部失效
		const secIdStr = String(secId)
		const doc = await this.getSectionDoc(idx, secIdStr)
		if (!doc) return null
		// 分部标题页的标题内容并入本章开头（见 mergePartTitles / partHeadHtml）。
		// 必须早于 rewriteResourcesLocal 与 injectFrameCss：part 页里的图片/链接
		// 才会走同一套资源改写、继承同一套主题 CSS，排版与书内天然一致。
		const partHead = this.partHeadHtml.get(idx)
		if (partHead) {
			// 官方 lint 禁 insertAdjacentHTML（no-unsanitized/method）：改为 DOMParser
			// 解析后移动节点 —— partHead 本来就是本书自己 DOM 的序列化产物（mergePartTitles），
			// 内容可信，只换注入方式。倒序 insertBefore 到 body 头部，保持原有先后顺序。
			try {
				const parsed = new DOMParser().parseFromString(partHead, "text/html").body
				const nodes = Array.from(parsed.childNodes).reverse()
				// 逆序 insertBefore(firstChild)：等价 insertAdjacentHTML("afterbegin", …) 的保序插入
				for (const node of nodes) {
					doc.body?.insertBefore(doc.importNode(node, true), doc.body.firstChild)
				}
			} catch { /* ignore */ }
		}
		// EPUB 专属：展平 epub:type 开关节点（epub:switch / epub:case / epub:default），
		// MOBI 不使用这些标签，无副作用
		if (this.bookFormat === "epub") this.flattenEpubSwitches(doc)
		// rewriteResourcesLocal 对 MOBI 自动跳过（方法开头检查 book.loadBlob）
		await this.rewriteResourcesLocal(doc, secIdStr)
		const anchors = this.rewriteAnchors(doc, idx, secIdStr)
		this.injectFrameCss(doc)
		// HTML 序列化（不能用 XMLSerializer）：见 serializeFrameHtml 注释
		const html = serializeFrameHtml(doc)
		// 记录产物引用的 blob 资源：pruneBlobCache 据此把缓存命中的 URL 视同活引用，
		// 防止重载帧的图片资源被提前 revoke
		const blobs = new Set<string>()
		for (const m of html.matchAll(/blob:[^"'\s<>)]+/g)) blobs.add(m[0])
		const entry = { css: this.contFrameCss, html, anchors, blobs }
		this.contHtmlCache.set(idx, entry)
		if (this.contHtmlCache.size > EngineAdapter.CONT_HTML_CACHE_MAX) {
			const oldest = this.contHtmlCache.keys().next().value
			if (oldest != null) this.contHtmlCache.delete(oldest)
		}
		return entry
	}

	/** `contRendering` 在途标记的包装：`renderSectionInner` 的每条退出路径（含抛错被吞）
	 *  都必须清标记——漏清会让该章被永久误判为「在途」，跳转期间的陈旧占位回收就再也碰不到它。 */
	private async renderSection(idx: number, wrap: HTMLElement, record?: ContFrame): Promise<void> {
		this.contRendering.add(idx)
		try {
			await this.renderSectionInner(idx, wrap, record)
		} finally {
			this.contRendering.delete(idx)
		}
	}

	private async renderSectionInner(idx: number, wrap: HTMLElement, record?: ContFrame): Promise<void> {
		const el = this.el
		const book = el?.book as unknown as {
			// MOBI 章节 id 是 number（foliate-js mobi.js:716 `id: index`）
			sections?: { id?: string | number }[]
		} | null
		const sec = book?.sections?.[idx]
		// MOBI 章节 id=0 是合法章节（mobi 章节下标从 0 开始）；用 `== null` 替代 `!sec?.id` 避免 0 被误判
		if (sec?.id == null) { this.failFrame(idx, record); return }
		try {
			const built = await this.buildSectionHtml(idx, sec.id)
			if (!built) { this.failFrame(idx, record); return }
			// 完成守卫：占位若已被看门狗回收并重试，本轮渲染作废，避免重复 iframe 与过期记录
			if (this.contFrames.get(idx) !== record) {
				return
			}
			// 提前接线：srcdoc 的 load 要等全部子资源（图片）加载完，有图章节拖后数秒，
			// 期间沉浸模式点按/翻页键全部失灵。往 srcdoc 尾部内联一段引导脚本，
			// 在 DOMContentLoaded（解析完成、图片未必要等）即回调宿主接线——
			// srcdoc 同源（allow-same-origin）且 Obsidian CSP 未限制 script-src，
			// 内联脚本确定执行。load 监听保留作兜底（f.wired 幂等守卫防重复）。
			// 注意：这段脚本文本会被原样插进 srcdoc（不经过任何转义），因此不能出现
			// `</script` 序列（会提前终结 script data 状态）。`<`、`&&` 本身合法——
			// srcdoc 按 HTML 解析，`<script>` 内是 raw text，不涉及 XML 实体解码。
			const uid = `f${idx}-${Math.random().toString(36).slice(2, 8)}`
			const hooks = (window as unknown as { __unreaderReadyHooks?: Record<string, () => void> })
			hooks.__unreaderReadyHooks = hooks.__unreaderReadyHooks ?? {}
			const f: ContFrame = { idx, iframe: null as unknown as HTMLIFrameElement, doc: null, pageUrl: "", anchors: built.anchors, lastHeight: 0, timers: [], ro: null, loaded: true }
			hooks.__unreaderReadyHooks[uid] = () => {
				delete hooks.__unreaderReadyHooks![uid]
				this.wireFrame(idx, f)
			}
			const readyTag = `<script>(function(){var f=function(){try{var p=window.parent;if(p){var h=p.__unreaderReadyHooks;if(h){var fn=h["${uid}"];if(fn){fn()}}}}catch(e){}};if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",f)}else{f()}})();</script>`
			// 尾部再挂侧栏手势桥：iframe 内识别横向 pan → 直接函数调用宿主原生抽屉
			const swipeTag = `<script>${SIDEBAR_SWIPE_BRIDGE_JS}</script>`
			// Obsidian 的 DOM 增强只装在主窗口 realm。核心 Modal.open() 会把焦点从
			// <iframe> 下钻到 contentDocument.activeElement，close() 再对该跨 realm
			// 元素调 instanceOf/hasClass/win；缺这层补丁会在关闭命令面板时抛错，
			// 令 selectSuggestion() 中断在 onChooseSuggestion() 之前（第一次命令不执行）。
			// 每个章节 frame 先装兼容垫片，且必须早于 readyTag 触发的接线。
			const compatTag = `<script>${OBSIDIAN_IFRAME_DOM_COMPAT_JS}</script>`
			const bridgeTags = compatTag + readyTag + swipeTag
			// 插入位置按格式分流，**网页原样必须插在 head 开头**：
			//   · 书本模式：作者 CSS 早就被丢光，章节文档里只有我们自己的样式，尾部注入即可；
			//   · 网页模式：作者 CSS 原样保留，而浏览器规定「样式表会阻塞它之后的解析型脚本」——
			//     桥接脚本挂在 body 末尾时，head 里那条**远程** stylesheet 只要慢（离线、代理、
			//     被墙），脚本就一直不执行，DOMContentLoaded 跟着不触发，接线被拖到看门狗
			//     （10s）超时 → 重试一次仍然如此（≥2 次进 contFailed）→ 该节永久空白。
			//     「打开一份带远程 CSS 的剪藏」正好是最常见的离线场景，所以这不是理论风险。
			//     插到 `<head>` 之后、作者样式表之前：脚本立刻执行（只注册 DOMContentLoaded
			//     监听，不碰 body），接线时机与 CSS 完全解耦；资源加载顺序不受影响。
			//     两个伴生脚本在 head 阶段同样安全：compat 只打原型补丁，swipe 只挂
			//     document 级触摸监听（均不依赖 body 存在）。
			const html = this.webLayout
				? built.html.replace(/<head(?:\s[^>]*)?>/i, m => m + bridgeTags)
				: built.html.replace(/<\/body>/i, bridgeTags + "</body>")
			const frame = createEl("iframe")
			f.iframe = frame
			frame.className = "unreader-cont-frame"
			frame.setAttribute("scrolling", "no")
			frame.setAttribute("title", String(idx))
			frame.style.cssText = CONT_FRAME_BASE_CSS
			// 设备模式（本地 HTML）：首次创建就要带上固定布局视口，否则会先用阅读区宽度
			// 渲染一帧、再重排一次（手机上是肉眼可见的闪动）
			this.applyWebDevice(f)
			// 有背景图时 frame 必须允许透明画布：宿主侧 iframe 元素继承 Obsidian
			// 的深色 color-scheme，同样会触发 Chromium 的深色画布填充盖住图片
			// 网页原样：color-scheme 由阅读器明暗决定（见 webColorScheme）；
			// 书本模式仍只在「有背景图」时把画布设为透明
			if (this.webColorScheme) frame.style.colorScheme = this.webColorScheme
			else if (this.contImgActive) frame.style.colorScheme = COLOR_SCHEME_NORMAL
			wrap.appendChild(frame)
			wrap.classList.add("unreader-loaded")
			// 用 srcdoc 注入整章 HTML：完全规避 blob: iframe 在移动端（尤其 Android WebView）
			// 的 CSP frame-src 拦截——blob frame 在部分 WebView 上 src 加载被拦、load 不触发、
			// 内容一片空白。srcdoc 全平台同源可读（contentDocument 可访问），是最稳的渲染路径。
			this.contFrames.set(idx, f)
			frame.addEventListener("load", () => this.wireFrame(idx, f))
			// 就绪看门狗：srcdoc 内容异常时 load 与 DOMContentLoaded 可能都不触发，
			// 而「unreader-loaded」标记已打上，loadSections 会永久去重跳过——本章
			// 无限空白且无重试路径（旧实现的真实悬挂点）。超时未接线 → 摘标记、
			// 重置 frame 重新入队；同一章连续挂起 2 次进黑名单，防无限重试 livelock。
			f.timers.push(window.setTimeout(() => {
				if (this.contFrames.get(idx) !== f || f.wired) return
				delete hooks.__unreaderReadyHooks![uid]
				const retries = (this.contHangRetries.get(idx) ?? 0) + 1
				this.contHangRetries.set(idx, retries)
				const w = this.contSectionEls.get(idx)
				try { frame.remove() } catch { /* ignore */ }
				this.contFrames.delete(idx)
				if (w) w.classList.remove("unreader-loaded")
				if (retries >= 2) this.contFailed.add(idx)
				else this.ensureFilledSoon()
			}, 10000))
			frame.srcdoc = html
			void this.linkResolve(idx, sec.id)
			this.emitContinuousRelocateSoon()
			this.ensureFilledSoon()
		} catch (e) {
			console.warn("[UNreader] continuous frame render failed", idx, e)
			this.failFrame(idx, record)
			this.ensureFilledSoon()
		}
	}


	private schedulePruneSoon(): void {
		// 前缘去抖（至多每 400ms 一次）：恢复/远跳的级联补载会持续触发调度，
		// 尾缘去抖会让回收被无限推迟（级联期间活 frame 撑爆，半透明窗口闪烁）
		if (this.contPruneTimer) return
		this.contPruneTimer = window.setTimeout(() => {
			this.contPruneTimer = 0
			this.maybeUnloadFarFrames()
		}, 400)
	}

	private contKeepThreshold(): number {
		try {
			const v = parseInt(window.localStorage.getItem("unreader-keep-frames") ?? "", 10)
			if (Number.isFinite(v) && v >= 2) return v
		} catch { /* ignore */ }
		return CONT_KEEP_FRAMES
	}

	/** 视口中心所在章的 contOrder 位置（找不到包含者时取最近章） */
	private orderPosAtViewport(cont: HTMLElement): number {
		const center = cont.scrollTop + cont.clientHeight / 2
		let best = -1
		let bestDist = Infinity
		for (const [idx, w] of this.contSectionEls) {
			const pos = this.contOrder.indexOf(idx)
			if (pos < 0) continue
			const top = w.offsetTop
			const bottom = top + w.offsetHeight
			if (center >= top && center < bottom) return pos
			const dist = center < top ? top - center : center - bottom
			if (dist < bestDist) { bestDist = dist; best = pos }
		}
		return best
	}

	/** 阈值卸载：常驻 frame 超过 keep 时，滚动停顿 400ms 后卸载「远离当前章且远离视口」的章节。
	 *  卸载保留 minHeight 占位 → offsetTop 数学不移位；摘掉 loaded 标记使其回到 ensureFilled 待载队列。 */
	private maybeUnloadFarFrames(): void {
		const cont = this.continuousEl
		if (!cont || !this.isContinuous || !this.continuousRendered) return
		// 跳转期间不做全局禁载：深位置恢复/远跳的路径补载会瞬时加载大量章节，
		// 若等漂移校正（最长~10s）结束再回收，窗口内活 frame 会撑爆（半透明窗口闪烁源）。
		// 安全性：只回收「已测量高度」的远章——卸载保留 minHeight 占位，offsetTop 不移位，
		// 落点校正不受影响；未测量的路径章（lastHeight=0，卸载即塌缩）原样保留。
		// 另保护「视口→目标」之间的路径章：它们是 pumpLoadToward/级联补载的装载对象，
		// 回收会被立即重载，形成加载-卸载抖动；只回收行进方向后方的远章。
		const keep = this.contKeepThreshold()
		const target = Math.max(4, keep - 4)
		const loaded = this.contOrder.filter(i => !!this.contFrames.get(i)?.doc)
		if (loaded.length <= keep) return
		const curPos = this.contOrder.indexOf(this.currentIndex)
		let pathLo = -1
		let pathHi = -1
		if (this.jumpPending) {
			const vpPos = this.orderPosAtViewport(cont)
			if (curPos < 0 || vpPos < 0) return // 位置不可判定：本次不回收（保守）
			pathLo = Math.min(vpPos, curPos)
			pathHi = Math.max(vpPos, curPos)
		}
		const vpTop = cont.scrollTop
		const vpBottom = cont.scrollTop + cont.clientHeight
		const screens = cont.clientHeight * CONT_UNLOAD_MIN_SCREENS
		const far = loaded.filter(i => {
			if (!((this.contFrames.get(i)?.lastHeight ?? 0) > 0)) return false // 未测量：卸载会塌缩占位
			const pos = this.contOrder.indexOf(i)
			if (curPos >= 0 && Math.abs(pos - curPos) < CONT_UNLOAD_MIN_DIST) return false
			if (pos >= pathLo && pos <= pathHi) return false // 跳转路径章：补载对象，勿回收
			const w = this.contSectionEls.get(i)
			if (!w) return false
			const top = w.offsetTop
			const bottom = top + w.offsetHeight
			return !(bottom > vpTop - screens && top < vpBottom + screens)
		}).sort((a, b) => Math.abs(this.contOrder.indexOf(b) - curPos) - Math.abs(this.contOrder.indexOf(a) - curPos))
		let remaining = loaded.length
		for (const i of far) {
			if (remaining <= target) break
			this.unloadFrame(i)
			remaining--
		}
		this.emitContinuousRelocateSoon()
	}

	private unloadFrame(i: number): void {
		const f = this.contFrames.get(i)
		const w = this.contSectionEls.get(i)
		if (!f || !w || !f.doc) return
		try { f.ro?.disconnect() } catch { /* ignore */ }
		f.ro = null
		for (const id of f.timers) { try { window.clearTimeout(id) } catch { /* ignore */ } }
		f.timers = []
		// 占位必须取实时高度而非 lastHeight：图片/字体晚到时 lastHeight 可能小于真实高度，
		// 用旧值占位会让上方内容突然变矮、版面往上弹一下（落地 bounce 的上弹一半）。
		// 实时 offsetHeight 是当前真相；只可能更大，不会更小。
		try {
			const liveH = w.offsetHeight || 0
			const keep = Math.max(f.lastHeight, liveH)
			if (keep > 0) w.style.minHeight = keep + "px"
		} catch { /* ignore */ }
		try { f.iframe.remove() } catch { /* ignore */ }
		try { URL.revokeObjectURL(f.pageUrl) } catch { /* ignore */ }
		this.contFrames.delete(i)
		w.classList.remove("unreader-loaded")
		const stale = this.contHLByIndex.get(i) ?? []
		for (const cfi of stale) { const data = this.contHL.get(cfi); if (data) { data.els = []; } }
	}

	private failFrame(idx: number, record?: ContFrame): void {
		const wrap = this.contSectionEls.get(idx)
		if (record && this.contFrames.get(idx) === record) this.contFrames.delete(idx)
		if (wrap) {
			wrap.classList.remove("unreader-loaded")
			wrap.classList.add("unreader-frame-error") // 本次会话不再自动重试，保留占位与手动重试通道
		}
	}

	/** 内部链接 → #nr-N 映射（同源 iframe 内禁内滚，点击由宿主接管） */
	private rewriteAnchors(doc: Document, idx: number, secBase: string): Map<string, ContAnchorRef> {
		const map = new Map<string, ContAnchorRef>()
		const book = this.el?.book as unknown as { resolveHref?: (href: string) => { index?: number; anchor?: unknown } | null } | null
		for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
			try {
				const raw = a.getAttribute("href") ?? ""
				if (!raw || /^(?:https?:|mailto:|blob:|data:|ftp:)/i.test(raw)) continue
				if (raw.startsWith("#")) {
					const key = `nr-${++this.contAnchorSeq}`
					map.set(key, { index: idx, hash: decodeURIComponent(raw.slice(1)) })
					a.setAttribute("href", "#" + key)
					continue
				}
				const hashIdx = raw.indexOf("#")
				const pathPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx)
				const hashPart = hashIdx === -1 ? null : decodeURIComponent(raw.slice(hashIdx + 1))
				if (!pathPart) continue
				const resolved = this.resolveRel(pathPart, secBase)
				const t = book?.resolveHref?.(resolved)
				if (t && typeof t.index === "number") {
					const key = `nr-${++this.contAnchorSeq}`
					map.set(key, { index: t.index, hash: hashPart })
					a.setAttribute("href", "#" + key)
				}
			} catch { /* 保留原样 */ }
		}
		return map
	}

	/** epub:switch 在 HTML 宽松解析下会把所有 case 分支一起渲染（正文重复两遍），
	 *  这里按规范折叠为 default（无 default 时取首个 case），消除重复内容。 */
	private flattenEpubSwitches(doc: Document): void {
		let switches: Element[] = []
		for (const sel of ["switch", "epub\\:switch"]) {
			try { switches = switches.concat(Array.from(doc.querySelectorAll(sel))) } catch { /* ignore */ }
		}
		for (const sw of switches) {
			try {
				let keep: Element | null = null
				for (const sel of ["default", "epub\\:default"]) {
					try { keep = sw.querySelector(sel); if (keep) break } catch { /* ignore */ }
				}
				if (!keep) {
					for (const sel of ["case", "epub\\:case"]) {
						try { keep = sw.querySelector(sel); if (keep) break } catch { /* ignore */ }
					}
				}
				const parent = sw.parentNode
				if (!parent) continue
				if (keep) { while (keep.firstChild) parent.insertBefore(keep.firstChild, sw) }
				parent.removeChild(sw)
			} catch { /* ignore */ }
		}
	}

	/** 临时显形被隐藏的注释宿主（⌘点击/跳转目标可能是 display:none 的注释体） */
	private revealNoteAround(elx: Element | null): void {
		if (!elx) return
		try {
			let note: Element | null = null
			try { note = elx.closest(NOTE_ANCESTOR_SELECTOR) } catch { /* ignore */ }
			if (!note && elx.tagName === "ASIDE") note = elx
			if (!note || note.classList.contains("unreader-note-reveal")) return
			note.classList.add("unreader-note-reveal", "unreader-note-flash")
			window.setTimeout(() => {
				try { note.classList.remove("unreader-note-reveal", "unreader-note-flash") } catch { /* ignore */ }
			}, 8000)
		} catch { /* ignore */ }
	}

	/** 注入 frame 基础约束 + 用户主题 */
	private injectFrameCss(doc: Document): void {
		const head = doc.head ?? doc.documentElement.querySelector("head")
		if (!head) return
		// frame 是**独立的 document**，宿主的 styles.css 根本进不去，只能就地注入 <style>。
		// 用全局 `createEl`（Obsidian 的 DOM 助手，造出的是**游离**节点）而不是
		// `doc.createElement`：随后 `head.appendChild` 会按 DOM 规范把它收养进这个 frame
		// 文档，效果完全一致；也不撞 `no-forbidden-elements`（那条规则只认
		// `document.createElement("style")` 与 `某对象.createEl("style")` 两种写法）。
		const base = createEl("style")
		base.id = "unreader-frame-base"
		// NOTE_HIDE_CSS 含 @namespace，必须保持在其所在样式表最顶端 → 放 base 段首
		// touch-action:pan-y：向浏览器声明横向位移不是滚动、由应用层接管。这样横滑
		// 时浏览器不会判定为滚动而取消触控流（也不需要 non-passive 监听/preventDefault，
		// 纵向滚动得以留在合成器快路径）。html/body 本就 overflow:hidden，纵向滚动
		// 始终是链到宿主 continuousEl，不受影响。
		// text-size-adjust:100%：iOS/移动 WebView 默认按「布局宽度」自动微调字号
		// （-webkit-text-size-adjust:auto），侧栏开合会改变正文可用宽度 → 触发一次
		// 自动字号修正，表现就是滑动侧栏时「正文字体轻微变动」。锁死为 100% 后
		// 字号只由我们自己的主题 CSS 决定，不再随宽度漂移。
		// 书本模式：版心由阅读器控制，任何残留的 margin/padding 都是干扰，一律清零。
		// 网页模式**相反**：body 的默认 8px 边距、作者写的 `body{padding:2em}` 都是
		// 「网页打开的样子」的一部分，抹掉就不是原样了（见 core/htmlBook.ts 文件头）。
		const boxReset = this.webLayout ? "" : "margin:0!important;padding:0!important;"
		// 纵向 overflow 必须锁死：宿主滚动是唯一滚动源，frame 内部一旦能滚，
		// 滚轮落在 frame 上就会变成滚章节内部（连续滚动的「无感换章」当场失效）。
		// 横向反过来 —— 网页原样下超宽内容（表格/代码块/大图）需要一条出口，
		// `auto` 只在真的超宽时出现滚动条（浏览器行为）。**不加 `!important`**：
		// 作者显式声明 `overflow-x:hidden` 是他的选择。
		base.textContent = `${NOTE_HIDE_CSS}
html,body{overflow-y:hidden!important;overflow-x:auto;${boxReset}touch-action:pan-y;-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important;}body{position:relative;-webkit-touch-callout:none;}.unreader-hl-rect{position:absolute;border-radius:2px;pointer-events:auto;cursor:pointer;z-index:1;mix-blend-mode:multiply;}`
		head.appendChild(base)
		const theme = createEl("style")
		theme.id = "unreader-theme"
		theme.textContent = this.contFrameCss
		head.appendChild(theme)
	}

	/** 网页原样通道（本地 HTML）的 frame 样式：**只放零特异性兜底**。
	 *
	 *  `:where()` 的特异性是 0，比作者的任何声明都低 —— 所以这些规则只在
	 *  「作者没表态」的地方生效。反过来，写成 `html{…}`（特异性 0,0,1）或挂上
	 *  `!important` 就会盖掉作者样式，「网页打开什么样就什么样」当场失效。
	 *  **本方法里出现的每一条都要按这个标准审查**，这是它与上方 contFrameCss
	 *  那套（刻意强制的书本化排版）最根本的区别。
	 *
	 *  只兜三件事：
	 *   ① `canvas`/`canvastext` —— 没自带配色的页面跟随阅读器明暗。这两个系统色
	 *      随 `color-scheme` 走，而 color-scheme 由宿主侧的 iframe 元素提供
	 *      （见 webColorScheme：内嵌文档自己的声明优先级更高，作者赢）。
	 *   ② 阅读器的字体/字号/行距作为**无样式页面**的默认（`px` 写死的网页不受影响）。
	 *   ③ 图片/视频不撑破容器。这条严格说不是「原样」，而是**溢出防护**：
	 *      章节 frame 的纵向滚动被锁死，超宽内容只会被裁掉、没有任何出口，
	 *      两害相权取其轻。作者显式写了宽度则作者赢（特异性 0 < 0,0,1）。
	 */
	private buildWebFrameCss(app: ResolvedAppearance, accent: string): string {
		// `customFontRules` 是 `@font-face` 声明（没有选择器，不影响特异性），
		// 必须带上：否则无样式页面里的 `font-family` 会指向一个从未定义的字族，
		// 用户选的自定义字体在网页模式下静默失效（FontFace 注册是另一条保险）。
		return `${app.customFontRules ?? ""}
:where(html){background:canvas;color:canvastext}
:where(body){font-family:${app.fontFamily};font-size:${app.fontSize}px;line-height:${app.lineHeight}}
:where(img,video,canvas){max-width:100%;height:auto}
:where(a){color:${accent}}
`.trim()
	}

	/** 用 FontFace API 把自定义字体注册进 frame 自身文档。
	 *  CSS @font-face 在某些移动端 WebView（尤其 srcdoc iframe）加载 blob/data 字体不可靠，
	 *  FontFace 是浏览器级 API，跨 iOS/Android/桌面一致生效。桌面保留 CSS 双保险。 */
	private registerCustomFontsIn(f: ContFrame): void {
		const d = f.doc
		if (!d) return
		// 只注册当前外观引用的字体（customFontEntries 已过滤）；同一 frame 在同一套
		// 字体下只做一次——换字号/边距/配色都会触发主题刷新循环重跑本方法，不设
		// 签名闸门就会把 N 个 frame × 每次调整都重新解析一遍字体二进制。
		// **签名必须含 src**：同一个 id 的 src 会跨轮变化（未被引用时是空串、被引用后
		// 变 blob:、字体文件被替换时 blob 重建）。只吃 id 的话，某个 frame 在字体「尚未
		// 建出 blob」的那一轮就写下了签名 → 之后 blob 建好、src 变了，签名却判等 →
		// 这个 frame 永远拿不到字体（改字号/重开书才会碰巧走到）。宿主侧的
		// fontRegistrySig 已经是 id:src 口径，这里与它对齐。
		const entries = customFontEntries()
		const sig = entries.map(e => `${e.id}:${e.src}`).join("|")
		if (f.fontSig === sig) return
		f.fontSig = sig
		try {
			for (const fe of entries) {
				const src = fe.src.startsWith("blob:") ? `url(${fe.src})` : `url("${fe.src}")`
				const face = new FontFace(fe.name, src, { display: "swap" })
				void face.load().then(() => {
					try { d.fonts.add(face) } catch { /* ignore */ }
				}).catch(() => { /* 字体加载失败：回退系统字体 */ })
			}
		} catch { /* FontFace 不可用（旧内核）则忽略，CSS @font-face 兜底 */ }
	}

	/** 量取一章的**真实内容高度**（px）。
	 *
	 *  ⚠️ **绝不能用 `documentElement.scrollHeight`**：根元素的 scrollHeight 自带
	 *  **视口钳位** —— 它至少等于当前 ICB 高，也就是「至少等于本 iframe 现在的高度」。
	 *  实测（内容 120px、iframe 高 400px）：`documentElement.scrollHeight` 返回 **400**，
	 *  而 `body.scrollHeight` / `body.offsetHeight` 都稳定返回 120。
	 *  旧实现取 `Math.max(documentElement.scrollHeight, body.scrollHeight)`，于是 max
	 *  **永远选中被钳住的那个值** ⇒ 章节盒子只能涨不能缩：iframe 的默认高度（150px）、
	 *  建帧占位（60vh）、或任何一次「先撑大后变短」（webfont 载入后重排、图片加载/失败、
	 *  转屏或分屏变宽）都会把那一章**永久**留在旧高度上 —— 正文之后就是一片空白，且
	 *  **不会自愈**（每轮重测都读回同一个被钳住的值，`|h - lastHeight| > 1` 恒不成立，
	 *  写回被挡掉）。用户报的「iPad 上两个章节之间、正文之后很大一片空白」就是它。
	 *
	 *  现口径：body 的滚动盒高与布局盒高取大（**两者都不受视口钳位**；前者还能覆盖
	 *  绝对定位/浮动溢出 body 盒的情形），再用末几个子元素的底边兜底。body 在本帧里被
	 *  `overflow:hidden` 强制成 BFC，末子元素的下外边距本来就被算进它的盒高。
	 *  调试开关 `localStorage["unreader-legacy-measure"]="1"` 恢复旧口径（回归阴性对照用）。 */
	private measureFrameContentHeight(d: Document): number {
		const body = d.body
		if (!body) return 0
		try {
			if (window.localStorage.getItem("unreader-legacy-measure") === "1") {
				return Math.max(d.documentElement?.scrollHeight ?? 0, body.scrollHeight)
			}
		} catch { /* ignore */ }
		let h = Math.max(body.scrollHeight, body.offsetHeight)
		const bodyTop = body.getBoundingClientRect().top
		const kids = body.children
		for (let i = Math.max(0, kids.length - 3); i < kids.length; i++) {
			const el = kids[i]
			if (el) h = Math.max(h, el.getBoundingClientRect().bottom - bodyTop)
		}
		// 网页原样：上面几条量到的都是**盒高**，不含 body 的外边距 —— 而网页模式
		// 刻意不清零 `body{margin}`（UA 默认的 8px、作者写的值都算「网页的样子」）。
		// 不补回来的话章节高度比真实内容矮一条外边距，表现为正文底部被裁掉一截，
		// 且因为每轮重测都得到同一个偏小的值，**永远不会自愈**。
		if (this.webLayout) {
			try {
				const cs = getComputedStyle(body)
				h += (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
			} catch { /* ignore */ }
		}
		return h
	}

	/* ---------------- 网页设备模式（本地 HTML 专用） ---------------- */

	/** 切换网页（本地 HTML）的**设备模式**：非 auto 时给每个章节 frame 一个固定的
	 *  **布局视口宽度**（见 WEB_DEVICE_WIDTH），再整体缩放到阅读区宽度。
	 *
	 *  为什么需要：手机上的阅读区只有 ~390px，而「网页原样」通道不给作者 CSS 兜底
	 *  （见 core/htmlBook.ts 文件头）—— 固定宽度 / `min-width` 的桌面页面会横向溢出，
	 *  而 frame 里 `touch-action:pan-y` 把横向拖动让给了原生侧栏手势，于是**右半页
	 *  永远够不着**（用户报的「手机上打开一些 HTML 看不到完整内容」）。设备模式把整页
	 *  按比例缩到阅读区宽度，一次看全；缩到多小由模式档位决定。
	 *
	 *  实现用 `zoom` 而不是 `transform: scale()`：zoom 会改变元素的**布局尺寸** ——
	 *  父容器看到的就是缩过之后的宽高，章节占位（offsetTop/offsetHeight）、宿主滚动
	 *  高度、点按命中全部自动成立（Chromium 实测：getBoundingClientRect 返回缩放后的
	 *  值、真实鼠标点击按缩放后坐标正确落进 frame、frame 内 `innerWidth` 是设备宽度
	 *  而不是容器宽度 ⇒ 媒体查询按该设备档生效）。transform 只改绘制，父容器仍按
	 *  1280px 排版，每处高度数学都得自己补一次换算。
	 *
	 *  只对 webLayout 生效：EPUB/TXT 的版式由阅读器控制，塞一个 1280px 的布局视口
	 *  只会把正文挤成一条窄带。 */
	setWebDevice(mode: WebDeviceMode): void {
		if (this.webDevice === mode) return
		this.webDevice = mode
		this.syncWebDevice()
	}

	getWebDevice(): WebDeviceMode { return this.webDevice }

	/** 当前这本是不是「网页原样」通道（本地 HTML）。工具栏据此显隐设备模式按钮。 */
	isWebLayout(): boolean { return this.webLayout }

	/** 重算所有 frame 的设备视口与缩放比，并重测高度（宽度一变内容必然重排）。
	 *  阅读区宽度变化（转屏 / 分屏 / 侧栏开合）之后必须再调一次。 */
	syncWebDevice(): void {
		// 只在签名真的变了时重测：本函数挂在 notifyVisible（叶子可见 / 阅读区尺寸变化）
		// 上，那条路径调用极频繁，签名不变就必须是零成本。
		this.contFrames.forEach(f => {
			if (this.applyWebDevice(f)) this.scheduleFrameSize(f)
		})
	}

	/** 当前该给 frame 的**布局视口宽度**（px）；0 = 不干预（auto 档，跟随阅读区）。 */
	private webDeviceWidth(): number {
		if (!this.webLayout) return 0
		return WEB_DEVICE_WIDTH[this.webDevice as Exclude<WebDeviceMode, "auto">] ?? 0
	}

	/** 缩放比（1 = 不缩放）。**上限锁 1**：阅读区比目标设备还宽时不放 ——
	 *  「手机档」在桌面端放大三倍毫无意义；此时 frame 保持设备宽度并居中。 */
	private webDeviceScale(): number {
		const w = this.webDeviceWidth()
		if (!w) return 1
		const avail = this.continuousEl ? this.continuousEl.clientWidth : 0
		if (avail <= 0) return 1
		return Math.min(1, avail / w)
	}

	/** 把设备视口落到这一帧上。返回**签名是否变了**（调用方据此决定要不要重测高度）。
	 *  幂等：签名不变就一行比较返回（resize / notifyVisible 路径上每帧都调）。 */
	private applyWebDevice(f: ContFrame): boolean {
		// 占位 frame（renderSection 完成前登记的记录）还没有 iframe 元素：`contFrames`
		// 里一直有这类半成品，而 syncWebDevice 会从 notifyVisible（加载期间频繁触发）
		// 走到这里 —— 不挡住就是空指针。
		if (!f.iframe) return false
		const w = this.webDeviceWidth()
		const k = w ? this.webDeviceScale() : 1
		const sig = w + "|" + k
		if (f.deviceSig === sig) return false
		f.deviceSig = sig
		// 切换前的**视觉高**：必须在写样式之前读（minHeight 与 iframe 高度都是缩放后的值，
		// offsetHeight 取两者较大者，即当前真实占位高）。
		const w0 = this.contSectionEls.get(f.idx)
		const prevVis = w0 ? w0.offsetHeight : 0
		const st = f.iframe.style
		if (!w) {
			// 摘掉覆盖值 ⇒ 基础 CSS 的 `var(--ur-frame-w,100%)` 落回 100%（跟随阅读区）。
			// 注意这里能动用的只有变量：frame 的 `width` 本身是基础 CSS 的一部分，
			// 直接 removeProperty("width") 会把基础宽度一起删掉，frame 退回
			// iframe 的默认宽 300px（auto 档当场变窄一截）。
			st.removeProperty(FRAME_WIDTH_VAR)
			st.removeProperty("zoom")
			st.removeProperty("margin-inline")
		} else {
			st.setProperty(FRAME_WIDTH_VAR, w + "px")
			// 居中：阅读区比目标设备宽时（k 锁在 1）页面不会贴在左边
			st.marginInline = "auto"
			if (k < 1) st.zoom = String(k)
			else st.removeProperty("zoom")
		}
		// 章节占位高度活在**宿主视觉空间**（见 frameVisualHeight）。缩放比一变，旧占位值
		// 立刻失真（auto→手机差 3 倍），文档总高会按旧比例撑住、切换瞬间画面整体跳掉。
		// 这里就地换算一次并做视口补偿；随后那次重测只负责「内容重排本身的增量」，
		// 它的 deltaWrap 基准（frameVisualHeight(lastHeight)）与这里写入的值正好对齐。
		if (w0 && f.lastHeight > 0) {
			const newVis = this.frameVisualHeight(f.lastHeight)
			w0.style.minHeight = newVis + "px"
			this.compensateHeightShift(w0, prevVis, newVis)
		}
		return true
	}

	/** 帧内内容高 → **宿主视觉高**。设备模式下帧内是按设备宽度布局量出来的 CSS px，
	 *  而宿主看到的是缩放后的盒子；占位高度与视口补偿都必须换成换算后的值，
	 *  否则每章下面会拖一条 (1−k) 的空白（章节之间凭空多出一大块）。 */
	private frameVisualHeight(h: number): number {
		if (!this.webDeviceWidth()) return h
		return Math.round(h * this.webDeviceScale())
	}

	/** 把量到的帧内内容高落到 DOM：frame 高度 + 章节占位 + 视口上方内容的高度补偿。
	 *  **两处调用点共用**（初次接线与 rAF 排程各一处），避免同一段数学改了一半。 */
	private writeFrameHeight(idx: number, f: ContFrame, h: number): void {
		const w0 = this.contSectionEls.get(idx)
		const oldWrapH = w0 ? w0.offsetHeight : 0
		const prevH = f.lastHeight
		const hVis = this.frameVisualHeight(h)
		// 首次渲染时 wrap 高度是占位（12vh / iframe 默认高），
		// 实际增量 = 真实高度 − 占位高度，而非 h − 0
		const deltaWrap = prevH > 0 ? hVis - this.frameVisualHeight(prevH) : hVis - oldWrapH
		f.lastHeight = h
		f.iframe.style.height = h + "px"
		if (w0) {
			w0.style.minHeight = hVis + "px"
			// 视口上方内容高度变化时稳住阅读位置（否则表现为翻页第一步多滚一页）
			this.compensateHeightShift(w0, oldWrapH, oldWrapH + deltaWrap, prevH === 0)
		}
		// 本章真实高度到手 = 一次可靠的比例样本：校准其余未载章的占位高度，
		// 让文档总高尽早贴近真实（远距离跳转能否一次直达取决于此）
		this.recalibratePlaceholders()
		this.ensureFilledSoon()
	}

	/** iframe 就绪：高度测量 + 交互接线 */
	private wireFrame(idx: number, f: ContFrame): void {
		if (f.wired) return // 提前接线已覆盖，load 兜底不再重复挂监听
		const d = f.iframe.contentDocument
		const cont = this.continuousEl
		if (!d || !d.body || !cont) return
		f.wired = true
		f.doc = d
		// 接线成功即既往挂起记录作废：偶发一次挂起不应累积成黑名单
		this.contHangRetries.delete(idx)
		if (!this.firstFrameLogged) {
			this.firstFrameLogged = true
			perfPoint("firstFrame")
		}
		f.iframe.style.minHeight = FRAME_MIN_HEIGHT_CLEARED
		// 接线完成：恢复 iframe 自身接收事件（接线前为 none，点按穿透到容器兜底）
		f.iframe.style.pointerEvents = POINTER_EVENTS_AUTO
		// 用 FontFace API 把自定义字体注册进 frame 自身文档：CSS @font-face 在某些
		// 移动端 WebView（尤其 srcdoc iframe）加载 blob/data 字体不可靠，FontFace 注册
		// 是浏览器级 API，跨 iOS/Android/桌面一致生效（桌面已有 @font-face 双保险）。
		this.registerCustomFontsIn(f)
		const measure = (): void => {
			try {
				const h = this.measureFrameContentHeight(d)
				if (h > 0 && Math.abs(h - f.lastHeight) > 1) {
					this.writeFrameHeight(idx, f, h)
				}
			} catch { /* ignore */ }
		}
		measure()
		d.querySelectorAll("img").forEach((im: HTMLImageElement) => {
			if (!im.complete) im.addEventListener("load", () => this.scheduleFrameSize(f), { once: true })
			im.addEventListener("error", () => this.scheduleFrameSize(f), { once: true })
		})
		void (d as Document & { fonts?: FontFaceSet }).fonts?.ready?.then(() => this.scheduleFrameSize(f))
		try {
			const ro = new ResizeObserver(() => this.scheduleFrameSize(f))
			ro.observe(d.body)
			f.ro = ro
		} catch { /* ignore */ }
		// 补测定时器精简：保留首测后三个节点（覆盖晚到图片/字体/懒加载布局）。
		// 旧版 6 个级联定时器每帧都强制 reflow，在低端 Android 上叠加 RO/图片事件
		// 会造成阅读卡顿；RO + fonts.ready + img.load 已是主触发，定时器仅兜底。
		;[100, 500, 1500].forEach(ms => f.timers.push(window.setTimeout(measure, ms)))
		// 抑制系统长按选区菜单：插件自带工具条（固定正文区底部），系统 callout/contextmenu
		// 会与之同时弹出、位置冲突。桌面右键菜单不影响选区，仅拦长按/触屏触发的 contextmenu。
		d.addEventListener("contextmenu", (e: Event) => {
			const ev = e as MouseEvent
			// 触屏长按在移动端 contextmenu 的 detail 常为 0/1；桌面右键 detail 为 2
			if (ev.detail < 2 || (navigator.maxTouchPoints > 0 && ev.detail === 0)) e.preventDefault()
		})
		// 点击：普通=悬浮窗显示注释；⌘/Ctrl+点击=跳转
		d.addEventListener("click", e => { this.handleFrameClick(f, e) })
		// 长按注标直跳（触屏替代 ⌘/Ctrl+点击）：触摸按下 500ms 未滑动（>10px 取消，
		// 滚动手势不受影响）且仍落在同一注标上 → 直接跳转；随后跟进的 click 须消费掉，
		// 否则会再弹一次悬浮窗
		let pressTimer = 0
		let pressX = 0
		let pressY = 0
		let pressConsumed = ""
		d.addEventListener("pointerdown", e => {
			window.clearTimeout(pressTimer)
			// 点正文：桥接给宿主收起浮动面板/工具条/未钉住侧边栏。触屏与鼠标
			// 都收——iframe 内事件不冒泡到宿主 body，只在触屏收的话鼠标点正文
			// 关不掉任何浮层。
			this.handlers?.onFrameTap?.()
			if (e.pointerType !== "touch") return
			// 命中的注标可能压在高亮覆盖矩形底下 → 走穿透命中（见 linkFromEvent）
			const a = this.linkFromEvent(e)
			const key = a?.getAttribute("href") ?? ""
			if (!a || !key.startsWith("#nr-") || !this.isNoterefLink(a)) return
			const ref = f.anchors.get(key.slice(1))
			if (!ref) return
			pressX = e.clientX
			pressY = e.clientY
			pressTimer = window.setTimeout(() => {
				pressConsumed = key
				this.jumpToRef(ref)
			}, 500)
		})
		d.addEventListener("pointermove", e => {
			if (!pressTimer) return
			if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > 10) window.clearTimeout(pressTimer)
		})
		d.addEventListener("pointerup", () => window.clearTimeout(pressTimer))
		d.addEventListener("pointercancel", () => window.clearTimeout(pressTimer))
		f.longPressConsumed = () => {
			const k = pressConsumed
			pressConsumed = ""
			return k
		}
		// 悬停 380ms → 悬浮窗
		let hoverTimer = 0
		let lastKey = ""
		d.addEventListener("pointermove", e => {
			const ev = e as MouseEvent
			// 同上：被高亮盖住的注标也要能悬停出注释窗
			const a = this.linkFromEvent(ev)
			const key = a?.getAttribute("href") ?? ""
			// 悬停弹注释窗仅限脚注引用；普通链接（目录/交叉引用）点击才跳转，悬停不动作
			if (!a || !key.startsWith("#nr-") || !this.isNoterefLink(a)) {
				if (lastKey) { window.clearTimeout(hoverTimer); lastKey = "" }
				return
			}
			if (key === lastKey) return
			lastKey = key
			window.clearTimeout(hoverTimer)
			const ref = f.anchors.get(key.slice(1))
			if (!ref) return
			const anchor = this.elementHostAnchor(a) ?? undefined
			hoverTimer = window.setTimeout(() => { void this.showFrameNote(ref, a, anchor) }, 380)
		})
		// 选区（pointerup + selectionchange 双保险，持续镜像给宿主插件）。
		// **方向抑制窗口在监听器里当场推进**，不能等下面 260ms 的 debounce：浏览器
		// 「把选区/手柄滚进可视区」发生在 selectionchange 的**当帧**，晚 260ms 再置
		// 窗口就已经放跑了那串滚动（= 用户报的「点选文本时概率触发底栏闪烁」）。
		d.addEventListener("pointerup", () => {
			const sel = d.defaultView?.getSelection?.() ?? null
			if (sel && !sel.isCollapsed) this.noteSelectionActivity()
			window.setTimeout(() => this.emitSelectionFromFrame(f), 0)
		})
		let selDeb = 0
		d.addEventListener("selectionchange", () => {
			this.noteSelectionActivity()
			window.clearTimeout(selDeb)
			selDeb = window.setTimeout(() => this.emitSelectionFromFrame(f), 260)
		})
		// 沉浸模式点按：连续流逐帧接入（分页流在 foliate load 事件统一接）
		this.wireTapZone(d)
		// 键盘：iframe 获焦时接管翻页与章节键。
		// 模态框（命令面板/快速切换/设置）开着时**整条让路**：此时焦点本不该在书页里
		// （真跑进来了由上面的 focusin 处理器归还），而任何一个「转发给宿主 keymap」的
		// 合成事件都可能在弹窗之外额外执行一次热键命令。
		d.addEventListener("keydown", e => {
			if (hasCoreModal(cont.ownerDocument)) return
			const ev = e
			if (this.handlers?.onFrameKey) { this.handlers.onFrameKey(ev); return }
			// 兜底：无宿主回调时保留原逻辑
			if (this.handleChapterKeys(ev)) return
			if (ev.ctrlKey || ev.metaKey || ev.altKey) return
			const tgt = ev.target as Element | null
			if (tgt?.closest("input, textarea, [contenteditable]")) return
			const key = ev.shiftKey && ev.key === " " ? "PageUp" : ev.key
			if (key === "ArrowDown" || key === "PageDown" || key === " ") { ev.preventDefault(); void this.scrollPage(1) }
			else if (key === "ArrowUp" || key === "PageUp") { ev.preventDefault(); void this.scrollPage(-1) }
			else if (key === "Escape") { this.handlers?.onSelection?.({ text: "", cfi: null, rect: new DOMRect() }) }
		})
		this.replayHighlightsFor(idx)
		this.handlers?.onFrameReady?.(d)
		// 章节 iframe 获得焦点 → 把键盘焦点收回正文容器（保证翻页键一致）。
		// **这是「阅读器抢焦点」的第二个写入点**：模态框开着时不许抢回容器，而且
		// **要把这一份焦点真的交出去** —— 早先只 `return` 等于「不抢回来、但也不放手」，
		// 键盘仍留在书页 iframe 里，命令面板的输入框收不到打字与回车（第一次操作无效）。
		// 交给弹窗里**现测的文本输入**；拿不到目标就**什么都不做**（别 blind blur —— 那会
		// 把焦点扔到 body 收掉软键盘，也比原来更坏）。判据见 core/modalFocusGate。
		f.iframe.addEventListener("focusin", () => {
			if (hasCoreModal(cont.ownerDocument)) {
				focusModalPrimary(cont.ownerDocument)
				return
			}
			try { cont.focus({ preventScroll: true }) } catch { /* ignore */ }
		})
	}

	private emitSelectionFromFrame(f: ContFrame): void {
		const d = f.doc
		const sel = f.iframe.contentWindow?.getSelection()
		if (!d) return
		if (!sel || sel.isCollapsed || !sel.rangeCount) {
			this.handlers?.onSelection?.({ text: "", cfi: null, rect: new DOMRect() })
			return
		}
		const text = sel.toString().replace(/\s+/g, " ").trim()
		if (!text) { this.handlers?.onSelection?.({ text: "", cfi: null, rect: new DOMRect() }); return }
		try {
			const range = sel.getRangeAt(0)
			const rr = range.getBoundingClientRect()
			const fr = f.iframe.getBoundingClientRect()
			const rect = new DOMRect(rr.left + fr.left, rr.top + fr.top, rr.width, rr.height)
			const cfi = this.rangeCFI(d, range)
			this.handlers?.onSelection?.({ text, cfi, rect })
		} catch { /* ignore */ }
	}

	/** 注释目标判定选择器：目标元素落在这些容器内才算"注释正文"（脚注/尾注/评注）。
	 *  frame 文档为 HTML 宽松解析，epub:type 用字面转义形式 */
	private static readonly NOTE_TARGET_SELECTOR = [
		NOTE_ANCESTOR_SELECTOR,
		'[epub\\:type~="footnote"]', '[epub\\:type~="endnote"]', '[epub\\:type~="rearnote"]',
		'[epub\\:type~="note"]', '[epub\\:type~="annotation"]',
		'[role~="doc-footnote"]', '[role~="doc-endnote"]',
		'.epubtype-footnote', '.epub-footnote-item',
		'.duokan-footnote-content', '.duokan-footnote-item', '.fnote',
	].join(",")

	/** 源锚点是否像注释引用：epub:type/role 标注的 noteref，或上标（sup）链接 */
	private isNoterefLink(a: HTMLAnchorElement): boolean {
		try {
			if (a.closest('[epub\\:type~="noteref"], [role~="doc-noteref"]')) return true
			if (a.querySelector("sup") || a.closest("sup")) return true
		} catch { /* ignore */ }
		return false
	}

	/** 悬浮窗内容：目标注释元素 outerHTML（跨章时先确保 frame 就绪）。
	 *  普通内部链接（目录/交叉引用等）不弹注释窗，直接跳转目标位置。 */
	private async showFrameNote(ref: ContAnchorRef, from?: HTMLAnchorElement, at?: { x: number; y: number }): Promise<void> {
		const hash = ref.hash
		if (!hash) { this.jumpToRef(ref); return }
		void this.loadSections([ref.index])
		const go = (attempt: number): void => {
			const tf = this.contFrames.get(ref.index)
			const d = tf?.doc
			if (!d) {
				if (attempt < 25) window.setTimeout(() => go(attempt + 1), 120)
				else this.jumpToRef(ref)
				return
			}
			try {
				const elx = d.getElementById(hash)
				if (!elx) {
					if (attempt < 25) window.setTimeout(() => go(attempt + 1), 120)
					else this.jumpToRef(ref)
					return
				}
				let note: Element | null = null
				try { note = elx.closest(EngineAdapter.NOTE_TARGET_SELECTOR) } catch { /* ignore */ }
				if (!note && (from && this.isNoterefLink(from))) {
					// 源是上标/noteref 但目标容器无类型标记：退化为取目标元素（裸链接取父元素）
					note = elx.tagName === "A" || !elx.textContent?.trim() ? elx.parentElement : elx
				}
				if (!note) { this.jumpToRef(ref); return }
				const html = note.outerHTML
				// jump 闭包：连续模式下裸 hash 无法经 goTo 解析，直接走 jumpToRef（含隐藏注释显形）
				if (html) this.handlers?.onInlineFootnote?.(html, hash, () => this.jumpToRef(ref), at)
				else this.jumpToRef(ref)
			} catch (e) { console.warn("[UNreader] showFrameNote failed", e) }
		}
		window.setTimeout(() => go(0), 30)
	}

	/** ⌘/Ctrl+点击/注释跳转：补载 → 版面稳定 → 精确定位（保留 70px 上文但不越过章节顶） */
	private jumpToRef(ref: ContAnchorRef): void {
		this.jumpToSection(ref.index, (d, _f, ridx) => {
			if (!ref.hash) return this.sectionScrollTop(ridx)
			const elx = d.getElementById(ref.hash)
			if (!elx) return null
			this.revealNoteAround(elx)
			return this.locateScrollTop(ridx, elx.getBoundingClientRect())
		})
	}

	/* ---------------- 连续模式精确跳转核心 ---------------- */

	private jumpSeq = 0
	private jumpPending = false
	/** 跳转过程事件环形缓冲（诊断用，上限 240 条）。记录每次落地/驻留写入的
	 *  「写前 scrollTop / 写入目标 / 目标章绝对顶端」，用于定位「落点后回退」类问题。
	 *  正常情况下只是少量数字入队，开销可忽略。 */
	private jumpTrace: { t: number; ev: string; from: number; to: number; now: number; sh: number; vis: number }[] = []
	/** 占位比例每次写入的历史（诊断用）：pxb 一变，全书未载章占位高度整体重算。 */
	private pxbLog: { t: number; pxb: number; sumH: number; sumSz: number; sh: number }[] = []

	/** 跳转结束（含被取代/中断）：解除挂起并调度一次远章回收——
	 *  pumpLoadToward 批量补载与恢复落点填充都会瞬时抬高活 frame 数，
	 *  落定后必须收敛回 CONT_KEEP_FRAMES 邻域内（半透明窗口闪烁根因） */
	private endJump(): void {
		this.jumpPending = false
		this.schedulePruneSoon()
	}

	/** 章节（wrap）在容器滚动内容坐标系里的绝对顶端 */
	private absContentTop(idx: number, el?: Element): number | null {
		const cont = this.continuousEl
		const wrap = el ?? this.contSectionEls.get(idx)
		if (!cont || !wrap) return null
		try {
			const cr = cont.getBoundingClientRect()
			return cont.scrollTop + (wrap.getBoundingClientRect().top - cr.top)
		} catch { return null }
	}

	private sectionScrollTop(idx: number): number | null {
		return this.absContentTop(idx)
	}

	/** iframe 内元素的绝对滚动位置。
	 *  注意：iframe（同源、禁内滚）内 getBoundingClientRect 返回的是 frame 视口坐标，
	 *  必须加上 frame 自身在容器内容系里的偏移，不能直接与宿主视口坐标相减。 */
	private rectAbsTop(idx: number, r: DOMRect): number | null {
		const cont = this.continuousEl
		const f = this.contFrames.get(idx)
		if (!cont || !f) return null
		try {
			const cr = cont.getBoundingClientRect()
			const fr = f.iframe.getBoundingClientRect()
			return cont.scrollTop + (fr.top - cr.top) + r.top
		} catch { return null }
	}

	/** 定位 scrollTop：目标元素保留 70px 上文，但不越过章节顶部（避免向上露出上一章） */
	private locateScrollTop(idx: number, r: DOMRect): number | null {
		const abs = this.rectAbsTop(idx, r)
		if (abs == null) return null
		const secTop = this.absContentTop(idx)
		return Math.max(secTop ?? 0, abs - 70)
	}

	/** 瞬时滚动：容器 CSS scroll-behavior:smooth 会把 "auto" 也变成动画，须显式 instant */
	private scrollContInstant(top: number, tag = "?"): void {
		const cont = this.continuousEl
		if (!cont) return
		if (tag !== "comp" || Math.abs(top - cont.scrollTop) > 8) this.jt(tag, top)
		this.clearGlide() // 瞬时定位（跳转/补偿）接管滚动，进行中的平滑滑动作废
		this.contProgScrollUntil = performance.now() + 1000
		const want = Math.max(0, top)
		cont.scrollTo({ top: want, behavior: "instant" as ScrollBehavior })
		// **clamp 自检**：`scrollTo` 越界时浏览器**静默截断**（不报错、不抛异常、无事件），
		// 于是「目标 scrollTop 超出当前可滚动高度」会退化成「落在能滚到的底部」——
		// 这正是「点第 143 章、结果停在别处」的终极形态。跳转在途时留一条痕迹，
		// `settleJump` 据此延长驻留等文档长高（占位比例校准后会自己撑开），
		// 回归据此断言主场景从未 clamp。
		if (this.jumpPending && want > cont.scrollHeight - cont.clientHeight + 2) {
			this.jt("clamped", want, cont.scrollTop)
		}
		this.emitContinuousRelocateSoon()
		this.ensureFilledSoon()
	}

	/** 跳转事件记录（诊断用，环形缓冲 240 条） */
	private jt(ev: string, to: number | null, now?: number | null): void {
		const cont = this.continuousEl
		if (this.jumpTrace.length > 240) this.jumpTrace.splice(0, 120)
		this.jumpTrace.push({
			t: Math.round(performance.now()),
			ev,
			from: cont ? Math.round(cont.scrollTop) : -1,
			to: to == null ? -1 : Math.round(to),
			now: now == null ? -1 : Math.round(now),
			sh: cont ? Math.round(cont.scrollHeight) : -1,
			vis: cont ? Math.round(cont.clientHeight) : -1,
		})
	}

	/** 跳转专用补载：**只装目标章（+ 左右各一章做上下文）**，不从已载前沿成批推进。
	 *
	 *  为什么不能推前沿：落点精度**不取决于中间章**——`landExact` 用的是
	 *  `absContentTop(idx)`，它把目标章顶端对齐视口顶端，与目标章之上那些章是否已测量
	 *  无关（未测量的按字节比例给占位高度）。而「从前沿每次推进 5~11 章」在 144 章的书
	 *  上要 13+ 批、每批都是**真渲染**（读 blob + HTML 重解析 + 序列化 + iframe 装载），
	 *  手机上几十秒才轮到目标章；等待窗口超时后退化为占位落点，用户体感就是
	 *  「点第 143 章只挪了几章」。更糟的是这些批次会跟目标章**抢主线程**，反而拖慢
	 *  目标章的就绪（旧代码注释里的「一批 11 章把主线程占满，目标章排不到 CPU」同因）。
	 *  落地后视口就在目标章上，邻域补载交给 `ensureFilled`（以视口为参照）即可。 */
	private pumpLoadToward(idx: number): void {
		const order = this.contOrder
		const targetPos = order.indexOf(idx)
		if (targetPos < 0) return
		const isDone = (i: number): boolean => {
			const w = this.contSectionEls.get(i)
			return !!w && (w.classList.contains("unreader-loaded") || !!this.contFrames.get(i)?.doc || this.contFailed.has(i))
		}
		// 恢复开书期间：只装目标章（理由见 ensureFilled 同名分支）。落定后闸门一关，
		// 邻章立刻回到正常的「目标 ±2 章」批（下面那条 isDone 分支）。
		if (this.restoreFocusIdx != null && this.restoreFocusActive() && !isDone(idx)) {
			void this.loadSections([idx])
			return
		}
		if (isDone(idx)) {
			// 目标章已就绪：只补它周围一段（供 pin 期间邻章换高、以及落地后直接可读）
			const lo = Math.max(0, targetPos - 2)
			const hi = Math.min(order.length, targetPos + 3)
			const around = order.slice(lo, hi).filter(i => !isDone(i))
			if (around.length) void this.loadSections(around)
			return
		}
		const neighbours = order.slice(Math.max(0, targetPos - 1), Math.min(order.length, targetPos + 2))
		void this.loadSections([idx, ...neighbours.filter(i => i !== idx)])
	}

	/** 目标章未参与连续渲染（linear="no"，典型是分部标题页）时，
	 *  映射到阅读顺序中的下一个已排章（即该部的第一个实章节）；
	 *  目标在所有已排章之后则回退到前一个已排章。 */
	private nearestRenderedSection(idx: number): number | null {
		const order = this.contOrder
		if (!order.length) return null
		if (order.includes(idx)) return idx
		let prev: number | null = null
		for (const i of order) {
			if (i > idx) return i
			prev = i
		}
		return prev
	}

	/** 连续模式精确跳转。三段式：
	 *
	 *  ① **近距离抢跑**——目标章未在册、且估算落点在当前位置 8 屏内时，先落到
	 *     `sectionScrollTop`（= 当前布局里目标章的绝对顶端）。它的可信度来自「未载章节的
	 *     占位高度按字节比例给」：布局本身就是「已测章真高 + 未测章字节外推」的合成。
	 *     **不能**再用 12vh 占位和——那会让文档总高远小于真实高度，目标 scrollTop 被
	 *     `scrollHeight` 上限 clamp 掉（实测目标 112,466 只能滚到 53,565），落点必然错位。
	 *     **远跳不抢跑**：线性外推的残差沿未测章区间累积（144 章书实测 3.37% ≈ 39 屏），
	 *     抢跑会把用户丢到空白占位处。远跳改为静默等待 → 一次落地。理由详见抢跑处注释。
	 *  ② 目标 frame 文档就绪 → `locate()` 精确落点覆盖①（远跳即唯一一次落地）。
	 *  ③ 收工交还控制权，由全局 `compensateHeightShift` 接管上方章节测高造成的漂移。
	 *
	 *  **等待窗口**：按「就绪即落 + 有界重试」而不是固定短超时。旧实现在 6s 处硬放弃并落到
	 *  占位和，而负载下目标章常常 6s 后才渲染完（`loadSections` 的占位回收看门狗是 8s，
	 *  比这个窗口还长）——「跳转距离远的时候跳转失败」正是这么来的。
	 *  等待期间用户滚轮/按下即取消。 */
	private jumpToSection(rawIdx: number, locate: (d: Document, f: ContFrame, idx: number) => number | null, onSettled?: () => void): void {
		// 入口留痕：`jumpTrace` 是跳转失败的唯一现场证据（断言里的 `jumpEvents` 为空 =
		// 连入口后的第一个分支都没走到）。下面每个 early-return 都对应一种真实故障形态。
		this.jt("enter", rawIdx)
		const cont = this.continuousEl
		if (!cont || !this.continuousRendered) { this.jt("ret:noCont", rawIdx); return }
		// 线性排除章（如分部标题页）没有渲染占位：落到阅读顺序中的下一个实章节
		const idx = this.nearestRenderedSection(rawIdx)
		if (idx == null) { this.jt("ret:noIdx", rawIdx); return }
		// 身份章记**原始**目标（含 linear="no" 分部页）：这类章没有渲染占位，几何上永远
		// 归不到自己名下，只能靠身份章把目录高亮钉在用户点的那一项上（见 contStickySection）
		this.contStickySection = rawIdx
		const seq = ++this.jumpSeq
		this.jumpPending = true
		this.currentIndex = idx
		this.pushContHistory()

		const cancel = (): void => {
			if (seq === this.jumpSeq) { this.jumpSeq++; this.endJump() }
			cont.removeEventListener("wheel", cancel)
			cont.removeEventListener("pointerdown", cancel)
		}
		cont.addEventListener("wheel", cancel, { once: true, passive: true })
		cont.addEventListener("pointerdown", cancel, { once: true, passive: true })

		/** 目标章「已就绪」= 文档接好线且量到高度（量到高度前 locate 没有可信坐标） */
		const targetReady = (): boolean => {
			const f0 = this.contFrames.get(idx)
			return !!f0?.doc && f0.lastHeight > 0
		}
		let landedExact = false
		let landedOffset: number | null = null
		const landPre = (): void => {
			if (landedExact) return
			const top = this.sectionScrollTop(idx)
			if (top == null) { this.jt("landPre:null", null); return }
			this.jt("landPre", top)
			this.scrollContInstant(top, "landPre")
		}
		const landExact = (top: number | null): void => {
			if (top == null) { landPre(); return }
			this.jt("landExact", top)
			this.scrollContInstant(top, "landExact")
			// **同一任务内收敛**：写入后布局可能仍在变（上方邻章正把占位换成真实高度），
			// 只写一次会在下一帧才被发现偏差 → 可见的二次跳动。这里紧接着复查目标章
			// 绝对顶端，偏离就立即补正 —— 同一个任务内没有中间绘制，用户看不到这一步。
			let off: number | null = null
			for (let i = 0; i < 3; i++) {
				const sec = this.absContentTop(idx)
				const cur = this.continuousEl
				if (sec == null || !cur) break
				const curOff = cur.scrollTop - sec
				if (off == null) { off = curOff; continue } // 首轮只记录本次落点偏移
				if (Math.abs(curOff - off) <= 2) break // 偏移未变 = 已收敛
				this.jt("landFix", sec + off)
				this.scrollContInstant(sec + off, "landFix")
			}
			landedExact = true
			const sec = this.absContentTop(idx)
			const cur = this.continuousEl
			// **被 clamp 时 `scrollTop - sec` 是无意义的**：那个大负差值是「文档还不够高、
			// 滚不过去」造成的，不是「用户想看的章内偏移」。若原样记进 `landedOffset`，
			// `settleJump` 里 `absContentTop + landedOffset` 恰好等于被截断的当前 scrollTop
			// → clamp 检测恒为假 → 驻留不再重试 → 用户在错的位置收工。
			// 此时退回「章顶贴视口顶」的口径（offset = 0），由 `settleJump` 的 clamp 驻留
			// 持续重试，等占位比例校准把文档撑开后自动补正。
			const clampedNow = !!cur && sec != null && top > cur.scrollHeight - cur.clientHeight + 2
			landedOffset = clampedNow ? 0 : (sec == null || !cur ? null : cur.scrollTop - sec)
		}

		// ① 抢跑：**仅近距离**。两个条件同时满足才抢跑：
		//    · 目标章未就绪（本就命中缓存/邻域补载的不抢跑，否则白多一次写入）
		//    · 估算落点距当前位置 ≤ 8 屏
		//
		//  为什么必须加距离门槛：占位高度是「字节数 × 全书统一 px/字节」的线性外推，
		//  单章密度（对话密集章比叙述章矮得多）偏离全书均值的**残差会沿未测章区间累积**。
		//  实测 144 章的书：139 个未测章把目标顶端高估 3.37% = 29k px ≈ **39 屏**。
		//  此时抢跑会把用户直接丢到距目标 39 屏的空白占位处，停 1s 再跳回 —— 这次
		//  「立刻响应」是**负价值**，就是用户说的「滑动定位」体感。
		//  8 屏内累积残差 < 1/4 屏，抢跑落点就在目标章眼皮底下，才是真的「先给位置、
		//  再补精确」。更远的跳转改为**静默等待就绪 → 一次精确落地**：用户看到的是
		//  静止 → 瞬移，中间没有闪烁，这才是用户要的「直接定位」。
		if (!targetReady()) {
			const preTop = this.sectionScrollTop(idx)
			const maxScreens = this.prerunScreens()
			const near = preTop != null && Math.abs(preTop - cont.scrollTop) <= cont.clientHeight * maxScreens
			if (near) {
				window.setTimeout(() => {
					if (seq !== this.jumpSeq || landedExact || targetReady()) return
					landPre()
					this.pumpLoadToward(idx)
				}, IS_MOBILE_LIKE_THRESHOLD ? 160 : 90)
			}
		}

		// ②③ 等就绪 → 精确落点 → 收工
		let rounds = 0
		const maxRounds = IS_MOBILE_LIKE_THRESHOLD ? 75 : 70 // 移动端 ~12s，桌面 ~8.4s
		const step = (): void => {
			if (seq !== this.jumpSeq || !this.continuousEl) { this.jt("cancel:seq", null); cancel(); return }
			// 真失败（连续挂起两次进黑名单）：落到当前最佳位置并收工，保底有响应
			if (this.contFailed.has(idx)) {
				this.jt("failBlacklist", null)
				landPre()
				onSettled?.()
				cancel()
				return
			}
			if (targetReady()) {
				// 就绪后**不立即落**：目标章文档一接上，上方邻章（idx-1 / idx-2）才开始把
				// 占位换成真实高度，这段换高会把目标章绝对顶端再推移数千 px（144 章
				// 实测 +4.7k）。落早了必然补一次 → 可见的二次跳动。等目标顶端连续两次
				// （约 160ms）不变再落，把「抢跑 → 精确」压成**两次可见定位**；
				// 1.2s 上限兜底，避免邻章迟迟不测高时干等。
				let anchor = this.absContentTop(idx)
				let stable = 0
				let waited = 0
				const converge = (): void => {
					if (seq !== this.jumpSeq || !this.continuousEl) { cancel(); return }
					if (this.contFailed.has(idx)) { landPre(); onSettled?.(); cancel(); return }
					const now = this.absContentTop(idx)
					if (now != null && anchor != null && Math.abs(now - anchor) > 1) {
						anchor = now
						stable = 0
					} else {
						stable++
					}
					waited += 80
					if (stable >= 2 || waited >= 1200) {
						let top: number | null = null
						const f = this.contFrames.get(idx)
						try { if (f?.doc) top = locate(f.doc, f, idx) } catch { /* ignore */ }
						landExact(top ?? this.sectionScrollTop(idx))
						this.settleJump(idx, seq, landedOffset, onSettled)
						return
					}
					window.setTimeout(converge, 80)
				}
				converge()
				return
			}
			if (rounds++ < maxRounds) {
				this.pumpLoadToward(idx)
				window.setTimeout(step, IS_MOBILE_LIKE_THRESHOLD ? 160 : 120)
				return
			}
			// 上限内仍未就绪：按**当前**布局重落一次收工（路径章已陆续测高，比①时更准）
			landPre()
			onSettled?.()
			cancel()
		}
		step()
	}

	/** 精确落点后的**贴顶驻留**：把目标章钉在视口同一位置，直到上方邻章由「字节占位」
	 *  换成实测高度（这正是落点后残余漂移的唯一来源）为止。
	 *
	 *  为什么需要它（实测数据）：一本 144 章、总高约 100 万 px 的书，抢跑落点已经**精确命中**
	 *  目标章的占位顶端（误差 0），但目标章文档就绪后上方邻章的占位→实测换高会把目标章
	 *  绝对顶端推移 +9.5k px（143 个未测章的随机误差累加，占总量 0.97% —— 这是估算的
	 *  方差下限，任何全局 px/字节 常数都消不掉）。旧实现落地即 `finishJump` 交还控制权，
	 *  由 `compensateHeightShift`（以**视口顶所在章**为锚）接盘，锚点与目标章不是同一章 →
	 *  补偿滞后，表现为落点后又跳两下（990,256 → 990,674 → 994,837）。
	 *
	 *  驻留期间 `jumpPending` 保持 true，`compensateHeightShift` 让路（不打架），本循环把
	 *  **目标章的视口偏移量**钉死：绝对顶端每变一次就整体平移同样的量，目标章在屏幕上的
	 *  位置纹丝不动 —— 上方内容换高只发生在其上方，视觉上只是「内容在标题下方铺开」。
	 *  连 4 次（约 500ms）无变化即认为上方已稳定，收工交还全局补偿（此时目标章正贴在视口
	 *  顶，`compensateHeightShift` 的「整章在视口上方」分支刚好是对的锚）。 */
	private settleJump(idx: number, seq: number, landedOffset: number | null, onSettled?: () => void): void {
		// 比例/页码落点（goToFraction）自带 correctPageLanding 对齐，别抢它的活；
		// 同时它的落点是「视口中心对齐」，本驻留的「贴顶」口径会把它拉偏
		if (onSettled) { this.finishJump(idx, seq, landedOffset, onSettled); return }
		let anchor = this.absContentTop(idx)
		let stable = 0
		let rounds = 0
		/** 因**文档高度不足**而滚不到目标位置的连续轮次（`scrollTo` 被静默截断） */
		let clamped = 0
		const maxRounds = 14 // ~2s 上限：上方仍在补载也不会无限驻留
		// clamp 时放宽上限：此刻要等的是「占位比例校准把文档撑开」，那是异步的，
		// 且校准本身就要等目标章以外的章节量到高度。放宽到 ~8s 且只在确实截断时启用，
		// 正常工况（不截断）仍受 2s 限制，不会拖长「跳完后驻留」。
		const maxClampRounds = IS_MOBILE_LIKE_THRESHOLD ? 70 : 50
		const tick = (): void => {
			if (seq !== this.jumpSeq) return
			const cont = this.continuousEl
			if (!cont) return
			const now = this.absContentTop(idx)
			this.jt("pin", null, now)
			// **clamp 优先于漂移判定**：文档还没长到能容纳目标位置时，每次写入都被静默
			// 截断到「当前能滚到的底部」，此时「目标章视口偏移量没变」是**假象**（被截断的
			// 位置当然稳定），照漂移逻辑会连着 stable++ 然后在 2s 后按错的位置收工——
			// 用户看到的就是「点目录跳不过去」。所以先把「滚不到」当成待办：保持驻留、
			// 每轮重试，等 `--ur-pxb` 校准把未载章占位撑开、文档够高了，写入自然生效。
			if (now != null && now + (landedOffset ?? 0) > cont.scrollHeight - cont.clientHeight + 2) {
				if (++clamped <= maxClampRounds) {
					this.jt("pinClamped", now + (landedOffset ?? 0), now)
					this.scrollContInstant(now + (landedOffset ?? 0), "pinTry")
					window.setTimeout(tick, IS_MOBILE_LIKE_THRESHOLD ? 120 : 100)
					return
				}
			}
			if (now != null && anchor != null && Math.abs(now - anchor) > 3) {
				// 只平移「绝对顶端的漂移量」：目标章的视口位置因此保持不变
				this.scrollContInstant(cont.scrollTop + (now - anchor), "pinDrift")
				anchor = now
				stable = 0
			} else {
				stable++
			}
			if (stable >= 4 || ++rounds >= maxRounds) {
				// 收工前把当前的绝对顶端换算成「目标章贴顶」的最终落点，保证交接给
				// compensateHeightShift 时锚点与目标章一致（避免交接瞬间再跳一下）
				if (now != null) this.scrollContInstant(now + (landedOffset ?? 0), "pinFinal")
				this.finishJump(idx, seq, landedOffset, onSettled)
				return
			}
			window.setTimeout(tick, IS_MOBILE_LIKE_THRESHOLD ? 140 : 120)
		}
		window.setTimeout(tick, IS_MOBILE_LIKE_THRESHOLD ? 140 : 120)
	}

	/** 抢跑距离门槛（单位：屏）。默认 8 屏。
	 *  调试开关 `localStorage["unreader-prerun-screens"]`：`"0"` = 永不抢跑（远跳路径），
	 *  `"9999"` = 永远抢跑（复现「先闪到空白占位再跳回」的旧体感）—— 供回归做阴性对照。 */
	private prerunScreens(): number {
		try {
			const v = window.localStorage.getItem("unreader-prerun-screens")
			if (v != null) {
				const n = Number(v)
				if (Number.isFinite(n) && n >= 0) return n
			}
		} catch { /* ignore */ }
		return 8
	}

	/** 跳转收工：清 `jumpPending` 把滚动控制权交还全局 —— `compensateHeightShift` 随即恢复对
	 *  「上方章节测高」的补偿（目标章贴视口顶不动），比旧实现自建 16×600ms 校正循环少几十次
	 *  滚动写入；长距离跳转的「滑动/卡顿」体感正是那一串补偿写出来的。
	 *  只留**一次**迟到校验，兜住「交还控制权之前已经发生」的大幅漂移（单次、有阈值）。 */
	private finishJump(idx: number, seq: number, landedOffset: number | null, onSettled?: () => void): void {
		onSettled?.()
		this.endJump()
		// 比例/页码落点（goToFraction）自带 correctPageLanding 对齐，别抢它的活；
		// 同时它的落点是「视口中心对齐」，本校正的「贴顶」口径会把它拉偏
		if (onSettled) return
		window.setTimeout(() => {
			// 用户在这 600ms 内滚动过 → cancel 已推进 jumpSeq，本次校验作废（不抢控制权）
			if (seq !== this.jumpSeq) return
			const cont = this.continuousEl
			if (!cont) return
			const now = this.absContentTop(idx)
			if (now == null) return
			const want = landedOffset == null ? now : now + landedOffset
			// 一屏以内不动：正常的图片晚到/字体回排由 compensateHeightShift 增量维持
			if (Math.abs(want - cont.scrollTop) > cont.clientHeight) this.scrollContInstant(Math.max(0, want))
		}, 600)
	}

	/** 全书各线性章节的字节数与总量（与 relocate 页码估算同源） */
	private bookByteSizes(): { sizes: number[]; total: number } | null {
		const sections = (this.el?.book as unknown as { sections?: { size?: number; linear?: string }[] })?.sections ?? []
		let total = 0
		const sizes: number[] = []
		for (const s of sections) {
			const sz = s && s.linear !== "no" && typeof s.size === "number" && s.size > 0 ? s.size : 0
			sizes.push(sz)
			total += sz
		}
		return total > 0 ? { sizes, total } : null
	}

	/** 按全书字节位置定位 {章节, 章内字节占比}（占位章节高度失真，不能用滚动比例直接换算） */
	private sectionByBytePos(pos: number): { idx: number; secFrac: number } | null {
		const sizes = this.bookByteSizes()
		if (!sizes) return null
		const p = Math.min(sizes.total - 0.5, Math.max(0, pos))
		let acc = 0
		for (let i = 0; i < sizes.sizes.length; i++) {
			const sz = sizes.sizes[i]!
			if (sz > 0 && p < acc + sz) return { idx: i, secFrac: (p - acc) / sz }
			acc += sz
		}
		for (let i = sizes.sizes.length - 1; i >= 0; i--) {
			if (sizes.sizes[i]! > 0 && this.contSectionEls.has(i)) return { idx: i, secFrac: 1 }
		}
		return null
	}

	/** 当前视口中心的字节位置估算（口径与 emitContinuousRelocate 页码一致） */
	private currentBytePos(): { idx: number; sizePos: number } | null {
		const cont = this.continuousEl
		const sizes = this.bookByteSizes()
		if (!cont || !sizes) return null
		const viewCenter = cont.scrollTop + cont.clientHeight / 2
		let cur = 0
		this.contSectionEls.forEach((elx, idx) => {
			if (elx.offsetTop <= viewCenter) cur = idx
		})
		let sizeBefore = 0
		let sizeOfCur = 0
		for (let i = 0; i < sizes.sizes.length; i++) {
			const sz = sizes.sizes[i]!
			if (i < cur) sizeBefore += sz
			else if (i === cur) sizeOfCur = sz
		}
		const wrap = this.contSectionEls.get(cur)
		const local = wrap ? Math.max(0, Math.min(1, (viewCenter - wrap.offsetTop) / Math.max(1, wrap.offsetHeight))) : 0
		return { idx: cur, sizePos: sizeBefore + local * sizeOfCur }
	}

	/** 页码跳转落点校正：章节内渲染高度占比 ≠ 字节占比（图片/标题等），按当前章节 px/字节 比例微调 */
	private correctPageLanding(targetPos: number, attempt: number): void {
		const cont = this.continuousEl
		if (!cont || attempt >= 3) return
		const cur = this.currentBytePos()
		if (!cur) return
		const delta = targetPos - cur.sizePos
		if (Math.abs(delta) <= 750) return // 半页以内：显示页码已与输入一致
		const wrap = this.contSectionEls.get(cur.idx)
		const sizeOfCur = this.bookByteSizes()?.sizes[cur.idx] ?? 0
		if (!wrap || wrap.offsetHeight <= 0 || sizeOfCur <= 0) return
		const deltaPx = delta * (wrap.offsetHeight / sizeOfCur)
		const clamped = Math.max(-cont.clientHeight * 2, Math.min(cont.clientHeight * 2, deltaPx))
		this.scrollContInstant(cont.scrollTop + clamped)
		window.setTimeout(() => this.correctPageLanding(targetPos, attempt + 1), 280)
	}


	/** 章节快捷键：[ / ] 与 Alt+←/→ */
	private handleChapterKeys(e: KeyboardEvent): boolean {
		if ((e.altKey || e.ctrlKey || e.metaKey) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			e.preventDefault()
			if (e.key === "ArrowRight") void this.nextSection()
			else void this.prevSection()
			return true
		}
		if (!e.ctrlKey && !e.metaKey && !e.altKey) {
			if (e.key === "[" ) { e.preventDefault(); void this.prevSection(); return true }
			if (e.key === "]" ) { e.preventDefault(); void this.nextSection(); return true }
		}
		return false
	}

	private scheduleFrameSize(f: ContFrame): void {
		if (f.sizePending) return
		f.sizePending = true
		window.requestAnimationFrame(() => {
			f.sizePending = false
			try {
				const d = f.iframe.contentDocument
				if (!d) return
				const h = this.measureFrameContentHeight(d)
				if (h > 0 && Math.abs(h - f.lastHeight) > 1) {
					this.writeFrameHeight(f.idx, f, h)
				}
			} catch { /* ignore */ }
		})
	}

	private handleFrameClick(f: ContFrame, e: MouseEvent): void {
		const a = this.linkFromEvent(e)
		if (!a) return
		this.handleAnchorTap(f, a, e)
	}

	/** 链接（注标 / 交叉引用）点击的**唯一落地**。`a` 由调用方给出而不是现取
	 *  `e.target`：命中的元素不一定是事件目标（高亮覆盖矩形挡在链接上时要按坐标
	 *  穿透命中，见 `linkFromEvent`），但落地语义必须与「矩形不存在时点到链接」
	 *  逐字一致 —— 这正是本次修复的判据。 */
	private handleAnchorTap(f: ContFrame, a: HTMLAnchorElement, e: MouseEvent): void {
		const href = a.getAttribute("href") ?? ""
		if (!href.startsWith("#")) {
			// **外链一律交系统默认浏览器，绝不让章节 iframe 自己导航。**
			// 历史实现这里直接 `return`（连 preventDefault 都没有），于是正文里的
			// http(s) 链接走浏览器默认行为，把 `about:srcdoc` 帧**当场导航走** ——
			// 正文被网页顶掉，而且没有任何返回入口（iframe 内事件不冒泡到宿主，
			// 工具栏/返回键都救不回来）。用户报的「外链按钮不稳定 / 还是在 Obsidian 中
			// 打开」就是这条（真机 CDP 取证 2026-09-20：点 http 外链后帧 URL 直接变成
			// 目标网址）。书 / Feed / 网页 / TXT 四种源在连续渲染下共用这一条链路，
			// 所以修在这里才是一次收口 —— foliate 自己的 `#handleLinks` 只覆盖它自己
			// 渲染的帧（见 `external-link` 监听那段）。
			// 非白名单协议（相对地址、`javascript:`、`obsidian://` 等）维持旧行为不拦，
			// 交给浏览器/宿主自己判定。
			const url = externalUrlOf(href, a)
			if (!url) return
			e.preventDefault()
			openExternalLink(url)
			return
		}
		e.preventDefault()
		if (!href.startsWith("#nr-")) return
		const ref = f.anchors.get(href.slice(1))
		if (!ref) return
		// 长按直跳后的跟进 click：已跳转过，直接消费不再弹悬浮窗
		try { if (f.longPressConsumed?.() === href) return } catch { /* ignore */ }
		if (e.metaKey || e.ctrlKey) {
			this.jumpToRef(ref)
		} else {
			void this.showFrameNote(ref, a, this.elementHostAnchor(a) ?? undefined)
		}
	}

	/** 事件命中的链接，**含穿透高亮覆盖矩形**。
	 *
	 *  高亮矩形是 `pointer-events:auto` 的装饰层，压在正文之上 → 落在被高亮文字里的
	 *  注标 / 交叉引用一律被它吃掉：click 在矩形自己的监听里就 `stopPropagation` 了
	 *  （连 `handleFrameClick` 都收不到），悬停与长按读到的 target 也全是矩形。
	 *  用户报的「划了高亮之后点不动注标」即此 —— 覆盖矩形是**装饰**，不该改变它下面
	 *  那个元素的语义。 */
	private linkFromEvent(e: { target: EventTarget | null; clientX: number; clientY: number }): HTMLAnchorElement | null {
		const t = e.target as Element | null
		if (!t || typeof t.closest !== "function") return null
		const direct = t.closest("a[href]")
		if (direct) return direct as HTMLAnchorElement
		const rect = t.closest(".unreader-hl-rect")
		if (!rect) return null
		return this.linkUnderCover(rect, e.clientX, e.clientY)
	}

	/** 覆盖矩形**下面**那个元素里的链接（只认 `#` 内部链接）。
	 *
	 *  `elementsFromPoint` 按绘制顺序给整摞元素，跳过我们自己的矩形后**取第一个
	 *  非矩形元素**：它就是「没有矩形时会被点到的那一个」。它若不是链接就到此为止，
	 *  不再往下找 —— 继续穿透会点到别的层上（与浏览器命中测试的语义相悖）。 */
	private linkUnderCover(rect: Element, x: number, y: number): HTMLAnchorElement | null {
		if (this.hlNoLinkThrough()) return null
		const d = rect.ownerDocument
		if (!d) return null
		// 坐标必须真落在矩形盒内（1px 容差）：探针用 `dispatchEvent` 合成的 click
		// 常带 0/8 这类与矩形无关的坐标，不设这道门就会在文档别处误命中一个链接。
		try {
			const b = rect.getBoundingClientRect()
			if (x < b.left - 1 || x > b.right + 1 || y < b.top - 1 || y > b.bottom + 1) return null
		} catch { return null }
		// 只借这两个命中测试入口，所以按**结构类型**取用而不是 `Document &` —— 后者会把
		// `Document.caretRangeFromPoint` 那个 `@deprecated` 声明一起继承进来。
		// （`caretRangeFromPoint` 是给没有 `elementsFromPoint` 的老 WebKit 留的退路。）
		const doc = d as unknown as {
			elementsFromPoint?: (x: number, y: number) => Element[]
			caretRangeFromPoint?: (x: number, y: number) => Range | null
		}
		let stack: Element[] = []
		try { stack = doc.elementsFromPoint?.(x, y) ?? [] } catch { stack = [] }
		if (!stack.length) {
			// 老 WebKit 没有 elementsFromPoint：按坐标取文本位置，再往上找链接
			try {
				const r = doc.caretRangeFromPoint?.(x, y)
				const n: Node | null = r?.startContainer ?? null
				const el = n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null
				if (el) stack = [el]
			} catch { /* ignore */ }
		}
		for (const el of stack) {
			if (el.classList?.contains("unreader-hl-rect")) continue
			const a = el.closest?.("a[href]")
			if (!a) return null
			// 只认 `#` 内部链接：非 `#` 的外部链接在**没有**矩形时也让 frame 自己导航
			// （`handleAnchorTap` 对它们不 preventDefault），不该因为压了高亮而被唤醒。
			return (a.getAttribute("href") ?? "").startsWith("#") ? a as HTMLAnchorElement : null
		}
		return null
	}

	/** 覆盖矩形**穿透命中链接**的阴性对照开关（`localStorage["unreader-hl-nolink"]="1"`）：
	 *  退回「矩形吃掉其下一切点击」的旧行为（被高亮盖住的注标点不动）。
	 *  回归 `node test/run-probe.mjs taphighlight` 用它验证「链接优先」那条断言有辨别力。
	 *  **每次现读**（同 `unreader-keep-frames` / `unreader-hl-nomerge` 约定）。 */
	private hlNoLinkThrough(): boolean {
		try { return window.localStorage.getItem("unreader-hl-nolink") === "1" } catch { return false }
	}


	private refreshHighlightsFor(idx: number): void {
		const list = this.contHLByIndex.get(idx) ?? []
		for (const cfi of list) {
			const data = this.contHL.get(cfi)
			if (data) { for (const r of data.els) r.remove(); this.contHL.delete(cfi) }
			const color = this.highlights.get(cfi) ?? "yellow"
			void this.renderHighlightIn(idx, cfi, color)
		}
	}

	/** 章节进入可滚动范围后，用其真实 base 精确解析 toc 归属 */
	/** 章节进入可滚动范围后，用其真实 base 精确解析 toc 归属 */
	private async linkResolve(idx: number, base: string | number): Promise<void> {
		const wrap = this.contSectionEls.get(idx)
		if (!wrap || base == null || wrap.dataset.tocLinked === "1") return
		// MOBI/AZW3：本节靠「href 路径字符串 ↔ section.id 字符串」比对归属，而 MOBI 的
		// toc href 是 `kindle:pos:fid:...`/`filepos:...`、section.id 是纯数字 → 永远不匹配
		// → candidates 为空 → 反过来把 buildTocSectionMap 已建好的**正确映射删掉**。
		// 且本函数按 section 进视口异步触发，删得早晚不定 → tocIdBySection 规模随滚动抖动
		//（实测同一本书两次运行 12 vs 10）。MOBI 的归属已由 splitTOCHref/getIndexByFID
		// 精确给出，这里必须跳过。
		//
		// 判据放宽到「非 EPUB」：TXT 合成书的 toc href **恰好**是 section 下标的字符串，
		// 今天能靠字符串比对命中，但那依赖一条未言明的契约（href 形式一旦改成
		// `chapter_00012` 之类，比对立刻全灭并误删正确映射）。TXT 的归属已由
		// buildTocSectionMap 经同步 resolveHref 精确建好，与 MOBI 同理 → 一并跳过。
		if (this.bookFormat !== "epub") return
		wrap.dataset.tocLinked = "1"
		const book = this.el?.book as unknown as { toc?: TocItem[]; sections?: { id?: string | number }[] } | null
		if (!book?.toc) return
		const flat: TocItem[] = []
		const collect = (items: TocItem[]): void => { for (const it of items) { flat.push(it); if (it.subitems?.length) collect(it.subitems) } }
		collect(book.toc)
		const target = String(((book as { sections?: { id?: string | number }[] }).sections?.[idx] as unknown as { id?: string | number })?.id ?? "")
		const norm = (x: string): string => x.replace(/^\.\//, "").replace(/^\//, "")
		const candidates = flat.filter(it => it.href && typeof it.id === "number").map(it => {
			const href = norm((it.href ?? "").split("#")[0] ?? "")
			const tg = norm(target)
			if (!href || !tg) return { it, ok: false, pos: -1 }
			return { it, ok: href === tg || tg.endsWith("/" + href) || href.endsWith("/" + tg), pos: href === tg ? 0 : (tg.endsWith("/" + href) ? tg.indexOf(href) : href.indexOf(tg)) }
		}).filter(x => x.ok).sort((x, y) => x.pos - y.pos || (x.it.id ?? 0) - (y.it.id ?? 0))
		const best = candidates[0]
		if (best?.it?.id != null) this.tocIdBySection.set(idx, best.it.id)
		else this.tocIdBySection.delete(idx)
		this.sortedTocSections = [...this.tocIdBySection.keys()].sort((a, b2) => a - b2)
	}

	/** 把章节内 link/img/svg 等资源解析为主线程 blob:，绕开 iframe CSP 与 blob 样式表拦截 */
	private async rewriteResourcesLocal(doc: Document, secBase: string): Promise<void> {
		const book = this.el?.book as unknown as { loadText?: (p: string) => Promise<string>; loadBlob?: (p: string) => Promise<Blob> } | null
		if (!book?.loadText || !book.loadBlob) return
		const blobFor = async (resolved: string): Promise<string | null> => {
			const hit = this.contBlobCache.get(resolved)
			if (hit) return hit
			try {
				const blob = await book.loadBlob!(resolved)
				if (!blob || blob.size === 0) return null
				const url = URL.createObjectURL(blob)
				this.contBlobCache.set(resolved, url)
				this.contBlobs.push(url)
				this.pruneBlobCache()
				return url
			} catch { return null }
		}
		const skip = (raw: string | null): boolean => !raw || /^(?:#|https?:|data:|blob:|mailto:)/i.test(raw)
		// img/source/audio/video src + poster —— 并行解析（原串行 await 逐个媒体
		// 读 zip+建 blob，多图章节拖慢开书数秒）
		await Promise.all(Array.from(doc.querySelectorAll("img[src], source[src], audio[src], video[src]")).map(async el => {
			try {
				const raw = el.getAttribute("src")
				if (skip(raw)) return
				const url = await blobFor(this.resolveRel(raw!, secBase))
				if (url) {
					el.setAttribute("src", url)
					// 首屏外图片不阻塞布局与 load 事件；进入视口才解码
					if (el.tagName === "IMG") {
						el.setAttribute("loading", "lazy")
						el.setAttribute("decoding", "async")
					}
				}
			} catch (e) { console.warn("[UNreader] media rewrite failed", e) }
		}))
		await Promise.all(Array.from(doc.querySelectorAll("[poster]")).map(async el => {
			try {
				const raw = el.getAttribute("poster")
				if (skip(raw) || raw === el.getAttribute("href")) return
				const url = await blobFor(this.resolveRel(raw!, secBase))
				if (url) el.setAttribute("poster", url)
			} catch { /* ignore */ }
		}))
		// svg image href / xlink:href（XML 文档上含冒号属性必须走 setAttributeNS，逐元素隔离防整章中止）
		await Promise.all(Array.from(doc.querySelectorAll("image")).map(async el => {
			try {
				const raw = el.getAttribute("href") ?? el.getAttribute("xlink:href")
				if (skip(raw)) return
				const url = await blobFor(this.resolveRel(raw!, secBase))
				if (!url) return
				try { el.setAttribute("href", url) } catch { /* SVG2 属性失败也无妨 */ }
				try { el.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", url) } catch { /* ignore */ }
				try { (el as Element).setAttribute("src", url) } catch { /* ignore */ }
			} catch (e) { console.warn("[UNreader] svg image rewrite failed", e) }
		}))
		// object[data]
		for (const el of Array.from(doc.querySelectorAll("object[data]"))) {
			const raw = el.getAttribute("data")
			if (skip(raw)) continue
			const url = await blobFor(this.resolveRel(raw!, secBase))
			if (url) el.setAttribute("data", url)
		}
		// 样式表：loadText → 内部 url() 转 blob → 内联 <style>
		// 并行解析（串行逐条 await 时，多 CSS 章节每条一次 zip 读 + 正则全文替换，
		// 线性叠加拖慢每章渲染）；replaceWith 相互独立，可安全并发
		await Promise.all(Array.from(doc.querySelectorAll("link[href]")).map(async el => {
			const rel = (el.getAttribute("rel") ?? "").toLowerCase()
			const type = el.getAttribute("type") ?? ""
			const href = el.getAttribute("href") ?? ""
			const isCss = rel.includes("stylesheet") || type === "text/css" || href.endsWith(".css")
			if (!isCss || skip(href)) return
			const resolved = this.resolveRel(href, secBase)
			try {
				const loadText = book.loadText
				if (!loadText) return
				const cssText = await loadText(resolved)
				if (!cssText) return
				const rewritten = await this.rewriteCssToBlobs(cssText, resolved, blobFor)
				// 把 EPUB 内的 <link rel=stylesheet> 换成内联 <style>（blob 化后的 CSS）：
				// 目标 document 是章节 frame，同样无法用宿主 styles.css 覆盖。
				// 同 `injectFrameCss`：游离节点 + `replaceWith` 收养，比 `doc.createElement` 干净。
				const style = createEl("style")
				style.setAttribute("data-css-from", resolved)
				style.textContent = rewritten
				el.replaceWith(style)
			} catch { /* 保留原 link */ }
		}))
	}


	/** CSS 文本内所有 url()/@import 解析为 blob: 绝对地址 */
	private async rewriteCssToBlobs(css: string, cssPath: string, blobFor: (p: string) => Promise<string | null>): Promise<string> {
		const dir = cssPath.includes("/") ? cssPath.slice(0, cssPath.lastIndexOf("/")) : ""
		const abs = (u: string): string => {
			let p = decodeURIComponent(u.trim())
			if (/^(?:https?:|data:|blob:|#)/i.test(p)) return ""
			p = p.replace(/^\.\//, "")
			const stack = dir ? dir.split("/") : []
			for (const seg of p.split("/")) {
				if (seg === "..") stack.pop()
				else if (seg && seg !== ".") stack.push(seg)
			}
			return stack.join("/")
		}
		const jobs: Promise<void>[] = []
		const map = new Map<string, string>()
		const queue = (u: string): string => {
			const key = abs(u)
			if (!key) return u
			jobs.push((async () => {
				const url = await blobFor(key)
				if (url) map.set(key, url)
			})())
			return u
		}
		let out = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m0, u: string) => { queue(u); return m0 })
		out = out.replace(/@import\s+["']([^"']+)["']/gi, (m0, u: string) => { queue(u); return m0 })
		await Promise.all(jobs)
		for (const [key, url] of map) {
			out = out.split(`url("${decodeURIComponent(key)}")`).join(`url("${url}")`)
			out = out.split(`url(${decodeURIComponent(key)})`).join(`url("${url}")`)
			out = out.split(`url("${key}")`).join(`url("${url}")`)
			out = out.split(`"${key}"`).join(`"${url}"`)
		}
		return out
	}

	/** 与 foliate 内部 resolveURL 同款算法：相对路径 → zip 内完整路径（保留 OEBPS/ 前缀） */
	private resolveRel(href: string, base: string): string {
		if (!base) return decodeURI(href.replace(/^\.\//, ""))
		try {
			if (base.includes(":")) return decodeURI(new URL(href, base).href)
			const root = "https://invalid.invalid/"
			const obj = new URL(href, root + base)
			obj.search = ""
			return decodeURI(obj.href.replace(root, ""))
		} catch {
			return decodeURI(href.replace(/^\.\//, ""))
		}
	}


	private loadContinuousTheme(appearance: AppearanceSettings): void {
		// 「引擎从现在起用这套外观」——自定义字体的按需过滤只认这个信号。
		// 必须落在本函数：它是两条外观落地路径的唯一汇合处（applyAppearance 之外，
		// load() 直接调用它，不经过 applyAppearance）。写在此处同时保证
		// registerCustomFontsIn 拿到的集合与紧随其后构建的 contFrameCss 一致。
		setActiveFontIds(appearance.fontFamily && isResourceEnabled(appearance.fontFamily) ? new Set([appearance.fontFamily]) : new Set<string>())
		// 切回连续模式时移除分页模式挂在 stage 上的宿主背景图层，避免双层绘制
		if (this.hostEl) this.removeHostBgLayers(this.hostEl)
		const accent = (() => {
			try { return getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim() || "#4c6ef5" } catch { return "#4c6ef5" }
		})()
		// **边距计算提前**（需 app 解析），在 contFrameCss 赋值前执行
		let app: ResolvedAppearance
		try {
			app = resolveAppearance(appearance)
		} catch {
			return
		}
		// 左右边距：连续容器（.unreader-continuous）的左右 padding 决定正文边距。
		// 为与分页模式保持一致，直接使用 CSS 变量传递给容器（JS 覆盖 CSS 默认值）。
		// **关键修正**：移动和桌面端都直接用设定值，不减去任何百分比
		try {
			const cont = this.continuousEl
			if (cont) {
				if (this.webLayout) {
					// 网页原样：**取消版心封顶与左右内边距**。网页的宽度语义是「铺满视口」，
					// 要不要留白、留多少，由页面自己的 `max-width`/`margin:auto` 决定 ——
					// 阅读器的边距设置在这里是纯粹的外来干预（见 core/htmlBook.ts 文件头口径③）。
					// 三个变量由 CSS 类给（见styles.css 的 `.unreader-continuous.unreader-web`）：
					// 行内值会跨书残留，而「网页模式」是个模式开关，本来就该由类表达。
					// 这里必须先**清掉上一本书留下的行内值** —— 行内优先级高于类规则，
					// 不清就会出现「先看 EPUB 再看 HTML，网页仍带着版心」的串味。
					cont.style.removeProperty('--ur-pad-left')
					cont.style.removeProperty('--ur-pad-right')
					cont.style.removeProperty('--ur-read-max')
					cont.classList.add('unreader-web')
				} else {
					const mobile = isPhoneLike()
					// 统一使用：移动端直接设置值（最小 8px），桌面限制 25%
					const leftPad = mobile ? `max(8px, ${app.marginLeft}px)` : `min(${app.marginLeft}px, 25%)`
					const rightPad = mobile ? `max(8px, ${app.marginRight}px)` : `min(${app.marginRight}px, 25%)`
					cont.style.setProperty('--ur-pad-left', leftPad)
					cont.style.setProperty('--ur-pad-right', rightPad)
					// 网页模式现在由 `.unreader-web` 类表达（见 styles.css），行内值只剩这两条。
					// 仍显式清一次 `--ur-read-max`：它的默认值在 styles.css 的 `.unreader-root` 上，
					// 万一将来有别的写入者在这里留下行内值，「先看 HTML 再看 EPUB」的那本书
					// 就会永远没有版心（见 webLayout 的 getter 注释）。
					cont.style.removeProperty('--ur-read-max')
					cont.classList.remove('unreader-web')
				}
				// 注：进度条（.unreader-progress）已改为全宽（left/right: 0），不再需要
				// 这里把边距变量镜像到 .unreader-body。若日后要恢复「只铺正文列宽」，
				// 需在写这两行的同时镜像到 hostEl.closest('.unreader-body')
				// （它是本容器的兄弟节点，读不到这里的行内变量）。
				// ⚠️ 这里**不再打调试日志**（2026-09-14 移除）：本函数在每次
				// `ensureContinuous` 命中「已渲染」快路径时都会跑一遍，日志实测
				// 单次开书刷 50+ 条，且 devtools 打开时 `console.log` 自身会触发
				// 强制重排（日志里成片的 `[Violation] Forced reflow ... 33~43ms`
				// 就是它与下面的 getComputedStyle 叠加出来的）。要复看计算结果请
				// 临时加回，不要长期保留。
			}
		} catch { /* ignore */ }
		// **段落间距必须用「解析后的值」，不能用原始字段**（2026-09-13 修）：
		// 原始字段的 `null` 语义是「跟随主题的 `--p-spacing`」（见 types.ts 的注释），
		// 而面板显示的就是解析值（≈1em）。老写法把 null 当成 0em 落地 —— 于是
		// 「点段间距那一行的『恢复默认』」之后**段落挤成一坨、面板却仍显示 1.00em**，
		// 显示与落点差一个 1em；用户再往任一方向推 0.05 就触发 emit，间距从 0 猛跳到 1.05em。
		// 帧内解析不到宿主的 `--p-spacing`，所以必须在宿主侧解析好再把**数字**烧进帧 CSS。
		const paraMargin = `${resolveAppearance(appearance).paragraphSpacing}em`
		// 无论明暗：html 承载阅读背景色，body 强制透明——EPUB 自带页面底色
		// （body/容器上的米黄、羊皮纸等）在浅色下会直接透出造成“棕色背景”。
		// body 自身 + 主要块级容器都强制透明，让 html 底色成为唯一可见背景。
		// 有背景图时：各帧完全透明（不参与任何背景绘制，正文布局与无图完全一致），
		// 图片层与玻璃层都挂在宿主固定视口图层上（见 applyContinuousBgLayer）
		const img = (app.backgroundImage || "").trim()
		const baseBg = img
			? `html{ background-color:transparent!important; }\nbody{ background-color:transparent!important; background-image:none!important; }`
			: `html{ background-color:${app.backgroundColor}!important; }\nbody{ background-color:transparent!important; background-image:none!important; }`
		const darkBase = isDarkReading(app, app.backgroundColor)
			? `${darkTextOverrideCss(app.textColor, accent, img ? "normal" : "dark")}`
			: ""
		try {
			if (this.continuousEl) this.continuousEl.style.backgroundColor = img ? "transparent" : app.backgroundColor
		} catch { /* ignore */ }
		this.applyContinuousBgLayer(app)
		this.contImgActive = !!img
		this.contFrameCss = `
${app.customFontRules ?? ""}
html,body,p,div,span,li,td,th,dd,dt,blockquote,figcaption{
	font-family:${app.fontFamily}!important;
	line-height:${app.lineHeight}!important;
	${app.letterSpacing ? `letter-spacing:${app.letterSpacing}em!important;` : ""}
}
body{
	color:${app.textColor}!important;
	font-size:${app.fontSize}px!important;
	text-align:justify;
	text-rendering:optimizeLegibility;
	-webkit-font-smoothing:antialiased;
}
/* 首行缩进 N 字：必须落在各块级元素上（em 随该元素自身字号解析），
   放 body 上靠继承会拿到解析好的绝对值，段落字号大时缩进不足 N 字；
   并补偿字间距（N×(1+ls)），否则缩进比第二行前 N 字窄 N×ls */
body, body p, body div, body li, body dd, body dt, body blockquote, body section, body article, body td, body th {
	text-indent:${(app.paragraphIndent * (1 + app.letterSpacing)).toFixed(4)}em!important;
}
${baseBg}
h1,h2,h3,h4,h5,h6{ text-indent:0 !important; }
a{ color:${accent}!important; }
img{ max-width:100%;height:auto; }
svg{ max-width:100%; }
svg[viewBox]{ height:auto; }
p{ margin-block-start:${paraMargin}!important; margin-block-end:0!important; }
${darkBase}
`.trim()
		// 网页原样通道（本地 HTML）：上面那套书本化主题整段不适用 —— 它用
		// `!important` 强制字体/字号/行距/首行缩进/正文配色，正是「网页打开什么样
		// 就什么样」的反面。换成一组 `:where()` 零特异性兜底，作者 CSS 一律赢。
		// `webColorScheme` 同批更新：它决定无配色页面里 `canvas`/`canvastext`
		// 解析成什么（= 跟随阅读器明暗，与浏览器的 color-scheme 行为一致）。
		if (this.webLayout) {
			this.webColorScheme = isDarkReading(app, app.backgroundColor) ? "dark" : "light"
			this.contFrameCss = this.buildWebFrameCss(app, accent)
		} else {
			this.webColorScheme = ""
		}
		// 刷新所有已就绪 frame 的主题并重测高度
		this.contFrames.forEach(f => {
			const s = f.doc?.getElementById("unreader-theme")
			if (s) s.textContent = this.contFrameCss
			// 画布填充开关随图片状态同步（新 frame 在 renderSection 已按当前值设置）
			// 网页原样：color-scheme 由阅读器明暗决定（见 webColorScheme 注释）；
			// 书本模式沿用「有背景图时允许透明画布」的老口径
			if (f.iframe) f.iframe.style.colorScheme = this.webColorScheme || (this.contImgActive ? COLOR_SCHEME_NORMAL : "")
			if (f.doc) this.registerCustomFontsIn(f)
			this.scheduleFrameSize(f)
		})
		// 主题/排版变化后，叠加高亮矩形必须重新定位：
		// 矩形是「渲染那一刻」的绝对坐标，字号/行距/边距一变文字就重排，
		// 不重绘的话标注仍停在旧位置、与文字脱节（文字样式与标注不同步）。
		// 等一帧让 reflow 落定再重绘，避免按旧布局取坐标。
		window.requestAnimationFrame(() => {
			this.contFrames.forEach((_, idx) => this.refreshHighlightsFor(idx))
		})
	}

	/** 连续模式背景图层（宿主层，固定视口）：
	 *  - 图片层 .unreader-cont-bg：z-index:-1 外壳（无滤镜），内层 absolute 承载
	 *    背景图与模糊——注意 filter 列表里不能混入 scale()（Chromium 会忽略整个
	 *    filter），模糊用 filter:blur、放大用 transform:scale 分开写；
	 *  - 玻璃层 .unreader-cont-tint：同为 z-index:-1、DOM 序在图片层之后
	 *    （画在图片之上、正文之下），半透明底色 + backdrop blur——放在宿主层
	 *    才能取到图片做模糊（iframe 内 backdrop-filter 取不到宿主图层，
	 *    且只覆盖 body 盒子，会呈现“只在文字处生效”的碎块感）。
	 *  连续容器自身是 isolate 堆叠上下文，负 z-index 子层不会沉到宿主底色之下。
	 *  不改动容器的定位/布局（有图无图时正文左右间距完全一致）。 */
	private applyContinuousBgLayer(appearance: ResolvedAppearance): void {
		const host = this.continuousEl
		if (!host) return
		// 清理旧版本可能遗留的容器 inline 定位覆盖（避免影响滚动容器布局）
		try {
			if (host.style.position === "relative") host.style.removeProperty("position")
			if (host.style.zIndex === "1") host.style.removeProperty("z-index")
		} catch { /* ignore */ }
		this.paintHostBgLayers(host, appearance)
	}

	private removeHostBgLayers(host: HTMLElement): void {
		try {
			host.querySelector<HTMLElement>(":scope > .unreader-cont-bg")?.remove()
			host.querySelector<HTMLElement>(":scope > .unreader-cont-tint")?.remove()
		} catch { /* ignore */ }
	}

	private paintHostBgLayers(host: HTMLElement, appearance: ResolvedAppearance): void {
		// 图片取「解析后生效值」（activeBackgroundImage：深浅分开时取对应侧字段），
		// 与 frame 主题（contFrameCss 同样按解析值决定透明/纯色）保持同一判据——
		// 若这里用原始 backgroundImage 共用字段，深浅分开且当前侧无图时会出现
		// 「frame 纯色不透明（正文黑）+ 宿主层仍在画共用旧图（只在两侧空白露出）」
		const image = (appearance.backgroundImage || "").trim()
		let bg = host.querySelector<HTMLElement>(":scope > .unreader-cont-bg")
		let tint = host.querySelector<HTMLElement>(":scope > .unreader-cont-tint")
		if (!image) {
			this.removeHostBgLayers(host)
			return
		}
		if (!bg) {
			bg = createDiv()
			bg.className = "unreader-cont-bg"
			host.insertBefore(bg, host.firstChild)
		}
		// 外壳只负责定位/层级；内层承载背景图与滤镜
		bg.style.cssText = LAYER_SHELL_CSS
		let bgInner = bg.firstElementChild as HTMLElement | null
		if (!bgInner) {
			bgInner = createDiv()
			bg.appendChild(bgInner)
		}
		bgInner.style.cssText = [
			"position:absolute",
			"inset:0",
			`background-image:url("${image.replace(/"/g, "%22")}")`,
			"background-size:cover",
			"background-position:center",
			"background-repeat:no-repeat",
			appearance.imageBlur > 0 ? `filter:blur(${appearance.imageBlur}px)` : "",
			appearance.imageBlur > 0 ? "transform:scale(1.06)" : "",
		].filter(Boolean).join(";")
		if (appearance.glassEnabled) {
			if (!tint) {
				tint = createDiv()
				tint.className = "unreader-cont-tint"
				// DOM 序在图片层之后：同为 z-index:-1 时后序者画在上
				bg.after(tint)
			}
			tint.style.cssText = LAYER_SHELL_CSS
			let tintInner = tint.firstElementChild as HTMLElement | null
			if (!tintInner) {
				tintInner = createDiv()
				tint.appendChild(tintInner)
			}
			tintInner.style.cssText = [
				"position:absolute",
				"inset:0",
				`background-color:${hexToRgba(activeBackground(appearance), appearance.glassOpacity)}`,
				`-webkit-backdrop-filter:blur(${appearance.glassBlur}px)`,
				`backdrop-filter:blur(${appearance.glassBlur}px)`,
			].join(";")
		} else {
			tint?.remove()
		}
	}

	private resolveHrefToIndex(href: string): number | null {
		const book = this.el?.book as unknown as { resolveHref?: (h: string) => unknown; sections?: { id?: string | number }[] } | null
		if (!book) return null
		try {
			const r = book.resolveHref?.(href)
			if (typeof r === "number") return r
			if (r && typeof (r as { index?: unknown }).index === "number") return (r as { index: number }).index
		} catch { /* ignore */ }
		const target = href.split("#")[0] ?? ""
		if (!target) return null
		const norm = (x: string): string => x.replace(/^\.\//, "")
		const secs = book.sections ?? []
		for (let i = 0; i < secs.length; i++) {
			// MOBI 章节 id 是 number，path 匹配用不到（只对 EPUB href 字符串有效），
			// 转字符串兜底防止 .replace on number 崩
			const id = norm(String(secs[i]?.id ?? ""))
			if (id && (id === norm(target) || id.endsWith("/" + norm(target)) || norm(target).endsWith("/" + id))) return i
		}
		return null
	}

	/**
	 * 位置 token → 章节 index（EPUB=CFI / MOBI=filepos 统一处理）：
	 *   - MOBI 的 `filepos:NNN` 直接走 `book.resolveHref`，foliate-js mobi.js:872
	 *     会把 filepos 映射到包含该位置的 section
	 *   - EPUB 的 CFI `/6/N[...]` 走 cfiStepIndices 反推（spine itemref 步数法）
	 *
	 * 这是「位置 token → 章节 index」的唯一对外入口；所有 caller（进度恢复、目录跳转、
	 * 高亮点击、书签跳转）都应走这里。旧的 sectionIndexFromCfi 同名保留作为 CFI 专用兜底。
	 */
	private sectionIndexFromPos(pos: string): number | null {
		if (!pos) return null
		// MOBI/AZW3 的 filepos 路径
		if (pos.startsWith("filepos:")) {
			try {
				const book = this.el?.book as unknown as { resolveHref?: (h: string) => { index?: number } | null } | null
				const r = book?.resolveHref?.(pos)
				if (r && typeof r.index === "number") return r.index
			} catch { /* fall through to CFI path */ }
		}
		// MOBI 章节下标合成 token：foliate-js MOBI 不暴露 CFI/filepos，
		// 章节粒度的进度以 `mobi:N` 字符串保存（N = 章节下标）
		if (pos.startsWith("mobi:")) {
			const n = Number(pos.slice(5))
			if (Number.isInteger(n) && n >= 0) return n
			return null
		}
		// EPUB CFI 路径（filepos 也可降级到此，但通常不命中）
		return this.sectionIndexFromCfi(pos)
	}

	private sectionIndexFromCfi(cfi: string): number | null {
		try {
			const steps = this.cfiStepIndices(cfi)
			const itemStep = steps?.[1] ?? steps?.[0]
			if (itemStep == null) return null
			// spine itemref 步数与 sections 数组一一对应（linear=no 项同样占用步数）：
			// section i 的 cfi 步数为 2i+2（/6/2、/6/4、/6/6…）。不能按「跳过 linear=no
			// 的线性章计数」反推——那会在第一个 linear=no 章节之后整体错位一章，
			// 导致高亮渲染/点击定位/书签跳转全部落到错误的章节
			const book = this.el?.book as unknown as { sections?: unknown[] } | null
			const count = book?.sections?.length ?? 0
			const idx = itemStep / 2 - 1
			if (Number.isInteger(idx) && idx >= 0 && idx < count) return idx
		} catch { /* ignore */ }
		return null
	}

	/** Range → 本地 CFI 路径（子节点 1-based 序列 + 文本偏移），与 rangeFromCfiParts 成对。
	 *  返回起点/终点两条路径：旧版只编码起点导致高亮点击无法还原范围 */
	private toEpubcfiPair(range: Range, holder: Element): { start: string; end: string } {
		const pathOf = (node: Node | null, offset: number): string => {
			try {
				const parts: number[] = []
				let n: Node | null = node
				while (n && n !== holder) {
					const parent: Node | null = n.parentNode
					if (!parent) break
					parts.unshift(Array.prototype.indexOf.call(parent.childNodes, n) + 1)
					n = parent
				}
				const off = node && node.nodeType === 3 ? offset + 1 : 1
				return parts.map(x => `/${x}`).join("") + `:${off}`
			} catch {
				return "/1:0"
			}
		}
		return {
			start: pathOf(range.startContainer, range.startOffset),
			end: pathOf(range.endContainer, range.endOffset),
		}
	}

	/** 章节定位（恢复位置 / 目录跳转 / 章节切换共用）。
	 *  `onLanded` 只在**恢复开书**路径传入：落定（或放弃收敛）时回调一次，
	 *  供视图层把「揭示正文」与落点对齐。其它调用方不传 → 行为零变化。 */
	private scrollToIndex(rawIdx: number, block: "start" | "end" = "start", fraction?: number, instant = false, onLanded?: () => void): void {
		// 非恢复路径的定位（目录跳转/章节切换/翻页）表明用户已经在自己控制位置：
		// 放弃「等视口就绪后补落恢复位置」的待办，避免之后一次 resize 把他拽回去
		if (!onLanded) this.restorePending = null
		this.pushContHistory()
		const cont = this.continuousEl
		// 线性排除章（分部标题页）无渲染占位：落到阅读顺序中的下一个实章节，否则恢复位置会静默丢失
		const idx = this.nearestRenderedSection(rawIdx)
		if (idx == null) { onLanded?.(); return }
		const wrap = this.contSectionEls.get(idx)
		if (!cont || !wrap) { onLanded?.(); return }
		// 恢复位置：从已载边界向目标成批补载路径章，让视口→目标之间的高度尽早建立，
		// 否则目标上方全是 12vh 占位，absContentTop 算出的落点错误 → 打开时一片空白
		// （单纯 loadSections([idx]) 只载目标章，中间章占位不立高度，滚动后内容才“冒出来”）
		this.pumpLoadToward(idx)
		this.ensureFilledSoon()
		// 恢复/跳转期间标记 jumpPending：maybeUnloadFarFrames 会据此保护「视口→目标」路径章，
		// 避免 pump 出来的中间章刚立起高度就被回收（补载-回收空转 → iPad 大段空白）
		this.jumpPending = true
		// 每个出口都算「落定/放弃」：闸门（whenRestored）与 jumpPending 必须同生共死
		const endJumpSoon = (): void => {
			this.jumpPending = false
			onLanded?.()
		}
		if (fraction != null && fraction > 0.02) {
			// apply 循环带序号守卫：期间发生任何新跳转（jumpToSection 会推进 jumpSeq）即作废，
			// 避免迟到的恢复定位把已完成的跳转又拖回去
			const seqAtStart = this.jumpSeq
			let prevTop = -1
			let stableCount = 0
			const landNow = (top: number, w: HTMLElement): void => {
				this.scrollContInstant(top + w.offsetHeight * Math.min(0.98, fraction) - cont.clientHeight / 2)
				this.restorePending = null
				perfEnd("restore")
				endJumpSoon()
			}
			/** **恢复开书走「就绪即落」**：下面的「连续两次不变」是给**目录远跳**定的判据——
			 *  那条路径落定瞬间用户正看着屏幕，落早了会看到二次跳动。恢复开书不同：
			 *  ① 落定前正文是隐藏的（`is-restoring`），揭示点由 `whenRestored()` 定，晚落 = 让用户
			 *     多等「正在打开…」（实测 Moby Dick：目标章 +975ms 就绪，却等到 +1517ms 才落）；
			 *  ② 落定后目标章的绝对顶端还会被占位比例校准推移，但那是 `restoreViewportAnchor` /
			 *     `compensateHeightShift` 的份内事（= 同一条内容回同一屏幕位置），不需要靠「等它不动」
			 *     来回避。开关 `localStorage["unreader-restore-fast"]="0"` 退回旧判据（阴性对照）。 */
			const landOnReady = !!onLanded && this.restoreFastLand()
			const apply = (attempt: number): void => {
				if (this.jumpSeq !== seqAtStart) { endJumpSoon(); return }
				const w = this.contSectionEls.get(idx)
				if (!w) { endJumpSoon(); return }
				const fr = this.contFrames.get(idx)
				// 「就绪」的判据分两档（与 jumpToSection 的 targetReady 同口径）：
				//   · 恢复开书（landOnReady）：**必须真接线并量到高度**。不能用 `unreader-loaded`
				//     类走捷径 —— 那个类在 frame 刚 append、srcdoc 还没解析完时就有了，此时
				//     `w.offsetHeight` 是占位高度（frac 落点会算偏，实测偏差一屏量级），
				//     且揭示会早于正文上屏（实测 mobifast 档：闸门 704ms 放行、正文 1210ms 才到）。
				//   · 目录远跳：沿用宽松判据（落点由后续 settleJump 驻留精修）
				const targetReady = landOnReady
					? (!!fr?.doc && fr.lastHeight > 0 && cont.clientHeight > 0)
					: (w.offsetHeight > 0 && (!!fr?.doc || w.classList.contains("unreader-loaded")))
				const top = targetReady ? this.absContentTop(idx, w) : null
				if (top != null && landOnReady) { landNow(top, w); return }
				// 等「落点稳定」：目标上方中间章还在补载时 offsetTop 会随高度建立而漂移，
				// 立刻落地会落在占位区（iPad 打开后大片空白）。连续两次 top 几乎不变
				// 才认定路径高度已就绪，再落地。
				if (top != null) {
					if (prevTop >= 0 && Math.abs(top - prevTop) < 4) {
						stableCount++
						if (stableCount >= 2) { landNow(top, w); return }
					} else {
						stableCount = 0
					}
					prevTop = top
				}
				// 每轮持续向目标补载：恢复位置落在远章时，路径中间章必须分批立起高度，
				// 否则目标上方长期是 12vh 占位、落点偏移 → iPad 上“打开后大段空白”。
				// 逐轮 pump（旧版隔轮 + 每批 7 章）会串行拖长整条收敛链
				this.pumpLoadToward(idx)
				// 目标迟迟就绪或高度持续漂移：放宽到 80 轮兜底落地。
				// 就绪即落时轮询加密到 60ms（每次只读一次 offsetTop，恢复窗口内可忽略），
				// 让「就绪 → 落地」的延迟从最坏 120ms 降到 60ms。
				const tickMs = landOnReady ? 60 : 120
				if (attempt < 80) window.setTimeout(() => apply(attempt + 1), tickMs)
				else {
					if (top != null) landNow(top, w)
					perfEnd("restore")
					endJumpSoon()
				}
			}
			window.setTimeout(() => apply(0), landOnReady ? 30 : 60)
		} else {
			// 章节跳转用瞬时定位：smooth 动画（scrollIntoView）会被滚动途中触发的
			// 高度补偿瞬时滚动打断——动画刚起步就被拉回原位，表现为「点了没反应」；
			// 章节切换本就是瞬移语义，落点基于当前布局计算，后续漂移由补偿稳住
			const target = this.sectionScrollTop(idx)
			// 容器没有真实视口（布局还没就绪）时不落：rects 全 0，落点是垃圾值。
			// 恢复路径留给 `restorePending`，由 `notifyVisible` 拿到尺寸后补落
			if (target != null && cont.clientHeight > 0) {
				const top = block === "end"
					? Math.max(0, target + (wrap.offsetHeight || 0) - cont.clientHeight + 2)
					: target
				this.scrollContInstant(top)
				if (onLanded) this.restorePending = null
			}
			// 非比例跳转（章节切换/章节顶部）无需长时间保护路径章，立即结束
			perfEnd("restore")
			endJumpSoon()
		}
		this.currentIndex = idx
	}


	/** 注标元素在宿主视口中的锚点（自动补偿所在 iframe 的偏移） */
	private elementHostAnchor(elx: HTMLElement | null | undefined): { x: number; y: number } | null {
		try {
			if (!elx?.getBoundingClientRect) return null
			const r = elx.getBoundingClientRect()
			const frameEl = (elx.ownerDocument?.defaultView as (Window & { frameElement?: HTMLIFrameElement | null }) | null)?.frameElement
			const off = frameEl ? frameEl.getBoundingClientRect() : { left: 0, top: 0 }
			return { x: r.left + off.left + r.width / 2, y: r.bottom + off.top }
		} catch { return null }
	}

	/** 视口中心所在章节及其章内比例；无渲染章节时返回 null */
	private viewportSection(): { idx: number; identity: number; local: number; localTop: number } | null {
		const cont = this.continuousEl
		if (!cont || !this.continuousRendered) return null
		const viewCenter = cont.scrollTop + cont.clientHeight / 2
		let cur = -1
		// 视口**顶边**归属章：只服务于身份章判定（跳转落点是否还成立）；
		// 章节归属与进度口径不变（仍按视口中心 / 归属窗口）
		let curTop = -1
		const viewTop = cont.scrollTop
		this.contSectionEls.forEach((elx, idx) => {
			if (elx.offsetTop <= viewCenter) cur = idx
			if (elx.offsetTop <= viewTop) curTop = idx
		})
		if (cur < 0) return null
		const wrap = this.contSectionEls.get(cur)
		const h = Math.max(1, wrap?.offsetHeight ?? 1)
		// 章节归属用视口中心（进入章节即归属该章），进度用「视口顶边」：
		// 以视口中心为锚时，章节首行出现在屏幕中线就已算 50%，短章会“一进来就过半”。
		// 视口顶边 = 当前正读到的行，顶边贴章首 → 0%，顶边贴章尾 → 100%。
		// 进度另按「归属窗口」归一（否则切章时只走到 (h - c/2)/h，章高≈2 屏正好 3/4
		// 就归零），公式与取舍见 sectionProgressFraction 的注释。
		const local = wrap ? Math.max(0, Math.min(1, (viewCenter - wrap.offsetTop) / h)) : 0
		const localTop = wrap
			? sectionProgressFraction(cont.scrollTop, wrap.offsetTop, h, cont.clientHeight)
			: 0
		return { idx: cur, identity: this.stickyIdentity(cur, curTop), local, localTop }
	}

	/** 目录高亮 / 章节名归属章（见 contStickySection）：
	 *  - 已渲染的目标：仍在视口顶边或中心名下时认账，用户滚走即自动失效（纯几何，无需事件）；
	 *  - 未渲染的目标（linear="no" 分部标题页）：本次落到的实章未离开时认账，
	 *    离开靠用户的显式输入（滚轮/触摸/按下/按键）释放。 */
	private stickyIdentity(cur: number, curTop: number): number {
		const s = this.contStickySection
		if (s == null) return cur
		if (this.contSectionEls.has(s)) return s === cur || s === curTop ? s : cur
		return this.nearestRenderedSection(s) === cur ? s : cur
	}

	/** 当前视口对应的合成 CFI（与 relocate 同口径）；算不出返回 null */
	private currentContCfi(): string | null {
		const v = this.viewportSection()
		if (!v) return null
		const base = this.contBaseCfi.get(v.idx) ?? ""
		if (!base) return null
		const pct = Math.max(1, Math.min(1000, Math.round(v.local * 1000) + 1))
		return `epubcfi(${base}!,/1:${pct})`
	}

	private emitContinuousRelocateSoon(): void {
		if (this.contRaf) return
		this.contRaf = window.requestAnimationFrame(() => {
			this.contRaf = 0
			this.emitContinuousRelocate()
		})
	}

	private emitContinuousRelocate(): void {
		const cont = this.continuousEl
		if (!cont || !this.handlers) return
		const v = this.viewportSection()
		const cur = v?.idx ?? 0
		this.currentIndex = cur
		// 目录高亮 / 章节名的归属章 = 身份章（跳转落点优先），几何量仍按视口实际所在章 cur
		const ident = v?.identity ?? cur
		// 进度条用「视口顶边」锚点（见 viewportSection）：顶边贴章首 = 0%，贴章尾 = 100%；
		// CFI/位置持久化仍用视口中心锚点（与恢复位置时 scrollContInstant 的落点口径一致）
		const local = v?.local ?? 0
		const localTop = v?.localTop ?? 0
		const base = this.contBaseCfi.get(cur) ?? ""
		let cfi = ""
		if (base) {
			// EPUB：CFI 持续 token，含章节定位 + 章节内百分比（pct = round(local*1000)+1）
			const pct = Math.max(1, Math.min(1000, Math.round(local * 1000) + 1))
			cfi = `epubcfi(${base}!,/1:${pct})`
		} else if (this.bookFormat !== "epub") {
			// MOBI/AZW3：foliate-js MOBI 不暴露 CFI（sec.cfi 为 undefined），用章节下标合成
			// `mobi:N` token，加载走 jumpToSection(N)；章节粒度恢复对阅读体感已够用。
			// TXT 正常走不到这里 —— 它有 fake CFI 基准（见 renderContinuous），base 一定非空，
			// 因此 TXT 的进度是含章内百分比的合成 CFI，恢复精度优于章节粒度。
			cfi = `mobi:${cur}`
		}
		if (cfi) this.contLastCfi = cfi
		// 高亮键链：精确目录映射 → 派生条目（书源目录缺失的子章节） → 最近前驱目录条目
		const tocId = this.tocIdBySection.get(ident) ?? this.sectionNavKeys.get(ident) ?? this.nearestTocIdForSection(ident)
		// 真实整书页码：按全书各章节字节数估算（与翻页模式 location 同源），
		// 不再用"已加载章节数"充当总页数
		const sizePerLoc = 1500
		const sections = (this.el?.book as unknown as { sections?: { size?: number; linear?: string }[] })?.sections ?? []
		let sizeTotal = 0
		let sizeBefore = 0
		let sizeOfCur = 0
		for (let i = 0; i < sections.length; i++) {
			const sx = sections[i]
			const sz = sx && sx.linear !== "no" && typeof sx.size === "number" && sx.size > 0 ? sx.size : 0
			sizeTotal += sz
			if (i < cur) sizeBefore += sz
			else if (i === cur) sizeOfCur = sz
		}
		const sizePos = sizeBefore + local * sizeOfCur
		let locTotal: number | null
		if (sizeTotal > 0) locTotal = Math.max(1, Math.ceil(sizeTotal / sizePerLoc))
		else locTotal = this.contSectionEls.size || null
		const locCurrent = locTotal != null
			? Math.min(locTotal, Math.floor(sizePos / sizePerLoc) + 1)
			: cur + 1
		const realFraction = sizeTotal > 0 ? Math.min(1, Math.max(0, sizePos / sizeTotal)) : 0
		this.handlers.onRelocate({
			cfi,
			fraction: realFraction,
			sectionFraction: localTop,
			tocId,
			// 派生条目（合成负数键）用派生标题，目录条目用目录原文
			sectionLabel: tocId != null ? (this.sectionNavTitles.get(ident) ?? this.getTocEntryLabel(tocId) ?? "") : "",
			locCurrent,
			locTotal,
		})
	}

	private getTocEntryLabel(tocId: number): string | null {
		const flat: TocItem[] = []
		const collect = (items: TocItem[], out: TocItem[]): void => { for (const it of items) { out.push(it); if (it.subitems?.length) collect(it.subitems, out) } }
		collect(this.getToc(), flat)
		return flat.find(it => it.id === tocId)?.label ?? null
	}

	/** 每个目录条目（tocId）所在章节的起始页码（全书字节估算，与页码显示同口径；连续模式专用） */
	getTocStartPages(): Map<number, number> {
		const map = new Map<number, number>()
		const sizes = this.bookByteSizes()
		if (!sizes) return map
		const sizePerLoc = 1500
		let acc = 0
		for (let i = 0; i < sizes.sizes.length; i++) {
			const tocId = this.tocIdBySection.get(i)
			if (tocId != null && !map.has(tocId)) map.set(tocId, Math.floor(acc / sizePerLoc) + 1)
			acc += sizes.sizes[i]!
		}
		return map
	}

	/**
	 * 位置 token（EPUB 合成 CFI / `mobi:N` / `filepos:`）→ 全书页码。
	 *
	 * 口径与右下角页码指示器**完全同源**（emitContinuousRelocate 的 loc：
	 * 按全书章节字节数估算，sizePerLoc = 1500），这是硬约束——书签行上写的
	 * 页码必须与点进去后指示器显示的数字一致，否则用户会认为跳错了位置。
	 *
	 * 页码**故意不落盘**：每次渲染/刷新时现算。凡是会改变页码模型的因素
	 * （换设备、切换预设/排版、书籍重解析）都会在下一次刷新时自动反映，
	 * 不会在笔记文件里留下过期快照。
	 */
	getPageForAnchor(anchor: string): { page: number; total: number } | null {
		const sizes = this.bookByteSizes()
		if (!sizes) return null
		const idx = this.sectionIndexFromPos(anchor)
		if (idx == null || idx < 0 || idx >= sizes.sizes.length) return null
		const sizePerLoc = 1500
		let sizeBefore = 0
		for (let i = 0; i < idx; i++) sizeBefore += sizes.sizes[i]!
		const local = this.localFractionFromPos(anchor)
		const sizePos = sizeBefore + local * sizes.sizes[idx]!
		const total = Math.max(1, Math.ceil(sizes.total / sizePerLoc))
		const page = Math.max(1, Math.min(total, Math.floor(sizePos / sizePerLoc) + 1))
		return { page, total }
	}

	/** 位置 token 的章内占比（0..1）。合成 CFI 的 `,/1:NNN` 端写入的是
	 *  pct = round(local*1000)+1（见 currentContCfi / emitContinuousRelocate），
	 *  这里反解；MOBI 的 `mobi:N` 与 filepos 无章内精度 → 章首（0）。 */
	private localFractionFromPos(pos: string): number {
		const m = /,\/1:(\d+)/.exec(pos)
		if (!m) return 0
		const pct = Number(m[1])
		if (!Number.isFinite(pct)) return 0
		return Math.max(0, Math.min(1, (pct - 1) / 1000))
	}

	/* ---------------- 正文搜索 ---------------- */

	private lastSearchQuery = ""

	/** 全书正文搜索：逐章解析原书文档（与渲染无关，连续/分页模式均可用），
	 *  产出进度与匹配（章节序号 + 章内序号 + 摘录）；token.aborted 用于中断 */
	async *searchBook(query: string, token: { aborted: boolean }): AsyncGenerator<
		| { type: "progress"; progress: number }
		| { type: "match"; index: number; matchIndex: number; cfi: string; label: string; pre: string; match: string; post: string }
		| { type: "done"; total: number; capped: boolean }
	> {
		const el = this.el
		const q = query.trim()
		const sections = (el as unknown as { book?: { sections?: ({ createDocument?: () => Promise<Document>; linear?: string } | undefined)[] } })?.book?.sections
		if (!el || !q || !sections) return
		this.lastSearchQuery = q
		const lang = this.getMetadata().language || "zh"
		const matcher = searchMatcher(textWalker, { defaultLocale: lang })
		const MAX_MATCHES = 500
		let total = 0
		for (let i = 0; i < sections.length; i++) {
			const sec = sections[i]
			if (!sec?.createDocument || sec.linear === "no") continue
			if (token.aborted) return
			let doc: Document
			try { doc = await sec.createDocument() } catch { continue }
			const tocId = this.tocIdBySection.get(i) ?? null
			const label = tocId != null ? this.getTocEntryLabel(tocId) ?? "" : ""
			let matchIndex = 0
			for (const { range, excerpt } of matcher(doc, q)) {
				let cfi = ""
				try { cfi = el.getCFI(i, range) } catch { /* ignore */ }
				total++
				yield { type: "match", index: i, matchIndex: matchIndex++, cfi, label, pre: excerpt.pre, match: excerpt.match, post: excerpt.post }
				if (total >= MAX_MATCHES) {
					yield { type: "done", total, capped: true }
					return
				}
				if (token.aborted) return
			}
			yield { type: "progress", progress: (i + 1) / sections.length }
		}
		yield { type: "done", total, capped: false }
	}

	/** 跳转到某章的第 matchIndex 处匹配：在渲染完成的 iframe 文档里重跑匹配取同一
	 *  序号（两次解析文本一致），用矩形精确滚动；分页模式退化为按 CFI 跳转 */
	async jumpToSearchMatch(idx: number, matchIndex: number, cfi: string): Promise<void> {
		this.pushContHistory()
		// 取代进行中的章节跳转，避免漂移校正循环把视图拽回旧目标
		this.jumpSeq++
		this.endJump()
		if (!this.isContinuous || !this.continuousEl) {
			if (cfi) await this.el?.goTo(cfi)
			this.focusContent()
			return
		}
		await this.loadSections([idx])
		for (let n = 0; n < 80; n++) {
			if (this.contFrames.get(idx)?.doc) break
			this.pumpLoadToward(idx)
			await new Promise(r => window.setTimeout(r, 120))
		}
		const f = this.contFrames.get(idx)
		if (!f?.doc) { this.scrollToIndex(idx); return }
		let range: Range | null = null
		try {
			const lang = this.getMetadata().language || "zh"
			const matcher = searchMatcher(textWalker, { defaultLocale: lang })
			let i = 0
			for (const { range: r } of matcher(f.doc, this.lastSearchQuery)) {
				if (i++ === matchIndex) { range = r; break }
			}
		} catch { /* ignore */ }
		this.currentIndex = idx
		if (range) {
			const top = this.locateScrollTop(idx, range.getBoundingClientRect())
			if (top != null) { this.scrollContInstant(top); return }
		}
		this.scrollToIndex(idx)
	}

	/** 跳转到 CFI 位置（书签/高亮/标注点击）：
	 *  连续模式先落到章，再分两类精确定位——
	 *  真实 CFI（含文本偏移，高亮）用 rangeFromCfiParts 还原 Range 精确定位；
	 *  合成 CFI（base!,/1:pct，书签/进度）按章内比例定位。
	 *  之前只取章节号，章内信息被丢弃 → 表现为「无法定位到具体位置」 */
	async jumpToCfi(cfi: string, textHint?: string): Promise<void> {
		if (this.isContinuous && this.continuousEl) {
			let idx = this.sectionIndexFromPos(cfi)
			// CFI 解析失败但有文本提示（旧格式/畸形 CFI）：按文本全书定位所属章
			if (idx == null && textHint && textHint.trim().length > 3) {
				const sections = (this.el?.book as unknown as { sections?: { createDocument?: () => Promise<Document>; linear?: string }[] })?.sections ?? []
				for (let i = 0; i < sections.length; i++) {
					const sec = sections[i]
					if (!sec?.createDocument || sec.linear === "no") continue
					try {
						const doc = await sec.createDocument()
						if ((doc.body?.textContent ?? "").includes(textHint.slice(0, 80))) { idx = i; break }
					} catch { /* ignore */ }
					if (idx != null) break
				}
			}
			if (idx != null) {
				const cont = this.continuousEl
				// 取代进行中的章节跳转：否则上一次跳转的漂移校正循环会把视图拽回旧目标
				const seq = ++this.jumpSeq
				this.jumpPending = true
				const alive = (): boolean => seq === this.jumpSeq
				this.pushContHistory()
				await this.loadSections([idx])
				// 等渲染 + 首轮测高都完成：占位/60vh 临时高度下按比例计算会退化为章节顶部
				for (let n = 0; n < 50; n++) {
					if (!alive()) { this.endJump(); return }
					const f0 = this.contFrames.get(idx)
					if (f0?.doc && f0.lastHeight > 0) break
					this.pumpLoadToward(idx)
					await new Promise(r => window.setTimeout(r, 120))
				}
				const f = this.contFrames.get(idx)
				const wrap = this.contSectionEls.get(idx)
				this.currentIndex = idx
				if (!f?.doc || !wrap) { this.scrollToIndex(idx); this.endJump(); this.focusContent(); return }
				// 合成 CFI：base!,/1:pct → 章内比例（与 relocate/恢复位置同口径）
				const inner = cfi.trim().match(/^epubcfi\((.*)\)$/)?.[1] ?? ""
				const segs = inner.split("!")
				// "!" 后可能紧跟范围逗号（base!,/1:pct），需去掉段首逗号再判定
				const local = segs.length > 1 ? (segs[segs.length - 1] ?? "").replace(/^,+/, "") : inner
				const synthetic = /^\/1:\d+$/.test(local)
				if (synthetic) {
					// 合成 CFI（书签/进度）：/1:pct → 章内比例定位
					const mOff = local.match(/:(\d+)\s*$/)
					if (mOff) {
						const pct = parseInt(mOff[1]!, 10)
						const frac = Math.min(0.98, Math.max(0, (pct - 1) / 1000))
						const landPct = (): void => {
							if (!alive()) return
							const top = this.absContentTop(idx, wrap)
							if (top == null || wrap.offsetHeight <= 0) return
							this.scrollContInstant(top + wrap.offsetHeight * frac - (cont.clientHeight / 2))
						}
						landPct()
					// 版面稳定后校正：晚到的图片/字体会改变章内高度占比，
					// 按最终高度重新对齐一次，避免落点漂移（表现为定位不到具体页）
					let lastH = -1
					let rounds = 0
					const settle = (): void => {
						if (!alive()) return
						const h2 = this.contFrames.get(idx)?.lastHeight ?? 0
						// 高度不变 = 落点依然准确，无需重滚（之前每轮无条件 landPct，
						// 制造多余瞬移 + relocate/补载连锁，是返回跳转僵硬的主因之一）
						if (h2 > 0 && h2 === lastH) { this.endJump(); return }
						lastH = h2
						if (h2 > 0) landPct()
						if (rounds++ < 10) window.setTimeout(settle, 350)
						else this.endJump()
					}
					window.setTimeout(settle, 400)
						this.focusContent()
						return
					}
					this.scrollToIndex(idx)
					this.focusContent()
					return
				}
				// 真实 CFI（高亮）：还原 Range 精确定位（保留 70px 上文，同脚注/搜索跳转）
				const fdoc = f.doc
				// 定位与渲染必须走同一条还原链（两种 CFI 口径 + 文本判据）：
				// 只走 rangeFromCfiParts 时，旧格式（foliate/规范口径）的 CFI 一律解不出，
				// 于是「侧栏点高亮」只落到章首（用户报的「定位不到高亮」）。
				const range = this.rangeFromAnyCfi(fdoc, cfi, textHint)
				if (range && fdoc) {
					const locateTop = (): number | null => {
						try {
							const r2 = this.rangeFromAnyCfi(fdoc, cfi, textHint)
							return r2 ? this.locateScrollTop(idx, r2.getBoundingClientRect()) : null
						} catch { return null }
					}
					const top = locateTop()
					if (top != null) {
						this.scrollContInstant(top)
						// 落地后漂移校正：章节内图片/字体晚到会平移目标点，按当前 Range 位置重新对齐。
						// 观察窗口要足够长（图片加载常在数秒后），连续 3 轮稳定才收工
						let anchor = top
						let stable = 0
						let rounds = 0
						const correct = (): void => {
							if (!alive()) return
							const now = locateTop()
							if (now == null) { if (rounds++ < 30) window.setTimeout(correct, 400); else this.endJump(); return }
							// 增量跟随（同 jumpToSection 漂移校正）：只补漂移量，不重算绝对落点
							if (Math.abs(now - anchor) > 2) {
								const cc = this.continuousEl
								if (cc) this.scrollContInstant(cc.scrollTop + (now - anchor))
								anchor = now
								stable = 0
							}
							else stable++
							if (stable < 3 && rounds++ < 30) window.setTimeout(correct, 400)
							else this.endJump()
						}
						window.setTimeout(correct, 350)
						this.focusContent()
						return
					}
				}
				this.scrollToIndex(idx)
				this.endJump()
				this.focusContent()
				return
			}
		}
		await this.el?.goTo(cfi)
		this.focusContent()
	}

	private replayHighlightsFor(idx: number): void {
		const list = this.contHLByIndex.get(idx) ?? []
		for (const cfi of list) {
			const color = this.highlights.get(cfi) ?? this.contHL.get(cfi)?.color ?? "yellow"
			void this.renderHighlightIn(idx, cfi, color)
		}
	}

	/** 覆盖矩形合并/去重的**阴性对照开关**（`localStorage["unreader-hl-nomerge"]="1"`）：
	 *  退回「`range.getClientRects()` 照单全画」的旧行为（重复矩形叠出深色块、
	 *  同行的碎片圆角在接缝处留缺口）。回归 `npm run test:engine` + `taphighlight`
	 *  用它验证几何断言有辨别力。**每次现读**（同 `unreader-keep-frames` 约定）。 */
	private hlNoMerge(): boolean {
		try { return window.localStorage.getItem("unreader-hl-nomerge") === "1" } catch { return false }
	}

	/** Range → 覆盖矩形（按行合并）。
	 *
	 *  `range.getClientRects()` 直接拿来画有两个实测缺陷（桌面/手机都有，用户报的
	 *  「从中间断开 + 部分颜色加重」）：
	 *  ① 规范要求把**被整段选中的元素自己的边框盒**也塞进列表（CSSOM-View：fully
	 *     contained 的元素各给一个 rect）。AZW3 里 `…saith plainly, <i>Nescio quid
	 *     sit.</i>…` 的斜体被整段选中时，它的盒子与那行文字碎片**完全重合** → 同一
	 *     位置画两个半透明矩形，`mix-blend-mode: multiply` 叠加后明显更深（截图里
	 *     就是斜体那块「颜色加重」；实测 `(255,239,178)` → `(255,224,124)`）。
	 *     整段选中的 `<p>` 更糟：块盒比文字宽，高亮会拖到行尾。
	 *  ② 每个碎片各自一个 `.unreader-hl-rect`，而它带 `border-radius: 2px` → 同一行
	 *     相邻碎片的接缝处各留一道圆角缺口，整块高亮看起来「从中间断开」。
	 *
	 *  所以：覆盖矩形**以逐文本节点切片的碎片为准**（与选中的文字一一对应），元素盒
	 *  只在「文本碎片没盖住」处补进来（图片/`<hr>` 这类没有文字的被选内容），最后把
	 *  同一行的相邻碎片合并成一段（行与行之间不合并，首尾圆角因此保留）。 */
	private coverRectsForRange(doc: Document, range: Range): CoverRect[] {
		const box = (r: DOMRect): CoverRect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
		const ok = (r: DOMRect): boolean => r.width >= 1 && r.height >= 1
		const raw = Array.from(range.getClientRects()).filter(ok).map(box)
		if (this.hlNoMerge()) return raw
		const frags: CoverRect[] = []
		const root = doc.body ?? doc.documentElement
		if (root) {
			const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const tn = n as Text
				try {
					// 边界节点按偏移切片；其余相交节点整段取。`intersectsNode` 对
					// 「部分相交」也只返回 true（边界是元素时，子文本节点非全有即全无）
					if (!range.intersectsNode(tn)) continue
					const s = tn === range.startContainer ? range.startOffset : 0
					const e = tn === range.endContainer ? range.endOffset : (tn.textContent ?? "").length
					if (s >= e) continue
					const slice = doc.createRange()
					slice.setStart(tn, s)
					slice.setEnd(tn, e)
					for (const b of Array.from(slice.getClientRects())) if (ok(b)) frags.push(box(b))
				} catch { /* 单个文本节点失败不影响其余 */ }
			}
		}
		if (!frags.length) return this.mergeRectsPerLine(raw) // 纯图片/无文字：元素盒就是唯一覆盖
		const covered = (outer: CoverRect, r: CoverRect): boolean => {
			const w = Math.min(outer.right, r.right) - Math.max(outer.left, r.left)
			const h = Math.min(outer.bottom, r.bottom) - Math.max(outer.top, r.top)
			return w > 0 && h > 0 && w * h >= 0.95 * (r.width * r.height)
		}
		const extra = raw.filter(r => !frags.some(t => covered(t, r)))
		return this.mergeRectsPerLine([...frags, ...extra])
	}

	/** 同一行的覆盖矩形合并成一段（见 `coverRectsForRange` 的 ②）。
	 *  判据是「同一个行盒 + 水平间隙 ≤ 0.75 个字高」：Range 是连续文本，同一行两片
	 *  碎片之间的水平间隙里一定是**被选中**的内容（空格或行内元素），填掉它不会盖住
	 *  未选中的文字；竖直方向一律不合并，行与行之间的圆角因此保留。
	 *  负间隙（重叠碎片）也一并并掉 —— 那正是「重复矩形叠出深色」的形态。 */
	private mergeRectsPerLine(list: CoverRect[]): CoverRect[] {
		const out: CoverRect[] = []
		const sorted = [...list].sort((a, b) => a.top - b.top || a.left - b.left)
		for (const r of sorted) {
			const last = out[out.length - 1]
			const sameLine = !!last
				&& Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top) > 0.5 * Math.min(last.height, r.height)
			const gap = last ? r.left - last.right : Number.POSITIVE_INFINITY
			if (last && sameLine && gap <= Math.max(1, r.height * 0.75)) {
				last.left = Math.min(last.left, r.left)
				last.right = Math.max(last.right, r.right)
				last.top = Math.min(last.top, r.top)
				last.bottom = Math.max(last.bottom, r.bottom)
				last.width = last.right - last.left
				last.height = last.bottom - last.top
				continue
			}
			out.push({ ...r })
		}
		return out
	}

	private async renderHighlightIn(idx: number, cfi: string, colorName: string, textHint?: string): Promise<void> {
		this.highlights.set(cfi, colorName)
		let list = this.contHLByIndex.get(idx) ?? []
		if (!list.includes(cfi)) list = [...list, cfi]
		this.contHLByIndex.set(idx, list)
		const f = this.contFrames.get(idx)
		const d = f?.doc
		if (!f || !d || !d.body) return // frame 未就绪：wireFrame 完成后会 replay
		// 重绘：先移除已有矩形
		const prev = this.contHL.get(cfi)
		if (prev) for (const old of prev.els) { try { old.remove() } catch { /* ignore */ } }
		try {
			// 判据文本：上次渲染时算出来的文本最可信（与矩形同源）；首次渲染用笔记里存的
			// 选中文本。它只用于「两种 CFI 口径都解得出来时挑对的那个」，见 rangeFromAnyCfi。
			const legacy = this.hlLegacyCfiMode()
			const expected = prev?.text || textHint
			let range = this.rangeFromAnyCfi(d, cfi, expected)
			let text = range ? range.toString().trim() : ""
			// 两种口径都解不出文本（畸形/跨版本数据）→ 按文本在章内反查兜底。
			// 代价是重复文本会命中第一处，但相对「侧栏有记录、正文什么都没有」仍更可用；
			// 老实现只在**上次渲染过**时才兜底（`prev`），旧格式高亮首绘因此直接消失。
			const canFallback = legacy ? !!prev : !!(prev?.text || textHint)
			const needle = prev?.text || textHint || ""
			if (!text && canFallback && needle) {
				const byText = this.findRangeInElement(d.body, needle)
				if (byText) { range = byText; text = needle }
			}
			if (!range || !text) return
			const bodyRect = d.body.getBoundingClientRect()
			const color = highlightColorOf(colorName)
			const els: HTMLElement[] = []
			for (const rct of this.coverRectsForRange(d, range)) {
				// ⚠️ 必须用**全局** `createDiv()`，不能写 `d.createDiv()`：Obsidian 的 DOM 助手
				// 只装在宿主 window 的原型上，而章节 iframe 是**独立 realm**（见
				// core/iframeDomCompat.ts 文件头），frame 文档上根本没有这个方法 → 抛
				// TypeError → 被下面的 catch 吞掉 → **高亮矩形永远画不出来**（正文一片空白、
				// 侧栏却有记录，控制台只有一条 warn）。与 injectFrameCss 同一条口径：
				// 全局助手造游离节点，`d.body.appendChild` 时按 DOM 规范收养进该 frame 文档。
				const hl = createDiv()
				hl.className = "unreader-hl-rect"
				hl.dataset.cfi = cfi
				// background 用 !important：深色覆盖的「容器透明化」规则带 !important，
				// 不加的话 inline 压不过它，标注矩形在深色下整块消失
				hl.style.cssText = `left:${rct.left - bodyRect.left}px;top:${rct.top - bodyRect.top}px;width:${rct.width}px;height:${rct.height}px;background:${color} !important;`
				d.body.appendChild(hl)
				els.push(hl)
			}
			if (els.length) {
				this.contHL.set(cfi, { text, color, els, range })
				for (const elx of els) {
					elx.addEventListener("click", (ev: MouseEvent) => {
						ev.stopPropagation()
						// **矩形底下的链接优先**：矩形是覆盖层，压在正文上就意味着被它盖住的
						// 注标/交叉引用永远点不到（用户报「划了高亮之后点不动注标」）。先按坐标
						// 穿透看底下是不是链接，是就把这次点击完整交回链接那条路
						//（`handleAnchorTap`，与未覆盖时逐字一致）；不是才走下面的高亮编辑。
						const link = this.linkFromEvent(ev)
						if (link) { this.handleAnchorTap(f, link, ev); return }
						// 连续模式在该文档内还原高亮 range，点击即可选中并弹出编辑浮窗。
						//
						// **必须 CFI 优先**（就是渲染矩形用的那个 range）。历史实现按**文本**
						// 反查（findRangeInElement），而它只能对上「逐字拼接 + 空白归一化」
						// 恰好成立的情形，实测三类翻车：
						//   · 真实 AZW3 单块场景：还原出的范围比高亮多 2 字符（映射回原始
						//     偏移时在空白处过冲）→ 选中的不是高亮那一块；
						//   · 跨块（两个 <p>）：needle 里没有分隔符、正文拼接里节点间有空白
						//     → 找不到 → 返回 null → 点了完全不选中；
						//   · 文本在章内重复：indexOf 命中第一处 → 选中了别处。
						// 用户报的「点高亮块没有选中全部高亮文本」即此。
						this.handlers?.onShowAnnotation(cfi, this.highlightRangeFor(cfi, d, range, text))
					})
				}
			}
		} catch (e) {
			console.warn("[UNreader] continuous highlight failed", cfi, e)
		}
	}

	/** 还原某高亮的文档 Range。三级优先：现成 range（渲染矩形用的那个）→
	 *  CFI 还原（两种口径都试，见 `rangeFromAnyCfi`）→ 文本反查（最后兜底，会漂移）。
	 *  frame 重渲染后闭包里的 range 会失去连接，故先验活。 */
	private highlightRangeFor(cfi: string, doc: Document, preferred?: Range | null, fallbackText?: string): Range | null {
		const live = this.liveRange(preferred, doc)
		if (live) return live
		const byCfi = this.rangeFromAnyCfi(doc, cfi, fallbackText)
		if (byCfi) return byCfi
		if (fallbackText) {
			try { return this.findRangeInElement(doc.body, fallbackText) } catch { /* ignore */ }
		}
		return null
	}

	/** CFI → 文档 Range，**两种历史口径都试**（见下面两个实现），用 `expected` 文本判谁对。
	 *
	 *  必须两种都试的原因：本插件连续模式自己那套 CFI（`base!childNodes:offset`）与
	 *  foliate/规范口径（元素-文本虚拟序列 + `[id]` 断言 + 独立的 `,/1:offset` 起止段）
	 *  用的是**不同的下标模型、不同的起点**（body vs documentElement），同一串 CFI
	 *  可能被两套都解出来却解到不同位置。所以判据是**文本**：
	 *    · expected 有 → 谁解出的文本对得上就用谁（相等 2 分、互为前缀 1 分、否则 0 分）；
	 *    · expected 无 → 优先本插件口径（现状行为），它解不出文本时才退规范口径。
	 *  真实旧数据实测（用户笔记里的 `epubcfi(/6/10!/4[2RHM0-…]/6,/1:0,/1:183)`）：
	 *  插件口径解到的是**元素**（判空 → 正文里永远画不出高亮块，侧栏有、点进去只到章首），
	 *  规范口径解出的文本与笔记里存的选中文本逐字相同。 */
	private rangeFromAnyCfi(doc: Document, cfi: string, expected?: string): Range | null {
		const safe = (f: () => Range | null): Range | null => { try { return f() } catch { return null } }
		const plugin = safe(() => this.rangeFromCfiParts(doc, cfi))
		const spec = this.hlLegacyCfiMode() ? null : safe(() => this.specCfiRange(doc, cfi))
		const want = (expected ?? "").replace(/\s+/g, " ").trim()
		if (!want) {
			return plugin && plugin.toString().trim() ? plugin : (spec ?? plugin)
		}
		const score = (r: Range | null): number => {
			if (!r) return -1
			const t = r.toString().replace(/\s+/g, " ").trim()
			if (!t) return -1
			if (t === want) return 2
			if (want.length > 8 && (t.startsWith(want) || want.startsWith(t))) return 1
			return 0
		}
		const ps = score(plugin)
		const ss = score(spec)
		if (ss > ps) return spec
		return ps >= 0 ? plugin : spec
	}

	/** **规范口径** CFI → Range（EPUB CFI 规范 / foliate 的 `view.getCFI` 生成的那种）。
	 *  旧版（分页模式）写下的高亮/书签都是这个格式，特征：路径里带元素 id 断言
	 *  （`/4[2RHM0-5079eb12709e441c9e80e542fd21586f]`）、起止可以是独立的 `,/1:183` 段。
	 *  它从 `documentElement` 起算、只数「元素 + 文本块」的虚拟序列（见
	 *  `vendor/foliate-js/epubcfi.js` 的 `indexChildNodes`），与 `rangeFromCfiParts`
	 *  的「body + childNodes」模型是两回事——所以必须借 vendored 的 `CFI.toRange` 来解。
	 *
	 *  **第一段间接层（`!` 前）必须剥掉**：它是包文档里的 spine itemref 路径
	 *  （`/6/10`），而 `toRange` 是拿 `doc.documentElement` 当根解的，段落文档里没有那一层。
	 *  剥掉后只剩一层时说明这串 CFI 本来就没有包层，原样保留。 */
	private specCfiRange(doc: Document, cfi: string): Range | null {
		const c = cfi.trim()
		if (!CFI.isCFI.test(c)) return null
		type Part = { index: number; id?: string; offset?: number }
		type Levels = Part[][]
		const parsed = CFI.parse(c) as Levels | { parent?: Levels; start?: Levels; end?: Levels }
		// 有包层（≥2 段）才剥掉第一段；只有一段时它就是局部路径
		const local = (ls: Levels | undefined): Levels | undefined => {
			if (!ls) return ls
			return ls.length > 1 ? ls.slice(1) : ls
		}
		const localParts = Array.isArray(parsed)
			? local(parsed)
			: { parent: local(parsed.parent), start: parsed.start, end: parsed.end }
		if (!localParts || (Array.isArray(localParts) && !localParts.length)) return null
		const r = CFI.toRange(doc, localParts)
		if (!r) return null
		// 解到文档外/空节点时 toRange 会抛（已在调用处捕获）；这里只挡住「解出的起点终点
		// 都不在当前文档里」的退化结果，避免把矩形画到别的文档对象上
		const st = r.startContainer
		if (!st || st.ownerDocument !== doc || !st.isConnected) return null
		return r
	}

	/** **旧行为阴性对照开关**（`localStorage["unreader-hl-legacy-cfi"]="1"`）：关掉规范口径
	 *  CFI 解析，并让文本兜底退回「只有上一次渲染过才兜底」的老条件——这就是修复前那条链
	 *  （`rangeFromCfiParts` + `prev` 兜底）。旧格式高亮在它下面首绘直接消失（用户报的
	 *  「侧栏有、正文没有」）。回归 `run-probe.mjs legacycfi` 的阴性档据此断言必须变红。
	 *  **每次现读**（与 `unreader-keep-frames` 同一约定），便于同页内切换档位。 */
	private hlLegacyCfiMode(): boolean {
		try { return window.localStorage.getItem("unreader-hl-legacy-cfi") === "1" } catch { return false }
	}

	/** Range 是否仍可用：属于该文档且边界未失去连接 */
	private liveRange(range: Range | null | undefined, doc: Document): Range | null {
		if (!range) return null
		try {
			const start = range.startContainer
			if (!start || start.ownerDocument !== doc || !start.isConnected) return null
			return range
		} catch { return null }
	}

	/** 还原本插件生成的本地路径 CFI → 隐藏文档 Range */
	private rangeFromCfiParts(doc: Document, cfi: string): Range | null {
		try {
			// 宽松解析：兼容旧数据缺右括号的 CFI
			let inner = cfi.trim()
			if (inner.startsWith("epubcfi(")) inner = inner.slice(8)
			if (inner.endsWith(")")) inner = inner.slice(0, -1)
			const segs = inner.split("!")
			const local = segs.length > 1 ? (segs[segs.length - 1] ?? "") : inner
			// 局部可能是「起点路径,终点路径」，旧数据仅起点（此时退化到该文本节点末尾）
			const halves = local.includes(",") ? local.split(",") : [local]
			const tokensOf = (s: string): { i: number; off?: number }[] =>
				[...s.matchAll(/\/(\d+)(?::(\d+))?/g)].map(m => ({ i: parseInt(m[1]!, 10), off: m[2] ? parseInt(m[2], 10) : undefined }))
			const resolve = (tokens: { i: number; off?: number }[]): { node: Text; off: number } | null => {
				let node: Node | null = doc.body
				for (const tk of tokens) {
					if (!node) return null
					const kids: (Node | null)[] = Array.from(node.childNodes)
					node = kids[Math.max(0, Math.min(kids.length - 1, tk.i - 1))] ?? null
				}
				if (!node || node.nodeType !== 3) return null
				const off = Math.max(0, Math.min(node.textContent?.length ?? 0, (tokens[tokens.length - 1]!.off ?? 1) - 1))
				return { node: node as Text, off }
			}
			const s = resolve(tokensOf(halves[0] ?? ""))
			if (!s) return null
			const e = halves.length > 1 ? resolve(tokensOf(halves[1] ?? "")) : null
			const r = doc.createRange()
			r.setStart(s.node, s.off)
			if (e) r.setEnd(e.node, e.off)
			else r.setEnd(s.node, s.node.textContent?.length ?? 0)
			return r
		} catch { return null }
	}

	/** 在元素内查找文本的首个 Range（跨文本节点拼接匹配，空白归一化） */
	private findRangeInElement(root: HTMLElement, text: string): Range | null {
		try {
			const norm = (s: string): string => s.replace(/\s+/g, " ")
			const needle = norm(text).trim()
			if (!needle) return null
			const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
			const nodes: Text[] = []
			let combined = ""
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const tn = n as Text
				combined += norm(tn.textContent ?? "")
				nodes.push(tn)
				const pos = combined.indexOf(needle)
				if (pos >= 0) {
					// 把归一化坐标映射回真实节点/偏移：归一化只压缩了空白，
					// 长度变化都发生在空白处，逐节点对齐仍成立（空白前后位置不变）
					const r = root.ownerDocument.createRange()
					const mapToRaw = (normPos: number): { node: Text; off: number } | null => {
						let acc = 0
						for (let i = 0; i < nodes.length; i++) {
							const nd = nodes[i]!
							const nLen = norm(nd.textContent ?? "").length
							const rawLen = (nd.textContent ?? "").length
							if (acc + nLen > normPos || i === nodes.length - 1) {
								const offInNorm = normPos - acc
								// 在节点内部把归一化偏移映射回真实字符位置：跳过空白即可（归一化只压缩空白）
								const nStr = nd.textContent ?? ""
								let consumed = 0
								let rawIdx = 0
								for (; rawIdx < nStr.length && consumed < offInNorm; rawIdx++) {
									if (!/\s/.test(nStr[rawIdx]!)) consumed++
								}
								return { node: nd, off: Math.min(rawLen, rawIdx) }
							}
							acc += nLen
						}
						return null
					}
					const s = mapToRaw(pos)
					const e = mapToRaw(pos + needle.length)
					if (s && e) {
						r.setStart(s.node, s.off)
						r.setEnd(e.node, e.off)
						return r
					}
					return null
				}
			}
		} catch { /* ignore */ }
		return null
	}

}

/** Style a secondary foliate-view used inside the footnote popup. */
export function styleFootnoteView(
	view: RawFoliateView,
	appearance: AppearanceSettings,
	widthPx: number,
): void {
	try {
		const r = view.renderer as unknown as { setAttribute?: (k: string, v: string) => void; setStyles?: (s: string) => void } | undefined
		if (!r?.setAttribute || !r?.setStyles) return
		r.setAttribute("flow", "scrolled")
		r.setAttribute("max-inline-size", `${Math.round(widthPx)}px`)
		// 注释弹窗内必须把 NOTE_HIDE_CSS 隐藏的注释体强制显示
		// 主题 CSS 按滚动模式生成（弹窗是滚动流），避免套用分页边距补偿
		const resolved = resolveAppearance(appearance)
		r.setStyles(buildThemeCss(resolved) + "\n" + NOTE_REVEAL_CSS)
	} catch (e) {
		console.error("[UNreader] footnote view styling failed", e)
	}
}
