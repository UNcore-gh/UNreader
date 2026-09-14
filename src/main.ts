import { Plugin, TFile, Notice, FuzzySuggestModal, WorkspaceLeaf, Platform } from "obsidian";
import { DEFAULT_SETTINGS, DEFAULT_APPEARANCE, UNreaderSettings, AppearanceSettings, BookPosition, CustomFont, activeTheme, adoptLegacyAppearance } from "./types";
import { UNreaderSettingTab } from "./settings";
import { getBookFiles } from "./core/bookService";
import { ProgressStore } from "./core/progressStore";
import { PresetStore } from "./core/presetStore";
import { scanCustomFonts, fontToBlobUrl } from "./core/fontService";
import { UNREADER_ROOT, BOOKS_FOLDER, FONTS_FOLDER, PRESETS_FOLDER, PROGRESS_FOLDER } from "./core/paths";
import { healLibraryFolders } from "./core/libraryFolders";
import { syncVaultExclusions, clearVaultExclusions } from "./core/exclusions";
import * as debugLog from "./core/debugLog";
import { saveDebugReportToVault, writeReport } from "./core/debugReport";
import { setCustomFonts, clearCustomFonts } from "./core/engineAdapter";
import { VIEW_TYPE_UNREADER, UNreaderView, ReaderSelectionInfo } from "./ui/readerView";
import { collectNeighborFacts } from "./ui/explorerDiag";
import { ExplorerHeal } from "./ui/explorerHeal";

/** 等「首屏绘制之后的第一个空闲期」。
 *
 *  为什么不能直接用 `setTimeout(0)`：HTML 规范把**嵌套深度 > 5** 的 setTimeout
 *  钳到最小 4ms，而且它在**本帧绘制之前**就返回 —— 等于没让路。移动端这个窗口
 *  正是 I/O 与首屏渲染抢资源的时候。
 *
 *  `requestIdleCallback` 在旧 WebKit（iOS < 15 的 WKWebView）不存在，回落
 *  「下一帧 + 一个宏任务」，语义同样是「本帧已绘制完」。`timeout` 是安全阀：
 *  设备若一直忙，最迟 1s 也要放行，不能让数据链被无限期押后。 */
function yieldToFirstIdle(): Promise<void> {
	return new Promise<void>(resolve => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolve();
		};
		// **硬兜底是必须的**（2026-09-14 补）：让路是「尽量等首屏」，不是「必须等首屏」。
		// 上一版只给 `requestIdleCallback` 带了 timeout，rAF 回落分支**没有任何兜底** ——
		// 而 `requestAnimationFrame` 在页面不可见时**根本不触发**：启动瞬间 WebView
		// 尚未上屏、或从后台恢复、或被浏览器节流时，这条 Promise 永不兑现 ⇒ `dataReady`
		// 永不 resolve ⇒ 进度与预设永远加载不出来（开书会一直挂在 whenDataReady 上）。
		// 定时器只有 300ms：让路的最大代价必须远小于它要避开的那批 I/O。
		window.setTimeout(finish, 300);
		try {
			const ric = (window as Window & {
				requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
			}).requestIdleCallback;
			if (typeof ric === "function") {
				ric.call(window, finish, { timeout: 250 });
				return;
			}
		} catch { /* 回落 */ }
		try {
			window.requestAnimationFrame(() => window.setTimeout(finish, 0));
		} catch {
			finish();
		}
	});
}

export default class UNreaderPlugin extends Plugin {
	settings!: UNreaderSettings;
	/** 阅读进度库：每书一个小 JSON 文件（UNreader/Progress/），随库同步到各端 */
	progress!: ProgressStore;
	/** 外观预设库：每个预设一个文件夹（UNreader/Presets/<名>/），随库同步到各端 */
	presetStore!: PresetStore;
	/** 目录找回（core/libraryFolders）的结果。**必须被 `ensureLibraryFolders` await**：
	 *  它是「不存在就建空目录」的那一半，会与找回抢着创建 `UNreader/`，一旦空壳先落盘，
	 *  候选里的 `Fonts` 就会因为「目标已有同名子目录」被跳过而永久留在原地。 */
	private libraryHeal: Promise<unknown> = Promise.resolve();

	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private saving = false;
	/** 字体 blob 缓存：路径 → (mtime, size, blob URL, format)，避免每次开书重读字体文件 */
	private fontBlobCache = new Map<string, { mtime: number; size: number; uri: string; format: string }>();
	private fontRegistrySig = "";
	/** 最近一轮真正建出 blob 的字体 id：供「选中字体后确认它已就绪」判断（见 hasFontBlob） */
	private fontBlobbedIds = new Set<string>();
	/** 进行中的字体刷新（单飞行去重，见 refreshCustomFonts） */
	private fontRefreshInFlight: Promise<CustomFont[]> | null = null;
	// 最近一次存活的阅读视图：阅读器为 iframe 架构，焦点进入书页后
	// Obsidian 的 getActiveViewOfType 可能解析不到活动视图（表现为命令面板
	// 首次回车不执行、点过书页后又失效），用自跟踪视图做兜底
	private lastReader: UNreaderView | null = null;
	/** 进度库 / 预设库的就绪 Promise。
	 *
	 *  onload 里**同步发起**这两库的初始化、不等它们落盘（见 onload 注释），
	 *  凡需要这两份数据的调用点 await 本 Promise 即可 —— 时序语义与原先
	 *  「onload 内 await 完再往下走」完全一致，区别只是不再把「插件启用」
	 *  这个承诺压在一次串行的磁盘列目录 + 二十来次文件读取上。 */
	private dataReady: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		// 过滤 foliate 预期警告：sandbox 与 blob: CSP 拦截不影响阅读，仅刷屏
		//
		// ⚠️ **代理 console 绝不能抛异常**（2026-09-13 加固）：下面这些过滤器要先把
		// `args` 拼成一行文本，而 `String(a)` 对某些实参是会抛的 —— 例如**已销毁 iframe 的
		// 节点/窗口**（移动端帧被回收时很常见）、带抛错 getter 的对象、Proxy 的
		// `Symbol.toPrimitive`。一旦在这里抛，异常会沿着**调用方**的栈抛出去 —— 调用方
		// 往往是 Obsidian 自己的代码（它在渲染途中打一条 warn），于是那条渲染路径**中途
		// 中断**：症状就是「只有装了本插件才坏、只坏某一个界面」这种极难归因的故障。
		// 所以：字符串化逐步兜底，整段过滤+桥接包在 try 里，任何意外都只是**少做一次过滤**，
		// 原始日志照旧原样打印（绝不错吞真实错误）。
		const safeMsg = (args: unknown[]): string => {
			try {
				return args.map(a => { try { return String(a) } catch { return "[unprintable]" } }).join(" ")
			} catch {
				return ""
			}
		};
		const _warn = console.warn.bind(console);
		const _error = console.error.bind(console);
		/** 按级别过滤 + 桥接诊断缓冲；**任何路径都不向外抛**。 */
		const makeProxy = (orig: (...a: unknown[]) => void, level: "warn" | "error") =>
			(...args: unknown[]): void => {
				try {
					const msg = safeMsg(args);
					if (level === "warn") {
						if (msg.includes("allow-scripts and allow-same-origin")) return;
						if (msg.includes("blob:app://obsidian.md") && msg.includes("violates")) return;
						if (msg.includes("Loading the stylesheet") && msg.includes("blob:")) return;
					} else {
						// 过滤 foliate iframe/CSP 的 console.error 刷屏，保留真实错误
						if (msg.includes("blob:app://obsidian.md") && msg.includes("style-src")) return;
					}
					// 桥接诊断缓冲（仅调试开关开启时落缓冲）：本插件自身的日志进导出报告，
					// 用户复现问题后直接导出，不必开 devtools 挂着等
					if (msg.includes("[UNreader]")) debugLog.appendConsole(level, msg);
				} catch { /* 过滤/桥接出事绝不吞掉原始日志 */ }
				orig(...args);
			};
		console.warn = makeProxy(_warn, "warn");
		console.error = makeProxy(_error, "error");

