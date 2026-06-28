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
from datetime import datetime, timezone
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
    import auth as _auth
    sources_list = [_email_source]
    if _auth.load_token("slack"):
        import sources.slack as _slack_source
        sources_list.append(_slack_source)
    return sources_list


# ── Criteria formatters ───────────────────────────────────────────────────────

def _format_filter_criteria(cat_config: dict) -> str:
    parts = [cat_config["description"]]
    if signals := cat_config.get("signals"):
        parts.append(f"Signals: {signals}")
    if examples := cat_config.get("examples"):
        parts.append("Examples (score high):\n" + "\n".join(f"- {e}" for e in examples))
    if counter_examples := cat_config.get("counter_examples"):
        lines = [f"- {ce['text']} (reason: {ce['reason']})" for ce in counter_examples]
        parts.append("Not this (score low):\n" + "\n".join(lines))
    return "\n".join(parts)


def _format_group_criteria(group_config: dict) -> str:
    parts = [group_config["description"]]
    if dims := group_config.get("dimensions"):
        dim_str = ", ".join(f"{d['name']} ({d['description']})" for d in dims)
        parts.append(f"Dimensions: {dim_str}")
    if examples := group_config.get("examples"):
        lines = [f"- A: \"{e['a']}\" / B: \"{e['b']}\" ({e['reason']})" for e in examples]
        parts.append("Same task (score high):\n" + "\n".join(lines))
    if counter_examples := group_config.get("counter_examples"):
        lines = [f"- A: \"{ce['a']}\" / B: \"{ce['b']}\" ({ce['reason']})" for ce in counter_examples]
        parts.append("Not the same task (score low):\n" + "\n".join(lines))
    return "\n".join(parts)


def _format_prioritize_criteria(prioritize_config: dict) -> str:
    parts = [prioritize_config["description"].strip()]
    if dims := prioritize_config.get("dimensions"):
        dim_str = ", ".join(f"{d['name']} ({d['description']})" for d in dims)
        parts.append(f"Urgency factors: {dim_str}")
    if examples := prioritize_config.get("examples"):
        lines = [f"- A: \"{e['a']}\" / B: \"{e['b']}\" ({e['reason']})" for e in examples]
        parts.append("A more urgent than B (return positive):\n" + "\n".join(lines))
    if counter_examples := prioritize_config.get("counter_examples"):
        lines = [f"- A: \"{ce['a']}\" / B: \"{ce['b']}\" ({ce['reason']})" for ce in counter_examples]
        parts.append("B actually more urgent despite A's appearance (return negative):\n" + "\n".join(lines))
    return "\n".join(parts)


# ── Pipeline stages ──────────────────────────────────────────────────────────

def run_filter(messages: list[dict], config: dict, settings: dict, verbose: bool = True) -> list[dict]:
    if verbose:
        print(f"\n[filter] Evaluating {len(messages)} messages...")
    threshold = settings["filter_threshold"]
    subject_limit = settings["subject_limit"]
    results = []

    total = len(messages)
    for i, em in enumerate(messages, 1):
        pct = int(i / total * 100)
        payload = f"Subject: {em['subject']}\nFrom: {em['author']}\nBody:\n{em['body']}"
        best_score = 0.0
        best_category = None

        for cat_name, cat_config in config["filter"]["categories"].items():
            criteria = _format_filter_criteria(cat_config)
            s = scorer.score("filter", criteria, payload)
            if s is not None and s > best_score:
                best_score = s
                best_category = cat_name

        if best_score >= threshold and best_category:
            em["category"] = best_category
            if verbose:
                print(f"  ✓ [{best_category}] {em['subject'][:subject_limit]} ({best_score:.2f}) [{pct}%]")
        else:
            em["category"] = None
            if verbose:
                print(f"  ✗ [skip] {em['subject'][:subject_limit]} [{pct}%]")

        results.append(em)

    return results


