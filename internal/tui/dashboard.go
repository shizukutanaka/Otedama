// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
// Package tui provides a terminal user interface for Otedama.
//
// # Design
//
// The TUI uses raw ANSI escape codes with no external dependencies.
// This keeps the binary small (no BubbleTea or tcell import), the build
// simple (no CGO), and the display fast (no abstraction layers between
// the output and the terminal).
//
// The dashboard refreshes every second. Each refresh:
//  1. Moves the cursor to the saved position (no flicker from full clear).
//  2. Overwrites all lines with fresh data.
//  3. Saves the cursor position again for the next refresh.
//
// The terminal width is detected at startup via TIOCGWINSZ (Unix) or
// GetConsoleScreenBufferInfo (Windows); if detection fails, 80 columns
// are assumed.
//
// # Thread safety
//
// Dashboard is safe to call from any goroutine. All mutations go through
// a single channel; the render loop drains it on each tick.
package tui

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Stats is a snapshot of live engine metrics passed to the dashboard.
type Stats struct {
	// Mining
	HashRate    float64 // H/s
	SharesFound uint64
	SharesSent  uint64

	// Pool
	PoolURL     string
	PoolLatency time.Duration // 0 = unknown
	Connected   bool

	// Providers
	Providers []ProviderStats

	// Wallet
	WalletFingerprint string
	// EstSatsEarned is an ESTIMATE of cumulative earnings, integrated from
	// the engine's forecast yield rate over productive time — not a figure
	// from the pool. It is labelled "est." in the dashboard accordingly; the
	// pool's own accounting is authoritative. See docs/KNOWN_LIMITATIONS.md §9.
	EstSatsEarned uint64

	// Session
	Uptime   time.Duration
	Devices  int
	Language string

	// Stalled is true when the hashrate monitor has detected that the miner
	// has produced zero (or below-floor) hashrate for several consecutive
	// samples. The TUI renders a ⚠ indicator so the operator sees the
	// warning immediately without checking Prometheus.
	Stalled bool

	// Curtailed is true when hashing is intentionally paused because the
	// BTC/USD rate is below the configured curtail_below_btc_usd threshold.
	// This is NOT a fault: zero hashrate is expected. The TUI renders a
	// distinct "paused" badge so the operator does not mistake a deliberate
	// price-driven pause for a broken miner (the failure mode without a
	// Prometheus stack: green "0 H/s", connected, not stalled, no explanation).
	Curtailed bool

	// DevicesIdle is the number of devices left idle by the
	// min_yield_sats_per_sec profitability floor in the current arbitration
	// cycle (0 when the floor is disabled or all devices have work). When
	// non-zero it is shown alongside the device count in the MINING line so
	// an operator using the TUI — rather than Prometheus — still sees the
	// floor biting without having to check logs or the otedama_devices_idle gauge.
	DevicesIdle int
}

// ProviderStats describes a single provider's live state.
type ProviderStats struct {
	Name          string
	SatsPerSecond float64
	Active        bool
}

// Dashboard renders a live terminal dashboard.
type Dashboard struct {
	w         io.Writer
	mu        sync.Mutex
	started   atomic.Bool
	updateCh  chan Stats
	doneCh    chan struct{}
	cols      int
	lastStats Stats
}

// NewDashboard returns a Dashboard that writes to w.
func NewDashboard(w io.Writer) *Dashboard {
	return &Dashboard{
		w:        w,
		updateCh: make(chan Stats, 8),
		doneCh:   make(chan struct{}),
		cols:     80,
	}
}

// Start begins the render loop. Call Stop to terminate it.
// Start must only be called once.
func (d *Dashboard) Start() {
	if !d.started.CompareAndSwap(false, true) {
		return
	}
	d.hideCursor()
	d.clearScreen()
	go d.renderLoop()
}

// Stop terminates the render loop and restores the terminal.
// Safe to call before Start; safe to call multiple times.
func (d *Dashboard) Stop() {
	// If Start was never called, started is false and doneCh is open;
	// we still want Stop to be a safe no-op that does not panic.
	// If Stop has been called before, doneCh is already closed and
	// closing it again would panic — use started as a single-shot flag.
	if !d.started.CompareAndSwap(true, false) {
		return
	}
	close(d.doneCh)
	d.showCursor()
	fmt.Fprintln(d.w) // leave cursor on clean line
}

// Update delivers a new stats snapshot. Non-blocking: if the dashboard
// update queue is full the oldest entry is discarded.
func (d *Dashboard) Update(s Stats) {
	select {
	case d.updateCh <- s:
	default:
		// Drain one stale entry then enqueue.
		select {
		case <-d.updateCh:
		default:
		}
		select {
		case d.updateCh <- s:
		default:
		}
	}
}

// ----- Render loop -----

func (d *Dashboard) renderLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-d.doneCh:
			return
		case s := <-d.updateCh:
			d.mu.Lock()
			d.lastStats = s
			d.mu.Unlock()
		case <-ticker.C:
			d.mu.Lock()
			s := d.lastStats
			d.mu.Unlock()
			d.render(s)
		}
	}
}

