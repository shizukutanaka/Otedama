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

// newTestWallet creates a wallet in a fresh temp dir and returns the dir
// and the wallet's mnemonic so tests can feed it back to `wallet verify`.
func newTestWallet(t *testing.T) (dir string, mnemonic lightning.Mnemonic) {
	t.Helper()
	dir = t.TempDir()
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("wordlist: %v", err)
	}
	wm, err := lightning.NewWalletManager(dir, "old-pass", nil, wl)
	if err != nil {
		t.Fatalf("create wallet: %v", err)
	}
	if !wm.IsNew() {
		t.Fatal("expected a freshly created wallet")
	}
	return dir, wm.Mnemonic()
}

func TestWallet_NoSubcommand_UsageError(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run([]string{"wallet"}, &out, &errb); code != exitUsage {
		t.Fatalf("wallet with no subcommand: exit %d, want %d", code, exitUsage)
	}
}

func TestWallet_UnknownSubcommand(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run([]string{"wallet", "bogus"}, &out, &errb); code != exitUsage {
		t.Fatalf("wallet bogus: exit %d, want %d", code, exitUsage)
	}
}

func TestWalletVerify_MatchingPhrase(t *testing.T) {
	dir, mnemonic := newTestWallet(t)
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		&out, &errb, strings.NewReader(mnemonic.String()+"\n"))
	if code != exitOK {
		t.Fatalf("verify correct phrase: exit %d, want %d (stderr: %s)", code, exitOK, errb.String())
	}
	if !strings.Contains(out.String(), "verified") {
		t.Errorf("verify output should confirm the match, got: %s", out.String())
	}
}

func TestWalletVerify_ValidPhraseDifferentWallet_Mismatch(t *testing.T) {
	dir, _ := newTestWallet(t)
	// Canonical BIP-39 test-vector phrase for all-zero 256-bit entropy:
	// valid checksum, but a different wallet than the one created above.
	other := strings.Repeat("abandon ", 23) + "art"
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		&out, &errb, strings.NewReader(other))
	if code != exitRuntime {
		t.Fatalf("verify wrong-wallet phrase: exit %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(errb.String(), "MISMATCH") {
		t.Errorf("mismatch should be reported clearly, got: %s", errb.String())
	}
}

func TestWalletVerify_MalformedPhrase_UsageError(t *testing.T) {
	dir, _ := newTestWallet(t)
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		&out, &errb, strings.NewReader("not a real phrase"))
	if code != exitUsage {
		t.Fatalf("verify malformed phrase: exit %d, want %d", code, exitUsage)
	}
}

func TestWalletVerify_NoWallet_NeverCreatesOne(t *testing.T) {
	dir := t.TempDir()
	phrase := strings.Repeat("abandon ", 23) + "art"
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		&out, &errb, strings.NewReader(phrase))
	if code != exitRuntime {
		t.Fatalf("verify with no wallet: exit %d, want %d", code, exitRuntime)
	}
	// The command must not mint a fresh wallet as a side effect: a silent
	// creation would make a later verify "succeed" against an empty wallet.
	if _, err := os.Stat(filepath.Join(dir, walletFile)); !os.IsNotExist(err) {
		t.Fatal("verify created a wallet.dat in an empty data dir")
	}
}

// A fingerprint sidecar without wallet.dat is a broken data dir — the
// sidecar caches the wallet's identity, it is not the wallet. Verify
// must not claim a match against a wallet that is not there.
func TestWalletVerify_FingerprintWithoutWallet_Fails(t *testing.T) {
	dir, mnemonic := newTestWallet(t)
	if err := os.Remove(filepath.Join(dir, walletFile)); err != nil {
		t.Fatalf("remove wallet.dat: %v", err)
	}
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		&out, &errb, strings.NewReader(mnemonic.String()))
	if code != exitRuntime {
		t.Fatalf("verify with only a fingerprint sidecar: exit %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(errb.String(), "no wallet found") {
		t.Errorf("expected 'no wallet found', got: %s", errb.String())
	}
}

