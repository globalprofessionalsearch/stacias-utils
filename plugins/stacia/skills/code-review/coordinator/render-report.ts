/**
 * Build the report JSON object from the coordinator's synthesis output.
 *
 * This is the final, schema-validated artifact that replaces both
 * findings/synthesis.json (which was unvalidated) and report.md (which the
 * HTML template now renders from this JSON). The coordinator mutates the
 * synthesis after verification — rewriting consolidated_findings, adding
 * dismissed_findings, verification_stats and coverage_notes — so the
 * synthesis schema no longer describes the object. This schema does.
 */

// biome-ignore lint/suspicious/noExplicitAny: synthesis is schema-validated JSON
type Any = any;

export interface RepoSummary {
	repo: string;
	slug: string;
	source: string;
	path?: string;
}

export function buildReport(fields: {
	charge: string;
	repos: RepoSummary[];
	synthesis: Any;
	runDir: string;
}): Any {
	return {
		version: 1,
		charge: fields.charge,
		generatedAt: new Date().toISOString(),
		runDir: fields.runDir,
		repos: fields.repos.map((r) => ({ repo: r.repo, slug: r.slug, source: r.source, path: r.path })),
		verdict: fields.synthesis.verdict,
		verdict_rationale: fields.synthesis.verdict_rationale,
		summary: fields.synthesis.summary,
		consolidated_findings: fields.synthesis.consolidated_findings ?? [],
		dismissed_findings: fields.synthesis.dismissed_findings ?? [],
		seam_accounting: fields.synthesis.seam_accounting ?? [],
		follow_up_recommended: fields.synthesis.follow_up_recommended ?? false,
		follow_up_reason: fields.synthesis.follow_up_reason,
		caveats: fields.synthesis.caveats ?? [],
		coverage_notes: fields.synthesis.coverage_notes ?? [],
		verification_stats: fields.synthesis.verification_stats,
	};
}
