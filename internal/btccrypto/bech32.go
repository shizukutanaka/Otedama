// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package btccrypto — bech32.go
//
// Checksum verification for Bitcoin SegWit addresses (BIP-173 bech32 and
// BIP-350 bech32m). This is NOT cryptography: bech32 is a BCH error-detection
// code over GF(32) whose reference implementation is published in BIP-173 and
// is expected to be implemented by every wallet. It exists here to catch a
// mistyped payout address before earnings are directed at it — a single
// transcription error keeps every character inside the bech32 charset yet
// fails the checksum, so a prefix-and-length check (as Otedama previously
// relied on) cannot detect it. Verifying the checksum is the difference
// between "looks like an address" and "is a well-formed address".
//
// Only mainnet ("bc") witness addresses are accepted; Otedama does not
// configure testnet/signet. Base58 (legacy "1.../3...") checksum verification
// (Base58Check) is tracked separately and still falls back to a format check.

package btccrypto

import (
	"fmt"
	"strings"
)

// bech32Charset is the BIP-173 character set: the value of a character is its
// index in this string. It deliberately omits 1, b, i, o to reduce
// transcription errors.
const bech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

// bech32 checksum constants. BIP-173 (witness v0) uses 1; BIP-350 (witness
// v1+, e.g. Taproot) uses this constant to fix a weakness in the original
// scheme. Verifying against the right constant is what distinguishes a valid
// bech32m Taproot address from one that would pass plain bech32.
const (
	bech32Const  = 1
	bech32mConst = 0x2bc830a3
)

// bech32Polymod computes the BCH checksum residue over the given 5-bit values,
// per the BIP-173 reference implementation.
func bech32Polymod(values []int) int {
	gen := [5]int{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := 1
	for _, v := range values {
		top := chk >> 25
		chk = (chk&0x1ffffff)<<5 ^ v
		for i := 0; i < 5; i++ {
			if (top>>uint(i))&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

// bech32HrpExpand expands the human-readable part for checksum computation.
func bech32HrpExpand(hrp string) []int {
	out := make([]int, 0, len(hrp)*2+1)
	for _, c := range hrp {
		out = append(out, int(c)>>5)
	}
	out = append(out, 0)
	for _, c := range hrp {
		out = append(out, int(c)&31)
	}
	return out
}

// convertBits regroups data from `from`-bit groups into `to`-bit groups. With
// pad=false (used when decoding the witness program) it requires that no
// non-zero bits are left over, matching the BIP-173 decoding rule.
func convertBits(data []int, from, to uint, pad bool) ([]int, error) {
	var acc, bits int
	maxv := (1 << to) - 1
	out := make([]int, 0, len(data)*int(from)/int(to)+1)
	for _, v := range data {
		if v < 0 || v>>from != 0 {
			return nil, fmt.Errorf("btccrypto: convertBits: value %d out of range", v)
		}
		acc = (acc << from) | v
		bits += int(from)
		for bits >= int(to) {
			bits -= int(to)
			out = append(out, (acc>>uint(bits))&maxv)
		}
	}
	if pad {
		if bits > 0 {
			out = append(out, (acc<<(to-uint(bits)))&maxv)
		}
	} else if bits >= int(from) || ((acc<<(to-uint(bits)))&maxv) != 0 {
		return nil, fmt.Errorf("btccrypto: convertBits: invalid padding")
	}
	return out, nil
}

// ValidateBech32Address verifies the checksum and structure of a mainnet
// SegWit address (bech32 / bech32m) and returns its AddressType. It returns an
// error for any malformed input: mixed case, wrong human-readable part, a
// character outside the bech32 charset, a failed checksum (the common case for
// a typo), an out-of-range witness version, or a witness-program length that
// does not match the version (v0 must be 20 or 32 bytes; v1/Taproot must be
// 32 bytes).
//
// It accepts only "bc" mainnet addresses. Inputs that are not bech32 at all
// (legacy base58 "1.../3...") return ErrNotBech32 so callers can fall back to
// their own legacy handling.
func ValidateBech32Address(addr string) (AddressType, error) {
	if !strings.HasPrefix(addr, "bc1") && !strings.HasPrefix(addr, "BC1") {
		return AddressUnknown, ErrNotBech32
	}
	// BIP-173: reject mixed case; normalise to lower for decoding.
	if addr != strings.ToLower(addr) && addr != strings.ToUpper(addr) {
		return AddressUnknown, fmt.Errorf("btccrypto: bech32 address has mixed case")
	}
	s := strings.ToLower(addr)

	if len(s) > 90 {
		return AddressUnknown, fmt.Errorf("btccrypto: bech32 address too long (%d > 90)", len(s))
	}
	pos := strings.LastIndexByte(s, '1')
	if pos < 1 {
		return AddressUnknown, fmt.Errorf("btccrypto: bech32 address has no separator")
	}
	hrp := s[:pos]
	if hrp != "bc" {
		return AddressUnknown, fmt.Errorf("btccrypto: unsupported human-readable part %q (mainnet 'bc' only)", hrp)
	}
	dataPart := s[pos+1:]
	// 1 witness-version char + >=1 program + 6 checksum chars.
	if len(dataPart) < 8 {
		return AddressUnknown, fmt.Errorf("btccrypto: bech32 data part too short")
	}

	data := make([]int, 0, len(dataPart))
	for _, c := range dataPart {
		idx := strings.IndexRune(bech32Charset, c)
		if idx < 0 {
			return AddressUnknown, fmt.Errorf("btccrypto: invalid bech32 character %q", c)
		}
		data = append(data, idx)
	}

	// The witness version is the first data value; it selects which checksum
	// constant must match (BIP-350).
	version := data[0]
	if version > 16 {
		return AddressUnknown, fmt.Errorf("btccrypto: invalid witness version %d", version)
	}
	wantConst := bech32Const
	if version != 0 {
		wantConst = bech32mConst
	}
	if got := bech32Polymod(append(bech32HrpExpand(hrp), data...)); got != wantConst {
		return AddressUnknown, fmt.Errorf("btccrypto: bech32 checksum failed (likely a typo in the address)")
	}

	// Decode the witness program (everything after the version, minus the
	// 6-char checksum) from 5-bit to 8-bit groups and validate its length.
	program, err := convertBits(data[1:len(data)-6], 5, 8, false)
	if err != nil {
		return AddressUnknown, fmt.Errorf("btccrypto: bech32 program decode: %w", err)
	}
	if len(program) < 2 || len(program) > 40 {
		return AddressUnknown, fmt.Errorf("btccrypto: witness program length %d out of range", len(program))
	}

	switch version {
	case 0:
		switch len(program) {
		case 20:
			return AddressP2WPKH, nil
		case 32:
			return AddressP2WSH, nil
		default:
			return AddressUnknown, fmt.Errorf("btccrypto: v0 witness program must be 20 or 32 bytes, got %d", len(program))
		}
	case 1:
		if len(program) != 32 {
			return AddressUnknown, fmt.Errorf("btccrypto: v1 (Taproot) program must be 32 bytes, got %d", len(program))
		}
		return AddressP2TR, nil
	default:
		// Valid checksum, future witness version we don't classify further.
		return AddressUnknown, fmt.Errorf("btccrypto: unsupported witness version %d", version)
	}
}
