// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Magnitude tests for the AI inference yield estimate, and for the
// cross-market comparison it exists to take part in.
//
// This is the companion to mining_yield_test.go. Session 259 pinned the
// mining side of the arbitration decision; without the same treatment here,
// half of the comparison is still only asserted to be greater than zero.
// The comparison itself is what the product is for, so it gets its own test
// rather than being left as an emergent property of two unrelated ones.
//
// The conversion under test is a unit change, not a model:
//
//	sats/sec = (USD/hour ÷ USD/BTC) × 1e8 ÷ 3600
//
// The interesting consequence is directional. Mining revenue is denominated
// in satoshis, so it does not move with BTC price. Inference revenue is
// denominated in USD, so its satoshi value moves inversely with price. That
// asymmetry — not any modelled "AI demand", which this provider does not
// simulate (KNOWN_LIMITATIONS §1) — is the only live signal that shifts the
// allocation today, so both directions are pinned below.
package provider

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

const (
	// Defaults set by NewAkashProvider, duplicated so a change to them
	// fails here and has to be restated rather than silently moving every
	// arbitration decision.
	assumedMinUSDPerHour = 0.30
	assumedMaxUSDPerHour = 0.60
	assumedAkashFee      = 0.20 // 20% platform fee
)

// gpuQuote runs the Akash provider once against a single GPU at the given
// BTC/USD rate and returns the quote.
func gpuQuote(t *testing.T, btcUSD float64) Quote {
	t.Helper()
	p := NewAkashProvider(StaticRateSource{Rate: btcUSD})
	devices := []hal.Device{
		&mockDevice{
			id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
			caps: hal.Capabilities{GeneralCompute: true},
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

// TestInferenceYield_MatchesTheUSDConversion checks the quote against the
// conversion computed independently from the provider's own defaults.
func TestInferenceYield_MatchesTheUSDConversion(t *testing.T) {
	const btcUSD = 95000.0
	usdPerHour := (assumedMinUSDPerHour + assumedMaxUSDPerHour) / 2
	expected := usdPerHour / btcUSD * satsPerBTC / 3600

	q := gpuQuote(t, btcUSD)
	if !closeEnough(q.Yield.SatsPerSecond, expected) {
		t.Errorf("SatsPerSecond = %g, want %g (ratio %.6g)",
			q.Yield.SatsPerSecond, expected, q.Yield.SatsPerSecond/expected)
	}

	// Sanity in the unit an operator would recognise: the midpoint of a
	// $0.30–0.60/hour band is roughly $10/day gross per GPU.
	usdPerDay := q.Yield.SatsPerSecond * 86400 / satsPerBTC * btcUSD
	if usdPerDay < 8 || usdPerDay > 15 {
		t.Errorf("gross yield is $%.2f/day, which is not the $%.2f/hour band this "+
			"provider is configured with", usdPerDay, usdPerHour)
	}
}

// TestInferenceYield_PlatformFeeIsDeducted pins the 20% Akash cut. Net is
// what arbitration should weigh, so a missing deduction biases every
// decision toward inference.
func TestInferenceYield_PlatformFeeIsDeducted(t *testing.T) {
	q := gpuQuote(t, 95000)
	want := q.Yield.SatsPerSecond * (1 - assumedAkashFee)
	if !closeEnough(q.Yield.NetSatsPerSecond, want) {
		t.Errorf("NetSatsPerSecond = %g, want %g (gross minus the %.0f%% platform fee)",
			q.Yield.NetSatsPerSecond, want, assumedAkashFee*100)
	}
}

// TestInferenceYield_MovesInverselyWithBTCPrice is the directional half of
// the comparison: a USD-denominated revenue is worth fewer satoshis as BTC
// appreciates. Mining's satoshi yield is flat across the same change
// (TestMiningYield_IsIndependentOfBTCPrice), so this is the mechanism that
// actually moves the allocation.
func TestInferenceYield_MovesInverselyWithBTCPrice(t *testing.T) {
	cheap := gpuQuote(t, 30000)
	dear := gpuQuote(t, 300000)

	if cheap.Yield.SatsPerSecond <= dear.Yield.SatsPerSecond {
		t.Fatalf("inference yield did not fall as BTC appreciated: %g sats/s at $30k "+
			"vs %g sats/s at $300k", cheap.Yield.SatsPerSecond, dear.Yield.SatsPerSecond)
	}
	// A 10x price rise must cut the satoshi yield to a tenth.
	if ratio := cheap.Yield.SatsPerSecond / dear.Yield.SatsPerSecond; !closeEnough(ratio, 10) {
		t.Errorf("a 10x BTC price rise changed the satoshi yield by %.6gx, want 10x", ratio)
	}
}

// TestCrossMarket_InferenceDominatesGPUMining pins the comparison the
// package doc makes, using both providers' own constants. The doc used to
// put GPU SHA256d mining at ~$0.05/day, which overstated the model by ~780×
// and made the gap look like a few hundred to one — close enough that a
// reader could believe "route back to mining when AI demand is low" was a
// live strategy. It is not: the real ratio is ~170,000:1.
func TestCrossMarket_InferenceDominatesGPUMining(t *testing.T) {
	const btcUSD = 95000.0

	// GPU mining, priced through the model pinned in mining_yield_test.go.
	const gpuHashrate = 1.5e9 // MiningProvider's RTX 4090 SHA256d estimate
	impliedDifficulty := assumedNetworkHashrate * assumedBlockTimeSec / hashesPerDifficulty
	miningSatsPerSec := gpuHashrate * assumedBlockSubsidyBTC * satsPerBTC /
		(impliedDifficulty * hashesPerDifficulty)

	inference := gpuQuote(t, btcUSD).Yield.SatsPerSecond
	ratio := inference / miningSatsPerSec

	// Wide band: this asserts the order of magnitude, which is the claim
	// the doc makes, not a precise figure that would break on any tweak.
	const (
		minRatio = 1e4
		maxRatio = 1e7
	)
	if ratio < minRatio || ratio > maxRatio {
		t.Errorf("inference/mining ratio for one GPU = %.3g, outside [%.0g, %.0g].\n"+
			"If this moved deliberately, update the comparison table in "+
			"ai_inference.go's package doc in the same change.", ratio, minRatio, maxRatio)
	}

	// And state it in the units the doc uses, so a failure message shows
	// the reader what the table should say.
	miningUSDPerDay := miningSatsPerSec * 86400 / satsPerBTC * btcUSD
	if miningUSDPerDay > 0.01 {
		t.Errorf("GPU SHA256d mining computes to $%.6f/day; the doc's comparison "+
			"table must not round this up to cents", miningUSDPerDay)
	}
}

// TestInferenceYield_NoGPUsQuotesZeroConfidence documents the contract the
// provider interface asks for: an unavailable market publishes a zero-yield,
// zero-confidence quote rather than going silent, so arbitration can route
// away from it instead of waiting.
func TestInferenceYield_NoGPUsQuotesZeroConfidence(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	// A CPU-only device set: Start filters to GPUs, leaving none.
	devices := []hal.Device{
		&mockDevice{
			id:   hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
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
		if q.Yield.SatsPerSecond != 0 || q.Yield.Confidence != 0 {
			t.Errorf("with no GPUs the quote was %+v, want zero yield and zero confidence",
				q.Yield)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no quote within 2s — an unavailable market must not go silent")
	}
}
