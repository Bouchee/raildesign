export const BACKPRESSURE_RECONCILE_MS = 1_000;

export function drainedClientKeys(
	latched: Iterable<string>,
	bufferedAmount: (clientKey: string) => number | undefined,
): string[] {
	return [...latched].filter((clientKey) => bufferedAmount(clientKey) === 0);
}
