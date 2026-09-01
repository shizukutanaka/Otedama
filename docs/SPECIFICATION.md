# Otedama — Specification (v3.0.0-alpha.1)

This document specifies the *observable behaviour* of Otedama as it is
actually implemented on this branch. It is descriptive (matches the code),
not aspirational — forward-looking work lives in `ROADMAP.md`, and honest
shortfalls in `docs/KNOWN_LIMITATIONS.md`. The product definition and
design principles are normative in `CLAUDE.md`.

The final section, **Gaps found while writing this spec**, lists concrete
discrepancies between intended and actual behaviour, with their status.

---

## 1. Product scope

Otedama is a non-custodial, Stratum-V2-first software suite that arbitrates
user-owned ASIC/GPU/CPU hardware across Bitcoin mining (real) and AI-inference
provision (not implemented — the simulated placeholder was deleted;
see KNOWN_LIMITATIONS §1). Bitcoin only
(SHA-256d); no custody of others' funds; no token issuance. (CLAUDE.md.)

## 2. Command-line interface

```
otedama <command> [flags]
```

| Command | Behaviour |
|---|---|
| `run` | Detect hardware, optionally create a Lightning wallet, connect to a pool, and mine. |
| `version [--json]` | Print version/commit/build-date/go-version/platform; `--json` emits the `version.Info` object. |
| `config show` | Print the **effective** configuration after layering (see §3). |
| `config validate` | Validate the effective configuration; print `configuration is valid` or the issues. |
| `service install\|uninstall\|status` | Manage the background service (systemd/launchd/Task Scheduler). |
| `doctor [--json]` | Run self-diagnostic checks. `--json` emits a machine-readable report; there is no `--log-level` on this subcommand, and no global flags precede the subcommand name. |
| `wallet verify` | Read a recovery phrase from stdin (never echoed) and report whether it reproduces the stored wallet's seed, compared in constant time. Refuses when no wallet exists. |
| `wallet change-passphrase` | Re-encrypt the stored seed under a new passphrase. The fingerprint before and after must match, or the change is rejected. |
| `completion bash\|zsh\|fish` | Emit a shell-completion script. |
| `help` / `--help` / `-h` | Print usage. |

### 2.1 Exit-code contract

| Code | Name | Meaning |
|---|---|---|
| `0` | OK | Success. |
| `1` | runtime | Runtime failure after a valid start (e.g. unrecoverable session error). |
| `64` | usage | Bad/unknown command, flag, or argument (`EX_USAGE`). |
| `78` | config | Invalid configuration (`EX_CONFIG`). |

Scripts may rely on these. `run` returns `78` if the resolved config fails
validation, `64` for flag-parse errors, `1` for a runtime error, `0` on clean
shutdown (SIGINT/SIGTERM).

## 3. Configuration

### 3.1 Schema

Every field, its YAML key, the environment variable that overrides it (if any),
its default, and its validation rule:

