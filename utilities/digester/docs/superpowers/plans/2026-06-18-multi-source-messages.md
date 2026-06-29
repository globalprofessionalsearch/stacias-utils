# Multi-Source Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize digester's email-only pipeline into a source-agnostic message pipeline, with Gmail and Slack as the two initial sources.

**Architecture:** A `Message` TypedDict defines the normalized schema. Each source module (`sources/email.py`, `sources/slack.py`) implements `fetch / sync_labels / sync_status`. `digester.py` calls `fetch()` on each active source, merges the results, runs the pipeline (unchanged in logic), then dispatches sync back per source.

**Tech Stack:** Python 3.10+, `slack-sdk`, `pytest`, existing `requests` / `pyyaml` / `python-dotenv`.

## Global Constraints

- All new code lives under `sources/` (fetchers) or top-level (schema, auth, pipeline).
- No source-specific identifiers (IMAP sequence numbers, Slack `ts`, channel IDs) may appear in `Message` dicts passed to the pipeline.
- `imap_client.py` is retired at the end of Task 4 — all IMAP logic moves to `sources/email.py`.
- Every task ends with passing tests and a clean commit.
- Run tests with: `python -m pytest tests/ -v` from the project root.
- The venv is at `./venv`. Activate with `. venv/bin/activate` before running commands.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `message.py` | Create | `Message` TypedDict |
| `sources/__init__.py` | Create | Empty package marker |
| `sources/email.py` | Create | Gmail/IMAP fetcher + sync |
| `sources/slack.py` | Create | Slack fetcher (no-op sync) |
| `auth.py` | Create | PKCE OAuth flow + token storage |
| `digester.py` | Modify | Source protocol, thread_id short-circuit, sync dispatch |
| `db.py` | Modify | `upsert_message`, state migration |
| `imap_client.py` | Retire | Replaced by `sources/email.py` |
| `requirements.txt` | Modify | Add `slack-sdk`, `pytest` |
| `tests/__init__.py` | Create | Package marker |
| `tests/sources/__init__.py` | Create | Package marker |
| `tests/test_message.py` | Create | Schema tests |
| `tests/test_db.py` | Create | Migration + upsert tests |
| `tests/test_digester.py` | Create | Thread_id grouping test |
| `tests/test_auth.py` | Create | PKCE + token storage tests |
| `tests/sources/test_email.py` | Create | Email normalization tests |
| `tests/sources/test_slack.py` | Create | Slack normalization tests |

---

## Task 1: Test infrastructure + Message schema

**Files:**
- Create: `message.py`
- Create: `tests/__init__.py`
- Create: `tests/sources/__init__.py`
- Create: `tests/test_message.py`
- Modify: `requirements.txt`

**Interfaces:**
- Produces: `message.Message` TypedDict — used by every subsequent task

---

- [ ] **Step 1: Add pytest to requirements.txt**

Open `requirements.txt` and append:
```
pytest==8.3.5
```

Install it:
```bash
pip install pytest==8.3.5
```
Expected: `Successfully installed pytest-8.3.5`

- [ ] **Step 2: Create test package directories**

```bash
mkdir -p tests/sources
touch tests/__init__.py tests/sources/__init__.py
```

- [ ] **Step 3: Write the failing test**

Create `tests/test_message.py`:
```python
from message import Message


def test_message_required_fields():
    msg: Message = {
        "id": "abc123",
        "source": "email",
        "subject": "Hello",
        "author": "sender@example.com",
        "body": "Body text",
        "timestamp": "2026-06-18T10:00:00+00:00",
        "url": "https://example.com",
        "thread_id": "",
        "channel": "inbox",
        "is_direct": True,
        "mentions_me": True,
    }
    assert msg["id"] == "abc123"
    assert msg["source"] == "email"
    assert msg["is_direct"] is True


def test_message_raw_is_optional():
    msg: Message = {
        "id": "abc123",
        "source": "email",
        "subject": "Hello",
        "author": "sender@example.com",
        "body": "Body text",
        "timestamp": "2026-06-18T10:00:00+00:00",
        "url": "https://example.com",
        "thread_id": "",
        "channel": "inbox",
        "is_direct": True,
        "mentions_me": True,
    }
    assert "raw" not in msg
```

- [ ] **Step 4: Run to verify it fails**

