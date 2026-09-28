// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package doctor

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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
	// recognizable fallback.
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
// checkConfig — valid-file paths (Fail and Pass)
// ============================================================================

func TestCheckConfig_ValidFile_InvalidConfig_Fails(t *testing.T) {
	// A file that exists but whose config fails Validate (no bitcoin address).
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("log_level: invalid_level\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	cfg := config.Config{LogLevel: "invalid_level"} // Validate rejects unknown log level
	c := checkConfig(cfg, path)
	r := c.Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("invalid config status = %v, want Fail (detail: %s)", r.Status, r.Detail)
	}
	if r.Fix == "" {
		t.Error("Fail result must have a Fix hint")
	}
}

func TestCheckConfig_ValidFile_ValidConfig_Passes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(""), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	cfg := config.Config{BitcoinAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}
	c := checkConfig(cfg, path)
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("valid config status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

// ============================================================================
// checkDataDir — additional branches
// ============================================================================

func TestCheckDataDir_EmptyDir_UsesDefault(t *testing.T) {
	// Passing "" triggers the home-directory lookup.
	// The default path (~/.local/share/otedama) almost certainly doesn't exist
	// in a test container, so we expect Warn (will-be-created) or Skip (no HOME).
	c := checkDataDir("")
	r := c.Run(context.Background())
	switch r.Status {
	case StatusWarn, StatusSkip, StatusPass:
		// All three are acceptable outcomes depending on environment.
	default:
		t.Errorf("empty-dir checkDataDir status = %v, want Warn/Skip/Pass", r.Status)
	}
}

func TestCheckDataDir_PathIsFile_Fails(t *testing.T) {
	// If the data-dir path points to a regular file (not a dir), report Fail.
	f, err := os.CreateTemp(t.TempDir(), "not-a-dir")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	f.Close()

	c := checkDataDir(f.Name())
	r := c.Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("file-path checkDataDir status = %v, want Fail (detail: %s)", r.Status, r.Detail)
	}
}

// ============================================================================
// isLikelyBitcoinAddress — base58 invalid-char branch
// ============================================================================

func TestIsLikelyBitcoinAddress_Base58InvalidChar_ReturnsFalse(t *testing.T) {
	// '0' is explicitly excluded from Bitcoin's Base58 alphabet.
	// "1" + 25 zeros is long enough (26 chars) but contains an invalid char.
	addr := "1" + strings.Repeat("0", 25)
	if isLikelyBitcoinAddress(addr) {
		t.Errorf("address with '0' chars should be rejected: %q", addr)
	}
}

func TestIsLikelyBitcoinAddress_ThreePrefixBase58InvalidChar_ReturnsFalse(t *testing.T) {
	// Same check for "3" prefix (P2SH).
	addr := "3" + strings.Repeat("O", 25) // 'O' is excluded from Base58
	if isLikelyBitcoinAddress(addr) {
		t.Errorf("address with 'O' chars should be rejected: %q", addr)
	}
}

func TestIsLikelyBitcoinAddress_Bech32InvalidCharInValidLengthAddress(t *testing.T) {
	// "bc1BADCAPS" is only 10 chars — it fails the length check before the
	// bech32 char loop. This test uses a 26-char address so the loop runs.
	// Uppercase letters are not in the Bech32 charset.
	addr := "bc1" + strings.Repeat("q", 22) + "B" // 26 chars, ends with invalid 'B'
	if isLikelyBitcoinAddress(addr) {
		t.Errorf("bc1 address with uppercase char should be rejected: %q", addr)
	}
}

// ============================================================================
// checkPoolReachability — default URL branch (no pools configured)
// ============================================================================

func TestCheckPoolReachability_NoPoolsUsesDefault(t *testing.T) {
	// With an empty Pools slice the check falls back to config.DefaultPoolURL.
	// In a network-isolated test environment the dial will fail, but the
	// important thing is that the default-URL branch was taken (coverage).
	cfg := config.Config{} // no Pools
	c := checkPoolReachability(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	r := c.Run(ctx)
	// Fail or Pass are both valid depending on network; Fail is expected in CI.
	if r.Status != StatusFail && r.Status != StatusPass {
		t.Errorf("no-pools checkPoolReachability status = %v, want Fail or Pass", r.Status)
	}
}

// ============================================================================
// checkNetwork — fail path via pre-canceled context
// ============================================================================

func TestCheckNetwork_CancelledContext_Fails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // canceled before the check even starts
	c := checkNetwork()
	r := c.Run(ctx)
	if r.Status != StatusFail {
		t.Errorf("canceled-context network check: status = %v, want Fail", r.Status)
	}
	if r.Fix == "" {
		t.Error("Fail result must provide a Fix hint")
	}
}

func TestCheckNetwork_LocalListener_Passes(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("cannot bind listener")
	}
	defer ln.Close()

	old := networkCheckEndpoint
	networkCheckEndpoint = ln.Addr().String()
	t.Cleanup(func() { networkCheckEndpoint = old })

	c := checkNetwork()
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("local-listener network check: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

// ============================================================================
// checkHardware — GPU detection branches via injected DRM path
// ============================================================================

func TestCheckHardware_GPUDetected(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("GPU detection only runs on Linux")
	}
	dir := t.TempDir()
	// Simulate two render nodes.
	for _, name := range []string{"renderD128", "renderD129", "card0"} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	old := gpuDRMPath
	gpuDRMPath = dir
	t.Cleanup(func() { gpuDRMPath = old })

	c := checkHardware()
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("GPU-detected status = %v, want Pass", r.Status)
	}
	if !strings.Contains(r.Detail, "GPU") {
		t.Errorf("detail should mention GPU: %q", r.Detail)
	}
}

