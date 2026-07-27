import { describe, expect, it } from "vitest";
import { modelFor, ROLES, validateModels } from "../models.ts";

// The SDK takes a bare model id, so there is no runtime to fake here — the
// pi-era resolveModel/ModelRuntime.getModel indirection is gone entirely.

const ALL_VALID_MODELS: Record<string, string> = {
	orienteer: "claude-sonnet-5",
	reconciler: "claude-sonnet-5",
	reviewer: "claude-sonnet-5",
	synthesizer: "claude-opus-4-8",
	verifier: "claude-sonnet-5",
};

describe("modelFor", () => {
	it("returns the configured id for a role", () => {
		expect(modelFor("reviewer", ALL_VALID_MODELS)).toBe("claude-sonnet-5");
		expect(modelFor("synthesizer", ALL_VALID_MODELS)).toBe("claude-opus-4-8");
	});
});

describe("validateModels", () => {
	it("passes when every role names a model", () => {
		expect(() => validateModels(ALL_VALID_MODELS)).not.toThrow();
	});

	it("throws listing every offending role: unset and blank", () => {
		const models = {
			orienteer: undefined, // unset
			reconciler: "   ", // blank
			reviewer: "", // empty
			synthesizer: "claude-opus-4-8", // fine
			verifier: "claude-sonnet-5", // fine
		};
		let message = "";
		try {
			validateModels(models as Record<string, unknown>);
			throw new Error("expected validateModels to throw");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("orienteer");
		expect(message).toContain("reconciler");
		expect(message).toContain("reviewer");
		expect(message).not.toContain("synthesizer=");
		expect(message).not.toContain("verifier=");
	});

	it("rejects the retired pi provider/id format with a migration hint", () => {
		const models = { ...ALL_VALID_MODELS, reviewer: "anthropic/claude-sonnet-5" };
		expect(() => validateModels(models)).toThrowError(/retired pi format/);
		expect(() => validateModels(models)).toThrowError(/reviewer/);
	});

	it("reports every legacy-format role at once", () => {
		const models = {
			...ALL_VALID_MODELS,
			reviewer: "anthropic/claude-sonnet-5",
			verifier: "anthropic/claude-sonnet-5",
		};
		let message = "";
		try {
			validateModels(models);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("reviewer");
		expect(message).toContain("verifier");
	});

	it("covers ROLES exhaustively (sanity for the fixture list above)", () => {
		expect(ROLES).toEqual(["orienteer", "reconciler", "reviewer", "synthesizer", "verifier"]);
	});
});