```bash
python -m pytest tests/test_message.py -v
```
Expected: `ERROR — cannot import name 'Message' from 'message'` (module doesn't exist yet)

- [ ] **Step 5: Create `message.py`**

```python
from typing import TypedDict, NotRequired


class Message(TypedDict):
    id: str            # globally unique — email message-id or "slack:{channel_id}:{ts}"
    source: str        # "email" | "slack"
    subject: str       # pipeline anchor — email subject or "#channel: first 80 chars"
    author: str        # human-readable sender
    body: str          # plain text content
    timestamp: str     # ISO 8601
    url: str           # clickable link in digest
    thread_id: str     # groups related messages; "" if standalone
    channel: str       # logical origin — "inbox", "#channel-name", "@username"
    is_direct: bool    # addressed specifically to the user
    mentions_me: bool  # user explicitly named or tagged
    raw: NotRequired[dict]
```

- [ ] **Step 6: Run to verify tests pass**

```bash
python -m pytest tests/test_message.py -v
```
Expected: `2 passed`

- [ ] **Step 7: Commit**

```bash
git add message.py requirements.txt tests/__init__.py tests/sources/__init__.py tests/test_message.py
git commit -m "feat: add Message TypedDict and test infrastructure"
```

---

## Task 2: Email source

**Files:**
- Create: `sources/__init__.py`
- Create: `sources/email.py`
- Create: `tests/sources/test_email.py`

**Interfaces:**
- Consumes: `message.Message` (Task 1)
- Produces:
  - `sources.email.SOURCE_NAME: str`
  - `sources.email.fetch(settings: dict, processed_ids: set[str]) -> list[Message]`
  - `sources.email.sync_labels(messages: list[Message], settings: dict) -> None`
  - `sources.email.sync_status(message_ids: list[str], old_status: str, new_status: str, settings: dict) -> None`
  - `sources.email._normalize(imap_id: bytes, raw_bytes: bytes, gmail_link: str | None) -> Message` (internal, tested directly)

---

- [ ] **Step 1: Write the failing normalization tests**

Create `tests/sources/test_email.py`:
```python
import email as emaillib
import sources.email as email_source


def _raw(msg_id, subject, sender, body, references="", in_reply_to=""):
    lines = [
        f"Message-ID: {msg_id}",
        f"Subject: {subject}",
        f"From: {sender}",
        "Date: Thu, 18 Jun 2026 10:00:00 +0000",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
    ]
    if references:
        lines.append(f"References: {references}")
    if in_reply_to:
        lines.append(f"In-Reply-To: {in_reply_to}")
    lines += ["", body]
    return "\n".join(lines).encode()


def test_normalize_basic_fields():
    raw = _raw("<abc@example.com>", "Test Subject", "Alice <alice@example.com>", "Hello")
    msg = email_source._normalize(b"42", raw, "https://mail.google.com/x")
    assert msg["id"] == "<abc@example.com>"
    assert msg["source"] == "email"
    assert msg["subject"] == "Test Subject"
    assert msg["author"] == "Alice <alice@example.com>"
    assert msg["body"] == "Hello"
    assert msg["url"] == "https://mail.google.com/x"
    assert msg["channel"] == "inbox"
    assert msg["is_direct"] is True
    assert msg["mentions_me"] is True


def test_normalize_thread_id_from_references():
    raw = _raw("<child@x.com>", "Re: Thing", "bob@x.com", "Reply",
               references="<parent@x.com> <grandparent@x.com>")
    msg = email_source._normalize(b"5", raw, None)
    assert msg["thread_id"] == "<parent@x.com>"


def test_normalize_thread_id_from_in_reply_to():
    raw = _raw("<child@x.com>", "Re: Thing", "bob@x.com", "Reply",
               in_reply_to="<parent@x.com>")
    msg = email_source._normalize(b"6", raw, None)
    assert msg["thread_id"] == "<parent@x.com>"


def test_normalize_thread_id_falls_back_to_own_id():
    raw = _raw("<root@x.com>", "Root message", "bob@x.com", "Body")
    msg = email_source._normalize(b"7", raw, None)
    assert msg["thread_id"] == "<root@x.com>"


def test_normalize_populates_imap_id_map():
    email_source._imap_id_map.clear()
    raw = _raw("<map@x.com>", "Test", "bob@x.com", "Body")
    email_source._normalize(b"99", raw, None)
    assert email_source._imap_id_map.get("<map@x.com>") == b"99"
```

- [ ] **Step 2: Run to verify tests fail**

```bash
python -m pytest tests/sources/test_email.py -v
```
Expected: `ERROR — No module named 'sources.email'`

- [ ] **Step 3: Create `sources/__init__.py`**

```bash
touch sources/__init__.py
```

- [ ] **Step 4: Create `sources/email.py`**

```python
import email as emaillib
import imaplib
import os
import re
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parsedate_to_datetime

from message import Message

SOURCE_NAME = "email"

IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
GMAIL_LABEL_SEEN = "digest/seen"
GMAIL_LABEL_SKIPPED = "digest/skipped"
_GMAIL_STATUS_LABEL = {"active": "digest/active", "done": "digest/done"}

FETCH_CHUNK = 100

# Populated during fetch(); used by sync_labels() in the same process run.
_imap_id_map: dict[str, bytes] = {}


def fetch(settings: dict, processed_ids: set[str]) -> list[Message]:
    mail = _connect(settings)
    try:
        return _fetch_recent(mail, settings, processed_ids)
    finally:
        mail.logout()


def sync_labels(messages: list[Message], settings: dict) -> None:
    if not messages:
        return
    by_label: dict[str, list] = {}
    for msg in messages:
        imap_id = _imap_id_map.get(msg["id"])
        if not imap_id:
            continue
        cat_label = (
            f"digest/category/{msg['category']}" if msg.get("category") else GMAIL_LABEL_SKIPPED
        )
        by_label.setdefault(GMAIL_LABEL_SEEN, []).append(imap_id)
        by_label.setdefault(cat_label, []).append(imap_id)

    mail = _connect(settings)
    mail.select("INBOX")
    try:
        batches = list(by_label.items())
        for i, (label, imap_ids) in enumerate(batches, 1):
            print(f"  syncing [{i}/{len(batches)}] {label} ({len(imap_ids)})...", end="\r", flush=True)
            _apply_label_batch(mail, imap_ids, label)
        print(f"  synced {len(batches)} label batch(es)                           ")
    finally:
        mail.logout()


def sync_status(message_ids: list[str], old_status: str, new_status: str, settings: dict) -> None:
    if not message_ids:
        return
    mail = _connect(settings)
    mail.select("INBOX")
    try:
        imap_ids = _find_imap_ids(mail, message_ids)
        if old_label := _GMAIL_STATUS_LABEL.get(old_status):
            _remove_label_batch(mail, imap_ids, old_label)
        if new_label := _GMAIL_STATUS_LABEL.get(new_status):
            _apply_label_batch(mail, imap_ids, new_label)
    finally:
        mail.logout()


def _normalize(imap_id: bytes, raw_bytes: bytes, gmail_link: str | None) -> Message:
    msg = emaillib.message_from_bytes(raw_bytes)
    message_id = msg.get("Message-ID", "").strip()

    references = msg.get("References", "").strip()
    in_reply_to = msg.get("In-Reply-To", "").strip()
    if references:
        thread_id = references.split()[0]
    elif in_reply_to:
        thread_id = in_reply_to.split()[0]
    else:
        thread_id = message_id

    _imap_id_map[message_id] = imap_id

    return {
        "id": message_id,
        "source": SOURCE_NAME,
        "subject": _decode_header_value(msg.get("Subject", "")),
        "author": msg.get("From", ""),
        "body": _get_body(msg),
        "timestamp": _parse_date(msg.get("Date", "")),
        "url": gmail_link or "",
        "thread_id": thread_id,
        "channel": "inbox",
        "is_direct": True,
        "mentions_me": True,
    }


def _connect(settings: dict):
    mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    mail.login(os.getenv("EMAIL"), os.getenv("APP_PASSWORD"))
    return mail


def _fetch_recent(mail, settings: dict, processed_ids: set[str]) -> list[Message]:
    days_back = settings["days_back"]
    limit = settings.get("limit")

    mail.select("INBOX")
    since_date = (datetime.now() - timedelta(days=days_back)).strftime("%d-%b-%Y")
    status, data = mail.search(None, f"SINCE {since_date}")
    if status != "OK":
        return []

    ids = list(reversed(data[0].split()))
    total = len(ids)
    if not ids:
        print(f"  No emails found in the last {days_back} days.", flush=True)
        return []

    n_chunks = (total + FETCH_CHUNK - 1) // FETCH_CHUNK
    print(f"  Found {total} emails in the last {days_back} days, fetching headers ({n_chunks} batch(es))...", flush=True)

    unprocessed: list[bytes] = []
    done = False
    for chunk_num, i in enumerate(range(0, total, FETCH_CHUNK), 1):
        if done:
            break
        chunk = ids[i:i + FETCH_CHUNK]
        message_set = b",".join(chunk)
        status, header_data = mail.fetch(message_set, "(RFC822.HEADER)")
        if status != "OK":
            continue
        print(f"  headers: batch {chunk_num}/{n_chunks}, found {len(unprocessed)} unprocessed so far...", end="\r", flush=True)
        for item in header_data:
            if not isinstance(item, tuple):
                continue
            seq_match = re.match(rb"(\d+)\s", item[0])
            if not seq_match:
                continue
            hdr = emaillib.message_from_bytes(item[1])
            mid = hdr.get("Message-ID", "").strip()
            if mid not in processed_ids:
                unprocessed.append(seq_match.group(1))
                if limit and len(unprocessed) >= limit:
                    done = True
                    break

    n_unprocessed = len(unprocessed)
    print(f"  headers done: {n_unprocessed} unprocessed of {total} total.              ", flush=True)
    if not unprocessed:
        return []

    n_body_chunks = (n_unprocessed + FETCH_CHUNK - 1) // FETCH_CHUNK
    print(f"  Fetching full content ({n_body_chunks} batch(es))...", flush=True)

    messages = []
    for chunk_num, i in enumerate(range(0, n_unprocessed, FETCH_CHUNK), 1):
        chunk = unprocessed[i:i + FETCH_CHUNK]
        message_set = b",".join(chunk)
        print(f"  content: batch {chunk_num}/{n_body_chunks}...", end="\r", flush=True)
        status, msg_data = mail.fetch(message_set, "(RFC822 X-GM-MSGID)")
        if status != "OK":
            continue
        for item in msg_data:
            if not isinstance(item, tuple):
                continue
            seq_match = re.match(rb"(\d+)\s", item[0])
            imap_id = seq_match.group(1) if seq_match else b"0"
            header_str = item[0].decode(errors="replace")
            gm_match = re.search(r"X-GM-MSGID (\d+)", header_str)
            gmail_link = None
            if gm_match:
                gmail_msgid = int(gm_match.group(1))
                gmail_link = f"https://mail.google.com/mail/u/0/#all/{format(gmail_msgid, 'x')}"
            messages.append(_normalize(imap_id, item[1], gmail_link))

    print(f"  Collected {len(messages)} unprocessed emails.                    ", flush=True)
    return messages


def _apply_label_batch(mail, imap_ids: list, label: str):
    if not imap_ids:
        return
    message_set = b",".join(imap_ids)
    mail.store(message_set, "+X-GM-LABELS", f'"{label}"')


def _remove_label_batch(mail, imap_ids: list, label: str):
    if not imap_ids:
        return
    message_set = b",".join(imap_ids)
    mail.store(message_set, "-X-GM-LABELS", f'"{label}"')


def _find_imap_ids(mail, message_ids: list[str]) -> list[bytes]:
    imap_ids = []
    for msg_id in message_ids:
        safe_id = msg_id.replace('"', '\\"')
        status, data = mail.search(None, f'HEADER Message-ID "{safe_id}"')
        if status == "OK" and data[0]:
            imap_ids.extend(data[0].split())
    return imap_ids


def _decode_header_value(value: str) -> str:
    parts = decode_header(value)
    decoded = []
    for part, enc in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def _get_body(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode(errors="replace")[:2000]
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            return payload.decode(errors="replace")[:2000]
    return ""


def _parse_date(date_str: str) -> str:
    if not date_str:
        return ""
    try:
        return parsedate_to_datetime(date_str).isoformat()
    except Exception:
        return date_str
```

**Note on `_fetch_recent` signature change:** `fetch()` passes `processed_ids` via `settings["_processed_ids"]`. Update the call site in `digester.py` (Task 4) to set this key before calling `fetch()`.

- [ ] **Step 5: Run normalization tests to verify pass**

```bash
python -m pytest tests/sources/test_email.py -v
```
Expected: `5 passed`

- [ ] **Step 6: Commit**

```bash
git add sources/__init__.py sources/email.py tests/sources/test_email.py
git commit -m "feat: add sources/email.py with Message normalization"
```

---

## Task 3: DB migration

**Files:**
- Modify: `db.py`
- Create: `tests/test_db.py`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `db.upsert_message(id, source, subject, author, received_at, category, task_id, skipped, url, body_snippet, channel, thread_id) -> None`
  - `db._load()` — transparently migrates `emails` → `messages` on first call after update
  - `db._build_tasks()` — returns `author`, `url`, `channel`, `thread_id`, `source` fields

---

- [ ] **Step 1: Write the failing migration and upsert tests**

Create `tests/test_db.py`:
```python
import json
import pytest
import db


@pytest.fixture
def old_state(tmp_path, monkeypatch):
    state = {
        "emails": {
            "<msg1@example.com>": {
                "subject": "Test PR",
                "sender": "alice@example.com",
                "received_at": "2026-06-18T10:00:00",
                "category": "pull_request",
                "task_id": "task-uuid-1",
                "skipped": 0,
                "seen": 1,
                "addressed": 0,
                "gmail_link": "https://mail.google.com/x",
                "body_snippet": "please review",
            }
        },
        "tasks": {
            "task-uuid-1": {
                "category": "pull_request",
                "created_at": "2026-06-18T10:00:00",
                "status": "pending",
                "priority": 1.0,
            }
        },
        "warnings": [],
    }
    path = tmp_path / "state.json"
    path.write_text(json.dumps(state))
    monkeypatch.setattr(db, "STATE_PATH", str(path))
    return path


@pytest.fixture
def empty_state(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    monkeypatch.setattr(db, "STATE_PATH", str(path))
    return path


def test_migration_renames_emails_key(old_state):
    state = db._load()
    assert "messages" in state
    assert "emails" not in state


def test_migration_renames_sender_to_author(old_state):
    state = db._load()
    record = state["messages"]["<msg1@example.com>"]
    assert "author" in record
    assert "sender" not in record
    assert record["author"] == "alice@example.com"


def test_migration_renames_gmail_link_to_url(old_state):
    state = db._load()
    record = state["messages"]["<msg1@example.com>"]
    assert "url" in record
    assert "gmail_link" not in record
    assert record["url"] == "https://mail.google.com/x"


def test_migration_adds_source_field(old_state):
    state = db._load()
    record = state["messages"]["<msg1@example.com>"]
    assert record["source"] == "email"


def test_upsert_message_writes_new_fields(empty_state):
    db.upsert_message(
        id="<new@example.com>",
        source="email",
        subject="Hello",
        author="bob@example.com",
        received_at="2026-06-18T10:00:00",
        category="pull_request",
        task_id="task-2",
        skipped=0,
        url="https://mail.google.com/y",
        body_snippet="body",
        channel="inbox",
        thread_id="<root@example.com>",
    )
    state = db._load()
    record = state["messages"]["<new@example.com>"]
    assert record["author"] == "bob@example.com"
    assert record["url"] == "https://mail.google.com/y"
    assert record["source"] == "email"
    assert record["channel"] == "inbox"
    assert record["thread_id"] == "<root@example.com>"


def test_get_processed_ids_returns_seen_messages(empty_state):
    db.upsert_message(
        id="<seen@x.com>", source="email", subject="S", author="a@x.com",
        received_at="2026-06-18", skipped=0, url="", body_snippet="",
        channel="inbox", thread_id="",
    )
    ids = db.get_processed_ids()
    assert "<seen@x.com>" in ids
```

- [ ] **Step 2: Run to verify tests fail**

```bash
python -m pytest tests/test_db.py -v
```
Expected: `FAILED — no attribute 'upsert_message'` (or similar)

- [ ] **Step 3: Update `db.py`**

Replace the `_load()` function and add `upsert_message`. Full updated `db.py`:

```python
import os
import json
from datetime import datetime

STATE_PATH = os.path.join(os.path.dirname(__file__), "state.json")


def _load() -> dict:
    default = {"messages": {}, "tasks": {}, "warnings": []}
    if not os.path.exists(STATE_PATH):
        return default
    with open(STATE_PATH) as f:
        content = f.read().strip()
    if not content:
        return default
    state = json.loads(content)
    # One-time migration: rename "emails" → "messages" with updated field names
    if "emails" in state and "messages" not in state:
        state["messages"] = {}
        for msg_id, em in state.pop("emails").items():
            state["messages"][msg_id] = {
                **{k: v for k, v in em.items() if k not in ("sender", "gmail_link")},
                "source": "email",
                "author": em.get("sender", ""),
                "url": em.get("gmail_link", ""),
                "channel": em.get("channel", "inbox"),
                "thread_id": em.get("thread_id", ""),
            }
        _save(state)
    return state


def _save(state: dict):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def _task_status(task: dict) -> str:
    if s := task.get("status"):
        return s
    return "done" if task.get("addressed") else "pending"


def _build_tasks(state: dict, include_done: bool = False) -> tuple[dict, dict]:
    tasks: dict[str, list] = {}
    for msg_id, em in state["messages"].items():
        tid = em.get("task_id")
        if not tid or em.get("skipped"):
            continue
        task = state["tasks"].get(tid, {})
        status = _task_status(task)
        if not include_done and status == "done":
            continue
        tasks.setdefault(tid, []).append({
            "id": msg_id,
            "subject": em["subject"],
            "author": em.get("author", em.get("sender", "")),
            "category": em.get("category"),
            "task_id": tid,
            "url": em.get("url", em.get("gmail_link", "")),
            "body": em.get("body_snippet", ""),
            "channel": em.get("channel", "inbox"),
            "thread_id": em.get("thread_id", ""),
            "source": em.get("source", "email"),
        })
    statuses = {
        tid: _task_status(state["tasks"].get(tid, {}))
        for tid in tasks
    }
    return tasks, statuses


_STATUS_SORT = {"active": 0, "pending": 1, "done": 2}


def _rank(tasks: dict, statuses: dict, state: dict) -> list:
    return sorted(
        [(tid, state["tasks"][tid].get("priority", 0.0)) for tid in tasks if tid in state["tasks"]],
        key=lambda x: (_STATUS_SORT.get(statuses.get(x[0], "pending"), 1), -x[1]),
    )


def get_processed_ids() -> set:
    state = _load()
    return {
        id for id, em in state["messages"].items()
        if em.get("seen") or em.get("addressed")
    }


def upsert_message(
    id, source, subject, author, received_at,
    category=None, task_id=None, skipped=0,
    url=None, body_snippet="", channel="inbox", thread_id="",
):
    state = _load()
    existing = state["messages"].get(id, {})
    state["messages"][id] = {
        **existing,
        "source": source,
        "subject": subject,
        "author": author,
        "received_at": received_at,
        "category": category,
        "task_id": task_id,
        "skipped": skipped,
        "seen": 1,
        "addressed": existing.get("addressed", 0),
        "url": url or "",
        "body_snippet": body_snippet,
        "channel": channel,
        "thread_id": thread_id,
    }
    _save(state)


def get_outstanding_tasks() -> tuple[dict, list, dict]:
    state = _load()
    tasks, statuses = _build_tasks(state, include_done=False)
    ranked = _rank(tasks, statuses, state)
    return tasks, ranked, statuses


def get_all_tasks() -> tuple[dict, list, dict]:
    state = _load()
    tasks, statuses = _build_tasks(state, include_done=True)
    ranked = _rank(tasks, statuses, state)
    return tasks, ranked, statuses


def set_task_status_batch(ranks: list[int], status: str) -> list[tuple]:
    _, ranked, statuses = get_all_tasks()
    results = []
    state = _load()
    for rank in ranks:
        if rank < 1 or rank > len(ranked):
            results.append((rank, None, None, None))
            continue
        tid = ranked[rank - 1][0]
        old_status = statuses.get(tid, "pending")
        msg_ids = [
            mid for mid, em in state["messages"].items()
            if em.get("task_id") == tid and not em.get("skipped")
        ]
        state["tasks"][tid]["status"] = status
        results.append((rank, tid, old_status, msg_ids))
    _save(state)
    return results


def revert_task_statuses(updates: list[tuple]):
    state = _load()
    for _rank, tid, old_status, _msgs in updates:
        if tid is not None:
            state["tasks"][tid]["status"] = old_status
    _save(state)


def set_task_status_by_id(task_id: str, status: str):
    state = _load()
    if task_id in state["tasks"]:
        state["tasks"][task_id]["status"] = status
        _save(state)


def upsert_task(id, category, priority=None):
    state = _load()
    if id not in state["tasks"]:
        state["tasks"][id] = {
            "category": category,
            "created_at": datetime.utcnow().isoformat(),
            "status": "pending",
        }
    if priority is not None:
        state["tasks"][id]["priority"] = priority
    _save(state)


def log_warning(operation, payload, attempts, message):
    state = _load()
    state["warnings"].append({
        "timestamp": datetime.utcnow().isoformat(),
        "operation": operation,
        "payload": str(payload)[:500],
        "attempts": attempts,
        "message": message,
    })
    _save(state)


def get_message_sources(message_ids: list[str]) -> dict[str, str]:
    """Return {msg_id: source_name} for a list of message IDs."""
    state = _load()
    return {
        mid: state["messages"].get(mid, {}).get("source", "email")
        for mid in message_ids
    }
```

**Note:** `upsert_email` is removed. `digester.py` will call `upsert_message` after Task 4.

- [ ] **Step 4: Run tests to verify pass**

```bash
python -m pytest tests/test_db.py -v
```
Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add db.py tests/test_db.py
git commit -m "feat: migrate db.py to Message schema (upsert_message, emails→messages)"
```

---

## Task 4: Pipeline refactor (email end-to-end)

**Files:**
- Modify: `digester.py`
- Create: `tests/test_digester.py`
- Retire: `imap_client.py` (deleted at end of task)

**Interfaces:**
- Consumes:
  - `message.Message` (Task 1)
  - `sources.email.SOURCE_NAME`, `fetch`, `sync_labels`, `sync_status` (Task 2)
  - `db.upsert_message`, `db.get_message_sources` (Task 3)
- Produces: working `digester run`, `digester show`, `digester set` using source protocol

---

- [ ] **Step 1: Write the failing thread_id grouping test**

Create `tests/test_digester.py`:
```python
from unittest.mock import patch
import digester


def _msg(id, subject, thread_id="", category="pull_request"):
    return {
        "id": id,
        "source": "email",
        "subject": subject,
        "author": "sender@example.com",
        "body": "body text",
        "timestamp": "2026-06-18T10:00:00+00:00",
        "url": "",
        "thread_id": thread_id,
        "channel": "inbox",
        "is_direct": True,
        "mentions_me": True,
        "category": category,
    }


def test_group_thread_id_short_circuit():
    """Messages sharing a thread_id are grouped without any LLM call."""
    msg1 = _msg("id1", "PR #42 needs review", thread_id="thread-abc")
    msg2 = _msg("id2", "Re: PR #42 needs review", thread_id="thread-abc")

    config = {
        "group": {
            "description": "test",
            "dimensions": [],
            "examples": [],
            "counter_examples": [],
        }
    }
    settings = {"group_threshold": 0.7, "group_body_limit": 500, "subject_limit": 60}

    with patch("digester.scorer") as mock_scorer:
        tasks = digester.run_group([msg1, msg2], config, settings)

    mock_scorer.score.assert_not_called()
    assert len(tasks) == 1
    task_msgs = list(tasks.values())[0]
    assert len(task_msgs) == 2


def test_group_different_threads_use_llm():
    """Messages with different thread_ids go through LLM comparison."""
    msg1 = _msg("id1", "PR #42", thread_id="thread-A")
    msg2 = _msg("id2", "PR #99", thread_id="thread-B")

    config = {
        "group": {
            "description": "test",
            "dimensions": [],
            "examples": [],
            "counter_examples": [],
        }
    }
    settings = {"group_threshold": 0.7, "group_body_limit": 500, "subject_limit": 60}

    with patch("digester.scorer") as mock_scorer:
        mock_scorer.score.return_value = 0.2  # below threshold → separate tasks
        tasks = digester.run_group([msg1, msg2], config, settings)

    mock_scorer.score.assert_called()
    assert len(tasks) == 2


def test_group_empty_thread_id_uses_llm():
    """A message with thread_id='' always goes through LLM comparison."""
    msg1 = _msg("id1", "Subject A", thread_id="")
    msg2 = _msg("id2", "Subject B", thread_id="")

    config = {
        "group": {
            "description": "test",
            "dimensions": [],
            "examples": [],
            "counter_examples": [],
        }
    }
    settings = {"group_threshold": 0.7, "group_body_limit": 500, "subject_limit": 60}

    with patch("digester.scorer") as mock_scorer:
        mock_scorer.score.return_value = 0.9  # above threshold → group together
        tasks = digester.run_group([msg1, msg2], config, settings)

    mock_scorer.score.assert_called()
    assert len(tasks) == 1
```

- [ ] **Step 2: Run to verify tests fail**

```bash
python -m pytest tests/test_digester.py -v
```
Expected: `FAILED — run_group uses em['sender']` (KeyError) or similar field mismatch

- [ ] **Step 3: Update `digester.py` — imports and source loader**

Replace the top of `digester.py` (imports section, up through `load_settings`):

```python
#!/usr/bin/env python3
"""
digester — a local multi-source attention digest tool
Fetch → Filter → Group → Prioritize → Deliver
"""

import os
import re
import shutil
import sys
import uuid
import yaml
import argparse
from collections import defaultdict
from functools import cmp_to_key
from dotenv import load_dotenv

load_dotenv()

import db
import scorer
import sources.email as _email_source

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "criteria.yaml")


