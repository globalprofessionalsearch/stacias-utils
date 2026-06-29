# whoneedsme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Go CLI that checks Slack and JIRA concurrently and prints items needing the user's attention, with seamless OAuth2 browser-based auth.

**Architecture:** Single binary with a `Source` interface each integration implements. A generic OAuth2 flow uses a local HTTP callback server to capture tokens. Sources run concurrently with a timeout; results are grouped and printed to stdout.

**Tech Stack:** Go 1.22+, `github.com/spf13/cobra` (CLI), `golang.org/x/oauth2` (OAuth2), `gopkg.in/yaml.v3` (config), `github.com/slack-go/slack` (Slack API), `github.com/andygrunwald/go-jira/v2` (JIRA API), `github.com/stretchr/testify` (test assertions)

---

## File Map

| File | Responsibility |
|------|---------------|
| `main.go` | Entry point — calls `cmd.Execute()` |
| `cmd/root.go` | Root cobra command, `--source` flag, concurrent source execution |
| `cmd/setup.go` | `setup <source>` subcommand — prompts for credentials, triggers OAuth |
| `cmd/auth.go` | `auth <source>` subcommand — re-triggers OAuth; shared `runOAuthFlow` helper |
| `auth/store.go` | Load/save `~/.config/whoneedsme/config.yaml`; CRUD for credentials and tokens |
| `auth/store_test.go` | Tests for Store using a temp config file |
| `auth/oauth.go` | Generic OAuth2 browser flow with local callback server |
| `auth/oauth_test.go` | Tests for OAuth callback handling using `httptest` |
| `source/source.go` | `Item` struct and `Source` interface |
| `sources/slack/slack.go` | Slack source: OAuth config, API interface, Check algorithm |
| `sources/slack/slack_test.go` | Tests using mock Slack API |
| `sources/jira/jira.go` | JIRA source: OAuth config, cloud ID fetch, API interface, Check algorithm |
| `sources/jira/jira_test.go` | Tests using mock JIRA API |
| `output/output.go` | Terminal rendering grouped by source |
| `output/output_test.go` | Tests for output formatting |

---

## Task 1: Initialize Go module and scaffold

**Files:**
- Create: `go.mod`
- Create: `main.go`

- [ ] **Step 1: Initialize the module**

```bash
cd /path/to/whoneedsme
go mod init github.com/joe/whoneedsme
```

Expected: `go.mod` created with `module github.com/joe/whoneedsme` and a `go 1.22` (or current) directive.

> Note: Replace `joe` with your actual GitHub username if you plan to publish, or keep as-is for a personal tool.

- [ ] **Step 2: Add dependencies**

```bash
go get github.com/spf13/cobra@latest
go get golang.org/x/oauth2@latest
go get gopkg.in/yaml.v3@latest
go get github.com/slack-go/slack@latest
go get github.com/andygrunwald/go-jira/v2@latest
go get github.com/stretchr/testify@latest
```

- [ ] **Step 3: Create main.go**

```go
package main

import "github.com/joe/whoneedsme/cmd"

func main() {
	cmd.Execute()
}
```

