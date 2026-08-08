// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package provider

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/hal"
)

// ----- Yield -----

func TestYield_Effective(t *testing.T) {
	tests := []struct {
		name string
		y    Yield
		want float64
	}{
		{"positive full confidence", Yield{SatsPerSecond: 100, NetSatsPerSecond: 99, Confidence: 1.0}, 99},
		{"positive half confidence", Yield{SatsPerSecond: 100, NetSatsPerSecond: 99, Confidence: 0.5}, 49.5},
		{"zero sats", Yield{SatsPerSecond: 0, NetSatsPerSecond: 0, Confidence: 1.0}, 0},
		{"zero confidence", Yield{SatsPerSecond: 100, NetSatsPerSecond: 99, Confidence: 0}, 0},
		{"negative net sats", Yield{SatsPerSecond: 100, NetSatsPerSecond: -1, Confidence: 1.0}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.y.Effective(); got != tt.want {
				t.Errorf("Effective() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ----- SatsPerSecond conversion -----

func TestSatsPerSecond_Conversion(t *testing.T) {
	// At $95,000/BTC, $0.50/hour should be ~1.462 sat/s
	// 0.50 USD/hr / 95000 USD/BTC * 1e8 sat/BTC / 3600 s/hr
	rate := 95000.0
	usdPerHour := 0.50
	expected := usdPerHour / rate * 1e8 / 3600

	got := SatsPerSecond(usdPerHour, rate)
	if got < expected*0.99 || got > expected*1.01 {
		t.Errorf("SatsPerSecond(%v, %v) = %v, want ~%v", usdPerHour, rate, got, expected)
	}
}

func TestSatsPerSecond_ZeroRate(t *testing.T) {
	if got := SatsPerSecond(1.0, 0); got != 0 {
		t.Errorf("SatsPerSecond with zero rate = %v, want 0", got)
	}
}

func TestSatsPerSecond_NegativeUSD(t *testing.T) {
	if got := SatsPerSecond(-1.0, 95000); got != 0 {
		t.Errorf("SatsPerSecond with negative USD = %v, want 0", got)
	}
}

// ----- StaticRateSource -----

func TestStaticRateSource(t *testing.T) {
	src := StaticRateSource{Rate: 95000}
	rate, fresh := src.BTCUSDRate()
	if rate != 95000 {
		t.Errorf("BTCUSDRate() = %v, want 95000", rate)
	}
	if !fresh {
		t.Error("StaticRateSource should always return fresh=true")
	}
}

// ----- MiningProvider -----

func TestMiningProvider_ID_and_Name(t *testing.T) {
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", StaticRateSource{Rate: 95000})
	if p.ID() != "mining.stratum" {
		t.Errorf("ID() = %q, want %q", p.ID(), "mining.stratum")
	}
	if p.Name() == "" {
		t.Error("Name() empty")
	}
}

func TestMiningProvider_PublishesQuoteForEachDevice(t *testing.T) {
	rates := StaticRateSource{Rate: 95000}
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", rates)

	devices := []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
		&mockDevice{id: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}, caps: hal.Capabilities{SHA256d: true}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := p.Start(ctx, devices); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer p.Stop()

	received := make(map[string]Quote)
	deadline := time.After(2 * time.Second)
loop:
	for {
		select {
		case q, ok := <-p.Quotes():
			if !ok {
				break loop
			}
			received[q.DeviceID] = q
			if len(received) >= len(devices) {
				break loop
			}
		case <-deadline:
			break loop
		}
	}

	for _, dev := range devices {
		q, ok := received[dev.Identity().ID]
		if !ok {
			t.Errorf("no quote received for device %s", dev.Identity().ID)
			continue
		}
		if q.Yield.SatsPerSecond <= 0 {
			t.Errorf("device %s: SatsPerSecond = %v, want > 0", dev.Identity().ID, q.Yield.SatsPerSecond)
		}
		if q.Yield.NetSatsPerSecond > q.Yield.SatsPerSecond {
			t.Errorf("device %s: net > gross yield", dev.Identity().ID)
		}
	}
}

func TestMiningProvider_SkipsNonSHA256dDevices(t *testing.T) {
	// A device with SHA256d=false must not receive a mining quote.
	rates := StaticRateSource{Rate: 95000}
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", rates)

	noSHA := &mockDevice{
		id:   hal.Identity{ID: "gpu-only", Family: hal.FamilyGPU},
		caps: hal.Capabilities{SHA256d: false, GeneralCompute: true},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = p.Start(ctx, []hal.Device{noSHA})
	defer p.Stop()

	select {
	case q := <-p.Quotes():
		if q.DeviceID == noSHA.Identity().ID {
			t.Errorf("received quote for non-SHA256d device %s", q.DeviceID)
		}
	case <-ctx.Done():
		// Expected: no quote emitted.
	}
}

func TestMiningProvider_StopWithoutStart(t *testing.T) {
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", StaticRateSource{Rate: 95000})
	p.Stop() // must not panic
}

func TestMiningProvider_StopClearsStateForRestart(t *testing.T) {
	// After Stop(), p.cancel must be nil'd so Start() can be called again.
	// Previously Stop() left p.cancel set, causing Start() to return
	// "already started" on every call after the first.
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", StaticRateSource{Rate: 95000})
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

func TestMiningProvider_DoubleStartRejected(t *testing.T) {
	p := NewMiningProvider("stratum+v2://pool.example.com:3336", StaticRateSource{Rate: 95000})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = p.Start(ctx, nil)
	if err := p.Start(ctx, nil); err == nil {
		t.Error("second Start must return error")
	}
	p.Stop()
}

// ----- AkashProvider -----

func TestAkashProvider_ID(t *testing.T) {
	p := NewAkashProvider(StaticRateSource{Rate: 95000})
	if p.ID() != "ai.akash" {
		t.Errorf("ID() = %q, want ai.akash", p.ID())
	}
}

func TestAkashProvider_OnlyAcceptsGPU(t *testing.T) {
	rates := StaticRateSource{Rate: 95000}
	p := NewAkashProvider(rates)

	devices := []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{GeneralCompute: true}},
		&mockDevice{id: hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU}, caps: hal.Capabilities{GeneralCompute: true}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = p.Start(ctx, devices)
	defer p.Stop()

	var gpuQuote *Quote
	select {
	case q := <-p.Quotes():
		gpuQuote = &q
	case <-ctx.Done():
	}

	// If a quote was received, it must be for the GPU only.
	if gpuQuote != nil && gpuQuote.DeviceID == "cpu-0" {
		t.Error("Akash issued quote for CPU device; should only accept GPU")
	}
}

func TestAkashProvider_YieldHigherThanCPUMining(t *testing.T) {
	// AI inference on GPU must be more profitable than CPU mining.
	// This test ensures the pricing model reflects economic reality.
	const btcRate = 95000.0
	rates := StaticRateSource{Rate: btcRate}
	akash := NewAkashProvider(rates)
	mining := NewMiningProvider("stratum+v2://pool.example.com:3336", rates)

	gpu := &mockDevice{
		id:   hal.Identity{ID: "gpu-0", Family: hal.FamilyGPU},
		caps: hal.Capabilities{SHA256d: true, GeneralCompute: true},
	}
	cpu := &mockDevice{
		id:   hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU},
		caps: hal.Capabilities{SHA256d: true},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = akash.Start(ctx, []hal.Device{gpu})
	_ = mining.Start(ctx, []hal.Device{cpu})
	defer akash.Stop()
	defer mining.Stop()

	var akashYield, miningYield float64
	for akashYield == 0 || miningYield == 0 {
		select {
		case q := <-akash.Quotes():
			akashYield = q.Yield.Effective()
		case q := <-mining.Quotes():
			miningYield = q.Yield.Effective()
		case <-ctx.Done():
			if akashYield == 0 || miningYield == 0 {
				t.Skip("timeout waiting for quotes")
			}
		}
	}

	if akashYield <= miningYield {
		t.Errorf("Akash yield (%v) should be >> CPU mining yield (%v)", akashYield, miningYield)
	}
}

// ----- mock device -----

type mockDevice struct {
	id   hal.Identity
	caps hal.Capabilities
}

func (m *mockDevice) Identity() hal.Identity           { return m.id }
func (m *mockDevice) Capabilities() hal.Capabilities   { return m.caps }
func (m *mockDevice) Shutdown(_ context.Context) error { return nil }

// ============================================================================
// MiningProvider.publish — uncovered branch coverage
// ============================================================================

func TestMiningProvider_Publish_ASICDeviceBranch(t *testing.T) {
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "asic-0", Family: hal.FamilyASIC}, caps: hal.Capabilities{SHA256d: true}},
	}
	p.publish(context.Background())

	select {
	case q := <-p.quoteCh:
		if q.DeviceID != "asic-0" {
			t.Errorf("DeviceID = %q, want asic-0", q.DeviceID)
		}
		if q.Yield.SatsPerSecond <= 0 {
			t.Error("ASIC device should produce positive yield")
		}
	default:
		t.Error("no quote received for ASIC device")
	}
}

func TestMiningProvider_Publish_ZeroRateUseFallback(t *testing.T) {
	// BTCUSDRate() returns 0 → publish must fall back to the hard-coded 95000
	// estimate and still produce a positive yield.
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 0})
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
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

func TestMiningProvider_Publish_DropsOldestWhenFull(t *testing.T) {
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	// Pre-fill the channel to capacity.
	for len(p.quoteCh) < cap(p.quoteCh) {
		p.quoteCh <- Quote{ProviderID: "fill"}
	}
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
	}
	// publish with a full channel must not block: it drops the oldest and
	// pushes the new quote via the drop-oldest path.
	p.publish(context.Background())
	if len(p.quoteCh) == 0 {
		t.Error("channel empty after drop-oldest publish")
	}
}

// ============================================================================
// pollingProvider — shared loop and send lifecycle
// ============================================================================

func TestPollingLoop_RepublishesOnTicker(t *testing.T) {
	// The polling loop publishes once immediately and then again on every
	// ticker tick. With a tiny interval we can observe more than one quote,
	// covering the ticker-driven republish branch deterministically (the
	// production 30s/60s interval made this branch unreachable in tests).
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	p.interval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := p.Start(ctx, []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer p.Stop()

	// First quote is the immediate publish; a second quote can only arrive
	// from a ticker tick.
	for i := 0; i < 2; i++ {
		select {
		case _, ok := <-p.Quotes():
			if !ok {
				t.Fatalf("quote channel closed after %d quotes; ticker did not republish", i)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for quote %d; ticker did not republish", i)
		}
	}
}

func TestPollingProvider_ParentContextCancelTerminatesLoop(t *testing.T) {
	// A provider is started under a parent context (in production, the engine's
	// context). Cancelling that parent — WITHOUT calling Stop() — must make the
	// loop goroutine exit and close the quote channel. Every other test drives
	// shutdown via Stop(); this covers the equally important path where the
	// owning context dies first, which is the classic goroutine-leak scenario:
	// a goroutine that only listens for its own Stop() and ignores ctx.Done
	// would leak here, pinning its Fetcher/devices for the life of the process.
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	p.interval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	if err := p.Start(ctx, []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Drain the immediate quote so the buffer cannot mask a stalled loop.
	select {
	case <-p.Quotes():
	case <-time.After(2 * time.Second):
		t.Fatal("no initial quote; provider did not start")
	}

	// Cancel the PARENT context only — do not call Stop().
	cancel()

	// The loop's defer close(p.quoteCh) must fire, so the channel drains to a
	// closed state (ok == false) within a bounded time. Reading drops any
	// in-flight buffered quotes until the close is observed.
	deadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-p.Quotes():
			if !ok {
				return // channel closed: goroutine exited on ctx.Done as required
			}
			// A buffered quote; keep reading until the channel closes.
		case <-deadline:
			t.Fatal("quote channel was not closed after parent context cancel; loop goroutine leaked")
		}
	}
}

// ============================================================================
// MiningProvider.HashrateFunc — live hashrate plumbing (KNOWN_LIMITATIONS §7)
// ============================================================================

func TestMiningProvider_Publish_UsesHashrateFuncWhenSet(t *testing.T) {
	// HashrateFunc reports 500 TH/s for the test device. publish() must use
	// that measured value instead of the static 10 MH/s CPU default, resulting
	// in a SatsPerSecond ~50 million times larger than the CPU fallback.
	const measured = 500e12 // 500 TH/s
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	p.HashrateFunc = func(id string) float64 {
		if id == "cpu-0" {
			return measured
		}
		return 0
	}
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
	}
	p.publish(context.Background())

	select {
	case q := <-p.quoteCh:
		// Static CPU estimate: 10 MH/s. Measured: 500 TH/s (50 000 000×).
		// The yield must be substantially higher than the static fallback.
		staticSats := (DefaultHashrates[hal.FamilyCPU] / 1e21) * 3.125 * 1e8 / 600.0
		if q.Yield.SatsPerSecond < staticSats*1000 {
			t.Errorf("HashrateFunc path: SatsPerSecond = %g, want >> %g (static CPU)", q.Yield.SatsPerSecond, staticSats)
		}
	default:
		t.Error("no quote received via HashrateFunc path")
	}
}

func TestMiningProvider_Publish_FallsBackWhenHashrateFuncReturnsZero(t *testing.T) {
	// When HashrateFunc returns 0 (no live measurement yet), publish() must
	// fall back to the static per-family estimate rather than emitting zero yield.
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	p.HashrateFunc = func(string) float64 { return 0 }
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "cpu-0", Family: hal.FamilyCPU}, caps: hal.Capabilities{SHA256d: true}},
	}
	p.publish(context.Background())

	select {
	case q := <-p.quoteCh:
		expectedSats := (DefaultHashrates[hal.FamilyCPU] / 1e21) * 3.125 * 1e8 / 600.0
		if q.Yield.SatsPerSecond < expectedSats*0.98 || q.Yield.SatsPerSecond > expectedSats*1.02 {
			t.Errorf("static fallback: SatsPerSecond = %g, want ~%g", q.Yield.SatsPerSecond, expectedSats)
		}
	default:
		t.Error("no quote received via static fallback path")
	}
}

