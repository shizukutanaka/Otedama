// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// Fuzz coverage for the BIP-39 parse boundary. MnemonicToEntropy takes
// operator-typed word sequences on the restore path: arbitrary word
// counts, unknown words, and checksum-corrupted phrases must error,
// never panic; a well-formed mnemonic must round-trip to its entropy
// bit-exact.
package lightning

import (
	"math/rand"
	"slices"
	"testing"
)

// fuzzWordList is a fixed synthetic list shared by both fuzzers.
func fuzzWL(t *testing.T) *WordList {
	t.Helper()
	words := make([]string, 2048)
	for i := range words {
		words[i] = wordAt(i) // wordAt defined in wallet_test.go
	}
	wl, err := NewWordList(words)
	if err != nil {
		t.Fatalf("fuzzWL: %v", err)
	}
	return wl
}

// FuzzMnemonicToEntropy feeds arbitrary word slices — wrong lengths,
// unknown words, real words in wrong order — and asserts the parser
// always returns (never panics) and that any accepted mnemonic
// re-encodes to an identical word sequence.
func FuzzMnemonicToEntropy(f *testing.F) {
	f.Add(int64(12)) // valid length, all-real words
	f.Add(int64(0))
	f.Add(int64(7))  // invalid length
	f.Add(int64(24)) // valid length
	f.Fuzz(func(t *testing.T, seed int64) {
		wl := fuzzWL(t)
		r := rand.New(rand.NewSource(seed))
		n := r.Intn(30)
		m := make(Mnemonic, n)
		for i := range m {
			switch r.Intn(10) {
			case 0:
				m[i] = "notaword"
			case 1:
				m[i] = "" // empty word
			case 2:
				m[i] = "ABANDON" // case mismatch
			default:
				m[i] = wordAt(r.Intn(2048))
			}
		}
		ent, err := MnemonicToEntropy(m, wl)
		if err != nil {
			return
		}
		// Accepted -> must round-trip to the same words.
		rt, err := EntropyToMnemonic(ent, wl)
		if err != nil {
			t.Fatalf("accepted mnemonic failed re-encode: %v", err)
		}
		if !slices.Equal([]string(m), []string(rt)) {
			t.Fatal("accepted mnemonic did not round-trip")
		}
	})
}

// FuzzMnemonicRoundtrip starts from random entropy of each legal size
// and asserts EntropyToMnemonic → MnemonicToEntropy is bit-exact. This
// pins the checksum math over every valid entropy length.
func FuzzMnemonicRoundtrip(f *testing.F) {
	f.Add([]byte{0})
	f.Add([]byte{16, 0xAB})
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) < 2 {
			return
		}
		wl := fuzzWL(t)
		legalSizes := []int{16, 20, 24, 28, 32}
		size := legalSizes[int(data[0])%len(legalSizes)]
		ent := Entropy(cycleBytes(data[1:], size))

		m, err := EntropyToMnemonic(ent, wl)
		if err != nil {
			t.Fatalf("EntropyToMnemonic(%d bytes): %v", size, err)
		}
		back, err := MnemonicToEntropy(m, wl)
		if err != nil {
			t.Fatalf("MnemonicToEntropy rejected freshly-encoded mnemonic: %v", err)
		}
		if !slices.Equal(ent, back) {
			t.Fatal("entropy round-trip not bit-exact")
		}
	})
}

// cycleBytes repeats src to fill a dst of size n.
func cycleBytes(src []byte, n int) []byte {
	dst := make([]byte, n)
	for i := range dst {
		dst[i] = src[i%len(src)]
	}
	return dst
}
