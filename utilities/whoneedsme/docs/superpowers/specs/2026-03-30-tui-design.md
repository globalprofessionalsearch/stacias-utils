# TUI Redesign — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Overview

Replace the current plain-text CLI output with a Bubble Tea TUI. The TUI becomes the default behavior of `whoneedsme` (no subcommand needed). Sources load in parallel and results stream into the UI as individual items are discovered — the lists progressively populate without waiting for a source to finish.

The design separates the application layer (source coordination, state management) from the presentation layer (Bubble Tea rendering) with a clean boundary: the app layer owns state and pushes snapshots; the UI renders whatever it receives.

---

## Layout

Split pane: stacked source sections on the left, detail panel on the right.

```
┌─ SLACK (3) ────────────────────────────┬──────────────────────────────────┐
│  > #engineering — review this PR?      │  SLACK › #engineering            │
│    #general — btw see above            │  ─────────────────────────────   │
│    #random — quick question for you    │  hey <@U123> can you review      │
├─ JIRA (2) ─────────────────────────────│  this PR? We need to merge       │
│    ENG-42 — Fix the thing              │  before EOD.                     │
│    ENG-7 — Investigate outage          │                                  │
├─ NOTION ✓ ─────────────────────────────│  https://slack.com/archives/...  │
│    (no items)                          │                                  │
│                                        │  [enter] open   [q] quit         │
│                                        │  [↑↓] item  [tab] source         │
└────────────────────────────────────────┴──────────────────────────────────┘
```

**Left pane (~55% width):** Stacked source sections. Each section has a header showing source name and status, followed by its item list. Sections with many items show a `↕` scroll indicator in the header and scroll independently.

**Right pane (~45% width):** Detail panel for the focused item. Shows source, title, full summary, URL, and key bindings. Empty until an item is selected.

**Source section header states:**

| State | Example |
|-------|---------|
| Fetching | `─ SLACK  ⠋ ────────────────────` |
| Has items | `─ SLACK (3) ──────────────────` |
| Has items, scrollable | `─ SLACK (12) ↕ ────────────────` |
| Done, no items | `─ SLACK ✓ ─────────────────────` |
| Error | `─ SLACK ✗ ────────────────────` |
| Not authenticated | `─ JIRA  ✗ not authenticated ───` |

---

## Architecture

### Guiding principle

The application layer owns state. The UI renders it. The UI never infers loading state from events — it only renders what the app layer explicitly says is true.

### Package structure

```
source/          — Item struct, Source interface (signature change), Result type
sources/slack/   — streaming Check() implementation
sources/jira/    — streaming Check() implementation
runner/          — NEW: coordinates sources, maintains AppState, pushes snapshots
tui/             — NEW: Bubble Tea model, views, key bindings
cmd/root.go      — simplified wiring: runner + tui
output/          — unchanged (used for non-TTY / piped output)
```

`runner` imports `source` but not `tui`. `tui` imports `runner` for `AppState` and `SourceStatus` types but not `source` directly. `cmd/root.go` imports both and wires them together.

---

## Source Interface

`Check()` changes from a batch return to a streaming channel:

```go
// source/source.go

type Result struct {
    Item Item
    Err  error
}

type Source interface {
    Name() string
    // Check runs one fetch pass, sending items as they are found.
    // The channel is closed when the pass is complete.
    Check(ctx context.Context) <-chan Result
}
```

The source closes the channel when a single pass is done. Re-invocation for polling is handled by the runner, not the source. This keeps sources stateless and easy to test.

**Slack streaming behavior:** Currently `Check()` fetches all search results then checks each thread. With the new interface, each thread that has an unreplied mention is sent to the channel immediately as it is found, before the remaining threads are checked.

---

## Runner

The runner coordinates sources, maintains authoritative state, and pushes snapshots to the TUI via `program.Send()`.