func TestCheckHardware_EmptyDRMDir_NoGPU(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("GPU detection only runs on Linux")
	}
	dir := t.TempDir() // empty dir — no renderD* entries
	old := gpuDRMPath
	gpuDRMPath = dir
	t.Cleanup(func() { gpuDRMPath = old })

	c := checkHardware()
	r := c.Run(context.Background())
	// Corrected session 243: no GPU is informational (Pass), not a Warn — a
	// GPU does not increase Bitcoin-mining hashrate today (see checkHardware).
	if r.Status != StatusPass {
		t.Errorf("no-GPU status = %v, want Pass", r.Status)
	}
	if !strings.Contains(r.Detail, "no GPU") {
		t.Errorf("detail should say 'no GPU': %q", r.Detail)
	}
}

// ============================================================================
// checkFailoverAddresses
// ============================================================================

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

// ============================================================================
// checkWallet — wallet initialisation and fingerprint display
// ============================================================================

func TestCheckWallet_NoWallet_EmitsWarn(t *testing.T) {
	dir := t.TempDir()
	c := checkWallet(dir)
	r := c.Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("no-wallet status = %v, want Warn (detail: %s)", r.Status, r.Detail)
	}
	if r.Fix == "" {
		t.Error("Warn result must provide a Fix hint")
	}
}

func TestCheckWallet_WalletWithFingerprint_ShowsFingerprint(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, walletDatFile), []byte("stub"), 0o600); err != nil {
		t.Fatalf("write wallet.dat: %v", err)
	}
	const fp = "a1b2c3d4"
	if err := os.WriteFile(filepath.Join(dir, walletFingerprintFile), []byte(fp), 0o600); err != nil {
		t.Fatalf("write fingerprint: %v", err)
	}
	c := checkWallet(dir)
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("wallet-with-fp status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, fp) {
		t.Errorf("fingerprint %q missing from detail: %q", fp, r.Detail)
	}
}

func TestCheckWallet_WalletWithoutFingerprintFile_PassesWithNote(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, walletDatFile), []byte("stub"), 0o600); err != nil {
		t.Fatalf("write wallet.dat: %v", err)
	}
	c := checkWallet(dir)
	r := c.Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("wallet-no-fp status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, "fingerprint file missing") {
		t.Errorf("detail should mention missing fingerprint file: %q", r.Detail)
	}
}

func TestCheckWallet_EmptyDataDir_UsesDefault(t *testing.T) {
	c := checkWallet("")
	r := c.Run(context.Background())
	switch r.Status {
	case StatusWarn, StatusSkip, StatusPass:
	default:
		t.Errorf("empty-dir checkWallet status = %v, want Warn/Skip/Pass", r.Status)
	}
}

func TestCheckWallet_FingerprintTrimmedOfWhitespace(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, walletDatFile), []byte("stub"), 0o600); err != nil {
		t.Fatalf("write wallet.dat: %v", err)
	}
	const fp = "deadbeef"
	if err := os.WriteFile(filepath.Join(dir, walletFingerprintFile), []byte(fp+"\n"), 0o600); err != nil {
		t.Fatalf("write fingerprint: %v", err)
	}
	c := checkWallet(dir)
	r := c.Run(context.Background())
	if !strings.Contains(r.Detail, fp) {
		t.Errorf("trimmed fingerprint %q not in detail: %q", fp, r.Detail)
	}
	if strings.Contains(r.Detail, fp+"\n") {
		t.Errorf("detail contains untrimmed newline: %q", r.Detail)
	}
}

func TestDefaultChecks_IncludesWalletCheck(t *testing.T) {
	checks := DefaultChecks(config.Config{}, "")
	var found bool
	for _, c := range checks {
		if c.Name == "Lightning wallet" {
			found = true
			break
		}
	}
	if !found {
		t.Error("DefaultChecks does not include the 'Lightning wallet' check")
	}
}

// ============================================================================
// checkBitcoinAddress / checkFailoverAddresses — bech32 checksum verification
// ============================================================================

func TestCheckBitcoinAddress_ValidBech32Passes(t *testing.T) {
	r := checkBitcoinAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("valid bech32 address: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

func TestCheckBitcoinAddress_TypoFailsChecksum(t *testing.T) {
	// Same address as above with the final character flipped: in-charset, so
	// the prefix/length check passes, but the bech32 checksum fails. This is
	// the typo class the check now catches.
	r := checkBitcoinAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr").Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("typo'd bech32 address: status = %v, want Fail (detail: %s)", r.Status, r.Detail)
	}
	if r.Fix == "" {
		t.Error("Fail result must provide a Fix hint")
	}
}

func TestCheckBitcoinAddress_ValidTaprootPasses(t *testing.T) {
	r := checkBitcoinAddress("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr").Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("valid taproot address: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

func TestCheckBitcoinAddress_ValidBase58Passes(t *testing.T) {
	// Valid Base58Check (1.../3...) addresses must pass the checksum step.
	for _, a := range []string{
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		"3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
	} {
		r := checkBitcoinAddress(a).Run(context.Background())
		if r.Status != StatusPass {
			t.Errorf("legacy address %q: status = %v, want Pass (detail: %s)", a, r.Status, r.Detail)
		}
	}
}

func TestCheckBitcoinAddress_Base58TypoFailsChecksum(t *testing.T) {
	// In-alphabet typo of a valid P2PKH address: passes the charset check but
	// fails the Base58Check checksum, so it must now be caught.
	r := checkBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb").Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("typo'd base58 address: status = %v, want Fail (detail: %s)", r.Status, r.Detail)
	}
	if r.Fix == "" {
		t.Error("Fail result must provide a Fix hint")
	}
}

func TestCheckFailoverAddresses_TypoFailsChecksum(t *testing.T) {
	addrs := []string{
		"bc1qjaet6jgpk08la46jelmlpgsz84luc4lc0tnwr5", // valid
		"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr", // checksum typo
	}
	r := checkFailoverAddresses(addrs).Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("failover list with a checksum typo: status = %v, want Fail", r.Status)
	}
}

// ============================================================================
// checkPoolEncryption — plaintext stratum warning
// ============================================================================

func TestCheckPoolEncryption_NoPoolsSkips(t *testing.T) {
	r := checkPoolEncryption(config.Config{}).Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("no pools: status = %v, want Skip", r.Status)
	}
}

