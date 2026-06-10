// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package lightning

import (
	"os"
	"path/filepath"
	"testing"
)

// failAfterNReader satisfies io.Reader and returns an error once N bytes
// have been consumed. Used to trigger io.ReadFull errors without touching
// real entropy or crypto.
type failAfterNReader struct{ remaining int }

func (r *failAfterNReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, errExhausted
	}
	n := len(p)
	if n > r.remaining {
		n = r.remaining
	}
	for i := 0; i < n; i++ {
		p[i] = byte(i % 256)
	}
	r.remaining -= n
	return n, nil
}

// errExhausted is a sentinel error for failAfterNReader.
var errExhausted = errMsg("failAfterNReader: exhausted")

type errMsg string

func (e errMsg) Error() string { return string(e) }

// ============================================================================
// Entropy.Validate — invalid length branch
// ============================================================================

func TestValidate_RejectsInvalidEntropyLength(t *testing.T) {
	e := Entropy([]byte{1, 2, 3}) // 24 bits — not in validEntropyBits
	if err := e.Validate(); err == nil {
		t.Error("Validate: expected error for 24-bit entropy")
	}
}

// ============================================================================
// NewWordList — invalid UTF-8 word branch
// ============================================================================

func TestNewWordList_RejectsInvalidUTF8Word(t *testing.T) {
	words := make([]string, 2048)
	for i := range words {
		words[i] = fmtWord(i) // fmtWord defined in seed_test.go
	}
	words[500] = string([]byte{0xFF, 0xFE}) // invalid UTF-8 sequence
	if _, err := NewWordList(words); err == nil {
		t.Error("NewWordList: expected error for invalid UTF-8 word")
	}
}

// ============================================================================
// WordList.Word — out-of-bounds index branch
// ============================================================================

func TestWord_RejectsOutOfBoundsIndex(t *testing.T) {
	wl := testWordList(t) // testWordList defined in seed_test.go
	if _, err := wl.Word(2048); err == nil {
		t.Error("Word(2048): expected error")
	}
	if _, err := wl.Word(-1); err == nil {
		t.Error("Word(-1): expected error")
	}
}

// ============================================================================
// EntropyToMnemonic — nil wordlist and invalid entropy branches
// ============================================================================

func TestEntropyToMnemonic_NilWordList(t *testing.T) {
	e, _ := GenerateEntropy(256, nil)
	if _, err := EntropyToMnemonic(e, nil); err == nil {
		t.Error("EntropyToMnemonic: expected error for nil wordlist")
	}
}

func TestEntropyToMnemonic_InvalidEntropy(t *testing.T) {
	wl := testWordList(t)
	e := Entropy([]byte{1, 2, 3}) // 24 bits — invalid
	if _, err := EntropyToMnemonic(e, wl); err == nil {
		t.Error("EntropyToMnemonic: expected error for invalid entropy length")
	}
}

// ============================================================================
// MnemonicToEntropy — nil wordlist branch
// ============================================================================

func TestMnemonicToEntropy_NilWordList(t *testing.T) {
	m := Mnemonic{"abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
		"abandon", "abandon", "abandon", "abandon", "abandon", "about"}
	if _, err := MnemonicToEntropy(m, nil); err == nil {
		t.Error("MnemonicToEntropy: expected error for nil wordlist")
	}
}

// ============================================================================
// DecryptSeed — wrong version and empty ciphertext branches
// ============================================================================

func TestDecryptSeed_RejectsWrongVersion(t *testing.T) {
	es := EncryptedSeed{
		Version:    0xFF,
		Ciphertext: []byte{1, 2, 3},
	}
	if _, err := DecryptSeed(es, "p"); err == nil {
		t.Error("DecryptSeed: expected error for unknown version")
	}
}

func TestDecryptSeed_RejectsEmptyCiphertext(t *testing.T) {
	es := EncryptedSeed{
		Version:    currentEncryptedSeedVersion,
		Ciphertext: nil,
	}
	if _, err := DecryptSeed(es, "p"); err == nil {
		t.Error("DecryptSeed: expected error for empty ciphertext")
	}
}

