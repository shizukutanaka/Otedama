// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"flag"
	"fmt"
	"io"

	"github.com/shizukutanaka/Otedama/internal/daemon"
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
	default:
		fmt.Fprintf(stderr, "otedama service: unknown subcommand %q\n", args[0])
		return exitUsage
	}
}

func cmdServiceInstall(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("service install", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configFile := fs.String("config", "", "Path to config.yaml for the service.")
	dataDir := fs.String("data-dir", "", "Data directory for the service.")
	bitcoinAddress := fs.String("bitcoin-address", "", "Payout address to embed in the service definition (required when no config file is specified).")
	logLevel := fs.String("log-level", "", "Log level for the service (debug|info|warn|error).")
	logFormat := fs.String("log-format", "", "Log format for the service (text|json).")
	language := fs.String("language", "", "UI language for the service (en, ja, …).")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	svcFlags := daemon.ServiceFlags{
		BitcoinAddress: *bitcoinAddress,
		LogLevel:       *logLevel,
		LogFormat:      *logFormat,
		Language:       *language,
	}
	mgr, err := daemon.NewManager(*configFile, *dataDir, svcFlags)
	if err != nil {
		fmt.Fprintf(stderr, "service: %v\n", err)
		return exitRuntime
	}
	if err := mgr.Install(); err != nil {
		fmt.Fprintf(stderr, "service install failed: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintln(stdout, "Otedama service installed and started.")
	fmt.Fprintln(stdout, "It will start automatically on login.")
	return exitOK
}

func cmdServiceUninstall(stdout, stderr io.Writer) int {
	mgr, err := daemon.NewManager("", "", daemon.ServiceFlags{})
	if err != nil {
		fmt.Fprintf(stderr, "service: %v\n", err)
		return exitRuntime
	}
	if err := mgr.Uninstall(); err != nil {
		fmt.Fprintf(stderr, "service uninstall failed: %v\n", err)
		return exitRuntime
	}
	fmt.Fprintln(stdout, "Otedama service uninstalled.")
	return exitOK
}

func cmdServiceStatus(stdout, stderr io.Writer) int {
	mgr, err := daemon.NewManager("", "", daemon.ServiceFlags{})
	if err != nil {
		fmt.Fprintf(stderr, "service: %v\n", err)
		return exitRuntime
	}
	status, err := mgr.Status()
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
