// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — arbitrate.go
//
// The arbitration loop and its helpers: translating provider quotes
// into arbitration streams, periodically re-running Decide, and
// applying the resulting device→stream allocation to the miner workers.

package engine

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
)

// arbitrationLoopOpts bundles the arguments to runArbitrationLoop.
type arbitrationLoopOpts struct {
	devRefs       []arbitration.DeviceRef
	streamsMu     *sync.Mutex
	streamMap     map[string]arbitration.Stream
	quoteCh       <-chan provider.Quote
	workers       []*miner.Worker
	metrics       *engineMetrics // must not be nil
	log           func(level, msg string)
	hysteresisPct float64 // 0 uses defaultHysteresisPct
	minYield      float64 // 0 disables the per-device profitability floor

	// activityMu/activity, when both non-nil, receive the TUI-facing
	// provider status: after each Decide() this loop rewrites activity to
	// exactly the providers with a live (non-idle) assignment this cycle,
	// keyed by provider ID, valued at the summed ExpectedYield across all
	// devices currently routed to them. A provider absent from the map is
	// not earning anything right now, whether or not it is still quoting —
	// "active" means arbitration actually chose it, not merely that it
	// exists. See buildStats/stats.go for the read side.
	activityMu *sync.Mutex
	activity   map[string]float64

	// explain, when non-nil, receives a fresh DecisionSnapshot after every
	// Decide cycle — the ADR-010 A9 read-model served by /arbitration and
	// rendered by `otedama arb explain`. Nil disables recording (tests and
	// the non-HTTP run configuration skip the allocation bookkeeping).
	explain *atomic.Pointer[arbitration.DecisionSnapshot]
}

// defaultHysteresisPct matches the default in config.Defaults().
const defaultHysteresisPct = 0.05

// streamStaleTimeout is how long a provider's quote remains usable after it
// was generated. Providers re-quote every 30s (mining) / 60s (AI), so a
// provider that has sent no quote within this window is treated as dead and
// its stream is dropped from arbitration — otherwise a crashed or partitioned
// provider's last quote would route devices to a revenue source that no longer
// exists (RESEARCH_IMPROVEMENTS Category 5 item 3). The window is generous
// (3–6× the quote cadence) so ordinary jitter never prunes a live provider.
const streamStaleTimeout = 3 * time.Minute

// forecastSeasonSteps is the Holt-Winters seasonal period in quote steps
// (ADR-010 A1). Providers re-quote on every arbitration tick, so one step
// ≈ 30 s and 2880 steps ≈ 24 h — one diurnal cycle of hashprice/AI demand.
const forecastSeasonSteps = 2880

