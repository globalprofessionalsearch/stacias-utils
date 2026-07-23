/**
 * Live activity monitor: a pinned widget (setWidget) + footer (setStatus) fed by
 * every subagent's event stream, plus an f8 drill-in overlay (ctx.ui.custom) that
 * can kill an agent mid-run. Rendering is fixed-row and ANSI-safe (build plain,
 * clamp to width, then color) — the lessons from the spike.
 *
 * All non-pi state logic (registry, register/pushEvent/cancelAll, the
 * event->activity update used by subscribe, and the widget-line builder) lives
 * in monitor-state.ts so it's importable by vitest without pulling in pi-tui.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type Activity, clean, MonitorState } from "./monitor-state.ts";

// biome-ignore lint/suspicious/noExplicitAny: SDK ctx/session/tui/theme are opaque here
type Any = any;

const TAIL_ROWS = 6;

export type { Activity };

export class Monitor {
	private readonly state = new MonitorState();
	private started = Date.now();
	private timer: ReturnType<typeof setInterval> | null = null;
	private overlayTui: Any = null;

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

	/** Kill every in-flight agent and mark the whole run cancelled. */
	cancelAll(): void {
		this.state.cancelAll();
	}

	register(label: string, role: string, maxRounds = 1): Activity {
		return this.state.register(label, role, maxRounds);
	}

	pushEvent(a: Activity, s: string): void {
		this.state.pushEvent(a, s);
	}

	/** Wire a subagent session's events into an activity entry. */
	subscribe(a: Activity, session: Any): void {
		a.session = session;
		session.subscribe((event: Any) => this.state.applyEvent(a, event));
	}

	start(ctx: Any): void {
		this.started = Date.now();
		this.timer = setInterval(() => {
			for (const a of this.state.registry.values()) {
				a.tokenRate = Math.max(0, (a.tokens - a.lastTokens) * 4);
				a.lastTokens = a.tokens;
			}
			ctx.ui.setWidget("stacia-code-review", this.state.widgetLines(this.started));
			const done = [...this.state.registry.values()].filter((a) => a.state === "done").length;
			ctx.ui.setStatus("stacia-code-review", `code-review: ${this.state.phase} · ${done}/${this.state.registry.size} · esc cancel`);
			this.overlayTui?.requestRender();
		}, 250);
	}

	stop(ctx: Any): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		ctx.ui.setWidget("stacia-code-review", undefined);
		ctx.ui.setStatus("stacia-code-review", undefined);
	}

	async openOverlay(ctx: Any): Promise<void> {
		if (ctx.mode !== "tui" || this.state.registry.size === 0) {
			ctx.ui.notify("code-review: no run in progress", "warning");
			return;
		}
		await ctx.ui.custom(
			(tui: Any, theme: Any, _kb: Any, done: (r: null) => void) => {
				this.overlayTui = tui;
				let sel = 0;
				return {
					render: (width: number): string[] => {
						const labels = [...this.state.registry.keys()];
						sel = Math.min(sel, Math.max(0, labels.length - 1));
						const rows: Array<{ t: string; c: "accent" | "muted" | "dim" | "plain"; sel?: boolean }> = [];
						rows.push({ t: "drill-in  up/down select  k kill  c cancel-all  esc close", c: "accent" });
						labels.forEach((l, i) => {
							const a = this.state.registry.get(l);
							if (!a) return;
							rows.push({
								t: `${i === sel ? ">" : " "} ${a.role.padEnd(13)} ${a.state.padEnd(7)} ${String(a.tokens).padStart(5)}t ${a.currentTool}`,
								c: "plain",
								sel: i === sel,
							});
						});
						const a = this.state.registry.get(labels[sel]);
						rows.push({ t: "", c: "plain" });
						rows.push({ t: `events [${labels[sel] ?? "-"}]:`, c: "muted" });
						const ev = (a?.events ?? []).slice(-TAIL_ROWS);
						for (let i = 0; i < TAIL_ROWS; i++) rows.push({ t: `  ${ev[i] ?? ""}`, c: "dim" });
						return rows.map(({ t, c, sel: s }) => {
							const line = clean(t, width);
							if (c === "plain") return s ? theme.fg("accent", line) : line;
							return theme.fg(c, line);
						});
					},
					handleInput: (data: string) => {
						const labels = [...this.state.registry.keys()];
						if (matchesKey(data, Key.up)) sel = Math.max(0, sel - 1);
						else if (matchesKey(data, Key.down)) sel = Math.min(labels.length - 1, sel + 1);
						else if (data === "k") {
							const a = this.state.registry.get(labels[sel]);
							if (a && (a.state === "running" || a.state === "queued")) {
								a.state = "killed"; // mark first; queued agents have no session yet
								a.session?.abort?.();
							}
						} else if (data === "c") {
							this.state.cancelAll();
							done(null);
							return;
						} else if (matchesKey(data, Key.escape)) {
							done(null);
							return;
						}
						tui.requestRender();
					},
					invalidate: () => {},
				};
			},
			{ overlay: true, overlayOptions: { width: "62%", minWidth: 48, maxHeight: "80%", anchor: "center" } },
		);
		this.overlayTui = null;
	}
}