- [ ] **Step 4: Verify it compiles (will fail until cmd exists — that's fine)**

We'll come back to verify the build compiles end-to-end in Task 10.

---

## Task 2: Define source interface and Item struct

**Files:**
- Create: `source/source.go`
- Create: `source/source_test.go`

- [ ] **Step 1: Write the failing test**

```go
// source/source_test.go
package source_test

import (
	"testing"

	"github.com/joe/whoneedsme/source"
	"github.com/stretchr/testify/assert"
)

func TestItemFields(t *testing.T) {
	item := source.Item{
		Source:  "slack",
		Title:   "#engineering",
		URL:     "https://slack.com/archives/C123/p456",
		Summary: "Alice mentioned you",
	}
	assert.Equal(t, "slack", item.Source)
	assert.Equal(t, "#engineering", item.Title)
	assert.Equal(t, "https://slack.com/archives/C123/p456", item.URL)
	assert.Equal(t, "Alice mentioned you", item.Summary)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./source/...
```

Expected: compile error — package not found.

- [ ] **Step 3: Implement source/source.go**

```go
// source/source.go
package source

import "context"

// Item is a single thing that needs the user's attention.
type Item struct {
	Source  string
	Title   string
	URL     string
	Summary string
}

// Source checks one external service and returns items needing attention.
type Source interface {
	Name() string
	Check(ctx context.Context) ([]Item, error)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./source/...
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add source/source.go source/source_test.go
git commit -m "feat: add source.Item and source.Source interface"
```

---

## Task 3: Implement auth.Store (config persistence)

**Files:**
- Create: `auth/store.go`
- Create: `auth/store_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// auth/store_test.go
package auth_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/joe/whoneedsme/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

func newTestStore(t *testing.T) *auth.Store {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	store, err := auth.NewStoreAt(path)
	require.NoError(t, err)
	return store
}

func TestStore_SetAndGetCredentials(t *testing.T) {
	store := newTestStore(t)

	err := store.SetCredentials("slack", "client-id-123", "client-secret-abc")
	require.NoError(t, err)

	cfg, ok := store.GetSourceConfig("slack")
	require.True(t, ok)
	assert.Equal(t, "client-id-123", cfg.ClientID)
	assert.Equal(t, "client-secret-abc", cfg.ClientSecret)
}

func TestStore_SetAndGetToken(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.SetCredentials("slack", "id", "secret"))

	token := &oauth2.Token{
		AccessToken:  "xoxp-abc",
		TokenType:    "Bearer",
		RefreshToken: "refresh-xyz",
		Expiry:       time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC),
	}
	require.NoError(t, store.SetToken("slack", token))

	got, ok := store.GetToken("slack")
	require.True(t, ok)
	assert.Equal(t, "xoxp-abc", got.AccessToken)
	assert.Equal(t, "refresh-xyz", got.RefreshToken)
	assert.Equal(t, time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), got.Expiry)
}

func TestStore_GetToken_Missing(t *testing.T) {
	store := newTestStore(t)
	_, ok := store.GetToken("slack")
	assert.False(t, ok)
}

func TestStore_PersistsAcrossLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	store1, err := auth.NewStoreAt(path)
	require.NoError(t, err)
	require.NoError(t, store1.SetCredentials("jira", "jira-id", "jira-secret"))

	store2, err := auth.NewStoreAt(path)
	require.NoError(t, err)
	cfg, ok := store2.GetSourceConfig("jira")
	require.True(t, ok)
	assert.Equal(t, "jira-id", cfg.ClientID)
}

func TestStore_SetCloudID(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.SetCredentials("jira", "id", "secret"))
	require.NoError(t, store.SetCloudID("jira", "cloud-abc-123"))

	cfg, ok := store.GetSourceConfig("jira")
	require.True(t, ok)
	assert.Equal(t, "cloud-abc-123", cfg.CloudID)
}

func TestStore_DefaultTimeoutSeconds(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.SetCredentials("slack", "id", "secret"))
	cfg, ok := store.GetSourceConfig("slack")
	require.True(t, ok)
	assert.Equal(t, 30, cfg.TimeoutSeconds)
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./auth/...
```

Expected: compile error — package not found.

- [ ] **Step 3: Implement auth/store.go**

```go
// auth/store.go
package auth

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/oauth2"
	"gopkg.in/yaml.v3"
)

// SourceConfig holds credentials and token for one source.
type SourceConfig struct {
	ClientID       string     `yaml:"client_id"`
	ClientSecret   string     `yaml:"client_secret"`
	CloudID        string     `yaml:"cloud_id,omitempty"`
	TimeoutSeconds int        `yaml:"timeout_seconds"`
	Token          *TokenData `yaml:"token,omitempty"`
}

// TokenData is the persisted form of an oauth2.Token.
type TokenData struct {
	AccessToken  string    `yaml:"access_token"`
	TokenType    string    `yaml:"token_type"`
	RefreshToken string    `yaml:"refresh_token"`
	Expiry       time.Time `yaml:"expiry"`
}

type configFile struct {
	Sources map[string]*SourceConfig `yaml:"sources"`
}

// Store loads and saves the whoneedsme config file.
type Store struct {
	path string
	cfg  configFile
}

// NewStore creates a Store backed by the default config path (~/.config/whoneedsme/config.yaml).
func NewStore() (*Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return NewStoreAt(filepath.Join(home, ".config", "whoneedsme", "config.yaml"))
}

// NewStoreAt creates a Store backed by an explicit path. Used in tests.
func NewStoreAt(path string) (*Store, error) {
	s := &Store{path: path, cfg: configFile{Sources: make(map[string]*SourceConfig)}}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return yaml.Unmarshal(data, &s.cfg)
}

func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	data, err := yaml.Marshal(&s.cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0600)
}

// GetSourceConfig returns the config for a named source.
func (s *Store) GetSourceConfig(name string) (*SourceConfig, bool) {
	cfg, ok := s.cfg.Sources[name]
	return cfg, ok
}

// SetCredentials stores OAuth client ID and secret for a source.
func (s *Store) SetCredentials(source, clientID, clientSecret string) error {
	if _, ok := s.cfg.Sources[source]; !ok {
		s.cfg.Sources[source] = &SourceConfig{TimeoutSeconds: 30}
	}
	s.cfg.Sources[source].ClientID = clientID
	s.cfg.Sources[source].ClientSecret = clientSecret
	return s.save()
}

// SetToken stores an OAuth token for a source.
func (s *Store) SetToken(source string, token *oauth2.Token) error {
	if s.cfg.Sources[source] == nil {
		return fmt.Errorf("source %q not configured", source)
	}
	s.cfg.Sources[source].Token = &TokenData{
		AccessToken:  token.AccessToken,
		TokenType:    token.TokenType,
		RefreshToken: token.RefreshToken,
		Expiry:       token.Expiry,
	}
	return s.save()
}

// GetToken returns the stored OAuth token for a source, if present.
func (s *Store) GetToken(source string) (*oauth2.Token, bool) {
	cfg, ok := s.cfg.Sources[source]
	if !ok || cfg.Token == nil {
		return nil, false
	}
	return &oauth2.Token{
		AccessToken:  cfg.Token.AccessToken,
		TokenType:    cfg.Token.TokenType,
		RefreshToken: cfg.Token.RefreshToken,
		Expiry:       cfg.Token.Expiry,
	}, true
}

// SetCloudID stores the JIRA cloud ID for a source.
func (s *Store) SetCloudID(source, cloudID string) error {
	if s.cfg.Sources[source] == nil {
		return fmt.Errorf("source %q not configured", source)
	}
	s.cfg.Sources[source].CloudID = cloudID
	return s.save()
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./auth/... -run TestStore
```

Expected: `PASS` for all 6 store tests.

- [ ] **Step 5: Commit**

```bash
git add auth/store.go auth/store_test.go
git commit -m "feat: add auth.Store for credential and token persistence"
```

---

## Task 4: Implement auth.RunFlow (OAuth2 browser flow)

**Files:**
- Create: `auth/oauth.go`
- Create: `auth/oauth_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// auth/oauth_test.go
package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/joe/whoneedsme/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// TestRunFlow_CapturesCallback tests the callback capture path by simulating
// a browser redirect to the local callback URL after auth server approval.
func TestRunFlow_CapturesCallback(t *testing.T) {
	// Set up a fake token endpoint that returns a valid token.
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"test-token","token_type":"Bearer","refresh_token":"refresh-123","expires_in":3600}`))
	}))
	defer tokenServer.Close()

	conf := &oauth2.Config{
		ClientID:     "test-client",
		ClientSecret: "test-secret",
		Scopes:       []string{"read"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://example.com/auth",
			TokenURL: tokenServer.URL + "/token",
		},
	}

	// Capture the redirect URL that RunFlow sets, then simulate the browser
	// callback ourselves (instead of actually opening a browser).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var callbackURL string
	token, err := auth.RunFlowWithOpener(ctx, conf, "test-state", func(authURL string) error {
		// Parse redirect_uri from authURL to know which local port was chosen.
		parsed, err := url.Parse(authURL)
		if err != nil {
			return err
		}
		callbackURL = parsed.Query().Get("redirect_uri") + "?code=auth-code-abc&state=test-state"
		// Simulate the browser hitting the callback.
		go http.Get(callbackURL)
		return nil
	})

	require.NoError(t, err)
	require.NotNil(t, token)
	assert.Equal(t, "test-token", token.AccessToken)
	assert.Equal(t, "refresh-123", token.RefreshToken)
}

