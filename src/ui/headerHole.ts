/** 页首「让位量」的**唯一判据** —— 纯函数，不碰 DOM，可真值表回归。
 *
 *  ## 它取代了什么
 *
 *  原先这段逻辑内联在 `readerView.measureHeaderHole()` 里，并且**被平台门控**：
 *
 *  ```ts
 *  const desktopLayout = !bodyCls.contains("is-mobile");
 *  const gap = desktopLayout ? this.measureHeaderHole(header) : 0;   // ← 移动端写死 0
 *  hole = (hiddenByUs && desktopLayout) ? gap : 0;
 *  ```
 *
 *  理由是「移动端页首已脱离布局流，hole 恒 0」。**而那条理由依赖一个会漂移的前提** ——
 *  移动端页首「脱离布局流」是由**浮层化的 CSS 规则**（`body.is-phone .view-header
 *  .unreader-view-header { position: absolute }` 那族）保证的。规则一旦因 DOM 结构漂移
 *  而静默不命中，页首就回到官方 `static`、**占布局流**，而 JS 这边仍写死 0
 *  ⇒ **既不给它留位测量、也不让位** ⇒ 页首一藏，它占的那 56/103px 原样留着，画出
 *  `.workspace-leaf` 的 `--background-secondary`（obsidian 次级色）—— 用户报的
 *  「沉浸模式下页首元素的背景板又出现了，颜色跟随 obsidian，遮挡书籍正文文字」。
 *
 *  **教训**：页首「占不占布局流」这件事有 **3 个消费点** —— ① 浮层化 CSS 规则、
 *  ② 这里的让位量、③ `body .unreader-body { overflow: visible }`（否则让位被 body 裁掉）。
 *  旧实现把它们绑在同一个「移动端页首是浮层」的假设上，却只有 ① 写着那个假设的**依据**
 *  （一条 CSS 规则），② ③ 只是照着抄结论。**假设的载体只有一处，结论的副本有三处。**
 *  现在 ② 改为**实测 + 计算定位判据**（本模块），与 ① 解耦：不管浮层化有没有生效，
 *  让位量都自动正确。
 *
 *  ## 为什么要看 `position`，而不是只看「实测空隙 > 0」
 *
 *  `.view-content` 顶边 − 叶子顶边 = 0 这个读数**同时对应两种完全不同的世界**：
 *    · 页首是浮层（不占位）—— 该让 0；
 *    · 页首占位、但空隙恰好为 0（几乎不可能，但语义上存在）—— 该按实测让。
 *  事后比较分不出，所以判据必须落在**计算定位**上：`absolute` / `fixed` = 浮层 = 不占流。
 *  这条同时天然覆盖官方「悬浮导航」与「自动全屏」（两者把 `--view-header-position`
 *  设成 `fixed`）—— 那两种形态下页首是透明浮层，本来就不占位。
 */

/** 让位量判据的全部输入事实。每条都**只由 readerView 现读**（唯一来源）。 */
export interface HeaderHoleInputs {
	/** 页首的计算 `position`。`static`/`relative` = **占布局流**；
	 *  `absolute`/`fixed` = **浮层**（本插件的移动端浮层化、官方悬浮导航/自动全屏）。 */
	readonly position: string;
	/** 计算 `display`（官方桌面默认 `body:not(.show-view-header)` 下是 `none`）。 */
	readonly display: string;
	readonly visibility: string;
	/** `header.offsetHeight` —— 页首盒高（含 padding-top 的安全区偏移）。 */
	readonly headerOffsetHeight: number;
	/** 实测空隙 = `.view-content` 顶边 − 叶子顶边；读不到传 `null`。
	 *  注意它**只在一侧成立**：浮层化生效时它是 0，占位时它是页首盒高。 */
	readonly rectDiff: number | null;
	/** `--header-height` 的解析值（末级兜底；官方 `:root` 是 40px，主题常覆盖）。 */
	readonly headerHeightVar: number;
}

/** 实测空隙的采纳阈值（px）。低于它的读数按「没有空隙」处理 ——
 *  排版亚像素（0.5px 级）不该被当成一个真实空隙去让位。 */
export const HOLE_MIN_PX = 0.5;

/** 页首「若可见会占掉多少布局高度」，0 = 不占位。
 *
 *  优先级（顺序即语义，别调换）：
 *   ① **不在布局里**（不在 DOM / `display:none` / `visibility:hidden` / 盒高 0）→ 0；
 *      注意此处**不能**落到末级兜底 —— 否则会给「页首本来就隐藏」的形态凭空造出让位，
 *      把正文推下去（这是既有的「正文零位移」契约的底线）。
 *   ② **浮层**（`position` 是 absolute/fixed）→ 0。**这一条是移动端可用的关键**：
 *      浮层页首不占流，而它的 `offsetHeight` 是整个页首盒高（56 / 刘海屏 103px），
 *      若走到 ③ 的兜底就会凭空造出那么大的让位量、把正文整段推上去。
 *   ③ **实测空隙**（> `HOLE_MIN_PX`）—— 权威值，桌面端页首在流内时它恒等于页首高。
 *   ④ 兜底 = `offsetHeight`（页面还没稳定、`.view-content` 量不到时的退路）。
 *   ⑤ 末级兜底 = `--header-height` 变量。 */
export function resolveHeaderHole(i: HeaderHoleInputs): number {
	// ① 不在布局里
	const inLayout = i.display !== "none" && i.visibility !== "hidden" && i.headerOffsetHeight > 0;
	if (!inLayout) return 0;
	// ② 浮层不占布局流（**绝不可省** —— 省掉就会把页首盒高当成让位量）
	if (i.position === "absolute" || i.position === "fixed") return 0;
	// ③ 实测空隙优先
	if (i.rectDiff != null && i.rectDiff > HOLE_MIN_PX) return i.rectDiff;
	// ④ / ⑤ 兜底（只在「占布局流」这条分支上才合法）
	if (i.headerOffsetHeight > 0) return i.headerOffsetHeight;
	return i.headerHeightVar > 0 ? i.headerHeightVar : 0;
}
