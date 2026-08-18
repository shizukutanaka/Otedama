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

	// Wait for at least one share so the share counter is non-zero.
	select {
	case <-shares:
	case <-ctx.Done():
		t.Fatal("no share before deadline")
	}

	// The hash counter is flushed to the shared atomic once per batch rather
	// than once per hash (session 264 — the per-hash Add cost 30.5 ns under
	// 4-thread contention, ~11% of a hash, purely cache-line bouncing). An
	// easy target yields its first share within the opening nonces of a
	// batch, so at that instant the count is legitimately still 0. Poll for
	// the invariant that matters — the worker accounts for its hashes —
	// rather than for it having happened by one particular moment.
	var stats Stats
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		stats = w.Stats()
		if stats.HashesTotal > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if stats.HashesTotal == 0 {
		t.Error("HashesTotal is still 0 a second after the worker started producing shares")
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

// BenchmarkWorkerGrind_SingleThread measures the hashing cost the way the
// worker actually pays it.
//
// It used to call HashHeader in a loop of its own and describe that as "the
// baseline for performance regression detection". It was not: it never
// executed grind, so it could not have detected a regression in the loop it
// claimed to guard — and it did not move at all when grind switched to the
// midstate path, which is a 33% change. It now drives a real Worker and
// derives the per-hash cost from the counter the worker itself maintains.
//
// The target is unreachable, so no share is ever found and the share channel
// never fills: this measures grinding, not share handling.
func BenchmarkWorkerGrind_SingleThread(b *testing.B) {
	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 1})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	go func() {
		for range shares {
		}
	}()
	w.SetWork(&Work{
		Header: Header{Version: 1, Time: 0x60000000, Bits: 0x1d00ffff},
		Target: Hash{}, // all zero: nothing can meet it
	})

	// Let the worker pick the job up and reach steady state before the
	// window that is measured.
	time.Sleep(50 * time.Millisecond)

	start := w.Stats().HashesTotal
	t0 := time.Now()
	time.Sleep(300 * time.Millisecond)
	hashes := w.Stats().HashesTotal - start
	elapsed := time.Since(t0)

	if hashes == 0 {
		b.Fatal("the worker produced no hashes; the benchmark is measuring nothing")
	}
	b.ReportMetric(float64(hashes)/elapsed.Seconds(), "hash/s")
	b.ReportMetric(float64(elapsed.Nanoseconds())/float64(hashes), "ns/hash")
	// b.N is deliberately not used: this is a fixed-window throughput probe,
	// so the ns/op column is meaningless here. Read the custom metrics.
}

// BenchmarkWorkerGrind_AllThreads measures the same thing at the thread count
// the product actually uses (DefaultWorkerConfig spawns runtime.NumCPU()
// threads). It is a separate benchmark because the two answer different
// questions: the single-thread number is the per-hash cost, this one also
// captures whatever the threads do to each other. The per-hash hashCount
// atomic used to cost 30.5 ns under 4-thread contention — visible only here.
func BenchmarkWorkerGrind_AllThreads(b *testing.B) {
	cfg := DefaultWorkerConfig()
	w := NewWorker(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	go func() {
		for range shares {
		}
	}()
	w.SetWork(&Work{
		Header: Header{Version: 1, Time: 0x60000000, Bits: 0x1d00ffff},
		Target: Hash{},
	})

	time.Sleep(50 * time.Millisecond)
	start := w.Stats().HashesTotal
	t0 := time.Now()
	time.Sleep(300 * time.Millisecond)
	hashes := w.Stats().HashesTotal - start
	elapsed := time.Since(t0)

	if hashes == 0 {
		b.Fatal("the worker produced no hashes; the benchmark is measuring nothing")
	}
	b.ReportMetric(float64(hashes)/elapsed.Seconds(), "hash/s")
	b.ReportMetric(float64(cfg.Threads), "threads")
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

// TestWorker_ShareCarriesJobKey: a found share must name the job the pool
// knows. Stratum V1 job IDs are arbitrary strings, so Work.JobKey — not the
// numeric JobID — is what the submission echoes.
func TestWorker_ShareCarriesJobKey(t *testing.T) {
	w := NewWorker(WorkerConfig{Threads: 1})
	// A max target makes the first hash a share, so the test never depends
	// on how fast this machine hashes.
	var everything Hash
	for i := range everything {
		everything[i] = 0xff
	}
	w.SetWork(&Work{
		JobID:  7,
		JobKey: "6a4f",
		Target: everything,
		Header: Header{Version: 0x20000000, Bits: 0x1d00ffff},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	select {
	case share := <-shares:
		if share.JobKey != "6a4f" {
			t.Errorf("Share.JobKey = %q, want 6a4f", share.JobKey)
		}
		if share.JobID != 7 {
			t.Errorf("Share.JobID = %d, want 7", share.JobID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no share found against a maximal target")
	}
	cancel()
	w.Stop()
}