// ============================================================================
// Marshal — wrong version branch
// ============================================================================

func TestMarshal_RejectsWrongVersion(t *testing.T) {
	es := EncryptedSeed{Version: 0x02}
	if _, err := es.Marshal(); err == nil {
		t.Error("Marshal: expected error for unknown version")
	}
}

// ============================================================================
// EncryptSeed — salt and nonce read-error branches
// These fail BEFORE scrypt is called, so they run instantly.
// ============================================================================

func TestEncryptSeed_SaltReadError(t *testing.T) {
	var s Seed
	// 0-byte reader: first ReadFull (16-byte salt) fails immediately.
	if _, err := EncryptSeed(s, "passphrase", &failAfterNReader{remaining: 0}); err == nil {
		t.Error("EncryptSeed: expected error when salt read fails")
	}
}

func TestEncryptSeed_NonceReadError(t *testing.T) {
	var s Seed
	// 16-byte reader: salt read succeeds, nonce read (12 bytes) fails.
	if _, err := EncryptSeed(s, "passphrase", &failAfterNReader{remaining: 16}); err == nil {
		t.Error("EncryptSeed: expected error when nonce read fails")
	}
}

// ============================================================================
// NewWalletManager — os.MkdirAll error branch (blocking-file trick)
// ============================================================================

func TestNewWalletManager_MkdirAllError(t *testing.T) {
	home := t.TempDir()
	// Create a FILE where a sub-directory must be created; MkdirAll fails.
	blockingFile := filepath.Join(home, "sub")
	if err := os.WriteFile(blockingFile, []byte("x"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	wl, _ := NewEnglishWordList()
	// dataDir = home/sub/wallet — MkdirAll tries to create home/sub as a dir
	// but home/sub is a file, so it returns an error.
	dataDir := filepath.Join(home, "sub", "wallet")
	if _, err := NewWalletManager(dataDir, "pass", nil, wl); err == nil {
		t.Error("NewWalletManager: expected error when MkdirAll fails")
	}
}

// ============================================================================
// createNew — EncryptSeed failure branch (fast: fails before scrypt)
//
// A 32-byte reader provides just enough for GenerateEntropy (32 bytes).
// When save→EncryptSeed tries to read 16 bytes for the salt, the reader
// is exhausted and returns an error — scrypt is never called.
// ============================================================================

func TestCreateNew_EncryptSeedError(t *testing.T) {
	dir := t.TempDir()
	wm := &WalletManager{dataDir: dir, wordList: testWL(t)} // testWL from wallet_test.go
	r := &failAfterNReader{remaining: 32}
	if err := wm.createNew("passphrase", r); err == nil {
		t.Error("createNew: expected error when EncryptSeed reader is exhausted")
	}
}

// ============================================================================
// save — os.CreateTemp failure branch
//
// EncryptSeed must succeed (real crypto, ~1 s) so that we reach
// os.CreateTemp. A nonexistent dataDir causes CreateTemp to fail.
// ============================================================================

func TestSave_CreateTempError(t *testing.T) {
	// Point to a path that does not exist so CreateTemp returns an error.
	wm := &WalletManager{dataDir: filepath.Join(t.TempDir(), "no-such-dir")}
	var s Seed
	if err := wm.save(s, "test-passphrase", nil); err == nil {
		t.Error("save: expected error when dataDir does not exist")
	}
}

// ============================================================================
// ChangePassphrase — UnmarshalEncryptedSeed error branch
// ============================================================================

func TestChangePassphrase_UnmarshalError(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()
	wm, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Write garbage shorter than the 29-byte minimum so UnmarshalEncryptedSeed fails.
	if err := os.WriteFile(filepath.Join(dir, walletFile), []byte("bad"), 0600); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
	if err := wm.ChangePassphrase("pass", "new", nil); err == nil {
		t.Error("ChangePassphrase: expected error when wallet file is corrupt")
	}
}