		await this.loadSettingsData();

		// 诊断日志（src/core/debugLog.ts）：设置开关关闭时零捕获零存储；
		// 环境快照喂进开启记录与导出报告（版本/平台/关键设置）
		debugLog.setEnvProvider(() => this.collectLogEnv());
		debugLog.setDebugEnabled(this.settings.debugLog);

		// 全局错误捕获钩子（仅调试开关开启时落缓冲，不改动控制台行为）：
		// window error 与未处理的 promise rejection 都进报告，用户不用开
		// devtools 也能把现场发给开发者
		// **归因 + 降噪（2026-09-14）**：老实现把**任意** rejection 都打上
		// `[UNreader]` 前缀，于是 Obsidian 核心 / 别的插件抛的错在报告里看起来
		// 像本插件的故障；而且 debugLog.append 只做「连续重复」判定，中间夹进
		// 任何别的日志（本插件每帧都有生命周期日志）去重就失效，同一条实测刷了
		// 4~5 遍。现在：① 已知的库外噪音直接静音；② 其余按栈归因；③ 同一现场只报一次。
		//
		// 已知噪音：Obsidian 的 create/delete 路径先用 `adapter.write` 直接落盘
		// （绕过 Vault 索引），file-explorer 偶尔在索引收录完成前就处理删除，
		// 于是在 **app.js 深处**抛
		// `TypeError: Cannot read properties of null (reading 'children')`。
		// 同一个现场 UNmemos 早已定位并静音（见 UNmemos/src/ui/editor-graft.ts
		// 的 quietRemove 注释）。**第三条判据是关键**：栈里不得有任何本插件的帧，
		// 否则本插件自己的空引用错误会被一起吞掉（宁可误报，不可漏报）。
		const isExternalNoise = (reason: unknown): boolean => {
			if (!(reason instanceof TypeError)) return false;
			if (!String(reason.message ?? "").includes("children")) return false;
			const stack = String((reason as Error).stack ?? "").toLowerCase();
			return !stack.includes("plugin:unreader");
		};
		/** 同一现场（message + 栈首帧）只进缓冲一次 */
		const seenReasons = new Set<string>();
		const reportOnce = (level: "warn" | "error", reason: unknown): void => {
			if (!debugLog.isDebugEnabled()) return;
			const stack = String((reason as Error)?.stack ?? "");
			const key = `${reason instanceof Error ? reason.message : String(reason)}|${stack.split("\n")[1] ?? ""}`;
			if (seenReasons.has(key)) return;
			seenReasons.add(key);
			// **归因**：栈里没有本插件的帧 → 来源是 Obsidian 核心或别的插件。
			// 省掉这一步，报告里就只剩 `[UNreader]` 前缀，读起来像本插件的 bug。
			const ours = stack.toLowerCase().includes("plugin:unreader");
			const label = level === "warn"
				? (ours ? "[unhandled rejection · 本插件]" : "[unhandled rejection · 外部来源]")
				: (ours ? "[window error · 本插件]" : "[window error · 外部来源]");
			if (level === "warn") debugLog.warn(label, reason);
			else debugLog.error(label, reason);
		};
		const captureError = (ev: ErrorEvent): void => {
			const reason = ev.error ?? ev.message;
			if (isExternalNoise(reason)) return; // 已知库外噪音：不刷控制台，也不进报告
			reportOnce("error", reason);
		};
		window.addEventListener("error", captureError);
		this.register(() => window.removeEventListener("error", captureError));
		const captureRejection = (ev: PromiseRejectionEvent): void => {
			if (isExternalNoise(ev.reason)) return; // 同上
			reportOnce("warn", ev.reason);
		};
		window.addEventListener("unhandledrejection", captureRejection);
		this.register(() => window.removeEventListener("unhandledrejection", captureRejection));

		// 阅读进度库：加载库内进度文件（开书取位置需要），并把旧 data.json positions 迁移为文件
		this.progress = new ProgressStore(this.app.vault, PROGRESS_FOLDER, this.deviceScope());

		// 外观预设库：从库内预设文件夹加载
		this.presetStore = new PresetStore(this.app.vault, PRESETS_FOLDER);

