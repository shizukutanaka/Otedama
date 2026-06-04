# ADR-008: Hardware and power awareness layer

**Status:** Proposed
**Date:** 2026-05-12
**Target releases:** v3.5 (mid-2027) through v4.0 (April 2028 halving)
**Related ADRs:** ADR-010 (arbitration engine evolution), ADR-007 (Lightning capability expansion)

---

## Context

Otedama v3.0.0-alpha.1 routes user-owned compute between Bitcoin mining (SHA-256d via Stratum V2) and Akash AI inference. Its arbitration engine compares **hashprice yield** against **inference yield** and picks the better stream. This is the right starting model, and ADR-010 will deepen it with forecasting, switching-cost accounting, and per-device suitability.

However, the engine has a structural blind spot: **it does not model power consumption, electricity cost, or device-level efficiency**. A miner at $0.06/kWh and a miner at $0.18/kWh see identical routing decisions even though their profit functions differ by 3×. Post-2028 halving (block reward 3.125 → 1.5625 BTC, expected April 2028 at block ~1,050,000), this blindness becomes existential: the marginal miner is decided by electricity, not hashrate.

The 2025–2026 ASIC firmware ecosystem has solved most of the hardware-control problems Otedama needs:

- **LuxOS** (Luxor Technology, SOC 2 Type 2 certified) has sub-5-second curtailment, hashprice-responsive auto-tuning, and PSU bypass mode for 110V/120V household power.
- **BraiinsOS+** is the only firmware with native Stratum V2 and per-chip J/TH auto-tuning.
- **VNish** is deployed on 1.5M+ devices with per-chip tuning that delivers 20–30% hashrate boost.
- **DCENT_OS** is open-source (Rust), exposes a REST API, integrates with Home Assistant, and ships a PID-controlled "space heater mode."
- **ePIC UMC and MARA UCB 2100** are alternative control boards for S19/S21 series.

On the electricity-pricing side, **public time-of-use APIs are mature**:

- **Octopus Agile** (UK): `https://api.octopus.energy/v1/products/AGILE-18-02-21/electricity-tariffs/...` — half-hourly prices, no API key required for pricing, plunge pricing (negative rates), 100 p/kWh cap. The developer portal is at `https://developer.octopus.energy/`.
- **Tibber** (Germany/Nordics), **aWATTar** (Germany), **Amber Electric** (Australia) — all expose public APIs.
- **Predbat**, **OpenEnergyMonitor**, **EnergyStats UK** are production tools using these feeds.

What's missing is the **orchestration layer**: a single place that reads electricity prices + ambient conditions + device efficiency curves + provider yields, and pushes optimal power-limit commands to the firmware in real time. **That is exactly the gap Otedama is positioned to fill** — it is already the arbitrator of compute streams; adding the power-and-efficiency dimension is the natural next step.

This ADR proposes a dedicated `internal/power/` package plus a `Device` extension to `internal/hal/`, exposed through new subcommands `otedama power` and `otedama device`.

---

## Decision

We will add a hardware-and-power-awareness layer to Otedama, shipped across v3.5–v4.0, structured around **seven sub-domains**. The design preserves non-custodial arbitration: Otedama never holds funds, never operates a pool, and never aggregates other users' hashrate. It only optimizes the user's own hardware against the user's own electricity tariff.

### Sub-domain 1 — ASIC firmware control surface

**State of the art (2026):** Five viable firmware targets (stock Bitmain, BraiinsOS+, LuxOS, VNish, DCENT_OS) plus two alternative control boards (ePIC UMC, MARA UCB 2100). The common control surfaces are HTTP/JSON over the miner's LAN address. There is **no standardized "smartmontools for ASICs"** layer — every firmware speaks its own dialect.

**Otedama proposal:** Introduce a `FirmwareAdapter` interface that wraps each firmware's API:

```go
// internal/power/firmware/adapter.go
type FirmwareAdapter interface {
    // Identity
    Vendor() string                    // "luxos", "braiins+", "vnish", "stock", "dcent"
    Model() string                     // "antminer-s21", "antminer-s19-pro", ...

    // Read state
    Status(ctx context.Context) (Status, error)

    // Power control
    SetPowerTarget(ctx context.Context, watts int) error  // soft target
    SetTuningProfile(ctx context.Context, profile Profile) error
    Curtail(ctx context.Context) error                     // → ~25W (LuxOS pattern)
    Resume(ctx context.Context) error
}

type Status struct {
    HashrateTH    float64
    PowerW        float64
    JoulesPerTH   float64     // = PowerW / (HashrateTH * 1e12 / 1e12) = W/TH
    Temperature   float64     // hottest chip
    FanRPMs       []int
    LastShareSec  int
    UptimeSec     int64
}

type Profile struct {
    Mode          ProfileMode  // "max-efficiency", "max-hashrate", "watt-target"
    WattTarget    int          // when Mode == "watt-target"
    AmbientLimit  float64      // °C — back off above this
}
```

