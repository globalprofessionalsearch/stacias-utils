import base64
import hashlib
import os
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlencode, parse_qs, urlparse

import requests
import yaml

TOKENS_PATH = os.path.expanduser("~/.config/digester/tokens.yaml")
CALLBACK_PORT = 9119

SLACK_AUTH_URL = "https://slack.com/oauth/v2/authorize"
SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access"
SLACK_USER_SCOPES = (
    "search:read,channels:read,channels:history,"
    "groups:read,groups:history,im:read,im:history,"
    "mpim:read,mpim:history,users:read"
)


def _generate_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def run_slack_flow(client_id: str) -> str:
    """Run the Slack PKCE OAuth browser flow. Returns the user access token."""
    verifier, challenge = _generate_pkce_pair()
    state = secrets.token_urlsafe(16)
    redirect_uri = f"http://localhost:{CALLBACK_PORT}/callback"

    auth_params = {
        "client_id": client_id,
        "user_scope": SLACK_USER_SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    auth_url = f"{SLACK_AUTH_URL}?{urlencode(auth_params)}"

    code_holder: dict = {}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if not self.path.startswith("/callback"):
                self.send_error(404)
                return
            params = parse_qs(urlparse(self.path).query)
            if params.get("state", [None])[0] != state:
                self.send_error(400, "State mismatch")
                return
            code = params.get("code", [None])[0]
            if not code:
                self.send_error(400, "No code in callback")
                return
            code_holder["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><body>Authentication successful! You can close this tab.</body></html>")

        def log_message(self, format, *args):
            pass  # suppress access log

    server = HTTPServer(("127.0.0.1", CALLBACK_PORT), _Handler)
    thread = threading.Thread(target=server.handle_request)
    thread.start()

    print(f"[auth] Opening browser for Slack authentication...")
    print(f"[auth] If your browser doesn't open, visit:\n  {auth_url}\n")
    webbrowser.open(auth_url)

    thread.join(timeout=120)
    server.server_close()

    if "code" not in code_holder:
        raise RuntimeError("Authentication timed out or was cancelled.")

    resp = requests.post(SLACK_TOKEN_URL, data={
        "client_id": client_id,
        "code": code_holder["code"],
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
    })
    resp.raise_for_status()
    data = resp.json()

    if not data.get("ok"):
        raise RuntimeError(f"Token exchange failed: {data.get('error')}")

    # Slack returns the user token inside authed_user, not at the top level
    import time
    authed_user = data["authed_user"]
    token_data = {
        "access_token": authed_user["access_token"],
        "refresh_token": authed_user.get("refresh_token"),
        "expires_in": authed_user.get("expires_in"),
        "obtained_at": int(time.time()) if authed_user.get("expires_in") else None,
    }
    return token_data


def save_token(source: str, token_data: dict | str) -> None:
    """Save token data. Accepts dict with token info or legacy string access_token."""
    path = Path(TOKENS_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path) as f:
            config = yaml.safe_load(f) or {}
    except FileNotFoundError:
        config = {}
    
    # Support legacy string token for backward compatibility
    if isinstance(token_data, str):
        token_data = {"access_token": token_data}
    
    config.setdefault("sources", {})[source] = {"token": token_data}
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        yaml.dump(config, f)


def load_token(source: str) -> str | None:
    """Load and refresh token if needed. Returns access_token or None."""
    try:
        with open(TOKENS_PATH) as f:
            config = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return None
    
    token_data = config.get("sources", {}).get(source, {}).get("token")
    if not token_data:
        return None
    
    # Legacy support: if token is just a string, return it
    if isinstance(token_data, str):
        return token_data
    
    access_token = token_data.get("access_token")
    if not access_token:
        return None
    
    # Check if token needs refresh (only for Slack)
    if source == "slack" and _needs_refresh(token_data):
        refreshed = _refresh_slack_token(token_data)
        if refreshed:
            save_token(source, refreshed)
            return refreshed["access_token"]
    
    return access_token


def _needs_refresh(token_data: dict) -> bool:
    """Check if token is expired or will expire soon (within 1 hour)."""
    if not token_data.get("expires_in") or not token_data.get("obtained_at"):
        return False  # No expiry tracking, assume valid
    
    import time
    obtained_at = token_data["obtained_at"]
    expires_in = token_data["expires_in"]
    elapsed = time.time() - obtained_at
    # Refresh if expired or will expire within 1 hour (3600 seconds)
    return elapsed >= (expires_in - 3600)


def _refresh_slack_token(token_data: dict) -> dict | None:
    """Refresh Slack token using refresh_token. Returns new token_data or None on failure."""
    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        return None
    
    client_id = os.getenv("SLACK_CLIENT_ID")
    if not client_id:
        print("[auth] Warning: SLACK_CLIENT_ID not set, cannot refresh token")
        return None
    
    try:
        resp = requests.post("https://slack.com/api/oauth.v2.access", data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        })
        resp.raise_for_status()
        data = resp.json()
        
        if not data.get("ok"):
            print(f"[auth] Token refresh failed: {data.get('error')}")
            return None
        
        import time
        return {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token", refresh_token),  # Keep old if not provided
            "expires_in": data.get("expires_in"),
            "obtained_at": int(time.time()) if data.get("expires_in") else None,
        }
    except Exception as e:
        print(f"[auth] Token refresh error: {e}")
        return None
