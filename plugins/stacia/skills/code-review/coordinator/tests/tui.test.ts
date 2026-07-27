import { describe, expect, it, vi } from "vitest";
import { Monitor } from "../monitor.ts";
import { type Activity, MonitorState } from "../monitor-state.ts";
import { type KeyName, LinePainter, type Term, Tui, decodeKeys, fg, fit, frame, nodeTerm, paint } from "../tui.ts";

/** The whole untestable surface, faked: no raw mode, no alternate screen. */
function fakeTerm(opts: { cols?: number; rows?: number; isTTY?: boolean } = {}) {
	let handler: ((k: KeyName) => void) | null = null;
	const writes: string[] = [];
	let started = 0;
	let stopped = 0;
	const term: Term & { writes: string[]; press(k: KeyName): void; starts(): number; stops(): number } = {
		isTTY: opts.isTTY ?? true,
		columns: () => opts.cols ?? 120,
		rows: () => opts.rows ?? 30,
		write: (s) => void writes.push(s),
		onKey: (cb) => {
			handler = cb;
		},
		start: () => {
			started++;
		},
		stop: () => {
			stopped++;
		},
		writes,
		press: (k) => handler?.(k),
		starts: () => started,
		stops: () => stopped,
	};
	return term;
}

function seeded(): MonitorState {
	const state = new MonitorState({ eventLimit: 200 });
	state.phase = "review";
	const a = state.register("security", "security", 3);
	const b = state.register("perf", "performance");
	const c = state.register("a11y", "accessibility");
	a.state = "running";
	a.round = 2;
	a.tokens = 1204;
	a.usageSeen = true;
	a.inputTokens = 42_000;
	a.startedAt = 1_000;
	a.currentTool = "Grep";
	a.lastEventAt = 60_000;
	b.state = "done";
	b.startedAt = 1_000;
	b.endedAt = 31_000;
	b.tokens = 900;
	b.usageSeen = true;
	c.state = "failed";
	c.fail = "timeout after 300s";
	for (let i = 0; i < 40; i++) state.pushEvent(a, `> Read src/file-${i}.ts`);
	return state;
}

const plain = (state: MonitorState, over: Partial<Parameters<typeof frame>[1]> = {}) =>
	frame(state, { sel: 0, scroll: 0, started: 0, now: 60_000, height: 30, ...over }).map((r) => r.t);

describe("decodeKeys", () => {
	it("decodes arrows, paging and home/end", () => {
		expect(decodeKeys("\x1b[A")).toEqual(["up"]);
		expect(decodeKeys("\x1b[B")).toEqual(["down"]);
		expect(decodeKeys("\x1b[5~")).toEqual(["pageup"]);
		expect(decodeKeys("\x1b[6~")).toEqual(["pagedown"]);
		expect(decodeKeys("\x1b[H")).toEqual(["home"]);
		expect(decodeKeys("\x1bOA")).toEqual(["up"]); // SS3 / application cursor mode
	});

	it("treats a bare ESC as escape, but never splits an escape sequence", () => {
		expect(decodeKeys("\x1b")).toEqual(["escape"]);
		expect(decodeKeys("\x1b\x1b")).toEqual(["escape", "escape"]);
		expect(decodeKeys("\x1b[A")).not.toContain("escape");
		// A chunk cut mid-sequence is dropped rather than misread as escape + junk.
		expect(decodeKeys("\x1b[")).toEqual([]);
	});

	it("decodes the plain command keys and ctrl-c", () => {
		expect(decodeKeys("k")).toEqual(["k"]);
		expect(decodeKeys("c")).toEqual(["c"]);
		expect(decodeKeys("q")).toEqual(["q"]);
		expect(decodeKeys("\x03")).toEqual(["ctrl-c"]);
		expect(decodeKeys("\r")).toEqual(["enter"]);
	});

	it("handles several keys arriving in one chunk and drops unknown sequences", () => {
		expect(decodeKeys("\x1b[Bk\x1b[A")).toEqual(["down", "k", "up"]);
		expect(decodeKeys("\x1b[200~")).toEqual([]); // bracketed paste marker, ignored
		expect(decodeKeys("\x00\x01")).toEqual([]); // unmapped control bytes
	});
});

