# ADR-007: Lightning capability expansion

**Status:** Proposed
**Date:** 2026-05-12 (formalized from prior research)
**Target releases:** v3.5 (mid-2027) through v4.0 (April 2028 halving), with v4.1 deferrals
**Related ADRs:** ADR-001 (non-custodial wallet — logical deepening), ADR-009 (pool decentralization), ADR-010 (arbitration engine evolution)

---

## Context

Otedama v3.0.0-alpha.1 uses Lightning as a **passive receive endpoint**: the wallet holds a BIP-39 seed and ChaCha20-Poly1305-encrypted state, signs proofs for BOLT12 offer registration with the pool, but does not run a Lightning node itself. Payouts arrive at the user's externally-run node (Phoenixd, CLN, lnd, Alby Hub) or, with OCEAN's TIDES system, accumulate as on-chain payouts.

This is the right starting point — minimal attack surface, no liveness requirements, no channel-management complexity. But it leaves Otedama unable to participate in three significant 2027–2028 capabilities:

1. **BOLT12 reusable offers** are now the de-facto Stratum V2 + pool decentralization payout standard (OCEAN, Braiins Pool production; DMND likely to follow). Otedama can't currently emit canonical BOLT12 offers because it has no node-side machinery.
2. **Splicing** (Eclair v0.11.0 production; LDK experimental Q3 2026) lets channel balance be converted to on-chain without close/reopen cycles. Mining payouts naturally accumulate; auto-splicing at threshold is the right UX.
3. **Submarine swaps** (Boltz, in production) are the right failsafe when Lightning routing degrades — a non-custodial way to bridge LN ↔ on-chain atomically.

Adding all of this requires a real Lightning node. Three options exist:

- **(A) cgo against LDK C bindings.** Tightest integration but adds C-toolchain dependency, defeats the "single Go binary" promise.
- **(B) Bundle LDK Node Rust sidecar binary; speak gRPC locally.** Same model as `phoenixd`. Replaceable, debuggable, isolates Lightning state from the main Otedama process.
- **(C) Stay as a BOLT12 receiver, talk to user's external node only.** Smallest scope; misses splicing and embedded auto-recovery.

Option (B) is the right answer for v3.7. Options (C) ships v3.5–v3.6 as the credible "Lightning-lite" path for users who don't want an embedded node. Both ship simultaneously, gated by user feature flag.

The **non-custodial constraint** is the boundary. Specifically:

- ✅ Otedama can hold the user's own seed and sign on behalf of the user.
- ✅ Otedama can manage the user's own channels with the user's own funds.
- ❌ Otedama can NOT hold third-party funds in transit (even briefly).
- ❌ Otedama can NOT operate as an LSP for free-tier users (custodial by definition).
- ❌ Otedama can NOT do multi-recipient HTLC interception — that path leads to custody-on-the-split.

---

## Decision

We will expand Otedama's Lightning capability across v3.5–v4.0 (with v4.1 deferrals), structured around **eleven features (B1–B11)**. Two features (B11 multi-recipient, B12 per-second stream-pay sending) were considered and explicitly rejected.

### Feature B1 — Canonical BOLT12 offer support (v3.5, ~35h)

**Mechanism:** Replace ad-hoc invoice flows with BOLT12 offers. Emit signed-message proof linking on-chain payout address ↔ offer. Wire format compatible with OCEAN; forward-compatible with Braiins Pool and DMND.

**Status of pool support (Apr 2026):**
- OCEAN: BOLT12 in production.
- Braiins Pool: Lightning payouts via Lightning Service Auth Token (LSAT).
- DMND: SLICE transparent payout system; BOLT12 expected post-Stratum-V2 expansion.

**Cost:** ~35h. BOLT12 codec is well-specified; existing Go libraries (`github.com/lightninglabs/lndclient` for receive path) cover most of it.

**Value/cost rank:** ★★★★★ — this is the table-stakes feature for any 2027+ non-custodial pool payout.

**Non-custodial check:** ✅ Otedama emits the offer, user controls the destination node.

### Feature B2 — Pool-agnostic payout adapter (v3.5, ~50h)

