/**
 * Single config file for the whole extension (tunables + models). Layered
 * lowest→highest: bundled defaults (assets/config.json) → user file →
 * project file (trust-gated — caller decides whether to pass a project path
 * at all). Missing/invalid override files are ignored. This module is
 * pi-free at runtime: callers (index.ts) resolve the candidate file paths
 * (via pi's getAgentDir()/CONFIG_DIR_NAME) and pass them in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateModels } from "./models.ts";
import { validate } from "./validate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, "assets", "config.json");
const SCHEMA = path.join(HERE, "assets", "config.schema.json");

export interface Config {
	workflow: { maxRounds: number; roundTimeoutMs: number; concurrency: number; agentRetries: number };
	reviewer: { maxFindings: number; perspectives: string[] };
	reconciler: { minSeams: number; maxSeams: number };
	synthesis: { followUpThreshold: number };
	models: Record<string, string>; // per-role "provider/id"; all roles required (validated)
}

// biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON being merged
type Json = any;

function isPlainObject(v: Json): boolean {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: Json, override: Json): Json {
	if (!isPlainObject(base) || !isPlainObject(override)) return override;
	const out: Json = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] = key in base && isPlainObject(base[key]) && isPlainObject(value) ? deepMerge(base[key], value) : value;
	}
	return out;
}

function readJsonSafe(p: string): Json | null {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Load + merge + validate the config. `userConfigPath`/`projectConfigPath` are
 * candidate override file paths (existence + trust decisions are the
 * caller's job — this function just merges whichever paths it's given, if
 * they exist). The FULL merged config is validated against
 * assets/config.schema.json, then `models` is checked with validateModels.
 */
export function loadConfig(userConfigPath?: string, projectConfigPath?: string): Config {
	let cfg: Json = JSON.parse(fs.readFileSync(BASE, "utf8"));

	if (userConfigPath) {
		const user = readJsonSafe(userConfigPath);
		if (user) cfg = deepMerge(cfg, user);
	}

	if (projectConfigPath) {
		const project = readJsonSafe(projectConfigPath);
		if (project) cfg = deepMerge(cfg, project);
	}

	const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
	const errs = validate(cfg, schema);
	if (errs.length) throw new Error(`config: invalid merged config:\n${errs.join("\n")}`);

	validateModels(cfg.models ?? {}); // fail fast: every role needs an explicit provider/id
	return cfg as Config;
}
