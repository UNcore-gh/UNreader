import { XMLParser } from "fast-xml-parser";
import type { FeedEnclosure } from "../types";
import { normalizeEnclosure, normalizeHttpUrl, stripHtml, stableEntryId, stableHash } from "./feedUtils";

type UnknownRecord = Record<string, unknown>;

export interface ParsedFeedEntry {
	id: string
	guid: string
	kind: "article" | "audio"
	title: string
	url: string
	author: string
	publishedAt: number
	updatedAt: number
	summary: string
	contentHtml: string
	contentSource: "feed" | "fulltext"
	contentHash: string
	enclosure: FeedEnclosure | null
}

export interface ParsedFeed {
	title: string
	siteUrl: string
	description: string
	entries: ParsedFeedEntry[]
}

export interface DiscoveredFeed {
	title: string
	url: string
	type: string
}

export interface ParsedOpmlFeed {
	title: string
	siteUrl: string
	feedUrl: string
}

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	removeNSPrefix: true,
	trimValues: false,
	parseTagValue: false,
	parseAttributeValue: false,
	cdataPropName: "#cdata",
});

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
	if (Array.isArray(value)) return value.map(textValue).find(Boolean) ?? "";
	if (!isRecord(value)) return "";
	for (const key of ["#cdata", "#text", "value", "@_href", "@_url"]) {
		const text = textValue(value[key]);
		if (text) return text;
	}
	return "";
}

function firstRecord(value: unknown): UnknownRecord | null {
	if (isRecord(value)) return value;
	if (Array.isArray(value)) for (const item of value) if (isRecord(item)) return item;
	return null;
}

function parseDate(value: unknown, fallback = Date.now()): number {
	const text = textValue(value);
	if (!text) return fallback;
	const time = Date.parse(text);
	return Number.isFinite(time) ? time : fallback;
}

function parseDuration(value: unknown): number | null {
	const raw = textValue(value);
	if (!raw) return null;
	if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Number(raw));
	const parts = raw.split(":").map(part => Number(part));
	if (parts.some(n => !Number.isFinite(n))) return null;
	if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
	if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
	return null;
}

function linkFrom(value: unknown, base: string, preferAlternate = true): string {
	const values = asArray(value);
	const preferred = preferAlternate
		? values.find(v => !isRecord(v) || ["", "alternate"].includes(textValue(v["@_rel"]).toLowerCase())) ?? values[0]
		: values[0];
	if (isRecord(preferred)) return normalizeHttpUrl(textValue(preferred["@_href"] || preferred["@_url"]), base);
	return normalizeHttpUrl(textValue(preferred), base);
}

function enclosureFrom(value: unknown, base: string, durationHint?: unknown): FeedEnclosure | null {
	for (const item of asArray(value)) {
		if (!isRecord(item)) continue;
		const rel = textValue(item["@_rel"]).toLowerCase();
		const type = textValue(item["@_type"] || item.type || item.mime_type) || "application/octet-stream";
		if (rel && rel !== "enclosure") continue;
		const url = normalizeHttpUrl(textValue(item["@_url"] || item["@_href"] || item.url), base);
		if (!url) continue;
		const length = Number(textValue(item["@_length"] || item.length || item.size_in_bytes));
		return normalizeEnclosure({
			url,
			type,
			length: Number.isFinite(length) ? length : null,
			duration: parseDuration(durationHint ?? item.duration ?? item.duration_in_seconds),
		});
	}
	return null;
}

function feedLinkFromRss(item: UnknownRecord, base: string): string {
	const direct = normalizeHttpUrl(textValue(item.link), base);
	if (direct) return direct;
	return linkFrom(item.link, base, false);
}

function entryFromRss(item: UnknownRecord, feedUrl: string, feedTitle: string): ParsedFeedEntry {
	const title = stripHtml(textValue(item.title)) || "未命名文章";
	const url = feedLinkFromRss(item, feedUrl);
	const guid = textValue(item.guid || item.id) || url || `${title}|${textValue(item.pubDate)}`;
	const publishedAt = parseDate(item.pubDate || item.published || item.updated || item.date);
	const contentRaw = textValue(item.encoded || item.content) || textValue(item.description || item.summary);
	const summary = stripHtml(textValue(item.description || item.summary || contentRaw)).slice(0, 500);
	const enclosure = enclosureFrom(item.enclosure, feedUrl, item.duration);
	const authorRecord = firstRecord(item.author);
	const author = textValue(authorRecord?.name || item.author || item.creator || item["dc:creator"] || feedTitle);
	return {
		id: stableEntryId({ guid, url, publishedAt, title }),
		guid,
		kind: enclosure?.type.startsWith("audio/") ? "audio" : "article",
		title,
		url,
		author,
		publishedAt,
		updatedAt: parseDate(item.updated || item.modified || item.pubDate, publishedAt),
		summary,
		contentHtml: contentRaw,
		contentSource: "feed",
		contentHash: stableHash(contentRaw || summary || title),
		enclosure,
	};
}

function parseRss(channel: UnknownRecord, feedUrl: string): ParsedFeed {
	const title = stripHtml(textValue(channel.title)) || new URL(feedUrl).hostname;
	const entries = asArray(channel.item).filter(isRecord).map(item => entryFromRss(item, feedUrl, title));
	return {
		title,
		siteUrl: linkFrom(channel.link, feedUrl, false),
		description: stripHtml(textValue(channel.description || channel.subtitle)).slice(0, 500),
		entries,
	};
}

