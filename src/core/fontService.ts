import { App, TFile } from "obsidian";
import { CustomFont } from "../types";

const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2"]);

/** 单枚字体导入上限。CJK 全字库常见 20~35MB（作者库实测 3 枚各约 24MB），留余量到 40MB。
 *  超过则拒绝：移动端读入 → 写库 → 再读回建 blob 是瞬时峰值内存的几倍，
 *  而这个上限之内用户可以自己取舍（没有廉价的办法统计字体夹总量）。 */
export const MAX_FONT_BYTES = 40 * 1024 * 1024;

/** 是否是可识别的字体扩展名（导入前的二次校验；文件对话框的 accept 只是筛选提示，
 *  不是安全边界 —— 用户可以在对话框里改选「所有文件」）。 */
export function isFontExt(ext: string): boolean {
	return FONT_EXT.has(ext.toLowerCase());
}

/** 逐级建目录（已存在则忽略）。与 presetStore.ensureFolder 同一语义 */
async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = path.split("/").filter(Boolean);
	let cur = "";
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (app.vault.getAbstractFileByPath(cur)) continue;
		try { await app.vault.createFolder(cur); } catch { /* 已存在/并发创建 */ }
	}
}

/** 文件夹内取一个未被占用的路径：同名文件加序号（X.ttf → X 2.ttf）。
 *  去重是为了让「库内选中的文件已在字体夹里 → 直接选中不复制」这条判据可靠：
 *  同一枚字体落两份会让下拉里出现两个同名项，而它们的 id（= 路径）不同。 */
function uniquePath(app: App, folder: string, base: string, ext: string): string {
	const clean = base.replace(/[\\/:*?"<>|#^[\]]/g, "_").slice(0, 80) || "font";
	let candidate = `${folder}/${clean}.${ext}`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = `${folder}/${clean} ${n}.${ext}`;
		n++;
	}
	return candidate;
}

/** 把字体二进制写入库内字体文件夹，返回落盘路径（失败返回 null，由调用方提示）。
 *
 *  写入是库结构性事件，移动端会推进官方文件列表的重算 —— 本路径只由用户点击触发，
 *  天然在 onLayoutReady 之后，与预设落背景图同级（见 AGENTS.md 的虚拟化条目）。
 *
 *  用 `vault.createBinary` 而不是 presetStore 那边的 `adapter.writeBinary`：后者只在
 *  文件系统层落盘，要靠官方 watcher 异步补登记进 vault 文件树 —— 而导入的下一步
 *  （scanCustomFonts 枚举 `vault.getFiles()`）要求它**当场可见**，否则刚导入的字体
 *  不会出现在字体下拉里（桌面端快、移动端可能慢到肉眼可见）。 */
export async function importFontFile(
	app: App,
	folder: string,
	base: string,
	ext: string,
	buf: ArrayBuffer,
): Promise<string | null> {
	try {
		await ensureFolder(app, folder);
		const path = uniquePath(app, folder, base, ext);
		try {
			await app.vault.createBinary(path, buf);
		} catch (e) {
			// 并发下路径刚被占：退回覆盖写，至少把字体装进去
			console.warn("[UNreader] vault.createBinary 失败，退回 adapter 写入", e);
			await app.vault.adapter.writeBinary(path, buf);
		}
		return path;
	} catch (e) {
		console.warn("[UNreader] 字体导入失败", e);
		return null;
	}
}

/** 扫描字体文件夹，返回库内字体文件列表（含子文件夹） */
export function scanCustomFonts(app: App, folder: string): CustomFont[] {
	const raw = folder.trim().replace(/^\/+|\/+$/g, "");
	const files = app.vault.getFiles().filter(f => {
		if (FONT_EXT.has(f.extension.toLowerCase())) {
			if (!raw) return true;
			return f.path.startsWith(raw + "/") || f.path === raw;
		}
		return false;
	});
	files.sort((a, b) => a.basename.localeCompare(b.basename));
	return files.map(f => ({
		id: `custom:${f.path}`,
		label: f.basename,
		path: f.path,
	}));
}

/** 字体文件扩展名 → @font-face format() 提示（WOFF/WOFF2 必须正确标注，否则浏览器不加载） */
export function fontFormat(ext: string): string {
	const e = ext.toLowerCase();
	if (e === "woff2") return "woff2";
	if (e === "woff") return "woff";
	if (e === "otf") return "opentype";
	return "truetype";
}

/** 二进制 → base64。小步累积避免 `String.fromCharCode(...巨数组)` 在移动端
 *  触发 Maximum call stack（Android/iOS 的 WebView 调用栈较浅，spread 3 万+ 参数会抛）。 */
export function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const chunk = 0x4000; // 16384，安全阈值
	for (let i = 0; i < bytes.length; i += chunk) {
		const slice = bytes.subarray(i, i + chunk);
		let s = "";
		for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j] as number);
		bin += s;
	}
	return btoa(bin);
}

/** 读取字体文件为 blob URL（compact 引用，注入每个 frame 的 @font-face）。
 *  data URI 会把整份字体 base64 内联进每个章节 iframe 的 <style>——移动端 WebView
 *  对超大内联样式（10~20MB+）会静默失败/截断，表现为桌面生效、手机/平板不生效。
 *  用 blob URL（与图片资源同机制）跨平台可靠加载，且不膨胀每个 frame 的 DOM。 */
export async function fontToBlobUrl(app: App, path: string): Promise<{ uri: string; format: string } | null> {
	try {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const buf = await app.vault.readBinary(file);
		const ext = file.extension.toLowerCase();
		// ttf 用 font/ttf、otf 用 font/otf：部分 WebView 对 font/opentype 的 ttf 不识别
		const mime = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : ext === "otf" ? "font/otf" : "font/ttf";
		const blob = new Blob([buf], { type: mime });
		return { uri: URL.createObjectURL(blob), format: fontFormat(ext) };
	} catch {
		return null;
	}
}