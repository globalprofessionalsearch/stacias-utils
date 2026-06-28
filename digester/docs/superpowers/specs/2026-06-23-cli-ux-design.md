# CLI UX Redesign

**Date:** 2026-06-23
**Status:** Approved

---

## Context

The existing CLI is functional but clunky for daily use. Three separate commands (`show`, `detail`, `set`) require multiple invocations and verbose syntax to accomplish a simple triage session. The redesign makes the grammar opinionated — the concise form is the primary interface, not an alias — while remaining fully automation-friendly with `--json` output.

Automation compatibility requirement: no interactive prompting under any circumstance. All commands complete without waiting for user input.

---

## Typical workflow

```
digester                   # orient: see where things stand
digester run               # fetch new messages
digester --latest          # see what the run added
digester 3                 # read task 3 in depth
digester 4                 # read task 4 in depth
digester 3 done            # mark task 3 done
digester 4 active          # mark task 4 active
```

---

## Command grammar

### Default: list view

```
digester [--latest] [--max-done N] [--json]
```

No subcommand. Running `digester` with no arguments shows the ranked task list.

- `--latest` — filter to tasks created during the most recent `run`
- `--max-done N` — show N done tasks (default: 5)
- `--json` — emit JSON only, no human-readable output

### Run

```
digester run [--limit N] [--source SOURCE] [--json]
```

Unchanged behavior. Fetches messages, runs the pipeline, delivers the ranked list. With `--json`, suppresses pipeline stage output and emits a JSON summary on completion.

### Detail

```
digester <N> [--json]
```

`<N>` is a single rank number. Shows full detail for that task: all messages, contacts, age, links, body.

Multi-rank without a status argument is an error.

### Set status

```
digester <RANK_SPEC> done|active|pending [--json]
```

`<RANK_SPEC>` accepts: single (`5`), comma list (`1,3,5`), range (`2-8`), or mixed (`1,3-5,8`). Executes immediately without confirmation. Syncs labels to the originating source(s).

### Auth

```
digester auth slack
```

Unchanged.

---

## `--json` output shapes

All `--json` modes produce only JSON to stdout — no human-readable text is mixed in.

**List (`digester --json`):**
```json
{
  "tasks": [
    {
      "rank": 1,
      "id": "uuid",
      "status": "active",
      "category": "pull_request",
      "subject": "SAML SSO PR needs review",
      "age_hours": 2,
      "message_count": 3,
      "contacts": ["alice@example.com"],
      "is_latest": true
    }
  ],
  "summary": { "active": 1, "pending": 3, "done": 1 }
}
```

**Detail (`digester <N> --json`):**
```json
{
  "rank": 3,
  "id": "uuid",
  "status": "pending",
  "category": "pull_request",
  "messages": [
    {
      "subject": "...",
      "author": "...",
      "received_at": "2026-06-23T10:30:00Z",
      "url": "https://...",
      "body": "..."
    }
  ]
}
```

**Set status (`digester <N> done --json`):**
```json
{
  "changed":   [{ "rank": 3, "from": "pending", "to": "done" }],
  "unchanged": [],
  "invalid":   []
}
```

**Run (`digester run --json`):**
```json
{
  "new_tasks":        3,
  "updated_tasks":    1,
  "skipped_messages": 12,
  "tasks": [ ]
}
```

`tasks` in the run response has the same shape as the list response.

---

## `--latest` tracking

`last_run_at` is persisted to state at the end of each successful `run`. `--latest` filters to tasks whose `created_at >= last_run_at`.

Before any run has completed, `--latest` returns the full list (no filtering applied).

`--latest` and `--max-done` compose: `--latest` filters the task set first, then `--max-done` caps the done section within that filtered view.

---

## Discoverability

The list view (both `digester` and the output of `digester run`) ends with a one-line footer:

```
  <N> · <N> done / active / pending
```

No prose. Shows the two primary actions in the new command form.

---

## Removed

| Removed | Reason |
|---------|--------|
| `show` subcommand | Replaced by `digester` (no args) |
| `detail` subcommand | Replaced by `digester <N>` |
| `set` subcommand | Replaced by `digester <N> done/active/pending` |
| `show --detail` flag | Verbose all-tasks-with-links view dropped |
| `_confirm_multi_set` | Interactive confirmation incompatible with automation requirement |

No deprecation period. No hidden aliases. The new grammar is the grammar.

---

## Exit codes

- `0` — success
- `1` — any rank in a set operation was invalid, or no valid ranks were changed
