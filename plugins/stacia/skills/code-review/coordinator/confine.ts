/**
 * B1: filesystem confinement for read-only subagents, as a `canUseTool` guard.
 *
 * The diff under review is attacker-authorable and is fed to the agents as
 * context, so a prompt-injection payload could otherwise steer Read/Grep/Glob
 * to open ~/.ssh, .env, etc. and surface secrets in findings. The pi version
 * wrapped each tool's `execute()`; on the Agent SDK the equivalent hook is
 * `Options.canUseTool`, which sees EVERY tool call with its full input object
 * — strictly stronger than pi's single hand-picked `params.path`.
 *
 * Two invariants make this guard load-bearing rather than decorative, and both
 * live in the options object built by subagent.ts, not here:
 *
 *   - Read/Grep/Glob must NOT appear in `allowedTools`. `allowedTools`
 *     auto-approves; `canUseTool` is only consulted when the permission flow
 *     falls through to a prompt. Listing them there turns this file off
 *     silently. `tools` is the restricting allow-list; `allowedTools` is not.
 *   - `settingSources: []` must be set, or the operator's own
 *     ~/.claude/settings.json allow-rules auto-approve the call and this guard
 *     is never invoked.
 *
 * tests/confine-guard.test.ts pins both through the real options object.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { canonical, resolveLikeTool, within } from "./confine-path.ts";

// biome-ignore lint/suspicious/noExplicitAny: tool inputs are opaque JSON here
type Any = any;

/** The only tools a review subagent may call. Mirrored into `Options.tools`. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

export const SUBMIT_SERVER_NAME = "review";
export const SUBMIT_TOOL_NAME = "submit_result";
export const SUBMIT_MCP_TOOL = `mcp__${SUBMIT_SERVER_NAME}__${SUBMIT_TOOL_NAME}`;

const PATHLESS_TOOLS = new Set([SUBMIT_MCP_TOOL]);

/**
 * Which inputs of each allowed tool are path-shaped, verified against
 * `sdk-tools.d.ts` (`FileReadInput`, `GrepInput`, `GlobInput`) and against the
 * tool implementations in the bundled Claude Code binary:
 *
 *   Read   `file_path`  required, absolute-ish; resolved with the CLI's `Li()`.
 *   Glob   `pattern`    required. NOT a regex — it is a path glob, and an
 *                       ABSOLUTE pattern overrides `path` entirely (the CLI
 *                       splits it into a search dir + relative pattern), so it
 *                       is an escape vector and must be checked.
 *          `path`       optional search directory.
 *   Grep   `path`       optional; rg's PATH argument.
 *          `glob`       optional; maps to `rg --glob`, a filter over the walk
 *                       rooted at `path` that cannot widen it. Checked anyway
 *                       as defence in depth — it costs nothing and normal
 *                       globs ("*.ts", "**\/*.{ts,tsx}") resolve under cwd.
 *          `pattern`    a REGULAR EXPRESSION, deliberately NOT path-checked.
 *                       Grep and Glob both call their first argument
 *                       `pattern` and they mean different things; that is why
 *                       this table is per-tool rather than a name sweep.
 */
const PATH_PARAMS: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
	Read: { required: ["file_path"], optional: [] },
	Grep: { required: [], optional: ["path", "glob"] },
	Glob: { required: ["pattern"], optional: ["path"] },
};

const CONFINEMENT_NOTE =
	"Subagents are read-only and confined to the change set's repo(s) and run directory.";

/**
 * Resolve a tool path argument the way CLAUDE CODE resolves it.
 *
 * Mirrors `Li(input, base)` in the bundled Claude Code binary (v2.1.220), the
 * normalizer every path-bearing tool routes through:
 *
 *   throw on NUL; trim(); "" -> normalize(base); "~" -> homedir();
 *   "~/x" -> join(home, x); absolute -> normalize(); else resolve(base, s);
 *   and NFC-normalize the result.
 *
 * This is NOT the same as `resolveLikeTool()` in confine-path.ts, which mirrors
 * *pi's* `resolveToCwd`. The two disagree on four inputs — see
 * `pathCandidates()` for how that is handled.
 */
export function resolveLikeClaudeCode(input: string, base: string, homeDir: string = os.homedir()): string {
	const s = input.trim();
	if (!s) return path.normalize(base).normalize("NFC");
	if (s === "~") return path.resolve(homeDir).normalize("NFC");
	if (s.startsWith("~/")) return path.resolve(path.join(homeDir, s.slice(2))).normalize("NFC");
	if (path.isAbsolute(s)) return path.normalize(s).normalize("NFC");
	return path.resolve(base, s).normalize("NFC");
}

