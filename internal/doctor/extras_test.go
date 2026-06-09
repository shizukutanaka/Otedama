// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package doctor

import (
	"bytes"
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
)

// ============================================================================
// Status.symbol — must return distinct, single-char-wide markers
// ============================================================================

func TestStatus_SymbolIsNonEmpty(t *testing.T) {
	for _, s := range []Status{StatusPass, StatusWarn, StatusFail, StatusSkip} {
		sym := s.symbol()
		if sym == "" {
			t.Errorf("Status(%d).symbol() is empty", s)
		}
	}
}

func TestStatus_SymbolsAreDistinct(t *testing.T) {
	symbols := map[string]Status{}
	for _, s := range []Status{StatusPass, StatusWarn, StatusFail, StatusSkip} {
		sym := s.symbol()
		if prev, dup := symbols[sym]; dup {
			t.Errorf("Status %d and Status %d share symbol %q",
				prev, s, sym)
		}
		symbols[sym] = s
	}
}

func TestStatus_SymbolUnknownValue(t *testing.T) {
	// Unknown Status values must not panic and should return a
	// recognisable fallback.
	s := Status(99)
	if sym := s.symbol(); sym == "" {
		t.Error("unknown Status returned empty symbol")
	}
}

// ============================================================================
// isBech32Char — character class is exactly the spec's charset
// ============================================================================

func TestIsBech32Char_AllValidChars(t *testing.T) {
	// BIP-173 Bech32 character set.
	const valid = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
	for _, c := range valid {
		if !isBech32Char(c) {
			t.Errorf("isBech32Char(%q) = false, want true", c)
		}
	}
}

func TestIsBech32Char_InvalidChars(t *testing.T) {
	// Characters explicitly excluded from Bech32 to reduce transcription errors.
	for _, c := range "1bio" { // 1, b, i, o are NOT in the bech32 charset
		if isBech32Char(c) {
			t.Errorf("isBech32Char(%q) = true, want false", c)
		}
	}
	// Uppercase ASCII must be rejected (Bech32 is lowercase).
	for _, c := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
		if isBech32Char(c) {
			t.Errorf("isBech32Char(%q) = true, want false (uppercase rejected)", c)
		}
	}
}

// ============================================================================
// isBase58Char — excludes 0, O, I, l to prevent misreading
// ============================================================================

func TestIsBase58Char_ExcludesAmbiguousChars(t *testing.T) {
	// These are the four characters Bitcoin's Base58 deliberately omits.
	for _, c := range "0OIl" {
		if isBase58Char(c) {
			t.Errorf("isBase58Char(%q) = true, want false (ambiguous char)", c)
		}
	}
}

func TestIsBase58Char_IncludesNumbers1Through9(t *testing.T) {
	for _, c := range "123456789" {
		if !isBase58Char(c) {
			t.Errorf("isBase58Char(%q) = false, want true", c)
		}
	}
}

func TestIsBase58Char_IncludesAllowedLetters(t *testing.T) {
	// All letters except 0/O/I/l.
	allowed := "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	for _, c := range allowed {
		if !isBase58Char(c) {
			t.Errorf("isBase58Char(%q) = false, want true", c)
		}
	}
}

// ============================================================================
// isLikelyBitcoinAddress — edge cases beyond the happy path
// ============================================================================

func TestIsLikelyBitcoinAddress_LengthBoundaries(t *testing.T) {
	// Bech32 minimum: 26 chars per spec lower bound in isLikelyBitcoinAddress.
	tests := []struct {
		addr string
		want bool
	}{
		// Too short — 25 chars (minimum plausible length is 26).
		{"bc1qar0srrr7xfkvy5l643lyd", false},
		// 63 chars is now accepted — the upper bound is 90, matching
		// internal/config so a longer bech32m address that passes
		// `config validate` is not flagged by `doctor`.
		{"bc1" + strings.Repeat("q", 60), true},
		// Too long — 91 chars (limit is 90).
		{"bc1" + strings.Repeat("q", 88), false},
		// Whitespace trimming.
		{"   bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq   ", true},
	}
	for _, tt := range tests {
		got := isLikelyBitcoinAddress(tt.addr)
		if got != tt.want {
			t.Errorf("isLikelyBitcoinAddress(%q) = %v, want %v", tt.addr, got, tt.want)
		}
	}
}

func TestIsLikelyBitcoinAddress_OneCharOffPrefix(t *testing.T) {
	// "bc2" prefix must be rejected even if the rest looks valid.
	bad := "bc2qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	if isLikelyBitcoinAddress(bad) {
		t.Errorf("%q should be rejected (wrong prefix)", bad)
	}
}

// ============================================================================
// stripScheme — additional edge cases
// ============================================================================

