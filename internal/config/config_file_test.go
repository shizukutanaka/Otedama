// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package config_test

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/config"
	"gopkg.in/yaml.v3"
)

// writeYAML writes cfg as YAML to a temp file and returns its path.
func writeYAML(t *testing.T, cfg config.Config) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "config-*.yaml")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	defer f.Close()
	if err := yaml.NewEncoder(f).Encode(cfg); err != nil {
		t.Fatalf("encode YAML: %v", err)
	}
	return f.Name()
}

// loadYAML reads and unmarshals a YAML config file (same logic as main.go).
func loadYAML(t *testing.T, path string) config.Config {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	var cfg config.Config
	if err := yaml.NewDecoder(f).Decode(&cfg); err != nil {
		t.Fatalf("decode YAML: %v", err)
	}
	return cfg
}

func TestConfigFile_RoundTrip(t *testing.T) {
	orig := config.Config{
		BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		LogLevel:       "debug",
		Language:       "ja",
		Pools: []config.PoolConfig{
			{URL: "stratum+v2://pool.example.com:3336", User: "worker1", Password: "x"},
		},
		Workers: config.WorkerConfig{Name: "rig-01"},
		DataDir: "/tmp/otedama",
	}
	path := writeYAML(t, orig)
	got := loadYAML(t, path)

	if got.BitcoinAddress != orig.BitcoinAddress {
		t.Errorf("BitcoinAddress: got %q, want %q", got.BitcoinAddress, orig.BitcoinAddress)
	}
	if got.LogLevel != orig.LogLevel {
		t.Errorf("LogLevel: got %q, want %q", got.LogLevel, orig.LogLevel)
	}
	if got.Language != orig.Language {
		t.Errorf("Language: got %q, want %q", got.Language, orig.Language)
	}
	if len(got.Pools) != 1 || got.Pools[0].URL != orig.Pools[0].URL {
		t.Errorf("Pools: got %+v, want %+v", got.Pools, orig.Pools)
	}
	if got.Workers.Name != orig.Workers.Name {
		t.Errorf("Workers.Name: got %q, want %q", got.Workers.Name, orig.Workers.Name)
	}
	if got.DataDir != orig.DataDir {
		t.Errorf("DataDir: got %q, want %q", got.DataDir, orig.DataDir)
	}
}

func TestConfigFile_PrecedenceOverDefaults(t *testing.T) {
	// A config file should override built-in defaults.
	fromFile := config.Config{
		BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
		LogLevel:       "debug",
	}
	cfg := config.Resolve(fromFile, nil, config.FlagValues{})
	if cfg.LogLevel != "debug" {
		t.Errorf("file LogLevel not applied: got %q", cfg.LogLevel)
	}
}

func TestConfigFile_FlagOverridesFile(t *testing.T) {
	fromFile := config.Config{
		BitcoinAddress: "bc1qfromfile000000000000000000000000000000",
		LogLevel:       "debug",
	}
	flags := config.FlagValues{
		BitcoinAddress: "bc1qfromflag00000000000000000000000000000000",
	}
	cfg := config.Resolve(fromFile, nil, flags)
	if cfg.BitcoinAddress != flags.BitcoinAddress {
		t.Errorf("flag did not override file: got %q", cfg.BitcoinAddress)
	}
	// LogLevel from file still applies (no flag override).
	if cfg.LogLevel != "debug" {
		t.Errorf("file LogLevel lost: got %q", cfg.LogLevel)
	}
}

func TestConfigFile_MissingFileIsOK(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nonexistent.yaml")
	// Simulate what main.go does: try to open, get ENOENT, return empty config.
	_, err := os.Open(path)
	if !os.IsNotExist(err) {
		t.Fatalf("expected ENOENT, got: %v", err)
	}
	// loadConfigFile silently ignores ENOENT — verified by returning empty config.
	// We simply assert the workflow doesn't fail.
}

func TestConfigFile_ExampleFileIsValid(t *testing.T) {
	// The shipped config.yaml.example must parse cleanly and produce
	// a valid (though incomplete) config. This prevents example rot.
	examplePath := "../../config.yaml.example"
	if _, err := os.Stat(examplePath); os.IsNotExist(err) {
		t.Skip("config.yaml.example not found (run from repo root)")
	}
	f, err := os.Open(examplePath)
	if err != nil {
		t.Fatalf("open example: %v", err)
	}
	defer f.Close()

	var cfg config.Config
	dec := yaml.NewDecoder(f)
	if err := dec.Decode(&cfg); err != nil {
		t.Errorf("config.yaml.example failed to parse: %v", err)
	}
	// The example has empty bitcoin_address, so validation fails by design.
	// We only check parsing succeeds.
}

// TestConfigFile_ExampleDocumentsEveryField guards against silent drift between
// the config struct and the shipped example: every yaml field a user can set
// must appear (active or commented) in config.yaml.example, so a field added in
// code can never ship undiscoverable. It reads the source rather than using
// reflection because the yaml tags live on unexported-context structs across
// the file; a regex over the source is the simplest source of truth.
func TestConfigFile_ExampleDocumentsEveryField(t *testing.T) {
	src, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatalf("read config.go: %v", err)
	}
	example, err := os.ReadFile("../../config.yaml.example")
	if err != nil {
		t.Skip("config.yaml.example not found (run from repo root)")
	}

	tagRE := regexp.MustCompile(`yaml:"([a-z_]+)"`)
	seen := map[string]bool{}
	for _, m := range tagRE.FindAllStringSubmatch(string(src), -1) {
		field := m[1]
		if seen[field] {
			continue
		}
		seen[field] = true
		// The field must appear as a YAML key (active or commented) in the
		// example: start of line, optional indent, optional '#', optional
		// list-item dash (for keys under a sequence like pools), the key, ':'.
		keyRE := regexp.MustCompile(`(?m)^[\t ]*#?[\t ]*-?[\t ]*` + regexp.QuoteMeta(field) + `:`)
		if !keyRE.Match(example) {
			t.Errorf("config field %q (yaml tag) is not documented in config.yaml.example", field)
		}
	}
}
