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
`run_dir`, `report`, `multi_repo`, and (multi-repo only) `cross_repo_findings`.
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

## 3. The `workflow` call: Comprehension phase

Run **one** `workflow` call. The first phase is **Comprehension**: two orienteers
run in parallel, then a reconciler merges their outputs into a seam map.

### Inline these into the script (authoring time)

Read each file below and paste its contents into the script as a string literal.
Do **not** rely on runtime file reads — the sandbox has no `fs`.

- `references/orienteer-claim-to-code.md` → `ORIENTEER_A_PERSONA`
- `references/orienteer-code-to-claim.md` → `ORIENTEER_B_PERSONA`
- `references/reconciler.md` → `RECONCILER_PERSONA`
- `references/common-reviewer-rules.md` → `COMMON_RULES`
- `references/reviewer-{correctness,security,performance,api-contract,tests}.md` → `REVIEWER_PERSONA[perspective]`
- `orientation.schema.json` → `orientationSchema` (object literal)
- `seam-map.schema.json` → `seamMapSchema` (object literal)
- `reviewer-output.schema.json` → `reviewerSchema` (object literal)

### Pass the change set as `args`

Build `args` from the manifest + scope and pass it to the `workflow` tool:

```json
{
  "run_dir": "<run_dir>",
  "charge": "<the stated charge>",
  "multi_repo": <bool>,
  "repos": [ { "repo": "<name>", "slug": "<slug>", "bundle": "<bundle path>", "path": "<abs repo local path>" } ]
}
```

### Workflow script skeleton

```js
export const meta = {
  name: 'stacia_code_review',
  description: 'Bounded-context code review: orient, reconcile, review, synthesize',
  phases: [
    { title: 'Comprehension' },
    { title: 'Review' },
    { title: 'Synthesis' }
  ],
}

const RO = 'stacia-review-readonly'
const ORIENTEER_A_PERSONA = `...`    // references/orienteer-claim-to-code.md
const ORIENTEER_B_PERSONA = `...`    // references/orienteer-code-to-claim.md
const RECONCILER_PERSONA = `...`     // references/reconciler.md
const COMMON_RULES = `...`           // references/common-reviewer-rules.md
const REVIEWER_PERSONA = {           // references/reviewer-*.md
  correctness: `...`,
  security: `...`,
  performance: `...`,
  'api-contract': `...`,
  tests: `...`,
}
const orientationSchema = { /* orientation.schema.json */ }
const seamMapSchema = { /* seam-map.schema.json */ }
const reviewerSchema = { /* reviewer-output.schema.json */ }

const PERSPECTIVES = ['correctness', 'security', 'performance', 'api-contract', 'tests']
const K = 3  // max rounds per reviewer
const ROUND_TIMEOUT = 60000  // 60s per round

// ---- Comprehension: two orienteers in parallel, then reconcile ----
phase('Comprehension')

const allBundles = args.repos.map(r => r.bundle).join(', ')
const bundleContext = args.repos.map(r => 
  `Repo: ${r.repo}, bundle: ${r.bundle}, local path: ${r.path}`
).join('\n')

const [orientationA, orientationB] = await parallel([
  () => agent(
    `${ORIENTEER_A_PERSONA}\n\n---\n\nCharge: ${args.charge}\n\nChange set:\n${bundleContext}\n\nTrace how the change delivers the charge (outside-in).`,
    { agentType: RO, tier: 'medium', schema: orientationSchema, label: 'orienteer-A' }
  ),
  () => agent(
    `${ORIENTEER_B_PERSONA}\n\n---\n\nCharge: ${args.charge}\n\nChange set:\n${bundleContext}\n\nReconstruct what the change does, then reconcile against the charge (inside-out).`,
    { agentType: RO, tier: 'medium', schema: orientationSchema, label: 'orienteer-B' }
  )
])

const seamMap = await agent(
  `${RECONCILER_PERSONA}\n\n---\n\nCharge: ${args.charge}\n\nOrienteer A (claim→code) output:\n${JSON.stringify(orientationA)}\n\nOrienteer B (code→claim) output:\n${JSON.stringify(orientationB)}\n\nMerge these into a unified orientation and seam map (3-12 seams).`,
  { agentType: RO, tier: 'medium', schema: seamMapSchema, label: 'reconciler' }
)

// ---- Review: K-round loop per perspective, parallel across perspectives ----
phase('Review')

// K-round reviewer function
async function runReviewer(perspective) {
  let findingsSoFar = []
  let result = null
  
  for (let round = 1; round <= K; round++) {
    const isLastRound = round === K
    const prompt = `${COMMON_RULES}\n\n---\n\n${REVIEWER_PERSONA[perspective]}\n\n---\n\n` +
      `Charge: ${args.charge}\n\n` +
      `Orientation:\n${seamMap.merged_orientation}\n\n` +
      `Seam map:\n${JSON.stringify(seamMap.seams)}\n\n` +
      `Round ${round} of ${K}${isLastRound ? ' (FINAL - must produce write-up)' : ''}\n\n` +
      `Change set:\n${bundleContext}\n\n` +
      (findingsSoFar.length > 0 ? `Findings so far:\n${JSON.stringify(findingsSoFar)}\n\n` : '') +
      `Review the change from the ${perspective} perspective. Focus on high-priority seams.`
    
    result = await agent(prompt, {
      agentType: RO,
      tier: 'medium',
      schema: reviewerSchema,
      label: `${perspective}:${round}`,
      agentTimeoutMs: ROUND_TIMEOUT
    })
    
    if (!result) {
      // Agent failed/timed out - return partial results with low confidence
      return {
        perspective,
        findings: findingsSoFar.map(f => ({ ...f, confidence: 'low' })),
        spillover: true,
        moreExploration: false,
        note: `Review incomplete - agent failed on round ${round}`
      }
    }
    
    findingsSoFar = result.findings || []
    
    // Exit early if reviewer signals no more exploration needed
    if (!result.moreExploration || isLastRound) {
      return result
    }
  }
  
  return result
}

// Run all perspectives in parallel
const reviewResults = await parallel(
  PERSPECTIVES.map(p => () => runReviewer(p))
)

// ---- Synthesis phase: PENDING (Spec 3) ----

return {
  run_dir: args.run_dir,
  charge: args.charge,
  orientations: { a: orientationA, b: orientationB },
  seamMap: seamMap,
  reviews: reviewResults,
  // synthesis results will be added in Spec 3
}
```

## 4. PENDING IMPLEMENTATION

Synthesis phase is not yet implemented.

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
