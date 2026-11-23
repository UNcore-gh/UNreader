// Canonical copy: UNmemos-src/src/shared/referencePreview.ts.
// Mirror this module into UNagent and UNreader so each plugin builds independently.
import { Platform } from 'obsidian';

export function hasPreviewModifier(event: MouseEvent | KeyboardEvent): boolean {
 return Platform.isMacOS ? event.metaKey : event.ctrlKey;
}

/** Retain the current pointer so pressing the modifier after hovering also works. */
export function bindReferenceHover(
 root: HTMLElement | Document,
 preview: (pointer: MouseEvent, modified: boolean, trigger: MouseEvent | KeyboardEvent) => void,
 options: { trackMovement?: boolean; onDeactivate?: () => void } = {},
): () => void {
 const doc = root.ownerDocument ?? root;
 const win = doc.defaultView;
 const hostDoc = win?.frameElement?.ownerDocument;
 let pointer: MouseEvent | null = null;
 let modified = false;
 const update = (event: MouseEvent) => {
  if (!pointer) {
   doc.addEventListener('keydown', keyDown, true);
   doc.addEventListener('keyup', keyUp, true);
   hostDoc?.addEventListener('keydown', keyDown, true);
   hostDoc?.addEventListener('keyup', keyUp, true);
   hostDoc?.addEventListener('mouseover', clear, true);
   if (root !== doc) doc.addEventListener('mouseover', outside, true);
   win?.addEventListener?.('blur', clear);
  }
  const previous = modified;
  modified = hasPreviewModifier(event);
  pointer = event;
  if (previous && !modified) options.onDeactivate?.();
  if (options.trackMovement || event.type === 'mouseover' || modified !== previous) {
   preview(event, modified, event);
  }
 };
 const clear = () => {
  pointer = null;
  modified = false;
  options.onDeactivate?.();
  doc.removeEventListener('keydown', keyDown, true);
  doc.removeEventListener('keyup', keyUp, true);
  hostDoc?.removeEventListener('keydown', keyDown, true);
  hostDoc?.removeEventListener('keyup', keyUp, true);
  hostDoc?.removeEventListener('mouseover', clear, true);
  doc.removeEventListener('mouseover', outside, true);
  win?.removeEventListener?.('blur', clear);
 };
 const outside = (event: MouseEvent) => {
  const target = event.target as Node | null;
  if (!target?.nodeType || !root.contains(target)) clear();
 };
 const out = (event: MouseEvent) => {
  const next = event.relatedTarget as Node | null;
  if (!next?.nodeType || !root.contains(next)) clear();
 };
 const keyDown = (event: KeyboardEvent) => {
  if (!pointer || !(pointer.target as Node | null)?.isConnected || (hostDoc && !win?.frameElement?.isConnected)) {
   clear();
   return;
  }
  if (event.key !== (Platform.isMacOS ? 'Meta' : 'Control') || event.repeat || !hasPreviewModifier(event)) return;
  modified = true;
  preview(pointer, true, event);
 };
 const keyUp = (event: KeyboardEvent) => {
  if (modified && !hasPreviewModifier(event)) {
   modified = false;
   options.onDeactivate?.();
  }
 };
 root.addEventListener('mouseover', update as EventListener, true);
 root.addEventListener('mousemove', update as EventListener, true);
 root.addEventListener('mouseout', out as EventListener, true);
 return () => {
  root.removeEventListener('mouseover', update as EventListener, true);
  root.removeEventListener('mousemove', update as EventListener, true);
  root.removeEventListener('mouseout', out as EventListener, true);
  clear();
 };
}

type HoverParent = { hoverPopover: unknown };
const parents = new WeakMap<HTMLElement, HoverParent>();

export function requestPagePreview(
 workspace: { trigger?: (name: string, payload: unknown) => void } | null,
 event: Event,
 source: string,
 targetEl: HTMLElement,
 linktext: string,
 sourcePath = '',
 hoverParent?: HoverParent,
): void {
 if (!hoverParent) {
  hoverParent = parents.get(targetEl);
  if (!hoverParent) {
   hoverParent = { hoverPopover: null };
   parents.set(targetEl, hoverParent);
  }
 }
 workspace?.trigger?.('hover-link', { event, source, hoverParent, targetEl, linktext, sourcePath });
}

export function closePagePreview(target: HTMLElement): void {
 const popover = parents.get(target)?.hoverPopover as { onClose?: () => void } | null | undefined;
 popover?.onClose?.();
}

export function createReferencePreviewFrame(anchor: HTMLElement, classes: string, title?: string) {
 const doc = anchor.ownerDocument;
 const panel = doc.body.createDiv({ cls: `popover hover-popover ${classes}` });
 const embed = panel.createDiv({ cls: 'markdown-embed' });
 const titleEl = title === undefined ? undefined : embed.createDiv({ cls: 'markdown-embed-title', text: title });
 const view = embed.createDiv({ cls: 'markdown-embed-content' })
  .createDiv({ cls: 'markdown-preview-view markdown-rendered' });
 return { panel, view, titleEl };
}

/** Position a fixed preview below its anchor, flipping and clamping at the window edges. */
export function placeReferencePreview(panel: HTMLElement, anchor: HTMLElement): void {
 const win = anchor.ownerDocument.defaultView;
 if (!win || !panel.isConnected || !anchor.isConnected) return;
 const viewport = win.visualViewport;
 const width = viewport?.width || win.innerWidth;
 const height = viewport?.height || win.innerHeight;
 const x = viewport?.offsetLeft || 0;
 const y = viewport?.offsetTop || 0;
 const gap = 8;
 panel.style.width = `${Math.max(0, Math.min(480, width - 2 * gap))}px`;
 panel.style.maxHeight = `${height * 0.6}px`;
 const r = anchor.getBoundingClientRect();
 const h = panel.offsetHeight;
 const w = panel.offsetWidth;
 const left = Math.max(x + gap, Math.min(r.left, x + width - w - gap));
 const below = r.bottom + gap;
 const top = Math.max(y + gap, Math.min(below + h <= y + height - gap ? below : r.top - gap - h, y + height - h - gap));
 panel.style.left = `${Math.round(left)}px`;
 panel.style.top = `${Math.round(top)}px`;
}

/** Let the mouse cross the gap from the reference to the preview. */
export function dismissAfterHover(anchor: HTMLElement, panel: HTMLElement, dismiss: () => void): () => void {
 const win = anchor.ownerDocument.defaultView ?? window;
 let timer: number | undefined;
 const cancel = () => { win.clearTimeout(timer); };
 const leave = (event: MouseEvent) => {
  const next = event.relatedTarget as Node | null;
  if (next && (panel.contains(next) || anchor.contains(next))) return;
  cancel();
  timer = win.setTimeout(dismiss, 180);
 };
 for (const part of [anchor, panel]) {
  part.addEventListener('mouseenter', cancel);
  part.addEventListener('mouseleave', leave);
 }
 return () => {
  cancel();
  for (const part of [anchor, panel]) {
   part.removeEventListener('mouseenter', cancel);
   part.removeEventListener('mouseleave', leave);
  }
 };
}