		// ⚠️ 这里**绝不能再 await**（2026-09-11 性能回归点）。
		// 进度库 + 预设库合计 20+ 次文件读取（实测本机：14 个进度文件 + 5 个预设），
		// 全部串行时插件启用耗时 ≈ 次数 × 单次读延迟。冷启动测量台实测（.perf/runner.cjs）：
		//   单次 I/O  5ms → onload 116ms ｜ 25ms → 523ms ｜ 60ms → 1228ms ｜ 120ms → 2433ms
		// 严格线性，说明这 500ms~2.4s 全部是「等磁盘」而非任何计算。桌面 SSD 上只有
		// 2.5ms（所以开发时看不出问题），移动端 iCloud / 网络盘才是真机受害者。
		// 改为「同步发起 + 暴露 dataReady」后，插件启用不再等磁盘，消费点
		// （readerView 开书取进度、外观面板列预设、预设重扫）各自 await whenDataReady()。
		//
		// 链首多了两步前置（目录找回 + 排除项同步），它们**不改变上面那条性能结论**：
		// 「不 await」约束的是 **onload 路径**，而链内 await 只推迟 dataReady 的兑现，
		// 不推迟插件启用。两步的顺序有硬约束：
		//   ① `healLibraryFolders` 必须排在两份存储读盘**之前** —— 目录若被改名搬走过，
		//      下面两个 init 会按空目录读完，搬回来也白搭（本会话缓存仍是空的）。
		//   ② 先等布局就绪再动目录/配置 —— 启动瞬间的库事件会把移动端官方文件列表的条目
		//      永久打成 `hidden`（理由见下方 onLayoutReady 那段与 explorerHeal.ts）。
		// 健康情况下 ① 是**纯读**、② 是幂等空写，两者都不产生库事件。
		this.dataReady = (async () => {
			// **启动分段计时（2026-09-14）**：安卓真机日志实测「插件 onload → `[progress] init`」
			// 之间有 **12.09s 的零记录窗口**，仅凭日志无法判断这段是「在等 Obsidian 布局就绪」
			// 还是「本插件在干活」—— 而这两者的修法完全不同（前者要去查别的插件与库规模，
			// 后者才是本插件的锅）。逐段计时后用 `debugLog.info` 汇总成一条 `[startup]`：
			// 只进诊断缓冲，debug 开关关闭时零捕获零开销，也不往控制台刷噪音。
			const tStart = Date.now();
			await new Promise<void>(resolve => {
				try { this.app.workspace.onLayoutReady(() => resolve()); } catch { resolve(); }
			});
			const msLayout = Date.now() - tStart;
			// ①② 必须各自兜住异常：它们是**前置步骤**，任何一步抛出都会顺带掐掉
			// 下面的两份存储读盘 —— 而进度库读空 = 每本书都从书首打开 + 首次 relocate
			// 把书首写回进度文件（= 永久性丢进度）。这两步失败（rename 被拒、用户
			// 的 .obsidian 配置只读）远不该有这种后果。
			let msHeal = -1;
			try {
				const t = Date.now();
				this.libraryHeal = healLibraryFolders(this.app);
				await this.libraryHeal;
				msHeal = Date.now() - t;
			} catch (e) {
				console.warn("[UNreader] 库内目录找回失败（继续读存储）", e);
			}
			let msExcl = -1;
			try {
				const t = Date.now();
				await syncVaultExclusions(this.app, { includeNotes: this.settings.excludeNotesFromSearch !== false });
				msExcl = Date.now() - t;
			} catch (e) {
				console.warn("[UNreader] 排除项同步失败", e);
			}
			// **首屏让路（2026-09-14 移动端启动专项）**
			//
			// 下面这一轮是启动路径上**唯一**成规模的 I/O：读全部进度文件（本机 14 个）
			// + 全部预设（5 个），而它紧贴在 `onLayoutReady` 之后落地，正好压着首屏绘制窗口。
			// `.perf/runner.cjs` 的延迟档实测（模拟移动端单次读延迟）：
			//   latency 0   → layout 同步段 0.11ms，异步续体 +0.7ms，端到端 3.0ms
			//   latency 60  → layout 同步段 0.13ms，异步续体 +62ms，端到端 125ms
			//   latency 120 → layout 同步段 0.13ms，异步续体 +122ms，端到端 245ms
			// 同步段恒定（布局回调本身不干活），**放大全在异步续体上，随单次 I/O 延迟线性**。
			// 真机更糟：这些文件在库内（`libraryRoot` 是可配的库内路径），iCloud / 网络盘上
			// 未下载的文件每次读都要现拉，不只是「延迟几十毫秒」。
			//
			// 只挪时序、不动语义：数据来源、链内先后顺序、`whenDataReady()` 的门闩语义
			// 一字未改 —— 消费点（开书取进度、外观面板列预设）照旧 await 同一个 Promise，
			// 变的只是「这批盘不再由首屏承担」。
			const tIdle = Date.now();
			await yieldToFirstIdle();
			const msIdle = Date.now() - tIdle;
			const tRead = Date.now();
			await Promise.all([
				this.progress.init(this.settings.positions).then(n => {
					// **迁移完就清空旧字段**（2026-09-13）：留着它，他端只要把旧 values 的
					// updatedAt 推得更新，**每次插件加载都会把这批进度文件重写一遍** ——
					// 手机端启动瞬间一次写 11 个文件，正好撞上官方文件列表虚拟化最脆弱的窗口
					// （用户报的「只有 UNreader 文件夹的内容不显示」就是这个触发源）。
					// 返回 0 说明本次没迁移（字段无需动，避免每次加载都写 data.json）。
					if (n > 0) {
						this.settings.positions = {};
						this.scheduleSave();
					}
				}).catch(e => {
					console.warn("[UNreader] 进度库初始化失败", e);
				}),
				this.presetStore.init(this.settings.appearancePresets).catch(e => {
					console.warn("[UNreader] 预设库初始化失败", e);
				}),
			]);
			// 一条汇总，直接回答「那 12s 到底花在哪一段」：
			// `layout` = 等 Obsidian 布局就绪（本插件控制不了，时序约束见 explorerHeal.ts）；
			// `heal` / `excl` / `idle` / `read` = 本插件的四段。哪段大，锅就在哪。
			// -1 表示该段抛异常被 catch 了（消息里另有一条 warn）。
			debugLog.info(
				`[startup] layout=${msLayout}ms heal=${msHeal}ms excl=${msExcl}ms idle=${msIdle}ms read=${Date.now() - tRead}ms`,
			);
		})().catch(e => {
			console.warn("[UNreader] 数据就绪链失败", e);
		});

