// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

package tui

import "golang.org/x/sys/windows"

// terminalWidth reads the console's visible window width via
// GetConsoleScreenBufferInfo. The Window rectangle (not Size, which is
// the scrollback buffer width) is what a repaint-style dashboard must
// fit inside. Returns 0 when the handle is not a console or the call
// fails.
func terminalWidth(fd uintptr) int {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(fd), &info); err != nil {
		return 0
	}
	return int(info.Window.Right - info.Window.Left + 1)
}
