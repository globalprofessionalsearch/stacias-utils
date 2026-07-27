import { describe, expect, it } from "vitest";
import { MonitorState, bar, clean, fmtDur, fmtNum } from "../monitor-state.ts";

// Message factories mirroring @anthropic-ai/claude-agent-sdk/sdk.d.ts.
// SDKAssistantMessage (:2854) wraps a BetaMessage; SDKPartialAssistantMessage
// (:4150) wraps a BetaRawMessageStreamEvent; SDKResultSuccess (:4292) carries
// the authoritative run usage.
const assistant = (id: string, content: unknown[], usage?: unknown) => ({
	type: "assistant",
	parent_tool_use_id: null,
	message: { id, type: "message", role: "assistant", content, usage },
});
const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event });
const userMsg = (content: unknown[]) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content } });

describe("MonitorState.register", () => {
	it("creates a queued activity with zeroed counters", () => {
		const state = new MonitorState();
		const a = state.register("orient-a", "orienteer", 3);
		expect(a.label).toBe("orient-a");
		expect(a.role).toBe("orienteer");
		expect(a.state).toBe("queued");
		expect(a.maxRounds).toBe(3);
		expect(a.tokens).toBe(0);
		expect(a.currentTool).toBe("");
		expect(a.events).toEqual([]);
		expect(state.registry.get("orient-a")).toBe(a);
	});

	it("defaults maxRounds to 1", () => {
		const state = new MonitorState();
		const a = state.register("solo", "verifier");
		expect(a.maxRounds).toBe(1);
	});
});