```go
// runner/runner.go

type SourceStatus int

const (
    StatusPending  SourceStatus = iota // not yet started
    StatusFetching                      // actively running
    StatusDone                          // pass complete, no more items coming
    StatusError                         // pass failed
)

type SourceState struct {
    Status SourceStatus
    Items  []source.Item
    Err    error
}

type AppState struct {
    Sources map[string]SourceState  // keyed by source name
    Order   []string                // display order, stable across updates
}

type Runner struct {
    sources []source.Source
    timeout time.Duration
    program *tea.Program  // set after TUI is created
}

// New creates a runner. authErrors contains source names that failed authentication
// (e.g. {"jira": errors.New("not authenticated")}). These are included in AppState
// with StatusError immediately, without being started.
func New(sources []source.Source, authErrors map[string]error, timeout time.Duration) *Runner

// InitialState returns an AppState with authenticated sources at StatusPending
// and unauthenticated sources at StatusError. Used to initialize the TUI before Start.
func (r *Runner) InitialState() AppState

// SetProgram gives the runner a handle to send state updates to the TUI.
func (r *Runner) SetProgram(p *tea.Program)

// Start launches all sources concurrently.
func (r *Runner) Start(ctx context.Context)

// Refresh re-runs sources. If source is empty, all sources are refreshed.
func (r *Runner) Refresh(ctx context.Context, source string)
```

**State update flow:**

1. Runner sets source status to `StatusFetching`, pushes `AppState` snapshot.
2. As each `Result` arrives from `src.Check()`, runner appends item to that source's state and pushes a new snapshot.
3. When `src.Check()` closes its channel, runner sets status to `StatusDone` (or `StatusError`) and pushes final snapshot.
4. On re-run (refresh), runner clears items for that source, sets status back to `StatusFetching`, and pushes snapshot before invoking `Check()` again.

Each push calls `program.Send(appState)` with the complete current `AppState`. The TUI replaces its local copy on every update — no diffing, no partial state.

---

## TUI

```go
// tui/model.go

type Model struct {
    state  runner.AppState
    cursor Cursor
    width  int
    height int
}

type Cursor struct {
    Source int  // index into AppState.Order
    Item   int  // index within that source's Items
}
```

**Messages handled:**

| Message | Action |
|---------|--------|
| `runner.AppState` | Replace model's state, clamp cursor if needed |
| `tea.KeyMsg` | Update cursor or trigger action |
| `tea.WindowSizeMsg` | Update width/height for layout |

**Key bindings:**

| Key | Action |
|-----|--------|
| `↑` / `k` | Move up within focused source |
| `↓` / `j` | Move down within focused source |
| `tab` | Move focus to next source section |
| `shift+tab` | Move focus to previous source section |
| `enter` | Open selected item URL in browser |
| `r` | Refresh all sources |
| `q` / `ctrl+c` | Quit |

**Cursor behavior:** When `tab` moves focus to a source with no items, the cursor parks at index 0 and the detail panel is empty. When a state update adds items to the focused source, the first item is auto-selected if the cursor was at 0 with no prior selection.

**File structure:**

```
tui/
  model.go   — Model struct, Init, Update
  view.go    — View, left pane, right pane, source section rendering
  keys.go    — key binding constants
```

---

## cmd/root.go

Simplified to a wiring layer:

```go
func runCheck(cmd *cobra.Command, args []string) error {
    store, err := auth.NewStore()
    // ...
    sources, authErrors := buildSources(store)
    // authErrors: map of source name → auth error for sources that couldn't be built.
    // The runner places these in AppState as StatusError so the TUI renders them
    // naturally (e.g. "─ JIRA ✗ not authenticated ─────"). No separate stderr output.

    r := runner.New(sources, authErrors, 30*time.Second)
    m := tui.New(r.InitialState())
    p := tea.NewProgram(m, tea.WithAltScreen())
    r.SetProgram(p)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    go r.Start(ctx)

    _, err = p.Run()
    return err
}
```

---

## Non-TTY Behavior

When stdout is not a TTY (piped, redirected, CI), the TUI is skipped and `output.Render` is used as today. Detection via `term.IsTerminal(int(os.Stdout.Fd()))`.

---

## What Does Not Change

- `source.Item` struct — fields unchanged
- `auth/` — entirely unchanged
- `output/output.go` — unchanged
- `sources/slack/` and `sources/jira/` Check logic — same logic, different return shape
- Existing source unit tests — updated for channel interface, same coverage
