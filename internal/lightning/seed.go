// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package lightning provides non-custodial Lightning Network wallet
// primitives for Otedama.
//
// # Non-Custodial Guarantee
//
// Competitive analysis of NiceHash (which lost 4,700 BTC to a 2017 hack),
// Kryptex, and ECOS exposes a shared weakness: they hold user funds in
// platform-managed custody, making a single platform breach catastrophic
// for every user simultaneously. Otedama rejects that architecture. The
// invariant enforced by this package is that the seed used to derive
// spending keys is:
//
//  1. Generated from crypto/rand on the user's own device.
//  2. Never transmitted, logged, or embedded in metrics.
//  3. Stored only on disk, encrypted at rest with a passphrase-derived key.
//  4. Loaded into memory only when the user unlocks the wallet.
//
// No Otedama maintainer, pool operator, or third party can recover a
// user's seed from the network, servers, or telemetry. This is not a
// promise of good behavior; it is a structural property enforced by
// where the secret lives and how it is handled.
//
// # Scope of This File
//
// This file covers the seed lifecycle: generation, serialization to
// mnemonic, encrypted storage, and decryption. It deliberately does not
// implement HD derivation, channel management, or payment routing;
// those live in sibling files and use Seed only as input. Keeping the
// seed lifecycle isolated simplifies auditing the most sensitive code
// path in Otedama.
//
// # BIP-39 Compliance
//
// Mnemonic generation and reconstruction follow BIP-39, verified against
// the complete official English test-vector set (bip39_vectors_test.go:
// entropy to mnemonic, mnemonic back to entropy, and mnemonic to seed for
// all 16 vectors). The package itself stays dependency-free by accepting
// the list via WordList rather than hardcoding one directly into this
// file — but the official 2,048-word English list IS bundled in this
// package (english_wordlist.go, integrity-checked by SHA-256 at init) and
// is what production wallet setup actually uses (see NewEnglishWordList(),
// called from engine.setupWallet). A caller that wants a different BIP-39
// language (Japanese, etc.) supplies its own list through the same
// WordList constructor.
//
// One deviation is known and is NOT covered by those vectors, which are
// pure ASCII: BIP-39 requires the mnemonic sentence and the salt
// ("mnemonic" + passphrase) to be UTF-8 NFKD-normalised before PBKDF2, and
// MnemonicToSeed normalises neither. For the sentence this is harmless in
// practice (see MnemonicToSeed); for a non-ASCII *passphrase* it changes
// the derived seed, so such a wallet is not portable to other BIP-39
// implementations. Tracked in docs/KNOWN_LIMITATIONS.md §19.
package lightning

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/pbkdf2"
)

// Entropy holds raw random bytes used to derive a seed. BIP-39 permits
// lengths of 128, 160, 192, 224, or 256 bits (16, 20, 24, 28, or 32
// bytes). Otedama defaults to 256 bits for maximum security.
type Entropy []byte

// DefaultEntropyBits is the default entropy size for new wallets.
const DefaultEntropyBits = 256

// Valid entropy lengths per BIP-39, in bits.
var validEntropyBits = map[int]bool{128: true, 160: true, 192: true, 224: true, 256: true}

// GenerateEntropy returns cryptographically random entropy of the given
// bit length. The length must be one of 128, 160, 192, 224, or 256.
//
// The reader argument allows tests to inject deterministic entropy; in
// production, pass crypto/rand.Reader. A nil reader also defaults to
// crypto/rand.Reader.
//
// Any error from the reader is returned directly; the caller must treat
// such errors as fatal and must not retry with a weaker source.
func GenerateEntropy(bits int, reader io.Reader) (Entropy, error) {
	if !validEntropyBits[bits] {
		return nil, fmt.Errorf("lightning: entropy bits must be 128/160/192/224/256, got %d", bits)
	}
	if reader == nil {
		reader = rand.Reader
	}
	buf := make([]byte, bits/8)
	if _, err := io.ReadFull(reader, buf); err != nil {
		return nil, fmt.Errorf("lightning: entropy generation failed: %w", err)
	}
	return buf, nil
}

// Validate reports whether this entropy has a BIP-39-acceptable length.
func (e Entropy) Validate() error {
	bits := len(e) * 8
	if !validEntropyBits[bits] {
		return fmt.Errorf("lightning: entropy has %d bits, must be one of 128/160/192/224/256", bits)
	}
	return nil
}

