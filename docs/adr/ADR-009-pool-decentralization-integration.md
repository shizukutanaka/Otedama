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

## Session-1246 ecosystem update (2026-10-02)

**sv2-spec** — normative tracked set unchanged: #236 (SetTarget ≤
channel max_target — active, updated today), #234 (authority-key
management §4.8), #203 (coinbase payout extension), #198
(coinbase_witness in NewTemplate). Housekeeping PRs (#232, #186)
remain cosmetic. No client-visible wire change.

**SRI** — v1.12.0 (2026-09-17) remains the latest release; the
upstream repo is `stratum-mining/stratum` (merged workspace).

**sv2-apps** — open set 27 PRs. Relevant drift:
- **#599 (PoC)** — replaces the pool's mempool mirror with Bitcoin
  Core's `TxCollection`; upstream exploring tighter Core coupling
  for template construction (server-side only).
- **#600** — integration tests across multiple Bitcoin Core
  versions; raises the bar for upstream template-compat testing.
- **#718** — `fix(pool): back off when accept() fails on descriptor
  exhaustion` — a server accept-loop hardening item; Otedama is a
  client and doesn't accept connections, but the same shape applies
  if a future local proxy lands.
- **#453** — BIP-54 coinbase-compliance integration test upstream.
- **#367** — adds `network` to `GlobalInfo` (sv2-ui API surface).
- **#212** — mimalloc adoption (build-infra).

## Session 1238 ecosystem update (2026-10-02)

- **sv2-spec** — open PR set unchanged at 7: #236 (SetTarget max_target
  MUST NOT exceed), #234 (authority key management), #232/#186 (table
  style), #203 (payouts ext), #198 (coinbase_witness), #103 (Proxy
  Annex WIP). No new normative items since session 1232.
- **sv2-apps v0.8.0** released (2026-09-17): a security-hardening
  release driven by the Loupe audit — tProxy SV1 session/channel
  lifecycle hardened (idempotent handshake, jobs only after
  subscribe+authorize, extranonce.subscribe honored, malformed
  notifications no longer panic, late-share validation), structured
  runtime lifecycles for every application, simpler containerized
  config. Open PR set at 27. Otedama's own V1 stack already mirrors
  the tProxy hardening direction (subscription ordering gates,
  extranonce atomics, notification validation from sessions 594–599).
- **SRI** remains at v1.12.0 (2026-09-17) — unchanged.


## Session-775 ecosystem update (2026-10-03)

**sv2-spec:**
- **#236 (open, active)** — `SetTarget.target` MUST NOT exceed the
  channel's `max_target`: still open after the 2026-10-02 update;
  Otedama already clamps pool-set targets to the block-target bound
  (sessions 256/736), so conformance unaffected if it merges.
- Normative open set unchanged: #236, #234 (authority key mgmt),
  #203 (coinbase payout extension), #198 (coinbase_witness) —
  quiet window continues; no new protocol requirement since #231.

**SRI:** remains at v1.12.0 (2026-09-17) — no new release.

**sv2-apps:** open set holds at 27. Since the session-761 check:
- **#907 (merged)** — docs-only agents-file guidance; no protocol
  impact.
- **#908 (open)** — B08 type support in `bitcoin_core_sv2`: block-
  template version coverage for newer core releases; worth tracking
  for V2 job-source compatibility.
- **#845 (open, updated)** — renames target message fields to match
  the spec cleanup Otedama already adopted (session 704).
- **#856 (open, updated)** — `bitcoin_core_sv2` hardening continues.
- Tracked #881/#839/#903/#904/#902/#878/#883 remain open; no new
  merged protocol-affecting work beyond what session-761 recorded.

No conformance gap detected — Otedama's SV2 wire surface stays
current with the normative spec text.

## Session-793 ecosystem update (2026-10-04)

### sv2-spec
- Normative open set unchanged: #236 (`SetTarget.target` ≤ `max_target` bound), #234 (authority-key management), #203 (coinbase payouts extension), #198 (`coinbase_witness` field) — all still open, no new conformance-relevant text.
- Newly merged since last check: #231 (Server/Client relationship clarified across roles — documentation alignment only, no wire change for a downstream mining client), #233 (AGENTS.md conventions). New editorial PR #186 open (markdown table fix) — non-normative.
- Otedama impact: none — the Oct-1 normative batch (session-678/#703) already covered the landed semantic changes; Otedama's SetTarget handling predates #236's bound and remains conformant.

### stratum (SRI)
- Latest release remains v1.12.0 (2026-09-17) — no new tag since last check.

### sv2-apps
- Open PR count steady at 27. Recently merged: #875 (crates consolidated into a single cargo workspace), #865 (`bitcoin_core_sv2` bumped to 0.6.0), #907 (docs: agent-comment guidance). No protocol-surface change affecting Otedama's client role.

## Session-817 ecosystem update (2026-10-04)

**sv2-spec (upstream spec PRs):**
- Normative open set unchanged: **#236** (`SetTarget.target` MUST NOT
  exceed `max_target`; last touched 2026-10-02 — active discussion
  continues, still open), **#234** (authority key management/rotation),
  **#198** (`coinbase_witness` on `NewTemplate`), **#203** (coinbase
  transaction payouts extension).
- New open: **#232** (editorial — unwrap multi-line table cells);
  **#186** and **#103** (Proxy Annex WIP) unchanged.
- Otedama conformance: no new normative deltas — the `max_target`
  bound (session-443 direction, PR #538) remains ahead of the
  still-open #236 requirement.

**SRI** remains at **v1.12.0** (2026-09-17) — no release since
session-793.

**sv2-apps (upstream SRI applications):** open count steady at **27**.
Recently merged: **#907** (agents docs), **#900** (stratum-core bump),
**#875** (workspace consolidation — already recorded), **#857** (pool
payout-policy isolation for solo mining — landed; the tracked isolation
item), **#871** (version-bump check only on PRs). The session-793 open
tracking items (#881 JDP push-solution, #883 fee-transparent config)
stay on the watch list.

## Session-833 ecosystem update (2026-10-02)

sv2-spec: the normative open set is unchanged — #236 (SetTarget `target` must not exceed `max_target`; still active, updated Oct-2), #234 (authority key management), #198, #203. Since the last check the merged batch is #227 (spec-gap normative clarifications, Oct-1), #228 (field renames — tracked since our wire-field rename), #231 (Server/Client roles clarified, Oct-2), #233 (shared AGENTS.md, editorial). #232 remains an open editorial pass. No new constraint lands on the client side; #236 stays the one to watch.

SRI: still v1.12.0 (2026-09-17) — no new tag.

sv2-apps: open set holds at 27. Recent merges are operational hygiene — #907 (docs), #900 (stratum-core bump), #875 (single cargo workspace), #871/#868 (CI version-bump gate), #869 (JDP docs). No client-facing behavior change for us.

Takeaway: stable window continues — nothing actionable. Next recheck in ~2 weeks or on #236 movement.

## Session-1251 ecosystem update (2026-10-02)

sv2-spec: normative open set unchanged — #236 (`SetTarget.target` must
not exceed `max_target`; still open, active), #234 (authority key
management), #198, #203 (non-custodial coinbase payouts — still open).
Repo open-issue count steady at 27. No new normative delta lands on a
client-role implementation; #236 remains the one to watch (Otedama's
max_target bound already satisfies its direction).

SRI: still **v1.12.0** (2026-09-17) — no new tag.

sv2-apps: open PR count dropped **27 → 17**. The workspace
consolidation wave closed the stale tail — previously tracked items
#881 (JDP push-solution) and #883 (fee-transparent config) are no
longer in the open set. Remaining open work is hardening and
monitoring: #310 (adapt apps to new extranonce APIs), #304 (migrate
pool to dashmap), #414 (stratum-core bump), #367/#373/#368/#285/#338
(monitoring JSON-API surface), #326/#325 (JD negotiation + coinbase
round-trip tests), #247 (tProxy SetExtranoncePrefix fallback — draft).
No client-facing behavior change for Otedama; the extranonce-API
adaptation (#310) is the only one to keep on the watch list in case it
signals a protocol-surface rename.

Takeaway: stable window continues — nothing actionable. Next recheck
in ~2 weeks or on #236 movement.

## Session-856 ecosystem update (2026-10-02)

### sv2-spec
Open set unchanged: 7 PRs — normative {236 SetTarget `max_target` bound (active, updated 10-02), 234 authority key mgmt, 198 `coinbase_witness`, 203 payouts extension}, editorial/WIP {103 Proxy Annex, 186 table consolidation, 232 cell unwrap}. No new client-impacting merges since s833 (#231 already recorded).

### SRI
Still v1.12.0 (2026-09-17) — no new release.

### sv2-apps
open=27; one merge since s833: #907 (docs/agents hygiene). No client-relevant changes.

**Verdict**: quiet window continues; no action required. Next scheduled recheck ~s872.

## Session-872 ecosystem update (2026-10-03)

### sv2-spec

Open PR set unchanged at seven:

- **Normative**: #236 `SetTarget.target` MUST NOT exceed `max_target` (still
  active, updated 2026-10-02 — the wording iteration continues; our client
  clamps to `max_target` and needs no change regardless of how it lands),
  #234 authority key management documentation (2026-09-25), #203 coinbase
  transaction payouts extension (2026-09-15), #198 `coinbase_witness` field
  on `NewTemplate` (2026-09-23).
- **Editorial/WIP**: #232, #186, #103.

No new client-impacting merges since Session-856: #231 (role relationship
clarification, merged 2026-10-02) was already recorded.

### SRI

Still v1.12.0 (2026-09-17).

### sv2-apps

Open PR count steady at 27. Notable merge: **#875 "Merge all crates into a
single cargo workspace"** (2026-09-25) — the sv2-apps repo consolidated its
crate layout into one workspace, simplifying downstream builds but not
changing the protocol. #907 docs-hygiene landed too. No client-facing
impact for Otedama.

*Quiet window continues — verdict unchanged: track, don't chase.*

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

## Session-908 ecosystem update (2026-10-04)

### sv2-spec

Open set is **unchanged at 7** — identical to s887:

- **Normative-track** (4): #236 `SetTarget.target` MUST NOT exceed `max_target`; #234 authority key management + rotation; #203 coinbase payouts extension; #198 `coinbase_witness` in `NewTemplate`.
- **Editorial / WIP** (3): #232, #186, #103.
- Nothing newly merged or newly opened; the spec quiet window persists (~3 weeks).

### SRI (stratum-mining/stratum)

Latest release remains **v1.12.0** (2026-09-17). No v1.13.x yet.

### sv2-apps

- **Open = 27** — 4 new since s887, all infra/quality: #908 B08 type in `bitcoin_core_sv2`; #904 monitoring/config/release edge cases; #903 Buffer sv2 hardening; #902 Windows CI support. None changes the wire surface Otedama implements.
- **Recently merged**: #907 (AGENTS.md docs, 10-02), #900 (stratum-core bump, 09-26) — both hygiene.
- #881 JDS push-solution and #856 bitcoin-core-sv2 hardening still open — tracked.

**Disposition**: no change required in Otedama; continue tracking #236/#234 (normative) and #881 (JDS).

## Session-922 ecosystem update (2026-10-02)

**sv2-spec** — open=7, normative set unchanged from session-908:
`#236` (SetTarget must not exceed `max_target`; last touched 2026-10-02),
`#234` (authority key management/rotation), `#203` (coinbase payouts
extension), `#198` (`coinbase_witness` on `NewTemplate`), plus the two
editorial cell-unwrap PRs (`#232`, `#186`) and the WIP `#103` Proxy
Annex. The ~3-week quiet window continues: no new normative text has
landed that would change Otedama's wire layout since #228 (field
renames, tracked at session-622/PR-#704).

**SRI** — still v1.12.0 (2026-09-17); no new release.

**sv2-apps** — open=27, one merge since session-908 (`#907` docs
hygiene). Open set now includes several security-relevant items worth
tracking:

- **#839** — binds mining-job tokens to `user_identity` and enforces
  the binding on `SetCustomMiningJob`. This is upstream's fix for the
  job-token→identity gap Otedama already avoids by not issuing
  unbound tokens (single-tenant JDC).
- **#845** — renames target message fields to match the post-#228
  spec cleanup; mirrors the Otedama rename landed at PR #704.
- **#878** — `stratum-apps` rejects empty coinbase reward scripts;
  upstream converging on the fail-closed parser direction Otedama
  adopted at session-595.
- **#881** (open, WIP) — JDS `handle_push_solution` still open,
  updated 2026-10-02; remains the piece phase-2 JDC submits through.
- **#856** — `bitcoin_core_sv2` hardening, updated 2026-10-02.

No action items: the normative SV2 surface Otedama implements is
unchanged, and the two tracked upstream convergence items (#845 field
rename, #878 empty-script rejection) are already reflected in-tree.

## Session-936 ecosystem update (2026-10-02)

Re-checked after ~14 sessions.

**sv2-spec** open=7, unchanged from session-922: normative candidates
{#236 `SetTarget` max_target bound (still active, touched 10-02),
#234 authority key management, #203 coinbase payouts, #198
coinbase_witness}; editorial/WIP {#232 table unwrap, #186 cell
consolidation, #103 proxy annex}. No merges since session-922 — the
quiet normative window continues.

**SRI** remains at v1.12.0 (2026-09-17) — no new release.

**sv2-apps** open=27, unchanged in count. No merges since session-922's
scan (#907 docs was the most recent merged, 10-02). Open items of note
(tracked): #839 job-token→user_identity binding (touched 10-02), #845
field-rename mirroring sv2-spec #228 cleanup (our PR #704 already
followed), #878 empty coinbase reward script rejection, #881 WIP JDS
push-solution (touched 10-02), #856 `bitcoin_core_sv2` hardening; newer
untracked openings include #874 AGENTS.md docs, #902 Windows CI support,
#903 "Buffer sv2" hardening, #904 monitoring/config/release edge cases,
#908 B08 type support in `bitcoin_core_sv2`. The ecosystem continues
hardening and infra work; nothing requires an Otedama change.

## Session-1015 ecosystem update (2026-10-02)

**sv2-spec** — the normative open set is unchanged since
session-606: #236 (`SetTarget.target` must not exceed the channel's
`max_target` — refreshed 2026-10-02, still open; Otedama's bounded
share-target handling already clamps pool-supplied targets, so the
proposed rule matches shipped behavior), #234 (key management and
rotation), #203 (coinbase payouts extension), #198
(`coinbase_witness` in `NewTemplate`), plus dormant #103/#186/#232.
No merged spec changes this window; the quiet window continues.

**SRI** — v1.12.0 (2026-09-17) remains the latest release; no new
tag since the session-606 check.

**sv2-apps** — open set stands at 27 PRs. The five PRs tracked
across prior sessions are all still open: #881 (WIP
`handle_push_solution` for the JDS — the piece phase-2 JDC submits
through), #839 (binds mining job tokens to `user_identity`), #845
(target-message field renames tracking spec cleanup), #856
(`bitcoin_core_sv2` hardening), #883 (fee-transparent example
configs). New entries since session-606 are operational hardening:
#903 (sv2 buffer hardening), #904 (monitoring/config/release edge
cases), #908 (B08 type support), #902 (Windows CI).

