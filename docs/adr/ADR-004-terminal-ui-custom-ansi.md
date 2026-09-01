# ADR-004: Custom ANSI TUI instead of Bubble Tea / tcell

**Status:** Accepted
**Date:** 2026-04-15

## Context

Otedama runs interactively. Users expect to see live hashrate, pool
status, current arbitration decision, and earnings estimate without
running an external dashboard. The two mature options for Go TUIs in
2026 are:

1. **Bubble Tea** (charmbracelet/bubbletea) — Elm-architecture-style
   reactive TUI framework. Excellent ergonomics, ~30 transitive
   dependencies. Used by gh, glow, lazygit.
2. **tcell** (gdamore/tcell) — lower-level terminal abstraction.
   ~10 transitive dependencies. Used by tview, micro.

Both are well-engineered and would have shipped a working dashboard
in roughly 200 lines.

The third option is to write the TUI directly with ANSI escape
sequences, no framework. We chose this third option.

## Decision

`internal/tui/dashboard.go` writes raw ANSI escape sequences to
the configured `io.Writer`. It uses:

- `\x1b[2J\x1b[H` to clear screen and home cursor at each render.
- `\x1b[?25l` / `\x1b[?25h` to hide and show the cursor.
- `\x1b[<row>;<col>H` to position output.
- A handful of color codes (`\x1b[32m` green, `\x1b[31m` red, `\x1b[0m` reset).

Layout is computed in code with `padRight`, `visibleLen` (which
correctly counts escape-sequence-stripped width), and `shortenURL`.

Render is driven by a single ticker (default 250 ms) that calls
`renderLoop`, which reads the latest `Stats` from a buffered channel
and writes the new frame.

## Consequences

### Positive

- **Zero new dependencies.** Consistent with ADR-003. The TUI is a
  consumer of `os.Stdout` and `time.Ticker` — both stdlib.
- **The render is deterministic and small.** ~400 lines of Go cover
  every rendering case. Bug reports and audits stay in the codebase.
- **No surprise updates.** Bubble Tea released breaking API changes
  during v0.x; we would not want to chase them.
- **Easy to skip.** `--no-tui` swaps the dashboard for a simple log
  stream by writing nothing instead of constructing a Dashboard.
  No "framework off" mode to maintain.
- **Predictable terminal compatibility.** Our escape sequences are
  the universal subset (xterm-256color since the 1990s). We do not
  query terminfo, so we work identically on Linux console, macOS
  Terminal.app, Windows Terminal, mosh, screen, tmux.

### Negative

- **No mouse, no keyboard input.** Bubble Tea handles arrow keys and
  click events for free. We have neither — but Otedama's TUI is
  read-only (the only interaction is Ctrl+C to quit), so we don't
  need them.
- **No automatic resize handling.** If the terminal is resized
  smaller than expected, lines wrap. We accept this; the dashboard
  is information-dense but not safety-critical.
- **No graphical widgets.** No progress bars, no spinners. We use
  plain text indicators (`✓`, `!`, `✗` in `doctor`; "connected" /
  "disconnected" in the dashboard). Less flashy, but readable in
  any terminal that supports UTF-8.

### Neutral

- **Testing is straightforward.** Each line-rendering function
  (`headerLine`, `poolLine`, `walletLine`, `earningsLine`,
  `providerLine`, `footer`) is a pure string-returning function and
  is unit-tested individually with no terminal involved.

## Alternatives Considered

### Bubble Tea

*Rejected.* Adds 30 dependencies including reactive runtime, lipgloss
styling, and bubbles widget library. Would change the API such that
testing requires a TestModel mock. Net code size larger (the
framework code is hidden but still in our binary).

### tcell

*Rejected.* Less heavyweight than Bubble Tea but still introduces
terminfo handling, signal management, and a separate event loop.
Our ticker-based loop is simpler.

### No TUI at all (CLI logs only)

*Rejected for default behaviour.* Live mining is a viewing experience —
users want to *watch* their hash rate. A flat log scroll is harder
to interpret. We do offer `--no-tui` for production deployments where
logs are aggregated.

### ASCII-only (no escapes)

*Rejected.* The dashboard is designed for live viewing, where redraw
is essential. Without escape sequences we would have to scroll
endlessly or reset the terminal between updates, which is jarring.

## Future revisions

If Otedama grows interactive features (key bindings to switch
allocation policies live, interactive diagnostic, etc.), we will
revisit. As of v3.0, the dashboard is read-only and the custom
implementation suffices.

## Related

- ADR-003 — Zero runtime dependencies
- `internal/tui/dashboard.go` — Implementation
- `internal/tui/dashboard_test.go` — Pure-function unit tests
- `internal/tui/formatters_test.go` — Format helper tests

## Erratum (added session 266, does not alter the accepted decision)

The consequence **"No automatic resize handling. If the terminal is
resized smaller than expected, lines wrap"** was addressed in session 264
on Linux. `internal/tui/width_linux.go` reads the real terminal width via
the `TIOCGWINSZ` ioctl and the dashboard re-reads it on every render tick,
so a mid-session resize is picked up without a restart; other platforms
fall back to the previous fixed width (`width_other.go`). This does not
introduce terminfo or a dependency, so the decision above is unchanged —
the ioctl is a direct syscall, and it is the only use of `unsafe` in the
repository. Tests drive it against a real PTY (`/dev/ptmx`).
