// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"context"
	"flag"
	"io"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/doctor"
)

func cmdDoctor(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configFile := fs.String("config", "", "Path to config.yaml to diagnose.")
	btcAddr := fs.String("bitcoin-address", "", "Bitcoin address to validate.")
	dataDir := fs.String("data-dir", "", "Data directory to check.")
	jsonOut := fs.Bool("json", false, "Emit results as a JSON object (for CI/monitoring) instead of text.")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}

	// Build effective config from the same layering used by `run`.
	// The config file is loaded separately (loadConfigFile); FlagValues
	// does not carry a file path — Resolve takes an already-decoded Config.
	flags := config.FlagValues{
		BitcoinAddress: *btcAddr,
		DataDir:        *dataDir,
	}
	fromFile := loadConfigFile(*configFile, stderr)
	cfg := config.Resolve(fromFile, nil, flags)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	runner := &doctor.Runner{Checks: doctor.DefaultChecks(cfg, *configFile)}
	report := runner.Run(ctx)
	if *jsonOut {
		_ = report.WriteJSON(stdout)
	} else {
		report.Print(stdout)
	}
	return report.ExitCode()
}
