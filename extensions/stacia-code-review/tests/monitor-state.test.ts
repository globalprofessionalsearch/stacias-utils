import { describe, expect, it } from "vitest";
import { MonitorState } from "../monitor-state.ts";

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

describe("MonitorState.applyEvent (subscribe logic)", () => {
	function fakeSession() {
		let handler: ((event: unknown) => void) | null = null;
		return {
			aborted: false,
			abort() {
				this.aborted = true;
			},
			subscribe(fn: (event: unknown) => void) {
				handler = fn;
			},
			emit(event: unknown) {
				handler?.(event);
			},
		};
	}

	it("accumulates tokens from message_update text_delta", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		const session = fakeSession();
		a.session = session;
		session.subscribe((event) => state.applyEvent(a, event));

		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });

		expect(a.tokens).toBe("hello".length + " world".length);
		expect(a.lastEventAt).toBeGreaterThan(0);
	});

	it("ignores message_update events that aren't text_delta", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");
		state.applyEvent(a, { type: "message_update", assistantMessageEvent: { type: "reasoning_delta", delta: "x" } });
		expect(a.tokens).toBe(0);
	});

	it("sets currentTool and logs on tool_execution_start, clears on tool_execution_end", () => {
		const state = new MonitorState();
		const a = state.register("perspective-1", "security");

		state.applyEvent(a, { type: "tool_execution_start", toolName: "grep" });
		expect(a.currentTool).toBe("grep");
		expect(a.toolCalls).toBe(1);
		expect(a.events.at(-1)).toBe("> grep");

		state.applyEvent(a, { type: "tool_execution_end", toolName: "grep" });
		expect(a.currentTool).toBe("");
		expect(a.toolCalls).toBe(1);
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
});
