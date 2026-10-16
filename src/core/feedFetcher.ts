import { requestUrl } from "obsidian";
import type { FeedSubscription } from "../types";
import { discoverFeedLinks, parseFeedDocument, type DiscoveredFeed, type ParsedFeed } from "./feedParser";
import { normalizeHttpUrl } from "./feedUtils";
import { decodeHtmlBytes } from "./textEncoding";

const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 25_000;
/** 网页抓取失败后的重试：给一次机会（首包超时/连接被重置多为瞬时），超时缩短以免用户干等。 */
const PAGE_RETRY_TIMEOUT_MS = 12_000;
const PAGE_RETRY_DELAY_MS = 600;
const PAGE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,image/avif,image/webp,*/*;q=0.5";
const FEED_ACCEPT = "application/atom+xml, application/rss+xml, application/feed+json, application/json, text/xml, text/html;q=0.9, */*;q=0.5";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 UNreader/0.2";

export interface FetchedDocument {
	url: string
	status: number
	text: string
	contentType: string
	etag: string | null
	lastModified: string | null
	notModified: boolean
}

export interface FeedResolution {
	inputUrl: string
	feedUrl: string
	discovered: DiscoveredFeed[]
	feed: ParsedFeed | null
}

function header(response: { headers: Record<string, string> }, name: string): string | null {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers ?? {})) {
		if (key.toLowerCase() === wanted) return value || null;
	}
	return null;
}

/** 取响应正文：有字节就按声明的/嗅探到的 charset 自己解码（见 textEncoding 的说明），
 *  拿不到字节（测试桩、304）才回退 Obsidian 已解码的 `text`。 */
function responseText(response: { text?: string; arrayBuffer?: ArrayBuffer }, contentType: string): string {
	const buffer = response.arrayBuffer;
	if (buffer && buffer.byteLength > 0) {
		try {
			return decodeHtmlBytes(new Uint8Array(buffer), contentType);
		} catch { /* 解码异常时回退 Obsidian 的 text */ }
	}
	return response.text ?? "";
}

async function withTimeout<T>(task: Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
	let timer: number | null = null;
	try {
		return await Promise.race([
			task,
			new Promise<T>((_, reject) => {
				timer = window.setTimeout(() => reject(new Error(`请求超时（${Math.round(ms / 1000)} 秒）`)), ms);
			}),
		]);
	} finally {
		if (timer) window.clearTimeout(timer);
	}
}

export async function fetchDocument(url: string, options?: {
	etag?: string | null
	lastModified?: string | null
	timeoutMs?: number
	purpose?: "feed" | "page"
}): Promise<FetchedDocument> {
	const purpose = options?.purpose ?? "feed";
	const headers: Record<string, string> = {
		Accept: purpose === "page" ? PAGE_ACCEPT : FEED_ACCEPT,
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		"User-Agent": BROWSER_USER_AGENT,
	};
	if (purpose === "page") headers["Cache-Control"] = "no-cache";
	if (options?.etag) headers["If-None-Match"] = options.etag;
	if (options?.lastModified) headers["If-Modified-Since"] = options.lastModified;
	const response = await withTimeout(requestUrl({
		url,
		method: "GET",
		headers,
		throw: false,
	}), options?.timeoutMs);
	const status = response.status;
	if (status >= 400 && status !== 304) throw new Error(`请求失败（HTTP ${status}）`);
	const contentType = header(response, "content-type") ?? "";
	const text = status === 304 ? "" : responseText(response, contentType);
	if (purpose === "page") {
		if (/application\/(?:pdf|zip|octet-stream)|\bimage\//i.test(contentType)) throw new Error(`网页返回了不支持的内容类型：${contentType || "未知"}`);
		const preview = text.slice(0, 24_000);
		if (/cf-chl-|Enable JavaScript and cookies to continue|Just a moment\.\.\.|Attention Required!|访问验证|安全验证/i.test(preview)) {
			throw new Error("网页触发了站点验证，暂时无法直接抓取正文");
		}
	}
	return {
		url,
		status,
		text,
		contentType,
		etag: header(response, "etag"),
		lastModified: header(response, "last-modified"),
		notModified: status === 304,
	};
}

export async function fetchParsedFeed(feed: FeedSubscription): Promise<{ feed: ParsedFeed; response: FetchedDocument }> {
	const response = await fetchDocument(feed.feedUrl, {
		etag: feed.etag,
		lastModified: feed.lastModified,
	});
	if (response.notModified) {
		return {
			feed: { title: feed.title, siteUrl: feed.siteUrl, description: feed.description, entries: [] },
			response,
		};
	}
	return { feed: parseFeedDocument(response.text, feed.feedUrl), response };
}

export async function resolveFeedInput(input: string): Promise<FeedResolution> {
	const inputUrl = normalizeHttpUrl(input);
	if (!inputUrl) throw new Error("请输入有效的 http(s) 地址");
	const response = await fetchDocument(inputUrl);
	try {
		const feed = parseFeedDocument(response.text, inputUrl);
		return { inputUrl, feedUrl: inputUrl, discovered: [], feed };
	} catch (parseError) {
		const discovered = discoverFeedLinks(response.text, inputUrl);
		if (discovered.length === 0) throw parseError;
		if (discovered.length === 1) {
			const feedUrl = discovered[0]!.url;
			const feedResponse = await fetchDocument(feedUrl);
			return {
				inputUrl,
				feedUrl,
				discovered,
				feed: parseFeedDocument(feedResponse.text, feedUrl),
			};
		}
		return { inputUrl, feedUrl: "", discovered, feed: null };
	}
}

/** 首包超时/连接被重置这类瞬时故障重试一次；4xx、验证页、内容类型不支持不重试
 *  （重试只会再等一轮，结果一样）。 */
function isRetryablePageError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (/HTTP 4\d\d/.test(message)) return false;
	if (/站点验证|不支持的内容类型|需要登录|需要付费|可提取的正文/.test(message)) return false;
	return true;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

export async function fetchPageForExtraction(url: string): Promise<string> {
	try {
		return (await fetchDocument(url, { purpose: "page", timeoutMs: PAGE_TIMEOUT_MS })).text;
	} catch (error) {
		if (!isRetryablePageError(error)) throw error;
		await delay(PAGE_RETRY_DELAY_MS);
		return (await fetchDocument(url, { purpose: "page", timeoutMs: PAGE_RETRY_TIMEOUT_MS })).text;
	}
}
