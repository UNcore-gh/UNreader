/** 带 Referer 的兜底下载通道（桌面 Node / 移动端 Capacitor 原生桥）。
 *
 * Obsidian 平台约束（2026-09-27 桌面实测）：所有出站请求在网络层被剥掉 Referer
 * （iframe 里 img 的 `referrerpolicy="unsafe-url"` 也覆盖不掉），给 `requestUrl`
 * 显式设置 Referer 头更会直接 `net::ERR_BLOCKED_BY_CLIENT`。而少数派等图床
 * 「Referer 为空即 403」（2026-09-29 复测：任意非空 Referer 都放行，UA 无关），
 * 所以任何走 Chromium 网络栈的通道都拿不到这类图，必须自己建连把 Referer 带出去。
 *
 * 桌面端渲染进程带 nodeIntegration（`window.require` 是 Obsidian 桌面端暴露的
 * 同一个 require，移动端为 undefined），用 Node 的 http/https 模块直接建连
 * （实测 sspai CDN 403 → 200）。注意它不走系统代理、不吃 CSP——只作 requestUrl
 * 失败后的兜底，不作为主通道。
 *
 * 移动端没有 Node，但 Obsidian 移动版是 Capacitor 壳，两级探测式兜底：
 * ① `requestUrl` 在移动端走 Capacitor 原生桥而非 Electron 的 SimpleURLLoader，
 *    显式 Referer 不一定被拦（桌面必拦，移动端行为随版本）——值得一试，403 /
 *    异常都自动降级；只带 Referer 最小头，多带一个头就多一分被桥拒绝的面。
 * ② `window.Capacitor.Plugins.CapacitorHttp`（Capacitor 内置 HTTP 插件）直接发
 *    原生请求（iOS NSURLSession / Android okhttp），headers 不受限；
 *    `responseType: "arraybuffer"` 的响应 data 是 base64 字符串，自行解码。
 *    只服务图片这类小资源（调用方传的 limit 是 IMAGE_LIMIT）；base64 双份内存，
 *    别拿它下大媒体。
 * 两级任何一步不可用 / 失败都静默降级，最终 null 由调用方退回原行为。
 * 惯例参照 `externalLink.ts`（别用裸 require / globalThis，eslint 会红）。 */

import { Platform, requestUrl } from "obsidian";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 UNreader/0.2";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface FetchedBytes {
	arrayBuffer: ArrayBuffer
	contentType: string
}

interface HttpResponseLike {
	statusCode?: number
	headers?: Record<string, string>
	on: (event: string, listener: (arg?: unknown) => void) => void
}

interface ClientRequestLike {
	on: (event: string, listener: (error: Error) => void) => void
	setTimeout: (ms: number, callback: () => void) => void
	destroy: (error?: Error) => void
}

interface HttpModuleLike {
	get: (url: string, options: { headers: Record<string, string> }, callback?: (response: HttpResponseLike) => void) => ClientRequestLike
}

/** Capacitor 内置 HTTP 插件：只声明用到的面。`responseType: "arraybuffer"` 时
 *  `data` 是 base64 字符串（Capacitor 桥不传二进制），`headers` 是小写键。 */
interface CapacitorHttpLike {
	request?: (options: {
		url: string
		method: string
		headers?: Record<string, string>
		responseType: string
		connectTimeout?: number
		readTimeout?: number
	}) => Promise<{ status?: number, data?: unknown, headers?: Record<string, string> }>
}

function requireHttpModule(url: string): HttpModuleLike | null {
	if (!Platform.isDesktopApp) return null;
	const req = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof req !== "function") return null;
	try {
		// 只允许这两个内置模块字面量，且 url 的协议头必须先匹配成功才走到这里
		if (/^https:\/\//i.test(url)) return req("https") as HttpModuleLike;
		if (/^http:\/\//i.test(url)) return req("http") as HttpModuleLike;
		return null;
	} catch {
		return null;
	}
}

function collectBody(chunks: Uint8Array[], total: number): FetchedBytes["arrayBuffer"] {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const part of chunks) {
		merged.set(part, offset);
		offset += part.byteLength;
	}
	return merged.buffer;
}

