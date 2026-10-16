/**
 * 桌面端「页首背景板 / 进度条看不看得见」的诊断事实采集
 * （**纯读取，不做任何写入/判定**）。
 *
 * 独立成模块的唯一理由：它要能被探针（`test/headerbanddiag-probe.ts`）在**真机级
 * 夹具**（官方 app.css 真身 + 完整祖先链）里直接跑，证明「采到的事实是属实的」。
 * 若把它留在 readerView 里，就只能靠人肉开 devtools 抄值 —— 而一个**静默失效**的
 * 诊断（例如某个选择器其实选不中、于是永远记 `(无)`）比没有诊断更糟：它会让人相信
 * 「这条带不是那一层画的」。
 *
 * **为什么必须带「裁剪祖先链」**（本轮新增）：真机实测（`?theme-clip=1` 档）证明
 * 下面这种组合会同时制造用户的**两个**症状：
 *   · 补偿层 / 进度条的**计算样式完全正确**（`height:38px`、`bg:阅读区底色`、
 *     `top:0.1 h:3`），
 *   · 而屏幕像素上是 `rgb(30,30,30)` 的板 / 什么都没有。
 * 因为 `getComputedStyle` 与 `getBoundingClientRect` **都与裁剪无关** —— 主题把
 * `.view-content` 按回裁剪盒后，两样东西（都画在它的盒子之外）被整条裁掉，
 * 而所有「读属性」的诊断依旧报告「一切正常」。**唯一的解释路径是裁剪盒**，
 * 所以链上每一层的 overflow/contain 必须记下来。
 *
 * 采集哪些事实、为什么是这些，见 `readerView.logHeaderBandDiag` 的注释。
 */

/** syncProgressTop 算出来的量（拿不到时传缺省值，见调用方） */
export interface HeaderBandMetrics {
	/** 页首是否由本插件隐藏（`headerHiddenState`） */
	hiddenByUs: boolean;
	/** root 顶边相对叶子顶边的位移 = 页首在流内占的高度（页首隐藏后即「留下的空隙」） */
	rootTop: number;
	/** 写入 `--ur-header-hole` 的值（补偿层高度） */
	hole: number;
	/** 写入 `--ur-progress-top` 的值（进度条让位，**root 坐标系**，页首隐藏时为负） */
	pad: number;
	/** 写入 `--ur-top-inset` 的值（不透明悬浮 UI 让位） */
	uiInset: number;
	/** 安全区下沿 */
	safeTop: number;
}

const n1 = (n: number | undefined | null): string =>
	n == null || !Number.isFinite(n) ? "-" : String(Math.round(n));

const n2 = (n: number | undefined | null): string =>
	n == null || !Number.isFinite(n) ? "-" : String(Math.round(n * 10) / 10);

/** 元素的**计算**底色；取不到给 `(无)`（区别于「透明」，后者是 `rgba(0, 0, 0, 0)`） */
const bgOf = (el: Element | null | undefined): string => {
	if (!el) return "(无)";
	try {
		return window.getComputedStyle(el).backgroundColor;
	} catch {
		return "(读取失败)";
	}
};

/** 自定义属性的**解析后**值。注意：`--view-header-top-offset` 这类是未解析 token 流，
 *  直接读会拿到字符串 `max(59px, 12px)` —— 在诊断里如实记录反而有用（能看出它存不存在）。 */
const varOf = (el: Element | null | undefined, name: string): string => {
	if (!el) return "(无)";
	try {
		return window.getComputedStyle(el).getPropertyValue(name).trim() || "(空)";
	} catch {
		return "(读取失败)";
	}
};

/**
 * 该层是否**制造裁剪盒**。返回 `null` = 不裁剪。
 * 覆盖 `overflow`（含 `clip`/`hidden`/`scroll`/`auto`）与 `contain` 的 paint 系
 * （`paint` / `content` / `strict` 含 paint；`layout` / `size` **不**裁剪），
 * 以及 `clip-path`。这三类是「几何正确却看不见」的全部可能来源。
 */
