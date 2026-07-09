---
name: stacia-code-review
description: Orchestrated multi-perspective code review of a change set, optionally spanning multiple repositories. Fans out parallel read-only reviewer subagents (correctness, security, performance, api-contract, tests, cross-repo) via a single pi-dynamic-workflows `workflow` call, adversarially verifies the high-severity findings, then synthesizes per repo (one report per repo, a separate cross-repo analysis, and an overall top-priorities triage). Use when asked to review a PR, a set of PRs, a branch range, or uncommitted changes — especially when the work spans more than one repo.
---

# Code Review (orchestrator)

You are the **orchestrator**. You establish the change set under review, then run
a single **`workflow`** call (the pi-dynamic-workflows tool) that fans out to
specialized read-only reviewer subagents in parallel, adversarially verifies the
high-severity findings, and synthesizes per repo. You persist the artifacts and
assemble the final report around that call.

This skill targets the **`workflow` tool from `@quintinshaw/pi-dynamic-workflows`**
(`agent()`, `parallel()`, `phase()`, `verify`-style stages, per-agent `schema`,
`tier`, and `agentType`). It replaces an earlier pi-subagents implementation. The
run-directory helper `code-review-workdir.py` is unchanged and harness-neutral.

## Why the work is split around the workflow call

A `workflow` script runs in a Node **vm sandbox**: no `fs`, no `require`, no
`bash`, no network, no `Date.now()`/`Math.random()`. That draws a hard line:

- **Orchestrator turn, before the call** — everything with side effects:
  preflight, the interactive scope gate, `init`, and `build-bundle` per repo
  (all the `gh`/`git`/filesystem I/O the helper does).
- **The single `workflow` call** — pure fan-out: subagents *read* the on-disk
  bundles (their `agentType` grants `read`/`ffgrep`/`fffind`), review → verify →
  synthesize, and the script **returns a compact JSON value**. It writes nothing.
- **Orchestrator turn, after the call** — persist findings + report via the
  helper (which the sandbox could not call) and print the paths.

This matches the extension's intended shape ("intermediate results stay in
variables… returns only the result") and makes the read-only guarantee concrete:
the script cannot write, and every subagent is tool-restricted via `agentType`.

## 0. Preflight

Verify tooling before establishing scope. Per-repo/per-ref checks happen in
step 1 once candidates are known.

- **`workflow` tool present**: this skill drives pi-dynamic-workflows. If the
  `workflow` tool is unavailable, stop and tell the user the extension isn't
  installed (`pi install npm:@quintinshaw/pi-dynamic-workflows`, then `/reload`).
- **Read-only `agentType` installed**: the reviewer/verify/synth subagents bind
  their read-only toolset through `~/.pi/agents/stacia-review-readonly.md`. Check
  it exists (`ls ~/.pi/agents/stacia-review-readonly.md`). If absent, tell the
  user to run `summon setup` (it symlinks the binding from this skill dir) — do
  not silently create it. Without it, the fan-out has no tool-level read-only
  enforcement.
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
reach a reviewer. It annotates every changed file with churn, post-change LOC, and
an **advisory confidence ceiling** (larger file → lower ceiling), and inlines each
file's diff (omitting only diffs too large to inline, with a pointer to the file).
One repo per bundle is deliberate: a reviewer handles a single repo far more
reliably than a combined bundle. `write-bundle` (raw stdin) remains a guarded
fallback, but **prefer `build-bundle`**.

## 3. The `workflow` call (fan-out → verify → synthesize)

