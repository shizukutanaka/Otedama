// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// ----- Policy & Yield basic checks -----

func TestPolicy_Valid(t *testing.T) {
	valid := []Policy{PolicyMaximizeEarnings, PolicyStackBTC, PolicyMaximizePrivacy, PolicyEnvironmentFriendly}
	for _, p := range valid {
		t.Run(p.String(), func(t *testing.T) {
			if !p.Valid() {
				t.Errorf("%v reported as invalid", p)
			}
		})
	}
	if Policy(99).Valid() {
		t.Error("unknown Policy value reported as valid")
	}
}

func TestPolicy_String_Stable(t *testing.T) {
	// These names are part of the log contract; operators grep for them.
	cases := map[Policy]string{
		PolicyMaximizeEarnings:    "maximize_earnings",
		PolicyStackBTC:            "stack_btc",
		PolicyMaximizePrivacy:     "maximize_privacy",
		PolicyEnvironmentFriendly: "environment_friendly",
	}
	for p, want := range cases {
		if got := p.String(); got != want {
			t.Errorf("Policy(%d).String() = %q, want %q", int(p), got, want)
		}
	}
}

func TestYield_Effective(t *testing.T) {
	tests := []struct {
		name string
		y    Yield
		want float64
	}{
		{"positive, full confidence", Yield{100, 1.0}, 100},
		{"positive, half confidence", Yield{100, 0.5}, 50},
		{"zero sats", Yield{0, 1.0}, 0},
		{"zero confidence", Yield{100, 0}, 0},
		{"negative sats treated as zero", Yield{-50, 1.0}, 0},
		{"negative confidence treated as zero", Yield{100, -0.5}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.y.Effective(); got != tt.want {
				t.Errorf("Effective() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ----- Decide: malformed input -----

func TestDecide_RejectsInvalidPolicy(t *testing.T) {
	_, err := Decide(Input{Policy: Policy(99)})
	if err == nil {
		t.Fatal("Decide must reject invalid Policy")
	}
}

func TestDecide_RejectsNegativeHysteresis(t *testing.T) {
	_, err := Decide(Input{HysteresisMargin: -0.1})
	if err == nil {
		t.Fatal("Decide must reject negative HysteresisMargin")
	}
}

func TestDecide_RejectsDuplicateDeviceIDs(t *testing.T) {
	devs := []DeviceRef{
		{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}},
		{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}},
	}
	_, err := Decide(Input{Devices: devs})
	if err == nil {
		t.Fatal("Decide must reject duplicate device IDs")
	}
	if !strings.Contains(err.Error(), "duplicate") {
		t.Errorf("error %q must mention 'duplicate'", err)
	}
}

func TestDecide_EmptyInputReturnsEmptyAllocation(t *testing.T) {
	alloc, err := Decide(Input{Policy: PolicyMaximizeEarnings})
	if err != nil {
		t.Fatalf("Decide on empty input failed: %v", err)
	}
	if len(alloc.Assignments) != 0 {
		t.Errorf("got %d assignments, want 0", len(alloc.Assignments))
	}
	if alloc.TotalYield != 0 {
		t.Errorf("TotalYield = %v, want 0", alloc.TotalYield)
	}
}

// ----- Decide: basic allocation -----

func TestDecide_AssignsEachDeviceToBestStream(t *testing.T) {
	// GPU and CPU both available; two streams exist. GPU's best stream
	// pays more than CPU's best; we verify each device gets its own best.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	cpu := DeviceRef{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}}

	mining := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU, hal.FamilyCPU},
		YieldPerDevice: map[string]Yield{
			"gpu-0": {SatsPerSecond: 100, Confidence: 1.0},
			"cpu-0": {SatsPerSecond: 10, Confidence: 1.0},
		},
	}
	ai := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice: map[string]Yield{
			"gpu-0": {SatsPerSecond: 200, Confidence: 1.0},
		},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu, cpu},
		Streams: []Stream{mining, ai},
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}

	byID := assignmentsByID(alloc)
	if byID["gpu-0"].Stream != "ai.strawberry" {
		t.Errorf("gpu-0 assigned to %q, want ai.strawberry (higher yield)", byID["gpu-0"].Stream)
	}
	if byID["cpu-0"].Stream != "mining.braiins" {
		t.Errorf("cpu-0 assigned to %q, want mining.braiins (only compatible)", byID["cpu-0"].Stream)
	}
}

