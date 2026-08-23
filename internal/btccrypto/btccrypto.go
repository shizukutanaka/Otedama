// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package btccrypto abstracts the signature schemes Otedama uses so
// that the inevitable post-quantum transition (BIP-360, expected
// 2028–2032) becomes a drop-in implementation change rather than a
// codebase-wide rewrite.
//
// # Why this exists
//
// Bitcoin's signature landscape is moving:
//
//   - 2009–2021: ECDSA over secp256k1 only (P2PKH, P2SH).
//   - 2021–:     Schnorr over secp256k1 added (P2TR, BIP-340).
//   - 2028–2032: BIP-360 introduces P2MR (Post-quantum Multi-Resistant)
//     outputs combining secp256k1 + ML-DSA (Dilithium) +
//     SPHINCS+. Activation timing has ±2-year uncertainty.
//   - 2032+:     Eventual sunsetting of pure-secp256k1 outputs once
//     cryptographically-relevant quantum computers arrive.
//
// Otedama's mining, payout, and wallet code must keep working through
// all of these transitions without touching call sites in stratum/,
// lightning/, or engine/. This package is the seam.
//
// # Design
//
//   - Scheme is an interface; any signature algorithm that implements
//     it (Sign, Verify, PublicKeyFromBytes) can be plugged in.
//   - Schemes() returns the registered set; Otedama chooses one based
//     on the address type it sees.
//   - The default registry includes ECDSA+secp256k1 and Schnorr,
//     currently as namespace-reserving stubs pending the secp256k1
//     dependency (ADR-011); ML-DSA/SPHINCS+ are likewise scaffolded so
//     each addition is small when the day comes.
//
// # What this package does NOT do
//
//   - It is not a crypto implementation. All real signing/verifying
//     will delegate to audited libraries (decred/dcrd/dcrec/secp256k1/v4
//     once ADR-011 lands, crypto/mldsa from std once Go ships it).
//   - It is not a key-management or wallet layer; that is in
//     internal/lightning/.
//   - It is not Stratum-protocol-aware; protocol code calls into
//     this package, never the reverse.
package btccrypto

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
)

// ----- Errors -----

var (
	// ErrUnknownScheme is returned when a Scheme name is not registered.
	ErrUnknownScheme = errors.New("btccrypto: unknown signature scheme")

	// ErrInvalidPublicKey is returned by PublicKeyFromBytes when the
	// input does not encode a valid public key for the scheme.
	ErrInvalidPublicKey = errors.New("btccrypto: invalid public key")

	// ErrInvalidSignature is returned when a signature is malformed
	// or does not verify.
	ErrInvalidSignature = errors.New("btccrypto: invalid signature")

	// ErrSchemeNotImplemented is returned by stub schemes that exist
	// to reserve the namespace but are not yet wired to a real
	// implementation. ML-DSA and SPHINCS+ return this until BIP-360
	// activates and Go's stdlib ships crypto/mldsa.
	ErrSchemeNotImplemented = errors.New("btccrypto: scheme registered but implementation pending")

	// ErrNotBech32 is returned by ValidateBech32Address when the input is not
	// a bech32 mainnet address (e.g. a legacy base58 "1.../3..." address), so
	// callers can fall back to their own legacy-format handling.
	ErrNotBech32 = errors.New("btccrypto: not a bech32 address")

	// ErrNotBase58 is returned by ValidateBase58Address when the input is not a
	// legacy base58 mainnet address (e.g. a bech32 "bc1..." address), so
	// callers (and ValidateAddress) can fall back to another format.
	ErrNotBase58 = errors.New("btccrypto: not a base58 address")

	// ErrUnrecognisedAddress is returned by ValidateAddress when an address is
	// well-formed in neither supported encoding (bech32/bech32m SegWit nor
	// legacy Base58Check). It is a sentinel so callers can distinguish "this is
	// not a recognisable address format" from any other validation error via
	// errors.Is — e.g. to offer format-specific guidance ("did you paste a
	// testnet address?") versus a checksum failure ("likely a typo").
	ErrUnrecognisedAddress = errors.New("btccrypto: unrecognized address format (not bech32 or base58 mainnet)")
)

// ----- Interfaces -----

// PublicKey is an opaque, scheme-specific public key. Methods on it
// return scheme-aware byte serialisations.
type PublicKey interface {
	// Bytes returns the canonical serialisation for this scheme:
	// 33 bytes (compressed sec1) for ECDSA-secp256k1; 32 bytes
	// (x-only) for Schnorr-secp256k1; ML-DSA-65 ≈1952 bytes; etc.
	Bytes() []byte

	// Scheme reports which Scheme produced this key.
	Scheme() string
}

