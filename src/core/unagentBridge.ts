/** UNagent 桥：检测与选区翻译（M2）。
 *
 * 依赖方向单向（UNreader → UNagent）：这里只经 `app.plugins.plugins.unagent?.getAI?.()`
 * 这一个口子说话，契约见《UNreader接入UNagent-AI设计任务书》§1 —— 三重可选链
 * （插件未安装/已禁用、旧版本无方法、未配置模型）全部落入「不可用」分支，绝不抛
 * 未捕获错误；**绝不读取 UNagent 的设置或 data.json**（安全边界，test:aitrans 有
 * 源码不变量盯着）。检测必须实时做、不得缓存：`getAI()` 在 UNagent 设置未载完时
 * 返回 null（契约 §1.4），UI 每次点击现查，`describeModel()` 也在开卡时现取。
 *
 * 方法最终命名由 UNagent 侧 M1 定稿；定稿后只需改本文件的调用点一处，
 * 并同步双方 AGENTS.md（契约冻结）。 */
import type {
	UnagentAIApi,
	UnagentCompleteRequest,
	UnagentCompleteResult,
	UnagentDetection,
	UnagentUnavailableReason,
} from "../types";
import { t, type StrKey } from "./i18n";

/** 三态指引文案（入口点击时直接展示，告诉用户去哪里修）。
 *
 *  刻意做成**函数**而不是常量表：`reason`（`not-installed` / `no-method` /
 *  `not-configured`）是机器可读的契约，跨语言不变；但承载它的那句**人话**要跟
 *  界面语言走。做成常量表就只能在模块加载时定死语言，切换后拿不到新文案。 */
export function unagentGuidance(reason: UnagentUnavailableReason): string {
	const key = `guidance${reason.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("")}` as StrKey;
	return t(key);
}

interface UnagentPluginShape {
	getAI?: (...args: unknown[]) => unknown
}

/** 检测 UNagent 与可用模型。host 必传（生产调用方传 `this.app`，探针喂 fake）——
 *  故意不给默认值：core 层不摸全局，可测性靠参数注入。 */
export function detectUnagent(host: unknown): UnagentDetection {
	const plugins = (host as { plugins?: { plugins?: Record<string, unknown> } } | null | undefined)?.plugins?.plugins;
	const plugin = plugins?.unagent as UnagentPluginShape | undefined;
	if (!plugin || typeof plugin !== "object") return { available: false, reason: "not-installed" };
	if (typeof plugin.getAI !== "function") return { available: false, reason: "no-method" };
	try {
		const api = plugin.getAI() as UnagentAIApi | null | undefined;
		if (!api || typeof api.complete !== "function" || typeof api.describeModel !== "function") {
			return { available: false, reason: "not-configured" };
		}
		return { available: true, api };
	} catch {
		// getAI() 自己抛错也按「未配置」处理：检测层对任何形态都不得抛
		return { available: false, reason: "not-configured" };
	}
}

const SYSTEM_PROMPT = [
	"你是书内选区翻译引擎，把用户给出的文本翻译成简体中文。",
	"只输出译文正文：不要解释、不要前言结语、不要用引号包裹。",
	"若原文本身已是简体中文，原样返回文本。",
].join("\n");

/** 选区翻译：M2 为单次调用（划词长度远小于单次上限；超限由 UNagent 抛错，
 *  message 已 friendlyMessage 化，直接展示即可），分块/缓存是 M3 的事。
 *  错误原样上抛 —— 由调用方决定展示位置（卡片 error 态 / Notice）。 */
export function translateViaUnagent(
	api: UnagentAIApi,
	text: string,
	options?: { signal?: AbortSignal; onChunk?: (delta: string) => void },
): Promise<UnagentCompleteResult> {
	const request: UnagentCompleteRequest = {
		system: SYSTEM_PROMPT,
		user: text,
		temperature: 0.2,
		onChunk: options?.onChunk,
		signal: options?.signal,
	};
	return api.complete(request);
}
