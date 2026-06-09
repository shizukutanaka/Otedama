// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Command otedama is the Otedama CLI.
//
// # Usage
//
//	otedama run --bitcoin-address bc1q...
//	otedama run --bitcoin-address bc1q... --wallet-passphrase "your passphrase"
//	otedama version [--json]
//	otedama config show
//	otedama config validate --bitcoin-address bc1q...
//	otedama service install [--config path] [--data-dir path] [--bitcoin-address addr]
//	otedama service uninstall
//	otedama service status
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/daemon"
	"github.com/shizukutanaka/Otedama/internal/doctor"
	"github.com/shizukutanaka/Otedama/internal/engine"
	"github.com/shizukutanaka/Otedama/internal/httpserver"
	"github.com/shizukutanaka/Otedama/internal/i18n"
	"github.com/shizukutanaka/Otedama/internal/i18n/messages"
	"github.com/shizukutanaka/Otedama/internal/logger"
	"github.com/shizukutanaka/Otedama/internal/metrics"
	"github.com/shizukutanaka/Otedama/internal/version"
)

// Exit codes (sysexits.h conventions).
const (
	exitOK      = 0
	exitUsage   = 64
	exitConfig  = 78
	exitRuntime = 1
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
  run       Start mining and/or other compute workloads.
  version   Print version information and exit.
  config    Inspect or validate the effective configuration.
  service   Install/uninstall as a background service.
  doctor    Run self-diagnostic checks.
  completion Generate a shell-completion script (bash|zsh|fish).
  help      Print this help and exit.

Getting started (zero-configuration):
  otedama run --bitcoin-address bc1q...

With Lightning wallet:
  otedama run --bitcoin-address bc1q... --wallet-passphrase "strong passphrase"

Run 'otedama <command> --help' for flags.
`)
}

// ----- version -----

func cmdVersion(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(stderr)
	jsonOut := fs.Bool("json", false, "Output as JSON.")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	info := version.Get()
	if *jsonOut {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(info); err != nil {
			fmt.Fprintf(stderr, "otedama: version: %v\n", err)
			return exitRuntime
		}
	} else {
		fmt.Fprintln(stdout, info.String())
	}
	return exitOK
}

// ----- config -----

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

// runFlags holds all parsed flags for the run subcommand.
type runFlags struct {
	config.FlagValues
	configFile       string
	dryRun           bool
	noTUI            bool
	walletPassphrase string
	httpAddr         string
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
	fs.StringVar(&f.httpAddr, "http-addr", "",
		"Address for HTTP metrics/health endpoints (e.g. 127.0.0.1:9090). Empty disables.")
	if err := fs.Parse(args); err != nil {
		return runFlags{}, err
	}
	return f, nil
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

// ----- run -----

func cmdRun(args []string, stdout, stderr io.Writer) int {
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

	poolURL := "stratum+v2://public.stratum.slushpool.com:3336"
	if len(cfg.Pools) > 0 {
		poolURL = cfg.Pools[0].URL
	}
	logln("info", messages.StartupPoolConnecting, map[string]any{"url": poolURL})

	ctx, cancel := signal.NotifyContext(
		context.Background(),
		os.Interrupt, syscall.SIGTERM,
	)
	defer cancel()

	// Build the structured logger.
	structlog := buildLogger(f, cfg, stdout)

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
func buildLogger(f runFlags, cfg config.Config, stdout io.Writer) *logger.Logger {
	if !f.noTUI {
		return logger.Discard()
	}
	format := logger.FormatText
	if cfg.LogFormat == "json" {
		format = logger.FormatJSON
	}
	return logger.New(logger.Config{
		Level:  logger.ParseLevel(cfg.LogLevel),
		Format: format,
		Writer: stdout,
	})
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
	srv := httpserver.New(f.httpAddr, reg)
	if err := srv.Start(ctx); err != nil {
		fmt.Fprintf(stderr, "warning: cannot start HTTP server: %v\n", err)
		return reg, nil
	}
	fmt.Fprintf(stdout, "[info] http: listening on %s\n", f.httpAddr)
	return reg, srv
}

// ----- service -----

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

// ----- YAML config loading -----

func loadConfigFile(path string, stderr io.Writer) config.Config {
	if path == "" {
		path = defaultConfigPath()
	}
	if path == "" {
		return config.Config{}
	}
	f, err := os.Open(path)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Fprintf(stderr, "warning: cannot open config file %q: %v\n", path, err)
		}
		return config.Config{}
	}
	defer f.Close()
	var cfg config.Config
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		// An empty or comments-only file yields io.EOF (no YAML document);
		// that is not a parse error — it means "use defaults".
		if err == io.EOF {
			return config.Config{}
		}
		fmt.Fprintf(stderr, "warning: cannot parse config file %q: %v\n", path, err)
		return config.Config{}
	}
	return cfg
}

func defaultConfigPath() string {
	if p := os.Getenv("OTEDAMA_CONFIG"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home + "/.config/otedama/config.yaml"
}

// ----- helpers -----

func safeDisplay(v string) string {
	if v == "" {
		return "(default)"
	}
	// Strip control characters (ESC, newlines, DEL, …) so a malicious
	// config value cannot inject ANSI escape sequences or forge log lines
	// when echoed to a terminal. Printable text is returned unchanged.
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

func maskAddress(addr string) string {
	if len(addr) <= 10 {
		return addr
	}
	return addr[:6] + strings.Repeat("·", 3) + addr[len(addr)-4:]
}

// ----- doctor subcommand -----

func cmdDoctor(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configFile := fs.String("config", "", "Path to config.yaml to diagnose.")
	btcAddr := fs.String("bitcoin-address", "", "Bitcoin address to validate.")
	dataDir := fs.String("data-dir", "", "Data directory to check.")
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
	report.Print(stdout)
	return report.ExitCode()
}
