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

## ~~1. AI inference yield is simulated, not live~~ ✅ RESOLVED (session 264 — by deletion)

**What it was:** `AkashProvider` (`internal/provider/ai_inference.go`)
quoted a fixed price — the midpoint of a hardcoded `MinUSDPerHour`/
`MaxUSDPerHour` band, unchanging tick to tick. It never queried the Akash
REST API, submitted a bid, or earned anything. It was nonetheless started
by default and its quote flowed into the arbitration engine, the TUI's
headline "sats/day" figure, and
`otedama_arbitration_expected_yield_sats_per_second`.

**Why it was deleted rather than disclosed.** The "(simulated)" suffix on
the provider's display name did its job in the provider list, but the
number the user actually reads — the big yellow sats/day figure — carried
no such marking, and on a host with a GPU the fabricated component
outweighed real mining revenue by roughly five orders of magnitude. A
disclaimer next to a wrong number is not the same as a right number.
CLAUDE.md also prohibits speculative features ahead of a production
implementation, and a market that reports a constant is exactly that.
Nothing of value was preserved by keeping it: a real integration is
written against a live API and shares no code with a constant.

**What survives for the real integration:** the `Provider` interface,
`RateSource`, the polling lifecycle in `internal/provider/polling.go`, and
an arbitration engine that already routes across an arbitrary number of
streams and is tested with several.

**Consequence today:** Bitcoin mining is the only market. A detected GPU is
compatible with no revenue stream and stays idle, which is the truth about
what Otedama can do with a GPU (see §4). The dashboard's earnings rate is
now the sum of what arbitration is actually routing devices to, so it is
zero when nothing is allocated rather than showing a would-be rate.

**Target for a real AI-inference market:** v3.1.0. Tracked by ROADMAP
v3.1.0 and ADR-010 (arbitration engine evolution) §A4 (strategic bidding).

---

## 2. Noise NX transport encryption is not wired into any live connection; use stratum+v2tls:// for real confidentiality

**What (revised session 240 — the previous wording of this entry
significantly understated the gap):** `internal/stratum/noise.go`
implements pieces of the Noise NX pattern, but three separate problems
mean it provides no real security today, and the engine's actual pool
connection never uses it in the first place:

1. **The engine's live connect path never calls it at all.**
   `internal/engine/run.go`'s `runSession` — the code that actually runs
   when you `otedama run` against a `stratum+v2://` pool — dials a plain
   `net.Dialer` and speaks Stratum V2 in the clear. `NewHandshakeInitiator`
   and `EncryptedConn` are fully unit-tested but have zero callers outside
   `internal/stratum`'s own test files. A user connecting to
   `stratum+v2://` gets no transport encryption, full stop — not a
   downgraded/incompatible encryption, none at all. The Bitcoin payout
   address (sent as `OpenMiningChannel.User`) travels in plaintext.
2. **The DH primitive is P-256, not the spec-mandated secp256k1 +
   ElligatorSwift** — even if the handshake were wired in, it would not
   be wire-compatible with a real Stratum V2 pool's encrypted channel.
   Adding a secp256k1 library is in tension with ADR-003 (zero runtime
   dependencies); resolution is an open decision tracked by ADR-011.