describe("MonitorState.applyEvent (SDK message stream)", () => {
	it("takes output tokens from a completed assistant message's usage", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, assistant("msg_1", [{ type: "text", text: "hello" }], { input_tokens: 900, output_tokens: 40 }));

		expect(a.usageSeen).toBe(true);
		expect(a.tokens).toBe(40);
		expect(a.inputTokens).toBe(900);
		expect(a.lastEventAt).toBeGreaterThan(0);
	});

	it("tracks the in-flight turn from stream_event message_delta usage", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, stream({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 500, output_tokens: 1 } } }));
		state.applyEvent(a, stream({ type: "message_delta", usage: { output_tokens: 12 } }));
		state.applyEvent(a, stream({ type: "message_delta", usage: { output_tokens: 30 } }));

		// message_delta usage is cumulative within the turn, not a delta to add up.
		expect(a.tokens).toBe(30);
		expect(a.inputTokens).toBe(500);
	});

	it("banks finished turns and never double-counts a re-seen turn", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, stream({ type: "message_start", message: { id: "msg_1", usage: { output_tokens: 0 } } }));
		state.applyEvent(a, stream({ type: "message_delta", usage: { output_tokens: 100 } }));
		state.applyEvent(a, assistant("msg_1", [], { output_tokens: 100 }));
		expect(a.tokens).toBe(100);

		state.applyEvent(a, stream({ type: "message_start", message: { id: "msg_2", usage: { output_tokens: 0 } } }));
		state.applyEvent(a, stream({ type: "message_delta", usage: { output_tokens: 55 } }));
		expect(a.tokens).toBe(155);

		// SDKAssistantMessage's doc note: one turn may arrive as several messages
		// sharing message.id. Re-applying must be idempotent.
		state.applyEvent(a, assistant("msg_2", [], { output_tokens: 55 }));
		state.applyEvent(a, assistant("msg_2", [], { output_tokens: 55 }));
		expect(a.tokens).toBe(155);
	});

	it("falls back to a chars/4 estimate when no usage is reported", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, assistant("msg_1", [{ type: "text", text: "x".repeat(400) }]));

		expect(a.usageSeen).toBe(false);
		expect(a.tokens).toBe(100);
	});

	it("does not double-count the fallback estimate when partial messages are on", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y".repeat(200) } }));
		state.applyEvent(a, assistant("msg_1", [{ type: "text", text: "y".repeat(200) }]));

		expect(a.tokens).toBe(50);
	});

	it("adopts the result message's usage as the authoritative run total", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, assistant("msg_1", [], { output_tokens: 40 }));
		state.applyEvent(a, {
			type: "result",
			subtype: "success",
			usage: { input_tokens: 1200, cache_read_input_tokens: 8000, output_tokens: 777 },
			total_cost_usd: 0.0421,
		});

		expect(a.tokens).toBe(777);
		expect(a.inputTokens).toBe(9200);
		expect(a.costUsd).toBeCloseTo(0.0421);
		expect(a.fail).toBeUndefined();
	});

	it("records a non-success result subtype as the failure reason", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		state.applyEvent(a, { type: "result", subtype: "error_max_structured_output_retries", usage: { output_tokens: 3 } });
		expect(a.fail).toBe("error_max_structured_output_retries");
		expect(a.events.at(-1)).toBe("! error_max_structured_output_retries");
	});

	it("sets currentTool and logs on a tool_use block, clears it on tool_result", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, assistant("msg_1", [{ type: "tool_use", id: "tu_1", name: "Grep", input: {} }]));
		expect(a.currentTool).toBe("Grep");
		expect(a.toolCalls).toBe(1);
		expect(a.events.at(-1)).toBe("> Grep");

		state.applyEvent(a, userMsg([{ type: "tool_result", tool_use_id: "tu_1", content: "..." }]));
		expect(a.currentTool).toBe("");
		expect(a.toolCalls).toBe(1);
	});

	it("counts a tool once when both the stream event and the assistant block arrive", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "Read" } }));
		state.applyEvent(a, assistant("msg_1", [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/a.ts" } }]));

		expect(a.toolCalls).toBe(1);
		expect(a.events.filter((e) => e.startsWith("> Read")).length).toBe(1);
	});

	it("logs the tool target and flags errored tool results", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		state.applyEvent(a, assistant("m", [{ type: "tool_use", id: "tu_9", name: "Read", input: { file_path: "src/deep/x.ts" } }]));
		expect(a.events.at(-1)).toBe("> Read src/deep/x.ts");
		state.applyEvent(a, userMsg([{ type: "tool_result", tool_use_id: "tu_9", is_error: true }]));
		expect(a.events.at(-1)).toBe("! Read error");
	});

	it("logs permission denials and api retries from system messages", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, { type: "system", subtype: "permission_denied", tool_name: "Read", decision_reason: "outside change set" });
		expect(a.events.at(-1)).toBe("! denied Read: outside change set");

		state.applyEvent(a, { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, error: "overloaded" });
		expect(a.events.at(-1)).toBe("! retry 2/5 overloaded");
	});

	it("follows tool_progress for long-running tools", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		state.applyEvent(a, { type: "tool_progress", tool_name: "Grep", tool_use_id: "tu_1", elapsed_time_seconds: 9 });
		expect(a.currentTool).toBe("Grep");
	});

	it("ignores unknown and malformed messages", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		expect(() => {
			state.applyEvent(a, null);
			state.applyEvent(a, { type: "compact_boundary" });
			state.applyEvent(a, { type: "assistant" });
			state.applyEvent(a, { type: "user", message: { content: "plain string" } });
			state.applyEvent(a, { type: "stream_event" });
		}).not.toThrow();
		expect(a.tokens).toBe(0);
		expect(a.toolCalls).toBe(0);
	});
});

describe("MonitorState.kill", () => {
	it("aborts the controller in the session slot and marks the agent killed", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		a.state = "running";
		let aborted = false;
		a.session = { abort: () => (aborted = true) };

		expect(state.kill(a)).toBe(true);
		expect(a.state).toBe("killed");
		expect(aborted).toBe(true);
	});

	it("tolerates a queued agent with no controller yet, and refuses terminal states", () => {
		const state = new MonitorState();
		const queued = state.register("q", "security");
		expect(state.kill(queued)).toBe(true);
		expect(queued.state).toBe("killed");

		const done = state.register("d", "security");
		done.state = "done";
		expect(state.kill(done)).toBe(false);
		expect(done.state).toBe("done");
	});
});

