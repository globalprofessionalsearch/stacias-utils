// cmd/root.go
package cmd

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/joe/whoneedsme/auth"
	"github.com/joe/whoneedsme/output"
	"github.com/joe/whoneedsme/source"
	jirasource "github.com/joe/whoneedsme/sources/jira"
	slacksource "github.com/joe/whoneedsme/sources/slack"
	"github.com/spf13/cobra"
)

var sourceFilter string

var rootCmd = &cobra.Command{
	Use:   "whoneedsme",
	Short: "Check if your attention is needed anywhere",
	RunE:  runCheck,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&sourceFilter, "source", "", "Run only this source (slack, jira)")
}

// Execute is the entry point called from main.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runCheck(cmd *cobra.Command, args []string) error {
	store, err := auth.NewStore()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	sources, warnings := buildSources(store)

	if sourceFilter != "" {
		knownSources := map[string]bool{"slack": true, "jira": true}
		if !knownSources[sourceFilter] {
			return fmt.Errorf("unknown source %q. Valid sources: slack, jira", sourceFilter)
		}
		filtered := filterSources(sources, sourceFilter)
		if len(filtered) == 0 {
			// Source is known but not authenticated — print only its warning.
			if msg, ok := warnings[sourceFilter]; ok {
				fmt.Fprintln(os.Stderr, msg)
			}
			return nil
		}
		sources = filtered
		warnings = nil // suppress warnings for other sources when filtering
	}

	for _, msg := range warnings {
		fmt.Fprintln(os.Stderr, msg)
	}

	if len(sources) == 0 {
		return nil
	}

	results := make(map[string][]source.Item)
	errors := make(map[string]error)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, src := range sources {
		wg.Add(1)
		go func(s source.Source) {
			defer wg.Done()
			timeout := 30 * time.Second
			if cfg, ok := store.GetSourceConfig(s.Name()); ok && cfg.TimeoutSeconds > 0 {
				timeout = time.Duration(cfg.TimeoutSeconds) * time.Second
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()

			items, err := s.Check(ctx)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errors[s.Name()] = err
			} else {
				results[s.Name()] = items
			}
		}(src)
	}

	wg.Wait()
	output.Render(os.Stdout, results, errors)
	return nil
}

func buildSources(store *auth.Store) ([]source.Source, map[string]string) {
	var sources []source.Source
	warnings := map[string]string{}

	if s, err := slacksource.New(store); err == nil {
		sources = append(sources, s)
	} else {
		warnings["slack"] = "SLACK — not authenticated. Run 'whoneedsme auth slack' to authenticate."
	}

	if s, err := jirasource.New(store); err == nil {
		sources = append(sources, s)
	} else {
		warnings["jira"] = "JIRA — not authenticated. Run 'whoneedsme auth jira' to authenticate."
	}

	return sources, warnings
}

func filterSources(sources []source.Source, name string) []source.Source {
	for _, s := range sources {
		if s.Name() == name {
			return []source.Source{s}
		}
	}
	return nil
}
