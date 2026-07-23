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
		const project = { workflow: { maxRounds: 7 } };
		const afterUser = deepMerge(base, user);
		expect(afterUser.workflow.maxRounds).toBe(5);
		expect(afterUser.workflow.concurrency).toBe(6); // untouched, still base
		const afterProject = deepMerge(afterUser, project);
		expect(afterProject.workflow.maxRounds).toBe(7); // project beats user beats base
		expect(afterProject.workflow.concurrency).toBe(6);
	});
});

describe("loadConfig — layering and trust-gating", () => {
	it("applies base only when neither override path is given", () => {
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

	it("project override wins over user override when both paths are given", () => {
		const userPath = writeJson("user.json", { workflow: { maxRounds: 5 } });
		const projectPath = writeJson("project.json", { workflow: { maxRounds: 7 } });
		const cfg = loadConfig(userPath, projectPath);
		expect(cfg.workflow.maxRounds).toBe(7);
	});

	it("trust-gating: the SAME project file is only applied when its path is passed", () => {
		const userPath = writeJson("user.json", { workflow: { maxRounds: 5 } });
		const projectPath = writeJson("project.json", { workflow: { maxRounds: 7 } });

		// "untrusted": caller doesn't pass the project path at all.
		const untrusted = loadConfig(userPath, undefined);
		expect(untrusted.workflow.maxRounds).toBe(5);

		// "trusted": caller passes the same file's path.
		const trusted = loadConfig(userPath, projectPath);
		expect(trusted.workflow.maxRounds).toBe(7);
	});
});

describe("loadConfig — full merged config is schema-validated", () => {
	it("throws when a tunable's type is wrong (workflow.concurrency as a string), via a project override", () => {
		const projectPath = writeJson("project.json", { workflow: { concurrency: "six" } });
		expect(() => loadConfig(undefined, projectPath)).toThrowError(/concurrency/);
	});

	it("throws when a tunable's type is wrong via a user override", () => {
		const userPath = writeJson("user.json", { reconciler: { minSeams: "three" } });
		expect(() => loadConfig(userPath)).toThrowError(/minSeams/);
	});

	it("does not throw for a well-formed override", () => {
		const projectPath = writeJson("project.json", { workflow: { concurrency: 2 } });
		expect(() => loadConfig(undefined, projectPath)).not.toThrow();
	});
});

describe("loadConfig — models validation (via validateModels)", () => {
	it("throws listing every bad role when models are missing/blank/malformed", () => {
		const projectPath = writeJson("project.json", {
			models: { orienteer: "", reconciler: "no-slash-here", reviewer: "   " },
		});
		let message = "";
		try {
			loadConfig(undefined, projectPath);
			throw new Error("expected loadConfig to throw");
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("orienteer");
		expect(message).toContain("reconciler");
		expect(message).toContain("reviewer");
	});

	it("(sanity) validateModels itself throws listing all bad roles", () => {
		expect(() => validateModels({})).toThrowError(/orienteer.*reconciler.*reviewer.*synthesizer.*verifier/s);
	});
});
