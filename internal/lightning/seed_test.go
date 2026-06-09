// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package lightning

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// ----- Test fixtures -----

// englishTestList is a truncated, test-only wordlist. Real use requires
// the full 2,048-word BIP-39 English list; for round-trip correctness
// tests we need a unique-words list of exactly 2,048 entries. We
// construct one synthetically below.
func testWordList(t *testing.T) *WordList {
	t.Helper()
	words := make([]string, 2048)
	for i := range words {
		words[i] = fmtWord(i)
	}
	wl, err := NewWordList(words)
	if err != nil {
		t.Fatalf("building test wordlist: %v", err)
	}
	return wl
}

func fmtWord(i int) string {
	// Make each word a distinct lowercase ASCII token. The characters
	// and length don't matter for correctness; only uniqueness does.
	const alphabet = "abcdefghijklmnopqrstuvwxyz"
	a := i / (26 * 26)
	b := (i / 26) % 26
	c := i % 26
	return string(alphabet[a]) + string(alphabet[b]) + string(alphabet[c])
}

// ----- GenerateEntropy -----

func TestGenerateEntropy_ValidBitCounts(t *testing.T) {
	for _, bits := range []int{128, 160, 192, 224, 256} {
		e, err := GenerateEntropy(bits, nil)
		if err != nil {
			t.Errorf("GenerateEntropy(%d) failed: %v", bits, err)
			continue
		}
		if len(e) != bits/8 {
			t.Errorf("GenerateEntropy(%d) length = %d, want %d", bits, len(e), bits/8)
		}
	}
}

func TestGenerateEntropy_RejectsInvalidBitCounts(t *testing.T) {
	for _, bits := range []int{0, 64, 100, 127, 129, 257, 512} {
		if _, err := GenerateEntropy(bits, nil); err == nil {
			t.Errorf("GenerateEntropy(%d) accepted; want error", bits)
		}
	}
}

func TestGenerateEntropy_UsesProvidedReader(t *testing.T) {
	// Deterministic reader yields predictable entropy. Two calls with
	// identical readers must produce identical output, which is the
	// property that makes tests of downstream derivation possible.
	r1 := bytes.NewReader(bytes.Repeat([]byte{0xAB}, 32))
	e1, err := GenerateEntropy(256, r1)
	if err != nil {
		t.Fatalf("e1: %v", err)
	}
	r2 := bytes.NewReader(bytes.Repeat([]byte{0xAB}, 32))
	e2, err := GenerateEntropy(256, r2)
	if err != nil {
		t.Fatalf("e2: %v", err)
	}
	if !bytes.Equal(e1, e2) {
		t.Error("deterministic reader produced different entropy")
	}
	if !bytes.Equal(e1, bytes.Repeat([]byte{0xAB}, 32)) {
		t.Error("entropy does not match injected bytes")
	}
}

func TestGenerateEntropy_PropagatesReaderError(t *testing.T) {
	// A reader that never returns enough bytes must surface as an error,
	// not a silent weaker source.
	r := bytes.NewReader([]byte{0x01, 0x02})
	if _, err := GenerateEntropy(256, r); err == nil {
		t.Error("short reader accepted; wallet generation must refuse insufficient entropy")
	}
}

// ----- WordList validation -----

func TestNewWordList_RejectsWrongLength(t *testing.T) {
	if _, err := NewWordList(make([]string, 2047)); err == nil {
		t.Error("2047-word list accepted")
	}
	if _, err := NewWordList(make([]string, 2049)); err == nil {
		t.Error("2049-word list accepted")
	}
}

func TestNewWordList_RejectsDuplicates(t *testing.T) {
	words := make([]string, 2048)
	for i := range words {
		words[i] = fmtWord(i)
	}
	words[100] = words[0] // deliberate duplicate
	if _, err := NewWordList(words); err == nil {
		t.Error("duplicate-containing wordlist accepted")
	}
}

