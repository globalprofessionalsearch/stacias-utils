import { describe, expect, it } from "vitest";
import { loadAssets, PERSPECTIVES } from "../assets.ts";
import type { Config } from "../config.ts";
import { required, resolvePerspectives } from "../coordinator.ts";
import type { Activity } from "../monitor-state.ts";
import type { Monitor } from "../monitor.ts";
import { RunLog } from "../run-log.ts";

// resolvePerspectives validates the configured list against the set of
// actually-present reviewer definitions (discovered from assets/reviewers/).

const assets = loadAssets();
const cfg = (perspectives: string[]) => ({ reviewer: { perspectives } }) as unknown as Config;

describe("resolvePerspectives", () => {
	it("honours a configured subset", () => {
		expect(resolvePerspectives(cfg(["security", "tests"]), assets)).toEqual(["security", "tests"]);
	});

	it("preserves configured order", () => {
		expect(resolvePerspectives(cfg(["tests", "correctness"]), assets)).toEqual(["tests", "correctness"]);
	});

	it("accepts the full discovered set", () => {
		const all = [...PERSPECTIVES] as string[];
		expect(resolvePerspectives(cfg(all), assets)).toEqual(all);
	});

	it("rejects an unknown perspective — no persona file exists for it", () => {
		expect(() => resolvePerspectives(cfg(["security", "vibes"]), assets)).toThrowError(/unknown perspective/);
		expect(() => resolvePerspectives(cfg(["security", "vibes"]), assets)).toThrowError(/vibes/);
	});

	it("lists the known perspectives in the error", () => {
		expect(() => resolvePerspectives(cfg(["nope"]), assets)).toThrowError(/correctness/);
	});

	it("rejects an empty list", () => {
		expect(() => resolvePerspectives(cfg([]), assets)).toThrowError(/at least one perspective/);
	});

	it("rejects a missing list", () => {
		expect(() => resolvePerspectives({ reviewer: {} } as unknown as Config, assets)).toThrowError(/at least one perspective/);
	});

	it("PERSPECTIVES is discovered from the directory, not hardcoded", () => {
		const all = [...PERSPECTIVES] as string[];
		expect(all.length).toBeGreaterThan(0);
		expect(new Set(all).size).toBe(all.length);
		// Every discovered perspective has a loaded persona
		for (const p of all) {
			expect(assets.personas.reviewers[p], `${p} has no loaded persona`).toBeTruthy();
		}
	});
});

describe("required — every agent is necessary", () => {
	const activity = (over: Partial<Activity> = {}) =>
		({ label: "security", role: "security", state: "failed", round: 2, fail: "timeout after 840s", ...over }) as Activity;

	function fakeMonitor() {
		const calls: string[] = [];
		return { calls, monitor: { cancelAll: (reason?: string) => calls.push(reason ?? "(none)") } as unknown as Monitor };
	}

	it("passes a real result straight through", () => {
		const { monitor } = fakeMonitor();
		const value = { findings: [] };
		expect(required(value, "Reviewer security", activity(), monitor)).toBe(value);
	});

	it("passes falsy-but-present results through — only null/undefined are failures", () => {
		const { monitor, calls } = fakeMonitor();
		expect(required(0, "x", activity(), monitor)).toBe(0);
		expect(required("", "x", activity(), monitor)).toBe("");
		expect(required(false, "x", activity(), monitor)).toBe(false);
		expect(calls).toEqual([]);
	});

	it("throws on null, naming the agent and the reason", () => {
		const { monitor } = fakeMonitor();
		expect(() => required(null, "Reviewer security (round 2 of 3)", activity(), monitor)).toThrowError(
			/Reviewer security \(round 2 of 3\) failed \(timeout after 840s\)/,
		);
	});

	it("throws on undefined too", () => {
		const { monitor } = fakeMonitor();
		expect(() => required(undefined, "Synthesis", activity(), monitor)).toThrow();
	});

	it("says why the run is halted, so the message is self-explaining", () => {
		const { monitor } = fakeMonitor();
		expect(() => required(null, "Verifier", activity(), monitor)).toThrowError(/every agent is required/);
	});

	it("halts siblings BEFORE unwinding, so nothing keeps spending", () => {
		const { monitor, calls } = fakeMonitor();
		expect(() => required(null, "Orienteer A", activity(), monitor)).toThrow();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("Orienteer A");
	});

	it("falls back to the activity state when there is no fail message", () => {
		const { monitor } = fakeMonitor();
		const a = activity({ fail: undefined, state: "killed" });
		expect(() => required(null, "Reviewer tests", a, monitor)).toThrowError(/killed/);
	});

	it("records the failure to the run log when one is supplied", () => {
		const { monitor } = fakeMonitor();
		const seen: Array<Record<string, unknown>> = [];
		const log = new RunLog(null, { sink: (l) => seen.push(JSON.parse(l)) });
		expect(() => required(null, "Reviewer adr", activity(), monitor, log)).toThrow();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ level: "error", event: "agent.required", agent: "security", role: "security", round: 2 });
	});

	it("works without a log (log is optional)", () => {
		const { monitor } = fakeMonitor();
		expect(() => required(null, "x", activity(), monitor, undefined)).toThrow();
	});
});
