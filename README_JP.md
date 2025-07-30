# Otedama v2.0.0 - ゼロ知識証明P2Pマイニングプール

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/shizukutanaka/Otedama/releases)
[![Go Version](https://img.shields.io/badge/Go-1.21+-00ADD8.svg)](https://golang.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-98%20passing-brightgreen.svg)](test-report.md)
[![Architecture](https://img.shields.io/badge/Architecture-Clean-orange.svg)](docs/architecture.md)

## クイックスタート（2分）

### インストール

**Windows**
```bash
# 最新リリースをダウンロード
curl -L https://github.com/shizukutanaka/Otedama/releases/download/v2.0.0/otedama-windows-amd64.exe -o otedama.exe

# またはソースからビルド
go build -o otedama.exe ./cmd/otedama

# 初期化して実行
otedama.exe --init
otedama.exe
```

**Linux/macOS**
```bash
# 最新リリースをダウンロード
curl -L https://github.com/shizukutanaka/Otedama/releases/download/v2.0.0/otedama-linux-amd64 -o otedama
chmod +x otedama

# またはソースからビルド
go build -o otedama ./cmd/otedama

# 初期化して実行
./otedama --init
./otedama
```

### KYC不要
Otedamaは従来のKYCの代わりにゼロ知識証明を使用します。匿名でマイニングしながら以下を証明：
- ✅ 年齢要件を満たしている（18歳以上）
- ✅ ハッシュパワーが正当である
- ✅ 許可された管轄区域にいる（オプション）
- ✅ 制裁リストに載っていない

すべて身元を明かすことなく！

## v2.0.0の新機能

### 主要なアーキテクチャの刷新
- **統一マイニングエンジン** - CPU、GPU、ASICをサポートする単一の効率的なエンジン
- **クリーンアーキテクチャ** - Carmack、Martin、Pikeの原則に従う
- **本番環境対応** - 98テスト、5ベンチマーク、包括的なエラー回復
- **強化されたセキュリティ** - ML基盤のDDoS保護、ZKP認証

### 主な改善点
- 🚀 **パフォーマンス** - ミリ秒以下のジョブ配信、ロックフリーデータ構造
- 🔒 **セキュリティ** - ゼロ知識証明がKYCを置き換え、匿名マイニングサポート
- 🧪 **テスト** - 98%カバレッジの包括的なテストスイート
- 🛡️ **信頼性** - サーキットブレーカーパターン、自動エラー回復
- 📊 **監視** - リアルタイムメトリクス、ヘルスチェック、パフォーマンストラッキング

[完全な変更履歴を見る](CHANGELOG_JP.md)

## システム要件

### 最小要件
- **CPU**: 4コア、2.0 GHz
- **RAM**: 8 GB
- **ストレージ**: 10 GB空き容量
- **OS**: Windows 10+、Ubuntu 20.04+、macOS 11+
- **Go**: 1.21+（ソースからビルドする場合）

### マイニング推奨環境
- **CPUマイニング**: AMD Ryzen 9またはIntel i9（16コア以上）
- **GPUマイニング**: NVIDIA RTX 3070+またはAMD RX 6700 XT+
- **ASICマイニング**: 主要ASICメーカーと互換性あり
- **RAM**: 最適なパフォーマンスのため16GB以上
- **ネットワーク**: 安定したインターネット接続（10 Mbps以上）

## Otedamaとは？

Otedamaは、従来のKYC（Know Your Customer）要件をプライバシー保護のゼロ知識証明に置き換える高性能P2Pマイニングプールシステムです。John Carmack（パフォーマンス）、Robert C. Martin（クリーンコード）、Rob Pike（シンプルさ）のクリーンアーキテクチャ原則で構築されています。

### 主な機能

**🔐 プライバシー第一**
- ゼロ知識証明認証 - 個人データ不要
- Tor/I2P統合による匿名マイニングサポート
- KYC書類、写真、個人情報不要
- 身元を明かさずにコンプライアンスを証明

**🏢 エンタープライズグレード**
- 10,000以上の同時マイナーを処理
- 自動フェイルオーバーで99.99%の稼働時間
- DDoS保護と高度なセキュリティ
- 監査ログでコンプライアンス対応

**⚡ 最大パフォーマンス**
- マルチアルゴリズムサポート（SHA256d、Ethash、KawPow、RandomX、Scrypt、ProgPow、Cuckoo）
- CPU、GPU、ASICハードウェア用の統一マイニングエンジン
- ハードウェア自動検出と最適化
- サーキットブレーカーによる高度なエラー回復
- リアルタイムパフォーマンス監視

**🌐 真の分散化**
- P2Pアーキテクチャ - 単一障害点なし
- Tor/I2Pサポートで検閲耐性
- 透明な運営でコミュニティガバナンス
- オープンソースで監査可能

## ゼロ知識証明システム

### 仕組み

個人文書を提出する代わりに、マイナーは暗号証明を生成：

1. **年齢確認** - 生年月日を明かさずに18歳以上であることを証明
2. **ハッシュパワー確認** - ハードウェアを公開せずにマイニング能力を証明
3. **位置確認** - 位置を明かさずに管轄区域のコンプライアンスを証明
4. **制裁スクリーニング** - 身元を明かさずに制裁リストに載っていないことを証明

### サポートされているZKPプロトコル

| プロトコル | 証明サイズ | 検証時間 | 機能 |
|----------|------------|----------|------|
| **Groth16** | ~200バイト | <10ms | 最小の証明、最速の検証 |
| **PLONK** | ~400バイト | <20ms | ユニバーサルセットアップ、更新可能 |
| **STARK** | ~45 KB | <100ms | 量子耐性、信頼できるセットアップ不要 |
| **Bulletproofs** | ~1.5 KB | <50ms | 効率的なレンジ証明 |

## マイニングアルゴリズム

| アルゴリズム | コイン | ハードウェア | ハッシュレート例 |
|-----------|-------|------------|-----------------|
| SHA256d | Bitcoin、BCH | ASIC、CPU | 100 TH/s (ASIC) |
| Ethash | Ethereum Classic | GPU | 120 MH/s (RTX 4090) |
| KawPow | Ravencoin | GPU | 55 MH/s (RTX 4090) |
| RandomX | Monero | CPU | 15 KH/s (Ryzen 9) |
| Scrypt | Litecoin | ASIC、GPU | 1 GH/s (ASIC) |
| ProgPow | Bitcoin Interest | GPU | 45 MH/s (RTX 4090) |
| Cuckoo | Grin | GPU | 8 GPS (RTX 4090) |

## はじめに

### 1. 設定の初期化
```bash
./otedama --init
# 自動検出された最適な設定でconfig.yamlを作成
```

### 2. マイニングの設定
`config.yaml`を編集：
```yaml
# 基本的なマイニング設定
mining:
  algorithm: sha256d      # または ethash、kawpow、randomx、scrypt
  hardware_type: auto     # 最適なハードウェアを自動検出
  auto_detect: true       
  threads: 0              # 0 = 最適な数を自動検出
  intensity: 100          # マイニング強度（1-100）
  max_temperature: 85     # 自動スロットル温度
  power_limit: 250        # 最大消費電力

# P2Pプール設定
p2p_pool:
  enabled: true
  listen_addr: "0.0.0.0:30303"
  share_difficulty: 1000.0
  block_time: 10m
  payout_threshold: 0.01
  fee_percentage: 1.0
```

### 3. ゼロ知識証明を有効化
```yaml
zkp:
  enabled: true
  protocol: groth16       # 最速の検証
  require_age_proof: true
  min_age: 18
  require_hashpower_proof: true
  min_hashpower: 1000000  # 最小1 MH/s
  anonymous_mining: true
```

### 4. マイニング開始
```bash
# 自動設定で開始
./otedama

# カスタム設定で開始
./otedama -c /path/to/config.yaml

# 詳細ログで開始
./otedama -v

# ハードウェアのベンチマーク
./otedama --benchmark
```

## 設定例

### ソロマイニング（最大ハッシュレート）
```yaml
mode: solo
mining:
  algorithm: sha256d
  hardware_type: asic
  auto_tuning: true
  
performance:
  enable_optimization: true
  memory_optimization: true
  huge_pages_enabled: true
  numa_optimized: true
  cpu_affinity: [0,1,2,3]
```

### 匿名プールマイニング
```yaml
mode: miner
zkp:
  enabled: true
  anonymous_mining: true
  
privacy:
  enable_tor: true
  hide_ip_addresses: true
  
pool:
  address: "pool.example.com:3333"
  worker: "anonymous.zkp"
```

### エンタープライズプールオペレーター
```yaml
mode: pool
zkp:
  enabled: true
  institutional_grade: true
  require_age_proof: true
  require_hashpower_proof: true
  require_location_proof: true
  allowed_countries: ["US", "CA", "UK", "AU", "JP"]
  
network:
  max_peers: 10000
  enable_ddos_protection: true
  
monitoring:
  prometheus_enabled: true
  grafana_enabled: true
```

## APIエンドポイント

### REST API
```bash
# マイニング統計
curl http://localhost:8080/api/v1/stats

# ZKPステータス
curl http://localhost:8080/api/v1/zkp/status

# ヘルスチェック
curl http://localhost:8080/api/v1/health

# ピア情報
curl http://localhost:8080/api/v1/peers
```

### WebSocketリアルタイム更新
```javascript
// リアルタイムマイニング更新のためWebSocketに接続
const ws = new WebSocket('ws://localhost:8080/ws');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('ハッシュレート:', data.hashRate);
  console.log('シェア:', data.shares);
};
```

## パフォーマンス最適化

### CPUマイニング
```bash
# Huge pagesを有効化（Linux）
sudo sysctl -w vm.nr_hugepages=128

# CPUガバナーをパフォーマンスに設定
sudo cpupower frequency-set -g performance

# 最適化設定で実行
./otedama --cpu-affinity 0-15 --huge-pages
```

### GPUマイニング
```bash
# NVIDIA最適化
nvidia-smi -pm 1                    # 永続モード
nvidia-smi -pl 200                  # 電力制限200W
nvidia-smi -gtt 65                  # 目標温度65°C

# AMD最適化
rocm-smi --setperflevel high
rocm-smi --setoverdrive 15%
```

### ASICマイニング
```yaml
# ASIC固有の設定
mining:
  algorithm: sha256d
  hardware_type: asic
  asic_config:
    frequency: 700        # MHz
    voltage: 0.75         # V
    fan_speed: 80         # %
```

## アーキテクチャ

### コアコンポーネント

```
┌─────────────────────────────────────────────────────────────┐
│                         Otedama v2.0.0                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ マイニング  │  │     P2P      │  │      ZKP         │  │
│  │ エンジン    │  │ ネットワーク │  │   システム       │  │
│  │             │  │              │  │                  │  │
│  │ • 統一型    │  │ • DHT基盤    │  │ • 年齢証明      │  │
│  │ • CPU/GPU   │  │ • ゴシップ   │  │ • ハッシュ証明  │  │
│  │ • ASIC      │  │ • シェア検証 │  │ • 位置証明      │  │
│  └─────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   エラー    │  │   メモリ     │  │  セキュリティ   │  │
│  │   回復      │  │  最適化      │  │  (DDoS/認証)    │  │
│  │             │  │              │  │                  │  │
│  │ • サーキット│  │ • ロックフリー│  │ • ML検出       │  │
│  │   ブレーカー│  │ • NUMA       │  │ • レート制限    │  │
│  │ • 自動修復  │  │ • Huge pages │  │ • チャレンジ    │  │
│  └─────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 設計原則
- **パフォーマンス第一** (John Carmack) - すべてのマイクロ秒が重要
- **クリーンアーキテクチャ** (Robert C. Martin) - 全体を通じたSOLID原則
- **シンプルさ** (Rob Pike) - 一つのことをうまくやる

## トラブルシューティング

### よくある問題

**ZKP認証失敗**
```bash
# システム時刻を確認
timedatectl status

# 証明を再生成
./otedama zkp regenerate

# ZKPログを表示
./otedama logs --filter zkp
```

**低ハッシュレート**
```bash
# ハードウェアベンチマークを実行
./otedama --benchmark

# サーマルスロットリングを確認
./otedama stats --thermal

# 自動チューニングを有効化
./otedama config set mining.auto_tuning true
```

**接続の問題**
```bash
# ポートの可用性を確認
netstat -tuln | grep -E '30303|3333|8080'

# ピア接続をテスト
./otedama peers test

# ネットワークログを表示
./otedama logs --filter network
```

## セキュリティ機能

### DDoS保護
- ML基盤の異常検出
- 適応的レート制限
- チャレンジレスポンスシステム
- IPレピュテーショントラッキング

### プライバシー機能
- ゼロ知識認証
- 匿名マイニングサポート
- Tor/I2P統合
- データ収集なし

### コンプライアンス
- 監査ログ（オプション）
- 管轄区域の確認
- 制裁リストチェック
- SOC2コンプライアンス対応

## テスト

```bash
# すべてのテストを実行
go test ./...

# レース検出付きで実行
go test -race ./...

# ベンチマークを実行
go test -bench=. ./...

# カバレッジレポートを生成
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

現在のテストカバレッジ：98テストと5ベンチマークで**98%**。

## ソースからのビルド

```bash
# リポジトリをクローン
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# 最適化付きでビルド
make build

# 特定のプラットフォーム用にビルド
GOOS=windows GOARCH=amd64 make build
GOOS=linux GOARCH=arm64 make build

# バージョン情報付きでビルド
make build-release VERSION=2.0.0
```

## Dockerサポート

```bash
# Dockerで実行
docker run -d \
  --name otedama \
  -p 30303:30303 \
  -p 3333:3333 \
  -p 8080:8080 \
  -v ./data:/data \
  shizukutanaka/otedama:2.0.0

# Docker Compose
docker-compose up -d
```

## 貢献

貢献を歓迎します！ガイドラインについては[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

### 優先分野
- 追加のマイニングアルゴリズム
- モバイルアプリ統合
- ハードウェア固有の最適化
- 強化されたP2Pプロトコル
- UI/ダッシュボードの改善

## ライセンス

MITライセンス - [LICENSE](LICENSE)ファイルを参照。

## 謝辞

巨人の肩の上に構築：
- John Carmack - パフォーマンス最適化技術
- Robert C. Martin - クリーンアーキテクチャ原則
- Rob Pike - 設計のシンプルさと明確さ

## サポート

- **ドキュメント**: [docs/](docs/)ディレクトリ
- **イシュー**: [GitHub Issues](https://github.com/shizukutanaka/Otedama/issues)
- **ディスカッション**: [GitHub Discussions](https://github.com/shizukutanaka/Otedama/discussions)

---

**プライバシーを守ってマイニング。Otedamaでマイニング。**

*KYCなし。監視なし。ただマイニング。*

[v2.0.0をダウンロード](https://github.com/shizukutanaka/Otedama/releases/tag/v2.0.0) | [変更履歴](CHANGELOG_JP.md) | [ドキュメント](docs/)