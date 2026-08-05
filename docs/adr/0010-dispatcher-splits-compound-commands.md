---
status: accepted
date: 2026-08-05
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, permission-sieve, security]
supersedes: 0009 (partially)
---

# Dispatcher splits compound commands

## Context and Problem Statement

ADR 0009 decided that the dispatcher should not parse compound commands,
leaving each Lua rule to handle complexity on its own. In practice this
led to mounting complexity inside rule definitions — `allow-safe-bash.lua`
grew its own segment splitter and redirect stripper to cope, and every
new guard rule had to decide independently how to handle compound
commands. The complexity that was supposed to stay out of the dispatcher
migrated into the rules instead, where it was duplicated and harder to
audit.

Meanwhile, the core safety argument from 0009 remains sound: the sieve
cannot prove behavioral properties of arbitrary shell. But it can
evaluate the *side-effect profile* of individual commands — "is `git
status` safe?", "does this path touch `/.ssh/`?" — and that evaluation
is more accurate when each command is examined in isolation rather than
buried in a compound chain.

## Decision Drivers

- Rule complexity was growing to compensate for the lack of
  dispatcher-level splitting — the opposite of 0009's intent.
- Evaluating each sub-command through the full sieve pipeline (all rules,
  path extraction, resolution) is strictly more thorough than a single
  rule's best-effort splitting.
- The fail-safe principle still holds: any ambiguity results in
  "uncertain" and the user is prompted.
- Redirections represent real side effects (file overwrites) and must be
  evaluated, not stripped.

## Decision Outcome

The dispatcher splits compound Bash commands into segments and evaluates
each segment through the full sieve pipeline independently. Results are
aggregated across segments with the same algebra used for single
commands.

This partially supersedes ADR 0009. The core principle — that the sieve
should not attempt behavioral analysis of arbitrary shell and should fail
safe to "uncertain" — is preserved. What changes is *where* structural
decomposition happens: in the dispatcher rather than in individual rules.

### Splitting

The dispatcher splits on `|`, `||`, `&&`, `;`, and `&`, respecting
single and double quotes. This reuses the existing `split_on_shell_operators`
logic from `paths.rs`, promoted to a shared utility.

Non-Bash tool calls are unaffected.

### Per-segment evaluation

Each segment is wrapped in a synthetic event with `tool_input.command`
set to that segment. The full pipeline runs for each segment:

1. Path extraction (including redirect targets)
2. All Lua rules
3. Resolution (same `resolve()` algebra per segment)

### Cross-segment aggregation

Segment resolutions are aggregated:

- Any **denied** → compound is **denied** (first denial wins)
- All **approved** → compound is **approved**
- Otherwise → compound is **uncertain** (summarizer + prompt)

This is the same algebra as single-command resolution across rules.

### Redirections

Redirections (`>`, `>>`, `2>`, `&>`, etc.) stay attached to their
segment — they are not stripped or split out. Redirect targets are
extracted as paths in `request.paths` so path-based guards
(`guard-sensitive-paths`, `guard-external-dirs`) evaluate them.

This means `echo secret > ~/.ssh/authorized_keys` is caught: the
redirect target appears in `request.paths`, and the sensitive-path
guard flags it.

### Summarization

When the compound resolution is "uncertain," the summarizer receives
the original full command, not individual segments. The user needs
context about the complete operation they are approving.

### Decision logging

The decision record includes a `segments` field with per-segment
resolution detail, providing auditability for compound command
evaluation.

### Rule simplification

`allow-safe-bash.lua` drops its own `split_segments` and
`strip_redirects` functions — it now only sees single-segment commands.
Other Bash rules (`deny-dangerous`, `guard-bash-carveouts`,
`guard-sensitive-paths`) require no structural changes; they naturally
operate on individual segments.

### Consequences

- Good: rule definitions become simpler and more auditable — no
  duplicated splitting logic across rules.
- Good: every sub-command is evaluated through all rules and path
  extraction, not just a subset of checks in a single rule.
- Good: redirect targets are now visible to path-based guards, closing
  a class of bypass where a safe command redirects to a sensitive path.
- Good: the fail-safe principle is preserved — unknown or ambiguous
  segments still trigger "uncertain."
- Neutral: the dispatcher takes on more responsibility, but the logic
  is well-defined and testable.
- Bad: a small increase in per-invocation cost for compound commands
  (multiple rule evaluations). Acceptable given the sieve's sub-millisecond
  budget for rule evaluation.
