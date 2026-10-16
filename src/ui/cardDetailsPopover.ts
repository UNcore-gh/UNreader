/** 卡片详情看板（悬停 / 点进度环 → 浮层，不推挤列表）。
 *
 *  ## 为什么是浮层而不是卡内展开
 *
 *  卡内展开会把卡片自身撑高、把下方所有卡片顶走（列表位置跳动，滚到一半的内容
 *  会跑到别处）；而看板是「临时看一眼」的信息，属于典型的 hover card 场景。
 *  用户 2026-10-13 定稿：浮层。
 *
 *  ## 触发与关闭（一条判据，两条通路）
 *
 *  · **桌面（`(hover: hover)`）**：`mouseenter` 延迟 {@link OPEN_DELAY_MS} 开，
 *    `mouseleave` **立即**关 —— 用户 2026-10-13 明示：「鼠标悬停显示卡片元数据，挪开要
 *    立马让元数据消失，哪怕鼠标在元数据的卡片上也一样」。所以①**没有关闭宽限**、
 *    ②看板自身**不挂** `mouseenter/mouseleave`（原来那一对是给「指针移到看板上」留时间的，
 *    留着它就会把「挪开立即消失」这条语义整个抵消掉）。看板是纯展示浮层（`role=tooltip`），
 *    本来也没有可点的东西。
 *  · **触屏 / 无悬停环境**：点进度环切换（点卡片其他地方仍是「打开内容」）。
 *  · 关闭：鼠标离开、`Esc`、点看板与卡片之外、滚动、窗口尺寸变化 —— 全部收口到
 *    {@link hideCardDetails}，避免出现「滚走了看板还钉在原地」。
 *
 *  ## 单例
 *
 *  整个应用共用**一个**浮层元素（懒创建）。同时最多只有一个看板可见 —— 鼠标在
 *  卡片之间移动时是「换内容 + 重新定位」，不是叠一堆浮层。
 */

export interface CardDetailRow {
	label: string
	value: string
	/** accent = 强调（进度 / 状态）；muted = 次要；warn = 需要注意（无正文等） */
	tone?: "accent" | "muted" | "warn"
}

export interface CardDetailSection {
	/** 分组小标题；不给则该组无标题 */
	title?: string
	rows: CardDetailRow[]
	/** 该组末尾的标签串（如 frontmatter 的 tags） */
	chips?: string[]
	/** 该组末尾的一段长文本（如摘要 / 正文首行） */
	text?: string
}

export interface CardDetailsContent {
	title: string
	subtitle?: string
	sections: CardDetailSection[]
}

/** 卡片的「详情提供者」：拿卡片元素换一份可渲染的看板内容；返回 null 表示不展开。 */
export type CardDetailsProvider = (card: HTMLElement) => CardDetailsContent | null

/** 悬停多久才开（防「鼠标扫过一路」把一排看板都弹出来） */
const OPEN_DELAY_MS = 240
/** 看板宽度（与 styles.css 的 `width` 保持一致，定位时用它兜底量不到的情况） */
const PANEL_WIDTH = 264

let panelEl: HTMLElement | null = null
let currentCard: HTMLElement | null = null
let openTimer: number | null = null
let globalsBound = false

function clearOpenTimer(): void {
	if (openTimer != null) {
		window.clearTimeout(openTimer)
		openTimer = null
	}
}

function panelVisible(): boolean {
	return !!panelEl && panelEl.classList.contains("is-visible")
}

function ensurePanel(): HTMLElement {
	if (panelEl && panelEl.isConnected) return panelEl
	const el = document.createElement("div")
	el.className = "unreader-card-details"
	el.setAttribute("role", "tooltip")
	// ⚠️ **刻意不挂** mouseenter/mouseleave：看板不吃指针（挪开卡片就立即消失，见文件头）。
	document.body.appendChild(el)
	panelEl = el
	return el
}

function bindGlobals(): void {
	if (globalsBound) return
	globalsBound = true
	// 捕获阶段：任何滚动（含侧栏内部滚动）都让看板立即消失 —— 它用 fixed 定位，
	// 不跟着卡片走，留着只会错位。**没展开时直接返回**：这条监听挂在 document 上，
	// 全应用的滚动都会经过它（移动端尤其频繁），空转也要保持零成本。
	document.addEventListener("scroll", () => {
		if (!panelVisible() && !currentCard) return
		hideCardDetails()
	}, { capture: true, passive: true })
	window.addEventListener("resize", () => hideCardDetails(), { passive: true })
	document.addEventListener("keydown", event => {
		if (event.key === "Escape") hideCardDetails()
	})
	document.addEventListener("pointerdown", event => {
		const target = event.target as HTMLElement | null
		if (!target) return
		if (panelEl?.contains(target)) return
		if (target.closest(".unreader-card-details-trigger")) return
		hideCardDetails()
	}, { capture: true })
}

