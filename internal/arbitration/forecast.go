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
// forecaster initializes — the first observation seeds the level).
func (f *YieldForecaster) Update(v float64) float64 {
	if !f.initialized {
		f.level = v
		f.initialized = true
		f.filled = 1
		return 0
	}
	pred := f.Predict(1)
	err := math.Abs(v - pred)

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
	return err
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