def run_group(messages: list[dict], config: dict, settings: dict, seed_tasks: dict = None, verbose: bool = True) -> dict[str, list[dict]]:
    if verbose:
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
                    if verbose:
                        print(f"  → threaded '{msg['subject'][:subject_limit]}' into task {task_id[:8]} [{pct}%]")
                    break

        # LLM pairwise comparison for messages not matched by thread_id
        if not assigned:
            payload_a = f"Subject: {msg['subject']}\nFrom: {msg['author']}\nBody:\n{msg['body'][:body_limit]}"
            for task_id, task_msgs in tasks.items():
                rep = task_msgs[0]
                payload_b = f"Subject: {rep['subject']}\nFrom: {rep['author']}\nBody:\n{rep['body'][:body_limit]}"
                payload = f"Message A:\n{payload_a}\n\nMessage B:\n{payload_b}"
                s = scorer.score("group", criteria, payload)
                if s is not None and s >= threshold:
                    tasks[task_id].append(msg)
                    msg["task_id"] = task_id
                    assigned = True
                    if verbose:
                        print(f"  → grouped '{msg['subject'][:subject_limit]}' into task {task_id[:8]} [{pct}%]")
                    break

        if not assigned:
            task_id = str(uuid.uuid4())
            tasks[task_id] = [msg]
            msg["task_id"] = task_id
            if verbose:
                print(f"  + new task {task_id[:8]} for '{msg['subject'][:subject_limit]}' [{pct}%]")

    return tasks


def run_prioritize(tasks: dict[str, list[dict]], config: dict, settings: dict, verbose: bool = True) -> list[tuple[str, float]]:
    n = len(tasks)
    if verbose:
        print(f"\n[prioritize] Prioritizing {n} tasks...")
    body_limit = settings["prioritize_body_limit"]
    criteria = _format_prioritize_criteria(config["prioritize"])
    worst_case = n * (n - 1) // 2
    comparisons = 0

    def compare(id_a: str, id_b: str) -> int:
        nonlocal comparisons
        comparisons += 1
        if verbose and worst_case > 0:
            pct = min(int(comparisons / worst_case * 100), 99)
            print(f"  sorting... {pct}%", end="\r", flush=True)
        rep_a = tasks[id_a][0]
        rep_b = tasks[id_b][0]
        payload = (
            f"Task A:\nSubject: {rep_a['subject']}\nCategory: {rep_a.get('category')}\n"
            f"Body: {rep_a['body'][:body_limit]}\n\n"
            f"Task B:\nSubject: {rep_b['subject']}\nCategory: {rep_b.get('category')}\n"
            f"Body: {rep_b['body'][:body_limit]}"
        )
        s = scorer.score("prioritize", criteria, payload)
        if s is None:
            return 0
        return -1 if s > 0 else (1 if s < 0 else 0)  # higher score = more urgent = sort first

    task_ids = sorted(tasks.keys(), key=cmp_to_key(compare))
    if verbose and worst_case > 0:
        print(f"  sorting... 100%")
    ranked = [(tid, float(len(task_ids) - i)) for i, tid in enumerate(task_ids)]
    return ranked


def _link(url: str, text: str) -> str:
    """Wrap text in an OSC 8 terminal hyperlink (clickable in iTerm2, Terminal.app, VS Code)."""
    return f"\033]8;;{url}\033\\{text}\033]8;;\033\\"


def _clean(s: str) -> str:
    """Strip control characters (\\r, \\n, \\t) from a subject string."""
    return re.sub(r'[\r\n\t]+', ' ', s).strip()


