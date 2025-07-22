# Otedama

高性能P2Pマイニングプール兼マイニングソフトウェア

## 概要

Otedamaは、CPU、GPU、ASICに対応した軽量で高速なマイニングプールソフトウェアです。P2P技術により分散型マイニングプールの構築が可能で、個人から企業まで幅広く利用できます。

## 主な特徴

- **スタンドアロン動作**: 一人でも完全なマイニングプールとして機能（新機能）
- **自動スケーリング**: ソロマイニングからP2Pプールへ自動移行
- **マルチアルゴリズム対応**: SHA256、Scrypt、Ethash、RandomX、KawPow等の主要アルゴリズムに対応
- **ハードウェア最適化**: CPU、GPU、ASIC各種に最適化されたマイニング
- **P2P分散型**: 中央サーバー不要の完全分散型マイニングプール
- **自動切り替え**: 収益性に基づく自動アルゴリズム切り替え
- **リアルタイム監視**: WebUIによるリアルタイム統計とモニタリング
- **高速処理**: ネイティブC++実装による高速シェア検証
- **企業対応**: 国家レベルの大規模運用にも対応可能なスケーラビリティ

## システム要件

### 最小要件
- OS: Windows 10/11、Ubuntu 20.04+、macOS 10.15+
- CPU: 2コア以上
- RAM: 4GB以上
- ストレージ: 10GB以上の空き容量
- ネットワーク: 安定したインターネット接続

### 推奨要件
- CPU: 8コア以上
- RAM: 16GB以上
- ストレージ: SSD 100GB以上
- ネットワーク: 1Gbps以上の回線

## インストール

### 1. リポジトリのクローン

```bash
git clone https://github.com/yourusername/otedama.git
cd otedama
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. ビルド（必要な場合）

```bash
npm run build:native
```

## 使用方法

### スタンドアロンモード（新機能）

一人でも完全なマイニングプールとして機能し、他のノードが参加すると自動的にP2Pネットワークを形成します：

```bash
# スタンドアロンプールを起動（ソロマイニングから開始）
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --blockchain-url http://localhost:8332 \
  --blockchain-user your_rpc_user \
  --blockchain-pass your_rpc_password
```

詳細は [STANDALONE_POOL.md](STANDALONE_POOL.md) を参照してください。

### 従来のマイニングプールとして起動

```bash
# デフォルト設定で起動
npm start

# カスタム設定で起動
npm start -- --config ./config/custom-config.json
```

### マイナーとして接続

```bash
# ローカルプールに接続
npm run miner -- --pool localhost:3333 --wallet YOUR_WALLET_ADDRESS

# 外部プールに接続
npm run miner -- --pool pool.example.com:3333 --wallet YOUR_WALLET_ADDRESS
```

### エンタープライズモードで起動

大規模運用向けの高度な機能を有効にします：

```bash
# クラスタリング対応
npm start -- --enterprise --cluster-workers 8

# 高可用性構成
npm start -- --enterprise --ha-nodes node1.example.com:5556,node2.example.com:5556

# フル機能有効化
npm start -- --enterprise --cluster-workers 16 --shard-count 32 --ha-nodes node1:5556,node2:5556
```

## エンタープライズ機能

### クラスタリング
- 複数のワーカープロセスによる負荷分散
- 自動フェイルオーバー
- リアルタイム負荷分散

### データベースシャーディング
- 数百万のシェアを効率的に処理
- 水平スケーリング対応
- 自動データ分散

### 高可用性（HA）
- Raftコンセンサスアルゴリズム
- 自動マスター選出
- データレプリケーション

### エンタープライズモニタリング
- リアルタイムメトリクス収集
- アラート機能
- パフォーマンスレポート生成

### キャッシュレイヤー
- 高速データアクセス
- LRUキャッシュ管理
- 分散キャッシュ対応

## 設定

### 基本設定ファイル (config/default.json)

```json
{
  "pool": {
    "port": 3333,
    "difficulty": 16,
    "payoutInterval": 3600000,
    "minPayout": 0.001,
    "fee": 0.01
  },
  "p2p": {
    "port": 6633,
    "maxPeers": 50
  },
  "mining": {
    "algorithms": ["sha256", "scrypt", "ethash"],
    "autoSwitch": true
  }
}
```

詳細な設定については [CONFIGURATION.md](CONFIGURATION.md) を参照してください。

## API

### RESTful API

```bash
# プール統計の取得
GET /api/v1/stats

# マイナー情報の取得
GET /api/v1/miners/:address

# 支払い履歴の取得
GET /api/v1/payments/:address
```

### WebSocket API

```javascript
// リアルタイム統計の購読
ws://localhost:3334/stats

// マイニングイベントの購読
ws://localhost:3334/mining
```

詳細なAPIドキュメントは [API_REFERENCE.md](API_REFERENCE.md) を参照してください。

## 監視とダッシュボード

### Web UIアクセス

ブラウザで以下のURLにアクセス:
```
http://localhost:8080
```

### コマンドラインモニタリング

```bash
# リアルタイム統計表示
npm run monitor

# ログ表示
npm run logs
```

## パフォーマンスチューニング

### CPU最適化

```bash
# CPUアフィニティの設定
npm start -- --cpu-affinity 0,1,2,3

# スレッド数の指定
npm start -- --threads 8
```

### メモリ最適化

```bash
# メモリプールサイズの設定
npm start -- --memory-pool 2048

# キャッシュサイズの設定
npm start -- --cache-size 512
```

## トラブルシューティング

### 接続できない場合

1. ファイアウォール設定を確認
2. ポートが使用されていないか確認
3. ネットワーク設定を確認

### パフォーマンスが低い場合

1. ハードウェアスペックを確認
2. 他のプロセスがリソースを使用していないか確認
3. 設定の最適化を実施

詳細は [docs/SETUP.md](docs/SETUP.md) を参照してください。

## セキュリティ

- すべての通信はTLS/SSLで暗号化
- DDoS攻撃対策機能搭載
- 不正なシェア検出機能
- 自動ブラックリスト機能

## ライセンス

MIT License

## サポート

### ドキュメント

- [セットアップガイド](docs/SETUP.md)
- [設定ガイド](CONFIGURATION.md)
- [APIリファレンス](API_REFERENCE.md)
- [デプロイメントガイド](DEPLOYMENT.md)

### コミュニティ

- GitHub Issues: バグ報告や機能要望
- Discord: リアルタイムサポート
- Forum: 技術的な議論

## 貢献

プルリクエストを歓迎します。大きな変更の場合は、まずissueを作成して変更内容について議論してください。

## 更新履歴

最新の更新情報は [CHANGELOG.md](CHANGELOG.md) を参照してください。