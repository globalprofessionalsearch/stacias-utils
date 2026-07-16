---
name: stacia-code-review
description: Orchestrated multi-perspective code review of a change set, optionally spanning multiple repositories. Uses a bounded-context architecture with orientation, reconciliation, and perspective review phases. Use when asked to review a PR, a set of PRs, a branch range, or uncommitted changes.
---

# Code Review (orchestrator)

You are the **orchestrator**. You establish the change set under review, then run
a single **`workflow`** call (the pi-dynamic-workflows tool) that fans out to
specialized read-only subagents. You persist the artifacts and assemble the final
report around that call.

This skill targets the **`workflow` tool from `@quintinshaw/pi-dynamic-workflows`**
(`agent()`, `parallel()`, `phase()`, per-agent `schema`, `tier`, and `agentType`).
The run-directory helper `code-review-workdir.py` handles all filesystem I/O.

## Why the work is split around the workflow call

A `workflow` script runs in a Node **vm sandbox**: no `fs`, no `require`, no
`bash`, no network, no `Date.now()`/`Math.random()`. That draws a hard line:

- **Orchestrator turn, before the call** — everything with side effects:
  preflight, the interactive scope gate, `init`, and `build-bundle` per repo
  (all the `gh`/`git`/filesystem I/O the helper does).
- **The single `workflow` call** — pure fan-out: subagents *read* the on-disk
  bundles (their `agentType` grants `read`/`ffgrep`/`fffind`), and the script
  **returns a compact JSON value**. It writes nothing.
- **Orchestrator turn, after the call** — persist findings + report via the
  helper (which the sandbox could not call) and print the paths.

## 0. Preflight

Verify tooling before establishing scope. Per-repo/per-ref checks happen in
step 1 once candidates are known.

- **`workflow` tool present**: this skill drives pi-dynamic-workflows. If the
  `workflow` tool is unavailable, stop and tell the user the extension isn't
  installed (`pi install npm:@quintinshaw/pi-dynamic-workflows`, then `/reload`).
- **Read-only `agentType` installed**: the subagents bind their read-only toolset
  through `~/.pi/agents/stacia-review-readonly.md`. Check it exists
  (`ls ~/.pi/agents/stacia-review-readonly.md`). If absent, tell the user to run
  `summon setup` (it symlinks the binding from this skill dir) — do not silently
  create it.
- **`gh` available & authed**: `gh auth status`. If it fails or `gh` is missing,
  you cannot resolve PRs — fall back to branch-range or working-tree diffs and
  tell the user.
- **`python3` present**: `python3 --version`. The run-directory helper is a
  Python script; without it you cannot allocate the run directory.

Report any preflight failure to the user before proceeding. Never fabricate a diff.

## 1. Establish scope (hard gate)

The review is always defined relative to **a set of changes**. Determine it
before anything else, and **do not run the workflow until scope is explicitly
confirmed**. This gate is interactive, so it must stay in this orchestrator turn —
scope cannot be resolved inside the sandboxed script (bundles need `gh`/`git`),
so it is settled and bundled *before* the `workflow` call regardless.

1. **If PRs are specified** (numbers/URLs): those PRs are the change set. Resolve
   each with `gh pr view <id> --json ...` and note repo, base, head.
2. **If no PRs are specified**: ask the user whether there are PRs to review.
   - If yes, collect their IDs/URLs and proceed as above.
   - If no, ask whether to compare committed refs or review the **uncommitted
     working tree**:
     - **Branch range**: **confirm the range(s)** per repo (e.g.
       `origin/main...feature/x`). Ask one repo at a time if ambiguous.
     - **Uncommitted changes**: the dirty working tree *is* the change set.
       Confirm staged-only vs staged + unstaged, per repo.
3. **Multi-repo**: build the list of repos involved. Record for each: repo name,
   local path, and source (PR id / ref range / working-tree mode).

Validate each repo before continuing — do not guess:
- **Repo paths exist**: `git -C <path> rev-parse --git-dir`.
- **Refs resolve**: `git -C <path> rev-parse --verify <ref>`. If missing, the
  clone may be stale — suggest `git fetch` rather than reviewing the wrong range.
- **Working tree state**: `git -C <path> status --porcelain` when reviewing
  uncommitted changes.

Confirm the full scope (repos + refs/PRs/working tree) back to the user in one
line and wait for agreement before continuing.

## 2–4. PENDING IMPLEMENTATION

The bounded-context workflow (orientation → reconciliation → review → synthesis)
is not yet implemented. See the architecture spec for the design:
`_code_review/specs/spec-code-review-context-efficiency/`

## Notes

- **Read-only by construction.** Every subagent binds
  `agentType: 'stacia-review-readonly'`, whose frontmatter grants only
  `read, ffgrep, fffind` — no `edit`, `write`, or `bash`. The workflow script
  itself runs in a sandbox with no `fs`/`bash`, so it cannot mutate anything
  either. The orchestrator never edits code as part of a review.
- **The read-only binding must be installed.** `summon setup` symlinks
  `skills/stacia-code-review/stacia-review-readonly.md` into `~/.pi/agents/`,
  where the workflow tool resolves `agentType` names.
- **Run state** lives under `${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review/runs/`,
  managed by `code-review-workdir.py`.
