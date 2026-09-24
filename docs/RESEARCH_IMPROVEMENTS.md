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
6. 🟡 **Partially resolved — Temperature-based throttling** (session 273).
   OS-visible device temperature now gates hashing: `thermal_throttle_above_celsius`
   pauses hashing when the hottest hwmon sensor reaches the threshold and
   resumes 5 °C below it (hysteresis), with per-sensor
   `otedama_thermal_sensor_celsius` metrics. Covers the Awesome Miner-style
   device-temperature triggers on Linux (k10temp/coretemp/amdgpu/nvme).
   Remaining: external ambient sensors (Home Assistant/1-Wire) and
   power-limit derating remain ADR-008 sub-domain 6 (v3.6) scope; macOS/Windows
   thermal sources are unimplemented (gate sees no data and stays off).
   — **Verified infeasible on arm64 macOS (session 337):** no rootless
   thermal source exists — `machdep.xcpm` sysctls are Intel-only,
   `powermetrics` requires root, and the SMC/IOKit path needs CGO, which
   ADR-003 rules out. Same for Windows (WMI calls would need CGO/syscalls
   beyond stdlib). The remaining half is a platform-policy constraint,
   not an implementation gap.
7. ✅ **Per-device share statistics** (session 109) — `Share.DeviceID` propagated
   from `WorkerConfig.DeviceID`; lazy `otedama_device_shares_found_total{device=...}`
   counter in `engineMetrics`; 7 new tests.
8. 🔵 **Solo-mining mode** (bfgminer auto-fails-over to solo+local block
   submission when Bitcoin Core is present). Tracked in ADR-009.
9. ❌ **Multi-algorithm (Scrypt/Ethash) support** — out of scope; Otedama is
   SHA-256d/Bitcoin-only by ADR-002.
10. ✅ **"Trust the pool's numbers" reconciliation — RESOLVED (session 261).**
    Stratum V1 pools expose no server-side share stats to poll, so the
    reconciliation is necessarily local: `otedama_shares_unaccounted`
    (found − judged, clamped ≥0) already existed; session 261 adds the
    `unaccountedWatchdog` operator alert — a `warn` log when the backlog
    stays ≥8 shares for 3 consecutive stats ticks, with a "drained" info
    on recovery. Wired in the shared sessionTelemetry tick covering both
    the V1 and V2 session loops (session 310, ported from the session-261
    sibling branch). Original
    finding: "Trust the pool's numbers" reconciliation. Local counters
    drift from pool-side truth; a periodic reconciliation against pool
    stats (where the pool exposes them) would catch silent miscounting.
11. 🟡 **ASIC hardware detection — partially resolved** (sessions 304,
    331, 332). `hal.ASICDriver` probes operator-listed `asic_endpoints`
    over the cgminer RPC API (Antminer/Whatsminer/Avalon/Braiins/Bitaxe
    dialects) so owned ASICs appear as `hal.Device`s; the opt-in
    `asic_manage` flag then pushes the currently-connected SV1 pool to
    each miner via `addpool`/`switchpool`, and
    `otedama_asic_pool_switches_total{pool_host}` + the doctor "ASIC
    endpoints" check expose actuation and endpoint reachability.
    What remains ADR-tracked 🔵: *work dispatch* — cgminer appliances
    fetch their own work over stratum, so Otedama cannot feed them
    shares; making an ASIC a first-class arbitrated worker (SHA256d
    dispatch, per-ASIC yield attribution) is the ADR-008 sub-domain 1
    scope.

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
   **Session 294:** the complementary client→pool direction is now sent
   too — one `mining.suggest_difficulty` per session, fired once the
   local hashrate is first measured (diff = H × 15 s / 2³²), via the new
   `poolproto.DifficultySuggester` optional interface. It targets the
   case item 5's note covers from the other side: on a pool default
   difficulty calibrated for ASICs, a CPU/GPU device produces no shares
   at all, so pool-side var-diff has nothing to bootstrap from.
6. 🔵 **DATUM / OCEAN template source** — ADR-009; `engine.parseHost` already
   accepts `datum://` (session 37).
7. ✅ **Share-submission latency histogram** (session 46). `LatencyTracker`
   records submit→accept RTT in a ring buffer; p50/p95/p99 are logged and
   exported as `otedama_submit_latency_milliseconds{quantile=...}`. Since
   stale shares are latency-driven, this tells operators when to switch to
   a closer pool *before* it costs them in the reject rate.
8. ✅ **engine→poolproto wiring** — RESOLVED (sessions 283–285).
   The `poolproto/stratumv2` adapter is a complete drop-in Session:
   Submit carries a real monotonically increasing `sequence_number` and
   blocks for the pool's verdict (SubmitSharesSuccess acks all seqs ≤
   `last_sequence_number`; SubmitSharesError matches by seq; ctx expiry
   returns the documented provisional result, flagged `Unconfirmed`),
   `SetTarget` frames update `SuggestedDifficulty`
   (`miner.DifficultyFromTarget`) and re-issue the active job so the new
   U256 target applies immediately, and `Job.Target` plus
   `ShareResult`'s batch accounting counters carry everything the
   engine's share-rate accounting needs. Session 285 completed the
   engine-side switch-over: `stratum+v2://`/`stratum+v2tls://` URLs now
   run `runSessionV2` consuming `poolproto.DialURL`, the ~350-line
   inline V2 handshake/session loop (`handshake`, `sendMsg`,
   `updateWork`, `parseHost`, the `poolMsg` pipeline) is deleted, the
   adapter's `Dial` performs a real certificate-verified TLS handshake
   for `stratum+v2tls://`, and `poolproto.ChannelIdentifier` surfaces
   the negotiated channel ID. The V1/V2 loops share the
   `sessionTelemetry`/`dialPool`/`dispatchJob` helpers (KNOWN_LIMITATIONS
   §3 closed).
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
8. ✅ **Seed backup reminder / verification flow — RESOLVED (session 313,
   ported from the session-264 sibling branch).**
   First-run creation now prompts the operator to re-enter 3 randomly
   chosen words (one retry with fresh positions on a miss) immediately
   after the phrase is printed — the only window where a transcription
   error is still fixable. Constant-time word compare; skipped silently
   on non-terminal stdin so unattended first runs never block;
   `--no-wallet-backup-check` opt-out. Original finding: Seed backup
   reminder / verification flow on first run (ask the user to re-enter
   N words) — reduces fund-loss from un-backed-up seeds.
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
7. ✅ **Pool-share-of-hashrate awareness. — RESOLVED (session 310, ported
   from the session-267 sibling branch).**
   `internal/rates.FetchPoolNetworkShare` queries mempool.space's weekly
   mining-pool distribution once per connected pool host; a hostname match
   (name/slug/link-domain normalisation, ≥5-rune substring rule so "pool"
   labels cannot false-match) sets `otedama_pool_network_share{pool_host}`
   and warns once at ≥30% share — the concentration the undetectable
   selfish-mining finding (Bahrani & Weinberg, arXiv:2309.06847) relies on.
   `--no-pool-share-check` opts out (privacy); unknown/private pools stay
   silent. Original finding: optionally inform the user when their chosen
   pool exceeds a large network share, nudging decentralisation.
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
3. ✅ **Provider health/heartbeat** — detect a dead inference provider and
   stop routing GPUs to it (parallels HashrateMonitor for mining).
   Routing-stop half was already live (`pruneStaleStreams` after 3m +
   Beta-Bernoulli failure update); the observability half shipped session
   292: `otedama_stream_last_quote_unixtime{stream,device}` publishes each
   stream's last-quote timestamp (quote age = `time() − value`, alertable
   before and independently of the prune), keeps its final timestamp after
   pruning as the dead-provider evidence, and stream expiry now logs at
   warn (was info).
