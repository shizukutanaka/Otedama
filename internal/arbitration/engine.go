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
//     assignment. Idle is only allowed when no stream accepts the device, or
//     when no accepting stream clears the MinYieldSatsPerSec profitability floor.
//   - No device is assigned to a stream that does not accept its Family.
//   - Switching occurs only when the policy-adjusted yield gain exceeds the
//     caller-supplied hysteresis margin. The gain is measured in the same
//     policy-adjusted metric used for selection, so hysteresis never
//     overrides the active policy's notion of "better" (e.g. a higher raw
//     yield with worse privacy is not a switch trigger under MaximizePrivacy).
//   - Under PolicyMaximizeEarnings with no hysteresis, total yield equals
//     the optimal per-device greedy maximum. Other policies deliberately
//     accept lower raw yield in exchange for BTC-native payment, privacy,
//     or environmental preference; raw TotalYield may therefore be less than
//     the greedy maximum under those policies.
//   - TotalYield equals the sum of ExpectedYield across all Assignments.
//   - ForegoneSatsPerSec is always >= 0 for every Assignment.
//
// These invariants are verified by property-based tests, which exercise
// the engine against many random inputs.
package arbitration

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"slices"

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

	// Confirmed is set once the provider has supplied at least
	// ConfirmationEpochs quotes within the process lifetime (ADR-010 A7's
	// confirmation ladder). An unconfirmed stream can still claim an idle
	// device on merit, but it cannot displace a confirmed incumbent — a
	// yield-lure stream that quotes high for its first few cycles to
	// trigger a switch is held regardless of how far above the hysteresis
	// threshold it scores.
	Confirmed bool

	// VolatilityPerDevice is the sample stddev of each device's realized
	// yield on this stream — the dispersion input of ADR-010 A5's modified
	// Sharpe score under IncomeModeSmooth/Balanced. Keyed by Identity.ID
	// like YieldPerDevice; absent entries mean "no risk measured yet",
	// which smooth modes treat as unproven risk (Sharpe 0), not zero risk.
	VolatilityPerDevice map[string]float64

	// Simulated marks the stream's yield as modeled rather than observed
	// market data (the provider still quotes estimated prices, not live
	// ones — e.g. the simulated Akash provider). Decide treats it like
	// any other candidate; the flag exists so accounting can split
	// simulated revenue out of real-earnings aggregates rather than
	// silently mixing the two.
	Simulated bool

	// MinMemoryBytes is the minimum dedicated memory (VRAM) a device must
	// report to qualify for this stream — e.g. an inference workload
	// whose model does not fit below a threshold. 0 (the default) means
	// no memory requirement. Devices that report no memory figure
	// (Capabilities.MemoryBytes == 0 — NVIDIA proprietary driver,
	// integrated GPUs) are treated as *unknown* and are NOT excluded:
	// the requirement only rejects devices positively known to be too
	// small, it never guesses at unreported capacity.
	MinMemoryBytes int64
}

// Accepts reports whether this stream will accept work from a device of
// the given family.
func (s *Stream) Accepts(f hal.Family) bool {
	return slices.Contains(s.AcceptsFamilies, f)
}

// SuitableFor reports whether this stream can use the given device: its
// family is accepted AND, when the stream declares a MinMemoryBytes
// requirement, the device either meets it or reports no memory figure
// (unknown capacity is not a rejection — only positively-too-small is).
func (s *Stream) SuitableFor(dev *DeviceRef) bool {
	if !s.Accepts(dev.Identity.Family) {
		return false
	}
	if s.MinMemoryBytes > 0 && dev.Capabilities.MemoryBytes > 0 &&
		dev.Capabilities.MemoryBytes < s.MinMemoryBytes {
		return false
	}
	return true
}

