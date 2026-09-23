// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Command otedama — wallet.go
//
// The `otedama wallet` subcommand: operator-facing wallet maintenance
// that previously required writing a Go program against internal
// packages (docs/KNOWN_LIMITATIONS.md §16).
//
//	otedama wallet verify            — re-enter the recovery phrase to
//	                                   prove the written-down backup
//	                                   matches the wallet on disk.
//	otedama wallet change-passphrase — rotate the passphrase that
//	                                   encrypts wallet.dat at rest.
//
// Design constraints carried over from the wallet itself:
//   - Secrets never come from argv for the phrase itself: the mnemonic
//     is read from stdin (a space- or newline-separated stream), never a
//     flag — argv is visible in process listings. Passphrases follow the
//     existing convention of `--wallet-passphrase` / OTEDAMA_* env vars
//     (docs/API.md documents env as preferred in production).
//   - `verify` does not need the wallet passphrase at all: it compares
//     the derived seed's public fingerprint against
//     `{data-dir}/wallet.fingerprint`, the file written for exactly this
//     purpose. Only when that file is missing does it fall back to
//     decrypting wallet.dat (which does need the passphrase).
//   - `change-passphrase` must never create a wallet: WalletManager
//     auto-creates wallet.dat when absent, so the file's existence is
//     checked explicitly first — otherwise "rotate" would silently mint
//     a brand-new empty wallet.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/lightning"
)

// validMnemonicLengths are the BIP-39 word counts MnemonicToEntropy
// accepts; used to know when an interactive stdin stream is complete.
var validMnemonicLengths = map[int]bool{12: true, 15: true, 18: true, 21: true, 24: true}

// walletDatName mirrors lightning's unexported walletFile constant; the
// stat below must not rely on NewWalletManager, which creates the file
// when absent (see package comment).
const walletDatName = "wallet.dat"

func cmdWallet(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printWalletUsage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "verify":
		return cmdWalletVerify(args[1:], stdout, stderr, os.Stdin)
	case "change-passphrase":
		return cmdWalletChangePassphrase(args[1:], stdout, stderr)
	case "help", "--help", "-h":
		printWalletUsage(stdout)
		return exitOK
	default:
		fmt.Fprintf(stderr, "otedama wallet: unknown subcommand %q\n", args[0])
		printWalletUsage(stderr)
		return exitUsage
	}
}

func printWalletUsage(w io.Writer) {
	fmt.Fprint(w, `Usage:
  otedama wallet verify            Verify a written-down recovery phrase.
  otedama wallet change-passphrase Rotate the wallet.dat passphrase.

Both accept --data-dir (defaults to the platform data directory) and read
secrets from stdin / OTEDAMA_* environment variables, never argv beyond
the documented passphrase flags.
`)
}

// resolveDataDir picks the data directory: explicit flag wins, else the
// same platform default config.Resolve would compute.
func resolveDataDir(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	return config.DefaultDataDir()
}

// readMnemonic consumes whitespace-separated BIP-39 words from r until
// the stream ends (EOF on a pipe/file, Ctrl-D on a terminal), then
// validates the count. It reads to EOF rather than stopping at the first
// valid-looking count: a 24-word phrase entered one word per line passes
// through 12 — itself a valid count — so stopping early would truncate
// it into a wrong (checksum-failing) phrase. Accepts both a single
// space-separated line and one word per line.
func readMnemonic(r io.Reader) (lightning.Mnemonic, error) {
	scanner := bufio.NewScanner(r)
	var words []string
	for scanner.Scan() {
		words = append(words, strings.Fields(scanner.Text())...)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read mnemonic: %w", err)
	}
	if len(words) == 0 {
		return nil, fmt.Errorf("no recovery phrase on stdin (expected 12/15/18/21/24 space-separated words)")
	}
	if !validMnemonicLengths[len(words)] {
		return nil, fmt.Errorf("recovery phrase has %d words, must be 12/15/18/21/24", len(words))
	}
	return lightning.Mnemonic(words), nil
}

// walletFingerprintFile mirrors lightning's unexported fingerprintFile;
// the fingerprint is public data (8 hex chars), safe to read directly.
const walletFingerprintName = "wallet.fingerprint"

