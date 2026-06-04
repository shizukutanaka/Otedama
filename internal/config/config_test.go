// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package config

import (
	"strings"
	"testing"
)

// ----- Defaults tests -----

func TestDefaults_HasNoBitcoinAddress(t *testing.T) {
	// The zero BitcoinAddress is a deliberate signal: no default can be
	// chosen, so the user must provide one. If this test breaks, someone
	// has added a default address, which would cause funds to be
	// redirected to an unintended wallet.
	c := Defaults()
	if c.BitcoinAddress != "" {
		t.Fatalf("Defaults().BitcoinAddress = %q, must be empty", c.BitcoinAddress)
	}
}

func TestDefaults_LogLevelIsInfo(t *testing.T) {
	c := Defaults()
	if c.LogLevel != "info" {
		t.Errorf("Defaults().LogLevel = %q, want %q", c.LogLevel, "info")
	}
}

// ----- Resolve precedence tests -----

func TestResolve_FlagOverridesEnvOverridesFileOverridesDefaults(t *testing.T) {
	fromFile := Config{
		BitcoinAddress: "bc1qfromfile000000000000000000000000000000",
		LogLevel:       "debug",
	}
	env := map[string]string{
		"OTEDAMA_BITCOIN_ADDRESS": "bc1qfromenv0000000000000000000000000000000",
		"OTEDAMA_LOG_LEVEL":       "warn",
	}
	flags := FlagValues{
		BitcoinAddress: "bc1qfromflag00000000000000000000000000000000",
	}

	got := Resolve(fromFile, env, flags)

	// Flag wins for BitcoinAddress.
	if got.BitcoinAddress != flags.BitcoinAddress {
		t.Errorf("BitcoinAddress = %q, want flag value %q", got.BitcoinAddress, flags.BitcoinAddress)
	}
	// Env wins for LogLevel (no flag provided).
	if got.LogLevel != "warn" {
		t.Errorf("LogLevel = %q, want env value %q", got.LogLevel, "warn")
	}
}

func TestResolve_FileOverridesDefaultsWhenNoEnvOrFlag(t *testing.T) {
	fromFile := Config{
		LogLevel: "error",
	}
	got := Resolve(fromFile, nil, FlagValues{})

	if got.LogLevel != "error" {
		t.Errorf("LogLevel = %q, want file value %q", got.LogLevel, "error")
	}
}

func TestResolve_EmptyLayersPreserveDefaults(t *testing.T) {
	// With no file, no env, no flags, the result must equal Defaults.
	got := Resolve(Config{}, nil, FlagValues{})
	want := Defaults()

	if got.LogLevel != want.LogLevel {
		t.Errorf("LogLevel = %q, want default %q", got.LogLevel, want.LogLevel)
	}
	if got.BitcoinAddress != "" {
		t.Errorf("BitcoinAddress = %q, must remain empty", got.BitcoinAddress)
	}
}

func TestResolve_EmptyStringInHigherLayerDoesNotOverrideLower(t *testing.T) {
	// An empty string at a higher layer must be treated as "not set",
	// not as "override with empty". Otherwise, an empty env variable
	// would erase the value set in the config file.
	fromFile := Config{
		LogLevel: "debug",
	}
	env := map[string]string{
		"OTEDAMA_LOG_LEVEL": "",
	}
	got := Resolve(fromFile, env, FlagValues{LogLevel: ""})

	if got.LogLevel != "debug" {
		t.Errorf("LogLevel = %q, want file value %q (empty env/flag must not override)", got.LogLevel, "debug")
	}
}

func TestResolve_PoolsFromFileUsedWhenFlagsEmpty(t *testing.T) {
	// Pools are only configurable via file (not env or flag in v3.0.0-alpha).
	// Ensure file-provided pools propagate through Resolve.
	fromFile := Config{
		Pools: []PoolConfig{
			{URL: "stratum+v2://braiins.com:3336"},
		},
	}
	got := Resolve(fromFile, nil, FlagValues{})

	if len(got.Pools) != 1 {
		t.Fatalf("got %d pools, want 1", len(got.Pools))
	}
	if got.Pools[0].URL != "stratum+v2://braiins.com:3336" {
		t.Errorf("Pools[0].URL = %q, want file value", got.Pools[0].URL)
	}
}

// ----- Validate tests -----

func TestValidate_RejectsMissingBitcoinAddress(t *testing.T) {
	c := Defaults()
	err := c.Validate()
	if err == nil {
		t.Fatal("Validate() on Defaults() must return error (no BitcoinAddress)")
	}
	if !strings.Contains(err.Error(), "bitcoin_address") {
		t.Errorf("error = %q, must mention bitcoin_address", err)
	}
}

func TestValidate_AcceptsValidAddresses(t *testing.T) {
	addresses := []string{
		"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", // Bech32 P2WPKH
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",         // P2PKH
		"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",         // P2SH
	}
	for _, addr := range addresses {
		t.Run(addr[:10], func(t *testing.T) {
			t.Parallel()
			c := Defaults()
			c.BitcoinAddress = addr
			c.LogLevel = "info"
			if err := c.Validate(); err != nil {
				t.Errorf("Validate() rejected valid address %q: %v", addr, err)
			}
		})
	}
}

func TestValidate_RejectsInvalidAddresses(t *testing.T) {
	tests := []struct {
		name string
		addr string
	}{
		{"too short", "1abc"},
		{"starts with wrong char", "Xabc123456789012345678901234567890"},
		{"testnet address rejected", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"},
		{"too long", strings.Repeat("b", 100)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			c := Defaults()
			c.BitcoinAddress = tt.addr
			if err := c.Validate(); err == nil {
				t.Errorf("Validate() accepted invalid address %q", tt.addr)
			}
		})
	}
}

