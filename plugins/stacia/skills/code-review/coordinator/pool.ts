/**
 * Concurrency-capped map. Preserves input order in the result array.
 *
 * Fails fast: if any `fn` rejects, no further items are scheduled and the
 * first rejection is rethrown once the in-flight workers have settled. Every
 * agent in a review is necessary, so there is nothing to be gained by starting
 * work whose result will be discarded.
 *
 * Note this stops *scheduling*, it does not by itself interrupt work already
 * running — aborting those is the caller's job (the coordinator calls
 * `monitor.cancelAll()`, which aborts each in-flight agent's AbortController).
 * We wait for them via `allSettled` so their aborts land before we unwind.
 */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failure: unknown;
	let failed = false;

	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
		for (;;) {
			if (failed) return;
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i], i);
			} catch (err) {
				// Latch the FIRST failure: later ones are usually the cancellation
				// cascade this one caused, and reporting those would bury the cause.
				if (!failed) {
					failed = true;
					failure = err;
				}
				return;
			}
		}
	});

	await Promise.allSettled(workers);
	if (failed) throw failure;
	return results;
}
