// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.

package tui

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// ----- formatHashRate -----

func TestFormatHashRate(t *testing.T) {
	tests := []struct {
		hps  float64
		want string
	}{
		{500, "500 H/s"},
		{1500, "1.50 kH/s"},
		{2.5e6, "2.50 MH/s"},
		{3.7e9, "3.70 GH/s"},
		{120e12, "120.00 TH/s"},
		{0, "0 H/s"},
	}
	for _, tt := range tests {
		got := FormatHashRate(tt.hps)
		if got != tt.want {
			t.Errorf("FormatHashRate(%g) = %q, want %q", tt.hps, got, tt.want)
		}
	}
}

// ----- formatDuration -----

func TestFormatDuration(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{5 * time.Second, "5s"},
		{90 * time.Second, "1m 30s"},
		{3661 * time.Second, "1h 1m 1s"},
	}
	for _, tt := range tests {
		got := FormatDuration(tt.d)
		if got != tt.want {
			t.Errorf("FormatDuration(%v) = %q, want %q", tt.d, got, tt.want)
		}
	}
}

// ----- visibleLen -----

func TestVisibleLen_PlainText(t *testing.T) {
	if got := visibleLen("hello"); got != 5 {
		t.Errorf("visibleLen(\"hello\") = %d, want 5", got)
	}
}

func TestVisibleLen_ANSIStripped(t *testing.T) {
	// "\x1b[32mOK\x1b[0m" is "OK" visually (2 chars)
	s := "\x1b[32mOK\x1b[0m"
	if got := visibleLen(s); got != 2 {
		t.Errorf("visibleLen(%q) = %d, want 2", s, got)
	}
}

func TestVisibleLen_Empty(t *testing.T) {
	if got := visibleLen(""); got != 0 {
		t.Errorf("visibleLen(\"\") = %d, want 0", got)
	}
}

func TestVisibleLen_BoldCyanText(t *testing.T) {
	s := "\x1b[1m\x1b[36mOtedama\x1b[0m"
	if got := visibleLen(s); got != len("Otedama") {
		t.Errorf("visibleLen(%q) = %d, want %d", s, got, len("Otedama"))
	}
}

// ----- SatsToDisplay -----

func TestSatsToDisplay(t *testing.T) {
	tests := []struct {
		sats uint64
		want string
	}{
		{0, "0 sats"},
		{100, "100 sats"},
		{1500, "1500 sats (0.00002 BTC)"},
		{100_000_000, "1.0000 BTC"},
		{250_000_000, "2.5000 BTC"},
	}
	for _, tt := range tests {
		got := SatsToDisplay(tt.sats)
		if !strings.Contains(got, strings.Split(tt.want, " ")[0]) {
			t.Errorf("SatsToDisplay(%d) = %q, want to contain %q", tt.sats, got, tt.want)
		}
	}
}

// ----- Dashboard renders without panic -----

func TestDashboard_RenderDoesNotPanic(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.SetWidth(100)

	s := Stats{
		HashRate:          2.5e6,
		SharesFound:       42,
		SharesSent:        40,
		PoolURL:           "stratum+v2://pool.example.com:3336",
		Connected:         true,
		PoolLatency:       15 * time.Millisecond,
		EstSatsEarned:     1500,
		WalletFingerprint: "aabbccdd",
		Uptime:            2*time.Hour + 15*time.Minute,
		Devices:           2,
		Providers: []ProviderStats{
			{Name: "Bitcoin Mining", SatsPerSecond: 0.001, Active: true},
			{Name: "AI Inference (Akash)", SatsPerSecond: 1.46, Active: false},
		},
	}

	// render should not panic even with empty/nil fields.
	d.render(s)

	output := buf.String()
	if !strings.Contains(output, "2.50 MH/s") {
		t.Errorf("output missing hash rate; got %q", output)
	}
	if !strings.Contains(output, "pool.example.com") {
		t.Errorf("output missing pool URL; got %q", output)
	}
	if !strings.Contains(output, "aabbccdd") {
		t.Errorf("output missing wallet fingerprint; got %q", output)
	}
}

