// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/config"
)

func TestRun_NoArgsPrintsUsage(t *testing.T) {
	var out, err bytes.Buffer
	if code := run(nil, &out, &err); code != exitUsage {
		t.Errorf("code=%d, want %d", code, exitUsage)
	}
	if !strings.Contains(err.String(), "otedama run") {
		t.Errorf("usage missing 'otedama run':\n%s", err.String())
	}
}

func TestPrintUsage_ContainsExitCodes(t *testing.T) {
	var buf bytes.Buffer
	printUsage(&buf)
	out := buf.String()

	// The usage text must document the exit-code contract so operators can
	// rely on it for shell scripting without reading the source.
	for _, want := range []string{
		"Exit codes",
		"0",  // success
		"1",  // runtime
		"64", // usage (EX_USAGE)
		"78", // config (EX_CONFIG)
		"doctor",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("printUsage missing %q:\n%s", want, out)
		}
	}
}

func TestExitCodeConstants_Values(t *testing.T) {
	// Verify exit code constants match documented sysexits.h values so
	// accidental renaming never silently breaks the contract.
	if exitOK != 0 {
		t.Errorf("exitOK = %d, want 0", exitOK)
	}
	if exitRuntime != 1 {
		t.Errorf("exitRuntime = %d, want 1", exitRuntime)
	}
	if exitUsage != 64 {
		t.Errorf("exitUsage = %d, want 64 (EX_USAGE)", exitUsage)
	}
	if exitConfig != 78 {
		t.Errorf("exitConfig = %d, want 78 (EX_CONFIG)", exitConfig)
	}
}

func TestRun_Help(t *testing.T) {
	for _, arg := range []string{"help", "--help", "-h"} {
		var out, err bytes.Buffer
		if code := run([]string{arg}, &out, &err); code != exitOK {
			t.Errorf("%s: code=%d", arg, code)
		}
		if !strings.Contains(out.String(), "otedama run") {
			t.Errorf("%s: missing usage text", arg)
		}
	}
}

func TestVersion_Plain(t *testing.T) {
	var out, err bytes.Buffer
	if code := run([]string{"version"}, &out, &err); code != exitOK {
		t.Errorf("code=%d err=%s", code, err.String())
	}
	if !strings.HasPrefix(out.String(), "otedama ") {
		t.Errorf("version should start 'otedama ': %q", out.String())
	}
}

func TestVersion_JSON(t *testing.T) {
	var out, err bytes.Buffer
	run([]string{"version", "--json"}, &out, &err) //nolint
	var v map[string]any
	if e := json.Unmarshal(out.Bytes(), &v); e != nil {
		t.Fatalf("JSON invalid: %v", e)
	}
	for _, k := range []string{"version", "commit", "build_date", "go_version", "platform"} {
		if _, ok := v[k]; !ok {
			t.Errorf("JSON missing key %q", k)
		}
	}
}

func TestConfigValidate_MissingAddress(t *testing.T) {
	var out, err bytes.Buffer
	if code := run([]string{"config", "validate"}, &out, &err); code != exitConfig {
		t.Errorf("code=%d, want exitConfig", code)
	}
	if !strings.Contains(err.String(), "bitcoin_address") {
		t.Errorf("missing 'bitcoin_address':\n%s", err.String())
	}
}

func TestConfigValidate_ValidAddress(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"config", "validate",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &out, &err)
	if code != exitOK {
		t.Errorf("code=%d err=%s", code, err.String())
	}
}

// TestZeroConfigurationStartup is the core acceptance test.
func TestZeroConfigurationStartup(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--dry-run",
	}, &out, &err)
	if code != exitOK {
		t.Fatalf("zero-config dry-run failed code=%d err=%s", code, err.String())
	}
	if !strings.Contains(out.String(), "dry-run") {
		t.Errorf("dry-run output missing text:\n%s", out.String())
	}
}

func TestRun_WalletPassphraseFlag(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--wallet-passphrase", "test-passphrase",
		"--dry-run",
	}, &out, &err)
	if code != exitOK {
		t.Errorf("code=%d err=%s", code, err.String())
	}
}

// ----- applyRunEnvFallbacks -----
//
// docs/API.md and doctor's "no wallet found" hint have long documented
// OTEDAMA_WALLET_PASSPHRASE as a valid configuration source, but no code
// ever read it: walletPassphrase is a CLI-only runFlags field, not part of
// config.FlagValues, so it never got the OTEDAMA_* env var wiring every
// other flag gets for free via config.Resolve. These tests pin the fix.
// (OTEDAMA_HTTP_ADDR had the same defect; it is now fixed by promoting
// http_addr into config.Config itself — see config.TestResolve_HTTPAddr* —
// rather than this CLI-only fallback.)

