// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !unix && !windows

package tui

import "os"

// terminalWidth has no implementation on this platform; it always
// returns 0 so callers fall back to the compiled-in default width.
func terminalWidth(_ *os.File) int {
	return 0
}
