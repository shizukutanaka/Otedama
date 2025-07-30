# Otedama - 高性能P2Pマイニングプールシステム

[![Go Version](https://img.shields.io/badge/go-1.21+-blue.svg)](https://golang.org/dl/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## 概要

Otedamaは、最大のパフォーマンス、信頼性、自動化を実現するために設計された次世代のP2Pマイニングプールシステムです。John Carmack（パフォーマンス最適化）、Robert C. Martin（クリーンアーキテクチャ）、Rob Pike（シンプリシティ）の原則に基づいて構築され、ゼロ知識証明認証を備えたエンタープライズグレードのマイニングインフラストラクチャを提供します。

## 主な機能

### コアマイニング機能
- **マルチアルゴリズム対応**: GPU（CUDA/OpenCL/Vulkan）、CPU、ASICマイニング
- **高度なアルゴリズム**: KawPow、VerusHash、Flux、カスタムWASMプラグイン
- **高性能エンジン**: ロックフリーデータ構造、GPU加速
- **スマートジョブ配布**: 効率的な作業配分とシェア検証

### P2Pネットワーク
- **分散アーキテクチャ**: 中央障害点のない真のピアツーピアマイニング
- **DHTベースの発見**: 自動ピア発見とネットワーク形成
- **地域別ロードバランシング**: 地理的位置に基づくインテリジェントルーティング
- **エンタープライズプール対応**: 大規模マイニング運用管理

### セキュリティとプライバシー
- **ZKP認証**: 従来のKYCに代わるゼロ知識証明システム
- **FIPS 140-2準拠**: エンタープライズグレードのセキュリティ標準
- **国家安全保障機能**: 高度な脅威検出と軽減
- **エンドツーエンド暗号化**: すべてのノード間の安全な通信

### 自動化とインテリジェンス
- **自己修復システム**: 自動問題検出と解決
- **オートスケーリング**: 負荷に基づく動的リソース割り当て
- **予測保守**: MLベースの障害予測
- **パフォーマンス最適化**: リアルタイムプロファイリングとボトルネック検出

### 高度な機能
- **WebAssemblyプラグイン**: WASMによるカスタムアルゴリズムサポート
- **カオスエンジニアリング**: 組み込み安定性テストフレームワーク
- **分散キャッシング**: Redisベースのキャッシングレイヤー
- **ゼロダウンタイム更新**: ブルーグリーン、カナリア、ローリングデプロイメント

## インストール

### 前提条件
- Go 1.21以上
- CUDA Toolkit（NVIDIA GPUサポート用）
- OpenCLドライバー（AMD GPUサポート用）
- Redis（分散キャッシング用）

### クイックスタート

```bash
# リポジトリをクローン
git clone https://github.com/yourusername/otedama.git
cd otedama

# 依存関係をインストール
go mod download

# プロジェクトをビルド
go build -o otedama cmd/otedama/main.go

# デフォルト設定で実行
./otedama

# カスタム設定で実行
./otedama -config config.yaml
```

## 設定

### 基本設定

```yaml
# config.yaml
mining:
  algorithms:
    - name: "kawpow"
      enabled: true
    - name: "verthash"
      enabled: true
  
  workers:
    gpu_threads: 2
    cpu_threads: 4

p2p:
  port: 30303
  max_peers: 50
  bootstrap_nodes:
    - "enode://..."

security:
  zkp_enabled: true
  encryption: "aes-256-gcm"
```

### 環境変数

```bash
OTEDAMA_LOG_LEVEL=info
OTEDAMA_DATA_DIR=/var/lib/otedama
OTEDAMA_METRICS_PORT=9090
```

## 使用方法

### マイニングノードの起動

```bash
# マイニングノードとして起動
./otedama mine --wallet YOUR_WALLET_ADDRESS

# 特定のアルゴリズムで起動
./otedama mine --algo kawpow --wallet YOUR_WALLET_ADDRESS

# GPU選択して起動
./otedama mine --gpu 0,1 --wallet YOUR_WALLET_ADDRESS
```

### プールの管理

```bash
# プールオペレーターとして起動
./otedama pool --fee 1.0 --min-payout 0.1

# プール統計を表示
./otedama stats

# パフォーマンスを監視
./otedama monitor
```

### CLIコマンド

```bash
# ノード管理
otedama node status        # ノードステータスを表示
otedama node peers         # 接続されたピアをリスト
otedama node sync          # 強制同期

# マイニング制御
otedama mining start       # マイニング開始
otedama mining stop        # マイニング停止
otedama mining benchmark   # パフォーマンスベンチマーク実行

# プール操作
otedama pool stats         # プール統計を表示
otedama pool miners        # アクティブマイナーをリスト
otedama pool payouts       # 支払い履歴を表示
```

## アーキテクチャ

### システムコンポーネント

```
┌─────────────────────────────────────────────────────────┐
│                     Otedamaシステム                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │ マイニング   │  │    P2P      │  │ セキュリティ │   │
│  │ エンジン     │  │ ネットワーク │  │   レイヤー   │   │
│  └─────────────┘  └─────────────┘  └─────────────┘   │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │   自動化     │  │ パフォーマンス│  │  監視      │   │
│  │  スイート    │  │ オプティマイザ│  │ システム    │   │
│  └─────────────┘  └─────────────┘  └─────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 設計原則

1. **パフォーマンス優先**（John Carmack）
   - ロックフリーデータ構造
   - GPU加速
   - メモリマップドファイル
   - ゼロコピー操作

2. **クリーンアーキテクチャ**（Robert C. Martin）
   - 依存性逆転
   - インターフェース分離
   - 単一責任
   - モジュラー設計

3. **シンプリシティ**（Rob Pike）
   - 明確で読みやすいコード
   - 最小限の依存関係
   - 直感的なAPI
   - 早すぎる最適化の回避

## パフォーマンス

### ベンチマーク

| コンポーネント | 操作 | パフォーマンス |
|-----------|-----------|-------------|
| ハッシュ検証 | GPU (RTX 3090) | 1000万ハッシュ/秒 |
| シェア処理 | ロックフリーキュー | 100万シェア/秒 |
| ネットワークスループット | P2P転送 | 10 Gbps |
| キャッシュヒット率 | 分散キャッシュ | 99.5% |

### 最適化のヒント

1. **GPUマイニング**
   - マイニング専用GPUを使用
   - 適切な冷却を確保
   - ドライバーを定期的に更新

2. **ネットワーク**
   - ファイアウォールで必要なポートを開く
   - 安定性のため有線接続を使用
   - マイニングトラフィック用のQoSを設定

3. **システム**
   - CPU省電力機能を無効化
   - パフォーマンスガバナーを使用
   - 十分なRAMを割り当て

## 開発

### ソースからのビルド

```bash
# 開発ビルド
make dev

# プロダクションビルド
make build

# テスト実行
make test

# ベンチマーク実行
make bench
```

### 貢献方法

1. リポジトリをフォーク
2. フィーチャーブランチを作成
3. 変更をコミット
4. ブランチにプッシュ
5. プルリクエストを作成

### コードスタイル

- Go標準フォーマットに従う
- 意味のある変数名を使用
- 包括的なテストを記述
- パブリックAPIを文書化

## モニタリング

### メトリクス

システムはポート9090でPrometheusメトリクスを公開：

- `otedama_hashrate_total` - 総ハッシュレート
- `otedama_shares_accepted` - 承認されたシェア
- `otedama_peers_connected` - 接続されたピア
- `otedama_mining_efficiency` - マイニング効率

### ロギング

複数レベルの構造化ロギング：

```bash
# ログレベルを設定
export OTEDAMA_LOG_LEVEL=debug

# ログフォーマットオプション
export OTEDAMA_LOG_FORMAT=json  # またはtext
```

## トラブルシューティング

### よくある問題

1. **GPUが検出されない**
   ```bash
   # GPUステータスを確認
   ./otedama gpu list
   
   # ドライバーを確認
   nvidia-smi  # NVIDIA用
   clinfo      # OpenCL用
   ```

2. **接続の問題**
   ```bash
   # 接続性をテスト
   ./otedama net test
   
   # ファイアウォールを確認
   sudo ufw status
   ```

3. **パフォーマンスの問題**
   ```bash
   # 診断を実行
   ./otedama diag
   
   # パフォーマンスをプロファイル
   ./otedama profile --duration 60s
   ```

## セキュリティ

### セキュリティ機能

- ゼロ知識証明認証
- エンドツーエンド暗号化
- DDoS保護
- レート制限
- 異常検出

### セキュリティ問題の報告

セキュリティの脆弱性は以下に報告してください: security@otedama.example.com

## ライセンス

このプロジェクトはMITライセンスの下でライセンスされています - 詳細は[LICENSE](LICENSE)ファイルを参照してください。

## 謝辞

- Bitcoin Core開発者
- Ethereumコミュニティ
- Goプログラミング言語チーム
- オープンソースマイニングソフトウェア貢献者

## サポート

- ドキュメント: https://docs.otedama.example.com
- Discord: https://discord.gg/otedama
- メール: support@otedama.example.com

---

Otedamaチームによって❤️を込めて構築