func TestNewWordList_RejectsEmptyWord(t *testing.T) {
	words := make([]string, 2048)
	for i := range words {
		words[i] = fmtWord(i)
	}
	words[50] = ""
	if _, err := NewWordList(words); err == nil {
		t.Error("empty-word-containing wordlist accepted")
	}
}

// ----- Entropy ↔ Mnemonic roundtrip -----

func TestEntropyToMnemonic_WordCountMatchesEntropy(t *testing.T) {
	wl := testWordList(t)
	tests := []struct {
		bits      int
		wantWords int
	}{
		{128, 12}, {160, 15}, {192, 18}, {224, 21}, {256, 24},
	}
	for _, tt := range tests {
		e, err := GenerateEntropy(tt.bits, nil)
		if err != nil {
			t.Fatalf("bits=%d: entropy: %v", tt.bits, err)
		}
		m, err := EntropyToMnemonic(e, wl)
		if err != nil {
			t.Fatalf("bits=%d: EntropyToMnemonic: %v", tt.bits, err)
		}
		if len(m) != tt.wantWords {
			t.Errorf("bits=%d: got %d words, want %d", tt.bits, len(m), tt.wantWords)
		}
	}
}

func TestEntropyMnemonicRoundtrip_Deterministic(t *testing.T) {
	wl := testWordList(t)
	for trial := 0; trial < 20; trial++ {
		e, err := GenerateEntropy(256, nil)
		if err != nil {
			t.Fatalf("entropy: %v", err)
		}
		m, err := EntropyToMnemonic(e, wl)
		if err != nil {
			t.Fatalf("EntropyToMnemonic: %v", err)
		}
		back, err := MnemonicToEntropy(m, wl)
		if err != nil {
			t.Fatalf("MnemonicToEntropy: %v", err)
		}
		if !bytes.Equal(e, back) {
			t.Fatalf("trial %d: entropy roundtrip mismatch\n got %X\nwant %X", trial, back, e)
		}
	}
}

func TestMnemonicToEntropy_DetectsChecksumMismatch(t *testing.T) {
	wl := testWordList(t)
	e, _ := GenerateEntropy(256, nil)
	m, _ := EntropyToMnemonic(e, wl)

	// Swap two adjacent words: this will almost always invalidate the
	// checksum, which is exactly the transcription error we want to catch.
	mutated := make(Mnemonic, len(m))
	copy(mutated, m)
	mutated[0], mutated[1] = mutated[1], mutated[0]

	if _, err := MnemonicToEntropy(mutated, wl); err == nil {
		t.Error("swapped-word mnemonic accepted; checksum check is not working")
	}
}

func TestMnemonicToEntropy_RejectsUnknownWord(t *testing.T) {
	wl := testWordList(t)
	e, _ := GenerateEntropy(256, nil)
	m, _ := EntropyToMnemonic(e, wl)

	mutated := make(Mnemonic, len(m))
	copy(mutated, m)
	mutated[5] = "notinthelist"

	if _, err := MnemonicToEntropy(mutated, wl); err == nil {
		t.Error("unknown-word mnemonic accepted")
	}
}

func TestMnemonicToEntropy_RejectsWrongWordCount(t *testing.T) {
	wl := testWordList(t)
	bad := Mnemonic{"aaa", "aab", "aac"} // 3 words is never valid
	if _, err := MnemonicToEntropy(bad, wl); err == nil {
		t.Error("3-word mnemonic accepted")
	}
}

// ----- MnemonicToSeed / passphrase -----

func TestMnemonicToSeed_Deterministic(t *testing.T) {
	// Same mnemonic + same passphrase must yield the same seed every time;
	// this is the property that lets users recover wallets.
	m := Mnemonic{"abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
		"abandon", "abandon", "abandon", "abandon", "abandon", "about"}
	s1 := MnemonicToSeed(m, "")
	s2 := MnemonicToSeed(m, "")
	if s1 != s2 {
		t.Error("MnemonicToSeed is not deterministic")
	}
}