func TestCheckPoolEncryption_PlaintextWarns(t *testing.T) {
	cfg := config.Config{Pools: []config.PoolConfig{
		{URL: "stratum+tcp://pool.example.com:3333"},
	}}
	r := checkPoolEncryption(cfg).Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("plaintext pool: status = %v, want Warn (detail: %s)", r.Status, r.Detail)
	}
	if r.Fix == "" {
		t.Error("Warn must include a Fix hint")
	}
	if !strings.Contains(r.Detail, "pool.example.com:3333") {
		t.Errorf("detail should name the plaintext pool: %q", r.Detail)
	}
}

func TestCheckPoolEncryption_EncryptedSchemesPass(t *testing.T) {
	for _, url := range []string{
		"stratum+tls://pool.example.com:3334",
		"stratum+v2://pool.example.com:34254",
		"stratum+v2tls://pool.example.com:34254",
	} {
		cfg := config.Config{Pools: []config.PoolConfig{{URL: url}}}
		r := checkPoolEncryption(cfg).Run(context.Background())
		if r.Status != StatusPass {
			t.Errorf("%s: status = %v, want Pass (detail: %s)", url, r.Status, r.Detail)
		}
	}
}

func TestCheckPoolEncryption_MixedWarnsOnPlaintextOnly(t *testing.T) {
	cfg := config.Config{Pools: []config.PoolConfig{
		{URL: "stratum+tls://safe.example.com:3334"},
		{URL: "stratum+tcp://risky.example.com:3333"},
	}}
	r := checkPoolEncryption(cfg).Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("mixed: status = %v, want Warn", r.Status)
	}
	if strings.Contains(r.Detail, "safe.example.com") {
		t.Errorf("only the plaintext pool should be named: %q", r.Detail)
	}
}

func TestDefaultChecks_IncludesPoolEncryptionCheck(t *testing.T) {
	var found bool
	for _, c := range DefaultChecks(config.Config{}, "") {
		if c.Name == "Pool connection encryption" {
			found = true
			break
		}
	}
	if !found {
		t.Error("DefaultChecks does not include the 'Pool connection encryption' check")
	}
}

// ============================================================================
// checkPowerEconomics — cross-field config coherence
// ============================================================================

func TestCheckPowerEconomics_BothUnsetSkips(t *testing.T) {
	r := checkPowerEconomics(config.Config{}).Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("both unset: status = %v, want Skip", r.Status)
	}
}

func TestCheckPowerEconomics_BothSetPasses(t *testing.T) {
	cfg := config.Config{PowerWatts: 1200, ElectricityPricePerKWh: 0.10}
	if r := checkPowerEconomics(cfg).Run(context.Background()); r.Status != StatusPass {
		t.Errorf("both set: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

func TestCheckPowerEconomics_PowerOnlyWarnsAboutCost(t *testing.T) {
	cfg := config.Config{PowerWatts: 1200}
	r := checkPowerEconomics(cfg).Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("power only: status = %v, want Warn", r.Status)
	}
	if !strings.Contains(r.Detail, "electricity_price_per_kwh") || r.Fix == "" {
		t.Errorf("power only: detail/fix should point at electricity_price_per_kwh: %q / %q", r.Detail, r.Fix)
	}
}

func TestCheckPowerEconomics_PriceOnlyWarnsInert(t *testing.T) {
	cfg := config.Config{ElectricityPricePerKWh: 0.10}
	r := checkPowerEconomics(cfg).Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("price only: status = %v, want Warn", r.Status)
	}
	if !strings.Contains(r.Detail, "power_watts") {
		t.Errorf("price only: detail should point at power_watts: %q", r.Detail)
	}
}

func TestDefaultChecks_IncludesPowerEconomicsCheck(t *testing.T) {
	var found bool
	for _, c := range DefaultChecks(config.Config{}, "") {
		if c.Name == "Power & cost config" {
			found = true
			break
		}
	}
	if !found {
		t.Error("DefaultChecks does not include the 'Power & cost config' check")
	}
}

// ============================================================================
// checkProfitabilityFloor — min_yield_sats_per_sec advisory check
// ============================================================================

func TestCheckProfitabilityFloor_UnsetSkips(t *testing.T) {
	r := checkProfitabilityFloor(config.Config{}).Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("unset: status = %v, want Skip", r.Status)
	}
}