func TestDecide_IdleWhenNoCompatibleStream(t *testing.T) {
	// An ASIC with only GPU-only streams available must be left idle,
	// not incorrectly assigned.
	asic := DeviceRef{Identity: hal.Identity{ID: "asic-0", Family: hal.FamilyASIC}}
	gpuOnly := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"asic-0": {SatsPerSecond: 1000, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{asic},
		Streams: []Stream{gpuOnly},
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if !alloc.Assignments[0].Idle() {
		t.Error("ASIC must be idle when no compatible stream exists")
	}
	if alloc.SkippedDevice != 1 {
		t.Errorf("SkippedDevice = %d, want 1", alloc.SkippedDevice)
	}
}

func TestDecide_ZeroYieldStreamIsIgnored(t *testing.T) {
	// A stream that quotes zero yield for a device must be treated as
	// "not accepting this device right now", not as the best option.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	zero := Stream{
		ID:              "render.rendernet",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 0, Confidence: 1.0}},
	}
	nonZero := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 10, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{zero, nonZero},
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Stream != "mining.braiins" {
		t.Errorf("chose %q despite zero-yield alternative", alloc.Assignments[0].Stream)
	}
}

func TestDecide_UsesDefaultYieldWhenDeviceNotListed(t *testing.T) {
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-new", Family: hal.FamilyGPU}}
	s := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		DefaultYield:    Yield{SatsPerSecond: 50, Confidence: 0.8},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{s},
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Idle() {
		t.Fatal("device left idle despite DefaultYield being available")
	}
	// 50 * 0.8 = 40
	if alloc.Assignments[0].ExpectedYield != 40 {
		t.Errorf("ExpectedYield = %v, want 40 (using DefaultYield)", alloc.Assignments[0].ExpectedYield)
	}
}

// ----- Decide: policies -----

func TestDecide_StackBTCPolicy_PrefersBitcoinMining(t *testing.T) {
	// When yields are close, the StackBTC policy must prefer BTC-native.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	mining := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		IsBitcoinMining: true,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	ai := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 103, Confidence: 1.0}},
	}

	// 3% advantage for AI should not overcome the 5% BTC bonus under StackBTC.
	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{mining, ai},
		Policy:  PolicyStackBTC,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Stream != "mining.braiins" {
		t.Errorf("StackBTC chose %q, want mining.braiins", alloc.Assignments[0].Stream)
	}
}

func TestDecide_PrivacyPolicy_PrefersHigherRating(t *testing.T) {
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	private := Stream{
		ID:              "mining.ocean",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		PrivacyRating:   9,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	kyc := Stream{
		ID:              "mining.nicehash",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		PrivacyRating:   2,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{private, kyc},
		Policy:  PolicyMaximizePrivacy,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	// 100 * (1 + 9*0.01) = 109; 105 * (1 + 2*0.01) = 107.1 => private wins
	if alloc.Assignments[0].Stream != "mining.ocean" {
		t.Errorf("Privacy policy chose %q, want mining.ocean", alloc.Assignments[0].Stream)
	}
}

// ----- Decide: hysteresis -----

func TestDecide_HysteresisKeepsCurrentUnderMargin(t *testing.T) {
	// If the new best only beats the incumbent by less than the margin,
	// we must stay on the incumbent to avoid flapping.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}

	prev := &Allocation{
		Assignments: []Assignment{
			{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100},
		},
	}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10, // require 10% improvement
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	// 5% improvement < 10% margin => keep current.
	if alloc.Assignments[0].Stream != "mining.braiins" {
		t.Errorf("under 10%% hysteresis, kept switch from %q; hysteresis violated", alloc.Assignments[0].Stream)
	}
}

func TestDecide_HysteresisAllowsSwitchAboveMargin(t *testing.T) {
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 200, Confidence: 1.0}},
	}

	prev := &Allocation{
		Assignments: []Assignment{
			{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100},
		},
	}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Stream != "ai.strawberry" {
		t.Errorf("100%% improvement failed to overcome 10%% hysteresis; got %q", alloc.Assignments[0].Stream)
	}
	if alloc.Assignments[0].SwitchedFromID != "mining.braiins" {
		t.Errorf("SwitchedFromID = %q, want mining.braiins", alloc.Assignments[0].SwitchedFromID)
	}
}

func TestDecide_HeldFlag_SetWhenBetterAlternativeSuppressed(t *testing.T) {
	// Session 131: a strictly higher-yielding challenger that does not clear the
	// hysteresis margin must mark the held assignment as Held (yield declined).
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10, // 5% gain < 10% margin → hold
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if a.Stream != "mining.braiins" {
		t.Fatalf("expected hold on mining.braiins, got %q", a.Stream)
	}
	if !a.Held {
		t.Error("Held = false, want true (a better alternative was suppressed)")
	}
}

func TestDecide_HeldFlag_FalseWhenIncumbentIsBest(t *testing.T) {
	// No better alternative exists, so staying is not a "hold" — nothing declined.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	weaker := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 80, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, weaker},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if alloc.Assignments[0].Held {
		t.Error("Held = true, want false (incumbent is already the best; nothing declined)")
	}
}

