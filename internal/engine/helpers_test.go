// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package engine

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/hal"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/miner"
	"github.com/shizukutanaka/Otedama/internal/provider"
)

// ============================================================================
// fatalError / isFatal
// ============================================================================

func TestFatalError_ErrorMessage(t *testing.T) {
	err := &fatalError{msg: "pool rejected: bad address"}
	if err.Error() != "pool rejected: bad address" {
		t.Errorf("Error() = %q, want %q", err.Error(), "pool rejected: bad address")
	}
}

func TestIsFatal_TrueForFatalError(t *testing.T) {
	err := &fatalError{msg: "irrecoverable"}
	if !isFatal(err) {
		t.Error("isFatal should return true for *fatalError")
	}
}

func TestIsFatal_FalseForGenericError(t *testing.T) {
	err := errors.New("transient network failure")
	if isFatal(err) {
		t.Error("isFatal should return false for generic errors")
	}
}

func TestIsFatal_FalseForNil(t *testing.T) {
	if isFatal(nil) {
		t.Error("isFatal(nil) should return false")
	}
}

func TestIsFatal_FalseForWrappedFatal(t *testing.T) {
	// A wrapped fatalError should NOT currently be detected as fatal
	// (isFatal uses type assertion, not errors.As). This documents the
	// current behavior; if we later switch to errors.As, flip this test.
	inner := &fatalError{msg: "inner"}
	wrapped := fmt.Errorf("outer: %w", inner)
	if isFatal(wrapped) {
		t.Error("isFatal currently does not unwrap; change this test if that changes")
	}
}

// ============================================================================
// mergeShares
// ============================================================================

func TestMergeShares_SingleChannel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	src := make(chan miner.Share, 3)
	src <- miner.Share{JobID: 1, Nonce: 100}
	src <- miner.Share{JobID: 1, Nonce: 101}
	src <- miner.Share{JobID: 1, Nonce: 102}
	close(src)

	merged := mergeShares(ctx, []<-chan miner.Share{src})

	var got []miner.Share
	for s := range merged {
		got = append(got, s)
	}

	if len(got) != 3 {
		t.Fatalf("merged 3 shares, got %d", len(got))
	}
}

func TestMergeShares_MultipleChannels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Three producers with distinct job IDs so we can verify all made it.
	src1 := make(chan miner.Share, 2)
	src2 := make(chan miner.Share, 2)
	src3 := make(chan miner.Share, 2)
	src1 <- miner.Share{JobID: 1}
	src1 <- miner.Share{JobID: 1}
	src2 <- miner.Share{JobID: 2}
	src2 <- miner.Share{JobID: 2}
	src3 <- miner.Share{JobID: 3}
	src3 <- miner.Share{JobID: 3}
	close(src1)
	close(src2)
	close(src3)

	merged := mergeShares(ctx, []<-chan miner.Share{src1, src2, src3})

	counts := map[uint32]int{}
	for s := range merged {
		counts[s.JobID]++
	}
	for id, want := range map[uint32]int{1: 2, 2: 2, 3: 2} {
		if counts[id] != want {
			t.Errorf("JobID=%d got %d shares, want %d", id, counts[id], want)
		}
	}
}

func TestMergeShares_ContextCancellationStopsProducers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	// Slow producer that would otherwise block forever.
	src := make(chan miner.Share) // unbuffered
	go func() {
		defer close(src)
		for i := 0; i < 1000; i++ {
			select {
			case src <- miner.Share{Nonce: uint32(i)}:
			case <-ctx.Done():
				return
			}
		}
	}()

	merged := mergeShares(ctx, []<-chan miner.Share{src})

	// Read a few then cancel.
	for i := 0; i < 3; i++ {
		<-merged
	}
	cancel()

	// merged should eventually close.
	deadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-merged:
			if !ok {
				return // channel closed, test passes
			}
			// drain remaining buffered items
		case <-deadline:
			t.Fatal("merged channel did not close within 2s after context cancellation")
		}
	}
}

