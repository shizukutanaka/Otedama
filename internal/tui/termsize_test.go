// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package tui

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TerminalWidth must return 0 for writers that are not files and for
// files that are not terminals — those cases keep the dashboard at its
// configured/default width.
func TestTerminalWidth_NonFileWriter(t *testing.T) {
	if got := TerminalWidth(&bytes.Buffer{}); got != 0 {
		t.Errorf("TerminalWidth(bytes.Buffer) = %d, want 0", got)
	}
	if got := TerminalWidth(os.Stdout); got < 0 {
		t.Errorf("TerminalWidth(os.Stdout) = %d, want >= 0", got)
	}
}

// A regular file is not a terminal: detection must fail cleanly rather
// than accept a garbage "width" or panic.
func TestTerminalWidth_RegularFile(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "out.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got := TerminalWidth(f); got != 0 {
		t.Errorf("TerminalWidth(regular file) = %d, want 0", got)
	}
}

// NewDashboard on a non-terminal writer keeps the 80-column default and
// never records an fd (so refreshWidth stays a no-op for it).
func TestNewDashboard_NonTerminalKeepsDefault(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	if d.cols != 80 {
		t.Errorf("cols = %d, want default 80", d.cols)
	}
	if d.fd != nil {
		t.Error("fd set for non-file writer; refreshWidth would not be a no-op")
	}
	d.refreshWidth() // must not panic or change cols
	if d.cols != 80 {
		t.Errorf("cols = %d after refreshWidth, want 80", d.cols)
	}
}

// A dashboard backed by a regular file stores the fd but keeps the
// default width; refreshWidth leaves it alone since a regular file is
// not a terminal.
func TestNewDashboard_RegularFileKeepsDefault(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "dash.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	d := NewDashboard(f)
	if d.cols != 80 {
		t.Errorf("cols = %d, want default 80", d.cols)
	}
	if d.fd == nil {
		t.Fatal("fd not recorded for *os.File writer")
	}
	d.refreshWidth()
	if d.cols != 80 {
		t.Errorf("cols = %d after refreshWidth, want 80", d.cols)
	}
}

// SetWidth is a manual override: after it, refreshWidth must not
// overwrite the pinned value even though auto-detection might find a
// different real width.
func TestDashboard_SetWidth_DisablesAutoDetect(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "dash.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	d := NewDashboard(f)
	d.SetWidth(120)
	d.refreshWidth()
	if d.cols != 120 {
		t.Errorf("cols = %d after refreshWidth, want pinned 120", d.cols)
	}
}
