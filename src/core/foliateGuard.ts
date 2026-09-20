/**
 * foliate 重复注册守卫。
 *
 * foliate 的自定义元素（foliate-view / foliate-paginator / foliate-fxl /
 * foliate-quoteimage）在其模块求值期就执行 customElements.define。Obsidian
 * disable → enable 插件时会重新求值 main.js，同一名称重复 define 直接抛
 * 「already been used with a different definition」，导致插件加载失败。
 *
 * 本模块必须在 foliate 相关模块之前被求值（engineAdapter 的首个 import），
 * 给 customElements.define 装上「已注册则跳过」的补丁：首次注册照常执行；
 * 重载后重复注册静默跳过 —— 旧注册仍可通过 document.createElement 正常
 * 使用，行为与重新注册一致。
 */
// 取原版 define：**不能**直接写 `CustomElementRegistry.prototype.define` ——
// 那是一个「脱离对象的未绑定方法引用」（上架规则 unbound-method 会报），
// 而这里恰恰要以调用方自己的 registry 作 `this`，`.bind()` 反而会绑错。
// 走属性描述符拿值，语义完全等价，也不产生方法引用。
type DefineFn = (
	this: CustomElementRegistry,
	name: string,
	ctor: CustomElementConstructor,
	options?: ElementDefinitionOptions,
) => void;
const origDefine = Object.getOwnPropertyDescriptor(CustomElementRegistry.prototype, "define")?.value as DefineFn | undefined;
CustomElementRegistry.prototype.define = function (
	this: CustomElementRegistry,
	name: string,
	ctor: CustomElementConstructor,
	options?: ElementDefinitionOptions,
): void {
	if (this.get(name)) return;
	if (!origDefine) throw new Error("[UNreader] CustomElementRegistry.define 缺失，无法注册 foliate 自定义元素");
	origDefine.call(this, name, ctor, options);
};