func TestMergeShares_EmptyInput(t *testing.T) {
	ctx := context.Background()
	merged := mergeShares(ctx, nil)
	// With no input channels, merged should close immediately.
	select {
	case _, ok := <-merged:
		if ok {
			t.Error("merged produced a share from empty input")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("merged did not close within 200ms for empty input")
	}
}

// ============================================================================
// mergeQuotes
// ============================================================================

func TestMergeQuotes_CombinesMultipleSources(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	src1 := make(chan provider.Quote, 2)
	src2 := make(chan provider.Quote, 2)
	src1 <- provider.Quote{ProviderID: "mining.stratum"}
	src1 <- provider.Quote{ProviderID: "mining.stratum"}
	src2 <- provider.Quote{ProviderID: "ai.akash"}
	src2 <- provider.Quote{ProviderID: "ai.akash"}
	close(src1)
	close(src2)

	merged := mergeQuotes(ctx, src1, src2)
	ids := map[string]int{}
	for q := range merged {
		ids[q.ProviderID]++
	}
	if ids["mining.stratum"] != 2 {
		t.Errorf("mining.stratum count = %d, want 2", ids["mining.stratum"])
	}
	if ids["ai.akash"] != 2 {
		t.Errorf("ai.akash count = %d, want 2", ids["ai.akash"])
	}
}

func TestMergeQuotes_NoSourcesClosesImmediately(t *testing.T) {
	ctx := context.Background()
	merged := mergeQuotes(ctx)
	select {
	case _, ok := <-merged:
		if ok {
			t.Error("no sources but got a quote")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("merged channel did not close")
	}
}

// ============================================================================
// updateStream — Quote → arbitration.Stream translation
// ============================================================================

func TestUpdateStream_InsertsNewStream(t *testing.T) {
	var mu sync.Mutex
	m := make(map[string]arbitration.Stream)

	q := provider.Quote{
		ProviderID:       "mining.stratum",
		DeviceID:         "cpu-0",
		AcceptedFamilies: []hal.Family{hal.FamilyCPU},
		Yield: provider.Yield{
			SatsPerSecond:    0.1,
			NetSatsPerSecond: 0.099,
			Confidence:       0.95,
		},
	}
	updateStream(&mu, m, q)

	if len(m) != 1 {
		t.Fatalf("map size = %d, want 1", len(m))
	}
	key := "mining.stratum:cpu-0"
	s, ok := m[key]
	if !ok {
		t.Fatalf("key %q not in map; got keys %v", key, mapKeys(m))
	}
	if string(s.ID) != "mining.stratum" {
		t.Errorf("Stream.ID = %q, want mining.stratum", s.ID)
	}
	if !s.IsBitcoinMining {
		t.Error("mining.stratum should set IsBitcoinMining=true")
	}
	y, ok := s.YieldPerDevice["cpu-0"]
	if !ok {
		t.Fatal("YieldPerDevice[cpu-0] missing")
	}
	if y.SatsPerSecond != 0.1 {
		t.Errorf("YieldPerDevice[cpu-0].SatsPerSecond = %v, want 0.1", y.SatsPerSecond)
	}
}

func TestUpdateStream_AIAkashIsNotBitcoinMining(t *testing.T) {
	var mu sync.Mutex
	m := make(map[string]arbitration.Stream)
	updateStream(&mu, m, provider.Quote{
		ProviderID: "ai.akash",
		DeviceID:   "gpu-0",
	})
	for _, s := range m {
		if s.IsBitcoinMining {
			t.Errorf("ai.akash should NOT set IsBitcoinMining=true; got %+v", s)
		}
	}
}

func TestUpdateStream_UpdateExistingDevice(t *testing.T) {
	var mu sync.Mutex
	m := make(map[string]arbitration.Stream)
	id := "mining.stratum"
	dev := "cpu-0"

	updateStream(&mu, m, provider.Quote{
		ProviderID: id, DeviceID: dev,
		Yield: provider.Yield{SatsPerSecond: 0.1, Confidence: 0.9},
	})
	updateStream(&mu, m, provider.Quote{
		ProviderID: id, DeviceID: dev,
		Yield: provider.Yield{SatsPerSecond: 0.2, Confidence: 0.95}, // updated
	})

	s := m[id+":"+dev]
	y := s.YieldPerDevice[dev]
	if y.SatsPerSecond != 0.2 {
		t.Errorf("expected updated yield 0.2, got %v", y.SatsPerSecond)
	}
}

// ============================================================================
// streamsSlice — deduplicate by StreamID
// ============================================================================

func TestStreamsSlice_DeduplicatesByID(t *testing.T) {
	m := map[string]arbitration.Stream{
		"mining.stratum:cpu-0": {ID: "mining.stratum"},
		"mining.stratum:gpu-0": {ID: "mining.stratum"}, // duplicate ID, different device
		"ai.akash:gpu-0":       {ID: "ai.akash"},
	}
	got := streamsSlice(m)
	if len(got) != 2 {
		t.Errorf("got %d streams, want 2 (deduped); %+v", len(got), got)
	}
	ids := map[arbitration.StreamID]bool{}
	for _, s := range got {
		ids[s.ID] = true
	}
	if !ids["mining.stratum"] || !ids["ai.akash"] {
		t.Errorf("missing stream IDs; got %v", ids)
	}
}

func TestStreamsSlice_EmptyInput(t *testing.T) {
	got := streamsSlice(map[string]arbitration.Stream{})
	if len(got) != 0 {
		t.Errorf("empty input: got %v, want empty", got)
	}
}

func TestStreamsSlice_MergesYieldPerDeviceForSameStreamID(t *testing.T) {
	// A provider with two GPU devices (gpu-0, gpu-1) produces two separate
	// map entries, both sharing StreamID "ai.akash". The old first-seen pick
	// would return only one entry, leaving one device with no YieldPerDevice
	// hit so it would fall back to the other device's DefaultYield — silently
	// returning the wrong rate for heterogeneous GPU configurations.
	//
	// Both entries carry the same AcceptsFamilies (GPU): the merge must
	// preserve that field from the representative entry, otherwise the
	// engine silently stops assigning *any* device to the stream because
	// Stream.Accepts() returns false for everything.
	m := map[string]arbitration.Stream{
		"ai.akash:gpu-0": {
			ID:              "ai.akash",
			AcceptsFamilies: []hal.Family{hal.FamilyGPU},
			YieldPerDevice: map[string]arbitration.Yield{
				"gpu-0": {SatsPerSecond: 1000, Confidence: 0.9},
			},
			DefaultYield: arbitration.Yield{SatsPerSecond: 1000, Confidence: 0.9},
		},
		"ai.akash:gpu-1": {
			ID:              "ai.akash",
			AcceptsFamilies: []hal.Family{hal.FamilyGPU},
			YieldPerDevice: map[string]arbitration.Yield{
				"gpu-1": {SatsPerSecond: 700, Confidence: 0.9},
			},
			DefaultYield: arbitration.Yield{SatsPerSecond: 700, Confidence: 0.9},
		},
	}

	got := streamsSlice(m)
	if len(got) != 1 {
		t.Fatalf("want 1 merged stream, got %d: %+v", len(got), got)
	}

	s := got[0]
	if s.ID != "ai.akash" {
		t.Errorf("stream ID = %q, want ai.akash", s.ID)
	}
	// AcceptsFamilies must survive the merge: if it were dropped the engine
	// would route no device to this stream, silently reducing revenue.
	if !s.Accepts(hal.FamilyGPU) {
		t.Error("merged stream must accept GPU; AcceptsFamilies was dropped during merge")
	}
	if y := s.YieldFor("gpu-0"); y.SatsPerSecond != 1000 {
		t.Errorf("gpu-0 yield = %v, want 1000", y.SatsPerSecond)
	}
	if y := s.YieldFor("gpu-1"); y.SatsPerSecond != 700 {
		t.Errorf("gpu-1 yield = %v, want 700 (was silently wrong before the merge fix)", y.SatsPerSecond)
	}
}

func TestStreamsSlice_MultiDeviceMergeDoesNotMutateInput(t *testing.T) {
	// The merge must not alias its YieldPerDevice maps back into m;
	// otherwise a later updateStream call would mutate the returned slice.
	m := map[string]arbitration.Stream{
		"ai.akash:gpu-0": {
			ID: "ai.akash",
			YieldPerDevice: map[string]arbitration.Yield{
				"gpu-0": {SatsPerSecond: 500},
			},
		},
	}

	got := streamsSlice(m)
	if len(got) != 1 {
		t.Fatalf("want 1 stream, got %d", len(got))
	}

	// Mutating the returned stream's YieldPerDevice must not reach m.
	got[0].YieldPerDevice["gpu-0"] = arbitration.Yield{SatsPerSecond: 9999}

	orig := m["ai.akash:gpu-0"].YieldPerDevice["gpu-0"]
	if orig.SatsPerSecond == 9999 {
		t.Error("streamsSlice must deep-copy YieldPerDevice; mutating the result should not affect the input map")
	}
}

// ============================================================================
// applyAllocation — workload switching
// ============================================================================

func TestApplyAllocation_LogsOnStreamChange(t *testing.T) {
	var lines []string
	log := func(level, msg string) {
		lines = append(lines, level+":"+msg)
	}

	// Build an allocation that says: switch from mining to ai.akash.
	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{{
			DeviceID:       "gpu-0",
			Stream:         "ai.akash",
			SwitchedFromID: "mining.stratum",
			ExpectedYield:  14000,
		}},
	}
	var workers []*miner.Worker // nil-safe: SetWork on nil slice is a no-op
	applyAllocation(alloc, workers, log)

	joined := fmt.Sprint(lines)
	if !strings.Contains(joined, "ai.akash") && !strings.Contains(joined, "AI") {
		t.Errorf("log must mention stream change to ai.akash; got: %v", lines)
	}
}

func TestApplyAllocation_IdleAssignment(t *testing.T) {
	// An idle assignment (no compatible stream) should log 'idle'.
	var lines []string
	log := func(_, msg string) { lines = append(lines, msg) }

	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{
			{DeviceID: "gpu-0", Stream: ""}, // Idle() is true when Stream is ""
		},
	}
	applyAllocation(alloc, nil, log)

	joined := fmt.Sprint(lines)
	if !strings.Contains(joined, "idle") {
		t.Errorf("log must mention idle; got %v", lines)
	}
}

