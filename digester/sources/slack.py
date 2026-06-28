import re
import time
from datetime import datetime, timedelta, timezone

from message import Message
import auth

SOURCE_NAME = "slack"


def _slack_call(fn, *args, **kwargs):
    """Call a Slack SDK method, retrying once on ratelimited with the Retry-After delay."""
    from slack_sdk.errors import SlackApiError
    while True:
        try:
            return fn(*args, **kwargs)
        except SlackApiError as e:
            if e.response.get("error") != "ratelimited":
                raise
            retry_after = int(e.response.headers.get("Retry-After", 1))
            print(f"  [slack] rate limited — waiting {retry_after}s...")
            time.sleep(retry_after)


def fetch(settings: dict, processed_ids: set[str]) -> list[Message]:
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError
    
    token = auth.load_token("slack")
    if not token:
        raise RuntimeError(
            "Slack not authenticated. Run: digester auth slack\n"
            "  (You'll need a Slack app with SLACK_CLIENT_ID in .env)"
        )

    client = WebClient(token=token)

    try:
        me = client.auth_test()
        user_id = me["user_id"]
    except SlackApiError as e:
        error_msg = e.response.get("error", "unknown")
        if error_msg in ("token_expired", "token_revoked", "invalid_auth", "not_authed"):
            raise RuntimeError(
                f"Slack authentication failed: {error_msg}\n"
                "  Your token has expired or been revoked.\n"
                "  Please re-authenticate: digester auth slack"
            ) from e
        raise RuntimeError(f"Slack API error during auth check: {error_msg}") from e

    days_back = settings.get("slack_days_back", settings.get("days_back", 30))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    after_date = cutoff.strftime("%Y-%m-%d")
    seen: dict[str, Message] = {}
    user_id_cache: dict[str, str] = {}

    print("  Fetching DMs...")
    _fetch_dms(client, user_id, after_date, processed_ids, seen)
    print(f"  Fetching @mentions...")
    _fetch_mentions(client, user_id, after_date, processed_ids, seen)
    print(f"  Fetching participated threads...")
    _fetch_participated_threads(client, user_id, after_date, processed_ids, seen)
    print(f"  Resolving author names...")
    _resolve_authors(client, list(seen.values()), user_id_cache)
    _build_transcripts(list(seen.values()), user_id_cache)
    print(f"  Collected {len(seen)} unprocessed Slack messages.")

    return list(seen.values())


def sync_labels(messages: list[Message], settings: dict) -> None:
    pass  # Slack has no label system


def sync_status(message_ids: list[str], old_status: str, new_status: str, settings: dict) -> None:
    pass  # Slack has no status sync


def _resolve_user_id(client, user_id: str, cache: dict) -> str:
    """Resolve a single Slack user ID to a display name, with caching."""
    from slack_sdk.errors import SlackApiError
    if user_id in cache:
        return cache[user_id]
    try:
        resp = _slack_call(client.users_info, user=user_id)
        profile = resp["user"].get("profile", {})
        name = profile.get("display_name") or profile.get("real_name") or user_id
    except SlackApiError:
        name = user_id
    cache[user_id] = name
    return name


def _resolve_authors(client, messages: list, user_id_cache: dict) -> None:
    """Resolve raw Slack user IDs in author and contacts fields to display names in-place."""
    for msg in messages:
        raw_id = msg.get("author", "")
        if raw_id and raw_id.startswith("U"):
            msg["author"] = _resolve_user_id(client, raw_id, user_id_cache)
        contacts = msg.get("contacts", [])
        if contacts:
            msg["contacts"] = [
                _resolve_user_id(client, c, user_id_cache) if c.startswith("U") else c
                for c in contacts
            ]


def _build_transcripts(messages: list, user_id_cache: dict) -> None:
    """Build body transcripts for consolidated messages using resolved author names."""
    for msg in messages:
        constituents = (msg.get("raw") or {}).get("constituents")
        if not constituents:
            continue
        lines = []
        for c in constituents:
            author = user_id_cache.get(c["user"], c["user"])
            lines.append(f"{author}: {c['text']}")
        msg["body"] = "\n".join(lines)