func TestDecide_HeldFlag_FalseOnActualSwitch(t *testing.T) {
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 200, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10, // 100% gain clears margin → switch
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if a.Stream != "ai.strawberry" {
		t.Fatalf("expected switch to ai.strawberry, got %q", a.Stream)
	}
	if a.Held {
		t.Error("Held = true on an actual switch, want false")
	}
}

func TestDecide_ForegoneSatsPerSec_ZeroWhenBestChosen(t *testing.T) {
	// Session 142: under MaximizeEarnings with no hold, the best raw-yield
	// stream is chosen, so nothing is sacrificed.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	hi := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 200, Confidence: 1.0}},
	}
	lo := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{hi, lo},
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if got := alloc.Assignments[0].ForegoneSatsPerSec; got != 0 {
		t.Errorf("ForegoneSatsPerSec = %v, want 0 (best stream chosen)", got)
	}
}

func TestDecide_ForegoneSatsPerSec_EqualsGapWhenHeld(t *testing.T) {
	// When hysteresis holds the incumbent (100) over a better challenger (105),
	// the opportunity cost is exactly the raw yield gap: 105 - 100 = 5 sats/s.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.braiins", ExpectedYield: 100}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10, // 5% gain < 10% margin → hold
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if a.Stream != "mining.braiins" {
		t.Fatalf("expected hold on mining.braiins, got %q", a.Stream)
	}
	if got := a.ForegoneSatsPerSec; got != 5 {
		t.Errorf("ForegoneSatsPerSec = %v, want 5 (105 - 100)", got)
	}
}

func TestDecide_ForegoneSatsPerSec_QuantifiesPolicyDeviation(t *testing.T) {
	// A non-earnings policy can prefer a lower raw-yield stream. The foregone
	// metric must capture that sacrifice even with no hysteresis hold: privacy
	// picks the 100-yield rating-9 stream over the 105-yield rating-2 stream,
	// so 105 - 100 = 5 sats/s is sacrificed for privacy.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	private := Stream{
		ID:              "ai.private",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
		PrivacyRating:   9,
	}
	lucrative := Stream{
		ID:              "ai.public",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
		PrivacyRating:   2,
	}
	// score(private) = 100*(1+9*0.01)=109; score(lucrative)=105*(1+2*0.01)=107.1
	// → private wins on score, but sacrifices 5 raw sats/s.
	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{private, lucrative},
		Policy:  PolicyMaximizePrivacy,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if a.Stream != "ai.private" {
		t.Fatalf("expected privacy to pick ai.private, got %q", a.Stream)
	}
	if got := a.ForegoneSatsPerSec; got != 5 {
		t.Errorf("ForegoneSatsPerSec = %v, want 5 (105 - 100 sacrificed for privacy)", got)
	}
}

func TestDecide_ForegoneSatsPerSec_ZeroWhenIdle(t *testing.T) {
	// An idle device (no compatible stream) sacrifices nothing.
	asic := DeviceRef{Identity: hal.Identity{ID: "asic-0", Family: hal.FamilyASIC}}
	gpuOnly := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 200, Confidence: 1.0}},
	}
	alloc, err := Decide(Input{
		Devices: []DeviceRef{asic},
		Streams: []Stream{gpuOnly},
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if !a.Idle() {
		t.Fatalf("expected asic-0 idle, got %q", a.Stream)
	}
	if got := a.ForegoneSatsPerSec; got != 0 {
		t.Errorf("ForegoneSatsPerSec = %v, want 0 for idle device", got)
	}
}

func TestDecide_HysteresisUsesPolicyScoreNotRawYield(t *testing.T) {
	// Regression for the Socratic-inquiry finding (session 114): under a
	// non-earnings policy, hysteresis must be measured in the same
	// policy-adjusted metric used for selection. A challenger with higher
	// *raw* yield but only a marginal *policy-score* gain must not trigger a
	// switch when that gain is below the hysteresis margin.
	//
	// incumbent: raw 100, privacy 10 -> score 100*(1+10*0.01) = 110
	// challenger: raw 115, privacy 0 -> score 115
	// policy-score gain = 115/110 = +4.5%, below the 10% margin -> hold.
	// (The old raw-yield logic would have switched: 115 > 100*1.10 = 110.)
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	incumbent := Stream{
		ID:              "mining.ocean",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		PrivacyRating:   10,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "mining.kyc",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		PrivacyRating:   0,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 115, Confidence: 1.0}},
	}
	prev := &Allocation{
		Assignments: []Assignment{
			{DeviceID: "gpu-0", Stream: "mining.ocean", ExpectedYield: 100},
		},
	}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{incumbent, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizePrivacy,
		HysteresisMargin: 0.10,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Stream != "mining.ocean" {
		t.Errorf("policy-score gain (+4.5%%) is below the 10%% margin; "+
			"engine switched to %q instead of holding the private incumbent",
			alloc.Assignments[0].Stream)
	}
}

