/**
 * 核心模态框的焦点仲裁 —— **`.modal-container` 开着时，阅读器一律不持有、不抢走键盘焦点**。
 *
 * ## 症状，以及为什么「修过还会冒出来」
 *
 * 用户报障原话：「（移动端）第一次在命令面板运行命令会失败，第二次才可以正常运行」。
 * 机制是**焦点被阅读器抢回去**：命令面板的输入框刚拿到焦点，阅读器又有一条异步路径把
 * 焦点拉回正文容器（`.unreader-continuous`）→ 打字与回车落回书页、软键盘被收起 →
 * 这一次点按/回车无效；第二次因为那条异步路径已经跑完，就好了。
 *
 * 关键在于：抢焦点的**写入点不止一处，触发路径三十余条**（翻页 / 上下章 / 目录跳转 /
 * 恢复落点 / `settleJump` 定时器 / resize 补落 / 章节 iframe 的 `focusin` …），每条都
 * 落在不同的异步时序上。上一轮的做法是**逐条加观察器、逐条补判据** —— 加完这条，
 * 下一条换个时序又冒出来。这就是用户说的「每次解决之后都有可能再次冒出来」的形状：
 * **补丁数量跟路径数量同阶，而路径会持续增加。**
 *
 * ## 做法：不枚举路径，在汇合点设门
 *
 * 判据只有一个（有没有模态框），门的数量与**写入点**数量相等，而不是与路径数量相等：
 *
 *   · `hasCoreModal()` —— 每次「阅读器要抢焦点」之前问一句；模态框开着就**不抢**。
 *   · `watchCoreModal()` —— 模态框出现的**那一刻**，把阅读器已抓在手上的焦点**交出去**。
 *     （门只在「下次来抢」时生效，管不了「已经抢在手上」的那一份，所以这两条都要有。）
 *   · `arbitrateReaderFocus()` —— **闭环**：它开着期间的**每一次**焦点落地都过一遍，
 *     落进阅读器就归还给弹窗。前三层是「堵已知入口」，这一层是「事后兜住未知入口」。
 *   · `focusModalPrimary()` —— 归还的**动作原语**，而且语义是「交给弹窗」而不是
 *     「blur 到 body」（后者会收掉软键盘、吃掉紧接着的那一次点按/回车）。
 *
 * 新增调用路径天然被覆盖：门在汇合点上，不在路径上。
 *
 * 四层的关系是**纵深**，不是重复：
 *   写入点上的门 → 减少「抢了又被收回去」的抖动（一次都不该抢）；
 *   `watchCoreModal` → 覆盖「开窗前已经抢了」；
 *   `arbitrateReaderFocus` → 覆盖「开窗后从没被枚举到的入口」；
 *   `focusModalPrimary` → 保证收回来的那一份真的握在弹窗手里，而不是空握。
 *
 * 缺任何一层都会有具体的漏：
 *   只有写入点门 → 新入口漏；
 *   只有 `watchCoreModal` → 开窗后的异步抢回漏（软键盘弹起引发的 resize 补载正是这条）；
 *   只有 arbitration 没有 `focusModalPrimary` → 焦点被摘到 body，第一次点按照样无效。
 *
 * ## 判据为什么是 `.modal-container`
 *
 * 官方 `Modal` 把容器挂在 `body` 上（与 `.app-container` 是兄弟，见 `ui/keyboardInset.ts`
 * 与 `test/modal-kb.html` 的前提断言）；命令面板 / 快速切换 / 设置 / 任何插件弹窗
 * **都是** `Modal` 子类 → 一个选择器覆盖全部弹窗。
 * 插件自己的面板（目录轨、标注侧栏、外观面板）不是 `Modal` → 不受影响，照旧。
 *
 * ## 为什么不用定时器轮询
 *
 * 轮询把「结构保证」换成「概率保证」：模态框与抢焦点之间只要有一次落在两个轮询点之间
 * 就漏，而漏掉的那一次正是用户看到的那一次。这里两条都是事件驱动 + 按需判定，没有时间窗。
 */

/** 解析要判定的文档：显式传入优先，否则用当前 window 的 document。
 *  iframe 上下文里调用时必须显式传宿主文档 —— iframe 内部永远没有 `.modal-container`。 */
function resolveDoc(doc: Document | null | undefined): Document | null {
	if (doc) return doc;
	return typeof document !== "undefined" ? document : null;
}

