// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !aix && !darwin && !dragonfly && !freebsd && !illumos && !linux && !netbsd && !openbsd && !solaris && !windows && !zos

package tui

// ioctlWinsize is the no-op stub for platforms without an implemented
// size query (plan9, js, wasip1, hurd, ...). The dashboard keeps its
// 80-column default there — the same behaviour as before detection was
// wired in.
func ioctlWinsize(uintptr) (int, bool) { return 0, false }
