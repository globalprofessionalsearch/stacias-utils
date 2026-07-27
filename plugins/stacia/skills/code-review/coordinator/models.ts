/**
 * Per-role model selection. Every role's model is EXPLICITLY named in the
 * single config's `models` map (see config.ts). There is no `default` and no
 * host-model fallback: an unset or blank model is a hard error (fail fast),
 * surfaced before any agent runs.
 *
 * Unlike the pi version, there is nothing to "resolve" — the Claude Agent SDK
 * takes a plain model id string on `query({ options: { model } })` and the
 * provider is whatever the session is authenticated against. So the old
 * `"provider/id"` format is gone, along with `ModelRuntime.getModel()`. The
 * SDK fails at startup on an unknown id, which preserves the fail-fast
 * property this module was written for.
 */

export type Role = "orienteer" | "reconciler" | "reviewer" | "synthesizer" | "verifier";
export const ROLES: Role[] = ["orienteer", "reconciler", "reviewer", "synthesizer", "verifier"];

/**
 * Validate that every role names a model. Throws listing ALL offending roles
 * at once. Call at config load, before any agent runs.
 *
 * A `provider/id` value is rejected with a migration hint rather than passed
 * through: it is the pi-era format, and forwarding it to the SDK would fail
 * later with a much less obvious "unknown model" error.
 */
export function validateModels(models: Record<string, unknown>): void {
	const bad: string[] = [];
	const legacy: string[] = [];
	for (const role of ROLES) {
		const v = models?.[role];
		if (typeof v !== "string" || !v.trim()) {
			bad.push(`${role}=${v === undefined ? "(unset)" : JSON.stringify(v)}`);
		} else if (v.includes("/")) {
			legacy.push(`${role}=${JSON.stringify(v)}`);
		}
	}
	if (legacy.length) {
		throw new Error(
			`config.models: "provider/id" is the retired pi format — use a bare model id ` +
				`(e.g. "claude-sonnet-5", not "anthropic/claude-sonnet-5"). Fix: ${legacy.join(", ")}.`,
		);
	}
	if (bad.length) {
		throw new Error(`config.models: every role must name a model. Fix: ${bad.join(", ")}. (No default / host-model fallback.)`);
	}
}

/** The model id for a role, as passed to `query({ options: { model } })`. */
export function modelFor(role: Role, models: Record<string, string>): string {
	return models[role];
}
