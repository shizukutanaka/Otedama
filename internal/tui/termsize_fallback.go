// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !unix && !windows

package tui

import "os"

// terminalWidth has no implementation on platforms outside unix/windows;
// the dashboard keeps its configured/default width.
func terminalWidth(_ *os.File) int { return 0 }
