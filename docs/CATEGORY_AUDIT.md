# Otedama — Category Audit (session 67)

This document divides the product into functional categories, then for each
records the concrete improvement points found by an exhaustive read-through and
their disposition. It complements `docs/SPECIFICATION.md` (the gap table tracks
spec-vs-code discrepancies; this tracks code-quality/correctness findings across
every package).

**Disposition legend:** ✅ Fixed this session · 🚩 Flagged for maintainer review
(funds-critical / CODEOWNERS-gated) · ⏸ Deferred (tracked) · ❎ Verified
not-a-defect (false positive).

The audit was produced by five parallel reviews, one per category cluster. Each
finding was re-verified against the code before any change.

---

## Category taxonomy

| # | Category | Packages |
|---|----------|----------|
| A | Mining core | `internal/miner` |
| B | Stratum V2 transport | `internal/stratum` (frame/messages/handshake) |
| C | Noise transport security | `internal/stratum` (noise*) |
| D | Pool-protocol abstraction | `internal/poolproto`, `…/stratumv1`, `…/stratumv2` |
| E | Engine / orchestration | `internal/engine` |
| F | Arbitration | `internal/arbitration` |
| G | Providers | `internal/provider` |
| H | Rates | `internal/rates` |
| I | Bitcoin crypto | `internal/btccrypto` |
| J | Lightning wallet | `internal/lightning` |
| K | Configuration | `internal/config` |
| L | CLI / UX | `cmd/otedama` |
| M | Daemon / service | `internal/daemon` |
| N | Doctor / diagnostics | `internal/doctor` |
| O | Metrics | `internal/metrics` |
| P | Logging | `internal/logger` |
| Q | HTTP server | `internal/httpserver` |
| R | HAL (hardware) | `internal/hal` |
| S | TUI | `internal/tui` |
| T | i18n | `internal/i18n` |
| U | Clock / version | `internal/clock`, `internal/version` |

---

## Findings by category

### H — Rates
- ✅ **Median biased on even source counts.** `Fetch` used `rates[len/2]` after
  sorting; for an even number of surviving sources (the common case when one of
  three fails) this returns the *upper* middle value, not the average — biasing
  toward the higher source and weakening outlier resistance. Now averages the
  two middle values. (`fetcher.go`; test `TestFetcher_MedianOfTwoSourcesAverages`.)
- ✅ **Initial background fetch error was swallowed.** Added `SetLogger(fn func(string))`
  seam to `Fetcher`; `StartBackground` now calls it on both the initial and
  periodic fetch errors instead of discarding them. Tests:
  `TestFetcher_StartBackground_LogsInitialFetchError`,
  `TestFetcher_SetLogger_NilIsSilent`. (session 70.)

### N — Doctor
- ✅ **Address length bound mismatched config.** `isLikelyBitcoinAddress`
  rejected addresses > 62 chars while `config.validateAddress` accepts up to 90,
  so a long bech32m address that passes `config validate` was flagged by
  `doctor`. Doctor now uses 26–90 to match. (`doctor.go`; test updated.)
- ❎ "`failed` not pluralized" — not a defect; "2 failed" is correct English, and
  the only count needing an `s` (`warning`→`warnings`) is already handled.

### M — Daemon / service
- ✅ **launchd split arguments on spaces.** `launchdPlist` built
  `ProgramArguments` via `strings.Split(binary+" "+serviceArgs(), " ")`, so a
  path or value containing a space (e.g. `/Users/John Doe/config.yaml`) was
  split across multiple `<string>` entries and the service started with broken
  args. Introduced a canonical `serviceArgv() []string` consumed directly by
  launchd (one `<string>` per element), with XML-escaping of values; `serviceArgs`
  (systemd/Windows) now joins it with selective quoting. (tests added.)
- ⏸ Windows `Status()` returns "unsupported platform" though install/uninstall
  work on Windows — incomplete. Deferred (needs `sc.exe query` parsing; can't be
  exercised from the Linux CI).
