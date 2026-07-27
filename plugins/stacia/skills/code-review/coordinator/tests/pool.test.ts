import { describe, expect, it } from "vitest";
import { pool } from "../pool.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pool", () => {
	it("preserves input order despite out-of-order completion", async () => {
		// later items finish first; results must still align to input index
		const delays = [40, 5, 25, 1];
		const out = await pool(delays, 4, async (d, i) => {
			await tick(d);
			return `${i}:${d}`;
		});
		expect(out).toEqual(["0:40", "1:5", "2:25", "3:1"]);
	});

	it("never exceeds the concurrency cap", async () => {
		// Deterministic instead of wall-clock: each task blocks on its own
		// manually-resolved deferred promise, so we control exactly when work
		// completes and can assert the in-flight count without timing races.
		const pending: Array<() => void> = [];
		let inFlight = 0;
		let peak = 0;

		const waitForPending = (n: number) =>
			new Promise<void>((resolve) => {
				const check = () => (pending.length >= n ? resolve() : setImmediate(check));
				check();
			});

		const donePromise = pool([...Array(10).keys()], 3, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise<void>((resolve) => pending.push(resolve));
			inFlight--;
			return null;
		});
		let finished = false;
		donePromise.then(() => {
			finished = true;
		});

		// Let the pool fill up to the concurrency cap before releasing anything —
		// proves the workers really run in parallel, not sequentially.
		await waitForPending(3);
		expect(peak).toBe(3);

		// Drain: release everything currently waiting, then wait for either more
		// work to queue up behind it or the pool to finish, repeating until done.
		while (!finished) {
			const batch = pending.splice(0, pending.length);
			for (const resolve of batch) resolve();
			await Promise.race([waitForPending(1), donePromise.then(() => {})]);
		}

		await donePromise;
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1); // actually ran in parallel
	});

	it("handles empty input", async () => {
		expect(await pool([], 4, async () => 1)).toEqual([]);
	});

	it("handles concurrency greater than length", async () => {
		const out = await pool([1, 2], 8, async (n) => n * 2);
		expect(out).toEqual([2, 4]);
	});

	it("runs every item exactly once", async () => {
		const seen = new Set<number>();
		await pool([...Array(20).keys()], 5, async (n) => {
			seen.add(n);
			return n;
		});
		expect(seen.size).toBe(20);
	});
});

describe("pool — fail-fast", () => {
	// Every agent in a review is necessary, so once one fails there is nothing
	// to gain from starting work whose result will be thrown away.

	it("rethrows the failure", async () => {
		await expect(pool([1, 2, 3], 1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
	});

	it("stops scheduling further items after a failure", async () => {
		const started: number[] = [];
		await expect(
			pool([0, 1, 2, 3, 4, 5], 1, async (n) => {
				started.push(n);
				if (n === 1) throw new Error("boom");
				return n;
			}),
		).rejects.toThrow("boom");
		// Serial pool: 0 ran, 1 threw, nothing after should have been picked up.
		expect(started).toEqual([0, 1]);
	});

	it("reports the FIRST failure, not a later one from the cancellation cascade", async () => {
		// Mirrors the real shape: one agent times out, siblings then abort. The
		// cause is the first error; surfacing an abort instead would bury it.
		const err = await pool([0, 1], 2, async (n) => {
			if (n === 0) throw new Error("root cause");
			await tick(20);
			throw new Error("aborted because a sibling failed");
		}).catch((e) => e as Error);
		expect(err.message).toBe("root cause");
	});

	it("waits for in-flight siblings to settle before unwinding", async () => {
		// The coordinator aborts siblings via monitor.cancelAll(); pool must not
		// resolve before those aborts have actually landed.
		let settled = false;
		await expect(
			pool([0, 1], 2, async (n) => {
				if (n === 0) throw new Error("boom");
				await tick(30);
				settled = true;
				return n;
			}),
		).rejects.toThrow("boom");
		expect(settled).toBe(true);
	});

	it("still returns results normally when nothing throws", async () => {
		expect(await pool([1, 2, 3], 2, async (n) => n * 2)).toEqual([2, 4, 6]);
	});

	it("propagates a non-Error rejection unchanged", async () => {
		await expect(pool([1], 1, async () => Promise.reject("plain string"))).rejects.toBe("plain string");
	});
});
