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

## 3. Engine connects to pools directly; poolproto not yet wired in

**What:** `internal/engine/run.go` dials pools with a raw `net.Dialer`
and a `stratum.NewDecoder` directly, rather than routing through
`poolproto.DialURL`. Consequently the `poolproto/stratumv1` and
`poolproto/stratumv2` dialer packages are not yet imported anywhere in
the binary, so their `init()` registration does not fire and the
`poolproto` registry is effectively unused at runtime today.

**Impact:** The clean protocol-dispatch layer (which would let a pool
URL scheme select Stratum V2 / V1 / future Job Declaration transparently
— see ADR-009) is not yet on the engine's hot path. The engine
hard-codes the Stratum V2 path. Mining works; the abstraction is just
not load-bearing yet.

**Workaround:** None needed; the current path works for Stratum V2
pools.

**Integration progress (3 steps):**
- ✅ Step 1 (session 37): URL-scheme parsing unified into
  `poolproto.knownSchemes` (single source of truth shared by `FromURL`
  and `StripScheme`).
- ✅ Step 2 (session 38): `poolproto/stratumv2` dialer implemented and
  unit-tested — the V2 `Dialer`/`Connection`/`Session` adapter that was
  the missing prerequisite.
- ✅ Step 3a (session 39): `engine.applyJob` bridges `poolproto.Job` →
  `miner.Work`, unit-tested, ready for the read loop to consume.
- ⬜ Step 3b: rewrite `engine.runSession` to call `poolproto.DialURL`,
  add the blank import that fires dialer registration, and consume
  `Session.Jobs()`. This is the step that makes the abstraction
  load-bearing and removes the inline handshake.

**Target:** v3.1.0.

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
