// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// Work is the current mining job delivered by the pool.
// The Worker hashes block headers derived from this work looking for
// a Nonce that satisfies the difficulty target.
type Work struct {
	JobID     uint32
	ChannelID uint32
	Header    Header // template; Nonce field will be overwritten
	NBits     uint32 // network compact target (from SetNewPrevHash / mining.notify)
	Target    Hash   // SHARE target the hash must meet (pool-assigned difficulty)

	// JobKey is the pool's own job identifier, opaque to the miner and
	// echoed back verbatim on submission. Stratum V2 numbers its jobs, so
	// JobID above is authoritative there and JobKey stays empty; Stratum
	// V1 job IDs are arbitrary strings ("6a4f", "1a3b0c", …) that survive
	// no numeric round trip, so the V1 path carries them here.
	JobKey string
}

// Share is a found solution: a Header whose hash meets the target.
// The Worker sends Shares on the channel passed to Start.
//
// Version echoes the exact block-header version that was hashed, so the
// submission layer can report it faithfully (Stratum V2's
// SubmitSharesStandard.version must match the hashed header, or the pool
// recomputes a different hash and rejects the share).
type Share struct {
	ChannelID uint32
	JobID     uint32
	Nonce     uint32
	NTime     uint32
	Version   uint32
	Hash      Hash
	// JobKey is the pool's own job identifier, copied from the Work this
	// share was found on. See Work.JobKey — empty on the Stratum V2 path.
	JobKey string
	// DeviceID is the HAL identity of the device whose worker found this
	// share. Set from WorkerConfig.DeviceID; empty when not configured.
	DeviceID string
}

// WorkerConfig controls the behaviour of a Worker.
type WorkerConfig struct {
	// Threads is the number of goroutines to spawn. Zero or negative
	// values are replaced with runtime.NumCPU().
	Threads int

	// NonceStep is the number of nonces each thread skips ahead per
	// iteration, interleaving the nonce space across threads. Zero is
	// replaced with Threads (see NewWorker) — not 1 — so that with the
	// default configuration every thread's nonce sequence is disjoint
	// (thread i visits i, i+Threads, i+2*Threads, ...) rather than every
	// thread rescanning the same sequential nonces from a different
	// starting offset, which would silently discard most of the
	// available hash rate (each of Threads goroutines redundantly
	// grinding the same nonces instead of partitioning the nonce space).
	NonceStep uint32

	// DeviceID is the HAL identity of the hardware device this worker
	// runs on (e.g. "cpu-0"). Propagated to every Share the worker
	// emits so the engine can attribute shares per device.
	// Empty string means "unidentified device".
	DeviceID string
}

// DefaultWorkerConfig returns a WorkerConfig that uses all available
// CPU cores and interleaves nonces cleanly across them.
func DefaultWorkerConfig() WorkerConfig {
	return WorkerConfig{
		Threads:   runtime.NumCPU(),
		NonceStep: 0, // resolved to Threads at start time
	}
}

// Stats carries live performance counters from a running Worker.
type Stats struct {
	HashesTotal   uint64        // total hashes computed since Start
	SharesFound   uint64        // valid shares found
	SharesDropped uint64        // valid shares discarded because the consumer was full
	Uptime        time.Duration // time since Start was called
	HashRate      float64       // hashes per second (lifetime average: HashesTotal/Uptime)
}

// Worker runs SHA-256d hashing across multiple goroutines and delivers
// found Shares over a channel.
//
// The zero value is not usable; use NewWorker.
type Worker struct {
	cfg WorkerConfig

	mu      sync.Mutex
	work    *Work  // current job; nil means idle
	workVer uint64 // bumped on every SetWork call

	// Atomic counters for stats.
	hashCount  atomic.Uint64
	shareCount atomic.Uint64
	dropCount  atomic.Uint64 // shares dropped because the share channel was full
	startTime  atomic.Int64  // UnixNano
	started    atomic.Bool   // guards Start against a second call

	cancel context.CancelFunc
	done   chan struct{}
}

// NewWorker creates a Worker with the given configuration.
// If cfg is the zero value, DefaultWorkerConfig() is used.
func NewWorker(cfg WorkerConfig) *Worker {
	if cfg.Threads <= 0 {
		cfg.Threads = runtime.NumCPU()
	}
	if cfg.NonceStep == 0 {
		cfg.NonceStep = uint32(cfg.Threads)
	}
	return &Worker{cfg: cfg, done: make(chan struct{})}
}

// Start launches the mining goroutines. Found shares are sent on the
// returned channel, which is closed when the Worker stops.
//
// ctx cancellation stops all goroutines and closes the share channel.
// Start may only be called once; a second call panics immediately (rather
// than corrupting the share channel and panicking later).
func (w *Worker) Start(ctx context.Context) <-chan Share {
	if !w.started.CompareAndSwap(false, true) {
		panic("miner: Worker.Start called more than once")
	}
	shares := make(chan Share, w.cfg.Threads*4)
	innerCtx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	w.startTime.Store(time.Now().UnixNano())

	var wg sync.WaitGroup
	for i := 0; i < w.cfg.Threads; i++ {
		wg.Add(1)
		go func(threadID int) {
			defer wg.Done()
			w.grind(innerCtx, uint32(threadID), shares)
		}(i)
	}

	go func() {
		wg.Wait()
		close(shares)
		close(w.done)
	}()
	return shares
}

// Stop signals all goroutines to stop and waits for them to finish.
// Safe to call even if Start was never called; in that case it returns
// immediately.
func (w *Worker) Stop() {
	w.mu.Lock()
	cancel := w.cancel
	w.mu.Unlock()
	if cancel != nil {
		cancel()
		<-w.done
	}
}

