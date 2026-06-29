# Digester — Product Brief

## What It Is

Digester is a local command-line tool that reads a Gmail inbox, identifies emails that require the user's attention, groups related emails into tasks, prioritizes those tasks by urgency, and presents a ranked digest. It is designed to replace the act of manually triaging email by surfacing only the items that genuinely need a response or decision.

All intelligence runs locally via a self-hosted LLM (Qwen). No email content is sent to a cloud API. State is persisted in a local `state.json` file.

---

## Core Concepts

### Emails vs. Tasks

An **email** is a single message fetched from Gmail. A **task** is a logical unit of work that one or more emails collectively represent — for example, a pull request that generated three separate notification emails is one task, not three. The user works with tasks, not raw emails.

### Task Status

Every task has one of three statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Default. Needs attention. |
| `active` | The user is actively working on it. |
| `done` | Addressed. Drops to the bottom of the list and is capped in display. |

Status is set manually by the user via the `set` command. It persists across runs.

### Rank

Tasks are displayed in a ranked list. Rank is **not stored** — it is computed fresh each time from the current sorted order: active first, then pending, then done; priority-descending within each group. Rank numbers are stable between `show` and `set` as long as no `run` has occurred in between.

---

## The Pipeline

Processing a run executes the pipeline:

```
Fetch → Filter → Group → Prioritize → Label → Deliver
```

### 1. Fetch

Connects to Gmail via IMAP. Fetches all emails from the last N days (default: 30) that haven't been seen before. Uses two batched IMAP calls — one for headers across all messages, one for full bodies of only the unprocessed subset — to minimize round-trips. Emails already in `state.json` (by Message-ID) are skipped.

### 2. Filter

Each new email is scored against every configured category using the local LLM. The email is assigned to the highest-scoring category that exceeds a threshold (default: 0.5). Emails that don't meet the threshold for any category are marked as skipped.

Categories are defined in `criteria.yaml` and currently include:
- `pull_request` — PRs that directly involve the user
- `opinion_request` — requests for architectural or technical input
- `topic_sensitive` — PRs or mentions touching security, auth, data contracts, safety signals
- `repo_notification` — activity in specific monitored repositories

### 3. Group

Filtered emails are grouped into tasks. Each new email is scored against every existing task's representative email. If the similarity score exceeds a threshold (default: 0.7), the email joins that task. Otherwise a new task is created.

Importantly, **outstanding tasks from prior runs are pre-seeded** before grouping begins. This means a follow-up email to a PR from a previous run will correctly join the existing task rather than creating a duplicate.

Done tasks are not currently seeded (a known gap — a new email matching a done task will create a new task rather than resurrecting the old one).

### 4. Prioritize

Tasks are sorted by urgency using pairwise LLM comparisons. Each comparison asks: "Is task A more urgent than task B?" The LLM returns a float in [-1, 1]; the sign determines ordering. This produces a total ordering across all tasks via Python's `cmp_to_key` sort.

Urgency factors (configured in `criteria.yaml`): whether a real person is blocked, shipping impact, recency, and whether the ask is explicit vs. passive.

Priority scores are stored per task as a float and used to maintain order on subsequent `show` calls between runs.

### 5. Label

New emails are labeled in Gmail via batched IMAP STORE commands. Each email receives two labels:
- `digest/seen` — marks it as processed
- `digest/category/<name>` — the assigned category (e.g. `digest/category/pull_request`), or `digest/skipped` if filtered out

Label operations are batched by label type to minimize IMAP round-trips.

### 6. Deliver

Prints the ranked task list to the terminal. New-this-run tasks are marked with ★; tasks carried forward from prior runs appear without a marker. The output uses the same detailed format as the digest view.

---

## Commands

The CLI is organized around a handful of intents. Exact keywords and flags may
evolve — run the tool with `-h` for current syntax. The operations below are the
stable surface.

### View the digest

