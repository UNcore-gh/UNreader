/**
 * 库内固定目录的**找回**：常量路径缺失、或只剩一个空壳时，把插件自己的数据搬回来。
 *
 * ## 为什么需要它（而不是「不存在就建一个」）
 *
 * 原先 `main.ts` 的 `ensureLibraryFolders` 是「不存在就 `vault.createFolder`」。一旦用户或
 * 同步客户端把 `UNreader/` 改名成 `UNreader 2/`，插件就会按常量重建一个**空**的
 * `UNreader/Data/…` 骨架，于是进度库、预设库、旁车笔记全部读到空 —— 用户看到的是
 * 「我的阅读进度 / 预设 / 高亮全没了」（书其实还能读，因为书籍不限位置，见
 * `bookService.getBookFiles`）。这是**静默**灾难：用户不会想到只是文件夹换了个名字。
 *
 * 判据因此从「目录在不在」换成「**我们的数据在不在**」，再把内部数据搬回来。这与
 * `nativeNavGuard`「不管谁摘的类，我按目标态补回」是同一个设计姿态：**不猜是谁改的，
 * 只按目标态修复**。
 *
 * ## 三个已经踩过的坑（改本文件前必须读完，每一条都对应一条断言）
 *
 * ### ① 健康判据不能只看「目录里有没有东西」
 *
 * `ensureLibraryFolders` 会凭空建出 `UNreader/Data/` + 六个数据子目录。初版把
 * 「常量路径下存在 `Books|Fonts|Presets|Progress|Notes` 之一」当健康判据，于是**空壳自己
 * 就带着两个证据，heal 每次启动都在第一行早退，用户的进度/预设/高亮永久搁浅**。
 * 而且这个空壳一定会落盘：`refreshCustomFonts`（`onLayoutReady` 后）会调
 * `ensureLibraryFolders`，与 heal 抢同一段时间。
 *
 * 所以：**证据必须是内容级的，且不设「健康就整段跳过」的早退** —— 改成「候选里缺哪个
 * 子目录就搬哪个」，天然收敛、天然幂等。
 *
 * ### ② 候选判据太宽会把用户的目录搬走
 *
 * 「名字以小写 `unreader` 开头且不全等」会命中 `UNreader-notes`、`unreader-old`、
 * `UNreader 副本`。若再只看子目录**名字**，用户那个 `UNreader-notes/Notes/`（他自己的
 * 笔记目录，这名字完全可能）就会被判成我们的、**被 `vault.rename` 改名成 `UNreader`**
 * —— 用户数据被搬走且插件命名空间被占，是不可逆的用户可见事故。
 *
 * 所以：候选必须**内容级**命中（见 `hasOurContent`）；只看得到目录名的空壳
 * （`Books`/`Fonts` 空文件夹）不构成任何证据。
 *
 * ### ③ 并列即放弃，不要赌
 *
 * 两个候选都像我们的时，按名字排序取一个是**在赌**。并列意味着我们不知道哪个对，
 * 那就不要动手（记日志 + 提示用户自己看）。
 *
 * ## 只搬内部数据，**永不搬 Books**
 *
 * 书放在库里任何位置都能读（`bookService.getBookFiles` 不按文件夹过滤），而进度文件名是
 * **书籍完整路径**的 djb2 hash（`progressStore.fileNameFor`）—— **移动一本书 = 视为新书 =
 * 进度归零**，这条隐性契约是仓库明写在案的（`AGENTS.md` 的「库内路径已收敛为常量」条 ③）。
 * 所以自愈绝不碰用户的书籍文件：它只把**插件自己的**数据搬回约定位置。
 *
 * 代价说清楚：如果用户是「刚改名、还没继续读」就撞上自愈，那批进度键仍是旧路径、依旧对不上
 * （与**不装自愈时的结果完全相同**，不是新增的损失）；而只要用户在改名期间读过，他的最新
 * 位置就是按当前书路径存的，自愈反而让它重新可见。要彻底消掉这个歧义只能换身份键（按书籍
 * 内容 hash 而非路径），代价见 `AGENTS.md` 同一处提到的「身份键」方案评估，不在本轮范围。
 *
 * ## 跨端同步的终态（不是 bug，但必须告知用户）
 *
 * A 端搬回 `UNreader` 后，B 端（尚未启动/尚未升级）的 `UNreader 2/` 会作为新文件同步回来
 * → 两处都有数据 → 下一次 A 端启动时目标已有数据、只搬缺的那些 → **停在「重复目录 + 数据
 * 可能分裂在两处」的终态**。因为只 rename 不删，**不丢数据，但会分裂**，所以 Notice 会
 * 明确提示「若发现旧的 `UNreader xxx` 残留，请手动合并」。不引入「N 天内不重复搬」的冷却：
 * 那会让真实的二次事故失去自愈。
 *
 * ## 安全边界
 *
 * - **只动库根的直接子目录**，不做递归查找 —— 藏在深层的 `UNreader` 更可能是用户自己的东西。
 * - **只 `rename`，绝不删除、绝不覆盖**：目标已有同名子目录就跳过并记日志（歧义时不动手）。
 * - 全程 try/catch，失败**静默降级**回「建空目录」的旧行为，绝不阻断插件加载。
 *
 * ## 调用时机（两条硬约束，改调用点前先读）
 *
 * 1. 必须**排在进度库/预设库读盘之前**（`main.ts` 的 `dataReady` 链首）：否则两份存储已经
 *    按空目录读完，搬回来也白搭 —— 本会话的内存缓存仍然是空的。
 * 2. 必须**排在布局就绪之后**才真的写库：启动瞬间的库事件会把移动端官方文件列表的条目
 *    永久打成 `hidden`，理由见 `main.ts` 里 `refreshCustomFonts` 那段注释与 `explorerHeal.ts`。
 *
 * 另外 `ensureLibraryFolders` 必须 `await` 本模块的 promise（`main.ts` 用 `libraryHeal`
 * 字段串链）：否则它会抢在 heal 之前把空壳建出来，候选里的 `Fonts` 就会因为「目标已有同名
 * 子目录」被跳过而永久留在原地。
 *
 * 数据齐全时本函数是**纯读**的（库根没有像被改名的兄弟目录就返回），零写入。
 */
