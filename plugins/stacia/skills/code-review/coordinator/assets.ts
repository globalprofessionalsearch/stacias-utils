/**
 * Load the on-disk review assets (personas, schemas) and drive the
 * run-directory helper (code-review-workdir.py) as a subprocess. Nothing here
 * is inlined into a tool call - the coordinator reads straight from disk.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ReviewerPersona, renderReviewerPersona } from "./render-persona.ts";
import { validate } from "./validate.ts";

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON schema/config
type Json = any;

export interface Assets {
	assetsDir: string;
	helper: string;
	personas: {
		orienteerA: string;
		orienteerB: string;
		reconciler: string;
		commonRules: string;
		reviewers: Record<string, string>;
		synthesizer: string;
		verifier: string;
	};
	schemas: { orientation: Json; seamMap: Json; reviewer: Json; synthesis: Json; verifier: Json; report: Json };
}

export interface RepoRef {
	repo: string;
	slug: string;
	bundle: string;
	findings: string;
	path: string; // absolute local repo path (added by caller)
}

export interface Manifest {
	run_dir: string;
	report_json: string;
	report_html: string;
	/** Append-only JSONL run log. Path allocated by the helper's `init`. */
	log: string;
	/** Terminal state (`complete` | `failed`), written once at the end. */
	status: string;
	multi_repo: boolean;
	context: Array<{ id: string; kind: string; title: string; path: string }>;
	repos: Array<{ repo: string; slug: string; bundle: string; findings: string }>;
}

/**
 * Discover the available perspectives by scanning assets/reviewers/*.json.
 * Adding or removing a reviewer is a file add/remove — no code changes.
 */
function discoverPerspectives(assetsDir: string): string[] {
	const dir = path.join(assetsDir, "reviewers");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.sort();
}

// Resolved at load time from the directory scan. Exported so the coordinator
// can validate config.reviewer.perspectives against the set of actually-present
// reviewer definitions.
let PERSPECTIVES: readonly string[] = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function resolveAssetsDir(): string {
	return process.env.CR_ASSETS_DIR || path.join(HERE, "assets");
}

export function loadAssets(): Assets {
	const assetsDir = resolveAssetsDir();
	const read = (p: string) => fs.readFileSync(path.join(assetsDir, p), "utf8");
	const readJson = (p: string) => JSON.parse(read(p));
	const schemas = {
		orientation: readJson("schemas/orientation.schema.json"),
		seamMap: readJson("schemas/seam-map.schema.json"),
		reviewer: readJson("schemas/reviewer-output.schema.json"),
		synthesis: readJson("schemas/synthesis.schema.json"),
		verifier: readJson("schemas/verifier-output.schema.json"),
		report: readJson("schemas/report.schema.json"),
	};
	PERSPECTIVES = discoverPerspectives(assetsDir);
	if (!PERSPECTIVES.length) throw new Error("no reviewer personas found in assets/reviewers/");

	const reviewerPersonaSchema = readJson("schemas/reviewer-persona.schema.json");
	const reviewers: Record<string, string> = {};
	for (const p of PERSPECTIVES) {
		const raw = readJson(`reviewers/${p}.json`);
		const errs = validate(raw, reviewerPersonaSchema);
		if (errs.length) throw new Error(`reviewer persona ${p}: schema validation failed: ${errs.join("; ")}`);
		reviewers[p] = renderReviewerPersona(raw as ReviewerPersona);
	}
	return {
		assetsDir,
		helper: path.join(HERE, "helper", "code-review-workdir.py"),
		schemas,
		personas: {
			orienteerA: read("references/orienteer-claim-to-code.md"),
			orienteerB: read("references/orienteer-code-to-claim.md"),
			reconciler: read("references/reconciler.md"),
			commonRules: read("references/common-reviewer-rules.md"),
			reviewers,
			synthesizer: read("references/synthesizer.md"),
			verifier: read("references/verifier.md"),
		},
	};
}

// ---- helper subprocess runners (async; stdin for write-* commands) ----

function runHelper(helper: string, args: string[], input?: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("python3", [helper, ...args], { signal, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${args[0]} failed: ${stderr || err.message}`));
			else resolve(stdout.trim());
		});
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

export async function initRun(helper: string, repos: string[]): Promise<Manifest> {
	const out = await runHelper(helper, ["init", ...repos]);
	return JSON.parse(out) as Manifest;
}

/**
 * Read the manifest of an already-allocated run.
 *
 * `bin/launch-review` runs `init` itself so it can tell the calling session
 * where the artifacts will land — it splits a pane and exits, so anything the
 * caller needs must be known before then. The coordinator therefore inherits a
 * run directory rather than allocating one.
 */
export function loadManifest(runDir: string): Manifest {
	const p = path.join(runDir, "manifest.json");
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch (err) {
		throw new Error(`could not read run manifest ${p}: ${(err as Error).message}`);
	}
	try {
		return JSON.parse(raw) as Manifest;
	} catch (err) {
		throw new Error(`run manifest ${p} is not valid JSON: ${(err as Error).message}`);
	}
}

export function buildBundle(helper: string, runDir: string, slug: string, repoPath: string, source: string, signal?: AbortSignal): Promise<string> {
	return runHelper(helper, ["build-bundle", "--run", runDir, "--slug", slug, "--repo-path", repoPath, "--source", source], undefined, signal);
}

export function addContext(helper: string, runDir: string, kind: string, id: string, title: string, body: string): Promise<string> {
	return runHelper(helper, ["add-context", "--run", runDir, "--kind", kind, "--id", id, "--title", title], body);
}

export function writeFindings(helper: string, runDir: string, slug: string, json: string): Promise<string> {
	return runHelper(helper, ["write-findings", "--run", runDir, "--slug", slug], json);
}

/**
 * Write the run's terminal state. The helper writes this ATOMICALLY, because
 * `bin/await-review` polls for the file's existence as the completion signal —
 * a half-written file would be read as "done".
 */
export function writeStatus(helper: string, runDir: string, json: string): Promise<string> {
	return runHelper(helper, ["write-status", "--run", runDir], json);
}

export function writeReport(helper: string, runDir: string, markdown: string): Promise<string> {
	return runHelper(helper, ["write-report", "--run", runDir], markdown);
}

export { PERSPECTIVES };
