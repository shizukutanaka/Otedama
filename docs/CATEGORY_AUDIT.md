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
- ✅ Windows `Status()` — resolved: `statusWindowsService` now parses
  `sc.exe query Otedama` (Installed/Running/Details). (Verified session 432.)
- ✅ Windows `sc.exe binPath=` quoting — resolved by the `serviceArgv`
  redesign: the canonical argv slice is the single source and each platform
  emits it in its own quoting discipline (launchd per-element `<string>`,
  systemd/sc.exe joined with selective quoting). (Verified session 432.)

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
- ✅ `DispatchFrame` decode errors — re-verified (session 435): the
  description was stale. A malformed *known* message's decode error reaches
  the session loop as `poolMsg.err` and is returned fatally
  (`engine: pool read: %w`, run.go) — the session dies with the error
  logged and reconnects, which is stricter than the proposed debug log,
  not silently continued. Only *unknown* message types are tolerated
  (routed to `Message.Unknown`). No fix needed.
- ✅ `OpenMiningChannel(.Success).MaxTargetNBits` wire-encoding — resolved:
  investigated against the spec; `max_target` (U256) is intentionally not
  implemented because Otedama accepts the pool-assigned target
  (`OpenMiningChannelSuccess.Target`, later `SetTarget`), so advertising a
  preference would be dead configuration. The dead field was removed and the
  rationale documented on `OpenMiningChannel`. (Verified session 432.)

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
| D | ✅ `poolproto` doc + `stratumv1.go` — resolved: both now state DATUM "is planned" (ADR-009, Proposed), not present-tense supported; disclosed as KNOWN_LIMITATIONS §14 ("reserved URL scheme, not an implemented protocol"). | — | verified session 432 |
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
| L | No typo tolerance / "did you mean" for subcommands (`otedama rnu` → generic "unknown subcommand" + full usage dump). | ✅ Fixed (session 434): `suggestSubcommand` offers the nearest subcommand at Levenshtein distance ≤ 2 on stderr; exit 64 unchanged. |

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

## Session 519 update — rule-3 duplication candidates recorded

Two residuals surfaced by the sessions 515–517 audit; recorded per
CLAUDE.md rule 3 (record before fixing — consolidation is a contract
decision, not a mechanical dedupe).

