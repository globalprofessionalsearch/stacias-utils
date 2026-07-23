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
The run-directory helper `code-review-workdir.py` handles all filesystem I/O, and
`summon setup` registers the workflow script as a saved workflow so it can be
invoked by name.

## Why the work is split around the workflow call

A `workflow` script runs in a Node **vm sandbox**: no `fs`, no `require`, no
`bash`, no network, no `Date.now()`/`Math.random()`. That draws a hard line:

- **Orchestrator turn, before the call** — everything with side effects:
  preflight, the interactive scope gate, `init`, `build-bundle` per repo, and
  staging any reference material into the context store (all the `gh`/`git`/
  filesystem I/O the helper does).
- **The single `workflow` call** — pure fan-out, invoked **by name** (a saved
  workflow; see §3). Its script is static and versioned, with schemas and
  personas **embedded**, so the orchestrator's tool-call payload is a tiny,
  fully-dynamic `args` object — no hand-transcribed static content. Subagents
  *read* the on-disk bundles and context (their `agentType` grants
  `read`/`ffgrep`/`fffind`), and the script **returns a compact JSON value**.
  It writes nothing.
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
- **Saved workflow registered**: the workflow script is delivered to the tool
  **by name**, not inline. Check the saved workflow exists
  (`ls ~/.pi/workflows/saved/stacia_code_review.json`). If absent, tell the user
  to run `summon setup` (it registers the script, schemas embedded, as a
  user-scope saved workflow) — do not paste the script inline as a fallback.
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

### 1d. ADR locations

After confirming scope, ask: **"Where should I look for relevant ADRs?"**

Examples of valid responses:
- `github.com/org/adrs/docs/adr` — a GitHub path (fetched via `gh api`)
- `docs/adr` — a local path in the repo under review
- `github.com/org/adrs/docs/adr + docs/adr` — multiple locations
- `none` or skip — no ADR compliance checking

If the user provides locations:
1. The `adr` perspective will be included in the review
2. You will fetch ADRs from those locations and stage them into the context
   store (step 2) before the workflow call

If the user skips or says "none":
1. Remove `adr` from the perspectives list for this run
2. Skip ADR fetching

### 1e. Any other large context

ADRs are one case of a general need: **any large reference material a reviewer
should know** (specs, PRDs, design docs, style guides, prior review notes,
fetched pages, oversized PR bodies). Do not inline such material into `args` by
value. Stage it into the run's **context store** (step 2) and pass only the
catalog of paths; subagents `read` what they need. Static content the *script
body* composes (personas, schemas) isn't in `args` at all — it's embedded in the
by-name workflow script (step 3). The only large thing `args` ever carries is
the context **catalog** (paths), never bodies.

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
with `bundles/`, `context/`, `findings/`, a `report.md` target, and a
`manifest.json`, then prints that manifest as JSON: per-repo `slug` + `bundle` +
`findings`, the `run_dir`, `report`, `multi_repo`, and an initially-empty
`context` catalog.
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

### Stage large context (context store)

The bundle is the by-reference channel for diffs. The **context store** is the
same channel for everything else. For each piece of large reference material,
resolve the source yourself, then pipe the bytes to the helper:

```
<resolve source> | python3 <skill-dir>/code-review-workdir.py add-context \
  --run <run_dir> --kind <kind> --id <id> --title <title> [--ext md]
```

It writes `context/<kind>/<id>.<ext>`, records `{id,kind,title,path}` in the
manifest's `context` catalog, and prints the path. Re-parse the manifest (or
collect the printed entries) so you can pass the catalog into the workflow
`args`. **Never** place content by an outside-supplied path or use the `write`
tool — route every write through the helper.

## 3. The `workflow` call

Run **one** `workflow` call. The workflow script is delivered to the tool **by
name** (a saved workflow registered by `summon setup`), not pasted inline. The
orchestrator only builds a small `args` object and invokes it.

### Why by name, and what stays out of `args`

The `workflow` tool takes `script` and `args` as inline parameters the model
must *author into the tool call itself* — there is no file-reference for them,
and large hand-transcribed content risks silent corruption (a wrong enum stays
valid JSON but weakens enforcement). So all **static, versioned** content lives
in the script, which is delivered by name and never transcribed:

- **The script** (`workflow-script.js`) — invoked as `name: 'stacia_code_review'`.
- **Output schemas** — embedded in the script as `SCHEMAS` (with config-driven
  bounds injected at runtime inside the script). Do **not** put schemas in `args`.
- **Personas** — embedded in the script as `PERSONAS`. Do **not** put personas
  in `args`.

Only genuinely **dynamic, per-run** data goes in `args`: run paths, the charge,
the repo list, the context catalog, and `config`.

### Read and validate config

`config` is small and tunable, so it rides `args` (not the script):
- `config.json` — tunable constants (rounds, timeouts, thresholds)
- `config.schema.json` — validate `config.json` against this; fail fast on invalid config

### Fetch and stage ADRs (if locations provided)

If the user provided ADR locations in step 1d, fetch them and stage each into
the context store (`kind: adr`) before building args:

**For GitHub paths** (e.g., `github.com/org/repo/docs/adr`):
```bash
# List ADR files
gh api repos/<org>/<repo>/contents/<path> --jq '.[].name'

# Read each .md file
gh api repos/<org>/<repo>/contents/<path>/<filename> --jq '.content' | base64 -d
```

**For local paths** (e.g., `docs/adr` in a repo under review):
```bash
ls <repo-path>/<adr-path>/*.md
read <repo-path>/<adr-path>/<filename>
```

**Filter to accepted ADRs**: Parse frontmatter and include only those with
`status: accepted`. Proposed, deprecated, and superseded ADRs are not binding.

Stage each accepted ADR into the context store (do not inline its body):
```bash
<read/decode the ADR markdown> | python3 <skill-dir>/code-review-workdir.py \
  add-context --run <run_dir> --kind adr --id 0001 --title "Short title"
```

After staging, re-read `manifest.json`; its `context` catalog now holds
`{id,kind,title,path}` for every staged item. Pass that catalog as `context` in
the workflow `args` (paths only — the workflow injects the catalog into prompts
and subagents `read` the bodies).

### Build args

Build the small, fully-dynamic `args` from the manifest + scope + config. No
personas, no schemas — those are embedded in the script:

```json
{
  "run_dir": "<run_dir>",
  "charge": "<the stated charge>",
  "multi_repo": <bool>,
  "repos": [ { "repo": "<name>", "slug": "<slug>", "bundle": "<bundle path>", "path": "<abs repo local path>" } ],
  "context": [ { "id": "0001", "kind": "adr", "title": "...", "path": "<context path>" } ],
  "config": { /* parsed config.json */ }
}
```

The script reads `config` and injects the config-driven schema bounds
(`seams.min/maxItems`, `findings.maxItems`) into its embedded `SCHEMAS` at
runtime, so bounds stay both config-driven and schema-enforced.

### Call the workflow

Invoke by name — the tool loads the registered script from
`~/.pi/workflows/saved/stacia_code_review.json`:

```js
const result = await workflow({
  name: 'stacia_code_review',
  args: JSON.stringify(args),
  agentRetries: config.workflow.agentRetries,
  concurrency: config.workflow.concurrency
})
```

The script handles all phases: Comprehension → Review → Synthesis → Verification.
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