func TestApplyAllocation_NoChangeProducesNoLog(t *testing.T) {
	// When a device's assignment is steady (no SwitchedFromID), nothing
	// should be logged for that device.
	var lines []string
	log := func(_, msg string) { lines = append(lines, msg) }

	alloc := &arbitration.Allocation{
		Assignments: []arbitration.Assignment{{
			DeviceID: "cpu-0",
			Stream:   "mining.stratum",
			// SwitchedFromID empty → no change
		}},
	}
	applyAllocation(alloc, nil, log)

	if len(lines) != 0 {
		t.Errorf("steady-state assignment should not log; got %v", lines)
	}
}

// ============================================================================
// buildStats — engine state → TUI snapshot
// ============================================================================

func TestBuildStats_IncludesHashRateAndWalletFingerprint(t *testing.T) {
	opts := sessionOpts{
		poolURL:   "stratum+v2://pool.example.com:3336",
		wallet:    "a1b2c3d4",
		startTime: time.Now().Add(-5 * time.Minute),
		devices:   2,
		providers: []provider.Provider{
			provider.NewMiningProvider("stratum+v2://pool:3336", provider.StaticRateSource{Rate: 95000}),
		},
	}
	stats := buildStats(opts, 1234.5, 42, nil, false)

	if stats.HashRate != 1234.5 {
		t.Errorf("HashRate = %v, want 1234.5", stats.HashRate)
	}
	if stats.WalletFingerprint != "a1b2c3d4" {
		t.Errorf("WalletFingerprint = %q, want a1b2c3d4", stats.WalletFingerprint)
	}
	if stats.Devices != 2 {
		t.Errorf("Devices = %d, want 2", stats.Devices)
	}
	if stats.EstSatsEarned != 42 {
		t.Errorf("EstSatsEarned = %d, want 42", stats.EstSatsEarned)
	}
	if stats.PoolURL != "stratum+v2://pool.example.com:3336" {
		t.Errorf("PoolURL wrong: %q", stats.PoolURL)
	}
	if !stats.Connected {
		t.Error("buildStats should set Connected=true")
	}
	if stats.Uptime <= 0 {
		t.Errorf("Uptime = %v, should be positive", stats.Uptime)
	}
	if len(stats.Providers) != 1 {
		t.Errorf("Providers count = %d, want 1", len(stats.Providers))
	}
}

