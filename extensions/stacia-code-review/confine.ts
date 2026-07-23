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

import * as fs from "node:fs";
import * as path from "node:path";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noExplicitAny: tool defs / params are opaque here
type Any = any;

// realpath an existing path; for a missing path, realpath its nearest existing
// ancestor and re-append the rest. This keeps symlinked roots (e.g. macOS
// /tmp -> /private/tmp) consistent between roots and not-yet-existing targets.
function canonical(p: string): string {
	let cur = path.resolve(p);
	const tail: string[] = [];
	while (!fs.existsSync(cur)) {
		const parent = path.dirname(cur);
		if (parent === cur) return path.resolve(p);
		tail.unshift(path.basename(cur));
		cur = parent;
	}
	try {
		const real = fs.realpathSync(cur);
		return tail.length ? path.join(real, ...tail) : real;
	} catch {
		return path.resolve(p);
	}
}

function within(target: string, roots: string[]): boolean {
	const t = canonical(target);
	return roots.some((root) => t === root || t.startsWith(root + path.sep));
}

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
