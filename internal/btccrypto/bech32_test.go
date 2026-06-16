// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"errors"
	"strings"
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

func TestValidateBech32Address_InvalidWitnessVersionRejected(t *testing.T) {
	// The first data character encodes the witness version. '3' has charset
	// index 17, i.e. witness version 17 — above the valid maximum of 16. This
	// is rejected before the checksum is even consulted, so any padding of
	// charset chars after it suffices to reach the version check.
	addr := "bc13" + makeRepeat('q', 8) // version 17, long enough to pass length gate
	if _, err := ValidateBech32Address(addr); err == nil {
		t.Errorf("witness version 17 accepted: %q", addr)
	}
}

func TestValidateBech32Address_WrongHRPRejected(t *testing.T) {
	// A second '1' makes the human-readable part "bc1" (the separator is the
	// LAST '1'), which is not the mainnet "bc". Must be rejected. '1' is not in
	// the bech32 charset, so this is the only way to shift the separator.
	addr := "bc11" + makeRepeat('q', 8)
	if _, err := ValidateBech32Address(addr); err == nil {
		t.Errorf("non-'bc' HRP accepted: %q", addr)
	}
}

func TestConvertBits_RejectsOutOfRangeValue(t *testing.T) {
	// A 5-bit group cannot hold the value 32 (>= 1<<5); convertBits must reject
	// it rather than silently truncate.
	if _, err := convertBits([]int{32}, 5, 8, false); err == nil {
		t.Error("convertBits accepted an out-of-range 5-bit value (32)")
	}
}

func TestConvertBits_RejectsInvalidPadding(t *testing.T) {
	// With pad=false, leftover non-zero bits are an invalid encoding (BIP-173
	// decoding rule). A single 5-bit group of all ones (0x1f) leaves 5 non-zero
	// bits that cannot form a full 8-bit byte, so it must be rejected.
	if _, err := convertBits([]int{0x1f}, 5, 8, false); err == nil {
		t.Error("convertBits accepted invalid non-zero padding")
	}
}

func TestConvertBits_PadRoundTrip(t *testing.T) {
	// With pad=true the trailing bits are zero-padded into a final group rather
	// than rejected; 8→5 then 5→8 with padding round-trips the original bytes.
	in := []int{0xff, 0x00, 0xab}
	five, err := convertBits(in, 8, 5, true)
	if err != nil {
		t.Fatalf("8->5 convertBits: %v", err)
	}
	back, err := convertBits(five, 5, 8, true)
	if err != nil {
		t.Fatalf("5->8 convertBits: %v", err)
	}
	// Round-trip restores the original bytes (a trailing zero pad byte may be
	// appended, so compare the meaningful prefix).
	if len(back) < len(in) {
		t.Fatalf("round-trip lost data: got %v, want prefix %v", back, in)
	}
	for i := range in {
		if back[i] != in[i] {
			t.Errorf("round-trip byte %d = %d, want %d", i, back[i], in[i])
		}
	}
}

// ============================================================================
// testEncodeBech32 — white-box helper that constructs a syntactically valid
// mainnet bech32/bech32m address from a witness version and program, using the
// package-internal polymod and charset functions. This lets tests reach
// branches inside ValidateBech32Address that are guarded by a checksum check
// and therefore unreachable from random/typed input strings.
// ============================================================================

func testEncodeBech32(t *testing.T, version int, program []byte) string {
	t.Helper()
	hrp := "bc"
	// Convert program bytes (8-bit) to 5-bit groups with padding.
	in8 := make([]int, len(program))
	for i, b := range program {
		in8[i] = int(b)
	}
	fiveBit, err := convertBits(in8, 8, 5, true)
	if err != nil {
		t.Fatalf("testEncodeBech32: convertBits 8→5: %v", err)
	}

	// Payload: version byte followed by 5-bit groups.
	payload := append([]int{version}, fiveBit...)

	// Compute checksum: version 0 uses bech32Const, version 1+ uses bech32mConst.
	wantConst := bech32Const
	if version != 0 {
		wantConst = bech32mConst
	}
	values := append(bech32HrpExpand(hrp), payload...)
	values = append(values, 0, 0, 0, 0, 0, 0)
	poly := bech32Polymod(values) ^ wantConst
	for i := 0; i < 6; i++ {
		payload = append(payload, (poly>>(5*(5-i)))&0x1f)
	}

	// Encode as bech32 characters.
	var sb strings.Builder
	sb.WriteString(hrp + "1") // separator is '1'
	for _, v := range payload {
		sb.WriteByte(bech32Charset[v])
	}
	return sb.String()
}

// ============================================================================
// ValidateBech32Address — edge cases for the version-specific dispatch (session 165)
// ============================================================================

func TestValidateBech32Address_V0With21ByteProgram(t *testing.T) {
	// v0 witness programs must be exactly 20 (P2WPKH) or 32 (P2WSH) bytes.
	// A 21-byte program with a valid checksum must be rejected.
	addr := testEncodeBech32(t, 0, make([]byte, 21))
	_, err := ValidateBech32Address(addr)
	if err == nil {
		t.Errorf("v0 address with 21-byte program should be rejected: %q", addr)
	}
}

func TestValidateBech32Address_V1With31ByteProgram(t *testing.T) {
	// v1 (Taproot/P2TR) programs must be exactly 32 bytes. 31 bytes is invalid.
	addr := testEncodeBech32(t, 1, make([]byte, 31))
	_, err := ValidateBech32Address(addr)
	if err == nil {
		t.Errorf("v1 address with 31-byte program should be rejected: %q", addr)
	}
}

func TestValidateBech32Address_FutureWitnessVersion(t *testing.T) {
	// Witness versions 2-16 are "future" versions; bech32m checksum passes but
	// Otedama rejects them as unsupported (we only classify v0 and v1).
	addr := testEncodeBech32(t, 2, make([]byte, 32))
	_, err := ValidateBech32Address(addr)
	if err == nil {
		t.Errorf("witness version 2 (future) should be rejected: %q", addr)
	}
}
