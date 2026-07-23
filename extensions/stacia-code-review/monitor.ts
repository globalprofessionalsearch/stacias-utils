/**
 * Live activity monitor: a pinned widget (setWidget) + footer (setStatus) fed by
 * every subagent's event stream, plus an f8 drill-in overlay (ctx.ui.custom) that
 * can kill an agent mid-run. Rendering is fixed-row and ANSI-safe (build plain,
 * clamp to width, then color) — the lessons from the spike.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
// biome-ignore lint/suspicious/noExplicitAny: SDK ctx/session/tui/theme are opaque here
type Any = any;

const TAIL_ROWS = 6;
const clean = (s: string, w: number) =>
	s.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7E]/g, "").slice(0, Math.max(0, w));

export interface Activity {
	label: string;
	role: string;
	state: "queued" | "running" | "done" | "failed" | "killed";
	round: number;
	maxRounds: number;
	attempts: number;
	tokens: number;
	lastTokens: number;
	tokenRate: number;
	toolCalls: number;
	currentTool: string;
	lastEventAt: number;
	events: string[];
	session: Any;
	fail?: string;
}

function bar(rate: number): string {
	const blocks = "▁▂▃▄▅▆▇█";
	if (rate <= 0) return "   ";
	return blocks[Math.min(blocks.length - 1, Math.floor(rate / 40))].repeat(3);
}

export class Monitor {
	readonly registry = new Map<string, Activity>();
	phase = "starting";
	cancelled = false;
	private started = Date.now();
	private timer: ReturnType<typeof setInterval> | null = null;
	private overlayTui: Any = null;

	/** Kill every in-flight agent and mark the whole run cancelled. */
	cancelAll(): void {
		this.cancelled = true;
		for (const a of this.registry.values()) {
			if (a.state === "running" || a.state === "queued") {
				a.state = "killed";
				a.session?.abort?.();
			}
		}
	}

	register(label: string, role: string, maxRounds = 1): Activity {
		const a: Activity = {
			label,
			role,
			state: "queued",
			round: 0,
			maxRounds,
			attempts: 0,
			tokens: 0,
			lastTokens: 0,
			tokenRate: 0,
			toolCalls: 0,
			currentTool: "",
			lastEventAt: 0,
			events: [],
			session: null,
		};
		this.registry.set(label, a);
		return a;
	}

	pushEvent(a: Activity, s: string): void {
		a.events.push(clean(s, 80));
		if (a.events.length > 24) a.events.splice(0, a.events.length - 24);
	}

	/** Wire a subagent session's events into an activity entry. */
	subscribe(a: Activity, session: Any): void {
		a.session = session;
		session.subscribe((event: Any) => {
			a.lastEventAt = Date.now();
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				a.tokens += (event.assistantMessageEvent.delta ?? "").length;
			} else if (event.type === "tool_execution_start") {
				a.toolCalls += 1;
				a.currentTool = event.toolName ?? "";
				this.pushEvent(a, `> ${event.toolName}`);
			} else if (event.type === "tool_execution_end") {
				a.currentTool = "";
			}
			// review-round is managed explicitly by the coordinator (a.round), not per turn
		});
	}

	private widgetLines(): string[] {
		const g = { queued: "·", running: "●", done: "✓", failed: "✗", killed: "☠" } as const;
		const elapsed = ((Date.now() - this.started) / 1000).toFixed(0);
		const vals = [...this.registry.values()];
		const done = vals.filter((a) => a.state === "done").length;
		const busy = vals.filter((a) => a.state === "running").length;
		const gone = vals.filter((a) => a.state === "failed" || a.state === "killed").length;
		const lines = [`code-review — ${this.phase} — ${elapsed}s`];
		for (const a of vals) {
			const rd = a.maxRounds > 1 ? ` r${a.round}/${a.maxRounds}` : "";
			const idle = a.state === "running" && Date.now() - a.lastEventAt > 2500 ? " idle" : "";
			lines.push(`  ${g[a.state]} ${a.role.padEnd(13)} ${bar(a.tokenRate)} ${String(a.tokens).padStart(5)}t${rd} ${a.currentTool.slice(0, 12)}${idle}`);
		}
		lines.push(`  ${vals.length} agents · ${done} done · ${busy} busy · ${gone} gone · f8 drill · esc cancel`);
		return lines;
	}

	start(ctx: Any): void {
		this.started = Date.now();
		this.timer = setInterval(() => {
			for (const a of this.registry.values()) {
				a.tokenRate = Math.max(0, (a.tokens - a.lastTokens) * 4);
				a.lastTokens = a.tokens;
			}
			ctx.ui.setWidget("stacia-code-review", this.widgetLines());
			const done = [...this.registry.values()].filter((a) => a.state === "done").length;
			ctx.ui.setStatus("stacia-code-review", `code-review: ${this.phase} · ${done}/${this.registry.size} · esc cancel`);
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
		if (ctx.mode !== "tui" || this.registry.size === 0) {
			ctx.ui.notify("code-review: no run in progress", "warning");
			return;
		}
		await ctx.ui.custom(
			(tui: Any, theme: Any, _kb: Any, done: (r: null) => void) => {
				this.overlayTui = tui;
				let sel = 0;
				return {
					render: (width: number): string[] => {
						const labels = [...this.registry.keys()];
						sel = Math.min(sel, Math.max(0, labels.length - 1));
						const rows: Array<{ t: string; c: "accent" | "muted" | "dim" | "plain"; sel?: boolean }> = [];
						rows.push({ t: "drill-in  up/down select  k kill  c cancel-all  esc close", c: "accent" });
						labels.forEach((l, i) => {
							const a = this.registry.get(l);
							if (!a) return;
							rows.push({
								t: `${i === sel ? ">" : " "} ${a.role.padEnd(13)} ${a.state.padEnd(7)} ${String(a.tokens).padStart(5)}t ${a.currentTool}`,
								c: "plain",
								sel: i === sel,
							});
						});
						const a = this.registry.get(labels[sel]);
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
						const labels = [...this.registry.keys()];
						if (matchesKey(data, Key.up)) sel = Math.max(0, sel - 1);
						else if (matchesKey(data, Key.down)) sel = Math.min(labels.length - 1, sel + 1);
						else if (data === "k") {
							const a = this.registry.get(labels[sel]);
							if (a && (a.state === "running" || a.state === "queued")) {
								a.state = "killed"; // mark first; queued agents have no session yet
								a.session?.abort?.();
							}
						} else if (data === "c") {
							this.cancelAll();
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
