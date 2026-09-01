# Otedama

[![CI](https://github.com/shizukutanaka/Otedama/actions/workflows/ci.yml/badge.svg)](https://github.com/shizukutanaka/Otedama/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Alpha](https://img.shields.io/badge/Status-Alpha-orange)](CHANGELOG.md)

**遊休計算資源を、非カストディで最大収益化する自律型ソフトウェア層。**
**A non-custodial autonomous arbitration layer for idle compute resources.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Go Report Card](https://goreportcard.com/badge/github.com/shizukutanaka/Otedama)](https://goreportcard.com/report/github.com/shizukutanaka/Otedama)
[![Go Version](https://img.shields.io/github/go-mod/go-version/shizukutanaka/Otedama)](go.mod)

---

## 概要 / Overview

Otedamaは、ユーザーが所有するASIC・GPU・CPUハードウェアを、複数の収益源にリアルタイム裁定配分することを目指すソフトウェアスイートです。v3.0.0-alpha.1時点で実装済みの収益源は、Stratum V2/V1準拠の実ビットコイン採掘の1系統のみです。AI推論の見積もりはシミュレーション価格を返すだけで実収入に変換できる経路が存在しなかったため、session 264で削除しました（`docs/KNOWN_LIMITATIONS.md` §1）。分散レンダリングと科学計算委託はv4.0スコープの計画機能で未実装です。Lightning関連コードは現時点でBIP-39シードの暗号化保管のみを提供し、決済処理自体は行いません。ZKPベースの匿名認証も同じくv4.0スコープの計画機能で未実装です。それでも、既存マイニングプールが抱える中央集権的リスクを回避する非カストディ設計そのものは、今日から機能します。

Otedama is a software suite designed to arbitrate user-owned ASIC, GPU, and CPU hardware across multiple revenue streams in real time. As of v3.0.0-alpha.1, exactly one stream is implemented: real Bitcoin mining over Stratum V2/V1. A simulated-price AI-inference quote used to be the second; it was deleted in session 264 because no code path could turn its constant quote into income, while it did feed the dashboard's headline earnings figure (`docs/KNOWN_LIMITATIONS.md` §1). Distributed rendering and scientific computing are planned v4.0-scope features and are not implemented. The Lightning-related code today only encrypts and stores a BIP-39 seed at rest; it does not process payments. ZKP-based anonymous authentication is likewise planned for v4.0 and not implemented today. What works today is the non-custodial design itself, which avoids the centralization risk of conventional mining pools from day one.

## なぜOtedamaか / Why Otedama

2026年現在、ビットコインマイニング市場では上位6プールが全ハッシュレートの99%を占め、AIインフラはGPU需給の逼迫により分散化が進んでいます。公開マイニング企業はマイニングからAI計算事業への資本移転を開始しており、遊休計算資源を単一用途に固定する設計は構造的に不利になりました。Otedamaは、ハードウェアを特定の用途に縛らず、収益期待値が最も高い用途へ自動的に切り替えることで、この市場構造変化に適応する設計を採用しています。

At the time of writing, the top six Bitcoin mining pools control approximately 99% of network hashrate, while the AI infrastructure market is moving in the opposite direction under GPU supply pressure. Public miners are reallocating capital from proof-of-work mining to AI compute leasing. Designs that bind hardware to a single revenue stream are structurally disadvantaged in this environment. Otedama's architecture refuses that binding and routes compute to whichever workload currently maximizes expected return.

## 設計原則 / Design Principles

Otedamaの設計は三つの原則に従います。John Carmackのパフォーマンスファースト思想、Robert C. Martinのクリーンアーキテクチャ、Rob Pikeの簡潔性と並行性です。これらは標語ではなく、具体的な実装選択に翻訳されています。ホットパスはプロファイリング駆動で最適化され、依存関係は単一責任原則に従い、並行処理はチャネルとゴルーチンによる明示的構造で記述されます。量子耐性演出機能、多通貨対応の拡張、独自トークン発行、中央集権コンポーネントの追加は、設計上明示的に禁止されています。

## 主要機能 / Core Features

Otedama v3.0.0-alpha.1が現時点で実際に提供する機能は次の通りです。Stratum V2/V1対応のマイニングクライアント（実際に採掘します。複数プールを明示設定すれば優先順位付きフェイルオーバーが機能し、未設定時は組み込みの既定プール1つにフォールバック）。Lightning関連コードによるBIP-39シードの暗号化保管（決済処理そのものは未実装）。裁定エンジン（現時点の収益源は実採掘の1系統のみなので、実質的な判断は「このデバイスを動かす価値があるか」——`min_yield_sats_per_sec` の採算下限を超えるか、`curtail_below_btc_usd` で停止中か——である）。CPU自動検出（実マイニング対応）およびLinux限定のGPU検出（プレゼンス検出のみで、compute dispatchは未実装のためGPUでのマイニング・推論は不可）。Prometheus互換のメトリクスエクスポート（`/metrics`・`/healthz`・`/readyz`）。

以下は現時点で未実装、またはv4.0以降の計画のみの機能です：ASIC検出、ZKPベース認証、プラグインアーキテクチャ、Web管理インターフェース、OpenTelemetry分散トレーシング、署名付きバイナリ配布、分散レンダリング、科学計算委託。詳細は `docs/KNOWN_LIMITATIONS.md` を参照してください。

## クイックスタート / Quick Start

### 必要環境 / Requirements

Go 1.24以上（`go.mod` は `go 1.22` を宣言していますが `godebug tlsmlkem=1` を含み、このキーは
Go 1.24 で追加されたため、それより古いツールチェーンは `GOTOOLCHAIN` を既定の `auto` にして
`toolchain go1.24.0` へ自動切替させる必要があります。`GOTOOLCHAIN=local` の古いツールチェーンでは
`go.mod` の読み込み時点で失敗します）、Linux・macOS・Windows のいずれか
（FreeBSD 向けにはクロスコンパイルが通ることのみ確認済みで、リリースバイナリは提供しておらず、
実機テストもしていません）、インターネット接続、そして実際に採掘するにはAVX2対応のx86_64 CPUまたはNEON対応のARM64 CPU（現時点で唯一の実マイニング対応デバイス）。GPUはLinux上でのみ検出されますが、現時点ではプレゼンス検出のみでマイニング・AI推論のいずれにも使用されません。ASICデバイスは検出されません（`docs/KNOWN_LIMITATIONS.md` 参照）。

### インストール / Installation

```bash
# ソースからビルド
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama
make build

# または、インストーラスクリプト（下記の注意を読んでから）
curl -sSL https://raw.githubusercontent.com/shizukutanaka/Otedama/main/install.sh | bash
```

> **インストーラは現在そのままでは完走しません（session 266 に実測）。** `install.sh` は
> `checksums.txt` を取得してSHA-256を照合しますが、`release.yml` はチェックサムを一切公開して
> いないため、取得に失敗して中断します（`docs/KNOWN_LIMITATIONS.md` §21）。検証を明示的に
> 放棄する `--skip-verify` を付ければインストールできますが、**その場合ダウンロード物は未検証**
> です。確実なのは上の `make build`（ソースからのビルド）です。
> なお、このURLは以前 `releases/latest/download/install.sh` を指していましたが、
> リリースに `install.sh` はアップロードされていないため 404 になります。

### 最小設定での起動 / Running with Minimal Configuration

```bash
# BTCアドレスを指定して即座に起動
otedama run --bitcoin-address bc1q...

# カスタム設定ファイルを使用
otedama run --config /path/to/config.yaml
```

> **プールの設定は現時点で必須です。** 組み込みの既定プールのホストは現在 DNS で解決しません
> （session 266 に実測。`docs/KNOWN_LIMITATIONS.md` §20）。したがって上の一行だけでは採掘は
> 始まりません——`otedama run` はその旨を起動時に警告し、`otedama doctor` は設定すべき内容を
> 示します。プールのホスト名・ポート・スキームは、利用するプール自身のドキュメントから取得して
> `config.yaml` の `pools:` に記載してください（`config.yaml.example` に雛形があります）。
> 可能なら `stratum+v2tls://` か `stratum+tls://` を選んでください。`stratum+v2://` は平文で、
> 支払先アドレスがネットワーク上で読み取り・書き換え可能です（§2）。
>
> **A pool must be configured.** The built-in default host does not currently resolve (measured in
> session 266 — see `docs/KNOWN_LIMITATIONS.md` §20), so the one-liner above will not mine on its
> own: `otedama run` warns about this at startup and `otedama doctor` says what to set. Take the
> hostname, port and scheme from your pool's own documentation and put them in `pools:` in
> `config.yaml` (`config.yaml.example` has the shape). Prefer `stratum+v2tls://` or
> `stratum+tls://` — `stratum+v2://` is plaintext, which exposes your payout address to rewriting
> in transit (§2).

初回起動時、Otedamaはローカルハードウェアを自動検出し、設定されたプールへの接続を試みます（プール未設定時は組み込みの既定プール1つにフォールバックしますが、上記の通りそのホストは解決しません——またこれは複数プールの推奨リストでもありません）。`--wallet-passphrase` を渡すと初回起動時に Lightning Wallet も自動生成されます（BIP-39シードの暗号化保管のみで、決済処理は行いません）。設定不要で稼働する設計を目指していますが、現時点で省略できないのは Bitcoin アドレス（非カストディ設計のため）とプール設定（上記のため）の2つです。

On first launch, Otedama auto-detects local hardware and attempts to connect to your configured pool(s), falling back to a single built-in default pool if none are configured — a fallback whose host does not resolve today, and not a curated multi-pool list either (see "Core Features" above). If you pass `--wallet-passphrase`, a Lightning wallet is generated at first run (this only encrypts and stores a BIP-39 seed at rest; it does not process payments). The product aims for zero-config operation; today two things cannot be omitted — the Bitcoin address (inherent to the non-custodial design) and the pool (for the reason above).

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
| `wallet verify` | 復元フレーズが実際にこのウォレットを復元するか照合 / Check that a recovery phrase really restores this wallet |
| `wallet change-passphrase` | ウォレットのパスフレーズを変更 / Rotate the wallet passphrase |
| `completion` | シェル補完スクリプトを出力 (bash/zsh/fish) / Emit a shell-completion script |
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

Otedamaは以下の主要レイヤーで構成されます。ハードウェア抽象化層（HAL）が物理デバイスの統一インターフェースを提供し、その上に収益源コネクタ層が存在します。現時点（v3.0.0-alpha.1）で実装済みなのは、Stratum V2/V1クライアントによる実際のビットコイン採掘の1系統のみです。レンダリングネットワークアダプタとBOINC互換クライアントは`CLAUDE.md`のロードマップ上でv4.0スコープとして明示されており、未着手です。裁定エンジン層は各収益源の期待収益を継続的に評価し、配分決定を下します。Lightning関連コードは現時点ではBIP-39シードの暗号化保管のみを提供し、決済・チャネル管理・支払いルーティングは実装していません（詳細は`docs/KNOWN_LIMITATIONS.md`）。観測性層（メトリクス・ログ）が全体を支えます。

詳細なアーキテクチャ設計は `docs/architecture.md` を参照してください。

## v2からの移行 / Migrating from v2

v2ユーザーへの完全な移行ガイドは `docs/MIGRATING-FROM-V2.md` にあります。判断指針（v3に移行すべきか）、段階的な手順、設定フィールドの差分対応表を含みます。

The complete migration guide for v2 users is at `docs/MIGRATING-FROM-V2.md`. It covers a decision framework (should you migrate?), a step-by-step procedure, and a field-by-field configuration diff.

v2.1.9 のコードベースは `legacy-v2` ブランチに保全され、2026年10月までの6ヶ月間は重大セキュリティ修正のみ継続提供します。

The v2.1.9 codebase is preserved on the `legacy-v2` branch and receives security fixes only for six months (until 2026-10-24).

## プロジェクトの状態 / Project Status

Otedama v3.0は2026年4月に戦略的リセットを実施した新世代バージョンです。v2系列で蓄積された技術資産の一部を継承しつつ、アーキテクチャの大部分を再設計しました。現在アルファ段階にあり、本番環境での利用は自己責任で行ってください。v3.0.0正式リリースは2026年後半を目標としています。

ロードマップの詳細は `ROADMAP.md` を、進捗状況は GitHub Projects を参照してください。

**アルファ段階の既知の制約は [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md) に正直に列挙しています。** 特に利用前に知っておくべき3点：**`stratum+v2://` は平文です**（Noise NX の実装は存在しますが、どの実接続にも配線されていません。暗号化が必要なら `stratum+v2tls://` を使ってください——§2）、**組み込みの既定プールのホストは現在解決しません**（プール設定が必須。§20）、**GPU は検出のみで採掘には使えず、ASIC は検出されません**（§4・§8）。全22項目で「設計上の意図」と「未実装」を区別しています。

The known limitations of this alpha are listed honestly in [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md). Three are worth knowing before you start: **`stratum+v2://` is plaintext** — the Noise NX handshake exists but is wired into no live connection, so use `stratum+v2tls://` if you need confidentiality (§2); **the built-in default pool host does not resolve**, so configuring a pool is mandatory (§20); and **GPUs are detected but cannot mine, while ASICs are not detected at all** (§4, §8). Please read it before relying on Otedama.

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
