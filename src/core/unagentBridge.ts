/** UNagent 桥：检测旧版 AI 能力，并将选区交给新版 UNagent 聊天。
 *
 * 依赖方向单向（UNreader → UNagent）：全文工具沿用 `getAI()`，选区交接使用
 * `runReaderAiTask()`。两者能力分开检测，避免旧接口可用时误报全文工具不可用。
 * 检测实时进行、不缓存；**绝不读取 UNagent 的设置或 data.json**（安全边界，
 * `test:aitrans` 有源码不变量盯着）。 */
import type {
	UnagentAIApi,
	UnagentCompleteRequest,
	UnagentCompleteResult,
	UnagentDetection,
	UnagentUnavailableReason,
} from "../types";
import { getLang, t, type StrKey } from "./i18n";

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
	runReaderAiTask?: (request: { text: string; quickComposer: boolean; newConversation: boolean; signal?: AbortSignal }) => Promise<void>
}

let selectionHandoffInFlight = false;

function getUnagentPlugin(host: unknown): UnagentPluginShape | undefined {
	const plugin = (host as { plugins?: { plugins?: { unagent?: unknown } } | null } | null | undefined)?.plugins?.plugins?.unagent;
	return plugin && typeof plugin === "object" ? plugin as UnagentPluginShape : undefined;
}

/** 只检查「选区交给聊天」所需的新接口；不影响全文工具使用的 getAI()。 */
export function hasUnagentSelectionHandoff(host: unknown): boolean {
	return typeof getUnagentPlugin(host)?.runReaderAiTask === "function";
}

/** 选区入口和面板共用的说明，明确区分旧 getAI 与新交接接口。 */
export function unagentSelectionHandoffGuidance(host: unknown): string {
	const plugin = getUnagentPlugin(host);
	if (!plugin) return unagentGuidance("not-installed");
	if (typeof plugin.runReaderAiTask === "function") return "";
	if (typeof plugin.getAI !== "function") return unagentGuidance("no-method");
	if (detectUnagent(host).available) {
		return "当前 UNagent 的旧版 AI 接口可用于全文工具，但选区交接接口不可用。请更新 UNagent 后重试选区功能。";
	}
	return "当前 UNagent 缺少选区交接接口。请更新 UNagent；全文工具还需要在 UNagent 中配置可用模型。";
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

function selectionTranslationPrompt(): string {
	const language = getLang() === "en" ? "English" : "简体中文";
	return [
		`你是书内选区翻译引擎，把用户给出的文本翻译成${language}。`,
		"只输出译文正文：不要解释、不要前言结语、不要用引号包裹。",
		`若原文本身已是${language}，原样返回文本。`,
	].join("\n");
}

/** 选区翻译：M2 为单次调用（划词长度远小于单次上限；超限由 UNagent 抛错，
 *  message 已 friendlyMessage 化，直接展示即可），分块/缓存是 M3 的事。
 *  错误原样上抛 —— 由调用方决定展示位置（卡片 error 态 / Notice）。 */
export function translateViaUnagent(
	api: UnagentAIApi,
	text: string,
	options?: { signal?: AbortSignal; onChunk?: (delta: string) => void },
): Promise<UnagentCompleteResult> {
	const request: UnagentCompleteRequest = {
		system: selectionTranslationPrompt(),
		user: text,
		temperature: 0.2,
		onChunk: options?.onChunk,
		signal: options?.signal,
	};
	return api.complete(request);
}

/** 将冻结原文交给 UNagent；输出位置和会话由用户选择。 */
export async function openUnagentSelectionChat(host: unknown, instruction: string, text: string, options?: { quickComposer?: boolean; newConversation?: boolean; signal?: AbortSignal }): Promise<boolean> {
	const plugin = getUnagentPlugin(host);
	if (!plugin) throw new Error(unagentGuidance("not-installed"));
	if (typeof plugin.runReaderAiTask !== "function") throw new Error(unagentSelectionHandoffGuidance(host));
	if (options?.signal?.aborted) throw selectionHandoffAbortError();
	// 所有选区入口共用此锁：工具条连点、或多个入口同时触发，都只提交一次。
	// API 完成、失败或取消后释放，用户仍可再次运行。
	if (selectionHandoffInFlight) return false;
	selectionHandoffInFlight = true;
	try {
		await plugin.runReaderAiTask({
			text: `${instruction}\n\n以下是我在 UNreader 中选中的原文，请将其作为待处理材料：\n\n${text}`,
			quickComposer: options?.quickComposer !== false,
			newConversation: options?.newConversation === true,
			signal: options?.signal,
		});
		return true;
	} finally {
		selectionHandoffInFlight = false;
	}
}

function selectionHandoffAbortError(): Error {
	const error = new Error("选区交接已取消。");
	error.name = "AbortError";
	return error;
}
