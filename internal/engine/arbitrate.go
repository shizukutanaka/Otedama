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
	for {
		select {
		case <-ctx.Done():
			return
		case q, ok := <-opts.quoteCh:
			if !ok {
				return
			}
			key := updateStream(opts.streamsMu, opts.streamMap, q)
			ts := q.At
			if ts.IsZero() {
				ts = time.Now()
			}
			lastQuoteAt[key] = ts
		case <-ticker.C:
			opts.streamsMu.Lock()
			for _, key := range pruneStaleStreams(opts.streamMap, lastQuoteAt, time.Now(), streamStaleTimeout) {
				opts.log("info", fmt.Sprintf(
					"arbitration: stream %q expired (no quote in %s); no longer routing to it",
					key, streamStaleTimeout))
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
		}
	}
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

// comparableYield converts a provider quote's yield into the figure the
// arbitration engine compares markets on: revenue **after** the provider's
// fee, which is what the user actually receives.
//
// This mattered more than it looks (fixed session 261). Until then this
// translation passed `q.Yield.SatsPerSecond` — the *gross*, pre-fee rate —
// so every allocation decision compared revenue nobody collects. Fees across
// markets are not close to each other: a mining pool deducts ~1%, a GPU
// compute marketplace ~20%, so comparing gross to gross overstates the
// high-fee market by ~1.24× — enough to route a device to whichever pays it
// less. `provider.Yield.Effective()` had computed the right figure
// (net × confidence) all along and its doc said the arbitration engine used
// it — but nothing in production ever called it. Only one market ships
// today, so the comparison has a single candidate; the conversion stays
// because the fee is still what separates the quoted rate from the rate the
// user is paid.
//
// A quote that leaves NetSatsPerSecond at zero falls back to the gross rate.
// The provider contract says net "equals SatsPerSecond" when there is no
// explicit fee, but a hand-built quote can leave it unset, and silently
// treating such a stream as worthless would be a worse failure than the bug
// this replaces.
func comparableYield(y provider.Yield) arbitration.Yield {
	sats := y.NetSatsPerSecond
	if sats <= 0 {
		sats = y.SatsPerSecond
	}
	return arbitration.Yield{
		SatsPerSecond: sats,
		Confidence:    y.Confidence,
	}
}

// updateStream folds one provider quote into the live streams map,
// keyed by "providerID:deviceID". It returns the key it wrote, so the caller
// can track per-stream freshness for staleness pruning.
func updateStream(mu *sync.Mutex, m map[string]arbitration.Stream, q provider.Quote) string {
	mu.Lock()
	defer mu.Unlock()
	key := q.ProviderID + ":" + q.DeviceID
	existing := m[key]
	existing.ID = arbitration.StreamID(q.ProviderID)
	existing.AcceptsFamilies = q.AcceptedFamilies
	if existing.YieldPerDevice == nil {
		existing.YieldPerDevice = make(map[string]arbitration.Yield)
	}
	if q.DeviceID != "" {
		existing.YieldPerDevice[q.DeviceID] = comparableYield(q.Yield)
	}
	existing.DefaultYield = comparableYield(q.Yield)
	existing.IsBitcoinMining = q.ProviderID == "mining.stratum"
	m[key] = existing
	return key
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