describe("fg / fit / paint", () => {
	it("fg wraps in the right SGR code and can be turned off", () => {
		expect(fg("err", "boom")).toBe("\x1b[31mboom\x1b[0m");
		expect(fg("plain", "boom")).toBe("boom");
		expect(fg("err", "boom", false)).toBe("boom");
	});

	it("fit strips control characters but keeps the status glyphs", () => {
		expect(fit("a\nb", 10)).toBe("a b");
		expect(fit("● running", 20)).toBe("● running");
		expect(fit("abcdef", 3)).toBe("abc");
	});

	it("paint clamps before it colorizes, so no escape is ever sliced", () => {
		const long = "x".repeat(200);
		const [line] = paint([{ t: long, c: "err" }], 20);
		expect(line).toBe(`\x1b[31m${"x".repeat(19)}\x1b[0m`);
		// The clamp counts payload characters only — the escapes are added after.
		expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBe(19);
	});

	it("paint pads the selected row so the highlight spans the width", () => {
		const [line] = paint([{ t: "hi", c: "sel" }], 10);
		expect(line).toBe(`\x1b[7m${"hi".padEnd(9)}\x1b[0m`);
	});
});

describe("frame", () => {
	it("renders header, per-agent rows, event log and footer, exactly `height` tall", () => {
		const rows = frame(seeded(), { sel: 0, scroll: 0, started: 0, now: 60_000, height: 30 });
		expect(rows).toHaveLength(30);
		expect(rows[0].t).toBe("code-review — review — 1m00s");
		expect(rows[1].t).toContain("3 agents · 1 done · 1 busy · 1 gone");
		expect(rows.at(-1)?.t).toContain("k kill");
		expect(rows.at(-1)?.t).toContain("esc cancel-all");
	});

	it("shows per-agent elapsed time, real tokens and context size", () => {
		const [security] = plain(seeded()).filter((t) => t.includes("security"));
		expect(security).toContain("● security");
		expect(security).toContain("1.2kt");
		expect(security).toContain("42k ctx");
		expect(security).toContain("r2/3");
		expect(security).toContain("59s"); // running since 1_000, now 60_000
		expect(security).toContain("Grep");

		const [perf] = plain(seeded()).filter((t) => t.includes("perf"));
		expect(perf).toContain("30s"); // frozen at endedAt, not still counting
	});

	it("marks an estimated token count with a tilde", () => {
		const state = new MonitorState();
		const a = state.register("security", "security");
		a.state = "running";
		a.tokens = 30;
		expect(plain(state).some((t) => t.includes("~30t"))).toBe(true);
	});

	it("moves the selection and swaps which agent's log is shown", () => {
		const state = seeded();
		state.pushEvent([...state.registry.values()][1], "> Glob **/*.ts");
		expect(plain(state, { sel: 0 }).some((t) => t.startsWith("events [security]"))).toBe(true);
		const perfView = plain(state, { sel: 1 });
		expect(perfView.some((t) => t.startsWith("events [perf]"))).toBe(true);
		expect(perfView.some((t) => t.includes("> Glob **/*.ts"))).toBe(true);
	});

	it("shows the failure reason of the selected agent", () => {
		const header = plain(seeded(), { sel: 2 }).find((t) => t.startsWith("events ["));
		expect(header).toContain("fail: timeout after 300s");
	});

	it("scrolls the event log rather than truncating to a fixed tail", () => {
		const state = seeded();
		const tail = plain(state, { sel: 0 });
		expect(tail.some((t) => t.includes("src/file-39.ts"))).toBe(true);
		expect(tail.some((t) => t.includes("src/file-0.ts"))).toBe(false);

		const scrolled = plain(state, { sel: 0, scroll: 40 });
		expect(scrolled.some((t) => t.includes("src/file-0.ts"))).toBe(true);
		expect(scrolled.find((t) => t.startsWith("events ["))).toContain("↑more");
	});

	it("clamps scroll to the available history", () => {
		const state = seeded();
		const a = plain(state, { sel: 0, scroll: 999_999 });
		const b = plain(state, { sel: 0, scroll: 40 });
		expect(a.find((t) => t.startsWith("events ["))).toBe(b.find((t) => t.startsWith("events [")));
	});

	it("reports live seam coverage when a seam map has been seeded", () => {
		const state = seeded();
		state.setSeams([{ id: 1, files: ["a.ts"] }, { id: 2, files: ["b.ts"] }]);
		state.coverSeams([1]);
		expect(plain(state)[1]).toContain("seams 1/2");
	});

	it("flags a cancelled run in the header", () => {
		const state = seeded();
		state.cancelAll();
		const rows = frame(state, { sel: 0, scroll: 0, started: 0, now: 60_000, height: 30 });
		expect(rows[0].t).toContain("CANCELLED");
		expect(rows[0].c).toBe("err");
	});

	it("windows the agent table on a short terminal instead of eating the log", () => {
		const state = new MonitorState();
		for (let i = 0; i < 20; i++) state.register(`agent-${i}`, `role-${i}`);
		const rows = frame(state, { sel: 15, scroll: 0, started: 0, now: 0, height: 14 });
		expect(rows).toHaveLength(14);
		expect(rows.some((r) => r.t.includes("above"))).toBe(true);
		expect(rows.some((r) => r.t.includes("role-15"))).toBe(true);
		expect(rows.some((r) => r.t.startsWith("events ["))).toBe(true);
	});

	it("renders with no agents at all", () => {
		const state = new MonitorState();
		const rows = frame(state, { sel: 0, scroll: 0, started: 0, now: 0, height: 20 });
		expect(rows).toHaveLength(20);
		expect(rows.some((r) => r.t.includes("no agents registered"))).toBe(true);
		expect(rows.some((r) => r.t.startsWith("events [-]"))).toBe(true);
	});
});