// YieldFor returns the yield this stream offers for the specified device.
// If the device is not listed in YieldPerDevice, DefaultYield is returned.
func (s *Stream) YieldFor(id string) Yield {
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

	// Held is true when a different, same-or-higher-scoring stream was
	// available but the device was kept on its previous one because the gain
	// (if any) did not strictly exceed the hysteresis margin — this includes
	// the exact-tie case, where a different stream scored identically and no
	// yield was actually left on the table, not just the case where a
	// strictly better stream was suppressed. It distinguishes "a candidate
	// other than the incumbent was in play" from "stayed because the current
	// stream is unambiguously the best", which lets operators see whether the
	// hysteresis margin is costing them and tune it.
	Held bool

	// ForegoneSatsPerSec is the raw revenue (satoshis/second) sacrificed by
	// this assignment relative to pure yield maximization: the highest raw
	// effective yield among all streams compatible with this device, minus the
	// yield of the stream actually assigned. It is always >= 0 and quantifies
	// the *magnitude* of every deliberate deviation from max-earnings —
	// hysteresis holds and non-earnings policies (privacy/environment/BTC) both
	// surface here. Zero under PolicyMaximizeEarnings with no hold. Where Held
	// counts that a better option was declined, this measures how much it cost.
	ForegoneSatsPerSec float64

	// ForegoneStreamID identifies the stream that produced ForegoneSatsPerSec's
	// reference point — the highest raw effective yield among this device's
	// compatible streams — when that stream differs from the one assigned.
	// Empty when the assigned stream is itself the raw-max candidate (nothing
	// was declined, only the same option kept). It answers "which stream was
	// declined" for explainability (ADR-010 A9's reasoning text), where
	// ForegoneSatsPerSec answers "how much was declined".
	ForegoneStreamID StreamID

	// AwaitingConfirmation is true when the assignment is a hysteresis hold
	// whose suppressed best candidate was an unconfirmed stream — the ladder
	// (not the margin) kept the incumbent. It distinguishes "declined for
	// stability" from "declined because the challenger hasn't proven
	// ConfirmationEpochs quotes yet" so operators can see the lure defense
	// working (ote­dama_arbitration_confirmation_holds_total).
	AwaitingConfirmation bool
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
	SkippedDevice int // devices left idle: no compatible stream accepts them, or none clears the MinYieldSatsPerSec floor
}

// IncomeMode selects the decision criterion applied to stream yields
// (ADR-010 A5). Max picks the highest expected yield; Smooth picks the
// highest modified Sharpe (yield minus the min-yield floor, over the
// realized-yield stddev); Balanced blends normalized yield and Sharpe
// half-and-half.
type IncomeMode int

const (
	// IncomeModeMax maximizes expected yield — the default and the
	// pre-A5 behavior.
	IncomeModeMax IncomeMode = iota
	// IncomeModeSmooth maximizes the modified Sharpe ratio: high
	// *steady* income preferred over high but spiky income.
	IncomeModeSmooth
	// IncomeModeBalanced scores 0.5·normalized-yield + 0.5·normalized-
	// Sharpe across the device's candidate set — ADR-010's "0.5 × mean +
	// 0.5 × Sharpe" compromise between the two extremes.
	IncomeModeBalanced
)

// String returns the config-file spelling of the mode.
func (m IncomeMode) String() string {
	switch m {
	case IncomeModeSmooth:
		return "smooth"
	case IncomeModeBalanced:
		return "balanced"
	default:
		return "max"
	}
}