func TestDashboard_MiningLine_IdleDevicesShown(t *testing.T) {
	// When the min_yield_sats_per_sec floor idles some devices, the count must
	// appear in the MINING line so TUI-only operators see it without Prometheus.
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.SetWidth(120)
	d.render(Stats{
		HashRate:    1e9,
		Devices:     4,
		DevicesIdle: 2,
		Connected:   true,
	})
	out := buf.String()
	if !strings.Contains(out, "2 idle") {
		t.Errorf("render with DevicesIdle=2 must contain '2 idle'; output:\n%s", out)
	}
	// The total device count must still be present.
	if !strings.Contains(out, "4 device(s)") {
		t.Errorf("render must still show total device count; output:\n%s", out)
	}
}

func TestDashboard_MiningLine_NoIdleWhenZero(t *testing.T) {
	// With DevicesIdle = 0, the "N idle" annotation must not appear.
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.SetWidth(120)
	d.render(Stats{HashRate: 1e9, Devices: 4, Connected: true})
	out := buf.String()
	if strings.Contains(out, "idle") {
		t.Errorf("render with DevicesIdle=0 must not contain 'idle'; output:\n%s", out)
	}
}

func TestDashboard_RenderZeroState(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.render(Stats{}) // must not panic even with zero-value Stats
}

func TestDashboard_SetWidth_MinimumEnforced(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.SetWidth(10) // below minimum 40 — should be ignored
	if d.cols != 80 {
		t.Errorf("cols = %d after invalid SetWidth(10), want 80", d.cols)
	}
	d.SetWidth(100) // valid
	if d.cols != 100 {
		t.Errorf("cols = %d after SetWidth(100), want 100", d.cols)
	}
}

func TestDashboard_Update_NonBlocking(t *testing.T) {
	var buf bytes.Buffer
	d := NewDashboard(&buf)

	// Fill the channel buffer.
	for i := 0; i < 20; i++ {
		d.Update(Stats{HashRate: float64(i)})
	}
	// None of the above calls must block or panic.
}

func TestDashboard_ShortenURL(t *testing.T) {
	tests := []struct {
		url    string
		maxLen int
		want   string
	}{
		{"stratum+v2://pool.example.com:3336", 80, "stratum+v2://pool.example.com:3336"},
		{"stratum+v2://very.long.pool.hostname.example.com:3336", 30, "stratum+v2://very.long.pool.ho..."},
	}
	for _, tt := range tests {
		got := shortenURL(tt.url, tt.maxLen)
		if len(tt.url) <= tt.maxLen {
			if got != tt.url {
				t.Errorf("shortenURL(%q, %d) = %q, want unchanged", tt.url, tt.maxLen, got)
			}
		} else {
			if len(got) != tt.maxLen {
				t.Errorf("shortenURL len = %d, want %d", len(got), tt.maxLen)
			}
			if !strings.HasSuffix(got, "...") {
				t.Errorf("shortened URL must end with '...': %q", got)
			}
		}
	}
}

// ----- Dashboard.footer — gap clamp (session 166) -----

func TestDashboard_Footer_GapClampedAtMinimum(t *testing.T) {
	// 1_000_000 h produces "  uptime: 1000000h 0m 0s" (24 visible chars).
	// At the minimum valid width of 40 cols: gap = 40 - 24 - 14 - 2 = 0,
	// which triggers the gap < 1 clamp branch.
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.SetWidth(40)
	d.render(Stats{Uptime: 1_000_000 * time.Hour})
	if !strings.Contains(buf.String(), "uptime:") {
		t.Error("footer must contain 'uptime:' even when gap is clamped to 1")
	}
}

// ----- Dashboard.renderLoop — updateCh and ticker branches (session 166) -----

func TestDashboard_RenderLoop_UpdateAndTick(t *testing.T) {
	if testing.Short() {
		t.Skip("renderLoop timing test requires ~1.1 s; skipped in short mode")
	}
	var buf bytes.Buffer
	d := NewDashboard(&buf)
	d.Start()

	// Deliver stats updates so renderLoop drains updateCh (lines 156-159).
	for i := 0; i < 3; i++ {
		d.Update(Stats{HashRate: 1.5e6, Connected: true, Devices: 1})
		time.Sleep(10 * time.Millisecond)
	}

	// Wait for the ticker (time.Second interval) to fire at least once,
	// triggering the ticker case (lines 160-164) which calls d.render.
	time.Sleep(1100 * time.Millisecond)

	d.Stop()

	if !strings.Contains(buf.String(), "1.50 MH/s") {
		t.Error("expected rendered hashrate in output after ticker fired")
	}
}
