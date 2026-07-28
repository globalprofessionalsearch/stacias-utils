import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadManifest } from "../assets.ts";
import { buildStatus, failureReport, parseArgs, readRequest, severityCounts, userConfigPath } from "../cli.ts";

// The launcher (bin/launch-review) validates repo paths, source grammar and ADR
// paths before writing request.json, so cli.ts deliberately does NOT re-check
// those — a second copy of the grammar would just drift. It re-checks only the
// two invariants that would corrupt a run rather than fail it cleanly.

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-cli-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const valid = {
	version: 1,
	charge: "adds retry to the upload path",
	cwd: "/repo",
	repos: [{ path: "/repo", source: "range:main...HEAD" }],
	adrs: [],
};

function write(data: unknown): string {
	const p = path.join(tmpDir, "request.json");
	fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data), "utf8");
	return p;
}

describe("parseArgs", () => {
	it("accepts the one supported invocation", () => {
		expect(parseArgs(["--request", "/tmp/r.json"])).toEqual({ requestPath: "/tmp/r.json" });
	});

	it("rejects a missing --request", () => {
		expect(() => parseArgs([])).toThrowError(/usage/);
	});

	it("rejects --request with no value", () => {
		expect(() => parseArgs(["--request"])).toThrowError(/usage/);
	});
});

describe("readRequest", () => {
	it("reads a well-formed request", () => {
		expect(readRequest(write(valid)).charge).toBe("adds retry to the upload path");
	});

	it("reports a missing file by path rather than throwing ENOENT", () => {
		expect(() => readRequest(path.join(tmpDir, "nope.json"))).toThrowError(/could not read request file/);
	});

	it("reports malformed JSON as such", () => {
		expect(() => readRequest(write("{ not json"))).toThrowError(/not valid JSON/);
	});

	it("rejects a version it does not understand, naming the drift", () => {
		expect(() => readRequest(write({ ...valid, version: 2 }))).toThrowError(/out of step/);
	});

	it("rejects a missing version rather than assuming v1", () => {
		const { version: _drop, ...noVersion } = valid;
		expect(() => readRequest(write(noVersion))).toThrowError(/not supported/);
	});

	// The charge gate is the one rule both pi entry points enforced and the
	// review is meaningless without: it is what the findings are judged against.
	it("rejects a missing charge", () => {
		const { charge: _drop, ...noCharge } = valid;
		expect(() => readRequest(write(noCharge))).toThrowError(/charge is required/);
	});

	it("rejects a whitespace-only charge", () => {
		expect(() => readRequest(write({ ...valid, charge: "   \n\t " }))).toThrowError(/charge is required/);
	});

	it("rejects a non-string charge", () => {
		expect(() => readRequest(write({ ...valid, charge: 42 }))).toThrowError(/charge is required/);
	});

	it("rejects an empty repo list", () => {
		expect(() => readRequest(write({ ...valid, repos: [] }))).toThrowError(/at least one repo/);
	});

	it("rejects a missing repo list", () => {
		const { repos: _drop, ...noRepos } = valid;
		expect(() => readRequest(write(noRepos))).toThrowError(/at least one repo/);
	});

	it("accepts an absent adrs field (ADRs are optional context)", () => {
		const { adrs: _drop, ...noAdrs } = valid;
		expect(() => readRequest(write(noAdrs))).not.toThrow();
	});

	it("accepts multiple repos", () => {
		const req = readRequest(write({ ...valid, repos: [{ path: "/a", source: "worktree" }, { path: "/b", source: "pr:12" }] }));
		expect(req.repos).toHaveLength(2);
	});
});

describe("userConfigPath", () => {
	it("resolves under ~/.claude, not the retired ~/.pi/agent", () => {
		expect(userConfigPath("/home/u")).toBe("/home/u/.claude/stacia-code-review.json");
	});

	it("does not consult the working directory — there is no project layer (ADR-0006)", () => {
		expect(userConfigPath("/home/u")).not.toContain("/repo");
	});
});

describe("failureReport", () => {
	// A failed review is exactly when the run dir matters: the log, the bundles
	// and any partial findings are all under there, and the message alone
	// rarely says enough.
	it("labels the review UNSUCCESSFUL and carries the reason", () => {
		const out = failureReport(new Error("Orienteer A (claim→code) failed (timeout after 360s)"), "/runs/abc");
		expect(out).toContain("Review UNSUCCESSFUL");
		expect(out).toContain("Orienteer A (claim→code) failed (timeout after 360s)");
	});

	it("points at the run directory and the log inside it", () => {
		const out = failureReport(new Error("boom"), "/runs/abc");
		expect(out).toContain("/runs/abc");
		expect(out).toContain("/runs/abc/logs/run.jsonl");
	});

	it("says so plainly when the run failed before a run dir existed", () => {
		const out = failureReport(new Error("could not read request file"), null);
		expect(out).toContain("No run directory was allocated");
		expect(out).not.toContain("logs/run.jsonl");
	});

	it("surfaces a degraded log rather than silently pointing at a file that isn't there", () => {
		const out = failureReport(new Error("boom"), "/runs/abc", "ENOSPC");
		expect(out).toContain("run log was degraded: ENOSPC");
	});

	it("omits the degraded-log note when logging worked", () => {
		expect(failureReport(new Error("boom"), "/runs/abc", null)).not.toContain("degraded");
	});

	it("handles a non-Error thrown value", () => {
		expect(failureReport("just a string", "/runs/abc")).toContain("just a string");
	});
});