def _fetch_dms(client, user_id: str, after_date: str, processed_ids: set[str], seen: dict):
    from slack_sdk.errors import SlackApiError
    # -from:me: explicitly request incoming messages (is:dm alone returns only outgoing)
    all_matches = []
    page = 1
    while True:
        try:
            resp = _slack_call(
                client.search_messages,
                query=f"is:dm -from:me after:{after_date}",
                sort="timestamp", count=100, page=page,
            )
        except SlackApiError:
            return
        data = resp.get("messages", {})
        all_matches.extend(data.get("matches", []))
        total_pages = data.get("paging", {}).get("pages", 1)
        if page >= total_pages:
            break
        page += 1
    print(f"    Found {len(all_matches)} incoming DM messages.")

    # Group by channel, one consolidated Message per conversation
    by_channel: dict[str, list] = {}
    for m in all_matches:
        by_channel.setdefault(m["channel"]["id"], []).append(m)

    for channel_id, msgs in by_channel.items():
        msgs.sort(key=lambda m: float(m["ts"]))
        stable_id = f"slack:dm:{channel_id}"
        if stable_id in seen:
            continue

        constituent_ids = [f"slack:{channel_id}:{m['ts']}" for m in msgs]
        if all(cid in processed_ids for cid in constituent_ids):
            continue

        channel_name = msgs[0]["channel"].get("name", channel_id)
        channel_display = f"@{channel_name}"

        # DM has exactly one other party; preserve insertion order (most recent first)
        other_users = list(dict.fromkeys(
            m["user"] for m in reversed(msgs) if m.get("user") and m["user"] != user_id
        ))
        seen[stable_id] = {
            "id": stable_id,
            "source": SOURCE_NAME,
            "subject": _subject_from_body(channel_display, msgs[-1].get("text", "")),
            "author": msgs[-1].get("user", ""),
            "contacts": other_users,
            "body": "",  # filled by _build_transcripts after author resolution
            "timestamp": _ts_to_iso(msgs[-1]["ts"]),
            "url": msgs[-1].get("permalink", ""),
            "thread_id": "",
            "channel": channel_display,
            "is_direct": True,
            "mentions_me": any(f"<@{user_id}>" in m.get("text", "") for m in msgs),
            "constituent_ids": constituent_ids,
            "raw": {"constituents": [
                {"user": m.get("user", ""), "text": m.get("text", ""), "ts": m["ts"]}
                for m in msgs
            ]},
        }


def _fetch_mentions(client, user_id: str, after_date: str, processed_ids: set[str], seen: dict):
    from slack_sdk.errors import SlackApiError
    try:
        resp = _slack_call(
            client.search_messages,
            query=f"<@{user_id}> after:{after_date}",
            sort="timestamp", count=100,
        )
    except SlackApiError:
        return
    matches = resp.get("messages", {}).get("matches", [])
    print(f"    Found {len(matches)} mention(s).")
    for match in matches:
        mid = f"slack:{match['channel']['id']}:{match['ts']}"
        if mid in processed_ids or mid in seen:
            continue
        msg = _normalize_search_result(match, user_id)
        sender = match.get("user", "")
        msg["contacts"] = [sender] if sender else []
        seen[mid] = msg


def _fetch_participated_threads(client, user_id: str, after_date: str, processed_ids: set[str], seen: dict):
    from slack_sdk.errors import SlackApiError
    try:
        resp = _slack_call(
            client.search_messages,
            query=f"from:me after:{after_date}",
            sort="timestamp", count=100,
        )
    except SlackApiError:
        return
    matches = resp.get("messages", {}).get("matches", [])
    print(f"    Found {len(matches)} thread(s) to check.")
    for i, match in enumerate(matches, 1):
        channel_id = match["channel"]["id"]
        thread_ts = match.get("thread_ts") or match["ts"]
        channel_name = match["channel"].get("name", channel_id)
        stable_id = f"slack:thread:{channel_id}:{thread_ts}"
        print(f"    Thread {i}/{len(matches)}: #{channel_name}")

        if stable_id in seen:
            continue

        try:
            thread_resp = _slack_call(
                client.conversations_replies,
                channel=channel_id, ts=thread_ts, limit=200
            )
        except SlackApiError:
            continue

        thread_msgs = [m for m in thread_resp.get("messages", []) if not m.get("subtype")]
        if not thread_msgs:
            continue

        # Only surface threads with replies from others after the user's last message
        user_tss = [float(m["ts"]) for m in thread_msgs if m.get("user") == user_id]
        my_ts = max(user_tss) if user_tss else 0.0
        pending_replies = [m for m in thread_msgs
                           if m.get("user") != user_id and float(m["ts"]) > my_ts]
        if not pending_replies:
            continue

        constituent_ids = [f"slack:{channel_id}:{m['ts']}" for m in pending_replies]
        if all(cid in processed_ids for cid in constituent_ids):
            continue

        channel_display = f"#{channel_name}"

        # Unique non-me participants, most recent first
        other_users = list(dict.fromkeys(
            m["user"] for m in reversed(thread_msgs)
            if m.get("user") and m["user"] != user_id
        ))

        seen[stable_id] = {
            "id": stable_id,
            "source": SOURCE_NAME,
            "subject": _subject_from_body(channel_display, thread_msgs[0].get("text", "")),
            "author": pending_replies[-1].get("user", ""),
            "contacts": other_users,
            "body": "",  # filled by _build_transcripts after author resolution
            "timestamp": _ts_to_iso(pending_replies[-1]["ts"]),
            "url": match.get("permalink", ""),
            "thread_id": thread_ts,
            "channel": channel_display,
            "is_direct": False,
            "mentions_me": any(f"<@{user_id}>" in m.get("text", "") for m in pending_replies),
            "constituent_ids": constituent_ids,
            "raw": {"constituents": [
                {"user": m.get("user", ""), "text": m.get("text", ""), "ts": m["ts"]}
                for m in thread_msgs  # full thread for context
            ]},
        }


def _normalize_search_result(result: dict, user_id: str, is_direct: bool = False) -> Message:
    channel_id = result["channel"]["id"]
    channel_name = result["channel"].get("name", channel_id)
    channel_display = f"@{channel_name}" if is_direct else f"#{channel_name}"
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


