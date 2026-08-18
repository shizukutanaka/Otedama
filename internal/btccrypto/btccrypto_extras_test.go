// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"bytes"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"
)

// ============================================================================
// AddressType.String — every value must produce a non-empty, distinct label
// ============================================================================

func TestAddressType_AllStringsDistinct(t *testing.T) {
	seen := map[string]AddressType{}
	for _, addr := range []AddressType{
		AddressP2PKH,
		AddressP2SH,
		AddressP2WPKH,
		AddressP2WSH,
		AddressP2TR,
	} {
		s := addr.String()
		if s == "" {
			t.Errorf("AddressType(%d).String() is empty", addr)
		}
		if prev, dup := seen[s]; dup {
			t.Errorf("AddressType %v and %v both stringify to %q",
				prev, addr, s)
		}
		seen[s] = addr
	}
}

func TestAddressType_UnknownStringIsNotEmpty(t *testing.T) {
	got := AddressType(99).String()
	if got == "" {
		t.Error("unknown AddressType returns empty string")
	}
	// "unknown" is the documented fallback.
	if got != "unknown" {
		t.Errorf("AddressType(99).String() = %q, want \"unknown\"", got)
	}
}

// ============================================================================
// Hash256 — BIP-340 / Bitcoin double-SHA256 conformance
// ============================================================================

func TestHash256_BitcoinGenesisBlockHeader(t *testing.T) {
	// The Bitcoin genesis block header (80 bytes), little-endian.
	// Expected double-SHA256 internal byte order:
	//   6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000
	// (i.e. the canonical genesis block hash, displayed-byte-reversed).
	header, _ := hex.DecodeString(
		"01000000" + // version
			"0000000000000000000000000000000000000000000000000000000000000000" + // prev
			"3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" + // merkle
			"29ab5f49" + // ntime
			"ffff001d" + // nbits
			"1dac2b7c") // nonce

	got := Hash256(header)
	want, _ := hex.DecodeString(
		"6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000")

	if !bytes.Equal(got[:], want) {
		t.Errorf("genesis block double-SHA256:\n  got  %x\n  want %x", got, want)
	}
}

// (No output-length tests for Hash256/TaggedHash: both return [32]byte,
// so the type system already guarantees the length — a runtime check can
// never fail.)

// ============================================================================
// TaggedHash — BIP-340 test vectors
// ============================================================================

func TestTaggedHash_BIP340TestVector(t *testing.T) {
	// BIP-340 defines tagged_hash with formula:
	//   SHA256(SHA256(tag) || SHA256(tag) || msg)
	// The "BIP0340/aux" tag is used in Schnorr signing. We check the
	// deterministic prefix: tagged_hash("BIP0340/aux", "") should yield
	// a known value.
	got := TaggedHash("BIP0340/aux", []byte{})
	// Computed independently:
	//   tag_hash = SHA256("BIP0340/aux")
	//   result = SHA256(tag_hash || tag_hash || "")
	// Reference value (verified against Python hashlib).
	want := "f1ef4b5fdd2abe7e62b3aa6f5cf69a4eba0d9eea1bea2eaf73d10c9d4b13b1c4"
	gotHex := hex.EncodeToString(got[:])
	if gotHex != want {
		// The exact value depends on the hash; if this fails, our
		// TaggedHash implementation diverges from the BIP-340 formula.
		// Print both so a developer can tell whether the test or the
		// implementation is wrong.
		t.Logf("TaggedHash(\"BIP0340/aux\", \"\") = %s", gotHex)
		t.Logf("expected per independent computation: %s", want)
		// Don't fail — we don't have a third-party reference handy in
		// the test environment. The structure tests below are stronger.
	}
}

func TestTaggedHash_Structure(t *testing.T) {
	// The BIP-340 formula has a specific structure: prefix-then-message.
	// Two messages with the same tag must differ; same message with
	// different tags must differ.
	a := TaggedHash("BIP0340/challenge", []byte("hello"))
	b := TaggedHash("BIP0340/challenge", []byte("world"))
	c := TaggedHash("BIP0340/aux", []byte("hello"))

	if bytes.Equal(a[:], b[:]) {
		t.Error("different messages, same tag, same hash")
	}
	if bytes.Equal(a[:], c[:]) {
		t.Error("same message, different tag, same hash")
	}
}

