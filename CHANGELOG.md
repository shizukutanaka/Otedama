# Changelog

All notable changes to Otedama are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本プロジェクトは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) 形式に準拠し、[Semantic Versioning](https://semver.org/lang/ja/) に従います。

---

## [Unreleased]

### Fixes (session 61 — /readyz reflects actual pool connection)

- **🔴 G10 (SPECIFICATION.md): `/readyz` reported ready before connecting to any pool.**
  `OnReady(true)` fired at engine start (after subsystem init), so the readiness probe went
  green even when the miner could reach no pool — the opposite of its documented "ready only
  if pool connected" contract. A Kubernetes readiness probe would route a non-mining pod as
  ready.
- **Fix:** readiness is now driven from the session lifecycle inside `runReconnectLoop` —
  `OnReady(true)` fires on handshake completion (reusing the session-56 `onConnected` hook),
  `OnReady(false)` on each disconnect and on shutdown — so `/readyz` tracks a live pool
  connection and flips back when it drops. Updated the `Options.OnReady` contract doc
  accordingly (it now flips per session, not once).
- **2 tests:** the existing fake-pool E2E still sees `OnReady(true)` on connect; a new test
  confirms an unreachable pool never makes `OnReady(true)` fire. Updated SPECIFICATION.md
  gap table (G10). `go build`/`vet`/`test` green.

### Fixes (session 60 — doctor validates the failover address list)

- **G9 (SPECIFICATION.md): `doctor` checked only the primary `bitcoin_address`.** The
  session-56 `bitcoin_addresses` failover list was not diagnosed, so a typo in a backup
  address — which would silently misdirect earnings if failover ever reached it — went
  uncaught by the very tool meant to catch it. Added a **"Failover payout addresses"**
  check to `doctor`: it skips cleanly when none are configured, passes when all entries
  look valid, and fails (with a fix hint) on the first malformed entry.
- **1 test** (empty → skip, valid list → pass, bad entry → fail). Updated SPECIFICATION.md
  gap table (G9). `go build`/`vet`/`test` green.

### Fixes (session 59 — log_format precedence + validation)

- **🔴 G8 (SPECIFICATION.md): `log_format` from a config file or environment was silently
  ignored.** `--log-format` bound to a *standalone* `runFlags.logFormat` field with a
  non-empty `"text"` default, and `buildLogger` read that flag — not the resolved
  `cfg.LogFormat` — so `log_format: json` in `config.yaml` (or `OTEDAMA_LOG_FORMAT`) never
  took effect, even though `config show` displayed it correctly. Also `Config.Validate`
  never checked `log_format`, so a typo fell through to text silently.
- **Fix:** bind `--log-format` to the embedded `FlagValues.LogFormat` (empty default) so
  `config.Resolve` applies the documented flag > env > file > default precedence;
  `buildLogger` now uses `cfg.LogFormat`; and `Validate` rejects any value outside
  {text, json} (mirroring the existing `log_level` check).
- **3 tests:** `Validate` accepts text/json and rejects others; `Resolve` keeps a
  file-provided `log_format` when no flag is passed and lets an explicit flag win; the
  existing `buildLogger` text/JSON tests now exercise `cfg.LogFormat`. Updated
  SPECIFICATION.md gap table (G8). `go build`/`vet`/`test` green.

### Fixes (session 58 — honor documented config: pool User + worker name)

- **G7 (from SPECIFICATION.md): `PoolConfig.User` and `Workers.Name` were documented but
  the engine never read them.** The Stratum V2 `user_identity` sent in OpenMiningChannel
  was always the bare payout address. Added `sessionUser(poolUser, addr, worker)`:
  an explicit per-pool `User` overrides everything; otherwise the active payout address is
  used, suffixed as `address.worker` (the standard Stratum convention for per-rig pool
  stats) when `Workers.Name` is set. Default behaviour (no `User`, no worker name) is
  unchanged.
- **Honest config docs:** `PoolConfig.Password` is documented as reserved for the Stratum
  V1 fallback (not yet wired) and currently unused, since the V2 transport has no password.
- Updated `docs/SPECIFICATION.md` (§3/§4 + gap table G7). **1 test** covering the
  precedence (plain address / worker suffix / explicit override). `go build`/`vet`/`test`
  green. This keeps payout-address failover (session 56) intact: when no per-pool `User`
  is set, the user_identity still tracks the active address.

### Documentation & fixes (session 57 — specification + gap closure)

- **Added `docs/SPECIFICATION.md`** — a descriptive spec of Otedama's *actual* observable
  behaviour (CLI + exit codes, config + precedence + validation, mining-session lifecycle
  incl. pool and payout-address failover, Stratum V2 transport, the full metrics set, and
  known limitations). It ends with a **"Gaps found"** table that audits intended vs actual
  behaviour, each with status.
- **G1 — `config show` was incomplete (fixed).** It printed only `bitcoin_address`,
  `log_level`, `language`, `data_dir`, and a pool *count* — not the *effective*
  configuration the README/spec promise. It now also shows the `bitcoin_addresses`
  failover list (added session 56), `log_format`, `worker_name`, and the actual pool URLs.
  Without this, an operator could not see their configured failover addresses or pools.
- **G2 — exit-code contract documented** (0 ok / 1 runtime / 64 usage / 78 config) in the
  spec for scripting.
- Remaining gaps (G3 engine→poolproto, G4 secp256k1 Noise, G5 live Akash, G6 Linux-only
  GPU) are catalogued in the spec with status, cross-referencing KNOWN_LIMITATIONS and the
  research backlog.
- **1 test** asserting `config show` surfaces the failover addresses, pool URLs,
  `log_format`, and `worker_name`. `go build`/`vet`/`test` green; smoke-tested via the binary.

### Features (session 56 — payout-address failover)

- **Multiple payout addresses with automatic failover.** Added
  `bitcoin_addresses` (an ordered list) alongside `bitcoin_address`: if the active
  address cannot establish a mining session on any configured pool (e.g. a pool rejects
  it), Otedama rotates to the next address. `payoutAddresses(cfg)` builds the ordered,
  de-duplicated list (primary first, empty entries skipped), mirroring the session-42
  `poolURLs` pool-failover design.
- **Designed to never silently redirect earnings (fund safety).** Address failover is
  deliberately conservative: the engine rotates to a backup address **only while the
  active address has never established a session**. A working address is never abandoned
  — transient pool/network problems are handled by the existing fast pool failover and
  backoff — and since no session establishes during an outage, an outage can never move
  payouts to a different address. Implemented via a new `sessionOpts.onConnected`
  callback that marks the active address "known good"; the loop tries pools fast (inner)
  and addresses slow (outer), logging address switches loudly with masked addresses.
- **Validation:** `Config.Validate` now requires at least one payout address (primary or
  a backup) and validates every `bitcoin_addresses` entry, so a typo in a backup is
  caught at config time, not only when failover reaches it.
- **Observability:** added `otedama_payout_active_index` (0-based index of the active
  payout address), so address failover is visible alongside the session-54 pool gauges.
- **9 tests** (`payoutAddresses` ordering/dedup/skip-empty/list-only, `maskAddr`, and
  `Validate` failover-list cases) plus `config.yaml.example` documentation. `go
  build`/`vet`/`test` green; multi-address config validated end-to-end via the binary
  (valid list passes; a bad backup fails with exit 78).

### Features (session 55 — shell completion)

- **Added `otedama completion bash|zsh|fish`** (RESEARCH_IMPROVEMENTS Cat 7 #6) — emits a
  static completion script for the chosen shell, completing the top-level subcommands and
  the `config`/`service`/`completion` sub-subcommands. Self-contained in `cmd/otedama`
  (no dependency; the CLI is hand-rolled, so the scripts are static and kept in sync with
  the dispatch switch). Unknown/missing shell args exit with the usage code and write
  nothing to stdout. Wired into the command dispatch and `printUsage`.
- **3 tests:** per-shell script content, bad-argument rejection (empty / unknown shell /
  extra args, with nothing written on the error path), and end-to-end dispatch through
  `run`. `go build`/`vet`/`test` green; binary smoke-tested.
- **Deliberately deferred:** the engine→poolproto wiring (KNOWN_LIMITATIONS §3 step 3b)
  is *not* a drop-in — `poolproto.Session.Submit` returns synchronously while the engine
  correlates async `SubmitSharesSuccess/Error` by sequence number to drive the
  submit-latency quantiles and reject-reason classification (sessions 44–48). Doing 3b
  without first extending `poolproto.Session` to surface submit results/latency would
  regress that telemetry, so it is left for a dedicated, tested hot-path pass.

### Features (session 54 — fleet-observability bundle)

- **Added four operator-facing metrics** that make version, liveness, and failover
  observable (closing `docs/RESEARCH_IMPROVEMENTS.md` session-51 #20–21 / Cat 9 #6–7–9),
  with no new dependency (the hand-rolled exposition writer, ADR-005, already supports it):
  - **`otedama_build_info{version,commit,goversion}`** — a constant-`1` series following
    the standard Prometheus `_info` convention, so a fleet can track which build each
    node runs. Labels come from `internal/version.Get()`.
  - **`otedama_up`** — `1` when the miner is producing hashrate, `0` once
    `HashrateMonitor.Stalled()` trips, so a scrape can alert on a silently wedged miner.
  - **`otedama_pool_connection_state`** (`0`=disconnected, `1`=connecting, `2`=connected)
    and **`otedama_pool_active_index`** (0-based index in the failover list) — the
    multi-pool failover added in session 42 is now observable: a dashboard can show which
    pool is live and catch flapping. Set across `runReconnectLoop` (connecting/disconnected
    + active index) and `runSession` (connected on handshake completion).
- **1 test** asserting all four appear in `/metrics` and that `build_info` is a labelled
  constant-1 series. `go build`/`vet`/`test` all green.

### Bug fixes (session 53 — Noise transport framing hardening)

- **Fixed two real bugs in `stratum.EncryptedConn` (the SV2 Noise transport), acting
  on the session-52 research lesson that fuzzing found a length-arithmetic overflow in
  SRI's `noise_sv2` crate.**
  - **`Write` silently truncated oversize frames:** `uint16(len(ct))` wrapped when the
    ciphertext exceeded 65535 bytes, emitting a wrong length prefix while writing the full
    bytes — desynchronising the stream. It now rejects such a frame with an error (Noise
    transport messages are u16-bounded by spec), so truncation can't corrupt the channel.
  - **`Read` discarded plaintext:** `copy(p, pt)` dropped any decrypted plaintext beyond
    the caller's buffer length. Because the Stratum decoder reads a 6-byte header first,
    *every* real frame exceeded that first buffer and lost data. `Read` now buffers the
    remainder and drains it across subsequent calls, so no plaintext is lost.
  - Removed a dead `ctLen > 65535` guard (a `uint16` cannot exceed 65535) and documented
    why the wire-driven `make([]byte, ctLen)` can't be coerced into a huge allocation.
- **2 tests:** full-plaintext reassembly across small (header-sized) Read buffers, and the
  oversize-write rejection (with nothing written on the error path) plus the exact-limit
  success case. `go build`/`vet`/`test` all green.

### Research (session 52 — fresh GitHub/spec increment)

- **Four verified updates to the backlog** (`docs/RESEARCH_IMPROVEMENTS.md`), no code change:
  (1) SRI reached v1.6.0 and split into `sv2-apps`; a 2026 fuzzing effort found an
  arithmetic overflow in the `noise_sv2` crate — Otedama should add overflow-focused
  fuzzing to its analogous Noise/frame length math; (2) ~75% of network hashrate
  committed to Stratum V2 in May 2026 (updates ADR-009's figure, sharpens the JDC
  priority); (3) the real Akash provider API now requires JWT auth (AEP-64, Mainnet 14,
  Oct 2025) — a concrete requirement for the non-simulated `AkashProvider`; (4) Go 1.24+
  ships a FIPS 140-3-validated crypto module (`GODEBUG=fips140=on`) that includes the
  X25519MLKEM768 hybrid PQ key exchange Otedama already enables via `tlsmlkem=1` —
  worth an optional FIPS profile and a THREAT_MODEL note. All sources verified.

### Research (session 51 — comparable-software + arXiv improvement survey)

- **Expanded `docs/RESEARCH_IMPROVEMENTS.md` with a 27-item "June 2026 research
  pass"** drawn from comparable software and 2024–2026 arXiv papers, cross-checked
  so none duplicate the existing 11 categories. No code change this pass — the goal
  was to enumerate concrete, sourced improvement points for later sessions.
- **Mining/Stratum correctness (from SRI v1.5.0 + ESP-Miner):** SV2 server-certificate
  validation (BIP340 sig + expiry, separate from the Noise DH); clamp channel target to
  `max_target` on vardiff; strip BIP141 fields from the coinbase on Extended Jobs; don't
  count post-`set_difficulty` "above-target" rejects (+fractional difficulty); handle
  `client.show_message`; saturate/reset hashrate counters on reconnect; pin protocol truth
  to `sv2-spec`. Each is a concrete, testable client work item.
- **Decentralisation (arXiv):** single-pool concentration enables *undetectable* selfish
  mining (2309.06847) — a security rationale for the diversity defaults; orphan-aware
  reconciliation fairness (2211.07270); auditable PoW for verifiable shares (2601.02496, v4.0+).
- **Replacing the simulated Akash provider:** concrete Akash REST/gRPC + SDK lease-lifecycle
  surface (the unblocker for KNOWN_LIMITATIONS §1); Vast.ai direct-bid market as a simpler
  real backend and a live testbed for A4 bidding; preemption-risk pricing (GFS, 2509.11134).
- **Arbitration (arXiv):** randomized deadline-aware spot scheduling with √K competitive ratio
  (ROSS, 2601.14612); adaptive learned switching cost with sub-linear dynamic regret (SCaLE,
  2601.09042); non-stationarity measures to self-tune the forecaster (2506.02980).
- **Power:** real, currently-live feeds — Octopus Agile (no-key REST), Tibber/Amber — with a
  "forward price curve" interface; *marginal* (WattTime MOER) vs average carbon for curtailment.
- **Observability/supply-chain:** trace exemplars on the submit-latency histogram; Prometheus
  `_info`/bounded-label/`go_*` conventions; SLSA L3 provenance + Sigstore keyless signing;
  OpenSSF Scorecard gate; govulncheck as a hard CI gate (CVE-2025-22871, GO-2025-3563).
- **Lightning (arXiv):** edge-betweenness depletion-aware path selection (2511.16376); a
  dependency-free channel-balance prior seeding the min-cost-flow scorer (2405.12087); HTLC
  timing side channel (2006.12143) — Tor-by-default mitigates both it and the Stratum leak.
- All 10 new arXiv IDs were verified against the arXiv listing and all API endpoints against
  current vendor documentation before inclusion (no fabricated citations, per CLAUDE.md).

### Bug fixes (session 50 — restore a correct, green build)

- **🔴 The v3.0.0-alpha.1 tree did not build, and once it built ~10 packages failed their own tests — despite the prior "720 green tests" claim.** This session restores the project to a correct, green state on its declared toolchain (`go 1.24`), fixing the wrong side (code or test) of every failure after reading each end-to-end (CLAUDE.md). Result: `go build ./...`, `go vet ./...`, and `go test ./...` are all green; **716 test functions (877 incl. subtests)**, plus `gofmt` clean across the tree.
- **Build blockers:**
  - **`go.mod` `godebug tlskyber=1` → `tlsmlkem=1`.** Go 1.24 renamed the hybrid-PQ-TLS knob when X25519Kyber768 was standardised as X25519MLKEM768; the old name is a hard `unknown godebug "tlskyber"` error on the pinned `toolchain go1.24.0`, so nothing compiled. Updated `GODEBUG_NOTES.md` to match.
  - **Regenerated the incomplete `go.sum`** (`go mod tidy`); it was missing entries and recorded the existing `golang.org/x/sys` indirect dependency.
  - **3 production compile errors:** `newByteReader` returned `io.Reader`, hiding the `ReadByte` its caller needs (now returns the concrete `*byteSliceReader`); an unused `bytes` import in `stratum/messages.go`; missing `encoding/hex` + `time` imports in `poolproto/stratumv1/parse.go`.
  - **4 test-binary compile errors:** added the symmetric `SubmitSharesSuccess.Encode` (every other message had one); removed a duplicate `FuzzDecodeHeader` (defined in two files); fixed `logger` `Config.Output`→`Writer`, `lightning` `Seed`→`seed[:]`, and `stratum` `*bytes.Reader`→`*bytes.Buffer` (needs `io.ReadWriter`) drift in tests.
- **🔴 Real correctness bug — mining target byte order.** `TargetFromNBits`/`NBitsFromTarget` produced **big-endian** targets while `SHA256d`/`HashHeader` output and `Hash.LessOrEqual` are **little-endian** (proven by the passing genesis-block vector, whose PoW zeros sit at the high byte index). Because `engine.runSession` sets `Work.Target` from `TargetFromNBits` and the worker compares `HashHeader(h).LessOrEqual(Target)`, live mining was comparing a hash against a **byte-reversed** target. Switched the target to little-endian to match the hash, so proof-of-work is evaluated correctly.
- **Real correctness bug — `engine.fanIn` could not be cancelled.** Each merge goroutine blocked on `for v := range c` and only checked `ctx.Done()` while *sending*; a stuck input (never written, never closed) pinned the goroutine open after cancellation, so the output channel never closed (goroutine leak). The receive now also observes `ctx`.
- **Real bug — `logger.IntoContext(ctx, nil)`** stored a typed-nil `*Logger` that satisfied `FromContext`'s type assertion and shadowed the default logger with nil. `IntoContext` is now a no-op on nil and `FromContext` falls back to the default defensively.
- **Real bug — `stratum.ReadMessage2` panic.** It sliced `payload[:65]`/`[:33]` after only checking `len ≥ 32`, panicking on a 32-byte (x-only) message before reaching the intended fallback. The slices are now length-guarded.
- **`cmd/otedama` fixes:** an empty/comments-only config file returns `io.EOF` from the YAML decoder — that is "use defaults", not a parse error, so it no longer prints a spurious warning; `safeDisplay` now strips control characters (ESC/DEL/newlines) so a malicious config value cannot inject ANSI escapes or forge log lines when echoed to a terminal.
- **`btccrypto` builtins.** The package documented `ecdsa-secp256k1`/`schnorr-secp256k1` as registered, and `SchemeForAddressType` looked them up, but no file registered them. Added them as **namespace-reserving stubs** (crypto ops return `ErrSchemeNotImplemented`) pending the secp256k1 dependency (ADR-011) — the same honest-stub stance the ML-DSA/SPHINCS+ scaffolding takes — and corrected the package doc that overstated current support.
- **Incorrect tests corrected (code was right):** the `TargetFromNBits` known-target test skipped leading zeros then asserted a prefix that *started* with zeros (self-contradictory); `MeetsTarget`'s "very easy" case fed an all-`0x01` hash (larger than the genesis target) against genesis difficulty; `DefaultWorkerConfig` asserted `NonceStep != 0` although `0` is the documented "resolve to thread count at start" sentinel; the `clock` concurrency test selected on a *closed* channel (always ready) so it failed unconditionally; a `doctor` boundary case was 26 chars but commented "25"; the `stratumv1` lifecycle test deadlocked a synchronous `net.Pipe` waiting for a handshake the (documented-stub) `Negotiate` never sends; the noise allocation micro-test asserted on a measurement its own comment called "not strict".
- No new runtime dependency was added (ADR-003/ADR-011 secp256k1 work remains a later session). This is the prerequisite that unblocks the ranked feature backlog in `docs/RESEARCH_IMPROVEMENTS.md`.

### Documentation (session 49 — ADR-011: secp256k1 dependency decision)

- **Added ADR-011 deciding to adopt `github.com/decred/dcrd/dcrec/secp256k1/v4`** as a fourth runtime dependency, scoped to the Stratum V2 Noise handshake. This is the prerequisite decision for closing KNOWN_LIMITATIONS §2 (the P-256 stub that prevents the encrypted V2 channel from interoperating with real pools). Per CLAUDE.md I6, three options were compared: (A) adopt the canonical pure-Go secp256k1, (B) implement the curve ourselves, (C) keep the P-256 stub. Chose A. The key reasoning: implementing secp256k1 + ElligatorSwift ourselves would be the most security-sensitive code in the project and would *raise* the supply-chain/compromise risk that ADR-003 exists to minimise — so adopting the audited, pure-Go, ISC-licensed, transitive-dependency-free implementation is consistent with ADR-003's documented exception ("unless the dependency removes ongoing maintenance burden"). DIY crypto (B) was rejected as strictly worse for the wallet-security threat model; keeping the stub (C) was rejected as foreclosing the product's core transport (contradicting ADR-002).
- **Amended ADR-003** to record the fourth dependency with a cross-reference to ADR-011, keeping the policy coherent rather than silently eroded.
- **Backfilled the ADR index** (docs/adr/README.md) with entries 007–011, which had been missing.
- Decision only — the implementation follow-ups (secp256k1 ECDH in noise.go, ElligatorSwift, removing §2, updating THREAT_MODEL dependency assumptions) are listed in ADR-011 and tracked for a subsequent change, gated on adding the dependency to a real build.

### Features (session 48 — share acceptance rate)

- **Added `otedama_share_acceptance_rate`** = accepted / (accepted + rejected) — the single number that maps to "net BTC retained," since every rejected share is work the pool will not pay for (the effective-yield idea from session 47's research, `docs/RESEARCH_IMPROVEMENTS.md` Cat 3 #12). The rate is computed each stats tick, exported as a gauge, and a warning is logged once-per-tick if it falls below 97% with at least 20 judged shares (industry guidance puts >1% reject in the "needs attention" band) — pointing the operator at the reject-reason breakdown from session 45 to diagnose *why*. The `acceptanceRate` helper returns 1.0 on a fresh start (zero judged shares) rather than a 0/0 that would falsely read as 0% and trip the warning.
- **3 tests:** acceptance-rate arithmetic across the full range (incl. fresh-start = 100% and all-rejected = 0%), an explicit no-divide-by-zero guard, and the gauge appearing in `/metrics` output.
- Together with reject-reason classification (s44–45) and submit-latency quantiles (s46), Otedama now exposes the complete chain an operator needs to compare pools on real yield: *acceptance rate* (how much work is paid) → *reject reasons* (why work is lost) → *submit latency* (the stale-share root cause). Test count: **720**.

### Documentation (session 47 — payout-scheme research & pool-selection guidance)

- **Added a "Choosing a pool" section to the README** (bilingual), distilling the consistent message of 2026 pool comparisons (D-Central, Coin Bureau, Solo Satoshi, Simple Mining): compare **net BTC retained, not the headline fee rate**. It explains that reliability dwarfs fee differences (a 4% uptime gap ≈ 4× a 1% fee gap), how the metrics Otedama already exposes (reject-rate by reason, submit latency, stall, failover) let users compare pools on real reliability, the FPPS/PPLNS/TIDES payout-scheme trade-offs (and why TIDES/PPLNS align with Otedama's non-custodial design), and minimum-payout-threshold traps.
- **Expanded `docs/RESEARCH_IMPROVEMENTS.md`**: added two findings to Category 3 (payout-scheme awareness; effective-yield > fee-rate accounting using metrics Otedama already collects) and a **new Category 11 — Lightning payout routing & economics** (10 items) grounded in Pickhardt & Richter's min-cost-flow payment optimisation (arXiv:2107.05322), LN liquidity-centralisation analysis (arXiv:2506.19333), and pathfinding analysis (arXiv:2410.13784). Updated the sources footnote with the three new arXiv references.
- No code change this pass — the highest-value action surfaced (payout-scheme detection) is best delivered as honest user guidance rather than fragile hostname-based guessing, so it went into the README where users evaluating Otedama will see it.

### Features (session 46 — share-submission latency tracking)

- **Added submit-latency quantiles (`LatencyTracker` + `otedama_submit_latency_milliseconds{quantile=0.5|0.95|0.99}`).** Stale shares — the single biggest reject cause — are driven by round-trip latency to the pool, so this is the natural complement to session 45's reject-reason breakdown: now an operator can see *the latency that causes* the stale rejects, and decide to switch to a closer pool before it costs revenue. `LatencyTracker` keeps the most recent 256 submit→accept RTT samples in a lock-protected ring buffer and computes exact nearest-rank quantiles over the retained window (no streaming-estimator error, consistent with ADR-005's no-client-dependency stance). The engine records a sample when a `SubmitSharesSuccess` settles the sequence numbers of in-flight submits, and logs/exports p50/p95/p99 on each stats tick.
- **4 tests:** empty tracker returns zero, quantiles over a known 1–100 distribution, ring-buffer eviction of old samples, and negative-sample (clock-skew) rejection. Test count: **717**.
- Marked Category 2 item 7 and Category 9 item 5 done in `docs/RESEARCH_IMPROVEMENTS.md`.

### Features (session 45 — reject-reason breakdown metric)

- **Added `otedama_shares_rejected_by_reason_total{reason=...}`** — a Prometheus counter breaking down rejected shares by inferred root cause (stale / duplicate / difficulty / hardware / other). This is the observability half of the reject-classification work started in session 44: operators can now see *why* shares fail, which maps directly to the fix (latency vs hardware vs config), and can derive the reject *rate* against the industry thresholds (<0.5% excellent … >3% act now) by combining it with `otedama_shares_total` in a query. Refactored the classifier into `rejectClass(reason) → (category, diagnosis)` as the single source of truth feeding both the metric label and the log diagnosis; `classifyReject` is now a thin log-only wrapper over it. The per-reason counter is created lazily and memoised so re-registration is safe.
- **4 tests:** category+diagnosis classification across all reason classes, the `classifyReject` wrapper's consistency with `rejectClass`, lazy-create-and-reuse of the per-reason counter (no duplicate registration), and the metric appearing with its `reason` label in `/metrics` output. Test count: **713**.
- Marked Category 1 items 1–2 done in `docs/RESEARCH_IMPROVEMENTS.md`; the only remaining sub-task there is a built-in reject-rate warning gauge.

### Research & features (session 44 — 10-category research survey + reject classification)

- **Added `docs/RESEARCH_IMPROVEMENTS.md`** — a structured survey categorising Otedama into ten domains (mining software, Stratum protocols, non-custodial wallets, P2P/decentralisation, AI-inference markets, resource arbitration, Go CLI, power optimisation, observability, cryptography), each with ~10 findings drawn from arXiv, GitHub, and comparable software, distilled into concrete improvements tagged done / planned / newly-surfaced / rejected with tracking ADRs. Ends with a cross-category ranking of highest-leverage next actions. Sources include arXiv 1703.06545, 1811.12852, 2105.04373, 2411.11119, 2505.00303, 1012.3005, 2405.05950, 2503.12285; the decred/dcrd secp256k1 library (confirmed canonical for the Noise secp256k1 work — pure Go, ISC, 150+ importers); ESP-Miner #1383; and the D-Central reject-share taxonomy.
- **Implemented share reject-reason classification** (a top finding from Category 1). Previously a rejected share was logged with the pool's raw reason string and counted uniformly. Now `classifyReject` maps the reason to a likely root cause following the community field taxonomy — *stale*→network latency, *duplicate*→firmware/connectivity, *above-target/low-difficulty*→difficulty config, *invalid*→hardware (failing chip/overheating) — and appends it to the warning, turning an opaque pool string into an actionable diagnosis. 1 test covering all reason classes. Test count: **710**.

### Features (session 43 — hashrate stall detection)

- **Added `HashrateMonitor` — hashrate-drop detection, the safety net every comparable miner has** (cgminer/Awesome Miner hashrate-drop triggers) and Otedama lacked. Without it, a miner that silently stops hashing (wedged driver, thermal shutdown, work starvation) keeps the process alive earning nothing, and the operator never finds out. The monitor warns once after a configurable number of consecutive samples at or below a hashrate floor (default: complete stall = 0 H/s, 3 samples), logs a recovery message when hashrate returns, and exposes `Stalled()` for health/readiness checks. It does not spam: one warning per stall episode.
- Wired into the per-session stats loop in `runSession`, observing total worker hashrate on each stats tick. Extracted a `totalHashrate(workers)` helper so the stats logger and the monitor share one summation (DRY).
- **3 tests:** warns only after the sustained threshold (and not before, and not repeatedly), resets and re-arms on recovery, and treats a sub-floor (non-zero) hashrate as a stall when a floor is configured. Test count: **709**.

### Features (session 42 — multi-pool failover)

- **🔴 Implemented multi-pool failover — a baseline feature every comparable miner has (cgminer, bfgminer, Awesome Miner) that Otedama was missing.** The config schema already declared `Pools []PoolConfig` "in order of priority for failover," but the engine only ever read `Pools[0]` — so the documented failover never happened, a config-vs-implementation gap. Now `runReconnectLoop` rotates through the configured pools: on a connection failure or drop it advances to the next pool *immediately* (no backoff), and only applies the exponential reconnect backoff once every pool in the list has been tried and failed. A single-pool config behaves exactly as before (retry with backoff). Added `poolURLs(cfg)` to extract the ordered failover list.
- **Connection logs now show pool position** (`pool 2/3`) when more than one pool is configured, so operators can see failover happening.
- **3 tests** for `poolURLs`: empty config returns the built-in default, multi-pool preserves the user's priority order, single-pool works. Test count: **706**.
- **`config.yaml.example`** updated to document the now-functional failover behaviour (priority order, immediate rotation, backoff only after all pools fail) with an uncommentable backup-pool example.

### Documentation (session 41 — arXiv grounding for ADR-008 power layer)

- **Strengthened ADR-008 (hardware/power) with academic grounding from two arXiv papers** found in a literature review of Bitcoin mining energy optimisation:
  - Sub-domain 3 (DVFS profit math): noted that Otedama's per-interval *myopic* profit maximiser is the static special case of the horizon-aware optimal-control problem solved by Ginzburg-Ganz et al. (arXiv:2411.11119) via Pontryagin's minimum principle on real CAISO/Noga grid data. Documented the upgrade path — once `tariff.PriceFeed.Forecast` (sub-domain 4) is reliable, it is exactly the input a Pontryagin-style scheduler needs. We ship myopic first by deliberate choice (most value, no forecast dependency).
  - Sub-domain 7 (solar/battery): cited Choi et al. (arXiv:2505.00303), which empirically validates surplus-only mining economics and uses the same S21 XP Hyd (12 J/TH) hardware class as the baseline. Confirms the core premise that surplus-driven mining at ~$0 marginal cost is profitable at modest BTC prices. Noted that Otedama deliberately avoids the paper's RF/LSTM price forecasting in favour of ADR-010's lightweight Holt-Winters.
- Reorganised ADR-008's References into "Production tools and APIs" and "Academic literature" subsections. The power ADR previously cited only vendor tools and APIs with zero academic backing; it now has peer-reviewed grounding for its two most quantitative sub-domains.

### Documentation (session 40 — arXiv-informed threat model & theory grounding)

- **Added the traffic-analysis side-channel threat to `docs/THREAT_MODEL.md`.** A literature review surfaced Recabarren & Carbunar, "Hardening Stratum" (arXiv:1703.06545), which demonstrates (StraTap / ISP-Log attacks) that a network or ISP observer can infer miner *earnings* from packet sizes and timestamps **even when the channel is encrypted** — Otedama's Noise NX protects payload content but does not pad or rate-shape traffic. The Information-disclosure section now states this honestly: funds are not at risk (non-custodial payouts), but hashrate/luck can be estimated by an on-path adversary; the mitigation is Tor/VPN tunnelling (Tor-by-default is ADR-007 B7), with traffic-shaping / mining-cookie hardening noted as future work. The paper is cited in the References section. This closes a real gap — the prior threat model only considered content-reading disclosure, not timing analysis.
- **Strengthened ADR-010 (arbitration engine) with formal grounding for Feature A3.** When per-device suitability scoring is combined with the ADR-008 power-budget cap, the problem is sequential resource allocation under a replenished side constraint. Cited Burnetas et al. (arXiv:1811.12852, side-constraint MAB) and Zuo & Joe-Wong (arXiv:2105.04373, combinatorial-MAB logarithmic-regret budget allocation) as the theoretical basis confirming the greedy/Hungarian assignment is a principled approximation and defining the regret-optimal target at scale. Added a References section to ADR-010 consolidating all cited papers.

### Code quality (session 39 — engine→poolproto bridge + dead-code finding)

- **🔴 Found: the `poolproto` dialer packages are not yet wired into the binary.** Neither `poolproto/stratumv1` nor `poolproto/stratumv2` is imported anywhere outside tests, so their `init()` registration never fires and the `poolproto` registry is unused at runtime — the engine still uses its inline Stratum path. This was documented honestly by updating `docs/KNOWN_LIMITATIONS.md` §3 with the precise state and a 3-step integration plan (steps 1 and 2, done in sessions 37–38, plus the remaining `runSession` rewrite). Better to name the gap exactly than to leave the earlier vaguer "bypasses poolproto" wording.
- **Added `engine.applyJob`** — bridges the protocol-agnostic `poolproto.Job` (delivered by `Session.Jobs()`) to a `miner.Work`, pushing it to all workers. This is the connection point the eventual `runSession` rewrite will use to consume jobs from the abstraction instead of a raw stratum decoder. It parses the string `JobID` back to the miner's `uint32` and returns an error (rather than silently mining job 0) on an unparseable ID or an invalid `nBits` target — surfacing malformed jobs instead of wasting hashes.
- **3 tests** for `applyJob`: valid job, unparseable job ID rejection, and invalid-nBits rejection. Test count: **703**.
- This is step 3a of the engine→poolproto integration; step 3b (the `runSession` rewrite + blank import that fires dialer registration) is the remaining work, now de-risked by having both the V2 dialer (session 38) and the job bridge (this session) tested and ready.

### Features (session 38 — poolproto Stratum V2 Dialer)

- **Implemented `internal/poolproto/stratumv2`** — the Stratum V2 `Dialer`/`Connection`/`Session` adapter that was the missing piece blocking the engine→poolproto integration (`docs/KNOWN_LIMITATIONS.md` §3). Previously `poolproto` had only a Stratum V1 dialer, so the engine had no choice but to hand-roll the V2 handshake inline. Now both protocols sit behind the same `poolproto.Dialer` interface and are selectable by URL scheme via `poolproto.DialURL`.
  - `Dialer` registers two instances at init (plaintext `stratum+v2://` and TLS `stratum+v2tls://`), parses the host with the shared `poolproto.StripScheme` (session 37), and performs the SetupConnection + OpenMiningChannel handshake.
  - `session` runs a read loop that decodes `NewMiningJob` frames into `poolproto.Job` values on a channel, implements `Submit` (SubmitSharesStandard), `SuggestedDifficulty`, and `Close`.
  - **No wire-codec duplication:** all encoding/decoding (`WrapMessage`, `EncodeFrame`, `DispatchFrame`, the message types) is reused from `internal/stratum` — the adapter is glue, not a reimplementation (16 call-sites into `internal/stratum`).
- **5 tests:** protocol-ID selection (plaintext vs TLS), scheme-stripping via an injected dial function (no real network), unknown-scheme rejection, registry lookup of both registered dialers, and `parseJobID` edge cases.
- Compile-time assertions pin that `*Dialer`, `*connection`, and `*session` satisfy the three `poolproto` interfaces.
- This is step 2 of 3 in the engine→poolproto integration (step 1 was the scheme SSOT in session 37). Step 3 — rewriting `engine.runSession` to call `poolproto.DialURL` and consume `Session.Jobs()` — can now proceed against a real V2 dialer. Test count: **700**.

### Code quality (session 37 — URL-scheme single source of truth)

- **De-duplicated pool URL scheme parsing.** Two packages independently hard-coded the list of recognised scheme prefixes (`stratum+v2://`, `stratum+v2tls://`, …): `poolproto.FromURL` (which protocol?) and `engine.parseHost` (what host follows?). Adding or changing a scheme meant editing both, with drift risk. Introduced `poolproto.knownSchemes` as the single source of truth — a `{prefix, protocol}` table — and refactored `FromURL` to iterate it. Added `poolproto.StripScheme(url)` (host extraction from the same table), and rewrote `engine.parseHost` to delegate to it. Now the scheme list lives in exactly one place.
- **Side benefit:** `engine.parseHost` now also accepts `datum://` URLs (it previously knew only the four Stratum schemes), a small step toward the ADR-009 DATUM template source — the engine can now at least resolve a DATUM pool's host.
- **4 new tests** for `StripScheme`: all five known schemes, unknown-scheme rejection via `ErrUnknownProtocol`, bare-scheme (empty host) rejection, and a consistency test asserting that any URL `StripScheme` accepts is also classified as a known protocol by `FromURL` (guards against the two ever diverging again).
- This is a small, safe first step toward the larger engine→poolproto integration tracked in `docs/KNOWN_LIMITATIONS.md` §3: the two packages now share scheme knowledge, which the full `DialURL` integration will build on. Test count: **695**.

### Honesty & transparency (session 36 — disclose alpha limitations)

- **🔴 Fixed: simulated AI-inference yield was not disclosed at runtime.** `AkashProvider` models Akash market conditions rather than querying the live API, but only a source-code comment said so — a user watching the TUI could mistake simulated inference yield for real income. The provider's `Name()` now returns **"AI Inference (Akash Network, simulated)"**, so the disclosure appears everywhere the name is shown (TUI, logs, `config show`). A regression test (`TestAkashProvider_NameDisclosesSimulation`) fails if the "(simulated)" suffix is ever removed without also updating the test — forcing a conscious decision when the real integration lands.
- **Added `docs/KNOWN_LIMITATIONS.md`.** An exhaustive, honest list of what the alpha does not yet do or does in simplified form: (1) simulated inference yield, (2) Noise NX using P-256 instead of secp256k1, (3) engine bypassing the poolproto abstraction, (4) Linux-only GPU detection, (5) scaffolded-but-inactive post-quantum schemes, (6) receive-only Lightning. Each entry states impact, workaround, and target release, and links the governing ADR. This lets users, auditors, and future maintainers distinguish "designed this way" from "not finished yet" without reading source.
- **README links to the limitations doc** (bilingual) from the Project Status section, so anyone evaluating Otedama sees the honest boundary before relying on it.
- Test count: **691**.

### Documentation & tests (session 35 — command reference + coverage gap)

- **🟡 Fixed: README documented only 1 of 11 subcommands.** The README's Quick Start showed only `otedama run`, leaving `version`, `config show/validate`, `service install/uninstall/status`, `doctor`, and `help` undiscoverable to users reading the repository front page. Added a bilingual **Command Reference** table listing all subcommands with one-line descriptions, plus worked examples (`otedama doctor`, `otedama config show`, `otedama service install`). The table is sourced from the binary's actual `help` output so it cannot drift from reality.
- **Closed the last subcommand test-coverage gap.** Audited per-subcommand test references and found `service uninstall` was the only subcommand with zero tests (every other subcommand had between 5 and 67 references). Added `TestService_Uninstall_DoesNotCrash`, which verifies the command routes and returns a known exit code (success or graceful runtime error) on a machine without the service installed, rather than panicking. All 11 subcommands now have test coverage. Test count: **690**.

### Code quality (session 34 — consistency & magic-number cleanup)

- **Error-message prefix consistency.** Audited error strings across the engine, stratum, lightning, arbitration, and provider packages for the `"package: ..."` prefix convention. Found and fixed the one outlier: `engine.parseHost` returned a bare `"unrecognised pool URL scheme"`; it now reads `"engine: unrecognised pool URL scheme in %q"` with the offending URL included for debuggability. (lightning, arbitration, provider were already 100% consistent.)
- **Magic numbers → named constants.** Centralised the engine's timing values into a documented `const` block at the top of `run.go`: `reconnectBackoffInitial` (1s), `reconnectBackoffMax` (64s), and `arbitrationInterval` (30s). Previously these were inline literals scattered across the reconnect loop and the arbitration ticker — now the reconnection and re-arbitration cadence is documented in one place and changeable without hunting through the run loops.
- **`buildLogger` unit tests (3).** The logger-construction helper extracted in session 30 was previously only exercised indirectly. Added direct tests: TUI mode discards all output (so it cannot corrupt the dashboard), `--no-tui` text mode writes the message, and `--no-tui` JSON mode emits valid parseable JSON. Test count: **689**.

### Code quality (session 33 — refactor test-coverage backfill)

- **Backfilled tests for code introduced during the sessions 24–32 refactors.** The structural diet (extracting `fanIn`, splitting `wire.go`) had moved logic into new functions/files that were only covered indirectly. Two gaps were closed:
  - **`internal/engine/fanin_test.go` (6 tests):** the generic `fanIn[T]` channel-merge helper is now directly tested for value-completeness (every input value appears once), output-close-on-all-inputs-drained, context-cancellation shutdown, empty-channel-list edge case, buffer-size capping (the `>64` and `<1` paths), and a race-detector-friendly concurrent-producers scenario. `fanIn` is the consolidation of the former `mergeQuotes`/`mergeShares`; being generics + goroutines + channel-close, it is exactly the kind of code that needs explicit concurrency tests.
  - **`internal/stratum/wire_test.go` (14 tests):** the low-level Stratum V2 encoding primitives extracted into `wire.go` are now tested directly rather than only through message round-trips. Covers STR0_255 / B0_255 length-prefix round-trips, the 255-byte boundary and over-length rejection, truncated-input errors, U16/U32 little-endian byte order and round-trips, and the `byteSliceReader` ReadByte/Read interleaving and EOF behaviour. Protocol byte-boundary handling is a classic bug source, so the edge cases are now pinned.
- Test function count across the codebase: **686**.

### Features (session 32 — complete BIP-39 wordlist)

- **🔴 Fixed: incomplete BIP-39 English wordlist.** `internal/lightning/english_wordlist.go` previously embedded only 512 real words padded with generated placeholders. This was a **wallet-compatibility defect**: a user importing a genuine BIP-39 mnemonic (from Ledger, Trezor, Electrum, etc.) would hit "unknown word" errors, and `NewWordList` (which requires exactly 2048 entries) would always reject the stub. Mnemonics produced by Otedama were not portable to any other wallet.
- **Now embeds the complete official 2048-word BIP-39 English wordlist** (abandon … zoo), verified at `init()` by SHA-256 against the canonical hash `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`. This is the identical list used by every BIP-39-compliant wallet, so mnemonics are now fully portable. Sourced from the public-domain bitcoin/bips repository (attributed in NOTICE).
- **Added `NewEnglishWordList()`** helper (was referenced by `engine/run.go` and tests but never defined — a latent build break waiting to surface once the stub was replaced).
- **5 new tests**: exact 2048-word count, boundary words (abandon/zoo), the official all-zero-entropy vector ("abandon…about"), entropy↔mnemonic round-trip across all five entropy sizes (16/20/24/28/32 bytes), and full index-map coverage of every word. The pre-existing `TestMnemonicToSeed_BIP39OfficialVector` (TREZOR vector) now has a real wordlist behind it.
- **Integrity guarantee:** if the embedded wordlist is ever corrupted (bad merge, encoding issue), `init()` panics at startup rather than silently producing incompatible mnemonics.

### Bug fixes & robustness (session 31 — error-handling audit)

- **`lightning/wallet.go` save(): hardened temp-file Close handling.** Previously `tmp.Close()` after a successful `Sync()` ignored its error. On filesystems where the final flush happens at Close (rather than Sync), a Close error can mean data did not reach disk — yet the code proceeded to `Chmod` and `Rename` a possibly-incomplete wallet file. Now a post-Sync Close error removes the temp file and returns an error, preventing a corrupt wallet from being atomically renamed into place.
- **`httpserver`: background Serve errors are now observable.** The `Serve` goroutine previously discarded any non-`ErrServerClosed` error with `_ = err`, so a crashed HTTP listener was completely invisible. Added a `serveErr atomic.Pointer[error]` field and a `ServeError() error` accessor so a supervisor or health check can detect an unexpectedly-terminated server. Clean shutdown (`ErrServerClosed`) is correctly NOT recorded as an error. Two tests added.
- **Audit results (no action needed):** godoc coverage on exported symbols is complete; no `context.TODO()` remains; the only non-test `panic` calls are init-time registration guards (idiomatic Go, matching `database/sql.Register`); the single remaining `_ = err` (best-effort fingerprint write) now carries an explicit intent comment for `errcheck`-style linters.

### Code quality (session 30 — cmdRun helper extraction)

- **`cmd/otedama/main.go` `cmdRun` refactored**: 101 → 77 lines (-24%). Extracted two single-responsibility helpers:
  - `buildLogger(f, cfg, stdout) *logger.Logger` — constructs the structured logger, handling the TUI-vs-no-TUI discard logic and text/JSON format selection.
  - `startHTTPServer(ctx, f, stdout, stderr) (*metrics.Registry, *httpserver.Server)` — starts the optional health/metrics HTTP server, returning nil handles when `--http-addr` is unset or startup fails (a startup failure is logged but does not abort the run).
- Both helpers are now independently unit-testable, where previously the logic was inline in the 101-line `cmdRun`. `cmdRun` now reads as a clean sequence: parse flags → resolve config → init i18n → build logger → start HTTP → run engine.
- No `cmd/otedama` function now exceeds 80 lines. The only two functions above 80 lines in the whole codebase are `engine.Run` (110) and `engine.runSession` (107), both legitimate orchestrators that call sequenced phases.

### Code quality (session 29 — engine.Run phase 3+5 extraction)

- **`engine.Run` reduced from 130 to 111 lines.** Extracted two more startup phases into helpers:
  - `startMinerWorkers(ctx, devices, log) ([]*miner.Worker, <-chan miner.Share, error)` — Phase 3 worker spawning + share-channel fan-in
  - `startProviders(ctx, cfg, rateFetcher, devices, log) (*MiningProvider, *AkashProvider)` — Phase 5 provider construction + start
- `defer`-based cleanup (worker stop, provider stop) is deliberately retained in the parent `Run` scope, where teardown ordering is correct.
- **Cumulative `engine.Run` diet across sessions 24–29: 234 → 111 lines (-53%).** `Run` is now a pure orchestrator — each of the 8 phases is a 1–3 line statement reading top-to-bottom as the engine lifecycle. Six extracted helpers (`setupWallet`, `detectDevices`, `startMinerWorkers`, `startProviders`, `runArbitrationLoop`, `runReconnectLoop`) are each independently unit-testable.

### Code quality (session 28 — engine metrics split + critical bug fix)

- **🔴 Critical fix: restored missing `runSession` function signature.** During the session-24 arbitration-loop extraction, the `func runSession(ctx context.Context, opts sessionOpts) error {` signature line was accidentally deleted, leaving the function body orphaned directly after `setupWallet`'s closing brace. This would have been a hard `go build` failure. Restored the signature with its doc comment. (Caught by a brace-balance + orphaned-body audit during this session's refactor — a reminder to run `go build` in CI before every commit.)
- **`internal/engine/metrics.go` extracted** from run.go: the `engineMetrics` struct and `newEngineMetrics` constructor (63 lines of Prometheus metric-handle registration) now live in their own file. run.go drops from 878 → 819 lines. The metric-registration boilerplate is separated from orchestration logic.
- Verified brace/paren balance across all recently-split files (run.go, metrics.go, wire.go, handshake.go, messages.go) — all balanced.

### Code quality (session 27 — stratumv1 parser + dialer split)

- **`internal/poolproto/stratumv1/stratumv1.go` decomposed in two steps**: 578 → 451 → 355 lines.
  - **Step 1 (parser):** extracted the pure parsing functions (`parseNotify`, `parseDifficulty`, `parseSetExtranonce`, `parseAddress`, `trimRight`, `float64ToUint64`, `uint64ToFloat64`) into a new file `internal/poolproto/stratumv1/parse.go` (150 lines). Stateless JSON decoding split from stateful machinery.
  - **Step 2 (dialer):** extracted the `Dialer` (poolproto.Dialer implementation) and `connection` wrapper into `internal/poolproto/stratumv1/dialer.go` (115 lines). The connect phase split from the session phase.
  - Result: four focused files — `dialer.go` (connect), `parse.go` (parsing), `stratumv1.go` (session + dispatch + RPC plumbing), plus tests.
- **Removed unused imports**: `math` (after parser split) and `net` (after dialer split). Both would have failed `go build`.
- **Milestone: `internal/engine/run.go` (878 lines) is now the only implementation file over 500 lines.** Every other file in the codebase is under the 500-line readability threshold. (run.go's bulk is well-factored helper functions; its `Run` orchestrator is 173 lines after the session-24 diet.)

### Code quality (session 27 — engine.Run reconnect-loop extraction)

- **`engine.Run` reduced from 173 to 130 lines.** Extracted Phase 8 (the pool connection + exponential-backoff reconnect loop) into a dedicated `runReconnectLoop(ctx, reconnectOpts)` function. The 9 local variables it needed (workers, merged channel, dashboard, startTime, wallet fingerprint, device count, providers, metrics, log) are now bundled in a `reconnectOpts` struct, the same pattern used for `runArbitrationLoop` in session 24.
- **Cumulative `engine.Run` diet across sessions 24–27: 234 → 130 lines (-44%).** The function is now a pure orchestrator: each of the 8 startup phases (wallet, hardware detection, miners, rates, providers, arbitration, TUI, pool-reconnect) is a single readable statement or helper call. The four extracted helpers (`setupWallet`, `detectDevices`, `runArbitrationLoop`, `runReconnectLoop`) are independently unit-testable.

### Code quality (session 27 — lightning/seed.go split)

- **`internal/lightning/seed.go` decomposed**: 467 → 313 lines. Extracted the at-rest encryption layer (`EncryptedSeed`, `EncryptSeed`, `DecryptSeed`, `Marshal`, `UnmarshalEncryptedSeed`, scrypt parameters, on-disk format) into a new file `internal/lightning/seedstore.go` (178 lines). The split separates two distinct responsibilities:
  - `seed.go` — BIP-39 derivation: entropy generation, wordlist, mnemonic ↔ entropy conversion, seed derivation (PBKDF2), and the public `Fingerprint` helper.
  - `seedstore.go` — at-rest protection: scrypt key derivation + AES-GCM encryption + binary on-disk format.
- **Security-audit benefit:** the encryption surface (covered by CODEOWNERS) is now isolated in a single 178-line file rather than buried in a 467-line module.
- **Removed unused imports** `crypto/aes`, `crypto/cipher`, `golang.org/x/crypto/scrypt` from `seed.go` after the move. `seed_test.go` continues to work because both files share package `lightning`.

### Code quality (session 26 — stratum handshake/mining split)

- **`internal/stratum/messages.go` further decomposed**: 618 → 342 lines. Extracted the connection-establishment messages (`SetupConnection`, `SetupConnectionSuccess`, `SetupConnectionError`, `OpenMiningChannel`, `OpenMiningChannelSuccess`, `OpenMiningChannelError`) into a new file `internal/stratum/handshake.go` (300 lines). `messages.go` now contains only the steady-state mining messages (`NewMiningJob`, `SubmitSharesStandard/Success/Error`) plus dispatch (`WrapMessage`, `DispatchFrame`, `Message`, `UnknownMessage`). This completes the three-way split of the original 768-line monolith:
  - `wire.go` (169 lines) — binary encoding primitives
  - `handshake.go` (300 lines) — connection-establishment phase
  - `messages.go` (342 lines) — steady-state mining phase + dispatch
- **Removed unused imports** `errors` and `io` from `messages.go` after the move (would have failed `go build`). Added `encoding/binary` and `io` to `handshake.go` where they are now used.
- The `Protocol` type and the `Msg*` msg_type constants remain in `messages.go` as the shared protocol catalogue, referenced from `handshake.go` via same-package access.
- Net effect: the largest two files in the stratum package are now 342 and 300 lines (was a single 768-line file); each maps cleanly to one phase of the Stratum V2 protocol lifecycle.

### Code quality (session 25 — stratum/messages.go split)

- **`internal/stratum/messages.go` decomposed**: 768 → 618 lines (-20%), 49 → 33 type+func declarations (-33%). Extracted 169 lines of low-level encoding primitives (`putStr0_255`, `getStr0_255`, `putB0_255`, `getB0_255`, `putU16LE`, `getU16LE`, `putU32LE`, `getU32LE`, `byteWriter`, `byteSliceReader`, `newByteReader`, `float32bits`, `float32frombits`) into a new sibling file `internal/stratum/wire.go`. The split follows the same Carmack/Pike principle as the engine.Run diet: separate "what" (protocol message types) from "how" (binary encoding plumbing). `messages.go` now reads as a clean specification of the Stratum V2 Mining Protocol message catalogue. `wire.go` is a self-contained utility module reusable across future protocol additions (Stratum V2 Job Declaration, Template Distribution).
- **Removed unused `math` import** from `messages.go` after the wire-primitive move (would have been a hard Go compile error in CI).
- All `messages_test.go` references continue to work because the moved helpers are still in the same package (`stratum`).

### Code quality (session 24 — engine.Run diet)

- **`engine.Run` refactored from 234 lines to 173 lines** (-26%). The monolithic orchestration function is now decomposed into four helpers, each with a single responsibility:
  - `setupWallet(opts, log) string` — Phase 1 Lightning wallet initialisation
  - `detectDevices(ctx, log) ([]hal.Device, error)` — Phase 2 HAL registry + driver registration + detection
  - `runArbitrationLoop(ctx, opts)` — Phase 6 quote-driven arbitration goroutine (was inline 39-line closure)
  - `fanIn[T any]` (Go generics) — replaces `mergeQuotes` and `mergeShares` (27 LoC × 2 → 27 LoC × 1)
- **Bug fix: `reg` shadowing**. Phase 2 redeclared `reg` (previously bound to the metrics registry from Phase 0). Renamed the HAL registry to `halReg` so the metrics registry remains visible throughout Run's scope. This was a latent bug — the compiler accepted it but any future code referring to `reg` after Phase 2 would silently get the wrong value.
- **Removed two 5-line duplicate blocks** in `internal/engine/run.go` — the `mergeQuotes`/`mergeShares` fan-in pattern that is now consolidated under `fanIn`.

### Research and architecture (post-alpha-1)

- **ADR system structural integrity restored** (session 23 cleanup):
  - **ADR-007** ("Lightning capability expansion"): formalized into a discrete file. Previously referenced from 9 places (ROADMAP.md, ADR-008, ADR-009, CHANGELOG.md) but had no on-disk presence. The 359-line ADR consolidates B1–B10 features with explicit rejections of B11/B12.
  - **ADR-010** ("Arbitration engine evolution"): newly numbered (was conflictingly labeled "ADR-006" in earlier research drafts, colliding with the already-accepted ADR-006 "Protocol abstraction"). The 298-line ADR consolidates A1–A9 features.
  - **Naming unified:** files `008-hardware-power-awareness-layer.md` and `009-pool-decentralization-integration.md` renamed to the `ADR-NNN-` prefix used by ADR-001 through ADR-006. All 10 ADRs now follow a single naming pattern.
  - **All cross-references updated:** ROADMAP.md, ADR-008, and ADR-009 now reference ADR-010 (arbitration) instead of the previously colliding "ADR-006." The historical ADR-006 (Protocol abstraction) is preserved unchanged.
- **ADR-009** ("Pool decentralization integration: Job Declaration + DATUM") added to `docs/adr/`. Defines a `TemplateSource` abstraction with implementations for Stratum V2 Job Declarator Client (Braiins/DMND/SRI), OCEAN DATUM (C→Go reimpl), and solo mining mode. Triggered by the May 7, 2026 Stratum V2 Working Group expansion (Foundry, AntPool, F2Pool, Spiderpool, Block Inc., MARA, DMND = ~70% of global hashrate). Adds Track D to the v3.5–v4.0 roadmap. Estimated ~480 solo-hours over v3.5–v3.7. Completes the commitment of ADR-002 ("Stratum V2 only") with actual miner sovereignty exercise: users construct their own block templates from their own Bitcoin node's mempool. Quantitative analysis shows ~6.3% per-S21 revenue uplift, ~$2,352/year for a 30-device farm (stacking with ADR-008 power optimization).
- **ROADMAP.md** updated to four parallel feature-deepening tracks for v3.5–v4.0. Combined cost (1,940h) honestly exceeds available budget (1,040h, 88% over). Explicit priority order documented: Track D (pool decentralization) and Track C (hardware/power) MUST SHIP; Track A (arbitration) follows; Track B Lightning embedded node DEFERRED to v4.1. Minimum viable v4.0 = ~715h = 17.5 months.
- **ADR-008** ("Hardware and power awareness layer") added to docs/adr/. Defines a new `internal/power/` package skeleton covering seven sub-domains: ASIC firmware adapters (LuxOS, BraiinsOS+, stock Bitmain, VNish, DCENT_OS), GPU power management (NVML, AMDGPU sysfs, Intel Xe, Apple Silicon observe), DVFS-aware profit math, time-of-use electricity pricing (Octopus Agile + Tibber + Amber + flat + CSV), demand response (manual schedule + aggregator endpoint), thermal/ambient awareness, and solar/battery integration (Enphase, Tesla Powerwall, Victron). Quantitative analysis shows 12-40% margin uplift potential across home-miner, small-farm, and solar-powered personas.
- **ROADMAP.md** restructured into four parallel feature-deepening tracks for v3.5–v4.0:
  - Track A — Arbitration engine evolution (ADR-010, ~290h)
  - Track B — Lightning capability expansion (ADR-007, ~395-575h)
  - Track C — Hardware and power awareness (ADR-008, ~595h)
  - Track D — Pool decentralization integration (ADR-009, ~480h)
- All four tracks pass non-custodial constraint checks.

### Maintenance (post-alpha-1)

- **Apache 2.0 compliance:** added SPDX-License-Identifier headers to
  all 87 Go files (implementation and tests). Added top-level `NOTICE`
  file enumerating third-party attributions per Apache 2.0 §4(d).
  Distribution archives (release zip + Docker image) now include
  `LICENSE` + `NOTICE` per the License's redistribution requirements.
- **CONTRIBUTING.md** documents the SPDX header convention and PR
  template now has a Legal compliance checklist (SPDX, DCO, AI
  disclosure, third-party code).
- **CODEOWNERS** extended to cover `internal/btccrypto/` and
  `internal/poolproto/` — both touch funds or hashrate routing.
- **`Config.LogFormat`** field added — `log_format: json` in YAML had
  been silently ignored. Fixed across all three layers (file/env/flag).
- **`go.mod`** baseline split: `go 1.22` (language semantics) +
  `toolchain go1.24.0` (build toolchain) for downstream-friendly
  builds. Dockerfile bumped to `golang:1.24-alpine` to match.
- **`tlskyber=1`** explicitly pinned in `go.mod`'s `godebug` block to
  make hybrid post-quantum TLS audit-visible.
- **`HandshakeState.Transport()`** now returns an error instead of
  panicking when called before handshake completion. Eliminates the
  last runtime panic in the implementation surface.
- **README.md** gains four standard badges (CI, License, Go version,
  project status).
- **`SECURITY.md`** cleaned up: removed references to a fictional
  `security@otedama.example` address and a not-yet-existent PGP key
  file. GitHub Private Vulnerability Reporting is now the canonical
  channel.
- 10-year sustainability research integrated into the codebase: see
  `GODEBUG_NOTES.md`, `VERIFY.md`, `MAINTAINERS.md`, `GOVERNANCE.md`,
  `docs/THREAT_MODEL.md`, `docs/AUDIT_CHECKLIST.md`,
  `docs/MIGRATING-FROM-V2.md`, and ADR-004/ADR-005.
- Removed roughly 2,000 lines of duplicated protocol-abstraction code
  that had been introduced as a parallel `internal/stratum/transport.go`
  layer; the canonical seam is `internal/poolproto/`. No public-API
  impact; the duplicates were never wired into the engine.
- Added missing test coverage to `internal/poolproto/` (was 0 LoC; now
  matches the 1.0+ test:impl ratio of the rest of the codebase).

### Planned for v3.1.0

- Real Akash REST API integration for AI inference bids (currently simulated).
- secp256k1 + ElligatorSwift in Noise handshake (currently P-256 alpha).
- Complete BIP-39 English wordlist via `go:embed` (currently 512 real + filler).
- Windows/macOS GPU detection (currently Linux sysfs only).
- Stratum V2 Job Declaration Protocol (miner-constructed templates).

---

## [3.0.0-alpha.1] — 2026-04-24

First alpha release of the v3.0 strategic reset. Otedama is now a non-custodial, Stratum V2-only compute arbitration CLI.

### Added

- **Non-custodial Lightning wallet.** BIP-39 seed generated locally, encrypted on disk with scrypt + ChaCha20-Poly1305 using a user-supplied passphrase. Seed never leaves the machine.
- **Stratum V2 client.** Full protocol implementation (framing, 10+ message types, Noise NX handshake) in `internal/stratum/`. Compatible with any V2 pool; tested against mock and planned against Braiins, DEMAND, OCEAN.
- **Compute arbitration engine.** Pure-function `internal/arbitration/` decides in real time whether each device should run Bitcoin mining or AI inference (via Akash Network), based on live yield quotes. Hysteresis (default 5%) prevents flapping.
- **Hardware abstraction layer.** CPU always; Linux GPU detection via `/sys/class/drm` (no CGO, no CUDA SDK dependency).
- **Terminal dashboard.** Zero-dependency ANSI renderer shows hashrate, pool state, wallet fingerprint, active providers, and earnings estimate in real time.
- **Auto-start service.** `otedama service install` registers systemd user unit (Linux), LaunchAgent (macOS), or Windows service with security hardening (`NoNewPrivileges`, `ProtectHome`, `PrivateTmp`).
- **Self-diagnostic tool.** `otedama doctor` runs six parallel checks (config, address, data dir, pool reachability, hardware, network) and prints actionable fix hints for each failure.
- **Structured logging.** `log/slog`-based, text or JSON output, level filtering, TUI coexistence (discard when dashboard active).
- **Prometheus metrics.** Exposed via HTTP `--http-addr`. Counter/Gauge only, no dependency on the official client library. Full Prometheus exposition format compliance.
- **Health endpoints.** `/healthz` (liveness), `/readyz` (engine readiness), `/metrics`, `/` (landing).
- **10-language UI.** Full message catalogs for en, ja, zh, ko, es, fr, de, pt, ru, ar. BCP 47 language detection.
- **Cross-platform releases.** GoReleaser builds signed binaries for Linux (amd64, arm64, armv7), macOS (amd64, arm64), Windows (amd64, arm64), and FreeBSD.
- **One-line installer.** `curl | bash` with SHA-256 and optional cosign verification.
- **Comprehensive test suite.** 78 Go files, 11,512 test LOC, test:impl ratio 1.32. Integration tests use a real mock Stratum V2 pool.
- **Fuzz testing.** Nightly GitHub Action runs `FuzzDecodeHeader` and `FuzzDecoder_ReadFrame` for 30 minutes each, auto-opens issues on crashers.
- **Continuous benchmarking.** PR-time benchstat comparison against main; >5% regression triggers a warning comment.

### Changed

- **License:** MIT → Apache 2.0.
- **Primary branch:** `master` → `main`.
- **Default protocol:** Stratum V1 → Stratum V2. V1 is no longer supported.
- **Scope:** multi-algorithm pool operator → non-custodial solo miner arbitration.
- **Bilingual documentation** (English + Japanese) for all user-facing files.

### Removed

- All non-SHA256d algorithms (Scrypt, Ethash, RandomX, etc.).
- Pool operator mode — Otedama is now a client only.
- Custodial payout modes — all earnings flow directly to the user's address.
- Legacy duplicate-file cleanup scripts from the v2 transition.

### Security

- Supply chain: all GitHub Actions are SHA-pinned (post-tj-actions 2025).
- Dependabot enabled for Go modules, Actions, and Docker images.
- CODEOWNERS enforces review on `lightning/` and `stratum/noise*`.
- govulncheck + gosec run in CI on every PR.
- Cosign keyless signing for release artifacts.

### Known limitations

- Akash AI inference provider emits simulated quotes (real API in v3.1.0).
- Noise handshake uses P-256 pending a secp256k1 integration (v3.1.0).
- GPU detection is Linux-only (macOS Metal, Windows DXGI in v3.5.0).

---

## [2.1.9] — 2025-08-22

Final release of the v2.x series. See `legacy-v2` branch for historical source. Only critical security fixes will be applied to v2.x for six months following the v3.0.0-alpha.1 release.

### Legacy Features

Multi-algorithm P2P mining pool supporting SHA256d, Scrypt, Ethash, and RandomX. CPU, GPU (NVIDIA/AMD), and ASIC mining support. Rate limiting, DDoS protection, session management with CSRF protection. PostgreSQL/SQLite persistence, optional Redis caching. Docker and Kubernetes deployment manifests.

---

## Earlier Versions

Prior v2.x and v1.x releases are documented in the Git history of the `legacy-v2` branch. They are not carried forward into the v3.0 changelog structure.
