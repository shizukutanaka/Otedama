# Otedama API Reference

This document is the authoritative reference for all external interfaces
exposed by Otedama: the command-line interface, configuration file,
environment variables, and HTTP endpoints.

---

## Command-line interface

### `otedama run`

Start mining and compute arbitration.

```
otedama run [flags]
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--bitcoin-address` | string | (required) | Bitcoin address for mining rewards. Bech32 (`bc1...`) or legacy (`1.../3...`). |
| `--config` | string | `~/.config/otedama/config.yaml` | Path to YAML configuration file. Optional. |
| `--data-dir` | string | `~/.local/share/otedama` | Directory for wallet and persistent state. |
| `--language` | string | `en` | UI language. BCP 47 tag (e.g. `ja`, `zh-CN`). |
| `--log-level` | string | `info` | Log verbosity: `debug`, `info`, `warn`, `error`. |
| `--log-format` | string | `text` | Log output format: `text` or `json`. |
| `--log-file` | string | (empty) | Append structured logs to this file. Written even under the TUI, so it provides an audit trail the dashboard otherwise hides. Created `0600`. |
| `--no-tui` | bool | `false` | Disable the terminal dashboard. |
| `--no-pool-share-check` | bool | `false` | Skip the one-shot mempool.space lookup that warns when the configured pool controls ≥30% of weekly network blocks (large-pool concentration risk). |
| `--wallet-passphrase` | string | (empty) | Passphrase to unlock/create the Lightning wallet. Empty = skip wallet. |
| `--wallet-mnemonic-passphrase` | string | (empty) | Optional BIP-39 "25th word" passphrase, applied only when a *new* wallet is created. Distinct from `--wallet-passphrase` (which encrypts the seed at rest); this changes which seed the recovery mnemonic derives to. Not needed again after first run. |
| `--no-wallet-backup-check` | bool | false | (run only) Skip the interactive recovery-phrase backup check on first wallet creation. The check only ever runs on an interactive terminal — unattended runs already skip it — so this flag exists for scripted interactive sessions and demos. |
| `--http-addr` | string | (empty) | HTTP address for metrics/health endpoints. Empty = disabled. |
| `--pprof` | bool | `false` | (run only) Mount Go pprof profiling endpoints under `/debug/pprof/` on the same `--http-addr` listener. Restricted to loopback/private addresses; a non-loopback bind logs a warning. |
| `--dry-run` | bool | `false` | Validate configuration and exit without mining. |

**Exit codes:**

- `0` — Clean shutdown (e.g. SIGINT after Ctrl+C).
- `1` — Runtime error during mining (pool connection exhausted, etc.).
- `64` — Bad command-line usage.
- `78` — Invalid configuration.

**Examples:**

```bash
# Minimum viable invocation.
otedama run --bitcoin-address bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq

# With wallet and JSON logs (for aggregation into Loki/ES).
otedama run \
  --bitcoin-address bc1q... \
  --wallet-passphrase 'my strong passphrase' \
  --no-tui \
  --log-format json

# With Prometheus metrics exposed on localhost.
otedama run \
  --bitcoin-address bc1q... \
  --http-addr 127.0.0.1:9090

# Dry-run: verify config only.
otedama run --bitcoin-address bc1q... --dry-run
```

### `otedama version`

Print version information.

```
otedama version [--json]
```

Text output example:
```
otedama v3.0.0-alpha.1 (commit abc1234 built 2026-04-24 linux/amd64)
```

JSON output fields:
- `version` — semver tag.
- `commit` — Git SHA (truncated to 7 chars).
- `build_date` — UTC ISO 8601 timestamp.
- `go_version` — `runtime.Version()` the binary was built with.
- `platform` — `GOOS/GOARCH`.

### `otedama config`

Inspect or validate the effective configuration.

- `otedama config show [--config path] [--origin] [--json]` — Print the merged
  configuration (defaults + file + env + flags). `--origin` annotates each value
  with the layer that set it; `--json` emits a JSON object (resolved values, plus
  an `origins` map when combined with `--origin`) for deploy/config-management scripts.
