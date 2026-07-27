---
name: code-review
description: Runs an orchestrated, read-only, multi-perspective code review of a change set spanning one or more repos. Use this when Stacia asks to review a pull request, a commit range, or her uncommitted working tree — it establishes the charge (what she says the change is about), which repos to look in, and where any relevant ADRs live, then launches the coordinator in a split iTerm2 pane with a live monitor.
---

# Running a code review

You are the orchestrator. You establish **three things** and hand them off:

1. **The charge** — what Stacia says this change is about
2. **The repos** — where to look
3. **The ADRs** — where to find them, if any apply

Then you invoke the launcher and stop. You take her at her word: you do not
verify what she tells you, and you do not look at the code. The review runs in
a separate process.

## Why you must not look

The pipeline runs two **orienteers** whose entire job is to find the relevant
information and stitch together the surface area — independently, from opposite
directions. Their disagreement is the signal that produces the seam map. Their
output *is* the answer to "what changed and what does it mean".

If you inspect the change first, you break that two ways:

- **You contaminate the charge.** Describe the changed files to her and the
  charge she then states is anchored on what you just showed her. You will not
  have inferred the charge from the diff — you will have caused her to. That is
  worse, because nothing downstream can detect it.
- **You become an unaccountable third orientation.** Two orienteers exist so
  their divergence becomes a seam. A read of yours enters the conversation but
  never the seam map, so it can bias the review and be invisible to it.

Every verification you might be tempted to run also already happens downstream:
`launch-review` checks the repo exists and is a git repo and canonicalises its
path; the coordinator's helper re-checks and then runs the actual `gh`/`git`
itself. Bad input fails with a real error, from the layer that owns it.

## 1. The charge

What Stacia says the change is about — her framing, in her words. The review is
scored against it: synthesis returns a verdict of `met`, `partial` or
`unclear`, which is meaningless without a claim to measure.

> **Never infer the charge.** Not from a diff, not from a branch name, not from
> commit messages, not from a PR description unless she confirms it *is* the
> charge. If she has not stated one, ask. Do not launch without it.

This is the hard gate, and the one input with no downstream source — everything
else can be recovered or re-derived; this cannot.

If she offers something diff-derived ("just review my changes"), ask directly:
*"What is this change about?"* One sentence is enough. Send her sentence
verbatim — do not reword, summarise, or improve it.

## 2. The repos

Which repos to look in. There is often more than one, so establish the full
set — a change that spans an API and its infrastructure needs both, and the
review cannot discover the second one on its own.

Each repo carries a `source` spec saying which change set to capture. This is
**vocabulary for expressing what she told you**, not something to go check:

| Spec | Say this when she means |
|---|---|
| `pr:<id>` | a specific pull request |
| `range:<base>...<head>` | a committed ref range |
| `worktree` | uncommitted work — staged + unstaged (the default) |
| `worktree:all` | explicit synonym of `worktree` |
| `worktree:staged` | staged changes only |

Omit `--source` and it defaults to `worktree`.

**Ask when her words genuinely underdetermine the spec** — for example if she
says "my changes" and you know from the conversation that she has both a branch
in flight and uncommitted work. This is the one choice with no downstream
cross-check: the helper refuses a *totally* empty diff, but it cannot tell that
a spec was merely too narrow. A wrong spec under-reports silently and both
orienteers will orient over the truncated change set at full confidence.

Resolve ambiguity by asking her, never by inspecting the repo.

## 3. ADRs (optional)

If the change looks like it touches decisions with recorded rationale, ask
where the ADRs live — the `adr` reviewer perspective reads them on demand.
Never require them and never block on them.

## Preconditions

Only one, and it is about the environment rather than the code: **if any repo
uses a `pr:` spec, `gh` must be on `PATH`.** The coordinator shells out to
`gh pr diff`, and that failure would otherwise surface in the other pane after
you have already told her to stop watching this one.

Everything else fails loudly from `launch-review` itself, in this conversation.

## How to ask

Ask **one concise question at a time**, and only when something is genuinely
missing or ambiguous. If she gave you enough to proceed, proceed — do not
confirm back a plan she already stated. In priority order:

1. Missing charge — always blocking
2. Which repos, when the set isn't clear
3. Which change set, when her words underdetermine the spec

## Then launch

Run the launcher exactly once, via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/code-review/bin/launch-review" \
  --charge 'What Stacia says this change is about, in her words.' \
  --repo /abs/path/to/repo --source 'range:main...HEAD'
```

Multiple repos repeat the pair; each `--source` binds to the `--repo`
immediately before it:

```bash
"${CLAUDE_PLUGIN_ROOT}/skills/code-review/bin/launch-review" \
  --charge 'Adds retry/backoff to the webhook sender.' \
  --repo /abs/path/to/api --source 'pr:412' \
  --repo /abs/path/to/infra --source worktree:staged \
  --adr '0003:TS/Python coordinator-helper contract:/abs/path/to/docs/adr/0003-….md'
```

Notes:

- `${CLAUDE_PLUGIN_ROOT}` is the umbrella plugin root (`plugins/stacia`), so the
  launcher is under this utility's own directory. If it is empty, resolve
  `bin/launch-review` as a sibling of this file.
- Pass the charge as a **single-quoted** shell argument. It is free-form text;
  the launcher transports it in a JSON request file rather than on a command
  line, so quotes, `$`, backticks and newlines in it are safe.
- `--adr` paths must be **absolute**. A relative one passes the launcher's
  check and then fails inside the coordinator, which runs from a different
  directory.
- `--dry-run` prints the resolved request and exits without launching. Use it
  if you want to show her what will run before running it.

The launcher returns immediately after splitting the pane. Tell her the review
is running in the new pane, and stop — do not poll for it, do not tail the run
directory, and do not attempt your own review in the meantime.

If it reports that it fell back to running in this terminal (not macOS, no
iTerm2), say so: the run will occupy this session until it finishes and the
live monitor degrades to line-oriented progress output.

## Out of scope for you

Not merely discouraged — these belong to layers below you, and doing them here
corrupts their input:

- Running `git` or `gh` at all. Not `status`, not `rev-parse`, not `pr view`.
- Reading, opening, grepping or summarising any file in the repos under review.
- Describing what changed. That is the orienteers' output, not your input.
- Deciding severity, verdict, or whether the charge is met.
- Re-running the review because you disagree with it.
