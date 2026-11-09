import { isReaderChrome } from "./selectionChrome";

/** 每个阅读宿主一份。移动端优先用触摸生命周期；原生把手吞掉触摸事件时用选区变化兜底。 */
export interface MobileSelectionSnapshot {
 identity: unknown;
 version: string;
 endpoints: readonly unknown[];
 restore(): void;
 clear(): void;
 valid(): boolean;
}
interface Surface {
 doc: Document;
 body(): HTMLElement | null;
 read(): MobileSelectionSnapshot | null;
 alive?(): boolean;
 point?(x: number, y: number): { x: number; y: number };
}
interface Options {
 enabled(): boolean;
 tools(target: Node): boolean;
 ended(): void;
 refreshed?(doc: Document): void;
 onDragVisibilityChange(active: boolean): void;
}
export class MobileSelectionInteractionController {
 private snapshot: MobileSelectionSnapshot | null = null;
 private surface: Surface | null = null;
 private bindings = new Map<Document, () => void>();
 private gesture: { x: number; y: number; at: number; invalid: boolean; changed: boolean } | null = null;
 private first: { x: number; y: number; at: number } | null = null;
 private dragging = false;
 private nativeHandleTimer = 0;
 private writing = false;
 private consumeUntil = 0;
 private consumedDoc: Document | null = null;
 private consumedPoint: { x: number; y: number } | null = null;
 private touchStream = false;
 constructor(private options: Options) {}
 get enabled(): boolean { return this.options.enabled(); }
 get active(): boolean { return this.options.enabled() && this.valid(); }
 private valid(): boolean {
  if (!this.snapshot) return false;
  try {
   if (this.snapshot.valid() && this.surface?.alive?.() !== false) return true;
  } catch { /* 编辑器/iframe 已卸载。 */ }
  this.end(); return false;
 }
 private clearNativeHandleTimer(): void {
  if (this.nativeHandleTimer) window.clearTimeout(this.nativeHandleTimer);
  this.nativeHandleTimer = 0;
 }
 private setDragging(value: boolean): void {
  if (!value) this.clearNativeHandleTimer();
  if (this.dragging === value) return;
  this.dragging = value;
  this.options.onDragVisibilityChange(value);
 }
 /** 供工具动作使用；拖动期间绝不把旧 Range 写回。 */
 restore(): void {
  if (!this.valid() || this.gesture || this.dragging) return;
  this.writing = true;
  try { this.snapshot?.restore(); } finally { this.writing = false; }
 }
 prepareAction(): boolean {
  if (!this.active || this.gesture) return false;
  // 显式工具动作优先于缺失原生松手事件的短暂兜底，不让高亮命令失灵。
  this.setDragging(false);
  const doc = this.surface?.doc;
  if (!doc) return false;
  this.observe(doc);
  this.setDragging(false); this.restore();
  if (!this.active) return false;
  this.options.refreshed?.(doc);
  return true;
 }
 end(clear = false): void {
  const snapshot = this.snapshot;
  this.consumeUntil = 0; this.consumedDoc = null; this.consumedPoint = null;
  this.snapshot = null; this.surface = null; this.first = null; this.gesture = null;
  this.setDragging(false);
  if (clear && snapshot) { try { if (snapshot.valid()) snapshot.clear(); } catch { /* 已关闭的文档无需再清理。 */ } }
  if (snapshot) this.options.ended();
 }
 dispose(): void { this.end(true); for (const stop of this.bindings.values()) stop(); this.bindings.clear(); this.touchStream = false; }
 observe(doc: Document): void {
  if (!this.options.enabled() || this.writing) return;
  const surface = this.surfaces.get(doc);
  if (!surface) return;
  if (this.snapshot && !this.valid()) return;
  const next = surface.read();
  if (!next) return; // 意外塌陷保留会话，只有确认 tap 后才恢复。
  const old = this.snapshot;
  const changed = !!old && (old.identity !== next.identity || old.endpoints.length !== next.endpoints.length || old.endpoints.some((v, i) => v !== next.endpoints[i]));
  this.snapshot = next; this.surface = surface;
  if (!changed) return;
  this.first = null;
  this.setDragging(true);
  if (this.gesture) this.gesture.changed = true;
  else {
   // Android 原生选区把手可能只发 selectionchange，不向网页交付 pointer/touch。
   // 每次真实端点变化续期一次（非轮询）；有松手事件时立即清理，无事件时安静 300ms 后恢复。
   // 此路径无法知道「手指停住但仍按着」，所以不声称超时等同于真实松手。
   this.clearNativeHandleTimer();
   this.nativeHandleTimer = window.setTimeout(() => this.setDragging(false), 300);
  }

 }
 private surfaces = new Map<Document, Surface>();
 private unbind(doc: Document): void {
  if (this.surface?.doc === doc) this.end();
  this.bindings.get(doc)?.(); this.bindings.delete(doc);
 }
 bind(surface: Surface): void {
  for (const [doc, old] of this.surfaces) if (old.alive?.() === false) this.unbind(doc);
  if (this.bindings.has(surface.doc)) return;
  this.surfaces.set(surface.doc, surface);
  const { doc } = surface;
  const point = (x: number, y: number) => surface.point?.(x, y) ?? { x, y };
  const start = (x: number, y: number, count: number, target: EventTarget | null) => {
   if (!this.options.enabled()) return;
   if (!this.snapshot) this.observe(doc);
   const node = target as Node | null;
   if (!node || !this.valid()) return;
   const p = point(x, y);
   if (this.options.tools(node) || isReaderChrome(node)) { this.setDragging(false); this.first = null; this.gesture = null; this.consumeUntil = 0; return; }
   if (!surface.body()?.contains(node)) { this.end(); return; }
   this.clearNativeHandleTimer();
   this.gesture = { ...p, at: performance.now(), invalid: count !== 1, changed: false };
   this.setDragging(true);
   if (count !== 1) this.first = null;
  };
  const move = (x: number, y: number, count: number) => {
   if (!this.gesture) return;
   const p = point(x, y);
   if (count !== 1 || Math.hypot(p.x - this.gesture.x, p.y - this.gesture.y) > 12) {
    this.gesture.invalid = true; this.first = null; this.setDragging(true);
   }
  };
  const release = (cancel: boolean) => {
   const g = this.gesture; this.gesture = null;
   this.setDragging(false);
   if (!this.options.enabled()) return;
   if (cancel) {
    this.first = null;
    return;
   }
   if (!g) return;
   const now = performance.now();
   if (cancel || g.invalid || g.changed || now - g.at > 300 || !this.valid()) {
    this.first = null;
    // 已确认松手、期间端点未改变时，滚动造成的临时塌陷也不应丢掉原选区。
    if (g.invalid && !g.changed) this.restore();
    return;
   }
   // 先在 capture 消费随后的 click，早于引擎的链接/标注/翻页处理。
   this.consumeUntil = now + 700; this.consumedDoc = doc; this.consumedPoint = { x: g.x, y: g.y };
   if (this.first && now - this.first.at <= 800 && Math.hypot(g.x - this.first.x, g.y - this.first.y) <= 32) {
    this.end(true);
    this.consumeUntil = now + 700; this.consumedDoc = doc; this.consumedPoint = { x: g.x, y: g.y };
   } else { this.first = { x: g.x, y: g.y, at: now }; this.restore(); }
  };
  const pd = (e: PointerEvent) => {
   if (e.pointerType === 'mouse') { this.consumeUntil = 0; this.first = null; return; }
   if (e.pointerType !== 'touch' || this.touchStream) return;
   start(e.clientX, e.clientY, e.isPrimary ? 1 : 2, e.target);
  };
  const pm = (e: PointerEvent) => { if (e.pointerType === 'touch' && !this.touchStream) move(e.clientX, e.clientY, e.isPrimary ? 1 : 2); };
  const pu = (e: PointerEvent) => { if (e.pointerType === 'touch' && !this.touchStream) release(e.type === 'pointercancel'); };
  const ts = (e: TouchEvent) => { this.touchStream = true; const t = e.touches[0]; if (t) start(t.clientX, t.clientY, e.touches.length, e.target); };
  const tm = (e: TouchEvent) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY, e.touches.length); };
  const te = (e: TouchEvent) => { if (e.touches.length) { if (this.gesture) this.gesture.invalid = true; return; } release(e.type === 'touchcancel'); this.touchStream = false; };
  const click = (e: MouseEvent) => {
   const pointerType = (e as PointerEvent).pointerType;
   const capabilities = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities;
   // Safari 的触摸兼容 click 可能只有 MouseEvent，没有 sourceCapabilities。
   // 只有此前确实完成了本会话的触摸、且坐标与时间吻合，才消费这类 click。
   const touch = pointerType === 'touch' || capabilities?.firesTouchEvents
    || (!pointerType && capabilities == null && e.detail > 0);
   const p = point(e.clientX, e.clientY);
   if (touch && this.options.enabled() && doc === this.consumedDoc && this.consumedPoint && Math.hypot(p.x - this.consumedPoint.x, p.y - this.consumedPoint.y) <= 12 && performance.now() <= this.consumeUntil && !this.options.tools(e.target as Node)) {
    this.consumeUntil = 0; e.preventDefault(); e.stopImmediatePropagation(); this.restore();
   }
  };
  const change = () => this.observe(doc);
  const unload = () => this.unbind(doc);
  const scroll = () => { this.first = null; if (this.gesture) this.gesture.invalid = true; };
  const focus = (e: FocusEvent) => {
   const el = e.target as Element | null;
   if (this.active && el?.matches('input, textarea, [contenteditable="true"]') && !surface.body()?.contains(el) && !this.options.tools(el)) this.end();
  };
  const hidden = () => { if (doc.visibilityState === 'hidden') this.end(); };
  const handlers: [string, EventListener][] = [['pointerdown', pd as EventListener], ['pointermove', pm as EventListener], ['pointerup', pu as EventListener], ['pointercancel', pu as EventListener], ['touchstart', ts as EventListener], ['touchmove', tm as EventListener], ['touchend', te as EventListener], ['touchcancel', te as EventListener], ['click', click as EventListener], ['selectionchange', change], ['scroll', scroll], ['focusin', focus as EventListener], ['visibilitychange', hidden]];
  for (const [type, fn] of handlers) doc.addEventListener(type, fn, { capture: true, passive: type !== 'click' });
  const win = doc.defaultView;
  win?.addEventListener('pagehide', unload);
  win?.addEventListener('pointerup', pu, true);
  win?.addEventListener('pointercancel', pu, true);
  win?.addEventListener('touchend', te, true);
  win?.addEventListener('touchcancel', te, true);
  this.bindings.set(doc, () => {
   win?.removeEventListener('pagehide', unload);
   win?.removeEventListener('pointerup', pu, true); win?.removeEventListener('pointercancel', pu, true);
   win?.removeEventListener('touchend', te, true); win?.removeEventListener('touchcancel', te, true);
   for (const [type, fn] of handlers) doc.removeEventListener(type, fn, true); this.surfaces.delete(doc); });
 }
}

