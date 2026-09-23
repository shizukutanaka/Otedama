// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/lightning"
)

// newTestWallet creates a real wallet in a fresh data dir and returns
// the dir, the mnemonic shown on first run, and the fingerprint.
func newTestWallet(t *testing.T, passphrase string) (dataDir, mnemonic, fingerprint string) {
	t.Helper()
	dataDir = t.TempDir()
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("wordlist: %v", err)
	}
	wm, err := lightning.NewWalletManager(dataDir, passphrase, nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}
	mnemonic = wm.Mnemonic().String()
	fingerprint = wm.Fingerprint()
	return dataDir, mnemonic, fingerprint
}

func runVerify(t *testing.T, args []string, stdin string) (code int, out, errOut string) {
	t.Helper()
	var o, e bytes.Buffer
	code = cmdWalletVerify(args, &o, &e, strings.NewReader(stdin))
	return code, o.String(), e.String()
}

// ----- otedama wallet verify -----

func TestWalletVerify_Match(t *testing.T) {
	dir, mnemonic, fp := newTestWallet(t, "old-pass")
	code, out, errOut := runVerify(t, []string{"--data-dir", dir}, mnemonic+"\n")
	if code != exitOK {
		t.Fatalf("verify exit = %d, want %d (stderr: %s)", code, exitOK, errOut)
	}
	if !strings.Contains(out, fp) || !strings.Contains(out, "MATCHES") {
		t.Errorf("stdout = %q, want MATCHES with fingerprint %s", out, fp)
	}
}

// One word per line (interactive-style input) must work as well as the
// space-separated form.
func TestWalletVerify_Match_MultilineInput(t *testing.T) {
	dir, mnemonic, _ := newTestWallet(t, "old-pass")
	code, _, errOut := runVerify(t, []string{"--data-dir", dir},
		strings.ReplaceAll(mnemonic, " ", "\n")+"\n")
	if code != exitOK {
		t.Fatalf("verify exit = %d, want %d (stderr: %s)", code, exitOK, errOut)
	}
}

