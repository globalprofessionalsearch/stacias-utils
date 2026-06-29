package auth_test

import (
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

func TestStore_SetAndGetToken(t *testing.T) {
	store := newTestStore(t)

	token := &oauth2.Token{
		AccessToken:  "xoxp-abc",
		TokenType:    "Bearer",
		RefreshToken: "refresh-xyz",
		Expiry:       time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC),
	}
	// SetToken creates the source entry automatically — no setup required.
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
	require.NoError(t, store1.SetToken("jira", &oauth2.Token{AccessToken: "tok"}))

	store2, err := auth.NewStoreAt(path)
	require.NoError(t, err)
	tok, ok := store2.GetToken("jira")
	require.True(t, ok)
	assert.Equal(t, "tok", tok.AccessToken)
}

func TestStore_SetCloudID(t *testing.T) {
	store := newTestStore(t)
	// SetCloudID creates the source entry automatically — no setup required.
	require.NoError(t, store.SetCloudID("jira", "cloud-abc-123"))

	cfg, ok := store.GetSourceConfig("jira")
	require.True(t, ok)
	assert.Equal(t, "cloud-abc-123", cfg.CloudID)
}

func TestStore_SetToken_SetsDefaultTimeout(t *testing.T) {
	store := newTestStore(t)
	require.NoError(t, store.SetToken("slack", &oauth2.Token{AccessToken: "xoxp-abc"}))

	cfg, ok := store.GetSourceConfig("slack")
	require.True(t, ok)
	assert.Equal(t, 30, cfg.TimeoutSeconds)
}
