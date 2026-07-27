#!/usr/bin/env node
/**
 * stacia-code-review — coordinator entrypoint.
 *
 * Invoked by `bin/launch-review` in a dedicated iTerm pane, with exactly one
 * argument shape and no others:
 *
 *     node ./cli.ts --request <abs path to request.json>
 *
 * The launcher owns argument validation, so by the time we read the request
 * file: `repos` has >= 1 entry, every repo path is absolute / symlink-resolved
 * / exists / has a .git, every `source` matches the source grammar, `charge`
 * is non-blank, and every ADR path is an existing file. We re-check the two
 * invariants that would corrupt a run rather than merely fail it (charge
 * present, at least one repo), and otherwise trust the contract — a second
 * copy of the grammar here would just drift.
 *
 * This owns the whole run: allocate the run dir, build bundles, stage ADRs,
 * fan out read-only subagents through the coordinator, paint the live monitor,
 * write the report.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addContext, buildBundle, initRun, loadAssets, type Manifest, writeFindings, writeReport } from "./assets.ts";
import { loadConfig } from "./config.ts";
import { type RepoInput, runReview } from "./coordinator.ts";
import { Monitor } from "./monitor.ts";
import { renderReport } from "./render-report.ts";

// biome-ignore lint/suspicious/noExplicitAny: request/synthesis are JSON payloads
type Any = any;

const REQUEST_VERSION = 1;

export interface ReviewRequest {
	version: number;
	charge: string;
	cwd: string;
	repos: Array<{ path: string; source: string }>;
	adrs?: Array<{ id: string; title: string; path: string }>;
}

/** The user-scope config override. There is deliberately no project layer (ADR-0006). */
export function userConfigPath(homeDir: string = os.homedir()): string {
	return path.join(homeDir, ".claude", "stacia-code-review.json");
}

export function parseArgs(argv: string[]): { requestPath: string } {
	const i = argv.indexOf("--request");
	if (i === -1 || !argv[i + 1]) {
		throw new Error("usage: cli.ts --request <path to request.json>");
	}
	return { requestPath: argv[i + 1] };
}

export function readRequest(requestPath: string): ReviewRequest {
	let raw: string;
	try {
		raw = fs.readFileSync(requestPath, "utf8");
	} catch (err) {
		throw new Error(`could not read request file ${requestPath}: ${(err as Error).message}`);
	}
	let req: Any;
	try {
		req = JSON.parse(raw);
	} catch (err) {
		throw new Error(`request file ${requestPath} is not valid JSON: ${(err as Error).message}`);
	}
	if (req?.version !== REQUEST_VERSION) {
		throw new Error(`request file version ${req?.version} is not supported (expected ${REQUEST_VERSION}) — launcher and coordinator are out of step`);
	}
	// The charge is a hard gate in every entry point; never inferred from the diff.
	if (typeof req.charge !== "string" || !req.charge.trim()) throw new Error("a charge is required (what the change claims to accomplish)");
	if (!Array.isArray(req.repos) || req.repos.length === 0) throw new Error("at least one repo is required");
	return req as ReviewRequest;
}

export async function performReview(req: ReviewRequest, monitor: Monitor, signal: AbortSignal): Promise<Any> {
	const assets = loadAssets();
	const repoIds = req.repos.map((r) => r.path.replace(/\/+$/, "").split("/").pop() || "repo");
	const manifest: Manifest = await initRun(assets.helper, repoIds);
	if (manifest.repos.length !== req.repos.length) {
		throw new Error(`initRun returned ${manifest.repos.length} repo(s), expected ${req.repos.length} (one per requested repo)`);
	}

	const repos: RepoInput[] = [];
	for (let i = 0; i < req.repos.length; i++) {
		const m = manifest.repos[i];
		await buildBundle(assets.helper, manifest.run_dir, m.slug, req.repos[i].path, req.repos[i].source, signal);
		repos.push({ repo: m.repo, slug: m.slug, bundle: m.bundle, path: req.repos[i].path });
	}

	for (const adr of req.adrs ?? []) {
		const body = fs.readFileSync(adr.path, "utf8");
		const staged = await addContext(assets.helper, manifest.run_dir, "adr", adr.id, adr.title, body);
		manifest.context.push({ id: adr.id, kind: "adr", title: adr.title, path: staged });
	}

	const config = loadConfig(userConfigPath());
	const notes: string[] = [];
	const synthesis = await runReview({ charge: req.charge, repos, manifest, assets, config, monitor, notes, signal });

	await writeFindings(assets.helper, manifest.run_dir, "synthesis", JSON.stringify(synthesis, null, 2));
	const report = await writeReport(assets.helper, manifest.run_dir, renderReport(req.charge, synthesis));

	const findings: Any[] = synthesis.consolidated_findings ?? [];
	const counts = ["Blocker", "Major", "Minor", "Nit"].map((s) => `${findings.filter((f: Any) => f.severity === s).length} ${s}`).join(" · ");
	return { synthesis, counts, report, run_dir: manifest.run_dir };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	let req: ReviewRequest;
	try {
		req = readRequest(parseArgs(argv).requestPath);
	} catch (err) {
		process.stderr.write(`stacia-code-review: ${(err as Error).message}\n`);
		return 2;
	}

	// One controller for the whole run. Every subagent derives its abort from
	// this, so `c` in the TUI (and SIGINT) kills the in-flight fan-out rather
	// than leaving siblings burning tokens after we unwind.
	const controller = new AbortController();
	const monitor = new Monitor();
	monitor.onQuit(() => controller.abort());
	monitor.start();

	try {
		const { synthesis, counts, report, run_dir } = await performReview(req, monitor, controller.signal);
		monitor.stop();
		process.stdout.write(`\nReview complete — verdict: ${synthesis.verdict}\n${counts}\nReport: ${report.split("\n")[0]}\nRun dir: ${run_dir}\n`);
		return 0;
	} catch (err) {
		// The run didn't finish normally — make sure in-flight sibling subagents
		// don't keep spending tokens after we unwind.
		monitor.cancelAll();
		controller.abort();
		monitor.stop();
		process.stderr.write(`\nstacia-code-review failed: ${(err as Error).message}\n`);
		return 1;
	}
}

// Only run when executed directly, so the exported pieces stay unit-testable.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`stacia-code-review: unexpected failure: ${err?.stack ?? err}\n`);
			process.exit(1);
		},
	);
}
