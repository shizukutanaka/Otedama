# Otedama Roadmap

このロードマップは、Otedamaがv3.0.0-alpha以降に取り組む技術的マイルストーンを公開する文書です。**意図的に短く、技術固有で、達成可能な範囲に絞っています**。

このロードマップは前バージョン（2026年4月初版）から大幅に縮小されました。理由は、研究調査（`docs/SUSTAINABILITY.md`参照）で「solo maintainer の現実的な持続可能ペースは10時間/週」と指摘され、財団法人化やCloud/Marketplaceのような事業展開はこの制約と両立しないと判断したためです。**Otedamaは1人のメンテナが10年運用できるソフトウェアであり続けます。** スケールの大きな計画は、コントリビュータが定着し、bus-factor が改善した後に再検討します。

This roadmap intentionally lists only technical milestones one solo maintainer can credibly ship within a 10-hour-per-week sustainable cap. Aspirational items (foundations, marketplaces, cloud services) have been removed; they will be reconsidered if and when contributor count and bus-factor justify them.

---

## 確定マイルストーン / Confirmed Milestones

### v3.1.0 — Real protocols (target: 2026 Q3)

研究調査で「現在の実装は alpha placeholder が多い」と判明。実プロトコルへの差し替え。

- **secp256k1 + Schnorr (BIP-340)** を `internal/btccrypto/` に統合。現在 P-256 alpha のNoise NXハンドシェイクを実機 secp256k1 + ElligatorSwift に置き換え。
- **engine → poolproto 統合** `engine.Run` の pool 接続を `poolproto.DialURL` 経由に切り替え。現状 `stratum.NewDecoder` + raw TCP に直結しており、SV1 transport 等が使えない。この統合が dual-protocol 対応の前提条件。
- **Akash Network API** 実装。現在 simulated quotes を返している `internal/provider/ai_inference.go` を実APIに接続。**注記 (session 251, 検証済み)**: `akash-network/akash-api` は 2026-01-05 に deprecated/archived。後継の `akash-network/chain-sdk`（protobuf 定義、Go 参照クライアントあり）をターゲットとすること。また入札は provider daemon の on-chain "Bidengine" が行うため、REST 一発の bid submission ではなく bid-price policy を on-chain 設定へ渡すモデルになる（ADR-010 A4 参照）。ADR-003 の zero-dependency 方針との兼ね合いで、SDK 全体の vendoring ではなく必要な market/provider protobuf のみ生成する選択肢を評価する。
- ~~**完全な BIP-39 English wordlist**~~ ✅ **完了 (session 32)**: 公式2048語リストを SHA-256 検証付きで埋め込み済み。Ledger/Trezor/Electrum と互換。
- **govulncheck + osv-scanner** を CI ゲートに昇格（現在 informational）。
- **Sigstore keyless signing** を release.yml に統合（cosign v3.x、Rekor v2 互換）。

### v3.2.0 — Stratum V2 maturity (target: 2026 Q4)

研究調査で「production-quality な Go SV2 実装は存在しない」と判明。Otedamaが実用レベルの Go SV2 実装を提供する。**更新 (session 251, 検証済み)**: SRI (stratum-mining/stratum) は既に alpha を脱し v1.11.0 (2026-07-08)、ほぼ月次リリース。「SRI は alpha」という当初の前提は陳腐化。Go 実装が無い点は依然として有効なので Otedama の位置付けは変わらないが、SV2 適合性テストの interop リファレンスとして特定の SRI タグを pin すること。

- **`internal/poolproto/` 抽象化レイヤ** を engine/ から完全分離。SV1/SV2/DATUM 切替可能に。
- **Stratum V1 互換** の追加。研究調査の通り、>99%のプールはSV1のままなので、ユーザー基盤拡大のため必須。
- **DATUM (OCEAN) 互換** の追加（SV1 transport 上のbridgeとして実装）。
- **Job Declaration Protocol (JDP)** opt-in 対応（Braiins と DEMAND のみ実用、ベータ機能として）。

### v3.3.0 — Observability and ops (target: 2027 Q1)

- **OpenTelemetry SDK** を build tag (`-tags otel`) 経由で opt-in 提供。デフォルトはPrometheus単独継続。
- **OTLP/HTTP exporter** （gRPCではなく、研究レポート推奨に従う）。
- **continuous benchmarking** workflow を main 比較から week-on-week トレンドに拡張。
- **OSS-Fuzz** 統合申請（無料、Google が運用）。
- **macOS / Windows GPU 検出** （現在Linux sysfsのみ）。

### v3.5.0 — Hardening and crypto refresh (target: 2027 Q3)

