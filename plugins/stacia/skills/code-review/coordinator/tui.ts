/**
 * Zero-dependency terminal UI for the coordinator.
 *
 * The pi version borrowed screen space from a host editor (pinned widget lines
 * plus an f8 overlay). This process owns the terminal outright, so there is one
 * always-on view: header, agent table, and a scrollable event log.
 *
 * Everything above the `Term` seam is a pure function of `MonitorState`:
 *   frame(state, view) -> Row[]   plain text, no escapes
 *   paint(rows, width) -> string[] clamp first, colorize second
 * Raw-mode stdin and the alternate screen live behind `Term` and are the only
 * untestable part; `nodeTerm()` is the single implementation of that seam.
 */

import { type Activity, type ActivityState, type MonitorState, bar, fmtDur, fmtNum } from "./monitor-state.ts";

// biome-ignore lint/suspicious/noExplicitAny: node stream handles are structurally typed here
type Any = any;

export type Color = "plain" | "accent" | "muted" | "dim" | "ok" | "warn" | "err" | "sel";

export interface Row {
	t: string;
	c: Color;
}

const CODES: Record<Color, string> = {
	plain: "",
	accent: "36",
	muted: "90",
	dim: "2",
	ok: "32",
	warn: "33",
	err: "31",
	sel: "7",
};

/** The whole of what `theme.fg` used to do. */
export function fg(color: Color, s: string, enabled = true): string {
	const c = CODES[color];
	return enabled && c ? `\x1b[${c}m${s}\x1b[0m` : s;
}

/**
 * monitor-state's `clean()` for frame rows, but keeps printable non-ASCII so the
 * status glyphs and the sparkline survive. Control and format characters still go.
 */
export const fit = (s: string, w: number): string =>
	s.replace(/[\r\n\t]+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, Math.max(0, w));

// ---- keypress decoding ------------------------------------------------------

export type KeyName = string;

const CSI: Record<string, KeyName> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	"1~": "home",
	"4~": "end",
	"5~": "pageup",
	"6~": "pagedown",
	"7~": "home",
	"8~": "end",
};

/**
 * Decode one raw-mode stdin chunk into key names.
 *
 * The ESC ambiguity: a lone `\x1b` is the Escape key, but `\x1b[A` is Up. A
 * terminal delivers a whole escape sequence in a single read, so we resolve it
 * per chunk rather than with a timer — if the chunk holds nothing after `\x1b`
 * (or nothing that starts a CSI/SS3 sequence), it was the Escape key.
 */
export function decodeKeys(data: string): KeyName[] {
	const out: KeyName[] = [];
	let i = 0;
	while (i < data.length) {
		const ch = data[i];
		if (ch === "\x1b") {
			const next = data[i + 1];
			if (next === "[" || next === "O") {
				let j = i + 2;
				while (j < data.length && !/[@-~]/.test(data[j])) j++;
				if (j >= data.length) break; // truncated sequence: drop it, don't emit a stray esc
				const name = CSI[data.slice(i + 2, j + 1)];
				if (name) out.push(name);
				i = j + 1;
				continue;
			}
			out.push("escape");
			i += 1;
			continue;
		}
		if (ch === "\x03") out.push("ctrl-c");
		else if (ch === "\x04") out.push("ctrl-d");
		else if (ch === "\r" || ch === "\n") out.push("enter");
		else if (ch >= " ") out.push(ch);
		i += 1;
	}
	return out;
}

// ---- rendering --------------------------------------------------------------

export interface View {
	/** Index of the selected agent. */
	sel: number;
	/** Event-log scrollback distance from the live tail, in lines. */
	scroll: number;
	started: number;
	now: number;
	/** Terminal rows; the frame is exactly this tall. */
	height: number;
}

const GLYPH: Record<ActivityState, string> = {
	queued: "·",
	running: "●",
	done: "✓",
	failed: "✗",
	killed: "☠",
};

const STATE_COLOR: Record<ActivityState, Color> = {
	queued: "dim",
	running: "plain",
	done: "ok",
	failed: "err",
	killed: "warn",
};

const FOOTER = "↑↓ select · pgup/pgdn log · k kill · c/esc cancel-all · q quit";

