import { requestUrl } from "obsidian";
import type { FeedSubscription } from "../types";
import { discoverFeedLinks, parseFeedDocument, type DiscoveredFeed, type ParsedFeed } from "./feedParser";
import { normalizeHttpUrl } from "./feedUtils";

const DEFAULT_TIMEOUT_MS = 15_000;

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

async function withTimeout<T>(task: Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			task,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`请求超时（${Math.round(ms / 1000)} 秒）`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function fetchDocument(url: string, options?: {
	etag?: string | null
	lastModified?: string | null
	timeoutMs?: number
}): Promise<FetchedDocument> {
	const headers: Record<string, string> = {
		Accept: "application/atom+xml, application/rss+xml, application/feed+json, application/json, text/xml, text/html;q=0.9, */*;q=0.5",
	};
	if (options?.etag) headers["If-None-Match"] = options.etag;
	if (options?.lastModified) headers["If-Modified-Since"] = options.lastModified;
	const response = await withTimeout(requestUrl({
		url,
		method: "GET",
		headers,
		throw: false,
	}), options?.timeoutMs);
	const status = response.status;
	return {
		url,
		status,
		text: status === 304 ? "" : response.text,
		contentType: header(response, "content-type") ?? "",
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

export async function fetchPageForExtraction(url: string): Promise<string> {
	return (await fetchDocument(url)).text;
}