describe("Tui input handling", () => {
	function harness() {
		const state = seeded();
		const term = fakeTerm();
		const killed: Activity[] = [];
		let cancelled = 0;
		let quit = 0;
		const tui = new Tui(state, term, {
			kill: (a) => void killed.push(a),
			cancelAll: () => {
				cancelled++;
			},
			quit: () => {
				quit++;
			},
		});
		tui.start(0);
		return { state, term, tui, killed, cancels: () => cancelled, quits: () => quit };
	}

	it("enters the terminal once and paints an initial frame", () => {
		const h = harness();
		expect(h.term.starts()).toBe(1);
		expect(h.term.writes.length).toBe(1);
		expect(h.term.writes[0].startsWith("\x1b[H")).toBe(true);
	});

	it("arrow keys move the selection and clamp at both ends", () => {
		const h = harness();
		h.term.press("up");
		expect(h.term.writes.at(-1)).toContain("events [security]");
		h.term.press("down");
		expect(h.term.writes.at(-1)).toContain("events [perf]");
		h.term.press("down");
		h.term.press("down");
		h.term.press("down");
		expect(h.term.writes.at(-1)).toContain("events [a11y]");
	});

	it("k kills the selected agent only", () => {
		const h = harness();
		h.term.press("k");
		expect(h.killed.map((a) => a.label)).toEqual(["security"]);
		h.term.press("down");
		h.term.press("k");
		expect(h.killed.map((a) => a.label)).toEqual(["security", "perf"]);
	});

	it("c and esc both cancel-all — esc is finally bound", () => {
		const h = harness();
		h.term.press("c");
		expect(h.cancels()).toBe(1);
		h.term.press("escape");
		expect(h.cancels()).toBe(2);
		expect(h.quits()).toBe(0);
	});

	it("q quits and ctrl-c cancels then quits", () => {
		const h = harness();
		h.term.press("q");
		expect(h.quits()).toBe(1);
		expect(h.cancels()).toBe(0);
		h.term.press("ctrl-c");
		expect(h.cancels()).toBe(1);
		expect(h.quits()).toBe(2);
	});

	it("pgup/pgdn scroll the log and end returns to the live tail", () => {
		const h = harness();
		h.term.press("pageup");
		expect(h.term.writes.at(-1)).toContain("↑more");
		h.term.press("end");
		expect(h.term.writes.at(-1)).not.toContain("↑more");
		h.term.press("home");
		expect(h.term.writes.at(-1)).toContain("src/file-0.ts");
	});

	it("ignores keys it does not bind, without repainting", () => {
		const h = harness();
		const before = h.term.writes.length;
		h.term.press("z");
		h.term.press("enter");
		expect(h.term.writes.length).toBe(before);
	});

	it("stop restores the terminal", () => {
		const h = harness();
		h.tui.stop();
		expect(h.term.stops()).toBe(1);
	});
});

describe("LinePainter (non-TTY fallback)", () => {
	it("prints only when something meaningful changes", () => {
		const state = new MonitorState();
		const out: string[] = [];
		const p = new LinePainter(state, (s) => out.push(s));
		p.start(0);

		const a = state.register("security", "security");
		p.render(1_000);
		expect(out).toHaveLength(1);

		// Token churn alone must not spam the log.
		a.tokens = 5_000;
		p.render(2_000);
		expect(out).toHaveLength(1);

		a.state = "running";
		p.render(3_000);
		expect(out).toHaveLength(2);
		expect(out[1]).toContain("running: security");
		expect(out[1]).toContain("5.0k tok");
		expect(out[1].endsWith("\n")).toBe(true);
	});

	it("emits a heartbeat when nothing has changed for a long time", () => {
		const state = new MonitorState();
		const out: string[] = [];
		const p = new LinePainter(state, (s) => out.push(s), 30_000);
		p.start(0);
		p.render(1_000);
		p.render(5_000);
		expect(out).toHaveLength(1);
		p.render(40_000);
		expect(out).toHaveLength(2);
	});

	it("writes a final summary on stop", () => {
		const state = new MonitorState();
		state.register("security", "security");
		const out: string[] = [];
		const p = new LinePainter(state, (s) => out.push(s));
		p.start(0);
		p.stop();
		expect(out.length).toBeGreaterThan(1);
		expect(out[0]).toContain("code-review");
	});

	it("emits no ANSI escapes at all", () => {
		const state = new MonitorState();
		state.register("security", "security").state = "running";
		const out: string[] = [];
		const p = new LinePainter(state, (s) => out.push(s));
		p.start(0);
		p.render(1_000);
		p.stop();
		expect(out.join("")).not.toMatch(/\x1b/);
	});
});

