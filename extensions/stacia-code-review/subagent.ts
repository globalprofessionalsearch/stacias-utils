/**
 * Run one read-only subagent to a schema-conforming result.
 *
 * - isolated in-memory session, restricted toolset (read/search + submit_result)
 * - submit_result gate: validates params against the JSON schema with our own
 *   validator; invalid → error back to the agent (in-session self-correction);
 *   valid → capture + terminate the turn.
 * - bounded by maxAttempts (aborts the session on exhaustion) and a timeout.
 * - feeds the monitor's activity entry via session.subscribe.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Activity, Monitor } from "./monitor.ts";
import { toTypebox } from "./schema-typebox.ts";
import { validate } from "./validate.ts";

// biome-ignore lint/suspicious/noExplicitAny: JSON payloads / opaque Model
type Any = any;

function bareLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export interface SubagentSpec {
	activity: Activity;
	monitor: Monitor;
	rt: ModelRuntime;
	model: Any;
	cwd: string;
	systemPrompt: string;
	userPrompt: string;
	schema: Any;
	maxAttempts: number;
	timeoutMs: number;
}

export async function runSubagent(spec: SubagentSpec): Promise<Any | null> {
	const { activity: a, monitor, rt, model, cwd, systemPrompt, userPrompt, schema, maxAttempts, timeoutMs } = spec;
	if (a.state === "killed" || monitor.cancelled) {
		a.state = "killed";
		a.fail = "cancelled";
		return null;
	}
	a.state = "running";
	a.lastEventAt = Date.now();

	const holder: { session: Any; result: Any } = { session: null, result: null };

	const submit = defineTool({
		name: "submit_result",
		label: "Submit Result",
		description:
			"Submit your final result. The parameters are the exact object you must return; if it comes back with " +
			"validation errors, correct the fields and call submit_result again.",
		parameters: toTypebox(schema),
		execute: async (_id: string, params: Any) => {
			a.attempts += 1;
			const errs = validate(params, schema);
			if (errs.length) {
				monitor.pushEvent(a, `submit rejected: ${errs[0]}`);
				if (a.attempts >= maxAttempts) {
					monitor.pushEvent(a, "submit attempts exhausted");
					// stop the turn; coordinator treats a null result as failure
					queueMicrotask(() => holder.session?.abort?.());
					throw new Error(`validation failed (final attempt): ${errs.join("; ")}`);
				}
				throw new Error(`validation failed: ${errs.join("; ")}`);
			}
			holder.result = params;
			monitor.pushEvent(a, "submit accepted");
			return { content: [{ type: "text", text: "accepted" }], details: {}, terminate: true };
		},
	});

	const { session } = await createAgentSession({
		cwd,
		model,
		modelRuntime: rt,
		tools: ["read", "grep", "find", "ls", "submit_result"],
		customTools: [submit],
		resourceLoader: bareLoader(systemPrompt),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});
	holder.session = session;
	monitor.subscribe(a, session);

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		session.abort?.();
	}, timeoutMs);

	try {
		await session.prompt(userPrompt);
	} catch (e) {
		a.fail = e instanceof Error ? e.message : String(e);
		monitor.pushEvent(a, `error: ${a.fail}`);
	} finally {
		clearTimeout(timer);
		session.dispose?.();
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
	if (holder.result) {
		a.state = "done";
		return holder.result;
	}
	a.state = "failed";
	a.fail = a.fail ?? `no conforming submit_result after ${a.attempts} attempt(s)`;
	return null;
}
