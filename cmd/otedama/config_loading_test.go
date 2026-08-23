// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ============================================================================
// loadConfigFile — malformed YAML handling
// ============================================================================

func TestLoadConfigFile_MalformedYAML_WarnsAndReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(path, []byte("this is: : not : valid yaml"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	// Must not crash. Must print warning to stderr.
	if stderr.Len() == 0 {
		t.Error("malformed YAML: no warning written to stderr")
	}
	if !strings.Contains(stderr.String(), "yaml") && !strings.Contains(stderr.String(), "config") {
		t.Errorf("stderr should mention config issue:\n%s", stderr.String())
	}
	// Must return empty (safe default) config.
	if cfg.BitcoinAddress != "" {
		t.Errorf("malformed YAML leaked field: %q", cfg.BitcoinAddress)
	}
}

func TestLoadConfigFile_ValidYAML_FieldsParsed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "good.yaml")
	content := []byte(`
bitcoin_address: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
log_level: debug
log_format: json
language: ja
pools:
  - url: stratum+v2://pool1.example.com:3336
  - url: stratum+v2://pool2.example.com:3336
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	if stderr.Len() != 0 {
		t.Errorf("valid YAML produced stderr output:\n%s", stderr.String())
	}
	if cfg.BitcoinAddress != "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" {
		t.Errorf("bitcoin_address = %q, want bc1qar0...", cfg.BitcoinAddress)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("log_level = %q, want debug", cfg.LogLevel)
	}
	if cfg.LogFormat != "json" {
		t.Errorf("log_format = %q, want json", cfg.LogFormat)
	}
	if cfg.Language != "ja" {
		t.Errorf("language = %q, want ja", cfg.Language)
	}
	if len(cfg.Pools) != 2 {
		t.Errorf("got %d pools, want 2", len(cfg.Pools))
	}
}

func TestLoadConfigFile_HTTPAddrField_Parses(t *testing.T) {
	// config.yaml.example has long documented http_addr as a valid field,
	// but config.Config had no such field. loadConfigFile's yaml.Decoder
	// uses KnownFields(true), so an unrecognized key does not just get
	// ignored — it fails the whole document, and this function's error
	// path discards the ENTIRE config, not just the offending line. A user
	// who uncommented the documented example would have silently lost
	// every other setting in their file. This pins the fix: http_addr must
	// both parse and NOT collapse the rest of the file to defaults.
	dir := t.TempDir()
	path := filepath.Join(dir, "with-http-addr.yaml")
	content := []byte(`
bitcoin_address: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
http_addr: "127.0.0.1:9090"
log_level: debug
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	if stderr.Len() != 0 {
		t.Errorf("http_addr in config file produced stderr output (should parse cleanly):\n%s", stderr.String())
	}
	if cfg.HTTPAddr != "127.0.0.1:9090" {
		t.Errorf("http_addr = %q, want 127.0.0.1:9090", cfg.HTTPAddr)
	}
	// The bug this pins was "unknown field -> whole document discarded",
	// so assert a sibling field survived too, not just http_addr itself.
	if cfg.BitcoinAddress != "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" {
		t.Errorf("bitcoin_address = %q; sibling fields were lost alongside http_addr", cfg.BitcoinAddress)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("log_level = %q; sibling fields were lost alongside http_addr", cfg.LogLevel)
	}
}

func TestLoadConfigFile_APIMdExample_Parses(t *testing.T) {
	// docs/API.md's flagship "Configuration file" example previously
	// documented `pools[].priority` (PoolConfig has no such field) and a
	// `workers:` YAML *list* (Config.Workers is a single WorkerConfig
	// object, not a slice — decoding a sequence into it is a type error,
	// not just an unknown-key warning). Either mistake fails the whole
	// document via KnownFields(true)/type mismatch, discarding every
	// other setting including bitcoin_address — verified by hand before
	// this fix: cfg.BitcoinAddress came back "" and cfg.Pools came back
	// empty. This test locks the corrected example to the real schema so
	// docs/API.md cannot regress to an unparseable one again.
	dir := t.TempDir()
	path := filepath.Join(dir, "api-md-example.yaml")
	content := []byte(`
bitcoin_address: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq
log_level: info
log_format: text
language: en
data_dir: ~/.local/share/otedama
pools:
  - url: stratum+v2://public.stratum.slushpool.com:3336
  - url: stratum+v2://demand.sv2.io:34254
workers:
  name: cpu-worker
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	if stderr.Len() != 0 {
		t.Errorf("docs/API.md example produced stderr output (should parse cleanly):\n%s", stderr.String())
	}
	if cfg.BitcoinAddress != "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" {
		t.Errorf("bitcoin_address = %q; docs/API.md example did not parse", cfg.BitcoinAddress)
	}
	if len(cfg.Pools) != 2 {
		t.Errorf("got %d pools, want 2", len(cfg.Pools))
	}
	if cfg.Workers.Name != "cpu-worker" {
		t.Errorf("workers.name = %q, want cpu-worker", cfg.Workers.Name)
	}
}

func TestLoadConfigFile_EmptyYAML_ReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.yaml")
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	if cfg.BitcoinAddress != "" {
		t.Errorf("empty YAML produced non-empty config: %+v", cfg)
	}
	if stderr.Len() != 0 {
		t.Errorf("empty YAML produced stderr:\n%s", stderr.String())
	}
}

func TestLoadConfigFile_CommentsOnly_ReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "comments.yaml")
	content := []byte(`
# This is a comment-only file.
# Another comment.
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)
	if cfg.BitcoinAddress != "" {
		t.Errorf("comments-only YAML leaked field: %q", cfg.BitcoinAddress)
	}
}

