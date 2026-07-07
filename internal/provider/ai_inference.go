// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// AkashProvider publishes AI inference yield estimates for GPU devices
// via the Akash Network decentralized compute marketplace.
//
// # Why Akash
//
// Akash is an open, permissionless cloud compute marketplace where
// providers (anyone with spare GPU capacity) offer compute to bidders.
// It is non-custodial: providers receive AKT tokens directly to their
// wallet with no platform holding funds. This aligns with Otedama's
// non-custodial philosophy.
//
// # Yield vs Bitcoin Mining
//
// GPU revenue comparison (RTX 4090, April 2026 estimates):
//
//	Bitcoin mining:  ~$0.05/day  (SV2, 1% pool fee)
//	AI inference:    ~$8-14/day  (Akash, LLM/image models)
//
// The arbitration engine will route GPUs to Akash when AI demand is
// high and back to Bitcoin mining during low-demand periods.
//
// # Implementation status (v3.0.0-alpha)
//
// This provider simulates market conditions as a fixed price: every
// quote uses the midpoint of the configured [MinUSDPerHour,
// MaxUSDPerHour] range (no randomness, no time-varying process — see
// publish() below). Real Akash API integration (bid submission,
// container management) is implemented in v3.1.0. The provider
// interface and yield calculation are stable and ready for the full
// integration.
type AkashProvider struct {
	pollingProvider
	id      string
	rates   RateSource
	devices []hal.Device

	// Configurable pricing floor and ceiling in USD/hour per GPU.
	MinUSDPerHour float64
	MaxUSDPerHour float64
}

// NewAkashProvider creates an AI inference provider using Akash Network.
func NewAkashProvider(rates RateSource) *AkashProvider {
	return &AkashProvider{
		pollingProvider: pollingProvider{
			quoteCh:  make(chan Quote, 32),
			interval: 60 * time.Second,
		},
		id:            "ai.akash",
		rates:         rates,
		MinUSDPerHour: 0.30, // market floor
		MaxUSDPerHour: 0.60, // peak inference demand
	}
}

func (p *AkashProvider) ID() string { return p.id }

// Name identifies this provider. The "(simulated)" suffix is
// deliberate and load-bearing: in v3.0.0-alpha this provider quotes a
// fixed price (the midpoint of MinUSDPerHour/MaxUSDPerHour, unchanging
// tick to tick — see publish()) rather than querying the live Akash
// Network REST API for real market conditions. The suffix ensures the
// simulation is visible everywhere the provider name is shown — the
// TUI, logs, and `config show` — so a user never mistakes simulated
// inference yield for real income. Removing the suffix is gated on the
// real REST integration landing (ROADMAP v3.1.0).
func (p *AkashProvider) Name() string { return "AI Inference (Akash Network, simulated)" }

// Start filters the device set to GPUs (CPUs cannot run AI inference at
// competitive throughput) and begins the polling loop.
func (p *AkashProvider) Start(ctx context.Context, devices []hal.Device) error {
	return p.launch(ctx, "akash", func() {
		var gpus []hal.Device
		for _, d := range devices {
			if d.Identity().Family == hal.FamilyGPU && d.Capabilities().GeneralCompute {
				gpus = append(gpus, d)
			}
		}
		p.devices = gpus
	}, p.publish)
}

func (p *AkashProvider) publish(ctx context.Context) {
	if len(p.devices) == 0 {
		// No GPU devices — send a zero-yield quote so arbitration can
		// exclude this provider gracefully.
		p.sendQuote(ctx, Quote{
			ProviderID:       p.id,
			AcceptedFamilies: []hal.Family{hal.FamilyGPU},
			At:               time.Now(),
			Yield:            Yield{Confidence: 0},
		})
		return
	}

	rate, fresh := p.rates.BTCUSDRate()
	if rate <= 0 {
		rate = 95000
	}
	confidence := 0.6
	if fresh {
		confidence = 0.85
	}

	// Use mid-point of market range as the current quote.
	// Real implementation: query Akash REST API for active bids.
	usdPerHour := (p.MinUSDPerHour + p.MaxUSDPerHour) / 2.0
	// Akash takes ~20% platform fee.
	netUSDPerHour := usdPerHour * 0.80

	for _, dev := range p.devices {
		sats := SatsPerSecond(usdPerHour, rate)
		netSats := SatsPerSecond(netUSDPerHour, rate)

		q := Quote{
			ProviderID:       p.id,
			DeviceID:         dev.Identity().ID,
			AcceptedFamilies: []hal.Family{hal.FamilyGPU},
			At:               time.Now(),
			Yield: Yield{
				SatsPerSecond:    sats,
				NetSatsPerSecond: netSats,
				Confidence:       confidence,
			},
		}
		if !p.sendQuote(ctx, q) {
			return
		}
	}
}

var _ Provider = (*AkashProvider)(nil)

// ----- Static rate source (for tests/offline mode) -----

// StaticRateSource returns a fixed BTC/USD rate. Useful in tests and
// for configurations that do not want live price fetching.
type StaticRateSource struct {
	Rate float64
}

func (s StaticRateSource) BTCUSDRate() (float64, bool) {
	return s.Rate, true
}