// ============================================================================
// buildStats — PoolLatency wired from LatencyTracker p50
// ============================================================================

func TestBuildStats_PoolLatencyFromTracker(t *testing.T) {
	opts := sessionOpts{
		poolURL:   "stratum+tcp://pool.example.com:3333",
		startTime: time.Now(),
	}

	// No latency samples: PoolLatency must be zero (unknown).
	lt := NewLatencyTracker(16)
	stats := buildStats(opts, 0, 0, lt, false)
	if stats.PoolLatency != 0 {
		t.Errorf("PoolLatency with no samples = %v, want 0", stats.PoolLatency)
	}

	// Record samples (all 50 ms) so p50 = 50 ms.
	for range 8 {
		lt.Record(50.0)
	}
	stats = buildStats(opts, 0, 0, lt, false)
	want := 50 * time.Millisecond
	if stats.PoolLatency != want {
		t.Errorf("PoolLatency = %v, want %v", stats.PoolLatency, want)
	}
}

// ============================================================================
// buildStats — Stalled flag propagation
// ============================================================================

func TestBuildStats_StalledPropagated(t *testing.T) {
	opts := sessionOpts{startTime: time.Now()}

	notStalled := buildStats(opts, 100.0, 0, nil, false)
	if notStalled.Stalled {
		t.Error("buildStats(stalled=false): Stats.Stalled should be false")
	}

	stalled := buildStats(opts, 0, 0, nil, true)
	if !stalled.Stalled {
		t.Error("buildStats(stalled=true): Stats.Stalled should be true")
	}
}

// ============================================================================
// cpuDriver — built-in driver satisfies hal.Driver
// ============================================================================

func TestCPUDriver_Name(t *testing.T) {
	d := &cpuDriver{}
	if d.Name() != "cpu" {
		t.Errorf("Name() = %q, want cpu", d.Name())
	}
}

// ============================================================================
// detectDevices — registry wiring and interrupted-detection diagnostics
// ============================================================================

func TestDetectDevices_ReturnsBuiltinCPU(t *testing.T) {
	// The built-in CPU driver is always registered, so detection on a live
	// context must return at least one device and no error.
	devices, err := detectDevices(context.Background(), func(string, string) {})
	if err != nil {
		t.Fatalf("detectDevices: %v", err)
	}
	if len(devices) == 0 {
		t.Fatal("detectDevices returned no devices; the built-in CPU must always be present")
	}
	var sawCPU bool
	for _, d := range devices {
		if d.Identity().Family == hal.FamilyCPU {
			sawCPU = true
		}
	}
	if !sawCPU {
		t.Error("detectDevices did not include the built-in CPU device")
	}
}

func TestDetectDevices_CancelledContextSurfacesRealCause(t *testing.T) {
	// With a canceled context, hal.Detector.Detect races between delivering
	// the (fast, synchronous) CPU result and observing ctx.Done(), so the
	// outcome varies run-to-run. The invariant that must hold every time:
	// detectDevices either returns devices, or an error that surfaces the
	// real cause (context cancellation) — it must NEVER report the misleading
	// "no devices detected" when the real problem is an interrupted context.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancel
	for i := 0; i < 200; i++ {
		devices, err := detectDevices(ctx, func(string, string) {})
		switch {
		case err != nil:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("iter %d: error must wrap context.Canceled, got %v", i, err)
			}
			if strings.Contains(err.Error(), "no devices detected") {
				t.Fatalf("iter %d: canceled detection misreported as 'no devices detected': %v", i, err)
			}
		case len(devices) == 0:
			t.Fatalf("iter %d: nil error with zero devices", i)
		}
	}
}

