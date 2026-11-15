import { App, TFile, normalizePath } from "obsidian";
import type {
	BookPosition,
	BookshelfCategory,
	FeedEntry,
	FeedSubscription,
	UNreaderSettings,
} from "../types";
import {
	annotationFileFor,
	annotationFileForFeed,
	loadAnnotations,
	parseAnnotations,
	writeAnnotations,
} from "./annotationStore";
import { getBookshelfEntries, getRemovedBookshelfEntries } from "./bookService";
import type { FeedService } from "./feedService";
import type { FeedStore } from "./feedStore";
import { saveFeedEntryAsMarkdown } from "./feedNoteSave";
import { htmlToMarkdown } from "./htmlToMarkdown";
import type { ProgressStore } from "./progressStore";
import type { BookIdentityStore } from "./bookIdentity";

export interface UnreaderAutomationApi {
	readonly version: 1;
	readonly actions: readonly string[];
	run(action: string, input?: Record<string, unknown>): Promise<unknown>;
}

export interface UnreaderAutomationDeps {
	app: App;
	version: string;
	getSettings(): UNreaderSettings;
	feedStore: FeedStore;
	feedService: FeedService;
	progress: ProgressStore;
	identity: BookIdentityStore;
	persistData(): Promise<void>;
	refreshFeedsPanels(): void;
	refreshBookshelfPanels(): void;
	refreshAnnotations(paths: readonly string[]): void | Promise<void>;
	afterFeedRemoved?(feedId: string): void;
	openBook(path: string): Promise<boolean>;
	openFeed(feedId: string, entryId: string): Promise<boolean>;
}

/** 对外稳定的自动化门面：第三方可以长期保存返回对象，内部始终转发到当前存储。 */
export function createStableAutomationFacade(
	getCurrent: () => UnreaderAutomationApi,
): UnreaderAutomationApi {
	const first = getCurrent();
	return {
		version: 1,
		actions: first.actions,
		run: (action, input) => getCurrent().run(action, input),
	};
}

const ACTIONS = Object.freeze([
	"status",
	"list_feeds",
	"add_feed",
	"refresh_feed",
	"update_feed",
	"remove_feed",
	"list_articles",
	"read_article",
	"update_article",
	"save_article_note",
	"list_books",
	"update_book",
	"list_categories",
	"create_category",
	"rename_category",
	"delete_category",
	"open",
	"get_progress",
	"list_annotations",
	"update_annotation",
] as const);

type ArticleState = "all" | "unread" | "read" | "starred" | "saved";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
	return value.trim();
}

function optionalText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return requiredText(value, "参数");
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${name} 必须是 true 或 false`);
	return value;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	const number = Math.floor(Number(value));
	return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function categoryId(): string {
	return `category-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function feedSummary(feed: FeedSubscription, entries: readonly FeedEntry[]) {
	const active = entries.filter(entry => entry.feedId === feed.id);
	return {
		id: feed.id,
		title: feed.title,
		feedUrl: feed.feedUrl,
		siteUrl: feed.siteUrl,
		description: feed.description,
		enabled: feed.enabled !== false,
		unread: active.filter(entry => entry.state.readAt == null).length,
		entries: active.length,
		lastFetchedAt: feed.lastFetchedAt,
		lastError: feed.lastError,
	};
}

function articleSummary(entry: FeedEntry) {
	return {
		feedId: entry.feedId,
		entryId: entry.id,
		kind: entry.kind,
		title: entry.title,
		url: entry.url,
		author: entry.author,
		publishedAt: entry.publishedAt,
		summary: entry.summary,
		contentSource: entry.contentSource,
		contentQuality: entry.contentQuality,
		read: entry.state.readAt != null,
		starred: entry.state.starredAt != null,
		saved: entry.state.savedAt != null,
		hasAnnotations: entry.state.hasAnnotations === true,
	};
}

function bookSummary(entry: ReturnType<typeof getBookshelfEntries>[number], hidden = false) {
	return {
		path: entry.path,
		name: entry.name,
		extension: entry.extension,
		progress: entry.progress,
		updatedAt: entry.updatedAt,
		pinned: entry.pinned,
		categoryId: entry.categoryId,
		hidden,
	};
}

