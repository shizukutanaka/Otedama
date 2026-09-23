// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

// Terminal width detection for the dashboard.
//
// Previously the dashboard rendered at a hard-coded 80 columns no matter
// the real terminal size (docs/KNOWN_LIMITATIONS.md §15): on a wide
// terminal the right half of the screen stayed empty, and under a narrow
// one lines wrapped destructively. NewDashboard now detects the width of
// the writer it was given and render() re-detects on every tick — one
// ioctl per ~1s render, trivially cheap — so a terminal resize mid-run
// (tmux pane split, SSH window drag) is picked up without a restart.
// SetWidth remains a manual override for callers that know better; once
// invoked it wins over auto-detection.
//
// terminalWidth is implemented per-platform:
//   - termsize_unix.go:    TIOCGWINSZ via golang.org/x/sys/unix
//   - termsize_windows.go: GetConsoleScreenBufferInfo via x/sys/windows
//   - termsize_fallback.go: anything else returns 0 (no detection)
//
// A writer that is not an *os.File, a file without a terminal (pipe,
// redirect, `| tee`), or a platform without an implementation all yield
// 0 — the dashboard keeps whatever width it already has (the 80-column
// default, or the last successfully detected value).

package tui

import (
	"io"
	"os"
)

// minCols is the narrowest width the dashboard renders correctly; a
// detection below it is treated as "no real width information" rather
// than a real size (line layout is already defined for ≥40).
const minCols = 40

// TerminalWidth reports the column width of w's terminal, or 0 when w is
// not a terminal (or detection is unsupported on this platform). Exported
// so non-dashboard callers (a future `--width` flag, doctor) can ask the
// same question without going through Dashboard.
func TerminalWidth(w io.Writer) int {
	f, ok := w.(*os.File)
	if !ok {
		return 0
	}
	return terminalWidth(f)
}
