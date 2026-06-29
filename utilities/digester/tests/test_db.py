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


def test_get_last_run_at_returns_none_when_not_set(empty_state):
    assert db.get_last_run_at() is None


def test_set_last_run_at_persists(empty_state):
    db.set_last_run_at()
    val = db.get_last_run_at()
    assert val is not None
    assert "T" in val  # ISO format contains 'T' separator


def test_get_tasks_since_filters_by_created_at(empty_state):
    import json
    state = {
        "messages": {},
        "tasks": {
            "task-old": {"category": "pull_request", "created_at": "2020-01-01T00:00:00", "status": "pending", "priority": 1.0},
            "task-new": {"category": "pull_request", "created_at": "2026-06-01T00:00:00", "status": "pending", "priority": 2.0},
        },
        "warnings": [],
    }
    empty_state.write_text(json.dumps(state))

    result = db.get_tasks_since("2025-01-01T00:00:00")
    assert "task-new" in result
    assert "task-old" not in result


def test_get_tasks_since_returns_all_when_cutoff_is_early(empty_state):
    import json
    state = {
        "messages": {},
        "tasks": {
            "task-a": {"category": "pull_request", "created_at": "2026-06-01T00:00:00", "status": "pending", "priority": 1.0},
        },
        "warnings": [],
    }
    empty_state.write_text(json.dumps(state))

    result = db.get_tasks_since("2000-01-01T00:00:00")
    assert "task-a" in result
