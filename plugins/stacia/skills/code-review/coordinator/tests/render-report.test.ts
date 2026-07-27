import { describe, expect, it } from "vitest";
import { esc, renderReport } from "../render-report.ts";

// report.md is rendered to HTML via marked.parse -> innerHTML. DOMPurify in
// report-template.html is the real backstop (ADR-0005) and tests/report.test.ts
// covers it; these tests cover the defence-in-depth layer, which the pi version
// applied to finding fields only and skipped everywhere else.

const XSS = '<img src=x onerror=alert(1)>';

const base = {
	verdict: "partial",
	verdict_rationale: "some goals met",
	summary: "a summary",
	consolidated_findings: [],
	seam_accounting: [],
	caveats: [],
	coverage_notes: [],
};

describe("esc", () => {
	it("escapes the three markdown-to-HTML-dangerous characters", () => {
		expect(esc("<script>")).toBe("&lt;script&gt;");
		expect(esc("a & b")).toBe("a &amp; b");
	});

	it("renders null and undefined as empty rather than the string 'null'", () => {
		expect(esc(null)).toBe("");
		expect(esc(undefined)).toBe("");
	});

	it("escapes & before < and > so entities are not double-mangled", () => {
		expect(esc("&lt;")).toBe("&amp;lt;");
	});
});

describe("renderReport — every untrusted field is escaped", () => {
	// Each case is a field the pi version interpolated raw.
	const cases: Array<[string, Record<string, unknown>]> = [
		["charge", {}],
		["verdict_rationale", { verdict_rationale: XSS }],
		["summary", { summary: XSS }],
		["caveats", { caveats: [XSS] }],
		["coverage_notes", { coverage_notes: [XSS] }],
		["follow_up_reason", { follow_up_recommended: true, follow_up_reason: XSS }],
		["seam_accounting note", { seam_accounting: [{ seam_id: 1, state: "under-explored", note: XSS }] }],
	];

	for (const [field, overrides] of cases) {
		it(`escapes ${field}`, () => {
			const charge = field === "charge" ? XSS : "a charge";
			const md = renderReport(charge, { ...base, ...overrides });
			expect(md).not.toContain("<img");
			expect(md).toContain("&lt;img");
		});
	}

	it("escapes corroborated_by, which is LLM-authored", () => {
		const md = renderReport("c", {
			...base,
			consolidated_findings: [
				{ severity: "Major", confidence: "high", corroborated_by: [XSS], location: { file: "a.ts", line: 1 }, finding: "f", rationale: "r" },
			],
		});
		expect(md).not.toContain("<img");
	});

	it("escapes finding fields and the dismissal reason", () => {
		const md = renderReport("c", {
			...base,
			consolidated_findings: [{ severity: "Blocker", confidence: "high", location: { file: XSS, line: 1 }, finding: XSS, rationale: XSS, suggestion: XSS, evidence: XSS }],
			dismissed_findings: [{ location: { file: XSS, line: 2 }, finding: XSS, dismissal_reason: XSS }],
		});
		expect(md).not.toContain("<img");
	});
});

describe("renderReport — structure", () => {
	it("puts Blockers and Majors in Top Priorities, and nothing else", () => {
		const md = renderReport("c", {
			...base,
			consolidated_findings: [
				{ severity: "Blocker", confidence: "high", location: { file: "a.ts", line: 1 }, finding: "boom", rationale: "r" },
				{ severity: "Nit", confidence: "low", location: { file: "b.ts", line: 2 }, finding: "tiny", rationale: "r" },
			],
		});
		expect(md).toContain("## Top Priorities (1)");
		const topSection = md.slice(md.indexOf("## Top Priorities"), md.indexOf("## All Findings"));
		expect(topSection).toContain("boom");
		expect(topSection).not.toContain("tiny");
	});

	it("says _None._ rather than rendering an empty section", () => {
		const md = renderReport("c", base);
		expect(md).toContain("## Top Priorities (0)");
		expect(md).toContain("_None._");
	});

	it("surfaces under-explored seams as coverage caveats", () => {
		const md = renderReport("c", { ...base, seam_accounting: [{ seam_id: 4, state: "under-explored", note: "ran out of budget" }] });
		expect(md).toContain("Seam 4 under-explored: ran out of budget");
	});

	it("omits the follow-up section unless recommended", () => {
		expect(renderReport("c", base)).not.toContain("Follow-up Recommended");
		expect(renderReport("c", { ...base, follow_up_recommended: true, follow_up_reason: "why" })).toContain("Follow-up Recommended");
	});

	it("reports verification stats when present", () => {
		const md = renderReport("c", { ...base, verification_stats: { verified: 3, confirmed: 2, corrected: 0, dismissed: 1 } });
		expect(md).toContain("3 Blocker/Major finding(s) independently checked");
		expect(md).toContain("2 confirmed");
		expect(md).toContain("1 dismissed");
	});

	it("does not report an 'unverified' count — a failed verifier halts the run", () => {
		// Every Blocker/Major in a report that exists was actually checked, so
		// there is no such thing as an unverified finding any more.
		const md = renderReport("c", { ...base, verification_stats: { verified: 2, confirmed: 2, corrected: 0, dismissed: 0 } });
		expect(md).not.toContain("unverified");
	});

	it("tolerates a synthesis missing every optional field", () => {
		expect(() => renderReport("c", {})).not.toThrow();
	});
});