The primary operation renders the current ranked task list without fetching
anything, so it is safe to run at any time. It offers a concise mode (one line
per task) and a detail mode (adds sender and per-message links, as OSC 8
clickable hyperlinks in supporting terminals). Options control how many `done`
tasks are shown and whether the view is restricted to tasks from the most recent
run. A machine-readable mode emits JSON instead of the rendered view.

The header count shows only active + pending tasks. `done` tasks beyond the
display cap are hidden with a hint showing how to reveal them; their rank numbers
remain valid for status changes. `[N]` after a subject means N messages are
grouped under that task.

**Concise view** — one line per task:
```
╔══════════════════════════════════════════════════════╗
║  DIGESTER  ·  3 tasks                                ║
╚══════════════════════════════════════════════════════╝

▶ ACTIVE ───────────────────────────────────────────────
  #1   TOPIC_SENSITIVE    SAML SSO PR needs review

  PENDING ──────────────────────────────────────────────
  #2   PULL_REQUEST       Analysis-mono PR #55 review…   [3]
  #3   OPINION_REQUEST    What's your take on Kafka?

✓ DONE ─────────────────────────────────────────────────
  #4   PULL_REQUEST       PR #88 merged

  ... 12 more done  ·  --max-done=16 to show all
```

### Inspect a single task

Selecting a task by its rank number shows full detail for that task: every
constituent message, senders, links, age, and originating source.

### Change task status

One or more tasks — addressed by rank — can be set to `active`, `done`, or
`pending`. The rank selector accepts a single value, a comma-separated list, a
range, or a mix (e.g. `5`, `1,3,5`, `2-8`, `1,3-5,8`).

The change is written to local state and then reflected back to each originating
source's labels. The two are kept consistent: if the source sync fails, the
local state change is reverted and the failure reported, so the digest view and
the source never disagree. Invalid ranks are reported individually; tasks
already at the requested status are noted separately.

`pending` is the absence of a status label — applying it removes whichever status
label was present. Source-specific details of how status maps to labels live in
the source, not the pipeline.

### Process new messages

The processing run executes the full pipeline (see above). Options cap the
number of messages (useful for testing) and restrict fetching to a single
source. If nothing new is found but outstanding tasks exist, the current list is
shown without reprocessing.

This is the only operation that contacts the LLM. If the local model server is
not reachable, the run offers to start it (see *Local model server* under
Configuration).

### Authenticate a source

Sources that require OAuth (currently Slack) have a one-time browser-based
authentication step.

**Requirements:**
- A Slack app with user token scopes (see below)
- `SLACK_CLIENT_ID` in `.env`

**User scopes required:**
- `search:read` — search for mentions
- `channels:read`, `channels:history` — read public channel messages
- `groups:read`, `groups:history` — read private channel messages
- `im:read`, `im:history` — read direct messages
- `mpim:read`, `mpim:history` — read group DMs
- `users:read` — resolve user IDs to display names

**Token refresh:** Slack access tokens automatically refresh when they expire (typically after 12 hours). The refresh token is stored securely in `~/.config/digester/tokens.yaml` and used to obtain new access tokens without requiring re-authentication. If token refresh fails or the refresh token is revoked, you'll see a friendly error message asking you to re-authenticate the source.

**First-time setup:**
1. Create a Slack app at https://api.slack.com/apps
2. Add the user scopes listed above under "OAuth & Permissions"
3. Add `http://localhost:9119/callback` as a redirect URL
4. Copy the Client ID to `SLACK_CLIENT_ID` in `.env`
5. Run the source authentication command and authorize in your browser

---

## Configuration

### `criteria.yaml`

The primary tuning surface. Defines:
- **filter categories**: description, keyword signals, examples (include), counter-examples (exclude with reasons)
- **group criteria**: description, dimensions, examples of same-task pairs, counter-examples of different-task pairs
- **prioritize criteria**: description of urgency, dimensions, examples of A-more-urgent-than-B pairs

