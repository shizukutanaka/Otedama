// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package metrics exposes Otedama's runtime metrics in a format
// compatible with Prometheus scrape endpoints.
//
// # Why not import prometheus/client_golang?
//
// The official Go client library is excellent but adds ~10MB to the
// binary and a transitive dependency on dozens of packages. For the
// metrics Otedama needs — counters and gauges — the Prometheus text
// exposition format is a few hundred lines of straightforward code.
// (Latency distributions are reported as gauge quantiles rather than a
// native histogram type, which keeps the registry minimal.) Going
// dependency-free keeps supply-chain risk minimal and the binary small.
//
// # Exposition format
//
// Output conforms to https://prometheus.io/docs/instrumenting/exposition_formats/
//
//	# HELP otedama_hashrate_hashes_per_second Current hashrate.
//	# TYPE otedama_hashrate_hashes_per_second gauge
//	otedama_hashrate_hashes_per_second{device="cpu-0"} 10500000
//	# HELP otedama_shares_total Total shares submitted to pool.
//	# TYPE otedama_shares_total counter
//	otedama_shares_total{status="accepted"} 42
//	otedama_shares_total{status="rejected"} 1
package metrics

import (
	"fmt"
	"io"
	"maps"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// CollectFunc is a function invoked during WriteText to emit dynamic metrics.
// It writes lines in Prometheus text exposition format directly to w.
// Useful for metrics whose values change between scrapes and are most
// efficiently gathered in one call (e.g. runtime.ReadMemStats).
type CollectFunc func(w io.Writer) error

// Registry holds all registered metrics.
// Safe for concurrent use.
type Registry struct {
	mu         sync.RWMutex
	counters   map[string]*Counter
	gauges     map[string]*Gauge
	collectors []CollectFunc
}

// NewRegistry returns an empty metrics registry.
func NewRegistry() *Registry {
	return &Registry{
		counters: make(map[string]*Counter),
		gauges:   make(map[string]*Gauge),
	}
}

// RegisterCollector adds fn to the registry. WriteText calls all registered
// collectors (in registration order) after writing the static counters and
// gauges. fn must write valid Prometheus text lines and may not call any
// Registry method (deadlock). Safe to call concurrently.
func (r *Registry) RegisterCollector(fn CollectFunc) {
	r.mu.Lock()
	r.collectors = append(r.collectors, fn)
	r.mu.Unlock()
}

// Counter is a monotonically increasing value (e.g. total shares submitted).
type Counter struct {
	name   string
	help   string
	labels map[string]string
	value  atomic.Uint64
}

// Gauge is an instantaneous value (e.g. current hashrate).
type Gauge struct {
	name   string
	help   string
	labels map[string]string

	mu    sync.RWMutex
	value float64
}

// isValidMetricName reports whether name conforms to the Prometheus metric
// naming rule: [a-zA-Z_:][a-zA-Z0-9_:]* — no hyphens, no leading digits.
// Every name in Otedama is a compile-time constant, so an invalid name is a
// developer error that surfaces immediately in tests.
func isValidMetricName(name string) bool {
	if len(name) == 0 {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r == '_' || r == ':':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// isValidLabelName reports whether name conforms to the Prometheus label
// naming rule: [a-zA-Z_][a-zA-Z0-9_]* — note this is stricter than a metric
// name (no colon is permitted in a label name). Like metric names, every label
// name in Otedama is a compile-time constant, so an invalid one is a developer
// error. Validating it at registration matters because a single malformed label
// name emits a line Prometheus rejects on scrape, which discards the *entire*
// /metrics response — so one bad label would silently break all metrics, not
// just its own series.
func isValidLabelName(name string) bool {
	if len(name) == 0 {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r == '_':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// validateLabelNames panics if any key in labels is not a valid Prometheus
// label name. metricName is included in the panic message to locate the
// offending registration.
func validateLabelNames(metricName string, labels map[string]string) {
	for k := range labels {
		if !isValidLabelName(k) {
			panic(fmt.Sprintf("metrics: invalid label name %q on metric %q (must match [a-zA-Z_][a-zA-Z0-9_]*)", k, metricName))
		}
	}
}

// ----- Counter API -----

// NewCounter registers a new Counter. Duplicate name+labels returns the existing one.
// Panics if name does not satisfy [a-zA-Z_:][a-zA-Z0-9_:]*.
func (r *Registry) NewCounter(name, help string, labels map[string]string) *Counter {
	if !isValidMetricName(name) {
		panic(fmt.Sprintf("metrics: invalid metric name %q (must match [a-zA-Z_:][a-zA-Z0-9_:]*)", name))
	}
	validateLabelNames(name, labels)
	key := metricKey(name, labels)
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.counters[key]; ok {
		return existing
	}
	c := &Counter{name: name, help: help, labels: cloneLabels(labels)}
	r.counters[key] = c
	return c
}

// Inc increments the counter by 1.
func (c *Counter) Inc() { c.value.Add(1) }

// Add adds delta to the counter.
func (c *Counter) Add(delta uint64) { c.value.Add(delta) }

// Value returns the current counter value.
func (c *Counter) Value() uint64 { return c.value.Load() }

// ----- Gauge API -----

// NewGauge registers a new Gauge.
// Panics if name does not satisfy [a-zA-Z_:][a-zA-Z0-9_:]*.
func (r *Registry) NewGauge(name, help string, labels map[string]string) *Gauge {
	if !isValidMetricName(name) {
		panic(fmt.Sprintf("metrics: invalid metric name %q (must match [a-zA-Z_:][a-zA-Z0-9_:]*)", name))
	}
	validateLabelNames(name, labels)
	key := metricKey(name, labels)
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.gauges[key]; ok {
		return existing
	}
	g := &Gauge{name: name, help: help, labels: cloneLabels(labels)}
	r.gauges[key] = g
	return g
}

// Set sets the gauge to the given value.
func (g *Gauge) Set(v float64) {
	g.mu.Lock()
	g.value = v
	g.mu.Unlock()
}

// Value returns the current gauge value.
func (g *Gauge) Value() float64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.value
}

// ----- Exposition -----

// WriteText writes the Prometheus text exposition format to w.
// Static counters and gauges are written first (sorted by name for stable
// diffing), then all registered CollectFuncs are called in registration order.
func (r *Registry) WriteText(w io.Writer) error {
	r.mu.RLock()
	// Collect and sort.
	type entry struct {
		name, help, kind string
		labels           map[string]string
		text             string
	}
	var entries []entry

	for _, c := range r.counters {
		entries = append(entries, entry{
			name: c.name, help: c.help, kind: "counter",
			labels: c.labels,
			text:   fmt.Sprintf("%d", c.Value()),
		})
	}
	for _, g := range r.gauges {
		entries = append(entries, entry{
			name: g.name, help: g.help, kind: "gauge",
			labels: g.labels,
			text:   formatFloat(g.Value()),
		})
	}
	// Snapshot collector list while the lock is held.
	fns := make([]CollectFunc, len(r.collectors))
	copy(fns, r.collectors)
	r.mu.RUnlock()

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].name != entries[j].name {
			return entries[i].name < entries[j].name
		}
		return metricKey(entries[i].name, entries[i].labels) <
			metricKey(entries[j].name, entries[j].labels)
	})

	// Emit one # HELP + # TYPE block per metric name, then all series.
	seen := make(map[string]bool)
	for _, e := range entries {
		if !seen[e.name] {
			seen[e.name] = true
			if _, err := fmt.Fprintf(w, "# HELP %s %s\n", e.name, escapeHelp(e.help)); err != nil {
				return err
			}
			if _, err := fmt.Fprintf(w, "# TYPE %s %s\n", e.name, e.kind); err != nil {
				return err
			}
		}
		labelStr := renderLabels(e.labels)
		if _, err := fmt.Fprintf(w, "%s%s %s\n", e.name, labelStr, e.text); err != nil {
			return err
		}
	}

	// Call dynamic collectors.
	for _, fn := range fns {
		if err := fn(w); err != nil {
			return err
		}
	}
	return nil
}

// ----- Helpers -----

func metricKey(name string, labels map[string]string) string {
	if len(labels) == 0 {
		return name
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	sb.WriteString(name)
	for _, k := range keys {
		sb.WriteByte(',')
		sb.WriteString(k)
		sb.WriteByte('=')
		sb.WriteString(labels[k])
	}
	return sb.String()
}

func renderLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	sb.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(k)
		sb.WriteString(`="`)
		sb.WriteString(escapeLabel(labels[k]))
		sb.WriteByte('"')
	}
	sb.WriteByte('}')
	return sb.String()
}

// escapeLabel escapes the three characters special in Prometheus label values.
func escapeLabel(v string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
	)
	return r.Replace(v)
}

// escapeHelp escapes a HELP string per the Prometheus text exposition
// format: only backslash and newline are escaped (the double-quote is not
// special in HELP lines, unlike label values). Without this, a help string
// containing a newline would split the HELP line and corrupt the scrape.
func escapeHelp(v string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		"\n", `\n`,
	)
	return r.Replace(v)
}

// cloneLabels returns an independent copy of in (nil stays nil), so a caller
// mutating its label map after registration cannot alter the stored metric.
func cloneLabels(in map[string]string) map[string]string {
	return maps.Clone(in)
}

// formatFloat renders a float in the format Prometheus expects.
// Uses %g but converts special values to the Prometheus-canonical strings.
// Inf/NaN are detected with math.IsInf/IsNaN rather than magnitude thresholds:
// a threshold like v > 1e308 also matches large *finite* values (anything in
// (1e308, MaxFloat64]), which would be mis-rendered as "+Inf".
func formatFloat(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	}
	return fmt.Sprintf("%g", v)
}
