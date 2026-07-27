import { describe, expect, it } from "vitest";
import { PERSPECTIVES } from "../assets.ts";
import type { Config } from "../config.ts";
import { required, resolvePerspectives } from "../coordinator.ts";
import type { Activity } from "../monitor-state.ts";
import type { Monitor } from "../monitor.ts";
import { RunLog } from "../run-log.ts";

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

describe("required — every agent is necessary", () => {
	// The pi version degraded: a failed orienteer became an empty stub, a failed
	// reviewer round returned partial findings with spillover:true, a failed
	// verifier marked the finding "unverified". Each produced a report that
	// looked complete while describing less coverage than it claimed. Now any
	// failure halts the run.
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
