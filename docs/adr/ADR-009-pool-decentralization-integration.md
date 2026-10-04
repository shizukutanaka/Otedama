# ADR-009: Pool decentralization integration (Job Declaration + DATUM)

**Status:** Proposed
**Date:** 2026-05-12
**Target releases:** v3.5 (mid-2027) through v4.0 (April 2028 halving)
**Related ADRs:** ADR-002 (Stratum V2 only — logical deepening), ADR-010 (arbitration engine evolution), ADR-007 (Lightning expansion), ADR-008 (hardware/power)

---

## Context

On **May 7, 2026** — five days before this ADR was drafted — seven of the largest Bitcoin mining pools (**Foundry, AntPool, F2Pool, Spiderpool, Block Inc., MARA Foundation, DMND**) formally joined the **Stratum V2 Working Group**. This is the most significant Bitcoin mining-protocol event of the decade: roughly **70% of global hashrate** is now committed to a protocol that lets **individual miners construct their own block templates** rather than blindly hashing pool-imposed transactions.

The implications:

1. **Censorship resistance becomes practical.** A miner running their own Bitcoin full node selects transactions from their own mempool. The pool is reduced to a share-accounting and reward-distribution layer.
2. **Two competing standards have converged on the same goal:**
   - **Stratum V2 Job Declaration Protocol (JDP)** — Working Group standard (Braiins, Spiral, SRI). Mature SDK in Rust; `Job Declarator Client (JDC)` runs miner-side.
   - **DATUM (Decentralized Alternative Templates for Universal Mining)** — OCEAN-specific; gateway in C. Already in production on OCEAN since 2024; Tether announced global deployment April 2025.
3. **Profitability uplift is real but modest.** Braiins-published real-world tests show **up to 7.4% higher profit** from V2-native miners through lower latency and better fee capture. Spiderpool's CTO explicitly noted miner-constructed templates help operators with limited bandwidth.
4. **Solo mining via decentralized templates is now production-viable.** Blitzpool runs Stratum V2 for solo miners; DMND was built on V2 from the ground up; Braiins Pool is 100% V2-capable; the SRI community pool continues testing. **Update (session 503):** since August 2026 **NexusPool also runs native Job Declaration in production** — the third pool after Braiins and DMND — and their engineering post-mortem confirms this ADR's hidden cost: their unit tests passed cleanly yet missed four real defects found only via live interop testing against SRI's reference JDC (a field-count mismatch in an allocation message, an unwired payout field, a connection reaper killing healthy JD-only connections). This ADR's estimate should therefore be read as including budget for reference-implementation interop testing, not unit tests alone.

**Otedama's positioning today (v3.0.0-alpha.1):** V2-preference client (ADR-002) — V1 sessions additionally work via `internal/poolproto/stratumv1` + `DialURL` since the alpha.1 import (**Erratum (session 497):** this paragraph previously said "hard-coded as a Stratum V2 client only", which predates the shipped V1 dialer; see also the ADR-002 erratum on the same point) — but treats the pool as the authoritative source of block templates. The miner has no transaction-selection capability. This is a **strategic inconsistency**: ADR-002's commitment to V2-only was motivated by miner sovereignty, yet the engine doesn't actually exercise that sovereignty.

**The opportunity:** Otedama can become **the first Go-language implementation that supports BOTH the Stratum V2 JDP path AND the DATUM path** through a unified `TemplateSource` abstraction. Users choose their pool and protocol; Otedama transparently selects the right template-construction strategy. This is the natural completion of ADR-002.

**Why now (not "in 10 years"):**

- The 7-pool expansion in May 2026 means by 2027 Q3 (v3.5 target), **a majority of pools will accept miner-declared templates**.
- The Bitcoin Core 30+ `getblocktemplate` RPC has been stable for a decade; DATUM Gateway and SRI JDC both consume it.
- The 2028 halving compresses fee revenue importance: every transaction the miner can select (rather than have selected for them) potentially adds basis points to net revenue.
- **No existing Go implementation exists.** OCEAN's DATUM Gateway is C (`OCEAN-xyz/datum_gateway` on GitHub). The SRI JDC is Rust. Go is the natural language for Otedama's solo-maintainer scope, and a Go reference implementation fills a real ecosystem gap.

---

## Decision

We will add a **Pool decentralization layer** to Otedama, shipped across v3.5–v4.0, structured around a **unified `TemplateSource` abstraction** with two concrete implementations:

1. **`StratumV2JDC`** — Job Declarator Client per the Working Group spec.
2. **`DATUMClient`** — DATUM Gateway functionality reimplemented in Go.

Both consume **local Bitcoin Core/Knots `getblocktemplate` RPC** for transaction selection and produce protocol-specific declarations to the pool. The engine treats them as polymorphic — pool URL scheme determines which implementation is selected.

The work is organized into **six sub-domains**:

### Sub-domain 1 — Bitcoin node integration

**State of the art (2026):** Bitcoin Core 30+ exposes `getblocktemplate` over JSON-RPC. Bitcoin Knots (OCEAN-recommended for better template control) adds finer-grained mempool policy options. DATUM Gateway and SRI JDC both consume this RPC. `blocknotify` signals new block arrival.

**Otedama proposal:** A `BitcoinNode` interface in `internal/btcnode/`:

```go
// internal/btcnode/node.go
type BitcoinNode interface {
    // Identity and health
    NetworkInfo(ctx context.Context) (NetworkInfo, error)
    BlockchainInfo(ctx context.Context) (BlockchainInfo, error)

    // Template construction
    GetBlockTemplate(ctx context.Context, opts TemplateRequest) (Template, error)

    // Block submission (when this miner finds a block)
    SubmitBlock(ctx context.Context, raw []byte) error

    // Streaming new-block notifications (via blocknotify or ZMQ)
    BlockUpdates(ctx context.Context) (<-chan BlockNotification, error)
}

type Template struct {
    Version           int32
    PreviousBlockHash [32]byte
    Transactions      []TemplateTx       // ordered by miner's policy
    CoinbaseValue     int64              // subsidy + fees
    CoinbaseAux       []byte             // for OP_RETURN signaling
    Target            [32]byte
    MinTime, CurTime  uint32
    Bits              uint32             // nBits
    Height            int32
    Mutable           []string           // ["transactions", "prevblock", ...]
    WitnessCommitment []byte             // BIP-141
}

type TemplateTx struct {
    TxID        [32]byte
    Hash        [32]byte    // wtxid
    Data        []byte      // raw tx
    Fee         int64
    SigOps      int
    Weight      int64
    Depends     []int       // for ancestor-set construction
}
```

Backends: `bitcoin-core` (JSON-RPC + cookie auth or RPC user/password), `knots` (same RPC surface plus extra policy options), and `external-http` (for users running a node on another machine).

**Cost:** ~80 hours. Most of the work is bulletproof JSON-RPC handling + auth + reconnect logic. The RPC surface is small (~5 methods used).

**Value/cost rank:** ★★★★★ — gateway capability for everything else in this ADR.

**Non-custodial check:** ✅ Otedama only reads from the user's own Bitcoin node. No third-party templates.

**Release:** v3.5.

### Sub-domain 2 — Template construction policy

**State of the art:** Bitcoin Knots offers fine-grained policy: `permitbaremultisig`, `acceptnonstdtxn`, `datacarrier`, `datacarriersize`, ancestor-set sizing, RBF policy, mempool fullness thresholds. Bitcoin Core 30+ has a narrower surface but covers the essentials. OCEAN's controversy (initial Ordinals/Inscriptions filter, later rescinded — April 2024) is the cautionary tale: **policy belongs to the miner, not the pool**.

