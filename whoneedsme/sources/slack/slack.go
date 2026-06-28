// sources/slack/slack.go
package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/joe/whoneedsme/auth"
	"github.com/joe/whoneedsme/source"
	goslack "github.com/slack-go/slack"
	"golang.org/x/oauth2"
)

// SearchMessage is a flattened representation of a Slack search result message.
// It mirrors the relevant fields of goslack.SearchMessage but adds ThreadTimestamp,
// which the Slack API returns as "thread_ts" in search results but is not present
// in the goslack.SearchMessage struct.
type SearchMessage struct {
	ChannelID       string
	ChannelName     string
	Timestamp       string
	ThreadTimestamp string
	Text            string
	Permalink       string
}

// SlackAPI is the subset of the Slack client used by this source.
// Defined as an interface for testability.
type SlackAPI interface {
	AuthTest() (*goslack.AuthTestResponse, error)
	SearchMessages(query string, params goslack.SearchParameters) ([]SearchMessage, error)
	GetConversationReplies(params *goslack.GetConversationRepliesParameters) ([]goslack.Message, bool, string, error)
}

// clientAdapter wraps the real goslack.Client and adapts its methods to our SlackAPI interface.
type clientAdapter struct {
	client *goslack.Client
}

func (a *clientAdapter) AuthTest() (*goslack.AuthTestResponse, error) {
	return a.client.AuthTest()
}

func (a *clientAdapter) SearchMessages(query string, params goslack.SearchParameters) ([]SearchMessage, error) {
	result, err := a.client.SearchMessages(query, params)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, nil
	}
	msgs := make([]SearchMessage, len(result.Matches))
	for i, m := range result.Matches {
		msgs[i] = SearchMessage{
			ChannelID:   m.Channel.ID,
			ChannelName: m.Channel.Name,
			Timestamp:   m.Timestamp,
			Text:        m.Text,
			Permalink:   m.Permalink,
			// ThreadTimestamp is not in goslack.SearchMessage; it would require
			// a custom API call or JSON unmarshaling. Default to Timestamp so we
			// fetch the message's own thread.
			ThreadTimestamp: m.Timestamp,
		}
	}
	return msgs, nil
}

func (a *clientAdapter) GetConversationReplies(params *goslack.GetConversationRepliesParameters) ([]goslack.Message, bool, string, error) {
	return a.client.GetConversationReplies(params)
}

// slackTokenTransformer rewrites Slack's oauth.v2.access response to standard
// OAuth2 format. Slack puts the user access token in authed_user.access_token
// rather than the top-level access_token field that golang.org/x/oauth2 expects.
type slackTokenTransformer struct {
	rt http.RoundTripper
}

func (t *slackTokenTransformer) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.rt.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var slackResp struct {
		OK         bool   `json:"ok"`
		Error      string `json:"error"`
		AuthedUser struct {
			AccessToken string `json:"access_token"`
			TokenType   string `json:"token_type"`
			Scope       string `json:"scope"`
		} `json:"authed_user"`
	}
	if jsonErr := json.Unmarshal(body, &slackResp); jsonErr != nil {
		// Not a Slack JSON response; pass through unchanged.
		resp.Body = io.NopCloser(bytes.NewReader(body))
		return resp, nil
	}

	var rewritten []byte
	if !slackResp.OK {
		rewritten, _ = json.Marshal(map[string]string{"error": slackResp.Error})
	} else {
		rewritten, _ = json.Marshal(map[string]interface{}{
			"access_token": slackResp.AuthedUser.AccessToken,
			"token_type":   slackResp.AuthedUser.TokenType,
			"scope":        slackResp.AuthedUser.Scope,
		})
	}
	resp.Body = io.NopCloser(bytes.NewReader(rewritten))
	resp.ContentLength = int64(len(rewritten))
	return resp, nil
}

// ContextWithExchange returns a context that rewrites Slack's token endpoint
// response to standard OAuth2 format before golang.org/x/oauth2 parses it.
// Pass this context to auth.RunFlow when authenticating with Slack.
func ContextWithExchange(ctx context.Context) context.Context {
	return context.WithValue(ctx, oauth2.HTTPClient, &http.Client{
		Transport: &slackTokenTransformer{rt: http.DefaultTransport},
	})
}

// OAuthConfig returns the OAuth2 config for Slack.
// No client secret — PKCE handles token exchange security.
func OAuthConfig(clientID string) *oauth2.Config {
	return &oauth2.Config{
		ClientID: clientID,
		Scopes:   []string{},
		// AuthStyleInParams sends client_id as a form field rather than HTTP Basic Auth.
		// Required to prevent oauth2's auth-style auto-detection from probing Slack's
		// token endpoint twice, which consumes the one-time authorization code.
		Endpoint: oauth2.Endpoint{
			AuthURL:   "https://slack.com/oauth/v2/authorize",
			TokenURL:  "https://slack.com/api/oauth.v2.access",
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}
}

// UserScopes are the Slack user token scopes required by this source.
const UserScopes = "search:read,channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history"

// Source implements source.Source for Slack.
type Source struct {
	api SlackAPI
}

// New creates a Slack Source using the token from the store.
// Returns an error if not authenticated.
func New(store *auth.Store) (*Source, error) {
	token, ok := store.GetToken("slack")
	if !ok {
		return nil, fmt.Errorf("slack not authenticated: run 'whoneedsme auth slack'")
	}
	client := goslack.New(token.AccessToken)
	return &Source{api: &clientAdapter{client: client}}, nil
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
	msgs, err := s.api.SearchMessages(query, goslack.SearchParameters{Count: 100})
	if err != nil {
		return nil, fmt.Errorf("slack search: %w", err)
	}

	var items []source.Item
	for _, msg := range msgs {
		threadTS := msg.ThreadTimestamp
		if threadTS == "" {
			threadTS = msg.Timestamp
		}
		replied, err := s.userRepliedAfter(msg.ChannelID, threadTS, msg.Timestamp, me.UserID)
		if err != nil {
			// Skip messages we can't fetch thread for.
			continue
		}
		if !replied {
			items = append(items, source.Item{
				Source:  "slack",
				Title:   "#" + msg.ChannelName,
				Summary: truncate(msg.Text, 80),
				URL:     msg.Permalink,
			})
		}
	}
	return items, nil
}

// userRepliedAfter returns true if the user has a message in the thread with
// timestamp > mentionTS. It paginates through all replies.
func (s *Source) userRepliedAfter(channelID, threadTS, mentionTS, userID string) (bool, error) {
	cursor := ""
	for {
		params := &goslack.GetConversationRepliesParameters{
			ChannelID: channelID,
			Timestamp: threadTS,
		}
		if cursor != "" {
			params.Cursor = cursor
		}
		replies, hasMore, nextCursor, err := s.api.GetConversationReplies(params)
		if err != nil {
			return false, err
		}
		for _, reply := range replies {
			mentionFloat, err1 := strconv.ParseFloat(mentionTS, 64)
			replyFloat, err2 := strconv.ParseFloat(reply.Timestamp, 64)
			if err1 != nil || err2 != nil {
				continue
			}
			if reply.User == userID && replyFloat > mentionFloat {
				return true, nil
			}
		}
		if !hasMore {
			break
		}
		cursor = nextCursor
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