function agentRow(a: Activity, selected: boolean, now: number): string {
	const rd = a.maxRounds > 1 ? `r${a.round}/${a.maxRounds}` : "";
	const el = a.startedAt ? fmtDur((a.endedAt || now) - a.startedAt) : "";
	const tok = `${a.usageSeen || a.tokens === 0 ? "" : "~"}${fmtNum(a.tokens)}t`;
	const ctx = a.inputTokens ? `${fmtNum(a.inputTokens)} ctx` : "";
	let status = a.currentTool.slice(0, 14);
	if (a.state === "running" && a.currentActivity && a.activitySince) {
		const secs = Math.round((now - a.activitySince) / 1000);
		status = `${a.currentActivity.slice(0, 12)} ${secs}s`;
	} else if (a.state === "running" && !a.currentActivity && now - (a.lastEventAt || a.startedAt || 0) > 2500) {
		const secs = Math.round((now - (a.lastEventAt || a.startedAt || 0)) / 1000);
		status = `thinking ${secs}s`;
	}
	return [
		selected ? ">" : " ",
		GLYPH[a.state],
		a.role.padEnd(13),
		a.state.padEnd(7),
		bar(a.tokenRate),
		tok.padStart(7),
		ctx.padStart(9),
		rd.padEnd(6),
		el.padStart(6),
		` ${status}`,
	].join(" ");
}

/** Build the whole frame as plain text. Pure: no escapes, no I/O, no clock. */
export function frame(state: MonitorState, view: View): Row[] {
	const vals = [...state.registry.values()];
	const height = Math.max(6, view.height);
	const sel = vals.length === 0 ? 0 : Math.min(Math.max(0, view.sel), vals.length - 1);

	const done = vals.filter((a) => a.state === "done").length;
	const busy = vals.filter((a) => a.state === "running").length;
	const gone = vals.filter((a) => a.state === "failed" || a.state === "killed").length;
	const cost = vals.reduce((s, a) => s + a.costUsd, 0);

	const head: Row[] = [];
	head.push({
		t: `code-review — ${state.phase} — ${fmtDur(view.now - view.started)}${state.cancelled ? " — CANCELLED" : ""}`,
		c: state.cancelled ? "err" : "accent",
	});
	const cov = state.coverage();
	const meta = [`${vals.length} agents`, `${done} done`, `${busy} busy`, `${gone} gone`];
	if (cov.total) meta.push(`seams ${cov.covered}/${cov.total}`);
	if (cost > 0) meta.push(`$${cost.toFixed(3)}`);
	head.push({ t: meta.join(" · "), c: "muted" });
	head.push({ t: "", c: "plain" });

	// Window the agent table so the event log always keeps a usable pane.
	const cap = Math.max(1, height - 8);
	let from = 0;
	if (vals.length > cap) from = Math.min(Math.max(0, sel - Math.floor(cap / 2)), vals.length - cap);
	const shown = vals.slice(from, from + cap);
	if (from > 0) head.push({ t: `  … ${from} above`, c: "dim" });
	for (const [i, a] of shown.entries()) {
		const isSel = from + i === sel;
		head.push({ t: agentRow(a, isSel, view.now), c: isSel ? "sel" : STATE_COLOR[a.state] });
	}
	const below = vals.length - (from + shown.length);
	if (below > 0) head.push({ t: `  … ${below} below`, c: "dim" });
	if (vals.length === 0) head.push({ t: "  (no agents registered yet)", c: "dim" });

	head.push({ t: "", c: "plain" });

	const active = vals[sel];
	const events = active?.events ?? [];
	const logH = Math.max(1, height - head.length - 2);
	const maxScroll = Math.max(0, events.length - logH);
	const scroll = Math.min(Math.max(0, view.scroll), maxScroll);
	const start = maxScroll - scroll;
	const slice = events.slice(start, start + logH);

	const where = events.length ? `${start + 1}-${start + slice.length}/${events.length}` : "0";
	const more = scroll > 0 ? " ↑more" : "";
	const fail = active?.fail ? `  fail: ${active.fail}` : "";
	head.push({ t: `events [${active?.label ?? "-"}] ${where}${more}${fail}`, c: active?.fail ? "err" : "muted" });

	const rows = [...head];
	for (let i = 0; i < logH; i++) rows.push({ t: `  ${slice[i] ?? ""}`, c: "dim" });
	rows.push({ t: FOOTER, c: "accent" });
	return rows.slice(0, height);
}

/** Clamp to width first, colorize second. Reversing this corrupts the layout. */
export function paint(rows: readonly Row[], width: number, color = true): string[] {
	const w = Math.max(1, width - 1); // leave the last column free so nothing auto-wraps
	return rows.map(({ t, c }) => {
		const line = fit(t, w);
		return fg(c, c === "sel" ? line.padEnd(w) : line, color);
	});
}

// ---- the terminal seam ------------------------------------------------------

export interface Term {
	readonly isTTY: boolean;
	columns(): number;
	rows(): number;
	write(s: string): void;
	onKey(cb: (k: KeyName) => void): void;
	/** Enter raw mode + alternate screen, hide the cursor. */
	start(): void;
	/** Undo all of it. Must be safe to call twice, and from an exit handler. */
	stop(): void;
}

