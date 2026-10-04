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
- ✅ Resolved: the decision landed as `btccrypto.ValidateAddress` — the
  unified dispatcher over bech32/bech32m/Base58Check (`bech32.go`); every
  validator call site (config file check, doctor payout/failover probes)
  routes through it. No charset-level duplication remains.

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
| S | Package doc claimed terminal width is "detected at startup via TIOCGWINSZ (Unix) or GetConsoleScreenBufferInfo (Windows)"; `SetWidth` exists but is called only from test files — every real invocation renders at the hardcoded 80-column default regardless of actual terminal size. | ✅ Resolved (session 385): the decision landed as hand-rolled per-platform syscalls via the already-direct `golang.org/x/sys` dep — `width_unix.go` `unix.IoctlGetWinsize(TIOCGWINSZ)`, `width_windows.go` `GetConsoleScreenBufferInfo`; `detectWidth` refreshes `d.cols` each render tick and `SetWidth` pins it for tests/embedders. KNOWN_LIMITATIONS §15 marked resolved. |
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



## Session 644 update — panic-site + tail-index audit

| M | `panic(` sites in library code reachable via untrusted input (pool input crashes the process). | ✅ Clean: all 12 panic sites are programming-error assertions unreachable from input — `Worker.Start` double-call, `poolproto.Register`/`btccrypto` duplicate-registration contracts, `metrics` static-name validation, BIP-39 wordlist length+hash integrity (init-time data check). |
| M | Tail indexing `s[len(s)-1]` / `s[:len-1]` on a possibly-empty slice (negative-offset panic class). | ✅ Clean: all 4 sites are guarded — `ID.Valid` returns early on `""`, `parse.go` bounds by `len(b) > 0` in the loop condition, `en2` writes bound `i < len(en2)`, completion.go uses a comparison not an index. |



## Session 642 update — nil-func-call audit

| M | Calling an optional func-value field that may be nil — nil-function panic on the injected callback (the nil-callback class). | ✅ Clean: every func field is safe by one of two forms — default-filled at construction (`run.go:192` `log = func(_,_) {}`; `dialFn` production default at both dialers; `extract`/`apply`/`Run` always set in table literals) or nil-guarded at the call (`onConnected`, `f.logFn`, `LogFn`, `HashrateFunc`/`NetworkHashrateFunc`). No unguarded optional call site. |



## Session 641 update — Split-index + io.Pipe audit

| M | `strings.Split` followed by fixed-position indexing — a repeated or missing separator yields fewer parts and an index panic (the split-index class). | ✅ Clean: only 2 `Split` sites exist, neither indexes — `gpu_linux` iterates lines with `CutPrefix` per line, the BIP-39 wordlist consumes the whole slice. All key=value / scheme extraction uses `Cut*`/`CutPrefix` (comma-ok). |
| M | `io.Pipe` misuse — close semantics and writer-blocked-forever when the reader exits early (the pipe-ownership class). | ✅ Absent: zero `io.Pipe` sites — streaming is direct conn/reader based. |



## Session 640 update — typed-nil + signal-channel audit

| M | Typed-nil through an interface — a `(*T)(nil)` returned where the type is an interface survives `x != nil` and nil-derefs downstream (the typed-nil class). | ✅ Clean: zero `(*T)(nil)` returns into interface types — the only `(*X)(nil)` forms are the compile-time satisfaction assertions (`var _ Provider = (*MiningProvider)(nil)`). Interface-returning error paths use untyped `nil` (`DialURL` → `Session`, driver `Lookup` → `Dialer`); `Enumerate`/`Detect` return nil *slices*, which are nil-safe. |
| M,S | `signal.Notify` on an unbuffered channel — a second signal arriving before the handler reads is dropped. | ✅ Absent: no raw `signal.Notify` — the only use is `signal.NotifyContext` (run.go:208, canonical; internally buffered correctly). |



## Session 639 update — ledger-staleness sweep

| M | Deferred ledger rows that later resolutions never amended — a stale "⏸ deferred" stays indistinguishable from an open item. | ✅ **2 stale rows amended in place**: the TUI terminal-width row (resolved session 385 — `detectWidth` per render tick via `x/sys`, §15 marked resolved) and the address-validator dedup row (resolved — `btccrypto.ValidateAddress` is the single source). |
| M | Remaining deferred rows re-verified against current code: passphrase-string immutability (Go semantics, unchanged), `clock.Clock` test-only gap (rates/providers still use `time.Now()`, unchanged), Noise `readMessage2` soft-degrade (still the documented P-256 stub, secp256k1 migration pending — correctly stays deferred). | ✅ Accurate as-is. |



## Session 638 update — Tick + range-channel audit

