// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"strings"
	"testing"
)

// FuzzValidateAddress drives the payout-address validators (bech32/bech32m +
// Base58Check) with arbitrary strings. The input is operator-supplied (config
// file / CLI flag), so a panic is a startup-crash vector, and an accepted
// checksum-invalid address silently routes rewards to a dead key.
func FuzzValidateAddress(f *testing.F) {
	seeds := []string{
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",          // canonical P2PKH
		"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",          // P2SH
		"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",  // BIP-173 v0 example
		"BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",  // upper-case form
		"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty",  // invalid checksum
		"bc1qr33j0zedavp4m4l6f5e0h6a2x0e7tq2xvp6u7k8", // speculative v1 shape
		"bc1", "", "1", "3", "bc", "0", "bc1pz",
		strings.Repeat("q", 200),             // over the 90-char BIP-173 cap
		"1BoatSLRHtKNngkdXEeobR76b53LETtpyT", // valid P2PKH (well-known vanity)
		"\x00\xff\xfe",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, addr string) {
		// No panic, ever. A nil error implies checksum-verified structure.
		typ, err := ValidateAddress(addr)
		if err == nil && typ == AddressUnknown {
			t.Fatalf("ValidateAddress(%q) succeeded but returned AddressUnknown", addr)
		}
		// Exercise the format-specific paths on their own inputs so both
		// decoders see adversarial byte strings, not just routed traffic.
		_, _ = ValidateBech32Address(addr)
		_, _ = ValidateBase58Address(addr)
	})
}