- `otedama config validate [flags]` — Check validity and exit with
  exit code 78 on problems. Takes the same flags as `otedama run`.

### `otedama service`

Install, remove, or query the auto-start service.

- `otedama service install [--config path] [--data-dir path]`
  Install the user-level service (systemd user unit on Linux,
  LaunchAgent on macOS, Windows service on Windows).
- `otedama service uninstall` — Remove and stop the service.
- `otedama service status` — Print installation and running state.

### `otedama doctor`

Run self-diagnostic checks and print a report.

```
otedama doctor [--config path] [--bitcoin-address addr] [--data-dir path] [--json]
```

`--json` emits a single JSON object instead of the text report — suitable for CI
gating or monitoring agents. Shape: `{"summary":{"passed","failed","warnings",
"skipped"}, "duration_ms", "exit_code", "checks":[{"name","status","detail","fix",
"elapsed_ms"}]}`, where `status` is one of `pass|warn|fail|skip`.

**Exit codes:**
- `0` — All checks passed.
- `1` — At least one check emitted a warning.
- `2` — At least one check failed.

The same exit code is mirrored in the JSON `exit_code` field.

Suitable as a container healthcheck command:
```yaml
healthcheck:
  test: ["CMD", "otedama", "doctor"]
```

### `otedama arb`

Inspect the running engine's arbitration decisions.

```
otedama arb explain [--config path] [--http-addr addr] [--json]
```

`arb explain` fetches `GET /arbitration` from the daemon (the `--http-addr`
flag, then `OTEDAMA_HTTP_ADDR`, then `http_addr` in the config file) and
renders the latest `DecisionSnapshot` as a per-device table: selected
stream, expected vs one-step forecast yield (± the forecaster's error
scale), the Beta-Bernoulli provider reliability posterior used by the
decision, and the held/switch/foregone detail (ADR-010 A9). A
"Reasoning:" block below the table explains each non-stay decision in
one clause — a switch states both streams' yields and the % delta, a
hysteresis hold or policy override names the declined stream
(`foregone_stream`) and its advantage, and when both sides have
forecast error scales the clause states whether the gap exceeds the
combined forecast error. `--json` emits the snapshot body verbatim for
scripting.

**Exit codes:** `0` — rendered; `1` — daemon unreachable or no decision
recorded yet (503); `78` — no HTTP address configured.

---

## Configuration file

Location (in order of precedence):

1. `--config` command-line flag.
2. `OTEDAMA_CONFIG` environment variable.
3. `~/.config/otedama/config.yaml`.

Format: YAML. See `config.yaml.example` for a fully-commented template.

```yaml
# Bitcoin address for mining rewards (required).
bitcoin_address: bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq

# Log verbosity and format.
log_level: info            # debug | info | warn | error
log_format: text           # text | json

# UI language (BCP 47).
language: en               # en, ja, zh, ko, es, fr, de, pt, ru, ar

# Data directory for wallet and persistent state.
data_dir: ~/.local/share/otedama

# Mining pools, tried in the order listed (list position is the priority;
# there is no separate priority field).
pools:
  - url: stratum+v2://public.stratum.slushpool.com:3336
  - url: stratum+v2://demand.sv2.io:34254

# Worker identification sent to pools — a single object, not a list.
# device/threads are not config fields: Otedama auto-detects every
# SHA256d-capable device (see internal/hal) and spawns one worker per
# device automatically; `name` only controls how the miner identifies
# itself to the pool.
workers:
  name: cpu-worker
```

The YAML decoder rejects unknown fields and a type mismatch (e.g. a list
where a single object is expected) fails the *entire* document, not just
the offending key — so a malformed `pools:` or `workers:` entry silently
discards every setting in the file, including `bitcoin_address`. See
`config.yaml.example` for the exact, decoder-verified schema.

**Precedence of configuration sources** (highest wins):

1. Command-line flags.
2. Environment variables (`OTEDAMA_*`).
3. Configuration file.
4. Built-in defaults.

---

## Environment variables

All environment variables are prefixed `OTEDAMA_`.

