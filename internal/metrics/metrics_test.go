// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package metrics

import (
	"bytes"
	"fmt"
	"io"
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

func TestGauge_DuplicateNameReturnsExisting(t *testing.T) {
	// Registering the same name+labels twice must return the same Gauge,
	// not create a duplicate. This enables idempotent metric creation.
	r := NewRegistry()
	g1 := r.NewGauge("cpu_temp_celsius", "help", nil)
	g1.Set(72.5)
	g2 := r.NewGauge("cpu_temp_celsius", "help", nil)
	if g1 != g2 {
		t.Error("duplicate NewGauge returned different instances")
	}
	if g2.Value() != 72.5 {
		t.Errorf("second handle sees value %v, want 72.5", g2.Value())
	}
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

func TestNewGauge_NameAlreadyCounterPanics(t *testing.T) {
	// A name registered as a counter cannot also be a gauge: Prometheus permits
	// one TYPE per name, and emitting both corrupts the whole scrape. The
	// collision must panic at registration, not silently corrupt /metrics.
	defer func() {
		if r := recover(); r == nil {
			t.Error("NewGauge did not panic for a name already registered as a counter")
		}
	}()
	r := NewRegistry()
	r.NewCounter("otedama_x", "a counter", nil)
	r.NewGauge("otedama_x", "a gauge", nil) // must panic
}

func TestNewCounter_NameAlreadyGaugePanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("NewCounter did not panic for a name already registered as a gauge")
		}
	}()
	r := NewRegistry()
	r.NewGauge("otedama_y", "a gauge", nil)
	r.NewCounter("otedama_y", "a counter", nil) // must panic
}

func TestCrossType_DetectedAcrossDifferentLabelSets(t *testing.T) {
	// The guard compares the bare metric name, so it fires even when the
	// counter and gauge would carry different label sets (the registry keys
	// differ, but the Prometheus TYPE conflict is by name).
	defer func() {
		if r := recover(); r == nil {
			t.Error("cross-type collision with differing labels was not detected")
		}
	}()
	r := NewRegistry()
	r.NewCounter("otedama_z", "c", map[string]string{"a": "1"})
	r.NewGauge("otedama_z", "g", map[string]string{"b": "2"}) // must panic
}

func TestNewCounter_InvalidLabelNamePanics(t *testing.T) {
	// An invalid label name must panic at registration: a single malformed
	// label name emits a line Prometheus rejects on scrape, discarding the
	// entire /metrics response, so the failure must surface in tests.
	invalid := []string{"has-hyphen", "has space", "0leadingdigit", "", "has:colon", "has.dot"}
	for _, label := range invalid {
		t.Run(label, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("NewCounter with label %q did not panic", label)
				}
			}()
			r := NewRegistry()
			r.NewCounter("valid_name_total", "help", map[string]string{label: "v"})
		})
	}
}

func TestNewGauge_InvalidLabelNamePanics(t *testing.T) {
	invalid := []string{"has-hyphen", "0leadingdigit", "has:colon"}
	for _, label := range invalid {
		t.Run(label, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("NewGauge with label %q did not panic", label)
				}
			}()
			r := NewRegistry()
			r.NewGauge("valid_name", "help", map[string]string{label: "v"})
		})
	}
}

func TestNewGauge_ValidLabelNameDoesNotPanic(t *testing.T) {
	// Every label name currently used in Otedama must pass: status, quantile,
	// reason, device, address, version, commit, goversion.
	valid := []string{"status", "quantile", "reason", "device", "address", "version", "commit", "goversion", "_underscore", "A1"}
	r := NewRegistry()
	for _, label := range valid {
		// A panic here fails the test.
		r.NewGauge("valid_name", "help", map[string]string{label: "v"})
	}
}