func TestCheckProfitabilityFloor_SetPassesAndSurfacesValue(t *testing.T) {
	cfg := config.Config{MinYieldSatsPerSec: 0.25}
	r := checkProfitabilityFloor(cfg).Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("set: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, "0.25") {
		t.Errorf("set: detail should echo the configured floor: %q", r.Detail)
	}
	// The Fix must point the operator at the observable that settles
	// "is this idling everything?" — the otedama_devices_idle metric.
	if !strings.Contains(r.Fix, "otedama_devices_idle") {
		t.Errorf("set: fix should point at the otedama_devices_idle metric: %q", r.Fix)
	}
}

func TestDefaultChecks_IncludesProfitabilityFloorCheck(t *testing.T) {
	var found bool
	for _, c := range DefaultChecks(config.Config{}, "") {
		if c.Name == "Profitability floor" {
			found = true
			break
		}
	}
	if !found {
		t.Error("DefaultChecks does not include the 'Profitability floor' check")
	}
}

// ============================================================================
// checkPoolTLSCA — per-pool tls_ca_file validation
// ============================================================================

func writePEMCert(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("createcert: %v", err)
	}
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestCheckPoolTLSCA_NoneConfiguredSkips(t *testing.T) {
	cfg := config.Config{Pools: []config.PoolConfig{{URL: "stratum+tls://p.example.com:3334"}}}
	if r := checkPoolTLSCA(cfg).Run(context.Background()); r.Status != StatusSkip {
		t.Errorf("status = %v, want Skip", r.Status)
	}
}

func TestCheckPoolTLSCA_ValidFilePasses(t *testing.T) {
	ca := writePEMCert(t)
	cfg := config.Config{Pools: []config.PoolConfig{
		{URL: "stratum+tls://p.example.com:3334", TLSCAFile: ca},
	}}
	if r := checkPoolTLSCA(cfg).Run(context.Background()); r.Status != StatusPass {
		t.Errorf("status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}

func TestCheckPoolTLSCA_MissingFileFails(t *testing.T) {
	cfg := config.Config{Pools: []config.PoolConfig{
		{URL: "stratum+tls://p.example.com:3334", TLSCAFile: "/nonexistent/ca.pem"},
	}}
	r := checkPoolTLSCA(cfg).Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("status = %v, want Fail", r.Status)
	}
	if r.Fix == "" {
		t.Error("Fail must include a Fix hint")
	}
}

func TestCheckPoolTLSCA_GarbageFileFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.pem")
	if err := os.WriteFile(path, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	cfg := config.Config{Pools: []config.PoolConfig{
		{URL: "stratum+tls://p.example.com:3334", TLSCAFile: path},
	}}
	if r := checkPoolTLSCA(cfg).Run(context.Background()); r.Status != StatusFail {
		t.Errorf("status = %v, want Fail (no valid PEM)", r.Status)
	}
}

func TestCheckPoolTLSCA_NonTLSSchemeWarns(t *testing.T) {
	ca := writePEMCert(t)
	cfg := config.Config{Pools: []config.PoolConfig{
		{URL: "stratum+tcp://p.example.com:3333", TLSCAFile: ca},
	}}
	r := checkPoolTLSCA(cfg).Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("status = %v, want Warn (CA set on non-TLS pool)", r.Status)
	}
}

// ============================================================================
// checkPayoutScheme — payout scheme advisory check
// ============================================================================

func TestCheckPayoutScheme_NoPoolsSkips(t *testing.T) {
	c := checkPayoutScheme(config.Config{})
	r := c.Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("no pools: status = %v, want Skip", r.Status)
	}
}

func TestCheckPayoutScheme_KnownSchemes(t *testing.T) {
	tests := []struct {
		scheme string
		want   string // substring expected in detail
	}{
		{"fpps", "FPPS"},
		{"pplns", "PPLNS"},
		{"tides", "TIDES"},
		{"solo", "Solo"},
	}
	for _, tt := range tests {
		t.Run(tt.scheme, func(t *testing.T) {
			cfg := config.Config{
				Pools: []config.PoolConfig{
					{URL: "stratum+tcp://pool.example.com:3333", PayoutScheme: tt.scheme},
				},
			}
			r := checkPayoutScheme(cfg).Run(context.Background())
			if r.Status != StatusPass {
				t.Errorf("%s: status = %v, want Pass", tt.scheme, r.Status)
			}
			if !strings.Contains(r.Detail, tt.want) {
				t.Errorf("%s: %q not in detail: %q", tt.scheme, tt.want, r.Detail)
			}
			if r.Fix != "" {
				t.Errorf("%s: known scheme should not emit Fix hint, got: %q", tt.scheme, r.Fix)
			}
		})
	}
}

func TestCheckPayoutScheme_UnknownScheme_EmitsFixHint(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+tcp://pool.example.com:3333", PayoutScheme: ""},
		},
	}
	r := checkPayoutScheme(cfg).Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("unknown scheme: status = %v, want Pass", r.Status)
	}
	if r.Fix == "" {
		t.Error("unknown scheme should emit Fix hint")
	}
	if !strings.Contains(r.Detail, "scheme not set") {
		t.Errorf("detail should mention 'scheme not set': %q", r.Detail)
	}
}