**Otedama proposal:** A `TemplatePolicy` configuration consumed by `BitcoinNode.GetBlockTemplate`:

```go
// internal/btcnode/policy.go
type TemplatePolicy struct {
    // Selection criteria
    MaxBlockWeight     int64       // default 3,996,000 (Bitcoin consensus −4000 buffer)
    MaxSigOps          int         // default 80,000 (consensus −20,000 buffer)
    MinFeePerKvB       int64       // miner-set floor
    MinAncestorScore   float64     // miner-set; default 0 (accept any)

    // Inclusion controls (advisory; Bitcoin consensus is final)
    AllowDataCarriers  bool        // OP_RETURN
    MaxDataCarrierSize int         // bytes
    AllowBareMultiSig  bool
    AllowSegWit        bool        // default true
    AllowTaproot       bool        // default true

    // Censorship knobs (DEFAULT: ACCEPT EVERYTHING)
    // We explicitly do NOT ship any default deny list. Users must
    // opt in to any filtering. This avoids OCEAN-style controversy.
    DenyOutputScripts  [][]byte    // empty by default
    DenyTxIDPrefixes   [][]byte    // empty by default

    // Reproducibility
    Seed               int64       // RNG seed for tiebreaker ordering
}
```

We **explicitly ship empty deny-lists by default** and document this choice in the README and ADR. Otedama does not editorialize on what Bitcoin transactions are legitimate.

**Cost:** ~30 hours. Mostly configuration plumbing and validation.

**Value/cost rank:** ★★★★ — exposes the user's sovereignty.

**Non-custodial check:** ✅ User's policy, user's node.

**Release:** v3.5.

### Sub-domain 3 — Stratum V2 Job Declaration Client

**State of the art:** The SRI provides a Rust reference implementation of JDC. The protocol involves:

1. Connect to JDS (Job Declarator Server, pool-side) over Noise NX-encrypted channel.
2. `AllocateMiningJobToken.Request` → receive `mining_job_token`.
3. Build candidate block from `BitcoinNode.GetBlockTemplate`.
4. `DeclareMiningJob.Request` (full-template mode or short-id mode) → wait for `DeclareMiningJob.Success`.
5. `SetCustomMiningJob` to the pool's Mining Protocol channel → pool acks.
6. Distribute job to downstream mining devices.
7. Forward shares back; if a winning block is found, submit to both the pool (via Mining Protocol) and the local node (via `submitblock`).

Failure modes the spec calls out: token allocation timeout, declaration rejection, valid shares rejected by pool, JDS disconnect.

**Otedama proposal:** A `StratumV2JDC` implementation in `internal/poolproto/sv2jdc/`:

```go
// internal/poolproto/sv2jdc/client.go
type Client struct {
    pool       *url.URL            // JDS endpoint
    poolPubKey [32]byte            // for Noise NX
    node       btcnode.BitcoinNode
    policy     btcnode.TemplatePolicy
    miningCh   poolproto.MiningChannel
}

// Run drives the declare-mine-submit loop until ctx cancellation
// or unrecoverable error.
func (c *Client) Run(ctx context.Context) error

// Compile-time assertion
var _ TemplateSource = (*Client)(nil)
```

