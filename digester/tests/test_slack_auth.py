"""Tests for Slack authentication and token refresh."""
import os
import time
from pathlib import Path
from unittest.mock import Mock, patch
import pytest
import auth


@pytest.fixture
def mock_tokens_file(tmp_path):
    """Create a temporary tokens file for testing."""
    tokens_path = tmp_path / "tokens.yaml"
    with patch("auth.TOKENS_PATH", str(tokens_path)):
        yield str(tokens_path)


def test_save_and_load_token_dict(mock_tokens_file):
    """Test saving and loading token data as a dict."""
    token_data = {
        "access_token": "xoxp-test-token",
        "refresh_token": "xoxe-1-refresh",
        "expires_in": 43200,
        "obtained_at": int(time.time()),
    }
    
    auth.save_token("slack", token_data)
    loaded = auth.load_token("slack")
    
    assert loaded == token_data["access_token"]


def test_save_and_load_legacy_string_token(mock_tokens_file):
    """Test backward compatibility with string tokens."""
    auth.save_token("slack", "xoxp-legacy-token")
    loaded = auth.load_token("slack")
    
    assert loaded == "xoxp-legacy-token"


def test_needs_refresh_expired_token():
    """Test that expired tokens are identified for refresh."""
    # Token obtained 13 hours ago, expires in 12 hours -> expired
    token_data = {
        "access_token": "xoxp-test",
        "refresh_token": "xoxe-refresh",
        "expires_in": 43200,  # 12 hours
        "obtained_at": int(time.time()) - 46800,  # 13 hours ago
    }
    
    assert auth._needs_refresh(token_data) is True


def test_needs_refresh_fresh_token():
    """Test that fresh tokens are not marked for refresh."""
    # Token obtained 1 hour ago, expires in 12 hours -> fresh
    token_data = {
        "access_token": "xoxp-test",
        "refresh_token": "xoxe-refresh",
        "expires_in": 43200,  # 12 hours
        "obtained_at": int(time.time()) - 3600,  # 1 hour ago
    }
    
    assert auth._needs_refresh(token_data) is False


def test_needs_refresh_soon_to_expire():
    """Test that tokens expiring soon (within 1 hour) are marked for refresh."""
    # Token obtained 11.5 hours ago, expires in 12 hours -> refresh soon
    token_data = {
        "access_token": "xoxp-test",
        "refresh_token": "xoxe-refresh",
        "expires_in": 43200,  # 12 hours
        "obtained_at": int(time.time()) - 41400,  # 11.5 hours ago
    }
    
    assert auth._needs_refresh(token_data) is True


def test_needs_refresh_no_expiry_tracking():
    """Test that tokens without expiry tracking are not refreshed."""
    token_data = {
        "access_token": "xoxp-test",
        "refresh_token": "xoxe-refresh",
    }
    
    assert auth._needs_refresh(token_data) is False


@patch("auth.requests.post")
def test_refresh_slack_token_success(mock_post, mock_tokens_file):
    """Test successful token refresh."""
    # Mock the Slack API response
    mock_response = Mock()
    mock_response.json.return_value = {
        "ok": True,
        "access_token": "xoxp-new-token",
        "refresh_token": "xoxe-new-refresh",
        "expires_in": 43200,
    }
    mock_response.raise_for_status = Mock()
    mock_post.return_value = mock_response
    
    with patch.dict(os.environ, {"SLACK_CLIENT_ID": "test-client-id"}):
        old_token_data = {
            "access_token": "xoxp-old",
            "refresh_token": "xoxe-old-refresh",
            "expires_in": 43200,
            "obtained_at": int(time.time()) - 50000,  # Expired
        }
        
        new_token_data = auth._refresh_slack_token(old_token_data)
        
        assert new_token_data is not None
        assert new_token_data["access_token"] == "xoxp-new-token"
        assert new_token_data["refresh_token"] == "xoxe-new-refresh"
        assert new_token_data["expires_in"] == 43200
        assert "obtained_at" in new_token_data


@patch("auth.requests.post")
def test_refresh_slack_token_failure(mock_post, mock_tokens_file, capsys):
    """Test token refresh failure handling."""
    # Mock the Slack API error response
    mock_response = Mock()
    mock_response.json.return_value = {
        "ok": False,
        "error": "invalid_refresh_token",
    }
    mock_response.raise_for_status = Mock()
    mock_post.return_value = mock_response
    
    with patch.dict(os.environ, {"SLACK_CLIENT_ID": "test-client-id"}):
        old_token_data = {
            "access_token": "xoxp-old",
            "refresh_token": "xoxe-invalid",
        }
        
        result = auth._refresh_slack_token(old_token_data)
        
        assert result is None
        captured = capsys.readouterr()
        assert "Token refresh failed" in captured.out


def test_refresh_slack_token_no_client_id(mock_tokens_file, capsys):
    """Test that refresh fails gracefully without SLACK_CLIENT_ID."""
    with patch.dict(os.environ, {}, clear=True):
        token_data = {
            "access_token": "xoxp-test",
            "refresh_token": "xoxe-refresh",
        }
        
        result = auth._refresh_slack_token(token_data)
        
        assert result is None
        captured = capsys.readouterr()
        assert "SLACK_CLIENT_ID not set" in captured.out


@patch("auth._refresh_slack_token")
def test_load_token_triggers_refresh(mock_refresh, mock_tokens_file):
    """Test that loading an expired token triggers refresh."""
    # Save an expired token
    expired_token = {
        "access_token": "xoxp-old",
        "refresh_token": "xoxe-refresh",
        "expires_in": 43200,
        "obtained_at": int(time.time()) - 50000,  # Expired
    }
    auth.save_token("slack", expired_token)
    
    # Mock the refresh to return a new token
    new_token = {
        "access_token": "xoxp-new",
        "refresh_token": "xoxe-new-refresh",
        "expires_in": 43200,
        "obtained_at": int(time.time()),
    }
    mock_refresh.return_value = new_token
    
    # Load the token (should trigger refresh)
    loaded = auth.load_token("slack")
    
    assert loaded == "xoxp-new"
    assert mock_refresh.called
    
    # Verify the new token was saved
    loaded_again = auth.load_token("slack")
    # After refresh, the token should be fresh and return the new access token
    assert loaded_again == "xoxp-new"
