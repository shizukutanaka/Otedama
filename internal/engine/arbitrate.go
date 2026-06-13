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

// runArbitrationLoop re-evaluates device→stream assignment every 30s,
// or whenever a fresh quote arrives. Blocks until ctx is cancelled or
// the quote channel is closed.
func runArbitrationLoop(ctx context.Context, opts arbitrationLoopOpts) {
	ticker := time.NewTicker(arbitrationInterval)
	defer ticker.Stop()
	var prevAlloc *arbitration.Allocation
	for {
		select {
		case <-ctx.Done():
			return
		case q, ok := <-opts.quoteCh:
			if !ok {
				return
			}
			updateStream(opts.streamsMu, opts.streamMap, q)
		case <-ticker.C:
			opts.streamsMu.Lock()
			streams := streamsSlice(opts.streamMap)
			opts.streamsMu.Unlock()

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
			for _, a := range alloc.Assignments {
				if a.SwitchedFromID != "" {
					opts.metrics.arbitrationSwitches.Inc()
				}
			}
			applyAllocation(alloc, opts.workers, opts.log)
		}
	}
}

// updateStream folds one provider quote into the live streams map,
// keyed by "providerID:deviceID".
func updateStream(mu *sync.Mutex, m map[string]arbitration.Stream, q provider.Quote) {
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