func TestCheckPayoutScheme_MultiplePoolsMixedSchemes(t *testing.T) {
	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+tcp://pool1.example.com:3333", PayoutScheme: "fpps"},
			{URL: "stratum+tcp://pool2.example.com:3333", PayoutScheme: "pplns"},
		},
	}
	r := checkPayoutScheme(cfg).Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("mixed schemes: status = %v, want Pass", r.Status)
	}
	if !strings.Contains(r.Detail, "FPPS") || !strings.Contains(r.Detail, "PPLNS") {
		t.Errorf("detail should mention both schemes: %q", r.Detail)
	}
	if r.Fix != "" {
		t.Errorf("all-known schemes should not emit Fix hint, got: %q", r.Fix)
	}
}

func TestDefaultChecks_IncludesPayoutSchemeCheck(t *testing.T) {
	checks := DefaultChecks(config.Config{}, "")
	var found bool
	for _, c := range checks {
		if c.Name == "Pool payout schemes" {
			found = true
			break
		}
	}
	if !found {
		t.Error("DefaultChecks does not include the 'Pool payout schemes' check")
	}
}

// checkPoolDiversity — no pools, single pool, multiple pools
func TestCheckPoolDiversity(t *testing.T) {
	ctx := context.Background()

	run := func(cfg config.Config) Result {
		return checkPoolDiversity(cfg).Run(ctx)
	}

	// No pools configured → warn (built-in default, no failover).
	noPools := run(config.Config{})
	if noPools.Status != StatusWarn {
		t.Errorf("no pools: status = %v, want StatusWarn", noPools.Status)
	}
	if !strings.Contains(noPools.Detail, "default") {
		t.Errorf("no pools: detail = %q, want 'default' substring", noPools.Detail)
	}

	// Single pool → warn (no failover).
	onePool := run(config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+tcp://pool.example.com:3333"},
		},
	})
	if onePool.Status != StatusWarn {
		t.Errorf("one pool: status = %v, want StatusWarn", onePool.Status)
	}
	if !strings.Contains(onePool.Detail, "one pool") {
		t.Errorf("one pool: detail = %q, want 'one pool' substring", onePool.Detail)
	}

	// Two pools → pass.
	twoPools := run(config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+tcp://pool1.example.com:3333"},
			{URL: "stratum+tcp://pool2.example.com:3333"},
		},
	})
	if twoPools.Status != StatusPass {
		t.Errorf("two pools: status = %v, want StatusPass", twoPools.Status)
	}
	if !strings.Contains(twoPools.Detail, "2 pools") {
		t.Errorf("two pools: detail = %q, want '2 pools' substring", twoPools.Detail)
	}
}

func TestCheckPoolEndpointDiversity(t *testing.T) {
	ctx := context.Background()

	// Swap in a deterministic resolver for the duration of the test.
	orig := poolIPResolver
	t.Cleanup(func() { poolIPResolver = orig })

	twoPools := config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+tcp://pool1.example.com:3333"},
			{URL: "stratum+tcp://pool2.example.com:3333"},
		},
	}

	// Fewer than two pools → Skip (nothing to compare).
	poolIPResolver = func(_ context.Context, _ string) ([]string, error) {
		return []string{"203.0.113.1"}, nil
	}
	one := checkPoolEndpointDiversity(config.Config{
		Pools: []config.PoolConfig{{URL: "stratum+tcp://only.example.com:3333"}},
	}).Run(ctx)
	if one.Status != StatusSkip {
		t.Errorf("one pool: status = %v, want StatusSkip", one.Status)
	}

	// Two pools, distinct endpoints → Pass.
	poolIPResolver = func(_ context.Context, host string) ([]string, error) {
		if strings.HasPrefix(host, "pool1") {
			return []string{"203.0.113.1"}, nil
		}
		return []string{"203.0.113.2"}, nil
	}
	distinct := checkPoolEndpointDiversity(twoPools).Run(ctx)
	if distinct.Status != StatusPass {
		t.Errorf("distinct endpoints: status = %v, want StatusPass (detail: %s)", distinct.Status, distinct.Detail)
	}

	// Two pools sharing an endpoint → Warn (illusory failover).
	poolIPResolver = func(_ context.Context, _ string) ([]string, error) {
		return []string{"203.0.113.7"}, nil
	}
	shared := checkPoolEndpointDiversity(twoPools).Run(ctx)
	if shared.Status != StatusWarn {
		t.Errorf("shared endpoint: status = %v, want StatusWarn", shared.Status)
	}
	if !strings.Contains(shared.Detail, "203.0.113.7") || !strings.Contains(shared.Detail, "illusory") {
		t.Errorf("shared endpoint: detail = %q, want shared IP + 'illusory'", shared.Detail)
	}

	// All pools unresolvable → Skip (not enough data to judge).
	poolIPResolver = func(_ context.Context, _ string) ([]string, error) {
		return nil, fmt.Errorf("no such host")
	}
	unresolved := checkPoolEndpointDiversity(twoPools).Run(ctx)
	if unresolved.Status != StatusSkip {
		t.Errorf("unresolvable: status = %v, want StatusSkip", unresolved.Status)
	}

	// Only one of two resolves → Skip (resolved < 2).
	poolIPResolver = func(_ context.Context, host string) ([]string, error) {
		if strings.HasPrefix(host, "pool1") {
			return []string{"203.0.113.1"}, nil
		}
		return nil, fmt.Errorf("no such host")
	}
	partial := checkPoolEndpointDiversity(twoPools).Run(ctx)
	if partial.Status != StatusSkip {
		t.Errorf("partial resolve: status = %v, want StatusSkip", partial.Status)
	}
}

// ============================================================================
// checkClockSkew — live clock accuracy check (session 136)
// ============================================================================

