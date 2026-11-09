/** 两种阅读宿主共用的临时遮挡层；不改原有显隐、钉住、面板或原生导航状态。 */
const SELECTION_DRAG_HIDE_SELECTOR = [
 ".unreader-actions", ".unreader-selection-toolbar",
 ".unreader-nav-nodes", ".unreader-nav-panel", ".unreader-nav-bridge", ".unreader-toc-panel",
].join(",");

// 面板触摸仍应让行，但面板本身不属于本次临时隐藏范围。
export const READER_CHROME_SELECTOR = [
 ".unreader-actions", ".unreader-nav-nodes", ".unreader-nav-panel", ".unreader-nav-bridge",
 ".unreader-back-btn", ".unreader-immersion-switch", ".unreader-progress",
 ".unreader-toc-panel", ".unreader-anno-panel", ".unreader-search", ".unreader-appearance-panel",
 ".unreader-selection-toolbar", ".unreader-highlight-popover", ".unreader-translate-card",
 ".unreader-ai-panel", ".unreader-bookmark-inline", ".unreader-chapter-hint",
 ".unreader-podcast-bar", ".unreader-footnote-bubble", ".unreader-footnote-backdrop", ".unreader-version-bar",
].join(",");

export function isReaderChrome(node: Node): boolean {
 const el = node.nodeType === 1 ? node as Element : node.parentElement;
 return !!el?.closest(READER_CHROME_SELECTOR);
}

export function setSelectionChromeHidden(root: HTMLElement | null, hidden: boolean): void {
 if (!root) return;
 // 标记控件而不移动/重建它们，CSS 共用这一份清单；后续手势可纳入新建的控件。
 if (hidden) for (const el of root.querySelectorAll(SELECTION_DRAG_HIDE_SELECTOR)) {
  el.setAttribute("data-ur-selection-chrome", "");
 }
 root.classList.toggle("is-selection-dragging", hidden);
}
