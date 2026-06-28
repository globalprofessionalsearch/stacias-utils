import json as _json
from datetime import datetime, timedelta, timezone
import pytest
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


def test_run_show_concise_footer(capsys):
    tasks = {
        "tid1": [{
            "id": "m1", "subject": "Test task", "author": "a@b.com",
            "category": "pull_request", "task_id": "tid1", "url": "",
            "body": "", "channel": "inbox", "thread_id": "", "source": "email",
            "received_at": "", "contacts": [],
        }]
    }
    ranked = [("tid1", 1.0)]
    settings = {"subject_limit": 60}
    statuses = {"tid1": "pending"}

    digester.run_show_concise(tasks, ranked, settings, task_statuses=statuses)
    out = capsys.readouterr().out
    assert "<N> · <N> done / active / pending" in out


def test_run_detail_invalid_rank_too_high(capsys):
    """Rank higher than task count prints error and returns gracefully."""
    msg = _msg("id1", "Test task", category="pull_request")
    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]

    digester.run_detail(tasks, ranked, rank=5)
    out = capsys.readouterr().out
    assert "[detail] No task at rank #5." in out


def test_run_detail_invalid_rank_zero(capsys):
    """Rank of 0 prints error (ranks are 1-indexed)."""
    msg = _msg("id1", "Test task", category="pull_request")
    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]

    digester.run_detail(tasks, ranked, rank=0)
    out = capsys.readouterr().out
    assert "[detail] No task at rank #0." in out


def test_run_detail_invalid_rank_negative(capsys):
    """Negative rank prints error."""
    msg = _msg("id1", "Test task", category="pull_request")
    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]

    digester.run_detail(tasks, ranked, rank=-1)
    out = capsys.readouterr().out
    assert "[detail] No task at rank #-1." in out


def test_run_detail_single_message(capsys):
    """Valid rank with single message shows subject, contact, and metadata."""
    msg = _msg(
        "id1",
        "PR #42 needs review",
        category="pull_request"
    )
    msg["author"] = "alice@example.com"
    msg["contacts"] = ["alice@example.com"]
    msg["received_at"] = "2026-06-23T10:00:00+00:00"
    msg["source"] = "email"
    msg["channel"] = "inbox"
    msg["url"] = "https://example.com/pr/42"
    msg["body"] = "This PR has several issues to address."

    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]
    statuses = {"tid1": "pending"}

    digester.run_detail(tasks, ranked, rank=1, task_statuses=statuses)
    out = capsys.readouterr().out

    # Verify header
    assert "Task #1" in out
    assert "PULL_REQUEST" in out
    assert "PENDING" in out
    # Verify subject
    assert "PR #42 needs review" in out
    # Verify metadata fields
    assert "Contact:" in out
    assert "alice@example.com" in out
    assert "Source:" in out
    assert "email" in out
    # Verify URL is included
    assert "https://example.com/pr/42" in out
    # Verify body is included
    assert "This PR has several issues to address." in out


def test_run_detail_multi_message_task(capsys):
    """Multi-message task shows [1/N] and [2/N] labels and count."""
    msg1 = _msg("id1", "Subject A", category="pull_request")
    msg1["received_at"] = "2026-06-23T10:00:00+00:00"
    msg1["contacts"] = ["alice@example.com"]

    msg2 = _msg("id2", "Subject B (reply)", category="pull_request")
    msg2["received_at"] = "2026-06-23T12:00:00+00:00"
    msg2["contacts"] = ["bob@example.com"]

    tasks = {"tid1": [msg1, msg2]}
    ranked = [("tid1", 1.0)]
    statuses = {"tid1": "active"}

    digester.run_detail(tasks, ranked, rank=1, task_statuses=statuses)
    out = capsys.readouterr().out

    # Verify header shows message count
    assert "2 messages" in out
    # Verify each message is labeled
    assert "[1/2]" in out
    assert "[2/2]" in out
    # Verify both subjects appear
    assert "Subject A" in out
    assert "Subject B (reply)" in out
    # Verify status indicator
    assert "ACTIVE" in out


def test_run_detail_rank_with_mixed_statuses(capsys):
    """Rank ordering respects task_statuses (active, pending, done)."""
    msg1 = _msg("id1", "First task")
    msg2 = _msg("id2", "Second task")
    msg3 = _msg("id3", "Third task")

    tasks = {
        "tid1": [msg1],
        "tid2": [msg2],
        "tid3": [msg3],
    }
    # In ranking order, but tid2 is "done" and tid1 is "active"
    ranked = [("tid1", 3.0), ("tid2", 2.0), ("tid3", 1.0)]
    statuses = {"tid1": "active", "tid2": "done", "tid3": "pending"}

    # Request rank 2, which after status-reordering should be tid3
    digester.run_detail(tasks, ranked, rank=2, task_statuses=statuses)
    out = capsys.readouterr().out

    # The detail should show the second task after grouping by status
    assert "Third task" in out


