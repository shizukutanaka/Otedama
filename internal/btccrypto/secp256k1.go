// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package btccrypto — secp256k1.go
//
// Registers the two secp256k1-based signature schemes Bitcoin uses
// today: ECDSA (P2PKH/P2SH/P2WPKH/P2WSH) and Schnorr/BIP-340 (P2TR).
//
// These are registered as **namespace-reserving stubs**: they satisfy
// the Scheme interface so the registry, Schemes(), and
// SchemeForAddressType dispatch all work, but their cryptographic
// operations return ErrSchemeNotImplemented until the audited
// secp256k1 dependency lands. That dependency decision is recorded in
// docs/adr/ADR-011 (adopt github.com/decred/dcrd/dcrec/secp256k1/v4),
// and the related transport stub is tracked in
// docs/KNOWN_LIMITATIONS.md §2. Using a stub here — rather than DIY
// secp256k1 — is the same honesty-over-silent-approximation stance the
// ML-DSA/SPHINCS+ scaffolding takes (see ErrSchemeNotImplemented).
package btccrypto

// secp256k1Stub reserves a secp256k1-based scheme name. Verify, parse,
// and (for the signer variant) Sign return ErrSchemeNotImplemented
// until the real implementation replaces this file.
type secp256k1Stub struct{ name string }

// Name returns the stable registry identifier (e.g. "ecdsa-secp256k1").
func (s secp256k1Stub) Name() string { return s.name }

// Verify returns ErrSchemeNotImplemented: no secp256k1 backend yet.
func (s secp256k1Stub) Verify(pub PublicKey, msg []byte, sig Signature) error {
	return ErrSchemeNotImplemented
}

// PublicKeyFromBytes returns ErrSchemeNotImplemented.
func (s secp256k1Stub) PublicKeyFromBytes(b []byte) (PublicKey, error) {
	return nil, ErrSchemeNotImplemented
}

// SignatureFromBytes returns ErrSchemeNotImplemented.
func (s secp256k1Stub) SignatureFromBytes(b []byte) (Signature, error) {
	return nil, ErrSchemeNotImplemented
}

// Compile-time check: secp256k1Stub must satisfy Scheme. If the Scheme
// interface gains a new method, this line fails at build time — not only
// when the test binary is compiled.
var _ Scheme = secp256k1Stub{}

func init() {
	Register(secp256k1Stub{name: "ecdsa-secp256k1"})
	Register(secp256k1Stub{name: "schnorr-secp256k1"})
}
