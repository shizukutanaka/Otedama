# Otedama

**全自動P2Pマイニングプール・DEX・DeFiプラットフォーム**

---

## 概要

Otedamaは、完全自動化された商用グレードのP2Pマイニングプール兼DEX兼DeFiプラットフォームです。John Carmack（パフォーマンス第一）、Robert C. Martin（クリーンアーキテクチャ）、Rob Pike（シンプリシティ）の設計哲学に基づいて開発されました。

### 主要機能

- **完全自動運営** - 運営側の介入一切不要
- **不変手数料システム** - 改変不可能な0.1% BTC自動徴収
- **マルチアルゴリズム対応** - CPU/GPU/ASIC対応
- **統合DEX** - V2 AMM + V3集中流動性
- **自動支払い** - 毎時間の自動マイナー報酬支払い
- **DeFi機能** - 自動清算、ガバナンス、ブリッジ
- **エンタープライズグレード** - 10,000+マイナー対応

### 運営自動化の特徴

1. **手数料の自動徴収**
   - BTCアドレス: ハードコード済み（不変）
   - プール手数料: 1.4%（改変不可）
   - 運営手数料: 0.1%（改変不可）
   - 合計手数料: 1.5%（完全固定）
   - 徴収頻度: 5分ごと自動実行
   - 全通貨をBTCに自動変換

2. **マイニング報酬の自動分配**
   - 毎時間自動実行
   - プール手数料自動控除
   - 最低支払額到達時に自動送金
   - トランザクション自動記録

3. **DEX/DeFiの完全自動化**
   - 流動性プールの自動リバランス
   - 自動清算処理（LTV 85%）
   - ガバナンス提案の自動実行
   - クロスチェーンブリッジの自動中継

---

## システム要件

### 最小要件
- Node.js 18以上
- RAM: 2GB
- ストレージ: 10GB SSD
- ネットワーク: 100Mbps

### 推奨要件
- CPU: 8コア以上
- RAM: 8GB以上
- ストレージ: 100GB NVMe SSD
- ネットワーク: 1Gbps

---

## インストール

### 1. 基本インストール

```bash
# リポジトリのクローン
git clone https://github.com/otedama/otedama.git
cd otedama

# 依存関係のインストール
npm install

# 起動
npm start
```

### 2. Dockerインストール

```bash
# Docker Composeで起動
docker-compose up -d

# ログ確認
docker-compose logs -f otedama
```

### 3. ワンクリックインストール

**Windows:**
```batch
.\quickstart.bat
```

**Linux/macOS:**
```bash
chmod +x quickstart.sh
./quickstart.sh
```

---

## 設定

### 基本設定

`otedama.json`を編集:

```json
{
  "pool": {
    "name": "あなたのプール名",
    "fee": 1.0,
    "minPayout": {
      "BTC": 0.001,
      "RVN": 100,
      "XMR": 0.1
    }
  },
  "mining": {
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "あなたのウォレットアドレス"
  }
}
```

### コマンドライン設定

```bash
# 基本起動
node index.js --wallet RYourWalletAddress --currency RVN

# 高性能設定
node index.js --threads 16 --max-miners 5000 --enable-dex

# カスタムポート
node index.js --api-port 9080 --stratum-port 4444
```

---

## マイナー接続

### 接続情報
- サーバー: `あなたのIP:3333`
- ユーザー名: `ウォレットアドレス.ワーカー名`
- パスワード: `x`

### マイナーソフト設定例

**T-Rex (NVIDIA):**
```bash
t-rex -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**TeamRedMiner (AMD):**
```bash
teamredminer -a kawpow -o stratum+tcp://YOUR_IP:3333 -u RWallet.worker1 -p x
```

**XMRig (CPU):**
```bash
xmrig -o YOUR_IP:3333 -u 4MoneroWallet -p x -a rx/0
```

---

## 対応通貨

| 通貨 | アルゴリズム | 最低支払額 | 手数料 |
|------|-------------|------------|---------|
| BTC | SHA256 | 0.001 BTC | 1.5% |
| RVN | KawPow | 100 RVN | 1.5% |
| XMR | RandomX | 0.1 XMR | 1.5% |
| ETC | Ethash | 1 ETC | 1.5% |
| LTC | Scrypt | 0.1 LTC | 1.5% |
| DOGE | Scrypt | 100 DOGE | 1.5% |
| KAS | kHeavyHash | 100 KAS | 1.5% |
| ERGO | Autolykos | 1 ERGO | 1.5% |

全通貨一律1.5%（プール1.4% + 運営0.1%）- 改変不可

---

## API

### RESTエンドポイント

```bash
# プール統計
GET /api/stats

# 手数料徴収状況
GET /api/fees

# マイナー情報
GET /api/miners/{minerId}

# DEX価格
GET /api/dex/prices

# システムヘルス
GET /health
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['stats', 'mining', 'dex']
}));
```

---

## 運営者向け情報

### 収益構造

1. **プール手数料**: 1.4%固定（改変不可）
2. **運営手数料**: 0.1%固定（改変不可）
3. **合計マイニング手数料**: 1.5%（完全固定）
4. **DEX手数料**: 0.3%（流動性プロバイダーへ分配）
5. **DeFi手数料**: レンディング金利の一部

### 自動化されたタスク

- **5分ごと**: 運営手数料のBTC変換・徴収
- **10分ごと**: DEXプールのリバランス
- **30分ごと**: DeFi清算チェック
- **1時間ごと**: マイナー報酬の自動支払い
- **24時間ごと**: データベース最適化・バックアップ

### モニタリング

ダッシュボード: `http://localhost:8080`

主要メトリクス:
- アクティブマイナー数
- ハッシュレート
- 手数料収入
- DEX取引量
- システムリソース

---

## セキュリティ

### 実装済み保護機能

1. **DDoS対策**
   - 多層レート制限
   - 適応型しきい値
   - チャレンジレスポンス

2. **認証システム**
   - JWT + MFA
   - ロールベースアクセス制御
   - APIキー管理

3. **改ざん防止**
   - 運営手数料アドレスの不変性
   - システム整合性チェック
   - 監査ログ

---

## トラブルシューティング

### ポートが使用中
```bash
# 使用中のプロセスを確認
netstat -tulpn | grep :8080

# プロセスを停止
kill -9 PID
```

### メモリ不足
```bash
# Node.jsメモリ上限を増やす
export NODE_OPTIONS="--max-old-space-size=8192"
```

### デバッグモード
```bash
DEBUG=* node index.js
```

---

## パフォーマンス最適化

### 最適化機能

- **データベースバッチング**: 70%高速化
- **ネットワーク最適化**: 40%帯域削減
- **高度なキャッシング**: 85%以上のヒット率
- **ゼロコピー操作**: マイニング処理の効率化

### ベンチマーク結果

```bash
# ベンチマーク実行
npm run benchmark

# 結果（8コア、16GB RAM）:
- データベース: 50,000+ ops/秒
- ネットワーク: 10,000+ msg/秒
- キャッシュヒット率: 85%+
- メモリ使用量: <100MB（基本）
```

---

## ライセンス

MIT License - 商用利用可能

## サポート

GitHub Issues: https://github.com/otedama/otedama/issues

---

**Otedama** - 全自動マイニングの未来

---