export function createUnreaderAutomationApi(deps: UnreaderAutomationDeps): UnreaderAutomationApi {
	const bindResolvedIdentity = async (path: string, identity: Awaited<ReturnType<BookIdentityStore["resolve"]>>) => {
		if (identity.recoveredFrom) {
			deps.progress.bindIdentity(identity.recoveredFrom, identity.record.id);
			await deps.progress.move(identity.recoveredFrom, path);
			deps.progress.bindIdentity(path, identity.record.id);
		} else {
			deps.progress.bindIdentity(path, identity.record.id);
		}
	};

	const resolveAnnotationTarget = async (input: Record<string, unknown>) => {
		const bookPath = optionalText(input.bookPath);
		const feedId = optionalText(input.feedId);
		const entryId = optionalText(input.entryId);
		if (bookPath) {
			const file = deps.app.vault.getFileByPath(normalizePath(bookPath));
			if (!(file instanceof TFile)) throw new Error(`找不到书籍：${bookPath}`);
			const identity = await deps.identity.resolve(file);
			await bindResolvedIdentity(file.path, identity);
			return {
				kind: "book" as const,
				title: identity.record.displayName || file.basename,
				file,
				annotationPath: identity.record.notePath || annotationFileFor(file),
				bookLink: file.path,
				bookId: identity.record.id,
			};
		}
		if (feedId && entryId) {
			const feed = deps.feedStore.getFeed(feedId);
			const entry = deps.feedStore.getEntry(feedId, entryId);
			if (!feed || !entry) throw new Error("找不到这篇文章");
			return {
				kind: "feed" as const,
				title: entry.title || feed.title,
				annotationPath: annotationFileForFeed(feedId, entryId, entry.title),
				bookLink: entry.url || entry.title,
				bookId: undefined,
			};
		}
		throw new Error("list_annotations / update_annotation 需要 bookPath，或 feedId + entryId");
	};

	const run = async (rawAction: string, rawInput?: Record<string, unknown>): Promise<unknown> => {
		const action = rawAction.trim();
		const input = record(rawInput);
		const settings = deps.getSettings();

		switch (action) {
			case "status": {
				const feeds = deps.feedStore.listFeeds();
				const entries = deps.feedStore.listEntries();
				const getPosition = (path: string) => {
					const identity = deps.identity.getKnown(path);
					if (identity) deps.progress.bindIdentity(path, identity.id);
					return deps.progress.get(path);
				};
				const bookshelfHost = {
					app: deps.app,
					settings,
					getPosition,
				} as unknown as Parameters<typeof getBookshelfEntries>[0];
				return {
					version: deps.version,
					capabilities: ACTIONS,
					feeds: feeds.length,
					enabledFeeds: feeds.filter(feed => feed.enabled !== false).length,
					articles: entries.length,
					unreadArticles: entries.filter(entry => entry.state.readAt == null).length,
					books: getBookshelfEntries(bookshelfHost).length,
				};
			}

			case "list_feeds": {
				const entries = deps.feedStore.listEntries();
				return {
					feeds: deps.feedStore.listFeeds().map(feed => feedSummary(feed, entries)),
				};
			}

			case "add_feed": {
				const feedUrl = requiredText(input.url, "url");
				const result = await deps.feedService.addSubscription({
					feedUrl,
					...(optionalText(input.title) ? { title: optionalText(input.title) } : {}),
					...(optionalText(input.siteUrl) ? { siteUrl: optionalText(input.siteUrl) } : {}),
					...(optionalText(input.description) ? { description: optionalText(input.description) } : {}),
				});
				if (result.error) throw new Error(result.error);
				deps.refreshFeedsPanels();
				return {
					feed: deps.feedStore.getFeed(result.feedId),
					addedOrUpdated: result.addedOrUpdated,
					notModified: result.notModified,
				};
			}

			case "refresh_feed": {
				const feedId = requiredText(input.feedId, "feedId");
				const result = await deps.feedService.refreshFeed(feedId, true);
				if (result.error) throw new Error(result.error);
				deps.refreshFeedsPanels();
				return result;
			}

			case "update_feed": {
				const feedId = requiredText(input.feedId, "feedId");
				const title = optionalText(input.title);
				const enabled = optionalBoolean(input.enabled, "enabled");
				if (title === undefined && enabled === undefined) throw new Error("title 和 enabled 至少提供一个");
				if (!deps.feedStore.getFeed(feedId)) throw new Error(`找不到订阅：${feedId}`);
				await deps.feedStore.updateSubscription(feedId, { title, enabled });
				deps.refreshFeedsPanels();
				return { feed: deps.feedStore.getFeed(feedId) };
			}

			case "remove_feed": {
				const feedId = requiredText(input.feedId, "feedId");
				const feed = deps.feedStore.getFeed(feedId);
				if (!feed) throw new Error(`找不到订阅：${feedId}`);
				await deps.feedService.removeSubscription(feedId);
				deps.afterFeedRemoved?.(feedId);
				deps.refreshFeedsPanels();
				return { removed: true, feed };
			}

			case "list_articles": {
				const feedId = optionalText(input.feedId);
				if (feedId && !deps.feedStore.getFeed(feedId)) throw new Error(`找不到订阅：${feedId}`);
				const state = (optionalText(input.state) ?? "all") as ArticleState;
				if (!new Set<ArticleState>(["all", "unread", "read", "starred", "saved"]).has(state)) {
					throw new Error("state 必须是 all / unread / read / starred / saved");
				}
				const query = (optionalText(input.query) ?? "").toLocaleLowerCase();
				const disabled = new Set(
					deps.feedStore.listFeeds().filter(feed => feed.enabled === false).map(feed => feed.id),
				);
				const rows = deps.feedStore.listEntries(feedId)
					.filter(entry => feedId || !disabled.has(entry.feedId))
					.filter(entry => {
						if (state === "unread" && entry.state.readAt != null) return false;
						if (state === "read" && entry.state.readAt == null) return false;
						if (state === "starred" && entry.state.starredAt == null) return false;
						if (state === "saved" && entry.state.savedAt == null) return false;
						if (!query) return true;
						return `${entry.title}\n${entry.summary}\n${entry.author}`.toLocaleLowerCase().includes(query);
					});
				const offset = integer(input.offset, 0, 0, 100_000);
				const limit = integer(input.limit, 30, 1, 100);
				const page = rows.slice(offset, offset + limit);
				return {
					total: rows.length,
					offset,
					count: page.length,
					...(offset + page.length < rows.length ? { nextOffset: offset + page.length } : {}),
					articles: page.map(articleSummary),
				};
			}

			case "read_article": {
				const feedId = requiredText(input.feedId, "feedId");
				const entryId = requiredText(input.entryId, "entryId");
				const entry = await deps.feedStore.ensureEntryContent(feedId, entryId);
				if (!entry) throw new Error("找不到这篇文章");
				const maxChars = integer(input.maxChars, 20_000, 500, 50_000);
				const markdown = htmlToMarkdown(entry.contentHtml || entry.summary);
				return {
					...articleSummary(entry),
					markdown: markdown.slice(0, maxChars),
					truncated: markdown.length > maxChars,
					totalChars: markdown.length,
				};
			}

			case "update_article": {
				const feedId = requiredText(input.feedId, "feedId");
				const entryId = requiredText(input.entryId, "entryId");
				const read = optionalBoolean(input.read, "read");
				const starred = optionalBoolean(input.starred, "starred");
				const saved = optionalBoolean(input.saved, "saved");
				if (read === undefined && starred === undefined && saved === undefined) {
					throw new Error("read / starred / saved 至少提供一个");
				}
				const now = Date.now();
				const updated = await deps.feedStore.updateEntryState(feedId, entryId, {
					...(read !== undefined ? { readAt: read ? now : null } : {}),
					...(starred !== undefined ? { starredAt: starred ? now : null } : {}),
					...(saved !== undefined ? { savedAt: saved ? now : null } : {}),
				});
				if (!updated) throw new Error("找不到这篇文章");
				await deps.feedStore.flushOrThrow();
				deps.refreshFeedsPanels();
				return articleSummary(updated);
			}

			case "save_article_note": {
				const feedId = requiredText(input.feedId, "feedId");
				const entryId = requiredText(input.entryId, "entryId");
				const saved = await saveFeedEntryAsMarkdown({
					app: deps.app,
					store: deps.feedStore,
					fetchFulltext: (targetFeed, targetEntry) =>
						deps.feedService.fetchFulltext(targetFeed, targetEntry),
				}, feedId, entryId);
				if (!saved) return { saved: false, feedId, entryId };
				await deps.feedStore.flushOrThrow();
				deps.refreshFeedsPanels();
				return { saved: true, feedId, entryId, note: saved };
			}

			case "list_books": {
				const query = (optionalText(input.query) ?? "").toLocaleLowerCase();
				const getPosition = (path: string) => {
					const identity = deps.identity.getKnown(path);
					if (identity) deps.progress.bindIdentity(path, identity.id);
					return deps.progress.get(path);
				};
				const host = {
					app: deps.app,
					settings,
					getPosition,
				} as never;
				const visible = getBookshelfEntries(host).filter(book => !query || `${book.name}\n${book.path}`.toLocaleLowerCase().includes(query));
				const removed = input.includeRemoved === true
					? getRemovedBookshelfEntries(host).filter(book => !query || `${book.name}\n${book.path}`.toLocaleLowerCase().includes(query))
					: [];
				return {
					books: visible.map(book => bookSummary(book)),
					...(input.includeRemoved === true ? { removed: removed.map(book => bookSummary(book, true)) } : {}),
				};
			}

			case "update_book": {
				const path = normalizePath(requiredText(input.path, "path"));
				const file = deps.app.vault.getFileByPath(path);
				if (!(file instanceof TFile)) throw new Error(`找不到书籍：${path}`);
				const pinned = optionalBoolean(input.pinned, "pinned");
				const hidden = optionalBoolean(input.hidden, "hidden");
				const hasCategory = Object.prototype.hasOwnProperty.call(input, "categoryId");
				if (pinned === undefined && hidden === undefined && !hasCategory) {
					throw new Error("pinned / hidden / categoryId 至少提供一个");
				}
				let nextPinned: string[] | undefined;
				let nextHidden: string[] | undefined;
				let nextAssignments: Record<string, string> | undefined;
				if (pinned !== undefined) {
					const next = new Set(settings.bookshelfPinned ?? []);
					if (pinned) next.add(path); else next.delete(path);
					nextPinned = [...next];
				}
				if (hidden !== undefined) {
					const next = new Set(settings.bookshelfHiddenBooks ?? []);
					if (hidden) next.add(path); else next.delete(path);
					nextHidden = [...next];
				}
				if (hasCategory) {
					const nextCategory = input.categoryId == null ? null : requiredText(input.categoryId, "categoryId");
					const assignments = { ...(settings.bookshelfCategoryAssignments ?? {}) };
					if (nextCategory == null) delete assignments[path];
					else {
						if (!(settings.bookshelfCategories ?? []).some(category => category.id === nextCategory)) {
							throw new Error(`找不到书架分类：${nextCategory}`);
						}
						assignments[path] = nextCategory;
					}
					nextAssignments = assignments;
				}
				const before = {
					pinned: settings.bookshelfPinned,
					hidden: settings.bookshelfHiddenBooks,
					assignments: settings.bookshelfCategoryAssignments,
				};
				if (nextPinned) settings.bookshelfPinned = nextPinned;
				if (nextHidden) settings.bookshelfHiddenBooks = nextHidden;
				if (nextAssignments) settings.bookshelfCategoryAssignments = nextAssignments;
				try {
					await deps.persistData();
				} catch (error) {
					settings.bookshelfPinned = before.pinned;
					settings.bookshelfHiddenBooks = before.hidden;
					settings.bookshelfCategoryAssignments = before.assignments;
					throw new Error(`书架状态保存失败：${error instanceof Error ? error.message : String(error)}`);
				}
				deps.refreshBookshelfPanels();
				return { path, pinned, hidden, categoryId: settings.bookshelfCategoryAssignments?.[path] ?? null };
			}

			case "list_categories":
				return { categories: settings.bookshelfCategories ?? [] };

			case "create_category": {
				const name = requiredText(input.name, "name");
				if ((settings.bookshelfCategories ?? []).some(category => category.name === name)) {
					throw new Error(`已有分类：${name}`);
				}
				const created: BookshelfCategory = { id: categoryId(), name, createdAt: Date.now() };
				const before = settings.bookshelfCategories;
				settings.bookshelfCategories = [...(settings.bookshelfCategories ?? []), created];
				try {
					await deps.persistData();
				} catch (error) {
					settings.bookshelfCategories = before;
					throw new Error(`分类保存失败：${error instanceof Error ? error.message : String(error)}`);
				}
				deps.refreshBookshelfPanels();
				return { category: created };
			}

			case "rename_category": {
				const id = requiredText(input.categoryId, "categoryId");
				const name = requiredText(input.name, "name");
				const categories = settings.bookshelfCategories ?? [];
				const index = categories.findIndex(item => item.id === id);
				if (index < 0) throw new Error(`找不到书架分类：${id}`);
				if (categories.some(item => item.id !== id && item.name === name)) throw new Error(`已有分类：${name}`);
				const category: BookshelfCategory = { ...categories[index]!, name };
				const before = categories;
				settings.bookshelfCategories = categories.map(item => item.id === id ? category : item);
				try {
					await deps.persistData();
				} catch (error) {
					settings.bookshelfCategories = before;
					throw new Error(`分类保存失败：${error instanceof Error ? error.message : String(error)}`);
				}
				deps.refreshBookshelfPanels();
				return { category };
			}

			case "delete_category": {
				const id = requiredText(input.categoryId, "categoryId");
				const category = (settings.bookshelfCategories ?? []).find(item => item.id === id);
				if (!category) throw new Error(`找不到书架分类：${id}`);
				const beforeCategories = settings.bookshelfCategories;
				const beforeAssignments = settings.bookshelfCategoryAssignments;
				settings.bookshelfCategories = (settings.bookshelfCategories ?? []).filter(item => item.id !== id);
				settings.bookshelfCategoryAssignments = Object.fromEntries(
					Object.entries(settings.bookshelfCategoryAssignments ?? {}).filter(([, assigned]) => assigned !== id),
				);
				try {
					await deps.persistData();
				} catch (error) {
					settings.bookshelfCategories = beforeCategories;
					settings.bookshelfCategoryAssignments = beforeAssignments;
					throw new Error(`分类保存失败：${error instanceof Error ? error.message : String(error)}`);
				}
				deps.refreshBookshelfPanels();
				return { removed: true, category };
			}

			case "open": {
				const path = optionalText(input.path);
				const feedId = optionalText(input.feedId);
				const entryId = optionalText(input.entryId);
				if (path) return { opened: await deps.openBook(normalizePath(path)) };
				if (feedId && entryId) return { opened: await deps.openFeed(feedId, entryId) };
				throw new Error("open 需要 path，或 feedId + entryId");
			}

			case "get_progress": {
				const path = normalizePath(requiredText(input.path, "path"));
				const file = deps.app.vault.getFileByPath(path);
				if (file instanceof TFile) {
					const identity = await deps.identity.resolve(file);
					await bindResolvedIdentity(path, identity);
				}
				const position: BookPosition | undefined = deps.progress.get(path);
				return { path, position: position ?? null };
			}

			case "list_annotations": {
				const target = await resolveAnnotationTarget(input);
				const data = await loadAnnotations(deps.app.vault, target.annotationPath, target.bookLink);
				return {
					target: {
						kind: target.kind,
						title: target.title,
						annotationPath: target.annotationPath,
					},
					...data,
				};
			}

			case "update_annotation": {
				const target = await resolveAnnotationTarget(input);
				const kind = requiredText(input.kind, "kind");
				if (kind !== "highlight" && kind !== "bookmark") {
					throw new Error("kind 必须是 highlight 或 bookmark");
				}
				const annotationId = Math.floor(Number(input.annotationId));
				if (!Number.isFinite(annotationId)) throw new Error("annotationId 必须是数字");
				const operation = requiredText(input.operation, "operation");
				if (operation !== "delete" && operation !== "update") {
					throw new Error("operation 必须是 delete 或 update");
				}
				const file = deps.app.vault.getFileByPath(target.annotationPath);
				if (!file) throw new Error("找不到标注文件");
				const raw = await deps.app.vault.read(file);
				const data = parseAnnotations(raw);
				let changed = false;
				if (kind === "highlight") {
					const index = data.highlights.findIndex(item => item.id === annotationId);
					if (index < 0) throw new Error(`找不到高亮：${annotationId}`);
					if (operation === "delete") {
						data.highlights.splice(index, 1);
						changed = true;
					} else {
						const color = optionalText(input.color);
						const comment = input.comment === undefined
							? undefined
							: input.comment == null || input.comment === ""
								? ""
								: requiredText(input.comment, "comment");
						if (color === undefined && comment === undefined) throw new Error("更新高亮需要 color 或 comment");
						const highlight = data.highlights[index]!;
						if (color !== undefined) highlight.color = color;
						if (comment !== undefined) {
							if (comment) highlight.comment = comment;
							else delete highlight.comment;
						}
						changed = true;
					}
				} else {
					const index = data.bookmarks.findIndex(item => item.id === annotationId);
					if (index < 0) throw new Error(`找不到书签：${annotationId}`);
					if (operation === "delete") {
						data.bookmarks.splice(index, 1);
						changed = true;
					} else {
						const label = requiredText(input.label, "label").slice(0, 120);
						data.bookmarks[index]!.label = label;
						changed = true;
					}
				}
				if (changed) {
					await writeAnnotations(deps.app.vault, target.annotationPath, target.bookLink, data, raw, target.bookId);
					await deps.refreshAnnotations([target.annotationPath]);
				}
				return { changed, target: target.annotationPath, ...data };
			}

			default:
				throw new Error(`未知的 UNreader 操作：${action || "(空)"}`);
		}
	};

	return { version: 1, actions: ACTIONS, run };
}