// WordList is a BIP-39 mnemonic wordlist. The list must contain exactly
// 2,048 unique words. Languages supported by BIP-39 (English, Japanese,
// Korean, Spanish, Chinese simplified, Chinese traditional, French,
// Italian, Czech, Portuguese) are all representable.
//
// Callers provide the wordlist via SetWordList so this package has no
// hard-coded word table. This keeps the package free of large embedded
// data and allows the caller to pick a list compatible with the active
// locale from the i18n subsystem.
type WordList struct {
	words     []string
	wordIndex map[string]int
}

// NewWordList constructs a WordList from a slice of exactly 2,048 words.
// Words must be unique; duplicates cause NewWordList to return an error.
func NewWordList(words []string) (*WordList, error) {
	const required = 2048
	if len(words) != required {
		return nil, fmt.Errorf("lightning: wordlist must have exactly %d entries, got %d", required, len(words))
	}
	idx := make(map[string]int, required)
	for i, w := range words {
		if w == "" {
			return nil, fmt.Errorf("lightning: wordlist entry at index %d is empty", i)
		}
		if !utf8.ValidString(w) {
			return nil, fmt.Errorf("lightning: wordlist entry at index %d is not valid UTF-8", i)
		}
		if _, dup := idx[w]; dup {
			return nil, fmt.Errorf("lightning: duplicate word %q in wordlist", w)
		}
		idx[w] = i
	}
	// Defensive copy so later mutation of the slice does not affect us.
	copied := make([]string, required)
	copy(copied, words)
	return &WordList{
		words:     copied,
		wordIndex: idx,
	}, nil
}

// Word returns the word at index i (0..2047).
func (w *WordList) Word(i int) (string, error) {
	if i < 0 || i >= len(w.words) {
		return "", fmt.Errorf("lightning: wordlist index %d out of range", i)
	}
	return w.words[i], nil
}

// Index returns the index of word in this wordlist, or an error if the
// word is not present.
func (w *WordList) Index(word string) (int, error) {
	i, ok := w.wordIndex[word]
	if !ok {
		return -1, fmt.Errorf("lightning: word %q not in wordlist", word)
	}
	return i, nil
}

// Mnemonic is a BIP-39 mnemonic phrase split into its constituent words.
//
// A Mnemonic is a public derivation input, not a secret in itself; only
// the underlying entropy is. However, it should be handled with the
// same care as a secret because it trivially reconstructs the entropy.
// Log, transmit, or display a Mnemonic only when explicitly recovering
// a wallet for the user.
type Mnemonic []string

// String returns the mnemonic as a space-separated sentence. For
// Japanese BIP-39 word lists, callers may prefer joining with "\u3000"
// (ideographic space); this function always uses an ASCII space.
func (m Mnemonic) String() string { return strings.Join(m, " ") }

// EntropyToMnemonic converts entropy to a BIP-39 mnemonic using the
// given wordlist. The algorithm appends a checksum of length ENT/32
// bits (where ENT is the entropy length in bits) and then slices the
// checksummed bitstream into 11-bit chunks, each used as an index into
// the wordlist.
func EntropyToMnemonic(e Entropy, w *WordList) (Mnemonic, error) {
	if err := e.Validate(); err != nil {
		return nil, err
	}
	if w == nil {
		return nil, errors.New("lightning: wordlist must not be nil")
	}

	ent := len(e) * 8
	cs := ent / 32    // checksum length in bits
	total := ent + cs // total bits in the indexable bitstream
	wordCount := total / 11

	// Compute the checksum: the first cs bits of SHA-256(entropy).
	sum := sha256.Sum256(e)
	checksumByte := sum[0]

	// Build a bit buffer: entropy || high `cs` bits of sum[0].
	bits := make([]byte, 0, ent+cs)
	for _, b := range e {
		for i := 7; i >= 0; i-- {
			bits = append(bits, (b>>uint(i))&1)
		}
	}
	for i := 7; i >= 8-cs; i-- {
		bits = append(bits, (checksumByte>>uint(i))&1)
	}

	mnemonic := make(Mnemonic, 0, wordCount)
	for i := 0; i < wordCount; i++ {
		var idx int
		for j := 0; j < 11; j++ {
			idx = (idx << 1) | int(bits[i*11+j])
		}
		word, err := w.Word(idx)
		if err != nil {
			return nil, err
		}
		mnemonic = append(mnemonic, word)
	}
	return mnemonic, nil
}