import { App, Notice, TFolder } from "obsidian";
import * as debugLog from "./debugLog";
import { BOOKS_DIR_NAME, DATA_DIR_NAME, DEFAULT_ROOT, FEEDS_FOLDER, FONTS_FOLDER, IMAGES_FOLDER, NOTES_FOLDER, PRESETS_FOLDER, PROGRESS_FOLDER, RESOURCES_FOLDER, UNREADER_ROOT } from "./paths";

/** 子目录**名字**（相对 `UNREADER_ROOT`）。paths 里是完整路径，这里只要末段 */
function nameOf(path: string): string {
	return path.split("/").pop() ?? path;
}

/** 「该搬什么」（旧版平铺布局下的子目录名）：只搬插件内部数据，**Books 刻意不在列**
 *  （理由见文件头）。每次调用读 `paths.ts` 的**活绑定** —— 数据根可配置（`setLibraryRoot`），
 *  在模块顶层缓存这份清单，换根之后就会拿着旧目录名去找。 */
function movableNames(): string[] {
	return [FONTS_FOLDER, PRESETS_FOLDER, PROGRESS_FOLDER, NOTES_FOLDER, RESOURCES_FOLDER, FEEDS_FOLDER].map(nameOf);
}

/** 进度文件名形如 `<书名清洗>-<djb2 8 位 hex>.json`（见 progressStore.fileNameFor） */
const PROGRESS_RE = /-[0-9a-f]{8}\.json$/i;
const BOOK_EXT = /\.(epub|mobi|azw3|txt|html?)$/i;
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