describe("nodeTerm", () => {
	function fakeStreams(isTTY: boolean) {
		const listeners: Record<string, Array<(b: unknown) => void>> = {};
		const stdin = {
			isTTY,
			raw: null as boolean | null,
			resumed: 0,
			paused: 0,
			setRawMode(v: boolean) {
				this.raw = v;
			},
			resume() {
				this.resumed++;
			},
			pause() {
				this.paused++;
			},
			setEncoding() {},
			on(ev: string, cb: (b: unknown) => void) {
				(listeners[ev] ??= []).push(cb);
			},
			off(ev: string, cb: (b: unknown) => void) {
				listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== cb);
			},
			emit(ev: string, b: unknown) {
				for (const f of listeners[ev] ?? []) f(b);
			},
		};
		const out: string[] = [];
		const stdout = { isTTY, columns: 100, rows: 40, write: (s: string) => void out.push(s) };
		return { stdin, stdout, out };
	}

	it("enters and leaves raw mode + the alternate screen, and hides/shows the cursor", () => {
		const { stdin, stdout, out } = fakeStreams(true);
		const term = nodeTerm(stdin, stdout);
		expect(term.isTTY).toBe(true);
		expect(term.columns()).toBe(100);
		expect(term.rows()).toBe(40);

		term.start();
		expect(stdin.raw).toBe(true);
		expect(out.join("")).toContain("\x1b[?1049h");
		expect(out.join("")).toContain("\x1b[?25l");

		term.stop();
		expect(stdin.raw).toBe(false);
		expect(out.join("")).toContain("\x1b[?25h");
		expect(out.join("")).toContain("\x1b[?1049l");
	});

	it("is idempotent on both ends", () => {
		const { stdin, stdout, out } = fakeStreams(true);
		const term = nodeTerm(stdin, stdout);
		term.start();
		term.start();
		term.stop();
		term.stop();
		expect(out.filter((s) => s.includes("\x1b[?1049h"))).toHaveLength(1);
		expect(out.filter((s) => s.includes("\x1b[?1049l"))).toHaveLength(1);
	});

	it("decodes stdin chunks into key callbacks and unsubscribes on stop", () => {
		const { stdin, stdout } = fakeStreams(true);
		const term = nodeTerm(stdin, stdout);
		const keys: string[] = [];
		term.onKey((k) => keys.push(k));
		term.start();
		stdin.emit("data", "\x1b[Bk");
		expect(keys).toEqual(["down", "k"]);
		term.stop();
		stdin.emit("data", "q");
		expect(keys).toEqual(["down", "k"]);
	});

	it("reports isTTY false when either end is not a terminal", () => {
		const a = fakeStreams(false);
		expect(nodeTerm(a.stdin, a.stdout).isTTY).toBe(false);
		const b = fakeStreams(true);
		b.stdout.isTTY = false;
		expect(nodeTerm(b.stdin, b.stdout).isTTY).toBe(false);
	});
});

