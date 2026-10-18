interface ElectronInputWindow extends Window {
	electron?: {
		remote?: {
			getCurrentWebContents?: () => {
				getZoomLevel?: () => number;
				sendInputEvent?: (event: { type: "mouseDown" | "mouseUp"; x: number; y: number; button: "right" }) => void;
			};
		};
	};
}

interface ContextMenuFrameWindow extends Window {
	__unreaderNativeContextMenuRequestUntil?: number;
}

/** 在指定的阅读文档里送入真正的右键输入，让 Obsidian / Electron 走原有菜单通路。 */
export function dispatchNativeContextMenu(target: HTMLElement, hostWindow: Window = target.ownerDocument.defaultView ?? window): boolean {
	const doc = target.ownerDocument;
	const win = doc.defaultView;
	if (!win) return false;

	let eventTarget = target;
	let x = win.innerWidth / 2;
	let y = win.innerHeight / 2;
	let localPoint = false;
	const selection = doc.getSelection();
	if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
		const anchor = selection.anchorNode;
		const anchorElement = anchor?.nodeType === 1 ? anchor as HTMLElement : anchor?.parentElement;
		if (anchorElement && target.contains(anchorElement)) {
			eventTarget = anchorElement;
			try {
				const rect = selection.getRangeAt(0).getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) {
					x = rect.left + rect.width / 2;
					y = rect.top + rect.height / 2;
					localPoint = true;
				}
			} catch { /* 排版未就绪时退回视口中心。 */ }
		}
	} else if (target !== doc.body && target !== doc.documentElement) {
		const rect = target.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			x = rect.left + rect.width / 2;
			y = rect.top + rect.height / 2;
			localPoint = true;
		}
	}

	// Obsidian 的桌面编辑器右键命令也通过 webContents.sendInputEvent 送 mouseDown/up；
	// DOM 派发的 contextmenu 是 isTrusted=false，系统菜单不会因此弹出。
	let hostX = x;
	let hostY = y;
	let frameDepth = 0;
	let frameLeft = 0;
	let frameTop = 0;
	let frameWidth = win.innerWidth;
	let frameHeight = win.innerHeight;
	let frameWindow: Window | null = win;
	while (frameWindow?.frameElement) {
		const frame = frameWindow.frameElement as HTMLElement;
		const rect = frame.getBoundingClientRect();
		frameLeft += rect.left;
		frameTop += rect.top;
		frameWidth = rect.width;
		frameHeight = rect.height;
		frameDepth++;
		frameWindow = frame.ownerDocument.defaultView;
	}
	if (localPoint) {
		hostX += frameLeft;
		hostY += frameTop;
	} else if (frameDepth > 0) {
		// 章节 iframe 高度可能是整章长度；用它与宿主视口的交集中心，避免坐标落在屏外。
		const left = Math.max(0, frameLeft);
		const top = Math.max(0, frameTop);
		const right = Math.min(hostWindow.innerWidth, frameLeft + frameWidth);
		const bottom = Math.min(hostWindow.innerHeight, frameTop + frameHeight);
		hostX = right > left ? (left + right) / 2 : hostWindow.innerWidth / 2;
		hostY = bottom > top ? (top + bottom) / 2 : hostWindow.innerHeight / 2;
	} else {
		hostX = hostWindow.innerWidth / 2;
		hostY = hostWindow.innerHeight / 2;
	}
	try {
		const contents = (hostWindow as ElectronInputWindow).electron?.remote?.getCurrentWebContents?.();
		if (contents?.sendInputEvent) {
			const scale = Math.pow(1.2, contents.getZoomLevel?.() ?? 0);
			const input = { x: hostX * scale, y: hostY * scale, button: "right" as const };
			if (frameDepth > 0) {
				// 电子书 frame 的触屏长按保护会拦 detail=0/1；这次是工具栏显式请求，
				// 给该 frame 的一次右键事件开短时通行证，物理长按仍照旧被抑制。
				const frameWindowWithToken = win as ContextMenuFrameWindow;
				const token = Date.now() + 1000;
				frameWindowWithToken.__unreaderNativeContextMenuRequestUntil = token;
				hostWindow.setTimeout(() => {
					if (frameWindowWithToken.__unreaderNativeContextMenuRequestUntil === token) {
						delete frameWindowWithToken.__unreaderNativeContextMenuRequestUntil;
					}
				}, 1100);
			}
			contents.sendInputEvent({ type: "mouseDown", ...input });
			contents.sendInputEvent({ type: "mouseUp", ...input });
			return true;
		}
	} catch { /* 受限宿主下退回 DOM 事件通路。 */ }

	return eventTarget.dispatchEvent(new win.MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: win,
		detail: 2,
		button: 2,
		buttons: 2,
		clientX: x,
		clientY: y,
	}));
}
