// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package lightning — seedstore.go
//
// On-disk encryption of the wallet seed. This is deliberately separate
// from seed.go (which handles BIP-39 entropy/mnemonic/seed derivation):
// derivation is "how a seed comes to exist", storage is "how a seed is
// protected at rest". Splitting them keeps each file focused and makes
// the encryption surface — the part most relevant to a security audit —
// easy to locate and review in isolation.
//
// On-disk format (EncryptedSeed.Marshal):
//
//	version (1 byte)    : currently 0x01
//	salt    (16 bytes)  : scrypt salt
//	nonce   (12 bytes)  : AES-GCM nonce
//	cipher  (variable)  : AES-GCM ciphertext of the 64-byte seed
package lightning

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/scrypt"
)

// EncryptedSeed is the on-disk representation of a user's seed. The
// format is:
//
//	version (1 byte)    : currently 0x01
//	salt    (16 bytes)  : scrypt salt
//	nonce   (12 bytes)  : AES-GCM nonce
//	cipher  (variable)  : AES-GCM ciphertext of the 64-byte seed
//
// Decoding into Go types uses the Marshal and Unmarshal methods rather
// than JSON/TOML, because predictable binary layout eases cross-language
// interop (for example, a future Rust client can open the same file).
type EncryptedSeed struct {
	Version    byte
	Salt       [16]byte
	Nonce      [12]byte
	Ciphertext []byte
}

// currentEncryptedSeedVersion is the latest on-disk format version.
// When changing the on-disk layout, increment this constant and retain
// decoding logic for older versions to preserve backward compatibility.
const currentEncryptedSeedVersion byte = 0x01

// scryptParams are the BIP-38-inspired scrypt parameters used for
// passphrase-to-key derivation. The combination (N=2^17, r=8, p=1)
// targets ~1 second on a modern consumer CPU, which makes offline
// brute force prohibitively expensive while keeping unlock time
// acceptable for an interactive user.
const (
	scryptN = 1 << 17
	scryptR = 8
	scryptP = 1
)

// EncryptSeed returns an EncryptedSeed suitable for writing to disk.
// The passphrase is used to derive an encryption key via scrypt.
//
// The reader argument provides random bytes for the salt and nonce;
// passing nil defaults to crypto/rand.Reader. Tests may inject
// deterministic readers for reproducible encryption outputs.
func EncryptSeed(s Seed, passphrase string, reader io.Reader) (EncryptedSeed, error) {
	if reader == nil {
		reader = rand.Reader
	}
	if passphrase == "" {
		// A passphrase of zero length means the seed file is essentially
		// unencrypted (scrypt of empty string is still deterministic,
		// so the encryption provides no protection). Require a non-
		// empty passphrase so users do not accidentally save seeds
		// in the clear.
		return EncryptedSeed{}, errors.New("lightning: passphrase must not be empty")
	}

	var es EncryptedSeed
	es.Version = currentEncryptedSeedVersion
	if _, err := io.ReadFull(reader, es.Salt[:]); err != nil {
		return EncryptedSeed{}, fmt.Errorf("lightning: salt generation failed: %w", err)
	}
	if _, err := io.ReadFull(reader, es.Nonce[:]); err != nil {
		return EncryptedSeed{}, fmt.Errorf("lightning: nonce generation failed: %w", err)
	}

	key, err := scrypt.Key([]byte(passphrase), es.Salt[:], scryptN, scryptR, scryptP, 32)
	if err != nil {
		return EncryptedSeed{}, fmt.Errorf("lightning: scrypt derivation failed: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return EncryptedSeed{}, fmt.Errorf("lightning: aes init failed: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedSeed{}, fmt.Errorf("lightning: gcm init failed: %w", err)
	}
	es.Ciphertext = gcm.Seal(nil, es.Nonce[:], s[:], nil)
	return es, nil
}

// DecryptSeed recovers a Seed from its encrypted form, using the
// supplied passphrase. An incorrect passphrase produces an authentication
// failure (GCM verifies the tag), which is returned as an error. The
// caller must treat any decryption error as "wrong passphrase or
// tampered file" without assuming which.
func DecryptSeed(es EncryptedSeed, passphrase string) (Seed, error) {
	var zero Seed
	if es.Version != currentEncryptedSeedVersion {
		return zero, fmt.Errorf("lightning: unsupported EncryptedSeed version %d", es.Version)
	}
	if len(es.Ciphertext) == 0 {
		return zero, errors.New("lightning: EncryptedSeed has empty ciphertext")
	}

	key, err := scrypt.Key([]byte(passphrase), es.Salt[:], scryptN, scryptR, scryptP, 32)
	if err != nil {
		return zero, fmt.Errorf("lightning: scrypt derivation failed: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return zero, fmt.Errorf("lightning: aes init failed: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return zero, fmt.Errorf("lightning: gcm init failed: %w", err)
	}
	plaintext, err := gcm.Open(nil, es.Nonce[:], es.Ciphertext, nil)
	if err != nil {
		return zero, errors.New("lightning: decryption failed (wrong passphrase or corrupted file)")
	}
	if len(plaintext) != 64 {
		return zero, fmt.Errorf("lightning: decrypted seed is %d bytes, want 64", len(plaintext))
	}
	var out Seed
	copy(out[:], plaintext)
	return out, nil
}

// Marshal serializes EncryptedSeed to a byte slice suitable for disk
// storage. The format is tagged with a one-byte version so that future
// format changes remain backward-compatible.
func (es EncryptedSeed) Marshal() ([]byte, error) {
	if es.Version != currentEncryptedSeedVersion {
		return nil, fmt.Errorf("lightning: Marshal: unsupported version %d", es.Version)
	}
	buf := make([]byte, 0, 1+16+12+len(es.Ciphertext))
	buf = append(buf, es.Version)
	buf = append(buf, es.Salt[:]...)
	buf = append(buf, es.Nonce[:]...)
	buf = append(buf, es.Ciphertext...)
	return buf, nil
}

// UnmarshalEncryptedSeed decodes the byte slice produced by Marshal.
func UnmarshalEncryptedSeed(b []byte) (EncryptedSeed, error) {
	const minLen = 1 + 16 + 12
	if len(b) < minLen {
		return EncryptedSeed{}, fmt.Errorf("lightning: EncryptedSeed too short: %d bytes, need at least %d", len(b), minLen)
	}
	var es EncryptedSeed
	es.Version = b[0]
	if es.Version != currentEncryptedSeedVersion {
		return EncryptedSeed{}, fmt.Errorf("lightning: unsupported EncryptedSeed version %d", es.Version)
	}
	copy(es.Salt[:], b[1:17])
	copy(es.Nonce[:], b[17:29])
	es.Ciphertext = make([]byte, len(b)-29)
	copy(es.Ciphertext, b[29:])
	return es, nil
}
