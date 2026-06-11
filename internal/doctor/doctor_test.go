// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package doctor

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/shizukutanaka/Otedama/internal/config"
)

// ----- isLikelyBitcoinAddress -----

func TestIsLikelyBitcoinAddress(t *testing.T) {
	tests := []struct {
		addr string
		want bool
	}{
		// Valid-looking addresses.
		{"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", true},
		{"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", true}, // Satoshi's address
		{"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", true},
		// Invalid.
		{"", false},
		{"too-short", false},
		{"totally-invalid-format-not-base58-or-bech32", false},
		{"bc1BADCAPS", false}, // uppercase in Bech32
		// Base58 with forbidden chars.
		{"1BoatSLRHtKNngkdXEeobR76b53LETtpyT", true},
	}
	for _, tt := range tests {
		if got := isLikelyBitcoinAddress(tt.addr); got != tt.want {
			t.Errorf("isLikelyBitcoinAddress(%q) = %v, want %v", tt.addr, got, tt.want)
		}
	}
}

// ----- maskAddress -----

func TestMaskAddress(t *testing.T) {
	in := "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	out := maskAddress(in)
	if !strings.HasPrefix(out, "bc1qar") {
		t.Errorf("prefix lost: %q", out)
	}
	if !strings.HasSuffix(out, "5mdq") {
		t.Errorf("suffix lost: %q", out)
	}
}

func TestMaskAddress_ShortInput(t *testing.T) {
	// Short addresses are returned as-is.
	if got := maskAddress("abc"); got != "abc" {
		t.Errorf("short address changed: %q", got)
	}
}

// ----- stripScheme -----

func TestStripScheme(t *testing.T) {
	tests := []struct {
		url, want string
	}{
		{"stratum+v2://pool.example.com:3336", "pool.example.com:3336"},
		{"stratum+v2tls://secure.example.com:34254", "secure.example.com:34254"},
		{"stratum+tcp://old.example.com:3333", "old.example.com:3333"},
		{"https://web.example.com", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := stripScheme(tt.url); got != tt.want {
			t.Errorf("stripScheme(%q) = %q, want %q", tt.url, got, tt.want)
		}
	}
}

// ----- Individual checks -----

func TestCheckBitcoinAddress_Missing(t *testing.T) {
	c := checkBitcoinAddress("")
	r := c.Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("empty address status = %v, want Fail", r.Status)
	}
	if r.Fix == "" {
		t.Error("no fix provided for missing address")
	}
}

func TestCheckBitcoinAddress_Valid(t *testing.T) {
	c := checkBitcoinAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("valid address status = %v, want Pass", r.Status)
	}
}

func TestCheckBitcoinAddress_Invalid(t *testing.T) {
	c := checkBitcoinAddress("not-an-address")
	r := c.Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("invalid address status = %v, want Fail", r.Status)
	}
}

func TestCheckBitcoinAddress_SurfacesType(t *testing.T) {
	// The PASS detail must name the detected address type so the operator
	// can confirm doctor understood it — including bech32m Taproot (bc1p).
	cases := map[string]string{
		"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq":                     "P2WPKH",
		"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr": "P2TR",
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa":                             "P2PKH",
	}
	for addr, wantType := range cases {
		r := checkBitcoinAddress(addr).Run(context.Background())
		if r.Status != StatusPass {
			t.Errorf("%s: status = %v, want Pass", addr, r.Status)
			continue
		}
		if !strings.Contains(r.Detail, wantType) {
			t.Errorf("%s: detail = %q, want to contain %q", addr, r.Detail, wantType)
		}
	}
}

func TestCheckDataDir_CreatesOnFirstRun(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "will-be-created")
	c := checkDataDir(dir)
	r := c.Run(context.Background())
	// Non-existent dir is a warning (will be auto-created later).
	if r.Status != StatusWarn {
		t.Errorf("missing dir status = %v, want Warn", r.Status)
	}
}

