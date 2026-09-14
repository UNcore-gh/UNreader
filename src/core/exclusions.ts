/**
 * 把插件内部数据目录登记进 Obsidian 的「排除文件」（配置键 `userIgnoreFilters`）。
 *
 * ## 为什么走这条路径，而不是把目录改名成 `.unreader`
 *
 * 点前缀目录是 Obsidian 里唯一「真隐藏」的手段（完全不进索引、文件树里不存在），但
 * **Obsidian Sync 会整体跳过点前缀目录** —— 官方帮助「同步设置与选择性同步」明写：
 * 「以 `.` 开头的文件夹被视为隐藏文件夹、不会被同步，唯一例外是配置文件夹」。而本插件
 * 这四份数据都必须跨端：字体、预设、进度、标注都是「他端同步到达即生效」的设计（见
 * `paths.ts` 与 `presetStore.ts` / `progressStore.ts` 的文件头注释）。用户用哪种同步并不
 * 确定（iCloud / Syncthing / Obsidian Sync 都有，且在插件侧无法区分），而点目录在
 * Obsidian Sync 下是**静默丢数据**：桌面读一天，手机打开进度还停在三天前，且不报任何错。
 *
 * 「排除文件」是唯一同时满足「不改路径（同步不受影响）+ 不写存储层（`getFiles()` 照常
 * 返回这些文件）+ 从搜索/图谱/快速切换里摘掉」的手段。**代价是它不隐藏文件树** ——
 * 官方那项设置的说明只承诺「隐藏于搜索、在快速切换里不那么显眼」，所以目录仍会列在文件
 * 树里。本模块的目标是消掉噪音，不是让文件夹消失。
 *
 * ## 条目形态：**必须带尾斜杠**
 *
 * 官方对条目的解释是：全 `/…/` 形态按正则处理，**其余一切**都变成
 * `new RegExp("^" + escapeRegExp(串), "i")` —— 也就是**前缀匹配，没有 glob**。所以
 * `UNreader/Progress`（无斜杠）会顺带命中用户自己的 `UNreader/Progress-old`；带上尾斜杠
 * 才精确，而且这正是官方 UI 自己写出来的形态（文件夹自动补全那条存的是 `item.path + "/"`）。
 * 判据只被传入**文件**路径，`UNreader/Progress/x.json` 照样被 `^UNreader/Progress/` 命中。
 *
 * ## 只增不覆盖，摘除要分清「谁登记的」
 *
 * 用户本来就可能有一批自己的排除项，所以写入一律是「保留他人条目 + 追加我们的」，
 * 绝不整体覆盖。摘除分两条路，口径故意不同：
 *
 * - `syncVaultExclusions`（开关的**目标态**）：按值比对，把「我们管的但这会儿不想要的」
 *   摘掉。这里按值是可以的 —— 开关的语义就是「这条路径不该被排除」，用户自己加过同一条
 *   时，摘掉它也符合开关的字面承诺。
 * - `clearVaultExclusions`（插件失活）：**只摘本次会话真正由我们插入的那几条**
 *   （`inserted`）。用户手动排除过 `UNreader/Notes` 是完全可能的（那正是他自己的标注目录），
 *   失活时把它一并删掉就越界了。代价：换设备/跨会话时 `inserted` 是空的 → 那台设备上不摘，
 *   条目留下。**失败方向指向安全侧**（多一条排除项是观感问题，删用户条目是破坏性问题），
 *   而下一次 `onload` 的 `syncVaultExclusions` 会按目标态把它收敛回去。
 *
 * ## 幂等是硬要求，不是优化
 *
 * 官方 `setConfig` 用**引用比较**决定是否落盘并派发 `config-changed`；派发出去的下游里
 * 有 SearchView —— 它会**清空用户正在输入的查询并重跑**。所以没有内容比对的话，每次启动
 * 都会写一次 `app.json` + 打断一次搜索。`sameList` 就是为这条存在的。
 *
 * `UNreader/Books` **刻意不在列**：书是用户的资产，要靠快速切换找得到。
 */
import { App } from "obsidian";
import * as debugLog from "./debugLog";
import { FONTS_FOLDER, NOTES_FOLDER, PRESETS_FOLDER, PROGRESS_FOLDER } from "./paths";

