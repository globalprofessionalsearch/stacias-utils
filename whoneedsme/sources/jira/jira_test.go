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
		Author:  &gojira.User{AccountID: accountID},
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