func TestCPUDriver_EnumerateReturnsCPUDevice(t *testing.T) {
	d := &cpuDriver{}
	devs, err := d.Enumerate(context.Background())
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	if len(devs) != 1 {
		t.Fatalf("Enumerate returned %d devices, want 1", len(devs))
	}
	id := devs[0].Identity()
	if id.Family != hal.FamilyCPU {
		t.Errorf("device family = %v, want %v", id.Family, hal.FamilyCPU)
	}
	caps := devs[0].Capabilities()
	if !caps.SHA256d {
		t.Error("CPU device must advertise SHA256d capability")
	}
	if !caps.GeneralCompute {
		t.Error("CPU device must advertise GeneralCompute capability")
	}
	// Shutdown should not panic.
	if err := devs[0].Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown returned error: %v", err)
	}
}

// ============================================================================
// Per-device share counter
// ============================================================================

func TestIncSharesFoundForDevice_CreatesCounterOnFirstCall(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.incSharesFoundForDevice("cpu-0")

	// Verify the counter was created and incremented.
	if m.sharesFoundPerDevice["cpu-0"] == nil {
		t.Fatal("counter for cpu-0 was not created")
	}
	if got := m.sharesFoundPerDevice["cpu-0"].Value(); got != 1 {
		t.Errorf("counter = %d, want 1", got)
	}
}

func TestIncSharesFoundForDevice_AccumulatesAcrossCalls(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	for i := 0; i < 5; i++ {
		m.incSharesFoundForDevice("cpu-1")
	}
	if got := m.sharesFoundPerDevice["cpu-1"].Value(); got != 5 {
		t.Errorf("counter = %d, want 5", got)
	}
}

func TestIncSharesFoundForDevice_EmptyIDIsNoOp(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.incSharesFoundForDevice("") // must not panic or create a counter
	if len(m.sharesFoundPerDevice) != 0 {
		t.Errorf("empty DeviceID created %d entries, want 0", len(m.sharesFoundPerDevice))
	}
}

func TestIncSharesFoundForDevice_MultipleDevicesTrackedSeparately(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.incSharesFoundForDevice("cpu-0")
	m.incSharesFoundForDevice("cpu-0")
	m.incSharesFoundForDevice("cpu-1")

	if got := m.sharesFoundPerDevice["cpu-0"].Value(); got != 2 {
		t.Errorf("cpu-0 = %d, want 2", got)
	}
	if got := m.sharesFoundPerDevice["cpu-1"].Value(); got != 1 {
		t.Errorf("cpu-1 = %d, want 1", got)
	}
}

func TestIncSharesFoundForDevice_AppearsInWriteText(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.incSharesFoundForDevice("gpu-0")

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `otedama_device_shares_found_total{device="gpu-0"} 1`) {
		t.Errorf("per-device counter missing from WriteText output:\n%s", out)
	}
}

// ============================================================================
// Curtailment metric — gauge is registered and starts at 0
// ============================================================================

func TestEngineMetrics_CurtailedGauge_RegisteredAndZero(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	// Before any curtailment event the gauge must be 0.
	if got := m.curtailed.Value(); got != 0 {
		t.Errorf("curtailed gauge initial = %v, want 0", got)
	}
}

func TestEngineMetrics_CurtailedGauge_AppearsInWriteText(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.curtailed.Set(1)

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "otedama_curtailed") {
		t.Errorf("otedama_curtailed missing from WriteText output:\n%s", out)
	}
	if !strings.Contains(out, "otedama_curtailed 1") {
		t.Errorf("otedama_curtailed should be 1 after Set(1):\n%s", out)
	}
}

// ============================================================================
// J/TH efficiency metric
// ============================================================================

func TestEngineMetrics_JoulesPerTerahash_RegisteredAndZero(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	if got := m.joulesPerTerahash.Value(); got != 0 {
		t.Errorf("joulesPerTerahash initial = %v, want 0", got)
	}
	if got := m.powerWatts.Value(); got != 0 {
		t.Errorf("powerWatts initial = %v, want 0", got)
	}
}

func TestEngineMetrics_JoulesPerTerahash_Calculation(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)

	// At 100 W and 100 GH/s: J/TH = 100W × 1e12 / 100e9 H/s = 1000 J/TH.
	const watts = 100.0
	const hashrate = 100e9
	m.powerWatts.Set(watts)
	m.joulesPerTerahash.Set(watts * 1e12 / hashrate)

	got := m.joulesPerTerahash.Value()
	const want = 1000.0
	if got != want {
		t.Errorf("J/TH = %v, want %v", got, want)
	}
}

func TestEngineMetrics_JoulesPerTerahash_AppearsInWriteText(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.powerWatts.Set(100)
	m.joulesPerTerahash.Set(1000)

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "otedama_joules_per_terahash") {
		t.Errorf("otedama_joules_per_terahash missing from WriteText:\n%s", out)
	}
	if !strings.Contains(out, "otedama_power_watts") {
		t.Errorf("otedama_power_watts missing from WriteText:\n%s", out)
	}
}

// ============================================================================
// pruneStaleStreams — dead-provider quote expiry (session 122)
// ============================================================================

