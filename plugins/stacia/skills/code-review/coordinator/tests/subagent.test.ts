import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorState } from "../monitor-state.ts";
import type { Monitor, QueryFn, ResultHolder, SubagentSpec } from "../subagent.ts";
import { createResultHolder, createSubmitResultServer, runSubagent, schemaToZodShape, subagentOptions } from "../subagent.ts";
import { SUBMIT_MCP_TOOL } from "../confine.ts";

// Unit tests for the failure-shape mapping. No real API calls: `runSubagent`
// takes an injectable `query` and `resultHolder` so each failure mode
// (plus success, timeout and cancellation) can be driven deterministically.

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

const successResult = () => ({
	type: "result",
	subtype: "success",
	is_error: false,
});

describe("runSubagent — success", () => {
	it("returns the captured result and marks the activity done", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		holder.value = { ok: true };
		const { fn } = stubQuery([successResult()]);
		const out = await runSubagent(spec, { query: fn, resultHolder: holder });
		expect(out).toEqual({ ok: true });
		expect(spec.activity.state).toBe("done");
		expect(spec.activity.fail).toBeUndefined();
	});

	it("returns falsy-but-present result rather than treating it as failure", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		holder.value = { ok: false };
		const { fn } = stubQuery([successResult()]);
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toEqual({ ok: false });
		expect(spec.activity.state).toBe("done");
	});
});

describe("runSubagent — submit_result never called", () => {
	it("returns null when the agent finishes without calling submit_result", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		const { fn } = stubQuery([successResult()]);
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/never called submit_result/);
	});
});

describe("runSubagent — validation failures exhausted", () => {
	it("returns null when all attempts fail validation", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		holder.attempts = 5;
		holder.lastErrors = ['$: missing required "ok"'];
		const { fn } = stubQuery([successResult()]);
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/submit_result validation failed after 5 attempt/);
	});
});

describe("runSubagent — query errors", () => {
	it("returns null when query() throws after yielding an error result", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		const { fn } = stubQuery(
			[{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] }],
			{ throwAfter: new Error("query failed after error result") },
		);
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/error_during_execution/);
	});

	it("returns null when query() throws with no result message at all", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		const { fn } = stubQuery([], { throwAfter: new Error("spawn failed") });
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toBe("spawn failed");
	});

	it("returns null when query() throws a non-Error", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		const { fn } = stubQuery([], { throwAfter: "string rejection" });
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.fail).toBe("string rejection");
	});
});

describe("runSubagent — other terminations", () => {
	it("returns null when the stream ends without any result message", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		const { fn } = stubQuery([{ type: "assistant", message: { content: [] } }]);
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.state).toBe("failed");
		expect(spec.activity.fail).toMatch(/never called submit_result/);
	});

	it("times out and returns null", async () => {
		const h = harness();
		const spec = h.spec({ timeoutMs: 20 });
		const holder = createResultHolder();
		const { fn } = stubQuery([], { hangUntilAborted: true });
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
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
		const h = harness();
		const spec = h.spec({ timeoutMs: 5000 });
		const holder = createResultHolder();
		let seenSignal: AbortSignal | undefined;
		const fn: QueryFn = (params) => {
			seenSignal = (params.options as Any)?.abortController?.signal;
			return (async function* () {
				h.state.cancelAll();
				await new Promise<void>((resolve) => {
					seenSignal?.addEventListener("abort", () => resolve(), { once: true });
					if (seenSignal?.aborted) resolve();
				});
				throw new Error("aborted");
			})();
		};
		expect(await runSubagent(spec, { query: fn, resultHolder: holder })).toBeNull();
		expect(spec.activity.session).toBeInstanceOf(AbortController);
		expect(seenSignal?.aborted).toBe(true);
		expect(spec.activity.state).toBe("killed");
	});

	it("forwards every message to the monitor", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		holder.value = { ok: true };
		const msgs = [{ type: "system", subtype: "init" }, successResult()];
		const { fn } = stubQuery(msgs);
		await runSubagent(spec, { query: fn, resultHolder: holder });
		expect(h.monitor.applied).toEqual(msgs);
	});
});