func TestValidate_RejectsUnknownLogLevel(t *testing.T) {
	c := Defaults()
	c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	c.LogLevel = "trace" // invalid

	err := c.Validate()
	if err == nil {
		t.Fatal("Validate() accepted invalid LogLevel")
	}
	if !strings.Contains(err.Error(), "log_level") {
		t.Errorf("error = %q, must mention log_level", err)
	}
}

func TestValidate_AcceptsAllValidLogLevels(t *testing.T) {
	for _, level := range []string{"debug", "info", "warn", "error"} {
		t.Run(level, func(t *testing.T) {
			t.Parallel()
			c := Defaults()
			c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
			c.LogLevel = level
			if err := c.Validate(); err != nil {
				t.Errorf("Validate() rejected valid log level %q: %v", level, err)
			}
		})
	}
}

func TestValidate_PoolURLs(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{"stratum+tcp accepted", "stratum+tcp://pool.example.com:3333", false},
		{"stratum+tls accepted", "stratum+tls://pool.example.com:3334", false},
		{"stratum+v2 accepted", "stratum+v2://pool.example.com:34254", false},
		{"stratum+v2tls accepted", "stratum+v2tls://pool.example.com:34254", false},
		{"http rejected", "http://pool.example.com", true},
		{"https rejected", "https://pool.example.com", true},
		{"ssh rejected", "ssh://pool.example.com", true},
		{"no scheme rejected", "pool.example.com:3333", true},
		{"empty host rejected", "stratum+v2://", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			c := Defaults()
			c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
			c.Pools = []PoolConfig{{URL: tt.url}}

			err := c.Validate()
			hasErr := err != nil
			if hasErr != tt.wantErr {
				t.Errorf("Validate() for URL %q: got error=%v, want error=%v (err=%v)",
					tt.url, hasErr, tt.wantErr, err)
			}
		})
	}
}

func TestValidate_AggregatesMultipleIssues(t *testing.T) {
	// A Config with multiple problems must report all of them in one
	// error message, so users can fix everything in a single edit.
	c := Config{
		BitcoinAddress: "invalid",
		LogLevel:       "unknown",
		Pools: []PoolConfig{
			{URL: "not-a-url"},
		},
	}

	err := c.Validate()
	if err == nil {
		t.Fatal("Validate() must fail for invalid Config")
	}

	msg := err.Error()
	for _, want := range []string{"bitcoin_address", "log_level", "pools[0]"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error = %q, missing mention of %q", msg, want)
		}
	}
}

// ----- Integration: zero-configuration invocation -----

func TestZeroConfigurationStartup(t *testing.T) {
	// This is the acceptance test for Otedama's core differentiator:
	// a user must be able to start mining with only a BitcoinAddress.
	// If this test breaks, we have regressed on the most important
	// design promise of the product.
	flags := FlagValues{
		BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}
	cfg := Resolve(Config{}, nil, flags)

	if err := cfg.Validate(); err != nil {
		t.Fatalf("zero-configuration invocation (BitcoinAddress only) failed validation: %v", err)
	}

	// Verify sane defaults are in place.
	if cfg.LogLevel != "info" {
		t.Errorf("zero-config LogLevel = %q, want %q", cfg.LogLevel, "info")
	}
}

// ============================================================================
// LogFormat — config file / env / flag precedence
// ============================================================================

func TestLogFormat_DefaultIsText(t *testing.T) {
	cfg := Defaults()
	if cfg.LogFormat != "text" {
		t.Errorf("default LogFormat = %q, want text", cfg.LogFormat)
	}
}

func TestLogFormat_FromConfigFile(t *testing.T) {
	file := Config{LogFormat: "json"}
	cfg := Resolve(file, nil, FlagValues{})
	if cfg.LogFormat != "json" {
		t.Errorf("LogFormat = %q, want json (from config file)", cfg.LogFormat)
	}
}

func TestLogFormat_EnvOverridesFile(t *testing.T) {
	file := Config{LogFormat: "json"}
	env := map[string]string{"OTEDAMA_LOG_FORMAT": "text"}
	cfg := Resolve(file, env, FlagValues{})
	if cfg.LogFormat != "text" {
		t.Errorf("LogFormat = %q, want text (env overrides file)", cfg.LogFormat)
	}
}

func TestLogFormat_FlagOverridesEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_LOG_FORMAT": "json"}
	flags := FlagValues{LogFormat: "text"}
	cfg := Resolve(Config{}, env, flags)
	if cfg.LogFormat != "text" {
		t.Errorf("LogFormat = %q, want text (flag overrides env)", cfg.LogFormat)
	}
}

func TestLogFormat_EmptyFileDoesNotClobberDefault(t *testing.T) {
	file := Config{} // LogFormat is empty
	cfg := Resolve(file, nil, FlagValues{})
	if cfg.LogFormat != "text" {
		t.Errorf("LogFormat = %q, want text (empty file preserves default)", cfg.LogFormat)
	}
}

func TestZeroConfigurationStartup_IncludesLogFormat(t *testing.T) {
	flags := FlagValues{
		BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
	}
	cfg := Resolve(Config{}, nil, flags)
	if cfg.LogFormat != "text" {
		t.Errorf("zero-config LogFormat = %q, want text", cfg.LogFormat)
	}
}