func TestPruneStaleStreams_RemovesExpiredKeepsFresh(t *testing.T) {
	now := time.Now()
	m := map[string]arbitration.Stream{
		"ai.akash:gpu-0":       {ID: "ai.akash"},
		"mining.stratum:cpu-0": {ID: "mining.stratum"},
	}
	seen := map[string]time.Time{
		"ai.akash:gpu-0":       now.Add(-5 * time.Minute),  // stale (> 3m)
		"mining.stratum:cpu-0": now.Add(-30 * time.Second), // fresh
	}
	pruned := pruneStaleStreams(m, seen, now, streamStaleTimeout)

	if len(pruned) != 1 || pruned[0] != "ai.akash:gpu-0" {
		t.Fatalf("pruned = %v, want [ai.akash:gpu-0]", pruned)
	}
	if _, ok := m["ai.akash:gpu-0"]; ok {
		t.Error("stale stream still present in map")
	}
	if _, ok := seen["ai.akash:gpu-0"]; ok {
		t.Error("stale stream still present in seen map")
	}
	if _, ok := m["mining.stratum:cpu-0"]; !ok {
		t.Error("fresh stream was wrongly pruned")
	}
}

func TestPruneStaleStreams_NeverPrunesUntimestampedEntries(t *testing.T) {
	// A stream present in the map but absent from `seen` (e.g. pre-seeded
	// directly, never quoted) must never be pruned, regardless of `now`.
	now := time.Now()
	m := map[string]arbitration.Stream{"mining.stratum:cpu-0": {ID: "mining.stratum"}}
	seen := map[string]time.Time{} // no timestamp recorded

	if pruned := pruneStaleStreams(m, seen, now.Add(100*time.Hour), streamStaleTimeout); len(pruned) != 0 {
		t.Errorf("pruned untimestamped entry: %v", pruned)
	}
	if _, ok := m["mining.stratum:cpu-0"]; !ok {
		t.Error("untimestamped stream was pruned")
	}
}

func TestPruneStaleStreams_BoundaryAtTTL(t *testing.T) {
	now := time.Now()
	m := map[string]arbitration.Stream{"a:x": {ID: "a"}, "b:y": {ID: "b"}}
	seen := map[string]time.Time{
		"a:x": now.Add(-streamStaleTimeout),               // exactly ttl old → not yet stale (> ttl is the test)
		"b:y": now.Add(-streamStaleTimeout - time.Second), // just past ttl → stale
	}
	pruned := pruneStaleStreams(m, seen, now, streamStaleTimeout)
	if len(pruned) != 1 || pruned[0] != "b:y" {
		t.Errorf("pruned = %v, want [b:y] (exactly-ttl entry must survive)", pruned)
	}
}

func TestEngineMetrics_ActiveStreamsGauge_Registered(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.activeStreams.Set(3)
	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	if !strings.Contains(buf.String(), "otedama_active_streams 3") {
		t.Errorf("otedama_active_streams missing/incorrect:\n%s", buf.String())
	}
}

// ============================================================================
// uptimeAccountant — effective-uptime accounting (session 124)
// ============================================================================

func TestUptimeAccountant_PrimesOnFirstObserve(t *testing.T) {
	reg := metrics.NewRegistry()
	c := reg.NewCounter("otedama_productive_seconds_total", "", nil)
	var u uptimeAccountant
	base := time.Now()
	u.observe(base, true, c) // first call primes; accounts nothing
	if c.Value() != 0 {
		t.Errorf("first observe accounted %d seconds, want 0 (priming)", c.Value())
	}
}

func TestUptimeAccountant_AccumulatesProductiveSeconds(t *testing.T) {
	reg := metrics.NewRegistry()
	c := reg.NewCounter("otedama_productive_seconds_total", "", nil)
	var u uptimeAccountant
	base := time.Now()
	u.observe(base, true, c)                     // prime
	u.observe(base.Add(10*time.Second), true, c) // +10s productive
	u.observe(base.Add(25*time.Second), true, c) // +15s productive
	if c.Value() != 25 {
		t.Errorf("productive seconds = %d, want 25", c.Value())
	}
}

func TestUptimeAccountant_SkipsNonProductiveTime(t *testing.T) {
	reg := metrics.NewRegistry()
	c := reg.NewCounter("otedama_productive_seconds_total", "", nil)
	var u uptimeAccountant
	base := time.Now()
	u.observe(base, true, c)                      // prime
	u.observe(base.Add(10*time.Second), false, c) // stalled/curtailed: not counted
	u.observe(base.Add(20*time.Second), true, c)  // +10s productive
	if c.Value() != 10 {
		t.Errorf("productive seconds = %d, want 10 (non-productive interval excluded)", c.Value())
	}
}

func TestUptimeAccountant_CarriesFractionalRemainder(t *testing.T) {
	reg := metrics.NewRegistry()
	c := reg.NewCounter("otedama_productive_seconds_total", "", nil)
	var u uptimeAccountant
	base := time.Now()
	u.observe(base, true, c)
	// Two 0.6s productive intervals = 1.2s → 1 whole second flushed, 0.2 carried.
	u.observe(base.Add(600*time.Millisecond), true, c)
	if c.Value() != 0 {
		t.Errorf("after 0.6s: counter = %d, want 0 (sub-second carried)", c.Value())
	}
	u.observe(base.Add(1200*time.Millisecond), true, c)
	if c.Value() != 1 {
		t.Errorf("after 1.2s: counter = %d, want 1 (whole second flushed)", c.Value())
	}
}

