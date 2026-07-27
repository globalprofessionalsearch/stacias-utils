/**
 * View-model + decision types for the permission checkpoint dialog.
 *
 * These are the seams that let us grow from B (fixed Approve/Deny) to C (risk
 * stripe, richer action menu, per-tool rendering) without touching the gate
 * plumbing in index.ts. The component returns a {@link Decision}, never a bare
 * boolean, so new verbs are added purely as {@link DialogAction}s.
 */

/**
 * Risk level for the C-scope risk stripe. It is a PURE PLACEHOLDER seam here:
 * never computed in B, and — by design — never derived from haiku (haiku only
 * describes what a command does; it does not assess risk).
 */
export type Severity = "low" | "elevated" | "high";

/** One rendered line of the literal action (a field, or a block-body line). */
export interface ActionLine {
	/** Optional field label, e.g. "path", "content". */
	label?: string;
	text: string;
	/** Render as a code/quote block body rather than an inline field. */
	block?: boolean;
}

/** Tool-agnostic description of the literal action, rendered by the component. */
export interface ActionView {
	kind: "shell" | "file-write" | "file-edit" | "generic";
	lines: ActionLine[];
}

/** Everything the dialog renders for one ask. */
export interface PermissionRequest {
	toolName: string;
	/** Coarse surface label: "shell" | "filesystem" | tool name. */
	surface: string;
	/** Haiku's plain-language description of what the call does. */
	summary?: string;
	action: ActionView;
	/** C-only seam; unset in B, never derived from haiku. */
	severity?: Severity;
}

/** The dialog's outcome. B emits only `approve/once` and `deny`. */
export type Decision = { kind: "approve"; scope: "once" | "session" } | { kind: "deny"; reason?: string };

/** A selectable action in the menu. Adding verbs = adding entries (see present.ts). */
export interface DialogAction {
	id: string;
	label: string;
	/** Single-key hotkey, e.g. "y" / "n". */
	hint?: string;
	decide: () => Decision;
}
