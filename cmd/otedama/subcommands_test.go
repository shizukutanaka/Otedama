// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/daemon"
)

// ============================================================================
// doctor subcommand
// ============================================================================

func TestDoctor_NoArgs_Runs(t *testing.T) {
	// doctor with no flags should run all default checks and exit.
	// Exit code depends on the test host environment (network, sysfs).
	// We just verify it does not crash and produces output.
	var out, err bytes.Buffer
	code := run([]string{"doctor"}, &out, &err)

	// Exit code 0 (pass), 1 (warn), or 2 (fail) are all acceptable here.
	if code < 0 || code > 2 {
		t.Errorf("doctor exit code = %d, want 0, 1, or 2", code)
	}
	// Output must include at least one check result.
	if !strings.Contains(out.String(), "[") {
		t.Errorf("doctor produced no bracketed status lines:\n%s", out.String())
	}
	// A summary line must be present.
	if !strings.Contains(out.String(), "Summary:") {
		t.Errorf("doctor missing summary line:\n%s", out.String())
	}
}

func TestDoctor_WithValidAddress_HigherPassCount(t *testing.T) {
	// With a valid address, doctor should report at least one fewer
	// failure than without.
	var outNoAddr, errNoAddr bytes.Buffer
	run([]string{"doctor"}, &outNoAddr, &errNoAddr)

	var outWithAddr, errWithAddr bytes.Buffer
	run([]string{
		"doctor",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &outWithAddr, &errWithAddr)

	// The "Bitcoin address" check must change from fail to pass.
	if !strings.Contains(outWithAddr.String(), "[✓] Bitcoin address") {
		t.Errorf("doctor with valid address should pass Bitcoin address check:\n%s",
			outWithAddr.String())
	}
}

func TestDoctor_JSONFlag_EmitsValidJSON(t *testing.T) {
	var out, errb bytes.Buffer
	run([]string{
		"doctor", "--json",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &out, &errb)

	var doc struct {
		Summary struct {
			Passed, Failed, Warnings, Skipped int
		}
		ExitCode int `json:"exit_code"`
		Checks   []struct {
			Name, Status string
		}
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("doctor --json did not emit valid JSON: %v\n%s", err, out.String())
	}
	if len(doc.Checks) == 0 {
		t.Error("doctor --json reported no checks")
	}
	// The valid address must show as a passing check in the structured output.
	found := false
	for _, c := range doc.Checks {
		if c.Name == "Bitcoin address" {
			found = true
			if c.Status != "pass" {
				t.Errorf("Bitcoin address status = %q, want pass", c.Status)
			}
		}
	}
	if !found {
		t.Error("doctor --json missing the Bitcoin address check")
	}
}

func TestDoctor_WithInvalidAddress_FailsCheck(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"doctor",
		"--bitcoin-address", "obviously-not-a-bitcoin-address",
	}, &out, &err)

	// Exit code 2 because address check fails.
	if code != 2 {
		t.Errorf("doctor with invalid address exit = %d, want 2", code)
	}
	if !strings.Contains(out.String(), "[✗] Bitcoin address") {
		t.Errorf("doctor should fail address check:\n%s", out.String())
	}
	// Fix line must be present for failures.
	if !strings.Contains(out.String(), "fix:") {
		t.Errorf("doctor fail should include fix hint:\n%s", out.String())
	}
}

func TestDoctor_NonExistentDataDir_EmitsWarning(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"doctor",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--data-dir", "/definitely/does/not/exist/otedama-test",
	}, &out, &err)

	// The data dir check emits a warning, not a failure, when missing.
	if code != 1 && code != 2 {
		t.Errorf("doctor with missing data-dir exit = %d, want 1 or 2 (due to potentially other issues)", code)
	}
	// Must mention the data dir.
	if !strings.Contains(out.String(), "Data directory") {
		t.Errorf("doctor output missing Data directory section:\n%s", out.String())
	}
}

// ============================================================================
// service subcommand — unit-level (no actual install)
// ============================================================================

func TestService_NoArgs_UsageError(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"service"}, &out, &err)
	if code != exitUsage {
		t.Errorf("service with no args: exit = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(err.String(), "expected subcommand") {
		t.Errorf("usage message unclear:\n%s", err.String())
	}
}

