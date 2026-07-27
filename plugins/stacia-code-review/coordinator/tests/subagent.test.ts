import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorState } from "../monitor-state.ts";
import type { Monitor, QueryFn, SubagentSpec } from "../subagent.ts";
import { runSubagent, subagentOptions } from "../subagent.ts";

// Unit tests for the failure-shape mapping. No real API calls: `runSubagent`
// takes an injectable `query` so each of the three documented failure shapes
// (plus success, timeout and cancellation) can be driven deterministically.
//
//   1. result subtype === "error_max_structured_output_retries"
//   2. result subtype === "success" with structured_output ABSENT
//   3. query() THROWS after yielding an error result (single-shot mode)
//
// All three must map to null, because the coordinator treats null as failure.

// biome-ignore lint/suspicious/noExplicitAny: opaque SDK message payloads
type Any = any;

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-subagent-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Harness {
	state: MonitorState;
	monitor: Monitor & { applied: unknown[] };
	spec: (over?: Partial<SubagentSpec>) => SubagentSpec;
}

function harness(): Harness {
	const state = new MonitorState();
	const applied: unknown[] = [];
	const monitor: Monitor & { applied: unknown[] } = {
		applied,
		get cancelled() {
			return state.cancelled;
		},
		pushEvent: (a, s) => state.pushEvent(a, s),
		applyEvent: (a, m) => {
			applied.push(m);
			state.applyEvent(a, m);
		},
	};
	return {
		state,
		monitor,
		spec: (over = {}) => ({
			activity: state.registry.get("agent") ?? state.register("agent", "reviewer"),
			monitor,
			model: "claude-sonnet-5",
			cwd: tmpDir,
			systemPrompt: "you are a reviewer",
			userPrompt: "review this",
			schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			timeoutMs: 5000,
			allowedRoots: [tmpDir],
			...over,
		}),
	};
}

const successResult = (structured: unknown) => ({
	type: "result",
	subtype: "success",
	is_error: false,
	structured_output: structured,
});

/** An async-generator stub standing in for the SDK's `query()`. */
function stubQuery(
	messages: unknown[],
	opts: { throwAfter?: unknown; hangUntilAborted?: boolean } = {},
): { fn: QueryFn; calls: Array<{ prompt: string; options?: Any }> } {
	const calls: Array<{ prompt: string; options?: Any }> = [];
	const fn: QueryFn = (params) => {
		calls.push(params as Any);
		return (async function* () {
			for (const m of messages) yield m;
			if (opts.hangUntilAborted) {
				const signal = (params.options as Any)?.abortController?.signal as AbortSignal | undefined;
				await new Promise<void>((resolve) => {
					if (!signal || signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("aborted");
			}
			if (opts.throwAfter !== undefined) throw opts.throwAfter;
		})();
	};
	return { fn, calls };
}

describe("runSubagent — success", () => {
	it("returns the structured output and marks the activity done", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([successResult({ ok: true })]);
		const out = await runSubagent(spec, { query: fn });
		expect(out).toEqual({ ok: true });
		expect(spec.activity.state).toBe("done");
		expect(spec.activity.fail).toBeUndefined();
	});

	it("returns falsy-but-present structured output rather than treating it as failure", async () => {
		// `structured_output: false` / `0` / `""` are legitimate payloads for some
		// schemas; only undefined/null mean "the model never produced one".
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([successResult({ ok: false })]);
		expect(await runSubagent(spec, { query: fn })).toEqual({ ok: false });
		expect(spec.activity.state).toBe("done");
	});
});

describe("runSubagent — failure shape 1: error_max_structured_output_retries", () => {
	it("returns null and records the exhausted retry loop", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([
			{ type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: [] },
		]);
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/retries exhausted/);
	});
});

describe("runSubagent — failure shape 2: success with structured_output absent", () => {
	it("returns null when structured_output is missing entirely", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([{ type: "result", subtype: "success", is_error: false }]);
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/no structured output/i);
	});

	it("returns null when structured_output is null", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([successResult(null)]);
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
	});
});

