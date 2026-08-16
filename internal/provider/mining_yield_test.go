// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Magnitude tests for the Bitcoin mining yield estimate.
//
// The sibling tests in provider_test.go check the mechanics — which device
// branch runs, whether HashrateFunc is consulted, that a quote arrives per
// device — and assert only that the yield is greater than zero. A yield off
// by a factor of 2^32 (a dropped hashes-per-difficulty term), or by 2×
// (a stale halving constant), passes all of them.
//
// That matters because this number is one of the two inputs the arbitration
// engine weighs: it decides whether a device mines Bitcoin or sells its
// cycles elsewhere. A yield that is wrong by a constant factor is not a
// cosmetic display bug — it is a permanently wrong allocation.
//
// The model, from standard mining economics:
//
//	E[revenue] = deviceHashrate × subsidy / expectedHashesPerBlock
//	expectedHashesPerBlock = networkDifficulty × 2^32
//
// The 2^32 factor is the number of hashes that must be tried, on average,
// to find one at difficulty 1; the same constant appears in the engine's
// expected-share-interval metric (D × 2^32 / hashrate, engine/stats.go).
// The two must be talking about the same network for the product's numbers
// to be coherent, so this file derives the expectation through difficulty
// while publish() computes it through network hashrate, and checks the two
// paths land on the same value.
package provider

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// The assumptions publish() is built on. These are duplicated here on
// purpose: if someone changes a constant in mining.go, this test fails and
// makes them restate the assumption rather than silently shifting every
// yield the arbitration engine sees.
const (
	assumedNetworkHashrate = 1e21  // H/s (~1000 EH/s, the 2026 estimate)
	assumedBlockSubsidyBTC = 3.125 // BTC, post-4th-halving (April 2024)
	assumedBlockTimeSec    = 600.0
	assumedPoolFee         = 0.01 // 1%
	hashesPerDifficulty    = 4294967296.0
	satsPerBTC             = 1e8
)