## Session-1035 ecosystem update (2026-10-04)

**sv2-spec** — normative open set unchanged: **#236** (`SetTarget.target` must not exceed channel `max_target`), **#234** (authority key management + rotation, §4.8 — handshake-time cert validation, no mid-session re-cert), **#203** (coinbase transaction payouts extension), **#198** (`coinbase_witness` in `NewTemplate`). Dormant formatting/WIP items **#232/#186/#103** still open and non-normative. No new normative activity since session-1015 — Otedama's v2 planned-codec conformance items (#236 bound, #234 cert flow) remain the ones to watch.

**SRI** — latest release still **v1.12.0**.

**sv2-apps** — open set stable at **27**. Previously tracked items all still open: **#881** (JDS `handle_push_solution` WIP — the piece phase-2 JDC submits through), **#839** (JDS mining-job tokens bound to `user_identity`), **#845** (target-message field renames aligning with the spec cleanup), **#856** (`bitcoin_core_sv2` hardening), **#883** (example configs pay mainnet reward to SRI community multisig). New since the session-1015 check: **#908** (B08 type support in `bitcoin_core_sv2`), **#904** (monitoring/config/release edge cases), **#903** (buffer hardening), **#902** (Windows CI). The open set continues to skew toward hardening (buffer bounds, descriptor-exhaustion back-off #718, monitoring edge cases) rather than protocol shape changes — consistent with the spec's quiet window.

