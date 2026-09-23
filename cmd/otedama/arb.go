// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// `otedama arb` — arbitration introspection subcommands (ADR-010 A9).
// `arb explain` fetches the live DecisionSnapshot the running engine
// exposes at GET /arbitration and renders it as the per-device table the
// ADR specifies: which stream each device is on, the expected and
// forecast yield, the provider's posterior reliability, and the reason
// for any hold, switch, or idle assignment.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/shizukutanaka/Otedama/internal/arbitration"
	"github.com/shizukutanaka/Otedama/internal/config"
)

// cmdArb dispatches the arb subcommand group.
func cmdArb(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printArbUsage(stderr)
		return exitUsage
	}
	// Reuse the shared help spelling helpers (helpWord + hasHelpFlag)
	// rather than repeating the "--help"/"-h"/"help" literals that
	// goconst counts package-wide.
	if args[0] == helpWord || hasHelpFlag(args[:1]) {
		printArbUsage(stdout)
		return exitOK
	}
	switch args[0] {
	case "explain":
		return cmdArbExplain(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "otedama: unknown arb subcommand %q\n", args[0])
		printArbUsage(stderr)
		return exitUsage
	}
}

func printArbUsage(w io.Writer) {
	fmt.Fprint(w, `Usage:
  otedama arb explain [--config path] [--http-addr addr]

Commands:
  explain    Show why the running engine assigned each device its current
             stream: expected vs forecast yield, provider reliability,
             hysteresis holds, and foregone revenue.

The explain subcommand reads the DecisionSnapshot the running daemon
serves at GET /arbitration (ADR-010 A9). Point it at the daemon's
HTTP address — resolved like every other subcommand: --http-addr flag,
then OTEDAMA_HTTP_ADDR, then config.yaml's http_addr.
`)
}

// cmdArbExplain implements `arb explain`: one GET against the daemon's
// HTTP endpoint, then render. It talks to a separate running process, so
// all failure modes are environmental (daemon down, HTTP disabled, no
// decision ticked yet) and map to exitRuntime with a plain-language hint.
func cmdArbExplain(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("arb explain", flag.ContinueOnError)
	httpAddr := fs.String("http-addr", "", "Daemon HTTP address (e.g. 127.0.0.1:9090). Resolved from config when empty.")
	configFile := fs.String("config", "", "Path to config.yaml (optional).")
	if ok, code := parseSubcommandFlags(fs, args, stdout, stderr); !ok {
		return code
	}

	fromFile := loadConfigFile(*configFile, stderr)
	cfg := config.Resolve(fromFile, nil, config.FlagValues{HTTPAddr: *httpAddr})
	if cfg.HTTPAddr == "" {
		fmt.Fprintln(stderr, "otedama: no HTTP address configured — start the daemon with --http-addr (or set http_addr) and pass --http-addr here")
		return exitConfig
	}

	url := "http://" + cfg.HTTPAddr + "/arbitration"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		fmt.Fprintf(stderr, "otedama: %v\n", err)
		return exitRuntime
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(stderr, "otedama: cannot reach daemon at %s: %v\n", url, err)
		return exitRuntime
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var snap arbitration.DecisionSnapshot
		if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
			fmt.Fprintf(stderr, "otedama: malformed /arbitration response: %v\n", err)
			return exitRuntime
		}
		fmt.Fprint(stdout, arbitration.ExplainText(&snap))
		return exitOK
	case http.StatusServiceUnavailable:
		fmt.Fprintln(stdout, "arbitration: no decision recorded yet — the engine ticks every 30 s or on each provider quote")
		return exitRuntime
	default:
		fmt.Fprintf(stderr, "otedama: %s returned %s\n", url, resp.Status)
		return exitRuntime
	}
}
