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

### S — TUI (session 71)
- ✅ **`shortenURL` panics on `maxLen < 4`.** `url[:maxLen-3]` produces a
  negative slice index when `maxLen` is 0–3 (valid inputs for a narrow
  terminal column). Added early return: `if maxLen < 4 { return url }`.
  Test: `TestShortenURL_MaxLenTooSmall`. (`dashboard.go`.)

### A — Mining core (session 71)
- ✅ **`Worker.Stats()` returns garbage before `Start()`.** Before `Start`
  is called `startTime` is 0; `time.Now().UnixNano() − 0` is a large
  positive number, so `Uptime` and `HashRate` are wildly wrong on first
  read. Added `if w.startTime.Load() == 0 { return Stats{} }` guard.
  Test: `TestWorker_StatsBeforeStart`. (`worker.go`.)

### R — HAL (session 71)
- ✅ **`Detect()` drain loop could not be interrupted by context
  cancellation.** The `for res := range resultsCh` loop blocks until
  `resultsCh` is closed, which requires all driver goroutines to finish.
  A driver that ignores context (e.g. opens a blocking syscall) would
  prevent `Detect` from returning promptly after `ctx` is cancelled.
  Replaced with a `select`-based loop that `break loop`s on `ctx.Done()`.
  Test: `TestDetector_ContextCancellationInterruptsDrainLoop`
  (uses new `blockingDriver` helper that ignores context). (`registry.go`.)

### G — Providers (session 71)
- ✅ **`MiningProvider.Stop()` / `AkashProvider.Stop()` left provider
  permanently broken.** After `Stop()` returned, `p.cancel` still held the
  old (already-called) `CancelFunc`. A subsequent `Start()` saw
  `p.cancel != nil` and returned "already started", making the provider
  un-restartable. Also, `p.quoteCh` was closed by the goroutine's
  `defer close()`, so callers that continued to hold the `Quotes()` channel
  reference would get the zero value on every read.  Fixed both providers:
  after `wg.Wait()`, nil `p.cancel` and recreate `p.quoteCh` with the same
  capacity under the mutex. Tests: `TestMiningProvider_StopClearsStateForRestart`,
  `TestAkashProvider_StopClearsStateForRestart`. (`mining.go`,
  `ai_inference.go`; updated `TestAkashProvider_StopCleansUpGoroutine` to
  save the channel reference before Stop.)

### L — CLI (session 71)
- ✅ **`cmdVersion --json` silently ignored `json.Encoder.Encode` error.**
  The only `_ = enc.Encode(info)` in the version command discarded the
  error (e.g. a broken pipe when the caller exits early). Now returns
  `exitRuntime` and prints to stderr. (`cmd/otedama/main.go`.)

### B — Stratum V2 transport (session 72)
- ✅ **`OpenMiningChannelError` and `SubmitSharesError` had no `Encode`
  method.** Every other message type exposes `Encode()` as the symmetric
  inverse of its `Decode*` function; these two were missing it. Without
  `Encode`, a server-side (or test-side) implementation could not send
  these rejection messages. Added `OpenMiningChannelError.Encode()` to
  `handshake.go` and `SubmitSharesError.Encode()` to `messages.go`
  (which required adding `"bytes"` to the import). Both round-trip
  correctly through the existing `Decode*` functions.
  Tests: `TestDecodeSubmitSharesError_Basic`,
  `TestDecodeSubmitSharesError_WithMessage`,
  `TestDecodeOpenMiningChannelError_Basic`,
  `TestDecodeOpenMiningChannelError_WithMessage`.
- ✅ **`DispatchFrame` coverage at 15.9%.** Added `TestDispatchFrame_*`
  cases for `SetupConnection`, `SetupConnectionError`,
  `OpenMiningChannel`, `OpenMiningChannelError`, `SubmitSharesSuccess`,
  `SubmitSharesError`, and a truncated-payload malformed-message test.
  Stratum coverage: 75.5% → 81.3%.
- ✅ **`SubmitSharesSuccess.Encode` at 0%.** Added
  `TestSubmitSharesSuccess_Encode_Roundtrip`.

