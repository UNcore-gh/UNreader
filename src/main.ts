import { Plugin, TFile, Notice, FuzzySuggestModal, MarkdownView, WorkspaceLeaf, Platform, normalizePath, MarkdownRenderer, Component } from "obsidian";
import { DEFAULT_SETTINGS, DEFAULT_APPEARANCE, UNreaderSettings, AppearanceSettings, BookPosition, CustomFont, activeTheme, adoptLegacyAppearance, platformAppearanceDefaults, HIGHLIGHT_COLORS } from "./types";
import type { AiToolOverride, FeedEntryKind, MarkdownNoteListItem, MarkdownNoteRecentEntry, NoteMetaSummary } from "./types";
import { UNreaderSettingTab } from "./settings";
import { getBookFiles, getRemovedBookshelfEntries, SUPPORTED_BOOK_FORMATS, READER_BOOK_EXT_ORDER, isReaderBookFile } from "./core/bookService";
import { isBookExtEnabled, isMdFormatEnabled, isRssFormatEnabled, normalizeDisabledFormats } from "./core/readableFormats";
import { createNoteFileResolver, isMarkdownNoteFile, normalizeNoteIndex, pruneNoteIndex, resolveNoteFile } from "./core/fileGate";
import { OFFICIAL_TOOLS as DEFAULT_AI_OFFICIAL_TOOLS } from "./core/aiTasks";
import { excludedFolderKey, normalizeExcludedFolder } from "./core/bookExclusions";
import { clearBookPreviewCache } from "./core/bookPreview";
import { ProgressStore } from "./core/progressStore";
import { PresetStore } from "./core/presetStore";
import { scanCustomFonts, fontToBlobUrl } from "./core/fontService";
import { repairDanglingFontRefs } from "./core/fontRefRepair";
import { ResourceStore, setActiveResourceStore, type SharedResourceKind } from "./core/resourceStore";
import { ReadingStatsStore, setActiveReadingStats, noteStatKey } from "./core/readingStatsStore";
import { ReadingTimer } from "./core/readingTimer";
import { UNREADER_ROOT, DATA_FOLDER, DATA_DIR_NAME, FONTS_FOLDER, RESOURCES_FOLDER, IMAGES_FOLDER, PRESETS_FOLDER, PROGRESS_FOLDER, NOTES_FOLDER, FEEDS_FOLDER, STATS_FOLDER, setConfiguredDataFolder, dataRootOf, normalizeDataFolder } from "./core/paths";
import { healLibraryFolders } from "./core/libraryFolders";
import { planDataFolderMigration, planLegacyDataFolderNesting, planDataContainerNesting, migrateDataFolder, rewriteFontReferences, dataContainerSkipNoticeId, type LibraryMigrationPlan } from "./core/libraryMigration";
import { syncVaultExclusions, clearVaultExclusions } from "./core/exclusions";
import * as debugLog from "./core/debugLog";
import { saveDebugReportToVault, writeReport } from "./core/debugReport";
import { setCustomFonts, clearCustomFonts } from "./core/engineAdapter";
import { idleYield } from "./core/idle";
import { setLang, getLang, resolveLang, normalizeLangPref, onLangChange, t, tf, highlightColorLabel, type LangPref } from "./core/i18n";
import { VIEW_TYPE_UNREADER, UNreaderView, ReaderSelectionInfo } from "./ui/readerView";
import { ResourceManagerModal, type ManagedResource } from "./ui/resourceManagerModal";
import { collectNeighborFacts } from "./ui/explorerDiag";
import { readSelectionDiag, clearSelectionDiag } from "./ui/selectionDiag";
import { ExplorerHeal } from "./ui/explorerHeal";
import { MdOverlayManager } from "./ui/mdOverlay";
import { AddFeedModal, DeleteFeedModal, FeedManagerModal, ImportOpmlModal, RenameFeedModal } from "./ui/feedModals";
import type { DiscoveredFeed } from "./core/feedParser";
import { FeedStore } from "./core/feedStore";
import { confirmAction } from "./ui/confirmModal";
import { FeedService } from "./core/feedService";
import { BookshelfCategoryManagerModal } from "./ui/bookshelfModals";
import type { BookshelfCategory } from "./types";
import { FeedMediaStore } from "./core/feedMediaStore";
import { countWords } from "./core/wordCount";
import { annotationFileFor, annotationFileForFeed, loadAnnotations, sanitizeBookmarkLabel, writeAnnotations, type AnnotationFileData, type StoredBookmark, type StoredHighlight } from "./core/annotationStore";
import { collectHighlights } from "./core/mdSelectionMap";
import { applyEditPlan, applyVaultEditPlan } from "./core/mdHighlightWrite";
import { normalizeNativeSidebarMode, resolveNativeSidebarCardIntent, resolveNativeSidebarPickerMode, selectNativeSidebarKeeperIndex, selectPreferredReaderIndex, shouldMigrateNativeSidebarGroup } from "./core/nativeSidebarState";
import { releaseNoteForVersion, releaseNoteVersionsNewestFirst, shouldPromptReleaseNotes } from "./core/releaseNotes";
import { VIEW_TYPE_UNREADER_SIDEBAR, UNreaderSidebarView } from "./ui/nativeSidebarView";
import type { NativeSidebarContext, SidePanelMode } from "./ui/sidePanels";
import { ReleaseNotesModal } from "./ui/releaseNotesModal";

/** UNagent 写完库内文件后的显式刷新通道（见 UNagent 的 utils/pluginNotify.ts）。
 *
 *  为什么需要它：本插件靠 Vault 的 create/modify/delete/rename 事件发现「他端
 *  同步到达」的数据，但那类重扫都排在 `dataReady` 门闩之后、并且带去抖；而
 *  `Data/Feeds/` 更是**从来没有**Vault 监听（订阅是插件自己高频写的，监听会
 *  自激）。于是 UNagent 替我们写订阅索引 / 预设 / 资源时，界面上什么都不会发生
 *  ——用户看到的是「Agent 说存好了，面板里没有」，只能重启插件。 */
const VAULT_WRITE_EVENT = "unagent:vault-write";

/** 「最近阅读」只保留这么多条；侧边页不会变成全库笔记列表。 */
const MARKDOWN_NOTE_RECENT_LIMIT = 12;

/** 笔记看板里「其余 frontmatter 键」最多列几条（窄浮层，多了要滚动反而看不清）。 */
const NOTE_META_EXTRA_LIMIT = 6;

/** frontmatter 里属于「封面」语义的键：`core/noteThumb` 已把它们用作缩略图来源，
 *  再在看板里列一遍是重复信息。 */
const COVER_META_KEYS = new Set(["cover", "thumbnail", "image", "banner", "position"]);

interface NativeAnnotationBrowseInfo {
	key: string
	kind: NativeSidebarContext["kind"]
	title: string
	pickerMode: NativeSidebarContext["pickerMode"]
	filePath: string
	annotationPath: string
	bookLink: string
	feedRef?: { feedId: string; entryId: string; kind?: FeedEntryKind }
}

/** frontmatter 值 → 展示串：数组接成「、」，对象/嵌套结构不展开（看板不是 YAML 查看器）。 */
function normalizeMetaValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value.filter(item => item != null && typeof item !== "object").map(item => String(item)).join("、").trim();
	}
	return "";
}

/** frontmatter 的 tags / aliases：数组或「逗号/空格分隔的字符串」两种写法都归一为数组。 */
function normalizeMetaList(value: unknown): string[] {
	if (value == null) return [];
	const raw = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
	return raw
		.map(item => String(item).trim().replace(/^#/, ""))
		.filter(item => item.length > 0)
		.slice(0, 8);
}

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
			// 以 window 为接收者直接调用（脱离 window 取方法引用会被 unbound-method 判为可疑，
			// 且 Web IDL 方法用错 this 会抛 Illegal invocation）。
			const idleWindow = window as Window & {
				requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
			};
			if (typeof idleWindow.requestIdleCallback === "function") {
				idleWindow.requestIdleCallback(finish, { timeout: 250 });
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

/** 启动期字体预热的「先让过多久」与「最迟多久」（毫秒）。
 *
 *  一段固定让路 + 一段「等到真空闲为止」的探测：固定值用来跨过首屏绘制与
 *  workspace 恢复那个必然繁忙的窗口（几百 ms 起步，移动端更久），探测用来在
 *  机器真的空下来之后立刻开跑，而不是把代价一路拖到用户第一次点东西。
 *  上限 4s：预热只是「提前备好」，任何消费点都会自己 await 一次扫描（单飞行去重），
 *  拖太久就失去了「开书零等待」的意义，宁可让它在一个较早的繁忙片里跑完。 */
const FONT_PREWARM_DELAY_MS = 1200;
const FONT_PREWARM_MAX_DELAY_MS = 4000;
/** 建 blob 之前值得让出一帧的批量大小。几枚 CJK 字库（>4MB）的 `readBinary` +
 *  `new Blob` + `createObjectURL` 在移动端是肉眼可见的一次卡顿；小字体（几百 KB）
 *  连 1ms 都不到，为它插一片空闲让路反而把开书路径拖长。 */
const FONT_BLOB_YIELD_BYTES = 4 * 1024 * 1024;

/** `applyDataFolder` 的结果。失败时 `ok=false` 且 `error` 已经是可读中文，调用方只负责提示。 */
export interface DataFolderSwitchResult {
	ok: boolean;
	error?: string;
	/** 真正搬动的文件数 */
	moved: number;
	/** 迁移后变空、被删掉的旧目录数 */
	removedEmpty: number;
	/** 被改写的字体引用数（字段 + 库内文件） */
	rewrote: number;
}

export default class UNreaderPlugin extends Plugin {
	settings!: UNreaderSettings;
	/** 阅读进度库：每书一个小 JSON 文件（UNreader/Data/Progress/），随库同步到各端 */
	progress!: ProgressStore;
	/** 外观预设库：每个预设一个文件夹（UNreader/Data/Presets/<名>/），随库同步到各端 */
	presetStore!: PresetStore;
	/** 共享资源库：字体与图片只存一份，预设/设备保存引用 */
	resourceStore!: ResourceStore;
	/** 阅读统计库：按条目累计的阅读时长（`Data/Stats/reading.json`） */
	readingStats!: ReadingStatsStore;
	/** 阅读计时器：把「当前正在读什么」翻译成累计时长（见 core/readingTimer.ts） */
	readingTimer!: ReadingTimer;
	/** RSS/Atom/JSON Feed 订阅与文章快照。网络请求只由显式刷新或打开文章触发。 */
	feedStore!: FeedStore;
	feedService!: FeedService;
	feedMediaStore!: FeedMediaStore;
	/** 目录找回（core/libraryFolders）的结果。**必须被 `ensureLibraryFolders` await**：
	 *  它是「不存在就建空目录」的那一半，会与找回抢着创建 `UNreader/`，一旦空壳先落盘，
	 *  候选里的 `Fonts` 就会因为「目标已有同名子目录」被跳过而永久留在原地。 */
	private libraryHeal: Promise<unknown> = Promise.resolve();

	/** 已注册命令的完整 id（`unreader:xxx`）：界面语言切换时据此逐个 removeCommand。
	 *  故意不依赖 addCommand 的返回值 —— 它的类型在官方不同版本间不稳。 */
	private commandIds = new Set<string>();

	private saveTimer: number | null = null;
	private saving = false;
	/** 字体 blob 缓存：路径 → (mtime, size, blob URL, format)，避免每次开书重读字体文件 */
	private fontBlobCache = new Map<string, { mtime: number; size: number; uri: string; format: string }>();
	private fontRegistrySig = "";
	/** 最近一轮真正建出 blob 的字体 id：供「选中字体后确认它已就绪」判断（见 hasFontBlob） */
	private fontBlobbedIds = new Set<string>();
	/** 进行中的字体刷新（单飞行去重，见 refreshCustomFonts） */
	private fontRefreshInFlight: Promise<CustomFont[]> | null = null;
	/** 已经卸载（禁用/重载）。延后的启动预热必须靠它及时刹车 —— 否则它会在
	 *  `onunload` 的 `clearCustomFonts()` **之后**建出 blob URL，既漏内存，
	 *  又把刚清空的字体注册表重新灌满。 */
	private unloaded = false;
	private hasExistingPluginData = false;
	private releaseNotesPromptTimer: number | null = null;
	private activeReleaseNotesModal: ReleaseNotesModal | null = null;
	// 最近一次存活的阅读视图：阅读器为 iframe 架构，焦点进入书页后
	// Obsidian 的 getActiveViewOfType 可能解析不到活动视图（表现为命令面板
	// 首次回车不执行、点过书页后又失效），用自跟踪视图做兜底
	private lastReader: UNreaderView | null = null;
	private nativeSidebarContext: NativeSidebarContext | null = null;
	private nativeSidebarAnnotationTarget: NativeSidebarContext | null = null;
	private nativeSidebarAnnotationSequence = 0;
	private nativeAnnotationJumpSequence = 0;
	private nativeAnnotationMutationQueues = new Map<string, Promise<void>>();
	private nativeSidebarContextOwner: object | null = null;
	private nativeSidebarLeafPromise: Promise<WorkspaceLeaf | null> | null = null;
	private sidebarCardNavigationIntent = 0;
	private pendingSidebarCardKey: string | null = null;
	private pendingSidebarAnnotationIntent: { key: string; navigationIntent: number } | null = null;
	private sidebarCardOpenPromises = new Map<string, Promise<boolean>>();
	private sidebarCardOpenQueue: Promise<boolean> | null = null;
	/** markdown 阅读视图叠加层（进度条 / 章节目录条 / 沉浸会话）。
	 *  插件不接管 .md —— 只寄生在官方阅读模式视图上，见 ui/mdOverlay.ts 文件头。 */
	mdOverlay: MdOverlayManager | null = null;
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
		debugLog.setSelectionDiagProvider(readSelectionDiag, clearSelectionDiag);
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
			const stack = String((reason).stack ?? "").toLowerCase();
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
			// `ErrorEvent.error` 的类型就是 `any`；这里只做「分类 + 记录」，收成 unknown 即可
			const reason: unknown = ev.error ?? ev.message;
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

		// 阅读统计库（阅读时长）。**不必 await**：卡片渲染时读不到就显示「暂无统计」，
		// 读完后下一次刷新自然补上（与进度库不同，统计不是开书的前置条件）。
		this.readingStats = new ReadingStatsStore(this.app.vault, STATS_FOLDER, this.deviceScope());
		setActiveReadingStats(this.readingStats);
		this.readingTimer = new ReadingTimer(this.readingStats);

		// 外观预设库：从库内预设文件夹加载
		this.presetStore = new PresetStore(this.app.vault, PRESETS_FOLDER, this.app.fileManager);

		// 共享资源库：字体沿用 Fonts/，图片统一落 Resources/Images/；
		// 资源文件与启用索引随库同步，设备外观和当前预设仍只存在本机。
		this.resourceStore = new ResourceStore(this.app.vault, this.app.fileManager);
		setActiveResourceStore(this.resourceStore);
		this.feedStore = new FeedStore(this.app.vault, this.deviceScope(), this.feedCachePluginDir());
		this.feedService = new FeedService(this.feedStore, () => this.settings.feeds);
		this.feedMediaStore = new FeedMediaStore(() => this.settings.feeds);

		// ⚠️ 这里**绝不能再 await**（2026-09-11 性能回归点）。
		// 进度库 + 预设库合计 20+ 次文件读取（实测本机：14 个进度文件 + 5 个预设），
		// 全部串行时插件启用耗时 ≈ 次数 × 单次读延迟。冷启动测量台实测（.perf/runner.cjs）：
		//   单次 I/O  5ms → onload 116ms ｜ 25ms → 523ms ｜ 60ms → 1228ms ｜ 120ms → 2433ms
		// 严格线性，说明这 500ms~2.4s 全部是「等磁盘」而非任何计算。桌面 SSD 上只有
		// 2.5ms（所以开发时看不出问题），移动端 iCloud / 网络盘才是真机受害者。
		// 改为「同步发起 + 暴露 dataReady」后，插件启用不再等磁盘，消费点
		// （readerView 开书取进度、外观面板列预设、预设重扫）各自 await whenDataReady()。
		//
		// 链首多了几步前置（旧布局/容器整理 + 目录找回 + 排除项同步），它们**不改变上面那条性能结论**：
		// 「不 await」约束的是 **onload 路径**，而链内 await 只推迟 dataReady 的兑现，
		// 不推迟插件启用。两步的顺序有硬约束：
		//   ① 目录整理与 `healLibraryFolders` 必须排在两份存储读盘**之前** —— 目录若被
		//      改名搬走过，下面两个 init 会按空目录读完，搬回来也白搭（本会话缓存仍是空的）。
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
			let msLegacy = -1;
			try {
				const t = Date.now();
				const legacyPlan = planLegacyDataFolderNesting(this.app, this.settings.dataFolder);
				if (legacyPlan.collisions.length) {
					debugLog.warn("[dataFolder] 旧版散放数据迁移被重名文件阻止", legacyPlan.collisions);
					new Notice(`UNreader：检测到旧版数据散放在「${legacyPlan.from}」中，但目标已有同名文件（如「${legacyPlan.collisions[0]}」），已停止自动整理。请先处理重名文件。`);
				} else if (legacyPlan.from) {
					// 即使 moves 为空也调用：上一轮可能已删完文件，只剩空目录骨架。
					const result = await migrateDataFolder(this.app, legacyPlan);
					if (result.error) {
						debugLog.warn("[dataFolder] 旧版散放数据迁移失败", result.error, result.rollbackFailures);
						new Notice(`UNreader：旧版数据自动整理失败：${result.error}`);
					} else if (result.moved.length || result.removedEmpty.length) {
						debugLog.info(`[dataFolder] 旧版数据整理完成：移动 ${result.moved.length} 个文件，清理 ${result.removedEmpty.length} 个空目录 → ${legacyPlan.to}`);
					}
				}
				msLegacy = Date.now() - t;
			} catch (e) {
				console.warn("[UNreader] 旧版数据文件夹整理失败（继续读存储）", e);
			}
			// ③ 容器化整理（2026-09-19）：旧版把六个数据目录平铺在数据根下
			//    （`UNreader/Progress/…`），现在统一收进 `Data/`。必须排在 heal 之前：
			//    heal 的内容证据要按收敛后的布局落位，刚搬回来的目录才不会再散一次。
			//    失败不阻断后续（数据仍在原地，只是布局没收敛，下次启动再试）。
			let msNest = -1;
			try {
				const t = Date.now();
				const containerPlan = planDataContainerNesting(this.app);
				// 冲突消失时清掉“已提示”标记；下次同一冲突重新出现仍会提醒一次。
				if (!containerPlan.skippedDirs?.length) this.clearDataContainerSkipNotice();
				if (containerPlan.moves.length || containerPlan.skippedDirs?.length) {
					const result = await migrateDataFolder(this.app, containerPlan);
					if (result.error) {
						debugLog.warn("[dataFolder] 数据容器化整理失败", result.error, result.rollbackFailures);
						new Notice(`UNreader：数据目录整理失败：${result.error}`);
					} else {
						// 平铺 `Fonts/` 收进 `Data/Fonts/` 会让 `custom:<库内路径>` 全部悬空
						// （字体 id 含完整路径），这里按目录前缀精确改写；`Fonts` 因重名被
						// 跳过时文件没动，引用仍是对的，不能改。
						if (result.moved.length && !containerPlan.skippedDirs?.includes("Fonts")) {
							const rewrote = await rewriteFontReferences(this.app, this.settings, [`${UNREADER_ROOT}/Fonts`], FONTS_FOLDER);
							if (rewrote) {
								// 外观快照在本机 localStorage（不随 data.json 同步），两份都写
								this.saveDeviceAppearance();
								this.scheduleSave();
							}
						}
						if (result.moved.length || result.removedEmpty.length) {
							debugLog.info(`[dataFolder] 数据容器化完成：移动 ${result.moved.length} 个文件，清理 ${result.removedEmpty.length} 个空目录 → ${containerPlan.to}`);
						}
						if (containerPlan.skippedDirs?.length && this.shouldShowDataContainerSkipNotice(containerPlan)) {
							new Notice(`UNreader：有 ${containerPlan.skippedDirs.length} 个数据目录因目标已有同名文件未整理（${containerPlan.skippedDirs.join("、")}），已保留原样。此提示在冲突内容变化前只显示一次。`);
						}
					}
				}
				msNest = Date.now() - t;
			} catch (e) {
				console.warn("[UNreader] 数据目录容器化整理失败（继续读存储）", e);
			}
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
				await syncVaultExclusions(this.app, { excludeNotes: this.settings.excludeNotesFromSearch !== false });
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
				this.resourceStore.init().catch(e => {
					console.warn("[UNreader] 共享资源库初始化失败", e);
				}),
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
				this.feedStore.init().catch(e => {
					console.warn("[UNreader] 订阅库初始化失败", e);
				}),
				this.readingStats.init().catch(e => {
					console.warn("[UNreader] 阅读统计初始化失败", e);
				}),
			]);
			await this.migrateLegacyImageResources().catch(e => {
				console.warn("[UNreader] 迁移共享图片资源失败", e);
			});
			// 一条汇总，直接回答「那 12s 到底花在哪一段」：
			// `layout` = 等 Obsidian 布局就绪（本插件控制不了，时序约束见 explorerHeal.ts）；
			// `heal` / `excl` / `idle` / `read` = 本插件的四段。哪段大，锅就在哪。
			// -1 表示该段抛异常被 catch 了（消息里另有一条 warn）。
			debugLog.info(
				`[startup] layout=${msLayout}ms legacy=${msLegacy}ms nest=${msNest}ms heal=${msHeal}ms excl=${msExcl}ms idle=${msIdle}ms read=${Date.now() - tRead}ms`,
			);
		})().catch(e => {
			console.warn("[UNreader] 数据就绪链失败", e);
		});

		// 预设内容随库同步（各端共享同一批预设）；启用状态在本机 localStorage 不同步。
		// 同步是异步的：预设文件在插件启动后才到达 → 监听 vault 事件重扫，保证他端
		// 新增/修改/删除的预设即时出现在面板里（去抖，本机未落盘写回不会被覆盖）
		{
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
			// 每次调用读**活绑定**（paths.ts）：切数据落点后的事件必须跟着新目录走，
			// 不能在 onload 时就捕获成常量（那样切根后预设变化永远不再重扫）。
			const underPresets = (path: string): boolean =>
				path === PRESETS_FOLDER || path.startsWith(`${PRESETS_FOLDER}/`);
			this.registerEvent(this.app.vault.on("create", f => { if (underPresets(f.path)) scheduleRescan(); }));
			this.registerEvent(this.app.vault.on("modify", f => { if (underPresets(f.path)) scheduleRescan(); }));
			this.registerEvent(this.app.vault.on("delete", f => { if (underPresets(f.path)) scheduleRescan(); }));
			this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
				if (underPresets(f.path) || underPresets(oldPath)) scheduleRescan();
			}));
		}

		// 书籍改名 / 删除时同步书架元数据。分类和“手动移除”按路径记录；
		// 若不同步，改名后的书会丢分类，删除的书还会留下永远不可见的隐藏记录。
		this.registerEvent(this.app.vault.on("delete", f => {
			const bookshelfChanged = this.pruneBookshelfPaths(f.path);
			const notesChanged = this.pruneMarkdownNotePaths(f.path);
			if (!bookshelfChanged && !notesChanged) return;
			void this.persistData();
			if (bookshelfChanged) this.refreshBookshelfPanels();
			if (notesChanged) {
				this.mdOverlay?.applySettingsAll();
				this.refreshMarkdownNotePanels();
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
			const bookshelfChanged = this.migrateBookshelfPaths(oldPath, f.path);
			const notesChanged = this.migrateMarkdownNotePaths(oldPath, f.path);
			if (!bookshelfChanged && !notesChanged) return;
			void this.persistData();
			if (bookshelfChanged) this.refreshBookshelfPanels();
			if (notesChanged) {
				this.mdOverlay?.applySettingsAll();
				this.refreshMarkdownNotePanels();
			}
		}));

		// 启动时扫描自定义字体（字体文件随库同步到各端，每端按需建 blob URL）。
		// 共享资源随库同步：他端新增/替换/删除图片或字体后，本端自动重扫。
		{
			let resourceRescanTimer: number | null = null;
			const scheduleResourceRescan = (): void => {
				if (resourceRescanTimer) window.clearTimeout(resourceRescanTimer);
				resourceRescanTimer = window.setTimeout(() => {
					resourceRescanTimer = null;
					void this.dataReady.then(async () => {
						await this.resourceStore.reload();
						await this.refreshCustomFonts();
						this.refreshAppearanceEverywhere();
					}).catch(() => {});
				}, 800);
			};
			const underResources = (path: string): boolean =>
				path === FONTS_FOLDER || path.startsWith(`${FONTS_FOLDER}/`)
				|| path === RESOURCES_FOLDER || path.startsWith(`${RESOURCES_FOLDER}/`);
			this.registerEvent(this.app.vault.on("create", f => { if (underResources(f.path)) scheduleResourceRescan(); }));
			this.registerEvent(this.app.vault.on("modify", f => { if (underResources(f.path)) scheduleResourceRescan(); }));
			this.registerEvent(this.app.vault.on("delete", f => { if (underResources(f.path)) scheduleResourceRescan(); }));
			this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
				if (underResources(f.path) || underResources(oldPath)) scheduleResourceRescan();
			}));
		}

		// UNagent 替我们写数据文件后的即时重扫（显式通道，见 VAULT_WRITE_EVENT 的注释）。
		// 与上面两条 Vault 监听并存：那条是「任何来源写入」的兜底，这条只保证
		// 「Agent 刚写完」的那一次立刻反映到已打开的界面上。
		{
			// 串行化：一次 Agent 操作可能连发几条事件，而重扫是「清空 + 重建」——并发
			// 跑会互相覆盖，后到的那份反而可能基于旧快照。排队保证最后一次读到的是
			// 最终磁盘状态。
			let tail: Promise<void> = Promise.resolve();
			const onExternalWrite = (ev: Event): void => {
				const detail = (ev as CustomEvent<{ paths?: unknown }>).detail;
				const raw = Array.isArray(detail?.paths) ? detail.paths : [];
				const paths = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
				if (paths.length === 0) return;
				debugLog.info(`[agent-write] ${paths.join(", ")}`);
				tail = tail
					.then(() => this.refreshFromExternalWrite(paths))
					.catch(() => undefined);
			};
			window.addEventListener(VAULT_WRITE_EVENT, onExternalWrite);
			this.register(() => window.removeEventListener(VAULT_WRITE_EVENT, onExternalWrite));
		}

		// **排在 `onLayoutReady` 之后**：本方法开头会 `ensureLibraryFolders()`（vault.createFolder
		// = 库事件），而移动端启动瞬间正是官方文件列表虚拟化测量最敏感的窗口 ——
		// 库事件会把 FileExplorerView 推进一次 `compute()`，若此时左抽屉还是
		// `display:none`（它创建时就是隐藏的），当趟测到的条目会被官方永久打上
		// `hidden`（详见 `src/ui/explorerHeal.ts` 的逐行取证）。挪到布局就绪后开跑。
		// 2026-09-19 起再往后挪一档：**等主线程真正闲下来**才读盘建 blob，理由见
		// `prewarmCustomFonts` 的注释。
		this.app.workspace.onLayoutReady(() => {
			this.migrateExistingNativeSidebarLeaf();
			void this.prewarmCustomFonts().catch(e => console.warn("[UNreader] refresh custom fonts failed", e));
		});

		// 移动端文件列表自愈：官方移动端文件列表住在左抽屉里，而抽屉收起时
		// `display:none` → 虚拟化一旦在收起窗口里量过，条目就被永久 `hidden`
		// （「夹子在、内容不显示」）。本守卫在抽屉展开时补一次全量重测
		// —— 即官方「显示不支持的文件」开关内部做的动作。见 explorerHeal.ts。
		const explorerHeal = new ExplorerHeal(this.app, Platform);
		explorerHeal.start();
		this.register(() => explorerHeal.stop());

		// markdown 阅读视图叠加层（进度条 / 章节目录条 / 沉浸）：只寄生官方阅读模式
		// 视图，.md 文件本身仍由 Obsidian 原生编辑器管理（不注册扩展名、不进书架）。
		// 格式开关（设置 → 阅读格式）关掉 Markdown 时整个叠加层不启动 —— .md 照常
		// 由 Obsidian 原生阅读，只是没有进度条/目录条/沉浸（见 core/readableFormats.ts）。
		if (isMdFormatEnabled(this.settings.disabledFormats)) {
			const mdOverlay = new MdOverlayManager(this.app, this);
			mdOverlay.start();
			this.register(() => mdOverlay.stop());
			this.mdOverlay = mdOverlay;
		}

		// 隔离墙（core/fileGate.ts）：笔记索引里可能存着历史版本写进去的「伪 markdown」
		// （Excalidraw 的 `*.excalidraw.md` 等）。入口判据只挡新记录，**存量必须自己清**
		// —— 否则用户还会在笔记列表里看到那个绘图文件。三种时机都要跑：
		//   ① 启动一次（settings 已就绪，但官方索引往往还没建好）；
		//   ② `resolved`（官方首轮索引完成）；
		//   ③ `changed`（兼容模式下文件名只以 .md 结尾，判据依赖 frontmatter，
		//      只有索引建立后才能识别 —— 这一步不能省）。
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleNoteIndexPurge()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleNoteIndexPurge()));
		this.scheduleNoteIndexPurge();
		this.register(() => {
			if (this.noteIndexPurgeTimer != null) window.clearTimeout(this.noteIndexPurgeTimer);
			this.noteIndexPurgeTimer = null;
		});

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
		// 格式开关（设置 → 阅读格式）：被关掉的书籍格式**根本不注册** —— 双击落到
		// Obsidian 默认处理，比「注册了再拒绝」更接近「这个格式没装过插件」。
		// ⚠️ 注册只发生在 onload ⇒ 开关改动要重载插件 / 重启 Obsidian 才完全生效
		// （设置页文案与关闭时的 Notice 都已说明）；重载前已开着的阅读器由
		// readerView.loadBook 的隔离墙当场拒绝，不会白屏。
		for (const ext of READER_BOOK_EXT_ORDER) {
			if (!isBookExtEnabled(ext, this.settings.disabledFormats)) {
				console.warn(`[UNreader] .${ext} 的阅读功能已在设置 → 阅读格式 中停用，本次不注册`);
				continue;
			}
			try {
				this.registerExtensions([ext], VIEW_TYPE_UNREADER);
			} catch (e) {
				console.warn(`[UNreader] 扩展名 .${ext} 已被占用，跳过（该类文件交由占用方打开）`, e);
			}
		}
		this.registerView(VIEW_TYPE_UNREADER, leaf => new UNreaderView(leaf, this));
		this.registerView(VIEW_TYPE_UNREADER_SIDEBAR, leaf => new UNreaderSidebarView(leaf, this));
		this.addSettingTab(new UNreaderSettingTab(this.app, this));
		// 固定入口复用已有侧栏打开路径，沿用位置偏好和页面记忆。
		const sidebarRibbon = this.addRibbonIcon("book-open", t("cmdOpenReader"), () => {
			void this.openReader();
		});
		this.register(onLangChange(() => {
			sidebarRibbon.setAttribute("aria-label", t("cmdOpenReader"));
		}));

		// 跟踪最近活动的阅读视图（命令解析兜底的数据源之一）
		this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
			if (!leaf) return;
			if (leaf.view instanceof UNreaderSidebarView) return;
			try {
				if (leaf.view?.getViewType() === VIEW_TYPE_UNREADER) {
					this.lastReader = leaf.view as UNreaderView;
				}
			} catch { /* ignore */ }
			if (leaf.view instanceof UNreaderView) this.updateNativeSidebarContext(leaf.view.getNativeSidebarContext(), leaf);
			else if (leaf.view instanceof MarkdownView) this.updateNativeSidebarContext(this.mdOverlay?.getNativeSidebarContext(leaf) ?? null, leaf);
			else this.updateNativeSidebarContext(null, leaf);
			this.syncNativeSidebarToolbarButtons();
			// 笔记阅读计时：Markdown 笔记走的是**官方**阅读模式（不是我们的视图），
			// 所以「正在读哪篇笔记」只能从活动叶子推。
			this.syncNoteReadingTimer();
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			this.migrateExistingNativeSidebarLeaf();
			this.syncNativeSidebarToolbarButtons();
		}));