All criteria are injected verbatim into LLM prompts as the system message. Example/counter-example ordering matters: earlier entries have stronger influence (primacy bias for examples; recency bias for counter-examples since they appear closest to the query).

### Environment Variables (`.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMAIL` | — | Gmail address |
| `APP_PASSWORD` | — | Gmail app password |
| `SLACK_CLIENT_ID` | — | Slack app client ID (required for Slack auth + token refresh) |
| `DAYS_BACK` | `30` | Lookback window for message fetch |
| `SLACK_DAYS_BACK` | `DAYS_BACK` | Lookback window for Slack messages (overrides DAYS_BACK for Slack) |
| `FILTER_THRESHOLD` | `0.5` | Min score to include a message |
| `GROUP_THRESHOLD` | `0.7` | Min score to join an existing task |
| `GROUP_BODY_LIMIT` | `500` | Body chars used during grouping |
| `PRIORITIZE_BODY_LIMIT` | `300` | Body chars used during prioritization |
| `DIGEST_SUBJECT_LIMIT` | `60` | Max subject chars in the rendered digest |
| `QWEN_URL` | `http://localhost:8099/v1/chat/completions` | Local LLM endpoint (host/port also used for autostart + health checks) |
| `QWEN_MODEL` | `/Users/joe/models/qwen3.6-35b` | Model id/path sent in scoring requests |
| `QWEN_TEMPERATURE` | `0.0` | LLM temperature (deterministic by default) |
| `MAX_SCORE_RETRIES` | `3` | Retry attempts on malformed LLM output |
| `QWEN_SERVER_CMD` | — | Launch command (e.g. `…/venv/bin/python -m mlx_lm server`); enables autostart when set |
| `QWEN_SERVER_BIN` | — | Legacy fallback: path to a single server binary (prefer `QWEN_SERVER_CMD`) |
| `QWEN_LAUNCH_MODEL` | — | Model id passed when launching the server; enables autostart when set |
| `QWEN_CHAT_TEMPLATE_ARGS` | `{"enable_thinking":false}` | Launch args that suppress the model's reasoning preamble |
| `QWEN_STARTUP_TIMEOUT` | `180` | Seconds to wait for a launched server to become ready |
| `QWEN_SERVER_LOG` | `~/.cache/digester/mlx_server.log` | Where a launched server's output is written |

### Local model server

All scoring runs against a local LLM server; nothing is sent to a cloud API.
A processing run first health-checks the configured endpoint. If the server is
not reachable and autostart is configured (`QWEN_SERVER_BIN` and
`QWEN_LAUNCH_MODEL` set), the run offers to launch it, then waits until it is
ready before continuing. In non-interactive (JSON) mode it does not prompt and
instead reports that the server is unavailable. The view/inspect/status
operations never contact the LLM and run regardless of server state.

The launch model is configured separately from the request-time model id because
the two need not be identical (e.g. a registry id at launch vs. a local path at
request time). The launch command invokes the server venv's Python via
`-m mlx_lm server` rather than the installed console script: console-script
shebangs hard-code an absolute interpreter path and break if the venv is moved,
whereas a venv's `python` symlink survives relocation. Setup details for the
reference model server live in `docs/MLX_QWEN_SETUP.md`.

### Calibrating `criteria.yaml` with `/digester-calibrate`

`criteria.yaml` is only as good as its examples. The `/digester-calibrate` skill is an interactive Claude Code session that improves filter, group, and prioritize accuracy by grounding examples and counter-examples in real inbox emails rather than hypotheticals.

**Invoke it in Claude Code:**
```
/digester-calibrate
```

### Understanding decisions with `/digester-explain`

The `/digester-explain` skill is a diagnostic tool that analyzes why a task ranked where it did, or why a message was filtered out.

**Invoke it in Claude Code:**
```
/digester-explain
```

The skill will ask what you want explained. You can provide:
- A task rank number: "Why is task #7 ranked so low?"
- A general question: "Why didn't I see the email about API design?"
- A comparison: "Why did the Slack thread rank higher than the PR?"

