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
| `--no-tui` | bool | `false` | Disable the terminal dashboard. |
| `--wallet-passphrase` | string | (empty) | Passphrase to unlock/create the Lightning wallet. Empty = skip wallet. |
| `--http-addr` | string | (empty) | HTTP address for metrics/health endpoints. Empty = disabled. |
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

- `otedama config show [--config path]` — Print the merged configuration
  (defaults + file + env + flags).
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
otedama doctor [--config path] [--bitcoin-address addr] [--data-dir path]
```

**Exit codes:**
- `0` — All checks passed.
- `1` — At least one check emitted a warning.
- `2` — At least one check failed.

Suitable as a container healthcheck command:
```yaml
healthcheck:
  test: ["CMD", "otedama", "doctor"]
```

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

# Mining pools (tried in order).
pools:
  - url: stratum+v2://public.stratum.slushpool.com:3336
    priority: 1
  - url: stratum+v2://demand.sv2.io:34254
    priority: 2

# Worker configuration.
workers:
  - name: cpu-worker
    device: cpu
    # threads defaults to runtime.NumCPU(). Set explicitly to cap CPU use.
```

**Precedence of configuration sources** (highest wins):

1. Command-line flags.
2. Environment variables (`OTEDAMA_*`).
3. Configuration file.
4. Built-in defaults.

---

## Environment variables

All environment variables are prefixed `OTEDAMA_`.

| Variable | Equivalent flag | Notes |
|----------|-----------------|-------|
| `OTEDAMA_CONFIG` | `--config` | Path to config file. |
| `OTEDAMA_BITCOIN_ADDRESS` | `--bitcoin-address` | |
| `OTEDAMA_DATA_DIR` | `--data-dir` | |
| `OTEDAMA_LOG_LEVEL` | `--log-level` | |
| `OTEDAMA_LOG_FORMAT` | `--log-format` | |
| `OTEDAMA_LANGUAGE` | `--language` | |
| `OTEDAMA_WALLET_PASSPHRASE` | `--wallet-passphrase` | Preferred over flag in production — flag is visible in process lists. |
| `OTEDAMA_HTTP_ADDR` | `--http-addr` | |

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
| `otedama_shares_unaccounted` | gauge | — | Found locally but not yet judged (found − accepted − rejected, clamped ≥0). A sustained value means shares are not reaching the pool. |
| `otedama_shares_rejected_by_reason_total` | counter | `reason={stale,duplicate,difficulty,hardware,other}` | Rejections by inferred root cause. |
| `otedama_last_reject_seconds` | gauge | `reason=…` | Unix timestamp of the most recent rejection of each category (distinguishes ongoing from cleared problems). |
| `otedama_share_acceptance_rate` | gauge | — | Accepted / judged (1.0 = all accepted). |
| `otedama_reject_rate` | gauge | — | Rejected / judged (complement of acceptance; >0.03 investigate). |
| `otedama_stale_rate` | gauge | — | Stale-rejected / judged (network-latency signal). |
| `otedama_submit_latency_milliseconds` | gauge | `quantile={0.5,0.95,0.99}` | Submit→accept round-trip latency. |

**Pool & connection**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_pool_connect_attempts_total` | counter | — | Pool dial attempts, including reconnects. |
| `otedama_pool_connect_failures_total` | counter | — | Pool dial failures. |
| `otedama_pool_connection_state` | gauge | — | 0=disconnected, 1=connecting, 2=connected. |
| `otedama_pool_active_index` | gauge | — | 0-based index of the active pool in the failover list. |
| `otedama_pool_difficulty` | gauge | — | Current share difficulty (`mining.set_difficulty`). |
| `otedama_estimated_share_interval_seconds` | gauge | — | Expected seconds between shares (difficulty × 2³² / hashrate). |
| `otedama_last_job_received_seconds` | gauge | — | Unix timestamp of the most recent pool job (stale-connection detector). |

**Arbitration**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_arbitration_switches_total` | counter | — | Workload reroutes by the arbitration engine. |
| `otedama_arbitration_holds_total` | counter | — | Decisions where a higher-yielding stream existed but hysteresis kept the current one. |
| `otedama_arbitration_foregone_sats_per_second` | gauge | — | Instantaneous opportunity cost: raw sats/s sacrificed versus pure yield routing, summed across devices (hysteresis holds + non-earnings policy preferences). The magnitude companion to `_holds_total`. |
| `otedama_arbitration_expected_yield_sats_per_second` | gauge | — | The engine's forecast earning rate (summed ExpectedYield of the chosen allocation). Compare against realized earnings to judge quote accuracy; × BTC rate for expected $/day. |
| `otedama_active_streams` | gauge | — | Live revenue streams after pruning stale (dead-provider) quotes. |

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

**Payout (non-custodial transparency)**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_payout_active_index` | gauge | — | 0-based index of the active payout address in the failover list. |
| `otedama_payout_info` | gauge | `address=<masked>` | Active payout destination; the series valued 1 is the address currently receiving rewards. |

**Health & liveness**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `otedama_up` | gauge | — | 1 if healthy (hashing, or intentionally curtailed), 0 if stalled. |
| `otedama_curtailed` | gauge | — | 1 if hashing is paused by `curtail_below_btc_usd`, else 0. |
| `otedama_productive_seconds_total` | counter | — | Cumulative seconds the miner actually produced hashrate (effective-uptime numerator). |
| `otedama_clock_skew_seconds` | gauge | — | Max \|local − server\| clock offset from rate-source HTTP Date headers (alert >120). |
| `otedama_uptime_seconds` | gauge | — | Seconds since engine start. |
| `otedama_start_time_seconds` | gauge | — | Unix timestamp at which engine started. |
| `otedama_build_info` | gauge | `version,commit,goversion` | Constant 1; build metadata carried as labels. |

### `GET /`

Minimal HTML landing page linking to the three endpoints. Useful for
human operators verifying the server is up.

---

## Wallet file format

Path: `{data-dir}/wallet.dat`
Permissions: `0600` (owner read/write only). Violation detected by
`otedama doctor`.

Format: length-prefixed binary blob containing:

1. Version byte (`0x01`).
2. scrypt parameters (N, r, p as u32).
3. 32-byte salt.
4. 12-byte AES-GCM nonce.
5. Ciphertext: ChaCha20-Poly1305 encrypted BIP-39 seed (64 bytes).
6. 16-byte GCM authentication tag.

The mnemonic is derived from the seed and is never stored on disk.
**The mnemonic is only displayed once, on first run.**

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