// ParseIncomeMode maps a config string ("", "max", "smooth",
// "balanced") to its mode; "" resolves to Max so an unset field is the
// unchanged default.
func ParseIncomeMode(s string) (IncomeMode, error) {
	switch s {
	case "", "max":
		return IncomeModeMax, nil
	case "smooth":
		return IncomeModeSmooth, nil
	case "balanced":
		return IncomeModeBalanced, nil
	default:
		return IncomeModeMax, fmt.Errorf("arbitration: unknown income_mode %q", s)
	}
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

	// MinYieldSatsPerSec is an absolute profitability floor: a stream is a
	// viable candidate for a device only if its confidence-adjusted yield is at
	// least this many satoshis per second. Streams below the floor are treated
	// as if they did not accept the device, so a device whose every compatible
	// stream is below the floor is left idle rather than run for a trickle of
	// revenue (which still costs power, wear, and heat).
	//
	// It is the per-device counterpart to the engine-level curtail_below_btc_usd
	// switch: curtailment pauses everything on a global BTC-price threshold,
	// whereas this idles only the individual devices that cannot clear the floor.
	// 0 (the default) disables the floor — every positive-yield stream qualifies,
	// exactly as before this field existed. Must be non-negative.
	MinYieldSatsPerSec float64

	// IncomeMode selects the decision criterion (ADR-010 A5): the
	// zero value IncomeModeMax keeps the pre-A5 "highest expected yield"
	// behavior; Smooth and Balanced fold the realized-yield dispersion
	// (Stream.VolatilityPerDevice) into the comparison score.
	IncomeMode IncomeMode
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
	if in.MinYieldSatsPerSec < 0 {
		return nil, errors.New("arbitration: MinYieldSatsPerSec must be non-negative")
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
	slices.SortFunc(devices, func(a, b DeviceRef) int {
		return cmp.Compare(a.Identity.ID, b.Identity.ID)
	})

	// Previous assignments, for hysteresis and switch detection.
	prev := map[string]Assignment{}
	if in.Previous != nil {
		for _, a := range in.Previous.Assignments {
			prev[a.DeviceID] = a
		}
	}

	mode := in.IncomeMode // zero value (Max) is the pre-A5 behavior

	alloc := &Allocation{
		Assignments: make([]Assignment, 0, len(devices)),
		Policy:      in.Policy,
	}

	for _, dev := range devices {
		a := chooseForDevice(dev, in.Streams, prev[dev.Identity.ID], in.Policy, in.HysteresisMargin, in.MinYieldSatsPerSec, mode)
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
	minYield float64,
	mode IncomeMode,
) Assignment {
	// belowFloor records whether at least one stream accepted this device with a
	// positive yield that nonetheless failed the minYield floor. It lets the idle
	// reason distinguish "nothing wanted this device" from "the work on offer was
	// not worth running", which is actionable for an operator tuning the floor.
	var candidates []candidate
	var belowFloor bool
	for _, s := range streams {
		if !s.SuitableFor(&dev) {
			continue
		}
		y := s.YieldFor(dev.Identity.ID).Effective()
		if y <= 0 {
			continue
		}
		if y < minYield {
			belowFloor = true
			continue
		}
		candidates = append(candidates, candidate{stream: s, yield: y, idx: len(candidates)})
	}

	if len(candidates) == 0 {
		reason := "no compatible stream accepting non-zero work"
		if belowFloor {
			reason = fmt.Sprintf("all compatible streams below minimum yield floor %.4g sats/s", minYield)
		}
		return Assignment{
			DeviceID: dev.Identity.ID,
			Reason:   reason,
		}
	}

	// maxRaw is the highest raw effective yield among compatible streams,
	// independent of policy. It is the reference point for ForegoneSatsPerSec:
	// the most this device could earn if routed purely by yield. Computed
	// before the policy sort so it reflects raw yield, not policy score.
	// maxRawStream records which stream produced it — the identity of "the
	// best declined alternative" for ForegoneStreamID.
	maxRaw := candidates[0].yield
	maxRawStream := candidates[0].stream.ID
	for _, c := range candidates[1:] {
		if c.yield > maxRaw {
			maxRaw = c.yield
			maxRawStream = c.stream.ID
		}
	}

	// ADR-010 A5: under a non-Max income mode the comparison value is the
	// modified Sharpe (smooth) or a normalized blend (balanced) instead of
	// raw yield. adj[i] is indexed by candidate.idx — see incomeScores.
	adj := incomeScores(candidates, dev.Identity.ID, minYield, mode)

	// Sort candidates by policy-adjusted score (descending), then by StreamID for
	// determinism.
	slices.SortStableFunc(candidates, func(a, b candidate) int {
		sa := policyScore(a.stream, adj[a.idx], policy)
		sb := policyScore(b.stream, adj[b.idx], policy)
		if sa != sb {
			return cmp.Compare(sb, sa) // descending: higher score first
		}
		return cmp.Compare(a.stream.ID, b.stream.ID)
	})

	best := candidates[0]
	bestScore := policyScore(best.stream, adj[best.idx], policy)

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
				incScore := policyScore(c.stream, adj[c.idx], policy)
				threshold := incScore * (1.0 + hysteresis)
				// ADR-010 A7's confirmation ladder: an unconfirmed challenger
				// cannot fast-track past a confirmed incumbent however far
				// above the hysteresis threshold it scores — the lure has to
				// sustain its quote for ConfirmationEpochs cycles first. An
				// unconfirmed incumbent enjoys no such protection (two fresh
				// streams trade freely on the usual margin).
				awaitingConfirm := c.stream.Confirmed && !best.stream.Confirmed
				if bestScore <= threshold || awaitingConfirm {
					// Held only counts when a *different*, higher-scoring stream
					// was suppressed — not when the incumbent is itself the best
					// (in which case nothing was declined).
					held := best.stream.ID != c.stream.ID
					var reason string
					switch {
					case held && awaitingConfirm:
						reason = fmt.Sprintf("held (challenger %s awaiting %d quote confirmations)", best.stream.ID, ConfirmationEpochs)
					case held:
						reason = fmt.Sprintf("held (best gain %.2f%% below hysteresis %.2f%%)", (bestScore-incScore)/math.Max(incScore, 1e-9)*100, hysteresis*100)
					default:
						reason = "incumbent is best; stayed"
					}
					foregoneID := StreamID("")
					if maxRawStream != c.stream.ID {
						foregoneID = maxRawStream
					}
					return Assignment{
						DeviceID:             dev.Identity.ID,
						Stream:               c.stream.ID,
						ExpectedYield:        c.yield,
						Reason:               reason,
						Held:                 held,
						AwaitingConfirmation: held && awaitingConfirm,
						ForegoneSatsPerSec:   maxRaw - c.yield,
						ForegoneStreamID:     foregoneID,
					}
				}
				break
			}
		}
	}

	reason := fmt.Sprintf("best yield under policy %s", policy)
	if mode != IncomeModeMax {
		reason = fmt.Sprintf("best %s score under policy %s", mode, policy)
	}
	a := Assignment{
		DeviceID:           dev.Identity.ID,
		Stream:             best.stream.ID,
		ExpectedYield:      best.yield,
		Reason:             reason,
		ForegoneSatsPerSec: maxRaw - best.yield,
	}
	if maxRawStream != best.stream.ID {
		a.ForegoneStreamID = maxRawStream
	}
	if previous.Stream != "" && previous.Stream != best.stream.ID {
		a.SwitchedFromID = previous.Stream
	}
	return a
}

