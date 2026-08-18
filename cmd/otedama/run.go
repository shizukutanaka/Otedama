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
	"unicode"

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
	configFile               string
	dryRun                   bool
	noTUI                    bool
	walletPassphrase         string
	walletMnemonicPassphrase string
	pprofEnabled             bool
	logFile                  string // --log-file: audit-trail path, written even under the TUI
	showOrigin               bool   // --origin: annotate config show output with value sources
	jsonOut                  bool   // --json: emit config show output as JSON
}

// parseRunFlags builds the flag set shared by `run`, `config show`, and
// `config validate` (all three need the same config-resolution inputs).
// name is used only for the FlagSet's own identity, which Go's flag
// package prints as "Usage of <name>:" on --help/parse-error — passing
// the caller's actual command name (e.g. "config validate", not always
// "run") keeps that header accurate regardless of which subcommand is
// asking for help.
func parseRunFlags(name string, args []string, stdout, stderr io.Writer) (runFlags, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	out := stderr
	if hasHelpFlag(args) {
		// See parseSubcommandFlags: --help/-h is not a usage mistake, so
		// its output belongs on stdout. This function returns a plain
		// error rather than an exit code (its three call sites each need
		// to do their own post-parse work), so the ErrHelp/exitOK
		// decision is made by the caller checking err == flag.ErrHelp.
		out = stdout
	}
	fs.SetOutput(out)
	var f runFlags
	fs.StringVar(&f.BitcoinAddress, "bitcoin-address", "", "Bitcoin address for mining rewards (required).")
	fs.StringVar(&f.LogLevel, "log-level", "", "Log level (debug|info|warn|error).")
	fs.StringVar(&f.Language, "language", "", "UI language as BCP 47 tag (e.g., ja, en, zh-CN).")
	fs.StringVar(&f.DataDir, "data-dir", "", "Directory for persistent data.")
	fs.StringVar(&f.configFile, "config", "", "Path to config.yaml (optional).")
	fs.BoolVar(&f.dryRun, "dry-run", false, "(run only) Validate configuration and exit without starting.")
	fs.BoolVar(&f.noTUI, "no-tui", false, "(run only) Disable the terminal dashboard (plain log output).")
	fs.StringVar(&f.walletPassphrase, "wallet-passphrase", "",
		"(run only) Passphrase to unlock/create the Lightning wallet. If empty, wallet is skipped.")
	fs.StringVar(&f.walletMnemonicPassphrase, "wallet-mnemonic-passphrase", "",
		"(run only) Optional BIP-39 \"25th word\" passphrase, applied only when a new wallet is "+
			"created. Distinct from --wallet-passphrase (which encrypts the seed at "+
			"rest); this changes which seed the recovery mnemonic derives to. Not "+
			"needed again after first run — it is already folded into wallet.dat. "+
			"Must be ASCII: a non-ASCII passphrase is not NFKD-normalised, so the "+
			"recovery phrase would restore a different wallet in other BIP-39 software, "+
			"and is rejected with exit 78 (docs/KNOWN_LIMITATIONS.md §19).")
	fs.StringVar(&f.LogFormat, "log-format", "", "Log output format: text or json.")
	fs.StringVar(&f.logFile, "log-file", "",
		"(run only) Append structured logs to this file. Written even while the TUI is active, "+
			"giving a long-running service an audit trail the dashboard otherwise hides.")
	fs.StringVar(&f.HTTPAddr, "http-addr", "",
		"Address for HTTP metrics/health endpoints (e.g. 127.0.0.1:9090). Empty disables.")
	fs.BoolVar(&f.pprofEnabled, "pprof", false,
		"(run only) Mount Go pprof profiling at /debug/pprof/ (only on loopback/private addresses).")
	fs.BoolVar(&f.showOrigin, "origin", false,
		"(config show only) Annotate each value with the layer that set it (default/file/env/flag).")
	fs.BoolVar(&f.jsonOut, "json", false,
		"(config show only) Emit the resolved configuration as a JSON object instead of text.")
	if err := fs.Parse(args); err != nil {
		return runFlags{}, err
	}
	return f, nil
}

// applyRunEnvFallbacks fills walletPassphrase and walletMnemonicPassphrase
// from their OTEDAMA_* environment variables when the corresponding flag
// was left at its empty default.
//
// Every other run flag is a field of config.FlagValues and gets OTEDAMA_*
// env var support for free through config.Resolve. Both wallet secrets are
// CLI-only fields of runFlags — deliberately kept out of config.Config so a
// secret never round-trips through `config show` or gets written to
// config.yaml — so they need this explicit fallback instead. (For
// walletPassphrase specifically, docs/API.md had long documented
// OTEDAMA_WALLET_PASSPHRASE as "preferred over flag in production — flag is
// visible in process lists" and doctor's "no wallet found" hint told
// operators to set it, but no code ever read it until this fallback was
// added.)
//
// A flag explicitly set on the command line always wins over the env var,
// matching the "flags > env vars" precedence documented in docs/API.md.
func applyRunEnvFallbacks(f *runFlags) {
	if f.walletPassphrase == "" {
		f.walletPassphrase = os.Getenv("OTEDAMA_WALLET_PASSPHRASE")
	}
	if f.walletMnemonicPassphrase == "" {
		f.walletMnemonicPassphrase = os.Getenv("OTEDAMA_WALLET_MNEMONIC_PASSPHRASE")
	}
}

