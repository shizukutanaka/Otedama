# Known limitations — Otedama v3.0.0-alpha.1

This document is an honest, exhaustive list of the things Otedama does
**not** yet do, or does in a simplified form, as of v3.0.0-alpha.1. It
exists so that users, auditors, and future maintainers can tell the
difference between "designed this way on purpose" and "not finished
yet" without reading the source.

Each entry states the **impact**, any **workaround**, and the **target
release** for resolution. Where a limitation is tracked by an ADR, the
ADR is linked.

The guiding principle (CLAUDE.md I7): AI-generated code is assumed to
carry a higher logic-error rate, so anything touching authentication,
payment, data, or external APIs is called out explicitly rather than
quietly trusted.

---

## 1. AI inference yield is simulated, not live

**What:** The `AkashProvider` (`internal/provider/ai_inference.go`)
models Akash Network market conditions with a realistic price process.
It does **not** yet query the live Akash REST API, submit real bids, or
earn real inference income.

**Impact:** The inference-side yield shown in the TUI and used by the
arbitration engine is a *simulation*. It is suitable for exercising the
arbitration logic and for development, but the numbers are not real
income and must not be relied upon for financial decisions.

**How you can tell:** The provider's name is rendered everywhere as
**"AI Inference (Akash Network, simulated)"** — in the TUI, in logs,
and in `otedama config show`. The "(simulated)" suffix is removed only
when the real integration lands.

**Workaround:** None needed for mining-only operation; the Bitcoin
mining path (Stratum V2) is real. If you only want real income today,
run mining and treat the inference figures as illustrative.

**Target:** v3.1.0 (real Akash REST API). Tracked by ROADMAP v3.1.0 and
ADR-010 (arbitration engine evolution) §A4 (strategic bidding).

---

## 2. Noise NX handshake uses P-256, not secp256k1

**What:** Otedama's Stratum V2 transport encryption
(`internal/stratum/noise.go`) implements the Noise NX pattern. The
Stratum V2 specification mandates secp256k1 Diffie-Hellman with
ElligatorSwift encoding. In v3.0.0-alpha this is **stubbed with P-256**
(NIST curve), which satisfies the same `crypto/ecdh` interface but is
**not wire-compatible with a real Stratum V2 server's encrypted
channel**.

**Impact:** The encrypted-channel handshake will not interoperate with
production Stratum V2 pools that require secp256k1. The plaintext
Stratum V2 path and the Stratum V1 path are unaffected.

**Why:** secp256k1 + ElligatorSwift requires a secp256k1 library.
Adding one is in tension with ADR-003 (zero runtime dependencies); the
resolution (vendoring `decred/dcrd/dcrec/secp256k1` vs. a minimal
in-tree implementation) is an open decision.

**Workaround:** Use pools that accept the plaintext Stratum V2 or V1
transport during the alpha.

**Target:** v3.1.0. Tracked by the v3.1.0 "real protocols" milestone.
The handshake code is already structured so only the DH primitive and
the ElligatorSwift encoding need to change; the message flow is final.

**Related:** for the same reason (the secp256k1 dependency is decided in
ADR-011 but not yet added), the `internal/btccrypto` signature schemes
`ecdsa-secp256k1` and `schnorr-secp256k1` are registered as
**namespace-reserving stubs**: their `Name()` and registry/address-type
dispatch work, but `Verify`/`PublicKeyFromBytes`/`SignatureFromBytes`
return `ErrSchemeNotImplemented`. Mining does not sign anything
user-controlled, so this affects nothing today; it is resolved by the
same ADR-011 implementation step that replaces the Noise P-256 stub.

---

## ~~3. Engine connects to pools directly; poolproto not yet wired in~~ ✅ RESOLVED (session 91)