**Mechanism:** Plugin interface decoupling Otedama from pool-specific payout dialects:

```go
type PayoutEndpoint interface {
    Register(ctx context.Context, seed []byte) error
    Receive(ctx context.Context) (<-chan ReceivedPayment, error)
}

type ReceivedPayment struct {
    AmountSats int64
    PoolID     string
    Timestamp  time.Time
    ProofOfWork []byte  // for OCEAN TIDES auditing
}
```

Implementations in v3.5: `ocean_bolt12`, `braiins_lightning`, `dmnd_slice` (forward-compat stub).

**Cost:** ~50h. Shares wire codec infrastructure with B1.

**Value/cost rank:** ★★★★★ — decouples Otedama from pool churn.

**Non-custodial check:** ✅ Same as B1.

### Feature B3 — External-node remote-control mode (v3.6, ~60h)

**Mechanism:** Talk to user's existing Lightning node over its REST/gRPC. Otedama never holds keys. Recovery story = user's own.

Supported backends:
- **Phoenixd HTTP API** — ACINQ's lightweight node, single-binary deploy.
- **Core Lightning JSON-RPC** — most flexible.
- **lnd gRPC** — most widely deployed.
- **Alby Hub** — emerging open-source option.

**Cost:** ~60h. Each backend has its own auth model (macaroons for lnd, runes for CLN, HTTP basic for Phoenixd).

**Value/cost rank:** ★★★★ — the right entry point for users who already self-host.

**Non-custodial check:** ✅ Maximally non-custodial. Otedama is a thin RPC client.

### Feature B4 — Embedded LDK Node sidecar, opt-in (v3.7, ~180h)

**Mechanism:** Bundle prebuilt `ldk-node` binary per-platform (Linux x86_64/arm64, macOS x86_64/arm64, Windows x86_64). Otedama exec's it, speaks UniFFI-generated gRPC. Feature-flagged: `otedama lightning enable --embedded`.

Architecture:
- Otedama main binary stays pure Go.
- `ldk-node` is a separate process, communicates over local Unix socket (Linux/macOS) or named pipe (Windows).
- Otedama supervises ldk-node lifecycle: start, health-check, graceful restart on crash.

**Cost:** ~180h. Bulk is integration: pre-built binary distribution per platform, UniFFI binding generation, IPC layer, supervision logic, log forwarding.

**Value/cost rank:** ★★★ — unlocks B5/B8/B9 but is the single biggest investment.

**Non-custodial check:** ✅ Sidecar runs on user's machine, with user's seed.

### Feature B5 — Auto-splice at threshold (v3.7, ~30h — gated on LDK splicing GA)

**Mechanism:** When channel-side balance > `splice_threshold` (default 500k sats), trigger splice-out to user-controlled on-chain address.

**Dependency:** Requires LDK splicing to be GA in `rust-lightning` mainline. As of April 2026, splicing is on a separate branch (`ldksplicing/ldk-splicing`); merge into mainline is tracked in `lightningdevkit/rust-lightning` issue #1621. Best estimate: end-of-2026 GA.

**If LDK splicing slips beyond Q3 2027:** drop B5, ship v3.7 with channel-rotation as a workaround.

**Cost:** ~30h. Logic itself is small; the heavy lifting is in B4.

**Value/cost rank:** ★★★★ — solves the "channel keeps filling up" problem that all home miners hit.

**Non-custodial check:** ✅ Splice-out goes to user-controlled address.

### Feature B6 — Boltz reverse-swap failsafe (v3.6, ~50h)

**Mechanism:** If 3 consecutive routing failures in 24h **OR** channel-side balance > splice threshold **without** B4 enabled, auto-trigger Boltz reverse submarine swap (LN → on-chain). Atomic, non-custodial (HTLC-based).

**Boltz integration:** Use Boltz's hold-invoice protocol via their REST API. `boltz-client` exists in Go and is GPL-licensed; we either consume it as a library or reimplement the relevant pieces.

**Cost:** ~50h. Works without B4 if B3 is active.

**Value/cost rank:** ★★★★ — credible "Lightning-lite" failsafe for users who don't want embedded node.

