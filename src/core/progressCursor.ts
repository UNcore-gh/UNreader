import { BookPosition } from "../types"

/**
 * 「可以被落盘的当前位置」的守卫（视图层不变式，2026-09-14 加）。
 *
 * 为什么需要它：阅读位置由 relocate 事件驱动落盘，而 relocate 有两类**不属于
 * 用户当前位置**的噪声 ——
 *   ① **恢复期**的首次 relocate。`renderSection` 一挂上 frame，foliate 就发一次
 *      relocate，此刻视口还在书首（或占位估算的落点）—— 写进去等于把用户的进度
 *      冲成书首（AGENTS.md 的「恢复落定前不落盘」那条）。视图层用 `restoring`
 *      挡住了**去抖写**，却漏了 `flushPosition()`（关闭视图/退出应用走的那条）：
 *      它读的是 `lastRelocate`，而那个字段在恢复期**照样被赋值**。于是
 *      「打开一本大书 → 还没开完就关掉标签页 / 退出应用」会把书首位置写进进度文件，
 *      下一次打开就从书首开始 —— 用户报的「偶尔进度丢失」。
 *   ② **换书后残留的 relocate**。旧书的 adapter 销毁前、或旧视图的节流回调里
 *      还会推一次旧位置，而此时 `view.file` 已经是新书 → 旧锚点被写进**新书**的
 *      进度文件（新书下次打开就落在一个对不上的锚点上）。
 *
 * 两条都收敛成同一句话：**只有「恢复期已结束」且「属于当前这本书」的落点才允许
 * 落盘**。把这条不变式放进一个纯函数式的小类，是为了能在 node 探针里直接跑它
 * （不需要 DOM），并且能把「去掉 trusted 判断」当阴性对照注回去。
 *
 * 注意 `updatedAt` 用的是**捕获时刻**而不是落盘时刻：flush 发生在关闭/切后台时，
 * 若拿 `Date.now()` 给一个几分钟前的旧位置盖新时间戳，它就会在多端合并里赢过
 * 他端更靠后的位置（另一台设备同一本书读得更远）。捕获时刻才是这句话的真实语义。
 */
export class ProgressCursor {
	/** 当前这本书的路径（`reset` 时更新） */
	private path = ""
	private pos: BookPosition | null = null

	/** 开始加载某本书：清掉上一本的落点（换书时旧落点再也不许落盘） */
	reset(bookPath: string): void {
		this.path = bookPath
		this.pos = null
	}

	/** 记一次 relocate。`trusted=false`（恢复期）与路径不符的直接丢弃。 */
	note(bookPath: string, anchor: string, fraction: number, updatedAt: number, trusted: boolean): void {
		if (!trusted || !anchor || bookPath !== this.path) return
		this.pos = { anchor, fraction, updatedAt }
	}

	/** 取当前可落盘的位置（路径不符/从未记录返回 null） */
	take(bookPath: string): BookPosition | null {
		if (!this.pos || bookPath !== this.path) return null
		return { ...this.pos }
	}
}