func TestStripScheme_ReturnsEmptyForMissingHost(t *testing.T) {
	// Scheme only with no host-port.
	if got := stripScheme("stratum+v2://"); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestStripScheme_RejectsUnknownScheme(t *testing.T) {
	for _, url := range []string{
		"ws://example.com",
		"ftp://example.com",
		"/no-scheme",
	} {
		if got := stripScheme(url); got != "" {
			t.Errorf("stripScheme(%q) = %q, want empty", url, got)
		}
	}
}

// ============================================================================
// maskAddress — preserves last 4 and first 6
// ============================================================================

func TestMaskAddress_PreservesStructure(t *testing.T) {
	long := "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
	masked := maskAddress(long)
	if !strings.HasPrefix(masked, long[:6]) {
		t.Errorf("prefix lost: %q", masked)
	}
	if !strings.HasSuffix(masked, long[len(long)-4:]) {
		t.Errorf("suffix lost: %q", masked)
	}
	if strings.Contains(masked, long[7:len(long)-5]) {
		t.Errorf("middle not masked: %q", masked)
	}
}

func TestMaskAddress_BoundaryLength10(t *testing.T) {
	// At exactly 10 chars, returns unchanged.
	in := "abcdefghij" // 10 chars
	if got := maskAddress(in); got != in {
		t.Errorf("10-char input changed: %q", got)
	}
}

func TestMaskAddress_BoundaryLength11(t *testing.T) {
	// 11 chars → masked.
	in := "abcdefghijk"
	got := maskAddress(in)
	if got == in {
		t.Errorf("11-char input should be masked; got unchanged: %q", got)
	}
}

// ============================================================================
// Runner — concurrent safety and order preservation
// ============================================================================

func TestRunner_PreservesCheckOrderDespiteConcurrency(t *testing.T) {
	// Even though checks run concurrently, results must appear in the
	// same order as the Checks slice (for deterministic output).
	var order []string
	var mu sync.Mutex
	makeCheck := func(name string, sleep time.Duration) Check {
		return Check{
			Name: name,
			Run: func(_ context.Context) Result {
				time.Sleep(sleep)
				mu.Lock()
				order = append(order, name)
				mu.Unlock()
				return Result{Status: StatusPass, Detail: name}
			},
		}
	}
	r := &Runner{
		Checks: []Check{
			// Reversed sleep order — slowest first, fastest last.
			makeCheck("Z", 30*time.Millisecond),
			makeCheck("A", 1*time.Millisecond),
			makeCheck("M", 15*time.Millisecond),
		},
	}
	rep := r.Run(context.Background())

	// Results must be Z, A, M (Checks order), not A, M, Z (completion order).
	for i, want := range []string{"Z", "A", "M"} {
		if rep.Results[i].Name != want {
			t.Errorf("rep.Results[%d].Name = %q, want %q (order preservation broken)",
				i, rep.Results[i].Name, want)
		}
	}
}

func TestRunner_EmptyChecks(t *testing.T) {
	r := &Runner{}
	rep := r.Run(context.Background())
	if len(rep.Results) != 0 {
		t.Errorf("empty Runner produced %d results", len(rep.Results))
	}
	if rep.ExitCode() != 0 {
		t.Errorf("empty Runner ExitCode = %d, want 0", rep.ExitCode())
	}
}

func TestRunner_MeasuresElapsedTime(t *testing.T) {
	r := &Runner{
		Checks: []Check{{
			Name: "slow",
			Run: func(_ context.Context) Result {
				time.Sleep(50 * time.Millisecond)
				return Result{Status: StatusPass}
			},
		}},
	}
	rep := r.Run(context.Background())
	if len(rep.Results) != 1 {
		t.Fatalf("expected 1 result")
	}
	if rep.Results[0].Elapsed < 40*time.Millisecond {
		t.Errorf("Elapsed = %v, want at least 40ms", rep.Results[0].Elapsed)
	}
	if rep.Duration < 40*time.Millisecond {
		t.Errorf("rep.Duration = %v, want at least 40ms", rep.Duration)
	}
}

// ============================================================================
// Report.Print — edge cases
// ============================================================================

func TestReport_Print_SkippedResultsShown(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Name: "A", Status: StatusPass, Detail: "ok"},
			{Name: "B", Status: StatusSkip, Detail: "n/a on this platform"},
		},
	}
	var buf bytes.Buffer
	r.Print(&buf)
	out := buf.String()
	if !strings.Contains(out, "skipped") {
		t.Errorf("summary missing 'skipped' count:\n%s", out)
	}
}

func TestReport_Print_SingularVsPluralWarning(t *testing.T) {
	// "1 warning" (singular) vs "2 warnings" (plural).
	r1 := &Report{Results: []Result{{Status: StatusWarn}}}
	var b1 bytes.Buffer
	r1.Print(&b1)
	if !strings.Contains(b1.String(), "1 warning") {
		t.Errorf("singular missing: %s", b1.String())
	}
	if strings.Contains(b1.String(), "1 warnings") {
		t.Errorf("wrong pluralisation for 1: %s", b1.String())
	}

	r2 := &Report{Results: []Result{{Status: StatusWarn}, {Status: StatusWarn}}}
	var b2 bytes.Buffer
	r2.Print(&b2)
	if !strings.Contains(b2.String(), "2 warnings") {
		t.Errorf("plural missing: %s", b2.String())
	}
}