## Session-1060 ecosystem update (2026-10-02)

**sv2-spec** — the normative open set is unchanged: #236 (`SetTarget.target`
MUST NOT exceed `max_target`, still in wording refinement), #234
(authority-key management/rotation), #203 (coinbase transaction payouts
extension), #198 (`coinbase_witness` on `NewTemplate`). A clarification
batch landed since the last merged record: #223 (SetupConnection protocol-
version semantics), #225 (validation rules + flag semantics), #226
(`min_ntime` and share validation rules), #227 (spec-gap normative
clarifications), #231 (Server/Client relationship across roles). All are
clarifying text — no wire-format or message-set change, so Otedama's
conformance surface is untouched; #226's share-validation text remains
aligned with the repo's existing share-time checks.

**SRI** — v1.12.0 (2026-09-17) remains the latest tag; no new release.

**sv2-apps** — open set holds at 27. Landed since the last merged record:
#875 (single cargo workspace — reference-implementation crate paths moved
under `sv2-apps/`), #857 (pool payout policy isolation for solo mining),
#900 (stratum-core bump), plus versioning/CI hygiene (#865/#868/#871/#907).
Open tracked items: #881 (WIP `handle_push_solution` — still the JDC phase-2
dependency), #839 (JDS binds mining-job tokens to `user_identity`),
#845 (target-message field renames tracking spec cleanup), #856
(`bitcoin_core_sv2` hardening), #903 (buffer hardening), #878 (reject empty
coinbase reward scripts — fail-closed direction consistent with session-595),
#904 (monitoring/config/release edge cases), #908 (B08 type support),
#883 (community-multisig example payouts). Trajectory unchanged: hardening
and reference-implementation consolidation, no new protocol surface.

