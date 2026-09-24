// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// `otedama wallet` — maintenance commands for the non-custodial wallet.
//
// Subcommands:
//
//	verify             Re-enter the recovery phrase; proves the backup
//	                   written down at first run actually recovers this
//	                   wallet (docs/KNOWN_LIMITATIONS.md §16).
//	change-passphrase  Re-encrypt wallet.dat with a new passphrase.
//
// Security contract: secrets (the recovery phrase, passphrases) are read
// from stdin or OTEDAMA_* environment variables — never from argv, which
// is world-visible in `ps`. When stdin is a terminal, echo is muted while
// secrets are read (termecho_*.go). Nothing entered here is logged.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/lightning"
)

// wallet.dat / wallet.fingerprint names mirror the unexported constants
// in internal/lightning/wallet.go — the same duplication
// internal/doctor/checks.go already performs for its wallet check.
const (
	walletDatFile         = "wallet.dat"
	walletFingerprintFile = "wallet.fingerprint"
)

// exitVerifyFail extends the shared 0/1/64/78 scale with a code for
// "the check ran cleanly to completion and FAILED" — a valid mnemonic
// that does not match this wallet, a wrong current passphrase, or a
// new/confirm mismatch. It mirrors the doctor subcommand's "check
// failed" code so scripts can distinguish "verification failed" (2)
// from "could not attempt verification" (1/64/78).
const exitVerifyFail = 2

// errNoInput means stdin ended before any input arrived.
var errNoInput = errors.New("no input on stdin")