function nodeDownload(url: string, referer: string, timeoutMs: number, maxBytes: number): Promise<FetchedBytes | null> {
	const mod = requireHttpModule(url);
	if (!mod || typeof mod.get !== "function") return Promise.resolve(null);
	return new Promise(resolve => {
		let settled = false;
		const finish = (value: FetchedBytes | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			const request = mod.get(url, {
				headers: {
					Referer: referer,
					"User-Agent": BROWSER_UA,
					Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
				},
			}, response => {
				const status = response.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					finish(null);
					return;
				}
				const chunks: Uint8Array[] = [];
				let total = 0;
				let overflow = false;
				response.on("data", chunk => {
					const part = chunk as Uint8Array;
					total += part.byteLength;
					if (total > maxBytes) {
						overflow = true;
						finish(null);
						return;
					}
					chunks.push(part);
				});
				response.on("end", () => {
					if (overflow || settled) return;
					finish({
						arrayBuffer: collectBody(chunks, total),
						contentType: response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "",
					});
				});
			});
			request.on("error", () => finish(null));
			request.setTimeout(timeoutMs, () => {
				try { request.destroy(); } catch { /* 已结束的请求无需销毁 */ }
				finish(null);
			});
		} catch {
			finish(null);
		}
	});
}

/** 移动端第①级：requestUrl 显式带 Referer。桌面端会 ERR_BLOCKED_BY_CLIENT，
 *  所以这条只该在非桌面路径被走到；即便如此也包 try——平台行为随版本变。 */
async function requestUrlWithReferer(url: string, referer: string, maxBytes: number): Promise<FetchedBytes | null> {
	try {
		const response = await requestUrl({ url, throw: false, headers: { Referer: referer } });
		const buffer = response.arrayBuffer;
		if (response.status >= 200 && response.status < 300 && buffer && buffer.byteLength > 0 && buffer.byteLength <= maxBytes) {
			return {
				arrayBuffer: buffer,
				contentType: response.headers["content-type"] ?? response.headers["Content-Type"] ?? "",
			};
		}
	} catch { /* 被拦/失败 → 降级 CapacitorHttp */ }
	return null;
}

/** 移动端第②级：Capacitor 原生 HTTP，headers 不受限（URLSession/okhttp 层）。
 *  arraybuffer 响应的 data 是 base64 字符串，atob 解回字节。 */
async function capacitorHttpDownload(url: string, referer: string, timeoutMs: number, maxBytes: number): Promise<FetchedBytes | null> {
	const plugin = (window as unknown as {
		Capacitor?: { Plugins?: { CapacitorHttp?: CapacitorHttpLike } };
	}).Capacitor?.Plugins?.CapacitorHttp;
	if (!plugin || typeof plugin.request !== "function") return null;
	try {
		const response = await plugin.request({
			url,
			method: "GET",
			headers: { Referer: referer },
			responseType: "arraybuffer",
			connectTimeout: timeoutMs,
			readTimeout: timeoutMs,
		});
		const status = response.status ?? 0;
		if (status < 200 || status >= 300) return null;
		if (typeof response.data !== "string" || response.data.length === 0) return null;
		const binary = atob(response.data);
		if (binary.length > maxBytes) return null;
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return {
			arrayBuffer: bytes.buffer,
			contentType: response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? "",
		};
	} catch { /* 原生桥不可用/请求失败 → 调用方退回原行为 */ }
	return null;
}

/** 下载并收集响应体；非 2xx、超时、超过 maxBytes、网络错误都返回 null（尽力而为）。
 *  不处理重定向——兜底通道只服务直连可得的资源，需要的站点以后再扩。 */
export function downloadWithReferer(url: string, referer: string, options?: {
	timeoutMs?: number
	maxBytes?: number
}): Promise<FetchedBytes | null> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
	if (Platform.isDesktopApp) return nodeDownload(url, referer, timeoutMs, maxBytes);
	return requestUrlWithReferer(url, referer, maxBytes)
		.then(viaBridge => viaBridge ?? capacitorHttpDownload(url, referer, timeoutMs, maxBytes));
}