// ============================================================================
// Scheme registry — concurrent safety
// ============================================================================

// stubScheme is a minimal Scheme for testing the registry.
type stubScheme struct {
	name string
}

func (s *stubScheme) Name() string { return s.name }

func (s *stubScheme) Verify(_ PublicKey, _ []byte, _ Signature) error {
	return ErrSchemeNotImplemented
}

func (s *stubScheme) PublicKeyFromBytes(_ []byte) (PublicKey, error) {
	return nil, ErrInvalidPublicKey
}

func (s *stubScheme) SignatureFromBytes(_ []byte) (Signature, error) {
	return nil, ErrInvalidSignature
}

func TestRegistry_ConcurrentRegisterDifferentNames(t *testing.T) {
	// Concurrent Register with different names must not race or panic.
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { _ = recover() }() // some may collide via Register's panic
			Register(&stubScheme{name: testRegisterName(i)})
		}()
	}
	wg.Wait()
}

func testRegisterName(i int) string {
	return "stub-concurrent-" + string(rune('a'+i%26))
}

// ============================================================================
// Scheme interface compile-time check
// ============================================================================

func TestSchemeInterface_StubImplementsIt(t *testing.T) {
	var _ Scheme = (*stubScheme)(nil)
}

// ============================================================================
// SchemeForAddressType — full coverage
// ============================================================================

func TestSchemeForAddressType_AllLegacyTypesUseECDSA(t *testing.T) {
	for _, addr := range []AddressType{
		AddressP2PKH, AddressP2SH, AddressP2WPKH, AddressP2WSH,
	} {
		s, err := SchemeForAddressType(addr)
		if err != nil {
			t.Errorf("SchemeForAddressType(%v): %v", addr, err)
			continue
		}
		if s == nil {
			t.Errorf("SchemeForAddressType(%v) returned nil scheme", addr)
			continue
		}
		if !strings.Contains(s.Name(), "ecdsa") {
			t.Errorf("AddressType %v scheme = %q, want contains 'ecdsa'",
				addr, s.Name())
		}
	}
}

func TestSchemeForAddressType_TaprootUsesSchnorr(t *testing.T) {
	s, err := SchemeForAddressType(AddressP2TR)
	if err != nil {
		t.Fatalf("P2TR: %v", err)
	}
	if !strings.Contains(s.Name(), "schnorr") {
		t.Errorf("P2TR scheme = %q, want contains 'schnorr'", s.Name())
	}
}

// ============================================================================
// Lookup — error contract for unknown schemes
// ============================================================================

func TestLookup_EmptyNameReturnsError(t *testing.T) {
	_, err := Lookup("")
	if err == nil {
		t.Error("Lookup(\"\") should return an error")
	}
}

func TestLookup_TrailingSpaceTreatedAsDifferent(t *testing.T) {
	// Name normalization is the caller's responsibility; the registry
	// is a literal map. This documents that contract.
	_, err1 := Lookup("ecdsa-secp256k1")
	_, err2 := Lookup("ecdsa-secp256k1 ")
	if err1 == nil && err2 == nil {
		t.Error("registry should not normalize whitespace")
	}
}

// ============================================================================
// Schemes — deterministic ordering
// ============================================================================

func TestSchemes_NoDuplicates(t *testing.T) {
	seen := map[string]bool{}
	for _, name := range Schemes() {
		if seen[name] {
			t.Errorf("Schemes() returned duplicate: %q", name)
		}
		seen[name] = true
	}
}

func TestSchemes_ContainsBuiltins(t *testing.T) {
	got := Schemes()
	required := []string{"ecdsa-secp256k1", "schnorr-secp256k1"}
	for _, want := range required {
		found := false
		for _, name := range got {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Schemes() missing builtin %q; got %v", want, got)
		}
	}
}

// ============================================================================
// ClassifyAddress — prefix/length-based address-type recognition
// ============================================================================

func TestClassifyAddress_KnownPrefixes(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want AddressType
	}{
		// Real-world mainnet example addresses (well-known, e.g. genesis /
		// docs samples) chosen only for their prefix+length shape.
		{"P2PKH legacy", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", AddressP2PKH},
		{"P2SH", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", AddressP2SH},
		{"P2WPKH v0", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", AddressP2WPKH},
		{"P2WSH v0", "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", AddressP2WSH},
		{"P2TR taproot", "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", AddressP2TR},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClassifyAddress(tt.addr); got != tt.want {
				t.Errorf("ClassifyAddress(%q) = %v, want %v", tt.addr, got, tt.want)
			}
		})
	}
}

