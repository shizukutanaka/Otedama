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
4. **Solo mining via decentralized templates is now production-viable.** Blitzpool runs Stratum V2 for solo miners; DMND was built on V2 from the ground up; Braiins Pool is 100% V2-capable; the SRI community pool continues testing.

**Otedama's positioning today (v3.0.0-alpha.1):** Hard-coded as a Stratum V2 client only (ADR-002), but treats the pool as the authoritative source of block templates. The miner has no transaction-selection capability. This is a **strategic inconsistency**: ADR-002's commitment to V2-only was motivated by miner sovereignty, yet the engine doesn't actually exercise that sovereignty.

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

The implementation reuses `internal/stratum/noise*.go` for the Noise NX handshake (already production-ready in Otedama since v3.0.0-alpha.1).

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

## References

- Stratum V2 Working Group expansion (May 7, 2026):
  https://news.bitcoin.com/bitcoin-mining-pool-giants-foundry-antpool-and-f2pool-signal-stratum-v2-shift/
- Stratum V2 spec (Job Declaration Protocol):
  https://stratumprotocol.org/specification/06-job-declaration-protocol/
- Stratum V2 spec (Mining Protocol):
  https://stratumprotocol.org/specification/05-mining-protocol/
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