describe("Monitor", () => {
	const base = { exitHooks: false as const, intervalMs: 10 };

	it("exposes the surface the coordinator drives", () => {
		const m = new Monitor(base);
		m.phase = "comprehension";
		expect(m.phase).toBe("comprehension");
		const a = m.register("orient-a", "orienteer", 3);
		expect(m.registry.get("orient-a")).toBe(a);
		expect(m.cancelled).toBe(false);

		const controller = new AbortController();
		m.attach(a, controller);
		a.state = "running";
		expect(m.kill(a)).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(a.state).toBe("killed");
	});

	it("cancelAll aborts every live controller and tolerates queued agents", () => {
		const m = new Monitor(base);
		const running = m.register("r", "verifier");
		const queued = m.register("q", "verifier");
		const controller = new AbortController();
		m.attach(running, controller);
		m.attach(queued, null);
		running.state = "running";

		expect(() => m.cancelAll()).not.toThrow();
		expect(m.cancelled).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(queued.state).toBe("killed");
	});

	it("applyEvent folds SDK messages through to the activity entry", () => {
		const m = new Monitor(base);
		const a = m.register("security", "security");
		m.applyEvent(a, {
			type: "assistant",
			message: { id: "m1", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/a.ts" } }], usage: { output_tokens: 12 } },
		});
		expect(a.tokens).toBe(12);
		expect(a.currentTool).toBe("Read");
	});

	it("keeps a deeper event ring than MonitorState's default so the log scrolls", () => {
		const m = new Monitor(base);
		const a = m.register("security", "security");
		for (let i = 0; i < 250; i++) m.pushEvent(a, `e-${i}`);
		expect(a.events.length).toBe(200);
	});

	it("tracks seam coverage handed to it by the coordinator", () => {
		const m = new Monitor(base);
		m.setSeams([{ id: 1, files: ["src/a.ts"] }, { id: 2, files: ["src/b.ts"] }]);
		expect(m.coverage()).toEqual({ covered: 0, total: 2 });
		const a = m.register("security", "security");
		m.applyEvent(a, { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/repo/src/b.ts" } }] } });
		expect(m.coverage()).toEqual({ covered: 1, total: 2 });
		m.coverSeams([1]);
		expect(m.coverage()).toEqual({ covered: 2, total: 2 });
	});

	it("drives the full-screen TUI on a TTY", async () => {
		const term = fakeTerm();
		const m = new Monitor({ ...base, term });
		m.register("security", "security");
		m.start();
		expect(term.starts()).toBe(1);
		expect(term.writes[0]).toContain("code-review");
		await vi.waitFor(() => expect(term.writes.length).toBeGreaterThan(1));
		m.stop();
		expect(term.stops()).toBe(1);
	});

	it("degrades to line output when stdout is not a TTY — no raw mode, no alt screen", async () => {
		const term = fakeTerm({ isTTY: false });
		const out: string[] = [];
		const m = new Monitor({ ...base, term, write: (s) => out.push(s) });
		m.phase = "review";
		const a = m.register("security", "security");
		m.start();

		expect(term.starts()).toBe(0); // never entered raw mode
		expect(term.writes).toHaveLength(0); // never touched the alternate screen
		await vi.waitFor(() => expect(out.length).toBeGreaterThan(0));
		expect(out[0]).toContain("review");
		expect(out.join("")).not.toMatch(/\x1b/);

		a.state = "running";
		await vi.waitFor(() => expect(out.length).toBeGreaterThan(1));
		m.stop();
		expect(out.at(-1)).toContain("agents");
	});

	it("honours an explicit tty override over the terminal's own answer", () => {
		const term = fakeTerm({ isTTY: true });
		const out: string[] = [];
		const m = new Monitor({ ...base, term, tty: false, write: (s) => out.push(s) });
		m.register("security", "security");
		m.start();
		expect(term.starts()).toBe(0);
		m.stop();
		expect(out.length).toBeGreaterThan(0);
	});

	it("q runs the registered quit handler; without one it cancels and tears down", () => {
		const term = fakeTerm();
		const m = new Monitor({ ...base, term });
		m.register("security", "security").state = "running";
		let quits = 0;
		m.onQuit(() => quits++);
		m.start();
		term.press("q");
		expect(quits).toBe(1);
		expect(m.cancelled).toBe(false);
		m.stop();

		const term2 = fakeTerm();
		const m2 = new Monitor({ ...base, term: term2 });
		m2.register("security", "security").state = "running";
		m2.start();
		term2.press("q");
		expect(m2.cancelled).toBe(true);
		expect(term2.stops()).toBe(1);
	});

	it("stop is idempotent and safe to call from an exit handler", () => {
		const term = fakeTerm();
		const m = new Monitor({ ...base, term });
		m.start();
		m.stop();
		m.stop();
		expect(term.stops()).toBe(1);
	});

	it("installs and removes process-level restore handlers", () => {
		const term = fakeTerm();
		const before = {
			exit: process.listenerCount("exit"),
			int: process.listenerCount("SIGINT"),
			term: process.listenerCount("SIGTERM"),
		};
		const m = new Monitor({ intervalMs: 10, term, exitHooks: true });
		m.start();
		expect(process.listenerCount("exit")).toBe(before.exit + 1);
		expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
		expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
		m.stop();
		expect(process.listenerCount("exit")).toBe(before.exit);
		expect(process.listenerCount("SIGINT")).toBe(before.int);
		expect(process.listenerCount("SIGTERM")).toBe(before.term);
	});
});
