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
	messages []slacksource.SearchMessage
	threads  map[string][]goslack.Message // key: "channelID:threadTS"
}

func (m *mockSlackAPI) AuthTest() (*goslack.AuthTestResponse, error) {
	return &goslack.AuthTestResponse{UserID: m.userID}, nil
}

func (m *mockSlackAPI) SearchMessages(query string, params goslack.SearchParameters) ([]slacksource.SearchMessage, error) {
	return m.messages, nil
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
		messages: []slacksource.SearchMessage{
			{
				ChannelID:       "C456",
				ChannelName:     "engineering",
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
		messages: []slacksource.SearchMessage{
			{
				ChannelID:       "C456",
				ChannelName:     "engineering",
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
		messages: []slacksource.SearchMessage{
			{
				ChannelID:       "C456",
				ChannelName:     "general",
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
