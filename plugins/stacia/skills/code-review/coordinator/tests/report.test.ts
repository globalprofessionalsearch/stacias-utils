import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tests the JSON inliner (render_report_html.py) produces a page that:
 * 1. Parses back to the same data (no loss from escaping)
 * 2. Cannot be broken out of by attacker-influenced findings text
 *
 * These are the replacement for the marked+DOMPurify tests (ADR-0005), which
 * tested a sanitization pipeline that no longer exists. The new template uses
 * Vue text interpolation ({{ }}) with no v-html, so there is no HTML parsing
 * to sanitize. The remaining risk is the JSON data island: a finding
 * containing `</script>` could terminate the tag and inject markup. The
 * inliner escapes `<` to `\u003c`; these tests verify that.
 */

const HELPER_DIR = path.resolve(__dirname, "../helper");
const INLINER = path.join(HELPER_DIR, "render_report_html.py");
const SAMPLE = path.join(HELPER_DIR, "report.sample.json");

function renderFixture(): string {
	const { execFileSync } = require("node:child_process");
	const out = path.join(__dirname, "../../.report-test-out.html");
	execFileSync("python3", [INLINER, SAMPLE, out]);
	const html = fs.readFileSync(out, "utf8");
	fs.unlinkSync(out);
	return html;
}

function extractIsland(html: string): string {
	const start = html.indexOf('id="review-data">') + 'id="review-data">'.length;
	const end = html.indexOf("</script>", start);
	return html.slice(start, end);
}

describe("report HTML — data island integrity", () => {
	let html: string;
	let island: string;

	it("renders without error", () => {
		html = renderFixture();
		expect(html).toBeTruthy();
	});

	it("the data island is valid JSON and round-trips the fixture", () => {
		island = extractIsland(html);
		const parsed = JSON.parse(island);
		const original = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
		expect(parsed.verdict).toBe(original.verdict);
		expect(parsed.consolidated_findings.length).toBe(original.consolidated_findings.length);
	});

	it("the </script> in the fixture's evidence is escaped in the island", () => {
		expect(island).not.toContain("</script>");
		expect(island).toContain("\\u003c/script\\u003e");
	});

	it("the escaped value parses back to the literal </script> string", () => {
		const parsed = JSON.parse(island);
		const nasty = parsed.consolidated_findings.find((f: { evidence?: string }) => f.evidence && f.evidence.includes("</script>"));
		expect(nasty).toBeTruthy();
		expect(nasty.evidence).toContain("</script>");
	});

	it("no v-html directive appears in the page markup", () => {
		// The comment explaining why v-html must not be used naturally mentions
		// the word; match only the attribute form (v-html=) which is the actual risk.
		expect(html).not.toMatch(/v-html\s*=/);
	});
});