4. 🟡 **Partially resolved** (session 316, ported from the session-271
   sibling branch). The VRAM dimension landed:
   `hal.Capabilities.MemoryBytes` is populated from amdgpu sysfs
   `mem_info_vram_total` (0 = unknown — NVIDIA's proprietary driver and
   iGPUs expose no node, and unknown is never treated as too-small),
   `arbitration.Stream.MinMemoryBytes` gates candidacy via
   `Stream.SuitableFor`, and the plumbing runs `Quote.MinMemoryBytes` →
   `updateStream` → stream. The simulated Akash provider advertises a
   4 GiB floor, so an amdgpu under 4 GiB is now positively excluded from
   inference assignment. Still open: FP16/INT8 throughput is not exposed
   via sysfs (needs a vendor API — out of the zero-CGO constraint), so
   scoring is capacity-only; and per-device assignment ranking stays
   ADR-010 A3 (Hungarian). Original finding: "GPU suitability scoring per
   workload (VRAM, FP16/INT8 throughput) so inference jobs map to capable
   GPUs only."
5. 🔵 **Per-device suitability assignment** — ADR-010 A3 (Hungarian).
6. ✅ **Spot-price volatility guard** — hysteresis exists in arbitration and
   now has a user-configurable knob: `arbitration_hysteresis_pct` (YAML) /
   `OTEDAMA_ARBITRATION_HYSTERESIS_PCT` (env), default 0.05 (5%). Applies
   to all workload switches (mining ↔ AI). Validation rejects values outside
   [0.0, 1.0). (session 108)
7. ✅ **Sharpe-ratio preference** to favour stable yield — ADR-010 A5,
   shipped (session 290): `income_mode` config/`OTEDAMA_INCOME_MODE` env
   (`max`/`smooth`/`balanced`); modified Sharpe `(yield − min_yield floor)/σ`
   over Welford variance of observed yields; unproven-volatility streams
   score Sharpe 0 (unproven risk ≠ zero risk); balanced blends
   `0.5·normalized-yield + 0.5·normalized-Sharpe`. No CLI flag (hysteresis
   precedent).
8. ✅ **Inference revenue is denominated/settled correctly** — USD→BTC
   conversion verified (SatsPerSecond + 20% fee + "(simulated)" suffix,
   session 267); the accounting half shipped session 291: `Quote.Simulated`
   propagates to `Stream.Simulated`, `arbitration_expected_yield_sats_
   per_second` counts live-market streams only, and simulated yield
   publishes to the separate `arbitration_simulated_yield_sats_per_second`
   gauge — so the TUI's lifetime-sats accumulator (which reads the real
   gauge) can no longer accrue modeled revenue. `arb explain` marks
   simulated rows "(sim)".
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
7. 🟡 **Holt-Winters short-horizon forecaster** — ADR-010 A1 (chosen over ML).
    — 🟡 **Partially resolved (session 280):** `arbitration.YieldForecaster`
    (additive level+trend+seasonal, 2880-tick season ≈ 24h at 30s cadence)
    shipped ahead of v3.5 — per-quote effective-yield smoothing exposed as
    `otedama_arbitration_yield_forecast_sats_per_second{stream,device}` +
    `otedama_arbitration_forecast_misses_total{stream,device}` (>2σ, the A8
    input). `Predict` is not yet wired into `Decide`; the shared rolling
    buffer and multi-horizon emission remain open.
8. 🟡 **Partially resolved — Switching-cost ledger** (ADR-010 A2, groundwork).
   The observation half shipped (session 308, ported from the
   session-274 sibling branch): every stream switch is scored one settle
   window (2 min) later against the abandoned stream's current offer and
   exported as `otedama_arbitration_switch_verdicts_total{verdict}` +
   `otedama_arbitration_last_switch_realized_gain_sats_per_second`
   — the empirical churn rate A2's calibrated `Cost(a,b)` needs. Remaining
   🔵 (v3.5): persistent per-provider-pair store, downtime/orphan-share
   accounting, and replacing the fixed hysteresis with
   `yield_delta * horizon > cost(a,b)`.
9. 🟡 **Beta-Bernoulli calibration** — ADR-010 A6. — 🟡 **Partially
    resolved (session 279):** `arbitration.ProviderReliability` shipped
    ahead of v3.5 — posterior mean discounts quote `Confidence`, epochs are
    staleness-window survival (success) vs stream expiry (failure), exposed
    as `otedama_arbitration_provider_reliability`. A7's Δα ≤ 1 cap and 168h
    reputation half-life followed in session 288 (`UpdateAt(success, now)`
    decays pseudo-counts toward the prior before tallying each outcome);
    the k-confirmation ladder landed in session 289 — `Stream.Confirmed`
    after `ConfirmationEpochs` (3) quotes, and `chooseForDevice` suppresses
    an unconfirmed best candidate from displacing a confirmed incumbent
    (`otedama_arbitration_confirmation_holds_total`). Remaining: the
    shared rolling buffer (with A1) and the persistent cost table.
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
11. ✅ **Deduplicate the two `Provider` implementations** — resolved by the
    `pollingProvider` shared lifecycle (`internal/provider/polling.go`,
    commit e94e9bb): both `MiningProvider` and `AkashProvider` now embed it,
    preserving the three load-bearing behaviours this item flagged
    (restart-safe `quoteCh` re-creation in `Stop()`, buffered drop-oldest
    semantics, distinct tick intervals/device filters). ~~Original item
    (maintainability; recorded per CLAUDE.md rule I3): byte-identical
    `Stop()` and near-identical `loop()`/`publish()` plumbing shared
    between the two providers; verdict was "worth doing as one focused
    refactor with the provider tests as the safety net".~~
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
10. ✅ **Carbon-intensity feed (optional) — RESOLVED (session 318,
    ported from the session-268 sibling branch).**
    `curtail_above_uk_carbon` (gCO2/kWh) polls the UK National Grid ESO
    half-hour forecast every 10 min (`internal/rates/carbon.go`; free,
    keyless, GB-grid only — hence the region in the name) and pauses
    hashing through the same untrusted-input gate semantics as the price
    gate: action only on a fresh reading, hold state across fetch
    failures, and an OR'd `otedama_curtailed` gauge plus new
    `otedama_uk_grid_carbon_intensity` for observability. Exposed in
    `config show`, SPECIFICATION §3/§6, API.md, and documented in
    SUSTAINABILITY.md §7 with the national-index-vs-MOER caveat
    (marginal-emissions feeds like WattTime remain future work pending an
    API key). Original finding: "for users who want to mine on low-carbon
    grid windows; aligns with SUSTAINABILITY.md."

---

## Category 9 — Observability / monitoring

1. ✅ **Prometheus text-format `/metrics`** without a client dependency
   (ADR-005).
2. ✅ **Health endpoint** + `ServeError()` accessor (session 31).
3. 🟡 **Partially resolved — OpenTelemetry traces** for the
   connect→handshake→mine span (session 329). Verification found **no
   spans exist** — nothing instruments the pool dial or submit path.
   The zero-dependency half landed: each pool connection attempt mints
   a random `trace=<16-hex>` span-style identifier and wraps the session
   logger so every line in that attempt's lifecycle (connect →
   handshake → channel open → jobs → submits) carries the same tag —
   `grep trace=<id>` reconstructs the span today. The OTel-SDK half
   (exported spans, W3C context propagation, exemplar-linked trace IDs
   joining the session-311 histogram exemplars) stays open: it needs
   `go.opentelemetry.io/otel` + SDK + exporter, an ADR-003 dependency-
   budget amendment beyond this item's scope.
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
10. ✅ **SLO documentation** (target uptime, p99 submit latency) to make the
    metrics actionable.
    — Implemented in PR #122 and ported to the current chain in PR #184
    (session 324): API.md's "Service-level objectives (SLO)" section
    publishes operator targets for reject rate, quote staleness,
    curtailed state, unaccounted backlog, and clock skew.

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
6. 🔵 **Traffic shaping / "mining cookie"** to blunt the timing side channel —
   the paper's own countermeasure. **Recorded as a design constraint
   (session 332):** the arXiv:1703.06545 countermeasure (Bedrock's
   mining-cookie / traffic shaping) is implemented *pool-side* — a client
   cannot unilaterally prevent a network observer from timing share
   submissions, and constant-rate padding is pointless when the channel
   itself reveals shape. The realistic client-side mitigations are already
   covered: Tor transport (ADR-007 B7, hides the flow entirely) and
   encrypted transports (stratum+tls:// / stratum+v2tls://, hides payload
   but not timing). No further client-side work is implementable; the item
   stays open only as the ADR-007 B7 Tor scope.
