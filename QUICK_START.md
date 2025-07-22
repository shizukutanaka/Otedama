# Otedama クイックスタートガイド

## 5分で始めるOtedama P2Pマイニングプール

### 前提条件

- Node.js 18以上
- 4GB以上の空きメモリ
- ポート3333（Stratum）, 6633（P2P）, 8080（API）が利用可能

### 1. 簡単セットアップ

```bash
# 1. リポジトリをクローン
git clone https://github.com/otedama/otedama.git
cd otedama

# 2. 依存関係をインストール
npm install

# 3. スタンドアロンプールを起動
npm run standalone -- \
  --coinbase-address YOUR_WALLET_ADDRESS
```

アクセスURL:
- Stratum接続: stratum+tcp://localhost:3333
- API: http://localhost:8080
- P2P: localhost:6633

### 2. マイニング開始

#### マイナー設定

お使いのマイニングソフトウェアに以下を設定：

```
プールURL: stratum+tcp://localhost:3333
ユーザー名: YOUR_BTC_ADDRESS.WORKER_NAME
パスワード: x
```

#### 設定例（GPU最適化）

**T-Rex (NVIDIA GPU) - 最適化設定**
```bash
t-rex -a kawpow -o stratum+tcp://localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.rig1 -p x --gpu-report-interval 30 --intensity 20
```

**XMRig (CPU)**
```bash
xmrig -o localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.cpu1 -p x -a rx/0 --threads=auto
```

**GMiner (Multi-GPU)**
```bash
gminer -a kawpow -s localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.farm1 -p x --cuda 1 --opencl 1
```

#### 接続確認

```bash
# プール統計を確認
curl http://localhost:8080/api/stats

# 接続中のマイナーを確認
curl http://localhost:8080/api/miners
```

### 3. プール動作モード

#### ソロモード（デフォルト）
- 1人で起動すると自動的にソロマイニングモード
- ブロック発見時の報酬は全てcoinbase-addressへ
- 他のOtedamaノードを自動検出

#### プールモード（自動切替）
- 他のマイナーが接続すると自動的にプールモードへ
- 公平な報酬分配（PPLNS）
- P2Pネットワークで他のプールと接続

### 4. 詳細設定

#### ブロックチェーン接続（Bitcoin等）

```bash
npm run standalone -- \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --blockchain-url http://localhost:8332 \
  --blockchain-user bitcoinrpc \
  --blockchain-pass yourpassword
```

#### 報酬設定

```bash
npm run standalone -- \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --fee 0.01 \
  --min-payout 0.001 \
  --payout-interval 3600000
```

### トラブルシューティング

#### ポートが使用中

```bash
# 使用中のポートを確認
netstat -tlnp | grep -E '3000|3333|8080'

# docker-compose.ymlでポートを変更
ports:
  - "3001:3000"  # 3000の代わりに3001を使用
```

#### メモリ不足

```bash
# Dockerのメモリ制限を増やす
docker update --memory="8g" --memory-swap="8g" otedama_app_1
```

#### 接続できない

```bash
# コンテナの状態を確認
docker-compose ps

# ログを確認
docker-compose logs -f
```

### 監視とAPI

#### プール統計

```bash
# 全体統計
curl http://localhost:8080/api/stats

# マイナー詳細
curl http://localhost:8080/api/miner/YOUR_WALLET_ADDRESS

# 発見ブロック
curl http://localhost:8080/api/blocks

# P2Pピア情報
curl http://localhost:8080/api/peers
```

#### セキュリティ機能

```bash
# 認証（JWT）
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "password"}'

# 2FA有効化
curl -X POST http://localhost:8080/api/auth/2fa/enable \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 次のステップ

1. **パフォーマンス調整**
   - ワーカースレッド数の最適化
   - キャッシュサイズの調整
   - ネットワーク設定の最適化

2. **セキュリティ強化**
   - 2要素認証（TOTP）の有効化
   - アクセス制御の設定
   - DDoS保護の調整

3. **エンタープライズ運用**
   - クラスタリングモードの有効化
   - 監視ダッシュボードの設定
   - 自動バックアップの設定

4. **P2Pネットワーク拡張**
   - 外部ピアの追加
   - ネットワークトポロジーの最適化
   - 帯域幅制限の設定

詳細は以下のドキュメントを参照してください：
- [STANDALONE_POOL.md](STANDALONE_POOL.md) - スタンドアロンプールの詳細
- [CONFIGURATION.md](CONFIGURATION.md) - 詳細な設定オプション
- [DEPLOYMENT.md](DEPLOYMENT.md) - 本番環境へのデプロイ
- [API_REFERENCE.md](API_REFERENCE.md) - API仕様