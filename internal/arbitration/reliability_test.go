// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import (
	"math"
	"testing"
)

func TestProviderReliability_UniformPrior(t *testing.T) {
	if got := NewProviderReliability().PosteriorMean(); got != 0.5 {
		t.Fatalf("prior posterior = %v, want 0.5 (uniform Beta(1,1))", got)
	}
}

func TestProviderReliability_ConvergesToOneOnSuccess(t *testing.T) {
	r := NewProviderReliability()
	for i := 0; i < 18; i++ {
		r.Update(true)
	}
	if got := r.PosteriorMean(); got != 0.95 {
		t.Fatalf("posterior after 18 successes = %v, want 0.95 (19/20)", got)
	}
}

func TestProviderReliability_ConvergesToZeroOnFailure(t *testing.T) {
	r := NewProviderReliability()
	for i := 0; i < 18; i++ {
		r.Update(false)
	}
	if got := r.PosteriorMean(); math.Abs(got-0.05) > 1e-9 {
		t.Fatalf("posterior after 18 failures = %v, want 0.05 (1/20)", got)
	}
}

func TestProviderReliability_AlternatingStaysNearHalf(t *testing.T) {
	r := NewProviderReliability()
	for i := 0; i < 10; i++ {
		r.Update(i%2 == 0)
	}
	if got := r.PosteriorMean(); got != 0.5 {
		t.Fatalf("posterior after 5+5 outcomes = %v, want 0.5", got)
	}
}
