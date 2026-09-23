// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package engine

import "sync"

// difficultyTagger tags each issued V1 job with the pool's suggested
// share difficulty in force at the time the job was applied.
//
// A pool's mining.set_difficulty takes effect immediately on the pool
// side, but shares the worker already found under the previous target
// are still in flight. The pool rejects those with a difficulty-class
// reason ("above target", "low-difficulty-share") — a cross-generation
// race, not a miner fault (bitaxeorg/ESP-Miner #212). The tag lets the
// engine separate those benign rejects from real difficulty rejects
// (shares genuinely below the current target — hardware or config
// trouble) so the reject-rate metric only ever counts the real kind.
type difficultyTagger struct {
	mu    sync.Mutex
	diffs map[uint32]float64
	order []uint32 // jobIDs in insertion order, for bounded eviction
	max   int
}

// newDifficultyTagger keeps at most max tag entries. Job IDs cycle fast
// on busy pools; 64 comfortably covers a session's outstanding work.
func newDifficultyTagger(max int) *difficultyTagger {
	if max <= 0 {
		max = 1
	}
	return &difficultyTagger{diffs: make(map[uint32]float64, max), max: max}
}

// tag records that jobID was issued under the given share difficulty.
func (t *difficultyTagger) tag(jobID uint32, difficulty float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.diffs[jobID]; !ok {
		t.order = append(t.order, jobID)
	}
	t.diffs[jobID] = difficulty
	for len(t.order) > t.max {
		delete(t.diffs, t.order[0])
		t.order = t.order[1:]
	}
}

// benign reports whether jobID is a known job issued under a different
// difficulty than the pool's current one — i.e. a reject on it is a
// cross-generation race and not evidence of real mining trouble.
// Unknown job IDs return false: an untagged share can only be judged
// against the current difficulty.
func (t *difficultyTagger) benign(jobID uint32, current float64) bool {
	t.mu.Lock()
	d, ok := t.diffs[jobID]
	t.mu.Unlock()
	return ok && d != current
}