/** 名字像不像被改名后的我们：默认根下的 `UNreader 2` / `UNreader-1` / `unreader_backup`，
 *  用户自选根下的 `配置 2` / `配置-旧` —— 判据是**当前数据根的名字**，所以换根之后
 *  仍然成立（数据根可配置，见 core/paths.ts）。 */
function looksRenamed(name: string): boolean {
	const n = name.trim().toLowerCase();
	const base = (UNREADER_ROOT.split("/").pop() ?? "").trim().toLowerCase();
	if (!base) return false;
	return n !== base && n.startsWith(base);
}

/** 数据根的**父目录**（`UNreader` → 库根；`配置/阅读` → `配置`）。
 *  自愈只扫这一层：藏在更深处的同名目录更可能是用户自己的东西。 */
function parentPathOfRoot(): string {
	const slash = UNREADER_ROOT.lastIndexOf("/");
	return slash > 0 ? UNREADER_ROOT.slice(0, slash) : "";
}

async function listFiles(app: App, path: string): Promise<string[]> {
	try {
		const listed = await app.vault.adapter.list(path);
		return listed.files ?? [];
	} catch {
		return [];
	}
}

async function listFolders(app: App, path: string): Promise<string[]> {
	try {
		const listed = await app.vault.adapter.list(path);
		return listed.folders ?? [];
	} catch {
		return [];
	}
}

/**
 * 这个目录里**有没有我们的数据**。看内容、不看目录名 —— 理由见文件头 ②。
 *
 * 六个子目录任一命中即可：进度 JSON 的 hash 文件名、预设的 `preset.json`、旁车笔记的
 * `## 高亮`/`## 书签` 段、书籍扩展名、字体扩展名。这些都是插件自己产出的形态，
 * 用户碰巧撞上的概率极低，而「目录名恰好叫 Notes」的概率不低。
 */
async function hasOurContent(app: App, folder: TFolder): Promise<boolean> {
	// 新旧两种落点都查：`<候选>/Data/<子目录>`（现行）与 `<候选>/<子目录>`（旧版平铺）——
	// 改名事故可能发生在任一版本上，判据必须都认。
	return (await hasOurContentAt(app, folder.path))
		|| (await hasOurContentAt(app, `${folder.path}/${DATA_DIR_NAME}`));
}

/** 单个落点（`base`）下的内容判据。 */
async function hasOurContentAt(app: App, base: string): Promise<boolean> {
	const childNames = new Set<string>();
	for (const path of await listFolders(app, base)) childNames.add(nameOf(path));
	const has = (name: string): boolean => childNames.has(name);
	const at = (name: string): string => `${base}/${name}`;

	if (has(nameOf(PROGRESS_FOLDER))) {
		if ((await listFiles(app, at(nameOf(PROGRESS_FOLDER)))).some(f => PROGRESS_RE.test(f))) return true;
	}
	if (has(nameOf(PRESETS_FOLDER))) {
		const presetsDir = at(nameOf(PRESETS_FOLDER));
		for (const sub of await listFolders(app, presetsDir)) {
			if ((await listFiles(app, sub)).some(f => /\/preset\.json$/i.test(f))) return true;
		}
	}
	if (has(nameOf(NOTES_FOLDER))) {
		const notes = await listFiles(app, at(nameOf(NOTES_FOLDER)));
		// 只读前几份就够了：一本有标注的书就足以定性
		for (const f of notes.filter(x => /\.md$/i.test(x)).slice(0, 3)) {
			try {
				const raw = await app.vault.adapter.read(f);
				if (raw.includes("## 高亮") || raw.includes("## 书签")) return true;
			} catch { /* 单份读不到不影响判据 */ }
		}
	}
	if (has(BOOKS_DIR_NAME)) {
		if ((await listFiles(app, at(BOOKS_DIR_NAME))).some(f => BOOK_EXT.test(f))) return true;
	}
	if (has(nameOf(FONTS_FOLDER))) {
		if ((await listFiles(app, at(nameOf(FONTS_FOLDER)))).some(f => FONT_EXT.test(f))) return true;
	}
	if (has(nameOf(RESOURCES_FOLDER))) {
		const resourcesDir = at(nameOf(RESOURCES_FOLDER));
		if ((await listFiles(app, resourcesDir)).some(f => /\/resources\.json$/i.test(f))) return true;
		const imagesDir = `${resourcesDir}/${nameOf(IMAGES_FOLDER)}`;
		if ((await listFiles(app, imagesDir)).some(f => /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f))) return true;
	}
	if (has(nameOf(FEEDS_FOLDER))) {
		const files = await listFiles(app, at(nameOf(FEEDS_FOLDER)));
		if (files.some(f => /\/index\.json$/i.test(f) || /\/[0-9a-f-]+\.json$/i.test(f))) return true;
	}
	return false;
}

