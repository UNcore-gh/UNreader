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
const origDefine = CustomElementRegistry.prototype.define;
CustomElementRegistry.prototype.define = function (
	this: CustomElementRegistry,
	name: string,
	ctor: CustomElementConstructor,
	options?: ElementDefinitionOptions,
): void {
	if (this.get(name)) return;
	origDefine.call(this, name, ctor, options);
};