// runArbitrationLoop re-evaluates device→stream assignment every 30s,
// or whenever a fresh quote arrives. Blocks until ctx is cancelled or
// the quote channel is closed.
func runArbitrationLoop(ctx context.Context, opts arbitrationLoopOpts) {
	ticker := time.NewTicker(arbitrationInterval)
	defer ticker.Stop()
	var prevAlloc *arbitration.Allocation
	// lastQuoteAt records when each stream (keyed as in updateStream) last
	// received a quote, so stale streams from dead providers can be expired.
	lastQuoteAt := make(map[string]time.Time)
	// reliability is the per-provider Beta-Bernoulli posterior (ADR-010 A6);
	// creditAt marks when each stream last earned its success epoch, so a
	// continuous quote stream accrues at most one success per stale window.
	// Both are guarded by streamsMu.
	reliability := make(map[string]*arbitration.ProviderReliability)
	creditAt := make(map[string]time.Time)
	// forecasters is the per-stream Holt-Winters smoother (ADR-010 A1):
	// each quote is one step, so a 24h season for tick-cadence providers is
	// ~2880 steps. Its sigma feeds the forecast-miss counter that A8's
	// regime-reset (>2σ shift) will consume.
	forecasters := make(map[string]*arbitration.YieldForecaster)
	for {
		select {
		case <-ctx.Done():
			return
		case q, ok := <-opts.quoteCh:
			if !ok {
				return
			}
			key := updateStreamReliability(opts.streamsMu, opts.streamMap, reliability, q)
			opts.streamsMu.Lock()
			fc := forecasters[key]
			if fc == nil {
				fc = arbitration.NewYieldForecaster(forecastSeasonSteps)
				forecasters[key] = fc
			}
			observed := q.Yield.NetSatsPerSecond
			if observed <= 0 {
				observed = q.Yield.SatsPerSecond
			}
			err, reset := fc.Update(observed * q.Yield.Confidence)
			stream, device, _ := strings.Cut(key, ":")
			opts.streamsMu.Unlock()
			opts.metrics.observeYieldForecast(stream, device, fc.Predict(1))
			if err > 0 && fc.Sigma() > 0 && err > 2*fc.Sigma() {
				opts.metrics.observeForecastMiss(stream, device)
			}
			if reset {
				opts.metrics.observeForecasterReset(stream, device)
			}
			ts := q.At
			if ts.IsZero() {
				ts = time.Now()
			}
			lastQuoteAt[key] = ts
		case <-ticker.C:
			opts.streamsMu.Lock()
			now := time.Now()
			for _, key := range pruneStaleStreams(opts.streamMap, lastQuoteAt, now, streamStaleTimeout) {
				providerReliability(reliability, key).Update(false)
				delete(creditAt, key)
				delete(forecasters, key)
				opts.log("info", fmt.Sprintf(
					"arbitration: stream %q expired (no quote in %s); no longer routing to it",
					key, streamStaleTimeout))
			}
			for key := range opts.streamMap {
				credited, seen := creditAt[key]
				if !seen {
					creditAt[key] = now
					continue
				}
				if now.Sub(credited) >= streamStaleTimeout {
					providerReliability(reliability, key).Update(true)
					creditAt[key] = now
				}
			}
			for pid, r := range reliability {
				opts.metrics.observeProviderReliability(pid, r.PosteriorMean())
			}
			streams := streamsSlice(opts.streamMap)
			opts.streamsMu.Unlock()
			opts.metrics.activeStreams.Set(float64(len(streams)))

			margin := opts.hysteresisPct
			if margin == 0 {
				margin = defaultHysteresisPct
			}
			alloc, err := arbitration.Decide(arbitration.Input{
				Devices:            opts.devRefs,
				Streams:            streams,
				Previous:           prevAlloc,
				Policy:             arbitration.PolicyMaximizeEarnings,
				HysteresisMargin:   margin,
				MinYieldSatsPerSec: opts.minYield,
			})
			if err != nil {
				opts.log("warn", fmt.Sprintf("arbitration: %v", err))
				continue
			}
			// Capture the previous idle count before overwriting prevAlloc, so a
			// transition can be logged once (not every tick) for operators who
			// watch logs rather than the otedama_devices_idle gauge.
			prevSkipped := 0
			if prevAlloc != nil {
				prevSkipped = prevAlloc.SkippedDevice
			}
			prevAlloc = alloc
			var foregone float64
			for _, a := range alloc.Assignments {
				if a.SwitchedFromID != "" {
					opts.metrics.arbitrationSwitches.Inc()
				}
				if a.Held {
					opts.metrics.arbitrationHolds.Inc()
				}
				foregone += a.ForegoneSatsPerSec
			}
			opts.metrics.arbitrationForegoneSatsPerSec.Set(foregone)
			opts.metrics.arbitrationExpectedYieldSatsPerSec.Set(alloc.TotalYield)
			opts.metrics.devicesIdle.Set(float64(alloc.SkippedDevice))
			if opts.activityMu != nil && opts.activity != nil {
				opts.activityMu.Lock()
				clear(opts.activity)
				for _, a := range alloc.Assignments {
					if a.Idle() {
						continue
					}
					opts.activity[string(a.Stream)] += a.ExpectedYield
				}
				opts.activityMu.Unlock()
			}
			if alloc.SkippedDevice != prevSkipped {
				if alloc.SkippedDevice > 0 {
					opts.log("info", fmt.Sprintf(
						"arbitration: %d device(s) now idle (no viable stream, or below min_yield_sats_per_sec floor)",
						alloc.SkippedDevice))
				} else {
					opts.log("info", "arbitration: all devices now have a viable stream")
				}
			}
			applyAllocation(alloc, opts.workers, opts.log)
			opts.recordExplainSnapshot(alloc, margin, forecasters, reliability)
		}
	}
}

