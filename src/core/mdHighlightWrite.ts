/** 把一次高亮编辑计划写回 markdown 笔记源文件。
 *
 *  **双通道**（阅读模式下 `view.editor` 是否实例化并不由我们掌握，所以必须有兜底）：
 *  ① `editor.replaceRange()` —— 走 CM6 事务，**进编辑器撤销栈，Cmd/Ctrl+Z 可撤销**。首选。
 *  ② `vault.process()` —— 原子读改写，先例来自 `annotationStore.writeAnnotations`。
 *     **不进撤销栈**，仅在编辑器不可用时兜底。
 *
 *  **两条通道都先做「用最新内容复核」**：选区快照与用户点色点之间存在时间窗
 *  （官方重排、别的面板在编辑同一文件、同步回写…），偏移可能已经失效。复核不上就
 *  **不写**——错写一处 `==` 会污染用户的笔记，比什么都不做严重得多。
 */

import { TFile, type App, type Editor, type MarkdownView } from "obsidian";
import type { EditPlan } from "./mdSelectionMap";

export interface WriteResult {
	ok: boolean
	/** 实际走的通道：`editor`（可撤销）/ `vault`（不可撤销）/ `none`（没写） */
	via: "editor" | "vault" | "none"
}

/** 用最新内容复核计划：区间必须是期望的那段原文，否则视为失效。 */
function verify(fresh: string, plan: EditPlan, expected: string): EditPlan | null {
	if (plan.from < 0 || plan.to > fresh.length || plan.to < plan.from) return null;
	if (fresh.slice(plan.from, plan.to) !== expected) return null;
	return plan;
}

/**
 * 落盘一次编辑。
 *
 * `expected` = 生成计划时该区间的原文（`src.slice(plan.from, plan.to)`），用于写入前复核。
 *
 * `channel`：
 *  - `"auto"`（默认）：有 editor 就走 editor；
 *  - `"vault"`：**强制文件通道**。阅读模式（preview）必须用它 —— 真机上
 *    `MarkdownView.editor` 在 preview 模式下**同样存在**（隐藏的 CM6 文档实例），
 *    对它 `replaceRange` 会把事务写进一个不可见的编辑器：校验通过、Promise 全绿，
 *    但预览不刷新、磁盘文件也不变（用户眼里就是「点高亮没反应」，2026-10-11 真机报障）。
 *    纯 node 端到端探针把 preview 档的 view 建成 `editor: undefined`，恰好绕过了这条
 *    真机路径 —— 所以这个坑必须由调用方按 `getMode()` 显式选通道，不能再靠
 *    「editor 在不在」自动探测。
 */
export async function applyEditPlan(
	app: App,
	view: MarkdownView,
	plan: EditPlan,
	expected: string,
	channel: "auto" | "vault" = "auto",
	expectedPath?: string,
): Promise<WriteResult> {
	const targetFile = view.file;
	const targetPath = expectedPath ?? targetFile?.path;
	if (!targetFile || !targetPath || targetFile.path !== targetPath) return { ok: false, via: "none" };
	// ① 编辑器通道（保留撤销栈）
	if (channel !== "vault") try {
		if (view.file?.path !== targetPath) return { ok: false, via: "none" };
		const ed = (view as unknown as { editor?: Editor }).editor;
		if (ed && typeof ed.replaceRange === "function" && typeof ed.getValue === "function") {
			const fresh = ed.getValue();
			const ok = verify(fresh, plan, expected);
			if (!ok) return { ok: false, via: "none" };
			ed.replaceRange(ok.replacement, ed.offsetToPos(ok.from), ed.offsetToPos(ok.to));
			return { ok: true, via: "editor" };
		}
	} catch (e) {
		console.warn("[UNreader] editor write failed, falling back to vault", e);
	}

	// ② 文件通道（兜底，无撤销栈）
	if (view.file?.path !== targetPath) return { ok: false, via: "none" };
	let wrote = false;
	try {
		await app.vault.process(targetFile, (data: string) => {
			const ok = verify(data, plan, expected);
			if (!ok) return data;
			wrote = true;
			return data.slice(0, ok.from) + ok.replacement + data.slice(ok.to);
		});
	} catch (e) {
		console.error("[UNreader] vault write failed", e);
		return { ok: false, via: "none" };
	}
	return { ok: wrote, via: wrote ? "vault" : "none" };
}

/** 不依赖已打开 MarkdownView 的文件通道；供侧栏独立标注目标按路径安全编辑。 */
export async function applyVaultEditPlan(
	app: App,
	path: string,
	plan: EditPlan,
	expected: string,
): Promise<WriteResult> {
	const file = app.vault.getFileByPath(path);
	if (!(file instanceof TFile) || file.path !== path) return { ok: false, via: "none" };
	let wrote = false;
	try {
		await app.vault.process(file, (fresh: string) => {
			if (file.path !== path) return fresh;
			const verified = verify(fresh, plan, expected);
			if (!verified) return fresh;
			wrote = true;
			return fresh.slice(0, verified.from) + verified.replacement + fresh.slice(verified.to);
		});
	} catch (error) {
		console.error("[UNreader] Markdown annotation write failed", error);
		return { ok: false, via: "none" };
	}
	return { ok: wrote, via: wrote ? "vault" : "none" };
}
