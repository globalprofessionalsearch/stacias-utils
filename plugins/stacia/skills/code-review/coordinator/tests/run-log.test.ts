import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NULL_LOG, RunLog } from "../run-log.ts";

// The TUI's event log is a ring buffer that dies with the process. This is the
// durable copy, and it matters most when a run fails — so the overriding rule
// is that logging must never itself be able to fail a review.

let tmpDir: string;
const at = () => new Date("2026-07-27T12:00:00.000Z");

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-log-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Collect lines instead of writing, so records can be asserted structurally. */
function capture(): { log: RunLog; lines: string[] } {
	const lines: string[] = [];
	return { log: new RunLog(null, { sink: (l) => lines.push(l), now: at }), lines };
}

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l));

describe("RunLog — record shape", () => {
	it("writes one JSON object per line, newline-terminated", () => {
		const { log, lines } = capture();
		log.info("a");
		log.info("b");
		expect(lines).toHaveLength(2);
		for (const l of lines) expect(l.endsWith("\n")).toBe(true);
		expect(parse(lines).map((r) => r.event)).toEqual(["a", "b"]);
	});

	it("stamps every record with an ISO timestamp and level", () => {
		const { log, lines } = capture();
		log.info("x");
		expect(parse(lines)[0]).toMatchObject({ ts: "2026-07-27T12:00:00.000Z", level: "info", event: "x" });
	});

	it("merges arbitrary fields into the record", () => {
		const { log, lines } = capture();
		log.info("agent.event", { agent: "security", role: "security", text: "> Read" });
		expect(parse(lines)[0]).toMatchObject({ agent: "security", role: "security", text: "> Read" });
	});

	it("records levels distinctly", () => {
		const { log, lines } = capture();
		log.info("i");
		log.warn("w");
		log.fail("e", new Error("boom"));
		expect(parse(lines).map((r) => r.level)).toEqual(["info", "warn", "error"]);
	});

	it("captures an Error's message and stack under stable keys", () => {
		const { log, lines } = capture();
		log.fail("run.failed", new Error("orienteer timed out"));
		const r = parse(lines)[0];
		expect(r.message).toBe("orienteer timed out");
		expect(r.stack).toContain("orienteer timed out");
	});

	it("handles a non-Error thrown value", () => {
		const { log, lines } = capture();
		log.fail("run.failed", "just a string");
		expect(parse(lines)[0].message).toBe("just a string");
	});
});

describe("RunLog — must never fail the review", () => {
	it("drops unserializable fields rather than throwing", () => {
		const { log, lines } = capture();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => log.info("weird", { circular })).not.toThrow();
		expect(parse(lines)[0]).toMatchObject({ event: "weird", note: "fields dropped (unserializable)" });
	});

	it("latches a sink failure and stops writing instead of throwing", () => {
		let calls = 0;
		const log = new RunLog(null, {
			now: at,
			sink: () => {
				calls++;
				throw new Error("ENOSPC");
			},
		});
		expect(() => log.info("first")).not.toThrow();
		expect(log.error).toBe("ENOSPC");
		expect(() => log.info("second")).not.toThrow();
		expect(calls).toBe(1); // gave up after the first failure
	});

	it("an unwritable path degrades to a no-op rather than throwing at construction", () => {
		const log = new RunLog(path.join(tmpDir, "no", "such", "dir", "run.jsonl"));
		expect(() => log.info("x")).not.toThrow();
	});

	it("NULL_LOG accepts everything and reports no error", () => {
		expect(() => NULL_LOG.info("x", { a: 1 })).not.toThrow();
		expect(NULL_LOG.error).toBeNull();
	});

	it("close() is safe to call twice", async () => {
		const { log } = capture();
		await log.close();
		await expect(log.close()).resolves.toBeUndefined();
	});
});

describe("RunLog — real file", () => {
	it("appends to the given path and survives close", async () => {
		const p = path.join(tmpDir, "run.jsonl");
		const log = new RunLog(p, { now: at });
		log.info("run.start", { runDir: "/tmp/x" });
		log.warn("run.cancel", { reason: "Orienteer A failed" });
		await log.close();

		const records = parse(fs.readFileSync(p, "utf8").trimEnd().split("\n"));
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ event: "run.start", runDir: "/tmp/x" });
		expect(records[1]).toMatchObject({ level: "warn", reason: "Orienteer A failed" });
	});

	it("appends rather than truncating, so a reopened log keeps history", async () => {
		const p = path.join(tmpDir, "run.jsonl");
		const a = new RunLog(p, { now: at });
		a.info("one");
		await a.close();
		const b = new RunLog(p, { now: at });
		b.info("two");
		await b.close();
		expect(fs.readFileSync(p, "utf8").trimEnd().split("\n")).toHaveLength(2);
	});
});