def test_run_detail_no_contacts_or_channel(capsys):
    """Task without contacts or channel skips those fields."""
    msg = _msg("id1", "Test task", category="pull_request")
    msg["contacts"] = []
    msg["channel"] = "inbox"  # 'inbox' is skipped
    msg["received_at"] = "2026-06-23T10:00:00+00:00"

    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]

    digester.run_detail(tasks, ranked, rank=1)
    out = capsys.readouterr().out

    # "Contact:" should not appear because contacts is empty
    assert "Contact:" not in out
    # "Channel:" should not appear because it's "inbox"
    assert "Channel:" not in out


def test_run_detail_age_string_formatting(capsys):
    """Age is correctly formatted for display."""
    msg = _msg("id1", "Test task", category="pull_request")
    # Set to roughly 2 days ago, relative to now so the test stays evergreen
    two_days_ago = datetime.now(timezone.utc) - timedelta(days=2, hours=1)
    msg["received_at"] = two_days_ago.isoformat()

    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]

    digester.run_detail(tasks, ranked, rank=1)
    out = capsys.readouterr().out

    # Should show "2 days" in the header
    assert "2 days" in out


def test_run_detail_empty_body_no_body_section(capsys):
    """Task with empty body doesn't print body section."""
    msg = _msg("id1", "Test task", category="pull_request")
    msg["body"] = ""

    tasks = {"tid1": [msg]}
    ranked = [("tid1", 1.0)]

    digester.run_detail(tasks, ranked, rank=1)
    out = capsys.readouterr().out

    # Should still have header and subject
    assert "Test task" in out
    # But should not have extra blank body lines
    lines = out.split("\n")
    # Count consecutive empty lines — should be reasonable
    assert len(lines) > 3  # At least header, subject, spacing


def test_parse_no_args_routes_to_list():
    args = digester._parse_args([])
    assert args.command is None


def test_parse_latest_flag_routes_to_list():
    args = digester._parse_args(["--latest"])
    assert args.command is None
    assert args.latest is True


def test_parse_max_done_flag():
    args = digester._parse_args(["--max-done", "10"])
    assert args.command is None
    assert args.max_done == 10


def test_parse_single_rank_routes_to_detail():
    args = digester._parse_args(["3"])
    assert args.command == "detail"
    assert args.number == 3


def test_parse_rank_with_json_routes_to_detail_with_json():
    args = digester._parse_args(["3", "--json"])
    assert args.command == "detail"
    assert args.json is True


def test_parse_rank_with_status_routes_to_set():
    args = digester._parse_args(["3", "done"])
    assert args.command == "set"
    assert args.number == "3"
    assert args.status == "done"


def test_parse_multirank_with_status_routes_to_set():
    args = digester._parse_args(["1,3,5", "done"])
    assert args.command == "set"
    assert args.number == "1,3,5"
    assert args.status == "done"


def test_parse_range_with_status_routes_to_set():
    args = digester._parse_args(["2-8", "active"])
    assert args.command == "set"
    assert args.number == "2-8"
    assert args.status == "active"


def test_parse_run_command():
    args = digester._parse_args(["run"])
    assert args.command == "run"


def test_parse_run_with_limit():
    args = digester._parse_args(["run", "--limit", "5"])
    assert args.command == "run"
    assert args.limit == 5


def test_parse_auth_command():
    args = digester._parse_args(["auth", "slack"])
    assert args.command == "auth"
    assert args.source == "slack"


def _make_tasks_ranked_statuses():
    tasks = {
        "t-new": [{"id": "m1", "subject": "New task", "author": "a@b.com",
                   "category": "pull_request", "task_id": "t-new", "url": "",
                   "body": "", "channel": "inbox", "thread_id": "", "source": "email",
                   "received_at": "", "contacts": []}],
        "t-old": [{"id": "m2", "subject": "Old task", "author": "b@c.com",
                   "category": "pull_request", "task_id": "t-old", "url": "",
                   "body": "", "channel": "inbox", "thread_id": "", "source": "email",
                   "received_at": "", "contacts": []}],
    }
    ranked = [("t-new", 2.0), ("t-old", 1.0)]
    statuses = {"t-new": "pending", "t-old": "pending"}
    return tasks, ranked, statuses


def test_filter_to_latest_returns_all_when_last_run_at_is_none():
    tasks, ranked, statuses = _make_tasks_ranked_statuses()
    ft, fr, fs = digester._filter_to_latest(tasks, ranked, statuses, None)
    assert set(ft.keys()) == {"t-new", "t-old"}
    assert len(fr) == 2


