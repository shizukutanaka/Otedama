// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import (
	"math"
	"testing"
)

func TestYieldForecaster_UninitializedPredictsZero(t *testing.T) {
	f := NewYieldForecaster(24)
	if got := f.Predict(1); got != 0 {
		t.Fatalf("Predict before any observation = %v, want 0", got)
	}
}

func TestYieldForecaster_ConstantSeriesPredictsConstant(t *testing.T) {
	f := NewYieldForecaster(24)
	for i := 0; i < 100; i++ {
		f.Update(42)
	}
	if got := f.Predict(1); math.Abs(got-42) > 1e-6 {
		t.Fatalf("Predict(1) on constant series = %v, want ~42", got)
	}
	if got := f.Sigma(); got > 0.01 {
		t.Fatalf("Sigma on constant series = %v, want ~0", got)
	}
}

func TestYieldForecaster_TracksLinearRamp(t *testing.T) {
	f := NewYieldForecaster(24)
	for i := 0; i < 200; i++ {
		f.Update(float64(i)) // perfect ramp: level 0,1,2,…, slope 1
	}
	// After convergence the one-step forecast should approach the next
	// ramp value (slope 1/step). Allow generous tolerance — smoothing
	// lags by construction; what matters is that it tracks within ~10%.
	if got := f.Predict(1); math.Abs(got-200) > 20 {
		t.Fatalf("Predict(1) after ramp = %v, want ~200", got)
	}
}

func TestYieldForecaster_SeasonalRepeats(t *testing.T) {
	const period = 8
	f := NewYieldForecaster(period)
	// Feed 4 full seasons of a repeating pattern plus start of the next.
	for i := 0; i < 4*period; i++ {
		f.Update(10 + float64(i%period)*10) // 10,20,…,80 repeating
	}
	// Predict 2 steps ahead from the last fed value (10, idx wraps to 0):
	// expected next pattern element is 20 then 30.
	p1 := f.Predict(1)
	p2 := f.Predict(2)
	if p2 < p1 {
		t.Fatalf("seasonal forecast not following pattern: p1=%v p2=%v", p1, p2)
	}
	if p1 <= 0 {
		t.Fatalf("seasonal forecast should be positive, got %v", p1)
	}
}

func TestYieldForecaster_SigmaRisesOnRegimeStep(t *testing.T) {
	f := NewYieldForecaster(24)
	for i := 0; i < 100; i++ {
		f.Update(10)
	}
	baseSigma := f.Sigma()
	for i := 0; i < 5; i++ {
		f.Update(100) // regime step
	}
	if got := f.Sigma(); got <= baseSigma {
		t.Fatalf("Sigma after regime step = %v, want > %v (baseline)", got, baseSigma)
	}
}

func TestYieldForecaster_NoSeasonalWhenPeriodZero(t *testing.T) {
	f := NewYieldForecaster(0)
	for i := 0; i < 50; i++ {
		f.Update(5)
	}
	if got := f.Predict(1); math.Abs(got-5) > 1e-6 {
		t.Fatalf("Predict with period 0 = %v, want ~5", got)
	}
}

func TestYieldForecaster_NeverPredictsNegative(t *testing.T) {
	f := NewYieldForecaster(24)
	f.Update(100)
	for i := 0; i < 300; i++ {
		f.Update(0) // crash to zero → trend goes negative
	}
	if got := f.Predict(1); got < 0 {
		t.Fatalf("Predict returned negative yield %v", got)
	}
}

// ============================================================================
// ADR-010 A8 — change-point reset (CTS-lite)
// ============================================================================

// A sustained regime break (5-epoch window median error > 2σ) must trigger
// exactly one reset; afterwards the smoother re-seeds onto the new level.
func TestYieldForecaster_ResetsOnRegimeBreak(t *testing.T) {
	f := NewYieldForecaster(24)
	for i := 0; i < 100; i++ {
		f.Update(10)
	}
	resets := 0
	for i := 0; i < 60; i++ {
		if _, reset := f.Update(1000); reset {
			resets++
		}
	}
	if resets == 0 {
		t.Fatal("expected at least one A8 reset after a 100x regime break")
	}
	if got := f.Predict(1); math.Abs(got-1000) > 100 {
		t.Fatalf("Predict(1) after reset+convergence = %v, want ~1000", got)
	}
}

// A single outlier spike must NOT trigger a reset — the median-of-5 window
// guards against one bad epoch (a lone anomalous quote is not a regime).
func TestYieldForecaster_SingleSpikeDoesNotReset(t *testing.T) {
	f := NewYieldForecaster(24)
	for i := 0; i < 100; i++ {
		f.Update(10)
	}
	resets := 0
	f.Update(1000) // one anomalous quote
	for i := 0; i < 20; i++ {
		if _, reset := f.Update(10); reset {
			resets++
		}
	}
	if resets != 0 {
		t.Fatalf("single spike triggered %d resets, want 0", resets)
	}
}

// Smooth drift that the trend component can track must not reset — only
// discontinuities (cliffs) are regime breaks, not gentle evolution.
func TestYieldForecaster_NoResetWithinNoise(t *testing.T) {
	f := NewYieldForecaster(24)
	for i := 0; i < 300; i++ {
		if _, reset := f.Update(10 + 0.02*float64(i)); reset {
			t.Fatalf("unexpected reset at observation %d", i)
		}
	}
}
