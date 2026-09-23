// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build aix || illumos || linux || solaris || zos

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// disableEcho clears the ECHO flag on f's controlling terminal and
// returns a function that restores the original termios. This uses the
// System V-style TCGETS/TCSETS ioctls (Linux, Solaris/illumos, AIX, z/OS);
// the BSDs use the TIOCGETA/TIOCSETA pair in termecho_tiocgeta.go
// instead — the constant names differ per platform, hence the split.
//
// golang.org/x/sys is already an indirect dependency (via x/crypto), so
// this adds no new module — ADR-003's zero-dependency stance is preserved.
func disableEcho(f *os.File) (restore func(), err error) {
	fd := int(f.Fd())
	termios, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return nil, err
	}
	orig := *termios
	termios.Lflag &^= unix.ECHO
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, termios); err != nil {
		return nil, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TCSETS, &orig) }, nil
}
