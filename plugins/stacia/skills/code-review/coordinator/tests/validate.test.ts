import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { injectBounds, validate } from "../validate.ts";

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "schemas");
const loadSchema = (name: string) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf8"));
const SCHEMA_FILES = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"));

const orientation = {
	type: "object",
	required: ["model", "clear_alignment", "unclear_alignment"],
	properties: {
		model: { type: "string" },
		clear_alignment: {
			type: "array",
			items: {
				type: "object",
				required: ["region", "line"],
				properties: { region: { type: "string" }, line: { type: "integer" } },
			},
		},
		unclear_alignment: { type: "array", items: { type: "object" } },
	},
};

const reviewer = {
	type: "object",
	required: ["perspective", "findings"],
	properties: {
		perspective: { type: "string", enum: ["correctness", "security"] },
		findings: { type: "array", items: { type: "object" } },
	},
};

describe("validate", () => {
	it("passes a conforming object", () => {
		expect(validate({ model: "m", clear_alignment: [], unclear_alignment: [] }, orientation)).toEqual([]);
	});

	it("reports every missing required key", () => {
		const errs = validate({ clear_alignment: [] }, orientation);
		expect(errs).toContain('$: missing required "model"');
		expect(errs).toContain('$: missing required "unclear_alignment"');
	});

	it("catches a wrong scalar type", () => {
		const errs = validate({ model: 42, clear_alignment: [], unclear_alignment: [] }, orientation);
		expect(errs.some((e) => e.includes("$.model") && e.includes("string"))).toBe(true);
	});

	it("catches an enum miss with a precise path", () => {
		const errs = validate({ perspective: "wat", findings: [] }, reviewer);
		expect(errs).toContain('$.perspective: "wat" not in [correctness, security]');
	});

	it("distinguishes integer from number", () => {
		const errs = validate(
			{ model: "m", clear_alignment: [{ region: "r", line: 1.5 }], unclear_alignment: [] },
			orientation,
		);
		expect(errs.some((e) => e.includes("clear_alignment[0].line") && e.includes("integer"))).toBe(true);
	});

	it("recurses into array items", () => {
		const errs = validate(
			{ model: "m", clear_alignment: [{ line: 1 }], unclear_alignment: [] },
			orientation,
		);
		expect(errs.some((e) => e.includes("clear_alignment[0]") && e.includes("region"))).toBe(true);
	});

	it("enforces minItems / maxItems", () => {
		const bounded = { type: "array", minItems: 3, maxItems: 5, items: { type: "integer" } };
		expect(validate([1, 2], bounded).some((e) => e.includes("≥ 3"))).toBe(true);
		expect(validate([1, 2, 3, 4, 5, 6], bounded).some((e) => e.includes("≤ 5"))).toBe(true);
		expect(validate([1, 2, 3], bounded)).toEqual([]);
	});

	it("ignores unmodeled keywords (documented subset: additionalProperties unenforced)", () => {
		const s = { type: "object", properties: { a: { type: "string" } } };
		expect(validate({ a: "x", extra: 1 }, s)).toEqual([]);
	});
});

const DEFAULT_CFG = { reconciler: { minSeams: 3, maxSeams: 12 }, reviewer: { maxFindings: 6 } };

// biome-ignore lint/suspicious/noExplicitAny: bare schema fixtures
const bareSchemas = (): any => ({
	seamMap: { properties: { seams: { type: "array", items: {} } } },
	reviewer: { properties: { findings: { type: "array", items: {} } } },
});

describe("injectBounds", () => {
	it("mutates seam and finding bounds to config values", () => {
		const schemas = bareSchemas();
		injectBounds(schemas, DEFAULT_CFG);
		expect(schemas.seamMap.properties.seams.minItems).toBe(3);
		expect(schemas.seamMap.properties.seams.maxItems).toBe(12);
		expect(schemas.reviewer.properties.findings.maxItems).toBe(6);
	});

	it("states each bound in the description as well as the keywords", () => {
		const schemas = bareSchemas();
		injectBounds(schemas, DEFAULT_CFG);
		expect(schemas.seamMap.properties.seams.description).toBe("Return between 3 and 12 items.");
		expect(schemas.reviewer.properties.findings.description).toBe("Return at most 6 items.");
	});

	it("appends the bound after an existing description, preserving it", () => {
		const schemas = bareSchemas();
		schemas.seamMap.properties.seams.description = "Priority-ranked list of seams.";
		injectBounds(schemas, DEFAULT_CFG);
		expect(schemas.seamMap.properties.seams.description).toBe(
			"Priority-ranked list of seams. Return between 3 and 12 items.",
		);
	});

	it("is idempotent — re-running does not stack sentences", () => {
		const schemas = bareSchemas();
		schemas.seamMap.properties.seams.description = "Priority-ranked list of seams.";
		injectBounds(schemas, DEFAULT_CFG);
		injectBounds(schemas, DEFAULT_CFG);
		injectBounds(schemas, DEFAULT_CFG);
		expect(schemas.seamMap.properties.seams.description).toBe(
			"Priority-ranked list of seams. Return between 3 and 12 items.",
		);
	});

	it("replaces a stale bound when config changes", () => {
		const schemas = bareSchemas();
		schemas.seamMap.properties.seams.description = "Priority-ranked list of seams.";
		injectBounds(schemas, DEFAULT_CFG);
		injectBounds(schemas, { reconciler: { minSeams: 2, maxSeams: 8 }, reviewer: { maxFindings: 4 } });
		expect(schemas.seamMap.properties.seams.description).toBe(
			"Priority-ranked list of seams. Return between 2 and 8 items.",
		);
		expect(schemas.seamMap.properties.seams.minItems).toBe(2);
		expect(schemas.reviewer.properties.findings.description).toBe("Return at most 4 items.");
	});

	it("collapses to 'exactly' when the floor and the cap coincide", () => {
		const schemas = bareSchemas();
		injectBounds(schemas, { reconciler: { minSeams: 5, maxSeams: 5 }, reviewer: { maxFindings: 6 } });
		expect(schemas.seamMap.properties.seams.description).toBe("Return exactly 5 items.");
	});

	it("tolerates schemas that lack the bounded properties", () => {
		const schemas = { seamMap: { properties: {} }, reviewer: {} };
		expect(() => injectBounds(schemas, DEFAULT_CFG)).not.toThrow();
	});
});