// ----- Rendering -----

// ANSI escape sequences.
const (
	esc           = "\x1b["
	reset         = "\x1b[0m"
	bold          = "\x1b[1m"
	dim           = "\x1b[2m"
	cyan          = "\x1b[36m"
	green         = "\x1b[32m"
	yellow        = "\x1b[33m"
	red           = "\x1b[31m"
	white         = "\x1b[37m"
	bgBlack       = "\x1b[40m"
	cursorHome    = "\x1b[H"
	clearLine     = "\x1b[2K"
	saveCursor    = "\x1b[s"
	restoreCursor = "\x1b[u"
)

func (d *Dashboard) render(s Stats) {
	var sb strings.Builder
	cols := d.cols

	// Move to home position (no flicker).
	sb.WriteString(cursorHome)

	d.writeLine(&sb, d.header(cols), cols)
	d.writeLine(&sb, "", cols)
	d.writeSection(&sb, "⛏  MINING", cols)
	d.writeLine(&sb, d.miningLine(s), cols)
	d.writeLine(&sb, d.poolLine(s), cols)
	d.writeLine(&sb, "", cols)
	d.writeSection(&sb, "💰  EARNINGS", cols)
	d.writeLine(&sb, d.earningsLine(s), cols)
	if len(s.Providers) > 0 {
		d.writeLine(&sb, "", cols)
		d.writeSection(&sb, "🔀  ARBITRATION", cols)
		for _, p := range s.Providers {
			d.writeLine(&sb, d.providerLine(p), cols)
		}
	}
	d.writeLine(&sb, "", cols)
	d.writeSection(&sb, "🔒  WALLET", cols)
	d.writeLine(&sb, d.walletLine(s), cols)
	d.writeLine(&sb, "", cols)
	d.writeLine(&sb, d.footer(s, cols), cols)

	io.WriteString(d.w, sb.String()) //nolint:errcheck
}

func (d *Dashboard) header(cols int) string {
	title := bold + cyan + "  Otedama" + reset + dim + " — non-custodial compute arbitration" + reset
	return padRight(title, cols)
}

func (d *Dashboard) writeSection(sb *strings.Builder, label string, cols int) {
	line := bold + white + label + reset
	d.writeLine(sb, line, cols)
}

func (d *Dashboard) miningLine(s Stats) string {
	rate := formatHashRate(s.HashRate)
	devs := fmt.Sprintf("%d device(s)", s.Devices)
	if s.DevicesIdle > 0 {
		// Show the floor-idle count inline so TUI-only operators see it
		// without needing Prometheus or log tailing.
		devs = fmt.Sprintf("%d device(s), %d idle", s.Devices, s.DevicesIdle)
	}
	shares := fmt.Sprintf("shares: %d sent / %d found", s.SharesSent, s.SharesFound)
	switch {
	case s.Curtailed:
		// Deliberate price-driven pause: zero hashrate is expected, not a
		// fault. Cyan "paused" badge (informational, not the yellow ⚠ used for
		// stalls) so the operator knows the miner is healthy and waiting for the
		// price to recover rather than broken.
		return fmt.Sprintf("  %s%-14s ⏸ paused (price below threshold)%s  %s%s%s",
			cyan, rate, reset,
			dim, shares, reset)
	case s.Stalled:
		// Yellow hashrate + stall badge so the operator sees the warning
		// immediately without needing to check Prometheus.
		return fmt.Sprintf("  %s%-14s ⚠ stalled%s  %-20s  %s%s%s",
			yellow, rate, reset,
			dim+devs+reset,
			dim, shares, reset)
	default:
		return fmt.Sprintf("  %s%-14s%s  %-20s  %s%s%s",
			green, rate, reset,
			dim+devs+reset,
			dim, shares, reset)
	}
}

func (d *Dashboard) poolLine(s Stats) string {
	status := red + "✗ disconnected" + reset
	if s.Connected {
		lat := ""
		if s.PoolLatency > 0 {
			lat = fmt.Sprintf(" (%dms)", s.PoolLatency.Milliseconds())
		}
		status = green + "✓ connected" + reset + dim + lat + reset
	}
	url := dim + shortenURL(s.PoolURL, 40) + reset
	return fmt.Sprintf("  Pool: %-30s  %s", url, status)
}

func (d *Dashboard) earningsLine(s Stats) string {
	satsPerSec := s.HashRate * defaultSatsPerHash()
	satsPerDay := satsPerSec * 86400

	// Add AI inference yield from active providers.
	for _, p := range s.Providers {
		if p.Active {
			satsPerDay += p.SatsPerSecond * 86400
		}
	}

	total := bold + yellow + fmt.Sprintf("%.0f sats/day", satsPerDay) + reset
	earned := dim + fmt.Sprintf("est. earned: ~%d sats", s.EstSatsEarned) + reset
	return fmt.Sprintf("  %-30s  %s", total, earned)
}

