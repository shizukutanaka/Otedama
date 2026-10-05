# Product Audit: 50 Strengths, 50 Weaknesses, and the Improvement Map

This document is the output of a first-principles / Socratic-questioning
pass over the product as it actually exists on `master` — not as it is
described in marketing copy. Every item cites the code or document that
backs it. Items marked ⚠️ are honest residuals: things the design does
on purpose, or cannot fully fix, that a reader should still know about.

Methodology: each entry was verified against the live tree (the same
standard used in `docs/CATEGORY_AUDIT.md`), or is a stated and disclosed
limitation from `docs/KNOWN_LIMITATIONS.md`. If an entry is wrong, that
is a documentation bug — please open an issue.

## 50 Strengths

### Protocol layer (Stratum V1 + V2)

1. Every pool-controlled input is bounded — line caps, `extranonce2_size`
   limits, bounded pending-job maps; hostile servers cannot grow memory
   unboundedly (`internal/poolproto/stratumv1`, `internal/poolproto/stratumv2`).
2. Decode is fail-closed: malformed prevhash, invalid `nBits`, bad
   `set_difficulty` values all produce errors, never silent zero-work.
3. SV2 channel frames addressed to a foreign channel are dropped with a
   warning — cross-channel share attribution is structurally impossible.
4. `CloseChannel` (0x18) is decoded and terminates the session instead of
   leaving a dead channel being mined forever.
5. Unimplemented pool→client `msg_type`s emit a once-per-type warning
   (256-entry cap) — nothing arrives silently.
6. Sequence-number bookkeeping is honest: `SubmitSharesSuccess` and
   `SubmitSharesError` frames carrying unsent sequence numbers are
   dropped, not credited.
7. `OpenMiningChannel` puts spec-required `max_target` and
   `group_channel_id` on the wire (fixed to the sv2-spec layout).
8. `SetupConnectionSuccess` flags outside the offered set are rejected.
9. V1 `prevhash` wire order is normalized per 4-byte word at decode —
   `Job.PrevHash` holds header-serialization bytes, so shares are
   verifiable against the pool's declared header (the s1553 fix).
10. V1 `applyJob` copies pool-declared `Version`/`PrevHash` into the
    hashed `Work.Header` — workers hash the real preimage, not a
    zero-filled stub (the s1553 fix).
11. Jobs are bounded: V1 uses a cap-8 channel honoring `clean_jobs`
    semantics; V2 pending-job maps evict FIFO at a fixed cap.
12. Share submissions are session-scoped goroutines with a token bucket —
    they cannot leak across reconnects or across sessions.
13. A new session cannot receive shares from a previous session's job
    (the `jobArmed`/`haveJob` gate, fixed and pinned by regression test).
14. Mining cannot start before the `subscribe` result supplies the
    extranonce — ordering is structural, not convention.
15. Workers see whole jobs only: `Work` is swapped atomically
    (pointer + version), never read mid-mutation.
16. Nonce space is partitioned across workers in `uint64` arithmetic —
    no overlap, no 32-bit overflow (`1<<31` fix).
17. `ntime` rolls forward when the nonce space wraps and when the pool's
    timestamp falls behind wall clock — no guaranteed-stale shares.
18. Pool writes have deadlines; the live V2 handshake has a 15s bound;
    the V1 handshake has a 30s bound; V1 RPC waits bound at 60s.
19. A per-session submit rate cap stops difficulty→0 share floods.
20. Reconnect uses exponential backoff (1s→64s) that resets only after
    an established session, fails over to the next pool before retrying
    a dead one, and only switches to addresses that were never
    established — it will never dial an unconfigured `Host:Port`.
21. An omitted or zero share target falls back to the *block* target —
    the strictest side — rather than trusting the pool.
22. Hostile difficulty starvation (economically pointless difficulty)
    surfaces a once-per-episode warning instead of silent revenue loss.
23. A connected-but-silent pool surfaces a once-per-episode warning.
24. `client.show_message` pool notices reach the operator — sanitized.
25. Reject-reason classification checks canonical SV2 codes before
    substring heuristics; unknown reasons land in "other", never hidden.
26. Mid-flight retarget rejects are classified benign, keeping the
    reject-rate signal honest.

### Arbitration engine

