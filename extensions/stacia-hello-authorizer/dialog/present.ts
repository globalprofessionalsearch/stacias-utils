/**
 * Builds the {@link PermissionRequest} view-model from a raw tool call + haiku
 * summary, and decides which {@link DialogAction}s the dialog offers.
 *
 * B scope: `describeAction` handles shell / file-write / generic; `actionsFor`
 * returns Approve + Deny. C extends both — `file-edit` (diff) and more verbs
 * (approve-for-session, view-full, deny-with-reason) slot in here with no change
 * to the component or the gate.
 */

import type { ToolCall } from "../sieves.ts";
import type { ActionView, DialogAction, PermissionRequest } from "./model.ts";

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function surfaceFor(toolName: string): string {
	if (toolName === "bash") return "shell";
	if (["write", "edit", "read", "ls", "find", "grep"].includes(toolName)) return "filesystem";
	return toolName;
}

/** Per-tool literal-action rendering data. */
export function describeAction(call: ToolCall): ActionView {
	if (call.toolName === "bash") {
		return { kind: "shell", lines: [{ text: asString(call.input.command) ?? "", block: true }] };
	}
	if (call.toolName === "write") {
		return {
			kind: "file-write",
			lines: [
				{ label: "path", text: asString(call.input.path) ?? "(unknown path)" },
				{ label: "content", text: asString(call.input.content) ?? "", block: true },
			],
		};
	}
	const entries = Object.entries(call.input).map(([k, v]) => ({
		label: k,
		text: asString(v) ?? safeJson(v),
	}));
	return { kind: "generic", lines: entries.length ? entries : [{ text: "(no arguments)" }] };
}

export function buildRequest(call: ToolCall, summary: string | undefined): PermissionRequest {
	return {
		toolName: call.toolName,
		surface: surfaceFor(call.toolName),
		summary,
		action: describeAction(call),
		// severity intentionally unset (B scope).
	};
}

/** The action menu for a request. B: Approve / Deny. */
export function actionsFor(_request: PermissionRequest): DialogAction[] {
	return [
		{ id: "approve", label: "Approve", hint: "y", decide: () => ({ kind: "approve", scope: "once" }) },
		{ id: "deny", label: "Deny", hint: "n", decide: () => ({ kind: "deny" }) },
	];
}