function entryFromAtom(item: UnknownRecord, feedUrl: string, feedTitle: string): ParsedFeedEntry {
	const title = stripHtml(textValue(item.title)) || "未命名文章";
	const url = linkFrom(item.link, feedUrl, true);
	const guid = textValue(item.id) || url || `${title}|${textValue(item.updated)}`;
	const publishedAt = parseDate(item.published || item.updated || item.issued);
	const contentRaw = textValue(item.content) || textValue(item.summary);
	const summary = stripHtml(textValue(item.summary || contentRaw)).slice(0, 500);
	const enclosure = enclosureFrom(item.link, feedUrl, item.duration);
	const authorRecord = firstRecord(item.author);
	return {
		id: stableEntryId({ guid, url, publishedAt, title }),
		guid,
		kind: enclosure?.type.startsWith("audio/") ? "audio" : "article",
		title,
		url,
		author: textValue(authorRecord?.name || item.author || feedTitle),
		publishedAt,
		updatedAt: parseDate(item.updated || item.published, publishedAt),
		summary,
		contentHtml: contentRaw,
		contentSource: "feed",
		contentHash: stableHash(contentRaw || summary || title),
		enclosure,
	};
}

function parseAtom(feed: UnknownRecord, feedUrl: string): ParsedFeed {
	const title = stripHtml(textValue(feed.title)) || new URL(feedUrl).hostname;
	const entries = asArray(feed.entry).filter(isRecord).map(item => entryFromAtom(item, feedUrl, title));
	return {
		title,
		siteUrl: linkFrom(feed.link, feedUrl, true),
		description: stripHtml(textValue(feed.subtitle || feed.description)).slice(0, 500),
		entries,
	};
}

function parseJsonFeed(raw: string, feedUrl: string): ParsedFeed {
	const data = JSON.parse(raw) as UnknownRecord;
	const title = stripHtml(textValue(data.title)) || new URL(feedUrl).hostname;
	const authorRecord = firstRecord(data.author);
	const entries = asArray(data.items).filter(isRecord).map(item => {
		const entryTitle = stripHtml(textValue(item.title)) || "未命名文章";
		const url = normalizeHttpUrl(textValue(item.url || item.external_url), feedUrl);
		const guid = textValue(item.id) || url || `${entryTitle}|${textValue(item.date_published)}`;
		const contentRaw = textValue(item.content_html || item.content_text || item.summary);
		const summary = stripHtml(textValue(item.summary || item.content_text || contentRaw)).slice(0, 500);
		const publishedAt = parseDate(item.date_published || item.date_modified);
		const author = textValue(firstRecord(item.authors)?.name || item.author || authorRecord?.name || title);
		const enclosure = enclosureFrom(item.attachments, feedUrl);
		return {
			id: stableEntryId({ guid, url, publishedAt, title: entryTitle }),
			guid,
			kind: enclosure?.type.startsWith("audio/") ? "audio" as const : "article" as const,
			title: entryTitle,
			url,
			author,
			publishedAt,
			updatedAt: parseDate(item.date_modified || item.date_published, publishedAt),
			summary,
			contentHtml: contentRaw,
			contentSource: "feed" as const,
			contentHash: stableHash(contentRaw || summary || entryTitle),
			enclosure,
		};
	});
	return {
		title,
		siteUrl: normalizeHttpUrl(textValue(data.home_page_url), feedUrl),
		description: stripHtml(textValue(data.description)).slice(0, 500),
		entries,
	};
}

export function parseFeedDocument(raw: string, feedUrl: string): ParsedFeed {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("订阅源内容为空");
	if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, feedUrl);
	const parsed = xmlParser.parse(trimmed) as UnknownRecord;
	if (isRecord(parsed.rss) && isRecord(parsed.rss.channel)) return parseRss(parsed.rss.channel, feedUrl);
	if (isRecord(parsed.channel)) return parseRss(parsed.channel, feedUrl);
	if (isRecord(parsed.feed)) return parseAtom(parsed.feed, feedUrl);
	const rdf = isRecord(parsed.rdf) ? parsed.rdf : isRecord(parsed.RDF) ? parsed.RDF : null;
	if (rdf && isRecord(rdf.channel)) {
		return parseRss({ ...rdf.channel, item: rdf.item }, feedUrl);
	}
	throw new Error("无法识别 RSS、Atom 或 JSON Feed 格式");
}

export function parseOpml(raw: string): ParsedOpmlFeed[] {
	const parsed = xmlParser.parse(raw) as UnknownRecord;
	const body = isRecord(parsed.opml) ? firstRecord(parsed.opml.body) : null;
	if (!body) throw new Error("OPML 缺少 body");
	const out: ParsedOpmlFeed[] = [];
	const visit = (node: unknown): void => {
		for (const item of asArray(node)) {
			if (!isRecord(item)) continue;
			const feedUrl = normalizeHttpUrl(textValue(item["@_xmlUrl"]));
			if (feedUrl) {
				out.push({
					title: textValue(item["@_title"] || item["@_text"]) || new URL(feedUrl).hostname,
					siteUrl: normalizeHttpUrl(textValue(item["@_htmlUrl"]), feedUrl),
					feedUrl,
				});
			}
			if (item.outline) visit(item.outline);
		}
	};
	visit(body.outline);
	return out;
}

export function discoverFeedLinks(html: string, pageUrl: string): DiscoveredFeed[] {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const found: DiscoveredFeed[] = [];
	const seen = new Set<string>();
	for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="alternate"][href]'))) {
		const type = (link.type || "").toLowerCase();
		const supported = type.includes("rss") || type.includes("atom") || type.includes("feed+json") || type === "application/json";
		if (!supported) continue;
		const url = normalizeHttpUrl(link.getAttribute("href"), pageUrl);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		found.push({ title: link.title || new URL(url).hostname, url, type });
	}
	return found;
}
