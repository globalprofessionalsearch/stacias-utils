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

The review is defined by **a set of changes** and **a stated charge**. Both are
required. Do not run the workflow until scope and charge are explicitly confirmed.

### 1a. Determine the change set

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

### 1b. Require a charge (hard stop)

A **charge** is a statement of what the work claims to accomplish. The review
orients and critiques against this charge. **Do not proceed without one.**

- If the user provided a charge (e.g., PR description, commit message, or explicit
  statement), confirm it back to them.
- If no charge is evident, **halt and ask**: "What does this change claim to
  accomplish?" Accept any non-empty answer. A minimal charge ("fix the login bug")
  is acceptable; absence is not.
- **Never infer the charge from the diff.** The skill orients and critiques; it
  does not invent intent.

### 1c. Confirm scope

Confirm the full scope (repos + refs/PRs/working tree + charge) back to the user
in a brief summary and wait for agreement before continuing.

## 2. Allocate the run directory and build per-repo bundles

All run state lives in a central, cwd-independent directory owned by the bundled
helper `code-review-workdir.py` (next to this `SKILL.md`) — never the current
working directory. The helper owns every path, name, and `mkdir`, and performs
every write; you never handle a filesystem path for output. Do not use the
`write` tool for any run artifact — route it through the helper.

Allocate the run **once** with the repo identifiers in scope:

```
python3 <skill-dir>/code-review-workdir.py init <repo> [<repo> ...]
```

It creates `${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review/runs/<ts>-<id>/`
with `bundles/`, `findings/`, a `report.md` target, and a `manifest.json`, then
prints that manifest as JSON: per-repo `slug` + `bundle` + `findings`, the
`run_dir`, `report`, and `multi_repo`.
**Keep the parsed manifest** — you pass its paths into the workflow `args` and
into every later write.

Then, for **each** repo, have the helper **capture and build** that repo's
bundle. You do not assemble diff text yourself:

```
python3 <skill-dir>/code-review-workdir.py build-bundle \
  --run <run_dir> --slug <slug> --repo-path <abs repo path> --source <spec>
```

`<spec>` is exactly one of (matching what step 1 confirmed):
- `pr:<id>` — a GitHub PR (helper runs `gh pr diff` + `gh pr view`),
- `range:<base>...<head>` — a committed ref range,
- `worktree` / `worktree:all` — uncommitted, staged + unstaged,
- `worktree:staged` — staged only.

`build-bundle` captures the diff bytes itself and **fails loudly** if the command
errors, the diff is empty, or it has no hunks — so a broken capture can never
reach a reviewer.

## 3. The `workflow` call

Run **one** `workflow` call using the static workflow script. The orchestrator
reads the script and all personas/schemas, then passes them to the workflow tool.

### Read the static workflow script

```
const script = read('<skill-dir>/workflow-script.js')
```

The workflow script (`workflow-script.js`) is static and versioned.
It contains all the orchestration logic: comprehension → review → synthesis.

### Read config, personas, and schemas

The workflow sandbox has no `fs`, so the orchestrator must pre-read config,
personas, and schemas and pass them in `args`:

**Config** (read, parse, and validate):
- `config.json` — tunable constants (rounds, timeouts, thresholds)
- `config.schema.json` — validate config against this schema; fail fast on invalid config

**Personas** (read as strings):
- `references/orienteer-claim-to-code.md`
- `references/orienteer-code-to-claim.md`
- `references/reconciler.md`
- `references/common-reviewer-rules.md`
- `references/reviewer-{correctness,security,performance,api-contract,tests}.md`
- `references/synthesizer.md`
- `references/verifier.md`

**Schemas** (read and parse as JSON):
- `orientation.schema.json`
- `seam-map.schema.json`
- `reviewer-output.schema.json`
- `synthesis.schema.json`
- `verifier-output.schema.json`

### Inject config into schemas

After reading schemas, inject config values into schema bounds for runtime
enforcement:

```js
// Inject seam bounds
schemas.seamMap.properties.seams.minItems = config.reconciler.minSeams
schemas.seamMap.properties.seams.maxItems = config.reconciler.maxSeams

// Inject max findings
schemas.reviewer.properties.findings.maxItems = config.reviewer.maxFindings
```

This ensures bounds are both config-driven AND schema-enforced at runtime.

### Build args

Build `args` from the manifest + scope + config + personas + schemas:

```json
{
  "run_dir": "<run_dir>",
  "charge": "<the stated charge>",
  "multi_repo": <bool>,
  "repos": [ { "repo": "<name>", "slug": "<slug>", "bundle": "<bundle path>", "path": "<abs repo local path>" } ],
  "config": { /* parsed config.json */ },
  "personas": {
    "orienteerA": "<contents of orienteer-claim-to-code.md>",
    "orienteerB": "<contents of orienteer-code-to-claim.md>",
    "reconciler": "<contents of reconciler.md>",
    "commonRules": "<contents of common-reviewer-rules.md>",
    "reviewers": {
      "correctness": "<contents of reviewer-correctness.md>",
      "security": "<contents of reviewer-security.md>",
      "performance": "<contents of reviewer-performance.md>",
      "api-contract": "<contents of reviewer-api-contract.md>",
      "tests": "<contents of reviewer-tests.md>"
    },
    "synthesizer": "<contents of synthesizer.md>",
    "verifier": "<contents of verifier.md>"
  },
  "schemas": {
    "orientation": { /* parsed orientation.schema.json */ },
    "seamMap": { /* parsed seam-map.schema.json */ },
    "reviewer": { /* parsed reviewer-output.schema.json */ },
    "synthesis": { /* parsed synthesis.schema.json */ },
    "verifier": { /* parsed verifier-output.schema.json */ }
  }
}
```

### Call the workflow

```js
const result = await workflow({
  script: script,
  args: JSON.stringify(args),
  agentRetries: config.workflow.agentRetries,
  concurrency: config.workflow.concurrency
})
```

The static workflow script handles all phases: Comprehension → Review → Synthesis.
See `workflow-script.js` for the implementation.

## 4. Persist and assemble the report (after the call)

The `workflow` result is a plain object. Now do the writes the sandbox couldn't —
always via the helper, never the `write` tool.

1. **Write synthesis** (the record): pipe the synthesis result as JSON:
   ```
   python3 <skill-dir>/code-review-workdir.py write-findings --run <run_dir> --slug synthesis
   ```

2. **Write the report**: render one markdown document from the synthesis:
   ```
   python3 <skill-dir>/code-review-workdir.py write-report --run <run_dir>
   ```

### Report shape

The report is **charge-scoped** (not repo-scoped):

1. **Header**: charge, verdict, one-line summary
2. **Top Priorities**: Blockers and Majors only, with corroboration counts
3. **All Findings**: grouped by severity, with location, evidence, rationale
4. **Coverage Caveats**: under-explored seams, timeouts, any reviewer failures
5. **Follow-up Recommendation**: if triggered, explain why

Print the report path (`report.md`), the HTML viewer path (`report.html`), and
`run_dir` to the user. The HTML file renders the markdown client-side and can be
opened directly in a browser.

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
- **Charge is required.** The skill never infers intent from the diff. A review
  is defined by exactly one charge; truly independent changes with no shared
  charge are separate reviews.
