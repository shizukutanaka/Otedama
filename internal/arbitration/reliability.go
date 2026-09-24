// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

import (
	"math"
	"time"
)

// ReputationHalfLife is ADR-010 A7's reputation decay constant: evidence
// behind a provider's posterior loses half its weight every 168 h (one
// week). A demonstration attack — briefly inflating quote quality or
// share-acceptance to farm trust — decays automatically once the
// performance stops, and providers cannot rest on months-old reputation.
const ReputationHalfLife = 168 * time.Hour

// ProviderReliability is the Beta-Bernoulli posterior over a provider's
// "keeps quoting" event (ADR-010 feature A6). Each settled epoch — a
// staleness window a stream stayed continuously quoted (success) or a
// stream expiring mid-assignment (failure) — updates the posterior, and
// the posterior mean discounts the provider's future quotes so that
// chronically under-delivering providers lose arbitration rank.
//
// Alpha and Beta start at 1 (the uniform prior): an unseen provider is
// untrusted by default — posterior 0.5 — matching the adversarial stance
// of ADR-010 A7. Reliable streams converge toward 1.0 within a handful
// of windows; dead providers fall toward 0.
type ProviderReliability struct {
	alpha      float64
	beta       float64
	lastUpdate time.Time
}

// NewProviderReliability returns a reliability tracker with the uniform
// Beta(1,1) prior — posterior mean 0.5 until evidence accumulates.
func NewProviderReliability() *ProviderReliability {
	return &ProviderReliability{alpha: 1, beta: 1}
}

// Update records one settled epoch outcome at the wall clock — shorthand
// for UpdateAt(success, time.Now()).
func (r *ProviderReliability) Update(success bool) {
	r.UpdateAt(success, time.Now())
}

// UpdateAt records one settled epoch outcome as of now. The single
// pseudo-count added per epoch is A7's Δα ≤ 1 trust cap: no single
// observation, however favorable, can move the posterior by more than
// one Bernoulli outcome. Before the new evidence is tallied, already-
// accumulated counts decay toward the prior by ReputationHalfLife.
func (r *ProviderReliability) UpdateAt(success bool, now time.Time) {
	if !r.lastUpdate.IsZero() {
		r.decay(now.Sub(r.lastUpdate))
	}
	r.lastUpdate = now
	if success {
		r.alpha++
	} else {
		r.beta++
	}
}

// decay pulls accumulated evidence toward the Beta(1,1) prior — the
// counts, not the posterior mean — so evidence weight expires with the
// posterior it supports. A zero or negative elapsed time is a no-op
// (same-tick epochs, clock regressions).
func (r *ProviderReliability) decay(d time.Duration) {
	if d <= 0 {
		return
	}
	keep := math.Pow(0.5, d.Hours()/ReputationHalfLife.Hours())
	r.alpha = 1 + (r.alpha-1)*keep
	r.beta = 1 + (r.beta-1)*keep
}

// PosteriorMean is the Beta posterior mean, E[reliability], in (0, 1).
func (r *ProviderReliability) PosteriorMean() float64 {
	return r.alpha / (r.alpha + r.beta)
}

// Params returns the posterior's pseudo-counts (α successes, β failures),
// displayed by `arb explain` as evidence weight behind the posterior mean.
func (r *ProviderReliability) Params() (alpha, beta float64) {
	return r.alpha, r.beta
}
