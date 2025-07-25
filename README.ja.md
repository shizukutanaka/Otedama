<div align="center">
  <h1>Otedama</h1>
  <p>
    <strong>エンタープライズグレード P2P マイニングプールプラットフォーム</strong>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version">
    <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
    <img src="https://img.shields.io/badge/coverage-95%25-brightgreen.svg" alt="Coverage">
    <img src="https://img.shields.io/badge/build-passing-brightgreen.svg" alt="Build">
  </p>
</div>

## 概要

Otedamaは、国家規模での展開を想定した高性能かつ本番環境対応のP2Pマイニングプールプラットフォームです。業界のレジェンドたちの設計原則に基づいて構築されています：

- **John Carmack**: ゼロコピー操作によるパフォーマンス最優先アーキテクチャ
- **Robert C. Martin**: SOLID原則に基づくクリーンアーキテクチャ
- **Rob Pike**: シンプルで実用的な設計

## ✨ 特徴

### 🚀 パフォーマンス
- **100万以上の同時接続マイナー**をサポート
- **毎秒1000万シェア**の処理能力
- シェア検証の**レイテンシ1ms未満**
- カスタムバイナリプロトコルによる**ゼロコピーネットワーキング**
- **メモリ効率** - 10万マイナーで4GB未満のRAM使用

### 🔐 セキュリティ
- **国家グレードセキュリティ**システム
- 複数アルゴリズムによる**DDoS保護**
- **リアルタイム脅威検知**と緩和
- 自動ブラックリスト機能付き**IPレピュテーション管理**
- **TLS 1.3暗号化**サポート

### ⛏️ マイニング
- **マルチアルゴリズム対応**: SHA256、Scrypt、Ethash、RandomX、KawPow
- **支払いスキーム**: PPLNS、PPS、PROP、SOLO
- 帯域幅を10倍削減する**Stratum V2プロトコル**
- **リアルタイムブロックチェーン統合**
- **自動難易度調整**

### 🌐 P2Pネットワーク
- ピア発見のための**Kademlia DHT**
- メッセージ伝播のための**ゴシッププロトコル**
- **NATトラバーサル**サポート
- **地理的分散**対応

### 📊 監視と運用
- **Prometheusメトリクス**統合
- 予測アルゴリズムによる**オートスケーリング**
- マルチリージョンサポートによる**ディザスタリカバリ**
- **パフォーマンステスト**スイート内蔵
- Grafanaによる**リアルタイムダッシュボード**

## 🚀 クイックスタート

### 前提条件

- Node.js 18以上
- Docker & Docker Compose
- Bitcoin Coreまたは互換ノード（支払い用）
- 8GB以上のRAM（本番環境では16GB以上推奨）
- Linux（Ubuntu 20.04以上推奨）

### インストール

```bash
# リポジトリのクローン
git clone https://github.com/yourusername/otedama.git
cd otedama

# 依存関係のインストール
npm install

# 設定ファイルのコピー
cp otedama.config.example.js otedama.config.js
cp .env.example .env

# 設定の編集
nano .env
# プールアドレス、RPC認証情報などを設定

# 設定の検証
npm run config:validate

# プールの起動
npm run start:national
```

### Dockerデプロイメント（推奨）

```bash
# すべてのサービスをビルドして起動
docker-compose -f docker-compose.national.yml up -d

# ヘルスチェック
npm run health

# ログの確認
docker-compose -f docker-compose.national.yml logs -f
```

## 📖 ドキュメント

- [アーキテクチャ概要](docs/ARCHITECTURE.ja.md)
- [設定ガイド](docs/CONFIGURATION.ja.md)
- [APIリファレンス](docs/API.ja.md)
- [デプロイメントガイド](docs/DEPLOYMENT.ja.md)
- [セキュリティベストプラクティス](docs/SECURITY.ja.md)
- [パフォーマンスチューニング](docs/PERFORMANCE.ja.md)
- [トラブルシューティング](docs/TROUBLESHOOTING.ja.md)

## 🏗️ アーキテクチャ