// recordExplainSnapshot publishes a fresh DecisionSnapshot for ADR-010 A9
// explainability: one ExplainRow per assignment carrying the Holt-Winters
// one-step forecast ± MAE and the Beta-Bernoulli posterior Decide() just
// used, plus the held/foregone context that explains a non-maximal pick.
// forecasters and reliability are guarded by streamsMu (taken here) — the
// snapshot is built after applyAllocation so a slow reader never delays
// the worker pause/unpause the loop just issued.
func (opts *arbitrationLoopOpts) recordExplainSnapshot(alloc *arbitration.Allocation, margin float64, forecasters map[string]*arbitration.YieldForecaster, reliability map[string]*arbitration.ProviderReliability) {
	if opts.explain == nil {
		return // recording disabled (no /arbitration consumer)
	}
	snap := &arbitration.DecisionSnapshot{
		At:                 time.Now(),
		Policy:             arbitration.PolicyMaximizeEarnings.String(),
		HysteresisPct:      margin,
		MinYieldSatsPerSec: opts.minYield,
		Rows:               make([]arbitration.ExplainRow, 0, len(alloc.Assignments)),
		Skipped:            alloc.SkippedDevice,
		TotalSatsPerSec:    alloc.TotalYield,
	}
	opts.streamsMu.Lock()
	for _, a := range alloc.Assignments {
		row := arbitration.ExplainRow{
			DeviceID:           a.DeviceID,
			Stream:             a.Stream,
			ExpectedSatsPerSec: a.ExpectedYield,
			SwitchedFrom:       a.SwitchedFromID,
			Held:               a.Held,
			ForegoneSatsPerSec: a.ForegoneSatsPerSec,
			ForegoneStream:     a.ForegoneStreamID,
			Reason:             a.Reason,
		}
		// The declined stream's current expected yield mirrors Decide's own
		// effective-yield convention (SatsPerSecond × Confidence). streamMap
		// is keyed "providerID:deviceID" — the StreamID alone is only the
		// provider half.
		if a.ForegoneStreamID != "" {
			if s, ok := opts.streamMap[string(a.ForegoneStreamID)+":"+a.DeviceID]; ok {
				exp := s.YieldFor(a.DeviceID).Effective()
				row.ForegoneExpectedSatsPerSec = &exp
			}
		}
		if a.SwitchedFromID != "" {
			if s, ok := opts.streamMap[string(a.SwitchedFromID)+":"+a.DeviceID]; ok {
				exp := s.YieldFor(a.DeviceID).Effective()
				row.SwitchedFromExpectedSatsPerSec = &exp
			}
		}
		if !a.Idle() {
			if fc := forecasters[string(a.Stream)+":"+a.DeviceID]; fc != nil {
				pred := fc.Predict(1)
				sigma := fc.Sigma()
				row.ForecastSatsPerSec = &pred
				row.ForecastSigmaSatsPerSec = &sigma
			}
			// The alternative stream's error scale powers the "does the gap
			// exceed forecast noise" reasoning clause: the foregone
			// candidate for a hold, the previous stream for a switch.
			altID := a.ForegoneStreamID
			if altID == "" {
				altID = a.SwitchedFromID
			}
			if altID != "" {
				if fc := forecasters[string(altID)+":"+a.DeviceID]; fc != nil {
					sigma := fc.Sigma()
					row.AltForecastSigmaSatsPerSec = &sigma
				}
			}
			if r := reliability[string(a.Stream)]; r != nil {
				mean := r.PosteriorMean()
				row.Reliability = &mean
				row.ReliabilityAlpha, row.ReliabilityBeta = r.Params()
			}
		}
		snap.Rows = append(snap.Rows, row)
	}
	opts.streamsMu.Unlock()
	opts.explain.Store(snap)
}

