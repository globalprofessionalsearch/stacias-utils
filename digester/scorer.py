import os
import re
import requests
import db

QWEN_URL = os.getenv("QWEN_URL", "http://localhost:8099/v1/chat/completions")
QWEN_MODEL = os.getenv("QWEN_MODEL", "/Users/joe/models/qwen3.6-35b")
QWEN_TEMPERATURE = float(os.getenv("QWEN_TEMPERATURE", 0.0))
MAX_RETRIES = int(os.getenv("MAX_SCORE_RETRIES", 3))


STRUCTURAL_PROMPTS = {
    "filter": """You are an email classifier. Given an email and a set of criteria,
return a single float between 0.0 and 1.0 representing how likely this email
belongs to the described category. Use any examples in the criteria as calibration. Return ONLY the number.""",

    "group": """You are a task grouping assistant. Given two emails and a grouping criteria,
return a single float between 0.0 and 1.0 representing how likely these two emails
are about the same actionable task. Use any examples in the criteria as calibration. Return ONLY the number.""",

    "prioritize": """You are a prioritization assistant. Given two tasks and prioritization criteria,
return a single float between -1.0 and 1.0. Return a positive value if task A is more urgent,
a negative value if task B is more urgent, and 0.0 if they are equally urgent.
Use any examples in the criteria as calibration. Return ONLY the number.""",
}


def _extract_float(text: str, lo: float, hi: float) -> float | None:
    """Extract the last float in range from a string."""
    matches = re.findall(r"-?\d+(?:\.\d+)?", text)
    for m in reversed(matches):
        try:
            value = float(m)
            if lo <= value <= hi:
                return value
        except ValueError:
            continue
    return None


def score(operation: str, criteria: str, payload: str) -> float | None:
    structural_prompt = STRUCTURAL_PROMPTS[operation]
    system_message = f"{structural_prompt}\n\nCriteria:\n{criteria}"

    ranges = {
        "filter": (0.0, 1.0),
        "group": (0.0, 1.0),
        "prioritize": (-1.0, 1.0),
    }
    lo, hi = ranges[operation]

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(QWEN_URL, json={
                "model": QWEN_MODEL,
                "messages": [
                    {"role": "system", "content": system_message},
                    {"role": "user", "content": payload},
                ],
                "temperature": QWEN_TEMPERATURE,
                "max_tokens": 10,
            }, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            message = data["choices"][0]["message"]
            # MLX server with Qwen 3.6 returns 'reasoning' instead of 'content'
            raw = (message.get("content") or message.get("reasoning") or "").strip()

            value = _extract_float(raw, lo, hi)
            if value is not None:
                return value
            last_error = f"No valid float in range [{lo}, {hi}] found in: {raw[:100]}"
        except (KeyError, requests.RequestException) as e:
            last_error = str(e)

    db.log_warning(operation, payload[:500], MAX_RETRIES, last_error)
    print(f"  [WARN] score() failed after {MAX_RETRIES} attempts ({operation}): {last_error}")
    return None
