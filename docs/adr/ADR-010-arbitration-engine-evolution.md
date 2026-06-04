# ADR-010: Arbitration engine evolution

**Status:** Proposed
**Date:** 2026-05-12 (formalized from prior research)
**Target releases:** v3.5 (mid-2027) through v3.7 (Q1 2028)
**Related ADRs:** ADR-001 (non-custodial), ADR-007 (Lightning), ADR-008 (hardware/power), ADR-009 (pool decentralization)

> **Note on numbering.** This ADR was originally proposed as "ADR-006" in earlier research drafts. ADR-006 was already accepted in April 2026 for "Protocol abstraction." To avoid number collision, this work is renumbered ADR-010.

---

## Context

`internal/arbitration/` in Otedama v3.0.0-alpha.1 is a **pure stateless comparator**: pull two quotes (mining yield, AI inference yield), pick the larger with 5% hysteresis. ~150 LOC. Intentionally simple — the first version.

By 2028, this engine should make **per-device, predictive, switching-cost-aware, Bayesian-calibrated, adversarially-robust** decisions while remaining a single binary with no external ML framework. The math is mostly standard; the value is integrating it cleanly.

**Why now (not "in 10 years"):**

- ADR-008 (hardware/power) emits per-device J/TH curves and electricity-cost-adjusted yield. The engine needs to consume these.
- ADR-009 (pool decentralization) emits `fee_capture_ratio`. The engine needs to factor this into yield estimates.
- The 2028 halving compresses margin; smarter routing is differentiation.
- Forecasting research (Wiley 2025; arXiv TimeXer; ACM 2026 multimodal) shows BTC direction-accuracy ceiling around 50–54%. Translation: **don't overbuild** — Holt-Winters captures most achievable value.
- Online learning literature is mature (Beta-Bernoulli + Thompson sampling, Lykouris-Mirrokni adversarial robustness, change-point detection). The right tools exist.

---

## Decision

We will evolve the arbitration engine across v3.5–v3.7 with **nine sub-features (A1–A9)**, each scoped to a specific failure mode of the current comparator.

### Feature A1 — Holt-Winters yield forecaster (v3.5, ~40h)

**Problem:** Current engine sees only "right now." Hashprice has 24h cyclic patterns (Asian/US trading hours), weekly cycles, post-block-finding variance, ~2-week difficulty-adjustment steps. AI inference demand on Akash has its own diurnal cycles.

**Mechanism:** 24h × 14d rolling buffer per provider. Double-exponential smoothing (Holt-Winters additive). Emits `predicted_yield(t+Δ)` for Δ ∈ {15min, 1h, 4h}.

```go
// internal/arbitration/forecast/holtwinters.go
type Forecaster struct {
    buffer    []Observation         // 14*24*60/5 = 4032 entries at 5-min resolution
    alpha     float64               // level smoothing (default 0.3)
    beta      float64               // trend smoothing (default 0.05)
    gamma     float64               // seasonal smoothing (default 0.1)
    period    int                   // 288 = 24h at 5-min resolution
}

func (f *Forecaster) Predict(horizon time.Duration) (yield float64, sigma float64)
```

**Why not LSTM/transformer:** Literature shows direction-accuracy ceiling around 50–54%. Holt-Winters captures ~95% of achievable value at ~5% of complexity.

**Cost:** ~40h. ~120 LOC of pure Go.

**Value/cost rank:** ★★★★★.

**Non-custodial check:** ✅ Pure local computation on user's own observations.

### Feature A2 — Switching-cost ledger (v3.5, ~30h)

**Problem:** Current 5% hysteresis is a crude proxy for switching cost. Real switches have costs: ASIC reboot (~30s wasted), AI inference session abandonment (lost partial payment), pool reconnection (TCP+handshake), orphan share penalties.

**Mechanism:** Per-provider-pair `switching_cost_sats` calibrated from observed downtime + orphan-share rate. Stored in `internal/arbitration/switchcost.bbolt`.

