---
status: accepted
date: 2026-07-27
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review]
---

# Re-host the coordinator on the Claude Agent SDK

## Context and Problem Statement

The pi harness is being abandoned entirely. `stacia-code-review` — the
orchestrated, read-only, multi-perspective review coordinator that
[ADR-0001](0001-orchestration-migration-to-custom-extension.md) built as a pi
extension — needs a new host. No backwards compatibility with pi is required.
The review's *behavior* (the four-stage pipeline, the personas, the schemas,
the bounds) is preserved; only the substrate changes.

This code has migrated once already, and the reason it migrated constrains
where it can land. ADR-0001 moved the coordination off `pi-dynamic-workflows`
because that engine ran user scripts inside a Node `vm` with no filesystem
access. With no `fs`, every persona, JSON Schema, and config value had to be
inlined by value into a single tool-call payload, the workflow had to be
pre-registered by name to be invocable, a `summon lint` drift check was needed
to keep the inlined copy in sync with source, and subagent tool restriction had
to be expressed as a separately-installed `agentType` binding. ADR-0001's own
summary of that scaffolding:

> "None of this scaffolding changed the review's behavior — it existed solely
> to compensate for the sandbox having no `fs`."

Claude Code's Workflow tool has the **identical** constraint — no `fs`, no Node
APIs — and one additional one: it cannot invoke the Python helper that
[ADR-0003](0003-ts-python-coordinator-helper-contract.md) makes the sole owner
of run-dir allocation, diff capture, and report writing. Choosing it would
re-create exactly what ADR-0001 removed, plus lose the helper.

Where should the coordination be hosted so that ADR-0001's property — personas,
schemas, and config are read from disk directly — is preserved, and the
pipeline's control flow stays real code?

## Decision Drivers

- **ADR-0001's win must not regress.** Personas, schemas, and config must stay
  file reads, not values threaded through a tool-call argument with a drift
  lint guarding the copy.
- **The Python helper must remain invocable as a subprocess.** ADR-0003's
  boundary — the orchestrating model never handles raw diff bytes or filesystem
  paths — depends on `execFile("python3", …)` being available to the host.
- **The pipeline's control flow is real code, not prose.** The per-perspective
  K-round loop, fail-fast on comprehension failure, merge-by-key accumulation,
  the concurrency-capped pool, and schema-retry are behaviors a model may or
  may not follow if they are only described; they are guarantees when they are
  executed.
- **Read-only enforcement must be expressible at the point of subagent
  creation**, not as a separately-installed artifact (ADR-0001).
- The live monitor needs *somewhere* to render (see
  [ADR-0008](0008-own-the-terminal-for-live-monitor.md)).
- No pi compatibility is required, so a clean re-host is on the table.

## Considered Options

- **Claude Agent SDK app, front-ended by a Claude Code plugin** (chosen) —
  ordinary Node with full `fs` and `child_process`; the plugin provides the
  entry point and the scope + charge conversation.
- **Claude Code Workflow tool script** — rejected for exactly the reason
  ADR-0001 gives. Same `vm`-with-no-`fs` sandbox, same forced inlining of
  personas/schemas/config, same drift-lint requirement, and additionally no way
  to reach `code-review-workdir.py`. This is ADR-0001's regression, re-bought.
- **Pure model-driven Claude Code plugin** (a skill plus subagent definitions,
  no first-party orchestration code) — the K-round loop, fail-fast,
  merge-by-key, concurrency cap and schema retry all degrade from executed
  guarantees into prose instructions the model may not follow. The bounds are
  the product here; making them advisory defeats the review.
- **Stay on pi** — off the table; the harness is being abandoned.

## Decision Outcome

Chosen option: **re-host the coordination as a Claude Agent SDK application**
(`plugins/stacia-code-review/coordinator/`), front-ended by a Claude Code
plugin (`plugins/stacia-code-review/.claude-plugin/plugin.json` and its
`stacia-code-review` skill). The SDK app is ordinary Node with full `fs` and
`child_process` — the exact property ADR-0001 bought — so personas, schemas,
config, bundles, and staged context stay direct file reads, and the Python
helper stays a subprocess.

The plugin's front-end skill owns the scope + charge conversation (charge
remains a required, non-inferred input) and then hands off to the coordinator
process via a private JSON request file and a launcher script. The
coordinator owns the run: comprehension → review → synthesis → verification,
unchanged.

**What ported unchanged.** The harness-agnostic modules moved across untouched,
along with their vitest suites, which is what proves the move was mechanical:
`pool.ts`, `validate.ts` (ADR-0004), `confine-path.ts`, `monitor-state.ts`,
`assets.ts`, `config.ts`, `models.ts`, and `helper/**` + `assets/**` in their
entirety. `coordinator.ts`'s pipeline topology ports essentially untouched;
only `runSubagent`'s signature and model resolution change.

**What changed shape.**

| pi mechanism | Claude Agent SDK | Note |
|---|---|---|
| `createAgentSession` per subagent | one `query()` per subagent, with its own `systemPrompt` / `model` / `tools` | direct analogue |
| `noTools:"builtin"` + `customTools` | `tools: ["Read","Grep","Glob"]` | equivalent |
| `submit_result` tool + typebox schema + hand-rolled retry (`maxSubmitAttempts`) | `outputFormat: { type: "json_schema", schema }` | simpler; `schema-typebox.ts` deleted outright — it existed only because pi's `defineTool` wanted typebox, while the five schemas are plain draft-07, which is what `outputFormat` accepts |
| `confine.ts` tool-definition wrapper | a `canUseTool` callback | **strictly stronger** — see below |
| `rt.getModel(provider, id)` on `"provider/id"` | `options.model`, a bare model id | config format changes |
| `session.abort()` / `cancelAll()` | one `AbortController` per `query()`, fanned out from a parent | equivalent |
| `session.subscribe(cb)` | iterate the async generator | small rewrite |
| `ctx.ui.setWidget` / `ctx.ui.custom` / `f8` | nothing | → ADR-0008 |
| `ctx.isProjectTrusted()` | nothing | → ADR-0006 |
| `execFile("python3", …)` | unchanged | ADR-0003 intact |

