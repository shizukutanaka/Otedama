// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package lightning

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
// seed, every pre-existing (no-option) call keeps its original behaviour,
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
	if perm := info.Mode().Perm(); perm != 0600 {
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

// ============================================================================
// Non-portable BIP-39 passphrase rejection (session 264, resolves
// docs/KNOWN_LIMITATIONS.md §19)
// ============================================================================

// TestCreateNew_RejectsNonASCIIMnemonicPassphrase pins the decision to refuse
// input Otedama cannot derive conformantly. Without it, the recovery phrase
// printed at creation would silently restore a *different* wallet in any
// other BIP-39 tool — a failure no other wallet can detect, because it has no
// way to know it derived the wrong seed.
func TestCreateNew_RejectsNonASCIIMnemonicPassphrase(t *testing.T) {
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name       string
		passphrase string
	}{
		{"precomposed latin", "caf\u00e9"},
		{"katakana", "\u30d1\u30b9\u30ef\u30fc\u30c9"},
		{"emoji", "correct horse \U0001f434"},
		{"non-breaking space", "two\u00a0words"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			_, err := NewWalletManager(dir, "encryption passphrase", nil, wl,
				WithMnemonicPassphrase(tc.passphrase))
			if err == nil {
				t.Fatal("wallet creation accepted a non-ASCII BIP-39 passphrase")
			}
			if !errors.Is(err, ErrNonPortablePassphrase) {
				t.Errorf("err = %v, want ErrNonPortablePassphrase", err)
			}
			// The rejection must happen before anything is written: a
			// half-created wallet would be worse than either outcome.
			if _, statErr := os.Stat(filepath.Join(dir, walletFile)); !os.IsNotExist(statErr) {
				t.Error("a wallet file was written despite the rejection")
			}
		})
	}
}

// TestCreateNew_AcceptsASCIIAndEmptyMnemonicPassphrase is the other half: NFKD
// is the identity on ASCII, so these are exactly the inputs Otedama derives
// conformantly, and the check must not narrow further than that. The empty
// passphrase is the common case and must keep working.
func TestCreateNew_AcceptsASCIIAndEmptyMnemonicPassphrase(t *testing.T) {
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatal(err)
	}
	for _, passphrase := range []string{"", "correct horse battery staple", "~!@#$%^&*()_+ 123"} {
		wm, err := NewWalletManager(t.TempDir(), "encryption passphrase", nil, wl,
			WithMnemonicPassphrase(passphrase))
		if err != nil {
			t.Errorf("passphrase %q rejected: %v", passphrase, err)
			continue
		}
		if !wm.IsNew() {
			t.Errorf("passphrase %q: expected a newly created wallet", passphrase)
		}
	}
}

// TestLoadExisting_IgnoresTheMnemonicPassphraseEntirely is why rejecting at
// creation cannot lock anyone out. A wallet created before this check existed
// with a non-ASCII passphrase must keep opening, because loading decrypts the
// stored seed and never re-derives it. The test builds that situation the only
// way still possible — create with an ASCII passphrase, then reopen passing a
// non-ASCII one — and asserts the option is not consulted on the load path.
func TestLoadExisting_IgnoresTheMnemonicPassphraseEntirely(t *testing.T) {
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	created, err := NewWalletManager(dir, "encryption passphrase", nil, wl,
		WithMnemonicPassphrase("ascii at creation"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	want := created.Fingerprint()

	reopened, err := NewWalletManager(dir, "encryption passphrase", nil, wl,
		WithMnemonicPassphrase("\u30d1\u30b9\u30ef\u30fc\u30c9"))
	if err != nil {
		t.Fatalf("reopening an existing wallet must not consult the mnemonic passphrase, got: %v", err)
	}
	if got := reopened.Fingerprint(); got != want {
		t.Errorf("fingerprint after reopen = %s, want %s", got, want)
	}
	if reopened.IsNew() {
		t.Error("reopening reported a new wallet")
	}
}

// TestCheckMnemonicPassphraseIsPortable_ErrorNamesTheOffendingCharacter keeps
// the message actionable: a user who pasted a passphrase with one invisible
// non-ASCII character (a non-breaking space from a web page is the usual way)
// needs to be told which character and where, not merely "not ASCII".
func TestCheckMnemonicPassphraseIsPortable_ErrorNamesTheOffendingCharacter(t *testing.T) {
	err := checkMnemonicPassphraseIsPortable("two\u00a0words")
	if err == nil {
		t.Fatal("expected an error")
	}
	msg := err.Error()
	for _, want := range []string{"\\u00a0", "byte 3", "NFKD", "§19"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention %q", msg, want)
		}
	}
}