// pruneStaleStreams removes from m (and seen) every stream whose last quote is
// older than ttl, returning the pruned keys. Only entries that have a recorded
// quote time are considered: a stream present in m but absent from seen (e.g.
// pre-seeded directly, never quoted) is never pruned. now is passed in so the
// logic is deterministically testable.
func pruneStaleStreams(m map[string]arbitration.Stream, seen map[string]time.Time, now time.Time, ttl time.Duration) []string {
	var pruned []string
	for key, ts := range seen {
		if now.Sub(ts) > ttl {
			delete(m, key)
			delete(seen, key)
			pruned = append(pruned, key)
		}
	}
	return pruned
}

// updateStream folds one provider quote into the live streams map,
// keyed by "providerID:deviceID". It returns the key it wrote, so the caller
// can track per-stream freshness for staleness pruning.
func updateStream(mu *sync.Mutex, m map[string]arbitration.Stream, q provider.Quote) string {
	return updateStreamReliability(mu, m, nil, q)
}

// updateStreamReliability is updateStream plus the ADR-010 A6 discount: the
// provider's self-reported confidence is scaled by its Beta-Bernoulli
// posterior, so a provider that has let streams die earns less trust on
// subsequent quotes. A nil rel map applies no discount (tests, seeds).
// Guarded by the same mutex as m.
func updateStreamReliability(mu *sync.Mutex, m map[string]arbitration.Stream, rel map[string]*arbitration.ProviderReliability, q provider.Quote) string {
	mu.Lock()
	defer mu.Unlock()
	discount := 1.0
	if r := rel[q.ProviderID]; r != nil {
		discount = r.PosteriorMean()
	}
	key := q.ProviderID + ":" + q.DeviceID
	existing := m[key]
	existing.ID = arbitration.StreamID(q.ProviderID)
	existing.AcceptsFamilies = q.AcceptedFamilies
	if existing.YieldPerDevice == nil {
		existing.YieldPerDevice = make(map[string]arbitration.Yield)
	}
	if q.DeviceID != "" {
		existing.YieldPerDevice[q.DeviceID] = arbitration.Yield{
			SatsPerSecond: q.Yield.SatsPerSecond,
			Confidence:    q.Yield.Confidence * discount,
		}
	}
	existing.DefaultYield = arbitration.Yield{
		SatsPerSecond: q.Yield.SatsPerSecond,
		Confidence:    q.Yield.Confidence * discount,
	}
	existing.IsBitcoinMining = q.ProviderID == "mining.stratum"
	m[key] = existing
	return key
}

// providerReliability returns (creating on first use) the Beta-Bernoulli
// tracker for the provider half of a "providerID:deviceID" stream key.
// Callers must hold the same mutex that guards m.
func providerReliability(m map[string]*arbitration.ProviderReliability, streamKey string) *arbitration.ProviderReliability {
	pid, _, _ := strings.Cut(streamKey, ":")
	r := m[pid]
	if r == nil {
		r = arbitration.NewProviderReliability()
		m[pid] = r
	}
	return r
}

