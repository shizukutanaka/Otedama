// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build aix || darwin || dragonfly || freebsd || illumos || linux || netbsd || openbsd || solaris || zos

package tui

import "golang.org/x/sys/unix"

// ioctlWinsize queries the kernel for the terminal's column count via
// the TIOCGWINSZ ioctl — the standard mechanism on every Unix-like Go
// supports. Any ioctl failure (not a tty, redirected fd) yields ok=false.
func ioctlWinsize(fd uintptr) (int, bool) {
	ws, err := unix.IoctlGetWinsize(int(fd), unix.TIOCGWINSZ)
	if err != nil || ws == nil {
		return 0, false
	}
	cols := int(ws.Col)
	return cols, cols > 0
}
