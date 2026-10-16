/**
 * 悬空字体引用的自愈：把指向**已经不存在的旧路径**的字体引用改写回当前字体文件。
 *
 * ## 为什么需要它
 *
 * 自定义字体的 id 是 `custom:<库内完整路径>`（见 core/fontService.ts 的 scanCustomFonts）。
 * 因此「数据根搬家」——把 `配置/Fonts/` 整理成 `配置/UNreader/Data/Fonts/`、或用户手动挪了
 * 字体夹——会让所有引用**全部悬空**。而悬空的后果是**完全静默**的：
 * `engineAdapter.resolveFontFamily()` 在注册表里查不到 id，返回空串 → 正文回落主题字体，
 * 不报错、不提示、界面上也看不出差别（用户只会觉得「我选的字体怎么没了」）。
 *
 * 迁移路径（core/libraryMigration.ts 的 rewriteFontReferences）会在搬家的同时改写引用，
 * 但有两个它覆盖不到的漏口：
 *   · **跨端同步把旧的 data.json 推回来**：A 端迁移并改写，B 端离线仍是旧值，B 端上线后
 *     用旧值覆盖 A 端 —— 引用重新悬空，而迁移只跑一次，不会再来。
 *   · 用户在插件之外手动移动/重命名了字体文件夹。
 *
 * ## 判据为什么收得这么紧（宁可不修，也不猜）
 *
 * 「按文件名找同名字体」本身是一个**赌**：字体夹里完全可以并存两枚同名不同目录的字体
 * （scanCustomFonts 允许子文件夹）。所以这里与 core/libraryFolders.ts 的自愈同一姿态：
 *   · 只处理 `custom:` 前缀的 id（只有它的 id 就是路径，天然能判「旧路径还在不在」）；
 *   · 只有同文件名在当前扫描结果里**唯一命中**才改写；0 个（文件真的没了）或 ≥2 个
 *     （并列即放弃）一律不动 —— 选错一个会让用户看到**另一枚**字体的字形，比回落到
 *     主题字体更难察觉；
 *   · 只改**引用**，不碰任何字体文件，也不碰资源清单（`resources.json` 里的
 *     `font:<路径>` 键由迁移路径负责；自愈不写库内文件）。
 *
 * 改完由调用方落盘（settings → scheduleSave，库内预设 → presetStore.upsert）。 */
import type { AppearancePreset, CustomFont, UNreaderSettings } from "../types";

/** 自定义字体 id 前缀：`custom:<库内完整路径>`（与 core/fontService.ts 同一约定） */
const CUSTOM_PREFIX = "custom:";

export interface FontRefRepair {
	/** 改写前的 id（`custom:<旧路径>`） */
	from: string;
	/** 改写后的 id（`custom:<当前路径>`） */
	to: string;
	/** 引用位置（日志用：「当前外观」/「预设 自然」…） */
	where: string;
}

export interface FontRefRepairResult {
	/** 被改写的引用（空数组 = 什么都没动） */
	repairs: FontRefRepair[];
	/** 被改写的**库内预设**（对象已被就地修改，调用方需要 upsert 落盘） */
	changedPresets: AppearancePreset[];
	/** 是否改到了 settings（调用方需要 scheduleSave） */
	settingsChanged: boolean;
}

/** 路径末段（`a/b/c.ttf` → `c.ttf`）。用 split/lastIndexOf 而不是正则：库名可能含 `.` `(` 之类元字符。 */
function baseName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash >= 0 ? path.slice(slash + 1) : path;
}

/** 解析一处引用：返回改写后的 id；不需要/不能改写时返回 null。 */
function makeResolver(fonts: CustomFont[], repairs: FontRefRepair[]) {
	const known = new Set(fonts.map(f => f.id));
	const byBase = new Map<string, CustomFont[]>();
	for (const f of fonts) {
		const base = baseName(f.path);
		const arr = byBase.get(base);
		if (arr) arr.push(f);
		else byBase.set(base, [f]);
	}
	return (id: string | null | undefined, where: string): string | null => {
		if (!id || !id.startsWith(CUSTOM_PREFIX)) return null;
		if (known.has(id)) return null; // 引用仍然有效：不动（幂等）
		const candidates = byBase.get(baseName(id.slice(CUSTOM_PREFIX.length))) ?? [];
		if (candidates.length !== 1) return null; // 未命中或并列：放弃
		const to = candidates[0]!.id;
		if (to === id) return null;
		repairs.push({ from: id, to, where });
		return to;
	};
}

/** 就地把「悬空的自定义字体引用」改写回当前字体 id。**纯函数**（不改任何文件）。 */
export function repairDanglingFontRefs(
	settings: UNreaderSettings,
	fonts: CustomFont[],
	presets: AppearancePreset[],
): FontRefRepairResult {
	const repairs: FontRefRepair[] = [];
	const resolve = makeResolver(fonts, repairs);
	let settingsChanged = false;
	/** 只碰 `fontFamily` 一个字段：其余外观字段与资源 id 不在本轮范围 */
	const fix = (holder: { fontFamily?: string | null } | null | undefined, where: string): boolean => {
		if (!holder) return false;
		const next = resolve(holder.fontFamily, where);
		if (!next) return false;
		holder.fontFamily = next;
		return true;
	};
	if (fix(settings.appearance, "当前外观")) settingsChanged = true;
	for (const preset of settings.appearancePresets ?? []) {
		if (fix(preset?.appearance, `旧预设 ${preset?.name ?? ""}`.trim())) settingsChanged = true;
	}
	const changedPresets: AppearancePreset[] = [];
	for (const preset of presets) {
		if (fix(preset?.appearance, `预设 ${preset?.name ?? ""}`.trim())) changedPresets.push(preset);
	}
	return { repairs, changedPresets, settingsChanged };
}