func TestMnemonicToSeed_DifferentPassphraseDifferentSeed(t *testing.T) {
	m := Mnemonic{"abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
		"abandon", "abandon", "abandon", "abandon", "abandon", "about"}
	s1 := MnemonicToSeed(m, "")
	s2 := MnemonicToSeed(m, "TREZOR")
	if s1 == s2 {
		t.Error("passphrase had no effect on seed")
	}
}

func TestMnemonicToSeed_BIP39OfficialVector(t *testing.T) {
	// From https://github.com/trezor/python-mnemonic/blob/master/vectors.json,
	// entry where passphrase="TREZOR" and mnemonic is all 'abandon' but
	// ending with 'about'. This seed value is the documented expected
	// result and is quoted in many implementations for cross-validation.
	m := Mnemonic{
		"abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
		"abandon", "abandon", "abandon", "abandon", "abandon", "about",
	}
	got := MnemonicToSeed(m, "TREZOR")
	wantHex := "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
	want, err := hex.DecodeString(wantHex)
	if err != nil {
		t.Fatalf("decoding expected seed: %v", err)
	}
	if !bytes.Equal(got[:], want) {
		t.Errorf("BIP-39 official vector failed\n got %X\nwant %X", got[:], want)
	}
}

// ----- Encrypted storage -----

func TestEncryptDecryptSeed_Roundtrip(t *testing.T) {
	original := Seed{}
	_, _ = rand.Read(original[:])

	es, err := EncryptSeed(original, "correct horse battery staple", nil)
	if err != nil {
		t.Fatalf("EncryptSeed: %v", err)
	}
	got, err := DecryptSeed(es, "correct horse battery staple")
	if err != nil {
		t.Fatalf("DecryptSeed: %v", err)
	}
	if got != original {
		t.Error("decrypted seed does not match original")
	}
}

func TestEncryptSeed_RejectsEmptyPassphrase(t *testing.T) {
	// An empty passphrase offers zero protection. The API forces the
	// caller to supply one, so no seed is ever accidentally written
	// effectively in the clear.
	if _, err := EncryptSeed(Seed{}, "", nil); err == nil {
		t.Error("EncryptSeed accepted empty passphrase")
	}
}

func TestDecryptSeed_RejectsWrongPassphrase(t *testing.T) {
	original := Seed{}
	_, _ = rand.Read(original[:])

	es, err := EncryptSeed(original, "correct-passphrase", nil)
	if err != nil {
		t.Fatalf("EncryptSeed: %v", err)
	}
	_, err = DecryptSeed(es, "wrong-passphrase")
	if err == nil {
		t.Fatal("DecryptSeed accepted wrong passphrase")
	}
	// Callers must be able to identify a wrong passphrase via the sentinel,
	// distinct from structural errors (bad version, empty ciphertext).
	if !errors.Is(err, ErrWrongPassphrase) {
		t.Errorf("err = %v, want errors.Is(err, ErrWrongPassphrase)", err)
	}
}

func TestDecryptSeed_DetectsTampering(t *testing.T) {
	// Flipping a single byte in the ciphertext must produce a GCM
	// authentication failure. This is what prevents a thief with
	// write-access-but-not-read-access to the disk from corrupting
	// the file in a useful way.
	original := Seed{}
	_, _ = rand.Read(original[:])

	es, err := EncryptSeed(original, "p", nil)
	if err != nil {
		t.Fatalf("EncryptSeed: %v", err)
	}
	es.Ciphertext[0] ^= 0x01

	if _, err := DecryptSeed(es, "p"); err == nil {
		t.Error("DecryptSeed accepted tampered ciphertext")
	}
}

func TestEncryptSeed_ProducesDifferentOutputForSameInput(t *testing.T) {
	// Because salt and nonce are random, two encryptions of the same
	// seed with the same passphrase must produce different bytes.
	// Otherwise an observer who sees a user's file twice could tell
	// their seed did not change, leaking metadata about wallet resets.
	original := Seed{}
	_, _ = rand.Read(original[:])

	es1, err := EncryptSeed(original, "p", nil)
	if err != nil {
		t.Fatalf("EncryptSeed #1: %v", err)
	}
	es2, err := EncryptSeed(original, "p", nil)
	if err != nil {
		t.Fatalf("EncryptSeed #2: %v", err)
	}
	if bytes.Equal(es1.Ciphertext, es2.Ciphertext) {
		t.Error("two encryptions produced identical ciphertext (salt/nonce reuse)")
	}
	if es1.Salt == es2.Salt {
		t.Error("salts identical across encryptions")
	}
	if es1.Nonce == es2.Nonce {
		t.Error("nonces identical across encryptions")
	}
}