/**
 * Every filesystem location the input string could plausibly denote.
 *
 * `resolveLikeTool` (pi) and `resolveLikeClaudeCode` (Claude Code) agree on
 * absolute paths, plain relative paths and `~/...`, and diverge on:
 *
 *   "@/etc/passwd"        pi strips "@"           CC does not
 *   "file:///etc/passwd"  pi calls fileURLToPath  CC does not
 *   "  /etc/passwd  "     pi keeps the spaces      CC trims (String.trim)
 *   U+00A0 & friends      pi folds them to " "     CC leaves them, except
 *                         anywhere in the string   at the ends via trim()
 *
 * Rather than pick one and be wrong the day a tool's resolution changes, the
 * guard checks BOTH and denies if EITHER lands outside the allowed roots. That
 * is fail-closed by construction. It cannot produce false denials for ordinary
 * inputs: both resolvers keep a relative path underneath `base`, and both
 * leave an in-root absolute path alone.
 *
 * This also covers the fact that Claude Code backfills only SOME inputs before
 * the permission flow runs — Read's `file_path` arrives here already expanded
 * to `Li(file_path)`, while Grep's and Glob's arrive raw. Both resolvers are
 * idempotent on an already-absolute path, so the guard is correct either way.
 */
function pathCandidates(raw: string, base: string): string[] {
	const cc = resolveLikeClaudeCode(raw, base);
	const pi = resolveLikeTool(raw, base);
	return cc === pi ? [cc] : [cc, pi];
}

const denyOutside = (raw: string): PermissionResult => ({
	behavior: "deny",
	message: `access denied: "${raw}" is outside the review's allowed roots. ${CONFINEMENT_NOTE}`,
});

/**
 * Decide one tool call. Exported for direct unit testing; production code
 * should go through `confinedToolPolicy()` so the roots are canonicalized once.
 */
export function decideToolCall(
	toolName: string,
	input: Record<string, unknown> | undefined,
	cwd: string,
	canonicalRoots: string[],
): PermissionResult {
	if (PATHLESS_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: (input ?? {}) as Any };

	const spec = PATH_PARAMS[toolName];
	if (!spec) {
		// Default-deny. `Options.tools` already restricts the base tool set; this
		// is the second line so that anything the harness adds later (Bash, Task,
		// an MCP tool) cannot reach the filesystem unreviewed.
		return {
			behavior: "deny",
			message: `access denied: the ${toolName} tool is not available to review subagents. ${CONFINEMENT_NOTE}`,
		};
	}

	const args = input ?? {};
	const str = (key: string): string | undefined => {
		const v = args[key];
		return typeof v === "string" && v.length > 0 ? v : undefined;
	};

	for (const key of [...spec.required, ...spec.optional]) {
		const v = args[key];
		if (v === undefined || v === null) continue;
		// Anything non-string here is rejected by the tool's own zod schema, but
		// the guard must not let it slide past unexamined on the way there.
		if (typeof v !== "string") {
			return {
				behavior: "deny",
				message: `access denied: "${key}" must be a string path. ${CONFINEMENT_NOTE}`,
			};
		}
		// A NUL byte makes the CLI's own resolver throw; there is no path to
		// reason about, so refuse rather than guess.
		if (v.includes("\0")) {
			return {
				behavior: "deny",
				message: `access denied: "${key}" contains a NUL byte. ${CONFINEMENT_NOTE}`,
			};
		}
	}

	// `path`, when present, is the base the other path-shaped inputs resolve
	// against (rg's PATH / the glob search dir), so it is checked first.
	const rawBase = spec.required.includes("path") || spec.optional.includes("path") ? str("path") : undefined;
	if (rawBase !== undefined) {
		for (const abs of pathCandidates(rawBase, cwd)) {
			if (!within(abs, canonicalRoots)) return denyOutside(rawBase);
		}
	}
	const base = rawBase === undefined ? cwd : resolveLikeClaudeCode(rawBase, cwd);

	for (const key of spec.required) {
		if (key === "path") {
			if (rawBase === undefined) {
				return {
					behavior: "deny",
					message: `access denied: ${toolName} requires a "path" argument. ${CONFINEMENT_NOTE}`,
				};
			}
			continue;
		}
		const raw = str(key);
		if (raw === undefined) {
			return {
				behavior: "deny",
				message: `access denied: ${toolName} requires a "${key}" argument. ${CONFINEMENT_NOTE}`,
			};
		}
		for (const abs of pathCandidates(raw, base)) {
			if (!within(abs, canonicalRoots)) return denyOutside(raw);
		}
	}

	for (const key of spec.optional) {
		if (key === "path") continue; // already checked above, against cwd
		const raw = str(key);
		if (raw === undefined) continue;
		for (const abs of pathCandidates(raw, base)) {
			if (!within(abs, canonicalRoots)) return denyOutside(raw);
		}
	}

	return { behavior: "allow", updatedInput: args as Any };
}

/**
 * A `canUseTool` policy that confines Read/Grep/Glob to `allowedRoots` (the
 * change set's repo roots + the run directory) and denies every other tool.
 *
 * The deny `message` is shown to the subagent, so it explains the boundary
 * rather than just refusing — the same wording the pi tool-error carried.
 */
export function confinedToolPolicy(cwd: string, allowedRoots: string[]): CanUseTool {
	const roots = allowedRoots.map(canonical);
	return async (toolName, input) => decideToolCall(toolName, input, cwd, roots);
}