7. 🔵 **Tor-by-default transport** — ADR-007 B7, also mitigates item 6.
8. 🔵 **Post-quantum scheme scaffolding** (ML-DSA/SPHINCS+) — ADR-006,
   conditional on BIP-360.
9. ✅ **Constant-time comparison audit — RESOLVED (session 327).**
   Audited every comparison over secret or secret-adjacent data in the
   handshake and seed paths:
   - `internal/lightning/seed.go` mnemonic→entropy checksum loop did
     compare per-bit with an early `return` on the first mismatch —
     now accumulates `diff` across all checksum bits and fails once
     at the end, so error timing cannot reveal the first-differing bit.
   - Wallet passphrase/seed decryption uses AES-256-GCM open (stdlib
     constant-time tag verification); the recovery-phrase backup check
     already compares via `crypto/subtle` (session 313).
   - The base58check/bech32 checksums, English-wordlist integrity hash,
     and the 8-hex HMAC fingerprint are integrity checks over
     public-by-design data (addresses, the wordlist, a UI identifier),
     not MACs over secrets — early-exit `bytes.Equal`/`==` there leaks
     nothing secret-bearing and stays.
   - Noise transport relies on ChaCha20-Poly1305 AEAD (stdlib
     constant-time tag check); no hand-rolled MAC compare exists in
     `internal/stratum/noise*`.
10. ✅ **Supply-chain: pin and verify the one new crypto dep — RESOLVED
    (session 327).** `golang.org/x/crypto` is pinned to an exact version
    (v0.54.0) with the selection rationale in `go.mod` comments, and its
    `go.sum` entries are verified via the module proxy + `sum.golang.org`
    transparency log (`go mod verify` passes — all modules match their
    recorded hashes). THREAT_MODEL's supply-chain mitigation now names
    all three direct dependencies with versions + reasons, and records
    the pin/checksum posture itself. The residual-risk line was also
    corrected (said "two direct dependencies" — it is three since
    x/sys was promoted to direct in session 322).

---

## Category 11 — Lightning payout routing & economics

Sources: Pickhardt & Richter (arXiv:2107.05322), LN autonomy/liquidity
(arXiv:2506.19333), pathfinding analysis (arXiv:2410.13784), 2026 pool
comparisons (D-Central, Coin Bureau, Solo Satoshi).

1. ✅ **Receive-only, non-custodial Lightning** — funds never held for others
   (ADR-007); aligns with the TIDES/OCEAN sovereignty stance the 2026
   comparisons single out.
2. 🔵 **BOLT12 reusable offers** — ADR-007 B1.
3. ✅ **Low Lightning payout-threshold awareness.** Resolved (session 330):
   a new `doctor` check ("Pool payout threshold") resolves each configured
   pool hostname through the public mempool.space directory (the same
   lookup `warnOnPoolShare` uses) and surfaces the documented minimum
   payout for curated pools (OCEAN: 1,000 sats via Lightning) — everything
   else gets a verify-with-the-pool warning instead of a guessed number,
   so small balances don't silently accrue under a threshold the operator
   never saw.
4. 🔵 **External-node control (Phoenixd/CLN/lnd/Alby)** — ADR-007 B3.
5. 🔵 **Embedded LDK Node sidecar (opt-in)** — ADR-007 B4.
6. 🟡 **Min-cost-flow path selection** *if Otedama ever sends*: Pickhardt &
   Richter (arXiv:2107.05322) show optimally-reliable-and-cheap multi-part
   payments are a separable-convex min-cost-flow problem — superior to naive
   shortest-fee-path. Catalogue only; sending is out of alpha scope.
7. ✅ **Liquidity-centralisation awareness — RESOLVED (session 269).**
   THREAT_MODEL's Assumptions now records the arXiv:2506.19333 result as a
   design constraint for any future routing layer: pure cost-minimisation
   consolidates into dominant hubs, so path selection must resist hub
   defaults — the LN echo of ADR-001's pool-decentralisation stance (the
   same reasoning that just landed the ≥30% pool-network-share warning).
   Original finding: "a future routing layer should resist defaulting to
   the same hubs, echoing the mining-pool decentralisation stance."
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

1. 🔵 **Validate the SV2 server certificate, not just the Noise DH.** The
   SV2 security spec delivers a signed certificate (`valid_from`,
   `not_valid_after`, `server_public_key`, BIP340 Schnorr sig over the
   fields); the initiator MUST verify the signature against a known
   authority key *and* check expiry — that is the actual MITM defence,
   distinct from the handshake DH. When `noise.go` moves to secp256k1
   (ADR-011) add `VerifyServerCert(cert, authorityPubKey, clock.Now())`
   and a per-pool `authority_pubkey` config field.
   (sv2-spec 04-Protocol-Security.md)
   — **Scope clarified (session 302):** today's only encrypted transport
   is `stratum+v2tls://`, which already runs standard X.509 chain
   verification — there is no insecure path this item guards against.
   The Noise-NX authority-key certificate applies exclusively to the
   future Noise wiring (the NX handshake code exists but is not in the
   live connect path); it stays open *as ADR-011 scope*, not as a
   standalone fix.
2. ✅ **Clamp the channel target to `max_target` on every vardiff update.**
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
   — ✅ **Resolved (session 282).** Re-verification against the spec
   showed `max_target` is a *required* trailing U256 of
   `OpenStandardMiningChannel`, not an optional preference — omitting it
   truncated the wire message for any spec-conformant pool. The
   advertisement is now sent as all-ones (`stratum.MaxTargetUnbounded`,
   "accept anything"), making the encode spec-conformant while keeping
   the accept-anything semantics; with an unbounded advertisement the
   `[min, max_target]` clamp has no bound to clamp to, closing the item.
   (Previous note claimed the omission was deliberate — corrected.)
3. ✅ **Strip BIP141 (segwit) fields from the coinbase on Extended Jobs.**
   Also fixed in SRI v1.5.0: a client assembling the coinbase from
   `coinbase_tx_prefix`/`suffix` must hash the *non-witness* serialization
   or every share is rejected on a wrong merkle root (SRI v1.5.0 fix).
   (stratum-mining/stratum v1.5.0)
   — ✅ **Resolved — non-applicable by design (session 302).** Otedama
   never assembles a coinbase anywhere: the V1 path deliberately
   discards `coinb1`/`coinb2`/`merkle_branch` (the pool supplies the
   merkle root — see `parseNotify`), and the only SV2 path where
   coinbase assembly exists — Extended Jobs — is unreachable because
   `REQUIRES_EXTENDED_CHANNELS` fails the handshake (session 297) and
   extended channels are ADR-009 scope. There is no code path to
   regress, hence no fixture to add.
