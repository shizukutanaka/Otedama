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
10. 🟡 **"Trust the pool's numbers" reconciliation.** Local counters drift
    from pool-side truth; a periodic reconciliation against pool stats
    (where the pool exposes them) would catch silent miscounting.
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
8. 🔵 **engine→poolproto wiring** (the dialers aren't imported yet, so
   `init()` doesn't register them) — KNOWN_LIMITATIONS §3, step 3b.
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
8. 🟡 **Seed backup reminder / verification flow** on first run (ask the user
   to re-enter N words) — reduces fund-loss from un-backed-up seeds.
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
10. 🔵 **Stratum V2 header-only / coinbase negotiation** for censorship
    resistance — part of the JDC story (ADR-009).

---

## Category 5 — AI inference / compute markets

1. 🟡 **Real Akash REST integration** — currently simulated
   (KNOWN_LIMITATIONS §1). The single biggest placeholder.
2. 🔵 **Strategic bidding on Akash** — ADR-010 A4.
3. 🟡 **Provider health/heartbeat** — detect a dead inference provider and
   stop routing GPUs to it (parallels HashrateMonitor for mining).
4. 🟡 **GPU suitability scoring per workload** (VRAM, FP16/INT8 throughput)
   so inference jobs map to capable GPUs only.
5. 🔵 **Per-device suitability assignment** — ADR-010 A3 (Hungarian).
6. ✅ **Spot-price volatility guard** — hysteresis exists in arbitration and
   now has a user-configurable knob: `arbitration_hysteresis_pct` (YAML) /
   `OTEDAMA_ARBITRATION_HYSTERESIS_PCT` (env), default 0.05 (5%). Applies
   to all workload switches (mining ↔ AI). Validation rejects values outside
   [0.0, 1.0). (session 108)
7. 🔵 **Sharpe-ratio preference** to favour stable yield — ADR-010 A5.
8. 🟡 **Inference revenue is denominated/settled correctly** — verify USD→BTC
   conversion path and that simulated vs real yield is never mixed in
   accounting.
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
11. ⬜ **Deduplicate the two `Provider` implementations** (maintainability;
    recorded per CLAUDE.md rule I3 — "log duplication as an issue, don't fix
    ad hoc"). `MiningProvider` and `AkashProvider`
    (`internal/provider/{mining,ai_inference}.go`) share substantial
    boilerplate: `Stop()` is **byte-identical** (cancel → `wg.Wait()` → nil
    the cancel → re-create the buffered `quoteCh`); `loop()` is identical
    except the tick interval (30 s vs 60 s); `Start()` differs only in the
    device filter (mining accepts all SHA-256d devices, Akash filters to
    GPUs with `GeneralCompute`); and the channel "drop-oldest when full"
    send pattern in `publish()` is copied in both. A small shared core — e.g.
    an unexported `baseProvider` holding `{quoteCh, cancel, wg, mu}` with
    shared `Stop()`, a `runLoop(interval, publishFn)`, and a `sendQuote()`
    helper — would remove ~60 LOC and one class of drift bug. **Trade-off to
    weigh before doing it:** the providers are deliberately simple and
    independent (Pike: "boring over clever"); a shared base adds an
    abstraction. A refactor must preserve three load-bearing behaviours: the
    `quoteCh` re-creation in `Stop()` (so a stopped provider can be
    restarted — see `TestMiningProvider_StopClearsStateForRestart`), the
    buffered drop-oldest semantics, and the distinct tick intervals/device
    filters. Verdict: worth doing as one focused refactor session with the
    existing provider tests as the safety net; not urgent (no correctness
    impact today).
12. 🟡 **`TestRunSession_StatsTickAndShareResponses` is flaky under heavy
    CPU contention** (`internal/engine/run_test.go`; found session 239).
    It asserts a "submit latency" log line appears within a fixed
    real-time window, which requires the session loop's 5ms stats ticker
    to win a `select` slot against two channels (`inCh`/`opts.merged`)
    that are effectively always ready while the test's fake pool streams
    shares continuously — under `go test ./...`'s full parallel load the
    ticker case can be intermittently starved long enough to miss the
    window even though every individual protocol step completes in
    milliseconds in isolation. Confirmed pre-existing (same fragile
    structure at commit `2faae1f`, before this session). Mitigated by
    doubling the test's timeout (2s→4s), which measurably reduces but
    does not eliminate the flake under extreme contention — further
    timeout increases showed no additional benefit in testing. A
    thorough fix decouples the assertion from ticker-selection fairness
    entirely: assert on `LatencyTracker`'s recorded sample count directly
    rather than requiring a specific log line within a fixed real-time
    window.

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
10. 🟡 **SLO documentation** (target uptime, p99 submit latency) to make the
    metrics actionable.

---

## Category 10 — Cryptography / security

1. 🟡 **Replace the P-256 Noise stub with real secp256k1.** Confirmed
   canonical library: `github.com/decred/dcrd/dcrec/secp256k1/v4` — pure Go,
   ISC (copyfree) licence, imported-by 150+, provides ECDH and Schnorr.
   This is the concrete unblocker for KNOWN_LIMITATIONS §2. **Tension with
   ADR-003 (zero runtime deps):** ISC is permissive and the package is pure
   Go with no transitive deps, so vendoring it is consistent with the spirit
   of ADR-003 — but the decision should be recorded in a new ADR.
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
9. 🟡 **Constant-time comparison audit** for any secret/MAC comparisons in the
   handshake and seed paths (use `crypto/subtle`).
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
3. 🟡 **Strip BIP141 (segwit) fields from the coinbase on Extended Jobs.**
   Also fixed in SRI v1.5.0: a client assembling the coinbase from
   `coinbase_tx_prefix`/`suffix` must hash the *non-witness* serialization
   or every share is rejected on a wrong merkle root. Add a segwit-coinbase
   regression fixture to the path feeding `engine.applyJob`.
   (stratum-mining/stratum v1.5.0)
4. 🟡 **Don't count post-`set_difficulty` "above-target" rejects.** ESP-Miner
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
6. 🟡 **Saturate/reset hashrate counters on reconnect.** ESP-Miner shipped a
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
7. 🟡 **Pin protocol truth to `stratum-mining/sv2-spec`, not the app code.**
   SRI split roles into a separate, independently-versioned repo after
   v1.5.0; update the SV2 reference links in ADR-009 / poolproto comments
   to cite the (stable) spec so the codec tracks the spec, not moving code.

### Category 4 — decentralisation (arXiv grounding)

8. 🟡 **Single-pool concentration enables *undetectable* attacks.** Bahrani &
   Weinberg, "Undetectable Selfish Mining" (arXiv:2309.06847), prove a
   selfish-mining strategy whose orphan pattern is statistically
   indistinguishable from honest mining, profitable from 38.2% hashrate.
   Document in THREAT_MODEL to justify the multi-pool / endpoint-diversity
   defaults as a *security* (not merely liveness) property; strengthens
   Cat 4 #7.
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

1. 🟡 **Fuzz the Noise/frame length arithmetic for overflow (SRI lesson).** SRI
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

## Highest-leverage next actions (cross-category synthesis)

Ranked by impact on the path to a real v3.1.0:

1. **secp256k1 (Cat 10 #1 / Cat 2 #3)** — unblocks the real SV2 encrypted
   channel; library identified, licence compatible. Needs an ADR for the
   dependency decision.
2. **engine→poolproto wiring (Cat 2 #8)** — makes the V2 dialer and job
   bridge (already built and tested) actually load-bearing; removes the
   dead-code state.
3. **Reject-reason classification + reject-rate metric (Cat 1 #1–2, Cat 9 #4)**
   — small, high-value observability win that directly reflects miner
   profitability and needs no new dependency.
4. **Real Akash REST (Cat 5 #1)** — removes the largest remaining "simulated"
   placeholder; larger effort, external API.
5. **Submit-latency + pool-state metrics (Cat 2 #7, Cat 9 #5/#7)** — cheap,
   makes the new failover and stale-share story observable.

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
