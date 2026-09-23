// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build darwin || dragonfly || freebsd || netbsd || openbsd

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// disableEcho clears the ECHO flag on f's controlling terminal and
// returns a function that restores the original termios. This uses the
// BSD-style TIOCGETA/TIOCSETA ioctls (macOS and the BSDs); the
// TCGETS/TCSETS variant for Linux/Solaris/AIX is in termecho_tcgets.go.
//
// golang.org/x/sys is already an indirect dependency (via x/crypto), so
// this adds no new module — ADR-003's zero-dependency stance is preserved.
func disableEcho(f *os.File) (restore func(), err error) {
	fd := int(f.Fd())
	termios, err := unix.IoctlGetTermios(fd, unix.TIOCGETA)
	if err != nil {
		return nil, err
	}
	orig := *termios
	termios.Lflag &^= unix.ECHO
	if err := unix.IoctlSetTermios(fd, unix.TIOCSETA, termios); err != nil {
		return nil, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TIOCSETA, &orig) }, nil
}
