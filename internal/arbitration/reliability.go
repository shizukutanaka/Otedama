// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package arbitration

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
	alpha float64
	beta  float64
}

// NewProviderReliability returns a reliability tracker with the uniform
// Beta(1,1) prior — posterior mean 0.5 until evidence accumulates.
func NewProviderReliability() *ProviderReliability {
	return &ProviderReliability{alpha: 1, beta: 1}
}

// Update records one settled epoch outcome.
func (r *ProviderReliability) Update(success bool) {
	if success {
		r.alpha++
	} else {
		r.beta++
	}
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