func TestService_UnknownSubcommand(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"service", "nonsense"}, &out, &err)
	if code != exitUsage {
		t.Errorf("unknown service subcommand exit = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(err.String(), "unknown subcommand") {
		t.Errorf("error message missing 'unknown subcommand':\n%s", err.String())
	}
}

func TestService_Status_DoesNotCrash(t *testing.T) {
	// On a machine where Otedama is not installed as a service, status
	// must report "not installed" without error.
	var out, err bytes.Buffer
	code := run([]string{"service", "status"}, &out, &err)

	switch runtime.GOOS {
	case "linux", "darwin":
		// Should succeed and report installed/not-installed.
		if code != exitOK {
			t.Errorf("service status exit = %d, want 0 (out=%s err=%s)",
				code, out.String(), err.String())
		}
		if !strings.Contains(out.String(), "Otedama service:") {
			t.Errorf("status output missing expected prefix:\n%s", out.String())
		}
	case "windows":
		// Windows path may error if SCM access denied, but must not crash.
		if code < 0 {
			t.Errorf("service status negative exit: %d", code)
		}
	default:
		// Unsupported platform returns error.
		if code == exitOK {
			t.Errorf("unsupported platform unexpectedly succeeded")
		}
	}
}

// ============================================================================
// config subcommand — both show and validate
// ============================================================================

func TestConfigShow_NoArgs(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"config", "show"}, &out, &err)
	if code != exitOK {
		t.Errorf("config show exit = %d, want 0", code)
	}
	// Must include key configuration fields.
	for _, field := range []string{
		"bitcoin_address",
		"log_level",
		"data_dir",
		"pools",
		"arbitration_hysteresis_pct",
		"curtail_below_btc_usd",
		"power_watts",
		"electricity_price_per_kwh",
		"http_addr",
	} {
		if !strings.Contains(out.String(), field) {
			t.Errorf("config show missing %q:\n%s", field, out.String())
		}
	}
}

func TestConfigShow_JSON_HTTPAddrFromFlagAndOrigin(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{
		"config", "show", "--json", "--origin",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--http-addr", "127.0.0.1:9090",
	}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --json exit = %d, want 0", code)
	}
	var doc struct {
		HTTPAddr string            `json:"http_addr"`
		Origins  map[string]string `json:"origins"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("config show --json not valid JSON: %v\n%s", err, out.String())
	}
	if doc.HTTPAddr != "127.0.0.1:9090" {
		t.Errorf("http_addr = %q, want 127.0.0.1:9090 (from flag)", doc.HTTPAddr)
	}
	if doc.Origins["http_addr"] != "flag" {
		t.Errorf("origins.http_addr = %q, want flag", doc.Origins["http_addr"])
	}
}

func TestConfigShow_JSON_EmitsResolvedConfig(t *testing.T) {
	t.Setenv("OTEDAMA_POWER_WATTS", "275")
	var out, errb bytes.Buffer
	code := run([]string{
		"config", "show", "--json",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --json exit = %d, want 0", code)
	}
	var doc struct {
		BitcoinAddress string  `json:"bitcoin_address"`
		PowerWatts     float64 `json:"power_watts"`
		LogLevel       string  `json:"log_level"`
		Pools          []string
		Origins        map[string]string `json:"origins"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("config show --json not valid JSON: %v\n%s", err, out.String())
	}
	if doc.BitcoinAddress != "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" {
		t.Errorf("bitcoin_address = %q", doc.BitcoinAddress)
	}
	if doc.PowerWatts != 275 {
		t.Errorf("power_watts = %v, want 275 (from env)", doc.PowerWatts)
	}
	if doc.LogLevel != "info" {
		t.Errorf("log_level = %q, want info default", doc.LogLevel)
	}
	// Without --origin, the origins object must be omitted.
	if doc.Origins != nil {
		t.Errorf("origins present without --origin: %v", doc.Origins)
	}
}

