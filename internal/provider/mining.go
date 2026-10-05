// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"fmt"
	"sync/atomic"
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
//
// The start/stop/loop/send lifecycle lives in the embedded pollingProvider;
// only the Bitcoin-specific yield calculation (publish) is defined here.
type MiningProvider struct {
	pollingProvider
	id      string
	poolURL string
	rates   RateSource
	devices []hal.Device

	// HashrateFunc, if non-nil, is called with each device's ID during
	// publish() to obtain its current measured hashrate (H/s). When it
	// returns a value > 0, that figure is used instead of the static
	// per-family estimate (ASIC/GPU/CPU constants), making the yield quote
	// reflect actual hardware performance rather than a family average.
	// Zero or negative return values cause publish() to fall back to the
	// static estimate, preserving the pre-wiring behavior when the engine
	// has not yet produced a hashrate measurement (e.g. first few seconds).
	// Setting this field after Start is called is not safe.
	HashrateFunc func(deviceID string) float64

	// NetworkHashrateFunc, when set, returns the live network-hashrate
	// estimate (H/s) and a freshness flag (rates.HashrateFetcher).
	// publish() prefers a fresh reading over the compile-time constant;
	// nil or stale readings fall back to it (KNOWN_LIMITATIONS §7).
	NetworkHashrateFunc func() (hps float64, fresh bool)

	// payoutScheme names the configured pool's payout_scheme
	// (fpps/pplns/tides/solo; empty = unset). publish() uses it to pick
	// the net-fee factor: under "solo" the coinbase pays the user's
	// address directly and the reward is all-or-nothing — no pool-side
	// cut exists in the reward itself, so the net yield carries no fee
	// haircut. Any other scheme (or unset) keeps the 1% typical-fee
	// haircut. Stored atomically because the engine updates it on every
	// pool session so the quote tracks the pool actually being mined
	// against, including after failover — see SetPayoutScheme.
	payoutScheme atomic.Pointer[string]
}

// NewMiningProvider creates a provider for a single Stratum V2 pool.
func NewMiningProvider(poolURL string, rates RateSource) *MiningProvider {
	return &MiningProvider{
		pollingProvider: pollingProvider{
			quoteCh:  make(chan Quote, 16),
			interval: 30 * time.Second,
		},
		id:      "mining.stratum",
		poolURL: poolURL,
		rates:   rates,
	}
}

func (p *MiningProvider) ID() string   { return p.id }
func (p *MiningProvider) Name() string { return fmt.Sprintf("Bitcoin Mining (%s)", p.poolURL) }

// SetPayoutScheme records the payout_scheme of the pool the quote
// prices (fpps/pplns/tides/solo; empty = unset). Safe to call at any
// time — the engine calls it once per pool session so failover to a
// differently-schemed pool reprices subsequent quotes.
func (p *MiningProvider) SetPayoutScheme(scheme string) {
	p.payoutScheme.Store(&scheme)
}

// PayoutScheme returns the scheme currently in force for quote pricing
// ("" when unset).
func (p *MiningProvider) PayoutScheme() string {
	if s := p.payoutScheme.Load(); s != nil {
		return *s
	}
	return ""
}

func (p *MiningProvider) Start(ctx context.Context, devices []hal.Device) error {
	return p.launch(ctx, "mining provider", func() { p.devices = devices }, p.publish)
}

// publish calculates the current yield and sends it on the quote channel.
// Yield per device is estimated using:
//   - Device hashrate: the engine's live worker.Stats().HashRate when
//     HashrateFunc is set and returns > 0; otherwise a static per-family
//     estimate (ASIC/GPU/CPU). See docs/KNOWN_LIMITATIONS.md §7.
//   - Network hashrate: a compile-time constant estimate (not configurable).
//   - Current BTC price from RateSource (freshness drives the confidence).
//   - Standard block time (600s) and reward (3.125 BTC post-4th halving)
func (p *MiningProvider) publish(ctx context.Context) {
	// Mining yield is BTC-native (sats/sec from hashrate share × block
	// reward) — the USD rate itself is unused; only its freshness feeds
	// the quote's confidence.
	_, fresh := p.rates.BTCUSDRate()
	confidence := 0.7
	if fresh {
		confidence = 0.95
	}

	// Network hashrate: prefer the live feed (rates.HashrateFetcher via
	// NetworkHashrateFunc); fall back to the compile-time ~1000 EH/s
	// constant when the feed is unwired or stale. A wired-but-stale feed
	// means the operator configured a better input that has degraded —
	// the constant it falls back to could be off by the drift since the
	// last reading, so the quote drops to the same degraded-input tier
	// as a stale price feed rather than claiming full confidence.
	networkHashrate := 1e21 // H/s
	if p.NetworkHashrateFunc != nil {
		if h, hashFresh := p.NetworkHashrateFunc(); hashFresh && h > 0 {
			networkHashrate = h
		} else if confidence > 0.7 {
			confidence = 0.7
		}
	}
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
			switch dev.Identity().Family {
			case hal.FamilyASIC:
				deviceHashrate = 100e12 // ~100 TH/s (Antminer S21)
			case hal.FamilyGPU:
				deviceHashrate = 1.5e9 // ~1.5 GH/s (RTX 4090 SHA256d)
			default:
				deviceHashrate = 10e6 // ~10 MH/s (CPU)
			}
		}

		// Expected BTC per second:
		// P(solve) = deviceHashrate / networkHashrate
		// blocks/sec = 1/600
		// BTC/sec = P(solve) * blockRewardBTC / blockTimeSec
		btcPerSec := (deviceHashrate / networkHashrate) * blockRewardBTC / blockTimeSec
		satsPerSec := btcPerSec * 1e8
		netSatsPerSec := satsPerSec * 0.99 // 1% pool fee typical for Stratum V2
		if p.PayoutScheme() == "solo" {
			// The coinbase pays the user's address directly — the reward
			// is all-or-nothing with no pool-side cut in the reward itself.
			netSatsPerSec = satsPerSec
		}

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
		if !p.sendQuote(ctx, &q) {
			return
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
