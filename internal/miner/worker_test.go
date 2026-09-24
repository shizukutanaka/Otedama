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
		JobID:     "1",
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
	job1.JobID = "1"
	w.SetWork(job1)

	// Wait for at least one share from job 1.
	var job1share Share
	waitFor(t, ctx, shares, func(s Share) bool {
		if s.JobID == "1" {
			job1share = s
			return true
		}
		return false
	})
	_ = job1share

	// Now switch to job 2.
	job2 := makeEasyWork()
	job2.JobID = "2"
	w.SetWork(job2)

	// We should eventually get a share from job 2.
	waitFor(t, ctx, shares, func(s Share) bool {
		return s.JobID == "2"
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
		JobID:  "1",
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
		JobID:  "1",
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

// ----- nTime rolling on nonce-space exhaustion -----

// TestWorker_RollsNTimeOnNonceWrap forces a nonce wrap every two hashes
// (NonceStep = MaxUint32 walks 0 → MaxUint32 → wrap) and asserts the
// worker rolls the header timestamp forward instead of re-hashing the
// same nonce space — the standard miner behavior that prevents
// duplicate-share rejects after nonce exhaustion.
func TestWorker_RollsNTimeOnNonceWrap(t *testing.T) {
	work := makeEasyWork()
	work.Header.Time = uint32(time.Now().Unix()) - 60 // comfortably rollable

	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 0xFFFFFFFF})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()
	w.SetWork(work)

	base := work.Header.Time
	seenRolled := false
	deadline := time.After(5 * time.Second)
	for !seenRolled {
		select {
		case s, ok := <-shares:
			if !ok {
				t.Fatal("share channel closed unexpectedly")
			}
			if s.NTime > base {
				seenRolled = true
			}
		case <-deadline:
			t.Fatalf("no rolled-ntime share within timeout (base %d)", base)
		}
	}
}

// TestWorker_StopsWhenNTimeAtCap sets the job timestamp at the
// MAX_FUTURE_BLOCK_TIME cap; on nonce wrap no further valid hashing
// space remains, so the worker must stop producing work for this job
// rather than emit consensus-invalid timestamps.
func TestWorker_StopsWhenNTimeAtCap(t *testing.T) {
	work := makeEasyWork()
	work.Header.Time = uint32(time.Now().Unix()) + MaxFutureBlockTimeSecs

	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 0xFFFFFFFF})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()
	w.SetWork(work)

	// Drain any in-flight shares, then let the worker settle.
	deadline := time.After(500 * time.Millisecond)
	for draining := true; draining; {
		select {
		case <-shares:
		case <-deadline:
			draining = false
		}
	}

	before := w.Stats().HashesTotal
	time.Sleep(120 * time.Millisecond)
	after := w.Stats().HashesTotal
	if after != before {
		t.Errorf("worker kept hashing an exhausted job: %d → %d hashes", before, after)
	}
}

// TestWorker_RollsVersionBitsBeforeNTime pins the BIP-310 ordering: on
// nonce-space exhaustion the worker must roll negotiated version bits
// FIRST and roll nTime only once every mask pattern has been tried.
// With mask 0x3 the two low version bits give 3 extra passes per nTime.
func TestWorker_RollsVersionBitsBeforeNTime(t *testing.T) {
	work := makeEasyWork()
	base := work.Header.Version // 1
	work.VersionMask = 0x3
	work.Header.Time = uint32(time.Now().Unix()) - 60

	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 0xFFFFFFFF})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()
	w.SetWork(work)

	sawRolledVersion := false
	sawRolledNTime := false
	mask := work.VersionMask
	deadline := time.After(5 * time.Second)
	for !(sawRolledVersion && sawRolledNTime) {
		select {
		case s, ok := <-shares:
			if !ok {
				t.Fatal("share channel closed unexpectedly")
			}
			// Non-mask version bits must never move.
			if s.Version&^mask != base&^mask {
				t.Fatalf("share version %#08x changes bits outside mask %#08x (base %#08x)", s.Version, mask, base)
			}
			if s.Version != base && s.NTime == work.Header.Time {
				sawRolledVersion = true // version rolled while nTime still at base
			}
			if s.NTime > work.Header.Time {
				if !sawRolledVersion {
					t.Fatal("nTime rolled before version bits were exhausted (BIP-310 ordering violated)")
				}
				sawRolledNTime = true
			}
		case <-deadline:
			t.Fatalf("timeout: sawRolledVersion=%v sawRolledNTime=%v", sawRolledVersion, sawRolledNTime)
		}
	}
}

// TestWorker_NoVersionRollWithoutMask: a job with VersionMask=0 (rolling
// not negotiated) must never change version bits — the worker falls
// straight to nTime rolling.
func TestWorker_NoVersionRollWithoutMask(t *testing.T) {
	work := makeEasyWork()
	work.Header.Time = uint32(time.Now().Unix()) - 60

	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 0xFFFFFFFF})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()
	w.SetWork(work)

	deadline := time.After(3 * time.Second)
	for {
		select {
		case s, ok := <-shares:
			if !ok {
				return
			}
			if s.Version != work.Header.Version {
				t.Fatalf("version rolled to %#08x with VersionMask unset", s.Version)
			}
			if s.NTime > work.Header.Time {
				return // reached nTime roll without touching version — pass
			}
		case <-deadline:
			t.Fatal("no rolled-ntime share within timeout")
		}
	}
}

