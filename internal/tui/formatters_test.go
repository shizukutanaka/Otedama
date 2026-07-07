// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package tui

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// ============================================================================
// padRight
// ============================================================================

func TestPadRight_PlainText(t *testing.T) {
	got := padRight("hello", 10)
	if got != "hello     " {
		t.Errorf("padRight(\"hello\", 10) = %q", got)
	}
	if visibleLen(got) != 10 {
		t.Errorf("padded visibleLen = %d, want 10", visibleLen(got))
	}
}

func TestPadRight_ShorterWidth(t *testing.T) {
	// If width is shorter than the input, padRight returns the input unchanged.
	got := padRight("hello", 3)
	if got != "hello" {
		t.Errorf("padRight shorter width should return original: got %q", got)
	}
}

func TestPadRight_ANSISequencesIgnoredForWidth(t *testing.T) {
	// Colored text should pad based on visible length, not byte length.
	colored := "\x1b[32mHI\x1b[0m" // 2 visible chars
	got := padRight(colored, 5)
	if visibleLen(got) != 5 {
		t.Errorf("padded visibleLen = %d, want 5", visibleLen(got))
	}
}

func TestPadRight_EmptyInput(t *testing.T) {
	got := padRight("", 4)
	if got != "    " {
		t.Errorf("padRight empty input: got %q, want 4 spaces", got)
	}
}

// ============================================================================
// shortenURL — edge cases
// ============================================================================

func TestShortenURL_ExactMaxLength(t *testing.T) {
	url := "0123456789"
	if got := shortenURL(url, 10); got != url {
		t.Errorf("url equal to maxLen should be unchanged: %q", got)
	}
}

func TestShortenURL_OneOver(t *testing.T) {
	url := "0123456789X"
	got := shortenURL(url, 10)
	if len(got) != 10 {
		t.Errorf("len = %d, want 10", len(got))
	}
	if !strings.HasSuffix(got, "...") {
		t.Errorf("%q should end with ...", got)
	}
}

func TestShortenURL_VeryShort(t *testing.T) {
	url := "abc"
	got := shortenURL(url, 10)
	if got != "abc" {
		t.Errorf("short url should be unchanged: %q", got)
	}
}

func TestShortenURL_MaxLenTooSmall(t *testing.T) {
	// maxLen < 4 would produce a negative slice index (maxLen-3 < 0).
	// shortenURL must return the original URL rather than panic.
	url := "https://pool.example.com"
	for _, max := range []int{0, 1, 2, 3} {
		got := shortenURL(url, max)
		if got != url {
			t.Errorf("shortenURL(url, %d) = %q, want original url", max, got)
		}
	}
}

// ============================================================================
// defaultSatsPerHash
// ============================================================================

func TestDefaultSatsPerHash_IsPositiveAndTiny(t *testing.T) {
	// This value represents the expected sats earned per hash at current
	// network difficulty. It should be positive but vanishingly small
	// (CPU mining earns virtually nothing in 2026).
	v := defaultSatsPerHash()
	if v <= 0 {
		t.Errorf("defaultSatsPerHash() = %v, want > 0", v)
	}
	if v >= 1e-10 {
		t.Errorf("defaultSatsPerHash() = %v, should be tiny (< 1e-10)", v)
	}
}

// ============================================================================
// Dashboard section rendering — each section produces non-empty output
// ============================================================================

func TestDashboard_PoolLineWhenDisconnected(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.poolLine(Stats{
		PoolURL:   "stratum+v2://example.com:3336",
		Connected: false,
	})
	if !strings.Contains(line, "disconnected") {
		t.Errorf("disconnected pool line missing 'disconnected': %q", line)
	}
}

func TestDashboard_PoolLineWhenConnected(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.poolLine(Stats{
		PoolURL:     "stratum+v2://example.com:3336",
		Connected:   true,
		PoolLatency: 42 * time.Millisecond,
	})
	if !strings.Contains(line, "connected") {
		t.Errorf("connected line missing 'connected': %q", line)
	}
	if !strings.Contains(line, "42ms") {
		t.Errorf("connected line missing latency '42ms': %q", line)
	}
}

func TestDashboard_WalletLine_WithFingerprint(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.walletLine(Stats{WalletFingerprint: "a1b2c3d4"})
	if !strings.Contains(line, "a1b2c3d4") {
		t.Errorf("walletLine missing fingerprint: %q", line)
	}
}

func TestDashboard_WalletLine_NotInitialized(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.walletLine(Stats{WalletFingerprint: ""})
	if !strings.Contains(line, "not initialized") {
		t.Errorf("empty fingerprint must show 'not initialized': %q", line)
	}
}

func TestDashboard_MiningLine_IncludesRateAndDevices(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.miningLine(Stats{
		HashRate: 2.5e6, Devices: 3, SharesFound: 42, SharesSent: 40,
	})
	if !strings.Contains(line, "2.50 MH/s") {
		t.Errorf("miningLine missing hashrate: %q", line)
	}
	if !strings.Contains(line, "3 device") {
		t.Errorf("miningLine missing device count: %q", line)
	}
	if !strings.Contains(line, "42") {
		t.Errorf("miningLine missing shares found: %q", line)
	}
}

