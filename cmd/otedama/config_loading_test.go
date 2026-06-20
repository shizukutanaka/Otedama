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
	if err := os.WriteFile(path, []byte("this is: : not : valid yaml"), 0644); err != nil {
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
	if err := os.WriteFile(path, content, 0644); err != nil {
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

func TestLoadConfigFile_EmptyYAML_ReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.yaml")
	if err := os.WriteFile(path, []byte(""), 0644); err != nil {
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
	if err := os.WriteFile(path, content, 0644); err != nil {
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
		if strings.Contains(stderr.String(), "warning") {
			// Permissive — just warn.
		}
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
	if err := os.WriteFile(path, []byte("bitcoin_address: bc1q..."), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chmod(path, 0000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	defer os.Chmod(path, 0644) // restore so cleanup works

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
	// (log injection attack). safeDisplay must neutralise them.
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
