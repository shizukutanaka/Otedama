// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build unix

package tui

import (
	"os"

	"golang.org/x/sys/unix"
)

// terminalWidth queries the kernel for the terminal's column count via
// TIOCGWINSZ on f's file descriptor. It returns 0 when f is not a
// terminal or the ioctl fails, leaving the caller's fallback in place.
func terminalWidth(f *os.File) int {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0
	}
	return int(ws.Col)
}
