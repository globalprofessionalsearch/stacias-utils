/**
 * The live activity monitor the coordinator talks to: MonitorState (all the
 * bookkeeping) plus a painter (tui.ts) and the process-lifecycle plumbing that
 * guarantees the terminal is handed back however this process ends.
 *
 * Ported from the pi extension's monitor.ts minus everything pi-shaped: no
 * setWidget/setStatus, no f8 overlay, no pi-tui key matching. A TTY gets the
 * full-screen Tui; anything else (CI, `bash -c`, a pipe) gets LinePainter.
 */

import { type Activity, MonitorState, type SeamRef } from "./monitor-state.ts";
import { LinePainter, type Painter, type Term, Tui, nodeTerm } from "./tui.ts";

// biome-ignore lint/suspicious/noExplicitAny: AbortController-ish and SDK messages are opaque here
type Any = any;

export type { Activity, SeamRef };

export interface MonitorOptions {
	/** Repaint / token-rate sampling interval. */
	intervalMs?: number;
	/** Event-log lines retained per agent. Deeper than pi's 24 because the log scrolls now. */
	eventLimit?: number;
	/** Terminal seam. Defaults to the real stdin/stdout pair. */
	term?: Term;
	/** Where LinePainter writes in the non-TTY fallback. */
	write?: (s: string) => void;
	/** Force a mode instead of sniffing `isTTY`. */
	tty?: boolean;
	/** Install SIGINT/SIGTERM/exit/uncaught handlers. Off in tests. */
	exitHooks?: boolean;
	colors?: boolean;
}

export class Monitor {
	readonly state: MonitorState;
	private started = Date.now();
	private timer: ReturnType<typeof setInterval> | null = null;
	private painter: Painter | null = null;
	private term: Term | null = null;
	private unhook: (() => void) | null = null;
	private quitHandler: (() => void) | null = null;
	private readonly opts: MonitorOptions;

	constructor(opts: MonitorOptions = {}) {
		this.opts = opts;
		this.state = new MonitorState({ eventLimit: opts.eventLimit ?? 200 });
	}

	// ---- the surface coordinator.ts / subagent.ts use ------------------------

	get registry(): Map<string, Activity> {
		return this.state.registry;
	}

	get phase(): string {
		return this.state.phase;
	}

	set phase(p: string) {
		this.state.phase = p;
	}

	get cancelled(): boolean {
		return this.state.cancelled;
	}

	register(label: string, role: string, maxRounds = 1): Activity {
		return this.state.register(label, role, maxRounds);
	}

	pushEvent(a: Activity, s: string): void {
		this.state.pushEvent(a, s);
	}

	/**
	 * Give an activity its AbortController, so `k` and cancel-all can reach it.
	 * `Activity.session` is the slot; null is fine (queued agents have none yet).
	 */
	attach(a: Activity, controller: Any): void {
		a.session = controller ?? null;
	}

	/**
	 * Fold one message from `query()`'s async generator into the activity entry.
	 * This is the analogue of pi's `session.subscribe` callback, and the name
	 * `subagent.ts`'s structural `Monitor` interface expects.
	 */
	applyEvent(a: Activity, message: Any): void {
		this.state.applyEvent(a, message);
	}

	/** Kill one agent: a direct abort() on its controller. */
	kill(a: Activity): boolean {
		return this.state.kill(a);
	}

	/** Kill every in-flight agent and mark the whole run cancelled. */
	cancelAll(): void {
		this.state.cancelAll();
		this.painter?.render();
	}

	/** Seed the seam map after comprehension so coverage can be tracked live. */
	setSeams(seams: readonly SeamRef[] | undefined): void {
		this.state.setSeams(seams);
	}

	/** Mark seams covered explicitly (e.g. from synthesis `seam_accounting`). */
	coverSeams(ids: readonly (string | number)[] | undefined): void {
		this.state.coverSeams(ids);
	}

	coverage(): { covered: number; total: number } {
		return this.state.coverage();
	}

	/** Called when the user presses `q` (or ctrl-c). Default: cancel and tear down. */
	onQuit(cb: () => void): void {
		this.quitHandler = cb;
	}

	// ---- lifecycle -----------------------------------------------------------

	start(): void {
		if (this.painter) return;
		this.started = Date.now();
		const interval = this.opts.intervalMs ?? 250;
		this.term = this.opts.term ?? nodeTerm();
		const tty = this.opts.tty ?? this.term.isTTY;

		this.painter = tty
			? new Tui(
					this.state,
					this.term,
					{ kill: (a) => this.kill(a), cancelAll: () => this.cancelAll(), quit: () => this.quit() },
					this.opts.colors ?? true,
				)
			: new LinePainter(this.state, this.opts.write ?? ((s) => process.stdout.write(s)));

		if (this.opts.exitHooks ?? true) this.installExitHooks();
		this.painter.start(this.started);
		this.timer = setInterval(() => {
			this.state.tick(Date.now(), interval);
			this.painter?.render();
		}, interval);
		this.timer.unref?.();
	}

	/** Idempotent, synchronous, and safe from an `exit` handler. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		const painter = this.painter;
		this.painter = null;
		this.state.tick(Date.now(), this.opts.intervalMs ?? 250);
		painter?.stop();
		this.unhook?.();
		this.unhook = null;
	}

	private quit(): void {
		if (this.quitHandler) {
			this.quitHandler();
			return;
		}
		this.state.cancelAll();
		this.stop();
	}

	/**
	 * A coordinator that dies leaving the terminal in raw mode with a hidden
	 * cursor is a bad citizen. Cover every exit: normal, signal, and fatal.
	 */
	private installExitHooks(): void {
		if (this.unhook) return;
		const onExit = () => this.stop();
		const onSignal = (code: number) => () => {
			this.state.cancelAll();
			this.stop();
			process.exit(code);
		};
		const onFatal = (err: unknown) => {
			this.stop();
			console.error(err);
			process.exit(1);
		};
		const sigint = onSignal(130);
		const sigterm = onSignal(143);
		// Only claim the fatal paths if nothing else has; otherwise the `exit`
		// listener still restores the terminal on Node's default crash path.
		const takeFatal = process.listenerCount("uncaughtException") === 0;

		process.on("exit", onExit);
		process.on("SIGINT", sigint);
		process.on("SIGTERM", sigterm);
		if (takeFatal) {
			process.on("uncaughtException", onFatal);
			process.on("unhandledRejection", onFatal);
		}
		this.unhook = () => {
			process.off("exit", onExit);
			process.off("SIGINT", sigint);
			process.off("SIGTERM", sigterm);
			if (takeFatal) {
				process.off("uncaughtException", onFatal);
				process.off("unhandledRejection", onFatal);
			}
		};
	}
}