The implementation reuses `internal/stratum/noise*.go` for the Noise NX handshake. (**Erratum (session 497):** the previous parenthetical claimed this code is "already production-ready" — it is not: `KNOWN_LIMITATIONS.md` §2 documents that it is never called by the live connect path, uses P-256 instead of spec-mandated secp256k1+ElligatorSwift, discards the `mixKey` cipher output, and performs no responder authentication. Reusing it would inherit those gaps; this ADR's cost estimate should be read as including a Noise rework or dependency on ADR-011.)

**Cost:** ~150 hours. Protocol parsing + message orchestration + integration with existing Noise NX layer + error recovery semantics. The SRI Rust source serves as a reference implementation but we don't link against it.

**Value/cost rank:** ★★★★★ — this is the canonical decentralized-mining path going forward.

**Non-custodial check:** ✅ Miner declares jobs, pool only accounts shares. No custody.

**Release:** v3.6 (after btcnode lands in v3.5).

### Sub-domain 4 — DATUM Gateway client

**State of the art:** OCEAN's `datum_gateway` is C, GPL-licensed, ~7,000 LOC. It implements:

1. Local Bitcoin node connection (RPC over HTTP).
2. Mempool monitoring (via `getblocktemplate` polling and `blocknotify`).
3. Template construction with OCEAN-allowed `coinbase_aux` for reward-split signaling.
4. Stratum V1-flavored connection to OCEAN's pool stratum (OCEAN uses an extended V1 dialect for DATUM, not native SV2).
5. Merkle-branch-only share submission — pool never sees the transactions.

Bitronics blog (October 2025) documents end-to-end setup for Bitaxe/Nerdaxe users.

**Otedama proposal:** A `DATUMClient` implementation in `internal/poolproto/datum/`:

```go
// internal/poolproto/datum/client.go
type Client struct {
    poolStratum  *url.URL          // OCEAN stratum endpoint
    payoutAddr   string            // user's Bitcoin address (non-custodial)
    rewardSplit  RewardSplit       // optional: secondary payouts
    node         btcnode.BitcoinNode
    policy       btcnode.TemplatePolicy
}

// Compile-time assertion
var _ TemplateSource = (*Client)(nil)
```

DATUM's wire format is **Stratum V1-compatible** with extended fields for the coinbase commitment. Most of the work is faithful translation of `datum_gateway`'s C logic — feasible because the source is open-source and well-commented.

**Cost:** ~120 hours. The protocol surface is smaller than JDP, but reimplementing C in Go always involves edge cases (endianness, struct packing, signed-vs-unsigned, error semantics).

**Value/cost rank:** ★★★★ — OCEAN is ideologically aligned with Otedama and has Tether-backed global deployment momentum. Supporting DATUM unlocks the largest non-custodial pool.

**Non-custodial check:** ✅ OCEAN is explicitly non-custodial; DATUM's `coinbase_aux` signaling is verifiable on-chain.

**Release:** v3.7.

### Sub-domain 5 — Solo mining mode

**Update (session 504):** the production set is wider than when this ADR was drafted — the official stratumprotocol.org ecosystem table now lists **Blitzpool, MKPool, NexusPool, Public Pool, and PyBlock Pool** as production solo pools, plus Braiins Pool and DMND as production pools (DMND with miner-selected templates), and SV2-native firmware in production from Auradine (FluxOS), Bitaxe, and BraiinsOS.

**Update (session 504 — BIP110):** July 2026 saw the first live template-signaling deployment: **BIP-110 (Reduced Data Temporary Softfork)** reached ~10% of listening nodes via a Knots-based activation client, and OCEAN launched dedicated signaling Stratum endpoints (`bip110.mine.ocean.xyz:3110`, `no-signal.mine.ocean.xyz:3000`) plus a chain-split contingency that effectively runs OCEAN as two pools on either side of a split. This is directly relevant here: template authorship now determines not just transaction selection but *which consensus chain a miner lands on* — strengthening this ADR's requirement that any solo/JDP path verify its work against the miner's own node's consensus rules, not the pool's.

**State of the art:** Blitzpool currently runs SV2 for solo miners. The "solo mining" pattern is: miner runs their own Bitcoin node, constructs templates, **submits found blocks directly to the network**, and pays themselves 100% of the reward (no pool variance smoothing, but no pool fees either). At ~1 PH/s, expected block-finding interval is roughly a decade; at ~100 PH/s, a few months. Useful for testnet, regtest, and users with very large hashrate or strong ideological preference for variance.

**Otedama proposal:** A `SoloMining` template source that bypasses pool protocols entirely:

```go
// internal/poolproto/solo/client.go
type Client struct {
    node       btcnode.BitcoinNode
    policy     btcnode.TemplatePolicy
    payoutAddr string                  // P2WPKH or P2TR address for coinbase
}

func (c *Client) Run(ctx context.Context) error {
    // 1. Fetch fresh template via getblocktemplate
    // 2. Construct coinbase paying entirely to payoutAddr
    // 3. Build merkle tree, distribute work to downstream miners
    // 4. On winning share: submitblock(raw) directly to local node
    // 5. No pool, no shares-of-payout, no third party
}
```

Includes a regtest mode for end-to-end testing without using mainnet hashrate.

**Cost:** ~60 hours. The merkle tree construction and `submitblock` flow are well-understood. Most work is integration with existing miner workers.

**Value/cost rank:** ★★★ — niche but ideologically maximal. Useful for users running large private operations or for Otedama's own test infrastructure.

**Non-custodial check:** ✅ Maximally non-custodial — there is no pool.

**Release:** v3.7 (alongside DATUM).

### Sub-domain 6 — Template-aware metrics and observability

**State of the art:** Without miner-constructed templates, "fee capture" is invisible to the miner — the pool decides. With JDP/DATUM, the miner sees its own template-construction quality: total fees included, txs rejected by pool, merkle branch acceptance rate.

**Otedama proposal:** Extend the existing `internal/metrics/` Prometheus exposition with template-construction metrics:

```
# HELP otedama_template_fees_satoshis Total satoshis in fees in the
# template the miner constructed
# TYPE otedama_template_fees_satoshis gauge
otedama_template_fees_satoshis{source="sv2jdc",pool="braiins"} 12543210

# HELP otedama_template_tx_count Number of transactions in the
# miner-constructed template
# TYPE otedama_template_tx_count gauge
otedama_template_tx_count{source="sv2jdc"} 2451

# HELP otedama_template_declaration_rejections_total Number of
# DeclareMiningJob requests rejected by the pool's JDS
# TYPE otedama_template_declaration_rejections_total counter
otedama_template_declaration_rejections_total{pool="braiins",reason="..."} 0

# HELP otedama_template_block_weight_bytes Current template weight in bytes
# TYPE otedama_template_block_weight_bytes gauge
otedama_template_block_weight_bytes 3984211

# HELP otedama_template_fee_capture_ratio Ratio of this template's fees
# to the network median fee for blocks at this height. >1 = better than median.
# TYPE otedama_template_fee_capture_ratio gauge
otedama_template_fee_capture_ratio 1.07
```

The `fee_capture_ratio` gauge measures Braiins' published "up to 7.4% profit uplift" claim **for the specific user**. If a miner's ratio is consistently ≥1.0, JDP/DATUM is paying off. If consistently <1.0, they should investigate their template policy.

**Cost:** ~40 hours. Wiring into existing metrics + Grafana dashboard panels.

**Value/cost rank:** ★★★★ — without this, the user has no way to know if their decentralized template is actually better.

**Non-custodial check:** ✅ User's metrics.

**Release:** v3.6 (alongside JDC).

---

## Architectural sketch

```
otedama/
├── cmd/otedama/
│   └── template_cmd.go             # `otedama template` subcommand
├── internal/
│   ├── btcnode/                    # NEW
│   │   ├── node.go                 # BitcoinNode interface
│   │   ├── core_rpc.go             # Bitcoin Core JSON-RPC
│   │   ├── knots_rpc.go            # Knots-specific extensions
│   │   ├── external.go             # HTTP proxy to remote node
│   │   ├── policy.go               # TemplatePolicy
│   │   └── template.go             # Template/TemplateTx
│   │
│   ├── poolproto/                  # existing
│   │   ├── template_source.go      # NEW: TemplateSource interface
│   │   ├── sv2jdc/                 # NEW: SV2 Job Declarator Client
│   │   │   ├── client.go
│   │   │   ├── handshake.go
│   │   │   ├── declare.go
│   │   │   └── token.go
│   │   ├── datum/                  # NEW: OCEAN DATUM client
│   │   │   ├── client.go
│   │   │   ├── coinbase_aux.go
│   │   │   └── merkle.go
│   │   ├── solo/                   # NEW: Solo mining mode
│   │   │   └── client.go
│   │   └── stratumv1/              # existing pass-through (no template)
│   │
│   ├── engine/                     # existing — gains TemplateSource injection
│   │   └── run.go
│   │
│   └── metrics/                    # existing — gains template_* metrics
│       └── template.go             # NEW
```

The `TemplateSource` interface is the unifying abstraction:

```go
// internal/poolproto/template_source.go
type TemplateSource interface {
    // Identity
    Name() string                   // "sv2jdc", "datum", "solo", "passthrough"
    PoolURL() *url.URL              // nil for solo

    // Lifecycle
    Run(ctx context.Context) error  // blocks until ctx done or fatal error

    // Streaming outputs
    Jobs() <-chan Job               // jobs to distribute to miners
    Shares() chan<- Share           // shares from miners (for forwarding)

    // Observability
    Metrics() TemplateMetrics
}

type TemplateMetrics struct {
    FeesSatoshis         int64
    TxCount              int
    BlockWeight          int64
    DeclarationsAccepted int64
    DeclarationsRejected int64
    LastTemplateAt       time.Time
}
```

`internal/engine/run.go` selects the `TemplateSource` based on the pool URL scheme:

```go
// Pseudocode in engine.runSession
func selectTemplateSource(poolURL *url.URL, node btcnode.BitcoinNode, policy btcnode.TemplatePolicy) (poolproto.TemplateSource, error) {
    switch poolURL.Scheme {
    case "stratum+v2tls", "stratum+v2":
        if hasJDP(poolURL) {
            return sv2jdc.New(poolURL, node, policy)
        }
        return passthrough.New(poolURL)   // pool-constructed templates
    case "datum":
        return datum.New(poolURL, node, policy)
    case "solo":
        return solo.New(node, policy)
    case "stratum+tcp", "stratum+tls":
        return passthrough.New(poolURL)   // V1 legacy
    default:
        return nil, fmt.Errorf("unknown scheme: %s", poolURL.Scheme)
    }
}
```

This is a clean dispatch — each user picks their pool and gets the right template-construction strategy automatically.

---

## `otedama template` UX proposal

```
$ otedama template --help
Pool decentralization layer

Usage:
  otedama template status               show current template stats
  otedama template policy show          display effective TemplatePolicy
  otedama template policy edit          open policy in $EDITOR
  otedama template node ping            check Bitcoin Core/Knots reachable
  otedama template node info            show synced height, mempool size, etc.
  otedama template benchmark            simulate 100 templates against current mempool
  otedama template explain              explain current template's fee composition

Flags:
  --node URL          override Bitcoin node URL
  --policy FILE       path to TemplatePolicy YAML
  --json              machine-readable output
```

Example output of `otedama template status`:

```
=== Otedama template source ===
Active source: sv2jdc → stratum+v2tls://braiins.com:3336
Bitcoin node: bitcoin-core 30.1 at 127.0.0.1:8332 (Knots-compatible policy)
Current template:
  Height:       874,213
  Transactions: 2,451
  Weight:       3,984,211 / 3,996,000 bytes (99.7%)
  Total fees:   0.12543210 BTC
  Coinbase:     3.25043210 BTC (subsidy 3.125 + fees 0.125)
Last 24h declarations: 142 accepted / 0 rejected
Fee-capture ratio:    1.07× (network median: 0.11734200 BTC)
```

This output makes the "up to 7.4% uplift" claim **measurable for the user's specific scenario**.

---

## Quantitative reasoning — three scenarios

### Scenario A: Home miner, 1× Antminer S21 (200 TH/s), $0.08/kWh, runs own Bitcoin node

**Without JDP/DATUM (pool template):**
- Daily revenue (hashprice $48/PH/day): 0.2 PH × $48 = $9.60/day
- Pool fee 2%: −$0.19
- Electricity (3500W × 24h × $0.08): −$6.72
- **Net: +$2.69/day**

**With Otedama JDP/DATUM at 1.07× fee capture:**
- Daily revenue base: $9.60
- Fee capture uplift (only on fees, ~25% of revenue → 1.07× of that): +$0.17/day
- **Net: +$2.86/day** (+6.3% margin)

Modest in absolute terms, but **pure upside with zero additional electricity cost**. Over 5 years: ~$310 additional revenue per S21.

### Scenario B: Small farm, 30× Antminer S21, $0.06/kWh, 1 dedicated full node

**Without JDP/DATUM:**
- Daily revenue: 30 × 0.2 PH × $48 = $288/day
- Pool fee 2%: −$5.76
- Electricity: 30 × 3500W × 24h × $0.06 = $151.20
- **Net: +$131.04/day = $3,931/month**

**With Otedama JDP at 1.07× fee capture + 0.5% pool fee reduction (DMND offers reduced fees for JDP miners):**
- Revenue base: $288
- Fee uplift: 30 × $0.17 = +$5.10
- Pool fee saving (2% → 1.5%): +$1.44
- **Net: +$137.58/day = $4,127/month**

**Annual uplift: ~$2,352/year** on identical hardware. Combined with ADR-008 power optimization (~$8,000/year), the v3.5–v4.0 roadmap delivers **~$10,000/year per 30-device farm**.

### Scenario C: Solo miner on regtest/testnet

Otedama's solo mining mode enables **regtest end-to-end integration testing without external pools**. This is primarily an engineering asset, not a revenue scenario. Reduces CI cost and speeds up feature development on the template-construction path.

---

## Cost summary

| Sub-domain | Hours | Release | Value/Cost |
|-----------|-------|---------|------------|
| 1. Bitcoin node integration | 80 | v3.5 | ★★★★★ |
| 2. Template construction policy | 30 | v3.5 | ★★★★ |
| 3. Stratum V2 JDC | 150 | v3.6 | ★★★★★ |
| 4. DATUM client | 120 | v3.7 | ★★★★ |
| 5. Solo mining mode | 60 | v3.7 | ★★★ |
| 6. Template-aware metrics | 40 | v3.6 | ★★★★ |
| **Total** | **480h** | v3.5–v3.7 | — |

480 hours over 18 months at 10h/week = 720 hours available → **33% buffer**. Comfortable.

---

## Combined roadmap impact

Adding ADR-009 to the existing v3.5–v4.0 plan:

| Track | Hours |
|-------|-------|
| ADR-010 (arbitration) | 290 |
| ADR-007 (Lightning, accepted features) | 575 |
| ADR-008 (hardware/power) | 595 |
| **ADR-009 (pool decentralization)** | **480** |
| **Total** | **1,940 hours over 24 months** |

Available at 10h/week × 104 weeks = 1,040 hours → **88% over budget**.

**Implication: must cut.** The honest priority order (preserving non-custodial core):

1. **ADR-009 (pool decentralization)** — completes ADR-002's commitment to V2-only with actual sovereignty exercise. **MUST SHIP v3.5–v3.7.**
2. **ADR-008 (hardware/power)** — 2028 halving survival. **MUST SHIP v3.5–v3.7.**
3. **ADR-010 (arbitration intelligence)** — depends on ADR-008 outputs for power-cost-aware decisions. **SHIP v3.5–v3.6.**
4. **ADR-007 Lightning embedded node (B4–B10, ~370h)** — **DEFER to v4.1**. BOLT12 receive (B1–B2, ~85h) ships in v3.5.

Adjusted v3.5–v4.0 budget:
- ADR-010: 290h
- ADR-007 partial (BOLT12 only): 85h
- ADR-008: 595h
- ADR-009: 480h
- **Total: 1,450 hours** vs 1,040 available = **40% over**.

Even with the Lightning embedded-node cut, the schedule is tight. **The realistic minimum viable v4.0** is:
- ADR-008 ASIC firmware adapters (LuxOS + BraiinsOS+ + stock) + TOU (Octopus Agile): ~270h
- ADR-009 btcnode + policy + JDC (no DATUM, no solo): ~260h
- ADR-010 Holt-Winters forecaster + switching-cost ledger + Bayesian calibration: ~100h
- ADR-007 BOLT12 receive: ~85h
- **Minimum viable: 715 hours** = 71.5 weeks at 10h/week ≈ 17.5 months. Fits if we accept that some features ship in v4.1.

---

## Mutually-reinforcing clusters

- **{ADR-009-sub1, ADR-009-sub2, ADR-009-sub3}**: btcnode + policy + JDC ship as one V2 capability.
- **{ADR-009-sub6, ADR-008}**: template metrics + power metrics share Prometheus exposition infrastructure.
- **{ADR-009-sub3, ADR-010}**: JDC's fee-capture metrics feed back into arbitration engine's yield forecasting.
- **{ADR-009-sub4, ADR-007-B1}**: DATUM uses OCEAN's BOLT12-receive payouts; both ship for OCEAN users.

---

## Non-custodial constraint check (consolidated)

| Feature | Constraint Check |
|---------|------------------|
| Sub-domain 1 (btcnode) | ✅ Otedama only reads user's own node |
| Sub-domain 2 (policy) | ✅ User-controlled; default = accept everything |
| Sub-domain 3 (JDC) | ✅ Pool only accounts shares, never sees txs unless full-template mode by user choice |
| Sub-domain 4 (DATUM) | ✅ OCEAN's protocol is explicitly non-custodial |
| Sub-domain 5 (solo) | ✅ Maximally non-custodial — no pool |
| Sub-domain 6 (metrics) | ✅ Local observability |

**Considered and rejected features:**

- *"Run a pool-operator-side JDS (Job Declarator Server)"* — would make Otedama a pool. Custodial by definition. **OUT.**
- *"Aggregate templates from multiple Otedama users for institutional miner customers"* — re-implements the pool problem we're trying to solve. **OUT.**
- *"Build a private mempool service for Otedama users"* — adds custody-of-data and proxy-trust dimensions. **OUT.**
- *"Default deny-list of 'spam' transactions"* — OCEAN's 2024 Ordinals controversy is the cautionary tale. Otedama explicitly does not editorialize on Bitcoin transaction legitimacy. **OUT.**

---

## Risks and external dependencies

1. **JDP spec is still evolving (May 2026).** Working Group expansion brings new requirements. Mitigate by tracking the spec versions in `internal/poolproto/sv2jdc/spec_version.go` and supporting at least the current and previous minor versions.

2. **Bitcoin Core 30+ deprecation of `getblocktemplate`?** No deprecation announced as of May 2026, but Core has discussed alternatives (`getblocktemplate light` proposal). We monitor and version-pin.

3. **DATUM is OCEAN-controlled.** OCEAN could change the wire format. Mitigate by treating DATUM client as a versioned protocol and committing to OCEAN compat for at least 6 months after any breaking change.

4. **`bitcoind` RPC auth model is awkward** (`cookie` file or `rpcuser`/`rpcpassword`). We document both paths clearly and provide a `otedama template node ping --auto-detect-cookie` helper.

5. **Mempool policy divergence between Bitcoin Core and Knots.** A miner running Knots will construct different templates than one running Core. Our `TemplatePolicy` exposes both surfaces; users choose.

6. **Pool refusal to accept user-declared templates.** Some pools may technically support JDP but routinely reject declarations (e.g., as anti-spam). Our metrics expose this directly via `template_declaration_rejections_total`; users can switch pools.

7. **Censorship pressure on the miner.** A government could compel a miner to filter transactions. ADR-009 explicitly does not provide built-in deny-lists; users who add their own do so under their own responsibility. We document the legal landscape in `docs/TEMPLATE_POLICY_LEGAL.md` as a separate cautionary deliverable.

8. **2028 halving cuts fee importance relative to subsidy.** Wait — actually the opposite: as subsidy halves (3.125 → 1.5625 BTC), fees become **proportionally more important**, increasing JDP/DATUM value. This ADR's value increases post-halving, not decreases.

---

## Decision threshold to ship

- **v3.5 cut:** sub-domains 1 (btcnode Core RPC) + 2 (policy). Must pass: `otedama template node ping` works against Bitcoin Core 28+ and Knots; `getblocktemplate` returns parseable templates; reconnect logic recovers from node restart within 5s.

- **v3.6 cut:** sub-domains 3 (SV2 JDC) + 6 (metrics). Must pass: end-to-end interop test against SRI community pool; declaration rejection rate ≤ 1% over 24h; fee-capture ratio metric verifiable against mempool.space snapshots.

- **v3.7 cut:** sub-domains 4 (DATUM) + 5 (solo). Must pass: shares accepted by OCEAN production stratum; solo regtest mode finds and submits regtest blocks in <60s.

- **v4.0 polish:** consolidated template UI, security audit of the new RPC/protocol surface (recommended: ~30h external audit budget).

---

## Implementation order (concrete steps)

1. Land `internal/btcnode/` skeleton with Bitcoin Core RPC + cookie auth (v3.5-α1).
2. Implement `TemplatePolicy` with sensible defaults (accept everything, no deny lists).
3. Wire `BitcoinNode.GetBlockTemplate` into a dry-run mode (`otedama template benchmark` doesn't yet drive a real pool).
4. v3.5 release with btcnode + policy + benchmark mode.
5. Implement SV2 JDC against SRI community pool in v3.6 (uses existing `internal/stratum/noise*.go`).
6. Add `template_*` Prometheus metrics in v3.6.
7. v3.7 brings DATUM client (translate OCEAN's C → Go) and solo mining mode.
8. v4.0 polish + audit.

---

## Connection to existing ADRs

- **ADR-002 (Stratum V2 only):** ADR-009 completes the promise. ADR-002 said "V2 because miner sovereignty." ADR-009 says "and here is the code that actually exercises sovereignty."
- **ADR-010 (arbitration engine):** Fee-capture ratio becomes another input to the engine's yield forecasting. A pool consistently rejecting our declarations is a strong signal to switch pools.
- **ADR-007 (Lightning):** DATUM users typically receive payouts via BOLT12 over Lightning. ADR-007's BOLT12 receive (v3.5) and ADR-009's DATUM client (v3.7) ship as a paired OCEAN experience.
- **ADR-008 (hardware/power):** Template construction is a CPU task on the user's Bitcoin node, not the miner. The two don't compete for power budget.

---

## Ecosystem update (session 511, September 2026)

**First known production JDP block.** On June 25–26, 2026 DMND mined
mainnet block **955,318** for GoMining — the first block produced via
Stratum V2 Job Declaration where a *miner* (not the pool) constructed and
declared its own template (verified against DMND's announcement and
Bitcoin Magazine's report). GoMining used it for a real purpose — the
template carried its own GoBTC Pay transactions — so this is the
end-to-end existence proof for the miner-declared path this ADR builds
on: template declaration is no longer specification-only or test-only; it
has produced a confirmed mainnet block through a live pool. This
strengthens the "Why now" argument's premise that pools will accept
miner-declared templates at scale. (Recorded here rather than in the
Context section per the original-text-immutable convention.)

- DMND announcement:
  https://blog.dmnd.work/dmnd-mines-the-first-known-bitcoin-block-using-stratum-v2-job-declaration/
- Bitcoin Magazine report:
  https://bitcoinmagazine.com/bitcoin-mining/bitcoin-mining-pool-dmnd-mines

---

## Ecosystem update (session 518, September 2026)

Two specification-level developments since the production-JDP evidence
recorded in this ADR:

- **sv2-spec PR #194 merged (2026-06-16): "allow implementations to use
  error codes for automated actions."** The Mining Protocol spec now
  explicitly blesses acting on `SubmitSharesError`/`OpenMiningChannelError`
  error codes programmatically — the upstream justification for Otedama's
  canonical reject-code classification (mapping standardized codes to
  reject families before substring heuristics, in flight since session
  257's open PRs). Error-code-driven behaviour is now spec-sanctioned,
  not an implementation liberty.
- **sv2-spec PRs #202 and #203 (open): a non-custodial pool-payouts
  extension for JDP.** Two competing designs — #202's request/response
  payout-set flow vs #203's push-based approach that avoids the
  declaration RTT — are converging on letting a miner declare its own
  payout outputs inside a Job Declaration, closing the last custody gap
  in the SV2 stack (today even a JDP pool assembles the coinbase). This
  is directly on Otedama's sovereignty axis: when it lands, a
  miner-declared template can carry the miner's own payout outputs, so
  `payout_scheme: tides` ceases to be the only non-custodial payout
  option. Track both PRs; whichever merges defines the wire format a
  future `internal/btcnode` JDC would need.

---

## Ecosystem update (session 520, September 2026)

- **Upstream now ships an orchestrated JDP stack (`stratum-mining/sv2-ui`).**
  A Docker-based setup wizard + monitoring dashboard that composes the
  Translator Proxy, the JDC, and Bitcoin Core IPC (30.x/31.x) into solo,
  pool-JD, and sovereign-solo deployments. The "hand-assembled stack"
  gap this ADR prices into the effort estimate is closing upstream: a
  future Otedama JDC integration can target the same component set
  sv2-ui orchestrates rather than bespoke wiring.
- **Go 1.27 released (August 2026); repo verified green under
  go1.27.1.** `go test ./...` passes on all 23 packages under
  go1.27.1; no stdlib symbols newer than the `go 1.22` directive are
  used, so 1.27's new default `stdversion` vet check is clean, and the
  godebug block parses under 1.27's rule accepting removed GODEBUG
  settings at their final values. The toolchain-pin bump itself remains
  owned by the closed-PR line (#369) and is not re-delivered here.

---

## Ecosystem update (session 521, September 2026)

- **Adoption trajectory:** third-party trackers put SV2 transport at an
  estimated 15–20% of network hashrate in early 2026 (mostly for
  encryption alone), with the SRI working group projecting 40–60% by
  end of 2026 as V2-capable firmware becomes the ASIC default — a
  forecast, not a measurement. The seven-pool working-group commitment
  (May 2026) remains the load-bearing datapoint.
- **Repository landscape clarified:** `stratum-mining/stratum` (SRI
  monorepo, Rust) and `stratum-mining/sv2-apps` (application layer —
  translator, JDC, sv2-ui) coexist; the JD tooling referenced by this
  ADR lives in sv2-apps.
- **Community pattern noted:** `cbyam/solo-pool-rs` auto-detects
  SV1-vs-SV2 per connection on a single listen port from the first
  frame byte — an existence proof that the two protocols can share a
  transport surface, should Otedama ever expose a listening endpoint.

---

## Ecosystem update (session 530, September 2026)

Two sv2-spec merges since the last pass:

- **#230 merged (2026-09-10): the Noise certificate `version` field is
  now normative** — `version` MUST be 0, and the initiator MUST reject
  a certificate whose version it does not support (closes #229: the
  field previously had no defined value and implementations
  disagreed). Otedama's `internal/stratum/noise*.go` does not yet
  parse the responder certificate at all (responder authentication is
  a recorded gap — KNOWN_LIMITATIONS §2 / ADR-009 errata), so this is
  a forward requirement: when certificate validation lands, it must
  include the `version == 0` check-and-reject, not just signature
  verification. Also clarified: the authority-key base58 prefix
  versions only the key encoding, unrelated to the cert `version`.
- **#233 merged (2026-09-23):** upstream added `AGENTS.md` conventions
  for coding agents — meta, no protocol impact.

---

## Ecosystem update (session 542, September 2026)

sv2-spec merged four relevant PRs since the last ecosystem check:

- **#220 (merged 2026-09-08):** fixed the Noise Act 2 message length
  to 234 bytes and added the `ELLSWIFT_PUBKEY` type alias. This is a
  wire-level normative fix: the responder's second handshake message
  is exactly 234 bytes. Otedama's `noise.go` `ReadMessage2` currently
  accepts any payload >= 32 bytes (lenient, plus the P-256 probes
  tracked in KNOWN_LIMITATIONS §2). Conformance requirement recorded:
  when the Noise path is completed per §2, Act 2 MUST be validated at
  exactly 234 bytes.
- **#221 (merged 2026-09-12):** dropped the Lightning-borrowed "Act"
  terminology from the Noise section in favor of Noise-framework
  "steps", and made the implicit trailing payload explicit in the
  pattern notation. Documentation-only; no behavior change.
- **#224 (merged 2026-09-22):** editorial cleanup (wording, typos,
  wrong references, diagrams). No normative changes.
- **#209 (merged 2026-08-20):** added explicit prohibitions — a pool
  MUST NOT reuse an active `job_id`, and `SetNewPrevHash` MUST NOT
  reference a job the client has never received. Otedama conformance
  verified: `engine/run.go` already pauses hashing and warns on an
  unknown-job SetNewPrevHash (defensive handling beyond the spec
  minimum); duplicate `job_id` is last-wins in the job map, which is
  a safe defensive choice against a MUST-NOT violation.

SRI remains at v1.11.1 (2026-07-22). Notable fix in that patch:
`stratum_translation` no longer rounds up SV1 difficulty values
during conversion (#2227) — more accurate target calculation when
bridging V1 miners to V2 pools. Otedama computes targets with
big.Int exact math (`sha256d.go`), so the upstream rounding class
does not apply; verified no analogous round-up in `TargetFromDifficulty`.

## References

- Stratum V2 Working Group expansion (May 7, 2026):
  https://news.bitcoin.com/bitcoin-mining-pool-giants-foundry-antpool-and-f2pool-signal-stratum-v2-shift/
- Stratum V2 spec (Job Declaration Protocol):
  https://stratumprotocol.org/specification/06-job-declaration-protocol/
- Stratum V2 spec (Mining Protocol):
  https://stratumprotocol.org/specification/05-mining-protocol/
- Stratum V2 specification, canonical source (independently versioned
  from the SRI roles code since v1.5.0 — stratumprotocol.org renders
  this repo):
  https://github.com/stratum-mining/sv2-spec
- OCEAN DATUM Gateway (C, GPL):
  https://github.com/OCEAN-xyz/datum_gateway
- OCEAN DATUM docs:
  https://ocean.xyz/docs/datum
- Bitronics DATUM Gateway setup guide:
  https://bitronics.store/datum-gateway-on-your-node-bitaxe-nerdaxe/
- D-Central Stratum V2 guide (Feb 2026):
  https://d-central.tech/what-is-the-stratum-v2-mining-protocol/
- D-Central OCEAN guide (Mar 2026):
  https://d-central.tech/ocean-mining-pool-guide/
- Blockspace DATUM vs SV2 analysis:
  https://blockspace.media/insight/ocean-pools-datum-is-live-heres-how-its-different-than-stratum-v2/
- OpenSats Stratum V2 funding:
  https://opensats.org/projects/stratumv2

---

## Status

**Proposed.** This ADR introduces a fourth feature-deepening track to the v3.5–v4.0 roadmap, completing the strategic picture: arbitration intelligence (ADR-010), Lightning capability (ADR-007), hardware/power awareness (ADR-008), and now pool decentralization (ADR-009).

The combined cost (~1,940h over 24 months) significantly exceeds the available 1,040h solo-maintainer budget. The ADR is honest about this and proposes a minimum-viable v4.0 (~715h) with deferred features in v4.1.

**Recommended next steps:**
1. Update ROADMAP.md to include Track D — Pool decentralization (ADR-009).
2. Update CHANGELOG.md with research-and-architecture entry.
3. Land `internal/btcnode/` skeleton in the next minor as a no-op scaffold (low cost, signals direction).
4. Begin Bitcoin Core RPC adapter as the first concrete deliverable.

---

## Session-600 ecosystem update (2026-09-30)

**SRI v1.12.0 (2026-09-17)** — largest hardening release to date:
`channels_sv2` received a correctness pass enforcing `min_ntime`/`nTime`
bounds across all channel types, hardened share dedup and extranonce-
prefix rotation, and fixed several consensus-invalid coinbase
construction bugs. `codec_sv2`/`framing_sv2` were split into
`MessageFrame`/`SerializedFrame`; `noise_sv2` dropped AES-256-GCM,
leaving ChaCha20-Poly1305 the sole cipher. Otedama alignment: already
ChaChaPoly-only (noise.go) and min_ntime semantics are correct
(dialer.go future-job wait + `max(SetNewPrevHash.ntime, MinNtime)`);
the share-side ntime enforcement is pool-side validation — clients
only need ntime ≥ min_ntime, which emit() guarantees.

**sv2-spec #203 (open)** — non-custodial payouts extension via JDP:
push-based payout construction avoiding RTT latency, alternative to
#195/#202. Directly relevant to the non-custodial wallet + JDP
direction; watch for spec stabilization before ADR-009 phase 2.

**sv2-apps #638 (open)** — JDC opt-in `accept_upstream_tip_work`: a
JDC may mine the pool's template when its tip is ahead, bounded by a
timeout (default-off). Addresses the honest-latency case for solo JDP
stacks; worth mirroring as an opt-in knob if/when the JDP client lands.

## Session-660 ecosystem update (2026-10-03)

sv2-spec remains in a quiet window: no merges since the Oct-2 batch (the
roles-terminology #231 was the last). The only open active item is #236
(`SetTarget.target` must not exceed the channel's `max_target`), which has
matured rather than stalled: review discussion added a race-condition nuance —
when a client *lowers* `max_target`, a `SetTarget` arriving above the new bound
cannot be an in-flight race crossing, so the client should allow a grace period
for the server to send a conforming `SetTarget` or `UpdateChannel.Error` before
treating it as a violation. The bound remains a server-side obligation and is
still a non-issue for Otedama: it never advertises `max_target` in
`OpenMiningChannel` (internal/stratum/handshake.go), so the constraint is
vacuous on our wire.

No new spec issues opened in the window. sv2-apps activity is housekeeping only
(AGENTS.md doc placement). SRI stays at v1.12.0 — no new release to track.

## Session-688 ecosystem update (2026-10-03)

Quiet window confirmed for a second recheck: sv2-spec merged list still ends at
#231 (10/2 roles clarification) after the Oct-1 normative batch; open items
unchanged — #236 (SetTarget ≤ max_target, server-side only), #234 (authority-key
mgmt), #198 (`coinbase_witness`, TDP-side), #203 (payouts extension), plus stale
editorial #232/#186 and the 2024 WIP #103. SRI release: v1.12.0 (unchanged).

sv2-apps: #839 (JDS job-token → `user_identity` binding), #845 (target-field
rename tracking spec #228), #856 (`bitcoin_core_sv2` hardening) all remain open —
#839 is still the notable item for this ADR's custody argument; no landed change
affects Otedama's client-only footprint.

Conclusion unchanged: nothing in flight requires wire or docs adjustments.

## Session-676 ecosystem update (2026-10-03)

sv2-spec remains quiet — no merges since the Oct-1 normative batch and the
10/2 roles clarification (#231, recorded in Session-654). Open items unchanged:
#236 (`SetTarget.target` ≤ channel `max_target` — server-side, vacuous for a
client that never advertises `max_target`), #234 (authority-key mgmt), #198
(`coinbase_witness`, TDP-side), #203 (payouts extension). #232/#186 are editorial
table-cell cleanups; #103 stays a 2024 WIP. SRI release: v1.12.0 (unchanged).

sv2-apps activity of note: #845 renames `target`-message fields to follow the
#228 spec cleanup — the same alignment Otedama made in PR #704, so the tree is
already consistent. #839 (jds) binds mining-job tokens to `user_identity` on
`SetCustomMiningJob` — the reference JDS tightening job-token custody in the
same direction as this ADR's payout-control argument; worth watching if it
lands. #856 (`bitcoin_core_sv2` hardening) and #881 (`handle_push_solution`)
are routine robustness work.

No changes to the ADR's conclusions: the demand-side SV2 trajectory still
favors pool-side JDP payout isolation, and Otedama's client-only footprint is
unaffected by every open normative item.

## Session-668 ecosystem update (2026-10-03)

Seventh recheck of the upstream landscape since the session-660 update:

- **sv2-spec** — no merges since the Oct-1 normative batch; #231's role-terminology
  definitions remain the newest normative text. The open list is unchanged:
  #236 (`SetTarget.target` ≤ channel `max_target`; still server-side, vacuous for
  Otedama which never advertises a max_target), #234 (authority-key management),
  #203 (payouts extension), #198 (coinbase_witness). No new issues filed.
- **SRI** — v1.12.0 remains latest (2026-09-17).
- **sv2-apps** — housekeeping continues (#907 docs, #900 stratum-core bump, #875
  single-workspace consolidation). Notably #857 adds *pool payout policy
  isolation for solo mining*: upstream pools now isolate payout policy per
  coinbase output — directly aligned with this ADR's decentralization thesis,
  and further evidence the ecosystem is standardizing the non-custodial payout
  pattern Otedama already ships.

No spec action required from Otedama. Continued monitoring of #236/#234.

## Session-654 ecosystem update (2026-10-03)

- **sv2-spec #231 merged (Oct-2):** "clarify Server/Client relationship across roles" landed — the pool role is now defined as `Mining Pool Server`, server/client terms are defined per protocol, and "one type of software can fulfill more than one role" is checkable rather than illustrative. Editorial/terminology only; wire format unchanged. No code impact for Otedama (docs consistently say "pool"); if a conformance doc ever names spec roles it should use `Mining Pool Server`.
- **sv2-spec #236 open (Oct-2, new):** `SetTarget.target` MUST NOT exceed the channel's `max_target` — closes the gap where an unconstrained `SetTarget` could undo the bounds that 5.3.3/5.3.5/5.3.7 put on the initial target and `UpdateChannel`. This is a server-side obligation; Otedama is unaffected (it advertises no `max_target` in `OpenMiningChannel` and accepts pool-assigned targets by design, see `internal/stratum/handshake.go`). Track to see if it lands.
- sv2-apps: housekeeping only (#907 agents docs).
- SRI: still v1.12.0 (2026-09-17).

## Session-643 ecosystem update (2026-10-02)

**sv2-spec: still quiet** — no merges since the Oct-1 normative batch
(#223/#225/#226/#227/#228, all recorded in the session-621 update).
The open landscape is unchanged from session-635:

- **#231 Server/Client role definitions** — still open, last activity
  Oct-2; converging on `Mining Protocol Server` terminology after
  plebhash dropped the third-party-JDS parts (Fi3's game-theory
  objection stands as out-of-scope follow-up). When it lands, Otedama
  docs may adopt `Mining Pool Server` role names (see #704 note).
- **#234 authority-key management** — idle since Sep-25 (21 review
  comments, no replies). Still tracks Otedama's Noise cert-verification
  gap noted in session-606.
- **#203 coinbase-transaction payouts** — idle since Sep-15; phase-2
  watch item, unchanged.
- **#198 coinbase_witness** — TDP-side only, N/A for Otedama.
- **#232 table-style** and stale editorial items — cosmetic.

**sv2-apps**: nothing since #900 (Sep-26 stratum-core bump) and #875
(single-workspace consolidation) — housekeeping only.

**SRI**: v1.12.0 (2026-09-17) remains the latest tag; no release in
the session-635 window.

Conclusion: no new normative content this window; the Otedama-side
record is current through the Oct-1 spec batch.

## Session-635 ecosystem update (2026-10-02)

Same-day recheck; state consistent with the session-627 sweep.

- **sv2-spec** — no merges since the Oct-1 normative batch (#223/#225/#226/#227/#228). Open PRs by activity:
  - **#231 Server/Client role definitions** — still open, Oct-2 discussion converging: `Mining Protocol Server` is the settled name for the upstream-facing server role (replaces the "pseudo-pool" wording); third-party-JDS trust concerns were dropped from scope. Editorial/wire-invariant — when it lands, Otedama docs can adopt the term for pool-facing roles.
  - **#234 authority-key management** — idle since Sep-25 (still the tracking item for the Noise certificate-verification gap).
  - **#198 `coinbase_witness` on NewTemplate** — TDP-side only; not applicable.
  - **#203 non-custodial payouts** — phase-2 watch item, unchanged.
- **sv2-apps** — housekeeping only: #900 stratum-core bump (Sep-26), #875 single-workspace consolidation (Sep-25). No new normative surface.
- **SRI** — v1.12.0 (2026-09-17) remains the latest tag.

---

## Session-627 ecosystem update (2026-10-02)

**sv2-spec merge queue is empty since the Oct-1 normative batch**
(#223/#225/#226/#227/#228 recorded in Session-621) — no new merges.
The open set is stable: #234 (authority key management/rotation) idle
since 2026-09-25; #203 (non-custodial payouts) still the ADR-009
phase-2 watch item.

**sv2-spec #231 (open, active 2026-10-02)** — "clarify Server/Client
relationship across roles": defines the previously undefined
`Client -> Server`/`Server -> Client` message labels, names the pool
role `Mining Pool Server` (with `Pool Server`/`Pool` as short forms),
and makes "one software can fulfill multiple roles" checkable rather
than illustrative. Editorial, no wire change — but once merged, role
references in our docs (`Mining Pool Server` vs. generic "pool")
should adopt the canonical names. No Otedama conformance impact.

**sv2-spec #198 (open)** — `coinbase_witness` field on `NewTemplate`
(TDP side), future-proofing for potential BIP141-related consensus
changes (closes #166, revives stalled #15). Template-provider side
only; Otedama submits shares, never builds templates — no action,
recorded for the phase-2 watch list.

**sv2-apps** — #2401 merged (patch `stratum-core` at the workspace
root; housekeeping, no protocol change). Nothing new affecting the
client-side surface since Session-621.

**SRI** — v1.12.0 (2026-09-17) remains the latest tag; no new release.

## Session-621 ecosystem update (2026-10-02)

**sv2-spec normative batch merged 2026-10-01** — five clarification
PRs landed together, tightening semantics without wire changes:

- **#228 field renames (soft-breaking)**: `UpdateChannel.maximum_target`
  → `max_target` (client-requested cap), `SetTarget.maximum_target` →
  `target` (server operating value), `min_ntime` → `ntime_start` in
  NewMiningJob/NewExtendedMiningJob/SetNewPrevHash/SetCustomMiningJob
  plus TDP `header_timestamp` → `ntime_start`, TDP SubmitSolution
  `header_timestamp`/`header_nonce` → `ntime`/`nonce`, JDP `prev hash`
  → `prev_hash`. Wire unchanged; names now encode cap-vs-operating and
  start-vs-minimum semantics. Otedama divergence: fields are
  `MaxTarget`, `MinNtime`/`HasMinNtime` — docs-level naming drift vs
  current spec; wire/protocol unaffected. If conformance polishing is
  desired, rename to match spec (`Target`, `NtimeStart`) — not urgent.
- **#226 min_ntime→ntime_start + share validation rules**: codifies
  that a share whose `ntime` is below the job's `ntime_start` is
  rejected server-side (it is the *pool's* share-validation minimum,
  not the consensus minimum). Otedama emit() already guarantees
  `ntime ≥ min_ntime` — consistent with the normative rule.
- **#225 SetupConnection validation rules + flag semantics** and
  **#223 protocol-version semantics**: tightened handshake-state
  requirements; Otedama sends/accepts standard flags — no action.
- **#227 spec-gaps normative clarifications** (27 comments): batch of
  explicit rules closing previously-ambiguous cases.
- **#221 noise: drop the Act** (merged 2026-09-12): removes the Noise
  "Act" ceremony terminology from the spec text; wire unchanged.

**sv2-spec #209 (merged 2026-08-20)** — the `job_id`-collision +
`SetNewPrevHash`-unknown-job prohibitions recorded as open at
session-542 have landed; Otedama already drops foreign-channel frames
(session-337) and bounds job maps.

**sv2-spec #234 (open, renamed)** — now "document authority key
management and rotation"; TheBlueMatt LGTM with nits, still open,
cross-referenced by #124 (key/certificate handling doc). The §4.8
requirements from session-606 stand unchanged: pin the authority key
from the `stratum+v2` URL, verify the authority signature at
handshake time only (established sessions need not terminate at
`not_valid_after`), tolerate transparent static-key rotation.
Otedama's alpha P-256 Noise stub still performs no certificate
parsing — the documented conformance gap is unchanged.

**SRI** — v1.12.0 remains the latest tag (2026-09-17, bare tag; the
newest GitHub Release object is still v1.11.1). No newer release
since session-606.

**sv2-apps activity** — #310 adapts apps to new extranonce APIs;
#247 (draft) adds tProxy fallbacks after upstream
`SetExtranoncePrefix` (directly relevant to Otedama's session-599
extranonce-chain handling); #326 adds JD mining-mode negotiation
integration tests; #304 migrates the pool to dashmap; #414 bumps
stratum-core. The open sv2-apps set stands at 17 PRs.


## Session-606 ecosystem update (2026-10-02)

**sv2-spec #234 (open)** — adds §4.8 "Key Management and Rotation",
the spec's first normative text on which key is which. It formally
splits two roles the old text conflated: the **Authority Key** (long-
lived trust anchor, reaches the client out-of-band, optionally embedded
in the mining URL — note the PR drops the "Pool" qualifier because
JDS/TDS/local proxies hold authority keys too) vs the **server static
Noise key** (short-lived, freely rotatable, authenticated by an
authority-signed CERTIFICATE). §4.8.3 states the validity window is
checked at handshake time and an established session need NOT be
terminated when `not_valid_after` passes — there is no mid-session
re-certification mechanism. Otedama conformance note (for when server
authentication lands): the current `noise.go` NX implementation is
the alpha P-256 stub and performs **no** certificate parsing —
`ReadMessage2` consumes only the ephemeral key and never reads the
encrypted static key + signature block (tracked in KNOWN_LIMITATIONS
§2 and session-597's deferral to the secp256k1 migration). When that
work happens it must (a) pin the authority key supplied via the
`stratum+v2://` URL, (b) verify the authority signature over the
static key + validity window **at handshake only**, matching §4.8.3,
and (c) treat static-key rotation as transparent to the session.

**sv2-apps (upstream SRI applications):**
- **#881 (open, WIP)** — implements `handle_push_solution` on
  `jd_server_sv2` + `bitcoin_core_sv2`: a Job Declarator Server that
  accepts miner-pushed block solutions. This is the piece ADR-009
  phase 2's JDC would submit through; worth tracking to completion.
- **#878 (merged)** — `stratum-apps` now rejects empty coinbase
  reward scripts. Upstream moving to fail-closed validation, matching
  Otedama's session-595 direction (reject malformed pool input rather
  than degrade to zero-filled work).
- **#875 (merged)** — all SRI crates merged into a single cargo
  workspace; repository layout for reference-implementation reading
  has changed (crate paths moved under `sv2-apps/`).
- **#883 (open)** — example configs now pay the mainnet coinbase
  reward to an SRI community multisig, making the upstream reference
  pool explicitly fee-transparent by default.

**SRI** remains at v1.12.0 (2026-09-17) — no new release since the
session-600 check.

## Session-887 ecosystem update (2026-10-02)

**sv2-spec** — open=7, normative set unchanged: #236 (`SetTarget`
max_target bound), #234 (authority key mgmt/rotation), #203 (coinbase
payouts extension), #198 (`coinbase_witness` in `NewTemplate`).
Editorial/WIP remainder {232, 186, 103}. No new normative activity.

**sv2-apps** — open=27. Since the session-872 check only two merges:
#900 (stratum-core bump) and #907 (docs). The #875 single-workspace
consolidation noted at s872 is the last structural change; #881
(JDS push-solution) remains open.

**SRI** — v1.12.0 (2026-09-17) still latest.

Quiet window continues — no action required.
