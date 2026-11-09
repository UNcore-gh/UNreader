/** 浮动面板的几何总线。
 *
 *  `ResizeObserver` 只能感知**尺寸**变化：侧栏拖宽、功能轨被平移这类「锚点纯位移」
 *  里，锚点与 root 的宽高可能一点没变，观察器整段拖拽都不会响 —— 这正是一排面板
 *  停在旧落点、与工具栏脱节的原因。由**产生几何变化的那一方**发一次信号，所有在
 *  开的面板在同一帧（各自 rAF 合帧）里重排，既连续又不用轮询。 */
const geometryListeners = new Set<() => void>();

/** 侧栏宽度 / 轨道位置 / 窗口几何发生变化时广播一次。 */
export function notifyPopoverGeometryChanged(): void {
 for (const listener of geometryListeners) listener();
}

/** 订阅几何变化；返回退订函数（面板关闭时必须调用，避免闭包滞留）。 */
export function subscribePopoverGeometry(listener: () => void): () => void {
 geometryListeners.add(listener);
 return () => { geometryListeners.delete(listener); };
}

/** 从锚点起步，优先消耗较宽裕一侧；剩余空间相等后再向两侧展开。 */
export function growingInterval(anchor: number, top: number, bottom: number, requested: number) {
 const y = Math.max(top, Math.min(anchor, bottom));
 const height = Math.max(0, Math.min(requested, bottom - top));
 const above = y - top, below = bottom - y;
 const imbalance = Math.abs(below - above);
 const shared = Math.max(0, height - imbalance) / 2;
 const up = above > below ? Math.min(height, imbalance) + shared : shared;
 return { top: y - up, height };
}

export interface PopoverOptions {
 toolbar?: HTMLElement;
 rowSelector?: string;
 content?: boolean;
 minWidth?: number;
}

/** 交给浏览器解析 min()/calc()/vh，不能对 CSS 表达式直接 parseFloat。 */
function resolveHeight(panel: HTMLElement, expression: string): number {
 if (!expression || expression === 'none') return Infinity;
 const probe = panel.ownerDocument.createElement('div');
 probe.classList.add('unreader-popover-measure');
 probe.style.height = expression;
 panel.parentElement!.appendChild(probe);
 const height = parseFloat(panel.ownerDocument.defaultView!.getComputedStyle(probe).height);
 probe.remove();
 return height;
}

/** 测量期间需要临时覆盖约束；测试环境可能没有 Obsidian 的 DOM 扩展。 */
function setMeasuredStyle(panel: HTMLElement, property: string, value: string): void {
 if (typeof panel.setCssProps === 'function') panel.setCssProps({ [property]: value });
 else panel.style.setProperty(property, value);
}

