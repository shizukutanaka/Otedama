// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package btccrypto — base58.go
//
// Base58Check checksum verification for legacy Bitcoin addresses (P2PKH "1…"
// and P2SH "3…"). Like bech32 (see bech32.go) this is NOT cryptography in the
// prohibited sense: Base58Check is a base-58 decode followed by a double-SHA256
// checksum, and it reuses Hash256 (audited crypto/sha256). It completes the
// payout-address typo protection started in bech32.go: a transcription error in
// a "1…"/"3…" address that stays inside the base58 alphabet passes a charset
// check yet fails the 4-byte checksum, so without this it would silently direct
// earnings to a wrong or undecodable address.
//
// Only mainnet version bytes are accepted (0x00 P2PKH, 0x05 P2SH); Otedama does
// not configure testnet/signet.

package btccrypto

import (
	"bytes"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// base58Alphabet is Bitcoin's Base58 alphabet: it omits 0, O, I, and l to
// reduce transcription errors. A character's value is its index here.
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// base58Decode decodes a Base58 string into its byte representation, preserving
// leading-zero bytes (each leading '1' in the input encodes one 0x00 byte).
func base58Decode(s string) ([]byte, error) {
	n := new(big.Int)
	radix := big.NewInt(58)
	for _, r := range s {
		idx := strings.IndexRune(base58Alphabet, r)
		if idx < 0 {
			return nil, fmt.Errorf("invalid base58 character %q", r)
		}
		n.Mul(n, radix)
		n.Add(n, big.NewInt(int64(idx)))
	}
	decoded := n.Bytes()
	// Each leading '1' represents a leading zero byte that big.Int drops.
	var leading int
	for i := 0; i < len(s) && s[i] == '1'; i++ {
		leading++
	}
	out := make([]byte, leading+len(decoded))
	copy(out[leading:], decoded)
	return out, nil
}

// ValidateBase58Address verifies the Base58Check checksum and structure of a
// mainnet legacy address ("1…" P2PKH or "3…" P2SH) and returns its AddressType.
// It returns an error for any malformed input: a character outside the base58
// alphabet, a wrong decoded length, a failed checksum (the common case for a
// typo), or an unsupported version byte.
//
// Inputs that are not legacy base58 (bech32 "bc1…", empty, or not starting with
// '1'/'3') return ErrNotBase58 so callers can fall back to their own handling.
func ValidateBase58Address(addr string) (AddressType, error) {
	if addr == "" ||
		strings.HasPrefix(addr, "bc1") || strings.HasPrefix(addr, "BC1") ||
		(!strings.HasPrefix(addr, "1") && !strings.HasPrefix(addr, "3")) {
		return AddressUnknown, ErrNotBase58
	}

	raw, err := base58Decode(addr)
	if err != nil {
		return AddressUnknown, fmt.Errorf("btccrypto: %w", err)
	}
	// version(1) + hash160(20) + checksum(4) = 25 bytes for P2PKH/P2SH.
	if len(raw) != 25 {
		return AddressUnknown, fmt.Errorf("btccrypto: base58 address decodes to %d bytes, want 25", len(raw))
	}
	payload := raw[:21]
	checksum := raw[21:]
	sum := Hash256(payload)
	if !bytes.Equal(sum[:4], checksum) {
		return AddressUnknown, fmt.Errorf("btccrypto: base58 checksum failed (likely a typo in the address)")
	}
	switch payload[0] {
	case 0x00:
		return AddressP2PKH, nil
	case 0x05:
		return AddressP2SH, nil
	default:
		return AddressUnknown, fmt.Errorf("btccrypto: unsupported base58 version byte 0x%02x (mainnet P2PKH/P2SH only)", payload[0])
	}
}

// ValidateAddress verifies a mainnet Bitcoin address of any supported format
// (bech32/bech32m SegWit or legacy Base58Check) and returns its AddressType.
// It is the single entry point payout-address validation should use: it tries
// bech32 first, then base58, and returns a descriptive error if the address is
// well-formed in neither. A nil error means the checksum verified.
func ValidateAddress(addr string) (AddressType, error) {
	if t, err := ValidateBech32Address(addr); !errors.Is(err, ErrNotBech32) {
		return t, err
	}
	if t, err := ValidateBase58Address(addr); !errors.Is(err, ErrNotBase58) {
		return t, err
	}
	return AddressUnknown, ErrUnrecognisedAddress
}
