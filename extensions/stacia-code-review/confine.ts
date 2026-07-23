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

import * as path from "node:path";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { canonical, within } from "./confine-path.ts";

// biome-ignore lint/suspicious/noExplicitAny: tool defs / params are opaque here
type Any = any;

// Audited param surface: read/grep/find/ls schemas each expose exactly one
// path-bearing param, `path` (optional on grep/find/ls, required on read).
// Their other string params (`pattern` on grep/find, `glob` on grep) are
// filename-matching patterns evaluated relative to `path`/cwd, not raw
// filesystem locations, so they don't need a separate guard check. If a
// future pi version adds another path-shaped param to one of these tools,
// extend the check below.
function guard(def: Any, cwd: string, roots: string[]): ToolDefinition {
	const orig = def.execute.bind(def);
	return {
		...def,
		execute: async (id: string, params: Any, signal: Any, onUpdate: Any, ctx: Any) => {
			const p = params?.path;
			if (typeof p === "string" && p.length > 0) {
				const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
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