**Non-custodial check:** ✅ Submarine swaps are atomic, no custody.

### Feature B7 — Tor-by-default (v3.5, ~40h)

**Mechanism:** All Lightning traffic over local Tor SOCKS5 proxy. v3 onion service for inbound (requires B4). Provision Tor data directory under `~/.otedama/tor/`. Detect existing system Tor and reuse it.

**Why:** Mining payouts are publicly observable on-chain via coinbase address. Linking that address to a Lightning node IP defeats much of Lightning's privacy. Tor-only mode is the documented default; clearnet opt-in only.

**Cost:** ~40h. Go's `golang.org/x/net/proxy` handles SOCKS5 trivially.

**Value/cost rank:** ★★★★★ — privacy is the core Lightning value proposition.

**Non-custodial check:** ✅ Tor doesn't change custody, only network layer.

### Feature B8 — LSP picker (v3.7, ~25h — only relevant with B4)

**Mechanism:** Three-way choice on first run of embedded mode:
- **Olympus by ZEUS** (default) — battle-tested, large operator.
- **Voltage Flow 2.0** — one-click alternative.
- **"I'll run my own"** — for users with existing infrastructure.

Document the trust model clearly: an LSP can force-close to extract funds, but the resulting on-chain UTXOs always belong to the user (the force-close fee is the cost).

**Cost:** ~25h. UI and integration plumbing.

**Value/cost rank:** ★★★★ — sets up B4's onboarding correctly.

**Non-custodial check:** ✅ LSPs can force-close but cannot steal. User funds are always recoverable via the seed.

### Feature B9 — SCB + seed recovery (v3.7, ~35h)

**Mechanism:** `otedama lightning backup [path]` exports static channel backup. `otedama lightning recover --seed <words> --scb <file>` walks the LDK Node DLP (Data Loss Protection) path to sweep funds.

Mirror lnd's `aezeed` + `channel.backup` UX exactly. Document the threat model: SCB file leakage doesn't reveal funds, but full seed leakage does.

**Cost:** ~35h. LDK Node exposes channel-backup primitives; mostly UI.

**Value/cost rank:** ★★★★ — without this, B4 is irresponsible to ship.

**Non-custodial check:** ✅ Recovery uses only user-known secrets.

### Feature B10 — Hardware-wallet PSBT cosign for channel opens/splices (v4.0, ~70h)

**Mechanism:** When opening a channel or splice-in/out, emit PSBT v2 (BIP-370). User signs offline on Coldcard Mk4 / Trezor Safe 3 / Ledger; Otedama broadcasts the finalized tx.

**Scope clarification:** Channel state updates (per-payment commitment txs) cannot be hardware-cosigned because they need to sign hundreds/thousands of times per day. Only **on-chain transactions** (channel opens, splices, force-close sweeps) go through HW wallet. This is what every other Lightning-with-HW-wallet integration does.

**Cost:** ~70h. PSBT v2 codec + hardware wallet detection + LDK splicing PSBT support.

**Value/cost rank:** ★★ — niche but valuable for the security-paranoid persona.

**Non-custodial check:** ✅ User keys never leave hardware wallet.

### Features rejected

**B11 — Multi-recipient payout splitter:** "Split 30% to investor A, 70% to operator B." Requires Otedama to either (a) sign both payments separately — fine, non-custodial, but adds complexity to ~200 LOC for a niche feature; or (b) briefly hold the investor's share before paying it out — **that is custody**. Even option (a) encourages users to set up arrangements that look custodial to regulators. **REJECTED for v4.0; re-evaluate post-v4.0 with explicit legal review.**

**B12 — Per-second AI streaming-payment send (e.g., L402/x402 from Otedama as the AI buyer):** Wrong side of the trade. Otedama is the *seller* of AI compute (provider), not the buyer. Stream-pay is the buyer's protocol problem. Per CoinDesk March 2026, agentic-commerce volumes remain tiny ($28K/day on the leading protocol) — demand is not there. **REJECTED.**

---

## Architectural sketch

