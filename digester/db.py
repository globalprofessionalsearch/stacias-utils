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
            "contacts": em.get("contacts", []),
            "category": em.get("category"),
            "task_id": tid,
            "url": em.get("url", em.get("gmail_link", "")),
            "body": em.get("body_snippet", ""),
            "channel": em.get("channel", "inbox"),
            "thread_id": em.get("thread_id", ""),
            "source": em.get("source", "email"),
            "received_at": em.get("received_at", ""),
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
    result = set()
    for id, em in state["messages"].items():
        if em.get("seen") or em.get("addressed"):
            constituents = em.get("constituent_ids")
            result.update(constituents if constituents else [id])
    return result


def upsert_message(
    id, source, subject, author, received_at,
    category=None, task_id=None, skipped=0,
    url=None, body_snippet="", channel="inbox", thread_id="",
    constituent_ids=None, contacts=None,
):
    state = _load()
    existing = state["messages"].get(id, {})
    state["messages"][id] = {
        **existing,
        "source": source,
        "subject": subject,
        "author": author,
        "contacts": contacts or [],
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
        "constituent_ids": constituent_ids or [],
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


def get_last_run_at() -> str | None:
    state = _load()
    return state.get("meta", {}).get("last_run_at")


def set_last_run_at():
    state = _load()
    state.setdefault("meta", {})["last_run_at"] = datetime.utcnow().isoformat()
    _save(state)


def get_tasks_since(iso_ts: str) -> set[str]:
    state = _load()
    return {
        tid for tid, task in state["tasks"].items()
        if task.get("created_at", "") >= iso_ts
    }


def get_message_sources(message_ids: list[str]) -> dict[str, str]:
    """Return {msg_id: source_name} for a list of message IDs."""
    state = _load()
    return {
        mid: state["messages"].get(mid, {}).get("source", "email")
        for mid in message_ids
    }
