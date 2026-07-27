/**
 * promptDecision — present the checkpoint dialog as a focused overlay and
 * resolve with the user's {@link Decision}.
 *
 * The only bridge between the gate (index.ts) and the dialog component: index
 * builds a {@link PermissionRequest}, calls this, and maps the returned
 * decision to a tool-call result + log entry.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CheckpointDialog } from "./checkpoint.ts";
import type { Decision, PermissionRequest } from "./model.ts";
import { actionsFor } from "./present.ts";

export async function promptDecision(ctx: ExtensionContext, request: PermissionRequest): Promise<Decision> {
	const actions = actionsFor(request);
	// Non-overlay modal: owns keyboard input until the user decides (the canonical
	// pattern from the TUI docs). Overlay presentation is a C-scope refinement.
	return ctx.ui.custom<Decision>((tui, theme, _keybindings, done) => {
		const dialog = new CheckpointDialog(request, actions, theme, (action) => done(action.decide()));
		return {
			render: (width) => dialog.render(width),
			handleInput: (data) => {
				dialog.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => dialog.invalidate(),
		};
	});
}
