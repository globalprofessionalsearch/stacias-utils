import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedToolPolicy, READ_ONLY_TOOLS, resolveLikeClaudeCode } from "../confine.ts";
import { MonitorState } from "../monitor-state.ts";
import type { SubagentSpec } from "../subagent.ts";
import { subagentOptions } from "../subagent.ts";

// tests/confine.test.ts exercises the PURE helpers (canonical/within/
// resolveLikeTool) in isolation — and would keep passing while confinement was
// wide open, because the helpers can be perfect and never consulted. These
// tests go through the REAL options object instead: the same
// `subagentOptions()` production uses, the same `canUseTool` callback the SDK
// would invoke, and the same `(toolName, input, options)` arity.

// biome-ignore lint/suspicious/noExplicitAny: SDK Options fields are opaque here
type Any = any;

let repoRoot: string;
let outside: string;

beforeEach(() => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scr-guard-test-")));
	repoRoot = path.join(tmp, "repo");
	outside = path.join(tmp, "elsewhere");
	fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(outside, "secret.txt"), "sekrit\n");
});

afterEach(() => {
	fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
});

function spec(): SubagentSpec {
	const state = new MonitorState();
	return {
		activity: state.register("agent", "reviewer"),
		monitor: { cancelled: false, pushEvent: () => {} },
		model: "claude-sonnet-5",
		cwd: repoRoot,
		systemPrompt: "persona",
		userPrompt: "review",
		schema: { type: "object" },
		timeoutMs: 1000,
		allowedRoots: [repoRoot],
	};
}

/** The guard exactly as the SDK would reach it: off the real options object. */
function guard() {
	const opts = subagentOptions(spec(), new AbortController()) as Any;
	const canUseTool = opts.canUseTool;
	if (typeof canUseTool !== "function") throw new Error("options.canUseTool is not a function");
	return (tool: string, input: Record<string, unknown>) =>
		canUseTool(tool, input, {
			signal: new AbortController().signal,
			toolUseID: "toolu_test",
			requestId: "req_test",
		});
}

describe("options object — the guard's preconditions", () => {
	// The single most dangerous mistake in this port: `allowedTools`
	// AUTO-APPROVES, it does not restrict. Anything listed there never reaches
	// canUseTool, so putting Read/Grep/Glob in it silently disables confinement.
	it("does NOT list Read/Grep/Glob in allowedTools", () => {
		const opts = subagentOptions(spec(), new AbortController()) as Any;
		const allowed: string[] = opts.allowedTools ?? [];
		for (const tool of READ_ONLY_TOOLS) expect(allowed).not.toContain(tool);
		expect(allowed).toEqual([]);
	});

	it("restricts the tool set with `tools`, which is the allow-list that restricts", () => {
		const opts = subagentOptions(spec(), new AbortController()) as Any;
		expect(opts.tools).toEqual([...READ_ONLY_TOOLS]);
	});

	it("sets settingSources: [] so user/project allow-rules cannot pre-approve the call", () => {
		const opts = subagentOptions(spec(), new AbortController()) as Any;
		expect(opts.settingSources).toEqual([]);
	});

	it("does not set a permissionMode that bypasses the prompt flow", () => {
		const opts = subagentOptions(spec(), new AbortController()) as Any;
		expect(opts.permissionMode).toBe("default");
		expect(opts.permissionMode).not.toBe("bypassPermissions");
		expect(opts.permissionMode).not.toBe("acceptEdits");
	});

	it("installs a canUseTool callback at all", () => {
		const opts = subagentOptions(spec(), new AbortController()) as Any;
		expect(typeof opts.canUseTool).toBe("function");
	});
});

describe("Read", () => {
	it("allows a file inside an allowed root", async () => {
		const r = await guard()("Read", { file_path: path.join(repoRoot, "src", "index.ts") });
		expect(r.behavior).toBe("allow");
		expect(r.updatedInput).toEqual({ file_path: path.join(repoRoot, "src", "index.ts") });
	});

	it("allows a relative path that stays inside the root", async () => {
		expect((await guard()("Read", { file_path: "src/index.ts" })).behavior).toBe("allow");
	});

	it("denies a traversal path that escapes the root", async () => {
		const r = await guard()("Read", { file_path: "../elsewhere/secret.txt" });
		expect(r.behavior).toBe("deny");
		expect(r.message).toContain("outside the review's allowed roots");
		expect(r.message).toContain("read-only and confined to the change set's repo(s) and run directory");
	});

	it("denies an absolute path outside the root", async () => {
		expect((await guard()("Read", { file_path: "/etc/passwd" })).behavior).toBe("deny");
	});

	it("denies tilde expansion (the pi bypass #1)", async () => {
		expect((await guard()("Read", { file_path: "~/.ssh/id_rsa" })).behavior).toBe("deny");
	});

	it("denies a file:// URL (the pi bypass #2)", async () => {
		expect((await guard()("Read", { file_path: "file:///etc/passwd" })).behavior).toBe("deny");
	});

	it("denies an @-prefixed path (the pi bypass #3)", async () => {
		expect((await guard()("Read", { file_path: "@/etc/passwd" })).behavior).toBe("deny");
	});

	it("denies a path Claude Code would trim into an escape", async () => {
		// Claude Code's normalizer trims the argument before resolving it; pi's
		// does not. Checking both resolutions catches the divergence.
		expect((await guard()("Read", { file_path: "   /etc/passwd   " })).behavior).toBe("deny");
	});

	it("denies a NUL byte rather than guessing what the tool would open", async () => {
		// The CLI's own resolver throws on NUL, so there is no path to reason about.
		const r = await guard()("Read", { file_path: `${repoRoot}/src/index.ts\u0000/../../../etc/passwd` });
		expect(r.behavior).toBe("deny");
		expect(r.message).toContain("NUL byte");
	});

	it("denies a missing file_path instead of falling through to cwd", async () => {
		expect((await guard()("Read", {})).behavior).toBe("deny");
	});

	it("denies a non-string file_path rather than letting it slide past unexamined", async () => {
		expect((await guard()("Read", { file_path: ["/etc/passwd"] })).behavior).toBe("deny");
		expect((await guard()("Read", { file_path: { toString: () => "/etc/passwd" } })).behavior).toBe("deny");
	});
});

