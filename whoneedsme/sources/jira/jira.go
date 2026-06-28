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
	"github.com/joe/whoneedsme/auth/embedded"
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

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("accessible resources request failed: HTTP %d", resp.StatusCode)
	}

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
	user, _, err := r.client.User.GetCurrentUser(ctx)
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

// New creates a JIRA Source using the token from the store.
func New(store *auth.Store) (*Source, error) {
	token, ok := store.GetToken("jira")
	if !ok {
		return nil, fmt.Errorf("jira not authenticated: run 'whoneedsme auth jira'")
	}
	cfg, ok := store.GetSourceConfig("jira")
	if !ok || cfg.CloudID == "" {
		return nil, fmt.Errorf("jira cloud ID missing: run 'whoneedsme auth jira'")
	}

	oauthConf := OAuthConfig(embedded.JiraClientID, "")
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
		if c == nil || c.Author == nil || c.Author.AccountID == accountID {
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
		if c == nil || c.Author == nil || c.Author.AccountID != accountID {
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