| YAML key | Env var | Default | Validation |
|---|---|---|---|
| `bitcoin_address` | `OTEDAMA_BITCOIN_ADDRESS` | `""` | plausible mainnet address (see §3.3) |
| `bitcoin_addresses` (failover list) | — (file only) | `nil` | each entry a plausible mainnet address |
| `pools[].url` | — (file only) | one built-in fallback endpoint (`config.DefaultPoolURL`) — not a curated list, and its host does not currently resolve (KNOWN_LIMITATIONS §20) | supported scheme + non-empty host (§3.3) |
| `pools[].user` | — (file only) | `""` | overrides the Stratum `user_identity` when set |
| `pools[].password` | — (file only) | `""` | V1-only; unused by the V2 transport |
| `pools[].payout_scheme` | — (file only) | `""` | empty, or one of `fpps`/`pplns`/`tides`/`solo` |
| `pools[].tls_ca_file` | — (file only) | `""` | readable PEM file; honoured only for `stratum+tls://` |
| `workers.name` | — (file only) | `""` | appended as `.name` to the `user_identity` |
| `language` | `OTEDAMA_LANGUAGE` | `""` → POSIX-locale fallback | — |
| `log_level` | `OTEDAMA_LOG_LEVEL` | `info` | ∈ {debug, info, warn, error} |
| `log_format` | `OTEDAMA_LOG_FORMAT` | `text` | ∈ {text, json} |
| `data_dir` | `OTEDAMA_DATA_DIR` | `""` → XDG/platform convention | absolute path (no `~` expansion) |
| `arbitration_hysteresis_pct` | `OTEDAMA_ARBITRATION_HYSTERESIS_PCT` | `0.05` | ∈ [0.0, 1.0) |
| `curtail_below_btc_usd` | `OTEDAMA_CURTAIL_BELOW_BTC_USD` | `0` (disabled) | ≥ 0 |
| `min_yield_sats_per_sec` | `OTEDAMA_MIN_YIELD_SATS_PER_SEC` | `0` (disabled) | ≥ 0 |
| `power_watts` | `OTEDAMA_POWER_WATTS` | `0` (disabled) | ≥ 0 |
| `electricity_price_per_kwh` | `OTEDAMA_ELECTRICITY_PRICE_PER_KWH` | `0` (disabled) | ≥ 0 |
| `http_addr` | `OTEDAMA_HTTP_ADDR` | `""` (HTTP server disabled) | also settable via `--http-addr`; when set, serves `/metrics`, `/healthz`, `/readyz` |

The path to the config file itself is resolved from `--config`, then
`OTEDAMA_CONFIG`, then the platform default (`~/.config/otedama/config.yaml`).

### 3.2 Precedence

**Highest → lowest:** flags → environment → config file → built-in defaults.
The address failover **list** (`bitcoin_addresses`) and all `pools[]` fields are
config-file-only; flags/env set only the primary address and the scalar
log/language/data-dir/power/arbitration fields. A malformed numeric env var
(e.g. `OTEDAMA_POWER_WATTS=300w`) is reported, not silently dropped.

### 3.3 Validation rules

At least one payout address is required (primary or a backup); every address
must be a plausible mainnet address (length 26–90, prefix `1`/`3`/`bc1`;
checksum is *not* verified here). Each `pools[].url` must use a supported scheme
(`stratum+tcp|tls|v2|v2tls://`) with a non-empty host. The numeric fields are
range-checked per the table above. An empty/comments-only file is valid
(defaults apply).

`config show` prints **all** effective fields — including the failover
addresses, the power/arbitration/curtailment fields, `worker_name`, and the
configured pool URLs — each tagged with the layer it was resolved from.

## 4. Mining session lifecycle

1. **Resolve + validate** config; abort with exit 78 on failure.
2. **Detect devices** (CPU always; GPU via Linux DRM sysfs — Linux-only,
   KNOWN_LIMITATIONS §4).
3. **Optional wallet** (only if `--wallet-passphrase` given): BIP-39 seed,
   scrypt+AES-GCM encrypted at rest, receive-only (KNOWN_LIMITATIONS §6).
4. **Reconnect loop** (`runReconnectLoop`):
   - Ordered pool list (`poolURLs`) and ordered payout-address list
     (`payoutAddresses`: primary first, de-duplicated, empties skipped).
   - For each attempt: dial TCP → Stratum V2 handshake (SetupConnection +
     OpenMiningChannel) → on success the address is marked *known-good*.
     The channel's `user_identity` is the per-pool `User` if set, otherwise
     the active payout address, suffixed with `.worker` when `Workers.Name`
     is configured.
   - **Pool failover (fast):** on session failure, advance to the next pool
     immediately; back off only after every pool has been tried.
   - **Payout-address failover (slow, safe):** rotate to the next address
     **only while the active address has never established a session**. A
     known-good address is never abandoned, and no session establishes during
     an outage, so an outage cannot silently redirect earnings.
   - **Backoff:** exponential from `reconnectBackoffInitial` to
     `reconnectBackoffMax`; honoured between full cycles.
