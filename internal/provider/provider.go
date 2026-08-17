// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package provider defines the interface between Otedama's arbitration
// engine and the external workload markets it connects to.
//
// # Why This Exists
//
// The arbitration engine (internal/arbitration) is a pure function that
// takes yield quotes and returns an allocation. But it needs live yield
// data from somewhere. That is the job of providers: each provider
// connects to one external market (a mining pool, an AI-inference
// marketplace, a rendering farm, a scientific grid) and continuously
// publishes what it will pay for the user's hardware right now.
//
// # Provider Contract
//
// A Provider implementation must:
//
//  1. Implement Provider.Start, which begins the quote loop and returns
//     immediately. Quotes are published asynchronously on the channel
//     returned by Provider.Quotes.
//
//  2. Publish at least one quote per MinQuoteInterval. If the external
//     market is unreachable, the provider should publish a Yield of
//     {SatsPerSecond:0, Confidence:0} rather than going silent, so that
//     the arbitration engine can route away from the unavailable market.
//
//  3. Honour context cancellation: when ctx is cancelled, the quote
//     channel must be closed and all goroutines must exit.
//
// # Which external markets fit this interface
//
// This interface assumes an Akash-shaped market: the user is a provider
// whose payout is non-custodial (settles to the user's own wallet /
// on-chain address) and whose price is discovered per-order (on-chain
// bidding for Akash — see docs/adr/ADR-010 Feature A4). Verified during
// the session-251 research pass, the obvious "add more GPU markets"
// candidates do NOT fit and are deliberately out of scope:
//
//   - Render Network intermediates payouts centrally in RNDR tokens
//     (burn-and-mint), and
//   - io.net centrally determines pricing with staking-based supplier
//     onboarding — neither exposes an open provider-side bidding/pricing
//     API.
//
// Both are custodial and centrally-priced, which conflicts with ADR-001
// (non-custodial) and CLAUDE.md's prohibition on custodial/centralized
// components. They are recorded here so a future contributor does not
// naively add them as Provider implementations: doing so would require a
// custodial integration this interface is specifically shaped to avoid.
// (Sources: github.com/rendernetwork/RNPs RNP-005; github.com/api-evangelist/io-net)
//
// # Revenue comparison (2026-04 estimates)
//
// Corrected (session 243): GPUs cannot mine Bitcoin in this codebase today
// — internal/hal reports Capabilities.SHA256d = false for every GPU because
// no CUDA/ROCm/Vulkan compute dispatch is implemented anywhere (see
// docs/KNOWN_LIMITATIONS.md §4). This table previously listed a "RTX 4090
// GPU Bitcoin mining" figure as if that were a real, reachable code path;
// it is not. The two real-today numbers are:
//
//	CPU  Bitcoin mining (any host): ~0.07 sats/s  ($0.000064/day)
//	RTX 4090 GPU  AI inference (simulated): ~14k  sats/s  ($12/day)
//
// A GPU is therefore never routed between mining and AI inference — it can
// only ever go to the (simulated) AI-inference stream or idle. The
// arbitration engine's live routing decision today is CPU-only: whether the
// CPU itself is worth dedicating to mining versus idling under the
// profitability floor. Once a GPU compute-dispatch driver lands, this
// comment should be updated with a real three-way comparison.
package provider

import (
	"context"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// MinQuoteInterval is the minimum time between consecutive yield quotes
// from a healthy provider. Providers that are slower than this are
// treated as temporarily unavailable.
const MinQuoteInterval = 30 * time.Second

// Yield describes the expected revenue rate a provider will pay for
// a device, expressed in satoshis per second.
//
// Using sat/s across all providers gives the arbitration engine a
// single unit for comparison. Providers convert their native units
// (USD/hour, credits/GPU-minute) to sat/s using a live BTC/USD rate
// from their own feed or from an injected RateSource.
type Yield struct {
	// SatsPerSecond is the gross expected revenue rate, pre-fees.
	SatsPerSecond float64

	// NetSatsPerSecond is SatsPerSecond minus the provider's fee.
	// If the provider has no explicit fee, this equals SatsPerSecond.
	NetSatsPerSecond float64

	// Confidence is the reliability of this quote, in [0,1].
	// 1.0 = firm, real-time market data.
	// 0.5 = estimated from recent history.
	// 0.0 = provider unreachable; yield is unknown.
	Confidence float64
}

// Effective returns the confidence-weighted net yield: the figure markets
// are compared on.
//
// The engine reaches the same value by a different route — it copies
// NetSatsPerSecond and Confidence into an arbitration.Yield (see
// engine.comparableYield) and lets the arbitration package apply the
// confidence weighting, so the comparison stays inside that package's own
// scoring. This method is the direct form, used where a provider quote needs
// to be ranked without building a Stream. Both compute net × confidence; if
// you change one, change the other.
func (y Yield) Effective() float64 {
	if y.NetSatsPerSecond <= 0 || y.Confidence <= 0 {
		return 0
	}
	return y.NetSatsPerSecond * y.Confidence
}

// Quote is a yield update published by a provider.
type Quote struct {
	// ProviderID identifies which provider issued this quote.
	ProviderID string

	// DeviceID is the hal.Identity.ID this quote applies to.
	// An empty DeviceID means the quote applies to any compatible device.
	DeviceID string

	// Yield is the current yield estimate.
	Yield Yield

	// AcceptedFamilies lists the device families this provider accepts.
	// A nil slice means all families are accepted.
	AcceptedFamilies []hal.Family

	// At is the wall-clock time the quote was generated.
	At time.Time
}

// Provider is the interface implemented by each external workload market.
type Provider interface {
	// ID returns the unique, stable identifier for this provider.
	// Format: "category.name", e.g. "mining.braiins", "ai.akash", "render.rendernet".
	ID() string

	// Name returns a human-readable display name.
	Name() string

	// Start begins the quote loop. Quotes are published on the channel
	// returned by Quotes(). Start must return immediately; the loop runs
	// in background goroutines. Start must only be called once.
	Start(ctx context.Context, devices []hal.Device) error

	// Quotes returns the channel on which this provider publishes yield
	// updates. The channel is closed when the provider stops.
	Quotes() <-chan Quote

	// Stop signals the provider to shut down and waits for completion.
	// Safe to call even if Start was never called.
	Stop()
}

// RateSource provides the current BTC/USD exchange rate.
// Providers use this to convert fiat-denominated yields to sat/s.
type RateSource interface {
	// BTCUSDRate returns the current BTC/USD rate and whether the rate
	// is fresh (fetched within the last 5 minutes).
	BTCUSDRate() (rate float64, fresh bool)
}

// SatsPerSecond converts a USD-per-hour yield to sat/s using rate.
// If rate is zero or negative, returns 0.
func SatsPerSecond(usdPerHour, btcUSDRate float64) float64 {
	if btcUSDRate <= 0 || usdPerHour <= 0 {
		return 0
	}
	// 1 BTC = 1e8 sats; 1 hour = 3600 seconds
	return (usdPerHour / btcUSDRate) * 1e8 / 3600
}
