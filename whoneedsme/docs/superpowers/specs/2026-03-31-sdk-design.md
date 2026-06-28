# SDK Design Spec

**Date:** 2026-03-31
**Status:** Approved

## Overview

Replace the ad-hoc source wiring in `cmd/` with a clean SDK (`sdk/`) that defines what it means to be an integration and provides the coordination infrastructure. Clients (CLI, TUI, or anything else) build on top of the SDK without touching source logic or auth plumbing.

The goal: adding a new integration means implementing one interface and registering it in one place. Nothing else changes.

---

## Motivation

The current codebase has no shared contract beyond `Name()` and `Check()`. Auth config, token handling, and check logic are scattered — `OAuthConfig` is a package-level function, `New(store)` pulls tokens internally, and `cmd/root.go` contains ad-hoc goroutine coordination and source-specific auth wiring. Adding a new source today requires knowing how several unrelated files fit together.

The SDK makes that contract explicit and moves all coordination out of `cmd/`.

---

## Package Structure

```
sdk/            — Integration interface, Item, Result, Event, Engine
sources/slack/  — Implements sdk.Integration (auth config + check logic)
sources/jira/   — Implements sdk.Integration (auth config + check logic)
auth/           — Unchanged: token storage, PKCE browser flow
output/         — Unchanged: non-TTY rendering
cmd/            — Thin wiring layer: builds integrations, runs engine, renders
source/         — Deleted: replaced by sdk.Item and sdk.Result
```

`sdk/` imports `auth/` for the store. `sources/*` import `sdk/` for the interface. `cmd/` imports `sdk/`, `auth/`, `sources/*`, and `output/`. No circular dependencies.

---

## Core Types

```go
// sdk/sdk.go

// Item is a single thing that needs the user's attention.
type Item struct {
    Source  string
    Title   string
    URL     string
    Summary string
}

// Result is one item or one error emitted during a Check pass.
type Result struct {
    Item Item
    Err  error
}
```

---

## Integration Interface

```go
// sdk/sdk.go

// Integration is the contract every source must satisfy to work with the SDK.
// The SDK owns the authenticated HTTP client — integrations never manage tokens.
type Integration interface {
    // Name returns the stable identifier for this integration (e.g. "slack").
    // Used as the storage key for tokens and configuration.
    Name() string

    // OAuthConfig returns the OAuth2 configuration for this integration.
    // The SDK uses this to drive the browser auth flow and token refresh.
    // For PKCE integrations (e.g. Google), ClientSecret may be empty.
    OAuthConfig() *oauth2.Config

    // ExchangeContext returns a context to use during the OAuth token exchange.
    // Most integrations return ctx unchanged. Integrations with non-standard
    // token response shapes (e.g. Slack's authed_user wrapper) return a context
    // carrying a custom HTTP client that rewrites the response before the
    // oauth2 library parses it.
    ExchangeContext(ctx context.Context) context.Context

    // Check runs one fetch pass, sending items as they are found.
    // client is a pre-built, authenticated HTTP client — integrations make
    // requests directly without managing token refresh or storage.
    // The channel is closed when the pass is complete.
    Check(ctx context.Context, client *http.Client) <-chan Result
}
```

---

## Engine

The Engine replaces the goroutine fan-out in `cmd/root.go`. It runs all integrations concurrently, builds authenticated HTTP clients, and streams typed events to the caller.

```go
// sdk/engine.go

// Event is emitted by the Engine as integrations run.
// Exactly one of Item, Err, or Done is meaningful per event.
type Event struct {
    Integration string

    Item *Item  // an item was found; nil otherwise
    Err  error  // a non-fatal error occurred; more events may follow for this integration
    Done bool   // this integration's pass is complete; no more events for it
}

type Engine struct {
    integrations []Integration
    store        *auth.Store
    timeout      time.Duration
}

func New(integrations []Integration, store *auth.Store, timeout time.Duration) *Engine

// Run starts all integrations concurrently and returns a channel of events.
// Events stream in as items are discovered. The channel is closed when all
// integrations have completed or the context is cancelled.
func (e *Engine) Run(ctx context.Context) <-chan Event
```

**Auth handling inside Run:**

For each integration, the Engine:
1. Calls `store.GetToken(integration.Name())`.
2. If the token is missing, emits `Event{Err: ErrNotAuthenticated}` then `Event{Done: true}` and skips the integration. `ErrNotAuthenticated` is an exported sentinel in `sdk/` so clients can identify this case specifically (e.g. to show "run: whoneedsme auth slack").
3. If the token is present, builds an `*http.Client` using `oauth2.NewClient` with the integration's config as the token source (handles refresh transparently).
4. Calls `integration.Check(ctx, client)` and fans events onto the output channel.
5. When `Check`'s channel closes, emits `Event{Done: true}`.

Each integration runs in its own goroutine. The output channel is closed after all goroutines finish.

---

## Migration of Existing Sources

Both `sources/slack/` and `sources/jira/` change in three ways:

**1. Drop `New(store *auth.Store)`**
The source no longer constructs an auth/HTTP client internally. It becomes a stateless struct with no required setup.

**2. `OAuthConfig()` and `ExchangeContext()` become interface methods**
Currently package-level functions. They move onto the source struct so everything about an integration is in one file.

**3. `Check()` receives `*http.Client`**
The Engine provides the authenticated client. The source uses it to construct its API client:

```go
// Jira
client, err := gojira.NewClient(baseURL, httpClient)

// Slack
client := goslack.New("", goslack.OptionHTTPClient(httpClient))
```

The `source/` package is deleted. All references to `source.Item` and `source.Source` are updated to `sdk.Item` and `sdk.Integration`.

---

## cmd/ Changes

`cmd/root.go` becomes a thin wiring layer:

```go
func runCheck(cmd *cobra.Command, args []string) error {
    store, err := auth.NewStore()
    // ...
    integrations := []sdk.Integration{
        &slack.Integration{},
        &jira.Integration{},
    }

    engine := sdk.New(integrations, store, 30*time.Second)
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    results := map[string][]sdk.Item{}
    errors  := map[string]error{}
    for event := range engine.Run(ctx) {
        switch {
        case event.Item != nil:
            results[event.Integration] = append(results[event.Integration], *event.Item)
        case event.Err != nil:
            errors[event.Integration] = event.Err
        }
    }
    output.Render(os.Stdout, results, errors)
    return nil
}
```

`cmd/auth.go` simplifies similarly: instead of source-specific `oauthConfigFor()` and context handling, it iterates registered integrations and calls `OAuthConfig()` and `ExchangeContext()` directly.

---

## Adding a New Integration

To add `sources/github/` (for example):

1. Create `sources/github/github.go` implementing `sdk.Integration`
2. Add `&github.Integration{}` to the slice in `cmd/root.go`
3. Add the client ID to `auth/embedded/credentials.go` and `Makefile`

Nothing else changes.

---

## What Does Not Change

- `auth/` — entirely unchanged
- `output/output.go` — unchanged, updated to use `sdk.Item` instead of `source.Item`
- The PKCE browser flow and token storage
- Existing check logic in `sources/slack/` and `sources/jira/` — same logic, adapted to the new interface
