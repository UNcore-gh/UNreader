import { Notice } from "obsidian";
import { AppearanceSettings, AppearancePreset, DEFAULT_APPEARANCE, normalizeHexColor, activeBackground, activeTextColor, activeTheme, activeBackgroundImage } from "../types";
import { resolveAppearance } from "../core/engineAdapter";

/** 内置 lucide 图标（不依赖 Obsidian 图标注册表，保证全平台渲染）。
 *  用结构化 path/polyline 定义 + createElementNS 逐个建节点——不能用 svg.innerHTML：
 *  移动端 WebView（iOS/Android）对 createElementNS 的 svg 赋 innerHTML 解析不可靠，
 *  图标会静默不显示。 */
const INLINE_ICON_DEFS: Record<string, { tag: string; attrs: Record<string, string> }[]> = {
	"rotate-ccw": [
		{ tag: "path", attrs: { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" } },
		{ tag: "path", attrs: { d: "M3 3v5h5" } },
	],
	"save": [
		{ tag: "path", attrs: { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" } },
		{ tag: "polyline", attrs: { points: "17 21 17 13 7 13 7 21" } },
		{ tag: "polyline", attrs: { points: "7 3 7 8 15 8" } },
	],
	"pencil": [
		{ tag: "path", attrs: { d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" } },
		{ tag: "path", attrs: { d: "m15 5 4 4" } },
	],
	"trash": [
		{ tag: "path", attrs: { d: "M3 6h18" } },
		{ tag: "path", attrs: { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" } },
		{ tag: "path", attrs: { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" } },
	],
	"x": [
		{ tag: "path", attrs: { d: "M18 6 6 18" } },
		{ tag: "path", attrs: { d: "m6 6 12 12" } },
	],
};

/** 生成 lucide 风格的 inline SVG 图标元素（stroke=currentColor，随按钮颜色显隐） */
function createInlineIcon(name: string, size = 14): SVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
		// 尺寸/显示兜底交给 .unreader-inline-icon 类（规避全局 .svg-icon 规则把尺寸压成 0）
	svg.setAttribute("class", "svg-icon unreader-inline-icon");
	for (const part of INLINE_ICON_DEFS[name] ?? []) {
		const el = document.createElementNS(ns, part.tag);
		for (const [k, v] of Object.entries(part.attrs)) el.setAttribute(k, v);
		svg.appendChild(el);
	}
	return svg;
}

export interface AppearanceCallbacks {
	onChange: (patch: Partial<AppearanceSettings>) => void
	getPresets?: () => AppearancePreset[]
	/** 当前生效的预设 id（用于下拉框回显预设名；null = 未启用预设/手动调整） */
	getActivePresetId?: () => string | null
	/** 保存当前外观为新预设；name 省略时由宿主负责命名（弹窗） */
	onSavePreset?: (name?: string) => void
	onApplyPreset?: (id: string) => void
	onDeletePreset?: (id: string) => void
	/** 重命名选中预设；命名由宿主负责（弹窗） */
	onRenamePreset?: (id: string) => void
	/** 将当前外观覆盖到选中预设 */
	onUpdatePreset?: (id: string) => void
	/** 面板打开后回调（用于外部对齐定位） */
	onOpened?: () => void
	/** 面板开 / 合回调（含面板自带关闭按钮、点外面、鼠标移开自动关这几条路径）：
	 *  宿主据此同步功能轨上那枚按钮的「作用中」高亮。挂在这里而不是各调用点 ——
	 *  `open()` / `close()` 是开合的唯一收口，少挂一条路径就会留下假高亮。 */
	onOpenChange?: (open: boolean) => void
	/** 从库中选择背景图片（弹窗列表） */
	onPickImage?: (field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark") => void
	/** 从系统文件选择器选择背景图片 */
	onPickImageSystem?: (field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark") => void
	/** 背景图片的展示名（仅显示用，面板里的文本框显示名字而非原始引用） */
	getImageName?: (field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark") => string | null
	/** 自定义字体列表（库内字体文件夹扫描结果），追加到字体选择 */
	getCustomFonts?: () => { id: string; label: string }[]
	/** 从库中选择字体文件导入（弹窗列表）；选完即复制进字体文件夹并选中 */
	onPickFont?: () => void
	/** 从系统文件选择器选择字体文件导入 */
	onPickFontSystem?: () => void
}

export type AppearanceSection = "normal" | "full"

type SegmentedOption<T extends string | number> = {
	value: T;
	label: string;
}

export class AppearancePanel {
	readonly containerEl: HTMLElement;
	private onChange: AppearanceCallbacks["onChange"];
	private getPresets: () => AppearancePreset[];
	private getActivePresetId: () => string | null;
	private onSavePreset: (name?: string) => void;
	private onApplyPreset: (id: string) => void;
	private onDeletePreset: (id: string) => void;
	private onRenamePreset: (id: string) => void;
	private onUpdatePreset: (id: string) => void;
	private onOpened: () => void;
	private onOpenChange: (open: boolean) => void;
	private onPickImage: (field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark") => void;
	private onPickImageSystem: (field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark") => void;
	private getImageName: (field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark") => string | null;
	private getCustomFonts: () => { id: string; label: string }[];
	private onPickFont: () => void;
	private onPickFontSystem: () => void;
	private current: AppearanceSettings;
	/** 当前生效预设 id（下拉框回显用） */
	private activePresetId: string | null = null;
	private closeTimeout: number | null = null;
	private entered = false;
	private ignoreOutsideUntil = 0;
	/** 下一次 render 完成后要定位到的分组（仅由工具栏快捷按钮传入）。 */
	private pendingScrollSection: AppearanceSection | null = null;

	constructor(callbacks: AppearanceCallbacks | ((patch: Partial<AppearanceSettings>) => void)) {
		if (typeof callbacks === "function") {
			this.onChange = callbacks;
			this.getPresets = () => [];
			this.getActivePresetId = () => null;
			this.onSavePreset = () => {};
			this.onApplyPreset = () => {};
			this.onDeletePreset = () => {};
			this.onRenamePreset = () => {};
			this.onUpdatePreset = () => {};
			this.onOpened = () => {};
			this.onOpenChange = () => {};
			this.onPickImage = () => {};
			this.onPickImageSystem = () => {};
			this.getImageName = () => null;
			this.getCustomFonts = () => [];
			this.onPickFont = () => {};
			this.onPickFontSystem = () => {};
		} else {
			this.onChange = callbacks.onChange;
			this.getPresets = callbacks.getPresets ?? (() => []);
			this.getActivePresetId = callbacks.getActivePresetId ?? (() => null);
			this.onSavePreset = callbacks.onSavePreset ?? (() => {});
			this.onApplyPreset = callbacks.onApplyPreset ?? (() => {});
			this.onDeletePreset = callbacks.onDeletePreset ?? (() => {});
			this.onRenamePreset = callbacks.onRenamePreset ?? (() => {});
			this.onUpdatePreset = callbacks.onUpdatePreset ?? (() => {});
			this.onOpened = callbacks.onOpened ?? (() => {});
			this.onOpenChange = callbacks.onOpenChange ?? (() => {});
			this.onPickImage = callbacks.onPickImage ?? (() => {});
			this.onPickImageSystem = callbacks.onPickImageSystem ?? (() => {});
			this.getImageName = callbacks.getImageName ?? (() => null);
			this.getCustomFonts = callbacks.getCustomFonts ?? (() => []);
			this.onPickFont = callbacks.onPickFont ?? (() => {});
			this.onPickFontSystem = callbacks.onPickFontSystem ?? (() => {});
		}
		this.containerEl = document.createElement("div");
		this.containerEl.className = "unreader-appearance-panel";
		// 鼠标离开面板自动关闭（300ms 延迟，移入则取消）。
		// 仅 hover 能力设备绑定：触屏靠「点击按钮开 + 点外面关」，
		// 否则触屏的合成 mouseenter/mouseleave 会在打开后 300ms 自动关掉面板。
		let hoverable = false;
		try { hoverable = window.matchMedia?.("(hover: hover)")?.matches ?? false; } catch { hoverable = false; }
		if (hoverable) {
			this.containerEl.addEventListener("mouseenter", () => {
				this.entered = true;
				if (this.closeTimeout) {
					window.clearTimeout(this.closeTimeout);
					this.closeTimeout = null;
				}
			});
			this.containerEl.addEventListener("mouseleave", () => {
				if (!this.entered) return; // 尚未进入过（如因布局变化误触发）不关闭
				if (this.closeTimeout) window.clearTimeout(this.closeTimeout);
				this.closeTimeout = window.setTimeout(() => {
					this.closeTimeout = null;
					try {
						// 原生吸色盘（input[type=color] 弹窗）是 OS 级窗口，指针移上去
						// 必然离开面板元素触发 mouseleave——但 color input 仍持焦，
						// 此时不能自动关闭，否则调色进行到一半面板消失
						const ae = document.activeElement as HTMLInputElement | null;
						if (ae && ae.tagName === "INPUT" && ae.type === "color") return;
					} catch { /* ignore */ }
					this.close();
				}, 300) as unknown as number;
			});
		}
		this.current = { ...DEFAULT_APPEARANCE };
	}

	open(current: AppearanceSettings, section: AppearanceSection | null = null): void {
		if (this.closeTimeout) {
			window.clearTimeout(this.closeTimeout);
			this.closeTimeout = null;
		}
		this.entered = false;
		// 刚打开时短窗口内忽略外部 pointerdown（覆盖点击触发按钮时的同一次指针事件链）
		this.ignoreOutsideUntil = performance.now() + 300;
		this.current = { ...current };
		this.pendingScrollSection = section;
		this.activePresetId = this.getActivePresetId();
		this.render();
		this.containerEl.addClass("is-open");
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
		// 通知外部对齐定位（边框与右下按钮轨对齐）
		this.onOpened();
		// 通知宿主：功能轨上这枚按钮转「作用中」
		this.onOpenChange(true);
	}

	close(): void {
		if (this.closeTimeout) {
			window.clearTimeout(this.closeTimeout);
			this.closeTimeout = null;
		}
		this.entered = false;
		if (!this.containerEl.hasClass("is-open")) return;
		this.containerEl.removeClass("is-open");
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		// 通知宿主：按钮回到常态（面板自带关闭按钮 / 点外面 / 鼠标移开自动关都走这里）
		this.onOpenChange(false);
	}

	toggle(current: AppearanceSettings, section: AppearanceSection | null = null): boolean {
		if (this.containerEl.hasClass("is-open")) {
			this.close();
		} else {
			this.open(current, section);
		}
		return this.containerEl.hasClass("is-open");
	}

	isOpen(): boolean {
		return this.containerEl.hasClass("is-open");
	}

	private onDocPointerDown = (ev: PointerEvent): void => {
		// 打开后的短窗口内忽略外部指针（避免打开动画/布局变化的误判）
		if (performance.now() < this.ignoreOutsideUntil) return;
		const target = ev.target as HTMLElement | null;
		if (!target) return;
		// inside the panel → keep open
		if (this.containerEl.contains(target)) return;
		// clicks on the right action rail belong to the toggle button —
		// ignore them here so its own click handler can close cleanly
		if (target.closest(".unreader-actions")) return;
		this.close();
	};

	private emit(patch: Partial<AppearanceSettings>): void {
		this.current = { ...this.current, ...patch };
		this.onChange(patch);
		this.renderValues();
	}

	private render(): void {
		// 全量重建会丢滚动位置：先记住，末尾恢复（开关/滑杆/主题切换不再弹回顶部）
		const prevScroll = this.containerEl.querySelector(".unreader-appearance-scroll")?.scrollTop ?? 0;
		this.containerEl.empty();
		const scrollEl = this.containerEl.createDiv({ cls: "unreader-appearance-scroll" });

		const header = scrollEl.createDiv({ cls: "unreader-appearance-header" });
		header.createSpan({ text: "阅读外观" });

		// 预设：多套样式一键切换
		scrollEl.appendChild(this.buildPresetRow());


		// 阅读模式：仅保留上下滚动
		// （原「左右翻页」选项已删除：见分页模式清理；栏数 colsRow 同样仅
		//  对左右翻页生效，故一并删去，简化设置面板）

		const fontRow = this.buildFontSelect(this.current.fontFamily);
		scrollEl.appendChild(fontRow);

		const resolved = resolveAppearance(this.current);
		scrollEl.appendChild(
			this.buildSlider("字号", 12, 28, 0.5, resolved.fontSize, v => this.emit({ fontSize: v }), x => `${x}px`, () => {
				this.emit({ fontSize: null });
				this.current.fontSize = null;
				this.render();
			}),
		);
		scrollEl.appendChild(
			this.buildSlider("左边距", 0, 120, 2, resolved.marginLeft, v => this.emit({ marginLeft: v }), x => `${Math.round(x)}px`, () => {
				this.emit({ marginLeft: DEFAULT_APPEARANCE.marginLeft });
				this.current.marginLeft = null;
				this.render();
			}),
		);
		scrollEl.appendChild(
			this.buildSlider("右边距", 0, 120, 2, resolved.marginRight, v => this.emit({ marginRight: v }), x => `${Math.round(x)}px`, () => {
				this.emit({ marginRight: DEFAULT_APPEARANCE.marginRight });
				this.current.marginRight = null;
				this.render();
			}),
		);
		// 上下边距行已删除：原本仅对左右翻页生效，分页模式砍掉后不再需要
		{
			// 为什么需要这句：宽窗口下正文列宽由「居中留白」接管（max(设定边距, (视口−700)/2)），
			// 940px 以上的窗口里滑杆从 0 拖到 120 都不改变正文位置 —— 用户读到的是
			// 「这两个滑杆没用」。实际上边距是**下限**（窄窗口/手机上就完全生效）。
			const hint = scrollEl.createDiv({ cls: "unreader-appearance-hint" });
			hint.setText("左右边距是下限：窗口够宽时正文列会居中（留白按阅读宽度算），边距要超过那份留白才推得动；窄窗口与手机上完全生效。");
		}

		scrollEl.appendChild(
			this.buildSlider("行距", 1.2, 2.4, 0.05, resolved.lineHeight, v => this.emit({ lineHeight: v }), x => x.toFixed(2), () => {
				this.emit({ lineHeight: null });
				this.current.lineHeight = null;
				this.render();
			}),
		);
		scrollEl.appendChild(
		this.buildSlider("段间距", 0, 3, 0.05, resolved.paragraphSpacing, v => this.emit({ paragraphSpacing: v }), x => `${x.toFixed(2)}em`, () => {
			this.emit({ paragraphSpacing: null });
			this.current.paragraphSpacing = null;
			this.render();
		}),
		);
		// 首行缩进按 em 落在各段落元素上，随字号自动缩放；0 = 不缩进
		scrollEl.appendChild(
			this.buildSlider("首行缩进", 0, 8, 1, resolved.paragraphIndent, v => this.emit({ paragraphIndent: Math.round(v) }), x => `${Math.round(x)} 字符`, () => {
				this.emit({ paragraphIndent: DEFAULT_APPEARANCE.paragraphIndent });
				this.current.paragraphIndent = DEFAULT_APPEARANCE.paragraphIndent;
				this.render();
			}),
		);
		scrollEl.appendChild(
			this.buildSlider("字间距", -0.05, 0.3, 0.01, resolved.letterSpacing, v => this.emit({ letterSpacing: v }), x => `${x.toFixed(2)}em`, () => {
				this.emit({ letterSpacing: DEFAULT_APPEARANCE.letterSpacing as number });
				(this.current as unknown as Record<string, unknown>).letterSpacing = DEFAULT_APPEARANCE.letterSpacing;
				this.render();
			}),
		);

		// ---------- 界面颜色 ----------
		const colorHeader = scrollEl.createDiv({ cls: "unreader-appearance-color-header" });
		colorHeader.createSpan({ text: "界面颜色" });
		scrollEl.appendChild(colorHeader);

		// 配色来源：跟随 Obsidian 主题（背景/文字与 Obsidian 界面同色）或自定义色值
		scrollEl.appendChild(this.buildSelectRow("配色来源", [
			{ value: "obsidian" as const, label: "跟随 Obsidian" },
			{ value: "custom" as const, label: "自定义" },
		], this.current.colorMode ?? "obsidian", v => {
			this.current.colorMode = v as AppearanceSettings["colorMode"];
			this.emit({ colorMode: v as AppearanceSettings["colorMode"] });
			this.render();
		}, "恢复默认：跟随 Obsidian", () => {
			this.emit({ colorMode: DEFAULT_APPEARANCE.colorMode });
			this.current.colorMode = DEFAULT_APPEARANCE.colorMode;
			this.render();
		}));

		// 深浅主题切换：分别保存浅色/深色配色
		scrollEl.appendChild(this.buildSelectRow("主题", [
			{ value: "auto" as const, label: "自动" },
			{ value: "light" as const, label: "浅色" },
			{ value: "dark" as const, label: "深色" },
		], this.current.theme ?? "auto", v => {
			this.current.theme = v as AppearanceSettings["theme"];
			this.emit({ theme: v as AppearanceSettings["theme"] });
			this.render();
		}, "恢复默认：自动", () => {
			this.emit({ theme: DEFAULT_APPEARANCE.theme });
			this.current.theme = DEFAULT_APPEARANCE.theme;
			this.render();
		}));

		const isDark = activeTheme(this.current) === "dark";
		const bgFallback = isDark ? (DEFAULT_APPEARANCE.darkBackgroundColor as string) : (DEFAULT_APPEARANCE.backgroundColor as string);
		const fgFallback = isDark ? (DEFAULT_APPEARANCE.darkTextColor as string) : (DEFAULT_APPEARANCE.textColor as string);
		const bgValue = isDark ? activeBackground(this.current) : activeBackground(this.current);
		const fgValue = isDark ? activeTextColor(this.current) : activeTextColor(this.current);
		// 跟随 Obsidian 模式：不显示自定义色行，给一句说明
		if ((this.current.colorMode ?? "obsidian") !== "custom") {
			scrollEl.createDiv({ cls: "unreader-tag-desc unreader-color-follow-hint", text: "背景与文字颜色跟随 Obsidian 当前主题（明暗切换自动同步）。切换「配色来源」为「自定义」可单独设置颜色。" });
		} else {
		// 用 activeBackground/activeTextColor 已自动取对应主题
		scrollEl.appendChild(
			this.buildColorRow("背景色", bgValue, v => {
				if (isDark) this.emit({ darkBackgroundColor: v } as Partial<AppearanceSettings>);
				else this.emit({ backgroundColor: v });
			}, bgFallback, () => {
				if (isDark) {
					this.emit({ darkBackgroundColor: DEFAULT_APPEARANCE.darkBackgroundColor } as Partial<AppearanceSettings>);
					this.current.darkBackgroundColor = DEFAULT_APPEARANCE.darkBackgroundColor;
				} else {
					this.emit({ backgroundColor: DEFAULT_APPEARANCE.backgroundColor });
					this.current.backgroundColor = DEFAULT_APPEARANCE.backgroundColor;
				}
				this.render();
			}),
		);
		scrollEl.appendChild(
			this.buildColorRow("文字颜色", fgValue, v => {
				if (isDark) this.emit({ darkTextColor: v } as Partial<AppearanceSettings>);
				else this.emit({ textColor: v });
			}, fgFallback, () => {
				if (isDark) {
					this.emit({ darkTextColor: DEFAULT_APPEARANCE.darkTextColor } as Partial<AppearanceSettings>);
					this.current.darkTextColor = DEFAULT_APPEARANCE.darkTextColor;
				} else {
					this.emit({ textColor: DEFAULT_APPEARANCE.textColor });
					this.current.textColor = DEFAULT_APPEARANCE.textColor;
				}
				this.render();
			}),
		);
		} // 自定义配色行结束

		// ---------- 背景图片（收纳进深浅主题板块） ----------
		const imgHeader = scrollEl.createDiv({ cls: "unreader-appearance-color-header" });
		imgHeader.createSpan({ text: "背景图片" });
		scrollEl.appendChild(imgHeader);

		// 作用范围：深浅共用一张，或深浅分别设置
		scrollEl.appendChild(this.buildSelectRow("作用范围", [
			{ value: "shared" as const, label: "深浅共用" },
			{ value: "separate" as const, label: "深浅分别" },
		], this.current.bgImageMode ?? "shared", v => {
			const patch: Partial<AppearanceSettings> = { bgImageMode: v };
			// 首次切到分别设置：用当前共用图填充两侧，避免视觉突变
			if (v === "separate") {
				const cur = this.current.backgroundImage ?? null;
				const light = this.current.backgroundImageLight ?? null;
				const dark = this.current.backgroundImageDark ?? null;
				patch.backgroundImageLight = light ?? cur;
				patch.backgroundImageDark = dark ?? cur;
				this.current.backgroundImageLight = patch.backgroundImageLight;
				this.current.backgroundImageDark = patch.backgroundImageDark;
			}
			this.current.bgImageMode = v;
			this.emit(patch);
			this.render();
		}, "恢复默认：深浅共用", () => {
			this.emit({ bgImageMode: DEFAULT_APPEARANCE.bgImageMode });
			this.current.bgImageMode = DEFAULT_APPEARANCE.bgImageMode;
			this.render();
		}));

		const separate = (this.current.bgImageMode ?? "shared") === "separate";
		if (separate) {
			scrollEl.appendChild(this.buildBackgroundImageRow("backgroundImageLight", "浅色图片"));
			scrollEl.appendChild(this.buildBackgroundImageRow("backgroundImageDark", "深色图片"));
		} else {
			scrollEl.appendChild(this.buildBackgroundImageRow("backgroundImage", "图片"));
		}
		const hasImage = !!activeBackgroundImage(this.current);
		const blurRow = this.buildSlider("图片模糊", 0, 30, 1, this.current.imageBlur ?? 0, v => this.emit({ imageBlur: v }), x => `${Math.round(x)}px`, () => {
			this.emit({ imageBlur: DEFAULT_APPEARANCE.imageBlur });
			this.current.imageBlur = DEFAULT_APPEARANCE.imageBlur;
			this.render();
		});
		// 图片模糊行在无图片时禁用（直接设在行上；之前误设到了滚动容器，无效）
		if (!hasImage) blurRow.setAttr("data-disabled", "true");
		scrollEl.appendChild(blurRow);
		// 玻璃效果开关：选中态只反映 glassEnabled；无图片时整行禁用，
		// 否则复选框永远选不上、点了也没变化（玻璃本就只在有图时生效）
		const glassRow = this.buildToggleRow("玻璃效果", this.current.glassEnabled, v => {
			this.current.glassEnabled = v;
			this.emit({ glassEnabled: v });
			this.render();
		}, () => {
			this.emit({ glassEnabled: DEFAULT_APPEARANCE.glassEnabled });
			this.current.glassEnabled = DEFAULT_APPEARANCE.glassEnabled;
			this.render();
		});
		if (!hasImage) glassRow.setAttr("data-disabled", "true");
		scrollEl.appendChild(glassRow);
		// 玻璃模糊与不透明度（仅在启用玻璃且有图片时显示）
		if (hasImage && this.current.glassEnabled) {
			scrollEl.appendChild(
				this.buildSlider("玻璃模糊", 0, 40, 1, this.current.glassBlur ?? 12, v => this.emit({ glassBlur: v }), x => `${Math.round(x)}px`, () => {
					this.emit({ glassBlur: DEFAULT_APPEARANCE.glassBlur });
					this.current.glassBlur = DEFAULT_APPEARANCE.glassBlur;
					this.render();
				}),
			);
			scrollEl.appendChild(
				this.buildSlider("玻璃不透明", 0, 1, 0.05, this.current.glassOpacity ?? 0.55, v => this.emit({ glassOpacity: v }), x => x.toFixed(2), () => {
					this.emit({ glassOpacity: DEFAULT_APPEARANCE.glassOpacity });
					this.current.glassOpacity = DEFAULT_APPEARANCE.glassOpacity;
					this.render();
				}),
			);
		}
		// 背景色/文字色在玻璃下仍生效，提示
		if (hasImage) {
			const hint = scrollEl.createDiv({ cls: "unreader-appearance-hint" });
			hint.setText(this.current.glassEnabled ? "已启用玻璃效果，文字浮于图片之上，可通过“玻璃不透明”调节可读性。" : "建议开启玻璃效果或提高图片模糊，避免文字与图片对比不足。");
			scrollEl.appendChild(hint);
		}

		// 常态模式：工具栏、目录轨、进度条与滚动行为都在这一组里，语义不再混用
		// “沉浸模式”。移动端/平板与桌面只影响加载时的初始默认，不锁死用户选择。
		const normalSection = this.buildSectionRow("常态模式", "normal");
		scrollEl.appendChild(normalSection);
		scrollEl.appendChild(this.buildToggleRow("显示工具栏", this.current.normalModeShowToolbar !== false, v => {
			this.current.normalModeShowToolbar = v;
			this.emit({ normalModeShowToolbar: v });
		}, () => {
			this.emit({ normalModeShowToolbar: DEFAULT_APPEARANCE.normalModeShowToolbar });
			this.current.normalModeShowToolbar = DEFAULT_APPEARANCE.normalModeShowToolbar;
			this.render();
		}));
		scrollEl.appendChild(this.buildToggleRow("滑动自动隐藏", this.current.normalModeScrollHide !== false, v => {
			this.current.normalModeScrollHide = v;
			this.emit({ normalModeScrollHide: v });
		}, () => {
			this.emit({ normalModeScrollHide: DEFAULT_APPEARANCE.normalModeScrollHide });
			this.current.normalModeScrollHide = DEFAULT_APPEARANCE.normalModeScrollHide;
			this.render();
		}));
		scrollEl.appendChild(this.buildToggleRow("浮动目录条", this.current.showTocRail === true, v => {
			this.current.showTocRail = v;
			this.emit({ showTocRail: v });
			this.render();
		}, () => {
			this.emit({ showTocRail: DEFAULT_APPEARANCE.showTocRail });
			this.current.showTocRail = DEFAULT_APPEARANCE.showTocRail;
			this.render();
		}));
		scrollEl.appendChild(this.buildToggleRow("章节进度条", this.current.chapterProgress !== false, v => {
			this.current.chapterProgress = v;
			this.emit({ chapterProgress: v });
			this.render();
		}, () => {
			this.emit({ chapterProgress: DEFAULT_APPEARANCE.chapterProgress });
			this.current.chapterProgress = DEFAULT_APPEARANCE.chapterProgress;
			this.render();
		}));
		scrollEl.appendChild(this.buildToggleRow("接管原生界面", this.current.normalModeHideNativeChrome === true, v => {
			this.current.normalModeHideNativeChrome = v;
			this.emit({ normalModeHideNativeChrome: v });
		}, () => {
			this.emit({ normalModeHideNativeChrome: DEFAULT_APPEARANCE.normalModeHideNativeChrome });
			this.current.normalModeHideNativeChrome = DEFAULT_APPEARANCE.normalModeHideNativeChrome;
			this.render();
		}));
		scrollEl.appendChild(this.buildToggleRow("自动打开目录面板", this.current.autoOpenToc === true, v => {
			this.current.autoOpenToc = v;
			this.emit({ autoOpenToc: v });
		}, () => {
			this.emit({ autoOpenToc: DEFAULT_APPEARANCE.autoOpenToc });
			this.current.autoOpenToc = DEFAULT_APPEARANCE.autoOpenToc;
			this.render();
		}));
		scrollEl.appendChild(
			this.buildSlider("按钮/目录条大小", 0.8, 1.6, 0.05, this.current.railScale ?? 1, v => this.emit({ railScale: v }), x => `${Math.round(x * 100)}%`, () => {
				this.emit({ railScale: DEFAULT_APPEARANCE.railScale });
				this.current.railScale = DEFAULT_APPEARANCE.railScale;
				this.render();
			}),
		);
		{
			const hint = scrollEl.createDiv({ cls: "unreader-appearance-hint" });
			hint.setText("点击正文空白始终可临时唤出工具栏；「滑动自动隐藏」只管插件工具层，「接管原生界面」让 Obsidian 的页首/底栏随滚动与工具层显隐一起收放（关掉后完全不碰原生界面）。浮动目录与章节进度按各自开关显示，不受工具栏显隐影响。");
		}

		// 全沉浸：默认只留退出按钮，这里的两个开关只控制明确例外。
		const fullSection = this.buildSectionRow("全沉浸模式", "full");
		scrollEl.appendChild(fullSection);
		const fullTocRow = this.buildToggleRow("显示浮动目录", this.current.fullImmersionShowTocRail === true, v => {
			this.current.fullImmersionShowTocRail = v;
			this.emit({ fullImmersionShowTocRail: v });
		}, () => {
			this.emit({ fullImmersionShowTocRail: DEFAULT_APPEARANCE.fullImmersionShowTocRail });
			this.current.fullImmersionShowTocRail = DEFAULT_APPEARANCE.fullImmersionShowTocRail;
			this.render();
		});
		if (this.current.showTocRail !== true) fullTocRow.setAttr("data-disabled", "true");
		(fullTocRow.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.toggleAttribute("disabled", this.current.showTocRail !== true);
		scrollEl.appendChild(fullTocRow);
		const fullProgressRow = this.buildToggleRow("显示章节进度条", this.current.fullImmersionShowChapterProgress === true, v => {
			this.current.fullImmersionShowChapterProgress = v;
			this.emit({ fullImmersionShowChapterProgress: v });
		}, () => {
			this.emit({ fullImmersionShowChapterProgress: DEFAULT_APPEARANCE.fullImmersionShowChapterProgress });
			this.current.fullImmersionShowChapterProgress = DEFAULT_APPEARANCE.fullImmersionShowChapterProgress;
			this.render();
		});
		if (this.current.chapterProgress !== true) fullProgressRow.setAttr("data-disabled", "true");
		(fullProgressRow.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.toggleAttribute("disabled", this.current.chapterProgress !== true);
		scrollEl.appendChild(fullProgressRow);
		scrollEl.appendChild(this.buildToggleRow("点击屏幕显示界面", this.current.fullImmersionTapReveal === true, v => {
			this.current.fullImmersionTapReveal = v;
			this.emit({ fullImmersionTapReveal: v });
		}, () => {
			this.emit({ fullImmersionTapReveal: DEFAULT_APPEARANCE.fullImmersionTapReveal });
			this.current.fullImmersionTapReveal = DEFAULT_APPEARANCE.fullImmersionTapReveal;
			this.render();
		}));
		{
			const hint = scrollEl.createDiv({ cls: "unreader-appearance-hint" });
			hint.setText("全沉浸默认隐藏所有界面，仅保留左上角半透明退出图标；开启“点击屏幕显示界面”后，点击正文可临时唤出常态工具层与原生界面。目录与进度只有在上方全局开关开启时才可作为例外保留。");
		}

		const footer = this.containerEl.createDiv({ cls: "unreader-appearance-footer" });
		const resetAllBtn = footer.createEl("button", { text: "重置全部为默认" });
		resetAllBtn.addEventListener("click", () => {
			const patch: AppearanceSettings = { ...DEFAULT_APPEARANCE };
			this.current = { ...patch };
			this.onChange(patch);
			this.render();
		});
		const scrollTarget = this.pendingScrollSection;
		this.pendingScrollSection = null;
		if (scrollTarget) {
			requestAnimationFrame(() => {
				const section = this.containerEl.querySelector<HTMLElement>(`[data-appearance-section="${scrollTarget}"]`);
				section?.scrollIntoView({ block: "start" });
			});
		} else if (prevScroll > 0) {
			const sc = this.containerEl.querySelector(".unreader-appearance-scroll");
			if (sc) sc.scrollTop = prevScroll;
		}
	}

	private renderValues(): void {
		// 下拉选择框：同步当前值（避免渲染后与 state 脱节）
		const syncSelect = (label: string, value: string): void => {
			const row = Array.from(this.containerEl.querySelectorAll<HTMLElement>(".unreader-appearance-row"))
				.find(r => r.querySelector(".unreader-appearance-label")?.textContent === label);
			const select = row?.querySelector<HTMLSelectElement>("select");
			if (select) select.value = value;
		};
		syncSelect("主题", this.current.theme ?? "auto");
		syncSelect("作用范围", this.current.bgImageMode ?? "shared");
	}

	/** 生成「标签 + 下拉选择 + 重置」行（阅读模式/栏数/主题统一用选择框收纳，紧凑） */
	private buildSelectRow<T extends string | number>(
		label: string,
		options: SegmentedOption<T>[],
		active: T,
		onPick: (v: T) => void,
		resetTitle: string,
		onReset: () => void,
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label", text: label });
		const control = row.createDiv({ cls: "unreader-appearance-control" });
		const select = control.createEl("select", { cls: "dropdown" }) as HTMLSelectElement;
		for (const opt of options) {
			select.createEl("option", { value: String(opt.value), text: opt.label });
		}
		select.value = String(active);
		select.addEventListener("change", () => {
			const v = options.find(o => String(o.value) === select.value);
			if (v) onPick(v.value);
		});
		row.appendChild(this.createResetButton(onReset, resetTitle));
		return row;
	}

	private buildFontSelect(currentId: string | null): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label", text: "字体" });
		const control = row.createDiv({ cls: "unreader-appearance-control" });
		const select = control.createEl("select", { cls: "dropdown" }) as HTMLSelectElement;
		select.createEl("option", { value: "", text: "跟随 Obsidian" });
		// 仅自定义字体（库内字体文件夹扫描结果）：要么跟随 Obsidian，要么用导入的字体
		const customs = this.getCustomFonts();
		if (customs.length) {
			const group = document.createElement("optgroup");
			group.label = "自定义字体";
			// 同名消歧：label 是去扩展名的 basename，所以 A.ttf 与 A.otf 会得到同一个
			// 显示名（而它们的 id / 字形都不同）——出现重名时补扩展名区分
			const labelCount = new Map<string, number>();
			for (const f of customs) labelCount.set(f.label, (labelCount.get(f.label) ?? 0) + 1);
			for (const f of customs) {
				const opt = document.createElement("option");
				opt.value = f.id;
				const dup = (labelCount.get(f.label) ?? 0) > 1;
				opt.text = dup ? `${f.label}（${f.id.split(".").pop() ?? ""}）` : f.label;
				group.appendChild(opt);
			}
			select.appendChild(group);
		}
		// 当前选中的字体已不在扫描结果里（文件被删/改名，或他端同步还没到本机）：
		// 补一个占位项。否则下面 `if (!select.value) select.selectedIndex = 0` 会让
		// 下拉显示「跟随 Obsidian」，而设置里其实还是那个旧 id —— UI 在说谎。
		if (currentId && !customs.some(f => f.id === currentId)) {
			const base = currentId.startsWith("custom:")
				? currentId.slice("custom:".length).split("/").pop() ?? ""
				: currentId;
			const opt = document.createElement("option");
			opt.value = currentId;
			opt.text = `字体已停用或丢失：${base.replace(/\.[^.]+$/, "")}`;
			select.appendChild(opt);
		}
		select.value = currentId ?? "";
		if (!select.value) select.selectedIndex = 0;
		select.addEventListener("change", () => {
			this.emit({ fontFamily: select.value || null });
		});
		// 字体从此在外观面板里「自管理」：库内挑一个 / 从系统导入一个，
		// 两者都复制进插件的字体文件夹（设置页不再有字体文件夹配置项）
		const libBtn = control.createEl("button", {
			text: "库",
			cls: "unreader-appearance-preset-btn",
			attr: { title: "从库中选择字体文件导入" },
		});
		libBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.onPickFont();
		});
		const sysBtn = control.createEl("button", {
			text: "系统",
			cls: "unreader-appearance-preset-btn",
			attr: { title: "从系统选择本地字体文件导入" },
		});
		sysBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.onPickFontSystem();
		});
		row.appendChild(this.createResetButton(() => {
			this.emit({ fontFamily: null });
			this.current.fontFamily = null;
			this.render();
		}, "恢复默认：跟随 Obsidian"));
		return row;
	}

	private buildSlider(
		label: string,
		min: number,
		max: number,
		step: number,
		initial: number,
		onInput: (v: number) => void,
		format: (v: number) => string,
		onReset?: () => void,
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label", text: label });
		const control = row.createDiv({ cls: "unreader-appearance-control" });
		const value = control.createSpan({ cls: "unreader-appearance-value", text: format(initial) });
		const slider = control.createEl("input", {
			type: "range",
			attr: { min: String(min), max: String(max), step: String(step) },
		}) as HTMLInputElement;
		slider.value = String(initial);
		slider.addEventListener("input", () => {
			const v = Number(slider.value);
			value.setText(format(v));
			onInput(v);
		});
		if (onReset) row.appendChild(this.createResetButton(onReset));
		return row;
	}

	private createResetButton(onReset: () => void, tooltip = "恢复默认"): HTMLElement {
		const btn = document.createElement("button");
		btn.className = "unreader-appearance-reset";
		btn.setAttr("aria-label", tooltip);
		btn.title = tooltip;
		// 内置 SVG 复位图标：不依赖 Obsidian 的 lucide 注册表（移动端部分图标未注册
		// 会抛错回退到不可见的 unicode），保证全平台都能看到图标
		btn.appendChild(createInlineIcon("rotate-ccw"));
		btn.addEventListener("click", e => {
			e.preventDefault();
			e.stopPropagation();
			onReset();
		});
		return btn;
	}

	private buildPresetRow(): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row unreader-appearance-preset-row";
		row.createSpan({ cls: "unreader-appearance-label", text: "预设" });
		const control = row.createDiv({ cls: "unreader-appearance-control unreader-appearance-preset-control" });
		const presets = this.getPresets();
		const select = control.createEl("select", { cls: "dropdown unreader-appearance-preset-select" }) as HTMLSelectElement;
		select.createEl("option", { value: "", text: presets.length ? "选择预设…" : "暂无预设" });
		for (const p of presets) select.createEl("option", { value: p.id, text: p.name });
		// 回显当前生效预设名；无生效预设（手动调整）时停在占位符
		if (this.activePresetId && presets.some(p => p.id === this.activePresetId)) {
			select.value = this.activePresetId;
		}
		select.addEventListener("change", () => {
			const id = select.value;
			if (!id) return;
			this.onApplyPreset(id);
			// 应用后回填预设名并重绘数值行；render 重建预设行时会按 activePresetId 回显
			this.activePresetId = id;
			const preset = presets.find(pp => pp.id === id);
			if (preset) {
				this.current = Object.assign({}, DEFAULT_APPEARANCE, preset.appearance);
				this.render();
			}
		});
		const iconBtn = (icon: string, title: string, onClick: () => void): HTMLButtonElement => {
			const btn = document.createElement("button");
			btn.className = "unreader-appearance-reset";
			btn.title = title;
			btn.setAttr("aria-label", title);
			btn.appendChild(createInlineIcon(icon));
			btn.addEventListener("click", e => {
				e.preventDefault();
				e.stopPropagation();
				onClick();
			});
			return btn;
		};
		const requireSelected = (): string | null => {
			const id = select.value;
			if (!id) {
				new Notice("请先在下拉框选择一个预设");
				return null;
			}
			return id;
		};
		// 保存：下拉框选中预设 → 用当前外观更新该预设；未选中 → 存为新预设（命名由宿主弹窗处理）。
		// 图标按钮，不占文字宽度
		const saveBtn = iconBtn("save", "已选中预设时更新该预设，未选中时存为新预设", () => {
			const id = select.value;
			if (id) this.onUpdatePreset(id);
			else this.onSavePreset();
		});
		control.appendChild(saveBtn);
		// 重命名选中预设（命名由宿主弹窗处理）
		control.appendChild(iconBtn("pencil", "重命名选中预设", () => {
			const id = requireSelected();
			if (!id) return;
			this.onRenamePreset(id);
		}));
		// 删除选中预设
		control.appendChild(iconBtn("trash", "删除选中预设", () => {
			const id = requireSelected();
			if (!id) return;
			this.onDeletePreset(id);
		}));
		return row;
	}

	private buildBackgroundImageRow(
		field: "backgroundImage" | "backgroundImageLight" | "backgroundImageDark",
		label: string,
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label", text: label });
		const control = row.createDiv({ cls: "unreader-appearance-control" });
		const text = control.createEl("input", {
			type: "text",
			cls: "unreader-appearance-color-text",
			attr: { spellcheck: "false", placeholder: "图片 URL / data URI（手动输入）" },
		}) as HTMLInputElement;
		const raw = ((this.current as unknown as Record<string, unknown>)[field] as string | null) ?? "";
		// 显示名字而非原始引用（data URI 太长、路径无意义）；手动输入 URL 仍然支持
		const picked = this.getImageName(field);
		let display = raw;
		if (raw) {
			if (picked) display = picked;
			else if (raw.startsWith("data:image/")) display = "已设置图片";
			else if (raw.startsWith("preset:")) display = "预设内图片";
		}
		text.value = display;
		const apply = (v: string) => {
			const trimmed = v.trim();
			// 文本框显示的是名字时，未实质修改不当作新引用
			if (trimmed === display) {
				this.render();
				return;
			}
			(this.current as unknown as Record<string, unknown>)[field] = trimmed || null;
			this.emit({ [field]: trimmed || null } as Partial<AppearanceSettings>);
			this.render();
		};
		text.addEventListener("change", () => apply(text.value));
		text.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				apply(text.value);
				(text as HTMLInputElement).blur();
			}
		});
		// 「库」走库内列表弹窗，「系统」直接调系统文件选择器；
		// 两条路径统一进宿主的同一应用流程（复制进预设文件夹后引用）
		const pickBtn = control.createEl("button", { text: "库", cls: "unreader-appearance-preset-btn", attr: { title: "从库中选择图片" } });
		pickBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.onPickImage(field);
		});
		const sysBtn = control.createEl("button", { text: "系统", cls: "unreader-appearance-preset-btn", attr: { title: "从系统选择本地图片" } });
		sysBtn.addEventListener("click", e => {
			e.stopPropagation();
			this.onPickImageSystem(field);
		});
		const clearBtn = document.createElement("button");
		clearBtn.className = "unreader-appearance-reset";
		clearBtn.title = "移除背景图片";
		clearBtn.appendChild(createInlineIcon("trash"));
		clearBtn.addEventListener("click", e => {
			e.stopPropagation();
			if (!((this.current as unknown as Record<string, unknown>)[field] as string | null)) return;
			(this.current as unknown as Record<string, unknown>)[field] = null;
			this.emit({ [field]: null } as Partial<AppearanceSettings>);
			this.render();
		});
		control.appendChild(clearBtn);
		return row;
	}

	/** 分区标题行（外观面板的分组）。与此前的「读一屏不分组」相比，它要回答的是
	 *  「这一堆里哪些是同类、哪些只在某种状态下才看得出来」——见各行/各组的注释。 */
	private buildSectionRow(title: string, section?: AppearanceSection): HTMLElement {
		const el = document.createElement("div");
		// 复用面板里**已有**的分区标题类（「界面颜色」「背景图片」用的就是它）——
		// 自造一个类会让同一面板出现两种分区观感。
		el.className = "unreader-appearance-color-header";
		if (section) el.setAttr("data-appearance-section", section);
		el.setText(title);
		return el;
	}

	private buildToggleRow(
		label: string,
		checked: boolean,
		onToggle: (v: boolean) => void,
		onReset?: () => void,
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row";
		const labelEl = row.createSpan({ cls: "unreader-appearance-label", text: label });
		// label 文字较长（"自动打开目录面板"7 字 > 72px）会溢出截断 → 覆盖默认
		// 固定宽，让 label 自适应内容宽度并 flex:1 1 auto 撑开中间空白，
		// toggle 和 reset 始终被推至 row 最右紧挨；slider/select 行不受影响
		labelEl.addClass("is-label-wide");
		// 勾选框紧挨重置按钮，移动端窄屏也不会因中间控件被压扁
		const toggle = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
		toggle.checked = checked;
		toggle.className = "unreader-appearance-toggle";
		toggle.addEventListener("change", () => onToggle(toggle.checked));
		if (onReset) row.appendChild(this.createResetButton(onReset));
		return row;
	}

	private buildColorRow(
		label: string,
		initial: string,
		onInput: (v: string) => void,
		fallback: string,
		onReset?: () => void,
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "unreader-appearance-row";
		row.createSpan({ cls: "unreader-appearance-label", text: label });
		const control = row.createDiv({ cls: "unreader-appearance-control" });
		const colorInput = control.createEl("input", {
			type: "color",
			cls: "unreader-appearance-color-input",
		}) as HTMLInputElement;
		colorInput.value = normalizeHexColor(initial, fallback);
		const text = control.createEl("input", {
			type: "text",
			cls: "unreader-appearance-color-text",
			attr: { spellcheck: "false" },
		}) as HTMLInputElement;
		text.value = colorInput.value;
		text.placeholder = fallback;
		const apply = (hex: string) => {
			const normalized = normalizeHexColor(hex, fallback);
			colorInput.value = normalized;
			text.value = normalized;
			onInput(normalized);
		};
		colorInput.addEventListener("input", () => {
			text.value = colorInput.value;
			onInput(colorInput.value);
		});
		colorInput.addEventListener("change", () => {
			text.value = colorInput.value;
			onInput(colorInput.value);
		});
		text.addEventListener("change", () => apply(text.value));
		text.addEventListener("keydown", e => {
			if (e.key === "Enter") {
				e.preventDefault();
				apply(text.value);
				(text as HTMLInputElement).blur();
			}
		});
		if (onReset) row.appendChild(this.createResetButton(onReset));
		return row;
	}
}