**Resolution:** `internal/engine/run.go` now dispatches Stratum V1 URLs
(`stratum+tcp://`, `stratum+tls://`) through `poolproto.DialURL` via the new
`runSessionV1` function. The blank import
`_ "github.com/shizukutanaka/Otedama/internal/poolproto/stratumv1"` in
`cmd/otedama/run.go` fires dialer registration at startup. Stratum V2 URLs
continue to use the existing inline `handshake` path.

**Integration progress (all steps complete):**
- ✅ Step 1 (session 37): URL-scheme parsing unified into `poolproto.knownSchemes`.
- ✅ Step 2 (session 38): `poolproto/stratumv2` dialer implemented and unit-tested.
- ✅ Step 3a (session 39): `engine.applyJob` bridges `poolproto.Job` → `miner.Work`.
- ✅ Step 3b (session 90–91): `Negotiate` stub replaced with full SV1 handshake
  (`mining.subscribe` + `mining.authorize`); `runSessionV1` added to engine;
  blank import registers the V1 dialer. The `poolproto` abstraction is now
  load-bearing for V1 connections at runtime.

---

## 4. GPU detection is Linux-only

**What:** Hardware detection of GPUs (`internal/hal`) reads Linux DRM
sysfs (`/sys/class/drm`). On Windows and macOS, the GPU driver is a
no-op stub that detects no GPUs.

**Impact:** On non-Linux hosts, only CPU devices are detected. Mining
and (simulated) inference still run on the CPU, but discrete GPUs are
invisible to the arbitration engine.

**Workaround:** Run on Linux for full GPU detection during the alpha.

**Target:** v3.7 (Windows/macOS GPU detection). Tracked by ADR-008
(hardware/power) sub-domain 2.

---

## 5. Post-quantum signature schemes are scaffolded, not active

**What:** `internal/btccrypto` registers ML-DSA and SPHINCS+ scheme
identifiers as TODO scaffolding. They are not implemented.

**Impact:** None today. Bitcoin's post-quantum signature support
(BIP-360 / P2MR) is not yet active on the network, so there is nothing
to interoperate with. The scaffolding exists so the scheme-registry
abstraction (ADR-006) is exercised and ready.

**Workaround:** Not applicable.

**Target:** v4.0, conditional on BIP-360 activation (which has ±2-year
timing uncertainty). Tracked by ADR-006 and the conditional-milestones
section of ROADMAP.md.

---

## 6. Lightning is receive-only; no embedded node

**What:** The Lightning capability (`internal/lightning`) holds a
BIP-39 seed (now the complete, integrity-checked 2048-word list — see
CHANGELOG session 32) and can register BOLT12-style payout proofs, but
does not run a Lightning node, manage channels, or send payments.

**Impact:** Payouts must terminate at a node you run elsewhere
(Phoenixd, Core Lightning, lnd, Alby Hub) or accumulate as on-chain
payouts via OCEAN's TIDES. Otedama cannot itself open channels or
splice during the alpha.

**Workaround:** Use an external Lightning node for payouts.

**Target:** External-node control v3.6; embedded LDK Node sidecar v3.7
(opt-in). Tracked by ADR-007 (Lightning capability expansion).

---

## ~~7. Mining-side yield uses static hashrate estimates~~ ✅ RESOLVED (session 225)

**Resolution:** `MiningProvider` now carries a `HashrateFunc func(deviceID string) float64`
field. `engine/setup.go`:`startProviders` sets it to a closure that looks up the worker
by device ID and calls `worker.Stats().HashRate`. Each `publish()` call samples the latest
live hashrate; when the engine has not yet produced a measurement (e.g. the first few
seconds after start) the return value is 0 and `publish()` falls back to the static
per-family estimate (ASIC ≈ 100 TH/s, GPU ≈ 1.5 GH/s, CPU ≈ 10 MH/s) rather than
emitting zero yield.

The remaining static input — the compile-time network-hashrate constant (≈ 1000 EH/s) —
is addressed by a live difficulty feed, which remains a v3.1.0 item. That does not affect
the relative arbitration accuracy on a given machine; it affects only the absolute
satoshi/second numbers (which move primarily with BTC price anyway).

