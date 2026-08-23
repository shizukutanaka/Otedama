// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package lightning

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// testWordList returns a synthetic 2048-word list for testing.
func testWL(t *testing.T) *WordList {
	t.Helper()
	words := make([]string, 2048)
	for i := range words {
		words[i] = wordAt(i)
	}
	wl, err := NewWordList(words)
	if err != nil {
		t.Fatalf("testWL: %v", err)
	}
	return wl
}

func wordAt(i int) string {
	const alpha = "abcdefghijklmnopqrstuvwxyz"
	return string(alpha[(i/676)%26]) + string(alpha[(i/26)%26]) + string(alpha[i%26])
}

// deterministicReader returns the same byte sequence every time.
func deterministicReader(seed byte) *bytes.Reader {
	b := make([]byte, 512)
	for i := range b {
		b[i] = seed + byte(i)
	}
	return bytes.NewReader(b)
}

// ----- NewWalletManager — first run -----

func TestWalletManager_FirstRun_CreatesFile(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)
	// Use a large deterministic reader (seed + encrypt both need bytes).
	r := deterministicReader(0xAB)

	wm, err := NewWalletManager(dir, "correct-passphrase", r, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}

	// wallet.dat must exist.
	if _, err := os.Stat(filepath.Join(dir, walletFile)); err != nil {
		t.Errorf("wallet.dat not created: %v", err)
	}

	// IsNew must be true on first run.
	if !wm.IsNew() {
		t.Error("IsNew() = false on first run")
	}

	// Mnemonic must be returned so the user can back it up.
	if len(wm.Mnemonic()) == 0 {
		t.Error("Mnemonic() returned empty on first run")
	}

	// Seed must be non-zero.
	var zero Seed
	if wm.Seed() == zero {
		t.Error("Seed() is zero")
	}
}

func TestWalletManager_FirstRun_FingerprintConsistent(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)
	r := deterministicReader(0xCD)

	wm, err := NewWalletManager(dir, "p", r, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}

	fp := wm.Fingerprint()
	if len(fp) != 8 {
		t.Errorf("Fingerprint length = %d, want 8", len(fp))
	}
	// Calling Fingerprint again must return the same value.
	if wm.Fingerprint() != fp {
		t.Error("Fingerprint() is not idempotent")
	}
}

// ----- NewWalletManager — reload -----

func TestWalletManager_Reload_ReturnsSameSeed(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)

	// Create wallet.
	r1 := deterministicReader(0x01)
	wm1, err := NewWalletManager(dir, "my-passphrase", r1, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	seed1 := wm1.Seed()

	// Reload wallet.
	r2 := deterministicReader(0xFF) // different reader, should not matter
	wm2, err := NewWalletManager(dir, "my-passphrase", r2, wl)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	seed2 := wm2.Seed()

	if seed1 != seed2 {
		t.Error("reloaded seed differs from original seed")
	}

	// IsNew must be false on reload.
	if wm2.IsNew() {
		t.Error("IsNew() = true on reload")
	}

	// Mnemonic() must be nil on reload (already backed up previously).
	if wm2.Mnemonic() != nil {
		t.Error("Mnemonic() non-nil on reload; should only be set on first run")
	}
}

// ----- WithMnemonicPassphrase (BIP-39 "25th word") -----
//
// docs/RESEARCH_IMPROVEMENTS.md Category 3 #5 flagged this as unverified:
// MnemonicToSeed already accepted an optional passphrase, but the only
// caller (createNew) hardcoded "" — the capability existed but was
// unreachable. These tests pin the fix: the option changes the derived
// seed, every pre-existing (no-option) call keeps its original behavior,
// and the passphrase only matters at creation (it's baked into the stored
// seed, not needed again on reload).

func TestNewWalletManager_WithMnemonicPassphrase_ChangesDerivedSeed(t *testing.T) {
	wl := testWL(t)
	const entropySeed = 0x42 // same byte for both readers: identical entropy/mnemonic

	dirPlain := t.TempDir()
	wmPlain, err := NewWalletManager(dirPlain, "unlock-pass", deterministicReader(entropySeed), wl)
	if err != nil {
		t.Fatalf("create (no mnemonic passphrase): %v", err)
	}

	dirWithPass := t.TempDir()
	wmWithPass, err := NewWalletManager(dirWithPass, "unlock-pass", deterministicReader(entropySeed), wl,
		WithMnemonicPassphrase("my 25th word"))
	if err != nil {
		t.Fatalf("create (with mnemonic passphrase): %v", err)
	}

	// Same entropy reader byte -> same mnemonic -> but the passphrase must
	// still produce a different derived seed (the whole point of the
	// BIP-39 25th-word feature).
	if wmPlain.Mnemonic().String() != wmWithPass.Mnemonic().String() {
		t.Fatalf("test setup invalid: mnemonics differ (%q vs %q); entropy readers were not equivalent",
			wmPlain.Mnemonic().String(), wmWithPass.Mnemonic().String())
	}
	if wmPlain.Seed() == wmWithPass.Seed() {
		t.Error("Seed() identical with and without WithMnemonicPassphrase; option had no effect")
	}
}

func TestNewWalletManager_WithMnemonicPassphrase_MatchesDirectMnemonicToSeed(t *testing.T) {
	// The derived seed must be exactly MnemonicToSeed(mnemonic, passphrase)
	// — not some other transformation — so recovery tooling that knows the
	// mnemonic and the 25th word can reproduce the seed independently.
	wl := testWL(t)
	dir := t.TempDir()
	const mnemonicPassphrase = "correct horse battery staple"

	wm, err := NewWalletManager(dir, "unlock-pass", deterministicReader(0x77), wl,
		WithMnemonicPassphrase(mnemonicPassphrase))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	want := MnemonicToSeed(wm.Mnemonic(), mnemonicPassphrase)
	if wm.Seed() != want {
		t.Error("Seed() does not match MnemonicToSeed(mnemonic, mnemonicPassphrase)")
	}
}