func TestIsValidLabelName(t *testing.T) {
	valid := []string{"status", "_", "a1", "A_B_2"}
	for _, name := range valid {
		if !isValidLabelName(name) {
			t.Errorf("isValidLabelName(%q) = false, want true", name)
		}
	}
	// Note: a colon is valid in a metric name but NOT in a label name.
	invalid := []string{"", "0digit", "has-hyphen", "has space", "has.dot", "has:colon"}
	for _, name := range invalid {
		if isValidLabelName(name) {
			t.Errorf("isValidLabelName(%q) = true, want false", name)
		}
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
// CollectFunc / RegisterCollector
// ============================================================================

func TestRegisterCollector_OutputAppearsInWriteText(t *testing.T) {
	r := NewRegistry()
	r.RegisterCollector(func(w io.Writer) error {
		_, err := fmt.Fprint(w, "# HELP custom_metric A custom metric.\n# TYPE custom_metric gauge\ncustom_metric 99\n")
		return err
	})

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "custom_metric 99") {
		t.Errorf("collector output missing from WriteText:\n%s", out)
	}
}

func TestRegisterCollector_MultipleCollectorsAllAppear(t *testing.T) {
	r := NewRegistry()
	for i, name := range []string{"metric_a", "metric_b", "metric_c"} {
		r.RegisterCollector(func(w io.Writer) error {
			_, err := fmt.Fprintf(w, "# HELP %s help.\n# TYPE %s gauge\n%s %d\n", name, name, name, i+1)
			return err
		})
	}

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"metric_a 1", "metric_b 2", "metric_c 3"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in output:\n%s", want, out)
		}
	}
}

func TestRegisterCollector_ErrorPropagates(t *testing.T) {
	r := NewRegistry()
	sentinel := fmt.Errorf("injected write error")
	r.RegisterCollector(func(_ io.Writer) error { return sentinel })

	var buf bytes.Buffer
	err := r.WriteText(&buf)
	if err == nil {
		t.Fatal("expected error from collector, got nil")
	}
	if err != sentinel {
		t.Errorf("error = %v, want %v", err, sentinel)
	}
}

func TestRegisterCollector_CollectorAfterStaticMetrics(t *testing.T) {
	// Collectors are emitted AFTER the static counter/gauge section.
	r := NewRegistry()
	r.NewCounter("alpha_total", "static", nil).Inc()
	r.RegisterCollector(func(w io.Writer) error {
		_, err := fmt.Fprint(w, "# HELP zzz_dynamic dynamic.\n# TYPE zzz_dynamic gauge\nzzz_dynamic 7\n")
		return err
	})

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	idxStatic := strings.Index(out, "alpha_total")
	idxDynamic := strings.Index(out, "zzz_dynamic")
	if idxStatic == -1 || idxDynamic == -1 {
		t.Fatalf("expected both metrics in output:\n%s", out)
	}
	if idxDynamic < idxStatic {
		t.Errorf("collector output appeared before static metric (idxDynamic=%d < idxStatic=%d):\n%s",
			idxDynamic, idxStatic, out)
	}
}

// errWriter is a failing io.Writer used to test WriteText error propagation.
type errWriter struct{}

func (errWriter) Write(_ []byte) (int, error) { return 0, io.ErrClosedPipe }

// countingErrWriter succeeds for the first failAfter writes then returns an
// error. It lets tests target specific write-error branches inside WriteText
// (the TYPE line at write #2, the sample line at write #3) that the always-
// failing errWriter never reaches because it aborts on write #1 (HELP line).
type countingErrWriter struct {
	failAfter int
	n         int
}

func (w *countingErrWriter) Write(p []byte) (int, error) {
	if w.n >= w.failAfter {
		return 0, io.ErrClosedPipe
	}
	w.n++
	return len(p), nil
}

func TestWriteText_PropagatesTypeLineWriteError(t *testing.T) {
	// Fail after the first write (# HELP succeeds, # TYPE fails).
	// This covers the TYPE-line error return inside the !seen[name] block.
	r := NewRegistry()
	r.NewCounter("otedama_test_total", "help", nil).Inc()
	if err := r.WriteText(&countingErrWriter{failAfter: 1}); err == nil {
		t.Error("WriteText: expected error when TYPE line write fails, got nil")
	}
}

func TestWriteText_PropagatesSampleLineWriteError(t *testing.T) {
	// Fail after two writes (# HELP and # TYPE succeed, sample line fails).
	// This covers the sample-line error return after the !seen[name] block.
	r := NewRegistry()
	r.NewCounter("otedama_test_total", "help", nil).Inc()
	if err := r.WriteText(&countingErrWriter{failAfter: 2}); err == nil {
		t.Error("WriteText: expected error when sample line write fails, got nil")
	}
}

func TestWriteText_PropagatesWriterError(t *testing.T) {
	// WriteText must propagate the first io.Writer error it encounters.
	// A counter is registered so there is at least one # HELP line to write.
	r := NewRegistry()
	r.NewCounter("otedama_test_total", "help", nil).Inc()
	if err := r.WriteText(errWriter{}); err == nil {
		t.Error("WriteText: expected error when writer fails, got nil")
	}
}

