---
status: accepted
date: 2026-07-23
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review, security]
---

# Hand-rolled JSON-Schema-subset validator and submit_result gate

## Context and Problem Statement

The `stacia-code-review` extension runs several read-only subagents
(orientation, seam-map/reconciler, reviewer, synthesis, verifier — see
`coordinator.ts`), each required to return a JSON object conforming to one of
our JSON Schemas (`assets.schemas.*`). Each subagent's only exit is a
`submit_result` tool (`subagent.ts`); the coordinator calls `runSubagent` once
per stage, passing that stage's schema straight through.

We need two things from the same schema: (1) a runtime check that rejects a
model's malformed submission and feeds the errors back so it can self-correct,
and (2) a tool-parameter shape (typebox) that the model actually sees in its
tool signature, so it is more likely to call `submit_result` correctly in the
first place (per `schema-typebox.ts`'s comment, a generic untyped bag did not
work in the spike).

How should we validate subagent JSON output against these schemas, and how
should the same schemas drive the tool-parameter shape the model sees?

## Decision Drivers

- **Self-correction loop.** A malformed submission must feed validation errors
  back into the subagent session so the model can retry within budget
  (`maxAttempts`), not fail the whole run.
- **Accurate tool signature.** The model needs real field names, types, enums,
  and required/optional markers in `submit_result`'s parameters, not a generic
  untyped bag (a plain bag did not work in the spike).
- **Single source of truth.** Both the runtime gate and the tool-parameter
  shape must derive from the same schema objects (`assets.ts`) mechanically,
  so nothing needs to be hand-kept-in-sync.
- **Dependency footprint.** Preference for no third-party schema-validation
  library to track, if our actual schema usage is narrow enough to hand-roll.

## Considered Options

- **Hand-rolled JSON-Schema-subset validator** (chosen) — implement exactly
  the subset our schemas use, no dependency.
- **Adopt a JSON-Schema library (ajv, zod-to-json-schema, etc.)** — full
  keyword coverage and battle-tested edge cases, but adds a dependency and
  still requires a separate typebox/tool-schema projection step for the
  model — doesn't remove the two-representation problem, just the validator
  half of it.
- **Define schemas directly in typebox and derive JSON Schema from it** —
  would make typebox the source of truth instead of JSON Schema; rejected to
  keep the schemas themselves declarative/plain-JSON and reusable independent
  of any TS-specific schema library.
- **Skip agent-side validation, validate only once at the coordinator** —
  loses the in-session self-correction loop (the model never sees *why* its
  submission was rejected), so bad submissions would fail the whole subagent
  run instead of being retried within budget (`maxAttempts`).

## Decision Outcome

Chosen option: **hand-rolled JSON-Schema-subset validator**. Ship a small,
self-contained validator (`validate.ts`) instead of taking a JSON-Schema
library dependency. It implements exactly the subset our schemas use: `type`,
`required`, `enum`, `properties` (recursive), `items` (recursive),
`minItems`/`maxItems`. Everything else in JSON Schema
(`additionalProperties`, `pattern`, `format`, `oneOf`/`anyOf`/`allOf`,
`const`, numeric bounds, etc.) is intentionally not implemented.

The same function backs both call sites:
- **Agent-side gate**: `subagent.ts`'s `submit_result.execute` calls
  `validate(params, schema)`; on errors it throws (feeding the message back
  into the session for self-correction) and re-throws a terminal error once
  `maxAttempts` is exhausted.
- **Coordinator-side re-validation**: the coordinator (`coordinator.ts`)
  invokes `runSubagent` once per stage (orientation, seamMap, reviewer,
  synthesis, verifier), each with its own schema, so every stage's output is
  regated through the same `validate` on the way out of its subagent session.

`schema-typebox.ts`'s `toTypebox` converts the same JSON Schema objects into
typebox schemas, used only as the `submit_result` tool's `parameters` so the
model sees real field names, types, enums (via `StringEnum`), and
required/optional markers — it performs no validation itself.

`injectBounds` (`validate.ts`) mutates the loaded schema objects at startup to
inject config-driven `minItems`/`maxItems` (seam count bounds, max findings)
before they reach either `validate` or `toTypebox`, so both stay in sync
automatically.

### Consequences

- Good: the JSON Schema objects in `assets.ts` are the single source of
  truth: both the runtime gate and the tool-parameter shape derive from them
  mechanically. Nothing else needs to be hand-kept-in-sync.
- Good: no third-party schema-validation dependency to track.
- Good: because `toTypebox` and `validate` both recurse the same
  `properties`/`items` shape, a schema authored for one implicitly works for
  the other.
- Bad: correctness of the subset is entirely on us; adding a genuinely new
  constraint type is a two-file change (`validate.ts` + `schema-typebox.ts`),
  not a schema-only change.
- Bad: any unsupported JSON Schema keyword (e.g. `pattern`,
  `additionalProperties`) is silently ignored by `validate` — it will not
  error, it will simply not be checked. This is a known, accepted gap: no
  fallback or lint currently detects an unsupported keyword being added to a
  schema.
- Neutral: the `toTypebox`/`validate` coupling (both recursing the same
  shape) is implicit — duplicated recursion logic, not shared code — rather
  than enforced by types.

## More Information

- Related: [0001-orchestration-migration-to-custom-extension](0001-orchestration-migration-to-custom-extension.md),
  [0003-ts-python-coordinator-helper-contract](0003-ts-python-coordinator-helper-contract.md).
