// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package tui — termwidth.go
//
// Real terminal-width detection, wired into engine.Run's dashboard
// construction so the TUI renders at the user's actual terminal width
// instead of the NewDashboard default of 80 columns (previously
// docs/KNOWN_LIMITATIONS.md §15).
//
// The platform-specific terminalWidth lives in termwidth_unix.go
// (TIOCGWINSZ ioctl) and termwidth_windows.go
// (GetConsoleScreenBufferInfo); both sit on golang.org/x/sys, which the
// module already carries as a dependency of x/crypto, so detection adds
// no new module to the dependency tree. Every other platform returns 0
// (termwidth_other.go) and the dashboard keeps its 80-column default.
package tui

import (
	"io"
	"os"
)

// DetectWidth returns the column count of the terminal w is connected
// to, or 0 when w is not an *os.File (a buffer in tests, a bytes sink)
// or the platform query fails (redirected output, non-terminal fd, an OS
// without a console API). Callers pass the result to SetWidth, whose own
// lower bound keeps an implausibly narrow result from shrinking the
// layout below the documented 40-column minimum.
func DetectWidth(w io.Writer) int {
	f, ok := w.(*os.File)
	if !ok {
		return 0
	}
	return terminalWidth(f.Fd())
}