4. ✅ **Don't count post-`set_difficulty` "above-target" rejects —
   RESOLVED (session 320, ported from the session-257 sibling
   branch).** `internal/engine/difftag.go` tags each applied V1 job
   with the share difficulty in force at issue time; a difficulty-class
   pool reject on a share whose job's tag differs from the current
   `SuggestedDifficulty()` is a cross-generation race and is counted under
   `otedama_shares_rejected_by_reason_total{reason="difficulty-change"}`
   for visibility while being excluded from `sharesRejected` /
   `otedama_reject_rate` (ESP-Miner #212). Original finding: after
   difficulty drops, in-flight shares against the old (harder) target are
   rejected as "above target"; distinct cause from the existing
   stale/latency `rejectClass`. (bitaxeorg/ESP-Miner #212)
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
   — The open tail is implemented in PR #111 (difficultyTagger: tags
   each generation of work with the difficulty active at issue time and
   excludes benign cross-generation "above target" rejects from the
   reject-rate metric; sibling branch pending merge).
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
6. ✅ **Saturate/reset hashrate counters on reconnect — RESOLVED
   (session 259).** Verified implemented: `internal/engine/stats.go`'s
   `hashrateWindow` saturates when the cumulative total decreases
   (workers recreated on reconnect reset their counters — `total <
   lastTotal` leaves the rate at 0, never negative or NaN), the windowed
   rate feeds the monitor/gauge/log/TUI, and a fresh `hashrateWindow` is
   declared per session so a reconnect re-primes the baseline. Existing
   tests cover the reset/NaN cases. Original finding: ESP-Miner shipped
   a reconnect overflow fix; garbage readings would poison
   `HashrateMonitor` and the yield estimate.
   (bitaxeorg/ESP-Miner releases)
   — **Implemented (session 65):** `hashrateWindow` differentiates the
   cumulative hash counter into a *current* windowed rate (the monitor, gauge,
   log, and TUI all consume it), which also fixed a latent bug where the
   lifetime-average rate could never reach the stall floor. Saturating on
   counter reset — no negative/NaN/spurious-spike readings. See SPECIFICATION.md
   G14.
7. ✅ **Pin protocol truth to `stratum-mining/sv2-spec`, not the app
   code — RESOLVED (session 259).** Verified: no code or doc comment
   cites the `stratum-mining/stratum` app repo for protocol truth —
   `internal/stratum/frame.go`, `handshake.go`, and `messages.go` cite
   stratumprotocol.org spec chapters, ADR-009 references the spec's job
   declaration/mining-protocol URLs, and ADR-011 + `skills/` already
   cite `stratum-mining/sv2-spec` directly. The codec already tracks
   the spec, not moving code.

### Category 4 — decentralisation (arXiv grounding)

8. ✅ **Single-pool concentration enables *undetectable* attacks —
   RESOLVED.** Bahrani & Weinberg, "Undetectable Selfish Mining"
   (arXiv:2309.06847), prove a selfish-mining strategy whose orphan pattern
   is statistically indistinguishable from honest mining, profitable from
   38.2% hashrate. THREAT_MODEL cites the result and justifies the
   multi-pool / endpoint-diversity defaults as a *security* (not merely
   liveness) property (session 325); the concrete mitigations shipped in
   sessions 312 (`otedama_pool_network_share` gauge + ≥30% warn via
   mempool.space distribution) and the doctor endpoint-diversity check —
   all the item asked for is in place.
9. ✅ **Orphan-aware reconciliation has a fairness rationale — RESOLVED
   (session 262).** The implementable half landed in session 261:
   `unaccountedWatchdog` warns when pool-acknowledged shares diverge from
   locally found ones (the only reconciliation signal Stratum V1/SV2
   miner protocols expose — neither reports pool-credited blocks to the
   miner, so a doctor-side block-credit comparison is a recorded protocol
   gap, not implementable today). The fairness rationale itself (Grunspan
   & Pérez-Marco, arXiv:2211.07270 — orphan-aware accounting makes honest
   mining the unique optimum) is what justifies tracking the divergence
   at all; Cat 1 #10's warning is the concrete artefact. Original
   finding: Orphan-aware reconciliation has a fairness rationale.
   Grunspan & Pérez-Marco, "Block withholding resilience"
   (arXiv:2211.07270, rev. Feb 2025), show accounting for orphans makes
   honest mining the unique optimum. Otedama can't change the DAA, but
   `doctor` can track pool-acknowledged shares vs. pool-credited blocks
   over a window and warn on divergence — grounds Cat 1 #10.
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
16. 🟡 **Partially resolved — drift measures instrumented** (session 275).
    "Non-stationary Bandit Convex Optimization" (arXiv:2506.02980, NeurIPS
    2025) gives regret bounds parameterised by switches / total-variation /
    path-length — exactly the three drift types in hashprice/Akash yield
    (difficulty steps, volatility, diurnal). The measurement half now exists:
    `otedama_stream_yield_shifts_total{stream,device}` (S) and
    `otedama_stream_yield_drift_sats_per_second{stream,device}` (V_T)
    classify each stream's drift in real time — steps vs smooth wandering
    shows up directly as shifts/variation ratio. Remaining: feeding the
    dominant drift type into the Holt-Winters reset threshold (A1+A8) stays
    🔵 (v3.6 scope with the forecaster itself).

### Category 8 — power: real, currently-live feeds

17. 🟡 **Partially resolved** (session 270, curtailment half resolved
    session 333). `internal/rates/octopus.go` implements exactly this
    endpoint: `FetchAgileRates` returns the keyless half-hourly
    `standard-unit-rates` curve, and a 15-min engine poll behind
    `electricity_tariff_octopus = "PRODUCT/TARIFF"` publishes the current
    slot on `otedama_electricity_tariff_pence_per_kwh` (GB pence — kept
    separate from the USD `electricity_price_per_kwh`). Session 333 added
    `curtail_above_tariff_pence`: a fourth curtailment gate mirroring
    `curtail_above_uk_carbon`, pausing all hashing while the current Agile
    slot exceeds the threshold. Still open: consuming the forward curve
    for horizon-aware scheduling (ADR-008 #2), and non-GB providers
    (Tibber/Amber below). Original finding: "Octopus Agile half-hourly REST
    (no key for read-only rates)."
18. 🟡 **Partially resolved** (session 270). The fetcher landed returns the
    forward `[]AgileRate` curve (not a spot price), and `AgileRateAt` does
    slot lookup — the interface shape this item prescribes. Still open:
    consuming the curve for horizon-aware scheduling (ADR-008 #2) and
    extending it to Tibber (GraphQL, once-daily curve) and Amber (REST,
    5-min AEMO forecast) for EU-Nordic/AU coverage. Original finding:
    "Design the tariff interface as a forward *price curve*, not a spot
    price."
19. 🟡 **For carbon-aware curtailment use *marginal*, not average, intensity.**
    WattTime MOER (5-min marginal emissions) is the correct signal for
    "pause to cut emissions" because curtailing changes load at the margin;
    Electricity Maps average (AOER) understates the effect. Sharpens Cat 8
    #10; keep optional (keys required) per ADR-003.
    — 🟡 **Partially resolved** (session 268): `curtail_above_uk_carbon`
    shipped the only free keyless source — the UK National Grid *national
    index* (AOER-class, not MOER) — so the gate exists but on the weaker
    signal. A MOER feed (WattTime etc.) requires an API key and stays open
    as the sharpening this item asks for; see SUSTAINABILITY.md §7.

### Category 9/10 — observability & supply-chain (current real tooling)

20. ✅ **Emit trace exemplars on the submit-latency histogram. — RESOLVED
    (session 266).** `internal/metrics` gained a histogram type with
    OpenMetrics exemplars (` # {labels} value ts` — a comment to
    text/0.0.4 parsers), registered as `otedama_submit_latency_seconds`
    with `{job_id="N"}` exemplars (the V2 adapter owns sequence correlation) so a
    p99 spike links to the share that produced it. The `_milliseconds`
    quantile gauges stay (API.md SLO contract); see SPECIFICATION §8 G18.
    OTel trace-ids (Cat 9 #3) remain absent, so the exemplar key is the
    submission identity rather than `trace_id`. Original finding:
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
    `otedama_build_info` (constant-1 gauge, version/commit/goversion
    labels) has since landed in `engineMetrics` — the `_info` convention is
    complete. (session 107; build_info recorded present at session 336)
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
    — 🟡 **Partially resolved** (session 269): advisory IDs verified
    (CVE-2025-22871 / GO-2025-3563 — net/http bare-LF chunk smuggling,
    fixed in go1.23.8/go1.24.2, covered by the go1.25.7 toolchain pin)
    and recorded in THREAT_MODEL's supply-chain threat. The hard-CI-gate
    half stays open — it needs a `.github/workflows` change.

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
27. ✅ **One countermeasure, two timing channels — RESOLVED (session 269).**
    THREAT_MODEL's Information-disclosure timing paragraph now cites Rohrer
    & Tschorsch (arXiv:2006.12143) — HTLC-resolution timing leaking payment
    endpoints — as the LN analogue of the Stratum channel (arXiv:1703.06545),
    and records that Tor-by-default (ADR-007 B7) is the shared mitigation.
    Original finding: "show HTLC-resolution timing leaks payment endpoints…
    Tor-by-default (ADR-007 B7) mitigates *both*; doc-only linkage."

---

## June 2026 research pass — session 52 increment (fresh GitHub/spec findings)

Four verified items that *update* earlier entries with newer reality.

1. ✅ **Fuzz the Noise/frame length arithmetic for overflow (SRI lesson) —
   RESOLVED (session 260).** `internal/stratum/noise_fuzz_test.go` adds two
   targets over the encrypted-frame length prefix:
   `FuzzEncryptedConn_Read` (arbitrary streams incl. runtime-seeded valid
   frames; asserts no panic and `readbuf` never exceeds one frame) and
   `FuzzEncryptedConn_Read_LengthPrefixArithmetic` (attacker-chosen u16
   length vs arbitrary body; boundary seeds 0/1/15/16/17/65519/65535).
   `frame_fuzz_test.go` seeds gained U24 boundary values (0xFFFFFE,
   0xFFFFFF, MinimumChannelPayload ±1, extension-bit patterns).
   `internal/poolproto/stratumv1/parse_fuzz_test.go` adds
   `FuzzSession_ReadLine` (maxLineBytes ceiling on newline-free streams)
   and `FuzzParseNotification` (all five JSON-RPC notification parsers).
   ~5M execs across the four targets: no panics, no unbounded retention.
   Original finding: SRI v1.6.0 / noise_sv2 arithmetic overflow found via
   24/7 fuzzing (Lucas Balieiro); Otedama's analogous surface is
   `internal/stratum` length math + the V1 JSON-RPC reader.
   (opensats.org/projects/stratumv2; github.com/stratum-mining/sv2-apps)
2. ✅ **JDC/template decentralisation just got more urgent: ~75% of hashrate
   committed to SV2 (May 2026) — RESOLVED (session 260).** ADR-009's
   Context now reads "roughly 75% of network hashrate (per the
   coindesk.com 2026-05-11 accounting of the seven signatories)",
   updating its original "~70%" figure. Original finding: seven pools
   (~75% of network hashrate) agreed to adopt SV2 / open block
   construction, strengthening the JDC case as the headline v3.x
   feature. (coindesk.com 2026-05-11)

3. ✅ **Real Akash provider API now requires JWT auth (AEP-64, Mainnet 14).**
   Akash Mainnet 14 (2025-10-28) shipped **AEP-64 JWT Authentication for
   Providers** — token-based auth on the provider APIs. The real
   `AkashProvider` (session 51 #11 / KNOWN_LIMITATIONS §1) must therefore mint
   and attach a JWT to provider `GetStatus`/lease calls, not just hit an open
   REST endpoint. Fold JWT acquisition into the provider client design.
   Recorded (session 293): KNOWN_LIMITATIONS §1 target notes + the
   `ai_inference.go` implementation TODO now name chain-sdk + AEP-64 JWT
   explicitly, and ADR-010 A4's session-251 re-frame covers the bid side.
   (messari.io State of Akash Q3 2025; akash.network/docs)
4. ✅ **Offer an optional FIPS 140-3 mode and document the PQ key exchange
   already negotiated.** Go 1.24+ ships a FIPS 140-3-validated crypto module
   enabled with `GODEBUG=fips140=on` (or the go.mod godebug), and the
   X25519MLKEM768 hybrid PQ key exchange Otedama already turns on via
   `tlsmlkem=1` is part of that validated module. Low-effort, high-trust wins
   for a money-handling binary: (a) document that outbound TLS uses hybrid
   post-quantum key exchange; (b) provide a `fips140=on` build/runtime profile
   for regulated operators; (c) note both in THREAT_MODEL. Pairs with the
   existing godebug block (`GODEBUG_NOTES.md`). (go.dev/blog/fips140)
   **Resolved (sessions 275/293):** (a)+(c) done — the hybrid
   X25519MLKEM768 key exchange is documented in GODEBUG_NOTES/THREAT_MODEL;
   (b) resolves to *not applicable by design* — `fips140=on` would break the
   ChaCha20-Poly1305 Noise transport, which is not FIPS-listed, so the knob
   is documented in GODEBUG_NOTES §fips140 with the rationale rather than
   offered as a runtime profile.

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

1. ✅ **[FETCHED] `gopkg.in/yaml.v3` is archived/unmaintained since 2025-04-01
   — RESOLVED (session 256).** Migrated both import sites
   (`cmd/otedama/configfile.go`, `internal/config/config_file_test.go`) to
   `go.yaml.in/yaml/v3 v3.0.5`, the YAML-org-maintained, API-frozen
   continuation; ADR-003's erratum now records the migration as done and
   `go.mod` carries the selection rationale per CLAUDE.md §外部依存.
   Original finding: the `go-yaml/yaml` source repo was archived by its
   author; the YAML org took over at import path `go.yaml.in/yaml`, where v3
   is frozen to security-fixes-only and active work is in v4. No CVE against
   v3.0.1 existed — the issue was maintenance status, not an active vuln.
   (github.com/go-yaml/yaml; pkg.go.dev/go.yaml.in/yaml/v4)
2. ✅ **[FETCHED] `golang.org/x/crypto` v0.23.0 is ~31 minor versions behind
   (latest v0.54.0, 2026-07-08); CVEs since are all unreachable here —
   RESOLVED (session 256).** Bumped to `v0.54.0` (which also pulled
   `golang.org/x/sys v0.47.0` and, per Go's module rules, raised the `go`
   directive to 1.25.0 to satisfy the dependency's own `go 1.25.0`
   requirement). govulncheck at the new version: see PR. Original finding:
   GO-2025-3487 / CVE-2025-22869 and the May-2026 batch are all in the
   `ssh`/`openpgp` subpackages; Otedama imports only `chacha20poly1305`,
   `scrypt`, and `pbkdf2`, so zero reachable vulnerabilities were expected
   even at v0.23.0. (pkg.go.dev/golang.org/x/crypto?tab=versions;
   pkg.go.dev/vuln/GO-2025-3487)
3. ✅ **[SNIPPET] `toolchain go1.24.0` predates the container-aware GOMAXPROCS
   that GODEBUG_NOTES.md relies on — RESOLVED (session 256).** Bumped to
   `toolchain go1.25.7`, so container-aware `GOMAXPROCS`
   (`containermaxprocs`, default-on since Go 1.25) is now compiled in;
   GODEBUG_NOTES.md's `containermaxprocs` entry updated from "not yet in
   effect" to in-effect. (go.dev/doc/go1.25)
4. ✅ **[FETCHED] x/crypto stays mandatory — confirms ADR-003.** `crypto/pbkdf2`,
   `crypto/hkdf`, `crypto/mlkem` landed in stdlib (Go 1.24), but
   `chacha20poly1305` and `scrypt` remain x/crypto-only through Go 1.26, so the
   dependency cannot be dropped. If PQ scaffolding ever needs ML-KEM, use
   stdlib `crypto/mlkem`. (pkg.go.dev/golang.org/x/crypto/chacha20poly1305,
   .../scrypt; pkg.go.dev/crypto/mlkem)

### Stratum V2 / Bitcoin (corrects roadmap/limitations wording)

5. ✅ **[FETCHED] decred secp256k1 v4.4.1 gives the curve ops but neither
   BIP-340 nor ElligatorSwift — RESOLVED (session 258).** Fix recorded in
   ADR-011's "Erratum (added session 251)" section (v4.4.1 lacks BIP-340
   Schnorr and ellswift; SV2 mandates the full
   `Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256` suite; ElligatorSwift
   must be hand-ported). Original finding: Its Schnorr subpackage is EC-Schnorr-DCRv0
   (Decred-custom), not BIP-340, and no ellswift package exists. SV2 mandates
   `Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256` (BIP324 64-byte ellswift
   x-only encoding + 2-level PKI server auth). So ADR-011's Option A alone does
   not complete v3.1.0 — the Noise path additionally needs BIP-340 Schnorr
   (e.g. btcec/v2's `schnorr`) and a **hand-ported ElligatorSwift (no audited
   Go implementation exists)**, materially raising the estimate. **Action:**
   record this in an ADR-011 Erratum. (pkg.go.dev/github.com/decred/dcrd/dcrec/secp256k1/v4;
   raw.githubusercontent.com/stratum-mining/sv2-spec/main/04-Protocol-Security.md)
6. ✅ **[FETCHED] BIP-360 is Status: Draft and specifies NO post-quantum
   signatures — RESOLVED (session 258).** Wording corrected: ROADMAP v3.1.0
   bullet now notes BIP-360 is P2MR and defers PQ signatures to a separate
   not-yet-written BIP; KNOWN_LIMITATIONS §5 uncouples the ML-DSA scaffold
   from "BIP-360 activation". Original finding: It is "Pay-to-Merkle-Root (P2MR)" — a Taproot-like output with
   the key-path spend removed — and explicitly defers PQ signatures to "a
   separate proposal." So coupling "BIP-360 activation" with "ML-DSA / P2MR
   default" (as ROADMAP/KNOWN_LIMITATIONS §5 currently do) is wrong: activation
   alone would not give the network ML-DSA, which is gated on a later,
   not-yet-written BIP — widening §5's uncertainty. **Action:** correct the §5
   / roadmap wording. (raw.githubusercontent.com/bitcoin/bips/master/bip-0360.mediawiki)
7. ✅ **[FETCHED] Bitcoin Core v30.0 ships an experimental IPC Mining
   Interface — RESOLVED (session 258).** ROADMAP v3.5 bullet and ADR-009
   Sub-domain 1 now note the `-m node -ipcbind=unix` / Cap'n Proto /
   multiprocess `bitcoin-node` interface as the target, with JSON-RPC
   `getblocktemplate` as fallback. Original finding: Started via `bitcoin -m node -ipcbind=unix` (gated by
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
9. ✅ **[FETCHED] SRI is past 1.x, monthly cadence (v1.11.0, 2026-07-08).**
   ROADMAP v3.2.0's premise that "SV2 SRI is alpha" is stale — corrected
   (session 251). **Pin executed (session 293):** ADR-009 names
   **SRI v1.11.0** the conformance reference for Go SV2 compatibility
   tests; bump the pin deliberately on each upstream re-verification.
   **Pin bumped (session 342):** latest upstream is **v1.11.1
   (2026-07-22)**; its user-visible fix "Do not round up SV1
   difficulties" (stratum-mining/stratum#2227, ckolivas) was verified
   against our own code — `internal/miner.TargetFromDifficulty` already
   truncates `diff1Target / difficulty` via `big.Float.Int()` with
   256-bit precision, matching the upstream behaviour; the
   `v1.11.0 → v1.11.1` bump is therefore conformance-only, no code
   change needed. (github.com/stratum-mining/stratum/releases.atom)

### AI-compute / arbitration engine

10. ✅ **[FETCHED] `akash-network/akash-api` is DEPRECATED (2026-01-05);
    successor is `akash-network/chain-sdk`.** ROADMAP v3.1.0 retargeted
    (session 251); KNOWN_LIMITATIONS §1 + the `ai_inference.go` TODO now
    name chain-sdk explicitly (session 293).
    module. **Action:** retarget v3.1.0 to `chain-sdk`, and weigh its Go client
    against ADR-003 (generating only the needed market/provider protobufs may
    be lighter than vendoring the whole SDK). (github.com/akash-network/akash-api;
    github.com/akash-network/chain-sdk)
11. ✅ **[FETCHED] Akash bidding is done on-chain by the provider daemon's
    "Bidengine", not a REST bid-submit call — RESOLVED (session 258).**
    ADR-010 Feature A4 carries the "Re-framing (session 251, primary-source
    verified)" paragraph: A4 outputs a bid-price *policy* fed into the
    provider daemon's on-chain bid config, not a per-order REST sealed
    bid. Original finding: ADR-010 Feature A4 ("Strategic
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
13. ✅ **[FETCHED title-match] ADR-010's bandit direction holds; add a
    2024-25 citation.** Done session 251 — ADR-010's references list
    Sliding-Window Thompson Sampling (arXiv:2409.05181) and Discounted
    Thompson Sampling (arXiv:2305.10718) alongside the 2013 basis. The Mellor & Shapiro 2013 paper ADR-010 cites (Thompson
    Sampling + Bayesian change-point) is real (arxiv.org/pdf/1302.3721); recent
    sliding-window / discounted Thompson Sampling results
    (arxiv.org/pdf/2409.05181, .../2305.10718) corroborate the "don't overbuild
    past Holt-Winters + change-point" stance. **Action:** cite one 2024-25
    result alongside the 2013 reference in ADR-010; no design change.
14. ✅ **[PRIMARY-VERIFIED — with correction] GPU compute spot prices —
    RESOLVED (session 269).** Re-fetched the cited sources directly:
    variant.fund's "Compute as a Commodity" (2026-05-14) scores GPU price
    volatility 🟢 "highly volatile" but makes no clustering claim at all;
    the SNIPPET's "jump-prone with no volatility clustering" phrasing is
    NOT supported by it. A newer empirical series (davefriedman.substack,
    "Three GPU Markets, Three Volatility Regimes", 2026-01-02; 90 days of
    spot data) shows volatility IS structured — next-week volatility
    correlates with utilization (+0.46 for H200), but regime-dependent per
    SKU (A100 inverted, −0.29). SSRN 6926798 remains unfetchable (403).
    Corrected claim: prices are highly volatile AND regime-switching —
    which still argues for change-point detection (A8), already sequenced
    adjacent to A1 (v3.5/v3.6, shared rolling buffer). Original finding:
    "GPU compute spot prices described as jump-prone with no volatility
    clustering… Sources are real but 403'd the fetcher."

### Lightning

15. ✅ **[FETCHED] LDK Node v0.7.0 (2025-12-03) adds experimental splicing +
    async payments; BOLT12 already shipped — RESOLVED (session 258).**
    ADR-007 Feature B4 records "Version target (session 251, primary-source
    verified): target LDK Node ≥ v0.7.0"; the B5 dependency note still
    gates auto-splice on mainline splicing GA. Original finding: Depends on rust-lightning v0.2,
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

## Highest-leverage next actions (cross-category synthesis)

Ranked by impact on the path to a real v3.1.0:

1. **secp256k1 (Cat 10 #1 / Cat 2 #3)** — unblocks the real SV2 encrypted
   channel; library identified, licence compatible. Needs an ADR for the
   dependency decision.
2. ~~**engine→poolproto wiring (Cat 2 #8)**~~ — ✅ done (sessions 283–285):
   the V2 adapter is a complete Session and all pool URLs now dispatch
   through `poolproto.DialURL`; the inline V2 path is deleted.
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

## August 2026 research pass — session 278 increment (sv2-apps re-verification)

Re-checked the Stratum V2 reference implementation ecosystem. The SRI repo
has split: shared crates live at `stratum-mining/stratum` (v1.11.1 latest)
while the runnable roles moved to `stratum-mining/sv2-apps`. Same
[FETCHED]/[SNIPPET] tagging rules as the July pass.

1. ✅ **[FETCHED] sv2-apps v0.5.0 added explicit TCP connect timeouts for its
   translator-proxy dials.** Audit found the same latent defect on every
   Otedama dial path: `stratumv1`, `stratumv2`, `stratumv1` TLS
   (`tls.Dialer`), `stratum` `DialTLS` (v2tls), and the engine's direct V2
   dial all used a bare `net.Dialer{}`, so a blackholed or packet-dropping
   pool stalled the failover loop for the OS TCP timeout (~2 min) instead
   of failing over. — ✅ **Resolved (session 278):** `poolproto.DialConnectTimeout`
   (15 s) bounds the connect phase on every pool dial path; callers' ctx
   can still shorten it. The `stratum` copy stays a local literal (layering)
   pinned equal by test.
2. ✅ **[FETCHED] sv2-apps v0.5.0 standardized Stratum error-code constants —
   verified non-applicable.** The constants are an internal refactor of the
   Rust codebase; the V1 wire carries free-form `[code, "message", null]`
   arrays per pool convention, so there is no shared wire constant set for
   Otedama to align with. `rejectClass`'s heuristic classification stands.
3. ✅ **[FETCHED] Per-upstream `user_identity` (sv2-apps v0.5.0) — already
   implemented.** Otedama sets the channel `user_identity` from the per-pool
   `User` field, falling back to the active payout address (SPECIFICATION
   §4). Share accounting is already `uint64`.
4. **[FETCHED] sv2-apps v0.7.0 (Job Declaration / SharedSet)** — JDC remains
   ADR-009 scope; see the September 2026 increment below for the full
   v0.6.0/v0.7.0 audit.

---

## September 2026 research pass — session 282 increment (sv2-apps v0.6/v0.7)

sv2-apps shipped v0.6.0 (2026-07-08) and v0.7.0 (2026-07-24) after the
session-278 pass. Audited every highlight for Otedama applicability
(we are a mining *client*, so pool/proxy/JD-server changes mostly don't
translate):

1. ✅ **[FETCHED] `OpenStandardMiningChannel.max_target` is a REQUIRED
   wire field — our encode omitted it.** Found while auditing v0.6.0's
   "integer powers of two in mining.set_difficulty" note (the difficulty
   negotiation path). Otedama's `OpenMiningChannel.Encode` wrote
   req_id+user+hashrate only; a spec-conformant pool expects the trailing
   U256 and reads a truncated message. — ✅ **Fixed (session 282):**
   `stratum.MaxTargetUnbounded` (all-ones) is now advertised on both V2
   call sites, closing the recorded `[min, max_target]` clamp item.
2. ✅ **[FETCHED] tProxy builds `UserIdentity` TLV only when extension
   0x0002 is negotiated (v0.7.0) — verified non-applicable.** The bug
   class was a translator-proxy constructing the *channel-extension TLV*
   for upstream translation. Otedama sets the *standard* `user_identity`
   field of `OpenStandardMiningChannel` (required, no extension
   negotiation needed) and builds no extension TLVs.
3. ✅ **[FETCHED] JDC `RequestTransactionData` race fix + JDS
   `DownstreamState` isolation (v0.7.0) — ADR-009 scope.** Job Declaration
   remains unimplemented by design; no client-side action.
4. ✅ **[FETCHED] Downstream share validation vs advertised pow2
   difficulty (v0.7.0) — pool-side, non-applicable.** Otedama mines
   against whatever share target the pool advertises; the symmetric
   client-side concern (a pool *sending* an unusable target) is covered
   by the SetTarget handling from session 238 and this session's
   max_target advertisement.
5. **[FETCHED] `bitcoin_core_sv2` multi-version IPC backends (v30.x +
   v31.x, v0.6.0)** — corroborates the ADR-009 "versioned backend"
   recording; the upstream pattern (one API, runtime version selection)
   is the same shape Otedama's own V1/V2 protocol abstraction follows.
   No action.
6. **[SNIPPET] ASIC telemetry discovery by miner username+port (v0.7.0)
   — lead only.** tProxy auto-discovers `asic-rs` endpoints; Otedama's
   ASIC discovery remains a hardware-probing item with no testable
   path on this VM. Recorded, not acted on.
   tracked in ADR-009; v0.7.0's release is the cue that an upstream JDS
   worth integrating against now exists. Priority unchanged pending the
   segwit-coinbase prerequisite.

**Session-295 follow-up (missed v0.5.0 highlight):** the session-278
audit itemised v0.5.0's timeout/identity/error-code changes but skipped
its "REQUIRES_STANDARD_JOBS semantics" protocol-compatibility note.
Audit found Otedama's `SetupConnection` left `flags=0`, while sv2-spec
§5.3.1 requires an end mining device opening Standard Channels to set
bit 0 (it cannot process extended jobs; flags=0 marks a proxy-capable
downstream). — ✅ **Fixed (session 295):**
`stratum.SetupFlagRequiresStandardJobs` is now declared on the V2
dialer's SetupConnection.

**Session-296 follow-up (SV2 error-code taxonomy):** while auditing the
canonical `SubmitSharesError` codes against `rejectClass`, found SV2's
hyphenated strings fell through to "other" — the classifier was written
for V1 free-form text ("low difficulty" with spaces), so
`low-difficulty-share` (the most common var-diff-related rejection)
misclassified and skewed the reject-reason counter. — ✅ **Fixed
(session 296):** `rejectClass` normalises `-`/`_` separators before
matching; all five spec codes now map correctly
(`unauthorized-worker`/`not-subscribed` → "other" by design).

**Session-297 follow-up (SetupConnectionSuccess.flags):** the success
side of the same §5.3.1 flags pair was decoded but never inspected — a
pool setting `REQUIRES_EXTENDED_CHANNELS` (0x02) demands group/extended
jobs an end device cannot process, yet the dialer proceeded and would
receive unusable work. — ✅ **Fixed (session 297):** the V2 dialer now
fails the handshake (`ErrHandshakeFailed`) when the success flags
require extended channels; `SetupFlagRequiresExtendedChannels` added
next to the client-side bit-0 constant.

**Session-298 follow-up (Reconnect, §3.6.5):** the common-protocol
`Reconnect` (msg_type 0x04, `new_host`/`new_port`) — the V2 analogue of
V1 `client.reconnect` — was silently dropped: not in the codec at all,
so a pool-directed redirect never terminated the session. — ✅ **Fixed
(session 298):** codec + dispatch added, and the read loop records the
directive then closes the session so the engine's reconnect loop
re-dials the *configured* pool — the pool-supplied endpoint is NOT
followed, mirroring the V1 trust posture (an unauthenticated redirect
would hand the hash rate to an arbitrary endpoint).
`ChannelEndpointChanged` (0x03, channel_msg) is decode-only on purpose:
it governs unknown-extension channel state, and Otedama negotiates no
extensions.

**Session-299 follow-up (channel lifecycle):** `CloseChannel` (0x18,
channel_id + reason_code) had no codec — a pool ending the channel left
the session alive on work it could no longer settle (per §5.3.9 the
sender MUST stop sending on it). — ✅ **Fixed (session 299):** codec +
dispatch added; the read loop records the close reason and ends the
session so the engine re-dials the configured pool. `SetExtranoncePrefix`
(0x19) was given a codec for wire completeness; it is deliberately not
applied to the session — standard-channel submits carry only
nonce/ntime/version and the pool supplies merkle roots, so no
miner-built coinbase consumes the prefix.

**Session-300 follow-up (client→server channel update):** `UpdateChannel`
(0x16, §5.3.7) — the client→server message that updates a channel's
nominal hashrate — had no codec; the channel was opened with
`nominal_hash_rate = 0` and never revised, leaving the pool blind to the
device's real rate (the SV2 counterpart of V1
`mining.suggest_difficulty`, wired in session 294). — ✅ **Fixed
(session 300):** codec + dispatch added (with `UpdateChannel.Error`
0x17), new `poolproto.NominalHashrateUpdater` optional interface
implemented by the V2 session, and the engine's existing
first-measurement trigger now notifies V2 sessions too —
`maximum_target` advertised unbounded so var-diff stays
pool-authoritative. Per the spec's proxy note, updates may repeat
(debounced ≤1/s); a drift-triggered re-notify is a possible follow-up.
— ✅ **Follow-up done (session 302):** the engine now re-notifies when
the measured rate drifts ±25% from the last notified value, debounced
at once a minute (far below the spec's ≤1/s proxy bound).

**Session-303 follow-up (sv2-apps v0.8.0, Loupe-audit release):** the
2026-09-17 release is a security-hardening pass driven by the Loupe
audit. Verified against Otedama — already covered: non-setup messages
during the SV2 handshake are rejected (`Negotiate` fails on any
unexpected msg_type), `Decoder.MaxFrameSize` caps frame allocation,
`extranonce.subscribe` opt-in + `mining.set_extranonce` handling exist,
and Go's dialer already iterates every resolved DNS address.
~~Non-applicable: BIP323 version-rolling mask (an end CPU/GPU device
has nothing to roll — `mining.set_version_mask` is correctly
ignored),~~ *Superseded (session 339):* `mining.set_version_mask` is now
handled — pools push it both unilaterally (NiceHash) and after a
successful `mining.configure` grant, and tracking the mask is required
for correct version echo on submit.
JDC/Pool-side items (extranonce allocator exhaustion, share-cache
ordering, `SeenSharesBudgetExhausted`, `max_past_jobs`) are upstream
scope, and the `noise_sv2` hardening applies to the unwired Noise path
(ADR-011). One real finding fixed — ✅ **Fixed (session 303):** the
`set_extranonce` rotation path itself raced — `readLoop` wrote
`extranonce1`/`extranonce2Size` while `Submit` read the size for
extranonce2 padding, with no synchronization. Both fields now move
together under `enMu` (confirmed by a `-race` regression test that
fails on the pre-fix code).

**Session-304 follow-up (SRI v1.12.0 + KNOWN_LIMITATIONS §8 detection
half):** audited the 2026-09-17 stratum-mining SRI v1.12.0 release —
all findings already covered or non-applicable: `min_ntime` is honoured
(`dialer.go` tracks `activeNTime`), difficulty arithmetic is guarded
(`TargetFromDifficulty` rejects ≤0/Inf/overflow), `noise.go` is
ChaChaPoly-only (matching upstream's AES-GCM removal), and the new
hyphenated wire error codes (`channel-capacity-exhausted`,
`protocol-version-mismatch`, …) were already handled by session-296's
separator normalisation in `rejectClass`. Separately, the ASIC half of
KNOWN_LIMITATIONS §8 got its detection half: `hal.ASICDriver` probes
operator-configured cgminer-API endpoints only (opt-in `asic_endpoints`,
never a subnet scan), reporting identity/vendor/self-reported hashrate
with `Capabilities{SHA256d:false}` — matching the GPU drivers'
detection-only posture. Firmware control/dispatch across the five
dialect families remains the ADR-008 SD1 residual.

**Session-305 follow-up (V1 `mining.set_target`):** RESEARCH item 5's
V1-extension handling covered the client→pool direction
(`suggest_difficulty`, session 294) and `set_difficulty` inbound, but
the pool→client *target form* — `mining.set_target` (zip-0301
canonical; braiins/bosminer, ckpool- and BFGMiner-family vardiff
variant carrying a 256-bit big-endian hex target instead of a
difficulty number) — was silently ignored, leaving
`SuggestedDifficulty()` stale on pools that speak it. Now parsed and
converted through `miner.DifficultyFromTarget` with the same
zero/degenerate guard as the SV2 zero-target lesson;
`mining.suggest_target` in the same notification shape is accepted
too. Verified `mining.suggest_target`'s *request* direction stays
client→pool per BFGMiner-era spec — we do not send it (the
`mining.suggest_difficulty` one-shot hint already covers that need).

**Session-306 follow-up (V1 `client.get_version`):** the braiins-family
version probe is a *request* (id present) expecting a reply on the same
id — silently dropping it left pools waiting on an unresolved id, and
some drop unresponsive clients. `session.respond` now writes a JSON-RPC
response carrying the same `clientAgent` string advertised in
`mining.subscribe` (extracted to a const shared by both call sites).
Verified the remaining pool→client request surface: `mining.configure`
(NiceHash version-rolling negotiation) is deliberately ignored — BIP320
version rolling is non-applicable to a CPU/GPU end device, and answering
it would falsely advertise support.

*Correction (session 339):* the claim conflated directions —
`mining.configure` is a *client→pool* negotiation request, not a
pool→client one (a pool that sends it gets the standard -32601 default).
We now SEND it in the handshake (cgminer/ESP-Miner convention) because
OCEAN/DATUM-family pools advertise their miner-facing protocol as
"SV1 + version-rolling": the negotiation + mask handling + version
echo on submit completes the client side. Varying the version bits
themselves in share construction stays non-applicable — the CPU share
producer never exhausts a job's nonce space.

**Session-307 follow-up (request contract completion):** the same
unresolved-id problem generalised — any pool→client method carrying an
`id` that we don't implement left the pool waiting. `dispatch` now has a
`default` branch answering such requests with the JSON-RPC -32601
"Method not found" error (SV1 `[code, message, traceback]` array form),
so unknown *requests* resolve while unknown *notifications* stay
ignored. The per-method bodies were also extracted into
`handleNotify`/`handleSetExtranonce`/`handleShowMessage`/
`handleReconnect`/`deliverResponse`, dropping `dispatch`'s
long-flagged gocyclo complexity under the lint threshold.

**Session-335 follow-up (V1 `mining.suggest_difficulty` pool→client):**
the vardiff surface covered `set_difficulty`, `set_target` and
`suggest_target` (sessions 294/305), but the pool→client form of
`suggest_difficulty` — which ckpool- and ESP-Miner-family pools emit as
a vardiff notification where the suggestion becomes the share target —
still fell through to the -32601 default and was dropped. `dispatch` now
routes it through the same `parseDifficulty` → `difficulty.Store` path
as `set_difficulty`, matching cgminer's convention.

**Session-336 follow-up (`xnsub` extension flag in `mining.subscribe`):**
mid-session extranonce rotation was already wired — `set_extranonce` is
handled and `extranonce.subscribe` is sent as handshake step 3 — but
NiceHash-family pools only enable `mining.set_extranonce` pushes when the
client advertises the `"xnsub"` extension flag in `mining.subscribe`
params[2] (the ESP-Miner convention); the method call alone does not
enable it on those pools. Subscribe params are now `[agent, null,
"xnsub"]` — a no-op on pools that ignore extensions, enabling the push
path on pools that gate it.

**Session-338 follow-up (forward-curve observability, Cat 8 #17/#18
groundwork):** the Octopus fetcher already returns the ~24h forward
`[]AgileRate` curve but only the current slot was consumed. Two gauges
now publish the envelope — `otedama_electricity_tariff_forward_min`
/`_max_pence_per_kwh` — so operators can alert on "a curtail window is
coming" (max > threshold) or locate the cheapest upcoming slot (min).
Horizon-aware *scheduling* itself stays ADR-008 sub-domain 2. Also:
doctor's ASIC-endpoints check now warns when `asic_manage` is armed
with endpoints but every configured pool is SV2-only — cgminer devices
speak SV1, so actuation could never fire (previously an info log only).

**Session-339 follow-up (V1 version-rolling extension):** the handshake
now sends `mining.configure` offering `version-rolling`
(mask 1fffe000, min-bit-count 2 — the cgminer/ESP-Miner convention),
records the negotiated mask, honours `mining.set_version_mask` pushes,
and echoes the hashed version as the optional 6th `mining.submit`
param once rolling is negotiated. This completes the client side of
the extension the DATUM gateway documents as its miner-facing
protocol ("SV1 + version-rolling"); the earlier audit rows that
treated the extension as wholly non-applicable are corrected above.

**Session-340 follow-up (V1 mining.ping):** ckpool-family pools send an
id-bearing `mining.ping` keepalive and drop clients that never resolve
the id; the dispatcher now answers with the conventional
`result: "pong"` (cgminer convention) instead of the -32601
method-not-found fallback. An id-less ping notification stays silent.
Also in session 340: `parseDifficulty` now rejects degenerate
`set_difficulty`/`suggest_difficulty` values (zero, negative, NaN,
+Inf) — the same guard the set_target path already has — because
storing one would make `TargetFromDifficulty` fail every share.
And `parseSubscribeResult`/`parseSetExtranonce` now bound the
extranonce pair (`validExtranonce`): a negative `extranonce2_size`
would panic `strings.Repeat` on the next submit, and non-hex or
oversized extranonce1 previously failed only at share time — a
hostile pool could crash the handshake or mid-session submit.

Session 341: pool TLS certificate expiry is now observable —
`otedama_pool_tls_cert_not_after_unixtime{pool_host}` carries the
peer leaf's NotAfter for stratum+tls:// and stratum+v2tls://
sessions (new `poolproto.TLSCertNotAfterer` optional interface,
same shape as PoolNoticeReceiver/DifficultySuggester). An expiring
pool certificate previously surfaced only as sudden dial failures
at the next reconnect; it is now alertable in advance. Plaintext
and Noise sessions report ok=false and publish nothing.

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
