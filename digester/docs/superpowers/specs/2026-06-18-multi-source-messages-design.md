# Multi-Source Messages — Design Spec

**Date:** 2026-06-18
**Status:** Approved

---

## Overview

Digester currently processes email exclusively. This spec describes the changes required to generalize the system so it can process messages from any communication source — with Gmail and Slack as the two initial implementations.

The core change is replacing the email-specific concept with a source-agnostic **Message** schema and a **source protocol** that any fetcher can implement. The pipeline (filter, group, prioritize, deliver) operates on Messages and knows nothing about where they came from.

---

## Scope

**In scope:**
- Normalized Message schema
- Source protocol (fetch, sync_labels, sync_status)
- Email source refactor (imap_client.py → sources/email.py)
- Slack source (DMs, @mentions, participated threads)
- Slack PKCE OAuth flow (auth.py + `digester auth slack` command)
- Thread-identity grouping short-circuit in the group stage
- State migration (emails → messages)
- Display: show `channel` field in digest output

**Out of scope:**
- Watched channel fetching (general channel chatter)
- Slack write-back (reactions, bookmarks)
- Additional sources beyond email and Slack
- LLM-synthesized subject lines

---

## Message Schema

Defined in `message.py` as a `TypedDict`. Every source produces this shape; the pipeline consumes nothing else.

```python
class Message(TypedDict):
    id: str            # globally unique — email message-id, or "slack:{channel_id}:{ts}"
    source: str        # "email" | "slack"
    subject: str       # pipeline anchor — email subject, or "#channel: first 80 chars of body"
    author: str        # human-readable sender
    body: str          # plain text content
    timestamp: str     # ISO 8601
    url: str           # clickable link in digest
    thread_id: str     # groups related messages; "" if standalone
    channel: str       # logical origin — "inbox", "#channel-name", "@username"
    is_direct: bool    # addressed specifically to the user (DM, direct email)
    mentions_me: bool  # user explicitly named or tagged
    raw: NotRequired[dict]  # original API payload, for debugging
```

**Design rule:** every field is expressed in terms meaningful to the pipeline. No source-internal identifiers (IMAP sequence numbers, Slack timestamps, channel IDs) appear here.

---

## Source Protocol

Each source is a Python module that exposes the following:

```python
SOURCE_NAME: str  # e.g. "email", "slack"

def fetch(settings: dict, processed_ids: set[str]) -> list[Message]:
    """Connect to the source, retrieve new messages, normalize to Message schema.
    Excludes any message whose id is in processed_ids."""

def sync_labels(messages: list[Message], settings: dict) -> None:
    """Write category/seen labels back to the source after a pipeline run.
    No-op for sources that do not support write-back."""

def sync_status(message_ids: list[str], old_status: str, new_status: str, settings: dict) -> None:
    """Reflect a task status change (active/done/pending) back to the source.
    No-op for sources that do not support write-back."""
```

**Protocol rules:**
- Sources manage their own connection lifecycle entirely
- Sources may maintain internal state (e.g. id → source-internal-id mappings) that is never exposed to the pipeline
- `sync_labels` and `sync_status` must be safe to call with an empty message list
- A source that fails to sync must not corrupt pipeline state — sync failures are reported but do not roll back task or message records

**Source discovery:** `digester.py` loads the email source always. It loads the Slack source if a Slack token is present in `~/.config/digester/tokens.yaml`. No additional configuration is required to activate a source.

---

## Email Source (`sources/email.py`)

Refactor of `imap_client.py`. Logic is unchanged; the output is normalized to the Message schema.

**Normalization mapping:**

| Message field | Source |
|---|---|
| `id` | RFC `Message-ID` header |
| `source` | `"email"` |
| `subject` | `Subject` header |
| `author` | `From` header |
| `body` | Plain text body |
| `timestamp` | `Date` header → ISO 8601 |
| `url` | Gmail web link (`https://mail.google.com/mail/u/0/#inbox/{id}`) |
| `thread_id` | First value of `In-Reply-To` or `References` header; own `id` if neither present |
| `channel` | `"inbox"` |
| `is_direct` | `True` (all inbox email is addressed to the user) |
| `mentions_me` | `True` |

**Internal state:** maintains a `dict[str, str]` mapping `id → imap_id` (IMAP sequence number). Used exclusively by `sync_labels` and `sync_status`. Never exposed outside the module.

**sync_labels:** applies `digest/seen` and `digest/category/{name}` labels (or `digest/skipped`) via batched IMAP STORE. Identical to current `run_label` behavior.

**sync_status:** applies/removes `digest/active` and `digest/done` labels via batched IMAP STORE. Identical to current `set` command Gmail sync behavior.

---

## Slack Source (`sources/slack.py`)

New module. Uses the `slack-sdk` Python package with a user token (`xoxp-`).

### Fetch strategy

Three queries are run in sequence. Results are deduplicated by `id` before returning.

**1. Direct messages**
- `conversations.list?types=im,mpim` — enumerate all DM and group DM channels
- `conversations.history?channel={id}&oldest={days_back_ts}` — fetch messages per channel
- Exclude any message whose `id` is in `processed_ids`

**2. @mentions**
- `search.messages?query=<@{user_id}> after:{days_back_date}&sort=timestamp&count=100`
- Exclude processed

