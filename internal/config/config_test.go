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

func TestValidate_BitcoinAddresses_FailoverList(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.LogLevel = "info"
		return c
	}

	t.Run("valid primary plus valid backups", func(t *testing.T) {
		c := base()
		c.BitcoinAddress = "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
		c.BitcoinAddresses = []string{"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"}
		if err := c.Validate(); err != nil {
			t.Errorf("valid failover list should pass: %v", err)
		}
	})

	t.Run("only backups, no primary", func(t *testing.T) {
		c := base()
		c.BitcoinAddress = ""
		c.BitcoinAddresses = []string{"bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"}
		if err := c.Validate(); err != nil {
			t.Errorf("a valid backup with no primary should satisfy the address requirement: %v", err)
		}
	})

	t.Run("invalid backup is rejected", func(t *testing.T) {
		c := base()
		c.BitcoinAddress = "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
		c.BitcoinAddresses = []string{"not-a-valid-address"}
		if err := c.Validate(); err == nil {
			t.Error("an invalid failover address should fail validation")
		}
	})

	t.Run("no addresses at all", func(t *testing.T) {
		c := base()
		c.BitcoinAddress = ""
		c.BitcoinAddresses = nil
		if err := c.Validate(); err == nil {
			t.Error("config with no payout address should fail validation")
		}
	})
}

func TestValidate_LogFormat(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.BitcoinAddress = "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
		return c
	}
	for _, ok := range []string{"text", "json"} {
		c := base()
		c.LogFormat = ok
		if err := c.Validate(); err != nil {
			t.Errorf("log_format %q should be valid: %v", ok, err)
		}
	}
	c := base()
	c.LogFormat = "yaml"
	if err := c.Validate(); err == nil {
		t.Error("invalid log_format should fail validation")
	}
}

func TestResolve_FileLogFormatNotClobberedByFlagDefault(t *testing.T) {
	// Regression: --log-format previously defaulted to "text" on a
	// standalone field, so a config-file log_format was ignored. With the
	// flag bound to FlagValues (empty default), the file value must win
	// when no flag is passed.
	fromFile := Config{LogFormat: "json"}
	cfg := Resolve(fromFile, nil, FlagValues{})
	if cfg.LogFormat != "json" {
		t.Errorf("Resolve: file log_format=json overridden, got %q", cfg.LogFormat)
	}
	// An explicit flag still wins.
	cfg = Resolve(fromFile, nil, FlagValues{LogFormat: "text"})
	if cfg.LogFormat != "text" {
		t.Errorf("Resolve: flag log_format=text should win, got %q", cfg.LogFormat)
	}
}

// ============================================================================
// Resolve — coverage for fields not exercised in the table above
// ============================================================================

func TestResolve_WorkerNameFromFile(t *testing.T) {
	fromFile := Config{Workers: WorkerConfig{Name: "rig-01"}}
	cfg := Resolve(fromFile, nil, FlagValues{})
	if cfg.Workers.Name != "rig-01" {
		t.Errorf("Workers.Name = %q, want rig-01 (from config file)", cfg.Workers.Name)
	}
}

func TestResolve_LanguageFromFile(t *testing.T) {
	fromFile := Config{Language: "ja"}
	cfg := Resolve(fromFile, nil, FlagValues{})
	if cfg.Language != "ja" {
		t.Errorf("Language = %q, want ja (from config file)", cfg.Language)
	}
}

func TestResolve_DataDirFromFile(t *testing.T) {
	fromFile := Config{DataDir: "/data/otedama"}
	cfg := Resolve(fromFile, nil, FlagValues{})
	if cfg.DataDir != "/data/otedama" {
		t.Errorf("DataDir = %q, want /data/otedama (from config file)", cfg.DataDir)
	}
}

func TestResolve_LanguageFromEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_LANGUAGE": "zh"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.Language != "zh" {
		t.Errorf("Language = %q, want zh (from env)", cfg.Language)
	}
}

