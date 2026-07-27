---
status: accepted
date: 2026-07-27
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review, ux]
---

# Own the terminal for the live monitor

## Context and Problem Statement

A `stacia-code-review` run fans out up to nine concurrent subagents across four
stages and can take minutes. Without a liveness surface it is an opaque wait,
and there is nowhere to type "kill that one" or "cancel everything."
[ADR-0001](0001-orchestration-migration-to-custom-extension.md) accepted the
cost of owning that plumbing, and paid it by **borrowing pi's UI**: a pinned
widget via `ctx.ui.setWidget`, a drill-in overlay via `ctx.ui.custom`, and an
`f8` shortcut registered with the host to toggle between them.

Every one of those is a pi API. Claude Code has **no custom-TUI API** — a
plugin cannot pin a widget, own a region of the transcript, or register a
keybinding into the session UI. Taken at face value that reads as a straight
capability loss.

It is not, because of what
[ADR-0007](0007-rehost-coordinator-on-claude-agent-sdk.md) changed. "Claude
Code has no custom-TUI API" constrains code running *inside* a Claude Code
session. The coordinator is no longer inside one: it is its own Node process,
launched by the plugin's front-end skill into a dedicated iTerm2 pane. It
does not borrow a widget slot from an editor that owns the screen — it **owns a
terminal outright**. That is more freedom than pi ever offered, not less.

Where should the live monitor render, and what shape should it take now that
the constraint that produced its design is gone?

## Decision Drivers

- Liveness is the point of the monitor: which agents are running, which are
  stuck, which failed, and how much has been spent.
- Kill-one and cancel-all need somewhere to be typed, and should not require an
  IPC channel or a control socket to reach the thing they abort.
- Claude Code exposes no custom-TUI API to plugins, so the pi rendering path
  cannot be ported as-is.
- The pi monitor's two-mode split (a squeezed pinned widget plus an `f8`
  drill-in overlay) existed **only** because pi's editor owned the screen. That
  constraint no longer applies, so the split is a workaround with nothing left
  to work around.
- The port should be cheap: `MonitorState.widgetLines()` already returns
  `string[]` of plain text, and the overlay is already a plain object
  satisfying `{ render(width): string[]; handleInput(data: string) }` — it
  never subclassed a pi `Component`.
- `monitor-state.test.ts`'s nine tests should stay green throughout and act as
  the conformance suite for the new renderer.

## Considered Options

- **Own the terminal: a standalone TUI in the coordinator process, launched
  into a dedicated iTerm2 pane** (chosen).
- **Line-oriented progress log only, no interactivity** — trivially portable
  and works anywhere stdout goes, but there is no cursor to select with and no
  raw-mode input, so kill-one and cancel-all are lost. That drops a feature the
  pipeline already supports.
- **Render progress back into the Claude Code transcript from the plugin** —
  keeps everything in one window, but there is no API to pin or refresh a
  region, so a 250 ms repaint becomes hundreds of appended messages; and the
  parent session is blocked on the coordinator anyway.
- **Serve a small web UI on localhost and open a browser** — full rendering
  freedom, but adds an HTTP server and a browser dependency to a terminal tool,
  and moves the controls out of the terminal the run was started from.

## Decision Outcome

Chosen option: **own the terminal**. The coordinator renders its own TUI, in
its own process, in a dedicated iTerm2 pane split by the plugin's launcher
(reusing the osascript pattern already in `utilities/repos/main`). stdin is a
real TTY, so input is direct and kill-one
is a plain `controller.abort()` on that agent's `AbortController` — no IPC, no
control socket, no protocol to keep in sync.

**The `f8`/overlay two-mode split is dropped in favor of a single always-on
view.** There is no host editor to yield the screen to, so there is nothing for
a gate to protect: the drill-in *is* the view. Nothing needs to be toggled,
remembered, or advertised.

What is genuinely new is small: alternate-screen enter/exit,
`stdin.setRawMode(true)` with a keypress decoder replacing pi's
`Key`/`matchesKey`, and an ANSI helper replacing `theme.fg`. The 250 ms repaint
loop and the ANSI-safe render discipline (build plain → clamp to width →
colorize) both already exist and carry over. `monitor.ts`'s
`render`/`handleInput` object ports as-is; only `applyEvent`, which is coupled
to pi's event vocabulary, is remapped to SDK message shapes.

Owning the process also makes several things cheap that were impractical
before, and they are in scope:

- **Always-on primary view**, replacing the widget/overlay pair.
- **Arrow-key select, `k` kill, `c` cancel-all, and `esc` actually bound.**
  `esc cancel` is advertised in the widget footer today and never registered —
  only `f8` is. The advertisement becomes true.
- **Real token usage**, from the SDK's `usage` deltas. Today `a.tokens` is not
  tokens: `applyEvent` accumulates `delta.length` (characters), and the repaint
  loop multiplies the difference by 4 to fabricate a rate.
- **Per-agent elapsed time, live seam coverage, and full scrollback** of the
  event log, rather than the last `TAIL_ROWS` lines.

### Consequences

- Good: the monitor is visible by default. No keybinding to discover, no mode
  to be in the wrong one of, and no squeezed-widget layout compromise.
- Good: kill-one and cancel-all are direct method calls on in-process
  `AbortController`s. The control path and the thing being controlled are in
  the same process, so there is no channel that can desynchronize or hang.
- Good: the displayed token counts and rates become real numbers instead of
  character counts scaled by a fudge factor.
- Good: no dependency on any host UI API, so the monitor cannot be broken by a
  harness changing or withdrawing one — which is precisely how the pi version
  died.
- Neutral: the whole TUI is on the order of a hundred lines with no
  dependencies, and `monitor-state.test.ts` continues to pin its behavior — the
  state model is unchanged, only the renderer and the input decoder are new.
- Neutral: the monitor remains observability, not a result surface. The output
  of record is still `report.md` / `report.html` written by the Python helper
  ([ADR-0003](0003-ts-python-coordinator-helper-contract.md)); closing the pane
  loses nothing but the view.
- Bad: launch ergonomics become **macOS- and iTerm2-specific**. The pane split
  is an osascript call against iTerm2; another terminal, another OS, or a
  headless environment gets no pane. This is accepted because it matches where
  the tool is actually used, but it is a hard portability boundary and should
  be read as one.
- Bad: a **non-TTY fallback is required**. If the coordinator is started
  somewhere stdin is not a TTY — CI, a plain `bash -c`, a piped invocation —
  entering raw mode and the alternate screen would corrupt output or fail
  outright. It must detect that case and degrade to line-oriented progress,
  accepting the loss of kill-one and cancel-all there.
- Bad: the first-party UI code ADR-0001 accepted as a cost grows. What was a
  registry plus two `string[]` producers is now a registry, a renderer, a
  keypress decoder, an ANSI helper, and terminal mode management — all owned
  and tested here.

## More Information

- Related: [0001-orchestration-migration-to-custom-extension](0001-orchestration-migration-to-custom-extension.md)
  (which accepted owning the monitor plumbing, on borrowed host UI),
  [0007-rehost-coordinator-on-claude-agent-sdk](0007-rehost-coordinator-on-claude-agent-sdk.md)
  (the separate process this decision depends on).
- Launch-pattern precedent: the osascript iTerm2 pane split in
  `utilities/repos/main` and `utilities/workspace/`.
