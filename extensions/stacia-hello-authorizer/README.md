# stacia-sieve-gate

A standalone **tool-call gate** for [pi](https://github.com/earendil-works/pi).
It replaces the `@gotgenes/pi-permission-system` authorizer-chain link entirely
— no dependency on that package — by hooking pi's own `tool_call` event.

## How it decides

Every tool call, before it runs, passes through:

```
tool_call
  ├─ 1. REJECTION sieve   (ordered rejecters; first veto wins)
  │        → block, with a reason + recommended alternative sent to the model
  ├─ 2. APPROVAL sieve    (ordered approvers; first permit wins)
  │        → run outright: no summary, no prompt
  └─ 3. fall-through
           → "haiku" writes one plain-language sentence describing the call
           → user sees the summary (primary) + raw command (secondary)
           → approve → run   |   deny → block ("user denied")
```

- A **rejecter** returns `{ reason }` to block; the reason is surfaced back to
  the calling model so it can self-correct (e.g. "split this into bash
  primitives").
- An **approver** returns `true` to permit the call with no further checks —
  haiku is skipped and the user is not asked.
- Anything that survives the rejecters and is claimed by no approver is
  summarized and put to the user.

Policy is **entirely code**: the two ordered arrays in `sieves.ts`. There is no
declarative policy file, no session-scoped "allow for the rest of the session",
and no subagent prompt forwarding (all of which the permission-system provided)
— every call is judged fresh.

## Files

| File           | Role                                                          |
| -------------- | ------------------------------------------------------------- |
| `index.ts`     | Wires the `tool_call` hook and runs the pipeline.             |
| `sieves.ts`    | `rejecters[]` and `approvers[]` — **edit these** to set policy. |
| `summarize.ts` | The one-shot "haiku" summary call (pi's bundled `complete()`).|
| `config.ts` / `config.json` | The summary model (`provider/id`).             |
| `logger.ts`    | Best-effort JSONL audit trail (one record per decision).     |
| `redact.ts`    | Ordered secret redactors applied to logged text.             |

## Configure the summary model

`config.json`:

```json
{ "summaryModel": "anthropic/claude-haiku-4-5" }
```

If the model can't be resolved or the call fails, the confirm prompt still
shows — with the raw command only, never auto-allowing.

## Install

Symlink into the pi extensions dir (auto-loaded per session):

```bash
ln -s "$PWD/extensions/stacia-hello-authorizer" \
  ~/.pi/agent/extensions/stacia-sieve-gate
```

No opt-in config step and no `authorizerChain` entry: hooking `tool_call` is the
activation. To disable, remove the symlink.

## Logging

Every decision appends one JSON line to:

```
~/.pi/agent/extensions/stacia-sieve-gate/logs/stacia-sieve-gate.jsonl
```

Each record carries `ts`, `outcome`
(`rejected` | `approved_by_sieve` | `user_approved` | `user_denied` |
`blocked_no_ui`), `toolName`, `toolCallId`, `detail` (command / compact input),
and, when relevant, `rule` (the sieve name that fired), `reason`, and `summary`.
Writes are best-effort — a logging failure never blocks a tool call.

**Redaction.** Before a record is written, `detail` and `summary` pass through
an ordered redactor pipeline (`redact.ts`) that masks known token shapes
(`gh*_`, `sk-`, `AKIA…`, JWTs, …), `Authorization`/bearer tokens, values after
risky flags (`--password`, `--token`, `--api-key`, …), sensitive `VAR=value`
assignments, and inline URL credentials. This is **heuristic, not a guarantee**
— an arbitrary command can hide a secret in a shape no rule anticipates. The
live confirm dialog is never redacted; only the on-disk log is.

```bash
tail -f ~/.pi/agent/extensions/stacia-sieve-gate/logs/stacia-sieve-gate.jsonl | jq .
```

## Notes / edges

- **No UI available** (e.g. non-interactive run): a fall-through call is
  **blocked**, not auto-allowed. Approve such calls via an approver rule if they
  must run unattended.
- **Latency/cost**: every call that reaches step 3 waits on one haiku round-trip
  before the prompt. Approvers short-circuit that for known-safe calls.
- The directory is still named `stacia-hello-authorizer` (its origin); rename
  the dir + symlink if you want it to match.
