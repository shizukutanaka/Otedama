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
	case "change-passphrase":
		return cmdWalletChangePassphrase(args[1:], stdout, stderr, os.Stdin)
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
  verify             Check a written-down recovery phrase against the stored wallet.
  change-passphrase  Re-encrypt the wallet under a new passphrase.
  help               Print this help and exit.

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

otedama wallet change-passphrase [--config path] [--data-dir path]

  Re-encrypts wallet.dat under a new passphrase. The seed itself does not
  change, so your recovery phrase stays valid and the wallet fingerprint
  stays the same — the command prints it before and after so you can see
  that for yourself.

  The current passphrase must be in OTEDAMA_WALLET_PASSPHRASE. The new one
  is read from standard input, twice, and the two must match.

  Your terminal will echo what you type. To avoid that, pipe the new
  passphrase in twice, one per line, from a source you then discard.

Exit codes:
  0   the wallet was re-encrypted
  1   the current passphrase was wrong, or the rewrite failed
  64  usage error
  78  config error (no data dir, no wallet, missing or mismatched passphrase)
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

// cmdWalletChangePassphrase re-encrypts wallet.dat under a new passphrase.
//
// # Why this is a thin wrapper
//
// lightning.WalletManager.ChangePassphrase already verifies the old
// passphrase by round-trip decrypt and writes through the same atomic path
// as creation — temp file in the same directory, write, Sync, Close (error
// checked), chmod 0600, rename — and is covered by that package's tests. It
// simply had no caller in production code, so a user whose passphrase might
// have been exposed could not rotate it without writing their own Go program
// against an internal package (docs/KNOWN_LIMITATIONS.md §16).
//
// So this adds no cryptography and no file handling of its own. What it adds
// is the operator-facing safety that a library function cannot: refusing to
// create a wallet when none exists, requiring the new passphrase twice, and
// proving to the user that the rotation did not change their seed.
//
// # The fingerprint check is the point, not decoration
//
// Changing the passphrase must re-encrypt the *same* seed. If the fingerprint
// changed, the recovery phrase the user wrote down would no longer describe
// the wallet on disk — silently, and discovered only during a recovery
// attempt. The command reads the fingerprint before and after, prints both,
// and treats a difference as a failure rather than reporting success. This
// should be unreachable; it is checked because the cost of being wrong here
// is the user's funds.
func cmdWalletChangePassphrase(args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	fs := flag.NewFlagSet("wallet change-passphrase", flag.ContinueOnError)
	configFile := fs.String("config", "", "Path to config.yaml.")
	dataDir := fs.String("data-dir", "", "Data directory holding wallet.dat.")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}

	cfg := config.Resolve(loadConfigFile(*configFile, stderr), nil, config.FlagValues{DataDir: *dataDir})
	if cfg.DataDir == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: no data directory could be determined; pass --data-dir")
		return exitConfig
	}
	walletPath := filepath.Join(cfg.DataDir, walletDatFile)
	if _, err := os.Stat(walletPath); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: no wallet at %s: %v\n", walletPath, err)
		fmt.Fprintln(stderr, "There is nothing to re-encrypt.")
		return exitConfig
	}

	oldPassphrase := os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	if oldPassphrase == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: OTEDAMA_WALLET_PASSPHRASE is not set.")
		fmt.Fprintln(stderr, "It must hold the CURRENT passphrase, and is read from the environment "+
			"rather than a flag so it does not appear in process lists.")
		return exitConfig
	}

	fmt.Fprintln(stdout, "Enter the NEW passphrase, then press Enter. You will be asked to repeat it.")
	fmt.Fprintln(stdout, "(It will be echoed by your terminal.)")
	lines := bufio.NewScanner(stdin)
	newPassphrase, err := readLine(lines)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitConfig
	}
	if newPassphrase == "" {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: the new passphrase must not be empty.")
		return exitConfig
	}
	fmt.Fprintln(stdout, "Repeat the NEW passphrase.")
	confirm, err := readLine(lines)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		return exitConfig
	}
	// Compared in constant time: both are secrets, and this comparison runs
	// before either has been used for anything.
	if subtle.ConstantTimeCompare([]byte(newPassphrase), []byte(confirm)) != 1 {
		fmt.Fprintln(stderr, "otedama wallet change-passphrase: the two entries do not match; nothing was changed.")
		return exitConfig
	}

	wordList, err := lightning.NewEnglishWordList()
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: wordlist: %v\n", err)
		return exitRuntime
	}
	wm, err := lightning.NewWalletManager(cfg.DataDir, oldPassphrase, nil, wordList)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: cannot open %s: %v\n", walletPath, err)
		fmt.Fprintln(stderr, "Nothing was changed.")
		return exitRuntime
	}
	before := wm.Fingerprint()

	if err := wm.ChangePassphrase(oldPassphrase, newPassphrase, nil); err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: %v\n", err)
		fmt.Fprintln(stderr, "The wallet is unchanged: it is replaced by an atomic rename only "+
			"after the new file is fully written, so a failure here leaves the old file in place.")
		return exitRuntime
	}

	// Re-open under the new passphrase. This proves three things at once: the
	// new file decrypts, it decrypts with the passphrase the user just chose,
	// and it holds the same seed.
	reopened, err := lightning.NewWalletManager(cfg.DataDir, newPassphrase, nil, wordList)
	if err != nil {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: the wallet was rewritten but "+
			"will not re-open under the new passphrase: %v\n", err)
		fmt.Fprintln(stderr, "Restore from your recovery phrase before doing anything else.")
		return exitRuntime
	}
	after := reopened.Fingerprint()
	if before != after {
		fmt.Fprintf(stderr, "otedama wallet change-passphrase: the seed changed (%s -> %s). "+
			"This must never happen; your recovery phrase describes %s.\n", before, after, before)
		return exitRuntime
	}

	fmt.Fprintf(stdout, "\nDone — wallet.dat is now encrypted with the new passphrase.\n\n")
	fmt.Fprintf(stdout, "  fingerprint before: %s\n", before)
	fmt.Fprintf(stdout, "  fingerprint after:  %s  (unchanged, as it must be)\n\n", after)
	fmt.Fprintln(stdout, "Your recovery phrase is unaffected — it describes the seed, not the")
	fmt.Fprintln(stdout, "passphrase. Update OTEDAMA_WALLET_PASSPHRASE wherever it is set, including")
	fmt.Fprintln(stdout, "any service unit installed by `otedama service install`.")
	return exitOK
}

// readLine reads one line from sc and returns it with the trailing newline
// removed. Unlike readMnemonic it does not split, lower-case, or otherwise
// touch the content: a passphrase's spaces and capitals are part of it.
//
// It takes a *bufio.Scanner rather than an io.Reader because the caller reads
// two lines. A Scanner buffers ahead, so constructing a fresh one per line
// loses whatever the previous one had already pulled in — with a piped
// passphrase and its confirmation arriving together, the second read saw EOF
// and the command failed with "no input was given" after the user had typed
// everything correctly. One scanner, two reads.
func readLine(sc *bufio.Scanner) (string, error) {
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return "", fmt.Errorf("reading input: %w", err)
		}
		return "", fmt.Errorf("no input was given")
	}
	return sc.Text(), nil
}
