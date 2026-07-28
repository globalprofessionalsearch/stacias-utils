/**
 * Run one read-only subagent to a schema-conforming result.
 *
 * One Agent SDK `query()` per subagent:
 *
 * - isolated: a plain-string `systemPrompt` (which fully replaces the default
 *   prompt) plus `settingSources: []`, `skills: []`, `plugins: []` and
 *   `mcpServers` containing only our submit_result server. That is the whole
 *   of pi's nine-method `bareLoader` — no skills, extensions, prompts, themes
 *   or CLAUDE.md leak into a subagent.
 * - restricted toolset: `tools: [Read, Grep, Glob, submit_result]`,
 *   path-confined by `canUseTool` (confine.ts). Deliberately NOT in
 *   `allowedTools` — see below.
 * - structured output via an in-process MCP tool (`submit_result`): the
 *   subagent calls the tool, our handler validates with `validate.ts`, and
 *   returns clear error messages or accepts. This replaces the SDK's opaque
 *   `outputFormat` + Ajv machinery, giving us full visibility into validation
 *   failures and full control over the error text the model sees.
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

import { createSdkMcpServer, query as sdkQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { confinedToolPolicy, READ_ONLY_TOOLS, SUBMIT_MCP_TOOL, SUBMIT_SERVER_NAME, SUBMIT_TOOL_NAME } from "./confine.ts";
import type { Activity } from "./monitor-state.ts";
import { validate } from "./validate.ts";

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
	/** draft-07 JSON Schema for the submit_result tool. */
	schema: Any;
	timeoutMs: number;
	/** Filesystem confinement for Read/Grep/Glob. */
	allowedRoots: string[];
	/** Max validation attempts before giving up. */
	maxAttempts?: number;
}

/** The `query()` function, narrowed to what this module uses. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<unknown>;

/** Injection seam for tests; production callers pass nothing. */
export interface SubagentDeps {
	query?: QueryFn;
	/** Override the result holder — lets tests set a result without the MCP server. */
	resultHolder?: ResultHolder;
}

// ---- result capture --------------------------------------------------------

export interface ResultHolder {
	value: Any | null;
	attempts: number;
	lastErrors: string[];
}

export function createResultHolder(): ResultHolder {
	return { value: null, attempts: 0, lastErrors: [] };
}

const DEFAULT_MAX_ATTEMPTS = 5;

const SUBMIT_INSTRUCTION =
	"\n\nWhen your analysis is complete, call the submit_result tool to deliver your structured output. Do not output results as text — use the tool.";

// ---- JSON Schema → Zod conversion (our schema subset only) -----------------

type ZodAny = z.ZodTypeAny;

function jsonSchemaToZod(node: Any): ZodAny {
	if (!node || typeof node !== "object") return z.unknown();

	const rawType = node.type;
	const types: string[] = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
	const desc: string | undefined = node.description;

	if (node.enum) {
		const lit = z.union(node.enum.map((v: Any) => z.literal(v)));
		return desc ? lit.describe(desc) : lit;
	}

	if (types.length > 1) {
		const branches = types.map((t) => jsonSchemaToZod({ ...node, type: t, enum: undefined }));
		const u = z.union(branches as [ZodAny, ZodAny, ...ZodAny[]]);
		return desc ? u.describe(desc) : u;
	}

	const t = types[0];

	if (t === "object" && node.properties) {
		const shape: Record<string, ZodAny> = {};
		const req = new Set<string>(node.required ?? []);
		for (const [key, sub] of Object.entries(node.properties)) {
			const field = jsonSchemaToZod(sub);
			shape[key] = req.has(key) ? field : field.optional();
		}
		const obj = z.object(shape);
		return desc ? obj.describe(desc) : obj;
	}
	if (t === "array") {
		let arr: ZodAny = node.items ? z.array(jsonSchemaToZod(node.items)) : z.array(z.unknown());
		return desc ? arr.describe(desc) : arr;
	}
	if (t === "string") {
		const s = z.string();
		return desc ? s.describe(desc) : s;
	}
	if (t === "integer") {
		const i = z.number().int();
		return desc ? i.describe(desc) : i;
	}
	if (t === "number") {
		const n = z.number();
		return desc ? n.describe(desc) : n;
	}
	if (t === "boolean") {
		const b = z.boolean();
		return desc ? b.describe(desc) : b;
	}
	return z.unknown();
}

/**
 * Convert a top-level JSON Schema object into a Zod raw shape (the format
 * `tool()` expects for `inputSchema`). Each top-level property becomes a
 * named tool parameter with full type information, so the model sees
 * structured parameters rather than a single opaque `output` field.
 */
export function schemaToZodShape(schema: Any): Record<string, ZodAny> {
	if (schema?.type !== "object" || !schema.properties) return { output: z.unknown() };
	const shape: Record<string, ZodAny> = {};
	const req = new Set<string>(schema.required ?? []);
	for (const [key, sub] of Object.entries(schema.properties)) {
		const field = jsonSchemaToZod(sub);
		shape[key] = req.has(key) ? field : field.optional();
	}
	return shape;
}

