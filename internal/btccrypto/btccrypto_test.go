// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package btccrypto

import (
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"
)

// ============================================================================
// fakeScheme — minimal Scheme for registry tests
// ============================================================================

type fakeScheme struct {
	name string
}

func (f *fakeScheme) Name() string { return f.name }
func (f *fakeScheme) Verify(_ PublicKey, _ []byte, _ Signature) error {
	return nil
}

func (f *fakeScheme) PublicKeyFromBytes(_ []byte) (PublicKey, error) {
	return nil, ErrInvalidPublicKey
}

func (f *fakeScheme) SignatureFromBytes(_ []byte) (Signature, error) {
	return nil, ErrInvalidSignature
}

// ============================================================================
// Registry
// ============================================================================

func TestRegister_DuplicateNamePanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Register did not panic on duplicate name")
		}
	}()
	Register(&fakeScheme{name: "test-duplicate"})
	Register(&fakeScheme{name: "test-duplicate"})
}

func TestLookup_UnknownReturnsTypedError(t *testing.T) {
	_, err := Lookup("totally-not-a-scheme")
	if err == nil {
		t.Fatal("Lookup of unknown scheme returned nil error")
	}
	if !errors.Is(err, ErrUnknownScheme) {
		t.Errorf("err is not ErrUnknownScheme: %v", err)
	}
	if !strings.Contains(err.Error(), "totally-not-a-scheme") {
		t.Errorf("error message should include the requested name: %v", err)
	}
}

func TestSchemes_DeterministicOrdering(t *testing.T) {
	// Multiple calls must return the same order — important for
	// metric label stability and for deterministic doctor output.
	a := Schemes()
	b := Schemes()
	if len(a) != len(b) {
		t.Fatalf("Schemes returned different lengths: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Errorf("Schemes ordering not stable at index %d: %q vs %q",
				i, a[i], b[i])
		}
	}
	// And the order must be lexicographic (ascending).
	for i := 1; i < len(a); i++ {
		if a[i] < a[i-1] {
			t.Errorf("Schemes not sorted: %q before %q", a[i-1], a[i])
		}
	}
}

