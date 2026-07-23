/**
 * Pure path-confinement helpers for B1 (see confine.ts).
 *
 * Node `fs`/`path` only — no pi imports — so this is unit-testable without
 * pulling in the pi tool-definition machinery. `confine.ts` imports
 * `within`/`canonical` from here and wraps the pi read-only tool definitions
 * with them.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// P4 perf: memoize canonical() by resolved input path, and by every existing
// ancestor realpath'd along the way. `confinedReadOnlyTools()` re-canonicalizes
// the same `allowedRoots` once per subagent (same repo roots, called
// repeatedly within one review run), and guard() re-checks paths under those
// roots on every read/grep/find/ls call. Both cases skip the
// fs.existsSync/realpathSync work entirely once an absolute path — or an
// ancestor of it — has already been canonicalized: the ancestor-walk below
// checks the cache before touching the filesystem, so a not-yet-existing
// target under an already-canonicalized root stops at the cached ancestor
// instead of re-stat'ing it.
const canonicalCache = new Map<string, string>();

/**
 * Resolve `p` to its canonical (symlink-free, absolute) form.
 *
 * realpath an existing path; for a missing path, realpath its nearest
 * existing ancestor and re-append the rest. This keeps symlinked roots (e.g.
 * macOS /tmp -> /private/tmp) consistent between roots and not-yet-existing
 * targets.
 */
export function canonical(p: string): string {
	const resolved = path.resolve(p);
	const memoized = canonicalCache.get(resolved);
	if (memoized !== undefined) return memoized;

	let cur = resolved;
	const tail: string[] = [];
	while (true) {
		const cachedAncestor = canonicalCache.get(cur);
		if (cachedAncestor !== undefined) {
			const result = tail.length ? path.join(cachedAncestor, ...tail) : cachedAncestor;
			canonicalCache.set(resolved, result);
			return result;
		}
		if (fs.existsSync(cur)) break;
		const parent = path.dirname(cur);
		if (parent === cur) return resolved;
		tail.unshift(path.basename(cur));
		cur = parent;
	}
	try {
		const real = fs.realpathSync(cur);
		canonicalCache.set(cur, real);
		const result = tail.length ? path.join(real, ...tail) : real;
		canonicalCache.set(resolved, result);
		return result;
	} catch {
		return resolved;
	}
}

/** True if `target`'s canonical form equals one of `roots`, or lies within it. */
export function within(target: string, roots: string[]): boolean {
	const t = canonical(target);
	return roots.some((root) => t === root || t.startsWith(root + path.sep));
}