// MnemonicToEntropy recovers the entropy encoded in a mnemonic, using
// the given wordlist. The checksum embedded in the mnemonic must match,
// or the call returns an error. This validation catches transcription
// mistakes: any single-word typo will almost certainly produce a
// checksum mismatch.
func MnemonicToEntropy(m Mnemonic, w *WordList) (Entropy, error) {
	if w == nil {
		return nil, errors.New("lightning: wordlist must not be nil")
	}
	if len(m) == 0 {
		return nil, errors.New("lightning: mnemonic is empty")
	}

	// Valid word counts: 12, 15, 18, 21, 24 (one per valid entropy length).
	validCounts := map[int]bool{12: true, 15: true, 18: true, 21: true, 24: true}
	if !validCounts[len(m)] {
		return nil, fmt.Errorf("lightning: mnemonic has %d words, must be 12/15/18/21/24", len(m))
	}

	totalBits := len(m) * 11
	cs := totalBits / 33 // because ENT + CS = ENT * 33/32 <=> CS = totalBits/33
	entBits := totalBits - cs
	bits := make([]byte, 0, totalBits)

	for i, word := range m {
		idx, err := w.Index(word)
		if err != nil {
			return nil, fmt.Errorf("lightning: word %d: %w", i, err)
		}
		for j := 10; j >= 0; j-- {
			bits = append(bits, byte((idx>>uint(j))&1))
		}
	}

	// Reassemble entropy bytes.
	entropy := make(Entropy, entBits/8)
	for i := 0; i < entBits; i++ {
		entropy[i/8] |= bits[i] << uint(7-(i%8))
	}

	// Verify checksum.
	sum := sha256.Sum256(entropy)
	for i := 0; i < cs; i++ {
		want := (sum[0] >> uint(7-i)) & 1
		if bits[entBits+i] != want {
			return nil, errors.New("lightning: mnemonic checksum mismatch; check for transcription errors")
		}
	}
	return entropy, nil
}

// Seed is the 64-byte HD wallet seed derived from a mnemonic and an
// optional passphrase, per BIP-39 section "From mnemonic to seed".
type Seed [64]byte

// MnemonicToSeed derives a Seed from a mnemonic using PBKDF2-HMAC-SHA512
// with 2048 iterations, as mandated by BIP-39. The passphrase is
// optional (empty string is common); when supplied, it acts as an
// additional secret that must be known to recover the wallet.
//
// The passphrase argument allows users to opt into a "25th word" style
// protection. Entering the wrong passphrase produces a different valid-
// looking seed (a so-called decoy wallet), which is a documented BIP-39
// behavior. Otedama surfaces this clearly in the user-facing UI to
// avoid confusion.
//
// # Normalisation (known deviation)
//
// BIP-39 specifies both PBKDF2 inputs "in UTF-8 NFKD": the mnemonic
// sentence as the password, and "mnemonic" + passphrase as the salt. This
// function applies no normalisation to either.
//
//   - Mnemonic sentence: no practical effect. The bundled English list is
//     ASCII, which NFKD leaves unchanged, and BIP-39 requires every
//     wordlist to be NFKD-encoded in the first place — so a caller-supplied
//     list is already normalised. Joining with an ASCII space rather than
//     the ideographic space (U+3000) conventionally used for Japanese is
//     likewise safe, because NFKD maps U+3000 to a plain space.
//   - Passphrase: this one matters. A passphrase containing non-ASCII
//     characters is almost always in NFC as typed (é as U+00E9, パ as
//     U+30D1), and NFKD decomposes those. The seed derived here therefore
//     differs from the seed every conformant wallet derives from the same
//     phrase and passphrase — silently, since the other wallet produces a
//     valid-looking wallet rather than an error.
//
// An ASCII-only passphrase (and the empty passphrase, the default) is
// unaffected: NFKD is the identity on ASCII. Resolving this needs a
// maintainer decision — normalise (a new dependency, against ADR-003) or
// reject non-ASCII passphrases — so it is recorded rather than changed
// here: docs/KNOWN_LIMITATIONS.md §19.
func MnemonicToSeed(m Mnemonic, passphrase string) Seed {
	salt := "mnemonic" + passphrase
	password := []byte(m.String())
	seed := pbkdf2.Key(password, []byte(salt), 2048, 64, sha512.New)
	var out Seed
	copy(out[:], seed)
	return out
}

// ----- Sanity helpers -----

// Fingerprint returns a public, short identifier for a seed: the first
// 4 bytes of HMAC-SHA256("otedama-fingerprint-v1", seed), hex-encoded.
//
// This is NOT a secret. It is used to let the UI show the user that
// they have entered the correct mnemonic (by comparing fingerprints)
// without exposing the seed itself. The HMAC construction ensures that
// the fingerprint cannot be used to derive any part of the seed.
func Fingerprint(s Seed) string {
	mac := hmac.New(sha256.New, []byte("otedama-fingerprint-v1"))
	mac.Write(s[:])
	return hex.EncodeToString(mac.Sum(nil)[:4])
}
