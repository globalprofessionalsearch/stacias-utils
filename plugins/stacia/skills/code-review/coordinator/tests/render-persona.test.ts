import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets, PERSPECTIVES } from "../assets.ts";
import { type ReviewerPersona, renderReviewerPersona } from "../render-persona.ts";
import { validate } from "../validate.ts";

const REVIEWERS_DIR = path.resolve(__dirname, "../assets/reviewers");
const SCHEMA_PATH = path.resolve(__dirname, "../assets/schemas/reviewer-persona.schema.json");
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

function loadPersona(perspective: string): ReviewerPersona {
	return JSON.parse(fs.readFileSync(path.join(REVIEWERS_DIR, `${perspective}.json`), "utf8"));
}

// loadAssets populates PERSPECTIVES from the directory scan.
loadAssets();

describe("reviewer persona definitions", () => {
	for (const p of PERSPECTIVES) {
		describe(p, () => {
			it("exists as a JSON file", () => {
				expect(fs.existsSync(path.join(REVIEWERS_DIR, `${p}.json`))).toBe(true);
			});

			it("validates against reviewer-persona.schema.json", () => {
				const persona = loadPersona(p as string);
				const errs = validate(persona, schema);
				expect(errs, `${p} failed validation: ${errs.join("; ")}`).toEqual([]);
			});

			it("has perspective matching the filename", () => {
				expect(loadPersona(p as string).perspective).toBe(p);
			});

			it("has all four severity levels defined", () => {
				const persona = loadPersona(p as string);
				for (const sev of ["Blocker", "Major", "Minor", "Nit"]) {
					expect(persona.severity[sev as keyof typeof persona.severity], `${p} missing severity.${sev}`).toBeTruthy();
				}
			});

			it("has at least one focus area", () => {
				expect(loadPersona(p as string).focus.length).toBeGreaterThan(0);
			});
		});
	}
});

describe("renderReviewerPersona", () => {
	const persona: ReviewerPersona = {
		perspective: "correctness",
		role: "Find bugs.",
		focus: [{ area: "Logic", details: "Off-by-one." }],
		severity: { Blocker: "Crash.", Major: "Wrong result.", Minor: "Edge case.", Nit: "Style." },
		method: "Trace paths.",
		rationale_instruction: "Say why.",
		suggestion_instruction: "Say how.",
	};

	it("produces a string containing the perspective", () => {
		expect(renderReviewerPersona(persona)).toContain("correctness");
	});

	it("includes the severity calibration section", () => {
		const rendered = renderReviewerPersona(persona);
		expect(rendered).toContain("## Severity calibration");
		expect(rendered).toContain("**Blocker**: Crash.");
		expect(rendered).toContain("**Nit**: Style.");
	});

	it("includes focus areas", () => {
		const rendered = renderReviewerPersona(persona);
		expect(rendered).toContain("**Logic**: Off-by-one.");
	});

	it("includes rationale and suggestion instructions", () => {
		const rendered = renderReviewerPersona(persona);
		expect(rendered).toContain("`rationale` Say why");
		expect(rendered).toContain("`suggestion` (optional) Say how");
	});

	it("includes extra_context when present", () => {
		const withContext = { ...persona, extra_context: "ADR bodies are not inlined." };
		expect(renderReviewerPersona(withContext)).toContain("ADR bodies are not inlined.");
	});

	it("omits extra_context section when absent", () => {
		expect(renderReviewerPersona(persona)).not.toContain("ADR bodies");
	});
});