def load_config():
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def load_settings() -> dict:
    days_back = int(os.getenv("DAYS_BACK", 30))
    return {
        "days_back":             days_back,
        "slack_days_back":       int(os.getenv("SLACK_DAYS_BACK", days_back)),
        "filter_threshold":      float(os.getenv("FILTER_THRESHOLD", 0.5)),
        "group_threshold":       float(os.getenv("GROUP_THRESHOLD", 0.7)),
        "group_body_limit":      int(os.getenv("GROUP_BODY_LIMIT", 500)),
        "prioritize_body_limit": int(os.getenv("PRIORITIZE_BODY_LIMIT", 300)),
        "subject_limit":         int(os.getenv("DIGEST_SUBJECT_LIMIT", 60)),
    }


def _active_sources(settings: dict) -> list:
    """Return source modules whose credentials are configured."""
    return [_email_source]
```

- [ ] **Step 4: Update `run_filter` field names**

Find the `run_filter` function and replace the payload line:

Old:
```python
payload = f"Subject: {em['subject']}\nFrom: {em['sender']}\nBody:\n{em['body']}"
```
New:
```python
payload = f"Subject: {em['subject']}\nFrom: {em['author']}\nBody:\n{em['body']}"
```

Also update every `for i, em in enumerate(emails, 1):` → `for i, em in enumerate(messages, 1):` in the function signature and body, and rename the parameter: `def run_filter(messages: list[dict], config: dict, settings: dict) -> list[dict]:`.

The print lines use `em['subject']` which is unchanged — those remain.

- [ ] **Step 5: Update `run_group` with thread_id short-circuit**

Replace the full `run_group` function:

```python
def run_group(messages: list[dict], config: dict, settings: dict, seed_tasks: dict = None) -> dict[str, list[dict]]:
    print(f"\n[group] Grouping filtered messages...")
    threshold = settings["group_threshold"]
    body_limit = settings["group_body_limit"]
    subject_limit = settings["subject_limit"]
    criteria = _format_group_criteria(config["group"])

    relevant = [m for m in messages if m.get("category")]
    total = len(relevant)
    tasks: dict[str, list[dict]] = {tid: list(ems) for tid, ems in seed_tasks.items()} if seed_tasks else {}

    for i, msg in enumerate(relevant, 1):
        pct = int(i / total * 100) if total else 100
        assigned = False

        # Fast path: deterministic thread grouping — no LLM call needed
        if msg.get("thread_id"):
            for task_id, task_msgs in tasks.items():
                if task_msgs[0].get("thread_id") == msg["thread_id"]:
                    tasks[task_id].append(msg)
                    msg["task_id"] = task_id
                    assigned = True
                    print(f"  → threaded '{msg['subject'][:subject_limit]}' into task {task_id[:8]} [{pct}%]")
                    break

        # LLM pairwise comparison for messages not matched by thread_id
        if not assigned:
            payload_a = f"Subject: {msg['subject']}\nFrom: {msg['author']}\nBody:\n{msg['body'][:body_limit]}"
            for task_id, task_msgs in tasks.items():
                rep = task_msgs[0]
                payload_b = f"Subject: {rep['subject']}\nFrom: {rep['author']}\nBody:\n{rep['body'][:body_limit]}"
                payload = f"Email A:\n{payload_a}\n\nEmail B:\n{payload_b}"
                s = scorer.score("group", criteria, payload)
                if s is not None and s >= threshold:
                    tasks[task_id].append(msg)
                    msg["task_id"] = task_id
                    assigned = True
                    print(f"  → grouped '{msg['subject'][:subject_limit]}' into task {task_id[:8]} [{pct}%]")
                    break

        if not assigned:
            task_id = str(uuid.uuid4())
            tasks[task_id] = [msg]
            msg["task_id"] = task_id
            print(f"  + new task {task_id[:8]} for '{msg['subject'][:subject_limit]}' [{pct}%]")

    return tasks
