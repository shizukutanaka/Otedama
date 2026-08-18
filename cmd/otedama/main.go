// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Command otedama is the Otedama CLI.
//
// # Usage
//
//	otedama run --bitcoin-address bc1q...
//	otedama run --bitcoin-address bc1q... --wallet-passphrase "your passphrase"
//	otedama version [--json]
//	otedama config show [--origin]
//	otedama config validate --bitcoin-address bc1q...
//	otedama service install [--config path] [--data-dir path] [--bitcoin-address addr]
//	otedama service uninstall
//	otedama service status
//	otedama doctor [--bitcoin-address bc1q...]
//	otedama wallet verify [--data-dir path]
//	otedama wallet change-passphrase [--data-dir path]
//
// # Exit codes
//
// The exit code indicates the outcome category, following sysexits.h conventions:
//
//	0  — success
//	1  — runtime error (engine failure, I/O error, network unreachable)
//	64 — usage error (unknown subcommand, unknown flag, missing required argument)
//	78 — configuration error (invalid bitcoin address, unrecognised log level, etc.)
//
// The doctor subcommand uses a narrower three-value scale:
//
//	0 — all checks passed
//	1 — at least one check warned (advisory, not fatal)
//	2 — at least one check failed (action required)
//
// For shell scripting the coarsest check is [ $? -eq 0 ]; any non-zero exit
// indicates that operator attention is needed.
//
// Each subcommand lives in its own file (run.go, config.go, service.go,
// doctor.go, wallet.go, version.go, completion.go); this file holds only the
// entry point and the top-level dispatcher.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

// Exit codes following sysexits.h conventions.
// See the package-level godoc for the complete contract.
const (
	exitOK      = 0  // success
	exitRuntime = 1  // runtime error (engine, network, I/O)
	exitUsage   = 64 // usage error (EX_USAGE: unknown flag, bad subcommand)
	exitConfig  = 78 // configuration error (EX_CONFIG: invalid field value)
)

// parseSubcommandFlags parses fs against args and returns the exit code the
// caller should use if parsing did not succeed (ok is false); callers
// proceed normally when ok is true.
//
// A bare `--help`/`-h` is not a usage mistake — it is the documented way to
// see a subcommand's flags (the top-level `otedama help` handles this
// correctly already; every per-subcommand flag.FlagSet did not). Every
// FlagSet in this package previously called fs.SetOutput(stderr)
// unconditionally, so `otedama run --help` printed its usage to stderr and
// exited 64, identical to a genuine mistake like an unknown flag — a
// correct invocation looked like an error to any script checking $?. This
// routes help output to stdout with exit 0, while every other parse error
// (unknown flag, missing value, etc.) still goes to stderr with exitUsage.
func parseSubcommandFlags(fs *flag.FlagSet, args []string, stdout, stderr io.Writer) (ok bool, exitCode int) {
	out := stderr
	if hasHelpFlag(args) {
		out = stdout
	}
	fs.SetOutput(out)
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return false, exitOK
		}
		return false, exitUsage
	}
	return true, exitOK
}

// hasHelpFlag reports whether args requests help, matching the exact
// spellings flag.FlagSet.Parse recognises (-h, -help, --help) before
// falling through to its own ErrHelp path. It scans every token rather
// than stopping at the first argument that doesn't look like a flag:
// every flag these subcommands define takes a value in the space-separated
// "--flag value" form (e.g. "--bitcoin-address bc1q..."), so the token
// right after a flag is that flag's value, not a positional argument
// signalling the end of flags — stopping there produced false negatives
// for the common case of --help appearing after any flag with a value.
// Scanning still stops at a literal "--", the unambiguous end-of-flags
// marker, since that ends flag.Parse's own scanning too.
func hasHelpFlag(args []string) bool {
	for _, a := range args {
		switch a {
		case "-h", "-help", "--help":
			return true
		case "--":
			return false
		}
	}
	return false
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printUsage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "run":
		return cmdRun(args[1:], stdout, stderr)
	case "version", "--version", "-v":
		return cmdVersion(args[1:], stdout, stderr)
	case "config":
		return cmdConfig(args[1:], stdout, stderr)
	case "service":
		return cmdService(args[1:], stdout, stderr)
	case "doctor":
		return cmdDoctor(args[1:], stdout, stderr)
	case "wallet":
		return cmdWallet(args[1:], stdout, stderr)
	case "completion":
		return cmdCompletion(args[1:], stdout, stderr)
	case "help", "--help", "-h":
		printUsage(stdout)
		return exitOK
	default:
		fmt.Fprintf(stderr, "otedama: unknown subcommand %q\n", args[0])
		printUsage(stderr)
		return exitUsage
	}
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, `Otedama — non-custodial compute arbitration software.

Usage:
  otedama <command> [flags]

Commands:
  run        Start mining and/or other compute workloads.
  version    Print version information and exit.
  config     Inspect or validate the effective configuration.
  service    Install/uninstall as a background service.
  doctor     Run self-diagnostic checks.
  wallet     Verify a recovery phrase, or rotate the wallet passphrase.
  completion Generate a shell-completion script (bash|zsh|fish).
  help       Print this help and exit.

Getting started (zero-configuration):
  otedama run --bitcoin-address bc1q...

With Lightning wallet:
  otedama run --bitcoin-address bc1q... --wallet-passphrase "strong passphrase"

Exit codes:
  0   success
  1   runtime error (engine, network, I/O failure)
  64  usage error  (unknown flag or subcommand)
  78  config error (invalid address, bad log level, etc.)
  doctor uses 0=pass, 1=warn, 2=fail instead of the above.

Run 'otedama <command> --help' for per-command flags.
`)
}
