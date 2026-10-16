/**
 * 自愈外部对官方 `is-hidden-nav` 的修改。
 *
 * NativeChromeGate 汇总 Reader / Markdown / 划词 owner 的意图，统一维护官方类，
 * 并在目标态为隐藏时拦住 Obsidian 的 restoreNavigation/show。这里仅处理绕过闸门
 * 直接摘类的路径：MutationObserver 在绘制前发现状态不符后，立即回调同一个协调器。
 * 不延迟重试、不挂点击快路，也不通过插件 CSS 盖住原生底栏。
 */

/** 旧版本遗留类的兼容清理名。新版本不再创建或使用它。 */
export const PLUGIN_NAV_HIDDEN_CLASS = "unreader-nav-hidden";

export interface NativeNavGuardOptions {
	/** 所属 Obsidian 窗口的 document；弹出窗口不可借用主窗口的 body。 */
	readonly document?: Document;
	/** 当前视图是否仍要求官方页首 / 手机底栏隐藏。 */
	readonly wantsHidden: () => boolean;
	/** 通过 NativeChromeGate 更新共享 owner 状态和官方类。 */
	readonly sync: () => void;
	/** 官方恢复导航时同时展示系统状态栏，供宿主补做对应的状态栏同步。 */
	readonly onExternalRestore?: () => void;
}

export class NativeNavGuard {
	private mo: MutationObserver | null = null;

	constructor(private readonly opts: NativeNavGuardOptions) {}

	private get doc(): Document { return this.opts.document ?? document; }

	start(): void {
		if (this.mo) return;
		try {
			this.mo = new MutationObserver(() => this.onBodyClassChange());
			this.mo.observe(this.doc.body, { attributes: true, attributeFilter: ["class"] });
		} catch {
			this.mo = null;
		}
	}

	stop(): void {
		try { this.mo?.disconnect(); } catch { /* ignore */ }
		this.mo = null;
		// 旧版本曾写入该类作为视觉遮罩；新版本只清理残留值。
		try { this.doc.body.classList.remove(PLUGIN_NAV_HIDDEN_CLASS); } catch { /* ignore */ }
	}

	private onBodyClassChange(): void {
		if (!this.wanted()) return;
		try { this.opts.onExternalRestore?.(); } catch { /* ignore */ }
		try { this.opts.sync(); } catch { /* ignore */ }
	}

	private wanted(): boolean {
		try {
			return this.opts.wantsHidden() && !this.doc.body.classList.contains("is-hidden-nav");
		} catch {
			return false;
		}
	}
}