```

- [ ] **Step 6: Update `run_prioritize` field names**

In `run_prioritize`, replace `rep_a['subject']`, `rep_b['subject']`, `rep_a.get('category')`, `rep_b.get('category')`, `rep_a['body']`, `rep_b['body']` — these field names are unchanged. No edits needed in `run_prioritize`.

- [ ] **Step 7: Update `run_deliver` and `run_show_concise`**

In `run_deliver`, replace every `rep['sender']` with `rep['author']`. Also update the sender line to show `channel` when it isn't `"inbox"`:

```python
# Replace the sender line (appears twice — for active marker and default):
channel = rep.get("channel", "")
channel_s = f"  ·  {_a(_GRY)}{channel}{_a(_RST)}" if channel and channel != "inbox" else ""
print(f"       {_a(_GRY)}{rep['author']}{_a(_RST)}{channel_s}")
```

In `run_show_concise`, replace `rep['sender']` with `rep['author']` if it appears (check — it may not; the concise view only shows subject).

- [ ] **Step 8: Update `run()` to use source protocol**

Replace the entire `run()` function:

```python
def run(limit=None):
    config = load_config()
    settings = load_settings()
    if limit is not None:
        settings["limit"] = limit

    processed_ids = db.get_processed_ids()
    outstanding_tasks, outstanding_ranked, outstanding_statuses = db.get_outstanding_tasks()

    active_sources = _active_sources(settings)
    messages = []
    for source in active_sources:
        print(f"[digester] Fetching from {source.SOURCE_NAME}...")
        messages.extend(source.fetch(settings, processed_ids))

    if not messages:
        if not outstanding_tasks:
            print("[digester] Nothing new to process.")
        else:
            run_deliver(outstanding_tasks, outstanding_ranked, settings, task_statuses=outstanding_statuses)
        return

    messages = run_filter(messages, config, settings)
    tasks = run_group(messages, config, settings, seed_tasks=outstanding_tasks)
    ranked = run_prioritize(tasks, config, settings)

    new_task_ids = set(tasks.keys()) - set(outstanding_tasks.keys())

    for msg in messages:
        db.upsert_message(
            id=msg["id"],
            source=msg["source"],
            subject=msg["subject"],
            author=msg["author"],
            received_at=msg["timestamp"],
            category=msg.get("category"),
            task_id=msg.get("task_id"),
            skipped=1 if not msg.get("category") else 0,
            url=msg.get("url", ""),
            body_snippet=msg["body"][:settings["group_body_limit"]],
            channel=msg.get("channel", ""),
            thread_id=msg.get("thread_id", ""),
        )

    for _rank, (task_id, priority_score) in enumerate(ranked, 1):
        msgs_in_task = tasks[task_id]
        category = msgs_in_task[0].get("category", "unknown")
        db.upsert_task(task_id, category, priority=priority_score)

    # Source-specific label sync
    by_source = defaultdict(list)
    for msg in messages:
        by_source[msg["source"]].append(msg)
    for source in active_sources:
        source.sync_labels(by_source.get(source.SOURCE_NAME, []), settings)

    run_deliver(tasks, ranked, settings, new_task_ids=new_task_ids, task_statuses=outstanding_statuses)
    print("\n[digester] Done.")
