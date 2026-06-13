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
// doctor.go, version.go, completion.go); this file holds only the entry
// point and the top-level dispatcher.
package main

import (
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
