// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// ============================================================================
// AkashProvider.Name
// ============================================================================

func TestAkashProvider_Name_ContainsAkash(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	if !strings.Contains(p.Name(), "Akash") {
		t.Errorf("Name = %q, should contain 'Akash'", p.Name())
	}
}

// ============================================================================
// AkashProvider.Stop lifecycle
// ============================================================================

func TestAkashProvider_StopWithoutStart_IsSafe(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	// Calling Stop before Start should be a no-op, not a panic.
	p.Stop()
}

func TestAkashProvider_DoubleStartRejected(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := p.Start(ctx, nil); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if err := p.Start(ctx, nil); err == nil {
		t.Error("second Start must return error")
	}
	p.Stop()
}

func TestAkashProvider_StopCleansUpGoroutine(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = p.Start(ctx, []hal.Device{
		&mockDevice{
			id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
			caps: hal.Capabilities{GeneralCompute: true},
		},
	})

	// Save the channel reference before Stop; Stop() recreates quoteCh so
	// p.Quotes() after Stop returns a fresh open channel, not the closed one.
	quotes := p.Quotes()
	p.Stop()

	// The original channel (saved above) must be closed by the goroutine's
	// defer close; draining buffered items first.
	deadline := time.After(1 * time.Second)
	for {
		select {
		case _, ok := <-quotes:
			if !ok {
				return // channel closed — goroutine exited cleanly
			}
		case <-deadline:
			t.Error("Quotes channel did not close within 1s after Stop")
			return
		}
	}
}

func TestAkashProvider_StopClearsStateForRestart(t *testing.T) {
	// After Stop(), p.cancel must be nil'd so Start() can be called again.
	// Previously Stop() left p.cancel set, causing Start() to return
	// "already started" on every call after the first.
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := p.Start(ctx, nil); err != nil {
		t.Fatalf("first Start failed: %v", err)
	}
	p.Stop()

	if err := p.Start(ctx, nil); err != nil {
		t.Fatalf("Start after Stop returned error: %v", err)
	}
	p.Stop()
}

// ============================================================================
// AkashProvider behavior with no eligible GPU
// ============================================================================

func TestAkashProvider_NoGPUDevices_EmitsZeroYieldQuote(t *testing.T) {
	// When no GPU is available, Akash must still publish a quote with
	// confidence=0 so the arbitration engine knows the provider is
	// available but has no offer. Silent failure would make arbitration
	// wait forever.
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	// Only CPU devices — AkashProvider must filter them out.
	cpuOnly := []hal.Device{
		&mockDevice{
			id:   hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
			caps: hal.Capabilities{SHA256d: true},
		},
	}
	_ = p.Start(ctx, cpuOnly)
	defer p.Stop()

	select {
	case q, ok := <-p.Quotes():
		if !ok {
			t.Fatal("channel closed without a zero-yield quote")
		}
		if q.Yield.Confidence != 0 {
			t.Errorf("no-GPU quote confidence = %v, want 0", q.Yield.Confidence)
		}
	case <-ctx.Done():
		t.Fatal("no quote received within 500ms with no-GPU devices")
	}
}

// ============================================================================
// AkashProvider pricing bounds
// ============================================================================

func TestAkashProvider_QuotePriceWithinConfiguredBounds(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	// Tighten the pricing window to verify the provider uses the configured bounds.
	p.MinUSDPerHour = 1.00
	p.MaxUSDPerHour = 2.00

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	gpu := &mockDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true},
	}
	_ = p.Start(ctx, []hal.Device{gpu})
	defer p.Stop()

	select {
	case q := <-p.Quotes():
		// Expected sats/s at midpoint ($1.50/hr, $95000 BTC):
		//   1.5 / 95000 * 1e8 / 3600 ≈ 4.39 sat/s
		// Net (after 20% fee): ≈ 3.51 sat/s
		expectedMid := SatsPerSecond(1.50, 95000)
		expectedNet := SatsPerSecond(1.20, 95000)

		// Allow 10% tolerance for floating-point arithmetic.
		tolerance := 0.10
		if q.Yield.SatsPerSecond < expectedMid*(1-tolerance) ||
			q.Yield.SatsPerSecond > expectedMid*(1+tolerance) {
			t.Errorf("SatsPerSecond = %v, want ~%v (from $1.50/hr midpoint)",
				q.Yield.SatsPerSecond, expectedMid)
		}
		if q.Yield.NetSatsPerSecond < expectedNet*(1-tolerance) ||
			q.Yield.NetSatsPerSecond > expectedNet*(1+tolerance) {
			t.Errorf("NetSatsPerSecond = %v, want ~%v (after 20%% fee)",
				q.Yield.NetSatsPerSecond, expectedNet)
		}
	case <-ctx.Done():
		t.Fatal("no quote received within 2s")
	}
}

// ============================================================================
// AkashProvider confidence reflects rate freshness
// ============================================================================