const CONFIG_KEY = "userIgnoreFilters";

/** `vault.getConfig/setConfig` 未进公开类型库、运行时可用（读的先例见
 *  `main.ts` 里的 `userIgnoreFilters` 读法，同样是受控断言 + try）。 */
interface ConfigHost {
	getConfig?: (key: string) => unknown
	setConfig?: (key: string, value: unknown) => void
}

/** 本次会话中真正由我们插入的条目（onload 必先于 onunload，无需持久化） */
const inserted = new Set<string>();

/** 拿不到配置宿主就整体静默降级：排除项纯粹是观感优化，不该因为官方改内部结构而报错 */
function configHost(app: App): ConfigHost | null {
	try {
		const v = app.vault as unknown as ConfigHost;
		return typeof v.getConfig === "function" && typeof v.setConfig === "function" ? v : null;
	} catch {
		return null;
	}
}

/** 由本模块负责登记/摘除的条目。`includeNotes=false` 时不登记 Notes，但**判定「是不是我们
 *  管的」时永远把它算在内** —— 否则用户关掉开关后，旧条目会永远留在自己的配置里。 */
function managed(includeNotes: boolean): string[] {
	const list = [PROGRESS_FOLDER, PRESETS_FOLDER, FONTS_FOLDER];
	if (includeNotes) list.push(NOTES_FOLDER);
	return list.map(p => `${p}/`);
}

/** 比较用：去尾斜杠 + 小写（官方匹配本身大小写不敏感） */
function normKey(s: string): string {
	return s.replace(/\/+$/, "").toLowerCase();
}

function readFilters(host: ConfigHost): string[] {
	try {
		const raw = host.getConfig?.(CONFIG_KEY);
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function sameList(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 把当前的开关状态同步到 Obsidian 配置里。幂等：没变化就不写，避免 `config-changed` 抖动。
 *
 *  `kept` 的写法有两个坑，改之前先读完：
 *  ① **不能把「我们管的」整批剥掉再重加**（初版就是这么写的）：剥掉后 `toAdd` 又因为
 *     「这些键已在 current 里」被跳过，结果 `next` 变成空数组 —— 每次同步都在**删掉**
 *     自己的条目，且永不收敛。
 *  ② **用户已有的等价形态要原样保留、不要改成我们的形态**：用户手动排除过
 *     `UNreader/Notes`（无尾斜杠）完全可能，若把它规范化成 `UNreader/Notes/` 再写回，
 *     就等于我们「插入了」它 → 失活时会被 `clearVaultExclusions` 当成自己的删掉。
 *     所以判定「目标态还需要它」时按规范化比较，但**保留原串**。 */
export async function syncVaultExclusions(app: App, opts: { includeNotes: boolean }): Promise<void> {
	const host = configHost(app);
	if (!host) return;
	try {
		const current = readFilters(host);
		const ours = new Set(managed(true).map(normKey));
		const wanted = managed(opts.includeNotes);
		const wantedKeys = new Set(wanted.map(normKey));
		// 用户自己的条目一律保留；我们管的那些只在目标态仍需要时保留（原串不动）
		const kept = current.filter(p => {
			const k = normKey(p);
			return ours.has(k) ? wantedKeys.has(k) : true;
		});
		const haveKeys = new Set(kept.map(normKey));
		const toAdd = wanted.filter(p => !haveKeys.has(normKey(p)));
		const next = [...kept, ...toAdd];
		if (sameList(current, next)) return;
		for (const p of toAdd) inserted.add(p);
		await Promise.resolve(host.setConfig?.(CONFIG_KEY, next));
	} catch (e) {
		debugLog.warn("[exclusions] 写入排除项失败", e);
	}
}

/** 插件失活时摘掉**本次会话由我们插入的**条目（用户自己的原样保留，见文件头） */
export function clearVaultExclusions(app: App): void {
	const host = configHost(app);
	if (!host) return;
	try {
		if (inserted.size === 0) return;
		const current = readFilters(host);
		const next = current.filter(p => !inserted.has(p));
		inserted.clear();
		if (next.length === current.length) return;
		void Promise.resolve(host.setConfig?.(CONFIG_KEY, next));
	} catch { /* ignore */ }
}
