/** Keep a layout edge fixed while a transient chrome animation moves its DOM box. */
export function stableBoundary(current: number, cached: number | null, mayRefresh: boolean): number {
	if (!Number.isFinite(current)) return cached ?? 0;
	return mayRefresh || cached == null ? current : cached;
}
