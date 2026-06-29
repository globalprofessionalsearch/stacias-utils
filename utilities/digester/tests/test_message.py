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
