// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build !windows

package engine

import (
	"os"
	"syscall"
	"unsafe"
)

// stdinIsTerminal reports whether stdin is an interactive terminal via
// ioctl(TIOCGWINSZ) — os.Stat's ModeCharDevice cannot distinguish a TTY
// from /dev/null or a detached pts slave, so the backup-verification
// prompt gates on this (golang.org/x/term.IsTerminal's mechanism, with
// no dependency).
func stdinIsTerminal() bool {
	var ws struct {
		row, col, xpixel, ypixel uint16
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, os.Stdin.Fd(),
		syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&ws)))
	return errno == 0
}