func TestCheckClockSkew_AccurateDatePasses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = srv.Client()

	result := checkClockSkew().Run(context.Background())
	if result.Status != StatusPass {
		t.Errorf("accurate Date header: status = %v, want Pass (detail: %s)", result.Status, result.Detail)
	}
}

// TestCheckClockSkew_DrainsBodyForConnectionReuse verifies that checkClockSkew
// drains the response body before closing it, so the keep-alive connection is
// returned to the pool and reused. The check needs only the Date header, but an
// undrained body makes net/http abandon the connection (and under HTTP/2 emit a
// spurious RST_STREAM). We assert reuse by counting how many connections the
// server sees across two sequential probes over the same client: with the body
// drained, the second probe reuses the first connection (exactly one StateNew).
func TestCheckClockSkew_DrainsBodyForConnectionReuse(t *testing.T) {
	var mu sync.Mutex
	newConns := 0
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
		// A non-trivial body: if checkClockSkew closes without draining it,
		// the HTTP/1.1 keep-alive connection cannot be reused.
		_, _ = w.Write([]byte(strings.Repeat("x", 1024)))
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			mu.Lock()
			newConns++
			mu.Unlock()
		}
	}
	srv.Start()
	defer srv.Close()

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = srv.Client()

	for i := 0; i < 2; i++ {
		if r := checkClockSkew().Run(context.Background()); r.Status != StatusPass {
			t.Fatalf("probe %d: status = %v, want Pass (detail: %s)", i, r.Status, r.Detail)
		}
	}

	mu.Lock()
	got := newConns
	mu.Unlock()
	if got != 1 {
		t.Errorf("server saw %d new connections across 2 probes; body not drained for keep-alive reuse (want 1)", got)
	}
}