### D — Pool-protocol abstraction / stratumv2 (session 72)
- ✅ **`poolproto/stratumv2` coverage at 23.7% (critical gap).**
  `Negotiate`, `readLoop`, `Jobs`, `Submit`, `sendMsg`, `SuggestedDifficulty`,
  `float64FromBits` were all at 0% — the core runtime path untested.
  Added a `poolSide`/`writeMsgTo` mock-pool-server helper using
  `net.Pipe()`; new tests exercise the full `Dial→Negotiate→Jobs→Submit→Close`
  lifecycle, pool-rejection paths (`SetupConnectionError`,
  `OpenMiningChannelError`), and idempotent `connection.Close()`.
  Coverage: 23.7% → 80.4%.
  Tests: `TestDialer_Negotiate_Success`,
  `TestDialer_Negotiate_PoolRejectsSetup`,
  `TestDialer_Negotiate_PoolRejectsChannel`,
  `TestDialer_Negotiate_WrongConnectionType`,
  `TestSession_Jobs_DeliversNewMiningJob`,
  `TestSession_Submit_SendsFrame`,
  `TestSession_Close_ClosesJobsChannel`,
  `TestSession_SuggestedDifficulty_Default`,
  `TestConnection_Close_IsIdempotent`,
  `TestFloat64FromBits`.

### Coverage tracking (session 72)
Total statement coverage across all 24 packages rose from **79.3%** to
**81.8%** this session. Remaining packages below 90%:

| Package | Coverage | Notes |
|---|---|---|
| `internal/daemon` | 36.2% | `installSystemd`, `installLaunchd`, `runCmd` need root/OS to exercise; unit-testable parts (`serviceArgv`, `xmlEscape`, `launchdPlist`) already covered |
| `cmd/otedama` | 68.3% | Subcommand integration paths; the 90% gap is in OS-interaction paths (`service install/uninstall/status`) |
| `internal/engine` | 77.3% | `totalHashes`, `totalDropped`, `logStats` helpers at 0% — need a live mining session |
| `internal/stratum` | 81.3% | `ReadMessage2` noise path, `EncodeFrame` error path |
| `internal/poolproto/stratumv2` | 80.4% | `readLoop` error paths, TLS dial path |

### Categories with no actionable findings this pass
F (arbitration), I (btccrypto), L (CLI beyond items already fixed in
G1–G15 and session 71), P (logger), U (clock/version) — reviewed, no
concrete defects beyond what the spec gap table already tracks.

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
| TUI (s71) | `shortenURL` panic guard for `maxLen < 4` | `TestShortenURL_MaxLenTooSmall` |
| Mining core (s71) | `Worker.Stats()` returns zero-value before `Start()` | `TestWorker_StatsBeforeStart` |
| HAL (s71) | `Detect()` drain loop exits on `ctx.Done()` (blocking driver no longer hangs) | `TestDetector_ContextCancellationInterruptsDrainLoop` |
| Providers (s71) | `Stop()` nils `p.cancel` + recreates `quoteCh` → provider is restartable | `TestMiningProvider_StopClearsStateForRestart`, `TestAkashProvider_StopClearsStateForRestart` |
| CLI (s71) | `version --json` propagates `Encode` error to stderr + `exitRuntime` | no separate test (exercised by `TestCmdVersion_*` integration) |
| Stratum B (s72) | `OpenMiningChannelError.Encode` + `SubmitSharesError.Encode` missing; added both | `TestDecodeOpenMiningChannelError_*`, `TestDecodeSubmitSharesError_*` |
| Stratum B (s72) | `DispatchFrame` + `SubmitSharesSuccess.Encode` branches at 0%; 15 new tests | `TestDispatchFrame_*`, `TestSubmitSharesSuccess_Encode_Roundtrip` |
| Stratum D (s72) | `poolproto/stratumv2` 23.7%→80.4%; full mock pool server tests for Negotiate/Jobs/Submit/Close | 10 new `TestDialer_*` / `TestSession_*` / `TestFloat64FromBits` |

All 24 packages build, vet, and test green (`-race` clean on the touched
packages). Flagged Noise/engine items are funds-critical and left for maintainer
review; remaining deferred items are tracked above.
