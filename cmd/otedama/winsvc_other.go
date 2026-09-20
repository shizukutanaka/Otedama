// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//go:build !windows

package main

import "io"

// maybeRunAsWindowsService is the non-Windows stub: the Service Control
// Manager only exists on Windows, so this never intercepts.
func maybeRunAsWindowsService(_ []string, _, _ io.Writer) (int, bool) {
	return 0, false
}
