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
	"strings"
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
	// language from the operating system.
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
		BitcoinAddress: "",
		Pools:          nil, // resolved from built-in recommendations at startup
		Workers:        WorkerConfig{},
		Language:       "", // resolved from OS locale at startup
		LogLevel:       "info",
		LogFormat:      "text",
		DataDir:        "", // resolved from XDG/platform conventions at startup
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
	cfg := Defaults()

	// Layer 1: config file overrides defaults where set.
	if fromFile.BitcoinAddress != "" {
		cfg.BitcoinAddress = fromFile.BitcoinAddress
	}
	if len(fromFile.BitcoinAddresses) > 0 {
		cfg.BitcoinAddresses = fromFile.BitcoinAddresses
	}
	if len(fromFile.Pools) > 0 {
		cfg.Pools = fromFile.Pools
	}
	if fromFile.Workers.Name != "" {
		cfg.Workers.Name = fromFile.Workers.Name
	}
	if fromFile.Language != "" {
		cfg.Language = fromFile.Language
	}
	if fromFile.LogLevel != "" {
		cfg.LogLevel = fromFile.LogLevel
	}
	if fromFile.LogFormat != "" {
		cfg.LogFormat = fromFile.LogFormat
	}
	if fromFile.DataDir != "" {
		cfg.DataDir = fromFile.DataDir
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
	}
	if v := getEnv("OTEDAMA_LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
	if v := getEnv("OTEDAMA_LOG_FORMAT"); v != "" {
		cfg.LogFormat = v
	}
	if v := getEnv("OTEDAMA_LANGUAGE"); v != "" {
		cfg.Language = v
	}
	if v := getEnv("OTEDAMA_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}

	// Layer 3: flags override environment variables.
	if flags.BitcoinAddress != "" {
		cfg.BitcoinAddress = flags.BitcoinAddress
	}
	if flags.LogLevel != "" {
		cfg.LogLevel = flags.LogLevel
	}
	if flags.LogFormat != "" {
		cfg.LogFormat = flags.LogFormat
	}
	if flags.Language != "" {
		cfg.Language = flags.Language
	}
	if flags.DataDir != "" {
		cfg.DataDir = flags.DataDir
	}

	return cfg
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
		return nil
	case strings.HasPrefix(addr, "3"):
		return nil
	case strings.HasPrefix(addr, "bc1"):
		return nil
	default:
		return fmt.Errorf("address does not start with '1', '3', or 'bc1'; testnet addresses are not supported in this configuration")
	}
}

// validatePoolURL checks that a pool URL has an acceptable scheme.
func validatePoolURL(raw string) error {
	validSchemes := []string{"stratum+tcp://", "stratum+tls://", "stratum+v2://", "stratum+v2tls://"}
	for _, s := range validSchemes {
		if strings.HasPrefix(raw, s) {
			rest := raw[len(s):]
			if rest == "" {
				return fmt.Errorf("URL has no host after scheme")
			}
			return nil
		}
	}
	return fmt.Errorf("URL must start with one of: %s", strings.Join(validSchemes, ", "))
}
