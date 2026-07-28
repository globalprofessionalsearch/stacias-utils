---
status: proposed
date: 2026-07-28
author: Stacia Colasurdo
tags: [plugins, hooks, poc]
---

# PoC: a Stop hook that reports Claude's response length back to Claude

**Nothing here is built.** This is a design worked out and then paused, written
down so it can be picked up cold. The research below cost more than the code
will — it is recorded verbatim so it does not have to be re-derived.

## Why

To exercise plugin **hooks**. `plugins/stacia/` uses none today; it ships only
skills. A hook that counts the lines in Claude's response and feeds the number
back to the model is small enough to be a genuine proof of concept and touches
the whole mechanism: event registration, `${CLAUDE_PLUGIN_ROOT}`, stdin/stdout
contract, and the recursion hazard.

The longer-range goal is a hook that speaks **only when warranted**. Line count
over a threshold is a placeholder for that predicate, not the destination.

## Shape

| Decision | Choice |
|---|---|
| Where the count goes | Back to **Claude**, via `hookSpecificOutput.additionalContext` |
| What is measured | The **final assistant message** only |
| Packaging | A hook on the existing **`stacia`** plugin, not a new plugin |
| Metric | `len(text.splitlines())` on the raw markdown |
| Predicate | Emit only when lines > `minLines` (default 10) |

**On the metric.** Raw newlines as authored, blank lines included — *not*
rendered lines, which vary with terminal width. A six-paragraph answer
separated by blank lines counts 11.

**On packaging.** A new plugin would need a marketplace entry and a
`summon setup` re-run. A hook on `stacia` needs neither: hooks ship with the
plugin, and it is already registered. The cost is that it is always-on wherever
`stacia` is installed — which is user scope, so everywhere. Hence `enabled` in
config.

## What the research established

The prose docs are truncated on this topic and `code.claude.com/docs/en/hooks-reference`
returns 404. **The Agent SDK's own type definitions are the authoritative
source.** They are not committed (`node_modules/` is gitignored) but land
locally the moment the coordinator's deps are installed — which
`plugins/stacia/skills/code-review/test.sh` does — at:

```
plugins/stacia/skills/code-review/coordinator/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

Line numbers below are from `@anthropic-ai/claude-agent-sdk@0.3.220` and will
drift with the version; grep the type name rather than trusting the number.

### The hook is handed the text — no transcript parsing

`sdk.d.ts:6771-6788`:

```ts
export declare type StopHookInput = BaseHookInput & {
    hook_event_name: 'Stop';
    stop_hook_active: boolean;
    /**
     * Text content of the last assistant message before stopping. Avoids the
     * need to read and parse the transcript file.
     */
    last_assistant_message?: string;
    /**
     * In-flight background work (running/pending + backgrounded) registered in
     * this session. Lets hooks distinguish "session is done" from "session is
     * paused waiting for background work to wake it". Empty array when nothing
     * is in flight.
     */
    background_tasks?: BackgroundTaskSummary[];
    /**
     * Session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop) that will
     * wake this session later. Empty array when none are scheduled.
     */
    session_crons?: SessionCronSummary[];
};
```

Note `last_assistant_message` is **optional**. The hook must tolerate absence.

Note also that this is the *last message*, not the whole turn. A turn with tool
calls contains several assistant messages; this is the final text block only.
Measuring the true turn total means reading `transcript_path` and summing back
to the last user message — deliberately out of scope, and the reason the emitted
wording should say "final assistant message", not "turn".

### `additionalContext` continues the conversation

This is the load-bearing fact. `sdk.d.ts:6790-6796`:

```ts
/**
 * Hook-specific output for the Stop event. additionalContext is non-error
 * feedback delivered to the model; the conversation continues so the model can
 * act on it.
 */
export declare type StopHookSpecificOutput = {
    hookEventName: 'Stop';
    additionalContext?: string;
};
```

Feeding something to the model *is* waking it up. There is no "tell Claude but
do not let it respond" — that is what distinguishes `additionalContext` from
`systemMessage`, which only shows the user a line and lets the turn end.

So the flow is:

```
you prompt
  Claude answers                      → Stop fires, stop_hook_active = false
    if lines <= minLines: silent, ends here
    else: hook emits count            → conversation CONTINUES
  Claude speaks again, reacting        → Stop fires, stop_hook_active = true
    hook silent                        → conversation ends
```

A long answer costs one extra turn; a short one costs nothing. Since most
substantive answers clear ten lines, expect the extra turn often.

**The threshold cannot replace the recursion guard.** The reaction turn could
itself exceed `minLines` and re-trigger. `stop_hook_active` is what actually
terminates the chain.

### The recursion guard, and its non-obvious caveat

`stop_hook_active` is the documented brake. The pattern is taken from the
official `security-guidance` plugin, at
`~/.claude/plugins/cache/claude-plugins-official/security-guidance/2.0.6/hooks/security_reminder_hook.py:1843-1853`,
including its own comment:

```python
# Recursion guard FIRST — consume_stop_state clears touched_paths, and CC
# sets stop_hook_active session-wide while any asyncRewake Stop is in
# flight, so a concurrent active=True fire winning the lock would discard
# paths the concurrent active=False fire needs.
if stop_hook_active:
    debug_log("Stop hook: stop_hook_active=True, skipping to avoid recursion")
    sys.exit(0)
