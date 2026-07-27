/**
 * B1: filesystem confinement for read-only subagents.
 *
 * The diff under review is attacker-authorable and is fed to the agents as
 * context, so a prompt-injection payload could otherwise steer read/grep/find/ls
 * to open ~/.ssh, .env, etc. and surface secrets in findings. We reuse the real
 * built-in read-only tool *definitions* (so grep/find behavior is unchanged) and
 * wrap each execute() with a path guard: any `path` argument must resolve inside
 * an allow-list of roots (the change set's repo roots + the run dir). Anything
 * outside is denied with a tool error the agent sees.
 */

import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { canonical, resolveLikeTool, within } from "./confine-path.ts";

// biome-ignore lint/suspicious/noExplicitAny: tool defs / params are opaque here
type Any = any;

// Audited param surface: read/grep/find/ls schemas each expose exactly one
// path-bearing param, `path` (optional on grep/find/ls, required on read).
//
// `glob` on grep is a ripgrep --glob filter over the walk rooted at `path`; it
// cannot widen the root, so it needs no separate check. `pattern` on find is
// rooted at `path` on the fd/rg backend, but find's FALLBACK backend hands the
// pattern to the node `glob` package, which honors `..` segments — that path is
// UNAUDITED and may be an escape vector. If a future pi version adds another
// path-shaped param, extend the check below.
//
// Note the guard must resolve `path` exactly as the tool does; see
// resolveLikeTool in confine-path.ts for why re-implementing that resolution
// was itself the bug.
function guard(def: Any, cwd: string, roots: string[]): ToolDefinition {
	const orig = def.execute.bind(def);
	return {
		...def,
		execute: async (id: string, params: Any, signal: Any, onUpdate: Any, ctx: Any) => {
			const p = params?.path;
			if (typeof p === "string" && p.length > 0) {
				// MUST resolve the way the wrapped tool will (resolveLikeTool mirrors pi's
				// resolveToCwd). Using path.resolve here let "~/.ssh/id_rsa", "file:///etc/passwd"
				// and "@/etc/passwd" pass the check and then escape it — see confine-path.ts.
				const abs = resolveLikeTool(p, cwd);
				if (!within(abs, roots)) {
					throw new Error(
						`access denied: "${p}" is outside the review's allowed roots. ` +
							`Subagents are read-only and confined to the change set's repo(s) and run directory.`,
					);
				}
			}
			return orig(id, params, signal, onUpdate, ctx);
		},
	};
}

/** Read-only tools (read/grep/find/ls) confined to `allowedRoots`. */
export function confinedReadOnlyTools(cwd: string, allowedRoots: string[]): ToolDefinition[] {
	const roots = allowedRoots.map(canonical);
	return [
		guard(createReadToolDefinition(cwd), cwd, roots),
		guard(createGrepToolDefinition(cwd), cwd, roots),
		guard(createFindToolDefinition(cwd), cwd, roots),
		guard(createLsToolDefinition(cwd), cwd, roots),
	];
}