func TestCheckClockSkew_LargeSkewWarns(t *testing.T) {
	const skewSecs = 180 // > clockSkewWarnSecs (120) but < clockSkewFailSecs (300)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		past := time.Now().Add(-skewSecs * time.Second).UTC()
		w.Header().Set("Date", past.Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = srv.Client()

	result := checkClockSkew().Run(context.Background())
	if result.Status != StatusWarn {
		t.Errorf("skew=%ds: status = %v, want Warn", skewSecs, result.Status)
	}
}

func TestCheckClockSkew_VeryLargeSkewFails(t *testing.T) {
	const skewSecs = 400 // > clockSkewFailSecs (300)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		past := time.Now().Add(-skewSecs * time.Second).UTC()
		w.Header().Set("Date", past.Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = srv.Client()

	result := checkClockSkew().Run(context.Background())
	if result.Status != StatusFail {
		t.Errorf("skew=%ds: status = %v, want Fail", skewSecs, result.Status)
	}
}

func TestCheckClockSkew_NetworkErrorWarns(t *testing.T) {
	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	// Point at a closed server — the request will fail immediately.
	clockSkewProbeURL = "http://127.0.0.1:1"
	clockSkewHTTPClient = &http.Client{Timeout: 100 * time.Millisecond}

	result := checkClockSkew().Run(context.Background())
	if result.Status != StatusWarn {
		t.Errorf("unreachable endpoint: status = %v, want Warn", result.Status)
	}
	if !strings.Contains(result.Fix, "internet connectivity") {
		t.Errorf("fix = %q, want it to mention internet connectivity", result.Fix)
	}
}

func TestCheckClockSkew_MissingDateHeaderWarns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Suppress the automatic Date header by deleting it before writing.
		w.Header()["Date"] = nil
		// We must write something to trigger the header flush, but httptest
		// may still add Date. Use a custom ResponseWriter approach: just set
		// content-length and write directly.
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Use a transport that strips the Date header from responses.
	inner := srv.Client().Transport
	if inner == nil {
		inner = http.DefaultTransport
	}
	strippedClient := &http.Client{
		Transport: &stripDateRoundTripper{inner: inner},
	}

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = strippedClient

	result := checkClockSkew().Run(context.Background())
	if result.Status != StatusWarn {
		t.Errorf("missing Date header: status = %v, want Warn", result.Status)
	}
}

// stripDateRoundTripper removes the Date header from HTTP responses.
type stripDateRoundTripper struct{ inner http.RoundTripper }

func (t *stripDateRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.inner.RoundTrip(req)
	if resp != nil {
		resp.Header.Del("Date")
	}
	return resp, err
}

func TestDefaultChecks_IncludesClockSkewCheck(t *testing.T) {
	checks := DefaultChecks(config.Config{}, "")
	for _, c := range checks {
		if c.Name == "System clock accuracy" {
			return
		}
	}
	t.Error("DefaultChecks does not include 'System clock accuracy' check")
}

func TestCheckEnvVars_PassesWhenAllValid(t *testing.T) {
	// No malformed OTEDAMA_* vars set → Pass. (t.Setenv ensures isolation and
	// restores the prior environment after the test.)
	t.Setenv("OTEDAMA_POWER_WATTS", "300")
	t.Setenv("OTEDAMA_ELECTRICITY_PRICE_PER_KWH", "0.12")
	res := checkEnvVars().Run(context.Background())
	if res.Status != StatusPass {
		t.Errorf("status = %v, want Pass (detail: %s)", res.Status, res.Detail)
	}
}

func TestCheckEnvVars_WarnsOnMalformed(t *testing.T) {
	t.Setenv("OTEDAMA_POWER_WATTS", "300w") // unit-suffix typo
	res := checkEnvVars().Run(context.Background())
	if res.Status != StatusWarn {
		t.Fatalf("status = %v, want Warn", res.Status)
	}
	if !strings.Contains(res.Detail, "OTEDAMA_POWER_WATTS") {
		t.Errorf("detail should name the offending var: %q", res.Detail)
	}
	if res.Fix == "" {
		t.Error("a Warn result should carry a Fix hint")
	}
}

func TestDefaultChecks_IncludesEnvVarsCheck(t *testing.T) {
	checks := DefaultChecks(config.Config{}, "")
	for _, c := range checks {
		if c.Name == "Environment variables" {
			return
		}
	}
	t.Error("DefaultChecks does not include 'Environment variables' check")
}

// ============================================================================
// addressKind — default ("unrecognized type") branch (session 162)
// ============================================================================

// TestAddressKind_UnknownAddress covers the default branch of addressKind:
// any address that ClassifyAddress does not recognize (not starting with
// "bc1p", "bc1q", "1", or "3") returns "unrecognized type".
func TestAddressKind_UnknownAddress(t *testing.T) {
	got := addressKind("garbage-address-format")
	if got != "unrecognized type" {
		t.Errorf("addressKind(garbage) = %q, want \"unrecognized type\"", got)
	}
}

// TestAddressKind_KnownP2WPKH verifies the P2WPKH branch is correctly labeled
// (regression: ensures the switch-case isn't accidentally removed).
func TestAddressKind_KnownP2WPKH(t *testing.T) {
	got := addressKind("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")
	if got != "P2WPKH SegWit v0" {
		t.Errorf("addressKind(P2WPKH) = %q, want \"P2WPKH SegWit v0\"", got)
	}
}

// ============================================================================
// appendUnique — duplicate-suppression path (session 162)
// ============================================================================

// TestAppendUnique_DuplicateNotAppended covers the early-return path in
// appendUnique: when the element is already present the slice is returned
// unchanged (same length, no allocation).
func TestAppendUnique_DuplicateNotAppended(t *testing.T) {
	xs := []string{"a", "b", "c"}
	got := appendUnique(xs, "b")
	if len(got) != 3 {
		t.Errorf("appendUnique(duplicate) len = %d, want 3 (unchanged)", len(got))
	}
	if &got[0] != &xs[0] {
		t.Error("appendUnique(duplicate) returned a new slice; expected the original")
	}
}

// TestAppendUnique_NewElementAppended verifies that a genuinely new element
// is appended (happy path, complementary to the duplicate test).
func TestAppendUnique_NewElementAppended(t *testing.T) {
	xs := []string{"a", "b"}
	got := appendUnique(xs, "c")
	if len(got) != 3 || got[2] != "c" {
		t.Errorf("appendUnique(new) = %v, want [a b c]", got)
	}
}

// ============================================================================
// session 171 — doctor uncovered branches: addressKind P2WSH, checkDataDir /
// checkWallet stat-error and no-home paths, pool-endpoint/payout empty-host,
// checkClockSkew malformed-Date.
// ============================================================================

// TestAddressKind_KnownP2WSH covers the P2WSH branch of addressKind
// (checks.go:133-134): a bc1q address of length >= 60 classifies as P2WSH.
func TestAddressKind_KnownP2WSH(t *testing.T) {
	// A 62-character bc1q... address: ClassifyAddress returns AddressP2WSH
	// for any witness-v0 address with a 32-byte program.
	addr := "bc1q" + strings.Repeat("q", 58)
	got := addressKind(addr)
	if got != "P2WSH SegWit v0" {
		t.Errorf("addressKind(P2WSH) = %q, want %q", got, "P2WSH SegWit v0")
	}
}

// TestCheckDataDir_StatErrorNotNotExist_Fails covers checks.go:200-206 —
// os.Stat returns an error that is NOT os.IsNotExist (ENOTDIR) when a path
// component is a regular file. The check must report Fail "cannot stat".
func TestCheckDataDir_StatErrorNotNotExist_Fails(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "blocker")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	f.Close()
	// A path *under* a regular file: os.Stat returns ENOTDIR, not ENOENT.
	dir := filepath.Join(f.Name(), "sub")
	r := checkDataDir(dir).Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("stat-under-file: status = %v, want Fail (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, "cannot stat") {
		t.Errorf("detail should mention 'cannot stat': %q", r.Detail)
	}
}

// TestCheckWallet_StatErrorNotNotExist_Fails covers checks.go:265-271 —
// os.Stat on the wallet path returns ENOTDIR (path under a regular file),
// which is neither IsNotExist nor nil, so the check reports Fail.
func TestCheckWallet_StatErrorNotNotExist_Fails(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "blocker")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	f.Close()
	// dataDir under a regular file → walletPath stat returns ENOTDIR.
	dir := filepath.Join(f.Name(), "sub")
	r := checkWallet(dir).Run(context.Background())
	if r.Status != StatusFail {
		t.Errorf("stat-under-file: status = %v, want Fail (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, "cannot stat") {
		t.Errorf("detail should mention 'cannot stat': %q", r.Detail)
	}
}

// TestCheckDataDir_NoHome_Skips covers checks.go:187-189 — when dir is empty
// and os.UserHomeDir fails (HOME unset), the check skips. On non-Linux the
// home lookup may use other sources, so this is gated to Linux.
func TestCheckDataDir_NoHome_Skips(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("UserHomeDir error path is HOME-driven only on Linux")
	}
	t.Setenv("HOME", "")
	r := checkDataDir("").Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("no-home checkDataDir: status = %v, want Skip (detail: %s)", r.Status, r.Detail)
	}
}

