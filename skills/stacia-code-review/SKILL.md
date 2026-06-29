---
name: stacia-code-review
description: Orchestrated multi-perspective code review of a change set, optionally spanning multiple repositories. Spawns parallel read-only reviewer subagents (correctness, security, performance, api-contract, tests, cross-repo), then deduplicates, groups, and prioritizes their findings into a single report. Use when asked to review a PR, a set of PRs, a branch range, or uncommitted changes — especially when the work spans more than one repo.
---

# Code Review (orchestrator)

You are the **orchestrator**. You establish the change set under review, fan out
to specialized read-only reviewer subagents in parallel, then synthesize their
findings into one prioritized report. Do not perform the per-perspective review
yourself — delegate it, then merge.

## 1. Establish scope

The review is always defined relative to **a set of changes**. Determine it before
anything else:

1. **If PRs are specified** (numbers/URLs): those PRs are the change set. Resolve
   each with `gh pr view <id> --json ...` and `gh pr diff <id>`. Note the repo,
   base, and head for each.
2. **If no PRs are specified**: ask the user whether there are PRs to review.
   - If yes, collect their IDs/URLs and proceed as above.
   - If no, **confirm the branch range(s) to compare**, per repo
     (e.g. `origin/main...feature/x`). Ask one repo at a time if ambiguous.
3. **Multi-repo**: build the list of repos involved. Each repo contributes its own
   diff to the bundle. Record for each: repo name, base ref, head ref.

Do not start reviewing until the scope (repos + refs/PRs) is confirmed.

## 2. Collect the diff bundle

For each repo in scope, gather:
- The unified diff (`gh pr diff <id>`, or `git diff <base>...<head>`).
- Changed file list with stat (`git diff --stat <base>...<head>`).
- PR metadata when applicable: title, description, linked issues, labels.
- Enough surrounding context that reviewers can reason about the change (reviewers
  are read-only and can open files in the repo themselves; tell them the repo path).

Assemble a **diff bundle** = the per-repo diffs + metadata + each repo's local path.
This same bundle is handed to every reviewer.

## 3. Fan out to reviewers (parallel)

Launch one read-only subagent per perspective, **all in a single message** so they
run concurrently (use whatever parallel-subagent mechanism the harness provides).
Each subagent is:
- Read-only: it must not edit, write, or commit anything.
- Given (a) the contents of the matching persona file from `references/`, (b) the
  diff bundle, and (c) the list of repo paths it may open for context.
- Instructed to return findings in the **shared finding format** below — nothing else.

Perspectives and their persona files:
| Perspective    | Persona file                       |
|----------------|------------------------------------|
| correctness    | `references/correctness.md`        |
| security       | `references/security.md`           |
| performance    | `references/performance.md`        |
| api-contract   | `references/api-contract.md`       |
| tests          | `references/tests.md`              |
| cross-repo     | `references/cross-repo.md`         |

> Read each persona file and paste its contents into the subagent's prompt
> (subagents do not inherit this context). Append the diff bundle and repo paths.

Skip `cross-repo` only when the scope is a single repo; otherwise always include it.

### Shared finding format

Every reviewer returns a list of findings, each as:

```
- severity: Blocker | Major | Minor | Nit
  perspective: <the reviewer's perspective>
  location: <repo>:<path>:<line(s)>  (or "cross-repo" / "N/A")
  finding: <one-line statement of the problem>
  rationale: <why it matters / what breaks>
  suggestion: <concrete fix or follow-up; omit if none>
```

If a reviewer finds nothing, it returns an empty list and a one-line note.

## 4. Synthesize

After all reviewers return:
1. **Deduplicate** — collapse findings that point at the same root cause, even if
   raised by different perspectives. Keep the highest severity; list contributing
   perspectives.
2. **Group** — cluster by theme (e.g. error handling, auth, query performance,
   contract drift), not by reviewer.
3. **Prioritize** — order groups and findings by severity: Blocker → Major →
   Minor → Nit.
4. **Report** — emit a single report:
   - **Summary**: scope reviewed (repos + refs/PRs), reviewer count, headline risks.
   - **Blockers**: must fix before merge.
   - **Major / Minor / Nit**: grouped findings with location + rationale + suggestion.
   - **Cross-repo notes**: integration/contract risks spanning repos.
   - **Open questions**: anything reviewers flagged as needing author input.

Print the report inline. Offer to also write it to `code-review-<YYYY-MM-DD>.md`
if the user wants a file.

## Notes

- Reviewers are read-only. The orchestrator never edits code as part of a review.
- If `gh` is unavailable or a PR can't be resolved, fall back to branch-range diffs
  and tell the user.
- Keep the diff bundle reasonably scoped; for very large changes, summarize
  per-file and let reviewers open files on demand.