func TestMiningProvider_Publish_HashrateFunc_UnknownDeviceUsesStatic(t *testing.T) {
	// HashrateFunc returns 0 for an unrecognised device ID — publish() must
	// fall back to the static estimate rather than producing zero yield.
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	p.HashrateFunc = func(id string) float64 { return 0 } // unknown → 0
	p.devices = []hal.Device{
		&mockDevice{id: hal.Identity{ID: "asic-0", Family: hal.FamilyASIC}, caps: hal.Capabilities{SHA256d: true}},
	}
	p.publish(context.Background())

	select {
	case q := <-p.quoteCh:
		if q.Yield.SatsPerSecond <= 0 {
			t.Error("ASIC static fallback must produce positive yield when HashrateFunc returns 0")
		}
	default:
		t.Error("no quote received")
	}
}

func TestPollingProvider_SendQuoteReturnsFalseOnCancelledContext(t *testing.T) {
	// sendQuote must report failure (not block) when the context is already
	// cancelled and the channel is full, so the publish loop exits promptly
	// on shutdown. With a full channel the buffered send blocks, so the
	// ready ctx.Done() case is selected and sendQuote returns false.
	p := NewMiningProvider("stratum+v2://pool.example:3336", StaticRateSource{Rate: 95000})
	for len(p.quoteCh) < cap(p.quoteCh) {
		p.quoteCh <- Quote{ProviderID: "fill"}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if p.sendQuote(ctx, Quote{ProviderID: "new"}) {
		t.Error("sendQuote returned true on a cancelled context; should report failure")
	}
}