describe("MonitorState.cancelAll", () => {
	it("marks queued and running activities as killed and aborts their sessions", () => {
		const state = new MonitorState();
		const queued = state.register("queued-1", "verifier");
		const running = state.register("running-1", "verifier");
		const done = state.register("done-1", "verifier");
		running.state = "running";
		done.state = "done";

		let queuedAborted = false;
		let runningAborted = false;
		let doneAborted = false;
		queued.session = { abort: () => (queuedAborted = true) };
		running.session = { abort: () => (runningAborted = true) };
		done.session = { abort: () => (doneAborted = true) };

		state.cancelAll();

		expect(state.cancelled).toBe(true);
		expect(queued.state).toBe("killed");
		expect(running.state).toBe("killed");
		expect(done.state).toBe("done"); // already-terminal states are left alone
		expect(queuedAborted).toBe(true);
		expect(runningAborted).toBe(true);
		expect(doneAborted).toBe(false);
	});

	it("tolerates activities with no session", () => {
		const state = new MonitorState();
		state.register("no-session", "verifier");
		expect(() => state.cancelAll()).not.toThrow();
	});
});

describe("MonitorState.pushEvent", () => {
	it("bounds the ring to 24 entries, dropping the oldest", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		for (let i = 0; i < 30; i++) state.pushEvent(a, `event-${i}`);
		expect(a.events.length).toBe(24);
		expect(a.events[0]).toBe("event-6");
		expect(a.events.at(-1)).toBe("event-29");
	});

	it("cleans control characters and non-ASCII, and clamps width", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		state.pushEvent(a, `line1\nline2\ttab${"x".repeat(100)}`);
		expect(a.events[0]).not.toMatch(/[\r\n\t]/);
		expect(a.events[0].length).toBeLessThanOrEqual(80);
	});

	it("honours a deeper ring so the TUI has real scrollback", () => {
		const state = new MonitorState({ eventLimit: 200 });
		const a = state.register("perspective-1", "security");
		for (let i = 0; i < 250; i++) state.pushEvent(a, `event-${i}`);
		expect(a.events.length).toBe(200);
		expect(a.events[0]).toBe("event-50");
	});
});

describe("MonitorState.tick", () => {
	it("stamps start/end times and converts token deltas into a per-second rate", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		a.state = "running";

		state.tick(1_000, 250);
		expect(a.startedAt).toBe(1_000);
		expect(a.endedAt).toBe(0);

		a.tokens = 25;
		state.tick(1_250, 250);
		expect(a.tokenRate).toBe(100); // 25 tokens in 250ms

		a.state = "done";
		state.tick(4_000, 250);
		expect(a.endedAt).toBe(4_000);
		expect(a.startedAt).toBe(1_000);
	});
});

describe("MonitorState seam coverage", () => {
	const seams = [
		{ id: 1, files: ["src/auth/login.ts", "src/auth/session.ts"] },
		{ id: 2, files: ["docs/adr/0001.md"] },
		{ id: 3, files: ["src/db/pool.ts"] },
	];

	it("starts empty and reports totals once seeded", () => {
		const state = new MonitorState();
		expect(state.coverage()).toEqual({ covered: 0, total: 0 });
		state.setSeams(seams);
		expect(state.coverage()).toEqual({ covered: 0, total: 3 });
	});

	it("covers a seam when a tool opens one of its files, absolute path and all", () => {
		const state = new MonitorState();
		state.setSeams(seams);
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, {
			type: "assistant",
			message: { id: "m1", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/repo/src/auth/session.ts" } }] },
		});
		expect(state.coverage()).toEqual({ covered: 1, total: 3 });

		// A directory read covers every seam file beneath it.
		state.applyEvent(a, {
			type: "assistant",
			message: { id: "m2", content: [{ type: "tool_use", id: "tu_2", name: "Grep", input: { path: "src/db" } }] },
		});
		expect(state.coverage()).toEqual({ covered: 2, total: 3 });
	});

	it("accepts explicit coverage and ignores unknown ids", () => {
		const state = new MonitorState();
		state.setSeams(seams);
		state.coverSeams([2, "3", 99]);
		expect(state.coverage()).toEqual({ covered: 2, total: 3 });
	});

	it("does nothing when no seam map has been seeded", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		state.applyEvent(a, {
			type: "assistant",
			message: { id: "m1", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "anything.ts" } }] },
		});
		expect(state.coverage()).toEqual({ covered: 0, total: 0 });
	});
});