func TestApplyRunEnvFallbacks_WalletPassphrase_FromEnvWhenFlagEmpty(t *testing.T) {
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "from-env")
	f := runFlags{}
	applyRunEnvFallbacks(&f)
	if f.walletPassphrase != "from-env" {
		t.Errorf("walletPassphrase = %q, want %q", f.walletPassphrase, "from-env")
	}
}

func TestApplyRunEnvFallbacks_WalletPassphrase_FlagWinsOverEnv(t *testing.T) {
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "from-env")
	f := runFlags{walletPassphrase: "from-flag"}
	applyRunEnvFallbacks(&f)
	if f.walletPassphrase != "from-flag" {
		t.Errorf("walletPassphrase = %q, want %q (flag must win over env)", f.walletPassphrase, "from-flag")
	}
}

func TestApplyRunEnvFallbacks_NoEnvSet_LeavesFieldEmpty(t *testing.T) {
	// os.Getenv returns "" for both "unset" and "set to empty string", so
	// setting the var to "" here exercises the same fallback branch as a
	// genuinely unset environment while still isolating this test from any
	// value the surrounding OS environment happens to have.
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "")
	f := runFlags{}
	applyRunEnvFallbacks(&f)
	if f.walletPassphrase != "" {
		t.Errorf("walletPassphrase = %q, want empty", f.walletPassphrase)
	}
}

func TestRun_WalletPassphraseFromEnv_Integration(t *testing.T) {
	// End-to-end through run(): the env var alone (no flag) must not be
	// rejected or ignored by flag parsing.
	t.Setenv("OTEDAMA_WALLET_PASSPHRASE", "test-passphrase-from-env")
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--dry-run",
	}, &out, &err)
	if code != exitOK {
		t.Errorf("code=%d err=%s", code, err.String())
	}
}

func TestRun_NoTUIFlag(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--no-tui", "--dry-run",
	}, &out, &err)
	if code != exitOK {
		t.Errorf("code=%d err=%s", code, err.String())
	}
}

func TestSafeDisplay(t *testing.T) {
	if safeDisplay("") != "(default)" {
		t.Error("empty → '(default)'")
	}
	if safeDisplay("ja") != "ja" {
		t.Error("non-empty should pass through")
	}
}

func TestLoadConfigFile_NonExistent(t *testing.T) {
	var e bytes.Buffer
	cfg := loadConfigFile("/nonexistent/config.yaml", &e)
	if cfg.BitcoinAddress != "" {
		t.Errorf("expected empty config")
	}
	if e.Len() > 0 {
		t.Errorf("unexpected stderr for missing file: %s", e.String())
	}
}

// ----- buildLogger -----

func TestBuildLogger_TUIModeDiscardsOutput(t *testing.T) {
	var out bytes.Buffer
	f := runFlags{noTUI: false} // TUI active
	log, cleanup := buildLogger(f, config.Config{LogLevel: "info"}, &out)
	defer cleanup()

	// In TUI mode, log output must be discarded so it does not corrupt
	// the dashboard.
	log.Adapter()("info", "this should not appear")
	if out.Len() != 0 {
		t.Errorf("TUI-mode logger wrote %d bytes to stdout, want 0:\n%s", out.Len(), out.String())
	}
}

func TestBuildLogger_NoTUIWritesText(t *testing.T) {
	var out bytes.Buffer
	f := runFlags{noTUI: true}
	log, cleanup := buildLogger(f, config.Config{LogLevel: "info", LogFormat: "text"}, &out)
	defer cleanup()

	log.Adapter()("info", "hello-text-log")
	if !strings.Contains(out.String(), "hello-text-log") {
		t.Errorf("text logger output missing message:\n%s", out.String())
	}
}

func TestBuildLogger_NoTUIWritesJSON(t *testing.T) {
	var out bytes.Buffer
	f := runFlags{noTUI: true}
	log, cleanup := buildLogger(f, config.Config{LogLevel: "info", LogFormat: "json"}, &out)
	defer cleanup()

	log.Adapter()("info", "hello-json-log")
	line := strings.TrimSpace(out.String())
	if line == "" {
		t.Fatal("json logger produced no output")
	}
	// Output must be valid JSON.
	var obj map[string]any
	if err := json.Unmarshal([]byte(line), &obj); err != nil {
		t.Errorf("json logger output is not valid JSON: %v\n%s", err, line)
	}
}