// quoteForHashrate runs the provider once with a pinned device hashrate and
// returns the resulting quote.
func quoteForHashrate(t *testing.T, hashrate float64) Quote {
	t.Helper()
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", StaticRateSource{Rate: 95000})
	p.HashrateFunc = func(string) float64 { return hashrate }

	devices := []hal.Device{
		&mockDevice{
			id:   hal.Identity{ID: "asic-0", Family: hal.FamilyASIC},
			caps: hal.Capabilities{SHA256d: true},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.Start(ctx, devices); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer p.Stop()

	select {
	case q, ok := <-p.Quotes():
		if !ok {
			t.Fatal("quote channel closed before a quote arrived")
		}
		return q
	case <-time.After(2 * time.Second):
		t.Fatal("no quote within 2s")
		return Quote{}
	}
}

// TestMiningYield_MatchesTheRevenueModel derives the expected satoshi rate
// through network *difficulty* and checks publish() — which works through
// network *hashrate* — agrees.
func TestMiningYield_MatchesTheRevenueModel(t *testing.T) {
	const deviceHashrate = 100e12 // 100 TH/s, an S21-class machine

	// Network hashrate and network difficulty are two views of the same
	// number: H = D × 2^32 / blockTime. Invert it to get the difficulty the
	// provider's constant implies, then price the device through the
	// revenue-per-hash form of the model.
	impliedDifficulty := assumedNetworkHashrate * assumedBlockTimeSec / hashesPerDifficulty
	expectedSatsPerSec := deviceHashrate * assumedBlockSubsidyBTC * satsPerBTC /
		(impliedDifficulty * hashesPerDifficulty)

	q := quoteForHashrate(t, deviceHashrate)
	if !closeEnough(q.Yield.SatsPerSecond, expectedSatsPerSec) {
		t.Errorf("SatsPerSecond = %g, want %g (ratio %.6g)\n"+
			"the yield no longer matches deviceHashrate × subsidy / (difficulty × 2^32)",
			q.Yield.SatsPerSecond, expectedSatsPerSec, q.Yield.SatsPerSecond/expectedSatsPerSec)
	}

	// Sanity in human terms: 100 TH/s against a ~1000 EH/s network should
	// earn single-digit dollars a day, not cents and not hundreds. This
	// catches an error of several orders of magnitude even if someone
	// "fixes" the constants above to match a broken implementation.
	satsPerDay := q.Yield.SatsPerSecond * 86400
	usdPerDay := satsPerDay / satsPerBTC * 95000
	if usdPerDay < 0.5 || usdPerDay > 50 {
		t.Errorf("100 TH/s earns $%.2f/day at $95k/BTC — implausible by orders of "+
			"magnitude for a ~1000 EH/s network", usdPerDay)
	}
}

// TestMiningYield_ImpliedDifficultyIsPlausible documents what the network
// hashrate constant means in the unit Bitcoin actually publishes, and fails
// if it drifts somewhere a real network has never been. Bitcoin's difficulty
// passed 100T in 2024; the band below is deliberately wide.
func TestMiningYield_ImpliedDifficultyIsPlausible(t *testing.T) {
	impliedDifficulty := assumedNetworkHashrate * assumedBlockTimeSec / hashesPerDifficulty
	const (
		minPlausible = 50e12  // ~50 T
		maxPlausible = 500e12 // ~500 T
	)
	if impliedDifficulty < minPlausible || impliedDifficulty > maxPlausible {
		t.Errorf("the network-hashrate constant implies difficulty %.3g, outside the "+
			"plausible band [%.3g, %.3g] — update the constant and this band together",
			impliedDifficulty, minPlausible, maxPlausible)
	}
}

// TestMiningYield_ScalesLinearlyWithHashrate pins the shape of the model,
// not just one point on it: revenue is linear in hashrate. A device twice as
// fast must be quoted twice the yield, or the arbitration engine cannot
// compare two devices meaningfully.
func TestMiningYield_ScalesLinearlyWithHashrate(t *testing.T) {
	single := quoteForHashrate(t, 50e12)
	double := quoteForHashrate(t, 100e12)

	if single.Yield.SatsPerSecond <= 0 {
		t.Fatalf("base yield = %g, want > 0", single.Yield.SatsPerSecond)
	}
	if ratio := double.Yield.SatsPerSecond / single.Yield.SatsPerSecond; !closeEnough(ratio, 2) {
		t.Errorf("doubling the hashrate changed the yield by %.6gx, want 2x", ratio)
	}
}

// TestMiningYield_PoolFeeIsDeductedFromNet checks the one adjustment between
// gross and net: the pool's cut. Net is what the arbitration engine should
// compare against other markets, so a missing deduction biases every
// decision toward mining.
func TestMiningYield_PoolFeeIsDeductedFromNet(t *testing.T) {
	q := quoteForHashrate(t, 100e12)
	want := q.Yield.SatsPerSecond * (1 - assumedPoolFee)
	if !closeEnough(q.Yield.NetSatsPerSecond, want) {
		t.Errorf("NetSatsPerSecond = %g, want %g (gross minus the %.0f%% pool fee)",
			q.Yield.NetSatsPerSecond, want, assumedPoolFee*100)
	}
	if q.Yield.NetSatsPerSecond >= q.Yield.SatsPerSecond {
		t.Error("net yield is not below gross — the pool fee is not being applied")
	}
}

// TestMiningYield_IsIndependentOfBTCPrice pins the denomination: the quote is
// in satoshis, so the BTC/USD rate must not scale it. Only Confidence moves
// with price freshness (the arbitration engine weighs this quote against a
// USD-denominated one, so a stale price makes the comparison less certain —
// it does not make the mining revenue itself smaller).
func TestMiningYield_IsIndependentOfBTCPrice(t *testing.T) {
	const deviceHashrate = 100e12
	run := func(rates RateSource) Quote {
		p := NewMiningProvider("stratum+v2://pool.example.com:3336", rates)
		p.HashrateFunc = func(string) float64 { return deviceHashrate }
		devices := []hal.Device{
			&mockDevice{
				id:   hal.Identity{ID: "asic-0", Family: hal.FamilyASIC},
				caps: hal.Capabilities{SHA256d: true},
			},
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := p.Start(ctx, devices); err != nil {
			t.Fatalf("Start: %v", err)
		}
		defer p.Stop()
		select {
		case q := <-p.Quotes():
			return q
		case <-time.After(2 * time.Second):
			t.Fatal("no quote within 2s")
			return Quote{}
		}
	}

	cheap := run(StaticRateSource{Rate: 30000})
	dear := run(StaticRateSource{Rate: 300000})
	if !closeEnough(cheap.Yield.SatsPerSecond, dear.Yield.SatsPerSecond) {
		t.Errorf("a 10x BTC price change moved the satoshi yield from %g to %g; "+
			"the quote is denominated in sats and must not scale with price",
			cheap.Yield.SatsPerSecond, dear.Yield.SatsPerSecond)
	}
}

// closeEnough compares two floats with a relative tolerance, so the tests
// above assert the model rather than the exact bit pattern of a float
// division.
func closeEnough(got, want float64) bool {
	if want == 0 {
		return got == 0
	}
	return math.Abs(got-want)/math.Abs(want) < 1e-9
}