**`canUseTool` is strictly stronger than the `confine.ts` wrapper it
replaces.** The pi guard wrapped four tool *definitions* and inspected
`params.path` on each; anything else — another parameter, another tool — was
outside its reach by construction. `canUseTool` is a single callback invoked
for every tool call, with every parameter of that call. The guard's decision
logic (`confine-path.ts`'s `canonical()` / `within()`) is unchanged and still
sound; it simply now sees the whole surface instead of a slice of it, and its
denial message is returned to the subagent rather than thrown past it.

The rejected alternatives:

- **Workflow tool script** — rejected. It reintroduces the inlined-payload /
  drift-lint stack ADR-0001 removed, and cannot reach the Python helper at all.
  Nothing about the constraint has changed between the two harnesses; only the
  vendor has.
- **Pure model-driven plugin** — rejected. It trades executed bounds for
  described bounds. The recall-honesty guarantee (cleared vs. under-explored),
  the finding caps, and fail-fast on comprehension failure are only worth
  anything if they cannot be talked out of.

### Consequences

- Good: ADR-0001's central property survives the harness change intact —
  personas, schemas, and config are still ordinary file reads, with no inlined
  payload, no by-name pre-registration, and no drift lint to keep a copy in
  sync.
- Good: ADR-0003's contract survives untouched. The Python helper is still
  spawned with `execFile`, still owns every path/mkdir/write, and the manifest
  and CLI surface are unchanged — the boundary is harness-agnostic and did not
  participate in this move.
- Good: roughly 120 lines are deleted — the `submit_result` conformance-gate
  tool, its typebox schema translation layer, and the hand-rolled retry loop
  all collapse into one `outputFormat` option; `schema-typebox.ts` and the
  `typebox` / `@earendil-works/pi-ai` dependencies go with them.
- Good: the guard surface widens from four tools' `path` parameter to every
  parameter of every tool call.
- Good: the coordinator's own process is what makes the live monitor possible
  at all (ADR-0008).
- Neutral: the structured-output retry count stops being tunable. The SDK owns
  that loop, so `MAX_SUBMIT_ATTEMPTS` becomes an internal detail. Three
  distinct failure shapes must all be mapped to a `null` subagent result:
  `subtype === "error_max_structured_output_retries"`; `subtype === "success"`
  with `structured_output` absent; and `query()` throwing after yielding an
  error result.
- Neutral: schema *bounds* are no longer expressible in the schema the model
  sees. `maxItems` is unsupported and stripped; `minItems` supports only 0 and
  1, so the seam floor of 3 cannot be stated. Bounds fold into field
  descriptions and remain enforced locally by `validate.ts`, which stays
  authoritative (ADR-0004) — i.e. bounds degrade to validate-and-retry, which
  is what `submit_result` already did.
- Bad: **`allowedTools` silently bypasses `canUseTool`.** Three options look
  interchangeable and are not. `tools` is the restricting allow-list.
  `allowedTools` *auto-approves* and does not restrict. `canUseTool` is invoked
  only when the permission flow falls through to a prompt — **not** for calls
  auto-approved by `allowedTools`, by allow rules, or by `permissionMode`. So
  the natural-looking move of putting `Read`/`Grep`/`Glob` in `allowedTools` to
  suppress prompts **turns the path guard off, with no error and no log**.
  Restrict with `tools`; deliberately leave those tools out of `allowedTools`
  so they reach the guard.
- Bad: **`settingSources: []` is load-bearing, not hygiene.** Without it the
  user's `settings.json` allow-rules are honored and can auto-approve tool
  calls past `canUseTool`. This repository's own `.claude/settings.local.json`
  already carries `Read(...)` allow rules, so a guard tested here without
  `settingSources: []` would pass locally and be inert in the field. Any test
  of the guard must exercise it **through the real configured options object**,
  not by calling the callback directly.
- Bad: the coordinator is now a separate process with its own `node_modules`,
  its own lifecycle, and its own failure modes, which the plugin front-end has
  to launch and supervise (ADR-0008).
- Bad: model ids lose their provider component. `assets/config.json`'s five
  role values, the `config.schema.json` pattern that required a slash, and
  `validateModels`' `includes("/")` check all change shape. Fail-fast
  validation survives, but every existing configured value is invalid until
  migrated.

## More Information

- Supersedes: [0001-orchestration-migration-to-custom-extension](0001-orchestration-migration-to-custom-extension.md).
  ADR-0001's *rationale* is not superseded — it is the reason this option was
  chosen — only its choice of host.
- Related: [0003-ts-python-coordinator-helper-contract](0003-ts-python-coordinator-helper-contract.md)
  (unchanged by this move), [0004-handrolled-schema-subset-validator](0004-handrolled-schema-subset-validator.md)
  (still authoritative for bounds), [0006-drop-project-level-config-layer](0006-drop-project-level-config-layer.md)
  (the trust signal lost here), [0008-own-the-terminal-for-live-monitor](0008-own-the-terminal-for-live-monitor.md)
  (the host UI lost here).
