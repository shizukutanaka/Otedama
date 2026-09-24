// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build windows

package engine

import (
	"os"
	"syscall"
	"unsafe"
)

// ttySize returns the console window's column/row count for fd via
// kernel32 GetConsoleScreenBufferInfo, reporting ok=false when fd is not
// a console (pipe, file, NUL) — the check os.Stat's ModeCharDevice cannot
// do. Same mechanism as golang.org/x/term's GetSize/IsTerminal,
// implemented on stdlib syscall with no dependency.
func ttySize(fd uintptr) (cols, rows int, ok bool) {
	var info struct {
		size      [2]uint16
		cursorPos [2]uint16
		attrs     uint16
		window    struct{ left, top, right, bottom uint16 }
		maxSize   [2]uint16
	}
	r, _, _ := syscall.NewLazyDLL("kernel32.dll").
		NewProc("GetConsoleScreenBufferInfo").
		Call(fd, uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		return 0, 0, false
	}
	return int(info.window.right) - int(info.window.left) + 1,
		int(info.window.bottom) - int(info.window.top) + 1, true
}

// stdinIsTerminal reports whether stdin is an interactive console, so
// the backup-verification prompt never blocks non-TTY launches.
func stdinIsTerminal() bool {
	_, _, ok := ttySize(os.Stdin.Fd())
	return ok
}

// outputWidth returns the console column count when out is a *os.File
// attached to a console, and (0, false) otherwise — files, buffers, and
// pipes get the dashboard's default width.
func outputWidth(out any) (int, bool) {
	f, ok := out.(*os.File)
	if !ok {
		return 0, false
	}
	cols, _, ok := ttySize(f.Fd())
	return cols, ok
}