```go
type SwitchCostLedger struct {
    db *bbolt.DB
}

// Cost returns the calibrated cost (in sats) of switching from provider a to b.
func (l *SwitchCostLedger) Cost(a, b ProviderID) (sats int64, ageOfData time.Duration)

// Observe records a switching event for calibration.
func (l *SwitchCostLedger) Observe(a, b ProviderID, downtimeMs int64, orphanShares int)
```

Decision rule replaces 5% hysteresis with: `switch iff (predicted_yield_b - predicted_yield_a) * horizon > cost(a, b)`.

**Formal framing:** Markov Decision Process with switching cost, equivalent to the energy-arbitrage formulation in arXiv 2601.12081.

**Cost:** ~30h.

**Value/cost rank:** ★★★★★.

**Non-custodial check:** ✅ Local ledger.

### Feature A3 — Per-device suitability scoring (v3.6, ~60h)

**Problem:** Current engine routes ALL devices to the winner. Better: ASIC #1 (high mining-only efficiency) → mining; GPU #1 (versatile) → whichever pays more right now.

**Mechanism:** `Device.Suitability map[ProviderType]float64` field, modeled on Slurm GRES (Generic Resource Scheduling). Loadable from `~/.otedama/devices.toml`.

```toml
# ~/.otedama/devices.toml
[[device]]
id = "antminer-s21-01"
type = "asic"
suitability = { mining = 1.0, inference = 0.0 }   # ASICs can't do inference

[[device]]
id = "rtx4090-01"
type = "gpu"
suitability = { mining = 0.3, inference = 1.0 }   # GPUs better at inference
affinity = "inference"                            # user preference hint
```

Decision becomes a bipartite assignment problem (Hungarian algorithm in `internal/arbitration/match/`, or greedy since |devices| × |providers| is tiny in practice).

**Theoretical grounding:** When A3 is combined with the power-budget
cap from ADR-008 (total watts ≤ available/affordable power), the
problem becomes sequential resource allocation under a side constraint
that is replenished over time (the electricity the user is willing to
buy per interval). This is exactly the model analysed by Burnetas et
al., "Optimal Data Driven Resource Allocation under Multi-Armed Bandit
Observations" (arXiv:1811.12852), which derives asymptotically optimal
policies for MABs whose activations consume a constant-rate-replenished
budget, and by Zuo & Joe-Wong, "Combinatorial Multi-armed Bandits for
Resource Allocation" (arXiv:2105.04373), which proves logarithmic
regret for allocating a discrete or continuous budget across arms. We
do not need their full machinery at Otedama's scale (a handful of
devices), but these results confirm the greedy/Hungarian assignment is
a principled approximation, and they define the regret-optimal target
if the device count ever grows large enough to warrant it.

**Cost:** ~60h.

**Value/cost rank:** ★★★★.

**Non-custodial check:** ✅ User's devices.

### Feature A4 — Strategic Akash bidding (v3.6, ~20h)

**Problem:** Akash inference market is a reverse first-price sealed-bid auction. Otedama (as a provider) currently submits naive bids. Equilibrium bid in symmetric IPV reverse FPA = expected second-lowest cost.

**Mechanism:** `bid = max(electricity_cost, opportunity_cost_mining) × (1 + margin)`. The work is bid-formulation logic, not auction theory.

**Cost:** ~20h.

**Value/cost rank:** ★★★.

**Non-custodial check:** ✅ User's bid strategy on user's hardware.

### Feature A5 — Sharpe-weighted preference (v3.6, ~15h)

**Problem:** A 100%-certain $5/day vs 60%-probability $10/day — which should the engine choose?

**Mechanism:** Modified Sharpe ratio for compute streams: `(expected_yield − electricity_floor) / std(realized_yield)`. CLI flag `--income-mode={smooth, max, balanced}`. `balanced` default = `0.5 × mean + 0.5 × Sharpe`.

