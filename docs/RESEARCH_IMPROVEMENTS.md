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
   (<0.5% excellent … >3% act now) is derivable in Prometheus from this
   plus `otedama_shares_total`; a built-in warning gauge is the remaining
   sub-task.
3. 🟡 **Do not count `Method not found` setup responses as rejected shares.**
   ESP-Miner #1383: pools like OCEAN reject `mining.suggest_difficulty` /
   `extranonce.subscribe` with "Method not found"; counting these as share
   rejects corrupts the reject rate. Otedama is Stratum-V2-first so less
   exposed, but the V1 fallback path must guard against this.
4. ✅ **Multi-pool failover** (session 42) — matches cgminer/bfgminer.
5. ✅ **Hashrate-drop detection** (session 43, HashrateMonitor) — matches
   Awesome Miner triggers.
6. 🔵 **Temperature-based throttling / shutdown.** Awesome Miner triggers on
   temperature thresholds. Tracked in ADR-008 sub-domain 6 (thermal).
7. 🟡 **Per-device share statistics** (accepted/rejected/HW-error per worker),
   as cgminer reports. Otedama aggregates; per-device would aid diagnosis.
8. 🔵 **Solo-mining mode** (bfgminer auto-fails-over to solo+local block
   submission when Bitcoin Core is present). Tracked in ADR-009.
9. ❌ **Multi-algorithm (Scrypt/Ethash) support** — out of scope; Otedama is
   SHA-256d/Bitcoin-only by ADR-002.
10. 🟡 **"Trust the pool's numbers" reconciliation.** Local counters drift
    from pool-side truth; a periodic reconciliation against pool stats
    (where the pool exposes them) would catch silent miscounting.

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
5. 🟡 **`extranonce.subscribe` / `suggest_difficulty` handling on the V1
   fallback** — see Category 1 item 3.
6. 🔵 **DATUM / OCEAN template source** — ADR-009; `engine.parseHost` already
   accepts `datum://` (session 37).
7. ✅ **Share-submission latency histogram** (session 46). `LatencyTracker`
   records submit→accept RTT in a ring buffer; p50/p95/p99 are logged and
   exported as `otedama_submit_latency_milliseconds{quantile=...}`. Since
   stale shares are latency-driven, this tells operators when to switch to
   a closer pool *before* it costs them in the reject rate.
