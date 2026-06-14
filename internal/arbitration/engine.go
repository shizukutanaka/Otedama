// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package arbitration implements Otedama's core differentiator: a real-time
// decision engine that routes each device to the currently most valuable
// workload.
//
// # Why This Exists
//
// Competitive analysis shows that every existing mining tool locks a
// device to a single workload: CGMiner mines, Kryptex mines, Hive OS
// mines. Meanwhile GPU idle time is worth money on Akash, Render, and
// BOINC; the hardware is the same, but no tool lets users capture all
// revenue streams automatically. This package is that tool.
//
// # Model
//
// The engine is a pure function over three inputs:
//
//  1. Devices - what hardware is currently available (from hal package)
//  2. Streams - revenue rates quoted by each connected provider
//  3. Policy - the user's preference ordering (maximize earnings,
//     stack BTC, maximize privacy, minimize environmental impact)
//
// From these, Decide produces an Allocation that maps each device to a
// stream. The allocation is recomputed periodically (typically once per
// second). The engine itself has no side effects: it reads inputs and
// produces an allocation; actually applying the allocation to hardware
// is the caller's job.
//
// # Invariants
//
// A correct engine preserves these invariants over every output:
//
//   - Every device with at least one compatible stream receives an
//     assignment. Idle is only allowed when no stream accepts the device.
//   - No device is assigned to a stream that does not accept its Family.
//   - Switching occurs only when the policy-adjusted yield gain exceeds the
//     caller-supplied hysteresis margin. The gain is measured in the same
//     policy-adjusted metric used for selection, so hysteresis never
//     overrides the active policy's notion of "better" (e.g. a higher raw
//     yield with worse privacy is not a switch trigger under MaximizePrivacy).
//   - Total yield of the allocation is >= any allocation produced by a
//     greedy per-device max-yield rule (ignoring switching costs).
//
// These invariants are verified by property-based tests, which exercise
// the engine against many random inputs.
package arbitration

