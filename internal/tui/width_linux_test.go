// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build linux

package tui

import (
	"bytes"
	"os"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// openPTY returns a pseudo-terminal master sized to rows x cols. Testing
// against a real terminal rather than a stubbed width is the point: the
// ioctl, the struct layout, and the field offset of ws_col are exactly what
// a stub cannot check, and getting ws_col's offset wrong would silently
// report the row count as the width.
func openPTY(t *testing.T, rows, cols uint16) *os.File {
	t.Helper()
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		t.Skipf("no pseudo-terminal available in this environment: %v", err)
	}
	t.Cleanup(func() { master.Close() })
	setPTYSize(t, master, rows, cols)
	return master
}

func setPTYSize(t *testing.T, f *os.File, rows, cols uint16) {
	t.Helper()
	ws := winsize{rows: rows, cols: cols}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(),
		uintptr(syscall.TIOCSWINSZ), uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		t.Skipf("cannot set pseudo-terminal size: %v", errno)
	}
}

func TestTerminalWidth_ReadsTheRealTerminalSize(t *testing.T) {
	pty := openPTY(t, 24, 132)
	if got := terminalWidth(pty.Fd()); got != 132 {
		t.Errorf("terminalWidth = %d, want 132 (the column count, not the row count)", got)
	}
}

// TestTerminalWidth_NotATerminalReportsUnknown covers the redirected-output
// case — `otedama run > dashboard.log`. The ioctl fails with ENOTTY, and 0
// means "keep the width you have" rather than a nonsense zero-column layout.
func TestTerminalWidth_NotATerminalReportsUnknown(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "notatty")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got := terminalWidth(f.Fd()); got != 0 {
		t.Errorf("terminalWidth(regular file) = %d, want 0 (unknown)", got)
	}
}

// TestDashboard_AdoptsTerminalWidth is the end-to-end shape: construct a
// Dashboard on a real terminal and its rendered lines should span that
// terminal, not the 80-column default.
func TestDashboard_AdoptsTerminalWidth(t *testing.T) {
	pty := openPTY(t, 24, 120)
	d := NewDashboard(pty)
	if got := int(d.cols.Load()); got != 120 {
		t.Fatalf("cols = %d, want 120 adopted from the terminal", got)
	}
}

// TestDashboard_FollowsAResize pins the reason the width is polled on every
// render tick rather than read once at construction: a user who widens their
// window mid-session should see the dashboard follow.
func TestDashboard_FollowsAResize(t *testing.T) {
	pty := openPTY(t, 24, 100)
	d := NewDashboard(pty)
	if got := int(d.cols.Load()); got != 100 {
		t.Fatalf("initial cols = %d, want 100", got)
	}

	setPTYSize(t, pty, 24, 160)
	d.refreshWidth()
	if got := int(d.cols.Load()); got != 160 {
		t.Errorf("cols after resize = %d, want 160", got)
	}
}

// TestDashboard_ClampsAbsurdlyNarrowTerminal checks the floor. A 20-column
// terminal cannot show this layout whatever we do; clamping to minCols keeps
// the truncation logic in its designed range instead of feeding it widths
// the line builders were never written for.
func TestDashboard_ClampsAbsurdlyNarrowTerminal(t *testing.T) {
	pty := openPTY(t, 24, 20)
	d := NewDashboard(pty)
	if got := int(d.cols.Load()); got != minCols {
		t.Errorf("cols = %d for a 20-column terminal, want the %d floor", got, minCols)
	}
}

// TestDashboard_NarrowTerminalLinesDoNotWrap is the defect this feature
// exists to prevent. The repaint overwrites a fixed number of lines from
// cursor-home, so a line wider than the terminal wraps, consumes an extra
// screen row, and desynchronises every subsequent line. Every emitted line
// must therefore fit the terminal's real width.
func TestDashboard_NarrowTerminalLinesDoNotWrap(t *testing.T) {
	pty := openPTY(t, 24, 52)

	// Render into a buffer while taking the width from the narrow terminal,
	// so the output can be inspected without reading back from the pty.
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.widthFn = func() int { return terminalWidth(pty.Fd()) }
	d.refreshWidth()
	if got := int(d.cols.Load()); got != 52 {
		t.Fatalf("cols = %d, want 52", got)
	}

	d.render(Stats{
		HashRate:          123456789,
		PoolURL:           "stratum+v2://a-very-long-pool-hostname.example.com:34254",
		Connected:         true,
		WalletFingerprint: "bd69fda6",
		Devices:           4,
		Providers:         []ProviderStats{{Name: "Bitcoin Mining", SatsPerSecond: 0.07, Active: true}},
	})

	for i, line := range strings.Split(buf.String(), "\n") {
		// Strip the frame's cursor-home prefix and each line's trailing
		// carriage return; visibleLen counts \r as a column, and it is
		// cursor movement, not content.
		line = strings.TrimSuffix(strings.TrimPrefix(line, cursorHome), "\r")
		if n := visibleLen(line); n > 52 {
			t.Errorf("line %d is %d visible columns, wider than the 52-column terminal: %q", i, n, line)
		}
	}
}