5. **In-session:** decode frames; apply `NewMiningJob` to workers — workers
   grind to the pool-assigned **share target** from `OpenMiningChannelSuccess`
   (far easier than the block target; the block target is used only as a
   fallback when the pool assigns none); submit found shares
   (`SubmitSharesStandard`); on `SubmitSharesSuccess` settle
   submit→accept latency and increment accepted; on `SubmitSharesError`
   classify the reason (`rejectClass` → stale/duplicate/difficulty/hardware/
   other) and increment the per-reason counter.
6. **Graceful shutdown** on SIGINT/SIGTERM.

## 5. Transport (Stratum V2)

Binary frame layer (`internal/stratum`): 6-byte header (u16 ext_type, u8
msg_type, u24 msg_length). The declared length is checked against
`MaxFrameSize` (default 16 MiB) *before* the payload buffer is allocated, so a
malicious peer cannot trigger a large allocation by announcing a huge frame.
(The u24 length is structurally incapable of overflowing a 64-bit `int`, the
project's only supported word size, so no separate overflow guard is needed.)
Noise NX transport encryption (ChaCha20-Poly1305, SHA-256) is implemented in
this package but **is not reachable from any live connection**: the engine's
`stratum+v2://` path dials a plain `net.Dialer` and speaks Stratum V2 in the
clear, so a `stratum+v2://` session has no transport encryption at all — the
payout address travels in plaintext (KNOWN_LIMITATIONS §2). `stratum+v2tls://`
and `stratum+tls://` do get real TLS, from a different code path, with
certificate verification never disabled. Within the unreachable Noise code the
DH primitive is **P-256**, not the spec-mandated secp256k1 + ElligatorSwift
(ADR-011). The
encrypted-frame codec is u16-length-prefixed, rejects oversize writes, and
buffers partial reads so no plaintext is dropped (session 53).

## 6. Metrics (`/metrics`, Prometheus text format, no client dependency)

All product metrics carry the `otedama_` prefix (omitted below). Metrics
registered at startup always appear; lazily-created series (marked †) appear
only after the first relevant event, with a bounded label set. HTTP endpoints:
`/metrics`, `/healthz`, `/readyz`, `/`.

`/metrics` also exposes twelve standard Go runtime series — `go_goroutines`,
`go_info{version}`, `go_memstats_*`, `go_gc_*` — under the names
`prometheus/client_golang` uses, so existing Grafana panels work unmodified.
They are produced by `metrics.RuntimeCollector()`, documented in that
package's godoc, and are outside the `otedama_` catalogue below (and outside
the CI check that enforces it). They were registered by nothing until session
266; see ADR-005's erratum.

**Shares & rejects**

| Metric | Type | Meaning |
|---|---|---|
| `shares_found_total` | counter | Shares found locally by all workers. |
| `device_shares_found_total{device}` † | counter | Per-device breakdown of shares found. |
| `shares_submitted_total` | counter | Shares actually transmitted to the pool, counted at send time regardless of the eventual accept/reject response. Distinct from `shares_found_total`: a found share is never submitted if its worker's share channel was full. |
| `shares_total{status}` | counter | Shares judged by the pool (`accepted`/`rejected`). |
| `shares_rejected_by_reason_total{reason}` † | counter | Rejects by inferred cause (stale/duplicate/difficulty/hardware/other). |
| `last_reject_seconds{reason}` † | gauge | Unix time of the most recent reject in each category. |
| `shares_unaccounted` | gauge | Found locally but not yet judged (found−accepted−rejected, ≥0). |
| `share_acceptance_rate` | gauge | accepted / judged. |
| `reject_rate` | gauge | rejected / judged. |
| `stale_rate` | gauge | stale-rejected / judged. |
| `submit_latency_milliseconds{quantile}` | gauge | submit→accept RTT at q=0.5/0.95/0.99. Note: milliseconds, not the seconds base unit used by every other time metric — see §8 G18. |

**Hashrate, health & power**

