# Service-Level Objectives (SLO)

このドキュメントは、Otedama の運用者が `/metrics` エンドポイントを監視する際の
目標値・警告閾値を定義します。全てのメトリクスは `docs/API.md` の表に登録済みの
実在する名前のみを使います（外部依存なしの自作 Prometheus エクスポージャー）。

The SLOs below reference only metric names that exist in the shipped
exposition. They are objectives for the operator's deployment, not test
assertions — Otedama itself does not emit alerts (no alert manager is
shipped), so copy the PromQL examples into your own monitoring stack.

## 目的とスコープ

- 対象: `otedama run` を稼働させるノード運用者。
- 収益まわりの判定（裁定エンジン出力の正しさ）は SLO の対象外 — ここでは
  「プロセスが健全にプールへ接続し、シェアを提出し続けているか」を測る。
- 期間: 特記ない限り 30 日ローリング。

## SLO-1 — 稼働率 (availability)

- **指標:** `otedama_up` (0/1)
- **目標:** `avg_over_time(otedama_up[30d]) >= 0.99`
- **除外:** `otedama_curtailed == 1` の期間（価格カーテイルによる意図的停止は
  稼働率のカウントから除く — 経済的に正しい挙動であり障害ではない）。
- **警告:** `otedama_up == 0` が 10 分継続 → ハッシュレート停滞かプール切断の
  可能性。`otedama_pool_connection_state` と併せて確認。

## SLO-2 — プール接続 (connectivity)

- **指標:** `otedama_pool_connection_state` (0=disconnected, 1=connecting,
  2=connected)
- **目標:** `otedama_pool_connection_state == 2` が稼働時間の 99% 以上。
- **警告:** `increase(otedama_pool_connect_failures_total[1h]) > 5` →
  プール障害か DNS/TLS 設定ミス。`otedama_pool_active_index` が
  failover リスト末尾に移動している場合は優先対応。
- **関連:** `otedama_last_job_received_seconds` が 300 秒以上古い場合、
  接続は生きていてもジョブが流れていない — stale-share リスク。

## SLO-3 — シェア提出レイテンシ (submit latency)

- **指標:** `otedama_submit_latency_milliseconds{quantile="0.99"}`
- **目標:** p99 < 500 ms（ローカル/近傍プール基準。リージョン跨ぎでは
  p99 < 1000 ms まで許容）。
- **警告:** p99 が 1 秒を超えて 15 分継続 → 地理的に近いプールへの切替を
  推奨（stale share はレイテンシ起因が支配的）。

## SLO-4 — リジェクト率 (reject rate)

- **指標:** `otedama_reject_rate`（判定済みシェア中の拒否割合）
- **目標:** < 0.5%。**警告帯:** 0.5–3%。**即対応:** > 3%。
  （D-Central のフィールドガイド閾値 — `internal/engine/metrics.go` の
  実装コメントと同一の区分。）
- **補足:** `otedama_shares_rejected_by_reason_total{reason="transition"}`
  は難易度遷移中の良性拒否で分母から除外済み（session 255）—
  `reject_rate` の閾値はそのまま使ってよい。

## SLO-5 — ステイル率 (stale rate)

- **指標:** `otedama_stale_rate`
- **目標:** < 0.1%。
- **警告:** > 0.5% が 1 時間継続 → 上流レイテンシ（SLO-3）または
  `clean_jobs` 未処理の疑い。

## SLO-6 — シェア会計完全性 (share accounting)

- **指標:** `otedama_shares_unaccounted`,
  `otedama_shares_unresolved_total`
- **目標:** `unaccounted == 0`（恒常時）。`unresolved` は切断/セッション
  終了時のみ増加し、定常状態では 0 に近いこと
  （`submitted ≈ accepted + rejected + unresolved` の整合）。
- **警告:** `increase(otedama_shares_unresolved_total[15m]) > 0` が
  再接続イベントと無関係に発生 → 判定を得られないままの提出を示唆、
  SLO-2 と併せて診断。

## SLO-7 — BTC レート鮮度 (rate feed freshness)

- **指標:** `otedama_btc_rate_age_seconds`,
  `otedama_rate_sources_ok` / `otedama_rate_sources_total`
- **目標:** レート年齢 < 120 秒、健全ソース数 `rate_sources_ok >= 2`。
- **警告:** `rate_sources_ok < 2` が 1 時間継続 → 裁定の価格根拠が
  単一ソースに退化（第三者停止時の盲点）。

## アラート例 (PromQL)

```promql
# SLO-1: stalled or down for 10 minutes
otedama_up == 0

# SLO-2: reconnect storm
increase(otedama_pool_connect_failures_total[1h]) > 5

# SLO-3: submit latency p99 over 1s
otedama_submit_latency_milliseconds{quantile="0.99"} > 1000

# SLO-4: reject rate over 3%
otedama_reject_rate > 0.03

# SLO-6: unresolved shares appearing without a reconnect
increase(otedama_shares_unresolved_total[15m]) > 0
```

Otedama にはアラート機構も OpenTelemetry も未実装です（ROADMAP v3.3.0
で OTel opt-in を計画）。上記ルールは Prometheus Alertmanager または
Grafana のアラートルールとして運用側に配置してください。

## 関連ドキュメント

- `docs/API.md` — `/metrics` 全メトリクス一覧（本書で参照する名前の網羅表）。
- `docs/TROUBLESHOOTING.md` — 警告発火時の調査手順。
- `docs/RESEARCH_IMPROVEMENTS.md` Category 9 — 各メトリクスの設計根拠。
