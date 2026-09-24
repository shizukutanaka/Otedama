# Research-driven improvement backlog

This document categorises Otedama into ten domains and, for each, records
findings gathered from arXiv, GitHub, and comparable production software,
then distils concrete improvements. It is the synthesis layer between
external research and the ROADMAP/ADRs.

Status legend: ✅ done · 🔵 planned (ADR/ROADMAP) · 🟡 newly surfaced here · ❌ rejected (scope)

Each item notes the source and, where applicable, the tracking ADR.

---

## Category 1 — Bitcoin mining software

Comparables: cgminer, bfgminer, Braiins OS+, Awesome Miner, ESP-Miner (Bitaxe).

1. ✅ **Classify reject reasons, don't count them uniformly** (session 44–45).
   `rejectClass` maps the pool's reason to a category + diagnosis
   (stale→latency, invalid→hardware, duplicate→firmware, above-target→
   difficulty); the diagnosis is logged.
2. ✅ **Reject breakdown metric** (session 45):
   `otedama_shares_rejected_by_reason_total{reason=...}` lets operators
   see *why* shares fail. Reject *rate* against the industry thresholds
   (<0.5% excellent … >3% act now) is now also exposed directly as
   `otedama_reject_rate` / `otedama_stale_rate` gauges (session 101), so
   the warning thresholds need no PromQL arithmetic.
3. ✅ **Do not count `Method not found` setup responses as rejected shares.**
   ESP-Miner #1383: pools like OCEAN reject `mining.suggest_difficulty` /
   `extranonce.subscribe` with "Method not found". — session 100: these are
   correlated by JSON-RPC id in `Negotiate()` and never reach `rejectClass`
   or the share counters. `cancelPending()` in readLoop ensures no call()
   blocks indefinitely when the pool closes mid-handshake.
4. ✅ **Multi-pool failover** (session 42) — matches cgminer/bfgminer.
5. ✅ **Hashrate-drop detection** (session 43, HashrateMonitor) — matches
   Awesome Miner triggers.
6. 🔵 **Temperature-based throttling / shutdown.** Awesome Miner triggers on
   temperature thresholds. Tracked in ADR-008 sub-domain 6 (thermal).
7. ✅ **Per-device share statistics** (session 109) — `Share.DeviceID` propagated
   from `WorkerConfig.DeviceID`; lazy `otedama_device_shares_found_total{device=...}`
   counter in `engineMetrics`; 7 new tests.
8. 🔵 **Solo-mining mode** (bfgminer auto-fails-over to solo+local block
   submission when Bitcoin Core is present). Tracked in ADR-009.
9. ❌ **Multi-algorithm (Scrypt/Ethash) support** — out of scope; Otedama is
   SHA-256d/Bitcoin-only by ADR-002.
10. ✅ **"Trust the pool's numbers" reconciliation.** Local counters drift
    from pool-side truth; a periodic reconciliation against pool stats
    (where the pool exposes them) would catch silent miscounting.
    — **Done (sessions 61/256/261):** `updateShareRates` reconciles
    found-vs-pool-judged into `otedama_shares_unaccounted` and
    `otedama_shares_pending` (the only reconciliation possible — V1/V2
    pool protocols expose no server-side share totals to compare
    against). Session 261 closed the last gap: submit failures
    (disconnect mid-flight) were subtracted from pending so a dead
    session cannot pin the gauge >0 forever.