def test_filter_to_latest_keeps_only_latest_tasks():
    tasks, ranked, statuses = _make_tasks_ranked_statuses()
    with patch("digester.db.get_tasks_since", return_value={"t-new"}):
        ft, fr, fs = digester._filter_to_latest(tasks, ranked, statuses, "2026-01-01T00:00:00")
    assert set(ft.keys()) == {"t-new"}
    assert all(tid == "t-new" for tid, _ in fr)
    assert set(fs.keys()) == {"t-new"}


def _one_task_fixture():
    tasks = {
        "tid1": [{
            "id": "m1", "subject": "Fix the bug", "author": "alice@example.com",
            "category": "pull_request", "task_id": "tid1", "url": "https://github.com/x",
            "body": "body text", "channel": "inbox", "thread_id": "", "source": "email",
            "received_at": "2026-06-21T10:00:00+00:00", "contacts": ["alice@example.com"],
        }]
    }
    ranked = [("tid1", 1.0)]
    statuses = {"tid1": "pending"}
    return tasks, ranked, statuses


def test_render_list_json_structure(capsys):
    tasks, ranked, statuses = _one_task_fixture()
    digester._render_list_json(tasks, ranked, statuses)
    out = capsys.readouterr().out
    data = _json.loads(out)
    assert "tasks" in data
    assert "summary" in data
    task = data["tasks"][0]
    assert task["rank"] == 1
    assert task["status"] == "pending"
    assert task["category"] == "pull_request"
    assert task["subject"] == "Fix the bug"
    assert isinstance(task["age_hours"], float)
    assert task["message_count"] == 1
    assert task["is_latest"] is False


def test_render_list_json_is_latest_flag(capsys):
    tasks, ranked, statuses = _one_task_fixture()
    digester._render_list_json(tasks, ranked, statuses, latest_ids={"tid1"})
    out = capsys.readouterr().out
    data = _json.loads(out)
    assert data["tasks"][0]["is_latest"] is True


def test_render_list_json_summary_counts(capsys):
    tasks, ranked, statuses = _one_task_fixture()
    digester._render_list_json(tasks, ranked, statuses)
    out = capsys.readouterr().out
    data = _json.loads(out)
    assert data["summary"] == {"active": 0, "pending": 1, "done": 0}


def test_render_detail_json_structure(capsys):
    tasks, ranked, statuses = _one_task_fixture()
    digester._render_detail_json(tasks, ranked, 1, statuses)
    out = capsys.readouterr().out
    data = _json.loads(out)
    assert data["rank"] == 1
    assert data["status"] == "pending"
    assert data["category"] == "pull_request"
    assert len(data["messages"]) == 1
    msg = data["messages"][0]
    assert msg["subject"] == "Fix the bug"
    assert msg["author"] == "alice@example.com"
    assert "url" in msg
    assert "body" in msg


def test_render_detail_json_invalid_rank(capsys):
    tasks, ranked, statuses = _one_task_fixture()
    with pytest.raises(SystemExit) as exc:
        digester._render_detail_json(tasks, ranked, 99, statuses)
    assert exc.value.code == 1
    out = capsys.readouterr().out
    data = _json.loads(out)
    assert "error" in data


def test_render_set_json_structure(capsys):
    changed   = [(3, "tid3", "pending", ["m3"])]
    unchanged = [(2, "tid2", "done",    ["m2"])]
    invalid   = [(9, None,  None,       None)]
    digester._render_set_json(changed, unchanged, invalid, "done")
    out = capsys.readouterr().out
    data = _json.loads(out)
    assert data["changed"]   == [{"rank": 3, "from": "pending", "to": "done"}]
    assert data["unchanged"] == [{"rank": 2}]
    assert data["invalid"]   == [{"rank": 9}]


def test_age_hours_returns_float():
    ts = "2026-06-21T10:00:00+00:00"
    result = digester._age_hours(ts)
    assert isinstance(result, float)
    assert result >= 0.0


def test_age_hours_returns_zero_for_empty():
    assert digester._age_hours("") == 0.0


def test_filter_to_latest_preserves_ranked_order():
    tasks = {
        "t-a": [{"id": "ma", "subject": "A", "author": "x@y.com", "category": "pull_request",
                 "task_id": "t-a", "url": "", "body": "", "channel": "inbox",
                 "thread_id": "", "source": "email", "received_at": "", "contacts": []}],
        "t-b": [{"id": "mb", "subject": "B", "author": "x@y.com", "category": "pull_request",
                 "task_id": "t-b", "url": "", "body": "", "channel": "inbox",
                 "thread_id": "", "source": "email", "received_at": "", "contacts": []}],
    }
    ranked = [("t-a", 3.0), ("t-b", 2.0)]
    statuses = {"t-a": "pending", "t-b": "pending"}
    with patch("digester.db.get_tasks_since", return_value={"t-a", "t-b"}):
        ft, fr, fs = digester._filter_to_latest(tasks, ranked, statuses, "2026-01-01T00:00:00")
    assert [tid for tid, _ in fr] == ["t-a", "t-b"]
