/**
 * stacia-sieve-gate — a standalone tool-call gate for pi.
 *
 * Replaces the @gotgenes/pi-permission-system authorizer-chain link entirely:
 * it hooks pi's native `tool_call` event (fired before any tool runs; a
 * `{ block, reason }` result blocks with the reason surfaced to the model) and
 * runs every call through two ordered sieves, then a human checkpoint.
 *
 * Per tool call:
 *   1. REJECTION sieve — first rejecter to veto blocks the call; its reason
 *      (why + a recommended alternative) goes back to the calling model.
 *   2. APPROVAL sieve  — first approver to permit runs the call outright:
 *      no summary, no user prompt.
 *   3. Fall-through    — a "haiku" model writes one plain-language sentence
 *      describing the call; the checkpoint dialog (dialog/) shows that summary
 *      with the literal action, and the user approves or denies.
 *
 * Policy lives entirely in the two sieve arrays (sieves.ts) — there is no
 * declarative config file, session-scoped approval, or subagent forwarding that
 * the permission-system provided; every call is judged fresh.
 */

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { buildRequest } from "./dialog/present.ts";
import { promptDecision } from "./dialog/prompt.ts";
import { logDecision } from "./logger.ts";
import { approvers, rejecters, type ToolCall } from "./sieves.ts";
import { summarize } from "./summarize.ts";

/** The raw action detail recorded in the audit log (redacted at write time). */
function describeCall(call: ToolCall): string {
	if (call.toolName === "bash" && typeof call.input.command === "string") {
		return call.input.command;
	}
	try {
		return `${call.toolName} ${JSON.stringify(call.input)}`;
	} catch {
		return call.toolName;
	}
}

export default function staciaSieveGate(pi: ExtensionAPI): void {
	const config = loadConfig();

	pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
		const call: ToolCall = {
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			toolCallId: event.toolCallId,
		};
		const detail = describeCall(call);
		const base = { toolName: call.toolName, toolCallId: call.toolCallId, detail };

		// 1. Rejection sieve — first veto wins.
		for (const rejecter of rejecters) {
			const verdict = await rejecter.check(call);
			if (verdict) {
				logDecision({ ...base, outcome: "rejected", rule: rejecter.name, reason: verdict.reason });
				return { block: true, reason: verdict.reason };
			}
		}

		// 2. Approval sieve — first explicit permit runs it outright.
		for (const approver of approvers) {
			if (await approver.check(call)) {
				logDecision({ ...base, outcome: "approved_by_sieve", rule: approver.name });
				return undefined; // allow: no summary, no prompt
			}
		}

		// 3. Fall-through — summarize, then ask the human.
		if (!ctx.hasUI) {
			const reason = "No interactive UI is available to confirm this action; blocking. Approve it via a sieve rule if it should run unattended.";
			logDecision({ ...base, outcome: "blocked_no_ui", reason });
			return { block: true, reason };
		}

		const summary = await summarize(call, config);
		const decision = await promptDecision(ctx, buildRequest(call, summary));
		if (decision.kind === "deny") {
			const reason = decision.reason ?? "The user denied this action.";
			logDecision({ ...base, outcome: "user_denied", summary, reason });
			return { block: true, reason };
		}
		logDecision({ ...base, outcome: "user_approved", summary });
		return undefined; // allow
	});
}
