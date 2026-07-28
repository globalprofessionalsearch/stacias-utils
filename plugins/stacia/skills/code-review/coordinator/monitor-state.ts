/**
 * Pure state logic for the live activity monitor: no terminal I/O and no SDK
 * imports, so this can be unit-tested directly with vitest. tui.ts renders it
 * and monitor.ts wires it to the Claude Agent SDK message stream.
 *
 * Render discipline (carried over from the pi version, and load-bearing): build
 * plain text first, clamp it to the available width, and only then colorize.
 * Colorizing before clamping slices ANSI escapes in half and corrupts the frame.
 */

// biome-ignore lint/suspicious/noExplicitAny: SDK message shapes are opaque here
type Any = any;

export type ActivityState = "queued" | "running" | "done" | "failed" | "killed";

export interface Activity {
	label: string;
	role: string;
	state: ActivityState;
	round: number;
	maxRounds: number;
	attempts: number;
	/** Output tokens. Real `usage` when the SDK reports it, else a chars/4 estimate. */
	tokens: number;
	lastTokens: number;
	/** Output tokens per second, recomputed by tick(). */
	tokenRate: number;
	/** Context size of the most recent request (input + cache read + cache creation). */
	inputTokens: number;
	/** Cumulative cost, from the result message. */
	costUsd: number;
	/** True once a real `usage` payload has been seen; false means `tokens` is estimated. */
	usageSeen: boolean;
	toolCalls: number;
	currentTool: string;
	/** What the agent is currently doing — "thinking", a tool name, or "" (between activities). */
	currentActivity: string;
	/** When the current activity started (ms epoch). 0 = no activity. */
	activitySince: number;
	startedAt: number;
	endedAt: number;
	lastEventAt: number;
	events: string[];
	/** The agent's AbortController (or anything with `.abort()`), or null while queued. */
	session: Any;
	fail?: string;
	/** Token bookkeeping across turns — internal to applyEvent. */
	committed: number;
	turnTokens: number;
	turnId: string;
	chars: number;
	streamed: boolean;
	toolIds: Map<string, string>;
}

export interface SeamRef {
	id: string | number;
	files?: string[];
}

export interface MonitorStateOptions {
	/** How many event-log lines to retain per agent. */
	eventLimit?: number;
}

const TERMINAL: ReadonlySet<ActivityState> = new Set<ActivityState>(["done", "failed", "killed"]);

export const clean = (s: string, w: number): string =>
	s.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7E]/g, "").slice(0, Math.max(0, w));

export function bar(rate: number): string {
	const blocks = "▁▂▃▄▅▆▇█";
	if (rate <= 0) return "   ";
	return blocks[Math.min(blocks.length - 1, Math.floor(rate / 40))].repeat(3);
}

/** 812 -> "812", 1204 -> "1.2k", 41000 -> "41k", 2_400_000 -> "2.4M". */
export function fmtNum(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 4200 -> "4s", 95_000 -> "1m35s", 3_800_000 -> "1h03m". */
export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const outTokens = (u: Any): number => num(u?.output_tokens);
const inTokens = (u: Any): number =>
	num(u?.input_tokens) + num(u?.cache_read_input_tokens) + num(u?.cache_creation_input_tokens);

const normPath = (p: unknown): string =>
	typeof p === "string" ? p.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "") : "";

/** Does a tool-visited path cover a seam's file? Handles abs/rel skew and directory reads. */
function pathMatch(seamFile: string, visited: string): boolean {
	if (!seamFile || !visited) return false;
	return (
		seamFile === visited ||
		visited.endsWith(`/${seamFile}`) ||
		seamFile.endsWith(`/${visited}`) ||
		seamFile.startsWith(`${visited}/`)
	);
}

/** Paths a tool call touched. Only unambiguous path params — Grep's `pattern` is a regex. */
function filesFrom(input: Any): string[] {
	if (!input || typeof input !== "object") return [];
	const out: string[] = [];
	for (const k of ["file_path", "path", "notebook_path"]) {
		const v = input[k];
		if (typeof v === "string" && v) out.push(v);
	}
	return out;
}

/** A short "what is it working on" suffix for the event log. */
function toolTarget(input: Any): string {
	if (!input || typeof input !== "object") return "";
	const v = input.file_path ?? input.path ?? input.pattern ?? input.glob;
	if (typeof v !== "string" || !v) return "";
	return v.length > 44 ? `…${v.slice(-43)}` : v;
}

export class MonitorState {
	readonly registry = new Map<string, Activity>();
	/** seam id -> its files (normalized). Populated by setSeams() after comprehension. */
	readonly seams = new Map<string, string[]>();
	readonly seamsCovered = new Set<string>();
	readonly eventLimit: number;
	phase = "starting";
	cancelled = false;