27. `arbitration.Decide` is a pure function — no side effects, fully
    deterministic given the same inputs — and its documented invariants
    are pinned by property tests.
28. Allocation is routed on **net** (post-fee) provider yield — the 20%
    Akash fee and pool fees are real inputs to the decision, not display
    arithmetic (the s1404 fix).
29. Confidence is clamped to `min(conf, 1)` at both the provider
    `Effective()` boundary and inside `Decide` — a `Confidence > 1`
    quote cannot inflate its own arbitration score.
30. Non-finite yields collapse to zero at the boundary — NaN/±Inf from a
    buggy provider cannot poison the comparison space.
31. Three independent gates before a device is assigned: family
    compatibility, positive effective revenue, and the min-yield floor.
32. Hysteresis operates in the post-policy score space (relative margin
    on adjusted scores), so the margin means what the config knob says.
33. A dead incumbent is dropped instantly — hysteresis never traps a
    device on a stream that has gone stale.
34. `Held` is only recorded when a switch was actually suppressed —
    opportunity-cost accounting cannot double-count a correct hold.
35. Stream freshness is enforced: quotes older than 3 minutes retire the
    stream, and future `q.At` timestamps are clamped so a broken clock
    cannot make a stream immortal (the s1439 fix).
36. The quote fan-in drops the *oldest* quote under backpressure and is
    context-scoped — a slow consumer cannot block a provider or deadlock
    the arbitration loop.
37. Per-provider, per-device bookkeeping is namespaced
    (`providerID:deviceID`) — quotes cannot cross-contaminate.
38. Stream classification is a single source of truth — the `mining.`
    category prefix shared by `reconcileArbPauses`, `applyAllocation`,
    and `IsBitcoinMining` (the s1398 fix).
39. Arbitration pauses persist across pool job updates and are enforced
    at the job-dispatch gate — a `SetNewPrevHash` cannot un-pause a
    curtailed device.
40. The pause set is single-writer (arbitration loop) / read-only
    everywhere else — no lock-ordering hazard on the hot path.
41. Idle devices log once on transition, not per tick — the audit fix
    removed a ~2,880-lines/day log flood without losing the signal.
42. The power-breakeven floor converts USD/kWh→sats correctly, applies
    per-device with hysteresis, and fails open (floor=0) when the rate
    feed is dead — it cannot get stuck curtailing.
43. `Decide` errors fall back to the previous allocation; internal bugs
    fail-stop deliberately rather than emit a corrupted allocation.
44. Estimated earnings only accumulate during productive time and are
    labeled estimates — idle hours and reconnects cannot inflate them.
45. `otedama_up` is honest about semantics: intentional idle (curtail /
    no acceptable stream) stays up=1, an actual stall drops it to 0.

### Wallet, secrets, and adversary-facing surfaces

46. Payouts are verified non-custodial by parsing the coinbase's actual
    `vout` list — the configured address must appear in a real output
    (TIDES/solo verified; OP_RETURN/scriptSig/witness stuffing rejected).
47. Corrupt `wallet.dat` stops the process — read/parse/decrypt failures
    propagate; there is no silent fall-through to minting a new seed.
48. Wallet encryption is scrypt + AES-256-GCM, secret buffers are
    zeroed, the BIP-39 wordlist is integrity-checked, and `wallet.dat`
    size is bounded at unmarshal.
49. A fingerprint sidecar verifies the wallet without decrypting it —
    mismatch is surfaced, never hidden.
50. Pool-controlled text is sanitized at the log boundary (including
    Unicode format chars `Cf`/`Zl`/`Zp`), URLs redact userinfo at every
    display boundary, outbound HTTP refuses redirects, and metric label
    cardinality is fixed — a hostile pool cannot inject log escapes,
    leak credentials, or explode the metrics index.

## 50 Weaknesses

### Product-completeness gaps (the largest class)

1. AI-inference yield is **simulated**: the Akash provider emits a
   configurable `$0.30–0.60/hr` midpoint, not a live market quote
   (`KNOWN_LIMITATIONS` §1). The "four-stream arbitration" product
   currently arbitrates across two streams, one of them modelled.
2. Rendering and scientific-computing streams do not exist at all —
   they are v4.0 scope (`CLAUDE.md`). The product today is a
   two-provider arbitrated miner, not the stated four-way engine.
