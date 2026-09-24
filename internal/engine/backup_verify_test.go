// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
package engine

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/lightning"
)

func testMnemonic() lightning.Mnemonic {
	return lightning.Mnemonic{
		"alpha", "bravo", "charlie", "delta", "echo",
		"foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima",
	}
}

// verifyWordPositions — the pure half of the backup-confirmation flow:
// every prompted answer must match the mnemonic word at that position
// (trimmed, case-insensitive).
func TestVerifyWordPositions_AllCorrect(t *testing.T) {
	m := testMnemonic()
	var out bytes.Buffer
	in := strings.NewReader("charlie\n  hotel \nALPHA\n") // trim + case fold
	if !verifyWordPositions(in, &out, m, []int{2, 7, 0}) {
		t.Error("all-correct answers rejected")
	}
	if !strings.Contains(out.String(), "word #3 of 12") || !strings.Contains(out.String(), "word #8 of 12") {
		t.Errorf("prompt labels wrong: %q", out.String())
	}
}

func TestVerifyWordPositions_WrongWord(t *testing.T) {
	m := testMnemonic()
	var out bytes.Buffer
	in := strings.NewReader("charlie\nwrongword\nalpha\n")
	if verifyWordPositions(in, &out, m, []int{2, 7, 0}) {
		t.Error("wrong answer accepted")
	}
}

func TestVerifyWordPositions_EOF(t *testing.T) {
	m := testMnemonic()
	var out bytes.Buffer
	in := strings.NewReader("charlie\n") // 3 asked, 1 given
	if verifyWordPositions(in, &out, m, []int{2, 7, 0}) {
		t.Error("truncated input accepted")
	}
}

// pickWordPositions — k distinct positions in [0,n), sorted, driven by the
// caller's rand source so tests stay deterministic.
func TestPickWordPositions_DistinctSorted(t *testing.T) {
	got, err := pickWordPositions(24, 3, bytes.NewReader([]byte{0, 200, 100, 50, 25}))
	if err != nil {
		t.Fatalf("pickWordPositions: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	seen := map[int]bool{}
	for i, p := range got {
		if p < 0 || p >= 24 {
			t.Errorf("position %d out of range", p)
		}
		if seen[p] {
			t.Errorf("duplicate position %d", p)
		}
		seen[p] = true
		if i > 0 && got[i-1] >= p {
			t.Errorf("not sorted: %v", got)
		}
	}
}

func TestPickWordPositions_ExhaustsRand(t *testing.T) {
	if _, err := pickWordPositions(24, 3, bytes.NewReader([]byte{1})); err == nil {
		t.Error("short rand source should error")
	}
}

func TestPickWordPositions_InvalidArgs(t *testing.T) {
	for _, tc := range [][2]int{{0, 3}, {24, 0}, {2, 5}} {
		if _, err := pickWordPositions(tc[0], tc[1], bytes.NewReader(nil)); err == nil {
			t.Errorf("n=%d k=%d should error", tc[0], tc[1])
		}
	}
}

// confirmSeedBackup — the TTY gate: with no interactive terminal the
// function is a silent no-op (service/daemon launches never block).
func TestConfirmSeedBackup_NonTTY(t *testing.T) {
	var out bytes.Buffer
	var logs []string
	// os.Stdin is a pipe in `go test` — not a character device — so the
	// function must return without touching out or log.
	confirmSeedBackup(testMnemonic(), &out, func(l, m string) { logs = append(logs, l+": "+m) })
	if out.Len() != 0 {
		t.Errorf("non-TTY run wrote %q, want nothing", out.String())
	}
	if len(logs) != 0 {
		t.Errorf("non-TTY run logged %v, want nothing", logs)
	}
}

// outputWidth — the dashboard's TTY gate: only a real *os.File terminal
// returns a width; everything else keeps the 80-column default.
func TestOutputWidth_NonFileAndNonTTY(t *testing.T) {
	var buf bytes.Buffer
	if w, ok := outputWidth(&buf); ok {
		t.Errorf("buffer writer got width %d, want ok=false", w)
	}
	if w, ok := outputWidth(nil); ok {
		t.Errorf("nil writer got width %d, want ok=false", w)
	}
	// A real file is not a terminal: os.CreateTemp gives an *os.File that
	// must not be mistaken for a TTY.
	f, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if w, ok := outputWidth(f); ok {
		t.Errorf("plain file got width %d, want ok=false", w)
	}
}
