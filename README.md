# Otedama

高性能P2Pマイニングプールソフトウェア

## 概要

Otedamaは、シンプルで効率的なP2P型マイニングプールソフトウェアです。個人から企業まで幅広く利用でき、高いパフォーマンスと安定性を提供します。

## 主な特徴

### マイニングプール機能
- **Stratum V1/V2対応** - 業界標準プロトコル完全サポート
- **マルチアルゴリズム対応** - SHA256、Scrypt、Ethash、RandomX等
- **自動難易度調整** - ワーカーごとの最適化
- **公平な報酬分配** - PPLNS/PPSシステム

### P2Pネットワーク
- **分散型アーキテクチャ** - 中央集権的な依存を排除
- **自動ピア発見** - 簡単なネットワーク参加
- **高速メッセージング** - バイナリプロトコルによる低遅延通信

### 報酬管理
- **カスタム支払いアドレス** - マイナーは任意のBTCアドレスで報酬受取可能
- **アドレス集約** - 複数のワーカーの報酬を一つのアドレスに集約
- **変更クールダウン** - セキュリティのため24時間の変更制限

### ハードウェアサポート
- **CPU最適化** - SIMD命令による高速化
- **GPU対応** - CUDA/OpenCLサポート
- **ASIC互換** - 標準プロトコル準拠

### スタンドアロンモード
- **ソロマイニング対応** - 一人でも完全なプールとして機能
- **自動スケーリング** - 参加者増加時にP2Pモードへ移行
- **簡単セットアップ** - 最小限の設定で開始可能

## システム要件

### 最小要件
- OS: Ubuntu 20.04+、Windows 10/11、macOS 10.15+
- CPU: 2コア以上
- RAM: 4GB以上
- ストレージ: 10GB以上
- Node.js: 18.0以上

### 推奨要件
- CPU: 8コア以上
- RAM: 16GB以上
- ストレージ: SSD 100GB以上
- ネットワーク: 1Gbps以上

## インストール

```bash
# リポジトリのクローン
git clone https://github.com/otedama/otedama.git
cd otedama

# 依存関係のインストール
npm install

# ネイティブモジュールのビルド（オプション）
npm run build:native
```

## 使用方法

### スタンドアロンプール起動

最も簡単な起動方法：

```bash
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --blockchain-url http://localhost:8332 \
  --blockchain-user rpcuser \
  --blockchain-pass rpcpass
```

### マイニングプール起動

```bash
# 基本的な起動
npm start

# カスタムポートで起動
node index.js --port 3333 --api-port 8080
```

### マイナーとして接続

```bash
# ローカルプールに接続
node index.js --mode miner \
  --pool localhost:3333 \
  --wallet YOUR_WALLET_ADDRESS
```

### 設定ファイル使用

```bash
# カスタム設定で起動
node index.js --config ./config/custom.json
```

## 設定

### 基本設定例 (config/default.json)

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
    "algorithms": ["sha256", "scrypt"],
    "autoSwitch": true
  }
}
```

### 環境変数

```bash
# .env ファイル例
NODE_ENV=production
POOL_PORT=3333
API_PORT=8080
P2P_PORT=6633
WALLET_ADDRESS=your_wallet_address
```

## API

### REST API

```bash
# プール統計
GET http://localhost:8080/api/stats

# マイナー情報
GET http://localhost:8080/api/miners

# 個別マイナー情報
GET http://localhost:8080/api/miner/:address

# 支払いアドレス更新
POST http://localhost:8080/api/miner/:address/payment-address
Content-Type: application/json
{
  "paymentAddress": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
}

# 支払い履歴
GET http://localhost:8080/api/payments/:address/history

# アドレス検証
POST http://localhost:8080/api/validate-address
Content-Type: application/json
{
  "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
}

# ヘルスチェック
GET http://localhost:8080/api/health
```

### WebSocket API

リアルタイム更新用：

```javascript
// 接続
const ws = new WebSocket('ws://localhost:8080/ws');

// 統計情報の購読
ws.send(JSON.stringify({ type: 'subscribe', channel: 'stats' }));
```

## マイナー設定

### 一般的なマイニングソフトウェア

#### CGMiner
```bash
cgminer -o stratum+tcp://pool.example.com:3333 -u YOUR_WALLET_ADDRESS -p x
```

#### BFGMiner
```bash
bfgminer -o stratum+tcp://pool.example.com:3333 -u YOUR_WALLET_ADDRESS -p x
```

#### XMRig (RandomX)
```bash
xmrig -o pool.example.com:3333 -u YOUR_WALLET_ADDRESS -p x
```

### カスタム支払いアドレスの設定

マイニングアドレスとは別のアドレスで報酬を受け取る場合：

```bash
# 1. マイニングアドレスで接続
cgminer -o stratum+tcp://pool.example.com:3333 -u MINING_ADDRESS -p x

# 2. APIで支払いアドレスを設定
curl -X POST http://pool.example.com:8080/api/miner/MINING_ADDRESS/payment-address \
  -H "Content-Type: application/json" \
  -d '{"paymentAddress": "YOUR_PAYMENT_ADDRESS"}'
```

複数のワーカーで同じ支払いアドレスを使用する場合、報酬は自動的に集約されます。

## パフォーマンスチューニング

### CPU最適化
```bash
# スレッド数指定
node index.js --threads 8

# CPUアフィニティ設定
taskset -c 0-7 node index.js
```

### メモリ最適化
```bash
# Node.jsヒープサイズ設定
node --max-old-space-size=4096 index.js
```

### データベース最適化
```bash
# SQLite最適化実行
npm run optimize-db
```

## 監視とメンテナンス

### ヘルスチェック
```bash
npm run health-check
```

### ログ確認
```bash
# 標準出力ログ
journalctl -u otedama -f

# ファイルログ
tail -f logs/otedama.log
```

### パフォーマンスベンチマーク
```bash
npm run benchmark
```

## トラブルシューティング

### 接続できない場合
1. ファイアウォール設定確認
2. ポート開放確認 (3333, 6633, 8080)
3. ブロックチェーンノードの接続確認

### ハッシュレートが低い場合
1. CPU/GPUドライバの更新
2. 電源管理設定の確認
3. 温度管理の確認

### シェアが拒否される場合
1. 難易度設定の確認
2. ネットワーク遅延の確認
3. マイナーソフトウェアの設定確認

## セキュリティ

### 推奨設定
- ファイアウォールで必要なポートのみ開放
- 強力なRPCパスワードの使用
- SSL/TLS証明書の設定（本番環境）
- 定期的なセキュリティアップデート

### DDoS対策
- レート制限機能内蔵
- 自動ブラックリスト機能
- 異常検知システム

## エンタープライズ機能

### クラスタリング
```bash
node index.js --enterprise \
  --cluster-workers 16 \
  --ha-nodes node1:5556,node2:5556
```

### 高可用性
- 自動フェイルオーバー
- データレプリケーション
- ロードバランシング

## 貢献

プルリクエストを歓迎します。大きな変更の場合は、まずissueを作成して議論してください。

## ライセンス

MIT License

## サポート

- GitHub Issues: バグ報告・機能要望
- ドキュメント: [docs/](docs/)
- コミュニティ: Discord/Forum

## 開発チーム

Otedama Team

---

詳細なドキュメントは [docs/](docs/) ディレクトリを参照してください。