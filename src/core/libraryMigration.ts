import { App, TFile, TFolder, normalizePath } from "obsidian";
import { BOOKS_DIR_NAME, DATA_DIR_NAME, DATA_SUBFOLDERS, PRESETS_FOLDER, RESOURCE_MANIFEST, UNREADER_ROOT, dataRootOf, normalizeDataFolder } from "./paths";
import type { UNreaderSettings } from "../types";

export interface LibraryPathMove {
	from: string;
	to: string;
}

export interface LibraryMigrationPlan {
	/** 迁移前的数据根（`UNreader` 之类，直接显示给用户）。 */
	from: string;
	/** 迁移后的数据根。 */
	to: string;
	moves: LibraryPathMove[];
	/** 目标位置已存在同名文件时列在这里（整批中止）。 */
	collisions: string[];
	/** 自动整理（容器化）时因目标重名而**整目录跳过**的名字（留在原地，绝不覆盖）。
	 *  与 `collisions` 的区别：那是用户主动搬家的整批中止；这里是升级自动整理，
	 *  坏一个目录不能挡住其余目录收敛。 */
	skippedDirs?: string[];
	/** 旧版散放布局整理时保留外层目录，只删除其中空的插件数据子目录。 */
	keepSourceRoot?: boolean;
}

export interface LibraryMigrationResult {
	plan: LibraryMigrationPlan;
	/** 全部文件迁移成功后才会有值；失败回滚成功时为空。 */
	moved: LibraryPathMove[];
	/** 迁移后已空、被删掉的旧目录（只删空壳，绝不删有内容的目录）。 */
	removedEmpty: string[];
	error?: string;
	rollbackFailures: string[];
}

/** 预检旧版「直接把数据散放在所选文件夹」的布局。
 *
 *  旧实现把 `settings.dataFolder` 本身当作数据根，于是在用户选中 `配置` 后，文件会落到
 *  `配置/Progress/...`。新的语义固定把真正的数据根放在 `配置/UNreader/`，且数据统一收进
 *  其中的 `Data/` 容器；升级时若只改路径计算，旧数据会看似消失。本函数只识别并移动
 *  `DATA_SUBFOLDERS` 里的内容，一步到位落到 `<外层目录>/UNreader/Data/...`，
 *  不会碰所选文件夹中的其他文件；执行时复用 `migrateDataFolder` 的预检、回滚与空目录清理。 */
export function planLegacyDataFolderNesting(app: App, folder: string | null | undefined): LibraryMigrationPlan {
	const selected = normalizeDataFolder(folder);
	const from = selected ?? "";
	const to = dataRootOf(selected);
	const plan: LibraryMigrationPlan = { from, to, moves: [], collisions: [], keepSourceRoot: true };
	if (!selected) return plan;

	const prefix = `${selected}/`;
	const seen = new Set<string>();
	for (const file of app.vault.getFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const rest = file.path.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash <= 0) continue;
		if (!(DATA_SUBFOLDERS as readonly string[]).includes(rest.slice(0, slash))) continue;
		const destination = `${to}/${DATA_DIR_NAME}/${rest}`;
		if (destination === file.path || seen.has(destination)) continue;
		seen.add(destination);
		plan.moves.push({ from: file.path, to: destination });
		if (app.vault.getAbstractFileByPath(destination)) plan.collisions.push(destination);
	}
	plan.moves.sort((a, b) => a.from.localeCompare(b.from));
	return plan;
}

/** 预检「旧版平铺在数据根下」的六个数据目录，准备收进 `<根>/Data/`（2026-09-19）。
 *
 *  升级后的第一趟启动要把 `<根>/{Progress,...}` 的平铺布局整理成 `<根>/Data/{...}`。
 *  只识别这六个子目录，书与用户文件一律不碰；`Books/` 的空壳由执行后的清理顺手回收
 *  （有内容则原样保留）。
 *
 *  与 `planLegacyDataFolderNesting` 的差别在**冲突粒度**：那边是用户主动搬家
 *  （重名整批中止），这边是升级自动整理、必须能收敛 —— 所以按**目录**处理：
 *  某个目录只要有一个同名目标文件就整个跳过（留在原地、列进 `skippedDirs`），
 *  其余目录照搬。一份坏文件不该挡住另外五个目录的整理。 */
