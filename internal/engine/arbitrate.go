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
	"sort"
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
	policy        arbitration.Policy

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
	// activityIdle, when non-nil, receives the same snapshot's
	// SkippedDevice count (devices left idle by the profitability
	// floor) so buildStats can populate Stats.DevicesIdle — the gauge
	// and log already see it, but the TUI field stayed 0 forever
	// without this wire. Written alongside the gauge update.
	activityIdle *atomic.Int64
}

// defaultHysteresisPct matches the default in config.Defaults().
const defaultHysteresisPct = 0.05

// streamStaleTimeout is how long a provider's quote remains usable after it
// was received. Providers re-quote every 30s (mining) / 60s (AI), so a
// provider that has sent no quote within this window is treated as dead and
// its stream is dropped from arbitration — otherwise a crashed or partitioned
// provider's last quote would route devices to a revenue source that no longer
// exists (RESEARCH_IMPROVEMENTS Category 5 item 3). The window is generous
// (3–6× the quote cadence) so ordinary jitter never prunes a live provider.
// A var (not const) so tests can shrink it deterministically.
var streamStaleTimeout = 3 * time.Minute

// arbitrationPolicyFromConfig maps the configured policy name to an
// arbitration.Policy. Config.Validate rejects unknown names, so an
// unrecognised value can only arrive when validation was skipped — fall back
// to the default rather than passing an invalid Policy to Decide.
func arbitrationPolicyFromConfig(name string) arbitration.Policy {
	if p, ok := arbitration.ParsePolicy(name); ok {
		return p
	}
	return arbitration.PolicyMaximizeEarnings
}

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
	// idleSeen records the reason each device was last logged idle under,
	// so a device that stays idle for many ticks does not repeat the same
	// "N idle (reason)" line every 30s forever. Entries are removed when
	// the device leaves the idle state, so a later re-idle logs again.
	idleSeen := make(map[string]string)
	for {
		select {
		case <-ctx.Done():
			return
		case q, ok := <-opts.quoteCh:
			if !ok {
				return
			}
			key := updateStream(opts.streamsMu, opts.streamMap, q)
			// Freshness is recorded by RECEIPT time, not the provider's own
			// q.At timestamp: a provider that keeps emitting stale backdated
			// quotes would otherwise be pruned on every tick while still
			// alive (expired→re-added→expired log spam), and a future
			// timestamp would never be pruned at all. Staleness means "we
			// have not heard recently", so receipt is the correct clock.
			lastQuoteAt[key] = time.Now()
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
				Policy:             opts.policy,
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
			if opts.activityIdle != nil {
				opts.activityIdle.Store(int64(alloc.SkippedDevice))
			}
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
			applyAllocation(alloc, opts.workers, opts.log, idleSeen)
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
	// arbitration.Yield.SatsPerSecond must carry the provider's *net*
	// rate: provider.Yield documents Effective() — net × confidence — as
	// "what the arbitration engine uses for comparison". Copying the
	// gross rate instead would silently discard provider fees (mining
	// pool ~1%, Akash platform ~20%), inflating every quote by its fee
	// share and biasing switches toward the higher-fee stream. A
	// provider that leaves NetSatsPerSecond unset falls back to its
	// gross figure (the Yield doc defines that as "no explicit fee").
	net := q.Yield.NetSatsPerSecond
	if net <= 0 {
		net = q.Yield.SatsPerSecond
	}
	key := q.ProviderID + ":" + q.DeviceID
	existing := m[key]
	existing.ID = arbitration.StreamID(q.ProviderID)
	existing.AcceptsFamilies = q.AcceptedFamilies
	existing.PreemptionRisk = q.PreemptionRisk
	if existing.YieldPerDevice == nil {
		existing.YieldPerDevice = make(map[string]arbitration.Yield)
	}
	if q.DeviceID != "" {
		existing.YieldPerDevice[q.DeviceID] = arbitration.Yield{
			SatsPerSecond: net,
			Confidence:    q.Yield.Confidence,
		}
	}
	existing.DefaultYield = arbitration.Yield{
		SatsPerSecond: net,
		Confidence:    q.Yield.Confidence,
	}
	existing.IsBitcoinMining = q.ProviderID == provider.MiningProviderID
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
//
// The map is iterated in sorted key order for two reasons. First, the
// representative's DefaultYield must be deterministic: the wildcard entry
// ("providerID:", produced when a provider quotes one figure for every
// compatible device) carries the provider-declared default, and sorting
// keys makes it win the representative slot — an arbitrary map-iteration
// pick could instead promote a device-scoped quote as the fallback figure
// for every other device, nondeterministically. Second, a deterministic
// result order makes tests and debug output stable.
func streamsSlice(m map[string]arbitration.Stream) []arbitration.Stream {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	merged := make(map[arbitration.StreamID]*arbitration.Stream, len(m))
	for _, k := range keys {
		s := m[k]
		if rep, ok := merged[s.ID]; ok {
			// Merge YieldPerDevice from this entry into the representative so
			// the arbitration engine has per-device yields for every device, not
			// just whichever map entry happened to be iterated first.
			// updateStream always initialises YieldPerDevice before inserting
			// into the map, so rep.YieldPerDevice is never nil today — but a
			// directly-seeded representative could have a nil map, which the
			// writes below would panic on, so allocate it defensively.
			if rep.YieldPerDevice == nil && len(s.YieldPerDevice) > 0 {
				rep.YieldPerDevice = make(map[string]arbitration.Yield, len(s.YieldPerDevice))
			}
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
//
// idleSeen optionally deduplicates the per-device idle log line across
// calls: keyed by device ID and valued at the last reason logged, so a
// device that remains idle for many arbitration ticks logs once per
// distinct reason instead of every 30s. Entries for non-idle devices are
// removed, so a re-idle logs again. Callers that pass no map keep the
// log-every-call behaviour (tests). At most one map is honoured.
func applyAllocation(alloc *arbitration.Allocation, workers []*miner.Worker, log func(string, string), idleSeen ...map[string]string) {
	var seen map[string]string
	if len(idleSeen) > 0 {
		seen = idleSeen[0]
	}
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
				// SetPaused, not bare SetWork(nil): a cleared work is undone
				// by the next pool-delivered job, which applyJob pushes to
				// every worker — the arbitration decision would silently
				// stop applying seconds later. Paused workers are skipped
				// by job delivery until resumed.
				w.SetPaused(true)
				return
			}
		}
	}
	resumeDevice := func(deviceID string) {
		for _, w := range workers {
			if w.DeviceID() == deviceID {
				w.SetPaused(false)
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
			if seen != nil {
				if seen[a.DeviceID] == reason {
					continue
				}
				seen[a.DeviceID] = reason
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
				// AI → Mining: lift the pause; the worker picks up the next
				// pool-delivered job (delivery skips it until then anyway
				// because its work was cleared when paused).
				resumeDevice(a.DeviceID)
				log("info", fmt.Sprintf("arbitration: %s → mining (%.0f sat/s)",
					a.DeviceID, a.ExpectedYield))
			default:
				log("info", fmt.Sprintf("arbitration: %s switched to %s (%.0f sat/s)",
					a.DeviceID, a.Stream, a.ExpectedYield))
			}

		default:
			// No recorded switch. Two cases reach here: a plain hold, and
			// an idle→assigned transition (idle assignments carry no
			// Stream, so SwitchedFromID is empty and the switch above is
			// skipped). A device that was paused while idle and is now
			// routed back to a mining stream must be resumed — otherwise
			// it stays paused forever. Non-"ai." streams are the mining
			// family (only SHA256d consumers); resuming an unpaused worker
			// is a no-op.
			if !strings.HasPrefix(string(a.Stream), "ai.") {
				resumeDevice(a.DeviceID)
			}
		}
		if seen != nil && !a.Idle() {
			delete(seen, a.DeviceID)
		}
	}
}
