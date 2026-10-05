// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package engine — arbitrate.go
//
// The arbitration loop and its helpers: translating provider quotes
// into arbitration streams, periodically re-running Decide, and
// applying the resulting device→stream allocation to the miner workers.

package engine

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/hal"
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

	// powerWatts/powerPricePerKWh/rateSource, when all set, add a derived
	// profitability floor on top of minYield: the per-device share of the
	// configured power draw is converted to sats/sec at the current BTC/USD
	// rate and arbitration must clear max(minYield, that breakeven) before
	// routing a device to a stream. It is the reward-vs-constraint half of
	// the bi-criteria formulation — yield is maximized only subject to the
	// power-cost constraint (RESEARCH_IMPROVEMENTS Category 6 item 6).
	// rateSource may be nil; the derived floor is then always 0.
	powerWatts       float64
	powerPricePerKWh float64
	rateSource       provider.RateSource

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

	// paused, when non-nil, is the shared per-device pause set rewritten
	// after each Decide: devices whose assignment is idle or routed to a
	// non-mining stream are marked paused so pool job dispatch
	// (updateWork/applyJob) does not re-arm them between ticks. applyAllocation
	// alone only pauses a worker once; without this the next pool job
	// silently undid every arbitration pause (the per-device counterpart
	// of the curtailGate documented in run.go).
	paused *pauseSet
}

// miningStreamPrefix is the StreamID category (provider.go "category.name"
// convention) for streams executed by SHA256d grinding — the only
// assignments under which a device's miner worker may keep working. Any
// other category (ai.* today, future render.*/science.*) means the device
// left mining and must stay paused.
const miningStreamPrefix = "mining."

// allDeviceFamilies is the explicit expansion of provider.Quote's nil
// AcceptedFamilies contract ("all families are accepted") used when
// folding a quote into a Stream.
var allDeviceFamilies = []hal.Family{hal.FamilyASIC, hal.FamilyGPU, hal.FamilyCPU}

// pauseSet tracks device IDs arbitration has currently paused (idle below
// the yield floor, or assigned to a non-mining stream). The arbitration
// loop is the only writer; the pool-session job dispatch reads it.
// The zero value is ready to use.
type pauseSet struct{ m sync.Map }

// Pause records deviceID as arbitration-paused.
func (p *pauseSet) Pause(deviceID string) { p.m.Store(deviceID, struct{}{}) }

// Resume removes deviceID from the paused set.
func (p *pauseSet) Resume(deviceID string) { p.m.Delete(deviceID) }

// Paused reports whether deviceID is currently arbitration-paused.
func (p *pauseSet) Paused(deviceID string) bool {
	_, ok := p.m.Load(deviceID)
	return ok
}

// reconcileArbPauses rewrites the shared pause set to exactly the devices
// whose current assignment is idle or routed to a non-mining stream. It is
// called after every successful Decide, before applyAllocation, so the set
// always mirrors the latest allocation. A nil paused is a no-op (tests).
func reconcileArbPauses(alloc *arbitration.Allocation, paused *pauseSet) {
	if paused == nil || alloc == nil {
		return
	}
	for _, a := range alloc.Assignments {
		if a.Idle() || !strings.HasPrefix(string(a.Stream), miningStreamPrefix) {
			paused.Pause(a.DeviceID)
		} else {
			paused.Resume(a.DeviceID)
		}
	}
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

// powerFloor returns the per-device power-breakeven yield floor in
// sats/sec: the configured system power cost (powerWatts/1000 × price
// $/kWh, in USD/hour) is converted to sats/sec at the current BTC/USD
// rate and split evenly across the devices arbitration manages. Returns
// 0 — no floor — when power data is unconfigured, no rate is available,
// or there are no devices. Splitting evenly is exact for a single-device
// rig and an approximation for heterogeneous multi-device rigs (per-device
// power draw is not yet measured; document power_watts as the dominant
// device's draw if strict per-device gating is needed).
func (o *arbitrationLoopOpts) powerFloor() float64 {
	floor := 0.0
	if o.powerWatts > 0 && o.powerPricePerKWh > 0 && len(o.devRefs) > 0 {
		var rate float64
		if o.rateSource != nil {
			rate, _ = o.rateSource.BTCUSDRate()
		}
		if rate > 0 {
			floor = provider.SatsPerSecond(o.powerWatts/1000*o.powerPricePerKWh, rate) / float64(len(o.devRefs))
		}
	}
	// The gauge mirrors the floor actually applied this round — 0 included —
	// so a dead rate feed or an emptied device list cannot leave a stale
	// positive floor on display while no floor is in force.
	o.metrics.powerBreakevenFloor.Set(floor)
	return floor
}

// runArbitrationLoop re-evaluates device→stream assignment on a fixed
// 30s ticker. A fresh quote only updates the shared stream map (and its
// freshness ledger); the next tick picks it up — Decide is deliberately
// not run per quote so a provider emitting faster than the interval
// cannot drive re-allocation churn. Blocks until ctx is canceled or
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
			key := updateStream(opts.streamsMu, opts.streamMap, &q)
			lastQuoteAt[key] = quoteFreshness(q.At, time.Now())
		case <-ticker.C:
			prevAlloc = arbitrationTick(&opts, lastQuoteAt, prevAlloc)
		}
	}
}

