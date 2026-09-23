// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import "math"

// YieldForecaster is an additive Holt-Winters smoother over a stream's
// effective-yield observations (ADR-010 feature A1). It tracks level and
// trend plus one full seasonal cycle of residuals, and emits
// Predict(steps) for horizon steps ahead together with a residual-based
// sigma — the input ADR-010 A8's change-point reset needs.
//
// One Update is one step. Callers feed it once per quote, so a "season"
// is period quotes long; for providers quoting on every arbitration tick
// (~30 s) period=2880 approximates 24 h. Until the first full season is
// observed the seasonal component is zero and the smoother degrades
// gracefully to plain Holt double-exponential smoothing.
//
// Defaults follow the ADR: alpha=0.3, beta=0.05, gamma=0.1.
type YieldForecaster struct {
	alpha, beta, gamma float64
	period             int

	level, trend float64
	seasonal     []float64 // circular buffer of length period
	idx          int       // write position within seasonal
	filled       int       // observations so far, capped at period
	initialized  bool

	mae float64 // EWMA of absolute one-step forecast error

	// A8 change-point detection (CTS-lite, Mellor & Shapiro 2013): a
	// rolling window of the last-5 absolute one-step errors. When the
	// window's median exceeds 2σ (the running MAE above), the smoother is
	// systematically mispredicting — a regime break (difficulty step,
	// auction-floor change) — and Update resets the smoother so the next
	// observation re-seeds the level. The median (not the mean) keeps a
	// single outlier epoch from triggering a reset: an isolated spike
	// costs at most one window slot, while a real regime break fills
	// most of the window with large errors.
	errWin       [5]float64
	errPos       int // write position within errWin
	errWinFilled int // entries populated so far, capped at 5
	updates      int // lifetime observations; the reset check stays disarmed
	// for the first 2×window epochs while sigma (the MAE EWMA) converges —
	// a freshly-seeded forecaster reports near-zero sigma, so any consistent
	// nonzero error would otherwise look like a regime break.
}

// NewYieldForecaster returns a forecaster with the ADR-010 defaults for a
// seasonal cycle of period steps. period < 1 disables seasonality (pure
// Holt smoothing).
func NewYieldForecaster(period int) *YieldForecaster {
	f := &YieldForecaster{alpha: 0.3, beta: 0.05, gamma: 0.1, period: period}
	if period > 0 {
		f.seasonal = make([]float64, period)
	}
	return f
}

// Update folds one observation into the smoother and returns the absolute
// error of the forecast it would have made for this step (0 before the
// forecaster initializes — the first observation seeds the level) plus a
// flag telling whether the observation triggered an A8 regime reset.
func (f *YieldForecaster) Update(v float64) (err float64, reset bool) {
	if !f.initialized {
		f.level = v
		f.initialized = true
		f.filled = 1
		return 0, false
	}
	f.updates++
	pred := f.Predict(1)
	err = math.Abs(v - pred)

	var season float64
	if f.period > 0 {
		season = f.seasonal[f.idx]
	}
	prevLevel := f.level
	f.level = f.alpha*(v-season) + (1-f.alpha)*(f.level+f.trend)
	f.trend = f.beta*(f.level-prevLevel) + (1-f.beta)*f.trend
	if f.period > 0 {
		f.seasonal[f.idx] = f.gamma*(v-f.level) + (1-f.gamma)*f.seasonal[f.idx]
		f.idx = (f.idx + 1) % f.period
		if f.filled < f.period {
			f.filled++
		}
	} else if f.filled < math.MaxInt {
		f.filled++
	}

	// Residual EWMA at rate ~0.1 — sigma input for A8's 2σ regime test.
	f.mae = 0.9*f.mae + 0.1*err

	f.errWin[f.errPos] = err
	f.errPos = (f.errPos + 1) % len(f.errWin)
	if f.errWinFilled < len(f.errWin) {
		f.errWinFilled++
	}
	if f.errWinFilled == len(f.errWin) && f.updates >= 2*len(f.errWin) &&
		f.mae > 0 && median5(f.errWin) > 2*f.mae {
		f.reset()
		return err, true
	}
	return err, false
}

// reset clears the smoothed state after an A8 regime break so the next
// observation re-seeds the level from the new regime. The running MAE is
// kept — it decays naturally as post-reset errors shrink — but the error
// window is cleared so a second reset needs five fresh misses.
func (f *YieldForecaster) reset() {
	f.level, f.trend = 0, 0
	for i := range f.seasonal {
		f.seasonal[i] = 0
	}
	f.idx, f.filled = 0, 0
	f.initialized = false
	f.errWin = [5]float64{}
	f.errPos, f.errWinFilled = 0, 0
	// f.updates deliberately survives the reset: the warm-up gate counts
	// lifetime observations, and a forecaster that already calibrated once
	// may immediately re-arm after a break.
}

// median5 returns the median of a 5-element window (insertion sort — the
// window is tiny and stays fixed-size, so no allocation is needed).
func median5(w [5]float64) float64 {
	a := w
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
	return a[2]
}

// Predict returns the forecast yield steps ahead of the latest
// observation. The seasonal term wraps within the observed cycle; before
// the first full season completes it degrades to level+steps·trend.
func (f *YieldForecaster) Predict(steps int) float64 {
	if !f.initialized {
		return 0
	}
	pred := f.level + float64(steps)*f.trend
	if f.period > 0 && f.filled > 0 {
		sIdx := (f.idx + steps - 1) % f.period
		if sIdx < 0 {
			sIdx += f.period
		}
		pred += f.seasonal[sIdx]
	}
	if pred < 0 {
		return 0 // yield is a rate; negative forecasts are meaningless
	}
	return pred
}

// Sigma is the running mean-absolute one-step error — the scale ADR-010
// A8's "5-epoch MA shifts > 2σ" reset compares against.
func (f *YieldForecaster) Sigma() float64 { return f.mae }
