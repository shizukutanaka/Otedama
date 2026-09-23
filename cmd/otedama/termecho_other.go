// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !aix && !darwin && !dragonfly && !freebsd && !illumos && !linux && !netbsd && !openbsd && !solaris && !windows && !zos

package main

import (
	"errors"
	"os"
)

// disableEcho is the catch-all for platforms with no implemented echo
// control (plan9, js, wasip1, hurd, ...). The caller warns and proceeds
// with echo enabled rather than failing.
func disableEcho(_ *os.File) (func(), error) {
	return nil, errors.New("unsupported platform")
}