---

## 8. ASIC hardware is not detected at all

**What:** Otedama's product definition names ASIC, GPU, and CPU hardware as
the three classes it arbitrates across. In v3.0.0-alpha.1, `internal/hal`
registers exactly two drivers — a built-in CPU driver and a Linux-only GPU
driver (`gpu_linux.go`/`gpu_stub.go`; see limitation §4). **No ASIC driver
exists.** `hal.FamilyASIC` and the per-family hashrate constant used as a
mining-yield fallback (`internal/provider/mining.go`, ≈100 TH/s) are defined,
but nothing in the codebase ever enumerates an ASIC as a `hal.Device` — the
family exists only as forward-compatible scaffolding.

**Impact:** A user who owns an Antminer, Whatsminer, or similar standalone
ASIC cannot have Otedama detect it, report its hashrate, or arbitrate its
workload — Otedama only ever sees the CPU (and, on Linux, any GPU) of the
host it runs on. For the majority of real-world Bitcoin hashrate, which is
ASIC-dominated, this means Otedama's arbitration engine currently has
nothing to arbitrate on the hardware class its own product definition lists
first. This does not affect CPU/GPU mining or payout correctness; it means
the ASIC side of the product definition is unimplemented, not degraded.

**Why:** Unlike CPU/GPU, an ASIC is not a local PCI/sysfs device — it is a
standalone network appliance running its own firmware (stock Bitmain,
Braiins OS+, LuxOS, VNish, DCENT_OS, or similar) that already connects
directly to a pool. Representing one as a `hal.Device` requires a different
integration shape than `miner.Worker` (which grinds SHA-256d in-process):
polling/controlling the appliance's own firmware control surface (HTTP/JSON,
firmware-dependent — there is no single standardized protocol across
vendors) rather than feeding it `Work` and reading back `Share`s over a
channel. This is a larger architectural piece than the CPU/GPU drivers, not
an oversight.

**Workaround:** Point ASICs at a pool directly (their normal mode of
operation) rather than through Otedama; run Otedama for CPU/GPU devices and,
optionally, for wallet/monitoring on the same network.

**Target:** v3.5, tracked by ADR-008 (hardware/power awareness layer)
sub-domain 1 ("ASIC firmware control surface"), scoped there at ~150 hours
across the five firmware dialects — the single highest value/cost item in
that ADR's roadmap.

---

## ~~9. TUI's "total sats earned" and "shares sent" are placeholder counters~~ ✅ RESOLVED (sessions 236–237)

**Resolution (two parts):**

- **"shares sent" (session 236):** `otedama_shares_submitted_total` is now a
  real counter incremented at the actual send point in both the V1
  (goroutine dispatch to `Submit`) and V2 (`sendMsg`) paths, distinct from
  `shares_found_total` — a share found by a worker but never submitted (its
  share channel was full) no longer inflates the TUI's "sent" figure.

- **"total sats earned" (session 237):** the former `TotalSatsEarned` field
  incremented by exactly `1` per accepted share — a placeholder unrelated to
  real income (Stratum carries no monetary value on the wire; the pool
  credits a share by difficulty and payout scheme, never one sat each). It
  is replaced by a `satsAccountant` that integrates the engine's own
  forecast rate (`otedama_arbitration_expected_yield_sats_per_second`) over
  the wall-clock time actually spent hashing productively — so the figure now
  tracks BTC price, share difficulty, and downtime, none of which the
  placeholder reflected. The TUI field is renamed `EstSatsEarned` and
  displayed as **"est. earned: ~N sats"** to make clear it is an estimate,
  not the pool's authoritative accounting (which remains the source of truth
  for a real balance).

