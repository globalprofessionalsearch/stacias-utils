# whoneedsme — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Overview

`whoneedsme` is an on-demand CLI tool written in Go that checks configured sources and surfaces items requiring the user's attention. The initial version supports Slack and JIRA. Authentication is handled via OAuth2 with a local callback server — no external auth tooling required.

---

## Architecture

Single Go binary. On invocation, all configured sources run concurrently. Results are collected and printed grouped by source.

```
whoneedsme/
├── main.go                  # Entry point
├── cmd/
│   └── root.go              # CLI setup (cobra)
├── auth/
│   ├── oauth.go             # Generic OAuth2 flow (local callback server)
│   └── store.go             # Token persistence (~/.config/whoneedsme/)
├── source/
│   └── source.go            # Source interface + Item struct
├── sources/
│   ├── slack/
│   │   └── slack.go
│   └── jira/
│       └── jira.go
└── output/
    └── output.go            # Terminal rendering
```

### Core Interface

```go
type Item struct {
    Source  string
    Title   string
    URL     string
    Summary string
}

type Source interface {
    Name() string
    Check(ctx context.Context) ([]Item, error)
}
```

---

## Authentication

OAuth2 credentials (client ID + secret) are registered once per platform in each platform's developer console and stored in `~/.config/whoneedsme/config.yaml` alongside access/refresh tokens.

**First-run flow:**
1. Source detects no token exists
2. Prints `"Opening browser for <Source> authentication..."`
3. Starts a local HTTP server on a random available port (`localhost:PORT/callback`)
4. Browser opens to the OAuth authorization URL
5. Platform redirects to local callback; token is captured, persisted, local server shuts down
6. Check proceeds immediately

**Subsequent runs:** tokens loaded from disk. Expired tokens are refreshed silently via refresh token. If refresh fails, the first-run flow re-triggers.

Auth is independent per source — already-authenticated sources are unaffected when a new source needs auth.

---

## Sources

### Slack

**Algorithm:** Find threads where the user is mentioned but has not directly replied in the thread after the mention.

1. Fetch all channels/DMs where user is a member
2. Search for messages that `@mention` the user's ID
3. For each mention, check if the thread contains a reply from the user posted *after* the mention timestamp
4. Surface threads with no such reply as `Item`s

**Item fields:**
- `Title`: channel/DM name
- `Summary`: truncated message preview ("Alice mentioned you: ...")
- `URL`: deep link to the thread

### JIRA

**Algorithm:** Find issues where the user is mentioned in a comment and has not posted a subsequent comment.

1. Query issues via JQL: `comment ~ "[~accountid:<id>]"` (JIRA's mention format in comments)
2. For each matching issue, fetch all comments and check if the user has posted any comment *after* the most recent mention
3. Surface issues with no such response as `Item`s

**Item fields:**
- `Title`: issue key + summary (e.g., `ENG-412 — Fix auth timeout in prod`)
- `Summary`: "Alice mentioned you in a comment"
- `URL`: issue URL

---

## CLI

```
whoneedsme                   # Run all sources
whoneedsme --source slack    # Run a single source
whoneedsme setup slack       # First-time setup: prompts for OAuth client ID/secret, then triggers auth flow
whoneedsme auth slack        # Re-trigger auth flow for an already-configured source
```

**Setup flow (`whoneedsme setup <source>`):**
1. Prompts for OAuth client ID and client secret (obtained from the platform's developer console)
2. Saves credentials to `~/.config/whoneedsme/config.yaml`
3. Immediately triggers the browser OAuth flow to obtain and store the access/refresh token

---

## Output Format

```
SLACK (3 items)
──────────────────────────────────────
• #engineering — Alice mentioned you: "hey @joe can you review..."
  https://app.slack.com/...

• @bob (DM) — Bob mentioned you: "did you see the issue with..."
  https://app.slack.com/...

JIRA (1 item)
──────────────────────────────────────
• ENG-412 — Fix auth timeout in prod
  Alice mentioned you in a comment
  https://yourorg.atlassian.net/browse/ENG-412

──────────────────────────────────────
4 items need your attention.
```

- If nothing needs attention: `All clear.`
- If a source errors: `SLACK — error: <message>` is printed and other results still display
- Each source has a configurable timeout (default 30s); timeout is treated as an error

---

## Error Handling

- Source errors are non-fatal — printed as warnings, other sources continue
- Auth failures trigger re-auth flow or a clear error message
- Network timeouts per source default to 30s

---

## Configuration

`~/.config/whoneedsme/config.yaml` stores:
- OAuth client ID + secret per source
- Persisted access/refresh tokens per source
- Optional per-source timeout override

---

## Future Extensions

The `Source` interface is the extension point for adding Notion, Gmail, and other sources. Each new source implements `Name()` and `Check()` and registers itself. No changes to core required.