describe("run_dir handoff from the launcher", () => {
	// The launcher allocates the run dir so it can print it before splitting the
	// pane — after that the calling session never hears from the review again.
	it("accepts a request carrying a pre-allocated run_dir", () => {
		expect(readRequest(write({ ...valid, run_dir: "/runs/abc" })).run_dir).toBe("/runs/abc");
	});

	it("still accepts a request without one", () => {
		expect(readRequest(write(valid)).run_dir).toBeUndefined();
	});
});

describe("loadManifest", () => {
	it("reads the manifest of a pre-allocated run", () => {
		const dir = fs.mkdtempSync(path.join(tmpDir, "run-"));
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ run_dir: dir, log: `${dir}/logs/run.jsonl`, repos: [{ slug: "a" }] }));
		const m = loadManifest(dir);
		expect(m.run_dir).toBe(dir);
		expect(m.log).toBe(`${dir}/logs/run.jsonl`);
	});

	it("names the path when the manifest is missing", () => {
		expect(() => loadManifest(path.join(tmpDir, "nope"))).toThrowError(/could not read run manifest/);
	});

	it("names the path when the manifest is malformed", () => {
		const dir = fs.mkdtempSync(path.join(tmpDir, "run-"));
		fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
		expect(() => loadManifest(dir)).toThrowError(/is not valid JSON/);
	});
});

describe("severityCounts", () => {
	it("tallies every severity, including zeros", () => {
		expect(severityCounts([{ severity: "Blocker" }, { severity: "Major" }, { severity: "Major" }])).toEqual({
			Blocker: 1,
			Major: 2,
			Minor: 0,
			Nit: 0,
		});
	});

	it("ignores unknown severities rather than inventing keys", () => {
		expect(severityCounts([{ severity: "Catastrophic" }])).toEqual({ Blocker: 0, Major: 0, Minor: 0, Nit: 0 });
	});

	it("tolerates an empty or absent list", () => {
		expect(severityCounts([])).toEqual({ Blocker: 0, Major: 0, Minor: 0, Nit: 0 });
		expect(severityCounts(undefined as unknown as [])).toEqual({ Blocker: 0, Major: 0, Minor: 0, Nit: 0 });
	});

	it("tolerates malformed findings", () => {
		expect(() => severityCounts([null, {}, { severity: null }] as unknown as [])).not.toThrow();
	});
});

describe("buildStatus", () => {
	// status.json is the completion signal await-review polls for. It must be
	// written on BOTH paths — a run that ends without one is indistinguishable
	// from one still in progress.
	const base = { runDir: "/runs/abc", charge: "adds retry", startedAt: "2026-07-28T12:00:00.000Z" };

	it("marks a completed run with verdict, counts and report", () => {
		const s = buildStatus({
			...base,
			state: "complete",
			verdict: "partial",
			findings: [{ severity: "Blocker" }, { severity: "Minor" }],
			report: "/runs/abc/report.md",
		});
		expect(s).toMatchObject({
			version: 1,
			state: "complete",
			verdict: "partial",
			report: "/runs/abc/report.md",
			counts: { Blocker: 1, Major: 0, Minor: 1, Nit: 0 },
		});
	});

	it("marks a failed run with the error message and no verdict", () => {
		const s = buildStatus({ ...base, state: "failed", error: new Error("Orienteer A failed (timeout)") });
		expect(s).toMatchObject({ state: "failed", error: "Orienteer A failed (timeout)" });
		expect(s.verdict).toBeUndefined();
		expect(s.counts).toBeUndefined();
	});

	it("handles a non-Error failure value", () => {
		expect(buildStatus({ ...base, state: "failed", error: "plain string" }).error).toBe("plain string");
	});

	it("never leaves the error empty, even with nothing thrown", () => {
		expect(buildStatus({ ...base, state: "failed", error: undefined }).error).toBe("unknown failure");
	});

	it("always carries the charge and both timestamps", () => {
		const s = buildStatus({ ...base, state: "complete", verdict: "met", findings: [] });
		expect(s.charge).toBe("adds retry");
		expect(s.startedAt).toBe("2026-07-28T12:00:00.000Z");
		expect(typeof s.endedAt).toBe("string");
	});

	it("records a null runDir rather than omitting it, when the run never got one", () => {
		expect(buildStatus({ ...base, runDir: null, state: "failed", error: "died early" }).runDir).toBeNull();
	});

	it("defaults a missing verdict rather than emitting undefined", () => {
		expect(buildStatus({ ...base, state: "complete", findings: [] }).verdict).toBe("unclear");
	});

	it("is JSON-serialisable — it is written to disk verbatim", () => {
		const s = buildStatus({ ...base, state: "complete", verdict: "met", findings: [{ severity: "Nit" }] });
		expect(JSON.parse(JSON.stringify(s))).toEqual(s);
	});
});
