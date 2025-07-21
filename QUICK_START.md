# Otedama v0.1.1 - クイックスタートガイド

## 5分で始めるOtedama - エンタープライズ強化版

### 前提条件

- Docker & Docker Compose
- 16GB以上の空きメモリ（GPU機能利用時は32GB推奨）
- ポート3000, 3333, 8080が利用可能
- CUDA対応GPU（オプション - マイニング性能向上）

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

### 2. マイニング開始（GPU加速対応）

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

**XMRig (CPU) - AI難易度調整対応**
```bash
xmrig -o localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.cpu1 -p x -a rx/0 --threads=auto
```

**GMiner (Multi-GPU)**
```bash
gminer -a kawpow -s localhost:3333 -u 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.farm1 -p x --cuda 1 --opencl 1
```

#### GPU加速機能

v0.1.1の新機能：
- **自動GPU検出**: CUDA、OpenCL、Metal、Vulkan対応
- **動的負荷調整**: GPU温度・電力監視による自動最適化
- **メモリプール最適化**: ゼロコピー操作で性能向上
- **AI難易度予測**: 機械学習による収益最適化

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

### v0.1.1 エンタープライズ機能

#### 新しい監視ダッシュボード

```bash
# システム監視
curl http://localhost:8080/api/monitoring/metrics
curl http://localhost:8080/api/monitoring/health
curl http://localhost:8080/api/monitoring/performance
```

#### GPU最適化設定

```bash
# GPU設定の確認
curl http://localhost:8080/api/mining/gpu/status
curl http://localhost:8080/api/mining/gpu/optimize
```

#### セキュリティ強化機能

```bash
# MFA設定
curl -X POST http://localhost:8080/api/auth/mfa/enable
# リスク評価
curl http://localhost:8080/api/security/risk-assessment
```

### 次のステップ

1. **強化されたセキュリティ**
   - 多要素認証（TOTP、WebAuthn）を有効化
   - リスクベース認証を設定
   - セキュリティスキャンを実行
   - 監査ログを確認

2. **パフォーマンス最適化**
   - GPU加速を有効化
   - キャッシュ設定を調整
   - オートスケーリングを設定
   - データベースシャーディングを設定

3. **エンタープライズ運用**
   - 分散トレーシングを設定
   - メトリクス収集を開始
   - アラートルールを設定
   - 自動バックアップを設定

4. **高可用性構成**
   - サーキットブレーカーを設定
   - ロードバランサーを設定
   - フェイルオーバーを設定
   - 災害復旧計画を実装

詳細は[DEPLOYMENT.md](DEPLOYMENT.md)を参照してください。

### サポート

- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- GitHub Discussions: https://github.com/shizukutanaka/Otedama/discussions