- ⏸ Windows `sc.exe binPath=` quoting of values with spaces is fragile —
  deferred with the Windows-status work.

### O — Metrics
- ✅ **HELP text not escaped (Prometheus spec violation).** A help string with a
  newline/backslash would split the `# HELP` line and corrupt the scrape. Added
  `escapeHelp` (backslash + newline; the double-quote is not special in HELP
  lines). (`metrics.go`; test `TestWriteText_HelpTextIsEscaped`.)
- ✅ Package comment claimed "a handful of histograms"; none exist. Corrected to
  describe the gauge-quantile approach actually used. (session 68.)
- ✅ **No metric-name validation.** Added `isValidMetricName` (`[a-zA-Z_:][a-zA-Z0-9_:]*`);
  `NewCounter`/`NewGauge` now panic with a clear message on invalid names. Every
  name is a compile-time constant, so the panic fires at test time, not runtime.
  Tests: `TestNewCounter_InvalidNamePanics`, `TestNewGauge_InvalidNamePanics`,
  `TestIsValidMetricName_ValidNames`, `TestIsValidMetricName_InvalidNames`. (session 70.)

### J — Lightning wallet (funds-critical; CODEOWNERS)
- ✅ **Secret material left on the heap.** `EncryptSeed`/`DecryptSeed` derived a
  32-byte scrypt key and (on decrypt) a 64-byte plaintext seed that were never
  wiped, lingering until GC. Added `zeroBytes` and `defer`-wiped the scrypt key,
  the `[]byte(passphrase)` copy, and the decrypted plaintext. Additive hardening,
  no change to the crypto behaviour; uses only stdlib. (`seedstore.go`.)
- Reviewed and confirmed correct: BIP-39 entropy uses `crypto/rand`; the GCM
  nonce is random per encrypt; the decryption error is deliberately opaque.
- ✅ **Decryption error is now a sentinel.** `DecryptSeed` returns
  `ErrWrongPassphrase` (testable via `errors.Is`) on GCM auth failure, distinct
  from structural errors (bad version, empty ciphertext), without leaking which
  via the message. (session 69; `TestDecryptSeed_RejectsWrongPassphrase`.)
- ⏸ Passphrase bytes from the caller's `string` can't be wiped (Go strings are
  immutable) — documented, deferred.

### C — Noise transport security (funds-critical; CODEOWNERS — 🚩 all flagged)
These touch `internal/stratum/noise*` which requires maintainer review. Verified
and flagged, not changed this session:
- 🚩 `CipherState.n` is a plain `uint64` incremented without synchronisation; if
  encrypt and decrypt ever run on different goroutines a nonce could repeat
  (catastrophic for ChaCha20-Poly1305). Today I/O is single-goroutine per
  direction, so latent — but worth an `atomic.Uint64` or an explicit
  "single-goroutine" contract.
- 🚩 No nonce-exhaustion guard: after 2⁶⁴ messages `n` wraps. Noise mandates a
  fatal error instead. Add `if c.n == math.MaxUint64 { return error }`.
- 🚩 `ReadMessage2` x-only fallback completes the handshake from unvalidated
  bytes with no DH (the documented P-256 *alpha* stub, KNOWN_LIMITATIONS §2 /
  SPECIFICATION G4). When secp256k1 lands (ADR-011) the fallback must validate
  the point and perform DH, or reject. Until then it must only be reachable in
  the alpha transport.
- 🚩 Custom `hmacSHA256` could be replaced with `crypto/hmac` (stdlib, audited)
  to shrink the custom-crypto surface.

### A — Mining core
- ✅ **`Worker.Start` contract not enforced.** Documented "subsequent calls
  panic" but a second call only panicked *later*, incidentally, via
  double-`close(w.done)` (after corrupting the share channel). Now an
  `atomic.Bool` guard panics immediately with a clear message. (session 68;
  `TestWorker_StartTwicePanics`.)