**3. Participated threads**
- `search.messages?query=from:@me after:{days_back_date}&sort=timestamp&count=100`
- For each result, fetch the full thread via `conversations.replies?channel={id}&ts={thread_ts}`
- Surface messages from others that arrived *after* the user's most recent message in the thread — these are replies the user has not yet responded to
- Exclude any message whose `id` is in `processed_ids`

### Normalization mapping

| Message field | Source |
|---|---|
| `id` | `"slack:{channel_id}:{ts}"` |
| `source` | `"slack"` |
| `subject` | `"#{channel_name}: {first 80 chars}"`, stripping `<@mentions>` and newlines |
| `author` | User display name (resolved from user ID via `users.info`) |
| `body` | Message text (Slack mrkdwn, not converted) |
| `timestamp` | Slack `ts` (unix epoch string) → ISO 8601 |
| `url` | `permalink` field from search results; fetched via `chat.getPermalink` for direct history results |
| `thread_id` | `thread_ts` if message is in a thread; own `ts` if it is the thread root |
| `channel` | `"#{channel_name}"` for public/private channels; `"@{display_name}"` for DMs |
| `is_direct` | `True` if conversation type is `im` or `mpim` |
| `mentions_me` | `True` if body contains `<@{user_id}>` |

**sync_labels:** no-op. Slack has no label system.

**sync_status:** no-op.

### Required OAuth scopes (user token)

```
search:read
channels:read
channels:history
groups:read
groups:history
im:read
im:history
mpim:read
mpim:history
users:read
```

---

## Auth (`auth.py`)

Python port of the PKCE OAuth flow from the predecessor project. Supports any OAuth2 provider that requires PKCE and an HTTPS redirect URI.

**Flow:**
1. Generate PKCE verifier and challenge (S256)
2. Start a local HTTPS server on port 9119 using a self-signed certificate (required by Slack)
3. Open the browser to the provider's authorization URL with the PKCE challenge and requested scopes
4. Receive the authorization code via the `/callback` handler
5. Exchange the code for a token (Slack's token endpoint returns `authed_user.access_token` in a non-standard envelope — the auth module handles the unwrapping)
6. Write the token to `~/.config/digester/tokens.yaml`

**Token storage:** `~/.config/digester/tokens.yaml`, permissions `0600`. Stored outside the project directory so it is never committed. Format mirrors the whoneedsme predecessor:

```yaml
sources:
  slack:
    token:
      access_token: xoxp-...
      token_type: user
      expiry: "0001-01-01T00:00:00Z"
```

**CLI command:** `digester auth slack` drives the flow. On success, prints confirmation. On failure, prints the error and exits non-zero.

**Token reading:** `sources/slack.py` reads the token from `~/.config/digester/tokens.yaml` on each `fetch()` call. If the file or token is absent, `fetch()` raises a clear error directing the user to run `digester auth slack`.

---

## Pipeline Changes

### Filter

Field name updates only: `em['sender']` → `msg['author']`. LLM payload format and all scoring logic unchanged.

### Group

One new fast path before LLM comparison:

```
for each message:
  1. if thread_id is non-empty AND matches the thread_id of any existing task's messages
     → assign to that task immediately (no LLM call)
  2. otherwise → LLM pairwise comparison as today
```

The short-circuit applies against both the current run's tasks and seed tasks from prior runs. A Slack reply to an existing open task thread is grouped deterministically.

No changes to LLM payload format or thresholds.

### Prioritize

Field name updates only. LLM payload and comparison logic unchanged.

### Sync (replaces `run_label`)

`digester.py` groups processed messages by `source` and calls each source's `sync_labels`. For the `set` command, messages in the affected task are grouped by `source` and routed to `sync_status` per source.

### Deliver

The `channel` field is shown in the detail view alongside the category and subject. It is rendered as-is — the display layer does not interpret or reformat it. In the concise view it is omitted to preserve line width.

---

## State Migration

`db.py` applies a one-time migration on first load after the update:

1. If `state.json` contains an `"emails"` key and no `"messages"` key, rename the key
2. Rewrite the file
3. Subsequent writes use the new key and updated field names (`author` instead of `sender`, `url` instead of `gmail_link`)

Legacy field names are read transparently during the transition via fallback lookups in `_build_tasks`. Once a record is re-upserted via `upsert_message`, it is written in the new format.

---

## Configuration

New environment variables added to `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `SLACK_CLIENT_ID` | — | OAuth app client ID for Slack |
| `SLACK_DAYS_BACK` | inherits `DAYS_BACK` | Lookback window for Slack fetch (may want shorter than email) |

Token storage path (`~/.config/digester/tokens.yaml`) is not configurable — it is fixed to prevent accidental exposure.

---

## File Changes Summary

| File | Change |
|---|---|
| `message.py` | **New** — Message TypedDict |
| `sources/email.py` | **New** — refactored from `imap_client.py` |
| `sources/slack.py` | **New** |
| `auth.py` | **New** — PKCE OAuth flow |
| `digester.py` | **Modified** — source-agnostic orchestration, thread_id short-circuit, sync dispatch |
| `db.py` | **Modified** — upsert_message, state migration |
| `imap_client.py` | **Retired** — replaced by `sources/email.py` |
| `criteria.yaml` | **Unchanged** — categories are topic-based, not source-specific |
| `scorer.py` | **Unchanged** |
| `requirements.txt` | **Modified** — add `slack-sdk` |

---

## Open Questions

None. All design decisions have been resolved.