func TestDecide_HysteresisPolicyScore_AllowsSwitchWhenScoreGainExceedsMargin(t *testing.T) {
	// Complement of the above: when the policy-score gain *does* exceed the
	// margin, the switch must occur even under a non-earnings policy.
	//
	// incumbent: raw 100, privacy 10 -> score 110
	// challenger: raw 130, privacy 0 -> score 130; gain 130/110 = +18% > 10%.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	incumbent := Stream{
		ID:              "mining.ocean",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		PrivacyRating:   10,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "mining.kyc",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		PrivacyRating:   0,
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 130, Confidence: 1.0}},
	}
	prev := &Allocation{
		Assignments: []Assignment{
			{DeviceID: "gpu-0", Stream: "mining.ocean", ExpectedYield: 100},
		},
	}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{incumbent, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizePrivacy,
		HysteresisMargin: 0.10,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Stream != "mining.kyc" {
		t.Errorf("policy-score gain (+18%%) exceeds the 10%% margin; "+
			"engine held %q instead of switching", alloc.Assignments[0].Stream)
	}
	if alloc.Assignments[0].SwitchedFromID != "mining.ocean" {
		t.Errorf("SwitchedFromID = %q, want mining.ocean", alloc.Assignments[0].SwitchedFromID)
	}
}

// ----- Decide: determinism -----

func TestDecide_DeterministicForIdenticalInput(t *testing.T) {
	in := Input{
		Devices: []DeviceRef{
			{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}},
			{Identity: hal.Identity{ID: "gpu-1", Family: hal.FamilyGPU}},
			{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}},
		},
		Streams: []Stream{
			{
				ID:              "mining.braiins",
				AcceptsFamilies: []hal.Family{hal.FamilyGPU, hal.FamilyCPU},
				DefaultYield:    Yield{50, 1.0},
			},
			{
				ID:              "ai.strawberry",
				AcceptsFamilies: []hal.Family{hal.FamilyGPU},
				DefaultYield:    Yield{70, 1.0},
			},
		},
		Policy: PolicyMaximizeEarnings,
	}

	first, err := Decide(in)
	if err != nil {
		t.Fatalf("first Decide failed: %v", err)
	}
	for i := 0; i < 10; i++ {
		next, err := Decide(in)
		if err != nil {
			t.Fatalf("iteration %d Decide failed: %v", i, err)
		}
		if !allocationsEqual(first, next) {
			t.Fatalf("iteration %d: allocation diverged from first", i)
		}
	}
}

func TestDecide_DeterministicUnderShuffledDeviceInput(t *testing.T) {
	// Shuffling the input order must not change the output order or
	// assignments. This is what lets callers compare allocations for
	// diffing.
	devs := []DeviceRef{
		{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}},
		{Identity: hal.Identity{ID: "gpu-1", Family: hal.FamilyGPU}},
		{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}},
	}
	streams := []Stream{
		{
			ID:              "s1",
			AcceptsFamilies: []hal.Family{hal.FamilyGPU, hal.FamilyCPU},
			DefaultYield:    Yield{50, 1.0},
		},
	}

	first, _ := Decide(Input{Devices: devs, Streams: streams, Policy: PolicyMaximizeEarnings})

	shuffled := []DeviceRef{devs[2], devs[0], devs[1]}
	second, _ := Decide(Input{Devices: shuffled, Streams: streams, Policy: PolicyMaximizeEarnings})

	if !allocationsEqual(first, second) {
		t.Error("shuffled input produced different allocation; engine is not input-order-deterministic")
	}
}

// ----- Property-based: invariants over random input -----

func TestDecide_Property_NeverAssignsIncompatibleFamily(t *testing.T) {
	// For any random configuration, no device may end up assigned to a
	// stream whose AcceptsFamilies excludes its Family.
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		in := randomInput(r)
		alloc, err := Decide(in)
		if err != nil {
			continue // random input may hit duplicate IDs; skip those trials
		}

		streamByID := make(map[StreamID]Stream, len(in.Streams))
		for _, s := range in.Streams {
			streamByID[s.ID] = s
		}
		devByID := make(map[string]DeviceRef, len(in.Devices))
		for _, d := range in.Devices {
			devByID[d.Identity.ID] = d
		}

		for _, a := range alloc.Assignments {
			if a.Idle() {
				continue
			}
			s, ok := streamByID[a.Stream]
			if !ok {
				t.Fatalf("trial %d: assignment references unknown stream %q", trial, a.Stream)
			}
			d := devByID[a.DeviceID]
			if !s.Accepts(d.Identity.Family) {
				t.Fatalf("trial %d: device %v (family %q) assigned to stream %q (accepts %v)",
					trial, a.DeviceID, d.Identity.Family, a.Stream, s.AcceptsFamilies)
			}
		}
	}
}