Run **one** `workflow` call. Its script inlines the personas and schemas (read
from this skill dir at authoring time — the sandbox can't read them at runtime),
reads the change set from `args`, and returns a compact JSON result. Subagents
read the bundles off disk via their read-only `agentType`.

### Inline these into the script (authoring time)

Read each file below and paste its contents into the script as a string / object
literal. Do **not** rely on runtime file reads — the sandbox has no `fs`.

- `references/common-reviewer-rules.md` → `COMMON` (prepended to every perspective)
- `references/reviewer-{correctness,security,performance,api-contract,tests,cross-repo}.md`
  → the six persona strings
- `references/verify.md` → `VERIFY_PERSONA`
- `references/synth.md` → `SYNTH_PERSONA`
- `findings.schema.json` → `findingsSchema` (object literal)
- `synth.schema.json` → `synthSchema` (object literal)

### Pass the change set as `args`

Build `args` from the manifest + scope and pass it to the `workflow` tool:

```json
{
  "run_dir": "<run_dir>",
  "multi_repo": <bool>,
  "repos": [ { "repo": "<name>", "slug": "<slug>", "bundle": "<bundle path>", "path": "<abs repo local path>" } ]
}
```

### Roles, tiers, and read-only binding

Every `agent()` call passes `agentType: 'stacia-review-readonly'` (tool-level
read-only: `read`/`ffgrep`/`fffind` only) plus the inlined persona as the prompt.
Route by role: **reviewers → `tier: 'medium'`**, **verifiers → `tier: 'medium'`**,
**synth → `tier: 'big'`**. Give every `agent()` a short unique `label`.

The verify stage is **hand-rolled** (not the built-in `verify()` helper) so its
subagents are also tool-restricted and evidence-grounded: each verifier opens the
cited file and confirms the quoted evidence exists there. Run the `workflow` tool
with `agentRetries: 1` (recoverable fan-out failures) and `concurrency: 6`.

### Script skeleton

```js
export const meta = {
  name: 'stacia_code_review',
  description: 'Multi-perspective code review: fan out, verify, synthesize per repo',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }, { title: 'Completeness' }],
}

const RO = 'stacia-review-readonly'
const COMMON = `...`                 // references/common-reviewer-rules.md
const PERSONA = {                    // references/reviewer-*.md
  correctness: `...`, security: `...`, performance: `...`,
  'api-contract': `...`, tests: `...`,
}
const CROSS_PERSONA = `...`          // references/reviewer-cross-repo.md
const VERIFY_PERSONA = `...`         // references/verify.md
const SYNTH_PERSONA = `...`          // references/synth.md
const findingsSchema = { /* findings.schema.json */ }
const synthSchema = { /* synth.schema.json */ }
const verifySchema = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] }

const PERSPECTIVES = ['correctness', 'security', 'performance', 'api-contract', 'tests']
const isHigh = (f) => f && (f.severity === 'Blocker' || f.severity === 'Major')

// ---- Review: every perspective, every repo, in parallel ----
phase('Review')
const reviewJobs = []
for (const r of args.repos) {
  for (const p of PERSPECTIVES) {
    reviewJobs.push({ slug: r.slug, repo: r.repo, perspective: p, cross: false,
      run: () => agent(`${COMMON}\n\n---\n\n${PERSONA[p]}\n\n---\n\nReview the change set in bundle \`${r.bundle}\` (repo \`${r.repo}\`, local path \`${r.path}\`). Open files under the local path for context as needed.`,
        { agentType: RO, tier: 'medium', schema: findingsSchema, label: `${r.slug}:${p}` }) })
  }
}
if (args.multi_repo) {
  const bundles = args.repos.map((r) => r.bundle).join(', ')
  reviewJobs.push({ slug: 'cross-repo', repo: 'cross-repo', perspective: 'cross-repo', cross: true,
    run: () => agent(`${COMMON}\n\n---\n\n${CROSS_PERSONA}\n\n---\n\nReview the cross-repo change set across all bundles: ${bundles}.`,
      { agentType: RO, tier: 'medium', schema: findingsSchema, label: 'cross-repo' }) })
}
const reviewResults = await parallel(reviewJobs.map((j) => j.run))
// bucket per repo (results align with reviewJobs order); track failed perspectives
const perRepo = {}       // slug -> { repo, perspectives: [{perspective, note, findings[]}], failed: [] }
let crossResult = null
for (const r of args.repos) perRepo[r.slug] = { repo: r.repo, perspectives: [], failed: [] }
reviewJobs.forEach((j, i) => {
  const res = reviewResults[i]
  if (j.cross) { crossResult = res; return }
  if (res && Array.isArray(res.findings)) perRepo[j.slug].perspectives.push(res)
  else perRepo[j.slug].failed.push(j.perspective)
})

