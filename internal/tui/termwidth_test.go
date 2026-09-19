// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package tui

import (
	"os"
	"testing"
)

func TestIsTerminal_RegularFileIsNotATerminal(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "not-a-tty")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	defer f.Close()

	if IsTerminal(f) {
		t.Error("IsTerminal(regular file) = true, want false")
	}
}

func TestIsTerminal_PipeIsNotATerminal(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer r.Close()
	defer w.Close()

	if IsTerminal(w) {
		t.Error("IsTerminal(pipe) = true, want false")
	}
}

func TestIsTerminal_ClosedFileReturnsFalse(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "closed")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	f.Close()

	// The ioctl on an already-closed fd fails; IsTerminal must treat that
	// as "not a terminal" rather than panicking.
	if IsTerminal(f) {
		t.Error("IsTerminal(closed file) = true, want false")
	}
}

// /dev/null carries os.ModeCharDevice — the stat heuristic used by the
// old cmd-level isTerminal misclassified it as a terminal, so redirected
// output could still spin up the dashboard. The ioctl probe is the fix:
// the kernel answers ENOTTY on /dev/null.
func TestIsTerminal_DevNullIsNotATerminal(t *testing.T) {
	f, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Skipf("no %s on this platform: %v", os.DevNull, err)
	}
	defer f.Close()

	if IsTerminal(f) {
		t.Error("IsTerminal(/dev/null) = true, want false (char device is not a terminal)")
	}
}

func TestDetectWidth_NonFileReturnsZero(t *testing.T) {
	if got := DetectWidth(nil); got != 0 {
		t.Errorf("DetectWidth(nil) = %d, want 0", got)
	}
}

func TestDetectWidth_RegularFileReturnsZero(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "not-a-tty")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	defer f.Close()

	if got := DetectWidth(f); got != 0 {
		t.Errorf("DetectWidth(regular file) = %d, want 0", got)
	}
}
