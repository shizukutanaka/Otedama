# Otedama Beta - クイックスタートガイド

## 5分で始めるOtedama

### 前提条件

- Docker & Docker Compose
- 8GB以上の空きメモリ
- ポート3000, 3333, 8080が利用可能

### 1. 簡単セットアップ（Docker）

```bash
# 1. 環境設定
cp .env.production.example .env.production

# 2. Dockerコンテナ起動
docker-compose up -d

# 3. 完了！
```

アクセスURL:
- Web UI: http://localhost:3000
- Admin: http://localhost:3001
- API: http://localhost:8080

### 2. マイニング開始

#### マイナー設定

お使いのマイニングソフトウェアに以下を設定：

```
プールURL: stratum+tcp://localhost:3333
ユーザー名: YOUR_BTC_ADDRESS.WORKER_NAME
パスワード: x
```

#### 設定例

**T-Rex (NVIDIA GPU)**
```bash
t-rex -a kawpow -o stratum+tcp://localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.rig1 -p x
```

**XMRig (CPU)**
```bash
xmrig -o localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.cpu1 -p x -a rx/0
```

### 3. 取引開始

#### ログイン

1. http://localhost:3000 にアクセス
2. 「新規登録」をクリック
3. メールアドレスとパスワードを入力
4. ログイン

#### 初回入金

1. 「ウォレット」タブを開く
2. 入金アドレスを確認
3. BTCまたはUSDTを送金

#### 取引実行

1. 「取引」タブを開く
2. 通貨ペアを選択（例：BTC/USDT）
3. 注文タイプと数量を入力
4. 「購入」または「売却」をクリック

### 4. 流動性提供

#### プール追加

1. 「DeFi」タブを開く
2. 「流動性追加」をクリック
3. 通貨ペアと数量を入力
4. 「追加」をクリック

報酬は自動的に蓄積されます。

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

### 次のステップ

1. **セキュリティ設定**
   - 2要素認証を有効化
   - APIキーを生成
   - IPホワイトリストを設定

2. **高度な機能**
   - 自動取引ボットを設定
   - アラートを設定
   - カスタムストラテジーを作成

3. **本番環境への移行**
   - SSL証明書を設定
   - バックアップを設定
   - 監視を設定

詳細は[DEPLOYMENT.md](DEPLOYMENT.md)を参照してください。

### サポート

- Discord: https://discord.gg/otedama
- Email: support@otedama.io
- ドキュメント: https://docs.otedama.io