function render(content: CardDetailsContent): void {
	const el = ensurePanel()
	el.empty()
	const head = el.createDiv({ cls: "unreader-card-details-head" })
	head.createDiv({ cls: "unreader-card-details-title", text: content.title })
	if (content.subtitle) head.createDiv({ cls: "unreader-card-details-subtitle", text: content.subtitle })
	for (const section of content.sections) {
		const box = el.createDiv({ cls: "unreader-card-details-section" })
		if (section.title) box.createDiv({ cls: "unreader-card-details-section-title", text: section.title })
		for (const row of section.rows) {
			const line = box.createDiv({ cls: "unreader-card-details-row" })
			line.createSpan({ cls: "unreader-card-details-label", text: row.label })
			const value = line.createSpan({ cls: "unreader-card-details-value", text: row.value })
			if (row.tone) value.classList.add(`is-${row.tone}`)
		}
		if (section.chips?.length) {
			const chipRow = box.createDiv({ cls: "unreader-card-details-chips" })
			for (const chip of section.chips) chipRow.createSpan({ cls: "unreader-card-details-chip", text: chip })
		}
		if (section.text) box.createDiv({ cls: "unreader-card-details-text", text: section.text })
	}
}

function place(card: HTMLElement): void {
	const el = ensurePanel()
	const rect = card.getBoundingClientRect()
	const width = el.offsetWidth || PANEL_WIDTH
	const height = el.offsetHeight || 0
	const margin = 10
	const gap = 10
	let left = rect.right + gap
	if (left + width > window.innerWidth - margin) left = rect.left - width - gap
	if (left < margin) left = Math.max(margin, window.innerWidth - width - margin)
	let top = rect.top
	if (height && top + height > window.innerHeight - margin) {
		top = Math.max(margin, window.innerHeight - margin - height)
	}
	el.style.left = `${Math.round(left)}px`
	el.style.top = `${Math.round(Math.max(margin, top))}px`
}

/** 先渲染、再显示、**最后**定位：`place()` 要读 `offsetWidth/offsetHeight`，
 *  而 `display:none` 的元素量到的是 0（首次展开会退到常量宽度、且不做纵向钳制）。 */
function openFor(card: HTMLElement, content: CardDetailsContent): void {
	render(content)
	const el = ensurePanel()
	el.classList.add("is-visible")
	place(card)
	currentCard = card
}

/** 立即收起看板（面板重渲染 / 卡片消失前必须调用，否则浮层会留在屏幕上）。 */
export function hideCardDetails(): void {
	clearOpenTimer()
	currentCard = null
	if (panelEl) {
		panelEl.classList.remove("is-visible")
		panelEl.empty()
	}
}

/** 立刻展开某张卡的看板（不过悬停延迟）。 */
export function showCardDetailsNow(card: HTMLElement, provider: CardDetailsProvider): void {
	clearOpenTimer()
	const content = provider(card)
	if (!content) return
	openFor(card, content)
}

/** 给一张卡片装上看板接线。`ring` 给定时那枚环同时是「无悬停环境」的开关。 */
export function attachCardDetails(card: HTMLElement, provider: CardDetailsProvider, ring?: HTMLElement | null): void {
	bindGlobals()
	const hoverable = typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches
	const open = (): void => {
		const content = provider(card)
		if (!content) return
		openFor(card, content)
	}
	if (hoverable) {
		card.addEventListener("mouseenter", () => {
			clearOpenTimer()
			openTimer = window.setTimeout(() => {
				openTimer = null
				if (currentCard === card) return
				open()
			}, OPEN_DELAY_MS)
		})
		// 挪开卡片 → **立即**收起（不设宽限、也不管指针是不是落在看板上）
		card.addEventListener("mouseleave", () => hideCardDetails())
	}
	if (ring) {
		ring.classList.add("unreader-card-details-trigger")
		ring.setAttribute("tabindex", "0")
		ring.addEventListener("click", event => {
			event.stopPropagation()
			event.preventDefault()
			if (currentCard === card && panelVisible()) hideCardDetails()
			else open()
		})
		ring.addEventListener("keydown", event => {
			if (event.key !== "Enter" && event.key !== " ") return
			event.preventDefault()
			event.stopPropagation()
			if (currentCard === card && panelVisible()) hideCardDetails()
			else open()
		})
	}
}

/** 当前是否可见（诊断 / 测试用）。 */
export function cardDetailsVisible(): boolean {
	return panelVisible()
}
