import rawReleaseNotes from "../release-notes.json";

export interface LocalizedReleaseNote {
	zh: string
	en: string
}

export interface ReleaseNoteEntry {
	title: LocalizedReleaseNote
	summary: LocalizedReleaseNote
	items: { zh: string[]; en: string[] }
}

export const RELEASE_NOTES = rawReleaseNotes as Record<string, ReleaseNoteEntry>;

function versionParts(version: string): number[] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? match.slice(1).map(Number) : null;
}

export function compareReleaseVersions(left: string, right: string): number {
	const a = versionParts(left);
	const b = versionParts(right);
	if (!a || !b) return left.localeCompare(right);
	for (let index = 0; index < 3; index++) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta) return delta;
	}
	return 0;
}

export function releaseNoteForVersion(version: string): ReleaseNoteEntry | null {
	return Object.prototype.hasOwnProperty.call(RELEASE_NOTES, version) ? RELEASE_NOTES[version] ?? null : null;
}

export function releaseNoteVersionsNewestFirst(): string[] {
	return Object.keys(RELEASE_NOTES).sort((a, b) => compareReleaseVersions(b, a));
}

/** 没有版本说明时不提醒；首次安装静默记为当前版本；已装过插件的库只提醒一次。 */
export function shouldPromptReleaseNotes(
	currentVersion: string,
	lastSeenVersion: string | null,
	hasExistingPluginData: boolean,
): boolean {
	if (!releaseNoteForVersion(currentVersion) || lastSeenVersion === currentVersion) return false;
	return lastSeenVersion !== null || hasExistingPluginData;
}
