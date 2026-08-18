// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// The `wallet` subcommand: operations on the local Lightning wallet that
// are not part of a mining run.
//
// # Why `wallet verify` exists
//
// Otedama prints the BIP-39 recovery phrase exactly once, when the wallet
// is created, and deliberately never persists it (engine.printRecoveryPhrase;
// derivation is one-way, so it cannot be recovered from wallet.dat
// afterwards). That is the correct handling of the secret — but until this
// command existed, it left the user unable to answer the only question that
// matters about a backup: *did I write it down correctly?*
//
// A transcription error is silent. Nothing detects it, no metric reflects
// it, and it surfaces at exactly one moment: a recovery attempt, after the
// disk has already failed. The whole non-custodial guarantee rests on a
// phrase whose correctness the user could not check. Verification has to
// happen while the user still holds both the phrase and a working wallet,
// which is what this command does (docs/KNOWN_LIMITATIONS.md §16).
//
// # How the secret is handled
//
// The mnemonic is read from stdin, never from argv: command-line arguments
// are visible to every process on the machine via /proc and `ps`, and land
// in shell history. The wallet encryption passphrase comes from
// OTEDAMA_WALLET_PASSPHRASE for the same reason — the same source `run`
// already documents as preferred over its flag.
//
// The comparison is on the 64-byte seeds, not on the 8-hex-character
// fingerprints, and uses crypto/subtle. Fingerprints are public by design
// and comparing them would prove only 32 bits; the seeds are already in
// memory, so comparing them is both stronger and free. The fingerprint is
// still printed, because it is what the user can cross-check against
// `otedama doctor` and against the value shown at wallet creation.
//
// Nothing is written: verify opens the existing wallet read-only and
// refuses to run when no wallet exists, rather than letting
// lightning.NewWalletManager take its create-a-new-wallet path.

package main

import (
	"bufio"
	"crypto/subtle"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/lightning"
)

// walletDatFile mirrors the unexported constant in internal/lightning. It is
// used only to check for existence before calling NewWalletManager, which
// would otherwise create a wallet when none is present — a side effect a
// verify command must not have.
const walletDatFile = "wallet.dat"

func cmdWallet(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printWalletUsage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "verify":
		return cmdWalletVerify(args[1:], stdout, stderr, os.Stdin)
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
	fmt.Fprint(w, `Otedama wallet — operations on the local Lightning wallet.

Usage:
  otedama wallet <command> [flags]

Commands:
  verify     Check a written-down recovery phrase against the stored wallet.
  help       Print this help and exit.

otedama wallet verify [--config path] [--data-dir path]

  Reads the recovery phrase from standard input, derives its seed, and
  compares that seed with the one in wallet.dat. Nothing is written and
  the phrase is never echoed back, logged, or stored.

  The wallet encryption passphrase must be in OTEDAMA_WALLET_PASSPHRASE.
  If the wallet was created with a BIP-39 "25th word", put it in
  OTEDAMA_WALLET_MNEMONIC_PASSPHRASE — without it the seed will not match.

  Your terminal will echo the phrase as you type it. To avoid that, pipe
  it in from a file you then delete, or run 'stty -echo' first.

Exit codes:
  0   the phrase reproduces the stored wallet
  1   it does not, or the wallet could not be opened
  64  usage error
  78  config error (no data dir, no wallet, missing passphrase)
`)
}

