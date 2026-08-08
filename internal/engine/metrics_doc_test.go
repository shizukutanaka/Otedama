// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestMetricsDocumentedInSpecification guards against SPECIFICATION §6 metric-
// catalogue drift: every otedama_* metric the engine registers must be documented
// in docs/SPECIFICATION.md §6. Gap G17 in that spec was exactly this drift — 22
// metrics were live at /metrics but undocumented, so an operator could not discover
// them — and it was caught only by a manual audit (session 190) with no guard to
// stop a recurrence. This test makes the invariant enforceable in CI: add a metric
// without documenting it and the build fails.
//
// It scans metrics.go for the metric-name string literals (the first argument to
// every NewGauge/NewCounter is a compile-time "otedama_…" constant) rather than
// instantiating the registry, so it also covers the lazily-created (†) series that
// only appear at /metrics after a runtime event and would be absent from a
// freshly-built registry.
func TestMetricsDocumentedInSpecification(t *testing.T) {
	src, err := os.ReadFile("metrics.go")
	if err != nil {
		t.Fatalf("read metrics.go: %v", err)
	}
	spec, err := os.ReadFile("../../docs/SPECIFICATION.md")
	if err != nil {
		t.Fatalf("read SPECIFICATION.md: %v", err)
	}
	specText := string(spec)

	nameRe := regexp.MustCompile(`"(otedama_[a-z_]+)"`)
	matches := nameRe.FindAllStringSubmatch(string(src), -1)
	if len(matches) == 0 {
		t.Fatal("no otedama_* metric literals found in metrics.go — source layout changed; update this guard")
	}

	seen := make(map[string]bool)
	for _, m := range matches {
		name := m[1]
		if seen[name] {
			continue
		}
		seen[name] = true

		// The §6 catalogue omits the otedama_ prefix and renders each metric as
		// `name` or `name{labels}` in a table cell. Anchoring on the opening
		// backtick and requiring the closing backtick or a `{` makes the marker
		// precise: it resists incidental prose mentions and, crucially, prevents
		// a false pass where a shorter name (`up`) is matched inside a longer
		// documented one (`uptime_seconds`).
		bare := strings.TrimPrefix(name, "otedama_")
		if !strings.Contains(specText, "`"+bare+"`") && !strings.Contains(specText, "`"+bare+"{") {
			t.Errorf("metric %q is registered in metrics.go but not documented in docs/SPECIFICATION.md §6 (expected a `%s` catalogue entry)", name, bare)
		}
	}
}