// ---- Verify: adversarially ground every Blocker/Major (+ cross-repo highs) ----
phase('Verify')
const verifyFinding = async (f, ctx) => {
  const claim = `${VERIFY_PERSONA}\n\n---\n\nCandidate finding (JSON):\n${JSON.stringify(f)}\n\nContext: bundle \`${ctx.bundle}\`${ctx.path ? `, repo local path \`${ctx.path}\`` : ''}. Open the cited file and confirm the quoted evidence exists at that location.`
  const votes = (await parallel([1, 2].map((n) => () =>
    agent(claim, { agentType: RO, tier: 'medium', schema: verifySchema, label: `verify ${ctx.slug} ${n}` })))).filter(Boolean)
  const real = votes.filter((v) => v && v.real).length
  return votes.length > 0 && real / votes.length >= 0.5   // unverifiable (no votes) -> drop
}
for (const r of args.repos) {
  const ctx = { slug: r.slug, bundle: r.bundle, path: r.path }
  const bucket = perRepo[r.slug]
  bucket.dropped = []
  for (const pr of bucket.perspectives) {
    const kept = []
    for (const f of pr.findings) {
      if (!isHigh(f)) { kept.push(f); continue }          // only high-sev is verified
      if (await verifyFinding(f, ctx)) kept.push(f)
      else bucket.dropped.push(f)
    }
    pr.findings = kept
  }
}
if (crossResult && Array.isArray(crossResult.findings)) {
  const allBundles = args.repos.map((r) => r.bundle).join(', ')
  const ctx = { slug: 'cross-repo', bundle: allBundles, path: null }
  const kept = []
  for (const f of crossResult.findings) {
    if (!isHigh(f)) { kept.push(f); continue }
    if (await verifyFinding(f, ctx)) kept.push(f)
  }
  crossResult.findings = kept
}

// ---- Synthesize: one big-tier synth per repo (dedup/theme/prioritize) ----
phase('Synthesize')
const synthJobs = args.repos.map((r) => () =>
  agent(`${SYNTH_PERSONA}\n\n---\n\nRepo: \`${r.repo}\`. Bundle: \`${r.bundle}\`. Local path: \`${r.path}\`.\n\nPer-perspective findings (already verified for Blocker/Major):\n${JSON.stringify(perRepo[r.slug].perspectives)}`,
    { agentType: RO, tier: 'big', schema: synthSchema, label: `synth:${r.slug}` }))
const synthResults = await parallel(synthJobs)

// ---- Completeness: a final "what did we under-review" critic per repo ----
phase('Completeness')
const completeness = await parallel(args.repos.map((r, i) => () =>
  completenessCheck({ repo: r.repo, perspectives: PERSPECTIVES, failed: perRepo[r.slug].failed },
    synthResults[i] ?? { note: 'synth produced no result' })))