The estimate deliberately gates on the same productive flag as the
uptime accounting (hashing, not stalled, not curtailed), so idle time never
accrues phantom earnings, and it reads 0 when metrics are disabled or before
the first arbitration quote arrives rather than fabricating a number.

---

## ~~10. Stratum V1 pool password is accepted in config but has no effect~~ ✅ RESOLVED (session 235)

**Resolution:** `runSessionV1` previously constructed its
`poolproto.Credentials` with a hardcoded `Password: "x"`, ignoring
`PoolConfig.Password` entirely (the V1 dialer itself already correctly
forwarded whatever password it was given into `mining.authorize` — the gap
was one call site upstream, in the engine's session setup, not the
protocol layer). `sessionOpts` now carries a `poolPassword` field populated
from `cfg.Pools[poolIdx].Password` at session-loop construction time;
`runSessionV1` uses it when non-empty and falls back to the pre-existing
`"x"` convention when no password is configured, so unconfigured setups
(the common case) are unaffected. Verified end-to-end against a fake V1
pool that captures and inspects the raw `mining.authorize` wire request.

---

## ~~11. Stratum V2 mining path could not produce a valid share~~ ✅ RESOLVED (session 238)

**What was broken (previously undisclosed):** five compounding defects in
`internal/stratum` and `internal/engine/run.go` together meant a real V2
pool connection could never actually earn anything, despite
KNOWN_LIMITATIONS describing the Bitcoin mining path as real:

1. `NewMiningJob`'s wire layout was wrong — it carried a spurious `nBits`
   field and omitted the block-header `version` entirely. Decoding a real
   pool's frame would read the pool's `version` into `NBits` and shift the
   merkle root out of place.
2. `SetNewPrevHash` (0x20) and `SetTarget` (0x21) did not exist at all —
   no constants, no structs, no dispatch — so the miner never learned the
   previous block hash, the network `nBits`, or share-difficulty updates.
3. `updateWork` populated only `MerkleRoot`/`Time`/`Bits` on the header,
   leaving `Version` and `PrevHash` at zero. Every hashed header was
   structurally invalid regardless of what a pool sent.
4. Workers mined against the *network* target
   (`TargetFromNBits(job.NBits)`) while the pool-assigned share target
   from `OpenMiningChannelSuccess` was decoded and discarded — expected
   share rate was effectively zero (a share is a full block solve at
   network difficulty).
5. Submitted `NVersion` was hardcoded `0x20000000` regardless of what was
   actually hashed, so even a correctly-hashed share would echo the wrong
   version back to the pool.

**Resolution:** `NewMiningJob` now matches the SV2 spec (`min_ntime` is a
proper `OPTION[u32]`, `version` replaces the phantom `nBits`).
`SetNewPrevHash`/`SetTarget` are implemented with full Encode/Decode and
wired into `DispatchFrame`. The engine's session loop implements the SV2
activation semantics: a job is mined only once both the job and its chain
tip are known (a job without `min_ntime` is a *future job* held until the
`SetNewPrevHash` naming it arrives); `SetNewPrevHash` invalidates every
other outstanding job; `handshake()` returns the channel's initial share
target, `SetTarget` updates it live, and `miner.Work.Target` is always the
pool-assigned share target (falling back to the network target only if
the pool assigned none). `miner.Share` now carries the exact `Version` of
the header that was hashed, and the submit path echoes it.

**How it was verified:** an end-to-end engine test against a fake pool
that drives the full activation sequence (`NewMiningJob` → `SetNewPrevHash`
→ share arrives) and asserts the submitted share's `NVersion` matches the
job's distinctive version; a `poolproto/stratumv2` adapter test proving a
future job is emitted only after its `SetNewPrevHash`, with `Version`/
`PrevHash`/`NBits`/`NTime` all populated from the right message; Encode/
Decode round-trip tests for the new and corrected message types.

