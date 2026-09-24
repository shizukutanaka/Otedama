// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package miner

import (
	"context"
	"fmt"
	"math/bits"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// Work is the current mining job delivered by the pool.
// The Worker hashes block headers derived from this work looking for
// a Nonce that satisfies the difficulty target.
type Work struct {
	// JobID is the pool-supplied job identifier, kept as an opaque
	// string: Stratum V1 job IDs are not decimal (Braiins, F2Pool,
	// public-pool all send alphanumeric IDs), so it must echo back on
	// submit verbatim rather than round-tripping through a uint32.
	JobID     string
	ChannelID uint32
	Header    Header // template; Nonce field will be overwritten
	NBits     uint32 // network compact target (from SetNewPrevHash / mining.notify)
	Target    Hash   // SHARE target the hash must meet (pool-assigned difficulty)

	// VersionMask is the BIP-310 negotiated mask of header-version bits
	// the miner may change (0 = not negotiated). When nonzero, the grind
	// loop rolls these bits on nonce-space exhaustion before falling
	// back to nTime rolling — the standard miner ordering — extending
	// per-job search space by roughly 2^popcount(mask). The masked bits
	// are reported on submission (Stratum V1 submit param 6).
	VersionMask uint32
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
	// JobID echoes Work.JobID of the job that produced this share.
	JobID   string
	Nonce   uint32
	NTime   uint32
	Version uint32
	Hash    Hash
	// Target is the share target the hash was validated against at issue
	// time — Work.Target of the job the worker was grinding when it found
	// the share. It is not transmitted on the wire; the engine uses it to
	// judge whether a pool rejection reflects a real validation failure or
	// a mid-flight difficulty change (the share was valid when produced).
	Target Hash
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
// MaxFutureBlockTimeSecs is Bitcoin's MAX_FUTURE_BLOCK_TIME: a block
// header timestamp may not exceed the network-adjusted current time by
// more than two hours. Pool-side share validation applies the same
// bound, so rolling nTime beyond it can only produce rejects. Exported
// so the engine can diagnose a job already past the cap.
const MaxFutureBlockTimeSecs = 7200

// nextSubmask returns the next value in the submask enumeration of
// mask after cur: (cur-1)&mask visits each of the 2^popcount(mask)
// patterns exactly once (wrapping back to 0 after the last). A plain
// increment would revisit the same masked value for sparse masks —
// e.g. mask 0x1fffe000 only changes once every 0x2000 steps — and
// re-hash an identical header space into duplicate-share rejects.
func nextSubmask(cur, mask uint32) uint32 { return (cur - 1) & mask }

// versionRollSpace is the number of distinct version patterns a mask
// offers — the unrolled pass plus one roll per remaining pattern.
func versionRollSpace(mask uint32) uint64 { return uint64(1) << bits.OnesCount32(mask) }

func (w *Worker) grind(ctx context.Context, threadID uint32, shares chan<- Share) {
	var (
		localWork    *Work
		localWorkVer uint64
		exhaustedVer uint64 // work version whose full search space is used up
		nonce        = threadID
		// verSub is the current submask of VersionMask applied to the
		// header version (0 = unrolled); verTried counts rolls taken.
		// Both reset on work reload.
		verSub   uint32
		verTried uint64
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
			verSub = 0       // and re-enumerate version bits for the new mask
			verTried = 0
		}
		w.mu.Unlock()

		if localWork == nil || exhaustedVer == localWorkVer {
			// No job yet, or the current job's search space (nonces ×
			// remaining nTime roll range) is exhausted; yield and retry.
			time.Sleep(10 * time.Millisecond)
			continue
		}

		// Inner loop: hash a batch of nonces before checking context
		// and work updates. Batch size balances overhead against
		// responsiveness to job changes.
		const batchSize = 1024

		h := localWork.Header
		// h is rebuilt from the job template each batch, so re-apply the
		// version submask reached by prior batches within the mask.
		if vm := localWork.VersionMask; vm != 0 && verSub != 0 {
			h.Version = (h.Version &^ vm) | verSub
		}
		for i := 0; i < batchSize; i++ {
			h.Nonce = nonce
			hash := HashHeader(h)
			w.hashCount.Add(1)

			if hash.LessOrEqual(localWork.Target) {
				share := Share{
					ChannelID: localWork.ChannelID,
					JobID:     localWork.JobID,
					Nonce:     nonce,
					NTime:     h.Time,
					Version:   h.Version,
					Hash:      hash,
					Target:    localWork.Target,
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
			next := nonce + w.cfg.NonceStep
			if next < nonce {
				// The 32-bit nonce space wrapped. Standard miner
				// behavior (BIP-310 ordering: cgminer/ESP-Miner alike)
				// rolls negotiated version bits first — free extra
				// search space — then the header timestamp, rather
				// than re-hash the same nonces (which only yields
				// duplicate-share rejects). Version rolling ends once
				// every one of the 2^popcount(mask) patterns was tried
				// (the unrolled pass counts as the first); timestamp
				// rolling is bounded by MAX_FUTURE_BLOCK_TIME (2 h ahead
				// of now): a header timestamp beyond it is consensus-
				// invalid, so further hashing can only produce rejects
				// — stop until a fresh job arrives.
				if vm := localWork.VersionMask; vm != 0 && verTried+1 < versionRollSpace(vm) {
					verSub = nextSubmask(verSub, vm)
					verTried++
					h.Version = (localWork.Header.Version &^ vm) | verSub
				} else if int64(h.Time)+1 > time.Now().Unix()+MaxFutureBlockTimeSecs {
					exhaustedVer = localWorkVer
					break
				} else {
					h.Time++
				}
				next = threadID
			}
			nonce = next
		}
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