function clipKindOf(cs: CSSStyleDeclaration): string | null {
	if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
		return `overflow:${cs.overflowX}/${cs.overflowY}`;
	}
	const c = String(cs.contain || "");
	if (c && c !== "none") {
		if (/\b(paint|content|strict)\b/.test(c)) return `contain:${c}`;
	}
	if (cs.clipPath && cs.clipPath !== "none") return `clip-path:${cs.clipPath.slice(0, 24)}`;
	return null;
}

/** 元素的**内边距盒**（= overflow / contain:paint 的裁剪边），绝对坐标 */
function paddingBoxOf(el: HTMLElement): { top: number; bottom: number; left: number; right: number } | null {
	try {
		const r = el.getBoundingClientRect();
		const top = r.top + el.clientTop;
		const left = r.left + el.clientLeft;
		return { top, left, right: left + el.clientWidth, bottom: top + el.clientHeight };
	} catch {
		return null;
	}
}

/**
 * 从 `el` 往上走到 `stopAt`（含），逐层记「是否裁剪 + 目标是否落在其裁剪盒之外」。
 * `target` 是要检查的元素（通常是进度条 / 补偿层）。
 *
 * 判据 `inside` 用了 `clientWidth/Height`（内边距盒）—— 那正是 overflow 与
 * contain:paint 的裁剪边；滚动条的 `clientXxx` 已经把它排除在外，不必再算。
 */
function clipChainOf(el: HTMLElement | null, stopAt: HTMLElement | null, target: DOMRect): string {
	if (!el) return "(无)";
	const parts: string[] = [];
	try {
		let n: HTMLElement | null = el.parentElement;
		let hops = 0;
		while (n && hops++ < 30) {
			const cs = window.getComputedStyle(n);
			const kind = clipKindOf(cs);
			if (kind) {
				const pb = paddingBoxOf(n);
				// 目标是否**完全**落在该层内边距盒内。越界 = 该层会把它裁掉。
				const inside = pb
					? target.top >= pb.top - 0.5 && target.bottom <= pb.bottom + 0.5
						&& target.left >= pb.left - 0.5 && target.right <= pb.right + 0.5
					: null;
				const cls = String(n.className || n.tagName).split(/\s+/).slice(0, 2).join(".");
				parts.push(`${cls}[${kind}]`
					+ (inside === false ? `→裁掉(目标${n2(target.top)}..${n2(target.bottom)} 盒${n2(pb!.top)}..${n2(pb!.bottom)})` : "→范围内"));
			}
			if (n === stopAt) break;
			n = n.parentElement;
		}
	} catch {
		return "(读取失败)";
	}
	return parts.length ? parts.join(" ∧ ") : "无裁剪层(到叶子为止)";
}

/**
 * 采集一次快照。调用方负责节流与去重（本函数每次都真读 DOM，有强制同步布局开销）。
 * `root` / `leaf` / `header` / `bar` 允许为 null（视图未就绪），此时对应字段记 `(无)`，绝不抛。
 */
