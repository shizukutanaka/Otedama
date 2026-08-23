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
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
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
func buildStats(opts sessionOpts, hashRate float64, estSats uint64, latency *LatencyTracker, stalled bool) tui.Stats {
	var sharesFound uint64
	for _, w := range opts.workers {
		sharesFound += w.Stats().SharesFound
	}
	// sharesSent is the real otedama_shares_submitted_total counter — the
	// number of shares actually transmitted to the pool — not a copy of
	// sharesFound. The two diverge whenever a worker's share channel was
	// full (see totalDropped): that share is "found" but never reaches
	// opts.merged, so it is never submitted. See
	// docs/KNOWN_LIMITATIONS.md §9 (session 236) for the prior approximation.
	var sharesSent uint64
	if opts.m != nil {
		sharesSent = opts.m.sharesSubmitted.Value()
		opts.m.uptime.Set(time.Since(opts.startTime).Seconds())
	}

	var poolLatency time.Duration
	if latency != nil {
		if p50 := latency.Quantile(0.50); p50 > 0 {
			poolLatency = time.Duration(p50 * float64(time.Millisecond))
		}
	}

	// Active/SatsPerSecond come from the shared activity snapshot the
	// arbitration loop maintains from its own Decide() output — a provider
	// is "active" only if arbitration is actually routing at least one
	// device to it right now, not merely because it exists or has quoted
	// (see arbitrationLoopOpts.activity). Nil activityMu (no arbitration
	// loop wired, e.g. some tests) renders every provider inactive rather
	// than defaulting back to the old unconditional true.
	var providerStats []tui.ProviderStats
	for _, p := range opts.providers {
		ps := tui.ProviderStats{Name: p.Name()}
		if opts.activityMu != nil {
			opts.activityMu.Lock()
			yield, active := opts.activity[p.ID()]
			opts.activityMu.Unlock()
			ps.Active = active
			ps.SatsPerSecond = yield
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
		Curtailed:         opts.isCurtailed(),
		EstSatsEarned:     estSats,
		WalletFingerprint: opts.wallet,
		Uptime:            time.Since(opts.startTime),
		Devices:           opts.devices,
		Providers:         providerStats,
	}
}

// disconnectedStats builds the TUI snapshot shown while no pool session is
// active (mid-reconnect backoff, or between a dropped session and the next
// dial attempt). Connected is the only field this exists to make honest —
// buildStats is only ever invoked from inside an active session's stats
// tick, so without this the dashboard simply stopped receiving updates on
// disconnect and froze on its last "✓ connected" frame instead of showing
// the real "✗ disconnected" state (dashboard.go's poolLine already renders
// it correctly; nothing was ever driving it). Hashrate/shares/earnings are
// left at zero rather than echoing stale pre-disconnect values, since this
// snapshot does not know the true current state of any of them.
func disconnectedStats(poolURL, wallet string, startTime time.Time, devices int) tui.Stats {
	return tui.Stats{
		PoolURL:           poolURL,
		Connected:         false,
		WalletFingerprint: wallet,
		Uptime:            time.Since(startTime),
		Devices:           devices,
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

// uptimeAccountant accumulates the wall-clock time the miner spends actually
// producing hashrate (not stalled, not curtailed) into a counter, so an
// operator can compute effective uptime = productive_seconds / uptime_seconds.
// The research consensus is that reliability dwarfs fee differences — a few
// percent of lost productive time outweighs a fee gap — so this is the headline
// uptime number. Time is tracked as a wall-clock delta between observations,
// with the sub-second remainder carried forward, so it stays accurate across
// non-uniform stats ticks (RESEARCH_IMPROVEMENTS Category 12 item 12).
type uptimeAccountant struct {
	lastTick time.Time
	accum    float64 // productive seconds not yet flushed to the counter
}

// observe accounts the time since the previous observe() call as productive or
// not, flushing whole productive seconds to counter. The first call primes the
// clock and accounts nothing. A nil counter (no metrics) is a no-op.
func (u *uptimeAccountant) observe(now time.Time, productive bool, counter *metrics.Counter) {
	if u.lastTick.IsZero() {
		u.lastTick = now
		return
	}
	elapsed := now.Sub(u.lastTick).Seconds()
	u.lastTick = now
	if elapsed <= 0 || !productive || counter == nil {
		return
	}
	u.accum += elapsed
	if whole := uint64(u.accum); whole > 0 {
		counter.Add(whole)
		u.accum -= float64(whole)
	}
}

// satsAccountant estimates cumulative earnings by integrating the engine's
// own forecast earning rate (the arbitration expected yield, in
// sats/second) over the wall-clock time actually spent hashing
// productively. It replaces the former "+1 per accepted share" placeholder,
// which bore no relation to real income: a share carries no monetary value
// on the wire — the pool credits it according to difficulty and its payout
// scheme, never one sat each (see docs/KNOWN_LIMITATIONS.md §9).
//
// It gates on the same productive flag as uptimeAccountant (hashing, not
// stalled, not curtailed), so downtime contributes nothing rather than
// silently accruing phantom earnings. The result remains an ESTIMATE — the
// authoritative figure is the pool's own accounting — but unlike the
// placeholder it tracks BTC price, share difficulty, and downtime, all of
// which move the real number.
type satsAccountant struct {
	lastTick time.Time
	total    float64 // estimated sats; fractional precision retained across ticks
}

// observe adds ratePerSec × (elapsed productive seconds) to the running
// estimate and returns the new total. The first call primes the clock and
// adds nothing. A non-positive elapsed, a non-productive interval, or a
// non-positive rate each contribute zero, so the estimate never runs
// backwards or accrues during idle/stalled/curtailed periods.
func (s *satsAccountant) observe(now time.Time, ratePerSec float64, productive bool) float64 {
	if s.lastTick.IsZero() {
		s.lastTick = now
		return s.total
	}
	elapsed := now.Sub(s.lastTick).Seconds()
	s.lastTick = now
	if elapsed > 0 && productive && ratePerSec > 0 {
		s.total += ratePerSec * elapsed
	}
	return s.total
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

// effectiveYield folds downtime into the engine's forecast yield, producing
// a single gross-minus-losses estimate: the raw quoted rate
// (arbitrationExpectedYieldSatsPerSec) scaled by the lifetime fraction of
// wall-clock time actually spent hashing productively (productiveSeconds /
// uptimeSeconds — see uptimeAccountant). This is
// docs/RESEARCH_IMPROVEMENTS.md Category 3 item 12's remaining piece: the
// comparisons this project is measured against stress that reliability
// dwarfs fee differences (a 4% uptime gap costs ~4× a 1% fee gap), but the
// instantaneous expected-yield gauge alone doesn't show that — it reads
// unchanged whether the miner has been stalled for the last hour or not.
// A device quoted at X sats/s that only actually hashes half the time nets
// the same as one quoted at X/2 sats/s running continuously; this metric
// makes that equivalence visible as a single number instead of requiring
// every operator to write the same PromQL multiplication themselves.
//
// Returns 0 when uptimeSeconds <= 0 (nothing has run long enough yet for a
// meaningful ratio) rather than dividing by zero. The fraction is clamped
// to [0, 1] as a defensive guard against the two counters being read a
// moment apart by different tickers, which could otherwise transiently
// read productiveSeconds fractionally ahead of uptimeSeconds.
func effectiveYield(expectedYieldSatsPerSec, productiveSeconds, uptimeSeconds float64) float64 {
	if uptimeSeconds <= 0 {
		return 0
	}
	fraction := productiveSeconds / uptimeSeconds
	if fraction > 1 {
		fraction = 1
	} else if fraction < 0 {
		fraction = 0
	}
	return expectedYieldSatsPerSec * fraction
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

	slices.Sort(cp)
	// Nearest-rank index, clamped to a valid sample. The clamps make the
	// q<=0 and q>=1 endpoints fall out for free: a tiny/zero/negative q
	// underflows the index below 0 (pinned to the minimum sample), and a
	// q at or above 1 overflows it to n or beyond (pinned to the maximum).
	// Keeping the clamps rather than separate early returns means a single
	// code path serves the whole domain and the bounds-check still prevents
	// an out-of-range index panic for any caller-supplied q.
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

// rateStats is the read-only view of the rate fetcher that publishBTCRate
// needs. Depending on this interface rather than the concrete *rates.Fetcher
// keeps the publish glue unit-testable with a fake that reports any post-fetch
// state (skew, age, source health) without driving real network I/O.
// *rates.Fetcher satisfies it.
type rateStats interface {
	BTCUSDRate() (rate float64, fresh bool)
	ClockSkewSeconds() float64
	RateAge() (age time.Duration, everFetched bool)
	SourceHealth() (ok, total int, fetched bool)
}

// publishBTCRate copies the fetcher's current BTC/USD rate and observed clock
// skew into their respective gauges. The rate gauge uses the fetcher's fallback
// before the first successful fetch, so it is never left at zero. The skew
// gauge is updated whenever the fetcher has seen at least one HTTP Date header
// from a source (0 until then, signaling "not yet observed").
func publishBTCRate(m *engineMetrics, f rateStats) {
	if rate, _ := f.BTCUSDRate(); rate > 0 {
		m.btcUSDRate.Set(rate)
	}
	if skew := f.ClockSkewSeconds(); skew > 0 {
		m.clockSkewSeconds.Set(skew)
	}
	// Publish the age of the cached rate so a stalled price feed is visible
	// even while the rate value itself still looks healthy. Only set once a
	// real fetch has happened; before that the age is meaningless.
	if age, everFetched := f.RateAge(); everFetched {
		m.btcRateAgeSeconds.Set(age.Seconds())
	}
	// Publish redundancy health so silent erosion (median backed by 1 of 3
	// sources) is visible before the feed fails outright. total is published
	// always (it is a constant); ok only once a fetch has run.
	if ok, total, fetched := f.SourceHealth(); fetched {
		m.rateSourcesOK.Set(float64(ok))
		m.rateSourcesTotal.Set(float64(total))
	}
}

// publishDifficulty updates the pool-difficulty and estimated-share-interval
// gauges. diff is the pool's current share difficulty (from
// Session.SuggestedDifficulty). hashrate is in hashes per second. Either
// being 0 or negative is a no-op / zero on the computed gauge.
func publishDifficulty(m *engineMetrics, diff, hashrate float64) {
	if diff <= 0 {
		return
	}
	m.poolDifficulty.Set(diff)
	if hashrate > 0 {
		// E[seconds between shares] = D × 2^32 / hashrate
		m.estimatedShareIntervalSeconds.Set(diff * 4294967296 / hashrate)
	} else {
		m.estimatedShareIntervalSeconds.Set(0)
	}
}