export interface LibraryHealResult {
	/** 真正被搬回的条目（`来源 → 目标`）；空数组 = 什么都没动 */
	recovered: string[]
}

/** 「自选数据根还空着，数据却留在默认根 `UNreader/`」时提醒用户。**只提示，不搬。**
 *
 *  触发场景：数据落点随 `data.json` 跨端同步，A 设备迁走了数据，B 设备还没迁 ——
 *  B 会按新根建一个空目录，用户看到的是「进度 / 预设 / 高亮全没了」。这与「数据真的
 *  没了」在界面上**完全无法区分**，所以必须有提示。
 *
 *  为什么不顺手搬过来：数据到底该去哪是用户的决定（设置页点「迁移并切换」才是明确
 *  授权），而且两个位置都可能有数据时搬错方向的代价不可逆。 */
async function warnIfDataLeftBehind(app: App): Promise<void> {
	// 默认根配置下**第一行就返回**：绝大多数会话走这条，必须保持纯读、零副作用。
	if (UNREADER_ROOT === DEFAULT_ROOT) return;
	const fallback = app.vault.getAbstractFileByPath(DEFAULT_ROOT);
	if (!(fallback instanceof TFolder)) return;
	const current = app.vault.getAbstractFileByPath(UNREADER_ROOT);
	if (current instanceof TFolder && (await hasOurContent(app, current))) return;
	if (!(await hasOurContent(app, fallback))) return;
	new Notice(`UNreader：数据文件夹「${UNREADER_ROOT}」里没有插件数据，而默认位置「${DEFAULT_ROOT}」里还有一份（可能是另一台设备迁移过、本机还没迁）。请到「设置 → UNreader → 数据 → 数据文件夹」重新选择并迁移，或把数据文件夹改回默认位置。`);
}