func cmdWalletVerify(args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	fs := flag.NewFlagSet("wallet verify", flag.ContinueOnError)
	var dataDirFlag, walletPass, mnemPass string
	fs.StringVar(&dataDirFlag, "data-dir", "", "Directory containing wallet.dat.")
	fs.StringVar(&walletPass, "wallet-passphrase", "",
		"Passphrase to unlock wallet.dat — only needed when wallet.fingerprint is missing.")
	fs.StringVar(&mnemPass, "wallet-mnemonic-passphrase", "",
		"BIP-39 \"25th word\" used at wallet creation, if any.")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	if walletPass == "" {
		walletPass = os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	}
	if mnemPass == "" {
		mnemPass = os.Getenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE")
	}
	dataDir := resolveDataDir(dataDirFlag)
	if dataDir == "" {
		fmt.Fprintln(stderr, "otedama wallet verify: cannot resolve data directory; pass --data-dir")
		return exitUsage
	}

	wordList, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitRuntime
	}

	// The fingerprint file is the public identity anchor; when it exists
	// no wallet passphrase is needed at all. Otherwise we must decrypt
	// wallet.dat to learn the expected fingerprint.
	expected, haveExpected := readExpectedFingerprint(dataDir)
	if !haveExpected && walletPass == "" {
		fmt.Fprintln(stderr, "otedama wallet verify: wallet.fingerprint is missing and no "+
			"--wallet-passphrase was given; cannot determine the expected fingerprint.")
		return exitUsage
	}

	// When stdin is a real terminal, tell the user how to end input —
	// otherwise the tool looks hung waiting for more words.
	if f, ok := stdin.(*os.File); ok {
		if st, err := f.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprintln(stderr, "Enter the recovery phrase (words separated by spaces or newlines; Ctrl-D when done):")
		}
	}
	words, err := readMnemonic(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitUsage
	}
	// MnemonicToEntropy validates the checksum: a transcription typo in
	// any word almost certainly fails here with the offending word named.
	if _, err := lightning.MnemonicToEntropy(words, wordList); err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: invalid recovery phrase: %v\n", err)
		return exitRuntime
	}
	got := lightning.Fingerprint(lightning.MnemonicToSeed(words, mnemPass))

	if !haveExpected {
		var statErr error
		if _, statErr = os.Stat(filepath.Join(dataDir, walletDatName)); statErr != nil {
			fmt.Fprintf(stderr, "otedama wallet verify: no wallet.dat in %s\n", dataDir)
			return exitRuntime
		}
		wm, err := lightning.NewWalletManager(dataDir, walletPass, nil, wordList)
		if err != nil {
			fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
			return exitRuntime
		}
		expected = wm.Fingerprint()
	}

	if got == expected {
		fmt.Fprintf(stdout, "fingerprint %s: MATCHES wallet in %s\n", got, dataDir)
		return exitOK
	}
	fmt.Fprintf(stderr, "fingerprint %s: does NOT match wallet in %s (expected %s)\n", got, dataDir, expected)
	fmt.Fprintln(stderr, "The written-down phrase does not correspond to this wallet — "+
		"check for transcription errors before relying on it for recovery.")
	return exitRuntime
}

// readExpectedFingerprint returns the 8-hex fingerprint stored in
// {dataDir}/wallet.fingerprint, or ("", false) when the file is absent.
func readExpectedFingerprint(dataDir string) (string, bool) {
	raw, err := os.ReadFile(filepath.Join(dataDir, walletFingerprintName))
	if err != nil {
		return "", false
	}
	fp := strings.TrimSpace(string(raw))
	if fp == "" {
		return "", false
	}
	return fp, true
}

func cmdWalletChangePassphrase(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("wallet change-passphrase", flag.ContinueOnError)
	var dataDirFlag, oldPass, newPass string
	fs.StringVar(&dataDirFlag, "data-dir", "", "Directory containing wallet.dat.")
	fs.StringVar(&oldPass, "wallet-passphrase", "",
		"Current wallet passphrase (or OTEDAMA_WALLET_PASSPHRASE).")
	fs.StringVar(&newPass, "new-passphrase", "",
		"New wallet passphrase (or OTEDAMA_WALLET_NEW_PASSPHRASE).")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	if oldPass == "" {
		oldPass = os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	}
	if newPass == "" {
		newPass = os.Getenv("OTEDAMA_WALLET_NEW_PASSPHRASE")
	}
	dataDir := resolveDataDir(dataDirFlag)
	if dataDir == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: cannot resolve data directory; pass --data-dir")
		return exitUsage
	}
	if oldPass == "" || newPass == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: both the current "+
			"(--wallet-passphrase / OTEDAMA_WALLET_PASSPHRASE) and new "+
			"(--new-passphrase / OTEDAMA_WALLET_NEW_PASSPHRASE) passphrases are required.")
		return exitUsage
	}

	// Guard the auto-create behaviour documented at the top of the file:
	// without an existing wallet.dat there is nothing to rotate.
	if _, err := os.Stat(filepath.Join(dataDir, walletDatName)); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: no wallet.dat in %s\n", dataDir)
		return exitRuntime
	}

	wordList, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	wm, err := lightning.NewWalletManager(dataDir, oldPass, nil, wordList)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	if err := wm.ChangePassphrase(oldPass, newPass, nil); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintf(stdout, "wallet passphrase changed (fingerprint %s unchanged — same seed)\n", wm.Fingerprint())
	return exitOK
}