/** DOM 快照只认「节点身份 + 选区自身的文本指纹」，不再扫整篇正文。
 *
 *  旧实现把整篇 `body.textContent` 当版本号：`observe()` 每记 selectionchange 建一次
 *  快照、`valid()` 每次判断又读一遍全文并比较。长文里这是 O(正文长度) × 高频事件，
 *  主线程被反复拖住（真机表现为选区卡顿、工具条点了没反应）；而且正文里任何一处
 *  **无关**改动都会让整份快照失效，反而把「误触后本该保留的选区」提前收掉。
 *
 *  现在只比对**选中区间**内的文本（O(选区长度)）与端点节点的连接状态：
 *  · 端点节点被重渲染摘掉 / iframe 卸载 → contains 失败；
 *  · 选中区间内被编辑（含 CM 就地改文本）→ range.toString() 变化；
 *  · 正文别处变化 → 端点与选中文本都没变，恢复原 Range 仍然精确且安全。
 *  节点身份仍由 `endpoints` 与 `identity` 逐对象比较，绝不靠「文字相同」反推位置。 */
export function domSelectionSnapshot(doc: Document, body: HTMLElement): MobileSelectionSnapshot | null {
 const sel = doc.getSelection();
 if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
 const range = sel.getRangeAt(0).cloneRange();
 if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
 const version = range.toString();
 const start = range.startContainer, end = range.endContainer;
 const valid = () => body.isConnected && body.contains(start) && body.contains(end) && range.toString() === version;
 return {
  identity: body, version, endpoints: [start, range.startOffset, end, range.endOffset], valid,
  restore: () => { if (valid()) {
   if (sel.rangeCount) { const current = sel.getRangeAt(0); if (current.startContainer === start && current.startOffset === range.startOffset && current.endContainer === end && current.endOffset === range.endOffset) return; }
   sel.removeAllRanges(); sel.addRange(range.cloneRange());
  } },
  clear: () => { if (sel.anchorNode && body.contains(sel.anchorNode)) sel.removeAllRanges(); },

 };
}
