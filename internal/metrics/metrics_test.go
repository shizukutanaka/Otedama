// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package metrics

import (
	"bytes"
	"math"
	"strings"
	"sync"
	"testing"
)

// ============================================================================
// Counter
// ============================================================================

func TestCounter_StartsAtZero(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("test_total", "help", nil)
	if v := c.Value(); v != 0 {
		t.Errorf("initial counter = %d, want 0", v)
	}
}

func TestCounter_IncAdds1(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("test_total", "help", nil)
	c.Inc()
	c.Inc()
	c.Inc()
	if v := c.Value(); v != 3 {
		t.Errorf("after 3 Inc: %d, want 3", v)
	}
}

func TestCounter_AddAccumulates(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("test_total", "help", nil)
	c.Add(10)
	c.Add(5)
	if v := c.Value(); v != 15 {
		t.Errorf("after Add(10)+Add(5): %d, want 15", v)
	}
}

func TestCounter_ConcurrentIncIsAtomic(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("test_total", "help", nil)
	const goroutines = 50
	const incsPer = 200
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < incsPer; j++ {
				c.Inc()
			}
		}()
	}
	wg.Wait()
	want := uint64(goroutines * incsPer)
	if v := c.Value(); v != want {
		t.Errorf("concurrent total = %d, want %d", v, want)
	}
}

func TestCounter_DuplicateNameReturnsExisting(t *testing.T) {
	// Registering the same name+labels twice must return the same Counter,
	// not create a duplicate. This enables idempotent metric creation.
	r := NewRegistry()
	c1 := r.NewCounter("test_total", "help", nil)
	c1.Inc()
	c2 := r.NewCounter("test_total", "help", nil)
	if c1 != c2 {
		t.Error("duplicate NewCounter returned different instances")
	}
	if c2.Value() != 1 {
		t.Errorf("second handle sees value %d, want 1", c2.Value())
	}
}

func TestCounter_DifferentLabelsCreatesNewCounter(t *testing.T) {
	r := NewRegistry()
	a := r.NewCounter("requests_total", "help", map[string]string{"status": "ok"})
	b := r.NewCounter("requests_total", "help", map[string]string{"status": "error"})
	if a == b {
		t.Error("different labels should produce different counters")
	}
	a.Inc()
	if b.Value() != 0 {
		t.Errorf("label-B counter incremented by label-A: %d", b.Value())
	}
}

// ============================================================================
// Gauge
// ============================================================================

func TestGauge_SetAndGet(t *testing.T) {
	r := NewRegistry()
	g := r.NewGauge("hashrate_hashes_per_second", "help", nil)
	g.Set(1.5e9)
	if v := g.Value(); v != 1.5e9 {
		t.Errorf("gauge = %v, want 1.5e9", v)
	}
}

func TestGauge_OverwriteReplaces(t *testing.T) {
	r := NewRegistry()
	g := r.NewGauge("temp", "help", nil)
	g.Set(100)
	g.Set(50)
	if v := g.Value(); v != 50 {
		t.Errorf("gauge = %v, want 50 (set overwrites)", v)
	}
}

func TestGauge_ConcurrentReadSafe(t *testing.T) {
	r := NewRegistry()
	g := r.NewGauge("hashrate", "help", nil)
	g.Set(1000)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				_ = g.Value()
			}
		}()
	}
	wg.Wait()
}

// ============================================================================
// Prometheus text exposition format
// ============================================================================

func TestWriteText_IncludesHelpAndTypeLines(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("otedama_shares_total", "Total shares submitted.", nil)
	c.Add(42)

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	// HELP line per the spec.
	if !strings.Contains(out, "# HELP otedama_shares_total Total shares submitted.") {
		t.Errorf("missing HELP line:\n%s", out)
	}
	// TYPE line.
	if !strings.Contains(out, "# TYPE otedama_shares_total counter") {
		t.Errorf("missing TYPE line:\n%s", out)
	}
	// Sample line.
	if !strings.Contains(out, "otedama_shares_total 42") {
		t.Errorf("missing sample line:\n%s", out)
	}
}

func TestWriteText_HelpTextIsEscaped(t *testing.T) {
	// A HELP string containing a newline or backslash must be escaped so it
	// stays on one line; otherwise the embedded newline splits the HELP line
	// and corrupts the scrape (Prometheus text exposition format).
	r := NewRegistry()
	r.NewCounter("otedama_test_total", "line one\nline two \\ end", nil)

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, `# HELP otedama_test_total line one\nline two \\ end`) {
		t.Errorf("HELP text not escaped:\n%s", out)
	}
	// The raw newline must NOT appear inside the HELP text (it would start a
	// spurious second line).
	if strings.Contains(out, "line one\nline two") {
		t.Errorf("HELP text contains a raw newline:\n%s", out)
	}
}

func TestWriteText_GaugeTypeLine(t *testing.T) {
	r := NewRegistry()
	r.NewGauge("otedama_hashrate_hps", "Hashrate in hashes per second.", nil).Set(2.5e6)

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	if !strings.Contains(buf.String(), "# TYPE otedama_hashrate_hps gauge") {
		t.Errorf("gauge TYPE line missing:\n%s", buf.String())
	}
}

func TestWriteText_LabelFormattingConformsToSpec(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("shares_total", "Total shares.", map[string]string{
		"status": "accepted",
		"pool":   "stratum.example",
	})
	c.Add(10)

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	out := buf.String()

	// Labels sorted alphabetically (pool < status).
	if !strings.Contains(out, `shares_total{pool="stratum.example",status="accepted"} 10`) {
		t.Errorf("label formatting wrong:\n%s", out)
	}
}

