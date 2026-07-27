import { describe, expect, it } from "vitest";
import { timeoutFor, validateTimeouts } from "../timeouts.ts";

const ALL_VALID: Record<string, number> = {
	orienteer: 180000,
	reconciler: 180000,
	reviewer: 420000,
	synthesizer: 240000,
	verifier: 60000,
};

describe("timeoutFor", () => {
	it("returns the configured budget for a role", () => {
		expect(timeoutFor("reviewer", ALL_VALID)).toBe(420000);
		expect(timeoutFor("verifier", ALL_VALID)).toBe(60000);
	});

	// The bug this replaces: one `roundTimeoutMs` knob drove every role through a
	// `* 3` multiplier, so tuning reviewers silently retuned verifiers.
	it("gives each role an independent budget", () => {
		const bumped = { ...ALL_VALID, reviewer: 600000 };
		expect(timeoutFor("reviewer", bumped)).toBe(600000);
		expect(timeoutFor("verifier", bumped)).toBe(ALL_VALID.verifier);
		expect(timeoutFor("orienteer", bumped)).toBe(ALL_VALID.orienteer);
	});
});

describe("validateTimeouts", () => {
	it("passes when every role names a budget", () => {
		expect(() => validateTimeouts(ALL_VALID)).not.toThrow();
	});

	it("throws listing every role that is unset", () => {
		const { reviewer, verifier, ...rest } = ALL_VALID;
		expect(() => validateTimeouts(rest)).toThrow(/reviewer=\(unset\)[\s\S]*verifier=\(unset\)|verifier=\(unset\)[\s\S]*reviewer=\(unset\)/);
	});

	it("rejects non-positive and non-integer budgets", () => {
		expect(() => validateTimeouts({ ...ALL_VALID, reviewer: 0 })).toThrow(/reviewer/);
		expect(() => validateTimeouts({ ...ALL_VALID, reviewer: -1 })).toThrow(/reviewer/);
		expect(() => validateTimeouts({ ...ALL_VALID, reviewer: 1.5 })).toThrow(/reviewer/);
		expect(() => validateTimeouts({ ...ALL_VALID, reviewer: "420000" })).toThrow(/reviewer/);
	});

	it("rejects the retired workflow.roundTimeoutMs with a migration hint", () => {
		expect(() => validateTimeouts(ALL_VALID, { roundTimeoutMs: 60000 })).toThrow(/roundTimeoutMs/);
		expect(() => validateTimeouts(ALL_VALID, { roundTimeoutMs: 60000 })).toThrow(/config\.timeouts/);
	});
});
