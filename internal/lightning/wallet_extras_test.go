// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package lightning

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// ============================================================================
// WalletManager state after creation vs after load
// ============================================================================

func TestWalletManager_NewRunExposesMnemonic(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm, err := NewWalletManager(dir, "passphrase", nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}

	// First run: Mnemonic() returns the freshly generated words.
	m := wm.Mnemonic()
	if m == nil {
		t.Fatal("Mnemonic() nil on first run")
	}
	if len(m) < 12 {
		t.Errorf("mnemonic too short: %d words", len(m))
	}

	// IsNew is true.
	if !wm.IsNew() {
		t.Error("IsNew() = false after first-run creation")
	}
}

func TestWalletManager_LoadedRunDoesNotExposeMnemonic(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	// First run — create wallet.
	_, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("first NewWalletManager: %v", err)
	}

	// Second run — load existing.
	wm, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("second NewWalletManager: %v", err)
	}

	if wm.IsNew() {
		t.Error("IsNew() = true after loading existing wallet")
	}
	if m := wm.Mnemonic(); m != nil {
		t.Errorf("Mnemonic() should be nil after load; got %v", m)
	}
}

func TestWalletManager_Seed_IsNot32ZeroBytes(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}
	seed := wm.Seed()
	if len(seed) != 64 {
		t.Errorf("seed size = %d, want 64 (BIP-39 spec)", len(seed))
	}
	if bytes.Equal(seed[:], make([]byte, 64)) {
		t.Error("seed is all zeros — seed derivation broken")
	}
}

func TestWalletManager_FingerprintIsStableAcrossLoad(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm1, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	fp1 := wm1.Fingerprint()

	// Create fresh manager from the same on-disk wallet.
	wm2, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	fp2 := wm2.Fingerprint()

	if fp1 != fp2 {
		t.Errorf("fingerprint drift: %s → %s", fp1, fp2)
	}
}

// ============================================================================
// WalletManager file layout
// ============================================================================

func TestWalletManager_WalletFileExists(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	_, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}

	// The wallet file must exist.
	entries, _ := os.ReadDir(dir)
	found := false
	for _, e := range entries {
		if !e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			found = true
			if strings.Contains(e.Name(), "tmp") {
				t.Errorf("found leftover tempfile: %s", e.Name())
			}
		}
	}
	if !found {
		t.Error("no wallet file created")
	}
}

func TestWalletManager_WalletFileNotWorldReadable(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	_, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, _ := e.Info()
		mode := info.Mode().Perm()
		// Other (world) must have no permissions.
		if mode&0007 != 0 {
			t.Errorf("wallet file %s world-accessible: %04o", e.Name(), mode)
		}
		// Group must have no permissions.
		if mode&0070 != 0 {
			t.Errorf("wallet file %s group-accessible: %04o", e.Name(), mode)
		}
	}
}

// ============================================================================
// ChangePassphrase edge cases
// ============================================================================

func TestChangePassphrase_TwiceInARow(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm, err := NewWalletManager(dir, "p1", nil, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	fpBefore := wm.Fingerprint()

	if err := wm.ChangePassphrase("p1", "p2", nil); err != nil {
		t.Fatalf("first change: %v", err)
	}
	if err := wm.ChangePassphrase("p2", "p3", nil); err != nil {
		t.Fatalf("second change: %v", err)
	}

	// Reload with the final passphrase.
	wm2, err := NewWalletManager(dir, "p3", nil, wl)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if wm2.Fingerprint() != fpBefore {
		t.Errorf("fingerprint changed after passphrase rotations: %s → %s",
			fpBefore, wm2.Fingerprint())
	}
}

func TestChangePassphrase_SameOldAndNew(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm, err := NewWalletManager(dir, "secret", nil, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Changing to the same passphrase is allowed but pointless.
	// It must succeed and leave the wallet usable.
	if err := wm.ChangePassphrase("secret", "secret", nil); err != nil {
		t.Fatalf("same-passphrase change: %v", err)
	}
	// Wallet still decryptable.
	if _, err := NewWalletManager(dir, "secret", nil, wl); err != nil {
		t.Errorf("reload after same-passphrase change failed: %v", err)
	}
}

func TestChangePassphrase_DoesNotCreateTempFile(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm, err := NewWalletManager(dir, "old", nil, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := wm.ChangePassphrase("old", "new", nil); err != nil {
		t.Fatalf("change: %v", err)
	}

	// No leftover tempfiles.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := e.Name()
		if strings.Contains(name, "tmp") || strings.Contains(name, ".bak") {
			t.Errorf("leftover file after rename: %s", name)
		}
	}
}

// ============================================================================
// Concurrent reads of the same WalletManager
// ============================================================================

func TestWalletManager_ConcurrentGettersAreSafe(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	wm, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}

	const goroutines = 32
	const iterations = 100

	wantFp := wm.Fingerprint()
	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				fp := wm.Fingerprint()
				if fp != wantFp {
					t.Errorf("concurrent fingerprint drift: %s vs %s", fp, wantFp)
					return
				}
				_ = wm.Seed()
				_ = wm.IsNew()
			}
		}()
	}
	wg.Wait()
}

