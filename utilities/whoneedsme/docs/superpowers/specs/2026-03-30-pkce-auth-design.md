# PKCE Auth Redesign — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Overview

Replace the current credential-prompting setup flow with a PKCE-based OAuth 2.0 browser flow. Users run `whoneedsme auth slack` to authenticate — a browser opens, they approve, and a token is stored locally. No client secret is required in the binary. If no token is present for a source, that source is skipped with a message directing the user to authenticate.

Primary focus: Slack. JIRA changes are noted as follow-on work.

---

## What Changes

### Removed
- `cmd/setup.go` — the `setup` command is deleted entirely. There is nothing left to configure manually.
- `ClientID` and `ClientSecret` fields from `auth.SourceConfig` in `auth/store.go` — credentials are no longer stored per-user.

### Added
- `auth/embedded/credentials.go` — a package containing `SlackClientID` (and `JiraClientID` as a stub), set to empty strings by default and populated at build time via `-ldflags`.
- PKCE support in `auth/oauth.go` — code verifier + challenge generation, passed through the auth URL and token exchange.
- Fixed callback port `9119` replacing the current random port in `auth/oauth.go`.

### Modified
- `cmd/auth.go` — `runOAuthFlow` reads the client ID from `auth/embedded` instead of the store. The check for `cfg.ClientID` is removed.
- `sources/slack/slack.go` — `OAuthConfig` drops the `clientSecret` parameter.
- `cmd/root.go` — when a source has no token, skip it and print: `SLACK — not authenticated. Run 'whoneedsme auth slack' to authenticate.`
- `Makefile` (new) — builds the binary with ldflags injecting client IDs.

---

## Auth Flow

```
whoneedsme auth slack
```

1. CLI generates a PKCE code verifier (32 random bytes, base64url-encoded) and derives the code challenge (SHA-256 of verifier, base64url-encoded, no padding).
2. Starts a local HTTP server on `http://localhost:9119`.
3. Opens the browser to Slack's authorization URL:
   - `client_id` from `auth/embedded.SlackClientID`
   - `redirect_uri=http://localhost:9119/callback`
   - `code_challenge` and `code_challenge_method=S256`
   - Required scopes: `channels:history groups:history im:history mpim:history channels:read search:read users:identity.basic`
4. User approves in browser; Slack redirects to `http://localhost:9119/callback?code=...&state=...`.
5. CLI validates the `state` parameter, then exchanges the authorization code + code verifier for a token (no client secret).
6. Token stored in `~/.config/whoneedsme/config.yaml` (0600 permissions).
7. Local server shuts down.

---

## Unauthenticated Source Behavior

When `whoneedsme` runs and a source has no stored token:

```
SLACK — not authenticated. Run 'whoneedsme auth slack' to authenticate.
```

The source is skipped. Other authenticated sources run normally. This is printed in place of that source's results section.

---

## Slack OAuth App Requirements

The Slack app must be configured with:
- Redirect URI: `http://localhost:9119/callback`
- User Token Scopes: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `search:read`, `users:identity.basic`

---

## Build

```makefile
build:
	go build -ldflags="\
	  -X github.com/joe/whoneedsme/auth/embedded.SlackClientID=$(SLACK_CLIENT_ID) \
	  -X github.com/joe/whoneedsme/auth/embedded.JiraClientID=$(JIRA_CLIENT_ID)" \
	  -o whoneedsme ./...
```

Usage:
```
make build SLACK_CLIENT_ID=Axxx...
```

The client ID is not sensitive — it appears in OAuth redirect URLs and is safe to embed in a distributed binary. No client secret is used.

---

## JIRA Follow-on

JIRA requires the same changes: remove `clientSecret` from `OAuthConfig`, add `JiraClientID` to `auth/embedded`, register `http://localhost:9119/callback` in the Atlassian OAuth app. These changes are deferred and will be picked up in a follow-on plan.

---

## What Does Not Change

- `auth/store.go` token persistence logic — tokens are still stored and loaded the same way.
- `sources/slack/slack.go` Check logic — unchanged.
- `output/output.go` — unchanged.
- The `auth` command itself remains the explicit entry point. The CLI does not auto-trigger authentication.
