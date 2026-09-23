// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// MiningProviderID is the canonical identifier of the built-in mining
// provider. The engine compares quotes against it to flag the
// BTC-denominated mining stream (arbitration.Stream.IsBitcoinMining) and
// to mark the corresponding TUI row as the mining market.
const MiningProviderID = "mining.stratum"

// MiningProvider publishes Bitcoin mining yield estimates for Stratum V2 pools.
//
// Yield is estimated from the pool's reported difficulty and the device's
// historical hashrate. The estimate is updated whenever:
//   - The pool sends a new job with different nBits (difficulty change).
//   - The device's measured hashrate changes by more than 5%.
//   - MinQuoteInterval has elapsed without an update.
//
// The start/stop/loop/send lifecycle lives in the embedded pollingProvider;
// only the Bitcoin-specific yield calculation (publish) is defined here.
type MiningProvider struct {
	pollingProvider
	id      string
	poolURL string
	devices []hal.Device

	// HashrateFunc, if non-nil, is called with each device's ID during
	// publish() to obtain its current measured hashrate (H/s). When it
	// returns a value > 0, that figure is used instead of the static
	// per-family estimate (ASIC/GPU/CPU constants), making the yield quote
	// reflect actual hardware performance rather than a family average.
	// Zero or negative return values cause publish() to fall back to the
	// static estimate, preserving the pre-wiring behaviour when the engine
	// has not yet produced a hashrate measurement (e.g. first few seconds).
	// Setting this field after Start is called is not safe.
	HashrateFunc func(deviceID string) float64
}

// NewMiningProvider creates a provider for a single Stratum V2 pool.
// The rates argument is retained for signature stability and a future
// USD-display path — the mining yield itself (sats/s = hashrate share ×
// block reward) is BTC-price-independent and does not consult it.
func NewMiningProvider(poolURL string, _ RateSource) *MiningProvider {
	return &MiningProvider{
		pollingProvider: pollingProvider{
			quoteCh:  make(chan Quote, 16),
			interval: 30 * time.Second,
		},
		id:      MiningProviderID,
		poolURL: poolURL,
	}
}

func (p *MiningProvider) ID() string   { return p.id }
func (p *MiningProvider) Name() string { return fmt.Sprintf("Bitcoin Mining (%s)", p.poolURL) }

func (p *MiningProvider) Start(ctx context.Context, devices []hal.Device) error {
	return p.launch(ctx, "mining provider", func() { p.devices = devices }, p.publish)
}

// publish calculates the current yield and sends it on the quote channel.
// Yield per device is estimated using:
//   - Device hashrate: the engine's live worker.Stats().HashRate when
//     HashrateFunc is set and returns > 0; otherwise a static per-family
//     estimate (ASIC/GPU/CPU). See docs/KNOWN_LIMITATIONS.md §7.
//   - Network hashrate: a compile-time constant estimate (not configurable).
//   - Standard block time (600s) and reward (3.125 BTC post-4th halving)
//
// Note the BTC/USD rate does NOT feed this quote: mining yield in sats/s
// is hashrate-share × block-reward — a pure BTC quantity, so a rate outage
// must not degrade this quote's confidence (the fiat price only matters
// for USD display and for converting fiat-denominated yields like Akash's,
// which is why AkashProvider does consult the rate).
func (p *MiningProvider) publish(ctx context.Context) {
	// Confidence reflects the static-estimate inputs (compile-time network
	// hashrate, per-family fallback hashrate), not external feed health.
	const confidence = 0.85

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
		// Prefer live measured hashrate (from the engine's worker stats)
		// when available; fall back to the static per-family estimate.
		var deviceHashrate float64
		if p.HashrateFunc != nil {
			deviceHashrate = p.HashrateFunc(dev.Identity().ID)
		}
		if deviceHashrate <= 0 {
			deviceHashrate = DefaultHashrates[dev.Identity().Family]
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
		if !p.sendQuote(ctx, q) {
			return
		}
	}
}

// Ensure *MiningProvider satisfies Provider.
var _ Provider = (*MiningProvider)(nil)

// ----- Default device hashrate families -----
//
// Static per-family hashrate estimates used when no live measurement is
// available (HashrateFunc unset or returning <= 0). ASIC ~100 TH/s
// (Antminer S21), GPU ~1.5 GH/s (RTX 4090 SHA256d, forward-looking —
// GPUs currently report SHA256d=false and are skipped above), CPU
// ~10 MH/s.
var DefaultHashrates = map[hal.Family]float64{
	hal.FamilyASIC: 100e12,
	hal.FamilyGPU:  1.5e9,
	hal.FamilyCPU:  10e6,
}
