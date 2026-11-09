import { hasCoreModal } from "../core/modalFocusGate";

interface ActivePanel {
 element: HTMLElement;
 close: () => void;
 detach: () => void;
}
const activePanels = new WeakMap<HTMLElement, ActivePanel>();
function scopeOf(element: HTMLElement): HTMLElement {
 return element.closest<HTMLElement>(".unreader-root, .unreader-md-root") ?? element.ownerDocument.body;
}

/** 同一个阅读界面只保留一个操作浮窗；刷新同一面板不会把它关掉。 */
export function openFloatingPanel(element: HTMLElement, close: () => void): void {
 element.classList.add("unreader-floating-panel");
 const scope = scopeOf(element);
 const previous = activePanels.get(scope);
 if (previous?.element === element) return;
 const doc = element.ownerDocument;
 const onKey = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.defaultPrevented || hasCoreModal(doc)) return;
  const target = event.target as Node | null;
  if (!target || !scope.contains(target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
 };
 const onPointerDown = (event: PointerEvent) => {
  const target = event.target as HTMLElement | null;
  if (!target?.nodeType || element.contains(target)) return;
  // 工具栏按钮由各自 click 决定切换；子级原生菜单/模态框属于当前操作。
  if (target.closest?.(".unreader-actions, .unreader-selection-toolbar, .modal-container, .menu")) return;
  close();
 };
 const next = { element, close, detach: () => {
  doc.removeEventListener("keydown", onKey, true);
  doc.removeEventListener("pointerdown", onPointerDown, true);
 } };
 // 先登记新窗口，旧窗口的关闭回调就不会误删新窗口。
 activePanels.set(scope, next);
 previous?.detach();
 previous?.close();
 doc.addEventListener("keydown", onKey, true);
 doc.addEventListener("pointerdown", onPointerDown, true);
}

export function closeFloatingPanel(element: HTMLElement): void {
 const scope = scopeOf(element);
 const active = activePanels.get(scope);
 if (active?.element !== element) return;
 active.detach();
 activePanels.delete(scope);
}

/** 换内容、离开标签页时收起当下的临时操作面板。 */
export function dismissFloatingPanel(scope: HTMLElement): void {
 activePanels.get(scopeOf(scope))?.close();
}
