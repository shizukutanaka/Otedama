// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package config provides layered configuration loading for Otedama.
//
// # Design Rationale
//
// A persistent pain point of existing mining software (CGMiner, BFGMiner)
// is that they require a complex configuration file before they can run.
// Users must understand pool URLs, worker names, failover strategies,
// difficulty settings, and dozens of other parameters just to see their
// first hash. This is the opposite of the zero-configuration experience
// we want for Otedama.
//
// This package implements a four-layer precedence model:
//
//  1. Command-line flags (highest priority)
//  2. Environment variables
//  3. YAML configuration file
//  4. Built-in defaults (lowest priority)
//
// Each layer is optional. The minimum invocation is:
//
//	otedama run --bitcoin-address bc1q...
//
// This single flag overrides one default (the Bitcoin address, which has
// no sensible default) and lets all other values fall through to
// reasonable defaults. The result: a user can start mining in under 60
// seconds without writing a single line of configuration.
//
// Advanced users can still provide a full config.yaml for detailed control.
// The layers compose transparently: a config.yaml can set everything, and
// a single flag can override one value for a test run.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/shizukutanaka/Otedama/internal/btccrypto"
)

// DefaultPoolURL is the built-in fallback Stratum V2 pool, used when the
// user has configured no pools of their own. It is the single source of
// truth for that endpoint: the engine (defaultPoolURL/poolURLs), the CLI
// startup banner, and the doctor reachability check all reference this
// constant rather than repeating the literal, so the default can never
// drift out of sync between subsystems.
const DefaultPoolURL = "stratum+v2://public.stratum.slushpool.com:3336"