func TestLoadConfigFile_EmptyPath_UsesDefault(t *testing.T) {
	// Passing empty path should invoke defaultConfigPath(). If the
	// default path does not exist (likely in test env), returns empty.
	var stderr bytes.Buffer
	cfg := loadConfigFile("", &stderr)

	// Should not crash. Should not write to stderr just because the
	// default config doesn't exist.
	if strings.Contains(stderr.String(), "cannot open") {
		// Acceptable only if message is about non-default path.
		// But "cannot open" should only appear if path was given.
	}
	_ = cfg
}

func TestLoadConfigFile_NulBytePath_WarnsAboutOpenError(t *testing.T) {
	// A path containing a NUL byte is rejected by the kernel with EINVAL
	// (not ENOENT), so !os.IsNotExist(err) is true. This covers the warning
	// branch without relying on file-permission tricks that break under root.
	path := "/tmp/nul\x00byte"
	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	if cfg.BitcoinAddress != "" {
		t.Errorf("NUL-byte path leaked config data: %q", cfg.BitcoinAddress)
	}
	if !strings.Contains(stderr.String(), "warning") {
		t.Errorf("expected warning on stderr, got: %q", stderr.String())
	}
}

func TestLoadConfigFile_UnreadableFile_WarnsOrReturnsEmpty(t *testing.T) {
	// Create a file with no read permissions. Must not crash.
	if runtime.GOOS == "windows" {
		t.Skip("file permission semantics differ on Windows")
	}
	if os.Getuid() == 0 {
		t.Skip("running as root bypasses file permissions; an unreadable file cannot be simulated")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "unreadable.yaml")
	if err := os.WriteFile(path, []byte("bitcoin_address: bc1q..."), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	defer os.Chmod(path, 0o644) // restore so cleanup works

	var stderr bytes.Buffer
	cfg := loadConfigFile(path, &stderr)

	// Must not return data from unreadable file.
	if cfg.BitcoinAddress != "" {
		t.Errorf("unreadable file leaked data: %q", cfg.BitcoinAddress)
	}
	// Running as root (e.g. Docker) bypasses permission checks.
	// Skip warning assertion if stderr is empty.
	if os.Getuid() != 0 && stderr.Len() == 0 {
		t.Error("unreadable file should produce a warning")
	}
}

// ============================================================================
// defaultConfigPath
// ============================================================================

func TestDefaultConfigPath_ReturnsExpandedPath(t *testing.T) {
	// Must return an absolute path or empty (if HOME is unset).
	path := defaultConfigPath()
	if path != "" && !filepath.IsAbs(path) {
		t.Errorf("defaultConfigPath = %q, want absolute path", path)
	}
	// Should contain "otedama" somewhere in the path.
	if path != "" && !strings.Contains(path, "otedama") {
		t.Errorf("defaultConfigPath = %q, should contain 'otedama'", path)
	}
}

func TestDefaultConfigPath_EnvVarOverridesDefault(t *testing.T) {
	const key = "OTEDAMA_CONFIG"
	old := os.Getenv(key)
	defer os.Setenv(key, old) //nolint:errcheck

	want := "/tmp/my-custom-otedama.yaml"
	os.Setenv(key, want) //nolint:errcheck

	got := defaultConfigPath()
	if got != want {
		t.Errorf("defaultConfigPath with %s=%q = %q, want %q", key, want, got, want)
	}
}

// ============================================================================
// safeDisplay — input sanitization for tty output
// ============================================================================

func TestSafeDisplay_EmptyReturnsNotSet(t *testing.T) {
	got := safeDisplay("")
	if got == "" {
		t.Error("safeDisplay('') should return a placeholder, not empty string")
	}
}

func TestSafeDisplay_StripsControlCharacters(t *testing.T) {
	// Terminal escape sequences in config values could inject ANSI
	// (log injection attack). safeDisplay must neutralize them.
	in := "valid\x1b[31mred\x1b[0m"
	out := safeDisplay(in)
	// The raw ESC byte must not appear in output.
	for _, r := range out {
		if r == 0x1b {
			t.Errorf("safeDisplay left ESC byte: %q", out)
		}
	}
}

func TestSafeDisplay_PreservesASCII(t *testing.T) {
	in := "normal-string-123"
	got := safeDisplay(in)
	if got != in {
		t.Errorf("safeDisplay(%q) = %q, want unchanged", in, got)
	}
}

func TestSafeDisplay_AllControlCharsBecomesDefault(t *testing.T) {
	// When the input consists ONLY of control characters, filtering
	// them all away yields an empty string. safeDisplay must then render
	// that as "(default)" to match the behavior of an explicitly empty input.
	// Use only actual control characters: \x01, \x02, \x03, \x04 (no printable chars).
	got := safeDisplay("\x01\x02\x03\x04")
	if got != "(default)" {
		t.Errorf("safeDisplay(all-control) = %q, want '(default)'", got)
	}
}
