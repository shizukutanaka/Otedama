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

## 5. Post-quantum signature schemes are scaffolded, not active

**What:** `internal/btccrypto` registers ML-DSA and SPHINCS+ scheme
identifiers as TODO scaffolding. They are not implemented.

**Impact:** None today. There is nothing on the Bitcoin network to
interoperate with. The scaffolding exists so the scheme-registry
abstraction (ADR-006) is exercised and ready.

**Corrected (session 251, primary-source verified):** this entry and
the roadmap previously coupled the ML-DSA scaffolding to "BIP-360
activation." That coupling is wrong. BIP-360 is **Status: Draft**
(assigned 2024-12-18) and is titled **"Pay-to-Merkle-Root (P2MR)"** — a
Taproot-like output with the key-path spend removed. Its own text
explicitly states post-quantum signatures are deferred to a *separate,
not-yet-written* proposal: "…may require the introduction of
post-quantum signatures… we intend to offer a separate proposal for
this purpose." So BIP-360 activation alone would **not** give the
network ML-DSA — Otedama's ML-DSA scaffolding is gated on a later BIP
that does not yet exist, which *widens* the timing uncertainty here
rather than bounding it. (Source:
raw.githubusercontent.com/bitcoin/bips/master/bip-0360.mediawiki)

**Workaround:** Not applicable.

**Target:** v4.0 or later, gated on a future (not-yet-published) PQ
signature BIP downstream of BIP-360 — an even more uncertain timeline
than "BIP-360 activation" implied. Tracked by ADR-006 and the
conditional-milestones section of ROADMAP.md.

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

## 13. Several CI workflows are non-functional or misdescribed (`deploy.yml`, `ci.yml`, `ci-cd.yml`, `security.yml`, `code-review.yml`, part of `release.yml`)

**What:** Six of the seven `.github/workflows/*.yml` files have real
problems, ranging from "fails deterministically" to "silently a
no-op":

- **`deploy.yml`** runs an `npm ci`/`npm test` job on every push to
  `main`/`develop` and every PR to `main` — but this is a Go project
  with no `package.json` anywhere in the repository, so that job fails
  immediately every time it runs. Its later `deploy-staging`/
  `deploy-production` jobs run `helm upgrade --install … ./kubernetes/helm/otedama`,
  but no `kubernetes/` or `helm/` directory exists in the repo
  (CLAUDE.md's architecture map explicitly documents that `k8s/` does
  not exist and is represented only by the YAML examples in
  `docs/DEPLOYMENT.md`).
- **`release.yml`**'s `build-packages` job (`.deb`/`.rpm` via `fpm`)
  references `scripts/post-install.sh`, `scripts/pre-remove.sh`,
  `scripts/otedama.service`, and a root-level `config.yaml` — none of
  which exist (`scripts/` is not a directory in this repo; there is no
  root `config.yaml`, only `config.yaml.example`). This job would also
  fail if it ran (it currently only runs on a `v*` tag push).
- **`ci.yml`**'s `docker-verify`/`docker-verify-windows` jobs run
  `scripts/verify-docker.sh`/`.ps1` (same nonexistent `scripts/`
  directory) and poll `http://localhost:8082/health` — but the actual
  server only exposes `/healthz`/`/readyz` (`internal/httpserver`), and
  the containers are started with no `--bitcoin-address`/`--http-addr`,
  so (per the Dockerfile's default `CMD ["run", "--help"]`) they just
  print help and exit — nothing is ever listening on 8082 regardless
  of the path. A separate `docker-verify-cgo0-postgres` job spins up a
  real `postgres:15` service and passes
  `OTEDAMA_DATABASE_DRIVER`/`OTEDAMA_DATABASE_CONNECTION_STRING` env
  vars — Otedama has no database layer and no such config fields exist
  anywhere in `internal/config`; this job tests a feature that does
  not exist. `ci.yml` also has its own `deploy-staging`/
  `deploy-production` jobs applying `k8s/*.yaml`, the same nonexistent/
  forbidden path as `deploy.yml`.
- **`ci-cd.yml`** is a second, largely duplicate "CI/CD Pipeline"
  (same workflow name as `ci.yml`) that appears to be superseded dead
  weight: it hardcodes `GO_VERSION: '1.21'` and a `go: ['1.20', '1.21']`
  matrix, both below `go.mod`'s `go 1.22` minimum (so those legs cannot
  even satisfy the module declaration), and it applies
  `k8s/deployment.yaml` — the same nonexistent path again.
