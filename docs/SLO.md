# Service Level Objectives — Otedama

本書は Otedama が `/metrics` で公開する各メトリクスを「アクション可能」にする
SLO（Service Level Objective）の既定値を定義する。各 SLI は実在するメトリクスに
のみ基づく — 存在しないシグナルを参照するアラートは設計しない。
（日本語サマリーは末尾の「まとめ」を参照。）

This document assigns starting SLOs to the signals Otedama already exposes,
following the Google SRE workbook convention: every indicator is a metric that
exists today, every objective is stated as a queryable expression, and every
alert means *act*, not *observe*. Defaults are starting points — tune them to
your deployment; a home miner and a fleet dashboard want different budgets.

## Reading this document

- **SLI** — the measurable indicator (a `/metrics` series).
- **Objective** — the target the operator should hold.
- **Alert expression** — a Prometheus-style predicate; when it fires, do the
  listed action.
- **Budget** — how much violation is acceptable before the objective is
  considered broken for the window (28d rolling).

## 1. Availability — is the miner producing?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_up` | = 1 for ≥ 99% of any 28d window (≤ ~6.7h down) | `otedama_up == 0` for 5m | Miner stalled — check `otedama_shares_unaccounted` and the TUI stall badge; restart if wedge persists. |
| productive fraction | `otedama_productive_seconds_total / otedama_uptime_seconds` ≥ 0.95 | ratio < 0.95 over 24h | Recurring stalls or curtailment — inspect `otedama_curtailed` and thermal logs. |
| `otedama_curtailed` | informational | = 1 | Not an error: price is below `curtail_below_btc_usd`. Silence if intentional. |

## 2. Share path — is work being credited?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_share_acceptance_rate` | ≥ 0.995 steady-state | < 0.97 for 15m | Above the ~3% act-now band — see `otedama_shares_rejected_by_reason_total{reason}` to split latency vs hardware vs difficulty. |
| `otedama_stale_rate` | < 0.01 | ≥ 0.01 for 15m | Latency problem on the pool path — check submit latency and link quality. |
| `otedama_shares_unaccounted` | low single digits; transient | > 10 sustained for 15m | Found shares are not reaching the pool — the local-vs-pool reconciliation tripwire. |
| `otedama_pool_reconcile_divergences_total` | = 0 | rate > 0 over 1h | Pool-reported accepts disagree with local settles — share accounting cannot be trusted; file evidence with the pool. |
| `otedama_shares_superseded_total` | informational | sustained rate | Benign vardiff transitions; only meaningful alongside a rising reject rate. |

## 3. Pool link — is the connection fresh?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_last_job_received_seconds` | < 120s old (≈2× typical notify interval) | `time() - value > 120` | Job feed wedged despite "connected" state — force reconnect/failover. |
| `otedama_pool_connection_state` | = 2 (connected) | < 2 for 10m | Failover cycling — check `otedama_pool_active_index` drift and per-pool reachability. |
| `otedama_pool_difficulty` | informational | sudden drop with near-zero shares | Pool may have lost var-diff trust or flagged the client — review `client.get_version`/difficulty history. |
| `otedama_estimated_share_interval_seconds` | ≈ pool target cadence | ≫ 120s sustained | Difficulty set too high for the hashrate — consider `mining.suggest_difficulty` tuning or another pool. |

## 4. Provider health — are all yield sources alive?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_provider_last_quote_seconds{provider}` | < 120s old | `time() - value > 120` | Provider went silent — its stream is pruned from arbitration automatically, so this alert means *investigate the provider*, not lost revenue. |
| `otedama_active_streams` | ≥ configured providers | < expected for 15m | Same signal at aggregate level; use the per-provider timestamp to locate the silent one. |

## 5. Price feed — is the rate trustworthy?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_btc_rate_age_seconds` | < 600s (2× the 5-min refresh) | > 600 | All price sources failing — yield conversion and curtailment run on stale data. |
| `otedama_rate_sources_ok` / `_total` | ok ≥ 1 | ok == 0 | Source redundancy exhausted; check network egress to the price endpoints. |
| `otedama_clock_skew_seconds` | \|skew\| < 120s | ≥ 120 | TLS validation, mining nTime and rate freshness all degrade — fix the host clock (NTP). |

## 6. Submit latency — is the submit round-trip fast?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_submit_latency_milliseconds{quantile="0.99"}` | ≤ 2000ms | > 2000 for 15m | Tail latency breeds stale shares — measure path to the pool, consider a closer endpoint. |
| `otedama_submit_latency_milliseconds{quantile="0.5"}` | ≤ 300ms | > 300 | Baseline latency regression on the pool link. |

## 7. Economics — is the arbitration honest?

| SLI | Objective | Alert expression | Action |
|---|---|---|---|
| `otedama_provider_yield_sats_per_second{simulated="false"}` | > 0 while mining | = 0 | Real yield collapsed — pool quote stale or difficulty miscalibrated. Always reconcile `simulated="true"` separately: it is modelled, not income. |
| `otedama_arbitration_foregone_sats_per_second` | low vs expected yield | sustained high | Hysteresis/policy is costing real sats — tune `arbitration_hysteresis_pct`. |
| `otedama_devices_idle` | = 0 | > 0 sustained | Devices parked — incompatible streams or `min_yield_sats_per_sec` floor too high. |

## Budgeting rule of thumb

Each SLO above carries an implicit error budget (e.g. 99% availability ≈ 6.7h
of downtime per 28d window). When an alert spends more than its budget, the
response is a fix, not a tighter threshold — do not tune an alert into silence.
When a signal burns budget *without* a user-visible cause, the SLO is wrong;
edit this file, don't delete the metric.

---

## まとめ（日本語サマリー）

- **SLO は「アクション可能」であることが目的**: すべての指標は `/metrics` に
  実在する系列であり、アラート式は Prometheus にそのまま貼れる形で記載。
- **優先度**: まず §1 の可用性（`otedama_up`、productive fraction）と
  §3 の `otedama_last_job_received_seconds` の2系統だけ入れても、
  実運用の大半の故障（スタック・半開き接続）は捕捉できる。
- **経済系の注意点**: `simulated="true"` の yield はモデル値であり、
  収益勘定・SLO からは必ず分離する（KNOWN_LIMITATIONS §1）。
- **チューニング規範**: 閾値を緩めてアラートを黙らせるのではなく、
  予算（error budget）を超えたら修正する。SLO が誤っている場合は
  本書を更新する — メトリクス側は削除しない。

参照: Google SRE Workbook "Implementing SLOs"、本リポジトリの
`docs/SPECIFICATION.md` §6（メトリクスカタログ）、
`docs/RESEARCH_IMPROVEMENTS.md` Category 9 item 10。