		// 预设内容随库同步（各端共享同一批预设）；启用状态在本机 localStorage 不同步。
		// 同步是异步的：预设文件在插件启动后才到达 → 监听 vault 事件重扫，保证他端
		// 新增/修改/删除的预设即时出现在面板里（去抖，本机未落盘写回不会被覆盖）
		{
			const presetDir = PRESETS_FOLDER;
			let rescanTimer: number | null = null;
			const scheduleRescan = (): void => {
				if (rescanTimer) window.clearTimeout(rescanTimer);
				rescanTimer = window.setTimeout(() => {
					rescanTimer = null;
					// 排在 init 的首次 reload 之后：init 内部先 cache.clear() 再写回，
					// 与事件重扫并发时，事件那份「更靠后的快照」有被旧快照反超的风险
					void this.dataReady.then(() => this.presetStore.reload()).catch(() => {});
				}, 800);
			};
			const underPresets = (path: string): boolean =>
				path === presetDir || path.startsWith(`${presetDir}/`);
			this.registerEvent(this.app.vault.on("create", f => { if (underPresets(f.path)) scheduleRescan(); }));
			this.registerEvent(this.app.vault.on("modify", f => { if (underPresets(f.path)) scheduleRescan(); }));
			this.registerEvent(this.app.vault.on("delete", f => { if (underPresets(f.path)) scheduleRescan(); }));
			this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
				if (underPresets(f.path) || underPresets(oldPath)) scheduleRescan();
			}));
		}

		// 启动时扫描自定义字体（字体文件随库同步到各端，每端独立内联为 data URI）。
		// **排在 `onLayoutReady` 之后**：本方法开头会 `ensureLibraryFolders()`（vault.createFolder
		// = 库事件），而移动端启动瞬间正是官方文件列表虚拟化测量最敏感的窗口 ——
		// 库事件会把 FileExplorerView 推进一次 `compute()`，若此时左抽屉还是
		// `display:none`（它创建时就是隐藏的），当趟测到的条目会被官方永久打上
		// `hidden`（详见 `src/ui/explorerHeal.ts` 的逐行取证）。挪到布局就绪后开跑。
		this.app.workspace.onLayoutReady(() => {
			void this.refreshCustomFonts().catch(e => console.warn("[UNreader] refresh custom fonts failed", e));
		});

		// 移动端文件列表自愈：官方移动端文件列表住在左抽屉里，而抽屉收起时
		// `display:none` → 虚拟化一旦在收起窗口里量过，条目就被永久 `hidden`
		// （「夹子在、内容不显示」）。本守卫在抽屉展开时补一次全量重测
		// —— 即官方「显示不支持的文件」开关内部做的动作。见 explorerHeal.ts。
		const explorerHeal = new ExplorerHeal(this.app, Platform);
		explorerHeal.start();
		this.register(() => explorerHeal.stop());

		// 注册原生 PagePreview hover 源，使批注块可通过原生弹窗预览/跳转（兼容旧版本 Obsidian/移动端）
		try {
			const ws = this.app.workspace as unknown as { registerHoverLinkSource?: (id: string, info: { display: string; defaultMod: boolean }) => { unregister: () => void } };
			if (ws.registerHoverLinkSource) {
				const h = ws.registerHoverLinkSource("unreader", { display: "UNreader 标注", defaultMod: true });
				if (h && typeof (h as unknown as { unregister?: () => void }).unregister === "function") {
					this.register(h as never);
				}
			}
		} catch { // ignore
		}

		// 逐个注册扩展名：批量 registerExtensions 在遇到已被占用的扩展名时会整体抛
		// "Attempting to register an existing file extension" 导致插件加载失败，
		// 逐项 try 可跳过被占用项、不影响其余扩展名（历史上 `pdf` 被 Obsidian 核心
		// 内置 PDF 查看器占用；现 PDF 已移除，保留该逐项机制作通用保护）。
		for (const ext of ["epub", "mobi", "azw3", "txt"]) {
			try {
				this.registerExtensions([ext], VIEW_TYPE_UNREADER);
			} catch (e) {
				console.warn(`[UNreader] 扩展名 .${ext} 已被占用，跳过（该类文件交由占用方打开）`, e);
			}
		}
		this.registerView(VIEW_TYPE_UNREADER, leaf => new UNreaderView(leaf, this));
		this.addSettingTab(new UNreaderSettingTab(this.app, this));

		// 跟踪最近活动的阅读视图（命令解析兜底的数据源之一）
		this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
			if (!leaf) return;
			try {
				if (leaf.view?.getViewType() === VIEW_TYPE_UNREADER) {
					this.lastReader = leaf.view as UNreaderView;
				}
			} catch { /* ignore */ }
		}));

		this.addCommand({
			id: "open-book",
			name: "打开书籍",
			callback: () => {
				void this.openBookPicker();
			},
		});
		// 命令统一用 callback 而非 checkCallback：命令面板回车执行时会再做一次
		// checkCallback(false)，而阅读器是 iframe 架构，焦点在书页内时工作区的
		// 活动视图解析可能瞬间失灵 → 面板关闭但命令静默不执行（首次回车失效、
		// 点过书页又失效的根因）。callback + 运行时兜底解析 + 可见提示，必不静默。
		const withReader = (action: (view: UNreaderView) => void): void => {
			const view = this.getActiveReader();
			if (!view) {
				new Notice("未找到正在使用的阅读器：请先打开一本书再执行此命令");
				return;
			}
			// 焦点若停在书页 iframe 上，先归还宿主文档：
			// 命令打开的弹窗/面板才能正常拿到键盘焦点
			const active = document.activeElement;
			if (active instanceof HTMLIFrameElement) {
				try { active.blur(); } catch { /* ignore */ }
			}
			action(view);
		};
		this.addCommand({
			id: "toggle-annotations",
			name: "切换标注侧边栏",
			callback: () => withReader(view => view.toggleAnnotations()),
		});
		this.addCommand({
			id: "toggle-toc",
			name: "显示/隐藏浮动目录",
			callback: () => withReader(view => view.toggleTocPanel()),
		});
		this.addCommand({
			id: "add-bookmark",
			name: "添加书签",
			callback: () => withReader(view => view.openBookmarkModal()),
		});
		this.addCommand({
			id: "toggle-appearance",
			name: "阅读外观",
			callback: () => withReader(view => view.toggleAppearance()),
		});
		// 诊断：把缓冲里的日志一键导出到库根（等价于 设置 → 诊断 → 保存到库，
		// 但不必进设置页翻找——排查闭环里这一步会被反复做）。
		// **读的是缓冲里的历史记录，不是现场快照**：打开命令面板要点屏幕，而点屏幕
		// 会触发核心的 `restoreNavigation()`（绑在 `mousedown`）恢复原生导航 ——
		// 「现场快照」类诊断在这种场景下**永远拍到健康的病人**。缓冲是边沿触发被动
		// 记录的，不受这一步点击影响，所以本命令是安全的（见 AGENTS.md「诊断」章）。
		// 诊断：拍一张**相邻界面**（官方文件列表 / 抽屉 / 宿主字体集 / 插件注入物）的快照
		// 落库根。用于「装了插件后**别的界面**渲染异常」这类故障 —— 现场不在插件自己的
		// DOM 里，真机又没有 devtools，只能靠这份快照区分「没渲染 / 被样式压没 / 合成被拖累」。
		// ⚠️ **先打开出问题那个界面（文件列表），再执行本命令**：抽屉内容在关闭时可能
		// 根本不在 DOM 里（那样快照只会报 found:false）。
		this.addCommand({
			id: "snapshot-neighbor-ui",
			name: "诊断：相邻界面快照（文件列表）",
			callback: () => {
				void this.snapshotNeighborUi();
			},
		});

		this.addCommand({
			id: "export-debug-log",
			name: "导出诊断日志",
			callback: () => {
				void this.exportDebugLog();
			},
		});
	}

	/** 采集并落盘相邻界面快照（见 `explorerDiag`）。**故意不依赖调试日志开关**：
	 *  这条排查路径上用户往往把日志关着，而证据必须落盘。 */
	private async snapshotNeighborUi(): Promise<void> {
		try {
			// 插件自己的 root 直接在宿主里查（readerView.rootEl 是私有的，不为一次性诊断开口子）
			const ownRoot = document.querySelector<HTMLElement>(".unreader-root");
			const facts = collectNeighborFacts(ownRoot);
			debugLog.info("[neighbor-ui]", facts);
			const text = JSON.stringify(facts, null, 2);
			const path = await writeReport(this.app, "unreader-neighbor", text);
			new Notice(`相邻界面快照已保存到 ${path}`);
		} catch (err) {
			debugLog.error("[neighbor-ui] snapshot failed", err);
			new Notice("快照失败（详见控制台）");
		}
	}

	/** 把诊断缓冲写到库根（落点与设置页「保存到库」一致 —— 库内普通文件会随同步
	 *  走、且 agent 能直接读盘；插件目录里的东西默认不参与同步，把证据留在离线
	 *  设备上等于没有）。 */
	private async exportDebugLog(): Promise<void> {
		if (debugLog.entryCount() === 0) {
			new Notice("暂无诊断日志：请先在「设置 → UNreader → 诊断」打开「调试日志」，复现问题后再执行本命令");
			return;
		}
		try {
			const path = await saveDebugReportToVault(this.app);
			new Notice(`诊断日志已保存到 ${path}`);
		} catch (err) {
			debugLog.error("[export-debug-log]", err);
			new Notice("导出诊断日志失败（详见控制台）");
		}
	}

	onunload(): void {
		this.flushSave();
		// 退出/禁用/重载插件时先把阅读视图的当前位置交出来：视图层的去抖（800ms）
		// 可能还没把这一拍的位置递给进度库，而下面那行只 flush「已经进库的」
		// —— 少了这一步，「读到一半直接退出 Obsidian」就丢掉最后那段阅读位置。
		try { this.lastReader?.forceFlushPosition(); } catch { /* ignore */ }
		// 待写盘的进度立即落库（卸载后没有机会再写）
		void this.progress?.flush();
		void this.presetStore?.flush();
		// 插件卸载时释放自定义字体 blob URL
		try { clearCustomFonts() } catch { /* ignore */ }
		// 兜底：两个底栏隐藏类都是 app 级（官方 is-hidden-nav 同时隐藏 view-header
		// 与 mobile-navbar；unreader-nav-hidden 是本插件的视觉闸门）。禁用/重载插件时
		// 若残留，别的视图会一进去就是沉浸态。
		try {
			document.body.removeClass("unreader-nav-hidden");
			document.body.removeClass("is-hidden-nav");
		} catch { /* ignore */ }
		// 同理：排除项写在用户的 `.obsidian` 配置里，失活必须摘掉我们登记的那几条
		// （用户自己的原样保留），否则插件禁用后仍在改用户的搜索行为。
		clearVaultExclusions(this.app);
	}

	/** 记录/清除存活阅读视图（由 readerView 在加载完成、获得焦点与关闭时调用） */
	noteActiveReader(view: UNreaderView): void {
		this.lastReader = view;
	}

	forgetActiveReader(view: UNreaderView): void {
		if (this.lastReader === view) this.lastReader = null;
	}

	getActiveReader(): UNreaderView | null {
		// 常规路径：Obsidian 自己的活动视图解析（焦点异常时也可能抛错，一并兜底）
		let active: UNreaderView | null = null;
		try {
			active = this.app.workspace.getActiveViewOfType(UNreaderView);
		} catch { /* ignore */ }
		if (active) {
			this.lastReader = active;
			return active;
		}
		// 兜底：焦点在书页 iframe 内 / 工作区状态滞后时，Obsidian 可能解析为空，
		// 回退到自跟踪的最近阅读视图（仍挂载在 DOM 上才算存活）
		const last = this.lastReader;
		if (last && last.containerEl?.isConnected) return last;
		this.lastReader = null;
		return null;
	}

	getBookFiles(): TFile[] {
		return getBookFiles(this);
	}

	/** 确保插件目录（UNreader/、Books/、Fonts/）存在。
	 *  路径是常量（见 core/paths.ts）——曾经的「资料库文件夹」设置项已撤下，
	 *  这三个目录不再由用户配置决定。Books/ 只作为「建议落点」存在（书放哪里都能读，
	 *  见 bookService.getBookFiles），空态提示里会提它一句。
	 *
	 *  ⚠️ 这里**只建空目录**，不负责找回。被改名/挪走的目录由 `core/libraryFolders.ts`
	 *  的 `healLibraryFolders` 在 `dataReady` 链首搬回 —— 那个必须跑在存储读盘之前，
	 *  而本方法是在 `onLayoutReady` 之后随字体扫描调用的。
	 *
	 *  **必须 await `libraryHeal`**：两者都要往 `UNreader/` 里放东西，谁先落地决定结果 ——
	 *  本方法若抢先建出空壳（尤其 `Fonts/`），找回那边就会因为「目标已有同名子目录」跳过，
	 *  用户真字体永久留在原地。 */
	async ensureLibraryFolders(): Promise<void> {
		try {
			await this.libraryHeal.catch(() => undefined);
			const missing: string[] = [];
			for (const sub of [UNREADER_ROOT, BOOKS_FOLDER, FONTS_FOLDER]) {
				const existing = this.app.vault.getAbstractFileByPath(sub);
				if (!existing || (existing as { children?: unknown[] }).children === undefined) missing.push(sub);
			}
			for (const p of missing) {
				try { await this.app.vault.createFolder(p); } catch { /* 已存在则忽略 */ }
			}
		} catch { /* ignore */ }
	}

	/** 把当前的排除开关状态同步到 Obsidian 配置（见 core/exclusions.ts）。
	 *  设置页切换开关后调用；`dataReady` 链首也会调一次（幂等）。 */
	async syncExclusions(): Promise<void> {
		await syncVaultExclusions(this.app, { includeNotes: this.settings.excludeNotesFromSearch !== false });
	}

	/** 扫描字体文件夹并把自定义字体注入引擎（跨设备：字体文件随库同步，
	 *  每端启动时自动扫描）。返回扫描到的字体列表。
	 *
	 *  单飞行（single-flight）：onload 的预热扫描与 loadBook 的并行组会**并发**调用
	 *  本方法，去重前会把全部字体二进制读两遍（用户库 3 枚 CJK 字体共 ~74MB）。
	 *  进行中的 Promise 直接复用，调用方拿到的都是同一次扫描结果，语义不变。 */
	async refreshCustomFonts(): Promise<CustomFont[]> {
		if (this.fontRefreshInFlight) return this.fontRefreshInFlight;
		const run = this.doRefreshCustomFonts();
		this.fontRefreshInFlight = run;
		try {
			return await run;
		} finally {
			// 只清理「自己这一次」：若期间已有新的刷新排队，不能把它的句柄抹掉
			if (this.fontRefreshInFlight === run) this.fontRefreshInFlight = null;
		}
	}

	/** 当前「真的会被用到」的自定义字体 id 集合（当前外观 + 各预设）。
	 *
	 *  **为什么需要它（2026-09-13）**：字体夹里常常躺着几十 MB 的 CJK 字库（作者库里就是
	 *  3 × 24MB），而 blob URL 一旦建出来就**常驻** —— 它活在 blob store 里，不进 JS 堆，
	 *  既看不见也回收不掉。原先 onload 与每次开书都把**所有**扫到的字体 readBinary +
	 *  createObjectURL，移动端 WebView 上等于凭空占住几十 MB 内存与渲染预算（用户报的
	 *  「装 UNreader 后官方文件列表在手机/平板上渲染异常、条目要滑动才闪出来」的可疑来源之一）。
	 *  实际会被用到的只有：当前外观选中的 family，以及各预设引用的 family（切预设不该掉字体）。
	 *  其余字体**仍然列出 label**（选择器要显示），只是不建 blob；用户真去选它时，选择路径
	 *  会先调 `refreshCustomFonts`（readerView 的 fontFamily patch 分支），那时它已进本集合
	 *  → 当场补上真 blob，不会出现「选了却不生效」。 */
	private referencedFontIds(): Set<string> {
		const ids = new Set<string>();
		const push = (v: string | null | undefined): void => { if (v) ids.add(v) };
		push(this.settings.appearance?.fontFamily);
		for (const p of this.settings.appearancePresets ?? []) push(p.appearance?.fontFamily);
		try {
			for (const p of this.presetStore?.list() ?? []) push(p.appearance?.fontFamily);
		} catch { /* ignore */ }
		return ids;
	}

	private async doRefreshCustomFonts(): Promise<CustomFont[]> {
		await this.ensureLibraryFolders();
		const fonts = scanCustomFonts(this.app, FONTS_FOLDER);
		const needed = this.referencedFontIds();
		// path → entry，最后按 fonts 顺序还原，保证并发完成顺序不影响结果顺序
		const byPath = new Map<string, { id: string; label: string; src: string; format: string }>();
		const pending: Promise<void>[] = [];
		// 字体 blob 缓存：readBinary + createObjectURL 对几 MB 的字体文件在移动端
		// 要花数秒，而 loadBook 每次开书都会调用本方法——按 mtime+size 缓存，
		// 未变化的文件直接复用 blob URL（ onload 首扫预热，开书零开销）
		for (const f of fonts) {
			// 没被任何外观/预设引用：只登记 label，**不建 blob**（见 referencedFontIds 注释）
			if (!needed.has(f.id)) {
				byPath.set(f.path, { id: f.id, label: f.label, src: "", format: "truetype" });
				continue;
			}
			const tf = this.app.vault.getAbstractFileByPath(f.path);
			const st = tf instanceof TFile ? tf.stat : null;
			const c = this.fontBlobCache.get(f.path);
			if (st && c && c.mtime === st.mtime && c.size === st.size) {
				byPath.set(f.path, { id: f.id, label: f.label, src: c.uri, format: c.format });
				continue;
			}
			// 未命中缓存的字体**并行**读取。此前串行 for-await 让总耗时 = 字体数 ×
			// 单次读延迟（移动端 iCloud 下 24MB 单枚可达数百 ms ~ 秒级），且与首屏
			// 渲染抢同一条 I/O 通道。
			pending.push(fontToBlobUrl(this.app, f.path).then(r => {
				if (!r) { console.warn("[UNreader] fontToBlobUrl failed:", f.path); return; }
				if (c) { try { URL.revokeObjectURL(c.uri) } catch { /* ignore */ } }
				this.fontBlobCache.set(f.path, { mtime: st?.mtime ?? 0, size: st?.size ?? 0, uri: r.uri, format: r.format });
				byPath.set(f.path, { id: f.id, label: f.label, src: r.uri, format: r.format });
			}));
		}
		await Promise.all(pending);
		// 本次不需要 blob 的字体：把缓存里那份回收掉（否则它一直占着内存，
		// 且 `sig` 里仍留真 src → 下次还会被当成「已注册」）
		for (const f of fonts) {
			if (needed.has(f.id)) continue;
			const c = this.fontBlobCache.get(f.path);
			if (!c) continue;
			try { URL.revokeObjectURL(c.uri) } catch { /* ignore */ }
			this.fontBlobCache.delete(f.path);
		}
		const entries = fonts
			.map(f => byPath.get(f.path))
			.filter((e): e is { id: string; label: string; src: string; format: string } => !!e);
		// 记录本轮真正建出 blob 的 id（src 为空的是「只登记 label、未建 blob」的字体）
		this.fontBlobbedIds = new Set(entries.filter(e => !!e.src).map(e => e.id));
		// 清理已删除字体的缓存
		for (const p of [...this.fontBlobCache.keys()]) {
			if (!fonts.some(f => f.path === p)) {
				const c = this.fontBlobCache.get(p);
				if (c) { try { URL.revokeObjectURL(c.uri) } catch { /* ignore */ } }
				this.fontBlobCache.delete(p);
			}
		}
		// 注册表与主题仅在内容变化时重建（否则每次开书都重注入 @font-face）
		const sig = entries.map(e => `${e.id}:${e.src}`).join("|");
		if (sig !== this.fontRegistrySig) {
			this.fontRegistrySig = sig;
			setCustomFonts(entries);
			// 已打开的阅读器立即刷新主题（重新注入 @font-face）
			try { this.getActiveReader()?.refreshAppearance(); } catch { /* ignore */ }
		}
		return fonts;
	}

	/** 自定义字体列表（外观面板用） */
	getCustomFonts(): CustomFont[] {
		return scanCustomFonts(this.app, FONTS_FOLDER);
	}

	/** 某字体 id 当前是否已建出 blob。
	 *
	 *  消费点只有一处：readerView 选中字体后的**有界重试**。refreshCustomFonts 是
	 *  单飞行的，复用的那次扫描可能发起于「用户写下新 fontFamily」之前 —— 它的
	 *  referencedFontIds 快照不含新 id，于是该字体会以 src:"" 落进注册表，产出
	 *  url("") 的假 @font-face，正文静默回退系统字体且不会自愈。调用方据此补跑一轮。 */
	hasFontBlob(id: string | null | undefined): boolean {
		return !!id && this.fontBlobbedIds.has(id);
	}

	/** 开放接口（UNagent 引用 / UNmemos 快速记录等三方插件调用）：
	 * 读取书内当前选区。阅读器是 iframe 架构，书内选区对宿主
	 * window.getSelection() 不可见，三方插件请优先走本接口、拿不到再回退
	 * 通用选区。返回 null 表示阅读器未打开或书内无选区。
	 * 用法：`app.plugins.plugins.unreader?.getReaderSelection?.()` */
	getReaderSelection(): ReaderSelectionInfo | null {
		return this.getActiveReader()?.getSelectionForExternal() ?? null;
	}

	/** 用阅读视图打开一本书。
	 *
	 *  常规路径是 `leaf.openFile(file)` —— 它按**扩展名注册表**路由到本视图。
	 *  但注册是可失败的（`registerExtensions` 在扩展名已被占用时抛错，onload 里逐项
	 *  吞掉），而 `UNreaderView` 是 `ItemView`、**没有 `onLoadFile`**，「哪些文件归本视图」
	 *  完全依赖那次注册。一旦 `.txt` 没注册成功，打开列表里的 TXT 就会落到别的视图
	 *  （markdown/空视图），本视图的 `setState` 根本收不到 file。
	 *  所以对 TXT 补一条显式路由兜底：`openFile` 若没能把本视图开到前台，就改用
	 *  `setViewState` 强指。注意本视图的 file 挂在 state **顶层**（见 readerView.setState），
	 *  不是官方 `FileView` 的 `state.state` 形状。 */
	async openBook(file: TFile): Promise<WorkspaceLeaf | null> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER)[0];
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		try {
			await leaf.openFile(file);
		} catch (e) {
			console.warn(`[UNreader] openFile 失败，改走显式路由：${file.path}`, e);
		}
		if (leaf.view?.getViewType() !== VIEW_TYPE_UNREADER) {
			try {
				await leaf.setViewState({ type: VIEW_TYPE_UNREADER, state: { file: file.path } });
			} catch (e) {
				console.warn(`[UNreader] 无法用阅读视图打开 ${file.path}`, e);
			}
		}
		return leaf;
	}

	async openBookPicker(): Promise<void> {
		const files = this.getBookFiles();
		if (!files.length) {
			new Notice("库里没有找到 EPUB / MOBI / AZW3 / TXT 文件：把书放进库内任意位置即可");
			return;
		}
		new BookPickerModal(this, files).open();
	}

	/** 进度库 / 预设库初始化完成。
	 *
	 *  onload 里已改成同步发起（不再阻塞插件启用），所以**任何需要这两份数据
	 *  的调用点都必须先 await 本方法**，否则会拿到空结果：开书会恢复不到上次
	 *  位置（getPosition 落回旧 data.json 的 positions 兜底），外观面板会列出
	 *  空预设、钉住的预设会被误判成「尚未同步」。 */
	whenDataReady(): Promise<void> {
		return this.dataReady;
	}

	getPosition(path: string): BookPosition | undefined {
		return this.progress?.get(path) ?? this.settings.positions[path];
	}

	savePosition(path: string, position: BookPosition, immediate = false): void {
		// 内存镜像保留（三方插件/降级兼容），落盘走进度库文件（多端同步）
		this.settings.positions[path] = position;
		// immediate：关闭视图 / 退出应用 / 切后台那条路 —— 不去抖，直接写盘
		if (immediate) this.progress?.saveNow(path, position);
		else this.progress?.save(path, position);
		this.scheduleSave();
	}

	scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.persistData();
		}, 800);
	}

	flushSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.persistData();
	}

	async persistData(): Promise<void> {
		// 设置保存即同步诊断开关（设置页切开关后立刻生效/清缓冲）
		debugLog.setDebugEnabled(this.settings.debugLog);
		try {
			this.saving = true;
			// 外观是设备本地状态（各设备可各自选择预设/各自微调），不写入随库
			// 同步的 data.json——否则 A 设备选择的预设会以「外观值」的形式泄漏
			// 到其他设备（他端没选预设却长成了 A 的样子）。存本机 localStorage；
			// 超配额（大背景 data URI）时降级回写 data.json 保底
			const overflow = !this.saveDeviceAppearance();
			const payload = overflow ? this.settings : { ...this.settings, appearance: undefined };
			await this.saveData(payload);
		} catch (e) {
			console.error("[UNreader] failed to save data", e);
		} finally {
			this.saving = false;
		}
	}

	/** 本机库作用域：localStorage 在 Obsidian 里是全局共享的，同一台机器上的
	 *  多个库必须各自隔离（否则进度热缓存/外观快照会串库） */
	private deviceScope(): string {
		try {
			return String((this.app as unknown as { appId?: string }).appId ?? "") || this.app.vault.getName() || "default";
		} catch {
			return "default";
		}
	}

	/** 本机外观的 localStorage key（按库隔离；同一台机器多个库各自独立） */
	private deviceAppearanceKey(): string {
		return `unreader-appearance:${this.deviceScope()}`;
	}

	/** 读取本机外观快照（localStorage，设备本地永不随库同步） */
	private loadDeviceAppearance(): Partial<AppearanceSettings> | null {
		try {
			const raw = localStorage.getItem(this.deviceAppearanceKey());
			if (!raw) return null;
			const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	}

	/** 写入本机外观快照；失败（超配额等）返回 false 由调用方降级 */
	private saveDeviceAppearance(): boolean {
		try {
			localStorage.setItem(this.deviceAppearanceKey(), JSON.stringify(this.settings.appearance));
			return true;
		} catch (e) {
			console.warn("[UNreader] 本机外观写入 localStorage 失败（可能超配额），降级写入 data.json", e);
			return false;
		}
	}

	private async loadSettingsData(): Promise<void> {
		const data = (await this.loadData()) as Partial<UNreaderSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		this.settings.positions = this.settings.positions ?? {};
		// 路径不再是设置项：四个文件夹字段已从 UNreaderSettings 删除，全部改用
		// core/paths.ts 的常量。老 data.json 里残留的同名字段会被 Object.assign
		// 一起带进来，但没有任何读取点，属无害的惰性残留。
		// 外观是设备本地状态（localStorage 按库隔离，不随 data.json 同步）：
		// 本机有快照就用本机的；没有（首次升级/新库）则回退旧 data.json 的
		// appearance 并迁移为本机快照——此后各设备外观互相独立
		const localAppearance = this.loadDeviceAppearance();
		this.settings.appearance = Object.assign(
			{},
			DEFAULT_APPEARANCE,
			localAppearance ?? data?.appearance ?? {},
		);
		if (!localAppearance && data?.appearance) this.saveDeviceAppearance();
		// 迁移：移动端默认开启「沉浸模式」（桌面/平板默认关）。仅当用户从未显式
		// 设置过（Set 标记缺失）时才按平台给默认——旧版会把桌面端写入的默认
		// false 同步到移动端，导致移动端沉浸模式永久失效
		let mobileLike = false;
		try {
			mobileLike = Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp;
		} catch { /* ignore */ }
		if (this.settings.hideChromeOnScrollSet !== true) {
			this.settings.hideChromeOnScroll = mobileLike;
		}
		// 迁移：沉浸模式适配（外观项，随预设存储）——移动端默认开，沿用既有的
		// 「沉浸隐藏页首」观感；桌面端默认关（页首承载标签/导航，藏掉会挡路）。
		// 外观是设备本地快照，故按平台给默认天然合理；仅当本机快照与旧 data.json
		// 都没有该字段（未设置过、也未被预设写入过）时才补。
		// 旧字段 `hideHeader`（只藏页首）就地迁移为 `immersiveAdapt`（2026-09-14 改名，
		// 语义扩到「连原生底栏/系统状态栏一起藏」）——**必须在合并默认值之前**
		// 对原始对象调用，否则默认值 false 会把旧值盖掉（见 adoptLegacyAppearance）。
		const rawAppearance = (localAppearance ?? data?.appearance ?? {}) as Record<string, unknown>;
		adoptLegacyAppearance(rawAppearance);
		if (typeof rawAppearance.immersiveAdapt === "boolean") {
			this.settings.appearance.immersiveAdapt = rawAppearance.immersiveAdapt;
		} else {
			this.settings.appearance.immersiveAdapt = mobileLike;
		}
		// 合并默认值时会把原始对象里的旧键一并带进来 —— 删掉，别让它跟着快照落盘
		delete (this.settings.appearance as unknown as Record<string, unknown>).hideHeader;
		// 移动端默认不自动展开浮动目录（隐藏了章节轨，目录改由工具栏「目录」按钮唤起；
		// 开书即弹面板反而打扰）。原先靠顶层旧字段 autoOpenToc/autoOpenTocSet 中转，
		// 那两个字段已随「已废弃设置项」清理删除 —— 直接写外观字段，行为不变。
		if (mobileLike) this.settings.appearance.autoOpenToc = false;
		// 迁移：旧数据可能缺少 theme / dark 配色，补齐默认值
		const a = this.settings.appearance as AppearanceSettings & Record<string, unknown>;
		if (a.theme !== "light" && a.theme !== "dark" && a.theme !== "auto") a.theme = "auto";
		// 迁移：未自定义过颜色（即保持默认值）时，统一改为自动跟随 Obsidian 明暗
		const untouched =
			(!a.backgroundColor || a.backgroundColor === "#ffffff") &&
			(!a.textColor || a.textColor === "#222222") &&
			(!a.darkBackgroundColor || a.darkBackgroundColor === "#1e1e1e") &&
			(!a.darkTextColor || a.darkTextColor === "#d4d4d4");
		if (untouched) a.theme = "auto";
		// 迁移：配色来源——undefined（旧版数据）一律升级为「跟随 Obsidian」；
		// 仅当用户显式选过「自定义」才保留自定义色值
		if (a.colorMode !== "custom") a.colorMode = "obsidian";
		// 迁移：排版仍为旧默认（跟随主题）时，升级为苹果式默认排版；
		// 字体跟随 Obsidian 系统字体（不默认锁死霞鹜文楷——自定义字体由用户放 Fonts 文件夹）
		const untouchedType =
			(a.fontFamily === null || a.fontFamily === undefined || a.fontFamily === "") &&
			(a.fontSize === null || a.fontSize === undefined) &&
			(a.lineHeight === null || a.lineHeight === undefined) &&
			(a.letterSpacing === 0 || a.letterSpacing === null || a.letterSpacing === undefined) &&
			(a.paragraphSpacing === null || a.paragraphSpacing === undefined) &&
			(a.marginLeft === null || a.marginLeft === undefined) &&
			(a.marginRight === null || a.marginRight === undefined);
		if (untouchedType) {
			a.fontFamily = DEFAULT_APPEARANCE.fontFamily; // null → 跟随 Obsidian 系统字体
			a.fontSize = DEFAULT_APPEARANCE.fontSize;
			a.lineHeight = DEFAULT_APPEARANCE.lineHeight;
			a.letterSpacing = DEFAULT_APPEARANCE.letterSpacing;
			a.paragraphSpacing = DEFAULT_APPEARANCE.paragraphSpacing;
			a.marginLeft = DEFAULT_APPEARANCE.marginLeft;
			a.marginRight = DEFAULT_APPEARANCE.marginRight;
		}
		if (!a.darkBackgroundColor) a.darkBackgroundColor = DEFAULT_APPEARANCE.darkBackgroundColor;
		if (!a.darkTextColor) a.darkTextColor = DEFAULT_APPEARANCE.darkTextColor;
		if (!a.backgroundColor) a.backgroundColor = DEFAULT_APPEARANCE.backgroundColor;
		if (!a.textColor) a.textColor = DEFAULT_APPEARANCE.textColor;
		if (typeof this.settings.annoPinned !== "boolean") this.settings.annoPinned = false;
		if (typeof this.settings.annoPanelHeight !== "number" || !Number.isFinite(this.settings.annoPanelHeight) || this.settings.annoPanelHeight < 220) delete this.settings.annoPanelHeight;
		if (typeof this.settings.pinThreshold !== "number" || this.settings.pinThreshold < 400 || this.settings.pinThreshold > 1200) this.settings.pinThreshold = DEFAULT_SETTINGS.pinThreshold;
		if (!Array.isArray(this.settings.appearancePresets)) this.settings.appearancePresets = [];
		// 规范化每个预设的 appearance，补齐缺失字段
		for (const p of this.settings.appearancePresets) {
			if (!p || typeof p.name !== "string" || !p.appearance) continue;
			// 旧字段迁移必须在合并默认值之前（否则默认 false 盖掉旧值，见 adoptLegacyAppearance）
			adoptLegacyAppearance(p.appearance as unknown as Record<string, unknown>);
			p.appearance = Object.assign({}, DEFAULT_APPEARANCE, p.appearance);
			if (!p.id) p.id = String(Date.now()) + Math.random().toString(36).slice(2, 7);
			if (!p.createdAt) p.createdAt = Date.now();
		}
	}

	/** 诊断日志的环境快照：版本/平台/库路径/外观关键项（不含任何 data URI 大字段） */
	private collectLogEnv(): Record<string, string> {
		// `version` 运行时存在但typings未声明
		const appVersion = (this.app as unknown as { version?: string }).version;
		const a = this.settings.appearance;
		return {
			"plugin version": this.manifest.version,
			"obsidian version": appVersion ?? "unknown",
			platform: Platform.isMobileApp
				? Platform.isIosApp ? "iOS app" : "Android app"
				: Platform.isDesktopApp ? "Desktop app" : "Desktop",
			"library root": UNREADER_ROOT,
			"fonts folder": FONTS_FOLDER,
			// 排除项（core/exclusions）：用户报「我的笔记不参与搜索了 / 明明排除了还在」
			// 这类问题时，唯一能看到**实际生效的配置**的地方 —— 设置里的开关只表达意图，
			// 官方配置里到底写了什么才是事实。
			"exclude notes from search": this.settings.excludeNotesFromSearch !== false ? "on" : "off",
			"userIgnoreFilters": (() => {
				try {
					const v = this.app.vault as unknown as { getConfig?: (k: string) => unknown };
					const raw = v.getConfig?.("userIgnoreFilters");
					return Array.isArray(raw) && raw.length > 0 ? raw.join(" ") : "（空）";
				} catch { return "读取失败"; }
			})(),
			"book count": String(this.getBookFiles().length),
			theme: a.theme,
			"color mode": a.colorMode,
			"bg image mode": a.bgImageMode,
			// **报告「实际生效的那张图」**（2026-09-13 修）：老写法两个字段口径不一致 ——
			// `bg image set` 是三者取或、`bg image size` 只读共用字段 → 用户配置成
			// `bgImageMode:"shared"` + `backgroundImage:null` 而 Light/Dark 有图时，
			// 同一份报告会同时输出「set: yes」与「size: none」，**自相矛盾**，让人以为图已生效。
			// 真相是：shared 模式只认 `backgroundImage`，那两张图完全不生效（用户就踩在这上面）。
			"bg image active": (() => {
				const field = a.bgImageMode === "separate"
					? (activeTheme(a) === "dark" ? "backgroundImageDark" : "backgroundImageLight")
					: "backgroundImage";
				const v = String((a as unknown as Record<string, unknown>)[field] ?? "");
				if (!v) return `none（当前生效字段是 ${field}，它是空的）`;
				return `${field} ${v.startsWith("data:") ? Math.round(v.length / 1024) + "KB(data uri)" : v.slice(0, 60)}`;
			})(),
			"bg image stored": (["backgroundImage", "backgroundImageLight", "backgroundImageDark"] as const)
				.map(f => `${f}=${(a as unknown as Record<string, unknown>)[f] ? "有" : "空"}`).join(" "),
			glass: String(!!a.glassEnabled),
			"image blur": String(a.imageBlur ?? 0),
			"font size": String(a.fontSize ?? ""),
		};
	}
}

class BookPickerModal extends FuzzySuggestModal<TFile> {
	/** 书名 → 库内出现次数。书不再限定在某个文件夹里（见 bookService.getBookFiles），
	 *  重名书会同时出现在列表里 —— 只显示 basename 时两项一模一样、无法分辨，故重名时补所在目录。 */
	private nameCounts = new Map<string, number>();

	constructor(
		private plugin: UNreaderPlugin,
		private files: TFile[],
	) {
		super(plugin.app);
		for (const f of files) this.nameCounts.set(f.basename, (this.nameCounts.get(f.basename) ?? 0) + 1);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		if ((this.nameCounts.get(file.basename) ?? 0) <= 1) return file.basename;
		const dir = file.parent?.path ?? "";
		return dir && dir !== "/" ? `${file.basename} — ${dir}` : file.basename;
	}

	onChooseItem(file: TFile): void {
		void this.plugin.openBook(file);
	}
}
