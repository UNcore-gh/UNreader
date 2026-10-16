// Ambient declarations for the vendored foliate-js library (plain JS, no types).
declare module "*foliate-js/view.js";

declare module "*foliate-js/overlayer.js" {
	export const Overlayer: {
		highlight(rects: unknown, options?: { color?: string }): SVGElement;
		underline(rects: unknown, options?: { color?: string }): SVGElement;
		outline(rects: unknown, options?: { color?: string }): SVGElement;
	};
}

declare module "*foliate-js/footnotes.js" {
	export class FootnoteHandler extends EventTarget {
		detectFootnotes: boolean;
		handle(book: unknown, e: Event): Promise<void> | undefined;
	}
}

declare module "*foliate-js/epubcfi.js" {
	export function parse(cfi: string): unknown;
	export function collapse(cfi: string, toEnd?: boolean): string;
	export function compare(a: string, b: string): number;
	export function joinIndir(...cfis: string[]): string;
	export function fromRange(range: Range, filter?: unknown): string;
	export function toRange(doc: Document, parts: unknown, filter?: unknown): Range;
	export const fake: { fromIndex(index: number): string; toIndex(parts: unknown): number };
	export const isCFI: RegExp;
}

declare module "*foliate-js/search.js" {
	export function searchMatcher(
		textWalker: unknown,
		opts: {
			defaultLocale?: string;
			matchCase?: boolean;
			matchDiacritics?: boolean;
			matchWholeWords?: boolean;
			acceptNode?: unknown;
		},
	): (doc: Document, query: string) => Generator<{ range: Range; excerpt: { pre: string; match: string; post: string } }>;
}

declare module "*foliate-js/text-walker.js" {
	export function textWalker(
		x: Node,
		func: (strs: string[], makeRange: (startIndex: number, startOffset: number, endIndex: number, endOffset: number) => Range) => Generator<unknown, void, void>,
		filterFunc?: unknown,
	): Generator<unknown, void, void>;
}
