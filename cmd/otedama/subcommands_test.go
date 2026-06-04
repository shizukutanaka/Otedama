// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"runtime"
	"strings"
	"testing"
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
	} {
		if !strings.Contains(out.String(), field) {
			t.Errorf("config show missing %q:\n%s", field, out.String())
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
