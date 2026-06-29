package source

import "context"

// Item is a single thing that needs the user's attention.
type Item struct {
	Source  string
	Title   string
	URL     string
	Summary string
}

// Source checks one external service and returns items needing attention.
type Source interface {
	Name() string
	Check(ctx context.Context) ([]Item, error)
}
