/**
 * CheckpointDialog — the custom-overlay permission prompt.
 *
 * Renders a bordered checkpoint card: title bar, tool/surface badge, haiku
 * summary, a divider, the per-tool literal action, and a selectable action
 * menu. Built at C's structure (arrow-key menu, per-tool action rendering,
 * a reserved risk-stripe slot) but B's scope (Approve/Deny only, no stripe).
 *
 * Implements pi's `Component` shape: `render(width)`, `handleInput(data)`,
 * `invalidate()`. It calls `onDecide` exactly once when the user picks.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DialogAction, PermissionRequest } from "./model.ts";

/** Only the theme surface this component needs. */
interface ThemeLike {
	fg(color: string, text: string): string;
}

const TITLE = "\uD83D\uDD12 Permission Check"; // 🔒
const MAX_BLOCK_LINES = 12; // cap block bodies so the card stays sane

export class CheckpointDialog {
	private selected = 0;
	private decided = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly request: PermissionRequest,
		private readonly actions: DialogAction[],
		private readonly theme: ThemeLike,
		private readonly onDecide: (action: DialogAction) => void,
	) {}

	handleInput(data: string): void {
		if (this.decided) return;
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.pick(this.actions[this.selected]);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.pick(this.actions.find((a) => a.id === "deny") ?? this.actions[this.actions.length - 1]);
			return;
		}
		const hotkey = this.actions.find((a) => a.hint && data === a.hint);
		if (hotkey) this.pick(hotkey);
	}

	private move(delta: number): void {
		const n = this.actions.length;
		this.selected = (this.selected + delta + n) % n;
		this.invalidate();
	}

	private pick(action: DialogAction): void {
		if (this.decided) return;
		this.decided = true;
		this.onDecide(action);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines = this.frame(width, this.body(this.innerWidth(width)));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	// ── layout ────────────────────────────────────────────────────────────────

	private innerWidth(width: number): number {
		return Math.max(8, width - 4); // "│ " … " │"
	}

	/** Build the un-bordered content lines (already styled, ≤ inner wide). */
	private body(inner: number): string[] {
		const t = this.theme;
		const out: string[] = [];

		// Badge: TOOL  surface
		out.push(`${t.fg("accent", this.request.toolName.toUpperCase())}  ${t.fg("muted", this.request.surface)}`);
		out.push("");

		// Haiku summary (prose).
		const summary = this.request.summary ?? "(no description — model summary unavailable)";
		for (const line of wrapTextWithAnsi(t.fg("text", summary), inner)) out.push(line);

		// Divider.
		out.push(t.fg("borderMuted", "\u2500".repeat(inner)));

		// Literal action.
		for (const line of this.actionLines(inner)) out.push(line);

		out.push("");

		// Action menu.
		for (const line of this.menuLines()) out.push(line);
		out.push(t.fg("dim", "\u2191\u2193 select \u00b7 enter confirm \u00b7 esc deny"));

		return out;
	}

	private actionLines(inner: number): string[] {
		const t = this.theme;
		const out: string[] = [];
		const shell = this.request.action.kind === "shell";
		for (const ln of this.request.action.lines) {
			if (ln.block) {
				if (ln.label) out.push(t.fg("muted", ln.label));
				const prefix = shell ? "$ " : "\u2502 ";
				const bodyWidth = Math.max(4, inner - visibleWidth(prefix));
				const wrapped = wrapTextWithAnsi(ln.text, bodyWidth);
				const shown = wrapped.slice(0, MAX_BLOCK_LINES);
				for (const w of shown) out.push(t.fg("mdCodeBlock", prefix + w));
				if (wrapped.length > shown.length) {
					out.push(t.fg("dim", `\u2502 \u2026 (${wrapped.length - shown.length} more lines)`));
				}
			} else if (ln.label) {
				out.push(`${t.fg("muted", ln.label.padEnd(8))}${t.fg("text", ln.text)}`);
			} else {
				out.push(t.fg("text", ln.text));
			}
		}
		return out;
	}

	private menuLines(): string[] {
		const t = this.theme;
		return this.actions.map((a, i) => {
			const on = i === this.selected;
			const marker = on ? t.fg("accent", "\u25b6 ") : "  ";
			const label = on ? t.fg("accent", a.label) : t.fg("muted", a.label);
			const hint = a.hint ? ` ${t.fg("dim", `(${a.hint})`)}` : "";
			return `${marker}${label}${hint}`;
		});
	}

	/** Wrap content lines in a titled border box exactly `width` wide. */
	private frame(width: number, content: string[]): string[] {
		const t = this.theme;
		const inner = this.innerWidth(width);
		const b = (s: string) => t.fg("border", s);

		const prefixPlain = `\u256d\u2500 ${TITLE} `;
		const dashes = Math.max(0, width - visibleWidth(prefixPlain) - 1);
		const top = `${b("\u256d\u2500 ")}${t.fg("borderAccent", TITLE)}${b(` ${"\u2500".repeat(dashes)}\u256e`)}`;
		const bottom = b(`\u2570${"\u2500".repeat(width - 2)}\u256f`);

		const rows = content.map((line) => {
			const padded = this.padTo(line, inner);
			return `${b("\u2502")} ${padded} ${b("\u2502")}`;
		});

		return [top, ...rows, bottom];
	}

	/** Pad a (possibly styled) line to exactly `inner` visible columns. */
	private padTo(line: string, inner: number): string {
		const truncated = truncateToWidth(line, inner);
		const gap = inner - visibleWidth(truncated);
		return gap > 0 ? truncated + " ".repeat(gap) : truncated;
	}
}
