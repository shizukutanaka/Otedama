// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build unix

package tui

import "golang.org/x/sys/unix"

// terminalWidth queries the kernel for the terminal's window size via
// the TIOCGWINSZ ioctl. It returns 0 when the fd is not a terminal
// (ENOTTY) or the ioctl fails for any other reason — the caller's
// SetWidth lower bound then keeps the default width.
func terminalWidth(fd uintptr) int {
	ws, err := unix.IoctlGetWinsize(int(fd), unix.TIOCGWINSZ)
	if err != nil || ws == nil {
		return 0
	}
	return int(ws.Col)
}

// fdIsTerminal reuses the TIOCGWINSZ probe (the one tty ioctl defined
// for every unix GOOS — TCGETS is Linux-only and TIOCGETA is
// Darwin-only): it succeeds on genuine terminals and ptys regardless of
// the reported size, while /dev/null, pipes and regular files all fail
// with ENOTTY despite carrying the os.ModeCharDevice stat bit.
func fdIsTerminal(fd uintptr) bool {
	_, err := unix.IoctlGetWinsize(int(fd), unix.TIOCGWINSZ)
	return err == nil
}