return {
  run_dir: args.run_dir,
  multi_repo: args.multi_repo,
  repos: args.repos.map((r, i) => ({
    repo: r.repo, slug: r.slug,
    synth: synthResults[i] ?? null,
    rawPerspectives: perRepo[r.slug].perspectives,
    droppedByVerify: perRepo[r.slug].dropped ?? [],
    failedPerspectives: perRepo[r.slug].failed,
    completeness: completeness[i] ?? null,
  })),
  crossRepo: crossResult ?? null,
}
```

Notes on the script:
- `parallel()` takes **thunks** (`() => agent(...)`), and returns results in input
  order — that alignment is how results are bucketed back to `(repo, perspective)`.
- A failed `agent()` returns `null`; guard for it (a failed perspective is
  recorded in `failedPerspectives`, not silently dropped).
- Only **Blocker/Major** (and cross-repo highs) are verified — the expensive
  false-positive cases. Minor/Nit pass straight to synth, which still clamps the
  confidence ceiling.
- `completenessCheck` is the extension's built-in critic; it runs at the session
  default tier with default tools (read-only by the nature of its task). It's a
  "what's missing" signal for the report header, not a gate.

## 4. Persist and assemble the report (after the call)

The `workflow` result is a plain object. Now do the writes the sandbox couldn't —
always via the helper, never the `write` tool. Redact secret-like values in
evidence (prefix + length, never the full credential) before persisting.

1. **Per-repo findings** (the record): for each repo, pipe its `synth` result
   (plus `droppedByVerify` / `failedPerspectives` for the audit trail) as JSON:
   ```
   python3 <skill-dir>/code-review-workdir.py write-findings --run <run_dir> --slug <slug>   # JSON on stdin
   ```
2. **Cross-repo findings** (multi-repo only): pipe `crossRepo` as JSON:
   ```
   python3 <skill-dir>/code-review-workdir.py write-cross-findings --run <run_dir>   # JSON on stdin
   ```
3. **The report**: render one markdown document and store it:
   ```
   python3 <skill-dir>/code-review-workdir.py write-report --run <run_dir>   # markdown on stdin
   ```
   Print the returned path and the `run_dir` to the user so artifacts are findable.

### Report shape

**Multi-repo** — three components, in this order:

1. **Top Priorities** — Blockers and Majors **only**, ranked, each labelled with
   its repo or `cross-repo`. **Cross-repo findings sort first**, then by severity
   (Blocker → Major), then confidence. A triage list — never Minor/Nit here.
2. **Per-repo sections** — one per repo, each opening with that repo's synth
   `summary` line, then its findings grouped by `theme` and ordered Blocker →
   Major → Minor → Nit (location + evidence + rationale + suggestion).
3. **Cross-repo** — the (verified) cross-repo findings, same finding shape.

**Single-repo** — collapse to one report (no Top Priorities, no Cross-repo): the
synth `summary` as the header, then its grouped findings ordered by severity.

The summary header carries: scope (repos + refs/PRs), the fact that Blocker/Major
findings were adversarially verified, any `failedPerspectives`, and each repo's
`completeness.missing` items (as caveats). Note any repo whose `synth` was `null`
rather than dropping it.

## Notes

- **Read-only by construction.** Every subagent (reviewer, verifier, synth) binds
  `agentType: 'stacia-review-readonly'`, whose frontmatter grants only
  `read, ffgrep, fffind` — no `edit`, `write`, or `bash`. The workflow script
  itself runs in a sandbox with no `fs`/`bash`, so it cannot mutate anything
  either. The orchestrator never edits code as part of a review.
- **The read-only binding must be installed.** `summon setup` symlinks
  `skills/stacia-code-review/stacia-review-readonly.md` into `~/.pi/agents/`,
  where the workflow tool resolves `agentType` names (user scope, so it applies
  regardless of which repo is under review). If preflight finds it missing, stop
  and have the user run `summon setup`.
- **The personas are the source of truth** under `references/`; edit them there.
  They are inlined into the script at authoring time because the vm sandbox can't
  read files at runtime — re-inline after editing.
- **Run state** lives under `${XDG_CACHE_HOME:-$HOME/.cache}/stacia-code-review/runs/`,
  allocated, captured, and written by `code-review-workdir.py` (a private helper,
  not a PATH utility): `init` allocates + records a `manifest.json`; `build-bundle`
  runs `gh`/`git` itself (so the model never handles diff bytes) and annotates each
  file with a size-derived confidence ceiling; `write-findings` /
  `write-cross-findings` / `write-report` (and the `write-bundle` fallback) resolve
  every destination from the manifest and validate input. Old run dirs persist
  until manually cleaned.
- **The file-size confidence ceiling is advisory**: the bundle surfaces it,
  reviewers calibrate down and never exceed it, the verifier grounds high-severity
  findings in the actual file, and synth clamps any finding that still exceeds its
  ceiling. Nothing is mechanically blocked — a large file just lowers attainable
  confidence.
- If `gh` is unavailable or a PR can't be resolved, fall back to branch-range or
  working-tree diffs and tell the user.
- Keep each per-repo bundle reasonably scoped; for very large changes the helper
  omits oversized per-file diffs and reviewers open files on demand.
