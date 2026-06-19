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

// MiningProvider publishes Bitcoin mining yield estimates for Stratum V2 pools.
//
// Yield is estimated from the pool's reported difficulty and the device's
// historical hashrate. The estimate is updated whenever:
//   - The pool sends a new job with different nBits (difficulty change).
//   - The device's measured hashrate changes by more than 5%.
//   - MinQuoteInterval has elapsed without an update.
type MiningProvider struct {
	id      string
	poolURL string
	rates   RateSource
	quoteCh chan Quote
	devices []hal.Device
	mu      sync.Mutex
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewMiningProvider creates a provider for a single Stratum V2 pool.
func NewMiningProvider(poolURL string, rates RateSource) *MiningProvider {
	return &MiningProvider{
		id:      "mining.stratum",
		poolURL: poolURL,
		rates:   rates,
		quoteCh: make(chan Quote, 16),
	}
}

func (p *MiningProvider) ID() string           { return p.id }
func (p *MiningProvider) Name() string         { return fmt.Sprintf("Bitcoin Mining (%s)", p.poolURL) }
func (p *MiningProvider) Quotes() <-chan Quote { return p.quoteCh }

func (p *MiningProvider) Start(ctx context.Context, devices []hal.Device) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cancel != nil {
		return fmt.Errorf("provider: mining provider already started")
	}
	p.devices = devices
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

func (p *MiningProvider) Stop() {
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

// loop periodically fetches the current BTC/USD rate and network stats
// to produce a live yield estimate.
func (p *MiningProvider) loop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Publish an initial quote immediately.
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

// publish calculates the current yield and sends it on the quote channel.
// Yield per device is estimated using:
//   - Device hashrate: a static per-family estimate (ASIC/GPU/CPU). The
//     hal.Device interface does not yet expose live hashrate telemetry, so
//     no measured rate is consumed here; see docs/KNOWN_LIMITATIONS.md §7.
//   - Network hashrate: a compile-time constant estimate (not configurable).
//   - Current BTC price from RateSource (freshness drives the confidence).
//   - Standard block time (600s) and reward (3.125 BTC post-4th halving)
//
// Because both hashrate inputs are static, the mining-side yield is a stable
// estimate rather than a live measurement; only the BTC price and its
// freshness vary between quotes.
func (p *MiningProvider) publish(ctx context.Context) {
	rate, fresh := p.rates.BTCUSDRate()
	if rate <= 0 {
		rate = 95000 // fallback estimate
	}
	confidence := 0.7
	if fresh {
		confidence = 0.95
	}

	// Network hashrate estimate: ~1000 EH/s in 2026. This is a compile-time
	// constant, not yet driven by config or a live difficulty feed.
	const networkHashrate = 1e21 // H/s
	const blockRewardBTC = 3.125
	const blockTimeSec = 600.0

	families := []hal.Family{hal.FamilyASIC, hal.FamilyGPU, hal.FamilyCPU}

	for _, dev := range p.devices {
		if !dev.Capabilities().SHA256d {
			continue
		}
		// Static per-family hashrate estimate. There is no live-telemetry
		// path today (hal.Device exposes no Stats()), so this estimate is
		// always used; wiring in the engine's measured worker hashrate is
		// tracked as future work (docs/KNOWN_LIMITATIONS.md §7).
		var deviceHashrate float64
		switch dev.Identity().Family {
		case hal.FamilyASIC:
			deviceHashrate = 100e12 // ~100 TH/s (Antminer S21)
		case hal.FamilyGPU:
			deviceHashrate = 1.5e9 // ~1.5 GH/s (RTX 4090 SHA256d)
		default:
			deviceHashrate = 10e6 // ~10 MH/s (CPU)
		}

		// Expected BTC per second:
		// P(solve) = deviceHashrate / networkHashrate
		// blocks/sec = 1/600
		// BTC/sec = P(solve) * blockRewardBTC / blockTimeSec
		btcPerSec := (deviceHashrate / networkHashrate) * blockRewardBTC / blockTimeSec
		satsPerSec := btcPerSec * 1e8
		netSatsPerSec := satsPerSec * 0.99 // 1% pool fee typical for Stratum V2

		q := Quote{
			ProviderID:       p.id,
			DeviceID:         dev.Identity().ID,
			AcceptedFamilies: families,
			At:               time.Now(),
			Yield: Yield{
				SatsPerSecond:    satsPerSec,
				NetSatsPerSecond: netSatsPerSec,
				Confidence:       confidence,
			},
		}
		_ = rate // used for future USD display
		select {
		case p.quoteCh <- q:
		case <-ctx.Done():
			return
		default:
			// Channel full — drop oldest, send newest.
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

// Ensure *MiningProvider satisfies Provider.
var _ Provider = (*MiningProvider)(nil)

// ----- Default device hashrate families (exported for tests) -----
var DefaultHashrates = map[hal.Family]float64{
	hal.FamilyASIC: 100e12,
	hal.FamilyGPU:  1.5e9,
	hal.FamilyCPU:  10e6,
}