## Session-1130 ecosystem update (2026-10-02)

### sv2-spec

- Normative set unchanged. #203 (non-custodial payouts, push-based) still open; the SEQ0_255-vs-B0_64K payout-list bound debate continues (large pools already ~60 outputs). #202 (request/response alternative) still open. #234 key-management and #198 witness-commitment threads open per prior entries.

### stratum (SRI)

- **v1.12.0 released (2026-09)**: breaking bumps across the stack. `channels_sv2` hardening pass — share validation now enforces min_ntime/nTime bounds, job storage bounded on every axis (future templates, past jobs, group-job replacements, rejected/seen share sets), several consensus-invalid coinbase defects fixed, ExtranoncePrefix live-reference fix, arithmetic hardened against overflow/underflow/div-by-zero. BIP323 adaptations landed (`EllSwiftPubKey` alias in `binary_sv2`). `codec_sv2`/`framing_sv2` refactored (`Frame` split into `MessageFrame`/`SerializedFrame`, `SizeHint`). `noise_sv2` dropped AES-256-GCM — ChaCha20-Poly1305 is now the sole cipher, matching Otedama's cipher choice recorded in earlier ADR notes.

### sv2-apps

- **v0.7.0 released**: share accounting tracks rejects via `channels_sv2::server::share_accounting` (u64), JDC supports per-upstream `user_identity`, standardized Stratum error-code constants adopted, Sv2TP TCP connect timeout added, `stratum-apps::rpc` deprecated. #881 still WIP per prior tracking.