// Signature is an opaque, scheme-specific signature.
type Signature interface {
	// Bytes returns the canonical serialisation. The size is
	// scheme-dependent: 64–72 bytes (DER ECDSA), 64 bytes (Schnorr),
	// ML-DSA-65 ≈3293 bytes, SPHINCS+-128f ≈17088 bytes.
	Bytes() []byte

	// Scheme reports which Scheme produced this signature.
	Scheme() string
}

// Scheme is a signature scheme: a way of signing and verifying
// messages with a public key.
//
// Implementations must be safe for concurrent use; verification in
// particular is called from many goroutines.
type Scheme interface {
	// Name is a stable, lowercase identifier. Used for registry
	// lookup and printed in logs / metrics.
	Name() string

	// Verify reports whether sig is a valid signature on msg under
	// pub. Both pub and sig must have been produced by this Scheme;
	// callers using a typed cast are responsible for that.
	Verify(pub PublicKey, msg []byte, sig Signature) error

	// PublicKeyFromBytes parses a serialised public key. It returns
	// ErrInvalidPublicKey if the bytes are not a well-formed public
	// key for this scheme.
	PublicKeyFromBytes(b []byte) (PublicKey, error)

	// SignatureFromBytes parses a serialised signature.
	SignatureFromBytes(b []byte) (Signature, error)
}

// SignerScheme extends Scheme with private-key operations. Otedama
// only uses signing for Lightning channel messages and (eventually)
// non-custodial payout authorisations; mining itself does not sign
// anything user-controlled.
type SignerScheme interface {
	Scheme

	// Sign produces a signature on msg using the scheme-specific
	// private key. priv is opaque to callers; obtain it from a
	// scheme-aware constructor (e.g. ECDSAPrivateKeyFromBytes).
	Sign(priv PrivateKey, msg []byte) (Signature, error)
}

// PrivateKey is an opaque, scheme-specific private key. Implementations
// MUST zero their internal state on Drop() and MUST refuse to expose
// their scalar via Bytes() unless the caller is a scheme-aware
// serialiser (typically wallet.dat encryption).
type PrivateKey interface {
	// Public returns the matching public key.
	Public() PublicKey

	// Scheme reports which Scheme produced this key.
	Scheme() string
}

// ----- Registry -----

// registry is the default, process-wide map from Scheme.Name() to
// Scheme. Entries are added at init() time by each implementation
// file via Register; no runtime registration is supported (that
// would let a malicious dependency inject a downgrade scheme).
var (
	registryMu sync.RWMutex
	registry   = map[string]Scheme{}
)

// Register adds s to the registry. Panics on duplicate name; this
// can only happen if two init() functions claim the same scheme,
// which is a programming error and not a runtime condition.
func Register(s Scheme) {
	registryMu.Lock()
	defer registryMu.Unlock()
	name := s.Name()
	if _, dup := registry[name]; dup {
		panic(fmt.Sprintf("btccrypto: scheme %q registered twice", name))
	}
	registry[name] = s
}

// Lookup returns the Scheme registered under name, or
// ErrUnknownScheme if none is registered.
func Lookup(name string) (Scheme, error) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	s, ok := registry[name]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownScheme, name)
	}
	return s, nil
}

// Schemes returns the names of all registered schemes, sorted for
// stable output. Useful for `otedama doctor` and metrics labels.
func Schemes() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	names := make([]string, 0, len(registry))
	for n := range registry {
		names = append(names, n)
	}
	// Sort to keep output deterministic. slices.Sort replaces a hand-rolled
	// insertion sort: same result, but boring and obviously correct (the
	// slices-migration of sessions 199–200 missed this one production call site).
	slices.Sort(names)
	return names
}

// ----- Address type → scheme dispatch -----

// AddressType identifies how a Bitcoin address encodes its
// authorisation rule, which determines the signature scheme needed
// to spend it.
type AddressType int

const (
	// AddressUnknown is the zero value.
	AddressUnknown AddressType = iota

	// AddressP2PKH is a legacy "1..." address.
	AddressP2PKH

	// AddressP2SH is a "3..." script-hash address.
	AddressP2SH

	// AddressP2WPKH is a v0 SegWit "bc1q..." address (20-byte program).
	AddressP2WPKH

	// AddressP2WSH is a v0 SegWit "bc1q..." address (32-byte program).
	AddressP2WSH

	// AddressP2TR is a Taproot v1 SegWit "bc1p..." address. Uses Schnorr.
	AddressP2TR

	// AddressP2MR is the future BIP-360 Post-quantum Multi-Resistant
	// address. Activation expected 2028–2032. Reserved here so call
	// sites can already branch on it; the actual ML-DSA/SPHINCS+
	// implementation arrives in a later release.
	AddressP2MR
)