11. 🔵 **ASIC hardware is not detected at all** (found via Socratic review,
    session 232). Otedama's own product definition names ASIC first among
    the three hardware classes it arbitrates, but `internal/hal` registers
    only a CPU driver and a Linux-only GPU driver — no ASIC driver exists,
    so an owned Antminer/Whatsminer is invisible to the engine entirely.
    ADR-008 sub-domain 1 already scopes this correctly (v3.5, ~150h across
    five firmware dialects, highest value/cost rank in that ADR) — the gap
    was that `docs/KNOWN_LIMITATIONS.md`'s "honest, exhaustive" inventory
    didn't disclose it as a *current* limitation; now fixed as
    KNOWN_LIMITATIONS §8. Implementation itself remains 🔵 (ADR-tracked,
    v3.5) rather than attempted ad hoc: the ASIC integration shape (poll a
    remote appliance's own firmware control surface) differs enough from
    the in-process `miner.Worker` model that it warrants the full
    design-review workflow CLAUDE.md mandates for new features, not a
    single-session implementation against protocol details that can't be
    verified against real hardware here.

---

## Category 2 — Stratum / mining protocols

1. ✅ **Stratum V2 codec** (internal/stratum) with SetupConnection /
   OpenMiningChannel / NewMiningJob / Submit.
2. ✅ **poolproto V2 dialer** (session 38) behind a protocol-agnostic
   interface.
3. 🔵 **secp256k1 + ElligatorSwift for the Noise NX channel** — currently a
   P-256 stub (KNOWN_LIMITATIONS §2). See Category 10.
4. 🔵 **Job Declaration Client (JDC)** — SV2's headline feature letting the
   miner build its own block template. Tracked ADR-009.
5. ✅ **`extranonce.subscribe` / `suggest_difficulty` handling on the V1
   fallback** — see Category 1 item 3. — session 100: `extranonce.subscribe`
   sent as step 3 of Negotiate(); "Method not found" and other pool errors
   are silently ignored (optional extension). Enables mid-session extranonce
   rotation on pools that support it (OCEAN, AntPool 2.x, etc.).
6. 🔵 **DATUM / OCEAN template source** — ADR-009; `engine.parseHost` already
   accepts `datum://` (session 37).
7. ✅ **Share-submission latency histogram** (session 46). `LatencyTracker`
   records submit→accept RTT in a ring buffer; p50/p95/p99 are logged and
   exported as `otedama_submit_latency_milliseconds{quantile=...}`. Since
   stale shares are latency-driven, this tells operators when to switch to
   a closer pool *before* it costs them in the reject rate.
8. ✅ **engine→poolproto wiring** — KNOWN_LIMITATIONS §3, step 3b.
   — **Done (session 259):** engine blank-imports both dialers;
   `runSession` dispatches `stratum-v2[-tls]` to `runPoolSession`, the
   same loop that drives V1 (reconnect, curtailment, benign-reject, latency).
9. ✅ **Graceful handling of the V1 `clean_jobs` flag** (session 97).
   `stratumv1.sendJob` now drains ALL pending jobs when `clean_jobs=true`
   (new block found), preventing stale-share submissions. Previously only
   the oldest was dropped; up to 7 stale jobs could remain queued.
   — ✅ **V2 `SetNewPrevHash` implemented** (session 238; this bullet's
   note about the msg_type was itself wrong — the real SV2 value is
   `0x20`, not `0x17`). `internal/stratum/messages.go` now defines
   `SetNewPrevHash`/`SetTarget` with full Encode/Decode, wired into
   `DispatchFrame`. The engine's session loop implements the future-job
   cache this item anticipated: `NewMiningJob` without `min_ntime` (the
   OPTION[u32] encoding — SV2's `future_job` concept) is held in a
   `map[uint32]*NewMiningJob` until the `SetNewPrevHash` naming its
   `job_id` arrives, at which point it activates against the new chain
   tip; any other cached job is discarded (a stale tip). This closed a
   correctness defect well beyond "no effect today": before this fix
   `internal/engine/run.go`'s `updateWork` never set `Header.Version` or
   `Header.PrevHash` at all (always zero), so every hashed header was
   structurally invalid regardless of whether `SetNewPrevHash` existed.
   Also fixed in the same pass: `updateWork` mined against the *network*
   target (`TargetFromNBits(job.NBits)`) while the pool-assigned share
   target from `OpenMiningChannelSuccess`/`SetTarget` was decoded and
   discarded — expected share rate was effectively zero — and submitted
   shares carried a hardcoded `NVersion` regardless of what was actually
   hashed. `docs/SPECIFICATION.md`/`docs/KNOWN_LIMITATIONS.md` should be
   checked for matching entries to update in a documentation follow-up.
10. ✅ **Protocol-version negotiation logging** (session 98). `runSession`
    logs `"engine: transport protocol: stratum-v1|stratum-v2|..."` at
    session start so operators can confirm which transport was negotiated.

---

## Category 3 — Non-custodial crypto wallets

1. ✅ **BIP-39 complete 2048-word list, SHA-256 verified** (session 32).
2. ✅ **Encrypted seed at rest** (scrypt + AES-GCM, seedstore.go).
3. ✅ **Receive-only by design** — never holds spending keys for others.
4. 🔵 **BOLT12 offers for payouts** — ADR-007 B1.
5. ✅ **BIP-39 passphrase (25th word) support** (session 230) — verification
   found `MnemonicToSeed` already accepted an optional passphrase, but the
   only caller (`createNew`) hardcoded `""`: the capability existed but was
   unreachable. Added `lightning.WithMnemonicPassphrase` (a functional
   option on `NewWalletManager`, so none of the ~35 existing call sites
   needed to change) and wired `--wallet-mnemonic-passphrase` /
   `OTEDAMA_WALLET_MNEMONIC_PASSPHRASE` through `engine.Options` down to it.
   Distinct secret from the at-rest encryption passphrase; only consulted
   at first-run creation, since the derived seed (not the mnemonic) is what
   `wallet.dat` stores.
6. ✅ **Wallet fingerprint display for verification** (session 110) —
   `doctor` now checks `wallet.dat` existence and reads `wallet.fingerprint`
   to show `initialized, fingerprint: <8-hex>` so operators can cross-verify
   against a hardware wallet. Warns when no wallet is initialized.
7. 🔵 **PSBT export for hardware-wallet payout addresses** — ADR-007 B10.
8. ✅ **Seed backup reminder / verification flow** on first run (ask the user
   to re-enter N words) — reduces fund-loss from un-backed-up seeds.
   Implemented (session 263): after printing the phrase, `confirmSeedBackup`
   prompts for three random word positions, re-prints + retries once on a
   mismatch, warns and continues on a second failure; runs only on an
   interactive terminal (ioctl TIOCGWINSZ / GetConsoleMode gate — no dep).
9. 🔵 **Output descriptor / xpub import** so payouts go to a watch-only
   wallet the user controls.
10. ✅ **Address-type validation breadth** — bech32m (P2TR) is accepted, not
    just bech32 (P2WPKH). — session 102: `btccrypto.ClassifyAddress()` maps an
    address string to its AddressType (bc1p→P2TR, bc1q→P2WPKH/P2WSH by length,
    1→P2PKH, 3→P2SH), and `doctor` surfaces the detected type in its
    Bitcoin-address check so operators can confirm a Taproot payout address
    is understood. The existing `SchemeForAddressType` dispatch is now
    reachable from a raw address.
11. ✅ **Payout-scheme awareness (FPPS / PPLNS / TIDES)** (session 111) —
    `PoolConfig.PayoutScheme` field (YAML: `payout_scheme`) and
    `checkPayoutScheme` doctor check surface per-pool variance/custody
    trade-offs; `Validate()` rejects unknown values.
12. ✅ **Effective-yield accounting > fee rate.** The comparisons stress
    *"reliability dwarfs fee differences"* — a 4% uptime gap can cost ~4× a
    1% fee gap. First piece shipped (session 48):
    `otedama_share_acceptance_rate` = accepted/(accepted+rejected), logged
    and warned-on below 97%, since every rejected share is unpaid work.
    Second piece shipped (session 231): `otedama_effective_yield_sats_per_second`
    = `otedama_arbitration_expected_yield_sats_per_second` × lifetime
    productive fraction (`productive_seconds_total / uptime_seconds`) — a
    single gauge folding downtime/stall time into the yield estimate, so a
    device quoted at X sats/s that only hashes half the time reads as X/2
    here rather than requiring every operator to write the same PromQL
    multiplication themselves.

---

## Category 4 — P2P / pool decentralisation

1. 🔵 **SV2 Job Declarator Client** — ADR-009, triggered by the May 2026 SV2
   working-group expansion (~70% hashrate).
2. 🔵 **Solo mining against a local bitcoind** — ADR-009.
3. 🔵 **OCEAN DATUM integration** (C→Go port) — ADR-009.
4. ✅ **Non-aggregating stance** — Otedama never pools others' hashrate
   (ADR-001), a deliberate decentralisation choice.
5. ✅ **Stratum endpoint diversity check** in `doctor` — warn if all
   configured pools resolve to the same operator/ASN (centralisation risk).
   — session 103: `checkPoolEndpointDiversity` resolves each configured pool
   and WARNs when two or more share a resolved IP (failover is illusory). A
   full IP→ASN check needs an external dataset Otedama does not bundle;
   shared-IP detection is the dependency-free signal that catches the common
   misconfig (two hostnames that are CNAMEs/round-robin for the same node).
6. 🔵 **TemplateSource abstraction** — ADR-009 lets a URL scheme select
   pool/JDC/solo template provenance.
7. 🟡 **Pool-share-of-hashrate awareness** — optionally inform the user when
   their chosen pool exceeds a large network share, nudging decentralisation.
8. ❌ **Running a pool server** — explicitly out of scope (ADR-001).
9. ✅ **Block-template freshness metric** (session 93):
   `otedama_last_job_received_seconds` (Unix timestamp of last
   `mining.notify`); alert `time() - metric > 120` to detect stale
   connections that look connected but deliver no work.
   — **Alert + watchdog completed (session 267):** `OtedamaPoolSilent`
   alert added to DEPLOYMENT.md and an in-engine warn fires at the same
   120 s threshold (`jobWatchdogWarnAfter`) with a recovery log, so the
   zombie-session failure is visible without Prometheus too.
10. 🔵 **Stratum V2 header-only / coinbase negotiation** for censorship
    resistance — part of the JDC story (ADR-009).

---

## Category 5 — AI inference / compute markets

1. 🟡 **Real Akash REST integration** — currently simulated
   (KNOWN_LIMITATIONS §1). The single biggest placeholder.
2. 🔵 **Strategic bidding on Akash** — ADR-010 A4.
3. ✅ **Provider health/heartbeat** — detect a dead inference provider and
   stop routing GPUs to it (parallels HashrateMonitor for mining).
   **Done:** `runArbitrationLoop` expires any stream with no quote for
   `streamStaleTimeout` (3 min) via `pruneStaleStreams`, logs the expiry,
   and `otedama_arbitration_streams` drops accordingly — a dead provider
   can no longer keep a routing slot on a stale quote.
4. 🟡 **GPU suitability scoring per workload** (VRAM, FP16/INT8 throughput)
   so inference jobs map to capable GPUs only.
5. 🔵 **Per-device suitability assignment** — ADR-010 A3 (Hungarian).
6. ✅ **Spot-price volatility guard** — hysteresis exists in arbitration and
   now has a user-configurable knob: `arbitration_hysteresis_pct` (YAML) /
   `OTEDAMA_ARBITRATION_HYSTERESIS_PCT` (env), default 0.05 (5%). Applies
   to all workload switches (mining ↔ AI). Validation rejects values outside
   [0.0, 1.0). (session 108)
7. 🔵 **Sharpe-ratio preference** to favour stable yield — ADR-010 A5.
8. ✅ **Inference revenue is denominated/settled correctly** — verified
   (session 267): USD→BTC conversion is `provider.SatsPerSecond` —
   `(usdPerHour / btcUSDRate) * 1e8 / 3600`, unit-checked; the simulated
   Akash provider is named "...(simulated)" everywhere it appears, and
   its estimate feeds only the explicitly-labelled "est. earned ~N sats"
   TUI figure (KNOWN_LIMITATIONS §9) — real earnings accounting books
   only pool-verified share accepts, so simulated vs real yield is never
   mixed.
9. 🔵 **Akash bid/lease lifecycle management** (deposit, close) — ADR-010 A4.
10. ❌ **Custodial escrow of inference earnings** — out (non-custodial).

---

## Category 6 — Resource arbitration / online optimisation

arXiv grounding (collected sessions 40–41 and here):

1. ✅ **Change-point / regime detection** — ADR-010 A8 (Mellor & Shapiro
   Bayesian online change detection).
2. ✅ **Adversarial robustness** — ADR-010 A7 (Lykouris-Mirrokni STOC 2018).
3. 🔵 **Side-constraint MAB for power budget** — Burnetas et al.
   (arXiv:1811.12852); grounding added to ADR-010 A3.
4. 🔵 **Combinatorial-MAB logarithmic-regret budget allocation** — Zuo &
   Joe-Wong (arXiv:2105.04373); CUCB-DRA treats "allocate budget a to
   resource k" as a base arm and needs no closed-form reward model.
5. 🟡 **Markovian-reward matching** — Tekin & Liu (arXiv:1012.3005) prove
   near-logarithmic regret for bipartite user↔resource matching with
   Markov state; directly models device↔stream assignment when yields are
   autocorrelated. New grounding for A3's dynamics.
6. 🟡 **Bi-criteria bandit (reward + constraint violation)** — arXiv:2503.12285
   transforms offline bi-criteria approximations into online CMAB with
   sublinear regret *and* sublinear constraint violation; the right frame
   if Otedama ever optimises yield subject to a hard power cap.
7. 🔵 **Holt-Winters short-horizon forecaster** — ADR-010 A1 (chosen over ML).
8. 🔵 **Switching-cost ledger** — ADR-010 A2 (don't churn for tiny gains).
9. 🔵 **Beta-Bernoulli calibration** — ADR-010 A6.
10. 🟡 **Federated/multi-agent extension** — arXiv:2405.05950 (if multiple
    Otedama nodes ever cooperate); noted as out-of-scope-for-now but
    catalogued.
11. ✅ **Arbitration Reason string matches Held flag in all cases** (session 174).
    Socratic probe found a misleading diagnostic: when the incumbent stream was
    already the best option (no challenger beats it), the engine returned
    `Held: false` but `Reason: "held (best gain 0.00% ..."`. An operator tuning
    hysteresis via logs would see a held-looking message on an assignment where
    nothing was declined. Fixed in `engine.go:chooseForDevice`: now two distinct
    reason strings — `"incumbent is best; stayed"` when Held=false, and the
    existing `"held (best gain X% below hysteresis Y%)"` when Held=true. Added
    4 new tests: Reason/Held consistency for both cases, direct `PolicyEnvironmentFriendly`
    coverage (previously only in random property tests), and zero-hysteresis exact
    tie behaviour.

---

## Category 7 — Go CLI / systems tools

1. ✅ **Subcommand structure** (run/version/config/service/doctor) with
   per-command `--help`; all 11 covered by tests.
2. ✅ **Background-service install** (launchd/systemd/Task Scheduler).
3. ✅ **Structured logging** (text/JSON via slog-style adapter).
4. ✅ **`doctor` self-diagnostics**.
5. ✅ **`--version --json` machine-readable output** for CI/monitoring —
   `version.go` implements `-json` flag emitting `{"version":...}` JSON.
6. ✅ **Shell completion generation** (`otedama completion bash|zsh|fish`) —
   `completion.go` implements bash/zsh/fish static completion scripts.
7. ✅ **`GODEBUG`/pprof opt-in endpoint** behind a flag for field debugging
   (already have an HTTP server; could mount `/debug/pprof`). — session 99: `--pprof`
   flag mounts `/debug/pprof/` and named profiles; explicit handler registration
   (not blank import on DefaultServeMux); loopback/private-IP safety note in docs.
8. ✅ **Config precedence documentation** (flags > env > file > defaults) and
   `otedama config show --origin`. — session 104: `ResolveWithOrigins` tracks
   a `ValueOrigin` (default/file/env/flag) per Config field. `config show
   --origin` appends ` [layer]` to each output line so operators immediately
   see which precedence layer set each value — critical for debugging "why is
   this config wrong?"
9. ✅ **Graceful shutdown on SIGINT/SIGTERM**.
10. ✅ **Exit-code contract documented** in the package godoc and `--help`
    output for scripting. — session 105: sysexits.h codes (0=ok, 1=runtime,
    64=EX_USAGE, 78=EX_CONFIG) plus the doctor exception (0/1/2) are
    documented in the package godoc `# Exit codes` section and printed by
    `otedama help`. `TestExitCodeConstants_Values` pins the numeric values
    to prevent silent breakage.
11. ✅ **Deduplicate the two `Provider` implementations** — done: the shared
    core described here already exists as `pollingProvider` in
    `internal/provider/polling.go` (embedded by MiningProvider and
    AkashProvider; shared Stop/launch/loop/send, per-provider publish). (maintainability;
    recorded per CLAUDE.md rule I3 — "log duplication as an issue, don't fix
    ad hoc"). `MiningProvider` and `AkashProvider`
    (`internal/provider/{mining,ai_inference}.go`) share substantial
    boilerplate — **all preserved**: `quoteCh` re-creation in `Stop()`
    (restartable providers), buffered drop-oldest sends, distinct tick
    intervals (30s mining / 60s AI) and device filters (SHA-256d vs
    GeneralCompute). (Marker corrected session 265 — the ⬜ was stale.)
12. ✅ **`TestRunSession_StatsTickAndShareResponses` flakiness under heavy
    CPU contention — resolved** (`internal/engine/run_test.go`; found
    session 239, fixed session 242). It used to assert a "submit latency"
    log line appeared within a fixed real-time window, which required the
    session loop's 5ms stats ticker to win a `select` slot against two
    channels (`inCh`/`opts.merged`) that are effectively always ready
    while the test's fake pool streams shares continuously — under
    `go test ./...`'s full parallel load the ticker case could be
    intermittently starved long enough to miss even a doubled (2s→4s)
    window. Confirmed pre-existing (same fragile structure at commit
    `2faae1f`, before session 239). The thorough fix flagged at the time
    — decouple the assertion from ticker-selection fairness entirely —
    is now implemented: `runSession` runs in a goroutine while the test
    actively polls the deterministic `submitLatencyP95` gauge (rather
    than a specific log line) every 5ms up to a generous 10s ceiling,
    cancelling the session as soon as the condition is observed rather
    than waiting a fixed duration and hoping. Net effect: the test now
    resolves in ~20ms in the unstarved case (down from a fixed 4-6.9s
    every run) and held clean across multiple full-suite runs plus
    `go test -race` where the log-line version had intermittently failed.

---

## Category 8 — Power optimisation / energy

arXiv grounding (session 41):

1. 🔵 **DVFS profit curve sampling** — ADR-008 sub-domain 3.
2. 🔵 **Horizon-aware (Pontryagin) scheduling** — Ginzburg-Ganz et al.
   (arXiv:2411.11119); the optimal-control upgrade of the myopic optimiser.
3. 🔵 **Surplus-only solar mining** — Choi et al. (arXiv:2505.00303);
   economics validated, S21 XP Hyd (12 J/TH) baseline.
4. 🔵 **TOU tariff feeds** (Octopus Agile/Tibber/Amber) — ADR-008 sub-domain 4.
5. 🔵 **Demand-response participation** — ADR-008 sub-domain 5.
6. 🔵 **Thermal/ambient awareness** — ADR-008 sub-domain 6.
7. 🔵 **Battery/Powerwall integration** — ADR-008 sub-domain 7.
8. ✅ **J/TH efficiency metric in metrics** (session 113) — `power_watts`
   config field (YAML/env); `otedama_joules_per_terahash` = watts × 1e12 /
   hashrate; `otedama_power_watts` gauge; updated in both V1 and V2 stat ticks.
9. ✅ **Idle/curtailment hook** (session 112) — `curtail_below_btc_usd` config
   field; BTC rate goroutine calls `SetWork(nil)` when price drops below
   threshold and logs re-start on recovery; `otedama_curtailed` gauge.
10. 🟡 **Carbon-intensity feed (optional)** — for users who want to mine on
    low-carbon grid windows; aligns with SUSTAINABILITY.md.

---

## Category 9 — Observability / monitoring

1. ✅ **Prometheus text-format `/metrics`** without a client dependency
   (ADR-005).
2. ✅ **Health endpoint** + `ServeError()` accessor (session 31).
3. 🟡 **OpenTelemetry traces** for the connect→handshake→mine span — ADR
   mentions OTel; confirm spans exist on pool dial and submit.
4. ✅ **Reject-rate & stale-rate gauges** (ties to Category 1). — session 101:
   `otedama_reject_rate` (rejected/judged) and `otedama_stale_rate`
   (stale-rejected/judged) gauges, recomputed each stats tick via
   `updateShareRates()`. Lets operators alert on the D-Central thresholds
   (<0.5% excellent … >3% act-now) without PromQL arithmetic.
5. ✅ **Submit-latency quantiles** (session 46) — see Category 2 item 7.
6. ✅ **`otedama_up` / readiness reflecting HashrateMonitor.Stalled()**
   (sessions 43/93). `otedama_up=0` when stalled; TUI also shows ⚠ stalled
   badge (session 96).
7. ✅ **Pool-connection state gauges** (sessions 91–93):
   `otedama_pool_connection_state` (0/1/2), `otedama_pool_active_index`,
   `otedama_payout_active_index`.
8. ✅ **Structured JSON logs** with level filtering.
9. ✅ **Build-info metric** (session 93): `otedama_build_info{version,commit,
   goversion}` — standard Prometheus `_info` convention for fleet tracking.
10. ✅ **SLO documentation** (target uptime, p99 submit latency) —
    **Done (session 262):** `docs/DEPLOYMENT.md` gained a
    "Service-level objectives" table (productive uptime ≥99.5 %/30 d,
    pool connectivity ≥99 %, acceptance ≥99.5 %, stale <0.5 %,
    p99 submit latency <500 ms, pending/unaccounted baselines) with
    act-now thresholds tied to the D-Central operator bands.

---

## Category 10 — Cryptography / security

1. 🟡 **Replace the P-256 Noise stub with real secp256k1 — and rework the
   message flow, not just the DH primitive.** Confirmed canonical library:
   `github.com/decred/dcrd/dcrec/secp256k1/v4` — pure Go, ISC (copyfree)
   licence, imported-by 150+, provides ECDH and Schnorr. This is the
   concrete unblocker for KNOWN_LIMITATIONS §2. **Tension with ADR-003
   (zero runtime deps):** ISC is permissive and the package is pure Go
   with no transitive deps, so vendoring it is consistent with the spirit
   of ADR-003 — but the decision should be recorded in a new ADR.
   — **Session 239 correction:** this item's own title previously implied
   a DH-primitive swap was the only remaining work, matching
   KNOWN_LIMITATIONS §2's prior ("message flow is final") claim — both
   were wrong. Reading `internal/stratum/noise.go` found the message flow
   itself has two structural gaps beyond the DH primitive: `ReadMessage2`'s
   "x-only" fallback branch completes the handshake with no
   Diffie-Hellman at all (transport keys derive from public data alone,
   so an on-path observer can compute them), and no code anywhere
   authenticates a responder static key — the defining property "NX"
   names. `mixKey`'s HKDF output is also computed and discarded (`_ = k`).
   Separately, and more urgently for user-facing risk: `internal/engine`'s
   live connect path (`runSession`) never called `NewHandshakeInitiator`/
   `EncryptedConn` at all — every `stratum+v2://` connection ran fully
   plaintext regardless of this stub's state, which this item's framing
   ("replace the DH stub") did not surface. **Fixed in the same session**:
   `stratum+v2tls://` (previously registered but silently downgraded to
   plaintext — the same bug class CHANGELOG session 126 fixed for V1's
   `stratum+tls://`) now performs real TLS via `internal/stratum/tls.go` — not
   spec-compliant Noise, but genuine confidentiality using only
   `crypto/tls`, available today without the secp256k1 dependency
   decision. This item (secp256k1 + message-flow rework) remains open for
   spec-compliant Stratum V2 Noise encryption specifically.
2. 🔵 **ElligatorSwift encoding** for the SV2 handshake (pairs with item 1).
3. ✅ **scrypt + AES-GCM seed encryption at rest**.
4. ✅ **gitleaks in CI** (per CLAUDE.md I4).
5. ✅ **Traffic-analysis side channel documented** in THREAT_MODEL
   (arXiv:1703.06545, session 40).
6. 🟡 **Traffic shaping / "mining cookie"** to blunt the timing side channel —
   the paper's own countermeasure; future hardening.
7. 🔵 **Tor-by-default transport** — ADR-007 B7, also mitigates item 6.
8. 🔵 **Post-quantum scheme scaffolding** (ML-DSA/SPHINCS+) — ADR-006,
   conditional on BIP-360.
9. ✅ **Constant-time comparison audit** for secret/MAC comparisons in the
   handshake and seed paths — **audited (session 262), nothing to fix:**
   no in-repo secret comparisons exist. Seed unlock flows rely on
   AES-GCM `Open` whose tag verification is constant-time inside
   `crypto/`; the Noise handshake compares no MAC/tag of its own
   (AEAD verify is likewise stdlib). `crypto/subtle` has zero call
   sites because there is nothing to wrap — re-audit when the
   secp256k1 NX flow lands (item 1), which introduces real MAC
   comparisons.
10. 🟡 **Supply-chain: pin and verify the one new crypto dep** (item 1) with a
    checksum and `go.sum`, and document it in THREAT_MODEL's dependency
    assumptions.

---

## Category 11 — Lightning payout routing & economics

Sources: Pickhardt & Richter (arXiv:2107.05322), LN autonomy/liquidity
(arXiv:2506.19333), pathfinding analysis (arXiv:2410.13784), 2026 pool
comparisons (D-Central, Coin Bureau, Solo Satoshi).

1. ✅ **Receive-only, non-custodial Lightning** — funds never held for others
   (ADR-007); aligns with the TIDES/OCEAN sovereignty stance the 2026
   comparisons single out.
2. 🔵 **BOLT12 reusable offers** — ADR-007 B1.
3. 🟡 **Low Lightning payout-threshold awareness.** OCEAN's 0.00001 BTC LN
   minimum makes frequent small withdrawals viable; surfacing the pool's
   minimum payout in `doctor` helps users avoid "trapped" small balances.
4. 🔵 **External-node control (Phoenixd/CLN/lnd/Alby)** — ADR-007 B3.
5. 🔵 **Embedded LDK Node sidecar (opt-in)** — ADR-007 B4.
6. 🟡 **Min-cost-flow path selection** *if Otedama ever sends*: Pickhardt &
   Richter (arXiv:2107.05322) show optimally-reliable-and-cheap multi-part
   payments are a separable-convex min-cost-flow problem — superior to naive
   shortest-fee-path. Catalogue only; sending is out of alpha scope.
7. 🟡 **Liquidity-centralisation awareness.** arXiv:2506.19333 shows LN
   liquidity consolidates into dominant hubs under pure cost minimisation; a
   future routing layer should resist defaulting to the same hubs, echoing
   the mining-pool decentralisation stance (ADR-001).
8. 🔵 **Boltz reverse-swap** for trustless LN→on-chain — ADR-007 B6.
9. 🔵 **Tor-by-default** for LN/pool connections — ADR-007 B7 (also mitigates
   the Category 10 timing side channel).
10. 🟡 **SCB / static-channel-backup reminders** if an embedded node lands —
    fund-loss prevention, parallels the seed-backup reminder (Cat 3 #8).

---

## June 2026 research pass (session 51) — new findings

A fresh sweep of comparable software (SRI / stratum-mining, ESP-Miner,
Akash, Vast.ai, sigstore/OpenSSF, prometheus/client_golang) and arXiv
(2024–2026), cross-checked so nothing below duplicates the categories
above. Every arXiv ID was verified against the arXiv listing; every API
endpoint against current vendor documentation. Tags as before
(✅/🔵/🟡/❌).

### Category 1/2 — mining client & Stratum correctness (from SRI v1.5.0 + ESP-Miner)

1. 🟡 **Validate the SV2 server certificate, not just the Noise DH.** The
   SV2 security spec delivers a signed certificate (`valid_from`,
   `not_valid_after`, `server_public_key`, BIP340 Schnorr sig over the
   fields); the initiator MUST verify the signature against a known
   authority key *and* check expiry — that is the actual MITM defence,
   distinct from the handshake DH. When `noise.go` moves to secp256k1
   (ADR-011) add `VerifyServerCert(cert, authorityPubKey, clock.Now())`
   and a per-pool `authority_pubkey` config field.
   (sv2-spec 04-Protocol-Security.md)
   — **Design update (session 256):** ESP-Miner v2.15.0 shipped the same
   feature as a *per-pool opt-in* "require authentication" flag (#1796) —
   model Otedama's the same way: `authority_pubkey` set ⇒ verify and fail
   closed; unset ⇒ warn once. See session-256 increment item 6.
2. 🟡 **Clamp the channel target to `max_target` on every vardiff update.**
   SRI v1.5.0 fixed a real bug where low-hashrate miners got "stuck"
   because vardiff produced a target *easier* than the channel's declared
   `max_target`. In the V2 channel/job path clamp the effective target into
   `[min, max_target]` at channel open and on each `SetTarget`; add a
   boundary test. (stratum-mining/stratum release v1.5.0)
   — ✅ **`SetTarget` prerequisite implemented** (session 238; the msg_type
   noted here was also wrong — the real SV2 value is `0x21`, not `0x1d`).
   `internal/stratum/messages.go` now decodes `SetTarget{ChannelID,
   MaxTarget}`; the engine's session loop updates the live share target
   and re-issues the active job so workers compare against it immediately.
   The clamp-to-`[min, max_target]` behavior this item originally asked
   for is not yet implemented — Otedama accepts whatever target the pool
   sends outright, since `OpenMiningChannel`'s `max_target` preference
   field is intentionally not sent (see the dead-field note removed from
   `OpenMiningChannel` in `internal/stratum/handshake.go`) — but the
   message is no longer silently unrecognised, which was the blocking gap.
3. ❌ **Strip BIP141 (segwit) fields from the coinbase on Extended Jobs.**
   Also fixed in SRI v1.5.0: a client assembling the coinbase from
   `coinbase_tx_prefix`/`suffix` must hash the *non-witness* serialization
   or every share is rejected on a wrong merkle root. Add a segwit-coinbase
   regression fixture to the path feeding `engine.applyJob`.
   (stratum-mining/stratum v1.5.0)
   — **Not applicable (session 256):** verified Otedama never assembles a
   coinbase. Standard channels deliver `NewMiningJob.MerkleRoot` (a pool-
   computed [32]byte) straight into `miner.Work.Header.MerkleRoot`
   (`internal/stratum/messages.go`, `engine.updateWork`); Extended Jobs /
   JDP coinbase assembly is a template-consumer concern Otedama doesn't
   implement. There is no witness-serialization path to get wrong — adding
   a fixture would test a nonexistent code path.
4. ✅ **Don't count post-`set_difficulty` "above-target" rejects.** ESP-Miner
   #212: after difficulty drops, in-flight shares against the old (harder)
   target are rejected as "above target". Tag outstanding work with the
   difficulty active when issued, validate locally against that, and treat
   the resulting pool rejects as benign (exclude from the reject-rate
   metric). Distinct cause from the existing stale/latency `rejectClass`.
   (bitaxeorg/ESP-Miner #212)
   — **Prerequisite fixed (session 226):** investigating this item surfaced a
   more fundamental bug it presupposes — the V1 path (`applyJob`) was not
   applying `mining.set_difficulty` to the mining target *at all*; every
   worker ground to the full nBits block target regardless of the pool's
   assigned share difficulty. Fixed via `miner.TargetFromDifficulty` (accepts
   fractional difficulty, e.g. 0.001) and `engine.v1JobTarget`. Without this,
   a V1-connected worker essentially never produced a submittable share.
   The transition-handling nuance this item actually asks for (tagging
   in-flight work with the difficulty active when issued, so a mid-flight
   difficulty *increase* doesn't misclassify a still-valid old-target share
   as a reject) remains open — the target now updates correctly on every new
   job, but shares in flight when `set_difficulty` changes are not yet
   re-validated against the difficulty active at issue time.
   — **Done (session 255):** `miner.Share` now carries `Target` (the
   issue-time `Work.Target`, not on the wire). On a `difficulty`-class
   reject, `benignTransitionReject` checks `hash ≤ share.Target` AND
   `hash > current target` — i.e. valid when produced, invalid only
   after the raise — and routes it to
   `otedama_shares_rejected_by_reason_total{reason="difficulty_transition"}`
   at info level instead of `sharesRejected`. V1 correlates via the
   captured share + `sess.SuggestedDifficulty()`; V2 via
   `SubmitSharesError.SequenceNumber` → a new `submitShares` map.
   Deliberately strict: a share meeting the current target but still
   rejected stays a *real* reject (pool mislabel or bug worth seeing).
5. ✅ **Handle `client.show_message` and unknown V1 notifications gracefully.**
   ESP-Miner added explicit `client.show_message` handling (pools send
   operator notices this way); an unhandled method can desync a strict
   JSON-RPC reader. Log-and-surface it, and skip unknown notifications
   rather than erroring the session. Complements Cat 1 #3.
   (bitaxeorg/ESP-Miner releases)
   — `client.reconnect` / `mining.reconnect` handled (session 64).
   — session 106: `client.show_message` now surfaced via
   `session.PoolNotices() <-chan string` (implements `poolproto.PoolNoticeReceiver`).
   Messages are queued on a buffered channel (cap 8); a full channel drops the
   oldest notice rather than blocking the read loop. Unknown notifications
   (e.g. `mining.set_version_mask`) remain silently ignored. `parseShowMessage`
   is the pure decode function.
6. ✅ **Saturate/reset hashrate counters on reconnect.** ESP-Miner shipped a
   fix for hashrate-counter overflow on reconnect; garbage readings would
   poison `HashrateMonitor` and the arbitration yield estimate. Reset
   windowed counters on reconnect, use saturating `uint64` accumulators,
   and test that a reconnect produces no spurious spike or NaN J/TH.
   (bitaxeorg/ESP-Miner releases)
   — **Implemented (session 65):** `hashrateWindow` differentiates the
   cumulative hash counter into a *current* windowed rate (the monitor, gauge,
   log, and TUI all consume it), which also fixed a latent bug where the
   lifetime-average rate could never reach the stall floor. Saturating on
   counter reset — no negative/NaN/spurious-spike readings. See SPECIFICATION.md
   G14.
7. ✅ **Pin protocol truth to `stratum-mining/sv2-spec`, not the app code.**
   SRI split roles into a separate, independently-versioned repo after
   v1.5.0; update the SV2 reference links in ADR-009 / poolproto comments
   to cite the (stable) spec so the codec tracks the spec, not moving code.
   — **Done (session 256):** ADR-009 References now cite
   `github.com/stratum-mining/sv2-spec` as the source of truth (the
   stratumprotocol.org links are its rendered form). Audited existing
   citations: `internal/stratum/frame.go` already cites spec ch.3 as
   primary (SRI only for test vectors), ADR-011 cites
   `04-Protocol-Security.md` directly — no app-code-derived protocol
   facts remained.

### Category 4 — decentralisation (arXiv grounding)

8. ✅ **Single-pool concentration enables *undetectable* attacks.** Bahrani &
   Weinberg, "Undetectable Selfish Mining" (arXiv:2309.06847), prove a
   selfish-mining strategy whose orphan pattern is statistically
   indistinguishable from honest mining, profitable from 38.2% hashrate.
   Document in THREAT_MODEL to justify the multi-pool / endpoint-diversity
   defaults as a *security* (not merely liveness) property; strengthens
   Cat 4 #7.
   — **Done (session 256):** added as a Tampering-section threat in
   THREAT_MODEL (pool-side withholding; mitigation = failover diversity +
   `shares_unaccounted`/`shares_pending` reconciliation signals;
   residual = detection stays statistical until auditable PoW lands).
9. 🟡 **Orphan-aware reconciliation has a fairness rationale.** Grunspan &
   Pérez-Marco, "Block withholding resilience" (arXiv:2211.07270, rev.
   Feb 2025), show accounting for orphans makes honest mining the unique
   optimum. Otedama can't change the DAA, but `doctor` can track
   pool-acknowledged shares vs. pool-credited blocks over a window and warn
   on divergence — grounds Cat 1 #10.
10. 🔵 **Auditable PoW for verifiable share attribution (v4.0+).** Lerner,
    "APoW: Auditable Proof-of-Work Against Block Withholding" (arXiv:
    2601.02496), constructs PoW letting pool participants retroactively
    audit each other's effort with no TTP. Catalogue as a research pointer
    for any future "verifiable share" work; fits the non-aggregating ethos
    (ADR-001).

### Category 5 — replacing the simulated Akash provider

11. 🟡 **Concrete Akash integration surface.** Akash exposes a provider REST
    gateway (`/status`, `/version`, manifest POST on lease-won) and a gRPC
    `akash.provider.v1.ProviderRPC.GetStatus` (per-node GPU model + status,
    allocatable vs allocated), plus SDK `createLease(bidId)` /
    `getLeases(owner,state)`. This is the unblocker for Cat 5 #1 /
    KNOWN_LIMITATIONS §1: poll `GetStatus` for real GPU availability + live
    lease count (feeds A6 reliability and Cat 5 #3 heartbeat), confirm a
    routed GPU is actually leased before counting its yield, and gate
    accounting (Cat 5 #8) on real lease state. gRPC adds a dependency —
    weigh against ADR-003; the REST `/status` path may suffice read-only.
12. 🟡 **Vast.ai as a second, simpler real compute backend.** Vast has a
    documented Bearer-token REST API with a *direct-bid* market (`bid_price`
    $/hr; highest bid runs, lower bids pause). Far less code than Akash gRPC
    and a cleaner live testbed for ADR-010 A4 strategic bidding (real
    preemption). A `VastProvider` behind the existing `provider` interface
    gives a non-simulated backend now. (Renting out *own* hardware — fine
    under the non-custodial stance.)
13. 🟡 **Preemption is the dominant failure mode — price it in.** Duan et al.,
    "GFS" (arXiv:2509.11134, ASPLOS '26), forecast GPU demand and keep a
    reserve quota to cut eviction 33%. A preemption-risk term should raise a
    provider's *effective* switch cost in the A2 ledger so the engine
    doesn't churn a GPU onto a stream it loses in minutes. Pairs with #14
    and Cat 5 #6.

### Category 6 — arbitration / online optimisation (arXiv grounding)

14. 🟡 **Randomized deadline-aware spot policy with √K competitive ratio.**
    "ROSS" (arXiv:2601.14612) proves deterministic deadline policies are
    stuck at Ω(K) (K = reliable/spot cost ratio) while a randomized reserve
    rule achieves √K (~30% savings). The competitive-analysis counterpart to
    ADR-010 A1/A6; load-bearing only if deadline-constrained inference
    exists.
15. 🟡 **Adaptive, learned switching cost with sub-linear dynamic regret.**
    "SCaLE" (arXiv:2601.09042) handles ℓ2 switching costs under noisy bandit
    feedback with no known cost structure. Justifies making ADR-010 A2's
    switch-cost ledger *learned / non-stationary* rather than a fixed
    calibration; the regret-optimal target for A2.
16. 🟡 **Track which non-stationarity the engine self-tunes against.**
    "Non-stationary Bandit Convex Optimization" (arXiv:2506.02980, NeurIPS
    2025) gives regret bounds parameterised by switches / total-variation /
    path-length — exactly the three drift types in hashprice/Akash yield
    (difficulty steps, volatility, diurnal). Use its measures to choose the
    self-tuning signal for the Holt-Winters reset threshold (A1+A8).

### Category 8 — power: real, currently-live feeds

17. 🟡 **Octopus Agile half-hourly REST (no key for read-only rates).**
    `api.octopus.energy/v1/products/<P>/electricity-tariffs/<T>/standard-unit-rates/?period_from=…`
    concretises ADR-008 sub-domain 4; a `power/tariff/octopus.go` poller
    (~30 min) drives the Cat 8 #9 curtailment hook.
18. 🟡 **Design the tariff interface as a forward *price curve*, not a spot
    price.** Tibber (GraphQL, once-daily curve) and Amber (REST, 5-min AEMO
    forecast) cover EU-Nordic and AU. A "return the forward curve" interface
    accommodates all three and feeds the horizon-aware (Pontryagin) scheduler
    (ADR-008 #2) — plan curtailment windows ahead instead of reacting to spot.
19. 🟡 **For carbon-aware curtailment use *marginal*, not average, intensity.**
    WattTime MOER (5-min marginal emissions) is the correct signal for
    "pause to cut emissions" because curtailing changes load at the margin;
    Electricity Maps average (AOER) understates the effect. Sharpens Cat 8
    #10; keep optional (keys required) per ADR-003.

### Category 9/10 — observability & supply-chain (current real tooling)

20. 🟡 **Emit trace exemplars on the submit-latency histogram.**
    prometheus/client_golang v1.23 (Jul 2025) + OpenMetrics 1.0 allow a
    `{trace_id="…"}` exemplar on a histogram bucket so a p99 spike links to
    its trace. Otedama already has the histogram (Cat 2 #7) and OTel spans
    (Cat 9 #3); joining them is a small extension to the hand-rolled
    exposition writer (no client_golang dep — keeps ADR-003/005).
21. ✅ **Follow Prometheus naming: `_info` gauge, bounded labels, std runtime
    metrics.** `CollectFunc`/`RegisterCollector` hook added to `internal/metrics`
    registry; `RuntimeCollector()` emits 12 standard `go_*` metrics
    (`go_goroutines`, `go_info{version}`, `go_memstats_*`, `go_gc_*`) using only
    stdlib `runtime` — no new dependency (ADR-003/005 preserved). Names match
    `prometheus/client_golang` so existing Grafana dashboards work unmodified.
    `otedama_build_info` (commit/goversion labels) deferred to next session.
    (session 107)
22. 🔵 **SLSA Build L3 provenance + Sigstore keyless signing for releases.**
    `actions/attest-build-provenance` + cosign keyless (Fulcio OIDC, Rekor)
    is the current bar for a non-custodial money-handling binary users must
    verify. Add provenance + `cosign sign-blob` (GitHub OIDC, no stored
    keys) to release.yml and document `cosign verify-blob` /
    `gh attestation verify`. (sigstore/cosign, slsa.dev)
23. 🟡 **Publish an OpenSSF Scorecard workflow as a release gate.**
    `ossf/scorecard-action` checks Branch-Protection / Pinned-Dependencies /
    Signed-Releases / Token-Permissions and bundles osv-scanner; the
    Signed-Releases check rewards #22 and Pinned-Dependencies reinforces
    Cat 10 #10. (github.com/ossf/scorecard)
24. 🟡 **Make govulncheck a hard CI gate and pin a patched toolchain.** Track
    current Go advisories on the `net/http` surface Otedama exposes
    (`/healthz /readyz /metrics`) — e.g. CVE-2025-22871 (request smuggling),
    GO-2025-3563 — and fail the build on any govulncheck finding. CLAUDE.md
    already mandates the tool; the gap is the gate. Record advisory IDs in
    THREAT_MODEL's dependency assumptions.

### Category 11 — Lightning routing & privacy (arXiv grounding)

25. 🟡 **Bias path selection away from high-betweenness channels.** Abdesselam
    et al., "Payment-failure times for random Lightning paths" (arXiv:
    2511.16376, BRAINS 2025), tie time-to-failure to edge-betweenness — the
    most-traversed channels deplete first. A depletion-aware tie-breaker
    sharpens Cat 11 #6/#7 from qualitative to concrete; catalogue-only while
    receive-only.
26. 🟡 **Seed the min-cost-flow scorer with a cheap balance prior.** Davis et
    al. (arXiv:2405.12087) beat the 50/50-split prior by ~27%. The
    ADR-003-friendly takeaway is a *dependency-free heuristic* prior
    (capacity + degree + age), not the ML model — a small deterministic
    initial liquidity belief feeding Pickhardt-Richter (Cat 11 #6),
    improving first-attempt success without probing.
27. 🟡 **One countermeasure, two timing channels.** Rohrer & Tschorsch,
    "Counting Down Thunder" (arXiv:2006.12143), show HTLC-resolution timing
    leaks payment endpoints — the LN analogue of the Stratum timing leak
    already in THREAT_MODEL (1703.06545). Note that Tor-by-default (ADR-007
    B7) mitigates *both*; doc-only linkage.

---

## June 2026 research pass — session 52 increment (fresh GitHub/spec findings)

Four verified items that *update* earlier entries with newer reality.

1. ✅ **Fuzz the Noise/frame length arithmetic for overflow (SRI lesson).** SRI
   is now at v1.6.0 with roles split into `stratum-mining/sv2-apps`, and an
   early-2026 security-tooling grant (Lucas Balieiro) found — via 24/7
   fuzzing — an **arithmetic overflow in the `noise_sv2` crate**, since fixed;
   the `sv1_api` translator parser is the next fuzz target. Otedama has a
   directly analogous surface (`internal/stratum/noise.go` length math,
   `frame.go` `MsgLength`/`DefaultMaxFrameSize`, the V1 JSON-RPC reader). Add
   overflow-focused fuzz seeds to the existing `FuzzDecodeHeader` /
   `FuzzDecoder_ReadFrame` and a new fuzz target over the encrypted-frame
   length prefix; assert no `int`/`uint32` overflow or huge allocation.
   (opensats.org/projects/stratumv2; github.com/stratum-mining/sv2-apps)
   — **Done (sessions 257–258, verified 265):** `FuzzDecodeHeader`
   asserts `MsgLength ≤ MaxMessageLength` + encode/decode round-trip,
   `FuzzDecoder_ReadFrame` caps iterations + asserts payload/header
   length agreement, `FuzzEncryptedConn_Read` covers the u16-length +
   AEAD-reject surface (the arithmetic-overflow class the grant found).
   ~4.9 M exec, zero crashes.
2. 🔵 **JDC/template decentralisation just got more urgent: ~75% of hashrate
   committed to SV2 (May 2026).** Seven pools (Foundry, AntPool, F2Pool,
   SpiderPool, MARA, Block, DMND) — ~75% of network hashrate — agreed to adopt
   Stratum V2 / open block construction. Updates ADR-009's "~70%" figure and
   strengthens the case for the Job Declaration Client (miner-built templates)
   as the headline v3.x feature. (coindesk.com 2026-05-11)
3. 🟡 **Real Akash provider API now requires JWT auth (AEP-64, Mainnet 14).**
   Akash Mainnet 14 (2025-10-28) shipped **AEP-64 JWT Authentication for
   Providers** — token-based auth on the provider APIs. The real
   `AkashProvider` (session 51 #11 / KNOWN_LIMITATIONS §1) must therefore mint
   and attach a JWT to provider `GetStatus`/lease calls, not just hit an open
   REST endpoint. Fold JWT acquisition into the provider client design.
   (messari.io State of Akash Q3 2025; akash.network/docs)
4. 🟡 **Offer an optional FIPS 140-3 mode and document the PQ key exchange
   already negotiated.** Go 1.24+ ships a FIPS 140-3-validated crypto module
   enabled with `GODEBUG=fips140=on` (or the go.mod godebug), and the
   X25519MLKEM768 hybrid PQ key exchange Otedama already turns on via
   `tlsmlkem=1` is part of that validated module. Low-effort, high-trust wins
   for a money-handling binary: (a) document that outbound TLS uses hybrid
   post-quantum key exchange; (b) provide a `fips140=on` build/runtime profile
   for regulated operators; (c) note both in THREAT_MODEL. Pairs with the
   existing godebug block (`GODEBUG_NOTES.md`). (go.dev/blog/fips140)

---

## July 2026 research pass — session 251 increment (ecosystem re-verification)

Three parallel research agents re-checked the mining, AI-compute, and
Go/security/Lightning ecosystems against 2025–2026 primary sources. Every
item below is tagged **[FETCHED]** (the cited URL was actually retrieved and
read) or **[SNIPPET]** (real indexed URL, but only the search summary was
available — the source page returned HTTP 403 to the fetcher, so treat as a
lead to re-verify, NOT as established fact). This split is deliberate:
CLAUDE.md forbids recording unverified URLs/claims as fact, and a fabricated
`https://otedama.io` URL was found and removed from this repo earlier this
month, so the discipline matters.

### Dependency & toolchain hygiene

1. ✅ **[FETCHED] `gopkg.in/yaml.v3` is archived/unmaintained since 2025-04-01.**
   The `go-yaml/yaml` source repo was archived by its author; the YAML org
   took over at import path `go.yaml.in/yaml`, where v3 is frozen to
   security-fixes-only and active work is in v4. This makes the dependency
   fail CLAUDE.md's own §外部依存 criterion 3 ("meaningful maintenance within
   the last year"), and dates ADR-003's "maintained by go-yaml project,
   stable since 2020" rationale. No CVE against v3.0.1 was found — the issue
   is maintenance status, not an active vuln. **Action:** plan migration to
   `go.yaml.in/yaml/v3` (near drop-in, YAML-org maintained) and correct
   ADR-003. (github.com/go-yaml/yaml; pkg.go.dev/go.yaml.in/yaml/v4)
   — **Done (session 255):** migrated to `go.yaml.in/yaml/v3 v3.0.5` —
   true drop-in (`NewDecoder`/`KnownFields`/`NewEncoder` unchanged), so
   only the two import lines moved. ADR-003 erratum resolved in place;
   AUDIT_CHECKLIST/THREAT_MODEL/MIGRATING-FROM-V2 dep lists updated.
   Stayed on v3 (frozen, security-only) rather than v4 (active dev):
   v3 is the minimal-diff step and satisfies criterion 3 via the YAML
   org's security maintenance.
2. ✅ **[FETCHED] `golang.org/x/crypto` v0.23.0 was ~31 minor versions behind;
   CVEs since are all unreachable here.**
   GO-2025-3487 / CVE-2025-22869 and the May-2026 batch (CVE-2026-39827…39835)
   are all in the `ssh`/`openpgp` subpackages; Otedama imports only
   `chacha20poly1305`, `scrypt`, and `ecdh`, so `govulncheck` should report
   zero reachable vulnerabilities even at v0.23.0. **Action:** bump to v0.54.0
   as routine hygiene and re-run govulncheck to document the zero-reachable
   result. (pkg.go.dev/golang.org/x/crypto?tab=versions; pkg.go.dev/vuln/GO-2025-3487)
   — **Done (session 255):** bumped to **v0.55.0** (the newest version
   compatible with `go 1.25`; v0.56+/v0.57 require go 1.26). Pulled
   `x/sys` v0.20.0 → v0.47.0 transitively. `govulncheck ./...`: 0
   reachable vulnerabilities (3 module-level findings remain
   unreachable, all in unused `ssh`/`openpgp` paths).
3. ✅ **[SNIPPET→VERIFIED] `toolchain go1.24.0` predated the container-aware
   GOMAXPROCS that GODEBUG_NOTES.md relies on.** Container-aware `GOMAXPROCS` (reads the
   cgroup CPU limit on Linux) shipped in Go 1.25 (Aug 2025); the pinned
   toolchain is 1.24 (Feb 2025), so GODEBUG_NOTES.md's `containermaxprocs`
   section — which calls that behavior "load-bearing for correct CPU mining
   throttling under cgroup constraints" — describes a benefit not actually
   compiled in today. **Action:** bump `toolchain` to go1.25.x per the repo's
   own quarterly-toolchain policy. (go.dev/doc/go1.25)
   — **Done (session 255):** `go 1.22 → 1.25.0` and
   `toolchain go1.24.0 → go1.25.7`. The container-aware GOMAXPROCS
   default is now compiled in (GODEBUG_NOTES.md updated); revert with
   `GODEBUG=containermaxprocs=0`. `.golangci.yml` `run.go` bumped to
   match.
4. ✅ **[FETCHED] x/crypto stays mandatory — confirms ADR-003.** `crypto/pbkdf2`,
   `crypto/hkdf`, `crypto/mlkem` landed in stdlib (Go 1.24), but
   `chacha20poly1305` and `scrypt` remain x/crypto-only through Go 1.26, so the
   dependency cannot be dropped. If PQ scaffolding ever needs ML-KEM, use
   stdlib `crypto/mlkem`. (pkg.go.dev/golang.org/x/crypto/chacha20poly1305,
   .../scrypt; pkg.go.dev/crypto/mlkem)

### Stratum V2 / Bitcoin (corrects roadmap/limitations wording)

5. 🟡 **[FETCHED] decred secp256k1 v4.4.1 gives the curve ops but neither
   BIP-340 nor ElligatorSwift.** Its Schnorr subpackage is EC-Schnorr-DCRv0
   (Decred-custom), not BIP-340, and no ellswift package exists. SV2 mandates
   `Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256` (BIP324 64-byte ellswift
   x-only encoding + 2-level PKI server auth). So ADR-011's Option A alone does
   not complete v3.1.0 — the Noise path additionally needs BIP-340 Schnorr
   (e.g. btcec/v2's `schnorr`) and a **hand-ported ElligatorSwift (no audited
   Go implementation exists)**, materially raising the estimate. **Action:**
   record this in an ADR-011 Erratum. (pkg.go.dev/github.com/decred/dcrd/dcrec/secp256k1/v4;
   raw.githubusercontent.com/stratum-mining/sv2-spec/main/04-Protocol-Security.md)
6. 🟡 **[FETCHED] BIP-360 is Status: Draft and specifies NO post-quantum
   signatures.** It is "Pay-to-Merkle-Root (P2MR)" — a Taproot-like output with
   the key-path spend removed — and explicitly defers PQ signatures to "a
   separate proposal." So coupling "BIP-360 activation" with "ML-DSA / P2MR
   default" (as ROADMAP/KNOWN_LIMITATIONS §5 currently do) is wrong: activation
   alone would not give the network ML-DSA, which is gated on a later,
   not-yet-written BIP — widening §5's uncertainty. **Action:** correct the §5
   / roadmap wording. (raw.githubusercontent.com/bitcoin/bips/master/bip-0360.mediawiki)
7. 🟡 **[FETCHED] Bitcoin Core v30.0 ships an experimental IPC Mining
   Interface.** Started via `bitcoin -m node -ipcbind=unix` (gated by
   `-DENABLE_IPC`), it lets SV2/other mining software request templates and
   submit blocks over a unix socket — a cleaner target than legacy
   getblocktemplate for ROADMAP Track D node integration. **Action:** note the
   v30 IPC interface (Cap'n Proto / multiprocess `bitcoin-node` binary) in
   ADR-009 / ROADMAP Track D. (raw.githubusercontent.com/bitcoin/bitcoin/v30.0/doc/release-notes.md)
8. ✅ **[FETCHED] DATUM confirmed MIT / BETA / SV1-transport-only.** The DATUM
   Gateway README states MIT license, public beta, requires a full node, and
   miners connect via Stratum V1 with version-rolling — it does NOT support
   SV2. This confirms KNOWN_LIMITATIONS §14's planned approach (implement
   `datum://` as an SV1-transport dialer reusing `poolproto/stratumv1`). Ignore
   a stray snippet claiming GPL-3.0 — the README says MIT.
   (raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md)
9. 🟡 **[FETCHED] SRI is past 1.x, monthly cadence (v1.11.0, 2026-07-08).**
   ROADMAP v3.2.0's premise that "SV2 SRI is alpha" is stale. **Action:**
   update the rationale text and pin a specific SRI tag as the interop
   reference for Go SV2 conformance tests.
   (github.com/stratum-mining/stratum/releases.atom)

### AI-compute / arbitration engine

10. 🟡 **[FETCHED] `akash-network/akash-api` is DEPRECATED (2026-01-05);
    successor is `akash-network/chain-sdk`.** ROADMAP v3.1.0's "Akash REST API"
    work, if scoped against akash-api, would build on an archived protobuf
    module. **Action:** retarget v3.1.0 to `chain-sdk`, and weigh its Go client
    against ADR-003 (generating only the needed market/provider protobufs may
    be lighter than vendoring the whole SDK). (github.com/akash-network/akash-api;
    github.com/akash-network/chain-sdk)
11. 🟡 **[FETCHED] Akash bidding is done on-chain by the provider daemon's
    "Bidengine", not a REST bid-submit call.** ADR-010 Feature A4 ("Strategic
    Akash bidding") currently models a per-order REST sealed-bid submission;
    the real auction is on-chain and mediated by the provider daemon's bid
    configuration. **Action:** re-frame A4 to output a *bid-price policy fed to
    the provider daemon's on-chain config*, not a per-order REST submission.
    (github.com/akash-network/provider) — note: this supersedes the session-52
    #3 "JWT on GetStatus" framing insofar as the *bidding* mechanism is
    on-chain; JWT (AEP-64) still applies to the provider *status/lease* REST
    surface.
12. ✅ **[FETCHED] Render / io.net have no open provider-side bidding API and
    are custodial/centrally-priced.** Render intermediates payouts in RNDR
    (burn-and-mint); io.net centrally determines pricing with staking-based
    supplier onboarding. Neither fits Otedama's non-custodial, per-order
    abstraction (conflicts with ADR-001 + CLAUDE.md禁止事項). **Action:** state
    in `internal/provider/` package docs that Akash-shaped (on-chain bid +
    non-custodial payout) is the supported model and Render/io.net are out of
    scope, so they aren't naively added later.
    (github.com/rendernetwork/RNPs/blob/main/RNP-005.md; github.com/api-evangelist/io-net)
13. 🔵 **[FETCHED title-match] ADR-010's bandit direction holds; add a
    2024-25 citation.** The Mellor & Shapiro 2013 paper ADR-010 cites (Thompson
    Sampling + Bayesian change-point) is real (arxiv.org/pdf/1302.3721); recent
    sliding-window / discounted Thompson Sampling results
    (arxiv.org/pdf/2409.05181, .../2305.10718) corroborate the "don't overbuild
    past Holt-Winters + change-point" stance. **Action:** cite one 2024-25
    result alongside the 2013 reference in ADR-010; no design change.
14. 🟡 **[SNIPPET — do NOT act until primary-verified] GPU compute spot prices
    described as jump-prone with no volatility clustering**, arguing change-point
    detection (ADR-010 A8) should be prioritized alongside the forecaster (A1)
    rather than after it. Sources are real but 403'd the fetcher
    (variant.fund, SSRN 6926798). Recorded as a lead only.

### Lightning

15. 🔵 **[FETCHED] LDK Node v0.7.0 (2025-12-03) adds experimental splicing +
    async payments; BOLT12 already shipped.** Depends on rust-lightning v0.2,
    MSRV rustc 1.85. **Action:** target the v3.7 embedded sidecar at LDK Node
    ≥ v0.7.0 and record in ADR-007 that it is a Rust subprocess/FFI sidecar
    (not in-Go). (github.com/lightningdevkit/ldk-node/releases;
    lightningdevkit.org/blog/bolt12-has-arrived/)

### Could not verify (recorded honestly per CLAUDE.md "調査が必要")

- **2025–26 mining academic papers:** arXiv/SSRN return 403 to the fetcher in
  this environment; no specific recent paper independently confirmed this pass.
- **BTC/USD feed breaking changes (`internal/rates/fetcher.go`):** no verifiable
  break found; exchange/CoinGecko docs 403 the fetcher. A [SNIPPET]-level lead
  suggests CoinGecko's keyless `simple/price` may now effectively need a demo
  key — if true, the median's third leg could silently degrade to two sources
  (exactly what `SourceHealth()` was built to expose). Verify from primary docs
  before acting.
- **Video sources:** none retrievable in a verifiable form in this environment;
  not recorded.

---

## September 2026 research pass — session 256 increment (upstream parity)

SRI and ESP-Miner release notes were re-read against the running code
(this round was deliberately client-visible-behaviour focused: what the
reference implementations shipped to operators since July 2026).

### Implemented this session (ESP-Miner v2.15.x parity)

1. ✅ **Pending-share visibility (ESP-Miner #1735).** SV2 pools may batch
   share acks, so a submitted share gets no feedback until the ack batch
   arrives — submitted-but-unjudged shares previously appeared only inside
   the broader `shares_unaccounted` figure. New gauge
   `otedama_shares_pending` (submitted − accepted − rejected −
   difficulty-transition-rejected, ≥0) + TUI `+N pending` badge on the
   mining line. `unaccounted = pending + found-but-never-submitted`, so
   the two gauges now separate "pool owes us a verdict" from "share was
   dropped at the local channel". (bitaxeorg/ESP-Miner #1735)
2. ✅ **One write per Noise transport frame (ESP-Miner v2.15).**
   `EncryptedConn.Write` previously wrote the 2-byte length prefix and the
   ciphertext as two separate `Write` calls — two syscalls per frame and
   a split point where a concurrent writer could interleave bytes mid-
   frame. Now one buffer, one write, `io.ErrShortWrite` on a short write.
   (bitaxeorg/ESP-Miner v2.15.0 Stratum section)
3. ✅ **Ignore duplicate job notifications (ESP-Miner #1731).** V1 pools
   can resend a `mining.notify` for a job_id already on the devices (e.g.
   after `mining.set_extranonce`); re-dispatching is wasted work churn.
   The V1 loop now tracks (job_id, difficulty) of the last applied job and
   skips identical re-notifies — stricter than upstream's job_id-only key
   so a same-id re-notify *after* `set_difficulty` still re-arms the new
   target. V2: identical re-sent `NewMiningJob` skipped in the same way.
   The `set_extranonce` half of #1731 does not apply: Otedama's workers
   never consume extranonce2 (submissions carry a zero pad), so there is
   no counter to reset. (bitaxeorg/ESP-Miner #1731)

### Verified already-correct (no change)

4. ✅ **SRI v1.11.1: "no longer rounds up Stratum V1 difficulty values"
   (stratum_translation).** Verified Otedama already does the right thing:
   `miner.TargetFromDifficulty` divides `diff1Target` by the exact float64
   difficulty and truncates the *target* (big.Float → Int); it never
   rounds the difficulty operand. Shares are compared against raw `Hash`
   targets end-to-end. (github.com/stratum-mining/stratum/releases/tag/v1.11.1)
5. ✅ **ESP-Miner #1779 "keep fractional SV2 pool difficulty".** Their bug
   was a `double → uint32_t` truncation in target-to-difficulty conversion
   letting shares in [931, 931.1) be submitted and rejected. Otedama has
   no target→difficulty conversion on the submit path — shares are checked
   against the target `Hash` directly, and `SuggestedDifficulty()` stays
   `float64` throughout. Nothing to fix.
   (github.com/bitaxeorg/ESP-Miner/pull/1779)

### New candidates (recorded, not implemented)

6. 🟡 **ESP-Miner #1796: per-pool "require authentication" flag.** Upstream
   now treats SV2 server-auth verification as an opt-in per-pool option —
   the right shape for Cat 2 #1 (authority-key verification): when the
   real secp256k1 Noise path lands (ADR-011), model enforcement as a
   per-pool `require_auth` boolean rather than a global, so pools without
   published keys still work. (github.com/bitaxeorg/ESP-Miner/pull/1796)
7. 🟡 **ESP-Miner #1913: reconnect storms caused by slow clients.** Fixed
   upstream — verify Otedama's read loop can't pile up reconnects when a
   pool stalls: `runSession`'s reconnect backoff + bounded job channels
   should cover it, but there is no explicit slow-reader watchdog on the
   session goroutines. Worth a deliberate test.
   (github.com/bitaxeorg/ESP-Miner/pull/1913)
8. 🟡 **SV2 frames larger than one Noise transport message.** A Noise
   transport message is u16-bounded (65535 incl. tag) but an SV2 frame's
   length field is u24 — spec-compliant peers may split a big frame across
   multiple Noise messages. `EncryptedConn.Write` currently rejects
   plaintext >65519 outright instead of chunking, and `Read` assumes one
   frame per transport message. Harmless today (every implemented message
   is small), required if JDP/Extended-Channel work lands.
   (sv2-spec 03-Protocol-Overview framing section)
9. 🟡 **ESP-Miner #1961: warnings keyed to device presets.** Upstream now
   derives low-hashrate warning thresholds from the detected board class.
   Otedama's HashrateMonitor floor is fixed; a per-device-class floor
   (CPU vs ASIC vs GPU) would make `otedama_up`/the TUI ⚠ indicator honest
   on heterogeneous rigs. (github.com/bitaxeorg/ESP-Miner/pull/1961)

---

## September 2026 research pass — session 257 increment (upstream parity, cont.)

Continues the session-256 backlog. ESP-Miner v2.15.2/v2.15.3 release
notes re-checked for deltas (both already covered by items 6–9).

### Implemented this session

1. ✅ **Noise transport chunking for frames >65519 B (session-256 item 8).**
   `EncryptedConn.Write` rejected any plaintext that did not fit a single
   transport message; it now splits the payload into ≤65519-byte chunks
   sent as consecutive transport messages (each still one `Write` call —
   the session-256 coalescing is preserved per message). Legal because
   SV2 framing is defined on the decrypted byte stream, not on Noise
   message boundaries; the receive side already reassembled chunked
   frames correctly via its plaintext stream. This unblocks JDP/
   Extended-Channel-sized frames before that work lands.
   (sv2-spec 03-Protocol-Overview framing)
2. ✅ **Non-blocking job emit on the V2 dialer (session-256 item 7,
   ESP-Miner #1913).** The adapter's read loop sent into `jobsCh` with
   a blocking channel op — a slow consumer stalled the loop, and while
   stalled it missed further NewMiningJob/SetNewPrevHash frames (every
   queued job it later dequeues is stale anyway). Now the same policy
   as the V1 session: clean emits purge the queue, and a full queue
   drops the oldest job — the newest always supersedes. The blocking
   send was also the *only* ctx-cancel escape for a conn stuck inside
   ReadFrame (net.Conn reads are not ctx-aware), so a watcher now
   closes the connection on ctx.Done — cancellation unblocks a blocked
   read on real sockets too, not just a full-queue send.
   (github.com/bitaxeorg/ESP-Miner/pull/1913)

### Verified non-applicable this session

3. ✅ **ESP-Miner #1961 device-class warning floors (session-256 item 9)
   — deferred by design.** Upstream derives low-hashrate warning floors
   from the detected board preset. Otedama's only mineable device class
   today is CPU (no GPU compute dispatch, no ASIC driver —
   KNOWN_LIMITATIONS §8), and a CPU worker's honest hashrate varies by
   orders of magnitude with core count, so any fixed floor would be a
   hard-coded wrong answer. Revisit when a second device class can
   actually mine; `HashrateMonitor(floor=0)` already covers the
   complete-stall case.

---

## September 2026 research pass — session 258 increment (backlog sweep)

SRI releases re-checked (v1.11.1, 2026-07-22 remains latest — no new
deltas). Session-52 backlog items resolved.

### Implemented this session

1. ✅ **Fuzz the Noise transport read path (session-52 #1).** The SRI
   fuzzing grant found an arithmetic overflow in `noise_sv2`; the
   directly analogous Otedama surface now has `FuzzEncryptedConn_Read`
   in `frame_fuzz_test.go` — arbitrary bytes into the u16-prefix +
   AEAD-reject loop, asserting no panic, no unbounded allocation, and
   no non-advancing read loop. (The write-side counterpart is covered
   deterministically by the session-257 chunking boundary tests.)
   (opensats.org/projects/stratumv2)
2. ✅ **JDC adoption figure updated (session-52 #2).** ADR-009 now
   carries the ~75%-of-hashrate SV2-commitment figure alongside the
   original ~70% (coindesk.com 2026-05-11).
3. ✅ **Impossible-target operator warning.** A `SetTarget` carrying
   `max_target = 0` can never yield a share; `updateWork` already fell
   back to the block target silently — the session loop now logs a
   warn so the fallback is diagnosable rather than invisible.

### Verified already-done / non-applicable this session

4. ✅ **FIPS 140-3 mode + PQ key-exchange documentation (session-52 #4)
   — already done.** `GODEBUG_NOTES.md §fips140` documents that Otedama
   is not FIPS-compliant *by design* (Noise transport uses
   ChaCha20-Poly1305, not FIPS-listed — enabling the knob would break
   it) while wallet-at-rest AES-256-GCM is validated; `go.mod` already
   carries `godebug tlsmlkem=1` for hybrid X25519MLKEM768 TLS key
   exchange. Nothing left to implement; marked done.
5. ✅ **Clamp channel target to `max_target` (Cat 2 #2 remainder) —
   verified non-applicable by design.** The upstream clamp bounds the
   share target to a client-declared `max_target` preference — Otedama
   intentionally sends no such preference (handshake.go dead-field
   note), so there is nothing to clamp *to*. Pool-sent targets are
   applied outright by design; the degenerate case is covered by the
   new zero-target warn + existing block-target fallback.

---

## September 2026 research pass — session 259 increment (CS first-principles sweep)

Methodology this round: a computer-science first-principles /
Socratic audit rather than an upstream-diff sweep — "what is the minimal
contract a pool connection must provide, and where does the code violate
its own axioms?" Four violations surfaced, all on the V2 path.

### Implemented this session

1. ✅ **engine→poolproto V2 wiring (Cat 2 #8 — the #2 highest-leverage
   item).** The engine carried a ~600-line inline Stratum V2
   handshake/read/submit loop that duplicated — and diverged from — the
   `stratumv2` dialer (dead code: no caller). `runSession` now dispatches
   every scheme to `poolproto.DialURL` and both protocols share the one
   `runPoolSession` session loop. Deleting the duplicate removed the
   two-paths-disagree bug class outright (V1's `mining.reconnect`
   handling, curtailment gate, benign-reject check, and latency
   accounting now apply to V2 by construction rather than by copy).
2. ✅ **Dialer registration was load-bearing-broken.** `cmd/otedama`
   blank-imported only `stratumv1`, so `poolproto.DialURL` reported
   "unknown protocol" for `stratum+v2://` — the *default* pool URL —
   in any binary that did not link the engine's inline path. The
   engine now blank-imports both dialers, making the package
   self-sufficient wherever it is linked.
3. ✅ **Share-verdict correlation.** V2 `Submit` previously returned a
   provisional `Accepted=true` immediately after the write — a fake
   signal that made `sharesAccepted`/`sharesRejected` and the
   submit-latency quantile meaningless on V2. `Submit` now registers a
   `SequenceNumber`-keyed verdict slot and waits for the pool's
   verdict: `SubmitSharesSuccess` is cumulative (settles all seq ≤
   `LastSequenceNumber`), `SubmitSharesError` settles its exact seq
   (returns `Accepted=false` + pool reason), and ctx-cancel surfaces
   `ctx.Err()` honestly. Late verdicts for expired waits drop safely —
   the map is keyed by seq, not positional, so no queue corruption.
4. ✅ **Full-precision pool-assigned share target.** Routing the 256-bit
   `SetTarget`/`OpenMiningChannelSuccess.target` through the float64
   `SuggestedDifficulty` and back would lose ~200 bits of precision —
   silently changing what the worker hashes. `poolproto.Job` now
   carries `ShareTarget [32]byte` + `TargetAssigned` (raw U256, same
   LE byte order as `miner.Hash`), applied verbatim by the shared loop;
   `DifficultyFromTarget` exists only for the float64 metrics/readouts
   where precision is informational. Zero-target assignment still
   warns once and falls back to the nBits block target.
5. ✅ **Real TLS for `stratum+v2tls://`.** The scheme previously dialed
   plaintext (the dialer ignored `useTLS`); it now builds
   `TLSConfigWithExtraCAs(creds.TLSRootCAsPEM)` and does a real TLS
   handshake — never a silent plaintext fallback (KNOWN_LIMITATIONS §2
   workaround text stays accurate).
6. ✅ **Handshake rejection is uniformly fatal.** `isFatal` now unwraps
   (`errors.As` + `errors.Is(ErrHandshakeFailed)`): a pool that rejects
   `SetupConnection` *or* `OpenMiningChannel` is telling us the session
   can never work — retrying just hammers it. Documented behavior
   tightening: `OpenMiningChannelError` previously retried until the
   reconnect cap.
7. ✅ **Share `version` surfaced to the pool.** `Submit` forwards the
   hashed header `Version` (was dropped → `NVersion: 0`), so
   `SubmitSharesStandard` echoes the version actually mined — required
   for correct share accounting on version-rolling-aware pools.

### Verified non-applicable / deferred this session

8. ❌ **Wiring the Noise NX handshake into V2 transport** — deferred:
   the current Noise implementation is a P-256 stub (ADR-011); wiring a
   stub as "encryption" is security theatre. Blocked on the secp256k1
   dependency decision (highest-leverage item #1), not on effort.
9. ✅ **dedup key extended** — the duplicate-job skip key now spans
   (JobID, share target, Version, MerkleRoot, PrevHash) so a same-ID
   job re-armed on a new tip is applied, not silently skipped.

### Socratic findings recorded for later rounds

- "What does a share submitter need?" → a job, a target, and an honest
  verdict — now the `Session` interface's exact shape.
- "Where can a u16-length prefix lie?" → chunking + fuzz coverage
  already landed (sessions 257–258); no new surface added this round.

## September 2026 research pass — session 260 increment (upstream parity)

### Implemented

1. ✅ **TCP_NODELAY on every pool dial** (ESP-Miner #1722 parity;
   precedent: bitcoin/bitcoin PR #30675 and the suprnova latency
   analysis showing Nagle + delayed-ACK ~40 ms stalls on small
   request/response exchanges). All four dial paths now disable Nagle:
   `stratumv1` plaintext + `dialTLS`, `stratumv2` plaintext, and the
   shared `stratum.DialTLS` used by `stratum+v2tls://`. Test
   getsockopt(TCP_NODELAY) assertions on all three packages' real-TCP
   paths (net.Pipe conns are skipped by design).

### Verified already-done / non-applicable this session

- ✅ **Pool-state metrics (Cat 9 #5/#7)** — `otedama_pool_connection_state`
  (0 disconnected / 1 connecting / 2 connected), `otedama_pool_connect_attempts_total`,
  and `otedama_pool_connect_failures_total` all exist and are wired in the
  session loop. Cat 9 #5/#7 confirmed complete.
- ❌ **ESP-Miner #1799 (extranonce2 minimum 6→2 bytes)** — N/A: Otedama does
  not roll extranonce2 at all (job composition stays pool-side for the
  engine's share-echo path), so the minimum-size knob does not exist here.
- ❌ **ESP-Miner #1796 (SV2 authority-key authentication option)** — N/A:
  depends on the secp256k1 decision (highest-leverage #1); the Noise stub
  cannot authenticate regardless of socket options.
- ❌ **ESP-Miner #1779 + SRI v1.11.1 (fractional difficulty / rounding)** —
  N/A: Otedama transports raw U256 `max_target` verbatim since session 259;
  there is no difficulty-to-target float conversion on the write path to
  round.
- ❌ **Qiita/Zenn sweep** — no new stratum-v2 / ASIC-firmware material
  since session 259.

## September 2026 research pass — session 290 increment (OMC request wire fix)

- **実装（spec 準拠・相互運用）: `OpenMiningChannel` に必須フィールド
  `max_target U256` を追加** —— spec 5.3.2（sv2-spec と突合）は
  `OpenStandardMiningChannel` に request_id / user_identity /
  nominal_hash_rate / **max_target U256** を要求し、サーバは受理するか
  OpenMiningChannel.Error を返す義務がある。実装は max_target を完全に
  省略しており、生成ペイロードが末尾32バイト欠け —— 厳格な spec 準拠
  プールではフレームデコード失敗→ハンドシェイク不能だった。Encode に
  32バイト末尾を追加、Decode は必須読み取り、dialer は all-ones
  （無制限 —— プール割当ターゲットを全て受容）を送信。s289 と同型の
  spec-parity バグのリクエスト側。
- **検証:** round-trip テストに MaxTarget assert 追加、truncation
  テストのコメントを新レイアウトに更新。

## September 2026 research pass — session 289 increment (OMC.Success wire fix)

- **実装（spec 準拠）: `OpenMiningChannelSuccess` 末尾フィールドを
  `group_channel_id U32` に修正** —— spec（sv2-spec 05-Mining-Protocol
  §5.3.3, SRI `mining_sv2` crate と突合）の最終フィールドは
  `group_channel_id U32`（全チャネルが属するグループ）だが、実装は
  `ExtraNonce2Size U16` と誤解釈していた。U16→U32 でデコード・
  エンコードを spec 準拠に変更。単一チャネル運用のため値は記録のみ
  （group_channel_id の用途は JD/グループ対応時に参照）。
  Extranonce（spec: extranonce_prefix B0_32）は既存どおり lenient
  decode/strict encode を維持。
- **検証:** encode↔decode round-trip / truncation テスト更新、
  dialer_test/run_test のフィールド参照を一括改名。

## September 2026 research pass — session 288 increment (V1 coinbase reconstruction)

- **実装（正確性・根本欠陥の解消）: V1 coinbase/merkle 再構成** ——
  Stratum V1 ではプールが coinbase を coinb1/coinb2 の二半で送り、
  miner 側が extranonce を挟んで完成させる。Otedama は再構成せず
  `MerkleRoot=0` でヘッダを組み立てていたため、プール側の再構成
  ハッシュと一致せず、**実プールに出す全シェアが構造的に不正**
  だった（session 286 以降 ADR 級として記録してきた根本欠陥）。
  `mining.notify` の coinb1/coinb2(hex)/merkle_branch([]hex) を
  `poolproto.Job` に載せ、sendJob で
  `Hash256(coinb1|en1|en2|coinb2)` を branch で畳んで MerkleRoot を
  刻印（en2 は submit と同じ negotiated-size のゼロ列）。notify の
  coinb/branch hex も他フィールドと同じ厳格さで検査。
- **検証:** `TestSendJob_ReconstructsMerkleRoot`（畳み込みの
  既知値検証）、`TestSendJob_MerkleRootSkippedWithoutExtranonce1`
  （en1 未設定時は安全側スキップ）。既存フィクスチャの
  `"coinb1"/"coinb2"` リテラルを有効 hex に修正。

## September 2026 research pass — session 287 increment (V2 write deadline)

- **実装（防御）: V2 Submit に write mutex + 10s write deadline を
  追加** —— V1 セッションは書き込み経路で `writeMu` +
  `SetWriteDeadline(10s)` を備えるが、V2 側は `sendMsg` が deadline
  も mutex も無く `w.Write` を直接呼んでいた。ジョブを送り続けながら
  submit を読まないプール（劣化・敵的）では、TCP 送信バッファが満杯に
  なると Submit がソケット write 内で永久ブロック —— read は成功し
  続けるため read deadline（session 282）もジョブ枯渇 watchdog
  （session 267）も発火しない死角だった。セッションメソッド
  `sendMsg` で mutex + 10s deadline に統一（V1 同等）。ハンドシェイク
  時の `sendMsg` 呼び出しは順序固定のため従来どおりパッケージ関数を
  使用。
- **検証:** `TestSubmit_ArmsWriteDeadline` —— deadline 記録 stub で
  Submit が書き込み前に SetWriteDeadline を呼ぶことを確認。
- **記録:** OpenMiningChannelSuccess の Extranonce/ExtraNonce2Size は
  デコードされるが未使用（standard channel では coinbase 再構成を
  行わないため参照先が無い）。仕様準拠の wire レイアウト上の差異
  （spec は group_channel_id U32 末尾、実装は U16 解釈）は decode が
  後続バイトを許容するため実害なし —— 将来 JD 対応時に要見直し。

## September 2026 research pass — session 286 increment (dedup key ntime)

- **実装（正確性）: ジョブ dedup キーに NTime/NBits を追加** —— V1
  プールは同一 job_id で ntime を更新して定期 re-notify する
  （slushpool 式ロール）が、dedup キー（JobID+target+Version+
  VersionMask+Merkle+PrevHash）が NTime/NBits を含まず、ntime 更新
  ジョブが重複として破棄されていた —— ワーカーはセッション中ずっと
  古いタイムスタンプで掘り続ける状態。「ヘッダを変える全フィールド」
  の原則に合わせ両者をキーに追加。
- **検証:** `TestRunSessionV1_SameJobIDRolledNTimeReapplies` —— 同一
  job_id + ロール ntime で再適用（applied=2）、既存
  `DuplicateJobIgnored` も継続 green。
- **記録:** V1 パスは coinbase/merkle を再構成しない（pool 側が計算、
  MerkleRoot=0）。実ブロック有効な V1 シェア生成にはコインベース
  再構成が必要 —— ADR 級の設計変更のため記録のみ。

## September 2026 research pass — session 285 increment (channel_id filtering)

- **実装（防御）: V2 channel_msg の channel_id 検証** —— セッションは
  コネクション上で1チャネルのみ所有するが、readLoop が channel_id を
  検証せず全 channel_msg を受理していた。他チャネル宛の SetTarget で
  シェアターゲットを乗っ取られ、他チャネルのジョブ/verdict が状態を
  汚染し得た（混線プール・敵意的プール）。NewMiningJob /
  SetNewPrevHash / SetTarget / SubmitSharesSuccess /
  SubmitSharesError / CloseChannel を `s.chanID` でフィルタ。
- **検証:** `TestReadLoop_ForeignChannelFiltered` —— 他チャネル宛
  SetTarget でターゲット不変、他チャネル宛ジョブ+prevhash で
  jobsCh 非送出。

## September 2026 research pass — session 284 increment (SV2 CloseChannel)

- **実装（spec 準拠）: `CloseChannel` (0x19) のデコード + readLoop
  ハンドリング** —— SV2 spec の正規チャネル終了メッセージが未実装で、
  プールがチャネルを閉じても TCP が残る経路でセッションが
  ゾンビ化（ジョブ停止だが切断として検出されず read deadline /
  watchdog 待ち）していた。自チャネル宛の CloseChannel で readLoop
  を終了し、エンジンの再接続経路で新チャネルを即座に開く。
  他チャネル宛は無視。reason_code STR0_255 必須として
  OpenMiningChannelError/SubmitSharesError と同規則で厳格化。
- **検証:** `TestReadLoop_CloseChannelEndsSession`（自チャネルで終了、
  他チャネルで継続）、`FuzzDecodeV2Message` に CloseChannel
  セレクタ追加（15 秒 3.5M exec クリーン）。

## September 2026 research pass — session 283 increment (extranonce size interop)

- **実装（interop 非対称修正）: `mining.set_extranonce` のサイズを
  float64 受理に** —— JSON 数値は常に float64 でデコードされるため、
  `extranonce2_size` を `int` 直接 unmarshal すると `4.0` エンコードの
  プールで通知が静かに棄却され、extranonce2_size が古いまま残り
  以後の全 submit が en2 長不一致で reject される経路があった。
  `parseSubscribeResult` と同じ float64→整数性チェックに統一。
- **検証:** `TestParseSetExtranonce_FloatSize` —— `4.0` 受理、
  `4.5`/負数/範囲外/非数値は棄却。既存テスト全通過。

## September 2026 research pass — session 282 increment (V2 read deadline)

- **実装（ゾンビセッション対策）: V2 readLoop に 5 分 read deadline** ——
  V1 は `SetReadDeadline(5min)` で「TCP は生きたままフレームを送らない
  wedged プール」を通常の切断→再接続として検出するが、V2 ダイヤラには
  deadline がなく、ctx キャンセル or conn close でしか read を抜けない
  ため、同じ状況でゾンビセッションが永久に存続し得た（session 267 の
  ジョブ枯渇ウォッチドッグは warn のみで切断しない）。V1 と同じ
  5 分 deadline を `dec.ReadFrame()` 前に追加。
- **検証:** `TestReadLoop_ArmsReadDeadline` —— deadline 記録する
  stub conn で readLoop が per-read deadline を設定し、peer close で
  正常 exit することを確認（5 分待機不要の構成）。
- **記録:** `extranonce.subscribe` は既に dialer step 3 で単独送信済み
  （mining.configure 拡張リストへの追加は不要と確認）。

## September 2026 research pass — session 281 increment (mask-rotation bound + wrap-safe cap)

- **実装（BIP-310 防御）: `set_version_mask` を交渉済み空間に限定** ——
  従来はローテーションを無検証で適用していたため、(a) 拡張未交渉の
  プールが set_version_mask を送った場合、(b) 交渉済みマスクの
  超集合を回転で送った場合、いずれもワーカーが交渉外のバージョン
  ビットをロールし始め、全ロール済み share が
  `version_bits & ~mask != 0` で reject される経路があった。
  交渉済みマスクを `negotiatedMask`（atomic — dialer が readLoop
  起動後に書くため）に保持し、`neg == 0 || mask &^ neg != 0` な
  ローテーションは PoolNotices 経由の通知 + 無視に変更。
  BIP-310 の「set_version_mask MUST be a subset of the negotiated
  mask」制約に準拠。
- **実装（u32 ラップ安全）: nTime cap チェックを int64 ドメインに** ——
  `h.Time = base + nOff` が u32 でラップすると `int64(h.Time)+1 > cap`
  が永遠に発火せず、コンセンサス無効な低タイムスタンプの空間を
  掘り続ける悪意ジョブ（base ntime ≈ u32max）に対して枯渇検出が
  効かなかった。cap 判定を `base + nOff + 1 > cap` の int64 演算に。
- **検証:** 新規 `TestSession_Dispatch_SetVersionMask_OutsideNegotiated`
  （未交渉/超集合の無視、範囲内ローテーション適用）。既存2テストに
  negotiatedMask 前提を追加。
- **記録:** 採用した検証は session-279 実装を拡張 —— dialer は交渉
  マスクを versionMask と negotiatedMask の両方に書き込む
  （rotations は前者のみ上書きするため）。

## September 2026 research pass — session 280 increment (rolled-state persistence)

- **実装（実バグ修正）: ロール状態をバッチ跨ぎで永続化** —— grind
  ループは 1024 ハッシュ毎に `h := localWork.Header` でヘッダを
  テンプレートから再構築するため、session 272 の nTime ロール
  （`h.Time++`）がバッチ境界で失われていた。実際の NonceStep での
  ラップ間隔は ~2^32 ハッシュ（~4M バッチ）なので、nTime は実質
  base+1 のみを ~バッチサイズ分掘り続けてテンプレート値に戻る
  —— base nTime 空間の永続的な再ハッシュ = 全 share が
  duplicate-share reject。version ロールも同じ構造で、列挙が
  バッチ毎にリセットされていた。ロール状態（nOff/verSub/verTried）
  を grind スコープへ持ち上げてバッチを跨いで維持し、nTime
  ロール時は version 列挙を再開して ntime→version→nonce の
  全積空間を網羅する順序に。`h.Version`/`h.Time` はバッチ先頭で
  テンプレート＋オフセットから再構成。cgminer/ESP-Miner の
  rollwork 実装でも同一パターン（ロール済みタイムスタンプは
  work 側に保持される）。
- **検証:** 新規 `TestWorker_NTimeRollPersistsAcrossBatches` は
  step≈2^32/1024（約1ラップ/バッチ）で nTime が base+3 超まで
  蓄積することを確認（旧実装では base+1 で頭打ちで検出可能）。
- **記録:** V2 標準チャネルは `NewMiningJob` に
  version_rolling_allowed フィールドを持たないため version
  rolling は拡張チャネルのみ —— Otedama の標準チャネル経路は
  影響なし（session 278 で確認済みの再確認）。

## September 2026 research pass — session 279 increment (version-rolling correctness)

### Implemented

1. ✅ **Submask enumeration for version rolling** — session 278 rolled
   `verOff++` then masked it off (`(h.Version &^ vm) | (verOff & vm)`),
   which for sparse masks re-visits the same masked value on most rolls:
   a typical negotiated mask like 0x1fffe000 only changes
   `verOff & vm` once every 0x2000 increments, so ~99.99% of rolls would
   re-hash an identical header space into duplicate-share rejects.
   Replaced with the classic `(v-1) & mask` submask walk
   (`nextSubmask`), which visits each of the 2^popcount(mask) patterns
   exactly once, plus `versionRollSpace` (1<<popcount) as the roll
   bound. `TestNextSubmask_EnumeratesEachPatternOnce` pins uniqueness
   over the full 65536-pattern space.
2. ✅ **`mining.set_version_mask` takes effect immediately** — BIP-310
   requires a mid-session rotation to apply to jobs already dispatched.
   The session now caches the most recent notify (`lastJob`,
   `atomic.Pointer[Job]`) and re-emits it on a valid rotation; the
   engine stamps the new mask at receive time and its dedup key
   includes the mask, so workers re-arm without waiting for the next
   job. Malformed rotations do not re-emit.
3. ✅ **`client.show_message` dispatch regression caught by tests** —
   an edit collision had dropped the `case` label so show_message
   handling ran inside the set_version_mask case (a mask became a pool
   "notice"); restored the label and re-armed
   `TestSession_Dispatch_UnknownNotification_SilentlyIgnored` with a
   genuinely unknown method.

### Verified this session

- ✅ `-race -count=2` clean on miner + stratumv1; full suite green.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 278 increment (BIP-310 version rolling)

### Implemented

1. ✅ **BIP-310 version-rolling negotiated end-to-end** — V1 dialer
   sends `mining.configure` (extension `version-rolling`, offered mask
   `ffffffff`, min-bit-count 2) as a synchronous, 250 ms-bounded
   request at the end of `Negotiate`; the negotiated
   `version-rolling.mask` lives on `session.versionMask`
   (`atomic.Uint32`). `mining.set_version_mask` notifications rotate it
   mid-session per spec (takes effect immediately, including for jobs
   already dispatched). Synchronous ordering keeps configure as wire
   request #4 — an async goroutine would race positional test pools and
   real submit ordering; the bounded ctx means a pool that never
   answers stalls Negotiate ≤250 ms and just leaves rolling off.
2. ✅ **Submit sends the sixth `version_bits` param** once a mask is
   negotiated — `fmt.Sprintf("%08x", sub.Version & mask)`, satisfying
   the spec constraint `version_bits & ~mask == 0` (the pool
   reconstructs `nVersion = (job_version & ~mask) | (version_bits &
   mask)`). Without a mask the classic 5-param submit is untouched.
3. ✅ **Worker rolls version bits before nTime** (cgminer/ESP-Miner
   ordering): on nonce-space exhaustion `verOff` enumerates 0..mask
   (covers all 2^popcount(mask) patterns even for sparse masks), then
   the loop falls back to nTime rolling capped at
   MAX_FUTURE_BLOCK_TIME. Search space per job grows ~2^popcount(mask)
   — on typical pools (~16-17 bits) that is >65,536× more work before
   nTime must move, which also pushes the effective job lifetime far
   past slow-network edge cases.
4. ✅ **Engine plumbs the mask** `poolproto.Job.VersionMask` →
   `miner.Work.VersionMask`, and the dedup key now includes the mask so
   a `mining.set_version_mask` rotation followed by a same-job_id
   re-notify still re-arms workers.

### Verified this session (sources)

- ✅ **BIP-310 contract vs slushpool/stratumprotocol spec** — params
  order `[extensions[], {mask, min-bit-count}]`, response mask =
  intersection, sixth submit param semantics, set_version_mask
  immediate effect all match the canonical mediawiki spec.
- ✅ **Test harness positional-read coupling** — fake V1 pools read
  requests positionally; the configure step shifted submit from id 4→5
  in coverage_test.go / stratumv1_test.go (updated, plus one
  pre-existing flake in TestRunSessionV1_SubmitError made
  deterministic).
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 277 increment (user field atomicity)

### Implemented

1. ✅ **V1 `session.user` is now `atomic.Pointer[string]`** — the last
   plain shared field left after session 275: the dialer writes it
   post-authorize *after* `start()` launched the read loop, and Submit
   callers read it on their own goroutines. It was only safe by an
   implicit Negotiate→Submit call-ordering invariant; making it atomic
   (same fix as the extranonce fields) removes that whole class rather
   than relying on call order. The `mining.submit` worker-name param
   now dereferences `s.user.Load()`; the pre-authorization default is
   the package-level `defaultWorkerName`.

### Deep audit — verified clean this session

- ✅ **`mining.set_difficulty` unmarshal path** — `[]float64` JSON
  decode cannot yield NaN/Inf (no JSON literal; out-of-range numbers
  error). Guarded by `TargetFromDifficulty` bounds downstream anyway.
- ✅ **`TargetFromNBits`** — negative-mantissa bit, exp<3, zero
  mantissa, and >32-byte overflow all error; hostile nBits cannot mint
  a wild target.
- ✅ **`parseNotify`** — all nine wire fields strictly validated
  (session 274); extra params tolerated for forward-compat.
- ✅ **V2 `emit`/`jobState`** — pending map bounded (256, s271),
  clean-tip purge, drop-oldest, `min_ntime` floor semantics verified
  against SRI.
- ✅ **V1 read deadline** — 5-min inactivity kill refreshed per loop
  iteration, standard miner behaviour (not a per-connection lifetime).
- ✅ **`writeMu`** — all conn writes serialised; `SetWriteDeadline`
  per-write under the same mutex.
- ✅ **`cancelPending`** — deletes as it closes, so readLoop-defer and
  Close() callers cannot double-close a channel.
- ✅ **`parseReconnect`** — deliberately tolerant; host/port are
  recorded but never consumed (anti-redirect ADR decision, s271).
- ✅ **TLS paths** — `stratum+v2tls` and V1-TLS both verify certs
  (MinVersion 1.2, system roots, SNI from dial address); no
  InsecureSkipVerify anywhere.
- ✅ **`publishDifficulty`** — `d<=0` gate; huge-but-finite values are
  honest (a share at 1e300 really does take ~forever).
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.
- 🟡 **Observed once, not reproduced**: one transient `-race -count=2`
  engine-package failure during local verification (no DATA RACE
  report; three subsequent -count=1/-count=2/-count=3 runs all green).

---

## September 2026 research pass — session 276 increment (invalid-difficulty starvation warn)

### Implemented

1. ✅ **V1 unrepresentable `set_difficulty` now warns** — the session-258
   V2 gap existed identically on V1: a `set_difficulty` value
   `TargetFromDifficulty` cannot represent (≈0 or above diff1 —
   malformed or hostile vardiff) silently fell back to the nBits block
   target, starving the miner exactly like `max_target=0`. The engine
   now warns once per incident (`invalidDiffWarned` latch), gated on
   `SuggestedDifficulty() > 0` so the pre-first-notification default
   doesn't false-positive.
2. ✅ **`session.call` pending-entry leak on marshal error** — a
   `json.Marshal` failure returned without `delete(s.pending, id)`,
   leaking the map entry for the session's life.
3. ✅ **stratumv2 `Submit` doc comment corrected** — still described the
   pre-session-259 provisional-accept behaviour; now describes the real
   verdict-correlation contract.

### Verified already-done / non-applicable this session

- ✅ **V1 write path** — `writeMu` already serialises all conn writes.
- ✅ **miner `Work`/stats** — `w.mu` guards work/workVer; all counters
  are `atomic.*`.
- ✅ **V2 dialer** — `targetMu`, `verdicts sync.Map`, `atomic.*`
  throughout; `s.done` unblocks waiting Submits on close.
- ✅ **`parseDifficulty` cannot yield NaN/Inf** — `[]float64` JSON
  unmarshal rejects non-numeric literals and out-of-range numbers.
- ✅ **5-min read deadline refreshes per read-loop iteration** — it's
  an inactivity kill, standard miner behaviour.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 275 increment (extranonce race)

### Implemented

1. ✅ **V1 `extranonce1`/`extranonce2Size` are now atomic** — a genuine
   data race: `mining.set_extranonce` dispatches on the readLoop
   goroutine while `Submit` reads `extranonce2Size` on the caller's
   goroutine (mid-session rotation is a real pool behaviour — slushpool
   rotates per-connection). Plain int/string → `atomic.Int64` /
   `atomic.Pointer[string]`. The handshake write happens *after*
   `start()` launches readLoop, so even negotiation wasn't safe under
   the memory model. New `-race` test loops set_extranonce dispatch
   against Submit.

### Verified already-done / non-applicable this session

- ✅ **`s.difficulty` (set_difficulty)** — already `atomic.Uint64`.
- ✅ **`pending` map** — already mutex-guarded (`pendingMu`).
- ✅ **`s.user`** — written once in `Negotiate` before any Submit can
  run (same goroutine happens-before), read-only thereafter.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 274 increment (notify strictness + nTime-cap diagnosis)

### Implemented

1. ✅ **V1 `mining.notify` hex fields are strict** — version/nbits/ntime/
   prevhash parse failures previously zeroed the field silently, so a
   malformed notify produced a job whose every share could only be
   rejected (bad ntime/nbits) while looking healthy. They now drop the
   notify, routing bad input to the job-starvation watchdog (session
   267), the diagnostic that already exists for "no valid jobs".
2. ✅ **`nTime > now+2h` warns at apply time** — session 272's
   MAX_FUTURE_BLOCK_TIME cap means a pool-supplied timestamp already
   past the bound makes the worker idle rather than hash; the engine
   now logs it explicitly instead of letting the starvation watchdog
   fire 120 s later. `maxFutureBlockTimeSecs` is exported as
   `miner.MaxFutureBlockTimeSecs` so the bound has one definition.

### Verified already-done / non-applicable this session

- ✅ **`mining.set_version_mask`** — silently ignored by design (no
  ASIC-Boost overt rolling in the CPU path); forward-compatible.
- ✅ **V1 prevhash byte order** — stored verbatim into `Header.PrevHash`
  and echoed back untouched; no re-interpretation on the wire path.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 273 increment (opaque V1 job IDs)

### Implemented

1. ✅ **`Work.JobID`/`Share.JobID` are now opaque strings** — the engine
   parsed the pool's `job_id` with `Sscanf("%d")` and dropped the job on
   failure, and `Submit` echoed `Sprintf("%d", parsed)` back. But V1 job
   IDs are not decimal: Braiins, F2Pool and public-pool issue
   alphanumeric identifiers, so on those pools every `mining.notify`
   was discarded (zero work, silent stall) — and any ID that parsed to
   a different value would have produced invalid-job-id rejects on
   every share. The JobID is now carried verbatim end-to-end and
   echoed on submit exactly as the pool sent it (V2 is unaffected: its
   job IDs are real u32s the dialer formats/parses itself). The
   test that pinned the reject (`TestApplyJob_UnparseableJobID`) was
   inverted to assert acceptance; `TestRunSessionV1_ApplyJobError` now
   exercises the error path via an invalid nBits target instead.
   (stratum v1 protocol docs; ESP-Miner treats job_id as an opaque
   string the same way.)

### Verified already-done / non-applicable this session

- ✅ **`mining.set_difficulty` non-positive values** — `parseDifficulty`
   cannot produce NaN/Inf (JSON has no literal for them); `<=0` flows
   to the existing "no target assigned" fallback, not a zero target.
- ✅ **`extranonce1` echo path** — bounded by the session's 64 KiB line
   cap and only ever echoed inside a same-bounded submit line.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 272 increment (nTime rolling)

### Implemented

1. ✅ **nTime rolling on nonce-space exhaustion** — the grind loop
   advanced `nonce += NonceStep` and silently wrapped at 2³², after
   which every hash duplicated an already-tried (job, nonce) pair —
   wasted work and duplicate-share rejects at ≥ ~40 MH/s aggregate
   (≈21 s/cycle/thread at 50 MH/s). Standard miner behaviour is to
   roll the header timestamp: on wrap, `h.Time++` and restart nonces.
   Rolling is capped by Bitcoin's `MAX_FUTURE_BLOCK_TIME` (now + 2 h) —
   a header timestamp beyond it is consensus-invalid and only produces
   rejects, so the worker then marks the job's search space exhausted
   and waits for fresh work. The rolled `NTime` flows to the pool
   unchanged via the existing `submit` path (V1 param, V2 field).
   Wire-level check first: SRI's `NewMiningJob.min_ntime` is the floor,
   never a ceiling, so forward rolling is legal.

### Verified already-done / non-applicable this session

- ✅ **`NewMiningJob` wire layout** — verified against SRI
  `Sv2Option<u32>`: absent `min_ntime` IS the future-job marker (no
  separate `future_job` field); Otedama's decoder + hold-until-tip
  semantics are spec-correct.
- ✅ **SetupConnectionSuccess flags/version** — Otedama proposes
  Flags=0/MinVersion=MaxVersion=2, so any conformant response is the
  one expected; mismatches are informational only.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 271 increment (V2 pending-job bound)

### Implemented

1. ✅ **`jobState.pending` bounded to 256** — the V2 dialer holds every
   NewMiningJob it receives until a SetNewPrevHash names one (all
   others are discarded unread). Between tips a hostile or buggy
   upstream could stream job frames indefinitely → unbounded map
   growth. Now oldest-first insertion-order eviction caps it at
   `maxPendingJobs = 256` (real pools keep a handful open); newest
   arrivals — the ones most likely to be named next — are retained.
   Duplicate job_id overwrite adds no order entries. NewMiningJob's
   `min_ntime OPTION[u32]` wire layout was verified against the SRI
   reference (`Sv2Option<u32>`, `is_future()`) before touching the job
   state machine — the decoder is spec-correct, no `future_job` field
   exists in this message.

### Verified already-done / non-applicable this session

- ✅ **V2 unknown msg_type forward-compat** — `DispatchFrame` routes
  unrecognised types to `Message.Unknown` and the read loop continues
  (channel_msg extension frames are skipped safely).
- ✅ **verdict `sync.Map`** — bounded by submit rate × wait timeout;
  entries are deleted on settle and on caller return.
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.
- 🟡 **`client.reconnect` host/port never consumed** — the V1 session
  records the directive (`lastReconnect`, diagnostics) but the
  reconnect loop never retargets host:port. Deliberately deferred:
  honoring pool-directed redirects is a design decision (a malicious
  pool could point hashing at an attacker endpoint; reference miners
  differ). Logged for ADR discussion rather than implemented ad hoc.

---

## September 2026 research pass — session 270 increment (rate-feed NaN hardening)

### Implemented

1. ✅ **NaN guard on the rate plausibility band** — fuzz-sweep analysis
   of the exchange extractors (the next untrusted-input boundary after
   pool protocols): `strconv.ParseFloat` accepts the tokens "NaN",
   "Inf", "Infinity" (case-insensitive) where JSON numbers cannot
   express them, so the string-typed sources (Coinbase `amount`,
   Kraken `c[0]`) could return NaN. Every ordered comparison against
   NaN is false, so it slipped through `rate < min || rate > max` into
   the median and poisoned `f.rate` — corrupting every USD-denominated
   arbitration comparison downstream. doFetch now drops non-finite
   readings explicitly (±Inf was already caught by the bounds; only
   NaN needed the explicit check). Verified end-to-end via httptest.

2. ✅ **`FuzzRateExtractors`** — selector-dispatched fuzz over all
   three exchange extractors asserting no panic + no non-finite value
   survives the band. ~1.6M execs/22s, zero failures.

### Verified already-done / non-applicable this session

- ✅ **CoinGecko extractor** — unmarshals into `float64` directly, so
  NaN/Inf are syntax errors / `1e999` overflow errors at decode time;
  unreachable for non-finite values. (Parsers that go through
  ParseFloat were the only gap.)
- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.

---

## September 2026 research pass — session 269 increment (V2 message-decoder fuzz)

### Implemented

1. ✅ **`FuzzDecodeV2Message`** — one dispatch target over all twelve
   payload decoders (selector byte + payload); asserts the
   error-not-panic contract AND that a successfully decoded message
   re-encodes to a prefix of the input (Encode is the decoders'
   declared inverse). ~6M execs/25s, zero crashes — but it did find a
   spec violation (below).

2. ✅ **Strictly require the STR0_255 length byte on error messages** —
   fuzz-discovered: `DecodeSubmitSharesError` and
   `DecodeOpenMiningChannelError` silently accepted payloads truncated
   exactly at the fixed-field boundary (missing the required
   error_code length byte), producing a phantom empty reason and
   breaking the encode↔decode invariant. Both now reject payloads that
   omit the required field (`<9` / `<5` bytes). Existing tests pinning
   the non-conformant minimal payloads were updated to the spec's
   zero-length-string encoding (`\x00`) rather than an absent field.
   `DecodeSetupConnectionError`/`DecodeOpenMiningChannel` were already
   strict on the same field.

### Verified already-done / non-applicable this session

- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 remain latest.
- ✅ **V1 read path** already bounded (`maxLineBytes` + ReadSlice) — no
  unbounded-line-accumulation class on the V1 transport.

---

## September 2026 research pass — session 268 increment (V1 parser fuzz + extranonce2_size bound)

### Implemented

1. ✅ **Fuzz targets for the Stratum V1 parsers** — the V2 framing/Noise
   path had three fuzz targets; the V1 untrusted-input surface had zero.
   Six targets over parseNotify, parseDifficulty, parseSetExtranonce,
   parseReconnect, parseSubscribeResult, parseShowMessage asserting the
   error-not-panic contract and value invariants (JobID echo, params[0]
   echo, bounded sizes). ~1M execs per 8s target, no crashes.

2. ✅ **Pool-supplied `extranonce2_size` is now bounded** — a real bug
   the fuzzing was written to find: `extranonce2_size` from both
   `mining.subscribe` and `mining.set_extranonce` fed `strings.Repeat`
   on every submit; a negative value panics the submit path and a huge
   value forces an unbounded allocation. Both entry points now reject
   sizes outside [0, 64] (real pools use 4–8) and non-integral sizes in
   the subscribe envelope. `TestExtranonce2SizeBounds` pins the bound.

### Verified already-done / non-applicable this session

- ❌ **Upstream** — SRI v1.12.0 / ESP-Miner v2.15.3 still latest.
- ❌ **Cat 4 #7 pool-share awareness** — still gated on a pool-stats
  data source decision (recorded session 267).

---

## September 2026 research pass — session 267 increment (job-starvation watchdog)

### Implemented

1. ✅ **Cat 4 #9 second half — zombie-session detection.** The
   `otedama_last_job_received_seconds` gauge existed (session 93) but
   nothing acted on it inside the engine and no documented alert used
   it: a "connected" pool that silently stops delivering notify left
   the miner idle while every signal said healthy. Engine now warns
   once per incident when no job arrives for `jobWatchdogWarnAfter`
   (120 s, seeded at connect so a never-delivered first job is caught)
   and logs recovery; `OtedamaPoolSilent` alert + an SLO row added to
   DEPLOYMENT.md for Prometheus operators.
   New `TestRunSessionV1_JobStarvationWarn` drives a handshake-then-
   silent fake pool through warn + recovery deterministically (~50 ms).

### Verified already-done / non-applicable this session

- ✅ **Cat 5 #8** — USD→BTC via `provider.SatsPerSecond` unit-correct;
  simulated Akash yield is labelled "(simulated)" and feeds only the
  "est. earned" TUI figure, never real earnings accounting (recorded ✅).
- ❌ **Upstream** — SRI v1.12.0 still latest; ESP-Miner v2.15.3 deltas
  hardware/UI-specific, non-applicable.
- ❌ **Cat 4 #7 pool-share awareness** — needs a pool network-share data
  source the repo has no dependency for; stays open pending a maintainer
  decision on whether to fetch pool statistics at all.

---

## September 2026 research pass — session 266 increment (terminal-width detection)

### Implemented

1. ✅ **KNOWN_LIMITATIONS §15 — TUI real terminal width** — `SetWidth`
   had no production caller, so the dashboard always rendered at the
   hardcoded 80 columns; on narrower terminals lines wrapped and broke
   the cursor-repaint model. `engine.Run` now feeds the real column
   count via a new `outputWidth` helper: ioctl(TIOCGWINSZ) on unix,
   GetConsoleScreenBufferInfo on Windows — the x/term.GetSize mechanism
   on stdlib syscall, no dependency (same pattern as session-263's
   TTY gate, which is now unified with it under `ttySize`). Non-file
   writers (tests, pipes) keep the 80-col default; <40 clamps to 40.

### Verified already-done / non-applicable this session

- ❌ **Upstream deltas** — SRI v1.12.0 / ESP-Miner v2.15.3 swept in
  session 264; nothing newer this round.
- ❌ **KNOWN_LIMITATIONS §16 (`wallet` subcommand)** — left open: the
  doc itself gates it on a maintainer decision (CLI architecture map).
- ❌ **Qiita/Zenn sweep** — no new stratum-v2 material.

---

## September 2026 research pass — session 265 increment (worker-name plumbing + marker sweep)

### Implemented

1. ✅ **mining.submit sends the authorized worker identity** — the first
   `mining.submit` param is the worker name per the V1 spec, but the
   code sent the literal `"otedama"` while `mining.authorize` used the
   configured `address.worker`/`pool.User` identity — every share was
   attributed to a different worker than the authorized one, breaking
   per-rig stats and making per-worker pool diagnostics impossible.
   `session.user` now carries the authorized identity (default
   `"otedama"` only for sessions built without `Negotiate`). Test
   asserts the wire param.

### Verified already-done / non-applicable this session

- ✅ **Cat 7 #11 Provider dedup** — already done: `pollingProvider` in
  `internal/provider/polling.go` is the shared core (embeds, shared
  Stop/launch/loop, restartable `quoteCh` re-creation, distinct
  intervals/filters preserved). Stale ⬜ marker corrected.
- ✅ **Cat 5 #3 provider heartbeat** — already done: `streamStaleTimeout`
  pruning in `runArbitrationLoop` + `otedama_arbitration_streams`.
- ✅ **Cat 12 #1 Noise/frame overflow fuzzing** — already done
  (sessions 257–258); boundary seeds and invariants present.
- ❌ **Upstream deltas** — SRI v1.12.0 / ESP-Miner v2.15.3 swept in
  session 264; nothing newer.

---

## September 2026 research pass — session 264 increment (V2 reject-code taxonomy)

### Implemented

1. ✅ **rejectClass handles canonical SV2 SubmitSharesError codes** —
   V2 pools return spec machine codes (`stale-share`,
   `low-difficulty-share`, `invalid-job-id`, `duplicate-share`,
   `unauthorized-worker`, `not-subscribed`, `difficulty-too-low`), but
   the V1-prose matcher misfiled them: `low-difficulty-share` and
   `difficulty-too-low` fell to `other` (hyphen ≠ "low difficulty"),
   and `invalid-job-id` — a stale work reference — filed as
   `hardware`. Separators now normalize before matching; a `job`
   contains-test joins the stale branch (job-reference errors are
   work-obsolescence/desync, never chip faults); `difficulty` itself
   matches the difficulty branch; `unauthorized`/`not subscribed` get a
   new `auth` category ("check worker credentials") since the fix is
   neither latency nor hardware. SPECIFICATION/API metric docs updated
   for the new label value.

### Verified already-done / non-applicable this session

- ❌ **SRI v1.12.0 (Sep 17)** — codec/framing refactor, **AES-256-GCM
  removed from noise_sv2**, BIP323 adaptations. Otedama's Noise NX is
  ChaChaPoly-only (AESGCM never implemented) so the cipher removal is
  already spec-aligned; template/BIP323 changes are pool-side, N/A to
  a miner client.
- ❌ **ESP-Miner v2.15.2 stable (Sep 18) + v2.15.3 (Sep 20)** — BM137x
  ASIC support, networking/UI fixes, per-device-preset frequency
  warnings. All hardware/firmware/AxeOS-UI specific; Otedama has no
  device presets or ASIC drivers. N/A.
- ❌ **Qiita/Zenn sweep** — no new stratum-v2 material this round.

---

## September 2026 research pass — session 263 increment (seed-backup verification)

### Implemented

1. ✅ **Seed-backup verification prompt (Cat 3 #8)** — the reminder half
   existed since session 253 (`printRecoveryPhrase`); the verification
   half did not. After a new wallet prints its phrase,
   `confirmSeedBackup` asks the user to re-enter three random word
   positions (partial Fisher–Yates over crypto/rand, deterministic
   io.Reader in tests). Mismatch → phrase re-prints once and the prompt
   retries; second failure → warn + continue, because mining must never
   refuse to start over an unverified backup (the printed phrase is the
   canonical record). The gate is a real isatty — ioctl(TIOCGWINSZ) on
   unix, GetConsoleMode on Windows, x/term's mechanism with stdlib
   syscall and no new dependency — so service/daemon/`go test` launches
   never block. Pure helpers (`verifyWordPositions`,
   `pickWordPositions`) take io.Reader/io.Writer for scripted tests.

### Verified already-done / non-applicable this session

- ❌ **Upstream deltas** — SRI v1.11.1 and ESP-Miner v2.15.2rc0 remain
  latest; residual deltas hardware-specific (BM137x/WPA/UI), N/A.
- ❌ **Qiita/Zenn sweep** — no new stratum-v2 material this round.

---

## September 2026 research pass — session 262 increment (observability docs + audit)

### Implemented

1. ✅ **SLO documentation (Cat 9 #10)** — `docs/DEPLOYMENT.md` "Service-level
   objectives": productive uptime (productive_seconds/uptime_seconds ≥99.5 %/30 d),
   pool connectivity, share acceptance ≥99.5 %, stale <0.5 %, p99 submit
   latency <500 ms, pending/unaccounted baselines — each with act-now
   thresholds tied to the existing D-Central bands.

### Verified already-done / non-applicable this session

- ✅ **Cat 10 #9 constant-time comparison audit** — clean: no in-repo
  secret/MAC comparisons exist (seed unlock and AEAD verifies are
  stdlib-internal and already constant-time; `crypto/subtle` has no call
  sites because nothing needs wrapping). Re-audit when the real secp256k1
  NX flow lands.
- ❌ **Upstream deltas** — SRI v1.11.1 remains latest; ESP-Miner
  v2.15.2rc0 swept in session 261 (hardware-specific remainder N/A).
- ❌ **Qiita/Zenn sweep** — no new stratum-v2 material.

---

## September 2026 research pass — session 261 increment (counter-reconciliation fix)

### Implemented

1. ✅ **`otedama_shares_pending` drains on submit failure** (Cat 1 #10
   completion). `sharesSubmitted` is incremented at send time, but a
   share whose `Submit` then fails outright (session dropped mid-flight,
   ctx canceled) was never subtracted from the pending gauge — the pool
   can never return a verdict for it, so `shares_pending` pinned above
   zero for the rest of the run after any disconnect, hiding the very
   signal the gauge exists to show. New counter
   `otedama_shares_submit_failures_total` is subtracted in the pending
   formula (`pending = submitted − judged − transition − submit-failed`,
   clamped ≥0); failed submits still count inside `shares_unaccounted`
   (they were found but never pool-judged — `unaccounted = pending +
   dropped + submit-failed`). `docs/SPECIFICATION.md` metric table and
   the gauge/counter help text updated to match.

### Verified already-done / non-applicable this session

- ✅ **ESP-Miner v2.15.1 #1913 (reconnect storms from slow clients)** —
  implemented in session 257 (non-blocking V2 job emit, drop-oldest +
  clean-purge). v2.15.2rc0's remaining delta is BM1372/BM1373 ASIC
  driver code + WPA/display/UI fixes — hardware/firmware-specific, N/A.
- ✅ **Stale status markers corrected** — Cat 1 #10 (done this session),
  Cat 2 #6 (implemented session 65, marker was stale 🟡), Cat 2 #8
  (done session 259, marker was stale 🔵).
- ❌ **SRI releases** — v1.11.1 remains latest; its difficulty-rounding
  fix stays non-applicable (raw U256 transport, no float conversion).

---

## Highest-leverage next actions (cross-category synthesis)

Ranked by impact on the path to a real v3.1.0:

1. **secp256k1 (Cat 10 #1 / Cat 2 #3)** — unblocks the real SV2 encrypted
   channel; library identified, licence compatible. Needs an ADR for the
   dependency decision.
2. ~~**engine→poolproto wiring (Cat 2 #8)**~~ — ✅ done (session 259).
3. **Reject-reason classification + reject-rate metric (Cat 1 #1–2, Cat 9 #4)**
   — small, high-value observability win that directly reflects miner
   profitability and needs no new dependency. Largely landed (sessions
   61/255); remainder is per-reason pool histogram polish.
4. **Real Akash REST (Cat 5 #1)** — removes the largest remaining "simulated"
   placeholder; larger effort, external API.
5. ~~**Submit-latency + pool-state metrics (Cat 2 #7, Cat 9 #5/#7)**~~ —
   ✅ done: V2 verdict correlation (259) made submit latency honest;
   pool-state gauges verified present (260); Nagle fix cut the RTT floor
   (260); pending gauge now drains on submit failure (261), so the
   reconciliation set is complete and honest across reconnects.

Items 3 and 5 are the cheapest real-code wins with no dependency or
external-API risk, and are the natural next implementation targets after the
research-only passes.

---

*Sources: arXiv (1703.06545, 1811.12852, 2105.04373, 2411.11119, 2505.00303,
1012.3005, 2405.05950, 2503.12285, 2107.05322, 2506.19333, 2410.13784);
GitHub (decred/dcrd secp256k1, bitaxeorg/ESP-Miner #1383); D-Central, Coin
Bureau, Solo Satoshi, Simple Mining 2026 pool comparisons on payout schemes
(FPPS/PPLNS/TIDES) and net-yield/reliability; cgminer/bfgminer/Awesome Miner
feature comparisons.*

*Session-277 additions (September 2026): the last plain shared V1
field (`session.user`) is atomic too — no reliance on call ordering.*

*Session-276 additions (September 2026): a V1 set_difficulty value
TargetFromDifficulty cannot represent now warns once instead of
silently degrading to the block target.*

*Session-275 additions (September 2026): V1 extranonce fields are
atomic — mid-session set_extranonce rotation raced against Submit's
extranonce2Size read.*

*Session-274 additions (September 2026): malformed V1 notify hex fields
now drop the job into the starvation watchdog instead of minting silent
rejects, and a job whose nTime already exceeds now+2h warns at apply
time rather than stalling unnoticed.*

*Session-273 additions (September 2026): pool job IDs are now opaque
strings echoed verbatim on submit — non-decimal V1 job IDs (Braiins,
F2Pool, public-pool) no longer stall every notify.*

*Session-272 additions (September 2026): the CPU grind loop now rolls
nTime on nonce wrap (capped at MAX_FUTURE_BLOCK_TIME) instead of
re-hashing the same nonce space into duplicate-share rejects.*

*Session-271 additions (September 2026): the V2 pending-future-job
set is bounded (oldest-first eviction at 256) so a hostile upstream
cannot grow memory between tips; pool-directed client.reconnect
redirects are logged as an ADR-level design question, not wired ad hoc.*

*Session-270 additions (September 2026): the BTC/USD rate feed — the
last un-audited untrusted-input boundary (HTTP exchange responses) —
is fuzzed; NaN/Inf readings that ParseFloat admits but JSON cannot
express are dropped before the median.*

*Session-269 additions (September 2026): SV2 payload decoders get a
dispatch fuzzer with an encode↔decode round-trip invariant — found a
spec violation where error frames could omit the STR0_255 length byte.*

*Session-268 additions (September 2026): Stratum V1 parser fuzz
coverage parity with the V2 path; extranonce2_size bounds-checking
class (untrusted length fields must never reach Repeat/allocation
unvetted).*

*Session-267 additions (September 2026): zombie-session / job-starvation
detection pattern (connected-but-silent Stratum sessions) — standard
operator guidance codified in-engine and in the DEPLOYMENT alert set.*

*Session-266 additions (September 2026): golang.org/x/term GetSize /
IsTerminal mechanism (TIOCGWINSZ, GetConsoleScreenBufferInfo)
replicated via stdlib syscall for TUI width detection — closes
KNOWN_LIMITATIONS §15 without a new dependency.*

*Session-265 additions (September 2026): Stratum V1 spec §mining.submit
worker-name param attribution; provider-lifecycle audit confirming
pollingProvider/stale-stream coverage.*

*Session-264 additions (September 2026): sv2-spec canonical
SubmitSharesError codes (stale-share, low-difficulty-share,
invalid-job-id, duplicate-share, unauthorized-worker, not-subscribed,
difficulty-too-low); stratum-mining SRI v1.12.0 release notes
(AES-256-GCM removed from noise_sv2, codec refactor, BIP323);
bitaxeorg/ESP-Miner v2.15.2 + v2.15.3 (device-preset warnings).*

*Session-263 additions (September 2026): BIP-39 backup-verification UX
patterns (electrum/sparrow word-position re-entry); golang.org/x/term
IsTerminal mechanism replicated via stdlib syscall (no new dependency).*

*Session-261 additions (September 2026): bitaxeorg/ESP-Miner v2.15.1 +
v2.15.2rc0 deltas (#1913 verified done in session 257; BM137x ASIC
drivers, WPA/display/UI fixes N/A); Cat 1 #10 reconciliation completed
via the submit-failures counter.*

*Session-260 additions (September 2026): bitaxeorg/ESP-Miner release
v2.15.0 delta (#1722 TCP_NODELAY, #1799, #1796, #1779); bitcoin/bitcoin
PR #30675 (Nagle/delayed-ACK ~40 ms request/response stalls); suprnova
stratum latency analysis; stratum-mining SRI v1.11.1 notes; Qiita/Zenn
stratum/ASIC sweep.*

*Session-51 additions (June 2026): arXiv (2309.06847 undetectable selfish
mining; 2211.07270 block-withholding resilience; 2601.02496 APoW; 2601.14612
ROSS randomized spot scheduling; 2601.09042 SCaLE switching-cost bandit;
2506.02980 non-stationary BCO, NeurIPS 2025; 2509.11134 GFS, ASPLOS '26;
2511.16376 LN payment-failure times, BRAINS 2025; 2405.12087 LN channel-balance
interpolation; 2006.12143 Counting Down Thunder). Software/specs: stratum-mining
SRI v1.5.0 release + sv2-spec (04-Protocol-Security); bitaxeorg/ESP-Miner
(#212, releases); Akash provider REST/gRPC + SDK docs; Vast.ai REST/bidding
docs; Octopus Agile, Tibber, Amber, WattTime (MOER), Electricity Maps APIs;
sigstore/cosign + slsa.dev; OpenSSF Scorecard + osv-scanner;
prometheus/client_golang v1.23 + OpenMetrics 1.0 + Prometheus naming practices;
Go vuln advisories CVE-2025-22871, GO-2025-3563. All arXiv IDs verified against
the arXiv listing; all API endpoints against current vendor documentation.*
