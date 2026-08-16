// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// The official BIP-350 segwit address test vectors.
//
// Address validation is the last thing standing between a mistyped payout
// address and months of mining into a hole, so it is worth checking against
// the specification's own vectors rather than fixtures of our own devising.
// The sibling tests in bech32_test.go exercise the structure of the decoder;
// these exercise the cases the BIP authors chose, including the ones the
// bech32m revision exists to catch.
//
// Source: bitcoin/bips bip-0350.mediawiki, "Test vectors". Every address
// below was additionally run through an independent implementation of the
// BIP reference decoder before being committed, so a transcription slip in
// this table cannot masquerade as a passing test.
//
// # Why the invalid vectors matter more than the valid ones
//
// BIP-350 exists because bech32's checksum has an insertion weakness for
// witness versions above 0, so v1+ addresses must use a different checksum
// constant. An implementation that hardcodes one constant still validates
// every *valid* address of the matching version — it fails only on the
// crossed pair (a v1 address checksummed as bech32, a v0 address
// checksummed as bech32m). Both of those pairs are below.
package btccrypto

import (
	"errors"
	"testing"
)

// TestBIP350_ValidMainnetAddresses runs the specification's valid mainnet
// vectors that fall inside Otedama's supported set (see
// TestBIP350_DeliberatelyStricterThanTheSpec for the ones deliberately
// outside it) and checks the address type each decodes to.
func TestBIP350_ValidMainnetAddresses(t *testing.T) {
	tests := []struct {
		addr string
		want AddressType
		note string
	}{
		{
			addr: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
			want: AddressP2WPKH,
			note: "v0, 20-byte program, uppercase (scriptPubKey 0014751e76e8…)",
		},
		{
			addr: "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
			want: AddressP2WSH,
			note: "v0, 32-byte program",
		},
		{
			addr: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
			want: AddressP2TR,
			note: "v1, 32-byte program — bech32m (scriptPubKey 512079be667e…)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			got, err := ValidateBech32Address(tt.addr)
			if err != nil {
				t.Fatalf("rejected a valid BIP-350 vector (%s): %v", tt.note, err)
			}
			if got != tt.want {
				t.Errorf("type = %v, want %v (%s)", got, tt.want, tt.note)
			}
			// ValidateAddress is the entry point config validation calls; it
			// must reach the same verdict rather than falling through to the
			// legacy base58 path.
			if got, err := ValidateAddress(tt.addr); err != nil || got != tt.want {
				t.Errorf("ValidateAddress = (%v, %v), want (%v, nil)", got, err, tt.want)
			}
		})
	}
}

// TestBIP350_InvalidAddressesRejected runs every mainnet invalid vector from
// the specification, each labelled with the BIP's own stated reason.
func TestBIP350_InvalidAddressesRejected(t *testing.T) {
	tests := []struct {
		addr   string
		reason string
	}{
		{
			addr:   "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
			reason: "Invalid checksum (Bech32 instead of Bech32m)",
		},
		{
			addr:   "BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL",
			reason: "Invalid checksum (Bech32 instead of Bech32m)",
		},
		{
			addr:   "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh",
			reason: "Invalid checksum (Bech32m instead of Bech32)",
		},
		{
			addr:   "bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4",
			reason: "Invalid character in checksum",
		},
		{
			addr:   "BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R",
			reason: "Invalid witness version",
		},
		{
			addr:   "bc1pw5dgrnzv",
			reason: "Invalid program length (1 byte)",
		},
		{
			addr:   "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav",
			reason: "Invalid program length (41 bytes)",
		},
		{
			addr:   "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P",
			reason: "Invalid program length for witness version 0 (per BIP141)",
		},
		{
			addr:   "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf",
			reason: "zero padding of more than 4 bits",
		},
		{
			addr:   "bc1gmk9yu",
			reason: "Empty data section",
		},
	}
	for _, tt := range tests {
		t.Run(tt.reason, func(t *testing.T) {
			if _, err := ValidateBech32Address(tt.addr); err == nil {
				t.Errorf("accepted an invalid BIP-350 vector (%s): %q", tt.reason, tt.addr)
			}
			// And the dispatcher must report it as a bad address, never as
			// ErrUnrecognisedAddress — an operator who typo'd a bech32
			// address needs to be told the checksum failed, not that the
			// string looks like nothing at all.
			_, err := ValidateAddress(tt.addr)
			if err == nil {
				t.Errorf("ValidateAddress accepted %q (%s)", tt.addr, tt.reason)
			}
			if errors.Is(err, ErrUnrecognisedAddress) {
				t.Errorf("ValidateAddress reported %q as an unrecognised format; "+
					"it is a bech32 address that fails validation (%s)", tt.addr, tt.reason)
			}
		})
	}
}

