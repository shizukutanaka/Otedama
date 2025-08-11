# Otedama - エンタープライズグレード P2Pマイニングプール＆マイニングソフトウェア

**バージョン**: 2.1.6  
**ライセンス**: MIT  
**Go バージョン**: 1.21以上  
**アーキテクチャ**: P2Pプール対応マイクロサービス  
**リリース日**: 2025年8月6日

Otedamaは、最高の効率性と信頼性を実現するために設計されたエンタープライズグレードのP2Pマイニングプールおよびマイニングソフトウェアです。John Carmack（パフォーマンス）、Robert C. Martin（クリーンアーキテクチャ）、Rob Pike（シンプリシティ）の設計原則に従い、国家レベルのスケーラビリティを備えた包括的なCPU/GPU/ASICマイニングをサポートしています。

## アーキテクチャ概要

### P2Pマイニングプール
- **分散型プール管理**: 自動フェイルオーバー機能を備えた分散マイニングプール
- **報酬分配システム**: マルチ通貨対応の高度なPPS/PPLNSアルゴリズム
- **フェデレーションプロトコル**: 耐障害性向上のためのプール間通信
- **国家レベル監視**: 政府機関での運用に適したエンタープライズ監視

### マイニング機能
- **マルチアルゴリズム**: SHA256d、Ethash、RandomX、Scrypt、KawPow
- **汎用ハードウェア対応**: 最適化されたCPU、GPU（CUDA/OpenCL）、ASICサポート
- **高度なStratum**: 高性能マイナー向け拡張機能を備えたv1/v2完全対応
- **ゼロコピー最適化**: キャッシュアウェアなデータ構造とNUMAアウェアメモリ

### エンタープライズ機能
- **本番環境対応**: オートスケーリング対応のDocker/Kubernetesデプロイメント
- **エンタープライズセキュリティ**: DDoS防御、レート制限、包括的な監査機能
- **高可用性**: 自動フェイルオーバーを備えたマルチノード構成
- **リアルタイム分析**: ライブダッシュボード統合のWebSocket API

## システム要件

- Go 1.21以上
- Linux、macOS、またはWindows
- マイニングハードウェア（CPU/GPU/ASIC）
- マイニングプールへのネットワーク接続

## インストール

### ソースからのビルド

```bash
# ソースディレクトリからビルド
cd Otedama

# バイナリをビルド
make build

# システムにインストール
make install
```

### Go Buildを使用

```bash
go build ./cmd/otedama
```

### Docker本番環境

```bash
# 本番環境デプロイメント
docker build -f Dockerfile.production -t otedama:production .
docker run -d --name otedama \
  -v ./config.yaml:/app/config/config.yaml:ro \
  -v otedama_data:/app/data \
  -p 3333:3333 -p 8080:8080 \
  otedama:production
```

### Kubernetes

```bash
# 完全なスタックをデプロイ
kubectl apply -f k8s/
```

## クイックスタートガイド

### 1. 設定

```yaml
# P2Pプール対応の本番環境設定
app:
  name: "Otedama"
  mode: "production"

mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0 # 自動検出
    priority: "normal"
  
  gpu:
    devices: [] # 全デバイスを自動検出
    intensity: 20
    temperature_limit: 85
  
  asic:
    devices: [] # 自動探索
    poll_interval: 5s

pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 10000
  fee_percentage: 1.0
  rewards:
    system: "PPLNS"
    window: 2h

stratum:
  enable: true
  address: "0.0.0.0:3333"
  max_workers: 10000
  
api:
  enable: true
  address: "0.0.0.0:8080"
  auth:
    enabled: true
    token_expiry: 24h

monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
  health:
    enabled: true
    address: "0.0.0.0:8081"
```

### 2. デプロイメントオプション

```bash
# 開発環境
./otedama serve --config config.yaml

# 本番環境Docker
docker-compose -f docker-compose.production.yml up -d

# エンタープライズKubernetes
kubectl apply -f k8s/

# 手動本番環境デプロイメント
sudo ./scripts/production-deploy.sh
```

### 3. パフォーマンス監視

```bash
# ステータス確認
./otedama status

# ログ表示
tail -f logs/otedama.log

# APIエンドポイント
curl http://localhost:8080/api/status
```

## パフォーマンスメトリクス

Otedamaは最高の効率性を実現するよう最適化されています：

- **メモリ使用量**: 最小限のメモリフットプリントに最適化
- **バイナリサイズ**: コンパクトなサイズ（約15MB）
- **起動時間**: <500ms
- **CPUオーバーヘッド**: 監視時<1%

## プロジェクト構造

```
otedama/
├── cmd/           # CLIアプリケーション
├── internal/      # コア実装
│   ├── mining/    # マイニングエンジン
│   ├── stratum/   # Stratumプロトコル
│   ├── api/       # REST/WebSocket API
│   ├── p2p/       # P2Pネットワーキング
│   └── ...        # その他のモジュール
└── config/        # 設定
```

## 高度な設定

### GPUマイニング

```yaml
mining:
  gpu_enabled: true
  gpu_devices: [0, 1]  # 特定のGPUまたは[]で全て
  intensity: 20        # 1-25、高いほどリソース使用量増
```

### 複数プール

```yaml
pool:
  backup_pools:
    - url: "stratum+tcp://backup1.example.com:3333"
      user: "wallet.worker"
    - url: "stratum+tcp://backup2.example.com:3333"
      user: "wallet.worker"
```

### セキュリティ

```yaml
security:
  enable_tls: true
  cert_file: "/path/to/cert.pem"
  key_file: "/path/to/key.pem"
  
api:
  api_key: "your-secure-api-key"
  rate_limit: 100  # 分あたりのリクエスト数
```

## APIリファレンス

### RESTエンドポイント

- `GET /api/status` - マイニングステータス
- `GET /api/stats` - 詳細統計情報
- `GET /api/workers` - ワーカー情報
- `POST /api/mining/start` - マイニング開始
- `POST /api/mining/stop` - マイニング停止

### WebSocket

リアルタイム更新は `ws://localhost:8080/api/ws` に接続してください。

## デプロイメント

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    build: .
    volumes:
      - ./config.yaml:/config.yaml
    ports:
      - "8080:8080"
      - "3333:3333"
    restart: unless-stopped
```

### Kubernetes

```bash
kubectl apply -f k8s/
```

### Systemd

```bash
sudo cp scripts/otedama.service /etc/systemd/system/
sudo systemctl enable otedama
sudo systemctl start otedama
```

## 貢献について

貢献を歓迎いたします。標準的な開発プラクティスに従ってください：

1. フィーチャーブランチを作成
2. 変更を実装
3. 徹底的にテスト
4. レビューのため提出

## ライセンス

本プロジェクトはMITライセンスの下でライセンスされています。詳細は[LICENSE](LICENSE)ファイルをご覧ください。

## 謝辞

- マイニングプロトコルに関するBitcoin Core開発者の皆様
- 優れたライブラリを提供するGoコミュニティ
- Otedamaの全ての貢献者およびユーザーの皆様

## サポート

- `docs/`ディレクトリのドキュメントをご確認ください
- `config.example.yaml`の設定例をご参照ください
- 実行時は`/api/docs`でAPIドキュメントをご覧いただけます

## 寄付

Otedamaが有用であると感じていただけた場合、開発支援をご検討ください：

**Bitcoin (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

皆様のご支援がOtedamaの維持と改善に役立ちます。

---

**重要**: 暗号通貨マイニングは大量の計算リソースと電力を消費します。マイニングを開始する前に、コストと環境への影響を十分にご理解ください。