// Config is the complete runtime configuration for Otedama.
//
// All fields are exported so that they can be populated from YAML and
// inspected by tests. However, the zero value of Config is not usable;
// callers must use Load or Resolve to produce a valid Config.
type Config struct {
	// BitcoinAddress is the destination address for mining rewards.
	// It has no default; the user must provide it via flag, environment
	// variable, or config file before mining can begin.
	//
	// Supported formats: P2PKH (starts with '1'), P2SH (starts with '3'),
	// and Bech32 (starts with "bc1"). The address is validated at load
	// time; malformed addresses cause Load to return an error.
	BitcoinAddress string `yaml:"bitcoin_address"`

	// BitcoinAddresses is an optional ordered list of additional payout
	// addresses used for failover. If the active address cannot be used
	// to establish a mining session (e.g. a pool rejects it), Otedama
	// rotates to the next address in this list. BitcoinAddress is always
	// tried first; these follow in order. All entries are validated like
	// BitcoinAddress. Earnings only ever go to whichever address actually
	// establishes a session, so a network outage never silently redirects
	// payouts.
	BitcoinAddresses []string `yaml:"bitcoin_addresses"`

	// Pools is the list of mining pools to connect to, in order of
	// preference. Otedama connects to the first and uses subsequent
	// entries for failover.
	//
	// If empty, Otedama uses its built-in list of recommended Stratum V2
	// pools (Braiins, DEMAND, OCEAN, Luxor). This default prioritizes
	// decentralization and non-custodial payouts.
	Pools []PoolConfig `yaml:"pools"`

	// Workers controls how Otedama names itself to pools. If empty,
	// a hostname-derived name is used automatically.
	Workers WorkerConfig `yaml:"workers"`

	// Language is the IETF BCP 47 language tag for UI messages and logs,
	// for example "en", "ja", "zh-CN". If empty, Otedama detects the
	// language from the POSIX locale environment (LC_ALL, LC_MESSAGES,
	// LANG), falling back to English.
	Language string `yaml:"language"`

	// LogLevel is one of "debug", "info", "warn", "error". If empty,
	// defaults to "info".
	LogLevel string `yaml:"log_level"`

	// LogFormat is one of "text", "json". If empty, defaults to "text".
	// "json" is recommended for production deployments where logs are
	// ingested by structured log aggregation (Loki, Elasticsearch, etc.).
	LogFormat string `yaml:"log_format"`

	// DataDir is the directory where Otedama stores persistent data
	// (Lightning wallet, known pool keys, usage statistics). If empty,
	// defaults to an OS-appropriate location:
	//   Linux:   $XDG_DATA_HOME/otedama or $HOME/.local/share/otedama
	//   macOS:   $HOME/Library/Application Support/Otedama
	//   Windows: %APPDATA%\Otedama
	DataDir string `yaml:"data_dir"`

	// ArbitrationHysteresisPct is the minimum fractional yield improvement
	// required to switch a device from its current workload (mining → AI or
	// vice versa). A value of 0.05 means a switch only happens when the new
	// workload earns at least 5% more. Higher values reduce oscillation on
	// noisy price feeds; lower values react faster to price changes.
	//
	// Valid range: [0.0, 1.0). The default 0.05 (5%) is a safe operating
	// point that prevents thrashing without meaningfully delaying profitable
	// switches. Set via OTEDAMA_ARBITRATION_HYSTERESIS_PCT or config file.
	ArbitrationHysteresisPct float64 `yaml:"arbitration_hysteresis_pct"`

	// CurtailBelowBTCUSD pauses all hashing workers when the BTC/USD rate
	// falls below this threshold. Workers resume automatically when the rate
	// recovers (on the next pool notify, up to ~60 s). This is the
	// electricity-tariff curtailment hook: set it to your break-even price
	// so Otedama stops mining when it becomes unprofitable.
	//
	// 0 disables the feature (default). Negative values are rejected by
	// Validate(). Set via OTEDAMA_CURTAIL_BELOW_BTC_USD or config file.
	CurtailBelowBTCUSD float64 `yaml:"curtail_below_btc_usd"`

	// MinYieldSatsPerSec is a per-device profitability floor in satoshis per
	// second: the arbitration engine leaves a device idle when none of its
	// compatible revenue streams clears this rate, rather than running it for a
	// trickle of revenue that does not justify the power, wear, and heat.
	//
	// It complements CurtailBelowBTCUSD: curtailment pauses *all* hashing on a
	// global BTC-price threshold, whereas this idles only the individual devices
	// whose best available workload is below the floor — useful on mixed rigs
	// where a weak device should stop while stronger ones keep earning.
	//
	// 0 disables the floor (default): every positive-yield stream qualifies.
	// Negative values are rejected by Validate(). Set via
	// OTEDAMA_MIN_YIELD_SATS_PER_SEC or config file.
	MinYieldSatsPerSec float64 `yaml:"min_yield_sats_per_sec"`

	// PowerWatts is the user's estimated total system power draw in watts.
	// When set (> 0), Otedama computes and exposes
	// `otedama_joules_per_terahash` (J/TH), the single efficiency metric
	// miners optimise for. J/TH = PowerWatts × 1e12 / HashesPerSecond.
	// Power measurement from hardware sensors is not yet available; this
	// field lets users enter their measured TDP or wall-meter reading.
	//
	// 0 disables the metric (default). Negative values are rejected.
	// Set via OTEDAMA_POWER_WATTS or config file.
	PowerWatts float64 `yaml:"power_watts"`

	// ElectricityPricePerKWh is the user's electricity price in USD per
	// kilowatt-hour. Together with PowerWatts it lets Otedama expose
	// `otedama_power_cost_usd_per_hour` (= PowerWatts/1000 × price), the cost
	// half of the profitability picture: combined with the BTC/USD rate and
	// the revenue metrics, an operator can see net profit, not just gross
	// yield or efficiency. This is the economic dimension the engine otherwise
	// lacks — "valuable" workload selection is measured in gross sats, but what
	// the operator keeps is revenue minus power cost.
	//
	// 0 disables the cost metric (default). Negative values are rejected.
	// Set via OTEDAMA_ELECTRICITY_PRICE_PER_KWH or config file.
	ElectricityPricePerKWh float64 `yaml:"electricity_price_per_kwh"`
}

