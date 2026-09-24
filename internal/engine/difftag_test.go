// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package engine

import "testing"

// A share whose job was tagged under the previous difficulty is a
// cross-generation reject once the pool raises (or lowers) the target —
// benign(), regardless of direction.
func TestDifficultyTagger_BenignOnDifficultyChange(t *testing.T) {
	dt := newDifficultyTagger(8)
	dt.tag(7, 1000)

	if !dt.benign(7, 2000) {
		t.Error("job tagged at 1000 rejected after raise to 2000 should be benign")
	}
	if !dt.benign(7, 500) {
		t.Error("job tagged at 1000 rejected after drop to 500 should be benign")
	}
}

// A reject on a job issued under the *current* difficulty is a real
// reject — the share genuinely missed the target it was issued under.
func TestDifficultyTagger_NotBenignWhenDifficultyUnchanged(t *testing.T) {
	dt := newDifficultyTagger(8)
	dt.tag(7, 1000)

	if dt.benign(7, 1000) {
		t.Error("job tagged at 1000 rejected while difficulty still 1000 must not be benign")
	}
}

// Untagged job IDs (never applied, or evicted) can only be judged
// against the current difficulty — never benign.
func TestDifficultyTagger_UnknownJobNotBenign(t *testing.T) {
	dt := newDifficultyTagger(8)
	if dt.benign(99, 2000) {
		t.Error("untagged job must not be benign")
	}
}

// The map is bounded: oldest tags evict so a long session cannot grow it
// without limit, and an evicted job is treated as unknown (not benign).
func TestDifficultyTagger_EvictsOldest(t *testing.T) {
	dt := newDifficultyTagger(2)
	dt.tag(1, 100)
	dt.tag(2, 200)
	dt.tag(3, 300) // evicts job 1

	if dt.benign(1, 999) {
		t.Error("evicted job 1 must not be benign")
	}
	if !dt.benign(2, 999) || !dt.benign(3, 999) {
		t.Error("jobs 2 and 3 must remain tagged and benign on change")
	}
}

// Re-tagging an existing job ID updates its difficulty without growing
// the entry count or evicting a second job.
func TestDifficultyTagger_RetagUpdates(t *testing.T) {
	dt := newDifficultyTagger(2)
	dt.tag(1, 100)
	dt.tag(1, 150)
	dt.tag(2, 200)

	if dt.benign(1, 150) {
		t.Error("re-tagged job 1 must report current tag 150, not stale 100")
	}
	if !dt.benign(1, 999) {
		t.Error("re-tagged job 1 should still be benign on a new difficulty")
	}
	if !dt.benign(2, 999) {
		t.Error("job 2 must not have been evicted by the re-tag of job 1")
	}
}