func TestDecide_Property_AllocationMatchesOrExceedsGreedy(t *testing.T) {
	// Under PolicyMaximizeEarnings with no hysteresis, the engine's raw
	// TotalYield must equal the greedy per-device maximum — it IS the
	// per-device greedy optimum. Other policies deliberately sacrifice raw
	// yield for privacy/environment/BTC preference, so this invariant is
	// restricted to PolicyMaximizeEarnings.
	r := rand.New(rand.NewSource(7))
	for trial := 0; trial < 200; trial++ {
		in := randomInput(r)
		in.HysteresisMargin = 0
		in.Previous = nil
		in.Policy = PolicyMaximizeEarnings // invariant only holds for this policy

		alloc, err := Decide(in)
		if err != nil {
			continue
		}
		greedy := greedyTotalYield(in)
		if alloc.TotalYield+1e-9 < greedy {
			t.Fatalf("trial %d: engine yield %.4f < greedy %.4f", trial, alloc.TotalYield, greedy)
		}
	}
}

func TestDecide_Property_NoIdleWhenCompatibleStreamExists(t *testing.T) {
	// A device must not be left idle if any stream accepts its Family
	// and offers positive yield for it.
	r := rand.New(rand.NewSource(99))
	for trial := 0; trial < 200; trial++ {
		in := randomInput(r)
		in.HysteresisMargin = 0
		in.Previous = nil

		alloc, err := Decide(in)
		if err != nil {
			continue
		}

		for _, a := range alloc.Assignments {
			if !a.Idle() {
				continue
			}
			// Device is idle; verify no stream actually accepts it.
			var dev DeviceRef
			for _, d := range in.Devices {
				if d.Identity.ID == a.DeviceID {
					dev = d
					break
				}
			}
			for _, s := range in.Streams {
				if s.Accepts(dev.Identity.Family) && s.YieldFor(dev.Identity.ID).Effective() > 0 {
					t.Fatalf("trial %d: device %v idle but stream %v offers yield %.4f",
						trial, a.DeviceID, s.ID, s.YieldFor(dev.Identity.ID).Effective())
				}
			}
		}
	}
}

func TestDecide_TotalYield_EqualsSumOfExpectedYields(t *testing.T) {
	// TotalYield must equal the sum of ExpectedYield values across all
	// Assignments — idle devices contribute zero, and the identity holds
	// regardless of policy.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	cpu := DeviceRef{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}}
	asic := DeviceRef{Identity: hal.Identity{ID: "asic-0", Family: hal.FamilyASIC}}
	streams := []Stream{
		{
			ID:              "mining.braiins",
			AcceptsFamilies: []hal.Family{hal.FamilyGPU, hal.FamilyCPU},
			YieldPerDevice: map[string]Yield{
				"gpu-0": {SatsPerSecond: 100, Confidence: 1.0},
				"cpu-0": {SatsPerSecond: 10, Confidence: 0.9},
			},
		},
	}
	// asic-0 has no compatible stream → idle (ExpectedYield = 0).

	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu, cpu, asic},
		Streams: streams,
		Policy:  PolicyMaximizeEarnings,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	var sumYield float64
	for _, a := range alloc.Assignments {
		sumYield += a.ExpectedYield
	}
	if alloc.TotalYield != sumYield {
		t.Errorf("TotalYield = %v, sum(ExpectedYield) = %v; must be equal", alloc.TotalYield, sumYield)
	}
}

func TestDecide_Property_ForegoneSatsPerSecNeverNegative(t *testing.T) {
	// ForegoneSatsPerSec must always be >= 0 for every Assignment,
	// regardless of policy, devices, hysteresis, or stream configuration.
	// A negative value would mean the engine assigned a device to a stream
	// that pays *more* than the best available stream, which is impossible.
	r := rand.New(rand.NewSource(17))
	for trial := 0; trial < 200; trial++ {
		in := randomInput(r)
		alloc, err := Decide(in)
		if err != nil {
			continue
		}
		for _, a := range alloc.Assignments {
			if a.ForegoneSatsPerSec < 0 {
				t.Fatalf("trial %d device %q: ForegoneSatsPerSec = %v < 0",
					trial, a.DeviceID, a.ForegoneSatsPerSec)
			}
		}
	}
}

// ----- Decide: Reason string fidelity -----

