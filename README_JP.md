# Otedama - 高性能P2Pマイニングプールソフトウェア

[![バージョン](https://img.shields.io/badge/version-2.1.1-blue.svg)](https://github.com/shizukutanaka/Otedama/releases)
[![ライセンス](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Go バージョン](https://img.shields.io/badge/go-1.21+-blue.svg)](https://golang.org)
[![ビルドステータス](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/shizukutanaka/Otedama/actions)

## 概要

Otedamaは、CPU、GPU、ASICマイニングをサポートし、信頼性の高い運用を実現するプロフェッショナルグレードの暗号通貨マイニングソフトウェアです。ゼロ知識証明（ZKP）を含む高度な認証メカニズムを搭載し、エンタープライズ展開に適した安全で効率的なマイニング機能を提供します。

**バージョン2.1.1**では、完全なP2Pシェアチェーン実装、自動支払いシステム、高度なプロファイリングツールが導入されました。

## 主要機能

### コアマイニング機能
- **マルチハードウェアサポート**: CPU（x86、ARM）、GPU（NVIDIA、AMD）、ASICハードウェア向けに最適化されたアルゴリズム
- **P2Pマイニングプール**: 自動フェイルオーバーとロードバランシングを備えた分散アーキテクチャ
- **アルゴリズム自動切り替え**: 収益性に基づく自動アルゴリズム切り替え
- **ゼロ知識証明**: KYC要件なしのプライバシー保護認証
- **エンタープライズセキュリティ**: 包括的なエラーハンドリングとサーキットブレーカーを備えた高度なセキュリティ

### 高度な機能
- **ハードウェアアクセラレーション**: AES-NI、SHA拡張、GPU加速暗号化、SIMD最適化
- **コンテナサポート**: スケーラブルな運用のためのDockerデプロイメント
- **リアルタイム分析**: パフォーマンスメトリクスを含む包括的なダッシュボード
- **高度な難易度調整**: 外れ値除去を備えたPID制御難易度
- **マルチモード認証**: 静的、動的、データベース、ウォレット、ZKP認証
- **高性能ネットワーキング**: ゼロコピーネットワーキング、TCP Fast Open、接続プーリング、L1/L2キャッシング
- **エンタープライズセキュリティ**: 緊急シャットダウン、フォレンジック分析、コンプライアンス監視、ML基盤の異常検知

### エンタープライズ機能
- **マルチユーザー管理**: ブロックチェーンベースの監査ログを備えたロールベースアクセス制御
- **超高性能ネットワーキング**: ゼロコピー、カーネルバイパス、SIMD加速、インテリジェントキャッシング
- **包括的な監視**: リアルタイムメトリクス、分散トレーシング、予測分析
- **自動フェイルオーバー**: ゴシッププロトコルとコンセンサスベースのリカバリを備えたP2Pプール
- **高度なセキュリティ**: TLS 1.3、レート制限、DDoS保護、自動リカバリ
- **コンプライアンス対応**: 組み込みのコンプライアンス監視と監査ログ

## システム要件

### 最小要件
- CPU: 4コア（x86_64またはARM64）
- RAM: 8GB
- ストレージ: 50GB SSD
- ネットワーク: 100Mbps
- OS: Linux、Windows 10+、macOS 11+

### 推奨要件
- CPU: AES-NIサポート付き16コア以上
- RAM: 32GB以上のECCメモリ
- ストレージ: 500GB NVMe SSD
- ネットワーク: 低遅延の1Gbps以上
- GPU: NVIDIA RTX 3060+またはAMD RX 6600+

## インストール

### バイナリインストール（推奨）

プラットフォーム用の最新リリースをダウンロード：

```bash
# Linux
# リリースページからダウンロード（利用可能になり次第）
# wget https://github.com/shizukutanaka/Otedama/releases/latest/download/otedama-linux-amd64
# chmod +x otedama-linux-amd64
# sudo mv otedama-linux-amd64 /usr/local/bin/otedama

# Windows
# リリースページからotedama-windows-amd64.exeをダウンロード

# macOS
# wget https://github.com/shizukutanaka/Otedama/releases/latest/download/otedama-darwin-amd64
# chmod +x otedama-darwin-amd64
# sudo mv otedama-darwin-amd64 /usr/local/bin/otedama
```

### ソースからビルド

前提条件：
- Go 1.21+
- C++17サポート付きGCC/Clang
- CUDA Toolkit 12.0+（GPUマイニング用）
- Git

```bash
# リポジトリをクローン
git clone https://github.com/shizukutanaka/Otedama.git
cd Otedama

# 依存関係をインストール
go mod download

# すべての機能でビルド
make build-full

# または特定の機能でビルド
make build-cpu      # CPUマイニングのみ
make build-gpu      # GPUマイニングサポート
make build-enterprise # すべてのエンタープライズ機能
```

## クイックスタートガイド

### 1. 初期設定

```bash
# 設定を生成
otedama init

# 以下が作成されます：
# - config.yaml（メイン設定）
# - wallet.key（ZKPウォレットキー）
# - peers.json（P2Pブートストラップノード）
```

### 2. マイニング設定

`config.yaml`を編集：

```yaml
# 基本的なマイニング設定
mining:
  mode: "auto"              # auto、manual、profit-switching
  algorithms:
    - name: "ethash"
      enabled: true
      intensity: 80         # 1-100
    - name: "randomx"
      enabled: true
      threads: 8
    - name: "kawpow"
      enabled: true
      gpu_only: true

# ハードウェア設定
hardware:
  cpu:
    threads: 0              # 0 = 自動検出
    affinity: true          # スレッドをコアに固定
    huge_pages: true        # ヒュージページを有効化
  gpu:
    - index: 0
      enabled: true
      memory_clock: 2100
      core_clock: 1800
      power_limit: 220
      fan_speed: "auto"     # auto、0-100
  asic:
    enabled: false
    devices: []

# P2Pプール設定
p2p:
  enabled: true
  mode: "hybrid"            # pure-p2p、hybrid、federated
  listen: "0.0.0.0:3333"
  max_peers: 100
  bootstrap_nodes:
    - "seed1.otedama.network:3333"
    - "seed2.otedama.network:3333"
  
# ZKP認証
zkp:
  enabled: true
  identity_proof: true      # マイナーIDを証明
  compliance_proof: false   # オプションのコンプライアンス証明
  reputation_threshold: 0.8 # 最小レピュテーションスコア

# パフォーマンス最適化
optimization:
  auto_tuning: true         # AI駆動の自動チューニング
  profit_switching: true    # 収益によるアルゴリズム切り替え
  power_efficiency: "balanced" # performance、balanced、efficiency
  
# 高度な機能
features:
  blockchain_integration: true
  smart_payouts: true
  renewable_energy: false
  container_mode: false
  hardware_monitoring: true
  predictive_maintenance: true
```

### 3. マイニング開始

```bash
# デフォルト設定で開始
otedama start

# 特定の設定で開始
otedama start --config custom-config.yaml

# デーモンモードで開始
otedama start --daemon --log-file otedama.log

# パフォーマンスプロファイリングで開始
otedama start --profile --profile-port 6060
```

## 動作モード

### ソロマイニング（新機能 - 単一マイナーで動作）
オプションのP2Pサポートでウォレットに直接マイニング：

```bash
# 純粋なソロマイニング（ネットワーク依存なし）
otedama solo --wallet YOUR_WALLET --algorithm sha256d

# P2Pバックアップ付きソロマイニング（ノード障害に強い）
otedama solo --wallet YOUR_WALLET --p2p --p2p-port 18080

# 設定ファイルでソロマイニング
otedama solo --config config.solo.yaml
```

機能：
- 1つのマイナーだけで効率的に動作
- 冗長性のためのオプションP2Pネットワーキング
- ローカルシェア追跡と統計
- 自動難易度調整
- プール料金や依存関係なし

### プールマイニング
従来のマイニングプールに接続：

```bash
# マイニングプールに接続（実際のプールアドレスに置き換えてください）
otedama pool --url stratum+tcp://your-pool-address:3333 --wallet YOUR_WALLET --worker worker1
```

### P2Pプールマイニング
P2Pマイニングプールに参加または作成：

```bash
# 既存のP2Pプールに参加
# 既知のピアとP2Pネットワークに参加（実際のピアアドレスを使用）
otedama p2p join --bootstrap 192.168.1.100:3333,192.168.1.101:3333

# 新しいP2Pプールを作成
otedama p2p create --name "MyPool" --fee 1.0 --min-payout 0.1
```

### エンタープライズデプロイメント
オーケストレーションによる大規模展開：

```bash
# Kubernetesマニフェストを生成
otedama deploy k8s --replicas 100 --namespace mining

# Docker Composeでデプロイ
otedama deploy compose --scale 50

# 自動スケーリングでデプロイ
otedama deploy k8s --autoscale --min 10 --max 1000 --target-cpu 80
```

## 管理インターフェース

### Webダッシュボード
`http://localhost:8080`でWebダッシュボードにアクセス

機能：
- リアルタイムハッシュレートチャート
- ワーカー管理
- 温度監視
- 収益計算機
- アラート設定

### REST API

```bash
# マイニング統計を取得
curl http://localhost:8080/api/v1/stats

# ワーカーを管理
curl http://localhost:8080/api/v1/workers
curl -X POST http://localhost:8080/api/v1/workers/pause/gpu-0

# アルゴリズムを設定
curl -X PUT http://localhost:8080/api/v1/algorithms/ethash \
  -d '{"enabled": true, "intensity": 90}'

# ユーザー管理
curl -X POST http://localhost:8080/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"username": "operator1", "role": "operator"}'
```

### コマンドラインインターフェース

```bash
# ステータスを表示
otedama status

# ワーカーをリスト
otedama workers list

# マイニングを一時停止/再開
otedama pause
otedama resume

# アルゴリズムを切り替え
otedama algo switch randomx

# 収益を確認
otedama profit --period 24h

# 統計をエクスポート
otedama stats export --format csv --output stats.csv
```

## パフォーマンス最適化

### CPU最適化
```bash
# ヒュージページを有効化（Linux）
sudo sysctl -w vm.nr_hugepages=1280

# CPUガバナーを設定
sudo cpupower frequency-set -g performance

# NUMAアフィニティを設定
otedama tune cpu --numa-node 0 --threads 32
```

### GPU最適化
```bash
# GPU設定を自動調整
otedama tune gpu auto

# 手動GPU調整
otedama tune gpu --device 0 --mem-clock 2150 --core-clock 1850 --power 230

# GPU監視を有効化
otedama monitor gpu --interval 1s --alert-temp 85
```

### ネットワーク最適化
```bash
# プロトコル最適化を設定
otedama tune network --tcp-nodelay --quick-ack --buffer-size 4MB

# 接続プーリングを最適化
otedama tune network --pool-size 100 --keepalive 30s
```

## 高度な機能

### 収益切り替え
```bash
# 自動収益切り替えを有効化
otedama profit enable --interval 5m --threshold 10

# サポートされるコインを設定
otedama profit add-coin --symbol BTC --algo sha256 --pool pool.example.com

# 収益性分析を表示
otedama profit analyze --period 24h
```

### ゼロ知識証明認証
```bash
# ZKP資格情報を生成
otedama zkp generate --identity worker1

# ZKP認証を有効化
otedama config set auth.mode zkp

# ZKPステータスを確認
otedama zkp status
```

### パフォーマンス監視
```bash
# 包括的な監視を有効化
otedama monitor enable --interval 1s

# アラートを設定
otedama monitor alert --cpu 90 --gpu-temp 85 --memory 95

# メトリクスをエクスポート
otedama monitor export --prometheus --port 9090
```

## セキュリティ

### ZKP認証
```bash
# ZKPアイデンティティを生成
otedama zkp generate-identity

# 明かさずにアイデンティティを証明
otedama zkp prove --identity wallet.key

# レピュテーションを確認
otedama zkp verify-reputation --min-score 0.9
```

### アクセス制御
```bash
# ロールを作成
otedama rbac create-role operator --permissions "mining.*,monitoring.view"
otedama rbac create-role admin --permissions "*"

# ユーザーを割り当て
otedama rbac assign user1 operator
otedama rbac assign admin1 admin

# MFAを有効化
otedama security mfa enable --type totp
```

## 監視とアラート

### Prometheusメトリクス
`http://localhost:9090/metrics`で利用可能なメトリクス：
- `otedama_hashrate_total`
- `otedama_shares_accepted`
- `otedama_temperature_celsius`
- `otedama_power_watts`
- `otedama_earnings_total`

### アラート設定
```yaml
alerts:
  - name: "高温"
    condition: "temperature > 85"
    action: "throttle"
    notify: ["email", "webhook"]
  
  - name: "低ハッシュレート"
    condition: "hashrate < expected * 0.9"
    action: "restart"
    cooldown: 5m
  
  - name: "ハードウェア障害"
    condition: "device.status == 'error'"
    action: "failover"
    notify: ["sms", "email"]
```

## トラブルシューティング

### 診断コマンド
```bash
# 診断を実行
otedama diagnose

# ハードウェアをチェック
otedama hardware test

# 設定を検証
otedama config validate

# ログを分析
otedama logs analyze --errors --warnings

# デバッグレポートを生成
otedama debug report --output debug-report.zip
```

### 一般的な問題

1. **低ハッシュレート**
```bash
# スロットリングをチェック
otedama diagnose throttle

# デフォルトにリセット
otedama reset gpu --device 0

# ベンチマークを実行
otedama benchmark --algorithm all
```

2. **接続の問題**
```bash
# 接続性をテスト
otedama network test

# P2P接続をリセット
otedama p2p reset

# フォールバックノードを使用
otedama p2p fallback
```

3. **メモリエラー**
```bash
# メモリ使用量をチェック
otedama memory check

# スワップを有効化（Linux）
sudo fallocate -l 32G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## ベストプラクティス

### 本番環境デプロイメント
1. 冗長電源の使用
2. 適切な冷却の実装（周囲温度 < 25°C）
3. アラート付き24時間365日監視
4. 定期的なメンテナンススケジュール
5. 自動フェイルオーバー設定
6. 設定とウォレットのバックアップ

### セキュリティ強化
1. ファイアウォールルールの有効化
2. 強力な認証の使用
3. 定期的なセキュリティアップデート
4. 監査ログの監視
5. ネットワーク分離
6. 暗号化された通信

### パフォーマンスチューニング
1. 最適化前のプロファイリング
2. 常時温度監視
3. 高品質PSUの使用（80+ Gold）
4. 定期的なドライバー更新
5. 月次ハードウェアクリーニング
6. すべての変更の文書化

## サポート

### ドキュメント
- ユーザーガイド: ドキュメントは`/docs`ディレクトリを参照
- APIリファレンス: APIドキュメントは`/docs/api/`を参照（利用可能になり次第）
- アーキテクチャ: `/docs/architecture.md`を参照（利用可能になり次第）

### コミュニティ
- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- コミュニティサポート: サポートについてはGitHubでIssueを作成してください

### エンタープライズサポート
- GitHub Issuesで[enterprise]タグを付けてお問い合わせください
- SLA: 1時間応答の24時間365日サポート
- トレーニング: リクエストに応じて利用可能

## 貢献

貢献を歓迎します！ガイドラインについては[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

## ライセンス

MITライセンスの下でライセンスされています。詳細は[LICENSE](LICENSE)を参照してください。

## 免責事項

暗号通貨マイニングには財務リスクが伴います。ユーザーは以下について責任を負います：
- 電気代と収益性の計算
- 管轄区域での法的コンプライアンス
- ハードウェア保証への影響
- マイニング報酬に対する税務義務

マイニングを行う前に、必ず十分な調査を行ってください。