// TestNextSubmask_EnumeratesEachPatternOnce verifies the (v-1)&mask
// enumeration visits every one of the 2^popcount(mask) version patterns
// exactly once — critical for sparse masks like 0x1fffe000 (a typical
// BIP-310 negotiated mask) where a plain increment would re-hash the
// same masked space thousands of times per distinct pattern.
func TestNextSubmask_EnumeratesEachPatternOnce(t *testing.T) {
	const mask = uint32(0x1fffe000) // 16 bits → 65536 distinct patterns
	want := versionRollSpace(mask)
	if want != 65536 {
		t.Fatalf("versionRollSpace(%#x) = %d, want 65536", mask, want)
	}
	seen := make(map[uint32]struct{}, want)
	cur := uint32(0)
	for i := uint64(0); i < want; i++ {
		if cur&^mask != 0 {
			t.Fatalf("step %d: %#08x sets bits outside mask %#08x", i, cur, mask)
		}
		if _, dup := seen[cur]; dup {
			t.Fatalf("step %d: submask %#08x visited twice", i, cur)
		}
		seen[cur] = struct{}{}
		cur = nextSubmask(cur, mask)
	}
	if cur != 0 {
		t.Fatalf("after %d patterns enumeration returned %#08x, want 0 (cycle complete)", want, cur)
	}
	if uint64(len(seen)) != want {
		t.Fatalf("visited %d patterns, want %d", len(seen), want)
	}
}

// TestWorker_SparseVersionMaskRollsDistinct drives the grind loop with
// a sparse mask (0x3000, popcount 2) and asserts the worker actually
// rolls distinct version patterns (≥2 non-zero submasks observed)
// while never touching bits outside the mask. Uniqueness across the
// full 2^popcount enumeration is pinned by
// TestNextSubmask_EnumeratesEachPatternOnce; roll-before-nTime
// ordering by TestWorker_RollsVersionBitsBeforeNTime.
func TestWorker_SparseVersionMaskRollsDistinct(t *testing.T) {
	work := makeEasyWork()
	base := work.Header.Version // 1
	work.VersionMask = 0x3000
	work.Header.Time = uint32(time.Now().Unix()) - 60

	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 0xFFFFFFFF})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()
	w.SetWork(work)

	seen := map[uint32]bool{}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s, ok := <-shares:
			if !ok {
				t.Fatal("share channel closed unexpectedly")
			}
			// Non-mask bits must never move, and every observed
			// submask is a valid pattern within the mask.
			if s.Version&^work.VersionMask != base&^work.VersionMask {
				t.Fatalf("share version %#08x changes bits outside mask %#08x", s.Version, work.VersionMask)
			}
			seen[s.Version&work.VersionMask] = true
			nonzero := 0
			for v := range seen {
				if v != 0 {
					nonzero++
				}
			}
			if nonzero >= 2 {
				return // sparse mask actually rolled distinct patterns
			}
		case <-deadline:
			t.Fatalf("timeout: saw submasks %v, want >=2 distinct non-zero patterns", seen)
		}
	}
}

// TestWorker_NTimeRollPersistsAcrossBatches pins the batch-boundary
// behavior: the grind loop rebuilds the header from the job template
// each 1024-hash batch, so rolled nTime must live in grind-scope state
// and accumulate — a wrap roughly once per batch (step ≈ 2^32/1024)
// must push shares to nTime base+3 and beyond. With rolled state kept
// inside the batch (the bug this guards against), shares would stay
// pinned at base..base+1 forever, re-mining an identical space into
// duplicate-share rejects.
func TestWorker_NTimeRollPersistsAcrossBatches(t *testing.T) {
	work := makeEasyWork()
	work.Header.Time = uint32(time.Now().Unix()) - 60

	// ~2^32/1024: nonce wraps roughly once per 1024-hash batch.
	w := NewWorker(WorkerConfig{Threads: 1, NonceStep: 0x400001})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	shares := w.Start(ctx)
	defer w.Stop()
	w.SetWork(work)

	maxNTime := work.Header.Time
	deadline := time.After(8 * time.Second)
	for {
		select {
		case s, ok := <-shares:
			if !ok {
				t.Fatal("share channel closed unexpectedly")
			}
			if s.NTime > maxNTime {
				maxNTime = s.NTime
			}
			if maxNTime >= work.Header.Time+3 {
				return // rolled nTime accumulated across batch boundaries
			}
		case <-deadline:
			t.Fatalf("nTime only reached %d (base %d) — rolls not persisting across batches", maxNTime, work.Header.Time)
		}
	}
}
