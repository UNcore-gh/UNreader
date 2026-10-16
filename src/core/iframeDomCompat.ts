/**
 * Obsidian installs DOM sugar (`.instanceOf`, `.hasClass`, `.win`, ...) on the
 * top-level window's prototypes from `enhance.js`.
 *
 * A same-origin iframe has its own realm and does not receive those patches.
 * `Modal.open()` deliberately descends from a focused `<iframe>` into
 * `iframe.contentDocument.activeElement`, so `Modal.close()` can later call
 * `focusEl.instanceOf(...)`, `focusEl.hasClass(...)` and `focusEl.win` on a
 * node from the iframe realm.
 *
 * When that happens in `SuggestModal.selectSuggestion()`, the restore path
 * throws before `onChooseSuggestion()` runs: the palette closes, but the
 * selected command is never executed. The next attempt works because focus is
 * then back in the host document.
 *
 * Keep this shim local to reader frames. It implements only the small surface
 * used by Obsidian's modal restore path.
 */
export const OBSIDIAN_IFRAME_DOM_COMPAT_JS = `(function(){
var w=window;
var N=w.Node&&w.Node.prototype;
function localCtor(C){
  if(!C)return null;
  var name=C.name;
  if(!name)return null;
  try{return w[name]||null}catch(e){return null}
}
if(N&&typeof N.instanceOf!=="function"){
  N.instanceOf=function(C){
    try{if(this instanceof C)return true}catch(e){}
    var Local=localCtor(C);
    try{return !!(Local&&this instanceof Local)}catch(e){return false}
  };
}
if(N&&!Object.prototype.hasOwnProperty.call(N,"win")){
  try{Object.defineProperty(N,"win",{configurable:true,get:function(){
    return (this.ownerDocument&&this.ownerDocument.defaultView)||w
  }})}catch(e){}
}
if(N&&!Object.prototype.hasOwnProperty.call(N,"doc")){
  try{Object.defineProperty(N,"doc",{configurable:true,get:function(){
    return this.ownerDocument||w.document
  }})}catch(e){}
}
var E=w.Element&&w.Element.prototype;
if(E&&typeof E.hasClass!=="function"){
  E.hasClass=function(c){return this.classList.contains(c)};
}
})();`;
