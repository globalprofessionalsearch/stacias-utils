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
