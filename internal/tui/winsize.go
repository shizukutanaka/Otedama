// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Real terminal-width detection for the dashboard. The platform call
// lives in winsize_unix.go (TIOCGWINSZ), winsize_windows.go
// (GetConsoleScreenBufferInfo), or winsize_other.go (no-op stub).
package tui

import (
	"io"
	"os"
)

// terminalWidth reports the column width of the terminal backing w.
// Returns ok=false when w is not backed by a real terminal — a pipe, a
// redirected file, a bytes.Buffer in tests, or any non-*os.File writer —
// or when the platform cannot report a size. Callers keep the
// 80-column default in that case.
//
// Implementation note (KNOWN_LIMITATIONS §15): this deliberately uses
// golang.org/x/sys, which is already an *indirect* dependency via
// golang.org/x/crypto — so real width detection lands with no new module
// dependency, preserving ADR-003's zero-dependency stance. The rejected
// alternative was golang.org/x/term, a new direct dependency.
func terminalWidth(w io.Writer) (cols int, ok bool) {
	f, isFile := w.(*os.File)
	if !isFile {
		return 0, false
	}
	return ioctlWinsize(f.Fd())
}