- **`golang.org/x/crypto` の crypto/* 標準ライブラリ化** 完了に追従。研究レポート時点でGo 1.24-1.26で進行中。
- **`crypto/mldsa` (ML-DSA)** の `internal/btccrypto/` への opt-in 統合。**まだdefault schemeにはしない**。**訂正 (session 251, 検証済み)**: BIP-360 は Status: Draft のままで、実体は "Pay-to-Merkle-Root (P2MR)"（key-path spend を除いた Taproot 類似 output）であり、**PQ署名を規定していない**——BIP-360 本文が「PQ署名は別提案で行う」と明記している。したがって「BIP-360 活性化」と「ML-DSA/P2MR default」を結び付けるのは誤りで、Otedama の ML-DSA scaffolding は BIP-360 の後続の**未執筆の別 BIP** に gate される。§5 の不確実性はこの分だけ広がる。
- **SLSA Level 3** 達成 (`slsa-framework/slsa-github-generator`)。
- **CycloneDX 1.6 + SPDX 3.0.1** 両方の SBOM をリリース毎に発行。

---

## Feature deepening tracks (v3.5 → v4.0)

非カストディアル裁定の核心価値を深める3つの柱。詳細は各ADRを参照。

### Track A — Arbitration engine evolution (ADR-010)

裁定エンジンを「ステートレス比較器」から「予測 × スイッチングコスト × デバイス別 × Bayesian校正 × 敵対耐性」を持つ contextual bandit に進化させる。**~290 solo-hours over v3.5–v3.6**。

- **v3.5**: Holt-Winters yield forecaster, switching-cost ledger, Bayesian Beta-Bernoulli calibration, `otedama arb explain` dashboard.
- **v3.6**: Per-device suitability scoring, strategic Akash bidding, Sharpe-weighted preference, adversarial-corruption hardening, change-point detection.

### Track B — Lightning capability expansion (ADR-007)

BOLT12 受信器から、外部ノード制御 → 埋め込み LDK Node sidecar への段階的拡張。**~395–575 solo-hours over v3.5–v4.0**。

- **v3.5**: BOLT12 canonical offers, pool-agnostic payout adapter, Tor-by-default.
- **v3.6**: External-node remote-control (Phoenixd/CLN/lnd), Boltz reverse-swap failsafe.
- **v3.7**: Embedded LDK Node sidecar (opt-in), auto-splice (gated on LDK splicing GA), LSP picker, SCB + seed recovery.
- **v4.0**: Hardware-wallet PSBT cosign for channel opens/splices.

### Track C — Hardware and power awareness (ADR-008)

電力消費、TOU電気料金、デバイス効率曲線、ソーラー余剰を裁定に統合。**~595 solo-hours over v3.5–v3.7**。2028年halving後の生存戦略の中核。

- **v3.5**: ASIC firmware adapters (LuxOS, BraiinsOS+, stock Bitmain), NVML GPU adapter, TOU pricing (flat, Octopus Agile, CSV), manual curtail schedule.
- **v3.6**: DVFS profit math (J/TH curve optimization), thermal/ambient awareness, additional firmware adapters (VNish, DCENT_OS), additional tariff feeds (Tibber, Amber).
- **v3.7**: Solar/battery integration (Enphase, Tesla Powerwall, Victron), Intel Xe + Apple Silicon GPU observation.

### Track D — Pool decentralization integration (ADR-009)

2026年5月7日のStratum V2 Working Group expansion (Foundry, AntPool, F2Pool, Spiderpool, Block Inc., MARA, DMND参画 = 全hashrateの70%) に対応。**~480 solo-hours over v3.5–v3.7**。ADR-002 "Stratum V2 only"の論理的深化 — minerが**実際に**block templateを構築する。

- **v3.5**: Bitcoin node integration, template construction policy (default = accept everything; no editorializing). **注記 (session 251, 検証済み)**: Bitcoin Core v30.0 が experimental な IPC Mining Interface（`bitcoin -m node -ipcbind=unix`、`-DENABLE_IPC` build option、Cap'n Proto over unix socket、SV2 等の mining client 向けに template 要求・block 提出を提供）をリリース。legacy `getblocktemplate` RPC ではなくこの IPC interface をターゲットにすること（別 `bitcoin-node` multiprocess binary を要する点は ADR-009 に記録）。
- **v3.6**: Stratum V2 Job Declaration Client (JDC) — Braiins Pool / DMND / SRI community pool で動作。Template-aware Prometheus metrics (fee_capture_ratio で 7.4% uplift を実測可能化)。
- **v3.7**: DATUM client (OCEAN-compatible, C→Go reimpl)、Solo mining mode (regtest + 大規模hashrate用)。**確認 (session 251)**: DATUM Gateway は MIT ライセンス・public BETA・**Stratum V1 transport（version-rolling / ASICBoost 付き）で SV2 非対応**。よって `datum://` は新規バイナリプロトコルではなく `poolproto/stratumv1` を再利用した SV1-transport dialer として実装するのが正しい（MIT なので参照 gateway の wire format を直接参照可能）。

### Combined trajectory

4トラックの累計 **~1,940 solo-hours over 24 months** vs 利用可能 1,040h (10h/週) → **88% over budget**。**全機能をship不可能**であることを率直に明示。

**Honest priority order** (非カストディアル核心の保持を最優先):

1. **Track D (Pool decentralization)** — ADR-002の commitment を実装で果たす義務。**MUST SHIP v3.5–v3.7**。
2. **Track C (Hardware/Power)** — 2028 halving 後の生存に直結。**MUST SHIP v3.5–v3.7**。
3. **Track A (Arbitration)** — Track C の出力を活用するために必要。**SHIP v3.5–v3.6**。
4. **Track B Lightning embedded node (B4–B10, ~370h)** — **DEFER to v4.1**。BOLT12受信のみ v3.5 で ship。

**Minimum viable v4.0 (~715h, 17.5ヶ月で達成可能):**
- ADR-008: ASIC firmware (LuxOS + BraiinsOS+ + stock) + TOU (Octopus Agile) — 270h
- ADR-009: btcnode + policy + JDC (DATUM/solo 抜き) — 260h
- ADR-010: Holt-Winters + 切替コスト + Bayesian calibration — 100h
- ADR-007: BOLT12 受信のみ — 85h

優先順位調整トリガー: 2027年Q2時点でTrack DのJDCが未完成 → **schedule freeze**して Track D 完成優先。Track B embedded node を v4.1 に確定移送。

---

## 条件付きマイルストーン / Conditional Milestones

これらは **特定の外部イベント** が起きた時に着手します。今コミットしません。

### v4.0.0 — Post-Quantum readiness (trigger: BIP-360 activation)



研究調査によれば BIP-360 (Pay-to-Quantum-Resistance) のBitcoin Core実装と活性化は **2028-2032** （±2年）。これが活性化したら:

- **default scheme を hybrid Schnorr+ML-DSA-65** に切替（v4.0）。
- **legacy ECDSA address の生成を deprecation warning** 化、活性化+18ヶ月後に廃止。
- **新規ウォレットは P2MR (Post-quantum Multi-Resistant) アドレス** をデフォルト発行。

研究レポートで明示されている通り、SHA-256d採掘自体はGroverアルゴリズムでも quadratic speedup しか得られず、量子コンピュータでも実機ASICの1000分の1程度。**採掘ホットパスはPQ移行の影響なし**。署名と鍵交換のレイヤのみ。

### Block height 1,050,000 — 2028 Halving (trigger: ~2028 March-April)

block subsidy が 3.125 BTC → 1.5625 BTC に減少。Otedamaが対応すべき事項:

- **subsidy計算式は既にハードコードしておらず**、`50e8 >> (height/210000)` 計算なので**コード変更不要**（重要な研究結果）。
- **dashboard と earnings estimator** の表示文言を halving 後の経済性に合わせて更新（収益性、prefix選定の現実）。
- **CHANGELOG** にhalving イベントの注記を追加。
- **`docs/economics-after-halving.md`** ドキュメントを公開（hashpriceの実勢、CPU/GPU採掘の経済合理性の判断指針）。

### conditional: SV2 hashrate dominance (trigger: SV2 ≥ 50% of network hashrate)

研究調査で「SV2 は2026年Q1時点で~15-20%」と判明。50%を超えたら:

- SV1サポートを deprecation warning 化。
- DATUM 抽象化を継続（OCEANが移行しない場合の備え）。

---

## 削除されたマイルストーン / Removed Milestones

旧版ロードマップ（2026年4月初版）から削除した項目とその理由を、透明性のため記録します。

| 削除項目 | 削除理由 |
|---------|---------|
| Otedama Foundation 法人化 | solo maintainerの10h/週枠を完全に超過。先に bus-factor 改善が必要。 |
| Otedama Cloud（マネージドサービス） | 24/7オペレーションは1人で負担不可能。商用化は事業計画次第。 |
| Otedama Marketplace | 同上。プラグインエコシステムの需要証明なし。 |
| Otedama Academy（教育プログラム） | コア製品の安定化が先決。 |
| Otedama Analytics（市場データ） | スコープ外（採掘ソフトウェアではなく分析ベンダー）。 |
| 多通貨対応の再追加 | 設計上明示的に拒否。SHA-256dのみ。 |
| ZKP-based KYC alternative | スコープ外。非カストディ設計でKYC必要なし。 |
| Threshold Signatures による マルチパーティ決済 | v4.0以降で技術的に再検討の余地。 |
| Braidpool 相互運用 | Braidpool自体がプロトタイプ段階。 |

これらは「将来の可能性」ではなく **「やらないこと」** として明確に文書化します。スコープを狭く保つことが、10年の生存可能性のための最重要な戦略です（研究調査の結論）。

---

## 改訂履歴 / Revision History

- **2026年4月（初版）:** v2.1.9からの戦略的リセットに伴う初版公開。
- **2026年4月下旬（第2版）:** 研究調査 (`docs/SUSTAINABILITY.md`) を反映し、solo maintainerの実勢に合わせ大幅縮小。財団法人化などの拡張計画を削除。BIP-360 PQ migration、2028 halving、SV2 maturity の3軸でマイルストーンを再構成。

---

## ロードマップへのフィードバック / Feedback

ロードマップへの意見・批判は GitHub Discussions で受け付けます。「これは過大」「これも追加すべき」のいずれも歓迎ですが、**いずれの主張もメンテナの10時間/週キャップとの両立性を示してください**。これを欠く提案は採用されません。