```

- [ ] **Step 9: Update the `set` command to use source protocol**

Find the `set` command's Gmail sync block (inside `if not needs_sync:` / `else:` around line 538). Replace the contents of the `else:` block:

```python
else:
    try:
        print("[set] Syncing labels...", flush=True)
        settings = load_settings()
        # Group message IDs by source
        all_msg_ids = [mid for _r, _t, _o, mids in needs_sync for mid in mids]
        source_map_for_ids = db.get_message_sources(all_msg_ids)
        by_source_status: dict[tuple, list] = defaultdict(list)
        for _r, _t, old_status, msg_ids in needs_sync:
            for mid in msg_ids:
                src = source_map_for_ids.get(mid, "email")
                by_source_status[(src, old_status)].append(mid)

        source_map = {s.SOURCE_NAME: s for s in _active_sources(settings)}
        for (src_name, old_st), msg_ids in by_source_status.items():
            if source := source_map.get(src_name):
                source.sync_status(msg_ids, old_st, args.status, settings)

        print(f"Marked {args.status}: {_fmt_ranks(changed)}")
    except Exception as e:
        print(f"[set] Sync failed: {e}")
        print("[set] Reverting state...", flush=True)
        db.revert_task_statuses(changed)
        print("[set] Reverted.")
```

Also remove the now-unused `_sync_status_labels` function and `_GMAIL_STATUS_LABEL` dict from `digester.py` (they are now in `sources/email.py`).

Remove the `import imap_client` line from `digester.py`.

- [ ] **Step 10: Run all tests**

```bash
python -m pytest tests/ -v
```
Expected: `all passed` (at least the 3 digester tests + db + message + email tests)

- [ ] **Step 11: Delete `imap_client.py`**

```bash
git rm imap_client.py
```

- [ ] **Step 12: Commit**

```bash
git add digester.py
git commit -m "feat: refactor digester.py to source protocol; retire imap_client.py"
```

---

## Task 5: Auth module

**Files:**
- Create: `auth.py`
- Create: `tests/test_auth.py`
- Modify: `digester.py` — add `digester auth slack` command

**Interfaces:**
- Produces:
  - `auth.TOKENS_PATH: str`
  - `auth._generate_pkce_pair() -> tuple[str, str]`
  - `auth.run_slack_flow(client_id: str) -> str`
  - `auth.save_token(source: str, token: str) -> None`
  - `auth.load_token(source: str) -> str | None`

---

- [ ] **Step 1: Write the failing auth tests**

Create `tests/test_auth.py`:
```python
import base64
import hashlib
import pytest
import auth