func TestWriteText_EscapesQuotesInLabels(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("err_total", "Errors.", map[string]string{
		"msg": `he said "hi"`,
	})
	c.Inc()

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	out := buf.String()

	// Quotes must be backslash-escaped per the spec.
	if !strings.Contains(out, `msg="he said \"hi\""`) {
		t.Errorf("quote escape wrong:\n%s", out)
	}
}

func TestWriteText_EscapesBackslashesAndNewlines(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("err_total", "Errors.", map[string]string{
		"path": "a\\b",
		"line": "first\nsecond",
	})
	c.Inc()

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	out := buf.String()

	if !strings.Contains(out, `path="a\\b"`) {
		t.Errorf("backslash escape wrong:\n%s", out)
	}
	if !strings.Contains(out, `line="first\nsecond"`) {
		t.Errorf("newline escape wrong:\n%s", out)
	}
}

func TestWriteText_OrderingIsDeterministic(t *testing.T) {
	// Multiple runs must produce identical output for identical state.
	r := NewRegistry()
	r.NewCounter("a", "a help", nil).Inc()
	r.NewCounter("b", "b help", nil).Inc()
	r.NewCounter("c", "c help", map[string]string{"x": "1"}).Inc()
	r.NewCounter("c", "c help", map[string]string{"x": "2"}).Inc()

	var out1, out2 bytes.Buffer
	_ = r.WriteText(&out1)
	_ = r.WriteText(&out2)

	if out1.String() != out2.String() {
		t.Errorf("non-deterministic output:\n--- first ---\n%s\n--- second ---\n%s",
			out1.String(), out2.String())
	}
}

func TestWriteText_EmptyRegistry(t *testing.T) {
	r := NewRegistry()
	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("empty registry WriteText: %v", err)
	}
	if buf.Len() != 0 {
		t.Errorf("empty registry produced output: %q", buf.String())
	}
}

// ============================================================================
// Special float values
// ============================================================================

func TestWriteText_NaNGauge(t *testing.T) {
	r := NewRegistry()
	r.NewGauge("weird", "help", nil).Set(math.NaN())

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	if !strings.Contains(buf.String(), "NaN") {
		t.Errorf("NaN gauge should render as 'NaN':\n%s", buf.String())
	}
}

func TestWriteText_InfinityGauge(t *testing.T) {
	r := NewRegistry()
	r.NewGauge("big", "help", nil).Set(math.Inf(1))

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	if !strings.Contains(buf.String(), "+Inf") {
		t.Errorf("+Inf gauge should render as '+Inf':\n%s", buf.String())
	}
}

func TestWriteText_NegativeInfinityGauge(t *testing.T) {
	r := NewRegistry()
	r.NewGauge("neg", "help", nil).Set(math.Inf(-1))

	var buf bytes.Buffer
	_ = r.WriteText(&buf)
	if !strings.Contains(buf.String(), "-Inf") {
		t.Errorf("-Inf gauge should render as '-Inf':\n%s", buf.String())
	}
}

// ============================================================================
// Metric-name validation
// ============================================================================

func TestNewCounter_InvalidNamePanics(t *testing.T) {
	// Invalid names must panic immediately so the developer error surfaces
	// in tests rather than silently corrupting the Prometheus scrape.
	invalid := []string{"", "0starts_with_digit", "has-hyphen", "has space", "-leading-dash"}
	for _, name := range invalid {
		name := name
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("NewCounter(%q) did not panic on invalid name", name)
				}
			}()
			r := NewRegistry()
			r.NewCounter(name, "help", nil)
		})
	}
}

func TestNewGauge_InvalidNamePanics(t *testing.T) {
	invalid := []string{"", "0starts_with_digit", "has-hyphen"}
	for _, name := range invalid {
		name := name
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("NewGauge(%q) did not panic on invalid name", name)
				}
			}()
			r := NewRegistry()
			r.NewGauge(name, "help", nil)
		})
	}
}

func TestIsValidMetricName_ValidNames(t *testing.T) {
	valid := []string{
		"a", "_", ":", "otedama_hashrate_hashes_per_second",
		"requests_total", "http_requests:latency", "A1",
	}
	for _, name := range valid {
		if !isValidMetricName(name) {
			t.Errorf("isValidMetricName(%q) = false, want true", name)
		}
	}
}

func TestIsValidMetricName_InvalidNames(t *testing.T) {
	invalid := []string{
		"", "0digit", "has-hyphen", "has space", "has.dot",
	}
	for _, name := range invalid {
		if isValidMetricName(name) {
			t.Errorf("isValidMetricName(%q) = true, want false", name)
		}
	}
}

// ============================================================================
// Realistic Otedama metric scenario
// ============================================================================

func TestFullScenario_MiningMetrics(t *testing.T) {
	r := NewRegistry()

	hashrate := r.NewGauge(
		"otedama_hashrate_hashes_per_second",
		"Current hashrate in hashes per second.",
		map[string]string{"device": "cpu-0"},
	)
	sharesAccepted := r.NewCounter(
		"otedama_shares_total",
		"Total shares submitted to pool.",
		map[string]string{"status": "accepted"},
	)
	sharesRejected := r.NewCounter(
		"otedama_shares_total",
		"Total shares submitted to pool.",
		map[string]string{"status": "rejected"},
	)

	hashrate.Set(2.5e6)
	for i := 0; i < 42; i++ {
		sharesAccepted.Inc()
	}
	sharesRejected.Inc()

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	// Expected output structure.
	want := []string{
		`otedama_hashrate_hashes_per_second{device="cpu-0"} 2.5e+06`,
		`otedama_shares_total{status="accepted"} 42`,
		`otedama_shares_total{status="rejected"} 1`,
	}
	for _, w := range want {
		if !strings.Contains(out, w) {
			t.Errorf("output missing %q:\n%s", w, out)
		}
	}
}