// String returns a human-readable label.
func (t AddressType) String() string {
	switch t {
	case AddressP2PKH:
		return "P2PKH"
	case AddressP2SH:
		return "P2SH"
	case AddressP2WPKH:
		return "P2WPKH"
	case AddressP2WSH:
		return "P2WSH"
	case AddressP2TR:
		return "P2TR"
	case AddressP2MR:
		return "P2MR"
	default:
		return "unknown"
	}
}

// SchemeForAddressType returns the canonical Scheme used to spend
// outputs of the given AddressType. Returns ErrSchemeNotImplemented
// if the address type is reserved for a future Bitcoin upgrade that
// Otedama does not yet implement.
//
// This indirection is the heart of the abstraction: when BIP-360
// activates, this function gains a case for AddressP2MR returning
// the ML-DSA scheme, and every call site (block-template parsing,
// payout verification, doctor checks) immediately works on the new
// address type without further changes.
func SchemeForAddressType(t AddressType) (Scheme, error) {
	switch t {
	case AddressP2PKH, AddressP2SH, AddressP2WPKH, AddressP2WSH:
		return Lookup("ecdsa-secp256k1")
	case AddressP2TR:
		return Lookup("schnorr-secp256k1")
	case AddressP2MR:
		// Once stdlib ships crypto/mldsa (Go 1.27+ expected) and
		// BIP-360 activates, return Lookup("mldsa65-sphincs128f").
		// Until then, we deliberately error so call sites that
		// might encounter a P2MR address fail loudly rather than
		// silently mishandling it.
		return nil, fmt.Errorf("%w: P2MR (BIP-360) not yet implemented", ErrSchemeNotImplemented)
	default:
		return nil, fmt.Errorf("%w: unknown address type %v", ErrUnknownScheme, t)
	}
}

// ClassifyAddress maps a mainnet Bitcoin address string to its AddressType
// using the address prefix and (for SegWit) length. This is a lightweight
// classifier — it does NOT verify the bech32/base58 checksum. To verify that a
// SegWit address is well-formed (catching a mistyped payout address), call
// ValidateBech32Address. ClassifyAddress's own purpose is only to recognise
// which signature scheme an address will need, so callers can branch via
// SchemeForAddressType without a full decode.
//
// Prefix mapping (BIP-173 / BIP-350):
//
//	"1..."   → P2PKH        (base58, ECDSA)
//	"3..."   → P2SH         (base58, ECDSA)
//	"bc1q..." → P2WPKH (42 chars) or P2WSH (62 chars) — witness v0, ECDSA
//	"bc1p..." → P2TR        — witness v1, Schnorr (bech32m)
//
// The witness version lives in the first character after "bc1": 'q' encodes
// version 0 (SegWit v0), 'p' encodes version 1 (Taproot). bech32m P2TR
// addresses are therefore recognised distinctly from bech32 v0 addresses —
// which is exactly the breadth a 2026 payout configuration needs. Returns
// AddressUnknown for anything that does not match (including testnet/signet
// prefixes, which Otedama does not configure).
func ClassifyAddress(addr string) AddressType {
	switch {
	case strings.HasPrefix(addr, "bc1p"):
		// Witness v1: Taproot. (bech32m-encoded.)
		return AddressP2TR
	case strings.HasPrefix(addr, "bc1q"):
		// Witness v0: distinguish key-hash (P2WPKH) from script-hash (P2WSH)
		// by encoded length. A 20-byte program yields a 42-char address; a
		// 32-byte program yields a 62-char address.
		if len(addr) >= 60 {
			return AddressP2WSH
		}
		return AddressP2WPKH
	case strings.HasPrefix(addr, "1"):
		return AddressP2PKH
	case strings.HasPrefix(addr, "3"):
		return AddressP2SH
	default:
		return AddressUnknown
	}
}

// ----- Hash helper -----
//
// Otedama always hashes payloads with double-SHA256 before signing
// (Bitcoin's standard for ECDSA pre-Taproot) or single-SHA256 with a
// tagged hash for Schnorr. This helper keeps the hashing convention
// in one place.

// Hash256 computes SHA-256(SHA-256(b)).
func Hash256(b []byte) [32]byte {
	first := sha256.Sum256(b)
	return sha256.Sum256(first[:])
}

// TaggedHash implements BIP-340's tagged hashing:
//
//	SHA-256(SHA-256(tag) || SHA-256(tag) || msg)
//
// Used for Schnorr (BIP-340), Taproot (BIP-341), and Tapscript
// (BIP-342). Each tag namespace is kept distinct so a signature for
// one purpose cannot be reinterpreted for another.
func TaggedHash(tag string, msg []byte) [32]byte {
	tagHash := sha256.Sum256([]byte(tag))
	h := sha256.New()
	h.Write(tagHash[:])
	h.Write(tagHash[:])
	h.Write(msg)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