func TestDecide_ReasonString_IncumbentIsBest_DoesNotSayHeld(t *testing.T) {
	// When the incumbent is the best available stream (nothing better exists),
	// the Reason must NOT say "held" — saying so is misleading because nothing
	// was sacrificed or declined; the engine simply confirmed the incumbent.
	// Held must be false in the same case.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	incumbent := Stream{
		ID:              "mining.best",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	weaker := Stream{
		ID:              "ai.weaker",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 80, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.best"}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{incumbent, weaker},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if a.Stream != "mining.best" {
		t.Fatalf("expected stay on mining.best, got %q", a.Stream)
	}
	if a.Held {
		t.Error("Held = true, want false (incumbent is the best; no alternative was suppressed)")
	}
	if strings.Contains(a.Reason, "held") {
		t.Errorf("Reason %q must not say 'held' when incumbent is already the best", a.Reason)
	}
}

func TestDecide_ReasonString_HeldOnSuppressedAlternative_ContainsHeld(t *testing.T) {
	// When a higher-scoring challenger is suppressed by hysteresis, the Reason
	// must say "held" and Held must be true — both for operator log readability.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	current := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.strawberry",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.braiins"}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{current, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0.10, // 5% gain < 10% margin → hold
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	if !a.Held {
		t.Error("Held = false, want true (challenger was suppressed)")
	}
	if !strings.Contains(a.Reason, "held") {
		t.Errorf("Reason %q must contain 'held' when a better alternative was suppressed", a.Reason)
	}
}

// ----- Decide: PolicyEnvironmentFriendly -----

