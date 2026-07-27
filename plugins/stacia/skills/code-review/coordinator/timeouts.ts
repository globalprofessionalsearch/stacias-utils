/**
 * Per-role wall-clock budgets. Every role's timeout is EXPLICITLY named in the
 * single config's `timeouts` map (see config.ts), mirroring `models`: no
 * default, no fallback, an unset value is a hard error surfaced before any
 * agent runs.
 *
 * This replaces `workflow.roundTimeoutMs`, which was one knob feeding every
 * role through a `* 3` multiplier (`longTimeout`). That coupling had two
 * failure modes: the only role receiving the literal configured value was the
 * verifier — which has no rounds at all — and giving reviewers more room
 * silently tripled orient/reconcile/synthesis too.
 *
 * Scope is unchanged: the budget applies to EACH invocation of that role, not
 * to the role's total. A reviewer running K rounds gets `timeouts.reviewer`
 * afresh per round.
 */

import { type Role, ROLES } from "./models.ts";

/**
 * Validate that every role names a positive integer budget. Throws listing ALL
 * offending roles at once. Call at config load, before any agent runs.
 *
 * `workflow` is passed so the retired `roundTimeoutMs` key can be rejected with
 * a migration hint rather than silently ignored — a stale user override would
 * otherwise look honoured while having no effect.
 */
export function validateTimeouts(timeouts: Record<string, unknown>, workflow?: Record<string, unknown>): void {
	if (workflow && "roundTimeoutMs" in workflow) {
		throw new Error(
			`config.workflow.roundTimeoutMs is retired — it drove every role through a "* 3" multiplier. ` +
				`Set a per-role budget under config.timeouts instead (${ROLES.join(", ")}).`,
		);
	}
	const bad: string[] = [];
	for (const role of ROLES) {
		const v = timeouts?.[role];
		if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
			bad.push(`${role}=${v === undefined ? "(unset)" : JSON.stringify(v)}`);
		}
	}
	if (bad.length) {
		throw new Error(`config.timeouts: every role must name a positive integer of milliseconds. Fix: ${bad.join(", ")}. (No default / fallback.)`);
	}
}

/** The wall-clock budget for one invocation of a role, in milliseconds. */
export function timeoutFor(role: Role, timeouts: Record<string, number>): number {
	return timeouts[role];
}