No Otedama action required — wire-layer and cipher posture already aligned with the v1.12.0 direction.

## Session-1144 ecosystem update (2026-10-02)

### sv2-spec

- #203 (non-custodial payouts extension) still open; active discussion on
  SEQ0_255 payout-set scalability for large pools. #202 and draft #195 remain
  the competing designs. Normative set unchanged — no new landed spec text
  affecting Otedama's wire layer.

### SRI

- Still v1.12.0 (2026-09-17); no v1.13. The ChaCha20-Poly1305-only cipher
  posture continues to match Otedama's Noise implementation.

### sv2-apps

- #582 (PoolRuntime typestate refactor of the pool start loop) open.
- #585 (all config options as env vars) and #576 (binary_sv2 cleanup) merged —
  config-surface and codec hygiene aligning with Otedama's own
  env-over-file precedence.

No Otedama action required.

## Session-1158 ecosystem update (2026-10-02)

**sv2-spec:** Normative open set unchanged — #203 (non-custodial payouts
extension, push-based) and #202 (request-response alternative) remain
open with #195 as draft; the payout-set scalability debate (SEQ0_255 vs
SEQ0_64K given pools already at ~60 coinbase outputs) is still active.
No new normative text for Otedama.

**SRI:** v1.12.0 remains current (no v1.13). ChaCha20-Poly1305 remains
the sole Noise cipher — matching Otedama's noise suite.

**sv2-apps:** v0.7.0 released (runtime-architecture modernization):
`stratum-apps` gained a `SharedSet` synchronization wrapper,
`bitcoin_core_sv2` now supports Bitcoin Core IPC v30.x and v31.x behind
versioned backends, `REQUIRES_STANDARD_JOBS` semantics updated, and the
`stratum-apps::rpc` module was deprecated. Otedama does not consume the
apps stack; the reference still validates the pool-side protocol shape
tracked in this ADR.

## Session-1172 ecosystem update (2026-10-02)

**sv2-spec** — quiet window continues: the normative open set is
unchanged (#203 non-custodial-payouts extension still open with the
SEQ0_255-vs-B0_64K payout-set scalability debate active — small pools
already sit at ~60 coinbase outputs; #202 remains the alternative
draft and #195 the original draft). Nothing new affects Otedama's
implemented surface.

**SRI** — still v1.12.0 (2026-09-17): ChaCha20-Poly1305 remains the
sole Noise cipher, matching Otedama's `internal/stratum/noise*`.

**sv2-apps** — still v0.7.0; the repo remains alpha with the JDP/JDS
stack under active development (178 open issues). No release-impacting
change for Otedama's tracking items (#881 JDP hardening, #839/#845
TDP work, #856 codecs, #883 fee-transparent example configs).

## Session-1186 ecosystem update (2026-10-02)

### sv2-spec (github.com/stratum-mining/sv2-spec)

The non-custodial-payout extension conversation is unchanged since
session-1172: #203 (push-based, plebhash) remains open with the
SEQ0_255 vs B0_64K payout-set scalability question still debated in
thread; #202 (RequestPayoutOutputs, GitGab19) remains the open
request-response alternative and has accumulated an epoch-freshness /
exact-sum rounding review thread; #195 (Dynamic Coinbase Outputs,
warioish) remains the original draft. All three encode the same
strategic direction ADR-009 already records; none has merged, so the
normative message set Otedama's dialer implements is unchanged.

### Stratum Reference Implementation (stratum-mining/stratum)