3. **The handshake itself has a structural gap beyond the DH primitive.**
   `ReadMessage2`'s "x-only" fallback branch (when the responder's
   ephemeral key doesn't parse as P-256 uncompressed/compressed) derives
   transport keys from `mixHash` alone — no Diffie-Hellman at all — so an
   on-path observer who sees the same public handshake messages can
   derive the same keys. Separately, `mixKey`'s HKDF output `k` (meant to
   become the handshake cipher key) is computed and then discarded
   (`_ = k`), and no code anywhere authenticates a responder static key —
   the defining property the "NX" pattern name refers to. These are not
   "swap the DH primitive" fixes; the message flow itself needs rework,
   contrary to what this entry previously claimed ("only the DH primitive
   ... needs to change; the message flow is final").

**Impact:** `stratum+v2://` (the default V2 scheme) carries no transport
encryption in any configuration. There is no way to get spec-compliant
Stratum V2 Noise encryption today regardless of configuration.

**What actually IS available today (session 240):** `stratum+v2tls://`
now performs a real, certificate-verified TLS 1.2+ handshake via Go's
standard `crypto/tls` (`internal/stratum/tls.go`, mirroring the identical
fix already applied to Stratum V1's `stratum+tls://` scheme). This is
**not** the Stratum V2 spec's Noise NX — it's TLS wrapping the same
plaintext V2 protocol — but it is real confidentiality against a
network eavesdropper for a pool that terminates TLS, using only
standard-library cryptography. Before this fix, `stratum+v2tls://` was
registered as a valid URL scheme but silently downgraded to the exact
same plaintext connection as `stratum+v2://` — a configured "TLS" pool
gave zero transport security with no indication anything was wrong.
Connecting over plain `stratum+v2://` now also logs an explicit warning
at connect time (`engine: connecting over plaintext Stratum V2 — no
transport encryption`) so an operator watching logs is told, rather than
having to already know to check this document.

**Workaround:** Use `stratum+v2tls://` for a TLS-terminating pool, or the
V1 fallback (`stratum+tls://`, also real TLS) for a pool that supports
it. Neither is spec-compliant Stratum V2 Noise encryption, but both are
real transport security today.

**Target:** v3.1.0 for spec-compliant Noise NX (secp256k1 +
ElligatorSwift + full message-flow rework + responder authentication).
Tracked by the v3.1.0 "real protocols" milestone and ADR-011.

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

## 4. GPU detection is Linux-only, and detected GPUs cannot mine

**What:** Hardware detection of GPUs (`internal/hal`) reads Linux DRM
sysfs — specifically the **render nodes** (`/sys/class/drm/renderD*`), not
the card nodes. The kernel always creates a card node for any DRM device
but creates a render node only for drivers that advertise `DRIVER_RENDER`,
so this narrowing is what separates a GPU that accepts compute clients from
display-only hardware such as a server's BMC chip or a simpledrm
framebuffer. Every GPU that could plausibly do compute advertises it
(amdgpu, i915/xe, nouveau, and NVIDIA's nvidia-drm), so nothing usable is
missed; a DRM device without render support is excluded by design
(clarified session 262, with the reasoning and its sources in
`internal/hal/gpu_linux.go`'s package doc). On Windows and macOS, the GPU
driver is a no-op stub that detects no GPUs. Separately, on any platform: no
CUDA, ROCm, or Vulkan compute dispatch is implemented anywhere in this
codebase, so a detected GPU always reports `Capabilities.SHA256d =
false` (corrected session 243 — this field was previously hardcoded
`true`, which caused `engine.startMinerWorkers` to spawn a second,
full-thread-count CPU-only mining pool mislabeled under the GPU's
device ID for every detected GPU: 2x thread oversubscription, and
every share that pool found was misattributed to the GPU in
`otedama_device_shares_found_total` and the live hashrate sampling
used by the arbitration engine).

**Impact:** On non-Linux hosts, only CPU devices are detected. Where a
GPU is detected (Linux only), it is visible to the arbitration engine
and eligible for the simulated AI-inference stream (§1) via its
`GeneralCompute` capability, but it contributes zero Bitcoin-mining
hashrate — mining always runs on the CPU only, regardless of platform
or GPU presence.

**Workaround:** Run on Linux for GPU detection (needed only for the
simulated AI-inference stream) during the alpha. There is no
workaround for GPU mining; it requires a compute-dispatch driver that
does not exist yet.

**Target:** v3.3.0, 2027 Q1 (Windows/macOS GPU detection — corrected
session 245; this previously said v3.7, contradicting ROADMAP.md's
"Observability and ops" milestone, which is the authoritative target).
GPU SHA256d mining dispatch has no committed target; it is not on the
current roadmap. Tracked by ADR-008 (hardware/power) sub-domain 2.

---

## ~~5. Post-quantum signature schemes are scaffolded, not active~~ ✅ RESOLVED (session 264 — by deletion)

**What it was:** `internal/btccrypto` carried an `AddressP2MR` constant, a
`String()` case for it, a `SchemeForAddressType` case returning
"not yet implemented", and a package-doc timeline stating
"2028–2032: BIP-360 introduces P2MR … combining secp256k1 + ML-DSA
(Dilithium) + SPHINCS+".

**Removed, for three reasons:**

- **Nothing could produce the value.** No address parser in the package
  returns `AddressP2MR` — `bech32.go` rejects witness versions 2–16
  outright — so the constant was unreachable and its guard clause guarded
  against a value that could not exist.
- **The timeline was wrong by this repository's own research.** Session 251
  established from the primary source that BIP-360 is Status: Draft, is
  titled "Pay-to-Merkle-Root (P2MR)", and defers post-quantum signatures to
  a separate proposal that has not been written. A dated forecast for an
  unwritten BIP is a guess presented as a schedule.
- **CLAUDE.md prohibits starting quantum-resistance work at this stage.**
  Scaffolding is starting it in the way that costs most and delivers least:
  the code carried maintenance and reader attention without carrying any
  capability. No ML-DSA or SPHINCS+ scheme was ever registered — only the
  two secp256k1 stubs are.

**What remains, and why it is enough:** `Scheme` and `SchemeForAddressType`
are the actual seam, and both stayed. Adding a signature scheme is a
`Register` call and one switch case, whenever there is something real to
register. The seam was never the unreachable constant.

**Target for actual post-quantum support:** v4.0 or later, gated on a
future PQ signature BIP downstream of BIP-360 that does not yet exist.
Tracked by ADR-006 and the conditional-milestones section of ROADMAP.md.

---

## 6. Lightning is receive-only; no embedded node

**What:** The Lightning capability (`internal/lightning`) holds a
BIP-39 seed (the complete, integrity-checked 2048-word list — see
CHANGELOG session 32) at rest, encrypted with a user passphrase. That is
the entire capability today: `WalletManager`'s public surface is
seed/mnemonic storage and retrieval (`Seed`, `Fingerprint`, `Mnemonic`,
`ChangePassphrase`) — nothing more. It does not run a Lightning node,
manage channels, send payments, or register payout proofs of any kind
(corrected session 243: this entry previously claimed it "can register
BOLT12-style payout proofs," which no code anywhere in the repository
implements — confirmed by a repo-wide search finding zero references to
BOLT12 or payout proofs outside this one now-corrected sentence).

**Impact:** Payouts must terminate at a node you run elsewhere
(Phoenixd, Core Lightning, lnd, Alby Hub) or accumulate as on-chain
payouts via OCEAN's TIDES. Otedama cannot itself open channels or
splice during the alpha.

**Workaround:** Use an external Lightning node for payouts.

**Target:** External-node control v3.6; embedded LDK Node sidecar v3.7
(opt-in). Tracked by ADR-007 (Lightning capability expansion).
**Note (session 251, verified):** LDK Node v0.7.0 (2025-12-03) is the
current release and adds experimental channel splicing and async
payments (on rust-lightning v0.2, MSRV rustc 1.85); BOLT12 shipped
earlier. So the v3.7 sidecar can target LDK Node ≥ v0.7.0 — but note it
is a Rust component (subprocess/FFI sidecar, not in-Go), which is the
correct integration shape for a zero-Rust-dependency Go binary.
(Source: github.com/lightningdevkit/ldk-node/releases)

---

## ~~7. Mining-side yield uses static hashrate estimates~~ ✅ RESOLVED (session 225)

**Resolution:** `MiningProvider` now carries a `HashrateFunc func(deviceID string) float64`
field. `engine/setup.go`:`startProviders` sets it to a closure that looks up the worker
by device ID and calls `worker.Stats().HashRate`. Each `publish()` call samples the latest
live hashrate; when the engine has not yet produced a measurement (e.g. the first few
seconds after start) the return value is 0 and `publish()` falls back to the static
per-family estimate (ASIC ≈ 100 TH/s, GPU ≈ 1.5 GH/s, CPU ≈ 10 MH/s) rather than
emitting zero yield. Note (session 243): `publish()` skips any device whose
`Capabilities().SHA256d` is false before reaching this fallback, and no GPU
device in this codebase ever reports `SHA256d: true` (§4 above) — the GPU
branch of the static estimate is therefore unreachable today and exists only
as forward-compatible scaffolding for a future GPU SHA256d driver.

The remaining static input — the compile-time network-hashrate constant (≈ 1000 EH/s) —
is addressed by a live difficulty feed, which remains a v3.1.0 item.

**Corrected session 259 — this entry previously understated that gap.** It claimed the
constant "does not affect the relative arbitration accuracy on a given machine; it affects
only the absolute satoshi/second numbers (which move primarily with BTC price anyway)".
Two things are wrong with that:

- The satoshi figure does **not** move with BTC price. The quote is denominated in
  satoshis, and the price only sets the quote's `Confidence`
  (`TestMiningYield_IsIndependentOfBTCPrice` pins this). What moves with price is the USD
  value of that constant satoshi rate.
- The constant scales the mining side of the comparison **only**. Arbitration weighs
  mining (sats/sec) against inference (quoted in USD and converted), so a network-hashrate
  constant that has drifted away from the real network biases *that* comparison — which is
  the decision the product exists to make. The original claim holds only in the narrower
  case of comparing two devices' mining yield against each other on the same machine,
  where the constant cancels.

Concretely: the constant implies a network difficulty of ≈ 140 T (H × 600 / 2^32). If the
real network moves to 280 T while the constant stays put, every mining quote is overstated
2× against the inference quote it competes with. Until the live feed lands, an operator
comparing markets should treat the mining figure as an estimate anchored to a 2026
snapshot, not a live measurement.

**Related, found in the same pass:** `MiningProvider`'s own doc comment claimed the yield
was "estimated from the pool's reported difficulty" and refreshed on nBits changes and on
5% hashrate moves. None of those existed — the pool's difficulty never reaches
`internal/provider` at all, and quotes are published on a plain 30-second ticker. The
comment has been corrected to describe the constant-driven model that is actually
implemented, and `internal/provider/mining_yield_test.go` now pins the revenue formula
itself (previously no test checked the yield's magnitude — only that it was greater than
zero, which a yield wrong by 2^32 would satisfy).

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
wired in. The Noise NX secp256k1 gap is unrelated and already tracked at
§2 above.

**Follow-up (session 256):** session 238 fixed what the messages *mean*;
it did not check what they *look like on the wire*. §18 below records five
field-level deviations from the specification found afterwards — including
two that stop the handshake outright — and the `max_target` question this
note previously called moot: `OpenMiningChannel` now sends the field
(it is mandatory), so the clamp discussed in
`docs/RESEARCH_IMPROVEMENTS.md` Category 10 item 2 is no longer moot,
though it is still not implemented.

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

## 13. CI workflows — PARTIALLY RESOLVED (session 264): three dead files deleted; dead jobs in three others still need a maintainer push

**What it was:** six of seven `.github/workflows/*.yml` files had real
problems, from "fails deterministically on every push" to "silently a
no-op". Every claim was re-verified in session 264 before acting:
`package.json`, `kubernetes/`, `helm/`, `k8s/`, `scripts/`, and `tests/`
are all absent from this repository, and `ci-cd.yml` pinned Go 1.20/1.21
against a `go 1.22` module, so those legs could not satisfy the module
declaration.

### Resolved — three files deleted outright

No job in any of them described work this repository does:

- **`deploy.yml`** — `npm ci`/`npm test` on every push to `main`/`develop`
  and every PR to `main`, in a Go repo with no `package.json`; then
  `helm upgrade --install ./kubernetes/helm/otedama` against a chart that
  does not exist.
- **`ci-cd.yml`** — a duplicate "CI/CD Pipeline" sharing `ci.yml`'s
  workflow name, with a Go matrix below the module minimum and another
  `k8s/deployment.yaml` apply.
- **`code-review.yml`** — written entirely around a Node/npm toolchain
  (ESLint via reviewdog, `npx complexity-report`, `npx size-limit`, a
  `scripts/code-review/generate-comment.js` that does not exist) behind a
  `has_node` check that is always false here. It never reviewed a line of
  Go; it only posted "no Node.js project detected".

### Still open — dead jobs inside `ci.yml`, `security.yml`, `release.yml`

These were prepared and verified in session 264 but **could not be
pushed**: the GitHub App used by that session may delete a workflow file
but not modify one ("refusing to allow a GitHub App to create or update
workflow `.github/workflows/ci.yml` without `workflows` permission").
Deletions went through; edits did not. The surgery is recorded here
exactly, so a maintainer can apply it in one pass:

- **`ci.yml`** — remove the jobs `docker-verify` and
  `docker-verify-windows` (they run `scripts/verify-docker.sh`/`.ps1`,
  which do not exist, and poll `http://localhost:8082/health`, a path the
  server does not serve — `internal/httpserver` exposes `/healthz` and
  `/readyz` — against containers started with no
  `--bitcoin-address`/`--http-addr`, so per the Dockerfile's default
  `CMD ["run", "--help"]` nothing ever listens on 8082 regardless of
  path); `docker-verify-cgo0-postgres` (spins up `postgres:15` and passes
  `OTEDAMA_DATABASE_DRIVER`/`OTEDAMA_DATABASE_CONNECTION_STRING` for a
  database layer that does not exist, and config fields that do not exist
  in `internal/config`); and `deploy-staging`/`deploy-production` (apply
  `k8s/*.yaml`). **Then change `release`'s `needs:` to
  `[build, build-unified, docker, docker-unified]`** — leaving it naming
  the removed `docker-verify*` jobs makes the whole workflow invalid
  rather than merely reduced.
- **`security.yml`** — remove the `security-tests` job (runs
  `go test ./tests/security/...` and `./tests/load/...`; there is no
  `tests/` directory, so both steps fail with "matched no packages").
  **Then remove `security-tests` from `security-report`'s `needs:`**,
  leaving `[security-scan, container-scan, compliance-check]`.
- **`release.yml`** — remove the `build-packages` job (`.deb`/`.rpm` via
  `fpm`, referencing `scripts/post-install.sh`, `scripts/pre-remove.sh`,
  `scripts/otedama.service`, and a root `config.yaml`, none of which
  exist). Nothing depends on it, so no `needs:` edit is required.
- **Every Go job in all three surviving files** — update the Go pins to
  1.24.x. `ci.yml` sets `GO_VERSION: '1.23.x'` and a
  `go: ['1.22.x', '1.23.x']` test matrix, `release.yml` pins 1.23.x, and
  `security.yml` pins 1.21 — while `go.mod` carries
  `godebug tlsmlkem=1`, a setting that exists only from Go 1.24
  (`GODEBUG_NOTES.md`; it was `tlskyber` on the 1.23 draft). A pre-1.24
  toolchain rejects the unknown godebug key at module parse, so **every
  Go job in the surviving workflows fails deterministically before
  compiling a line**, today, independent of the dead jobs above. This is
  the highest-impact item in this section and, like the rest, needs a
  maintainer push — the session-264 GitHub App could delete workflow
  files but not modify them.

With those applied, all four remaining workflows parse as YAML, every
`needs:` names a job in the same file, and no reference to
`package.json`, `npm ci`, `helm`, `kubernetes/`, `k8s/`, `scripts/`, or
`tests/` survives under `.github/workflows/` — verified statically in
session 264 against the edited files before they were reverted.

**Not verified in either state:** no workflow has been observed running
green on GitHub from that session. The checks are static — YAML parse,
dependency graph, path existence.

**Also corrected:** CLAUDE.md's architecture map described `test.yml` as
`test.yml (fuzz+benchmark)`; its actual jobs are `test`, `lint`,
`security`, `build`, `integration`, `benchmark`. The map now lists the
files that exist.

---

## 14. DATUM is a reserved URL scheme, not an implemented protocol

**What:** `internal/poolproto`'s `ProtocolDATUM` constant and the
`datum://` URL scheme are recognized by `FromURL`/`StripScheme`, and
prior to session 248 the package doc comment and
`internal/poolproto/stratumv1/stratumv1.go`'s "what this file does
NOT do" note both described DATUM in present-tense, "Otedama can
speak..." language. In reality, no `Dialer` is registered for
`ProtocolDATUM` anywhere in the codebase (only `stratumv1` and
`stratumv2` call `poolproto.Register` in `init()`), and no
`internal/poolproto/datum` package exists.

**Impact:** `poolproto.DialURL("datum://pool.example.com:3334")`
returns `ErrUnknownProtocol`. Users who configure an OCEAN pool via
its DATUM endpoint cannot connect through Otedama; OCEAN must be used
via its SV1-transport-compatible endpoint instead, if it offers one.

**Workaround:** Configure OCEAN (or any DATUM-only pool) via a
Stratum V1 or V2 endpoint if the pool operator provides one.

**Design note (session 251, primary-source verified):** the DATUM
Gateway (OCEAN-xyz/datum_gateway) is **MIT-licensed**, a public
**BETA**, requires a full Bitcoin node, and miners connect to it over
**Stratum V1 with version-rolling (ASICBoost) — it does NOT support
Stratum V2**. This confirms the planned implementation shape: `datum://`
should be an **SV1-transport dialer reusing `poolproto/stratumv1`**, not
a new binary protocol, and the MIT license means the reference
gateway's wire format can be studied directly. (Disregard a stray
third-party claim of GPL-3.0 — the gateway README says MIT. Source:
raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md)

**Target:** Tracked by `docs/adr/ADR-009` (status: Proposed — pool
decentralization integration, covering JDC/DATUM/solo). No committed
release target.

---

## ~~15. TUI dashboard renders at a fixed 80 columns; real terminal width is never detected~~ ✅ RESOLVED on Linux (session 264)

**What it was:** `NewDashboard` set 80 columns and `SetWidth` — the injection
point for a real width — was called by nothing outside tests, so the
dashboard ran at 80 columns whatever the terminal actually was.

**Why it mattered beyond looks.** The repaint moves the cursor home and
overwrites a fixed number of lines. On a terminal narrower than 80, every
line wraps, each wrap consumes an extra screen row, and the offsets stop
lining up: the dashboard degrades into overlapping fragments rather than
merely looking cramped. On a wider terminal the cost was only unused space.

**Resolved:** on Linux the width is read from the writer's file descriptor
with the `TIOCGWINSZ` ioctl (`internal/tui/width_linux.go`) and re-read once
per render tick, so a mid-session resize is followed within a second without
a `SIGWINCH` handler. A reported width below the 40-column design floor is
clamped to it. Tests drive a real pseudo-terminal rather than a stub, since
the struct layout and the offset of `ws_col` are exactly what a stub cannot
check — getting that offset wrong would silently report the row count.

Fixing this also removed a latent data race: `cols` was a plain `int` written
by `SetWidth` and read by the render loop. It is now `atomic.Int32`.

**Still open — other platforms.** macOS, the BSDs, and Windows keep the
80-column default. The BSD family uses a different `TIOCGWINSZ` value and
reaches ioctl through libc trampolines rather than `syscall.Syscall`;
Windows needs `GetConsoleScreenBufferInfo`. Writing either without being
able to run it would be guessing, so `terminalWidth` returns "unknown"
there and the dashboard behaves exactly as it did before. This mirrors the
existing Linux-only scope of GPU detection (§4).

**Workaround on those platforms:** none needed at 80 columns or wider; below
that, widen the terminal or run with `--no-tui`.

**Target for macOS/Windows:** no committed date. The natural moment is when
someone can test on the platform; the detection is one function behind a
build tag, so adding a platform is a single file.

---

## ~~16. No `wallet` subcommand: the recovery phrase cannot be verified, and the passphrase cannot be changed, from the CLI~~ ✅ RESOLVED (session 264)

**Both halves are closed.** `cmd/otedama/wallet.go` adds
`otedama wallet verify` and `otedama wallet change-passphrase`. Neither
required a change to `internal/lightning`: every piece was already exported
and tested, and both commands are thin wrappers that add the operator-facing
safety a library function cannot.

### `wallet verify` — the backup can finally be checked

Reads a recovery phrase from stdin, derives its seed, and compares it in
constant time against the seed in `wallet.dat`. Exit 0 on match, 1 on
mismatch.

This closes the gap that mattered: Otedama prints the phrase exactly once
and cannot re-derive it later, so a transcription error was silent and
surfaced only during a recovery attempt, when it is too late. Verification
now happens while the user still holds both the phrase and a working wallet,
which is the only moment it can.

The phrase never comes from argv (visible in `ps` and shell history) and is
never echoed back, logged, or written; the command refuses to run when no
wallet exists rather than letting `lightning.NewWalletManager` take its
create-a-new-wallet path. The two failure causes are reported distinctly
because they need different fixes: an invalid BIP-39 mnemonic (misspelled or
dropped word — caught by the checksum) versus a valid mnemonic that is not
this wallet's (wrong word order, or a BIP-39 "25th word" missing from
`OTEDAMA_WALLET_MNEMONIC_PASSPHRASE`).

### `wallet change-passphrase` — rotation is reachable

`lightning.WalletManager.ChangePassphrase` was implemented, atomic, and
covered by tests, but no production code called it, so a user whose
passphrase might have been exposed could not rotate it without writing their
own Go program against an internal package. It is now wired up.

The current passphrase comes from `OTEDAMA_WALLET_PASSPHRASE`; the new one
is read from stdin twice and the two must match, because a typo here would
otherwise lock the user out of their own wallet. Nothing is written unless
the current passphrase decrypts the existing wallet, and the replacement is
an atomic rename after the new file is written, synced, closed, and chmodded
0600 — a failure at any point leaves the old file in place.

**The fingerprint check is the safety property, not decoration.** Rotation
must re-encrypt the *same* seed; if the fingerprint changed, the phrase the
user wrote down would no longer describe the wallet on disk, silently. The
command re-opens the rewritten wallet under the new passphrase, compares the
fingerprint with the one it read before, and treats a difference as a
failure rather than reporting success.

**Verified end to end with the real binary:** a wallet created by
`otedama run`, rotated, then checked — the fingerprint is unchanged
(`6c993fa2`), the old passphrase no longer opens the wallet, the original
24-word phrase still verifies as MATCH under the new passphrase, and
`otedama doctor` reports the same fingerprint.

**One bug found and fixed by these tests:** `readLine` originally built a
fresh `bufio.Scanner` per call. A Scanner buffers ahead, so the first read
swallowed the confirmation line and the command failed with "no input was
given" after the user had typed everything correctly. Both reads now share
one scanner, and a test pins that the second read sees the second line.

---

## ~~17. Stratum V1 mining path could not produce a valid share~~ ✅ RESOLVED (session 255)

**What was broken (previously undisclosed):** the Stratum V1 path — the
fallback this document recommends for pools that do not speak V2, and the
protocol >99% of Bitcoin pools actually run — had the same class of defect
that §11 above fixed for Stratum V2, in five compounding parts. A V1
connection completed its handshake, received jobs, and submitted shares
that no pool could ever credit:

1. **The merkle root was never computed.** V1 does not send a finished
   merkle root: it sends the two halves of the coinbase transaction plus a
   merkle branch, and the *miner* assembles `coinb1 ‖ extranonce1 ‖
   extranonce2 ‖ coinb2`, hashes it, and folds the branch. `parseNotify`
   discarded all three fields ("Otedama doesn't reconstruct the coinbase in
   the V1 path (the pool does)" — which is not how V1 works), so every job
   carried an all-zero merkle root.
2. **The header's version and previous-block hash were dropped.**
   `parseNotify` decoded both correctly, then `applyJob` built
   `miner.Header` from only merkle root, time and bits — the identical
   omission §11 item 3 describes for V2.
3. **The previous-block hash byte order was never converted.** V1 sends it
   with its eight 4-byte words in reverse order; using those bytes as-is
   yields a header committing to a block that does not exist.
4. **Non-numeric job IDs were refused outright.** `applyJob` parsed the
   job ID with `fmt.Sscanf("%d")` and returned an error when that failed,
   and the submit path rebuilt the string with `fmt.Sprintf("%d")`. Real
   V1 job IDs are arbitrary strings (`"6a4f"`, ids with leading zeros), so
   on most pools every job was rejected before mining started, and on the
   rest the submitted ID was not the one the pool issued.
5. **`mining.submit` sent a hardcoded worker name.** Every submission went
   up as worker `"otedama"` regardless of the name `mining.authorize`
   succeeded with, which a pool answers with an unauthorised-worker
   rejection. The extranonce2 was likewise a zero placeholder unrelated to
   any coinbase, so even a correct header would not have been
   reconstructible pool-side.

Separately, `extranonce1`/`extranonce2_size` were written by the read-loop
goroutine (`mining.set_extranonce`) and read by `Submit` on the caller's
goroutine with no synchronisation — a data race on the values that define
the coinbase.

**Resolution:** the miner-side header construction V1 requires now exists
in `internal/poolproto/stratumv1/work.go` (coinbase assembly, merkle fold,
prev-hash word swap, extranonce2 generation), each piece pure and unit
tested. The session picks a fresh extranonce2 per job, records it, folds it
into the merkle root, and echoes that exact value on submission, together
with the authorised worker name and the pool's own job ID string — carried
end-to-end as `miner.Work.JobKey`/`miner.Share.JobKey` rather than squeezed
through a uint32. All negotiated state moved behind a mutex. Malformed
notifications are now rejected whole (matching cpuminer's field-length
validation) instead of mined with zeroed fields.

**How the byte orders were established:** Stratum V1 has no specification
document, so the rules were taken verbatim from the canonical
implementation on each side of the wire — pooler/cpuminer
(`stratum_notify`, `stratum_gen_work`) for the client and
zone117x/node-stratum-pool (`blockTemplate.js`, `util.reverseByteOrder`)
for the pool — and cross-checked against real block data:
`TestMerkleRoot_GenesisCoinbase_EmptyBranch` folds the genesis coinbase
into the genesis merkle root, and `TestHeaderPrevHash_Block125552` runs
block 125552's previous-hash through the pool-side transform and back
through the client-side one, then hashes the assembled header and compares
it to that block's real hash. `TestSubmit_ReconstructsTheHashedHeader`
replays the pool's own share validation against a live session.

**Scope note:** this fixes header *construction* and *submission*. Two
things V1 miners commonly also do remain unimplemented and are unaffected
by this work: version rolling (`mining.configure`/ASICBoost) and ntime
rolling. Otedama submits the job's own version and ntime, which is valid —
it simply searches the nonce and extranonce2 space only.

---

## ~~18. The Stratum V2 handshake did not match the wire specification~~ ✅ RESOLVED (session 256)

**What was broken (previously undisclosed):** §11 above corrected the
*semantics* of the V2 path — which message activates a job, which target to
grind, which version to echo — and its tests passed because both sides of
every test were Otedama's own encoder and decoder. Round-tripping proves
self-consistency, not conformance. Checked field by field against
`stratum-mining/sv2-spec`, five deviations turned up, two of which stop a
real pool connection at the handshake:

1. **`SetupConnection` omitted `endpoint_port` (U16).** The spec's field
   order is `endpoint_host` then `endpoint_port`, then vendor, hardware
   version, firmware, device ID. Otedama sent no port at all and passed the
   whole `"host:port"` string as the host, so a conformant pool read two
   bytes of the vendor string as the port and everything after it was
   garbage. The connection cannot get past its first message.
2. **`OpenStandardMiningChannel` omitted `max_target` (U256).** SV2 is
   fixed-layout binary — a field cannot be left out the way an optional
   JSON key can. The code comment justified the omission as avoiding "dead
   configuration", but the pool is simply left 32 bytes short of a complete
   message. "No preference" is expressed by the largest possible target,
   not by silence.
3. **`OpenStandardMiningChannel.Success` decoded an `extranonce2_size`
   (U16) where the spec has `group_channel_id` (U32).** There is no
   extranonce2 in Stratum V2 standard channels — the pool builds the
   coinbase — so the field was a Stratum V1 concept carried across by
   mistake. Half of a real pool's `group_channel_id` was read as that
   field, leaving two bytes unconsumed.
4. **`SubmitShares.Error` used msg_type `0x1e`, which is Reserved.** The
   real value is `0x1d`. Every share rejection from a real pool arrived as
   an unrecognised frame and was silently dropped: rejects would never be
   counted, the reject-reason classifier could never run, and the
   acceptance-rate warning could never fire — a miner rejecting 100% of its
   shares would have looked, from its own logs and metrics, like a miner
   with nothing to report.
5. **`SubmitShares.Success.new_shares_sum` was a U32; the spec says U64.**
   The decoded figure was truncated and the encoded message was four bytes
   short.

Separately, the engine applied a new `SetTarget` to the job it was already
mining. The spec scopes a target change to future jobs and to
already-received *future* jobs (those with an empty `min_ntime`), and
explicitly not to a job that arrived with `min_ntime` set — re-targeting
one of those makes the pool and the miner judge the same share
differently.

**Resolution:** all five wire defects fixed in `internal/stratum`
(`handshake.go`, `messages.go`), both callers updated to split host and
port, and `SetTarget` scoping corrected in `internal/engine/run.go`. The
`poolproto/stratumv2` adapter additionally now numbers its submissions
instead of sending sequence 0 forever — SV2 acknowledges a *range* of
submissions by reporting the last sequence number accepted, which is
meaningless if every submission claims to be number 0.

**How this class of defect is kept out from now on:**
`internal/stratum/conformance_test.go` asserts *absolute* layout — total
payload length and the byte offset of each field — plus the message-type
numbers, rather than only that encode and decode agree with each other.
The two `SetTarget` scope tests were confirmed to fail against the previous
behaviour before the fix was kept.

**Still unverified against a real pool:** these fixes come from the
specification, not from a session against live Braiins/DEMAND endpoints,
which this environment cannot reach. Interop testing remains the honest
next step before claiming Stratum V2 works end to end.

---

## ~~19. A non-ASCII BIP-39 passphrase produces a wallet other software cannot restore~~ ✅ RESOLVED (session 264 — by refusing the input)

**What it was:** BIP-39 derives the seed with
`PBKDF2(password = mnemonic sentence in UTF-8 NFKD, salt = "mnemonic" +
passphrase in UTF-8 NFKD, 2048 iterations, HMAC-SHA512, 64 bytes)`.
`lightning.MnemonicToSeed` performs the PBKDF2 exactly as specified but
normalises neither input, and a non-ASCII passphrase as typed is almost
always NFC — `é` as U+00E9, `パ` as U+30D1 — which NFKD decomposes. Otedama
therefore derived a different seed than any conformant wallet derives from
the same phrase and passphrase: the printed recovery phrase would silently
restore a *different, valid-looking* wallet in Electrum or on a hardware
wallet. No error was possible in principle, because the other wallet cannot
know it derived the wrong seed.

(For the mnemonic sentence itself this never mattered: the bundled English
wordlist is ASCII, NFKD is the identity on ASCII, BIP-39 requires every
wordlist to be NFKD-encoded anyway, and joining Japanese words with an ASCII
space rather than U+3000 is equivalent because NFKD maps U+3000 to a plain
space.)

**Decision taken: refuse, not normalise.** Two fixes were recorded for a
maintainer decision. Normalising via `golang.org/x/text/unicode/norm` is what
a BIP-39 implementation is *supposed* to do, but it buys conformance with a
runtime dependency that ADR-003 exists to prevent, and the alternative —
hand-rolling NFKD — is exactly the from-scratch implementation of a standard
algorithm that CLAUDE.md forbids for funds-critical code. Accepting input
that cannot be handled correctly was the requirement to drop, not the
constraint to work around.

**What now happens:** creating a wallet with a non-ASCII BIP-39 passphrase
fails with `lightning.ErrNonPortablePassphrase`, naming the offending
character and its byte offset — the usual cause is one invisible character,
a non-breaking space pasted from a web page. `otedama run` performs the same
check at config time and exits 78, because `engine.setupWallet` logs wallet
failures at warn level and continues without a wallet, and with the TUI
active and no `--log-file` the logger is a discard sink; relying on the
library alone would have produced a silent no-wallet run instead of a reason.

**Nobody is locked out.** The check applies only to wallet *creation*.
`loadExisting` never consults the mnemonic passphrase — only the seed is
stored, and it is not re-derived — so a wallet already created with a
non-ASCII passphrase keeps opening normally, and `otedama wallet verify`
still derives with whatever passphrase it is given, so such a wallet can
still be checked. Both properties are pinned by tests.

**Still true, and now the only supported shape:** an ASCII passphrase —
including the empty default, which is the common case — is fully
conformant, because NFKD is the identity on ASCII. If you already created a
wallet with a non-ASCII passphrase and want portability, create a new wallet
in a fresh `--data-dir` with an ASCII passphrase and mine to that instead.

**What was verified alongside (session 257):** the rest of the BIP-39 path
is checked against the complete official English test-vector set — entropy
to mnemonic, mnemonic back to entropy, and mnemonic to seed for all 16
vectors (`internal/lightning/bip39_vectors_test.go`). The embedded wordlist
is confirmed to be the official one by the same run: a single wrong word
would break some vector's mnemonic.

---

## How to verify what is real yourself

There is no longer a simulated revenue stream to tell apart: the one that
existed was deleted in session 264 (§1), so every figure the product shows
comes from something it actually does.

- **Mining (real):** `otedama run --bitcoin-address bc1q...` connects to a
  real Stratum pool and submits real shares. It is the only revenue stream.
- **The earnings rate** in the dashboard is the sum of the streams
  arbitration is routing devices to right now — zero when nothing is
  allocated, rather than a would-be rate. `otedama_arbitration_expected_
  yield_sats_per_second` is the same number.
- **Your backup:** `otedama wallet verify` confirms the recovery phrase you
  wrote down reproduces the stored wallet. This is the one check that
  cannot be done later — BIP-39 derivation is one-way, so do it while you
  still hold both the phrase and a working wallet.
- **Self-check:** `otedama doctor` runs diagnostic checks; `otedama config
  show --origin` prints the effective configuration and which layer set
  each value.

If you find a behaviour that is simplified or stubbed but **not** listed
here, that is a documentation bug — please open an issue. Honesty about
limitations is a project value, not an afterthought.

---

*Last updated: v3.0.0-alpha.1. This file is maintained alongside the
code; each limitation is removed from this list in the same release that
resolves it.*