3. No ASIC driver exists — the ASIC device family is pure scaffolding
   (`KNOWN_LIMITATIONS` §8). The headline "user-owned ASIC" hardware is
   undrivable.
4. GPU detection is Linux-only via sysfs; on macOS/Windows GPUs are
   invisible to the engine (`KNOWN_LIMITATIONS` §4).
5. Detected GPUs never compute: `SHA256d=false` is unconditional and no
   compute dispatch exists — a GPU is enumeratable but cannot earn.
6. `datum://` is a reserved scheme with no dialer — the main
   decentralized-pool path is unimplemented (`KNOWN_LIMITATIONS` §14).
7. V1 version-rolling (`mining.configure`, ASICBoost) is absent — only
   a diagnostic notice when a pool requests it; pools that require it
   cannot be served (`stratumv1.go`).
8. Noise NX is not wired: `stratum+v2://` runs plaintext and only logs
   a warning — the flag also advertises encryption the link does not
   have (`KNOWN_LIMITATIONS` §2, ADR-011).
9. The Noise implementation uses a **P-256** stub for a spec that
   requires secp256k1+ElligatorSwift — wire-incompatible with any real
   SV2 endpoint (`internal/stratum/noise.go`).
10. Even when wired, the Noise path has no responder authentication —
    the security guarantee SV2 exists to provide is unmet.
11. `internal/lightning` is seed storage only: BIP-39 + AES-GCM at
    rest, receive-only — no channels, no sends, no node (`§6`).
12. Post-quantum scaffolding (ML-DSA, SPHINCS+) is registered-but-stub
    `ErrSchemeNotImplemented` — dead code carrying a roadmap promise.
13. P2MR (BIP-360) payout addresses return `ErrSchemeNotImplemented` —
    a config-accepted address family that cannot be paid to.
14. No BOLT-12 / offer-based payout path; the "Lightning" in the name of
    the wallet package is a storage format, not a network participant.

### Protocol and correctness residuals

15. ⚠️ V1 transport is plaintext by default (`stratum+tcp://`); TLS
    exists only on the `stratum+v2tls://` path, with no cert pinning.
16. Arbitrated devices resume mining only on the next job/tick — up to
    ~60s of idle after an un-pause (deliberate curtail-style design,
    but a real latency).
17. The 30s `Decide` tick is the *only* decision trigger — arriving
    quotes never re-decide, so a fast provider sits idle up to a tick
    even when it just became optimal (documented design, real cost).
18. Reconnect backoff has no jitter — a fleet restarting together
    can thundering-herd the pool (⚠️ recorded in the ledger).
19. The failover pool's payout scheme is not propagated: the flat 1%
    fee assumption follows only `pools[0]` — a `solo` failover is
    mispriced (s1406 residual).
20. Solo mining's all-or-nothing variance is not reflected in
    `Confidence` — a coinbase that statistically pays ~never is scored
    at its EV (s1406 residual).
21. Estimated earnings reset on restart and are never reconciled
    against pool-side accounting — long-run drift is unbounded.
22. Arbitration history and the earnings ledger are not persisted —
    process restart loses the decision trail.
23. `otedama_up=1` while every provider is dead (idle-by-design
    semantics) can mislead a naive "up means earning" alert (⚠️).
24. A dormant dialer residual exists — a cleanup path left for a later
    pass (⚠️ recorded).
25. A 1→1 same-count device swap produces no aggregate log line —
    invisible in the idle-transition summary (⚠️ cosmetic).
26. Per-device resume log lines do not exist — only the aggregate
    counts them (⚠️ recorded).

### Verification and ops surface

27. CI queue saturation was observed: ~29 pending / 0 running checks
    across the PR backlog — the gate exists but the runner capacity
    does not match it (operational, not code).
28. `KNOWN_LIMITATIONS` §13's workflow claims are partially stale —
    merged fixes (branch filters, govulncheck, fuzz job) are not yet
    reflected; the honesty doc itself lags the code.
29. golangci-lint is pinned to v1.64.8 while upstream is v2.x — a
    deliberately frozen linter (upstream rejected the v2 config
    migration), so new-rule findings accumulate silently.
