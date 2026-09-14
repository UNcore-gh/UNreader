/**
 * 诊断报告的落盘（设置页「保存到库」与命令「导出诊断日志」共用）。
 *
 * 单独成文件的理由：这条落点**会被反复使用**（排查闭环是「复现 → 导出 → 交给
 * 开发者读盘」），两处各写一份必然漂移（重名序号规则、时间戳格式、create 与索引
 * 竞态的兜底），而漂移的后果是「报告写到了另一个位置 / 覆盖了上一份」—— 恰好发生
 * 在最需要证据的时候。
 *
 * 落点选**库根**（而不是插件目录）是刻意的：库内普通文件会随同步走、且 agent 能
 * 直接读盘；插件目录里的东西**默认不参与同步**，把证据留在离线设备上就等于没有。
 */
import type { App } from "obsidian";
import * as debugLog from "./debugLog";

/** 时间戳形如 `20260911T132045` → 去掉分隔符取前 14 位（`20260911132045`） */
function stamp(): string {
	return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** 写到库根 `unreader-debug-log-<时间戳>.txt`，重名自动加 `-1` / `-2` …
 *  返回实际写入的路径（调用方用于提示用户）。 */
export async function saveDebugReportToVault(app: App): Promise<string> {
	return writeReport(app, "unreader-debug-log", debugLog.buildReport());
}

/** 通用落盘：`<prefix>-<时间戳>.txt` 写到库根，重名自动加序号。
 *  相邻界面快照（`explorerDiag`）复用它 —— 那份证据**不能依赖调试日志开关**
 *  （关着时缓冲为空 = 你要的证据恰好不落盘）。 */
export async function writeReport(app: App, prefix: string, text: string): Promise<string> {
	const base = `${prefix}-${stamp()}`;
	let path = `${base}.txt`;
	for (let i = 1; app.vault.getAbstractFileByPath(path); i++) {
		path = `${base}-${i}.txt`;
	}
	try {
		await app.vault.create(path, text);
	} catch {
		// create 与 vault 索引存在竞态时落回 adapter 直写
		await app.vault.adapter.write(path, text);
	}
	return path;
}
