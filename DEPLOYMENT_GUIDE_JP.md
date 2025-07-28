# Otedama プロダクションデプロイメントガイド

このガイドでは、Otedamaマイニングプールをプロダクション環境にデプロイする手順を説明します。

## 目次

1. [システム要件](#システム要件)
2. [事前準備](#事前準備)
3. [インストール](#インストール)
4. [設定](#設定)
5. [デプロイメント](#デプロイメント)
6. [監視とメンテナンス](#監視とメンテナンス)
7. [トラブルシューティング](#トラブルシューティング)

## システム要件

### 最小要件
- **OS**: Ubuntu 20.04 LTS以上、CentOS 8以上、またはDebian 10以上
- **CPU**: 8コア以上
- **RAM**: 16GB以上
- **ストレージ**: SSD 500GB以上
- **ネットワーク**: 1Gbps以上の専用接続
- **ポート**: 3333 (Stratum)、8080 (API)、33333 (P2P)

### 推奨要件
- **CPU**: 16コア以上
- **RAM**: 32GB以上
- **ストレージ**: NVMe SSD 1TB以上（RAID構成）
- **ネットワーク**: 10Gbps接続
- **ロードバランサー**: HAProxy またはNginx

## 事前準備

### 1. システムの更新
```bash
# Ubuntu/Debian
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git curl wget

# CentOS/RHEL
sudo yum update -y
sudo yum groupinstall -y "Development Tools"
sudo yum install -y git curl wget
```

### 2. Node.jsのインストール
```bash
# Node.js 18.xをインストール
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# バージョン確認
node --version  # v18.x.x
npm --version   # 9.x.x
```

### 3. データベースのセットアップ
```bash
# PostgreSQL 14のインストール（オプション、デフォルトはSQLite）
sudo apt install -y postgresql-14 postgresql-client-14
sudo systemctl start postgresql
sudo systemctl enable postgresql

# データベースとユーザーの作成
sudo -u postgres psql <<EOF
CREATE DATABASE otedama;
CREATE USER otedama WITH PASSWORD 'secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE otedama TO otedama;
EOF
```

### 4. Redisのインストール（キャッシング用）
```bash
sudo apt install -y redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

## インストール

### 1. Otedamaのクローン
```bash
cd /opt
sudo git clone https://github.com/your-repo/otedama.git
sudo chown -R $USER:$USER otedama
cd otedama
```

### 2. 依存関係のインストール
```bash
npm install --production
npm run build
```

### 3. 設定ファイルの準備
```bash
cp otedama.config.example.js otedama.config.js
cp .env.example .env.production
```

## 設定

### 1. 基本設定（otedama.config.js）
```javascript
export default {
  // プール設定
  pool: {
    name: "あなたのプール名",
    host: "pool.yourdomain.com",
    fee: 1.0,  // 1% プール手数料
    minPayout: 0.001,  // 最小支払い額（BTC）
    payoutInterval: 3600000,  // 1時間ごと
  },
  
  // ネットワーク設定
  network: {
    p2p: {
      enabled: true,
      port: 33333,
      maxPeers: 100
    },
    stratum: {
      ports: {
        3333: { diff: 16384, desc: "高性能ASIC" },
        3334: { diff: 1024, desc: "GPU" },
        3335: { diff: 64, desc: "CPU" }
      }
    }
  },
  
  // データベース設定
  database: {
    type: "postgresql",  // または "sqlite"
    host: "localhost",
    port: 5432,
    name: "otedama",
    user: "otedama",
    password: process.env.DB_PASSWORD
  },
  
  // セキュリティ設定
  security: {
    zkpAuth: true,
    rateLimit: {
      windowMs: 60000,
      max: 100
    },
    ssl: {
      enabled: true,
      key: "/path/to/ssl.key",
      cert: "/path/to/ssl.crt"
    }
  }
};
```

### 2. 環境変数（.env.production）
```bash
# ノード環境
NODE_ENV=production

# データベース
DB_PASSWORD=your_secure_password

# Redis
REDIS_URL=redis://localhost:6379

# API設定
API_PORT=8080
API_HOST=0.0.0.0

# セキュリティ
JWT_SECRET=your_jwt_secret_here
ENCRYPTION_KEY=your_encryption_key_here

# 監視
PROMETHEUS_ENABLED=true
METRICS_PORT=9090

# バックアップ
BACKUP_ENABLED=true
BACKUP_S3_BUCKET=otedama-backups
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
```

### 3. Nginxリバースプロキシ設定
```nginx
# /etc/nginx/sites-available/otedama
server {
    listen 80;
    server_name pool.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pool.yourdomain.com;
    
    ssl_certificate /path/to/ssl.crt;
    ssl_certificate_key /path/to/ssl.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    # API
    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # WebSocket
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
    
    # 静的ファイル
    location / {
        root /opt/otedama/public;
        try_files $uri $uri/ /index.html;
    }
}
```

## デプロイメント

### 1. Systemdサービスの作成
```bash
sudo nano /etc/systemd/system/otedama.service
```

```ini
[Unit]
Description=Otedama Mining Pool
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=otedama
WorkingDirectory=/opt/otedama
Environment=NODE_ENV=production
ExecStart=/usr/bin/node start-mining-pool.js
Restart=always
RestartSec=10

# セキュリティ設定
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/otedama/data /opt/otedama/logs

[Install]
WantedBy=multi-user.target
```

### 2. サービスの開始
```bash
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama
sudo systemctl status otedama
```

### 3. ファイアウォールの設定
```bash
# UFWの場合
sudo ufw allow 3333/tcp  # Stratum
sudo ufw allow 3334/tcp  # Stratum SSL
sudo ufw allow 8080/tcp  # API
sudo ufw allow 33333/tcp # P2P
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 80/tcp    # HTTP
```

### 4. ヘルスチェック
```bash
# APIヘルスチェック
curl https://pool.yourdomain.com/health

# ダッシュボードアクセス
open https://pool.yourdomain.com/dashboard/
```

## 監視とメンテナンス

### 1. Prometheusの設定
```yaml
# /etc/prometheus/prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
```

### 2. Grafanaダッシュボード
- Prometheus: http://localhost:9091
- Grafana: http://localhost:3000 (デフォルト: admin/admin)
- エージェントダッシュボード: http://localhost:8084

### 3. ログ管理
```bash
# ログローテーション設定
sudo nano /etc/logrotate.d/otedama
```

```
/opt/otedama/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0640 otedama otedama
    sharedscripts
    postrotate
        systemctl reload otedama
    endscript
}
```

### 4. バックアップ
```bash
# 自動バックアップの有効化
npm run backup:enable

# 手動バックアップ
npm run backup:now

# バックアップのリストア
npm run backup:restore backup_2024_01_20.tar.gz
```

### 5. 監視コマンド
```bash
# システムステータス
npm run health:full

# パフォーマンス分析
npm run performance:analyze

# ログ分析
npm run logs:analyze

# セキュリティスキャン
npm run security:scan
```

## トラブルシューティング

### 一般的な問題

#### 1. ポートが使用中
```bash
# 使用中のポートを確認
sudo netstat -tlnp | grep -E '3333|8080|33333'

# プロセスを停止
sudo kill -9 <PID>
```

#### 2. データベース接続エラー
```bash
# PostgreSQLの状態を確認
sudo systemctl status postgresql

# 接続をテスト
psql -h localhost -U otedama -d otedama
```

#### 3. メモリ不足
```bash
# メモリ使用状況を確認
free -h

# Node.jsのメモリ制限を増やす
export NODE_OPTIONS="--max-old-space-size=8192"
```

#### 4. ハッシュレートが低い
```bash
# ネットワーク遅延を確認
npm run network:test

# ハードウェアを再最適化
npm run optimize:hardware
```

### ログの確認
```bash
# アプリケーションログ
tail -f /opt/otedama/logs/otedama.log

# エラーログ
grep ERROR /opt/otedama/logs/otedama.log

# システムログ
journalctl -u otedama -f
```

### パフォーマンスチューニング
```bash
# カーネルパラメータの最適化
sudo sysctl -w net.core.somaxconn=65535
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=65535
sudo sysctl -w net.core.netdev_max_backlog=65535

# 永続化
echo "net.core.somaxconn = 65535" | sudo tee -a /etc/sysctl.conf
```

## セキュリティのベストプラクティス

1. **定期的な更新**
   ```bash
   npm run update:check
   npm run update:apply
   ```

2. **SSL証明書の更新**
   ```bash
   certbot renew --nginx
   ```

3. **セキュリティ監査**
   ```bash
   npm run security:audit
   ```

4. **アクセス制限**
   - SSH鍵認証のみ許可
   - 不要なポートを閉じる
   - IPホワイトリスト設定

## サポート

- ドキュメント: `/docs`フォルダを参照
- 問題報告: お好みの問題追跡システムで報告
- セキュリティ: security@otedama.example

---

**注意**: 本番環境に適用する前に、必ずステージング環境でデプロイメント手順をテストしてください！