func TestDashboard_MiningLine_StalledIndicator(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.miningLine(Stats{
		HashRate: 0, Devices: 1, Stalled: true,
	})
	if !strings.Contains(line, "stalled") {
		t.Errorf("miningLine with Stalled=true missing stall indicator: %q", line)
	}
}

func TestDashboard_MiningLine_NoStalledIndicatorWhenFalse(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.miningLine(Stats{
		HashRate: 1e9, Devices: 2, Stalled: false,
	})
	if strings.Contains(line, "stalled") {
		t.Errorf("miningLine with Stalled=false should not show stall indicator: %q", line)
	}
}

func TestDashboard_MiningLine_CurtailedShowsPausedNotStalled(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.miningLine(Stats{
		HashRate: 0, Devices: 1, Curtailed: true,
	})
	if !strings.Contains(line, "paused") {
		t.Errorf("miningLine with Curtailed=true missing paused indicator: %q", line)
	}
	// A deliberate pause must NOT be rendered as a fault stall.
	if strings.Contains(line, "stalled") {
		t.Errorf("curtailed miningLine must not show 'stalled' (it is not a fault): %q", line)
	}
}

func TestDashboard_MiningLine_CurtailedTakesPriorityOverStalled(t *testing.T) {
	// If both flags were ever set, curtailment (deliberate) is the explanation
	// shown — never the misleading fault badge.
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.miningLine(Stats{
		HashRate: 0, Devices: 1, Curtailed: true, Stalled: true,
	})
	if !strings.Contains(line, "paused") {
		t.Errorf("curtailed+stalled miningLine should show paused: %q", line)
	}
	if strings.Contains(line, "stalled") {
		t.Errorf("curtailed+stalled miningLine must not show stalled: %q", line)
	}
}

func TestDashboard_EarningsLine_PositiveRate(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.earningsLine(Stats{
		HashRate:      1e9, // 1 GH/s
		EstSatsEarned: 1234,
	})
	if !strings.Contains(line, "sats/day") {
		t.Errorf("earningsLine missing sats/day: %q", line)
	}
	if !strings.Contains(line, "1234") {
		t.Errorf("earningsLine missing total: %q", line)
	}
}

func TestDashboard_EarningsLine_IncludesProviders(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	line := d.earningsLine(Stats{
		HashRate: 1e6,
		Providers: []ProviderStats{
			{Name: "akash", SatsPerSecond: 1000, Active: true},
		},
	})
	// Active AI inference should boost the sats/day significantly.
	if !strings.Contains(line, "sats/day") {
		t.Errorf("earningsLine missing sats/day: %q", line)
	}
}

func TestDashboard_ProviderLine_ActiveVsIdle(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	active := d.providerLine(ProviderStats{Name: "akash", SatsPerSecond: 100, Active: true})
	idle := d.providerLine(ProviderStats{Name: "akash", SatsPerSecond: 0, Active: false})

	if !strings.Contains(active, "active") {
		t.Errorf("active provider line missing 'active': %q", active)
	}
	if !strings.Contains(idle, "idle") {
		t.Errorf("idle provider line missing 'idle': %q", idle)
	}
}

func TestDashboard_Footer_IncludesUptimeAndHint(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.SetWidth(80)
	line := d.footer(Stats{Uptime: 3*time.Hour + 15*time.Minute + 30*time.Second}, 80)
	if !strings.Contains(line, "3h") {
		t.Errorf("footer missing uptime: %q", line)
	}
	if !strings.Contains(line, "Ctrl+C") {
		t.Errorf("footer missing exit hint: %q", line)
	}
}

func TestDashboard_Header_MentionsOtedama(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	h := d.header(80)
	if !strings.Contains(h, "Otedama") {
		t.Errorf("header missing 'Otedama': %q", h)
	}
}

// ============================================================================
// Dashboard lifecycle
// ============================================================================

func TestDashboard_DoubleStart_SecondIsNoop(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.Start()
	// A second Start must not panic, not duplicate the goroutine.
	d.Start()
	d.Stop()
}

func TestDashboard_StopWithoutStart_IsSafe(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	// Stop before Start must be a no-op (never panic, never block).
	// This is important because Otedama's main.go always defers Stop
	// after creating a Dashboard, even when --no-tui is set and Start
	// is skipped.
	done := make(chan struct{})
	go func() {
		d.Stop()
		close(done)
	}()
	select {
	case <-done:
		// OK
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Stop without Start blocked")
	}
}

func TestDashboard_DoubleStop_IsSafe(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.Start()
	d.Stop()
	// A second Stop must not panic even though doneCh is already closed.
	done := make(chan struct{})
	go func() {
		d.Stop()
		close(done)
	}()
	select {
	case <-done:
		// OK
	case <-time.After(100 * time.Millisecond):
		t.Fatal("second Stop blocked")
	}
}

