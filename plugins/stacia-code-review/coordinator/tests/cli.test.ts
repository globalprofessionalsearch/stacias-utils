import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, readRequest, userConfigPath } from "../cli.ts";

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