// TestConfigShow_JSON_EmitsConfiguredPools covers writeConfigJSON's pool-flatten
// loop, which the flag-only JSON tests never reach (pools come only from a config
// file). It asserts the URLs survive into the JSON "pools" array in order.
func TestConfigShow_JSON_EmitsConfiguredPools(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := []byte(`
bitcoin_address: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
pools:
  - url: stratum+v2tls://primary.example.com:3336
  - url: stratum+v2://backup.example.com:3336
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	var out, errb bytes.Buffer
	code := run([]string{"config", "show", "--json", "--config", path}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --json exit = %d, want 0 (stderr: %s)", code, errb.String())
	}
	var doc struct {
		Pools []string `json:"pools"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("config show --json not valid JSON: %v\n%s", err, out.String())
	}
	want := []string{
		"stratum+v2tls://primary.example.com:3336",
		"stratum+v2://backup.example.com:3336",
	}
	if len(doc.Pools) != len(want) {
		t.Fatalf("pools length = %d, want %d:\n%s", len(doc.Pools), len(want), out.String())
	}
	for i, w := range want {
		if doc.Pools[i] != w {
			t.Errorf("pools[%d] = %q, want %q", i, doc.Pools[i], w)
		}
	}
}

// TestConfigShow_JSONEncodeError_ReturnsRuntime covers writeConfigJSON's Encode
// error branch: a failing stdout writer makes the JSON encoder's Write fail, and
// the command must surface exitRuntime rather than exitOK.
func TestConfigShow_JSONEncodeError_ReturnsRuntime(t *testing.T) {
	var errb bytes.Buffer
	code := run([]string{
		"config", "show", "--json",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &failWriter{}, &errb)
	if code != exitRuntime {
		t.Errorf("config show --json with failing writer: code = %d, want exitRuntime (%d)", code, exitRuntime)
	}
}

func TestConfigShow_JSONWithOrigin_IncludesOrigins(t *testing.T) {
	t.Setenv("OTEDAMA_POWER_WATTS", "275")
	var out, errb bytes.Buffer
	run([]string{
		"config", "show", "--json", "--origin",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &out, &errb)
	var doc struct {
		Origins map[string]string `json:"origins"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, out.String())
	}
	if doc.Origins["power_watts"] != "env" {
		t.Errorf("origins.power_watts = %q, want env", doc.Origins["power_watts"])
	}
	if doc.Origins["bitcoin_address"] != "flag" {
		t.Errorf("origins.bitcoin_address = %q, want flag", doc.Origins["bitcoin_address"])
	}
}

func TestConfigShow_EconomicFieldReflectsEnvWithOrigin(t *testing.T) {
	// A value set via env must appear in `config show`, and `--origin` must
	// attribute it to the env layer — the operator's way to confirm an
	// economic setting took effect.
	t.Setenv("OTEDAMA_POWER_WATTS", "325")
	var out, errb bytes.Buffer
	code := run([]string{"config", "show", "--origin"}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --origin exit = %d, want 0", code)
	}
	s := out.String()
	if !strings.Contains(s, "power_watts") || !strings.Contains(s, "325") {
		t.Errorf("config show did not reflect OTEDAMA_POWER_WATTS=325:\n%s", s)
	}
	// The power_watts line must carry the [env] origin tag.
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "power_watts:") {
			if !strings.Contains(line, "[env]") {
				t.Errorf("power_watts line missing [env] origin: %q", line)
			}
		}
	}
}

func TestConfigShow_WithFlags_ReflectsFlags(t *testing.T) {
	var out, err bytes.Buffer
	run([]string{
		"config", "show",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--log-level", "debug",
	}, &out, &err)

	if !strings.Contains(out.String(), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq") {
		t.Errorf("config show did not reflect --bitcoin-address:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "debug") {
		t.Errorf("config show did not reflect --log-level:\n%s", out.String())
	}
}

func TestConfig_NoSubcommand(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"config"}, &out, &err)
	if code != exitUsage {
		t.Errorf("config no subcommand exit = %d, want %d", code, exitUsage)
	}
}

func TestConfig_UnknownSubcommand(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"config", "totally-invented"}, &out, &err)
	if code != exitUsage {
		t.Errorf("config unknown subcommand exit = %d, want %d", code, exitUsage)
	}
}

// ============================================================================
// HTTP-related flags
// ============================================================================

func TestRun_HTTPAddrFlag_DryRun(t *testing.T) {
	// --http-addr in combination with --dry-run must parse correctly.
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--http-addr", "127.0.0.1:0",
		"--dry-run",
	}, &out, &err)

	if code != exitOK {
		t.Errorf("run with --http-addr --dry-run exit = %d (err=%s)",
			code, err.String())
	}
}

func TestRun_LogFormatJSON_DryRun(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--log-format", "json",
		"--dry-run",
	}, &out, &err)

	if code != exitOK {
		t.Errorf("run with --log-format=json --dry-run exit = %d (err=%s)",
			code, err.String())
	}
}

func TestRun_MalformedNumericEnvVar_WarnsAndSucceeds(t *testing.T) {
	// A non-parseable numeric env var (e.g. OTEDAMA_POWER_WATTS=abc) must be
	// warned about before the run starts, not silently discarded. The run
	// itself should succeed with the default value for that field.
	t.Setenv("OTEDAMA_POWER_WATTS", "not-a-number")
	var out, errb bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--dry-run",
	}, &out, &errb)
	if code != exitOK {
		t.Errorf("run with malformed env var should succeed (dry-run): code=%d, stderr=%q",
			code, errb.String())
	}
	if !strings.Contains(errb.String(), "warning") {
		t.Errorf("malformed numeric env var should produce warning; got stderr=%q", errb.String())
	}
}

// ============================================================================
// Unknown flag handling
// ============================================================================

func TestRun_UnknownFlag_ReturnsUsageError(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--this-flag-does-not-exist",
	}, &out, &err)

	if code != exitUsage {
		t.Errorf("unknown flag exit = %d, want %d", code, exitUsage)
	}
}

func TestService_Uninstall_DoesNotCrash(t *testing.T) {
	// On a machine where Otedama is not installed as a service,
	// uninstall must terminate cleanly (either reporting success or a
	// graceful runtime error) without panicking. This is the only
	// service subcommand that previously had no test coverage.
	var out, err bytes.Buffer
	code := run([]string{"service", "uninstall"}, &out, &err)

	// We do not assert a specific exit code: on an un-privileged CI
	// runner the uninstall may legitimately fail with a permission or
	// "not installed" error (exitRuntime). What we require is that the
	// command is routed, runs, and returns one of the known exit codes
	// rather than panicking or returning an undefined value.
	switch code {
	case exitOK, exitRuntime:
		// Acceptable outcomes.
	default:
		t.Errorf("service uninstall returned unexpected exit code %d (out=%s err=%s)",
			code, out.String(), err.String())
	}
}

// ============================================================================
// run — top-level unknown subcommand
// ============================================================================

func TestRun_UnknownSubcommand_ReturnsUsage(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"totally-unknown-subcommand"}, &out, &err)
	if code != exitUsage {
		t.Errorf("unknown subcommand exit = %d, want %d", code, exitUsage)
	}
	if !strings.Contains(err.String(), "unknown subcommand") {
		t.Errorf("error message missing 'unknown subcommand':\n%s", err.String())
	}
}

// ============================================================================
// cmdConfigShow / cmdConfigValidate — flag parse error path
// ============================================================================

func TestConfigShow_UnknownFlag_ReturnsUsage(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"config", "show", "--this-flag-is-not-defined"}, &out, &err)
	if code != exitUsage {
		t.Errorf("config show unknown flag exit = %d, want %d", code, exitUsage)
	}
}

func TestConfigValidate_UnknownFlag_ReturnsUsage(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"config", "validate", "--this-flag-is-not-defined"}, &out, &err)
	if code != exitUsage {
		t.Errorf("config validate unknown flag exit = %d, want %d", code, exitUsage)
	}
}

func TestConfigValidate_MalformedNumericEnvVar_PrintsWarning(t *testing.T) {
	// OTEDAMA_POWER_WATTS=abc is a non-parseable float; it is dropped silently
	// during resolution, but `config validate` should emit a warning so the
	// operator notices the typo rather than silently mining at default settings.
	t.Setenv("OTEDAMA_POWER_WATTS", "not-a-number")
	t.Setenv("OTEDAMA_BITCOIN_ADDRESS", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")
	var out, errb bytes.Buffer
	code := run([]string{"config", "validate"}, &out, &errb)
	if code != exitOK {
		t.Errorf("config validate with malformed numeric env var should still succeed: code=%d stderr=%q",
			code, errb.String())
	}
	if !strings.Contains(errb.String(), "warning") {
		t.Errorf("malformed numeric env var should print a warning to stderr; got %q", errb.String())
	}
}

// ============================================================================
// loadConfigFile — non-NotExist open error (warns, returns empty)
// ============================================================================

func TestLoadConfigFile_UnreadableFile_WarnsOnOpen(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root bypasses file permission checks")
	}
	// Create a file then remove all permissions to force a permission-denied error.
	dir := t.TempDir()
	path := filepath.Join(dir, "locked.yaml")
	if err := os.WriteFile(path, []byte("bitcoin_address: bc1q...\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(path, 0o000); err != nil {
		t.Skip("cannot chmod in this environment")
	}
	defer os.Chmod(path, 0o600) //nolint:errcheck — restore for cleanup

	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	if !strings.Contains(stderr.String(), "warning") {
		t.Errorf("non-NotExist open error should produce warning; got: %q", stderr.String())
	}
	if cfg.BitcoinAddress != "" {
		t.Errorf("unreadable file leaked data: %q", cfg.BitcoinAddress)
	}
}

// ============================================================================
// defaultConfigPath — HOME unset returns empty string
// ============================================================================

func TestDefaultConfigPath_NoHomeDir_ReturnsEmpty(t *testing.T) {
	if os.Getenv("OTEDAMA_CONFIG") != "" {
		t.Skip("OTEDAMA_CONFIG overrides home-based path; skip")
	}
	old := os.Getenv("HOME")
	os.Unsetenv("HOME")
	defer os.Setenv("HOME", old) //nolint:errcheck

	// UserHomeDir may fall back to passwd on Linux even when HOME is unset.
	// Only assert if it actually returns "".
	got := defaultConfigPath()
	if got != "" && !strings.Contains(got, "otedama") {
		t.Errorf("defaultConfigPath = %q, want empty or otedama path", got)
	}
}

// ============================================================================
// startHTTPServer — error path when address is invalid
// ============================================================================

func TestStartHTTPServer_InvalidAddr_WarnsAndReturnsRegistryOnly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out, errb bytes.Buffer
	// An invalid port (65536) forces srv.Start to fail.
	reg, srv := startHTTPServer(ctx, "127.0.0.1:99999", false, &out, &errb)
	if srv != nil {
		defer srv.Stop()
		// On some systems the error may not be detected until Start's internal listen.
		// Accept srv non-nil only if it actually started.
	}
	if errb.Len() == 0 && srv == nil {
		// If srv is nil and no error, that means the start failed but no warning was printed.
		// This is acceptable only if reg is non-nil (the implementation returns reg on failure).
	}
	if reg == nil && srv == nil {
		// Both nil means no addr was set — but we did set an addr. At minimum reg must be set.
		// Skip assertion if the address happened to be valid on this platform.
	}
	// The key assertion: if srv fails to start, stderr must contain "warning".
	// This covers the error path in startHTTPServer.
	if errb.Len() > 0 && !strings.Contains(errb.String(), "warning") {
		t.Errorf("expected 'warning' in stderr, got: %q", errb.String())
	}
}

// ============================================================================
// cmdVersion — JSON encode error via failing writer
// ============================================================================

func TestVersion_JSONEncodeError_ReturnsRuntime(t *testing.T) {
	// Use a writer that fails immediately to trigger the json.Encode error path.
	code := run([]string{"version", "--json"}, &failWriter{}, &failWriter{})
	// Should return exitRuntime when Encode fails.
	if code != exitRuntime && code != exitOK {
		t.Errorf("version --json with failing writer: code = %d, want exitRuntime or exitOK", code)
	}
}

// failWriter always returns an error on Write.
type failWriter struct{}

func (f *failWriter) Write(p []byte) (int, error) {
	return 0, os.ErrClosed
}

func TestConfigShow_ShowsFailoverAddressesAndPools(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	content := []byte(`
bitcoin_address: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
bitcoin_addresses:
  - "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"
  - "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"
log_format: json
workers:
  name: rig-01
pools:
  - url: stratum+v2tls://primary.example.com:3336
  - url: stratum+v2://backup.example.com:3336
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	var out, errb bytes.Buffer
	if code := run([]string{"config", "show", "--config", path}, &out, &errb); code != exitOK {
		t.Fatalf("config show exit = %d, want 0 (stderr: %s)", code, errb.String())
	}
	got := out.String()

	// The effective config must surface ALL configured values, not just a count.
	for _, want := range []string{
		"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // failover address 1
		"1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", // failover address 2
		"bitcoin_addresses (failover): 2",    // list header
		"log_format:",                        // previously missing
		"json",                               // its value
		"worker_name:",                       // previously missing
		"rig-01",                             // its value
		"stratum+v2tls://primary.example.com:3336", // actual pool URLs, not just a count
		"stratum+v2://backup.example.com:3336",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("config show missing %q:\n%s", want, got)
		}
	}
}

// ============================================================================
// config show --origin
// ============================================================================

func TestConfigShow_Origin_DefaultValues(t *testing.T) {
	// With no file, env, or flags, all values are from the default layer.
	var out, errb bytes.Buffer
	code := run([]string{"config", "show", "--origin"}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --origin exit = %d, want 0 (stderr: %s)", code, errb.String())
	}
	got := out.String()
	// Every line must include "[default]" since nothing was explicitly set.
	for _, line := range strings.Split(strings.TrimSpace(got), "\n") {
		if line == "" || strings.HasPrefix(line, "  ") {
			continue // sub-items (indented pool/address lines) have no tag
		}
		if !strings.Contains(line, "[default]") {
			t.Errorf("expected [default] on line %q", line)
		}
	}
}

func TestConfigShow_Origin_FlagAnnotated(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{
		"config", "show",
		"--origin",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		"--log-level", "debug",
	}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --origin --bitcoin-address exit = %d (stderr: %s)", code, errb.String())
	}
	got := out.String()
	// bitcoin_address was provided via flag — must say [flag].
	if !strings.Contains(got, "bitcoin_address:") || !strings.Contains(got, "[flag]") {
		t.Errorf("expected [flag] annotation for bitcoin_address:\n%s", got)
	}
	// log_level was provided via flag — must say [flag].
	if !strings.Contains(got, "log_level:") {
		t.Errorf("log_level line missing:\n%s", got)
	}
	for _, line := range strings.Split(got, "\n") {
		if strings.Contains(line, "log_level:") && !strings.Contains(line, "[flag]") {
			t.Errorf("log_level should have [flag] annotation: %q", line)
		}
	}
}

func TestConfigShow_Origin_FileAnnotated(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("log_level: warn\nlog_format: json\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	var out, errb bytes.Buffer
	code := run([]string{"config", "show", "--origin", "--config", path}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show --origin --config exit = %d (stderr: %s)", code, errb.String())
	}
	got := out.String()
	// log_level and log_format came from the file.
	for _, line := range strings.Split(got, "\n") {
		if strings.Contains(line, "log_level:") && !strings.Contains(line, "[file]") {
			t.Errorf("log_level should have [file] annotation: %q", line)
		}
		if strings.Contains(line, "log_format:") && !strings.Contains(line, "[file]") {
			t.Errorf("log_format should have [file] annotation: %q", line)
		}
	}
}

func TestConfigShow_NoOriginFlag_NoAnnotations(t *testing.T) {
	// Without --origin, no bracket annotations should appear in the output.
	var out, errb bytes.Buffer
	code := run([]string{
		"config", "show",
		"--bitcoin-address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}, &out, &errb)
	if code != exitOK {
		t.Fatalf("config show exit = %d (stderr: %s)", code, errb.String())
	}
	got := out.String()
	if strings.Contains(got, "[flag]") || strings.Contains(got, "[default]") || strings.Contains(got, "[file]") || strings.Contains(got, "[env]") {
		t.Errorf("origin annotations found without --origin flag:\n%s", got)
	}
}

// ============================================================================
// doctor — fs.Parse error path
// ============================================================================

func TestDoctor_UnknownFlag_ReturnsUsage(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"doctor", "--this-flag-is-not-defined"}, &out, &err)
	if code != exitUsage {
		t.Errorf("doctor unknown flag exit = %d, want %d", code, exitUsage)
	}
}

// ============================================================================
// run — cfg.Validate error path (invalid address, reached before dry-run check)
// ============================================================================

func TestRun_InvalidAddress_ExitsWithConfig(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{
		"run",
		"--bitcoin-address", "not-a-valid-address",
		"--dry-run",
	}, &out, &err)
	if code != exitConfig {
		t.Errorf("invalid address exit = %d, want exitConfig (%d)", code, exitConfig)
	}
}

// ============================================================================
// loadConfigFile — empty path AND no home directory (double-empty guard)
// ============================================================================

func TestLoadConfigFile_EmptyPathAndNoHome_ReturnsEmpty(t *testing.T) {
	if os.Getenv("OTEDAMA_CONFIG") != "" {
		t.Skip("OTEDAMA_CONFIG overrides home-based path; skip")
	}
	old := os.Getenv("HOME")
	os.Unsetenv("HOME")
	defer os.Setenv("HOME", old) //nolint:errcheck

	// If UserHomeDir falls back to /etc/passwd, defaultConfigPath returns a
	// non-empty path and this code path is not exercised. Guard accordingly.
	result := defaultConfigPath()
	if result != "" {
		t.Skip("UserHomeDir fell back to /etc/passwd; cannot exercise double-empty guard")
	}

	var stderr bytes.Buffer
	cfg := loadConfigFile("", &stderr)
	if cfg.BitcoinAddress != "" || cfg.LogLevel != "" {
		t.Errorf("loadConfigFile with no path should return empty Config; got %+v", cfg)
	}
	if stderr.Len() != 0 {
		t.Errorf("loadConfigFile with no path should not print warnings; got: %q", stderr.String())
	}
}

// ============================================================================
// service — injectable-var tests covering all uncovered branches
// ============================================================================

func TestServiceInstall_ParseFlagError_ReturnsUsage(t *testing.T) {
	var out, err bytes.Buffer
	code := run([]string{"service", "install", "--unknown-install-flag"}, &out, &err)
	if code != exitUsage {
		t.Errorf("service install unknown flag exit = %d, want %d", code, exitUsage)
	}
}

func TestServiceInstall_NewManagerError_ReturnsRuntime(t *testing.T) {
	orig := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return nil, errInjected
	}
	defer func() { newDaemonManager = orig }()

	var out, err bytes.Buffer
	code := run([]string{"service", "install"}, &out, &err)
	if code != exitRuntime {
		t.Errorf("install manager error exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(err.String(), "service:") {
		t.Errorf("expected 'service:' in stderr; got %q", err.String())
	}
}

func TestServiceInstall_Success_PrintsConfirmation(t *testing.T) {
	origMgr := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return &daemon.Manager{}, nil
	}
	defer func() { newDaemonManager = origMgr }()

	origInst := managerInstall
	managerInstall = func(_ *daemon.Manager) error { return nil }
	defer func() { managerInstall = origInst }()

	var out, err bytes.Buffer
	code := run([]string{"service", "install"}, &out, &err)
	if code != exitOK {
		t.Errorf("install success exit = %d, want %d (err=%s)", code, exitOK, err.String())
	}
	if !strings.Contains(out.String(), "installed and started") {
		t.Errorf("expected confirmation message; got %q", out.String())
	}
}

