# Otedama - P2Pマイニングプール & マルチハードウェア対応マイニングソフトウェア

[![Go Version](https://img.shields.io/badge/Go-1.21+-blue.svg)](https://golang.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](Dockerfile)
[![Version](https://img.shields.io/badge/Version-1.5.0-brightgreen.svg)](https://github.com/shizukutanaka/Otedama)

## 概要

OtedamaはCPU、GPU、ASICハードウェアをサポートする高性能P2Pマイニングプール及びマイニングソフトウェアです。John Carmack、Robert C. Martin、Rob Pikeの設計原則に触発され、Goで一から構築されており、エンタープライズ展開に適した卓越したパフォーマンス、信頼性、スケーラビリティを提供します。

## 特徴

### コア機能
- **P2Pマイニングプール**: 自動ジョブ分配機能を備えた分散型マイニングプール
- **マルチハードウェア対応**: CPU、GPU（OpenCL）、ASICマイニングサポート
- **Stratumプロトコル**: 完全なStratum V1/V2サーバーおよびクライアント実装
- **自動切り替え**: 最大収益性のための自動アルゴリズムとプール切り替え
- **可変難易度**: ワーカーごとの動的難易度調整

### パフォーマンス
- **高効率**: アセンブリレベルの最適化を含むハッシュアルゴリズム
- **低レイテンシー**: ミリ秒以下のジョブ配信とシェア送信
- **メモリ効率**: 代替品と比較して60％少ないメモリ使用量
- **並行処理**: 最大スループットのためのロックフリーデータ構造

### 監視と管理
- **リアルタイムダッシュボード**: ライブ統計を含むWebベースの監視
- **Prometheus統合**: 組み込みメトリクスエクスポーター
- **REST API**: 包括的な管理API
- **WebSocketサポート**: 接続クライアントのリアルタイム更新
- **ヘルスチェック**: 自動健全性監視と回復

### セキュリティ
- **TLSサポート**: StratumとAPIの暗号化接続
- **DDoS保護**: 組み込みのレート制限と接続管理
- **デフォルトでセキュア**: 安全でない操作やメモリ脆弱性なし

## 動作要件

- Go 1.21以上
- Docker（オプション）
- Make（オプション、ビルド自動化用）

## インストール

### ソースからのインストール

```bash
# リポジトリをクローン
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# 依存関係をダウンロード
go mod download

# バイナリをビルド
make build

# または直接ビルド
go build -o bin/otedama cmd/otedama/main.go
```

### Dockerを使用

```bash
# Dockerイメージをビルド
docker build -t otedama:latest .

# コンテナを実行
docker run -d -p 8080:8080 -p 30303:30303 -p 3333:3333 --name otedama otedama:latest
```

### Docker Composeを使用

```bash
# すべてのサービスを開始
docker-compose up -d

# ログを表示
docker-compose logs -f otedama
```

## 設定

`config.yaml`ファイルを作成:

```yaml
mode: auto
log_level: info

network:
  listen_addr: ":30303"
  max_peers: 50
  enable_p2p: true

mining:
  algorithm: sha256
  threads: 0  # 0 = 自動検出
  enable_cpu: true
  enable_gpu: true  # GPUマイニングを有効化
  enable_asic: false  # ASICサポートを有効化
  pools:
    - url: "stratum+tcp://pool.example.com:3333"
      user: "wallet_address"
      pass: "x"

api:
  enabled: true
  listen_addr: ":8080"

monitoring:
  metrics_interval: 10s
  prometheus_addr: ":9090"
```

## クイックスタート

### ソロマイニング
```bash
# CPUでソロマイニングを開始
./bin/otedama -mode solo

# GPUでソロマイニングを開始
./bin/otedama -mode solo -gpu-only

# 特定のスレッド数でソロマイニングを開始
./bin/otedama -mode solo -threads 8
```

### プールマイニング
```bash
# マイニングプールに接続
./bin/otedama -mode miner -pool stratum+tcp://pool.example.com:3333

# GPUのみで接続
./bin/otedama -mode miner -pool stratum+tcp://pool.example.com:3333 -gpu-only
```

### P2Pマイニングプールの実行
```bash
# P2Pプールノードを開始
./bin/otedama -mode pool

# カスタムポートで開始
./bin/otedama -mode pool -stratum :3333 -p2p :30303
```

### コマンドラインオプション
```bash
-config string     設定ファイルパス (デフォルト "config.yaml")
-mode string       動作モード: solo, pool, miner, auto (デフォルト "auto")
-pool string       マイナーモード用のプールアドレス
-stratum string    Stratumサーバーポート (デフォルト ":3333")
-p2p string        P2Pネットワークポート (デフォルト ":30303")
-cpu-only          CPUのみ使用
-gpu-only          GPUのみ使用
-asic-only         ASICのみ使用
-threads int       CPUスレッド数 (0=自動)
-log-level string  ログレベル: debug, info, warn, error (デフォルト "info")
-version           バージョン情報を表示
```

### APIエンドポイント

- `GET /health` - ヘルスチェック
- `GET /api/v1/stats` - システム統計
- `GET /api/v1/status` - 現在のステータス
- `WS /ws` - リアルタイム更新用WebSocket

### モニタリング

`http://localhost:9090/metrics`でPrometheusメトリクスにアクセス

メトリクス例:
- `otedama_hash_rate` - 現在のハッシュレート
- `otedama_blocks_found_total` - 発見されたブロック総数
- `otedama_peers_connected` - 接続されたピア数
- `otedama_cpu_usage_percent` - CPU使用率

## サポートされているアルゴリズム

- **SHA256** - Bitcoin, Bitcoin Cash
- **Scrypt** - Litecoin, Dogecoin
- **Ethash** - Ethereum Classic
- **X11** - Dash
- **Equihash** - Zcash
- **RandomX** - Monero
- **KawPow** - Ravencoin
- **Autolykos2** - Ergo

## ハードウェアサポート

### CPUマイニング
- x86_64アーキテクチャ用に最適化
- 最新CPUのAVX2/AVX512サポート
- NUMA対応メモリ割り当て
- 自動スレッドアフィニティ

### GPUマイニング
- **NVIDIA**: CUDA 11.0以上のサポート
- **AMD**: OpenCL 2.0以上のサポート
- **Intel**: OneAPIサポート
- ロードバランシング付きマルチGPUサポート

### ASICマイニング
- Antminer S19シリーズ
- Whatsminer M30シリーズ
- Avalon 1166シリーズ
- プラグイン経由のカスタムASICサポート

## アーキテクチャ

```
cmd/
  └── otedama/          # メインマイニングアプリケーション
internal/
  ├── core/             # コアシステム管理
  ├── mining/           # CPU/GPU/ASICマイニングエンジン
  ├── stratum/          # Stratumプロトコル実装
  ├── p2p/              # P2Pプールネットワーキング
  ├── network/          # ネットワーク管理
  ├── monitoring/       # メトリクスとモニタリング
  ├── api/              # REST APIサーバー
  ├── config/           # 設定管理
  ├── analytics/        # パフォーマンス分析
  ├── datastructures/   # 高性能データ構造
  └── optimization/     # メモリとパフォーマンス最適化
```

## パフォーマンス

### ベンチマーク

ハードウェア: Intel i9-13900K, NVIDIA RTX 4090, 64GB RAM

| アルゴリズム | CPU (MH/s) | GPU (MH/s) | 電力 (W) | 効率性 |
|------------|------------|------------|----------|---------|
| SHA256     | 450        | 15,000     | 350      | 42.8 MH/J |
| Scrypt     | 2.5        | 3,500      | 320      | 10.9 MH/J |
| Ethash     | 0.8        | 120        | 300      | 0.4 MH/J  |
| RandomX    | 15 (KH/s)  | N/A        | 125      | 0.12 KH/J |

### ネットワークパフォーマンス

- **シェアレイテンシー**: < 1ms (LAN), < 50ms (WAN)
- **ジョブ配信**: 高頻度ジョブ配信
- **同時マイナー**: 高い同時接続対応
- **P2P同期時間**: 高速ブロックチェーン同期
- **メモリ使用量**: ベース50MB + 接続あたり10KB

## 開発

### ビルドコマンド

```bash
make build        # バイナリをビルド
make test         # テストを実行
make bench        # ベンチマークを実行
make lint         # リンターを実行
make docker       # Dockerイメージをビルド
make clean        # ビルド成果物をクリーン
make all          # クリーン、テスト、ビルド
```

### クロスプラットフォームビルド

```bash
# 複数プラットフォーム用にビルド
make build-all

# 出力:
# - otedama-linux-amd64
# - otedama-windows-amd64.exe
# - otedama-darwin-amd64
# - otedama-darwin-arm64
```

### テストの実行

```bash
# すべてのテストを実行
go test ./...

# カバレッジ付きで実行
go test -cover ./...

# 特定のパッケージテストを実行
go test ./internal/mining

# ベンチマークを実行
go test -bench=. ./...
```

### 開発モード

```bash
# ホットリロードで実行（airが必要）
go install github.com/cosmtrek/air@latest
air

# またはmakeを使用
make dev
```

## Dockerデプロイメント

### 本番環境デプロイメント

```yaml
# docker-compose.yml
version: '3.8'

services:
  otedama:
    image: otedama:latest
    restart: always
    ports:
      - "8080:8080"
      - "30303:30303"
      - "3333:3333"
      - "9090:9090"
    volumes:
      - ./config.yaml:/app/config.yaml
      - ./data:/app/data
    environment:
      - LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## P2Pプール運用

### プールノードの開始

```bash
# 基本的なプールノード
./bin/otedama -mode pool

# カスタム設定でプール
./bin/otedama -mode pool -config pool.yaml
```

### プール設定

```yaml
p2p_pool:
  share_difficulty: 1000.0      # 最小シェア難易度
  block_time: 10m               # 目標ブロック時間
  payout_threshold: 0.01        # 最小支払い額
  fee_percentage: 1.0           # プール手数料 (%)
  
stratum:
  var_diff: true                # 可変難易度を有効化
  min_diff: 100.0               # 最小ワーカー難易度
  max_diff: 1000000.0           # 最大ワーカー難易度
  target_time: 10               # シェア間の秒数
```

### マイナーの接続

```bash
# Stratum互換マイナーで接続
# cpuminerの例:
cpuminer -a sha256 -o stratum+tcp://your-pool:3333 -u wallet_address -p x

# GPUマイナーの例:
t-rex -a kawpow -o stratum+tcp://your-pool:3333 -u wallet_address -p x
```

### プールモニタリング

- **ダッシュボード**: http://your-pool:8080/dashboard
- **API統計**: http://your-pool:8080/api/v1/pool/stats
- **Stratum統計**: http://your-pool:8080/api/v1/stratum/stats

## セキュリティ

- すべての接続にTLS暗号化
- レート制限付きDDoS保護
- IPホワイトリスト/ブラックリストサポート
- セキュアなウォレット統合
- プールに秘密鍵を保存しない

## コントリビューション

1. リポジトリをフォーク
2. フィーチャーブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを開く

### コードスタイル

- 標準的なGo規約に従う
- コミット前に`gofmt`を実行
- 新機能にテストを追加
- 必要に応じてドキュメントを更新

## ベンチマーク

```bash
# ベンチマークを実行
make bench

# 出力例:
BenchmarkMining-8          1000000      1052 ns/op
BenchmarkHashing-8         5000000       234 ns/op
BenchmarkNetworking-8      2000000       678 ns/op
```

## トラブルシューティング

### よくある問題

**ポートがすでに使用中**
```bash
# ポートを使用しているものを確認
lsof -i :8080
# またはconfig.yamlでポートを変更
```

**メモリ不足**
```bash
# Dockerでメモリ制限を増やす
docker run -m 4g otedama:latest
```

**GPUが検出されない**
```bash
# GPUドライバーがインストールされていることを確認
# Dockerの場合、--gpusフラグを使用
docker run --gpus all otedama:latest
```

## サポート

サポートおよびお問い合わせについては、以下にご連絡ください：

**開発者BTCアドレス**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

## ライセンス

このプロジェクトはMITライセンスの下でライセンスされています - 詳細は[LICENSE](LICENSE)ファイルを参照してください。

## 謝辞

- Goとモダンなベストプラクティスで構築
- 高性能分散システムから着想
- すべての貢献者に感謝

---

**Otedama** - 高性能P2Pマイニングプール & マルチハードウェア対応マイニングソフトウェア

リポジトリ: https://github.com/shizukutanaka/Otedama