def test_pkce_verifier_is_url_safe():
    verifier, _ = auth._generate_pkce_pair()
    # URL-safe base64 chars only: A-Z a-z 0-9 - _
    assert all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for c in verifier)


def test_pkce_challenge_is_s256_of_verifier():
    verifier, challenge = auth._generate_pkce_pair()
    digest = hashlib.sha256(verifier.encode()).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    assert challenge == expected


def test_token_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "TOKENS_PATH", str(tmp_path / "tokens.yaml"))
    auth.save_token("slack", "xoxp-test-token")
    assert auth.load_token("slack") == "xoxp-test-token"


def test_load_token_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "TOKENS_PATH", str(tmp_path / "tokens.yaml"))
    assert auth.load_token("slack") is None


def test_save_token_creates_parent_dir(tmp_path, monkeypatch):
    nested = tmp_path / "a" / "b" / "tokens.yaml"
    monkeypatch.setattr(auth, "TOKENS_PATH", str(nested))
    auth.save_token("slack", "xoxp-abc")
    assert nested.exists()


def test_save_token_preserves_other_sources(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "TOKENS_PATH", str(tmp_path / "tokens.yaml"))
    auth.save_token("slack", "xoxp-slack")
    auth.save_token("other", "token-other")
    assert auth.load_token("slack") == "xoxp-slack"
    assert auth.load_token("other") == "token-other"
```

- [ ] **Step 2: Run to verify tests fail**

```bash
python -m pytest tests/test_auth.py -v
```
Expected: `ERROR — No module named 'auth'`

- [ ] **Step 3: Create `auth.py`**

```python
import base64
import hashlib
import os
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlencode, parse_qs, urlparse

import requests
import yaml

TOKENS_PATH = os.path.expanduser("~/.config/digester/tokens.yaml")
CALLBACK_PORT = 9119

SLACK_AUTH_URL = "https://slack.com/oauth/v2/authorize"
SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access"
SLACK_USER_SCOPES = (
    "search:read,channels:read,channels:history,"
    "groups:read,groups:history,im:read,im:history,"
    "mpim:read,mpim:history,users:read"
)


