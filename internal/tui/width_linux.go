// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build linux

// Package tui — width_linux.go
//
// Terminal width detection via the TIOCGWINSZ ioctl.
//
// # Why this is worth a syscall and an unsafe.Pointer
//
// The dashboard repaints by moving the cursor home and overwriting every
// line, which only works while each line fits the terminal. On a terminal
// narrower than the assumed width every line wraps, each wrap consumes an
// extra screen row, and the fixed cursor-home offsets no longer line up —
// the display degrades into overlapping fragments rather than merely looking
// cramped. Knowing the real width is what keeps the repaint correct, not
// just tidy.
//
// # Why not a dependency
//
// golang.org/x/term does exactly this, but CLAUDE.md admits a dependency
// only when the standard library cannot serve, and here it can: TIOCGWINSZ
// is two constants and a four-field struct. The cost is one unsafe.Pointer
// in one file — the only use of unsafe in the repository — which is how
// every Go ioctl wrapper, x/sys included, is written. That is a smaller and
// more inspectable surface than a new module in the dependency tree.
//
// # Why Linux only
//
// The BSD family, macOS included, uses a different TIOCGWINSZ value and
// reaches ioctl through libc trampolines rather than syscall.Syscall. Adding
// those paths without being able to run them would be guessing; other
// platforms get the stub in width_other.go, which reports "unknown" and
// leaves the dashboard on its default width — exactly the behaviour they
// have today. This mirrors the existing Linux-only scope of GPU detection
// (docs/KNOWN_LIMITATIONS.md §4).
package tui

import (
	"syscall"
	"unsafe"
)

// winsize mirrors struct winsize from <sys/ioctl.h>: four unsigned shorts,
// rows and columns first. Only ws_col is read here.
type winsize struct {
	rows    uint16
	cols    uint16
	xpixels uint16
	ypixels uint16
}

// terminalWidth returns the column count of the terminal behind fd, or 0
// when fd is not a terminal (output redirected to a file or a pipe) or the
// kernel reports no size (common under a detached service, where the
// terminal exists but has never been sized). Callers treat 0 as "unknown"
// and keep whatever width they were using.
func terminalWidth(fd uintptr) int {
	var ws winsize
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		fd,
		uintptr(syscall.TIOCGWINSZ),
		uintptr(unsafe.Pointer(&ws)),
	)
	if errno != 0 {
		return 0
	}
	return int(ws.cols)
}