func TestResolve_DataDirFromEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_DATA_DIR": "/var/lib/otedama"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.DataDir != "/var/lib/otedama" {
		t.Errorf("DataDir = %q, want /var/lib/otedama (from env)", cfg.DataDir)
	}
}

func TestResolve_LanguageFromFlag(t *testing.T) {
	cfg := Resolve(Config{}, nil, FlagValues{Language: "ko"})
	if cfg.Language != "ko" {
		t.Errorf("Language = %q, want ko (from flag)", cfg.Language)
	}
}

func TestResolve_DataDirFromFlag(t *testing.T) {
	cfg := Resolve(Config{}, nil, FlagValues{DataDir: "/tmp/mydata"})
	if cfg.DataDir != "/tmp/mydata" {
		t.Errorf("DataDir = %q, want /tmp/mydata (from flag)", cfg.DataDir)
	}
}

func TestResolve_FlagLanguageOverridesEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_LANGUAGE": "fr"}
	cfg := Resolve(Config{}, env, FlagValues{Language: "de"})
	if cfg.Language != "de" {
		t.Errorf("Language = %q, want de (flag overrides env)", cfg.Language)
	}
}

func TestResolve_FlagDataDirOverridesEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_DATA_DIR": "/env/data"}
	cfg := Resolve(Config{}, env, FlagValues{DataDir: "/flag/data"})
	if cfg.DataDir != "/flag/data" {
		t.Errorf("DataDir = %q, want /flag/data (flag overrides env)", cfg.DataDir)
	}
}

// ============================================================================
// Validate — uncovered branches
// ============================================================================

func TestValidate_EmptyStringInBitcoinAddressesList(t *testing.T) {
	c := Defaults()
	c.BitcoinAddress = "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
	c.BitcoinAddresses = []string{""}
	err := c.Validate()
	if err == nil {
		t.Fatal("Validate() must reject an empty string in bitcoin_addresses")
	}
	if !strings.Contains(err.Error(), "bitcoin_addresses[0] is empty") {
		t.Errorf("error = %q, want mention of empty slot", err)
	}
}

func TestValidate_EmptyPoolURL(t *testing.T) {
	c := Defaults()
	c.BitcoinAddress = "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5"
	c.Pools = []PoolConfig{{URL: ""}}
	err := c.Validate()
	if err == nil {
		t.Fatal("Validate() must reject an empty pool URL")
	}
	if !strings.Contains(err.Error(), "pools[0]") {
		t.Errorf("error = %q, want mention of pools[0]", err)
	}
}

// ============================================================================
// ResolveWithOrigins — per-layer attribution
// ============================================================================

func TestResolveWithOrigins_AllDefault(t *testing.T) {
	_, o := ResolveWithOrigins(Config{}, nil, FlagValues{})
	if o.LogLevel != OriginDefault {
		t.Errorf("LogLevel origin = %v, want default", o.LogLevel)
	}
	if o.LogFormat != OriginDefault {
		t.Errorf("LogFormat origin = %v, want default", o.LogFormat)
	}
	if o.BitcoinAddress != OriginDefault {
		t.Errorf("BitcoinAddress origin = %v, want default", o.BitcoinAddress)
	}
}

func TestResolveWithOrigins_FromFile(t *testing.T) {
	fromFile := Config{
		LogLevel: "debug",
		DataDir:  "/data",
		Workers:  WorkerConfig{Name: "rig-01"},
	}
	_, o := ResolveWithOrigins(fromFile, nil, FlagValues{})
	if o.LogLevel != OriginFile {
		t.Errorf("LogLevel origin = %v, want file", o.LogLevel)
	}
	if o.DataDir != OriginFile {
		t.Errorf("DataDir origin = %v, want file", o.DataDir)
	}
	if o.WorkerName != OriginFile {
		t.Errorf("WorkerName origin = %v, want file", o.WorkerName)
	}
	// LogFormat not set in file → still default.
	if o.LogFormat != OriginDefault {
		t.Errorf("LogFormat origin = %v, want default (not in file)", o.LogFormat)
	}
}