// streamsSlice flattens the streams map into a slice, de-duplicated by
// StreamID. The map is keyed "providerID:deviceID", so a provider with N
// devices produces N entries all sharing the same StreamID. A simple
// first-seen pick would lose the YieldPerDevice data for all but one device,
// causing the arbitration engine to fall back to DefaultYield for the rest.
// Instead, same-ID entries are merged: the first becomes the representative
// and subsequent ones contribute their YieldPerDevice entries into it.
func streamsSlice(m map[string]arbitration.Stream) []arbitration.Stream {
	merged := make(map[arbitration.StreamID]*arbitration.Stream, len(m))
	for _, s := range m {
		if rep, ok := merged[s.ID]; ok {
			// Merge YieldPerDevice from this entry into the representative so
			// the arbitration engine has per-device yields for every device, not
			// just whichever map entry happened to be iterated first.
			// updateStream always initialises YieldPerDevice before inserting
			// into the map, so rep.YieldPerDevice is never nil here.
			for devID, y := range s.YieldPerDevice {
				rep.YieldPerDevice[devID] = y
			}
		} else {
			// Deep-copy to avoid aliasing the YieldPerDevice map inside m.
			cp := s
			if len(s.YieldPerDevice) > 0 {
				ypd := make(map[string]arbitration.Yield, len(s.YieldPerDevice))
				for k, v := range s.YieldPerDevice {
					ypd[k] = v
				}
				cp.YieldPerDevice = ypd
			}
			merged[s.ID] = &cp
		}
	}
	result := make([]arbitration.Stream, 0, len(merged))
	for _, s := range merged {
		result = append(result, *s)
	}
	return result
}

// applyAllocation applies a Decide result to the miner workers: pausing
// SHA256d work on the specific device that was idled or switched to AI
// inference, and logging every change of assignment.
func applyAllocation(alloc *arbitration.Allocation, workers []*miner.Worker, log func(string, string)) {
	// pauseDevice stops only the worker whose DeviceID matches the
	// assignment being processed. Correctness bug fixed session 247:
	// this previously called SetWork(nil) on every element of workers,
	// so idling or AI-switching one device silently paused mining on
	// every other SHA256d device too. Currently latent — the only
	// production HAL driver reporting SHA256d:true is the single CPU
	// device (GPU always reports false, see internal/hal/gpu_linux.go),
	// so startMinerWorkers never produces more than one worker today —
	// but the moment a second SHA256d-capable device exists (e.g. an
	// ASIC driver), this would silently stop unrelated devices from
	// mining.
	pauseDevice := func(deviceID string) {
		for _, w := range workers {
			if w.DeviceID() == deviceID {
				w.SetWork(nil)
				return
			}
		}
	}
	for _, a := range alloc.Assignments {
		switch {
		case a.Idle():
			// Device is idle: no stream accepts its family, or all compatible
			// streams are below the min_yield_sats_per_sec floor. Pause SHA256d.
			pauseDevice(a.DeviceID)
			reason := a.Reason
			if reason == "" {
				reason = "no compatible stream"
			}
			log("info", fmt.Sprintf("arbitration: %s idle (%s)", a.DeviceID, reason))

		case a.SwitchedFromID != "":
			// Stream changed. If switching away from mining, signal workers to pause.
			// Switching TO mining re-enables them; the pool connection delivers new work.
			wasAI := strings.HasPrefix(string(a.SwitchedFromID), "ai.")
			nowAI := strings.HasPrefix(string(a.Stream), "ai.")
			switch {
			case !wasAI && nowAI:
				// Mining → AI: pause this device's SHA256d worker.
				pauseDevice(a.DeviceID)
				log("info", fmt.Sprintf("arbitration: %s → AI inference (%.0f sat/s)",
					a.DeviceID, a.ExpectedYield))
			case wasAI && !nowAI:
				// AI → Mining: workers will receive new work from the pool on next job.
				log("info", fmt.Sprintf("arbitration: %s → mining (%.0f sat/s)",
					a.DeviceID, a.ExpectedYield))
			default:
				log("info", fmt.Sprintf("arbitration: %s switched to %s (%.0f sat/s)",
					a.DeviceID, a.Stream, a.ExpectedYield))
			}

		default:
			// No change; assignment held per hysteresis.
		}
	}
}
