// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/engine"
	"github.com/shizukutanaka/Otedama/internal/httpserver"
	"github.com/shizukutanaka/Otedama/internal/i18n"
	"github.com/shizukutanaka/Otedama/internal/i18n/messages"
	"github.com/shizukutanaka/Otedama/internal/logger"
	"github.com/shizukutanaka/Otedama/internal/metrics"

	// Register pool-protocol dialers so poolproto.DialURL can find them.
	// Each package's init() calls poolproto.Register with its Dialer.
	_ "github.com/shizukutanaka/Otedama/internal/poolproto/stratumv1"
)

// runFlags holds all parsed flags for the run subcommand. The same flag
// set backs `config show` and `config validate`, which build an effective
// config without starting the engine.
type runFlags struct {
	config.FlagValues
	configFile       string
	dryRun           bool
	noTUI            bool
	walletPassphrase string
	httpAddr         string
	pprofEnabled     bool
	logFile          string // --log-file: audit-trail path, written even under the TUI
	showOrigin       bool   // --origin: annotate config show output with value sources
}

func parseRunFlags(args []string, stderr io.Writer) (runFlags, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var f runFlags
	fs.StringVar(&f.BitcoinAddress, "bitcoin-address", "", "Bitcoin address for mining rewards (required).")
	fs.StringVar(&f.LogLevel, "log-level", "", "Log level (debug|info|warn|error).")
	fs.StringVar(&f.Language, "language", "", "UI language as BCP 47 tag (e.g., ja, en, zh-CN).")
	fs.StringVar(&f.DataDir, "data-dir", "", "Directory for persistent data.")
	fs.StringVar(&f.configFile, "config", "", "Path to config.yaml (optional).")
	fs.BoolVar(&f.dryRun, "dry-run", false, "Validate configuration and exit without starting.")
	fs.BoolVar(&f.noTUI, "no-tui", false, "Disable the terminal dashboard (plain log output).")
	fs.StringVar(&f.walletPassphrase, "wallet-passphrase", "",
		"Passphrase to unlock/create the Lightning wallet. If empty, wallet is skipped.")
	fs.StringVar(&f.LogFormat, "log-format", "", "Log output format: text or json.")
	fs.StringVar(&f.logFile, "log-file", "",
		"Append structured logs to this file. Written even while the TUI is active, "+
			"giving a long-running service an audit trail the dashboard otherwise hides.")
	fs.StringVar(&f.httpAddr, "http-addr", "",
		"Address for HTTP metrics/health endpoints (e.g. 127.0.0.1:9090). Empty disables.")
	fs.BoolVar(&f.pprofEnabled, "pprof", false,
		"Mount Go pprof profiling at /debug/pprof/ (only on loopback/private addresses).")
	fs.BoolVar(&f.showOrigin, "origin", false,
		"(config show only) Annotate each value with the layer that set it (default/file/env/flag).")
	if err := fs.Parse(args); err != nil {
		return runFlags{}, err
	}
	return f, nil
}

