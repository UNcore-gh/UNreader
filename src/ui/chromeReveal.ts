/** 沉浸态「亮出 chrome」的最小策略 —— 从 readerView 抽出来，与视图实例解耦，
 *  以便回归夹具能**直打产品代码**（而不是在夹具里重演一遍类切换）。
 *
 *  为什么这件事值得一个模块：目录面板（`.unreader-nav-panel`）在右缘锚点下挂进
 *  `.unreader-nav-nodes`，而沉浸态给该容器写了 `opacity:0 !important` 与
 *  `pointer-events:none !important`，并且**专门为面板另补了一条显式
 *  `pointer-events:none`** —— 因为 `pointer-events` 是**可继承属性**，「父级 none
 *  不继承阻断」这个直觉是错的：子元素只要自己写 `auto` 就能重新被命中，所以光靠
 *  父级那条规则拦不住面板（见 src/styles.css 的「隐形区域吞点按」段）。
 *
 *  结论：沉浸态下「面板 open 了」与「面板可见可点」是**两件事**。任何只把面板
 *  置为打开的路径，净效果都是零 —— 用户报的「命令执行了但没效果」正是这一条
 *  （命令是在 chrome 已收起时被调用的；工具栏按钮则天然不会，因为要够到按钮，
 *  chrome 必然已经亮着）。
 *
 *  ⚠️ 不要在这里顺手切别的 chrome 类：本函数只做「脱离隐藏态」这一件事，
 *  「收起」由 handleScrollActivity / handleTapZone 各自负责（它们各有语义）。 */

/** 亮出 chrome：移除 `chrome-hidden`、加上 `chrome-revealed`。
 *
 *  @returns 是否真的发生了翻转。原本就不在隐藏态时返回 `false` —— 调用方据此跳过
 *           随后的原生导航同步（`syncNativeNav` 会读几何、写类），避免在热路径上
 *           做无谓的重排；也让「本次命令到底有没有改变 chrome」在诊断里可判定。 */
export function revealChromeClasses(root: HTMLElement | null | undefined): boolean {
	if (!root || !root.hasClass("chrome-hidden")) return false;
	root.addClass("chrome-revealed");
	root.removeClass("chrome-hidden");
	return true;
}