/** 文档里是否挂着核心模态框（命令面板 / 快速切换 / 设置 / 任意 `Modal` 子类）。
 *
 *  查询失败一律当「没有」：判据本身出错时不能把阅读器的键盘交互整体锁死。 */
export function hasCoreModal(doc?: Document | null): boolean {
	const d = resolveDoc(doc);
	if (!d) return false;
	try {
		return d.querySelector(".modal-container") !== null;
	} catch {
		return false;
	}
}

/** 节点自身或其子树里是否是模态框容器（判定单个变更节点，不做文档级查询）。 */
function nodeIsModalContainer(n: Node): boolean {
	if (!n.instanceOf(Element)) return false;
	try {
		return n.classList.contains("modal-container") || n.querySelector(".modal-container") !== null;
	} catch {
		return false;
	}
}

/** 模态框「由关到开」的那一次通知；返回取消订阅。
 *
 *  只报**跃迁**（关→开），不报重复出现：同一个模态框内部插节点、正文补载章节 frame
 *  都会让 `body` 子树变动，逐次回调等于给热路径加噪声。
 *
 *  **判定走变更节点，不做文档级查询**：这个观察器挂在 `body` 子树（章节 frame 补载、
 *  高亮重绘都会触发），`document.querySelector(".modal-container")` 每次都做一遍
 *  就把它变成热路径上的固定开销。这里只在**新增/移除的节点**里找，成本与本次变动同阶；
 *  文档级查询留给按需判定的 `hasCoreModal()`（它只在「阅读器想抢焦点」时被调用）。 */
export function watchCoreModal(onOpen: () => void, doc?: Document | null): () => void {
	const d = resolveDoc(doc);
	if (!d || typeof MutationObserver === "undefined") return () => { /* noop */ };
	let open = hasCoreModal(d);
	let mo: MutationObserver | null = null;
	try {
		mo = new MutationObserver(muts => {
			let added = false;
			let removed = false;
			for (const m of muts) {
				if (!added) m.addedNodes.forEach(n => { if (!added && nodeIsModalContainer(n)) added = true; });
				if (!removed) m.removedNodes.forEach(n => { if (!removed && nodeIsModalContainer(n)) removed = true; });
			}
			// 关→开
			if (added) {
				if (!open) {
					open = true;
					try {
						onOpen();
					} catch {
						/* 订阅者自身异常不得影响观察器 */
					}
				}
				return;
			}
			// 开→关（不通知，只更新状态，保证下一次「关→开」还能报）
			if (removed) open = false;
		});
		mo.observe(d.body ?? d.documentElement, { childList: true, subtree: true });
	} catch {
		mo = null;
	}
	return () => {
		try {
			mo?.disconnect();
		} catch {
			/* ignore */
		}
		mo = null;
	};
}

/** 焦点若在 `el` 或其子树内就摘掉它；返回是否真的摘了。
 *
 *  **只交不抢**：焦点在别处（比如模态框自己的输入框）时一律不碰。
 *  这是 `watchCoreModal` 那条通路的动作原语。 */
export function blurIfFocusInside(el: Element | null | undefined, doc?: Document | null): boolean {
	const d = resolveDoc(doc);
	if (!el || !d) return false;
	try {
		const active = d.activeElement;
		if (!active || active === d.body) return false;
		if (active !== el && !el.contains(active)) return false;
		(active as HTMLElement).blur();
		return true;
	} catch {
		return false;
	}
}

/** 「配接管键盘」的元素 —— **只认文本输入类**。
 *
 *  ## 为什么把 `[tabindex]` 一类「可聚焦容器」排除掉（踩过一次，很坏）
 *
 *  第一版写的是 `… [tabindex]:not([tabindex='-1'])`，意图是「弹窗里没有输入框时退而求其次，
 *  至少把焦点交给某个可聚焦控件」。实测后果是**弹窗彻底不能用**：
 *
 *  · `querySelector` 取的是**文档序第一个**匹配 —— Obsidian 弹窗里排在真正输入框**之前**
 *    的包裹层（结果列表的 tabindex 容器、外层滚动区等）会先命中；
 *  · 焦点于是被送进一个**不处理按键**的 div：打字打不进去、回车不触发任何东西，
 *    而且它每次开窗/每次焦点一乱都重演 → 用户看到的是「**任何一个次数的命令都无法启用**」，
 *    比原来的「第一次失败」严重得多。
 *
 *  正确的判据是「这个元素拿住键盘**有用**吗」：只有文本输入类有用。没有就**什么都不做**
 *  —— 让官方自己聚焦，比塞给一个吞键的容器好。 */