func cmdRun(args []string, stdout, stderr io.Writer) int {
	f, err := parseRunFlags(args, stderr)
	if err != nil {
		return exitUsage
	}

	fromFile := loadConfigFile(f.configFile, stderr)
	// Surface env vars that were set but could not be parsed: they are
	// silently ignored during resolution, so warn before starting rather than
	// let an operator's typo'd setting vanish unnoticed.
	for _, w := range config.EnvWarnings(nil) {
		fmt.Fprintf(stderr, "config: warning: %s\n", w)
	}
	cfg := config.Resolve(fromFile, nil, f.FlagValues)
	if err := cfg.Validate(); err != nil {
		fmt.Fprintf(stderr, "%s\n", err)
		return exitConfig
	}

	// Initialise i18n bundle.
	bundle, _ := messages.NewBundle()
	lang := messages.DetectLang(cfg.Language)

	logln := func(level string, id i18n.ID, data map[string]any) {
		msg, _ := bundle.RenderWith(lang, id, data)
		fmt.Fprintf(stdout, "[%s] %s\n", level, msg)
	}
	plain := func(level, text string) {
		fmt.Fprintf(stdout, "[%s] %s\n", level, text)
	}

	if f.dryRun {
		fmt.Fprintln(stdout, "dry-run: configuration is valid; would start run")
		return exitOK
	}

	logln("info", messages.StartupReady, nil)

	poolURL := config.DefaultPoolURL
	if len(cfg.Pools) > 0 {
		poolURL = cfg.Pools[0].URL
	}
	logln("info", messages.StartupPoolConnecting, map[string]any{"url": poolURL})

	ctx, cancel := signal.NotifyContext(
		context.Background(),
		os.Interrupt, syscall.SIGTERM,
	)
	defer cancel()

	// Build the structured logger. closeLog flushes/closes the --log-file.
	structlog, closeLog := buildLogger(f, cfg, stdout)
	defer closeLog()

	// Start HTTP health/metrics server if requested.
	metricsRegistry, httpSrv := startHTTPServer(ctx, f, stdout, stderr)
	if httpSrv != nil {
		defer httpSrv.Stop()
	}

	// Bridge engine readiness to HTTP /readyz.
	onReady := func(ready bool) {
		if httpSrv != nil {
			httpSrv.SetReady(ready)
		}
	}

	if err := engine.Run(ctx, engine.Options{
		Config:           cfg,
		Output:           stdout,
		NoTUI:            f.noTUI,
		WalletPassphrase: f.walletPassphrase,
		Logger:           structlog.Adapter(),
		Metrics:          metricsRegistry,
		OnReady:          onReady,
	}); err != nil && err != context.Canceled {
		structlog.Error("engine", "error", err.Error())
		plain("error", err.Error())
		return exitRuntime
	}

	logln("info", messages.StatusShuttingDown, nil)
	return exitOK
}

// buildLogger constructs the structured logger for a run. When the TUI
// dashboard is active (default), log output is discarded so it does not
// corrupt the dashboard. With --no-tui, logs go to stdout in the
// configured format (text or JSON).
// buildLogger constructs the structured logger for a run and returns a cleanup
// function the caller must defer (it closes the --log-file, if one was opened).
//
// Sink selection: the TUI owns stdout, so while it is active logs must never go
// there (they would corrupt the dashboard). --log-file is what gives a TUI
// session any audit trail at all. The combinations:
//
//	TUI on,  no file  → discard (unchanged; dashboard only)
//	TUI on,  file     → file only
//	TUI off, no file  → stdout (unchanged)
//	TUI off, file     → stdout + file
//
// A file that cannot be opened is a warning, not a fatal error: the run
// proceeds without the audit trail rather than refusing to mine.
func buildLogger(f runFlags, cfg config.Config, stdout io.Writer) (*logger.Logger, func()) {
	cleanup := func() {}

	var fileW io.Writer
	if f.logFile != "" {
		// 0600: logs can include pool URLs and worker names; match the
		// restrictive posture used for the wallet and data directory.
		lf, err := os.OpenFile(f.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: cannot open --log-file %q: %v\n", f.logFile, err)
		} else {
			fileW = lf
			cleanup = func() { _ = lf.Close() }
		}
	}

	var w io.Writer
	switch {
	case !f.noTUI:
		if fileW == nil {
			return logger.Discard(), cleanup // dashboard only; logs dropped
		}
		w = fileW // TUI active: the file is the audit trail
	case fileW != nil:
		w = io.MultiWriter(stdout, fileW) // plain mode: console + file
	default:
		w = stdout // plain mode, no file
	}

	format := logger.FormatText
	if cfg.LogFormat == "json" {
		format = logger.FormatJSON
	}
	return logger.New(logger.Config{
		Level:  logger.ParseLevel(cfg.LogLevel),
		Format: format,
		Writer: w,
	}), cleanup
}

// startHTTPServer starts the health/metrics HTTP server if --http-addr
// was provided. Returns the metrics registry and server handle (both
// nil if no address was set, or if startup failed — a startup failure
// is logged as a warning but does not abort the run).
func startHTTPServer(ctx context.Context, f runFlags, stdout, stderr io.Writer) (*metrics.Registry, *httpserver.Server) {
	if f.httpAddr == "" {
		return nil, nil
	}
	reg := metrics.NewRegistry()
	srv := httpserver.New(f.httpAddr, reg, f.pprofEnabled)
	if err := srv.Start(ctx); err != nil {
		fmt.Fprintf(stderr, "warning: cannot start HTTP server: %v\n", err)
		return reg, nil
	}
	fmt.Fprintf(stdout, "[info] http: listening on %s\n", f.httpAddr)
	return reg, srv
}
