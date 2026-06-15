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
	metrics       *engineMetrics
	log           func(level, msg string)
	hysteresisPct float64 // 0 uses defaultHysteresisPct
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
			if opts.metrics != nil {
				opts.metrics.activeStreams.Set(float64(len(streams)))
			}

			margin := opts.hysteresisPct
			if margin == 0 {
				margin = defaultHysteresisPct
			}
			alloc, err := arbitration.Decide(arbitration.Input{
				Devices:          opts.devRefs,
				Streams:          streams,
				Previous:         prevAlloc,
				Policy:           arbitration.PolicyMaximizeEarnings,
				HysteresisMargin: margin,
			})
			if err != nil {
				opts.log("warn", fmt.Sprintf("arbitration: %v", err))
				continue
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
		existing.YieldPerDevice[q.DeviceID] = arbitration.Yield{
			SatsPerSecond: q.Yield.SatsPerSecond,
			Confidence:    q.Yield.Confidence,
		}
	}
	existing.DefaultYield = arbitration.Yield{
		SatsPerSecond: q.Yield.SatsPerSecond,
		Confidence:    q.Yield.Confidence,
	}
	existing.IsBitcoinMining = q.ProviderID == "mining.stratum"
	m[key] = existing
	return key
}

// streamsSlice flattens the streams map into a slice, de-duplicated by
// StreamID (the map is keyed per device, the arbitration engine wants
// one entry per stream).
func streamsSlice(m map[string]arbitration.Stream) []arbitration.Stream {
	seen := make(map[arbitration.StreamID]bool)
	var result []arbitration.Stream
	for _, s := range m {
		if !seen[s.ID] {
			seen[s.ID] = true
			result = append(result, s)
		}
	}
	return result
}

// applyAllocation applies a Decide result to the miner workers: pausing
// SHA256d work when a device is idled or switched to AI inference, and
// logging every change of assignment.
func applyAllocation(alloc *arbitration.Allocation, workers []*miner.Worker, log func(string, string)) {
	for _, a := range alloc.Assignments {
		switch {
		case a.Idle():
			// Device has no compatible stream; pause SHA256d to save power.
			for _, w := range workers {
				w.SetWork(nil)
			}
			log("info", fmt.Sprintf("arbitration: %s idle (no compatible stream)", a.DeviceID))

		case a.SwitchedFromID != "":
			// Stream changed. If switching away from mining, signal workers to pause.
			// Switching TO mining re-enables them; the pool connection delivers new work.
			wasAI := strings.HasPrefix(string(a.SwitchedFromID), "ai.")
			nowAI := strings.HasPrefix(string(a.Stream), "ai.")
			switch {
			case !wasAI && nowAI:
				// Mining → AI: pause SHA256d workers.
				for _, w := range workers {
					w.SetWork(nil)
				}
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
