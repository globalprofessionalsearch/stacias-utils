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
import { NULL_LOG, RunLog } from "./run-log.ts";

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

/**
 * Called as soon as the run directory exists, so `main` can point at it even
 * when the review fails. Everything worth inspecting after a failure —
 * bundles, the log, whatever findings landed — lives under there.
 */
export type OnRunDir = (manifest: Manifest) => void;

export async function performReview(req: ReviewRequest, monitor: Monitor, signal: AbortSignal, onRunDir?: OnRunDir): Promise<Any> {
	const assets = loadAssets();
	const repoIds = req.repos.map((r) => r.path.replace(/\/+$/, "").split("/").pop() || "repo");
	const manifest: Manifest = await initRun(assets.helper, repoIds);
	onRunDir?.(manifest);
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
	const synthesis = await runReview({ charge: req.charge, repos, manifest, assets, config, monitor, notes, signal, log: monitor.runLog });

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

	// Captured as soon as initRun allocates it, so the failure path can point at
	// it. A failed review is exactly when the run dir matters most: the log,
	// the bundles and any partial findings are all under there.
	let runDir: string | null = null;
	let log: RunLog = NULL_LOG;
	const onRunDir = (manifest: Manifest) => {
		runDir = manifest.run_dir;
		log = new RunLog(manifest.log ?? null);
		monitor.setLog(log);
		log.info("run.start", { runDir, charge: req.charge, repos: req.repos, adrs: (req.adrs ?? []).map((a) => a.id) });
	};

	try {
		const { synthesis, counts, report, run_dir } = await performReview(req, monitor, controller.signal, onRunDir);
		monitor.stop();
		await log.close();
		process.stdout.write(`\nReview complete — verdict: ${synthesis.verdict}\n${counts}\nReport: ${report.split("\n")[0]}\nRun dir: ${run_dir}\n`);
		return 0;
	} catch (err) {
		// The run didn't finish normally — make sure in-flight sibling subagents
		// don't keep spending tokens after we unwind.
		monitor.cancelAll("run failed");
		controller.abort();
		monitor.stop();
		log.fail("run.failed", err);
		await log.close();
		process.stderr.write(failureReport(err, runDir, log.error));
		return 1;
	}
}

/**
 * What the user sees in the pane when a review does not complete. The run dir
 * is the actionable part — the message alone rarely says enough — so it is
 * always printed when we got far enough to have one.
 */
export function failureReport(err: unknown, runDir: string | null, logError?: string | null): string {
	const message = err instanceof Error ? err.message : String(err);
	const lines = ["", `Review UNSUCCESSFUL: ${message}`, ""];
	if (runDir) {
		lines.push(`Run directory: ${runDir}`, `Log:           ${runDir}/logs/run.jsonl`, "");
	} else {
		lines.push("No run directory was allocated — the review failed before it started.", "");
	}
	if (logError) lines.push(`(run log was degraded: ${logError})`, "");
	return lines.join("\n");
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
