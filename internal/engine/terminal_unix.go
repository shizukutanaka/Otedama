// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build !windows

package engine

import (
	"os"
	"syscall"
	"unsafe"
)

// ttySize returns the terminal's column/row count for fd via
// ioctl(TIOCGWINSZ), reporting ok=false when fd is not a TTY (pipe,
// file, /dev/null, detached pts slave) — the check os.Stat's
// ModeCharDevice cannot do. Same mechanism as golang.org/x/term's
// GetSize/IsTerminal, implemented on stdlib syscall with no dependency.
func ttySize(fd uintptr) (cols, rows int, ok bool) {
	var ws struct {
		row, col, xpixel, ypixel uint16
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd,
		syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return 0, 0, false
	}
	return int(ws.col), int(ws.row), true
}

// stdinIsTerminal reports whether stdin is an interactive terminal, so
// the backup-verification prompt never blocks non-TTY launches.
func stdinIsTerminal() bool {
	_, _, ok := ttySize(os.Stdin.Fd())
	return ok
}

// outputWidth returns the terminal column count when out is a *os.File
// attached to a terminal, and (0, false) otherwise — files, buffers, and
// pipes get the dashboard's default width.
func outputWidth(out any) (int, bool) {
	f, ok := out.(*os.File)
	if !ok {
		return 0, false
	}
	cols, _, ok := ttySize(f.Fd())
	return cols, ok
}
