// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"fmt"
	"io"
	"strings"
	"unicode"

	"github.com/shizukutanaka/Otedama/internal/config"
)

func cmdConfig(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "otedama config: expected subcommand (show|validate)")
		return exitUsage
	}
	switch args[0] {
	case "show":
		return cmdConfigShow(args[1:], stdout, stderr)
	case "validate":
		return cmdConfigValidate(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "otedama config: unknown subcommand %q\n", args[0])
		return exitUsage
	}
}

func cmdConfigShow(args []string, stdout, stderr io.Writer) int {
	f, err := parseRunFlags(args, stderr)
	if err != nil {
		return exitUsage
	}
	fromFile := loadConfigFile(f.configFile, stderr)
	cfg := config.Resolve(fromFile, nil, f.FlagValues)
	fmt.Fprintf(stdout, "bitcoin_address: %s\n", safeDisplay(cfg.BitcoinAddress))
	if len(cfg.BitcoinAddresses) > 0 {
		fmt.Fprintf(stdout, "bitcoin_addresses (failover): %d\n", len(cfg.BitcoinAddresses))
		for i, a := range cfg.BitcoinAddresses {
			fmt.Fprintf(stdout, "  [%d] %s\n", i+1, safeDisplay(a))
		}
	}
	fmt.Fprintf(stdout, "log_level:       %s\n", cfg.LogLevel)
	fmt.Fprintf(stdout, "log_format:      %s\n", cfg.LogFormat)
	fmt.Fprintf(stdout, "language:        %s\n", safeDisplay(cfg.Language))
	fmt.Fprintf(stdout, "data_dir:        %s\n", safeDisplay(cfg.DataDir))
	fmt.Fprintf(stdout, "worker_name:     %s\n", safeDisplay(cfg.Workers.Name))
	if len(cfg.Pools) == 0 {
		fmt.Fprintf(stdout, "pools:           (built-in default)\n")
	} else {
		fmt.Fprintf(stdout, "pools:           %d configured\n", len(cfg.Pools))
		for i, p := range cfg.Pools {
			fmt.Fprintf(stdout, "  [%d] %s\n", i+1, safeDisplay(p.URL))
		}
	}
	return exitOK
}

func cmdConfigValidate(args []string, stdout, stderr io.Writer) int {
	f, err := parseRunFlags(args, stderr)
	if err != nil {
		return exitUsage
	}
	fromFile := loadConfigFile(f.configFile, stderr)
	cfg := config.Resolve(fromFile, nil, f.FlagValues)
	if err := cfg.Validate(); err != nil {
		fmt.Fprintf(stderr, "%s\n", err)
		return exitConfig
	}
	fmt.Fprintln(stdout, "configuration is valid")
	return exitOK
}

// safeDisplay sanitises a config value for terminal output. It strips
// control characters (ESC, newlines, DEL, …) so a malicious config value
// cannot inject ANSI escape sequences or forge log lines when echoed to a
// terminal, and renders the empty string as "(default)".
func safeDisplay(v string) string {
	if v == "" {
		return "(default)"
	}
	if !strings.ContainsFunc(v, unicode.IsControl) {
		return v
	}
	var b strings.Builder
	b.Grow(len(v))
	for _, r := range v {
		if !unicode.IsControl(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}
