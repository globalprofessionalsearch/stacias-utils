/**
 * The two ordered sieves the gate runs over every tool call.
 *
 *   rejecters  — ordered rejection functions. The FIRST one that returns a
 *                {@link Rejection} halts the sieve and blocks the call; its
 *                `reason` (why + a recommended alternative) is surfaced back to
 *                the calling model so it can self-correct.
 *   approvers  — ordered approval functions, consulted only if no rejecter
 *                fired. The FIRST one that returns `true` permits the call
 *                outright: haiku is NOT consulted and the user is NOT asked.
 *
 * A call that survives the rejecters and is claimed by no approver falls
 * through to the haiku-summary + user-confirmation path (see index.ts).
 *
 * Both function kinds may be async (an approver may shell out to inspect repo
 * state, etc.). The arrays below are intentionally empty — every rule is being
 * built from scratch. With no rules, every tool call falls through to the
 * haiku-summary + user-confirmation path. The gate machinery in index.ts does
 * not change as rules are added.
 */

/** The tool call under review, straight off pi's `tool_call` event. */
export interface ToolCall {
	toolName: string;
	input: Record<string, unknown>;
	toolCallId: string;
}

/** A rejecter's veto: block the call and teach the caller why + what to do instead. */
export interface Rejection {
	/** Human/model-facing explanation: the reason, and the recommended approach. */
	reason: string;
}

/** Returns a {@link Rejection} to block, or `null`/`undefined` to pass to the next rejecter. */
export type RejectionFn = (call: ToolCall) => Rejection | null | undefined | Promise<Rejection | null | undefined>;

/** Returns `true` to permit the call outright (skip haiku + user), else pass to the next approver. */
export type ApprovalFn = (call: ToolCall) => boolean | Promise<boolean>;

/** A named rejecter — the name identifies the firing rule in the audit log. */
export interface Rejecter {
	name: string;
	check: RejectionFn;
}

/** A named approver — the name identifies the firing rule in the audit log. */
export interface Approver {
	name: string;
	check: ApprovalFn;
}

// ── rejecters (ordered; first veto wins) ──────────────────────────────────────

export const rejecters: Rejecter[] = [];

// ── approvers (ordered; first permit wins) ────────────────────────────────────

export const approvers: Approver[] = [
	// Approve common built-in pi tools (read-only / low-risk).
	{
		name: "common-builtins",
		check: (call) =>
			[
				"read",
				"ls",
				"find",
				"grep",
				"fffind",
				"ffgrep",
				"web_search",
				"fetch_content",
				"get_search_content",
				"intercom",
				"ask_user_question",
				"structured_output",
			].includes(call.toolName),
	},
];