/** 全部几何先在视口坐标中计算，最后一次性换算到定位祖先的 padding 坐标。 */
export function placeGrowingPopover(panel: HTMLElement, anchor: HTMLElement, cap?: number, animate = false, opts: PopoverOptions = {}): void {
 const win = panel.ownerDocument.defaultView!;
 const root = panel.closest<HTMLElement>('.unreader-root, .unreader-md-root, .unreader-body') ?? panel.ownerDocument.documentElement;
 // 手机内容面板保持现有 sheet 布局；从桌面模式切换过来也清除内联几何。
 if (opts.content && panel.ownerDocument.body.classList.contains('is-phone')) {
  resetPopoverPlacement(panel);
  return;
 }
 const savedScroll = panel.scrollTop;
 panel.scrollTop = 0;
 const innerScroll = Array.from(panel.querySelectorAll<HTMLElement>('*')).filter(el => el.scrollTop > 0)
  .map(el => ({ el, top: el.scrollTop }));
 panel.style.removeProperty('max-height');
 panel.style.removeProperty('width');
 panel.style.removeProperty('max-width');
 panel.style.removeProperty('min-width');
 panel.style.removeProperty('left');
 panel.style.removeProperty('right');
 const css = win.getComputedStyle(panel);
 const limit = Math.min(cap ?? Infinity, resolveHeight(panel, css.maxHeight));
 const preferredWidth = panel.getBoundingClientRect().width;
 panel.classList.add('is-growing-popover');
 // 测量前暂时解除原有尺寸限制，定位完成后再写入实测值。
 setMeasuredStyle(panel, 'max-height', 'none');
 const rect = root.getBoundingClientRect();
 const viewport = win.visualViewport;
 const rootStyle = win.getComputedStyle(root);
 const rootScale = root.offsetHeight ? rect.height / root.offsetHeight : 1;
 const inset = (name: string) => Math.max(0, parseFloat(rootStyle.getPropertyValue(name)) || 0) * rootScale;
 const top = Math.max(rect.top + inset('--ur-top-inset'), viewport?.offsetTop ?? 0) + 8;
 const bottom = Math.max(top, Math.min(rect.bottom - Math.max(inset('--ur-bottom-inset'), inset('--ur-kb-inset')), (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight)) - 8);
 const leftBound = Math.max(rect.left, viewport?.offsetLeft ?? 0) + 8;
 const rightBound = Math.min(rect.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? win.innerWidth)) - 8;
 const ar = anchor.getBoundingClientRect();
 const rail = opts.toolbar ?? anchor.closest<HTMLElement>('.unreader-actions') ?? anchor.closest<HTMLElement>('.unreader-selection-toolbar') ?? anchor;
 const rr = rail.getBoundingClientRect();
 const parent = panel.offsetParent as HTMLElement | null;
 const pr = parent?.getBoundingClientRect();
 const sx = parent?.offsetWidth ? pr!.width / parent.offsetWidth : 1;
 const sy = parent?.offsetHeight ? pr!.height / parent.offsetHeight : 1;
 const minWidth = (opts.minWidth ?? (opts.content ? 240 : 140)) * sx;
 const rightSpace = Math.max(0, rightBound - rr.right);
 const leftSpace = Math.max(0, rr.left - leftBound);
 const onRight = rightSpace >= Math.min(minWidth, preferredWidth) || rightSpace >= leftSpace;
 const space = onRight ? rightSpace : leftSpace;
 const width = Math.max(0, Math.min(preferredWidth, space >= Math.min(minWidth, preferredWidth) ? space : rightBound - leftBound));
 setMeasuredStyle(panel, 'min-width', '0');
 setMeasuredStyle(panel, 'max-width', 'none');
 panel.style.width = `${width / sx}px`;
 const left = Math.max(leftBound, Math.min(onRight ? rr.right : rr.left - width, rightBound - width));
 const naturalHeight = panel.getBoundingClientRect().height;
 const height = Math.max(0, Math.min(naturalHeight, limit * sy, bottom - top));
 const y = Math.max(top, Math.min(ar.top + ar.height / 2, bottom));
 const row = panel.querySelector<HTMLElement>(opts.rowSelector ?? '.unreader-nav-row, .unreader-selbar-ai-item');
 const measured = panel.getBoundingClientRect();
 // 初始矩形包括首项上下的 padding/边框，让单条内容的中心精确落在按钮中心。
 const rowRect = row?.getBoundingClientRect();
 const offset = rowRect ? rowRect.top - measured.top + rowRect.height / 2 : Math.min(height, ar.height) / 2;

 // 列表的初始高度由首项、面板上下内边距和边框组成，与总条目数量无关。
 const ps = win.getComputedStyle(panel);
 const seed = rowRect ? Math.min(height, offset + rowRect.height / 2 + (parseFloat(ps.paddingBottom) + parseFloat(ps.borderBottomWidth)) * sy) : Math.min(height, ar.height);
 const seedTop = Math.max(top, Math.min(y - offset, bottom - seed));
 const extra = growingInterval(seedTop, top, bottom - seed, height - seed);
 const interval = { top: extra.top, height };
 panel.style.maxHeight = `${height / sy}px`;
 panel.style.left = `${(left - (pr?.left ?? 0)) / sx + (parent?.scrollLeft ?? 0) - (parent?.clientLeft ?? 0)}px`;
 panel.style.top = `${(interval.top - (pr?.top ?? 0)) / sy + (parent?.scrollTop ?? 0) - (parent?.clientTop ?? 0)}px`;
 setMeasuredStyle(panel, 'bottom', 'auto');
 setMeasuredStyle(panel, 'right', 'auto');
 panel.scrollTop = savedScroll;
 innerScroll.forEach(({ el, top }) => { el.scrollTop = top; });
 if (animate && win.matchMedia('(hover: hover)').matches && !win.matchMedia('(prefers-reduced-motion: reduce)').matches && panel.animate) {
  panel.getAnimations().forEach(animation => animation.cancel());
  const inset = Math.max(0, (seedTop - interval.top) / sy);
  panel.animate([{ clipPath: `inset(${inset}px 0 ${Math.max(0, (height - seed) / sy - inset)}px 0)` }, { clipPath: 'inset(0)' }], { duration: 140, easing: 'linear' });
 }
}

export function resetPopoverPlacement(panel: HTMLElement): void {
 panel.classList.remove('is-growing-popover');
 for (const property of ['top', 'left', 'right', 'bottom', 'width', 'max-width', 'min-width', 'max-height']) panel.style.removeProperty(property);
}