// arbitrationTick runs one arbitration interval: expire stale streams,
// decide the new allocation, publish metrics and the activity map, and
// apply it to the workers. It returns the allocation to carry into the
// next tick as the hysteresis baseline — the previous allocation when
// Decide fails (so a transient error does not reset hysteresis).
func arbitrationTick(opts *arbitrationLoopOpts, lastQuoteAt map[string]time.Time, prevAlloc *arbitration.Allocation) *arbitration.Allocation {
	opts.streamsMu.Lock()
	pruned := pruneStaleStreams(opts.streamMap, lastQuoteAt, time.Now())
	streams := streamsSlice(opts.streamMap)
	opts.streamsMu.Unlock()
	for _, key := range pruned {
		opts.log("info", fmt.Sprintf(
			"arbitration: stream %q expired (no quote in %s); no longer routing to it",
			key, streamStaleTimeout,
		))
	}
	opts.metrics.activeStreams.Set(float64(len(streams)))

	margin := cmp.Or(opts.hysteresisPct, defaultHysteresisPct)
	minYield := opts.minYield
	if pf := opts.powerFloor(); pf > minYield {
		minYield = pf
	}
	alloc, err := arbitration.Decide(&arbitration.Input{
		Devices:            opts.devRefs,
		Streams:            streams,
		Previous:           prevAlloc,
		Policy:             arbitration.PolicyMaximizeEarnings,
		HysteresisMargin:   margin,
		MinYieldSatsPerSec: minYield,
	})
	if err != nil {
		opts.log("warn", fmt.Sprintf("arbitration: %v", err))
		return prevAlloc
	}
	// Capture the previous idle count before overwriting prevAlloc, so a
	// transition can be logged once (not every tick) for operators who
	// watch logs rather than the otedama_devices_idle gauge.
	prevSkipped := 0
	if prevAlloc != nil {
		prevSkipped = prevAlloc.SkippedDevice
	}
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
				"arbitration: %d device(s) now idle (no viable stream, or below the effective profitability floor)",
				alloc.SkippedDevice,
			))
		} else {
			opts.log("info", "arbitration: all devices now have a viable stream")
		}
	}
	// Keep the shared pause set in step with this allocation BEFORE
	// applyAllocation runs: the set is what makes a pause survive the
	// next pool job, so it must reflect the new Decide result even on
	// the tick where the worker gets its one-shot SetWork(nil).
	reconcileArbPauses(alloc, opts.paused)
	applyAllocation(alloc, opts.workers, opts.log, prevAlloc == nil)
	return alloc
}

// quoteFreshness resolves the timestamp a quote contributes to the
// freshness ledger. A zero or future-dated At must not set the clock
// forward: now.Sub(ts) would go negative, so the stream could never
// age out of pruneStaleStreams and a dead provider's quote would keep
// routing devices indefinitely. Extracted as a pure function so the
// clamp is unit-testable without a running loop.
func quoteFreshness(at, now time.Time) time.Time {
	if at.IsZero() || at.After(now) {
		return now
	}
	return at
}

