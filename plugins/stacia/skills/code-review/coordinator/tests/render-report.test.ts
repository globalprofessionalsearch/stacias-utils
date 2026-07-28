import { describe, expect, it } from "vitest";
import { buildReport } from "../render-report.ts";

const synthesis = {
	verdict: "partial",
	verdict_rationale: "some goals met",
	summary: "a summary",
	consolidated_findings: [
		{ severity: "Blocker", confidence: "high", location: { file: "a.ts", line: 1 }, finding: "boom", rationale: "r", verification: "confirmed" },
		{ severity: "Nit", confidence: "low", location: { file: "b.ts", line: 2 }, finding: "tiny", rationale: "r" },
	],
	dismissed_findings: [{ severity: "Major", location: { file: "c.ts", line: 3 }, finding: "f", dismissal_reason: "false positive" }],
	seam_accounting: [{ seam_id: 1, state: "cleared" }, { seam_id: 2, state: "under-explored", note: "ran out" }],
	follow_up_recommended: true,
	follow_up_reason: "two Blockers",
	caveats: ["seam 2 under-explored"],
	coverage_notes: ["reviewer tests: timeout"],
	verification_stats: { verified: 1, confirmed: 1, corrected: 0, dismissed: 1 },
};

const repos = [
	{ repo: "api", slug: "api", source: "pr:412", path: "/code/api" },
	{ repo: "infra", slug: "infra", source: "worktree:staged", path: "/code/infra" },
];

describe("buildReport", () => {
	it("carries every field the schema requires", () => {
		const r = buildReport({ charge: "adds retry", repos, synthesis, runDir: "/runs/abc" });
		expect(r.version).toBe(1);
		expect(r.charge).toBe("adds retry");
		expect(typeof r.generatedAt).toBe("string");
		expect(r.runDir).toBe("/runs/abc");
		expect(r.verdict).toBe("partial");
		expect(r.verdict_rationale).toBe("some goals met");
		expect(r.summary).toBe("a summary");
		expect(r.consolidated_findings).toHaveLength(2);
		expect(r.dismissed_findings).toHaveLength(1);
		expect(r.seam_accounting).toHaveLength(2);
		expect(r.follow_up_recommended).toBe(true);
		expect(r.follow_up_reason).toBe("two Blockers");
		expect(r.caveats).toEqual(["seam 2 under-explored"]);
		expect(r.coverage_notes).toEqual(["reviewer tests: timeout"]);
		expect(r.verification_stats.confirmed).toBe(1);
	});

	it("carries repo metadata for the viewer", () => {
		const r = buildReport({ charge: "c", repos, synthesis, runDir: "/runs/abc" });
		expect(r.repos).toHaveLength(2);
		expect(r.repos[0]).toMatchObject({ repo: "api", slug: "api", source: "pr:412" });
	});

	it("tolerates a synthesis missing every optional field", () => {
		const r = buildReport({ charge: "c", repos: [], synthesis: { verdict: "met", verdict_rationale: "all good", summary: "ok", consolidated_findings: [], seam_accounting: [], follow_up_recommended: false, caveats: [] }, runDir: "/r" });
		expect(r.consolidated_findings).toEqual([]);
		expect(r.dismissed_findings).toEqual([]);
	});

	it("is JSON-serialisable — it is written to disk verbatim", () => {
		const r = buildReport({ charge: "c", repos, synthesis, runDir: "/r" });
		expect(JSON.parse(JSON.stringify(r))).toEqual(r);
	});
});
