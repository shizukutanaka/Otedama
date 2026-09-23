// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

package tui

import (
	"os"

	"golang.org/x/sys/windows"
)

// terminalWidth returns the console window column count via
// GetConsoleScreenBufferInfo, or 0 when f has no console (redirected
// output, mintty pipe) — the call fails there just like TIOCGWINSZ does
// on Unix.
func terminalWidth(f *os.File) int {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(f.Fd()), &info); err != nil {
		return 0
	}
	return int(info.Window.Right - info.Window.Left + 1)
}
