// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build windows

package engine

import (
	"os"
	"syscall"
	"unsafe"
)

// stdinIsTerminal reports whether stdin is an interactive console via
// GetConsoleMode — os.Stat's ModeCharDevice cannot distinguish a console
// from /dev/null or a pipe, so the backup-verification prompt gates on
// this (golang.org/x/term.IsTerminal's mechanism, with no dependency).
func stdinIsTerminal() bool {
	var mode uint32
	r, _, _ := syscall.NewLazyDLL("kernel32.dll").
		NewProc("GetConsoleMode").
		Call(uintptr(syscall.Handle(os.Stdin.Fd())), uintptr(unsafe.Pointer(&mode)))
	return r != 0
}