// ---- submit_result MCP server ----------------------------------------------

/**
 * Create an in-process MCP server with a single `submit_result` tool.
 *
 * The tool parameters mirror the JSON Schema's top-level properties, so the
 * model sees named, typed parameters — not a single opaque wrapper. Validation
 * still runs through `validate.ts` for clear, LLM-tuned error messages.
 */
export function createSubmitResultServer(
	schema: Any,
	holder: ResultHolder,
	maxAttempts: number,
	onAttempt?: (attempt: number, errors: string[]) => void,
) {
	const zodShape = schemaToZodShape(schema);
	return createSdkMcpServer({
		name: SUBMIT_SERVER_NAME,
		alwaysLoad: true,
		tools: [
			tool(
				SUBMIT_TOOL_NAME,
				"Submit your structured analysis result.",
				zodShape,
				async (args) => {
					holder.attempts++;
					const errors = validate(args, schema);
					if (errors.length > 0) {
						holder.lastErrors = errors;
						onAttempt?.(holder.attempts, errors);
						if (holder.attempts >= maxAttempts) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Validation failed (attempt ${holder.attempts}/${maxAttempts} — final attempt):\n${errors.join("\n")}\n\nMaximum attempts reached. Produce your best-effort output as text.`,
									},
								],
								isError: true,
							};
						}
						return {
							content: [
								{
									type: "text" as const,
									text: `Validation failed (attempt ${holder.attempts}/${maxAttempts}):\n${errors.join("\n")}\n\nFix these errors and call submit_result again.`,
								},
							],
							isError: true,
						};
					}
					holder.value = args;
					holder.lastErrors = [];
					onAttempt?.(holder.attempts, []);
					return {
						content: [{ type: "text" as const, text: "Output accepted." }],
					};
				},
			),
		],
	});
}

// ---- options builder -------------------------------------------------------

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
export function subagentOptions(
	spec: SubagentSpec,
	abortController: AbortController,
	mcpServers: Record<string, Any> = {},
): Options {
	return {
		systemPrompt: spec.systemPrompt + SUBMIT_INSTRUCTION,
		model: spec.model,
		cwd: spec.cwd,
		tools: [...READ_ONLY_TOOLS, SUBMIT_MCP_TOOL],
		allowedTools: [],
		canUseTool: confinedToolPolicy(spec.cwd, spec.allowedRoots),
		settingSources: [],
		skills: [],
		plugins: [],
		mcpServers,
		strictMcpConfig: true,
		permissionMode: "default",
		abortController,
	};
}

// ---- runner ----------------------------------------------------------------

const isResult = (m: unknown): m is { type: "result"; subtype: string; errors?: string[] } =>
	typeof m === "object" && m !== null && (m as Any).type === "result";

export async function runSubagent(spec: SubagentSpec, deps: SubagentDeps = {}): Promise<Any | null> {
	const { activity: a, monitor, timeoutMs } = spec;
	if (a.state === "killed" || monitor.cancelled) {
		a.state = "killed";
		a.fail = "cancelled";
		return null;
	}
	a.state = "running";
	a.timeoutMs = timeoutMs;
	a.lastEventAt = Date.now();
	a.startedAt = Date.now();

	const controller = new AbortController();
	a.session = controller;

	const maxAttempts = spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const holder = deps.resultHolder ?? createResultHolder();

	const server = deps.resultHolder
		? undefined
		: createSubmitResultServer(spec.schema, holder, maxAttempts, (attempt, errors) => {
				a.attempts = attempt;
				if (errors.length) {
					monitor.pushEvent(a, `submit_result attempt ${attempt}/${maxAttempts}: ${errors.length} error(s) — ${errors[0]}`);
				} else {
					monitor.pushEvent(a, `submit_result accepted (attempt ${attempt})`);
				}
			});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const run = deps.query ?? (sdkQuery as unknown as QueryFn);
		monitor.pushEvent(a, `query started (timeout ${Math.round(timeoutMs / 1000)}s)`);
		let firstMessage = true;
		const mcpServers = server ? { [SUBMIT_SERVER_NAME]: server } : {};
		for await (const message of run({ prompt: spec.userPrompt, options: subagentOptions(spec, controller, mcpServers) })) {
			a.lastEventAt = Date.now();
			if (firstMessage) {
				monitor.pushEvent(a, "first message from SDK");
				firstMessage = false;
			}
			monitor.applyEvent?.(a, message);
			if (!isResult(message)) continue;
			if (message.subtype !== "success") {
				const detail = Array.isArray(message.errors) && message.errors.length ? `: ${message.errors[0]}` : "";
				a.fail = `${message.subtype}${detail}`;
				monitor.pushEvent(a, `error: ${a.fail}`);
			}
		}
	} catch (e) {
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
	if (holder.value !== null) {
		a.state = "done";
		return holder.value;
	}
	a.state = "failed";
	if (!a.fail) {
		a.fail =
			holder.attempts > 0
				? `submit_result validation failed after ${holder.attempts} attempt(s): ${holder.lastErrors[0] ?? "unknown"}`
				: "subagent never called submit_result";
	}
	return null;
}
