/**
 * Render the synthesis object into the charge-scoped report markdown.
 *
 * Everything interpolated here is either LLM-authored (verdicts, findings,
 * caveats) or user-authored (the charge), and `report.md` is later rendered to
 * HTML by `helper/report-template.html` via `marked.parse` -> `innerHTML`.
 * DOMPurify in that template is the real XSS backstop (ADR-0005); the escaping
 * here is defence in depth.
 *
 * The pi version escaped finding fields but left the charge, verdict
 * rationale, summary, caveats, coverage notes, follow-up reason and
 * corroborated_by unescaped — defence in depth with holes. Every
 * untrusted string now goes through `esc`, and `report.md` has consumers
 * beyond the HTML viewer, which is why this is worth doing properly rather
 * than leaning entirely on DOMPurify.
 */

// biome-ignore lint/suspicious/noExplicitAny: synthesis is schema-validated JSON
type Any = any;

/** HTML-escape untrusted text before it is interpolated into report markdown. */
export function esc(v: Any): string {
	return String(v ?? "").replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function findingMd(f: Any): string {
	const corroborated = Array.isArray(f.corroborated_by) && f.corroborated_by.length ? ` — corroborated by ${f.corroborated_by.map(esc).join(", ")}` : "";
	const verification = f.verification ? `, ${esc(f.verification)}` : "";
	return (
		`- **${esc(f.severity)}** (${esc(f.confidence ?? "?")}${verification}) ` +
		`\`${esc(f.location?.file ?? "?")}:${esc(f.location?.line ?? "?")}\`${corroborated}\n` +
		`  - ${esc(f.finding)}\n  - _why:_ ${esc(f.rationale)}` +
		`${f.suggestion ? `\n  - _fix:_ ${esc(f.suggestion)}` : ""}` +
		`${f.evidence ? `\n  - _evidence:_ ${esc(f.evidence)}` : ""}`
	);
}

export function renderReport(charge: string, s: Any): string {
	const findings: Any[] = s.consolidated_findings ?? [];
	const bySev = (sev: string) => findings.filter((f) => f.severity === sev);

	const lines: string[] = [];
	lines.push(`# Code Review\n`);
	lines.push(`**Charge:** ${esc(charge)}\n`);
	lines.push(`**Verdict:** ${esc(s.verdict ?? "?")} — ${esc(s.verdict_rationale ?? "")}\n`);
	if (s.summary) lines.push(`> ${esc(s.summary)}\n`);

	const top = [...bySev("Blocker"), ...bySev("Major")];
	lines.push(`## Top Priorities (${top.length})\n`);
	lines.push(top.length ? top.map(findingMd).join("\n") : "_None._");

	lines.push(`\n## All Findings\n`);
	for (const sev of ["Blocker", "Major", "Minor", "Nit"]) {
		const group = bySev(sev);
		if (group.length) lines.push(`### ${sev} (${group.length})\n${group.map(findingMd).join("\n")}\n`);
	}

	const underExplored = (s.seam_accounting ?? []).filter((x: Any) => x.state === "under-explored");
	lines.push(`## Coverage Caveats\n`);
	const caveats = [
		...(s.caveats ?? []).map(esc),
		...underExplored.map((x: Any) => `Seam ${esc(x.seam_id)} under-explored${x.note ? `: ${esc(x.note)}` : ""}`),
		...(s.coverage_notes ?? []).map(esc),
	];
	lines.push(caveats.length ? caveats.map((c: string) => `- ${c}`).join("\n") : "_None._");

	if (s.follow_up_recommended) lines.push(`\n## Follow-up Recommended\n${esc(s.follow_up_reason ?? "")}`);

	if (s.dismissed_findings?.length) {
		lines.push(
			`\n## Dismissed (${s.dismissed_findings.length})\n` +
				s.dismissed_findings
					.map((f: Any) => `- \`${esc(f.location?.file)}:${esc(f.location?.line)}\` — ${esc(f.finding)} (_${esc(f.dismissal_reason)}_)`)
					.join("\n"),
		);
	}

	if (s.verification_stats) {
		const v = s.verification_stats;
		lines.push(
			`\n## Verification\n\n${v.verified} Blocker/Major finding(s) independently checked: ` +
				`${v.confirmed} confirmed, ${v.corrected} corrected, ${v.dismissed} dismissed, ${v.unverified} unverified.`,
		);
	}

	return `${lines.join("\n")}\n`;
}