func TestWriteText_CollectorErrorPropagates(t *testing.T) {
	// When a registered CollectFunc returns an error, WriteText must
	// propagate it instead of swallowing it.
	r := NewRegistry()
	r.RegisterCollector(func(w io.Writer) error {
		return fmt.Errorf("collector failed")
	})
	if err := r.WriteText(&bytes.Buffer{}); err == nil {
		t.Error("WriteText: expected error from failing collector, got nil")
	}
}

// ============================================================================
// RuntimeCollector
// ============================================================================

func TestRuntimeCollector_ContainsRequiredMetrics(t *testing.T) {
	r := NewRegistry()
	r.RegisterCollector(RuntimeCollector())

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	required := []string{
		"go_goroutines",
		"go_info",
		"go_memstats_alloc_bytes",
		"go_memstats_sys_bytes",
		"go_memstats_heap_alloc_bytes",
		"go_memstats_heap_sys_bytes",
		"go_memstats_heap_inuse_bytes",
		"go_memstats_heap_idle_bytes",
		"go_memstats_stack_inuse_bytes",
		"go_memstats_gc_cpu_fraction",
		"go_gc_duration_seconds_total",
		"go_gc_cycles_total",
	}
	for _, name := range required {
		if !strings.Contains(out, name) {
			t.Errorf("missing metric %q in runtime output:\n%s", name, out)
		}
	}
}

func TestRuntimeCollector_GoInfoHasVersionLabel(t *testing.T) {
	r := NewRegistry()
	r.RegisterCollector(RuntimeCollector())

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, `go_info{version="`) {
		t.Errorf("go_info missing version label in output:\n%s", out)
	}
	// go_info value must be 1.
	if !strings.Contains(out, "} 1") {
		t.Errorf("go_info value must be 1:\n%s", out)
	}
}

func TestRuntimeCollector_GoroutineCountIsPositive(t *testing.T) {
	r := NewRegistry()
	r.RegisterCollector(RuntimeCollector())

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	// The running goroutine count must be at least 1 (this test goroutine).
	if strings.Contains(out, "go_goroutines 0") {
		t.Errorf("go_goroutines should be > 0:\n%s", out)
	}
}

func TestRuntimeCollector_HelpAndTypeLines(t *testing.T) {
	r := NewRegistry()
	r.RegisterCollector(RuntimeCollector())

	var buf bytes.Buffer
	if err := r.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()

	checks := []struct{ line string }{
		{"# TYPE go_goroutines gauge"},
		{"# TYPE go_info gauge"},
		{"# TYPE go_memstats_alloc_bytes gauge"},
		{"# TYPE go_gc_duration_seconds_total counter"},
		{"# TYPE go_gc_cycles_total counter"},
	}
	for _, c := range checks {
		if !strings.Contains(out, c.line) {
			t.Errorf("expected %q in output:\n%s", c.line, out)
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

func TestFormatFloat_SpecialAndFiniteValues(t *testing.T) {
	tests := []struct {
		name string
		in   float64
		want string
	}{
		{"zero", 0, "0"},
		{"small int", 42, "42"},
		{"negative", -3.5, "-3.5"},
		{"NaN", math.NaN(), "NaN"},
		{"positive inf", math.Inf(1), "+Inf"},
		{"negative inf", math.Inf(-1), "-Inf"},
		// Regression: a large *finite* value must NOT be rendered as +Inf.
		// 1.5e308 is finite (< MaxFloat64 ~1.7976931348623157e308) but exceeds
		// the old `v > 1e308` threshold that misclassified it as infinity.
		{"large finite is not +Inf", 1.5e308, "1.5e+308"},
		{"max finite is not +Inf", math.MaxFloat64, "1.7976931348623157e+308"},
		{"large negative finite is not -Inf", -1.5e308, "-1.5e+308"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatFloat(tt.in); got != tt.want {
				t.Errorf("formatFloat(%g) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestRuntimeCollector_PropagatesWriterError(t *testing.T) {
	// RuntimeCollector must propagate the first io.Writer error it encounters.
	fn := RuntimeCollector()
	if err := fn(errWriter{}); err == nil {
		t.Error("RuntimeCollector: expected error when writer fails, got nil")
	}
}
