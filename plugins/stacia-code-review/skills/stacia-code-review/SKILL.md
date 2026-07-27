---
name: stacia-code-review
description: Runs an orchestrated, read-only, multi-perspective code review of a change set spanning one or more repos. Use this when Stacia asks to review a pull request, a commit range, or her uncommitted working tree — it resolves the repos and the exact change set conversationally, requires her to state the charge (what the change claims to accomplish), and then launches the coordinator in a split iTerm2 pane with a live monitor.
---

# Running a stacia-code-review

You are the front half of this review. Your only job is to establish **what is
being reviewed** and **what it claims to accomplish**, then hand that off. The
review itself runs in a separate process — you do not perform it, summarize the
diff, or form an opinion about the code.

## What you must resolve

### 1. The change set

Which repo(s), and exactly what changed in each. Every repo needs an absolute
path and one `source` spec:

| Spec | Meaning |
|---|---|
| `pr:<id>` | A specific pull request |
| `range:<base>...<head>` | A committed ref range |
| `worktree` | Uncommitted working tree — staged + unstaged (the default) |
| `worktree:all` | Explicit synonym of `worktree` |
| `worktree:staged` | Staged changes only |

Before handing off:

- Resolve every repo to an **absolute path** and confirm it is a git repo.
- **Verify refs actually exist.** For a range, `git -C <repo> rev-parse <base>`
  and `<head>`. For a PR, confirm the id resolves (`gh pr view <id> -R …`).
  A typo'd branch name should be caught here, not in the coordinator.
- If she said "my changes" or "what I'm working on" without qualifying,
  `worktree` is the right default — but check `git -C <repo> status --short`
  is non-empty and say what you found.

### 2. The charge — a hard gate

The charge is a statement of **what the change claims to accomplish**. The
review orients and critiques against it; a review without one has nothing to
measure the code against.

> **Never infer the charge from the diff.** Not from the branch name, not from
> the commit messages, not from the PR description unless she confirms it *is*
> the charge. If she has not stated one, ask for it. Do not launch without it.

If she offers something diff-derived ("just review my changes"), ask directly:
*"What is this change supposed to accomplish?"* One sentence is enough.

### 3. ADRs (optional)

If the repo has accepted ADRs relevant to the change, offer to stage them as
context — the `adr` reviewer perspective reads them on demand. Never require
them, and never block on them.

## How to ask

Ask **one concise question at a time**, and only when something is genuinely
ambiguous or missing. If she gave you enough to proceed, proceed — do not
confirm back a plan she already stated. Typical gaps, in priority order:

1. Missing charge (always blocking)
2. Which repo, when the cwd isn't obviously the target
3. Which change set, when both a branch and uncommitted work exist

## Then launch

Run the launcher exactly once, via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/launch-review" \
  --charge 'What the change claims to accomplish, in her words.' \
  --repo /abs/path/to/repo --source 'range:main...HEAD'
```

Multiple repos repeat the pair; each `--source` binds to the `--repo`
immediately before it and defaults to `worktree` if omitted:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/launch-review" \
  --charge 'Adds retry/backoff to the webhook sender.' \
  --repo /abs/path/to/api --source 'pr:412' \
  --repo /abs/path/to/infra --source worktree:staged \
  --adr '0003:TS/Python coordinator-helper contract:/abs/path/to/docs/adr/0003-….md'
```

Notes:

- `${CLAUDE_PLUGIN_ROOT}` is set for Bash calls made from this plugin. If it is
  empty, resolve the launcher from this skill's own location instead
  (`<plugin root>/bin/launch-review`, three directories up from this file).
- Pass the charge as a **single-quoted** shell argument. It is free-form text;
  the launcher transports it in a JSON request file rather than on a command
  line, so quotes, `$`, backticks and newlines in it are safe. Do not
  pre-escape or reword it — send her sentence.
- `--dry-run` prints the resolved request and exits without launching. Use it
  if you want to show her what will run before running it.

The launcher returns immediately after splitting the pane. Tell her the review
is running in the new pane, and stop — do not poll for it, do not tail the run
directory, and do not attempt your own review in the meantime.

If it reports that it fell back to running in this terminal (not macOS, no
iTerm2), say so: the run will occupy this session until it finishes and the
live monitor degrades to line-oriented progress output.

## Out of scope for you

- Reading or analyzing the diff yourself
- Deciding severity, verdict, or whether the charge is met
- Re-running the review because you disagree with it
