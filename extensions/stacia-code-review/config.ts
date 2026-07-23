/**
 * Single config file for the whole extension (tunables + models). Layered
 * lowest→highest: bundled defaults (assets/config.json) → user file
 * (~/.pi/agent/stacia-code-review.json) → project file
 * (.pi/stacia-code-review.json, trust-gated). Missing/invalid override files
 * are ignored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { validateModels } from "./models.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(HERE, "assets", "config.json");
const CONFIG_NAME = "stacia-code-review.json";

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

export function loadConfig(cwd: string, trusted: boolean): Config {
	let cfg: Json = JSON.parse(fs.readFileSync(BASE, "utf8"));

	const user = readJsonSafe(path.join(getAgentDir(), CONFIG_NAME));
	if (user) cfg = deepMerge(cfg, user);

	if (trusted) {
		const project = readJsonSafe(path.join(cwd, CONFIG_DIR_NAME, CONFIG_NAME));
		if (project) cfg = deepMerge(cfg, project);
	}

	validateModels(cfg.models ?? {}); // fail fast: every role needs an explicit provider/id
	return cfg as Config;
}