const MODAL_TEXT_ENTRY = "input, textarea, [contenteditable='true'], [contenteditable='']";

/** 非文本类 `input`（拿住键盘没意义，甚至会误导） */
const NON_TEXT_INPUT_TYPES = new Set([
	"hidden", "checkbox", "radio", "button", "submit", "reset", "file",
	"range", "color", "image", "date", "time", "datetime-local", "month", "week",
]);

/** 把键盘焦点**交给弹窗**（而不是只把阅读器那份 blur 掉）。
 *
 *  ## 为什么必须「交出去」而不是「摘掉」
 *
 *  `blur()` 的落点是 `document.body` —— **没有任何元素持有键盘**。此时：
 *   · 移动端软键盘被收起（iOS 只要输入框失焦就收键盘，即便马上又聚焦回去，
 *     也要等一次新的用户手势才会再弹）；
 *   · 用户紧接着的那一次点按/回车落在 `body` 上，`SuggestModal` 的输入框收不到
 *     → **第一次操作无效**，第二次才好。
 *
 *  这正是用户报的「第一次在命令面板运行命令失败，第二次才可以」的另一半：
 *  上一版只做了 `blurIfFocusInside`（摘），摘完就没人拿着键盘了。语义应该是
 *  「移交给弹窗」，不是「扔到 body 上」。
 *
 *  已经在弹窗里（`activeElement` 属于该容器）时一律不碰 —— 那是弹窗自己刚聚焦好的，
 *  再去动它就是反向干扰。找不到文本输入（弹窗还没渲染完 / 它本就不是输入型弹窗）
 *  返回 false，**交由官方接管**。 */

/** 「当前真正在用的」弹窗容器：**从后往前**取第一个既可见又有几何的。
 *
 *  ## 为什么不是 `querySelector`（取第一个）
 *
 *  DOM 里可能**同时**存在多个 `.modal-container`：别的插件残留的隐藏容器、关闭动画中的
 *  旧弹窗、以及刚开的这个。新开的总是**最后**插入的（越晚越在上层）。取第一个往往拿到
 *  陈旧/隐藏的那个 → 把键盘送进一个用户根本看不见的弹窗 → 当前弹窗永远收不到回车。
 *
 *  可见性判据只看 `display/visibility` + 几何，**不看 `opacity`**：Obsidian 弹窗有淡入，
 *  判定时刻可能正好落在 opacity 还很小的那一帧，把 opacity 算进来会把正在开的弹窗误杀。 */
export function activeModalContainer(doc?: Document | null): HTMLElement | null {
	const d = resolveDoc(doc);
	if (!d) return null;
	let list: HTMLElement[];
	try {
		list = Array.from(d.querySelectorAll<HTMLElement>(".modal-container"));
	} catch {
		return null;
	}
	for (let i = list.length - 1; i >= 0; i--) {
		const el = list[i];
		if (!el) continue;
		try {
			if (!el.isConnected) continue;
			const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
			if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) continue;
			return el;
		} catch { /* 单个容器判定失败不影响其余 */ }
	}
	return null;
}

/** 容器里配接管键盘的**文本输入**元素；没有则 null（调用方负责「什么都不做」）。 */
function modalTextEntry(container: HTMLElement): HTMLElement | null {
	let cands: HTMLElement[];
	try {
		cands = Array.from(container.querySelectorAll<HTMLElement>(MODAL_TEXT_ENTRY));
	} catch {
		return null;
	}
	for (const el of cands) {
		try {
			// 非文本 input（checkbox/button/… ）拿住键盘没有意义
			if (el.tagName === "INPUT") {
				const t = (el.getAttribute("type") ?? "text").toLowerCase();
				if (NON_TEXT_INPUT_TYPES.has(t)) continue;
			}
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) continue;
			return el;
		} catch { /* ignore */ }
	}
	return null;
}

export function focusModalPrimary(doc?: Document | null): boolean {
	const d = resolveDoc(doc);
	if (!d) return false;
	try {
		const mc = activeModalContainer(d);
		if (!mc) return false;
		const cur = d.activeElement;
		// 焦点已经在**这个**弹窗里 → 视为已达成，不再动
		// （焦点在弹窗内部怎么走是弹窗自己的事，我们插进去只会打乱它）
		if (cur && mc.contains(cur)) return true;
		const target = modalTextEntry(mc);
		if (!target) return false;
		target.focus({ preventScroll: true });
		return true;
	} catch {
		return false;
	}
}