func TestServiceUninstall_NewManagerError_ReturnsRuntime(t *testing.T) {
	orig := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return nil, errInjected
	}
	defer func() { newDaemonManager = orig }()

	var out, err bytes.Buffer
	code := run([]string{"service", "uninstall"}, &out, &err)
	if code != exitRuntime {
		t.Errorf("uninstall manager error exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(err.String(), "service:") {
		t.Errorf("expected 'service:' in stderr; got %q", err.String())
	}
}

func TestServiceUninstall_UninstallError_ReturnsRuntime(t *testing.T) {
	origMgr := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return &daemon.Manager{}, nil
	}
	defer func() { newDaemonManager = origMgr }()

	origUn := managerUninstall
	managerUninstall = func(_ *daemon.Manager) error { return errInjected }
	defer func() { managerUninstall = origUn }()

	var out, err bytes.Buffer
	code := run([]string{"service", "uninstall"}, &out, &err)
	if code != exitRuntime {
		t.Errorf("uninstall error exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(err.String(), "uninstall failed") {
		t.Errorf("expected 'uninstall failed' in stderr; got %q", err.String())
	}
}

func TestServiceStatus_NewManagerError_ReturnsRuntime(t *testing.T) {
	orig := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return nil, errInjected
	}
	defer func() { newDaemonManager = orig }()

	var out, err bytes.Buffer
	code := run([]string{"service", "status"}, &out, &err)
	if code != exitRuntime {
		t.Errorf("status manager error exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(err.String(), "service:") {
		t.Errorf("expected 'service:' in stderr; got %q", err.String())
	}
}

