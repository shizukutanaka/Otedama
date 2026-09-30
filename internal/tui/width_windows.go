// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

package tui

import (
	"os"

	"golang.org/x/sys/windows"
)

// terminalWidth queries the console screen buffer for its column count.
// It returns 0 when f is not a console handle or the call fails, leaving
// the caller's fallback in place.
func terminalWidth(f *os.File) int {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(f.Fd()), &info); err != nil {
		return 0
	}
	return int(info.Window.Right - info.Window.Left + 1)
}
