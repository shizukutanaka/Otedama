// SPDX-License-Identifier: Apache-2.0
package engine

import (
	"bufio"
	"bytes"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/lightning"
)

func backupTestMnemonic() lightning.Mnemonic {
	return lightning.Mnemonic{
		"abandon", "ability", "able", "about",
		"above", "absent", "absorb", "abstract",
		"absurd", "abuse", "access", "accident",
	}
}

func TestPickBackupPositions(t *testing.T) {
	pos := pickBackupPositions(12, 3)
	if len(pos) != 3 {
		t.Fatalf("pick(12,3) returned %d positions, want 3", len(pos))
	}
	seen := map[int]bool{}
	prev := 0
	for _, p := range pos {
		if p < 1 || p > 12 {
			t.Fatalf("position %d out of range [1,12]", p)
		}
		if seen[p] {
			t.Fatalf("position %d drawn twice", p)
		}
		if p <= prev {
			t.Fatalf("positions not ascending: %v", pos)
		}
		seen[p] = true
		prev = p
	}
	if got := pickBackupPositions(0, 3); got != nil {
		t.Fatalf("pick(0,3) = %v, want nil", got)
	}
	if got := pickBackupPositions(12, 0); got != nil {
		t.Fatalf("pick(12,0) = %v, want nil", got)
	}
	if got := pickBackupPositions(2, 5); len(got) != 2 {
		t.Fatalf("pick(2,5) returned %d, want 2 (clamped)", len(got))
	}
}

func TestBackupWordsMatch(t *testing.T) {
	m := backupTestMnemonic()
	if !backupWordsMatch(m, []int{1, 5, 12}, []string{"abandon", "above", "accident"}) {
		t.Fatal("exact answers should match")
	}
	if !backupWordsMatch(m, []int{1}, []string{"  Abandon  "}) {
		t.Fatal("whitespace/case should be normalized")
	}
	if backupWordsMatch(m, []int{1}, []string{"ability"}) {
		t.Fatal("wrong word must not match")
	}
	if backupWordsMatch(m, []int{1, 2}, []string{"abandon"}) {
		t.Fatal("answer-count mismatch must fail")
	}
	if backupWordsMatch(m, []int{0, 13}, []string{"x", "y"}) {
		t.Fatal("out-of-range positions must fail")
	}
}

func TestBackupCheckRound(t *testing.T) {
	m := backupTestMnemonic()
	out := &bytes.Buffer{}
	in := strings.NewReader("abandon\nabove\naccident\n")
	if !backupCheckRound(out, bufio.NewScanner(in), m, []int{1, 5, 12}) {
		t.Fatal("correct answers should pass; out:", out.String())
	}
	for _, want := range []string{"Word #1", "Word #5", "Word #12"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("prompt missing %q in %q", want, out.String())
		}
	}
}

func TestBackupCheckRound_EOF(t *testing.T) {
	m := backupTestMnemonic()
	out := &bytes.Buffer{}
	in := strings.NewReader("abandon\n") // one line, check wants three
	if backupCheckRound(out, bufio.NewScanner(in), m, []int{1, 5, 12}) {
		t.Fatal("short input must not pass")
	}
	if !strings.Contains(out.String(), "no input") {
		t.Fatalf("expected skip notice, got %q", out.String())
	}
}

func fixedPick(pos ...int) func(n, k int) []int {
	return func(n, k int) []int { return append([]int(nil), pos...) }
}

func TestRunBackupVerification_Success(t *testing.T) {
	m := backupTestMnemonic()
	out := &bytes.Buffer{}
	in := strings.NewReader("able\nabsurd\n")
	if !runBackupVerification(out, in, m, fixedPick(3, 9)) {
		t.Fatal("correct answers should verify; out:", out.String())
	}
	if !strings.Contains(out.String(), "Backup verified") {
		t.Fatalf("missing confirmation in %q", out.String())
	}
}

func TestRunBackupVerification_RetryThenPass(t *testing.T) {
	m := backupTestMnemonic()
	out := &bytes.Buffer{}
	// First round wrong, retry correct (picker returns same positions both
	// calls; different answers on the two passes).
	in := strings.NewReader("wrong\nable\n")
	if !runBackupVerification(out, in, m, fixedPick(3)) {
		t.Fatal("retry with the right word should verify; out:", out.String())
	}
	if strings.Count(out.String(), "Word #3") != 2 {
		t.Fatalf("expected two rounds of prompts, got %q", out.String())
	}
}

func TestRunBackupVerification_FailsTwice(t *testing.T) {
	m := backupTestMnemonic()
	out := &bytes.Buffer{}
	in := strings.NewReader("wrong\nalsowrong\n")
	if runBackupVerification(out, in, m, fixedPick(3)) {
		t.Fatal("two failed rounds must report failure")
	}
	if !strings.Contains(out.String(), "WARNING") {
		t.Fatalf("missing failure warning in %q", out.String())
	}
}

func TestRunBackupVerification_Skip(t *testing.T) {
	m := backupTestMnemonic()
	out := &bytes.Buffer{}
	if !runBackupVerification(out, nil, m, fixedPick(1)) {
		t.Fatal("nil reader should report success (skipped)")
	}
	if !runBackupVerification(nil, strings.NewReader("x"), m, fixedPick(1)) {
		t.Fatal("nil writer should report success (skipped)")
	}
	if !runBackupVerification(out, strings.NewReader("x"), nil, fixedPick(1)) {
		t.Fatal("empty mnemonic should report success (skipped)")
	}
}