describe("MonitorState text builders", () => {
	it("widgetLines renders one row per agent plus a header and a footer", () => {
		const state = new MonitorState();
		state.phase = "review";
		const a = state.register("security", "security", 3);
		a.state = "running";
		a.round = 2;
		a.tokens = 1204;
		a.usageSeen = true;
		a.currentTool = "Grep";
		a.lastEventAt = 10_000;
		state.setSeams([{ id: 1, files: ["a.ts"] }]);

		const lines = state.widgetLines(0, 10_000);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("code-review — review — 10s");
		expect(lines[1]).toContain("security");
		expect(lines[1]).toContain("1.2kt");
		expect(lines[1]).toContain("r2/3");
		expect(lines[2]).toBe("  1 agents · 0 done · 1 busy · 0 gone · seams 0/1");
	});

	it("widgetLines marks an estimated token count and an idle agent", () => {
		const state = new MonitorState();
		const a = state.register("security", "security");
		a.state = "running";
		a.tokens = 30;
		a.lastEventAt = 0;
		expect(state.widgetLines(0, 10_000)[1]).toContain("~30t");
		expect(state.widgetLines(0, 10_000)[1]).toContain("idle");
	});

	it("progressLine summarises the run on one line", () => {
		const state = new MonitorState();
		state.phase = "review";
		const a = state.register("security", "security");
		const b = state.register("perf", "performance");
		a.state = "running";
		a.tokens = 2000;
		b.state = "done";

		const line = state.progressLine(0, 65_000);
		expect(line).toContain("[ 1m05s]");
		expect(line).toContain("review");
		expect(line).toContain("1/2 done");
		expect(line).toContain("2.0k tok");
		expect(line).toContain("running: security");
	});

	it("progressKey changes on state transitions but not on token churn", () => {
		const state = new MonitorState();
		const a = state.register("security", "security");
		const before = state.progressKey();
		a.tokens += 5000;
		expect(state.progressKey()).toBe(before);
		a.state = "running";
		expect(state.progressKey()).not.toBe(before);
	});
});

describe("formatting helpers", () => {
	it("clean strips control characters and non-ASCII and clamps", () => {
		expect(clean("a\nb\tc", 10)).toBe("a b c");
		expect(clean("héllo", 10)).toBe("hllo");
		expect(clean("abcdef", 3)).toBe("abc");
	});

	it("bar scales with the token rate", () => {
		expect(bar(0)).toBe("   ");
		expect(bar(-5)).toBe("   ");
		expect(bar(10)).toBe("▁▁▁");
		expect(bar(10_000)).toBe("███");
	});

	it("fmtNum and fmtDur", () => {
		expect(fmtNum(0)).toBe("0");
		expect(fmtNum(812)).toBe("812");
		expect(fmtNum(1204)).toBe("1.2k");
		expect(fmtNum(41_000)).toBe("41k");
		expect(fmtNum(2_400_000)).toBe("2.4M");
		expect(fmtDur(4200)).toBe("4s");
		expect(fmtDur(95_000)).toBe("1m35s");
		expect(fmtDur(3_800_000)).toBe("1h03m");
	});
});
