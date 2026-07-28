/**
 * Render a structured reviewer persona definition into a system-prompt string.
 *
 * Each reviewer is defined as a JSON file under assets/reviewers/, validated
 * against reviewer-persona.schema.json. This renderer assembles the JSON into
 * the markdown the model sees, replacing the hand-authored reviewer-*.md files
 * that had the same sections in roughly the same order but inconsistent
 * structure and missing severity calibration.
 *
 * The common reviewer rules (common-reviewer-rules.md) are prepended by the
 * coordinator, not by this renderer — that separation is unchanged.
 */

// biome-ignore lint/suspicious/noExplicitAny: persona JSON is validated upstream
type Any = any;

export interface ReviewerPersona {
	perspective: string;
	role: string;
	focus: Array<{ area: string; details: string }>;
	severity: { Blocker: string; Major: string; Minor: string; Nit: string };
	method: string;
	rationale_instruction?: string;
	suggestion_instruction?: string;
	extra_context?: string;
}

export function renderReviewerPersona(persona: ReviewerPersona): string {
	const lines: string[] = [];

	lines.push(`# Reviewer persona: ${persona.perspective}\n`);
	lines.push(`You are a **${persona.perspective} reviewer** (\`perspective: ${persona.perspective}\`). ${persona.role}\n`);

	lines.push("## Your input\n");
	lines.push(
		"You receive the **orientation** (comprehension model of the change) and **seam " +
			"map** (priority-ranked regions warranting attention). Start from high-priority " +
			"seams; pull file content on demand to investigate. You do not receive the full diff.\n",
	);

	if (persona.extra_context) {
		lines.push(`${persona.extra_context}\n`);
	}

	lines.push("## Focus\n");
	for (const f of persona.focus) {
		lines.push(`- **${f.area}**: ${f.details}`);
	}
	lines.push("");

	lines.push("## Severity calibration\n");
	for (const sev of ["Blocker", "Major", "Minor", "Nit"] as const) {
		lines.push(`- **${sev}**: ${persona.severity[sev]}`);
	}
	lines.push("");

	lines.push("## Method\n");
	lines.push(`${persona.method}\n`);

	if (persona.rationale_instruction || persona.suggestion_instruction) {
		const parts: string[] = [];
		if (persona.rationale_instruction) parts.push(`\`rationale\` ${persona.rationale_instruction}`);
		if (persona.suggestion_instruction) parts.push(`\`suggestion\` (optional) ${persona.suggestion_instruction}`);
		lines.push(parts.join("; ") + ".\n");
	}

	return lines.join("\n");
}