export function nodeTerm(stdin: Any = process.stdin, stdout: Any = process.stdout): Term {
	let handler: ((k: KeyName) => void) | null = null;
	let active = false;
	const onData = (buf: Any) => {
		for (const k of decodeKeys(String(buf))) handler?.(k);
	};
	return {
		get isTTY() {
			return Boolean(stdout?.isTTY && stdin?.isTTY);
		},
		columns: () => Math.max(40, stdout?.columns ?? 80),
		rows: () => Math.max(8, stdout?.rows ?? 24),
		write: (s: string) => {
			stdout?.write(s);
		},
		onKey: (cb) => {
			handler = cb;
		},
		start() {
			if (active) return;
			active = true;
			stdin?.setRawMode?.(true);
			stdin?.resume?.();
			stdin?.setEncoding?.("utf8");
			stdin?.on?.("data", onData);
			stdout?.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
		},
		stop() {
			if (!active) return;
			active = false;
			stdout?.write("\x1b[?25h\x1b[?1049l");
			stdin?.off?.("data", onData);
			stdin?.setRawMode?.(false);
			stdin?.pause?.();
		},
	};
}

// ---- painters ---------------------------------------------------------------

export interface Painter {
	start(started: number): void;
	render(now?: number): void;
	stop(): void;
}

export interface TuiActions {
	kill(a: Activity): void;
	cancelAll(): void;
	quit(): void;
}

export class Tui implements Painter {
	private sel = 0;
	private scroll = 0;
	private started = Date.now();
	private readonly state: MonitorState;
	private readonly term: Term;
	private readonly actions: TuiActions;
	private readonly color: boolean;

	// Plain field assignment, not parameter properties: this package's .ts runs
	// directly under Node's strip-only type stripping, which rejects those.
	constructor(state: MonitorState, term: Term, actions: TuiActions, color = true) {
		this.state = state;
		this.term = term;
		this.actions = actions;
		this.color = color;
	}

	start(started: number): void {
		this.started = started;
		this.term.onKey((k) => this.handleKey(k));
		this.term.start();
		this.render();
	}

	stop(): void {
		this.term.stop();
	}

	render(now = Date.now()): void {
		const height = this.term.rows();
		const lines = paint(frame(this.state, { sel: this.sel, scroll: this.scroll, started: this.started, now, height }), this.term.columns(), this.color);
		let out = "\x1b[H";
		for (let i = 0; i < height; i++) out += `${lines[i] ?? ""}\x1b[K${i < height - 1 ? "\r\n" : ""}`;
		this.term.write(out);
	}

	/** Exposed for tests: the whole input surface, with no terminal involved. */
	handleKey(k: KeyName): void {
		const n = this.state.registry.size;
		const page = Math.max(1, this.term.rows() - 10);
		switch (k) {
			case "up":
				this.sel = Math.max(0, this.sel - 1);
				this.scroll = 0;
				break;
			case "down":
				this.sel = Math.min(Math.max(0, n - 1), this.sel + 1);
				this.scroll = 0;
				break;
			case "pageup":
				this.scroll += page;
				break;
			case "pagedown":
				this.scroll = Math.max(0, this.scroll - page);
				break;
			case "home":
				this.scroll = Number.MAX_SAFE_INTEGER;
				break;
			case "end":
				this.scroll = 0;
				break;
			case "k": {
				const a = this.selected();
				if (a) this.actions.kill(a);
				break;
			}
			case "c":
			case "escape":
				this.actions.cancelAll();
				break;
			case "q":
				this.actions.quit();
				return;
			case "ctrl-c":
			case "ctrl-d":
				this.actions.cancelAll();
				this.actions.quit();
				return;
			default:
				return;
		}
		this.scroll = Math.min(this.scroll, Math.max(0, this.selected()?.events.length ?? 0));
		this.render();
	}

	private selected(): Activity | undefined {
		return [...this.state.registry.values()][this.sel];
	}
}

/**
 * Non-TTY fallback: no raw mode, no alternate screen, no cursor games. Prints a
 * progress line whenever something a human cares about changes, plus a heartbeat
 * so a long silent stage still shows the run is alive.
 */
export class LinePainter implements Painter {
	private key = "";
	private last = 0;
	private started = Date.now();
	private readonly state: MonitorState;
	private readonly write: (s: string) => void;
	private readonly heartbeatMs: number;

	constructor(state: MonitorState, write: (s: string) => void, heartbeatMs = 30_000) {
		this.state = state;
		this.write = write;
		this.heartbeatMs = heartbeatMs;
	}

	start(started: number): void {
		this.started = started;
		this.key = "";
		this.last = 0;
	}

	render(now = Date.now()): void {
		const key = this.state.progressKey();
		if (key === this.key && now - this.last < this.heartbeatMs) return;
		this.key = key;
		this.last = now;
		this.write(`${this.state.progressLine(this.started, now)}\n`);
	}

	stop(): void {
		const now = Date.now();
		for (const line of this.state.widgetLines(this.started, now)) this.write(`${line}\n`);
	}
}
