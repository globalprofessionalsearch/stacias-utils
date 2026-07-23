# stacia-code-review

Orchestrated, read-only, multi-perspective code review of a change set —
optionally spanning multiple repos. This is a custom pi **extension**
(`index.ts`), not a `pi-dynamic-workflows` workflow: it spawns and tracks its
own subagents, enforces fail-fast / cancel-all, confines subagent filesystem
access to the change set, validates structured output, and writes the report
itself.

Installed by `summon setup` (symlinked into `~/.pi/agent/extensions/`), so it's
available in any project. Throwaway test without installing:
`pi -e <repo>/extensions/stacia-code-review/index.ts`.

## Invoking

Two entry points, one shared core (`performReview` in `index.ts`):

- **`/stacia-code-review <free-form description>`** — a thin trigger. It hands
  your description to the model, which resolves scope (repos + change-set
  specs) and charge conversationally, then calls the tool below. Bare
  `/stacia-code-review` makes the model ask what to review.
- **`code_review` tool** — called by the model once scope + charge are
  resolved. Args:

  ```json
  {
    "charge": "<what the change claims to accomplish>",
    "repos": [{ "path": "<abs repo path>", "source": "pr:<id> | range:<base>...<head> | worktree | worktree:all | worktree:staged" }],
    "adrs": [{ "id": "0001", "title": "…", "path": "<abs path to accepted ADR .md>" }]
  }
  ```

**Charge is a hard gate.** It's a statement of what the change claims to
accomplish; the review orients and critiques against it. It is never inferred
from the diff — both entry points refuse to run without one (empty/whitespace
`charge` throws before anything is spun up).

`repos` is required (≥1). `adrs` is optional context staged into the run's
context store for the `adr` reviewer to read on demand.

## Pipeline

1. **Comprehension** — two orienteers (claim→code, code→claim) in parallel,
   reconciled into a bounded orientation + priority-ranked seam map. Fail-fast
   if both orienteers or the reconciler fail.
2. **Review** — six perspective reviewers (correctness, security, performance,
   api-contract, tests, adr) in parallel, each a bounded K-round loop, capped
   prioritized findings + a spillover flag.
3. **Synthesis** — consolidation (preserving reviewer priority), a charge
   verdict (`met` / `partial` / `unclear`), three-state seam accounting,
   follow-up signal.
4. **Verification** — Blocker/Major findings independently confirmed,
   corrected, or dismissed.

Guarantees: read-only by construction (subagents get read/grep/find/ls + a
`submit_result` gate tool, confined to the change set's repo roots + the run
dir — `confine.ts`); structured, schema-validated output at every hop; honest
coverage (under-explored seams and reviewer failures surface as report
caveats, never silently dropped).

## Config

One config file governs the whole extension: tunables (`workflow`, `reviewer`,
`reconciler`, `synthesis`) and models. Three layers, deep-merged low→high
(`config.ts`):

1. **Shipped defaults** — `assets/config.json` (baked into the extension).
2. **User override** — `~/.pi/agent/stacia-code-review.json`.
3. **Project override** — `.pi/stacia-code-review.json`, only applied if the
   project is trust-gated (`ctx.isProjectTrusted()`).

Same schema at every layer; a missing or unparseable override file is silently
ignored (falls through to the layer below). Deep merge is a plain-object
recursive merge — object keys merge, everything else (arrays, scalars) is
replaced wholesale by the higher layer.

Shipped defaults (`assets/config.json`):

```json
{
  "workflow": { "maxRounds": 3, "roundTimeoutMs": 60000, "concurrency": 6, "agentRetries": 1 },
  "reviewer": { "maxFindings": 6, "perspectives": ["correctness", "security", "performance", "api-contract", "tests", "adr"] },
  "reconciler": { "minSeams": 3, "maxSeams": 12 },
  "synthesis": { "followUpThreshold": 4 },
  "models": { "default": null, "orienteer": null, "reconciler": null, "reviewer": null, "synthesizer": null, "verifier": null }
}
```

### Per-role models

`models` maps role → `provider/id` (or `null`). Roles: `orienteer`,
`reconciler`, `reviewer`, `synthesizer`, `verifier`, plus `default` as a
fallback for any unset role. Resolution per agent (`models.ts`):

```
models[role] → models.default → host session model
```

Zero-config (all `null`) uses the host model everywhere. An unresolvable
`provider/id` (bad format, or model not found) falls back to the host model
with a surfaced note rather than failing the run.

## Live monitor

While a review runs, a pinned widget shows per-agent activity (role, round,
state, token rate). Press **f8** to open a drill-in overlay:

- ↑/↓ to select an agent
- **k** kill the selected agent
- **c** cancel the whole run (kills every in-flight/queued agent)
- **esc** close the overlay

`esc` at the top level (no overlay open) also cancels the run.

## I/O

`helper/code-review-workdir.py` owns all filesystem/diff/report I/O — invoked
by the extension as a subprocess, never done in-process. It allocates the run
dir, captures and annotates per-repo diff bundles, stages context (ADRs), and
writes findings + `report.md` / `report.html`.

Run state lives under
`${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review/runs/<run-id>/`. The report
is charge-scoped: verdict, top priorities (Blocker/Major), all findings by
severity, coverage caveats, and a follow-up recommendation if triggered.