/** 检测并把被改名/挪走的插件数据搬回 `UNreader/`。数据齐全时是纯读，零写入。 */
export async function healLibraryFolders(app: App): Promise<LibraryHealResult> {
	const result: LibraryHealResult = { recovered: [] };
	try {
		// 只在数据根的**直接父目录**里找被改名的兄弟目录（默认根 = 库根，见 parentPathOfRoot）。
		// 数据根可以是用户自选的嵌套路径，所以父目录也要跟着算，不能写死 vault.getRoot()。
		const parentPath = parentPathOfRoot();
		const parent = parentPath ? app.vault.getAbstractFileByPath(parentPath) : app.vault.getRoot();
		if (!(parent instanceof TFolder)) return result;
		const target = parent.children.find(c => c.path === UNREADER_ROOT);
		const targetFolder = target instanceof TFolder ? target : null;

		// 只看名字够像的兄弟目录（廉价的同步预筛），再对它们做内容判定
		const suspects = parent.children.filter(
			(c): c is TFolder => c instanceof TFolder && looksRenamed(c.name),
		);

		const candidates: TFolder[] = [];
		for (const folder of suspects) {
			if (await hasOurContent(app, folder)) candidates.push(folder);
		}
		// **纯读路径**：没有任何「被改名的我们」→ 什么都不搬（绝大多数会话走这条；
		// `suspects` 为空时下面这个循环体一次都不执行，代价为零）。这里仍要处理另一种
		// 同样静默的事故：自选数据根空着、数据还留在默认根（见 warnIfDataLeftBehind）。
		if (candidates.length === 0) {
			await warnIfDataLeftBehind(app);
			return result;
		}

		// **并列即放弃**（见文件头 ③）：两个都像，就说明我们不知道哪个对
		if (candidates.length > 1) {
			const names = candidates.map(c => c.path).join(", ");
			debugLog.warn("[libraryFolders] 有多个目录都含我们的数据，无法判断哪个是对的，不搬:", names);
			new Notice(`UNreader：库里有多个像插件数据目录的文件夹（${names}），为避免搬错，请手动确认保留哪个。`);
			return result;
		}

		const source = candidates[0]!;
		const flexible = movableNames();
		const movable: TFolder[] = [];
		let dataChild: TFolder | null = null;
		for (const child of source.children) {
			if (!(child instanceof TFolder)) continue;
			if (child.name === DATA_DIR_NAME) {
				// `Data` 这名字太泛化：必须是**内容级**确认才搬（用户自己的 `Data/` 不许碰）
				if (await hasOurContentAt(app, child.path)) dataChild = child;
				continue;
			}
			if (flexible.includes(child.name)) movable.push(child);
		}
		if (movable.length === 0 && !dataChild) return result;

		if (!targetFolder) {
			try { await app.vault.createFolder(UNREADER_ROOT); } catch { /* 并发下已存在 */ }
		}

		const targetData = `${UNREADER_ROOT}/${DATA_DIR_NAME}`;
		const skipped: string[] = [];
		// 现行布局被改名时内容全在整棵 `Data/` 里 —— 先把它整体搬回（目标已有 `Data/`
		// 就整个跳过，两份不合并）。
		if (dataChild) {
			if (await app.vault.adapter.exists(targetData)) {
				skipped.push(DATA_DIR_NAME);
			} else {
				await app.vault.rename(dataChild, targetData);
				result.recovered.push(`${dataChild.path} → ${targetData}`);
			}
		}
		// 旧版平铺的子目录逐个收进 `Data/`；目标已有同名子目录就跳过（两份来源不明的数据不合并）。
		if (movable.length > 0) {
			try { await app.vault.createFolder(targetData); } catch { /* 已存在（或并发） */ }
		}
		for (const child of movable) {
			const dest = `${targetData}/${child.name}`;
			if (await app.vault.adapter.exists(dest)) { skipped.push(child.name); continue; }
			// **必须用 `vault.rename` 而不是 `adapter.rename`** —— 后者只在文件系统层落位、
			// 靠官方 watcher 异步补登记，而紧随其后的 `ProgressStore.init` 走
			// `getAbstractFileByPath` 查的是**索引**，会当场读到 null（同一个坑见
			// `fontService.importFontFile` 那段「必须用 createBinary」的注释）。
			await app.vault.rename(child, dest);
			result.recovered.push(`${child.path} → ${dest}`);
		}

		if (result.recovered.length > 0) {
			debugLog.info("[libraryFolders] 已找回被移动的插件数据:", result.recovered.join("；"));
			const rest = skipped.length > 0
				? `；${skipped.join(" / ")} 因目标已有同名目录未动，请手动比对`
				: "";
			new Notice(`UNreader：已从「${source.path}」找回被移动的数据文件夹，阅读进度与标注恢复正常。若发现该目录仍有残留，说明其它设备也在同步，请手动合并后再删${rest}`);
		}
	} catch (e) {
		// 静默降级：绝不因为「找不回来」而阻断加载，退回「建空目录」的旧行为
		debugLog.error("[libraryFolders] 找回插件数据失败", e);
	}
	return result;
}