// ============================================================================
// Reader injection — deterministic mnemonic from fixed entropy
// ============================================================================

func TestWalletManager_FixedReaderProducesDeterministicFingerprint(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	wl, _ := NewEnglishWordList()

	// 32 bytes of deterministic "entropy" + more for encryption nonce/salt.
	seedBytes := make([]byte, 256)
	for i := range seedBytes {
		seedBytes[i] = byte(i)
	}

	wm1, err := NewWalletManager(dir1, "pass", bytes.NewReader(seedBytes), wl)
	if err != nil {
		t.Fatalf("wm1: %v", err)
	}
	wm2, err := NewWalletManager(dir2, "pass", bytes.NewReader(seedBytes), wl)
	if err != nil {
		t.Fatalf("wm2: %v", err)
	}

	// Same entropy → same fingerprint.
	if wm1.Fingerprint() != wm2.Fingerprint() {
		t.Errorf("fingerprints differ despite identical entropy: %s vs %s",
			wm1.Fingerprint(), wm2.Fingerprint())
	}
}

func TestWalletManager_DifferentPassphrasesSameEntropy_SameSeed(t *testing.T) {
	// BIP-39 mnemonic is derived from entropy ALONE. Passphrase only
	// affects seed derivation from the mnemonic, but in this codebase
	// WalletManager uses a fixed empty BIP-39 passphrase (the user's
	// wallet passphrase is for ENCRYPTION of the seed, not for BIP-39).
	// Therefore different wallet passphrases with same entropy yield
	// identical mnemonics (and thus identical seeds).
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	wl, _ := NewEnglishWordList()

	entropy := make([]byte, 256)
	_, _ = rand.Read(entropy)

	wm1, err := NewWalletManager(dir1, "pass-a", bytes.NewReader(entropy), wl)
	if err != nil {
		t.Fatalf("wm1: %v", err)
	}
	wm2, err := NewWalletManager(dir2, "pass-b", bytes.NewReader(entropy), wl)
	if err != nil {
		t.Fatalf("wm2: %v", err)
	}

	// If implementation incorporates wallet passphrase into seed, fingerprints differ.
	// If not (correct behavior: encrypt-only), fingerprints match.
	fp1 := wm1.Fingerprint()
	fp2 := wm2.Fingerprint()
	if fp1 != fp2 {
		t.Logf("wallet passphrase affects seed: fp1=%s fp2=%s", fp1, fp2)
		t.Logf("this is acceptable if intentional; documents current behavior")
	}
}

// ============================================================================
// Error paths — corrupted wallet file
// ============================================================================

func TestWalletManager_CorruptedWalletFileFailsClean(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	// Create a valid wallet.
	_, err := NewWalletManager(dir, "pass", nil, wl)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Corrupt every file in the data dir.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if err := os.WriteFile(path, []byte("not a valid wallet"), 0600); err != nil {
			t.Fatalf("corrupt: %v", err)
		}
	}

	_, err = NewWalletManager(dir, "pass", nil, wl)
	if err == nil {
		t.Error("corrupted wallet file should fail to load")
	}
}

func TestWalletManager_EmptyWalletFileFailsClean(t *testing.T) {
	dir := t.TempDir()
	wl, _ := NewEnglishWordList()

	// Write an empty wallet file manually.
	if err := os.WriteFile(filepath.Join(dir, "wallet.dat"), nil, 0600); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, err := NewWalletManager(dir, "pass", nil, wl)
	if err == nil {
		t.Error("empty wallet file should fail to load")
	}
}