describe("shipped schemas", () => {
	// The SDK validates schemas with JSON Schema draft-07; a schema declaring a
	// newer draft is rejected and fails the run at startup.
	it.each(SCHEMA_FILES)("%s declares draft-07", (file) => {
		expect(loadSchema(file).$schema).toBe("http://json-schema.org/draft-07/schema#");
	});

	// `additionalProperties` is not required — the SDK's strict-schema derivation
	// sets it to false itself. But if one is ever written by hand it must be
	// `false`; any other value makes the whole schema strict-incompatible.
	it.each(SCHEMA_FILES)("%s never sets additionalProperties to anything but false", (file) => {
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (typeof node !== "object" || node === null) return;
			const obj = node as Record<string, unknown>;
			if ("additionalProperties" in obj) expect(obj.additionalProperties).toBe(false);
			Object.values(obj).forEach(walk);
		};
		walk(loadSchema(file));
	});

	// The bounds are a product requirement, so assert them end-to-end against the
	// real shipped schemas rather than fixtures: config in, enforcement out.
	it("bounds the real seam map, and validate() enforces what was injected", () => {
		const schemas = { seamMap: loadSchema("seam-map.schema.json"), reviewer: loadSchema("reviewer-output.schema.json") };
		injectBounds(schemas, DEFAULT_CFG);

		const seams = schemas.seamMap.properties.seams;
		expect(seams.minItems).toBe(3);
		expect(seams.maxItems).toBe(12);
		expect(seams.description).toMatch(/Return between 3 and 12 items\.$/);
		expect(seams.description).toContain("Priority-ranked list of seams");

		const seam = (id: number) => ({
			id,
			priority: "high",
			type: "unclear",
			region: "r",
			files: [{ file: "a.ts", line: 1 }],
			rationale: "why",
		});
		const payload = (n: number) => ({
			merged_orientation: "m",
			seams: Array.from({ length: n }, (_, i) => seam(i + 1)),
		});

		expect(validate(payload(2), schemas.seamMap).some((e) => e.includes("≥ 3"))).toBe(true);
		expect(validate(payload(13), schemas.seamMap).some((e) => e.includes("≤ 12"))).toBe(true);
		expect(validate(payload(3), schemas.seamMap)).toEqual([]);
		expect(validate(payload(12), schemas.seamMap)).toEqual([]);
	});

	it("caps findings on the real reviewer schema", () => {
		const schemas = { seamMap: loadSchema("seam-map.schema.json"), reviewer: loadSchema("reviewer-output.schema.json") };
		injectBounds(schemas, DEFAULT_CFG);

		const findings = schemas.reviewer.properties.findings;
		expect(findings.maxItems).toBe(6);
		expect(findings.description).toMatch(/Return at most 6 items\.$/);

		const finding = {
			severity: "Major",
			confidence: "high",
			location: { file: "a.ts", line: 1 },
			evidence: "e",
			finding: "f",
			rationale: "r",
		};
		const payload = (n: number) => ({
			perspective: "correctness",
			findings: Array.from({ length: n }, () => finding),
			spillover: false,
			moreExploration: false,
		});

		expect(validate(payload(7), schemas.reviewer).some((e) => e.includes("≤ 6"))).toBe(true);
		expect(validate(payload(6), schemas.reviewer)).toEqual([]);
	});

	// Cleanup #5: the cap belongs to config, so no description may hardcode it.
	it("no description hardcodes a findings cap", () => {
		const text = fs.readFileSync(path.join(SCHEMA_DIR, "reviewer-output.schema.json"), "utf8");
		expect(text).not.toMatch(/beyond the \d+ reported/);
		expect(text).not.toMatch(/injects (?:minItems\/maxItems|maxItems) from config/);
	});
});