func TestUptimeAccountant_IgnoresNonPositiveAndNilCounter(t *testing.T) {
	reg := metrics.NewRegistry()
	c := reg.NewCounter("otedama_productive_seconds_total", "", nil)
	var u uptimeAccountant
	base := time.Now()
	u.observe(base, true, c)
	u.observe(base.Add(-5*time.Second), true, c) // clock went backwards: ignore
	if c.Value() != 0 {
		t.Errorf("counter = %d, want 0 (negative elapsed ignored)", c.Value())
	}
	// nil counter must not panic.
	var u2 uptimeAccountant
	u2.observe(base, true, nil)
	u2.observe(base.Add(time.Second), true, nil)
}

// ============================================================================
// satsAccountant — estimated-earnings integration (KNOWN_LIMITATIONS §9)
// ============================================================================

func TestSatsAccountant_PrimesOnFirstObserve(t *testing.T) {
	var s satsAccountant
	base := time.Now()
	// First call primes the clock and must add nothing even at a high rate.
	if got := s.observe(base, 1000, true); got != 0 {
		t.Errorf("first observe = %v, want 0 (priming call adds nothing)", got)
	}
}

func TestSatsAccountant_IntegratesRateOverProductiveTime(t *testing.T) {
	var s satsAccountant
	base := time.Now()
	s.observe(base, 5, true)                            // prime
	got := s.observe(base.Add(10*time.Second), 5, true) // 5 sats/s × 10 s = 50
	if got != 50 {
		t.Errorf("accumulated = %v, want 50 (5 sats/s over 10 s)", got)
	}
	// A second interval accumulates on top of the first.
	got = s.observe(base.Add(20*time.Second), 5, true) // +50
	if got != 100 {
		t.Errorf("accumulated = %v, want 100 (two 10 s intervals)", got)
	}
}

func TestSatsAccountant_SkipsNonProductiveInterval(t *testing.T) {
	var s satsAccountant
	base := time.Now()
	s.observe(base, 5, true)                             // prime
	got := s.observe(base.Add(10*time.Second), 5, false) // not productive → +0
	if got != 0 {
		t.Errorf("accumulated = %v, want 0 (non-productive interval)", got)
	}
}

func TestSatsAccountant_SkipsNonPositiveRateAndBackwardsClock(t *testing.T) {
	var s satsAccountant
	base := time.Now()
	s.observe(base, 5, true) // prime
	if got := s.observe(base.Add(10*time.Second), 0, true); got != 0 {
		t.Errorf("zero-rate interval accumulated %v, want 0", got)
	}
	if got := s.observe(base.Add(5*time.Second), 5, true); got != 0 {
		t.Errorf("backwards-clock interval accumulated %v, want 0", got)
	}
}

func TestSatsAccountant_RetainsFractionalPrecision(t *testing.T) {
	var s satsAccountant
	base := time.Now()
	s.observe(base, 0.3, true) // prime
	// 0.3 sats/s × 1 s = 0.3, below 1 — must not be truncated to 0 internally;
	// three such intervals cross the integer boundary.
	s.observe(base.Add(1*time.Second), 0.3, true)
	s.observe(base.Add(2*time.Second), 0.3, true)
	got := s.observe(base.Add(3*time.Second), 0.3, true)
	if got < 0.89 || got > 0.91 {
		t.Errorf("accumulated = %v, want ~0.9 (fractional precision retained)", got)
	}
}

// ============================================================================
// effectiveYield — gross-minus-losses yield estimate (RESEARCH_IMPROVEMENTS
// Category 3 #12: fold downtime into a single yield number)
// ============================================================================

func TestEffectiveYield_FullUptimeMatchesExpectedYield(t *testing.T) {
	// 100% productive fraction: effective yield equals the raw quote exactly.
	got := effectiveYield(1000, 3600, 3600)
	if got != 1000 {
		t.Errorf("effectiveYield(full uptime) = %v, want 1000", got)
	}
}

func TestEffectiveYield_HalfUptimeHalvesYield(t *testing.T) {
	// The headline equivalence this metric exists to show: a device quoted
	// at X sats/s but only hashing half the time nets the same as one
	// quoted at X/2 sats/s running continuously.
	got := effectiveYield(1000, 1800, 3600)
	if got != 500 {
		t.Errorf("effectiveYield(50%% uptime) = %v, want 500", got)
	}
}

func TestEffectiveYield_ZeroUptimeReturnsZeroNotNaN(t *testing.T) {
	// Nothing has run long enough yet (e.g. the very first tick after
	// start) for a meaningful ratio; must not divide by zero.
	got := effectiveYield(1000, 0, 0)
	if got != 0 {
		t.Errorf("effectiveYield(uptime=0) = %v, want 0", got)
	}
}

