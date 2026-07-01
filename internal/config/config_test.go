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

func TestValidate_RejectsChecksumTypo(t *testing.T) {
	// In-charset single-character typos that pass the prefix/length check but
	// fail the address checksum must be rejected at config load — before any
	// mining directs earnings at the wrong address. (Sessions 118/119 added
	// the verifier; this wires it into Validate.)
	tests := []struct {
		name string
		addr string
	}{
		{"bech32 typo", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr"}, // last q->r
		{"base58 typo", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"},         // last a->b
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			c := Defaults()
			c.BitcoinAddress = tt.addr
			err := c.Validate()
			if err == nil {
				t.Fatalf("Validate() accepted checksum-invalid address %q", tt.addr)
			}
			if !strings.Contains(err.Error(), "checksum") {
				t.Errorf("error should mention checksum: %v", err)
			}
		})
	}
}

func TestValidate_RejectsChecksumTypoInFailoverList(t *testing.T) {
	c := Defaults()
	c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"             // valid primary
	c.BitcoinAddresses = []string{"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr"} // typo backup
	if err := c.Validate(); err == nil {
		t.Error("Validate() accepted a checksum-invalid failover address")
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

func TestValidate_PayoutScheme(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
		c.Pools = []PoolConfig{{URL: "stratum+tcp://pool.example.com:3333"}}
		return c
	}
	valid := []string{"", "fpps", "pplns", "tides", "solo"}
	for _, s := range valid {
		t.Run("valid_"+s, func(t *testing.T) {
			c := base()
			c.Pools[0].PayoutScheme = s
			if err := c.Validate(); err != nil {
				t.Errorf("payout_scheme %q should be valid; got %v", s, err)
			}
		})
	}
	t.Run("invalid_scheme", func(t *testing.T) {
		c := base()
		c.Pools[0].PayoutScheme = "pow"
		err := c.Validate()
		if err == nil {
			t.Error("unknown payout_scheme should fail Validate()")
		}
		if !strings.Contains(err.Error(), "payout_scheme") {
			t.Errorf("error should mention payout_scheme: %v", err)
		}
	})
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

func TestValidate_CurtailBelowBTCUSD(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
		return c
	}
	// 0 (disabled) and positive values are valid.
	for _, v := range []float64{0, 1, 50000, 100000} {
		c := base()
		c.CurtailBelowBTCUSD = v
		if err := c.Validate(); err != nil {
			t.Errorf("CurtailBelowBTCUSD=%.0f should be valid; got %v", v, err)
		}
	}
	// Negative values are rejected.
	c := base()
	c.CurtailBelowBTCUSD = -1
	err := c.Validate()
	if err == nil {
		t.Error("negative CurtailBelowBTCUSD should fail Validate()")
	}
	if !strings.Contains(err.Error(), "curtail_below_btc_usd") {
		t.Errorf("error should mention curtail_below_btc_usd: %v", err)
	}
}

func TestResolve_CurtailBelowBTCUSD_EnvOverride(t *testing.T) {
	env := map[string]string{"OTEDAMA_CURTAIL_BELOW_BTC_USD": "50000"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.CurtailBelowBTCUSD != 50000 {
		t.Errorf("CurtailBelowBTCUSD = %g, want 50000", cfg.CurtailBelowBTCUSD)
	}
}

func TestResolve_CurtailBelowBTCUSD_InvalidEnvIgnored(t *testing.T) {
	env := map[string]string{"OTEDAMA_CURTAIL_BELOW_BTC_USD": "not-a-number"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.CurtailBelowBTCUSD != 0 {
		t.Errorf("invalid env should leave default 0; got %g", cfg.CurtailBelowBTCUSD)
	}
}

func TestValidate_MinYieldSatsPerSec(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
		return c
	}
	for _, v := range []float64{0, 0.5, 10, 1000} {
		c := base()
		c.MinYieldSatsPerSec = v
		if err := c.Validate(); err != nil {
			t.Errorf("MinYieldSatsPerSec=%g should be valid; got %v", v, err)
		}
	}
	c := base()
	c.MinYieldSatsPerSec = -1
	err := c.Validate()
	if err == nil {
		t.Error("negative MinYieldSatsPerSec should fail Validate()")
	}
	if err != nil && !strings.Contains(err.Error(), "min_yield_sats_per_sec") {
		t.Errorf("error should mention min_yield_sats_per_sec: %v", err)
	}
}

func TestResolve_MinYieldSatsPerSec_EnvOverride(t *testing.T) {
	env := map[string]string{"OTEDAMA_MIN_YIELD_SATS_PER_SEC": "12.5"}
	cfg, o := ResolveWithOrigins(Config{}, env, FlagValues{})
	if cfg.MinYieldSatsPerSec != 12.5 {
		t.Errorf("MinYieldSatsPerSec = %g, want 12.5", cfg.MinYieldSatsPerSec)
	}
	if o.MinYieldSatsPerSec != OriginEnv {
		t.Errorf("origin = %v, want env", o.MinYieldSatsPerSec)
	}
}

func TestResolve_MinYieldSatsPerSec_FileOverride(t *testing.T) {
	fromFile := Config{MinYieldSatsPerSec: 7}
	cfg, o := ResolveWithOrigins(fromFile, nil, FlagValues{})
	if cfg.MinYieldSatsPerSec != 7 {
		t.Errorf("MinYieldSatsPerSec = %g, want 7 (from file)", cfg.MinYieldSatsPerSec)
	}
	if o.MinYieldSatsPerSec != OriginFile {
		t.Errorf("origin = %v, want file", o.MinYieldSatsPerSec)
	}
}

func TestEnvWarnings_FlagsMalformedNumericVars(t *testing.T) {
	env := map[string]string{
		"OTEDAMA_POWER_WATTS":               "300w",   // unit suffix typo
		"OTEDAMA_CURTAIL_BELOW_BTC_USD":     "50,000", // comma decimal
		"OTEDAMA_ELECTRICITY_PRICE_PER_KWH": "0.12",   // valid → no warning
	}
	warns := EnvWarnings(env)
	if len(warns) != 2 {
		t.Fatalf("EnvWarnings = %d warnings %v, want 2", len(warns), warns)
	}
	joined := strings.Join(warns, "\n")
	if !strings.Contains(joined, "OTEDAMA_POWER_WATTS") {
		t.Errorf("warnings missing OTEDAMA_POWER_WATTS: %v", warns)
	}
	if !strings.Contains(joined, "OTEDAMA_CURTAIL_BELOW_BTC_USD") {
		t.Errorf("warnings missing OTEDAMA_CURTAIL_BELOW_BTC_USD: %v", warns)
	}
	if strings.Contains(joined, "OTEDAMA_ELECTRICITY_PRICE_PER_KWH") {
		t.Errorf("valid var should not warn: %v", warns)
	}
}

func TestEnvWarnings_NoneWhenAllValidOrUnset(t *testing.T) {
	if w := EnvWarnings(map[string]string{}); len(w) != 0 {
		t.Errorf("empty env should yield no warnings; got %v", w)
	}
	valid := map[string]string{
		"OTEDAMA_POWER_WATTS":                "300",
		"OTEDAMA_ARBITRATION_HYSTERESIS_PCT": "0.05",
	}
	if w := EnvWarnings(valid); len(w) != 0 {
		t.Errorf("valid env should yield no warnings; got %v", w)
	}
}

func TestEnvWarnings_DoesNotFlagNonNumericVars(t *testing.T) {
	// Non-numeric vars (address, log level) are never parsed as floats and
	// must not be reported by EnvWarnings regardless of content.
	env := map[string]string{
		"OTEDAMA_BITCOIN_ADDRESS": "definitely-not-a-number",
		"OTEDAMA_LOG_LEVEL":       "verbose",
	}
	if w := EnvWarnings(env); len(w) != 0 {
		t.Errorf("non-numeric vars must not be flagged; got %v", w)
	}
}

func TestValidate_PowerWatts(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
		return c
	}
	for _, v := range []float64{0, 100, 1200, 3000} {
		c := base()
		c.PowerWatts = v
		if err := c.Validate(); err != nil {
			t.Errorf("PowerWatts=%.0f should be valid; got %v", v, err)
		}
	}
	c := base()
	c.PowerWatts = -1
	err := c.Validate()
	if err == nil {
		t.Error("negative PowerWatts should fail Validate()")
	}
	if !strings.Contains(err.Error(), "power_watts") {
		t.Errorf("error should mention power_watts: %v", err)
	}
}

func TestResolve_PowerWatts_EnvOverride(t *testing.T) {
	env := map[string]string{"OTEDAMA_POWER_WATTS": "1200"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.PowerWatts != 1200 {
		t.Errorf("PowerWatts = %g, want 1200", cfg.PowerWatts)
	}
}

func TestResolve_PowerWatts_InvalidEnvIgnored(t *testing.T) {
	env := map[string]string{"OTEDAMA_POWER_WATTS": "not-a-number"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.PowerWatts != 0 {
		t.Errorf("invalid env should leave default 0; got %g", cfg.PowerWatts)
	}
}

func TestValidate_ElectricityPricePerKWh(t *testing.T) {
	base := func() Config {
		c := Defaults()
		c.BitcoinAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
		return c
	}
	for _, v := range []float64{0, 0.08, 0.42, 1.5} {
		c := base()
		c.ElectricityPricePerKWh = v
		if err := c.Validate(); err != nil {
			t.Errorf("ElectricityPricePerKWh=%g should be valid; got %v", v, err)
		}
	}
	c := base()
	c.ElectricityPricePerKWh = -0.1
	err := c.Validate()
	if err == nil {
		t.Error("negative ElectricityPricePerKWh should fail Validate()")
	}
	if !strings.Contains(err.Error(), "electricity_price_per_kwh") {
		t.Errorf("error should mention electricity_price_per_kwh: %v", err)
	}
}

func TestResolve_ElectricityPricePerKWh_EnvOverride(t *testing.T) {
	env := map[string]string{"OTEDAMA_ELECTRICITY_PRICE_PER_KWH": "0.12"}
	cfg, origins := ResolveWithOrigins(Config{}, env, FlagValues{})
	if cfg.ElectricityPricePerKWh != 0.12 {
		t.Errorf("ElectricityPricePerKWh = %g, want 0.12", cfg.ElectricityPricePerKWh)
	}
	if origins.ElectricityPricePerKWh != OriginEnv {
		t.Errorf("origin = %v, want OriginEnv", origins.ElectricityPricePerKWh)
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

// ----- HTTPAddr -----
//
// http_addr was documented in config.yaml.example and docs/API.md as a
// valid config-file field and OTEDAMA_HTTP_ADDR env var, but had no backing
// Config field at all: loadConfigFile's yaml.Decoder uses KnownFields(true),
// so a user who uncommented the documented "http_addr: ..." example would
// get the ENTIRE config file silently discarded (an unknown-field decode
// error), not just that one line ignored. These tests pin the fix across
// all three layers plus the flag>env precedence rule.

func TestResolve_HTTPAddrFromFile(t *testing.T) {
	fromFile := Config{HTTPAddr: "127.0.0.1:9090"}
	cfg := Resolve(fromFile, nil, FlagValues{})
	if cfg.HTTPAddr != "127.0.0.1:9090" {
		t.Errorf("HTTPAddr = %q, want 127.0.0.1:9090 (from config file)", cfg.HTTPAddr)
	}
}

func TestResolve_HTTPAddrFromEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_HTTP_ADDR": "0.0.0.0:8080"}
	cfg := Resolve(Config{}, env, FlagValues{})
	if cfg.HTTPAddr != "0.0.0.0:8080" {
		t.Errorf("HTTPAddr = %q, want 0.0.0.0:8080 (from env)", cfg.HTTPAddr)
	}
}

func TestResolve_HTTPAddrFromFlag(t *testing.T) {
	cfg := Resolve(Config{}, nil, FlagValues{HTTPAddr: "127.0.0.1:9999"})
	if cfg.HTTPAddr != "127.0.0.1:9999" {
		t.Errorf("HTTPAddr = %q, want 127.0.0.1:9999 (from flag)", cfg.HTTPAddr)
	}
}

func TestResolve_FlagHTTPAddrOverridesEnv(t *testing.T) {
	env := map[string]string{"OTEDAMA_HTTP_ADDR": "0.0.0.0:8080"}
	cfg := Resolve(Config{}, env, FlagValues{HTTPAddr: "127.0.0.1:9999"})
	if cfg.HTTPAddr != "127.0.0.1:9999" {
		t.Errorf("HTTPAddr = %q, want 127.0.0.1:9999 (flag overrides env)", cfg.HTTPAddr)
	}
}

func TestResolve_HTTPAddrDefaultsToEmpty(t *testing.T) {
	cfg := Resolve(Config{}, nil, FlagValues{})
	if cfg.HTTPAddr != "" {
		t.Errorf("HTTPAddr = %q, want empty (HTTP server disabled by default)", cfg.HTTPAddr)
	}
}

func TestResolveWithOrigins_HTTPAddrOriginTracksLayer(t *testing.T) {
	_, o := ResolveWithOrigins(Config{}, nil, FlagValues{})
	if o.HTTPAddr != OriginDefault {
		t.Errorf("HTTPAddr origin = %v, want default", o.HTTPAddr)
	}
	_, o = ResolveWithOrigins(Config{HTTPAddr: "127.0.0.1:9090"}, nil, FlagValues{})
	if o.HTTPAddr != OriginFile {
		t.Errorf("HTTPAddr origin = %v, want file", o.HTTPAddr)
	}
	_, o = ResolveWithOrigins(Config{}, map[string]string{"OTEDAMA_HTTP_ADDR": "0.0.0.0:8080"}, FlagValues{})
	if o.HTTPAddr != OriginEnv {
		t.Errorf("HTTPAddr origin = %v, want env", o.HTTPAddr)
	}
	_, o = ResolveWithOrigins(Config{}, nil, FlagValues{HTTPAddr: "127.0.0.1:9999"})
	if o.HTTPAddr != OriginFlag {
		t.Errorf("HTTPAddr origin = %v, want flag", o.HTTPAddr)
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

// ============================================================================
// ArbitrationHysteresisPct
// ============================================================================

func TestArbitrationHysteresisPct_DefaultIs5Pct(t *testing.T) {
	cfg := Defaults()
	if cfg.ArbitrationHysteresisPct != 0.05 {
		t.Errorf("default ArbitrationHysteresisPct = %v, want 0.05", cfg.ArbitrationHysteresisPct)
	}
}

func TestArbitrationHysteresisPct_ResolvePreservesDefault(t *testing.T) {
	cfg := Resolve(Config{}, nil, FlagValues{})
	if cfg.ArbitrationHysteresisPct != 0.05 {
		t.Errorf("resolved ArbitrationHysteresisPct = %v, want 0.05", cfg.ArbitrationHysteresisPct)
	}
}

func TestArbitrationHysteresisPct_EnvOverride(t *testing.T) {
	env := map[string]string{"OTEDAMA_ARBITRATION_HYSTERESIS_PCT": "0.10"}
	cfg, o := ResolveWithOrigins(Config{}, env, FlagValues{})
	if cfg.ArbitrationHysteresisPct != 0.10 {
		t.Errorf("ArbitrationHysteresisPct = %v, want 0.10", cfg.ArbitrationHysteresisPct)
	}
	if o.ArbitrationHysteresisPct != OriginEnv {
		t.Errorf("origin = %v, want env", o.ArbitrationHysteresisPct)
	}
}

func TestArbitrationHysteresisPct_InvalidEnvIgnored(t *testing.T) {
	// A non-numeric env value must be silently ignored, leaving the default.
	env := map[string]string{"OTEDAMA_ARBITRATION_HYSTERESIS_PCT": "not_a_number"}
	cfg, o := ResolveWithOrigins(Config{}, env, FlagValues{})
	if cfg.ArbitrationHysteresisPct != 0.05 {
		t.Errorf("invalid env: ArbitrationHysteresisPct = %v, want 0.05 (default)", cfg.ArbitrationHysteresisPct)
	}
	if o.ArbitrationHysteresisPct != OriginDefault {
		t.Errorf("invalid env: origin = %v, want default", o.ArbitrationHysteresisPct)
	}
}

func TestArbitrationHysteresisPct_FileOverride(t *testing.T) {
	fromFile := Config{ArbitrationHysteresisPct: 0.15}
	cfg, o := ResolveWithOrigins(fromFile, nil, FlagValues{})
	if cfg.ArbitrationHysteresisPct != 0.15 {
		t.Errorf("from file: ArbitrationHysteresisPct = %v, want 0.15", cfg.ArbitrationHysteresisPct)
	}
	if o.ArbitrationHysteresisPct != OriginFile {
		t.Errorf("from file: origin = %v, want file", o.ArbitrationHysteresisPct)
	}
}

func TestArbitrationHysteresisPct_EnvOverridesFile(t *testing.T) {
	fromFile := Config{ArbitrationHysteresisPct: 0.15}
	env := map[string]string{"OTEDAMA_ARBITRATION_HYSTERESIS_PCT": "0.20"}
	cfg, o := ResolveWithOrigins(fromFile, env, FlagValues{})
	if cfg.ArbitrationHysteresisPct != 0.20 {
		t.Errorf("env > file: ArbitrationHysteresisPct = %v, want 0.20", cfg.ArbitrationHysteresisPct)
	}
	if o.ArbitrationHysteresisPct != OriginEnv {
		t.Errorf("env > file: origin = %v, want env", o.ArbitrationHysteresisPct)
	}
}

func TestValidate_ArbitrationHysteresisPct_OutOfRange(t *testing.T) {
	cases := []struct {
		name string
		val  float64
	}{
		{"negative", -0.01},
		{"exactly 1.0", 1.0},
		{"above 1.0", 1.5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Config{
				BitcoinAddress:           "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
				LogLevel:                 "info",
				LogFormat:                "text",
				ArbitrationHysteresisPct: tc.val,
			}
			if err := cfg.Validate(); err == nil {
				t.Errorf("Validate(%v) = nil, want error for out-of-range ArbitrationHysteresisPct", tc.val)
			}
		})
	}
}

func TestValidate_ArbitrationHysteresisPct_ValidRange(t *testing.T) {
	cases := []float64{0.0, 0.01, 0.05, 0.10, 0.50, 0.99}
	for _, v := range cases {
		cfg := Config{
			BitcoinAddress:           "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
			LogLevel:                 "info",
			LogFormat:                "text",
			ArbitrationHysteresisPct: v,
		}
		if err := cfg.Validate(); err != nil {
			t.Errorf("Validate(%v) = %v, want nil for valid ArbitrationHysteresisPct", v, err)
		}
	}
}

// ============================================================================
// session 170 — config.go:335, config.go:457-460
// ============================================================================

// TestEnvWarnings_NilEnvUsesProcessEnv covers config.go:335 —
// when env is nil, EnvWarnings uses os.Getenv instead of the map.
// The test just verifies the call doesn't panic; the actual warnings depend on
// the process environment which is opaque to the test.
func TestEnvWarnings_NilEnvUsesProcessEnv(t *testing.T) {
	warns := EnvWarnings(nil)
	_ = warns // result depends on process env; we only verify no panic
}

// TestResolveWithOrigins_FlagLogLevelOrigin covers config.go:457-460 —
// when flags.LogLevel is non-empty it overrides env and is attributed OriginFlag.
func TestResolveWithOrigins_FlagLogLevelOrigin(t *testing.T) {
	env := map[string]string{"OTEDAMA_LOG_LEVEL": "warn"}
	flags := FlagValues{LogLevel: "debug"}
	cfg, o := ResolveWithOrigins(Config{}, env, flags)
	if cfg.LogLevel != "debug" {
		t.Errorf("LogLevel = %q, want debug (flag overrides env)", cfg.LogLevel)
	}
	if o.LogLevel != OriginFlag {
		t.Errorf("LogLevel origin = %v, want OriginFlag", o.LogLevel)
	}
}

// TestResolveWithOrigins_NumericFileFields covers the four numeric file-layer
// override blocks (ArbitrationHysteresisPct, CurtailBelowBTCUSD, PowerWatts,
// ElectricityPricePerKWh) that are skipped when the file value is zero.
// This is the only layer where zero is ambiguous ("unset" vs "explicitly zero"),
// so the four numeric fields are special-cased with != 0 guards in Layer 1.
func TestResolveWithOrigins_NumericFileFields(t *testing.T) {
	fromFile := Config{
		ArbitrationHysteresisPct: 0.07,
		CurtailBelowBTCUSD:       80000,
		PowerWatts:               150.0,
		ElectricityPricePerKWh:   0.12,
	}
	got, o := ResolveWithOrigins(fromFile, nil, FlagValues{})

	if got.ArbitrationHysteresisPct != 0.07 {
		t.Errorf("ArbitrationHysteresisPct = %v, want 0.07", got.ArbitrationHysteresisPct)
	}
	if o.ArbitrationHysteresisPct != OriginFile {
		t.Errorf("ArbitrationHysteresisPct origin = %v, want file", o.ArbitrationHysteresisPct)
	}
	if got.CurtailBelowBTCUSD != 80000 {
		t.Errorf("CurtailBelowBTCUSD = %v, want 80000", got.CurtailBelowBTCUSD)
	}
	if o.CurtailBelowBTCUSD != OriginFile {
		t.Errorf("CurtailBelowBTCUSD origin = %v, want file", o.CurtailBelowBTCUSD)
	}
	if got.PowerWatts != 150.0 {
		t.Errorf("PowerWatts = %v, want 150", got.PowerWatts)
	}
	if o.PowerWatts != OriginFile {
		t.Errorf("PowerWatts origin = %v, want file", o.PowerWatts)
	}
	if got.ElectricityPricePerKWh != 0.12 {
		t.Errorf("ElectricityPricePerKWh = %v, want 0.12", got.ElectricityPricePerKWh)
	}
	if o.ElectricityPricePerKWh != OriginFile {
		t.Errorf("ElectricityPricePerKWh origin = %v, want file", o.ElectricityPricePerKWh)
	}
}
