import base64
import hashlib
import pytest
import auth


def test_pkce_verifier_is_url_safe():
    verifier, _ = auth._generate_pkce_pair()
    # URL-safe base64 chars only: A-Z a-z 0-9 - _
    assert all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for c in verifier)


def test_pkce_challenge_is_s256_of_verifier():
    verifier, challenge = auth._generate_pkce_pair()
    digest = hashlib.sha256(verifier.encode()).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    assert challenge == expected


def test_token_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "TOKENS_PATH", str(tmp_path / "tokens.yaml"))
    auth.save_token("slack", "xoxp-test-token")
    assert auth.load_token("slack") == "xoxp-test-token"


def test_load_token_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "TOKENS_PATH", str(tmp_path / "tokens.yaml"))
    assert auth.load_token("slack") is None


def test_save_token_creates_parent_dir(tmp_path, monkeypatch):
    nested = tmp_path / "a" / "b" / "tokens.yaml"
    monkeypatch.setattr(auth, "TOKENS_PATH", str(nested))
    auth.save_token("slack", "xoxp-abc")
    assert nested.exists()


def test_save_token_preserves_other_sources(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "TOKENS_PATH", str(tmp_path / "tokens.yaml"))
    auth.save_token("slack", "xoxp-slack")
    auth.save_token("other", "token-other")
    assert auth.load_token("slack") == "xoxp-slack"
    assert auth.load_token("other") == "token-other"
