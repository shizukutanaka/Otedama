// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — stats.go
//
// Observability helpers for the run loop: worker-stat aggregation, the
// windowed hashrate calculation, share-reject classification, submit-
// latency quantiles, the stalled-hashrate monitor, and the TUI stats
// snapshot. None of these touch the pool connection; they only read
// worker counters and feed logs, metrics gauges, and the dashboard.

package engine

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/rates"
	"github.com/shizukutanaka/Otedama/internal/tui"
)

// buildStats assembles a tui.Stats snapshot from live engine state.
// Also updates the uptime gauge. hashRate is the current (windowed) rate
// computed once per stats tick by hashrateWindow; the hashrate gauge is set
// by the caller from the same value, so display, log, gauge, and stall
// monitor all agree.
//
// latency is the session's live LatencyTracker; its p50 populates
// PoolLatency so the TUI shows actual measured round-trip time instead of
// a constant zero. Passing nil is safe and leaves PoolLatency at 0.
//
// stalled reflects HashrateMonitor.Stalled(); true renders the ⚠ stalled
// indicator in the TUI so operators see the warning immediately.
func buildStats(opts sessionOpts, hashRate float64, totalSats uint64, latency *LatencyTracker, stalled bool) tui.Stats {
	var sharesSent, sharesFound uint64
	for _, w := range opts.workers {
		sharesFound += w.Stats().SharesFound
	}
	if opts.m != nil {
		opts.m.uptime.Set(time.Since(opts.startTime).Seconds())
	}
	sharesSent = sharesFound // approximation

	var poolLatency time.Duration
	if latency != nil {
		if p50 := latency.Quantile(0.50); p50 > 0 {
			poolLatency = time.Duration(p50 * float64(time.Millisecond))
		}
	}

	var providerStats []tui.ProviderStats
	for _, p := range opts.providers {
		// Sample latest quote from provider — simplified.
		ps := tui.ProviderStats{
			Name:   p.Name(),
			Active: true,
		}
		providerStats = append(providerStats, ps)
	}

	return tui.Stats{
		HashRate:          hashRate,
		SharesFound:       sharesFound,
		SharesSent:        sharesSent,
		PoolURL:           opts.poolURL,
		PoolLatency:       poolLatency,
		Connected:         true,
		Stalled:           stalled,
		TotalSatsEarned:   totalSats,
		WalletFingerprint: opts.wallet,
		Uptime:            time.Since(opts.startTime),
		Devices:           opts.devices,
		Providers:         providerStats,
	}
}

// totalHashes sums the lifetime cumulative hash count across all workers.
// This is the raw counter that hashrateWindow differentiates into a
// *current* rate — as opposed to a lifetime average (total/uptime), which
// barely moves once a worker has run for a while and so can never fall to
// the stall floor after startup, defeating HashrateMonitor.
func totalHashes(workers []*miner.Worker) uint64 {
	var total uint64
	for _, w := range workers {
		total += w.Stats().HashesTotal
	}
	return total
}

// totalDropped sums the shares dropped (consumer-full) across all workers.
func totalDropped(workers []*miner.Worker) uint64 {
	var total uint64
	for _, w := range workers {
		total += w.Stats().SharesDropped
	}
	return total
}

// hashrateWindow turns successive cumulative hash-count samples into a
// current hashrate (hashes/sec over the last interval). This is what every
// comparable miner reports (cgminer/bfgminer/ESP-Miner rolling averages)
// and what the stall monitor must consume: a lifetime average (total/uptime)
// stays positive forever after the first hash, so it can never signal a
// stall — only a windowed rate can.
//
// It is saturating: when the cumulative total *decreases* — which happens
// when workers are recreated on reconnect and their counters reset to zero
// (ESP-Miner reconnect fix) — the rate is 0, never negative or NaN. The
// first observation primes the baseline and returns 0.
type hashrateWindow struct {
	lastTotal uint64
	lastTime  time.Time
	primed    bool
}

// observe records one cumulative sample and returns the hashrate since the
// previous sample. The first call returns 0 (baseline).
func (w *hashrateWindow) observe(total uint64, now time.Time) float64 {
	if !w.primed {
		w.primed = true
		w.lastTotal = total
		w.lastTime = now
		return 0
	}
	dt := now.Sub(w.lastTime).Seconds()
	var rate float64
	if dt > 0 && total >= w.lastTotal {
		rate = float64(total-w.lastTotal) / dt
	}
	// total < lastTotal → counters reset (reconnect): leave rate at 0.
	w.lastTotal = total
	w.lastTime = now
	return rate
}

// logStats emits the periodic hashrate + cumulative share-count log line.
func logStats(workers []*miner.Worker, hashRate float64, log func(string, string)) {
	var shares uint64
	for _, w := range workers {
		shares += w.Stats().SharesFound
	}
	log("info", fmt.Sprintf("engine: hashrate=%s shares=%d",
		miner.HashRateString(hashRate), shares))
}

// rejectClass categorises a pool's share-rejection reason. The category
// string is short and stable, suitable as a metric label; the diagnosis
// is the human-readable hint for logs. Both derive from the same
// classification (community field taxonomy, e.g. D-Central's guide):
// stale→latency, duplicate→firmware, above-target→difficulty,
// invalid→hardware.
func rejectClass(reason string) (category, diagnosis string) {
	r := strings.ToLower(reason)
	switch {
	case strings.Contains(r, "stale") || strings.Contains(r, "job not found") || strings.Contains(r, "unknown job"):
		return "stale", "likely cause: network latency / stale work"
	case strings.Contains(r, "duplicate"):
		return "duplicate", "likely cause: firmware or connectivity (duplicate submission)"
	case strings.Contains(r, "above") || strings.Contains(r, "target") || strings.Contains(r, "low difficulty") || strings.Contains(r, "high-hash"):
		return "difficulty", "likely cause: difficulty configuration or hardware error"
	case strings.Contains(r, "invalid") || strings.Contains(r, "bad"):
		return "hardware", "likely cause: hardware error (failing chip / overheating)"
	default:
		return "other", "cause unclassified — check pool documentation"
	}
}