- **`security.yml`**'s `security-tests` job runs
  `go test -tags=security ./tests/security/...` and
  `go test -tags=load -run TestDDoSProtection ./tests/load/...` —
  there is no `tests/` directory anywhere in the repo; both steps fail
  with "matched no packages." (Its `compliance-check` job's hardcoded-IP
  grep, a second deterministic failure in the same file caused by
  legitimate loopback/example addresses in this codebase's own flag
  help text and doctor checks, was fixed session 247 — see below.)
- **`code-review.yml`** is written entirely around a Node.js/npm
  toolchain (ESLint via reviewdog, `npx complexity-report`,
  `npx size-limit`, a `scripts/code-review/generate-comment.js` that
  doesn't exist) gated behind a `has_node` check that is always false
  for this Go-only repo — except its "Setup Node.js" step runs
  unconditionally. Net effect: the workflow never reviews any Go code
  (no golangci-lint/gosec-based inline comments); it only ever posts a
  static "no Node.js project detected" comment.
- **CLAUDE.md's own architecture map** describes `test.yml` as
  `test.yml (fuzz+benchmark)`, but the file's actual jobs are `test`,
  `lint`, `security`, `build`, `integration`, `benchmark` — there is no
  fuzz job. A real fuzz target exists (`internal/stratum/frame_fuzz_test.go`,
  `make fuzz`), but no workflow invokes it.
- **Go-version mismatch breaks EVERY Go job at `go.mod` parse time
  (confirmed live on PR CI, session 252).** Every workflow pins an old
  Go: `ci.yml`/`test.yml`/`release.yml` use `1.23.x`, `ci-cd.yml`/
  `security.yml` use `1.21`, all with `GOTOOLCHAIN=local`. But `go.mod`
  declares `toolchain go1.24.0` and — decisively — a `godebug` block
  containing `tlsmlkem=1`, which is a **Go 1.24** knob (X25519MLKEM768,
  standardized in 1.24). Go 1.23/1.21 with `GOTOOLCHAIN=local` refuses
  to download the newer toolchain and fails immediately with
  `go.mod:16: unknown godebug "tlsmlkem"` at the very first `go mod
  download` step — so the Test, Build, Lint, Benchmark, and gosec jobs
  never even compile the code. This is not a code defect; the module is
  internally consistent for Go 1.24+ (it builds and passes all 24
  packages' tests locally on Go 1.24.7). It is purely that CI pins a Go
  older than the module's own `tlsmlkem` godebug requires. Note the
  latent tension it exposes: GODEBUG_NOTES.md says the `go 1.22` /
  `toolchain go1.24.0` split exists so "older toolchains can still
  build Otedama," but the `tlsmlkem=1` godebug (a 1.24 knob) already
  makes `go.mod` unparseable by any toolchain < 1.24 — so that stated
  intent is not actually achievable as long as the godebug is pinned.

**Impact:** `deploy.yml`, `ci-cd.yml`, and parts of `ci.yml` make CI
status red on ordinary development pushes/PRs for reasons unrelated to
code quality — false-negative signals an operator or contributor could
mistake for a real regression. Most severely, the Go-version mismatch
above means the flagship **Test/Build/Lint jobs are red on every PR**
before a single test runs — so CI provides no real signal on Go code
health at all right now, even though the code itself is green on a
correct (Go 1.24+) toolchain. `release.yml`'s packaging job and
`security.yml`'s `security-tests` job would fail if actually triggered.
`code-review.yml` gives the appearance of automated Go code review
while doing none. The `test.yml`/CLAUDE.md mismatch means fuzzing —
required by CLAUDE.md's own testing policy for parser/protocol code —
is not actually running in CI despite the architecture map implying it
is.

**Corrected so far:** `release.yml`'s smaller factual errors (session
245: wrong `MIT` license string vs. the project's actual Apache-2.0;
a "P2P Mining Pool Software" description CLAUDE.md explicitly forbids
as mischaracterizing Otedama as a pool operator; a broken deployment-
guide link) and `security.yml`'s `compliance-check` hardcoded-IP check
(session 247: changed from a hard failure to a non-fatal `::warning::`,
since the pattern matches this repo's own legitimate loopback/example
addresses — `127.0.0.1` in flag help text, `1.1.1.1` in doctor's DNS
reachability check — not just genuine leaks).

**Not fixed:** everything above lives in `.github/workflows/`, which
the automation making these corrections cannot push to (the GitHub App
lacks the `workflows` permission — verified repeatedly this session).
Each item also carries a maintainer decision:

- **The Go-version mismatch is the one-line, highest-value fix:** set
  every workflow's Go version to **`1.24.x`** (matching `go.mod`'s
  `toolchain go1.24.0`), or drop `GOTOOLCHAIN=local` so the runner is
  allowed to fetch the 1.24 toolchain the module already declares. That
  single change turns the Test/Build/Lint jobs from "red before
  compiling" to actually exercising the (already-green) code. The
  deeper question — whether to keep the `tlsmlkem=1` godebug pin (which
  forecloses GODEBUG_NOTES.md's "old toolchains can build" intent) or
  relax it — is a security-posture call for the maintainer, informed by
  GODEBUG_NOTES.md's reasoning; it should not be changed unilaterally.
- The rest: author the missing `scripts/`/`config.yaml`/
  `tests/security`/`tests/load` assets and a real Kubernetes/Helm
  deployment target vs. remove the non-functional jobs entirely; decide
  whether `ci-cd.yml` is still needed or should be deleted; decide
  whether to replace `code-review.yml` with a Go-native reviewdog/
  golangci-lint pipeline; decide whether to add a scheduled fuzz job to
  `test.yml` or correct CLAUDE.md's description.

**Workaround:** Ignore `deploy.yml`/`ci-cd.yml` CI status; neither
reflects code health. Do not attempt `.deb`/`.rpm` packaging via
`release.yml`, rely on `code-review.yml`'s output as a Go code review,
or assume fuzz testing runs in CI until these are addressed.

**Target:** No committed target; tracked here pending a maintainer
decision on CI/CD strategy.

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

## 15. TUI dashboard renders at a fixed 80 columns; real terminal width is never detected

**What:** `internal/tui.Dashboard.SetWidth` lets a caller inject the
real terminal width, but no production call site ever calls it —
`engine.Run` constructs the dashboard via `tui.NewDashboard` and never
calls `SetWidth`, so every real invocation renders at the constructor's
hardcoded default of 80 columns regardless of the actual terminal
size (confirmed: `SetWidth` is called only from `internal/tui`'s own
test files).

**Impact:** On a narrower real terminal, output can wrap onto a second
terminal row, which breaks the dashboard's "cursor home, overwrite in
place" repaint model (each subsequent frame then draws one row off
from where the previous one landed). On a wider terminal, screen space
is simply unused. Separately (fixed session 249): before this session,
the pool connection-status text and share-count text on the two
busiest lines were truncated using fixed-width budgets independent of
the actual configured width, so at the documented 40-column minimum
they could be cut off entirely even once real width detection lands;
both lines now size their variable-length fields from the actual
`cols` value, so this specific failure mode is closed regardless of
whether width detection itself is ever wired in.