this.registerCommands();
		this.scheduleReleaseNotesReminder();
	}

	/**
	 * 注册全部命令。**独立成方法而非内联在 onload**，是为了支持界面语言切换后的
	 * 重注册：`reapplyCommands()` 先按 `commandIds` 逐个 removeCommand，再走一遍本
	 * 方法 —— 命令名带 `t()`，重注册后命令面板立即显示新语言，无需重载插件。
	 *
	 * 命令 id 是持久化契约（用户会在快捷键设置里绑定它们），**任何情况下不得改名**，
	 * 语言只影响 `name`。
	 */
	private registerCommands(): void {
		// Obsidian 的 removeCommand 收全 id（`unreader:xxx`），而 addCommand 的返回值
		// 类型在不同版本间不稳，所以自己攒一份已注册 id 清单。
		this.addCommand({
			id: "open-reader",
			name: t("cmdOpenReader"),
			callback: () => {
				void this.openReader();
			},
		});
		this.addCommand({
			id: "view-release-notes",
			name: t("cmdReleaseNotes"),
			callback: () => this.openReleaseNotes(),
		});
		this.addCommand({
			id: "open-book",
			name: t("cmdOpenBook"),
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
				new Notice(t("noticeNoActiveReader"));
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
			name: t("cmdToggleAnnotations"),
			callback: () => withReader(view => view.toggleAnnotations()),
		});
		this.addCommand({
			id: "toggle-bookshelf",
			name: t("cmdToggleBookshelf"),
			callback: () => { void this.openSidePanel("bookshelf"); },
		});
		this.addCommand({
			id: "toggle-feeds",
			name: t("cmdToggleFeeds"),
			callback: () => {
				// RSS 停用时侧栏「订阅」页签已消失（两个装配路径都过滤），命令必须给
				// 可操作提示（指向设置），不能静默无反应，也不能默默落到书架页。
				if (!isRssFormatEnabled(this.settings.disabledFormats)) {
					new Notice(t("noticeRssFormatDisabled"));
					return;
				}
				void this.openSidePanel("feeds");
			},
		});
		// 侧栏位置（用户 2026-10-17）：默认落左侧；这条命令左右切换，**没打开时直接去右侧**。
		// 它与「打开书架 / 订阅」互补：那两条读偏好侧，切换命令翻转偏好 —— 所以切过一次之后
		// 「打开」不会又把它搬回来（否则切换等于白切）。
		this.addCommand({
			id: "toggle-sidebar-side",
			name: t("cmdToggleSidebarSide"),
			callback: () => { void this.toggleNativeSidebarSide(); },
		});
		this.addCommand({
			id: "refresh-feeds",
			name: t("cmdRefreshFeeds"),
			callback: () => { void this.refreshAllFeeds(); },
		});
		this.addCommand({
			id: "add-feed",
			name: t("cmdAddFeed"),
			callback: () => this.promptAddFeed(),
		});
		this.addCommand({
			id: "open-next-unread-feed",
			name: t("cmdNextUnreadFeed"),
			callback: () => { void this.openNextUnreadFeed(); },
		});
		this.addCommand({
			id: "toggle-toc",
			name: t("cmdToggleToc"),
			callback: () => withReader(view => view.toggleTocPanel()),
		});
		// markdown 阅读视图的沉浸会话：只作用于官方阅读模式视图（不碰 .md 文件本身，
		// 见 ui/mdOverlay.ts）。沿用「callback + 运行时兜底 + Notice」习惯，必不静默。
		this.addCommand({
			id: "toggle-md-immersion",
			name: t("cmdToggleMdImmersion"),
			callback: () => {
				// mdOverlay 为 null 有两种来路：Markdown 阅读增强被格式开关关掉
				// （设置 → 阅读格式），或 onload 没跑完。前者必须给可操作的提示
				// （指向设置），不能静默 return ——「命令没反应」是最难归类的报障。
				if (!this.mdOverlay) {
					if (!isMdFormatEnabled(this.settings.disabledFormats)) {
						new Notice(t("noticeMdFormatDisabled"));
					}
					return;
				}
				if (this.settings.mdOverlayImmersive === false) {
					new Notice(t("noticeMdOverlayOff"));
					return;
				}
				if (!this.mdOverlay.toggleImmersionOnActiveLeaf()) {
					new Notice(t("noticeNoMdReadingView"));
				}
			},
		});
		this.addCommand({
			id: "add-bookmark",
			name: t("cmdAddBookmark"),
			callback: () => withReader(view => view.openBookmarkModal()),
		});
		// 选区翻译（M2，经 UNagent 桥）：取选区走 getSelectionForExternal —— 与三方
		// 插件同一接口（含 10s lastExcerpt 兜底与脚注气泡内选区优先）。
		this.addCommand({
			id: "translate-selection",
			name: t("cmdTranslateSelection"),
			callback: () => withReader(view => {
				const selection = view.getSelectionForExternal();
				if (!selection?.text.trim()) {
					new Notice(t("noticeNoSelectionToTranslate"));
					return;
				}
				view.translateSelection(selection.text);
			}),
		});
		// 高亮选中文本（六色）：自定义按钮的验收场景要求「高亮」本身是可绑定命令 ——
		// 划词色点走的是工具条回调，命令面板里没有对应命令。阅读器与 md 阅读视图都接：
		// 阅读器优先（含 lastReader 兜底），否则交给 md 叠加层的活动会话；两者都要求
		// 「选区缓存被清时主动重采」，见各自的 highlightCurrentSelection 实现。
		for (const color of HIGHLIGHT_COLORS) {
			this.addCommand({
				id: `highlight-selection-${color.name}`,
				name: tf("cmdHighlightSelection", { color: highlightColorLabel(color.name, color.label) }),
				callback: () => {
					const reader = this.getActiveReader();
					if (reader) {
						reader.highlightCurrentSelection(color.name);
						return;
					}
					if (this.mdOverlay?.highlightSelectionOnActiveLeaf(color.name)) return;
					new Notice(t("noticeNoSelectionToHighlight"));
				},
			});
		}
		this.addCommand({
			id: "toggle-appearance",
			name: t("cmdToggleAppearance"),
			callback: () => withReader(view => view.toggleAppearance()),
		});
		this.addCommand({
			id: "toggle-full-immersion",
			name: t("cmdToggleFullImmersion"),
			callback: () => withReader(view => view.toggleFullImmersion()),
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
			name: t("cmdSnapshotNeighborUi"),
			callback: () => {
				void this.snapshotNeighborUi();
			},
		});

		this.addCommand({
			id: "export-debug-log",
			name: t("cmdExportDebugLog"),
			callback: () => {
				void this.exportDebugLog();
			},
		});
	}

	/**
	 * 界面语言切换后重注册命令：`setLang` 之后再走一遍 `registerCommands()`。
	 *
	 * 为什么要先 remove：Obsidian 的 `addCommand` 只在 id 未被占用时可用，重复
	 * 注册会静默沿用旧条目（命令名停留在旧语言）。remove 全部再注册是唯一能让
	 * 命令面板立刻刷新名字的做法 —— 用户不该为了换个语言去重启 Obsidian。
	 *
	 * 已绑定的快捷键不受影响：快捷键绑定按命令 id 记录，而 id 是持久化契约，
	 * 全程不变。
	 */
	reapplyCommands(): void {
		for (const fullId of this.commandIds) {
			try {
				this.removeCommand(fullId);
			} catch {
				// 单个命令移除失败（极老版本的 removeCommand 缺失）不该中断整批。
			}
		}
		this.commandIds.clear();
		this.registerCommands();
	}

	/**
	 * 设置页语言开关的落地入口：落盘偏好 → 更新 i18n 单例 → 重注册命令。
	 *
	 * `setLang` 内部会通知所有 `onLangChange` 订阅者（阅读器 / 标注面板等视图在
	 * 那里订阅并重画），所以这里**不需要**逐个视图手动刷新。
	 */
	async applyLanguage(pref: LangPref): Promise<void> {
		this.settings.language = normalizeLangPref(pref);
		setLang(resolveLang(this.settings.language));
		this.getActiveReader()?.refreshAppearancePanel();
		this.mdOverlay?.refreshLanguageAll();
		await this.persistData();
		this.reapplyCommands();
	}

	/** 采集并落盘相邻界面快照（见 `explorerDiag`）。**故意不依赖调试日志开关**：
	 *  这条排查路径上用户往往把日志关着，而证据必须落盘。 */
	private async snapshotNeighborUi(): Promise<void> {
		try {
			// 插件自己的 root 直接在宿主里查（readerView.rootEl 是私有的，不为一次性诊断开口子）
			const ownRoot = document.querySelector<HTMLElement>(".unreader-root");
			const facts = collectNeighborFacts(ownRoot);
			// 划词工具条「被官方快速编辑栏遮挡」的现场几何（见 `selectionDiag`）。
			//
			// 为什么挂在**这个**命令上：那条故障在夹具里复现不出来（真机 `test:md-kb`
			// 46/46 全绿），只能靠真机落盘的原始几何定位；而工具条是**边沿触发的瞬时物**
			// ——命令面板一点屏就收起它，现场快照类诊断「永远拍到健康的病人」。
			// `selectionDiag` 是**被动记录**的环形缓冲（最后一次划词的几何留在里面），
			// 开启调试后记录的现场可由这条手动命令一并导出。
			facts.selectionToolbar = readSelectionDiag();
			debugLog.info("[neighbor-ui]", facts);
			const text = JSON.stringify(facts, null, 2);
			const path = await writeReport(this.app, "unreader-neighbor", text);
			new Notice(tf("noticeSnapshotSaved", { path }));
		} catch (err) {
			debugLog.error("[neighbor-ui] snapshot failed", err);
			new Notice(t("noticeSnapshotFailed"));
		}
	}

	/** 把诊断缓冲写到库根（落点与设置页「保存到库」一致 —— 库内普通文件会随同步
	 *  走、且 agent 能直接读盘；插件目录里的东西默认不参与同步，把证据留在离线
	 *  设备上等于没有）。 */
	private async exportDebugLog(): Promise<void> {
		if (debugLog.entryCount() === 0) {
			new Notice(t("noticeDebugLogEmpty"));
			return;
		}
		try {
			const path = await saveDebugReportToVault(this.app);
			new Notice(tf("noticeDebugLogSaved", { path }));
		} catch (err) {
			debugLog.error("[export-debug-log]", err);
			new Notice(t("noticeDebugLogExportFailed"));
		}
	}

	onunload(): void {
		debugLog.setDebugEnabled(false);
		this.unloaded = true;
		this.flushSave();
		// 退出/禁用/重载插件时先把阅读视图的当前位置交出来：视图层的去抖（800ms）
		// 可能还没把这一拍的位置递给进度库，而下面那行只 flush「已经进库的」
		// —— 少了这一步，「读到一半直接退出 Obsidian」就丢掉最后那段阅读位置。
		try { this.lastReader?.forceFlushPosition(); } catch { /* ignore */ }
		// 待写盘的进度立即落库（卸载后没有机会再写）
		void this.progress?.flush();
		// 阅读计时：先停表结算（把最后这一段补进统计），再落盘。
		try { this.readingTimer?.stopAll(); } catch { /* ignore */ }
		void this.readingStats?.flush();
		void this.presetStore?.flush();
		void this.feedStore?.flush();
		try { this.feedService?.close(); } catch { /* ignore */ }
		try { this.feedMediaStore?.releaseSessionUrls(); } catch { /* ignore */ }
		// 插件卸载时释放自定义字体 blob URL
		try { clearCustomFonts() } catch { /* ignore */ }
		// 释放书架卡片缓存的封面 blob URL
		try { clearBookPreviewCache() } catch { /* ignore */ }
		// 释放共享图片 blob URL 并解除引擎解析器
		try { this.resourceStore?.dispose(); setActiveResourceStore(null); } catch { /* ignore */ }
		// 兜底只清旧版插件类；官方 is-hidden-nav 的释放由 NativeChromeGate 按 owner
		// 恢复到接管前状态，不能在这里覆盖 Obsidian 自己的自动全屏状态。
		try {
			document.body.removeClass("unreader-nav-hidden");
		} catch { /* ignore */ }
		// 同理：排除项写在用户的 `.obsidian` 配置里，失活必须摘掉我们登记的那几条
		// （用户自己的原样保留），否则插件禁用后仍在改用户的搜索行为。
		clearVaultExclusions(this.app);
	}

	/** 记录/清除存活阅读视图（由 readerView 在加载完成、获得焦点与关闭时调用） */
	noteActiveReader(view: UNreaderView): void {
		this.lastReader = view;
		const active = this.app.workspace.activeLeaf;
		if (active === view.leaf || active?.view instanceof UNreaderSidebarView) {
			this.updateNativeSidebarContext(view.getNativeSidebarContext(), view.leaf);
		}
	}

	forgetActiveReader(view: UNreaderView): void {
		if (this.lastReader === view) this.lastReader = null;
		if (this.nativeSidebarContextOwner === view || this.nativeSidebarContextOwner === view.leaf) this.updateNativeSidebarContext(null);
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

	/** 阅读外观变化后的**统一刷新漏斗**：把「字体 / 字号 / 行距 / 字距」重刷进两个宿主。
	 *
	 *  以前每个资源/字体刷新点都只写 `getActiveReader()?.refreshAppearance()` —— 那对
	 *  电子书 / RSS 够用，但**纯 markdown 读者没有活动阅读器**（`getActiveReader()` 恒
	 *  null），md 叠加层的抽屉就收不到这一针。而 `resolveAppearance` 在字体 id 尚未进
	 *  `customFontRegistry` 时会静默回落到 `--font-text`（= 笔记字体），注册表的填充是
	 *  异步的（启动预热至少 1.2s）⇒ 抽屉会**永久**停在回落值上（用户 2026-10-12 报
	 *  「md 高亮侧栏的字体应该跟插件设置一致、现在却跟笔记字体一致」）。
	 *
	 *  ⚠️ 新增任何「改了 settings.appearance 或重扫了字体」的路径都要走这里，不要再
	 *  单写 `getActiveReader()?.refreshAppearance()`（既漏 md，也漏将来第三个宿主）。 */
	refreshAppearanceEverywhere(): void {
		try { this.getActiveReader()?.refreshAppearance(); } catch { /* 没有打开的阅读器 */ }
		this.mdOverlay?.refreshAppearanceAll();
	}

	/** 自定义按钮的统一命令执行入口（侧栏 / 划词两条按钮路共用）。
	 *  命令不存在 / 返回 false / 抛错都给明确提示，绝不静默 —— 与本插件
	 *  「callback + Notice 兜底」的命令口径一致（main.ts 命令注册段注释）。 */
	runCustomButtonCommand(commandId: string): void {
		const exists = this.commandExists(commandId);
		if (!exists) {
			new Notice(`命令不可用（可能已被移除或对应插件未启用）：${commandId}`);
			return;
		}
		try {
			const ret = (this.app as unknown as {
				commands?: { executeCommandById?: (id: string) => unknown };
			}).commands?.executeCommandById?.(commandId);
			if (ret === false) new Notice(`命令未能执行：${commandId}`);
		} catch (err) {
			new Notice(`命令执行失败：${commandId}`);
			debugLog.info("[custom-buttons] executeCommandById threw", String(err));
		}
	}

	/** 命令是否仍注册着（置灰判据）。listCommands 优先，退回读 commands 字典，
	 *  与 readerView.findCommandForHotkey 的双路取法一致。 */
	commandExists(commandId: string): boolean {
		const cmds = (this.app as unknown as {
			commands?: {
				listCommands?: () => Array<{ id: string }>;
				commands?: Record<string, unknown>;
			};
		}).commands;
		try {
			if (typeof cmds?.listCommands === "function") {
				return cmds.listCommands().some(c => c.id === commandId);
			}
		} catch { /* ignore */ }
		return !!cmds?.commands?.[commandId];
	}

	/** 设置变更后把按钮配置同步到所有已打开的阅读器与 md 阅读会话（不重开视图）。 */
	refreshCustomButtons(): void {
		try {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER)) {
				const view = leaf.view;
				if (view instanceof UNreaderView) view.syncCustomButtons();
			}
		} catch { /* ignore */ }
		this.mdOverlay?.refreshCustomButtonsAll();
	}

	/** 确保当前数据根下的插件目录存在（根 + `Data/` 容器 + 数据子目录）。
	 *  路径读的是 `core/paths.ts` 的**活绑定**：`setLibraryRoot` 换根后本方法就跟着建
	 *  新根，不会在旧位置重建空壳。`Books/` 已退役（2026-09-19）：不再创建 ——
	 *  书放在库里任何位置都能读（见 `bookService.getBookFiles`），换数据落点**不搬书**。
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
			for (const sub of [UNREADER_ROOT, DATA_FOLDER, FONTS_FOLDER, RESOURCES_FOLDER, IMAGES_FOLDER, PRESETS_FOLDER, PROGRESS_FOLDER, NOTES_FOLDER, STATS_FOLDER]) {
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
		await syncVaultExclusions(this.app, { excludeNotes: this.settings.excludeNotesFromSearch !== false });
	}

	/** 预检「把数据落点切到 `next`」要搬哪些文件。只读：不建目录、不改任何状态。 */
	planDataFolder(next: string | null): LibraryMigrationPlan {
		return planDataFolderMigration(this.app, this.settings.dataFolder, next);
	}

	/** 切换插件**数据**的落点（`next = null` → 默认根 `UNreader/`）。
	 *  `migrate=false` 时只切不搬（用户明确选择「文件我自己处理」）。
	 *
	 *  **书籍一律不搬**：书放在库里任何位置都能读（`bookService.getBookFiles` 全库扫描），
	 *  所以进度键（书籍完整路径的 djb2 hash）、书架顺序 / 置顶、笔记 frontmatter 里的
	 *  书籍链接、他端的同步身份**全都不需要改** —— 这正是「只搬数据」比「搬书」简单
	 *  且安全的地方。搬的是 `paths.ts` 里的 `DATA_SUBFOLDERS`：
	 *  Progress / Presets / Fonts / Resources / Notes。
	 *
	 *  顺序有硬约束（每一步都是为了上一步的结果不被下面覆盖）：
	 *   ① 先把两份存储的去抖写入 `flush` 到**旧根** —— 它们构造时就捕获了旧目录，
	 *      下面重建后未落盘的改动会写到新根（落错地方）甚至丢失；
	 *   ② 迁移（`migrate=false` 时跳过）；失败即中止，**不切根**，保持旧状态可用；
	 *   ③ `setConfiguredDataFolder` —— 活绑定生效，此后所有路径读取立刻指向新根；
	 *   ④ 改写字体引用：字体 id 是 `custom:<库内路径>`，搬 `Fonts/` 会让这四处全部悬空；
	 *   ⑤ 重建存储并读新目录；
	 *   ⑥ 落盘 settings（`dataFolder` 换新值）。
	 */
	async applyDataFolder(next: string | null, options: { migrate: boolean }): Promise<DataFolderSwitchResult> {
		const target = normalizeDataFolder(next);
		const fromRoot = dataRootOf(this.settings.dataFolder);
		const toRoot = dataRootOf(target);
		const failed = (error: string): DataFolderSwitchResult =>
			({ ok: false, error, moved: 0, removedEmpty: 0, rewrote: 0 });
		if (fromRoot === toRoot) {
			this.settings.dataFolder = target;
			await this.persistData();
			return { ok: true, moved: 0, removedEmpty: 0, rewrote: 0 };
		}
		// 存储首次读盘还没完成时切根：它们的 init 会把**旧根**读完（甚至按旧根写回），
		// 之后再重建等于白读一遍。先等到它就绪（正常情况下早已 resolve）。
		await this.whenDataReady().catch(() => undefined);
		await this.progress.flush().catch(() => undefined);
		await this.presetStore.flush().catch(() => undefined);

		let moved = 0;
		let removedEmpty = 0;
		if (options.migrate) {
			const plan = this.planDataFolder(target);
			if (plan.collisions.length) {
				return failed(`目标位置已有 ${plan.collisions.length} 个同名文件（如「${plan.collisions[0]}」），请先处理冲突`);
			}
			const result = await migrateDataFolder(this.app, plan);
			if (result.error) {
				debugLog.warn("[dataFolder] 迁移失败", result.error, result.rollbackFailures);
				const suffix = result.rollbackFailures.length ? `；${result.rollbackFailures.length} 个文件未能自动回滚` : "";
				return failed(`${result.error}${suffix}`);
			}
			moved = result.moved.length;
			removedEmpty = result.removedEmpty.length;
		}

		setConfiguredDataFolder(target);
		await this.ensureLibraryFolders();
		// 旧根下的字体可能在规范位（`Data/Fonts`），也可能是上一轮容器迁移因重名
		// 跳过的平铺残留（`Fonts`）—— 两个来源都映射到新根的 `Data/Fonts`。
		const rewrote = await rewriteFontReferences(
			this.app,
			this.settings,
			[`${fromRoot}/Fonts`, `${fromRoot}/${DATA_DIR_NAME}/Fonts`],
			FONTS_FOLDER,
		);
		this.settings.dataFolder = target;
		await this.persistData();
		await this.rebuildStores();
		this.refreshAppearanceEverywhere();
		return { ok: true, moved, removedEmpty, rewrote };
	}

	/** 按**当前**数据根重建三份存储。
	 *
	 *  必须重建，不能只改字段：`ProgressStore` / `PresetStore` 在构造时就把目录字符串
	 *  捕获成了私有字段，`ResourceStore` 的默认参数同理 —— `core/paths.ts` 的活绑定只对
	 *  **每次读取**的调用点有效，构造期捕获的值不会跟着变。 */
	private async rebuildStores(): Promise<void> {
		try { this.resourceStore?.dispose(); } catch { /* ignore */ }
		this.progress = new ProgressStore(this.app.vault, PROGRESS_FOLDER, this.deviceScope());
		// 统计库同样在构造期捕获目录 ⇒ 一起重建；重建前先把旧根那份待写盘的数据落地。
		try { await this.readingStats?.flush(); } catch { /* ignore */ }
		this.readingStats = new ReadingStatsStore(this.app.vault, STATS_FOLDER, this.deviceScope());
		setActiveReadingStats(this.readingStats);
		this.presetStore = new PresetStore(this.app.vault, PRESETS_FOLDER, this.app.fileManager);
		this.resourceStore = new ResourceStore(this.app.vault, this.app.fileManager);
		setActiveResourceStore(this.resourceStore);
		this.feedStore = new FeedStore(this.app.vault, this.deviceScope(), this.feedCachePluginDir());
		this.feedService = new FeedService(this.feedStore, () => this.settings.feeds);
		this.feedMediaStore = new FeedMediaStore(() => this.settings.feeds);
		await Promise.all([
			this.progress.init(this.settings.positions).then(n => {
				// 与 onload 的链首同一口径：迁移完就清空旧字段（见那里的长注释）
				if (n > 0) {
					this.settings.positions = {};
					this.scheduleSave();
				}
			}).catch(e => console.warn("[UNreader] 进度库重建失败", e)),
			this.presetStore.init(this.settings.appearancePresets).catch(e => console.warn("[UNreader] 预设库重建失败", e)),
			this.resourceStore.init().catch(e => console.warn("[UNreader] 共享资源库重建失败", e)),
			this.feedStore.init().catch(e => console.warn("[UNreader] 订阅库重建失败", e)),
		]);
		// 字体文件路径全变了：重扫会把新路径建成新 blob，并回收旧路径的缓存（见 doRefreshCustomFonts）
		await this.refreshCustomFonts().catch(e => console.warn("[UNreader] 字体重扫失败", e));
	}

	/** 启动期的字体预热：**等主线程真正闲下来之后**才去读盘、建 blob。
	 *
	 *  ## 为什么要这么绕（2026-09-19 启动卡顿专项）
	 *
	 *  原先这里是 `onLayoutReady(() => refreshCustomFonts())` —— 紧跟布局就绪。
	 *  而这一步的真实成本是「读被外观/预设引用的那几枚字库 + `new Blob` +
	 *  `createObjectURL`」：作者库里 2 枚 CJK 字库合计 ~50MB，桌面实测 ≈54ms，
	 *  移动端 WebView（iCloud 上未下载的文件要现拉、`createObjectURL` 还要按
	 *  blob 尺寸走一遍渲染器）是数百 ms 到秒级。它落地的时刻恰好与「首屏绘制 +
	 *  workspace 恢复 + 其它插件各自启动」重叠，于是表现为用户报的
	 *  **「界面已经画出来了，但几秒内点什么都没反应，恢复后操作一次性涌出」**。
	 *
	 *  ## 语义不变
	 *
	 *  这里做的只是**提前备好**。任何真正的消费点（开书、外观面板选中字体的
	 *  `ensureFontReady`、资源变化重扫）都会各自 await `refreshCustomFonts()`，
	 *  单飞行去重保证同一轮只读一次盘 —— 用户若在这个窗口里打开书，那一次就由
	 *  开书路径自己承担，与「没有预热」的旧版本完全一致，不会少东西。
	 *
	 *  慢机器上最迟 `FONT_PREWARM_MAX_DELAY_MS` 放行：预热不该被无限期饿死，
	 *  否则「开书零等待」这个它存在的理由就没了。
	 */
	private async prewarmCustomFonts(): Promise<void> {
		const started = Date.now();
		await new Promise<void>(resolve => window.setTimeout(resolve, FONT_PREWARM_DELAY_MS));
		// 固定让路之后，再逐片试探：`idleYield` 兑现得快 = 这一片确实没有排队工作。
		// （空闲回调在忙时会被推迟到 timeout，或干脆被长任务压在后面 —— 那就会
		// 明显超过这里的阈值，于是再让一片。WebKit 没有 requestIdleCallback，
		// 回落是一枚 32ms 宏任务，语义同样是「本帧已经画完」。）
		while (Date.now() - started < FONT_PREWARM_MAX_DELAY_MS) {
			const t = Date.now();
			await idleYield(250);
			if (Date.now() - t <= 48) break;
		}
		if (this.unloaded) return;
		await this.refreshCustomFonts();
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
		const push = (v: string | null | undefined): void => {
			if (v && this.resourceStore.isEnabled(v)) ids.add(v);
		};
		push(this.settings.appearance?.fontFamily);
		for (const p of this.settings.appearancePresets ?? []) push(p.appearance?.fontFamily);
		try {
			for (const p of this.presetStore?.list() ?? []) push(p.appearance?.fontFamily);
		} catch { /* ignore */ }
		return ids;
	}

	private async doRefreshCustomFonts(): Promise<CustomFont[]> {
		await this.ensureLibraryFolders();
		const fonts = scanCustomFonts(this.app, FONTS_FOLDER).filter(f => this.resourceStore.isEnabled(f.id));
		// 悬空引用自愈（见 core/fontRefRepair.ts）：数据根搬家后 `custom:<旧路径>` 的引用
		// 会静默失效（引擎查不到 id → 正文回落主题字体，不报错）。**必须排在下面算
		// `referencedFontIds()` 之前**：修完这一轮就能直接把 blob 建出来，用户不需要
		// 再手动重选一次字体。
		try {
			const repaired = repairDanglingFontRefs(this.settings, fonts, this.presetStore?.list() ?? []);
			if (repaired.settingsChanged) {
				// 外观快照存在**本机 localStorage**（永不随 data.json 同步，见 persistData）：
				// 只 scheduleSave 的话改写只活在内存里，下次启动又从旧快照读回悬空值 ——
				// 于是每次启动都要重修一遍，而首屏消费点（开书、应用预设）在预热跑完之前
				// 拿到的仍是旧 id。两份都要写。
				this.saveDeviceAppearance();
				this.scheduleSave();
			}
			// 库内预设走 store 落盘：它自带内容去重与 600ms 去抖，不会每次启动都写文件
			for (const preset of repaired.changedPresets) this.presetStore.upsert(preset);
			if (repaired.repairs.length) {
				debugLog.info(
					`[font] 悬空字体引用已自愈 ${repaired.repairs.length} 处：` +
					repaired.repairs.map(r => `${r.where}「${r.from}」→「${r.to}」`).join("；"),
				);
			}
		} catch (e) {
			console.warn("[UNreader] 字体引用自愈失败（不影响本轮扫描）", e);
		}
		const needed = this.referencedFontIds();
		// path → entry，最后按 fonts 顺序还原，保证并发完成顺序不影响结果顺序
		const byPath = new Map<string, { id: string; label: string; src: string; format: string }>();
		const pending: Promise<void>[] = [];
		let pendingBytes = 0;
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
			pendingBytes += st?.size ?? 0;
		}
		// 大批量读盘/建 blob 前先让出一个空闲片：这一步会同时发生在开书路径上
		// （`loadBook` 与读整包并行），大字体在移动端足以吃掉一帧甚至几帧。
		// 命中缓存时 `pending` 为空、不产生任何额外等待。
		if (pending.length && pendingBytes >= FONT_BLOB_YIELD_BYTES) await idleYield(120);
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
			// 字体注册表变了（字体刚扫出来 / blob 重建）⇒ 两个宿主的抽屉都要重刷排版。
			// 这是 md 侧字体回落自愈的**主路径**：注册表就绪后那一刻把 --anno-font-family
			// 从 --font-text 回落值改回真字体（纯 markdown 用户没有阅读器，旧写法漏了它）。
			this.refreshAppearanceEverywhere();
		}
		return fonts;
	}

	/** 自定义字体列表（外观面板用） */
	getCustomFonts(): CustomFont[] {
		return scanCustomFonts(this.app, FONTS_FOLDER).filter(f => this.resourceStore.isEnabled(f.id));
	}

	/** 资源引用被当前设备外观与预设使用的次数。 */
	private resourceUsageCount(ref: string): number {
		const fields = ["backgroundImage", "backgroundImageLight", "backgroundImageDark", "fontFamily"] as const;
		const refs: (string | null | undefined)[] = [];
		for (const field of fields) refs.push((this.settings.appearance as unknown as Record<string, unknown>)[field] as string | null | undefined);
		for (const preset of this.presetStore.list()) {
			for (const field of fields) refs.push((preset.appearance as unknown as Record<string, unknown>)[field] as string | null | undefined);
		}
		return refs.filter(value => value === ref).length;
	}

	/** 删除资源后清掉本机外观与所有预设里的悬空引用。 */
	private clearResourceReferences(id: string, kind: SharedResourceKind): void {
		const fields = kind === "font"
			? (["fontFamily"] as const)
			: (["backgroundImage", "backgroundImageLight", "backgroundImageDark"] as const);
		const clear = (appearance: AppearanceSettings): boolean => {
			const raw = appearance as unknown as Record<string, unknown>;
			let changed = false;
			for (const field of fields) {
				if (raw[field] !== id) continue;
				raw[field] = null;
				changed = true;
			}
			return changed;
		};

		if (clear(this.settings.appearance)) {
			this.saveDeviceAppearance();
			this.scheduleSave();
		}
		for (const preset of this.presetStore.list()) {
			if (!clear(preset.appearance)) continue;
			preset.appearance = { ...preset.appearance };
			this.presetStore.upsert(preset);
		}
	}

	/** 设置页打开统一资源管理器；启用、移除与删除都走同一套插件级逻辑。 */
	async openResourceManager(kind: SharedResourceKind, onChanged?: () => void): Promise<void> {
		await this.whenDataReady();
		const resources: ManagedResource[] = this.resourceStore.list(kind).map(resource => ({
			...resource,
			usedBy: this.resourceUsageCount(resource.id),
		}));
		const refresh = async (): Promise<void> => {
			if (kind === "font") await this.refreshCustomFonts();
			this.refreshAppearanceEverywhere();
			onChanged?.();
		};

		new ResourceManagerModal(this.app, kind, resources, {
			onToggle: async (id, enabled) => {
				await this.resourceStore.setEnabled(id, enabled);
				const resource = resources.find(item => item.id === id);
				if (resource) resource.enabled = enabled;
				await refresh();
			},
			onDelete: async resource => {
				const used = this.resourceUsageCount(resource.id);
				if (used > 0 && !await confirmAction(this.app, {
						title: t("resDeleteConfirmTitle"),
						body: tf("resDeleteConfirmBody", { name: resource.name, count: used }),
						cta: t("resManagerDelete"),
					destructive: true,
				})) return;
				if (!await this.resourceStore.remove(resource.id)) {
						new Notice(t("resDeleteFailed"));
					return;
				}
				const index = resources.findIndex(item => item.id === resource.id);
				if (index >= 0) resources.splice(index, 1);
				this.clearResourceReferences(resource.id, kind);
				await refresh();
					new Notice(tf("resDeleted", { name: resource.name }));
			},
		}).open();
	}

	/** 把旧版内联/预设内图片一次性迁移为共享图片引用。重复执行是幂等的。 */
	private async migrateLegacyImageResources(): Promise<void> {
		const fields = ["backgroundImage", "backgroundImageLight", "backgroundImageDark"] as const;
		let currentChanged = false;
		for (const field of fields) {
			const value = ((this.settings.appearance as unknown as Record<string, unknown>)[field] as string | null) ?? null;
			const imported = await this.resourceStore.importImageReference(value, field === "backgroundImageLight" ? "浅色背景" : field === "backgroundImageDark" ? "深色背景" : "背景图片");
			if (imported && imported !== value) {
				(this.settings.appearance as unknown as Record<string, unknown>)[field] = imported;
				currentChanged = true;
			}
		}
		if (currentChanged) {
			this.saveDeviceAppearance();
			this.scheduleSave();
		}

		for (const preset of this.presetStore.list()) {
			let changed = false;
			const dir = preset.dir ?? preset.name;
			for (const field of fields) {
				const value = ((preset.appearance as unknown as Record<string, unknown>)[field] as string | null) ?? null;
				let imported: string | null = null;
				if (value?.startsWith("preset:")) {
					const file = value.slice("preset:".length);
					const ext = (file.split(".").pop() ?? "png").toLowerCase();
					imported = await this.resourceStore.importImage({
						name: (file.split(".").shift() || preset.name),
						ext,
						sourcePath: `${PRESETS_FOLDER}/${dir}/${file}`,
					});
				} else {
					imported = await this.resourceStore.importImageReference(value, preset.name);
				}
				if (imported && imported !== value) {
					(preset.appearance as unknown as Record<string, unknown>)[field] = imported;
					changed = true;
				}
			}
			if (changed) this.presetStore.upsert(preset);
		}
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

	/** 兼容入口：既有命令/快捷键继续可用，但只打开独立侧栏，不动正文阅读内容。 */
	async openReader(): Promise<void> {
		await this.openSidePanel();
	}

	/** 原生侧栏里的列表/标注都复用一份内容身份，切换正文时不会串到上一份数据。 */
	getNativeSidebarContext(): NativeSidebarContext | null { return this.nativeSidebarContext; }

	clearNativeSidebarAnnotationTarget(): void {
		this.nativeSidebarAnnotationSequence++;
		this.setNativeSidebarAnnotationTarget(null);
	}

	private setNativeSidebarAnnotationTarget(target: NativeSidebarContext | null): void {
		this.nativeSidebarAnnotationTarget = target;
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (leaf?.view instanceof UNreaderSidebarView) leaf.view.setAnnotationTarget(target);
	}

	private findLiveNativeAnnotationContext(key: string): NativeSidebarContext | null {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER)) {
			if (!(leaf.view instanceof UNreaderView)) continue;
			const context = leaf.view.getNativeSidebarContext();
			if (context?.key === key) return context;
		}
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			const context = this.mdOverlay?.getNativeSidebarContext(leaf) ?? null;
			if (context?.key === key) return context;
		}
		return null;
	}

	private nativeAnnotationBrowseInfo(key: string): NativeAnnotationBrowseInfo | null {
		if (key.startsWith("book:")) {
			const filePath = key.slice("book:".length);
			const file = this.app.vault.getFileByPath(filePath);
			if (!(file instanceof TFile) || !isReaderBookFile(file) || !isBookExtEnabled(file.extension, this.settings.disabledFormats)) return null;
			return { key, kind: "book", title: file.basename, pickerMode: "bookshelf", filePath: file.path, annotationPath: annotationFileFor(file), bookLink: file.path };
		}
		if (key.startsWith("markdown:")) {
			const filePath = key.slice("markdown:".length);
			const file = resolveNoteFile(this.app, filePath);
			if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) return null;
			return { key, kind: "markdown", title: file.basename, pickerMode: "notes", filePath: file.path, annotationPath: file.path, bookLink: file.path };
		}
		if (key.startsWith("feed:")) {
			if (!isRssFormatEnabled(this.settings.disabledFormats)) return null;
			const rest = key.slice("feed:".length);
			const feed = this.feedStore.listFeeds().sort((a, b) => b.id.length - a.id.length)
				.find(candidate => rest.startsWith(`${candidate.id}:`));
			if (!feed) return null;
			const entryId = rest.slice(feed.id.length + 1);
			const entry = entryId ? this.feedStore.getEntry(feed.id, entryId) : null;
			if (!entry) return null;
			return {
				key, kind: "feed", title: entry.title || feed.title, pickerMode: "feeds",
				filePath: "", annotationPath: annotationFileForFeed(feed.id, entry.id, entry.title),
				bookLink: entry.url || entry.title, feedRef: { feedId: feed.id, entryId: entry.id, kind: entry.kind },
			};
		}
		return null;
	}

	private markdownAnnotationData(source: string): AnnotationFileData {
		return {
			highlights: collectHighlights(source).map((span, index) => ({
				id: index + 1, color: span.color, anchor: `md:${span.contentStart}:${span.contentEnd}`, text: span.plain,
			})),
			bookmarks: [],
		};
	}

	private async loadNativeAnnotationData(info: NativeAnnotationBrowseInfo): Promise<AnnotationFileData> {
		if (info.kind !== "markdown") return loadAnnotations(this.app.vault, info.annotationPath, info.bookLink);
		const file = resolveNoteFile(this.app, info.filePath);
		if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) throw new Error("笔记已移动或删除");
		const view = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view)
			.find((candidate): candidate is MarkdownView => candidate instanceof MarkdownView && candidate.file?.path === info.filePath);
		if (view?.getMode?.() === "source" && view.editor?.getValue) return this.markdownAnnotationData(view.editor.getValue());
		return this.markdownAnnotationData(await this.app.vault.read(file));
	}

	private findLiveMarkdownView(path: string): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf.view;
		}
		return null;
	}

	private cloneAnnotationData(data: AnnotationFileData): AnnotationFileData {
		return { highlights: data.highlights.map(item => ({ ...item })), bookmarks: data.bookmarks.map(item => ({ ...item })) };
	}

	private async loadNativeAnnotationBrowseTarget(info: NativeAnnotationBrowseInfo): Promise<NativeSidebarContext> {
		await this.whenDataReady();
		const live = this.findLiveNativeAnnotationContext(info.key);
		if (live) return live;
		let data = await this.loadNativeAnnotationData(info);
		const annotation = {
			key: info.key,
			data: () => this.cloneAnnotationData(data),
			onJump: (anchor: string, hint?: string) => { void this.jumpFromNativeAnnotationTarget(info.key, anchor, hint); },
			onPreview: (item: StoredHighlight, anchorEl: HTMLElement) => this.findLiveNativeAnnotationContext(info.key)?.annotation.onPreview(item, anchorEl),
			onComment: (id: number, comment: string) => {
				if (info.kind === "markdown") return;
				const expected = data.highlights.find(item => item.id === id);
				if (!expected) return;
				this.queueStoredAnnotationMutation(info, fresh => {
					const current = fresh.highlights.find(item => item.id === id && item.anchor === expected.anchor && item.text === expected.text);
					if (!current) return false;
					current.comment = comment.trim() || undefined;
					return true;
				}, next => { data = next; });
			},
			onCopyReference: (item: StoredHighlight) => { void this.copyNativeAnnotationReference(item.text, info.title, info.annotationPath); },
			onDeleteHighlight: (id: number) => {
				const expected = data.highlights.find(item => item.id === id);
				if (!expected) return;
				if (info.kind === "markdown") {
					void this.deleteMarkdownAnnotation(info, expected, next => { data = next; });
					return;
				}
				this.queueStoredAnnotationMutation(info, fresh => {
					const index = fresh.highlights.findIndex(item => item.id === id && item.anchor === expected.anchor && item.text === expected.text);
					if (index < 0) return false;
					fresh.highlights.splice(index, 1);
					return true;
				}, next => { data = next; });
			},
			onDeleteBookmark: (id: number) => {
				if (info.kind === "markdown") return;
				const expected = data.bookmarks.find(item => item.id === id);
				if (!expected) return;
				this.queueStoredAnnotationMutation(info, fresh => {
					const index = fresh.bookmarks.findIndex(item => item.id === id && item.anchor === expected.anchor && item.label === expected.label);
					if (index < 0) return false;
					fresh.bookmarks.splice(index, 1);
					return true;
				}, next => { data = next; });
			},
			onRenameBookmark: (id: number, label: string) => {
				if (info.kind === "markdown") return;
				const expected = data.bookmarks.find(item => item.id === id);
				const nextLabel = sanitizeBookmarkLabel(label);
				if (!expected || !nextLabel || nextLabel === expected.label) return;
				this.queueStoredAnnotationMutation(info, fresh => {
					const current = fresh.bookmarks.find(item => item.id === id && item.anchor === expected.anchor && item.label === expected.label);
					if (!current) return false;
					current.label = nextLabel;
					return true;
				}, next => { data = next; });
			},
			getPageForAnchor: (anchor: string) => this.findLiveNativeAnnotationContext(info.key)?.annotation.getPageForAnchor(anchor) ?? null,
			commentEnabled: () => info.kind !== "markdown",
		};
		return {
			key: info.key,
			kind: info.kind,
			title: info.title,
			pickerMode: info.pickerMode,
			...(info.kind === "book" ? { bookPath: info.filePath } : {}),
			...(info.kind === "feed" ? { feedRef: info.feedRef } : {}),
			...(info.kind === "markdown" ? { markdownPath: info.filePath } : {}),
			annotation,
		};
	}

	private queueStoredAnnotationMutation(
		info: NativeAnnotationBrowseInfo,
		mutate: (fresh: AnnotationFileData) => boolean,
		onSaved: (fresh: AnnotationFileData) => void,
	): void {
		const previous = this.nativeAnnotationMutationQueues.get(info.key) ?? Promise.resolve();
		const pending = previous.catch(() => undefined).then(async () => {
			const fresh = await loadAnnotations(this.app.vault, info.annotationPath, info.bookLink);
			if (!mutate(fresh)) {
				new Notice("这条标注已变化，请刷新后再操作");
				await this.refreshNativeSidebarAnnotationTarget(info.key);
				return;
			}
			await writeAnnotations(this.app.vault, info.annotationPath, info.bookLink, fresh);
			if (info.kind === "feed" && info.feedRef) {
				await this.feedStore.updateEntryState(info.feedRef.feedId, info.feedRef.entryId, {
					hasAnnotations: fresh.highlights.length > 0 || fresh.bookmarks.length > 0,
				});
			}
			onSaved(this.cloneAnnotationData(fresh));
			await this.refreshOpenAnnotationDocuments(info);
			await this.refreshNativeSidebarAnnotationTarget(info.key);
		}).catch(error => {
			console.error("[UNreader] 无法修改标注", error);
			new Notice("标注保存失败");
		});
		this.nativeAnnotationMutationQueues.set(info.key, pending);
		void pending.finally(() => { if (this.nativeAnnotationMutationQueues.get(info.key) === pending) this.nativeAnnotationMutationQueues.delete(info.key); });
	}

	private async deleteMarkdownAnnotation(
		info: NativeAnnotationBrowseInfo,
		expected: StoredHighlight,
		onSaved: (data: AnnotationFileData) => void,
	): Promise<void> {
		const file = resolveNoteFile(this.app, info.filePath);
		if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) { new Notice("笔记已移动或删除"); return; }
		try {
			const view = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view)
				.find((candidate): candidate is MarkdownView => candidate instanceof MarkdownView && candidate.file?.path === info.filePath);
			const sourceMode = view?.getMode?.() === "source";
			const source = sourceMode && view?.editor?.getValue ? view.editor.getValue() : await this.app.vault.read(file);
			const span = collectHighlights(source).find((item, index) => item.plain === expected.text
				&& `md:${item.contentStart}:${item.contentEnd}` === expected.anchor);
			if (!span) { new Notice("这条高亮已变化，请刷新后再操作"); await this.refreshNativeSidebarAnnotationTarget(info.key); return; }
			const plan = { from: span.openStart, to: span.closeEnd, replacement: source.slice(span.contentStart, span.contentEnd) };
			const expectedSource = source.slice(plan.from, plan.to);
			const result = sourceMode && view
				? await applyEditPlan(this.app, view, plan, expectedSource, "auto", info.filePath)
				: await applyVaultEditPlan(this.app, info.filePath, plan, expectedSource);
			if (!result.ok) { new Notice("笔记已变化，高亮未删除；请刷新后重试"); return; }
			const nextSource = sourceMode && view?.editor?.getValue ? view.editor.getValue() : source.slice(0, plan.from) + plan.replacement + source.slice(plan.to);
			onSaved(this.markdownAnnotationData(nextSource));
			if (!sourceMode) await this.mdOverlay?.refreshNativeSidebarContext(info.key);
			await this.refreshNativeSidebarAnnotationTarget(info.key);
		} catch (error) {
			console.error("[UNreader] 无法删除 Markdown 高亮", error);
			new Notice("删除高亮失败");
		}
	}

	private async refreshOpenAnnotationDocuments(info: NativeAnnotationBrowseInfo): Promise<void> {
		if (info.kind === "markdown") {
			await this.mdOverlay?.refreshNativeSidebarContext(info.key);
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER)) {
			if (leaf.view instanceof UNreaderView) await leaf.view.refreshAnnotationsFromExternalWrite([info.annotationPath]);
		}
	}

	private async copyNativeAnnotationReference(text: string, title: string, notePath: string): Promise<void> {
		const clean = text.replace(/\s+/g, " ").trim();
		const exists = !!this.app.vault.getFileByPath(notePath);
		const content = [`> ${clean}`, "", `来源：《${title}》`, ...(exists ? [`溯源：${notePath}`] : [])].join("\n");
		try { await navigator.clipboard.writeText(content); new Notice("已复制引用"); }
		catch { new Notice("复制失败"); }
	}

	private async refreshNativeSidebarAnnotationTarget(key: string): Promise<void> {
		if (this.nativeSidebarAnnotationTarget?.key !== key) return;
		const sequence = this.nativeSidebarAnnotationSequence;
		const info = this.nativeAnnotationBrowseInfo(key);
		if (!info) return;
		try {
			const target = await this.loadNativeAnnotationBrowseTarget(info);
			if (sequence === this.nativeSidebarAnnotationSequence && this.nativeSidebarAnnotationTarget?.key === key) this.setNativeSidebarAnnotationTarget(target);
		} catch (error) {
			console.error("[UNreader] 无法刷新侧栏标注", error);
		}
	}

	private async jumpFromNativeAnnotationTarget(key: string, anchor: string, hint?: string): Promise<void> {
		const jumpSequence = ++this.nativeAnnotationJumpSequence;
		const targetSequence = this.nativeSidebarAnnotationSequence;
		const isCurrent = (): boolean => jumpSequence === this.nativeAnnotationJumpSequence
			&& targetSequence === this.nativeSidebarAnnotationSequence
			&& this.nativeSidebarAnnotationTarget?.key === key;
		if (!isCurrent()) return;
		try {
			if (key.startsWith("book:") || key.startsWith("feed:")) {
				let reader = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER).map(leaf => leaf.view)
					.find((view): view is UNreaderView => view instanceof UNreaderView && view.isNativeSidebarSourceLoaded(key));
				if (!reader) {
					let leaf: WorkspaceLeaf | null = null;
					if (key.startsWith("book:")) {
						const file = this.app.vault.getFileByPath(key.slice("book:".length));
						if (file instanceof TFile) leaf = await this.openBook(file);
					} else {
						const info = this.nativeAnnotationBrowseInfo(key);
						if (info?.feedRef) leaf = await this.openFeedEntry(info.feedRef.feedId, info.feedRef.entryId);
					}
					if (!isCurrent()) return;
					if (!leaf || !(leaf.view instanceof UNreaderView) || !(await leaf.view.waitForNativeSidebarSource(key))) throw new Error("正文打开失败");
					if (!isCurrent()) return;
					reader = leaf.view;
				}
				if (!isCurrent()) return;
				if (!(await reader.jumpToNativeSidebarAnnotation(key, anchor, hint))) throw new Error("标注位置不可用");
				if (!isCurrent()) return;
				await this.focusNativeSidebarContent(reader.leaf);
				return;
			}
			const path = key.slice("markdown:".length);
			let leaf = this.app.workspace.getLeavesOfType("markdown").find(candidate => candidate.view instanceof MarkdownView && candidate.view.file?.path === path) ?? null;
			if (!leaf) leaf = await this.openMarkdownNote(path);
			if (!isCurrent()) return;
			if (!leaf || !(leaf.view instanceof MarkdownView)) throw new Error("笔记打开失败");
			const context = await this.mdOverlay?.refreshNativeSidebarContext(key)
				?? this.mdOverlay?.getNativeSidebarContext(leaf)
				?? null;
			if (!isCurrent()) return;
			if (!context || context.key !== key) throw new Error("笔记标注尚未准备好");
			context.annotation.onJump(anchor, hint);
			await this.focusNativeSidebarContent(leaf);
		} catch (error) {
			if (!isCurrent()) return;
			console.warn("[UNreader] 定位标注失败", key, error);
			new Notice("无法打开正文或定位这条标注；标注列表仍保留在侧栏");
		}
	}

	updateNativeSidebarContext(context: NativeSidebarContext | null, owner?: object): void {
		if (owner && this.nativeSidebarContextOwner && this.nativeSidebarContextOwner !== owner
			&& this.app.workspace.activeLeaf !== owner) return;
		this.nativeSidebarContext = context;
		this.nativeSidebarContextOwner = owner ?? (context ? this.app.workspace.activeLeaf ?? null : null);
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (leaf?.view instanceof UNreaderSidebarView) leaf.view.setContext(context);
	}

	forgetNativeSidebarContext(owner: object): void {
		const leaf = owner instanceof UNreaderView ? owner.leaf : owner;
		if (this.nativeSidebarContextOwner === owner || this.nativeSidebarContextOwner === leaf) this.updateNativeSidebarContext(null);
	}

	private activeNativeSidebarContext(): NativeSidebarContext | null {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return this.nativeSidebarContext;
		if (leaf.view instanceof UNreaderSidebarView) return this.nativeSidebarContext ?? this.getActiveReader()?.getNativeSidebarContext() ?? null;
		if (leaf.view instanceof UNreaderView) return leaf.view.getNativeSidebarContext();
		if (leaf.view instanceof MarkdownView) return this.mdOverlay?.getNativeSidebarContext(leaf) ?? null;
		return null;
	}

	/** 取（必要时创建 / 跨侧迁移）原生侧栏标签，并保证它落在 `side` 这一侧。
	 *  `side` 缺省 = 用户偏好侧（`settings.nativeSidebarSide`，默认 `left`）。 */
	private async ensureNativeSidebarLeaf(side?: "left" | "right"): Promise<WorkspaceLeaf | null> {
		const targetSide: "left" | "right" = side ?? this.settings.nativeSidebarSide ?? "left";
		if (this.nativeSidebarLeafPromise) return this.nativeSidebarLeafPromise;
		const operation = (async (): Promise<WorkspaceLeaf | null> => {
			this.migrateExistingNativeSidebarLeaf();
			let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR);
			let leaf = leaves[0] ?? null;
			if (leaves.length > 1) {
				const activeIndex = leaves.findIndex(candidate => (candidate as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl?.classList.contains("is-active"));
				const keeperIndex = selectNativeSidebarKeeperIndex({
					leafCount: leaves.length,
					sameGroupIndices: [],
					activeIndex,
					migrationDone: true,
				});
				leaf = keeperIndex == null ? leaf : leaves[keeperIndex] ?? leaf;
				for (const duplicate of leaves) if (duplicate !== leaf) duplicate.detach();
				leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR);
			}
			// 已有标签但不在目标侧 ⇒ 跨侧迁移；没有标签 ⇒ 在目标侧新建。两条同一个出口。
			if (!leaf) return this.createNativeSidebarLeaf(targetSide, null);
			if (this.nativeSidebarSideOf(leaf) !== targetSide) return this.createNativeSidebarLeaf(targetSide, leaf);
			return leaf;
		})();
		this.nativeSidebarLeafPromise = operation;
		try { return await operation; }
		catch (error) {
			console.error(`[UNreader] 无法在${targetSide === "right" ? "右" : "左"}侧标签组创建原生侧栏`, error);
			new Notice(`无法在${targetSide === "right" ? "右" : "左"}侧边栏打开 UNreader；请检查该侧边栏是否可用`);
			return null;
		} finally {
			if (this.nativeSidebarLeafPromise === operation) this.nativeSidebarLeafPromise = null;
		}
	}

	/** 在目标侧建 sidebar 标签；`previous` 非空时先把旧标签拆掉（= 跨侧迁移）。
	 *
	 *  为什么是「拆了重建」而不是搬过去：Obsidian **没有**公开的「把标签从左栏移到右栏」
	 *  方法（`moveLeafToPopout` 只去弹窗），而 `ensureSideLeaf` 在已有同类型标签时**直接忽略
	 *  side 参数**、复用现有那个（asar 里 `ensureSideLeaf` 的实现就是 `c[0]` 存在便用 `c[0]`）——
	 *  所以光传 `"right"` 永远不会换边。换边只能：记下当前页签与上下文 → detach →
	 *  目标侧重建 → 还原。 */
	private async createNativeSidebarLeaf(side: "left" | "right", previous: WorkspaceLeaf | null): Promise<WorkspaceLeaf> {
		// 迁移会销毁旧视图实例，所以「用户正在看哪一页 / 看的是哪篇的标注」必须先取出来。
		const oldView = previous?.view instanceof UNreaderSidebarView ? previous.view : null;
		const mode = oldView?.getPanelMode() ?? this.settings.lastSidebarMode ?? "bookshelf";
		const annotationTarget = this.nativeSidebarAnnotationTarget;
		const context = this.nativeSidebarContext;
		previous?.detach();
		// detach 是同步移除，但布局更新可能压到下一帧；此刻 ensureSideLeaf 若仍枚举到旧标签，
		// 就会复用一个**已经 dispose 的视图**（真机表现为「侧栏打开是一片空白」）。让一帧再建。
		await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
		// split:false 把它塞进该侧已有标签组；不创建上下分区，也不退回主区域。
		const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_UNREADER_SIDEBAR, side, {
			active: false,
			split: false,
			reveal: false,
		});
		if (leaf.view?.getViewType() !== VIEW_TYPE_UNREADER_SIDEBAR) {
			await leaf.setViewState({ type: VIEW_TYPE_UNREADER_SIDEBAR, active: false });
		}
		// 后台标签是 deferred：不显式加载的话 `leaf.view` 还不是我们的 View，
		// 下面那步「还原页签」会被 `instanceof` 挡掉，用户切过去看到的是默认页。
		if (leaf.isDeferred) await leaf.loadIfDeferred();
		if (leaf.view instanceof UNreaderSidebarView) {
			// 顺序要紧：先喂上下文，再 showMode —— `setContext` 会按**当前** mode 决定刷新哪一页。
			leaf.view.setContext(context);
			leaf.view.setAnnotationTarget(annotationTarget);
			// persistMode=false：迁移是位置操作，不该顺手改「上次停在哪一页」这个设置。
			leaf.view.showMode(mode, false);
		}
		this.settings.nativeSidebarPlacementMigrated = true;
		void this.persistData();
		return leaf;
	}

	/** 某个侧栏标签现在在哪一侧（null = 不在左右侧栏里，例如被拖成了浮窗）。 */
	private nativeSidebarSideOf(leaf: WorkspaceLeaf): "left" | "right" | null {
		const { leftSplit, rightSplit } = this.app.workspace;
		const seen = new Set<unknown>();
		let node: unknown = leaf;
		while (node && !seen.has(node)) {
			seen.add(node);
			if (node === leftSplit) return "left";
			if (node === rightSplit) return "right";
			node = (node as { parent?: unknown }).parent ?? null;
		}
		// 兜底走 DOM：移动端的 parent 链会绕一个 MobileDrawer，个别版本还会重挂。
		// `containerEl` 在 leaf 上没写进公开类型（只在 View 上），运行期却有 —— 都试一遍。
		const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl ?? leaf.view?.containerEl;
		if (el?.closest(".mod-right-split")) return "right";
		if (el?.closest(".mod-left-split")) return "left";
		return null;
	}

	/** 侧栏整体在哪一侧（null = 标签还没建过）。 */
	private nativeSidebarSide(): "left" | "right" | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		return leaf ? this.nativeSidebarSideOf(leaf) : null;
	}

	/** 侧栏所在那一侧是否**折叠着**（用户看不见）。 */
	private nativeSidebarCollapsed(): boolean {
		const side = this.nativeSidebarSide();
		if (!side) return true;
		const split = side === "left" ? this.app.workspace.leftSplit : this.app.workspace.rightSplit;
		return (split as unknown as { collapsed?: boolean } | null)?.collapsed === true;
	}

	/** 「侧栏位置：在左侧 / 右侧之间切换」命令的本体（用户 2026-10-17）。
	 *
	 *  规则按用户原话：
	 *  · 侧栏**没打开**（标签不存在 / 所在那侧折叠着）⇒ 直接在**右侧**打开；
	 *  · 已经打开 ⇒ 换到另一侧。
	 *
	 *  换完把新侧写回 `settings.nativeSidebarSide` —— 否则下一次「打开书架」会按旧偏好
	 *  把它搬回去，切换命令等于白切。这也是「默认在左侧」与「可以切换」能共存的原因：
	 *  偏好默认 `left`，用户切过一次之后就跟着用户走。 */
	async toggleNativeSidebarSide(): Promise<void> {
		const current = this.nativeSidebarSide();
		const opened = current !== null && !this.nativeSidebarCollapsed();
		const target: "left" | "right" = opened ? (current === "left" ? "right" : "left") : "right";
		this.settings.nativeSidebarSide = target;
		void this.persistData();
		const leaf = await this.ensureNativeSidebarLeaf(target);
		if (!leaf) return;
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.syncNativeSidebarToolbarButtons();
	}

	/** 布局恢复后只迁移旧版已经存在的独立分区；不会自动创建标签，也不追着用户拖动后的布局跑。 */
	private migrateExistingNativeSidebarLeaf(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR);
		if (!leaves.length) return;
		const fileExplorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
		if (!this.settings.nativeSidebarPlacementMigrated && !fileExplorer) return;
		const sameGroupIndices = fileExplorer ? leaves.flatMap((leaf, index) => leaf.parent === fileExplorer.parent ? [index] : []) : [];
		const activeIndex = leaves.findIndex(leaf => (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl?.classList.contains("is-active"));
		const keeperIndex = selectNativeSidebarKeeperIndex({
			leafCount: leaves.length,
			sameGroupIndices,
			activeIndex,
			migrationDone: this.settings.nativeSidebarPlacementMigrated,
		});
		const leaf = keeperIndex == null ? leaves[0] : leaves[keeperIndex] ?? leaves[0];
		if (!leaf) return;
		if (!this.settings.nativeSidebarPlacementMigrated && fileExplorer && shouldMigrateNativeSidebarGroup({
			existingView: true,
			migrationDone: false,
			sameGroup: leaf.parent === fileExplorer.parent,
		})) leaf.setGroupMember(fileExplorer);
		for (const duplicate of leaves) if (duplicate !== leaf) duplicate.detach();
		if (!this.settings.nativeSidebarPlacementMigrated) {
			this.settings.nativeSidebarPlacementMigrated = true;
			void this.persistData();
		}
	}

	/** 打开原生侧栏；列表/标注页都走同一标签，重复点击只重显目标页。 */
	async openSidePanel(mode?: SidePanelMode, context?: NativeSidebarContext | null): Promise<void> {
		let nextContext = context === undefined ? this.activeNativeSidebarContext() : context;
		const feedsEnabled = isRssFormatEnabled(this.settings.disabledFormats);
		const pickerMode = resolveNativeSidebarPickerMode({
			contentKind: nextContext?.kind ?? null,
			savedMode: this.settings.lastSidebarMode,
			hasSavedMode: this.settings.lastSidebarModeExplicit,
			feedsEnabled,
		});
		const targetMode: SidePanelMode = mode === "annotations"
			? "annotations"
			: mode ? normalizeNativeSidebarMode(mode, feedsEnabled) : pickerMode;
		if (targetMode === "annotations" && nextContext?.kind === "markdown") {
			nextContext = await this.mdOverlay?.refreshNativeSidebarContext(nextContext.key) ?? null;
		}
		this.updateNativeSidebarContext(nextContext);
		if (targetMode === "annotations") this.nativeSidebarAnnotationTarget = nextContext;
		const leaf = await this.ensureNativeSidebarLeaf();
		if (!leaf) return;
		if (leaf.view instanceof UNreaderSidebarView) {
			leaf.view.setContext(nextContext);
			if (targetMode === "annotations") leaf.view.setAnnotationTarget(nextContext);
		}
		const view = leaf.view;
		if (view instanceof UNreaderSidebarView) view.showMode(targetMode, mode !== undefined && mode !== "annotations");
		if (mode && mode !== "annotations") {
			this.settings.lastSidebarMode = normalizeNativeSidebarMode(mode, feedsEnabled);
			this.settings.lastSidebarModeExplicit = true;
			void this.persistData();
		}
		// revealLeaf 会展开左侧栏并选中这个标签；等待它完成，避免工具栏状态先于界面落地。
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.syncNativeSidebarToolbarButtons();
	}

	getNativeSidebarMode(): SidePanelMode | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (!(leaf?.view instanceof UNreaderSidebarView) || !leaf.view.isPanelOpen()) return null;
		const root = leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf");
		const tabHeader = (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		const parent = leaf.parent as unknown as { children?: WorkspaceLeaf[]; tabHeaderEls?: HTMLElement[] };
		const index = parent.children?.indexOf(leaf) ?? -1;
		const selected = tabHeader?.classList.contains("is-active")
			?? (index >= 0 && parent.tabHeaderEls?.[index]?.classList.contains("is-active") === true);
		const rect = root?.getBoundingClientRect();
		// 展开判定要按**当前所在侧**取：侧栏可以在右栏（2026-10-17 可切换），
		// 写死 `mod-left-split` 会把右侧打开的侧栏一律判成「不可见」。
		const collapsedSelector = this.nativeSidebarSide() === "right"
			? ".workspace-split.mod-right-split.is-collapsed"
			: ".workspace-split.mod-left-split.is-collapsed";
		const expanded = !!rect && rect.width > 0 && rect.height > 0
			&& !root?.closest(collapsedSelector);
		return selected && expanded ? leaf.view.getPanelMode() : null;
	}

	syncNativeSidebarToolbarButtons(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER)) {
			if (leaf.view instanceof UNreaderView) leaf.view.syncNativeSidebarToolbarButtons();
		}
		this.mdOverlay?.syncNativeSidebarToolbarButtons();
	}

	refreshNativeSidebarAnnotations(key?: string): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (key && this.nativeSidebarAnnotationTarget?.key === key) {
			void this.refreshNativeSidebarAnnotationTarget(key);
			return;
		}
		if (leaf?.view instanceof UNreaderSidebarView) leaf.view.refreshAnnotations(key);
	}

	refreshNativeSidebarBookshelf(): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (leaf?.view instanceof UNreaderSidebarView) leaf.view.refreshBookshelf();
	}

	refreshNativeSidebarFeeds(): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (leaf?.view instanceof UNreaderSidebarView) leaf.view.refreshFeeds();
	}

	refreshNativeSidebarNotes(): void {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
		if (leaf?.view instanceof UNreaderSidebarView) leaf.view.refreshNotes();
	}

	collapseNativeSidebarOnPhone(): void {
		if (!Platform.isPhone) return;
		// 收哪一侧取决于侧栏现在在哪：写死 `leftSplit` 时，侧栏挪到右栏后手机上点卡片
		// 会去收一个空的左栏，右栏照样铺满屏幕。
		if (this.nativeSidebarSide() === "right") this.app.workspace.rightSplit.collapse();
		else this.app.workspace.leftSplit.collapse();
	}

	async focusNativeSidebarContent(leaf: WorkspaceLeaf): Promise<void> {
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.collapseNativeSidebarOnPhone();
	}

	private async openNativeSidebarCard(key: string, open: () => Promise<boolean>, requestedNavigationIntent?: number): Promise<void> {
		const intent = resolveNativeSidebarCardIntent({
			targetKey: key,
			loadedKey: this.activeNativeSidebarContext()?.key ?? this.nativeSidebarContext?.key ?? null,
			pendingKey: this.pendingSidebarCardKey,
		});
		if (intent === "open-annotations") {
			if (requestedNavigationIntent === undefined) await this.openSidePanel("annotations", this.activeNativeSidebarContext());
			return;
		}
		if (intent === "wait-for-open") {
			const pending = this.sidebarCardOpenPromises.get(key);
			if (!pending) return;
			if (requestedNavigationIntent !== undefined) {
				await pending;
				return;
			}
			const navigationIntent = this.sidebarCardNavigationIntent;
			const annotationIntent = { key, navigationIntent };
			this.pendingSidebarAnnotationIntent = annotationIntent;
			const loaded = await pending;
			if (loaded && this.pendingSidebarAnnotationIntent === annotationIntent
				&& this.sidebarCardNavigationIntent === navigationIntent) {
				this.pendingSidebarAnnotationIntent = null;
				await this.openSidePanel("annotations", this.nativeSidebarContext);
			}
			return;
		}

		const navigationIntent = requestedNavigationIntent ?? ++this.sidebarCardNavigationIntent;
		if (requestedNavigationIntent === undefined) {
			const sidebarLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER_SIDEBAR)[0];
			if (sidebarLeaf?.view instanceof UNreaderSidebarView) sidebarLeaf.view.setAnnotationLoading(null);
		}
		this.pendingSidebarAnnotationIntent = null;
		this.pendingSidebarCardKey = key;
		const previous = this.sidebarCardOpenQueue;
		const pending = (previous ? previous.catch(() => false).then(async () => {
			this.updateNativeSidebarContext(null);
			return open();
		}) : Promise.resolve().then(async () => {
			this.updateNativeSidebarContext(null);
			return open();
		})).catch(error => {
			console.error("[UNreader] 原生侧栏打开内容失败", error);
			return false;
		});
		this.sidebarCardOpenQueue = pending;
		this.sidebarCardOpenPromises.set(key, pending);
		let loaded = false;
		try { loaded = await pending; }
		finally {
			if (this.sidebarCardOpenPromises.get(key) === pending) this.sidebarCardOpenPromises.delete(key);
			if (this.sidebarCardOpenQueue === pending) this.sidebarCardOpenQueue = null;
			if (this.pendingSidebarCardKey === key && this.sidebarCardNavigationIntent === navigationIntent) {
				this.pendingSidebarCardKey = null;
			}
		}
		if (!loaded && this.sidebarCardNavigationIntent === navigationIntent) {
			this.pendingSidebarAnnotationIntent = null;
			this.updateNativeSidebarContext(null);
		}
		if (loaded && this.sidebarCardNavigationIntent === navigationIntent) this.collapseNativeSidebarOnPhone();
	}

	async openBookFromNativeSidebar(path: string, navigationIntent?: number): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile) || !isReaderBookFile(file) || !isBookExtEnabled(file.extension, this.settings.disabledFormats)) {
			new Notice("这本书不存在，或当前阅读格式已关闭");
			return;
		}
		const key = `book:${file.path}`;
		await this.openNativeSidebarCard(key, async () => {
			const leaf = await this.openBook(file);
			if (!leaf || !(leaf.view instanceof UNreaderView)) return false;
			return leaf.view.waitForNativeSidebarSource(key);
		}, navigationIntent);
	}

	async openAnnotationsFromNativeSidebar(key: string): Promise<void> {
		const sequence = ++this.nativeSidebarAnnotationSequence;
		const info = this.nativeAnnotationBrowseInfo(key);
		if (!info) {
			new Notice("内容不存在或对应格式已关闭，请刷新侧栏");
			return;
		}
		const leaf = await this.ensureNativeSidebarLeaf();
		if (!(leaf?.view instanceof UNreaderSidebarView)) return;
		this.setNativeSidebarAnnotationTarget(null);
		leaf.view.setAnnotationLoading(key, info.title);
		leaf.view.showMode("annotations", false);
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.syncNativeSidebarToolbarButtons();
		try {
			await this.whenDataReady();
			const target = await this.loadNativeAnnotationBrowseTarget(info);
			if (sequence !== this.nativeSidebarAnnotationSequence) return;
			this.setNativeSidebarAnnotationTarget(target);
		} catch (error) {
			console.error("[UNreader] 无法读取标注", key, error);
			if (sequence === this.nativeSidebarAnnotationSequence) {
				leaf.view.setAnnotationLoading(key, info.title, "读取标注失败；可关闭本页或重新点击查看标注");
				new Notice("读取标注失败；原文不会被打开");
			}
		}
	}

	async openFeedEntryFromNativeSidebar(feedId: string, entryId: string, navigationIntent?: number): Promise<void> {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		const key = `feed:${feedId}:${entryId}`;
		await this.openNativeSidebarCard(key, async () => {
			const leaf = await this.openFeedEntry(feedId, entryId);
			if (!leaf || !(leaf.view instanceof UNreaderView)) return false;
			return leaf.view.waitForNativeSidebarSource(key);
		}, navigationIntent);
	}

	async openMarkdownNoteFromNativeSidebar(path: string, navigationIntent?: number): Promise<void> {
		const key = `markdown:${path}`;
		await this.openNativeSidebarCard(key, async () => {
			const leaf = await this.openMarkdownNote(path);
			if (!leaf) return false;
			for (let i = 0; i < 60; i++) {
				const context = this.mdOverlay?.getNativeSidebarContext(leaf) ?? null;
				if (context?.key === key) {
					this.updateNativeSidebarContext(context, leaf);
					return true;
				}
				await new Promise(resolve => window.setTimeout(resolve, 50));
			}
			new Notice("笔记已经打开，但标注面板还没准备好；稍后可再次点击这张卡片");
			return false;
		}, navigationIntent);
	}

	private preferredReaderLeaf(targetKey?: string): WorkspaceLeaf | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER);
		const active = this.app.workspace.activeLeaf;
		const activeIndex = active?.view instanceof UNreaderView ? leaves.indexOf(active) : -1;
		const lastIndex = this.lastReader?.containerEl?.isConnected
			? leaves.findIndex(leaf => leaf.view === this.lastReader)
			: -1;
		const targetIndex = targetKey ? leaves.findIndex(leaf => {
			if (!(leaf.view instanceof UNreaderView)) return false;
			if (leaf.view.getNativeSidebarContext()?.key === targetKey) return true;
			if (targetKey.startsWith("book:")) return leaf.view.file?.path === targetKey.slice("book:".length);
			const feedRef = leaf.view.getCurrentFeedRef();
			return !!feedRef && targetKey === `feed:${feedRef.feedId}:${feedRef.entryId}`;
		}) : -1;
		const index = selectPreferredReaderIndex({ leafCount: leaves.length, targetIndex, activeIndex, lastUsedIndex: lastIndex });
		return index == null ? null : leaves[index] ?? null;
	}

	getCurrentReaderTitle(): string | null { return this.getActiveReader()?.getDisplayText() ?? null; }
	getCurrentBookPath(): string | null { return this.getActiveReader()?.file?.path ?? null; }
	getCurrentFeedRef(): { feedId: string; entryId: string } | null { return this.getActiveReader()?.getCurrentFeedRef() ?? null; }
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
		// 隔离墙（core/fileGate.ts）：阅读视图只吃自己注册过的格式。`openBook` 既是对外
		// 开放接口（UNagent 等三方插件会调），也是书架 / 笔记卡跳转的出口，传进来的可能是
		// 任何 TFile —— 引擎对未知格式只会抛错并停在空态，这里当场拒绝，不把文件喂进去。
		if (!isReaderBookFile(file)) {
			debugLog.warn("[gate] 拒绝用阅读视图打开非支持格式", file?.path ?? "");
			new Notice(tf("noticeUnsupportedFile", { name: file?.basename || file?.path || "该文件" }));
			return null;
		}
		// 格式开关（设置 → 阅读格式，见 core/readableFormats.ts）：用户显式关掉过这个
		// 格式 ⇒ 一律拒绝。与上面那道「不是支持的格式」分开报 —— 病因不同，文案不同
		// （一个是插件压根不适配，一个是用户自己关的，提示要指向设置里能改回来）。
		if (!isBookExtEnabled(file.extension, this.settings.disabledFormats)) {
			debugLog.warn("[gate] 拒绝打开已被用户停用的格式", file.path);
			new Notice(tf("noticeFormatDisabled", { name: file.basename || file.path }));
			return null;
		}
		const existing = this.preferredReaderLeaf(`book:${file.path}`);
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
		// 复用的阅读器 leaf 可能在别的 pane / 后台标签（典型场景：从 md 叠加层抽屉点书）；
		// setViewState 只灌内容不切前台，不 reveal 表现就是「点了没跳转」。
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		return leaf;
	}

	async openBookPicker(): Promise<void> {
		const files = this.getBookFiles();
		if (!files.length) {
			// 书籍不限位置（数据落点与书籍位置无关，见 core/paths.ts）：
			// 扫描范围就是整个库，所以空态的修复建议只能是「把书放进库」。
			// 格式与排除文件夹是另外两条「有书却不显示」的原因，一并写进文案 ——
			// 只报「库里没有」会让用户以为书丢了（真实原因往往是刚排除过的下载目录）。
			new Notice(`库里没有找到 ${SUPPORTED_BOOK_FORMATS.join(" / ")} 书籍：把书放进库内任意位置即可；若书在排除的文件夹里，请到 设置 → UNreader → 书架 调整`);
			return;
		}
		new BookPickerModal(this, files).open();
	}

	/** 用 Obsidian 原生 Markdown 阅读模式打开一篇笔记。
	 *
	 *  产品边界仍是「插件不接管 .md」：这里只负责把文件路由到官方 markdown 视图，
	 *  阅读模式里的进度条/目录条/插件工具栏由 `MdOverlayManager` 寄生叠加。
	 *  优先复用已经打开的 markdown 叶子，避免每次点列表都多开一个标签页。 */
	async openMarkdownNote(path: string): Promise<WorkspaceLeaf | null> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice("笔记不存在或已移动");
			return null;
		}
		// 隔离墙：不是「真 markdown 笔记」就不许路由到官方 markdown 视图。
		// Excalidraw 这类「伪 markdown」（`*.excalidraw.md` / frontmatter 带
		// `excalidraw-plugin`）内容是一段绘图 JSON，塞进 markdown 视图只会把别人的
		// 数据文件当场摊开（历史版本就是这样从笔记列表点进去的），见 core/fileGate.ts。
		if (!isMarkdownNoteFile(this.app, file)) {
			debugLog.warn("[gate] 拒绝打开非笔记的 markdown 数据文件", file.path);
			new Notice(tf("noticeNotMarkdownNote", { name: file.basename }));
			return null;
		}
		this.recordMarkdownNoteOpened(file.path);
		const existing = this.app.workspace.getLeavesOfType("markdown")[0];
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		try {
			await leaf.setViewState({
				type: "markdown",
				state: { file: file.path, mode: "preview" },
				active: true,
			});
		} catch (error) {
			console.warn(`[UNreader] 无法用 Markdown 阅读模式打开 ${file.path}`, error);
			await leaf.openFile(file, { active: true, state: { mode: "preview" } });
		}
		// 某些版本对 `openFile` 的 state 只做合并、不保证把 source 切回 preview；
		// 本入口的产品语义是「打开笔记阅读」，这里补一次显式模式切换。
		if (leaf.view instanceof MarkdownView && leaf.view.getMode() !== "preview") {
			await leaf.view.setState({ ...leaf.view.getState(), mode: "preview" }, { history: false });
		}
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		return leaf;
	}

	/** 历史存储字段的读取口：Markdown 界面现在把这项状态显示为「置顶」。 */
	isMarkdownNoteStarred(path: string): boolean {
		return !!path && typeof this.settings.markdownNoteStarred?.[path] === "number";
	}

	/** Markdown 的旧「星标」索引现在作为置顶状态展示；继续沿用原存储键，保留用户已有标记。 */
	isMarkdownNotePinned(path: string): boolean {
		return this.isMarkdownNoteStarred(path);
	}

	/** 笔记阅读计时：正在读的那篇笔记的统计键（null = 当前活动叶子不是 Markdown 笔记）。 */
	private activeNoteReadingKey: string | null = null;

	/** 按「当前活动叶子」同步笔记阅读计时。
	 *
	 *  为什么必须从活动叶子推：Markdown 笔记由**官方**的阅读模式承载，不是我们的
	 *  阅读视图，所以插件没有「打开 / 关闭」这一步可以挂钩；能观察到的只有
	 *  `active-leaf-change`。切走时停止并结算，切回来重新起算。
	 *
	 *  书籍 / RSS 文章那条路由 `readerView` 直接给（它有明确的换源时刻），见
	 *  `readerView.applyReaderSource`。 */
	private syncNoteReadingTimer(): void {
		let key: string | null = null;
		try {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = view?.file;
			// 隔离墙：伪 markdown（Excalidraw 绘图等）不记阅读时长 —— 它不是笔记。
			if (file && isMarkdownNoteFile(this.app, file)) key = noteStatKey(file.path);
		} catch { /* 取活动视图失败只是少一段统计，不影响功能 */ }
		if (key === this.activeNoteReadingKey) return;
		if (this.activeNoteReadingKey) this.readingTimer?.stop(this.activeNoteReadingKey);
		this.activeNoteReadingKey = key;
		if (key) this.readingTimer?.start(key);
	}

	/** 当前笔记是否「已读」。判据 = 在「最近阅读」索引里，**不新增存储字段** ——
	 *  索引本身就是「读过」的证据，另立一个布尔位只会多一处不一致的来源。
	 *  笔记卡的详情看板读它（用户 2026-10-13）。 */
	isMarkdownNoteRead(path: string): boolean {
		return (this.settings.markdownNoteRecent ?? []).some(entry => entry.path === path);
	}

	/** `toggleMarkdownNoteRead` 已退役（2026-10-13）：笔记卡上那枚「标记已读 / 未读」按钮
	 *  取消（用户定稿的按钮只有 复制路径 / 定位到文件夹 / 星标），读态只由「真的打开过」
	 *  这一条路径记录 —— 手动切读态原本就是「同一状态两个来源」，取消后反而更一致。 */

	/** 一篇 Markdown 笔记的字数（卡片底栏那格，替代原先的二态进度环）。
	 *
	 *  口径在 `core/wordCount`（中文字符逐字 + 外文按词，排除 frontmatter），这里只负责
	 *  取文：`cachedRead` 命中官方缓存，面板重绘频繁时不会把磁盘打满（与 `noteThumb`
	 *  同一取舍）。读不到（文件被删 / 读盘失败）返回 null ⇒ 卡片显示占位符，
	 *  **不返回 0** —— 「读不出来」不是「这篇是空的」。 */
	async countMarkdownNoteWords(path: string): Promise<number | null> {
		// 走 `resolveNoteFile`：跨端同步的路径形态漂移（NFC/NFD、大小写）不该让字数位
		// 恒显示占位符（解析器只在文件**确实在库里**时命中，不会为已删除的路径造数）。
		const file = resolveNoteFile(this.app, path);
		// 隔离墙：伪 markdown（绘图数据等）不读正文、不算字数。
		if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) return null;
		try {
			return countWords(await this.app.vault.cachedRead(file));
		} catch {
			return null;
		}
	}

	/** frontmatter 摘要（笔记卡看板用）。只认官方 metadataCache 的结果：
	 *  索引没准备好时返回 undefined，看板少一段，**不自己再去解析一遍 YAML**
	 *  （`core/noteThumb` 有一份手扫实现，那只是为取封面的一条捷径，不该扩散）。 */
	private noteMetaFor(file: TFile): NoteMetaSummary | undefined {
		try {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) return undefined;
			const tags = normalizeMetaList(frontmatter.tags ?? frontmatter.tag);
			const aliases = normalizeMetaList(frontmatter.aliases ?? frontmatter.alias);
			const extra: Array<{ key: string; value: string }> = [];
			for (const [key, value] of Object.entries(frontmatter)) {
				if (key === "position" || key === "tags" || key === "tag" || key === "aliases" || key === "alias") continue;
				if (COVER_META_KEYS.has(key)) continue;
				const text = normalizeMetaValue(value);
				if (!text) continue;
				extra.push({ key, value: text });
				if (extra.length >= NOTE_META_EXTRA_LIMIT) break;
			}
			const summary: NoteMetaSummary = {};
			if (tags.length) summary.tags = tags;
			if (aliases.length) summary.aliases = aliases;
			if (extra.length) summary.extra = extra;
			return Object.keys(summary).length ? summary : undefined;
		} catch {
			return undefined;
		}
	}

	/** 兼容历史调用名；旧 markdownNoteStarred 索引继续保存当前置顶状态。 */
	toggleMarkdownNoteStar(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		// 隔离墙：伪 markdown 不进置顶索引（否则它会出现在笔记列表里）。
		if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) return;
		this.settings.markdownNoteStarred ??= {};
		if (this.isMarkdownNoteStarred(file.path)) delete this.settings.markdownNoteStarred[file.path];
		else this.settings.markdownNoteStarred[file.path] = Date.now();
		this.scheduleSave();
		this.mdOverlay?.applySettingsAll();
		this.refreshMarkdownNotePanels();
	}

	toggleMarkdownNotePin(path: string): void {
		this.toggleMarkdownNoteStar(path);
	}

	/** 记录一次「在阅读模式真正看过的笔记」；只保留最近 12 条，列表打开时现算文件信息。 */
	recordMarkdownNoteOpened(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		// 隔离墙（唯一入口判据）：伪 markdown 不进「最近阅读」—— 这一条是绘图文件
		// 漏进插件笔记视图的**源头**（Excalidraw 的 `.excalidraw.md` 先由官方 markdown
		// 视图承载一瞬，叠加层的 active-leaf-change 就会走到这里）。
		if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) return;
		this.settings.markdownNoteRecent ??= [];
		const recent = this.settings.markdownNoteRecent;
		// 同一篇连续触发 active-leaf-change / layout-change 是常态，顶部已是它就不再重复写盘。
		if (recent[0]?.path === file.path) return;
		this.settings.markdownNoteRecent = [
			{ path: file.path, openedAt: Date.now() },
			...recent.filter(entry => entry.path !== file.path),
		].slice(0, MARKDOWN_NOTE_RECENT_LIMIT);
		this.scheduleSave();
		this.refreshMarkdownNotePanels();
	}

	/** 当前 vault 里仍存在、且属于最近/置顶索引的 Markdown 笔记清单。
	 *
	 *  ⚠️ 路径解析必须走 `createNoteFileResolver`（精确命中 → 归一化回退），**不能**只写
	 *  `getFileByPath`：他端写进索引的路径形态（NFC/NFD、大小写）在本端可能精确失配，
	 *  只认精确命中时，用户看到的是「**这台设备上笔记卡片全没了**」——而索引里明明有记录
	 *  （2026-10-14 报障的形态之一；另一半是索引被清理误删，见 `pruneNoteIndex`）。
	 *  归一化命中时用**真实文件的 path** 当身份（打开 / 星标 / 定位都按它走），并按解析后的
	 *  路径去重，免得同一篇笔记因两份路径形态在列表里出现两次。 */
	getMarkdownNoteListItems(): { recent: MarkdownNoteListItem[]; starred: MarkdownNoteListItem[] } {
		const recent = this.settings.markdownNoteRecent ?? [];
		const starred = this.settings.markdownNoteStarred ?? {};
		const resolver = createNoteFileResolver(this.app);
		const makeItem = (path: string, openedAt?: number, starredAt?: number): MarkdownNoteListItem | null => {
			const file = resolver.resolve(path);
			// 隔离墙：列表是「插件检索到的文件」的用户可见形态，伪 markdown 一个都不出现。
			if (!(file instanceof TFile) || !isMarkdownNoteFile(this.app, file)) return null;
			return {
				path: file.path,
				title: file.basename,
				mtime: file.stat.mtime,
				openedAt,
				starredAt,
				// frontmatter 摘要：笔记卡看板里专门显示元数据的那一段（用户 2026-10-13）。
				meta: this.noteMetaFor(file),
			};
		};
		// 置顶组也必须带上**真实的**阅读状态：以前这里写死 `openedAt = undefined`，
		// 于是「已读 + 置顶」的笔记在置顶组里永远画成**未读**（空环 + 「标记已读」按钮）——
		// 用户点了那个按钮，`toggleMarkdownNoteRead` 发现它已在「最近阅读」索引里，**反而把它
		// 移出去**（= 置为未读），而按钮看上去毫无变化。这正是用户 2026-10-13 六轮报的
		// 「点击那个已读按钮显示的不好」的第二个来源。已读判据只有一个真源：在 recent 索引里。
		const openedAtByPath = new Map(recent.map(entry => [entry.path, entry.openedAt]));
		const makeGroup = (items: Array<{ path: string; openedAt?: number; starredAt?: number }>): MarkdownNoteListItem[] => {
			const groupSeen = new Set<string>();
			return items.map(item => makeItem(item.path, item.openedAt, item.starredAt)).filter((item): item is MarkdownNoteListItem => {
				if (!item || groupSeen.has(item.path)) return false;
				groupSeen.add(item.path);
				return true;
			});
		};
		return {
			// 最近阅读项也要带上历史标记时间：同一路径若已置顶，recent 卡片显示激活的图钉按钮
			// 必须画成激活态（用户 2026-10-10：最近阅读里也要反映置顶）。不改变 recent
			// 自身的顺序与条数 —— 置顶组仍单独按置顶时间排在上面。
			recent: makeGroup(recent.map(entry => ({ path: entry.path, openedAt: entry.openedAt, starredAt: starred[entry.path] }))),
			starred: makeGroup(Object.entries(starred).sort(([, a], [, b]) => b - a)
				.map(([path, starredAt]) => ({ path, openedAt: openedAtByPath.get(path), starredAt }))),
		};
	}

	/** 笔记卡正文预览的 Markdown 渲染（用户 2026-10-17：「要渲染 markdown 格式」）。
	 *
	 *  为什么收在插件而不是卡片自己调：`ui/markdownNoteCards` 是纯 DOM 层，不 import
	 *  Obsidian 渲染器（探针替身里也没有它）；两个宿主（阅读器抽屉 / 原生侧栏）需要
	 *  **同一份**口径，收在这里两边都只接一根线。
	 *
	 *  `MarkdownRenderer.render` 是**追加**语义（自己不清空），调用方负责先 `empty()`。
	 *  component **不能**用插件本身（`obsidianmd/no-plugin-as-component`：插件生命周期太长，
	 *  卡片反复重绘会把渲染子组件越堆越多）。这里每次渲染新建一个临时 `Component`，
	 *  它不被挂进任何父组件，渲染结束后随引用释放 —— 预览里只有行内元素（图片 / 代码块 /
	 *  表格在 CSS 里已禁），没有需要主动 cleanup 的子组件。 */
	async renderNotePreview(el: HTMLElement, markdown: string, sourcePath: string): Promise<void> {
		// 存成变量（规则要求能显式 `unload()`）；不 unload 是刻意的：unload 会连带清掉
		// 刚渲染出来的子组件状态。卡片被 DOM 丢弃后它自然随引用释放。
		const host = new Component();
		try {
			await MarkdownRenderer.render(this.app, markdown, el, sourcePath, host);
		} catch {
			/* 渲染失败就让预览留空：卡片上弹错误横幅比没有预览更打扰 */
		}
	}

	/** 打开 RSS 文章/播客条目；稳定身份不依赖数组下标或虚拟文件路径。 */
	async openFeedEntry(feedId: string, entryId: string): Promise<WorkspaceLeaf | null> {
		// 格式开关（设置 → 阅读格式）：RSS 被关掉时订阅文章一律不开。这道闸同时管住
		// 侧栏「订阅」页卡片、命令面板入口与 UNagent 的外部调用 —— 页签消失只是 UI
		// 层，这里才是「点不开」的承重墙（见 core/readableFormats.ts）。
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return null;
		}
		if (!this.feedStore.getEntry(feedId, entryId)) {
			new Notice("文章不存在或已被清理");
			return null;
		}
		const existing = this.preferredReaderLeaf(`feed:${feedId}:${entryId}`);
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: VIEW_TYPE_UNREADER,
			state: { source: { kind: "feed-entry", feedId, entryId } },
		});
		// 同 openBook：复用 leaf 时必须显式切前台，否则从 md 叠加层点文章「跳不过去」。
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		return leaf;
	}

	/** 书架排除项 / 收录格式变更后重绘已打开的书架（见 settings 的「书架」分区）。
	 *  书架的列表数据每次渲染现算，所以这里只需通知视图重绘 —— 面板模式与滚动位置不变；
	 *  面板没开（或当前不在书架模式）时什么都不做。 */
	refreshBookshelfPanel(): void {
		const reader = this.getActiveReader();
		if (reader) reader.refreshBookshelfPanel();
		else this.refreshNativeSidebarBookshelf();
	}

	/** UNagent 写完数据文件后的重扫：按路径前缀判断该动哪个库，再刷新已打开的界面。
	 *
	 *  与 Vault 监听的分工见 VAULT_WRITE_EVENT 的注释——这里负责「立刻」。路径前缀
	 *  每次都读**活绑定**（paths.ts）：用户切过资料文件夹后，Agent 写的是新落点，
	 *  不能拿 onload 时捕获的旧常量去比（那样切根后永远匹配不上）。 */
	async refreshFromExternalWrite(paths: readonly string[]): Promise<void> {
		const under = (root: string, p: string): boolean => p === root || p.startsWith(`${root}/`);
		const touchesPresets = paths.some(p => under(PRESETS_FOLDER, p));
		const touchesResources = paths.some(p =>
			under(FONTS_FOLDER, p) || under(RESOURCES_FOLDER, p),
		);
		const touchesFeeds = paths.some(p => under(FEEDS_FOLDER, p));
		const touchesNotes = paths.some(p => under(NOTES_FOLDER, p));
		if (!touchesPresets && !touchesResources && !touchesFeeds && !touchesNotes) return;
		// 排在 init 的首轮读盘之后：那些 init 会先 clear 再写回，并发重扫有被旧快照反超的风险。
		await this.whenDataReady().catch(() => undefined);
		if (touchesPresets) await this.presetStore.reload().catch(() => undefined);
		if (touchesResources) {
			await this.resourceStore.reload().catch(() => undefined);
			await this.refreshCustomFonts().catch(() => undefined);
		}
		// 订阅库是内存缓存，`init()` 就是「整库重读」；只有这条通道会重读它，
		// Feeds/ 没有 Vault 监听（订阅刷新频率高，监听会自激）。
		if (touchesFeeds) await this.feedStore.init().catch(() => undefined);
		// 外观刷新必须**先于** reader 判空：他端同步来的字体 / 预设到齐后，纯 markdown
		// 读者（没有活动阅读器）也要把抽屉排版刷新过来，否则会停在 --font-text 回落值上。
		if (touchesPresets || touchesResources) this.refreshAppearanceEverywhere();
		const reader = this.getActiveReader();
		if (!reader) return;
		if (touchesPresets || touchesResources) reader.refreshAppearancePanel();
		if (touchesFeeds) reader.refreshFeedsPanel();
		if (touchesNotes) await reader.refreshAnnotationsFromExternalWrite(paths);
	}

	promptAddFeed(): void {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		new AddFeedModal(this.app, this).open();
	}

	async addResolvedFeed(candidate: DiscoveredFeed): Promise<void> {
		await this.whenDataReady();
		const result = await this.feedService.addSubscription({
			feedUrl: candidate.url,
			siteUrl: "",
			title: candidate.title,
		});
		if (result.error) throw new Error(result.error);
		new Notice(`已添加订阅：${this.feedStore.getFeed(result.feedId)?.title ?? candidate.title}`);
		this.refreshFeedsPanels();
	}

	importOpmlFromFile(): void {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		new ImportOpmlModal(this.app, this).open();
	}

	async exportOpmlToVault(): Promise<void> {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		await this.whenDataReady();
		const feeds = this.feedStore.listFeeds();
		if (!feeds.length) {
			new Notice("还没有可导出的订阅");
			return;
		}
		const folder = normalizePath(FEEDS_FOLDER);
		try { await this.app.vault.createFolder(folder); } catch { /* 已存在 */ }
		const path = normalizePath(`${FEEDS_FOLDER}/UNreader订阅.opml`);
		const payload = this.feedService.exportOpml();
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modify(existing, payload);
			else await this.app.vault.create(path, payload);
			new Notice(`OPML 已导出到 ${path}`);
		} catch (error) {
			new Notice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 重命名订阅。`onDone` 供订阅管理面板在自己开着时重绘列表（弹窗是同一窗口的两层）。 */
	renameFeed(feedId: string, title: string, onDone?: () => void): void {
		new RenameFeedModal(this.app, title, value => {
			void this.feedStore.renameSubscription(feedId, value).then(() => {
				this.refreshFeedsPanels();
				onDone?.();
			});
		}).open();
	}

	async deleteFeed(feedId: string, onDone?: () => void): Promise<void> {
		const feed = this.feedStore.getFeed(feedId);
		if (!feed) return;
		new DeleteFeedModal(this.app, feed.title, () => {
			void this.feedService.removeSubscription(feedId).then(() => {
				const reader = this.getActiveReader();
				if (reader?.getCurrentFeedSource()?.feedId === feedId) reader.showEmptyState();
				reader?.refreshFeedsPanel();
				onDone?.();
				new Notice(`已删除订阅：${feed.title}`);
			});
		}).open();
	}

	/** 订阅管理面板（RSS 工具栏的设置按钮）。 */
	openFeedManager(): void {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		new FeedManagerModal(this.app, this).open();
	}

	/** 把书架元数据里的旧路径迁到新路径；支持单个文件和整个文件夹。 */
	private migrateBookshelfPaths(oldPath: string, newPath: string): boolean {
		if (!oldPath || !newPath || oldPath === newPath) return false;
		const remap = (path: string): string => {
			if (path === oldPath) return newPath;
			if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
			return path;
		};
		const remapList = (values: readonly string[]): string[] =>
			[...new Set(values.map(remap))];

		let changed = false;
		const oldHidden = [...(this.settings.bookshelfHiddenBooks ?? [])];
		const nextHidden = remapList(this.settings.bookshelfHiddenBooks ?? []);
		if (JSON.stringify(oldHidden) !== JSON.stringify(nextHidden)) changed = true;
		this.settings.bookshelfHiddenBooks = nextHidden;

		const oldManual = [...(this.settings.bookshelfManualOrder ?? [])];
		const nextManual = remapList(this.settings.bookshelfManualOrder ?? []);
		if (JSON.stringify(oldManual) !== JSON.stringify(nextManual)) changed = true;
		this.settings.bookshelfManualOrder = nextManual;

		const oldPinned = [...(this.settings.bookshelfPinned ?? [])];
		const nextPinned = remapList(this.settings.bookshelfPinned ?? []);
		if (JSON.stringify(oldPinned) !== JSON.stringify(nextPinned)) changed = true;
		this.settings.bookshelfPinned = nextPinned;

		const assignments = this.settings.bookshelfCategoryAssignments ?? {};
		const nextAssignments: Record<string, string> = {};
		for (const [path, categoryId] of Object.entries(assignments)) {
			nextAssignments[remap(path)] = categoryId;
		}
		if (JSON.stringify(assignments) !== JSON.stringify(nextAssignments)) changed = true;
		this.settings.bookshelfCategoryAssignments = nextAssignments;
		return changed;
	}

	/** Markdown 笔记索引的路径迁移；支持单文件和文件夹改名。 */
	private migrateMarkdownNotePaths(oldPath: string, newPath: string): boolean {
		if (!oldPath || !newPath || oldPath === newPath) return false;
		const remap = (path: string): string => {
			if (path === oldPath) return newPath;
			if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
			return path;
		};
		const oldRecent = this.settings.markdownNoteRecent ?? [];
		const oldStarred = this.settings.markdownNoteStarred ?? {};
		const nextRecent = oldRecent.map(entry => ({ ...entry, path: remap(entry.path) }));
		const nextStarred = Object.fromEntries(
			Object.entries(oldStarred).map(([path, starredAt]) => [remap(path), starredAt] as const),
		);
		const changed = JSON.stringify(oldRecent) !== JSON.stringify(nextRecent)
			|| JSON.stringify(oldStarred) !== JSON.stringify(nextStarred);
		if (!changed) return false;
		this.settings.markdownNoteRecent = nextRecent;
		this.settings.markdownNoteStarred = nextStarred;
		return true;
	}

	/** 书籍被删除后清掉路径元数据；文件夹删除时一并清掉子路径。 */
	private pruneBookshelfPaths(path: string): boolean {
		if (!path) return false;
		const isRemoved = (candidate: string): boolean =>
			candidate === path || candidate.startsWith(`${path}/`);
		const beforeHidden = [...(this.settings.bookshelfHiddenBooks ?? [])];
		const beforeManual = [...(this.settings.bookshelfManualOrder ?? [])];
		const beforePinned = [...(this.settings.bookshelfPinned ?? [])];
		const beforeAssignments = { ...(this.settings.bookshelfCategoryAssignments ?? {}) };

		this.settings.bookshelfHiddenBooks = beforeHidden.filter(candidate => !isRemoved(candidate));
		this.settings.bookshelfManualOrder = beforeManual.filter(candidate => !isRemoved(candidate));
		this.settings.bookshelfPinned = beforePinned.filter(candidate => !isRemoved(candidate));
		this.settings.bookshelfCategoryAssignments = Object.fromEntries(
			Object.entries(beforeAssignments).filter(([candidate]) => !isRemoved(candidate)),
		);
		return JSON.stringify(beforeHidden) !== JSON.stringify(this.settings.bookshelfHiddenBooks)
			|| JSON.stringify(beforeManual) !== JSON.stringify(this.settings.bookshelfManualOrder)
			|| JSON.stringify(beforePinned) !== JSON.stringify(this.settings.bookshelfPinned)
			|| JSON.stringify(beforeAssignments) !== JSON.stringify(this.settings.bookshelfCategoryAssignments);
	}

	/** Markdown 笔记索引的清场：文件/文件夹删除时同步删掉最近与置顶路径。 */
	private pruneMarkdownNotePaths(path: string): boolean {
		if (!path) return false;
		const isRemoved = (candidate: string): boolean =>
			candidate === path || candidate.startsWith(`${path}/`);
		const beforeRecent = this.settings.markdownNoteRecent ?? [];
		const beforeStarred = this.settings.markdownNoteStarred ?? {};
		const nextRecent = beforeRecent.filter(entry => !isRemoved(entry.path));
		const nextStarred = Object.fromEntries(
			Object.entries(beforeStarred).filter(([candidate]) => !isRemoved(candidate)),
		);
		const changed = beforeRecent.length !== nextRecent.length
			|| Object.keys(beforeStarred).length !== Object.keys(nextStarred).length;
		if (!changed) return false;
		this.settings.markdownNoteRecent = nextRecent;
		this.settings.markdownNoteStarred = nextStarred;
		return true;
	}

	/** 书籍分类管理面板（书架工具栏的设置按钮）。 */
	openBookshelfCategoryManager(): void {
		new BookshelfCategoryManagerModal(this.app, this).open();
	}

	private refreshBookshelfPanels(): void {
		const reader = this.getActiveReader();
		if (reader) reader.refreshBookshelfPanel();
		else this.refreshNativeSidebarBookshelf();
	}

	/** 星标/最近索引变化后刷新所有已挂载阅读器的「笔记」页；没有阅读器时是无操作。 */
	private refreshMarkdownNotePanels(): void {
		let hasReader = false;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_UNREADER)) {
			const view = leaf.view;
			if (view instanceof UNreaderView) { hasReader = true; view.refreshMarkdownNotesPanel(); }
		}
		if (!hasReader) this.refreshNativeSidebarNotes();
	}

	private refreshFeedsPanels(): void {
		const reader = this.getActiveReader();
		if (reader) reader.refreshFeedsPanel();
		else this.refreshNativeSidebarFeeds();
	}

	/** 隔离墙去抖计时器（`scheduleNoteIndexPurge`；卸载时清，见 onload）。 */
	private noteIndexPurgeTimer: number | null = null;

	/** 隔离墙对**存量索引**的清理：把「不是插件适配格式」的路径从「最近阅读 / 星标」
	 *  里剔除。
	 *
	 *  为什么必须单独做一次：入口判据（`recordMarkdownNoteOpened` 等）只挡**新**记录，
	 *  而历史版本已经把 Excalidraw 绘图写进过索引 —— 不清就是「插件仍然检索得到它」。
	 *  判据与入口同一份（`core/fileGate.pruneNoteIndex`），所以名字改了 / 文件删了 /
	 *  后来才被识别成数据文件的条目都会一起消失。返回 true 表示索引真的变了
	 *  （调用方不必自己比对）。 */
	purgeUnsupportedNoteIndexes(): boolean {
		const result = pruneNoteIndex(this.app, this.settings.markdownNoteRecent, this.settings.markdownNoteStarred);
		if (!result.removed) return false;
		debugLog.info("[gate] 清理笔记索引里的非笔记条目", `${result.removed} 条`);
		this.settings.markdownNoteRecent = result.recent;
		this.settings.markdownNoteStarred = result.starred;
		this.scheduleSave();
		this.refreshMarkdownNotePanels();
		return true;
	}

	/** 索引清理的去抖入口（`metadataCache` 的两条事件都会打到它）。 */
	private scheduleNoteIndexPurge(): void {
		if (this.noteIndexPurgeTimer != null) return;
		this.noteIndexPurgeTimer = window.setTimeout(() => {
			this.noteIndexPurgeTimer = null;
			try {
				this.purgeUnsupportedNoteIndexes();
			} catch (e) {
				debugLog.warn("[gate] 笔记索引清理失败", e);
			}
		}, 500);
	}

	async createBookshelfCategory(name: string): Promise<void> {
		const label = name.trim();
		if (!label) return;
		if ((this.settings.bookshelfCategories ?? []).some(category => category.name === label)) {
			new Notice(`已有分类：${label}`);
			return;
		}
		const category: BookshelfCategory = {
			id: `category-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			name: label,
			createdAt: Date.now(),
		};
		this.settings.bookshelfCategories = [...(this.settings.bookshelfCategories ?? []), category];
		await this.persistData();
		this.refreshBookshelfPanels();
		new Notice(`已创建分类：${label}`);
	}

	async renameBookshelfCategory(categoryId: string, name: string): Promise<void> {
		const label = name.trim();
		if (!label) return;
		const category = (this.settings.bookshelfCategories ?? []).find(item => item.id === categoryId);
		if (!category) return;
		if (label === category.name) return;
		if ((this.settings.bookshelfCategories ?? []).some(item => item.id !== categoryId && item.name === label)) {
			new Notice(`已有分类：${label}`);
			return;
		}
		category.name = label;
		await this.persistData();
		this.refreshBookshelfPanels();
		new Notice(`已重命名分类：${label}`);
	}

	async deleteBookshelfCategory(categoryId: string): Promise<void> {
		const before = this.settings.bookshelfCategories ?? [];
		const category = before.find(item => item.id === categoryId);
		if (!category) return;
		this.settings.bookshelfCategories = before.filter(item => item.id !== categoryId);
		this.settings.bookshelfCategoryAssignments = Object.fromEntries(
			Object.entries(this.settings.bookshelfCategoryAssignments ?? {})
				.filter(([, id]) => id !== categoryId),
		);
		await this.persistData();
		this.refreshBookshelfPanels();
		new Notice(`已删除分类：${category.name}`);
	}

	async assignBookshelfCategory(path: string, categoryId: string | null): Promise<void> {
		const assignments = { ...(this.settings.bookshelfCategoryAssignments ?? {}) };
		if (categoryId == null) delete assignments[path];
		else {
			if (!(this.settings.bookshelfCategories ?? []).some(category => category.id === categoryId)) return;
			assignments[path] = categoryId;
		}
		this.settings.bookshelfCategoryAssignments = assignments;
		await this.persistData();
		this.refreshBookshelfPanels();
	}

	async removeBookFromBookshelf(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`找不到书籍：${path}`);
			return;
		}
		const hidden = new Set(this.settings.bookshelfHiddenBooks ?? []);
		if (!hidden.has(path)) hidden.add(path);
		this.settings.bookshelfHiddenBooks = [...hidden];
		await this.persistData();
		this.refreshBookshelfPanels();
		new Notice(`已从书架移除：${file.basename}（文件保留）`);
	}

	async restoreBookToBookshelf(path: string): Promise<void> {
		this.settings.bookshelfHiddenBooks = (this.settings.bookshelfHiddenBooks ?? []).filter(item => item !== path);
		await this.persistData();
		this.refreshBookshelfPanels();
		const name = path.split("/").pop() || path;
		new Notice(`已添加回书架：${name}`);
	}

	getRemovedBookshelfEntries() {
		return getRemovedBookshelfEntries(this);
	}

	/** 启用 / 停用订阅：停用后不再参与刷新，文章也从「全部」聚合列表里收起。 */
	async setFeedEnabled(feedId: string, enabled: boolean): Promise<void> {
		await this.whenDataReady();
		await this.feedService.setSubscriptionEnabled(feedId, enabled);
		const title = this.feedStore.getFeed(feedId)?.title ?? "";
		new Notice(enabled ? `已启用订阅：${title}` : `已停用订阅：${title}`);
		this.refreshFeedsPanels();
	}

	/** 只刷新一个订阅（订阅管理面板每行那颗刷新按钮；停用的订阅也能手动刷一次）。 */
	async refreshFeed(feedId: string): Promise<void> {
		await this.whenDataReady();
		const feed = this.feedStore.getFeed(feedId);
		if (!feed) return;
		const result = await this.feedService.refreshFeed(feedId, true);
		if (result.error) new Notice(`刷新失败：${result.error}`);
		else new Notice(result.notModified ? `《${feed.title}》没有新文章` : `《${feed.title}》已更新 ${result.addedOrUpdated} 篇`);
		this.refreshFeedsPanels();
	}

	async downloadPodcast(feedId: string, entryId: string): Promise<boolean> {
		const entry = this.feedStore.getEntry(feedId, entryId);
		const url = entry?.enclosure?.url;
		if (!url) return false;
		if (this.settings.feeds.mediaCacheMb <= 0) {
			new Notice("播客缓存上限为 0，请先在订阅设置中调大后再下载");
			return false;
		}
		const bytes = this.settings.feeds.mediaCacheMb * 1024 * 1024;
		const ok = await this.feedMediaStore.downloadMedia(url, bytes);
		if (ok) this.refreshFeedsPanels();
		return ok;
	}

	async refreshAllFeeds(): Promise<void> {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		await this.whenDataReady();
		const results = await this.feedService.refreshAll(true);
		if (!results.length) {
			new Notice("没有可刷新的订阅（订阅源可能都已停用）");
			return;
		}
		const failed = results.filter(result => result.error).length;
		new Notice(failed ? `刷新完成，${failed} 个订阅失败` : "订阅已刷新");
		this.refreshFeedsPanels();
	}

	async openNextUnreadFeed(): Promise<void> {
		if (!isRssFormatEnabled(this.settings.disabledFormats)) {
			new Notice(t("noticeRssFormatDisabled"));
			return;
		}
		await this.whenDataReady();
		const disabled = new Set(this.feedStore.listFeeds().filter(feed => feed.enabled === false).map(feed => feed.id));
		const next = this.feedStore.listEntries()
			.find(entry => entry.state.readAt == null && !disabled.has(entry.feedId));
		if (!next) {
			new Notice("没有未读文章");
			return;
		}
		await this.openFeedEntry(next.feedId, next.id);
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

	/** 播客音频拖动/播放的同步热缓存入口；与正文位置分开存。 */
	checkpointPodcastProgress(feedId: string, entryId: string, position: BookPosition): void {
		this.feedStore?.checkpointEntryState(feedId, entryId, { audioPosition: position });
	}

	/** 阅读中每次可信 relocate 的同步热缓存入口（不等待任何磁盘 I/O）。 */
	checkpointSourcePosition(key: string, position: BookPosition): void {
		if (!key.startsWith("feed:")) {
			this.progress?.checkpoint(key.slice("book:".length), position);
			return;
		}
		const [, feedId, entryId] = key.split(":");
		if (!feedId || !entryId) return;
		this.feedStore?.checkpointEntryState(feedId, entryId, { position });
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
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.persistData();
		}, 800);
	}

	flushSave(): void {
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.persistData();
	}

	async persistData(): Promise<void> {
		// 设置保存即同步诊断开关（设置页切开关后立刻生效/清缓冲）
		debugLog.setDebugEnabled(!this.unloaded && this.settings.debugLog);
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

	private releaseNotesSeenKey(): string {
		return `unreader-release-notes-seen:${this.deviceScope()}`;
	}

	private markReleaseNotesSeen(version: string): void {
		try { window.localStorage.setItem(this.releaseNotesSeenKey(), version); } catch { /* 手动命令仍可查看 */ }
	}

	private openReleaseNotes(versions = releaseNoteVersionsNewestFirst()): void {
		if (this.activeReleaseNotesModal) return;
		const currentVersion = this.manifest.version;
		const modal = new ReleaseNotesModal(this.app, versions, currentVersion, () => {
			if (this.activeReleaseNotesModal === modal) this.activeReleaseNotesModal = null;
			this.markReleaseNotesSeen(currentVersion);
		});
		this.activeReleaseNotesModal = modal;
		modal.open();
	}

	/** 新库首次安装不弹窗；检测到已有 UNreader 设置时，升级后的当前版本温和提醒一次。 */
	private scheduleReleaseNotesReminder(): void {
		const version = this.manifest.version;
		if (!releaseNoteForVersion(version)) return;
		const key = this.releaseNotesSeenKey();
		let seen: string | null;
		try { seen = window.localStorage.getItem(key); } catch { return; }
		if (seen === version) return;
		if (!shouldPromptReleaseNotes(version, seen, this.hasExistingPluginData)) {
			if (!seen) this.markReleaseNotesSeen(version);
			return;
		}

		let cancelled = false;
		this.register(() => {
			cancelled = true;
			if (this.releaseNotesPromptTimer !== null) window.clearTimeout(this.releaseNotesPromptTimer);
			this.releaseNotesPromptTimer = null;
		});
		void this.dataReady.then(() => {
			if (cancelled || this.unloaded) return;
			this.releaseNotesPromptTimer = window.setTimeout(() => {
				this.releaseNotesPromptTimer = null;
				if (cancelled || this.unloaded || this.activeReleaseNotesModal) return;
				let latestSeen: string | null;
				try { latestSeen = window.localStorage.getItem(key); } catch { return; }
				if (latestSeen === version) return;
				this.openReleaseNotes([version]);
			}, 1300);
		}).catch(() => undefined);
	}

	/** 插件目录的**库内相对路径**（`.obsidian/plugins/unreader`），给订阅正文当缓存落点。
	 *
	 *  正文是**可再生的抓取缓存**（换设备重新刷新订阅就能拿到同样的内容），不该占着库内可见
	 *  文件树、也不该跨端同步 —— 插件目录同时满足这两条（点目录不进索引、文件树里不存在，
	 *  且官方 Sync 整体跳过它），与图片/播客缓存的 IndexedDB 是同一个设计姿态
	 *  （见 `core/feedStore.ts` 文件头「正文为什么搬进插件目录」）。
	 *
	 *  `manifest.dir` 官方契约写的是「插件目录的绝对路径」，实际普遍是库内相对路径 ——
	 *  这里两种形态都归一：按 `/<配置目录>/plugins/` 取尾段，取不到就按 `manifest.id` 拼；
	 *  再取不到（自定义配置目录 / 老 API）返回 null，由 `FeedStore` 退回库内点目录兜底，
	 *  **功能不受影响**，只是那份缓存会跟着数据根搬家。 */
	private feedCachePluginDir(): string | null {
		try {
			const configDir = String(this.app.vault.configDir ?? "").trim();
			if (!configDir) return null;
			const raw = String(this.manifest?.dir ?? "").replace(/\\/g, "/");
			const marker = `/${configDir}/plugins/`;
			const idx = raw.indexOf(marker);
			const rel = (idx >= 0 ? raw.slice(idx + 1) : `${configDir}/plugins/${String(this.manifest?.id ?? "")}`)
				.replace(/^\/+|\/+$/g, "");
			const parts = rel.split("/").filter(Boolean);
			if (parts.length < 3 || parts[0] !== configDir || parts[1] !== "plugins" || !parts[2]) return null;
			return parts.slice(0, 3).join("/");
		} catch {
			return null;
		}
	}

	/** 容器化冲突提示也是设备本地 UI 状态：同一冲突只提醒一次，换库/换数据根互不影响。 */
	private dataContainerSkipNoticeKey(): string {
		return `unreader-data-container-skip-notice:${this.deviceScope()}`;
	}

	/** 冲突集合没变就不重复弹 Notice；localStorage 不可用时保留每次提醒的安全降级。 */
	private shouldShowDataContainerSkipNotice(plan: LibraryMigrationPlan): boolean {
		const id = dataContainerSkipNoticeId(plan);
		if (!id) return false;
		try {
			const key = this.dataContainerSkipNoticeKey();
			if (window.localStorage.getItem(key) === id) return false;
			window.localStorage.setItem(key, id);
			return true;
		} catch {
			return true;
		}
	}

	private clearDataContainerSkipNotice(): void {
		try { window.localStorage.removeItem(this.dataContainerSkipNoticeKey()); } catch { /* localStorage 不可用时无需清理 */ }
	}

	/** 读取本机外观快照（localStorage，设备本地永不随库同步） */
	private loadDeviceAppearance(): Partial<AppearanceSettings> | null {
		try {
			const raw = window.localStorage.getItem(this.deviceAppearanceKey());
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
			window.localStorage.setItem(this.deviceAppearanceKey(), JSON.stringify(this.settings.appearance));
			return true;
		} catch (e) {
			console.warn("[UNreader] 本机外观写入 window.localStorage 失败（可能超配额），降级写入 data.json", e);
			return false;
		}
	}

	private async loadSettingsData(): Promise<void> {
		const data = (await this.loadData()) as (Partial<UNreaderSettings> & {
			hideChromeOnScroll?: unknown;
			hideChromeOnScrollSet?: unknown;
			/** 旧字段：曾是「打开书籍」的扫描范围（切换时把书迁进去）。语义已整体拆除，见下。 */
			materialsFolder?: unknown;
		}) | null;
		this.hasExistingPluginData = !!data && typeof data === "object" && Object.keys(data).length > 0;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		if (typeof data?.lastSidebarModeExplicit === "boolean") {
			this.settings.lastSidebarModeExplicit = data.lastSidebarModeExplicit;
		} else {
			// 旧版本没有显式标记；非默认页一定是用户选过的，默认书架则按当前内容推断。
			this.settings.lastSidebarModeExplicit = data?.lastSidebarMode != null && data.lastSidebarMode !== "bookshelf";
		}
		this.settings.nativeSidebarPlacementMigrated = data?.nativeSidebarPlacementMigrated === true;
		// 侧栏默认侧：只认 "right"，其余（含旧数据里的 undefined）一律回落 left。
		this.settings.nativeSidebarSide = data?.nativeSidebarSide === "right" ? "right" : "left";
		const retiredSettings = this.settings as unknown as Record<string, unknown>;
		delete retiredSettings.annoPinned;
		delete retiredSettings.pinThreshold;
		delete retiredSettings.annoPanelHeight;
		delete retiredSettings.annoPanelWidth;
		if (!["bookshelf", "feeds", "notes"].includes(this.settings.lastSidebarMode)) {
			this.settings.lastSidebarMode = "bookshelf";
		}
		// **绝不把旧 `materialsFolder` 当新 `dataFolder` 迁移**（2026-09-18，关键）：
		// 旧字段表达的是「书扫描范围」，用户选过的值往往是他的**书**目录（作者库里就是
		// `4-配置文件`）。照搬成数据落点的话，首次启动时活绑定就指向那个目录，而
		// `healLibraryFolders` 会把 `UNreader/` 下的进度 / 预设 / 字体**悄悄搬进用户的
		// 书籍目录** —— 不可逆的用户可见事故。新语义是「插件数据放哪儿」，默认根
		// `UNreader/` 也正是数据**现在**实际所在的位置；要换位置请在设置页显式迁移。
		this.settings.dataFolder = normalizeDataFolder(this.settings.dataFolder);
		delete (this.settings as unknown as Record<string, unknown>).materialsFolder;
		// **落点必须在这里生效**：下面所有路径读取（三份存储的构造、字体 id 解析、
		// `ensureLibraryFolders`）读的都是 `core/paths.ts` 的活绑定。
		setConfiguredDataFolder(this.settings.dataFolder);
		if (this.settings.bookshelfSortMode !== "recent" && this.settings.bookshelfSortMode !== "manual") {
			this.settings.bookshelfSortMode = "scan";
		}
		this.settings.bookshelfManualOrder = Array.isArray(this.settings.bookshelfManualOrder)
			? this.settings.bookshelfManualOrder.filter((path): path is string => typeof path === "string")
			: [];
		this.settings.bookshelfPinned = Array.isArray(this.settings.bookshelfPinned)
			? this.settings.bookshelfPinned.filter((path): path is string => typeof path === "string")
			: [];
		// Markdown 笔记本就是原文件，索引只是一份轻量路径表。收口只做「裁空 / 去重 / 排序 /
		// 截断」，**绝不因为字段形态不符就丢条目**（旧写法把 `openedAt` 非法当作「这篇不在
		// 索引里」整条删掉 ⇒ 升级那一刻他端/旧版本写下的索引被静默清空，2026-10-14 报障）。
		// 判据与兜底都收口在 `core/fileGate.normalizeNoteIndex`，回归 `npm run test:file-gate`。
		{
			const normalized = normalizeNoteIndex(
				this.settings.markdownNoteRecent,
				this.settings.markdownNoteStarred,
				MARKDOWN_NOTE_RECENT_LIMIT,
			);
			this.settings.markdownNoteRecent = normalized.recent as MarkdownNoteRecentEntry[];
			this.settings.markdownNoteStarred = normalized.starred;
		}
		// 分类 / 手动移除是书架的轻量元数据；旧 data.json 没有这些键时用默认值兜底。
		// 这里收口类型、去重并丢掉指向已不存在分类的 assignment，避免手改或同步冲突
		// 后的坏数据让书架整块渲染失败。
		this.settings.bookshelfCategories = [
			...new Map(
				(Array.isArray(this.settings.bookshelfCategories) ? this.settings.bookshelfCategories : [])
					.map((category, index): BookshelfCategory | null => {
						const id = typeof category?.id === "string" ? category.id.trim() : "";
						const name = typeof category?.name === "string" ? category.name.trim() : "";
						if (!id || !name) return null;
						const createdAt = Number(category.createdAt);
						return { id, name, createdAt: Number.isFinite(createdAt) ? createdAt : Date.now() + index };
					})
					.filter((category): category is BookshelfCategory => category !== null)
					.map(category => [category.id, category] as const),
			).values(),
		];
		const categoryIds = new Set(this.settings.bookshelfCategories.map(category => category.id));
		this.settings.bookshelfCategoryAssignments = Object.fromEntries(
			Object.entries(
				this.settings.bookshelfCategoryAssignments && typeof this.settings.bookshelfCategoryAssignments === "object"
					? this.settings.bookshelfCategoryAssignments
					: {},
			).filter(entry => {
				const [path, categoryId] = entry;
				return typeof path === "string" && path !== ""
					&& typeof categoryId === "string" && categoryIds.has(categoryId);
			}),
		);
		this.settings.bookshelfHiddenBooks = [
			...new Set(
				(Array.isArray(this.settings.bookshelfHiddenBooks) ? this.settings.bookshelfHiddenBooks : [])
					.filter((path): path is string => typeof path === "string" && path !== ""),
			),
		];
		// 书架排除文件夹（老 data.json 没有这两个键，`Object.assign` 会保留默认值，
		// 这里再收一次口：手改过 / 跨版本写坏的 data.json 不该让书架整体崩掉）。
		// 归一化走 `normalizeExcludedFolder`（去首尾斜杠、统一分隔符、去空项、去重），
		// 比较用小写键 —— 官方匹配本身大小写不敏感，用户手写 `Books` 与 `books` 是同一条。
		this.settings.bookshelfExcludedFolders = [
			...new Map(
				(Array.isArray(this.settings.bookshelfExcludedFolders) ? this.settings.bookshelfExcludedFolders : [])
					.filter((f): f is string => typeof f === "string")
					.map(f => normalizeExcludedFolder(f))
					.filter(f => f !== "")
					.map(f => [excludedFolderKey(f), f] as const),
			).values(),
		];
		this.settings.bookshelfFollowObsidianExclusions = this.settings.bookshelfFollowObsidianExclusions !== false;
			this.settings.positions = this.settings.positions ?? {};
			this.settings.feeds = Object.assign({}, DEFAULT_SETTINGS.feeds, this.settings.feeds ?? {});
			this.settings.feeds.autoFulltext = this.settings.feeds.autoFulltext !== false;
			this.settings.feeds.entryLimit = Math.max(20, Math.min(2000, Math.floor(Number(this.settings.feeds.entryLimit) || DEFAULT_SETTINGS.feeds.entryLimit)));
			this.settings.feeds.imageCacheMb = Math.max(0, Math.min(2048, Math.floor(Number(this.settings.feeds.imageCacheMb) || 0)));
			this.settings.feeds.mediaCacheMb = Math.max(0, Math.min(8192, Math.floor(Number(this.settings.feeds.mediaCacheMb) || 0)));
		// AI 面板（M2）：老 data.json 没有该键，Object.assign 补默认值；
		// translateSelection 读法统一 `!== false`，这里只收口布尔形态。
		this.settings.ai = Object.assign({}, DEFAULT_SETTINGS.ai, this.settings.ai ?? {});
		this.settings.ai.translateSelection = this.settings.ai.translateSelection !== false;
		this.settings.ai.targetLanguage = typeof this.settings.ai.targetLanguage === "string" && this.settings.ai.targetLanguage.trim()
			? this.settings.ai.targetLanguage.trim()
			: DEFAULT_SETTINGS.ai.targetLanguage;
		// 自定义工具：只留字段完整的条目，名字/提示词截断，作用域收口两种合法值，数量封顶；
		// enabled 是功能开关（缺省 = 开）。v0.3.12 之前的 buttonStyle/icon（划词工具栏按钮
		// 形态与图标）已随「统一 AI 入口」移除 —— 这里不再收口，老 data.json 里残留的同名键
		// 会在下一次 saveSettings 时被这份对象覆盖掉（惰性清理，无读取点）。
		this.settings.ai.customFunctions = (Array.isArray(this.settings.ai.customFunctions) ? this.settings.ai.customFunctions : [])
			.filter(f => !!f && typeof f.name === "string" && typeof f.prompt === "string" && f.name.trim() && f.prompt.trim())
			.slice(0, 20)
			.map((f, index) => ({
				id: typeof f.id === "string" && f.id.trim() ? f.id : `fn-${Date.now().toString(36)}-${index}`,
				name: f.name.trim().slice(0, 40),
				prompt: f.prompt.trim().slice(0, 4000),
				scope: f.scope === "selection" ? "selection" as const : "full" as const,
				enabled: f.enabled !== false,
			}));
		// 官方工具改动（提示词/作用域/停用）：逐字段收口，只认官方 id；全空的对象不留键。
		const rawOverrides = this.settings.ai.toolOverrides;
		const cleanOverrides: Record<string, AiToolOverride> = {};
		for (const tool of DEFAULT_AI_OFFICIAL_TOOLS) {
			const raw = rawOverrides?.[tool.id];
			if (!raw || typeof raw !== "object") continue;
			const entry: AiToolOverride = {};
			if (typeof raw.prompt === "string" && raw.prompt.trim()) entry.prompt = raw.prompt.trim().slice(0, 6000);
			if (raw.scope === "full" || raw.scope === "selection") entry.scope = raw.scope;
			if (typeof raw.enabled === "boolean") entry.enabled = raw.enabled;
			if (Object.keys(entry).length) cleanOverrides[tool.id] = entry;
		}
	// markdown 阅读视图叠加层：三个布尔全按「缺省 = 开」读法收口（与 translateSelection 同款）。
	this.settings.mdOverlayShowProgress = this.settings.mdOverlayShowProgress !== false;
	this.settings.mdOverlayShowTocRail = this.settings.mdOverlayShowTocRail !== false;
	this.settings.mdOverlayImmersive = this.settings.mdOverlayImmersive !== false;
	// 进度分段粒度：整数 clamp 0-6（0 = 全文），脏值回 0。
	this.settings.mdOverlayProgressScope = Math.max(0, Math.min(6, Math.floor(Number(this.settings.mdOverlayProgressScope) || 0)));
	// 阅读格式管理（2026-10-16）：老 data.json 没有这个键 ⇒ Object.assign 补空数组（全开）；
	// 手写脏数据（非数组 / 陌生 id / 大小写混写）由 normalizeDisabledFormats 收口，
	// 缺省形态与功能上线前逐字节相同。
	this.settings.disabledFormats = normalizeDisabledFormats(this.settings.disabledFormats);
		// 自定义按钮：只留 commandId 合法的条目；id 补齐、label/icon 截断兜底、
		// 两个位置开关缺省均为开。**不封数量上限**（用户明确要求）。
		this.settings.customButtons = ((Array.isArray(this.settings.customButtons) ? this.settings.customButtons : []) as unknown[])
			.filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
			.filter(b => typeof b.commandId === "string" && b.commandId.trim().length > 0)
			.map((b, index) => ({
				id: typeof b.id === "string" && b.id.trim() ? b.id : `cb-${Date.now().toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
				commandId: (b.commandId as string).trim(),
				label: typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 40) : (b.commandId as string).trim().slice(0, 40),
				icon: typeof b.icon === "string" && b.icon.trim() ? b.icon.trim().slice(0, 64) : "zap",
				showInRail: b.showInRail !== false,
				showInSelbar: b.showInSelbar !== false,
			}));
		this.settings.ai.toolOverrides = cleanOverrides;
		// 界面语言（2026-10-11）：老 data.json 没有这个键，`Object.assign` 会补上
		// 默认值；手改过 / 跨版本写坏的值由 `normalizeLangPref` 收口回 `'auto'`
		// （= 跟随 Obsidian 软件语言，行为与本功能上线前一致）。
		this.settings.language = normalizeLangPref(this.settings.language);
		// **在读设置之前就生效**：`setLang` 必须在下面任何一处可能读 `t()` 的代码
		// 之前跑完（命令注册、路径迁移提示都是读点）。
		setLang(resolveLang(this.settings.language));
		// 路径不再是设置项：四个文件夹字段已从 UNreaderSettings 删除，全部改用
		// core/paths.ts 的常量。老 data.json 里残留的同名字段会被 Object.assign
		// 一起带进来，但没有任何读取点，属无害的惰性残留。
		// 外观是设备本地状态（localStorage 按库隔离，不随 data.json 同步）：
		// 本机有快照就用本机的；没有（首次升级/新库）则回退旧 data.json 的
		// appearance 并迁移为本机快照——此后各设备外观互相独立。
		let mobileLike = false;
		try {
			mobileLike = Platform.isMobile || Platform.isIosApp || Platform.isAndroidApp;
		} catch { /* ignore */ }
		const platformDefaults = platformAppearanceDefaults(mobileLike);
		const localAppearance = this.loadDeviceAppearance();
		const rawAppearance = {
			...((localAppearance ?? data?.appearance ?? {}) as Record<string, unknown>),
		};
		// 旧顶层开关只在旧版明确标记为“用户设置过”时迁移；否则按平台新默认。
		adoptLegacyAppearance(rawAppearance, platformDefaults, {
			value: data?.hideChromeOnScroll,
			explicitlySet: data?.hideChromeOnScrollSet,
		});
		this.settings.appearance = Object.assign({}, DEFAULT_APPEARANCE, rawAppearance);
		// 旧顶层字段已无读取点，从最终对象中删掉，避免继续落盘。
		const legacySettings = this.settings as unknown as Record<string, unknown>;
		delete legacySettings.hideChromeOnScroll;
		delete legacySettings.hideChromeOnScrollSet;
		delete (this.settings.appearance as unknown as Record<string, unknown>).immersiveAdapt;
		delete (this.settings.appearance as unknown as Record<string, unknown>).hideHeader;
		// 「自动打开目录面板」设置项已整体移除（2026-09-27）：删掉落盘的旧键，
		// 防止快照/预设继续带着它（读取侧已无任何消费方）。
		delete (this.settings.appearance as unknown as Record<string, unknown>).autoOpenToc;
		// 旧版默认「开书显示目录轨」，会让正文一打开就被目录类 UI 包围。
		// 按库做一次本机迁移：默认回到纯阅读；用户之后在界面里主动开启会被本机快照保留。
		let cleanOpenMigrationKey: string | null = null;
		try {
			const key = `unreader-clean-open-v1:${this.deviceScope()}`;
			if (window.localStorage.getItem(key) !== "1") {
				this.settings.appearance.showTocRail = false;
				cleanOpenMigrationKey = key;
			}
		} catch {
			// localStorage 不可用时仍保证当前会话只打开正文；下次启动会再按新默认值收敛。
			this.settings.appearance.showTocRail = false;
		}
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
		// 本地 HTML 的阅读设备档位：值域写成显式枚举（不 import 视图层那张表，
		// 它是 UI 文案层的东西）。兜底很重要——脏值会让设备按钮查表拿到 undefined。
		if (this.settings.webDeviceMode !== "auto" && this.settings.webDeviceMode !== "phone"
			&& this.settings.webDeviceMode !== "tablet" && this.settings.webDeviceMode !== "desktop") {
			this.settings.webDeviceMode = DEFAULT_SETTINGS.webDeviceMode;
		}
		if (!Array.isArray(this.settings.appearancePresets)) this.settings.appearancePresets = [];
		// 规范化每个预设的 appearance，补齐缺失字段
		for (const p of this.settings.appearancePresets) {
			if (!p || typeof p.name !== "string" || !p.appearance) continue;
			// 旧字段迁移必须在合并默认值之前（否则默认 false 盖掉旧值，见 adoptLegacyAppearance）
			adoptLegacyAppearance(p.appearance as unknown as Record<string, unknown>, platformDefaults);
			p.appearance = Object.assign({}, DEFAULT_APPEARANCE, p.appearance);
			if (!p.id) p.id = String(Date.now()) + Math.random().toString(36).slice(2, 7);
			if (!p.createdAt) p.createdAt = Date.now();
		}
		const appearanceSaved = this.saveDeviceAppearance();
		if (cleanOpenMigrationKey && appearanceSaved) {
			try { window.localStorage.setItem(cleanOpenMigrationKey, "1"); } catch { /* 下次启动重试即可 */ }
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
			"data root": dataRootOf(this.settings.dataFolder),
			"fonts folder": FONTS_FOLDER,
			"data folder setting": normalizeDataFolder(this.settings.dataFolder) ?? `（默认 ${dataRootOf(null)}）`,
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
			// 书架收录边界的**实际生效态**：用户报「我的书不见了」时，先看这一行 ——
			// 是格式不符、还是被官方排除项/额外排除的文件夹摘掉了（设置页只表达意图）。
			"bookshelf filter": (() => {
				const folders = this.settings.bookshelfExcludedFolders ?? [];
				const follow = this.settings.bookshelfFollowObsidianExclusions !== false;
				const extra = folders.length ? `（${folders.join(" ")}）` : "";
				return `follow obsidian=${follow ? "on" : "off"}；extra folders=${folders.length}${extra}`;
			})(),
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
				// 字段是 string | null：非字符串不参与展示（`String(对象)` 会输出 "[object Object]"）
				const rawField = (a as unknown as Record<string, unknown>)[field];
				const v = typeof rawField === "string" ? rawField : "";
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
	/** 书名 → 当前资料范围内的出现次数（见 bookService.getBookFiles）。
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