// stdin=/dev/null is a character device, so a ModeCharDevice check would
// print the interactive prompt into a session with no human attached.
// The prompt must be gated on a real terminal, not just a char device.
func TestWalletVerify_DevNullStdin_NoPrompt(t *testing.T) {
	dir, _ := newTestWallet(t)
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Skipf("cannot open %s: %v", os.DevNull, err)
	}
	defer devnull.Close()
	var out, errb bytes.Buffer
	// /dev/null yields no words, so the phrase parse fails — fine; this
	// test only asserts the interactive prompt text is absent.
	cmdWallet([]string{"verify", "--data-dir", dir}, &out, &errb, devnull)
	if strings.Contains(errb.String(), "recovery phrase") && strings.Contains(errb.String(), "Enter") {
		t.Errorf("interactive prompt printed with /dev/null stdin: %s", errb.String())
	}
}

func TestWalletVerify_FingerprintFileMissing_UsesPassphrase(t *testing.T) {
	dir, mnemonic := newTestWallet(t)
	if err := os.Remove(filepath.Join(dir, walletFingerprintFile)); err != nil {
		t.Fatalf("remove fingerprint file: %v", err)
	}
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir, "--wallet-passphrase", "old-pass"},
		&out, &errb, strings.NewReader(mnemonic.String()))
	if code != exitOK {
		t.Fatalf("verify via decrypt fallback: exit %d, want %d (stderr: %s)", code, exitOK, errb.String())
	}
}

func TestWalletVerify_FingerprintFileMissing_NoPassphrase_Fails(t *testing.T) {
	dir, mnemonic := newTestWallet(t)
	if err := os.Remove(filepath.Join(dir, walletFingerprintFile)); err != nil {
		t.Fatalf("remove fingerprint file: %v", err)
	}
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		&out, &errb, strings.NewReader(mnemonic.String()))
	if code != exitRuntime {
		t.Fatalf("verify without passphrase or fingerprint file: exit %d, want %d", code, exitRuntime)
	}
}

func TestWalletChangePassphrase_RoundTrip(t *testing.T) {
	dir, _ := newTestWallet(t)
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{
			"change-passphrase", "--data-dir", dir,
			"--old-passphrase", "old-pass", "--new-passphrase", "new-pass",
		},
		&out, &errb, nil)
	if code != exitOK {
		t.Fatalf("change-passphrase: exit %d, want %d (stderr: %s)", code, exitOK, errb.String())
	}

	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("wordlist: %v", err)
	}
	// New passphrase unlocks.
	if _, err := lightning.NewWalletManager(dir, "new-pass", nil, wl); err != nil {
		t.Fatalf("wallet does not unlock with new passphrase: %v", err)
	}
	// Old passphrase no longer does.
	if _, err := lightning.NewWalletManager(dir, "old-pass", nil, wl); err == nil {
		t.Fatal("wallet still unlocks with the old passphrase after rotation")
	}
}

func TestWalletChangePassphrase_MissingWallet_DoesNotCreate(t *testing.T) {
	dir := t.TempDir()
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{
			"change-passphrase", "--data-dir", dir,
			"--old-passphrase", "old-pass", "--new-passphrase", "new-pass",
		},
		&out, &errb, nil)
	if code != exitRuntime {
		t.Fatalf("change-passphrase with no wallet: exit %d, want %d", code, exitRuntime)
	}
	if _, err := os.Stat(filepath.Join(dir, walletFile)); !os.IsNotExist(err) {
		t.Fatal("change-passphrase created a wallet.dat in an empty data dir")
	}
}

func TestWalletChangePassphrase_MissingArgs_UsageError(t *testing.T) {
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", t.TempDir()},
		&out, &errb, nil)
	if code != exitUsage {
		t.Fatalf("change-passphrase without passphrases: exit %d, want %d", code, exitUsage)
	}
}

func TestWalletChangePassphrase_WrongOldPassphrase(t *testing.T) {
	dir, _ := newTestWallet(t)
	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{
			"change-passphrase", "--data-dir", dir,
			"--old-passphrase", "not-the-pass", "--new-passphrase", "new-pass",
		},
		&out, &errb, nil)
	if code != exitRuntime {
		t.Fatalf("change-passphrase with wrong old passphrase: exit %d, want %d", code, exitRuntime)
	}
}
