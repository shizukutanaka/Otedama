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

// makeTestWallet creates a real wallet (wallet.dat + wallet.fingerprint)
// under dir and returns its mnemonic — the verification path is exercised
// end-to-end against the same artifacts `run` produces.
func makeTestWallet(t *testing.T, dir, passphrase string) lightning.Mnemonic {
	t.Helper()
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("NewEnglishWordList: %v", err)
	}
	wm, err := lightning.NewWalletManager(dir, passphrase, nil, wl)
	if err != nil {
		t.Fatalf("NewWalletManager: %v", err)
	}
	if !wm.IsNew() {
		t.Fatal("expected a freshly created wallet")
	}
	return wm.Mnemonic()
}

func otherMnemonic(t *testing.T) lightning.Mnemonic {
	t.Helper()
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("NewEnglishWordList: %v", err)
	}
	ent, err := lightning.GenerateEntropy(lightning.DefaultEntropyBits, nil)
	if err != nil {
		t.Fatalf("GenerateEntropy: %v", err)
	}
	m, err := lightning.EntropyToMnemonic(ent, wl)
	if err != nil {
		t.Fatalf("EntropyToMnemonic: %v", err)
	}
	return m
}

func TestWallet_NoArgs_UsageError(t *testing.T) {
	var out, errBuf bytes.Buffer
	if code := cmdWallet(nil, strings.NewReader(""), &out, &errBuf); code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
}

func TestWallet_UnknownSubcommand(t *testing.T) {
	var out, errBuf bytes.Buffer
	if code := cmdWallet([]string{"bogus"}, strings.NewReader(""), &out, &errBuf); code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
}

func TestWalletVerify_MatchesCreatedWallet(t *testing.T) {
	dir := t.TempDir()
	m := makeTestWallet(t, dir, "pw")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"verify", "--data-dir", dir},
		strings.NewReader(m.String()+"\n"), &out, &errBuf)
	if code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, errBuf.String())
	}
	if !strings.Contains(out.String(), "verified") {
		t.Fatalf("stdout %q missing verification message", out.String())
	}
}

func TestWalletVerify_MismatchedPhrase(t *testing.T) {
	dir := t.TempDir()
	makeTestWallet(t, dir, "pw")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"verify", "--data-dir", dir},
		strings.NewReader(otherMnemonic(t).String()+"\n"), &out, &errBuf)
	if code != exitRuntime {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(errBuf.String(), "does NOT match") {
		t.Fatalf("stderr %q missing mismatch message", errBuf.String())
	}
}

func TestWalletVerify_InvalidPhrase(t *testing.T) {
	dir := t.TempDir()
	makeTestWallet(t, dir, "pw")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"verify", "--data-dir", dir},
		strings.NewReader("not a mnemonic at all\n"), &out, &errBuf)
	if code != exitRuntime {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(errBuf.String(), "invalid recovery phrase") {
		t.Fatalf("stderr %q missing invalid-phrase message", errBuf.String())
	}
}

// The fingerprint file is preferred; when absent (e.g. written by an older
// build) verify falls back to decrypting wallet.dat with the passphrase env.
func TestWalletVerify_FallbackDecryptsWalletDat(t *testing.T) {
	dir := t.TempDir()
	m := makeTestWallet(t, dir, "pw")
	if err := os.Remove(filepath.Join(dir, "wallet.fingerprint")); err != nil {
		t.Fatalf("remove fingerprint file: %v", err)
	}
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "pw")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"verify", "--data-dir", dir},
		strings.NewReader(m.String()+"\n"), &out, &errBuf)
	if code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, errBuf.String())
	}
}

// A verify run must never create a wallet: NewWalletManager's
// create-when-absent contract would silently mint an empty wallet under a
// path the user pointed at by mistake.
func TestWalletVerify_NoWallet_DoesNotCreate(t *testing.T) {
	dir := t.TempDir()
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"verify", "--data-dir", dir},
		strings.NewReader("anything\n"), &out, &errBuf)
	if code == exitOK {
		t.Fatal("expected non-zero exit with no wallet present")
	}
	if _, err := os.Stat(filepath.Join(dir, "wallet.dat")); !os.IsNotExist(err) {
		t.Fatal("verify created wallet.dat — must not create wallets")
	}
}

func TestWalletChangePassphrase_Rotates(t *testing.T) {
	dir := t.TempDir()
	makeTestWallet(t, dir, "old-pass")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "old-pass")
	t.Setenv("OTEDAMA_WALLET_NEW_PASSPHRASE", "new-pass")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader(""), &out, &errBuf)
	if code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, errBuf.String())
	}
	// The new passphrase unlocks; the old one must not.
	wl, _ := lightning.NewEnglishWordList()
	if _, err := lightning.NewWalletManager(dir, "new-pass", nil, wl); err != nil {
		t.Fatalf("wallet does not open under new passphrase: %v", err)
	}
	if _, err := lightning.NewWalletManager(dir, "old-pass", nil, wl); err == nil {
		t.Fatal("wallet still opens under the old passphrase")
	}
}

func TestWalletChangePassphrase_NoWallet_DoesNotCreate(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "old")
	t.Setenv("OTEDAMA_WALLET_NEW_PASSPHRASE", "new")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader(""), &out, &errBuf)
	if code == exitOK {
		t.Fatal("expected non-zero exit with no wallet present")
	}
	if _, err := os.Stat(filepath.Join(dir, "wallet.dat")); !os.IsNotExist(err) {
		t.Fatal("change-passphrase created wallet.dat — must not create wallets")
	}
}

func TestWalletChangePassphrase_RequiresEnv(t *testing.T) {
	dir := t.TempDir()
	makeTestWallet(t, dir, "pw")
	var out, errBuf bytes.Buffer
	code := cmdWallet([]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader(""), &out, &errBuf)
	if code != exitUsage {
		t.Fatalf("exit code = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(errBuf.String(), "OTEDAMA_WALLET_PASSPHRASE") {
		t.Fatalf("stderr %q missing env-var guidance", errBuf.String())
	}
}