func TestBuildLogger_TUIWithLogFileWritesToFileNotStdout(t *testing.T) {
	// The key audit-trail case: TUI active + --log-file. Logs must reach the
	// file (the dashboard otherwise hides them) but never stdout (it would
	// corrupt the display).
	var out bytes.Buffer
	path := filepath.Join(t.TempDir(), "audit.log")
	f := runFlags{noTUI: false, logFile: path}
	log, cleanup := buildLogger(f, config.Config{LogLevel: "info", LogFormat: "text"}, &out)

	log.Adapter()("info", "tui-audit-entry")
	cleanup() // close the file before reading

	if out.Len() != 0 {
		t.Errorf("TUI+log-file wrote to stdout, want 0 bytes:\n%s", out.String())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if !strings.Contains(string(data), "tui-audit-entry") {
		t.Errorf("log file missing entry; got:\n%s", data)
	}
}

func TestBuildLogger_NoTUIWithLogFileWritesBoth(t *testing.T) {
	// Plain mode + --log-file: logs go to both the console and the file.
	var out bytes.Buffer
	path := filepath.Join(t.TempDir(), "audit.log")
	f := runFlags{noTUI: true, logFile: path}
	log, cleanup := buildLogger(f, config.Config{LogLevel: "info", LogFormat: "text"}, &out)

	log.Adapter()("info", "both-sinks-entry")
	cleanup()

	if !strings.Contains(out.String(), "both-sinks-entry") {
		t.Errorf("stdout missing entry:\n%s", out.String())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if !strings.Contains(string(data), "both-sinks-entry") {
		t.Errorf("log file missing entry; got:\n%s", data)
	}
}

func TestBuildLogger_LogFilePermissionsAre0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	f := runFlags{noTUI: true, logFile: path}
	_, cleanup := buildLogger(f, config.Config{LogLevel: "info"}, &bytes.Buffer{})
	cleanup()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat log file: %v", err)
	}
	// The log file may contain pool URLs / worker names — keep it owner-only.
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("log file perms = %04o, want 0600", perm)
	}
}

func TestBuildLogger_UnopenableLogFileDoesNotPanic(t *testing.T) {
	// A bad path must degrade to the no-file behaviour (warning to stderr),
	// not crash the run. Point at a file under a non-existent directory.
	var out bytes.Buffer
	path := filepath.Join(t.TempDir(), "no-such-dir", "audit.log")
	f := runFlags{noTUI: true, logFile: path}
	log, cleanup := buildLogger(f, config.Config{LogLevel: "info"}, &out)
	defer cleanup()

	// Logging still works (falls back to stdout since the file failed to open).
	log.Adapter()("info", "fallback-entry")
	if !strings.Contains(out.String(), "fallback-entry") {
		t.Errorf("expected fallback to stdout when log file cannot open:\n%s", out.String())
	}
}

// ============================================================================
// cmdVersion — flag parse error path
// ============================================================================

func TestVersion_UnknownFlagReturnsUsage(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{"version", "--this-flag-does-not-exist"}, &out, &errb)
	if code != exitUsage {
		t.Errorf("version with unknown flag: code=%d, want exitUsage(%d)", code, exitUsage)
	}
}

// ============================================================================
// startHTTPServer — no-addr and with-addr paths
// ============================================================================

func TestStartHTTPServer_NoAddrReturnsNils(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out, errb bytes.Buffer
	reg, srv := startHTTPServer(ctx, "", false, &out, &errb)
	if reg != nil {
		t.Error("startHTTPServer(no addr): reg should be nil")
	}
	if srv != nil {
		t.Error("startHTTPServer(no addr): srv should be nil")
	}
}

func TestStartHTTPServer_WithAddrStartsServer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out, errb bytes.Buffer
	reg, srv := startHTTPServer(ctx, "127.0.0.1:0", false, &out, &errb)
	if errb.Len() != 0 {
		t.Fatalf("startHTTPServer: unexpected stderr: %s", errb.String())
	}
	if reg == nil {
		t.Fatal("startHTTPServer: reg should not be nil")
	}
	if srv == nil {
		t.Fatal("startHTTPServer: srv should not be nil")
	}
	defer srv.Stop()
	if !strings.Contains(out.String(), "http:") {
		t.Errorf("startHTTPServer: expected log line; got %q", out.String())
	}
}

// ============================================================================
// cmdService install — flag parsing path (fails at OS level, not flag level)
// ============================================================================

func TestService_Install_DoesNotCrash(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{"service", "install"}, &out, &errb)
	switch code {
	case exitOK, exitRuntime:
		// Both are acceptable: success on a configured system, or a graceful
		// "cannot install service" on an unconfigured/CI environment.
	default:
		t.Errorf("service install: unexpected exit code %d (out=%s err=%s)", code, out.String(), errb.String())
	}
}
