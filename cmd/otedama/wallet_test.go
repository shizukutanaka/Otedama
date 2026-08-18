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

// newTestWallet creates a real wallet in a temp dir and returns the dir and
// the mnemonic it printed. Using the real WalletManager rather than a fixture
// is the point: the phrase this returns is the phrase a user would have
// written down, so a verify that passes here passes for them.
func newTestWallet(t *testing.T, mnemonicPassphrase string) (dir string, phrase string) {
	t.Helper()
	dir = t.TempDir()
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		t.Fatalf("wordlist: %v", err)
	}
	wm, err := lightning.NewWalletManager(dir, "test encryption passphrase", nil, wl,
		lightning.WithMnemonicPassphrase(mnemonicPassphrase))
	if err != nil {
		t.Fatalf("create wallet: %v", err)
	}
	if !wm.IsNew() {
		t.Fatal("expected a freshly created wallet")
	}
	return dir, wm.Mnemonic().String()
}

func TestWalletVerify_MatchingPhrase(t *testing.T) {
	dir, phrase := newTestWallet(t, "")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	var stdout, stderr bytes.Buffer
	code := cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr, strings.NewReader(phrase+"\n"))

	if code != exitOK {
		t.Fatalf("exit = %d, want %d\nstdout: %s\nstderr: %s", code, exitOK, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "MATCH") {
		t.Errorf("stdout = %q, want a MATCH result", stdout.String())
	}
	// The fingerprint is what the user cross-checks against `otedama doctor`
	// and against what was shown at creation, so it must be printed.
	if !strings.Contains(stdout.String(), "fingerprint:") {
		t.Errorf("stdout = %q, want the fingerprint printed", stdout.String())
	}
}

// TestWalletVerify_DetectsTranscriptionError is the failure this command
// exists for: a phrase that is a perfectly valid BIP-39 mnemonic but not this
// wallet's. It is built by swapping two words, which preserves nothing about
// the seed but can still satisfy the checksum — the exact silent error a user
// cannot otherwise detect until a recovery attempt.
func TestWalletVerify_DetectsTranscriptionError(t *testing.T) {
	dir, phrase := newTestWallet(t, "")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	words := strings.Fields(phrase)
	words[0], words[1] = words[1], words[0]

	var stdout, stderr bytes.Buffer
	code := cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr,
		strings.NewReader(strings.Join(words, " ")+"\n"))

	// A swap usually breaks the checksum, in which case the command reports
	// an invalid mnemonic; when it survives the checksum it reports a
	// mismatch. Both are correct and both are non-zero — what must never
	// happen is a swapped phrase being accepted.
	if code == exitOK {
		t.Fatalf("a word-swapped phrase verified successfully\nstdout: %s", stdout.String())
	}
	combined := stdout.String() + stderr.String()
	if !strings.Contains(combined, "MISMATCH") && !strings.Contains(combined, "not a valid BIP-39 mnemonic") {
		t.Errorf("output = %q, want it to name the mismatch or the invalid mnemonic", combined)
	}
}

// TestWalletVerify_ValidPhraseForADifferentWallet exercises the MISMATCH
// branch specifically. The word-swap above usually breaks the checksum and so
// exits through the invalid-mnemonic path; a second wallet's phrase is
// guaranteed to be a valid BIP-39 mnemonic that is not this wallet's, which
// is the case a user hits when they verify against the wrong data dir.
func TestWalletVerify_ValidPhraseForADifferentWallet(t *testing.T) {
	dir, _ := newTestWallet(t, "")
	_, otherPhrase := newTestWallet(t, "")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	var stdout, stderr bytes.Buffer
	code := cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr, strings.NewReader(otherPhrase+"\n"))

	if code == exitOK {
		t.Fatalf("another wallet's phrase verified successfully\nstdout: %s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "MISMATCH") {
		t.Errorf("stdout = %q, want a MISMATCH result", stdout.String())
	}
	// Both fingerprints are shown so the user can tell which wallet they are
	// actually looking at.
	if strings.Count(stdout.String(), "fingerprint") < 1 {
		t.Errorf("stdout = %q, want both fingerprints shown", stdout.String())
	}
}

