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

// ============================================================================
// wallet subcommand
//
// These tests exercise cmdWallet directly (not run()) because the wallet
// subcommands read secrets from stdin, which the dispatcher doesn't inject.
// ============================================================================

// newTestWallet creates a real wallet in a fresh temp dir and returns the
// dir plus the mnemonic the operator would have written down at first run.
func newTestWallet(t *testing.T, passphrase string) (dir string, mnemonic lightning.Mnemonic) {
	t.Helper()
	dir = t.TempDir()
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("wordlist: %v", err)
	}
	wm, err := lightning.NewWalletManager(dir, passphrase, nil, wl)
	if err != nil {
		t.Fatalf("create wallet: %v", err)
	}
	mnemonic = wm.Mnemonic()
	if len(mnemonic) == 0 {
		t.Fatal("new wallet returned no mnemonic")
	}
	return dir, mnemonic
}

// isolateWalletEnv keeps ambient OTEDAMA_* secrets from leaking into the
// command under test — a developer's real OTEDAMA_WALLET_PASSPHRASE must
// not change test outcomes.
func isolateWalletEnv(t *testing.T) {
	t.Helper()
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "")
	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	t.Setenv("OTEDAMA_DATA_DIR", "")
}

func TestWallet_NoSubcommand(t *testing.T) {
	var out, errb bytes.Buffer
	if code := cmdWallet(nil, strings.NewReader(""), &out, &errb); code != exitUsage {
		t.Errorf("exit = %d, want %d", code, exitUsage)
	}
}

func TestWallet_UnknownSubcommand(t *testing.T) {
	var out, errb bytes.Buffer
	if code := cmdWallet([]string{"nonsense"}, strings.NewReader(""), &out, &errb); code != exitUsage {
		t.Errorf("exit = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(errb.String(), "unknown subcommand") {
		t.Errorf("stderr missing 'unknown subcommand': %q", errb.String())
	}
}

func TestWallet_Help(t *testing.T) {
	var out, errb bytes.Buffer
	if code := cmdWallet([]string{"help"}, strings.NewReader(""), &out, &errb); code != exitOK {
		t.Errorf("exit = %d, want %d", code, exitOK)
	}
	if !strings.Contains(out.String(), "verify") || !strings.Contains(out.String(), "change-passphrase") {
		t.Errorf("usage output missing subcommands:\n%s", out.String())
	}
}

// ----- verify -----

func TestWalletVerify_MatchingPhrase(t *testing.T) {
	isolateWalletEnv(t)
	dir, mnemonic := newTestWallet(t, "test-passphrase")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		strings.NewReader(strings.Join(mnemonic, " ")+"\n"),
		&out, &errb,
	)
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, errb.String())
	}
	if !strings.Contains(out.String(), "verified") {
		t.Errorf("stdout missing 'verified': %q", out.String())
	}
}

func TestWalletVerify_MismatchedPhrase(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "test-passphrase")
	// A second, different wallet's phrase is still a valid BIP-39 phrase —
	// it must pass checksum validation but fail the fingerprint compare.
	_, other := newTestWallet(t, "test-passphrase")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		strings.NewReader(strings.Join(other, " ")+"\n"),
		&out, &errb,
	)
	if code != exitVerifyFail {
		t.Errorf("exit = %d, want %d (stderr: %s)", code, exitVerifyFail, errb.String())
	}
	if !strings.Contains(errb.String(), "MISMATCH") {
		t.Errorf("stderr missing MISMATCH: %q", errb.String())
	}
}

func TestWalletVerify_InvalidPhrase(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "test-passphrase")

	var out, errb bytes.Buffer
	// 12×"abandon" is well-formed input but fails the BIP-39 checksum.
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		strings.NewReader(strings.Repeat("abandon ", 12)),
		&out, &errb,
	)
	if code != exitConfig {
		t.Errorf("exit = %d, want %d (stderr: %s)", code, exitConfig, errb.String())
	}
	if !strings.Contains(errb.String(), "invalid recovery phrase") {
		t.Errorf("stderr missing diagnostic: %q", errb.String())
	}
}

func TestWalletVerify_EmptyStdin(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "test-passphrase")

	var out, errb bytes.Buffer
	if code := cmdWallet([]string{"verify", "--data-dir", dir}, strings.NewReader(""), &out, &errb); code != exitUsage {
		t.Errorf("exit = %d, want %d", code, exitUsage)
	}
}