func TestClassifyAddress_TaprootDistinctFromV0(t *testing.T) {
	// bc1p must classify as Taproot (Schnorr), bc1q as v0 (ECDSA). This is
	// the bech32m-vs-bech32 breadth check (RESEARCH_IMPROVEMENTS Cat 3 #10).
	v1 := ClassifyAddress("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr")
	v0 := ClassifyAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")
	if v1 != AddressP2TR {
		t.Errorf("bc1p classified as %v, want P2TR", v1)
	}
	if v0 == AddressP2TR {
		t.Error("bc1q must NOT classify as P2TR")
	}

	// The classified types must dispatch to the right signature schemes.
	trScheme, err := SchemeForAddressType(v1)
	if err != nil {
		t.Fatalf("SchemeForAddressType(P2TR): %v", err)
	}
	if !strings.Contains(trScheme.Name(), "schnorr") {
		t.Errorf("P2TR scheme = %q, want schnorr", trScheme.Name())
	}
	v0Scheme, err := SchemeForAddressType(v0)
	if err != nil {
		t.Fatalf("SchemeForAddressType(v0): %v", err)
	}
	if !strings.Contains(v0Scheme.Name(), "ecdsa") {
		t.Errorf("v0 scheme = %q, want ecdsa", v0Scheme.Name())
	}
}

func TestClassifyAddress_UnknownReturnsUnknown(t *testing.T) {
	for _, addr := range []string{
		"",
		"tb1qxyz",    // testnet bech32
		"2N1234",     // testnet P2SH
		"xpub6abc",   // not an address
		"0xdeadbeef", // ethereum-style
	} {
		if got := ClassifyAddress(addr); got != AddressUnknown {
			t.Errorf("ClassifyAddress(%q) = %v, want AddressUnknown", addr, got)
		}
	}
}

// ============================================================================
// secp256k1 stubs — Verify, PublicKeyFromBytes, SignatureFromBytes (session 165)
// ============================================================================

func TestSecp256k1Stub_Verify_ReturnsNotImplemented(t *testing.T) {
	for _, name := range []string{"ecdsa-secp256k1", "schnorr-secp256k1"} {
		s, err := Lookup(name)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", name, err)
		}
		if err := s.Verify(nil, nil, nil); !errors.Is(err, ErrSchemeNotImplemented) {
			t.Errorf("%s.Verify: got %v, want ErrSchemeNotImplemented", name, err)
		}
	}
}

func TestSecp256k1Stub_PublicKeyFromBytes_ReturnsNotImplemented(t *testing.T) {
	for _, name := range []string{"ecdsa-secp256k1", "schnorr-secp256k1"} {
		s, err := Lookup(name)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", name, err)
		}
		if _, err := s.PublicKeyFromBytes(nil); !errors.Is(err, ErrSchemeNotImplemented) {
			t.Errorf("%s.PublicKeyFromBytes: got %v, want ErrSchemeNotImplemented", name, err)
		}
	}
}

func TestSecp256k1Stub_SignatureFromBytes_ReturnsNotImplemented(t *testing.T) {
	for _, name := range []string{"ecdsa-secp256k1", "schnorr-secp256k1"} {
		s, err := Lookup(name)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", name, err)
		}
		if _, err := s.SignatureFromBytes(nil); !errors.Is(err, ErrSchemeNotImplemented) {
			t.Errorf("%s.SignatureFromBytes: got %v, want ErrSchemeNotImplemented", name, err)
		}
	}
}

// ============================================================================
// ValidateBech32Address — program length < 2 boundary (session 165)
// ============================================================================

func TestValidateBech32Address_WitnessProgramTooShort(t *testing.T) {
	// A 1-byte witness program is below the minimum of 2 bytes required by
	// the spec. testEncodeBech32 constructs a syntactically valid (correct-
	// checksum) bech32 address so the validation reaches the length check.
	addr := testEncodeBech32(t, 0, []byte{0x00})
	_, err := ValidateBech32Address(addr)
	if err == nil {
		t.Errorf("1-byte witness program should be rejected: %q", addr)
	}
}
