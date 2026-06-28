package embedded

// SlackClientID is the Slack OAuth app client ID.
// Set at build time: go build -ldflags="-X github.com/joe/whoneedsme/auth/embedded.SlackClientID=xxx"
var SlackClientID = ""

// JiraClientID is the Atlassian OAuth app client ID.
// Set at build time: go build -ldflags="-X github.com/joe/whoneedsme/auth/embedded.JiraClientID=xxx"
var JiraClientID = ""