func cmdWalletVerify(args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	fs := flag.NewFlagSet("wallet verify", flag.ContinueOnError)
	configFile := fs.String("config", "", "Path to config.yaml.")
	dataDir := fs.String("data-dir", "", "Data directory holding wallet.dat.")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}

	// Same layering as run/doctor, so --data-dir, OTEDAMA_DATA_DIR and
	// data_dir in the config file all point this command at the same
	// directory the engine uses.
	cfg := config.Resolve(loadConfigFile(*configFile, stderr), nil, config.FlagValues{DataDir: *dataDir})
	if cfg.DataDir == "" {
		fmt.Fprintln(stderr, "otedama wallet verify: no data directory could be determined; pass --data-dir")
		return exitConfig
	}
	walletPath := filepath.Join(cfg.DataDir, walletDatFile)
	if _, err := os.Stat(walletPath); err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: no wallet at %s: %v\n", walletPath, err)
		fmt.Fprintln(stderr, "There is nothing to verify against. A wallet is created by "+
			"`otedama run` when --wallet-passphrase or OTEDAMA_WALLET_PASSPHRASE is set.")
		return exitConfig
	}

	passphrase := os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	if passphrase == "" {
		fmt.Fprintln(stderr, "otedama wallet verify: OTEDAMA_WALLET_PASSPHRASE is not set.")
		fmt.Fprintln(stderr, "It is required to open the stored wallet, and is read from the "+
			"environment rather than a flag so it does not appear in process lists.")
		return exitConfig
	}

	fmt.Fprintln(stdout, "Enter your recovery phrase, then press Enter.")
	fmt.Fprintln(stdout, "(It will be echoed by your terminal. Nothing is written to disk or logged.)")
	words, err := readMnemonic(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: %v\n", err)
		return exitConfig
	}

	wordList, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: wordlist: %v\n", err)
		return exitRuntime
	}
	// MnemonicToEntropy validates the word count, every word's membership in
	// the list, and the BIP-39 checksum. Running it first means the common
	// failures — a misspelled or dropped word — are reported as exactly that,
	// rather than as an opaque "does not match".
	if _, err := lightning.MnemonicToEntropy(words, wordList); err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: the phrase is not a valid BIP-39 mnemonic: %v\n", err)
		fmt.Fprintln(stderr, "Check the word count (12/15/18/21/24) and the spelling of each word.")
		return exitRuntime
	}

	derived := lightning.MnemonicToSeed(words, os.Getenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE"))

	wm, err := lightning.NewWalletManager(cfg.DataDir, passphrase, nil, wordList)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet verify: cannot open %s: %v\n", walletPath, err)
		return exitRuntime
	}
	stored := wm.Seed()

	// Both operands are secret, so compare in constant time. The fingerprints
	// printed below are public and safe to show either way.
	if subtle.ConstantTimeCompare(derived[:], stored[:]) != 1 {
		fmt.Fprintf(stdout, "\nMISMATCH — this phrase does not reproduce the stored wallet.\n\n")
		fmt.Fprintf(stdout, "  stored wallet fingerprint:  %s\n", lightning.Fingerprint(stored))
		fmt.Fprintf(stdout, "  phrase you entered derives: %s\n\n", lightning.Fingerprint(derived))
		fmt.Fprintln(stdout, "The phrase is a valid BIP-39 mnemonic, so the words themselves are")
		fmt.Fprintln(stdout, "spelled correctly and in a self-consistent order — but they are not")
		fmt.Fprintln(stdout, "this wallet's. Two things commonly cause that: the words are in the")
		fmt.Fprintln(stdout, "wrong order, or the wallet was created with a BIP-39 \"25th word\"")
		fmt.Fprintln(stdout, "that is not in OTEDAMA_WALLET_MNEMONIC_PASSPHRASE.")
		return exitRuntime
	}

	fmt.Fprintf(stdout, "\nMATCH — this phrase reproduces the stored wallet.\n\n")
	fmt.Fprintf(stdout, "  fingerprint: %s\n\n", lightning.Fingerprint(stored))
	fmt.Fprintln(stdout, "Your backup is correct. Keep it offline; anyone holding it holds your funds.")
	return exitOK
}

// readMnemonic reads a BIP-39 phrase from the first line of r.
//
// One line, whatever whitespace separates the words. Reading to EOF instead
// would let a phrase span lines, but it would also make the interactive case
// require Ctrl-D after pressing Enter, and stopping early at "enough words"
// cannot work either: 12 is a valid BIP-39 length, so a 24-word phrase would
// be silently truncated at half and reported as a mismatch. A line is the
// unit the user already ends by pressing Enter, and it is equally natural for
// `otedama wallet verify < phrase.txt`.
//
// Words are lower-cased because the wordlist is lower-case and a phrase
// written down in capitals is the same phrase. Count validation is left to
// lightning.MnemonicToEntropy, which reports it along with the other BIP-39
// checks; this only rejects an entirely empty input, which is not a
// transcription error but a user who pressed Enter by mistake.
func readMnemonic(r io.Reader) (lightning.Mnemonic, error) {
	sc := bufio.NewScanner(r)
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return nil, fmt.Errorf("reading the phrase: %w", err)
		}
		return nil, fmt.Errorf("no phrase was entered")
	}
	fields := strings.Fields(sc.Text())
	if len(fields) == 0 {
		return nil, fmt.Errorf("no phrase was entered")
	}
	words := make(lightning.Mnemonic, len(fields))
	for i, f := range fields {
		words[i] = strings.ToLower(f)
	}
	return words, nil
}
