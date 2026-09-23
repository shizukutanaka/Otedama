// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

package tui

import "golang.org/x/sys/windows"

// ioctlWinsize reads the console's screen-buffer window width via
// GetConsoleScreenBufferInfo — the Windows analogue of TIOCGWINSZ.
// Fails (ok=false) when the handle isn't a console (redirected output).
func ioctlWinsize(fd uintptr) (int, bool) {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(fd), &info); err != nil {
		return 0, false
	}
	// Window is an inclusive SMALL_RECT of cell coordinates.
	cols := int(info.Window.Right) - int(info.Window.Left) + 1
	return cols, cols > 0
}
