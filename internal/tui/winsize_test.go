// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package tui

import (
	"bytes"
	"os"
	"testing"
)

// ============================================================================
// Terminal width detection (winsize.go)
//
// A real interactive terminal is not available under `go test`, so these
// cover the failure paths every non-terminal writer must take — and the
// dashboard's documented fallback to 80 columns.
// ============================================================================

func TestTerminalWidth_NonFileWriter(t *testing.T) {
	var buf bytes.Buffer
	if cols, ok := terminalWidth(&buf); ok || cols != 0 {
		t.Errorf("terminalWidth(bytes.Buffer) = (%d, %v), want (0, false)", cols, ok)
	}
}

func TestTerminalWidth_NilWriter(t *testing.T) {
	if cols, ok := terminalWidth(nil); ok || cols != 0 {
		t.Errorf("terminalWidth(nil) = (%d, %v), want (0, false)", cols, ok)
	}
}

func TestTerminalWidth_RegularFile(t *testing.T) {
	// A redirected file is an *os.File but not a terminal — the ioctl
	// must fail cleanly rather than report a bogus size.
	f, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	defer f.Close()
	if cols, ok := terminalWidth(f); ok || cols != 0 {
		t.Errorf("terminalWidth(regular file) = (%d, %v), want (0, false)", cols, ok)
	}
}

func TestNewDashboard_NonTerminalKeepsDefaultWidth(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	if got := d.cols.Load(); got != 80 {
		t.Errorf("cols = %d on a non-terminal writer, want the 80-column default", got)
	}
}

func TestTerminalWidth_DevNull(t *testing.T) {
	// /dev/null is a character device that is NOT a terminal — the ioctl
	// fails on it on every platform, exercising the "is a file, is a
	// chardev, but has no window size" path.
	f, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Skipf("cannot open %s: %v", os.DevNull, err)
	}
	defer f.Close()
	if cols, ok := terminalWidth(f); ok || cols != 0 {
		t.Errorf("terminalWidth(%s) = (%d, %v), want (0, false)", os.DevNull, cols, ok)
	}
}