// PoolConfig describes a single mining pool connection.
type PoolConfig struct {
	// URL is the stratum endpoint, for example "stratum+tcp://pool.example.com:3333"
	// or "stratum+v2://pool.example.com:34254". The scheme determines the
	// protocol version.
	URL string `yaml:"url"`

	// User is the Stratum user_identity sent when opening the mining
	// channel. If empty, Otedama uses the active payout address (suffixed
	// with the worker name as "address.worker" when Workers.Name is set);
	// if non-empty, it overrides that entirely.
	User string `yaml:"user"`

	// Password is the pool password. The Stratum V2 transport has no
	// password concept, so this field is reserved for the Stratum V1
	// fallback path (not yet wired in v3.0.0-alpha) and is currently
	// unused. Most V1 pools accept any value (often "x").
	Password string `yaml:"password"`

	// PayoutScheme is the pool's reward distribution method, used by
	// `doctor` to surface its variance/custody trade-offs. Valid values:
	// "fpps" (Full Pay Per Share — smooth payouts, pool absorbs variance),
	// "pplns" (Pay Per Last N Shares — lower fee, miner absorbs variance),
	// "tides" (Transparent Index of Distinct Extended Shares, OCEAN —
	// non-custodial coinbase payouts, best alignment with Otedama's stance),
	// "solo" (full block reward or nothing). Empty means unknown/unset.
	// This field has no effect on the mining protocol.
	PayoutScheme string `yaml:"payout_scheme"`

	// TLSCAFile is an optional path to a PEM file of certificate authorities
	// to trust for this pool's stratum+tls:// connection, in addition to the
	// system root store. Use it for a pool that presents a private-CA or
	// self-signed certificate, so the connection can be verified rather than
	// either failing or being run in the clear. Empty means "system roots
	// only". It has no effect on non-TLS schemes. Certificate verification is
	// always performed; this never disables it.
	TLSCAFile string `yaml:"tls_ca_file"`
}

// WorkerConfig controls how Otedama identifies itself to pools.
type WorkerConfig struct {
	// Name is the worker name reported to pools. If empty, the hostname
	// is used.
	Name string `yaml:"name"`
}

// Defaults returns a Config populated with Otedama's built-in defaults.
//
// The returned Config is not usable for mining on its own (BitcoinAddress
// is empty), but it provides the baseline onto which flags, environment
// variables, and config files are overlaid.
func Defaults() Config {
	return Config{
		BitcoinAddress:           "",
		Pools:                    nil, // resolved from built-in recommendations at startup
		Workers:                  WorkerConfig{},
		Language:                 "", // resolved from POSIX locale env at startup
		LogLevel:                 "info",
		LogFormat:                "text",
		DataDir:                  "", // resolved from XDG/platform conventions at startup
		ArbitrationHysteresisPct: 0.05,
		CurtailBelowBTCUSD:       0, // disabled by default
		MinYieldSatsPerSec:       0, // disabled by default
	}
}

// FlagValues collects values set via command-line flags.
//
// A FlagValues with all-empty fields means "no flags were provided";
// such a FlagValues does not override any other layer. This is the
// invariant that makes the precedence model work cleanly.
//
// Config-file loading is the caller's responsibility (before calling
// Resolve). FlagValues intentionally does not carry a config-file path
// because Resolve receives an already-decoded Config value, not a path.
type FlagValues struct {
	BitcoinAddress string
	LogLevel       string
	LogFormat      string
	Language       string
	DataDir        string
}

// ValueOrigin indicates which configuration layer provided a particular value.
type ValueOrigin uint8

const (
	OriginDefault ValueOrigin = iota // built-in default (lowest priority)
	OriginFile                       // YAML configuration file
	OriginEnv                        // environment variable
	OriginFlag                       // command-line flag (highest priority)
)

// String returns the human-readable label used in "config show --origin" output.
func (o ValueOrigin) String() string {
	switch o {
	case OriginFile:
		return "file"
	case OriginEnv:
		return "env"
	case OriginFlag:
		return "flag"
	default:
		return "default"
	}
}

// Origins records which layer provided each Config field.
// A field set to OriginDefault means no higher-priority layer overrode the
// built-in value.
type Origins struct {
	BitcoinAddress           ValueOrigin
	BitcoinAddresses         ValueOrigin
	Pools                    ValueOrigin
	WorkerName               ValueOrigin
	Language                 ValueOrigin
	LogLevel                 ValueOrigin
	LogFormat                ValueOrigin
	DataDir                  ValueOrigin
	ArbitrationHysteresisPct ValueOrigin
	CurtailBelowBTCUSD       ValueOrigin
	MinYieldSatsPerSec       ValueOrigin
	PowerWatts               ValueOrigin
	ElectricityPricePerKWh   ValueOrigin
}

// Resolve combines defaults, a config file (already loaded into fromFile),
// environment variables (read from env), and flag values into a single
// Config. Later layers override earlier ones.
//
// If env is nil, os.Getenv is used. This indirection exists so that tests
// can inject a controlled environment.
//
// Resolve does not perform validation of the resulting Config; call
// Config.Validate separately once all layers have been combined.
func Resolve(fromFile Config, env map[string]string, flags FlagValues) Config {
	cfg, _ := ResolveWithOrigins(fromFile, env, flags)
	return cfg
}