```
otedama/
├── cmd/otedama/
│   └── lightning_cmd.go             # `otedama lightning` subcommand
├── internal/
│   ├── lightning/                   # existing — BIP-39 seed + state
│   │   ├── wallet.go
│   │   ├── english_wordlist.go
│   │   ├── bolt12/                  # NEW v3.5
│   │   │   ├── offer.go             # B1
│   │   │   ├── codec.go
│   │   │   └── proof.go
│   │   ├── payout/                  # NEW v3.5
│   │   │   ├── endpoint.go          # PayoutEndpoint interface
│   │   │   ├── ocean.go             # OCEAN BOLT12 (B2)
│   │   │   ├── braiins.go           # Braiins Lightning (B2)
│   │   │   └── dmnd.go              # DMND SLICE (B2, stub)
│   │   ├── external/                # NEW v3.6
│   │   │   ├── client.go            # B3 dispatch
│   │   │   ├── phoenixd.go
│   │   │   ├── cln.go
│   │   │   └── lnd.go
│   │   ├── embedded/                # NEW v3.7
│   │   │   ├── sidecar.go           # B4 supervisor
│   │   │   ├── ipc.go               # IPC with ldk-node
│   │   │   └── distrib/             # pre-built binary distribution
│   │   ├── splice/                  # NEW v3.7
│   │   │   ├── auto.go              # B5
│   │   │   └── threshold.go
│   │   ├── swap/                    # NEW v3.6
│   │   │   ├── boltz.go             # B6
│   │   │   └── trigger.go
│   │   ├── tor/                     # NEW v3.5
│   │   │   ├── proxy.go             # B7
│   │   │   └── onion.go
│   │   ├── lsp/                     # NEW v3.7
│   │   │   ├── picker.go            # B8
│   │   │   ├── olympus.go
│   │   │   └── voltage.go
│   │   ├── backup/                  # NEW v3.7
│   │   │   ├── scb.go               # B9
│   │   │   └── recover.go
│   │   └── hwwallet/                # NEW v4.0
│   │       ├── psbt.go              # B10
│   │       ├── coldcard.go
│   │       ├── trezor.go
│   │       └── ledger.go
```

---

## `otedama lightning` UX proposal

```
$ otedama lightning --help
Lightning capability layer

Usage:
  otedama lightning status                 show wallet + connection state
  otedama lightning balance                show on-chain + LN balance
  otedama lightning enable                 enable Lightning capability
    --embedded                             use embedded LDK Node sidecar (B4+)
    --external-node URL                    use external node (B3)
    --bolt12-receive-only                  default v3.5 mode (B1+B2)
  otedama lightning offer create           emit a BOLT12 offer (B1)
  otedama lightning offer list             show active offers
  otedama lightning lsp pick               select LSP (B8, embedded mode)
  otedama lightning swap on-chain          trigger Boltz reverse swap (B6)
  otedama lightning splice out [amount]    splice-out to on-chain (B5)
  otedama lightning backup [path]          export SCB (B9)
  otedama lightning recover --seed --scb   recover from seed+SCB (B9)
  otedama lightning hw-wallet pair         pair hardware wallet (B10)
  otedama lightning tor status             show Tor connection (B7)
```

Example output of `otedama lightning status`:

```
=== Otedama Lightning ===
Mode: embedded (ldk-node v0.4.1)
Tor: enabled (SOCKS5 → 127.0.0.1:9050) ✓
Onion v3: otedamabtc...onion (active)
On-chain balance:  0.00234567 BTC
Lightning balance: 0.00891234 BTC (3 channels)
Channels:
  ID                 Peer                Local       Remote      State
  ────────────────────────────────────────────────────────────────────
  abcd1234...        Olympus-LSP-001     500000      4500000     active
  efgh5678...        OCEAN-receive       1234567     0           active
  ijkl9012...        Phoenix-LSP-de      156789      843211      active
Splice threshold: 5000000 sats (auto-splice enabled)
Boltz failsafe:   armed (last triggered: never)
Active offers (B1):
  lno1q...           OCEAN BOLT12 receive (unlimited reuse)
```

---

## Cost summary