| Metric | Type | Meaning |
|---|---|---|
| `hashrate_hashes_per_second` | gauge | Current aggregate hashrate. |
| `up` | gauge | 1 = healthy (hashing or curtailed), 0 = stalled when it should hash. |
| `curtailed` | gauge | 1 = paused below `curtail_below_btc_usd`, else 0. |
| `productive_seconds_total` | counter | Wall-clock seconds actually producing hashrate. |
| `power_watts` | gauge | Configured system draw (0 = unset). |
| `joules_per_terahash` | gauge | watts × 1e12 / hashrate (0 = power unset). |
| `power_cost_usd_per_hour` | gauge | watts/1000 × price/kWh (0 = unset). |
| `uptime_seconds` | gauge | Seconds since engine start. |
| `start_time_seconds` | gauge | Unix start timestamp. |

**Pool & payout**

| Metric | Type | Meaning |
|---|---|---|
| `pool_connect_attempts_total` | counter | Connection attempts incl. reconnects. |
| `pool_connect_failures_total` | counter | Connection failures. |
| `pool_connection_state` | gauge | 0=disconnected, 1=connecting, 2=connected. |
| `pool_active_index` | gauge | 0-based index of active pool in the failover list. |
| `pool_difficulty` | gauge | Current pool-assigned share difficulty. |
| `estimated_share_interval_seconds` | gauge | difficulty × 2³² / hashrate. |
| `last_job_received_seconds` | gauge | Unix time of the most recent job. |
| `payout_active_index` | gauge | 0-based index of active payout address. |
| `payout_info{address}` † | gauge | Active (masked) payout destination = 1. |
| `build_info{version,commit,goversion}` | gauge | Constant 1; build metadata in labels. |

**Arbitration & rates**

| Metric | Type | Meaning |
|---|---|---|
| `arbitration_switches_total` | counter | Workload switches (mining ↔ AI). |
| `arbitration_holds_total` | counter | Better stream existed but hysteresis held. |
| `arbitration_foregone_sats_per_second` | gauge | Instantaneous opportunity cost of the held allocation. |
| `arbitration_expected_yield_sats_per_second` | gauge | Engine forecast earning rate. |
| `effective_yield_sats_per_second` | gauge | `arbitration_expected_yield_sats_per_second` × lifetime productive fraction (`productive_seconds_total / uptime_seconds`) — folds downtime into a single gross-minus-losses estimate. |
| `active_streams` | gauge | Live revenue streams after stale-pruning. |
| `devices_idle` | gauge | Devices left idle this cycle (no compatible stream, or none clearing `min_yield_sats_per_sec`). |
| `btc_usd_rate` | gauge | BTC/USD from source consensus (last good value). |
| `btc_rate_age_seconds` | gauge | Seconds since the last successful rate fetch. |
| `rate_sources_ok` / `rate_sources_total` | gauge | Healthy vs configured price sources. |
| `clock_skew_seconds` | gauge | Max offset vs rate-source HTTP `Date` headers. |

## 7. Known limitations

Authoritative list in `docs/KNOWN_LIMITATIONS.md`. Still open as of session
266: Noise NX is wired into no live connection, so `stratum+v2://` is
plaintext (§2); GPU detection is Linux-only and no compute dispatch exists,
so a detected GPU is given no work (§4); Lightning is receive-only, with no
embedded node (§6); ASIC hardware is not detected at all (§8); several CI
workflows are non-functional (§13); `datum://` is a reserved scheme with no
dialer (§14); the built-in default pool host does not resolve, so a pool
must be configured (§20); CI has no SHA-pinned actions, signed releases, or
`govulncheck` (§21); and the mining thread count cannot be set from inside
the product (§22).

Resolved since the earlier revision of this list: the simulated
AI-inference yield was deleted rather than disclosed (§1), the post-quantum
scaffolding was removed as unreachable (§5), the engine now routes through
`poolproto` (§3), the TUI detects the real terminal width on Linux (§15),
**both halves of §16 are closed** — `otedama wallet verify` for backup
verification and `otedama wallet change-passphrase` for rotation, the latter
of which an earlier revision of this section still listed as open — and a
non-ASCII BIP-39 passphrase is refused rather than silently producing a
non-portable wallet (§19).