export function planDataContainerNesting(app: App): LibraryMigrationPlan {
	const root = UNREADER_ROOT;
	const container = `${root}/${DATA_DIR_NAME}`;
	// `keepSourceRoot`：`from` 就是数据根 `UNreader/`（外层可能是用户选的目录，但这一层
	// 是我们自己的命名空间）—— 整理完只该回收空掉的平铺子目录，绝不把根本身删掉：
	// 启动瞬间删了又由 `ensureLibraryFolders` 建回来，既制造库事件（移动端文件列表
	// 隐藏窗口，见 explorerHeal），又让「数据根」这个概念在日志/路径里忽隐忽现。
	const plan: LibraryMigrationPlan = { from: root, to: container, moves: [], collisions: [], skippedDirs: [], keepSourceRoot: true };
	const flatNames = new Set<string>(DATA_SUBFOLDERS);
	const byDir = new Map<string, LibraryPathMove[]>();
	for (const file of app.vault.getFiles()) {
		if (!file.path.startsWith(`${root}/`)) continue;
		const rest = file.path.slice(root.length + 1);
		const slash = rest.indexOf("/");
		if (slash <= 0) continue;
		const dir = rest.slice(0, slash);
		if (!flatNames.has(dir)) continue;
		const destination = `${container}/${rest}`;
		if (destination === file.path) continue;
		const bucket = byDir.get(dir) ?? [];
		bucket.push({ from: file.path, to: destination });
		byDir.set(dir, bucket);
	}
	for (const [dir, moves] of byDir) {
		if (moves.some(m => app.vault.getAbstractFileByPath(m.to))) {
			plan.skippedDirs!.push(dir);
			continue;
		}
		plan.moves.push(...moves);
	}
	plan.moves.sort((a, b) => a.from.localeCompare(b.from));
	return plan;
}

/** 把**指向字体文件**的引用从旧字体夹改写到新字体夹；返回被改动的字段 / 文件数。
 *
 *  字体 id 是 `custom:<库内完整路径>`（见 `fontService.scanCustomFonts`），所以字体文件
 *  一挪地方（数据根换位置，或旧版平铺的 `Fonts/` 收进 `Data/`），这四处引用会**全部悬空**
 *  （表现为「阅读外观里的字体突然失效、回落到跟随主题」）：
 *   · 本机当前外观的 `fontFamily`；
 *   · data.json 里的旧预设 `appearancePresets[].appearance.fontFamily`；
 *   · 库内 `Presets/<名>/preset.json`（已随迁移落到新位置）；
 *   · `Resources/resources.json` 里 `font:<路径>` 形式的索引键 —— 键不跟着改，就会丢掉
 *     「已停用」状态与自定义名（`enabled` 会默认回落成启用）。
 *
 *  `fromDirs` 是**旧字体夹路径**的列表（数据根切换传「源根的 Fonts + 可能在的平铺残留」，
 *  容器化只传「根下平铺的 Fonts」），全部映射到 `toDir`。按目录前缀精确改写 —— 比
 *  `fontRefRepair` 的按文件名兜底更可靠（重名字体不会碰运气），两者互为补位。
 *
 *  图片资源不受影响：它的 id 是 `shared:image/<文件名>`，不含目录。
 *
 *  用字符串 split/join 而不是正则：库名可能含 `.` `(` 之类正则元字符，拼正则要么转义
 *  要么踩坑。 */
