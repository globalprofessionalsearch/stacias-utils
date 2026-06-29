# Slack Authentication Fixes

## Issues Fixed

### 1. Token Refresh Not Implemented
**Problem**: Slack access tokens expire after ~12 hours, requiring daily re-authentication.

**Root Cause**: The auth flow only saved the `access_token` but ignored the `refresh_token` provided by Slack's OAuth response.

**Solution**: 
- Save complete token data including `refresh_token`, `expires_in`, and `obtained_at` timestamp
- Automatically check token expiry on every `load_token()` call
- Refresh tokens proactively (when < 1 hour until expiry) using the refresh token grant
- Maintain backward compatibility with legacy string-only tokens

**Files Changed**:
- `auth.py`: Added `_needs_refresh()`, `_refresh_slack_token()`, updated `save_token()` and `load_token()`

### 2. Unfriendly Error Messages
**Problem**: Expired/invalid tokens resulted in uncaught `SlackApiError` stack traces.

**Solution**:
- Wrap `client.auth_test()` in try/catch in `sources/slack.py`
- Detect auth errors (`token_expired`, `token_revoked`, `invalid_auth`, `not_authed`)
- Raise user-friendly `RuntimeError` with clear instructions to re-authenticate

**Files Changed**:
- `sources/slack.py`: Added error handling in `fetch()` function

## Technical Details

### Token Storage Format

**Before** (`~/.config/digester/tokens.yaml`):
```yaml
sources:
  slack:
    token:
      access_token: xoxp-...
```

**After**:
```yaml
sources:
  slack:
    token:
      access_token: xoxp-...
      refresh_token: xoxe-1-...
      expires_in: 43200
      obtained_at: 1719273845
```

### Token Refresh Flow

1. User calls `digester run`
2. `sources/slack.py` calls `auth.load_token("slack")`
3. `load_token()` checks if token needs refresh:
   - Token expired? (elapsed > expires_in)
   - Token expiring soon? (< 1 hour remaining)
4. If yes, call Slack's `oauth.v2.access` with grant_type=refresh_token
5. Save new token data and return fresh access_token
6. If refresh fails, user sees friendly error on next API call

### Error Messages

**Before**:
```
Traceback (most recent call last):
  File "sources/slack.py", line 33, in fetch
    me = client.auth_test()
slack_sdk.errors.SlackApiError: The request to the Slack API failed.
The server responded with: {'ok': False, 'error': 'token_expired'}
```

**After**:
```
RuntimeError: Slack authentication failed: token_expired
  Your token has expired or been revoked.
  Please re-authenticate: digester auth slack
```

## Testing

New test suite: `tests/test_slack_auth.py`
- ✅ Token save/load with dict format
- ✅ Backward compatibility with legacy string tokens
- ✅ Expiry detection (expired, fresh, soon-to-expire)
- ✅ Successful token refresh
- ✅ Refresh failure handling
- ✅ Missing SLACK_CLIENT_ID handling
- ✅ Automatic refresh trigger on load

All 10 new tests pass.

## Requirements

**Environment Variable**:
- `SLACK_CLIENT_ID` must be set in `.env` for token refresh to work
- Already present in current `.env`

**Backward Compatibility**:
- Existing tokens stored as strings still work
- They won't auto-refresh (no refresh_token), but won't break
- Re-running `digester auth slack` will upgrade to the new format

## Documentation Updates

- Added `SLACK_CLIENT_ID` to Environment Variables table in PRODUCT_BRIEF.md
- Added `SLACK_DAYS_BACK` to Environment Variables table
- Added new `digester auth slack` command section with:
  - Required user scopes
  - Token refresh behavior explanation
  - First-time setup instructions
