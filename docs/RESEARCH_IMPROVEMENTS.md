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
10. ✅ **"Trust the pool's numbers" reconciliation** — done to the extent the
    wire allows (sessions 288/310/321/322): V2 `SubmitSharesSuccess.LastSequenceNumber`
    is validated before crediting and pool-reported batch accepts are counted;
    V1 exposes no stats RPC, so no further reconciliation surface exists.
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
8. ✅ **engine→poolproto wiring** — done (session 1282 verification):
   `runSessionV1` calls `poolproto.DialURL` and drives the protocol-agnostic
   `poolproto.Session` (Jobs/Submit); the V2 path is protocol-gated on
   `ProtocolStratumV2/TLS`. Dialers are registered and load-bearing.
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
8. ✅ **Seed backup reminder / verification flow** — done (sessions 387/498):
   first-run wallet setup prompts the user to re-enter a random subset of
   recovery words (`verifyBackupPhrase`, internal/engine/setup.go), catching
   unwritten or transposed seeds before funds depend on them.
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
7. 🔵 **Pool-share-of-hashrate awareness** — optionally inform the user when
   their chosen pool exceeds a large network share, nudging decentralisation.
   — 🔵 **Scope refined (verified session 1740):** nothing on the stratum
   wire exposes a pool's network share, so this needs an external pool-stats
   source — which exists and is already trusted by Otedama: the hashrate
   feed queries `mempool.space/api/v1/mining/hashrate/1d` (rates/hashrate.go:49),
   and the same host serves `/api/v1/mining/pools/1w` (per-pool block
   counts → share). The unsolved piece is *identity mapping*: the API
   reports pool names ("Foundry USA", "AntPool") while config carries
   pool URLs (`stratum+tcp://fp2.antpool.com:3333`); joining them requires
   either a user-declared pool identity or a curated hostname→pool table —
   a design decision (new config surface vs. a curated-map maintenance
   liability) fit for an ADR, not a drive-by heuristic. Deferred pending
   that design choice rather than implemented speculatively.
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
   — **Already satisfied (verified session 1742):** provider liveness is
   quote-driven — `pruneStaleStreams` (arbitrate.go:285-298) removes any
   stream whose last quote is older than `streamStaleTimeout` (3 min,
   arbitrate.go:128), the pruned keys are logged ("stream %q expired …
   no longer routing to it", arbitrate.go:196-201), and `quoteFreshness`
   (arbitrate.go:272-281) clamps zero/future `At` so a dead provider
   cannot pin its freshness clock forward. A dead provider silently ages
   out of `Decide`'s input and its devices return to the surviving
   streams — exactly the stop-routing behaviour asked for.
4. 🟡 **GPU suitability scoring per workload** (VRAM, FP16/INT8 throughput)
   so inference jobs map to capable GPUs only.
5. 🔵 **Per-device suitability assignment** — ADR-010 A3 (Hungarian).
6. ✅ **Spot-price volatility guard** — hysteresis exists in arbitration and
   now has a user-configurable knob: `arbitration_hysteresis_pct` (YAML) /
   `OTEDAMA_ARBITRATION_HYSTERESIS_PCT` (env), default 0.05 (5%). Applies
   to all workload switches (mining ↔ AI). Validation rejects values outside
   [0.0, 1.0). (session 108)
7. 🔵 **Sharpe-ratio preference** to favour stable yield — ADR-010 A5.
8. ✅ **Inference revenue is denominated/settled correctly** — verify USD→BTC
   conversion path and that simulated vs real yield is never mixed in
   accounting.
   — **Verified (session 1741):** the USD→BTC path is correct —
   `SatsPerSecond(usdPerHour, rate) = usd/rate × 1e8 / 3600`
   (provider.go:183-190), rate≤0 → 0 (no sign flip), stale-rate fallback
   95000 is a named constant, and `Confidence` scales `NetSatsPerSecond`
   in `EffectiveYield` (provider.go:114-117). Accounting isolation
   verified: the *only* surface simulated yield reaches is the `estSats`
   estimate (run.go:1048/1596 via `satsAcc.observe(expectedYieldRate)`),
   which is labelled `est. earned` in the TUI (dashboard.go:372) and the
   active provider's name carries the "(simulated)" suffix — the
   estimate honestly discloses what it contains. No payout ledger,
   settlement accounting, or pool-reported metric is fed by it:
   `otedama_shares_total{accepted,rejected}` counts only pool-verified
   mining shares, which a simulated provider cannot produce. Simulated
   yield is summed into the *estimate* by design (opportunity accrual)
   and can never masquerade as settled revenue.
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
5. 🔵 **Markovian-reward matching** — Tekin & Liu (arXiv:1012.3005) prove
   near-logarithmic regret for bipartite user↔resource matching with
   Markov state; directly models device↔stream assignment when yields are
   autocorrelated. New grounding for A3's dynamics.
   — **Dispositioned (session 1744):** grounding material for ADR-010 A3,
   not a defect — today's engine does assignment by hysteresis-guarded
   greedy `Decide`, and the autocorrelated-yield regime this paper
   addresses is what A3's dynamics section would formalise. 🔵
   (planned/ADR-referenced), not 🟡 (newly surfaced gap).
6. 🔵 **Bi-criteria bandit (reward + constraint violation)** — arXiv:2503.12285
   transforms offline bi-criteria approximations into online CMAB with
   sublinear regret *and* sublinear constraint violation; the right frame
   if Otedama ever optimises yield subject to a hard power cap.
   — **Dispositioned (session 1744):** conditional research, correctly
   self-scoped — verified no hard power cap exists to violate. Power is
   handled as a breakeven *floor*: `max(min_yield, powerFloor)`
   (arbitrate.go:130-139, 206-208), a threshold below which a stream is
   not worth running — not a constrained-optimisation surface. Becomes
   relevant only if a power *cap* ships. 🔵.
7. 🔵 **Holt-Winters short-horizon forecaster** — ADR-010 A1 (chosen over ML).
8. 🔵 **Switching-cost ledger** — ADR-010 A2 (don't churn for tiny gains).
9. 🔵 **Beta-Bernoulli calibration** — ADR-010 A6.
10. ❌ **Federated/multi-agent extension** — arXiv:2405.05950 (if multiple
    Otedama nodes ever cooperate); noted as out-of-scope-for-now but
    catalogued.
    — **Dispositioned (session 1744):** out of scope, as the row itself
    declared — Otedama is a single-node client by product definition and
    no multi-node cooperation surface exists. Catalogued for the record;
    ❌.
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
2. ✅ **Background-service install** (launchd/systemd/Windows SCM via `sc.exe`
   — **correction session 486:** this item said "Task Scheduler"; nothing
   invokes `schtasks.exe`, the Windows path is an SCM registration).
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
11. ✅ **Deduplicate the two `Provider` implementations — resolved.**
    Verified resolved in session 1726: the refactor this row prescribed
    shipped as `internal/provider/polling.go`'s embedded `pollingProvider`
    — exactly the proposed `baseProvider` (shared `launch`/`loop`/`Stop`/
    `sendQuote`, distinct tick intervals via `interval`, preserved
    channel re-creation for restart, buffered drop-oldest semantics).
    Only `publish()` now differs per domain. (Historical row kept below.)
    ⬜ **Deduplicate the two `Provider` implementations** (maintainability;
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
10. 🟡→🔵 **Carbon-intensity feed (optional) — scope refined.**
    Verified session 1745: nothing named "carbon" exists in `internal/`
    (the only match is a BIP-39 wordlist entry) and SUSTAINABILITY.md
    contains no carbon reference, so the row's alignment claim is
    aspirational rather than anchored. Implementation is not blocked on
    code — it is blocked on an external-dependency decision: every
    carbon-intensity source is region- or key-locked (WattTime /
    electricityMaps need API keys; free feeds like energy-charts.info
    cover only the EU). Choosing a source family and how a user declares
    their grid region is the same class of feed-integration decision as
    the TOU tariff feeds already parked under ADR-008 sub-domain 4 —
    that ADR is the natural home for this row. Original request follows:

    For users who want to mine on low-carbon grid windows; aligns with
    SUSTAINABILITY.md.

---

## Category 9 — Observability / monitoring

1. ✅ **Prometheus text-format `/metrics`** without a client dependency
   (ADR-005).
2. ✅ **Health endpoint** + `ServeError()` accessor (session 31).
3. 🟡→🔵 **OpenTelemetry traces — already planned, not a gap.**
   Verified session 1746: no OTel dependency exists in go.mod and no
   spans exist anywhere — confirmed absent. But the row is already
   dispositioned by the project's own roadmap, not an unhandled gap:
   ADR-005 (:105-110) deliberately rejected the OTel metrics SDK for now
   ("adopt incrementally if it becomes the unambiguous winner"), and
   SUSTAINABILITY.md:105-115 pins the delivery shape — a separate
   `otedama-full` binary behind `-tags otel` with OTLP/HTTP (not gRPC),
   declared v3.3.0 scope. Connect→handshake→mine span instrumentation
   lands with that artifact. 🔵 (planned/roadmap-anchored). Original
   request follows:

   OpenTelemetry traces for the connect→handshake→mine span — ADR
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
10. ✅ **SLO documentation** (target uptime, p99 submit latency) to make the
    metrics actionable.
    — **Shipped (session 1739):** DEPLOYMENT.md gained an "SLO guidance"
    table under Alerts — availability (`otedama_up` ≥99%/30d), pool
    connectivity (connection_state=2 ≥99%/24h), share acceptance
    (rejects ≤5%/10m — matching the shipped alert), and submit latency
    (p50 <200ms, p99 <500ms — with the stale-share rationale). All named
    metrics are real registrations.

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
6. 🟡→🔵 **Traffic shaping / "mining cookie" — future hardening, correctly
   so.** Verified session 1747: no shaping/padding exists (share submits
   are event-driven as they must be — delays would inflate stale rates),
   and the row self-declares "future hardening". The real decision is
   which of two countermeasures to the *same* timing channel to take:
   shaping/cover traffic (client-side, costs bandwidth and share
   latency) vs Tor-by-default transport (already 🔵 under ADR-007 B7,
   mitigates the same observer). That trade-off is an ADR-level decision
   — the shaping option stays catalogued here alongside B7 rather than
   being an independent open task. 🔵. Original request follows:

   Traffic shaping / "mining cookie" to blunt the timing side channel —
   the paper's own countermeasure; future hardening.
7. 🔵 **Tor-by-default transport** — ADR-007 B7, also mitigates item 6.
8. 🔵 **Post-quantum scheme scaffolding** (ML-DSA/SPHINCS+) — ADR-006,
   conditional on BIP-360.
9. ✅ **Constant-time comparison audit** — done (sessions 554/645/841):
   `crypto/subtle` is the only secret-comparison boundary; `bytes.Equal` sites
   are all on non-secret protocol fields (checksums, magic bytes).
10. ✅ **Supply-chain: pin and verify the crypto dep** — done (session 1279):
    `golang.org/x/crypto` is pinned in go.mod with go.sum checksums, `go mod
    verify` passes, and `govulncheck` shows zero reachable vulnerabilities;
    THREAT_MODEL lists the dependency assumptions.

---

## Category 11 — Lightning payout routing & economics

Sources: Pickhardt & Richter (arXiv:2107.05322), LN autonomy/liquidity
(arXiv:2506.19333), pathfinding analysis (arXiv:2410.13784), 2026 pool
comparisons (D-Central, Coin Bureau, Solo Satoshi).

1. ✅ **Receive-only, non-custodial Lightning** — funds never held for others
   (ADR-007); aligns with the TIDES/OCEAN sovereignty stance the 2026
   comparisons single out.
2. 🔵 **BOLT12 reusable offers** — ADR-007 B1.
3. 🟡→🔵 **Low Lightning payout-threshold awareness — blocked on protocol
   surface.** Verified session 1748: `doctor` already surfaces payout
   *context* — `checkPayoutScheme` (checks.go:756-790) prints per-pool
   FPPS/PPLNS/TIDES/Solo trade-offs and prompts when `payout_scheme` is
   unset. But the row asks for the pool's actual *minimum* payout, and
   neither Stratum V1 nor V2 carries a payout-policy field — the
   deployed check can only echo the config-declared label. The
   tracked spec path is sv2-spec #203 (non-custodial payout extension),
   which is exactly where pool-advertised payout parameters would land;
   until then a lookup table of pool policies would be unverifiable
   hardcoding (rejected class). 🔵 (blocked-on-spec). Original request:
   OCEAN's 0.00001 BTC LN minimum makes frequent small withdrawals
   viable; surfacing the pool's minimum payout in `doctor` helps users
   avoid "trapped" small balances.
4. 🔵 **External-node control (Phoenixd/CLN/lnd/Alby)** — ADR-007 B3.
5. 🔵 **Embedded LDK Node sidecar (opt-in)** — ADR-007 B4.
6. 🔵 **Min-cost-flow path selection** *if Otedama ever sends*: Pickhardt &
   Richter (arXiv:2107.05322) show optimally-reliable-and-cheap multi-part
   payments are a separable-convex min-cost-flow problem — superior to naive
   shortest-fee-path. Catalogue only; sending is out of alpha scope.
   — **Dispositioned (session 1748):** correctly self-scoped as
   conditional — Otedama is receive-only today (ADR-007), so there is no
   send path to route. Activates only if a send feature is ever added.
7. 🔵 **Liquidity-centralisation awareness.** arXiv:2506.19333 shows LN
   liquidity consolidates into dominant hubs under pure cost minimisation; a
   future routing layer should resist defaulting to the same hubs, echoing
   the mining-pool decentralisation stance (ADR-001).
   — **Dispositioned (session 1748):** same condition as row 6 —
   hub-preference policy exists only where a send router exists. The
   ADR-001 decentralisation stance is already on record to apply when
   that day comes.
8. 🔵 **Boltz reverse-swap** for trustless LN→on-chain — ADR-007 B6.
9. 🔵 **Tor-by-default** for LN/pool connections — ADR-007 B7 (also mitigates
   the Category 10 timing side channel).
10. 🔵 **SCB / static-channel-backup reminders** if an embedded node lands —
    fund-loss prevention, parallels the seed-backup reminder (Cat 3 #8).
    — **Dispositioned (session 1748):** conditional by construction —
    there is no embedded node to back up today (ADR-007 B4 is 🔵
    unscheduled). When B4 lands, SCB reminders ride with it.

---

## June 2026 research pass (session 51) — new findings

A fresh sweep of comparable software (SRI / stratum-mining, ESP-Miner,
Akash, Vast.ai, sigstore/OpenSSF, prometheus/client_golang) and arXiv
(2024–2026), cross-checked so nothing below duplicates the categories
above. Every arXiv ID was verified against the arXiv listing; every API
endpoint against current vendor documentation. Tags as before
(✅/🔵/🟡/❌).

### Category 1/2 — mining client & Stratum correctness (from SRI v1.5.0 + ESP-Miner)

1. 🟡→🔵 **Validate the SV2 server certificate — scope refined.** Verified
   in session 1731/1732: the premise "only the Noise DH defends today" is
   stale. Noise NX is **not wired into the live connect path at all**
   (engine run.go:871-876 warns "Noise NX is not yet wired"; noise.go:107
   still substitutes P-256 for secp256k1). The MITM defence that *is*
   deployed is `stratum+v2tls://`: real certificate-verified TLS via
   `stratum.DialTLS` + `TLSConfigWithExtraCAs` (system roots + optional
   `tls_ca_file` PEM), with no plaintext downgrade (coverage_test.go:733-787).
   The genuinely-open remainder is unchanged but narrower: when ADR-011's
   secp256k1 migration wires Noise NX, add `VerifyServerCert(cert,
   authorityPubKey, clock.Now())` + a per-pool `authority_pubkey` config
   field — the SV2-native signed-certificate check (BIP340 Schnorr over
   `valid_from`/`not_valid_after`/`server_public_key`, with expiry
   enforcement) the spec mandates. Until then the row is blocked, not
   silently missing.
   — (Original row retained below.)
   Validate the SV2 server certificate, not just the Noise DH. The
   SV2 security spec delivers a signed certificate (`valid_from`,
   `not_valid_after`, `server_public_key`, BIP340 Schnorr sig over the
   fields); the initiator MUST verify the signature against a known
   authority key *and* check expiry — that is the actual MITM defence,
   distinct from the handshake DH. When `noise.go` moves to secp256k1
   (ADR-011) add `VerifyServerCert(cert, authorityPubKey, clock.Now())`
   and a per-pool `authority_pubkey` config field.
   (sv2-spec 04-Protocol-Security.md)
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
   The clamp-to-`[min, max_target]` behavior this item originally asked
   for is not implemented — Otedama accepts whatever target the pool
   sends outright.
   — ✅ **Resolved by design** (verified session 1733): the remaining
   clamp is vacuous on every axis. Otedama declares
   `MaxTargetUnconstrained` in `OpenMiningChannel` (run.go:1919,
   handshake.go:162-168 — the field is now on the wire, the earlier note's
   "intentionally not sent" is stale), so sv2-spec #236's pool-side
   SetTarget≤max_target bound can never be violated against this client.
   A too-EASY pool target is harmless (easy shares are what the pool
   credits; any resulting submit flood is already bounded by the
   per-session `submitLimiter` token bucket, run.go:2218-2225). The only
   adversarial direction is a too-HARD target (share difficulty ≥ block
   difficulty), which cannot be "clamped" upward — grinding at
   block-target instead would emit only rejected shares — and is already
   defended by the episodic starvation tripwire (run.go:951-1096) plus
   the SetTarget=0 → block-target fallback (run.go:2036-2043). SetTarget
   is applied and re-issues the active job immediately (run.go:1228-1235).
3. ✅ **Strip BIP141 (segwit) fields from the coinbase on Extended Jobs — not applicable as designed.** Verified in session 1731: Otedama never assembles a coinbase from `coinbase_tx_prefix`/`suffix` — it opens *standard* channels and `NewMiningJob` carries the pool-computed `merkle_root` directly (messages.go:87,101), so the witness-vs-txid choice this row guards against does not exist on the V2 path. The V1 path does assemble coinbase (`coinb1 + en1 + en2 + coinb2` → `Hash256`, stratumv1.go:537-546) but hashes exactly the byte string the pool dictates — V1 coinbase parts carry no witness fields to strip, and the pool reconstructs the identical bytes for verification. The hazard would only materialize if a future Extended-channel/JDP path assembles client-side coinbase; record it as a design constraint for that work.
   — (Original row retained below.)
   Strip BIP141 (segwit) fields from the coinbase on Extended Jobs.
   Also fixed in SRI v1.5.0: a client assembling the coinbase from
   `coinbase_tx_prefix`/`suffix` must hash the *non-witness* serialization
   or every share is rejected on a wrong merkle root. Add a segwit-coinbase
   regression fixture to the path feeding `engine.applyJob`.
   (stratum-mining/stratum v1.5.0)
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
   — ✅ **Nuance shipped** (verified session 1726): `stats.go`'s
   `transitionReject` now tags the difficulty epoch active at issue time
   and excludes above-target-family rejects that arrive after the pool
   retargeted (engine run.go:1816-1818 for V1 set_difficulty, run.go:1326
   for V2 SetTarget). The reject-rate metric no longer counts them —
   exactly what this item asked.
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
   — ✅ **Re-verified (session 1734):** the claim holds against current
   code, and is stronger than the note records — each `runSession*`
   declares a fresh `hashrateWindow` (V2: run.go:943, V1: run.go:1492), so
   reconnect doesn't merely saturate a stale baseline, it gets a whole
   new window whose first `observe` re-primes to 0. The saturation arm
   (total < lastTotal → rate 0, stats.go:164-173) additionally covers
   counter shrink *within* a session. Regression pins exist exactly as
   asked: `TestHashrateWindow_SaturatesOnCounterReset`,
   `_ZeroDeltaTimeYieldsZero`, `_FeedsStallMonitor` (run_test.go:875-915).
   Accumulators are `atomic.Uint64` (worker.go:121). Marker flipped 🟡→✅.
7. ✅ **Pin protocol truth to `stratum-mining/sv2-spec`, not the app code.**
   SRI split roles into a separate, independently-versioned repo after
   v1.5.0; update the SV2 reference links in ADR-009 / poolproto comments
   to cite the (stable) spec so the codec tracks the spec, not moving code.
   — ✅ **Already satisfied** (verified session 1735): `internal/stratum/messages.go:11-14`
   declares "The specification's source of truth is the
   independently-versioned repository github.com/stratum-mining/sv2-spec
   (SRI split the roles code out after v1.5.0); stratumprotocol.org
   renders it. When the codec and the site disagree, trust the repo."
   `frame.go` cites stable rendered-spec section URLs; `poolproto/stratumv2`
   reuses that same codec rather than carrying a second protocol truth.
   The `stratum-mining/stratum` references in CHANGELOG/ADR-009 are
   ecosystem tracking of the SRI *implementation* releases — correctly
   distinct from spec truth. No `sv2-rs` or stale link remains.

### Category 4 — decentralisation (arXiv grounding)

8. ✅ **Single-pool concentration enables *undetectable* attacks.** Bahrani &
   Weinberg, "Undetectable Selfish Mining" (arXiv:2309.06847), prove a
   selfish-mining strategy whose orphan pattern is statistically
   indistinguishable from honest mining, profitable from 38.2% hashrate.
   Document in THREAT_MODEL to justify the multi-pool / endpoint-diversity
   defaults as a *security* (not merely liveness) property; strengthens
   Cat 4 #7.
   — ✅ **Already satisfied** (verified session 1736): THREAT_MODEL's
   Tampering section (:135-152) documents the pool-selfishness threat with
   the exact citation (undetectable orphan pattern, 38.2% profitability
   threshold), then frames multi-pool failover + endpoint diversity as
   "*cheap defection*" — the security framing this row asked for — and
   cites pool-vs-local share reconciliation as the closest observable
   signal plus the PPLNS/FPPS residual-risk advice. The mechanisms it
   names are real: `otedama doctor` ships both "Pool diversity" and
   "Pool endpoint diversity" checks (checks.go:448, :498 — warns when
   distinct URLs resolve to one endpoint, "failover is illusory").
   Reference list entry at :496-497.
9. 🔵 **Orphan-aware reconciliation has a fairness rationale.** Grunspan &
   Pérez-Marco, "Block withholding resilience" (arXiv:2211.07270, rev.
   Feb 2025), show accounting for orphans makes honest mining the unique
   optimum. Otedama can't change the DAA, but `doctor` can track
   pool-acknowledged shares vs. pool-credited blocks over a window and warn
   on divergence — grounds Cat 1 #10.
   — 🔵 **Scope refined (verified session 1737):** the share side of the
   divergence signal already ships — SubmitSharesSuccess reconciliation
   clamps pool-claimed accepts to locally settled submits (run.go:1252-1270),
   the starvation tripwires warn once per episode when pool difficulty
   starves income or a connected pool goes silent (run.go:1498-1505),
   and rejects are classified by reason for metric attribution. The
   block side is *structurally unobservable* to a Stratum client: block
   credit travels over Bitcoin, not the stratum wire, so "pool-credited
   blocks" has no data source without a chain-explorer API — a new
   external dependency for doctor, which today is pure config +
   reachability checks (its only HTTP is the clock-skew probe). Whether
   that dependency is in scope is an ADR-level product decision, not a
   maintenance task — deferred rather than implemented speculatively.
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
13. 🔵 **Preemption is the dominant failure mode — price it in.** Duan et al.,
    "GFS" (arXiv:2509.11134, ASPLOS '26), forecast GPU demand and keep a
    reserve quota to cut eviction 33%. A preemption-risk term should raise a
    provider's *effective* switch cost in the A2 ledger so the engine
    doesn't churn a GPU onto a stream it loses in minutes. Pairs with #14
    and Cat 5 #6.
    — **Dispositioned (session 1750):** conditional on a real provider —
    today's only compute backend is simulated, so there is no preemption
    signal to price. Anchored to ADR-010 A2's switch-cost ledger (itself
    🔵) and Cat 5's real-provider row; activates with them.

### Category 6 — arbitration / online optimisation (arXiv grounding)

14. 🔵 **Randomized deadline-aware spot policy with √K competitive ratio.**
    "ROSS" (arXiv:2601.14612) proves deterministic deadline policies are
    stuck at Ω(K) (K = reliable/spot cost ratio) while a randomized reserve
    rule achieves √K (~30% savings). The competitive-analysis counterpart to
    ADR-010 A1/A6; load-bearing only if deadline-constrained inference
    exists.
    — **Dispositioned (session 1750):** correctly self-scoped — no
    deadline-constrained inference surface exists today (simulated
    provider only). Anchored to ADR-010 A1/A6.
15. 🔵 **Adaptive, learned switching cost with sub-linear dynamic regret.**
    "SCaLE" (arXiv:2601.09042) handles ℓ2 switching costs under noisy bandit
    feedback with no known cost structure. Justifies making ADR-010 A2's
    switch-cost ledger *learned / non-stationary* rather than a fixed
    calibration; the regret-optimal target for A2.
    — **Dispositioned (session 1750):** an upgrade target for ADR-010 A2
    (🔵 unscheduled) — the ledger must exist before it can be learned.
16. 🔵 **Track which non-stationarity the engine self-tunes against.**
    "Non-stationary Bandit Convex Optimization" (arXiv:2506.02980, NeurIPS
    2025) gives regret bounds parameterised by switches / total-variation /
    path-length — exactly the three drift types in hashprice/Akash yield
    (difficulty steps, volatility, diurnal). Use its measures to choose the
    self-tuning signal for the Holt-Winters reset threshold (A1+A8).
    — **Dispositioned (session 1750):** signal-selection guidance for
    ADR-010 A1+A8 (🔵) — catalogued, rides with that scope.

### Category 8 — power: real, currently-live feeds

17. 🔵 **Octopus Agile half-hourly REST (no key for read-only rates).**
    `api.octopus.energy/v1/products/<P>/electricity-tariffs/<T>/standard-unit-rates/?period_from=…`
    concretises ADR-008 sub-domain 4; a `power/tariff/octopus.go` poller
    (~30 min) drives the Cat 8 #9 curtailment hook.
    — **Dispositioned (session 1750):** UK-only tariff and one instance
    of the feed-integration decision already parked 🔵 under ADR-008
    sub-domain 4 — rides with that scope (region/feed selection is the
    ADR question, same class as the carbon row). Also note the proposed
    `power/tariff/` path is not in CLAUDE.md's architecture map — an
    implementation lands inside an existing package, not a new dir.
18. 🔵 **Design the tariff interface as a forward *price curve*, not a spot
    price.** Tibber (GraphQL, once-daily curve) and Amber (REST, 5-min AEMO
    forecast) cover EU-Nordic and AU. A "return the forward curve" interface
    accommodates all three and feeds the horizon-aware (Pontryagin) scheduler
    (ADR-008 #2) — plan curtailment windows ahead instead of reacting to spot.
    — **Dispositioned (session 1750):** interface-shape guidance for the
    same ADR-008 sub-domain 4 scope; catalogued as the design constraint
    that any tariff feed must return a curve, not a scalar.
19. 🔵 **For carbon-aware curtailment use *marginal*, not average, intensity.**
    WattTime MOER (5-min marginal emissions) is the correct signal for
    "pause to cut emissions" because curtailing changes load at the margin;
    Electricity Maps average (AOER) understates the effect. Sharpens Cat 8
    #10; keep optional (keys required) per ADR-003.
    — **Dispositioned (session 1750):** sharpens Cat 8 #10, which is now
    🔵 under ADR-008 — catalogued as the signal-selection constraint
    (marginal, not average) inside that scope.

### Category 9/10 — observability & supply-chain (current real tooling)

20. 🔵 **Emit trace exemplars on the submit-latency histogram.**
    prometheus/client_golang v1.23 (Jul 2025) + OpenMetrics 1.0 allow a
    `{trace_id="…"}` exemplar on a histogram bucket so a p99 spike links to
    its trace. Otedama already has the histogram (Cat 2 #7) and OTel spans
    (Cat 9 #3); joining them is a small extension to the hand-rolled
    exposition writer (no client_golang dep — keeps ADR-003/005).
    — **Dispositioned (session 1750):** conditional on Cat 9 #3 — there
    are no trace IDs to exemplar until OTel ships (🔵, v3.3.0 `-tags otel`
    artifact). Joins that scope.
21. ✅ **Follow Prometheus naming: `_info` gauge, bounded labels, std runtime
    metrics.** `CollectFunc`/`RegisterCollector` hook added to `internal/metrics`
    registry; `RuntimeCollector()` emits 12 standard `go_*` metrics
    (`go_goroutines`, `go_info{version}`, `go_memstats_*`, `go_gc_*`) using only
    stdlib `runtime` — no new dependency (ADR-003/005 preserved). Names match
    `prometheus/client_golang` so existing Grafana dashboards work unmodified.
    `otedama_build_info` (commit/goversion labels) shipped in session 54;
    SPECIFICATION §6 has the catalogue row. (session 107)
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
24. ✅→🟡 **Make govulncheck a hard CI gate — gate shipped; advisory
    tracking remains evergreen.** Verified in session 1726: security.yml's
    `govulncheck ./...` step runs with no `continue-on-error`, so any
    finding fails the build — the gate this row asked for exists (added
    session 1265). The remaining ask (recording advisory IDs in
    THREAT_MODEL's dependency assumptions) stays open as an evergreen
    documentation practice. (Original row kept below.)
    🟡 **Make govulncheck a hard CI gate and pin a patched toolchain.** Track
    current Go advisories on the `net/http` surface Otedama exposes
    (`/healthz /readyz /metrics`) — e.g. CVE-2025-22871 (request smuggling),
    GO-2025-3563 — and fail the build on any govulncheck finding. CLAUDE.md
    already mandates the tool; the gap is the gate. Record advisory IDs in
    THREAT_MODEL's dependency assumptions.

### Category 11 — Lightning routing & privacy (arXiv grounding)

25. 🔵 **Bias path selection away from high-betweenness channels.** Abdesselam
    et al., "Payment-failure times for random Lightning paths" (arXiv:
    2511.16376, BRAINS 2025), tie time-to-failure to edge-betweenness — the
    most-traversed channels deplete first. A depletion-aware tie-breaker
    sharpens Cat 11 #6/#7 from qualitative to concrete; catalogue-only while
    receive-only.
    — **Dispositioned (session 1749):** correctly self-scoped as
    catalogue — rides with Cat 11 #6 if a send path ever exists.
26. 🔵 **Seed the min-cost-flow scorer with a cheap balance prior.** Davis et
    al. (arXiv:2405.12087) beat the 50/50-split prior by ~27%. The
    ADR-003-friendly takeaway is a *dependency-free heuristic* prior
    (capacity + degree + age), not the ML model — a small deterministic
    initial liquidity belief feeding Pickhardt-Richter (Cat 11 #6),
    improving first-attempt success without probing.
    — **Dispositioned (session 1749):** same condition — catalogued as
    the prior for Cat 11 #6's scorer.
27. ✅ **One countermeasure, two timing channels — already satisfied.**
    Verified session 1749: THREAT_MODEL :267-271 already documents
    exactly this linkage — "the same class of timing channel exists on
    the payout side: Rohrer & Tschorsch ... HTLC-resolution timing leaks
    payment endpoints in payment-channel networks", and Tor-by-default
    (ADR-007 B7) "mitigates both channels at once". Reference entry at
    :500. No further linkage needed.

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

1. 🟡 **[FETCHED] `gopkg.in/yaml.v3` is archived/unmaintained since 2025-04-01.**
   The `go-yaml/yaml` source repo was archived by its author; the YAML org
   took over at import path `go.yaml.in/yaml`, where v3 is frozen to
   security-fixes-only and active work is in v4. This makes the dependency
   fail CLAUDE.md's own §外部依存 criterion 3 ("meaningful maintenance within
   the last year"), and dates ADR-003's "maintained by go-yaml project,
   stable since 2020" rationale. No CVE against v3.0.1 was found — the issue
   is maintenance status, not an active vuln. **Action:** plan migration to
   `go.yaml.in/yaml/v3` (near drop-in, YAML-org maintained) and correct
   ADR-003. (github.com/go-yaml/yaml; pkg.go.dev/go.yaml.in/yaml/v4)
2. 🟡 **[FETCHED] `golang.org/x/crypto` v0.23.0 is ~31 minor versions behind
   (latest v0.54.0, 2026-07-08); CVEs since are all unreachable here.**
   GO-2025-3487 / CVE-2025-22869 and the May-2026 batch (CVE-2026-39827…39835)
   are all in the `ssh`/`openpgp` subpackages; Otedama imports only
   `chacha20poly1305`, `scrypt`, and `ecdh`, so `govulncheck` should report
   zero reachable vulnerabilities even at v0.23.0. **Action:** bump to v0.54.0
   as routine hygiene and re-run govulncheck to document the zero-reachable
   result. (pkg.go.dev/golang.org/x/crypto?tab=versions; pkg.go.dev/vuln/GO-2025-3487)
3. 🟡 **[SNIPPET] `toolchain go1.24.0` predates the container-aware GOMAXPROCS
   that GODEBUG_NOTES.md relies on.** Container-aware `GOMAXPROCS` (reads the
   cgroup CPU limit on Linux) shipped in Go 1.25 (Aug 2025); the pinned
   toolchain is 1.24 (Feb 2025), so GODEBUG_NOTES.md's `containermaxprocs`
   section — which calls that behavior "load-bearing for correct CPU mining
   throttling under cgroup constraints" — describes a benefit not actually
   compiled in today. **Action:** bump `toolchain` to go1.25.x per the repo's
   own quarterly-toolchain policy. (go.dev/doc/go1.25)
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

## Highest-leverage next actions (cross-category synthesis)

Ranked by impact on the path to a real v3.1.0 — **status updated session
463** (the original list predates the sessions that shipped several items):

1. **secp256k1 (Cat 10 #1 / Cat 2 #3)** — **open**. The Noise NX handshake
   still stubs secp256k1+ElligatorSwift with P-256 (`internal/stratum/noise.go`);
   scheduled for v3.1.0, needs an ADR for the dependency decision.
2. **engine→poolproto wiring (Cat 2 #8)** — **partly done**. V1 sessions
   route through `poolproto.DialURL` in `internal/engine/run.go`; the V2 path
   still uses inline framing — bridging the stratumv2 dialer into the session
   loop is pending (see the `runSession` doc comment).
3. **Reject-reason classification + reject-rate metric (Cat 1 #1–2, Cat 9 #4)**
   — **done**. `otedama_reject_rate` plus per-category reject counters
   (`otedama_shares_rejected_by_reason_total`,
   stale/duplicate/difficulty/hardware/other) live in
   `internal/engine/metrics.go`.
4. **Real Akash REST (Cat 5 #1)** — **open**. The provider is still the
   simulated AkashProvider; external-API work.
5. **Submit-latency + pool-state metrics (Cat 2 #7, Cat 9 #5/#7)** — **done**.
   `otedama_submit_latency_milliseconds` (seq→ack RTT) and the connection/
   rate-source gauges are registered in `internal/engine/metrics.go`.

Items 3 and 5 were shipped in the intervening sessions; the remaining open
items are 1, 4, and the V2 half of 2.

---

## September 2026 research pass — session 271 increment

1. ✅ **Server→client input audit — V1 notifications & V2 frame dispatch,
   all bounded:** `client.reconnect`/`mining.reconnect` is honored but the
   pool-supplied host:port is deliberately not followed (redirect-attack
   defense) and the exponential reconnect backoff bounds a reconnect
   flood; `client.show_message` is a drop-oldest bounded channel;
   `set_extranonce` carries the session-262 size bound; `set_version_mask`
   (BIP310) is ignored — correct, rolling is opt-in and never required.
   V2 `DispatchFrame` maps unknown/newer message types to `Unknown`
   (forward-compatible skip), so a pool sending e.g. `SetExtranoncePrefix`
   cannot fatal the session; only malformed *known* frames end it. Both
   V2 job stores are bounded (live loop `jobsCap`, adapter `pendingCap`).
   No code change needed — verdicts recorded, plus a pre-existing gofumpt
   nit in `integration_test.go` cleaned.
2. ✅ **[FETCHED] Ecosystem steady:** unchanged since session 270.

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

## Session 306 — consolidate research backlog into ADRs/THREAT_MODEL/KNOWN_LIMITATIONS (re-delivers closed #376)

**Change [OBSERVED].** Landed the session-264 docs consolidation on master:
sv2-spec repo pinned as the canonical SV2 source (messages.go + ADR-009);
KNOWN_LIMITATIONS Akash shape corrected (chain-sdk + on-chain Bidengine +
AEP-64 JWT); THREAT_MODEL gained the undetectable-selfish-mining threat
(honest "no mitigation — cheap defection") + LN HTLC timing linkage;
ADR-010 gained SCaLE learned-switch-cost (A2), the three drift-type
non-stationarity grounding + Sliding-Window TS (A8), and ROSS in refs.
Cat-4 #9 left open on purpose — pools never report credited blocks, so the
written action is infeasible; recorded as such.

## Session 323 — server→client input audit verdicts, round 3

Re-audit of pool-controlled inputs left uncovered by sessions 271/309
plus this stretch's upstream drift check (SRI 1.12.0 still latest;
ESP-Miner v2.15.1/v2.15.2rc0 reviewed — the only mining-relevant fix,
"prevent reconnect storms from slow clients" #1913, is pool-server-side
machinery Otedama doesn't run; the client-side equivalent — exponential
reconnect backoff 1s→64s + address failover — already exists in
runReconnectLoop).

**Verdicts [OBSERVED — code-verified this session].**

- `mining.notify` coinb1/coinb2/merkle_branch: never unmarshalled on
  master (coinbase reconstruction is #417's scope, still open); the raw
  frame is bounded by the 64 KiB line limit — no unbounded input.
- CPU worker nonce space: `NonceStep` defaults to `Threads` so threads
  interleave disjoint nonce sequences — no duplicate-work partition bug.
- `TargetFromNBits`: rejects negative-mantissa bit, exponent < 3, zero
  mantissa, and >256-bit targets. `TargetFromDifficulty` rejects d<=0,
  NaN, ±Inf, and overflowing targets. Both bounded.
- `mining.set_version_mask` / unknown notifications: forward-compatibly
  ignored — no state touched.
- `client.show_message` notice channel: bounded drop-oldest queue.
- Terminal/log injection: no pool-controlled string reaches the TUI
  (pool URL + provider names are operator config; wallet fingerprint is
  hex-only). Pool notices go to slog (session-278/#424) — slog text
  output passes control bytes through for string values containing
  newlines, so a hostile pool could forge log lines; recorded as a
  residual in THREAT_MODEL terms, cosmetic severity.
- `otedama_build_info`: backlog line claiming "deferred" was stale — the
  gauge shipped in session 54 and is catalogued in SPECIFICATION §6;
  corrected.

## Session 326 — hygiene sweep verdicts (govulncheck + deadcode)

**govulncheck (go1.26.8) [OBSERVED — ran live].** 0 reachable
vulnerabilities; 22 module-level advisories in the require graph, all
in code paths Otedama does not call (same pattern as prior sessions).

**deadcode ./... [OBSERVED — ran live].** Every hit is intentional
public-ish API surface on internal packages (btccrypto helpers,
clock.Fake test utilities, i18n catalogue helpers, lightning
WordList/MnemonicToEntropy, httpserver.Addr/ServeError) — used by tests
or reserved for in-flight v4.0 scope. Judged not-deletable; recorded so
the sweep doesn't re-flag them as findings.

**Coverage sweep [OBSERVED].** Server→client input surface, worker nonce
partitioning, provider quotes (stale-pruned at 3 min), metrics label
cardinality (fixed enums), config/env parsing, wallet KDF constants,
HTTP server timeouts — all verified bounded/safe on master.

## Session 328 — remaining surface verdicts

**mining.set_version_mask [OBSERVED].** Ignored server→client
notification (parse-only, never consumed) — BIP320 version-rolling is
not implemented (coinbase reconstruction is open PR #417 scope); a
malicious mask value can at worst be dropped, which it already is.

**Worker Threads [OBSERVED].** Not user-configurable — always
`runtime.NumCPU()` via DefaultWorkerConfig; `Threads<=0` falls back to
NumCPU; `NonceStep=0` resolves to Threads. No goroutine-flood path.

**internal/rates [OBSERVED].** http.Client Timeout=10s per fetch,
64 KiB LimitReader on bodies, three-source median (Coinbase/Kraken/
CoinGecko). Hashrate feed (s320) reuses the same bounded client shape.

**internal/daemon [OBSERVED].** systemd/launchd unit files written
0644 in 0755 dirs — correct modes for service units (world-readable
config is systemd convention; no secrets inside).

**internal/i18n [OBSERVED].** Missing-key fallback is explicit
(requested tag → base tag → English); no panic/empty-render path.

**internal/config [OBSERVED].** Env-var numeric parsing warns-and-skips
on malformed values (two ParseFloat sites, both error-handled); no
panic paths.

**internal/provider [OBSERVED].** quoteCh buffered 16; no unbounded
map/state on quote arrival.

## Session 329 — SRI 1.12.0 cipher alignment (verified)

**noise_sv2 dropped AES-256-GCM [FETCHED — freedom.tech SRI 1.12.0
release notes, 2026-09-17].** SRI now ships ChaCha20-Poly1305 as the
sole Noise cipher. **Otedama is already aligned**: `internal/stratum/
noise.go` implements only `Noise_NX_secp256k1_ChaChaPoly_SHA256` — no
AES-GCM code path exists to remove, and interop with 1.12.0 peers is
unaffected.

**Repo split note [FETCHED].** Roles moved to `stratum-mining/sv2-apps`
under a separate versioning scheme; `stratum-mining/stratum` keeps the
library crates. Our sv2-spec canonical-source pin (s306) is unaffected.

**ESP-Miner v2.15.3 [FETCHED].** Per-preset low-frequency warnings —
dashboard tuning only, no pool-protocol change. `checksum-test-0`
(2026-09-26) is a CI test tag, not a release.

## Session 330 — ecosystem + Japanese-source scan verdicts

**internal/hal GPU sysfs [OBSERVED — clean].** sysfs reads bounded by
kernel-managed files; Identity.Validate() gates every parsed device;
SHA256d=false hardcoded with rationale (no compute dispatch exists) —
prevents GPU-attributed CPU-pool oversubscription.

**Qiita/Zenn scan [FETCHED].** No new actionable findings: Zenn hits
were ONF Stratum (SDN switch OS, unrelated). Found `0xf0xx0/stratumv2`
(Go SV2 codec library) as comparable prior art — MIT-licensed, covers
frame+mining messages only; Otedama's internal/stratum already covers
its scope plus Noise NX, so no adoption rationale (would add a dep for
no new capability; CLAUDE.md dep criteria unmet).

**SRI roles repo confirmed [FETCHED].** sv2-apps carries pool/JD-client
/translator roles; `stratum-mining/stratum` keeps library crates only —
the channels_sv2 1.12.0 hardening (share validation, bounded job
storage, consensus-defect coinbase fixes) is pool-server-side, all
mirrored client-side in our already-landed bounds (#385/#397/#429) and
coinbase rebuild (#417, still open).

## Session 334 — metrics exposition verdict (final surface)

**internal/metrics [OBSERVED — clean].** Label names are validated at
registration (panic on malformed — a bad name would corrupt the whole
scrape); label values escape `\`, `"`, `\n` per exposition spec; HELP
escapes `\` and `\n`. Dynamic label values are all bounded-cardinality:
status/quantile/reason are fixed enums, device IDs come from hal
Identity.Validate(), address is the masked user payout address.
No pool-controlled string can mint new label series or inject into the
exposition format.

**Audit coverage is now complete on master.** Every package's externally
-influenced input path has been audited in sessions 262–334: pool
V1/V2 (en2, job maps, seq numbers, reconnect, deadlines), provider
quotes, rates fetchers, config/env/YAML, wallet.dat, sysfs, i18n,
daemon, metrics labels, arbitration params. Remaining backlog items are
all blocked on unmerged PRs (#417 coinbase rebuild, #432 hashrate feed,
go1.26 module bump) — not on missing analysis.

## Session 346 — ecosystem re-check + wallet/metrics audit verdicts

**Ecosystem [FETCHED].** No drift since session 344: SRI v1.12.0 remains
the latest release (Sep 17); ESP-Miner v2.15.3 (Sep 20) is a
prerelease-scoped UI warning fix with no stratum changes. SRI v1.11.1's
"do not round up SV1 difficulties" fix was verified against our client
path: `TargetFromDifficulty` divides `diff1Target` by the pool value
with 256-bit `big.Float` precision and truncates — never rounds up.
A difficulty so small the target exceeds 256 bits returns an error, and
`v1JobTarget` then falls back to the nBits block target (the strictly
harder bound — fails safe toward starvation, never toward
accept-everything).

**Audit verdicts [AUDITED — clean].**

- `stratumv1.parseAddress` returns the host:port remainder unvalidated,
  but malformed values fail fast in the (now 15 s-bounded) dial — a
  config-error surface, not an injection path; credentials are passed
  separately and never spliced into the URL, so URL-bearing errors
  cannot leak a password.
- `btccrypto.ValidateAddress` verifies the checksum (bech32/bech32m or
  Base58Check) and is enforced on every pool payout address at config
  load — a mistyped address fails startup rather than mining to a dead
  destination.
- `hashrateWindow.observe` saturates: a counter reset on reconnect
  yields rate 0, never negative or NaN; the first sample only primes.
- `printRecoveryPhrase` writes the mnemonic exclusively to
  `opts.Output` (stdout on first run) — it is never passed to the
  logger; wallet.dat stores only the encrypted seed.

## Session 347 — provider/engine/worker audit verdicts (all clean)

**Provider quote path [AUDITED — clean].** Both providers are local
simulators — no network fetch: `ai_inference` quotes the midpoint of the
configured USD/hour range, `mining` computes yield from the static
network-hashrate constant (the live feed remains on open PR #432). No
response-size or redirect concerns apply; quote channels are buffered
(32/16) so a stalled consumer cannot wedge the publisher.

**Engine session loops [AUDITED — clean].** Every `for/select` in
`run.go` honors `ctx.Done()`; the reconnect backoff uses
`time.NewTimer`+`Stop` so shutdown does not linger; the V2 read
goroutine checks ctx on every send and closes `inCh` on exit — no spin,
no goroutine leak on teardown.

**Worker nonce space [AUDITED — clean].** Threads partition the 32-bit
nonce space by `threadID + k*Threads` (NonceStep defaults to Threads, so
sequences are disjoint); a new job resets the counter rather than
exhausting the space. uint32 wrap re-hashes old nonces, which is the
accepted stratum behavior — a fresh job or an extranonce roll
supersedes long before exhaustion at any real hashrate.

**SV2 frame bound [AUDITED — clean].** `Decoder.ReadFrame` enforces
`MaxFrameSize` (default 16 MiB, SRI-aligned) *before* allocating the
payload buffer — a malicious length header cannot force a large
allocation. Already covered by the v1.12.0-alignment pass; re-verified
on master this session.

## Session 352 — wallet-write, TUI, doctor audit verdicts (all clean)

**Wallet save path [AUDITED — hardened].** `wallet.dat` is written via
`CreateTemp` + `Sync` + `Chmod 0600` (before rename, so the file is
never world-readable even momentarily) + atomic `Rename` on the same
filesystem — a mid-write kill cannot corrupt the wallet. The public
fingerprint file is a best-effort convenience write (0600, recoverable
from the seed); `loadExisting` caps the input (session 333) and returns
an opaque error on wrong passphrase — no oracle.

**TUI render path [AUDITED — clean].** The dashboard renders only
operator-config strings (pool URL) and numeric stats; `shortenURL`
byte-truncates for narrow terminals. No wire-derived text reaches the
dashboard. (The show_message notice would arrive sanitized by the
session-348 parser change.)

**Doctor checks [AUDITED — clean].** All 17 checks reviewed; the only
network probe is `checkPoolReachability` — `net.Dialer{Timeout: 5s}`,
ctx-aware, closes the connection, and quotes the URL with `%q`. The
host string logged is the operator's own config value. Clock-skew and
rates probes were hardened in earlier sessions (no redirects, bounded
bodies).

## Session 356 — hal/sysfs and V1 dispatch verdicts

**GPU sysfs enumeration [AUDITED — clean].** `internal/hal/gpu_linux.go`
enumerates `/sys/class/drm` via `os.ReadDir` and reads sysfs attributes
with `readSysFile` (unbounded `os.ReadFile`). Both inputs are
kernel-generated; fabricating them needs root, which is already outside
the threat model — a local-root attacker owns the box. No bound added.

**V1 server→client dispatch [AUDITED — complete].** All six handled
methods (`mining.notify`, `set_difficulty`, `set_extranonce`,
`client.show_message`, `client.reconnect`/`mining.reconnect`) are
parsed-or-dropped; unknown methods (`set_version_mask`, etc.) fall
through harmlessly — ignoring version-rolling masks is correct for a
CPU/GPU arbiter (no version-rolling hardware path exists). In-flight
fixes for `set_extranonce` atomicity (PR #450) and `set_difficulty`
validation (PR #456) are deliberately not re-delivered here.

**Noise transport wiring [OBSERVED — intentionally dormant].**
`internal/stratum`'s `NewHandshakeInitiator`/`NewEncryptedConn` are
unwired from `poolproto` — V2 runs plaintext per KNOWN_LIMITATIONS §3,
which documents the gap and the logged warning. Not dead code to
delete; it is the staged substrate for a future encryption land.

**Ecosystem [FETCHED — steady].** SRI v1.12.0 (Sep 17) and ESP-Miner
v2.15.3 (Sep 20) remain latest; no new stratum-facing changes since
session 346.

## Session 362 — btccrypto + dependency-posture verdicts

**btccrypto [AUDITED — clean].** Bech32: BIP-173 length cap (90),
mixed-case rejection, charset validation, witness version ≤ 16, and
BIP-350 checksum-constant selection. Base58Check: alphabet check,
decoded-length check, checksum verify, version-byte whitelist.
secp256k1 schemes are honest stubs returning `ErrSchemeNotImplemented`
— no fake crypto satisfies a caller silently.

**Dependency posture [FETCHED — zero reachable].** `govulncheck ./...`
on master under go1.26.8: 0 vulnerabilities reachable in Otedama code;
22 module-level findings exist in required modules but none are in
called paths (module updates still worth landing via #444's yaml
migration).

## Session 363 — provider lifecycle verdicts

**Polling lifecycle [AUDITED — clean].** `pollingProvider`: bounded
quote channel with drop-oldest backpressure, ctx-aware sends,
WaitGroup + channel-close teardown. Double-Start rejected before any
state mutation. Publish math is deterministic and finite — fallback
rate (95000) only on `rate <= 0`; a hypothetical non-finite remote
rate would fail JSON decode (`1e999` errors at unmarshal) before
reaching `BTCUSDRate`.

**Latent caveat [OBSERVED — unreachable today].** `Stop()` recreates
`quoteCh`, but `runArbitrationLoop` holds the *old* channel; a
Stop→Start cycle would leave quotes going to a channel nobody reads
after the old one closes (the loop exits on `ok=false`). Providers are
started once and stopped only at shutdown — the path is unreachable.
Recorded rather than fixed: a proper fix needs an API-level decision
(reconnectable quote source), not a drive-by change.

## Session 364 — wire-format + shutdown verdicts

**V1 share serialization [AUDITED — correct].** `mining.submit` emits
ntime and nonce as `%08x` big-endian hex — the stratum convention —
while `Header.Bytes()` hashes the little-endian field order Bitcoin
requires. The two representations are consistent: the share the pool
verifies reconstructs the same 80-byte header. `extranonce2` is
raw-hex (verbatim bytes the pool split off), correct per spec.

**Shutdown path [AUDITED — complete].** `signal.NotifyContext`
(Interrupt + SIGTERM) → engine ctx → `defer conn.Close()` unblocks
`ReadFrame`/`call` waits → workers' inner ctx cancels → providers'
Stop is deferred after engine exit. Every blocking surface audited in
s354–s358 reaches a ctx or conn close; no orphaned goroutine survives
a clean shutdown.

## Session 397 — transport + fan-in + encode-side verdicts

**V1 outbound request side [AUDITED — clean].** `authorize`/`subscribe`/
`mining.submit` marshal operator-controlled fields only (worker name,
password, job params); the pending-RPC map evicts entries on every exit
path (response, timeout, ctx cancel, conn close) — audited in s355 and
re-verified. `buildSubmit` hex-encodes fixed-width integers; no pool
string is ever reflected outbound.

**V1 `readLine` [AUDITED — 64 KiB bound].** `bufio.Reader.ReadSlice` +
`ErrBufferFull` cut-off; the returned slice is copied out of the ring
buffer so a no-newline pool line can never grow memory (the old
`ReadBytes` path accumulated unboundedly — fixed earlier, confirmed).

**TLS dialers [AUDITED — hardened].** Both `stratum.DialTLS` and
`stratumv1.dialTLS` share the same shape: `MinVersion: TLS1.2`,
verification always on, `ServerName` auto-filled by `crypto/tls` from the
dial address (documented in both files), `tlsConfigWithExtraCAs` for
private-CA pools, never a plaintext fallback. `tls.Dialer.DialContext`
completes the handshake inside the call, so a verification failure is a
dial error, not a first-write surprise.

**`engine.fanIn` [AUDITED — leak-free].** Both merge helpers select on
`ctx.Done()` on *both* the input receive and the output send — a stuck
producer cannot pin the goroutine or keep `out` open after cancel; the
closer goroutine exits on `wg.Wait()`. Buffer is `bufFactor×N` capped at
64 — bounded regardless of worker/provider count.

**`hal` sysfs reads [AUDITED — safe].** `inferModel`/`readSysFile` read
kernel-generated sysfs attributes only (behind the DAC wall), trim
whitespace, and never numeric-parse untrusted input — there is no parser
surface here to fuzz.

**BIP-39 wordlist [VERIFIED — integrity-checked].** The embedded
2048-word English list is split at init and pinned by a SHA-256 check —
corruption fails closed (panic at init) rather than silently mis-encoding
entropy.

**SV2 `ExtraNonce2Size` [AUDITED — decoded but unconsumed].**
`OpenMiningChannelSuccess.Extranonce`/`ExtraNonce2Size` decode correctly
(lenient `getB0_255`, spec is `B0_32` — Postel asymmetry documented at
handshake.go:246) but the value is not yet consumed by the live engine
submit path — `SubmitSharesStandard` on master carries
channel/seq/job/nonce/ntime/nversion only. Full coinbase/extranonce
assembly is the documented protocol-completeness gap, not a memory
safety issue; deliberately left for the v3.1.0 work rather than a
hard-fail on >0, which would break every existing SV2 connection.

**`detectDevices` tail coverage [AUDITED — unreachable without refactor].**
The uncovered ~30% is the concrete-driver registration failure paths —
`cpuDriver{}`/`GPULinuxDriver` `Register` cannot fail without fault
injection; testing it would require an interface seam that exists only
for the test. Recorded, not padded.

**Ecosystem [RE-VERIFIED — unchanged].** SRI v1.12.0 (2026-09-17) remains
the latest SRI release: the `noise_sv2` 2.0.0 AES-256-GCM drop and the
codec/framing split do not change any live Otedama path — the in-process
Noise surface stays the documented alpha stub (KNOWN_LIMITATIONS §2).

## Session 400 — provider liveness gap (surfaced) + publish() audit

**Mining yield quoted while pool is down [🟡 SURFACED — needs design
decision, not a silent fix].** `MiningProvider.publish` emits full
expected yield for every SHA256d device regardless of pool session
state — there is no connectivity input on the provider. During a
reconnect gap or total failover exhaustion, arbitration keeps devices
assigned to "mining" at positive yield rather than re-routing them to
AI/compute providers.

No electricity is wasted — workers whose job queue is empty sit in the
10 ms idle loop and burn nothing — so this is an opportunity-cost gap
(AI yield forgone during long outages), not a power bug. The fix is a
design choice: (a) `poolConnectionState` gauge already tracks
connectivity, so a `HealthyFunc`/`ConnectedFunc` on MiningProvider
could zero the mining yield while disconnected; (b) hysteresis already
suppresses thrash for short outages; (c) product rule question — should
a disconnected pool keep devices "reserved" for mining anyway (faster
resume, no AI churn)? Recording per CLAUDE.md's requirement→design
workflow rather than coding it unilaterally.

**`publish()` math [AUDITED — correct].** sats/sec = deviceHashrate /
networkHashrate × blockReward / 600 s × 1e8, ×0.99 for pool fee;
confidence 0.95 fresh rate / 0.7 stale; `rate <= 0` falls back to a
documented 95 k USD estimate. BTC/USD intentionally does not scale the
sats-denominated yield (`_ = rate` is a deliberate placeholder for a
future USD display, flagged in the comment). Live `HashrateFunc` beats
static per-family estimate when > 0; static constants documented in
KNOWN_LIMITATIONS §7.

## Session 401 — seedstore.go audit; per-file sweep complete

**`internal/lightning/seedstore.go` [AUDITED — clean]** — the last file
in the repo not yet individually reviewed:

- `EncryptSeed`: rejects empty passphrase (an empty scrypt input is
  deterministic but provides no protection); salt+nonce from
  crypto/rand (injectable reader for tests); key and passphrase copies
  zeroed via `zeroBytes` on every path.
- `DecryptSeed`: version gate before crypto work, empty-ciphertext
  rejection, GCM tag failure mapped to the indistinguishable
  `ErrWrongPassphrase` (no decryption oracle — a precise wrong-key vs
  corruption split would leak information), 64-byte plaintext length
  enforced, plaintext wiped on return paths.
- `Marshal`/`UnmarshalEncryptedSeed`: fixed 29-byte header, min-length
  bound before slicing, version checked in both directions.
- scrypt N=2^17/r=8/p=1 matches the doc comment's ~1 s interactive
  target and BIP-38 ballpark.

**`stratum.Decoder.ReadFrame` [AUDITED — bounded].** Payload size is
checked against `MaxFrameSize` (16 MiB default) *before* the
allocation, so a hostile peer announcing a huge `MsgLength` cannot
exhaust memory. `Header.Validate` also rejects channel frames under the
4-byte minimum (channel_id prefix). The message-type byte itself is
validated downstream by `DispatchFrame`.

**`WalletManager` lifecycle [AUDITED — safe]** — constructed once in
`engine/setup.go`, read (`Seed`/`Fingerprint`/`IsNew`/`Mnemonic`)
during the same single-threaded setup phase, never touched from the
run loop. No mutex needed because no concurrent access exists; noted
so a future TUI/metrics reader doesn't add one silently.

With this, every file under `internal/` and `cmd/` has been audited at
least once across sessions 340–401.

## Session 402 — skills/ drift fixed [FIXED]

**`skills/tdd.md` described test infrastructure that never existed**
[FIXED]. Three fabricated mechanisms corrected to match the real
Makefile/test topology:

- "integration tests gated by `//go:build integration`, run via
  `make test-integration`" → reality: no build tag exists anywhere in
  the repo; slower tests are gated by `testing.Short()` and live in
  ordinary `_test.go` files; `make test-integration` runs the full
  suite. The old text silently instructed contributors to add files
  under a tag nothing consumes.
- "E2E tests under `//go:build e2e` run via `make test-e2e`" → no E2E
  suite or `test/e2e/` package has ever existed; the Makefile
  documents the target's deliberate omission. Rewritten to state that
  plainly and point at the engine fake-pool integration tests as the
  current end-to-end coverage.
- "LDK regtest harness / channel tests" and "zkSNARK circuit tests" →
  Lightning payment channels and ZKP auth are v4.0 scope per CLAUDE.md
  and do not exist in the codebase; the paragraphs now read as future
  guidance rather than describing present infrastructure (the existing
  BIP-39/AES-GCM wallet test surface is named instead).

**`skills/release-procedure.md` [FIXED]** — the release checklist
demanded a green run of `otedama migrate-from-v2`, a subcommand that
has never existed. Replaced with a config-load-path verification and a
note that `make test-e2e` does not exist (prevents a releaser failing
the checklist on a phantom step).

Note: the integration/E2E/`migrate-from-v2` corrections in `skills/tdd.md`
and `skills/release-procedure.md` had already landed on master in
session 483, so the duplicate paragraphs were dropped from this change;
only the Lightning/ZKP v4.0-scope rewrite in `skills/tdd.md` remains.

`skills/code-review.md`, `security-audit.md`, and both quality-pass
files contain no phantom commands [AUDITED — clean]; the "24 package"
count in the quality-pass files matches `go list ./...` = 24.

## Session 404 — docs/ flag sweep; phantom --worker-threads fixed [FIXED]

**`docs/TROUBLESHOOTING.md` recommended a nonexistent flag [FIXED].**
The "high CPU usage" section told users to run `otedama run
--worker-threads 4`. No such flag exists — `run` accepts only the 15
flags defined in `cmd/otedama/run.go`, and `WorkerConfig.Threads`
defaults to `runtime.NumCPU()` with no CLI/config override. Replaced
with the real mechanism (`GOMAXPROCS`, which caps how many grinding
goroutines run in parallel) and kept the OS-level quota options.

**All other docs flag/subcommand references [AUDITED — accurate].**
Every `otedama` invocation across API.md, DEPLOYMENT.md,
TROUBLESHOOTING.md, MIGRATING-FROM-V2.md, competitive-analysis.md maps
to a real subcommand (run/version/config/service/doctor/completion);
every `--flag` maps to a defined `fs.*` registration except container/
OS-tool flags (docker `--name`/`--restart`, useradd `--system`/`--home`)
correctly shown in their own contexts. `otedama v` is a real alias for
`version`.

**skills/ quality-pass "24 packages" [VERIFIED]** — matches
`go list ./...` output exactly.

## Session 403 — CONTRIBUTING/README command audit + DCO drift [SURFACED]

**DCO sign-off required by CONTRIBUTING.md but not practiced [🟡
SURFACED — maintainer policy decision].** CONTRIBUTING.md §DCO states
all commits must carry `git commit -s` Signed-off-by, and the PR
template repeats it. Reality: **zero** of the last 50 commits on
master carry the trailer — including the maintainer's own merges and
every session-NNN PR landed so far. The requirement is either (a)
intended but unenforced — in which case a CI DCO check would be the
fix, or (b) stale boilerplate carried in from a template — in which
case the docs should drop it. Deliberately NOT edited: whether the
project wants DCO is a legal-policy call for the maintainer, and a
docs patch that silently removes a contributor's attestation
requirement could hide real intent. Recorded here instead; the PR
template's DCO checkbox likewise goes unchecked in practice.

**CONTRIBUTING.md command surface [AUDITED — accurate].**
`make setup`/`build`/`test`/`lint` all exist and do what the doc says;
`.golangci.yml` exists and is referenced correctly; the PR-flow
section (feature branch, `make test` + `make lint`, template) matches
practice.

**README.md [AUDITED — clean].** Only command reference is
`make build` — exists; no phantom targets or flags. CLI flag docs
(`docs/API.md`) were already verified against `cmd/otedama` in
sessions 339/346.

## Session 406 — API.md env-var table completed [FIXED]

**API.md's environment-variable table omitted five real vars [FIXED].**
`OTEDAMA_ARBITRATION_HYSTERESIS_PCT`, `OTEDAMA_CURTAIL_BELOW_BTC_USD`,
`OTEDAMA_MIN_YIELD_SATS_PER_SEC`, `OTEDAMA_POWER_WATTS`, and
`OTEDAMA_ELECTRICITY_PRICE_PER_KWH` are all implemented in
`internal/config/config.go` (validated, origin-tracked) and documented
in `config.yaml.example` — but missing from the user-facing env table.
Added rows noting they are config-file-only knobs (no `--flag`
equivalent) with their yaml key names and the metrics each enables.

**Cross-checks [AUDITED — clean]:** every other `OTEDAMA_*` var named
in API.md/DEPLOYMENT.md/TROUBLESHOOTING.md exists in code; Dockerfile
(distroless + nonroot + static ldflags version injection, VOLUME at
/var/lib/otedama) matches DEPLOYMENT.md's run/compose examples; the
compose healthcheck (`otedama doctor`) and the loopback-published
metrics port both behave as documented.

Note: `EXPOSE 0` in the Dockerfile is a documented no-op (the binary
dials out; metrics binds only when `--http-addr` is set inside the
container) — harmless, left as-is since the comment explains intent.

## Session 407 — release pipeline vs VERIFY.md: major drift [SURFACED]

**The release pipeline does not produce what VERIFY.md documents
[🔴 SURFACED — maintainer action needed on workflow].**
`.github/workflows/release.yml` builds plain `otedama-<os>-<arch>.tar.gz`
via `go build` + `upload-release-asset`: **no checksums.txt, no cosign
signatures, no SBOMs** are ever generated — yet VERIFY.md instructs users
to verify them, and `.goreleaser.yaml` (with the full cosign/SBOM config)
is never invoked by any workflow. Users following VERIFY.md today find
nothing to verify — verification theatre, a security-documentation bug.
VERIFY.md now carries a status banner stating only the source-rebuild
check works, and all asset names were corrected to goreleaser's real
name templates (`otedama_<ver>_checksums.txt{,.sig,.pem,.bundle}`,
`otedama_<ver>_<os>_<arch>.sbom.*.json`) for when the pipeline goes live.

**Additional release.yml defects found while auditing [SURFACED]:**
- `-X main.Version=...`/`main.BuildTime`/`main.GitCommit` inject into
  `main` — the real vars live at `internal/version.{Version,BuildDate,
  Commit}` (even the names differ). `-X` on a nonexistent symbol is a
  silent no-op: **every tagged release binary reports dev defaults**
  from `otedama version`.
- Release body links `docs/DEPLOYMENT_GUIDE.md` — file does not exist
  (the real guide is `docs/DEPLOYMENT.md`); dead link in every release.
- `build-packages` (fpm deb/rpm) references `scripts/post-install.sh`,
  `scripts/pre-remove.sh`, `scripts/otedama.service`, and `config.yaml`
  — none exist, so the job fails on any tag push.
- fpm metadata claims `--license MIT`; the project is Apache-2.0.
- `update-homebrew` targets tap repo `otedama/homebrew-tap` — different
  org than `shizukutanaka`; likely a stale placeholder.

Not fixed: all defects are in `.github/workflows/` — CI files outside
the safe-edit boundary; recorded here for the maintainer (the fix is
either wiring goreleaser into release.yml or correcting the inline
pipeline).

## Session 408 — migration guide drift vs code reality [FIXED]

**MIGRATING-FROM-V2.md claims corrected [FIXED].**
The guide told v2 users "v3 has no V1 fallback" / "v3 is V2-only" /
"[stratum_v1] — no V1 support" — all false: v3 has full Stratum V1
support (`internal/poolproto/stratumv1`, `stratum+tcp://`+`stratum+tls://`
schemes, `v1PoolWorker` in engine). Corrected to describe dual-protocol
support and the per-pool URL-scheme selection. Also corrected the CI
boast: "nightly fuzz, cosign signing" — no workflow runs fuzzers (they
exist + `make fuzz` works, but no scheduled job) and cosign is not
wired into release.yml (session 407). "verify the signature" in the
install step → pointed at VERIFY.md's current-reality flow.
DEPLOYMENT.md's hardening checklist already carries master's session-485
notes on the checksum/cosign items, so it is not re-edited here.

**Also found [SURFACED]:** CLAUDE.md's architecture map itself lists
`test.yml (fuzz+benchmark)` — test.yml has benchmarks but no fuzz job.
CLAUDE.md changes require maintainer agreement per its own update
clause, so recorded rather than edited.

**Audited — clean:** config.yaml.example value ranges match config.go
validation ([0,1) hysteresis, ≥0 floors); doctor `--bitcoin-address`
flag exists as documented; AUDIT_CHECKLIST scrypt claim (N=32768 vs
actual 1<<17) already corrected in open #494 — no re-delivery needed.

## Session 410 — THREAT_MODEL claims vs shipped reality [FIXED]

**False mitigation claims corrected [FIXED].**
- "Falling back to V1 is not supported, so downgrade attacks are
  structurally impossible" — V1 support shipped long ago
  (`internal/poolproto/stratumv1`, ADR-006). Rewrote the Spoofing
  section: protocol is chosen by the operator's URL scheme; a
  `stratum+v2*` pool cannot be downgraded by an attacker (no
  auto-negotiation), but a `stratum://` config is plaintext with zero
  MITM protection — now documented as a residual risk with guidance.
- "fuzz tests run nightly with automatic crasher reporting" — no
  fuzz job exists in any workflow; replaced with the accurate
  inventory (fuzzers ship in-repo, `make fuzz`; scheduled CI fuzz
  not yet wired).
- "Release artifacts are cosign-signed" — false (session 407 finding);
  reframed as planned-not-live with the source-rebuild path.
- "Only three runtime dependencies" listed two deps + stdlib — now
  "two third-party dependencies" plus stdlib.
- ADR-002 reference annotated as partially superseded by ADR-006.

**Verified — accurate as written:** $95,000 fallback constant
(engine/run.go:205), median-of-3 price feeds, MaxFrameSize=16 MiB
pre-allocation bound, bounded job channel (32), atomic wallet write,
maskAddress truncation, non-root service hardening flags.

**Not touched:** the stale `scrypt (N=32768)` claim — already fixed
in open #494; editing the same line would conflict.

## Session 411 — GODEBUG_NOTES/ADR cross-reference audit [FIXED]

**Dead cross-reference fixed [FIXED].** GODEBUG_NOTES tells users
"see docs/THREAT_MODEL.md for the rationale" on FIPS — but
THREAT_MODEL contained zero FIPS content. Added a Posture notes
section to THREAT_MODEL carrying the actual rationale (Noise NX's
ChaCha20-Poly1305 is not FIPS-listed; wallet-at-rest AES-256-GCM is;
`fips140=on` does not make that transport FIPS-validated).

**Audited — clean:** GODEBUG_NOTES knob inventory matches go.mod's
godebug block exactly (panicnil=0/randautoseed=1/tlsmlkem=1), its
`containermaxprocs` "not yet in effect" caveat is honest (toolchain
still go1.24.0), ADR-009's datum:// status (parseable in poolproto,
rejected at config validation, engine returns unsupported-protocol)
matches its "planned" label, and ADR-006 already documents partial
supersession of ADR-002's V2-only decision.

## Session 412 — SECURITY.md phantom command + ADR audit [FIXED]

**Phantom command reference removed [FIXED].** SECURITY.md told v2
users "`otedama migrate-from-v2`コマンドが移行を支援します" — the
subcommand does not exist (never implemented; session 402 already
scrubbed it from skills/release-procedure.md — that fix is live in
open #513). Replaced with a pointer to `docs/MIGRATING-FROM-V2.md`,
which is the actual migration path. A security-policy document
pointing at a nonexistent command is the worst place for drift —
a v2 user with an active issue gets a flag-parse error instead of
guidance.

**Audited — clean:** ADR-006's transport/crypto abstraction text
matches the shipped code (V1 shipped first behind `poolproto`,
btccrypto scheme registry exists, JDP deferred as stated); ADR-011
secp256k1-for-Noise status is honestly marked; SECURITY.md's scope
section correctly notes `web/` and plugin system don't exist;
reporting paths (Private Vulnerability Reporting → MAINTAINERS.md
fallback) are real.

## Session 414 — competitive-analysis present-tense overclaims [FIXED]

**Present-tense claims corrected to roadmap scope [FIXED].**
`docs/competitive-analysis.md` described three features as shipped
design: (1) "プール自動選択（Stratum V2対応プール優先）" — the actual
default is a single constant `config.DefaultPoolURL`
(stratum+v2 Slushpool), not pool-list auto-selection; (2) "ZKP認証により…
数学的に証明" — ZKP auth does not exist (v4.0-scoped per CLAUDE.md; no ADR
covers it); (3) "LDKバインディングを使い Lightning Wallet
自動生成" — no LDK binding exists; the shipped wallet is BIP-39 local
store (AES-256-GCM + scrypt). Each is now qualified as implemented vs
proposed without rewriting the market analysis.

**Audited clean:** CATEGORY_AUDIT.md is a historical record (all rows
✅-resolved); ADR index status markers consistent with each ADR header
(ADR-002 "partially superseded" annotation correct); DEPLOYMENT.md
service-install flags (`--config`, `--data-dir`) and Docker/compose
`--http-addr` usage all real; i18n claims ~10 languages — actual
catalogue has ar/de/en/es/fi/fr/ja/ko/pt/ru/zh (claim accurate).

## Session 437 — ADR-011 依存先の上流進展: btcec/v2 が ellswift を同梱 [RESEARCH]

- **発見**: `github.com/btcsuite/btcd/btcec/v2@v2.5.0`（2026-05-15,
  Go 1.25, ISC）が `ellswift` パッケージを上流マージ済み
  （btcsuite/btcd commit d79d37d・BIP-324 公式テストベクタ付き）。
  エクスポート API は SV2 Noise NX に必要な全面をカバー:
  `EllswiftCreate`・`XSwiftEC`/`XElligatorSwift`/`XSwiftECInv`・
  `EllswiftECDHXOnly`・`V2Ecdh`（`bip324_ellswift_xonly_ecdh`
  タグ付きハッシュの x-only ECDH）。
- **意味**: ADR-011 の前回 erratum が記録した「Go の監査済み
  ellswift 実装が存在しない → 手移植必須（Option B と同等の DIY
  リスク）」が解消。Option A は `btcec/v2` 単一依存で curve +
  encoding + ECDH ヘルパまで完結する形に収束（btcec 自体が
  decred/dcrd 系譜のため審査根拠は同一・推移的に dcrec/v4 に依存
  するため追加面積も最小）。ADR-011 へ Erratum 2 を追記。
- **残件（不変）**: SV2 spec の "2-level PKI server authentication"
  のメッセージフロー実装 — ellswift は DH エンコードのみで、
  レスポンダ固定鍵認証は別件（CODEOWNERS・Noise 領域）。
- 併せて検証: closed PR #371 の responsivePool flag-race は master
  に吸収済み（atomic gate + started chan）、prose-collision flake は
  open #425 が担当済み — 再デリバリー不要。

## Session 463

Audited the stale "Highest-leverage next actions" tail list against
current master — items 3 (reject classification + metric) and 5
(submit-latency + pool-state gauges) have shipped since it was written,
item 2 (engine→poolproto wiring) is done for V1 only, items 1 (secp256k1,
v3.1.0 scope) and 4 (real Akash REST) remain open. Annotated each entry
with its current status instead of rewriting the dated list. hal GPU
sysfs enumeration audited clean (bounded reads, identity validation,
documented SHA256d:false caps).

## Session 465

Corrected a false portability claim in GODEBUG_NOTES.md: it said the
go/toolchain split "lets users with older toolchains still build" —
but `toolchain go1.24.0` makes GOTOOLCHAIN=auto switch to 1.24, and
under GOTOOLCHAIN=local the pinned `godebug tlsmlkem` fails to parse
on older toolchains (the exact "unknown godebug" error seen on CI's 1.23.x
legs). The note now states plainly that Go 1.24+ is required while
the `go 1.22` line only governs language defaults. Audited clean:
config.yaml.example covers every yaml field; docs/API.md's five
missing OTEDAMA_ env vars are open PR #517's territory (not
duplicated); ADR set has no other phantom references.

## Session 483 — skills/*.md の実在しない参照・虚偽 CI 記述を一括訂正

**Sweep.** `skills/` 配下の全 markdown を機械照合（コマンド・パス・ビルドタグの実在性、CI ワークフローとの機能一致）し、6件の stale 記述を発見・訂正。open #513 が担当した領域（phantom テスト対象・v4.0 スコープ記述）との重複なし。

**発見（全件訂正、検証済み）。**
- `skills/tdd.md` 3件: (a) ファズテスト「CI上で継続的に30秒から数分間実行」→ `.github/workflows/` に `fuzz` の参照ゼロ（test.yml は benchmark のみ）。`make fuzz` ローカル実行を正しく記述。(b) 統合テスト「`//go:build integration` タグで分離」→ 宣言ファイルゼロ。実際の区別は `testing.Short()` ゲート。(c) E2Eテスト「`//go:build e2e` タグ・`make test-e2e`」→ スイート未実装・ターゲット削除済み・タグ宣言なし。
- `skills/security-audit.md` 3件: (a) ファズ「CIで継続的に実行」→ 同上。(b) govulncheck「CIで毎回実行」→ CI 非存在（Makefile `security`/`audit` ローカルターゲットのみ — session 482 の ROADMAP 訂正と同じ虚偽クラス）。(c) 「Web管理インターフェース（`web/`配下）」→ CLAUDE.md のアーキテクチャマップで「存在しないパス（作成禁止）」と明示される phantom 参照。
- `skills/release-procedure.md` 2件: `otedama migrate-from-v2` phantom コマンド（#523 が SECURITY.md、#543 が Makefile で同クラスを修正した残件 — dispatch に存在せず）→ `docs/MIGRATING-FROM-V2.md` 手順に言い換え。「E2Eテストの全てが通過」→ スイート未実装と訂正。

**正しいと検証済みの記述（変更なし）。** CodeQL/Semgrep は security.yml に実在。カバレッジは test.yml が Codecov へアップロード（回帰警告は Codecov 側機能）。`make fuzz`/`make test-integration`/`make security`/`make audit` 全ターゲット実在。code-review.md・quality-pass-*.md・fuzz-runbook.md は s245/s253 訂正済み or スナップショット記録として正当。

**帰納。** 同じ虚偽クラス（「X は CI で実行される」→ CI 非存在）が ROADMAP・tdd.md・security-audit.md の3箇所に分布 — ドキュメント記述の CI 実態照合は継続監査が必要。

## Session 484 — BENCHMARKS.md の虚偽 CI 記述・phantom ベンチマークを訂正

**Sweep.** `BENCHMARKS.md` の全クレームを `.github/workflows/test.yml` と実在の `func Benchmark` 一覧と照合し、4件の虚偽/phantom 記述を発見・訂正。

**発見（全件訂正、検証済み）。**
- 「`go test -bench` is checked into CI. A PR that regresses performance by >5% fails automatically.」→ ci.yml の `benchmark` ジョブは `go test -bench` を実行し `benchmark.txt` を artifact `benchmark-results` としてアップロードするのみ。回帰検出・閾値・失敗ロジックは非実在。
- 「CI runs benchmarks on every push to main and posts a comparison to PRs.」→ push + PR で実行される点は正しいが、「posts a comparison」は非実在（比較ステップなし・PR コメントなし）。
- 「The decoder is fuzzed continuously in CI.」→ `.github/workflows/` に `fuzz` 参照ゼロ — session 483 の skills/ 訂正と同一の虚偽クラス（4箇所目の発生）。
- 「`go test -bench=BenchmarkDecoder_ReadFrame`」→ その関数は非実在（phantom 再現コマンド）。フレームデコード throughput 表（~50M frames/s 等）は本書独自の「再現可能であること」ルールを満たせない未検証推定値と明示。
- 補足: 公表数値の計測環境（Go 1.22）は現 master の最低要件（Go ≥1.24、`godebug tlsmlkem`）を満たさないため注意書きを追加。

**正しいと検証済みの記述（変更なし）。** `BenchmarkHashHeader`・`BenchmarkWorkerGrind_SingleThread`・`BenchmarkWriteText` 等の実在・reproduce コマンドの形式妥当性、benchmark ジョブが push+PR で起動すること、SHA-NI/ARM SHA ext が stdlib crypto/sha256 で自動使用されること。

**帰納。** 「CIで実行される」系の虚偽記述は本ラウンドで ROADMAP（#564）→ skills（#565）→ BENCHMARKS と4ドキュメント目 — CI ワークフローの記述照合は引き続き監査対象。

## Session 485 — docs/DEPLOYMENT.md の phantom 指示・虚偽チェック項目を訂正

**Sweep.** `docs/DEPLOYMENT.md`（416行、初監査）の全コマンド・パス・サービス属性を `internal/daemon/service.go`・`Dockerfile`・`internal/metrics`・`.github/` と照合。

**発見（4件訂正）。**
- Windows ログ参照手順 `Get-EventLog -LogName Application -Source Otedama -Newest 50` → phantom: Otedama はイベントソースを登録しないため「Cannot find source」で失敗。加えて SCM 起動サービスの stdout は破棄（`serviceArgv` が `--log-file` を通さない）— Windows サービスの永続ログは存在しないことを明示し、`otedama run --log-file` を案内。
- 「A reference Grafana dashboard lives at `contrib/grafana/otedama-dashboard.json`」→ `contrib/` 非実在。「(TODO for v3.1.0)」併記だが「lives at」の存在断言と矛盾 — v3.1.0 計画に訂正。
- ハードニングチェック「Binary cosign signature verified」→ 今日の release.yml は署名・チェックサム・SBOM を一切生成しない（#562 記録済み）ため未達成不可能な項目 — 訂正。
- 「Automatic updates via Dependabot for the Otedama container image tag」→ dependabot `docker` エコシステム（dependabot.yml:52）は Dockerfile のベースイメージ pin 更新のみで、運用中のデプロイ済みタグは更新しない — 訂正。

**正しいと検証済みの記述（変更なし）。** `service install` の `--config`/`--data-dir` フラグ実在、systemd unit の hardening 項目（NoNewPrivileges/ProtectHome=read-only/PrivateTmp/Restart=on-failure/RestartSec=10s）・`~/.config/systemd/user/` パス・launchd `~/Library/LaunchAgents/com.otedama.daemon.plist`+KeepAlive+即時 load・Windows `DisplayName=Otedama Mining Service`+`start=auto`（+install 時 start 追加は #552）・全6メトリクス名（SPECIFICATION §6 と一致）・`--log-format=json`・ENTRYPOINT `/usr/local/bin/otedama`（healthcheck パス整合）・NOTICE の依存列挙（go.mod と完全一致）・dependabot docker エコシステム存在。

## Session 486 — docs/SPECIFICATION.md §2/§7 の stale 記述を訂正

**Sweep.** `docs/SPECIFICATION.md`（252行）の非メトリクス節を `internal/config/config.go`・`internal/daemon/service.go`・`internal/engine/run.go`・`.github/ISSUE_TEMPLATE/` と照合。

**発見（2箇所訂正 + 帳簿1行）。**
- §2 サービス行「systemd/launchd/Task Scheduler」→ Windows 経路は Task Scheduler（`schtasks.exe`）ではなく SCM の `sc.exe create` — 実装と不一致。同じ phantom が RESEARCH_IMPROVEMENTS Category 7 行2にも存在し訂正。
- §7 (3)「engine does not yet route through the `poolproto` abstraction」→ stale: V1 セッションは session 91 から `poolproto.DialURL`+Session 経由（KNOWN_LIMITATIONS §3 自体が RESOLVED と宣言）— 実際の残ギャップは V2 native 経路のみ（run.go:609 が「V2 poolproto dialer completes Step 3b」を明示）。

**正しいと検証済みの記述（変更なし）。** §2 コマンド表の全動詞・`--json`・exit-code 契約（0/1/64/78）、§3.1 スキーマ表の全フィールド（config 構造体と完全一致）、§3.2 優先順位・数値 env の malformed 報告、§4 ライフサイクル（share target 採用・failover 分離・backoff）、§5 フレームフォーマット・MaxFrameSize 事前検査・P-256 注記、§6 メトリクスカタログ（CI 整合ガード済み）、ISSUE_TEMPLATE（doctor 出力フォーマット `[✓]` 一致・必須項目妥当）。

## Session 487 — docs/architecture.md の免責ブロックに残存乖離2件を追記

**Sweep.** `docs/architecture.md`（112行）全文精読。session 243 の免責ブロックが主要乖離（provider 単数形・2系統収益・HAL ドライバ・lightning・observability・API層）を網羅済みだが、2件の未免責の虚偽主張を発見・免責へ追記。

**発見（日英両免責に追記）。**
- `internal/plugin/`・`pkg/plugin/`・`internal/api/`・`internal/auth/` の非実在が未免責 — プラグイン基盤・gRPC/REST API・ZKP 認証は全て未実装で、`internal/auth/` は CLAUDE.md 禁止パス（v4.0 スコープ）。
- 「SRI（Stratum Reference Implementation）のGoバインディングを統合利用」（§44）および「自前実装ではなくSRIを選択」（§100）の理由付けは**実態と逆** — SRI（`stratum-mining/stratum`）は Rust 実装で Go バインディングは存在せず、`internal/stratum` は本プロジェクトの自前フレーム/コーデック/Noise 実装。LDK についても lightningdevkit のメンテ済み言語バインディング（Swift/Kotlin/Java/TypeScript 等）に Go は含まれない。

**検証済み・変更なし（免責が既にカバー）。** providers 複数形、収益源4系統の内2系統未実装、asic/cuda/rocm ドライバ非実在、LDK 統合・チャネル管理・自動決済・LSP 未実装、observability パッケージ非実在、API 層非実在 — 全て session 243 免責済み。

## Session 488 — docs/solo-operations.md の現在形虚偽記述3件を訂正

**Sweep.** `docs/solo-operations.md`（690行）全文精読。設計マニュアルとして将来形の推奨事項は正当だが、現在形の「設定済み/実施済み」クレームを `.github/workflows/`・`Makefile`・`.goreleaser.yaml` と照合。

**発見（3件訂正、#561 が直した SHA-pinning 虚偽と同クラス）。**
- Scorecard リスト「Signed-Releases（cosign設定済み → 自動高スコア）」→ 虚偽: `.goreleaser.yaml` の cosign 設定は残るが `release.yml` が goreleaser を一切呼ばない dead code（session 480 で検証済み）— 署名リリース非存在で Scorecard 低スコアのまま。
- Scorecard リスト「Fuzzing（go test -fuzz → CIで継続実行 → 設定済み）」→ 虚偽: `.github/workflows/` にファズ参照ゼロ、`make fuzz` はローカルのみ（session 483-485 で横断検証済み、6文書目の同クラス）。
- リスク1 対策「`govulncheck` は週次で自動実行済み」→ 虚偽: 全ワークフローに govulncheck/osv-scanner 参照ゼロ — Makefile ローカルターゲットのみ。Lightning ゼロデイ対策として列挙した根拠が未実装。

**検証済み・変更なし。** 第1層〜第7層の推奨設計（SHA pinning 原則・Renovatebot 設定例・Private Vulnerability Reporting・DCO・CODEOWNERS サンプル・週10時間上限）は全て将来形の設計提案として正しく記述されており実装要求ではない。Dependabot 設定済み・Branch-Protection「設定必要」表記は正直。CodeQL/Semgrep の security.yml 存在も確認。

## Session 489 — docs/AUDIT_CHECKLIST.md の監査人向け虚偽記述を訂正

**Sweep.** `docs/AUDIT_CHECKLIST.md`（148行）全文精読 — 第三者監査人が「各行を検証せよ」と設計した文書ゆえに誤誘導の影響が大きい。全行を ci.yml/security.yml/.golangci.yml/go.mod/実装と照合。併せて `docs/API.md` 残節（HTTP エンドポイント・メトリクスカタログ・ウォレット形式・終了挙動・API 安定性）を照合 — 全 clean（env 変数表の欠落は open #517 の担当域）。

**発見（4箇所訂正）。**
- 行1「Go 1.22+ でビルド可」→ 虚偽: go.mod は実質 Go ≥1.24 必須（`godebug tlsmlkem` が旧ツールチェーンでパースエラー = CI の 1.22/1.23 マトリクス失敗の正体）。session 465 の GODEBUG_NOTES 訂正と同根拠。
- 行11「GitHub Actions は SHA ピン留め」→ 虚偽: 全 `uses:` がタグ/ブランチ参照。行を「現状 fails・目標状態」と明記（#561 が solo-operations で直した虚偽と同クラス）。
- 行13「リリース成果物は cosign 署名済み」→ 虚偽: `release.yml` は goreleaser/cosign を一切呼ばず `.goreleaser.yaml` の `signs:` は dead config（session 480 検証済み）。
- 「CI gate summary」節を実態に書換: 独立 `go vet`/`staticcheck`/`govulncheck`/5-OS `go build` 行列は非存在（govet+staticcheck は `.golangci.yml` 経由で golangci-lint 内実行のみ）。実際のゲート: golangci-lint・gosec・gofmt・go mod tidy・test -race（Windows 除く）。「Nightly 30分ファズ + PR ベンチマーク比較(5%)」→ 両ジョブ非存在（ファズ関数名 FuzzDecodeHeader/FuzzDecoder_ReadFrame は実在するが `make fuzz` ローカルのみ、ベンチは artifact アップロードのみ — session 484 検証済み）。

**検証済み・変更なし。** 行2-10/14-30 の残クレーム（vet/staticcheck クリーン・SPDX・go mod verify・Dependabot・wallet 0600・AES-256-GCM・Noise NX・ChaCha20-Poly1305・ADR/COC/SECURITY.md 存在）は実装と一致。行22 の scrypt 行（N=32768 記載・実際は N=2^17=131072・seedstore.go 所在）は虚偽だが closed #485 の担当域のため未修正として記録のみ。検証スクリプトは `|| true` で tolerant 設計、妥当。

## Session 490 — docs/SUSTAINABILITY.md の実装状況欄3件を訂正

**Sweep.** `docs/SUSTAINABILITY.md`（193行）全文精読 — 10年戦略書の「実装状況」欄を go.mod・`.goreleaser.yaml`・`internal/poolproto/`・`.github/workflows/`・ルートファイル群と照合。

**発見（3件訂正、全て「実装済み」の過剰/陳腐申告）。**
- §2「`internal/poolproto/poolproto.go` 作成済み（インターフェース層のみ）。SV1/SV2 implementation は v3.2.0 スコープ」→ 陳腐: `stratumv1/`・`stratumv2/` 両 dialer が実在し V1 セッションは engine で稼働中（session 482 の ROADMAP 訂正と同ドリフト）。
- §5「SHA pinning + Dependabot + cosign signing は v3.0.0-alpha で実装済み」→ 虚偽: Dependabot のみ実装済み。全 `uses:` はタグ/ブランチ参照で SHA pin ゼロ、`release.yml` は goreleaser/cosign 未呼出で `signs:` は dead config（session 479-480,488-489 と同クラス）。
- §10「SECURITY.md と LEGAL.md は v3.1.0 スコープ」→ 半陳腐: SECURITY.md は作成済み（残る v3.1.0 項目は LEGAL.md のみ）。

**検証済み・変更なし。** §1 godebug 3 knob・go.mod/toolchain 記述、§3 subsidy 式・witness dispatch、§4 btccrypto 抽象化済み、§6 MAINTAINERS/GOVERNANCE/Dependabot 存在、§7 metrics+http-addr 実装済み、§8 goreleaser matrix、§9 ファズ2件実在（FuzzDecodeHeader/FuzzDecoder_ReadFrame）、§10 Apache+DCO+AI clause 実在 — 全て一致。「CI で 60秒 fuzz」等は実装状況でなく判断（将来計画）欄のため保留。

## Session 491 — docs/KNOWN_LIMITATIONS.md 再検証 clean + docs/TROUBLESHOOTING.md の phantom 2件を訂正

**Sweep.** `docs/KNOWN_LIMITATIONS.md`（746行・帳簿本体）の未解決項目を全数再照合 + `docs/TROUBLESHOOTING.md`（228行）の非フラグ節を初全文精読。

**発見（2件訂正、#558 が直した `--worker-threads` と同 phantom クラスの残件）。**
- 「`service` オプションは Otedama を idle scheduling class に自動バインド」→ **phantom**: `internal/daemon/` 全実装を grep しても CPUSchedulingPolicy/IOSchedulingClass/Nice/Priority 等の設定は皆無 — systemd unit は NoNewPrivileges/ProtectHome/PrivateTmp/Restart のみ、launchd plist もスケジューリング未設定。
- 「`otedama --log-level=debug doctor`」→ **実行不能**: dispatch は `args[0]` でサブコマンド判定するため `--log-level=debug` は `unknown subcommand`（exit 64）に落ち、さらに `doctor` の FlagSet は `--log-level` を定義していない（`run`・`service install` のみ）。

**検証済み・変更なし。** KNOWN_LIMITATIONS の全未解決項目: §2（Noise 未配線・P-256・mixKey 破棄 — run.go:645 の警告と一致）、§4 GPU Linux-only、§5 PQ scaffold、§6 Lightning receive-only、§8 ASIC 未検出、§13 CI 6ワークフロー欠陥、§14 DATUM reserved、§15 TUI 固定80列、§16 wallet サブコマンド非実装 — 全て現状正確。TROUBLESHOOTING のバックオフ記述（1s→64s）は reconnectBackoffInitial/Max と一致、CPU 飽和対策・linger・LaunchAgent 説明も正しい。`--worker-threads` 行は open #558 の担当域のため未修正。

## Session 492 — GOVERNANCE.md の誤記2件を訂正 + CODE_OF_CONDUCT・パス参照棚卸し clean

**Sweep.** `GOVERNANCE.md`（159行）・`CODE_OF_CONDUCT.md`（117行）全文精読 + 全 markdown（433件のバッククォートパス参照）の非実在ファイル棚卸し。

**発見（2件訂正）。**
- 「Auto-mergeable if **Renovate** patch update」→ 実際の設定済み bot は Dependabot（`.github/dependabot.yml` — renovate 設定は一切非実在、サーバーサイド automerge は GH-actions bump 用に設定済み）。
- Phase-1 の bus-factor 緩和に「**Sigstore 鍵なし署名**（長命シークレットなし）」→ session 480 検証済みの通り `.goreleaser.yaml` の cosign `signs:` は dead config（release.yml が goreleaser を一切呼ばない）— 署名される成果物は存在せず、緩和は succession plan のみ。

**検証済み・変更なし。** CODE_OF_CONDUCT は標準 Contributor Covenant 2.1＋正しい Security Advisories 報告 URL で clean。CODEOWNERS（lightning/noise* カバー）・MAINTAINERS.md の succession plan・ADR append-only 方針は実体と一致。パス参照棚卸し: `config.yaml`/`test.yml` 言及は全て正当（非実在を論じる文脈 or 実在）— 新規 phantom パス参照なし。

## Session 493 — README.md の phantom/陳腐クレーム4件を訂正

**Sweep.** `README.md`（157行・バッジ〜フッター全節）を実コード・リモートブランチ・release.yml と照合。

**発見（4件訂正）。**
- **「`releases/latest/download/install.sh` でインストール」→ 404**: `release.yml` がアップロードするのは `otedama-<os>-<arch>.tar.gz` のみで install.sh はリリース資産として存在しない → `raw.githubusercontent.com` の実 URL に訂正。
- **「v2.1.9 は `legacy-v2` ブランチに保全済み・2026-10 まで修正提供」→ phantom ブランチ**: `git ls-remote` で同ブランチ非実在 → 「保全が計画」に訂正（CLAUDE.md アーキテクチャマップ内の同趣旨記述も phantom — メンテナ自身のファイルのため帳簿記録のみ）。
- **「Windows: Task Scheduler」×2箇所** → 実装は `sc.exe` SCM 登録（#568 が SPECIFICATION.md で直した phantom の README 残件）。
- **バッジ「Go 1.22+」・要件「Go 1.22以上」** → `toolchain go1.24.0` + `godebug tlsmlkem` で実効 ≥1.24（#571 が AUDIT_CHECKLIST で直した同クレームの README 残件）。

**検証済み・変更なし。** 機能一覧の「未実装」正直列挙（署名バイナリ・ASIC・ZKP等）・コマンド表（`completion` 行欠落は open #557 担当域）・market claims・i18n 部分は正確。

## Session 494 — docs/API.md 前半（1–206行）照合、未記載フラグ2件を追記

**Sweep.** `docs/API.md` の CLI 節（`run` フラグ表・exit codes・`version`/`config`/`service`/`doctor` シグネチャ）を `cmd/otedama` の実 FlagSet と機械照合。

**発見（2件追記）。**
- **`run` フラグ表に `--pprof` が欠落**: run.go:84 で実在（`/debug/pprof/` マウント・loopback/private 推奨）— API.md には未記載。「non-loopback で警告」の記述は未作成（open #453 の未マージ面のため）。
- **`service install` のフラグ記述が不完全**: `--config`/`--data-dir` のみ記載だが実 FlagSet は `--bitcoin-address`（config 無し時必須）・`--log-level`・`--log-format`・`--language` も受理。また Windows サービスを「Windows service」とのみ記載 — `sc.exe` SCM に明記（README と同じ訂正）。

**検証済み・変更なし。** `run` の他11フラグ・exit codes（0/1/64/78）・`version --json` フィールド・`config show --origin/--json`・`doctor` フラグ+exit 0/1/2+JSON シェイプ（duration_ms/exit_code/elapsed_ms）・YAML KnownFields 振る舞い・設定優先度・env var 表 — 全て正確（env 欠落5件は open #517 担当域）。

## Session 495 — .github/oss-fuzz-integration.md の陳腐化2件 + CONTRIBUTING.md Go 要件を訂正

**Sweep.** `.github/oss-fuzz-integration.md`（未提出の統合文書）の全クレームを上流ソースと照合 + `CONTRIBUTING.md`（166行）精読。

**発見（3件訂正）。**
- **「Bug bounties (~$500–$5000 per accepted vulnerability)」→ 陳腐化**: OSS-Fuzz reward program は sunset（google/oss-fuzz#15478 で確認）。24/7 ファズ・issue filing・coverage reports は無料継続 — bounty 行を取消線＋訂正。
- **準備済み `build.sh` が obsolete interface**: `go-118-fuzz-build -o x.a -func F pkg` + 手動 `$CXX $LIB_FUZZING_ENGINE` リンクは旧式 — 現行 OSS-Fuzz Go ガイドの `compile_native_go_fuzzer <pkg> <func> <name>` ヘルパーに置換（base-builder-go 同梱・go-118-fuzz-build を内部駆動）。
- **CONTRIBUTING.md「Go 1.22以上」** → 実効 ≥1.24（README/AUDIT_CHECKLIST に続く同クレーム5箇所目）。

**検証済み・変更なし。** Fuzz* 関数2件の記述（FuzzDecodeHeader/FuzzDecoder_ReadFrame）・提出手順・メンテナ工数見積・`primary_contact` は提出時差し替えのテンプレートとして妥当。CONTRIBUTING の make ターゲット・DCO・二重レビュー方針（Phase-1 単独メンテ下での意図的ポリシー）・Braiins/DEMAND 手検証クレームは正確。

## Session 496 — MAINTAINERS.md の虚偽引用訂正 + Dockerfile/.dockerignore 監査

**Sweep.** `MAINTAINERS.md`（192行）全文精読 + `Dockerfile`（70行）を ci.yml の docker-verify クレーム・API.md・内部実装と照合。

**発見（1件訂正 — 外部引用の捏造系）。**
- 冒頭の動機付け「Kubernetes Ingress NGINX, **External Secrets Operator** have been declared end-of-life in 2025–2026」→ Ingress NGINX の 2026 EOL 宣言は実在だが **ESO は活発に開発中**（external-secrets.io のサポート表: 2026-08 時点で v2.10 までリリース）— 虚偽引用を訂正（CLAUDE.md「存在しない URL・API の生成禁止」と同クラスの事実捏造）。
- MAINTAINERS の cosign「default path」記述（line ~101, 148）は未修正のまま残存 — **closed #562 の担当域**（同 PR で訂正済みだったが未マージで閉鎖）のため再提出せず帳簿記録のみ。

**検証済み・変更なし。** Dockerfile: `golang:1.24-alpine`（実効要件と一致）・ldflags が正しい `internal/version.{Version,Commit,BuildDate}` シンボル（release.yml の間違った `main.*` と対照的）・NOTICE+LICENSE 同梱・nonroot uid 65532・`VOLUME /var/lib/otedama`・`EXPOSE 0`・`CMD ["run","--help"]` — 全て正確（ci.yml docker-verify の失敗は §13 記録済みのジョブ側欠陥で Dockerfile 側の問題ではない）。`.dockerignore` 非実在（COPY . . が .git 等を context に含めるが動作上無害 — open #530 担当域）。

## Session 497 — ADR-009 にエラッタ2件（残 Proposed ADR 007–010 の現在形検証）

**Sweep.** Accepted ADR（001–006, 011）は session 473 で全照合済みのため、残る Proposed ADR 007–010 の「今日の実装」現在形クレームを検証（Proposed 自体は未来設計で正当 — 陳腐な現在形のみ対象）。

**発見（2件、ADR-009 にエラッタ追加）。**
- **「Otedama's positioning today: hard-coded as a Stratum V2 client only (ADR-002)」→ 陳腐**: `internal/poolproto/stratumv1` + `DialURL` が alpha.1 から稼働 — ADR-002 エラッタ（session 472）と同クラスの決定記録 vs 実装乖離。V2-preference に訂正。
- **「`internal/stratum/noise*.go` を Noise NX に再利用（already production-ready since alpha.1）」→ 虚偽**: KNOWN_LIMITATIONS §2 が証明する通り未配線・P-256（spec 必須は secp256k1+ElligatorSwift）・`mixKey` の HKDF 出力破棄・responder 認証なし。「production-ready」は帳簿と直接矛盾 — 再利用はギャップ継承＋コスト見積に Noise 手直し or ADR-011 依存を明記。

**検証済み・変更なし。** ADR-007（passive receive endpoint・BOLT12 未署名）・ADR-008（orchestration gap 主張）・ADR-010（renumbering note）は現在形も正確。

## Session 499 — go.mod 依存選定理由コメント（CLAUDE.md ルール遵守）+ skills/docs 最終棚卸し

**Sweep.** `docs/` 全ファイルの精読が本ラウンドで完結（adr/README 索引は11件・status 一致で clean）。残軸として (a) TODO/FIXME/XXX/HACK マーカー掃討 → **実コード 0件**（clean）、(b) skills/ 未精読3ファイル（code-review・quality-pass×2）→ 過去セッション記録で status は依然正確、(c) CLAUDE.md「go.mod コメントに追加理由と選定基準」遵守状況。

**発見（1件対応）。**
- **`go.mod` に依存根拠コメントが皆無** → CLAUDE.md 外部依存管理ルール違反状態を修正: `x/crypto`（scrypt — ウォレット KDF、BSD-3-Clause、ADR-003 予算内）と `gopkg.in/yaml.v3`（YAML デコーダ、MIT/Apache、上流 archived → go.yaml.in 移行は別途追跡中 ※open #444）に記録。`x/crypto` の実使用箇所は scrypt 単一と確認、`go mod verify` 緑。

## Session 500 — DEPLOYMENT.md: 実害2件（ジェネシスアドレス例・healthcheck 終了コード）+ i18n 未翻訳混入なし

**Sweep.** (a) i18n カタログ10言語の未翻訳混入 → 全言語適切に翻訳済み（ru/ar/fr/de/pt 確認）で clean。(b) `.github/` 非ワークフロー: dependabot.yml の dead `automerge` キーは open #524 の担当域で重複せず。(c) doctor チェック数 = 17 件で CLAUDE.md と一致。(d) BIP-39 wordlist は init 時 SHA-256 検証済みの堅牢設計。(e) DEPLOYMENT.md の YAML 5ブロックをパース＋照合。

**発見（2件訂正 — 後者は注意喚起）。**
- **デプロイ例がジェネシスブロックの coinbase アドレスを実例として使用**（docker run・compose env・k8s Secret stringData の3箇所、計3回）→ 有効な bech32 でバリデーション通過＝コピー運用で報酬が使用不能アドレスへ送金される実害。失敗する `<your-bitcoin-address>` プレースホルダに置換（静かに動く最悪パターン → 叫んで止まる安全パターン）。
- **compose healthcheck `otedama doctor` が Warn で exit 1** → 単一 pool 構成（「Pool diversity」が Warn する典型構成）でコンテナが unhealthy 扱い — distroless にはシェルがなく exit-2 ゲートに書き換えられないため、warn-as-degraded 意図の確認コメントを付記。

**検証済み・変更なし。** Dockerfile `/usr/local/bin/otedama` パス一致・k8s マニフェストの liveness/readiness（/healthz・/readyz）は httpserver 実装と一致・ServiceMonitor の port 名は Deployment の port と一致・Secret の `stringData` 用法正しい。

## Session 502 — 監査検証ラウンド（godoc 適合・panic サイト・全テスト実行 — 全件 clean）

**Sweep.** (a) CLAUDE.md「主要型・公開関数に godoc 必須」の機械検査: exported func/type の doc コメント有無を全 internal/ で走査。(b) `panic(` サイトの正当性。(c) `go test ./...` 全実行。(d) LICENSE/NOTICE/CODEOWNERS/.editorconfig/CHANGELOG↔VERSION 整合。

**発見なし（全件 clean）。**
- godoc 欠落ヒット20件は全て正当: `Identity()`/`Capabilities()`/`Read()`/`Error()`/`Close()` 等の **interface 充足メソッド**（hal.Device・provider・io.Reader・error）で、interface 側に文書があるためメソッド毎の godoc は不要 — Go 慣行適合。
- panic 11箇所は全て正当: `init()` の BIP-39 SHA 検証・registry 二重登録・worker 多重 Start のような programmer-error ガード — ライブラリ境界を越える panic なし。
- `go test ./...` **24パッケージ全緑**（master 現状、18.3s engine 含む）。
- CHANGELOG セクション構成（Unreleased → 3.0.0-alpha.1 → 2.1.9）と VERSION 一致、LICENSE 著作権行記入済み、CODEOWNERS noise* パターン実解決。

本ラウンドは検証のみ（コード・ドキュメント変更なし）。

## Session 503 — エコシステム再照合: NexusPool の JDP 本番稼働（新事実）

**Sweep.** GitHub/海外技術情報の最新差分: SRI は 1.12.0（9/17、session 478 追跡済み）が最新で新リリースなし。Go は 1.26 系パッチ進行中でブートストラップ要件等の新規影響なし。**新事実: NexusPool が 2026-08-24 から native SV2 Job Declaration を本番稼働** — Braiins・DMND に続く3例目（5月ワーキンググループ発表後の初の実稼働追加）。

**対応（1件 — ADR-009 エビデンス更新）。**
- ADR-009 の「production-viable」エビデンスに NexusPool を追記。特に価値があるのは同社ポストモーテムの教訓: **単体テストが通っても SRI 参照 JDC との実接続テストでしか見つからなかった欠陥が4件**（allocation メッセージの field-count 不一致・未配線 payout フィールド・JD 専用接続を殺す reaper）— これは ADR-009 のコスト見積が unit test だけでなく reference-implementation interop テスト工数を含むべき根拠として記録。

## Session 504 — エコシステム再照合: BIP-110 と拡大した本番プールセット（2件）

**Sweep.** Reddit/海外技術情報・公式エコシステム表の差分。

**対応（2件 — ADR-009 エビデンス更新）。**
1. **本番セットの拡充**: stratumprotocol.org 公式表で production プールが Blitzpool/MKPool/NexusPool/Public Pool/PyBlock（solo）+ Braiins/DMND（DMND は miner-selected templates）に拡大、Auradine FluxOS・Bitaxe・BraiinsOS の SV2 ネイティブファームウェアも稼働。
2. **BIP-110 = 初のライブ template-signaling 展開**: Reduced Data Temporary Softfork が Knots ベース activation client で listening node の ~10% に到達。OCEAN は BIP110/非シグナルの2専用 endpoint を追加し split 時は「2つのプール」として運用すると発表（7月）。テンプレート所有が**どの consensus chain に着陸するか**を左右する初の実例 — ADR-009 の solo/JDP 提案が「プールではなく自ノードの consensus rule で検証」を要する根拠として記録。

## Session 505 — DEPLOYMENT.md の K8s 例に未解決参照2件（マニフェスト追記）

**Sweep.** リポジトリメタ整合（gitignore 追跡逸脱・dependabot エコシステム・compose 参照）＋ DEPLOYMENT.md の埋め込み YAML を構造検証。

**発見（2件 — 修正）。**
1. **`otedama-data` PVC 未定義**: Deployment が `persistentVolumeClaim.claimName` を参照するがドキュメントに PVC マニフェストが存在せず、コピー運用で pod が mount 失敗。PVC を追記。
2. **ServiceMonitor がセレクトする Service が非存在**: `app: otedama` を select する ServiceMonitor はあるが Service がなくスクレイプ対象ゼロ — ServiceMonitor は pod ではなく Service をセレクトするため必須。Service を追記（port 名 `metrics` を ServiceMonitor の `endpoints[].port` と一致、targetPort は pod の `metrics` ポートを指す）。

**検証 clean**: gitignore 追跡逸脱ファイル 0件、dependabot エコシステム3種（gomod/github-actions/docker）整合、全埋め込み YAML 構造 parse 通過、Deployment の probe/securityContext/label 整合。

## Session 506 — competitive-analysis.md の外部事実検証（2件訂正・引用確認済み）

**Sweep.** docs/adr/README 索引（11 ADR・status 一致で clean）・gitignore 追跡逸脱（0件）・dependabot・.claude 再出現（#563 の担当域）を棚卸し後、competitive-analysis の外部事実クレームを一次ソース照合。

**対応（2件 — 訂正）。**
1. **「Bitcoin Core v30 が Stratum V2 を公式サポート」は過大記述**: v30 の release notes（bitcoincore.org）によれば出荷は **experimental IPC Mining Interface**（`bitcoin -m node -ipcbind=unix`、IPC でテンプレート要求・ブロック提出を受ける Unix socket）で、ノード自体は SV2 を話さない — 「公式サポート」を訂正し、Go 製 TP の直接バインド経路である点を併記。
2. **計画 vs 出荷分岐の Note**: 実装順序節が「LDK バインディング」「x/text 基盤」を記述するが、出荷は stdlib ウォレット（ADR-001）・独自 i18n カタログ（ADR-003）で分岐 — 起案時計画である旨の Note を追加。

**検証 clean（引用確認）**: CVE-2014-4501 は実在（client.reconnect のスタックオーバーフロー、sgminer/cgminer/BFGMiner — NVD/fulldisclosure 確認）。NiceHash 4700 BTC・ADR 索引・dependabot エコシステム整合。

## Session 507 — skills/code-review.md の stale 参照2件（訂正）

**Sweep.** パッケージ doc コメント網羅・main.go usage/exit-code 表と実 dispatch 照合の後、最後の未精読 skill ファイル code-review.md を精読。

**対応（2件 — 訂正）。**
1. **`pkg/` 参照**: ドキュメントチェックが「公開API（`pkg/`配下）」を挙げるが `pkg/` はアーキテクチャマップの作成禁止パスで存在し得ない — export された型・関数に言い換え（session 253 が直したパス phantom の残件）。
2. **BOLT/LDK 観点**: Lightning レビューが「BOLT 仕様準拠・LDK バージョンアップ」を挙げるが LDK は非採用（出荷は BIP-39/scrypt/AES-256-GCM ウォレット）— 現行範囲に訂正し BOLT/LDK は ADR-007 着工まで適用外と明記（session 506 の competitive-analysis と同 drift クラス）。

**検証 clean**: 全 internal/ パッケージに `// Package` doc（`package main` は `// Command` 規約適合）、main.go の usage 例と exit-code 表（0/1/64/78・doctor 0/1/2）が実 FlagSet・dispatch・doctor.go と一致。

## Session 508 — quality-pass 指示書の実測値更新（3件）＋ ellswift 出荷状況再検証

**Sweep.** docs/skills/コメント内全 URL 抽出 → 実在性棚卸し（otedama.io は除去済み記録のみ残存・issues#2/#3 実在・badge は #575 担当域）の後、未精読だった `skills/quality-pass-{sonnet,opus}.md` を精読。

**対応（3件 — 実測値更新）。**
1. カバレッジ「lightning 91.2%」→ **実測 92.0%**（`go test -cover` で7パッケージ検証、全域 ≥90%: engine 93.8・config 94.7・miner 96.2・doctor 96.6・stratum 97.9・arbitration 100）— 両ファイル更新。
2. opus の CI ピン「Go 1.23.x/1.21」→ ci.yml 実マトリクスは **1.22.x/1.23.x**（env GO_VERSION 1.23.x）。
3. opus の「コードは1.24.7でgreen」→ go1.26.8 で全テスト green を実測し更新。

**検証 clean**: ellswift 出荷状況 — decred secp256k1/v4・btcec/v2 共に release 版に ellswift 未含有（btcsuite/btcd#2219 は 2025-06 に closed-unmerged、v2_transport フォークのみ）→ opus の「監査済み Go 実装非存在」主張は依然正確。URL 棚卸しで otedama.io の live 参照なし。

## Session 511 — internal/engine fully read; first production JDP block

**Audit milestone.** This session completes the end-to-end read of every
non-test file in `internal/engine` (run.go 1434 lines, arbitrate.go,
metrics.go, stats.go, setup.go, fanin.go), closing the shared-state sweep
started in session 509. Verdicts: `miner.Worker`'s SetWork↔grind path is
race-free by design (mutex + workVer generation counter — grinding
threads copy job pointer + version under lock and detect changes between
nonce batches); `LatencyTracker` is mutex-guarded for concurrent
record/quantile; `HashrateMonitor` and the session-loop maps (jobs,
submitTimes, prevHash/active state) are correctly loop-local; `fanIn`
drains ctx-awarely; `arbitration.Decide` emits an assignment for every
input device, so the session-510 paused set is fully refreshed each
cycle — no stale marks can outlive their device. The only findings in the
package were the two already shipped: `rejectByReason` map race (session
509, PR #591) and the arbitration-pause flap (session 510, PR #592).

**Ecosystem — ADR-009 update.** DMND mined mainnet block 955,318 for
GoMining on June 25–26, 2026 — the first known production block built
via Stratum V2 Job Declaration with a *miner-declared* template (the
template carried GoMining's own GoBTC Pay transactions). Verified against
DMND's announcement and Bitcoin Magazine. JDP is now production-proven
end-to-end; recorded in ADR-009's new Ecosystem-update section.

**ESP-Miner watch.** v2.15.2 (9/18) added BM1372/BM1373 ASIC support;
v2.15.3 (9/20) derives low-frequency warnings from device presets. No
actionable delta for Otedama's HAL (sysfs driver only, no ASIC bus code)
— recorded for the drift log.

## Session 513 — arbitration + logger + version fully read; core audit complete

**Audit milestones.** With this session's reads of `internal/arbitration`
(engine.go, 503 lines), `internal/logger`, and `internal/version`, every
non-test file in the core path (engine, miner, hal, arbitration, logger,
version) has now been read end-to-end across sessions 509–513.

**arbitration verdicts.** `Decide` rejects invalid Policy, negative
HysteresisMargin/MinYieldSatsPerSec, and duplicate device IDs up front;
device order is sorted so identical inputs produce byte-identical
allocations (the determinism contract tests and log-diffing rely on).
`chooseForDevice` correctly computes `maxRaw` before the policy sort
(ForegoneSatsPerSec measures raw yield, not policy score), compares
hysteresis in the *policy-adjusted* score space so a worse-privacy
higher-yield stream can't force a switch under MaximizePrivacy, and
emits an assignment for every device. The only residual inputs are
non-finite values (NaN hysteresis/floor/yield) — that class is owned by
open PRs #437 (collapse non-finite yields) and #443 (reject non-finite
margin/floor); no re-delivery here.

**logger verdicts.** Default-logger singleton is a `sync/atomic.Pointer`
with a CAS cold path (CAS-loser branch is unit-testable); `IntoContext`
and `SetDefault` both no-op on nil so a typed-nil can never shadow the
default; `Discard` uses a level above LevelError rather than a discarded
writer alone. Clean.

**version verdicts.** ldflags-injected vars + Info snapshot + stable
`String()` format — clean. (The release.yml `-X main.Version` wrong-
symbol defect is already recorded in docs/KNOWN_LIMITATIONS via #562 —
different layer, not this file.)

## Session 514 — provider + daemon fully read; toolchain pin verified current

**Audit milestones.** `internal/provider` (all 4 files — provider.go,
polling.go, mining.go, ai_inference.go) and `internal/daemon`
(service.go, 463 lines) read end-to-end.

**provider verdicts.** `pollingProvider` guards double-start under mutex
and runs `prepare` inside the lock, so a rejected second Start can't
mutate the device set the running loop reads; `Stop` cancels, waits for
the sole-writer goroutine, then recreates the quote channel — the order
is documented and correct for sequential use. `sendQuote` drops the
oldest buffered quote so the freshest estimate wins without blocking the
loop. AkashProvider emits an explicit zero-confidence quote when no GPU
is present (matching the contract: publish zero rather than go silent).
MiningProvider's yield math (device/network hashrate × block reward /
block time) is correct and honestly constants-marked; the unused BTC/USD
rate is gated behind `_ = rate` with a note — cosmetic only. Clean.

**daemon verdicts.** `quoteToken`/`xmlEscape` quoting is correct for all
three managers (systemd ExecStart, launchd plist argv, sc.exe binPath);
`statusWindowsService` parses `sc.exe query` output correctly ("RUNNING"
only appears as the state token); the `ProtectHome=read-only` +
`ReadWritePaths` carve-out mirrors `DefaultDataDir` resolution so the
unit's exception matches the path `otedama run` actually uses. Master's
`installWindowsService` registers `start= auto` without starting the
service — that semantics change is owned by closed PR #552 (user's
review decision), not re-delivered here.

**Toolchain watch.** Go 1.26.8 (released Sep 1, 2026) is the latest
patch — the repo's `GOTOOLCHAIN=go1.26.8` pin already tracks it. Minor
revisions 1.26.5–1.26.8 shipped security fixes across crypto/tls, x509,
net/http and the go command; no action beyond confirming the pin.

## Session 515 — metrics + clock + tui fully read

**Audit milestones.** `internal/metrics` (both files), `internal/clock`,
and `internal/tui` read end-to-end.

**metrics verdicts.** Registry is RWMutex-guarded; counter/gauge
cross-type name collisions panic at registration with a documented
severity rationale (one bad name discards the whole Prometheus scrape).
Exposition is sorted and deterministic; `escapeLabel`/`escapeHelp` cover
the format's real specials; `formatFloat` renders NaN/±Inf canonically.
Noted residual (recorded, not fixed): `metricKey` serializes label
values without escaping `,`/`=`, so two distinct (name, labels) pairs
could collide into one series key — requires a device ID containing `,`
or `=`, which today's ID producers ("cpu-0", "gpu-<render-node>") cannot
emit; worth revisiting if a user-controlled ID source ever lands.
`RuntimeCollector`'s PauseTotalNs/GCCPUFraction are deprecated-but-still-
populated MemStats fields — fine on go1.26.8.

**clock verdicts.** Fake is RWMutex-guarded; Set/Advance deliberately
allow backwards time with a documented non-monotonicity contract.
Compile-time interface checks present. Clean.

**tui verdicts.** Start/Stop are atomic-gated and Stop waits on the
render-loop WaitGroup before writing to the (non-concurrent) writer —
the race it documents is genuinely closed. `writeLine` truncates then
pads to cols, keeping the cursor-home repaint model; `truncateVisible`
preserves in-flight ANSI and appends reset. Two non-blocking findings
(recorded, no code change): `truncateToBudget` and `shortenURL` are two
near-identical truncators — a duplication candidate to file as an Issue
per the dedupe convention, not fix inline; and the `⏸`/`⚠` badges in
miningLine count as width-1 under `visibleLen` but render width-2 —
self-consistent across frames since truncation uses the same count, so
the residual is at most a one-column flicker on narrow terminals, not
repaint corruption.

## Session 516 — doctor + config read; full-tree audit complete

**Audit milestone — full coverage.** With `internal/doctor`
(doctor.go + checks.go) and `internal/config` (config.go) read
end-to-end this session, every non-test `.go` file in the repository has
now been read line-by-line across sessions 509–516 (plus the earlier
CODEOWNERS-area sweeps): engine, miner, hal, arbitration, logger,
version, provider, daemon, metrics, clock, tui, doctor, config, stratum,
poolproto (V1+V2), lightning, btccrypto, rates, httpserver, i18n, cmd.

**doctor verdicts.** All 17 checks (matching the architecture map's
"17 並行ヘルスチェック") verified: concurrent runner preserves curated
result order by index; exit codes 0/1/2 mirror correctly into JSON;
clock-skew check drains a bounded 8 KB body so keep-alive reuse cannot
become an unbounded read; `maskAddress`, charset helpers, tls_ca_file
scheme-scoping, endpoint-diversity DNS check all sound. Per-pool probing
remains open-PR-owned (#490).

**config verdicts.** Four-layer resolution and Origins tracking are
complete and consistent (all 14 fields); `numericEnvVars` is the single
source the applier and warner share so they cannot drift;
`DefaultDataDir` platform paths match the doc comment; `Validate`
aggregates issues in one pass. Two residual items already owned by open
PRs, recorded not re-delivered: non-finite env values parse as floats
and pass Validate's `< 0`/`>= 1` guards (open #492 re-delivery), and
pool-URL validation stops at scheme+non-empty host (open #486's
host:port/userinfo tightening).

## Session 517 — test-code audit pass + ecosystem recheck

**Test-suite mechanical audit.** All 33 K lines of `*_test.go` swept:
skips are all environmental and self-describing (OS-gated GPU/permission
checks, listener binds, root-user semantics); `_ =` error swallows are
confined to fixture setup/teardown and test-only probes; sleeps are
localized concurrency timing, not correctness dependencies; assertion
density ~1.8–2 per test with no tautological or always-true checks found.
`go test -race ./...` on master (go1.26.8): all 23 packages green —
clean baseline re-verified.

**Ecosystem recheck — no drift.** SRI release line still tops out at
v1.12.0 (the BIP323/cipher-drop/hardening release recorded in session
478); nothing newer to reconcile. Local toolchain go1.26.8 confirmed
current-latest against go.dev. ESP-Miner 2.15.3 already recorded (no
HAL delta). The go1.24.0→go1.26 toolchain bump remains closed-PR-owned
(#369) — recorded, not re-delivered.

## Session 518 — sv2-spec: error-code automation + non-custodial payouts

Two verified specification developments recorded in ADR-009:

- **sv2-spec #194 merged (2026-06-16)**: the spec now explicitly permits
  implementations to take automated actions on protocol error codes —
  upstream validation of Otedama's canonical reject-code classification
  (open-PR lineage since session 257).
- **sv2-spec #202/#203 (open)**: competing designs for a non-custodial
  pool-payouts extension to JDP (request/response vs push-based) —
  miner-declared payout outputs inside the declared template, directly
  on Otedama's sovereignty axis; worth tracking for any future JDC work.

## Session 519 — duplication candidates recorded as ledger entries

Recorded (not fixed, per CLAUDE.md rule 3 — consolidation is a contract
decision) in `docs/CATEGORY_AUDIT.md`:

- **`tui` truncator family**: `truncateToBudget` hard-cuts at `budget<4`
  vs `shortenURL` returning the over-limit string intact — divergent
  edge semantics, same class as Issue #3.
- **`metrics.metricKey`**: label values join `,`/`=` unescaped —
  collision possible only if a label value contains those characters;
  unreachable from today's producers but live on the API surface.

## Session 520 — Go 1.27 verification + upstream sv2-ui orchestrator

- **Go 1.27 released Aug 2026** — environment toolchain auto-upgraded to
  go1.27.1; `go test ./...` green on all 23 packages; no >`go 1.22`
  stdlib symbols → 1.27's new `stdversion` vet is clean; godebug block
  parses under the new removed-setting acceptance rule. Toolchain bump
  remains closed-PR-owned (#369).
- **`stratum-mining/sv2-ui`** — upstream Docker orchestrator (translator
  + JDC + Core IPC 30.x/31.x) for JDP stacks; recorded in ADR-009 as the
  deployment target a future Otedama JDC would compose with.
- ESP-Miner still at v2.15.3 (AxeOS UI now embedded in the main
  firmware binary + mDNS since 2.15.0); DATUM gateway v0.4.1beta, no
  protocol drift.

## Session 521 — ecosystem recheck: SV2 trajectory, repo landscape

- SV2 transport ~15–20% of hashrate early 2026 (estimate); SRI WG
  projects 40–60% by end-2026 (forecast). 7-pool WG commitment remains
  the load-bearing datapoint — recorded in ADR-009.
- `stratum-mining/stratum` (SRI monorepo) and `stratum-mining/sv2-apps`
  (translator/JDC/sv2-ui) coexist — JD tooling lives in sv2-apps.
- `cbyam/solo-pool-rs` demonstrates single-port SV1/SV2 auto-detection
  from the first frame byte.
- Japanese-source recheck (Qiita/Zenn): no new mining-protocol or
  arbitration content — coverage gap persists, no drift.

## Session 522 — EROSION network-adversary threat modeled

Recorded in THREAT_MODEL's DoS section (a class previously unmodeled —
network adversary disruption, vs pool-side DoS):

- **EROSION (Tran/von Arx/Vanbever, IEEE S&P'24)**: one corrupted SV2
  ciphertext desynchronizes Noise nonce counters → session dies while
  the miner keeps hashing stale jobs; 91% of surveyed pools reachable,
  one malicious AS could hit 96% of BTC hashrate.
- **Otedama posture verified**: any frame/decrypt error is session
  fatal → reconnect → fresh handshake re-syncs counters. No
  silent-degradation mode; residual = bounded reconnect loop under
  sustained tampering (inherent; countermeasure is routing hygiene).
- Spot-GPU scheduling literature (SkyNomad, committed-horizon spot
  allocators) reviewed — tangential to the current provider layer
  (simulated); noted for future arbitration work only.

## Session 524 — golangci-lint version divergence recorded

Recorded in KNOWN_LIMITATIONS §13 (CI-workflow ledger):

- **Three different pins**: `ci.yml` curl-installs `v1.55.2`;
  `test.yml`/`ci-cd.yml` use `golangci-lint-action@v3`; local tooling
  is `v1.64.8`. Upstream is at `v2.13.x` — v2.13.0 added go1.27
  support (needed locally since go1.27.1's export data exceeds
  v1.64.8's typecheck decoder; run under `GOTOOLCHAIN=go1.26.8`).
- Upgrading implies a v2 config migration of `.golangci.yml` plus
  bumping both CI pin sites — maintainer-owned (workflow files).
- Repo's GitHub Issues #2/#3 (duplication ledger links) re-checked:
  still open, status unchanged.

## Session 526 — in-tree fuzz targets smoke-verified

CI has no fuzz job (recorded in KNOWN_LIMITATIONS §13), so the two
in-tree fuzzers were run locally for 30s each under go1.27.1:

- `FuzzDecoder_ReadFrame` (frame decoder, length-field arithmetic):
  ~618K execs, 20 seeds → 21 corpus, **zero crashes**.
- `FuzzDecodeHeader` (header parser): ~3.97M execs, 7 seeds → 8
  corpus, **zero crashes**.

The protocol-parse boundary holds against random input; the only gap
remains that CI never exercises these (maintainer-owned workflow).

## Session 527 — first end-to-end binary smoke

Built the real binary under go1.27.1 and exercised the user-facing
surface (everything prior was library-level testing):

- `otedama version` — prints version + toolchain + arch correctly
  (`unknown` commit/build is the documented no-ldflags behavior).
- `otedama completion bash` — emits a working script.
- `otedama doctor` — all 17 checks run (119ms), correct pass/fail/warn/
  skip counts, exit code 2 with failures per the documented 0/1/2
  contract. (Pool-reachability fail is sandbox DNS, not a defect.)
- `otedama config show` / `config validate` — resolved config with
  origins prints; validate fails with exit **78** exactly per the
  §2.1 EX_CONFIG contract.

The documented CLI contract holds end-to-end on the built artifact.

## Session 528 — non-custodial core path verified end-to-end

Ran the real binary against a temp data dir; the product's core
promise holds E2E:

- **First run**: wallet auto-created → the 24-word BIP-39 phrase is
  shown exactly once with its fingerprint and the "not saved to disk /
  not in any log" banner → `wallet.dat` written at mode 0600 (+ a
  `wallet.fingerprint` sidecar) → devices detected, worker spawned,
  V2 connect attempted → plaintext-transport warning correctly
  advises `stratum+v2tls://` → exponential-backoff reconnect loop on
  DNS failure → clean shutdown on SIGTERM ("Your wallet remains
  safe").
- **Second run**: same fingerprint (`27d96d0d`), phrase NOT re-shown —
  one-time disclosure honored.

Also observed live: the sandbox can't resolve the default pool's DNS,
so the connect loop's backoff behavior was exercised directly.

## Session 529 — BENCHMARKS re-verified against go1.27.1/arm64

- **Measured `BenchmarkHashHeader`**: ~112 ns/op, 0 allocs on
  virtualized Apple M4 → ~8.9 MH/s/thread — added the missing M4 row
  to the single-thread table (the existing rows predate M4).
- **Frame-decode section corrected** (two stale claims surviving
  session 484's pass): the cited `BenchmarkDecoder_ReadFrame` does not
  exist in the tree (only `BenchmarkHmacSHA256_*` in `internal/stratum`)
  so the reproduce command ran zero benchmarks; and "fuzzed
  continuously in CI" is false (no fuzz job — KNOWN_LIMITATIONS §13;
  fifth doc with this phantom). Table re-labeled as unverified
  targets, not measurements.

## Session 530 — sv2-spec drift: cert version now normative

Recorded in ADR-009:

- **sv2-spec #230 merged (Sep 10)**: Noise certificate `version` MUST
  be 0; initiator MUST reject unsupported versions (was undefined;
  implementations disagreed, #229). Forward requirement for Otedama:
  `internal/stratum/noise*.go` does not yet parse the responder cert,
  so when cert validation lands it must include the `version == 0`
  check — recorded where implementers will look.
- **sv2-spec #233 merged (Sep 23)**: upstream added `AGENTS.md` —
  meta, no protocol impact.
- SRI remains at v1.11.1 (no release since the V1-difficulty fix).

## Session 531 — per-package coverage measured

`go test -cover ./...` under go1.27.1: **24 packages, all green;
median ~97% statement coverage.** Distribution:

- 100%: arbitration, clock, i18n, logger, metrics, poolproto, version
- 97–99.7%: btccrypto, doctor, hal, httpserver, i18n/messages, miner,
  poolproto/stratumv1, poolproto/stratumv2, provider, rates, stratum,
  tui
- 92–95%: config, daemon, engine, lightning
- 88%: `cmd/otedama` — the only package below the 90% intent.

The two <50% functions inside cmd/otedama are `main` (0% — untestable
entrypoint by design) and `cmdRun` (36.4%). cmdRun's uncovered
residue is the live-run tail — `engine.Run(...)` call site, the
signal-NotifyContext wiring, HTTP server Start/Stop — i.e.
integration-only territory already exercised by the session-527/528
binary E2E smokes rather than unit tests. Recorded as a
coverage-gap verdict, not a defect: unit coverage of the remaining
paths would require a live pool or a scripted service manager.

## Session 534 — escape analysis: hot path clean

`go build -gcflags='-m'` on `internal/miner`: every heap escape is on
a cold path — `diff1Target` (package-init big.Int), error-string
literals in `NBitsFromTarget`/`TargetFromDifficulty` (invalid-input
paths only), `&Worker{}`/`wg` (once per construction/Start).
`TargetFromDifficulty` allocates `big.Float` per call but runs once
per `mining.set_difficulty`, not per hash. The grind loop itself is
allocation-free, consistent with `BenchmarkHashHeader` 0 allocs/op.
No action needed; recorded as an audit verdict.

## Session 535 — flake sweep: timing-sensitive packages clean

Repeat-run sweep of the packages whose tests touch timers,
goroutines, or the network: `go test -count=3 ./internal/engine`
and `-race -count=2` on `internal/engine`, `internal/stratum`,
`internal/poolproto` — all green, zero flakes observed on
go1.27.1/arm64. Combined with the `-race` full-tree run in session
517, no nondeterminism evidence remains anywhere in the suite.
No action needed; recorded as an audit verdict.

## Session 536 — extended vet analyzers: nilness + shadow

`nilness` (x/tools, go1.26.8): zero findings across the whole tree —
no impossible-nil or nil-deref paths.
`shadow`: 13 findings, all the `if err := f(); err != nil` idiom —
each inner `err` is scoped to the `if` and checked immediately; the
outer `err` continues to be read afterward (wallet.go:136,
handshake.go:243, engine/run.go:1212, stratumv1/dialer.go:67,
stratumv2/dialer.go:121 — all verified benign, no dropped errors).
Standard vet's `loopclosure`/`unusedresult`/`atomicalign` already
run clean via `go vet ./...`. No action needed.

## Session 537 — stdlib modernization: sort → slices complete

Audit found every non-test sort already on `slices`/`cmp`/`maps`
(stdlib since Go 1.21) across metrics, rates, hal, btccrypto,
arbitration, i18n, engine. The single holdout — `sort.Strings` in
`internal/i18n/messages/messages_test.go` — is now `slices.Sort`,
so the tree no longer imports `sort` or calls `reflect.DeepEqual`
anywhere. `go test ./internal/i18n/...` green.

## Session 538 — checkptr sweep: pointer safety clean

`go test -gcflags=all=-d=checkptr ./...` ran the whole suite with
checkptr instrumentation (unsafe.Pointer arithmetic validation):
all 24 packages green, zero violations. The tree uses almost no
`unsafe` (only the syscall-free design), and what little pointer
manipulation exists in the wire codecs is spec-conformant.
No action needed; recorded as an audit verdict.

## Session 539 — dependency & import-boundary audit

`go mod verify`: all modules verified — module-cache integrity
clean. External dep surface is exactly two modules (`x/crypto`
chacha20/chacha20poly1305/scrypt/pbkdf2 for Noise + wallet KDF;
`yaml.v3` for config), both already documented in go.mod comments.

Import graph verified as a proper DAG matching CLAUDE.md's
architecture map: 13 leaf packages with zero internal imports;
`arbitration→hal`, `provider→hal`, `config→btccrypto`,
`daemon→config`, `doctor→{btccrypto,config}`, `httpserver→metrics`,
`stratumv1→poolproto`, `stratumv2→{poolproto,stratum}`; `engine` is
the sole aggregator and `cmd/otedama` wires the entrypoint. No
upward imports, no cycles, no forbidden paths.

## Session 540 — test-order dependence: -shuffle=on clean

`go test -shuffle=on ./...` twice with different seeds — all 24
packages green both runs. No test depends on package-level
execution order (no shared fixture state leaking between tests),
consistent with the session-517 race sweep and session-535 flake
sweep: the suite is deterministic and order-independent.
No action needed; recorded as an audit verdict.

## Session 541 — serialized scheduling: -cpu=1 clean

`go test -cpu=1 ./...` (GOMAXPROCS=1, single-threaded scheduling)
twice over the full tree — all 24 packages green both runs. No
test implicitly requires a multi-CPU scheduler to make progress;
the concurrency-heavy suites (engine, stratumv1/v2, doctor's
17 parallel checks) all drive goroutines through channels/sync
correctly under serialization. Combined with the race (s517),
flake (s535), and shuffle (s540) sweeps, the suite is robust
across every Go scheduler dimension.

## Session 542 — ecosystem recheck: sv2-spec #220/#221/#224/#209

Four new spec merges since session 530: #220 fixes Noise Act 2 to
exactly 234 bytes (wire-level normative; Otedama's ReadMessage2 is
lenient >=32 — recorded as a §2 forward requirement), #221 drops
Lightning "Act" terminology for Noise "steps" (docs only), #224
editorial, #209 prohibits active-job_id reuse and SetNewPrevHash
references to unreceived jobs (engine already pauses+warns on
unknown-job refs; duplicate job_id is last-wins defensively).
SRI still v1.11.1 — its SV1 difficulty round-up fix (#2227) does
not apply here: sha256d.go computes targets with exact big.Int math.

## Session 544 — runtime integrity: checkptr=2, invalidptr, binary audit

- `checkptr=2` (stricter: also checks unsafe.Pointer→uintptr
  conversions) on miner+stratum — green; `GODEBUG=invalidptr=1`
  on the same — green. With s538's tree-wide checkptr=1, every
  pointer-safety level now verifies clean.
- `go version -m` on a local build: dep closure = x/crypto +
  yaml.v3 only (matches s539). Local builds link CGO
  (libSystem/CoreFoundation/Security via darwin resolver — default
  platform behavior), but the shipped path pins `CGO_ENABLED=0`
  in both .goreleaser.yaml and the Dockerfile, so release artifacts
  are fully static per ADR-003. Verified, no drift.

## Session 545 — pprof: hot loop is ~100% FIPS SHA-256

`go test -bench=BenchmarkHashHeader -benchmem -memprofile
-cpuprofile`: 105.3 ns/op, **0 B/op 0 allocs/op** — and
`alloc_space` shows zero bytes attributable to HashHeader itself
(every byte is test-harness/pprof machinery). CPU: 98.5% of
samples inside `HashHeader` → `crypto/internal/fips140/sha256`
(go1.27 routes crypto/sha256 through the FIPS-validated
implementation, matching the FIPS posture in GODEBUG_NOTES).

Optimization analyzed and rejected: the classic mining midstate
trick (header bytes 0–63 are constant per job → precompute the
SHA-256 state after block 1, compress only block 2 per nonce)
would cut ~1 of 3 compressions (~25–30% of hash cost). Go stdlib
exposes no midstate/partial-compression API; the only path is a
hand-rolled compression function, which CLAUDE.md forbids
(no custom crypto — audited libraries only). Recorded with the
measured headroom so the constraint-vs-payoff trade is explicit.

## Session 565 — atomic API surface

- All `sync/atomic` usage is the typed Go-1.19+ API:
  `atomic.Uint64` (8), `atomic.Bool` (7), `atomic.Pointer[T]` (4),
  `atomic.Int64` (1). Zero legacy `atomic.AddInt64(&field)`-style
  calls — so the 386-misalignment panic class (64-bit atomics on
  unaligned fields) is structurally absent; the typed API
  guarantees alignment internally.

## Session 566 — JSON/YAML decode boundary

- Every `json.Unmarshal` takes a `&`-pointer and checks its error;
  every `json.Marshal` checks `err`. The only two ignored results
  are the documented best-effort tolerations in parse.go:164/176
  ("tolerate non-string" — deliberate lenient parsing for pool
  quirks), each carrying an inline justification comment.
- yaml: the config-file decode uses `yaml.NewDecoder` with
  `KnownFields(true)` (unknown keys rejected), checks `Decode`'s
  error, and treats io.EOF as "use defaults" — the fuzz target for
  this boundary exists (session 391).

## Session 567 — package-init surface

- `func init()` exists in exactly four files:
  - `lightning/english_wordlist.go` — splits the embedded BIP-39
    wordlist and **panics at startup** if the count is not 2048 or
    the SHA-256 doesn't match — fail-fast integrity self-check.
  - `btccrypto/secp256k1.go`, `stratumv1` and `stratumv2` dialer
    registration — the canonical `init()` plugin-registry pattern,
    each paired with compile-time `var _ Interface =` assertions.
- No init performs I/O, spawns goroutines, or mutates shared state
  beyond registration — all are idempotent and order-independent.

## Session 568 — recover() + goroutine-spawn audit

- Zero `recover()` calls in non-test code: no panic-swallowing
  surface anywhere — every error propagates as a returned error,
  matching the library-kill audit (session 562).
- 20 `go` spawn sites across 10 packages — the exact set mapped in
  session 553's leak-coverage table. Each is ctx-scoped
  (readLoop/renderLoop/arbitration), wg-tracked (fan-in
  collectors closing via `wg.Wait(); close`), or a one-shot
  trigger (`go s.Close()`). NumGoroutine shutdown evidence from
  session 553 covers all of them.

## Session 569 — `any` usage audit

- The only `any` values in non-test code are: V1 JSON-RPC wire
  struct fields (`ID`, `Result`, `Error`, `result`, `errResult`)
  — spec-mandated untyped payloads at the wire boundary, parsed
  into typed values by the parsers; `sync.Pool.New`'s required
  `func() any` signature; and `fanIn[T any]` — a generic
  constraint, the correct modern form.
- Zero loose-typing escapes at internal package boundaries; every
  internal API is concretely typed.

## Session 570 — enum exhaustiveness audit

- Five iota-enum types (`Format`, `ValueOrigin`, `Status`,
  `AddressType`, `Policy`). Every switch over them is either
  exhaustive (`doctor.go:177` enumerates all four Status cases) or
  uses a correct default: `logger.go` FormatJSON→JSON,
  default→text (two-value enum); `doctor.go:114` counts only
  Warn/Fail — correct for exit-code semantics; `config.go` string
  field with explicit validation default.
- Zero silent pass-through on an unhandled enum value.

## Session 571 — context cancel-function audit

- Six `context.WithTimeout/WithCancel` sites; every cancel is
  paired: three use immediate `defer cancel()` (checks.go:772,
  httpserver:138, doctor.go:36) and three store the func into a
  lifecycle field that is unconditionally invoked — `p.cancel`
  called at polling.go:87 with nil-reset under lock, `s.ctxCancel`
  inside `closeOnce.Do` (stratumv1:377), `w.cancel` retrieved by
  worker Stop (worker.go:158).
- Zero leaked contexts; no `WithCancel` whose cancel is dropped.

## Session 315 — submit in-flight depth gauge (ESP-Miner v2.15.0 pending-shares parity)

**Finding [FETCHED — bitaxeorg/ESP-Miner v2.15.0 release notes, 2026-08-21].**
ESP-Miner added "Show pending SV2 shares on the dashboard" (#1735) —
exposing submit→ack in-flight depth as a first-class operational signal.

**Fix [OBSERVED].** New `otedama_shares_submit_in_flight` gauge publishes
`len(submitTimes)` on the 30 s stats tick (V2 path; V1 submits
synchronously and stays 0). SPECIFICATION §6 catalogue row added —
`TestMetricsDocumentedInSpecification` green. Also audited [OBSERVED]:
V1 fractional difficulty + negative/zero difficulty are already handled
(`[]float64` parse + `TargetFromDifficulty` `>0`/IsInf guard).

## Session 388 — arbitration property tests + ecosystem re-check

[FETCHED — 2026-09-25] Stratum V2 SRI: v1.12.0 (2026-09-17) remains the latest release — channels_sv2 hardening pass, codec_sv2/framing_sv2 refactor (Frame enum → MessageFrame/SerializedFrame), BIP323 adaptations, AES-256-GCM dropped from noise_sv2 leaving ChaCha20-Poly1305 sole cipher. All mapped onto Otedama in earlier sessions (this client never implemented AES-256-GCM; framing is Otedama's own). ESP-Miner v2.15.3 (2026-09-20) remains latest; no new stratum-facing changes to chase.

[FIXED — session 388] **Arbitration property tests** (`internal/arbitration/fuzz_test.go`): the `Decide` doc comment has always claimed its invariants "are verified by property-based tests" but no such test existed — a doc/code drift and a real coverage gap on the package CLAUDE.md explicitly requires property tests for. `FuzzDecide` generates randomized devices/streams/policies/margins/previous-allocations (seeded `math/rand` over a fuzz `int64`) and asserts on every run: bijective DeviceID assignment in sorted order; no assignment to an unknown or family-incompatible stream; idle only when no compatible stream both yields >0 and clears MinYieldSatsPerSec; `TotalYield` == exact IEEE-754 sum of ExpectedYield; `ForegoneSatsPerSec` >= 0; byte-identical determinism via a second `Decide` call; and — on a quarter of runs that force PolicyMaximizeEarnings + zero hysteresis + no Previous — the documented greedy-optimality invariant (TotalYield equals the per-device max). 13.5M execs in 90s, zero violations.

[AUDITED — clean] Open-PR review-comment sweep: #495, #496, #497, #498 all mergeable, zero unresolved reviewer/Devin-Review comments. Re-delivery queue stays exhausted (audit recorded in session-387 entry).

## Session 543 — sync.Pool wiring: Noise handshake hashers

`noise_pool.go` shipped a correctness-tested `hmacSHA256Pooled`
that the file itself documented as "not yet wired" — hkdf2/hkdf3
still called the unpooled `hmacSHA256`, allocating ~12 hasher
objects per handshake. Wired hkdf2 (3 calls) and hkdf3 (4 calls)
to the pooled variant; the unpooled `hmacSHA256` remains as the
test reference implementation. Equivalence is covered by the
existing pooled-vs-reference test matrix; `go test -race
./internal/stratum/` green. Frame-codec `make([]byte)` calls are
per-message (share/notify rate), not per-hash — pooling there
would not pay; recorded as reviewed-and-skipped.

## Session 398 — SV2 encode-side round-trip fuzz

**`FuzzMessageRoundTrip` [FIXED — coverage gap].** The six steady-state
mining-channel messages (`NewMiningJob`, `SetNewPrevHash`, `SetTarget`,
`SubmitSharesStandard`, `SubmitSharesSuccess`, `SubmitSharesError`)
previously had decode-only fuzzers (#479): arbitrary bytes never wedge
the parser, but nothing proved the encode direction is correct or
canonical. The new fuzzer builds every message from fuzz input and
asserts three invariants per type: Encode never fails, Decode of the
output returns an identical value, and re-encoding is byte-identical
(canonical-form stability in both directions). 60 s / 8.7 M execs clean
(`internal/stratum/roundtrip_fuzz_test.go`). With this, both directions
of every SV2 message type Otedama emits or consumes have property
coverage.

## Session 389 — fuzz coverage for target bitmath + numeric env resolution

[FIXED — session 389] **Target-math fuzzers** (`internal/miner/fuzz_test.go`): `TargetFromNBits` and `TargetFromDifficulty` convert pool-supplied wire values into the 256-bit targets shares are compared against — until now covered only by fixed vectors. `FuzzTargetFromNBits` asserts: never panic; accepted inputs produce a positive target; `TargetFromNBits(NBitsFromTarget(t))` reproduces the identical target (value round-trip, since re-encoding may pick a non-canonical nBits); the all-zero hash meets every valid target. `FuzzTargetFromDifficulty` asserts invalid difficulties (NaN/±Inf/≤0) always error and accepted ones produce positive targets. `FuzzTargetFromDifficultyMonotonic` asserts d1<d2 ⟹ target1≥target2 (weak monotonicity under float truncation). ~41M execs total, zero violations.

[FIXED — session 389] **Numeric env-resolution fuzz** (`internal/config/fuzz_test.go`): `FuzzResolveNumericEnv` drives `EnvWarnings` + `ResolveWithOrigins` with arbitrary strings on each `OTEDAMA_*` float key, asserting the documented contract both ways — a parseable value lands on its field bit-exact with `OriginEnv`, while an unparseable non-empty value yields exactly one warning naming the key and leaves the field untouched (no env origin). Covers typo classes the unit tests missed (comma decimals, overflow exponents, "NaN" literals). ~7M execs, zero violations.

## Session 481

**Ecosystem drift check (SRI 1.11.1, 2026-07-22).** The reference
implementation's translation proxy rounded *up* Stratum V1 difficulty
values during V1→V2 conversion (stratum-mining/stratum#2227), making the
effective share target stricter than the pool assigned. Otedama's
`miner.TargetFromDifficulty` performs full-precision division
(`target = diff1Target / difficulty` at 256-bit `big.Float` precision,
truncation error <1 ULP) — the same defect class is not present. The
V1 notification parsers (`parseNotify`, `parseDifficulty`,
`parseSetExtranonce`, `parseShowMessage`, `client.reconnect`) were
re-audited: all bounded, and the zero-fill fallbacks are on the
pool-side-invalid V1 share path (KNOWN_LIMITATIONS §17), so they cannot
produce misleading mining behaviour beyond what is already documented.

**Repo hygiene sweep — one real fix.** `Makefile` targets were all
inventoried: every referenced binary, path, and subcommand exists; the
only remaining stale reference is `docs-serve`'s
`golang.org/x/tools/cmd/godoc@latest`, which resolves to
`v0.1.0-deprecated` (godoc was split out of x/tools and abandoned — it
still runs today but upstream is dead and a future `@latest`
resolution can fail outright; left as-is since `setup:` uses the same
`@latest` convention and the correct replacement choice — pkgsite vs.
`go doc` static output — is a maintainer call).

The committed `.claude/settings.local.json` was deleted and added to
`.gitignore`. It is a per-developer Claude Code permissions file that
must not be versioned (upstream convention: `settings.local.json` is
local-only; the shared file is `settings.json`). The committed copy
accumulated 130+ stale `Bash(...)` allow-entries for a pre-rewrite
project shape that no longer exists — `internal/mining`,
`internal/crypto`, `internal/monitoring`, `internal/database`,
`cmd/improvements`, `cmd/demo`, `cmd/test-runner`, WSL paths
(`/mnt/c/...`, `"C:\Program Files\Go"`), and phantom helper scripts
(`./fix_imports.sh`, `./cleanup_tests.sh`, `dos2unix`) — plus
broad `Bash(rm:*)`/`Bash(git push:*)` grants. Removing it cannot break
the tool: Claude Code regenerates the file locally on first use.

## Session 482

**ROADMAP.md reconciliation against shipped code — four stale entries
corrected.** The v3.1.0/v3.2.0 milestone lists still described the
pre-integration state:

- `engine → poolproto 統合` claimed `engine.Run` was still on
  `stratum.NewDecoder` + raw TCP and that "SV1 transport 等が使えない" —
  false since the `runSessionV1` dispatch shipped: V1 connections go
  through `poolproto.DialURL` and the `poolproto.Session` interface
  (`Jobs()`/`Submit()`). The remaining gap is narrower: the V2 loop is
  still on the native decoder path, and `internal/poolproto/stratumv2`
  (registered dialer) has no engine caller — the open decision is
  "migrate the V2 loop onto poolproto" vs "drop the unused dialer".
- `govulncheck + osv-scanner を CI ゲートに昇格（現在 informational）` —
  "informational" was inaccurate: neither tool runs in any CI workflow;
  govulncheck exists only in the local `security`/`audit`/`setup`
  Makefile targets and osv-scanner is absent from the repo entirely.
- `internal/poolproto/ 抽象化レイヤ` — marked partially complete: only
  the SV1 switch actually dispatches through the abstraction.
- `Stratum V1 互換の追加` — marked connection-complete: the dialer,
  handshake, extranonce/difficulty notifications, and submit path all
  ship, but V1 jobs hash a zero MerkleRoot (coinbase is never
  reconstructed — `stratumv1/parse.go`), so pools cannot accept the
  shares; V1 remains a connectivity/diagnostic path, SV2 is required
  for real revenue.

## Session 395 — fuzz for the V1 notification parsers

[FIXED — session 395] **V1 notification-parser fuzz** (`internal/poolproto/stratumv1/notify_fuzz_test.go`): `parseNotify`, `parseReconnect`, `parseSetExtranonce`, `parseShowMessage` — pool-controlled params decoders reachable on every read-loop tick. The dispatch-level fuzzer (#478) reaches them only after producing a well-formed method string; direct seeds drive the parsers past their length guards into per-field unmarshal and hex/dec paths. ~15M execs clean; `client.reconnect` verified to always yield a directive (its host/port remain advisory-only and are never dialed — documented anti-redirection design).

[AUDITED — clean] `parseReconnect` Wait field is stored but unconsumed on master (no sleep path); `parseSubscribeResult` fuzz lives in open #478; `extranonce2_size` bounds are open in #428/#450. The dormant Noise handshake stub (x-only fallback completes without DH) is documented as unwired alpha in KNOWN_LIMITATIONS §2 — targeted for spec-compliant replacement in v3.1.0, deliberately not hardened in place.

## Session 332 — yaml.v3 maintained-continuation migration

**gopkg.in/yaml.v3 archived [FETCHED + FIXED].** The gopkg.in yaml repo
was archived April 2025; the Yaml project continues it as
`go.yaml.in/yaml/v3` (v3.0.5). Violated CLAUDE.md external-dependency
criterion 3 (meaningful maintenance within the last year). API-identical
drop-in: only the two import sites changed (cmd/otedama/configfile.go,
internal/config/config_file_test.go). Re-delivers the dep-swap portion
of closed #367.

## Session 391 — fuzz for the config-file decode boundary

[FIXED — session 391] **YAML config-file fuzz** (`cmd/otedama/fuzz_test.go`): `loadConfigFile` turns arbitrary on-disk bytes into a `config.Config` — the last input-facing boundary without fuzz coverage. `FuzzLoadConfigFile` writes each input to a temp file and asserts the decode+`KnownFields`+`Validate` path returns without panic on non-UTF8 bytes, deep nesting, self-referential aliases, binary junk, and unknown-field documents. 98K execs clean (slower rate is per-exec file I/O by design — the load path is file-backed). With this landed plus #478/#479/#481/#499/#500, every untrusted-input surface — V1 wire, SV2 frames and typed messages, payout addresses, pool difficulty/nBits, numeric env vars, arbitration inputs, and config files — has fuzz or property coverage.

[AUDITED — clean] Session-level sweep recorded: all packages 92–99% statement coverage (≥90% bar met); zero TODO/FIXME/`unsafe` in non-test code; hot paths benchmarked.

## Session 498 — config.yaml.example の虚偽クレーム訂正 + コメント文言再検証

**Sweep.** `config.yaml.example`（~190行の説明コメント全部）を `internal/config`・`internal/engine`・`internal/i18n` と再照合（field 網羅性は session 465 で clean 確認済み、本ラウンドは「コメントの挙動記述」）。

**発見（1件訂正）。**
- **「pools が空なら built-in recommended pool list（V2 優先・0% fee）を使用」→ 虚偽**: `config.go` の PoolConfig コメントが明示する通りキュレーション済みリストは**存在せず**、単一 `DefaultPoolURL`（slushpool V2）へのフォールバックのみ — failover したいユーザーは明示列挙が必要と訂正（ドキュメント側が「ある」と言い、コード側が「ない」と書いている典型的二重記述乖離）。

**検証済み・変更なし。** スキーム一覧 4種（validSchemes と一致）・payout_scheme 4値・`user` 既定= bitcoin_address・worker name 既定= hostname・言語一覧（10 言語カタログと一致）・failover「全 pool 試行後に backoff」（run.go:462-469 と一致）・endpoint 一覧（/metrics /healthz /readyz /）・hysteresis/curtail/min_yield/power 系の説明 — 全て実装と一致。エコシステム再照合: SRI/sv2-spec に新規リリース差分なし。

## Session 501 — .golangci.yml 非推奨キー移行 + run.go バージョン訂正 + govulncheck clean

**Sweep.** (a) ルート直下の未精読ファイル（.editorconfig・CODEOWNERS・LICENSE 著作権行・NOTICE）→ 全て正確。(b) `golangci-lint config verify` で schema 検証 → 3件の不整合を発見。(c) `govulncheck -mode=source ./...` → **0 reachable vulns**（依存内22件は未到達 — yaml.v3/x/crypto とも import 経路が脆弱コードに触れない）。

**発見（1件修正 — 設定ファイルの陳腐化）。**
- **`run.skip-dirs` / `output.format` が deprecated**（v1.64 系で警告＋`config verify` が schema 拒否）→ `issues.exclude-dirs` / `output.formats`（array form）へ移行。併せて `run.go: "1.22"` を実効要件の `"1.24"` に訂正 — 「Go 1.22 記述」クラスの6箇所目（AUDIT_CHECKLIST・README・CONTRIBUTING・GODEBUG_NOTES・BENCHMARKS に続く）。検証: `config verify` exit 0・`run` で警告ゼロ。

**検証済み・変更なし。** LICENSE 著作権行（Monu (shizukutanaka) 記入済み）・CODEOWNERS の全パターン（noise* 2ルール含め実パス解決）・.editorconfig・service.go/version.go の CLI 実装。

## Session 392 — fuzz for the BIP-39 restore boundary

[FIXED — session 392] **BIP-39 mnemonic parse fuzz** (`internal/lightning/fuzz_test.go`): `MnemonicToEntropy` consumes operator-typed word sequences on the wallet-restore path — the last untrusted-input parser without fuzz coverage. Two fuzzers: `FuzzMnemonicToEntropy` (1.5M execs) asserts arbitrary word slices — wrong counts, unknown words, case-mismatch, empty strings — always error rather than panic, and any accepted mnemonic re-encodes identically; `FuzzMnemonicRoundtrip` (3.0M execs) asserts `EntropyToMnemonic` → `MnemonicToEntropy` is bit-exact across all five legal entropy sizes, pinning the checksum math.

[AUDITED — clean] gh CLI is unauthenticated in this environment (expected); open-PR mergeability was verified via the builtin git tools instead — recent PRs (#497, #498, #502) report MERGEABLE.

## Session 434 — サブコマンド did-you-mean 提案 [UX]

CATEGORY_AUDIT session-250 で「実在・低重要度・deferred」と記録されていた
唯一のコード補完可能項目を実装: `otedama verson` 等の誤記時に
`did you mean "version"?` を stderr に提案（exit 64 は不変）。

- `suggestSubcommand`: 全サブコマンド名との Levenshtein 距離 ≤2 で
  最近接を提案 — transposition（rnu→run）・脱字（srvce→service）・
  打ち違い（doktor→doctor）をカバーし、無関係入力（xyzzy-plugh）には
  提案しない。先頭ダッシュは除去（`--versio` → version）。
- 既存の静的リスト慣例（completion スクリプトと同型）に倣い
  `knownSubcommands` を dispatch switch と同期コメント付きで定義。
- 新規依存ゼロ（stdlib `min` + 2行 DP）。テスト3件追加
  （dispatch 統合2件 + 距離表10ケース）。

注意: open の #529 が `wallet` を switch に追加するため、そちらが先に
マージされた場合 `knownSubcommands` への追記が必要（#529 側で対応可、
または本 PR マージ後の一行フォローアップ）。

## Session 396 — fuzz for the SV2 handshake decoders

[FIXED — session 396] **Handshake-decoder fuzz** (`internal/stratum/handshake_fuzz_test.go`): `FuzzHandshakeDecoders` covers the five connection-phase decoders — the first wire bytes a pool controls after TCP accept (`SetupConnection`/`+Success`/`+Error`, `OpenMiningChannel`/`+Success`). Real `Encode()` outputs seed the corpus so mutations start past the length guards into the STR0_255/B0_255 field reads. `OpenMiningChannelSuccess` additionally asserts decode→encode→decode is stable (8.1M execs clean). With #479's steady-state decoders, every SV2 server→client message type has fuzz coverage.

[AUDITED — clean] `decode→encode` for a leniently-decoded `Extranonce` >32B correctly fails strict `appendB0_32` (documented Postel asymmetry) — verified by the round-trip guard.

## Session 413 — cross-reference sweep + dependabot dead key [FIXED]

**CODEOWNERS sample in solo-operations.md listed nonexistent paths
[FIXED].** §7.1's sample claimed `/internal/security/` and
`/internal/auth/` rules — both are CLAUDE.md forbidden paths that
don't exist and would never match anything. Replaced with the real
`.github/CODEOWNERS` contents (lightning/btccrypto/poolproto/
stratum-noise rules) plus a note explaining why those paths are
absent.

**Dead Dependabot key removed [FIXED].** `.github/dependabot.yml`'s
github-actions section had an `automerge: [dependency-type: direct]`
block — `automerge` is not a Dependabot option; GitHub silently
ignores unknown keys, so the config implied auto-merge that never
happened. Replaced with a comment pointing at the real mechanism
(repo auto-merge + `gh pr merge --auto` / merge queue).

**§-number cross-reference audit — clean:** every
`KNOWN_LIMITATIONS §N` reference in code/docs resolves correctly,
including the resolved entries (all carry "resolved session NNN"
annotations); `runSessionV1` V1-via-poolproto vs V2-inline split
matches §3's resolution wording; DEPLOYMENT.md command/flag/path
references all exist; README badges/links valid.

## Session 415 — Lint-debt cleanup: 350 → 65 findings [LINT]

**動機.** `.golangci.yml` は errcheck・errorlint・gosec・gocritic・misspell
(locale: US)・gofumpt・prealloc・goconst・unparam・dogsled・nilerr 等を必須と
明記しているが、CI の Lint ジョブは setup 段階で常に失敗しており債務が不可視
だった。手元で golangci-lint v1.64.8 を実行すると ~350 件。このセッションで
機械的・意味的修正を一括適用した。

**適用した修正（全てリポジトリ自身の lint 設定が要求する規則）.**

- **gofumpt -extra（21ファイル）**: `0600`→`0o600` 8進リテラル、var グループ化、
  composite literal の整形。
- **misspell（locale US、~140件）**: コメント・godoc の英英式綴りを米式へ
  （sanitises→sanitizes、recognises→recognizes、behaviour→behavior 等）。
  i18n メッセージカタログと BIP-39 英語ワードリストは**除外** — カタログは
  非英語文字列を破壊し、ワードリストの `artefact` は正規データ（SHA-256 の
  init 時整合チェックが実際に検出した）。`english_wordlist.go` を misspell
  対象から exclude-rules で恒久的に除外。
- **errorlint**: `err == flag.ErrHelp` / `err == io.EOF` / `err != context.Canceled`
  の等価比較を `errors.Is` へ（cmd/otedama ×4、configfile、coverage_test、
  metrics_test、noise_test 群）。`isFatal` の型アサートを `errors.As` へ —
  **これは意味変更を伴う**: ラップされた fatalError が従来「非 fatal＝無限再試行」
  だったのを正しく fatal 判定へ（テストが将来の移行を明記していたため期待値を更新）。
  `fmt.Errorf("%w: %v", a, b)` → 複数 `%w`。
- **unparam**: `parseReconnect` の常に true の ok 戻り値を除去、`pruneStaleStreams`
  の冗長 ttl パラメータを除去（呼び出し側・テスト3箇所を追従）。
- **unused**: `remoteStatic` フィールド（noise.go）・テスト専用 `parseFloat` を削除。
- **prealloc**: 8箇所のスライスに容量ヒント（arbitration candidates、setup workers、
  metrics entries 等）。
- **goconst**: 本番側の繰り返しリテラルを定数化（`helpFlag`/`displayDefault`、
  `logLevelInfo`/`logFormatText`、daemon/doctor の `goosLinux` 等）。テスト内
  リテラルは .golangci.yml 既存の除外方針どおり据え置き。
- **gocritic（機械的なもの）**: 空の else/fallthrough 除去、unnecessaryDefer
  （return 直前の defer → 直接呼出）、builtinShadow（`cap` パラメータ）、
  stringXbytes、emptyStringTest（`len(name)==0`→`name==""`）、appendAssign、
  ifElseChain→switch（wallet.go）、httpNoBody、emptyFallthrough。
- **dogsled**: 3連ブランク代入を `_ = ferr` パターンへ。
- **SA9003**: 空の許容ブランチを `t.Log`/コメントで明示。
- **bodyclose**: テストの `http.Get` レスポンスボディを Close。
- **gosec G306**: systemd unit / launchd plist の 0644 → 0600（serviceArgs を
  埋め込むため厳格化が安全側）。
- **gosec G115 ×18**: 全サイトを個別検証し、有界変換（5/8ビット群、BIP-39 チェック
  サム bit、nBits 指数、maxNoiseFrame 検査済み ciphertext 長等）に根拠コメント付き
  `//nolint:gosec` を付与。uintID は負値でも unmatched key 化するのみで安全。
- **sprintfQuotedString**: `sc.exe` の `"%s"` と Prometheus ラベル `"%s"` は %q の
  Go エスケープで意味が変わるため `//nolint:gocritic` と根拠を記録。

**意図的に残した判定（65件）.**
- **hugeParam ×53**: `Decide(in Input)` 等の値渡しは純粋関数の意図的設計で、
  ポインタ化はシグネチャ・全呼出し・テストを巻き込む。単独 PR での判断が適切。
- **gocyclo ×12**: chooseForDevice、ResolveWithOrigins、run 系等の分解は
  振る舞いリスクを伴うリファクタ — 個別対応。

**残課題.** CI の Lint ジョブ自体が setup（Go バージョン固定）で壊れており、
債務の可視化には workflow 修正が別途必要。

*検証: go build ./...、go test ./...（全24 pkg green）、go vet クリーン、
golangci-lint 350→65 件（残りは hugeParam/gocyclo のみ）。*

## Session 296 — warn once per episode when a connected pool goes silent (re-delivers closed #396)

**Finding [OBSERVED — code-verified].** A pool that stops delivering jobs
while keeping the connection open starves revenue identically to extreme
difficulty — but with no rejects, no disconnect, and no metric edge. The
clock starts at session start so a pool that never sends a first job is
equally covered.

**Fix [OBSERVED].** `jobStallWarnAfter` (10 min, var for tests) — on each
stats tick, if `time.Since(lastJobAt) > jobStallWarnAfter` and not
curtailed, warn once per episode (`jobStarvedWarned`), re-arming when jobs
resume. Wired on both V1 and V2 paths.

**Tests [OBSERVED].** `TestRunSession_JobStallWarnsOnce` + V1 variant —
silent fake pool past the threshold logs exactly one warn.

## Session 304 — power-breakeven yield floor for arbitration (re-delivers closed #373)

**Finding [OBSERVED — code-verified].** `power_watts` and
`electricity_price_per_kwh` were metrics-only — below-breakeven mining could
only be stopped via a hand-computed `curtail_below_btc_usd`. This is the
constraint half of the bi-criteria bandit formulation (arXiv:2503.12285).

**Fix [OBSERVED].** `arbitrationLoopOpts.powerFloor()` derives a per-device
breakeven floor: powerWatts/1000 × price $/h → `provider.SatsPerSecond` →
split evenly across managed devices. The arbitration loop applies
`max(min_yield, floor)` each round — the constraint tracks BTC price moves
automatically. New metric `otedama_power_breakeven_floor_sats_per_second`
(0 when unconfigured). SPECIFICATION §3.1/§6 synced.

**Tests [OBSERVED].** `TestArbitrationLoopOpts_PowerFloor` (six invalid-input
cases + arithmetic + even-split) + `TestRunArbitrationLoop_PowerFloorIdlesDevice`.

## Session 464

Version-source drift fixed: the VERSION file reads
v3.0.0-alpha.1 and `make build` injects it via ldflags, but the
in-code default (used by plain `go build`/`go install`, which skip
ldflags) still said v3.0.0-alpha.0-dev — a `go install`-built binary
reported a stale version. Bumped the default to v3.0.0-alpha.1-dev
(keeps the -dev marker distinguishing unblessed builds) and aligned
the Makefile's missing-VERSION fallback the same way. Release
builds via goreleaser inject {{.Version}} correctly and were
unaffected.

## Session 523 — full linter sweep re-verified on master

Re-ran the full golangci-lint suite under `GOTOOLCHAIN=go1.26.8`
(go1.27.1's export data format is newer than golangci-lint v1.64.8's
typecheck can decode — run it with the pinned toolchain):

- **Bulk of findings = known lint backlog** already delivered by the
  open #526–#528 refactor family (misspell, hugeParam, gocyclo,
  errorlint, gofumpt, goconst, prealloc, unparam, dogsled).
- **`daemon/service.go:375` nilerr** — false positive on a documented
  contract: `statusWindowsService` treats sc.exe's non-zero exit as
  "not installed" by design (comment lines 367–371; matches
  statusLaunchd). No change.
- **`stratum/noise.go` `remoteStatic` unused** — already recorded as
  the CODEOWNERS-level noise*.go erratum; no change.
- **Two actionable test-hygiene items fixed**: dead `parseFloat`
  helper in `internal/rates/fetcher_test.go` and an unclosed response
  body in `internal/httpserver/server_test.go` (bodyclose).
- `govulncheck ./...` re-verified under go1.26.8: zero reachable
  vulnerabilities.

## Session 350 — remaining pool-text log sites

**V1 job ID in log lines [FIXED].** `job.JobID` (pool-controlled
`mining.notify` string) was logged with `%s` on both the curtailed-debug
and job-active lines — a pool could embed ANSI escapes or newlines to
forge log entries. Both sites now use `%q`, which escapes control
bytes and makes unusual content visible. The `applyJob` error paths
already used `%q` and were verified safe.

**Remaining pool-text audit [AUDITED — clean].** `engine: V1 submit:
%v` logs only transport/call errors (the pool's reject text travels in
`ShareResult.Reason`, covered by PR #461's sanitizer); `loc`/`host`/
`poolURL` log operands come from the operator's own pool configuration,
not the wire; V2 job lines log numeric JobID. No other unquoted
pool-derived strings reach the log.

## Session 416 — lint backlog follow-up: eliminate the entire hugeParam class [PERF]

Session 415 (PR #526) cleared ~350 lint findings down to 65 and deferred two
classes: 53 `hugeParam` (large structs passed by value, ≥80 bytes each copied
per call) and 12 `gocyclo` (functions needing real decomposition, not cosmetic
fixes). This session converts **all 53 hugeParam sites** — zero remain.

What changed (value → pointer params/receivers):

- `internal/arbitration`: `Stream.Accepts/YieldFor`, `Assignment.Idle`,
  `Decide(in *Input)`, `chooseForDevice`, `policyScore` — the arbitration hot
  path ran once per Decide tick copying 80–120-byte structs per call.
- `internal/miner`: `Header.Bytes`, `ParseHeader`, `HashHeader` — `HashHeader`
  is called once **per nonce** in the grind loop; the 80-byte Header copy per
  hash is eliminated (BenchmarkHashHeader: ~107ns/op, 0 allocs — unchanged
  correctness, the copy was the only overhead above SHA-256d itself).
- `internal/poolproto`: `DialURL` and the `Dialer` interface now take
  `*Credentials`; `sendJob` takes `*Job`; `rpcMessage.uintID` pointer receiver.
- `internal/doctor`: `DefaultChecks` + all 10 check funcs take `*config.Config`
  (200 bytes → 8 per call).
- `internal/config`: `Resolve(fromFile *Config, env, flags *FlagValues)`.
- `internal/engine`: `sessionOpts` receivers, `applyJob`, `setupWallet`,
  `startProviders`, `poolURLs`, `payoutAddresses`, `buildStats`,
  `disconnectedStats` (returns `*tui.Stats`).
- `internal/provider`, `internal/stratum` (`SetupConnection.Encode`,
  `ValidateSetupConnection`), `internal/tui` (`Stats` through the whole
  render pipeline).

Channel types (`jobsCh chan Job`, `updateCh chan Stats`, `quoteCh chan Quote`)
intentionally keep value semantics — pointers are taken at send/apply
boundaries only, avoiding aliasing across the producer/consumer handoff.

`Decide` also gained a nil-`Input` guard (a pointer API must not panic on nil).

Remaining deferred debt: the 12 `gocyclo` findings (cyclomatic complexity) —
those need decomposition refactors, not signature changes, and stay parked as
a separate judgement call.

*Evidence: `golangci-lint run` hugeParam count 53 → 0; `go vet` clean;
`go test ./...` all 24 packages green including `-race` on the engine suite.*

## Session 409 — SPECIFICATION validation-section drift [FIXED]

**Understated validation claims corrected [FIXED].**
- §3.3 claimed the payout-address checksum is "*not* verified here" —
  `validateBitcoinAddress` has called `btccrypto.ValidateAddress`
  (bech32/bech32m + Base58Check) at config load for a long time. Both
  §3.3 and the §3.1 rows corrected. The function's own godoc was stale
  in the same way (claimed checksums deferred to the lightning package
  while the body verified them) — rewrote to describe actual behaviour.
- §3.1 `tls_ca_file` row: "honoured only for `stratum+tls://`" — it is
  also honoured for `stratum+v2tls://` (engine loads the PEM for both
  TLS dial paths; unreadable → warn + system roots, never plaintext).
  Field godoc corrected too.

**Audited — clean:** §3.1 schema table covers every yaml key (pools
sub-fields url/user/password/payout_scheme/tls_ca_file, workers.name,
all scalar fields + env vars); §2.1 exit-code contract matches
exitUsage=64/exitConfig=78; payout_scheme enum validation matches;
config.yaml.example ranges match config.go checks; command table
matches main.go dispatch.

## Session 294 — warn once per episode on difficulty starvation (re-delivers closed #394)

**Finding [OBSERVED — code-verified].** A pool-assigned difficulty so high the
expected share interval exceeds an hour starves income silently — no rejects,
no disconnect, nothing credited. Operators can't distinguish it from a dead
pool.

**Fix [OBSERVED].** On each V1 stats tick, when `estimatedShareIntervalSeconds`
exceeds 3600 the engine logs a warn once per episode (`starvedWarned`),
re-arming when the interval recovers. Downward floods stay bounded by the
capped share channel (audit verdict, session-270 lineage).

**Tests [OBSERVED].** `TestRunSessionV1_StarvationWarnsOnce` — fake pool sets a
starving difficulty; exactly one warn fires across repeated ticks.

## Session 377 — build tooling audit

[FIXED] `make fuzz` silently ran zero fuzzers: `go list ./...` emits
import paths, so `grep -l "func Fuzz" {}/*.go` globbed a nonexistent
directory for every package and the loop body never ran. The target now
discovers fuzz tests from the filesystem and runs each
`Fuzz*` function individually (`-fuzz=^Name$`) — also fixing the
"matches more than one fuzz test" error that a package with multiple
fuzzers would hit. Verified live: both `internal/stratum` fuzzers ran
30s each (~4.8M execs, PASS).

[AUDITED — clean] Remaining Makefile targets checked for the same
class of bug (`docs`, `licenses`, `audit` sub-steps) — all correct.

## Session 426 — .gitignore: strip vestigial v2 sections [HYGIENE]

The ignore file still described the pre-reset repository, not this one —
eight sections covered trees that do not exist and per CLAUDE.md cannot
be created:

- `web/` Node.js section (node_modules, .next, …) — `web/` is on the
  forbidden-path list; advertising it here contradicts the architecture
  map.
- `scripts/` Python section — no scripts/ directory exists (the release
  workflow's deb/rpm job already fails on exactly this).
- Docs-site outputs (docs/.docusaurus, site/, .vuepress) — docs/ is plain
  Markdown; no SSG is wired.
- Lightning node files (channel.db, neutrino.db, lnd.conf, ldk-node/) —
  Otedama's `internal/lightning` is a BIP-39 seed vault, not an LDK/LND
  node; it writes none of these (wallet.dat is covered separately).
- Bitcoin Core data dirs (blocks/, chainstate/, peers.dat) — the miner
  talks to pools; no Core instance is embedded.
- docker-compose overrides — no compose file exists.
- "Legacy v2 cleanup artifacts" (fix_*.sh, remove_*.sh) — the reset
  already happened.
- Dead allowlist entries `!config.production.yaml` / `!SHA256SUMS.example`
  — neither file exists; release checksums are named
  `otedama_v*_checksums.txt`, so the SHA256SUMS glob was removed too.
- Mining caches (work-cache/, share-cache/, benchmark-results/) — no code
  writes these paths.

Kept: everything the codebase can actually produce (wallet.dat,
config.yaml, coverage, profiling output, release archives, the built
binary) plus generic editor/OS shields.

Sources for what does not exist: CLAUDE.md architecture map, the repo
tree itself, and .goreleaser.yaml's nfpms/archives file lists.

## Session 428 — audit-checklist/SUSTAINABILITY/BENCHMARKS verification claims [DOCS]

While auditing the last unvisited docs, three "verified" claims turned out
to describe controls that do not exist — the same verification-theatre
class as VERIFY.md's cosign section (session 407):

- `BENCHMARKS.md` asserted "a PR that regresses >5% fails automatically".
  Reality: the benchmark jobs only run `go test -bench` and upload an
  artifact; the "Performance Impact" job is a Node-only template whose
  every step skips in this Go repo. Reworded as regression-*visible*.
- Same file pointed reproduce instructions at `BenchmarkDecoder_ReadFrame`,
  which was never committed, and claimed the decoder "is fuzzed
  continuously in CI" — no fuzz job exists. `FuzzDecoder_ReadFrame` is
  real; the doc now says to run it locally.
- `AUDIT_CHECKLIST` item 11 recorded "Every `uses:` has @<40-char-sha>".
  Reality: all workflow `uses:` are tag refs, including
  `aquasecurity/trivy-action@master` — a moving branch ref, the exact
  shape of the TeamPCP attack SUSTAINABILITY §5 itself cites. Item 13's
  cosign verification was likewise aspirational. Both rows now show the
  gap instead of a false pass.
- `SUSTAINABILITY.md` 実装状況: §2 claimed SV1/SV2 implementation was
  v3.2.0 scope — both dialers already exist under `internal/poolproto/`.
  §5 claimed SHA pinning + cosign "実装済み" — neither is wired.

Sources: `.github/workflows/*.yml`, `internal/stratum/*_test.go`,
`internal/poolproto/`, go.mod.

## Session 429 — Makefile ターゲットの監査 [HYGIENE]

`Makefile` の残り未監査ターゲットを検証:

- `migrate-from-v2` ターゲットが「otedama migrate-from-v2 を実行せよ」と
  echo していた — そのサブコマンドは非実在（#513 が skills/、#523 が
  SECURITY.md の同種幻影を修正済み）。docs/MIGRATING-FROM-V2.md への
  誘導に置き換え。
- `security` ターゲットが gosec・govulncheck をガードなしで呼んでおり、
  未インストール環境では `make security` が即失敗。`audit` ターゲット
  自身が govulncheck/golangci-lint に使う「未導入なら install 手順を
  表示してスキップ」パターンに統一（`licenses` の go-licenses も同様）。
- Devin Review 指摘を受理: release ジョブが `artifacts/*/SHA256SUMS` を
  生成するため #426 の gitignore 整理で除去した `SHA256SUMS*` パターンは
  dead ではなかった — 復元（`artifacts/` 自体は ignore 対象外のため
  ローカル再現で trackable になる）。

Clean-verdict: `audit`（8 ステップ・30-item 表記は master の実数と一致）、
`fuzz`（Fuzz 関数を持つ pkg を動的列挙）、`docs`/`docs-serve`、
`deps-graph`、docker 系、ISSUE_TEMPLATE 両 yml、PR テンプレートは
全て実装と整合。

Sources: `Makefile`, `.github/workflows/ci.yml` (release job),
`.github/ISSUE_TEMPLATE/*.yml`, `git check-ignore`.

## Session 430 — i18n キー整合 + .claude 設定ファイル [HYGIENE]

- i18n 監査: 全10言語（en/ja/zh/ko/es/ru/ar/fr/de/pt）が同一15キーセット
  を完全保持 — multi-language ファイル内の言語別 map も個別検証。clean。
- `CODE_OF_CONDUCT.md`: 実在の Security Advisories URL を通報経路として
  記載 — clean。
- 実修正: 追跡されていた `.claude/settings.local.json` が v2 時代の
  ~100件の許可リスト（`internal/mining`・`internal/pool`・`internal/crypto`・
  `internal/database`・`internal/monitoring`・`internal/security`・
  `cmd/demo`・`cmd/improvements*`・`otedama_*.exe`・幻影スクリプト群・
  WSL `go.exe` パス・ethereum 依存取得コマンド — 全て非実在）を保持。
  settings.local.json は規約上マシンローカルのため untrack + gitignore。
- `skills/quality-pass-{opus,sonnet}.md`: 過去セッション修正の
  元帳として正確（各 G 項目は Fixed 済みの記録）、タスクキューも
  ブロック要因つきで正直 — clean。

Sources: `internal/i18n/messages/*.go`, `.claude/settings.local.json`,
`CODE_OF_CONDUCT.md`, `skills/quality-pass-*.md`.

## Session 431 — Dockerfile + PR 間コンフリクトマップ [HYGIENE]

- `Dockerfile` の `EXPOSE 0` を削除 — 0 は有効ポート宣言ではなく
  （Podman は build 時に "cannot expose 0" で拒否、Docker でも無意味な
  メタデータ）。`--http-addr` は静的に宣言できる固定ポートではないため
  EXPOSE 自体不要。
- `.dockerignore` を新設 — `COPY . .` が `.git/`・`wallet.dat`・
  `config.yaml`・ビルド成果物を build context として daemon に
  アップロードしていた（中間レイヤに秘密情報が残り得る + キャッシュ
  無効化）。イメージが必要とするのは go.mod/go.sum/LICENSE/NOTICE/
  cmd/internal のみ。
- open PR コンフリクトマップ（git merge-tree --write-tree）: 全ペアが
  CHANGELOG/RESEARCH_IMPROVEMENTS の EOF 追記で機械的衝突。実質衝突は
  lint 三部作 #526↔#527（doctor/checks・miner/sha256d・stratum/handshake・
  provider_test）、#527↔#528 と #526↔#528（arbitration/engine・
  engine/arbitrate・engine/run）、#526↔#529（lightning/wallet.go）。
  推奨マージ順: #526 → #527 → #528 → #529 → #530（後続ほど再基盤化が軽い）。
- Clean-verdict: i18n 10言語キー完全パリティ、CODE_OF_CONDUCT 通報経路実在、
  Dockerfile 残部（distroless nonroot・ldflags は正しい
  internal/version パッケージ — release.yml の `-X main.Version` バグとは別）。

Sources: `Dockerfile`, `.github/workflows/ci.yml` (release asset steps),
`git merge-tree --write-tree` 全ペア, `internal/i18n/messages/*.go`.

## Session 432 — ROADMAP のステータスドリフト [HYGIENE]

- `internal/engine/run.go` のコメントが「V2 poolproto ダイアラの
  Step 3b 完了待ち」を主張していたが、§3 は session 90–91 で RESOLVED・
  Step 3b も完了済み — `poolproto/stratumv2` ダイアラは既に存在する。
  実際の残件は「engine のセッションループへの V2 ダイアラ組込み」
  という別ギャップ — コメントを実態に訂正。
- `ROADMAP.md` v3.1.0/v3.2.0 のステータス欄を実装に整合:
  - 「engine → poolproto 統合（現状 raw TCP 直結）」→ V1 は DialURL
    経由で完了、V2 残件、と部分完了に訂正。
  - 「Stratum V1 互換の追加」→ 実装済み（stratumv1 ダイアラ +
    runSessionV1・TLS 対応）で完了マーク。
  - 「poolproto 抽象化レイヤ完全分離」→ パッケージ分離・両ダイアラ
    存在で部分完了、残件は V2 engine 配線 + DATUM。
- 検証済み正確な残存項目: Akash は依然 simulated quotes、DATUM は
  scheme 予約のみ（§14）、JDP 未実装、secp256k1 は P-256 スタブのまま
  （noise.go L96「v3.1.0 で置換予定」— ROADMAP v3.1 項と整合）。

Sources: `internal/engine/run.go`, `internal/poolproto/{,stratumv1,
stratumv2}/`, `docs/KNOWN_LIMITATIONS.md` §3, `ROADMAP.md`.

## Session 433 — CATEGORY_AUDIT バックログの再検証 [HYGIENE]

`docs/CATEGORY_AUDIT.md`（608行・最後の未精読ドキュメント）の
deferred/flagged 行を全件 master と再照合。3行が陳腐化:

- Windows `Status()`「unsupported platform」→ `statusWindowsService`
  が `sc.exe query Otedama` を parse して実装済み。
- `sc.exe binPath=` quoting 脆弱性 → `serviceArgv` カノニカル argv
  再設計で解消済み。
- `OpenMiningChannel.MaxTargetNBits`「spec 確認待ち」→ spec 照合済み・
  意図的非実装（プール割当 target を受理するため dead config）として
  文書化・フィールド削除済み。
- DATUM「現在形でサポートと誤記・未開示」→ poolproto/stratumv1 とも
  "is planned" 表記に訂正済み + KNOWN_LIMITATIONS §14 で開示済み。

検証済み引き続き正確な項目: secp256k1 は ErrSchemeNotImplemented
スタブのまま、Noise 4フラグ（非 atomic n・exhaustion guard なし・
x-only fallback・custom hmacSHA256）は全て CODEOWNERS 判断待ちのまま、
hmacSHA256Pooled は設計どおり未配線、maskAddress/stripScheme 二重化・
did-you-mean 未実装は現状のまま。

これで docs/ 配下の全ファイル精読・実装照合が完結。

## Session 435 — エコシステム追跡 + 監査残件の最終検証 [AUDIT]

- CATEGORY_AUDIT `DispatchFrame` 行が陳腐: decode error は
  `poolMsg.err` → `engine: pool read` でセッション死亡・再接続
  （fail-fast — 提案 debug ログより厳格）。unknown 型のみ Unknown
  へルーティングされ許容。行を解決済みに更新。
- ESP-Miner v2.14.0b4 調査（SV2 submit 改善の上流参照元）:
  `TCP_NODELAY` 設定は Go では `net.TCPConn` デフォルト true のため
  Otedama では不要（lwIP/ESP32 固有の修正）。dial timeout 不在は
  open の #457/#483 が担当済み、KeepAlive は Go デフォルト有効
  （15s）。ESPM の SV2 実装マージ（Noise_NX + libsecp256k1）は
  Otedama の Noise NX 方向を裏付け。per-share RTT 計測は候補として
  記録（seq→時刻相関の配線が必要）。
- SRI v1.12.0 (2026-09-17) 引き続き最新 — ChaChaPoly 整合維持。

これで CATEGORY_AUDIT の actionable backlog はメンテナ判断待ち項目
（CODEOWNERS Noise 4項・secp256k1 依存判断・依存追加を要する TUI
width・Issue #2/#3 統合・workflow 群）のみ残存 — 一方的実装可能な
項目は枯渇。

## Session 436 — share-RTT 計測は実装済みと検証 [AUDIT]

ESP-Miner v2.14.0b4 の "Measure SV2 share response time per-share"
(#1720) を Otedama へ輸入する検討 → **実装済みと確認**: `submitTimes`
(seq→送信時刻, submitTimesCap=1024 有界) が `SubmitSharesSuccess.
LastSequenceNumber` でバッチ settle し `latency.Record`（256窓の
quantile 追跡）→ `otedama_submit_latency_milliseconds` ゲージで
公開。上流実装より厳密（未 ack map に上限 + in-flight 深度ゲージも
別途存在）。検証のみ、コード変更なし。

残る輸入候補は全て判断待ち or 非適用: TCP_NODELAY は Go デフォルト
true（lwIP 固有の修正）、dial timeout は open #457/#483 が担当、
hashtrate counter overflow は ESP32 ファームウェア固有。

## Session 368/369 — wallet KDF + address-parser fuzz + dep freshness

**Audited clean.** wallet.dat scrypt params are compile-time constants
(N=1<<17, r=8, p=1) — a tampered wallet file cannot request a
memory-exhausting KDF; decrypt path is bounded and checksum-gated.
V1 TLS dialer verified: MinVersion TLS 1.2, no InsecureSkipVerify,
extra-CA PEM merge preserves verification.

**Coverage [FIXED].** `FuzzValidateAddress` + direct bech32/base58
drives the payout-address parsers with operator-supplied strings
(1.4M execs clean): no panic, and a nil error always implies a
checksum-verified structure.

**Observed [OBSERVED — deferred].** `golang.org/x/crypto` is pinned at
v0.23.0 vs latest v0.57.0 and `x/sys`/`x/term`/`x/text` are similarly
behind; `govulncheck` shows zero reachable vulns (s362), and a bump
raises the go.mod `go` directive, colliding with CI's pinned Go —
deferred until the toolchain pin is resolved. yaml.v3 migration is
already tracked on #444.

## Session 376 — audit-checklist row verification (continued)

[AUDITED — clean] i18n completeness is test-enforced:
`TestAllLanguages_CoverAllEnglishIDs` asserts `MissingTranslations()`
is empty for the full built-in bundle, so a dropped catalog entry is a
CI failure, not a silent fallback.

[AUDITED — clean] Checklist rows verified true: #14 (go.mod contains
only `x/crypto` + `yaml.v3` + stdlib), #7 (test:impl line ratio 1.74
≥ 1.0), doctor count (17 checks = CLAUDE.md claim), ADR-001..011 all
present, SECURITY.md + CODE_OF_CONDUCT.md present.

[FIXED] `.goreleaser.yaml` release header referenced a nonexistent
`docs/verify-release.md` (dead link in every future release note) and
named the checksums file `checksums.txt` while the configured
`checksum.name_template` emits `otedama_<ver>_checksums.txt`. Both
corrected; the link is now an absolute URL to DEPLOYMENT.md (relative
links in release bodies do not resolve to repo files).

## Session 418 — close KNOWN_LIMITATIONS §16: the `wallet` subcommand [FEATURE]

The last open CLI-facing limitation: no way to verify a written-down
recovery phrase or rotate the wallet passphrase without starting the engine.
The limitation entry itself prescribed the minimal fix — this session
implements exactly it.

New `otedama wallet` subcommand (`cmd/otedama/wallet.go`):

- `otedama wallet verify` — reads a recovery phrase from **stdin** (never
  argv: `ps aux` exposes it to every local process), validates the BIP-39
  checksum via `MnemonicToEntropy`, derives the seed with
  `MnemonicToSeed`, and compares its public `Fingerprint` against the
  stored `wallet.fingerprint` file. `wallet.dat` is never decrypted, so a
  wallet passphrase is not required; the `OTEDAMA_WALLET_MNEMONIC_PASSPHRASE`
  env var covers wallets created with a BIP-39 "25th word". When the
  fingerprint file is absent (older builds), verify falls back to unlocking
  `wallet.dat` with `OTEDAMA_WALLET_PASSPHRASE`.
- `otedama wallet change-passphrase` — wires the already-implemented,
  already-tested `WalletManager.ChangePassphrase` to the CLI. Both
  passphrases come from env vars (`OTEDAMA_WALLET_PASSPHRASE` /
  `OTEDAMA_WALLET_NEW_PASSPHRASE`), matching the argv-leak guidance added
  in session 372.

Safety details: both verbs stat `wallet.dat` before calling
`NewWalletManager` (whose contract is "create when absent"), so a mistyped
`--data-dir` can never silently mint an empty wallet. The wallet directory
resolves through the same four-layer precedence as `run`
(`--data-dir` > `OTEDAMA_DATA_DIR` > `config.yaml` > platform default).
New minimal exports `lightning.WalletFilePath` / `FingerprintFilePath`
expose the on-disk names without leaking internals. `internal/lightning`
is funds-adjacent — CODEOWNERS review applies (disclosed in the PR).

*Evidence: 9 new cmd tests cover match/mismatch/invalid-phrase/no-wallet/
no-create/fallback-decrypt/env-required paths; `go test ./...` all 24
packages green; lint introduces zero new findings.*

## Session 335 — transition-reject fix re-delivered (from closed #367)

**Benign retarget rejects [PORTED].** `miner.Share.Target` carries the
issue-time share target; `transitionReject` classifies a difficulty
reject as `difficulty-transition` only when the share was issued under
a different, since-replaced target. V1 compares captured vs current
suggested difficulty; V2 tracks `submitTargets` (SequenceNumber →
issue target, same 1024 cap/reap as submitTimes). Benign rejects skip
reject_rate/sharesRejected/last_reject_seconds and log at info; the
rejectByReason map race fix (rejectByReasonMu + rejectReasonValue)
came along. Verified `-race` clean on the ported tests.

## Session 336 — pool show_message delivery re-delivered (from closed #405/#424)

**client.show_message [PORTED].** The V1 session parsed operator
notices into `PoolNotices()` (buffered 8, drop-oldest) but master had
no consumer. `runSessionV1` now type-asserts `poolproto.PoolNoticeReceiver`
and forwards each notice to `opts.log("info", …)`. slog's TextHandler
writes values verbatim, so a hostile/MitM pool could inject ANSI
sequences or newlines into a terminal — noted as accepted residual
(also true of every other logged field); escapes are not stripped
because slog output is already conventionally machine-consumed.
**TUI injection surface [AUDITED — clean].** Dashboard renders only
user-configured `PoolURL` (scheme-validated), engine-computed
fingerprints, and internal provider names — no pool-supplied string
reaches `internal/tui`.

## Session 353 — poolproto V2 dialer handshake-error quoting

**Handshake-error injection on the dialer path [FIXED].** The engine's
inline `handshake()` was fixed in session 351, but the
`poolproto/stratumv2` `Negotiate` implementation has its own
independent handshake that embedded both `SetupConnectionError.Error`
and `OpenMiningChannelError.Error` raw (`%s`) into
`ErrHandshakeFailed`-wrapped errors — logged via `session ended: %v`.
Both now `%q`-quote the pool string. All three STR0_255 error strings
(SetupConnectionError, OpenMiningChannelError, SubmitSharesError) are
now covered across both code paths: the handshake pair quoted here,
share-reject reasons sanitized by PR #461.

**Noise transport bounds [AUDITED — clean].** `EncryptedConn.Read`
reads a u16 length prefix — inherently ≤ 65535, so no allocation bound
is needed. `HandshakeState.ReadMessage2` guards every slice by length
before parsing.

## Session 405 — release-config drift fixed [FIXED]

**`.goreleaser.yaml` referenced two paths that don't exist [FIXED].**

- Archive `files:` glob `docs/locales/*.toml` — no such directory;
  the i18n catalog lives as Go source in `internal/i18n/messages/`
  (compile-time strings, not runtime-loaded .toml). The glob silently
  matched nothing on every release. Removed from the archive list.
- Release `header:` linked `[docs/verify-release.md]` — the actual
  file is `VERIFY.md` at the repo root. Every published GitHub release
  would have shipped a dead link in its body. Corrected.

**Verified consistent while here:** doctor exposes exactly the 17
parallel health checks CLAUDE.md claims; `otedama completion`
bash/zsh/fish scripts enumerate only real subcommands and sub-verbs
(config show/validate, service install/uninstall/status); API.md's
`/healthz` `/readyz` `/metrics` `/` table matches `httpserver`'s mux;
DEPLOYMENT.md's systemd unit fields (Type=simple, Restart=on-failure,
RestartSec=10s, hardening directives) match `daemon/service.go`'s
generated unit; solo-operations.md's goreleaser excerpt is illustrative
and its cosign/SBOM steps do exist (superset in the real file).

## Session 372 — argv secret hygiene + residual audits

**[FIXED] argv passphrase warning.** `--wallet-passphrase` /
`--wallet-mnemonic-passphrase` place the wallet passphrase in the
process list (`/proc/<pid>/cmdline`, `ps aux`) — readable by every
process on the host. Docs already prefer the OTEDAMA_WALLET_*_ env
vars (THREAT_MODEL §Information-disclosure); `run` now emits a stderr
warning when either flag is explicitly given (fs.Visit tracking), so
the guidance reaches operators who never read the docs. The env-var
path and `config show`/`validate` do not warn.

**Audited clean.** curtailment gate (stale/failed price holds last
trusted state — never curtails or resumes on untrusted data);
TargetFromNBits (negative mantissa / exp<3 / zero mantissa / >256-bit
overflow all rejected); hashrateWindow / uptime / sats accountants
(dt≤0, counter reset, productive gating all guarded); SV2
SetNewPrevHash future-job activation (unknown job → workers paused).

## Session 381 — re-delivery of #484 (argv secret hygiene)

[FIXED — re-delivery] Cherry-picked closed-unmerged #484 (session 372)
unchanged onto current master: `--wallet-passphrase` /
`--wallet-mnemonic-passphrase` on argv now emit a stderr warning
(fs.Visit-tracked, so env/config paths stay silent) pointing at the
OTEDAMA_WALLET_*_PASSPHRASE environment variables — argv is world-
readable via /proc/<pid>/cmdline. The session-372 audit verdicts
(curtailment gate, TargetFromNBits edges, stats accountants, SV2
SetNewPrevHash pause) arrive with it.

## Session 393 — non-loopback HTTP listener warning

[FIXED — session 393] **`--http-addr` non-loopback warning** (`cmd/otedama/run.go`): a metrics listener bound to `0.0.0.0`/`::`/LAN addresses (share counts, hashrate telemetry, `/healthz` presence) exposed itself silently — only a pprof-enabled bind was ever flagged (open PR #453). `startHTTPServer` now warns on stderr for any non-loopback bind, and names pprof profile exposure explicitly when `--pprof` is on. Supersedes #453's narrower warning (identical `isLoopbackAddr` helper, wider trigger). Tests: address table (v4/v6/hostname/bare/empty), warn-on-0.0.0.0 with and without pprof, silent-on-loopback.

[AUDITED — clean] Ecosystem re-check: SRI v1.12.0 (2026-09-17) remains latest — AES-256-GCM drop, codec refactor, BIP323 adaptations confirmed unchanged since session 388; sv2-apps v0.4.0. Coverage sweep of low spots: `config.DefaultDataDir` (platform branches), `miner.HasWork` (trivial exported getter), `doctor.checkHardware` (sysfs/darwin-limited) — all verified benign or already covered by open PRs (#501 for `lightning save()`).

## Session 385 — TUI terminal-width auto-detection

[FETCHED] Ecosystem re-check: SRI v1.12.0 (2026-09-17) and ESP-Miner v2.15.3 (2026-09-20) remain latest — no drift since session 383. ESP-Miner 2.15.2/3 changes are firmware UX (AxeOS embedding, BM1372/73 support, WiFi reconnect storms) — nothing touching the stratum protocol surface Otedama speaks.

[FIXED] **TUI rendered at a fixed 80 columns; the real terminal width was never detected** (`internal/tui`, `docs/KNOWN_LIMITATIONS.md` §15 → RESOLVED). `Dashboard.SetWidth` existed as an injection seam but no production caller used it, so every real run rendered 80 columns regardless of terminal size — on a narrower terminal each frame wrapped a row and broke the overwrite-in-place repaint model. The render loop now queries the kernel each tick: `unix.IoctlGetWinsize(fd, TIOCGWINSZ)` on Unix builds, `windows.GetConsoleScreenBufferInfo` on Windows, stub on other platforms. Per-tick querying also picks up resizes without a SIGWINCH handler. Non-terminal writers (pipes, test buffers), failed queries, and degenerate widths (<40) keep the previous value; `SetWidth` pins a width and disables detection. `golang.org/x/sys` promoted indirect→direct with rationale comment in go.mod (per CLAUDE.md dependency policy: BSD license, Go-team maintained, already in the graph via x/crypto — zero new modules).

[AUDITED — clean] Closing the loop on the remaining unaudited leaf packages: `internal/logger` (atomic default pointer, nil-safe SetDefault, conservative ParseLevel), `internal/clock` (Fake/System trivial), `internal/version` (ldflags vars only), `internal/i18n` `DetectLang`/`DetectLangFromEnv` (fail-safe English fallback, POSIX precedence order), `cmd/otedama` flag parsing (help-vs-error routing, `--` handling), env-var binding (`EnvWarnings` for malformed numerics + enum validation), engine failover ordering (pool-first, address rotation only while never-connected, capped backoff, masked addresses in logs), `maskAddr` short-string safety. Every package under `internal/` + `cmd/` now has at least one recorded audit verdict across sessions.

[FIXED — session 385, second commit] **Probabilistic flake in `TestSetupWallet_MnemonicNeverReachesLogger`** (`internal/engine/run_test.go`): the whole-word leak scan ran against every captured log line including the two constant wallet-setup messages that already contain BIP-39 vocabulary ("recovery phrase", "wallet", "created") — a random 24-word draw colliding with that prose false-positived. The scan now strips the known-static lines and checks only dynamic log content; a real leak still trips it. Re-delivers the applicable half of closed #371 (its `atomic.Bool` half targeted `responsivePool` fields that exist only on the in-flight #447 branch — applied there directly as a follow-up commit instead).

## Session 351 — handshake-error sanitization + surfaced channel rejections

**SetupConnectionError injection [FIXED].** The pool's error string was
concatenated raw into `fatalError` and logged via `session ended: %v` —
the same escape/newline injection class as the reject reasons. Now
`%q`-quoted, which escapes control bytes. The same treatment was
applied to `OpenMiningChannelError`: its reason string was previously
dropped entirely ("channel open failed" with no detail) — it now
surfaces the pool's reason, quoted, and classifies the rejection as
fatal (consistent with a refused setup — failover to the next pool
rather than a same-pool retry).

## Session 295 — publish V2 share-target difficulty + starvation warn (re-delivers closed #395)

**Finding [OBSERVED — code-verified].** `publishDifficulty` ran only in the
V1 stats tick: V2 sessions never updated `otedama_pool_difficulty` and never
emitted the starvation warn — the V1/V2 observability paths were asymmetric.

**Fix [OBSERVED].** `miner.DifficultyFromTarget` converts the V2 share target
(a raw U256 from OpenMiningChannelSuccess/SetTarget) into a Stratum
difficulty (diff1Target / target; zero target → +Inf). The V2 stats tick
publishes it and runs the same >3600s starvation tripwire as V1.

**Tests [OBSERVED].** `DifficultyFromTarget` unit table (diff1 → 1.0,
halving, zero → +Inf); V2 stats tick publishes; warn fires once per episode.

## Session 390 — wallet temp-file sweep + save() failure-path tests

[FIXED — session 390] **Stale wallet temp files swept at startup** (`internal/lightning/wallet.go`): `save()`'s atomic write (CreateTemp → write → fsync → chmod → rename) leaves a `.wallet-*.tmp` file behind if the process is killed mid-write or a late step fails. Nothing ever removed them, so every failed save accumulated a permanent ciphertext fragment in the data dir — confusing operators and backup tooling. `sweepStaleTempFiles` runs once in `NewWalletManager` after `MkdirAll` and removes only files older than `staleTempMaxAge` (1 min): a live save holds its tmp for milliseconds, so the age gate both guarantees the file is abandoned and prevents unlinking a temp file mid-write in a second process sharing the data dir. Best-effort — a sweep error never blocks startup. Changes in `internal/lightning` are CODEOWNERS-reviewed per repo policy.

[FIXED — session 390] **save() failure-path coverage**: three tests — stale/fresh/decoy sweep behavior, encrypt-failure leaves zero temp files (`failAfterNReader` exhausting after the 32-byte entropy read), read-only data dir propagates a wrapped CreateTemp error. Lightning package coverage improves at the lowest-covered function (save 62%).

[AUDITED — clean] Coverage sweep: every package sits at 92–99% (above the 90% bar); zero TODO/FIXME/XXX/`unsafe` in non-test code; benchmarks exist on all hot paths (miner grind, sha256d, metrics write, noise HMAC, clock, version). Japanese-source scan this week: no new Qiita/Zenn mining-ops posts relevant to Otedama's stratum layer.

## Session 320 — live network-hashrate feed (re-delivers closed #378/#415)

**Finding [OBSERVED — fetched live].** The mining-yield estimate consumed
a compile-time network-hashrate constant (1e21 H/s). mempool.space and
blockchain.info both expose live difficulty/hashrate endpoints — fetched
and shape-verified live, the two agree (~930 EH/s vs the stale 1e21
constant). Closes KNOWN_LIMITATIONS §7's deferred "live difficulty
feed".

**Fix [OBSERVED].** `rates.HashrateFetcher` polls both endpoints, takes
the median inside a plausibility band, and replaces the constant via
`MiningProvider.NetworkHashrateFunc`. Stale/unwired falls back to the
constant, so offline start is unaffected.

**Tests [OBSERVED].** rates + provider + engine suites green.

## Session 379 — reconnect-loop + docs/config-surface audit

[FIXED] `runReconnectLoop` never reset its exponential backoff after a
successful session: `backoff` doubled on every failure and was capped at
64s, but a session that connected, mined for hours, then dropped still
waited out whatever the backoff had grown to from earlier failed hops.
`connectedThisAttempt` (set from `onConnected`) now resets it to
`reconnectBackoffInitial`, placed before the failover branches and log
lines so both the immediate-retry path and the "reconnecting in %v"
message report the post-reset delay. New `dropAfterHandshakePool` fake +
`TestRunReconnectLoop_BackoffResetsAfterConnectedSession` verify the
delay stays at 1s across repeated established-then-dropped sessions.

[AUDITED — clean] `config.yaml.example` documents every Config field
(all 17 yaml keys incl. pool sub-fields `tls_ca_file`, `payout_scheme`);
Dockerfile is minimal (distroless nonroot, CGO_ENABLED=0, -trimpath,
ldflags version injection, /LICENSE + /NOTICE copied, VOLUME /var/lib/
otedama matching docs/DEPLOYMENT.md, EXPOSE 0); cmd wrappers
(version/completion/doctor/main/service) are thin and correct.

## Session 399 — cross-worker nonce-space partition

**Duplicate grinding across devices [FIXED].** Every `miner.Worker`
started each thread at `nonce = threadID` with `NonceStep = Threads` —
on a multi-device rig, N workers hashing the same job ran identical
nonce sequences, so every device but the fastest duplicated work already
done by a sibling and earned "duplicate" rejects for it. V1 offers no
rescue: `Share` carries no extranonce2, so submissions also collided at
en2 = "00…0".

`WorkerConfig` gains `NonceOffset`; `startMinerWorkers` now assigns
worker i an offset of `i*Threads` and a shared `NonceStep` of
next-pow2(threads × workers). Because the stride is a power of two
dividing 2^32, each (worker, thread) pair owns a residue class for the
job's whole lifetime — including through u32 wraparound — with zero
allocation change on the hot loop. `TestWorker_NoncePartitionAcrossWorkers`
proves the parity partition end-to-end; miner + engine suites race-clean.

## Session 462

TUI column-layout bug fixed: three line builders padded fields with
fmt's %-Ns, which pads by rune count — but the padded values carry ANSI
colour escapes (~9 bytes), so the padding never reached the intended
visible column and the following column drifted left by the escape
length (pool status, device-count field, earnings "est." column).
Added padToVisibleWidth (pads to visibleLen) and switched the three
escaped-field sites to it; tests pin the status column position. This
is distinct from open #497 (which detects the real terminal width) —
that PR tells the dashboard the width; this fix makes it lay out
correctly at whatever width it has.

## Session 318 — honor pool-requested reconnect wait (re-delivers closed #388/#413)

**Finding [OBSERVED — code-verified].** `client.reconnect`/
`mining.reconnect` `wait_seconds` was parsed and recorded but never
applied — a dead write; pools asking for drain time before reconnect got
an immediate re-dial.

**Fix [OBSERVED].** New `poolproto.ReconnectWaiter` interface + V1
`ReconnectWait()` clamped to [0, 300 s]; `runSessionV1` waits
ctx-cancellably before erroring out to the reconnect loop. Host:Port
still deliberately not followed (redirect defence).

**Tests [OBSERVED].** Session-close + wait-clamp cases green.

## Session 512 — hal.Identity.Validate whitespace coverage + miner/hal complete

**Bug (doc-vs-impl contract).** `hal.Identity.Validate` documented "no
whitespace" for IDs but only rejected `' '`, `'\t'`, `'\n'` — `'\r'`,
`'\v'`, `'\f'`, and all non-ASCII whitespace (U+00A0, U+2000–U+200A,
U+3000, …) passed. Fixed with `unicode.IsSpace`; the ID is echoed into
log lines (`Identity.String`) and used as a metrics device label, where
whitespace/control characters corrupt output or split label values.
Regression cases added for `\r`, `\v`, `\f`, and U+00A0.

**Audit milestones.** `internal/miner` and `internal/hal` are now read
end-to-end. `sha256d.go`: nBits decode rejects negative-mantissa bit,
exp<3, zero mantissa, and >256-bit targets; `TargetFromDifficulty`
rejects NaN/≤0/±Inf and uses 256-bit big.Float division; share target
and hash share one little-endian layout so `LessOrEqual` is direct.
`worker.go` grind tail: non-blocking share send with drop counter,
atomic counters — clean; the only residual is the nonce-wrap/ntime-roll
item owned by open PR #482. `hal`: Registry is RWMutex-guarded with a
sorted snapshot; Detect fans out per-driver goroutines on a buffered
results channel (no leak on ctx cancel), validates every returned
Identity, and returns partial results + ctx.Err on cancel — clean.

**Sources:** repo code only (audit session).

## Session 394 — bounded --log-file growth

[FIXED — session 394] **Log-file rotation** (`cmd/otedama/logfile.go`): `--log-file` was an unbounded `O_APPEND` writer — a miner left running for months grew its audit log without limit, and no rotation existed (not in KNOWN_LIMITATIONS either). `cappedLogFile` rotates at 32 MiB to a single `path.old` backup (total ≤ ~64 MiB), preserves the 0600 mode, appends across restarts, and on a failed rotate falls back to the existing file rather than dropping writes. Tests: rotation at cap, total-disk bound, single-backup invariant, append-reopen, mode 0600 — race clean.

[AUDITED — clean] Remaining low-coverage spots verified benign: `config.DefaultDataDir` (per-OS branches), `miner.HasWork` (trivial exported getter), `doctor.checkHardware` (Linux sysfs path is darwin-skipped), `lightning save()` (covered by open #501).

## Session 321 — count pool-reported batch accepts (re-delivers closed #386/#400/#410)

**Finding [OBSERVED — code-verified].** `SubmitSharesSuccess` credited
`shares_accepted` by +1 per message, ignoring the pool-reported
`NewSubmitsAccepted` batch count — on batching pools the acceptance rate
drifted low.

**Fix [OBSERVED].** `shares_accepted` now credits
`NewSubmitsAccepted` (pool-reported batch count) instead of +1 per
message.

**Tests [OBSERVED].** Engine suite green; batch-accept cases added.

## Session 322 — classify canonical SV2 reject codes (re-delivers closed #387/#399/#409)

**Finding [OBSERVED — code-verified].** `rejectClass` handled standard
`SubmitSharesError` codes via substring heuristics only:
`invalid-job-id`/`invalid-channel-id` landed in `hardware` when they are
stale-class; `difficulty-too-low` fell to `other` instead of
`difficulty`.

**Fix [OBSERVED].** Canonical codes are now classified explicitly before
substring heuristics.

**Tests [OBSERVED].** `TestRejectClass` canonical 9-case table green.

## Session 370 — nonce-space exhaustion (ntime roll)

**[FIXED]** `miner.Worker.grind` wrapped `nonce` past 2^32 with no
compensation: once a thread finished its stride slice it silently
re-hashed identical (header, nonce) pairs for the rest of the job —
wasted power plus *duplicate* shares the pool rejects. Now each wrap
increments `ntimeRoll` and rolls `Header.Time` forward (standard stratum
ntime roll; V1 submit and SV2 `SubmitSharesStandard.ntime` both carry
`Share.NTime` so the rolled value is what the pool sees; forward rolls
stay ≥ SV2 `min_ntime`). Verified by `TestWorker_NonceWrapRollsNTime`
(`NonceStep=2^31` forces a wrap every other iteration).

**Audited clean.** Share→submit ntime plumbing (`run.go` 934/1132,
`stratumv1.go` `%08x`) propagates the rolled value on both protocols.

## Session 335 — transition-reject fix re-delivered (from closed #367)

**Benign retarget rejects [PORTED].** `miner.Share.Target` carries the
issue-time share target; `transitionReject` classifies a difficulty
reject as `difficulty-transition` only when the share was issued under
a different, since-replaced target. V1 compares captured vs current
suggested difficulty; V2 tracks `submitTargets` (SequenceNumber →
issue target, same 1024 cap/reap as submitTimes). Benign rejects skip
reject_rate/sharesRejected/last_reject_seconds and log at info; the
rejectByReason map race fix (rejectByReasonMu + rejectReasonValue)
came along. Verified `-race` clean on the ported tests.

## Session 361 — config NaN/±Inf rejection

**Non-finite float fields passed Validate [FIXED].** Every float range
check used `x < 0`/`x >= 1.0` — both false for NaN, so
`arbitration_hysteresis_pct: .nan` in config.yaml or
`OTEDAMA_...=NaN` via env validated cleanly and poisoned the
arbitration math downstream. An explicit `math.IsNaN ||
math.IsInf` sweep now rejects non-finite values on all five float
fields (`arbitration_hysteresis_pct`, `curtail_below_btc_usd`,
`min_yield_sats_per_sec`, `power_watts`,
`electricity_price_per_kwh`). Table-driven test covers NaN, +Inf,
-Inf on each field.

## Session 380 — stratum encode-side + stats-math audit; ecosystem re-check

[FIXED — re-delivery] Cherry-picked closed-unmerged #473 (session 361):
`Config.Validate` rejected non-finite floats only via `x < 0` / `x >= 1`
comparisons — all false for NaN — so `.nan`/`NaN`/`Inf` config values
flowed into arbitration math. Now explicit `IsNaN`/`IsInf` rejection on
all five float fields; table-driven tests cover NaN/+Inf/−Inf each.

[AUDITED — clean] Stratum encode side (fuzz covers the decode side):
`appendStr0_255`/`appendB0_255`/`appendB0_32` all bound the length-prefix
payload and every caller propagates the error; `WrapMessage`/`EncodeFrame`
validate the U24 MsgLength bound. stats.go divisions are all guarded:
hashrateWindow (`dt>0`, counter-reset safe), acceptanceRate (0/0→1.0),
effectiveYield (`uptime<=0`→0, fraction clamped [0,1]), publishDifficulty
(`diff<=0` no-op, `hashrate<=0`→0). Noise internals re-read end-to-end:
the `ReadMessage2` x-only fallback's secret-less completion is a real
structural gap but already documented verbatim in KNOWN_LIMITATIONS §2
item 3 (alpha stub, zero callers outside tests — left for the v3.1.0
full-message-flow rework rather than churned now). `stratum/tls.go`
dialer verified: TLS1.2+, system roots + optional extra CAs, handshake
performed before return, never falls back to plaintext. `setup.go`
wiring clean (worker-per-device, provider Start errors non-fatal,
mnemonic printed only to opts.Output pre-TUI).

[FETCHED] Ecosystem unchanged since s375 re-check: SRI v1.12.0 (2026-09-17)
remains latest (noise_sv2 AES-256-GCM removal is server-side; Otedama
implements only the ChaChaPoly half already); ESP-Miner v2.15.3
prerelease (2026-09-20) is preset-scoped frequency warnings only — no
stratum changes. Go advisories: go1.26.8 toolchain still clears the
Sept advisories.

## Session 325 — non-finite yield collapse in the arbitration engine

**Finding [OBSERVED — code-verified].** `Yield.Effective()`'s `<= 0`
guards pass NaN through (NaN <= 0 is false): a provider division
yielding 0/0 upstream produces a NaN candidate that enters the policy
sort and contaminates `TotalYield` — silently corrupting every
downstream sat/day figure.

**Fix [OBSERVED].** `Effective` now collapses any non-finite product
(NaN or ±Inf, from either field) to 0 — a bad quote can never win the
sort or poison the total.

**Tests [OBSERVED].** Five new table cases (NaN/±Inf on both fields).

## Session 338 — set_extranonce race fix + V1 method-surface audit

**set_extranonce data race [FIXED].** `mining.set_extranonce` (read
goroutine) replaced `extranonce1`/`extranonce2Size` while `Submit`
(caller goroutine) read them — plain fields, a real race whenever a
pool rotated extranonce mid-session. Both now atomic
(`atomic.Pointer[string]` / `atomic.Int64`); a concurrent dispatch+load
test locks the fix in. Benign-read note: today's V1 path leaves
`MerkleRoot` to the pool (poolproto.Job comment), so rotation stales
no in-flight work; a future en1-dependent coinbase path (open #417)
must additionally flush queued jobs on rotation.
**V1 method coverage [AUDITED — clean].** Handled: mining.notify,
set_difficulty, set_extranonce, client.show_message,
client.reconnect/mining.reconnect. mining.set_version_mask and other
extensions are deliberately ignored (forward-compatible). Requests
with an id are never sent pool→client by conforming pools; unknown
methods are dropped without reply.

## Session 383 — SV2 nominal_hashrate seeding

[FETCHED] Ecosystem re-check: SRI v1.12.0 line and ESP-Miner v2.15.x line unchanged this round; no new upstream protocol changes to absorb.

[FIXED] **engine `handshake` declared `nominal_hashrate ≈ 0`** (`internal/engine/run.go`, `setup.go`): the value was summed from `w.Stats().HashRate`, which is always ~0 at handshake time because no job has been hashed yet. Pools use `nominal_hashrate` to seed variable difficulty, so a 0 declaration mis-seeds vardiff for real hardware. Fix: compute a capability-based nominal estimate in `Run` (per-worker sum of `provider.DefaultHashrates` over each worker's device family, via `nominalMiningHashrate`), thread it through `reconnectOpts`/`sessionOpts`, and declare it whenever the live rate is non-positive. On reconnect the live rate wins, reflecting sustained throughput. Tests: `TestHandshake_DeclaresNominalHashrateWhenWorkersCold` (net.Pipe server asserts the declared float) and `TestNominalMiningHashrate`.

[AUDITED — clean] SV2 `DispatchFrame` (messages.go:406-483): every known msg type decodes or errors (error → session drop → reconnect); unknown types become `UnknownMessage` and are ignored; the 16 MiB frame cap is enforced in `ReadFrame` before allocation.

## Session 374 — config-layer pool URL validation hardening

[AUDITED — clean] `config show`/`config validate` output: passphrases are
flag/env-only (never stored in Config), and pool URLs carry no credentials,
so no secret can leak through the config-inspection path. `configfile.go`
is read-only (os.Open; no write path).

[FIXED] `validatePoolURL` accepted any non-empty string after a recognised
scheme — `stratum+tcp://pool` (no port; dialer always fails since no
default port exists), `:99999` out-of-range ports, `user:pass@host`
userinfo, `host:3333/path` trailing paths all passed `config validate`
and failed only at first dial. Now the remainder must parse as
`host:port` via `net.SplitHostPort` with a numeric port in 1-65535 and
no userinfo/path/whitespace. Pools are config-file-only (no env/flag
path), so the one validation site covers the entire surface.

## Session 310 — validate SubmitSharesSuccess.LastSequenceNumber before crediting (re-delivers closed #403)

**Finding [OBSERVED — code-verified].** SV2 `SubmitSharesSuccess` was
credited without checking `LastSequenceNumber` — a bogus success frame
with an unsent seq inflated the acceptance rate and settled latency
stats it never earned (mirror of the reject-side fix, session-277/#389).

**Fix [OBSERVED].** Frames with `LastSequenceNumber > seqNum` drop at
debug level — no acceptance credit, no latency settle.

**Tests [OBSERVED].** `TestRunSessionV2_FutureSeqAcceptIgnored`.

## Session 331 — non-finite arbitration parameters (real fix)

**NaN/Inf hysteresis & floor slip past validation [OBSERVED + FIXED].**
`strconv.ParseFloat` accepts `nan`/`inf`, and YAML accepts `.nan`/`.inf`
literals, so `arbitration_hysteresis_pct` or `min_yield_sats_per_sec`
could carry non-finite values into `Decide`. The `< 0` guards don't
catch NaN: a NaN margin silently disables hysteresis (NaN threshold
never satisfied → switch on any improvement), +Inf freezes the
incumbent stream permanently, NaN floor silently disables the
min-yield gate. `Decide` now rejects non-finite values outright — the
engine logs a warn per cycle instead of silently misbehaving. Follow-up
in the same class as the s325 `Yield.Effective()` NaN collapse.
`TestDecide_RejectsNonFiniteMargins` covers all six cases.

## Session 378 — doctor check-suite audit

[FIXED] `checkPoolReachability` probed only `Pools[0]`: a dead
secondary/tertiary pool — the exact thing `checkPoolDiversity` pushes
operators to configure — was never tested until a real failover. The
check now probes every configured pool concurrently (bounded at 8, 5s
dial timeout each, caller ctx honoured): all reachable → Pass; any
unreachable or unparseable → Warn naming them; zero reachable → Fail.

[FIXED] `checkWallet` embedded the `wallet.fingerprint` file content in
the report verbatim. A corrupt or tampered file could inject control
characters into doctor output. The fingerprint is now printed only when
it matches the shape the wallet writes (8 lowercase hex chars —
`HMAC-SHA256("otedama-fingerprint-v1", seed)[:4]`); otherwise the check
reports the file as malformed instead of echoing it.

[AUDITED — clean] The remaining 15 checks: bounded timeouts on every
network probe (5s pool dial, 3s 1.1.1.1, 5s clock skew incl. bounded
body drain for keep-alive reuse), address checksums verified for both
primary and failover lists, data-dir permission warning, pool
encryption/CA/diversity/scheme checks, env-var lint, profitability
floor advisory. Results are indexed back into report order, so output
is deterministic despite concurrent execution.

## Session 371 — unimplemented schemes + live V2 dial bound

**[FIXED] Unimplemented scheme fail-fast.** `datum://` is recognised by
`poolproto.FromURL` (ADR-009, OCEAN's SV1-transport variant) but has no
implementation — it previously fell through to the plaintext SV2 branch
and emitted binary V2 frames to a pool expecting DATUM, surfacing only
as a confusing connect/handshake timeout. `runSession` now rejects any
protocol that is not V1-family/V2 with a named error; regular (non-fatal)
error so pool failover still rotates past the unusable entry to
configured alternatives.

**[FIXED] Live V2 dial bound.** The engine's inline V2 path dialled with
a bare `net.Dialer` (and `stratum.DialTLS` for v2tls) — no connect
timeout, so a blackholed endpoint stalled each failover hop for the OS
TCP timeout (~127s on Linux). `poolDialTimeout` (15s, test-overridable
var) now bounds the TCP connect; for `stratum+v2tls://` a derived ctx
bounds connect + TLS handshake together.

## Session 345 — per-attempt dial timeout on pool connections

**Blackhole dial stall [FIXED].** Both dialers called `DialContext` with
only the caller's context — which the engine session loop supplies
without a deadline — so a pool endpoint that swallows SYNs stalled each
failover hop for the OS TCP default (~127 s on Linux). Both `Dial`
implementations now wrap the attempt in a 15 s `dialTimeout` (covers the
TLS handshake on `stratum+tls://`), report it as a clear "dial timeout"
error, and keep the caller's deadline when it is tighter. `TestDialer_
DialTimeout` covers both protocols via a dialFn that blocks on ctx.

**Credentials-in-URL audit [AUDITED — clean].** `Credentials` are passed
separately from the pool URL; `StripScheme`/`DialURL` never splice user
material into URLs, so dial errors that embed the URL cannot leak a
password. Userinfo in a pool URL (`stratum+tcp://u:p@host`) is not
parsed — it reaches the resolver as literal text and fails fast.

## Session 314 — roll stale pool ntime forward to wall clock (SRI 1.12.0 nTime-bound lesson)

**Finding [FETCHED — freedom.tech SRI 1.12.0 release notes, 2026-09-17].**
`channels_sv2` now enforces `min_ntime`/`nTime` bounds on share
validation across all channel types: shares stamped with an aging ntime
get rejected once they fall outside the pool's window.

**Fix [OBSERVED].** New `rollNTime()` in run.go: `updateWork` (V2) and
`applyJob` (V1) roll a stale declared ntime forward to `time.Now()`;
a future ntime stays verbatim (rolling down would undershoot min_ntime —
itself a reject). Submission echoes `Header.Time`, so the submitted nTime
always matches the hashed header.

**Tests [OBSERVED].** `TestRollNTime` — stale→now, future→verbatim,
now→unchanged.

**Other SRI 1.12.0 notes audited [FETCHED].** noise_sv2 dropped
AES-256-GCM (ChaCha20-Poly1305 sole cipher) — Otedama's noise stack is
already ChaChaPoly-only, no action. Coinbase defects (undersized BIP141
parts, scriptSig serialization) are server-side taker paths — not a
client concern. ESP-Miner v2.15.x continues (v2.15.3); its SV2
"pending shares" dashboard maps to our `shares_pending` gauges.

## Session 387 — first-run wallet backup verification re-delivery

[FIXED — re-delivered] **First-run wallet backup verification** (`internal/engine/setup.go`, `internal/engine/run.go`, `internal/engine/run_test.go`), cherry-picked from closed #379: after the one-time recovery-phrase display, interactive terminals get a 3-position re-entry check drawn from crypto/rand — wrong or blank answers print a loud NOT-verified warning and log a warn, never a false pass; the phrase is never re-shown (the shown-once contract stands). Gated by `stdinIsTerminal` (*os.File + ModeCharDevice) so systemd/docker/piped stdin never see a prompt; `Options.Input io.Reader` (default os.Stdin) lets embedders drive or suppress the flow. For a non-custodial wallet, an unverified backup is the dominant fund-loss path — the software cannot detect a lost wallet.dat, so the backup step must prove the phrase left the screen.

[AUDITED — clean] Re-check of remaining closed-unmerged queue for re-delivery eligibility: #372/#386/#400/#410 (batch accepts) → live as open #433; #374/#384/#398/#411 (extranonce2 bound) → live as open #428; #377/#385/#397/#412 (job-map bounds) → live as open #429; #387/#399/#409 (reject-code classification) → live as open #434; #388/#413 (reconnect wait) → live as open #430; #381/#414 (wallet mode audit) → live as open #431; #378/#415 (live hashrate feed) → live as open #432; #389/#393/#403/#404 (seq validation) → live as open #422/#423; #426 ntime roll → open #426; #427 in-flight gauge → open; #416/#418–#421/#425/#435–#446 → all open. #375 FIPS doctor still blocked (go1.26 module directive vs CI pin), #380 hashrate gauges blocked by #432, #271 halves blocked by #417. #371 both halves landed this stretch (mnemonic flake → #497; atomic.Bool → pushed to #447's branch). Docs-only closed #469/#471/#472 remain low-value. No eligible candidate left un-delivered.

## Session 311 — drop SubmitSharesError frames with unsent sequence numbers (re-delivers closed #404)

**Finding [OBSERVED — code-verified].** SV2 `SubmitSharesError` was
counted without checking the sequence number — a forged reject frame
with an unsent seq inflated the reject rate, feeding curtailment.

**Fix [OBSERVED].** Frames with `SequenceNumber > seqNum` drop at debug
level; error responses for real seqs still settle `submitTimes` and run
reject classification.

**Tests [OBSERVED].** `TestRunSessionV2_FutureSeqRejectIgnored`.

## Session 366 — rates NaN injection + parser fuzz

**Fixed [FIXED — real reachable bug].** `strconv.ParseFloat` accepts the
literals `"NaN"`, `"Infinity"`, `"-Inf"` with nil error, and the doFetch
sanity band `rate < min || rate > max` cannot reject NaN (every
comparison against NaN is false). A price source returning
`{"data":{"amount":"NaN"}}` (Coinbase shape) or `{"c":["NaN",…]}`
(Kraken shape) — compromised endpoint or a proxy sitting inside TLS —
injected NaN into the median, producing a NaN BTC/USD rate that
poisons every downstream yield estimate. Two-layer fix: a `parseRate`
helper rejects non-finite values at the extractor, and the band check
is now a negated in-range test (`!(x >= lo && x <= hi)`) so NaN fails
closed for any future source. New `FuzzSourceExtract` asserts every
extractor's contract: no panic, and err==nil implies a finite rate —
1.9M execs clean.

**Fixed [FIXED — fuzzer-found].** `parseSubscribeResult` accepted an
empty `extranonce1` (`[[], "", 0]` — found by the new fuzzer on its
first pass): shares built on an empty extranonce are guaranteed
invalid, silently burning accepted-looking work. Empty en1 now errors,
terminating the handshake instead.

**New fuzz coverage [FIXED — CLAUDE.md parity].** `FuzzDispatchLine`
drives the session's JSON-RPC dispatcher (mining.notify /
set_difficulty / set_extranonce / show_message / reconnect /
response-id routing) over net.Pipe with arbitrary lines — 1.7M execs,
no panic/block. `FuzzParseSubscribeResult` covers the subscribe
response shape; its crash seed lives in testdata as a regression
input. This brings the cleartext V1 wire — the most exposed parser in
the codebase — under the fuzz mandate alongside the SV2 frame
fuzzers.

## Session 373 — wallet lifecycle audit + docs-code drift fix

[AUDITED — clean] `internal/lightning` wallet lifecycle: wallet.dat writes
are fully atomic (tempfile + Sync + Close + pre-rename chmod 0600 + Rename
into a 0700 data dir); decrypt errors are deliberately opaque ("wallet
unlock failed"); the WalletManager is short-lived in the engine
(`setupWallet` keeps only the fingerprint string, so the BIP-39 mnemonic
is collectable after first-run display).

[AUDITED — clean] BIP-39 wordlist + derivation: `GenerateEntropy`
restricts to valid bit widths and requires a full read; `MnemonicToEntropy`
rejects invalid word counts and enforces the checksum (transcription
errors caught); `Fingerprint` is an HMAC so it reveals nothing about the
seed. Intermediate derivation buffers are zeroed (session 340, PR #452).

[FIXED] Docs-code drift on the wallet KDF work factor: THREAT_MODEL and
AUDIT_CHECKLIST claimed `scrypt N=32768`; the actual constant is
`scryptN = 1 << 17` = 131072 in `internal/lightning/seedstore.go`
(4x understatement — the brute-force residual-risk paragraph materially
understates the real work factor). AUDIT_CHECKLIST also pointed item 22
at `internal/lightning/seed.go`; the call site is `seedstore.go`.
Corrected both. `docs/API.md` already documented N=2^17 correctly.

[AUDITED — clean] THREAT_MODEL channel bound: the SV2 reader channel is
`make(chan poolMsg, 32)` (run.go), matching the documented "Job channel
is bounded (buffer size 32)" claim.

## Session 382 — re-delivery of #485 + arbitration pause persistence fix

[FETCHED] Re-delivered the closed-unmerged #485 (docs-code drift on the
wallet scrypt work factor: THREAT_MODEL/AUDIT_CHECKLIST said N=32768;
implementation is `scryptN = 1 << 17` = 131072) — cherry-picked onto
master verbatim; no equivalent open PR exists.

[FIXED] Arbitration device pause was defeated by the next pool job:
`applyAllocation` pauses below-floor/idle/AI-routed workers with
`SetWork(nil)`, but `updateWork`/`applyJob` re-armed *every* worker on
each new pool job — undoing the pause for the ~30 s until the next Decide
tick. Introduced `pauseSet` (sync.Map), the per-device counterpart of
`curtailGate`: `reconcileArbPauses` rewrites the set after every Decide
(before applyAllocation), and both job-dispatch paths skip paused device
IDs. Hashing resumes on the next job after arbitration routes the device
back to a mining stream.

[FIXED] `updateLiveness` now treats "every worker arbitration-paused" the
same as curtailment — stall monitor not advanced, `otedama_up` stays 1 —
preventing false "hashrate stalled" warnings while the rig is
deliberately idle below the yield floor. Partial pause still stalls
normally (a nominally-mining device at 0 rate is a real fault).

[AUDITED — clean] fanIn share-merge backpressure: buffer 4·N capped at
64; when full during a reconnect the producers block and workers drop
shares via the dropped-share counter — bounded loss, no unbounded queue.

## Session 319 — doctor audits wallet.dat file mode (re-delivers closed #381/#414)

**Finding [OBSERVED — code-verified].** The wallet-permission audit
checked only the containing directory; a wallet restored via scp/rsync
or unpacked from a tarball lands 0644 inside a correctly-moded 0700
directory, silently exposing the encrypted seed.

**Fix [OBSERVED].** `doctor` now audits `wallet.dat`'s own file mode and
warns with a `chmod 0600` remediation (Unix-only; Windows builds report
N/A as before).

**Tests [OBSERVED].** Mode-audit cases green.

## Session 358 — engine V2 handshake deadline

**Live V2 handshake had no read bound [FIXED].** The engine's inline
`handshake()` (the *actual* V2 connect path — the `poolproto/stratumv2`
adapter remains unwired per KNOWN_LIMITATIONS §3) performed two
`dec.ReadFrame()` calls with no deadline. A pool that accepts TCP but
never answers SetupConnection held the failover loop forever; on
net.Pipe-style silent peers the write deadline alone fired after 10 s,
but a reader-draining silent peer never returned at all. A shared
`handshakeTimeout = 15 s` (var, test-overridable) now covers the whole
exchange via `conn.SetDeadline`, cleared on return so steady-state
session reads stay unbounded — matching the adapter-side `Negotiate`
deadline from session 327 (PR #439) that never applied to this path.

**V2 mid-session silence [OBSERVED — covered by #408].** The inline
reader goroutine exits cleanly on `ctx.Done` via `defer conn.Close()`
unblocking `ReadFrame`; a *live-but-silent* pool mid-session is a
detection problem already addressed by the pool-silence warning on
open PR #408 — deliberately not duplicated.

## Session 365 — re-delivery + ecosystem

**Re-delivered [FIXED].** The live-path V2 handshake deadline
(originally session 358, PR #470, closed unmerged in review flow) is
re-delivered standalone on master. `handshake()` — the engine's real
V2 connect path (`poolproto/stratumv2` adapter is unwired per
KNOWN_LIMITATIONS §3) — set no deadline on its two `ReadFrame` waits,
letting a TCP-accepting-but-silent pool hold the failover hop
forever. `var handshakeTimeout = 15 * time.Second` bounds both reads;
the deadline is cleared on return so mid-session reads stay governed
by ctx/keepalive, not a stale timer.

**Ecosystem [FETCHED — steady].** SRI release train unchanged from
the v1.12.0 line (sv2-apps repo carries app roles post v1.6.0 split);
ESP-Miner v2.15.x line unchanged. No new alignment gaps.

## Session 339 — V1 handshake timeout (mirrors s327's V2 fix)

**V1 Negotiate [FIXED].** `call()` waited only on the caller's ctx and
the read loop's 5-minute per-line deadline — a pool that trickles a
heartbeat line under 5 min but never answers `mining.subscribe` wedged
the handshake forever. Negotiate now wraps all three calls in
`context.WithTimeout(ctx, handshakeTimeout)` (30 s, var-overridable),
mirroring the V2 `Negotiate` read deadline from session 327. The 30 s
budget is shared across subscribe+authorize+extranonce.subscribe.

## Session 337 — SV2 channel_id validation + protocol-surface audit

**Foreign-channel frames [FIXED].** The live V2 loop processed
channel-scoped frames without checking `channel_id` against the
channel opened in handshake. A confused or hostile pool could mutate
`jobs`/prevHash/`shareTarget` via frames for a channel Otedama never
opened. `channelIDOf` extracts the id from the five channel-scoped
types; mismatches drop with a warn. Non-channel frames pass through.
**Message surface [AUDITED — clean].** Standard-channel message set is
complete (SetupConnection*/OpenMiningChannel*/NewMiningJob/
SetNewPrevHash/SetTarget/SubmitShares*); extended-channel and unknown
types land in `Message.Unknown` without error. `Decoder.MaxFrameSize`
bounds every frame at 16 MiB — matching SRI — so a peer announcing a
max-U24 payload cannot force an oversized allocation. The
`internal/poolproto/stratumv2` adapter's `channel_id`/pending-map gaps
are moot: it is not the live V2 path (its own comment + KNOWN_LIMITATIONS
§3), and pending-map bounding ships separately in #429.

## Session 317 — bound outstanding V2 job maps (re-delivers closed #385/#397/#412)

**Finding [OBSERVED — code-verified].** Two SV2 maps were unbounded: the
engine's live-loop `jobs` map and the adapter's `pending` future-job set.
A hostile/compromised pool flooding distinct `NewMiningJob` IDs without
rotating the tip could grow memory without bound (Noise encrypts the
wire, so the attacker IS the pool itself).

**Fix [OBSERVED].** `jobsCap`/`pendingCap` = 64 with oldest-first FIFO
eviction on both stores.

**Tests [OBSERVED].** Engine store-bound test + dialer flood test over a
real net.Pipe read loop.

## Session 355 — V1 RPC-call wait timeout

**Goroutine/pending leak on a silent pool [FIXED].** `session.call`
waited on `respCh` or `ctx.Done()` only. A pool that keeps TCP alive
but stops answering (wedged server, silent failure) left the waiting
goroutine and its `pending[id]` entry forever — V1 submits run one
goroutine per share, so the leak compounded at the share rate for the
session's whole life. `callTimeout = 60s` (var, test-overridable) now
bounds the wait: on expiry the pending entry is deleted and the caller
gets a "timed out" error, which the submit goroutine logs and exits.

**Remaining in-flight state [AUDITED — bounded].** `submitTimes`
(1024-cap oldest-evict) and the `jobsCh`/`noticeCh` buffers (8 each,
drop-oldest) are bounded on master; the V2 engine `jobs` map remains
bounded only on open PR #397/#429 — not re-implemented here.

## Session 340 — BIP-39 intermediate-buffer zeroization

**Secret-material wipe [FIXED].** `EntropyToMnemonic` and
`MnemonicToEntropy` built the mnemonic/entropy through a `bits` slice
holding the full secret bitstream (one byte per bit) that was left for
the GC; `MnemonicToSeed` left the mnemonic-derived `password` and raw
PBKDF2 `seed` buffers likewise. All are wiped via the package's
existing `zeroBytes` on every return path (defer). Residual: the
`m.String()` mnemonic string itself and `salt` are Go strings —
immutable, unzeroable — an accepted language limitation now recorded.
Touched `internal/lightning` — CODEOWNERS maintainer review applies.

## Session 327 — V2 handshake read deadline (real fix)

**Negotiate reads unbounded [OBSERVED + FIXED].** The dialer's two
handshake `ReadFrame` calls ran with no deadline and no ctx wiring —
unlike `sendMsg` (write deadline, s324) and the steady-state read loop
(unblocked by Close/ctx). A pool that accepts TCP then goes silent hung
`DialURL` inside the engine's synchronous reconnect loop: no backoff, no
failover, and shutdown could not cancel it. `handshakeTimeout` = 15 s now
bounds the phase (cleared on return — steady state stays
Close/ctx-governed). Test: `TestNegotiate_HandshakeTimeout` (net.Pipe,
draining-but-silent peer) fails Negotiate in 50 ms.

## Session 509 — V1 reject メトリクスのデータレース修正（実害）

**Sweep.** `internal/engine/metrics.go`（581行・未精読）の排他制御監査: lazy 作成 map 4件全て専用 mutex（`lastRejectByReasonMu`・`sharesFoundPerDeviceMu`・`payoutInfoMu`・`submitTimes` ローカル）保有なのに **`rejectByReason` のみロック欠落**を発見。

**実害**: `runSessionV1` はシェア毎に `go func()` で submit を非同期化し、reject 時に `rejectReason(category)` を呼ぶ → 2件の拒否が同時解決すると map への同時書き込み。さらに stats ループの `updateShareRates` が `m.rejectByReason["stale"]` をロックなしで読む → goroutine 書き込みとの同時 read/write。両経路とも `fatal error: concurrent map read/write`（recover 不可・プロセス強制終了）。Counter/Gauge 自体は atomic/RWMutex で安全 — map へのポインタ格納だけが問題だった。

**対応**: `rejectByReasonMu sync.Mutex` を追加し両アクセスを保護（兄弟の既存パターンと同一形状）。回帰テスト `TestRejectByReasonConcurrent`: 8 goroutine が rejectReason を競合呼出 + 4 goroutine が updateShareRates を競合読取 → mutex 除去で `-race` が DATA RACE を検出することを確認済み（付けると緑）。engine パッケージ全テスト緑。

## Session 324 — SV2 write path lacked a deadline (write-side stall fix)

**Finding [OBSERVED — code-verified].** `sendMsg` wrote to the pool
socket with no `SetWriteDeadline`. A pool that keeps the TCP connection
open but stops reading leaves a blocked `Write` once the kernel send
buffer fills — the whole V2 runSession stalls silently: no jobs
processed, no shares out. V1 already bounds writes at 10 s; the V2 path
had no equivalent.

**Fix [OBSERVED].** `writeTimeout` (10 s, matching V1) applied via
`SetWriteDeadline` inside `sendMsg`, covering SetupConnection,
OpenMiningChannel, and every SubmitSharesStandard write.

**Tests [OBSERVED].** `TestSendMsg_WriteDeadline` writes to an unread
net.Pipe with a shortened timeout and asserts a prompt i/o timeout.

## Session 333 — wallet.dat size bound (real fix)

**UnmarshalEncryptedSeed unbounded alloc [OBSERVED + FIXED].** The
parser `make([]byte, len(b)-29)`'d whatever `os.ReadFile` returned —
a corrupt or oversized wallet.dat forced a matching allocation. The
v1 payload is exactly 80 bytes (64-byte seed + 16-byte tag); added a
4 KiB cap (generous headroom for future versions) at the single parse
choke point both loadExisting and ChangePassphrase flow through.
Test: `TestUnmarshalEncryptedSeed_RejectsOversizedInput`. Touches
internal/lightning — fund-adjacent, CODEOWNERS review applies.

## Session 305 — reconstruct coinbase/merkle per job so V1 shares are verifiable (re-delivers closed #401)

**Finding [OBSERVED — code-verified].** V1 jobs dropped the coinbase parts
(coinb1‖en1‖en2‖coinb2) and merkle branch after parsing — shares couldn't be
verified locally before submit; an invalid share was only discoverable via
pool reject.

**Fix [OBSERVED].** `poolproto.Job` gains `ExtraNonce`/`Coinb1`/`Coinb2`/
`MerkleBranch` (V1-only; empty for V2). `miner.Work`/`Share` gain
`ExtraNonce`. A per-session `en2Counter` (big-endian counter at the field
tail) plus `completeV1Job()` folds the coinbase (`btccrypto.Hash256`) and
per-branch `Hash256(merkle‖branch)` at dispatch time.

**Tests [OBSERVED].** stratumv1 en2-counter + coinbase-fold cases; engine
dispatch threading.

## Session 349 — pool-text sanitization at the log boundary

**Reject-reason escape injection [FIXED].** Session 348 sanitized
`client.show_message` at the V1 parser; the same vector reached the log
through the two share-reject paths: V2 `SubmitSharesError.Error`
(STR0_255, bounded but raw) logged at `run.go`, and V1's
`ShareResult.Reason` (`fmt.Sprintf("%v", errResult)` — the pool's whole
JSON error object, potentially longer). New `poolproto.SanitizePoolText`
strips all Unicode control characters (C0/DEL/C1, including ANSI escape
introducers) and truncates to 256 runes; applied to `reason` at both
engine log sites *before* classification (canonical reject codes are
ASCII, so stripping cannot change the match).

**Job-ID strings in errors [AUDITED — clean].** `applyJob` embeds the
pool's JobID with `%q`, which escapes control bytes — no injection.

**Escalation boundary [AUDITED — clean].** Shares rejected via the
protocol error surface stay inside the loop; the engine only escalates
to reconnect on transport errors, so a hostile reject reason cannot
liveness-abort the session.

## Session 375 — release-supply-chain claims audit + install.sh fix

[FETCHED] Ecosystem: SRI v1.12.0 (2026-09-17, freedom.tech release notes) —
deep hardening pass on channels_sv2, codec/framing refactor, **bounded job
storage** (same class as Otedama's open PR #429), consensus-defect coinbase
fixes, BIP323 adaptations, AES-256-GCM removed from noise_sv2 leaving
ChaCha20-Poly1305 the sole cipher. ESP-Miner v2.15.3 (2026-09-20 prerelease;
v2.15.2 added BM1372/BM1373). No Otedama action — the coinbase defects live
in the pool-side reconstruction Otedama deliberately does not perform (V1
coinbase handling is the open #391/#417 thread).

[FIXED] `install.sh` could not download any release the repo actually
produces: it hardcoded the goreleaser asset name
(`otedama_<ver>_<os>_<arch>.tar.gz`) while release.yml emits
`otedama-<os>-<arch>.tar.gz` and ci-cd.yml emits a bare binary. The
checksums download was a hard `die`, yet release.yml never publishes
checksums. Now tries all three asset names, accepts either checksum file
name, still refuses (dies) when none is published unless
--skip-verify is given, and installs bare binaries
without tar extraction. `bash -n` clean.

[FIXED] Documentation overclaimed supply-chain mitigations that do not
exist on master: THREAT_MODEL asserted cosign-signed release artifacts,
`-trimpath` reproducible builds, and SHA-pinned Actions — release.yml has
no cosign step, no `-trimpath`, embeds `BuildTime` (inherently
non-reproducible), and all 8 workflows use `@vN` tags (0/168 `uses:`
SHA-pinned). AUDIT_CHECKLIST rows 11/13/17/22 corrected to match reality
(including the session-373 scrypt N=2^17 and seedstore.go fixes, which
returned to master when PR #485 was closed unmerged). The checklist's own
rule — a failing row means "open a security advisory" — is served better
by marking rows as gaps than by claiming mitigations that are absent.

## Session 307 — per-session submit rate cap stops difficulty→0 share floods (re-delivers closed #402)

**Finding [OBSERVED — code-verified].** A pool (or MitM on cleartext V1)
assigning difficulty≈0 makes every nonce a "valid share" — the workers flood
submit, a bandwidth/CPU DoS the capped share channel alone doesn't bound at
the *protocol* layer.

**Fix [OBSERVED].** A token bucket (8/s refill, burst 32) on both submit
paths; excess shares drop and count into `otedama_shares_submit_dropped_total`.
SPECIFICATION §6 catalogue + API.md row + THREAT_MODEL entry synced.

**Tests [OBSERVED].** `TestSubmitLimiter_BurstThenRefill` — burst exhausts
the bucket, drops count, refill resumes submits.

## Session 343 — HTTP client redirect refusal

**Redirect downgrade [FIXED].** The rate fetcher's `http.Client` and the
doctor clock-skew probe (which used `http.DefaultClient`) followed
redirects by default — including https→http downgrades. All rate sources
and the clock probe are hardcoded HTTPS endpoints, so a redirect can only
be hostile: a network attacker 302-ing a price source to a cleartext
endpoint could inject a manipulated BTC/USD into the arbitration median.
`CheckRedirect` now refuses all redirects on both clients. (A legitimately
moved API would fail loudly and the median falls back to the remaining
sources — the correct degradation.)

**Rates surface audit [AUDITED — clean].** Verified bounded before this
round: 10s client timeout, 64KiB `LimitReader`, implausible-reading
exclusion from the median, per-source health accounting, skew measured
from the `Date` header, body drained for keep-alive reuse.

## Session 348 — pool-notice sanitization + config-write audit

**Terminal-escape injection via client.show_message [FIXED].**
`parseShowMessage` forwarded the pool's string verbatim into
`noticeCh`; every downstream consumer (the log wiring on PR #448, or a
future TUI notice line) would write raw text to a terminal or log file.
A hostile pool could embed ANSI escape sequences (screen clear, cursor
moves, OSC window-title / hyperlink payloads) or newlines that forge
log entries. `sanitizeNotice` now strips all Unicode control characters
(C0, DEL, C1) and truncates to 256 runes at parse time, so every
consumer gets safe text regardless of how it renders.

**Config-file write path [AUDITED — clean].** `otedama` never writes
the YAML config — `loadConfigFile` is read-only with
`KnownFields(true)` (rejects typo'd keys), so there is no
config-write permission path to audit. The wallet passphrase flag
documented in `--help` is consumed in-process only.
## Session 384 — pool-URL credential redaction

[FIXED] **Userinfo in pool URLs could leak into logs and status surfaces** (`internal/poolproto/poolproto.go` + call sites): a `scheme://user:pass@host` pool URL was echoed verbatim by the connect log (`connecting to %s`), the bad-URL error, the V1 connected log, the TUI `PoolURL` field, `config show` (text + JSON), and four doctor `Detail` strings. `poolproto.StripUserinfo` removes the authority-section userinfo at every display boundary (dial-path parsing unchanged — `StripScheme` semantics untouched). Malformed URLs pass through so redaction cannot corrupt diagnostics. Defense-in-depth regardless of upstream userinfo validation. Test: `TestStripUserinfo` (9 cases incl. path-`@`, multi-`@`, no-scheme edge cases).

[AUDITED — clean] V2 handshake `OpenMiningChannelSuccess` consumption: `ExtraNonce2Size` is legitimately unused — Otedama uses standard channels where the pool supplies the merkle root and the miner varies only nonce/ntime, so extranonce2 never participates. `ReqID` echo unchecked (cosmetic; ChannelID is authoritative). V1 `mining.authorize` is a mandatory handshake step — rejection is `ErrHandshakeFailed`, not silent. `internal/daemon` `launchdLogPath`/`systemdUnitName` take literals only — no name-traversal surface.

## Session 368 — v2tls silent-downgrade fix

**Fixed [FIXED — real reachable bug].** `stratumv2.Dialer{useTLS: true}`
(the registered handler for `stratum+v2tls://`) ignored `useTLS` in
`Dial` — it always opened plaintext TCP while reporting the V2-TLS
protocol ID. The engine's live path was already correct
(`stratum.DialTLS` with verified certs + `tls_ca_file`), so the trap
was dormant but armed: the first wiring of the poolproto V2 adapter
(KNOWN_LIMITATIONS §3 Step 3b) would silently downgrade every v2tls
pool to plaintext — under a scheme operators are explicitly told to
use for encryption. `Dial` now routes `useTLS` through
`stratum.DialTLS` (system roots, TLS 1.2+, ServerName from the
address, no plaintext fallback).

**Tests [FIXED].** `TestDialer_V2TLS_DialsTLS` drives the production
dial path (no injected dialFn) against a TLS server with an untrusted
cert and asserts a `*tls.CertificateVerificationError` — proof the
handshake ran and verification is enforced.
`TestDialer_V2TLS_ConnectsToTrustedServer` completes the positive path
with a CA-trusted dialFn injection and asserts the conn is *tls.Conn.

## Session 344 — V1 set_difficulty value validation

**Non-positive/non-finite difficulty [FIXED].** `parseDifficulty`
stored `params[0]` unchecked: `d <= 0` collapses the share target to
accept-every-hash (a share flood from a hostile pool or MitM on
cleartext V1), and non-finite values poisoned the target math
downstream (same class as the s325 `Yield.Effective` and s331 hysteresis
non-finite fixes). NaN/±Inf cannot arrive via JSON literals but
`1e999` decodes to +Inf without error — all now rejected. Fractional
and subnormal difficulties stay valid (ESP-Miner #1594/#1779 show real
pools use them).

**Ecosystem re-check [FETCHED].** SRI v1.12.0 (Sep 17) unchanged since
s329. ESP-Miner v2.15.3 (Sep 20) is a UI-only patch; the v2.15.x stratum
changes (fractional SV2 difficulty, duplicate-jobId drop,
submit-response-only share counting, TCP_NODELAY) are all behaviours
Otedama already matches — recorded. Go advisory batch (Sep 2) — the
reachable classes (crypto/tls KeyUpdate DoS CVE-2026-56862,
net/url quadratic CVE-2026-56860) are fixed in go1.26.8 which the
toolchain already requires; encoding/xml recursion and unencrypted-HTTP/2
do not apply (no xml decode, no h2c listener).

## Session 316 — bound pool-controlled extranonce2_size (re-delivers closed #384/#398/#411)

**Finding [OBSERVED — code-verified].** `extranonce2_size` is
pool-controlled and flowed unbounded into `strings.Repeat` on every
`mining.submit` — a hostile pool or MitM on cleartext V1 could force a
~2 GiB allocation per share (memory-exhaustion DoS).

**Fix [OBSERVED].** Bounded to [0, 64] at both negotiation entry points
(`parseSubscribeResult`, `parseSetExtranonce`) plus a defensive clamp in
`Submit`. THREAT_MODEL documents the threat and residual.

**Tests [OBSERVED].** Boundary unit tests on both entry points.

## Session 342 — service-definition injection via control characters

**Unit-file directive injection [FIXED].** `quoteToken` quoted values on
whitespace/quotes but passed control characters raw: a flag value
containing a literal newline (`--data-dir`, `--config`, payout flags —
reachable from CLI, env, or a poisoned config file) broke out of the
systemd `ExecStart=`/`ReadWritePaths=` lines into a new unit directive —
e.g. `\nProtectHome=false` silently removed the sandbox, or
`ExecStartPost=` ran an arbitrary command. Now any rune < 0x20 or 0x7f
triggers `%q` quoting, which escapes it to `\\n` inside the token.
launchd was already safe (argv slice + XML escape); Windows sc.exe
binPath= shares `serviceArgs` so it inherits the fix. Same for the
`%q`-inside-quotes caveat: systemd does not unescape Go `\uXXXX`, so a
path mixing spaces with non-printable bytes quotes correctly for the
file but resolves differently — recorded, not exploitable.

**Daemon surface audit [AUDITED — hardened].** Verified already-clean:
launchd XML escaping (`xmlEscape` covers the five specials),
LaunchAgent log path moved off world-readable `/tmp` to
`~/Library/Logs`, `ProtectHome=read-only` + `ReadWritePaths` carve-out,
`NoNewPrivileges`, `PrivateTmp`, user-scope units (no root), Windows
`binPath=` quoting.

## Session 367 — SV2 message-decoder fuzz coverage

**Coverage [FIXED — CLAUDE.md parity].** The SV2 frame fuzzers covered
header + stream decode, but the six typed payload decoders
(`DecodeNewMiningJob`, `DecodeSetNewPrevHash`, `DecodeSetTarget`,
`DecodeSubmitSharesStandard`, `DecodeSubmitSharesSuccess`,
`DecodeSubmitSharesError`) and the STR0_255/B0_255/U16/U32 wire
primitives had none — all run on pool-controlled post-handshake bytes.
`FuzzMessageDecoders` now drives every one of them with arbitrary
payloads plus shape-targeted seeds (OPTION-present NewMiningJob,
over-claimed STR0_255 length prefixes, 255-byte strings): 2.7M execs,
no panic or hang. `TestMessageDecoderBounds` pins the short-payload
contract as a plain unit test so the invariant holds even outside
fuzzing.

**Audit [AUDITED — clean].** The decoders were already bounds-safe —
every field read is preceded by a `len < need` guard, every
length-prefixed read goes through `io.ReadFull`, and the
`byteSliceReader` cannot over-read. The fuzzer confirms empirically.