Latest release is still v1.12.0 (2026-09-17): the hardening wave over
`channels_sv2` (bounded job storage on every axis, `min_ntime`/nTime
share-validation bounds, consensus-invalid coinbase fixes), BIP323
adaptations, the `codec_sv2`/`framing_sv2` `MessageFrame`/`SerializedFrame`
split, and the `noise_sv2` AES-256-GCM removal leaving
ChaCha20-Poly1305 as the sole cipher — matching Otedama's
`noise_primitives.go` cipher set. No v1.13.

### sv2-apps (stratum-mining/sv2-apps)

Latest release is still v0.7.0 (alpha). The repo's open-issue count
remains in the high-170s; the tracked items from earlier updates
(#881/#839/#845/#856/#883) continue as the open set of record. No
release-level change affecting this ADR's client-side scope.

### Assessment

Quiet window confirmed — no action. ADR-009's proposal sections stand
as written; the next recheck is due around session 1200.

## Session-1201 ecosystem update (2026-10-02)

Quiet window confirmed again — no movement since the s1186 recheck. sv2-spec: #203 (plebhash's push-based non-custodial payout extension) remains open with the SEQ0_255 vs B0_64K bound debate unresolved; #202 (GitGab19's request-response variant) still open, #195 still draft; discussion #192 stays active. The normative open set (#203/#202/#198) is unchanged. SRI low-level crates remain at v1.12.0 (2026-09-17: share-validation hardening, BIP323, codec refactor, AES-256-GCM dropped — ChaCha20-Poly1305 sole cipher, matching Otedama). sv2-apps latest remains v0.7.0 (alpha). No action required.

## Session-1307 ecosystem update (2026-10-02)

### sv2-spec

Normative open set unchanged: #203 (coinbase transaction payouts,
plebhash — push-based extension), #236 (`SetTarget.target` MUST NOT
exceed the channel's `max_target` — client-side bound Otedama already
records in the session-1269 audit), #234 (authority key management and
rotation), #198 (`coinbase_witness` field in `NewTemplate`) all remain
open; none merged since the last recheck. The message set Otedama's
dialer implements is unchanged.

### Stratum Reference Implementation (stratum-mining/stratum)

Latest release confirmed via tags+releases API: v1.12.0 (2026-09-17) —
the hardening wave already recorded (bounded job storage, min_ntime/nTime
bounds, codec_sv2/framing_sv2 split, AES-256-GCM removal leaving
ChaCha20-Poly1305 as the sole cipher, matching Otedama's noise set). No
v1.13.

### sv2-apps (stratum-mining/sv2-apps)

27 open PRs (was ~25 in session-1262's update). Recent activity is the
same hardening wave plus infra: #908 (B08 type in bitcoin_core_sv2),
#904 (monitoring/config/release edge cases), #903 (buffer hardening),
#902 (Windows CI). The tracked set — #881 (WIP jds handle_push_solution),
#883 (community-multisig coinbase config), #856 (bitcoin_core_sv2
hardening), #845 (target-field rename matching spec cleanup), #839 (jds
user_identity token binding) — all still open. Latest release remains
v0.7.0-era alpha; no release-level change in client-side scope.

### Assessment

Quiet window confirmed — no action. ADR-009's proposal sections stand;
next recheck due around session 1317.

## Session-1297 ecosystem update (2026-10-04)

sv2-spec normative open set unchanged — #203 (coinbase transaction payouts extension, last updated 2026-09-15), #236 (SetTarget.target MUST NOT exceed max_target — still active, updated 2026-10-02), #234 (authority key management docs, 2026-09-25), #198 (coinbase_witness field, 2026-09-23) all remain open and unmerged; no new normative candidate merged since the s1287 recheck. SRI latest release re-confirmed as v1.12.0 (2026-09-17) — the earlier "v1.12.0 stale" note in the ledger was wrong; v1.12.0 stands as the current release with the hardening wave intact. sv2-apps latest = v0.8.0 (2026-09-17); open-PR count 27 with the hardening wave continuing (#903 buffer hardening, #856 bitcoin_core_sv2 hardening, #878 empty-coinbase-script rejection, #845 spec-field rename alignment, #881 JDS push-solution WIP). No action required — quiet window continues.

## Session-1287 ecosystem update (2026-10-02)