describe("runSubagent — failure shape 3: query() throws", () => {
	it("returns null when query() throws after yielding an error result", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery(
			[{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] }],
			{ throwAfter: new Error("query failed after error result") },
		);
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		// The result message's reason is more specific than the rethrow, so it wins.
		expect(spec.activity.fail).toMatch(/error_during_execution/);
	});

	it("returns null when query() throws with no result message at all", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([], { throwAfter: new Error("spawn failed") });
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toBe("spawn failed");
	});

	it("returns null when query() throws a non-Error", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([], { throwAfter: "string rejection" });
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.fail).toBe("string rejection");
	});
});

describe("runSubagent — other terminations", () => {
	it("returns null when the stream ends without any result message", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn } = stubQuery([{ type: "assistant", message: { content: [] } }]);
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/no result message/);
	});

	it("times out and returns null", async () => {
		const h = harness();
		const spec = h.spec({ timeoutMs: 20 });
		const { fn } = stubQuery([], { hangUntilAborted: true });
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/^timeout after/);
	});

	it("short-circuits when the run was already cancelled", async () => {
		const h = harness();
		const spec = h.spec();
		h.state.cancelAll();
		let called = false;
		const fn: QueryFn = () => {
			called = true;
			return (async function* () {})();
		};
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(called).toBe(false);
		expect(spec.activity.state).toBe("killed");
		expect(spec.activity.fail).toBe("cancelled");
	});
});

describe("runSubagent — abort plumbing", () => {
	it("parks an AbortController on activity.session so cancelAll()/kill-one can abort it", async () => {
		// MonitorState.cancelAll() calls `a.session?.abort?.()`; an AbortController
		// satisfies that shape, which is why monitor-state.ts needs no change.
		const h = harness();
		const spec = h.spec({ timeoutMs: 5000 });
		let seenSignal: AbortSignal | undefined;
		const fn: QueryFn = (params) => {
			seenSignal = (params.options as Any)?.abortController?.signal;
			return (async function* () {
				// cancelAll() marks every in-flight agent killed and aborts it.
				h.state.cancelAll();
				await new Promise<void>((resolve) => {
					seenSignal?.addEventListener("abort", () => resolve(), { once: true });
					if (seenSignal?.aborted) resolve();
				});
				throw new Error("aborted");
			})();
		};
		expect(await runSubagent(spec, { query: fn })).toBeNull();
		expect(spec.activity.session).toBeInstanceOf(AbortController);
		expect(seenSignal?.aborted).toBe(true);
		expect(spec.activity.state).toBe("killed");
	});

	it("forwards every message to the monitor", async () => {
		const h = harness();
		const spec = h.spec();
		const msgs = [{ type: "system", subtype: "init" }, successResult({ ok: true })];
		const { fn } = stubQuery(msgs);
		await runSubagent(spec, { query: fn });
		expect(h.monitor.applied).toEqual(msgs);
	});
});

describe("subagentOptions", () => {
	it("passes the caller's prompt and options through to query()", async () => {
		const h = harness();
		const spec = h.spec();
		const { fn, calls } = stubQuery([successResult({ ok: true })]);
		await runSubagent(spec, { query: fn });
		expect(calls).toHaveLength(1);
		expect(calls[0].prompt).toBe("review this");
		expect(calls[0].options?.systemPrompt).toBe("you are a reviewer");
		expect(calls[0].options?.model).toBe("claude-sonnet-5");
		expect(calls[0].options?.cwd).toBe(tmpDir);
	});

	it("declares the schema as a json_schema output format", () => {
		const h = harness();
		const spec = h.spec();
		const opts = subagentOptions(spec, new AbortController()) as Any;
		expect(opts.outputFormat).toEqual({ type: "json_schema", schema: spec.schema });
	});

	it("wires the caller's AbortController through", () => {
		const h = harness();
		const controller = new AbortController();
		const opts = subagentOptions(h.spec(), controller) as Any;
		expect(opts.abortController).toBe(controller);
	});

	it("isolates the subagent from ambient skills, plugins and MCP servers", () => {
		// pi's nine-method bareLoader collapses to these.
		const h = harness();
		const opts = subagentOptions(h.spec(), new AbortController()) as Any;
		expect(opts.settingSources).toEqual([]);
		expect(opts.skills).toEqual([]);
		expect(opts.plugins).toEqual([]);
		expect(opts.mcpServers).toEqual({});
	});

	it("uses a plain-string systemPrompt, which fully replaces the default prompt", () => {
		const h = harness();
		const opts = subagentOptions(h.spec(), new AbortController()) as Any;
		expect(typeof opts.systemPrompt).toBe("string");
	});
});
