// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// makeEasyWork creates a Work whose target is almost all-0xFF (maximum
// difficulty 1), meaning that virtually every hash will produce a share.
// This allows tests to verify share delivery without grinding millions
// of nonces.
func makeEasyWork() *Work {
	var target Hash
	for i := range target {
		target[i] = 0xFF
	}
	// Use nBits 0x207fffff which is the largest valid compact target.
	// We provide the pre-computed Hash directly, bypassing nBits.
	return &Work{
		JobID:     1,
		ChannelID: 0,
		Header: Header{
			Version: 1,
			Time:    0x60000000,
			Bits:    0x207fffff,
		},
		NBits:  0x207fffff,
		Target: target,
	}
}

// ----- Worker lifecycle -----

func TestWorker_StatsBeforeStart(t *testing.T) {
	// Before Start is called, Stats must return a zero-value Stats so
	// callers see zero uptime and hashrate rather than a garbage negative
	// duration (time.Now() − 0 = a large positive number).
	w := NewWorker(WorkerConfig{Threads: 1})
	s := w.Stats()
	if s.Uptime != 0 {
		t.Errorf("Stats().Uptime before Start = %v, want 0", s.Uptime)
	}
	if s.HashRate != 0 {
		t.Errorf("Stats().HashRate before Start = %v, want 0", s.HashRate)
	}
	if s.HashesTotal != 0 || s.SharesFound != 0 || s.SharesDropped != 0 {
		t.Error("Stats() before Start returned non-zero counters")
	}
}

func TestWorker_StartTwicePanics(t *testing.T) {
	w := NewWorker(WorkerConfig{Threads: 1})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = w.Start(ctx)
	defer w.Stop()

	defer func() {
		if r := recover(); r == nil {
			t.Error("second Start should panic")
		}
	}()
	_ = w.Start(ctx) // must panic
}

func TestWorker_StartAndStop(t *testing.T) {
	w := NewWorker(WorkerConfig{Threads: 1})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)

	// Give the worker a moment to start.
	time.Sleep(10 * time.Millisecond)
	w.Stop()

	// Channel must be closed after Stop.
	select {
	case _, ok := <-shares:
		if ok {
			// A share arrived before stop — that's fine, just drain.
		}
	case <-time.After(100 * time.Millisecond):
		// Channel not closed — Stop didn't terminate goroutines.
		t.Error("worker did not stop within 100ms")
	}
}

func TestWorker_FindsSharesWithEasyTarget(t *testing.T) {
	// With a target of all-0xFF, every hash is a valid share.
	// We expect at least one share within a short timeout.
	w := NewWorker(WorkerConfig{Threads: 1})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	shares := w.Start(ctx)

	w.SetWork(makeEasyWork())

	select {
	case share, ok := <-shares:
		if !ok {
			t.Fatal("share channel closed before receiving a share")
		}
		// Verify the share hash actually meets the target.
		h := share
		if !h.Hash.LessOrEqual(makeEasyWork().Target) {
			t.Errorf("share hash %s does not meet target", h.Hash)
		}
	case <-ctx.Done():
		t.Fatal("no share found within 2 seconds with maximum target")
	}
}

func TestWorker_MultipleThreadsFindShares(t *testing.T) {
	// With multiple threads and maximum target, shares should arrive
	// rapidly. This test verifies thread-safe operation of the shared
	// work pointer and atomic counters.
	w := NewWorker(WorkerConfig{Threads: 4})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	shares := w.Start(ctx)
	w.SetWork(makeEasyWork())

	var count int
	for count < 10 {
		select {
		case _, ok := <-shares:
			if !ok {
				t.Fatalf("channel closed with only %d shares", count)
			}
			count++
		case <-ctx.Done():
			t.Fatalf("timeout with only %d shares (wanted 10)", count)
		}
	}
}

