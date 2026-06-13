// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"errors"
	"testing"
)

func TestValidateBech32Address_ValidVectors(t *testing.T) {
	// Official BIP-173 / BIP-350 mainnet vectors plus the repo's standard
	// fixtures. That a v0 (bech32) and a v1/Taproot (bech32m) address both
	// validate proves the version-dependent checksum-constant selection: a
	// hardcoded constant would reject one of the two.
	tests := []struct {
		addr string
		want AddressType
	}{
		{"BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", AddressP2WPKH}, // uppercase, BIP-173
		{"bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", AddressP2WSH},
		{"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", AddressP2TR}, // bech32m
		{"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", AddressP2WPKH},
		{"bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5", AddressP2WPKH},
	}
	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			got, err := ValidateBech32Address(tt.addr)
			if err != nil {
				t.Fatalf("ValidateBech32Address(%q) returned error: %v", tt.addr, err)
			}
			if got != tt.want {
				t.Errorf("type = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestValidateBech32Address_TypoFailsChecksum(t *testing.T) {
	// Flipping a single character of a valid address keeps every character
	// inside the bech32 charset but breaks the checksum — exactly the typo a
	// prefix-and-length check cannot catch.
	const valid = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	const typo = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr" // last q -> r
	if _, err := ValidateBech32Address(valid); err != nil {
		t.Fatalf("control address should be valid: %v", err)
	}
	if _, err := ValidateBech32Address(typo); err == nil {
		t.Error("single-character typo accepted; checksum not verified")
	}
}

func TestValidateBech32Address_MixedCaseRejected(t *testing.T) {
	// BIP-173 forbids mixed case.
	mixed := "bc1Qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	if _, err := ValidateBech32Address(mixed); err == nil {
		t.Error("mixed-case address accepted; BIP-173 requires uniform case")
	}
}

func TestValidateBech32Address_InvalidCharRejected(t *testing.T) {
	// 'b' is deliberately excluded from the bech32 charset.
	bad := "bc1qbr0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	if _, err := ValidateBech32Address(bad); err == nil {
		t.Error("address with out-of-charset character accepted")
	}
}

func TestValidateBech32Address_TooLongRejected(t *testing.T) {
	long := "bc1q" + makeRepeat('q', 100)
	if _, err := ValidateBech32Address(long); err == nil {
		t.Error("over-length (>90) address accepted")
	}
}

func TestValidateBech32Address_LegacyReturnsErrNotBech32(t *testing.T) {
	for _, a := range []string{
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // P2PKH
		"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // P2SH
		"",
		"not-an-address",
	} {
		_, err := ValidateBech32Address(a)
		if !errors.Is(err, ErrNotBech32) {
			t.Errorf("ValidateBech32Address(%q) error = %v, want ErrNotBech32", a, err)
		}
	}
}

func TestValidateBech32Address_NoSeparatorOrShortRejected(t *testing.T) {
	for _, a := range []string{
		"bc1",   // separator present but no data
		"bc1q",  // data part too short
		"bc1qq", // still too short for version+program+checksum
	} {
		if _, err := ValidateBech32Address(a); err == nil {
			t.Errorf("malformed %q accepted", a)
		}
	}
}

func makeRepeat(c byte, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = c
	}
	return string(b)
}
