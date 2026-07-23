---
status: accepted
date: 2026-07-23
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review]
---

# Orchestration migration to a custom pi extension

## Context and Problem Statement

`stacia-code-review` previously ran its coordination as a saved `pi-dynamic-workflows`
`workflow` tool call. That tool executes user scripts inside a Node `vm` sandbox with
no filesystem access. Because the coordinator script and its arguments could not read
anything off disk, every persona, JSON Schema, and config value had to be inlined by
value into a single tool-call payload (`workflow-script.js` + `args`), and the workflow
itself had to be pre-registered by name (`~/.pi/workflows`) to be invocable at all. That
forced a cascade of accreted scaffolding to route around the sandbox: a by-name
saved-workflow indirection, a `summon lint` drift check to keep the inlined copy in
sync with source, and an installed read-only `agentType` binding (`stacia-review-readonly.md`)
so subagents spawned by the workflow got a restricted toolset. None of this scaffolding
changed the review's behavior — it existed solely to compensate for the sandbox having
no `fs`.

How should the review's coordination be hosted so that personas, schemas, and config
can be read from disk directly, without workarounds for a sandboxed execution model?

## Decision Drivers

- The `vm` sandbox's lack of filesystem access forced every persona, schema, and
  config value to be inlined by value into a single tool-call payload.
- The saved-workflow-by-name mechanism required pre-registration in `~/.pi/workflows`
  before the coordination could be invoked at all.
- The inlined copy could drift from source, requiring a `summon lint` check to
  detect it.
- Restricting subagent tool access required an installed, separately-maintained
  `agentType` binding (`stacia-review-readonly.md`) rather than being expressible at
  the point of subagent creation.
- None of the above scaffolding changed the review's actual behavior — it existed
  solely to compensate for the sandbox having no `fs`.

## Considered Options

- **Re-host as a custom pi extension** running as ordinary Node with full filesystem
  access, retiring the pi-dynamic-workflows dependency for this review entirely
  (chosen).
- **Keep pi-dynamic-workflows, harden the workarounds** — continue layering fixes
  (inlined payload, saved-workflow registration, drift lint, installed binding) around
  the sandbox.
- **Port `code-review-workdir.py` to TypeScript as part of this move** — eliminate the
  cross-process boundary entirely in the same effort.
- **OS-level sandboxing (process- or container-per-subagent)** — isolate subagents via
  process/container boundaries instead of in-process session isolation.

## Decision Outcome

Chosen option: re-host the coordination as a purpose-built pi extension
(`extensions/stacia-code-review/`) that runs as ordinary Node with full filesystem
access, and retire the pi-dynamic-workflows dependency for this review entirely. The
review's topology, personas, schemas, and bounds are ported unchanged — this is a
re-host of the substrate, not a redesign of the review.

The extension's `code_review` tool is called once by the host model after it has
conducted the scope + charge conversation (charge is a required, non-inferred input;
the tool refuses to run without one). `execute()` then owns the whole run:

- **Pipeline** — comprehension (orient×2 in parallel → reconciler merges into a bounded
  orientation + priority-ranked seam map) → review (six perspective reviewers in
  parallel, each an internal K-round loop, K=3, that pulls detail on demand and returns
  capped findings + a spillover flag) → synthesis (consolidate, charge verdict, seam
  accounting, follow-up signal) → verification (Blocker/Major findings independently
  confirmed, corrected, or dismissed, in parallel).
- **Subagents** — each is one `createAgentSession` with a fresh in-memory
  (`SessionManager.inMemory()`) session: a fully isolated context, granted only
  `read`/`grep`/`find`/`ls` plus a per-session `submit_result` conformance-gate tool
  (no `bash`/`edit`/`write`). All fan-out (orienteers, the six reviewers, verifiers)
  runs through a coordinator-owned concurrency-capped promise pool
  (`pool.ts`, default concurrency 6), not workflow-engine `phase()`/`parallel()`
  primitives.
  - `submit_result` validates each agent's payload against its JSON Schema with the
    extension's own validator; invalid submissions return structured errors and the
    agent self-corrects in the same session (capped at `maxSubmitAttempts = 3`); a
    valid submission is captured and the turn is terminated. The coordinator
    re-validates every captured payload independently.
- **Failure handling** — fail-fast where continuation is meaningless (comprehension
  aborts if both orienteers fail, or if the reconciler produces no seam map); a global
  `AbortSignal` (wired to every session and to the `code-review-workdir.py`
  subprocess) plus per-agent abort give cancel-all and kill-one, both handled as the
  same failure/timeout path the pipeline already models (retry within budget, or
  degrade the seam to under-explored / raise spillover) rather than as a special case.
- **I/O** — `code-review-workdir.py` (invoked as a subprocess) remains the sole owner
  of run-dir allocation, diff-bundle capture/annotation, staging reference material
  (e.g. ADRs) into the context store, and writing findings/`report.md`/`report.html`.
  The coordinator reads bundles, personas, schemas, config, and staged context
  straight off disk to assemble prompts; it does not reimplement diff capture or
  report rendering.

The rejected alternatives:

- **Keep pi-dynamic-workflows, harden the workarounds** — rejected. The
  inlined-payload / saved-workflow / drift-lint / installed-binding stack was
  fragility layered on fragility; each fix added more scaffolding around a sandbox
  that fundamentally cannot read files, rather than removing the root cause.
- **Port `code-review-workdir.py` to TypeScript as part of this move** — rejected for
  this effort (explicit non-goal). Reuse-as-subprocess was sufficient and kept the
  change scoped to the coordination substrate; a port remains a possible future
  cleanup.
- **OS-level sandboxing (process- or container-per-subagent)** — rejected. The SPEC's
  isolation requirement is a fully isolated in-process context per agent, not strict
  process isolation; `createAgentSession` with a fresh in-memory session manager
  meets that bar without the overhead of process-per-agent.

### Consequences

- Good: the `workflow` tool call, `workflow-script.js`, and its inlined args payload
  are retired: personas/schemas/config are now file reads, not values threaded through
  a tool-call argument.
- Good: the saved-workflow-by-name registration, the `~/.pi/workflows` artifact, and
  the `summon lint` drift check that guarded the inlined copy are gone.
- Good: the `stacia-review-readonly.md` `agentType` binding and its `summon setup`
  install step are gone; read-only is now enforced inline at each subagent's session
  creation.
- Good: the extension couples to a small, named pi SDK surface (`createAgentSession`,
  `ModelRuntime`, `defineTool`/tool registration, session `.subscribe`, `ctx.ui`) and
  to no other extension; it depends on no workflow engine, typebox-based structured
  output, or provider-specific structured-output plumbing.
- Neutral: `SPEC.md` + `architecture.md` under
  `_code_review/specs/spec-code-review-coordinator-extension/` are now the single
  authoritative contract for this coordination substrate; `skills/stacia-code-review/SKILL.md`
  documents how to drive it and defers design-of-record questions to that spec pair
  and to this ADR series.
- Bad: the coordinator now owns liveness/monitor plumbing (registry, pinned widget,
  drill-in overlay, `f8` keybinding) that a workflow-hosted run got for less
  first-party code; this is accepted as the price of removing the sandbox.

## More Information

Related ADRs in this series (same effort, same date):
[0002-trust-gated-per-role-model-config](0002-trust-gated-per-role-model-config.md),
[0003-ts-python-coordinator-helper-contract](0003-ts-python-coordinator-helper-contract.md),
[0004-handrolled-schema-subset-validator](0004-handrolled-schema-subset-validator.md).