func TestWalletVerify_Mismatch(t *testing.T) {
	dir, _, _ := newTestWallet(t, "old-pass")
	// A different wallet's valid mnemonic must NOT match.
	_, otherMnemonic, _ := newTestWallet(t, "x")
	code, _, errOut := runVerify(t, []string{"--data-dir", dir}, otherMnemonic+"\n")
	if code != exitRuntime {
		t.Fatalf("verify exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(errOut, "does NOT match") {
		t.Errorf("stderr = %q, want mismatch message", errOut)
	}
}

// A transcription typo is caught by the BIP-39 checksum before any
// fingerprint comparison — the error should name the problem.
func TestWalletVerify_TypoCaughtByChecksum(t *testing.T) {
	dir, mnemonic, _ := newTestWallet(t, "old-pass")
	words := strings.Fields(mnemonic)
	// Flip the first word to a different valid BIP-39 word. Pick a
	// replacement that deterministically fails the checksum — a swap
	// that still passes (≈1/256 by construction) is a real BIP-39
	// property, so asserting on it would make this test flaky.
	wl, _ := lightning.NewEnglishWordList()
	m := lightning.Mnemonic(words)
	if _, err := lightning.MnemonicToEntropy(m, wl); err != nil {
		t.Fatalf("wallet mnemonic should be valid: %v", err)
	}
	candidates := []string{"abandon", "ability", "zebra", "zone"}
	found := false
	for _, cand := range candidates {
		if words[0] == cand {
			continue
		}
		trial := append(lightning.Mnemonic{}, m...)
		trial[0] = cand
		if _, err := lightning.MnemonicToEntropy(trial, wl); err != nil {
			words[0] = cand
			found = true
			break
		}
	}
	if !found {
		t.Skip("all candidate swaps yielded a valid checksum — cannot construct a failing phrase")
	}
	code, _, errOut := runVerify(t, []string{"--data-dir", dir},
		strings.Join(words, " ")+"\n")
	if code != exitRuntime {
		t.Fatalf("verify exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(errOut, "invalid recovery phrase") {
		t.Errorf("stderr = %q, want checksum failure message", errOut)
	}
}

func TestWalletVerify_WrongWordCount(t *testing.T) {
	dir, mnemonic, _ := newTestWallet(t, "old-pass")
	words := strings.Fields(mnemonic)[:10] // 10 words: invalid count
	code, _, errOut := runVerify(t, []string{"--data-dir", dir},
		strings.Join(words, " ")+"\n")
	if code != exitUsage {
		t.Fatalf("verify exit = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(errOut, "10 words") {
		t.Errorf("stderr = %q, want word-count error", errOut)
	}
}

// When wallet.fingerprint is absent, verify falls back to decrypting
// wallet.dat — which requires --wallet-passphrase.
func TestWalletVerify_FingerprintFileMissing_UsesWalletDat(t *testing.T) {
	dir, mnemonic, fp := newTestWallet(t, "old-pass")
	if err := os.Remove(filepath.Join(dir, "wallet.fingerprint")); err != nil {
		t.Fatal(err)
	}
	// Without the passphrase: no way to learn the expected fingerprint.
	code, _, errOut := runVerify(t, []string{"--data-dir", dir}, mnemonic+"\n")
	if code != exitUsage || !strings.Contains(errOut, "wallet-passphrase") {
		t.Fatalf("verify exit = %d stderr = %q, want usage error naming --wallet-passphrase", code, errOut)
	}
	// With it: decrypt wallet.dat and compare.
	code, out, errOut := runVerify(t,
		[]string{"--data-dir", dir, "--wallet-passphrase", "old-pass"}, mnemonic+"\n")
	if code != exitOK || !strings.Contains(out, fp) {
		t.Fatalf("verify exit = %d stdout = %q stderr = %q, want MATCHES %s", code, out, errOut, fp)
	}
}

func TestWalletVerify_NoWalletAtAll(t *testing.T) {
	dir := t.TempDir() // empty: neither wallet.dat nor fingerprint
	_, mnemonic, _ := newTestWallet(t, "x")
	code, _, errOut := runVerify(t,
		[]string{"--data-dir", dir, "--wallet-passphrase", "p"}, mnemonic+"\n")
	if code != exitRuntime || !strings.Contains(errOut, "no wallet.dat") {
		t.Fatalf("verify exit = %d stderr = %q, want no-wallet error", code, errOut)
	}
}

// ----- otedama wallet change-passphrase -----

func TestWalletChangePassphrase_Rotates(t *testing.T) {
	dir, _, fp := newTestWallet(t, "old-pass")
	var o, e bytes.Buffer
	code := cmdWalletChangePassphrase(
		[]string{"--data-dir", dir, "--wallet-passphrase", "old-pass", "--new-passphrase", "new-pass"},
		&o, &e)
	if code != exitOK {
		t.Fatalf("change-passphrase exit = %d, want %d (stderr: %s)", code, exitOK, e.String())
	}

	wl, _ := lightning.NewEnglishWordList()
	// New passphrase unlocks; same fingerprint (same seed).
	wm, err := lightning.NewWalletManager(dir, "new-pass", nil, wl)
	if err != nil {
		t.Fatalf("unlock with new passphrase: %v", err)
	}
	if wm.Fingerprint() != fp {
		t.Errorf("fingerprint changed after rotation: %s -> %s", fp, wm.Fingerprint())
	}
	// Old passphrase no longer works.
	if _, err := lightning.NewWalletManager(dir, "old-pass", nil, wl); err == nil {
		t.Error("old passphrase still unlocks wallet after rotation")
	}
}

func TestWalletChangePassphrase_MissingWallet(t *testing.T) {
	dir := t.TempDir()
	var o, e bytes.Buffer
	code := cmdWalletChangePassphrase(
		[]string{"--data-dir", dir, "--wallet-passphrase", "a", "--new-passphrase", "b"},
		&o, &e)
	if code != exitRuntime {
		t.Fatalf("exit = %d, want %d", code, exitRuntime)
	}
	// The auto-create side effect of NewWalletManager must not have run:
	// nothing was rotated, and no new wallet silently appeared.
	if _, err := os.Stat(filepath.Join(dir, walletDatName)); !os.IsNotExist(err) {
		t.Error("wallet.dat was created by change-passphrase on a missing wallet")
	}
}

func TestWalletChangePassphrase_MissingSecrets(t *testing.T) {
	dir, _, _ := newTestWallet(t, "old-pass")
	var o, e bytes.Buffer
	code := cmdWalletChangePassphrase([]string{"--data-dir", dir}, &o, &e)
	if code != exitUsage {
		t.Fatalf("exit = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(e.String(), "new-passphrase") {
		t.Errorf("stderr = %q, want missing-secret guidance", e.String())
	}
}

// ----- dispatcher -----

func TestCmdWallet_Dispatch(t *testing.T) {
	var o, e bytes.Buffer
	if code := run([]string{"wallet"}, &o, &e); code != exitUsage {
		t.Errorf("bare `wallet` exit = %d, want %d", code, exitUsage)
	}
	o.Reset()
	e.Reset()
	if code := run([]string{"wallet", "bogus"}, &o, &e); code != exitUsage {
		t.Errorf("unknown subcommand exit = %d, want %d", code, exitUsage)
	}
	o.Reset()
	e.Reset()
	if code := run([]string{"wallet", "help"}, &o, &e); code != exitOK {
		t.Errorf("wallet help exit = %d, want %d", code, exitOK)
	}
	if !strings.Contains(o.String(), "verify") {
		t.Errorf("wallet help output = %q, want usage naming verify", o.String())
	}
}