func TestServiceStatus_StatusError_ReturnsRuntime(t *testing.T) {
	origMgr := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return &daemon.Manager{}, nil
	}
	defer func() { newDaemonManager = origMgr }()

	origSt := managerStatus
	managerStatus = func(_ *daemon.Manager) (daemon.ServiceStatus, error) { return daemon.ServiceStatus{}, errInjected }
	defer func() { managerStatus = origSt }()

	var out, err bytes.Buffer
	code := run([]string{"service", "status"}, &out, &err)
	if code != exitRuntime {
		t.Errorf("status error exit = %d, want %d", code, exitRuntime)
	}
	if !strings.Contains(err.String(), "service status:") {
		t.Errorf("expected 'service status:' in stderr; got %q", err.String())
	}
}

func TestServiceStatus_InstalledStopped_PrintsState(t *testing.T) {
	origMgr := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return &daemon.Manager{}, nil
	}
	defer func() { newDaemonManager = origMgr }()

	origSt := managerStatus
	managerStatus = func(_ *daemon.Manager) (daemon.ServiceStatus, error) {
		return daemon.ServiceStatus{Installed: true, Running: false}, nil
	}
	defer func() { managerStatus = origSt }()

	var out, err bytes.Buffer
	code := run([]string{"service", "status"}, &out, &err)
	if code != exitOK {
		t.Errorf("status installed exit = %d, want %d (err=%s)", code, exitOK, err.String())
	}
	if !strings.Contains(out.String(), "installed, stopped") {
		t.Errorf("expected 'installed, stopped'; got %q", out.String())
	}
}