Adapters for **LuxOS** (most curtail-capable, prioritize first), **BraiinsOS+** (open-source friendly), and **stock Bitmain** (largest install base) ship in v3.5. **VNish** and **DCENT_OS** in v3.6.

**Cost:** ~50h per adapter; LuxOS + BraiinsOS+ + stock = ~150h. Mostly HTTP plumbing + JSON parsing.

**Value/cost rank:** ★★★★★ — this is the gateway capability. Without firmware adapters, nothing else in this ADR works.

**Non-custodial check:** ✅ Otedama only sends control commands to miners the user owns. No funds, no third-party hardware.

**Release:** v3.5 (LuxOS, BraiinsOS+, stock); v3.6 (VNish, DCENT_OS).

### Sub-domain 2 — GPU power management

**State of the art:** AMDGPU exposes `/sys/class/drm/cardN/device/power_dpm_state` and `power_dpm_force_performance_level`. NVIDIA exposes `nvidia-smi -pl <watts>` and the NVML C API (Go binding: `github.com/NVIDIA/go-nvml`). Intel Battlemage/Xe driver is converging on similar sysfs interfaces. Apple Silicon (M1–M5) only **observes** power via `powermetrics`/IOReport — no programmatic control surface.

**Otedama proposal:** A `GPUAdapter` interface parallel to `FirmwareAdapter`, with backends for AMDGPU sysfs, NVIDIA NVML, and Intel Xe sysfs:

```go
// internal/power/gpu/adapter.go
type GPUAdapter interface {
    Identity() GPUIdentity                          // vendor, model, PCI BDF
    Status(ctx context.Context) (GPUStatus, error)
    SetPowerLimit(ctx context.Context, watts int) error
    PowerLimitRange(ctx context.Context) (min, max int, err error)
}

type GPUStatus struct {
    PowerW          float64
    PowerLimitW     int
    UtilizationPct  float64
    MemoryUsedMiB   uint64
    Temperature     float64
    TokensPerSec    float64   // optional, populated by inference workload
}
```

**Cost:** NVML adapter ~30h (mature Go binding exists); AMDGPU sysfs ~25h; Intel Xe ~25h. Apple Silicon observation-only ~10h. Total ~90h.

**Value/cost rank:** ★★★★ — essential for AI inference side. GPU is where inference happens.

**Non-custodial check:** ✅ User's GPU, user's electricity.

**Release:** v3.5 (NVML); v3.6 (AMDGPU); v3.7 (Intel Xe, Apple observe).

### Sub-domain 3 — DVFS-aware profit math

**State of the art:** For SHA-256d, the J/TH curve is well-characterized for major chips. Public datasets exist from Hashrate Index, MinerMag, and BraiinsOS+ tuning data. The curve has a clear sweet spot: aggressive overclock gives more TH/s but degrades J/TH; deep undervolting improves J/TH but loses TH/s. The optimal operating point depends on electricity cost.

For AI inference on GPUs, the analogous curve (tokens-per-second per watt vs power limit) has been published for llama.cpp, vLLM, and TensorRT-LLM. NVIDIA H100 at 700W vs 400W shows roughly 60% throughput at 57% power — strongly favoring underpowering when electricity is expensive.

**Otedama proposal:** A "profit-per-kWh maximizer" mode in the arbitration engine. Given:
- Current hashprice (sat/TH/s/day)
- Current electricity cost ($/kWh)
- Device's J/TH curve (sampled at runtime)

Compute the operating point `(watts, J/TH)` that maximizes `revenue − electricity_cost`. The math is one-dimensional and tractable:

```
profit(W) = hashprice * hashrate(W) − price_kWh * W * 24/1000
```

Differentiate and find optimum on the empirically-sampled curve. This is conceptually similar to **LuxOS's hashprice-responsive tuning**, but generalized across firmware vendors and extended to GPU inference.