**Note:** this fixes the engine's inline SV2 path (`internal/engine/run.go`,
the one actually used today per §3 above) and mirrors the same fix into
the `internal/poolproto/stratumv2` adapter so it does not regress once
wired in. A related, lower-severity gap remains open and is tracked in
`docs/RESEARCH_IMPROVEMENTS.md` Category 10 item 2: clamping the channel
target to `max_target` on every vardiff update, which is moot for now
since Otedama never sends a `max_target` preference to the pool in the
first place (`OpenMiningChannel` intentionally omits it — see the field's
removal note in `internal/stratum/handshake.go`). The Noise NX secp256k1
gap is unrelated and already tracked at §2 above.

---

## ~~12. TUI dashboard froze on stale "connected" data during outages; provider status was always fabricated~~ ✅ RESOLVED (session 239)

**What was broken (previously undisclosed):**

1. `buildStats`'s `Connected: true` is only ever produced from inside an
   active session's stats tick — nothing called `dashboard.Update` while a
   pool session was down (mid-reconnect backoff). The dashboard therefore
   froze on its last "✓ connected" frame for the entire outage, showing a
   stale hashrate/earnings snapshot that looked like mining was proceeding
   normally when it was not. `dashboard.go`'s "✗ disconnected" render path
   existed and worked correctly — it was simply never invoked.
2. Every configured provider rendered `Active: true` unconditionally with
   `SatsPerSecond: 0`, regardless of whether arbitration was actually
   routing any device to it. A provider that was quoting but never chosen
   (or never quoting at all) looked identical to one earning in real time.

**Resolution:**

- `runReconnectLoop` now pushes a `disconnectedStats` snapshot to the
  dashboard immediately after a session ends, before backing off —
  `Connected: false`, live figures zeroed rather than echoing stale
  pre-disconnect values (this snapshot genuinely does not know the
  current hashrate/shares).
- The arbitration loop now maintains a shared, mutex-protected
  `providerID → assigned yield` snapshot, rewritten after every `Decide()`
  cycle from `Allocation.Assignments` (excluding idle assignments).
  `buildStats` reads it: a provider is `Active` only if arbitration is
  currently routing at least one device to it, and its `SatsPerSecond` is
  the real assigned yield, not a placeholder.

**Also fixed in the same pass (found via `go test -race`, not the initial
audit):** `Dashboard.Stop()` closed its done-channel and immediately wrote
to the terminal itself (`showCursor`/`Fprintln`) without waiting for a
concurrently in-flight `render()` call to finish its own writes to the
same `io.Writer` first — a genuine data race, reproducible under `-race`.
`Stop()` now waits on a `sync.WaitGroup` the render loop signals on exit
before touching the writer itself.

**Also fixed:** section headers (`⛏ MINING`, `💰 EARNINGS`, etc.) used
emoji, which render at visible width 2 in virtually every terminal while
`visibleLen` (used for the fixed-repaint padding math) counts every rune
as width 1 — under-padding those specific lines and risking stray
characters left over from a longer previous frame. Headers are now plain
bold text. Separately, `writeLine` never truncated content longer than
the detected terminal width, so a narrow terminal (as low as the
documented 40-column minimum) could wrap a line onto a second terminal
row, breaking the "cursor home, overwrite in place" repaint model for
every line after it; content longer than `cols` is now truncated to fit.

---

## How to verify the real vs. simulated boundary yourself

- **Mining (real):** `otedama run --bitcoin-address bc1q...` connects to
  a real Stratum pool and submits real shares.
- **Inference (simulated):** any provider whose name ends in
  "(simulated)" is modelled, not live.
- **Self-check:** `otedama doctor` runs diagnostic checks; `otedama
  config show` prints the effective configuration including provider
  names.

If you find a behaviour that is simplified or stubbed but **not** listed
here, that is a documentation bug — please open an issue. Honesty about
limitations is a project value, not an afterthought.

---

*Last updated: v3.0.0-alpha.1. This file is maintained alongside the
code; each limitation is removed from this list in the same release that
resolves it.*