func TestRunFlow_ContextCancellation(t *testing.T) {
	conf := &oauth2.Config{
		ClientID: "test",
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://example.com/auth",
			TokenURL: "https://example.com/token",
		},
	}
	ctx, cancel := context.WithCancel(context.Background())

	_, err := auth.RunFlowWithOpener(ctx, conf, "state", func(authURL string) error {
		cancel() // cancel before any callback arrives
		return nil
	})

	assert.ErrorIs(t, err, context.Canceled)
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./auth/... -run TestRunFlow
```

Expected: compile error — `auth.RunFlowWithOpener` not found.

- [ ] **Step 3: Implement auth/oauth.go**

```go
// auth/oauth.go
package auth

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"runtime"

	"golang.org/x/oauth2"
)

// RunFlow opens the browser for OAuth and captures the callback token.
// It uses the default system browser opener.
func RunFlow(ctx context.Context, conf *oauth2.Config, state string) (*oauth2.Token, error) {
	return RunFlowWithOpener(ctx, conf, state, openBrowser)
}

// RunFlowWithOpener is like RunFlow but accepts a custom function to open the
// auth URL. This makes it testable without a real browser.
func RunFlowWithOpener(
	ctx context.Context,
	conf *oauth2.Config,
	state string,
	opener func(string) error,
) (*oauth2.Token, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("start local server: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	conf.RedirectURL = fmt.Sprintf("http://localhost:%d/callback", port)

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			errCh <- fmt.Errorf("no code in callback")
			http.Error(w, "authentication failed", http.StatusBadRequest)
			return
		}
		fmt.Fprintln(w, "Authentication successful! You can close this tab.")
		codeCh <- code
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(listener) //nolint:errcheck
	defer srv.Shutdown(context.Background()) //nolint:errcheck

	authURL := conf.AuthCodeURL(state, oauth2.AccessTypeOffline)
	if err := opener(authURL); err != nil {
		fmt.Printf("Open this URL in your browser:\n%s\n", authURL)
	}

	select {
	case code := <-codeCh:
		return conf.Exchange(ctx, code)
	case err := <-errCh:
		return nil, err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./auth/... -run TestRunFlow -v
```

Expected: both `TestRunFlow_CapturesCallback` and `TestRunFlow_ContextCancellation` PASS.

- [ ] **Step 5: Commit**

```bash
git add auth/oauth.go auth/oauth_test.go
git commit -m "feat: add OAuth2 browser flow with local callback server"
```

---

## Task 5: Implement output.Render

**Files:**
- Create: `output/output.go`
- Create: `output/output_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// output/output_test.go
package output_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/joe/whoneedsme/output"
	"github.com/joe/whoneedsme/source"
	"github.com/stretchr/testify/assert"
)

func TestRender_AllClear(t *testing.T) {
	var buf bytes.Buffer
	output.Render(&buf, map[string][]source.Item{}, map[string]error{})
	assert.Equal(t, "All clear.\n", buf.String())
}

func TestRender_SingleItem(t *testing.T) {
	var buf bytes.Buffer
	output.Render(&buf, map[string][]source.Item{
		"slack": {
			{Title: "#engineering", Summary: `Alice mentioned you: "hey can you review"`, URL: "https://slack.com/x"},
		},
	}, map[string]error{})

	out := buf.String()
	assert.Contains(t, out, "SLACK (1 item)")
	assert.Contains(t, out, "• #engineering")
	assert.Contains(t, out, `Alice mentioned you: "hey can you review"`)
	assert.Contains(t, out, "https://slack.com/x")
	assert.Contains(t, out, "1 item needs your attention.")
}

func TestRender_MultipleItems(t *testing.T) {
	var buf bytes.Buffer
	output.Render(&buf, map[string][]source.Item{
		"slack": {
			{Title: "#eng", Summary: "Alice mentioned you", URL: "https://slack.com/1"},
			{Title: "#eng", Summary: "Bob mentioned you", URL: "https://slack.com/2"},
		},
	}, map[string]error{})

	out := buf.String()
	assert.Contains(t, out, "SLACK (2 items)")
	assert.Contains(t, out, "2 items need your attention.")
}

func TestRender_SourceError(t *testing.T) {
	var buf bytes.Buffer
	output.Render(&buf, map[string][]source.Item{}, map[string]error{
		"jira": errors.New("connection timeout"),
	})

	out := buf.String()
	assert.Contains(t, out, "JIRA — error: connection timeout")
}

func TestRender_MixedItemsAndErrors(t *testing.T) {
	var buf bytes.Buffer
	output.Render(&buf, map[string][]source.Item{
		"slack": {
			{Title: "#eng", Summary: "Alice mentioned you", URL: "https://slack.com/1"},
		},
	}, map[string]error{
		"jira": errors.New("timeout"),
	})

	out := buf.String()
	assert.Contains(t, out, "JIRA — error: timeout")
	assert.Contains(t, out, "SLACK (1 item)")
	assert.Contains(t, out, "1 item needs your attention.")
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./output/...
```

Expected: compile error — package not found.

- [ ] **Step 3: Implement output/output.go**

```go
// output/output.go
package output

import (
	"fmt"
	"io"
	"strings"

	"github.com/joe/whoneedsme/source"
)

const divider = "──────────────────────────────────────"

// Render prints items grouped by source to w.
// Errors are printed as warnings; items with no results are skipped.
func Render(w io.Writer, results map[string][]source.Item, errors map[string]error) {
	for src, err := range errors {
		fmt.Fprintf(w, "%s — error: %s\n\n", strings.ToUpper(src), err.Error())
	}

	total := 0
	for src, items := range results {
		if len(items) == 0 {
			continue
		}
		total += len(items)
		fmt.Fprintf(w, "%s (%d %s)\n", strings.ToUpper(src), len(items), pluralItem(len(items)))
		fmt.Fprintln(w, divider)
		for _, item := range items {
			fmt.Fprintf(w, "• %s — %s\n  %s\n\n", item.Title, item.Summary, item.URL)
		}
	}

	if total == 0 && len(errors) == 0 {
		fmt.Fprintln(w, "All clear.")
		return
	}
	if total > 0 {
		fmt.Fprintln(w, divider)
		fmt.Fprintf(w, "%d %s need your attention.\n", total, pluralItem(total))
	}
}

func pluralItem(n int) string {
	if n == 1 {
		return "item needs"
	}
	return "items need"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./output/... -v
```

Expected: all 5 output tests PASS.

- [ ] **Step 5: Commit**

```bash
git add output/output.go output/output_test.go
git commit -m "feat: add output renderer"
```

---

## Task 6: Implement Slack source

**Files:**
- Create: `sources/slack/slack.go`
- Create: `sources/slack/slack_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// sources/slack/slack_test.go
package slack_test

import (
	"context"
	"testing"

	slacksource "github.com/joe/whoneedsme/sources/slack"
	goslack "github.com/slack-go/slack"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockSlackAPI implements slacksource.SlackAPI for testing.
type mockSlackAPI struct {
	userID   string
	messages []goslack.SearchMessage
	threads  map[string][]goslack.Message // key: "channelID:threadTS"
}

func (m *mockSlackAPI) AuthTest() (*goslack.AuthTestResponse, error) {
	return &goslack.AuthTestResponse{UserID: m.userID}, nil
}

func (m *mockSlackAPI) SearchMessages(query string, params goslack.SearchParameters) (*goslack.SearchMessages, *goslack.SearchFiles, error) {
	return &goslack.SearchMessages{Matches: m.messages}, nil, nil
}

func (m *mockSlackAPI) GetConversationReplies(params *goslack.GetConversationRepliesParameters) ([]goslack.Message, bool, string, error) {
	key := params.ChannelID + ":" + params.Timestamp
	msgs := m.threads[key]
	return msgs, false, "", nil
}

func TestSlack_NoMentions(t *testing.T) {
	api := &mockSlackAPI{userID: "U123", messages: nil}
	src := slacksource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestSlack_MentionWithReply(t *testing.T) {
	// Mention is in a thread at ts=100; user replied at ts=200. Should NOT surface.
	api := &mockSlackAPI{
		userID: "U123",
		messages: []goslack.SearchMessage{
			{
				Channel:         goslack.CtxChannel{ID: "C456", Name: "engineering"},
				Timestamp:       "100.000",
				ThreadTimestamp: "100.000",
				Text:            "hey <@U123> can you review?",
				Permalink:       "https://slack.com/archives/C456/p100",
			},
		},
		threads: map[string][]goslack.Message{
			"C456:100.000": {
				{Msg: goslack.Msg{User: "U789", Timestamp: "100.000", Text: "hey <@U123> can you review?"}},
				{Msg: goslack.Msg{User: "U123", Timestamp: "200.000", Text: "sure!"}},
			},
		},
	}
	src := slacksource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	assert.Empty(t, items, "thread with user reply should not surface")
}

func TestSlack_MentionWithoutReply(t *testing.T) {
	// Mention is in a thread at ts=100; only the mention itself is in the thread.
	api := &mockSlackAPI{
		userID: "U123",
		messages: []goslack.SearchMessage{
			{
				Channel:         goslack.CtxChannel{ID: "C456", Name: "engineering"},
				Timestamp:       "100.000",
				ThreadTimestamp: "100.000",
				Text:            "hey <@U123> can you help?",
				Permalink:       "https://slack.com/archives/C456/p100",
			},
		},
		threads: map[string][]goslack.Message{
			"C456:100.000": {
				{Msg: goslack.Msg{User: "U789", Timestamp: "100.000", Text: "hey <@U123> can you help?"}},
			},
		},
	}
	src := slacksource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "slack", items[0].Source)
	assert.Equal(t, "#engineering", items[0].Title)
	assert.Contains(t, items[0].Summary, "hey <@U123> can you help?")
	assert.Equal(t, "https://slack.com/archives/C456/p100", items[0].URL)
}

func TestSlack_MentionReplyBeforeMention(t *testing.T) {
	// User replied at ts=50, but the mention is at ts=100 — reply was BEFORE the mention.
	// Should surface.
	api := &mockSlackAPI{
		userID: "U123",
		messages: []goslack.SearchMessage{
			{
				Channel:         goslack.CtxChannel{ID: "C456", Name: "general"},
				Timestamp:       "100.000",
				ThreadTimestamp: "50.000",
				Text:            "btw <@U123> see above",
				Permalink:       "https://slack.com/archives/C456/p100",
			},
		},
		threads: map[string][]goslack.Message{
			"C456:50.000": {
				{Msg: goslack.Msg{User: "U123", Timestamp: "50.000", Text: "original message"}},
				{Msg: goslack.Msg{User: "U789", Timestamp: "100.000", Text: "btw <@U123> see above"}},
			},
		},
	}
	src := slacksource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	assert.Len(t, items, 1, "mention with no subsequent reply should surface")
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./sources/slack/...
```

Expected: compile error — package not found.

- [ ] **Step 3: Implement sources/slack/slack.go**

```go
// sources/slack/slack.go
package slack

import (
	"context"
	"fmt"
	"strings"

	"github.com/joe/whoneedsme/auth"
	"github.com/joe/whoneedsme/source"
	goslack "github.com/slack-go/slack"
	"golang.org/x/oauth2"
)

// SlackAPI is the subset of the Slack client used by this source.
// Defined as an interface for testability.
type SlackAPI interface {
	AuthTest() (*goslack.AuthTestResponse, error)
	SearchMessages(query string, params goslack.SearchParameters) (*goslack.SearchMessages, *goslack.SearchFiles, error)
	GetConversationReplies(params *goslack.GetConversationRepliesParameters) ([]goslack.Message, bool, string, error)
}

// OAuthConfig returns the OAuth2 config for Slack.
// Slack requires user scopes via the user_scope parameter (not scope),
// so we pass them as a custom auth URL param in RunFlow.
func OAuthConfig(clientID, clientSecret string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		// user_scope is set via AuthCodeURL option in cmd/auth.go
		Scopes: []string{},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://slack.com/oauth/v2/authorize",
			TokenURL: "https://slack.com/api/oauth.v2.access",
		},
	}
}

// UserScopes are the Slack user token scopes required by this source.
const UserScopes = "search:read,channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history"

// Source implements source.Source for Slack.
type Source struct {
	api SlackAPI
}

// New creates a Slack Source using credentials and token from the store.
// Returns an error if the source is not configured or not authenticated.
func New(store *auth.Store) (*Source, error) {
	cfg, ok := store.GetSourceConfig("slack")
	if !ok || cfg.ClientID == "" {
		return nil, fmt.Errorf("slack not configured: run 'whoneedsme setup slack'")
	}
	token, ok := store.GetToken("slack")
	if !ok {
		return nil, fmt.Errorf("slack not authenticated: run 'whoneedsme auth slack'")
	}
	client := goslack.New(token.AccessToken)
	return &Source{api: client}, nil
}

// NewWithAPI creates a Source with a custom API implementation. Used in tests.
func NewWithAPI(api SlackAPI) *Source {
	return &Source{api: api}
}

func (s *Source) Name() string { return "slack" }

// Check finds threads where the user is mentioned but has not replied after the mention.
func (s *Source) Check(ctx context.Context) ([]source.Item, error) {
	me, err := s.api.AuthTest()
	if err != nil {
		return nil, fmt.Errorf("slack auth test: %w", err)
	}

	query := fmt.Sprintf("<@%s>", me.UserID)
	msgs, _, err := s.api.SearchMessages(query, goslack.SearchParameters{Count: 100})
	if err != nil {
		return nil, fmt.Errorf("slack search: %w", err)
	}
	if msgs == nil {
		return nil, nil
	}

	var items []source.Item
	for _, msg := range msgs.Matches {
		threadTS := msg.ThreadTimestamp
		if threadTS == "" {
			threadTS = msg.Timestamp
		}
		replied, err := s.userRepliedAfter(msg.Channel.ID, threadTS, msg.Timestamp, me.UserID)
		if err != nil {
			// Skip messages we can't fetch thread for.
			continue
		}
		if !replied {
			items = append(items, source.Item{
				Source:  "slack",
				Title:   "#" + msg.Channel.Name,
				Summary: truncate(msg.Text, 80),
				URL:     msg.Permalink,
			})
		}
	}
	return items, nil
}

// userRepliedAfter returns true if the user has a message in the thread with
// timestamp > mentionTS.
func (s *Source) userRepliedAfter(channelID, threadTS, mentionTS, userID string) (bool, error) {
	replies, _, _, err := s.api.GetConversationReplies(&goslack.GetConversationRepliesParameters{
		ChannelID: channelID,
		Timestamp: threadTS,
	})
	if err != nil {
		return false, err
	}
	for _, reply := range replies {
		if reply.User == userID && reply.Timestamp > mentionTS {
			return true, nil
		}
	}
	return false, nil
}

func truncate(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./sources/slack/... -v
```

Expected: all 4 Slack tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sources/slack/slack.go sources/slack/slack_test.go
git commit -m "feat: add Slack source"
```

---

## Task 7: Implement JIRA source

**Files:**
- Create: `sources/jira/jira.go`
- Create: `sources/jira/jira_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// sources/jira/jira_test.go
package jira_test

import (
	"context"
	"testing"
	"time"

	jirasource "github.com/joe/whoneedsme/sources/jira"
	gojira "github.com/andygrunwald/go-jira/v2/cloud"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockJiraAPI struct {
	accountID string
	issues    []gojira.Issue
}

func (m *mockJiraAPI) GetCurrentUser(ctx context.Context) (*gojira.User, error) {
	return &gojira.User{AccountID: m.accountID}, nil
}

func (m *mockJiraAPI) SearchIssues(ctx context.Context, jql string, opts *gojira.SearchOptions) ([]gojira.Issue, error) {
	return m.issues, nil
}

func ts(t string) time.Time {
	parsed, _ := time.Parse(time.RFC3339, t)
	return parsed
}

func makeComment(accountID string, created time.Time, body string) gojira.Comment {
	return gojira.Comment{
		Author:  gojira.User{AccountID: accountID},
		Created: created.Format(time.RFC3339),
		Body:    body,
	}
}

func TestJIRA_NoMentions(t *testing.T) {
	api := &mockJiraAPI{accountID: "acc-123", issues: nil}
	src := jirasource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	assert.Empty(t, items)
}

func TestJIRA_MentionWithSubsequentReply(t *testing.T) {
	// Comment 1 (ts 10:00) mentions the user. Comment 2 (ts 11:00) is from the user.
	// Should NOT surface.
	api := &mockJiraAPI{
		accountID: "acc-123",
		issues: []gojira.Issue{
			{
				Key: "ENG-1",
				Fields: &gojira.IssueFields{
					Summary: "Fix the thing",
					Comments: &gojira.Comments{
						Comments: []*gojira.Comment{
							ptr(makeComment("other-user", ts("2026-03-30T10:00:00Z"), "[~accountid:acc-123] please review")),
							ptr(makeComment("acc-123", ts("2026-03-30T11:00:00Z"), "Done!")),
						},
					},
				},
			},
		},
	}
	src := jirasource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	assert.Empty(t, items, "issue with user reply after mention should not surface")
}

func TestJIRA_MentionWithoutReply(t *testing.T) {
	// Comment mentions the user but no subsequent user comment.
	api := &mockJiraAPI{
		accountID: "acc-123",
		issues: []gojira.Issue{
			{
				Key:  "ENG-2",
				Self: "https://acme.atlassian.net/rest/api/3/issue/ENG-2",
				Fields: &gojira.IssueFields{
					Summary: "Investigate outage",
					Comments: &gojira.Comments{
						Comments: []*gojira.Comment{
							ptr(makeComment("other-user", ts("2026-03-30T10:00:00Z"), "[~accountid:acc-123] what do you think?")),
						},
					},
				},
			},
		},
	}
	src := jirasource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, "jira", items[0].Source)
	assert.Equal(t, "ENG-2 — Investigate outage", items[0].Title)
	assert.Equal(t, "You were mentioned in a comment", items[0].Summary)
}

func TestJIRA_MentionWithReplyBeforeMention(t *testing.T) {
	// User commented at 09:00, then was mentioned at 10:00 — reply was before mention.
	// Should surface.
	api := &mockJiraAPI{
		accountID: "acc-123",
		issues: []gojira.Issue{
			{
				Key: "ENG-3",
				Fields: &gojira.IssueFields{
					Summary: "Perf regression",
					Comments: &gojira.Comments{
						Comments: []*gojira.Comment{
							ptr(makeComment("acc-123", ts("2026-03-30T09:00:00Z"), "I looked into this")),
							ptr(makeComment("other-user", ts("2026-03-30T10:00:00Z"), "[~accountid:acc-123] still broken")),
						},
					},
				},
			},
		},
	}
	src := jirasource.NewWithAPI(api)

	items, err := src.Check(context.Background())
	require.NoError(t, err)
	assert.Len(t, items, 1)
}

func ptr(c gojira.Comment) *gojira.Comment { return &c }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./sources/jira/...
```

Expected: compile error — package not found.

- [ ] **Step 3: Implement sources/jira/jira.go**

```go
// sources/jira/jira.go
package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	gojira "github.com/andygrunwald/go-jira/v2/cloud"
	"github.com/joe/whoneedsme/auth"
	"github.com/joe/whoneedsme/source"
	"golang.org/x/oauth2"
)

// JiraAPI is the subset of the JIRA client used by this source.
type JiraAPI interface {
	GetCurrentUser(ctx context.Context) (*gojira.User, error)
	SearchIssues(ctx context.Context, jql string, opts *gojira.SearchOptions) ([]gojira.Issue, error)
}

// OAuthConfig returns the OAuth2 config for Atlassian/JIRA.
func OAuthConfig(clientID, clientSecret string) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Scopes:       []string{"read:jira-work", "read:jira-user", "offline_access"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://auth.atlassian.com/authorize",
			TokenURL: "https://auth.atlassian.com/oauth/token",
		},
	}
}

// FetchCloudID retrieves the first accessible Atlassian cloud resource ID.
// Must be called after OAuth to get the JIRA cloud ID for API calls.
func FetchCloudID(accessToken string) (string, error) {
	req, err := http.NewRequest("GET", "https://api.atlassian.com/oauth/token/accessible-resources", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch accessible resources: %w", err)
	}
	defer resp.Body.Close()

	var resources []struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&resources); err != nil {
		return "", fmt.Errorf("decode accessible resources: %w", err)
	}
	if len(resources) == 0 {
		return "", fmt.Errorf("no accessible JIRA resources found")
	}
	return resources[0].ID, nil
}

// realJiraAPI wraps the go-jira client to implement JiraAPI.
type realJiraAPI struct {
	client *gojira.Client
}

func (r *realJiraAPI) GetCurrentUser(ctx context.Context) (*gojira.User, error) {
	user, _, err := r.client.User.GetSelf(ctx)
	return user, err
}

func (r *realJiraAPI) SearchIssues(ctx context.Context, jql string, opts *gojira.SearchOptions) ([]gojira.Issue, error) {
	issues, _, err := r.client.Issue.Search(ctx, jql, opts)
	return issues, err
}

// Source implements source.Source for JIRA.
type Source struct {
	api JiraAPI
}

// New creates a JIRA Source using credentials and token from the store.
func New(store *auth.Store) (*Source, error) {
	cfg, ok := store.GetSourceConfig("jira")
	if !ok || cfg.ClientID == "" {
		return nil, fmt.Errorf("jira not configured: run 'whoneedsme setup jira'")
	}
	token, ok := store.GetToken("jira")
	if !ok {
		return nil, fmt.Errorf("jira not authenticated: run 'whoneedsme auth jira'")
	}
	if cfg.CloudID == "" {
		return nil, fmt.Errorf("jira cloud ID missing: run 'whoneedsme auth jira'")
	}

	// Use oauthConf.TokenSource so expired tokens are refreshed automatically.
	oauthConf := OAuthConfig(cfg.ClientID, cfg.ClientSecret)
	httpClient := oauth2.NewClient(context.Background(), oauthConf.TokenSource(context.Background(), token))
	baseURL := fmt.Sprintf("https://api.atlassian.com/ex/jira/%s/", cfg.CloudID)
	client, err := gojira.NewClient(baseURL, httpClient)
	if err != nil {
		return nil, fmt.Errorf("create jira client: %w", err)
	}
	return &Source{api: &realJiraAPI{client: client}}, nil
}

// NewWithAPI creates a Source with a custom API implementation. Used in tests.
func NewWithAPI(api JiraAPI) *Source {
	return &Source{api: api}
}

func (s *Source) Name() string { return "jira" }

// Check finds JIRA issues where the user is mentioned but hasn't replied.
func (s *Source) Check(ctx context.Context) ([]source.Item, error) {
	me, err := s.api.GetCurrentUser(ctx)
	if err != nil {
		return nil, fmt.Errorf("jira get current user: %w", err)
	}

	mention := fmt.Sprintf("[~accountid:%s]", me.AccountID)
	jql := fmt.Sprintf(`comment ~ "%s" ORDER BY updated DESC`, mention)
	issues, err := s.api.SearchIssues(ctx, jql, &gojira.SearchOptions{MaxResults: 50})
	if err != nil {
		return nil, fmt.Errorf("jira search: %w", err)
	}

	var items []source.Item
	for _, issue := range issues {
		if needsReply(issue, me.AccountID, mention) {
			items = append(items, source.Item{
				Source:  "jira",
				Title:   fmt.Sprintf("%s — %s", issue.Key, issue.Fields.Summary),
				Summary: "You were mentioned in a comment",
				URL:     issueURL(issue),
			})
		}
	}
	return items, nil
}

// needsReply returns true if the user has been mentioned in a comment and has
// not posted any comment after the most recent mention.
func needsReply(issue gojira.Issue, accountID, mention string) bool {
	if issue.Fields == nil || issue.Fields.Comments == nil {
		return false
	}
	comments := issue.Fields.Comments.Comments

	// Find the timestamp of the most recent mention.
	var lastMentionTime time.Time
	for _, c := range comments {
		if c == nil || c.Author.AccountID == accountID {
			continue
		}
		if strings.Contains(c.Body, mention) {
			t, err := time.Parse(time.RFC3339, c.Created)
			if err != nil {
				continue
			}
			if t.After(lastMentionTime) {
				lastMentionTime = t
			}
		}
	}
	if lastMentionTime.IsZero() {
		return false
	}

	// Check if the user commented after the last mention.
	for _, c := range comments {
		if c == nil || c.Author.AccountID != accountID {
			continue
		}
		t, err := time.Parse(time.RFC3339, c.Created)
		if err != nil {
			continue
		}
		if t.After(lastMentionTime) {
			return false
		}
	}
	return true
}

func issueURL(issue gojira.Issue) string {
	// issue.Self is like https://acme.atlassian.net/rest/api/3/issue/ENG-1
	// We want https://acme.atlassian.net/browse/ENG-1
	if issue.Self != "" {
		parts := strings.Split(issue.Self, "/rest/")
		if len(parts) >= 2 {
			return parts[0] + "/browse/" + issue.Key
		}
	}
	return issue.Key
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./sources/jira/... -v
```

Expected: all 4 JIRA tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sources/jira/jira.go sources/jira/jira_test.go
git commit -m "feat: add JIRA source"
```

---

## Task 8: Implement CLI commands

**Files:**
- Create: `cmd/root.go`
- Create: `cmd/setup.go`
- Create: `cmd/auth.go`

No unit tests for cmd — these are thin wiring layers. Verified by the smoke test in Task 10.

- [ ] **Step 1: Create cmd/root.go**

```go
// cmd/root.go
package cmd

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/joe/whoneedsme/auth"
	"github.com/joe/whoneedsme/output"
	"github.com/joe/whoneedsme/source"
	jirasource "github.com/joe/whoneedsme/sources/jira"
	slacksource "github.com/joe/whoneedsme/sources/slack"
	"github.com/spf13/cobra"
)

var sourceFilter string

var rootCmd = &cobra.Command{
	Use:   "whoneedsme",
	Short: "Check if your attention is needed anywhere",
	RunE:  runCheck,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&sourceFilter, "source", "", "Run only this source (slack, jira)")
}

// Execute is the entry point called from main.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runCheck(cmd *cobra.Command, args []string) error {
	store, err := auth.NewStore()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	sources := buildSources(store)
	if sourceFilter != "" {
		sources = filterSources(sources, sourceFilter)
		if len(sources) == 0 {
			return fmt.Errorf("unknown source %q", sourceFilter)
		}
	}
	if len(sources) == 0 {
		fmt.Fprintln(os.Stderr, "No sources configured. Run 'whoneedsme setup slack' or 'whoneedsme setup jira' to get started.")
		return nil
	}

	results := make(map[string][]source.Item)
	errors := make(map[string]error)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, src := range sources {
		wg.Add(1)
		go func(s source.Source) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			items, err := s.Check(ctx)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errors[s.Name()] = err
			} else {
				results[s.Name()] = items
			}
		}(src)
	}

	wg.Wait()
	output.Render(os.Stdout, results, errors)
	return nil
}

