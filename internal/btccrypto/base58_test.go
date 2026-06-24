// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"crypto/sha256"
	"errors"
	"math/big"
	"testing"
)

func TestValidateBase58Address_ValidVectors(t *testing.T) {
	tests := []struct {
		addr string
		want AddressType
	}{
		{"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", AddressP2PKH}, // genesis coinbase address
		{"12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX", AddressP2PKH},
		{"1BoatSLRHtKNngkdXEeobR76b53LETtpyT", AddressP2PKH},
		{"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", AddressP2SH},
	}
	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			got, err := ValidateBase58Address(tt.addr)
			if err != nil {
				t.Fatalf("ValidateBase58Address(%q) error: %v", tt.addr, err)
			}
			if got != tt.want {
				t.Errorf("type = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestValidateBase58Address_TypoFailsChecksum(t *testing.T) {
	const valid = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
	const typo = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb" // last a -> b (in-alphabet)
	if _, err := ValidateBase58Address(valid); err != nil {
		t.Fatalf("control address should be valid: %v", err)
	}
	if _, err := ValidateBase58Address(typo); err == nil {
		t.Error("single-character base58 typo accepted; checksum not verified")
	}
}

func TestValidateBase58Address_InvalidCharRejected(t *testing.T) {
	// '0' is excluded from the base58 alphabet.
	if _, err := ValidateBase58Address("10A1zP1eP5QGefi2DMPTfTL5SLmv7Divf"); err == nil {
		t.Error("address with out-of-alphabet character accepted")
	}
}

func TestValidateBase58Address_WrongLengthRejected(t *testing.T) {
	// Valid base58 chars but far too few to be a 25-byte address.
	if _, err := ValidateBase58Address("123456789"); err == nil {
		t.Error("too-short base58 string accepted")
	}
}

func TestValidateBase58Address_NotBase58ReturnsSentinel(t *testing.T) {
	for _, a := range []string{
		"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", // bech32
		"",
		"xyz",
	} {
		_, err := ValidateBase58Address(a)
		if !errors.Is(err, ErrNotBase58) {
			t.Errorf("ValidateBase58Address(%q) error = %v, want ErrNotBase58", a, err)
		}
	}
}

// testBase58Encode encodes raw bytes as a base58 string (Bitcoin alphabet).
// Used only for constructing test vectors.
func testBase58Encode(b []byte) string {
	n := new(big.Int).SetBytes(b)
	zero := new(big.Int)
	mod := new(big.Int)
	var result []byte
	for n.Cmp(zero) > 0 {
		n.DivMod(n, big.NewInt(58), mod)
		result = append(result, base58Alphabet[mod.Int64()])
	}
	// Reverse.
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	// Prepend '1' for each leading zero byte.
	var leading []byte
	for _, c := range b {
		if c != 0 {
			break
		}
		leading = append(leading, '1')
	}
	return string(leading) + string(result)
}

// testBase58Address constructs a valid-checksum base58 address from a version
// byte and a 20-byte hash160. The checksum is computed via double-SHA256 per
// the Base58Check specification, so the resulting address passes the decode
// and checksum steps of ValidateBase58Address.
func testBase58Address(t *testing.T, version byte, hash160 []byte) string {
	t.Helper()
	if len(hash160) != 20 {
		t.Fatalf("testBase58Address: hash160 must be 20 bytes, got %d", len(hash160))
	}
	payload := append([]byte{version}, hash160...)
	h1 := sha256.Sum256(payload)
	h2 := sha256.Sum256(h1[:])
	raw := append(payload, h2[:4]...)
	return testBase58Encode(raw)
}

func TestValidateBase58Address_UnsupportedVersionByteReturnsError(t *testing.T) {
	// A valid-checksum address whose version byte is not 0x00 (P2PKH) or
	// 0x05 (P2SH) should be rejected with an "unsupported version byte" error.
	// Version 0x06 produces a '3' prefix (passes the prefix guard) but is not
	// a mainnet-assigned version byte — it hits the default case in the switch.
	addr := testBase58Address(t, 0x06, make([]byte, 20))
	_, err := ValidateBase58Address(addr)
	if err == nil {
		t.Errorf("version byte 0x06 should be rejected, got nil error (addr=%q)", addr)
	}
}

func TestValidateAddress_DispatchesByFormat(t *testing.T) {
	tests := []struct {
		addr    string
		want    AddressType
		wantErr bool
	}{
		{"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", AddressP2WPKH, false},
		{"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", AddressP2TR, false},
		{"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", AddressP2PKH, false},
		{"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", AddressP2SH, false},
		{"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr", AddressUnknown, true}, // bech32 typo
		{"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", AddressUnknown, true},         // base58 typo
		{"garbage", AddressUnknown, true},
	}
	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			got, err := ValidateAddress(tt.addr)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateAddress(%q) err=%v, wantErr=%v", tt.addr, err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("type = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestValidateAddress_UnrecognisedFormatIsSentinel(t *testing.T) {
	// An address that is neither bech32 nor base58 must return the
	// ErrUnrecognisedAddress sentinel, checkable via errors.Is, so callers can
	// distinguish "not a recognisable format" from a checksum failure (a typo
	// in an otherwise well-formed address) and give format-specific guidance.
	cases := []string{
		"garbage",                              // not a Bitcoin address at all
		"xyz123notanaddress",                   // wrong prefix
		"tb1qw508d6qejxtdg4y5r3zarvary0c5xw7k", // testnet bech32 (hrp "tb", rejected)
	}
	for _, addr := range cases {
		_, err := ValidateAddress(addr)
		if !errors.Is(err, ErrUnrecognisedAddress) {
			t.Errorf("ValidateAddress(%q) error = %v, want errors.Is ErrUnrecognisedAddress", addr, err)
		}
	}
}

func TestValidateAddress_ChecksumFailureIsNotUnrecognised(t *testing.T) {
	// A well-formed-but-mistyped address (correct prefix and charset, failing
	// checksum) must NOT be reported as ErrUnrecognisedAddress: the format was
	// recognised, the checksum was not. This is the distinction the sentinel
	// exists to let callers make.
	const bech32Typo = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr" // last char flipped
	_, err := ValidateAddress(bech32Typo)
	if err == nil {
		t.Fatal("expected an error for a bech32 typo")
	}
	if errors.Is(err, ErrUnrecognisedAddress) {
		t.Errorf("bech32 checksum typo wrongly classified as ErrUnrecognisedAddress: %v", err)
	}
}
