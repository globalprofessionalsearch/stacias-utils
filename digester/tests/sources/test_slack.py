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


def test_normalize_search_result_dm():
    result = {
        "channel": {"id": "D111DM", "name": "bob"},
        "ts": "1750240800.000000",
        "thread_ts": "1750240800.000000",
        "text": "hey quick question",
        "permalink": "https://slack.com/x",
        "user": "U789OTHER",
    }
    msg = slack_source._normalize_search_result(result, "U456ME", is_direct=True)
    assert msg["is_direct"] is True
    assert msg["channel"] == "@bob"
    assert msg["id"] == "slack:D111DM:1750240800.000000"