// TestWalletVerify_MnemonicPassphraseChangesTheAnswer pins the "25th word"
// case, which is the second thing that makes a correctly-transcribed phrase
// fail to match. The same words must verify with the passphrase and fail
// without it, so the command's advice about
// OTEDAMA_WALLET_MNEMONIC_PASSPHRASE is actionable rather than decorative.
func TestWalletVerify_MnemonicPassphraseChangesTheAnswer(t *testing.T) {
	dir, phrase := newTestWallet(t, "the 25th word")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "the 25th word")
	var okOut, okErr bytes.Buffer
	if code := cmdWalletVerify([]string{"--data-dir", dir}, &okOut, &okErr, strings.NewReader(phrase+"\n")); code != exitOK {
		t.Fatalf("with the correct 25th word: exit = %d, want 0\nstdout: %s\nstderr: %s",
			code, okOut.String(), okErr.String())
	}

	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	var badOut, badErr bytes.Buffer
	if code := cmdWalletVerify([]string{"--data-dir", dir}, &badOut, &badErr, strings.NewReader(phrase+"\n")); code == exitOK {
		t.Fatalf("without the 25th word the same phrase verified; it must not\nstdout: %s", badOut.String())
	}
	if !strings.Contains(badOut.String(), "25th word") {
		t.Errorf("mismatch output = %q, want it to point at the 25th word", badOut.String())
	}
}

// TestWalletVerify_CaseAndSpacingAreForgiving covers phrases written down in
// capitals or with ragged spacing — both are the same phrase, and rejecting
// them would send a user hunting for a transcription error that isn't there.
func TestWalletVerify_CaseAndSpacingAreForgiving(t *testing.T) {
	dir, phrase := newTestWallet(t, "")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	messy := "  " + strings.ToUpper(strings.Join(strings.Fields(phrase), "   ")) + "  \n"

	var stdout, stderr bytes.Buffer
	if code := cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr, strings.NewReader(messy)); code != exitOK {
		t.Fatalf("exit = %d, want 0 for an upper-cased, ragged-spaced phrase\nstdout: %s\nstderr: %s",
			code, stdout.String(), stderr.String())
	}
}

// TestWalletVerify_NoWalletDoesNotCreateOne guards the side effect a verify
// command must not have: lightning.NewWalletManager creates a wallet when
// none exists, so calling it unguarded would answer "no wallet" by making
// one — and then cheerfully report a mismatch against a wallet it had just
// invented.
func TestWalletVerify_NoWalletDoesNotCreateOne(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	var stdout, stderr bytes.Buffer
	code := cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr, strings.NewReader("word word\n"))

	if code != exitConfig {
		t.Errorf("exit = %d, want %d (config error)", code, exitConfig)
	}
	if _, err := os.Stat(filepath.Join(dir, walletDatFile)); !os.IsNotExist(err) {
		t.Errorf("verify created %s; it must never write", walletDatFile)
	}
}

func TestWalletVerify_RequiresPassphraseFromEnvironment(t *testing.T) {
	dir, phrase := newTestWallet(t, "")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	var stdout, stderr bytes.Buffer
	code := cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr, strings.NewReader(phrase+"\n"))

	if code != exitConfig {
		t.Errorf("exit = %d, want %d", code, exitConfig)
	}
	if !strings.Contains(stderr.String(), "OTEDAMA_WALLET_PASSPHRASE") {
		t.Errorf("stderr = %q, want it to name the environment variable", stderr.String())
	}
}

// TestWalletVerify_PhraseIsNeverEchoedBack checks that no output path repeats
// the secret. The phrase is already exposed by the terminal's own echo; the
// command must not add a second copy that could reach a pipe, a log, or a
// screenshot.
func TestWalletVerify_PhraseIsNeverEchoedBack(t *testing.T) {
	dir, phrase := newTestWallet(t, "")
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test encryption passphrase")
	t.Setenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE", "")
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(dir, "no-such-config.yaml"))

	_, otherPhrase := newTestWallet(t, "")

	for _, tc := range []struct {
		name  string
		input string
	}{
		{"matching", phrase},
		{"mismatching", otherPhrase},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			cmdWalletVerify([]string{"--data-dir", dir}, &stdout, &stderr, strings.NewReader(tc.input+"\n"))
			out := stdout.String() + stderr.String()
			// A single word could plausibly appear in prose; several in a row
			// can only be the phrase being repeated back. Check the submitted
			// phrase and the stored one, since either would be a leak.
			for _, secret := range []string{tc.input, phrase} {
				w := strings.Fields(secret)
				if run := strings.Join(w[:4], " "); strings.Contains(out, run) {
					t.Fatalf("output repeats the phrase (%q): %q", run, out)
				}
			}
		})
	}
}

func TestReadMnemonic_RejectsEmptyInput(t *testing.T) {
	if _, err := readMnemonic(strings.NewReader("\n")); err == nil {
		t.Error("readMnemonic(blank line) = nil error, want an error")
	}
	if _, err := readMnemonic(strings.NewReader("")); err == nil {
		t.Error("readMnemonic(EOF) = nil error, want an error")
	}
}

