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
| V | Docs / CI infra | `docs/*`, `README.md`, `CLAUDE.md`, `.github/workflows/*` (added session 247) |

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

### Coverage tracking (sessions 73–75)
Session 73 covered the remaining 0% paths (`totalHashes`, `totalDropped`,
`logStats`, the two session-72 `Encode` methods): total **81.8% → 82.6%**,
805 tests. Engine 77.3% → 78.9%; stratum 81.3% → 83.4%.

### E — Engine structure (session 74, refactor)
`run.go` had grown to 1,427 lines mixing six concerns, and the godoc
comments for `setupWallet`/`detectDevices` had drifted onto
`arbitrationLoopOpts` (rendered on the wrong symbol). Split into
`run.go` (session core), `fanin.go`, `arbitrate.go`, `setup.go`,
`stats.go`; comments reattached; code otherwise moved verbatim.
Coverage identical (78.9%) before/after — confirms no behavior change.

### E — Dead code (session 75)
`classifyReject` (stats.go) had no production caller — `runSession`
calls `rejectClass` directly; only the wrapper's own test referenced it.
Function and test deleted.

### Duplicate code recorded as Issue #2 (session 75, per CLAUDE.md rule 3)
Three near-duplicate address-masking helpers: `cmd/otedama/main.go:499
maskAddress`, `internal/doctor/doctor.go:471 maskAddress` (byte-identical
to cmd), `internal/engine/setup.go maskAddr` (threshold ≤12 vs ≤10,
`…` vs `···` — same address renders differently in doctor output vs
engine logs). Not fixed: consolidation needs an architecture decision on
a shared home (no existing path fits; new paths need review). See
https://github.com/shizukutanaka/Otedama/issues/2.

### Whole-program dead-code triage (session 76)
`golang.org/x/tools/cmd/deadcode ./...` reports ~120 unreachable functions.
Triage so future sessions do not re-investigate:

**Deleted (genuinely dead):**
- `cmd/otedama maskAddress` — unreachable; only callers were two tests
  (one asserting consistency with doctor's copy). Reduces Issue #2's
  triplicate to a duplicate. Tests deleted with it.
- `doctor.SortedResults` (+3 tests) — speculative API. `Runner.Run`
  already writes results by check index (doctor.go:159), so output order
  is deterministic and matches the curated `DefaultChecks` order;
  alphabetical sorting would degrade the UX. No production caller ever
  appeared.
- `engine.classifyReject` (+1 test, session 75) — wrapper superseded by
  `rejectClass`.

**KEEP — planned-integration scaffolds (roadmap P1, do not delete):**
- all of `poolproto/stratumv1`, `poolproto/stratumv2`, and
  `poolproto.Register/Lookup/Available/DialURL/FromURL`, plus
  `engine.applyJob` — the engine→poolproto wiring (Step 3b) consumes
  these; heavily tested in sessions 72–73.
- all of `stratum/noise*` — Noise NX for `stratum+v2tls`, pending
  ADR-011 secp256k1; CODEOWNERS-protected.
- `btccrypto.*` registry + `secp256k1Stub` — ADR-011 scaffold.

**KEEP — test seams / QA mechanisms (the architecture depends on them):**
- `clock.NewFake/Fake.*` — the package's reason to exist (CLAUDE.md map).
- server→client `stratum` Encode methods + `wire.putB0_255` — used by the
  mock pool servers (`fakePool`, `poolSide`) in tests; Encode/Decode
  symmetry is a session-72 invariant.
- `i18n` `Catalog.IDs`/`Bundle.MissingTranslations`/`Bundle.Languages`/
  `messages.AllIDs` — drive the 10-language parity tests.
- `httpserver.Server.Addr`, `tui.Dashboard.SetWidth`,
  `provider.StaticRateSource` — test injection points.
- `miner.ParseHeader/NBitsFromTarget/MeetsTarget/Hash.String` — inverse
  ops used by property tests.
- `metrics.Counter.Add` — standard counter API surface with `Inc`.

**Recorded as candidates (decide later, not deleted):**
- `logger.IntoContext/FromContext/SetDefault` — context-logger plumbing;
  the codebase settled on explicit log-func injection instead. Tested but
  unused; removal would be API-shape decision.
- `tui.FormatHashRate/FormatDuration/SatsToDisplay` — "exported for the
  CLI status line" which never materialised; note `tui.FormatHashRate`
  overlaps `miner.HashRateString` (display-formatter duplication family,
  same class as Issue #2/#3).
- `lightning.WalletManager.Seed/Mnemonic/ChangePassphrase`,
  `MnemonicToEntropy`, `WordList.Index` — obvious future wallet-UX API
  (backup phrase display, passphrase rotation); CODEOWNERS territory,
  leave untouched.

### Staticcheck sweep (session 77)
`staticcheck ./...` findings, all fixed except the flagged one:
- **D (stratumv2 tests)** — SA2002: `writeMsgTo`/`doHandshake` called
  `t.Fatalf` from the mock pool's goroutine (`Fatalf` runs
  `runtime.Goexit`, only valid on the test goroutine). Now `t.Errorf` +
  early return.
- **D (stratumv1 tests)** — SA4011: ineffective `break` inside `select`
  in the difficulty-wait loop; after the one-shot `deadline` channel
  fired, the loop would spin forever on a failed assertion. Fixed with a
  labeled break.
- **G (provider)** — U1000: `MiningProvider.lastRate` field declared,
  never read or written. Deleted.
- **I (btccrypto tests)** — SA4006: two tautological length tests
  (`Hash256`/`TaggedHash` return `[32]byte`; `len != 32` can never be
  true). Deleted per the no-meaningless-tests rule.
- **Q (httpserver tests)** — U1000: unused `setupServer` helper (plus the
  orphaned design-note comments around it). Deleted.
- **E (engine tests)** — S1009: redundant `!= nil` before `len()`.
- 🚩 **C (noise)** — U1000: `HandshakeState.remoteStatic` field is
  unused. `internal/stratum/noise*` is CODEOWNERS/funds-critical; left
  for maintainer review (it may be a placeholder for the responder
  static-key check, or genuinely vestigial).

### Duplicate code recorded as Issue #3 (session 76, per CLAUDE.md rule 3)
`internal/doctor/doctor.go stripScheme` (returns `""` on unknown scheme)
near-duplicates `poolproto.StripScheme` (returns error). Same prefix
list, divergent failure semantics; a future scheme added to poolproto
would silently desync `otedama doctor`. Consolidation = dependency
decision (doctor currently does not import poolproto; no cycle if it
did). https://github.com/shizukutanaka/Otedama/issues/3

### Single-sourced the default pool URL (session 78)
`stratum+v2://public.stratum.slushpool.com:3336` was copy-pasted in four
sites (engine `defaultPoolURL`/`poolURLs`, doctor `checkPoolReachability`,
CLI startup banner). Hoisted to `config.DefaultPoolURL` (config is a pure
leaf already imported by all three consumers); literal now in one place.

### Duplication family — scheme list & address validators (session 79)
Recorded, not fixed (rule 3; consolidation is a layering decision):
- **Scheme-prefix list triplicated** — `poolproto.knownSchemes`
  (canonical), `config.validatePoolURL` (validation, error-returning),
  `doctor.stripScheme` (reachability, `""`-returning). Extends Issue #3
  (which had noted only the latter two). Verified: `config` is a pure
  leaf and `poolproto` does not import `config`, so neither importing the
  other would cycle — the blocker is purely whether the config resolver
  should depend on the protocol layer.
- **Bitcoin-address validators duplicated** — `config.validateBitcoinAddress`
  (len 26–90 + prefix 1/3/bc1, descriptive errors) vs
  `doctor.isLikelyBitcoinAddress` (same bounds + prefix set, **plus**
  bech32/base58 charset validation, bool). Shared facts (bounds, prefix
  set) duplicated; strictness and return type diverge. Note: CLAUDE.md
  designates `internal/btccrypto` as the Bitcoin abstraction home, so a
  future `btccrypto.ValidateMainnetAddress` could be the single source —
  an architecture decision, deferred.

### Categories with no actionable findings this pass
F (arbitration), I (btccrypto), L (CLI beyond items already fixed in
G1–G15 and sessions 71/78), P (logger), U (clock/version) — reviewed, no
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

---

## Sessions 243–247 update — excess-vs-deficiency triage

Same taxonomy, same disposition legend. This round split findings into two
kinds instead of one: **excess** (E-tag below — documentation, comments, or
config describing a capability that does not exist in code) and
**deficiency** (D-tag below — code that is genuinely missing, stubbed, or
architecturally incomplete). Every row was independently re-verified against
source (grep + Read) before being marked, by two parallel background audits
per session plus manual verification. Intended as the entry point for any
future session (Opus or Sonnet) picking this codebase back up: read this
table first, then follow the "Ref" column into `docs/KNOWN_LIMITATIONS.md`
or the cited file for full detail.

**Excess = fix by deleting/correcting a claim. Deficiency = fix by writing
code, or requires a product/infra decision before code can be written.**

### Excess — fixed sessions 243–247

| Cat | Finding | Ref |
|---|---|---|
| R | ✅ `hal.Capabilities.SHA256d` hardcoded `true` for every GPU → CPU thread oversubscription + share misattribution. | `internal/hal/gpu_linux.go`; KNOWN_LIMITATIONS §4 |
| R | ✅ Package doc for `internal/hal` described nonexistent `hal/asic`, `hal/cuda`, `hal/rocm`, `hal/cpu` driver subpackages. | `internal/hal/device.go` |
| V | ✅ `CONTRIBUTING.md`/`SECURITY.md`/`README.md` described a plugin architecture as shipped; `ROADMAP.md`'s own "Removed Milestones" table rejects it (no proven demand). | `docs/KNOWN_LIMITATIONS.md` §13 area |
| V | ✅ `SECURITY.md`/`README.md` described ZKP-based auth as adopted (present tense); `internal/auth/` is v4.0-scoped and does not exist. | CLAUDE.md architecture map |
| V | ✅ `SECURITY.md` listed an "official web management interface" in scope; no `web/`, none planned per CLAUDE.md. | — |
| V | ✅ `README.md` claimed OpenTelemetry tracing, signed binary distribution (cosign), a 4-stream arbitration engine — only 2 streams (mining, simulated AI) exist; cosign is v3.1.0-planned only. | `README.md` Core Features section |
| V | ✅ `README.md` + `internal/config/config.go` `Pools` doc both claimed a "built-in recommended pool list (Braiins/DEMAND/OCEAN/Luxor)"; actual fallback is one hardcoded constant, `config.DefaultPoolURL` (Slushpool). | `internal/engine/setup.go` `defaultPoolURL` |
| V | ✅ `docs/architecture.md` described a target architecture (gRPC/REST API layer, `internal/providers/` plural, full LDK integration) as current. | Disclaimer added at top of file |
| J | ✅ `docs/KNOWN_LIMITATIONS.md` §6 claimed the wallet "can register BOLT12-style payout proofs" — zero such code anywhere in repo. | — |
| V | ✅ `docs/adr/README.md` index marked ADR-007/008/009/010 "Accepted"; each ADR's own header says "Proposed". | — |
| J,V | ✅ Wallet cipher misdescribed as ChaCha20-Poly1305 in 7 files (`docs/API.md`, `docs/THREAT_MODEL.md`, `docs/MIGRATING-FROM-V2.md`, `docs/AUDIT_CHECKLIST.md`, `docs/adr/ADR-007`, `GODEBUG_NOTES.md`, original CHANGELOG entry) — real cipher is AES-256-GCM (`internal/lightning/seedstore.go`); ChaCha20-Poly1305 is the Noise NX transport's cipher. | — |
| N,V | ✅ `internal/doctor` warned "GPU increases hashrate ~150x"; `docs/TROUBLESHOOTING.md` advised "attach a GPU" for mining speed — both false now that R's SHA256d fix landed (GPU never mined in the first place; the claim was already fiction). | — |
| K | ✅ `Config.DataDir` doc promised OS-appropriate auto-resolution; no code implemented it — see Deficiency-turned-fix D-prior below (this is the doc-vs-code gap that *caused* the real bug, listed here for the "excess claim" half of it). | `internal/config/config.go` `DefaultDataDir` |

### Deficiency — fixed sessions 243–247 (real code was missing/wrong)

| Cat | Finding | Ref |
|---|---|---|
| K,J | ✅ **Fund-safety.** `DefaultDataDir()` did not exist; `DataDir` stayed `""` with no flag/env/file value, and `engine.setupWallet` silently skips wallet init on empty `DataDir` — every user who never passed `--data-dir` got no wallet, no error. Implemented `config.DefaultDataDir()` (XDG/macOS/Windows) and wired into `ResolveWithOrigins`. | `internal/config/config.go`; test `TestResolve_DataDirDefaultsToOSPath` |
| M,J | ✅ **Fund-safety, same root.** Generated systemd unit set `ProtectHome=read-only` with no `ReadWritePaths=` exception, blocking `wallet.dat` writes under `$HOME`. Added conditional `ReadWritePaths=`. | `internal/daemon/service.go` `systemdUnit`; test `TestSystemdUnit_ReadWritePathsMatchesDataDir` |
| E,F | ✅ `applyAllocation` called `SetWork(nil)` on **every** worker instead of the one named by `Assignment.DeviceID` — latent (only 1 SHA256d device exists today) but would silently stop unrelated devices mining once a 2nd SHA256d device exists (e.g. future ASIC driver). Fixed with `pauseDevice` filtered by `w.DeviceID()`. | `internal/engine/arbitrate.go`; test `TestApplyAllocation_OnlyPausesTargetDevice` |
| Q | ✅ `/readyz` doc overstated its gate ("pool connected, at least one worker hashing"); real gate is only "pool session established" — no job/hash requirement. | `internal/httpserver/server.go` |
| C | 🚩 `hmacSHA256Pooled` (GC-pressure optimization) is implemented + correctness-tested + benchmarked but **not wired** into `hkdf2`/`hkdf3` in the live handshake — noise.go/noise_pool.go are CODEOWNERS-gated funds-critical, so the wiring itself was deliberately left for reviewed follow-up; only the doc comment was corrected. | `internal/stratum/noise_pool.go` |
| L | ✅ `internal/doctor` checks.go duplicated a Linux-only data-dir fallback instead of reusing the (now-existing) shared resolver — also silently wrong on macOS/Windows. Unified onto `config.DefaultDataDir()`. | `internal/doctor/checks.go` |

### Deficiency — NOT fixed, flagged for maintainer decision (this is the actionable backlog)

| Cat | Finding | Priority | Ref |
|---|---|---|---|
| I | 🚩 `internal/btccrypto` secp256k1 Verify/PublicKeyFromBytes/SignatureFromBytes are namespace-reserving stubs returning `ErrSchemeNotImplemented`; ADR-006 ("Accepted") describes them as "concrete implementations" — doc contradicts code. Real dependency (`decred/dcrd/dcrec/secp256k1`) not yet in `go.mod` (ADR-011, Accepted-but-pending). | **High** — core Bitcoin signing is unimplemented | KNOWN_LIMITATIONS §5 |
| C | 🚩 Noise NX not wired into any live connection except `stratum+v2tls://`; default `stratum+v2://` is plaintext. | **High** — funds/privacy adjacent | KNOWN_LIMITATIONS §2 |
| D | ⏸ `poolproto` package doc and `stratumv1.go` describe DATUM as a present-tense supported protocol ("Otedama can speak... DATUM"); reality: `ProtocolDATUM` is a URL-scheme constant only, no `Dialer` registered, no `internal/poolproto/datum` package exists. Not yet disclosed in KNOWN_LIMITATIONS. | Medium | found session 246, unfixed |
| V | ⏸ `.github/workflows/deploy.yml` — non-Go npm/Helm pipeline fails on every push/PR; references forbidden/nonexistent `kubernetes/helm/`. | High (false-negative CI signal on every push) | KNOWN_LIMITATIONS §13 |
| V | ⏸ `.github/workflows/ci-cd.yml` — near-duplicate of `ci.yml`, Go version matrix (1.20/1.21) below `go.mod`'s `go 1.22` minimum, references forbidden `k8s/`. | Medium (likely just delete) | KNOWN_LIMITATIONS §13 |
| V | ⏸ `.github/workflows/ci.yml` `docker-verify*` jobs reference nonexistent `scripts/`, poll `/health` (real path is `/healthz`), never pass `--bitcoin-address`/`--http-addr` so the container just prints help and exits regardless of path fix; `docker-verify-cgo0-postgres` tests a nonexistent Postgres/database layer; deploy jobs apply forbidden `k8s/*.yaml`. | High (819-line file, multiple broken jobs) | KNOWN_LIMITATIONS §13 |
| V | ⏸ `.github/workflows/release.yml` `build-packages` job references nonexistent `scripts/post-install.sh`, `scripts/pre-remove.sh`, `scripts/otedama.service`, root `config.yaml`. | Medium | KNOWN_LIMITATIONS §13 |
| V | ⏸ `.github/workflows/code-review.yml` is entirely Node.js/npm-oriented; always a no-op for this Go-only repo (posts a static "no Node.js project" comment, never runs Go lint/review). | Medium | KNOWN_LIMITATIONS §13 |
| V | ⏸ `.github/workflows/security.yml` `security-tests` job references nonexistent `tests/security/`, `tests/load/` directories — fails deterministically if triggered. | Medium | KNOWN_LIMITATIONS §13 |
| V | 🚩 `.github/workflows/security.yml` `compliance-check`'s hardcoded-IP grep fails deterministically against this repo's own legitimate `127.0.0.1`/`1.1.1.1` addresses (flag help text, doctor's DNS check). **A proposed downgrade to non-fatal `::warning::` was blocked by the safety classifier session 247 as an unauthorized weakening of a security gate — needs explicit user sign-off before any fix, mechanical or otherwise.** | High-but-blocked | KNOWN_LIMITATIONS §13 |
| V | ⏸ CLAUDE.md's own architecture map labels `test.yml` `(fuzz+benchmark)`; actual jobs are `test/lint/security/build/integration/benchmark` — no fuzz job, though `internal/stratum/frame_fuzz_test.go` and `make fuzz` exist locally and are simply never invoked by CI. | Medium | — |

### Reading order for a fresh session

1. `docs/KNOWN_LIMITATIONS.md` — user-facing, exhaustive, per-item impact/workaround/target.
2. This table — triage view, points at exactly which file/line to open next.
3. `docs/SPECIFICATION.md`'s gap table (`G1`–`G19`) — spec-vs-code discrepancies specifically.
4. `ROADMAP.md` — confirmed vs. removed milestones, so a fix doesn't reintroduce something already rejected (e.g. plugin architecture, multi-currency).
5. `skills/quality-pass-opus.md` / `skills/quality-pass-sonnet.md` (added session 253) — model-specific continuation playbooks: verified strengths/weaknesses, a prioritized improvement queue with blockers, the verification loop, and the working discipline this whole pass has followed. A fresh Opus or Sonnet session can read just its own file to start.

---

## Session 250 update — "frontend" (TUI + CLI) real-UX audit

Everything above (sessions 243–248) was mostly doc-vs-code accuracy work.
This round specifically targeted user-facing quality in `internal/tui/`
(category S) and `cmd/otedama/` (category L) — what a real operator
actually experiences — rather than doc claims. All confirmed by building
the binary and driving real invocations, not just reading source.

| Cat | Finding | Disposition |
|---|---|---|
| S,E | TUI wrote raw ANSI escape codes to stdout unconditionally — redirecting output (`> log.txt`, `\| tee`, any non-interactive capture) produced an unreadable, ever-growing stream of cursor-control noise instead of logs. No TTY detection existed anywhere in the codebase. | ✅ Fixed: `cmd/otedama/run.go` `isTerminal` (stdlib-only, `os.ModeCharDevice`) auto-disables the TUI when stdout is not a terminal; `--no-tui` still works as an explicit override. Tests: `TestIsTerminal_*`. |
| M,S | `otedama service install` (a first-class, documented workflow) produces a unit that runs with the TUI on and no `--log-file` — since a service never has a controlling terminal, this meant `journalctl`/launchd logs filled with ANSI noise forever while the structured logger was silently discarded (`logger.Discard()`). No flag existed to fix this short of hand-editing the generated unit. | ✅ Fixed as a side effect of the TTY-detection fix above: systemd/launchd capture stdout as a non-TTY pipe, so `isTerminal` now auto-flips to `--no-tui` behavior for every service-managed run, and `buildLogger` falls through to its plain-stdout branch — real structured logs now reach `journalctl`/the launchd log file with zero additional flags needed. |
| S | `poolLine`/`miningLine` truncated the pool URL and share-count fields using **fixed** budgets (hardcoded 40 / 20 chars) independent of the actual configured `cols`. At the documented 40-column minimum, the connection-status text ("✓ connected"/"✗ disconnected") — the single most important field on the line — could be truncated away entirely by `writeLine`'s right-side cut before it was ever reached. | ✅ Fixed: both functions now take `cols` and compute the variable-length field's budget from it (`cols - fixed-overhead`), with status placed so it is never the part that gets cut. Test: `TestDashboard_PoolLine_ConnectionStatusSurvivesNarrowWidth`. |
| S | Package doc claimed terminal width is "detected at startup via TIOCGWINSZ (Unix) or GetConsoleScreenBufferInfo (Windows)"; `SetWidth` exists but is called only from test files — every real invocation renders at the hardcoded 80-column default regardless of actual terminal size. | ⏸ Deferred (doc corrected to state the gap honestly; disclosed as KNOWN_LIMITATIONS §15). Needs a maintainer decision: add `golang.org/x/term` as a new direct dependency (exception to ADR-003's zero-dependency stance) vs. hand-roll per-platform syscalls via the already-indirect `golang.org/x/sys`. |
| L | `config show --help` / `config validate --help` printed `Usage of run:` (the shared `flag.FlagSet`'s hardcoded name) and dumped all 15 `run` flags, more than a third of which are no-ops for those two subcommands (`--dry-run`, `--no-tui`, `--pprof`, `--wallet-passphrase`, `--wallet-mnemonic-passphrase`, `--log-file`). | ✅ Fixed: `parseRunFlags` now takes a `name` parameter (each of the 3 call sites passes its real command name), and every run-only flag's help text is prefixed `(run only)`, matching the existing `(config show only)` convention already used for `--origin`/`--json`. |
| L | No typo tolerance / "did you mean" for subcommands (`otedama rnu` → generic "unknown subcommand" + full usage dump). | ⏸ Deferred — real but low-severity; the existing fallback (full usage block) is a reasonable floor. Not fixed this session. |

Categories checked and found clean this round: config-validation error messages (consistently field-labeled and actionable), `doctor` output (every finding pairs with a `→ fix:` hint), documented exit-code contract (0/1/64/78, verified live), `run --help` flag descriptions (all accurate), explicit `--help` routing to stdout/exit 0 across all subcommands, flag-naming consistency across `run`/`service install`/`doctor`.

All 24 packages build, vet, and test green.

---

## Session 252 update — miner + stratum wire-level correctness audit

Independent audit of `internal/miner` and `internal/stratum` wire code
(excluding `noise*`, which is CODEOWNERS-gated and covered separately),
looking specifically for hot-path correctness and protocol-fidelity bugs.

| Cat | Finding | Disposition |
|---|---|---|
| A | `WorkerConfig.NonceStep` field doc said "Zero is replaced with 1" but `NewWorker` resolves it to `Threads` — a trap where a future maintainer "fixing" the code to match the doc would make all `Threads` goroutines redundantly grind the identical nonce sequence, silently losing `(Threads-1)/Threads` of hash rate. Code was correct; doc was wrong. | ✅ Fixed (doc corrected to match implementation). |
| B | `OpenMiningChannelSuccess.Extranonce` is SV2 type B0_32 (max 32 bytes) but was encoded/decoded with the B0_255 (max 255) helpers — a spec-fidelity gap, not a memory-safety bug (B0_255 is still bounded/allocation-safe). | ✅ Fixed on the encode side (new `appendB0_32` caps at 32); decode intentionally left lenient (Postel's law — accepts a longer non-conformant value rather than dropping a working connection), documented at both the field and the decode call site, and pinned by two new tests. |

Verified clean by direct reading (not just doc-checking): SHA-256d
correctness (genesis-block vector), nonce-space partitioning across
threads, `Hash.LessOrEqual` big-endian-value target comparison, `SetWork`
torn-read safety (whole-pointer swap under mutex, immutable `*Work`
snapshot in `grind`), atomic stats counters (no double-count / lost
update), STR0_255/B0_255 length-prefix bounds (no overflow, proper
truncation handling), U24 frame-length validated against `MaxFrameSize`
*before* allocation, `Encode`/`Decode` round-trips for every production
SV2 message (including `NewMiningJob`'s optional `min_ntime` branch), and
decode-error propagation (live reader terminates the session on error
rather than feeding zero-value job data to the miner).

All 24 packages build, vet, and test green.

---

## Session 262 update — run.go session state machine, error/abnormal paths

Close read of `internal/engine/run.go` session loops (queue item 4), on
the finding-has-value-only-if-new rule.

| Finding | Disposition |
|---|---|
| V2 outstanding-job map `jobs` was unbounded: `NewMiningJob` accumulated per receipt and was only cleared on `SetNewPrevHash`, so a pool streaming future jobs without a tip update grew session memory without bound. | ✅ Fixed: `storeJob` bounds it at 256 with FIFO eviction (mirrors `submissions` cap 1024 and V1 job-ID map cap 1024); eviction drops the oldest entry, the least likely to be named by a later `SetNewPrevHash`. |
| After `isCurtailed()` lifted, hashing resumed only when the pool's next `NewMiningJob`/notify arrived — minutes of needless idle on a quiet pool. | ✅ Fixed: `resumeCh` (cap-1 buffered, non-blocking send) plumbed Run→reconnect→session; the price goroutine nudges on uncurtail. V2 re-issues `startJob(active, activeNTime)`; V1 re-`applyJob`s `lastV1Job` (job-ID map resolution made unconditional so the resume target is always registered). |
| Reconnect budget / backoff reset suspicion | ⏭ Not a defect — already fixed by parallel session (devin branch `reconnect-budget-reset`); verified its diff before claiming. |

Tests: `TestStoreJob_BoundsAndEvictsOldest`, `TestRunSession_ResumeReArmsJobAfterUncurtail` (V2 e2e via fakePool), `TestRunSessionV1_ResumeReArmsJob` (V1 e2e via in-process JSON-RPC pool).

All 24 packages build, vet, and test green.

---

## Session 268 update — V1 client.reconnect advisory-wait handling

| Finding | Disposition |
|---|---|
| `client.reconnect` / `mining.reconnect` parsed a full directive (host, port, wait) into `session.lastReconnect` — but nothing ever read it. The pool's advisory wait (seconds to hold off before re-dialling, e.g. a maintenance drain) was dead state: the reconnect loop always slept its own exponential backoff and re-dialled straight back into a draining node. | ✅ Fixed: `poolproto.ReconnectInformer` optional interface surfaces only the advisory wait (`LastReconnectWait`) — the pool-supplied host:port stays unexposed (unauthenticated redirection vector, the existing `reconnectDirective` rationale). `runSessionV1` writes it to `sessionOpts.reconnectWaitSecs` on unwind; `runReconnectLoop` sleeps `max(backoff, min(wait, reconnectBackoffMax))` before the next dial — clamped so a hostile/buggy pool cannot pin the miner offline. |

Tests: `TestSession_LastReconnectWait_FalseBeforeDirective`, `LastReconnectWait` assertion in the client.reconnect e2e, `TestRunSessionV1_RecordsPoolReconnectWait` (in-process pool sends a 42s directive).

All 24 packages build, vet, and test green.

---

## Session 269 update — arbitration non-finite hardening + property test

| Finding | Disposition |
|---|---|
| `Decide`'s `< 0` validation let `NaN` through (`NaN < 0` is false): `MinYieldSatsPerSec=NaN` silently disabled the profitability floor (`y < NaN` is false for all y), `HysteresisMargin=NaN` made every switch threshold NaN so hysteresis was silently lost. | ✅ Fixed: both fields now require finite non-negative values (error on NaN/±Inf/negative). |
| `chooseForDevice`'s `y <= 0` filter let `NaN` through the same way — a lone NaN-quoting stream won the device and put `ExpectedYield=NaN` into the allocation (propagates to `TotalYield` and the metrics writer), while a `+Inf` quote beat every real stream unconditionally. | ✅ Fixed: non-finite quotes are rejected alongside non-positive yields; device idles rather than run a garbage quote. |
| `mining.set_extranonce` mutates `session.extranonce1`/`extranonce2Size` from the read loop while `Submit` reads them — data race + stale-extranonce share-invalidating semantic gap. | ⏭ Not a defect to claim — already fixed by parallel session (devin branch `setextranonce-race`, atomic.Int32 + en2 rotation); verified its diff before claiming. |
| V1 job-ID string↔uint32 map unbounded growth | ⏭ Not a defect — already bounded at `v1JobIDMapCap=1024` with paired-map reset (session 262's pattern, pre-existing). |

Also implemented the property-test requirement CLAUDE.md places on the
arbitration engine: `FuzzDecide` decodes devices/streams/policy/margins/
previous-allocation from fuzz bytes (wild `Float64frombits` scalars so
NaN/±Inf actually reach the engine) and asserts the documented
invariants — determinism, one assignment per device, family acceptance,
floor compliance, finite `ExpectedYield`, `Held` ⇒ previous stream,
`ForegoneSatsPerSec ≥ 0`, `TotalYield = Σ`. 6.7M execs, no crash.

Tests: `FuzzDecide`, `TestDecide_RejectsNonFiniteMargins`,
`TestDecide_NonFiniteYieldNeverAssigned`.

All 24 packages build, vet, and test green.

---

## Session 270 update — V1 set_extranonce stale-work invalidation

| Finding | Disposition |
|---|---|
| `mining.set_extranonce` updated `extranonce1`/`extranonce2Size` but left jobs already queued in `jobsCh` intact. Those jobs were built under the retired extranonce1 — the client computes the coinbase (`coinb1 + en1 + en2 + coinb2`) and hence the merkle root with the old nonce-space, so every share mined from them is a guaranteed reject under the new extranonce. Standard clients (cgminer, bfgminer) treat extranonce rotation as work invalidation like `clean_jobs`. | ✅ Fixed: `purgeJobs()` (extracted from the clean_jobs path) now runs on a parsed `set_extranonce`; queued stale jobs are drained and the next notify re-arms the miner under the new nonce-space. |
| Race: `extranonce2Size` written by the read loop, read by `Submit` on the engine's goroutine | ⏭ Not a defect to claim — fixed by parallel session (branch `setextranonce-race`: atomic.Int32 + en2 rotation); verified its diff before claiming. The stale-work purge was NOT covered there — this session's change is orthogonal (small merge overlap expected on the same `case` block). |

Tests: `TestSession_E2E_SetExtranoncePurgesPendingJobs` — net.Pipe pool queues two jobs (clean_jobs=false so only the rotation can purge), sends `set_extranonce`, then a `set_difficulty` marker (proves the read loop passed the rotation before the consumer drains) and a new job; asserts the only surviving job is the post-rotation one.

All 24 packages build, vet, and test green.

## Session 271 update — arbitration_policy config knob

| Finding | Disposition |
|---|---|
| The arbitration engine implements four scoring policies (`maximize_earnings`, `stack_btc`, `maximize_privacy`, `environment_friendly`), but `runArbitrationLoop` hardcoded `PolicyMaximizeEarnings` in its Decide input — three of the four were unreachable from any configuration surface. No `policy` config field existed, so this was an unexposed feature rather than dead config. | ✅ Fixed: new `arbitration_policy` YAML key + `OTEDAMA_ARBITRATION_POLICY` env var plumbed through `Config`, `Origins`, `config show` (text + JSON + `--origin`), `config.Validate`, `arbitrationLoopOpts`, and the `Decide` input. `arbitration.ParsePolicy` added so config and engine share one source of truth for the policy names (round-trip vs `String()` tested). Empty stays the default (`maximize_earnings`), matching the optional-string convention of `pools[].payout_scheme`. |
| Scoring semantics worth stating exactly (verified in `policyScore`): `stack_btc` multiplies BTC-native streams ×1.05; `maximize_privacy`/`environment_friendly` add +1% per rating point (0–10, max +10%). These are near-tie breakers — a materially higher raw yield always still wins. | ✅ Documented on the Config field, `config.yaml.example`, and SPECIFICATION §3. |
| `Validate` initially rejected `""` — broke pre-existing tests that build `Config{}` literals. | ✅ Fixed: empty means "unset → default", same as other optional string fields. |

Tests: `TestParsePolicy` (round-trip + reject set), `TestValidate_RejectsUnknownArbitrationPolicy` + `TestValidate_AcceptsAllValidArbitrationPolicies`, `TestArbitrationPolicy_EnvOverride`/`_FileOverride`/`_DefaultIsMaximizeEarnings`, `TestArbitrationPolicyFromConfig`, and `TestRunArbitrationLoop_PolicyReachesDecide` — the last proves the policy actually reaches Decide by routing a device to a lower-yield (95 vs 100 sats/s) but fully environment-rated stream via the TUI activity map (score 95×1.1 = 104.5 > 100, only possible under `environment_friendly`).

All 24 packages build, vet, and test green.

## Session 272 update — Noise transcript-init spec divergences (funds-gated: docs/comments only)

Queue item 4's open half — deep-read of `internal/stratum/noise.go`'s handshake state machine for findings beyond the two already on record (P-256 stub; unauthenticated responder static + no-DH x-only fallback + discarded `k`).

| Finding | Disposition |
|---|---|
| `NewHandshakeInitiator` passes `"Noise_NX_secp256k1_ChaChaPoly_SHA256"` to `initialize` — NOT the SV2 spec's `Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256` (case differs; `+EllSwift` missing). Noise seeds `h`/`ck` from the name, so a spec responder derives a different handshake hash before any DH. Verified against sv2-spec `04-Protocol-Security.md` §4.5.1 (primary source fetched). | ✅ Documented: KNOWN_LIMITATIONS §2 item 4 + in-code note at the call site. No behaviour change — fixing the literal is part of the maintainer-gated message-flow rework; the code has no live callers today. |
| `initialize` omits the spec's third act-1 step `h = HASH(h)` (after `ck = h`), leaving `h == ck`. For a >32-byte name the spec wants `h = HASH(HASH(protocolName))`; the first `mixHash` already diverges. Verified against same §4.5.1 steps 1–4. | ✅ Same disposition: documented on the function + KNOWN_LIMITATIONS §2 item 4. |
| `CipherState.Decrypt` consumes a nonce even when `aead.Open` fails | ℹ️ Noted, no action: Noise requires terminating the session on any auth failure, so post-failure nonce state is moot in practice; `EncryptedConn.Read` surfaces the error and the engine tears down on read errors. Not worth a KNOWN_LIMITATIONS entry. |
| `EncryptedConn.Read` on a zero-length frame: `ctLen=0` → `aead.Open` of empty ciphertext fails cleanly | ✅ Clean (correct malformed-input handling). `Write` also rejects oversized ciphertext before the u16 prefix overflows — checked. |
| `internal/stratum/handshake.go`, `wire.go`, `tls.go` (non-gated siblings) | ✅ Clean: message codecs match SV2 layouts (incl. Postel-strict `appendB0_32`/lenient `getB0_255` extranonce), `DialTLS` never downgrades, `defaultTLSConfig` TLS1.2+ verified. |
| `internal/engine/arbitrate.go` remainder (`streamsSlice` same-ID merge, `applyAllocation` per-device pause) | ✅ Clean: merge preserves per-device yields; pause is correctly device-scoped (session-247 fix verified in place). |

All 24 packages build, vet, and test green. Comment-only change inside `internal/stratum/noise*` per the funds-area gate (doc corrections permitted; no behaviour changed).

## Session 273 update — TUI EARNINGS line double-counted mining yield

Provider-package + TUI audit (`polling.go`, `provider.go`, `mining.go`, `ai_inference.go`, `dashboard.go`).

| Finding | Disposition |
|---|---|
| `earningsLine` added `HashRate × satsPerHash` AND every active provider's `SatsPerSecond` — but `mining.stratum`'s quote is the same quantity: computed from the same live `worker.Stats().HashRate` (wired via `HashrateFunc`, setup.go) with the same network constant (1e21 H/s, 3.125 BTC, 600 s), net of the 1% pool fee. In the common configuration (mining provider active — the only market CPU/ASIC can route to), the dashboard's expected-earnings figure read ~1.99× the real value. | ✅ Fixed: `ProviderStats.IsMining` (set in stats.go on `p.ID() == "mining.stratum"`, matching arbitrate.go's literal convention). When an active provider is the mining one, its quote stands in for the hashrate-derived term; non-mining actives still add, inactive mining → hashrate fallback preserved. `TestDashboard_EarningsLine_MiningQuoteNotDoubleCounted` covers both branches. |
| `time.NewTicker(p.interval)` in pollingProvider.loop — panic if interval ≤ 0 | ℹ️ Not a defect: both callers hardcode 30 s / 60 s; `interval` is unreachable from config. statsInterval in run.go is separately guarded (≤0 → 10 s). |
| `mining.go` fetches `BTCUSDRate` then discards it (`_ = rate`) — yield math uses no price | ℹ️ Kept, with a mild honesty note worth a maintainer eyeball: `Confidence` still tracks feed freshness (0.95 fresh / 0.7 stale) although the quote ignores the rate. Feed-failure therefore *devalues* a quote that never used the feed — but symmetrically across both providers' confidence treatment, so no systematic routing bias was shown. Not changed; recorded here. |
| `pollingProvider` lifecycle (launch/loop/Stop/sendQuote drop-oldest, quoteCh recreate-after-Wait) | ✅ Clean: single writer, double-start rejected, restart-safe, no leak. `AkashProvider.publish` device filter + zero-yield no-GPU path correct. |
| `Dashboard` render loop / Update drain / Stop ordering / ANSI width handling | ✅ Clean: wg.Wait before Stop's writes, emoji-free section labels after a prior fix, CSI-aware visibleLen/truncateVisible correct. |

All affected packages build, vet, and test green; gofumpt clean.

## Session 274 update — `service status`/`uninstall` created config dirs as side effects

Daemon/service + stratum messages audit.

| Finding | Disposition |
|---|---|
| `systemdUnitPath`/`launchdPlistPath` called `os.MkdirAll` unconditionally, and `statusSystemd`/`statusLaunchd`/`uninstallSystemd`/`uninstallLaunchd` all used them — so a read-only `otedama service status` created `~/.config/systemd/user` / `~/Library/LaunchAgents` on machines where the service was never installed, and `uninstall` left a fresh empty dir behind. | ✅ Fixed: new pure resolvers `systemdUnitDir`/`launchdAgentsDir` (no mkdir) for status/uninstall; the mkdir-ing helpers stay for install (and remain pinned by `TestSystemdUnitPath_CreatesDirectory`). 3 new side-effect tests. |
| `uninstall` errors when the unit file is absent | ℹ️ Pinned by `TestUninstallSystemd_FileNotFound` — an explicit test decision, not a defect; left as-is and noted here so it isn't "re-fixed" later. |
| `DecodeSubmitSharesError` accepts an 8-byte payload (channel_id+seq only) and yields an empty error string — a payload that omits the STR0_255 entirely is silently treated as empty | ℹ️ Postel-leniency consistent with the file's trailing-byte leniency; empty error renders identically to a real empty one. Noted, not changed (a strict parser would still have nothing to display). |
| `internal/stratum/messages.go` codecs (NewMiningJob OPTION tag, SetNewPrevHash, SetTarget, SubmitShares* bounds), `frame.go` (bound-before-alloc, U24/channel-msg rules), `metrics/runtime.go` (label escaping) | ✅ Clean. gofumpt also normalized `0644/0755` → `0o644/0o755` across the touched files. |

daemon package tests green; lint shows only pre-existing findings (documented `nilerr` in statusWindowsService, `behaviour` misspell).

## Session 275 update — `ClassifyAddress` rejected all-uppercase bech32 that the validator accepts

btccrypto + cmd/otedama + logger/clock/version/i18n audit.

| Finding | Disposition |
|---|---|
| `ValidateBech32Address` accepts BIP-173's all-uppercase encoding ("BC1Q…"/"BC1P…"), but `ClassifyAddress` — which feeds doctor's payout-type label — matched only the lowercase "bc1p"/"bc1q" prefixes, so a *valid* uppercase address validated and was then labelled "unrecognised type". | ✅ Fixed: prefix match now lower-cases the input first (base58 "1"/"3" prefixes are digits and case-free). New test covers all three uppercase types. |
| `loadConfigFile` returns defaults with no warning when the given path does not exist — including an explicitly passed `--config /typo.yaml`, so a typo'd config path is silently ignored | ℹ️ Pinned by `TestLoadConfigFile_NonExistent` (explicitly asserts *no* stderr for a missing explicit path). Debatable UX but an explicit test decision; recorded, not reversed. |
| `internal/btccrypto/base58.go` (big.Int decode, leading-'1' zeroes, 25-byte+checksum+version check), `bech32.go` (BIP-173/350 polymod, hrp, convertBits leftover-bit rules, version/program-length table), `btccrypto.go` (registry, AddressType, scheme dispatch), `secp256k1.go` (honest ErrSchemeNotImplemented stubs), `ValidateAddress` dispatch (checksum error surfaces for bc1…, ErrUnrecognisedAddress for neither) | ✅ Clean. Payout addresses are checksum-verified both at config load and in doctor. |
| `cmd/otedama` run/main/service/configfile/doctor/completion: help→stdout/exit-0 plumbing, TUI auto-disable on non-tty stdout, logger sink matrix, signal handling, POSIX locale precedence (LC_ALL C suppresses LANG), completion lists in sync with dispatch | ✅ Clean. `engine.Run` returns raw `ctx.Err()` so cmdRun's `!= context.Canceled` comparison is correct on the current path. |
| `internal/logger` (atomic default, Discard, Adapter), `internal/clock` (Fake RWMutex), `internal/version` (ldflags vars), `internal/i18n` (immutable catalogs, English fallback, MissingTranslations) | ✅ Clean. |

lint/deadcode on changed files show only pre-existing findings (G115/cyclomatic on bech32.go, misspell 'recognise' series, scaffolded-API unreachable funcs).

## Session 276 update — hal detector nil-device panic + doctor pre-check/severity-mask fixes

hal + miner + doctor audit.

| Finding | Disposition |
|---|---|
| `detector.Detect` rejects malformed driver output via `dev.Identity().Validate()` — but a `nil` Device in a driver's slice panicked before reaching the check. | ✅ Fixed: nil devices are now filtered with the same logged-rejection path as invalid identities. New test `TestDetector_RejectsNilDevices`. |
| `isLikelyBitcoinAddress` (doctor's cheap pre-check) required the lowercase bech32 charset, so a valid all-uppercase `BC1…` payout address (accepted by `ValidateBech32Address`) failed with a misleading "does not look like a valid address" before the real validator ran. | ✅ Fixed: folds to lowercase for the `bc1` prefix + charset test. New uppercase pre-check test. |
| `checkPoolTLSCA` returned immediately on the *first* pool's Warn (tls_ca_file on non-TLS scheme), so a later pool's unreadable/invalid CA file — a Fail — was masked. | ✅ Fixed: Warn is deferred and the scan continues; Fail still returns immediately. New test `TestCheckPoolTLSCA_WarnDoesNotMaskLaterFail`. |
| `internal/hal` device.go/registry.go/gpu_linux.go (driver contract, dedup, honest SHA256d=false) | ✅ Clean beyond the nil guard. |
| `internal/miner` sha256d.go (nBits decode incl. sign-bit/zero-mantissa/overflow rejects, diff1Target fractional-difficulty path), coinbase.go (V1 coinbase concat + merkle fold conventions) | ✅ Clean. |
| `internal/doctor` doctor.go runner + checks.go remaining 15 checks (config/address/failover/datadir/wallet/reachability/diversity/endpoint-diversity/encryption/TLSCA/payout/power/floor/hardware/network/clockskew/envvars) | ✅ Clean beyond the two fixes. Per-check ctx-honouring is by contract (cmd wraps 30 s); a ctx-ignoring check would hang — noted, not changed (no such check exists today). |

doctor/hal package tests green; lint/deadcode show only pre-existing findings (hugeParam on cfg params, British-spelling misspell).

## Session 277 update — stratumv1 idempotent-start contract + non-finite guards + TLS doc honesty

engine remainder (stats/setup/metrics/fanin), poolproto interface layer, stratumv1 package (4 files), and lightning package (read-only; maintainer-gated) audit.

| Finding | Disposition |
|---|---|
| `session.start` documented "Idempotent" but was not: a second call spawned a second readLoop whose deferred `close(jobsCh)`/`close(noticeCh)` double-closed on exit → panic, plus a ctxCancel write race. | ✅ Fixed: `sync.Once` makes the documented contract real. New test `TestSession_StartIsIdempotent`. |
| `LatencyTracker.Record` rejected `ms < 0` but admitted NaN — a NaN sample sits in the ring forever and `Quantile` could return it, poisoning submit-latency gauges. | ✅ Fixed: `!(ms >= 0)` rejects negatives and NaN alike. New test `TestLatencyTracker_RecordRejectsNaN`. |
| `effectiveYield` — same non-finite class: NaN fraction slipped both `> 1` and `< 0` clamps; NaN/+Inf expected yield propagated to the gauge. | ✅ Fixed: NaN fraction clamps to 0, non-finite expected yield returns 0. New test `TestEffectiveYield_NonFiniteInputsReturnZero`. |
| `tlsConfigWithExtraCAs` doc claimed "system root store plus PEM" — when `x509.SystemCertPool` fails it silently narrows to PEM-only. | ✅ Doc corrected (fail-closed narrowing is the safe behaviour; documented rather than changed). |
| `extranonce2Size` data race (readLoop writes, Submit reads) | ⏸ Deferred: owned by parallel session `devin/1790137453-setextranonce-race` (atomic field + en2 counter + ping/version responders). Not duplicated here to avoid a conflicting fix. |
| `NewWalletManager` first-run TOCTOU: stat→createNew race between two simultaneous instances lets the second silently overwrite the first's wallet.dat (a funds-key loss if the first's mnemonic was never backed up). | 📝 Recorded: internal/lightning is maintainer-gated (CLAUDE.md); noted for CODEOWNERS review, no change. |
| `MnemonicToSeed` leaves PBKDF2 intermediates (password/mnemonic bytes, raw seed slice) unwiped — inconsistent with seedstore.go's zeroBytes hygiene. | 📝 Recorded: same gating; doc-comment-only changes are permitted in noise*, wallet hygiene is not noise*. |
| `session.start` callers verified single-call (dialer only); `fanIn` ctx-aware fan-in, `buildStats`, `publishBTCRate`, `poolproto` registry/scheme table, `rpcMessage` dispatch, `parseNotify` per-word swap + lenient hex, `dialer.Negotiate` handshake ordering, `seedstore` scrypt+AES-GCM + opaque ErrWrongPassphrase, `wallet.save` atomic rename + 0600-before-rename, `MnemonicToEntropy` constant-accumulate checksum | ✅ Clean. |

## Session 278 update — build/release surface audit (Dockerfile + Makefile)

Same class as session 260's install.sh audit: distribution/build paths that
had never been exercised. Six confirmed-broken targets/fixes:

| Finding | Disposition |
|---|---|
| `make docs` ran `go doc -all ./...` — `go doc` takes one package, never expands `...` patterns → always failed "cannot find package". | ✅ Fixed: iterate `go list ./...` per package. Verified producing 196 KB of real output. |
| `make fuzz` fed `grep -l` *file* paths to `go test -fuzz` which takes *package* paths → compiled as command-line-arguments, undefined-symbol failure on the first package. | ✅ Fixed: `dirname` the matching test files, `sort -u`, pass `./<dir>`. Verified loop output resolves real packages. |
| `make migrate-from-v2` referenced `otedama migrate-from-v2` — the subcommand does not exist (echoed a command that always fails). | ✅ Removed with a comment (same precedent as the removed test-e2e target). |
| `make docker-run` mounted `config.yaml` to `/etc/otedama/config.yaml` — a path nothing reads (loader uses `~/.config/...` or `--config`) — and the image's default CMD is `run --help`, so it exited without mining. | ✅ Fixed: passes `run --config /etc/otedama/config.yaml`; guards a missing local config.yaml. |
| `make docker-build` never passed the Dockerfile's VERSION/COMMIT/BUILD_DATE args → every image binary reported `version dev`. | ✅ Fixed: `--build-arg` all three. |
| Makefile lint/test targets ran under whatever `go` resolved — `golangci-lint` reads compiled export data and fails on version mismatch unless GOTOOLCHAIN pins to go.mod's toolchain. | ✅ Fixed: `export GOTOOLCHAIN` derived from go.mod's `toolchain` line (single source of truth). |
| `Dockerfile` `FROM golang:1.24-alpine` while go.mod pins `toolchain go1.25.7` → silently downloads a second toolchain mid-build. | ✅ Fixed: `golang:1.25-alpine`. |
| `Dockerfile` `EXPOSE 0` — meaningless (port 0 can never be published) and wrong: the optional `--http-addr` metrics server CAN listen. | ✅ Removed with an explanatory comment. |
| `Dockerfile` `VOLUME /var/lib/otedama` mountpoint created as root → the `nonroot` (uid 65532) process gets permission denied writing the wallet on first run. | ✅ Fixed: builder creates the dir, final stage `COPY --chown=65532:65532`. |
| `docs/api-reference.txt` generated by `make docs` was not gitignored | ✅ Added to .gitignore. |

Docker build itself not run (no docker daemon in this environment) —
changes reviewed for syntax; Makefile targets verified by execution
(`make docs`, `make -n fuzz/build/help`).

## Session 279 update — release tooling audit (.goreleaser.yaml, .golangci.yml, release.yml)

Third leg of the distribution-path audit (s260 install.sh → s278
Makefile/Dockerfile → s279 release config). release.yml is the actual
producer; .goreleaser.yaml is the sanctioned local alternative
(`goreleaser release --snapshot`).

| Finding | Disposition |
|---|---|
| `.goreleaser.yaml` archive names `otedama_v{ver}_{os}_{arch}` — install.sh fetches `otedama-<os>-<arch>.tar.gz` (release.yml contract) → goreleaser-path assets could never be installed by the installer. | ✅ Fixed: name_template aligned to `{{ .ProjectName }}-{{ .Os }}-{{ .Arch }}`. |
| `docs/locales/*.toml` in archive files — directory does not exist; an empty-match glob aborts the release. | ✅ Fixed: removed with a re-add comment. |
| checksum name `otedama_v{ver}_checksums.txt` — install.sh fetches literal `checksums.txt` → signature/checksum verification path impossible. | ✅ Fixed: `name_template: "checksums.txt"` (cosign outputs become `checksums.txt.sig`/`.pem`, matching install.sh fetches). |
| `changelog.use: git-cliff` — no git-cliff binary guaranteed, no cliff.toml exists, and goreleaser ignores `filters` under git-cliff → the declared exclude list was dead config. | ✅ Fixed: `use: git` so the declared filters actually apply. |
| `.golangci.yml` `run.go: "1.22"` stale — repo floor is `go 1.24.0`; pinning 1.25.7 or unsetting breaks golangci-lint (built with go1.24.1 — measured: "language version used to build golangci-lint is lower than the targeted Go version"). | ✅ Fixed: `go: "1.24"` (go.mod's language floor). Lint output verified identical to baseline. |
| release.yml `-X main.Version/-X main.BuildTime/-X main.GitCommit` — symbols don't exist (`-X` silently ignored); metadata lives in `internal/version` → shipped binaries report `v3.0.0-alpha.0-dev`/`unknown`. | ⚠️ Recorded (KNOWN_LIMITATIONS §13) — workflows outside push scope. Same class as the docker-build ARG fix (s278) but ships to users. |
| release.yml release body links `docs/DEPLOYMENT_GUIDE.md` — only DEPLOYMENT.md exists → 404 in every Release. | ⚠️ Recorded (workflows scope). |
| release.yml `update-homebrew` uses `GITHUB_TOKEN` for cross-repo checkout of `otedama/homebrew-tap` — needs a PAT; fails on auth regardless of repo existence (tap repo unverifiable from session — git-manager proxy 403). | ⚠️ Recorded (workflows scope). |
| `actions/create-release@v1`, `actions/upload-release-asset@v1` archived upstream. | ⚠️ Recorded (workflows scope). |
| `prerelease: false` publishes `-alpha` tags as stable (goreleaser uses `prerelease: auto`). | ⚠️ Recorded (workflows scope). |
| `scripts/`+`config.yaml` missing → DEB/RPM job fails; GO_VERSION 1.23 below godebug floor | Already recorded §13 (sessions 245-252). |
| First-tag `git describe HEAD^` failure | ❌ Not a defect — v2.1.x tags exist; HEAD^ resolves on future tags. |

goreleaser binary not installed locally — config validated by YAML parse
+ docs semantics, not a live release run.

## Session 280 update — config surface audit (config.yaml.example + DefaultPoolURL)

User-facing config surface audited key-by-key against `internal/config`,
`internal/i18n`, and live DNS. Same "never-verified claims" class, worst
finding in code rather than docs:

| Finding | Disposition |
|---|---|
| `DefaultPoolURL` pointed at `public.stratum.slushpool.com` — **NXDOMAIN** (verified: no A/AAAA; `stratum.slushpool.com` resolves). Zero-config startup (`otedama run` with no `pools:`) could never connect to anything. The fabricated-looking hostname (public-pool.io conflation?) had been the code constant since the four copy-pastes were consolidated. | ✅ Fixed: `stratum+v2://stratum.slushpool.com:3336` (Braiins' real SV2 endpoint, resolves, single constant feeds engine/CLI banner/doctor). Also updated in `config.yaml.example`, `docs/API.md`, `config_loading_test.go`. |
| `config.yaml.example` primary pool used `stratum+v2tls://` — TLS-transport SV2 Braiins does not serve on :3336 (code default is plain SV2/Noise). | ✅ Fixed: `stratum+v2://` matching the constant. |
| `demand.fun` in the commented failover example — NXDOMAIN. | ✅ Fixed: `pool.example.com` (RFC-2606, same convention as poolproto docs). |
| "built-in recommended pool list (Stratum V2 pools prioritised, 0% fee)" — false: config.go documents there IS no list, only DefaultPoolURL. | ✅ Reworded to single default pool. |
| Language list "en, ja, zh-CN, ko, es, fr, de, pt" — code tag is `zh` (not `zh-CN`) and `ru`/`ar` catalogs exist but were omitted. | ✅ Fixed: en, ja, zh, ko, es, fr, de, pt, ru, ar (all 10). |
| "System roots are always used" for tls_ca_file — false when SystemCertPool load fails (fail-closed narrows to PEM-only; corrected in code at s277). | ✅ Reworded to match reality. |
| `datum://` parsed by DialURL but unimplemented — absent from the scheme list a user would copy. | ✅ Documented as parsed-but-unimplemented w/ KNOWN_LIMITATIONS §14 pointer. |
| `FormatHashRate`/`FormatDuration`/`SatsToDisplay` (internal/tui) exported "for use in the CLI status line" — no CLI status line exists; deadcode reports them unreachable outside tests. | ⚠️ Recorded — wire the status line or drop the export; maintainer call (comment states intent). |

Verification: `go test ./...` all packages green; touched files gofumpt-
normalized; lint/deadcode deltas vs baseline: none introduced (the tui
formatter findings are pre-existing reachability, unchanged by this diff).

## Session 281 update — docs surface audit (DEPLOYMENT.md, API.md, README, install.sh self-URL, i18n)

| Finding | Disposition |
|---|---|
| README install command `releases/latest/download/install.sh` — install.sh is not a release asset → **verified 404**; the documented quick-start was dead. | ✅ Fixed: fetch from `raw.githubusercontent.com/.../master/install.sh` (verified 200). |
| install.sh's own header self-URL used `/main/` branch — repo's default branch is `master` → **verified 404**. | ✅ Fixed: `/master/` ×2. |
| `ghcr.io/shizukutanaka/otedama` image referenced by DEPLOYMENT.md pull/compose/k8s — every CI docker job builds `load:true` verification images only; nothing pushes (push-capable workflows are the recorded-broken ones, §13) → pull likely fails for everyone. | ✅ Documented: pull note + `make docker-build` fallback. Image publish remains a maintainer/workflow fix (§13). |
| K8s section: Deployment mounts `persistentVolumeClaim: otedama-data` but no PVC manifest existed → pod stays Pending. ServiceMonitor selects a Service `otedama` exposing port `metrics` — no Service manifest existed → zero scrape targets. | ✅ Added PVC (1Gi RWO) + Service manifests with a note. |
| ci.yml docker-verify: runs `docker run otedama:ci-test -version` — `-version` is "unknown subcommand" (verified; only version/--version/-v accepted); greps for `Git Commit:` — a string the version output never contains; passes `GIT_COMMIT`/`CGO_ENABLED` build-args the Dockerfile doesn't declare (declared: VERSION/COMMIT/BUILD_DATE) → commit stays `unknown`. Triply-determined failure. | ⚠️ Recorded (KNOWN_LIMITATIONS §13 addendum — workflows outside push scope). |
| API.md `--language` examples said `zh-CN` — real tag is `zh`. | ✅ Fixed (added `ru`/`ar` examples). |
| README Go badge `1.22+` — go.mod floor is 1.24. | ✅ Fixed: 1.24+. |
| i18n catalogs — key parity across all 10 languages | ✅ Verified clean: 15 IDs each, completeness test covers all (no defect). |
| DEPLOYMENT.md endpoints/probes/flags vs httpserver | ✅ Verified consistent (healthz/readyz/metrics, 9090, runAsNonRoot 65532 matches Dockerfile nonroot uid). |

## Session 282 update — repo meta-file audit (SECURITY.md, dependabot, CODEOWNERS, ADR-002)

| Finding | Disposition |
|---|---|
| SECURITY.md told v2 users to run `otedama migrate-from-v2` — the subcommand does not exist (confirmed at s278, Makefile target removed for the same reason). Security-policy doc directing users to a dead command. | ✅ Reworded: manual re-config + note the command is unimplemented. |
| `.github/dependabot.yml` `automerge:` under updates — not a dependabot.yml key; unknown keys make GitHub's config validation reject the file → every update entry silently disabled. | ✅ Removed with explanatory comment (auto-merge is a repo setting). |
| `.github/CODEOWNERS` `/internal/stratum/noise_pool*` rule — file deleted at session 259 (pooled-HMAC measured pessimisation). | ✅ Removed rule with note. |
| ADR-002 Implementation Notes cited `noise_pool.go` as a live allocation optimisation — the file is gone. | ✅ Errata inline (strikethrough + measured numbers), per ADR convention of not rewriting history. |
| `MAINTAINERS.md`, `GOVERNANCE.md`, `BENCHMARKS.md`, `ROADMAP.md`, `SECURITY.md`, `CONTRIBUTING.md`, `.github/CODEOWNERS`, `ISSUE_TEMPLATE/`, `oss-fuzz-integration.md` | ✅ All exist; references resolve. |
| CLAUDE.md "doctor/ 17 並行ヘルスチェック" | ✅ Verified: exactly 17 `Name:` checks in checks.go. |
| DEPLOYMENT.md's `ROADMAP.md "Real protocols"` reference | ✅ Resolves (v3.1.0 section exists). |
| `solo-operations.md`'s `.github/MAINTAINERS.md` | ❌ Not a live link — instructive template telling future maintainers what to write; acceptable as-is. |

## Session 283 update — user-facing ops docs audit (MIGRATING-FROM-V2.md, TROUBLESHOOTING.md)

Two remaining never-audited user-facing docs, same "never-verified claims"
class as s281/s282. Worst finding again contradicts shipped code:

| Finding | Disposition |
|---|---|
| "Stratum V1 compatibility. v3 has no V1 fallback" + "v3 is V2-only" — false. V1 dialers are registered (`stratum+tcp://`, `stratum+tls://`; stratumv1.go:516-517) and engine.runSessionV1 is a live path (config.go documents `mining.authorize` for V1 pools). A V1-only-pool user would wrongly conclude they can't migrate. | ✅ Fixed: V1 removed from the "No" list; protocol is per-pool via `pools[].url` scheme; `[stratum_v1]` diff entry clarified. |
| `releases/latest/download/install.sh` — same dead release-asset URL fixed in README at s281 (404 for everyone). | ✅ Fixed: `raw .../master/install.sh` (verified-200 URL). "verify the signature" → VERIFY.md pointer (signing assets unpublished, s260). |
| "The `legacy-v2` branch is maintained for security fixes until October 2026" — the branch does not exist on the remote (`git ls-remote --heads`; only v2.x tags exist). Users told to stay on v2.x can receive nothing. | ✅ Fixed (×2): v2.x is EOL with no fixes; legacy-v2 is planned-in-CLAUDE.md but uncreated. CLAUDE.md's governance text left as-is (it describes intent). |
| "CI: ... cosign signing" — signing assets not published (s260 measured). | ✅ Fixed: dropped from CI claims with VERIFY.md pointer. |
| `pools[].priority:` listed as a new field — PoolConfig has no `priority` (fields: url/user/password/payout_scheme/tls_ca_file); list order is the failover order. `workers[]:` "per-device worker configuration" — `workers:` is a single `{name}` object, not an array. | ✅ Fixed: `pools[]` ordered list (order = priority), `workers.name`, and added `bitcoin_addresses` (real payout-rotation field missing from the diff). |
| `--worker-threads` flag — does not exist (run has no thread knob; engine spawns `runtime.NumCPU()` threads per SHA256d device → "flag provided but not defined" exit 64). | ✅ Fixed: taskset/systemd drop-in/affinity guidance (NumCPU honours CPU affinity). |
| "the `service` option binds Otedama to an idle scheduling class automatically" — generated unit has no Nice/CPUSchedulingPolicy/IOPriority (only ExecStart/Restart/hardening). | ✅ Fixed: `systemctl --user edit otedama` drop-in with CPUQuota/Nice/CPUSchedulingPolicy=idle, noting the unit sets none itself. |
| `otedama --log-level=debug doctor` — dead command: flags before the subcommand hit "unknown subcommand" (exit 64), and doctor defines no --log-level anyway. | ✅ Fixed: `run --log-level=debug --no-tui` / `OTEDAMA_LOG_LEVEL=debug`; doctor's report is already the full diagnostic. |
| "first metrics appear after the first successful pool handshake" — engine sets uptime/startTime at engine.Run start, before any dial. | ✅ Fixed: empty /metrics means the engine never started (or --http-addr unset). |
| `demand.sv2.io` named as an auto-tuning pool — NXDOMAIN (verified). Same class as s280's `demand.fun`. | ✅ Fixed: Braiins Pool vardiff only (didn't fabricate a DEMAND host). |
| Symptom title quoted `wallet: decrypt seed: invalid passphrase` — real message is `lightning: wallet unlock failed — check your passphrase` (wallet.go:219). | ✅ Fixed. |
| Reconnect backoff "1s, 2s, 4s, ... up to 64s" | ✅ Verified: reconnectBackoffInitial=1s, ×2, cap=64s (plus pool advisory wait ≤64s from s268 — claim still holds). |
| "Check `otedama doctor`'s pool latency reading" | ✅ Verified: "Pool reachability" check records per-pool latency (checks.go:323). |
| `doctor --bitcoin-address`, `run --wallet-passphrase/--dry-run`, `service install/status`, `--http-addr` | ✅ All flags verified to exist. |
| Renamed fields `payout.address`→`bitcoin_address`, `log.level`→`log_level`, `pool.urls[]`→`pools[].url`; new `data_dir`, `language` | ✅ All yaml tags verified in config.go. |

## Session 284 update — metrics-feature wiring + SPECIFICATION/API conformance

Same "implemented but unreachable" class as s271 arbitration_policy, plus the
normative-spec conformance check:

| Finding | Disposition |
|---|---|
| `metrics.RuntimeCollector()` (12 `go_*` series: goroutines, memstats, GC, go_info) implemented and tested but **never registered** — `RegisterCollector` had zero non-test call sites; the go_* family was dead API. | ✅ Fixed: `reg.RegisterCollector(metrics.RuntimeCollector())` in `startHTTPServer` + e2e test asserting go_goroutines/go_memstats_alloc_bytes/go_gc_cycles_total in the exposition. |
| API.md metric table missing `shares_submitted_total`, `shares_unresolved_total` (s266), `effective_yield_sats_per_second`, `devices_idle`; reject-reason enum missing `transition` (s255). | ✅ Fixed: all added, plus go_* family section. |
| SPECIFICATION §3.3 "checksum is *not* verified here" — stale: `validateBitcoinAddress` calls `btccrypto.ValidateAddress` (checksum verified at config load). config.go's own doc comment contradicted the code too. | ✅ Fixed (spec §3.3 + the config.go comment). |
| SPECIFICATION §4 lifecycle described only the V2 handshake — the `stratum+tcp`/`stratum+tls` → V1 session path (subscribe/authorize/notify/submit) was absent, inconsistent with shipped V1 support. | ✅ Fixed: scheme-selects-protocol bullet added. |
| SPECIFICATION §6 "All metrics carry the `otedama_` prefix" + no go_* mention. | ✅ Fixed: intro now covers the go_* family (wired this PR). |
| §6's 42 otedama_* names vs `newEngineMetrics` | ✅ Verified: every spec name matches a registered series (labels incl. — build_info{version,commit,goversion}, quantile{0.5,0.95,0.99}, † lazy series). |
| §3.1 schema table vs `Config.Validate()` | ✅ Verified: every rule matches (datum:// rejected at validate — consistent with parsed-but-unimplemented; hysteresis [0,1); all OTEDAMA_* env vars exist). |
| §2 command table, §2.1 exit codes, §3.2 precedence | ✅ Verified against main.go/config.Resolve (EnvWarnings reporting confirmed). |
| rejectClass categories | ✅ Verified: stale/duplicate/difficulty/hardware/other + "transition" constant. |

Verification: `go test ./...` all 24 packages green; changed files gofumpt-
normalized; lint findings on touched files: none (all pre-existing elsewhere);
deadcode delta: RuntimeCollector now reachable (baseline shrank, nothing added).

## Session 285 update — governance/supply-chain docs conformance (SUSTAINABILITY, solo-operations, AUDIT_CHECKLIST)

Three "claims about our own process" docs never previously audited — the same
never-verified-claims class as s281–s283, but aimed at auditors/maintainers
rather than users. Worst finding: the auditor-facing checklist's own
verifiable assertions fail, and the supply-chain section of SUSTAINABILITY
declares controls that don't exist (tag-pinned actions incl. two `@master`
floats — the exact tj-actions/TeamPCP class the doc itself warns about).

| Finding | Disposition |
|---|---|
| SUSTAINABILITY §1: "go 1.22 baseline / toolchain go1.24.0", godebug list missing `containermaxprocs` | ✅ Fixed: go 1.24.0 / toolchain go1.25.7, all four godebug pins. |
| SUSTAINABILITY §2: "SV1/SV2 implementation は v3.2.0 スコープ" — both shipped & live | ✅ Fixed. |
| SUSTAINABILITY §4: XChaCha20-Poly1305/Argon2id "採用" reads as current — wallet ships AES-256-GCM + scrypt; decred secp256k1 still stub | ✅ Fixed: split adopted-design from shipped-state. |
| SUSTAINABILITY §5: "SHA pinning + cosign signing は実装済み" — **both false**; all `uses:` are tags, `trivy-action@master` & `gosec@master` float; cosign/SBOM/checksums unpublished; govulncheck/osv/scorecard jobs absent | ✅ Fixed with measured negatives + KNOWN_LIMITATIONS pointers. |
| SUSTAINABILITY §7: "全 metric `otedama_*`" (go_* added s284); `--metrics-addr`/`--otlp-endpoint`/`--pprof-addr` flags don't exist (only `--http-addr`) | ✅ Fixed. |
| SUSTAINABILITY §9: "fuzz 2件" → actually 6 (stratum×2, stratumv1×2, arbitration×2); vendoring plan vs AUDIT_CHECKLIST "no vendor" row tension noted | ✅ Fixed. |
| SUSTAINABILITY §10: `otedama.dev` "確保" — NXDOMAIN (measured); SECURITY.md "v3.1.0 スコープ" — exists; "本セッションで追加" tense; ADR-001〜005 → 001〜013 | ✅ Fixed. |
| solo-operations: "govulncheck 週次自動実行済み", "SHAピン留め ci.yml実施済み", "Renovabot設定済み", "Fuzzing CI継続実行 設定済み", "cosign設定済み" — all five false | ✅ Fixed: restated as un-deployed design targets with exact gap. |
| solo-operations CODEOWNERS example lists `/internal/security/` & `/internal/auth/` — nonexistent paths CLAUDE.md forbids creating | ✅ Fixed: real gated paths (`internal/lightning/`, `internal/stratum/noise*`). |
| solo-operations "stratum+v2tls://のみデフォルト" — built-in default is `stratum+v2` cleartext; CA verify needs explicit tls_ca_file | ✅ Fixed. |
| AUDIT_CHECKLIST: Go 1.22+; `gopkg.in/yaml.v3` dep name; scrypt N=32768 in seed.go; "Noise NX full handshake"; CI-gate list asserting staticcheck/govulncheck/nightly-fuzz/benchmark jobs that don't exist; SHA-pin & cosign rows silently failing; duplicate row number 9 | ✅ Fixed: Go 1.24+, `go.yaml.in/yaml/v3`, N=131072 in seedstore.go, P-256 stub status, real CI-job list, failing rows marked "currently fails", rows renumbered 1–31. |
| Verified accurate (recorded, not changed): dependabot 3 ecosystems weekly; `OTEDAMA_WALLET_PASSPHRASE` env; wallet 0600; `otedama.org` DNS live; test:impl ≈1.77; zero TODO/FIXME/XXX; AES-256-GCM/PBKDF2-2048/SPDX headers; goreleaser ldflags example matches real file. | ✅ |

Recorded for maintainer action (push-scope): KNOWN_LIMITATIONS §13 session-285
addendum — `@master` floating pins, zero SHA pinning, absent govulncheck/
osv-scanner/Scorecard/fuzz/benchmark jobs.

## Session 286 update — benchmarks/competitive-analysis/skills conformance

Continuation of the docs-vs-reality audit into performance claims, market
docs, and the skills/ procedure files contributors actually follow.

| Finding | Disposition |
|---|---|
| BENCHMARKS "Reproduce: `BenchmarkDecoder_ReadFrame`" — the benchmark does not exist; the decoder throughput table was a design projection presented as measured | ✅ Fixed: status note marks the numbers unmeasured; lists the benchmarks that do exist. |
| BENCHMARKS "`go test -bench` checked into CI, >5% fails automatically" + "posts a comparison to PRs" — the real job only runs `go test -bench=.` and uploads an artifact (and cannot run at all while the workflow Go floor is broken, §13) | ✅ Fixed: actual job + manual comparison procedure. |
| BENCHMARKS "decoder fuzzed continuously in CI" — no fuzz job exists | ✅ Fixed. |
| BENCHMARKS Akash revenue column as "market data" — produced by the simulated provider | ✅ Fixed: caveat added (KNOWN_LIMITATIONS §1 / ADR-013). Go 1.22 reference floor → ≥1.24. |
| competitive-analysis "ZKP認証で数学的に証明" (v4.0), "LDKバインディング" (not integrated — BIP-39 storage only), "`golang.org/x/text`のmessageパッケージを基礎に" (not a dep; hand-rolled internal/i18n), "プール自動選択" (none — explicit pools[].url), pool list naming DEMAND (NXDOMAIN measured) / Luxor (SV2 unverified) | ✅ All five corrected to shipped reality. |
| skills/tdd.md: `make test-e2e` (intentionally undefined target), `//go:build integration` tag (not introduced), "CI上で継続的に fuzz 実行" (no job), gopter mention (no property lib) | ✅ Fixed. |
| skills/release-procedure.md: `otedama migrate-from-v2` migration test (dead subcommand), "golangci-lint 警告ゼロ" (backlog exists), govulncheck in CI (unwired), "E2Eテストの全てが通過" | ✅ Fixed. |
| skills/security-audit.md: `.github/workflows/codeql.yml` (real file is security.yml), govulncheck "CIで毎回実行" | ✅ Fixed. |
| Verified accurate: architecture.md carries the session-243 target-vs-actual disclaimer; gosec+CodeQL+Semgrep actions exist in security.yml/ci.yml (three-layer claim holds); `make test-integration`, `make audit`, `make fuzz` targets exist; BenchmarkHashHeader/WorkerGrind_SingleThread/WriteText and 4 other benchmarks exist. | ✅ |

## Session 287 update — CONTRIBUTING/ROADMAP/CLAUDE.md conformance

Closes the docs-conformance sweep with the three highest-traffic
contributor-facing files. ROADMAP was already self-annotated (sessions 32/251)
but had regressed again as code shipped.

| Finding | Disposition |
|---|---|
| ROADMAP v3.1.0 "engine → poolproto 統合 — 現状 raw TCP に直結" — engine already dials via poolproto.DialURL (verified run.go + coverage tests) | ✅ Marked complete. |
| ROADMAP v3.2.0 "Stratum V1 互換の追加" — stratumv1 shipped (dialers registered, runSessionV1 live) | ✅ Marked complete; DATUM noted as not started. |
| ROADMAP "govulncheck + osv-scanner を informational から昇格" — neither was ever wired into CI (§13) | ✅ Corrected to new-add. |
| CONTRIBUTING "Go 1.22以上" / Docker "統合テスト用" | ✅ → Go 1.24+ with go1.25.7 toolchain pin; Docker for container builds. |
| CONTRIBUTING "CODEOWNERSにより二人のメンテナによる二重レビュー" — CODEOWNERS lists only @shizukutanaka; two-reviewer requirement is unenforceable on a solo project | ✅ Corrected to auto review request. |
| CONTRIBUTING cites "Doe v. GitHub訴訟（2025年11月和解）" as the rationale for strict duplication filtering — settlement not verifiable from any source | ✅ Simplified to recommendation without the citation. |
| CONTRIBUTING "その他の言語は機械翻訳で対応" — no MT pipeline; catalog is 10 languages | ✅ Corrected. |
| CLAUDE.md factual refs: "ADR-001〜011" (013 exists), "main ブランチ" (default is master), "legacy-v2 ブランチは保全用" (branch was never created — s283), "機械翻訳で1,000言語以上" (no MT) | ✅ Minimal factual corrections; normative sections untouched. |
| Verified accurate: all 7 workflow filenames in the architecture map exist; CODEOWNERS paths all real; .gitignore protects config.yaml; PR/Conventional-Commits/SPDC requirements match practice; ADR-007/008/009/010 track references in ROADMAP resolve to real ADRs. | ✅ |
