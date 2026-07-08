# Otedama

[![CI](https://github.com/shizukutanaka/Otedama/actions/workflows/ci.yml/badge.svg)](https://github.com/shizukutanaka/Otedama/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Alpha](https://img.shields.io/badge/Status-Alpha-orange)](CHANGELOG.md)

**遊休計算資源を、非カストディで最大収益化する自律型ソフトウェア層。**
**A non-custodial autonomous arbitration layer for idle compute resources.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Go Report Card](https://goreportcard.com/badge/github.com/shizukutanaka/Otedama)](https://goreportcard.com/report/github.com/shizukutanaka/Otedama)
[![Go Version](https://img.shields.io/github/go-mod/go-version/shizukutanaka/Otedama)](go.mod)

---

## 概要 / Overview

Otedamaは、ユーザーが所有するASIC・GPU・CPUハードウェアを、複数の収益源（ビットコイン採掘・AI推論提供・分散レンダリング・科学計算委託）にリアルタイム裁定配分するソフトウェアスイートです。Stratum V2プロトコル準拠、Lightning Networkによる非カストディ決済、ZKPベースの匿名認証を標準実装し、既存マイニングプールの中央集権的リスクと規制摩擦の両方を回避します。

Otedama is a software suite that automatically arbitrates user-owned ASIC, GPU, and CPU hardware across multiple revenue streams—Bitcoin mining, AI inference provision, distributed rendering, and scientific computing—in real time. It ships with native Stratum V2 support, non-custodial Lightning Network payouts, and ZKP-based anonymous authentication, avoiding both the centralization risks and the regulatory friction of conventional mining pools.

## なぜOtedamaか / Why Otedama

2026年現在、ビットコインマイニング市場では上位6プールが全ハッシュレートの99%を占め、AIインフラはGPU需給の逼迫により分散化が進んでいます。公開マイニング企業はマイニングからAI計算事業への資本移転を開始しており、遊休計算資源を単一用途に固定する設計は構造的に不利になりました。Otedamaは、ハードウェアを特定の用途に縛らず、収益期待値が最も高い用途へ自動的に切り替えることで、この市場構造変化に適応する設計を採用しています。

At the time of writing, the top six Bitcoin mining pools control approximately 99% of network hashrate, while the AI infrastructure market is moving in the opposite direction under GPU supply pressure. Public miners are reallocating capital from proof-of-work mining to AI compute leasing. Designs that bind hardware to a single revenue stream are structurally disadvantaged in this environment. Otedama's architecture refuses that binding and routes compute to whichever workload currently maximizes expected return.

## 設計原則 / Design Principles

Otedamaの設計は三つの原則に従います。John Carmackのパフォーマンスファースト思想、Robert C. Martinのクリーンアーキテクチャ、Rob Pikeの簡潔性と並行性です。これらは標語ではなく、具体的な実装選択に翻訳されています。ホットパスはプロファイリング駆動で最適化され、依存関係は単一責任原則に従い、並行処理はチャネルとゴルーチンによる明示的構造で記述されます。量子耐性演出機能、多通貨対応の拡張、独自トークン発行、中央集権コンポーネントの追加は、設計上明示的に禁止されています。

## 主要機能 / Core Features

Otedama v3.0は以下の機能を中核として提供します。Stratum V2完全対応のマイニングクライアント（Braiins Pool、DEMAND、OCEAN、Luxorを初期サポート）、Lightning Network非カストディ決済層（LDK統合）、四系統リアルタイム裁定エンジン、ASIC・GPU・CPU自動検出と最適化、ZKPベース認証（KYC代替として設計）、プラグイン拡張アーキテクチャ、Web管理インターフェース（オプション、デフォルト無効）、Prometheus互換のメトリクスエクスポート、OpenTelemetry分散トレーシング、クロスプラットフォーム署名付きバイナリ配布（Windows、macOS、Linux x86_64/ARM64、FreeBSD）。

## クイックスタート / Quick Start

### 必要環境 / Requirements

Go 1.22以上、Linux・macOS・Windows・FreeBSDのいずれか、インターネット接続、対象ハードウェア（任意のASIC、CUDA 12以上のNVIDIA GPU、ROCm 6以上のAMD GPU、AVX2対応のx86_64 CPU、またはNEON対応のARM64 CPU）のうち一つ以上。

### インストール / Installation

```bash
# ソースからビルド
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama
make build

# または、リリースバイナリをダウンロード
curl -sSL https://github.com/shizukutanaka/Otedama/releases/latest/download/install.sh | bash
```

### 最小設定での起動 / Running with Minimal Configuration

```bash
# BTCアドレスを指定して即座に起動
otedama run --bitcoin-address bc1q...

# カスタム設定ファイルを使用
otedama run --config /path/to/config.yaml
```

初回起動時、Otedamaはローカルハードウェアを自動検出し、組み込みのStratum V2対応プール一覧から最初の応答可能なプールに接続します。`--wallet-passphrase` を渡すと初回起動時に Lightning Wallet も自動生成されます。設定不要で稼働する設計を目指していますが、Bitcoin アドレスの指定だけは省略できません（非カストディ設計のため）。

On first launch, Otedama auto-detects local hardware, then connects to the first responsive pool from its built-in Stratum V2 list. If you pass `--wallet-passphrase`, a Lightning wallet is generated at first run. The product aims for zero-config operation, but the Bitcoin address must always be supplied (this is inherent to the non-custodial design).

## コマンド一覧 / Command Reference

```
otedama <command> [flags]
```

| コマンド / Command | 説明 / Description |
|--------------------|--------------------|
| `run` | マイニング／計算ワークロードを開始 / Start mining and/or other compute workloads |
| `version` | バージョン情報を表示 / Print version information |
| `config show` | 有効な設定を表示 / Print the effective configuration |
| `config validate` | 設定ファイルを検証 / Validate a configuration file |
| `service install` | バックグラウンドサービスとして登録 / Install as a background service (launchd/systemd/Task Scheduler) |
| `service uninstall` | サービス登録を解除 / Uninstall the background service |
| `service status` | サービス状態を表示 / Show background service status |
| `doctor` | 自己診断チェックを実行 / Run self-diagnostic checks |
| `help` | ヘルプを表示 / Print help |

各コマンドの詳細フラグは `otedama <command> --help` で確認できます。
Run `otedama <command> --help` for the flags of each command.

```bash
# 自己診断 / Self-diagnostics
otedama doctor

# 有効な設定を確認 / Inspect effective configuration
otedama config show

# 常駐サービスとして登録 (Linux: systemd, macOS: launchd, Windows: Task Scheduler)
otedama service install --bitcoin-address bc1q...
```

## プール選択の指針 / Choosing a pool

採掘プールを選ぶ際、表面的な手数料率だけで判断しないでください。2026年の各種比較が一致して指摘する通り、**実際にウォレットに届くBTC(net yield)** で比較すべきです。

- **手数料 < 信頼性**: 稼働率4%の差は、手数料1%の差の約4倍のコストになり得ます。Otedama は reject率(理由別)・submit遅延(p50/p95/p99)・stall検出・プールfailover を計測するので、`/metrics` でプールの実効的な健全性を比較できます。
- **払い出し方式のトレードオフ**: FPPS は分散(variance)をプールが吸収し収益が滑らか / PPLNS は低手数料だが分散はマイナー負担 / TIDES(OCEAN)は非カストディでcoinbaseに直接支払い。Otedama の非カストディ設計は TIDES/PPLNS と思想的に整合します。
- **最低払い出し額**: 高い閾値は小残高を「塩漬け」にします。OCEAN の 0.00001 BTC Lightning 最低額のような低閾値プールは小規模マイナーに有利です。

Pick a pool by **net BTC retained**, not the headline fee rate. A 4% uptime gap can cost ~4× a 1% fee gap; Otedama's reject-rate (by reason), submit-latency, stall, and failover metrics let you compare pools on real reliability. Understand the payout scheme you choose: FPPS smooths variance (pool absorbs it), PPLNS is cheaper but variance is yours, TIDES (OCEAN) is non-custodial and pays into the coinbase — the last aligns with Otedama's non-custodial design. Watch minimum-payout thresholds so small balances are not trapped.

## アーキテクチャ / Architecture

Otedamaは以下の主要レイヤーで構成されます。ハードウェア抽象化層（HAL）が物理デバイスの統一インターフェースを提供し、その上に収益源コネクタ層が存在します。現時点（v3.0.0-alpha.1）で実装済みなのは、Stratum V2/V1クライアントによる実際のビットコイン採掘と、Akashネットワークを模したシミュレーション価格による実験的なAI推論見積もりの2系統のみです。レンダリングネットワークアダプタとBOINC互換クライアントは`CLAUDE.md`のロードマップ上でv4.0スコープとして明示されており、未着手です。裁定エンジン層は各収益源の期待収益を継続的に評価し、配分決定を下します。Lightning関連コードは現時点ではBIP-39シードの暗号化保管のみを提供し、決済・チャネル管理・支払いルーティングは実装していません（詳細は`docs/KNOWN_LIMITATIONS.md`）。観測性層（メトリクス・ログ）が全体を支えます。

詳細なアーキテクチャ設計は `docs/architecture.md` を参照してください。

## v2からの移行 / Migrating from v2

v2ユーザーへの完全な移行ガイドは `docs/MIGRATING-FROM-V2.md` にあります。判断指針（v3に移行すべきか）、段階的な手順、設定フィールドの差分対応表を含みます。

The complete migration guide for v2 users is at `docs/MIGRATING-FROM-V2.md`. It covers a decision framework (should you migrate?), a step-by-step procedure, and a field-by-field configuration diff.

v2.1.9 のコードベースは `legacy-v2` ブランチに保全され、2026年10月までの6ヶ月間は重大セキュリティ修正のみ継続提供します。

The v2.1.9 codebase is preserved on the `legacy-v2` branch and receives security fixes only for six months (until 2026-10-24).

## プロジェクトの状態 / Project Status

Otedama v3.0は2026年4月に戦略的リセットを実施した新世代バージョンです。v2系列で蓄積された技術資産の一部を継承しつつ、アーキテクチャの大部分を再設計しました。現在アルファ段階にあり、本番環境での利用は自己責任で行ってください。v3.0.0正式リリースは2026年後半を目標としています。

ロードマップの詳細は `ROADMAP.md` を、進捗状況は GitHub Projects を参照してください。

**アルファ段階の既知の制約は [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) に正直に列挙しています。** AI推論収益が現在シミュレーションであること、Noise NX が暫定的に P-256 を使用していること等、「設計上の意図」と「未実装」の区別を明記しています。利用前に必ず確認してください。

The known limitations of this alpha — including that AI-inference yield is currently *simulated*, and that the Noise NX handshake temporarily uses P-256 — are listed honestly in [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md). Please read it before relying on Otedama.

## コントリビューション / Contributing

Otedamaはコミュニティからの貢献を歓迎します。コード、ドキュメント、翻訳、テスト、バグ報告のいずれも価値ある貢献です。初めて貢献する方は `CONTRIBUTING.md` を参照してください。コーディング規約は同ファイルの「コーディング規約 / Coding Standards」節に記載されています。

技術的な議論はGitHub Discussionsで、脆弱性報告は `SECURITY.md` に記載されたセキュリティ連絡先へお願いします。

## ライセンス / License

Otedamaは Apache License 2.0 の下で公開されています。詳細は `LICENSE` ファイルを参照してください。

## 連絡先 / Contact

- GitHub Issues: [shizukutanaka/Otedama/issues](https://github.com/shizukutanaka/Otedama/issues)
- GitHub Discussions: [shizukutanaka/Otedama/discussions](https://github.com/shizukutanaka/Otedama/discussions)
- Security: `SECURITY.md` を参照

---

**Otedama is software, not financial advice. Mining, AI compute provision, and cryptocurrency operations involve financial and regulatory risk. Users are responsible for compliance with applicable laws in their jurisdiction.**