// numericEnvVars is the single source of truth for the OTEDAMA_* float
// environment variables: the key and how to apply a parsed value. Both
// ResolveWithOrigins (which applies them) and EnvWarnings (which reports
// malformed ones) iterate this slice, so the set parsed and the set validated
// can never drift apart.
var numericEnvVars = []struct {
	key   string
	apply func(cfg *Config, o *Origins, v float64)
}{
	{"OTEDAMA_ARBITRATION_HYSTERESIS_PCT", func(c *Config, o *Origins, v float64) {
		c.ArbitrationHysteresisPct = v
		o.ArbitrationHysteresisPct = OriginEnv
	}},
	{"OTEDAMA_MIN_YIELD_SATS_PER_SEC", func(c *Config, o *Origins, v float64) {
		c.MinYieldSatsPerSec = v
		o.MinYieldSatsPerSec = OriginEnv
	}},
	{"OTEDAMA_CURTAIL_BELOW_BTC_USD", func(c *Config, o *Origins, v float64) {
		c.CurtailBelowBTCUSD = v
		o.CurtailBelowBTCUSD = OriginEnv
	}},
	{"OTEDAMA_POWER_WATTS", func(c *Config, o *Origins, v float64) {
		c.PowerWatts = v
		o.PowerWatts = OriginEnv
	}},
	{"OTEDAMA_ELECTRICITY_PRICE_PER_KWH", func(c *Config, o *Origins, v float64) {
		c.ElectricityPricePerKWh = v
		o.ElectricityPricePerKWh = OriginEnv
	}},
}

// EnvWarnings returns human-readable warnings for environment variables that
// are set but cannot be applied — currently, numeric OTEDAMA_* variables whose
// value does not parse as a float. Such a variable is silently ignored during
// resolution (the prior layer's value stands), so without this an operator's
// typo (e.g. OTEDAMA_POWER_WATTS=300w, or a comma decimal "300,5") would vanish
// with no feedback. If env is nil the process environment is consulted, exactly
// as ResolveWithOrigins does. The CLI prints these to stderr before running.
func EnvWarnings(env map[string]string) []string {
	getEnv := func(key string) string {
		if env != nil {
			return env[key]
		}
		return os.Getenv(key)
	}
	var warnings []string
	for _, spec := range numericEnvVars {
		v := getEnv(spec.key)
		if v == "" {
			continue
		}
		if _, err := strconv.ParseFloat(v, 64); err != nil {
			warnings = append(warnings, fmt.Sprintf(
				"%s=%q is not a valid number; ignoring it and using the default", spec.key, v))
		}
	}
	return warnings
}

