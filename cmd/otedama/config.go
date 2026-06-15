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
	cfg, origins := config.ResolveWithOrigins(fromFile, nil, f.FlagValues)

	// tag returns " [layer]" when --origin is active, otherwise empty.
	tag := func(o config.ValueOrigin) string {
		if f.showOrigin {
			return fmt.Sprintf(" [%s]", o)
		}
		return ""
	}

	fmt.Fprintf(stdout, "bitcoin_address: %s%s\n", safeDisplay(cfg.BitcoinAddress), tag(origins.BitcoinAddress))
	if len(cfg.BitcoinAddresses) > 0 {
		fmt.Fprintf(stdout, "bitcoin_addresses (failover): %d%s\n", len(cfg.BitcoinAddresses), tag(origins.BitcoinAddresses))
		for i, a := range cfg.BitcoinAddresses {
			fmt.Fprintf(stdout, "  [%d] %s\n", i+1, safeDisplay(a))
		}
	}
	fmt.Fprintf(stdout, "log_level:       %s%s\n", cfg.LogLevel, tag(origins.LogLevel))
	fmt.Fprintf(stdout, "log_format:      %s%s\n", cfg.LogFormat, tag(origins.LogFormat))
	fmt.Fprintf(stdout, "language:        %s%s\n", safeDisplay(cfg.Language), tag(origins.Language))
	fmt.Fprintf(stdout, "data_dir:        %s%s\n", safeDisplay(cfg.DataDir), tag(origins.DataDir))
	fmt.Fprintf(stdout, "worker_name:     %s%s\n", safeDisplay(cfg.Workers.Name), tag(origins.WorkerName))
	if len(cfg.Pools) == 0 {
		fmt.Fprintf(stdout, "pools:           (built-in default)%s\n", tag(origins.Pools))
	} else {
		fmt.Fprintf(stdout, "pools:           %d configured%s\n", len(cfg.Pools), tag(origins.Pools))
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
	// Malformed numeric env vars are dropped silently during resolution; a
	// validate command should call them out so the operator can fix the typo.
	for _, w := range config.EnvWarnings(nil) {
		fmt.Fprintf(stderr, "config: warning: %s\n", w)
	}
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