/** **闭环守卫**：核心模态框开着期间，只要焦点沾到阅读器就立刻归还给弹窗。
 *
 *  ## 为什么前面那四个写入点上的门还不够
 *
 *  门设在写入点上 = 「已知的抢焦点位置」都堵住了，但**判据的完备性依赖人工枚举**
 *  （这也是 `test:focusgate` 里那条「写入点数量钉死」断言存在的理由）。而真实世界
 *  里焦点还有别的入口：`iframe.contentWindow.focus()`、浏览器的焦点恢复、系统级
 *  快捷键、别的插件主动 `focus()`、以及将来任何人新加的一行。
 *
 *  这里换一条**不依赖枚举**的判据 —— 问 `focusin` 事件本身：焦点一旦落进阅读器，
 *  在**同一个任务**里（捕获阶段，早于任何业务处理器）就把焦点请回弹窗。不管是谁
 *  干的、用什么 API 干的，都在覆盖范围内。
 *
 *  ## 三条硬约束
 *
 *  1. **只在模态框开着时武装**（`watchCoreModal` 的关→开跃迁）。平时那条监听器
 *     第一次判断就返回，零成本；也绝不会在正常阅读时把焦点从书里拽走。
 *  2. **只管「进阅读器」这一个方向**：焦点落在别处（含弹窗内部、其他插件视图）
 *     一律不碰 —— 否则就变成抢焦点的另一方，把模态框的输入框按死。
 *  3. **归还目标是弹窗里现测的**文本输入**元素**（`focusModalPrimary`），不是写死的
 *     选择器、不是 `body`、也**不是任意可聚焦容器**。找不到目标时**什么都不做**
 *     —— 「摘到 body」收软键盘，「塞给吞键的容器」让弹窗永远收不到回车。
 *
 *  与 `watchCoreModal` 的分工：那个管**模态框出现的那一刻**（把已经抓在手上的
 *  焦点交出去），这个管**它开着期间的每一次**。两条都以「弹窗容器」为唯一判据。
 *
 *  @param readerRoot 阅读器视图容器（`ItemView.containerEl`）
 *  @param doc        宿主文档；不传取当前 `document`
 *  @param onArbitrate 可选取证回调（只在真的发生归还时调用一次）
 */
export function arbitrateReaderFocus(
	readerRoot: Element | null | undefined,
	doc?: Document | null,
	onArbitrate?: (ev: Event, from: Element) => void,
): () => void {
	const d = resolveDoc(doc);
	if (!d || !readerRoot) return () => { /* noop */ };
	// 只在模态框生命周期内武装；未武装时事件处理器第一句就返回
	let armed = false;

	const onFocusIn = (ev: Event): void => {
		if (!armed) return;
		if (!hasCoreModal(d)) {
			armed = false;
			return;
		}
		const from = ev.target as Element | null;
		if (!from) return;
		// 只处理「焦点进了阅读器」——注意 iframe 元素本身也在 readerRoot 子树里，
		// 所以「点进书页」这一路同样被覆盖
		if (from !== readerRoot && !readerRoot.contains(from)) return;
		// 归还：**只在弹窗里真的有文本输入可接管时**才动。找不到目标时**什么都不做** ——
		// 「摘到 body」会收掉软键盘、把紧随的点按/回车丢给 body；「塞进某个可聚焦容器」
		// 更坏（那容器不处理按键，弹窗从此收不到回车）。宁可不动，交给官方。
		if (!focusModalPrimary(d)) return;
		try { onArbitrate?.(ev, from); } catch { /* 取证不得影响仲裁 */ }
	};

	const unwatch = watchCoreModal(() => { armed = true; }, d);
	try {
		// 捕获阶段：抢在任何业务处理器之前，避免「弹窗输入框刚收到键、又被拽走」的中间态
		d.addEventListener("focusin", onFocusIn, true);
	} catch { /* 监听器挂不上则退化为「只有写入点上的门」 */ }

	return () => {
		armed = false;
		try { d.removeEventListener("focusin", onFocusIn, true); } catch { /* ignore */ }
		try { unwatch(); } catch { /* ignore */ }
	};
}