- ✅ **`grind` dropped found shares silently** when the share channel was full.
  Added `dropCount`/`Stats.SharesDropped`; the engine stats tick now logs a
  warning when the drop total grows (`totalDropped`), so a consumer that can't
  keep up is visible instead of silently losing shares. (session 68.)
- ❎ `Worker.Stop` "unbounded wait" — safe: `grind` selects on `ctx.Done()` every
  batch (~µs) and after a 10 ms idle sleep, so it always returns promptly after
  `cancel()`.

### B — Stratum V2 transport
- ❎ "`SubmitSharesError` STR0_255 length-prefix overflow" — false positive:
  `getStr0_255` uses `io.ReadFull`, which errors (`ErrUnexpectedEOF`) when fewer
  than `n` bytes remain. Malformed input is rejected, not over-read.
- ❎ Frame `MsgLength` int conversion overflow — safe on the 64-bit platform
  minimum; the existing bounds check guards allocation.
- ⏸ `DispatchFrame` returns a decode error for malformed *known* messages and the
  V2 read loop `continue`s silently — adding a debug log would aid attack
  triage. Deferred (forward-compat behaviour is intentional).
- ⏸ `OpenMiningChannel(.Success).MaxTargetNBits` wire-encoding: an audit pass
  suggested a missing field, but the exact SV2 field set must be confirmed
  against the spec before touching the working round-trip — not changed (the
  project forbids acting on an unverified spec claim). Tracked for the secp256k1
  work which revisits the channel messages.

