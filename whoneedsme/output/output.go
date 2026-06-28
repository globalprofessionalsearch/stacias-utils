package output

import (
	"fmt"
	"io"
	"strings"

	"github.com/joe/whoneedsme/source"
)

const divider = "──────────────────────────────────────"

// Render prints items grouped by source to w.
// Errors are printed as warnings; sources with no items are skipped.
func Render(w io.Writer, results map[string][]source.Item, errors map[string]error) {
	for src, err := range errors {
		fmt.Fprintf(w, "%s — error: %s\n\n", strings.ToUpper(src), err.Error())
	}

	total := 0
	for src, items := range results {
		if len(items) == 0 {
			continue
		}
		total += len(items)
		fmt.Fprintf(w, "%s (%d %s)\n", strings.ToUpper(src), len(items), pluralItem(len(items)))
		fmt.Fprintln(w, divider)
		for _, item := range items {
			fmt.Fprintf(w, "• %s — %s\n  %s\n\n", item.Title, item.Summary, item.URL)
		}
	}

	if total == 0 && len(errors) == 0 {
		fmt.Fprintln(w, "All clear.")
		return
	}
	if total > 0 {
		fmt.Fprintln(w, divider)
		fmt.Fprintf(w, "%d %s your attention.\n", total, pluralVerb(total))
	}
}

func pluralItem(n int) string {
	if n == 1 {
		return "item"
	}
	return "items"
}

func pluralVerb(n int) string {
	if n == 1 {
		return "item needs"
	}
	return "items need"
}
