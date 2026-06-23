// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"encoding/json"
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

	if f.jsonOut {
		return writeConfigJSON(stdout, stderr, cfg, origins, f.showOrigin)
	}

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
	// Economic & arbitration scalars. Shown so an operator can confirm these
	// took effect (especially via env/flag) — `config show --origin` reveals
	// which layer set each. %g keeps 0 ("disabled/unset" for the optional ones)
	// and fractions readable.
	fmt.Fprintf(stdout, "arbitration_hysteresis_pct: %g%s\n", cfg.ArbitrationHysteresisPct, tag(origins.ArbitrationHysteresisPct))
	fmt.Fprintf(stdout, "curtail_below_btc_usd:      %g%s\n", cfg.CurtailBelowBTCUSD, tag(origins.CurtailBelowBTCUSD))
	fmt.Fprintf(stdout, "min_yield_sats_per_sec:     %g%s\n", cfg.MinYieldSatsPerSec, tag(origins.MinYieldSatsPerSec))
	fmt.Fprintf(stdout, "power_watts:                %g%s\n", cfg.PowerWatts, tag(origins.PowerWatts))
	fmt.Fprintf(stdout, "electricity_price_per_kwh:  %g%s\n", cfg.ElectricityPricePerKWh, tag(origins.ElectricityPricePerKWh))
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

// writeConfigJSON emits the resolved configuration as a JSON object, the
// machine-readable counterpart to the text view — for a deploy or
// config-management script verifying the effective config after file/env/flag
// layering. When withOrigins is set (i.e. --json --origin together) a parallel
// "origins" map records which layer set each field, preserving the text mode's
// --origin information. JSON encoding escapes control characters natively, so
// the safeDisplay terminal-sanitisation used by the text view is unnecessary
// here (a consumer parses the bytes; it does not echo them to a terminal).
func writeConfigJSON(stdout, stderr io.Writer, cfg config.Config, origins config.Origins, withOrigins bool) int {
	pools := make([]string, 0, len(cfg.Pools))
	for _, p := range cfg.Pools {
		pools = append(pools, p.URL)
	}
	doc := struct {
		BitcoinAddress           string            `json:"bitcoin_address"`
		BitcoinAddresses         []string          `json:"bitcoin_addresses,omitempty"`
		LogLevel                 string            `json:"log_level"`
		LogFormat                string            `json:"log_format"`
		Language                 string            `json:"language"`
		DataDir                  string            `json:"data_dir"`
		WorkerName               string            `json:"worker_name"`
		ArbitrationHysteresisPct float64           `json:"arbitration_hysteresis_pct"`
		CurtailBelowBTCUSD       float64           `json:"curtail_below_btc_usd"`
		MinYieldSatsPerSec       float64           `json:"min_yield_sats_per_sec"`
		PowerWatts               float64           `json:"power_watts"`
		ElectricityPricePerKWh   float64           `json:"electricity_price_per_kwh"`
		Pools                    []string          `json:"pools"`
		Origins                  map[string]string `json:"origins,omitempty"`
	}{
		BitcoinAddress:           cfg.BitcoinAddress,
		BitcoinAddresses:         cfg.BitcoinAddresses,
		LogLevel:                 cfg.LogLevel,
		LogFormat:                cfg.LogFormat,
		Language:                 cfg.Language,
		DataDir:                  cfg.DataDir,
		WorkerName:               cfg.Workers.Name,
		ArbitrationHysteresisPct: cfg.ArbitrationHysteresisPct,
		CurtailBelowBTCUSD:       cfg.CurtailBelowBTCUSD,
		MinYieldSatsPerSec:       cfg.MinYieldSatsPerSec,
		PowerWatts:               cfg.PowerWatts,
		ElectricityPricePerKWh:   cfg.ElectricityPricePerKWh,
		Pools:                    pools,
	}
	if withOrigins {
		doc.Origins = map[string]string{
			"bitcoin_address":            origins.BitcoinAddress.String(),
			"bitcoin_addresses":          origins.BitcoinAddresses.String(),
			"log_level":                  origins.LogLevel.String(),
			"log_format":                 origins.LogFormat.String(),
			"language":                   origins.Language.String(),
			"data_dir":                   origins.DataDir.String(),
			"worker_name":                origins.WorkerName.String(),
			"arbitration_hysteresis_pct": origins.ArbitrationHysteresisPct.String(),
			"curtail_below_btc_usd":      origins.CurtailBelowBTCUSD.String(),
			"min_yield_sats_per_sec":     origins.MinYieldSatsPerSec.String(),
			"power_watts":                origins.PowerWatts.String(),
			"electricity_price_per_kwh":  origins.ElectricityPricePerKWh.String(),
			"pools":                      origins.Pools.String(),
		}
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(&doc); err != nil {
		fmt.Fprintf(stderr, "otedama: config show: %v\n", err)
		return exitRuntime
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
	// If all characters were control chars, return the placeholder.
	if b.Len() == 0 {
		return "(default)"
	}
	return b.String()
}
