// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

//go:build !linux

package tui

// terminalWidth reports "unknown" on every platform but Linux, so the
// dashboard keeps its default width there. See width_linux.go for why the
// detection is not written blind for platforms it cannot be run on.
func terminalWidth(_ uintptr) int { return 0 }
