// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"errors"
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