func buildSources(store *auth.Store) []source.Source {
	var sources []source.Source
	if s, err := slacksource.New(store); err == nil {
		sources = append(sources, s)
	}
	if s, err := jirasource.New(store); err == nil {
		sources = append(sources, s)
	}
	return sources
}

func filterSources(sources []source.Source, name string) []source.Source {
	for _, s := range sources {
		if s.Name() == name {
			return []source.Source{s}
		}
	}
	return nil
}
```

- [ ] **Step 2: Create cmd/auth.go**

```go
// cmd/auth.go
package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/joe/whoneedsme/auth"
	jirasource "github.com/joe/whoneedsme/sources/jira"
	slacksource "github.com/joe/whoneedsme/sources/slack"
	"github.com/spf13/cobra"
	"golang.org/x/oauth2"
)

var authCmd = &cobra.Command{
	Use:   "auth <source>",
	Short: "Re-authenticate with a source",
	Args:  cobra.ExactArgs(1),
	RunE:  runAuth,
}

func init() {
	rootCmd.AddCommand(authCmd)
}

func runAuth(cmd *cobra.Command, args []string) error {
	sourceName := args[0]
	store, err := auth.NewStore()
	if err != nil {
		return err
	}
	return runOAuthFlow(sourceName, store)
}

// runOAuthFlow is shared by the setup and auth commands.
func runOAuthFlow(sourceName string, store *auth.Store) error {
	cfg, ok := store.GetSourceConfig(sourceName)
	if !ok || cfg.ClientID == "" {
		return fmt.Errorf("source %q not configured. Run 'whoneedsme setup %s' first", sourceName, sourceName)
	}

	oauthConf := oauthConfigFor(sourceName, cfg.ClientID, cfg.ClientSecret)
	if oauthConf == nil {
		return fmt.Errorf("unknown source %q", sourceName)
	}

	fmt.Fprintf(os.Stderr, "Opening browser for %s authentication...\n", sourceName)
	token, err := auth.RunFlow(context.Background(), oauthConf, sourceName)
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}

	if err := store.SetToken(sourceName, token); err != nil {
		return fmt.Errorf("save token: %w", err)
	}

	// JIRA requires fetching the cloud ID after OAuth.
	if sourceName == "jira" {
		cloudID, err := jirasource.FetchCloudID(token.AccessToken)
		if err != nil {
			return fmt.Errorf("fetch JIRA cloud ID: %w", err)
		}
		if err := store.SetCloudID("jira", cloudID); err != nil {
			return fmt.Errorf("save cloud ID: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "Successfully authenticated with %s.\n", sourceName)
	return nil
}

// oauthConfigFor returns the OAuth2 config for a named source.
func oauthConfigFor(sourceName, clientID, clientSecret string) *oauth2.Config {
	switch sourceName {
	case "slack":
		return slacksource.OAuthConfig(clientID, clientSecret)
	case "jira":
		return jirasource.OAuthConfig(clientID, clientSecret)
	default:
		return nil
	}
}
```

- [ ] **Step 3: Create cmd/setup.go**

```go
// cmd/setup.go
package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/joe/whoneedsme/auth"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup <source>",
	Short: "Configure a source for the first time",
	Args:  cobra.ExactArgs(1),
	RunE:  runSetup,
}

func init() {
	rootCmd.AddCommand(setupCmd)
}

func runSetup(cmd *cobra.Command, args []string) error {
	sourceName := args[0]
	if oauthConfigFor(sourceName, "", "") == nil {
		return fmt.Errorf("unknown source %q. Valid sources: slack, jira", sourceName)
	}

	store, err := auth.NewStore()
	if err != nil {
		return err
	}

	scanner := bufio.NewScanner(os.Stdin)

	fmt.Printf("OAuth Client ID for %s: ", sourceName)
	scanner.Scan()
	clientID := strings.TrimSpace(scanner.Text())
	if clientID == "" {
		return fmt.Errorf("client ID cannot be empty")
	}

	fmt.Printf("OAuth Client Secret for %s: ", sourceName)
	scanner.Scan()
	clientSecret := strings.TrimSpace(scanner.Text())
	if clientSecret == "" {
		return fmt.Errorf("client secret cannot be empty")
	}

	if err := store.SetCredentials(sourceName, clientID, clientSecret); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}

	return runOAuthFlow(sourceName, store)
}
```

- [ ] **Step 4: Verify it compiles**

```bash
go build ./...
```

Expected: success, no errors.

- [ ] **Step 5: Commit**

```bash
git add cmd/root.go cmd/setup.go cmd/auth.go
git commit -m "feat: add CLI commands (root, setup, auth)"
```

---

## Task 9: Final wiring and smoke test

**Files:**
- Modify: `main.go` (already written in Task 1; verify it's correct)

- [ ] **Step 1: Build the binary**

```bash
go build -o whoneedsme .
```

Expected: `whoneedsme` binary created in the current directory.

- [ ] **Step 2: Verify help output**

```bash
./whoneedsme --help
```

Expected output contains:
```
Check if your attention is needed anywhere

