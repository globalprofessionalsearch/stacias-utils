import { describe, expect, it } from "vitest";
import { resolveModel, ROLES, validateModels } from "../models.ts";

// Fake ModelRuntime objects below only implement the shape resolveModel
// actually uses (getModel). Keeps this suite pi-free at runtime: models.ts's
// ModelRuntime import is type-only and erased, so no
// @earendil-works/pi-coding-agent value import is ever needed here.

const ALL_VALID_MODELS: Record<string, string> = {
	orienteer: "anthropic/model-a",
	reconciler: "anthropic/model-a",
	reviewer: "anthropic/model-a",
	synthesizer: "anthropic/model-b",
	verifier: "anthropic/model-a",
};

describe("resolveModel", () => {
	it("resolves provider/id via rt.getModel", () => {
		const rt = { getModel: (p: string, i: string) => ({ provider: p, id: i }) };
		const model = resolveModel("reviewer", ALL_VALID_MODELS, rt as unknown as Parameters<typeof resolveModel>[2]);
		expect(model).toEqual({ provider: "anthropic", id: "model-a" });
	});

	it("splits provider/id on the first slash only", () => {
		const models = { orienteer: "openai/o4/mini" };
		const rt = { getModel: (p: string, i: string) => ({ provider: p, id: i }) };
		const model = resolveModel("orienteer", models, rt as unknown as Parameters<typeof resolveModel>[2]);
		expect(model).toEqual({ provider: "openai", id: "o4/mini" });
	});

	it("throws when rt.getModel returns undefined (unresolvable model)", () => {
		const rt = { getModel: () => undefined };
		expect(() => resolveModel("reviewer", ALL_VALID_MODELS, rt as unknown as Parameters<typeof resolveModel>[2])).toThrowError(
			/config\.models\.reviewer.*not found/,
		);
	});
});

describe("validateModels", () => {
	it("passes when every role is an explicit provider/id", () => {
		expect(() => validateModels(ALL_VALID_MODELS)).not.toThrow();
	});

	it("throws listing every offending role: unset, blank, and no-slash", () => {
		const models = {
			orienteer: undefined, // unset
			reconciler: "   ", // blank
			reviewer: "no-slash-here", // no slash
			synthesizer: "anthropic/model-b", // fine
			verifier: "", // blank/empty
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
		expect(message).toContain("verifier");
		expect(message).not.toContain("synthesizer=");
	});

	it("covers ROLES exhaustively (sanity for the fixture list above)", () => {
		expect(ROLES).toEqual(["orienteer", "reconciler", "reviewer", "synthesizer", "verifier"]);
	});
});