// pruneStaleStreams removes from m (and seen) every stream whose last quote is
// older than streamStaleTimeout, returning the pruned keys. Only entries that have a recorded
// quote time are considered: a stream present in m but absent from seen (e.g.
// pre-seeded directly, never quoted) is never pruned. now is passed in so the
// logic is deterministically testable.
func pruneStaleStreams(m map[string]arbitration.Stream, seen map[string]time.Time, now time.Time) []string {
	var pruned []string
	for key, ts := range seen {
		if now.Sub(ts) > streamStaleTimeout {
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
func updateStream(mu *sync.Mutex, m map[string]arbitration.Stream, q *provider.Quote) string {
	mu.Lock()
	defer mu.Unlock()
	key := q.ProviderID + ":" + q.DeviceID
	existing := m[key]
	existing.ID = arbitration.StreamID(q.ProviderID)
	// provider.Quote documents nil AcceptedFamilies as "all families
	// accepted"; on the Stream a nil AcceptsFamilies would instead
	// reject every family in Accepts(). Translate the contract at
	// the boundary rather than letting the meaning invert.
	if q.AcceptedFamilies != nil {
		existing.AcceptsFamilies = q.AcceptedFamilies
	} else {
		existing.AcceptsFamilies = allDeviceFamilies
	}
	if existing.YieldPerDevice == nil {
		existing.YieldPerDevice = make(map[string]arbitration.Yield)
	}
	// Arbitration compares net yield: provider.go documents
	// NetSatsPerSecond as "SatsPerSecond minus the provider's fee", and
	// provider.Yield.Effective() ("what the arbitration engine uses for
	// comparison") is net-weighted. Copying the gross figure here would
	// drop every provider fee from the decision — Akash's 20% and the
	// pool's 1% alike. A provider that sets no explicit fee leaves
	// NetSatsPerSecond <= 0; then gross is the honest net.
	netSats := q.Yield.NetSatsPerSecond
	if netSats <= 0 {
		netSats = q.Yield.SatsPerSecond
	}
	if q.DeviceID != "" {
		existing.YieldPerDevice[q.DeviceID] = arbitration.Yield{
			SatsPerSecond: netSats,
			Confidence:    q.Yield.Confidence,
		}
	} else {
		// Only a device-agnostic quote sets the stream-wide default; a
		// per-device quote must not leak its price to devices the provider
		// declined to quote — otherwise a device excluded by the provider
		// (e.g. a GPU skipped by the mining provider) silently inherits a
		// sibling device's yield and can be assigned work it cannot do.
		existing.DefaultYield = arbitration.Yield{
			SatsPerSecond: netSats,
			Confidence:    q.Yield.Confidence,
		}
	}
	existing.IsBitcoinMining = strings.HasPrefix(q.ProviderID, miningStreamPrefix)
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
			// updateStream always initializes YieldPerDevice before inserting
			// into the map, so rep.YieldPerDevice is never nil here.
			maps.Copy(rep.YieldPerDevice, s.YieldPerDevice)
			// A provider can also emit one device-agnostic quote; its
			// DefaultYield must survive whichever entry became the rep.
			if rep.DefaultYield == (arbitration.Yield{}) {
				rep.DefaultYield = s.DefaultYield
			}
		} else {
			// Deep-copy to avoid aliasing the YieldPerDevice map inside m.
			cp := s
			if len(s.YieldPerDevice) > 0 {
				ypd := make(map[string]arbitration.Yield, len(s.YieldPerDevice))
				maps.Copy(ypd, s.YieldPerDevice)
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
func applyAllocation(alloc *arbitration.Allocation, workers []*miner.Worker, log func(string, string), firstDecide bool) {
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
			}
		}
	}
	for _, a := range alloc.Assignments {
		switch {
		case a.Idle():
			// Device is idle: no stream accepts its family, or all compatible
			// streams are below the min_yield_sats_per_sec floor. Pause SHA256d
			// unconditionally so the worker stays drained, but log only on the
			// idle *transition*: HeldIdle means it was already idle last Decide,
			// and re-logging the same line every tick would flood the log with
			// one identical line per device per interval (~2880/day at 30s).
			pauseDevice(a.DeviceID)
			if !a.HeldIdle {
				reason := cmp.Or(a.Reason, "no compatible stream")
				log("info", fmt.Sprintf("arbitration: %s idle (%s)", a.DeviceID, reason))
			}

		case a.SwitchedFromID != "":
			// Stream changed. Leaving a mining stream pauses the worker;
			// entering one re-enables it — the pool delivers new work.
			wasMining := strings.HasPrefix(string(a.SwitchedFromID), miningStreamPrefix)
			nowMining := strings.HasPrefix(string(a.Stream), miningStreamPrefix)
			switch {
			case wasMining && !nowMining:
				// Mining → non-mining: pause this device's SHA256d worker.
				pauseDevice(a.DeviceID)
				log("info", fmt.Sprintf("arbitration: %s → %s (%.0f sat/s)",
					a.DeviceID, a.Stream, a.ExpectedYield))
			case !wasMining && nowMining:
				// Non-mining → mining: workers receive new work on next job.
				log("info", fmt.Sprintf("arbitration: %s → mining (%.0f sat/s)",
					a.DeviceID, a.ExpectedYield))
			default:
				log("info", fmt.Sprintf("arbitration: %s switched to %s (%.0f sat/s)",
					a.DeviceID, a.Stream, a.ExpectedYield))
			}

		default:
			// No change; assignment held per hysteresis. On the first
			// Decide there is no previous allocation, so every routed
			// device is itself a transition — log the initial routing
			// once rather than staying silent about it.
			if firstDecide && a.Stream != "" {
				log("info", fmt.Sprintf("arbitration: %s → %s (%.0f sat/s)",
					a.DeviceID, a.Stream, a.ExpectedYield))
			}
		}
	}
}
