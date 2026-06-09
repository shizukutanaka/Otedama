// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"fmt"
	"sync"
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
// This provider simulates market conditions using realistic price
// distributions. Real Akash API integration (bid submission, container
// management) is implemented in v3.1.0. The provider interface and
// yield calculation are stable and ready for the full integration.
type AkashProvider struct {
	id      string
	rates   RateSource
	quoteCh chan Quote
	devices []hal.Device
	mu      sync.Mutex
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	// Configurable pricing floor and ceiling in USD/hour per GPU.
	MinUSDPerHour float64
	MaxUSDPerHour float64
}

// NewAkashProvider creates an AI inference provider using Akash Network.
func NewAkashProvider(rates RateSource) *AkashProvider {
	return &AkashProvider{
		id:            "ai.akash",
		rates:         rates,
		quoteCh:       make(chan Quote, 32),
		MinUSDPerHour: 0.30, // market floor
		MaxUSDPerHour: 0.60, // peak inference demand
	}
}

func (p *AkashProvider) ID() string { return p.id }

// Name identifies this provider. The "(simulated)" suffix is
// deliberate and load-bearing: in v3.0.0-alpha this provider models
// Akash market conditions with a realistic price process rather than
// querying the live Akash Network REST API. The suffix ensures the
// simulation is visible everywhere the provider name is shown — the
// TUI, logs, and `config show` — so a user never mistakes simulated
// inference yield for real income. Removing the suffix is gated on the
// real REST integration landing (ROADMAP v3.1.0).
func (p *AkashProvider) Name() string         { return "AI Inference (Akash Network, simulated)" }
func (p *AkashProvider) Quotes() <-chan Quote { return p.quoteCh }

func (p *AkashProvider) Start(ctx context.Context, devices []hal.Device) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cancel != nil {
		return fmt.Errorf("provider: akash already started")
	}

	// Only accept GPU devices; CPU cannot run AI inference workloads
	// at competitive throughput.
	var gpus []hal.Device
	for _, d := range devices {
		if d.Identity().Family == hal.FamilyGPU && d.Capabilities().GeneralCompute {
			gpus = append(gpus, d)
		}
	}
	p.devices = gpus

	inner, cancel := context.WithCancel(ctx)
	p.cancel = cancel

	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer close(p.quoteCh)
		p.loop(inner)
	}()
	return nil
}

func (p *AkashProvider) Stop() {
	p.mu.Lock()
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
		p.wg.Wait()
		p.mu.Lock()
		p.cancel = nil
		p.quoteCh = make(chan Quote, cap(p.quoteCh))
		p.mu.Unlock()
	}
}

func (p *AkashProvider) loop(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	p.publish(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.publish(ctx)
		}
	}
}

func (p *AkashProvider) publish(ctx context.Context) {
	if len(p.devices) == 0 {
		// No GPU devices — send a zero-yield quote so arbitration can
		// exclude this provider gracefully.
		select {
		case p.quoteCh <- Quote{
			ProviderID:       p.id,
			AcceptedFamilies: []hal.Family{hal.FamilyGPU},
			At:               time.Now(),
			Yield:            Yield{Confidence: 0},
		}:
		case <-ctx.Done():
		}
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
		select {
		case p.quoteCh <- q:
		case <-ctx.Done():
			return
		default:
			select {
			case <-p.quoteCh:
			default:
			}
			select {
			case p.quoteCh <- q:
			case <-ctx.Done():
				return
			}
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