| Variable | Equivalent flag / config key | Notes |
|----------|-----------------|-------|
| `OTEDAMA_CONFIG` | `--config` | Path to config file. |
| `OTEDAMA_BITCOIN_ADDRESS` | `--bitcoin-address` | |
| `OTEDAMA_DATA_DIR` | `--data-dir` | |
| `OTEDAMA_LOG_LEVEL` | `--log-level` | |
| `OTEDAMA_LOG_FORMAT` | `--log-format` | |
| `OTEDAMA_LANGUAGE` | `--language` | |
| `OTEDAMA_WALLET_PASSPHRASE` | `--wallet-passphrase` | Preferred over flag in production — flag is visible in process lists. |
| `OTEDAMA_WALLET_MNEMONIC_PASSPHRASE` | `--wallet-mnemonic-passphrase` | Same process-list caveat as above. Only consulted on first run (new wallet creation). |
| `OTEDAMA_HTTP_ADDR` | `--http-addr` | |
| `OTEDAMA_INCOME_MODE` | `income_mode` | `max` / `smooth` / `balanced`. |
| `OTEDAMA_ELECTRICITY_TARIFF_OCTOPUS` | `electricity_tariff_octopus` | Octopus tariff as `PRODUCT/TARIFF`; enables the tariff feed + forward-curve metrics. |
| `OTEDAMA_ARBITRATION_HYSTERESIS_PCT` | `arbitration_hysteresis_pct` | [0.0, 1.0); malformed values are rejected. |
| `OTEDAMA_MIN_YIELD_SATS_PER_SEC` | `min_yield_sats_per_sec` | ≥ 0 (0 = floor disabled). |
| `OTEDAMA_CURTAIL_BELOW_BTC_USD` | `curtail_below_btc_usd` | ≥ 0 (0 = gate disabled). |
| `OTEDAMA_CURTAIL_ABOVE_UK_CARBON` | `curtail_above_uk_carbon` | ≥ 0 gCO2/kWh (0 = gate disabled). |
| `OTEDAMA_CURTAIL_ABOVE_TARIFF_PENCE` | `curtail_above_tariff_pence` | ≥ 0 pence/kWh (0 = gate disabled); requires `electricity_tariff_octopus`. |
| `OTEDAMA_POWER_WATTS` | `power_watts` | ≥ 0 (0 = efficiency metrics off). |
| `OTEDAMA_ELECTRICITY_PRICE_PER_KWH` | `electricity_price_per_kwh` | ≥ 0 USD/kWh (0 = cost metrics off). |
| `OTEDAMA_THERMAL_THROTTLE_ABOVE_CELSIUS` | `thermal_throttle_above_celsius` | [20, 110] or 0 = disabled. |
| `OTEDAMA_WORKER_THREADS` | `worker_threads` / `--worker-threads` | Integer in [0, 1024]; 0 = one hashing goroutine per logical CPU. |

---

## HTTP endpoints

Activated by `--http-addr host:port`. All endpoints are unauthenticated;
bind to `127.0.0.1` or a private network.

### `GET /healthz`

Liveness probe. Always returns 200 OK with body `ok\n` as long as the
HTTP server goroutine is alive.

Use case: container orchestrator restarts a frozen process.

### `GET /readyz`

Readiness probe. Returns:

- `200 OK` + body `ready\n` — engine has fully started.
- `503 Service Unavailable` + body `not ready\n` — still starting, or shutting down.

Use case: load balancer removes a not-yet-ready instance from rotation.

### `GET /metrics`

Prometheus text exposition format (version 0.0.4). All metrics are
prefixed `otedama_`. Metrics are created at startup; counters and the
lazily-created per-label series (reject reasons, per-device shares, payout
addresses) appear once their first event occurs.

