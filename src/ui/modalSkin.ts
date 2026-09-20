import { Modal } from "obsidian";
import type { App } from "obsidian";

/** 本插件的弹窗类都挂这个类（由 `UnreaderModal` 在**构造时**加到官方 `.modal` 元素上）。 */
export const UNREADER_MODAL_CLASS = "unreader-modal";

/** UN 系列设计同步（2026-09-20）：本插件自己的弹窗统一皮肤。
 *
 *  为什么用基类而不是「每个弹窗自己 `modalEl.addClass(...)`」：新弹窗漏写一行就会退回
 *  原生皮肤，而这类漏写没人会在评审里看见（它不报错、只是变丑）。收成一个基类之后，
 *  「是不是本插件的弹窗」这件事在类型上就是确定的。
 *
 *  ⚠️ 加类的时机必须是**构造期**：Obsidian 的 `Modal` 构造函数里就把 DOM 建好了
 *  （app.js：`this.containerEl = createDiv("modal-container")` → `this.modalEl =
 *  this.containerEl.createDiv("modal")`），所以在构造期加类不会先渲染一帧原生皮肤。
 *  样式侧只写 `.unreader-modal`（我们自己的容器类），**不许**改写官方 `.modal` ——
 *  那会连带改掉官方与用户其余插件的所有弹窗（口径见 styles.css 第 7 节）。 */
export class UnreaderModal extends Modal {
	constructor(app: App) {
		super(app);
		this.modalEl.addClass(UNREADER_MODAL_CLASS);
	}
}
