/**
 * Load the on-disk review assets (personas, schemas) and drive the
 * run-directory helper (code-review-workdir.py) as a subprocess. Nothing here
 * is inlined into a tool call - the coordinator reads straight from disk.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
	schemas: { orientation: Json; seamMap: Json; reviewer: Json; synthesis: Json; verifier: Json };
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
	report: string;
	report_html: string;
	multi_repo: boolean;
	context: Array<{ id: string; kind: string; title: string; path: string }>;
	repos: Array<{ repo: string; slug: string; bundle: string; findings: string }>;
}

const PERSPECTIVES = ["correctness", "security", "performance", "api-contract", "tests", "adr"] as const;

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
	};
	const reviewers: Record<string, string> = {};
	for (const p of PERSPECTIVES) reviewers[p] = read(`references/reviewer-${p}.md`);
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

export function buildBundle(helper: string, runDir: string, slug: string, repoPath: string, source: string, signal?: AbortSignal): Promise<string> {
	return runHelper(helper, ["build-bundle", "--run", runDir, "--slug", slug, "--repo-path", repoPath, "--source", source], undefined, signal);
}

export function addContext(helper: string, runDir: string, kind: string, id: string, title: string, body: string): Promise<string> {
	return runHelper(helper, ["add-context", "--run", runDir, "--kind", kind, "--id", id, "--title", title], body);
}

export function writeFindings(helper: string, runDir: string, slug: string, json: string): Promise<string> {
	return runHelper(helper, ["write-findings", "--run", runDir, "--slug", slug], json);
}

export function writeReport(helper: string, runDir: string, markdown: string): Promise<string> {
	return runHelper(helper, ["write-report", "--run", runDir], markdown);
}

export { PERSPECTIVES };
