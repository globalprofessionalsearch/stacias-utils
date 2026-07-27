import { describe, expect, it } from "vitest";
import { PERSPECTIVES } from "../assets.ts";
import type { Config } from "../config.ts";
import { resolvePerspectives } from "../coordinator.ts";

// The pi version accepted reviewer.perspectives in its config schema and then
// iterated a hardcoded const instead, so narrowing the list was silently
// ignored and all six always ran. These tests pin the corrected behavior.

const cfg = (perspectives: string[]) => ({ reviewer: { perspectives } }) as unknown as Config;

describe("resolvePerspectives", () => {
	it("honours a configured subset instead of always running all six", () => {
		expect(resolvePerspectives(cfg(["security", "tests"]))).toEqual(["security", "tests"]);
	});

	it("preserves configured order", () => {
		expect(resolvePerspectives(cfg(["tests", "correctness"]))).toEqual(["tests", "correctness"]);
	});

	it("accepts the full shipped set", () => {
		const all = [...PERSPECTIVES] as string[];
		expect(resolvePerspectives(cfg(all))).toEqual(all);
	});

	it("rejects an unknown perspective rather than silently skipping it", () => {
		// There would be no persona file to load, so failing loudly at config
		// time beats a reviewer that never runs and never explains why.
		expect(() => resolvePerspectives(cfg(["security", "vibes"]))).toThrowError(/unknown perspective/);
		expect(() => resolvePerspectives(cfg(["security", "vibes"]))).toThrowError(/vibes/);
	});

	it("lists the known perspectives in the error to make the fix obvious", () => {
		expect(() => resolvePerspectives(cfg(["nope"]))).toThrowError(/correctness/);
	});

	it("rejects an empty list", () => {
		expect(() => resolvePerspectives(cfg([]))).toThrowError(/at least one perspective/);
	});

	it("rejects a missing list", () => {
		expect(() => resolvePerspectives({ reviewer: {} } as unknown as Config)).toThrowError(/at least one perspective/);
	});

	it("every shipped perspective has a persona file backing it", () => {
		// Guards the invariant resolvePerspectives relies on: the known-set comes
		// from PERSPECTIVES, and loadAssets() reads references/reviewer-<p>.md for
		// each. A new perspective added to one and not the other breaks a run.
		const all = [...PERSPECTIVES] as string[];
		expect(all.length).toBeGreaterThan(0);
		expect(new Set(all).size).toBe(all.length);
	});
});