def _generate_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def run_slack_flow(client_id: str) -> str:
    """Run the Slack PKCE OAuth browser flow. Returns the user access token."""
    verifier, challenge = _generate_pkce_pair()
    state = secrets.token_urlsafe(16)
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/callback"

    auth_params = {
        "client_id": client_id,
        "user_scope": SLACK_USER_SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    auth_url = f"{SLACK_AUTH_URL}?{urlencode(auth_params)}"

    code_holder: dict = {}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if not self.path.startswith("/callback"):
                self.send_error(404)
                return
            params = parse_qs(urlparse(self.path).query)
            if params.get("state", [None])[0] != state:
                self.send_error(400, "State mismatch")
                return
            code = params.get("code", [None])[0]
            if not code:
                self.send_error(400, "No code in callback")
                return
            code_holder["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><body>Authentication successful! You can close this tab.</body></html>")

        def log_message(self, format, *args):
            pass  # suppress access log

    server = HTTPServer(("127.0.0.1", CALLBACK_PORT), _Handler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()

    print(f"[auth] Opening browser for Slack authentication...")
    print(f"[auth] If your browser doesn't open, visit:\n  {auth_url}\n")
    webbrowser.open(auth_url)

    thread.join(timeout=120)
    server.server_close()

    if "code" not in code_holder:
        raise RuntimeError("Authentication timed out or was cancelled.")

    resp = requests.post(SLACK_TOKEN_URL, data={
        "client_id": client_id,
        "code": code_holder["code"],
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
    })
    resp.raise_for_status()
    data = resp.json()

    if not data.get("ok"):
        raise RuntimeError(f"Token exchange failed: {data.get('error')}")

    # Slack returns the user token inside authed_user, not at the top level
    token = data["authed_user"]["access_token"]
    return token


def save_token(source: str, token: str) -> None:
    path = Path(TOKENS_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path) as f:
            config = yaml.safe_load(f) or {}
    except FileNotFoundError:
        config = {}
    config.setdefault("sources", {})[source] = {"token": {"access_token": token}}
    with open(path, "w") as f:
        yaml.dump(config, f)
    path.chmod(0o600)


def load_token(source: str) -> str | None:
    try:
        with open(TOKENS_PATH) as f:
            config = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return None
    return config.get("sources", {}).get(source, {}).get("token", {}).get("access_token")
```

- [ ] **Step 4: Run tests to verify pass**

```bash
python -m pytest tests/test_auth.py -v
```
Expected: `6 passed`

- [ ] **Step 5: Add `digester auth` command to `digester.py`**

In the `argparse` block, after the existing `set_p` parser definition, add:

```python
auth_p = sub.add_parser("auth", help="Authenticate with a source")
auth_p.add_argument("source", choices=["slack"], help="Source to authenticate (slack)")
```

In the `if args.command == ...` dispatch block, add:

```python
elif args.command == "auth":
    client_id = os.getenv("SLACK_CLIENT_ID")
    if not client_id:
        print("[auth] SLACK_CLIENT_ID not set in .env")
        sys.exit(1)
    import auth as _auth
    try:
        token = _auth.run_slack_flow(client_id)
        _auth.save_token("slack", token)
        print("[auth] Slack authentication successful.")
    except Exception as e:
        print(f"[auth] Failed: {e}")
        sys.exit(1)
```

Also add `SLACK_CLIENT_ID=` as a blank entry to `.env` (the user fills it in).

- [ ] **Step 6: Run all tests**

```bash
python -m pytest tests/ -v
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add auth.py tests/test_auth.py digester.py .env
git commit -m "feat: add auth.py PKCE flow and digester auth slack command"
```

---

## Task 6: Slack source

**Files:**
- Create: `sources/slack.py`
- Create: `tests/sources/test_slack.py`

**Interfaces:**
- Consumes: `auth.load_token` (Task 5), `message.Message` (Task 1)
- Produces:
  - `sources.slack.SOURCE_NAME: str`
  - `sources.slack.fetch(settings: dict, processed_ids: set[str]) -> list[Message]`
  - `sources.slack.sync_labels(messages: list[Message], settings: dict) -> None` (no-op)
  - `sources.slack.sync_status(message_ids: list[str], old_status: str, new_status: str, settings: dict) -> None` (no-op)
  - `sources.slack._subject_from_body(channel_display: str, text: str) -> str` (tested directly)
  - `sources.slack._normalize_search_result(result: dict, user_id: str) -> Message` (tested directly)
  - `sources.slack._normalize_history_msg(msg: dict, user_id: str, channel_id: str, channel_display: str, is_direct: bool) -> Message` (tested directly)
  - `sources.slack._ts_to_iso(ts: str) -> str` (tested directly)

---

- [ ] **Step 1: Write the failing Slack tests**

Create `tests/sources/test_slack.py`:
```python
import sources.slack as slack_source


def test_subject_strips_mentions():
    result = slack_source._subject_from_body("#eng", "<@U123ABC> can you review this?")
    assert "<@U123ABC>" not in result
    assert result.startswith("#eng:")


def test_subject_truncates_to_80():
    long_text = "a" * 200
    result = slack_source._subject_from_body("#eng", long_text)
    # channel prefix + ": " + up to 80 chars of body
    assert len(result) <= len("#eng: ") + 80 + 1  # +1 for ellipsis char


def test_subject_strips_newlines():
    result = slack_source._subject_from_body("#eng", "line one\nline two\nline three")
    assert "\n" not in result


def test_ts_to_iso():
    result = slack_source._ts_to_iso("1750240800.000000")
    assert result.startswith("2025")  # approximate — confirms conversion happened
    assert "T" in result


def test_normalize_search_result_fields():
    result = {
        "channel": {"id": "C123ABC", "name": "eng-backend"},
        "ts": "1750240800.123456",
        "thread_ts": "1750240700.000000",
        "text": "hey <@U456ME> can you review this PR?",
        "permalink": "https://slack.com/archives/C123ABC/p1750240800123456",
        "user": "U789OTHER",
    }
    msg = slack_source._normalize_search_result(result, "U456ME")
    assert msg["id"] == "slack:C123ABC:1750240800.123456"
    assert msg["source"] == "slack"
    assert msg["channel"] == "#eng-backend"
    assert msg["is_direct"] is False
    assert msg["mentions_me"] is True
    assert msg["thread_id"] == "1750240700.000000"
    assert msg["url"] == "https://slack.com/archives/C123ABC/p1750240800123456"
    assert "<@U456ME>" not in msg["subject"]


def test_normalize_search_result_not_mention():
    result = {
        "channel": {"id": "C123ABC", "name": "eng"},
        "ts": "1750240800.000000",
        "thread_ts": "1750240800.000000",
        "text": "just a message with no mention",
        "permalink": "https://slack.com/x",
        "user": "U789OTHER",
    }
    msg = slack_source._normalize_search_result(result, "U456ME")
    assert msg["mentions_me"] is False


def test_normalize_history_msg_dm():
    msg = {
        "ts": "1750240800.000000",
        "thread_ts": "1750240800.000000",
        "text": "hey quick question",
        "user": "U789OTHER",
    }
    result = slack_source._normalize_history_msg(
        msg, user_id="U456ME", channel_id="D111DM",
        channel_display="@Bob", is_direct=True,
    )
    assert result["is_direct"] is True
    assert result["channel"] == "@Bob"
    assert result["id"] == "slack:D111DM:1750240800.000000"
```

- [ ] **Step 2: Run to verify tests fail**

```bash
python -m pytest tests/sources/test_slack.py -v
```
Expected: `ERROR — No module named 'sources.slack'`

- [ ] **Step 3: Create `sources/slack.py`**

```python
import re
from datetime import datetime, timedelta, timezone

from message import Message
import auth

SOURCE_NAME = "slack"


def fetch(settings: dict, processed_ids: set[str]) -> list[Message]:
    token = auth.load_token("slack")
    if not token:
        raise RuntimeError("Slack not authenticated. Run: digester auth slack")

    from slack_sdk import WebClient
    client = WebClient(token=token)

    me = client.auth_test()
    user_id = me["user_id"]

    days_back = settings.get("slack_days_back", settings.get("days_back", 30))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    after_date = cutoff.strftime("%Y-%m-%d")
    oldest_ts = str(cutoff.timestamp())

    seen: dict[str, Message] = {}

    _fetch_dms(client, user_id, oldest_ts, processed_ids, seen)
    _fetch_mentions(client, user_id, after_date, processed_ids, seen)
    _fetch_participated_threads(client, user_id, after_date, processed_ids, seen)

    return list(seen.values())


def sync_labels(messages: list[Message], settings: dict) -> None:
    pass  # Slack has no label system


def sync_status(message_ids: list[str], old_status: str, new_status: str, settings: dict) -> None:
    pass  # Slack has no status sync


def _fetch_dms(client, user_id: str, oldest_ts: str, processed_ids: set[str], seen: dict):
    from slack_sdk.errors import SlackApiError
    try:
        resp = client.conversations_list(types="im,mpim")
    except SlackApiError:
        return
    for channel in resp.get("channels", []):
        channel_id = channel["id"]
        is_dm = channel.get("is_im", False)
        dm_partner = _dm_display_name(client, channel, user_id) if is_dm else channel.get("name", channel_id)
        channel_display = f"@{dm_partner}" if is_dm else f"#{dm_partner}"

        cursor = None
        while True:
            hist = client.conversations_history(
                channel=channel_id, oldest=oldest_ts, cursor=cursor, limit=200
            )
            for msg in hist.get("messages", []):
                if msg.get("subtype"):
                    continue  # skip system messages
                mid = f"slack:{channel_id}:{msg['ts']}"
                if mid in processed_ids or mid in seen:
                    continue
                seen[mid] = _normalize_history_msg(
                    msg, user_id=user_id, channel_id=channel_id,
                    channel_display=channel_display, is_direct=is_dm,
                )
            if not hist.get("has_more"):
                break
            cursor = hist["response_metadata"]["next_cursor"]


def _fetch_mentions(client, user_id: str, after_date: str, processed_ids: set[str], seen: dict):
    from slack_sdk.errors import SlackApiError
    try:
        resp = client.search_messages(
            query=f"<@{user_id}> after:{after_date}",
            sort="timestamp", count=100,
        )
    except SlackApiError:
        return
    for match in resp.get("messages", {}).get("matches", []):
        mid = f"slack:{match['channel']['id']}:{match['ts']}"
        if mid in processed_ids or mid in seen:
            continue
        seen[mid] = _normalize_search_result(match, user_id)


def _fetch_participated_threads(client, user_id: str, after_date: str, processed_ids: set[str], seen: dict):
    from slack_sdk.errors import SlackApiError
    try:
        resp = client.search_messages(
            query=f"from:@me after:{after_date}",
            sort="timestamp", count=100,
        )
    except SlackApiError:
        return
    for match in resp.get("messages", {}).get("matches", []):
        channel_id = match["channel"]["id"]
        thread_ts = match.get("thread_ts") or match["ts"]
        my_ts = float(match["ts"])

        # Fetch the thread to find replies from others after our last message
        try:
            thread_resp = client.conversations_replies(
                channel=channel_id, ts=thread_ts, limit=200
            )
        except SlackApiError:
            continue

        for reply in thread_resp.get("messages", []):
            if reply.get("user") == user_id:
                continue  # skip our own messages
            reply_ts = float(reply["ts"])
            if reply_ts <= my_ts:
                continue  # only surface replies after our last message
            mid = f"slack:{channel_id}:{reply['ts']}"
            if mid in processed_ids or mid in seen:
                continue
            channel_display = f"#{match['channel'].get('name', channel_id)}"
            seen[mid] = _normalize_history_msg(
                reply, user_id=user_id, channel_id=channel_id,
                channel_display=channel_display, is_direct=False,
            )


def _normalize_search_result(result: dict, user_id: str) -> Message:
    channel_id = result["channel"]["id"]
    channel_name = result["channel"].get("name", channel_id)
    channel_display = f"#{channel_name}"
    ts = result["ts"]
    thread_ts = result.get("thread_ts") or ts
    text = result.get("text", "")

    return {
        "id": f"slack:{channel_id}:{ts}",
        "source": SOURCE_NAME,
        "subject": _subject_from_body(channel_display, text),
        "author": result.get("user", ""),
        "body": text,
        "timestamp": _ts_to_iso(ts),
        "url": result.get("permalink", ""),
        "thread_id": thread_ts,
        "channel": channel_display,
        "is_direct": False,
        "mentions_me": f"<@{user_id}>" in text,
    }


def _normalize_history_msg(
    msg: dict, user_id: str, channel_id: str, channel_display: str, is_direct: bool
) -> Message:
    ts = msg["ts"]
    thread_ts = msg.get("thread_ts") or ts
    text = msg.get("text", "")

    return {
        "id": f"slack:{channel_id}:{ts}",
        "source": SOURCE_NAME,
        "subject": _subject_from_body(channel_display, text),
        "author": msg.get("user", ""),
        "body": text,
        "timestamp": _ts_to_iso(ts),
        "url": "",  # permalink requires an extra API call; omit for history messages
        "thread_id": thread_ts,
        "channel": channel_display,
        "is_direct": is_direct,
        "mentions_me": f"<@{user_id}>" in text,
    }


def _subject_from_body(channel_display: str, text: str) -> str:
    clean = re.sub(r"<@[A-Z0-9]+>", "", text)
    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) > 80:
        clean = clean[:79] + "…"
    return f"{channel_display}: {clean}"


def _ts_to_iso(ts: str) -> str:
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except Exception:
        return ts


def _dm_display_name(client, channel: dict, user_id: str) -> str:
    """Resolve DM partner display name from the channel object."""
    from slack_sdk.errors import SlackApiError
    # For IM channels, the other user is in channel["user"]
    other_user_id = channel.get("user", "")
    if not other_user_id or other_user_id == user_id:
        return channel.get("id", "unknown")
    try:
        resp = client.users_info(user=other_user_id)
        profile = resp["user"].get("profile", {})
        return profile.get("display_name") or profile.get("real_name") or other_user_id
    except SlackApiError:
        return other_user_id
```

- [ ] **Step 4: Run Slack tests to verify pass**

```bash
python -m pytest tests/sources/test_slack.py -v
```
Expected: `8 passed`

- [ ] **Step 5: Run all tests**

```bash
python -m pytest tests/ -v
```
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add sources/slack.py tests/sources/test_slack.py
git commit -m "feat: add sources/slack.py with DM/mention/thread fetch and normalization"
```

---

## Task 7: Wire Slack into digester + requirements

**Files:**
- Modify: `digester.py` — activate Slack source in `_active_sources`
- Modify: `requirements.txt` — add `slack-sdk`

**Interfaces:**
- Consumes: `sources.slack.SOURCE_NAME`, `fetch`, `sync_labels`, `sync_status` (Task 6), `auth.load_token` (Task 5)

---

- [ ] **Step 1: Add `slack-sdk` to `requirements.txt`**

Append to `requirements.txt`:
```
slack-sdk==3.35.0
```

Install:
```bash
pip install slack-sdk==3.35.0
```
Expected: `Successfully installed slack-sdk-3.35.0`

- [ ] **Step 2: Update `_active_sources` in `digester.py`**

Replace the `_active_sources` function:

```python
def _active_sources(settings: dict) -> list:
    """Return source modules whose credentials are configured."""
    import auth as _auth
    sources_list = [_email_source]
    if _auth.load_token("slack"):
        import sources.slack as _slack_source
        sources_list.append(_slack_source)
    return sources_list
```

- [ ] **Step 3: Run all tests**

```bash
python -m pytest tests/ -v
```
Expected: all pass

- [ ] **Step 4: Manual smoke test — show command still works**

```bash
python digester.py show
```
Expected: digest renders without error (existing tasks from state.json display correctly)

- [ ] **Step 5: Commit**

```bash
git add digester.py requirements.txt
git commit -m "feat: activate Slack source in digester; add slack-sdk dependency"
```

---

## Setup: Register Slack redirect URI

Before running `digester auth slack`, the Slack app must have `http://localhost:9119/callback` registered as a redirect URI.

1. Go to `api.slack.com/apps` → open the whoneedsme app (ID: A0APMAVR3EX)
2. **OAuth & Permissions → Redirect URLs** → Add `http://localhost:9119/callback`
3. **OAuth & Permissions → User Token Scopes** → verify all scopes from Task 6 are present:
   `search:read, channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, users:read`
4. Add `SLACK_CLIENT_ID=<client-id-from-app-page>` to `.env`
5. Run `python digester.py auth slack` — browser opens, authorize, token saved to `~/.config/digester/tokens.yaml`
6. Run `python digester.py run` — both email and Slack sources activate
