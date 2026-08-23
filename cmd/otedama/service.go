// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"flag"
	"fmt"
	"io"

	"github.com/shizukutanaka/Otedama/internal/daemon"
)

// Injectable function variables — overridden in tests to avoid real OS service operations.
var (
	newDaemonManager = daemon.NewManager
	managerInstall   = func(m *daemon.Manager) error { return m.Install() }
	managerUninstall = func(m *daemon.Manager) error { return m.Uninstall() }
	managerStatus    = func(m *daemon.Manager) (daemon.ServiceStatus, error) { return m.Status() }
)

func cmdService(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "otedama service: expected subcommand (install|uninstall|status)")
		return exitUsage
	}
	switch args[0] {
	case "install":
		return cmdServiceInstall(args[1:], stdout, stderr)
	case "uninstall":
		return cmdServiceUninstall(stdout, stderr)
	case "status":
		return cmdServiceStatus(stdout, stderr)
	case "help", "--help", "-h":
		// Without this, "otedama service --help" fell through to
		// "unknown subcommand" on stderr with exit 64 — an explicit help
		// request looking identical to a mistake, the same class of bug
		// fixed for the leaf subcommands' own --help via
		// parseSubcommandFlags.
		fmt.Fprintln(stdout, "otedama service: expected subcommand (install|uninstall|status)")
		return exitOK
	default:
		fmt.Fprintf(stderr, "otedama service: unknown subcommand %q\n", args[0])
		return exitUsage
	}
}

func cmdServiceInstall(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("service install", flag.ContinueOnError)
	configFile := fs.String("config", "", "Path to config.yaml for the service.")
	dataDir := fs.String("data-dir", "", "Data directory for the service.")
	bitcoinAddress := fs.String("bitcoin-address", "", "Payout address to embed in the service definition (required when no config file is specified).")
	logLevel := fs.String("log-level", "", "Log level for the service (debug|info|warn|error).")
	logFormat := fs.String("log-format", "", "Log format for the service (text|json).")
	language := fs.String("language", "", "UI language for the service (en, ja, …).")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}
	svcFlags := daemon.ServiceFlags{
		BitcoinAddress: *bitcoinAddress,
		LogLevel:       *logLevel,
		LogFormat:      *logFormat,
		Language:       *language,
	}
	mgr, err := newDaemonManager(*configFile, *dataDir, svcFlags)
	if err != nil {
		fmt.Fprintf(stderr, "service: %v\n", err)
		return exitRuntime
	}
	if err := managerInstall(mgr); err != nil {
		fmt.Fprintf(stderr, "service install failed: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintln(stdout, "Otedama service installed and started.")
	fmt.Fprintln(stdout, "It will start automatically on login.")
	return exitOK
}

func cmdServiceUninstall(stdout, stderr io.Writer) int {
	mgr, err := newDaemonManager("", "", daemon.ServiceFlags{})
	if err != nil {
		fmt.Fprintf(stderr, "service: %v\n", err)
		return exitRuntime
	}
	if err := managerUninstall(mgr); err != nil {
		fmt.Fprintf(stderr, "service uninstall failed: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintln(stdout, "Otedama service uninstalled.")
	return exitOK
}

func cmdServiceStatus(stdout, stderr io.Writer) int {
	mgr, err := newDaemonManager("", "", daemon.ServiceFlags{})
	if err != nil {
		fmt.Fprintf(stderr, "service: %v\n", err)
		return exitRuntime
	}
	status, err := managerStatus(mgr)
	if err != nil {
		fmt.Fprintf(stderr, "service status: %v\n", err)
		return exitRuntime
	}
	if status.Installed {
		state := "stopped"
		if status.Running {
			state = "running"
		}
		fmt.Fprintf(stdout, "Otedama service: installed, %s\n", state)
	} else {
		fmt.Fprintln(stdout, "Otedama service: not installed")
		fmt.Fprintln(stdout, "Run 'otedama service install' to install.")
	}
	return exitOK
}