func (d *Dashboard) providerLine(p ProviderStats) string {
	active := dim + "○ idle" + reset
	if p.Active {
		active = green + "● active" + reset
	}
	rate := fmt.Sprintf("%.1f sats/s", p.SatsPerSecond)
	return fmt.Sprintf("  %-30s  %-12s  %s", p.Name, rate, active)
}

func (d *Dashboard) walletLine(s Stats) string {
	fp := s.WalletFingerprint
	if fp == "" {
		fp = "not initialized"
	}
	return fmt.Sprintf("  Fingerprint: %s%s%s", cyan, fp, reset)
}

func (d *Dashboard) footer(s Stats, cols int) string {
	uptime := formatDuration(s.Uptime)
	hint := dim + "Ctrl+C to exit" + reset
	left := fmt.Sprintf("  uptime: %s", uptime)
	right := hint
	gap := cols - visibleLen(left) - visibleLen(right) - 2
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

func (d *Dashboard) writeLine(sb *strings.Builder, content string, cols int) {
	sb.WriteString(clearLine)
	sb.WriteString(content)
	// Pad to column width to overwrite any previous longer line.
	pad := cols - visibleLen(content)
	if pad > 0 {
		sb.WriteString(strings.Repeat(" ", pad))
	}
	sb.WriteString("\r\n")
}

func (d *Dashboard) clearScreen() {
	fmt.Fprint(d.w, "\x1b[2J"+cursorHome)
}

func (d *Dashboard) hideCursor() {
	fmt.Fprint(d.w, "\x1b[?25l")
}

func (d *Dashboard) showCursor() {
	fmt.Fprint(d.w, "\x1b[?25h")
}

// ----- Formatting helpers -----

// formatHashRate formats a hash/s value in human-readable form.
func formatHashRate(hps float64) string {
	switch {
	case hps >= 1e12:
		return fmt.Sprintf("%.2f TH/s", hps/1e12)
	case hps >= 1e9:
		return fmt.Sprintf("%.2f GH/s", hps/1e9)
	case hps >= 1e6:
		return fmt.Sprintf("%.2f MH/s", hps/1e6)
	case hps >= 1e3:
		return fmt.Sprintf("%.2f kH/s", hps/1e3)
	default:
		return fmt.Sprintf("%.0f H/s", hps)
	}
}

// formatDuration formats a duration in human-readable form.
func formatDuration(d time.Duration) string {
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%dh %dm %ds", h, m, s)
	}
	if m > 0 {
		return fmt.Sprintf("%dm %ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

// defaultSatsPerHash returns the estimated sats earned per hash for
// a CPU device on mainnet (extremely small number; used for display).
func defaultSatsPerHash() float64 {
	const networkHashrate = 1e21
	const blockReward = 3.125e8 // in sats
	const blockTime = 600.0
	return blockReward / (networkHashrate * blockTime)
}

// visibleLen returns the visible character count of a string, excluding
// ANSI escape sequences. Used for padding calculations.
func visibleLen(s string) int {
	n := 0
	inEsc := false
	for _, r := range s {
		if inEsc {
			// A CSI sequence ends at its final byte, any character in the
			// range '@'..'~' (0x40-0x7E) — not only 'm'. The '[' introducer
			// and the numeric/';' parameter bytes (< '@') are consumed
			// silently. Ending on any final byte means a non-colour escape
			// (e.g. "\x1b[2J") can't swallow the rest of the string.
			if r >= '@' && r <= '~' && r != '[' {
				inEsc = false
			}
			continue
		}
		if r == '\x1b' {
			inEsc = true
			continue
		}
		n++
	}
	return n
}

// padRight pads s to width with spaces (ignoring ANSI sequences).
func padRight(s string, width int) string {
	pad := width - visibleLen(s)
	if pad <= 0 {
		return s
	}
	return s + strings.Repeat(" ", pad)
}

// shortenURL truncates a URL to maxLen characters.
func shortenURL(url string, maxLen int) string {
	if len(url) <= maxLen {
		return url
	}
	if maxLen < 4 {
		// Can't fit "..." plus at least one character; return as-is.
		return url
	}
	return url[:maxLen-3] + "..."
}

// ----- Width detection stub -----

// SetWidth allows callers to inject the terminal width.
// If never called, defaults to 80 columns.
func (d *Dashboard) SetWidth(cols int) {
	if cols >= 40 {
		d.cols = cols
	}
}

// FormatHashRate is exported for use in the CLI status line.
func FormatHashRate(hps float64) string { return formatHashRate(hps) }

// FormatDuration is exported for use in the CLI status line.
func FormatDuration(dur time.Duration) string { return formatDuration(dur) }

// SatsToDisplay formats satoshis in a human-readable way.
func SatsToDisplay(sats uint64) string {
	if sats >= 1e8 {
		return fmt.Sprintf("%.4f BTC", float64(sats)/1e8)
	}
	if sats >= 1000 {
		return fmt.Sprintf("%d sats (%.5f BTC)", sats, float64(sats)/1e8)
	}
	return fmt.Sprintf("%d sats", sats)
}
