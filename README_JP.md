# Otedama - 高性能暗号通貨マイニングソフトウェア

[![バージョン](https://img.shields.io/badge/version-2.1.4-blue.svg)](https://github.com/shizukutanaka/Otedama)
[![ライセンス](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Go バージョン](https://img.shields.io/badge/go-1.21+-red.svg)](https://golang.org)
[![ビルド状態](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/shizukutanaka/Otedama/actions)

Otedamaは、効率的で信頼性の高いマイニング運用のために設計されたプロフェッショナルグレードの暗号通貨マイニングソフトウェアです。最高のパフォーマンスを実現するためにGoで構築され、シンプルさ、効率性、保守性に重点を置いてCPU、GPU、ASICマイニングをサポートしています。

## 🚀 機能

### コアマイニング機能
- **アルゴリズムサポート**: SHA256d（ビットコイン）、追加アルゴリズム用のモジュラーアーキテクチャ
- **ハードウェアサポート**: CPU、GPU（NVIDIA/AMD）、ASICマイナー向けに最適化
- **Stratumプロトコル**: 暗号化付きの完全なStratum v1およびv2サポート
- **P2Pマイニング**: 分散型マイニングプール機能

### パフォーマンスと効率性
- **軽量設計**: 最適化されたメモリ管理による最小限のリソース使用
- **高速起動**: 効率的な初期化によるサブ秒起動時間
- **リアルタイムモニタリング**: オーバーヘッドなしの組み込みパフォーマンスメトリクス
- **自動最適化**: 自動ハードウェア検出と最適化

### エンタープライズ対応
- **高可用性**: 組み込みフェイルオーバーと接続回復
- **セキュリティファースト**: TLS暗号化、API認証、レート制限
- **本番環境モニタリング**: Prometheusメトリクス、ヘルスチェック、ロギング
- **簡単な設定**: シンプルなYAMLベースの設定

## 📋 要件

- Go 1.21以上
- Linux、macOS、またはWindows
- マイニングハードウェア（CPU/GPU/ASIC）
- マイニングプールへのネットワーク接続

## 🛠️ インストール

### ソースから

```bash
# リポジトリをクローン
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# バイナリをビルド
make build

# システムにインストール
make install
```

### Go Installを使用

```bash
go install github.com/shizukutanaka/Otedama/cmd/otedama@latest
```

### Docker

```bash
docker pull ghcr.io/shizukutanaka/otedama:latest
docker run -d --name otedama -v ./config.yaml:/config.yaml ghcr.io/shizukutanaka/otedama:latest
```

## ⚡ クイックスタート

### 1. 設定を作成

```bash
cp config.example.yaml config.yaml
```

`config.yaml`を編集:

```yaml
# 基本設定
mining:
  algorithm: SHA256d
  threads: 0  # 0 = 自動検出

pool:
  url: "stratum+tcp://pool.example.com:3333"
  user: "your_wallet_address.worker_name"
  password: "x"

api:
  enabled: true
  listen: "0.0.0.0:8080"

monitoring:
  enabled: true
  prometheus: true
```

### 2. マイニング開始

```bash
# プールマイニング（推奨）
./otedama start

# ソロマイニング
./otedama solo

# P2Pプールモード
./otedama p2p

# カスタム設定を使用
./otedama start --config /path/to/config.yaml
```

### 3. パフォーマンスの監視

```bash
# ステータス確認
./otedama status

# ログ表示
tail -f logs/otedama.log

# APIエンドポイント
curl http://localhost:8080/api/status
```

## 📊 パフォーマンス

Otedama v2.1.3は最大効率のために最適化されています：

- **メモリ使用量**: v2.1.2より60%削減
- **バイナリサイズ**: 50%小型化（約15MB）
- **起動時間**: <500ms
- **CPUオーバーヘッド**: モニタリングで<1%

## 🏗️ アーキテクチャ

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

## 🔧 高度な設定

### GPUマイニング

```yaml
mining:
  gpu_enabled: true
  gpu_devices: [0, 1]  # 特定のGPUまたは[]ですべて
  intensity: 20        # 1-25、高いほどリソース使用増
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

## 📡 APIリファレンス

### RESTエンドポイント

- `GET /api/status` - マイニングステータス
- `GET /api/stats` - 詳細な統計
- `GET /api/workers` - ワーカー情報
- `POST /api/mining/start` - マイニング開始
- `POST /api/mining/stop` - マイニング停止

### WebSocket

リアルタイム更新のために`ws://localhost:8080/api/ws`に接続。

## 🐳 デプロイメント

### Docker Compose

```yaml
version: '3.8'
services:
  otedama:
    image: ghcr.io/shizukutanaka/otedama:latest
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

## 🤝 貢献

貢献を歓迎します！詳細は[貢献ガイド](CONTRIBUTING.md)をご覧ください。

1. リポジトリをフォーク
2. フィーチャーブランチを作成（`git checkout -b feature/amazing-feature`）
3. 変更をコミット（`git commit -m 'Add amazing feature'`）
4. ブランチにプッシュ（`git push origin feature/amazing-feature`）
5. プルリクエストを開く

## 📄 ライセンス

このプロジェクトはMITライセンスの下でライセンスされています - 詳細は[LICENSE](LICENSE)ファイルをご覧ください。

## 🙏 謝辞

- マイニングプロトコルのBitcoin Core開発者
- 優れたライブラリのGoコミュニティ
- Otedamaのすべての貢献者とユーザー

## 📞 サポート

- **問題**: [GitHub Issues](https://github.com/shizukutanaka/Otedama/issues)
- **ディスカッション**: [GitHub Discussions](https://github.com/shizukutanaka/Otedama/discussions)
- **Wiki**: [ドキュメント](https://github.com/shizukutanaka/Otedama/wiki)

## 💰 寄付

Otedamaが役立つと思われる場合は、開発のサポートをご検討ください：

**ビットコイン (BTC)**: `1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa`

皆様のサポートがOtedamaの維持と改善に役立ちます！

---

**⚠️ 重要**: 暗号通貨マイニングは大量の計算リソースと電力を消費します。マイニングを開始する前に、コストと環境への影響を理解してください。