func TestDecide_EnvironmentFriendlyPolicy_PrefersHigherRating(t *testing.T) {
	// Under PolicyEnvironmentFriendly a stream with a high EnvironmentalRating
	// must win over a marginally higher raw-yield stream with a poor rating.
	//
	// green: raw 100, env 9  → score = 100 * (1 + 9*0.01) = 109.0
	// dirty: raw 105, env 1  → score = 105 * (1 + 1*0.01) = 106.05
	// → green wins.
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	green := Stream{
		ID:                  "science.boinc",
		AcceptsFamilies:     []hal.Family{hal.FamilyGPU},
		EnvironmentalRating: 9,
		YieldPerDevice:      map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	dirty := Stream{
		ID:                  "mining.coal",
		AcceptsFamilies:     []hal.Family{hal.FamilyGPU},
		EnvironmentalRating: 1,
		YieldPerDevice:      map[string]Yield{"gpu-0": {SatsPerSecond: 105, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{gpu},
		Streams: []Stream{green, dirty},
		Policy:  PolicyEnvironmentFriendly,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if alloc.Assignments[0].Stream != "science.boinc" {
		t.Errorf("EnvironmentFriendly policy chose %q (score 106.05), want science.boinc (score 109.0)",
			alloc.Assignments[0].Stream)
	}
}

func TestDecide_ZeroHysteresisExactTieStaysOnIncumbent(t *testing.T) {
	// With HysteresisMargin=0, the engine should switch on ANY strict improvement.
	// An exact yield tie is not an improvement; the incumbent must be kept and
	// Held must be false (nothing was declined — scores are equal).
	gpu := DeviceRef{Identity: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}}
	incumbent := Stream{
		ID:              "mining.a", // lexicographically > "ai.b" so challenger would win sort
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	challenger := Stream{
		ID:              "ai.b",
		AcceptsFamilies: []hal.Family{hal.FamilyGPU},
		YieldPerDevice:  map[string]Yield{"gpu-0": {SatsPerSecond: 100, Confidence: 1.0}},
	}
	prev := &Allocation{Assignments: []Assignment{{DeviceID: "gpu-0", Stream: "mining.a"}}}

	alloc, err := Decide(Input{
		Devices:          []DeviceRef{gpu},
		Streams:          []Stream{incumbent, challenger},
		Previous:         prev,
		Policy:           PolicyMaximizeEarnings,
		HysteresisMargin: 0, // switch on any strict improvement
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	a := alloc.Assignments[0]
	// Scores are equal; the tie-break sort picks "ai.b" (lexicographically first)
	// as best. But incumbent "mining.a" has incScore == bestScore, threshold ==
	// bestScore → hold fires. Held must be true since best != incumbent.
	// The Reason must contain "held".
	if a.Stream != "mining.a" {
		t.Errorf("exact tie with hysteresis=0: expected incumbent mining.a, got %q (challenger had equal yield, no improvement)", a.Stream)
	}
	if !a.Held {
		t.Errorf("Held = false; expected true because tie-break would pick ai.b but no gain justifies switching")
	}
	if !strings.Contains(a.Reason, "held") {
		t.Errorf("Reason %q should say 'held' when a tie-break alternative was suppressed", a.Reason)
	}
}

// ----- Helpers -----

func assignmentsByID(a *Allocation) map[string]Assignment {
	m := make(map[string]Assignment, len(a.Assignments))
	for _, x := range a.Assignments {
		m[x.DeviceID] = x
	}
	return m
}

func allocationsEqual(a, b *Allocation) bool {
	if a == nil || b == nil {
		return a == b
	}
	if len(a.Assignments) != len(b.Assignments) {
		return false
	}
	for i := range a.Assignments {
		if a.Assignments[i] != b.Assignments[i] {
			// Assignments differ by Reason string; compare field-by-field
			// ignoring Reason, since Reason carries diagnostic text.
			if a.Assignments[i].DeviceID != b.Assignments[i].DeviceID ||
				a.Assignments[i].Stream != b.Assignments[i].Stream ||
				a.Assignments[i].ExpectedYield != b.Assignments[i].ExpectedYield ||
				a.Assignments[i].SwitchedFromID != b.Assignments[i].SwitchedFromID {
				return false
			}
		}
	}
	return true
}

func randomInput(r *rand.Rand) Input {
	families := []hal.Family{hal.FamilyASIC, hal.FamilyGPU, hal.FamilyCPU}

	nDev := r.Intn(6) + 1
	devs := make([]DeviceRef, 0, nDev)
	for i := 0; i < nDev; i++ {
		devs = append(devs, DeviceRef{
			Identity: hal.Identity{
				ID:     fmt.Sprintf("dev-%d", i),
				Family: families[r.Intn(len(families))],
			},
		})
	}

	nStream := r.Intn(5) + 1
	streams := make([]Stream, 0, nStream)
	for i := 0; i < nStream; i++ {
		accepted := make([]hal.Family, 0)
		for _, f := range families {
			if r.Intn(2) == 0 {
				accepted = append(accepted, f)
			}
		}
		streams = append(streams, Stream{
			ID:                  StreamID(fmt.Sprintf("stream-%d", i)),
			AcceptsFamilies:     accepted,
			DefaultYield:        Yield{SatsPerSecond: float64(r.Intn(200)), Confidence: 0.5 + r.Float64()*0.5},
			PrivacyRating:       r.Intn(11),
			EnvironmentalRating: r.Intn(11),
			IsBitcoinMining:     r.Intn(2) == 0,
		})
	}

	return Input{
		Devices: devs,
		Streams: streams,
		Policy:  Policy(r.Intn(4)),
	}
}

func greedyTotalYield(in Input) float64 {
	// For each device, take the max effective yield among compatible streams.
	var total float64
	for _, d := range in.Devices {
		var best float64
		for _, s := range in.Streams {
			if !s.Accepts(d.Identity.Family) {
				continue
			}
			y := s.YieldFor(d.Identity.ID).Effective()
			if y > best {
				best = y
			}
		}
		total += best
	}
	return total
}

// ----- MinYieldSatsPerSec profitability floor -----

func TestDecide_RejectsNegativeMinYield(t *testing.T) {
	_, err := Decide(Input{MinYieldSatsPerSec: -1})
	if err == nil {
		t.Fatal("Decide must reject negative MinYieldSatsPerSec")
	}
}

func TestDecide_MinYieldFloor_IdlesDeviceBelowFloor(t *testing.T) {
	// The only compatible stream yields 5 sats/s; the floor is 10, so the
	// device must idle rather than run unprofitably.
	cpu := DeviceRef{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}}
	mining := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice:  map[string]Yield{"cpu-0": {SatsPerSecond: 5, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices:            []DeviceRef{cpu},
		Streams:            []Stream{mining},
		Policy:             PolicyMaximizeEarnings,
		MinYieldSatsPerSec: 10,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	a := alloc.Assignments[0]
	if !a.Idle() {
		t.Errorf("device assigned to %q, want idle (yield 5 < floor 10)", a.Stream)
	}
	if alloc.SkippedDevice != 1 {
		t.Errorf("SkippedDevice = %d, want 1", alloc.SkippedDevice)
	}
	if !strings.Contains(a.Reason, "floor") {
		t.Errorf("idle reason %q must mention the floor", a.Reason)
	}
	if a.ForegoneSatsPerSec != 0 {
		t.Errorf("ForegoneSatsPerSec = %v, want 0 for an idle device", a.ForegoneSatsPerSec)
	}
}

func TestDecide_MinYieldFloor_KeepsDeviceAtOrAboveFloor(t *testing.T) {
	// Yield exactly equal to the floor must qualify (>= is the contract).
	cpu := DeviceRef{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}}
	mining := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice:  map[string]Yield{"cpu-0": {SatsPerSecond: 10, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices:            []DeviceRef{cpu},
		Streams:            []Stream{mining},
		Policy:             PolicyMaximizeEarnings,
		MinYieldSatsPerSec: 10,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Idle() {
		t.Error("device idle, want assigned (yield 10 == floor 10 qualifies)")
	}
}

func TestDecide_MinYieldFloor_ExcludesBelowFloorStreamFromChoice(t *testing.T) {
	// Two compatible streams: one below the floor (8), one above (50). The
	// below-floor stream must be excluded entirely — the device runs on the
	// above-floor stream and ForegoneSatsPerSec is 0 (the excluded stream is not
	// a viable alternative, so it does not count as forgone revenue).
	cpu := DeviceRef{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}}
	low := Stream{
		ID:              "ai.cheap",
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice:  map[string]Yield{"cpu-0": {SatsPerSecond: 8, Confidence: 1.0}},
	}
	high := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice:  map[string]Yield{"cpu-0": {SatsPerSecond: 50, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices:            []DeviceRef{cpu},
		Streams:            []Stream{low, high},
		Policy:             PolicyMaximizeEarnings,
		MinYieldSatsPerSec: 10,
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	a := alloc.Assignments[0]
	if a.Stream != "mining.braiins" {
		t.Errorf("assigned to %q, want mining.braiins (only above-floor stream)", a.Stream)
	}
	if a.ForegoneSatsPerSec != 0 {
		t.Errorf("ForegoneSatsPerSec = %v, want 0 (below-floor stream is not a viable alternative)", a.ForegoneSatsPerSec)
	}
}

func TestDecide_MinYieldFloor_ZeroDisablesFloor(t *testing.T) {
	// With the floor at 0 (default), even a tiny positive yield is assigned —
	// identical to the pre-floor behaviour.
	cpu := DeviceRef{Identity: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}}
	mining := Stream{
		ID:              "mining.braiins",
		AcceptsFamilies: []hal.Family{hal.FamilyCPU},
		YieldPerDevice:  map[string]Yield{"cpu-0": {SatsPerSecond: 0.0001, Confidence: 1.0}},
	}

	alloc, err := Decide(Input{
		Devices: []DeviceRef{cpu},
		Streams: []Stream{mining},
		Policy:  PolicyMaximizeEarnings,
		// MinYieldSatsPerSec left at zero value.
	})
	if err != nil {
		t.Fatalf("Decide failed: %v", err)
	}
	if alloc.Assignments[0].Idle() {
		t.Error("device idle with floor 0, want assigned")
	}
}

func TestDecide_Property_NonIdleAssignmentsClearFloor(t *testing.T) {
	// Invariant: with a positive floor, every non-idle assignment yields at
	// least the floor.
	r := rand.New(rand.NewSource(2027))
	for trial := 0; trial < 200; trial++ {
		in := randomInput(r)
		in.Previous = nil
		floor := r.Float64() * 50 // 0..50 sats/s
		in.MinYieldSatsPerSec = floor

		alloc, err := Decide(in)
		if err != nil {
			continue
		}
		for _, a := range alloc.Assignments {
			if a.Idle() {
				continue
			}
			if a.ExpectedYield < floor {
				t.Fatalf("trial %d: device %v active at yield %.6f below floor %.6f",
					trial, a.DeviceID, a.ExpectedYield, floor)
			}
		}
	}
}

func TestDecide_Property_AboveFloorStreamPreventsIdle(t *testing.T) {
	// Converse invariant of NonIdleAssignmentsClearFloor: if ANY stream accepts
	// a device with positive effective yield that clears the floor, the engine
	// MUST assign that device — it must not be left idle. Together the two
	// property tests pin the floor semantics from both directions:
	//   - active  → clears floor  (NonIdleAssignmentsClearFloor)
	//   - eligible → not idle     (this test)
	//
	// The test uses no Previous allocation (hysteresis off, Previous=nil) so
	// the engine makes a clean greedy choice unconstrained by hold logic.
	r := rand.New(rand.NewSource(2029))
	for trial := 0; trial < 200; trial++ {
		in := randomInput(r)
		in.Previous = nil
		in.HysteresisMargin = 0
		floor := r.Float64() * 50 // 0..50 sats/s
		in.MinYieldSatsPerSec = floor

		alloc, err := Decide(in)
		if err != nil {
			continue
		}

		// Build a set of eligible device IDs: those that have at least one
		// compatible stream with effective yield > 0 and >= floor.
		eligible := map[string]bool{}
		for _, d := range in.Devices {
			for _, s := range in.Streams {
				if !s.Accepts(d.Identity.Family) {
					continue
				}
				y := s.YieldFor(d.Identity.ID).Effective()
				if y > 0 && y >= floor {
					eligible[d.Identity.ID] = true
					break
				}
			}
		}

		for _, a := range alloc.Assignments {
			if a.Idle() && eligible[a.DeviceID] {
				t.Fatalf("trial %d: device %v idle but has an eligible stream above floor %.4g",
					trial, a.DeviceID, floor)
			}
		}
	}
}
