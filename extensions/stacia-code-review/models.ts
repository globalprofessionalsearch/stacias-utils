/**
 * Per-agent-type model resolution. Every role's model is EXPLICITLY specified in
 * the single config's `models` map (see config.ts) as "provider/id". There is no
 * `default` and no host-model fallback: an unset, blank, or unresolvable model is
 * a hard error (fail fast), surfaced before agents run.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
// biome-ignore lint/suspicious/noExplicitAny: Model type varies by provider api
type Model = any;

export type Role = "orienteer" | "reconciler" | "reviewer" | "synthesizer" | "verifier";
export const ROLES: Role[] = ["orienteer", "reconciler", "reviewer", "synthesizer", "verifier"];

/**
 * Validate that every role has an explicit "provider/id" string. Throws listing
 * ALL offending roles at once. Call at config load, before any agent runs.
 */
export function validateModels(models: Record<string, unknown>): void {
	const bad: string[] = [];
	for (const role of ROLES) {
		const v = models?.[role];
		if (typeof v !== "string" || !v.includes("/") || !v.trim()) {
			bad.push(`${role}=${v === undefined ? "(unset)" : JSON.stringify(v)}`);
		}
	}
	if (bad.length) {
		throw new Error(
			`config.models: every role must be an explicit "provider/id". Fix: ${bad.join(", ")}. ` +
				`(No default / host-model fallback.)`,
		);
	}
}

/** Resolve a role to a concrete Model. Throws if the configured id is unresolvable. */
export function resolveModel(role: Role, models: Record<string, string>, rt: ModelRuntime): Model {
	const name = models[role];
	const slash = name.indexOf("/");
	const provider = name.slice(0, slash);
	const id = name.slice(slash + 1);
	const model = rt.getModel(provider, id);
	if (!model) {
		throw new Error(`config.models.${role}: model "${name}" not found (check provider/id and that it is configured/authed).`);
	}
	return model;
}