**Mining & shares**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_hashrate_hashes_per_second` | gauge | — | Live aggregate hash rate. |
| `otedama_shares_found_total` | counter | — | Shares found locally (before submission). |
| `otedama_device_shares_found_total` | counter | `device` | Per-device breakdown of shares found. |
| `otedama_shares_total` | counter | `status={accepted,rejected}` | Shares acknowledged by pool. |
| `otedama_shares_unaccounted` | gauge | — | Found locally but not yet judged (found − accepted − rejected, clamped ≥0). A sustained value means shares are not reaching the pool; the engine logs a `warn` when the backlog stays ≥8 for 3 consecutive stats ticks. |
| `otedama_shares_rejected_by_reason_total` | counter | `reason={stale,duplicate,difficulty,hardware,other,difficulty-change}` | Rejections by inferred root cause. `difficulty-change` marks benign cross-generation rejects: shares honestly mined under the previous share difficulty, rejected because `mining.set_difficulty` moved the target mid-flight; excluded from `shares_rejected`/`reject_rate`. |
| `otedama_last_reject_seconds` | gauge | `reason=…` | Unix timestamp of the most recent rejection of each category (distinguishes ongoing from cleared problems). |
| `otedama_share_acceptance_rate` | gauge | — | Accepted / judged (1.0 = all accepted). |
| `otedama_reject_rate` | gauge | — | Rejected / judged (complement of acceptance; >0.03 investigate). |
| `otedama_stale_rate` | gauge | — | Stale-rejected / judged (network-latency signal). |
| `otedama_submit_latency_milliseconds` | gauge | `quantile={0.5,0.95,0.99}` | Submit→accept round-trip latency. |
| `otedama_submit_latency_seconds` | histogram | — | Submit→verdict round-trip latency, le buckets 0.01–10 s. Bucket samples carry OpenMetrics exemplars (`# {job_id="N"}`) linking a latency spike to the share that produced it; on text/0.0.4 parsers the ` # {…}` suffix is read as a comment. |

**Pool & connection**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_pool_connect_attempts_total` | counter | — | Pool dial attempts, including reconnects. |
| `otedama_pool_connect_failures_total` | counter | — | Pool dial failures. |
| `otedama_pool_connection_state` | gauge | — | 0=disconnected, 1=connecting, 2=connected. |
| `otedama_pool_active_index` | gauge | — | 0-based index of the active pool in the failover list. |
| `otedama_pool_network_share` | gauge | `pool_host=…` | Connected pool's weekly block-share of the network (mempool.space, one-shot per host). ≥0.30 logs a concentration warn; absent when the pool is not publicly tracked. |
| `otedama_pool_difficulty` | gauge | — | Current share difficulty (`mining.set_difficulty`). |
| `otedama_estimated_share_interval_seconds` | gauge | — | Expected seconds between shares (difficulty × 2³² / hashrate). |
| `otedama_last_job_received_seconds` | gauge | — | Unix timestamp of the most recent pool job (stale-connection detector). |
| `otedama_pool_tls_cert_not_after_unixtime` | gauge | `pool_host=…` | Leaf certificate expiry of the connected pool (TLS transports only: `stratum+tls://`, `stratum+v2tls://`). Alert before `time()` reaches it — an expiring pool cert surfaces as sudden dial failures at the next reconnect. |
| `otedama_asic_pool_switches_total` | counter | `pool_host=…` | Successful cgminer `switchpool` pushes to managed ASICs (`asic_manage`), per destination pool host; each successful endpoint switch counts once. |