describe("subagentOptions", () => {
	it("passes the caller's prompt and options through to query()", async () => {
		const h = harness();
		const spec = h.spec();
		const holder = createResultHolder();
		holder.value = { ok: true };
		const { fn, calls } = stubQuery([successResult()]);
		await runSubagent(spec, { query: fn, resultHolder: holder });
		expect(calls).toHaveLength(1);
		expect(calls[0].prompt).toBe("review this");
		expect(calls[0].options?.systemPrompt).toContain("you are a reviewer");
		expect(calls[0].options?.systemPrompt).toContain("submit_result");
		expect(calls[0].options?.model).toBe("claude-sonnet-5");
		expect(calls[0].options?.cwd).toBe(tmpDir);
	});

	it("includes the submit_result MCP tool in the tools list", () => {
		const h = harness();
		const spec = h.spec();
		const opts = subagentOptions(spec, new AbortController()) as Any;
		expect(opts.tools).toEqual([...["Read", "Grep", "Glob"], SUBMIT_MCP_TOOL]);
	});

	it("does not declare outputFormat", () => {
		const h = harness();
		const spec = h.spec();
		const opts = subagentOptions(spec, new AbortController()) as Any;
		expect(opts.outputFormat).toBeUndefined();
	});

	it("wires the caller's AbortController through", () => {
		const h = harness();
		const controller = new AbortController();
		const opts = subagentOptions(h.spec(), controller) as Any;
		expect(opts.abortController).toBe(controller);
	});

	it("isolates the subagent from ambient skills and plugins", () => {
		const h = harness();
		const opts = subagentOptions(h.spec(), new AbortController()) as Any;
		expect(opts.settingSources).toEqual([]);
		expect(opts.skills).toEqual([]);
		expect(opts.plugins).toEqual([]);
	});

	it("appends submit_result instruction to the system prompt", () => {
		const h = harness();
		const opts = subagentOptions(h.spec(), new AbortController()) as Any;
		expect(typeof opts.systemPrompt).toBe("string");
		expect(opts.systemPrompt).toContain("call the submit_result tool");
	});
});

describe("schemaToZodShape", () => {
	it("converts top-level properties to named Zod fields", () => {
		const shape = schemaToZodShape({
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" }, count: { type: "integer" } },
		});
		expect(Object.keys(shape)).toEqual(["name", "count"]);
	});

	it("handles nested objects and arrays", () => {
		const shape = schemaToZodShape({
			type: "object",
			required: ["items"],
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						required: ["file"],
						properties: { file: { type: "string" }, line: { type: "integer" } },
					},
				},
			},
		});
		expect(Object.keys(shape)).toEqual(["items"]);
	});

	it("falls back to { output: unknown } for non-object schemas", () => {
		expect(Object.keys(schemaToZodShape({ type: "string" }))).toEqual(["output"]);
		expect(Object.keys(schemaToZodShape(null))).toEqual(["output"]);
	});
});

describe("createSubmitResultServer", () => {
	const schema = {
		type: "object",
		properties: { name: { type: "string" }, count: { type: "integer" } },
		required: ["name", "count"],
	};

	function getHandler(server: Any) {
		return server.instance._registeredTools.submit_result.handler;
	}

	it("accepts valid output passed as named parameters", async () => {
		const holder = createResultHolder();
		const attempts: Array<{ n: number; errs: string[] }> = [];
		const server = createSubmitResultServer(schema, holder, 5, (n, errs) => attempts.push({ n, errs }));
		const handler = getHandler(server);
		const result = await handler({ name: "test", count: 3 }, {});
		expect(result.isError).toBeUndefined();
		expect(holder.value).toEqual({ name: "test", count: 3 });
		expect(holder.attempts).toBe(1);
		expect(attempts).toEqual([{ n: 1, errs: [] }]);
	});

	it("rejects invalid output with clear error messages", async () => {
		const holder = createResultHolder();
		const server = createSubmitResultServer(schema, holder, 5);
		const handler = getHandler(server);
		const result = await handler({ name: 42 }, {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Validation failed");
		expect(result.content[0].text).toContain("attempt 1/5");
		expect(holder.value).toBeNull();
		expect(holder.attempts).toBe(1);
		expect(holder.lastErrors.length).toBeGreaterThan(0);
	});

	it("indicates final attempt when maxAttempts is reached", async () => {
		const holder = createResultHolder();
		const server = createSubmitResultServer(schema, holder, 2);
		const handler = getHandler(server);
		await handler({}, {});
		const result = await handler({}, {});
		expect(result.content[0].text).toContain("final attempt");
		expect(holder.attempts).toBe(2);
	});
});