// TestDashboard_StopDoesNotRaceRenderLoop pins the fix for a genuine data
// race: Stop() used to close doneCh and immediately write to w itself
// (showCursor/Fprintln) without waiting for a concurrently in-flight
// render() call — started by the ticker case in renderLoop — to finish
// its own writes to the same io.Writer first. Driving ticks right up to
// the moment Stop is called maximizes the chance of catching the race
// under `go test -race`.
func TestDashboard_StopDoesNotRaceRenderLoop(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.Start()
	for i := 0; i < 5; i++ {
		d.Update(Stats{HashRate: float64(i) * 1e6, Devices: 1})
		time.Sleep(2 * time.Millisecond)
	}
	d.Stop() // must not race renderLoop's writes to buf
}

// ============================================================================
// FormatHashRate — boundary cases
// ============================================================================

func TestFormatHashRate_ExactThresholds(t *testing.T) {
	tests := []struct {
		hps  float64
		want string
	}{
		{999, "999 H/s"},
		{1000, "1.00 kH/s"},
		{999_999, "1000.00 kH/s"},
		{1_000_000, "1.00 MH/s"},
		{999_999_999, "1000.00 MH/s"},
		{1_000_000_000, "1.00 GH/s"},
		{1e12, "1.00 TH/s"},
	}
	for _, tt := range tests {
		if got := FormatHashRate(tt.hps); got != tt.want {
			t.Errorf("FormatHashRate(%g) = %q, want %q", tt.hps, got, tt.want)
		}
	}
}

func TestFormatHashRate_NegativeReturnsHz(t *testing.T) {
	// Negative doesn't make physical sense but the function must not panic.
	got := FormatHashRate(-100)
	if got == "" {
		t.Error("FormatHashRate(-100) returned empty string")
	}
}

// ============================================================================
// FormatDuration — boundary cases
// ============================================================================

func TestFormatDuration_SubSecond(t *testing.T) {
	got := FormatDuration(500 * time.Millisecond)
	if got != "0s" {
		t.Errorf("FormatDuration(500ms) = %q, want 0s", got)
	}
}

func TestFormatDuration_ZeroIsZeroSeconds(t *testing.T) {
	if got := FormatDuration(0); got != "0s" {
		t.Errorf("FormatDuration(0) = %q, want 0s", got)
	}
}

func TestFormatDuration_OverOneDay(t *testing.T) {
	got := FormatDuration(25 * time.Hour)
	// Expected: "25h 0m 0s"
	if !strings.Contains(got, "25h") {
		t.Errorf("25-hour duration = %q, want to contain '25h'", got)
	}
}

// ============================================================================
// SatsToDisplay — edge cases
// ============================================================================

func TestSatsToDisplay_RangeBoundaries(t *testing.T) {
	tests := []struct {
		sats        uint64
		mustContain string
	}{
		{0, "0 sats"},
		{999, "999 sats"},
		{1000, "1000 sats"},
		{99_999_999, "99999999 sats"},
		{100_000_000, "1.0000 BTC"},
		{150_000_000, "1.5000 BTC"},
	}
	for _, tt := range tests {
		got := SatsToDisplay(tt.sats)
		if !strings.Contains(got, tt.mustContain) {
			t.Errorf("SatsToDisplay(%d) = %q, should contain %q",
				tt.sats, got, tt.mustContain)
		}
	}
}

// ============================================================================
// visibleLen — more ANSI sequences
// ============================================================================

func TestVisibleLen_MultipleEscapeSequences(t *testing.T) {
	// Multiple ANSI sequences in sequence.
	s := "\x1b[1m\x1b[31mERROR\x1b[0m: something went \x1b[32mwrong\x1b[0m"
	// Visible: "ERROR: something went wrong" = 27 chars
	want := len("ERROR: something went wrong")
	if got := visibleLen(s); got != want {
		t.Errorf("visibleLen = %d, want %d; input: %q", got, want, s)
	}
}

func TestVisibleLen_NonColorCSITerminator(t *testing.T) {
	// A non-'m' CSI sequence (here "\x1b[2J", clear-screen) must terminate
	// at its final byte 'J' so the trailing visible text is still counted.
	// The old logic only reset on 'm' and would swallow "DONE".
	s := "\x1b[2JDONE"
	if got := visibleLen(s); got != len("DONE") {
		t.Errorf("visibleLen(%q) = %d, want %d", s, got, len("DONE"))
	}
}

func TestVisibleLen_IncompleteEscapeAtEnd(t *testing.T) {
	// An incomplete escape (e.g., a truncation bug) should not crash.
	s := "hello\x1b["
	got := visibleLen(s)
	// The function eats everything after the escape character as part
	// of the escape sequence. We just assert no panic and result ≤ len(s).
	if got < 0 || got > len(s) {
		t.Errorf("visibleLen on truncated escape = %d", got)
	}
}