func TestCheckDataDir_Existing(t *testing.T) {
	dir := t.TempDir()
	// Make it properly restrictive.
	if runtime.GOOS != "windows" {
		_ = os.Chmod(dir, 0700)
	}
	c := checkDataDir(dir)
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("existing dir status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

func TestCheckDataDir_LaxPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions not applicable on Windows")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0755); err != nil {
		t.Skip("cannot chmod in test environment")
	}
	c := checkDataDir(dir)
	r := c.Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("lax-permission dir status = %v, want Warn (detail: %s)", r.Status, r.Detail)
	}
}

func TestCheckHardware_AlwaysReturnsResult(t *testing.T) {
	c := checkHardware()
	r := c.Run(context.Background())
	if r.Status != StatusPass && r.Status != StatusWarn {
		t.Errorf("hardware check status = %v, want Pass or Warn", r.Status)
	}
	if r.Detail == "" {
		t.Error("hardware check detail is empty")
	}
	// Must mention CPU count.
	if !strings.Contains(r.Detail, "core") {
		t.Errorf("hardware detail missing 'core' mention: %q", r.Detail)
	}
}

// ----- Report -----

func TestReport_ExitCode_AllPass(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Status: StatusPass},
			{Status: StatusPass},
		},
	}
	if got := r.ExitCode(); got != 0 {
		t.Errorf("all-pass exit code = %d, want 0", got)
	}
}

func TestReport_ExitCode_WarnOnly(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Status: StatusPass},
			{Status: StatusWarn},
		},
	}
	if got := r.ExitCode(); got != 1 {
		t.Errorf("warn-only exit code = %d, want 1", got)
	}
}

func TestReport_ExitCode_AnyFail(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Status: StatusPass},
			{Status: StatusWarn},
			{Status: StatusFail},
		},
	}
	if got := r.ExitCode(); got != 2 {
		t.Errorf("with-fail exit code = %d, want 2", got)
	}
}

func TestReport_Print_OutputFormat(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Name: "Config", Status: StatusPass, Detail: "loaded"},
			{Name: "Address", Status: StatusFail, Detail: "missing", Fix: "pass --bitcoin-address"},
		},
	}
	var buf bytes.Buffer
	r.Print(&buf)
	out := buf.String()
	if !strings.Contains(out, "[✓] Config") {
		t.Errorf("missing pass marker:\n%s", out)
	}
	if !strings.Contains(out, "[✗] Address") {
		t.Errorf("missing fail marker:\n%s", out)
	}
	if !strings.Contains(out, "→ fix:") {
		t.Errorf("missing fix line:\n%s", out)
	}
	if !strings.Contains(out, "Summary:") {
		t.Errorf("missing summary:\n%s", out)
	}
	if !strings.Contains(out, "1 passed, 1 failed") {
		t.Errorf("summary counts wrong:\n%s", out)
	}
}

// ----- Runner -----

func TestRunner_ExecutesAllChecks(t *testing.T) {
	r := &Runner{
		Checks: []Check{
			{Name: "A", Run: func(_ context.Context) Result {
				return Result{Status: StatusPass, Detail: "a"}
			}},
			{Name: "B", Run: func(_ context.Context) Result {
				return Result{Status: StatusWarn, Detail: "b"}
			}},
			{Name: "C", Run: func(_ context.Context) Result {
				return Result{Status: StatusFail, Detail: "c"}
			}},
		},
	}
	rep := r.Run(context.Background())
	if len(rep.Results) != 3 {
		t.Fatalf("got %d results, want 3", len(rep.Results))
	}
	// Order must match Checks order.
	for i, want := range []string{"A", "B", "C"} {
		if rep.Results[i].Name != want {
			t.Errorf("result %d name = %q, want %q", i, rep.Results[i].Name, want)
		}
	}
}

// ----- DefaultChecks integration -----

func TestDefaultChecks_ReturnsAllExpectedChecks(t *testing.T) {
	checks := DefaultChecks(config.Config{BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}, "")
	names := make(map[string]bool)
	for _, c := range checks {
		names[c.Name] = true
	}
	expected := []string{
		"Configuration",
		"Bitcoin address",
		"Data directory",
		"Pool reachability",
		"Pool endpoint diversity",
		"Hardware",
		"Network",
	}
	for _, name := range expected {
		if !names[name] {
			t.Errorf("DefaultChecks missing %q", name)
		}
	}
}
