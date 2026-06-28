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
    _imap_id_map.clear()
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

    author = msg.get("From", "")
    return {
        "id": message_id,
        "source": SOURCE_NAME,
        "subject": _decode_header_value(msg.get("Subject", "")),
        "author": author,
        "contacts": [author] if author else [],
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