// ResolveWithOrigins is identical to Resolve but also returns an Origins
// value indicating which layer provided each Config field. This powers
// "otedama config show --origin".
func ResolveWithOrigins(fromFile Config, env map[string]string, flags FlagValues) (Config, Origins) {
	cfg := Defaults()
	var o Origins

	// Layer 1: config file overrides defaults where set.
	if fromFile.BitcoinAddress != "" {
		cfg.BitcoinAddress = fromFile.BitcoinAddress
		o.BitcoinAddress = OriginFile
	}
	if len(fromFile.BitcoinAddresses) > 0 {
		cfg.BitcoinAddresses = fromFile.BitcoinAddresses
		o.BitcoinAddresses = OriginFile
	}
	if len(fromFile.Pools) > 0 {
		cfg.Pools = fromFile.Pools
		o.Pools = OriginFile
	}
	if fromFile.Workers.Name != "" {
		cfg.Workers.Name = fromFile.Workers.Name
		o.WorkerName = OriginFile
	}
	if fromFile.Language != "" {
		cfg.Language = fromFile.Language
		o.Language = OriginFile
	}
	if fromFile.LogLevel != "" {
		cfg.LogLevel = fromFile.LogLevel
		o.LogLevel = OriginFile
	}
	if fromFile.LogFormat != "" {
		cfg.LogFormat = fromFile.LogFormat
		o.LogFormat = OriginFile
	}
	if fromFile.DataDir != "" {
		cfg.DataDir = fromFile.DataDir
		o.DataDir = OriginFile
	}
	// ArbitrationHysteresisPct: 0.0 in the file is indistinguishable from
	// "unset" at the Go level, so we treat any non-default file value as an
	// explicit override. Users who genuinely want 0.0 must use the env var.
	if fromFile.ArbitrationHysteresisPct != 0 {
		cfg.ArbitrationHysteresisPct = fromFile.ArbitrationHysteresisPct
		o.ArbitrationHysteresisPct = OriginFile
	}
	// CurtailBelowBTCUSD: same zero-value caveat; treat non-zero file value
	// as an explicit override.
	// MinYieldSatsPerSec: same zero-value caveat; treat non-zero file value as
	// an explicit override.
	if fromFile.MinYieldSatsPerSec != 0 {
		cfg.MinYieldSatsPerSec = fromFile.MinYieldSatsPerSec
		o.MinYieldSatsPerSec = OriginFile
	}
	if fromFile.CurtailBelowBTCUSD != 0 {
		cfg.CurtailBelowBTCUSD = fromFile.CurtailBelowBTCUSD
		o.CurtailBelowBTCUSD = OriginFile
	}
	if fromFile.PowerWatts != 0 {
		cfg.PowerWatts = fromFile.PowerWatts
		o.PowerWatts = OriginFile
	}
	if fromFile.ElectricityPricePerKWh != 0 {
		cfg.ElectricityPricePerKWh = fromFile.ElectricityPricePerKWh
		o.ElectricityPricePerKWh = OriginFile
	}

	// Layer 2: environment variables override config file.
	getEnv := func(key string) string {
		if env != nil {
			return env[key]
		}
		return os.Getenv(key)
	}
	if v := getEnv("OTEDAMA_BITCOIN_ADDRESS"); v != "" {
		cfg.BitcoinAddress = v
		o.BitcoinAddress = OriginEnv
	}
	if v := getEnv("OTEDAMA_LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
		o.LogLevel = OriginEnv
	}
	if v := getEnv("OTEDAMA_LOG_FORMAT"); v != "" {
		cfg.LogFormat = v
		o.LogFormat = OriginEnv
	}
	if v := getEnv("OTEDAMA_LANGUAGE"); v != "" {
		cfg.Language = v
		o.Language = OriginEnv
	}
	if v := getEnv("OTEDAMA_DATA_DIR"); v != "" {
		cfg.DataDir = v
		o.DataDir = OriginEnv
	}
	for _, spec := range numericEnvVars {
		v := getEnv(spec.key)
		if v == "" {
			continue
		}
		// A malformed value is left for EnvWarnings to surface; here it is
		// simply not applied (the default/file/earlier-layer value stands).
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			spec.apply(&cfg, &o, f)
		}
	}

	// Layer 3: flags override environment variables.
	if flags.BitcoinAddress != "" {
		cfg.BitcoinAddress = flags.BitcoinAddress
		o.BitcoinAddress = OriginFlag
	}
	if flags.LogLevel != "" {
		cfg.LogLevel = flags.LogLevel
		o.LogLevel = OriginFlag
	}
	if flags.LogFormat != "" {
		cfg.LogFormat = flags.LogFormat
		o.LogFormat = OriginFlag
	}
	if flags.Language != "" {
		cfg.Language = flags.Language
		o.Language = OriginFlag
	}
	if flags.DataDir != "" {
		cfg.DataDir = flags.DataDir
		o.DataDir = OriginFlag
	}

	return cfg, o
}

