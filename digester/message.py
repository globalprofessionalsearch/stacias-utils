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
    contacts: NotRequired[list[str]]          # unique non-me participants, most recent first
    constituent_ids: NotRequired[list[str]]  # sub-message IDs; absent means [id]
    raw: NotRequired[dict]
