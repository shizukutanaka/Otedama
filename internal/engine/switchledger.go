// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
)

// ============================================================================
// Switch-verdict ledger — ADR-010 feature A2 groundwork (session 274)
//
// The hysteresis margin already rejects switches below a quoted gain; what
// was missing is any record of whether the switches that DO clear the margin
// actually paid off. Each switch is scored one settle window later by
// comparing the device's realized expected yield against what the stream it
// left currently offers that same device — the counterfactual "had we
// stayed" income. A learned switching cost (A2 proper, and the SCaLE
// direction of RESEARCH Cat 6 #15) then calibrates the margin against real
// churn rate instead of a fixed 5% guess.
//
// Verdict semantics are deliberately narrow: the comparison is between the
// two streams' *reported* yields, so teardown downtime and quote inflation
// are not measured — a switch that "pays off" on quotes may still have cost
// ramp-up time. Honest accounting of that is what the full A2 ledger adds.
// ============================================================================

// switchSettleWindow is how long after a switch its verdict is measured:
// long enough for the new stream's quote to reflect reality, short enough
// that the old stream's current offer is still a fair counterfactual.
const switchSettleWindow = 2 * time.Minute

// pendingSwitchCap bounds the ledger so a pathological quote loop cannot
// grow it without bound; the oldest entries are dropped first.
const pendingSwitchCap = 64

// pendingSwitch is a recorded stream change awaiting its settle window.
type pendingSwitch struct {
	deviceID   string
	fromStream arbitration.StreamID
	toStream   arbitration.StreamID
	at         time.Time
}

// switchVerdict is the outcome class of a settled switch.
type switchVerdict string

const (
	// verdictPaidOff means the device's current realized yield is at least
	// what the stream it left now offers: switching did not lose yield.
	verdictPaidOff switchVerdict = "paid_off"
	// verdictChurn means the stream it left currently offers MORE than the
	// realized yield: the engine would earn more having stayed — the
	// switch was churn the hysteresis margin failed to prevent.
	verdictChurn switchVerdict = "churn"
	// verdictUnverifiable means the old stream no longer exists (provider
	// died or its quote went stale), so no counterfactual offer exists.
	verdictUnverifiable switchVerdict = "unverifiable"
)

// recordSwitches appends pending entries for every assignment that changed
// stream this tick, keeping the ledger under pendingSwitchCap.
func recordSwitches(pending []pendingSwitch, alloc *arbitration.Allocation, now time.Time) []pendingSwitch {
	if alloc == nil {
		return pending
	}
	for _, a := range alloc.Assignments {
		if a.SwitchedFromID == "" {
			continue
		}
		pending = append(pending, pendingSwitch{
			deviceID:   a.DeviceID,
			fromStream: a.SwitchedFromID,
			toStream:   a.Stream,
			at:         now,
		})
	}
	if len(pending) > pendingSwitchCap {
		pending = pending[len(pending)-pendingSwitchCap:]
	}
	return pending
}

// settledSwitch is one scored ledger entry: the device, the streams it
// moved between, the outcome class, and the realized gain (realized yield
// minus the abandoned stream's current offer; negative = churned). gain is
// meaningless for unverifiable verdicts and left at zero there.
type settledSwitch struct {
	device   string
	from, to arbitration.StreamID
	verdict  switchVerdict
	gain     float64
}

// settleVerdicts scores every pending switch older than the window against
// the current allocation and stream set, returning the surviving pending
// list plus one settledSwitch per settled switch.
func settleVerdicts(pending []pendingSwitch, alloc *arbitration.Allocation, streams []arbitration.Stream, now time.Time) (
	keep []pendingSwitch,
	settled []settledSwitch,
) {
	// Streams can repeat the same StreamID — the live map keys streams by
	// providerID:deviceID, so one provider appears once per device it quotes.
	// The counterfactual must therefore be per (stream, device): take the best
	// effective yield any same-ID stream entry offers this device.
	counterfactual := make(map[string]float64, len(streams))
	providerAlive := make(map[arbitration.StreamID]bool, len(streams))
	for _, s := range streams {
		providerAlive[s.ID] = true
		for _, p := range pending {
			if s.ID == p.fromStream {
				if y := s.YieldFor(p.deviceID).Effective(); y > counterfactual[string(s.ID)+"/"+p.deviceID] {
					counterfactual[string(s.ID)+"/"+p.deviceID] = y
				}
			}
		}
	}
	realizedByDevice := make(map[string]float64)
	if alloc != nil {
		for _, a := range alloc.Assignments {
			if a.Idle() {
				realizedByDevice[a.DeviceID] = 0
			} else {
				realizedByDevice[a.DeviceID] = a.ExpectedYield
			}
		}
	}
	for _, p := range pending {
		if now.Sub(p.at) < switchSettleWindow {
			keep = append(keep, p)
			continue
		}
		entry := settledSwitch{device: p.deviceID, from: p.fromStream, to: p.toStream}
		if !providerAlive[p.fromStream] {
			entry.verdict = verdictUnverifiable
		} else {
			entry.gain = realizedByDevice[p.deviceID] - counterfactual[string(p.fromStream)+"/"+p.deviceID]
			if entry.gain < 0 {
				entry.verdict = verdictChurn
			} else {
				entry.verdict = verdictPaidOff
			}
		}
		settled = append(settled, entry)
	}
	return keep, settled
}

// settleLedger is the arbitration-loop hook: record this tick's switches,
// score any that aged past the window, and publish each verdict to metrics
// and the log. Returns the surviving pending list.
func settleLedger(pending []pendingSwitch, alloc *arbitration.Allocation, streams []arbitration.Stream, now time.Time, m *engineMetrics, log func(string, string)) []pendingSwitch {
	pending = recordSwitches(pending, alloc, now)
	keep, settled := settleVerdicts(pending, alloc, streams, now)
	for _, s := range settled {
		m.recordSwitchVerdict(s.verdict, s.gain)
		log("info", describeVerdict(s.device, s.from, s.to, s.verdict, s.gain))
	}
	return keep
}

// describeVerdict renders a settled switch for the log.
func describeVerdict(device string, from, to arbitration.StreamID, v switchVerdict, gain float64) string {
	switch v {
	case verdictChurn:
		return fmt.Sprintf("arbitration: %s switch %s → %s churned (%.2f sat/s below the old stream's current offer)",
			device, from, to, gain)
	case verdictUnverifiable:
		return fmt.Sprintf("arbitration: %s switch %s → %s unverifiable (old stream no longer quotes)",
			device, from, to)
	default:
		return fmt.Sprintf("arbitration: %s switch %s → %s paid off (+%.2f sat/s vs the old stream's current offer)",
			device, from, to, gain)
	}
}
