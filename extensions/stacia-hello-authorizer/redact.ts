/**
 * Best-effort secret redaction for the AUDIT LOG only. The live confirm dialog
 * still shows the human the real command; these redactors run just before a
 * record is written to disk.
 *
 * This is heuristic and cannot be complete — an arbitrary command can carry a
 * secret in a shape no rule anticipates. It is a mitigation, not a guarantee.
 * Redactors run in order; each is a pure `(text) => text`. Edit the array to
 * tune coverage.
 */

export interface Redactor {
	name: string;
	apply: (text: string) => string;
}

const MASK = "\u2039redacted\u203a"; // ‹redacted›

export const redactors: Redactor[] = [
	// Known high-confidence token shapes (GitHub, OpenAI, AWS, Slack, Google, JWT).
	{
		name: "known-token-shapes",
		apply: (t) =>
			t.replace(
				/\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
				MASK,
			),
	},

	// Authorization headers and standalone bearer/basic tokens.
	{
		name: "auth-header",
		apply: (t) =>
			t
				.replace(/\bAuthorization\s*[:=]\s*\S+(?:\s+\S+)?/gi, `Authorization: ${MASK}`)
				.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${MASK}`),
	},

	// Structural: the value after a risky flag (--password, --token, -p, --api-key, ...).
	{
		name: "risky-flag-value",
		apply: (t) =>
			t.replace(
				/(--?(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|auth|access[-_]?token|bearer|header)\b[=\s]+)(?:"[^"]*"|'[^']*'|\S+)/gi,
				`$1${MASK}`,
			),
	},

	// Structural: VAR=value where the name looks sensitive.
	{
		name: "sensitive-env-assign",
		apply: (t) =>
			t.replace(
				/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|CREDENTIAL|AUTH|PRIVATE)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g,
				`$1=${MASK}`,
			),
	},

	// Inline URL credentials: proto://user:pass@host.
	{
		name: "url-userinfo",
		apply: (t) => t.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi, `$1${MASK}@`),
	},
];

/** Run every redactor in order. A broken redactor is skipped, not fatal. */
export function redact(text: string): string;
export function redact(text: undefined): undefined;
export function redact(text: string | undefined): string | undefined;
export function redact(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	let out = text;
	for (const r of redactors) {
		try {
			out = r.apply(out);
		} catch {
			// a malformed redactor must not break logging
		}
	}
	return out;
}
