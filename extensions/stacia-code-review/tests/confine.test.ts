import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonical, within } from "../confine-path.ts";

// These tests exercise the PURE confine-path helpers directly — no pi
// imports, no tool wrapping — per self-review-2-delegation.md's A2 scope.

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-confine-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("within", () => {
	it("denies a path outside allowedRoots", () => {
		const root = fs.mkdtempSync(path.join(tmpDir, "root-"));
		const outside = fs.mkdtempSync(path.join(tmpDir, "outside-"));
		const target = path.join(outside, "secret.txt");
		fs.writeFileSync(target, "nope");

		expect(within(target, [canonical(root)])).toBe(false);
	});

	it("allows a path inside allowedRoots", () => {
		const root = fs.mkdtempSync(path.join(tmpDir, "root-"));
		const target = path.join(root, "file.txt");
		fs.writeFileSync(target, "ok");

		expect(within(target, [canonical(root)])).toBe(true);
	});

	it("resolves a symlinked root equivalently (macOS /tmp -> /private/tmp style)", () => {
		const real = fs.mkdtempSync(path.join(tmpDir, "real-"));
		const target = path.join(real, "file.txt");
		fs.writeFileSync(target, "ok");

		const linkPath = path.join(tmpDir, "link-to-real");
		fs.symlinkSync(real, linkPath);

		// Root given as the symlink path; target accessed through the symlink too.
		const rootViaLink = canonical(linkPath);
		const targetViaLink = path.join(linkPath, "file.txt");

		expect(within(targetViaLink, [rootViaLink])).toBe(true);
		// Root given via symlink, target given via its real (already-resolved) path.
		expect(within(target, [rootViaLink])).toBe(true);
	});

	it("rejects a sibling-prefix collision: /root/repo must not allow /root/repo-evil", () => {
		const base = fs.mkdtempSync(path.join(tmpDir, "base-"));
		const repo = path.join(base, "repo");
		const repoEvil = path.join(base, "repo-evil");
		fs.mkdirSync(repo);
		fs.mkdirSync(repoEvil);
		const evilTarget = path.join(repoEvil, "secret.txt");
		fs.writeFileSync(evilTarget, "nope");

		// A naive `t.startsWith(root)` check (without the path.sep suffix) would
		// wrongly allow this, since "/root/repo-evil" startsWith "/root/repo".
		expect(within(evilTarget, [canonical(repo)])).toBe(false);
		// The root itself, and real children of it, are still allowed.
		expect(within(repo, [canonical(repo)])).toBe(true);
		const repoChild = path.join(repo, "file.txt");
		fs.writeFileSync(repoChild, "ok");
		expect(within(repoChild, [canonical(repo)])).toBe(true);
	});

	it("resolves a relative path against cwd", () => {
		const root = fs.mkdtempSync(path.join(tmpDir, "root-"));
		fs.writeFileSync(path.join(root, "file.txt"), "ok");

		const prevCwd = process.cwd();
		process.chdir(root);
		try {
			expect(within(path.resolve("file.txt"), [canonical(root)])).toBe(true);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("passes the guard for a not-yet-existing path under an allowed root (ancestor-canonicalization branch)", () => {
		const root = fs.mkdtempSync(path.join(tmpDir, "root-"));
		const notYetExisting = path.join(root, "new-subdir", "new-file.txt");

		expect(fs.existsSync(notYetExisting)).toBe(false);
		expect(within(notYetExisting, [canonical(root)])).toBe(true);
	});

	it("still denies a not-yet-existing sibling-prefix path outside the root", () => {
		const base = fs.mkdtempSync(path.join(tmpDir, "base-"));
		const repo = path.join(base, "repo");
		fs.mkdirSync(repo);
		const notYetExisting = path.join(base, "repo-evil", "new-file.txt");

		expect(within(notYetExisting, [canonical(repo)])).toBe(false);
	});
});

describe("canonical", () => {
	it("returns an absolute, symlink-free path for an existing target", () => {
		const real = fs.mkdtempSync(path.join(tmpDir, "real-"));
		expect(canonical(real)).toBe(fs.realpathSync(real));
	});

	it("re-appends the missing tail for a not-yet-existing path under an existing ancestor", () => {
		const root = fs.mkdtempSync(path.join(tmpDir, "root-"));
		const missing = path.join(root, "a", "b", "c.txt");
		const result = canonical(missing);
		expect(result).toBe(path.join(fs.realpathSync(root), "a", "b", "c.txt"));
	});

	it("is idempotent / cache-safe: repeated calls for the same root agree", () => {
		const root = fs.mkdtempSync(path.join(tmpDir, "root-"));
		const first = canonical(root);
		const second = canonical(root);
		expect(second).toBe(first);
		expect(second).toBe(fs.realpathSync(root));
	});
});
