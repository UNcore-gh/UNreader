/** 悬浮侧边抽屉的「指针还在不在它身上」判定 —— 阅读器与 markdown 叠加层**共用这一份**。
 *
 *  背景（2026-10-13 用户报障）：「侧边栏悬浮状态下，鼠标移开会自动关闭……把这个判定扩大
 *  一些，扩大到侧边工具栏的最右侧边缘过一些距离（容错），方便在侧边栏没关的时候点击
 *  侧边栏的按钮」。抽屉与左缘功能轨是**兄弟**节点（不是父子），只判「指针还在抽屉盒里」
 *  必然在用户横穿过去点轨上按钮的路上把抽屉关掉：抽屉贴屏左缘、功能轨贴在抽屉右缘
 *  （`left: calc(var(--ur-anno-w) + 1px)`），两者之间只隔一条 1px 的缝，而功能轨自身还带
 *  悬停滑出动画 —— 指针一离开抽屉右缘就再也没有「属于抽屉」的盒子可判。
 *
 *  于是判定改成**两级**，任一级成立都算「还在」：
 *  ① `hover`：指针**此刻真压在**抽屉 / 功能轨 / 宿主额外点名的控件上。
 *     `:hover` 是浏览器实时算的，指针停住不动也照样成立 —— 这一级不做任何坐标推算。
 *  ② `near`：指针**最后一次出现**的坐标落在「抽屉 + 功能轨所在的那一整列」里
 *     （用户 2026-10-13 原话：「判定距离应该扩大到**全列**（侧边栏快速工具栏所在的），
 *     而且判定距离不是侧边工具栏的宽度，而是比这个更宽大概 **0.5 倍**」）。这一列是：
 *     · **纵向 = 整屏高**（`0 .. innerHeight`）—— 功能轨只有几百像素高，指针滑到它上下的
 *       同一列里同样算「还在工具栏那一条带子上」；
 *     · **横向 = 0 .. 功能轨右缘 + 功能轨自身宽度的 0.5 倍**（32px 轨 → 抽屉右缘外约 48px）；
 *       量不到功能轨时退回抽屉右缘 + {@link KEEP_ALIVE_FALLBACK_PAD}。
 *     它兜的是①判不到的三处：跨过抽屉与功能轨之间那条 1px 缝的瞬间（两侧 `:hover` 都还是假）、
 *     功能轨悬停滑出动画盒子在动的那几帧、以及指针在功能轨上下沿擦过的时候。
 *
 *  ⚠️ `near` **必须带新鲜度闸门**（{@link KEEP_ALIVE_FRESH_MS}）：书页正文在 iframe 里，
 *  指针一滑进去，宿主 document 再也收不到 `pointermove`，这条坐标会**永远停在列里**
 *  —— 没有闸门的话抽屉就再也不会自动关了。因此调用方也不该把 `near` 当作「可以取消定时器」，
 *  而应当**续一次轮询**：只有轮询能把「指针其实已经走了」这件事收敛到关。 */
/** 功能轨量不到时（未布局 / display:none）的横向容错：抽屉右缘再外扩这么多像素 */
const KEEP_ALIVE_FALLBACK_PAD = 16;
const KEEP_ALIVE_FRESH_MS = 400;

/** 判定结果：`hover` 实测指针在盒子上 / `near` 坐标带内（须继续轮询）/ `away` 已离开。 */
export type SideKeepAliveTier = "hover" | "near" | "away";

export interface SideKeepAliveOptions {
	/** 抽屉本体（卸载 / 不可用时返回 null）。 */
	panel: () => HTMLElement | null
	/** 左缘功能轨（与抽屉同级）。取不到就只按抽屉判。 */
	rail: () => HTMLElement | null
	/** 其它「指针压上去就不许关」的小控件（如抽屉头部的钉住钮）。 */
	hoverAlso?: () => Array<HTMLElement | null>
	/** 抽屉是否处于「移开就关」的活态（开着且未钉住）。false 时处理器零开销早退。 */
	isActive: () => boolean
	/** 每次指针移动后的判定结果（调用方据此决定排 / 取消自动关闭）。 */
	onChange: (tier: SideKeepAliveTier) => void
}

export class SideHoverKeepAlive {
	private point: { x: number; y: number; at: number } | null = null;
	private doc: Document | null = null;

	constructor(private readonly opts: SideKeepAliveOptions) {}

	/** 挂 document 级 `pointermove`（**被动**监听，多次调用等价于重新挂一次）。
	 *  抽屉关着时处理器只问一句 `isActive()` 就返回，正常阅读零成本。 */
	attach(doc: Document): void {
		this.detach();
		this.doc = doc;
		doc.addEventListener("pointermove", this.onPointerMove, { passive: true });
	}

	detach(): void {
		this.doc?.removeEventListener("pointermove", this.onPointerMove);
		this.doc = null;
		this.point = null;
	}

	private onPointerMove = (ev: PointerEvent): void => {
		if (!this.opts.isActive()) return;
		this.point = { x: ev.clientX, y: ev.clientY, at: Date.now() };
		this.opts.onChange(this.tier());
	};

	/** 现算一次判定（自动关闭的定时器里用）。 */
	tier(): SideKeepAliveTier {
		const panel = this.opts.panel();
		if (!panel) return "away";
		// ① 实测指纹：`:hover` 实时可信，指针停着不动也成立。
		if (panel.matches(":hover")) return "hover";
		for (const el of this.opts.hoverAlso?.() ?? []) if (el?.matches(":hover")) return "hover";
		const rail = this.opts.rail();
		if (rail?.matches(":hover")) return "hover";
		// ② 坐标列：最后一次指针位置落在「整屏高 × 抽屉右缘外扩到功能轨右缘 + 半个轨宽」里。
		//    ⚠️ 新鲜度闸门不可省，理由见文件头（指针滑进书页 iframe 后坐标就冻住了）。
		const p = this.point;
		if (!p || Date.now() - p.at > KEEP_ALIVE_FRESH_MS) return "away";
		const height = panel.ownerDocument.defaultView?.innerHeight ?? 0;
		if (height > 0 && (p.y < 0 || p.y > height)) return "away";
		return p.x >= 0 && p.x <= this.columnRight(panel, rail) ? "near" : "away";
	}

	/** 保持区的横向右缘（见文件头「全列」）：功能轨右缘再外扩它自身宽度的 0.5 倍；
	 *  功能轨量不到（未布局 / `display:none`）时退回抽屉右缘 + {@link KEEP_ALIVE_FALLBACK_PAD}。
	 *  ⚠️ 抽屉本身的右缘也属于这条列（`Math.max`），否则拖宽抽屉后列会落在抽屉里面。 */
	private columnRight(panel: HTMLElement, rail: HTMLElement | null): number {
		const pr = panel.getBoundingClientRect();
		const rr = rail?.getBoundingClientRect() ?? null;
		if (rr && rr.width > 0 && rr.height > 0) {
			return Math.max(pr.right, rr.right) + rr.width * 0.5;
		}
		return pr.right + KEEP_ALIVE_FALLBACK_PAD;
	}
}
