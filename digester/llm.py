"""
llm — local LLM server lifecycle.

Detects whether the configured Qwen/MLX server is reachable and, if not,
offers to start it from launch config in .env.

Launch config (all optional; autostart is disabled if no command/model is set):
  QWEN_SERVER_CMD          launch command, e.g. "/path/to/venv/bin/python -m mlx_lm server"
  QWEN_SERVER_BIN          fallback: path to a single server binary (legacy)
  QWEN_LAUNCH_MODEL        model id passed to `--model` at launch
  QWEN_CHAT_TEMPLATE_ARGS  JSON for `--chat-template-args` (default disables thinking)
  QWEN_STARTUP_TIMEOUT     seconds to wait for the server to become ready (default 180)
  QWEN_SERVER_LOG          where to tee server stdout/stderr

QWEN_SERVER_CMD is preferred over QWEN_SERVER_BIN: invoking the venv's Python
with `-m mlx_lm server` is resilient to the venv being moved (console-script
shebangs bake in an absolute interpreter path and break on relocation).

The request URL/port come from QWEN_URL.
"""

import os
import shlex
import subprocess
import sys
import time
from urllib.parse import urlparse

import requests

QWEN_URL = os.getenv("QWEN_URL", "http://localhost:8099/v1/chat/completions")
SERVER_CMD = os.getenv("QWEN_SERVER_CMD", "")
SERVER_BIN = os.getenv("QWEN_SERVER_BIN", "")
LAUNCH_MODEL = os.getenv("QWEN_LAUNCH_MODEL", "")
CHAT_TEMPLATE_ARGS = os.getenv("QWEN_CHAT_TEMPLATE_ARGS", '{"enable_thinking":false}')
STARTUP_TIMEOUT = int(os.getenv("QWEN_STARTUP_TIMEOUT", 180))
LOG_PATH = os.path.expanduser(
    os.getenv("QWEN_SERVER_LOG", "~/.cache/digester/mlx_server.log")
)


def _parsed():
    return urlparse(QWEN_URL)


def _base_url() -> str:
    p = _parsed()
    return f"{p.scheme}://{p.hostname}:{p.port}"


def _port() -> int:
    return _parsed().port or 80


def is_running(timeout: float = 2.0) -> bool:
    """True if the server answers its models endpoint."""
    try:
        return requests.get(f"{_base_url()}/v1/models", timeout=timeout).ok
    except requests.RequestException:
        return False


def _base_argv() -> list[str]:
    """The launch command without the standard flags we append.

    ADR: prefer a full launch command (QWEN_SERVER_CMD) invoking the venv's
    Python via `-m mlx_lm server` over pointing at the `mlx_lm.server` console
    script (QWEN_SERVER_BIN). Console scripts hard-code an absolute interpreter
    path in their shebang at install time; relocating the venv (as happened when
    ollama moved from code/sandbox to code/experiments) leaves the shebang
    dangling and exec fails with ENOENT against a path that *looks* present. A
    venv's `python` symlink, by contrast, resolves to the system interpreter and
    survives the move, so module invocation is robust to relocation. SERVER_BIN
    is retained only as a legacy fallback.
    """
    if SERVER_CMD:
        parts = shlex.split(SERVER_CMD)
    elif SERVER_BIN:
        parts = [SERVER_BIN]
    else:
        return []
    return [os.path.expanduser(p) if p.startswith("~") else p for p in parts]


def can_autostart() -> bool:
    return bool(_base_argv() and LAUNCH_MODEL)


def _msg(text: str):
    print(text, file=sys.stderr, flush=True)


def start_server() -> subprocess.Popen:
    """Spawn the MLX server detached. Raises RuntimeError on bad config."""
    argv = _base_argv()
    if not argv:
        raise RuntimeError(
            "no launch command configured (set QWEN_SERVER_CMD or QWEN_SERVER_BIN)"
        )
    exe = argv[0]
    if "/" in exe and not os.path.exists(exe):
        raise RuntimeError(f"server executable not found: {exe}")

    cmd = argv + ["--model", LAUNCH_MODEL, "--port", str(_port())]
    if CHAT_TEMPLATE_ARGS:
        cmd += ["--chat-template-args", CHAT_TEMPLATE_ARGS]

    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    log = open(LOG_PATH, "ab")
    return subprocess.Popen(
        cmd,
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )


def ensure_running(interactive: bool = True) -> bool:
    """
    Ensure the LLM server is reachable.

    Returns True if it is up (or was started successfully). If it is down and
    cannot/should not be started, returns False without raising.
    """
    if is_running():
        return True

    if not can_autostart():
        _msg(
            f"[digester] LLM server not reachable at {QWEN_URL} and autostart is "
            "not configured (set QWEN_SERVER_CMD and QWEN_LAUNCH_MODEL in .env)."
        )
        return False

    if interactive:
        try:
            answer = input(
                f"[digester] LLM server not running at {QWEN_URL}. Start it? [Y/n] "
            ).strip().lower()
        except EOFError:
            answer = "n"
        if answer in ("n", "no"):
            return False

    _msg("[digester] Starting LLM server (model load can take a minute)...")
    try:
        proc = start_server()
    except RuntimeError as e:
        _msg(f"[digester] Could not start LLM server: {e}")
        return False

    deadline = time.time() + STARTUP_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            _msg(f"[digester] LLM server exited early (see {LOG_PATH}).")
            return False
        if is_running():
            _msg("[digester] LLM server is up.")
            return True
        time.sleep(2)
        print(".", end="", file=sys.stderr, flush=True)

    _msg(f"\n[digester] LLM server not ready within {STARTUP_TIMEOUT}s (see {LOG_PATH}).")
    return False