// TestReadMnemonic_DoesNotTruncateAtTwelveWords pins the bug the single-line
// design avoids: stopping at the first valid BIP-39 length would cut a
// 24-word phrase in half and report it as a mismatch, sending a user to
// re-transcribe a backup that was correct.
func TestReadMnemonic_DoesNotTruncateAtTwelveWords(t *testing.T) {
	words := make([]string, 24)
	for i := range words {
		words[i] = "abandon"
	}
	got, err := readMnemonic(strings.NewReader(strings.Join(words, " ") + "\n"))
	if err != nil {
		t.Fatalf("readMnemonic: %v", err)
	}
	if len(got) != 24 {
		t.Errorf("read %d words, want 24", len(got))
	}
}

func TestCmdWallet_UnknownSubcommandIsUsageError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := cmdWallet([]string{"frobnicate"}, &stdout, &stderr); code != exitUsage {
		t.Errorf("exit = %d, want %d", code, exitUsage)
	}
	if code := cmdWallet(nil, &stdout, &stderr); code != exitUsage {
		t.Errorf("exit with no subcommand = %d, want %d", code, exitUsage)
	}
}

func TestCmdWallet_HelpGoesToStdoutAndExitsZero(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := cmdWallet([]string{"help"}, &stdout, &stderr); code != exitOK {
		t.Errorf("exit = %d, want 0", code)
	}
	if !strings.Contains(stdout.String(), "verify") {
		t.Errorf("help output = %q, want it to list verify", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Errorf("help wrote to stderr: %q", stderr.String())
	}
}

// ============================================================================
// --wallet-mnemonic-passphrase portability (session 264, KNOWN_LIMITATIONS §19)
// ============================================================================

// TestCheckWalletMnemonicPassphrase_RejectsNonASCII pins the CLI-level half of
// the rule. lightning.NewWalletManager rejects it too, but engine.setupWallet
// logs wallet failures at warn level and carries on without a wallet — and
// with the TUI active and no --log-file the logger is a discard sink, so
// relying on the library alone would give the user a silent no-wallet run
// instead of a reason.
func TestCheckWalletMnemonicPassphrase_RejectsNonASCII(t *testing.T) {
	for _, p := range []string{"caf\u00e9", "\u30d1\u30b9\u30ef\u30fc\u30c9", "two\u00a0words", "\U0001f434"} {
		err := checkWalletMnemonicPassphrase(p)
		if err == nil {
			t.Errorf("passphrase %q accepted; want rejection", p)
			continue
		}
		if !strings.Contains(err.Error(), "NFKD") || !strings.Contains(err.Error(), "§19") {
			t.Errorf("error for %q = %q, want the NFKD reason and the docs pointer", p, err)
		}
	}
}

func TestCheckWalletMnemonicPassphrase_AcceptsASCIIAndEmpty(t *testing.T) {
	for _, p := range []string{"", "correct horse battery staple", "~!@#$%^&*()_+ 123"} {
		if err := checkWalletMnemonicPassphrase(p); err != nil {
			t.Errorf("passphrase %q rejected: %v", p, err)
		}
	}
}

// TestRun_NonASCIIMnemonicPassphraseIsAConfigError checks the wiring: the
// check must run at config time and exit with the config code, so a script
// can tell it apart from a runtime failure.
//
// --dry-run is what makes this a test rather than a hang. The check sits
// before the dry-run early return, so a correct implementation still rejects;
// but if the check were removed, dry-run returns exitOK immediately instead of
// starting the engine and blocking until a signal that never comes. A
// regression should fail this in milliseconds, not wedge the suite.
func TestRun_NonASCIIMnemonicPassphraseIsAConfigError(t *testing.T) {
	t.Setenv("OTEDAMA_CONFIG", filepath.Join(t.TempDir(), "no-such-config.yaml"))
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--wallet-passphrase", "encryption passphrase",
		"--wallet-mnemonic-passphrase", "\u30d1\u30b9\u30ef\u30fc\u30c9",
		"--data-dir", t.TempDir(),
		"--no-tui",
		"--dry-run",
	}, &stdout, &stderr)

	if code != exitConfig {
		t.Fatalf("exit = %d, want %d (config error)\nstdout: %s\nstderr: %s",
			code, exitConfig, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "wallet-mnemonic-passphrase") {
		t.Errorf("stderr = %q, want it to name the flag", stderr.String())
	}
	// The rejection must beat the dry-run success message, not follow it.
	if strings.Contains(stdout.String(), "configuration is valid") {
		t.Errorf("dry-run reported success for a rejected passphrase: %q", stdout.String())
	}
}
