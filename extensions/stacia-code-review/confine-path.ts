/**
 * Pure path-confinement helpers for B1 (see confine.ts).
 *
 * Node `fs`/`path` only — no pi imports — so this is unit-testable without
 * pulling in the pi tool-definition machinery. `confine.ts` imports
 * `within`/`canonical` from here and wraps the pi read-only tool definitions
 * with them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Unicode space variants pi's `normalizePath` collapses to a regular space
 * (`utils/paths.js` UNICODE_SPACES). Mirrored verbatim.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a tool `path` argument the SAME WAY the underlying read/grep/find/ls
 * tool will resolve it, so the confinement check and the filesystem access
 * agree on which file is meant.
 *
 * This mirrors pi's `resolveToCwd(p, cwd)` →
 * `resolvePath(p, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true })`
 * → `normalizePath` (`utils/paths.js`). We cannot import it: the package's
 * `exports` map only exposes `.` and `./rpc-entry`, so `dist/utils/paths.js`
 * is unreachable.
 *
 * Why this exists: a plain `path.isAbsolute(p) ? p : path.resolve(cwd, p)`
 * disagrees with the tool on three inputs, and each disagreement was a
 * confinement bypass — the guard checked a path inside an allowed root, then
 * the tool expanded the same string back out to somewhere else:
 *
 *   "~/.ssh/id_rsa"       guard saw <cwd>/~/.ssh/id_rsa   tool opened $HOME/.ssh/id_rsa
 *   "file:///etc/passwd"  guard saw <cwd>/file:/etc/passwd  tool opened /etc/passwd
 *   "@/etc/passwd"        guard saw <cwd>/@/etc/passwd    tool opened /etc/passwd
 *
 * Order below is load-bearing and matches `normalizePath`: unicode spaces,
 * then `@`-strip, then `~` expansion (which returns early), then `file://`.
 */
export function resolveLikeTool(input: string, cwd: string, homeDir: string = os.homedir()): string {
	let s = input.replace(UNICODE_SPACES, " ");
	if (s.startsWith("@")) s = s.slice(1);
	if (s === "~") return path.resolve(homeDir);
	if (s.startsWith("~/") || (process.platform === "win32" && s.startsWith("~\\"))) {
		return path.resolve(path.join(homeDir, s.slice(2)));
	}
	if (/^file:\/\//.test(s)) return path.resolve(fileURLToPath(s));
	if (path.isAbsolute(s)) return path.resolve(s);
	// pi normalizes the base dir too (tilde only — no @-strip, no space folding).
	// In practice cwd is always an absolute repo root, so this is a no-op.
	const base = cwd === "~" ? homeDir : cwd.startsWith("~/") ? path.join(homeDir, cwd.slice(2)) : cwd;
	return path.resolve(base, s);
}

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
