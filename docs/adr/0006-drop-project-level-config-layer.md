---
status: accepted
date: 2026-07-27
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review, security]
---

# Drop the project-level config layer

## Context and Problem Statement

[ADR-0002](0002-trust-gated-per-role-model-config.md) layered `stacia-code-review`'s
config three deep, lowest to highest precedence, deep-merged by `loadConfig`
(`config.ts`):

1. Bundled defaults — `assets/config.json`. Always read.
2. User file — `~/.pi/agent/stacia-code-review.json`. Always read.
3. Project file — `<cwd>/.pi/stacia-code-review.json`. Read **only if**
   `ctx.isProjectTrusted?.()` returned true.

Layer 3 was the only layer behind a trust gate, and that call
(`index.ts:124`) was the sole use of `ctx.isProjectTrusted()` anywhere in the
extension. The gate mattered because of *where* the config is read from:
`ctx.cwd` — the directory the review is being run **from**, not the repos
under review, which are supplied separately as bundles (`params.repos`) and
never contribute config. So the file that could rewrite the run's settings was
a file in whatever checkout Stacia happened to be standing in.

That is precisely the reviewer's normal working posture: `cd` into a cloned PR
branch to review it. Under that posture, an untrusted checkout that commits
`.pi/stacia-code-review.json` gets to edit the merged config of the process
about to read its code. Setting `models.*` redirects **every subagent's
traffic — the diffs, the orientation, the findings — to an attacker-chosen
endpoint**. That is an exfiltration gate, not a preference. And the blast
radius is the whole merged config, not just `models`: `reviewer.perspectives:
[]` would silently blind the review rather than fail it, `reviewer.maxFindings`
would cap what can be reported, and any tunable added later inherits the same
exposure by default.

Re-hosting the coordinator on the Claude Agent SDK
([ADR-0007](0007-rehost-coordinator-on-claude-agent-sdk.md)) removes the gate's
foundation: **Claude Code exposes no project-trust signal** — not to plugins,
not to hooks, not through the SDK. `ctx.isProjectTrusted()` has no analogue to
port to. Layer 3 cannot be carried across as specified.

Should the project config layer be reimplemented on some new gate, carried
across ungated, or removed?

## Decision Drivers

- There is no project-trust bit in Claude Code to gate on. ADR-0002's gate is
  not portable, only replaceable or removable.
- The asset at risk is high value and hard to notice losing: subagent traffic
  contains the diff, the reconstructed orientation, and the findings. A
  redirected model endpoint exfiltrates all three and the review still appears
  to succeed.
- The exposure is structural, not incidental: config comes from `ctx.cwd`, and
  the whole point of the tool is to be run from inside a checkout you do not
  trust yet.
- Any replacement gate is new security surface to build, document, and defend —
  a cost ADR-0002 explicitly declined to pay.
- The cost of removal should be measured against what actually exists on disk,
  not assumed.
- ADR-0002's actual *feature* — per-role cost/quality tuning with loud,
  fail-fast validation — must keep working.

## Considered Options

- **Drop layer 3 entirely** (chosen) — `loadConfig` keeps defaults + user file;
  the project path and the trust call are deleted.
- **Honor layer 3 only for directories allow-listed in the user-scope config
  file** — a repo cannot write the user-scope file, so an untrusted checkout
  cannot allow-list itself. This is a review-specific trust surface, i.e. the
  option ADR-0002 rejected; it is now the only *kind* of option available,
  since there is no host trust decision left to borrow.
- **Carry layer 3 across ungated** — smallest diff, keeps parity with the
  documented three-layer design; rejected outright. It does not degrade the
  ADR-0002 threat model, it deletes it: every checkout becomes trusted.

## Decision Outcome

Chosen option: **drop the project-level config layer**. `loadConfig` loses its
`projectConfigPath` parameter, and the `ctx.isProjectTrusted?.()` expression at
`index.ts:124` is deleted rather than translated. Two layers remain:

1. Bundled defaults — `assets/config.json`. Always read.
2. User file — repointed to `~/.claude/stacia-code-review.json`. Always read.

Everything else ADR-0002 decided survives unchanged: per-role model selection,
deep-merged layering, and resolution as an **explicit fail-fast requirement**
(`validateModels` throws, naming every offending role; there is no silent
fallback to a host or default model). Only the model *format* changes, and for
an unrelated reason — see ADR-0007. ADR-0002 is superseded because its central
mechanism, the trust gate, is gone; its feature is not.

**ADR-0002's reasoning for rejecting a separate trust surface is now void, and
should be read as void rather than as still-binding precedent.** It reasoned:

> *"Separate trust prompt for this config file — more precise, but adds a new
> trust surface to build and reason about; reusing pi's existing project trust
> decision keeps this feature consistent with how all other project-local
> config is already gated."*

That argument was sound and is no longer available. It was never "don't build a
trust surface"; it was "don't build a second one when a first already exists."
There is no first one now. If per-project overrides are ever wanted again, the
allow-list option above is the shape to build — and it must be argued on its
own merits, not inherited from ADR-0002.

**Verified cost of removal: zero.** No `stacia-code-review.json` exists at the
user path, nor at any project path anywhere under `~/Documents/code`. Layer 3
was never once populated in the life of the feature. Nothing in use is being
taken away.

### Consequences

- Good: the exfiltration gate is closed by construction, not by a gate that
  could be misconfigured, defaulted open, or accidentally bypassed. A checked-
  out repo has no config surface at all — there is no file for it to write.
- Good: the one expression in the extension with no Claude Code analogue is
  deleted rather than emulated. Nothing in the port has to pretend to know
  whether a directory is trusted.
- Good: `loadConfig` gets simpler — one fewer layer, one fewer optional
  argument, one fewer conditional read; and the reachable config sources are
  now enumerable without knowing runtime trust state.
- Good: per-role tuning and its fail-fast validation are untouched, and now
  behave identically in every directory rather than varying with a trust bit
  the user cannot see.
- Neutral: `reviewer.perspectives` was one of the vectors the gate protected,
  but that key is currently **declared and never read** — the coordinator
  iterates the hardcoded `PERSPECTIVES` constant. That specific vector was
  latent rather than live; it is listed here because the blast radius is the
  merged config as a whole, including tunables that become live later.
- Neutral: the user file moves from `~/.pi/agent/` to `~/.claude/`. It sits
  beside Claude Code's own configuration but is not read by Claude Code — the
  coordinator loads it directly by path.
- Bad: per-project tuning is no longer possible *even for repos Stacia trusts*.
  A repo that would legitimately want a stronger reviewer model must be
  configured machine-wide in the user file, or not at all. This is the real
  cost of the decision and it is accepted because the feature was never used.
- Bad: the user-scope file is now the single override point, so any tuning is
  global. Reviewing two repos with different cost profiles in the same session
  means one setting for both.

## More Information

- Supersedes: [0002-trust-gated-per-role-model-config](0002-trust-gated-per-role-model-config.md).
- Related: [0007-rehost-coordinator-on-claude-agent-sdk](0007-rehost-coordinator-on-claude-agent-sdk.md)
  (the re-host that removed the trust signal, and the change to the model id
  format the remaining layers carry).