export function collectHeaderBandFacts(
	root: HTMLElement | null,
	leaf: HTMLElement | null,
	header: HTMLElement | null,
	bar: HTMLElement | null,
	m: HeaderBandMetrics,
): Record<string, string> {
	const facts: Record<string, string> = {};

	// ① 宿主环境：判据分支全在这串类名里（is-mobile / is-tablet / is-phone /
	//    show-view-header / is-floating-nav / is-hidden-nav），故障复现第一步就是核对它
	facts.body = document.body.className;
	facts.hiddenByUs = String(m.hiddenByUs);

	// ② 页首：**必须带 display/visibility/opacity** —— 官方隐藏用 transform，
	//    元素仍在布局流内、rect 带负位移，只看 rect 高度会误判成「页首还在占位」
	if (header) {
		let line = "(读取失败)";
		try {
			const r = header.getBoundingClientRect();
			const cs = window.getComputedStyle(header);
			line = `h=${n1(r.height)} bottom=${n1(r.bottom)} top=${n1(r.top)}`
				+ ` display=${cs.display} vis=${cs.visibility} op=${cs.opacity}`
				+ ` transform=${cs.transform}`;
		} catch { /* 保持 (读取失败) */ }
		facts.header = line;
	} else {
		facts.header = "(不在 DOM)";
	}

	// ②′ **页首的 DOM 归属与布局契约**（2026-09-14 新增 —— 「页首背景板」最新一次的
	//     根因就落在这里，而旧报告**完全看不到它**）。
	//
	//     教训：本插件针对页首的规则必须**只用元素级类**（`unreader-view-header`，
	//     由 `readerView.markViewHeader` 挂）。写成 `[data-type="unreader-view"]
	//     .view-header` 这种后代选择器时，它隐含「页首是叶内容的**后代**」这个
	//     **会漂移的 DOM 结构假设**；假设不成立（页首成了 `.workspace-leaf` 的直接
	//     子项）时那条规则**静默不命中** → 页首退回官方 `static` → **占布局流** →
	//     藏掉之后它占的那条 56/103px 原样留着，画的是 `.workspace-leaf` 的
	//     `--background-secondary`（obsidian 次级色）= 用户报的「页首元素的背景板
	//     又出现了，颜色跟随 obsidian，遮挡书籍正文文字」。
	//     而**报告里其它字段全都是正常的**（页首确实隐藏了、变量也对、叶子类也在）
	//     —— 与桌面端第四轮「条正常、板还在」是同一类静默失效。
	//     所以这里把三件事一次报全：页首挂在哪、那条旧选择器还命不命中、契约类挂上没有。
	if (header) {
		let line = "(读取失败)";
		try {
			const cs = window.getComputedStyle(header);
			const parent = header.parentElement;
			line = `parent=<${parent
				? parent.tagName.toLowerCase() + "." + String(parent.className || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".")
				: "无"}>`
				+ ` legacySel=${header.matches('.workspace-leaf-content[data-type="unreader-view"] .view-header')}`
				+ ` contractCls=${header.classList.contains("unreader-view-header")}`
				+ ` position=${cs.position} flex=${cs.flex}`;
		} catch { /* 保持 (读取失败) */ }
		facts.headerPlacement = line;
	} else {
		facts.headerPlacement = "(不在 DOM)";
	}

	// ③ 阅读器子树之外的祖先链底色 —— 「这条带露的是哪一层」由这几行直接回答。
	// **`leafContent` 要报「解析到了谁」，不能只报 found/缺失**（本轮补）：
	// 它是**三件事共用**的上游（叶子底色、补偿层开关类、`--ur-header-hole`）。
	// 解析到错的元素 → 三件事一起静默失效 → 「条很好、板还在」；解析失败同理。
	// 只报 `found` 的话，报告里看不出它到底是不是那块 `.workspace-leaf-content`。
	facts.leafContent = leaf
		? `found <${leaf.tagName.toLowerCase()}.${String(leaf.className || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".")}>`
		: "(缺失)";
	// **补偿层的开关类**（本轮新增，之前漏了它）：
	// `.workspace-leaf-content.unreader-header-hidden::before` 的唯一前提就是这个类。
	// 类没挂上 → 补色层根本不存在 → 顶部那条页首背景板原样出现，而**其它所有字段
	// 都会是正常的**（叶子底色对、变量对、页首也真的隐藏了），极难从报告里看出来。
	// 所以单独记一行：`leaf` = 叶子上的类，`header` = 页首上的类（两者由同一次
	// syncNativeNav 写，理论上同真同假；不同就是写漏了一处）。
	facts.leafHiddenClass = leaf
		? `${leaf.classList.contains("unreader-header-hidden")}`
			+ ` (header=${header ? header.classList.contains("unreader-header-hidden") : "无页首"})`
		: "(无)";
	// 叶子的底色链（inline/computed/var）与 `--ur-reader-bg` 已随「补色」路线删除
	// （2026-09-13 第六轮）：那个变量没有任何消费者了，继续报它只会让人以为
	// 「还有一层在管颜色」。叶子现在只承载一个类，供 v5 兜底规则命中。
	facts.viewContentBg = bgOf(leaf?.querySelector(".view-content"));
	facts.workspaceLeafBg = bgOf(leaf?.closest(".workspace-leaf"));

	// ④ 阅读区自身：行内底色是阅读区底色的取值来源
	facts.rootInlineBg = root?.style.backgroundColor || "(空)";
	facts.rootComputedBg = bgOf(root);

	// ④′ **v4 主防线：根容器自己那条带**（本轮新增）。
	//    与 v1/v3 不同，v4 不依赖 `leafContentEl()` —— 判据只剩一件事：**CSS 规则有没有
	//    真的作用在 root 上**。变量写对了但规则没命中（构建产物没更新 / 主题用更高优先级
	//    写死了 root 的 margin/height / `body.is-mobile` 误判）时，只有这几个数能看出来：
	//      · `marginTop` 应等于 `-hole`、`paddingTop` 应等于 `+hole`、`height` 应等于
	//        `叶子高 − 页首高 + hole`；三者只要不同步就是规则没生效；
	//      · `boxTop`（root 顶边相对叶子顶边的位移）在页首隐藏时应为 **0**，未隐藏时应
	//        等于页首高度 —— 这一个数直接回答「阅读器自己的盒子有没有顶到叶子顶边」，
	//        也就是「那条带有没有被自己的底色盖住」。
	if (root) {
		let line = "(读取失败)";
		try {
			const cs = window.getComputedStyle(root);
			const r = root.getBoundingClientRect();
			const lt = leaf?.getBoundingClientRect().top;
			const boxTop = lt == null ? null : r.top - lt;
			// **本轮的加法：把「这条带到底盖住了没有」写成结论**（不只是几个数）。
			// 为什么要结论：上面三件套（margin/padding/height）要人肉比对才看得出问题，
			// 而真机上「元素消失了、板还在」这个签名**恰好是它们全都正常、只有 boxTop
			// 不为 0 的那一种**（规则生效了但 hole 是 0）。页首由我们隐藏时 boxTop 应当
			// ≈0（root 顶边 = 叶子顶边）；给一行「没盖住，还差 Npx」，
			// 真机日志就能一句话定位，不必再让人对着三个值反推。
			// **结论行必须看「阅读区那一层」，不能看 root 的盒子**：让位现在由 stage 承担，
			// root 的 `boxTop` 恒等于页首高度（不动），拿它当判据会永远报「没盖住」。
			const needCover = m.hiddenByUs;
			const stageTop = (() => {
				try {
					const st = leaf?.querySelector<HTMLElement>(".unreader-stage");
					const lt2 = leaf?.getBoundingClientRect().top;
					return st && lt2 != null ? st.getBoundingClientRect().top - lt2 : null;
				} catch { return null; }
			})();
			const covered = stageTop != null && Math.abs(stageTop) <= 1;
			line = `inlineHole=${root.style.getPropertyValue("--ur-header-hole") || "(未写入)"}`
				+ ` marginTop=${cs.marginTop} paddingTop=${cs.paddingTop} height=${cs.height}`
				+ ` boxTop=${boxTop == null ? "-" : n1(boxTop)} boxH=${n1(r.height)}`
				+ ` bg=${bgOf(root)}`
				+ ` 阅读区top=${stageTop == null ? "-" : n1(stageTop)}`
				+ ` ${varOf(root, "--ur-hole-px") === "(空)" ? "" : "holePx=" + varOf(root, "--ur-hole-px") + " "}`
				+ (needCover
					? (covered ? " → 让位成立（阅读区顶边已到叶子顶边）"
						: ` → **没让位**（页首已隐藏，阅读区顶边却低 ${n1(stageTop)}px）`)
					: " → 页首未隐藏，本区不该上移");
			// 兜底链能看到的东西：`--header-height` 是 v5 兜底用的那个量，
			// 页首实际占位（offsetHeight）与它不等时，兜底会欠冲/过冲 —— 一并记下来。
			line += ` --header-height=${varOf(leaf ?? document.body, "--header-height")}`
				+ ` headerOffsetHeight=${n1(header?.offsetHeight ?? NaN)}`;
		} catch { /* 保持 (读取失败) */ }
		facts.rootBand = line;
	} else {
		facts.rootBand = "(无)";
	}

	// ⑤ 叶子上的两个关键事实：
	//    · `--ur-header-hole` —— 补偿层高度。**页首 display:none（桌面默认形态）时
	//      实测为 0 → 该层自动退化为不存在**，不必另判分支；
	//    · **叶子自己的 overflow** —— 补偿层 v3 的宿主，若叶子自己也裁剪，
	//      那补偿层就无处可去（正常它落在叶子盒内，不该被裁）。
	facts.holeVar = leaf?.style.getPropertyValue("--ur-header-hole") || "(未写入)";
	facts.leafOverflow = leaf ? `${varOf(leaf, "overflow-x")}/${varOf(leaf, "overflow-y")}` : "(无)";

	// ⑤c **叶子正上方那一条到底是谁**（本轮新增）。
	//    为什么必须记：页首被隐藏、root 也覆盖到位之后，阅读区顶上**仍可能有一条带**——
	//    它不属于阅读器子树，而是 Obsidian 工作区自己的东西：桌面端 `.workspace-tabs`
	//    里 `.workspace-tab-header-container` 就压在叶子正上方，另占一个
	//    `height: var(--header-height)`，底板是主题 token `--tab-container-background`
	//    （Composer 把它设成 transparent，官方默认主题下则是不透明 / 半透明的一层）。
	//    **UNreader 全仓库没有任何一条规则碰过它**，v1..v4 四轮修复都在阅读器子树里
	//    绕圈，自然一行日志都不会提到它 —— 于是「元素没了、上面还有块板」这种现象
	//    在诊断里是**不可见**的。这一行就是把它变成可见事实：直接量「叶子顶边之上、
	//    窗口顶边之下」那段空间里，最靠近叶子的那个兄弟元素是谁、多高、什么底色、
	//    是否不透明。真机上若板在那里，这一行会自己指出来。
	if (leaf) {
		try {
			const lr = leaf.getBoundingClientRect();
			const parts: string[] = [];
			// 叶子所在 tab 组里、排在叶子容器之前的那些兄弟（真实环境就是 tab 头容器）
			const tabs = leaf.closest(".workspace-tabs");
			if (tabs) {
				for (const sib of Array.from(tabs.children)) {
					if (sib === leaf || sib.contains(leaf)) continue;
					const sr = sib.getBoundingClientRect();
					if (sr.bottom > lr.top + 0.5 || sr.height <= 0) continue;
					const scs = window.getComputedStyle(sib);
					const alpha = (() => {
						const m = /rgba?\(([^)]+)\)/.exec(scs.backgroundColor);
						if (!m) return 1;
						const p = (m[1] ?? "").split(",").map(Number);
						return p.length > 3 ? (p[3] ?? 1) : 1;
					})();
					parts.push(`${sib.tagName.toLowerCase()}.${String(sib.className).split(/\s+/).slice(0, 2).join(".")}`
						+ ` h=${n1(sr.height)} bottom=${n1(sr.bottom)} leafTop=${n1(lr.top)}`
						+ ` bg=${scs.backgroundColor}${alpha > 0 ? "（不透明，会露出来）" : ""}`
						+ ` token=${varOf(sib, "--tab-container-background")}`);
				}
			}
			facts.aboveLeaf = parts.length
				? parts.join(" ;; ")
				: `(叶子之上没有占位的兄弟元素) leafTop=${n1(lr.top)}`;
		} catch {
			facts.aboveLeaf = "(读取失败)";
		}
	} else {
		facts.aboveLeaf = "(无叶子)";
	}

	// ⑥ **死区高度**（2026-09-13 取代原先的「v3 补色层」事实）。
	//    定义：正文可用的顶边（`.unreader-body` 的顶边）比叶子顶边低多少。
	//    **页首隐藏时应为 0** —— 那一段归正文（这是「让位」设计的核心契约）；
	//    页首可见时应约等于页首高度。
	//    为什么用死区取代补色层：v3 的补色层随「让位」设计整体删掉了（它会把让出来的
	//    正文盖住），而**旧诊断一直在报「补色层高度 38px、底色正确」这类看起来正常的
	//    事实** —— 那恰恰是四轮修复都以为修好了的原因：补色层存在的意义就是让那条带
	//    「看不见」，于是「空间仍被占着」这件事在报告里**没有任何一行会变红**。
	//    死区高度是唯一能把「让位了」与「只是把带子涂成了同色」分开的量。
	if (leaf) {
		try {
			// **量的是 `.unreader-stage`**（= 阅读区那一层）而不是 `.unreader-body`：
			// 让位的落点已从 root/body 挪到 stage（root 与 body 现在纹丝不动，见 styles.css
			// v4 段），body 的顶边因此恒为「页首可见时的位置」，拿它当判据会永远报「没让位」。
			const bodyEl = leaf.querySelector<HTMLElement>(".unreader-stage");
			const lr = leaf.getBoundingClientRect();
			const bt = bodyEl ? bodyEl.getBoundingClientRect().top : NaN;
			const dz = Number.isFinite(bt) ? bt - lr.top : NaN;
			const ok = !m.hiddenByUs || Math.abs(dz) <= 1;
			facts.deadZone = `leafTop=${n2(lr.top)} 阅读区顶边=${n2(bt)} deadZone=${n2(dz)}px`
				+ (m.hiddenByUs
					? (ok ? " → 让位成立（正文顶到叶子顶边，那一段归正文）"
						: ` → **没让位**（页首已隐藏，正文顶边却低 ${n2(dz)}px）`)
					: " → 页首未隐藏，本应 ≈ 页首高度");
		} catch {
			facts.deadZone = "(读取失败)";
		}
	} else {
		facts.deadZone = "(无叶子)";
	}

	// ⑦ 进度条：**它是「几何正确却看不见」的另一个受害者，且与补偿层同根因**
	//    （页首隐藏时 top 为负 → 同样落在 .view-content 盒外）。所以除了几何与
	//    计算样式，必须给出**裁剪判定**：只看 `top=0 h=3 display=block` 会得
	//    「条好着呢」的结论，而屏幕上什么都没有。
	if (bar) {
		try {
			const r = bar.getBoundingClientRect();
			const cs = window.getComputedStyle(bar);
			facts.bar = `top=${n2(r.top)} bottom=${n2(r.bottom)} left=${n2(r.left)}`
				+ ` right=${n2(r.right)} h=${n2(r.height)}`
				+ ` display=${cs.display} vis=${cs.visibility} op=${cs.opacity}`
				+ ` bg=${cs.backgroundColor} z=${cs.zIndex} pe=${cs.pointerEvents}`;
			facts.barTopVar = varOf(bar, "--ur-progress-top");
			facts.barClip = clipChainOf(bar, leaf, r);
			// 填充段比例（--p）：0 时条上只剩 22% 半透明轨道，容易被误判成「条没画出来」
			const fill = bar.querySelector<HTMLElement>(".unreader-progress-fill");
			facts.barFill = fill
				? `p=${varOf(fill, "--p")} w=${n2(fill.getBoundingClientRect().width)} bg=${bgOf(fill)}`
				: "(无填充层)";
			facts.barOff = bar.classList.contains("is-off") ? "is-off(外观开关关闭)" : "on";
		} catch {
			facts.bar = "(读取失败)";
		}
	} else {
		facts.bar = "(不在 DOM)";
	}

	// ⑧ 主题 token：颜色类故障（条画出来了但与底色同色）只能靠它们判断。
	//    **必须在「消费点」（叶子）读，不能只在 documentElement 读** —— 本轮真机级夹具
	//    抓到过这个陷阱：夹具在 `:root` 写了 `--background-primary:#1e242e`，而主题把
	//    它定义在 `body.theme-dark` 上（`#1e1e1e`）。自定义属性是**继承**的 → 叶子
	//    解析到的是 body 那份 `#1e1e1e`，而 `documentElement` 那份是 `#1e242e`。
	//    只读 docElement 会报出一个**与实际渲染无关**的值，正是「静默误导」。
	//    两者不一致时把 docElement 的值一并标出（`(doc=..)`），这种分歧本身就是线索。
	//    注意 `--interactive-accent` 被 `color-mix(...)` 消费，值本身可能是未解析流。
	const tok = (name: string): string => {
		const consumed = varOf(leaf, name);
		const atDoc = varOf(document.documentElement, name);
		return consumed === atDoc ? `${name}=${consumed}` : `${name}=${consumed}(doc=${atDoc})`;
	};
	facts.themeTokens = [
		tok("--interactive-accent"),
		tok("--background-primary"),
		tok("--header-height"),
		tok("--view-header-height"),
		tok("--view-header-top-offset"),
		tok("--view-top-spacing"),
	].join(" ");

	facts.metrics = `rootTop=${n1(m.rootTop)} hole=${n1(m.hole)} pad=${n1(m.pad)}`
		+ ` uiInset=${n1(m.uiInset)} safeTop=${n1(m.safeTop)}`;

	return facts;
}