Usage:
  whoneedsme [flags]
  whoneedsme [command]

Available Commands:
  auth        Re-authenticate with a source
  setup       Configure a source for the first time

Flags:
      --source string   Run only this source (slack, jira)
```

- [ ] **Step 3: Verify the no-sources message**

```bash
./whoneedsme
```

Expected (assuming no config file exists yet):
```
No sources configured. Run 'whoneedsme setup slack' or 'whoneedsme setup jira' to get started.
```

- [ ] **Step 4: Run the full test suite**

```bash
go test ./... -v
```

Expected: all tests PASS, no failures.

- [ ] **Step 5: Commit and tag**

```bash
git add main.go
git commit -m "feat: wire up main entry point"
git tag v0.1.0
```

---

## Manual Verification Steps (post-implementation)

Once you have OAuth app credentials from each platform:

**Slack setup:**
1. Go to https://api.slack.com/apps → Create New App → From scratch
2. Under "OAuth & Permissions" → add User Token Scopes: `search:read`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`
3. Under "OAuth & Permissions" → note the Client ID and Client Secret
4. Add `http://localhost` as an allowed redirect URL (the port will be random, but Slack allows any `localhost` port)
5. Run: `./whoneedsme setup slack`

**JIRA setup:**
1. Go to https://developer.atlassian.com/console/myapps/ → Create → OAuth 2.0 integration
2. Add scopes: `read:jira-work`, `read:jira-user`
3. Set callback URL to `http://localhost` (Atlassian also allows any localhost port)
4. Note Client ID and Client Secret
5. Run: `./whoneedsme setup jira`

**Run a check:**
```bash
./whoneedsme
```
