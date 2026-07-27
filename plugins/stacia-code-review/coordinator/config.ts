/**
 * Single config file for the whole coordinator (tunables + models). Two
 * layers, lowest→highest: bundled defaults (assets/config.json) → user file
 * (~/.claude/stacia-code-review.json). A missing or unparseable override is
 * ignored and falls through to the layer below.
 *
 * There is deliberately NO project-level layer. The pi version had one, gated
 * on `ctx.isProjectTrusted()` (ADR-0002), because config is read from the
 * directory the review runs *from* — so reviewing a cloned PR branch meant
 * that checkout could commit a config naming `models.*` and redirect every
 * subagent's traffic (diffs, orientation, findings) to an endpoint it chose.
 * Claude Code exposes no project-trust signal to gate that with, so the layer
 * is removed rather than left ungated. See ADR-0006.
 *
 * The caller resolves the user file's path and passes it in; this module does
 * no path discovery of its own.
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
	workflow: { maxRounds: number; roundTimeoutMs: number; concurrency: number };
	reviewer: { maxFindings: number; perspectives: string[] };
	reconciler: { minSeams: number; maxSeams: number };
	synthesis: { followUpThreshold: number };
	models: Record<string, string>; // per-role model id; all roles required (validated)
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
 * Load + merge + validate the config. `userConfigPath` is a candidate override
 * file path (existence is this function's problem; discovering the path is the
 * caller's). The FULL merged config is validated against
 * assets/config.schema.json, then `models` is checked with validateModels.
 */
export function loadConfig(userConfigPath?: string): Config {
	let cfg: Json = JSON.parse(fs.readFileSync(BASE, "utf8"));

	if (userConfigPath) {
		const user = readJsonSafe(userConfigPath);
		if (user) cfg = deepMerge(cfg, user);
	}

	const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
	const errs = validate(cfg, schema);
	if (errs.length) throw new Error(`config: invalid merged config:\n${errs.join("\n")}`);

	validateModels(cfg.models ?? {}); // fail fast: every role needs an explicit provider/id
	return cfg as Config;
}
