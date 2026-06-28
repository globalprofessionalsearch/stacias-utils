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