	constructor(opts: MonitorStateOptions = {}) {
		this.eventLimit = Math.max(1, opts.eventLimit ?? 24);
	}

	/** Kill one agent. Queued agents have no controller yet, hence the optional chain. */
	kill(a: Activity): boolean {
		if (TERMINAL.has(a.state)) return false;
		a.state = "killed";
		a.fail = a.fail ?? "killed by user";
		a.session?.abort?.();
		return true;
	}

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
			inputTokens: 0,
			costUsd: 0,
			usageSeen: false,
			toolCalls: 0,
			currentTool: "",
			currentActivity: "",
			activitySince: 0,
			startedAt: 0,
			endedAt: 0,
			lastEventAt: 0,
			events: [],
			session: null,
			committed: 0,
			turnTokens: 0,
			turnId: "",
			chars: 0,
			streamed: false,
			toolIds: new Map(),
		};
		this.registry.set(label, a);
		return a;
	}

	pushEvent(a: Activity, s: string): void {
		a.events.push(clean(s, 80));
		if (a.events.length > this.eventLimit) a.events.splice(0, a.events.length - this.eventLimit);
	}

	/** Per-frame bookkeeping: elapsed-time stamps and the token rate the sparkline reads. */
	tick(now = Date.now(), intervalMs = 250): void {
		const perSecond = intervalMs > 0 ? 1000 / intervalMs : 1;
		for (const a of this.registry.values()) {
			if (a.state === "running" && a.startedAt === 0) a.startedAt = now;
			if (TERMINAL.has(a.state) && a.endedAt === 0) a.endedAt = now;
			a.tokenRate = Math.max(0, (a.tokens - a.lastTokens) * perSecond);
			a.lastTokens = a.tokens;
		}
	}

	// ---- seam coverage -----------------------------------------------------

	/** Seed the seam map (coordinator calls this once comprehension produces it). */
	setSeams(seams: readonly SeamRef[] | undefined): void {
		this.seams.clear();
		this.seamsCovered.clear();
		for (const s of seams ?? []) {
			if (!s || s.id == null) continue;
			this.seams.set(String(s.id), (s.files ?? []).map(normPath).filter(Boolean));
		}
	}

	/** Explicitly mark seams covered (e.g. from synthesis `seam_accounting`). */
	coverSeams(ids: readonly (string | number)[] | undefined): void {
		for (const id of ids ?? []) {
			const k = String(id);
			if (this.seams.has(k)) this.seamsCovered.add(k);
		}
	}

	/** Mark any seam whose files a reviewer just opened as covered. */
	noteFiles(paths: readonly string[]): void {
		if (this.seams.size === 0) return;
		for (const raw of paths) {
			const visited = normPath(raw);
			if (!visited) continue;
			for (const [id, files] of this.seams) {
				if (this.seamsCovered.has(id)) continue;
				if (files.some((f) => pathMatch(f, visited))) this.seamsCovered.add(id);
			}
		}
	}

	coverage(): { covered: number; total: number } {
		return { covered: this.seamsCovered.size, total: this.seams.size };
	}

	// ---- SDK message folding ----------------------------------------------

	/**
	 * Fold one Claude Agent SDK message into an activity entry.
	 *
	 * Shapes (from @anthropic-ai/claude-agent-sdk/sdk.d.ts):
	 *   stream_event   SDKPartialAssistantMessage — raw Anthropic stream events
	 *   assistant      SDKAssistantMessage        — a completed BetaMessage
	 *   user           SDKUserMessage             — carries tool_result blocks
	 *   tool_progress  SDKToolProgressMessage     — long-running tool heartbeat
	 *   result         SDKResultSuccess|Error     — authoritative run totals
	 *   system         api_retry / permission_denied / init
	 */
	applyEvent(a: Activity, event: Any): void {
		if (!event || typeof event !== "object") return;
		a.lastEventAt = Date.now();
		switch (event.type) {
			case "stream_event":
				this.streamEvent(a, event.event);
				break;
			case "assistant":
				this.assistantMessage(a, event);
				break;
			case "user":
				this.userMessage(a, event);
				break;
			case "tool_progress":
				if (typeof event.tool_name === "string" && event.tool_name) a.currentTool = event.tool_name;
				break;
			case "result":
				this.resultMessage(a, event);
				break;
			case "system":
				this.systemMessage(a, event);
				break;
		}
		this.recount(a);
	}

	/** BetaRawMessageStreamEvent — the live, sub-turn signal. */
	private streamEvent(a: Activity, ev: Any): void {
		if (!ev || typeof ev !== "object") return;
		a.streamed = true;
		switch (ev.type) {
			case "message_start":
				this.beginTurn(a, ev.message?.id ?? "");
				this.absorbUsage(a, ev.message?.usage);
				break;
			case "message_delta":
				// BetaMessageDeltaUsage.output_tokens is cumulative for the current turn.
				this.absorbUsage(a, ev.usage);
				break;
			case "content_block_start":
				if (ev.content_block?.type === "tool_use") {
					this.startTool(a, ev.content_block.id, ev.content_block.name, ev.content_block.input);
				} else if (ev.content_block?.type === "thinking") {
					this.setActivity(a, "thinking");
				} else if (ev.content_block?.type === "text") {
					this.setActivity(a, "writing");
				}
				break;
			case "content_block_delta":
				if (ev.delta?.type === "text_delta") a.chars += String(ev.delta.text ?? "").length;
				break;
			case "content_block_stop":
				// Clear the activity if the current one matches what just ended.
				// Tool ends are handled in endTool; this catches thinking/writing.
				if (a.currentActivity === "thinking" || a.currentActivity === "writing") {
					this.setActivity(a, "");
				}
				break;
		}
	}

	/** SDKAssistantMessage — `message` is a BetaMessage with authoritative per-turn usage. */
	private assistantMessage(a: Activity, m: Any): void {
		const msg = m.message ?? {};
		this.beginTurn(a, typeof msg.id === "string" ? msg.id : "");
		this.absorbUsage(a, msg.usage);
		for (const b of Array.isArray(msg.content) ? msg.content : []) {
			if (b?.type === "tool_use") this.startTool(a, b.id, b.name, b.input);
			// Only count text here when partial messages are off; otherwise the deltas
			// already counted it and we'd double-book the fallback estimate.
			else if (b?.type === "text" && !a.streamed) a.chars += String(b.text ?? "").length;
		}
		if (typeof m.error === "string") this.pushEvent(a, `! ${m.error}`);
	}

	/** SDKUserMessage — tool_result blocks close out the in-flight tool. */
	private userMessage(a: Activity, m: Any): void {
		const content = m.message?.content;
		if (!Array.isArray(content)) return;
		for (const b of content) {
			if (b?.type !== "tool_result") continue;
			const name = a.toolIds.get(String(b.tool_use_id)) || a.currentTool || "tool";
			a.currentTool = "";
			this.setActivity(a, "");
			if (b.is_error) this.pushEvent(a, `! ${name} error`);
		}
	}

	/** SDKResultSuccess | SDKResultError — `usage` here is the whole run, not a delta. */
	private resultMessage(a: Activity, r: Any): void {
		if (r.usage) {
			a.usageSeen = true;
			a.committed = outTokens(r.usage) || a.committed + a.turnTokens;
			a.turnTokens = 0;
			a.turnId = "";
			const i = inTokens(r.usage);
			if (i) a.inputTokens = i;
		}
		if (typeof r.total_cost_usd === "number") a.costUsd = r.total_cost_usd;
		a.currentTool = "";
		this.setActivity(a, "");
		if (typeof r.subtype === "string" && r.subtype !== "success") {
			a.fail = a.fail ?? r.subtype;
			this.pushEvent(a, `! ${r.subtype}`);
		}
	}

	private systemMessage(a: Activity, m: Any): void {
		if (m.subtype === "permission_denied") {
			a.currentTool = "";
			this.setActivity(a, "");
			const why = m.decision_reason ? `: ${m.decision_reason}` : "";
			this.pushEvent(a, `! denied ${m.tool_name ?? "tool"}${why}`);
		} else if (m.subtype === "api_retry") {
			this.pushEvent(a, `! retry ${m.attempt ?? "?"}/${m.max_retries ?? "?"} ${m.error ?? ""}`.trimEnd());
		}
	}

	// ---- token bookkeeping -------------------------------------------------

	/** A new message id means the previous turn's tokens are final; bank them. */
	private beginTurn(a: Activity, id: string): void {
		if (!id || id === a.turnId) return;
		a.committed += a.turnTokens;
		a.turnTokens = 0;
		a.turnId = id;
	}

	/** Usage payloads are cumulative-within-turn, and may be re-seen; take the max. */
	private absorbUsage(a: Activity, u: Any): void {
		if (!u || typeof u !== "object") return;
		a.usageSeen = true;
		const out = outTokens(u);
		if (out > a.turnTokens) a.turnTokens = out;
		const i = inTokens(u);
		if (i) a.inputTokens = i;
	}

	/** Real usage when we have it; ~4 chars per token otherwise. */
	private recount(a: Activity): void {
		a.tokens = a.usageSeen ? a.committed + a.turnTokens : Math.round(a.chars / 4);
	}

	private setActivity(a: Activity, activity: string): void {
		if (a.currentActivity !== activity) {
			a.currentActivity = activity;
			a.activitySince = activity ? Date.now() : 0;
		}
	}

	private startTool(a: Activity, id: unknown, name: unknown, input?: Any): void {
		const n = typeof name === "string" && name ? name : "tool";
		const key = typeof id === "string" && id ? id : `${n}#${a.toolCalls}`;
		if (a.toolIds.has(key)) {
			a.currentTool = a.toolIds.get(key) ?? n;
			return;
		}
		if (a.toolIds.size > 512) a.toolIds.clear();
		a.toolIds.set(key, n);
		a.toolCalls += 1;
		a.currentTool = n;
		this.setActivity(a, n);
		const target = toolTarget(input);
		this.pushEvent(a, target ? `> ${n} ${target}` : `> ${n}`);
		this.noteFiles(filesFrom(input));
	}

	// ---- plain-text summaries ----------------------------------------------

	/** Compact plain-text summary. Also the body of the non-TTY fallback. */
	widgetLines(started: number, now = Date.now()): string[] {
		const g = { queued: "·", running: "●", done: "✓", failed: "✗", killed: "☠" } as const;
		const vals = [...this.registry.values()];
		const done = vals.filter((a) => a.state === "done").length;
		const busy = vals.filter((a) => a.state === "running").length;
		const gone = vals.filter((a) => a.state === "failed" || a.state === "killed").length;
		const lines = [`code-review — ${this.phase} — ${fmtDur(now - started)}`];
		for (const a of vals) {
			const rd = a.maxRounds > 1 ? ` r${a.round}/${a.maxRounds}` : "";
			const tok = `${a.usageSeen || a.tokens === 0 ? "" : "~"}${fmtNum(a.tokens)}t`;
			let status = a.currentTool.slice(0, 12);
			if (a.state === "running" && a.currentActivity && a.activitySince) {
				const elapsed = Math.round((now - a.activitySince) / 1000);
				status = `${a.currentActivity.slice(0, 10)} ${elapsed}s`;
			} else if (a.state === "running" && !a.currentActivity && now - (a.lastEventAt || a.startedAt || 0) > 2500) {
				// No stream_event tells us when the model enters thinking — the SDK
				// doesn't yield partial messages unless explicitly opted in. After tool
				// calls finish and no new activity starts, the model is thinking.
				const since = a.lastEventAt || a.startedAt || 0;
				const elapsed = Math.round((now - since) / 1000);
				status = `thinking ${elapsed}s`;
			}
			lines.push(`  ${g[a.state]} ${a.role.padEnd(13)} ${bar(a.tokenRate)} ${tok.padStart(7)}${rd} ${status}`);
		}
		const cov = this.coverage();
		const seams = cov.total ? ` · seams ${cov.covered}/${cov.total}` : "";
		lines.push(`  ${vals.length} agents · ${done} done · ${busy} busy · ${gone} gone${seams}`);
		return lines;
	}

	/** Everything the non-TTY fallback prints, on one line. */
	progressLine(started: number, now = Date.now()): string {
		const vals = [...this.registry.values()];
		const done = vals.filter((a) => a.state === "done").length;
		const busy = vals.filter((a) => a.state === "running");
		const gone = vals.filter((a) => a.state === "failed" || a.state === "killed").length;
		const tokens = vals.reduce((s, a) => s + a.tokens, 0);
		const cov = this.coverage();
		const parts = [`[${fmtDur(now - started).padStart(6)}]`, this.phase, `${done}/${vals.length} done`];
		if (busy.length) parts.push(`${busy.length} busy`);
		if (gone) parts.push(`${gone} gone`);
		if (tokens) parts.push(`${fmtNum(tokens)} tok`);
		if (cov.total) parts.push(`seams ${cov.covered}/${cov.total}`);
		if (busy.length) parts.push(`running: ${busy.map((a) => a.role).join(", ")}`);
		if (this.cancelled) parts.push("CANCELLED");
		return parts.join(" · ");
	}

	/**
	 * Change detector for the non-TTY fallback: everything a human needs to hear
	 * about, and nothing that ticks every frame (tokens, elapsed) — otherwise the
	 * "print on change" throttle degrades into "print every frame".
	 */
	progressKey(): string {
		const agents = [...this.registry.values()].map((a) => `${a.label}:${a.state}:${a.round}`).join(",");
		return `${this.phase}|${this.cancelled}|${this.seamsCovered.size}/${this.seams.size}|${agents}`;
	}
}
