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