describe("Grep", () => {
	it("allows a search rooted inside the allowed root", async () => {
		expect((await guard()("Grep", { pattern: "export", path: path.join(repoRoot, "src") })).behavior).toBe("allow");
	});

	it("allows an omitted path (defaults to cwd, which is a root)", async () => {
		expect((await guard()("Grep", { pattern: "export" })).behavior).toBe("allow");
	});

	it("denies a search rooted outside the allowed root", async () => {
		const r = await guard()("Grep", { pattern: "sekrit", path: outside });
		expect(r.behavior).toBe("deny");
		expect(r.message).toContain("outside the review's allowed roots");
	});

	it("does NOT path-check `pattern`, which is a regular expression on Grep", async () => {
		// Grep's `pattern` is a regex handed to ripgrep, not a path — it cannot
		// widen the walk. Glob's identically named `pattern` IS a path and IS
		// checked (below); that asymmetry is why the guard's table is per-tool.
		expect((await guard()("Grep", { pattern: "\\.\\./\\.\\./etc/passwd" })).behavior).toBe("allow");
	});

	it("checks the rg --glob filter as defence in depth", async () => {
		expect((await guard()("Grep", { pattern: "x", glob: "*.ts" })).behavior).toBe("allow");
		expect((await guard()("Grep", { pattern: "x", glob: "/etc/*" })).behavior).toBe("deny");
	});
});

describe("Glob", () => {
	it("allows a relative pattern under the root", async () => {
		expect((await guard()("Glob", { pattern: "**/*.ts" })).behavior).toBe("allow");
	});

	it("allows a pattern scoped to a directory inside the root", async () => {
		expect((await guard()("Glob", { pattern: "*.ts", path: path.join(repoRoot, "src") })).behavior).toBe("allow");
	});

	it("denies an ABSOLUTE pattern, which overrides `path` in the tool", async () => {
		// The CLI splits an absolute glob into a search dir + relative pattern and
		// ignores `path` entirely, so a benign `path` does not make it safe.
		const r = await guard()("Glob", { pattern: "/etc/**", path: repoRoot });
		expect(r.behavior).toBe("deny");
	});

	it("denies a traversal pattern", async () => {
		expect((await guard()("Glob", { pattern: "../elsewhere/**" })).behavior).toBe("deny");
	});

	it("denies a search directory outside the root", async () => {
		expect((await guard()("Glob", { pattern: "*.txt", path: outside })).behavior).toBe("deny");
	});
});

describe("tools outside the read-only set", () => {
	it("default-denies anything not in the allow-list", async () => {
		for (const tool of ["Bash", "Write", "Edit", "Task", "WebFetch", "mcp__whatever__do"]) {
			const r = await guard()(tool, { command: "cat /etc/passwd" });
			expect(r.behavior).toBe("deny");
			expect(r.message).toContain("not available to review subagents");
		}
	});

	it("allows StructuredOutput, which carries the result payload and no path", async () => {
		expect((await guard()("StructuredOutput", { ok: true })).behavior).toBe("allow");
	});
});

describe("multiple allowed roots", () => {
	it("admits a second repo root and the run directory", async () => {
		const secondRoot = path.join(path.dirname(repoRoot), "second");
		fs.mkdirSync(secondRoot, { recursive: true });
		fs.writeFileSync(path.join(secondRoot, "a.txt"), "a\n");
		const policy = confinedToolPolicy(repoRoot, [repoRoot, secondRoot]);
		const call = (input: Record<string, unknown>) =>
			policy("Read", input, {
				signal: new AbortController().signal,
				toolUseID: "t",
				requestId: "r",
				// biome-ignore lint/suspicious/noExplicitAny: partial context is enough here
			} as any);
		expect((await call({ file_path: path.join(secondRoot, "a.txt") }))?.behavior).toBe("allow");
		expect((await call({ file_path: path.join(outside, "secret.txt") }))?.behavior).toBe("deny");
	});
});

describe("resolveLikeClaudeCode", () => {
	// Pins the divergences from resolveLikeTool that make the two-resolver check
	// necessary. Claude Code's Li() trims, expands ~, and does NOT strip "@" or
	// understand file:// URLs.
	const home = "/home/tester";

	it("expands a leading ~/", () => {
		expect(resolveLikeClaudeCode("~/.ssh/id_rsa", "/repo", home)).toBe(`${home}/.ssh/id_rsa`);
	});

	it("expands a bare ~", () => {
		expect(resolveLikeClaudeCode("~", "/repo", home)).toBe(home);
	});

	it("trims surrounding whitespace before resolving", () => {
		expect(resolveLikeClaudeCode("  /etc/passwd  ", "/repo", home)).toBe("/etc/passwd");
	});

	it("does NOT strip a leading @, unlike pi", () => {
		expect(resolveLikeClaudeCode("@/etc/passwd", "/repo", home)).toBe("/repo/@/etc/passwd");
	});

	it("does NOT interpret file:// URLs, unlike pi", () => {
		expect(resolveLikeClaudeCode("file:///etc/passwd", "/repo", home)).toBe("/repo/file:/etc/passwd");
	});

	it("resolves an empty argument to the base directory", () => {
		expect(resolveLikeClaudeCode("", "/repo", home)).toBe("/repo");
	});
});
