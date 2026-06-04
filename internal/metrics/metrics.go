// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package metrics exposes Otedama's runtime metrics in a format
// compatible with Prometheus scrape endpoints.
//
// # Why not import prometheus/client_golang?
//
// The official Go client library is excellent but adds ~10MB to the
// binary and a transitive dependency on dozens of packages. For the
// metrics Otedama needs — counters, gauges, a handful of histograms —
// the Prometheus text exposition format is a few hundred lines of
// straightforward code. Going dependency-free keeps supply-chain risk
// minimal and the binary small.
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
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry holds all registered metrics.
// Safe for concurrent use.
type Registry struct {
	mu       sync.RWMutex
	counters map[string]*Counter
	gauges   map[string]*Gauge
}

// NewRegistry returns an empty metrics registry.
func NewRegistry() *Registry {
	return &Registry{
		counters: make(map[string]*Counter),
		gauges:   make(map[string]*Gauge),
	}
}

// Counter is a monotonically increasing value (e.g. total shares submitted).
type Counter struct {
	name   string
	help   string
	labels map[string]string
	value  uint64
}

// Gauge is an instantaneous value (e.g. current hashrate).
type Gauge struct {
	name   string
	help   string
	labels map[string]string

	mu    sync.RWMutex
	value float64
}

// ----- Counter API -----

// NewCounter registers a new Counter. Duplicate name+labels returns the existing one.
func (r *Registry) NewCounter(name, help string, labels map[string]string) *Counter {
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
func (c *Counter) Inc() { atomic.AddUint64(&c.value, 1) }

// Add adds delta to the counter. Panics if delta is negative.
func (c *Counter) Add(delta uint64) { atomic.AddUint64(&c.value, delta) }

// Value returns the current counter value.
func (c *Counter) Value() uint64 { return atomic.LoadUint64(&c.value) }

// ----- Gauge API -----

// NewGauge registers a new Gauge.
func (r *Registry) NewGauge(name, help string, labels map[string]string) *Gauge {
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
// Metrics are sorted by name for stable diffing in tests.
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
			if _, err := fmt.Fprintf(w, "# HELP %s %s\n", e.name, e.help); err != nil {
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

func cloneLabels(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// formatFloat renders a float in the format Prometheus expects.
// Uses %g but converts special values to the Prometheus-canonical strings.
func formatFloat(v float64) string {
	switch {
	case v != v: // NaN
		return "NaN"
	case v > 1e308:
		return "+Inf"
	case v < -1e308:
		return "-Inf"
	}
	return fmt.Sprintf("%g", v)
}
