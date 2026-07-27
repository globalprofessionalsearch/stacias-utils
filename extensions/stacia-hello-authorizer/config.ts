/**
 * Minimal config: which model writes the plain-language summary ("haiku"),
 * shown to the user before a fall-through approve/deny. Bundled default lives
 * in config.json beside this file; a same-named file at
 * ~/.pi/agent/extensions/<this-extension>/config.json is not separately layered
 * yet (single bundled file for now — edit config.json directly).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, "config.json");

export interface GateConfig {
	/** Summary model as "provider/id", e.g. "anthropic/claude-haiku-4-5". */
	summaryModel: string;
}

const DEFAULTS: GateConfig = { summaryModel: "anthropic/claude-haiku-4-5" };

export function loadConfig(): GateConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<GateConfig>;
		return {
			summaryModel: typeof raw.summaryModel === "string" && raw.summaryModel.includes("/") ? raw.summaryModel : DEFAULTS.summaryModel,
		};
	} catch {
		return DEFAULTS;
	}
}