// SetWork replaces the current mining job. The running goroutines will
// pick up the new job on their next nonce iteration, so there may be a
// very short lag (sub-millisecond) before the switch takes effect.
//
// SetWork is safe to call from any goroutine while the Worker is running.
func (w *Worker) SetWork(work *Work) {
	w.mu.Lock()
	w.work = work
	w.workVer++
	w.mu.Unlock()
}

// DeviceID returns the HAL device identity string this worker was
// configured with. Empty string means "unidentified device".
func (w *Worker) DeviceID() string { return w.cfg.DeviceID }

// HasWork reports whether the worker currently has a job assigned
// (SetWork was last called with a non-nil Work). Used by callers and
// tests that need to observe pause/resume state from outside the
// package without reaching into the unexported work field directly.
func (w *Worker) HasWork() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.work != nil
}

// CurrentWork returns the job the worker is hashing, or nil when idle.
// The returned *Work is the same value SetWork was given and must be
// treated as read-only: the grind loop reads it concurrently. Provided so
// callers and tests can inspect the assigned work — in particular that
// every block-header field was populated — without reaching into the
// package's unexported state.
func (w *Worker) CurrentWork() *Work {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.work
}

// Stats returns a snapshot of the Worker's performance counters.
// Before Start is called, Stats returns a zero-value Stats.
func (w *Worker) Stats() Stats {
	if w.startTime.Load() == 0 {
		return Stats{}
	}
	uptime := time.Duration(time.Now().UnixNano() - w.startTime.Load())
	hashes := w.hashCount.Load()
	var rate float64
	if uptime > 0 {
		rate = float64(hashes) / uptime.Seconds()
	}
	return Stats{
		HashesTotal:   hashes,
		SharesFound:   w.shareCount.Load(),
		SharesDropped: w.dropCount.Load(),
		Uptime:        uptime,
		HashRate:      rate,
	}
}

// grind is the hot loop executed by each worker goroutine.
// threadID determines the starting nonce offset so that threads do not
// duplicate work.
func (w *Worker) grind(ctx context.Context, threadID uint32, shares chan<- Share) {
	var (
		localWork    *Work
		localWorkVer uint64
		nonce        = threadID
		hasher       *headerHasher
	)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Reload work if it changed.
		w.mu.Lock()
		if w.work != localWork || w.workVer != localWorkVer {
			localWork = w.work
			localWorkVer = w.workVer
			nonce = threadID // restart nonce from thread offset on new job
			hasher = nil     // the midstate is job-specific
		}
		w.mu.Unlock()

		if localWork == nil {
			// No job yet; yield and retry.
			time.Sleep(10 * time.Millisecond)
			continue
		}

		if hasher == nil {
			// Build the midstate once per job rather than once per nonce.
			// A failure here means crypto/sha256 no longer exposes the
			// marshalable state this depends on; fall back to the plain
			// path rather than stopping the miner.
			hasher, _ = newHeaderHasher(localWork.Header)
		}

		// Inner loop: hash a batch of nonces before checking context
		// and work updates. Batch size balances overhead against
		// responsiveness to job changes.
		const batchSize = 1024

		h := localWork.Header
		// hashed accumulates this batch's count so the shared atomic is
		// touched once per batch instead of once per hash. Measured on the
		// reference machine, the per-hash Add costs 30.5 ns under 4-thread
		// contention — around 11% of a 264 ns hash, spent entirely on
		// bouncing one cache line between cores, and growing with thread
		// count. Per batch it is 0.15 ns. The counter only feeds the
		// hashrate gauge and the stall detector, so lagging by at most one
		// batch (a fraction of a millisecond at any real rate) costs
		// nothing; the remainder is flushed before every early return so
		// the total stays exact.
		var hashed uint64
		for i := 0; i < batchSize; i++ {
			var hash Hash
			if hasher != nil {
				hash = hasher.hash(nonce)
			} else {
				h.Nonce = nonce
				hash = HashHeader(h)
			}
			hashed++

			if hash.LessOrEqual(localWork.Target) {
				share := Share{
					ChannelID: localWork.ChannelID,
					JobID:     localWork.JobID,
					JobKey:    localWork.JobKey,
					Nonce:     nonce,
					NTime:     h.Time,
					Version:   h.Version,
					Hash:      hash,
					DeviceID:  w.cfg.DeviceID,
				}
				w.shareCount.Add(1)
				// Non-blocking send: if the consumer is full, the share
				// is dropped rather than blocking the miner. A larger
				// buffer (Threads*4) makes this unlikely in practice;
				// dropCount makes the rare drop observable instead of silent.
				select {
				case shares <- share:
				default:
					w.dropCount.Add(1)
				}
			}

			// Advance nonce by step (interleaves threads' nonce ranges).
			nonce += w.cfg.NonceStep
		}
		w.hashCount.Add(hashed)
	}
}

// HashRateString formats a hash rate in human-readable form.
func HashRateString(hps float64) string {
	switch {
	case hps >= 1e12:
		return fmt.Sprintf("%.2f TH/s", hps/1e12)
	case hps >= 1e9:
		return fmt.Sprintf("%.2f GH/s", hps/1e9)
	case hps >= 1e6:
		return fmt.Sprintf("%.2f MH/s", hps/1e6)
	case hps >= 1e3:
		return fmt.Sprintf("%.2f kH/s", hps/1e3)
	default:
		return fmt.Sprintf("%.0f H/s", hps)
	}
}