func TestWalletVerify_FingerprintFileMissing_NoPassphrase(t *testing.T) {
	isolateWalletEnv(t)
	dir, mnemonic := newTestWallet(t, "test-passphrase")
	if err := os.Remove(filepath.Join(dir, walletFingerprintFile)); err != nil {
		t.Fatalf("remove fingerprint file: %v", err)
	}

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		strings.NewReader(strings.Join(mnemonic, " ")),
		&out, &errb,
	)
	if code != exitRuntime {
		t.Errorf("exit = %d, want %d (stderr: %s)", code, exitRuntime, errb.String())
	}
	if !strings.Contains(errb.String(), "OTEDAMA_WALLET_PASSPHRASE") {
		t.Errorf("stderr should point at OTEDAMA_WALLET_PASSPHRASE: %q", errb.String())
	}
}

func TestWalletVerify_FingerprintFileMissing_FallbackDecrypt(t *testing.T) {
	isolateWalletEnv(t)
	dir, mnemonic := newTestWallet(t, "test-passphrase")
	if err := os.Remove(filepath.Join(dir, walletFingerprintFile)); err != nil {
		t.Fatalf("remove fingerprint file: %v", err)
	}
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test-passphrase")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"verify", "--data-dir", dir},
		strings.NewReader(strings.Join(mnemonic, " ")),
		&out, &errb,
	)
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, errb.String())
	}
	if !strings.Contains(errb.String(), "verifying against wallet.dat") {
		t.Errorf("stderr should note the wallet.dat fallback: %q", errb.String())
	}
}

// ----- change-passphrase -----

func TestWalletChangePassphrase_Success(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "old-pass")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader("old-pass\nnew-pass\nnew-pass\n"),
		&out, &errb,
	)
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, errb.String())
	}
	if !strings.Contains(out.String(), "passphrase updated") {
		t.Errorf("stdout missing confirmation: %q", out.String())
	}

	// The wallet must now open under the new passphrase, and reject the old.
	wl, _ := lightning.NewEnglishWordList()
	if _, err := lightning.NewWalletManager(dir, "new-pass", nil, wl); err != nil {
		t.Errorf("wallet does not open under new passphrase: %v", err)
	}
	if _, err := lightning.NewWalletManager(dir, "old-pass", nil, wl); err == nil {
		t.Error("wallet still opens under the old passphrase")
	}
}

func TestWalletChangePassphrase_WrongCurrent(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "real-pass")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader("wrong-pass\nnew-pass\nnew-pass\n"),
		&out, &errb,
	)
	if code != exitVerifyFail {
		t.Errorf("exit = %d, want %d (stderr: %s)", code, exitVerifyFail, errb.String())
	}
}

func TestWalletChangePassphrase_ConfirmMismatch(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "old-pass")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader("old-pass\nnew-a\nnew-b\n"),
		&out, &errb,
	)
	if code != exitVerifyFail {
		t.Errorf("exit = %d, want %d", code, exitVerifyFail)
	}
	// The original passphrase must still work — the rotate must not have run.
	wl, _ := lightning.NewEnglishWordList()
	if _, err := lightning.NewWalletManager(dir, "old-pass", nil, wl); err != nil {
		t.Errorf("wallet no longer opens under old passphrase: %v", err)
	}
}

func TestWalletChangePassphrase_NoWallet(t *testing.T) {
	isolateWalletEnv(t)
	dir := t.TempDir() // empty — no wallet.dat

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader("a\nb\nb\n"),
		&out, &errb,
	)
	if code != exitRuntime {
		t.Errorf("exit = %d, want %d", code, exitRuntime)
	}
	// Critically, the command must NOT have created a wallet here.
	if _, err := os.Stat(filepath.Join(dir, walletDatFile)); !os.IsNotExist(err) {
		t.Error("change-passphrase must never create wallet.dat")
	}
}

func TestWalletChangePassphrase_EarlyEOF(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "old-pass")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader("old-pass\n"), // only the first of three lines
		&out, &errb,
	)
	if code != exitUsage {
		t.Errorf("exit = %d, want %d", code, exitUsage)
	}
}

func TestWalletChangePassphrase_EmptyNewRejected(t *testing.T) {
	isolateWalletEnv(t)
	dir, _ := newTestWallet(t, "old-pass")

	var out, errb bytes.Buffer
	code := cmdWallet(
		[]string{"change-passphrase", "--data-dir", dir},
		strings.NewReader("old-pass\n\n\n"),
		&out, &errb,
	)
	if code != exitConfig {
		t.Errorf("exit = %d, want %d", code, exitConfig)
	}
}
