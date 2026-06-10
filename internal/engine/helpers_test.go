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
	stats := buildStats(opts, 1234.5, 42)

	if stats.HashRate != 1234.5 {
		t.Errorf("HashRate = %v, want 1234.5", stats.HashRate)
	}
	if stats.WalletFingerprint != "a1b2c3d4" {
		t.Errorf("WalletFingerprint = %q, want a1b2c3d4", stats.WalletFingerprint)
	}
	if stats.Devices != 2 {
		t.Errorf("Devices = %d, want 2", stats.Devices)
	}
	if stats.TotalSatsEarned != 42 {
		t.Errorf("TotalSatsEarned = %d, want 42", stats.TotalSatsEarned)
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
// cpuDriver — built-in driver satisfies hal.Driver
// ============================================================================

func TestCPUDriver_Name(t *testing.T) {
	d := &cpuDriver{}
	if d.Name() != "cpu" {
		t.Errorf("Name() = %q, want cpu", d.Name())
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
// Helpers
// ============================================================================

func mapKeys(m map[string]arbitration.Stream) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