| M | `time.Tick(d)` — returns a channel that can never be stopped; the ticker lives for the process lifetime (the unstoppable-ticker class). | ✅ Absent: zero `time.Tick` sites — every periodic source is `time.NewTicker` paired with `Stop()` (session 590). |
| M | `for v := range ch` where the producer never closes — the consumer blocks at the range head forever once senders exit (the hung-range class; can't observe ctx). | ✅ Absent: zero range-over-channel sites — all channel consumption is `select`-based with `ctx.Done()` cases (fanIn per-channel goroutines, session `Jobs()`, `merged` shares). The only `range` hits are map/slice iteration. |



## Session 637 update — flush + context-cancel audit

| M | `bufio.Writer` without `Flush` — buffered bytes silently dropped on return (the unflushed-writer class). | ✅ Absent: zero `bufio.NewWriter` sites — all writes go directly to files/conns/loggers (or `bufio.Reader`-side only). |
| M | `context.WithCancel/WithTimeout` whose cancel is never invoked — the uncancelled-context leak (timers and child spans retained until parent exits). | ✅ Clean: all 12 sites have a matching cancel — 8 `defer cancel()`, 3 stored into a lifecycle field invoked on Close/Stop (`worker.cancel`, `poller.cancel`, `session.ctxCancel`), 1 explicit `dialCancel()` after the bounded dial. |



## Session 634 update — assertion-form + loop-capture audit

| M | Single-value type assertion `v := x.(T)` — panics when the dynamic type differs (the assertion-panic class on pool-controlled `interface{}` fields). | ✅ Clean: every assertion is comma-ok (`sess.(ReconnectWaiter)`, `arr[1].(string)`, `resp.result.(bool)`) or a type switch (`m.ID`). The `accepted, _` site discards `ok` but degrades fail-closed — a non-bool `result` is treated as "not accepted" and reports an error. |
| M | `go func` capturing the loop variable — pre-1.22 semantics the closure shares the variable and sees the last value (or a data race under concurrent writes). | ✅ Clean: all 6 in-loop `go func` sites pass the variable as an explicit parameter (`func(threadID int)`, `func(c <-chan T)`, `func(idx int, chk Check)`, `func(dr Driver)`, `func(s ...)`) — the canonical capture-avoidance form, correct on every toolchain version. |



## Session 633 update — defer-order + dispatch-map audit

| M | `defer x.Close()` registered before the error check — a nil handle reaching the deferred call (nil-interface panic on cleanup). | ✅ Clean: all 5 `defer *.Close()` sites (config file, 2× HTTP body, pool conn, session) sit strictly after the `err != nil` early return; the doctor probe defers a drain-then-close closure likewise gated. |
| M | `map[k]func` dispatch called without an `ok` check — a missing key yields a nil-function call panic. | ✅ Absent: zero `map[...]func` tables exist — all dispatch is switch/if-chains and interface polymorphism. The class is structurally unrepresentable here. |



## Session 631 update — library-exit + HTTP-body audit

| M,S | `os.Exit`/`log.Fatal*` inside `internal/` — a library path that kills the embedding process mid-defer (the library-exit class: skipped cleanup, no error propagation to the caller). | ✅ Clean: zero `os.Exit`/`log.Fatal*` call sites in `internal/` — the only hit is a doc comment describing the `os.Exit(report.ExitCode())` contract, whose exit decision lives in `cmd/otedama`. Every library error propagates (session 568). |
| M | `http.Response.Body` left unclosed/undrained — connection leak and keep-alive abandonment (under HTTP/2, spurious RST_STREAM) — the response-lifecycle class. | ✅ Clean: all 3 `client.Do` sites (`doctor` clock probe, `rates` hashrate, `rates` fetcher) `defer resp.Body.Close()` after the err check, with bounded drains for keep-alive (8 KiB discard on the probe, `maxHashrateBody` on non-200). The doctor site documents the drain-then-close requirement explicitly. |



## Session 630 update — epoch-unit + config-tag audit

| M | Epoch unit confusion: seconds vs milliseconds vs nanoseconds mixed across pool-time (`ntime` u32 seconds), uptime deltas, and gauge values — the `Unix()`/`UnixMilli()` swap class. | ✅ Clean: no `time.Unix(x)` constructor calls exist — every site uses `Now().Unix*()` so there is no input to misread. Pool ntime domain is `Unix()` seconds throughout (rollNTime `declared < now`, lastJobReceivedAt/reject gauges); uptime deltas are `UnixNano` at both ends (worker.go). Unit mixing is structurally impossible. |
| M | Config tag asymmetry: an exported field missing `yaml:` becomes silently unconfigurable via file while looking complete (KnownFields would *reject* the yaml key instead — fail-safe) — or missing both tags becoming invisible in dumps. | ✅ Clean: all 13 file-facing fields carry `yaml:` tags (KnownFields decode means an untagged export would be a hard error, not silent loss). The only untagged exports live on internal tracking structs (`ValueOrigin` map, summary view) that never decode files; `config show` emits an explicit doc map keyed by canonical yaml names. |



## Session 629 update — wire-marshal nil semantics audit

| P | nil `[]any` reaching `json.Marshal` → `"params":null` on the V1 wire (some pools reject `null` where the spec shows `[]` — the nil-vs-empty wire drift class). | ✅ Clean: `session.call` has exactly 4 call sites and every one passes a literal non-nil `[]any` (submit builds the 5-element share tuple; subscribe/authorize/extranonce.subscribe are literals, the last explicitly `[]any{}` → `[]`). `params` can never be `null` on the wire. |
| P | Generic `rpcMessage` (`Result`/`Error`/`ID` as `any`) leaking spurious `"error":null`/`"result":null` keys outbound — field-presence drift vs JSON-RPC expectations. | ✅ Clean: `rpcMessage` is decode-only; outbound requests marshal a 3-key map (`id`/`method`/`params`) — `result`/`error` keys can never appear. Decode side treats `null` as nil (`any`), matching JSON-RPC semantics (session 566). V2 is binary — no null semantics exist. Other marshal sites (`version --json`, config dump, doctor `/healthz`) are operator-facing output where null-vs-`[]` is cosmetic, not protocol conformance. |



## Session 628 update — spec-name drift + modernization leftovers 2

| M | Post-sv2-spec-#228 stale names lingering in comments/docs after the #704 rename — `min_ntime`, `maximum_target`, `header_timestamp`, `header_nonce`, `prev hash` (partial-rename drift class). | ✅ Clean on the #704 branch: zero residue including block comments — every `min_ntime`/`MinNtime`/`MaxTarget`/`maximum_target` hit on master is a site #704 already renames. (Verified on `devin/1790945186-s622-specnames`; the hits reported here are master's pre-merge state, expected until #704 lands.) |
| L | Modernization leftovers, batch 2: `io/ioutil` legacy calls, `reflect` escape hatches, `filepath.Walk` (vs `WalkDir`), manual multi-error concat (vs `errors.Join`), `signal.Notify` channel plumbing (vs `signal.NotifyContext`). | ✅ Clean: `io/ioutil`, `reflect`, `filepath.Walk` all zero — the tree is fully post-1.16 idiom. `errors.Join` used exactly once at its natural site (rates fetcher joining per-source failures, `joined != nil` guard). Signal handling is the canonical `signal.NotifyContext(ctx, os.Interrupt, SIGTERM)` in run.go:208. |



## Session 626 update — t.Parallel shared-state audit

| M | `t.Parallel()` subtests touching shared mutable state (package fixtures, global counters, env vars) — the parallel-test interference class, including `t.Setenv`/`t.Chdir` inside a parallel test (runtime panic). | ✅ Clean: 19 `t.Parallel` sites across 5 files all operate on per-call values — `config.Defaults()` fresh Configs, `allCatalogSpecs[i].fn()` building a fresh `*Catalog` each call, copied range vars (`tt`/`tc` by value under go≥1.22 semantics), pure value-receiver reads (`Header.Validate`, `Family.Valid`, `ChannelMsg`). The only shared fixture, `placeholderRE`, is a compiled regexp — safe for concurrent use by contract. Zero `t.Setenv`/`t.Chdir`/`os.Setenv` in any parallel-capable file, so no env interference either. |



## Session 625 update — sync.Map + unchecked-Sscanf audit

| M | `sync.Map` misuse (mixed key types, Range-snapshot iteration, missing "zero value ready" contract) — the map-substitution bug class. | ✅ Clean: the tree's only `sync.Map` is `pauseSet` (arbitrate.go) — fixed `string→struct{}` key/value shape, single-writer (arbitration loop) with pool-dispatch readers, `Load`-only reads (no `Range`), zero value documented as ready-to-use. Canonical form; a mutex+map would add nothing but a second lock discipline to audit. |
| M | `fmt.Sscanf` with discarded error (`_, _ =`) — malformed input silently yields a zero destination (silent zero-value class, cf. session 604). | ✅ Benign-by-contract: the sole unchecked site is `parseJobID` (dialer.go:401), whose own table test documents `"bad"→0` deliberately. In the V2 flow `sub.JobID` is always `FormatUint`-derived, so malformed input is unreachable; even if reached, `JobID=0` is a *valid* wire value — the pool rejects the share as unknown/stale job, i.e. fail-safe rather than silent credit. The engine-side `Sscanf` (run.go:1781) is checked and fails the job loudly. |



## Session 624 update — randomness provenance + nil-error deref audit

| S | `math/rand` reaching security-adjacent paths (nonces, ephemeral keys, jitter that shapes protocol timing) — the weak-RNG class. | ✅ Clean: zero `math/rand` import anywhere in `internal/`/`cmd/` (test or prod). All 6 production randomness sites use `crypto/rand` — `rand.Int(rand.Reader)` for wallet-setup index picks (setup.go) and `rand.Reader` injected for seed/wallet KDF salts and Noise P-256 ephemeral keys (seedstore.go, seed.go, wallet.go, noise.go). Weak-RNG surface structurally absent. |
| M | `err.Error()` on a potentially-nil error → nil-pointer dereference (usually via a missed guard in logging paths). | ✅ Clean: all 5 `.Error()` call sites in production sit behind a proven `err != nil` guard — cmd/otedama/run.go's `err != nil && err != context.Canceled` gate, engine run.go's `if err := applyJob(...); err != nil`, and both Fetcher sites inside `if err := f.Fetch(ctx); err != nil`. No error-valued field or unchecked provenance site exists. |



## Session 620 update — make+append off-by-n + self-append-in-range audit

**`make([]T, n)` then `append`** — preallocating with length `n`
then appending produces `n` leading zero-valued elements (the
"capacity vs length" classic — the slice already *contains* n
zeros). Verified all `make([]T, n>0)` sites: every one is a
fixed-size wire buffer (12B nonce, 24/16/6B encode buffers) written
by index — `PutUint32`/`copy` into `buf[i:j]` — never appended to.
Zero defects.

**self-append during range** — `for _, v := range s { s = append(s,
...) }` skips or double-processes elements because range evaluates
the slice header once (new elements appended past the original
length are never visited — and re-slicing can re-visit). Verified
via PCRE2 backreference sweep: zero production sites append to the
ranged slice inside its own loop.

| M | make+append leading-zero corruption | Absent — all fixed buffers are index-written |
| M | self-append in range loop | Absent — zero sites |



## Session 619 update — %w scope + fallthrough audit

**`%w` outside `fmt.Errorf`** — the wrap verb is only meaningful
inside `Errorf`; used in `Sprintf`/`Printf`/`log` it emits literal
`%!w(...)` garbage, silently corrupting the message (and hiding the
real error text at the worst time — inside an error path). Verified:
every `%w` in production code sits inside `fmt.Errorf` — zero
out-of-scope sites.

**`fallthrough`** — Go requires the keyword explicitly, so implicit
fallthrough bugs can't occur; but explicit `fallthrough` in a
type-switch or tag-switch is fragile (it transfers to the next case
without re-checking). Verified: zero `fallthrough` in production
code — every switch exits per-case or shares bodies via case lists.

| M | %w outside fmt.Errorf | Absent — all wrap verbs inside Errorf |
| M | fallthrough fragility | Absent — zero fallthrough sites |



## Session 618 update — errors.As target + named-return defer audit

**errors.As panic** — `errors.As` panics when its second argument is
not a pointer to a type implementing error or `*interface{}` (a
spec-level contract violation, not an error path). Verified: the
single production call site (run.go:1830) passes `&fe` where
`fe *fatalError` — a `**fatalError` target, exactly the required
pointer-to-error-type form. Zero defect sites.

**named-return defer clobber** — a deferred closure that assigns to
a named result (`defer func(){ err = nil }()`-class) silently
discards the real return value — the worst kind of failure
swallowing. Verified: zero `defer func` bodies assign to `err`,
`ret`, `result`, or `out` — the two `defer func` sites (worker sweep,
bounded drain) mutate only channels and waitgroups, never named
results. Function returns are all explicit `return` statements.

| M | errors.As non-pointer target panic | Absent — single site uses `**fatalError` correctly |
| M | defer clobbering named returns | Absent — zero defer-site result assignment |



## Session 617 update — strings.Replace count + regexp audit

**strings.Replace n-count** — `Replace(s, old, new, n)` with
`n < occurrences` silently leaves later occurrences un-replaced
(partial-substitution corruption). Verified: the only replacement
site is `strings.ReplaceAll` at bundle.go:119 (BCP-47 `_`→`-` tag
normalization) — ReplaceAll has no count semantics; zero
`strings.Replace`/`bytes.Replace` calls exist. Class absent.

**regexp** — a regex compiled from untrusted input panics under
`MustCompile` or, worse, admits ReDoS (catastrophic backtracking on
pool-supplied strings). Verified: zero `regexp.` references in
production code — all wire validation is hand-rolled byte/char
checks (stratumv1 parse, bech32, config validators). The entire
class is structurally absent.

| M | strings.Replace partial substitution | Absent — only ReplaceAll for BCP-47 normalization |
| S | regexp on untrusted input (MustCompile panic / ReDoS) | Absent — no regexp usage at all |



## Session 616 update — slice-expression bounds + math-domain audit

**slice-expression panic** — `s[a:b]` panics when `a>b` or `b>len(s)`
(a distinct class from the element-index audit of session-558).
Verified every variable-bound reslice: `candidates[1:]` and
`candidates[0]` sit behind the `len(candidates)==0` early return;
`order = order[1:]` runs inside `for len(order) > jobsCap` (non-empty
by invariant); `maskAddr`'s `a[:6]+a[len-4:]` needs len>12, the guard
requires it; `c.readbuf = c.readbuf[n:]` uses `n = copy(...)` ≤ len;
`payload[:65]/[:33]/[:32]` are each behind explicit len guards plus
the function-level `len < 32` reject; `DecodeNewMiningJob`'s
`payload[off:off+N]` fields sit behind the `minNeed` check and a
re-verified `off+36` bound in the OPTION branch. All fixed-offset
slices index fixed-size arrays ([80]byte header, [12]byte nonce,
[4]byte u32). Zero defects.

**math domain** — `math.Sqrt(-x)`/`Log(0)`/`Pow` produce NaN/±Inf
that silently propagates through yield math. Verified: zero
`math.Sqrt/Log/Pow/Exp/Cbrt/Gamma/Dim` call sites in production code
— yield aggregation is pure float64 add/compare/mul. The class is
structurally absent.

| M | slice-expression out-of-bounds panic | Absent — every variable bound len-guarded, fixed offsets on fixed arrays |
| M | math-domain NaN propagation | Absent — zero math.* domain functions in production |



## Session 615 update — interface-equality panic + range-pointer audit

**interface `==` panic** — comparing two interface values with `==`
panics at runtime when both dynamic types are uncomparable (the
"comparing uncomparable type" panic — a defect hiding behind
seemingly-safe `err1 == err2`). Verified: every error comparison is
against `nil` (the only universal-safe operand) or the sentinel
`flag.ErrHelp` (pointer identity — always comparable). No
interface-vs-interface `==` anywhere; no `any`-typed comparisons at
all. Zero panic sites.

**`&rangeVar` capture** — taking the address of a range variable
hands out a pointer to the iteration copy, not the element (pre-1.22
it aliased all iterations; post-1.22 each iteration is fresh, but the
pointer still refers to a copy — writes via it never reach the
container). Verified: the only stored pointer is `merged[s.ID] = &cp`
at arbitrate.go:323 — `cp` is an explicit deep-copy of the map's
stream (`cp := s` with `YieldPerDevice` re-allocated), so storing its
address is the documented intent. `m.X = &v` sites in
DispatchFrame store fresh per-case decode results — each `v` is a
distinct allocation scoped to its case. `chooseForDevice(&p)` passes
a copy by pointer for read-only use — never stored. Zero defects.

| M | interface `==` uncomparable panic | Absent — all comparisons vs nil or pointer-sentinel |
| M | `&rangeVar` stale-copy pointer | Absent — only the deliberate deep-copy is stored |



## Session 614 update — sync.Pool reset + secret-via-format audit

**sync.Pool stale-object** — a pooled object returned without reset
hands stale state to the next borrower. One pool exists (`hashPool`,
noise_pool.go): `getHasher` calls `h.Reset()` on *checkout* — the
correct reset side (put-side reset would also work; checkout reset is
the idempotent choice). `putHasher` stores the used hasher as-is —
safe because every borrow resets first. Pooled hashers are only ever
sha256 `hash.Hash`; `inner`/`outer` in `hmacSHA256Pooled` both reset
via `getHasher`. Zero defects.

**secret leak via fmt/log** — formatting a secret-bearing value
(`%v`/`%+v`/`%s`/`%q`/`Sprint`) into a log line or error string is the
silent leak class. Verified: every secret-adjacent format mentions
only *lengths and versions* (`decrypted seed is %d bytes`, `mnemonic
has %d words`, `EncryptedSeed version %d`) — never contents. The
mnemonic crosses a string boundary at exactly two places:
`printRecoveryPhrase` writes it to `opts.Output` on first run — the
deliberate one-time display that bypasses the structured logger
(commented as intentional), and `MnemonicToSeed` uses `m.String()` as
PBKDF2 input then zeroes it (`zeroBytes(password)`). No `String()`/
`%v`/`Sprint` on `HandshakeState`, `EncryptedConn`, `Session`, or
`Wallet` — the cipher-key-bearing structs are never formatted.
Fingerprint output is a 7-hex-char sha256 prefix (identifier, not
secret); payout addresses are masked before logging (session-384).

| M | sync.Pool stale-object reuse | Absent — checkout-time Reset() is the correct side |
| S | secret leak via fmt/log | Absent — only lengths/versions formatted; mnemonic only via deliberate TTY + PBKDF2 input |



## Session 613 update — sort-comparator + json-omitempty audit

**strict-weak-ordering in sort comparators** — a comparator that
isn't a proper ordering (returns 0 inconsistently, e.g. on NaN) makes
`slices.SortFunc` nondeterministic and can panic. All three sites are
total orders: `devices` by `Identity.ID` (unique strings), `entries`
by (name, key) lexicographic, `candidates` by score-desc then
StreamID-asc — all lexicographic compositions of total orders. The
float comparator `cmp.Compare(sb, sa)` cannot see NaN:
`Yield.Effective()` collapses non-finite inputs to 0 before candidacy
(engine.go:93-100), `y <= 0` filters them, and Inf compares
consistently — so `cmp.Compare` remains a strict total order even
under extreme values. Zero defects.

**json:",omitempty"** — omitempty on a numeric/bool field silently
drops legitimate zero values (`{"enabled":false}` → `{}`), the
wire-contract data-loss class. Only 3 omitempty sites exist, all on
display-only output where dropping an empty value is the intent:
`Fix` (doctor check hint — empty = no suggestion), `BitcoinAddresses`
and `Origins` (`otedama config` display dump — empty list/map elided
for readability; the struct is never re-parsed). No omitempty on any
numeric/bool field and none on the V1/V2 wire structs (binary
encode/decode, not JSON). Zero defects.

| M | Non-SWO sort comparator | Absent — all total/lexicographic; NaN structurally excluded |
| M | omitempty silent field-drop | Absent — only on display strings/slices/maps, not wire or numeric fields |



## Session 612 update — break/continue scoping + case-fold audit

**break/continue scoping** — a `break` inside `select` or `switch`
exits only that inner construct, not the enclosing `for` (the classic
infinite-loop defect); a `continue` inside `select` continues the
outer `for` (correct but easy to get wrong). Verified: zero `break`
inside `select`/`switch` — all six unlabeled breaks sit directly in
`for` bodies (run.go:465/541 ctx-exit, arbitration:459 best-candidate
found, dashboard:529 visible-width cap). The one nested-loop exit —
hal/registry.go:178/193 — correctly uses labeled `break loop`.
`continue` sites all target the enclosing `for` intentionally
(dashboard.go:522/527 escape-sequence skipping, engine loops). Zero
defects.

**case-insensitive comparison** — `ToLower`/`EqualFold` on wire input
has two traps: comparing a non-folded operand (`s == ToLower(s)`
misses case) and Unicode folding surprises (Turkish-i, ß→ss). All 7
sites verified on ASCII-only domains where both traps are absent:
`EqualFold(TrimSpace(line), mnemonic[pos])` BIP-39 words (ASCII
wordlist), `ToLower(reason)` reject-reason classification (ASCII
pool text), `ToLower(tag)` BCP-47 language tags (ASCII), bech32's
`addr != ToLower(addr) && addr != ToUpper(addr)` (the spec-required
mixed-case *rejection* — opposite of the trap), `ToLower(level)`
log-level parsing, `EqualFold(host, "localhost")` ASCII literal.

| M | break-in-select/switch scope confusion | Absent — all breaks direct-in-for or labeled |
| M | case-fold on wire input | Absent — all on ASCII domains; bech32 uses fold correctly for rejection |



## Session 611 update — strings.Trim* semantics + time.Time comparison audit

**Trim-family set-vs-prefix confusion** — `strings.TrimLeft(s, "x")`
trims a *character set* (every leading rune in "x"), not the string
"x" — a classic defect when a prefix is intended
(`TrimLeft(url, "https://")` eats leading h/t/p/s). All 10 sites
verified: 9 are `TrimSpace` (whitespace set — always the intended
semantics), `TrimSuffix(raw, "\n")` removes the one trailing newline
of the embedded wordlist (suffix semantics — correct), and
`TrimLeft(typed, "-")` (main.go:158) strips a leading dash *run* for
subcommand matching, where set-semantics is exactly what's wanted.
No prefix intended anywhere; zero defects.

**time.Time `==` vs `.Equal()`** — `==` compares the monotonic clock
reading too, so two Times representing the same instant compare
unequal after any serialization round-trip (a monotonic-stripping
defect). Verified: zero `==` comparisons on `time.Time` values — all
time logic uses `time.Since`, `.Sub`, `.Before`, `.After`
(monotonic-safe instant/duration ops): staleness pruning
(`now.Sub(ts) > timeout`), stall detection (`time.Since(lastJobAt)`),
share latency (`now.Sub(sent)`), temp-file sweep cutoff
(`ModTime().Before(cutoff)`), and clock-skew measurement
(`math.Abs(time.Since(serverTime))`). The one pool-controlled
duration — `time.After(w)` for client.reconnect waits — is bounded
at parse by `maxReconnectWaitSeconds` (stratumv1.go:310). Zero defects.

| M | Trim set-vs-prefix misuse | Absent — TrimSpace + correct suffix/set usage |
| M | time.Time `==` monotonic defect | Absent — all comparisons via Before/Sub/Since |



## Session 609 update — nil-map write + float-equality audit

Two more silent/panic defect classes swept.

**nil-map writes** — assigning to a nil map panics (`assignment to
entry in nil map`). Every map-write site checked against its
initializer: `seen`/`idx`/`copied`/`ipToPools`/`submitTimes`/
`submitTargets`/`devices`/`ypd`/`fns` all take `make()` at
declaration; `streamMap` (run.go:349), `lastQuoteAt` (arbitrate.go:154),
`pending` (stratumv1.go:146 literal), `drivers`/`counters`/`gauges`/
`rejectByReason`/`lastRejectByReason`/`sharesFoundPerDevice`/
`payoutInfo`/`registry` (hal:33, metrics:62-63, engine/metrics:470-473,
btccrypto:176, poolproto:333) are all initialized at construction.
`existing.YieldPerDevice` (arbitrate.go:277) has an explicit
lazy-init guard (`if == nil { make }`) before the write at :280.
Zero nil-map writes.

**float `==` comparisons** — exact-equality on float64 is the
classic defect for prices/yields (0.1+0.2 != 0.3). Only two named
float comparisons exist, both correct sentinel semantics:
`margin == 0` (arbitrate.go:178) tests the config-supplied value for
"unset → default" — the config value itself, not a computed result;
`r.rate != 0` (fetcher.go:328) distinguishes "source returned no
value" (zero, silent) from implausible nonzero readings (logged) —
both are sentinel checks, not approximate-equality tests. All real
comparisons use `<`/`>`/`<`; `Confidence`/`SatsPerSecond` fields are
never `==`-compared. Non-finite rejection is session-331/361 territory
(already merged: NaN/Inf collapse to zero in Decide, config rejects
non-finite floats). Zero defects.

| M | nil-map write panic class | Absent — all maps initialized at construction or lazily guarded |
| M | float `==` equality defect | Absent — only sentinel checks (unset-zero, no-value), no approximate-equality |



## Session 608 update — defer-in-loop + map-mutation-during-range audit

Two scheduling/state defect classes swept.

**defer-in-loop** — a `defer` executed once per loop iteration defers
the cleanup until the *function* returns, accumulating resources
(handles, locks, ticker alloc) for the loop's lifetime. All ~90 defer
sites inspected: every defer is function-scoped or goroutine-scoped —
the run.go ticker defers (216, 289, 1861) sit inside `go func(){...}()`
bodies so each runs once when its goroutine exits on ctx.Done, and
run.go:247's `defer func(){ for _, w := range workers { w.Stop() } }`
is a function-exit sweep, not a per-iteration defer. Zero
per-iteration defer sites.

**map mutation during range** — Go permits deleting the current key
during iteration, but writes/deletes to other entries mid-iteration or
concurrent writes are a panic/corruption class. All sites verified:
`pruneStaleStreams` (arbitrate.go:255) deletes only the *current* key
under the streams mutex; `ypd[k] = v` / `copied[id] = msg` /
`prev[j] = j` all write to a *different* (fresh or DP) container while
reading the source — the documented deep-copy idiom; the FIFO evictions
(`jobs`, `pending`, `pendingOrder`) run outside iteration; stratumv1
`pending` and engine `submitTimes`/`submitTargets` deletes execute in
the single owning readLoop goroutine. Zero violations.

| M | defer-in-loop resource accumulation | Absent — all defers function/goroutine-scoped |
| M | map mutation during range | Absent — current-key delete, fresh-map writes, owner-goroutine deletes |



## Session 607 update — copy() silent truncation + append shared-backing audit

Completed the io-contract trilogy (after session-602 short-read and
session-603 partial-write) with the remaining two silent-failure
builtins: `copy()` truncates to `min(len(dst), len(src))` without an
error return, and `append()` on a slice with spare capacity writes
into the shared backing array, mutating any other live view.

**copy() — all 33 production sites verified.**

| Pattern | Sites | Verdict |
| Fixed 32-byte fields (SHA-256d headers, SV2 messages, Noise keys) | sha256d.go:62-75, messages.go ×5, noise.go:189-205 | Exact-fit |
| Length-bound-then-pad (`be[32-len(b):]`) | sha256d.go:167,241 | Guarded: `len(b)>32` rejected above |
| `make()`-sized-then-copy (collectors, samples, devices, slices) | metrics.go:267, stats.go:413, engine.go:322, base58.go:51, seed.go:143 | Exact-fit |
| Hash output to fixed array | btccrypto.go:371, seed.go:304, seedstore.go:162 | 32/64B exact; seedstore length-checks 64 first |
| HMAC ipad/opad zero-pad | noise.go:234-235, noise_pool.go:64-65 | Correct per RFC 2104 (key ≤ block size) |
| Reader-contract short copies | wire.go:148, noise.go:325 | Return `n`; io.Reader semantics |
| Frame encode | frame.go:208 | Buffer sized `HeaderSize+len(Payload)` |
| V1 line copy | stratumv1.go:204 | Fresh alloc same len |

Zero truncation sites — every copy is either exact-fit, bound-checked
immediately before the call, or a contract-short copy returning `n`.

**append() — shared-backing scan.**

The risky shape is `append(s, x)` where `s` retains another live view
of its backing array. All sites fall into three safe classes:
linear builder buffers (wire encoders, argv/issues/lines —
the variable is reassigned and no alias is kept), map-value slices
(`appendUnique` at doctor/checks.go:496 — appended value is stored
back to `ipToPools[ip]` and the backing is only reachable via the
map), and the `pendingOrder` head-trim FIFO at dialer.go:239-302
(`s = s[1:]` + `append(s, v)` bounded by `pendingCap` — the classic
circular-buffer idiom). Noise `append(out1, 0x02)` HKDF taps append
to freshly `Sum`-returned slices used only as HMAC input — the tail
byte cannot leak into another live view.

| M | copy() truncation class | Absent — all sites exact-fit, bound-checked, or n-returning |
| M | append() shared-backing class | Absent — linear builders, map-valued slices, bounded FIFO |



## Session 605 update — runtime-adjacent escape hatches

Bug class: `unsafe`, `syscall`, `runtime`, compiler directives, and cgo
bypassing the abstraction layers the rest of the tree is audited
through — an un-audited low-level path could undermine every guarantee
recorded above (bounds, deadlines, constant-time).

| S | `unsafe` package usage. | ✅ Absent: zero non-test references. Consistent with the s538/s544 `checkptr=2` clean runs — no pointer arithmetic exists to escape memory safety. |
| S | `syscall` direct calls. | ✅ Single site: `syscall.SIGTERM` in `signal.NotifyContext` (`cmd/otedama/run.go:210`) — the canonical cross-platform idiom (SIGTERM is defined on every target; Windows simply never delivers it). No raw fd/socket/process syscalls. |
| S | `runtime` package calls. | ✅ All intended uses only: `Version`/`GOOS`/`GOARCH` for metadata and platform dispatch (s547-audited), `NumCPU` for worker defaults and display (s578-audited), `ReadMemStats`/`NumGoroutine` inside the metrics collector (its documented purpose), and `daemon`'s `var goos` test seam. No `GOMAXPROCS` mutation, no `runtime.SetFinalizer`, no `Goexit`. |
| S | Compiler directives & cgo. | ✅ None beyond `//go:build` platform tags: no `go:linkname`, `go:nosplit`, `go:embed`, `go:generate`, no `import "C"`. Release builds are `CGO_ENABLED=0` fully static (s544 binary audit), so the cgo surface is structurally zero on the shipped artifact. |

Every low-level facility is either absent or confined to its documented
purpose — no un-audited escape path exists.



## Session 603 update — partial-write contract audit

Mirror of session 602 on the write side: a producer calls `w.Write(p)`
once and assumes the whole buffer went out, silently truncating the
stream when the writer returns `n < len(p)`. Every `Write`/`WriteString`/
`WriteByte` call site and `Writer` implementation was inspected:

| S | Fallible-writer call sites checking only `err` (`noise.go:292/295`, `dialer.go:395`, `stratumv1.go:516`, `run.go:1665`, `wallet.go:300`). | ✅ Correct per the `io.Writer` contract: a conforming Writer MUST return a non-nil error when `n < len(p)`, so `err != nil` is a complete partial-write detector. All underlying writers are stdlib types (`net.Conn`, `*os.File`) which honour the contract. |
| S | `EncryptedConn.Write` (`noise.go:282`) — Noise frame writer. | ✅ Contract-conforming: rejects oversized plaintext before framing (`maxNoiseFrame`) rather than truncating — a truncated frame would desynchronise the cipher stream. Returns `0, err` on any underlying failure; callers treat errors as fatal and reconnect. |
| M | `cappedLogFile.Write` (`logfile.go:51`) — rotation wrapper. | ✅ Contract-conforming passthrough: forwards the real `n` to the caller and accumulates `c.size += n`, so rotation accounting can never over-count a short write. |
| M | `hash.Hash`/`hmac` Write sites (`btccrypto`, `noise` mixHash/HKDF, `noise_pool`, `seed.go` MAC). | ✅ Unchecked by design: `hash.Hash.Write` is documented to never return an error. |
| M | `strings.Builder`/`io.WriteString` to in-memory builders (metrics exposition, TUI frame assembly). | ✅ Infallible — `Builder.Write` always returns `(len(p), nil)`. |
| M | `io.WriteString` to `http.ResponseWriter` (healthz/readyz/index) and the TUI terminal writer. | ✅ Best-effort display paths; a response-truncating error is already fatal to the request, and the TUI write is `nolint:errcheck`-documented. |

No `binary.Write` call sites exist. The silent-truncation class is
absent on the write path as well.



## Session 602 update — short-read contract audit

Bug class: a consumer calls `r.Read(p)` once and assumes `n == len(p)`,
silently truncating a message when the reader returns a short read (legal
per the `io.Reader` contract — TCP segmentation, buffering, crypto
wrappers all fragment). Every `Read` call site and `Reader`
implementation was inspected:

| S | Non-test `Read(` call sites that assume a full fill. | ✅ None exist: every consumer goes through `io.ReadFull` — 15 sites across `wire.go` (6: length-prefixed fields + fixed ints), `noise.go` (len prefix + ciphertext), `frame.go` (header scratch + payload), `handshake.go` (2), `seedstore.go` (salt + nonce), `seed.go`. `binary.Read` is unused. |
| S | `EncryptedConn.Read` (`noise.go:305`) — a `net.Conn` shim over the Noise transport; its internal framing must not itself short-read. | ✅ Correct: reads the u16 length prefix and the ciphertext via `io.ReadFull`, decrypts, and serves `copy(p, c.readbuf)` — returning short n is legal for a Reader and consumers read it through `Decoder` (which uses `io.ReadFull`). |
| S | `byteSliceReader.Read` (`wire.go:144`) — in-memory reader feeding the `get*` decoders. | ✅ Correct: copies into the caller's `p`, returns `io.EOF` at exhaustion; all `get*` sites wrap it in `io.ReadFull`. |
| M | `crypto/rand` entropy fills. | ✅ Correct: production paths use `io.ReadFull(rand.Reader, …)`; `rand.Read` (guaranteed full fill) appears only in tests. |

The short-read / partial-consume defect class is structurally absent:
consumers universally use `io.ReadFull`, and the only two `Reader`
implementations satisfy the contract.



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



## Session 675 update — errors.Join + multi-wrap + func-assertion audit

| M | `errors.Join`/`errors.Unwrap` misuse — joining a single error or unwrapping an interface without cause hides the real failure class (the multiwrap-mismatch class). | ✅ Clean: the sole `errors.Join` (rates fetcher) aggregates per-source errors then nil-checks, preserving each cause for `errors.Is` — the documented Go 1.20+ pattern; zero `errors.Unwrap` call sites. |
| M | `fmt.Errorf` with multiple `%w` — silently dropping causes or formatting them as `%!w(MISSING)` (the multi-wrap class). | ✅ Clean: the single site (`stratumv1/dialer.go:164`) wraps `poolproto.ErrHandshakeFailed` + the transport error — both reachable via `errors.Is`, which is correct multi-wrap. |
| S | `.​(func…)` type assertions on `any` — a wrong dynamic type panics at the call boundary (the func-assert class). | ✅ Absent: zero sites — callbacks are statically typed fields, never smuggled through `any`. |



## Session 674 update — concat-allocation + unbuffered-channel + busy-default audit

| P | `slices.Concat`/`append` rebuilding large slices per iteration — quadratic copy work disguised as concat (the allocation-churn class). | ✅ Clean: `slices.Concat` absent; loop-appends are bounded (diagnostic line building, per-frame `merkle_branch`) or pre-sized via `make(..., 0, n)` — no per-iteration quadratic rebuild. |
| P | `make(chan T)` unbuffered where the producer must never block — a slow consumer stalls the loop (the channel-capacity class, second pass after s625). | ✅ Clean: bare `make(chan)` appears only on `done`/`doneCh` close-signalling channels where unbuffered is canonical; every data channel is explicitly buffered (8–32, `Threads*4`, `len(sources)`). |
| P | `for { select { ... default: } }` busy-loop — a `default` arm that re-enters `select` spins a core at 100% with no work (the busy-default class). | ✅ Clean: every `default:` arm is a one-shot non-blocking send/read or the worker's canonical "check-ctx-then-hash-one-iteration" — the mining loop's spin is the productive workload itself, gated by `ctx.Done()`. |



## Session 673 update — bytes-string-conversion + nil-receiver + error-style audit

| P | `string([]byte)`/`[]byte(string)` conversions inside loops or hot paths — each copy allocates, thrashing the allocator under frame-rate traffic (the conversion-copy class). | ✅ Clean: the single conversion sits at a parse boundary returning the decoded string once per frame, not per byte; the hot hash path works entirely on `[]byte`. |
| S | Calling a pointer-receiver method through a possibly-nil `*T` — a nil self inside the method derefs implicitly (the nil-receiver class). | ✅ Clean: all 145 pointer-receiver methods are only invoked after successful construction; `return nil` sites produce typed-error interfaces, never a nil `*Session`/`*Engine` passed onward (typed-nil itself verified in s640). |
| M | `fmt.Errorf` with a constant format string where `errors.New` is idiomatic — harmless but inconsistent error-construction style (the error-style class). | ✅ Benign: ~8 sites use `fmt.Errorf("engine: ...")` with no verbs — the codebase consistently prefers `fmt.Errorf` everywhere, which is a defensible house style rather than a defect. |



## Session 672 update — map-delete + sync.Once + defer-arg-snapshot audit

| P | `delete(m, k)` on a shared map as state invalidation — racing readers see the stale value between the check and the delete, or a deleted-but-resurrected entry (the invalidate-race class). | ✅ Clean: every delete is inside a lock or on a single-owner map — `pruneStaleStreams` GC under `streamsMu`, `jobs`/`pending` LRU eviction bounded, `submitTimes`/`submitTargets` single-engine-goroutine. Deleting during `range` is a defined operation in Go. |
| M | `sync.Once` used where re-initialization is later needed — a `Do` can't be reset, silently skipping a required re-run (the once-reuse class). | ✅ Clean: all four sites are exactly the lifecycle idempotence `Once` is designed for (`closeOnce`×3, `startOnce`×1) — no re-initialization requirement exists. |
| P | `defer f(arg)` capturing a mutable variable — args are evaluated at defer registration, so the deferred call sees the stale pre-mutation value (the defer-snapshot class). | ✅ Clean: zero `defer func(args)` sites; every deferred literal takes no parameters and closes over variables by reference (the documented intent). |



## Session 671 update — mutex-aliasing + unmarshal-reuse + receiver-consistency audit

| P | `sync.Mutex`/`RWMutex`/`WaitGroup` copied by value — each copy locks an independent state, silently breaking mutual exclusion (the lock-copy class). | ✅ Clean: `go vet -copylocks ./...` reports zero; every `mu`/`wg`/`registryMu` is a struct field reached only through a pointer receiver. |
| S | `json.Unmarshal` into a previously-populated struct — absent fields keep their old values, mixing two payloads (the partial-overwrite class). | ✅ Clean: every site decodes into a fresh local (`var v`, `var p []json.RawMessage`, per-field temporaries) — no struct is reused across decodes. |
| M | Mixed value/pointer receivers on the same type — methods sharing state see different copies, hiding mutation (the receiver-consistency class). | ✅ Clean: every method on `Engine`/`Worker`/`Dashboard`/`Clock`/`Session` takes a pointer receiver (`func (x *T)`); `gofmt -l` and `go vet` show no inconsistencies. |



## Session 670 update — hex-decode + bytes/index + slices-membership audit

| S | `hex.DecodeString` on pool-supplied text without an `err` check — malformed hex silently produces truncated or zero bytes, corrupting job hashes or extranonces (the hex-trust class). | ✅ Clean: every site checks `err` *and* validates length — `coinb1/coinb2/merkle_branch` reject malformed or wrong-length values, `prev_hash`/`en1` fall back or bail on decode failure. |
| P | `bytes.Index`/`LastIndex` on wire data compared against `== 0`/`!= -1` for prefix or membership semantics (the bytes-index class — byte-level sibling of the string Index==0 audit). | ✅ Clean: the only `bytes` predicate on data is `bytes.Equal` — the base-58 checksum compare where exact equality is the correct test. |
| M | `slices.Index`/`IndexFunc` used where `slices.Contains` or `==` is meant — an index treated as a boolean truth (the membership-mismatch class). | ✅ Clean: the single `slices` use is `slices.Contains` in `Accepts` — an exact-match family dispatch; zero `Index`/`IndexFunc` sites. |



## Session 669 update — bigint + compare-and-swap + trylock + readfull audit

| S | `big.Int.SetString`/`SetBytes` on untrusted input without the ok return — malformed digits silently become 0 (the bigint-trust class). | ✅ Absent: zero `SetString`/`SetBytes` sites — every `big.Int` is seeded from a compile-time constant (diff1 bound, base-58 radix, `rand.Int` bound). |
| P | `atomic.CompareAndSwap` in an unbounded retry loop — a contended CAS can livelock at full CPU (the cas-retry class). | ✅ Clean: all four CAS sites are single-shot one-way transitions (`started` flags, logger `defaultPtr` install) — no loops. |
| M | `Mutex.TryLock`/`TryRLock` masking contention — try-then-skip hides real lock pressure as missing work (the contention-hiding class). | ✅ Absent: zero sites — contention is always faced via `Lock`/`RLock`. |
| P | `io.ReadFull`/`ReadAtLeast`/`SkipAll` misuse — partial reads treated as complete frames (the partial-read class). | ✅ Clean: every `ReadFull` site checks `err` (wire frame codec, Noise handshake, stratum primitives); zero `ReadAtLeast`/`SkipAll` sites. |



## Session 667 update — cut-comma-ok + binary.Read + form-input + fields-split audit

| P | `strings.Cut`/`CutPrefix`/`CutSuffix` ignoring the `found` boolean — a separator-absent input is silently treated as separator-present (the cut-comma-ok class). | ✅ Clean: all four sites are `CutPrefix` with `ok` checked (scheme stripping, sysfs `PCI_ID=` parse); no bare `Cut`/`CutSuffix` sites. |
| P | `binary.Read` on a struct — a short read leaves trailing fields zero without error (the partial-decode class). | ✅ Absent: zero call sites — decode goes through explicit offset cursor reads that bounds-check each field. |
| S | `r.ParseForm`/`r.FormValue`/`r.PostFormValue` on untrusted HTTP input — unbounded form/body buffering (the request-input class). | ✅ Absent: the mux registers only fixed read-only handlers (`/healthz`, `/readyz`, `/metrics`, `/`, pprof) — no request-body parsing exists. |
| P | `strings.Fields` on positionally-meaningful data — runs of whitespace collapse, shifting fixed columns (the fields-position class). | ✅ Absent: zero production sites. |



## Session 666 update — binary.Size + error-wrap-loss + single-case-select + errors.Is-nil audit

| P | `binary.Size(x)` on a variable-size type returns -1 silently — a frame-size computed as -1 corrupts writes (the binary-size class). | ✅ Absent: zero call sites — frame lengths come from `len(buf)` on materialized payloads. |
| M | `fmt.Errorf` formatting `err` as `%v`/`%s` instead of wrapping with `%w` — the caller loses `errors.Is/As` access to the cause (the wrap-loss class). | ✅ Benign: the single `%v` site (`config.validatePoolTarget`) formats `net.SplitHostPort`'s error into a user-facing config message — no programmatic `Is/As` consumer exists; the other site wraps with `%w` correctly. |
| P | Single-case `select` that blocks forever — an unguarded `select { case ch <- v: }` deadlocks when the peer never drains (the blind-blocking class). | ✅ Clean: all selects are multi-case or guard via `default:`/`ctx.Done()`; the miner's share send is non-blocking with a `dropCount` counter. |
| M | `errors.Is(err, nil)` / `errors.As(err, nil)` — nil-target misuse that silently devolves to `err == nil` or panics (the nil-target class). | ✅ Absent: zero sites. |



## Session 665 update — timer-reset + closed-channel-read + runtime-tuning + test-cleanup audit

| P | `Timer.Reset`/`Ticker.Reset` on live timers — resetting an expired-but-undrained timer double-fires (the reset-drain-race class). | ✅ Absent: zero timer resets — the only `Reset()` site is the hmac hasher's pool reset (the s614 canonical). |
| P | `case v := <-ch` receiving without comma-ok — a closed channel keeps yielding the zero value forever, spinning the select (the closed-channel-read class). | ✅ Clean: the single site (`tui` `updateCh`) reads a channel that is *never closed by design* — shutdown is signalled on `doneCh`, so a zero `Stats` can never arrive. |
| P | `runtime.Goexit`/`Gosched`/`SetGCPercent`/`FreeOSMemory`/`LockOSThread` — runtime-tuning escapes that distort the scheduler (the runtime-intrusion class). | ✅ Absent: zero sites — `runtime` usage is the GOMAXPROCS query already verified (s605). |
| M | Tests acquiring resources without `t.Cleanup` — leaked files/conns corrupt later tests (the test-hygiene class). | ✅ Clean: `t.Cleanup` is used across engine/poolproto/daemon/doctor tests; temp dirs use `t.TempDir()` which self-registers cleanup. |



## Session 664 update — path-traversal + binary-search + multiwriter + stream-reader audit

| S | `filepath.Join`/`EvalSymlinks` on attacker-influenced components — a `..` element escapes the intended directory (the path-traversal class). | ✅ Clean: every join pairs a base dir with a *constant* filename (`wallet.dat`, fingerprint files) or kernel-provided sysfs names (cannot contain `..`); `EvalSymlinks` is only used to canonicalize device/binary paths, never to gate access. |
| P | `sort.Search`/`slices.BinarySearch` on an unsorted slice — the sorted precondition is unchecked, returning wrong indexes silently (the search-precondition class). | ✅ Absent: zero production call sites — the only `IsSortedFunc` lives in the arbitration fuzz test asserting the property. |
| M | `io.MultiWriter` first-error short-circuit — an early writer's failure starves later writers (the fan-out-write class). | ✅ Benign: the only site tees log output to console+file (`run.go`); a dead stdout means the session is ending anyway, and logging is already best-effort. |
| P | `io.TeeReader`/`SectionReader`/`OffsetReader` boundary misuse — mis-sized windows or unbuffered tee loss (the stream-window class). | ✅ Absent: zero call sites. |



## Session 663 update — unsigned-countdown + builder-copy + json-string-tag + index-prefix audit

| P | Countdown loops `for i := n; i >= 0; i--` — with an *unsigned* counter `i--` wraps at 0 and the loop never exits (the countdown-underflow class; signed counters are safe). | ✅ Clean: all three sites (`sha256d.go`, `seed.go` ×2) use signed `int` counters — `i--` reaches −1 and exits normally. No unsigned countdowns exist. |
| P | `strings.Builder`/`bytes.Buffer` copied by value — copying after first write panics at runtime (the builder-copy class). | ✅ Clean: all sites are function-local `var` builders, or `*strings.Builder` parameters (TUI `writeSection`/`writeLine`) — nothing is copied after use. |
| M | `json:",string"` tags — quotes numbers as strings; easy to miss on wire structs (the tag-semantics class). | ✅ Absent: zero `,string` tags — all wire fields marshal their native type. |
| P | `strings.Index(s, x) == 0` used as a prefix test — scans the whole string and allocates where `HasPrefix` is O(len(x)) (the wrong-predicate class, sibling of the Contains sweep). | ✅ Absent: zero `Index(...) == 0` comparisons — prefix checks use `HasPrefix`/`HasSuffix`/`CutPrefix` throughout. |



## Session 662 update — fsync + chmod-TOCTOU + netip + modern-API audit

| S,P | Missing `fsync` on critical writes — write+rename without Sync can lose the file on crash despite atomic rename (the durability class). | ✅ Clean: the only fund-critical write (`lightning/wallet.go` save) is the full canonical sequence — CreateTemp same-dir → Write → `Sync` → Close (error handled) → Chmod → Rename. Remaining writes (log append, service defs, fingerprint aux) carry no durability requirement. |
| S | `os.Chmod` on a path — TOCTOU between stat and chmod lets an attacker swap the file (the path-chmod class; the fd variant `f.Chmod` is race-free). | ✅ Clean: the only call is `os.Chmod(tmpPath, 0o600)` on the wallet's own tmp file *before* rename — the intentional atomic-permission idiom (narrows to 0600 only; a same-dir swap requires the attacker to already own the directory). |
| M | `net.IP`/`net.ParseIP` where `netip.Addr` is safer — the legacy 16-byte type accepts zoneless junk and compares awkwardly (the addr-type class). | ✅ Benign: one site (`cmd/run.go` loopback check) — `net.ParseIP(host).IsLoopback()` is correct; `netip` would be a cosmetic swap with no behavioral gain. |
| M | Unadopted modern stdlib APIs (`iter`, `unique`, `sync.OnceFunc/OnceValue`) — the modernization-gap class. | ✅ Absent/benign: no sites need them — explicit `sync.Once`/`map` usage is already minimal and correct; adopting these would be churn, not improvement. |



## Session 661 update — env-mutation + template + display-width + RLock audit

| S | `os.Setenv`/`Unsetenv`/`Clearenv` inside library code — mutates process-global env visible to all goroutines (the global-state-mutation class, env variant). | ✅ Absent: zero call sites outside tests. |
| S | `text/template`/`html/template` parsing attacker-controlled strings — template injection (actions, `{{.}}` on hostile data). | ✅ Clean: the only site (`i18n/message.go`) parses the compiled-in message catalog, never user input; guarded by a `{{` fast-path and both parse/execute errors propagate. |
| P | `len()`/`s[:n]` on display strings — byte-vs-rune confusion cuts mid-rune or miscomputes column width for multibyte text (the display-width class). | ✅ Clean: `truncateToBudget`/`shortenURL` apply only to ASCII-constructed fields (share counters, validated host:port pool URLs); ANSI/multibyte-aware helpers (`visibleLen`, `padToVisibleWidth`) handle real display width. |
| P | Writes under `RLock` — a mutation under read lock races (the lock-granularity class). | ✅ Clean: all `RLock` sites are read-only field/map reads, and `metrics.WriteText` uses the canonical snapshot pattern — copies collectors under `RLock`, `RUnlock`s, then invokes them outside the lock. |



## Session 659 update — slog-bypass + shallow-clone + chdir + exposure audit

| M | `slog.*` called directly outside `internal/logger` — bypasses the atomic-swappable wrapper, losing level/format control (the logger-bypass class, slog variant). | ✅ Absent: zero `slog.` sites outside `internal/logger` and tests — every log call flows through the wrapper. |
| P | `maps.Clone`/`slices.Clone`/`maps.Copy` mistaken for a deep copy — nested maps/slices/pointers stay shared after the clone (the shallow-clone class). | ✅ Clean: the only site is `metrics.cloneLabels` over `map[string]string` — immutable string values make the shallow clone a true independent copy (its doc says exactly that). |
| S | `os.Chdir` inside library code — mutates process-global cwd for every goroutine (the global-state-mutation class). | ✅ Absent: zero `os.Chdir` call sites. |
| S | `expvar`/extra listeners exposing runtime state on unconfigured ports (the exposure-surface class). | ✅ Absent: zero `expvar`, `ListenUDP`, `ListenTCP` sites — the only listener is `httpserver` on the configured address. |



## Session 658 update — writer-bypass + unbounded-ReadAll + bufio.Reader + multi-%w audit

| M | `fmt.Fprint*`/`os.Stdout`/`os.Stderr` writes bypassing the logger (the output-bypass class; sibling of the `fmt.Print*` sweep in s655). | ✅ Clean: every `Fprint*` writes to an *injected* `io.Writer` (the TUI dashboard writer, the doctor report writer) — the correct DI pattern, not a hardcoded bypass. The sole `os.Stderr` reference is `logger.go`'s own default destination. |
| P,S | `io.ReadAll` on a response body without a bound — unbounded memory on a hostile/large body (the unbounded-read class). | ✅ Clean: both sites wrap the body in `io.LimitReader` (`rates/hashrate.go` maxHashrateBody, `rates/fetcher.go` 64KiB). |
| P | `bufio.Reader` buffered-data discard or shared reuse — leftover buffered bytes desync the stream (the buffered-reader class). | ✅ Clean: three sites, all single-owner — V1 reader (`NewReaderSize` → bounded `readLine`), one-shot stdin readers (`wallet.go`, `engine/setup.go`). No cross-call reuse. |
| M | Multiple `%w` in one `fmt.Errorf` — Go ≥1.20 multi-wrap; safe only when callers expect `Unwrap() []error` (the multi-wrap class). | ✅ Clean: one site (`stratumv1/dialer.go:164`) deliberately wraps sentinel + inner error so `errors.Is(err, ErrHandshakeFailed)` works — the canonical multi-wrap use. |



## Session 657 update — goto + request-context + scanner-limit + time-parse audit

| M | `goto` misuse — spaghetti flow that defeats structured control (the goto class). | ✅ Clean: two sites, both the canonical forward jump that exits a `select` nested in a `for` (the only place Go needs it — a plain `break` would exit the select, not the loop): `stratumv1.go:385` (drain-then-send) and a test poll loop. No back-edges, no crossed blocks. |
| P | `http.NewRequest` without context — the request ignores caller cancellation (the ctx-propagation class at HTTP boundaries). | ✅ Absent: zero bare `http.NewRequest` calls — every outbound request is `NewRequestWithContext`. |
| P,S | `bufio.Scanner` on untrusted input with the default 64KB token limit — a long line aborts with `ErrTooLong` or is silently truncated (the scanner-limit class). | ✅ Absent: zero `bufio.Scanner` sites — V1 line reading is the custom bounded `readLine` (s601-era verified). |
| M | `time.Parse*` result unchecked — a malformed timestamp silently becomes the zero time (the parse-swallow class). | ✅ Absent: zero `time.Parse*` call sites. |



## Session 656 update — io.Copy + map-any-key + stdlib-log + marshal-error audit

| P | `io.Copy`/`io.CopyN` return value unhandled — a truncated copy continues as if complete (the partial-transfer class; distinct from the builtin `copy()` sweep in s607). | ✅ Clean: the only two sites are `_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, N))` — bounded body drains where a failed drain is best-effort by design (connection-reuse drain, `doctor/checks.go`, `rates/hashrate.go`). |
| P | `map[any]`/`map[interface{}]` keys — an uncomparable dynamic value (slice/map/func) panics at insert (the uncomparable-key class). | ✅ Absent: zero interface-keyed maps. |
| M | `log.*` stdlib logger inside `internal/` — bypasses the slog wrapper (atomic level/format control), the logger-bypass class. | ✅ Absent: zero `log` imports or `log.Print*` calls in `internal/` — all logging goes through `logger`/slog. |
| S | `json.Marshal`/`Encode` error ignored at write boundaries — a failed marshal writes `null`/garbage silently (the silent-marshal class). | ✅ Clean: the single production `json.Marshal` (`stratumv1.go:508`) checks `err` before appending the newline; all three `json.NewEncoder` sites return/check the encode error. |



## Session 655 update — context-TODO + Contains-dispatch + sort-stability + library-print audit

| M | `context.TODO()` leftovers — an unpropagated context the caller can never cancel (the ctx-origin class's TODO variant). | ✅ Absent: zero `context.TODO` sites — every context is either propagated or the deliberate `Background()` stop-grace origin (s650). |
| P,S | `strings.Contains` used for protocol dispatch — substring matching accepts junk-with-substring where equality was meant (the over-broad match class). | ✅ Clean: the only dispatch use is `engine/stats.go` reject-reason classification, where `Contains` correctly runs after canonical SV2 codes against free-form pool text (the #387 design). All other `Contains*` sites are charset checks (`ContainsAny`/`ContainsFunc`/`ContainsRune`) or output probes (`sc query` text) — nothing masquerades as equality. |
| P | `sort.Slice`/`slices.Sort` where ties need stable order — unstable sort reorders equal elements nondeterministically (the stability-loss class). | ✅ Clean: `slices.SortStableFunc` is used at the one stability-sensitive site (`arbitration` candidate order); all `Sort`/`SortFunc` comparators are total-order over value elements where equal items are identical. |
| L | `fmt.Print*` in `internal/` library code — bypasses the slog pipeline, loses level/format control (the print-bypass class). | ✅ Absent: zero `fmt.Print/Println/Printf` sites outside tests — all output flows through `logger`/`i18n`. |



## Session 653 update — WaitGroup ordering + builtin-shadow + marker audit

| P | `wg.Add` called inside (or after) the spawned goroutine — Add-after-spawn lets `Wait` return before the worker registers, the lost-count race class. | ✅ Clean: every `wg.Add` is the canonical loop pattern — `wg.Add(1)` in the loop body immediately before `go func` (`rates/hashrate.go`, `miner/worker.go`, and all test sites); zero `Add` inside a spawned goroutine. |
| M | Builtin identifier shadowing (`len`, `cap`, `new`, `copy`, `close`, `error`, `min`, `max`, `clear`, `any`, `string`, `int`, `byte`, `bool`, `nil`, `iota`) — a shadowed name silently changes meaning on later use, the shadow-builtin class. | ✅ Benign: one scoped test hit — `for _, max := range []int{…}` in `tui/formatters_test.go:85`; `max` the builtin is never referenced in that scope. Zero production sites. |
| M | FIXME/HACK/XXX/WORKAROUND/BUG comment markers — leftover defect tickets hiding in prose, the marker-rot class. | ✅ Absent: zero marker comments in `internal/` and `cmd/`. |



## Session 652 update — timezone-mixing + test-helper audit

| L | UTC/Local mixing: converting some timestamps to `UTC()`/`Local()` while others stay wall-local makes log/metric comparisons drift by the host zone — the timezone-inconsistency class. | ✅ Absent: zero `.UTC()`/`.Local()`/`time.Local`/`.In(...)` sites — every timestamp is `time.Now()`/derived local-clock uniformly, so no mixed-zone comparison can arise. |
| M | Test helpers taking `*testing.T` without `t.Helper()` — failure lines point at the helper's internals instead of the calling test (the attribution-loss class). | ✅ Clean: all 40 `func helper(t *testing.T…)` sites call `t.Helper()` first — failure attribution already correct tree-wide. |



## Session 651 update — reflect + buffer-reuse audit

| M | `reflect` package on hot paths — `DeepEqual`/`ValueOf` in per-share or per-frame code (reflection-cost + type-inspection fragility class). | ✅ Absent: zero `reflect` sites anywhere — all comparison/dispatch is typed. |
| M | Reused `strings.Builder`/`bytes.Buffer`/scratch slices carrying stale content into the next render or frame (the buffer-reset class). | ✅ Clean: every `strings.Builder` is a per-call `var` (Builder semantics require a fresh value — a stored-and-reused Builder would need `Reset`, and none exist); the sync.Pool hasher resets on checkout; `frame.go`'s `scratch[HeaderSize]` is fully overwritten by `ReadFull` each frame while payloads allocate per call. |



## Session 650 update — ctx-origin + build-tag audit

| M | `context.Background()` inside `internal/` — a fresh root ctx severs the caller's cancellation chain (the ctx-origin class). | ✅ Clean: the only site is `httpserver.Server.Stop`, which *must* use a fresh root — a graceful-shutdown grace period would be immediately cancelled if it inherited the (already-cancelled) parent ctx. Correct by necessity. |
| M | Old-style `// +build` constraints — deprecated pre-Go-1.17 syntax that newer toolchains ignore (the build-tag class). | ✅ Clean: zero `// +build` sites; all 6 build-tagged files (`tui/width_*`, `hal/gpu_*`) use `//go:build`. |



## Session 649 update — URL-parsing + path-package audit

| S | `net/url.Parse` on pool URLs — it silently accepts `userinfo@`, fragments and paths a `scheme://host:port` contract must reject (the permissive-URL-parser class). | ✅ Absent: zero `url.Parse` sites — pool targets parse via `CutPrefix` + `net.SplitHostPort` with explicit `@/?#`/whitespace rejection and port-range bounds (`validatePoolTarget`); `poolIPResolver` strips the port before DNS. The custom parser is the security-correct choice — `url.Parse` would silently accept userinfo. |
| M | `path` vs `path/filepath` mixing — `path.Join` on filesystem paths breaks on Windows separators (the path-package class). | ✅ Clean: zero `path` imports — every filesystem join is `filepath.Join` (~15 sites across daemon/config/doctor/hal). |



## Session 648 update — duration-unit + discarded-return audit

| M | `time.Duration(x)` unit confusion — nanoseconds vs seconds/milliseconds misinterpreted produces 10^9× off-by-scale timeouts (the duration-unit class). | ✅ Clean: all 3 conversions are typed correctly (`UnixNano` delta, `p50*float64(time.Millisecond)`, `Wait seconds * time.Second`); every literal is `N * time.Unit`. |
| M | `_ =` discarded returns silently dropping errors a caller could act on (the discarded-error class). | ✅ Clean: every site is an intentional decision — best-effort teardown (`systemctl disable`, `sc.exe stop`, service unload), fire-and-forget deadline sets and Body.Close drains, client-tolerant health-endpoint writes, and the `BTCUSDRate` soft-degrade. No actionable error is discarded. |



## Session 647 update — mergeability + ledger re-verification

| M | Open-PR merge conflicts — 46 open PRs from the audit loop could drift into conflict as they land. | ✅ Verified mergeable: all 46 open PRs report MERGEABLE against current master. Note: most append to this ledger's tail, so they will pairwise-conflict once the first merges — that is the known append pattern, resolved by the union-resolution sweep, not a defect. |
| M | Ledger deferred rows drifted from code reality (s639 follow-up). | ✅ Accurate: 3 remaining `⏸ Deferred` rows are all still true — line ~581 (TUI width; resolved by open PR #721, lands on merge), ~176 (`clock.Clock` test-only gap, still real), line ~10 (CODEOWNERS-gated funds-critical item, tracked). No new stale rows found. |



## Session 646 update — deadlock-primitive + serialization audit

| M | Deadlock-prone concurrency primitives — bare `select{}` (permanent block), `sync.Cond` (lost-wakeup risk), `context.AfterFunc` (callback-after-cancel races). | ✅ Absent: zero `select{}`, zero `sync.Cond`, zero `AfterFunc` — all blocking is `select`+`ctx.Done()` or `wg.Wait()` joins (the `fanin.go` closer idiom is canonical). |
| M | Hand-rolled serialization on a wire/storage boundary — `binary.Write`/`gob`/custom `MarshalText` implementations diverging from the canonical codec. | ✅ Absent: zero `binary.Write`/`gob`/MarshalText sites — V1 is `encoding/json`, V2 is the single custom frame codec in `internal/stratum`. |


---

## Session 1154 update — bool-map census

`map[K]bool` as a set vs the `map[K]struct{}` idiom — absent-vs-false
ambiguity surface.

| Cat | Finding | Disposition |
|-----|---------|-------------|
| S | 7 `map[K]bool` sites (setFlags, 3× seen dedup, 2× valid-count/break sets); every write is `= true` only — no `= false` is ever stored, so all `m[k]` truth tests are safe; the 2 `struct{}` sites coexist | ⚠️ Noted |

All packages build, vet, and test green.

---

## Session 726 update — compiler-directive + pipe-fd + slog-attr audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| L | `//go:build` partitions leaving a GOOS uncovered (missing symbol on some platform) or a file that compiles nowhere; stray `//go:embed`/`//go:generate`/`//go:linkname` directives. | ✅ Clean: the only directives are the two complete partitions — hal GPU `linux`/`!linux` and TUI width `unix`/`windows`/`!unix && !windows` (full GOOS coverage, every file compiles somewhere); zero embed/generate/linkname directives. |
| M | `os.Pipe`/`net.Pipe` in prod — an fd/in-memory pair whose ends must both be closed and drained (a blocked write wedges a goroutine). | ✅ Absent in prod: all ~50 `net.Pipe` sites are `_test.go` fake transports (the canonical use, with drain goroutines where needed — `dialer_test.go:1126`); the single `os.Pipe` is the test stderr capture. |
| L | slog attribute keys with unbounded cardinality — dynamic keys (host, ID, user input) exploding the log schema. | ✅ Clean by construction: zero typed-attr call sites — every log line routes through the Logger wrapper's plain-message methods (`Info(msg)`), so no key/value attrs exist to vary. |

All packages build, vet, and test green.

---

## Session 719 update — error-receiver + unwrap-cycle + racy-len audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| M | `Error()` on the wrong receiver kind — a pointer-receiver `Error()` on a type passed by value (interface never satisfied), or value-receiver on a type whose address errors can't compare. | ✅ Clean: one prod `Error()` — `(*fatalError).Error()` on the unexported sentinel — is constructed and propagated as `*fatalError` throughout; test-only sites match their own usage. No value/pointer mismatch. |
| M | Custom `Unwrap() error` returning itself or forming a cycle — infinite `errors.Is/As` loops. | ✅ Absent: zero custom `Unwrap` implementations — all wrapping goes through `%w` in `fmt.Errorf`, which cannot cycle. |
| P | `len(ch)`/`cap(ch)` channel probes or `len(map)` reads used as flow control across goroutines — racy snapshots racing producers/deleters. | ✅ Absent: zero `len(ch)`/`cap(ch)` sites; the `len()` checks that do exist are owner-local invariants (job-FIFO caps under the owning goroutine/lock — same scopes s553/s672 verified) or wire/buffer bounds on local slices. |

All packages build, vet, and test green.

---

## Session 720 update — float-trunc + rune-width + round-direction audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| P | `int(float)` truncation toward zero on yield/duration/rate math — silently flooring fractional values (or inverting sign expectation on negatives). | ✅ Clean: the only float→int casts are the documented sats *display* estimate (`uint64(satsAcc.observe(...))`, whole-sat presentation) and `int(d.Seconds())%60` TUI formatting; all other `int()`/`uint32()` casts are on integer/bounded fields (MsgLength, Threads, ioctl Col). |
| S | `[]rune`/`[]byte` width confusion — iterating bytes where runes were meant (mangling multibyte pool text or validation positions). | ✅ Clean: rune conversion happens exactly where needed — the two pool-text sanitizers (`poolproto.go`, `stratumv1/parse.go`) and the `[]rune` Levenshtein in `did-you-mean` — and all `[]byte` conversions are on ASCII-canonical data (hashes, protocol names, KDF inputs). |
| P | `Truncate`/`Round`/`Floor` direction errors on staleness or rate math (rounding a bound the wrong way). | ✅ Clean: all four sites are presentation-side — `quiet.Truncate(time.Second)` and `.Round(time.Millisecond)` format durations/latency for display; no truncation feeds a staleness or pricing comparison. |

All packages build, vet, and test green.

---

## Session 721 update — marshal-impl + pem-decode + bench-loop audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| M | Custom `MarshalJSON`/`UnmarshalJSON`/`MarshalText`/`UnmarshalText`/`MarshalBinary` implementations — hand-rolled codecs that can panic on hostile input or round-trip lossily. | ✅ Absent: zero custom marshal/unmarshal methods — all wire/serialization goes through `json`/`yaml` tags on stock codecs; no hand-rolled codec exists to misbehave. |
| S | `pem.Decode`/`AppendCertsFromPEM` misuse on CA-file loading — unchecked return accepting a garbage/empty cert pool, or block-type confusion accepting non-CERTIFICATE blocks. | ✅ Clean: all 3 sites (`stratum/tls.go`, `stratumv1/tls.go`, `doctor/checks.go`) use `AppendCertsFromPEM` (not raw `pem.Decode`) and branch on its bool — failure surfaces as an explicit "no valid CA certificates" error. The API itself handles block filtering and multi-block PEMs; partial garbage is tolerated only when ≥1 valid CERTIFICATE parses. |
| M | Benchmark-loop misuse — missing `b.N` iteration, setup inside the timed region, or unreported allocations skewing results. | ✅ Clean: all 11 benchmarks use the canonical `for i := 0; i < b.N; i++` loop, hoist setup before `b.ResetTimer()` where needed, and call `b.ReportAllocs()` — no timing-region pollution. |

All packages build, vet, and test green.

---

## Session 722 update — time-add + error-discard + blank-import audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| P | `time.Add`/`AddDate` on unbounded or user-controlled durations — a far-future/wrapped deadline silently disabling a guard (or negative duration pre-expiring it). | ✅ Clean: every `time.Add` uses a compile-time or config-validated constant (`handshakeTimeout`, `10s`, `5m`, `-staleTempMaxAge`) — no unbounded duration reaches a deadline computation. |
| S | `_ =` swallowing *error* values — a failed operation whose error was the only signal. | ✅ Clean: all discards are documented unactionables — HTTP health-endpoint writes (client disconnect can't be fixed), `fmt.Sscanf` where a malformed value fails validation downstream, bounded `io.Copy` drains before Close, and one explicitly commented `// intentionally ignored: non-fatal`. |
| M | Blank imports (`import _ "..."`) with undocumented side effects — hidden init() work the reader can't see. | ✅ Clean: 2 sites, both `_ "internal/poolproto/stratumv1"` — the documented self-registration import (V1's init() registers its dialer into the poolproto registry); no hidden side effect beyond the deliberate one. |

All packages build, vet, and test green.

---

## Session 723 update — builtin-adoption + chan-convention + slices-delete audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| M | `clear`/`min`/`max` builtin misuse or non-adoption — `clear` on a map other code still views (wiping shared state), or hand-rolled clamps where the builtins belong. | ✅ Clean: the single `clear` (`opts.activity` in the arbitration loop) wipes a private per-round scratch map that is rebuilt each iteration — no shared view exists; the `min`/`max` sites are the canonical clamp idiom (yield floors, extranonce2 bound, Levenshtein DP). |
| M | `chan bool` for pure signals — a bool channel implying a payload it doesn't carry (zero-size `struct{}` is the convention). | ✅ Uniform: zero `chan bool` — all ~40 signal channels (`done`, `started`, `runDone`, limiter tokens, test gates) are `chan struct{}`. |
| P | `slices.Delete*`/`Insert`/`Replace` tail-pointer retention — a removed element's slot still referencing a live object (GC pin). | ✅ Absent: zero prod `slices.Delete`/`DeleteFunc`/`Insert`/`Replace` sites — removal goes through the bounded-FIFO `s[1:]` pattern (no tail retention beyond the cap) or map `delete`. |

All packages build, vet, and test green.

---

## Session 724 update — func-compare + raw-fd + header-order audit

| Cat | Finding | Disposition |
|-----|---------|-------------|
| S | `f == g` comparing two func values — always false (or panics on some reflect paths), hiding a broken equality check. | ✅ Clean: zero func==func comparisons; the only `func` hits are method signatures and predicate arguments (`strings.IndexFunc`). |
| M | `os.NewFile`/`f.Fd()` escapes — wrapping a raw fd whose ownership then competes with the GC'd `*os.File` (double-close). | ✅ Clean: zero `os.NewFile`; the 2 `Fd()` sites are the platform-split TTY-width ioctls (`unix.IoctlGetWinsize`, `windows.GetConsoleScreenBufferInfo`) — the fd is borrowed read-only for the call, no ownership transfer. |
| L | `w.Write` before `w.WriteHeader` in an HTTP handler — body flush implicitly sends 200, making the later status a silent no-op. | ✅ Clean: all 4 httpserver handlers call `WriteHeader(status)` before any body write — correct header-then-body order. |

All packages build, vet, and test green.