sv2-spec: the normative open set is unchanged (#203/#202/#198, plus #236 SetTarget bound and #234 key management tracked alongside). #202 has a new substantive review thread: reviewer concern that a `RequestPayoutOutputs.Success` can be stale at declaration time — validating side would need epoch-awareness plus a "stale → re-request" signal so a JDC that caches payout sets doesn't silently build superseded coinbases against sliding-window/reset pools. Otedama's DATUM/non-custodial tracking should note this freshness requirement as an open design issue for the eventual client role. SRI low-level crates: latest release confirmed v1.12.0 (2026-09-17) — the earlier ledger re-anchor to v1.11.1 (session 1268) was a verification miss; v1.12.0 is real and current. sv2-apps latest remains v0.7.0 (alpha). No action required.

## Session-1274 ecosystem update (2026-10-02)

- sv2-spec normative open set reshaped: **#202 (non-custodial payouts) and #195 (Dynamic Coinbase Outputs 0x0003) were both CLOSED unmerged** (28–29 Jul 2026) — the payout-extension work consolidated into **#203 (coinbase transaction payouts extension, still open)**. Blitzpool continues to run extension 0x0003 in production per the #202 discussion.
- Still open and relevant to Otedama: **#236** (`SetTarget.target` MUST NOT exceed `max_target` — our s1269 audit recorded that we deliberately declare no `max_target`), **#234** (authority key management/rotation), **#198** (`coinbase_witness` in NewTemplate), #186 (markdown table fix), #103 draft (Proxy Annex).
- SRI release line: latest is **v1.11.1** (22 Jul 2026) — confirms the session-1268 re-anchor; earlier ledger mentions of a "v1.12.0" were unverifiable and are stale. v1.11.1's SV1-difficulty-conversion fix ("no longer rounds up") matches our `DifficultyFromTarget` truncation semantics — no action.
- sv2-apps: 27 open; hardening wave continues — new since last recheck: #908 (B08 in `bitcoin_core_sv2`), #904 (monitoring/config/release edge cases), #902 (Windows CI). Tracked items #881 (handle_push_solution + bitcoind), #883 (community multisig payout), #839 (JDS job-token identity binding) still open.
- Japanese-source scan (Qiita/Zenn, SV2 + non-custodial mining): no new Otedama-relevant material.
- Net: no protocol change required; payout-extension consolidation narrows the design surface we track to #203.

## Session-1268 ecosystem update (2026-10-02)

### sv2-spec (github.com/stratum-mining/sv2-spec)

The non-custodial-payout thread gained a deployment signal: on
#202 (GitGab19's request-response extension), warioishere reports
blitzpool is already running the extension's current spec and could
be tested against a jd-client built for extension `0x0003` — the
first concrete pool-side deployment of the non-custodial payout
proposal family. #202 also gained normative clarifications: each
`RequestPayoutOutputs.Success` is single-use (JDC MUST re-request
per declared job; validating party rejects stale sets with
`stale-payout-outputs`) and residual/rounding MUST be folded into
`coinbase_tx_outputs` so the set sums exactly to
`available_payout_value`. #203 (plebhash's push-based variant) and
#195 (the original Dynamic Coinbase Outputs draft) remain open; the
three-way design space is unchanged.

#236 (`SetTarget.target` MUST NOT exceed the channel's `max_target`,
opened 2026-10-02 by plebhash) is the newest normative-candidate:
it closes the gap where a server-initiated `SetTarget` could undo
the `UpdateChannel`/`max_target` bounds of 5.3.3–5.3.7, including
the cross-message race (a `SetTarget` sent before the server
accepts an `UpdateChannel` is bound by the superseded `max_target`).
Directly relevant to Otedama's target-tracking path; worth
re-auditing the engine's share-target handling if it lands. #234
(authority key management/rotation doc) remains open with active
review. Style/WIP items (#232, #186, #103) unchanged.

### Stratum Reference Implementation (stratum-mining/stratum)

Latest listed release is v1.11.1 (2026-07-22): `stratum_translation`
no longer rounds up SV1 difficulty values during conversion (#2227),
plus a `stratum-core` patch bump. Earlier ledger entries citing a
"v1.12.0" release could not be verified against the current
releases page — treating them as stale and re-anchoring to v1.11.1.

### sv2-apps (stratum-mining/sv2-apps)

~25 open PRs; the hardening wave continues — #903 (buffer sv2
hardening), #856 (`bitcoin_core_sv2` hardening), #839 (bind mining
job tokens to `user_identity`), #904 (monitoring/config/release
edge cases), #902 (Windows CI), #908 (B08 type in
`bitcoin_core_sv2`). #881 (JDP `handle_push_solution`) remains WIP;
#845 (target field renames tracking spec cleanup) and #883
(multisig config examples) still tracked.

### Assessment

The normative message set Otedama's dialer implements is still
unchanged, but the extension space is moving: blitzpool's live
`0x0003` deployment makes #202's request-response flow the most
concrete non-custodial-payout proposal to date, and #236's
`SetTarget` bound is a candidate that would tighten the server
contract Otedama already assumes. No code action this round;
re-audit the share-target path if #236 merges.

## Session-1262 ecosystem update (2026-10-02)

### sv2-spec (github.com/stratum-mining/sv2-spec)