def _age_str(ts: str) -> str:
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        hours = int(delta.total_seconds() // 3600)
        if hours < 1:
            return "< 1 hour"
        if hours < 24:
            return f"{hours} hour{'s' if hours > 1 else ''}"
        days = delta.days
        if days < 7:
            return f"{days} day{'s' if days > 1 else ''}"
        weeks = days // 7
        if weeks < 5:
            return f"{weeks} week{'s' if weeks > 1 else ''}"
        months = days // 30
        if months < 12:
            return f"{months} month{'s' if months > 1 else ''}"
        years = days // 365
        return f"{years} year{'s' if years > 1 else ''}"
    except (ValueError, TypeError):
        return ""


def _age_hours(ts: str) -> float:
    if not ts:
        return 0.0
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        return round(delta.total_seconds() / 3600, 1)
    except (ValueError, TypeError):
        return 0.0


def _contacts_str(msgs: list) -> str:
    """Primary contact from the task's messages, with +N for additional participants."""
    seen: dict[str, None] = {}
    for msg in msgs:
        for c in msg.get("contacts", []):
            if c:
                seen[c] = None
    contacts = list(seen.keys())
    if not contacts:
        return ""
    primary = contacts[0]
    others = len(contacts) - 1
    return f"{primary}  +{others}" if others else primary


def _oldest_ts(msgs: list) -> str:
    candidates = [m.get("received_at", "") for m in msgs if m.get("received_at")]
    return min(candidates) if candidates else ""


def _render_list_json(tasks: dict, ranked: list, statuses: dict, latest_ids: set | None = None):
    import json as _json
    latest_ids = latest_ids or set()
    task_list = []
    for rank, (tid, _) in enumerate(_grouped(ranked, statuses), 1):
        msgs = tasks[tid]
        rep  = msgs[0]
        task_list.append({
            "rank":          rank,
            "id":            tid,
            "status":        statuses.get(tid, "pending"),
            "category":      rep.get("category", "unknown"),
            "subject":       _clean(rep["subject"]),
            "age_hours":     _age_hours(_oldest_ts(msgs)),
            "message_count": len(msgs),
            "contacts":      list({c for m in msgs for c in m.get("contacts", []) if c}),
            "is_latest":     tid in latest_ids,
        })
    summary = {s: sum(1 for v in statuses.values() if v == s) for s in ("active", "pending", "done")}
    print(_json.dumps({"tasks": task_list, "summary": summary}))


def _render_detail_json(tasks: dict, ranked: list, rank: int, statuses: dict):
    import json as _json
    grouped_ranked = _grouped(ranked, statuses)
    if rank < 1 or rank > len(grouped_ranked):
        print(_json.dumps({"error": f"No task at rank #{rank}"}))
        sys.exit(1)
    tid, _ = grouped_ranked[rank - 1]
    msgs   = tasks[tid]
    rep    = msgs[0]
    print(_json.dumps({
        "rank":     rank,
        "id":       tid,
        "status":   statuses.get(tid, "pending"),
        "category": rep.get("category", "unknown"),
        "messages": [
            {
                "subject":     _clean(m["subject"]),
                "author":      m.get("author", ""),
                "received_at": m.get("received_at", ""),
                "url":         m.get("url", ""),
                "body":        m.get("body", ""),
            }
            for m in msgs
        ],
    }))


def _render_set_json(changed: list, unchanged: list, invalid: list, status: str):
    import json as _json
    print(_json.dumps({
        "changed":   [{"rank": r, "from": o, "to": status} for r, t, o, m in changed],
        "unchanged": [{"rank": r}                           for r, t, o, m in unchanged],
        "invalid":   [{"rank": r}                           for r, *_      in invalid],
    }))


_STATUS_ORDER  = {"active": 0, "pending": 1, "done": 2}
_SECTION_LABEL = {"active": "▶ ACTIVE", "pending": "  PENDING", "done": "✓ DONE"}
_W = 56

_TTY = sys.stdout.isatty()


def _a(code: str) -> str:
    """Return an ANSI escape code only when stdout is a real terminal."""
    return code if _TTY else ""


# Palette — blue/cyan/yellow/gray: safe for red-green colorblindness
_RST = "\033[0m"
_BLD = "\033[1m"
_CYN = "\033[96m"   # bright cyan  — box borders, rank numbers, → arrows
_BLU = "\033[94m"   # bright blue  — category labels
_YLW = "\033[93m"   # bright yellow — active section, ★/▶ markers, [N] counts
_GRY = "\033[90m"   # dark gray    — done items, sender lines

_SECTION_COLOR = {"active": _YLW + _BLD, "pending": "", "done": _GRY}
_SUBJ_COLOR    = {"active": _BLD,         "pending": "", "done": _GRY}


def _grouped(ranked, task_statuses):
    return sorted(ranked, key=lambda x: _STATUS_ORDER.get(task_statuses.get(x[0], "pending"), 1))


def _box_header(title: str):
    inner_w = _W - 2
    b = _a(_CYN)
    r = _a(_RST)
    print(f"{b}╔{'═' * inner_w}╗{r}")
    print(f"{b}║{r}{'  ' + title:{inner_w}}{b}║{r}")
    print(f"{b}╚{'═' * inner_w}╝{r}")


def _section_banner(status: str):
    label = _SECTION_LABEL.get(status, status.upper())
    color = _SECTION_COLOR.get(status, "")
    fill = "─" * (_W - len(label) - 1)
    print(f"\n{_a(color)}{label} {fill}{_a(_RST)}")


def run_show_concise(tasks: dict[str, list[dict]], ranked: list[tuple[str, float]], settings: dict, task_statuses: dict = None, max_done: int = 5):
    task_statuses = task_statuses or {}
    n = sum(1 for tid in tasks if task_statuses.get(tid, "pending") != "done")

    _box_header(f"DIGESTER  ·  {n} task{'s' if n != 1 else ''}")

    _CAT_W = 17  # widest built-in category: REPO_NOTIFICATION
    _AGE_W = 9   # widest age string: "11 months"
    # 2 (indent) + 4 (rank) + 1 + 17 (cat) + 2 + 9 (age) + 2 + subject + count
    cols = shutil.get_terminal_size((80, 24)).columns
    concise_limit = max(20, cols - 37)

    grouped_ranked = _grouped(ranked, task_statuses)
    done_total = sum(1 for tid, _ in grouped_ranked if task_statuses.get(tid, "pending") == "done")
    done_shown = 0
    current_section = None

    for rank, (task_id, _) in enumerate(grouped_ranked, 1):
        msgs = tasks[task_id]
        rep = msgs[0]
        status = task_statuses.get(task_id, "pending")
        n_emails = len(msgs)

        if status == "done":
            done_shown += 1
            if done_shown > max_done:
                continue

        if status != current_section:
            current_section = status
            _section_banner(status)

        category = rep.get("category", "?").upper()
        age      = _age_str(_oldest_ts(msgs))
        contacts = _contacts_str(msgs)
        subject  = _clean(rep["subject"])
        if len(subject) > concise_limit:
            subject = subject[:concise_limit - 1] + "…"
        rank_col   = f"#{rank}".ljust(4)
        rank_s     = f"{_a(_CYN)}{rank_col}{_a(_RST)}"
        cat_s      = f"{_a(_BLU)}{category.ljust(_CAT_W)}{_a(_RST)}"
        age_s      = f"{_a(_GRY)}{age.ljust(_AGE_W)}{_a(_RST)}"
        subj_color = _SUBJ_COLOR.get(status, "")
        subj_s     = f"{_a(subj_color)}{subject}{_a(_RST)}"
        count_s    = f"  {_a(_YLW)}[{n_emails}]{_a(_RST)}" if n_emails > 1 else ""
        print(f"  {rank_s} {cat_s}  {age_s}  {subj_s}{count_s}")
        if contacts:
            print(f"       {_a(_GRY)}{contacts}{_a(_RST)}")

    hidden = done_total - max_done
    if hidden > 0:
        print(f"\n  {_a(_GRY)}... {hidden} more done  ·  --max-done={done_total} to show all{_a(_RST)}")

    print(f"\n  {_a(_GRY)}<N> · <N> done / active / pending{_a(_RST)}")


def run_detail(tasks: dict[str, list[dict]], ranked: list[tuple[str, float]], rank: int, task_statuses: dict = None):
    task_statuses = task_statuses or {}
    grouped_ranked = _grouped(ranked, task_statuses)

    if rank < 1 or rank > len(grouped_ranked):
        print(f"[detail] No task at rank #{rank}.")
        return

    task_id, _ = grouped_ranked[rank - 1]
    msgs = tasks[task_id]
    rep = msgs[0]
    category = rep.get("category", "unknown").upper()
    status = task_statuses.get(task_id, "pending")
    age = _age_str(_oldest_ts(msgs))
    n = len(msgs)
    count_s = f"  ·  {n} messages" if n > 1 else ""

    status_color = {
        "active":  _YLW + _BLD,
        "pending": "",
        "done":    _GRY,
    }.get(status, "")

    # Header
    print()
    header = f"  Task #{rank}  ·  {category}  ·  {_a(status_color)}{status.upper()}{_a(_RST)}  ·  {_a(_GRY)}{age}{_a(_RST)}{count_s}"
    rule = "─" * (shutil.get_terminal_size((80, 24)).columns - 2)
    print(f"  {_a(_CYN)}{rule}{_a(_RST)}")
    print(header)
    print(f"  {_a(_CYN)}{rule}{_a(_RST)}")

    _LBL_W = 9  # "Channel: " — widest label
    arrow_s = f"{_a(_CYN)}→{_a(_RST)}"

    for i, msg in enumerate(msgs):
        print()
        if n > 1:
            print(f"  {_a(_BLU)}[{i + 1}/{n}]{_a(_RST)}")

        subject = _clean(msg["subject"])
        print(f"  {_a(_BLD)}{subject}{_a(_RST)}")
        print()

        contacts_raw = msg.get("contacts", [])
        channel = msg.get("channel", "")
        source  = msg.get("source", "")
        ts      = msg.get("received_at", "")
        url     = msg.get("url", "")
        body    = msg.get("body", "")

        if contacts_raw:
            primary = contacts_raw[0]
            others  = contacts_raw[1:]
            print(f"  {'Contact:':{_LBL_W}} {_a(_GRY)}{primary}{_a(_RST)}")
            for c in others:
                print(f"  {'':{_LBL_W}} {_a(_GRY)}{c}{_a(_RST)}")
        if channel and channel not in ("inbox", ""):
            print(f"  {'Channel:':{_LBL_W}} {_a(_GRY)}{channel}{_a(_RST)}")
        if source:
            print(f"  {'Source:':{_LBL_W}} {_a(_GRY)}{source}{_a(_RST)}")
        if ts:
            print(f"  {'Age:':{_LBL_W}} {_a(_GRY)}{_age_str(ts)}{_a(_RST)}")

        if url:
            print()
            print(f"  {arrow_s} {_link(url, url)}")

        if body:
            print()
            for line in body.splitlines():
                print(f"  {_a(_GRY)}{line}{_a(_RST)}")

    print()


def run_deliver(tasks: dict[str, list[dict]], ranked: list[tuple[str, float]], settings: dict, new_task_ids: set = None, task_statuses: dict = None, max_done: int = 5):
    subject_limit = settings["subject_limit"]
    new_task_ids = new_task_ids or set()
    task_statuses = task_statuses or {}
    show_new_markers = bool(new_task_ids) and len(new_task_ids) < len(tasks)
    n = sum(1 for tid in tasks if task_statuses.get(tid, "pending") != "done")

    _box_header(f"DIGESTER  ·  {n} task{'s' if n != 1 else ''}")

    grouped_ranked = _grouped(ranked, task_statuses)
    done_total = sum(1 for tid, _ in grouped_ranked if task_statuses.get(tid, "pending") == "done")
    done_shown = 0
    current_section = None

    for rank, (task_id, _) in enumerate(grouped_ranked, 1):
        emails = tasks[task_id]
        rep = emails[0]
        category = rep.get("category", "unknown").upper()
        status = task_statuses.get(task_id, "pending")
        n_emails = len(emails)

        if status == "done":
            done_shown += 1
            if done_shown > max_done:
                continue

        if status != current_section:
            current_section = status
            _section_banner(status)

        if show_new_markers and task_id in new_task_ids:
            marker_s = f"{_a(_YLW)}★ {_a(_RST)}"
        elif status == "active":
            marker_s = f"{_a(_YLW)}▶ {_a(_RST)}"
        elif status == "done":
            marker_s = f"{_a(_GRY)}✓ {_a(_RST)}"
        else:
            marker_s = "  "

        subject = _clean(rep["subject"])
        if len(subject) > subject_limit:
            subject = subject[:subject_limit - 1] + "…"
        age        = _age_str(_oldest_ts(emails))
        rank_col   = f"#{rank}".ljust(4)
        rank_s     = f"{_a(_CYN)}{rank_col}{_a(_RST)}"
        cat_s      = f"{_a(_BLU)}{category}{_a(_RST)}"
        age_s      = f"{_a(_GRY)}{age}{_a(_RST)}"
        subj_color = _SUBJ_COLOR.get(status, "")
        subj_s     = f"{_a(subj_color)}{subject}{_a(_RST)}"
        count_s    = f"  {_a(_YLW)}[{n_emails}]{_a(_RST)}" if n_emails > 1 else ""
        arrow_s    = f"{_a(_CYN)}→{_a(_RST)}"
        contacts  = _contacts_str(emails)
        print(f"\n  {rank_s} {marker_s}{cat_s}  {age_s}  {subj_s}{count_s}")
        channel = rep.get("channel", "")
        channel_s = f"  ·  {_a(_GRY)}{channel}{_a(_RST)}" if channel and channel != "inbox" else ""
        contacts_s = f"{_a(_GRY)}{contacts}{_a(_RST)}" if contacts else ""
        print(f"       {contacts_s}{channel_s}")
        for em in emails:
            url = em.get("url")
            subj = _clean(em["subject"])
            if len(subj) > subject_limit:
                subj = subj[:subject_limit - 1] + "…"
            label = _link(url, subj) if url else subj
            print(f"       {arrow_s} {label}")

    hidden = done_total - max_done
    if hidden > 0:
        print(f"\n  {_a(_GRY)}... {hidden} more done  ·  --max-done={done_total} to show all{_a(_RST)}")

    print(f"\n  {_a(_GRY)}<N> · <N> done / active / pending{_a(_RST)}")
    print()


# ── Main ──────────────────────────────────────────────────────────────────────

def run(limit=None, only_source=None, as_json: bool = False):
    config = load_config()
    settings = load_settings()
    if limit is not None:
        settings["limit"] = limit

    processed_ids = db.get_processed_ids()
    outstanding_tasks, outstanding_ranked, outstanding_statuses = db.get_outstanding_tasks()

    active_sources = _active_sources(settings)
    if only_source:
        active_sources = [s for s in active_sources if s.SOURCE_NAME == only_source]
        if not active_sources:
            print(f"[digester] No active source named '{only_source}'.")
            return
    messages = []
    for source in active_sources:
        if not as_json:
            print(f"[digester] Fetching from {source.SOURCE_NAME}...")
        messages.extend(source.fetch(settings, processed_ids))

    if not messages:
        if not outstanding_tasks:
            if not as_json:
                print("[digester] Nothing new to process.")
        else:
            if as_json:
                import json as _json
                grouped_ranked = _grouped(outstanding_ranked, outstanding_statuses)
                latest_ids = db.get_tasks_since(db.get_last_run_at() or "")
                task_list_json = []
                for rank, (tid, _) in enumerate(grouped_ranked, 1):
                    msgs = outstanding_tasks[tid]
                    rep  = msgs[0]
                    task_list_json.append({
                        "rank":          rank,
                        "id":            tid,
                        "status":        outstanding_statuses.get(tid, "pending"),
                        "category":      rep.get("category", "unknown"),
                        "subject":       _clean(rep["subject"]),
                        "age_hours":     _age_hours(_oldest_ts(msgs)),
                        "message_count": len(msgs),
                        "contacts":      list({c for m in msgs for c in m.get("contacts", []) if c}),
                        "is_latest":     tid in latest_ids,
                    })
                print(_json.dumps({
                    "new_tasks":        0,
                    "updated_tasks":    0,
                    "skipped_messages": 0,
                    "tasks":            task_list_json,
                }))
            else:
                run_deliver(outstanding_tasks, outstanding_ranked, settings, task_statuses=outstanding_statuses)
        return

    messages = run_filter(messages, config, settings, verbose=not as_json)
    tasks = run_group(messages, config, settings, seed_tasks=outstanding_tasks, verbose=not as_json)
    ranked = run_prioritize(tasks, config, settings, verbose=not as_json)

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
            constituent_ids=msg.get("constituent_ids"),
            contacts=msg.get("contacts"),
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

    db.set_last_run_at()

    if as_json:
        import json as _json
        new_task_count   = len(new_task_ids)
        updated_task_ids = {m.get("task_id") for m in messages
                            if m.get("category") and m.get("task_id")
                            and m.get("task_id") not in new_task_ids}
        skipped_count    = sum(1 for m in messages if not m.get("category"))
        tasks_fresh, ranked_fresh, statuses_fresh = db.get_all_tasks()
        latest_ids = db.get_tasks_since(db.get_last_run_at() or "")
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            _render_list_json(tasks_fresh, ranked_fresh, statuses_fresh, latest_ids=latest_ids)
        list_payload = _json.loads(buf.getvalue())
        print(_json.dumps({
            "new_tasks":        new_task_count,
            "updated_tasks":    len(updated_task_ids),
            "skipped_messages": skipped_count,
            "tasks":            list_payload["tasks"],
        }))
    else:
        run_deliver(tasks, ranked, settings, new_task_ids=new_task_ids,
                    task_statuses=outstanding_statuses)
        print("\n[digester] Done.")


def _filter_to_latest(
    tasks: dict, ranked: list, statuses: dict, last_run_at: str | None
) -> tuple[dict, list, dict]:
    if not last_run_at:
        return tasks, ranked, statuses
    latest_ids = db.get_tasks_since(last_run_at)
    filtered_tasks    = {tid: msgs for tid, msgs in tasks.items() if tid in latest_ids}
    filtered_ranked   = [(tid, p) for tid, p in ranked if tid in filtered_tasks]
    filtered_statuses = {tid: s for tid, s in statuses.items() if tid in filtered_tasks}
    return filtered_tasks, filtered_ranked, filtered_statuses


def _parse_ranks(spec: str) -> list[int]:
    """Parse a rank spec into a sorted deduplicated list of ints.

    Accepts: single '5', comma list '1,3,5', range '2-8', or mixed '1,3-5,8'.
    Raises ValueError on malformed input.
    """
    ranks: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_s, hi_s = part.split("-", 1)
            lo, hi = int(lo_s.strip()), int(hi_s.strip())
            ranks.update(range(min(lo, hi), max(lo, hi) + 1))
        else:
            ranks.add(int(part))
    return sorted(ranks)


def _fmt_ranks(results: list[tuple]) -> str:
    """Format (rank, ...) tuples as '#1, #2, #5'."""
    return ", ".join(f"#{r}" for r, *_ in results)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    # Route bare rank specs before argparse
    if argv and re.match(r'^[\d,\-]+$', argv[0]):
        rank_spec = argv[0]
        rest_no_json = [a for a in argv[1:] if a != "--json"]
        has_json = "--json" in argv[1:]
        if rest_no_json and rest_no_json[0] in ("done", "active", "pending"):
            return argparse.Namespace(
                command="set", number=rank_spec, status=rest_no_json[0], json=has_json
            )
        try:
            rank = int(rank_spec)
        except ValueError:
            print(f"[digester] '{rank_spec}' requires a status: done, active, or pending", file=sys.stderr)
            sys.exit(1)
        return argparse.Namespace(command="detail", number=rank, json=has_json)

    parser = argparse.ArgumentParser(
        description="digester — attention digest",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        usage=(
            "digester [--latest] [--max-done N] [--json]\n"
            "       digester <N> [--json]\n"
            "       digester <RANKS> done|active|pending [--json]\n"
            "       digester run [--json] [--limit N] [--source S]\n"
            "       digester auth slack"
        ),
        epilog=(
            "rank commands (no subcommand keyword):\n"
            "  digester <N>                          show full detail for task at rank N\n"
            "  digester <RANKS> done|active|pending  set status without confirmation\n"
            "    RANKS: 5  or  1,3,5  or  2-8  or  1,3-5,8"
        ),
    )
    parser.add_argument("--latest", action="store_true",
                        help="filter to tasks added in the most recent run")
    parser.add_argument("--max-done", type=int, default=5, metavar="N",
                        help="max done tasks to show (default: 5)")
    parser.add_argument("--json", action="store_true", dest="json",
                        help="machine-readable JSON output")

    sub = parser.add_subparsers(dest="command", title="commands")

    run_p = sub.add_parser("run", help="Fetch and process new messages")
    run_p.add_argument("--limit", type=int, default=None,
                       help="Max messages to process (for testing)")
    run_p.add_argument("--source", default=None,
                       help="Only fetch from this source (e.g. email, slack)")
    run_p.add_argument("--json", action="store_true", dest="json",
                       help="Output JSON summary instead of human-readable output")

    auth_p = sub.add_parser("auth", help="Authenticate with a source")
    auth_p.add_argument("source", choices=["slack"])

    return parser.parse_args(argv)


def dispatch(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    args = _parse_args(argv)

    if args.command == "run":
        try:
            run(limit=args.limit, only_source=args.source, as_json=args.json)
        except RuntimeError as e:
            print(f"[digester] {e}", file=sys.stderr)
            sys.exit(1)

    elif args.command == "detail":
        tasks, ranked, statuses = db.get_all_tasks()
        if not tasks:
            if args.json:
                import json as _json; print(_json.dumps({"tasks": [], "summary": {"active": 0, "pending": 0, "done": 0}}))
            else:
                print("[digester] No tasks.")
        elif args.json:
            _render_detail_json(tasks, ranked, args.number, statuses)
        else:
            run_detail(tasks, ranked, args.number, task_statuses=statuses)

    elif args.command == "set":
        try:
            ranks = _parse_ranks(args.number)
        except ValueError:
            print("[set] Invalid rank spec. Use: 5  or  1,3,5  or  2-8  or  1,3-5,8",
                  file=sys.stderr)
            sys.exit(1)

        results = db.set_task_status_batch(ranks, args.status)
        invalid   = [(r, t, o, m) for r, t, o, m in results if t is None]
        unchanged = [(r, t, o, m) for r, t, o, m in results if t and o == args.status]
        changed   = [(r, t, o, m) for r, t, o, m in results if t and o != args.status]

        for r, *_ in invalid:
            if not args.json:
                print(f"[set] No task at rank #{r}.")
        if unchanged and not args.json:
            print(f"Already {args.status}: {_fmt_ranks(unchanged)}")
        if not changed:
            if args.json:
                _render_set_json([], unchanged, invalid, args.status)
            sys.exit(1 if invalid else 0)

        needs_sync = [(r, t, o, m) for r, t, o, m in changed if m]
        if not needs_sync:
            if args.json:
                _render_set_json(changed, unchanged, invalid, args.status)
            else:
                print(f"Marked {args.status}: {_fmt_ranks(changed)}")
        else:
            try:
                if not args.json:
                    print("[set] Syncing labels...", flush=True)
                settings = load_settings()
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
                    else:
                        if not args.json:
                            print(f"[set] Warning: source '{src_name}' not active, "
                                  f"skipping label sync for {len(msg_ids)} message(s)")
                if args.json:
                    _render_set_json(changed, unchanged, invalid, args.status)
                else:
                    print(f"Marked {args.status}: {_fmt_ranks(changed)}")
            except Exception as e:
                if not args.json:
                    print(f"[set] Sync failed: {e}")
                    print("[set] Reverting state...", flush=True)
                db.revert_task_statuses(changed)
                if not args.json:
                    print("[set] Reverted.")

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

    else:
        # Default: list view
        settings = load_settings()
        tasks, ranked, statuses = db.get_all_tasks()
        if not tasks:
            if args.json:
                import json as _json; print(_json.dumps({"tasks": [], "summary": {"active": 0, "pending": 0, "done": 0}}))
            else:
                print("[digester] No tasks.")
        else:
            if args.latest:
                last_run_at = db.get_last_run_at()
                tasks, ranked, statuses = _filter_to_latest(tasks, ranked, statuses, last_run_at)
            if args.json:
                last_run_at = db.get_last_run_at()
                latest_ids  = db.get_tasks_since(last_run_at) if last_run_at else set()
                _render_list_json(tasks, ranked, statuses, latest_ids=latest_ids)
            else:
                run_show_concise(tasks, ranked, settings, task_statuses=statuses,
                                 max_done=args.max_done)


if __name__ == "__main__":
    dispatch()
