.PHONY: build test

build:
	go build -ldflags="\
	  -X github.com/joe/whoneedsme/auth/embedded.SlackClientID=$(SLACK_CLIENT_ID) \
	  -X github.com/joe/whoneedsme/auth/embedded.JiraClientID=$(JIRA_CLIENT_ID)" \
	  -o whoneedsme .

test:
	go test ./...
