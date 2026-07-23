---
name: stacia-code-review
description: Orchestrated multi-perspective code review of a change set, optionally spanning multiple repositories. A custom pi extension owns the orchestration; this skill documents how to drive it. Use when asked to review a PR, a set of PRs, a branch range, or uncommitted changes.
---

# Code Review

Multi-perspective, read-only, charge-scoped code review. Orchestration is owned
by a **custom pi extension** (`extensions/stacia-code-review/`), not the
pi-dynamic-workflows `workflow` tool. The extension spawns and tracks the review
subagents itself, enforces fail-fast / cancel-all, confines subagent filesystem
access, validates structured output, and writes the report.

This file documents how to **drive** the review. The design of record lives in
`_code_review/specs/spec-code-review-coordinator-extension/` and the ADRs under
`docs/adr/`.

## How to invoke

Two entry points, one shared core:

- **Slash command** — `/stacia-code-review <free-form description of what to
  review + the charge>`. A thin trigger: it hands your description to the model,
  which resolves scope + charge and calls the `code_review` tool. Bare
  `/stacia-code-review` makes the model ask what to review.
- **`code_review` tool** — the model calls it with structured args after
  gathering scope. You can also just ask in chat ("review my uncommitted changes
  in ~/foo; charge: fix the upload retry").

The extension is installed by `summon setup` (symlinked into
`~/.pi/agent/extensions/`), so the tool + command are available in any project.
For a throwaway test without installing: `pi -e <repo>/extensions/stacia-code-review/index.ts`.

## Establishing scope (the model's job, before the tool call)

Scope is resolved conversationally — the tool is never called until these hold:

1. **Change set.** Which repo(s) and exactly what changed, expressed as a
   `source` spec per repo:
   - `pr:<id>` — a GitHub PR (uses `gh`)
   - `range:<base>...<head>` — a committed ref range
   - `worktree` / `worktree:all` — uncommitted, staged + unstaged
   - `worktree:staged` — staged only
   Validate repo paths and that refs resolve before running; suggest `git fetch`
   rather than reviewing a stale range.
2. **Charge (required, hard gate).** A statement of what the work claims to
   accomplish. The review orients and critiques against it. **Never infer the
   charge from the diff** — if absent, ask for it. The `code_review` tool refuses
   to run without a non-empty charge.
3. **ADRs (optional).** Accepted ADRs to check compliance against, passed as the
   tool's `adrs` arg (`{id, title, path}` local files); they are staged into the
   run's context store and read by the `adr` reviewer on demand.

A review is defined by exactly one charge; truly independent changes with no
shared charge are separate reviews. Repos are just a dimension of the change
set, not an organizing unit — the report is charge-scoped, not repo-scoped.

## `code_review` tool arguments

```json
{
  "charge": "<what the change claims to accomplish>",
  "repos": [ { "path": "<abs repo path>", "source": "<pr:… | range:… | worktree[:all|:staged]>" } ],
  "adrs": [ { "id": "0001", "title": "…", "path": "<abs path to accepted ADR .md>" } ]
}
```

## What the extension does (for reference)

Pipeline (ported topology; personas in `references/`, schemas in `*.schema.json`,
tunables in `config.json`):

1. **Comprehension** — two orienteers (claim→code, code→claim) run in parallel,
   then a reconciler merges them into a bounded orientation + a priority-ranked
   seam map. Fail-fast if both orienteers or the reconciler fail.
2. **Review** — six perspective reviewers (correctness, security, performance,
   api-contract, tests, adr) in parallel, each a bounded K-round loop that pulls
   detail on demand and returns capped, prioritized findings + a spillover flag.
3. **Synthesis** — consolidate (preserving reviewer priorities), a charge verdict
   (met / partial / unclear), three-state seam accounting, follow-up signal.
4. **Verification** — Blocker/Major findings are independently confirmed,
   corrected, or dismissed.

Guarantees:

- **Read-only by construction.** Subagents get only read/grep/find/ls (+ a
  `submit_result` gate tool), and those are **confined** to the change set's repo
  roots + the run directory (`confine.ts`) so an untrusted diff can't steer an
  agent to read arbitrary files.
- **Structured output.** Each subagent returns via `submit_result`, validated
  against the JSON schema; the coordinator re-validates.
- **Live monitor.** A pinned widget shows per-agent activity; **f8** opens a
  drill-in overlay (↑/↓ select, `k` kill one agent, `c` cancel the whole run,
  `esc` close). `esc` at the top level also cancels the run.
- **Honest coverage.** Under-explored seams and reviewer failures surface as
  explicit caveats in the report, never dropped.

## I/O

The run-directory helper `code-review-workdir.py` owns all filesystem/diff/report
I/O (invoked by the extension as a subprocess): allocate the run dir, capture and
annotate per-repo diff bundles, stage context (ADRs), and write findings +
`report.md` / `report.html`. Run state lives under
`${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review/runs/`. The report is
charge-scoped: verdict, top priorities (Blocker/Major), all findings by severity,
coverage caveats, and a follow-up recommendation if triggered.

## Per-agent models (optional)

Each role's model is configurable via `stacia-code-review.json` (user:
`~/.pi/agent/`, project: `.pi/`, trust-gated), with keys
`default | orienteer | reconciler | reviewer | synthesizer | verifier`
(values `provider/id`). Resolution: role → `default` → the host session model.
Zero-config uses the host model everywhere. See ADR-0002.