// acceptanceRate computes the share acceptance rate — accepted /
// (accepted + rejected) — as a fraction in [0,1]. This is the metric
// that maps to "net BTC retained": every rejected share is work the
// pool will not pay for, so a falling acceptance rate is lost revenue
// (see docs/RESEARCH_IMPROVEMENTS.md Cat 3). Returns 1.0 when no shares
// have been judged yet (nothing rejected = nothing lost), avoiding a
// 0/0 that would otherwise read as a catastrophic 0% on a fresh start.
func acceptanceRate(accepted, rejected uint64) float64 {
	total := accepted + rejected
	if total == 0 {
		return 1.0
	}
	return float64(accepted) / float64(total)
}

// LatencyTracker records share-submission round-trip times (submit →
// pool accept/reject) in a fixed-size ring buffer and computes
// quantiles on demand. Submit latency is the direct driver of stale
// shares — the #1 reject cause — so surfacing p50/p95/p99 tells an
// operator when their pool is too far away (high RTT) before it shows
// up as lost revenue in the reject rate.
//
// It is intentionally allocation-free in steady state and lock-protected
// so the submit path (which records) and the stats loop (which reads
// quantiles) can run on different goroutines.
type LatencyTracker struct {
	mu      sync.Mutex
	samples []float64 // milliseconds, ring buffer
	next    int
	filled  bool
}

// NewLatencyTracker creates a tracker holding the most recent `size`
// samples (default 256 if size < 1).
func NewLatencyTracker(size int) *LatencyTracker {
	if size < 1 {
		size = 256
	}
	return &LatencyTracker{samples: make([]float64, size)}
}

// Record adds one round-trip sample in milliseconds.
func (l *LatencyTracker) Record(ms float64) {
	if ms < 0 {
		return
	}
	l.mu.Lock()
	l.samples[l.next] = ms
	l.next = (l.next + 1) % len(l.samples)
	if l.next == 0 {
		l.filled = true
	}
	l.mu.Unlock()
}

// Quantile returns the q-th (0..1) percentile of the recorded samples in
// milliseconds, or 0 if no samples yet. Uses nearest-rank on a sorted
// copy — exact for the retained window, no streaming-estimator error.
func (l *LatencyTracker) Quantile(q float64) float64 {
	l.mu.Lock()
	n := len(l.samples)
	if !l.filled {
		n = l.next
	}
	if n == 0 {
		l.mu.Unlock()
		return 0
	}
	cp := make([]float64, n)
	copy(cp, l.samples[:n])
	l.mu.Unlock()

	sort.Float64s(cp)
	if q <= 0 {
		return cp[0]
	}
	if q >= 1 {
		return cp[n-1]
	}
	idx := int(q*float64(n)+0.5) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= n {
		idx = n - 1
	}
	return cp[idx]
}

// HashrateMonitor watches for a stalled miner: a hashrate that has been
// at or below a floor for several consecutive samples. This is the
// safety net every comparable miner has (cgminer/Awesome Miner
// hashrate-drop triggers) — without it, a miner that silently stops
// hashing (driver wedged, thermal shutdown, work starvation) keeps the
// process alive while earning nothing, and the user never finds out.
//
// The monitor is intentionally stateful and single-goroutine: it is
// driven from the same stats loop that logs hashrate, so no locking is
// needed.
type HashrateMonitor struct {
	floor      float64 // hashes/sec at or below which a sample counts as stalled
	maxStall   int     // consecutive stalled samples before warning
	stallCount int
	warned     bool
	log        func(level, msg string)
}

// NewHashrateMonitor creates a monitor that warns after maxStall
// consecutive samples at or below floor hashes/sec. A floor of 0 means
// "warn only on a complete stall (zero hashrate)".
func NewHashrateMonitor(floor float64, maxStall int, log func(level, msg string)) *HashrateMonitor {
	if maxStall < 1 {
		maxStall = 3
	}
	return &HashrateMonitor{floor: floor, maxStall: maxStall, log: log}
}

// Observe records one hashrate sample and emits a warning the first
// time the stall threshold is crossed. Once the hashrate recovers above
// the floor, the monitor resets and will warn again on the next stall.
func (m *HashrateMonitor) Observe(hashrate float64) {
	if hashrate <= m.floor {
		m.stallCount++
		if m.stallCount >= m.maxStall && !m.warned {
			m.warned = true
			if m.log != nil {
				m.log("warn", fmt.Sprintf(
					"engine: hashrate stalled at %s for %d consecutive samples — "+
						"check device health, cooling, and pool connection",
					miner.HashRateString(hashrate), m.stallCount))
			}
		}
		return
	}
	// Recovered.
	if m.warned && m.log != nil {
		m.log("info", "engine: hashrate recovered")
	}
	m.stallCount = 0
	m.warned = false
}

// Stalled reports whether the monitor is currently in a warned-stall
// state (useful for health endpoints / readiness).
func (m *HashrateMonitor) Stalled() bool { return m.warned }

// publishBTCRate copies the fetcher's current BTC/USD rate into its gauge.
// The fetcher returns its fallback before the first successful fetch, so the
// gauge is never left at zero once a fetcher exists.
func publishBTCRate(m *engineMetrics, f *rates.Fetcher) {
	if rate, _ := f.BTCUSDRate(); rate > 0 {
		m.btcUSDRate.Set(rate)
	}
}