Normative open set unchanged: #203 (push-based non-custodial payouts,
plebhash) remains open — the SEQ0_255-vs-B0_64K payout-set scalability
question is still debated in-thread; #202 (RequestPayoutOutputs,
GitGab19) remains the request-response alternative with the
epoch-freshness / exact-sum rounding review thread; #195 remains the
original draft. #236 (SetTarget.target bounded by the channel's
max_target), #234 (authority-key management doc), and #198
(coinbase_witness on NewTemplate) all remain open. #232/#186 are
table-formatting style PRs; #103 is the long-running Proxy Annex WIP.
Nothing new affects Otedama's implemented message surface.

### Stratum Reference Implementation (stratum-mining/stratum)

Latest tag is still v1.12.0 (2026-09-17, e11881b): channels_sv2
hardening, BIP323 adaptations, codec/framing split, and the
noise_sv2 AES-256-GCM removal leaving ChaCha20-Poly1305 as the sole
cipher — matching Otedama's `internal/stratum` cipher set. No v1.13.

### sv2-apps (stratum-mining/sv2-apps)

Latest release remains v0.7.0 (alpha). The open-PR list stands at ~25;
items tracked since the last update (#845 target-field rename, #856
bitcoin_core_sv2 hardening, #839 JDS user_identity binding, #881
handle_push_solution WIP, #878 empty-coinbase-script rejection, #883
community-multisig config examples) continue unchanged. New entries in
the window: #908 (B08 type support in bitcoin_core_sv2, Oct 3), #904
(monitoring/config/release edge cases, Oct 1), #903 (Buffer sv2
hardening, Sep 29), #902 (Windows CI support, Sep 28). No
release-level change affecting this ADR's client-side scope.

### Assessment

Quiet window confirmed — no action. ADR-009's proposal sections stand
as written; the next recheck is due around session 1275.

## Session-1255 ecosystem update (2026-10-02)

### sv2-spec (stratum-mining/sv2-spec)

The normative open set is unchanged — every tracked item remains open:

- **#236** (`SetTarget.target` MUST NOT exceed the channel's `max_target`) is the most active item: force-pushes and GitGab19 review on 2026-10-02. The proposed text now covers the group-channel bound, the UpdateChannel/SetTarget crossing race (a SetTarget sent before the UpdateChannel is accepted is held to the replaced max_target, with 5.3.7 forcing a corrected one), and a client-side grace period before treating an above-max target as a violation. If it lands, Otedama's dialer-side invariant is the existing pool-share-target clamp — the rule would make the bound mutual instead of client-advisory.
- **#234** (authority key management and rotation) is converging: TheBlueMatt reviewed "lgtm, some tiny nits", bit-aloo review in flight, and it's referenced by the new doc PR #124. Clarification-only — adds §4.8, renames "Pool Authority Key" to "Authority Key" (non-pool entities can hold authority keys), and records that cert validity is checked at handshake time (an established session need not terminate at `not_valid_after`). No wire or crypto change.
- **#198** (`coinbase_witness` in `NewTemplate`) still open — BIP141 future-proofing for TDP.
- **Non-custodial payouts:** #202 (GitGab19's request-response variant) open with plebhash's review probing staleness semantics (a `RequestPayoutOutputs.Success` going stale against sliding-window PPLNS needs a reject-vs-re-request signal) and exact-sum rounding; #203 (push-based variant) open; #195 draft; discussion #192 active. The wire set Otedama's dialer implements is unchanged.

### Stratum Reference Implementation (stratum-mining/stratum)

No new low-level crate release: the workspace tag remains the 2026-09-17 line recorded as v1.12.0 (`stratum-apps` 0.8.0 on crates.io, same date). The GitHub Releases listing still tops out at v1.11.1 (Jul 22). No action.

### sv2-apps (stratum-mining/sv2-apps)

Open PR count holds at 17 (unchanged since the s1251 recheck). Latest GitHub release remains v0.7.0. Watch items: #310 (adapt apps to new extranonce APIs — the sole protocol-surface item), #325 (multiple-coinbase-outputs round-trip test — test coverage for the non-custodial payout direction), #326 (JD mining-mode negotiation integration test). The rest are monitoring/metrics/deps maintenance.

### Japanese / English media scan

Nothing new at the implementation layer: the Gomining/DMND first production JDP block and the Foundry/Antpool/F2Pool SV2 working-group commitment were already recorded; no new Qiita/Zenn posts touching Otedama's stratum surface.

### Assessment

Quiet window continues — no action. One observation for the record: `05-Mining-Protocol.md` on `main` now writes `maximum_target`/`min_ntime` while the stratumprotocol.org build still shows `max_target`/`ntime_start` — the spec's field naming is mid-evolution again (Otedama decodes positionally, so wire-immune; relevant only to doc drift). Next recheck due around session 1270.