30. `internal/engine/run.go` remains a 2,180-line unit with 23
    functions — the gocyclo decomposition PR was closed unmerged, so
    the largest file in the repo stays at monster size by choice.
31. There is no integration test against a real public pool — E2E uses
    in-process fakes; wire fidelity against production pools is
    inferred, not measured.
32. Benchmarks exist but no CI regression check consumes them —
    performance is asserted by construction, not tracked.
33. Release binaries are unsigned — `VERIFY.md` discloses this, but
    the supply-chain gap stands until signing lands.
34. Solo CPU mining's EV is ~0 on mainnet — honest reporting makes this
    a disclosed reality, but the out-of-box "just run it" path earns
    nothing for a typical laptop user.
35. Mining revenue is entirely pool-dependent — no solo-sovereign mode
    has a non-negligible expected return at CPU/GPU scale.
36. The power input is a user-supplied constant — no sensor/telemetry
    path exists, so `power_watts` staleness is unverifiable in-band.
37. Arbitration is whole-device granularity — a device cannot split
    e.g. 50/50 between streams; mixed-fleet fine-tuning is impossible.
38. The hashrate feed draws from two HTTP endpoints; when unwired or
    unreachable it falls back to static per-device constants.
39. The Akash fee model is a fixed 20% — no market dynamics, no
    currency depth, no time-of-day pricing.
40. `Confidence` falls back to a constant when the hashrate feed is
    unwired — a degraded input silently scores as mediocre rather than
    signalling the degradation (documented caveat).
41. The fingerprint sidecar is trust-on-first-use — a swapped
    `wallet.dat` on first run is accepted without history.
42. Wallet passphrases come only from env vars — an interactive prompt
    exists for first-run verify but passphrase rotation/verify are
    env-only; headless UX is the only documented path.
43. The metrics endpoint has no auth — binding it beyond loopback is
    warned, not prevented; a misconfigured `--http-addr` exposes all
    operational data.
44. `doctor`'s fingerprint echo is bounded but still echoes — the
    bounded-output mitigation is a rate limit, not removal.
45. The TUI is ANSI-only with no remote/web surface — headless
    operation on a server relies on logs and `/metrics` alone.
46. Non-major-language i18n catalogs are machine-translated — the 10
    human-reviewed languages are real, but the long tail's quality is
    unreviewed by design.
47. Windows-service and launchd paths are compile-tested and audited
    but not E2E-tested on their platforms — service lifecycle on the
    non-Linux targets is exercised only in CI build.
48. `internal/engine` concentrates most of the product's logic in one
    package — cohesion is high but so is the blast radius of any
    engine-local mistake.
49. The s1553 defect class — V1 shares hashing a zero-prefilled header
    for ~4 months — shows that unit-level wire fidelity can be wrong
    *silently* when only the decode side is tested; end-to-end "does a
    real pool accept this share" coverage is still thin.
50. The open-PR backlog + append-only ledger/CHANGELOG anchors create
    a standing merge-conflict treadmill — every session's bookkeeping
    conflicts with every other open session's bookkeeping (process
    weakness, repeatedly observed).

## Improvement map

Ordered by leverage — what to fix first to make the product match its
own definition. P0 = the gap between claimed and shipped product is
widest here.

### P0 — close the claim/code gap

1. **Implement real Noise NX** — secp256k1+ElligatorSwift DH (btcec/v2
   ships upstream ellswift now, per ADR-011 erratum 2) with responder
   authentication. Closes weaknesses 8–10 and makes `stratum+v2://`
   honest. This is the single highest-leverage fix: the product's name
   claims SV2 compliance, and the security mechanism is a stub.
2. **Ship a real second provider or narrow the claim** — either wire a
   real Akash/akash-market lease-price source so inference yield is
   market-derived, or document that today the engine arbitrates
   mining-vs-modelled-idle. Closes weakness 1.
3. **V1 version-rolling support** — implement `mining.configure` +
   version-mask rolling so ASICBoost-capable firmware and pools that
   require it (e.g. DATUM-adjacent deployments) are reachable. Closes 7
   and unblocks the `datum://` path's V1-fallback plan.
4. **GPU compute dispatch or drop the capability flag** — either ship
   real SHA256d GPU kernels (OpenCL/compute-shader), or remove GPU
   enumeration's mining claim so devices can't be allocated work they
   cannot do. Closes 5; partially closes 3–4.

