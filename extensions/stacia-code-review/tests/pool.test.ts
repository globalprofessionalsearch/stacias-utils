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
		let inFlight = 0;
		let peak = 0;
		await pool([...Array(10).keys()], 3, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await tick(5);
			inFlight--;
			return null;
		});
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
