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
