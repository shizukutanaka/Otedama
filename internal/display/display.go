// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package display holds tiny shared rendering helpers for values that
// appear in both command output and logs. It exists so a value renders
// identically wherever it is shown; helpers here must stay free of any
// domain behavior beyond formatting.
package display

import "strings"

// MaskAddress renders a Bitcoin address for display and logs without
// printing it in full: the first 6 and last 4 characters are kept and
// the middle is replaced by an ellipsis of middle dots, e.g.
// "bc1qar0···5mdq". Strings of 10 characters or fewer are returned
// unchanged (masking them would hide most of the value).
//
// This is the single canonical implementation. Doctor and engine each
// had their own copy with slightly different thresholds and ellipsis
// characters, so the same address could render differently in doctor
// output versus engine logs (issue #2).
func MaskAddress(s string) string {
	if len(s) <= 10 {
		return s
	}
	return s[:6] + strings.Repeat("·", 3) + s[len(s)-4:]
}