func TestReport_Print_NoFixLine_WhenPassing(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Name: "OK", Status: StatusPass, Detail: "nothing to fix", Fix: ""},
		},
	}
	var buf bytes.Buffer
	r.Print(&buf)
	if strings.Contains(buf.String(), "fix:") {
		t.Errorf("passing result must not emit fix line:\n%s", buf.String())
	}
}

// ============================================================================
// checkPoolReachability — unreachable endpoint
// ============================================================================

func TestCheckPoolReachability_UnreachableReturnsFail(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{
			// RFC 5737 TEST-NET-1 is non-routable — guaranteed to be unreachable.
			{URL: "stratum+v2://192.0.2.1:9999"},
		},
	}
	c := checkPoolReachability(cfg)

	// Short timeout to keep the test fast.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	r := c.Run(ctx)
	if r.Status != StatusFail {
		t.Errorf("unreachable pool status = %v, want Fail (got detail: %s)", r.Status, r.Detail)
	}
	if r.Fix == "" {
		t.Error("fail result must provide a fix hint")
	}
}

func TestCheckPoolReachability_MalformedURL(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: "not-a-valid-url"},
		},
	}
	c := checkPoolReachability(cfg)
	r := c.Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("malformed URL status = %v, want Fail", r.Status)
	}
}

func TestCheckPoolReachability_ReachableEndpoint(t *testing.T) {
	// Start a local TCP listener to simulate a reachable pool.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind listener")
	}
	defer ln.Close()

	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+v2://" + ln.Addr().String()},
		},
	}
	c := checkPoolReachability(cfg)
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("reachable pool status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

// ============================================================================
// checkNetwork
// ============================================================================

func TestCheckNetwork_ReturnsResult(t *testing.T) {
	// This test requires either internet or no internet — both outcomes
	// are valid. We just verify the check does not panic and returns a
	// result with a sensible status.
	c := checkNetwork()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r := c.Run(ctx)
	if r.Status != StatusPass && r.Status != StatusFail {
		t.Errorf("network check returned unexpected status %v", r.Status)
	}
}

// ============================================================================
// checkConfig — warnings vs failures
// ============================================================================

func TestCheckConfig_NoPathEmitsWarning(t *testing.T) {
	c := checkConfig(config.Config{}, "")
	r := c.Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("status = %v, want Warn (no config file is not fatal)", r.Status)
	}
	if r.Fix == "" {
		t.Error("warning result should provide a fix hint")
	}
}

func TestCheckConfig_NonexistentPathEmitsWarning(t *testing.T) {
	c := checkConfig(config.Config{}, "/nonexistent/path/config.yaml")
	r := c.Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("status = %v, want Warn (missing file is not fatal)", r.Status)
	}
}

// ============================================================================
// DefaultChecks — returns well-defined set
// ============================================================================

func TestDefaultChecks_AllHaveRunFunction(t *testing.T) {
	checks := DefaultChecks(config.Config{}, "")
	if len(checks) == 0 {
		t.Fatal("DefaultChecks returned empty slice")
	}
	for _, c := range checks {
		if c.Name == "" {
			t.Error("check with empty Name")
		}
		if c.Run == nil {
			t.Errorf("check %q has nil Run function", c.Name)
		}
	}
}

// ============================================================================
// SortedResults — stability guarantee
// ============================================================================

func TestSortedResults_StableForEqualNames(t *testing.T) {
	r := &Report{
		Results: []Result{
			{Name: "A", Detail: "first"},
			{Name: "B", Detail: "middle"},
			{Name: "A", Detail: "second"},
		},
	}
	sorted := SortedResults(r)
	// Stable sort preserves relative order of equal elements.
	if sorted[0].Detail != "first" || sorted[1].Detail != "second" {
		t.Errorf("stable sort broken:\n%+v", sorted)
	}
}

func TestSortedResults_DoesNotMutateOriginal(t *testing.T) {
	original := []Result{
		{Name: "Zeta"},
		{Name: "Alpha"},
	}
	r := &Report{Results: original}
	_ = SortedResults(r)

	if r.Results[0].Name != "Zeta" {
		t.Errorf("original Results mutated: %+v", r.Results)
	}
}

func TestCheckFailoverAddresses(t *testing.T) {
	run := func(addrs []string) Result {
		return checkFailoverAddresses(addrs).Run(context.Background())
	}

	if got := run(nil); got.Status != StatusSkip {
		t.Errorf("empty list: status = %v, want StatusSkip", got.Status)
	}
	if got := run([]string{
		"bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5",
		"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
	}); got.Status != StatusPass {
		t.Errorf("valid list: status = %v (detail=%q), want StatusPass", got.Status, got.Detail)
	}
	if got := run([]string{
		"bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5",
		"not-a-valid-address",
	}); got.Status != StatusFail {
		t.Errorf("list with a bad entry: status = %v, want StatusFail", got.Status)
	}
}