// TestCheckWallet_NoHome_Skips covers checks.go:252-254 — empty dataDir with
// HOME unset makes os.UserHomeDir fail, so the wallet check skips.
func TestCheckWallet_NoHome_Skips(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("UserHomeDir error path is HOME-driven only on Linux")
	}
	t.Setenv("HOME", "")
	r := checkWallet("").Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("no-home checkWallet: status = %v, want Skip (detail: %s)", r.Status, r.Detail)
	}
}

// TestCheckPoolEndpointDiversity_EmptyHostSkipped covers checks.go:397-398 —
// a pool URL with no recognized scheme yields an empty host from stripScheme,
// which is skipped (continue). With only one resolvable host, the check
// returns Skip ("could not resolve enough pool endpoints").
func TestCheckPoolEndpointDiversity_EmptyHostSkipped(t *testing.T) {
	orig := poolIPResolver
	t.Cleanup(func() { poolIPResolver = orig })
	poolIPResolver = func(_ context.Context, _ string) ([]string, error) {
		return []string{"203.0.113.1"}, nil
	}
	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: "stratum+tcp://good.example.com:3333"},
			{URL: "http://bad.example.com"}, // unrecognized scheme → host "" → skipped
		},
	}
	r := checkPoolEndpointDiversity(cfg).Run(context.Background())
	if r.Status != StatusSkip {
		t.Errorf("empty-host pool: status = %v, want Skip (detail: %s)", r.Status, r.Detail)
	}
}

// TestCheckPayoutScheme_EmptyHostUsesURL covers checks.go:620-622 —
// a pool URL with no recognized scheme makes stripScheme return "", so the
// check falls back to using the raw URL string as the host label.
func TestCheckPayoutScheme_EmptyHostUsesURL(t *testing.T) {
	const rawURL = "noscheme-host:3333"
	cfg := config.Config{
		Pools: []config.PoolConfig{
			{URL: rawURL, PayoutScheme: "fpps"},
		},
	}
	r := checkPayoutScheme(cfg).Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("empty-host payout: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, rawURL) {
		t.Errorf("detail should fall back to the raw URL %q: %q", rawURL, r.Detail)
	}
}

// TestCheckClockSkew_MalformedDateWarns covers checks.go:765-771 —
// the probe server returns a Date header that http.ParseTime cannot parse,
// so the check warns rather than reporting a bogus skew.
func TestCheckClockSkew_MalformedDateWarns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// An explicitly-set Date header is preserved by net/http (it only
		// auto-fills Date when absent). Garbage here forces a ParseTime error.
		w.Header().Set("Date", "not-a-valid-http-date")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = srv.Client()

	r := checkClockSkew().Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("malformed Date: status = %v, want Warn (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, "cannot parse server Date header") {
		t.Errorf("detail should mention the parse failure: %q", r.Detail)
	}
}

// TestPoolIPResolver_DefaultResolvesIPLiteral covers checks.go:365-370 —
// the package-default poolIPResolver. Given an IP literal with a port it must
// strip the port and resolve the literal without performing real DNS (the Go
// resolver short-circuits IP literals), so this is offline-safe.
func TestPoolIPResolver_DefaultResolvesIPLiteral(t *testing.T) {
	ips, err := poolIPResolver(context.Background(), "127.0.0.1:3333")
	if err != nil {
		t.Fatalf("default poolIPResolver on IP literal: %v", err)
	}
	var found bool
	for _, ip := range ips {
		if ip == "127.0.0.1" {
			found = true
		}
	}
	if !found {
		t.Errorf("default poolIPResolver(127.0.0.1:3333) = %v, want to contain 127.0.0.1", ips)
	}
}

// TestCheckClockSkew_RequestBuildError covers checks.go:733-739 —
// a probe URL containing a control character makes http.NewRequestWithContext
// fail before any network call, and the check warns with an internal-error note.
func TestCheckClockSkew_RequestBuildError(t *testing.T) {
	origURL := clockSkewProbeURL
	t.Cleanup(func() { clockSkewProbeURL = origURL })
	clockSkewProbeURL = "http://\x7f-control-char" // invalid: control char in URL

	r := checkClockSkew().Run(context.Background())
	if r.Status != StatusWarn {
		t.Errorf("request-build error: status = %v, want Warn (detail: %s)", r.Status, r.Detail)
	}
	if !strings.Contains(r.Detail, "could not build request") {
		t.Errorf("detail should mention the build failure: %q", r.Detail)
	}
}

// TestCheckClockSkew_NilClientUsesDefault covers checks.go:743-745 —
// when clockSkewHTTPClient is nil the check falls back to http.DefaultClient,
// which can still reach a local httptest server (no external network needed).
func TestCheckClockSkew_NilClientUsesDefault(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	origURL := clockSkewProbeURL
	origClient := clockSkewHTTPClient
	t.Cleanup(func() {
		clockSkewProbeURL = origURL
		clockSkewHTTPClient = origClient
	})
	clockSkewProbeURL = srv.URL
	clockSkewHTTPClient = nil // force the http.DefaultClient fallback branch

	r := checkClockSkew().Run(context.Background())
	if r.Status != StatusPass {
		t.Errorf("nil-client accurate clock: status = %v, want Pass (detail: %s)", r.Status, r.Detail)
	}
}
