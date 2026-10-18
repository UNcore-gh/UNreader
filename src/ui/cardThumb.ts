/** 列表卡片右侧缩略图列：书架 / RSS / 笔记三类卡片共用同一套「可见即加载」。
 *
 *  从 `annotationsPanel.observeShelfPreview` 抽出来的原因：三类卡片都要这套机制（IntersectionObserver
 *  判可见 → 懒加载 → 往卡片里塞图），复制三份必然漂移；而「可见性判定」是**宿主无关**的
 *  DOM 逻辑，放 UI 层、由渲染方注入取数回调最干净。
 *
 *  两条硬约束（2026-10-12 定）：
 *  · **无图不留空档** —— 缩略图列初始 `is-hidden`；只有图片真的 load 成功才揭开。卡片是
 *    `grid-template-columns: minmax(0,1fr) auto`，第 2 列塌成 0 时文字自然占满整卡。
 *  · **不用浏览器原生 `loading="lazy"`** —— 原生惰性对 `display:none` 子树可能永不触发，
 *    而我们的口径是「先隐藏加载、load 成功才显示」；两套惰性叠加会互相卡死。可见性由
 *    本文件的观察器负责，图片本身立即发起请求。 */

export interface CardThumb {
	root: HTMLElement
	img: HTMLImageElement
	/** 已经揭开过一次（load 成功）；防止同一张卡重复触发重排。 */
	revealed: boolean
}

/** 建缩略图列（默认隐藏）。**必须作为卡片的最后一个子节点**，CSS 靠 `grid-column: 2` 定位。 */
export function mountCardThumb(card: HTMLElement): CardThumb {
	const root = card.createDiv({ cls: "unreader-card-thumb is-hidden" });
	const img = root.createEl("img", { cls: "unreader-card-thumb-img" });
	img.alt = "";
	img.decoding = "async";
	return { root, img, revealed: false };
}

/** 挂上一张图；**只有 load 成功才揭开缩略图列**。
 *
 *  @param onSettled 无论成功失败都会在「已定局」时回调一次 —— 给需要重算高度的调用方
 *  （如置顶笔记组的 max-height）用。 */
export function showCardThumb(thumb: CardThumb, url: string, onSettled?: () => void): void {
	if (thumb.revealed) return;
	thumb.img.addEventListener("load", () => {
		if (!thumb.root.isConnected) return;
		thumb.root.removeClass("is-hidden");
		thumb.revealed = true;
		onSettled?.();
	}, { once: true });
	thumb.img.addEventListener("error", () => {
		thumb.root.addClass("is-hidden");   // 裂图不如不显示：整列塌回，卡片回到全宽文字
		onSettled?.();
	}, { once: true });
	thumb.img.src = url;
}

/** 卡片可见时才发起取图。root 为抽屉的滚动容器（`listEl`），与旧的封面观察器同参数。 */
export class CardThumbObserver {
	private observer: IntersectionObserver | null = null;
	private loaders = new WeakMap<Element, () => void>();

	constructor(private getRoot: () => HTMLElement | null) {}

	observe(card: HTMLElement, load: () => void): void {
		if (typeof IntersectionObserver === "undefined") {
			load();
			return;
		}
		if (!this.observer) {
			this.observer = new IntersectionObserver(entries => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					this.observer?.unobserve(entry.target);
					this.loaders.get(entry.target)?.();
				}
			}, { root: this.getRoot(), rootMargin: "220px 0px" });
		}
		this.loaders.set(card, load);
		this.observer.observe(card);
	}

	/** 切页 / 重绘时收口：断开观察器并丢弃回调表。 */
	reset(): void {
		try { this.observer?.disconnect(); } catch { /* ignore */ }
		this.observer = null;
		this.loaders = new WeakMap<Element, () => void>();
	}
}
