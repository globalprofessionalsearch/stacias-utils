import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepMerge, loadConfig } from "../config.ts";
import { validateModels } from "../models.ts";

// These tests exercise loadConfig's own merge/validate logic. They never
// assert on the SHIPPED assets/config.json's values (models ids, etc.) — only
// on tmp override files this suite controls, layered on top of whatever base
// ships. The base is always valid, so any thrown error in these tests comes
// from the tmp override under test.

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-config-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(name: string, data: unknown): string {
	const p = path.join(tmpDir, name);
	fs.writeFileSync(p, JSON.stringify(data), "utf8");
	return p;
}

describe("deepMerge", () => {
	it("overrides scalars and preserves untouched sibling keys", () => {
		const base = { a: 1, b: { x: 1, y: 2 } };
		const override = { b: { x: 9 } };
		expect(deepMerge(base, override)).toEqual({ a: 1, b: { x: 9, y: 2 } });
	});

	it("recurses arbitrarily deep, only replacing leaves the override touches", () => {
		const base = { a: { b: { c: 1, d: 2 }, e: 3 } };
		const override = { a: { b: { c: 99 } } };
		expect(deepMerge(base, override)).toEqual({ a: { b: { c: 99, d: 2 }, e: 3 } });
	});

	it("replaces (does not merge) arrays and non-object overrides", () => {
		const base = { list: [1, 2, 3], n: 1 };
		expect(deepMerge(base, { list: [9] })).toEqual({ list: [9], n: 1 });
		expect(deepMerge(base, { n: "x" })).toEqual({ list: [1, 2, 3], n: "x" });
	});

	it("layers left-to-right: later merges win over earlier ones", () => {
		const base = { workflow: { maxRounds: 3, concurrency: 6 } };
		const user = { workflow: { maxRounds: 5 } };
		const afterUser = deepMerge(base, user);
		expect(afterUser.workflow.maxRounds).toBe(5);
		expect(afterUser.workflow.concurrency).toBe(6); // untouched, still base
	});
});

describe("loadConfig — layering", () => {
	it("applies base only when no override path is given", () => {
		const cfg = loadConfig();
		expect(cfg.workflow).toBeTruthy();
		expect(cfg.models).toBeTruthy();
	});

	it("applies the user override when userConfigPath is given and exists", () => {
		const userPath = writeJson("user.json", { workflow: { maxRounds: 5 } });
		const cfg = loadConfig(userPath);
		expect(cfg.workflow.maxRounds).toBe(5);
	});

	it("ignores a userConfigPath that doesn't exist", () => {
		const missing = path.join(tmpDir, "nope.json");
		const base = loadConfig();
		const cfg = loadConfig(missing);
		expect(cfg.workflow.maxRounds).toBe(base.workflow.maxRounds);
	});

	it("ignores an unparseable override rather than throwing", () => {
		const bad = path.join(tmpDir, "bad.json");
		fs.writeFileSync(bad, "{ not json", "utf8");
		const base = loadConfig();
		expect(loadConfig(bad).workflow.maxRounds).toBe(base.workflow.maxRounds);
	});

	// ADR-0006: there is no project-level layer. loadConfig takes exactly one
	// override path, so a file in the reviewed checkout has no way in.
	it("accepts only one override path — there is no project layer", () => {
		expect(loadConfig.length).toBe(1);
	});
});

describe("loadConfig — full merged config is schema-validated", () => {
	it("throws when a tunable's type is wrong (workflow.concurrency as a string)", () => {
		const userPath = writeJson("user.json", { workflow: { concurrency: "six" } });
		expect(() => loadConfig(userPath)).toThrowError(/concurrency/);
	});

	it("throws when a tunable's type is wrong (reconciler.minSeams as a string)", () => {
		const userPath = writeJson("user.json", { reconciler: { minSeams: "three" } });
		expect(() => loadConfig(userPath)).toThrowError(/minSeams/);
	});

	it("does not throw for a well-formed override", () => {
		const userPath = writeJson("user.json", { workflow: { concurrency: 2 } });
		expect(() => loadConfig(userPath)).not.toThrow();
	});
});

describe("loadConfig — models validation (via validateModels)", () => {
	it("throws listing every bad role when models are missing or blank", () => {
		const userPath = writeJson("user.json", {
			models: { orienteer: "", reconciler: "   ", reviewer: "   " },
		});
		let message = "";
		try {
			loadConfig(userPath);
			throw new Error("expected loadConfig to throw");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("orienteer");
		expect(message).toContain("reconciler");
		expect(message).toContain("reviewer");
	});

	it("rejects a stale pi-format provider/id override", () => {
		const userPath = writeJson("user.json", { models: { reviewer: "anthropic/claude-sonnet-5" } });
		expect(() => loadConfig(userPath)).toThrowError(/retired pi format/);
	});

	it("(sanity) validateModels itself throws listing all bad roles", () => {
		expect(() => validateModels({})).toThrowError(/orienteer.*reconciler.*reviewer.*synthesizer.*verifier/s);
	});
});

describe("shipped defaults", () => {
	// Deliberately narrow: asserts the SHAPE contract the port changed, not the
	// tuning values (which are expected to drift as models are superseded).
	it("ship bare model ids, not the retired provider/id form", () => {
		const cfg = loadConfig();
		for (const [role, id] of Object.entries(cfg.models)) {
			expect(id, `models.${role}`).not.toContain("/");
		}
	});

	it("no longer carries the dead workflow.agentRetries knob", () => {
		expect(loadConfig().workflow).not.toHaveProperty("agentRetries");
	});
});