```

**`stop_hook_active` is session-wide, not per-continuation-chain.** Concurrent
Stop fires can observe it set. Check it first, before config loading or any
other work.

### `Stop` fires on pauses too

Per `background_tasks` above, `Stop` fires when a session pauses waiting on
background work, not only when it is genuinely finished. This PoC does not
handle that, so it will occasionally measure a pause rather than an answer.
Worth knowing before reading the output as a clean per-prompt count.

## Files to add

### `plugins/stacia/hooks/hooks.json`

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/hooks/turn-length.py"
          }
        ]
      }
    ]
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin root (`plugins/stacia/`). Quoted
as in the official example — the installed path contains a version segment.

### `plugins/stacia/hooks/turn-length.py` (executable)

Python3, not bash + `jq`: python3 is already a hard dependency of this repo
(`summon lint`'s `check_marketplace`, the code-review helper), and it parses and
emits JSON without quoting hazards.

Logic, in order:

1. **Recursion guard.** `stop_hook_active` truthy → exit 0, no output. First
   check, before config or anything else.
2. Load config (shipped, then user override). `enabled: false` → exit 0.
3. No `last_assistant_message`, or empty → exit 0, no output.
4. `lines = len(text.splitlines())`. If `lines <= minLines` → exit 0, no output.
5. Emit:
   ```json
   {"hookSpecificOutput": {"hookEventName": "Stop",
                           "additionalContext": "final assistant message: 23 lines"}}
   ```
6. **Any exception → exit 0, no output.** A hook that throws fires on every
   turn, and a malformed config file must not break every conversation. Wrap
   the whole body.

### `plugins/stacia/hooks/config.json`

```json
{ "enabled": true, "minLines": 10 }
```

### `plugins/stacia/hooks/test.sh` (executable)

Pipes fixture JSON at the script and asserts stdout. Nothing else can test it.

## Config

Two layers, mirroring the code-review coordinator's `config.ts` so the repo has
one convention rather than two:

| Layer | Path | Notes |
|---|---|---|
| Shipped defaults | `plugins/stacia/hooks/config.json` | Committed |
| User override | `~/.claude/stacia-turn-length.json` | Optional; same shape, keys present override, keys absent fall through |

Deliberately simpler than the coordinator's: two flat keys, so a shallow merge
rather than `deepMerge`, and no JSON Schema. A missing or unparseable override
is ignored and falls through to defaults — the same posture as `readJsonSafe`.
An out-of-range `minLines` (non-integer, negative) falls back to the default
rather than erroring.

**Which layer you will actually edit.** Installs are snapshot *copies* into
`~/.claude/plugins/cache/…`, so editing the shipped `config.json` in the repo
changes nothing until reinstall. The user file at `~/.claude/` takes effect
immediately — that is the one to tune with while testing. The committed file
sets the default.

## Known gaps, accepted for a PoC

- **Not gated by the pre-commit hook or CI.** `.githooks/pre-commit:15` matches
  `^plugins/[^/]+/skills/[^/]+/`. A hook at `plugins/stacia/hooks/` does not
  match, so its `test.sh` never runs automatically. A one-line glob change
  would fix it; do not assume it is covered as written.
- **`summon lint` does not validate `hooks.json`.** The plugin contract checks
  the manifest and skill frontmatter only. `claude plugin validate --strict`
  does check it.
- **No marketplace change and no `summon setup` re-run needed** — but installs
  are snapshots, so the hook does not take effect until reinstall, or until
  Claude Code is pointed at the working tree with `--plugin-dir`.
- **Pauses are measured as answers**, per `background_tasks` above.

## Verification

1. Feed fixture JSON to the script for each case: over threshold (emits),
   at/under threshold (silent), `stop_hook_active: true` (silent even when
   long), missing `last_assistant_message`, malformed input JSON,
   `enabled: false`, malformed *config* file, out-of-range `minLines`.
   **Every path must exit 0.**
   Include the boundary explicitly — exactly `minLines` silent, `minLines + 1`
   emits — since an off-by-one there is the whole predicate.
   Point the user-config path at a fixture via an env var so the suite never
   reads the real `~/.claude/stacia-turn-length.json`.
2. `./plugins/stacia/hooks/test.sh` — the above as one runnable script.
3. `claude plugin validate ./plugins/stacia --strict` — the only tool that
   actually checks `hooks.json`.
4. `./summon/main lint` and `./summon/test` — must stay green. Neither knows
   about hooks; this confirms nothing regressed.
5. `./plugins/stacia/skills/code-review/test.sh` — 306 vitest + 5 Python,
   unaffected, as a regression check.
6. **Live check.** `claude --plugin-dir plugins/stacia` in a scratch directory.
   Provoke a *long* answer: expect exactly two assistant turns and one count,
   not an unbounded stream. Then provoke a *short* one: expect a single turn and
   no count. Those two prove the recursion guard and the predicate respectively,
   and no unit test substitutes for either.

## Rollback

`{"enabled": false}` in `~/.claude/stacia-turn-length.json` — immediate, nothing
committed. To remove properly, delete `plugins/stacia/hooks/` and reinstall.

## If picked up later

The obvious next question is what "warranted" should mean beyond line count.
The constraint to design against: **the hook can only choose whether to speak,
not how loudly.** There is no cheap channel — no way to log quietly and
separately decide to interrupt. Either it is silent, or it costs a full turn. So
the predicate has to be genuinely selective rather than a filter on a stream of
notifications.

The whole `StopHookInput` is available to that predicate — `transcript_path`,
`cwd`, `session_id`, `background_tasks`, `session_crons` — so it can eventually
be anything computable in a few hundred milliseconds.