// ConfirmationEpochs is the number of quotes a provider must supply before
// one of its streams may displace a confirmed incumbent (ADR-010 A7's
// confirmation ladder, after Lykouris, Mirrokni & Paes Leme's bounded-arm
// defense). Three ticks ≈ 90 s at the 30 s arbitration cadence: short enough
// that honest providers clear it quickly, long enough that a lure must
// sustain its inflated quote — and accrue real epoch observations to the
// reliability posterior — before it can cause a switch.
const ConfirmationEpochs = 3

// frac is x/d with a 0 default for d<=0 — the balanced mode's normalized
// terms collapse gracefully when a whole candidate set shares one scale
// value (e.g. all Sharpe scores 0 before any volatility history exists).
func frac(x, d float64) float64 {
	if d <= 0 {
		return 0
	}
	return x / d
}

// candidate pairs a stream with its raw effective yield for one device;
// idx preserves the candidate's slot in the income-adjusted score table
// (incomeScores output) across the policy sort.
type candidate struct {
	stream Stream
	yield  float64
	idx    int
}

// incomeScores computes the per-candidate comparison value Decide sorts
// on (ADR-010 A5). sharpes[i] is (yield_i − minYield)/σ_i with σ_i the
// stream's realized-yield stddev for this device; a candidate with no
// volatility history scores Sharpe 0 (unproven risk treated as maximal).
// A measured-but-constant stream (σ=0) gets a very large Sharpe — the
// risk-free-rate case, faithfully dominating noisy alternatives. Under
// IncomeModeMax (the default) the result is the raw yield itself, so the
// pre-A5 semantics are preserved exactly.
func incomeScores(candidates []candidate, deviceID string, minYield float64, mode IncomeMode) []float64 {
	sharpes := make([]float64, len(candidates))
	adj := make([]float64, len(candidates))
	maxY, maxS := 0.0, 0.0
	for i, c := range candidates {
		if std, ok := c.stream.VolatilityPerDevice[deviceID]; ok {
			sharpes[i] = (c.yield - minYield) / math.Max(std, 1e-9)
		}
		if c.yield > maxY {
			maxY = c.yield
		}
		if sharpes[i] > maxS {
			maxS = sharpes[i]
		}
	}
	for i, c := range candidates {
		switch mode {
		case IncomeModeSmooth:
			adj[i] = sharpes[i]
		case IncomeModeBalanced:
			adj[i] = 0.5*frac(c.yield, maxY) + 0.5*frac(sharpes[i], maxS)
		default:
			adj[i] = c.yield
		}
	}
	return adj
}

// Scoring constants for policyScore. Extracted so the documented intent and
// the arithmetic share a single source of truth (the previous inline comment
// claimed "~10% yield" per rating point while the code applied 1%).
const (
	// btcStackBonus is the score multiplier applied to BTC-native streams
	// under PolicyStackBTC, approximating the conversion friction avoided by
	// being paid directly in Bitcoin. A 5% edge lets a BTC stream win a near
	// tie without overriding a materially higher-yielding alternative.
	btcStackBonus = 1.05

	// ratingBonusPerPoint is the score bonus per privacy / environmental
	// rating point. Ratings run 0..10, so at 0.01 the maximum rating of 10
	// yields a 10% score premium total — enough to prefer a well-rated stream
	// over a marginally higher-yielding one, but not enough to ignore revenue.
	ratingBonusPerPoint = 0.01
)

// policyScore assigns a comparison score that reflects the active policy.
// Higher scores are preferred. When scores are equal, sort falls back to
// yield, then StreamID.
func policyScore(s Stream, yield float64, p Policy) float64 {
	switch p {
	case PolicyStackBTC:
		if s.IsBitcoinMining {
			return yield * btcStackBonus
		}
		return yield
	case PolicyMaximizePrivacy:
		return yield * (1.0 + float64(s.PrivacyRating)*ratingBonusPerPoint)
	case PolicyEnvironmentFriendly:
		return yield * (1.0 + float64(s.EnvironmentalRating)*ratingBonusPerPoint)
	case PolicyMaximizeEarnings:
		fallthrough
	default:
		return yield
	}
}