| Feature | Hours | Release | Value/Cost |
|---------|-------|---------|------------|
| B1 BOLT12 offers | 35 | v3.5 | ★★★★★ |
| B2 Payout adapter | 50 | v3.5 | ★★★★★ |
| B3 External node | 60 | v3.6 | ★★★★ |
| B4 Embedded LDK Node | 180 | v3.7 | ★★★ |
| B5 Auto-splice | 30 | v3.7 (gated) | ★★★★ |
| B6 Boltz reverse-swap | 50 | v3.6 | ★★★★ |
| B7 Tor-by-default | 40 | v3.5 | ★★★★★ |
| B8 LSP picker | 25 | v3.7 | ★★★★ |
| B9 SCB + recovery | 35 | v3.7 | ★★★★ |
| B10 HW wallet PSBT | 70 | v4.0 | ★★ |
| **Accepted total** | **575** | v3.5–v4.0 | — |
| ~~B11 multi-recipient~~ | — | rejected | custody risk |
| ~~B12 stream-pay send~~ | — | rejected | wrong side of trade |

575 hours over 24 months at 10h/week = 1,040 hours available → **45% of available budget** if Track B is the only thing built.

In combination with Tracks A/C/D (see ROADMAP.md), B4 (180h) is the **single largest deferrable item**. The minimum-viable Lightning roadmap is **B1 + B2 + B7** (125h) shipping in v3.5 — that alone delivers BOLT12 + Tor-by-default, which is the table-stakes V2-era functionality.

---

## Mutually-reinforcing clusters

- **{B1, B2}**: Same BOLT12 codec — build once, reuse twice.
- **{B4, B5, B8, B9, B10}**: All hinge on the embedded LDK Node sidecar. Ship them in one v3.7 wave or not at all.
- **{B3, B6, B7}**: Independent of B4 — form a credible "Lightning lite" path.
- **{B7, B4}**: Tor proxy plumbing shared between external-node-mode and embedded-node-mode.

---

## External dependencies and risks

1. **LDK Node maturity.** `ldk-node` is at v0.x (April 2026). Splicing is on a separate branch. **B5 ship date is the largest schedule risk.** Mitigation: defer B5 to v4.1 if LDK splicing isn't mainline by Q3 2027.

2. **BOLT12 adoption.** OCEAN production; Braiins compatible; DMND projected. If only OCEAN ships by mid-2027, B2 still ships with `ocean_bolt12` + `bolt11_invoice_fallback`. Re-evaluate quarterly.

3. **Boltz API stability.** Boltz has changed protocols before (introduced hold invoices in 2024). Mitigation: version-pin against their v2 API; have a 6-month sunset commitment from Boltz before relying.

4. **HW wallet PSBT v2 support.** Coldcard Mk4, Trezor Safe 3, Ledger all support BIP-370 PSBT v2. Should be fine by mid-2027.

5. **Tor exit-node attacks.** Lightning over Tor adds latency and reduces payment success rate by several percentage points. Document this trade-off; allow opt-out for users with strict throughput requirements.

6. **Phoenixd / CLN / lnd API churn.** lnd has stable gRPC; CLN has stable JSON-RPC; Phoenixd's HTTP API is newer and may evolve. Track release notes.

---

## Decision threshold to ship

- **v3.5 cut:** B1 + B2 + B7. Must pass: emit valid BOLT12 offer accepted by OCEAN's receive endpoint; all LN traffic goes through Tor; backup → restore round-trip works.
- **v3.6 cut:** B3 + B6. Must pass: connect to all three external node types in CI; Boltz reverse-swap completes against testnet.
- **v3.7 cut:** B4 + B5 (conditional) + B8 + B9. Must pass: embedded ldk-node opens channel against Olympus LSP, sends a payment, receives a payment, exports SCB, recovers from SCB+seed.
- **v4.0 cut:** B10 + polish + external Lightning security audit (~30h budget).

---

## Status

**Proposed.** This ADR formalizes the prior research thread on Lightning capability expansion into a discrete decision document. It restores the file that was referenced from 9 places (ROADMAP.md, ADR-008, ADR-009, CHANGELOG.md) but did not previously exist on disk — closing a structural integrity gap in the ADR system.
