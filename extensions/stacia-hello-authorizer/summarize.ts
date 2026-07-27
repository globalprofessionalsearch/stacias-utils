/**
 * The "haiku" step: a single, tool-free LLM call that turns a tool invocation
 * into one terse plain-language sentence for the confirmation prompt.
 *
 * Uses the ModelRuntime's own one-shot `complete()` (not a full agent session),
 * so it is cheap and cannot itself trip the gate. Crucially this is
 * `rt.complete`, NOT the pi-ai/compat `complete` — the runtime injects your
 * stored auth (auth.json / OAuth) via its credential store, whereas the compat
 * helper only does env-API-key injection (which silently produced no summary).
 * The runtime is resolved once and cached. Any failure resolves to `undefined`
 * (logged to stderr) — the caller then prompts with the raw command only, never
 * auto-allowing on a summary error.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GateConfig } from "./config.ts";
import type { ToolCall } from "./sieves.ts";

const SYSTEM_PROMPT =
	"You summarize a single tool invocation for a human about to approve or deny it. " +
	"Reply with ONE terse, plain-language sentence stating what the invocation would do and any notable side effect. " +
	"No preamble, no markdown, no quoting the raw command back.";

let runtimePromise: Promise<ModelRuntime> | undefined;
function getRuntime(): Promise<ModelRuntime> {
	if (!runtimePromise) runtimePromise = ModelRuntime.create();
	return runtimePromise;
}

/** Render the call as the user-message body the summarizer reads. */
export function renderCall(call: ToolCall): string {
	if (call.toolName === "bash" && typeof call.input.command === "string") {
		return `Tool: bash\nCommand:\n${call.input.command}`;
	}
	let input: string;
	try {
		input = JSON.stringify(call.input, null, 2);
	} catch {
		input = String(call.input);
	}
	return `Tool: ${call.toolName}\nInput:\n${input}`;
}

/** One terse sentence describing the call, or `undefined` on any failure. */
export async function summarize(call: ToolCall, config: GateConfig): Promise<string | undefined> {
	try {
		const slash = config.summaryModel.indexOf("/");
		const provider = config.summaryModel.slice(0, slash);
		const id = config.summaryModel.slice(slash + 1);
		const rt = await getRuntime();
		const model = rt.getModel(provider, id);
		if (!model) {
			console.error(`[sieve-gate] summary model unresolved: ${config.summaryModel}`);
			return undefined;
		}

		const resp = await rt.complete(model, {
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: renderCall(call), timestamp: Date.now() }],
		});

		const text = resp.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		return text || undefined;
	} catch (e) {
		console.error(`[sieve-gate] summary failed: ${e instanceof Error ? e.message : String(e)}`);
		return undefined;
	}
}