### P1 — revenue correctness and operational honesty

5. **Persist the earnings ledger** — one append-only file under the data
   dir, loaded on startup. Closes 21–22.
6. **Reconcile estimates with pool stats** — a periodic
   `mining.get_transactions`/pool-API comparison that logs drift.
   Closes 21 and the "estimate vs reality" gap.
7. **Propagate payout scheme on failover** — each pool carries its
   scheme; the quote uses the *active* pool's fee model. Closes 19.
8. **Model solo variance in Confidence** — scale solo EV by a
   variance/expected-blocks factor so a ~never-paying coinbase isn't
   scored like an FPPS stream. Closes 20.
9. **Add jitter to reconnect backoff** — ±25% uniform jitter on the
   exponential base; three-line change, kills the herd risk. Closes 18.
10. **Fix CI runner saturation** — the audit's single largest
    operational blocker; without it the "green gate" is theoretical.
    This is an infra task, not a code task.
11. **Sync `KNOWN_LIMITATIONS` §13 with merged CI fixes** — keep the
    honesty doc honest about which workflow defects are still live.

### P2 — depth of verification

12. **End-to-end share acceptance test** — a CI job (or a documented
    manual harness) that connects to a public testnet/regtest pool and
    verifies pool-side share acceptance. Closes 49, the class that let
    s1553 hide for months.
13. **Benchmark regression tracking** — a CI step comparing hot-path
    bench output to a stored baseline and warning on regression.
    Closes 32.
14. **Sensor-based power telemetry** — an interface (`PowerSampler`)
    with a sysfs/`hwmon`/OS-API implementation per platform so
    `power_watts` is measured, not asserted. Closes 36.
15. **Split-allocation arbitration** — allow a device to divide work
    across streams by share, not just binary switching. Closes 37;
    large design surface, plan behind an ADR.
16. **Quote-arrival re-decision** — a debounced trigger on quote
    arrival (e.g. 5s coalescing) so the tick isn't the only path.
    Closes 17.
17. **Signed releases** — cosign keyless signing on the release job;
    `VERIFY.md` already describes the verification flow. Closes 33.
18. **Interactive passphrase prompt for wallet ops** — wire
    `wallet verify`/`change-passphrase` to a no-echo TTY prompt, keep
    env vars as the scripting path. Closes 42.
19. **Metrics endpoint auth or hard loopback default** — an
    `--http-auth-token` flag, or refuse non-loopback without an
    explicit `--i-know` override. Closes 43.
20. **Device-level idle/resume log lines** — close the 1→1 swap and
    per-device visibility gaps noted in 25–26.

### P3 — structural and process debt

21. **Decompose `run.go`** — retry the rejected decomposition in
    smaller pieces (one function family per PR); the 2,180-line unit
    is the largest single maintenance risk. Closes 30.
22. **Decide golangci-lint's future** — either accept the v2 config
    migration cost or record the freeze as permanent in
    KNOWN_LIMITATIONS; the current limbo silently accumulates findings.
    Closes 29. (This direction was previously closed unmerged — the
    decision belongs to the maintainer.)
23. **`datum://` dialer** — implement when V1 version-rolling lands;
    the DATUM gateway is MIT-licensed SV1-transport compatible. Closes 6.
24. **Cross-platform service E2E** — a Windows runner job that
    installs/uninstalls the service; a launchd smoke on macOS. Closes 47.
25. **Per-platform GPU detection** — extend `hal` past Linux sysfs
    (Metal on macOS, DXCore on Windows) so enumeration isn't
    Linux-only. Closes 4.
26. **Process: rotate the ledger anchor** — per-session files under a
    `docs/audit/` directory instead of appends to one file would end
    the standing merge-conflict treadmill. Closes 50.

### Deferred (explicitly out of scope for this pass)

- `datum://` implementation, real Noise, GPU dispatch, and any second
  provider are engineering projects, not single-PR fixes — they are
  listed here because the weakness list demands them, not because they
  are ready to schedule.
- Anything in `CLAUDE.md`'s banned list (multi-currency, PQ features
  before v4.0, custodial components, own tokens) stays banned
  regardless of how attractive it looks in a strengths/weaknesses
  framing.