**Why not Kelly:** Full-Kelly assumes log-utility and no estimation error; half-Kelly or fractional-Kelly is standard practice (Chan 2006). Sharpe is the right framing for the smoothing-vs-maximizing tradeoff.

**Cost:** ~15h.

**Value/cost rank:** ★★★★.

**Non-custodial check:** ✅ Pure preference flag.

### Feature A6 — Bayesian Beta-Bernoulli calibration (v3.5, ~30h)

**Problem:** Engine needs ground truth. After routing Device X to provider Y, observe actual realized yield and update internal estimate of Y's reliability.

**Mechanism:** Beta-Bernoulli conjugate update (Thompson sampling). After each settled epoch, update `Beta(α_p, β_p)` for each provider's "paid out as promised" event. Use posterior mean to discount forecasts.

```go
type ProviderReliability struct {
    Alpha float64    // successes + 1 (smoothed prior)
    Beta  float64    // failures + 1
}

func (r *ProviderReliability) Update(success bool) {
    if success {
        r.Alpha += 1
    } else {
        r.Beta += 1
    }
}

func (r *ProviderReliability) PosteriorMean() float64 {
    return r.Alpha / (r.Alpha + r.Beta)
}
```

**Cost:** ~30h. ~50 LOC.

**Value/cost rank:** ★★★★★. Mutually reinforcing with A1 — shares rolling buffer.

**Non-custodial check:** ✅ Local statistics.

### Feature A7 — Adversarial-corruption hardening (v3.6, ~45h)

**Problem:** What if a malicious Akash provider offers fake high quotes to lure hashrate, then defaults? What about a pool that briefly inflates share-acceptance rate during a probe period?

**Mechanism:** Direct port of Lykouris-Mirrokni-Paes Leme STOC 2018 ("Stochastic Bandits Robust to Adversarial Corruptions"):

1. Cap trust gained per epoch: `Δα ≤ 1.0`.
2. Require k=3 independent confirmations above current best before fast-tracking.
3. Reputation half-life of 168h (one week) — demonstration attacks decay automatically.

**Cost:** ~45h. Requires A6 to be live first.

**Value/cost rank:** ★★★.

**Non-custodial check:** ✅ Defense logic, no third-party interaction.

### Feature A8 — Change-point detection (v3.6, ~25h)

**Problem:** Difficulty adjustments (every ~2 weeks) cause regime shifts; Akash auction-floor changes do the same. Standard forecasters fail across these cliffs.

**Mechanism:** CTS-lite (Mellor & Shapiro 2013): trigger forecaster reset when 5-epoch moving average shifts > 2σ.

**Cost:** ~25h. Necessary glue between A1 and A2.

**Value/cost rank:** ★★★.

**Non-custodial check:** ✅ Local statistics.

### Feature A9 — Live calibration dashboard (v3.5, ~25h)

**Problem:** The new engine is more opaque than the simple comparator. Users need to be able to debug "why did Otedama choose X right now?"

**Mechanism:** `otedama arb explain` subcommand. Prints:

```
=== Otedama arbitration decision (2027-08-14 14:32:11) ===
Tariff: octopus-agile-c, 22.4 p/kWh
Devices: 2 ASIC, 1 GPU

Device              Selected provider    Predicted yield (4h)   Posterior reliability   Switch cost
─────────────────────────────────────────────────────────────────────────────────────────────────────
antminer-s21-01     mining (braiins)     0.000523 BTC ± 0.000031   97.2% (α=89, β=2.6)    n/a (stay)
antminer-s21-02     mining (braiins)     0.000523 BTC ± 0.000031   97.2% (α=89, β=2.6)    n/a (stay)
rtx4090-01          inference (akash)    $1.23/hr ± $0.18         91.5% (α=41, β=3.8)    switch from mining: 1200 sats

Reasoning: Inference yield 28% above mining-adjusted ($1.23 vs $0.96); confidence interval excludes
overlap. Switch cost amortizes over 4h horizon (~$0.07 vs $0.27 advantage).
```