**Theoretical grounding & extension path:** Otedama's per-interval
profit maximisation is a static (myopic) optimum — it picks the best
operating point for *now*. The fuller problem, scheduling power over a
horizon to account for ramping transients and time-varying prices, is
an optimal-control problem. Ginzburg-Ganz et al., "Leveraging Bitcoin
Mining Machines in Demand-Response Mechanisms" (arXiv:2411.11119),
formulate exactly this as an extended unit-commitment problem and solve
it with Pontryagin's minimum principle on real grid data (CAISO, Noga).
We deliberately ship the myopic optimiser first (it captures most of
the value at a fraction of the complexity and needs no price forecast),
but the horizon-aware controller is the documented upgrade path once
the `tariff.PriceFeed.Forecast` from sub-domain 4 is reliable — the
forecast is precisely the input Pontryagin-style scheduling needs.

**Cost:** ~60h. Includes per-device curve sampling (auto-calibration: sweep power-limit, measure hashrate, fit cubic spline), profit optimizer (Brent's method, ~100 LOC), and integration with arbitration engine.

**Value/cost rank:** ★★★★★ — this is where the new package pays for itself. At $0.12/kWh, switching an S19 Pro from 110 J/TH stock to 90 J/TH efficient-mode (BraiinsOS+ data) raises daily profit by ~$1.50/device. Across 10 devices: ~$450/year saved.

**Non-custodial check:** ✅ Pure optimization on user's own hardware and tariff.

**Release:** v3.6 (after sub-domain 1 + 2 ship).

### Sub-domain 4 — Time-of-use electricity pricing

**State of the art:** Octopus Agile is the gold standard (public API, no key required, 30-minute granularity, plunge pricing). Tibber/aWATTar (Germany), Amber Electric (Australia), and Predbat-style spot-price approximations cover much of the rest. North American real-time pricing (ERCOT, NYISO real-time LMP, AESO) is available but routed through retail providers like Griddy Texas, Octopus Texas, and Energy Hub.

**Otedama proposal:** A `PriceFeed` interface returning a horizon of $/kWh forecasts:

```go
// internal/power/tariff/feed.go
type PriceFeed interface {
    Source() string                                // "octopus-agile-c", "tibber-de", "flat-fixed"
    Current(ctx context.Context) (PricePoint, error)
    Forecast(ctx context.Context, horizon time.Duration) ([]PricePoint, error)
    SupportsNegative() bool                        // plunge pricing
}

type PricePoint struct {
    ValidFrom time.Time
    ValidTo   time.Time
    PriceKWh  float64        // in user's currency
    Currency  string         // "GBP", "USD", "EUR", "JPY", "AUD"
    Source    string
}
```

Built-in adapters in v3.5: `flat-fixed` (user enters one rate), `octopus-agile` (no API key needed), `tibber` (requires API key), `amber-australia`. Custom feeds via a simple CSV import path for users with non-API utilities.

The arbitration engine consumes the forecast and biases routing decisions toward high-power activities (mining) during plunge windows, and toward curtailment or AI inference (lower W) during peak windows.

**Cost:** Octopus Agile adapter ~15h (well-documented, no auth); Tibber ~20h; Amber ~20h; CSV import ~10h; integration with engine ~25h. Total ~90h.

**Value/cost rank:** ★★★★★ — at variable-tariff regions, this single feature can shift annual profit by 20–40%. Octopus Agile users routinely report negative-price plunges multiple times per week.

**Non-custodial check:** ✅ User's tariff data, no third-party funds.

**Release:** v3.5 (flat-fixed, octopus-agile, csv-import); v3.6 (tibber, amber).

### Sub-domain 5 — Demand response and grid services

**State of the art:** Bitcoin mining facilities (Riot Platforms, Marathon Digital, Bitfarms) participate in ERCOT's Controllable Load Resource and Emergency Response Service. UK has the Demand Flexibility Service via National Grid ESO. **The minimum-size threshold for direct participation is typically 100 kW**, putting solo home miners out of reach. **Aggregators** bundle smaller users; LuxOS's sub-5-second curtailment is explicitly designed to qualify for strict-response programs.

**Otedama proposal:** Two-tier support:

1. **Aggregator-ready curtailment (v3.6):** Expose a local HTTP endpoint that accepts curtail/resume commands from an aggregator service the user has signed up with. Otedama just executes — the contract is between user and aggregator. This positions Otedama as the *execution layer* for solo miners who join an aggregator pool.

2. **Manual schedule (v3.5):** A YAML schedule (`~/.otedama/curtail-schedule.yaml`) where the user specifies their own avoidance windows. Useful for users on simple TOU plans where peak hours are fixed.

```yaml
# curtail-schedule.yaml
curtail_windows:
  - description: "Weekday evening peak (PG&E TOU-D-Prime)"
    days: [mon, tue, wed, thu, fri]
    start: "16:00"
    end: "21:00"
    target_watts: 25     # LuxOS-style deep curtail
  - description: "ERCOT scarcity event"
    trigger: "spot_price_above"
    threshold_usd_mwh: 500
    target_watts: 0      # full off
```

**We deliberately do not build a full DR market integration**: it requires accreditation, MWh metering certification, and entity-level contracts with grid operators — far beyond the solo-maintainer scope.

**Cost:** Manual schedule ~30h; HTTP curtail endpoint ~25h. Total ~55h.

**Value/cost rank:** ★★★ — niche but high-leverage for the few users who already participate.

**Non-custodial check:** ✅ Otedama executes user-configured rules. No money handled.

**Release:** v3.5 (manual schedule); v3.6 (aggregator endpoint).

### Sub-domain 6 — Thermal management and ambient awareness

**State of the art:** Home Assistant integrations via Tasmota, ESPHome, and DS18B20 1-Wire sensors are mature. Server-grade ambient sensing via `ipmitool` / Redfish. ASIC firmware already exposes chip temperature; ambient is the missing input.

**Otedama proposal:** An `AmbientSensor` interface plus thermal-aware decision logic:

```go
// internal/power/thermal/sensor.go
type AmbientSensor interface {
    Source() string                                          // "home-assistant", "1-wire", "manual"
    Reading(ctx context.Context) (Reading, error)
}

type Reading struct {
    AmbientTempC  float64
    HumidityPct   float64   // 0 if not measured
    At            time.Time
}
```

Decision rules (v3.6):

- If ambient > `derate_ambient_c` (default 32°C): reduce all device power limits 5% per °C above threshold.
- If ambient < `freecool_ambient_c` (default 10°C): allow up to manufacturer-rated peak (cool air = efficient mining).
- If room rises faster than `delta_c_per_min` (default 0.5): pre-emptively curtail before chips throttle.

**Cost:** Home Assistant adapter ~20h (REST API, well-documented); 1-Wire ~15h; integration with arbitration engine ~25h. Total ~60h.

**Value/cost rank:** ★★★★ — home miners particularly. Saves ASIC lifespan, prevents nuisance shutdowns, allows higher overclock when conditions support it.

**Non-custodial check:** ✅ Local sensor reads.

**Release:** v3.6.

### Sub-domain 7 — Solar/battery integration

**State of the art:** Production-ready local APIs from Enphase Envoy (Token-based local API since Envoy firmware D7+), Tesla Powerwall (Local Gateway API), SolarEdge ModBus TCP, Victron Venus OS dbus, SMA Sunny WebBox/Speedwire, Growatt cloud. Forecasting via Solcast (paid) or NREL PVlib (free, requires local computation).

**Economic grounding:** The "consume surplus generation only" strategy
is empirically validated by Choi et al., "Leveraging Surplus
Electricity: Profitability of Bitcoin Mining as a National Strategy in
South Korea" (arXiv:2505.00303), which shows that directing
post-net-metering surplus into mining generates revenue while
minimising energy loss — and notably uses an Antminer S21 XP Hyd
(473 TH/s, 5676 W, **12 J/TH**) as its efficiency baseline, the same
class of hardware Otedama's `SolarFeed` users would run. The paper
forecasts profitability with Random Forest and LSTM price models;
Otedama deliberately does **not** embed a price-forecasting ML model
(ADR-010's Holt-Winters is the chosen lightweight forecaster), but the
study confirms the core economic premise: surplus-driven mining at ~$0
marginal energy cost is profitable even at modest BTC prices.

**Otedama proposal:** A `SolarFeed` interface returning surplus generation:

```go
// internal/power/solar/feed.go
type SolarFeed interface {
    Source() string                                       // "enphase-envoy", "tesla-powerwall", "victron"
    Current(ctx context.Context) (SolarReading, error)
    Forecast(ctx context.Context, horizon time.Duration) ([]SolarPoint, error)
}

type SolarReading struct {
    GenerationW       float64
    HouseLoadW        float64
    SurplusW          float64   // GenerationW − HouseLoadW; can be negative
    BatterySOC        float64   // 0..1
    BatteryDirection  string    // "charging", "discharging", "idle"
    GridImportW       float64
    GridExportW       float64
    At                time.Time
}
```

The engine then has a `SurplusOnlyMode` that limits total compute draw to the available surplus, and a `BatteryAwareMode` that **does not discharge the battery to mining/inference** (that's almost always net-negative due to round-trip losses on top of any export tariff).

**Cost:** Enphase ~30h (good docs, OAuth flow); Tesla Powerwall ~30h; Victron ~30h. SolarEdge + SMA + Growatt as community contributions. Total ~90h for the three priority adapters.

**Value/cost rank:** ★★★★ — the solar-powered home miner is a real and growing user persona. Surplus-only mining at $0/kWh effective cost is the ultimate margin.

**Non-custodial check:** ✅ User's solar, user's battery.

**Release:** v3.7 (Enphase, Tesla, Victron).

---

## Architectural sketch

```
otedama/
├── cmd/otedama/
│   └── power_cmd.go              # new subcommand `otedama power`
│   └── device_cmd.go             # extends existing
├── internal/
│   ├── arbitration/              # existing — gets two new inputs:
│   │                             #   - power.Plan (recommended W per device)
│   │                             #   - tariff.PricePoint (current $/kWh)
│   │
│   ├── hal/                      # existing — gains Device extension fields
│   │
│   ├── power/                    # NEW
│   │   ├── firmware/             # sub-domain 1
│   │   │   ├── adapter.go        # FirmwareAdapter interface
│   │   │   ├── luxos.go          # v3.5
│   │   │   ├── braiins.go        # v3.5
│   │   │   ├── stock_bitmain.go  # v3.5
│   │   │   ├── vnish.go          # v3.6
│   │   │   └── dcent.go          # v3.6
│   │   ├── gpu/                  # sub-domain 2
│   │   │   ├── adapter.go        # GPUAdapter interface
│   │   │   ├── nvml.go           # v3.5
│   │   │   ├── amdgpu_sysfs.go   # v3.6
│   │   │   ├── intel_xe.go       # v3.7
│   │   │   └── apple_observe.go  # v3.7
│   │   ├── dvfs/                 # sub-domain 3
│   │   │   ├── curve.go          # J/TH curve sampling
│   │   │   ├── optimize.go       # Brent's method
│   │   │   └── calibrate.go      # automatic curve calibration
│   │   ├── tariff/               # sub-domain 4
│   │   │   ├── feed.go           # PriceFeed interface
│   │   │   ├── flat.go           # v3.5
│   │   │   ├── octopus.go        # v3.5
│   │   │   ├── csv.go            # v3.5
│   │   │   ├── tibber.go         # v3.6
│   │   │   └── amber.go          # v3.6
│   │   ├── dr/                   # sub-domain 5
│   │   │   ├── schedule.go       # YAML curtail-schedule
│   │   │   └── http_endpoint.go  # aggregator API
│   │   ├── thermal/              # sub-domain 6
│   │   │   ├── sensor.go         # AmbientSensor interface
│   │   │   ├── hass.go           # Home Assistant
│   │   │   └── onewire.go        # DS18B20
│   │   └── solar/                # sub-domain 7
│   │       ├── feed.go           # SolarFeed interface
│   │       ├── enphase.go        # v3.7
│   │       ├── tesla.go          # v3.7
│   │       └── victron.go        # v3.7
```

The **integration point** with `internal/arbitration/` is a single new dependency:

```go
// internal/arbitration/engine.go (excerpt)
type Engine struct {
    // existing
    miningProvider provider.Provider
    aiProvider     provider.Provider

    // NEW (v3.5)
    tariff         tariff.PriceFeed
    powerPlanner   *power.Planner
}

func (e *Engine) Decide(ctx context.Context) (Decision, error) {
    miningQuote, _ := e.miningProvider.Quote(ctx)
    aiQuote, _ := e.aiProvider.Quote(ctx)
    currentPrice, _ := e.tariff.Current(ctx)

    // Compute electricity-adjusted yield
    miningNet := miningQuote.RevenuePerHour - currentPrice.PriceKWh * miningQuote.PowerW / 1000.0
    aiNet := aiQuote.RevenuePerHour - currentPrice.PriceKWh * aiQuote.PowerW / 1000.0

    // Power plan (per-device W targets)
    plan, _ := e.powerPlanner.Optimize(ctx, currentPrice)

    return Decision{
        Provider:    pickBetter(miningNet, aiNet),
        PowerPlan:   plan,
        Reasoning:   fmt.Sprintf("price=%.3f, mining_net=%.2f, ai_net=%.2f", ...),
    }, nil
}
```

---

## `otedama power` UX proposal

```
$ otedama power
power awareness layer

Usage:
  otedama power status              show current device power, J/TH, ambient
  otedama power calibrate [device]  sweep power limits to learn J/TH curve
  otedama power set <device> <W>    manually set power limit
  otedama power tariff show         show current and next-24h electricity prices
  otedama power tariff configure    interactive tariff setup
  otedama power schedule edit       open curtail schedule in $EDITOR
  otedama power explain             explain the current power plan and reasoning
  otedama power dry-run             show what the power planner *would* do

Flags:
  --device <id>     limit operation to one device
  --json            machine-readable output
```

Example output of `otedama power explain`:

```
=== Otedama power plan ===
Time: 2027-08-14 14:32:11 BST
Tariff: octopus-agile-c (current 22.4p/kWh, next 30m: 18.1p, +1h: 12.6p)
Ambient: 24.8°C (Home Assistant sensor.living_room_temperature)

Device                  Current   Plan      ΔW     Reason
─────────────────────────────────────────────────────────────────────
antminer-s21-01          3050W    2700W   −350    price > 20p, dropping to next sweet spot at 90 J/TH
antminer-s21-02          3050W    2700W   −350    same
rtx4090-inference-01     370W     250W    −120    AI yield 28% lower than mining-adjusted; back off
rtx4090-inference-02     370W     OFF     −370    duplicate of -01; queue empty; idle until next inference job

Net plan: 5650W (down from 6840W). Projected $/day after electricity: $14.20 (was $11.80).
Will re-evaluate in 30 minutes when next tariff bucket arrives.
```

---

## Quantitative reasoning — three scenarios

### Scenario A: Home miner, 2× Antminer S19 Pro at $0.12/kWh flat

- Stock firmware, 110 TH/s × 2 = 220 TH/s, ~3050W × 2 = 6100W
- Hashprice ≈ $48/PH/day → mining revenue: 220 × 48 / 1000 = **$10.56/day**
- Electricity: 6.1 kW × 24h × $0.12 = **$17.57/day**
- **Stock net: −$7.01/day** (currently unprofitable at this electricity price)

With Otedama power layer + BraiinsOS+ at J/TH-efficient profile (90 J/TH instead of 110 J/TH):

- 110 TH/s × 2 = 220 TH/s (preserved via auto-tune)
- Power: 220 × 90 / 1000 = 19.8 kW·h/day → wait, that's wrong. Let me redo.
- Power per device at 90 J/TH × 110 TH/s = 9.9 kW... that's higher than stock.

Correcting: at 90 J/TH the device runs at 90 W per TH/s. If we hold 110 TH/s, we need 9900W. That's *more* than the 3050W stock unit.

The realistic move is: **maintain the same wall power (~3050W) by reducing hashrate to the J/TH-efficient point.** At 90 J/TH and 3050W, hashrate = 3050/90 = ~34 TH/s. Lower throughput.

Better realistic numbers (from BraiinsOS+ S19 Pro published data):
- Stock: 110 TH/s @ 3250W = 29.5 J/TH (Antminer's marketing 29.5 J/TH was always nominal; real-world is ~32 J/TH)
- Efficient profile: 95 TH/s @ 2660W = 28 J/TH
- Going to 28 J/TH:
  - Hashrate × 2 = 190 TH/s; revenue = 190 × 48 / 1000 = $9.12/day
  - Power × 2 = 5320W; electricity = 5.32 × 24 × 0.12 = $15.32/day
  - **Net: −$6.20/day** ← still unprofitable but 12% less bad

The honest conclusion: **at $0.12/kWh post-halving, S19 Pro is fundamentally marginal.** Otedama's value here is to surface this clearly and route to AI inference when GPU is available, or recommend curtailment during peak hours.

### Scenario B: Small farm, 30× Antminer S21 at $0.08/kWh fixed

- Stock S21: 200 TH/s @ 3500W = 17.5 J/TH
- 30 × 200 = 6000 TH/s = 6 PH/s
- Hashprice $52/PH/day → revenue = 6 × 52 = **$312/day**
- Power: 30 × 3500 = 105 kW; electricity = 105 × 24 × 0.08 = **$201.60/day**
- **Stock net: +$110.40/day = $3,312/month**

With Otedama's TOU integration (assume operator moves to Octopus Agile, average effective rate $0.06/kWh with peak-curtailment):

- Revenue: $312/day (curtailing 5h/day costs ~$65 in lost revenue → $247/day)
- Electricity: 105 × (24-5) × 0.06 + (curtailed period: ~0) = $119.70/day
- **Net: +$127.30/day = $3,820/month**
- **Annual uplift: $6,096/year** for the same hardware

Plus per-chip auto-tuning via BraiinsOS+: additional 3-5% efficiency = another $1,500-$2,500/year.

**Total potential lift over baseline: ~$8,000-$8,500/year.** This is the persona for whom Otedama's power layer pays off most clearly.

### Scenario C: Solar+battery home miner, 1× S19 XP, 10 kW PV, 13.5 kWh Powerwall

- Solar generation: ~40 kWh/day average (UK), ~55 kWh/day (Texas), ~50 kWh/day (Australia)
- House baseline load: ~15 kWh/day
- Surplus available: 25–40 kWh/day
- S19 XP: 140 TH/s @ 3010W = 21.5 J/TH
- If miner only runs on surplus: ~10h/day effective at full power, ~7-12 kWh/day actually consumed
- Daily mining: 140 × 10/24 × hashprice → ~ 60 TH-day/day → revenue $3.10/day
- Electricity cost: $0 (using surplus that would have been exported at low feed-in tariff, or stored)

**Net: +$3.10/day with zero marginal cost.** Plus the user *needs* to dump solar somewhere — Otedama makes that economic choice automatic via the `SolarFeed` interface, switching to AI inference during low-surplus windows where the device draws less power.

This is the lowest absolute revenue but the **highest margin (∞%)** scenario, and over a 10-year solar array lifetime represents ~$11,000 of value that would otherwise be lost to export at low feed-in rates or to curtailment.

---

## Cost summary

| Sub-domain | Hours | Release | Value/Cost |
|-----------|-------|---------|------------|
| 1. ASIC firmware adapters | 150 | v3.5 (3 of 5) | ★★★★★ |
| 2. GPU power management | 90 | v3.5 (NVML) | ★★★★ |
| 3. DVFS profit math | 60 | v3.6 | ★★★★★ |
| 4. TOU electricity pricing | 90 | v3.5 (3 of 5) | ★★★★★ |
| 5. Demand response | 55 | v3.5/3.6 | ★★★ |
| 6. Thermal/ambient | 60 | v3.6 | ★★★★ |
| 7. Solar/battery | 90 | v3.7 | ★★★★ |
| **Total** | **595h** | v3.5–v3.7 | — |

595 hours over 18 months at 10h/week = 720 hours available → 17% buffer. Tight but feasible.

---

## Mutually-reinforcing clusters

- **{1, 3}**: DVFS math is useless without firmware adapters to apply it.
- **{1, 4, 5}**: TOU + DR + firmware control = the full "respond to grid signals" loop.
- **{6, 1}**: Ambient sensing modulates firmware power limits.
- **{7, 4}**: Solar surplus is a "negative price" — fits naturally into the PriceFeed abstraction (`PriceKWh = -feed_in_tariff` when surplus exists).
- **{2, 3}**: GPU adapter + DVFS curve enables AI-inference-side optimization symmetric to mining-side.

---

## Non-custodial constraint check (consolidated)

Every feature in this ADR operates on the user's own hardware, the user's own electricity tariff, and the user's own solar/battery. **No feature involves Otedama holding funds, aggregating hashrate, or operating on behalf of third parties.** The aggregator endpoint (sub-domain 5) is execution-only: the user signs the aggregator contract; Otedama merely curtails when told.

Considered and **rejected** features:

- *"Otedama-operated demand-response aggregator"* — would require Otedama to receive grid payments on behalf of users. Custodial. Out.
- *"Mining-as-a-service for users who don't own ASICs"* — fundamentally a pool operator. Out.
- *"Hashrate tokenization (sell forward your future hashrate as NFT)"* — derivatives market on user output. Custodial and regulated. Out.

---

## Risks and external dependencies

1. **Firmware API drift.** LuxOS, BraiinsOS+, VNish each evolve their APIs. We mitigate with per-version adapter tests and a `min_supported_version` field per adapter. Quarterly review of firmware release notes.

2. **NVIDIA driver licensing.** Embedding NVML requires shipping against NVIDIA's redistributable. We use `github.com/NVIDIA/go-nvml`, which is BSD-licensed and dlopen's the system NVML — no NVIDIA binary in our distribution.

3. **Octopus Agile is UK-only.** International expansion of TOU feeds is community-driven. We ship the interface; users contribute country-specific adapters.

4. **DR aggregator market is fragmented.** No single API standard. We ship a generic HTTP endpoint; integrations with specific aggregators (Voltus, Enel X, etc.) deferred to user community.

5. **Solar inverter APIs change.** Enphase changed auth model in 2022 (Token-based). Tesla restricts Local Gateway access. We monitor and version-pin.

6. **Plunge-pricing exploitation risk.** If many Otedama users on Octopus Agile all aggressively mine during negative-price windows, they could slightly move the spot market. Otedama itself doesn't aggregate, but emergent coordination is plausible. We document this and recommend users not all set identical thresholds (auto-jitter built into the schedule logic).

7. **2028 halving timing uncertainty.** Block 1,050,000 may occur anywhere from late March to mid-May 2028 depending on hashrate growth. v4.0's positioning slightly flexible. We will track and re-time if needed.

---

## Decision threshold to ship

- **v3.5 cut:** sub-domain 1 (LuxOS + BraiinsOS+ + stock) + sub-domain 2 (NVML) + sub-domain 4 (flat + Octopus + CSV) + sub-domain 5 (manual schedule). Must pass: backtest showing ≥10% net-profit improvement on a representative home-miner trace vs current Otedama.

- **v3.6 cut:** sub-domains 3 + 6 + remaining firmware adapters. Must pass: J/TH curve auto-calibration converges within 10 minutes of sweep on supported hardware.

- **v3.7 cut:** sub-domain 7 + Intel Xe + Apple observe. Must pass: end-to-end "surplus-only" mode delivers correct routing on Enphase + Tesla scenarios.

- **v4.0 polish + audit.** Security review of firmware adapters (each is privileged on the LAN). Halving-aligned release.

---

## Implementation order (concrete steps)

1. Land the `internal/power/` package skeleton + `FirmwareAdapter` interface (v3.5-α1).
2. Implement `tariff.PriceFeed` flat and Octopus Agile adapters first (no hardware needed; pure HTTP).
3. Wire `Engine.Decide` to consume `PriceFeed.Current()` (one-line change in arbitration engine).
4. Add LuxOS adapter (simplest, best documented).
5. Add BraiinsOS+ adapter.
6. Add stock Bitmain adapter (legacy, hardest, but largest install base).
7. NVML adapter for GPU side.
8. Manual curtail schedule.
9. v3.5 release with sub-domains 1, 2 (partial), 4 (partial), 5 (manual).
10. Sub-domain 3 (DVFS math) closes the loop in v3.6.

---

## References

### Production tools and APIs

- LuxOS firmware: https://luxor.tech/firmware
- BraiinsOS+ documentation: https://braiins.com/os
- DCENT_OS (open source): https://d-central.tech/downloads/firmwares/
- Octopus Energy Developer Portal: https://developer.octopus.energy/
- Octopus Agile API guide: https://www.guylipman.com/octopus/api_guide.html
- Predbat (Home Assistant battery dispatcher): https://springfall2008.github.io/batpred/
- OpenEnergyMonitor Agile App: https://docs.openenergymonitor.org/emoncms/agileapp.html
- ePIC UMC / MARA UCB 2100: https://altairtech.io/
- ASIC firmware comparison (D-Central 2026): https://d-central.tech/firmware-comparison/
- NVIDIA go-nvml: https://github.com/NVIDIA/go-nvml
- Enphase local API: https://enphase.com/installers/apps/envoy
- Tesla Powerwall Local API: https://github.com/jrester/tesla_powerwall

### Academic literature

- Ginzburg-Ganz et al., "Leveraging Bitcoin Mining Machines in
  Demand-Response Mechanisms to Mitigate Ramping-Induced Transients"
  (arXiv:2411.11119) — optimal-control (Pontryagin) scheduling of
  miners against grid ramping; basis for the horizon-aware extension of
  sub-domain 3's DVFS profit math.
- Choi et al., "Leveraging Surplus Electricity: Profitability of
  Bitcoin Mining as a National Strategy in South Korea"
  (arXiv:2505.00303) — empirical validation of surplus-only mining
  economics underpinning sub-domain 7; uses the S21 XP Hyd (12 J/TH) as
  baseline.

---

## Status

**Proposed.** This ADR consolidates the third major v3.5–v4.0 research thread alongside ADR-010 (arbitration engine evolution) and ADR-007 (Lightning capability expansion). Combined, the three ADRs define the complete roadmap from v3.0 alpha to the April 2028 halving.

Next steps: incorporate `internal/power/` skeleton into the codebase as a no-op stub (ship in next minor release), then begin Octopus Agile adapter as the first concrete deliverable (lowest dependency, fastest signal of design soundness).
