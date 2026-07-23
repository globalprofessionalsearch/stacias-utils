/**
 * Per-agent-type model resolution. Model names come from the single merged
 * Config's `models` map (see config.ts). Resolution per agent: models[role] →
 * models.default → host model.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
// biome-ignore lint/suspicious/noExplicitAny: Model type varies by provider api
type Model = any;

export type Role = "orienteer" | "reconciler" | "reviewer" | "synthesizer" | "verifier";

/**
 * Resolve a role to a concrete Model. Returns { model, note? } where note flags
 * a configured-but-unresolvable name (so the caller can surface it and fall back
 * to the host model).
 */
export function resolveModel(
	role: Role,
	models: Record<string, string | null>,
	rt: ModelRuntime,
	hostModel: Model,
): { model: Model; note?: string } {
	const name = models[role] ?? models.default;
	if (!name) return { model: hostModel };
	const slash = name.indexOf("/");
	if (slash < 0) return { model: hostModel, note: `bad model id "${name}" (want provider/id)` };
	const provider = name.slice(0, slash);
	const id = name.slice(slash + 1);
	const model = rt.getModel(provider, id);
	if (!model) return { model: hostModel, note: `model "${name}" not found; using host model` };
	return { model };
}
