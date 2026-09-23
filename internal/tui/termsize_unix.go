// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build unix

package tui

import (
	"os"

	"golang.org/x/sys/unix"
)

// terminalWidth returns the terminal column count via TIOCGWINSZ, or 0
// when f is not a terminal (the ioctl fails with ENOTTY on pipes,
// redirects, and regular files — the same check tcgetattr-based tools
// perform).
func terminalWidth(f *os.File) int {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0
	}
	return int(ws.Col)
}