**Arbitration**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_arbitration_switches_total` | counter | — | Workload reroutes by the arbitration engine. |
| `otedama_arbitration_holds_total` | counter | — | Decisions where a higher-yielding stream existed but hysteresis kept the current one. |
| `otedama_arbitration_confirmation_holds_total` | counter | — | Subset of `_holds_total` where the suppressed candidate was an unconfirmed stream awaiting k quote confirmations (ADR-010 A7 confirmation ladder). |
| `otedama_arbitration_foregone_sats_per_second` | gauge | — | Instantaneous opportunity cost: raw sats/s sacrificed versus pure yield routing, summed across devices (hysteresis holds + non-earnings policy preferences). The magnitude companion to `_holds_total`. |
| `otedama_arbitration_switch_verdicts_total` | counter | `verdict` | Switches scored one settle window (2 min) later: `paid_off` = realized yield ≥ the abandoned stream's current offer; `churn` = abandoned stream now offers more (the switch cost yield); `unverifiable` = abandoned stream no longer quotes. The `churn` rate is the empirical input for tuning `arbitration_hysteresis_pct`. |
| `otedama_arbitration_last_switch_realized_gain_sats_per_second` | gauge | — | Realized gain of the most recent verifiable switch verdict (negative = churned). |
| `otedama_arbitration_expected_yield_sats_per_second` | gauge | — | The engine's forecast REAL earning rate (summed ExpectedYield of the chosen allocation restricted to live-market streams — simulated streams publish to `_simulated_yield_sats_per_second` instead). Compare against realized earnings to judge quote accuracy; × BTC rate for expected $/day. Feeds the TUI's lifetime-sats accumulator, so modeled revenue can never accrue as fake income. |
| `otedama_effective_yield_sats_per_second` | gauge | — | Expected yield × lifetime productive fraction (`productive_seconds_total / uptime_seconds`) — folds downtime into a single gross-minus-losses estimate. |
| `otedama_arbitration_simulated_yield_sats_per_second` | gauge | �� | Forecast earning rate of assignments on simulated streams only (providers quoting modeled prices, e.g. ai.akash). Reads 0 on rigs with no devices routed to simulated providers. |
| `otedama_stream_yield_shifts_total` | counter | `stream`, `device` | Significant yield shifts per stream-device — a change exceeding 2% of the prior level, or a zero/positive transition. The S (switches) drift measure; a high shifts/variation ratio means the stream moves in regime steps and suits change-point handling. |
| `otedama_stream_yield_drift_sats_per_second` | gauge | `stream`, `device` | Accumulated \|Δyield\| per stream-device since startup — the V_T (total variation) drift measure. High drift with few shifts = smooth wandering suited to a forecaster; many shifts = jumps. |
| `otedama_active_streams` | gauge | — | Live revenue streams after pruning stale (dead-provider) quotes. |
| `otedama_stream_last_quote_unixtime` | gauge | `stream`, `device` | Unix timestamp of the stream's most recent provider quote — the provider heartbeat. Alert on `time() - value` exceeding the stale-prune TTL (3m): a dead provider is visible before the reliability update the prune issues. The series keeps its final timestamp after pruning — the stale value is itself the evidence. |
| `otedama_arbitration_provider_reliability` | gauge | `provider` | Beta-Bernoulli posterior mean of the provider's reliability (ADR-010 A6) — the factor currently discounting its quoted confidence. New providers start at 0.5 and converge toward 1 (reliable) or 0 (dead). |
| `otedama_arbitration_yield_forecast_sats_per_second` | gauge | `stream`, `device` | Holt-Winters one-step-ahead predicted effective yield (ADR-010 A1). Compare against the stream's actual quote series. |
| `otedama_arbitration_forecast_misses_total` | counter | `stream`, `device` | Quotes deviating >2σ from the Holt-Winters forecast — the regime-change signal for ADR-010 A8's forecaster reset. |
| `otedama_arbitration_forecaster_resets_total` | counter | `stream`, `device` | A8 change-point resets — the smoother re-seeds when the median of its last-5 absolute errors exceeds 2σ. A rising rate marks a provider whose yield moves in cliffs (difficulty steps, auction-floor changes). |

**Economics & power**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_btc_usd_rate` | gauge | — | Current BTC/USD rate (median of 3 sources). |
| `otedama_btc_rate_age_seconds` | gauge | — | Seconds since the rate was last successfully fetched (silent-staleness detector). |
| `otedama_rate_sources_ok` | gauge | — | Price sources returning a usable in-band reading in the last fetch. `ok < total` = degraded redundancy. |
| `otedama_rate_sources_total` | gauge | — | Price sources configured (denominator for `_ok`). |
| `otedama_power_watts` | gauge | — | Configured system power draw (0 = unset). |
| `otedama_joules_per_terahash` | gauge | — | Energy efficiency: watts × 1e12 / hashrate. |
| `otedama_power_cost_usd_per_hour` | gauge | — | Electricity cost: watts/1000 × electricity price. |
| `otedama_thermal_sensor_celsius` | gauge | `source`, `label` | Latest OS thermal (hwmon) reading per sensor, e.g. `{source="k10temp",label="Tctl"}`; Linux-only, absent on other platforms. |
| `otedama_electricity_tariff_pence_per_kwh` | gauge | — | Current Octopus Energy unit rate (pence/kWh incl. VAT); populated only when `electricity_tariff_octopus` is set. |
| `otedama_electricity_tariff_forward_min_pence_per_kwh` | gauge | — | Minimum unit price across the fetched forward Agile curve (~24h of half-hourly slots) — the cheapest upcoming slot. |
| `otedama_electricity_tariff_forward_max_pence_per_kwh` | gauge | — | Maximum unit price across the fetched forward Agile curve — alert when it exceeds `curtail_above_tariff_pence` for lead time on a coming curtail window. |

