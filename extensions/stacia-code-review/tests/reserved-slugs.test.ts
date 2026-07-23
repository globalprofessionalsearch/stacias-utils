import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Cross-file consistency check: the Python helper reserves certain slugs so a
// repo can never collide with a fixed (non-repo) findings file the TS side
// writes. This test has no import-time coupling between the two languages —
// it reads both source files as text and cross-checks them, so it fails loudly
// if either side changes without the other being updated.

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pythonHelperPath = join(extDir, "helper", "code-review-workdir.py");
const indexTsPath = join(extDir, "index.ts");

function readReservedSlugs(pythonSource: string): string[] {
	const match = pythonSource.match(/RESERVED_SLUGS\s*=\s*\{([^}]*)\}/);
	if (!match) throw new Error("RESERVED_SLUGS set not found in code-review-workdir.py");
	const body = match[1];
	const slugs = [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
	if (slugs.length === 0) throw new Error("RESERVED_SLUGS set is empty or unparseable");
	return slugs;
}

function readWriteFindingsSlugs(tsSource: string): string[] {
	// Matches writeFindings(<helper>, <runDir>, "<slug>", ...) — the slug is the
	// third positional argument and, for the fixed (non-repo) call sites, is a
	// string literal rather than a variable.
	const calls = [...tsSource.matchAll(/writeFindings\(\s*[^,]+,\s*[^,]+,\s*["']([^"']+)["']/g)];
	return calls.map((m) => m[1]);
}

describe("reserved slug consistency (Python RESERVED_SLUGS vs TS write-findings)", () => {
	it("Python RESERVED_SLUGS contains 'synthesis'", () => {
		const pythonSource = readFileSync(pythonHelperPath, "utf8");
		const reserved = readReservedSlugs(pythonSource);
		expect(reserved).toContain("synthesis");
	});

	it("the fixed non-repo slug the TS side writes via writeFindings is exactly 'synthesis'", () => {
		const tsSource = readFileSync(indexTsPath, "utf8");
		const fixedSlugs = readWriteFindingsSlugs(tsSource);
		expect(fixedSlugs.length).toBeGreaterThan(0);
		for (const slug of fixedSlugs) {
			expect(slug).toBe("synthesis");
		}
	});

	it("every fixed slug the TS side writes is covered by the Python RESERVED_SLUGS set", () => {
		const pythonSource = readFileSync(pythonHelperPath, "utf8");
		const tsSource = readFileSync(indexTsPath, "utf8");
		const reserved = new Set(readReservedSlugs(pythonSource));
		const fixedSlugs = readWriteFindingsSlugs(tsSource);
		expect(fixedSlugs.length).toBeGreaterThan(0);
		for (const slug of fixedSlugs) {
			expect(reserved.has(slug)).toBe(true);
		}
	});
});
