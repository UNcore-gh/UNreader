/** 沉浸模式对 Obsidian **原生界面**的接管判据 —— 纯函数，不碰 DOM，可单测。
 *
 *  ## 为什么单开一个模块
 *
 *  真机上「沉浸时到底该藏哪些东西」有两个相反的失败方向：
 *  · **该藏不藏** —— 页首藏了、底栏还在（用户报障的原始形态：「移动端全屏模式下，
 *    底下元素不隐藏，但是页首元素隐藏」）；
 *  · **无谓地藏** —— 用户只想要干净的正文，结果 Obsidian 的页首/底栏被一起收走。
 *
 *  判据写成 readerView 的内联表达式时，两者都只能靠真机试；抽成纯函数后
 *  `npm run test:immersive-adapt` 能把整张真值表连**阴性对照**一起钉住。
 *
 *  ## 与官方机制的关系（obsidian.asar 实测）
 *
 *  · **页首**：官方规则 `.is-phone.is-hidden-nav .view-header`（按「手机」门控）。
 *    本插件**不借**官方这条 —— 页首是本视图自己的 UI，给它挂自己的
 *    `unreader-header-hidden` 类，故**三端通用**（桌面 / 平板也要能藏）。
 *  · **底栏**：官方规则 `.is-hidden-nav .mobile-navbar`（**无平台前缀**；另有一条
 *    `body.is-tablet .mobile-navbar { display: none }` —— 平板压根没有底栏）。
 *    该类是 **app 级**（挂 `document.body`），**失活视图写它会污染下一个视图**。
 *  · **官方「全屏」(`autoFullScreen`)**：官方自己在 markdown 视图上滚动显隐原生界面
 *    用的开关，与本插件无关 —— 这里**刻意不看它**（历史版本拿它当底栏的门，
 *    结果官方设置与本机平台形态一漂移就只剩半边生效，见 AGENTS.md）。
 */

/** 沉浸态的四条输入事实。每条都**只**由 readerView 现读（唯一来源），
 *  守卫与同步不许各自再算一套。 */
export interface ImmersiveNativeInputs {
	/** 外观「沉浸模式适配」（`appearance.immersiveAdapt`）——用户的总开关：
	 *  开 = 连 Obsidian 原生界面一起收；关 = 只收本插件自己的悬浮 UI。 */
	readonly adapt: boolean;
	/** 沉浸态：`.unreader-root` 上的 `chrome-hidden`（滚动下滑藏、点按唤出）。 */
	readonly chromeHidden: boolean;
	/** 本机是**手机形态**（官方 `body.is-phone`，真机制判据）——官方底栏与
	 *  系统状态栏只在这种形态下存在；平板（`is-tablet`）与桌面都没有。 */
	readonly phoneLike: boolean;
	/** 本视图是活动视图 —— app 级类只允许活动视图写（否则污染下一个视图）。 */
	readonly selfActive: boolean;
}

/** 页首是否由本插件隐藏。**三端通用**：它是本视图自己的元素，与平台无关。 */
export function headerHiddenByUs(i: ImmersiveNativeInputs): boolean {
	return i.adapt === true && i.chromeHidden === true;
}

/** 底栏（手机端另含系统状态栏）是否该由本插件收起。
 *
 *  判据链：
 *   · 先要满足「页首也藏」（见下）；
 *   · **手机形态**：平板没有底栏，系统时间也该保留；
 *   · **自活**：app 级类不得由失活视图写。
 *
 *  ⚠️ **不变量：`bottomBarHiddenByUs(i) → headerHiddenByUs(i)`** —— 底栏与页首同属
 *  「沉浸时把原生界面收走」这一件事（官方两条 CSS 同吃 `is-hidden-nav`，做不到
 *  「只藏底栏不藏页首」）。两者必须同进同退，这正是用户要的
 *  「不打开这个开关都不隐藏，打开了这个开关都隐藏」。
 *  `test:immersive-adapt` 对全部 16 种组合断言这条蕴含关系。 */
export function bottomBarHiddenByUs(i: ImmersiveNativeInputs): boolean {
	return headerHiddenByUs(i) && i.phoneLike === true && i.selfActive === true;
}