---

## 8. Gaps found while writing this spec

| # | Gap | Status |
|---|---|---|
| G1 | `config show` omitted the failover addresses, `log_format`, `worker_name`, and the actual pool URLs (showed only a count) — it did not show the *effective* configuration as documented. | **Fixed this session** (session 57): `config show` now prints all effective fields incl. `bitcoin_addresses` and pool URLs. |
| G2 | The exit-code contract was defined in code but undocumented for scripting. | **Fixed (session 57)**: documented in §2.1. |
| G11 | `otedama_btc_usd_rate` was registered and listed in §6 but never `Set` — the rate fetcher ran and exposed `BTCUSDRate()`, yet the gauge stayed at 0, so a dashboard/alert on BTC price saw nothing. | **Fixed (session 62)**: a publisher copies the fetcher's rate (its fallback before the first fetch, then live medians) into the gauge on a 30s cadence. |
| G10 | `/readyz` reported ready as soon as the process started (`OnReady(true)` fired before any pool connection), contradicting its documented "ready only if pool connected" semantics — a k8s readiness probe would treat a miner that can reach no pool as ready. | **Fixed (session 61)**: readiness is now driven from the session lifecycle — `OnReady(true)` on handshake completion, `OnReady(false)` on disconnect/shutdown — so `/readyz` tracks an actual pool connection and flips back when it drops. |
| G9 | `doctor` validated only the primary `bitcoin_address`, not the session-56 `bitcoin_addresses` failover list — a typo in a backup went uncaught by the diagnostic tool. | **Fixed (session 60)**: added a "Failover payout addresses" check that validates every entry (skips when none configured, fails on any malformed entry). |
| G8 | `log_format` from the config file/env was silently ignored: `--log-format` bound to a standalone flag with a non-empty `"text"` default and the logger read the flag, not the resolved `cfg.LogFormat` — and `Validate` never checked it. | **Fixed (session 59)**: `--log-format` now binds to `FlagValues.LogFormat` (empty default → correct flag>env>file>default precedence), `buildLogger` uses `cfg.LogFormat`, and `Validate` rejects values outside {text,json}. |
| G7 | `PoolConfig.User` and `Workers.Name` were documented config fields the engine never read — the Stratum user_identity was always the bare payout address. | **Fixed (session 58)**: `sessionUser` now honours an explicit per-pool `User`, else uses `address.worker` when `Workers.Name` is set, else the address. `PoolConfig.Password` is documented as V1-only/unused (no password in the V2 transport). |
| G12 | `service install` accepted `--bitcoin-address` / `--log-level` / `--log-format` / `--language` flags at the CLI but `daemon.Manager` never stored or emitted them — the installed service unit started without a payout address and exited 78. | **Fixed (session 63)**: `daemon.ServiceFlags` struct added; all four flags are forwarded to `Manager` and emitted by `serviceArgs()` into the systemd unit / launchd plist / Windows service command line. |
| G13 | The Stratum V1 session silently ignored `client.reconnect` / `mining.reconnect` — the standard directive every major pool (Braiins/F2Pool/AntPool/ViaBTC/NiceHash) and client (cgminer/bfgminer/ESP-Miner) uses to move a miner to another node. Otedama held the connection until the socket died or the 5-minute read deadline fired, wasting connect time and shares. | **Fixed (session 64)**: `parseReconnect` decodes `[host,port,wait]`; on receipt the session records the directive and closes cleanly so `Jobs()` closes and the reconnect loop re-dials. The pool-supplied `host:port` is recorded but deliberately **not** followed (redirection-vector guard for a non-custodial miner). Grounded in RESEARCH_IMPROVEMENTS session-51 Cat 1/2 #5. |
| G14 | The stall monitor (`HashrateMonitor`, floor 0 H/s) was fed a *lifetime-average* hashrate (`HashesTotal/Uptime`), which stays positive forever after the first hash — so a device that wedges after running could never trip the stall warning, and `otedama_up`/`otedama_hashrate` reported lifetime, not current, values. | **Fixed (session 65)**: `hashrateWindow` differentiates the cumulative hash counter into a current (Δ/interval) rate consumed by the monitor, gauge, log, and TUI. Saturating on counter reset (reconnect) — no negative/NaN/spurious-spike readings. Grounded in RESEARCH_IMPROVEMENTS session-51 Cat 1/2 #6. |
| G15 | The miner ground against the **block target** (`TargetFromNBits(job.NBits)`) and discarded the pool-assigned **share target** (`OpenMiningChannelSuccess.Target`), so a worker emitted a share only on an actual block solve — effectively never on a live pool. No shares submitted ⇒ no credited work, no payout, no vardiff feedback. The integration test masked it with an easy block nBits and never asserted shares were submitted. | **Fixed (session 66)**: `handshake` returns the channel share target; `updateWork` grinds to it (block-target fallback only when the pool assigns none). Integration test now asserts `pool.SharesReceived() >= 1`. Grounded in RESEARCH_IMPROVEMENTS session-51 Cat 1/2 (#2/#4). |
| G16 | This spec's §3 documented only 8 of the 16 config fields — the power-awareness (`power_watts`, `electricity_price_per_kwh`), arbitration/curtailment (`arbitration_hysteresis_pct`, `curtail_below_btc_usd`), and per-pool (`payout_scheme`, `tls_ca_file`) fields were all live, validated, and printed by `config show`, yet absent from the spec; the 4 numeric `OTEDAMA_*` env vars and the range-validation rules were also undocumented. | **Fixed this session** (session 190): §3 rewritten as a complete schema table (key, env var, default, validation) plus precedence and validation subsections. |
| G17 | §6 listed 17 metrics, but the engine registers ~39 — the entire power/efficiency, rate-redundancy, clock-skew, pool-difficulty, per-device, payout-info, and arbitration-economics families were exposed at `/metrics` but undocumented, so an operator building dashboards/alerts could not discover them from the spec. | **Fixed this session** (session 190): §6 replaced with the full catalogue grouped by purpose (shares/rejects, hashrate/health/power, pool/payout, arbitration/rates), with type and lazy-creation (†) notes. |
| G3 | Engine bypasses the `poolproto` dialer abstraction (inline handshake). | Open — KNOWN_LIMITATIONS §3; deferred (would regress submit-latency/reject telemetry until `poolproto.Session` is extended — see CHANGELOG session 55). |
| G4 | Noise NX DH uses P-256, not secp256k1 + ElligatorSwift. | Open — KNOWN_LIMITATIONS §2; decided in ADR-011, implementation pending the dependency. |
| G5 | AI-inference yield was simulated (no live Akash API) yet fed the arbitration engine, the TUI's headline sats/day figure, and the expected-yield gauge. | **Resolved by deletion (session 264)**: the simulated provider was removed from the product rather than disclosed, since a disclaimer beside the provider name did not mark the number users actually read. The `Provider` interface, `RateSource`, polling lifecycle, and multi-stream arbitration remain for a real integration (ROADMAP v3.1.0; integration surface catalogued in RESEARCH_IMPROVEMENTS session-51 #11, session-52 #3). |
| G6 | GPU detection is Linux-only. | Open — KNOWN_LIMITATIONS §4. |
| G18 | `otedama_submit_latency_milliseconds` is the only time-valued metric expressed in milliseconds; the other eight (`uptime_seconds`, `start_time_seconds`, `clock_skew_seconds`, `btc_rate_age_seconds`, `last_job_received_seconds`, `last_reject_seconds`, `estimated_share_interval_seconds`, `productive_seconds_total`) use seconds. Prometheus naming guidance mandates base units (seconds), so the conventional name would be `otedama_submit_latency_seconds` with values in seconds. The stored value is genuinely milliseconds (`run.go` records `Sub(sent).Microseconds()/1000` and `Since(sendTime).Milliseconds()`), so the current name is *accurate* but non-idiomatic and inconsistent with the rest of the catalogue. | Open — **breaking rename**: any operator dashboard/alert keyed on the metric name or its ms scale would break. Recorded for a maintainer decision rather than changed unilaterally (options: rename to `_seconds` + divide by 1000 in one release; or expose a parallel `_seconds` series and deprecate the ms one). |
| G19 | Despite G16's "complete schema table" fix (session 190), `http_addr` (`OTEDAMA_HTTP_ADDR` / `--http-addr`) — settable, validated, and printed by `config show` since before that session — was never added to the §3.1 table. | **Fixed (session 244)**: added the missing `http_addr` row (env var, default, and the endpoints it gates). |
| G20 | The Stratum V1 mining path could not produce a creditable share. V1 delegates merkle-root construction to the miner (coinbase halves + branch), which Otedama never did, so every job carried a zero merkle root; `applyJob` additionally dropped the header's version and prev-hash, the notify prev-hash word order was never converted, arbitrary-string job IDs were rejected by a `Sscanf("%d")` round trip, and `mining.submit` sent a hardcoded worker name with an extranonce2 unrelated to any coinbase. The same defect class G15/§11 closed for Stratum V2, on the protocol >99% of pools actually speak. | **Fixed (session 255)**: miner-side coinbase/merkle construction in `internal/poolproto/stratumv1/work.go` with byte orders taken verbatim from cpuminer (client) and node-stratum-pool (pool) and verified against real block data; per-job extranonce2 recorded and echoed on submit; authorised worker name reused; job-ID strings carried end-to-end as `miner.Work.JobKey`. See KNOWN_LIMITATIONS §17. |
| G21 | The Stratum V2 handshake did not match the wire specification: `SetupConnection` omitted `endpoint_port` (and callers passed `"host:port"` as the host), `OpenStandardMiningChannel` omitted the mandatory `max_target` U256, `OpenStandardMiningChannel.Success` decoded a V1-style `extranonce2_size` U16 where the spec has `group_channel_id` U32, `SubmitShares.Error` used the Reserved msg_type `0x1e` instead of `0x1d` (so pool rejections were silently dropped), and `SubmitShares.Success.new_shares_sum` was U32 instead of U64. The engine also applied `SetTarget` to a job that arrived with `min_ntime` set, which §5.3.21 excludes. Round-trip tests could not catch any of it. | **Fixed (session 256)**: all six corrected against `stratum-mining/sv2-spec`; `internal/stratum/conformance_test.go` now pins absolute field offsets, payload lengths, and msg_type numbers. Interop against a live SV2 pool is still untested — see KNOWN_LIMITATIONS §18. |
| G22 | The arbitration engine — the product's namesake feature — decided allocations on **gross** revenue. `engine.updateStream` copied `provider.Yield.SatsPerSecond` (pre-fee) into `arbitration.Yield`, discarding the `NetSatsPerSecond` the providers compute. With a 1% pool fee against a 20% compute-marketplace fee, gross-to-gross comparison overstates the high-fee market by ≈1.24×, enough to route a device to whichever pays it less. `provider.Yield.Effective()` computed the right figure and its doc claimed the engine used it; nothing called it. The README meanwhile tells users to compare pools by net BTC retained. | **Fixed (session 261)**: `engine.comparableYield` translates each quote into its net rate (gross as fallback when net is unset) for both `YieldPerDevice` and `DefaultYield`; `arbitration.Yield.SatsPerSecond` now documents that callers must quote net. An existing test that pinned the gross value was corrected, and `TestArbitration_ChoosesTheMarketThatPaysMoreNet` covers the case where the gross and net orderings disagree. |

This spec is updated alongside the code; new gaps are added here as they are
found and removed in the same change that closes them.
