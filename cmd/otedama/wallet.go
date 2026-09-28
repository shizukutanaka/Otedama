// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

// The `wallet` subcommand: wallet management without starting the engine.
//   otedama wallet verify             — confirm a written-down recovery
//                                       phrase derives to the same seed as
//                                       the stored wallet, by fingerprint
//   otedama wallet change-passphrase  — re-encrypt wallet.dat under a new
//                                       passphrase
//
// Secrets are never accepted on argv: process lists (ps aux) expose them to
// every local process. Passphrases come from the OTEDAMA_WALLET_PASSPHRASE /
// OTEDAMA_WALLET_NEW_PASSPHRASE / OTEDAMA_WALLET_MNEMONIC_PASSPHRASE
// environment variables (the convention docs/API.md already documents for
// `run`), and the recovery phrase is read from stdin. See
// docs/KNOWN_LIMITATIONS.md §16 for the motivation.

package main

import (
	"bufio"
	"crypto/subtle"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/lightning"
)

// cmdWallet dispatches `otedama wallet <verb>`. stdin is a parameter (rather
// than os.Stdin read directly) so tests can feed it a strings.Reader.
func cmdWallet(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printWalletUsage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "verify":
		return cmdWalletVerify(args[1:], stdin, stdout, stderr)
	case "change-passphrase":
		return cmdWalletChangePassphrase(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "otedama: unknown wallet subcommand %q\n", args[0])
		printWalletUsage(stderr)
		return exitUsage
	}
}

func printWalletUsage(w io.Writer) {
	fmt.Fprint(w, `otedama wallet — manage the Lightning wallet.

Usage:
  otedama wallet <verb> [flags]

Verbs:
  verify             Check that a written-down recovery phrase derives to the
                     same seed as the stored wallet. Reads the phrase from
                     stdin (never argv — process lists leak it) and compares
                     public fingerprints, so wallet.dat is never decrypted.
  change-passphrase  Re-encrypt wallet.dat under a new passphrase.

Environment variables:
  OTEDAMA_WALLET_PASSPHRASE           Current wallet passphrase
                                      (change-passphrase; also lets verify
                                      fall back to decrypting wallet.dat when
                                      wallet.fingerprint is absent).
  OTEDAMA_WALLET_NEW_PASSPHRASE       New passphrase (change-passphrase).
  OTEDAMA_WALLET_MNEMONIC_PASSPHRASE  BIP-39 "25th word" used at wallet
                                      creation (verify, only when set then).
  OTEDAMA_DATA_DIR                    Wallet directory (see also --data-dir).

Flags for both verbs:
  --data-dir <dir>    Directory for persistent data.
  --config <path>     Path to config.yaml (data_dir is honored from it).
`)
}

// walletFlags are the flags shared by both wallet verbs.
type walletFlags struct {
	dataDir    string
	configFile string
}

// parseWalletFlags parses the shared flags for one wallet verb, routing
// --help output to stdout exactly like every other subcommand.
func parseWalletFlags(verb string, args []string, stdout, stderr io.Writer) (walletFlags, bool, int) {
	fs := flag.NewFlagSet("wallet "+verb, flag.ContinueOnError)
	var f walletFlags
	fs.StringVar(&f.dataDir, "data-dir", "", "Directory for persistent data.")
	fs.StringVar(&f.configFile, "config", "", "Path to config.yaml (optional).")
	ok, code := parseSubcommandFlags(fs, args, stdout, stderr)
	return f, ok, code
}

// walletDataDir resolves the wallet directory through the same four-layer
// precedence as `run` (flag > OTEDAMA_DATA_DIR > config.yaml > platform
// default), so a user who configured a custom location does not need to
// repeat it — and one who never did still lands in the right place.
func walletDataDir(f walletFlags, stderr io.Writer) string {
	cfg := config.Resolve(loadConfigFile(f.configFile, stderr), nil,
		config.FlagValues{DataDir: f.dataDir})
	return cfg.DataDir
}