func TestRegistry_ConcurrentLookupSafe(t *testing.T) {
	// Register one scheme then hammer Lookup from many goroutines.
	// Run with -race to catch unprotected map access.
	Register(&fakeScheme{name: "test-concurrent"})

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				if _, err := Lookup("test-concurrent"); err != nil {
					t.Errorf("concurrent Lookup failed: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// ============================================================================
// AddressType
// ============================================================================

func TestAddressType_StringForKnownTypes(t *testing.T) {
	for _, tt := range []struct {
		typ  AddressType
		want string
	}{
		{AddressP2PKH, "P2PKH"},
		{AddressP2SH, "P2SH"},
		{AddressP2WPKH, "P2WPKH"},
		{AddressP2WSH, "P2WSH"},
		{AddressP2TR, "P2TR"},
		{AddressP2MR, "P2MR"},
		{AddressUnknown, "unknown"},
		{AddressType(99), "unknown"},
	} {
		if got := tt.typ.String(); got != tt.want {
			t.Errorf("(%d).String() = %q, want %q", tt.typ, got, tt.want)
		}
	}
}

func TestSchemeForAddressType_P2MRReturnsNotImplemented(t *testing.T) {
	// This is the single most important test in this file. When
	// BIP-360 activates years from now, the maintainer must change
	// this test — and that change is the signal that they have
	// also implemented the ML-DSA scheme. If this test mysteriously
	// passes (returns a Scheme for P2MR) without the implementation
	// being added, something is very wrong.
	_, err := SchemeForAddressType(AddressP2MR)
	if err == nil {
		t.Fatal("AddressP2MR returned a Scheme; ML-DSA implementation is not done yet.")
	}
	if !errors.Is(err, ErrSchemeNotImplemented) {
		t.Errorf("err is not ErrSchemeNotImplemented: %v", err)
	}
	if !strings.Contains(err.Error(), "BIP-360") {
		t.Errorf("error message should reference BIP-360 for searchability: %v", err)
	}
}

func TestSchemeForAddressType_UnknownReturnsError(t *testing.T) {
	_, err := SchemeForAddressType(AddressUnknown)
	if err == nil {
		t.Fatal("AddressUnknown returned a Scheme")
	}
}

// The following test verifies that P2PKH/P2SH/P2WPKH/P2WSH all map
// to the same scheme name — the ECDSA-secp256k1 family. This is the
// invariant Otedama relies on when validating that a payout address
// matches the wallet that produced it.
func TestSchemeForAddressType_LegacyAndV0SegWitShareScheme(t *testing.T) {
	// This test only passes once an ecdsa-secp256k1 scheme is registered
	// (which happens in a sibling file we don't have yet). Until then,
	// the test documents the expectation. Skip rather than fail when
	// the scheme is absent.
	if _, err := Lookup("ecdsa-secp256k1"); err != nil {
		t.Skip("ecdsa-secp256k1 scheme not registered; this test is forward-looking")
	}
	for _, addr := range []AddressType{
		AddressP2PKH, AddressP2SH, AddressP2WPKH, AddressP2WSH,
	} {
		s, err := SchemeForAddressType(addr)
		if err != nil {
			t.Errorf("%v: %v", addr, err)
			continue
		}
		if s.Name() != "ecdsa-secp256k1" {
			t.Errorf("%v dispatched to %q, want ecdsa-secp256k1", addr, s.Name())
		}
	}
}

// ============================================================================
// Hash256 — Bitcoin double-SHA256
// ============================================================================

// Test vector: empty input. SHA-256(SHA-256("")) is well-known.
func TestHash256_EmptyInput(t *testing.T) {
	want := mustHex(
		"5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456")
	got := Hash256([]byte{})
	if got != want {
		t.Errorf("Hash256(\"\") = %x, want %x", got, want)
	}
}

// Test vector: "hello" → known double-SHA-256.
func TestHash256_KnownString(t *testing.T) {
	want := mustHex(
		"9595c9df90075148eb06860365df33584b75bff782a510c6cd4883a419833d50")
	got := Hash256([]byte("hello"))
	if got != want {
		t.Errorf("Hash256(\"hello\") = %x, want %x", got, want)
	}
}

func TestHash256_SameInputDeterministic(t *testing.T) {
	a := Hash256([]byte("the same input"))
	b := Hash256([]byte("the same input"))
	if a != b {
		t.Errorf("Hash256 not deterministic: %x vs %x", a, b)
	}
}

func TestHash256_DifferentInputsDifferentOutputs(t *testing.T) {
	a := Hash256([]byte("input A"))
	b := Hash256([]byte("input B"))
	if a == b {
		t.Error("Hash256 collision on trivially different inputs")
	}
}

// ============================================================================
// TaggedHash — BIP-340 / BIP-341 tagged hashing
// ============================================================================

// Test vector verified against canonical SHA-256:
//
//	tagged_hash("BIP0340/challenge", []) = c216d352f5818b7b4beacd4ae0a26fe888080823d2a598856661bcd54f1b3713
//
// Computed by hand:
//
//	tag_hash = SHA-256("BIP0340/challenge")
//	output   = SHA-256(tag_hash || tag_hash || "")
//
// This re-derives the construction as a pure regression test against
// any future refactor of TaggedHash.
func TestTaggedHash_BIP340Construction(t *testing.T) {
	want := mustHex(
		"c216d352f5818b7b4beacd4ae0a26fe888080823d2a598856661bcd54f1b3713")
	got := TaggedHash("BIP0340/challenge", []byte{})
	if got != want {
		t.Errorf("TaggedHash(\"BIP0340/challenge\", []) =\n  %x\nwant\n  %x",
			got, want)
	}
}

func TestTaggedHash_DifferentTagsDifferentOutputs(t *testing.T) {
	// This is the security property that tagged hashing exists to
	// provide: a signature over "TapBranch" || msg cannot be reused
	// as a signature over "TapLeaf" || msg.
	msg := []byte("identical message content")
	tagBranch := TaggedHash("TapBranch", msg)
	tagLeaf := TaggedHash("TapLeaf", msg)
	if tagBranch == tagLeaf {
		t.Error("TaggedHash collided across tag namespaces — domain separation broken")
	}
}

func TestTaggedHash_EmptyTag(t *testing.T) {
	// Empty tag is a valid edge case (tag_hash = SHA-256("")). Must
	// not panic and must produce deterministic output.
	a := TaggedHash("", []byte("msg"))
	b := TaggedHash("", []byte("msg"))
	if a != b {
		t.Errorf("TaggedHash with empty tag not deterministic")
	}
}

// ============================================================================
// helpers
// ============================================================================

func mustHex(s string) [32]byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	if len(b) != 32 {
		panic("expected 32-byte hex constant")
	}
	var out [32]byte
	copy(out[:], b)
	return out
}