The skill reads your current `state.json` and `criteria.yaml`, analyzes the target against prioritization rules, compares it to nearby tasks, and provides a detailed explanation of which urgency factors applied (blocked_human, shipping_impact, recency, explicit_ask).

**Use this when:**
- A task ranked unexpectedly high or low
- An important message was skipped
- You want to understand what drives prioritization
- You're deciding whether to adjust criteria or thresholds

The skill runs a two-phase session:

#### Phase 0 — Retrospective (last run)

Reads `state.json` and reconstructs the most recent run. Presents:

- **Included tasks** in priority order. For each, asks: was this correctly included? Was the category right? If the task had multiple grouped emails, was that grouping correct? Wrong answers become counter-examples; confirmed correct answers become examples (if the category is thin).
- **Borderline skipped emails** — filtered messages from work-relevant senders (`@github.com`, `@jeenie.com`, `@atlassian.net`) or subjects containing PR/review/mention keywords. False negatives found here are the highest-value output.
- **Priority ordering** — presents the full ranked list and asks whether the order feels right. Misorderings are captured as `prioritize` examples or counter-examples.

#### Phase 1–2 — Gmail quiz (new emails)

Fetches two pools of real inbox emails via the Gmail MCP:
- **Pool A** (decision zone): emails matching current filter signals — things that look like they might belong
- **Pool B** (likely negatives): recent inbox emails that don't match signals

The skill merges and shuffles both pools, then presents each as a card — subject, sender, date, 200-char body snippet — and asks: include or exclude? Include answers name a category; exclude answers optionally give a reason.

Pool A emails that score No are the most valuable: they define the false-positive boundary.

#### Phase 3–4 — Synthesis and write

All judgments from both phases are merged and translated into `criteria.yaml` changes. Before writing, the skill shows a diff summary and asks for approval.

**Critical: examples are generalized before writing.** Specific identifiers are stripped to ensure the model learns patterns, not names:

| Replace | With |
|---------|------|
| Teammate handles (`@mgornik`) | `[teammate]` |
| PR numbers (`PR #412`) | `#[N]` or omit |
| Ticket IDs (`YEL-1184`) | `[TICKET-ID]` or omit |
| Commit SHAs | omit |

Keep: repo names (they are signals), topic keywords (SAML, SSO, data contract), action verbs.

**Ordering rules (applied after every write):**

The criteria YAML becomes Qwen's system message; the email being scored is the user message. This has implications:

- `examples` — most representative/clearest include-case first. The first entry anchors the category's meaning.
- `counter_examples` — clearest exclusions first; most common false-positive patterns last. Counter-examples appear closest to the query in the prompt and get a recency boost — use that placement for the trickiest edge cases.

**When to run it:** 3–4 sessions over the first few days of use gives good coverage. After that, run it when you notice false positives (emails that shouldn't have been included) or false negatives (work-relevant emails that got skipped). Short sessions are better than infrequent long ones.

---

## State (`state.json`)

Flat JSON with three keys:

**`emails`** — keyed by RFC Message-ID. Each record stores subject, sender, received_at, category, task_id, skipped flag, seen flag, gmail_link, body_snippet. The `addressed` field is a legacy boolean (superseded by task status).

**`tasks`** — keyed by UUID. Each record stores category, created_at, priority (float), and status (`pending` | `active` | `done`).

**`warnings`** — list of LLM scoring failures with operation, payload excerpt, attempt count, and error message.

---

## Known Gaps

- **Done task resurrection**: If a new email arrives that matches a done task's thread, it creates a new task instead of reviving the done one. The intended behavior is resurrection. A TODO comment exists in `run_group()`.
- **Priority score comparability**: Priority scores are relative to the task set at the time of the run, not globally comparable. Done tasks sort by their stored priority within the done section, which may not reflect recency of completion.
- **No `done_at` timestamp**: The system does not currently record when a task was marked done, so the done section sorts by legacy priority rather than completion time.