// Validate checks that the Config is self-consistent and ready for use.
//
// Validation errors are returned as a single error that may describe
// multiple problems at once, so that users can fix them in one edit
// rather than one error per run.
func (c Config) Validate() error {
	var issues []string

	if c.BitcoinAddress == "" && len(c.BitcoinAddresses) == 0 {
		issues = append(issues, "bitcoin_address is required (set via --bitcoin-address, OTEDAMA_BITCOIN_ADDRESS, or config file)")
	} else if c.BitcoinAddress != "" {
		if err := validateBitcoinAddress(c.BitcoinAddress); err != nil {
			issues = append(issues, fmt.Sprintf("bitcoin_address invalid: %v", err))
		}
	}
	// Validate every failover address too, so a typo in a backup is caught
	// at config time rather than only when failover actually reaches it.
	for i, a := range c.BitcoinAddresses {
		if a == "" {
			issues = append(issues, fmt.Sprintf("bitcoin_addresses[%d] is empty", i))
		} else if err := validateBitcoinAddress(a); err != nil {
			issues = append(issues, fmt.Sprintf("bitcoin_addresses[%d] invalid: %v", i, err))
		}
	}

	switch c.LogLevel {
	case "debug", "info", "warn", "error":
		// ok
	case "":
		// empty LogLevel is unreachable post-Resolve (defaults supply "info"),
		// but we guard anyway.
	default:
		issues = append(issues, fmt.Sprintf("log_level %q is not one of debug, info, warn, error", c.LogLevel))
	}

	switch c.LogFormat {
	case "text", "json":
		// ok
	case "":
		// empty is unreachable post-Resolve (defaults supply "text").
	default:
		issues = append(issues, fmt.Sprintf("log_format %q is not one of text, json", c.LogFormat))
	}

	for i, p := range c.Pools {
		if p.URL == "" {
			issues = append(issues, fmt.Sprintf("pools[%d].url is empty", i))
		} else if err := validatePoolURL(p.URL); err != nil {
			issues = append(issues, fmt.Sprintf("pools[%d].url invalid: %v", i, err))
		}
		switch p.PayoutScheme {
		case "", "fpps", "pplns", "tides", "solo":
			// valid
		default:
			issues = append(issues, fmt.Sprintf("pools[%d].payout_scheme %q is not one of fpps, pplns, tides, solo", i, p.PayoutScheme))
		}
	}

	if c.ArbitrationHysteresisPct < 0 || c.ArbitrationHysteresisPct >= 1.0 {
		issues = append(issues, fmt.Sprintf(
			"arbitration_hysteresis_pct %.4f is out of range [0.0, 1.0)", c.ArbitrationHysteresisPct))
	}
	if c.CurtailBelowBTCUSD < 0 {
		issues = append(issues, fmt.Sprintf(
			"curtail_below_btc_usd %.2f must be >= 0 (0 = disabled)", c.CurtailBelowBTCUSD))
	}
	if c.MinYieldSatsPerSec < 0 {
		issues = append(issues, fmt.Sprintf(
			"min_yield_sats_per_sec %.4f must be >= 0 (0 = disabled)", c.MinYieldSatsPerSec))
	}
	if c.PowerWatts < 0 {
		issues = append(issues, fmt.Sprintf(
			"power_watts %.2f must be >= 0 (0 = disabled)", c.PowerWatts))
	}
	if c.ElectricityPricePerKWh < 0 {
		issues = append(issues, fmt.Sprintf(
			"electricity_price_per_kwh %.4f must be >= 0 (0 = disabled)", c.ElectricityPricePerKWh))
	}

	if len(issues) == 0 {
		return nil
	}
	return fmt.Errorf("config validation failed:\n  - %s", strings.Join(issues, "\n  - "))
}

// validateBitcoinAddress performs a lightweight format check on a Bitcoin
// address. Full cryptographic validation (checksum verification) is
// performed by the lightning package when the address is first used;
// this function only catches obvious typos and wrong-chain addresses.
func validateBitcoinAddress(addr string) error {
	if len(addr) < 26 {
		return fmt.Errorf("address is too short (%d characters)", len(addr))
	}
	if len(addr) > 90 {
		return fmt.Errorf("address is too long (%d characters)", len(addr))
	}
	// Bitcoin mainnet addresses start with '1' (P2PKH), '3' (P2SH), or "bc1" (Bech32).
	// We reject testnet/signet addresses at this layer; test networks are
	// enabled via a separate configuration option (not yet wired in v3.0.0-alpha).
	switch {
	case strings.HasPrefix(addr, "1"):
	case strings.HasPrefix(addr, "3"):
	case strings.HasPrefix(addr, "bc1"):
	default:
		return fmt.Errorf("address does not start with '1', '3', or 'bc1'; testnet addresses are not supported in this configuration")
	}
	// Verify the address checksum (bech32/bech32m for bc1…, Base58Check for
	// 1…/3…) so a transcription error that stays inside the character set —
	// which would otherwise pass the prefix/length check and silently
	// misdirect earnings — is rejected at config load, before mining begins.
	if _, err := btccrypto.ValidateAddress(addr); err != nil {
		return fmt.Errorf("checksum verification failed (likely a typo in the address): %w", err)
	}
	return nil
}

// validatePoolURL checks that a pool URL has an acceptable scheme.
func validatePoolURL(raw string) error {
	validSchemes := []string{"stratum+tcp://", "stratum+tls://", "stratum+v2://", "stratum+v2tls://"}
	for _, s := range validSchemes {
		if rest, ok := strings.CutPrefix(raw, s); ok {
			if rest == "" {
				return fmt.Errorf("URL has no host after scheme")
			}
			return nil
		}
	}
	return fmt.Errorf("URL must start with one of: %s", strings.Join(validSchemes, ", "))
}
