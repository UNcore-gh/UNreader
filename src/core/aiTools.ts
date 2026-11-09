import { OFFICIAL_TOOLS } from "./aiTasks";
import type { AiSettings, AiCustomFunction } from "../types";

const LEGACY_LANGUAGE_TOKEN = "{目标语言}";
const LEGACY_DEFAULT_TRANSLATE_PROMPT = `你是专业的图书翻译引擎。把用户给出的内容翻译成${LEGACY_LANGUAGE_TOKEN}，保持原文的段落结构与语气，专有名词保留原文。只输出译文：不要解释、不要前言结语、不要用引号包裹。`;

/** 旧版提示词可能残留语言占位符；新模型在运行级统一跟随界面语言，工具定义里不再出现。 */
function normalizeToolPrompt(id: string, prompt: string): string {
	if (id === "translate" && prompt === LEGACY_DEFAULT_TRANSLATE_PROMPT) {
		return OFFICIAL_TOOLS.find(tool => tool.id === "translate")!.defaultPrompt;
	}
	return prompt.split(LEGACY_LANGUAGE_TOKEN).join("当前界面语言");
}

/** 一次性把旧内置工具与用户工具合并；已迁移的空列表就是用户删除后的结果。 */
export function migrateAiTools(settings: AiSettings): AiSettings {
	const existing = (settings.customFunctions ?? []).map(tool => ({ ...tool, prompt: normalizeToolPrompt(tool.id, tool.prompt) }));
	if (settings.toolsInitialized) {
		const changed = existing.some((tool, index) => tool.prompt !== settings.customFunctions?.[index]?.prompt);
		return changed ? { ...settings, customFunctions: existing } : settings;
	}
	const defaults: AiCustomFunction[] = OFFICIAL_TOOLS
		.filter(tool => !existing.some(fn => fn.id === tool.id))
		.map(tool => {
			const override = settings.toolOverrides?.[tool.id];
			return {
				id: tool.id,
				name: tool.name,
				prompt: override?.prompt ?? tool.defaultPrompt,
				scope: override?.scope ?? tool.defaultScope,
				enabled: override?.enabled !== false,
				mode: tool.id === "typography" ? "typography" : "rewrite",
			};
		});
	return {
		...settings,
		toolsInitialized: true,
		toolOverrides: {},
		customFunctions: [...defaults, ...existing],
	};
}