const contentWatchers = new WeakMap<HTMLElement, () => void>();
/** 内容面板与列表共享定位；收起/卸载时由面板唯一 close 入口释放。 */
export function alignContentPopover(panel: HTMLElement, anchor: HTMLElement, toolbar: HTMLElement): void {
 const update = () => placeGrowingPopover(panel, anchor, undefined, false, { toolbar, content: true });
 update();
 if (!contentWatchers.has(panel)) contentWatchers.set(panel, watchGrowingPopover(panel, anchor, update));
}
export function stopContentPopover(panel: HTMLElement): void {
 contentWatchers.get(panel)?.();
 contentWatchers.delete(panel);
 resetPopoverPlacement(panel);
}

/** 面板开启期间跟随窗口、祖先滚动、项目数量变化和**侧栏拖宽**；关闭时完整解绑。 */
export function watchGrowingPopover(panel: HTMLElement, anchor: HTMLElement, update: () => void): () => void {
 const win = panel.ownerDocument.defaultView!;
 let frame = 0;
 const schedule = () => { if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; if (panel.isConnected) update(); }); };
 const observer = new win.ResizeObserver(schedule);
 observer.observe(panel); observer.observe(anchor);
 const rail = anchor.closest<HTMLElement>('.unreader-actions') ?? anchor.closest<HTMLElement>('.unreader-selection-toolbar');
 if (rail) observer.observe(rail);
 const root = panel.closest('.unreader-root, .unreader-md-root');
 if (root) observer.observe(root);
 // 抽屉拖宽时 root / anchor 的宽高都不变，只有抽屉自己在变 —— 补观察它，
 // 让「拖拽过程中」的每一帧都有一记合帧后的重排信号（不依赖松手回调）。
 const anno = root?.querySelector('.unreader-anno-panel');
 if (anno) observer.observe(anno);
 // 其余纯位移（轨道 transform 过渡、开合、宿主主动同步）走统一总线。
 const stopGeometry = subscribePopoverGeometry(schedule);
 const mutations = new win.MutationObserver(schedule);
 mutations.observe(panel, { childList: true, subtree: true, characterData: true });
 const rootObserver = new win.MutationObserver(schedule);
 if (root) rootObserver.observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
 if (rail && rail !== root) rootObserver.observe(rail, { attributes: true, attributeFilter: ['style', 'class'] });
 const bodyObserver = new win.MutationObserver(schedule);
 bodyObserver.observe(panel.ownerDocument.body, { attributes: true, attributeFilter: ['class', 'style'] });
 win.addEventListener('resize', schedule);
 win.visualViewport?.addEventListener('resize', schedule);
 win.visualViewport?.addEventListener('scroll', schedule);
 panel.ownerDocument.addEventListener('css-change', schedule);
 let motionFrame = 0;
 const moving = new Map<EventTarget, Set<string>>();
 const follow = () => { schedule(); motionFrame = moving.size ? win.requestAnimationFrame(follow) : 0; };
 const transitionStart = (event: Event) => {
  if (event.target === panel) return;
  const properties = moving.get(event.target!) ?? new Set<string>();
  properties.add((event as TransitionEvent).propertyName);
  moving.set(event.target!, properties);
  if (!motionFrame) follow();
 };
 const transitionEnd = (event: Event) => {
  const properties = moving.get(event.target!);
  properties?.delete((event as TransitionEvent).propertyName);
  if (!properties?.size) moving.delete(event.target!);
  schedule();
 };
 root?.addEventListener('transitionend', transitionEnd);
 root?.addEventListener('transitioncancel', transitionEnd);
 root?.addEventListener('transitionrun', transitionStart);
 // 面板内部滚动不移动锚点；测量时恢复 scrollTop 也不能反过来触发重排循环。
 const onScroll = (event: Event) => {
  const target = event.target as Node | null;
  if (target && (target === panel || panel.contains(target))) return;
  schedule();
 };
 panel.ownerDocument.addEventListener('scroll', onScroll, true);
 return () => {
  stopGeometry();
  mutations.disconnect(); bodyObserver.disconnect(); rootObserver.disconnect();
  win.cancelAnimationFrame(motionFrame);
  root?.removeEventListener('transitionend', transitionEnd);
  root?.removeEventListener('transitioncancel', transitionEnd);
  root?.removeEventListener('transitionrun', transitionStart);
  panel.ownerDocument.removeEventListener('css-change', schedule);
  win.visualViewport?.removeEventListener('scroll', schedule);
  observer.disconnect(); win.cancelAnimationFrame(frame);
  win.removeEventListener('resize', schedule);
  win.visualViewport?.removeEventListener('resize', schedule);
  panel.ownerDocument.removeEventListener('scroll', onScroll, true);
 };
}