func TestEffectiveYield_NegativeUptimeReturnsZero(t *testing.T) {
	got := effectiveYield(1000, 0, -1)
	if got != 0 {
		t.Errorf("effectiveYield(negative uptime) = %v, want 0", got)
	}
}

func TestEffectiveYield_ClampsFractionAboveOne(t *testing.T) {
	// Guards against productiveSeconds transiently read ahead of uptime by
	// two different tickers — the fraction must never exceed 1, which would
	// otherwise report an effective yield higher than the raw quote.
	got := effectiveYield(1000, 3700, 3600) // productive > uptime
	if got != 1000 {
		t.Errorf("effectiveYield(productive > uptime) = %v, want 1000 (clamped)", got)
	}
}

func TestEffectiveYield_ZeroExpectedYieldIsZero(t *testing.T) {
	got := effectiveYield(0, 3600, 3600)
	if got != 0 {
		t.Errorf("effectiveYield(expectedYield=0) = %v, want 0", got)
	}
}

// ============================================================================
// Arbitration holds metric — observing declined switches (session 131)
// ============================================================================

func TestEngineMetrics_ArbitrationHolds_AppearsInOutput(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.arbitrationHolds.Inc()
	m.arbitrationHolds.Inc()

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	if !strings.Contains(buf.String(), "otedama_arbitration_holds_total 2") {
		t.Errorf("otedama_arbitration_holds_total missing/incorrect:\n%s", buf.String())
	}
}

// ============================================================================
// effectiveYieldSatsPerSec gauge — registration and exposition (session 231)
// ============================================================================

func TestEngineMetrics_EffectiveYieldSatsPerSec_AppearsInOutput(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.effectiveYieldSatsPerSec.Set(effectiveYield(1000, 1800, 3600))

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	if !strings.Contains(buf.String(), "otedama_effective_yield_sats_per_second 500") {
		t.Errorf("otedama_effective_yield_sats_per_second missing/incorrect:\n%s", buf.String())
	}
}

// ============================================================================
// setActivePayout — payout-destination transparency (session 132)
// ============================================================================

func TestSetActivePayout_ExposesActiveAddress(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.setActivePayout("bc1q…mdq")

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	if !strings.Contains(buf.String(), `otedama_payout_info{address="bc1q…mdq"} 1`) {
		t.Errorf("active payout series missing/incorrect:\n%s", buf.String())
	}
}

func TestSetActivePayout_FailoverZeroesPrevious(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.setActivePayout("bc1q…aaa") // primary
	m.setActivePayout("bc1q…bbb") // failover to backup

	out := func() string {
		var b strings.Builder
		if err := reg.WriteText(&b); err != nil {
			t.Fatalf("WriteText: %v", err)
		}
		return b.String()
	}()
	if !strings.Contains(out, `otedama_payout_info{address="bc1q…aaa"} 0`) {
		t.Errorf("previous payout address should read 0 after failover:\n%s", out)
	}
	if !strings.Contains(out, `otedama_payout_info{address="bc1q…bbb"} 1`) {
		t.Errorf("new payout address should read 1 after failover:\n%s", out)
	}
}

func TestSetActivePayout_UnchangedIsNoOp(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.setActivePayout("bc1q…mdq")
	m.setActivePayout("bc1q…mdq") // same → no churn
	if len(m.payoutInfo) != 1 {
		t.Errorf("payoutInfo has %d series, want 1", len(m.payoutInfo))
	}
	if m.payoutInfo["bc1q…mdq"].Value() != 1 {
		t.Error("active series should still read 1")
	}
}

func TestSetActivePayout_EmptyIgnored(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	m.setActivePayout("")
	if len(m.payoutInfo) != 0 {
		t.Errorf("empty address created %d series, want 0", len(m.payoutInfo))
	}
}

// ============================================================================
// Power-cost metric — economic (net-profit) perspective (session 130)
// ============================================================================

func TestEngineMetrics_PowerCostGauge_RegisteredAndZero(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	if got := m.powerCostUSDPerHour.Value(); got != 0 {
		t.Errorf("powerCostUSDPerHour initial = %v, want 0", got)
	}
}

func TestEngineMetrics_PowerCost_Computation(t *testing.T) {
	reg := metrics.NewRegistry()
	m := newEngineMetrics(reg)
	// 1200 W at $0.10/kWh = 1.2 kW × 0.10 = $0.12/hour.
	const watts, price = 1200.0, 0.10
	m.powerCostUSDPerHour.Set(watts / 1000 * price)
	got := m.powerCostUSDPerHour.Value()
	const want = 0.12
	if got < want-1e-9 || got > want+1e-9 {
		t.Errorf("power cost = %v, want %v", got, want)
	}

	var buf strings.Builder
	if err := reg.WriteText(&buf); err != nil {
		t.Fatalf("WriteText: %v", err)
	}
	if !strings.Contains(buf.String(), "otedama_power_cost_usd_per_hour") {
		t.Errorf("otedama_power_cost_usd_per_hour missing from output:\n%s", buf.String())
	}
}

// ============================================================================
// Helpers
// ============================================================================

func mapKeys(m map[string]arbitration.Stream) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
