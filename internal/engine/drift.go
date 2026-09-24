// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"strings"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/provider"
)

// ============================================================================
// Stream-yield drift tracking — RESEARCH Cat 6 #16 (session 275)
//
// "Non-stationary Bandit Convex Optimization" (arXiv:2506.02980, NeurIPS
// 2025) bounds regret by three drift measures — switches S (count of
// distribution shifts), total variation V_T (sum of |Δyield|), and path
// length (per-episode variation). These are exactly the drift types in
// hashprice/provider yield (difficulty steps, price volatility, diurnal
// load). Recording which one a stream actually exhibits is the empirical
// input for choosing the self-tuning signal behind ADR-010 A1's forecaster
// reset threshold and A8's change-point detector: a stream dominated by S
// wants change-point handling, one dominated by V_T wants a forecaster
// that tracks smooth drift.
//
// Two counters per (stream, device) pair are published:
//   - otedama_stream_yield_shifts_total — significant yield changes
//     (|Δ| > driftShiftEpsilon of the prior level), the S measure.
//   - otedama_stream_yield_drift_sats_per_second_total — accumulated |Δ|
//     in the stream's yield units, the V_T measure.
// ============================================================================

// driftShiftEpsilon is the relative change below which a quote update is
// treated as provider noise rather than a regime shift (2% of the prior
// yield). A stream appearing or vanishing (zero ↔ positive) always counts.
const driftShiftEpsilon = 0.02

// driftTracker accumulates per-stream-key yield-drift measures across
// provider quotes. Keys are the streamMap key "providerID:deviceID".
type driftTracker struct {
	last   map[string]float64 // previous effective yield per key
	shifts map[string]uint64  // significant-shift count per key (S)
	tv     map[string]float64 // accumulated |Δyield| per key (V_T)
}

func newDriftTracker() *driftTracker {
	return &driftTracker{
		last:   make(map[string]float64),
		shifts: make(map[string]uint64),
		tv:     make(map[string]float64),
	}
}

// observedEffective mirrors what Decide() compares: the arbitration engine
// folds a provider quote into arbitration.Yield and compares Effective()
// (SatsPerSecond × Confidence). Drift is measured on that quantity so the
// measures describe the series the engine actually optimizes over.
func observedEffective(q *provider.Quote) float64 {
	return arbitration.Yield{
		SatsPerSecond: q.Yield.SatsPerSecond,
		Confidence:    q.Yield.Confidence,
	}.Effective()
}

// observe records one quote observation for key, returning whether the
// update counts as a significant shift along with the running totals.
func (d *driftTracker) observe(key string, y float64) (shifted bool, shiftCount uint64, totalVar float64) {
	prev, ok := d.last[key]
	d.last[key] = y
	if !ok {
		return false, d.shifts[key], d.tv[key]
	}
	delta := y - prev
	if delta < 0 {
		delta = -delta
	}
	d.tv[key] += delta
	// A significant shift is a change exceeding driftShiftEpsilon of the
	// prior level — relative, so scale-free. max(prev,0) keeps the band at
	// zero for a dead stream, so any revival or death counts at any size.
	if base := prev; delta > max(base, 0)*driftShiftEpsilon {
		d.shifts[key]++
		shifted = true
	}
	return shifted, d.shifts[key], d.tv[key]
}

// expire drops a stream's tracking state when its quote goes stale, so
// dead providers cannot grow the maps; counters already published stay.
func (d *driftTracker) expire(key string) {
	delete(d.last, key)
	delete(d.shifts, key)
	delete(d.tv, key)
}

// splitStreamKey splits the streamMap key "providerID:deviceID" into its
// (stream, device) label pair. DeviceID may be empty for device-agnostic
// quotes, and ProviderIDs contain no colons.
func splitStreamKey(key string) (stream, device string) {
	stream, device, _ = strings.Cut(key, ":")
	return stream, device
}
