// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package metrics

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// exemplar is one observation's trace context, rendered after the bucket
// sample it was recorded on in OpenMetrics syntax:
//
//	metric_bucket{le="0.1"} 42 # {share_seq="17"} 0.083 1760000000000
//
// In the text/0.0.4 exposition Otedama serves, the leading '#' parses as
// a comment marker on parsers that predate exemplars, so attaching one
// degrades gracefully rather than corrupting the scrape.
type exemplar struct {
	// labels is the pre-rendered `{k="v",...}` label text (renderLabels
	// output — sorted keys, escaped values).
	labels string
	value  float64
	ts     int64 // observation time, Unix milliseconds
}

// Histogram is a fixed-bucket cumulative histogram with optional
// per-bucket exemplar attachment — the dependency-free equivalent of
// prometheus/client_golang's ObserveWithExemplar. Each bucket retains
// only the most recent observation's exemplar (the client_golang
// convention), which is what makes a p99 spike answerable: the exemplar
// on the high bucket names the exact observation that landed there.
type Histogram struct {
	name   string
	help   string
	labels map[string]string

	// upperBounds are the le= thresholds, ascending; an implicit +Inf
	// bucket always follows the last one.
	upperBounds []float64
	// counts[i] is the number of observations in (bounds[i-1], bounds[i]];
	// counts[len(bounds)] is the overflow bucket.
	counts []atomic.Uint64
	// exemplars[i] mirrors counts[i]; nil until ObserveWithExemplar lands
	// there. Latest wins.
	exemplars []atomic.Pointer[exemplar]
	sumBits   atomic.Uint64 // float64 bits, updated via CAS
}

// NewHistogram registers a new Histogram. Duplicate name+labels returns
// the existing one. Buckets must be ascending; an out-of-order slice
// panics (a developer error caught at registration).
// Panics on invalid names/labels like NewCounter, and on a name already
// registered as a counter or gauge — one metric name may carry only one
// Prometheus TYPE or the whole scrape is discarded.
func (r *Registry) NewHistogram(name, help string, labels map[string]string, upperBounds []float64) *Histogram {
	if !isValidMetricName(name) {
		panic(fmt.Sprintf("metrics: invalid metric name %q (must match [a-zA-Z_:][a-zA-Z0-9_:]*)", name))
	}
	validateLabelNames(name, labels)
	for i, b := range upperBounds {
		if math.IsNaN(b) || (i > 0 && b <= upperBounds[i-1]) {
			panic(fmt.Sprintf("metrics: histogram %q bounds must be ascending and non-NaN (got %v)", name, upperBounds))
		}
	}
	key := metricKey(name, labels)
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.histograms[key]; ok {
		return existing
	}
	if counterNameExists(r.counters, name) || gaugeNameExists(r.gauges, name) {
		panic(fmt.Sprintf("metrics: name %q already registered as a counter/gauge; cannot also be a histogram", name))
	}
	h := &Histogram{
		name:        name,
		help:        help,
		labels:      cloneLabels(labels),
		upperBounds: slices.Clone(upperBounds),
		counts:      make([]atomic.Uint64, len(upperBounds)+1),
		exemplars:   make([]atomic.Pointer[exemplar], len(upperBounds)+1),
	}
	r.histograms[key] = h
	return h
}

// Observe records v into the matching cumulative bucket.
func (h *Histogram) Observe(v float64) {
	h.observe(v, nil)
}

// ObserveWithExemplar records v and attaches exemplarLabels to the bucket
// v lands in, replacing any previous exemplar there. exemplarLabels must
// be small — the trace lookup key (e.g. share sequence number, request
// ID), not arbitrary dimensions; client_golang caps exemplar labels at
// 128 runes for the same reason. Invalid label names or an oversized
// label set drop the exemplar but still record the observation.
func (h *Histogram) ObserveWithExemplar(v float64, exemplarLabels map[string]string) {
	h.observe(v, exemplarLabels)
}

const maxExemplarLabelRunes = 128

func (h *Histogram) observe(v float64, exemplarLabels map[string]string) {
	i, _ := slices.BinarySearch(h.upperBounds, v)
	h.counts[i].Add(1)
	for {
		old := h.sumBits.Load()
		if h.sumBits.CompareAndSwap(old, math.Float64bits(math.Float64frombits(old)+v)) {
			break
		}
	}
	if len(exemplarLabels) == 0 {
		return
	}
	labels := renderLabels(exemplarLabels)
	// rune-count the *source* values; renderLabels inserts separators.
	n := 0
	for k, val := range exemplarLabels {
		if !isValidLabelName(k) {
			return
		}
		n += len(k) + len(val)
	}
	if n > maxExemplarLabelRunes {
		return
	}
	h.exemplars[i].Store(&exemplar{labels: labels, value: v, ts: time.Now().UnixMilli()})
}

// render produces the bucket/sum/count series lines for this histogram,
// each a complete exposition line (with exemplar comment when present).
func (h *Histogram) render() []string {
	out := make([]string, 0, len(h.upperBounds)+3)
	base := renderLabels(h.labels)
	sep := ""
	if len(h.labels) > 0 {
		sep = ","
	}
	var cumulative uint64
	emit := func(le string, i int) {
		var sb strings.Builder
		fmt.Fprintf(&sb, "%s_bucket{%s%sle=%q} %d", h.name, strings.Trim(base, "{}"), sep, le, cumulative)
		if ex := h.exemplars[i].Load(); ex != nil {
			fmt.Fprintf(&sb, " # %s %s %d", ex.labels, formatFloat(ex.value), ex.ts)
		}
		out = append(out, sb.String())
	}
	for i, ub := range h.upperBounds {
		cumulative += h.counts[i].Load()
		emit(formatFloat(ub), i)
	}
	cumulative += h.counts[len(h.upperBounds)].Load()
	emit("+Inf", len(h.upperBounds))
	out = append(out,
		fmt.Sprintf("%s_sum%s %s", h.name, base, formatFloat(math.Float64frombits(h.sumBits.Load()))),
		fmt.Sprintf("%s_count%s %d", h.name, base, cumulative))
	return out
}

// histogramNameExists is the histogram-map counterpart of
// gaugeNameExists: bare-name comparison across label sets.
func histogramNameExists(m map[string]*Histogram, name string) bool {
	for _, h := range m {
		if h.name == name {
			return true
		}
	}
	return false
}
