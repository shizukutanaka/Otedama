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
// # Terminal width (not yet auto-detected)
//
// SetWidth lets a caller inject the real terminal width (intended
// source: TIOCGWINSZ on Unix, GetConsoleScreenBufferInfo on Windows),
// but no caller in this codebase actually calls it in production —
// engine.Run's dashboard always runs at the NewDashboard default of 80
// columns, regardless of the real terminal size. See
// docs/KNOWN_LIMITATIONS.md §15. What IS handled correctly regardless
// of the real width: every
// line is truncated to fit whatever width is configured, and the most
// important field on each line (pool connection status, in particular)
// is sized from a dynamic budget rather than a fixed offset, so it
// cannot be silently cut off even at the documented 40-column minimum.
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
	// wg tracks the render loop goroutine so Stop can block until it has
	// genuinely exited before Stop itself writes to w (showCursor /
	// Fprintln below) — without this, Stop's writes could race an
	// in-flight render() call's writes to the same io.Writer.
	wg sync.WaitGroup
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
	d.wg.Add(1)
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
	// Wait for renderLoop to actually return before touching w ourselves:
	// otherwise this Fprintln can race an in-flight render() call's own
	// writes to the same (generally non-concurrency-safe) io.Writer.
	d.wg.Wait()
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
	defer d.wg.Done()
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
	// Section labels are plain text, not emoji: an emoji glyph renders at
	// visible width 2 in virtually every terminal, but visibleLen counts
	// every rune as width 1 (correctly matching real width for the ANSI
	// color codes and plain text used everywhere else) — the mismatch
	// under-padded these lines specifically and could leave stray
	// characters from a longer previous frame unoverwritten.
	d.writeSection(&sb, "MINING", cols)
	d.writeLine(&sb, d.miningLine(s, cols), cols)
	d.writeLine(&sb, d.poolLine(s, cols), cols)
	d.writeLine(&sb, "", cols)
	d.writeSection(&sb, "EARNINGS", cols)
	d.writeLine(&sb, d.earningsLine(s), cols)
	if len(s.Providers) > 0 {
		d.writeLine(&sb, "", cols)
		d.writeSection(&sb, "ARBITRATION", cols)
		for _, p := range s.Providers {
			d.writeLine(&sb, d.providerLine(p), cols)
		}
	}
	d.writeLine(&sb, "", cols)
	d.writeSection(&sb, "WALLET", cols)
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

func (d *Dashboard) miningLine(s Stats, cols int) string {
	rate := formatHashRate(s.HashRate)
	devs := fmt.Sprintf("%d device(s)", s.Devices)
	if s.DevicesIdle > 0 {
		// Show the floor-idle count inline so TUI-only operators see it
		// without needing Prometheus or log tailing.
		devs = fmt.Sprintf("%d device(s), %d idle", s.Devices, s.DevicesIdle)
	}
	sharesFull := fmt.Sprintf("shares: %d sent / %d found", s.SharesSent, s.SharesFound)
	switch {
	case s.Curtailed:
		// Deliberate price-driven pause: zero hashrate is expected, not a
		// fault. Cyan "paused" badge (informational, not the yellow ⚠ used for
		// stalls) so the operator knows the miner is healthy and waiting for the
		// price to recover rather than broken.
		prefix := fmt.Sprintf("  %s%-14s ⏸ paused (price below threshold)%s  ", cyan, rate, reset)
		shares := truncateToBudget(sharesFull, cols-visibleLen(prefix))
		return prefix + dim + shares + reset
	case s.Stalled:
		// Yellow hashrate + stall badge so the operator sees the warning
		// immediately without needing to check Prometheus.
		prefix := fmt.Sprintf("  %s%-14s ⚠ stalled%s  %-20s  ", yellow, rate, reset, dim+devs+reset)
		shares := truncateToBudget(sharesFull, cols-visibleLen(prefix))
		return prefix + dim + shares + reset
	default:
		prefix := fmt.Sprintf("  %s%-14s%s  %-20s  ", green, rate, reset, dim+devs+reset)
		shares := truncateToBudget(sharesFull, cols-visibleLen(prefix))
		return prefix + dim + shares + reset
	}
}