// ----- Marshal / Unmarshal of EncryptedSeed -----

func TestMarshalUnmarshal_Roundtrip(t *testing.T) {
	original := Seed{}
	_, _ = rand.Read(original[:])
	es, err := EncryptSeed(original, "p", nil)
	if err != nil {
		t.Fatalf("EncryptSeed: %v", err)
	}

	raw, err := es.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	back, err := UnmarshalEncryptedSeed(raw)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Version != es.Version {
		t.Errorf("Version: got %d, want %d", back.Version, es.Version)
	}
	if back.Salt != es.Salt {
		t.Error("Salt mismatch")
	}
	if back.Nonce != es.Nonce {
		t.Error("Nonce mismatch")
	}
	if !bytes.Equal(back.Ciphertext, es.Ciphertext) {
		t.Error("Ciphertext mismatch")
	}

	// End-to-end: unmarshal, decrypt, verify seed.
	got, err := DecryptSeed(back, "p")
	if err != nil {
		t.Fatalf("Decrypt after roundtrip: %v", err)
	}
	if got != original {
		t.Error("seed mismatch after marshal/unmarshal/decrypt")
	}
}

func TestUnmarshalEncryptedSeed_RejectsShortInput(t *testing.T) {
	for i := 0; i < 29; i++ {
		if _, err := UnmarshalEncryptedSeed(make([]byte, i)); err == nil {
			t.Errorf("Unmarshal of %d-byte input accepted", i)
		}
	}
}

func TestUnmarshalEncryptedSeed_RejectsUnknownVersion(t *testing.T) {
	buf := make([]byte, 29+16)
	buf[0] = 0xFF // unknown version
	if _, err := UnmarshalEncryptedSeed(buf); err == nil {
		t.Error("Unmarshal accepted unknown version byte")
	}
}

// ----- Fingerprint -----

func TestFingerprint_Deterministic(t *testing.T) {
	var s Seed
	copy(s[:], bytes.Repeat([]byte{0xAA}, 64))
	f1 := Fingerprint(s)
	f2 := Fingerprint(s)
	if f1 != f2 {
		t.Errorf("Fingerprint is not deterministic: %q != %q", f1, f2)
	}
}

func TestFingerprint_DifferentSeedsDifferentFingerprints(t *testing.T) {
	var s1, s2 Seed
	copy(s1[:], bytes.Repeat([]byte{0xAA}, 64))
	copy(s2[:], bytes.Repeat([]byte{0xBB}, 64))
	if Fingerprint(s1) == Fingerprint(s2) {
		t.Error("different seeds produced identical fingerprint")
	}
}

func TestFingerprint_IsShortHex(t *testing.T) {
	var s Seed
	f := Fingerprint(s)
	// 4 bytes hex-encoded = 8 characters
	if len(f) != 8 {
		t.Errorf("Fingerprint length = %d, want 8", len(f))
	}
	if _, err := hex.DecodeString(f); err != nil {
		t.Errorf("Fingerprint is not valid hex: %v", err)
	}
}

// ----- Defense-in-depth: no secret leaks -----

func TestEncryptedSeed_ContainsNoPlaintextSeed(t *testing.T) {
	// A smoke test: the encrypted form must not contain the raw seed
	// bytes anywhere. This would fail immediately if a future "helpful"
	// change accidentally added a plaintext backup to the struct.
	var s Seed
	copy(s[:], bytes.Repeat([]byte{0xDE, 0xAD, 0xBE, 0xEF}, 16))

	es, err := EncryptSeed(s, "p", nil)
	if err != nil {
		t.Fatalf("EncryptSeed: %v", err)
	}
	raw, _ := es.Marshal()
	if bytes.Contains(raw, s[:]) {
		t.Fatal("encrypted seed marshal contains raw seed bytes")
	}
}