func TestNewWalletManager_NoMnemonicPassphraseOption_MatchesEmptyPassphraseDerivation(t *testing.T) {
	// Omitting WithMnemonicPassphrase must be identical to explicitly
	// passing WithMnemonicPassphrase("") — the empty-string default that
	// every pre-existing caller of NewWalletManager relies on.
	wl := testWL(t)
	const entropySeed = 0x99

	dirImplicit := t.TempDir()
	wmImplicit, err := NewWalletManager(dirImplicit, "p", deterministicReader(entropySeed), wl)
	if err != nil {
		t.Fatalf("create (implicit empty): %v", err)
	}

	dirExplicit := t.TempDir()
	wmExplicit, err := NewWalletManager(dirExplicit, "p", deterministicReader(entropySeed), wl,
		WithMnemonicPassphrase(""))
	if err != nil {
		t.Fatalf("create (explicit empty): %v", err)
	}

	if wmImplicit.Seed() != wmExplicit.Seed() {
		t.Error("omitting WithMnemonicPassphrase differs from WithMnemonicPassphrase(\"\")")
	}
}

func TestNewWalletManager_MnemonicPassphrase_NotNeededOnReload(t *testing.T) {
	// The mnemonic passphrase is folded into the seed at creation time and
	// only the resulting Seed (never the mnemonic) is persisted to
	// wallet.dat, so reloading WITHOUT the option must still recover the
	// exact same seed that was derived WITH it at creation.
	wl := testWL(t)
	dir := t.TempDir()

	wmCreate, err := NewWalletManager(dir, "unlock-pass", deterministicReader(0x55), wl,
		WithMnemonicPassphrase("recovery-only secret"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	originalSeed := wmCreate.Seed()

	// Reload with no WithMnemonicPassphrase option at all.
	wmReload, err := NewWalletManager(dir, "unlock-pass", deterministicReader(0xAA), wl)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}

	if wmReload.Seed() != originalSeed {
		t.Error("reload without WithMnemonicPassphrase produced a different seed than creation with it")
	}
}

// ----- Wrong passphrase -----

func TestWalletManager_WrongPassphrase(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)
	r := deterministicReader(0x22)

	if _, err := NewWalletManager(dir, "correct", r, wl); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Reload with wrong passphrase.
	_, err := NewWalletManager(dir, "wrong", deterministicReader(0x33), wl)
	if err == nil {
		t.Fatal("wrong passphrase accepted")
	}
}

// ----- Atomic write -----

func TestWalletManager_WalletFileHasRestrictivePermissions(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root user ignores file permissions")
	}
	dir := t.TempDir()
	wl := testWL(t)
	r := deterministicReader(0x44)

	if _, err := NewWalletManager(dir, "p", r, wl); err != nil {
		t.Fatalf("create: %v", err)
	}

	info, err := os.Stat(filepath.Join(dir, walletFile))
	if err != nil {
		t.Fatalf("stat wallet.dat: %v", err)
	}
	// Owner read/write only (0600); no group or other access.
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("wallet.dat permissions = %04o, want 0600", perm)
	}
}

// ----- ChangePassphrase -----

func TestWalletManager_ChangePassphrase(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)
	r := deterministicReader(0x55)

	wm, err := NewWalletManager(dir, "old-pass", r, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	origSeed := wm.Seed()

	// Change passphrase.
	if err := wm.ChangePassphrase("old-pass", "new-pass", deterministicReader(0x66)); err != nil {
		t.Fatalf("ChangePassphrase: %v", err)
	}

	// Old passphrase must no longer work.
	if _, err := NewWalletManager(dir, "old-pass", deterministicReader(0x77), wl); err == nil {
		t.Error("old passphrase still accepted after change")
	}

	// New passphrase must work and return the same seed.
	wm2, err := NewWalletManager(dir, "new-pass", deterministicReader(0x88), wl)
	if err != nil {
		t.Fatalf("reload with new passphrase: %v", err)
	}
	if wm2.Seed() != origSeed {
		t.Error("seed changed after passphrase change")
	}
}

func TestWalletManager_ChangePassphrase_WrongOld(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)
	r := deterministicReader(0x99)

	wm, err := NewWalletManager(dir, "correct", r, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := wm.ChangePassphrase("wrong", "new", deterministicReader(0xAA)); err == nil {
		t.Error("ChangePassphrase accepted wrong old passphrase")
	}
}

func TestWalletManager_ChangePassphrase_EmptyNew(t *testing.T) {
	dir := t.TempDir()
	wl := testWL(t)
	r := deterministicReader(0xBB)

	wm, err := NewWalletManager(dir, "p", r, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := wm.ChangePassphrase("p", "", nil); err == nil {
		t.Error("ChangePassphrase accepted empty new passphrase")
	}
}

// ----- Validation -----

func TestNewWalletManager_RejectsEmptyDataDir(t *testing.T) {
	if _, err := NewWalletManager("", "p", nil, testWL(t)); err == nil {
		t.Error("empty dataDir accepted")
	}
}

func TestNewWalletManager_RejectsEmptyPassphrase(t *testing.T) {
	if _, err := NewWalletManager(t.TempDir(), "", nil, testWL(t)); err == nil {
		t.Error("empty passphrase accepted")
	}
}

func TestNewWalletManager_RejectsNilWordList(t *testing.T) {
	if _, err := NewWalletManager(t.TempDir(), "p", nil, nil); err == nil {
		t.Error("nil WordList accepted")
	}
}
