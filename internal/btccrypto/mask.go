// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package btccrypto — mask.go
//
// MaskAddress renders a payout address for logs and diagnostics without
// printing it in full, so operator output does not needlessly expose the
// complete address (a payout address is semi-sensitive: logging it whole
// lets anyone with log access correlate the operator to a public key).
// This is the single implementation of address masking — previously
// duplicated as internal/doctor's maskAddress and internal/engine's
// maskAddr with divergent thresholds and ellipsis styles (Issue #2).
package btccrypto

// MaskAddress returns a shortened form of a for display: inputs of 12
// characters or fewer are returned unchanged (too short to be an address
// at all — mainnet payouts are 26+ chars), and longer inputs are shown
// as first-6 + "…" + last-4 (e.g. "bc1qja…nwr5").
func MaskAddress(a string) string {
	if len(a) <= 12 {
		return a
	}
	return a[:6] + "…" + a[len(a)-4:]
}