func cmdWallet(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "otedama wallet: expected subcommand (verify|change-passphrase)")
		return exitUsage
	}
	switch args[0] {
	case "verify":
		return cmdWalletVerify(args[1:], stdin, stdout, stderr)
	case "change-passphrase":
		return cmdWalletChangePassphrase(args[1:], stdin, stdout, stderr)
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
  otedama wallet verify              [--data-dir DIR] [--config FILE]
  otedama wallet change-passphrase   [--data-dir DIR] [--config FILE]

verify: reads a BIP-39 recovery phrase from stdin (never argv), re-derives
the seed, and compares its fingerprint against the wallet's stored
fingerprint — proof that the written backup recovers this wallet. If the
wallet was created with a BIP-39 "25th-word" passphrase, supply it via
OTEDAMA_WALLET_MNEMONIC_PASSPHRASE (the same env var run uses).

change-passphrase: reads three lines from stdin — current passphrase, new
passphrase, new passphrase again — and re-encrypts wallet.dat atomically.
It never creates a wallet.

Exit codes: 0 success · 2 verification failed (mismatch or wrong
passphrase) · 64 usage error · 78 invalid input · 1 runtime error.
`)
}

// walletFlags builds the flag set shared by the wallet subcommands.
// Secrets are never flags — see the file-level security contract.
func walletFlags(name string, configFile, dataDir *string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.StringVar(configFile, "config", "", "Path to config.yaml (used to resolve data_dir).")
	fs.StringVar(dataDir, "data-dir", "", "Directory holding wallet.dat (default: platform data dir).")
	return fs
}

// resolveWalletDir applies the standard flag > env > file > default
// precedence to find the data directory, so `wallet` operates on the
// same wallet.dat `run` created.
func resolveWalletDir(configPath, dataDir string, stderr io.Writer) string {
	fromFile := loadConfigFile(configPath, stderr)
	return config.Resolve(fromFile, nil, config.FlagValues{DataDir: dataDir}).DataDir
}

// ----- verify -----

func cmdWalletVerify(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	var configFile, dataDir string
	fs := walletFlags("wallet verify", &configFile, &dataDir)
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	dir := resolveWalletDir(configFile, dataDir, stderr)
	if dir == "" {
		fmt.Fprintln(stderr, "otedama wallet verify: cannot determine a data directory — pass --data-dir, set OTEDAMA_DATA_DIR, or set data_dir in config.yaml")
		return exitConfig
	}
	words, err := readMnemonic(stdin, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		if errors.Is(err, errNoInput) {
			return exitUsage
		}
		return exitRuntime
	}
	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: wordlist: %v\n", err)
		return exitRuntime
	}
	// MnemonicToEntropy validates the word count and the embedded BIP-39
	// checksum — a transcription typo fails here, before any fingerprint
	// comparison, with a specific diagnostic.
	if _, err := lightning.MnemonicToEntropy(words, wl); err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: invalid recovery phrase: %v\n", err)
		return exitConfig
	}
	seed := lightning.MnemonicToSeed(words, os.Getenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE"))
	fp := lightning.Fingerprint(seed)

	stored, err := storedFingerprint(dir, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitRuntime
	}
	// The fingerprint is a deliberately public value (HMAC-derived, see
	// lightning.Fingerprint) — a plain string comparison is fine.
	if fp == stored {
		fmt.Fprintf(stdout, "verified: recovery phrase matches wallet fingerprint %s\n", fp)
		return exitOK
	}
	fmt.Fprintf(stderr, "otedama wallet verify: MISMATCH — the phrase entered derives fingerprint %s, but the wallet in %s has fingerprint %s\n", fp, dir, stored)
	return exitVerifyFail
}

// storedFingerprint returns the wallet's public fingerprint. The fast
// path reads wallet.fingerprint (written at wallet creation for exactly
// this purpose). When that file is absent — the creation write is
// best-effort — it falls back to decrypting wallet.dat with
// OTEDAMA_WALLET_PASSPHRASE.
func storedFingerprint(dir string, stderr io.Writer) (string, error) {
	fpPath := filepath.Join(dir, walletFingerprintFile)
	raw, err := os.ReadFile(fpPath)
	switch {
	case err == nil:
		if fp := strings.TrimSpace(string(raw)); fp != "" {
			return fp, nil
		}
		// Empty file: fall through to the wallet.dat path.
	case os.IsNotExist(err):
		// Fall through to the wallet.dat path.
	default:
		return "", fmt.Errorf("read %s: %w", fpPath, err)
	}
	pass := os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	if pass == "" {
		return "", fmt.Errorf("fingerprint file %s is missing or empty; set OTEDAMA_WALLET_PASSPHRASE to verify against wallet.dat directly", fpPath)
	}
	fmt.Fprintln(stderr, "otedama wallet verify: fingerprint file missing — verifying against wallet.dat")
	seed, err := loadWalletSeed(dir, pass)
	if err != nil {
		return "", err
	}
	return lightning.Fingerprint(seed), nil
}

// loadWalletSeed decrypts wallet.dat directly — used only when the
// public fingerprint sidecar is unavailable.
func loadWalletSeed(dir, passphrase string) (lightning.Seed, error) {
	raw, err := os.ReadFile(filepath.Join(dir, walletDatFile))
	if err != nil {
		return lightning.Seed{}, fmt.Errorf("read wallet file: %w", err)
	}
	es, err := lightning.UnmarshalEncryptedSeed(raw)
	if err != nil {
		return lightning.Seed{}, fmt.Errorf("unmarshal wallet: %w", err)
	}
	seed, err := lightning.DecryptSeed(es, passphrase)
	if err != nil {
		// DecryptSeed's error is deliberately opaque (oracle protection);
		// say what the user can actually act on.
		return lightning.Seed{}, errors.New("wallet decrypt failed — check OTEDAMA_WALLET_PASSPHRASE")
	}
	return seed, nil
}

// ----- change-passphrase -----

func cmdWalletChangePassphrase(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	var configFile, dataDir string
	fs := walletFlags("wallet change-passphrase", &configFile, &dataDir)
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	dir := resolveWalletDir(configFile, dataDir, stderr)
	if dir == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: cannot determine a data directory — pass --data-dir, set OTEDAMA_DATA_DIR, or set data_dir in config.yaml")
		return exitConfig
	}

	// Deliberately do NOT auto-create a wallet: NewWalletManager would
	// silently generate a fresh seed in an empty directory, destroying
	// the "change the passphrase on THIS wallet" contract — and a user
	// mistyping --data-dir would end up rotating a brand-new empty wallet
	// while believing the real one was secured.
	if _, err := os.Stat(filepath.Join(dir, walletDatFile)); err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintf(stderr, "otedama wallet change-passphrase: no wallet.dat in %s — start the engine once with --wallet-passphrase to create one\n", dir)
		} else {
			fmt.Fprintf(stderr, "otedama wallet change-passphrase: stat wallet: %v\n", err)
		}
		return exitRuntime
	}

	lines, err := readSecretLines(stdin, stderr,
		"Current passphrase: ", "New passphrase: ", "Confirm new passphrase: ")
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		if errors.Is(err, errNoInput) {
			return exitUsage
		}
		return exitRuntime
	}
	oldPass, newPass, confirm := lines[0], lines[1], lines[2]
	if newPass == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: new passphrase must not be empty")
		return exitConfig
	}
	if newPass != confirm {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: new passphrase and confirmation do not match")
		return exitVerifyFail
	}

	wl, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: wordlist: %v\n", err)
		return exitRuntime
	}
	// NewWalletManager verifies the old passphrase by decrypting
	// wallet.dat; wallet.dat is known to exist (stated above), so it
	// cannot take the create-new path here.
	wm, err := lightning.NewWalletManager(dir, oldPass, nil, wl)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitVerifyFail
	}
	if err := wm.ChangePassphrase(oldPass, newPass, nil); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintf(stdout, "wallet passphrase updated (fingerprint %s)\n", wm.Fingerprint())
	return exitOK
}

// ----- secret input helpers -----

// isTTY reports whether stdin is a real terminal (an *os.File that is a
// character device), so prompts and echo-muting engage only for
// interactive use and piped input stays silent.
func isTTY(stdin io.Reader) bool {
	f, ok := stdin.(*os.File)
	return ok && isTerminal(f)
}

// muteIfTerminal disables echo on stdin when it is a real terminal and
// returns a restore function (a no-op otherwise). It never fails hard —
// a platform without echo control just warns and reads normally.
func muteIfTerminal(stdin io.Reader, stderr io.Writer) func() {
	f, ok := stdin.(*os.File)
	if !ok || !isTerminal(f) {
		return func() {}
	}
	restore, err := disableEcho(f)
	if err != nil {
		fmt.Fprintf(stderr, "warning: cannot mute terminal echo on this platform: %v\n", err)
		return func() {}
	}
	return restore
}

// readMnemonic consumes ALL of stdin and splits it into words. The
// phrase may be pasted on one line or spread across several; every
// whitespace-separated token is taken, lowercased to match the
// lowercase BIP-39 list. On a terminal the echo is muted for the read
// and a hint is printed to stderr.
func readMnemonic(stdin io.Reader, stderr io.Writer) (lightning.Mnemonic, error) {
	if isTTY(stdin) {
		fmt.Fprintln(stderr, "Recovery phrase (input is muted — paste it, then press Enter and Ctrl-D):")
	}
	restore := muteIfTerminal(stdin, stderr)
	defer restore()
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return nil, fmt.Errorf("read stdin: %w", err)
	}
	fields := strings.Fields(strings.ToLower(string(raw)))
	if len(fields) == 0 {
		return nil, errNoInput
	}
	return lightning.Mnemonic(fields), nil
}

// readSecretLines reads exactly len(prompts) lines from stdin. On a
// terminal each prompt is printed to stderr and echo is muted for the
// whole sequence; since Enter does not echo while muted, a newline is
// written to stderr after each entry to keep the display aligned.
// Piped input prints no prompts.
func readSecretLines(stdin io.Reader, stderr io.Writer, prompts ...string) ([]string, error) {
	tty := isTTY(stdin)
	restore := muteIfTerminal(stdin, stderr)
	defer restore()
	br := bufio.NewReader(stdin)
	lines := make([]string, 0, len(prompts))
	for _, prompt := range prompts {
		if tty {
			fmt.Fprint(stderr, prompt)
		}
		line, err := br.ReadString('\n')
		if tty {
			fmt.Fprintln(stderr)
		}
		switch {
		case err == nil:
			lines = append(lines, strings.TrimRight(line, "\r\n"))
		case errors.Is(err, io.EOF) && line != "":
			// Last line without a trailing newline still counts.
			lines = append(lines, strings.TrimRight(line, "\r\n"))
		case errors.Is(err, io.EOF):
			// stdin ended before this prompt — missing input, caught by
			// the length check below.
		default:
			return nil, fmt.Errorf("read stdin: %w", err)
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	if len(lines) < len(prompts) {
		return nil, fmt.Errorf("stdin ended early: expected %d input lines, got %d: %w", len(prompts), len(lines), errNoInput)
	}
	return lines, nil
}