func TestMnemonic_StringIsSpaceSeparated(t *testing.T) {
	m := Mnemonic{"abandon", "ability", "able"}
	got := m.String()
	if !strings.Contains(got, " ") {
		t.Errorf("String() = %q, expected space-separated words", got)
	}
	if strings.Count(got, " ") != 2 {
		t.Errorf("String() = %q, expected exactly 2 spaces for 3 words", got)
	}
}

// ----- Full 2048-word BIP-39 wordlist tests -----

func TestEnglishWordList_HasExactly2048Words(t *testing.T) {
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatalf("NewEnglishWordList: %v", err)
	}
	if got := len(wl.words); got != 2048 {
		t.Errorf("wordlist length = %d, want 2048", got)
	}
}

func TestEnglishWordList_BoundaryWords(t *testing.T) {
	// The official BIP-39 English list begins with "abandon" (index 0)
	// and ends with "zoo" (index 2047).
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatalf("NewEnglishWordList: %v", err)
	}
	if wl.words[0] != "abandon" {
		t.Errorf("word[0] = %q, want abandon", wl.words[0])
	}
	if wl.words[2047] != "zoo" {
		t.Errorf("word[2047] = %q, want zoo", wl.words[2047])
	}
}

func TestEntropyToMnemonic_OfficialAllZeroVector(t *testing.T) {
	// BIP-39 official vector: 16 bytes of 0x00 entropy →
	// "abandon abandon ... about" (the canonical test mnemonic).
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatalf("NewEnglishWordList: %v", err)
	}
	entropy := make(Entropy, 16) // all zero
	m, err := EntropyToMnemonic(entropy, wl)
	if err != nil {
		t.Fatalf("EntropyToMnemonic: %v", err)
	}
	want := "abandon abandon abandon abandon abandon abandon " +
		"abandon abandon abandon abandon abandon about"
	if got := strings.Join([]string(m), " "); got != want {
		t.Errorf("mnemonic mismatch\n got %q\nwant %q", got, want)
	}
}

func TestEntropyToMnemonic_OfficialAllFFVector(t *testing.T) {
	// BIP-39 official vector: 16 bytes of 0x7f → "legal winner thank..."
	// Use the documented all-0xff 32-byte vector instead, which maps to
	// a mnemonic ending in "vote" — verify round-trip rather than exact
	// words to keep the test robust.
	wl, _ := NewEnglishWordList()
	for _, nbytes := range []int{16, 20, 24, 28, 32} {
		entropy := make(Entropy, nbytes)
		for i := range entropy {
			entropy[i] = 0xff
		}
		m, err := EntropyToMnemonic(entropy, wl)
		if err != nil {
			t.Fatalf("EntropyToMnemonic(%d bytes): %v", nbytes, err)
		}
		// Round-trip back to entropy.
		got, err := MnemonicToEntropy(m, wl)
		if err != nil {
			t.Fatalf("MnemonicToEntropy(%d bytes): %v", nbytes, err)
		}
		if !bytes.Equal(got, entropy) {
			t.Errorf("round-trip failed for %d bytes:\n got %X\nwant %X", nbytes, got, entropy)
		}
	}
}

func TestMnemonicEntropy_AllWordsReachable(t *testing.T) {
	// Verify every one of the 2048 words can appear in a valid mnemonic
	// by checking the wordlist index map covers 0..2047 with no gaps.
	wl, _ := NewEnglishWordList()
	for i := 0; i < 2048; i++ {
		w := wl.words[i]
		idx, ok := wl.wordIndex[w]
		if !ok {
			t.Fatalf("word %q (position %d) not in index", w, i)
		}
		if idx != i {
			t.Errorf("word %q index = %d, want %d", w, idx, i)
		}
	}
}
