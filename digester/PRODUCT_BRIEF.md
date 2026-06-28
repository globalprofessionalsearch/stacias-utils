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

## The Pipeline (`digester run`)

`run` executes a five-stage pipeline:

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

Prints the ranked task list to the terminal. New-this-run tasks are marked with ★. Tasks carried forward from prior runs appear without a marker. The output is the same format as `digester show --detail`.

---

## Commands

### `digester run [--limit N]`

Runs the full pipeline. `--limit N` caps the number of new emails fetched, useful for testing. If no new emails are found but outstanding tasks exist, the current task list is displayed without running the pipeline.

### `digester show [--detail] [--max-done N]`

Displays the current task list without fetching email. Safe to run at any time.

**Default (concise) view** — one line per task:
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

`[N]` after a subject means N emails are grouped under that task.

**`--detail`** — shows sender and per-email links (OSC 8 clickable hyperlinks in supporting terminals).

**`--max-done N`** — controls how many done tasks appear at the bottom. Default: 5. Done tasks beyond the cap are hidden with a hint showing the exact flag to see all. Rank numbers for hidden done tasks are still valid for `set`.

The header count shows only active + pending tasks (not done).

### `digester set RANKS STATUS`

Sets the status of one or more tasks. Immediately syncs the corresponding Gmail labels.

**RANKS** accepts:
- Single: `5`
- List: `1,3,5`
- Range: `2-8`
- Mixed: `1,3-5,8`

**STATUS**: `active`, `done`, or `pending`

**Behavior:**
1. Writes the new status to `state.json`
2. Connects to Gmail, resolves current IMAP sequence numbers for all affected messages
3. Removes the old status label (e.g. `digest/active`) and applies the new one (e.g. `digest/done`) in batched IMAP calls grouped by operation type
4. If Gmail update fails, reverts `state.json` and reports failure — the user's view and Gmail remain consistent
5. Confirmation is printed only after Gmail confirms success

Invalid ranks are reported individually. Tasks already at the requested status are noted separately. The command exits with a non-zero status if any rank was invalid.

**Gmail label mapping:**
- `active` → `digest/active`
- `done` → `digest/done`
- `pending` → no label (removes whichever status label was present)

### `digester auth slack`

Authenticate with Slack using OAuth. This is a one-time setup step.

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

**Token refresh:** Slack access tokens automatically refresh when they expire (typically after 12 hours). The refresh token is stored securely in `~/.config/digester/tokens.yaml` and used to obtain new access tokens without requiring re-authentication. If token refresh fails or the refresh token is revoked, you'll see a friendly error message asking you to re-run `digester auth slack`.

**First-time setup:**
1. Create a Slack app at https://api.slack.com/apps
2. Add the user scopes listed above under "OAuth & Permissions"
3. Add `http://localhost:9119/callback` as a redirect URL
4. Copy the Client ID to `SLACK_CLIENT_ID` in `.env`
5. Run `digester auth slack` and authorize in your browser

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
| `DAYS_BACK` | `30` | Lookback window for email fetch |
| `SLACK_DAYS_BACK` | `DAYS_BACK` | Lookback window for Slack messages (overrides DAYS_BACK for Slack) |
| `FILTER_THRESHOLD` | `0.5` | Min score to include an email |
| `GROUP_THRESHOLD` | `0.7` | Min score to join an existing task |
| `GROUP_BODY_LIMIT` | `500` | Body chars used during grouping |
| `PRIORITIZE_BODY_LIMIT` | `300` | Body chars used during prioritization |
| `DIGEST_SUBJECT_LIMIT` | `60` | Max subject chars in detail/deliver view |
| `QWEN_URL` | `http://localhost:8099/v1/chat/completions` | Local LLM endpoint |
| `QWEN_MODEL` | `/Users/joe/models/qwen3.6-35b` | Model path |
| `QWEN_TEMPERATURE` | `0.0` | LLM temperature (deterministic by default) |
| `MAX_SCORE_RETRIES` | `3` | Retry attempts on malformed LLM output |

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
