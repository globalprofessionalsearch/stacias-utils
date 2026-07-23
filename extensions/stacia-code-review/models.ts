/**
 * Per-agent-type model configuration + resolution.
 *
 * Config shape (all optional): { "models": { "default": "provider/id",
 * "orienteer": "...", "reconciler": "...", "reviewer": "...",
 * "synthesizer": "...", "verifier": "..." } }
 *
 * Layered lowest→highest: (bundled = host session model) → user file
 * (~/.pi/agent/stacia-code-review.json) → project file (.pi/stacia-code-review.json,
 * trust-gated). Resolution per agent: models[role] → models.default → host model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
// biome-ignore lint/suspicious/noExplicitAny: Model type varies by provider api
type Model = any;

const CONFIG_NAME = "stacia-code-review.json";
export type Role = "orienteer" | "reconciler" | "reviewer" | "synthesizer" | "verifier";

export interface ModelConfig {
	models: Partial<Record<Role | "default", string>>;
}

function readJsonSafe(p: string): { models?: Record<string, string> } | null {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

export function loadModelConfig(cwd: string, projectTrusted: boolean): ModelConfig {
	const merged: Record<string, string> = {};
	const user = readJsonSafe(path.join(getAgentDir(), CONFIG_NAME));
	if (user?.models) Object.assign(merged, user.models);
	if (projectTrusted) {
		const project = readJsonSafe(path.join(cwd, CONFIG_DIR_NAME, CONFIG_NAME));
		if (project?.models) Object.assign(merged, project.models);
	}
	return { models: merged };
}

/**
 * Resolve a role to a concrete Model. Returns { model, note? } where note flags
 * a configured-but-unresolvable name (so the caller can surface it and fall back
 * to the host model).
 */
export function resolveModel(
	role: Role,
	cfg: ModelConfig,
	rt: ModelRuntime,
	hostModel: Model,
): { model: Model; note?: string } {
	const name = cfg.models[role] ?? cfg.models.default;
	if (!name) return { model: hostModel };
	const slash = name.indexOf("/");
	if (slash < 0) return { model: hostModel, note: `bad model id "${name}" (want provider/id)` };
	const provider = name.slice(0, slash);
	const id = name.slice(slash + 1);
	const model = rt.getModel(provider, id);
	if (!model) return { model: hostModel, note: `model "${name}" not found; using host model` };
	return { model };
}