func (d *Dashboard) poolLine(s Stats, cols int) string {
	statusPlain := "✗ disconnected"
	status := red + statusPlain + reset
	if s.Connected {
		lat := ""
		if s.PoolLatency > 0 {
			lat = fmt.Sprintf(" (%dms)", s.PoolLatency.Milliseconds())
		}
		statusPlain = "✓ connected" + lat
		status = green + "✓ connected" + reset + dim + lat + reset
	}
	const prefix = "  Pool: "
	// Reserve enough room for the connection status plus a 2-space gap
	// so it can never be truncated off-screen by writeLine's right-side
	// cut — connection status is the single most important thing this
	// line conveys. The URL gets whatever budget remains, with a floor
	// so a very narrow terminal still shows a recognizable fragment
	// rather than nothing.
	urlBudget := cols - len(prefix) - len(statusPlain) - 2
	if urlBudget < 8 {
		urlBudget = 8
	}
	url := dim + shortenURL(s.PoolURL, urlBudget) + reset
	return fmt.Sprintf("%s%-*s  %s", prefix, urlBudget, url, status)
}

// truncateToBudget shortens a plain (no-ANSI) string to fit budget visible
// columns, appending "..." when it must cut. A non-positive budget yields
// an empty string rather than a negative-length panic.
func truncateToBudget(s string, budget int) string {
	if budget <= 0 {
		return ""
	}
	if len(s) <= budget {
		return s
	}
	if budget < 4 {
		return s[:budget]
	}
	return s[:budget-3] + "..."
}

// earningsLine renders the dashboard's headline rate and the running estimate
// of what has been earned so far.
//
// The rate has exactly one source: the yield of the streams arbitration is
// actually routing devices to right now. It previously had two, added
// together — a local hashrate × defaultSatsPerHash() estimate *plus* every
// active provider's quoted yield. Since the mining provider is itself one of
// those providers, real mining revenue was counted twice, and the local
// estimate was a third copy of the mining yield model carrying a frozen 1e21
// network-hashrate constant, so the two halves disagreed by however far
// difficulty had moved since that constant was written. (The other addend
// used to be a simulated AI-inference market, now deleted — see the
// internal/provider package doc.)
//
// Summing the allocation means an idle device contributes nothing, a
// curtailed miner shows zero rather than its would-be rate, and the figure
// tracks the same number the engine exports as
// otedama_arbitration_expected_yield_sats_per_second.
func (d *Dashboard) earningsLine(s Stats) string {
	satsPerDay := 0.0
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
	// On a narrow terminal, content longer than cols would wrap onto a
	// second terminal row — breaking the "cursor home, overwrite in place"
	// repaint model this dashboard depends on, since every subsequent line
	// would then land one row off from where the previous frame drew it.
	if visibleLen(content) > cols {
		content = truncateVisible(content, cols)
	}
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

// truncateVisible cuts s down to at most maxVisible visible characters,
// copying every ANSI escape sequence encountered up to the cut point
// verbatim (so color codes opened before the cut still apply) and
// discarding everything after it. A trailing reset closes any style left
// open by a truncated escape, so a cut line can never bleed its color
// into the rest of the frame.
func truncateVisible(s string, maxVisible int) string {
	if maxVisible <= 0 {
		return ""
	}
	var sb strings.Builder
	n := 0
	inEsc := false
	for _, r := range s {
		if inEsc {
			sb.WriteRune(r)
			if r >= '@' && r <= '~' && r != '[' {
				inEsc = false
			}
			continue
		}
		if r == '\x1b' {
			inEsc = true
			sb.WriteRune(r)
			continue
		}
		if n >= maxVisible {
			break
		}
		sb.WriteRune(r)
		n++
	}
	sb.WriteString(reset)
	return sb.String()
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
