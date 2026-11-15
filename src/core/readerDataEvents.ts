export type ReaderDataChange =
	| { kind: "feeds" }
	| { kind: "bookshelf" }
	| { kind: "markdown-notes" }
	| { kind: "annotations"; paths: readonly string[] };

type Listener = (change: ReaderDataChange) => void;

const listeners = new Set<Listener>();

export function subscribeReaderDataChanges(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 同步发布：调用方返回时，所有已打开阅读标签已接到同一份变更通知。 */
export function publishReaderDataChange(change: ReaderDataChange): void {
	for (const listener of [...listeners]) {
		try {
			listener(change);
		} catch (error) {
			console.error("[UNreader] reader data listener failed", change.kind, error);
		}
	}
}