export async function rewriteFontReferences(
	app: App,
	settings: UNreaderSettings,
	fromDirs: readonly string[],
	toDir: string,
): Promise<number> {
	const fromFonts = fromDirs.map(d => `custom:${d}/`);
	const toFont = `custom:${toDir}/`;
	let changed = 0;
	const rewriteIn = (holder: Record<string, unknown>, field: string): void => {
		const value = holder[field];
		if (typeof value !== "string") return;
		for (const from of fromFonts) {
			if (!value.startsWith(from)) continue;
			holder[field] = toFont + value.slice(from.length);
			changed++;
			return;
		}
	};
	rewriteIn(settings.appearance as unknown as Record<string, unknown>, "fontFamily");
	for (const preset of settings.appearancePresets ?? []) {
		if (!preset?.appearance) continue;
		rewriteIn(preset.appearance as unknown as Record<string, unknown>, "fontFamily");
	}
	for (const file of app.vault.getFiles()) {
		const isPreset = file.name === "preset.json" && file.path.startsWith(`${PRESETS_FOLDER}/`);
		if (!isPreset && file.path !== RESOURCE_MANIFEST) continue;
		try {
			const raw = await app.vault.read(file);
			let next = raw;
			for (const dir of fromDirs) {
				const fromFont = `custom:${dir}/`;
				const fromKey = `font:${dir}/`;
				if (!next.includes(fromFont) && !next.includes(fromKey)) continue;
				next = next.split(fromFont).join(toFont).split(fromKey).join(`font:${toDir}/`);
			}
			if (next === raw) continue;
			await app.vault.modify(file, next);
			changed++;
		} catch (e) {
			// 单个文件改写失败不阻断迁移：剩下的引用仍是对的，用户重选一次字体即可恢复
			console.warn("[UNreader] 改写字体引用失败", file.path, e);
		}
	}
	return changed;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = normalizePath(folderPath).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (app.vault.getAbstractFileByPath(current) instanceof TFolder) continue;
		try {
			await app.vault.createFolder(current);
		} catch {
			if (!(app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw new Error(`无法创建文件夹：${current}`);
		}
	}
}

/** 预检资料文件夹迁移；只读，不创建目录，也不移动文件。
 *
 *  「资料文件夹」是插件**数据**的落点（阅读进度 / 预设 / 字体 / 资源 / 标注笔记），
 *  所以迁移范围就是这几个固定子目录整树搬家 —— **书籍一律不在范围内**，
 *  它们留在各自原来的文件夹（书在库里任何位置都能读，见 core/bookService.ts）。 */
export function planDataFolderMigration(app: App, from: string | null, to: string | null): LibraryMigrationPlan {
	const fromRoot = dataRootOf(from);
	const toRoot = dataRootOf(to);
	const plan: LibraryMigrationPlan = { from: fromRoot, to: toRoot, moves: [], collisions: [] };
	if (fromRoot === toRoot) return plan;

	const prefix = `${fromRoot}/`;
	const seen = new Set<string>();
	for (const file of app.vault.getFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const rest = file.path.slice(prefix.length);
		// 源可能是规范布局（`Data/Progress/x`），也可能是上一轮容器迁移被冲突跳过的
		// 平铺残留（`Progress/x`）—— 统一剥掉可选的 `Data/` 前缀，按数据相对路径重排，
		// 两种形态都落到 `<新根>/Data/...`。
		const rel = rest.startsWith(`${DATA_DIR_NAME}/`) ? rest.slice(DATA_DIR_NAME.length + 1) : rest;
		const slash = rel.indexOf("/");
		if (slash <= 0) continue;
		if (!(DATA_SUBFOLDERS as readonly string[]).includes(rel.slice(0, slash))) continue;
		const destination = `${toRoot}/${DATA_DIR_NAME}/${rel}`;
		if (destination === file.path || seen.has(destination)) continue;
		seen.add(destination);
		plan.moves.push({ from: file.path, to: destination });
		if (app.vault.getAbstractFileByPath(destination)) plan.collisions.push(destination);
	}
	plan.moves.sort((a, b) => a.from.localeCompare(b.from));
	return plan;
}

async function rollbackMoves(app: App, moves: LibraryPathMove[]): Promise<string[]> {
	const failures: string[] = [];
	for (const move of [...moves].reverse()) {
		try {
			const current = app.vault.getAbstractFileByPath(move.to);
			if (!(current instanceof TFile)) throw new Error("迁移后的文件已不可用");
			if (app.vault.getAbstractFileByPath(move.from)) throw new Error("原路径已被占用");
			await ensureFolder(app, move.from.slice(0, move.from.lastIndexOf("/")));
			await app.vault.rename(current, move.from);
		} catch (error) {
			failures.push(`${move.to} → ${move.from}：${errorMessage(error)}`);
		}
	}
	return failures;
}

/** 自底向上删掉旧数据目录里**变空**的那几层（含空掉的旧根），返回被删路径。
 *
 *  为什么要递归：`vault.rename` 搬走的是**文件**，不会顺手删掉它空出来的父目录 ——
 *  `Progress/deep/B.json` 搬走后 `Progress/deep/` 会一直空着，只要不清理，旧根就会
 *  留下一个没用的数据目录骨架。
 *
 *  清理范围限定为插件自己的数据子目录（平铺的与 `Data/` 容器下的都算），外加
 *  **只清空目录的 `Books/`**：书文件不迁移，但空的 Books 骨架可以删除（它已从
 *  「建议落点」退役，2026-09-19）；旧根下其他用户文件与目录一律不碰。
 *  旧根只有在彻底空掉且调用方未要求保留时才删。 */
async function removeEmptyFolders(app: App, root: string, deleteRoot = true): Promise<string[]> {
	const removed: string[] = [];
	/** 返回「这个目录处理完之后是空的吗」——**不要**用 `folder.children` 再判一次：
	 *  那是调用方拿到的那份快照，异步删掉子目录之后它并不会自己更新（真实 vault 里
	 *  是活的，假 vault 里不是，而这种「只有生产环境才对」的判据最容易埋雷）。 */
	const prune = async (folder: TFolder): Promise<boolean> => {
		let empty = true;
		for (const child of [...folder.children]) {
			if (child instanceof TFolder) {
				if (!(await prune(child))) empty = false;
			} else {
				empty = false;
			}
		}
		if (!empty) return false;
		try {
			// force=true：空目录必须永久删除，不能只进本机回收站。普通 delete 会把目录
			// 移进 `.trash`，而 Obsidian Sync 通常不把回收站当成普通库内容同步，其他设备
			// 就会继续看到旧的 `UNreader/` 及空子目录骨架。
			await app.vault.delete(folder, true);
			removed.push(folder.path);
			return true;
		} catch {
			return false; // 删不掉就留着空壳，不影响功能
		}
	};
	// `Books` 不参与文件迁移（移动书会改变路径身份、重置进度），但它已经退役：空的骨架
	// 一律回收，里面有书 / 用户文件时 prune 会保留整棵树。
	for (const name of [...DATA_SUBFOLDERS, BOOKS_DIR_NAME]) {
		const folder = app.vault.getAbstractFileByPath(`${root}/${name}`);
		if (folder instanceof TFolder) await prune(folder);
	}
	// 数据容器：`Data/{六个}` 里的文件被搬走后会留下空壳，容器本身也可能是空的。
	// prune 只删空目录 —— 里面还有任何一个文件（含用户文件）就整棵保留。
	const container = app.vault.getAbstractFileByPath(`${root}/${DATA_DIR_NAME}`);
	if (container instanceof TFolder) await prune(container);
	const rootFolder = app.vault.getAbstractFileByPath(root);
	if (deleteRoot && rootFolder instanceof TFolder && rootFolder.children.length === 0) {
		try {
			await app.vault.delete(rootFolder, true);
			removed.push(rootFolder.path);
		} catch { /* 同上 */ }
	}
	return removed;
}

/** 执行已经预检过的数据迁移。任一文件移动失败都会逆序回滚已移动部分。 */
export async function migrateDataFolder(app: App, plan: LibraryMigrationPlan): Promise<LibraryMigrationResult> {
	const result: LibraryMigrationResult = { plan, moved: [], removedEmpty: [], rollbackFailures: [] };
	if (plan.collisions.length) {
		result.error = `目标位置已有 ${plan.collisions.length} 个同名文件`;
		return result;
	}
	if (!plan.moves.length) {
		// 文件可能在上一次迁移中已经搬完，只剩旧版留下的空目录骨架。即使没有 move，
		// 也要执行一次清理；否则用户会一直看到 `Progress/`、`Presets/` 等空壳。
		result.removedEmpty = await removeEmptyFolders(app, plan.from, !plan.keepSourceRoot);
		return result;
	}

	try {
		for (const move of plan.moves) {
			const source = app.vault.getAbstractFileByPath(move.from);
			if (!(source instanceof TFile)) throw new Error(`源文件不存在：${move.from}`);
			if (app.vault.getAbstractFileByPath(move.to)) throw new Error(`目标文件已存在：${move.to}`);
			await ensureFolder(app, move.to.slice(0, move.to.lastIndexOf("/")));
			await app.vault.rename(source, move.to);
			result.moved.push(move);
		}
	} catch (error) {
		// 失败时旧目录里其实已经空了，先回滚文件再谈删壳 —— 顺序反了会把刚回滚的文件连目录一起删掉。
		result.rollbackFailures = await rollbackMoves(app, result.moved);
		if (result.rollbackFailures.length) {
			result.error = `迁移失败且部分文件未能回滚：${errorMessage(error)}`;
		} else {
			result.moved = [];
			result.error = `迁移失败，已回滚：${errorMessage(error)}`;
		}
		return result;
	}

	result.removedEmpty = await removeEmptyFolders(app, plan.from, !plan.keepSourceRoot);
	return result;
}