func TestWorker_SetWorkJobChange(t *testing.T) {
	// Verify that the worker switches to a new job when SetWork is called.
	// We set up job 1, collect a share, then switch to job 2 and verify
	// we eventually receive a share with job 2's ID.
	w := NewWorker(WorkerConfig{Threads: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shares := w.Start(ctx)

	job1 := makeEasyWork()
	job1.JobID = 1
	w.SetWork(job1)

	// Wait for at least one share from job 1.
	var job1share Share
	waitFor(t, ctx, shares, func(s Share) bool {
		if s.JobID == 1 {
			job1share = s
			return true
		}
		return false
	})
	_ = job1share

	// Now switch to job 2.
	job2 := makeEasyWork()
	job2.JobID = 2
	w.SetWork(job2)

	// We should eventually get a share from job 2.
	waitFor(t, ctx, shares, func(s Share) bool {
		return s.JobID == 2
	})
}

// waitFor drains the share channel until predicate returns true or ctx expires.
func waitFor(t *testing.T, ctx context.Context, ch <-chan Share, pred func(Share) bool) {
	t.Helper()
	for {
		select {
		case s, ok := <-ch:
			if !ok {
				t.Fatal("share channel closed unexpectedly")
			}
			if pred(s) {
				return
			}
		case <-ctx.Done():
			t.Fatal("condition not met before context deadline")
		}
	}
}

// ----- Stats -----

func TestWorker_StatsAfterWork(t *testing.T) {
	w := NewWorker(WorkerConfig{Threads: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	shares := w.Start(ctx)
	w.SetWork(makeEasyWork())

	// Wait for at least one share so counters are non-zero.
	select {
	case <-shares:
	case <-ctx.Done():
		t.Fatal("no share before deadline")
	}

	stats := w.Stats()
	if stats.HashesTotal == 0 {
		t.Error("HashesTotal is 0 after running worker")
	}
	if stats.SharesFound == 0 {
		t.Error("SharesFound is 0 after receiving share")
	}
	if stats.HashRate <= 0 {
		t.Errorf("HashRate <= 0: %f", stats.HashRate)
	}
	if stats.Uptime <= 0 {
		t.Errorf("Uptime <= 0: %v", stats.Uptime)
	}
}

// ----- DefaultWorkerConfig -----

func TestDefaultWorkerConfig_UsesAllCores(t *testing.T) {
	cfg := DefaultWorkerConfig()
	if cfg.Threads <= 0 {
		t.Errorf("Threads = %d, want > 0", cfg.Threads)
	}
	if cfg.Threads != runtime.NumCPU() {
		t.Errorf("Threads = %d, want NumCPU = %d", cfg.Threads, runtime.NumCPU())
	}
	// NonceStep is intentionally 0 in the default config: it is the
	// sentinel meaning "resolve to Threads at Start time" (see worker.go),
	// so each thread strides by the thread count and they never collide.
	if cfg.NonceStep != 0 {
		t.Errorf("NonceStep = %d, want 0 (resolve-to-Threads sentinel)", cfg.NonceStep)
	}
}

// ----- HashRateString -----

func TestHashRateString(t *testing.T) {
	tests := []struct {
		hps  float64
		want string
	}{
		{500, "500 H/s"},
		{1500, "1.50 kH/s"},
		{2.5e6, "2.50 MH/s"},
		{3.7e9, "3.70 GH/s"},
		{120e12, "120.00 TH/s"},
	}
	for _, tt := range tests {
		got := HashRateString(tt.hps)
		if got != tt.want {
			t.Errorf("HashRateString(%g) = %q, want %q", tt.hps, got, tt.want)
		}
	}
}

// ----- Benchmark: inner loop throughput -----

func BenchmarkWorkerGrind_SingleThread(b *testing.B) {
	// Measure how many hashes/second a single goroutine achieves.
	// This establishes the baseline for performance regression detection.
	work := &Work{
		Header: Header{Version: 1, Time: 0x60000000, Bits: 0x1d00ffff},
		Target: func() Hash {
			t, _ := TargetFromNBits(0x1d00ffff)
			return t
		}(),
	}
	b.ResetTimer()
	b.ReportAllocs()

	h := work.Header
	for i := 0; i < b.N; i++ {
		h.Nonce = uint32(i)
		_ = HashHeader(h)
	}
}

func TestNewWorker_ZeroThreads_DefaultsToCPUCount(t *testing.T) {
	// cfg.Threads == 0 triggers the default to runtime.NumCPU().
	w := NewWorker(WorkerConfig{Threads: 0})
	if w.cfg.Threads <= 0 {
		t.Errorf("Threads after default = %d, want > 0", w.cfg.Threads)
	}
}

// ----- DeviceID propagation -----

func TestShare_DeviceID_PropagatedFromConfig(t *testing.T) {
	// Create a worker with a DeviceID, plant a trivial target so it finds a
	// share immediately, and verify the share carries the DeviceID.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	w := NewWorker(WorkerConfig{
		Threads:  1,
		DeviceID: "test-device-42",
	})
	shares := w.Start(ctx)
	defer w.Stop()

	// Use the genesis block difficulty: NBits=0x1d00ffff gives a target
	// that a CPU can satisfy quickly in tests.
	target, err := TargetFromNBits(0x207fffff) // extremely easy for tests
	if err != nil {
		t.Fatalf("TargetFromNBits: %v", err)
	}
	w.SetWork(&Work{
		JobID:  1,
		Header: Header{Version: 1, Time: 0x60000000, Bits: 0x207fffff},
		Target: target,
	})

	for {
		select {
		case share, ok := <-shares:
			if !ok {
				t.Fatal("share channel closed before finding a share")
			}
			if share.DeviceID != "test-device-42" {
				t.Errorf("share.DeviceID = %q, want %q", share.DeviceID, "test-device-42")
			}
			return
		case <-ctx.Done():
			t.Fatal("timeout: no share found within 3s")
		}
	}
}

func TestShare_DeviceID_EmptyWhenNotSet(t *testing.T) {
	// A worker created without DeviceID must emit shares with empty DeviceID.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	w := NewWorker(WorkerConfig{Threads: 1}) // no DeviceID
	shares := w.Start(ctx)
	defer w.Stop()

	target, err := TargetFromNBits(0x207fffff)
	if err != nil {
		t.Fatalf("TargetFromNBits: %v", err)
	}
	w.SetWork(&Work{
		JobID:  1,
		Header: Header{Version: 1, Time: 0x60000000, Bits: 0x207fffff},
		Target: target,
	})

	for {
		select {
		case share, ok := <-shares:
			if !ok {
				t.Fatal("share channel closed before finding a share")
			}
			if share.DeviceID != "" {
				t.Errorf("share.DeviceID = %q, want empty (no DeviceID in config)", share.DeviceID)
			}
			return
		case <-ctx.Done():
			t.Fatal("timeout: no share found within 3s")
		}
	}
}

// ----- DeviceID method -----

func TestWorker_DeviceID_ReturnsConfigValue(t *testing.T) {
	w := NewWorker(WorkerConfig{Threads: 1, DeviceID: "gpu-0"})
	if got := w.DeviceID(); got != "gpu-0" {
		t.Errorf("DeviceID() = %q, want %q", got, "gpu-0")
	}
}

func TestWorker_DeviceID_EmptyWhenNotConfigured(t *testing.T) {
	w := NewWorker(WorkerConfig{Threads: 1})
	if got := w.DeviceID(); got != "" {
		t.Errorf("DeviceID() = %q, want empty string", got)
	}
}

// TestWorker_NonceBasePartitionsAcrossWorkers proves two workers built
// the way startMinerWorkers builds them (same Work, NonceBase=i*Threads,
// NonceStep=totalLanes) never hash the same nonce: worker A covers
// residues {0..3} mod 8 and worker B {4..7} mod 8. Before NonceBase,
// every worker started every thread at nonce=threadID with step=Threads,
// so two devices grinding the same job produced identical
// (header, nonce) tuples — shares a pool rejects as duplicates.
func TestWorker_NonceBasePartitionsAcrossWorkers(t *testing.T) {
	const threads = 4
	const stride = 2 * threads // 2 workers × 4 threads
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	collect := func(base uint32, n int) map[uint32]bool {
		w := NewWorker(WorkerConfig{Threads: threads, NonceStep: stride, NonceBase: base})
		w.SetWork(makeEasyWork())
		shares := w.Start(ctx)
		defer w.Stop()
		seen := make(map[uint32]bool, n)
		for len(seen) < n {
			select {
			case s, ok := <-shares:
				if !ok {
					t.Fatalf("share channel closed after %d shares", len(seen))
				}
				seen[s.Nonce] = true
			case <-ctx.Done():
				t.Fatalf("timed out collecting shares (got %d, want %d)", len(seen), n)
			}
		}
		return seen
	}

	a := collect(0, 64)
	b := collect(threads, 64)
	for nonce := range b {
		if a[nonce] {
			t.Fatalf("nonce %d produced by both workers — duplicate share", nonce)
		}
	}
	// Every nonce B produced must sit in B's lanes (base..base+threads-1
	// mod stride); a lane leak would still collide on some other job.
	for nonce := range b {
		if got := nonce % stride; got < threads || got >= stride {
			t.Errorf("worker B hashed nonce %d outside its lanes (residue %d)", nonce, got)
		}
	}
	for nonce := range a {
		if got := nonce % stride; got >= threads {
			t.Errorf("worker A hashed nonce %d outside its lanes (residue %d)", nonce, got)
		}
	}
}

// TestWorker_ParksExhaustedNonceLane pins the wrap-around defect: with a
// fixed header (baked extranonce2), a thread whose lane wraps would
// re-hash the identical sequence — every share an exact pool duplicate.
// The fix parks the lane until the next job. We force a tiny lane by
// placing the base near the top of the space: lane = one nonce.
func TestWorker_ParksExhaustedNonceLane(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Lane = exactly one nonce: base = 2^32-8, step = 8 → hashes
	// 0xFFFFFFF8 then next wraps to 0 → exhausted.
	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 8, NonceBase: 0xFFFFFFF8})
	w.SetWork(makeEasyWork())
	shares := w.Start(ctx)
	defer w.Stop()

	// The single lane nonce produces exactly one share (max target);
	// after that the thread must park — any second share means it
	// re-hashed a wrapped nonce.
	first, ok := <-shares
	if !ok {
		t.Fatal("no share emitted for the single-nonce lane")
	}
	if first.Nonce != 0xFFFFFFF8 {
		t.Fatalf("first share nonce = %#x, want 0xFFFFFFF8", first.Nonce)
	}
	select {
	case s := <-shares:
		t.Fatalf("second share (nonce %#x) — thread re-hashed a wrapped lane", s.Nonce)
	case <-time.After(250 * time.Millisecond):
	}
	// A new job re-arms the lane: next work must produce again.
	w.SetWork(makeEasyWork())
	select {
	case s := <-shares:
		if s.Nonce != 0xFFFFFFF8 {
			t.Fatalf("re-armed share nonce = %#x, want 0xFFFFFFF8", s.Nonce)
		}
	case <-ctx.Done():
		t.Fatal("worker did not re-arm on new job after lane exhaustion")
	}
}