**Payout (non-custodial transparency)**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_payout_active_index` | gauge | — | 0-based index of the active payout address in the failover list. |
| `otedama_payout_info` | gauge | `address=<masked>` | Active payout destination; the series valued 1 is the address currently receiving rewards. |

**Health & liveness**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_up` | gauge | — | 1 if healthy (hashing, or intentionally curtailed), 0 if stalled. |
| `otedama_curtailed` | gauge | — | 1 if hashing is paused by any curtailment gate (`curtail_below_btc_usd`, `thermal_throttle_above_celsius`, and/or `curtail_above_uk_carbon`), else 0. |
| `otedama_uk_grid_carbon_intensity` | gauge | — | GB grid carbon intensity forecast (gCO2/kWh, 10-min poll); populated only when `curtail_above_uk_carbon` is set. |
| `otedama_productive_seconds_total` | counter | — | Cumulative seconds the miner actually produced hashrate (effective-uptime numerator). |
| `otedama_clock_skew_seconds` | gauge | — | Max \|local − server\| clock offset from rate-source HTTP Date headers (alert >120). |
| `otedama_uptime_seconds` | gauge | — | Seconds since engine start. |
| `otedama_start_time_seconds` | gauge | — | Unix timestamp at which engine started. |
| `otedama_build_info` | gauge | `version,commit,goversion` | Constant 1; build metadata carried as labels. |

### `GET /`

Minimal HTML landing page linking to the endpoints. Useful for
human operators verifying the server is up.

### `GET /debug/pprof/*`

Only mounted when `--pprof` is passed — serves the standard Go pprof handlers
(`index`, `cmdline`, `profile`, `symbol`, `trace`, plus `heap`/`goroutine`/etc.
under `/debug/pprof/<name>`). Intended for loopback/private binds.

### `GET /arbitration`