### E — Engine / orchestration
- 🚩 Payout-address failover timing: `onConnected` (which marks the active
  address known-good) fires after the reader goroutine spawns, so a pool that
  disconnects in the same instant *could* leave `addrConnected=false` for one
  extra iteration. Funds-adjacent invariant ("a known-good address is never
  abandoned") — flagged for careful maintainer review; needs a test that pins
  the exact ordering before any change.
- ❎ "Reader goroutine lingers on a hung `ReadFrame` after cancel" — re-verified
  as acceptable: `runSession` has `defer conn.Close()`, which unblocks
  `ReadFrame` (returns an error) as soon as the loop returns on `ctx.Done()`, so
  the goroutine exits promptly. No leak.
- ⏸ Providers/rates use `time.Now()` rather than the injected `clock.Clock`,
  limiting deterministic time control in tests. Deferred (test-only;
  threading the clock through is a larger refactor).
- ❎ `fanIn` drops buffered values on `ctx` cancel — correct for graceful
  shutdown; documented behaviour.

### G — Providers
- ❎ Quote-channel "drop oldest" pattern — re-verified low-risk: the channel is
  buffered at 16 with a *single* publisher goroutine, so the drop path rarely
  triggers and the nested select cannot deadlock (only the consumer drains;
  the publisher's resend always succeeds). Working code; not churned.
- ❎ Unused `rate` in the mining provider is intentional (mining yield is
  price-independent; the BTC/USD rate is used by the Akash provider) — clarified
  by comment, no behaviour change needed.

### S — TUI
- ✅ **`visibleLen` only reset its ANSI state on an `m` terminator.** A non-colour
  CSI sequence (e.g. `\x1b[2J`) never reset the state and swallowed the rest of
  the string in width calculations. Now terminates on any CSI final byte
  (`@`..`~`, excluding the `[` introducer). (session 68;
  `TestVisibleLen_NonColorCSITerminator`.)
- ❎ Earnings float precision — `float64` is adequate for a display estimate; the
  suggested constant rewrite changes semantics and is not a defect.

### R — HAL
- ✅ **`parseGPUDevice` silently dropped invalid GPU identities.** Added
  `LogFn func(string)` exported field to `GPULinuxDriver`; `parseGPUDevice` now
  accepts a `logFn` parameter and calls it with the render-node name and
  validation error when skipping a device. `Enumerate` passes `d.LogFn`.
  Test: `TestParseGPUDevice_LogFnCalledOnValidationFailure`. (session 70.)

### Q — HTTP server
- ❎ `ReadHeaderTimeout` < `ReadTimeout` is correct slowloris mitigation; only a
  clarifying comment was suggested.

### T — i18n
- ✅ **Placeholder parity was claimed but unverified.** The package doc promises
  "no format-specifier mismatches between languages," and key-set completeness is
  tested — but nothing verified that each translation references the *same*
  `{{.field}}` placeholders as the English source, nor that every message is a
  valid `text/template`. A translator typo (`{{.ur}}`), a dropped placeholder, or
  a malformed brace (`{{.url}`) would only surface at runtime in that one
  language. Added `TestAllCatalogs_PlaceholdersMatchEnglish` and
  `TestAllCatalogs_TemplatesParse`. The current 10 catalogs pass — so this is a
  regression guard that finally backs the documented invariant. (session 69.)

### K — Configuration
- ✅ **`FlagValues.ConfigFile` dead field.** The field was set by `cmdDoctor` in
  `main.go` but never consumed by `Resolve` (which receives an already-decoded
  `Config`, not a path). Dead state creates false impressions about the four-layer
  model. Removed `ConfigFile` from `FlagValues`; updated `cmdDoctor` to not set
  it; added a doc comment to `Resolve` explaining that file loading is the
  caller's responsibility. (session 70.)

### Categories with no actionable findings this pass
F (arbitration), I (btccrypto), L (CLI beyond items already fixed in
G1–G15), P (logger), U (clock/version) — reviewed, no concrete defects beyond
what the spec gap table already tracks.

---

## This session's fixes (summary)

| Category | Fix | Test |
|---|---|---|
| Rates | median averages two middle values on even source counts | `TestFetcher_MedianOfTwoSourcesAverages` |
| Doctor | address length bound 62 → 90 (matches config) | updated `TestIsLikelyBitcoinAddress_LengthBoundaries` |
| Daemon | launchd consumes `serviceArgv` (paths with spaces survive) + XML-escape | `TestServiceArgv_PreservesValuesWithSpaces`, `TestLaunchdPlist_PathWithSpacesIsSingleString`, `TestXMLEscape` |
| Metrics | escape HELP text (Prometheus spec) | `TestWriteText_HelpTextIsEscaped` |
| Lightning | wipe scrypt key / passphrase / decrypted plaintext | existing seedstore tests still pass |
| Mining core | `Worker.Start` double-call panics immediately; `grind` tracks dropped shares | `TestWorker_StartTwicePanics`; `Stats.SharesDropped` |
| TUI | `visibleLen` terminates on any CSI final byte, not just `m` | `TestVisibleLen_NonColorCSITerminator` |
| i18n | placeholder parity + template parse guard across all 10 catalogs | `TestAllCatalogs_PlaceholdersMatchEnglish`, `TestAllCatalogs_TemplatesParse` |
| Lightning | `ErrWrongPassphrase` sentinel for `errors.Is` callers | `TestDecryptSeed_RejectsWrongPassphrase` |
| Rates (s70) | `SetLogger` seam — startup/periodic fetch errors surface to operator | `TestFetcher_StartBackground_LogsInitialFetchError` |
| Metrics (s70) | `isValidMetricName` guard in `NewCounter`/`NewGauge` | `TestNewCounter_InvalidNamePanics`, `TestIsValidMetricName_*` |
| Config (s70) | removed dead `FlagValues.ConfigFile` field | compile-time (field no longer exists) |
| HAL (s70) | `GPULinuxDriver.LogFn` seam — skipped render nodes now logged | `TestParseGPUDevice_LogFnCalledOnValidationFailure` |

All 24 packages build, vet, and test green (`-race` clean on the touched
packages). Flagged Noise/engine items are funds-critical and left for maintainer
review; remaining deferred items are tracked above.
