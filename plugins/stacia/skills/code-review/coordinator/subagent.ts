/**
 * Run one read-only subagent to a schema-conforming result.
 *
 * One Agent SDK `query()` per subagent, replacing pi's `createAgentSession`:
 *
 * - isolated: a plain-string `systemPrompt` (which fully replaces the default
 *   prompt) plus `settingSources: []`, `skills: []`, `plugins: []` and
 *   `mcpServers: {}`. That is the whole of pi's nine-method `bareLoader` —
 *   no skills, extensions, prompts, themes or CLAUDE.md leak into a subagent.
 * - restricted toolset: `tools: [Read, Grep, Glob]`, path-confined by
 *   `canUseTool` (confine.ts). Deliberately NOT in `allowedTools` — see below.
 * - structured output: `outputFormat: { type: "json_schema", schema }` replaces
 *   pi's `submit_result` tool + typebox conversion + hand-rolled
 *   validation-retry loop. The SDK owns the retry loop now, so `maxAttempts`
 *   is gone from the spec.
 * - bounded by a timeout: one `AbortController` per query. The same controller
 *   is parked on `activity.session`, which is exactly what MonitorState's
 *   `cancelAll()` and the TUI's kill-one already call `.abort()` on — an
 *   `AbortController` satisfies that shape with no change to monitor-state.ts.
 * - feeds the monitor by iterating the async generator (pi used
 *   `session.subscribe`).
 *
 * Returns the validated result object, or `null` on ANY failure. The
 * coordinator treats `null` as failure and applies its own fail-fast rules.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { confinedToolPolicy, READ_ONLY_TOOLS } from "./confine.ts";
import type { Activity } from "./monitor-state.ts";

// biome-ignore lint/suspicious/noExplicitAny: JSON payloads / opaque SDK messages
type Any = any;

/**
 * The slice of the live monitor a subagent touches.
 *
 * Declared structurally here rather than imported from the TUI so this module
 * stays unit-testable with a plain object and does not depend on the renderer.
 * `applyEvent` is the analogue of pi's `session.subscribe` callback and is
 * optional so a monitor that does not want per-message updates still satisfies
 * the contract.
 */
export interface Monitor {
	readonly cancelled: boolean;
	pushEvent(activity: Activity, text: string): void;
	applyEvent?(activity: Activity, message: unknown): void;
}

export interface SubagentSpec {
	activity: Activity;
	monitor: Monitor;
	/** Bare model id — the SDK has no `provider/id` component. */
	model: string;
	cwd: string;
	systemPrompt: string;
	userPrompt: string;
	/** draft-07 JSON Schema handed to `outputFormat`. */
	schema: Any;
	timeoutMs: number;
	/** Filesystem confinement for Read/Grep/Glob. */
	allowedRoots: string[];
}

/** The `query()` function, narrowed to what this module uses. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<unknown>;

/** Injection seam for tests; production callers pass nothing. */
export interface SubagentDeps {
	query?: QueryFn;
}

/**
 * Build the `query()` options for one subagent.
 *
 * Exported because the confinement guard is only as good as this object:
 * `allowedTools` MUST stay empty (it auto-approves, and an auto-approved call
 * never reaches `canUseTool`) and `settingSources` MUST stay `[]` (otherwise
 * the operator's own ~/.claude/settings.json allow-rules approve the call
 * before the guard sees it, and confinement passes in testing and fails in the
 * field). tests/confine-guard.test.ts asserts both against this function.
 */
export function subagentOptions(spec: SubagentSpec, abortController: AbortController): Options {
	return {
		// A plain string fully replaces Claude Code's default system prompt.
		systemPrompt: spec.systemPrompt,
		model: spec.model,
		cwd: spec.cwd,
		// The RESTRICTING allow-list.
		tools: [...READ_ONLY_TOOLS],
		// Auto-approval list. Must stay empty: anything here bypasses canUseTool.
		allowedTools: [],
		canUseTool: confinedToolPolicy(spec.cwd, spec.allowedRoots),
		// Disable user/project/local settings. Also means no CLAUDE.md.
		settingSources: [],
		// pi's bareLoader, continued: nothing ambient reaches the subagent.
		skills: [],
		plugins: [],
		mcpServers: {},
		strictMcpConfig: true,
		permissionMode: "default",
		outputFormat: { type: "json_schema", schema: spec.schema },
		abortController,
	};
}

const isResult = (m: unknown): m is { type: "result"; subtype: string; structured_output?: unknown; errors?: string[] } =>
	typeof m === "object" && m !== null && (m as Any).type === "result";

export async function runSubagent(spec: SubagentSpec, deps: SubagentDeps = {}): Promise<Any | null> {
	const { activity: a, monitor, timeoutMs } = spec;
	if (a.state === "killed" || monitor.cancelled) {
		a.state = "killed";
		a.fail = "cancelled";
		return null;
	}
	a.state = "running";
	a.lastEventAt = Date.now();

	// Per-agent abort: the timeout below, MonitorState.cancelAll() and the TUI's
	// kill-one all funnel through this one controller.
	const controller = new AbortController();
	a.session = controller;

	let timedOut = false;
	let sawResult = false;
	let result: Any = null;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const run = deps.query ?? (sdkQuery as unknown as QueryFn);
		for await (const message of run({ prompt: spec.userPrompt, options: subagentOptions(spec, controller) })) {
			a.lastEventAt = Date.now();
			monitor.applyEvent?.(a, message);
			if (!isResult(message)) continue;
			sawResult = true;
			if (message.subtype === "success") {
				// Failure shape 2: a "success" result with NO structured_output.
				// The SDK documents this as a failure, not an empty success.
				if (message.structured_output === undefined || message.structured_output === null) {
					a.fail = "result reported success but carried no structured output";
					monitor.pushEvent(a, a.fail);
				} else {
					result = message.structured_output;
					a.attempts = Math.max(a.attempts, 1);
					monitor.pushEvent(a, "structured output accepted");
				}
			} else if (message.subtype === "error_max_structured_output_retries") {
				// Failure shape 1: the SDK's own retry loop gave up.
				a.fail = "structured-output retries exhausted";
				monitor.pushEvent(a, a.fail);
			} else {
				const detail = Array.isArray(message.errors) && message.errors.length ? `: ${message.errors[0]}` : "";
				a.fail = `${message.subtype}${detail}`;
				monitor.pushEvent(a, `error: ${a.fail}`);
			}
		}
	} catch (e) {
		// Failure shape 3: in single-shot mode query() THROWS after yielding the
		// error result, so the subtype checks above are not sufficient on their
		// own. Keep the more specific reason if the result message already set one.
		const msg = e instanceof Error ? e.message : String(e);
		if (!a.fail) a.fail = msg;
		monitor.pushEvent(a, `error: ${msg}`);
	} finally {
		clearTimeout(timer);
	}

	if ((a.state as string) === "killed") {
		a.fail = a.fail ?? "killed";
		return null;
	}
	if (timedOut) {
		monitor.pushEvent(a, "timeout");
		a.fail = `timeout after ${Math.round(timeoutMs / 1000)}s`;
		a.state = "failed";
		return null;
	}
	if (result !== null) {
		a.state = "done";
		return result;
	}
	a.state = "failed";
	a.fail = a.fail ?? (sawResult ? "no conforming structured output" : "subagent produced no result message");
	return null;
}
