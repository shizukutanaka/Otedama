// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// disableEcho clears ENABLE_ECHO_INPUT on the console behind f and
// returns a function that restores the original console mode.
//
// golang.org/x/sys is already an indirect dependency (via x/crypto), so
// this adds no new module — ADR-003's zero-dependency stance is preserved.
func disableEcho(f *os.File) (restore func(), err error) {
	h := windows.Handle(f.Fd())
	var mode uint32
	if err := windows.GetConsoleMode(h, &mode); err != nil {
		return nil, err
	}
	if err := windows.SetConsoleMode(h, mode&^uint32(windows.ENABLE_ECHO_INPUT)); err != nil {
		return nil, err
	}
	return func() { _ = windows.SetConsoleMode(h, mode) }, nil
}
