// cmd/auth.go
package cmd

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/joe/whoneedsme/auth"
	"github.com/joe/whoneedsme/auth/embedded"
	jirasource "github.com/joe/whoneedsme/sources/jira"
	slacksource "github.com/joe/whoneedsme/sources/slack"
	"github.com/spf13/cobra"
	"golang.org/x/oauth2"
)

var authCmd = &cobra.Command{
	Use:   "auth <source>",
	Short: "Authenticate with a source",
	Args:  cobra.ExactArgs(1),
	RunE:  runAuth,
}

func init() {
	rootCmd.AddCommand(authCmd)
}

func generateState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

func runAuth(cmd *cobra.Command, args []string) error {
	sourceName := args[0]
	store, err := auth.NewStore()
	if err != nil {
		return err
	}
	return runOAuthFlow(sourceName, store)
}

// runOAuthFlow drives the PKCE browser flow for a source.
func runOAuthFlow(sourceName string, store *auth.Store) error {
	oauthConf := oauthConfigFor(sourceName)
	if oauthConf == nil {
		return fmt.Errorf("unknown source %q. Valid sources: slack, jira", sourceName)
	}

	if oauthConf.ClientID == "" {
		return fmt.Errorf("%s client ID not set: rebuild with 'make build %s_CLIENT_ID=<id>'",
			sourceName, strings.ToUpper(sourceName))
	}

	fmt.Fprintf(os.Stderr, "Opening browser for %s authentication...\n", sourceName)

	var opts []oauth2.AuthCodeOption
	if sourceName == "slack" {
		// Slack uses user_scope (not scope) for user token permissions.
		opts = append(opts, oauth2.SetAuthURLParam("user_scope", slacksource.UserScopes))
	}

	state, err := generateState()
	if err != nil {
		return fmt.Errorf("generate OAuth state: %w", err)
	}

	ctx := context.Background()
	if sourceName == "slack" {
		ctx = slacksource.ContextWithExchange(ctx)
	}

	token, err := auth.RunFlow(ctx, oauthConf, state, opts...)
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}

	if err := store.SetToken(sourceName, token); err != nil {
		return fmt.Errorf("save token: %w", err)
	}

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

// oauthConfigFor returns the OAuth2 config for a named source using embedded client IDs.
func oauthConfigFor(sourceName string) *oauth2.Config {
	switch sourceName {
	case "slack":
		return slacksource.OAuthConfig(embedded.SlackClientID)
	case "jira":
		return jirasource.OAuthConfig(embedded.JiraClientID, "") // no client secret — PKCE flow
	default:
		return nil
	}
}
