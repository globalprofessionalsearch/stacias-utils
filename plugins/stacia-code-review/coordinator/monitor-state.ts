/**
 * Pure state logic for the live activity monitor: no pi imports, so this can be
 * unit-tested directly with vitest. monitor.ts wraps this with the pi-tui bits
 * (setWidget/setStatus, the f8 overlay) and delegates all bookkeeping here.
 */

// biome-ignore lint/suspicious/noExplicitAny: SDK session/event shapes are opaque here
type Any = any;

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

export const clean = (s: string, w: number): string =>
	s.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7E]/g, "").slice(0, Math.max(0, w));

export function bar(rate: number): string {
	const blocks = "▁▂▃▄▅▆▇█";
	if (rate <= 0) return "   ";
	return blocks[Math.min(blocks.length - 1, Math.floor(rate / 40))].repeat(3);
}

export class MonitorState {
	readonly registry = new Map<string, Activity>();
	phase = "starting";
	cancelled = false;

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

	/** Apply one subagent session event to its activity entry (the logic behind subscribe). */
	applyEvent(a: Activity, event: Any): void {
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
	}

	/** Pure widget text builder; `started` is the run's start timestamp (ms epoch). */
	widgetLines(started: number): string[] {
		const g = { queued: "·", running: "●", done: "✓", failed: "✗", killed: "☠" } as const;
		const elapsed = ((Date.now() - started) / 1000).toFixed(0);
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
}