8. 🔵 **engine→poolproto wiring** (the dialers aren't imported yet, so
   `init()` doesn't register them) — KNOWN_LIMITATIONS §3, step 3b.
9. 🟡 **Graceful handling of `SetNewPrevHash` / clean-jobs flag** to drop
   stale work immediately on new block — reduces stale rejects.
10. 🟡 **Protocol-version negotiation logging** so operators can confirm which
    transport (V2/V2TLS/V1) actually got used.

---

## Category 3 — Non-custodial crypto wallets

1. ✅ **BIP-39 complete 2048-word list, SHA-256 verified** (session 32).
2. ✅ **Encrypted seed at rest** (scrypt + AES-GCM, seedstore.go).
3. ✅ **Receive-only by design** — never holds spending keys for others.
4. 🔵 **BOLT12 offers for payouts** — ADR-007 B1.
5. 🟡 **BIP-39 passphrase (25th word) support** — standard hardening; verify
   whether the current seed derivation accepts an optional passphrase.
6. 🟡 **Wallet fingerprint display for verification** — partially present
   (fingerprint file); surface it in `config show` / first-run output so
   users can cross-check against a hardware wallet.
7. 🔵 **PSBT export for hardware-wallet payout addresses** — ADR-007 B10.
8. 🟡 **Seed backup reminder / verification flow** on first run (ask the user
   to re-enter N words) — reduces fund-loss from un-backed-up seeds.
9. 🔵 **Output descriptor / xpub import** so payouts go to a watch-only
   wallet the user controls.
10. 🟡 **Address-type validation breadth** — confirm bech32m (P2TR) is
    accepted, not just bech32 (P2WPKH), since taproot payout addresses are
    now common.
11. 🟡 **Payout-scheme awareness (FPPS / PPLNS / TIDES).** 2026 pool
    comparisons converge on one message: *compare net BTC retained, not the
    headline fee* — FPPS smooths variance (pool absorbs it), PPLNS is cheaper
    but variance falls on the miner, TIDES (OCEAN) is non-custodial and pays
    into the coinbase. Otedama's non-custodial stance aligns with
    TIDES/PPLNS. Improvement: surface the configured pool's payout scheme
    (where known) and its variance/custody trade-off in `doctor`.
12. 🟡 **Effective-yield accounting > fee rate.** The comparisons stress
    *"reliability dwarfs fee differences"* — a 4% uptime gap can cost ~4× a
    1% fee gap. ✅ First piece shipped (session 48):
    `otedama_share_acceptance_rate` = accepted/(accepted+rejected), logged
    and warned-on below 97%, since every rejected share is unpaid work. The
    remaining piece is folding downtime/stall time into a single gross-minus-
    losses yield estimate.

---

## Category 4 — P2P / pool decentralisation

1. 🔵 **SV2 Job Declarator Client** — ADR-009, triggered by the May 2026 SV2
   working-group expansion (~70% hashrate).
2. 🔵 **Solo mining against a local bitcoind** — ADR-009.
3. 🔵 **OCEAN DATUM integration** (C→Go port) — ADR-009.
4. ✅ **Non-aggregating stance** — Otedama never pools others' hashrate
   (ADR-001), a deliberate decentralisation choice.
5. 🟡 **Stratum endpoint diversity check** in `doctor` — warn if all
   configured pools resolve to the same operator/ASN (centralisation risk).
6. 🔵 **TemplateSource abstraction** — ADR-009 lets a URL scheme select
   pool/JDC/solo template provenance.
7. 🟡 **Pool-share-of-hashrate awareness** — optionally inform the user when
   their chosen pool exceeds a large network share, nudging decentralisation.
8. ❌ **Running a pool server** — explicitly out of scope (ADR-001).
9. 🟡 **Block-template freshness metric** — time since last template; a stale
   template source is a silent failure.
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
6. 🟡 **Spot-price volatility guard** — don't thrash between mining and
   inference on noisy price ticks (hysteresis already exists in arbitration;
   confirm it covers the inference side).
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

---

## Category 7 — Go CLI / systems tools

1. ✅ **Subcommand structure** (run/version/config/service/doctor) with
   per-command `--help`; all 11 covered by tests.
2. ✅ **Background-service install** (launchd/systemd/Task Scheduler).
3. ✅ **Structured logging** (text/JSON via slog-style adapter).
4. ✅ **`doctor` self-diagnostics**.
5. 🟡 **`--version --json` machine-readable output** for CI/monitoring; verify
   it exists.
6. 🟡 **Shell completion generation** (`otedama completion bash|zsh|fish`) —
   table-stakes for a polished CLI.
7. 🟡 **`GODEBUG`/pprof opt-in endpoint** behind a flag for field debugging
   (already have an HTTP server; could mount `/debug/pprof`).
8. 🟡 **Config precedence documentation** (flags > env > file > defaults) and
   an `otedama config show --origin` annotating where each value came from.
9. ✅ **Graceful shutdown on SIGINT/SIGTERM**.
10. 🟡 **Exit-code contract documented** (0 ok, 1 runtime, 2 usage) in the man
    page / README for scripting.

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
8. 🟡 **J/TH efficiency metric in the TUI/metrics** — the single number miners
   optimise; expose `joules_per_terahash` from power draw ÷ hashrate.
9. 🟡 **Idle/curtailment hook** — a clean "pause hashing when price > X" path
   that the tariff feed can drive (precursor to full demand response).
10. 🟡 **Carbon-intensity feed (optional)** — for users who want to mine on
    low-carbon grid windows; aligns with SUSTAINABILITY.md.

---

## Category 9 — Observability / monitoring

1. ✅ **Prometheus text-format `/metrics`** without a client dependency
   (ADR-005).
2. ✅ **Health endpoint** + `ServeError()` accessor (session 31).
3. 🟡 **OpenTelemetry traces** for the connect→handshake→mine span — ADR
   mentions OTel; confirm spans exist on pool dial and submit.
4. 🟡 **Reject-rate & stale-rate gauges** (ties to Category 1).
5. ✅ **Submit-latency quantiles** (session 46) — see Category 2 item 7.
6. 🟡 **`otedama_up` / readiness reflecting HashrateMonitor.Stalled()** so a
   scrape can alert on a stalled miner.
7. 🟡 **Pool-connection state gauge** (connected/reconnecting/failed + current
   pool index) — failover is now implemented (session 42) but not yet
   observable as a metric.
8. ✅ **Structured JSON logs** with level filtering.
9. 🟡 **Build-info metric** (`otedama_build_info{version,commit}`) — standard
   Prometheus convention for fleet version tracking.
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
