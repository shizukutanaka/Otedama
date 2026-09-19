// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !unix && !windows

package tui

// terminalWidth has no implementation on platforms outside unix/windows
// (plan9, js, wasip1). Returning 0 leaves the dashboard at its
// NewDashboard default width.
func terminalWidth(uintptr) int { return 0 }

// fdIsTerminal has no console API to ask on platforms outside
// unix/windows; false is the safe answer.
func fdIsTerminal(uintptr) bool { return false }