**Cost:** ~25h.

**Value/cost rank:** ★★★★. Required for users to trust the now-opaque engine.

**Non-custodial check:** ✅ Local report.

---

## Architectural sketch

```
internal/arbitration/
├── engine.go               # entry point; orchestrates the below
├── forecast/               # A1, A8
│   ├── holtwinters.go
│   ├── changepoint.go
│   └── buffer.go           # shared rolling state
├── switchcost/             # A2
│   ├── ledger.go
│   └── bbolt.go
├── device/                 # A3
│   ├── suitability.go
│   └── match.go            # bipartite assignment
├── bid/                    # A4
│   └── akash_fpa.go
├── preference/             # A5
│   └── sharpe.go
├── calibration/            # A6
│   └── betabernoulli.go
├── robust/                 # A7
│   └── epoch.go            # Lykouris-Mirrokni-style buckets
└── explain/                # A9
    └── print.go
```

---

## Cost summary

| Feature | Hours | Release | Value/Cost |
|---------|-------|---------|------------|
| A1 Holt-Winters forecaster | 40 | v3.5 | ★★★★★ |
| A2 Switching-cost ledger | 30 | v3.5 | ★★★★★ |
| A3 Per-device suitability | 60 | v3.6 | ★★★★ |
| A4 Strategic Akash bidding | 20 | v3.6 | ★★★ |
| A5 Sharpe preference | 15 | v3.6 | ★★★★ |
| A6 Beta-Bernoulli calibration | 30 | v3.5 | ★★★★★ |
| A7 Adversarial hardening | 45 | v3.6 | ★★★ |
| A8 Change-point detection | 25 | v3.6 | ★★★ |
| A9 Explain dashboard | 25 | v3.5 | ★★★★ |
| **Total** | **290** | v3.5–v3.6 | — |

290 hours = 29 weeks at 10h/week. Comfortable.

---

## Mutually-reinforcing clusters

- **{A1, A6, A8}** share the rolling-buffer infrastructure → build once, reuse three times.
- **{A2, A3}** share the per-device data model → build A3 first, A2 hangs off it.
- **{A7}** requires A6 to be live first.
- **{A4}** is independent — can ship in any release.

---

## Non-custodial constraint check

Every feature is pure local computation on user's own observations and devices. No custody, no aggregation, no third-party trust.

**Considered and rejected:**
- *"Auto-rebalancing of user funds across pools"* — requires holding user funds. Out.
- *"Aggregating multiple users' hashrate to qualify for institutional pool tiers"* — classic custodial-pool path. Out.

---

## References

- Lykouris, Mirrokni & Paes Leme, "Stochastic Bandits Robust to
  Adversarial Corruptions," STOC 2018 — basis for A7 corruption
  hardening.
- Burnetas, Kanavetas & Katehakis, "Optimal Data Driven Resource
  Allocation under Multi-Armed Bandit Observations" (arXiv:1811.12852)
  — side-constraint (power-budget) MAB grounding for A3.
- Zuo & Joe-Wong, "Combinatorial Multi-armed Bandits for Resource
  Allocation" (arXiv:2105.04373) — logarithmic-regret budget allocation
  across arms, the regret-optimal target for A3 at scale.
- Mellor & Shapiro, "Thompson Sampling in Switching Environments with
  Bayesian Online Change Detection," 2013 — basis for A8.

---

## Status

**Proposed.** Renumbered from "ADR-006" in earlier research drafts to avoid collision with the already-accepted ADR-006 (Protocol abstraction). Forms Track A of the v3.5–v3.7 deepening plan alongside ADR-007 (Lightning), ADR-008 (hardware/power), and ADR-009 (pool decentralization).