func TestAkashProvider_FreshRate_HighConfidence(t *testing.T) {
	// StaticRateSource always returns fresh=true, so confidence should be
	// at its high ceiling (0.85 per current implementation).
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	gpu := &mockDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true},
	}
	_ = p.Start(ctx, []hal.Device{gpu})
	defer p.Stop()

	select {
	case q := <-p.Quotes():
		if q.Yield.Confidence < 0.8 {
			t.Errorf("confidence with fresh rate = %v, expected >= 0.8",
				q.Yield.Confidence)
		}
	case <-ctx.Done():
		t.Fatal("no quote within 500ms")
	}
}

type staleRateSource struct{ Rate float64 }

func (s staleRateSource) BTCUSDRate() (float64, bool) {
	return s.Rate, false // always stale
}

func TestAkashProvider_StaleRate_LowerConfidence(t *testing.T) {
	p := NewAkashProvider(staleRateSource{Rate: 95000})
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	gpu := &mockDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true},
	}
	_ = p.Start(ctx, []hal.Device{gpu})
	defer p.Stop()

	select {
	case q := <-p.Quotes():
		// With stale rate, confidence drops to 0.6 per implementation.
		if q.Yield.Confidence >= 0.8 {
			t.Errorf("confidence with stale rate = %v, expected < 0.8",
				q.Yield.Confidence)
		}
		if q.Yield.Confidence <= 0 {
			t.Errorf("confidence with stale rate = %v, expected > 0",
				q.Yield.Confidence)
		}
	case <-ctx.Done():
		t.Fatal("no quote within 500ms")
	}
}

// ============================================================================
// AcceptedFamilies correctness
// ============================================================================

func TestAkashProvider_AcceptedFamilies_IsGPUOnly(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	gpu := &mockDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true},
	}
	_ = p.Start(ctx, []hal.Device{gpu})
	defer p.Stop()

	select {
	case q := <-p.Quotes():
		if len(q.AcceptedFamilies) != 1 {
			t.Fatalf("AcceptedFamilies = %v, want [GPU]", q.AcceptedFamilies)
		}
		if q.AcceptedFamilies[0] != hal.FamilyGPU {
			t.Errorf("AcceptedFamilies[0] = %v, want GPU", q.AcceptedFamilies[0])
		}
	case <-ctx.Done():
		t.Fatal("no quote within 500ms")
	}
}

// ============================================================================
// Compile-time Provider interface satisfaction
// ============================================================================

func TestAkashProvider_SatisfiesProviderInterface(t *testing.T) {
	var _ Provider = (*AkashProvider)(nil)
	var _ Provider = (*MiningProvider)(nil)
}

// ============================================================================
// Benchmarks — publish loop allocation pressure
// ============================================================================

func BenchmarkAkashProvider_Publish(b *testing.B) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	gpu := &mockDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{GeneralCompute: true},
	}
	ctx := context.Background()
	p.devices = []hal.Device{gpu}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p.publish(ctx)
		// Drain to prevent channel backup.
		select {
		case <-p.Quotes():
		default:
		}
	}
}

// ============================================================================
// AkashProvider.publish — uncovered branch coverage
// ============================================================================

func TestAkashProvider_Publish_ZeroRateUseFallback(t *testing.T) {
	// BTCUSDRate() returns 0 → publish must fall back to 95000 and produce
	// a positive yield.
	p := NewAkashProvider(StaticRateSource{Rate: 0})
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}, caps: hal.Capabilities{GeneralCompute: true}},
	}
	p.publish(context.Background())

	select {
	case q := <-p.quoteCh:
		if q.Yield.SatsPerSecond <= 0 {
			t.Error("zero-rate fallback should still produce positive yield")
		}
	default:
		t.Error("no quote received with zero-rate fallback")
	}
}

func TestAkashProvider_Publish_DropsOldestWhenFull(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	// Pre-fill the channel to capacity.
	for len(p.quoteCh) < cap(p.quoteCh) {
		p.quoteCh <- Quote{ProviderID: "fill"}
	}
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}, caps: hal.Capabilities{GeneralCompute: true}},
	}
	p.publish(context.Background())
	if len(p.quoteCh) == 0 {
		t.Error("channel empty after Akash drop-oldest publish")
	}
}

func TestAkashProvider_NameDisclosesSimulation(t *testing.T) {
	// The provider name MUST disclose that yield is simulated, so the
	// disclosure is visible in the TUI, logs, and `config show`. This is
	// a deliberate honesty guarantee (see docs/KNOWN_LIMITATIONS.md §1).
	// When the real Akash REST integration lands, this test is updated
	// in the same change that removes the suffix — forcing a conscious
	// decision rather than a silent drift.
	p := NewAkashProvider(StaticRateSource{Rate: 60000})
	name := p.Name()
	if !strings.Contains(strings.ToLower(name), "simulated") {
		t.Errorf("AkashProvider.Name() = %q; must disclose 'simulated' "+
			"while yield is not live (see docs/KNOWN_LIMITATIONS.md)", name)
	}
}
