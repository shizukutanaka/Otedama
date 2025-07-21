# Otedama Beta - デプロイメントガイド

## 概要

Otedama Betaは、エンタープライズグレードのP2Pマイニングプール、DEX、DeFiプラットフォームの本番環境用コードです。

## システム要件

### 最小要件
- CPU: 16コア (AMD EPYC / Intel Xeon)
- メモリ: 64GB DDR4 ECC
- ストレージ: 2TB NVMe SSD
- ネットワーク: 10Gbps
- OS: Ubuntu 22.04 LTS / RHEL 8+

### 推奨構成
- CPU: 32コア以上
- メモリ: 128GB以上
- ストレージ: 4TB NVMe RAID
- GPU: NVIDIA A100/H100 (ML機能用)

## クイックスタート

### 1. 環境設定

```bash
# 環境設定ファイルのコピー
cp .env.production.example .env.production

# 必要な設定を編集
nano .env.production
```

### 2. Dockerを使用したデプロイ

```bash
# イメージのビルド
docker build -t otedama:beta .

# 本番環境の起動
docker-compose -f docker-compose.production.yml up -d
```

### 3. 直接実行

```bash
# 依存関係のインストール
npm ci --production

# データベースマイグレーション
npm run migrate

# サーバー起動
NODE_ENV=production node index.js
```

## サービスエンドポイント

| サービス | ポート | 説明 |
|---------|--------|------|
| Web UI | 3000 | ユーザーインターフェース |
| Admin | 3001 | 管理画面 |
| API | 8080 | REST API |
| Stratum | 3333 | マイニング接続 |
| WebSocket | 8081-8083 | リアルタイム通信 |

## 設定パラメータ

### 必須設定

```env
# データベース
DB_HOST=localhost
DB_PORT=5432
DB_NAME=otedama_production
DB_USER=otedama
DB_PASSWORD=CHANGE_THIS

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=CHANGE_THIS

# セキュリティ
JWT_SECRET=64文字のランダム文字列
ENCRYPTION_KEY=32文字のランダム文字列
```

### パフォーマンス設定

```env
# ワーカー設定
WORKER_THREADS=16
MAX_CONNECTIONS=100000
SHARE_PROCESS_BATCH=5000

# メモリ設定
NODE_OPTIONS="--max-old-space-size=8192"
```

## モニタリング

### Prometheus設定

```yaml
# deploy/prometheus.yml
scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
```

### ヘルスチェック

```bash
# システムヘルス
curl http://localhost:8080/health

# 詳細ステータス
curl http://localhost:8080/status
```

## セキュリティ

### SSL/TLS設定

本番環境では必ずHTTPSを使用してください：

```nginx
server {
    listen 443 ssl http2;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
}
```

### ファイアウォール設定

```bash
# 必要なポートのみ開放
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 3333/tcp  # Stratum
sudo ufw enable
```

## バックアップとリカバリ

### 自動バックアップ

```bash
# Cronジョブの設定
0 3 * * * /opt/otedama/scripts/backup.sh
```

### リストア手順

```bash
# データベースのリストア
psql -U otedama otedama_production < backup.sql

# アプリケーションデータのリストア
tar -xzf data-backup.tar.gz -C /opt/otedama/
```

## トラブルシューティング

### 一般的な問題

1. **メモリ不足**
   ```bash
   NODE_OPTIONS="--max-old-space-size=16384" node index.js
   ```

2. **接続数上限**
   ```bash
   ulimit -n 65536
   ```

3. **パフォーマンス問題**
   - Redis接続を確認
   - データベースインデックスを最適化
   - ログレベルを調整

### ログ確認

```bash
# アプリケーションログ
tail -f logs/app.log

# エラーログ
tail -f logs/error.log

# Dockerログ
docker-compose logs -f
```

## サポート

- 技術サポート: support@otedama.io
- セキュリティ問題: security@otedama.io
- ドキュメント: https://docs.otedama.io