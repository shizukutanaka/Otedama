// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import (
	"math"
	"testing"
	"time"
)

func TestProviderReliability_UniformPrior(t *testing.T) {
	if got := NewProviderReliability().PosteriorMean(); got != 0.5 {
		t.Fatalf("prior posterior = %v, want 0.5 (uniform Beta(1,1))", got)
	}
}

func TestProviderReliability_ConvergesToOneOnSuccess(t *testing.T) {
	r := NewProviderReliability()
	now := time.Now()
	for i := 0; i < 18; i++ {
		r.UpdateAt(true, now) // same instant — no decay between outcomes
	}
	if got := r.PosteriorMean(); got != 0.95 {
		t.Fatalf("posterior after 18 successes = %v, want 0.95 (19/20)", got)
	}
}

func TestProviderReliability_ConvergesToZeroOnFailure(t *testing.T) {
	r := NewProviderReliability()
	now := time.Now()
	for i := 0; i < 18; i++ {
		r.UpdateAt(false, now)
	}
	if got := r.PosteriorMean(); math.Abs(got-0.05) > 1e-9 {
		t.Fatalf("posterior after 18 failures = %v, want 0.05 (1/20)", got)
	}
}

func TestProviderReliability_AlternatingStaysNearHalf(t *testing.T) {
	r := NewProviderReliability()
	for i := 0; i < 10; i++ {
		r.Update(i%2 == 0) // wall-clock shorthand: real-time gaps decay ~1e-14
	}
	if got := r.PosteriorMean(); math.Abs(got-0.5) > 1e-6 {
		t.Fatalf("posterior after 5+5 outcomes = %v, want ~0.5", got)
	}
}

// --- ADR-010 A7: reputation half-life -------------------------------------

// TestProviderReliability_DecayHalvesEvidenceAfterOneHalfLife: 18 successes
// build posterior 0.95 with evidence weight 20; after exactly one
// ReputationHalfLife the next epoch sees both pseudo-counts halved toward
// the prior before the new outcome lands — the demonstration attack's
// accumulated trust has decayed halfway to untrusted.
func TestProviderReliability_DecayHalvesEvidenceAfterOneHalfLife(t *testing.T) {
	base := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
	r := NewProviderReliability()
	for i := 0; i < 18; i++ {
		r.UpdateAt(true, base) // same instant — seeding carries no decay
	}
	// 168h later a failure lands. Before it is counted, (α,β) = (19,1)
	// decays to (10,1): evidence weight 20 → 11, then +1 failure → (10,2).
	r.UpdateAt(false, base.Add(ReputationHalfLife))
	a, b := r.Params()
	if math.Abs(a-10) > 1e-9 || math.Abs(b-2) > 1e-9 {
		t.Fatalf("params after one half-life = (%.6f, %.6f), want (10, 2)", a, b)
	}
	if got := r.PosteriorMean(); math.Abs(got-10.0/12.0) > 1e-9 {
		t.Fatalf("posterior = %v, want 10/12", got)
	}
}

// TestProviderReliability_DecayIsGradual checks the half-life is smooth,
// not a cliff: a quarter-life gap removes ~15.9% of evidence weight
// (2^−0.25), and freshly accumulated outcomes still dominate immediately.
func TestProviderReliability_DecayIsGradual(t *testing.T) {
	base := time.Now()
	r := NewProviderReliability()
	for i := 0; i < 18; i++ {
		r.UpdateAt(true, base)
	}
	r.UpdateAt(true, base.Add(ReputationHalfLife/4))
	a, _ := r.Params()
	// Evidence above the prior: 18 → 18·2^−0.25 ≈ 15.14, then +1 → α ≈ 16.14.
	want := 1 + 18*math.Pow(0.5, 0.25) + 1
	if math.Abs(a-want) > 1e-9 {
		t.Fatalf("alpha after quarter-life = %.6f, want %.6f", a, want)
	}
}

// TestProviderReliability_DecayNeverCrossesPrior: decay is a pull toward
// Beta(1,1), never through it — a failure-heavy posterior asymptotes at
// 0.5, so long-absent providers return to untrusted, not negative trust.
func TestProviderReliability_DecayNeverCrossesPrior(t *testing.T) {
	base := time.Now()
	r := NewProviderReliability()
	for i := 0; i < 18; i++ {
		r.UpdateAt(false, base)
	}
	for i := 1; i <= 10; i++ {
		r.UpdateAt(true, base.Add(time.Duration(i)*ReputationHalfLife))
	}
	if got := r.PosteriorMean(); got <= 0 || got >= 1 {
		t.Fatalf("posterior escaped (0,1): %v", got)
	}
	a, b := r.Params()
	if a < 1 || b < 1 {
		t.Fatalf("pseudo-counts decayed below prior: (%.4f, %.4f)", a, b)
	}
}

// TestProviderReliability_DecaySameInstantAndBackwards: zero and negative
// elapsed times are no-ops — same-tick epochs and a regressed clock
// cannot erase or inflate evidence.
func TestProviderReliability_DecaySameInstantAndBackwards(t *testing.T) {
	base := time.Now()
	r := NewProviderReliability()
	r.UpdateAt(true, base)
	r.UpdateAt(false, base)                   // zero gap
	r.UpdateAt(true, base.Add(-24*time.Hour)) // clock regression
	a, b := r.Params()
	if a != 3 || b != 2 {
		t.Fatalf("non-forward updates changed counts: (%.4f, %.4f), want (3, 2)", a, b)
	}
}