// cmdWalletVerify implements `otedama wallet verify`: derive the seed from a
// recovery phrase read from stdin and compare its public fingerprint with the
// stored wallet's. The mnemonic itself is checksum-validated first so a
// transcription slip reports "invalid phrase" rather than a silent mismatch.
func cmdWalletVerify(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	f, ok, code := parseWalletFlags("verify", args, stdout, stderr)
	if !ok {
		return code
	}
	dataDir := walletDataDir(f, stderr)

	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama: %v\n", err)
		return exitRuntime
	}
	wantFP, err := walletFingerprint(dataDir, os.Getenv("OTEDAMA_WALLET_PASSPHRASE"), wl)
	if err != nil {
		fmt.Fprintf(stderr, "otedama: %v\n", err)
		return exitRuntime
	}

	line, err := readSecretLine(stdin, stderr, "Recovery phrase: ")
	if err != nil {
		fmt.Fprintf(stderr, "otedama: read recovery phrase: %v\n", err)
		return exitRuntime
	}
	m := lightning.Mnemonic(strings.Fields(line))
	if _, err := lightning.MnemonicToEntropy(m, wl); err != nil {
		fmt.Fprintf(stderr, "otedama: invalid recovery phrase: %v\n", err)
		return exitRuntime
	}
	seed := lightning.MnemonicToSeed(m, os.Getenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE"))
	gotFP := lightning.Fingerprint(seed)
	if subtle.ConstantTimeCompare([]byte(gotFP), []byte(wantFP)) != 1 {
		fmt.Fprintf(stderr,
			"otedama: recovery phrase does NOT match this wallet\n  derived fingerprint: %s\n  wallet fingerprint:  %s\n",
			gotFP, wantFP)
		return exitRuntime
	}
	fmt.Fprintf(stdout, "recovery phrase verified — wallet fingerprint %s\n", gotFP)
	return exitOK
}

// walletFingerprint returns the stored wallet's public fingerprint, preferring
// the wallet.fingerprint file written at creation (no decryption needed) and
// falling back to unlocking wallet.dat with passphrase when the file is absent.
func walletFingerprint(dataDir, passphrase string, wl *lightning.WordList) (string, error) {
	if raw, err := os.ReadFile(lightning.FingerprintFilePath(dataDir)); err == nil {
		return string(raw), nil
	}
	// Stat first: NewWalletManager's contract is "create when absent", which
	// a verification command must never trigger.
	if _, err := os.Stat(lightning.WalletFilePath(dataDir)); err != nil {
		return "", fmt.Errorf("no wallet found under %s", dataDir)
	}
	if passphrase == "" {
		return "", fmt.Errorf("wallet.fingerprint is missing under %s; "+
			"set OTEDAMA_WALLET_PASSPHRASE to verify against wallet.dat directly", dataDir)
	}
	wm, err := lightning.NewWalletManager(dataDir, passphrase, nil, wl)
	if err != nil {
		return "", err
	}
	return wm.Fingerprint(), nil
}

// cmdWalletChangePassphrase implements `otedama wallet change-passphrase`:
// unlock the wallet with OTEDAMA_WALLET_PASSPHRASE and re-encrypt it under
// OTEDAMA_WALLET_NEW_PASSPHRASE via the already-tested ChangePassphrase.
func cmdWalletChangePassphrase(args []string, stdout, stderr io.Writer) int {
	f, ok, code := parseWalletFlags("change-passphrase", args, stdout, stderr)
	if !ok {
		return code
	}
	dataDir := walletDataDir(f, stderr)

	// Stat first: NewWalletManager creates a wallet when wallet.dat is
	// absent, which would silently rotate a brand-new empty wallet instead
	// of the user's real one.
	if _, err := os.Stat(lightning.WalletFilePath(dataDir)); err != nil {
		fmt.Fprintf(stderr, "otedama: no wallet found at %s\n",
			lightning.WalletFilePath(dataDir))
		return exitRuntime
	}
	old := os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	if old == "" {
		fmt.Fprintf(stderr, "otedama: set OTEDAMA_WALLET_PASSPHRASE to the current "+
			"passphrase (never on argv — process lists expose it)\n")
		return exitUsage
	}
	newPass := os.Getenv("OTEDAMA_WALLET_NEW_PASSPHRASE")
	if newPass == "" {
		fmt.Fprintf(stderr, "otedama: set OTEDAMA_WALLET_NEW_PASSPHRASE to the new passphrase\n")
		return exitUsage
	}

	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama: %v\n", err)
		return exitRuntime
	}
	wm, err := lightning.NewWalletManager(dataDir, old, nil, wl)
	if err != nil {
		fmt.Fprintf(stderr, "otedama: %v\n", err)
		return exitRuntime
	}
	if err := wm.ChangePassphrase(old, newPass, nil); err != nil {
		fmt.Fprintf(stderr, "otedama: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintf(stdout, "wallet passphrase updated — fingerprint %s\n", wm.Fingerprint())
	return exitOK
}

// readSecretLine reads one line from stdin holding a secret value (recovery
// phrase). The prompt goes to stderr, only when stdin is a real terminal, so
// piped invocations stay clean and captured output never sees it.
func readSecretLine(stdin io.Reader, stderr io.Writer, prompt string) (string, error) {
	if f, ok := stdin.(*os.File); ok && isTerminal(f) {
		fmt.Fprint(stderr, prompt)
	}
	return bufio.NewReader(stdin).ReadString('\n')
}