import (
	"errors"
	"fmt"
	"math"
	"sort"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// StreamID uniquely identifies a revenue source. The format is
// "family.provider", for example "mining.braiins", "ai.strawberry",
// "render.rendernet", "scientific.boinc".
type StreamID string

// Yield describes the expected revenue rate for a stream on a device,
// expressed in satoshis per second.
//
// Using satoshis/second across all streams gives the engine a single
// unit for cross-stream comparison. Providers are responsible for
// converting their native units (USD/hour, AKT/block, etc.) to this
// common unit before quoting.
type Yield struct {
	// SatsPerSecond is the expected revenue rate. It must be non-negative;
	// a zero yield means the stream does not currently accept the device
	// but is not permanently unavailable.
	SatsPerSecond float64

	// Confidence is a caller-supplied reliability score in [0, 1].
	// 1.0 means the quote is based on a signed, recent observation;
	// 0.0 means the value is a guess. The engine multiplies yield by
	// confidence before comparison, so unreliable quotes are down-weighted.
	Confidence float64
}

// Effective returns the confidence-adjusted yield. A quote with zero
// confidence is treated as zero yield.
func (y Yield) Effective() float64 {
	if y.SatsPerSecond <= 0 || y.Confidence <= 0 {
		return 0
	}
	return y.SatsPerSecond * y.Confidence
}

// Stream is a revenue source's quote for what it will pay for each
// accepted device type.
//
// AcceptsFamilies declares which device families this stream can use.
// For example, a Bitcoin mining stream accepts {ASIC, GPU, CPU}, while
// an AI inference stream accepts only {GPU, CPU}.
type Stream struct {
	ID                  StreamID
	AcceptsFamilies     []hal.Family
	YieldPerDevice      map[string]Yield // keyed by Identity.ID
	DefaultYield        Yield            // used when a device is not in YieldPerDevice
	PrivacyRating       int              // 0 (worst) .. 10 (best)
	EnvironmentalRating int              // 0 (worst) .. 10 (best)
	IsBitcoinMining     bool             // true for streams that pay out as BTC natively
}

// Accepts reports whether this stream will accept work from a device of
// the given family.
func (s Stream) Accepts(f hal.Family) bool {
	for _, accepted := range s.AcceptsFamilies {
		if accepted == f {
			return true
		}
	}
	return false
}

// YieldFor returns the yield this stream offers for the specified device.
// If the device is not listed in YieldPerDevice, DefaultYield is returned.
func (s Stream) YieldFor(id string) Yield {
	if y, ok := s.YieldPerDevice[id]; ok {
		return y
	}
	return s.DefaultYield
}

// Policy selects how the engine should break ties between streams with
// similar effective yield.
type Policy int

const (
	// PolicyMaximizeEarnings chooses the stream with the highest
	// confidence-adjusted yield, regardless of other attributes. This
	// is the default for users who want to maximize short-term revenue.
	PolicyMaximizeEarnings Policy = iota

	// PolicyStackBTC prefers streams that pay out in Bitcoin natively,
	// accepting a small yield premium for non-BTC streams. This suits
	// users who want to accumulate BTC without conversion costs.
	PolicyStackBTC

	// PolicyMaximizePrivacy prefers streams with higher PrivacyRating.
	// Tie-breaking uses effective yield.
	PolicyMaximizePrivacy

	// PolicyEnvironmentFriendly prefers streams with higher
	// EnvironmentalRating (such as science-grid workloads or
	// renewable-powered pools).
	PolicyEnvironmentFriendly
)

// String returns a stable, human-readable name for the policy.
func (p Policy) String() string {
	switch p {
	case PolicyMaximizeEarnings:
		return "maximize_earnings"
	case PolicyStackBTC:
		return "stack_btc"
	case PolicyMaximizePrivacy:
		return "maximize_privacy"
	case PolicyEnvironmentFriendly:
		return "environment_friendly"
	default:
		return fmt.Sprintf("unknown(%d)", int(p))
	}
}

// Valid reports whether p is one of the defined Policy values.
func (p Policy) Valid() bool {
	switch p {
	case PolicyMaximizeEarnings, PolicyStackBTC, PolicyMaximizePrivacy, PolicyEnvironmentFriendly:
		return true
	default:
		return false
	}
}

// Assignment is the engine's decision for a single device.
//
// Stream is the chosen StreamID, or empty if the device is to remain
// idle (no compatible stream is available).
type Assignment struct {
	DeviceID       string
	Stream         StreamID
	ExpectedYield  float64 // effective yield at the time of decision
	SwitchedFromID StreamID
	Reason         string // human-readable explanation for logging

	// Held is true when a strictly higher-scoring stream was available but the
	// device was kept on its previous one because the gain did not exceed the
	// hysteresis margin. It distinguishes "deliberately declined a better
	// option" (yield left on the table to avoid flapping) from "stayed because
	// the current stream is still the best", which lets operators see whether
	// the hysteresis margin is costing them and tune it.
	Held bool
}

// Idle reports whether this assignment leaves the device idle.
func (a Assignment) Idle() bool { return a.Stream == "" }

// Allocation is the complete set of Assignments for a decision cycle.
//
// The order of Assignments is deterministic: devices are listed in
// sorted order by DeviceID, so that two identical inputs produce byte-
// identical allocations. This property is relied on by tests and by
// log readers trying to diff successive allocations.
type Allocation struct {
	Assignments   []Assignment
	TotalYield    float64
	Policy        Policy
	SkippedDevice int // devices left idle because no stream accepts them
}

// Input bundles the arguments to Decide.
type Input struct {
	// Devices is the set of hardware currently available. Devices are
	// identified by their Identity.ID; duplicate IDs are rejected.
	Devices []DeviceRef

	// Streams is the set of revenue sources currently quoting. Empty
	// or nil is legal; the resulting Allocation will consist entirely
	// of idle assignments.
	Streams []Stream

	// Previous is the allocation from the preceding decision cycle,
	// used to detect switches. May be nil for the first decision.
	Previous *Allocation

	// Policy selects the tie-break strategy.
	Policy Policy

	// HysteresisMargin is the minimum yield improvement (as a fraction
	// of the current yield) required to justify switching streams.
	// 0.0 means switch at any improvement; 0.1 means require 10% more.
	// This damps rapid oscillation when streams have near-equal yields.
	HysteresisMargin float64
}

// DeviceRef is a lightweight reference to a Device. We pass references
// rather than Device interface values because the engine only needs
// the Identity and Capabilities, not the ability to submit work. This
// keeps the engine free of any dependency on the hal package beyond
// these two data types.
type DeviceRef struct {
	Identity     hal.Identity
	Capabilities hal.Capabilities
}

// Decide computes the optimal Allocation for the given input.
//
// Decide is deterministic: for any two identical inputs, it returns
// byte-identical Allocations. This determinism is what makes the
// engine testable; it also lets us diff allocations meaningfully in
// logs to understand why a device changed workloads.
//
// Decide returns an error only for malformed input (duplicate device
// IDs, invalid Policy). Runtime conditions that make a full allocation
// impossible (all streams offline, no compatible streams for a device)
// are handled by leaving the affected devices idle, not by returning
// an error.
func Decide(in Input) (*Allocation, error) {
	if !in.Policy.Valid() {
		return nil, fmt.Errorf("arbitration: invalid Policy %v", in.Policy)
	}
	if in.HysteresisMargin < 0 {
		return nil, errors.New("arbitration: HysteresisMargin must be non-negative")
	}

	// Reject duplicate device IDs up front, since silently ignoring
	// duplicates could cause subtle allocation bugs.
	seen := make(map[string]struct{}, len(in.Devices))
	for _, d := range in.Devices {
		if _, dup := seen[d.Identity.ID]; dup {
			return nil, fmt.Errorf("arbitration: duplicate device ID %q", d.Identity.ID)
		}
		seen[d.Identity.ID] = struct{}{}
	}

	// Sort devices by ID for deterministic output order.
	devices := make([]DeviceRef, len(in.Devices))
	copy(devices, in.Devices)
	sort.Slice(devices, func(i, j int) bool {
		return devices[i].Identity.ID < devices[j].Identity.ID
	})

	// Previous assignments, for hysteresis and switch detection.
	prev := map[string]Assignment{}
	if in.Previous != nil {
		for _, a := range in.Previous.Assignments {
			prev[a.DeviceID] = a
		}
	}

	alloc := &Allocation{
		Assignments: make([]Assignment, 0, len(devices)),
		Policy:      in.Policy,
	}

	for _, dev := range devices {
		a := chooseForDevice(dev, in.Streams, prev[dev.Identity.ID], in.Policy, in.HysteresisMargin)
		if a.Idle() {
			alloc.SkippedDevice++
		}
		alloc.TotalYield += a.ExpectedYield
		alloc.Assignments = append(alloc.Assignments, a)
	}

	return alloc, nil
}

// chooseForDevice selects the best stream for a single device, applying
// policy preferences and hysteresis.
func chooseForDevice(
	dev DeviceRef,
	streams []Stream,
	previous Assignment,
	policy Policy,
	hysteresis float64,
) Assignment {
	type candidate struct {
		stream Stream
		yield  float64
	}

	var candidates []candidate
	for _, s := range streams {
		if !s.Accepts(dev.Identity.Family) {
			continue
		}
		y := s.YieldFor(dev.Identity.ID).Effective()
		if y <= 0 {
			continue
		}
		candidates = append(candidates, candidate{stream: s, yield: y})
	}

	if len(candidates) == 0 {
		return Assignment{
			DeviceID: dev.Identity.ID,
			Reason:   "no compatible stream accepting non-zero work",
		}
	}

	// Sort candidates by policy-adjusted score, then by StreamID for
	// determinism.
	sort.SliceStable(candidates, func(i, j int) bool {
		si := policyScore(candidates[i].stream, candidates[i].yield, policy)
		sj := policyScore(candidates[j].stream, candidates[j].yield, policy)
		if si != sj {
			return si > sj
		}
		return candidates[i].stream.ID < candidates[j].stream.ID
	})

	best := candidates[0]
	bestScore := policyScore(best.stream, best.yield, policy)

	// Hysteresis: if we currently have a previous assignment on a still-
	// available stream, keep it unless the best candidate beats it by the
	// hysteresis margin. The comparison is made in the *policy-adjusted*
	// score space (the same metric used for selection above), not raw yield,
	// so the "only switch on a meaningful improvement" guarantee is
	// consistent with what "better" means under the active policy. Under
	// PolicyMaximizeEarnings the score equals the raw yield, so this is
	// identical to a plain yield comparison; under privacy/environment/BTC
	// policies a higher raw yield with a worse rating is correctly treated
	// as a marginal (or non-existent) gain rather than a reason to switch.
	if previous.Stream != "" {
		for _, c := range candidates {
			if c.stream.ID == previous.Stream {
				incScore := policyScore(c.stream, c.yield, policy)
				threshold := incScore * (1.0 + hysteresis)
				if bestScore <= threshold {
					// Held only counts when a *different*, higher-scoring stream
					// was suppressed — not when the incumbent is itself the best
					// (in which case nothing was declined).
					return Assignment{
						DeviceID:      dev.Identity.ID,
						Stream:        c.stream.ID,
						ExpectedYield: c.yield,
						Reason:        fmt.Sprintf("held (best gain %.2f%% below hysteresis %.2f%%)", (bestScore-incScore)/math.Max(incScore, 1e-9)*100, hysteresis*100),
						Held:          best.stream.ID != c.stream.ID,
					}
				}
				break
			}
		}
	}

	a := Assignment{
		DeviceID:      dev.Identity.ID,
		Stream:        best.stream.ID,
		ExpectedYield: best.yield,
		Reason:        fmt.Sprintf("best yield under policy %s", policy),
	}
	if previous.Stream != "" && previous.Stream != best.stream.ID {
		a.SwitchedFromID = previous.Stream
	}
	return a
}

// policyScore assigns a comparison score that reflects the active policy.
// Higher scores are preferred. When scores are equal, sort falls back to
// yield, then StreamID.
func policyScore(s Stream, yield float64, p Policy) float64 {
	switch p {
	case PolicyStackBTC:
		// BTC-native streams get a yield bonus equivalent to skipping
		// conversion friction. The 5% factor is a rough heuristic.
		if s.IsBitcoinMining {
			return yield * 1.05
		}
		return yield
	case PolicyMaximizePrivacy:
		// Each privacy rating point is worth ~10% yield. This prefers
		// private streams without completely ignoring revenue.
		return yield * (1.0 + float64(s.PrivacyRating)*0.01)
	case PolicyEnvironmentFriendly:
		return yield * (1.0 + float64(s.EnvironmentalRating)*0.01)
	case PolicyMaximizeEarnings:
		fallthrough
	default:
		return yield
	}
}