func TestResolveWithOrigins_EnvOverridesFile(t *testing.T) {
	fromFile := Config{LogLevel: "debug"}
	env := map[string]string{"OTEDAMA_LOG_LEVEL": "warn"}
	_, o := ResolveWithOrigins(fromFile, env, FlagValues{})
	if o.LogLevel != OriginEnv {
		t.Errorf("LogLevel origin = %v, want env (env > file)", o.LogLevel)
	}
}

func TestResolveWithOrigins_FlagOverridesEnv(t *testing.T) {
	env := map[string]string{
		"OTEDAMA_BITCOIN_ADDRESS": "bc1qfromenv0000000000000000000000000000000",
		"OTEDAMA_LOG_LEVEL":       "warn",
	}
	flags := FlagValues{
		BitcoinAddress: "bc1qfromflag00000000000000000000000000000000",
	}
	_, o := ResolveWithOrigins(Config{}, env, flags)
	if o.BitcoinAddress != OriginFlag {
		t.Errorf("BitcoinAddress origin = %v, want flag (flag > env)", o.BitcoinAddress)
	}
	// LogLevel was env only, no flag.
	if o.LogLevel != OriginEnv {
		t.Errorf("LogLevel origin = %v, want env", o.LogLevel)
	}
}

func TestResolveWithOrigins_PoolsAndAddressesFromFile(t *testing.T) {
	fromFile := Config{
		BitcoinAddress:   "bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5",
		BitcoinAddresses: []string{"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"},
		Pools:            []PoolConfig{{URL: "stratum+v2://pool.example.com:3336"}},
	}
	_, o := ResolveWithOrigins(fromFile, nil, FlagValues{})
	if o.BitcoinAddress != OriginFile {
		t.Errorf("BitcoinAddress origin = %v, want file", o.BitcoinAddress)
	}
	if o.BitcoinAddresses != OriginFile {
		t.Errorf("BitcoinAddresses origin = %v, want file", o.BitcoinAddresses)
	}
	if o.Pools != OriginFile {
		t.Errorf("Pools origin = %v, want file", o.Pools)
	}
}

func TestValueOrigin_String(t *testing.T) {
	cases := map[ValueOrigin]string{
		OriginDefault: "default",
		OriginFile:    "file",
		OriginEnv:     "env",
		OriginFlag:    "flag",
	}
	for o, want := range cases {
		if got := o.String(); got != want {
			t.Errorf("ValueOrigin(%d).String() = %q, want %q", o, got, want)
		}
	}
}

func TestResolveWithOrigins_ConsistentWithResolve(t *testing.T) {
	// The Config returned by ResolveWithOrigins must equal that returned by
	// Resolve for the same inputs.
	fromFile := Config{LogLevel: "error", DataDir: "/tmp/data"}
	env := map[string]string{"OTEDAMA_LANGUAGE": "ja"}
	flags := FlagValues{BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}

	want := Resolve(fromFile, env, flags)
	got, _ := ResolveWithOrigins(fromFile, env, flags)

	if want.BitcoinAddress != got.BitcoinAddress {
		t.Errorf("BitcoinAddress mismatch: Resolve=%q ResolveWithOrigins=%q", want.BitcoinAddress, got.BitcoinAddress)
	}
	if want.LogLevel != got.LogLevel {
		t.Errorf("LogLevel mismatch: Resolve=%q ResolveWithOrigins=%q", want.LogLevel, got.LogLevel)
	}
	if want.Language != got.Language {
		t.Errorf("Language mismatch: Resolve=%q ResolveWithOrigins=%q", want.Language, got.Language)
	}
	if want.DataDir != got.DataDir {
		t.Errorf("DataDir mismatch: Resolve=%q ResolveWithOrigins=%q", want.DataDir, got.DataDir)
	}
}
