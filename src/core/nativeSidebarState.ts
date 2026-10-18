export type NativeSidebarMode = "bookshelf" | "feeds" | "notes";

export type NativeSidebarCardIntent = "open-content" | "open-annotations" | "wait-for-open";

export interface NativeSidebarCardIntentInput {
	targetKey: string;
	loadedKey: string | null;
	pendingKey: string | null;
}

/** 同一内容已加载才直达标注；加载期间再次点同卡则等待这次加载成功。 */
export function resolveNativeSidebarCardIntent(input: NativeSidebarCardIntentInput): NativeSidebarCardIntent {
	if (input.pendingKey === input.targetKey) return "wait-for-open";
	if (input.pendingKey !== null) return "open-content";
	return input.loadedKey === input.targetKey ? "open-annotations" : "open-content";
}

/** 首次展开按当前内容类型选列表；用户明确选过页后保留他的选择。 */
export function resolveNativeSidebarPickerMode(input: {
	contentKind: "book" | "feed" | "markdown" | null;
	savedMode: unknown;
	hasSavedMode: boolean;
	feedsEnabled: boolean;
}): NativeSidebarMode {
	const fallback: NativeSidebarMode = input.contentKind === "markdown"
		? "notes"
		: input.contentKind === "feed" && input.feedsEnabled ? "feeds" : "bookshelf";
	if (!input.hasSavedMode) return fallback;
	if (input.savedMode === "feeds" && !input.feedsEnabled) return fallback;
	if (input.savedMode === "bookshelf" || input.savedMode === "feeds" || input.savedMode === "notes") return input.savedMode;
	return fallback;
}

/** 旧布局只迁移一次，之后尊重用户自己拖动到的分组。 */
export function shouldMigrateNativeSidebarGroup(input: {
	existingView: boolean;
	migrationDone: boolean;
	sameGroup: boolean;
}): boolean {
	return input.existingView && !input.migrationDone && !input.sameGroup;
}

/** 异步标注动作仅能写回生成该动作的那份内容。 */
export function canApplyNativeSidebarAnnotationAction(capturedKey: string, currentKey: string | null): boolean {
	return currentKey === capturedKey;
}

/** 布局迁移只选一个原生侧栏标签作为保留项。迁移后优先尊重用户当前激活的标签。 */
export function selectNativeSidebarKeeperIndex(input: {
	leafCount: number;
	sameGroupIndices: number[];
	activeIndex: number;
	migrationDone: boolean;
}): number | null {
	if (input.leafCount <= 0) return null;
	if (!input.migrationDone && input.sameGroupIndices.length) return input.sameGroupIndices[0] ?? 0;
	if (input.migrationDone && input.activeIndex >= 0 && input.activeIndex < input.leafCount) return input.activeIndex;
	return 0;
}

/** 列表排序变化后，让记住的卡片回到它之前相对滚动区的位置。 */
export function adjustNativeSidebarScrollTop(
	currentScrollTop: number,
	currentAnchorOffset: number,
	rememberedAnchorOffset: number,
): number {
	return Math.max(0, currentScrollTop + currentAnchorOffset - rememberedAnchorOffset);
}

/** 内容卡片优先复用发起操作的活动阅读器；侧栏取得焦点时回到最近阅读器。 */
export function selectPreferredReaderIndex(input: {
	leafCount: number;
	targetIndex?: number;
	activeIndex: number;
	lastUsedIndex: number;
}): number | null {
	if (input.leafCount <= 0) return null;
	if (input.targetIndex != null && input.targetIndex >= 0 && input.targetIndex < input.leafCount) return input.targetIndex;
	if (input.activeIndex >= 0 && input.activeIndex < input.leafCount) return input.activeIndex;
	if (input.lastUsedIndex >= 0 && input.lastUsedIndex < input.leafCount) return input.lastUsedIndex;
	return 0;
}

/** 校验配置文件里的分页值；RSS 关闭时不允许恢复到已消失的订阅页。 */
export function normalizeNativeSidebarMode(value: unknown, feedsEnabled: boolean): NativeSidebarMode {
	if (value === "feeds" && feedsEnabled) return "feeds";
	if (value === "notes") return "notes";
	return "bookshelf";
}