Latest arbitration `DecisionSnapshot` as indented JSON — one row per
device with the selected stream, expected yield, the Holt-Winters
one-step forecast ± error scale, the Beta-Bernoulli provider reliability
posterior (mean, α, β), and the held/switch/foregone detail
(ADR-010 A9). Rows may also carry `foregone_stream` (the declined
argmax stream), `foregone_expected_sats_per_sec` and
`switched_from_expected_sats_per_sec` (that stream's current
confidence-adjusted quote), and `alt_forecast_sigma_sats_per_sec` (the
alternative's forecast error scale) — the inputs the rendered
"Reasoning:" block is built from. A held row additionally carries
`awaiting_confirmation` when the suppressed candidate was an
unconfirmed stream (ADR-010 A7 confirmation ladder). Rows carry
`simulated` when the chosen stream quotes modeled rather than
live-market yield — rendered as "(sim)" on the stream column so
simulated revenue stays visually distinct from real earnings. The
snapshot header echoes the active `income_mode` (`max`/`smooth`/`balanced` —
ADR-010 A5) alongside policy, hysteresis, and the min-yield floor.
Served by `otedama arb explain` for terminal rendering.

- `200 OK` — snapshot JSON.
- `503 Service Unavailable` — the engine has not recorded its first
  decision tick yet.

---

## Service-level objectives (SLO)

Operational targets that make the metrics above actionable. "Breach" means
the metric stayed outside target long enough to cost shares or revenue —
a single bad sample during a reconnect or rate-fetch gap is expected.

| Objective | Metric(s) | Target | On breach |
|-----------|-----------|--------|-----------|
| Pool session healthy | `otedama_up` | 1 continuously | Check hashrate, pool difficulty, network path; `otedama_last_job_received_seconds` for a stale conn. |
| Productive uptime | `otedama_productive_seconds_total` ÷ `otedama_uptime_seconds` | ≥ 0.99 over any 24 h window | Check `otedama_curtailed` (intentional pause is fine), reconnect count, `otedama_devices_idle`. |
| Share acceptance | `otedama_reject_rate` | < 0.005 excellent; > 0.03 investigate | Break down by `otedama_shares_rejected_by_reason_total` (`stale` = latency, `difficulty-change` = benign generation boundary, others = pool). |
| Stale fraction | `otedama_stale_rate` | < 0.005 | Submit path too slow for the pool's stale window — pick a closer pool. |
| Submit latency | `otedama_submit_latency_milliseconds{quantile=0.95}` | < 200 ms; p99 < 1000 ms | Above ~200 ms risks stale rejects (pool stale thresholds are typically 1–2 s). |
| Unaccounted shares | `otedama_shares_unaccounted` | drains to <8 within one stats tick | The engine warns when ≥8 persists for 3 ticks — submissions are being silently dropped; check connection state and `otedama_shares_submitted_total` vs `otedama_shares_total`. |
| Live revenue streams | `otedama_active_streams` | ≥ 1 while a market is up | 0 means every provider went 3 min without a quote — check provider reachability/logs. |
| Rate freshness | `otedama_btc_rate_age_seconds` | < 300 | Rate loop stalled; `otedama_rate_sources_ok` shows how many sources still answer. |
| Clock skew | `otedama_clock_skew_seconds` | \|skew\| < 120 | Fix NTP — skew breaks rate-freshness accounting and HTTPS cert validation. |

These are single-operator SLOs, not contractual guarantees: CPU-only
mining earnings are near-zero by hardware economics, so the productive-
uptime objective measures whether Otedama itself is healthy, not whether
mining is profitable.

---

## Wallet file format

Path: `{data-dir}/wallet.dat`
Permissions: `0600` (owner read/write only). Violation detected by
`otedama doctor`.

Format (`internal/lightning/seedstore.go`: `EncryptedSeed.Marshal`), a flat
concatenation with no internal length prefixes:

1. Version byte (`0x01`).
2. 16-byte scrypt salt.
3. 12-byte AES-GCM nonce.
4. Ciphertext: AES-256-GCM encrypted BIP-39 seed (64 bytes plaintext);
   the GCM authentication tag is appended by `cipher.AEAD.Seal` as part
   of this ciphertext, not stored as a separate field.

The scrypt parameters (N=2^17, r=8, p=1) are fixed constants in code,
not serialized to disk.

The mnemonic is derived from the seed and is never stored on disk.
**The mnemonic is only displayed once, on first run.**

On first run, when stdin is an interactive terminal, Otedama then runs a
backup check: the operator is asked to re-enter 3 randomly chosen words
(one retry with different words after a miss). A failure prints a loud
warning but does not block startup — the wallet is already created and
mining may proceed while the written copy is re-checked. Piped,
redirected, or service-managed stdin skips the check silently;
`--no-wallet-backup-check` disables it on interactive terminals.

---

## Exit behaviour

Otedama performs graceful shutdown on receiving:

- `SIGINT` (Ctrl+C) on Unix / `CTRL_C_EVENT` on Windows.
- `SIGTERM` on Unix / service stop on Windows.

Shutdown sequence:

1. Cancel root context.
2. Stop workers (finish current hash batch).
3. Flush pending share submissions to the pool.
4. Close pool connection cleanly.
5. Fire `OnReady(false)` to HTTP server.
6. Shutdown HTTP server (up to 5 seconds for in-flight requests).
7. Exit with code 0.

If a second SIGINT arrives during shutdown, Otedama exits immediately
with code 130 (standard interrupt exit).

---

## Go API stability

Packages under `internal/` are not covered by stability guarantees.
They may change between minor versions.

The only stable public surface is the `otedama` binary's CLI and
configuration, documented above. To embed Otedama functionality in
another Go program, vendor the relevant `internal/` package into your
own module.