- **`tui` truncator family — near-duplicate with divergent edge
  semantics (same class as Issue #3).** `truncateToBudget` (dashboard.go:329)
  hard-cuts `s[:budget]` when `budget < 4`; `shortenURL`
  (dashboard.go:530) returns the **over-limit string intact** in the
  same edge case — silently violating the caller's width bound.
  `truncateVisible` (dashboard.go:490) is the third, ANSI-aware variant.
  Consolidation must pick one edge-case contract: hard-bound always vs
  never-distort. Today the divergence is harmless only because callers
  pass budgets ≫4.
- **`metrics.metricKey` label-value collision — latent, not
  exploitable today.** `metricKey` (metrics.go:331) joins
  `name,k=v` pairs with `,`/`=` unescaped, so two distinct label maps
  produce the same key if a label *value* contains `,` or `=` (e.g.
  `{dc:"a",rack:"b"}` vs `{dc:"a,rack=b"}`). Not reachable from current
  producers (device IDs are `cpu-N`/`gpu-<render-node>`, provider names
  are fixed literals), but `NewCounter`/`NewGauge` accept arbitrary
  label values, so the collision exists on the API surface. A
  length-prefix or escaping scheme would fix it; recorded for the next
  metrics-API change rather than churning the wire format now.

---

## Session 596 update — V1 write-path + handshake-response audit

Continues the session-595 fail-closed pass over the V1 session pipeline
(the dispatch/parse side itself was hardened in this branch's sibling
fix). Verified by site inspection:

| Cat | Finding | Disposition |
|---|---|---|
| S | `conn.Write`/`Fprintf` errors swallowed on the wire path — a dropped socket write is never detected. | ✅ Clean: V1 `call()` propagates write errors with pending-map cleanup and a 10s write deadline; V2 `sendMsg` propagates with `writeTimeout`; metrics exposition checks every `Fprintf`. |
| S | Authorize response coercion — `result` asserted to bool without ok-check could accept a non-bool payload. | ✅ Clean: `accepted, _ := resp.result.(bool)` — non-bool degrades to `false` = reject (fail closed), plus `errResult` rejected first. |
| S | Response-ID parsing — a non-numeric string id wrapping to a pending-map key. | ✅ Clean: `uintID()` returns 0 on unparseable ids; 0 matches no pending entry (ids start at 1) — the response is dropped. |
| S | `SetWriteDeadline` error ignored (`_ =`). | ✅ Benign: deadline failure implies a broken conn — the subsequent `Write` surfaces the real error. |

All packages build, vet, and test green.

---

## Session 597 update — V2 handshake strictness + service-definition audit

| Cat | Finding | Disposition |
|---|---|---|
| S | V2 Noise `readMessage2` soft-degrade — the `err == nil` try-encodings chain (65B uncompressed → 33B compressed → 32B x-only fallback) accepts an arbitrary 32-byte payload as the responder key. | ✅ Deferred (fund-critical, alpha stub): the fallback is a documented P-256 stub simplification; a bogus "key" yields a wrong shared secret and the handshake fails at AEAD verification anyway (fail-eventually, never silently accepted). Any change belongs in the Noise NX secp256k1 migration, which is CODEOWNERS-reviewed by rule — not this sweep. |
| S | Service-definition injection — pool URL / config path / binary path breaking out of `ExecStart=` or plist `<string>` into a new directive (systemd `;`/newline, plist `</string>`). | ✅ Clean: `quoteToken` escapes whitespace+quotes+control chars on every ExecStart token (the literal-newline → new-directive class is covered); plist uses `serviceArgv` as discrete `<string>` elements with `xmlEscape`; Windows sc.exe binaryPath is os.Executable-derived (operator input, not attacker input). |

All packages build, vet, and test green.

---

## Session 598 update — metrics-cardinality + stale-share semantics audit

| Cat | Finding | Disposition |
|---|---|---|
| P | Prometheus label cardinality — a label whose values come from pool-controlled or device-controlled strings explodes series count (memory + scrape cost). | ✅ Clean: every label value is bounded — `reason` ∈ 5 fixed categories from `rejectClass` ("stale"/"difficulty"/"duplicate"/"hardware"/"other"; canonical SV2 codes checked before substring heuristics), `device` bounded by hardware count, `address` bounded to the configured failover list, `status`/`quantile`/buildInfo are fixed enums. No pool string reaches a label. |
| S | V1 `Submit` lacks a client-side staleness check — a share for a job purged by `clean_jobs` is sent anyway. | ✅ By protocol: pools expect and reject stale shares by design (`stale-share` is a canonical SV2 code; V1 pools reject with a stale reason). Client-side pre-checking saves nothing — the worker's share was already computed; the pool-side reject is the correctness boundary. |

All packages build, vet, and test green.

---

## Session 591 update — test-goroutine assertions + filesystem-path hygiene sweep

Two mechanical axes not covered by the earlier lint/race/concurrency
rounds, verified by inspection of every matched site (not just pattern
counts):

| Cat | Finding | Disposition |
|---|---|---|
| S | `t.Fatal`/`t.Fatalf` called inside a spawned goroutine would `runtime.Goexit` that goroutine only — the test continues and can pass while the assertion never ran (silent pass-through). | ✅ Clean: every `t.Fatal*` site sits on the main test goroutine; spawned goroutines only do I/O or report via `t.Error*`/`t.Logf` (both safe off-main). No assertion inside any `go func` anywhere in the test tree. |
| S | `filepath`/`os` path handling — `os.Stat`/`os.Lstat`/`os.Open`/`os.ReadFile`/`os.WriteFile`/`filepath.Join` on derived paths (wallet dir, config, log file, unit files, sysfs). | ✅ Clean: every joined path is rooted at an operator-owned directory (dataDir from the 4-layer config, `$HOME` service dirs, sysfs `drmBasePath`); the only operator-supplied single paths are `--config`, `--log-file`, and `tls_ca_file`, which the operator legitimately controls. `filepath.Glob` wallet-tmp sweep is pattern-bounded to the same dir. No traversal or symlink-follow surface reachable from untrusted input. |

All 24 packages build, vet, and test green.

---

## Session 592 update — observability-boundary + test-timing sweep

Two more mechanical axes verified by site inspection:

| Cat | Finding | Disposition |
|---|---|---|
| S | `log.Print*`/`fmt.Print*` bypassing the `internal/logger` abstraction inside library packages would write unfiltered output to stdout/stderr (breaks `--log-file` redirection, the structured-logger contract, and the non-TTY TUI flip). | ✅ Clean: zero `log.*` or `fmt.Print*` call sites in non-test code outside `cmd/otedama`, `internal/tui` (its own output layer), and `internal/logger` itself. All library reporting routes through the injected `log func(level, msg)` / `*slog.Logger` seam. |
| S | `time.Sleep` in tests (76 sites) — the sleep-then-assert race class where the test's verdict depends on wall-clock scheduling. | ✅ Clean: every site is simulation pacing — letting a fake-pool session reach a state, keeping a connection alive through a window, or draining a goroutine before teardown. Verdicts are taken on channels/`select` timeouts or post-sleep reads of atomically-published state, not on the sleep itself. Consistent with the session-535 empirical verdict (`-count=3` + `-race`×2 green on all timing-sensitive packages). |

All 24 packages build, vet, and test green.

---

## Session 593 update — signed-arithmetic + TLS-configuration sweep

Two more mechanical axes verified by site inspection:

| Cat | Finding | Disposition |
|---|---|---|
| S | Signed `%` on a possibly-negative dividend yields a negative remainder (index/stride wrap bugs); integer division in yield/price math truncates silently. | ✅ Clean: every `%` site operates on provably non-negative operands — `int(d.Minutes())%60`/`Seconds` on uptime durations, `(idx+1) % len(...)` ring indices. Every division in the yield/rate paths is `float64` (medians, rates, J/TH, latency ms); no integer truncation sits on a monetary or difficulty quantity. |
| S | TLS configuration — `InsecureSkipVerify`, weak `MinVersion`, SNI not derived from the dial address — on the `stratum+tls://` and `stratum+v2tls://` paths. | ✅ Clean: `InsecureSkipVerify` appears nowhere; both dialers pin `MinVersion: TLS1.2`, leave `ServerName` empty so crypto/tls fills it from the actual dial address, use `tls.Dialer` so the handshake completes (and verification failures surface) before first write with no plaintext fallback. `TLSConfigWithExtraCAs`/`tlsConfigWithExtraCAs` add a private-CA bundle *on top of* system roots — verification stays enabled; a nil/empty bundle yields the secure default. `doctor` pre-validates the PEM with the same `AppendCertsFromPEM` path. |

All 24 packages build, vet, and test green.

---

## Session 594 update — stdlib-modernization leftovers + error-sentinel sweep

Two more mechanical axes verified by site inspection:

| Cat | Finding | Disposition |
|---|---|---|
| L | Modernization leftovers after the session-537 `slices` pass: manual map-clear loops (`for k := range m { delete(m,k) }` → `clear`), `HasPrefix`+slice pairs (→ `strings.Cut*`), hand-rolled min/max (→ builtins). | ✅ Clean: no whole-map clear loop exists (all `delete` sites are selective single-key expiry — `pending`, `submitTimes`, stale stream entries); every `HasPrefix`/`HasSuffix` call is a pure check with no following slice-off; no hand-rolled min/max remains. The tree is fully on current stdlib idiom. |
| M,S | `err == sentinel` direct equality on the check side misses wrapped errors (a `fmt.Errorf("…: %w", sentinel)` passes by the guard) — the wrap-penetration bug class. | ✅ Clean: the only `==` sentinel comparison in the tree is `err == flag.ErrHelp`, which is the flag package's own documented idiom (flag.Parse returns it unwrapped). All other error checks are `err != nil` or `errors.Is`/`errors.As` (post-#526). |

All 24 packages build, vet, and test green.

---

## Session 599 update — extranonce-chain completeness audit

| Cat | Finding | Disposition |
|---|---|---|
| P | V1 `en2` rollover: `en2Counter` provides uniqueness only within the 2^(8·sz) space the pool assigns — a long-lived session on a small `extranonce2_size` (e.g. sz=1 → 256 jobs) could repeat a coinbase and draw "duplicate" rejects. | ✅ Bounded-benign: the field IS the nonce space — no client-side construction can extend it; the bound is pool-controlled, sessions cycle en1 on reconnect, and sv2-spec practice is sz≥4. Noted, not fixed. |
| P | `Submit`'s en2 pad-zero branch is reachable only when extranonces were never negotiated — post-#677 the subscribe boundary requires valid en1 + en2_size>0 or the session fails. | ✅ Benign dead fallback: kept as defensive padding; unreachable through the negotiated path. |
| P | `extranonce1` uniqueness across reconnects: a repeated en1 + same en2 range can collide coinbases. | ✅ By protocol: pools scope en1 per session; the spec puts rollover responsibility on the pool — same-session en2 counter roll covers the rest. |

All packages build, vet, and test green.

---

## Session 601 update — read-buffer aliasing audit

Bug class: a decoded field that aliases a shared read buffer is silently
corrupted when the next read overwrites it (use-after-overwrite). Every
decode boundary was inspected for slice retention into longer-lived
structures:

| Cat | Finding | Disposition |
|---|---|---|
| S | V1 `readLine` (`stratumv1.go`): `bufio.Reader.ReadSlice` returns a slice aliasing the reader's internal buffer — invalid on the next read. | ✅ Clean: `readLine` copies the line into a fresh `make([]byte, …)` before returning, preserving the "caller owns its line" contract that `dispatch`/`json.Unmarshal` rely on. Documented in the function comment. |
| S | V2 `Decoder.ReadFrame` (`frame.go`): a decoder-level scratch buffer reused across frames would corrupt the previous Frame's payload. | ✅ Clean: `payload := make([]byte, h.MsgLength)` is allocated per call — the Frame owns its payload indefinitely. `scratch` covers only the 6-byte header and is consumed into the value-type `Header` (no slice field), so nothing aliases it. |
| S | V2 wire primitives (`wire.go`) + Noise transport (`noise.go`) + handshake decoders (`handshake.go`) — lower-level decode sites that could alias a reused buffer. | ✅ Clean: every `get*` reader allocates its own result (`getB0_255`, `getStr0_255`) or reads into stack arrays (`getU16LE`/`getU32LE`, fixed-size handshake fields). `EncryptedConn.Read` decrypts into a fresh buffer and hands out copies, never the buffer itself. `byteSliceReader` copies into the caller's `p`. |
| M | `Frame` doc claimed "the Decoder may reuse its internal buffer for the next frame" — the decoder does no such thing for payloads; the comment both mis-described the implementation and forbade a retention pattern that is actually safe. | ✅ Fixed: comment rewritten to state the real ownership contract (per-call fresh payload, caller-owned; scratch only for the header). |

No retained slice references a buffer any read path can overwrite — the
use-after-overwrite class is structurally absent.

All packages build, vet, and test green.

---

## Session 632 update — callback-under-lock + nil-channel audit

| M | Callback under mutex: `runArbitrationLoop` invoked the injected `opts.log` per pruned key while holding `streamsMu` — the one site where a func value was called inside a critical section. Benign today (the logger is a leaf slog sink), but the pattern re-introduces the lock-held-across-callout class. | ✅ **Fixed**: prune under lock, log after `Unlock()` (same call order, callback now outside the section). Every other mutex region (`updateStream`, fetcher `mu`/`inflightMu`, stats `activityMu`) contains only map/metric writes — no interface or func-value calls under a held lock remain. |
| M | Nil channel in select — a possibly-nil channel field used in send/recv blocks forever. | ✅ Clean: the only possibly-nil channel is `notices` in `runStatsLoop`, deliberately nil-then-assigned for the select-disabled idiom (documented; also reset to nil on close to un-ready the case). `tokens`/`done`/all producer channels are `make()`'d in their constructors before exposure. |

All packages build, vet, and test green (`go test -race ./internal/engine/`).


## Session 636 update — timer-leak + request-reuse + endian audit

| M | `<-time.After(d)` inside a re-entering select loop — each iteration allocates a timer that lives until it fires (the timer-leak class). | ✅ Clean: the single `time.After` site (run.go:1431) fires at most once per session teardown — a one-shot pool-requested reconnect wait, ctx-cancellable and already clamped by `ReconnectWait`. Not inside a hot re-entering loop. |
| M | `http.Request` reused across retry attempts — the body is consumed on the first `Do`, so retries send an empty body. | ✅ Absent: no `client.Do` inside a retry loop; all 3 sites build the request per call, and the pool reconnect loop retries `DialURL` (fresh conn + handshake per attempt, never a consumed request). |
| P | Endianness mixing across the binary surface — an accidentally `BigEndian` field would silently corrupt wire values. | ✅ Clean: every `binary.` call is `LittleEndian` (wire u16/u32, Noise nonce/len prefixes, frame header, miner block-header fields — all spec-mandated LE); zero `BigEndian`/`binary.Read`. |



## Session 610 update — ctx-stored-in-struct + duration/shift-overflow audit

**ctx in struct** — storing `context.Context` in a struct field is the
documented antipattern (lifetime ambiguity between the call's ctx and
the object's lifetime). Verified: no struct field is `ctx
context.Context` — the apparent matches are all `dialFn
func(ctx context.Context, ...)` function-type fields (a signature,
not a stored value); no `.ctx` member access anywhere; every ctx is
the first (or only) parameter per convention. The only `_ context.Context`
ignores are the no-op `Enumerate`/`Shutdown` implementations
(cpuDriver, linuxGPUDevice) whose work is local-fs and synchronous —
cancellation has nothing to reach.

**duration/shift overflow** — exponential growth without a cap wraps
to negative or panics. All sites verified bounded:
`backoff *= 2` (run.go:613) is guarded by `backoff <
reconnectBackoffMax` — at most 2×max, never wraps; `stride <<= 1`
(setup.go:92) multiplies worker stride but the loop terminates under
`total <= 1<<31` guard; `idx = (idx << 1) | bit` (seed.go:221) builds
an 11-bit word index (≤2047); `byte(n >> (8*i))` (stratumv1.go:357) is
bounded by en2 size (≤32, per session-262 bound). The one genuinely
dangerous shift — `v.Lsh(v, 8*(exp-3))` in `TargetFromNBits` —
already rejects `exp < 3` (negative shift → panic), negative-mantissa
bit, zero mantissa, and `len(b) > 32` post-shift overflow; pool-supplied
nBits cannot reach a panic path. Constants `1<<24`-style are compile-
time. Zero defects.

| M | context stored in struct | Absent — all ctx is first-parameter; only func-type fields use the name |
| M | duration/int shift overflow | Absent — every growth is capped or guarded before shift/multiply |



## Session 604 update — silent zero-value on decode failure

Residual surface of the session-595 fail-closed fix: every decoder that
can yield a zero value when parsing fails (`hex.Decode*`, `base64`,
`big.Int.SetString`, `strconv.Parse*`, `Atoi`, `UnmarshalText`). If a
call site drops the error, downstream code consumes a fabricated zero —
the class that made notify produce zero-MerkleRoot jobs.

| S | `hex.DecodeString` sites (`stratumv1/parse.go` ×5, `stratumv1.go` en1). | ✅ All fail-closed since #677: coinb/merkle/prevhash reject malformed or wrong-length values; `extranonce1OK` returns false; `completeV1Job` bails on en1 decode error. `base64`, `hex.NewDecoder`, `SetString`, `UnmarshalText`: zero non-test call sites. |
| S | `strconv.Atoi` unchecked at `parse.go:268` — a failed parse sets `reconnectDirective.Port = 0`, a fabricated value a consumer could dial. | ✅ Benign: `Port`/`Host` are recorded but never consumed — `parseReconnect`'s doc explicitly states the pool-supplied `Host:Port` is NOT honored (only `Wait` is, via `ReconnectWait`, bounded by `maxReconnectWaitSeconds`). The zero can reach no dialer. |
| S | `strconv.ParseUint` unchecked at `stratumv1.go:484` — `uintID`'s string-id fallback returns 0 on unparseable input. | ✅ By design: every request id Otedama sends is a `uint64`, so a non-numeric string id can never match a pending entry regardless — 0 is just another unmatched key, and the response is dropped either way. |
| M | `strconv.ParseFloat`/`Atoi`/`ParseUint` remainder (`rates`, `config`, `hashrate`). | ✅ All error-checked; non-finite rejection audited in #437/#443/#478. |

No reachable site lets a failed decode masquerade as a valid zero.



## Session 645 update — embed + weak-crypto audit

| Cat | Finding | Disposition |
|---|---|---|
| M | `//go:embed` directive misuse — pattern/type mismatch fails the build (low risk but verifies the class). | ✅ Absent: zero `go:embed` sites — the BIP-39 wordlist is a generated `.go` string literal, all other data is computed or external. |
| S | Weak cryptographic primitives on a security path — MD5/SHA-1/DES/ECB providing false integrity/confidentiality (the weak-crypto class). | ✅ Clean: zero md5/sha1/des/ECB sites; the crypto surface is `subtle` (constant-time compare), `sha256`/`sha512`/`hmac` (BIP-39 + mining), `aes`+`cipher` (AES-GCM seed store), `rand`, `tls`, `x509` — all standard, none weak. |

All packages build, vet, and test green.

---

## Session 684 update — lock-channel + duration-overflow + hot-sprintf audit

| Cat | Finding | Disposition |
|---|---|---|
| S | Mutex held across a channel send/receive — a blocked peer wedges every lock holder (the lock-channel class; extends s560/s632). | ✅ Clean: channel ops adjacent to locks all sit after `Unlock` (e.g. worker snapshots `cancel` under `mu` then waits on `done` unlocked) — no Lock→send/recv region. |
| P | `time.Duration` formed by unchecked multiplication — `d * n` with large `n` wraps int64 to a negative sleep (the duration-overflow class). | ✅ Clean: the single product (`stats.go` p50→Duration) multiplies a bounded measured latency (~seconds) — magnitudes orders below int64 wrap; timeouts/deadlines are literal constants. |
| P | `fmt.Sprintf` in the hash hot path — per-nonce allocation churn (the hot-format class). | ✅ Clean: `Sprintf` appears only in display formatting (`HashRateString`, log lines) at stats/log cadence; the hashing loop calls `HashHeader` with zero allocs (s534 verified). |

All packages build, vet, and test green.


## Session 693 update — file-handle + Must-init + printf-verbs audit

| S | `os.Open*`/`Create*` handles without a `Close` path — descriptor leak until process exit (the file-handle class). | ✅ Clean: `logfile` stores the handle on the owned writer (closed on rotate/close); the wallet temp file closes+removes on every error branch; remaining sites are self-contained `ReadFile`/`WriteFile`; `configfile` defers `Close`. |
| M | `Must*`/`MustCompile`/`template.Must` initializers — a runtime data problem becomes a process crash (the must-init class). | ✅ Clean: zero sites — all initializations return errors. |
| S | `fmt.Errorf` verb/argument mismatch — `%d` on a string prints `%!d(MISSING)` and corrupts diagnostics (the printf-verbs class). | ✅ Clean: `go vet ./...` printf analysis reports nothing across ~234 `Errorf` sites. |



## Session 692 update — aead-nonce + time-equality + hash-reuse audit

| S | AEAD (AES-GCM/ChaCha) keyed nonce reuse or fixed IV — ciphertexts become plaintext-comparable/forgable (the nonce-reuse class). | ✅ Clean: wallet `EncryptSeed` fills `es.Nonce`+`es.Salt` from `crypto/rand` per call; the Noise transport derives each frame nonce from a monotonically incrementing `uint64` counter per Noise spec — no fixed IV. |
| M | `t1 == t2` on `time.Time` — monotonic-vs-wall mismatch gives false negatives (the time-equality class). | ✅ Clean: zero `==` on `time.Time`; all comparisons go through `time.Since`, `.Equal`, or unix-nano arithmetic. |
| S | `hash.Hash` reused across computations without `Reset` — concatenated digests silently corrupt verification (the hasher-state class). | ✅ Clean: the pooled hasher does comma-ok + `Reset` on borrow; `hmacSHA256`/`hmacSHA256Pooled` build fresh `sha256.New` per call; the Noise handshake hash is single-owner sequential per spec. |



## Session 691 update — http-server + sync.Pool + decoder-strictness audit

| S | `http.Server` without `ReadHeaderTimeout` — Slowloris header stalls exhaust sockets (the server-timeout class). | ✅ Clean: the metrics/health server sets `ReadHeaderTimeout` 5s plus `Read`/`Write`/`Idle` timeouts — full Slowloris posture. |
| P | `sync.Pool` objects reused without reset or type-checked — stale state leaks between borrowers (the pool-hygiene class). | ✅ Clean: `hashPool.Get` uses comma-ok then `h.Reset()` before lending; `Put` sites return the same concrete `hash.Hash` type. |
| S | `yaml`/`xml`/`gob` decoders accepting unknown fields or unbounded documents — config drift and decode bombs (the decoder-strictness class). | ✅ Clean: `yaml.NewDecoder` runs `KnownFields(true)` (unknown keys are hard errors) with EOF-as-empty handling; `xml`/`gob` decoders absent. |



## Session 690 update — dial-context + exec + signal-stop audit

| P | `net.Dial`/`tls.Dial` without a context or timeout — dial stalls block forever (the dial-context class). | ✅ Clean: every dial path uses `DialContext` (engine, stratum TLS, stratumv1/v2 dialers) or an explicit `net.Dialer{Timeout: …}` (doctor probes, 3–5s) — no bare `net.Dial`. |
| S | `os/exec` with attacker-influenced argv — command injection (the exec-argv class). | ✅ Clean: four sites — `systemctl is-active`, `launchctl list`, `sc.exe query`, and the service-manager `exec.Command(name, args…)` — all invoke fixed platform tools with constant/service-defined arguments; no user-controlled string reaches argv. |
| S | `signal.Notify` without a matching `signal.Stop` — a cancelled registration keeps the channel subscribed (the signal-stop class). | ✅ Clean: the only signal use is `signal.NotifyContext`, whose `cancel` performs the `Stop` — canonical. |



## Session 689 update — map-comma-ok + double-close + wire-tag audit

| S | Map reads without comma-ok where missing vs zero-value changes behavior — silently treating absent as present (the map-comma-ok class). | ✅ Clean: `updateStream`'s bare `m[key]` reads the zero `Stream`, populates it, and writes `m[key] = existing` back — missing key is the intended fresh-stream path; `dup`-checks and `pending`/`drivers` lookups all use comma-ok or `_, present :=`. |
| S | `close(ch)` reachable twice — double-close panic on reconnect/teardown (the double-close class). | ✅ Clean: every close is single-shot guarded — `cancelPending` under `pendingMu`+delete, dispatch's delete-before-close, worker's post-`wg.Wait` close, dashboard's CAS on `started`, producer-side `wg.Wait`+close (fanin, hashrate, registry, polling). |
| S | `json:"-"`/`,omitempty` on wire-marshalled fields — silently dropping or renaming protocol fields (the wire-tag class). | ✅ Clean: zero sites — V1 JSON uses explicit `params` literals, V2 is the binary frame codec; no tag drift on wire structs. |



## Session 687 update — httputil + x509-verify + path-portability audit

| S | `net/http/httputil` or unchecked `x509` parsing — reverse-proxy surface or unvalidated certificate bundles (the transport-security class). | ✅ Clean: `httputil` absent; all three cert-pool sites fail hard on `!AppendCertsFromPEM` (TLS config builders in stratum/stratumv1, doctor pre-check) — no silent empty-pool path. |
| M | `filepath.IsAbs`/`VolumeName`/manual separator joining — Windows/POSIX path portability drift (the path-portability class). | ✅ Clean: the only separator use is the daemon's `\tmp`-rooted fallback when the home dir is unresolvable — deliberate drive-root fallback, documented; no `IsAbs`/`VolumeName` call sites needing review. |
| M | Duplicate `tlsConfigWithExtraCAs` in stratum + stratumv1 — verbatim helper duplication across package boundary (the duplication class). | ✅ Benign: the two copies sit behind a package boundary that keeps `internal/stratum/` free of poolproto deps — vendoring the helper is cheaper than introducing a shared crypto-util package for 12 lines. |



## Session 686 update — assertion-ok + tls-verify + rand-seed audit

| S | Single-value type assertions on `json.Unmarshal`-decoded `any` — a malformed pool payload panics at the assertion (the decode-assert class; regression check after s634). | ✅ Clean: both V1 decode assertions (`arr[1].(string)`, `arr[2].(float64)`) use comma-ok with explicit error branches — zero unchecked `.(T)` on decoded data. |
| S | `tls.Config{InsecureSkipVerify: true}` or `MinVersion < TLS12` — MITM-capable connections (the tls-verify class). | ✅ Clean: zero `InsecureSkipVerify`; every client config sets `MinVersion: tls.VersionTLS12` (stratum/tls.go, stratumv1/tls.go); protocol `MinVersion` fields are SV2 wire values, not TLS. |
| S | `rand.Seed`/`rand.New` with predictable seeds (`time.Now`) on security paths — weak token generation (the rand-seed class; extends s624). | ✅ Clean: zero `math/rand`/`Seed`/`rand.New` — all randomness is `crypto/rand` (s624). |



## Session 685 update — external-endpoint + any-signature + dialer-goroutine audit

| S | `https?://` literals reaching undeclared endpoints — telemetry or exfil surface hiding in string constants (the endpoint-inventory class). | ✅ Clean: every external literal is a declared feed — Coinbase/Kraken/CoinGecko rate sources, mempool.space + blockchain.info hashrate sources, `api.coinbase.com/v2/time` doctor clock-skew probe, plist DTD and spec links in comments. No telemetry URL exists. |
| M | `any`/`interface{}` parameters in exported (capitalized) functions — weakly-typed public surface (the any-signature class). | ✅ Clean: zero sites — exported APIs are concretely typed; `any` appears only as map values on internal decode paths (validated in earlier sessions). |
| S | `go func` spawned in dialers/session code without a completion signal — detached workers that leak past `Close` (the dialer-goroutine class; extends the s553 leak map). | ✅ Clean: zero `go func` inside `internal/poolproto/`; the engine's background goroutines all select on `ctx.Done()` and join via `wg`/`done` (s553). |



## Session 683 update — loop-capture + iota-wire + dead-const audit

| S | `for range` loop variable captured by `go func` — the pre-1.22 shared-variable capture (the loop-capture class; regression check after s634). | ✅ Clean: all five fan-out sites pass the loop variable as an explicit parameter (`go func(c <-chan T)`, `go func(s Source)`, `go func(idx int, chk Check)`, `go func(d Driver)`) — canonical even under pre-1.22 semantics. |
| S | `iota` enum values serialized onto the wire — renumbering a constant silently shifts the protocol (the iota-wire class). | ✅ Clean: all five `iota` blocks are internal-only (Policy, AddressType, Status, ValueOrigin, Format); wire message types use explicit numeric constants, never `iota`. |
| M | Declared-but-unused `const`/helpers — dead declarations rotting in the tree (the dead-const class; covered by the s532 deadcode sweep). | ✅ Clean: deadcode verdict from s532 stands — no new unused constants introduced; `go vet` + build confirm none today. |



## Session 682 update — nil-interface + header-key + atomic-bypass audit

| S | Interface `nil` checks that miss typed-nil — `(*T)(nil)` boxed in an interface compares `!= nil` (the nil-interface class; re-verified after s640). | ✅ Clean: no new typed-nil constructions since s640 — interface-returning sites still produce only untyped nil. |
| M | `http.Header` written via direct map index (`Header["K"]=`) — bypasses canonical textproto casing so `Get("K")` misses (the header-key class). | ✅ Clean: zero direct-map writes; every header is set via `w.Header().Set(...)` which canonicalizes; no case-folded map keys (`ToLower(...)]`) anywhere. |
| S | Plain assignment/read on a field declared `atomic.*` — bypasses the atomic op and tears the value under racing access (the atomic-bypass class). | ✅ Clean: zero bare assignments to `curtailGate`/`started`/`closed`/`ready`/counter fields — all access goes through `Load`/`Store`/`Swap`/`Add`. |



## Session 681 update — init-side-effect + unlock-balance + dynamic-inspect audit

| M | `init()` with ordering-dependent or re-entrant side effects — init-order fragility and duplicate registration (the init-surface class, second pass after s567). | ✅ Clean: all four `init()` are self-contained — wordlist split+SHA-256 self-verify (lightning), stub/dialer `Register` calls into owning-package registries (btccrypto, stratumv1, stratumv2); no cross-package ordering dependency, each registration additive. |
| S | Manual `mu.Unlock()` on an early-return path that skips it — a missed unlock wedges the mutex (the unlock-balance class). | ✅ Clean: every non-deferred `Unlock` is the canonical lock-snapshot-unlock or a local branch symmetric with its `Lock` (worker stats, arbitrate streams, dashboard, metrics accessors) — no branch escapes the pair. |
| S | `%T`/`encoding/gob` dynamic type inspection on wire data — gob is unbounded and `%T` can leak internals (the dynamic-inspect class). | ✅ Clean: `%T` appears only in decode-error diagnostics (unexpected type reporting); `encoding/gob` absent. |



## Session 680 update — bool-env + mustcompile + path-package audit

| S | Boolean env/flag values checked with string equality (`== "true"`, `== "1"`) — silently treats `TRUE`/`yes`/`on` as false (the bool-parse class). | ✅ Clean: zero `ParseBool` misuse — env lookups return strings into the layered config where typed conversion happens once; no ad-hoc truthy comparisons. |
| S | `regexp.MustCompile` at package init — a bad pattern panics at startup, and an attacker-influenced pattern is a ReDoS surface (the mustcompile class). | ✅ Clean: zero `regexp` usage in production code (verified s617); nothing compiles patterns at init or from input. |
| S | `path` package applied to filesystem paths — `path.Join` on Windows paths or `..` elements produces non-native results (the path-package class). | ✅ Clean: every filesystem join uses `filepath.` (service defs, sysfs probes, log paths); `path` appears only inside `filepath`/`urlpath` identifiers — no `import "path"` on filesystem data. |



## Session 679 update — wg-negative + json-streaming + deadline-semantics audit

| S | `wg.Done()`/`wg.Add(-1)` beyond the paired count — driving the counter negative panics or unblocks `Wait` early (the wg-negative class). | ✅ Clean: `Done` appears only as `defer wg.Done()` at goroutine start after a matching `Add(1)` (worker, fanin); zero `Add(-` calls. |
| M | `json.NewDecoder` reused across concatenated objects or its partial-decode state ignored — a stream decoder on a one-shot payload (the streaming-decode class). | ✅ Clean: zero `json.NewDecoder` sites — every decode is `json.Unmarshal` on a complete frame or the line-framed V1 reader (validated in earlier sessions). |
| P | `SetDeadline` where only one direction needs a bound — a shared deadline lets a stalled write mask a healthy read side (the deadline-semantics class). | ✅ Clean: `SetDeadline` appears only at handshakes (both directions bounded, cleared after); steady-state I/O uses separated `SetReadDeadline` (5-min job-wait in V1, negotiate in V2) and `SetWriteDeadline` (10s writes) — directionally correct. |



## Session 678 update — recover-value + goroutine-t + sanitize-boundary audit

| S | `recover()` whose returned value goes uninspected — catching a panic without classifying it resumes on an unknown failure (the recover-blanket class). | ✅ Clean: zero `recover()` sites — the codebase propagates errors instead of catching panics; the only panics are startup-contract assertions (s644). |
| M | `t.Log`/`t.Error`/`t.Fatal` called from a goroutine that outlives `t` — post-teardown races on `testing.T` (the goroutine-t class; regression check after PR #705). | ✅ Clean: zero remaining sites — the #705 rewrite holds; no test calls `t` methods outside its own goroutine. |
| S | `%s`/`%v` on pool-controlled strings at the log boundary — unsanitized C0/C1/control text reaching the terminal (the sanitize-boundary class). | ✅ Clean: every pool-text `%s` (`share rejected` reason, V1 reject reason, `pool notice`) is produced by `poolproto.SanitizePoolText`/`sanitizeNotice` upstream; remaining `%s` args are typed enums, parsed durations, or user-config hosts run through `StripUserinfo`. |



## Session 677 update — atomic-alignment + typed-wrapper + unsafe audit

| S | `unsafe.Pointer`/`uintptr` — breaking the GC's pointer-tracking contract (the unsafe class; re-verified after s605). | ✅ Clean: zero `unsafe.`/`uintptr` sites in non-test code. |
| P | Old-style `atomic.AddUint64(&x)` on a struct field — requires manual 64-byte alignment on 32-bit archs or the op crashes (the aligned-64 class). | ✅ Clean: the free-function API is absent; every counter/flag uses the typed `atomic.Bool`/`Uint64`/`Int64`/`Pointer[T]` API (worker counters, curtail gate, httpserver ready/bound-addr/serve-err, dialer closed/diff, metrics values, TUI started, logger defaultPtr), which embeds its own alignment guarantee. |
| M | `atomic.Pointer[T]` used where a plain pointer under mutex would do — or vice versa, an unguarded pointer where atomic is required (the synchronization-choice class). | ✅ Clean: each `atomic.Pointer` stores a write-once/read-many value (`boundAddr`, `serveErr`, `defaultPtr`) that would otherwise need a dedicated mutex — the right primitive for the access pattern. |