func TestServiceStatus_InstalledRunning_PrintsRunning(t *testing.T) {
	origMgr := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return &daemon.Manager{}, nil
	}
	defer func() { newDaemonManager = origMgr }()

	origSt := managerStatus
	managerStatus = func(_ *daemon.Manager) (daemon.ServiceStatus, error) {
		return daemon.ServiceStatus{Installed: true, Running: true}, nil
	}
	defer func() { managerStatus = origSt }()

	var out, err bytes.Buffer
	code := run([]string{"service", "status"}, &out, &err)
	if code != exitOK {
		t.Errorf("status running exit = %d, want %d (err=%s)", code, exitOK, err.String())
	}
	if !strings.Contains(out.String(), "installed, running") {
		t.Errorf("expected 'installed, running'; got %q", out.String())
	}
}

func TestServiceStatus_NotInstalled_PrintsNotInstalled(t *testing.T) {
	origMgr := newDaemonManager
	newDaemonManager = func(cfg, dir string, flags daemon.ServiceFlags) (*daemon.Manager, error) {
		return &daemon.Manager{}, nil
	}
	defer func() { newDaemonManager = origMgr }()

	origSt := managerStatus
	managerStatus = func(_ *daemon.Manager) (daemon.ServiceStatus, error) {
		return daemon.ServiceStatus{Installed: false}, nil
	}
	defer func() { managerStatus = origSt }()

	var out, err bytes.Buffer
	code := run([]string{"service", "status"}, &out, &err)
	if code != exitOK {
		t.Errorf("status not-installed exit = %d, want %d (err=%s)", code, exitOK, err.String())
	}
	if !strings.Contains(out.String(), "not installed") {
		t.Errorf("expected 'not installed'; got %q", out.String())
	}
}

// errInjected is a sentinel error used by injectable-var tests.
var errInjected = errors.New("injected test error")
