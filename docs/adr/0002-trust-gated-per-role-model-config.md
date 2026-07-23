---
status: accepted
date: 2026-07-23
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review, security]
---

# Trust-gated per-role model configuration

## Context and Problem Statement

`stacia-code-review` spawns several subagent roles per run — orienteer,
reconciler, reviewer, synthesizer, verifier (`Role` in `models.ts`) — each of
which calls out to a model. Stacia wants to pin cheaper/faster/stronger models
per role (e.g. a cheap model for orienteers, a strong one for synthesis)
without hardcoding choices in the extension.

Config is read from `ctx.cwd`, i.e. the project the *review session* is
running in — not necessarily the repo(s) under review (`params.repos`), which
are supplied separately as bundles. If that host project is itself an
untrusted checkout (e.g. Stacia `cd`'d into a cloned PR branch to review it),
a file dropped in that checkout could otherwise steer subagent model choice.

How should per-role model configuration be sourced and layered so that Stacia
gets cost/quality tuning per role, without an untrusted checked-out repo being
able to redirect subagent traffic to an attacker-chosen provider/model?

## Decision Drivers

- Per-role cost/quality tuning (cheap orienteer, strong synthesizer) should be
  configurable without hardcoding in the extension.
- An untrusted checked-out repo must not be able to steer subagent model
  choice or redirect prompts/context/findings to an attacker-chosen
  provider/model.
- Misconfiguration should degrade visibly, not fail the run.
- Prefer reusing pi's existing trust model over building a new trust surface.

## Considered Options

- **Project config always honored (no trust gate)** — simplest, but lets any
  checked-out repo hijack model selection for subagents that process
  potentially sensitive diffs/context; rejected on security grounds.
- **Single global model config, no per-role override** — simpler surface, but
  loses the cost/quality tuning Stacia wants (cheap orienteer, strong
  synthesizer).
- **Separate trust prompt for this config file** — more precise, but adds a
  new trust surface to build and reason about; reusing pi's existing project
  trust decision keeps this feature consistent with how all other
  project-local config is already gated.
- **Trust-gated layered config (chosen)** — see Decision Outcome.

## Decision Outcome

Chosen option: **trust-gated layered config**. Model configuration is layered,
lowest to highest precedence:

1. Bundled/host default — the host session's active model (`ctx.model`),
   used as the ultimate fallback.
2. User file — `~/.pi/agent/stacia-code-review.json` (`getAgentDir()` +
   `CONFIG_NAME`). Always read.
3. Project file — `<cwd>/.pi/stacia-code-review.json` (`CONFIG_DIR_NAME` +
   `CONFIG_NAME`). Read **only if** `ctx.isProjectTrusted?.()` is true;
   `loadModelConfig(cwd, projectTrusted)` skips it entirely otherwise.

Each file has the shape `{ "models": { "default"?: string, "<role>"?: string
} }`, values `"provider/id"`. Layers are merged with `Object.assign`, so
project values overwrite user values overwrite nothing (host model is a
fallback, not a merge input).

Per-role resolution (`resolveModel`): `cfg.models[role] ?? cfg.models.default`
→ if unset, use the host model; if set but malformed (no `/`) or unresolvable
via `rt.getModel(provider, id)`, fall back to the host model and return a
`note` string. `index.ts` calls `loadModelConfig(ctx.cwd, ctx.isProjectTrusted?.()
?? false)` once per run; `coordinator.ts` calls `resolveModel` per role and
collects any notes for surfacing to the user.

Project trust is the same trust gate pi already uses to decide whether a
project's own `.pi/` config/extensions are allowed to run
(`isProjectTrusted`/`SettingsManager`). Reusing it here means: an untrusted
project's `.pi/stacia-code-review.json` is invisible to the extension, full
stop — no partial trust, no prompt, no separate config surface to defend.

### Consequences

- Good: a malicious or compromised repo cannot use
  `.pi/stacia-code-review.json` to redirect review-subagent traffic (prompts,
  code context, findings) to an attacker-chosen provider/model unless Stacia
  has explicitly trusted that project.
- Good: per-role tuning still works normally for Stacia's own trusted repos
  and always works via the user-level file regardless of project trust.
- Good: if a configured model name is malformed or the provider/id can't be
  resolved, the run degrades to the host model for that role rather than
  failing, and a note is surfaced — misconfiguration is visible, not silent,
  but also not fatal.
- Neutral: the gate is coarse — it's the same trust bit as extension/config
  loading in general, not a review-specific trust decision. If pi's
  project-trust model changes, this feature inherits that change
  automatically (for better or worse) with no code change in `models.ts`.
- Neutral: `ctx.cwd` is the review session's own project, not the repos passed
  as review targets; trusting "the project you're running the review from"
  says nothing about trusting the code being reviewed, which is bundled and
  read separately.

## More Information

- Related: [0001-orchestration-migration-to-custom-extension](0001-orchestration-migration-to-custom-extension.md).
