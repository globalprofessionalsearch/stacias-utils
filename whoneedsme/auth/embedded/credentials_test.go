package embedded_test

import (
	"testing"

	"github.com/joe/whoneedsme/auth/embedded"
	"github.com/stretchr/testify/assert"
)

func TestCredentials_DefaultsAreEmpty(t *testing.T) {
	// In tests (no ldflags), all IDs default to empty string.
	assert.Equal(t, "", embedded.SlackClientID)
	assert.Equal(t, "", embedded.JiraClientID)
}