// TestBIP350_DeliberatelyStricterThanTheSpec pins the three cases where
// Otedama rejects an address the specification calls valid. Each is a
// deliberate choice about what may receive mining income, not an oversight,
// and each is worth revisiting under the stated condition.
func TestBIP350_DeliberatelyStricterThanTheSpec(t *testing.T) {
	tests := []struct {
		addr string
		why  string
	}{
		{
			addr: "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
			why: "witness v1 with a 40-byte program. Valid as an address under " +
				"BIP-350, but BIP-341 defines Taproot only for 32-byte v1 " +
				"programs, so this output cannot currently be spent — mining " +
				"income sent here would be stranded. Rejecting is protective. " +
				"Revisit if a future soft fork gives 40-byte v1 programs meaning.",
		},
		{
			addr: "BC1SW50QGDZ25J",
			why: "witness v16, 2-byte program. Valid per BIP-350; witness " +
				"versions 2-16 have no consensus meaning yet, so Otedama will " +
				"not direct payouts at one. Revisit when a version is defined.",
		},
		{
			addr: "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
			why:  "witness v2, 16-byte program. Same reasoning as v16 above.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.addr, func(t *testing.T) {
			if _, err := ValidateBech32Address(tt.addr); err == nil {
				t.Errorf("accepted %q — this test records a deliberate restriction, "+
					"so if the restriction was intentionally lifted, update the test "+
					"and KNOWN_LIMITATIONS together.\nRationale on file: %s", tt.addr, tt.why)
			}
		})
	}
}

// TestBIP350_TestnetIsNotAccepted covers the fourth deliberate restriction:
// mainnet only. A testnet address is reported as "not bech32" so the
// dispatcher can try the legacy path, which then fails — the operator ends
// up with an error either way, which is the point (Otedama has no testnet
// mode, so a tb1 payout address is always a configuration mistake).
func TestBIP350_TestnetIsNotAccepted(t *testing.T) {
	// A valid testnet vector from the specification.
	const tb = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7"
	if _, err := ValidateBech32Address(tb); !errors.Is(err, ErrNotBech32) {
		t.Errorf("ValidateBech32Address(%q) error = %v, want ErrNotBech32 "+
			"(non-'bc' HRPs are handed back to the dispatcher)", tb, err)
	}
	if _, err := ValidateAddress(tb); err == nil {
		t.Errorf("ValidateAddress accepted a testnet address: %q", tb)
	}
}

// TestBIP350_ChecksumConstantIsVersionDependent is the test that fails if
// someone "simplifies" the two checksum constants into one. It pairs the
// two crossed vectors: swapping either constant makes exactly one of these
// four assertions fail, whichever direction the mistake goes.
func TestBIP350_ChecksumConstantIsVersionDependent(t *testing.T) {
	const (
		v0Bech32  = "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"                     // correct: v0 + bech32
		v0Bech32m = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh"                     // wrong: v0 + bech32m
		v1Bech32m = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0" // correct: v1 + bech32m
		v1Bech32  = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd" // wrong: v1 + bech32
	)
	if _, err := ValidateBech32Address(v0Bech32); err != nil {
		t.Errorf("v0 address with the bech32 constant was rejected: %v", err)
	}
	if _, err := ValidateBech32Address(v1Bech32m); err != nil {
		t.Errorf("v1 address with the bech32m constant was rejected: %v", err)
	}
	if _, err := ValidateBech32Address(v0Bech32m); err == nil {
		t.Error("v0 address checksummed as bech32m was accepted — the constant " +
			"is not being selected by witness version")
	}
	if _, err := ValidateBech32Address(v1Bech32); err == nil {
		t.Error("v1 address checksummed as bech32 was accepted — this is exactly " +
			"the weakness BIP-350 was written to close")
	}
}