func cmdRun(args []string, stdout, stderr io.Writer) int {
	f, err := parseRunFlags("run", args, stdout, stderr)
	if err != nil {
		if err == flag.ErrHelp {
			return exitOK
		}
		return exitUsage
	}
	applyRunEnvFallbacks(&f)

	// Auto-disable the TUI when stdout is not an interactive terminal
	// (redirected to a file/pipe, or captured by a service manager like
	// systemd's journal or launchd's file-based stdout redirection — see
	// docs/DEPLOYMENT.md and internal/daemon). Left on, the dashboard
	// writes a continuous stream of raw ANSI escape codes to whatever
	// stdout was redirected to: an unreadable, ever-growing file, or (for
	// `otedama service install`, whose generated unit always runs
	// unattended) a journald/log stream containing nothing but cursor-
	// control noise instead of the structured logs an operator actually
	// needs. This only ever narrows TUI use toward the safe default
	// (plain, readable output); --no-tui still works as an explicit
	// override, and there is no flag to force the TUI on when stdout is
	// not a terminal, since that would only ever reproduce this bug.
	if !f.noTUI {
		if out, ok := stdout.(*os.File); ok && !isTerminal(out) {
			f.noTUI = true
		}
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

	// Reject a non-portable BIP-39 passphrase here, not only in
	// lightning.NewWalletManager. The library rejects it too — that is where
	// the invariant belongs — but engine.setupWallet logs wallet failures at
	// warn level and continues without a wallet, and with the TUI active and
	// no --log-file the logger is a discard sink, so the user would see a
	// silent no-wallet run instead of the reason. Failing here makes it an
	// ordinary config error with an exit code and a message on stderr.
	if err := checkWalletMnemonicPassphrase(f.walletMnemonicPassphrase); err != nil {
		fmt.Fprintf(stderr, "%s\n", err)
		return exitConfig
	}

	// Initialise i18n bundle.
	bundle, _ := messages.NewBundle()
	lang := messages.DetectLang(cfg.Language)
	if cfg.Language == "" {
		// No explicit language configured (flag/env/file); fall back to the
		// OS locale, as documented on config.Config.Language.
		lang = messages.DetectLangFromEnv(os.Getenv)
	}

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
	metricsRegistry, httpSrv := startHTTPServer(ctx, cfg.HTTPAddr, f.pprofEnabled, stdout, stderr)
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
		Config:                   cfg,
		Output:                   stdout,
		NoTUI:                    f.noTUI,
		WalletPassphrase:         f.walletPassphrase,
		WalletMnemonicPassphrase: f.walletMnemonicPassphrase,
		Logger:                   structlog.Adapter(),
		Metrics:                  metricsRegistry,
		OnReady:                  onReady,
	}); err != nil && err != context.Canceled {
		structlog.Error("engine", "error", err.Error())
		plain("error", err.Error())
		return exitRuntime
	}

	logln("info", messages.StatusShuttingDown, nil)
	return exitOK
}

// isTerminal reports whether f is connected to an interactive terminal,
// as opposed to a redirected file, a pipe, or a service manager's log
// capture (systemd's journal, launchd's file-based stdout redirection).
// Stdlib-only: os.ModeCharDevice is set on a file's Stat() when the
// underlying descriptor is a character device, which a real terminal is
// and a regular file/pipe is not, on every platform Go supports — no
// golang.org/x/term dependency needed for this check.
func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

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

// startHTTPServer starts the health/metrics HTTP server if httpAddr is
// non-empty (resolved from --http-addr, OTEDAMA_HTTP_ADDR, or config.yaml's
// http_addr via config.Resolve). Returns the metrics registry and server
// handle (both nil if no address was set, or if startup failed — a startup
// failure is logged as a warning but does not abort the run).
func startHTTPServer(ctx context.Context, httpAddr string, pprofEnabled bool, stdout, stderr io.Writer) (*metrics.Registry, *httpserver.Server) {
	if httpAddr == "" {
		return nil, nil
	}
	reg := metrics.NewRegistry()
	srv := httpserver.New(httpAddr, reg, pprofEnabled)
	if err := srv.Start(ctx); err != nil {
		fmt.Fprintf(stderr, "warning: cannot start HTTP server: %v\n", err)
		return reg, nil
	}
	fmt.Fprintf(stdout, "[info] http: listening on %s\n", httpAddr)
	return reg, srv
}

// checkWalletMnemonicPassphrase mirrors lightning's portability rule at the
// CLI boundary so the failure is visible. See
// lightning.checkMnemonicPassphraseIsPortable for why a non-ASCII BIP-39
// passphrase is refused rather than normalised, and
// docs/KNOWN_LIMITATIONS.md §19.
//
// It duplicates a rule rather than calling into lightning because the check
// there is unexported and guards wallet *creation*, while this one guards
// *user input* and must run before anything starts. Both admit exactly the
// ASCII strings, on which NFKD is the identity; the lightning test suite pins
// that rule, and this one is pinned separately in run_test.go.
func checkWalletMnemonicPassphrase(p string) error {
	for i, r := range p {
		if r > unicode.MaxASCII {
			return fmt.Errorf(
				"--wallet-mnemonic-passphrase contains %q at byte %d, which is outside ASCII.\n"+
					"BIP-39 requires the passphrase in Unicode NFKD form, which Otedama does not\n"+
					"normalise, so this passphrase would create a wallet whose recovery phrase no\n"+
					"other BIP-39 tool can restore. Use an ASCII passphrase, or none at all\n"+
					"(see docs/KNOWN_LIMITATIONS.md §19).", r, i)
		}
	}
	return nil
}
