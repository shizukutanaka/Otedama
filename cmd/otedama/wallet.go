// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/lightning"
	"github.com/shizukutanaka/Otedama/internal/tui"
)

// walletFile and walletFingerprintFile mirror the constants in
// internal/lightning/wallet.go. Duplicating the two filenames (the same
// approach doctor/checks.go takes) keeps cmd/otedama able to inspect the
// data directory without reaching into unexported package state; the
// values are part of the on-disk format, not implementation details.
const (
	walletFile            = "wallet.dat"
	walletFingerprintFile = "wallet.fingerprint"
)

// cmdWallet dispatches the wallet subcommands.
//
//	otedama wallet verify            — confirm a written-down recovery
//	                                  phrase actually matches wallet.dat
//	otedama wallet change-passphrase — re-encrypt wallet.dat with a new
//	                                  passphrase
func cmdWallet(args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	if len(args) == 0 {
		printWalletUsage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "verify":
		return cmdWalletVerify(args[1:], stdout, stderr, stdin)
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
  otedama wallet verify              Check a recovery phrase against the stored wallet.
  otedama wallet change-passphrase   Re-encrypt wallet.dat with a new passphrase.

Both commands locate the wallet via --data-dir, --config, or the platform
default. Secrets are read from stdin (verify) or from
OTEDAMA_WALLET_PASSPHRASE / OTEDAMA_WALLET_NEW_PASSPHRASE /
OTEDAMA_WALLET_MNEMONIC_PASSPHRASE; the corresponding flags exist but are
visible in process lists.
`)
}

// walletDataDir resolves the wallet directory through the same layering
// `run` and `doctor` use: --data-dir flag > config file data_dir >
// OTEDAMA_DATA_DIR > platform default.
func walletDataDir(configFile, dataDirFlag string, stderr io.Writer) string {
	fromFile := loadConfigFile(configFile, stderr)
	cfg := config.Resolve(fromFile, nil, config.FlagValues{DataDir: dataDirFlag})
	return cfg.DataDir
}

// storedFingerprint returns the public fingerprint recorded for the
// wallet in dataDir. The plaintext wallet.fingerprint sidecar is tried
// first; when it is absent (it is written best-effort at creation and can
// be lost independently of wallet.dat) the wallet itself is decrypted
// with passphrase and the fingerprint recomputed from the seed — the
// fingerprint is a pure function of the seed, so both paths agree.
//
// wallet.dat must exist either way: the sidecar is only a cache of the
// wallet's identity, so trusting it alone would report a successful
// "match" against a wallet that is not actually there.
func storedFingerprint(dataDir, passphrase string) (string, error) {
	walletPath := filepath.Join(dataDir, walletFile)
	raw, err := os.ReadFile(walletPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("no wallet found in %s", dataDir)
		}
		return "", fmt.Errorf("cannot read %s: %w", walletPath, err)
	}
	// Verify is a recovery rehearsal: the phrase must recover THIS wallet.
	// An unparseable wallet.dat can never be recovered — report it broken
	// even when the fingerprint sidecar (a cache of its identity) is intact.
	es, err := lightning.UnmarshalEncryptedSeed(raw)
	if err != nil {
		return "", fmt.Errorf("unmarshal wallet: %w", err)
	}
	fpPath := filepath.Join(dataDir, walletFingerprintFile)
	if raw, err := os.ReadFile(fpPath); err == nil {
		if fp := strings.TrimSpace(string(raw)); fp != "" {
			return fp, nil
		}
	}
	if passphrase == "" {
		return "", fmt.Errorf("%s is missing; supply --wallet-passphrase or OTEDAMA_WALLET_PASSPHRASE to derive the fingerprint from %s", walletFingerprintFile, walletFile)
	}
	seed, err := lightning.DecryptSeed(es, passphrase)
	if err != nil {
		return "", fmt.Errorf("wallet unlock failed — check your passphrase")
	}
	return lightning.Fingerprint(seed), nil
}

// cmdWalletVerify checks a recovery phrase the user wrote down against
// the stored wallet, closing the gap where a transcription error is only
// discovered during an actual recovery — when it is too late. The phrase
// is read from stdin (never argv, which leaks via process lists) and
// validated with the BIP-39 checksum before any comparison, so a typo is
// reported as "malformed" rather than an opaque fingerprint mismatch.
//
// Exit codes: 0 phrase matches the stored wallet; exitUsage the phrase
// is malformed; exitRuntime the wallet cannot be read or the phrase is
// valid but belongs to a different wallet.
func cmdWalletVerify(args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	fs := flag.NewFlagSet("wallet verify", flag.ContinueOnError)
	configFile := fs.String("config", "", "Path to config.yaml (optional).")
	dataDirFlag := fs.String("data-dir", "", "Directory holding wallet.dat.")
	walletPass := fs.String("wallet-passphrase", "",
		"Wallet decryption passphrase. Only needed when wallet.fingerprint is missing; "+
			"prefer OTEDAMA_WALLET_PASSPHRASE (the flag is visible in process lists).")
	mnPass := fs.String("mnemonic-passphrase", "",
		"BIP-39 \"25th word\" used when the wallet was created, if any; "+
			"prefer OTEDAMA_WALLET_MNEMONIC_PASSPHRASE.")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	if *walletPass == "" {
		*walletPass = os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	}
	if *mnPass == "" {
		*mnPass = os.Getenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE")
	}

	// The phrase is secret input: prompt on stderr (stdout stays
	// machine-clean) and only when a human is actually at a terminal.
	// tui.IsTerminal rather than the local isTerminal: the latter keys on
	// os.ModeCharDevice, which /dev/null also sets — a piped-away stdin
	// would still print the prompt.
	if f, ok := stdin.(*os.File); ok && tui.IsTerminal(f) {
		fmt.Fprint(stderr, "Enter recovery phrase, then press Enter followed by Ctrl+D: ")
	}
	// A BIP-39 phrase is at most 24 short words; a generous bound keeps a
	// stray or hostile pipe from producing an unbounded read.
	raw, err := io.ReadAll(io.LimitReader(stdin, 4096))
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: cannot read stdin: %v\n", err)
		return exitRuntime
	}
	mnemonic := lightning.Mnemonic(strings.Fields(string(raw)))

	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitRuntime
	}
	if _, err := lightning.MnemonicToEntropy(mnemonic, wl); err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitUsage
	}
	dataDir := walletDataDir(*configFile, *dataDirFlag, stderr)
	expected, err := storedFingerprint(dataDir, *walletPass)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitRuntime
	}
	got := lightning.Fingerprint(lightning.MnemonicToSeed(mnemonic, *mnPass))
	if got != expected {
		fmt.Fprintf(stderr, "otedama wallet verify: MISMATCH — this phrase does not recover the wallet in %s (expected fingerprint %s, got %s)\n",
			dataDir, expected, got)
		return exitRuntime
	}
	fmt.Fprintf(stdout, "recovery phrase verified — fingerprint %s matches %s\n", got, filepath.Join(dataDir, walletFile))
	return exitOK
}

// cmdWalletChangePassphrase wires the existing, already-tested
// lightning.WalletManager.ChangePassphrase to the CLI so a user whose
// passphrase may have been exposed can rotate it without writing a Go
// program against the internal package.
func cmdWalletChangePassphrase(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("wallet change-passphrase", flag.ContinueOnError)
	configFile := fs.String("config", "", "Path to config.yaml (optional).")
	dataDirFlag := fs.String("data-dir", "", "Directory holding wallet.dat.")
	oldPass := fs.String("old-passphrase", "",
		"Current wallet passphrase; prefer OTEDAMA_WALLET_PASSPHRASE (the flag is visible in process lists).")
	newPass := fs.String("new-passphrase", "",
		"New wallet passphrase; prefer OTEDAMA_WALLET_NEW_PASSPHRASE.")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	if *oldPass == "" {
		*oldPass = os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	}
	if *newPass == "" {
		*newPass = os.Getenv("OTEDAMA_WALLET_NEW_PASSPHRASE")
	}
	if *oldPass == "" || *newPass == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: both --old-passphrase and --new-passphrase are required")
		return exitUsage
	}

	dataDir := walletDataDir(*configFile, *dataDirFlag, stderr)
	// Guard before NewWalletManager: it CREATES a wallet when wallet.dat
	// is absent, which would silently mint an empty wallet under the new
	// passphrase instead of re-encrypting the real one.
	if _, err := os.Stat(filepath.Join(dataDir, walletFile)); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: no wallet found in %s\n", dataDir)
		return exitRuntime
	}
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	wm, err := lightning.NewWalletManager(dataDir, *oldPass, nil, wl)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	if err := wm.ChangePassphrase(*oldPass, *newPass, nil); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintf(stdout, "wallet passphrase changed (fingerprint %s, wallet.dat unchanged otherwise)\n", wm.Fingerprint())
	return exitOK
}
