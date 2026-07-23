import { describe, expect, it } from "vitest";
import { injectBounds, validate } from "../validate.ts";

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

describe("injectBounds", () => {
	it("mutates seam and finding bounds to config values", () => {
		const schemas = {
			seamMap: { properties: { seams: { type: "array", items: {} } } },
			reviewer: { properties: { findings: { type: "array", items: {} } } },
		};
		injectBounds(schemas, { reconciler: { minSeams: 3, maxSeams: 12 }, reviewer: { maxFindings: 6 } });
		expect(schemas.seamMap.properties.seams.minItems).toBe(3);
		expect(schemas.seamMap.properties.seams.maxItems).toBe(12);
		expect(schemas.reviewer.properties.findings.maxItems).toBe(6);
	});
});
