package auth_test

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/joe/whoneedsme/auth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

func TestRunFlow_CapturesCallback(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"test-token","token_type":"Bearer","refresh_token":"refresh-123","expires_in":3600}`))
	}))
	defer tokenServer.Close()

	conf := &oauth2.Config{
		ClientID: "test-client",
		Scopes:   []string{"read"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://example.com/auth",
			TokenURL: tokenServer.URL + "/token",
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var callbackURL string
	// Port 0 = random (for test isolation).
	token, err := auth.RunFlowWithOpener(ctx, conf, "test-state", func(authURL string) error {
		parsed, err := url.Parse(authURL)
		if err != nil {
			return err
		}
		// Verify PKCE params are present in the auth URL.
		assert.NotEmpty(t, parsed.Query().Get("code_challenge"))
		assert.Equal(t, "S256", parsed.Query().Get("code_challenge_method"))

		callbackURL = parsed.Query().Get("redirect_uri") + "?code=auth-code-abc&state=test-state"
		// Self-signed cert — skip TLS verification for the local test server.
		insecureClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}} //nolint:gosec
		go insecureClient.Get(callbackURL) //nolint:errcheck
		return nil
	}, 0)

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

	// Port 0 = random (for test isolation).
	_, err := auth.RunFlowWithOpener(ctx, conf, "state", func(authURL string) error {
		cancel()
		return nil
	}, 0)

	assert.ErrorIs(t, err, context.Canceled)
}
