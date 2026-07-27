/**
 * Best-effort JSONL audit trail: one structured record per gate decision,
 * appended to a .jsonl under the agent dir. Replaces the permission-review log
 * the old authorizer link wrote to. A logging failure NEVER breaks the gate —
 * every write is guarded and swallowed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { redact } from "./redact.ts";

export const LOG_DIR = path.join(getAgentDir(), "extensions", "stacia-sieve-gate", "logs");
export const LOG_FILE = path.join(LOG_DIR, "stacia-sieve-gate.jsonl");

export type Outcome =
	| "rejected" // a rejecter vetoed
	| "approved_by_sieve" // an approver permitted outright
	| "user_approved" // fall-through: user confirmed
	| "user_denied" // fall-through: user declined
	| "blocked_no_ui"; // fall-through with no UI to ask

export interface DecisionRecord {
	outcome: Outcome;
	toolName: string;
	toolCallId: string;
	/** The command (bash) or a compact input rendering. */
	detail: string;
	/** Name of the sieve rule that fired (rejecter or approver). */
	rule?: string;
	/** Block/deny reason surfaced to the model or shown to the user. */
	reason?: string;
	/** The haiku summary, when one was produced. */
	summary?: string;
}

export function logDecision(rec: DecisionRecord): void {
	try {
		// Redact secrets from the persisted free-text fields (the live prompt
		// already showed the human the real command).
		const safe: DecisionRecord = { ...rec, detail: redact(rec.detail), summary: redact(rec.summary) };
		fs.mkdirSync(LOG_DIR, { recursive: true });
		fs.appendFileSync(LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...safe })}\n`);
	} catch {
		// best-effort: never let an audit-log failure block a tool call
	}
}
