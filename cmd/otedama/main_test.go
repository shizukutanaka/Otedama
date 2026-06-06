// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"encoding/json"
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

func TestMaskAddress(t *testing.T) {
	addr := "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	got := maskAddress(addr)
	if !strings.HasPrefix(got, "bc1qar") {
		t.Errorf("prefix lost: %q", got)
	}
	if !strings.HasSuffix(got, "5mdq") {
		t.Errorf("suffix lost: %q", got)
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
	log := buildLogger(f, config.Config{LogLevel: "info"}, &out)

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
	log := buildLogger(f, config.Config{LogLevel: "info", LogFormat: "text"}, &out)

	log.Adapter()("info", "hello-text-log")
	if !strings.Contains(out.String(), "hello-text-log") {
		t.Errorf("text logger output missing message:\n%s", out.String())
	}
}

func TestBuildLogger_NoTUIWritesJSON(t *testing.T) {
	var out bytes.Buffer
	f := runFlags{noTUI: true}
	log := buildLogger(f, config.Config{LogLevel: "info", LogFormat: "json"}, &out)

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