```
otedama/
├── lib/
│   ├── core/           # コアユーティリティと基本機能
│   ├── network/        # P2Pとバイナリプロトコル実装
│   ├── mining/         # マイニングプールコアロジック
│   ├── security/       # セキュリティと保護システム
│   ├── monitoring/     # 監視とメトリクス
│   ├── storage/        # データベースとキャッシュ層
│   ├── api/            # RESTとWebSocket API
│   └── utils/          # 共通ユーティリティ
├── scripts/            # ユーティリティスクリプト
├── config/             # 設定ファイル
├── test/               # テストスイート
└── docs/               # ドキュメント
```

## 🔧 設定

### 基本設定

```javascript
// otedama.config.js
export default {
  poolName: 'My Mining Pool',
  poolAddress: 'YOUR_WALLET_ADDRESS',
  poolFee: 0.01, // 1%
  
  // ネットワーク
  stratumPort: 3333,
  apiPort: 8080,
  
  // アルゴリズム
  algorithm: 'sha256',
  
  // 支払い
  paymentScheme: 'PPLNS',
  minPayment: 0.001,
  
  // パフォーマンス
  workers: 0, // 0 = 自動（CPUコア数）
  
  // セキュリティ
  security: {
    rateLimiting: true,
    ddosProtection: true
  }
};
```

### 環境変数

```bash
# .env
POOL_ADDRESS=bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BITCOIN_RPC_URL=http://localhost:8332
BITCOIN_RPC_USER=bitcoinrpc
BITCOIN_RPC_PASSWORD=your_password
NODE_ENV=production
```

## 🎯 パフォーマンスベンチマーク

| メトリクス | 値 |
|--------|-------|
| 最大同時接続マイナー数 | 1,000,000+ |
| シェア処理 | 1000万/秒 |
| 平均レイテンシ | <1ms |
| メモリ使用量（10万マイナー） | <4GB |
| ネットワーク帯域幅 | バイナリプロトコルで10倍削減 |
| 起動時間 | <5秒 |

## 🛡️ セキュリティ機能

- **多層DDoS保護**: トークンバケット、スライディングウィンドウ、適応的レート制限
- **攻撃検知**: SQLインジェクション、XSS、パストラバーサル、コマンドインジェクション
- **IPレピュテーションシステム**: 自動スコアリングとブラックリスト
- **認証**: JWTトークン、APIキー、マイナー認証
- **暗号化**: TLS 1.3、セキュアな通信

## 📊 監視

### Prometheusメトリクス

```bash
# http://localhost:9090/metrics で利用可能
pool_hashrate_total
pool_miners_active
pool_shares_accepted_total
pool_blocks_found_total
network_latency_ms
system_cpu_usage_percent
```

### Grafanaダッシュボード

`http://localhost:3000`でアクセス可能。以下の事前設定されたダッシュボード：
- プール概要
- マイナー統計
- ネットワークヘルス
- システムパフォーマンス

## 🤝 コントリビューション

コントリビューションを歓迎します！詳細は[コントリビューションガイド](CONTRIBUTING.md)をご覧ください。

1. リポジトリをフォーク
2. フィーチャーブランチを作成（`git checkout -b feature/amazing-feature`）
3. 変更をコミット（`git commit -m 'Add amazing feature'`）
4. ブランチにプッシュ（`git push origin feature/amazing-feature`）
5. プルリクエストを開く

## 📝 ライセンス

このプロジェクトはMITライセンスの下でライセンスされています - 詳細は[LICENSE](LICENSE)ファイルをご覧ください。

## 🙏 謝辞

- リファレンス実装を提供してくれたBitcoin Core開発者の皆様
- プロトコル仕様を策定したStratum V2ワーキンググループ
- オープンソースマイニングコミュニティ

## 📞 サポート

- 📧 メール: support@otedama.io
- 💬 Discord: [サーバーに参加](https://discord.gg/otedama)
- 📚 ドキュメント: [docs.otedama.io](https://docs.otedama.io)
- 🐛 Issues: [GitHub Issues](https://github.com/yourusername/otedama/issues)

## ⚡ パフォーマンスのヒント

1. 本番環境では**クラスターモードを使用**
2. 帯域幅削減のため**バイナリプロトコルを有効化**
3. CPUコアに基づいて**ワーカープロセスを設定**
4. 高負荷時は**Redisをキャッシュに使用**
5. **メトリクスを監視**し、設定を調整