**Workaround:** Keep the terminal at or above 80 columns for correct
rendering, or use `--no-tui` for plain log output, which has no width
assumptions.

**Target:** No committed target. Wiring in real detection needs either
`golang.org/x/term` (a new direct dependency; the ADR-003 zero-
dependency stance would need a documented exception, as the package
doc's own "Design" section already assumed this was solved) or raw
per-platform syscalls (`golang.org/x/sys/unix` TIOCGWINSZ / `x/sys/windows`
GetConsoleScreenBufferInfo, both already reachable as an indirect
dependency via `golang.org/x/crypto`) — a maintainer decision between
the two is needed before implementation.

---

## 16. No `wallet` subcommand: the recovery phrase cannot be verified, and the passphrase cannot be changed, from the CLI

**What:** The CLI dispatches only `run`, `version`, `config`, `service`,
`doctor`, `completion`, and `help` (`cmd/otedama/main.go`). There is no
`otedama wallet ...` command. Two consequences:

- **No way to verify a backup.** After writing down the 24-word recovery
  phrase printed on first run (implemented session 253 — see
  `engine.printRecoveryPhrase`), a user has no way to check that what
  they wrote down is correct. The standard practice for a non-custodial
  wallet is a verify step — re-enter the phrase, derive the seed, and
  confirm the fingerprint matches the stored wallet — precisely because
  a transcription error is silent and is only discovered during a
  recovery attempt, when it is too late. `doctor` reports whether
  `wallet.dat` exists and prints its fingerprint, but never accepts a
  mnemonic to compare against.
- **`ChangePassphrase` is implemented but unreachable.**
  `lightning.WalletManager.ChangePassphrase` (internal/lightning/wallet.go)
  correctly verifies the old passphrase and atomically re-encrypts the
  seed, and is covered by tests — but no production code calls it, so a
  user whose passphrase may have been exposed cannot rotate it without
  writing their own Go program against the internal package.

**Impact:** A user can follow every documented instruction and still hold
an unusable backup, discovering it only when their disk has already
failed. Because BIP-39 derivation is one-way, Otedama cannot re-derive
the phrase to check it later — verification must happen while the user
still has both the phrase and the working wallet. This is a gap in the
*usability* of the non-custodial guarantee rather than in its
cryptography: the seed never leaves the device (that part holds), but
the user's ability to prove they can recover it is missing.

**Workaround:** Immediately after first run, confirm that the printed
fingerprint matches what `otedama doctor` reports, and store the phrase
and a copy of `wallet.dat` separately. There is no in-product way to
confirm the transcription itself. To rotate a passphrase, create a new
wallet in a fresh `--data-dir` and mine to it instead.

**Target:** No committed target. Adding a subcommand touches the CLI
architecture map in CLAUDE.md, so it needs a maintainer decision rather
than a mechanical fix. A minimal `otedama wallet verify` (read a mnemonic
from stdin — never argv, which leaks via process lists — derive the seed,
compare fingerprints, print match/mismatch) and `otedama wallet
change-passphrase` (wiring the existing, already-tested
`ChangePassphrase`) would close both halves without new dependencies.

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

## 19. A non-ASCII BIP-39 passphrase produces a wallet other software cannot restore 🚩

**What:** BIP-39 derives the seed with
`PBKDF2(password = mnemonic sentence in UTF-8 NFKD, salt = "mnemonic" +
passphrase in UTF-8 NFKD, 2048 iterations, HMAC-SHA512, 64 bytes)`.
`lightning.MnemonicToSeed` performs the PBKDF2 exactly as specified but
normalises neither input.

For the mnemonic sentence this has no practical effect: the bundled
English wordlist is ASCII (NFKD is the identity on ASCII), BIP-39 requires
every wordlist to be NFKD-encoded anyway, and joining Japanese words with
an ASCII space instead of the conventional ideographic space (U+3000) is
equivalent because NFKD maps U+3000 to a plain space.

For the **passphrase** it matters. `--wallet-mnemonic-passphrase` (or
`OTEDAMA_WALLET_MNEMONIC_PASSPHRASE`) takes an arbitrary string, and a
non-ASCII passphrase as typed is almost always NFC — `é` as U+00E9, `パ`
as U+30D1 — which NFKD decomposes. Otedama therefore derives a different
seed than any conformant wallet derives from the same phrase and
passphrase.

**Impact:** the recovery phrase Otedama prints is only portable if the
BIP-39 passphrase is ASCII (including the default: no passphrase at all,
which is the common case and is unaffected). With a non-ASCII passphrase,
typing the phrase and passphrase into Electrum, a hardware wallet, or any
other BIP-39 tool silently produces a *different, valid-looking* wallet —
the "decoy wallet" failure mode, arrived at unintentionally. Nothing warns
the user, and no error is possible in principle: the other wallet cannot
know it derived the wrong seed. Funds already received remain spendable
through Otedama's own `wallet.dat`, so this is a portability defect rather
than an immediate loss, but portability is precisely what the recovery
phrase exists for.

**How you can tell:** you are affected only if you passed
`--wallet-mnemonic-passphrase` (or set the environment variable) with a
value containing any character outside ASCII when the wallet was first
created. The flag's `--help` text now says so.

**Workaround:** use an ASCII-only BIP-39 passphrase. An empty passphrase
(the default) is fully conformant. If you already created a wallet with a
non-ASCII passphrase and want portability, create a new wallet in a fresh
`--data-dir` with an ASCII passphrase and mine to that instead.

**Why this is flagged rather than fixed:** `internal/lightning` is
CODEOWNERS-gated funds-critical code, and both plausible fixes are
behaviour changes that need a maintainer decision:

1. **Normalise** — apply NFKD via `golang.org/x/text/unicode/norm`. Fully
   conformant, but adds a runtime dependency, which ADR-003 (zero runtime
   dependencies) exists to prevent. It also changes the seed derived from
   an existing non-ASCII passphrase, so it needs a migration note (existing
   wallets keep working: only the seed is stored, and it is not re-derived).
2. **Reject** — refuse a non-ASCII passphrase at wallet creation with an
   explanatory error. Dependency-free and prevents a non-portable wallet
   from ever being created, but rejects input that is accepted today.

Option 2 is the smaller change and preserves ADR-003; option 1 is what a
BIP-39 implementation is supposed to do. Recorded here, in
`docs/CATEGORY_AUDIT.md` (session 257, 🚩), and in the doc comments on
`MnemonicToSeed` / `WithMnemonicPassphrase` pending that decision.

**What was verified at the same time (session 257):** the rest of the
BIP-39 path is now checked against the complete official English
test-vector set — entropy to mnemonic, mnemonic back to entropy, and
mnemonic to seed for all 16 vectors
(`internal/lightning/bip39_vectors_test.go`). Before this the package
claimed to be "validated against the specification's published test
vectors" on the strength of three of them. The embedded wordlist is
confirmed to be the official one by the same run: a single wrong word
would break some vector's mnemonic.

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
