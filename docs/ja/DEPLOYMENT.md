# Otedama デプロイメントガイド

## 目次

1. [概要](#概要)
2. [デプロイメントオプション](#デプロイメントオプション)
3. [前提条件](#前提条件)
4. [本番環境デプロイメント](#本番環境デプロイメント)
5. [Dockerデプロイメント](#dockerデプロイメント)
6. [Kubernetesデプロイメント](#kubernetesデプロイメント)
7. [高可用性セットアップ](#高可用性セットアップ)
8. [監視セットアップ](#監視セットアップ)
9. [セキュリティ強化](#セキュリティ強化)
10. [メンテナンス](#メンテナンス)

## 概要

このガイドでは、シングルサーバーのセットアップから国家規模のインフラストラクチャまで、さまざまな環境でのOtedamaのデプロイメントについて説明します。要件に最適なデプロイメント方法を選択してください。

## デプロイメントオプション

| 方法 | 使用ケース | 複雑性 | スケーラビリティ |
|------|------------|--------|------------------|
| **スタンドアロン** | 開発、テスト | 低 | 限定的 |
| **Docker** | 小〜中規模運用 | 中 | 良好 |
| **Kubernetes** | エンタープライズ、国家規模 | 高 | 優秀 |
| **マルチリージョン** | グローバル運用 | 非常に高 | 最大 |

## 前提条件

### システム要件

**最小要件（シングルサーバー）：**
- CPU: 8コア
- RAM: 16GB
- ストレージ: 500GB SSD
- ネットワーク: 1Gbps
- OS: Ubuntu 20.04+ または CentOS 8+

**推奨要件（本番環境）：**
- CPU: 32コア以上
- RAM: 64GB以上
- ストレージ: 2TB NVMe SSD
- ネットワーク: 10Gbps
- OS: Ubuntu 22.04 LTS

### ソフトウェア要件

```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# ビルドツール
sudo apt-get install -y build-essential git

# データベース
sudo apt-get install -y postgresql-14 redis

# 監視（オプション）
sudo apt-get install -y prometheus grafana

# ロードバランサー（オプション）
sudo apt-get install -y nginx haproxy
```

## 本番環境デプロイメント

### 1. サーバー準備

```bash
# 専用ユーザーの作成
sudo useradd -m -s /bin/bash otedama
sudo usermod -aG sudo otedama

# ディレクトリのセットアップ
sudo mkdir -p /opt/otedama
sudo chown otedama:otedama /opt/otedama

# otedamaユーザーに切り替え
sudo su - otedama
```

### 2. Otedamaのインストール

```bash
# リポジトリのクローン
cd /opt/otedama
git clone [repository-url] .

# 依存関係のインストール
npm install --production

# ネイティブモジュールのビルド
npm run build:native

# 設定の作成
cp otedama.config.example.js otedama.config.js
```

### 3. 環境の設定

`otedama.config.js`を編集：

```javascript
module.exports = {
  // 本番環境設定
  env: 'production',
  
  // ネットワーク設定
  network: {
    host: '0.0.0.0',
    port: 3333,
    ssl: {
      enabled: true,
      cert: '/path/to/cert.pem',
      key: '/path/to/key.pem'
    }
  },
  
  // データベース設定
  database: {
    host: 'localhost',
    port: 5432,
    name: 'otedama',
    user: 'otedama',
    password: process.env.DB_PASSWORD
  },
  
  // Redis設定
  redis: {
    host: 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD
  },
  
  // パフォーマンス設定
  performance: {
    workers: 'auto', // すべてのCPUコアを使用
    memoryLimit: 8192, // MB
    connectionLimit: 100000
  }
};
```

### 4. データベースのセットアップ

```bash
# データベースの作成
sudo -u postgres createuser otedama
sudo -u postgres createdb otedama -O otedama

# マイグレーションの実行
NODE_ENV=production npm run migrate

# インデックスの作成
NODE_ENV=production npm run db:optimize
```

### 5. Systemdサービスの設定

`/etc/systemd/system/otedama.service`を作成：

```ini
[Unit]
Description=Otedama マイニングプール
After=network.target postgresql.service redis.service
Wants=postgresql.service redis.service

[Service]
Type=notify
ExecStart=/usr/bin/node /opt/otedama/index.js
ExecReload=/bin/kill -USR2 $MAINPID
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=otedama
User=otedama
Group=otedama
Environment=NODE_ENV=production
Environment=NODE_OPTIONS="--max-old-space-size=8192"

# セキュリティ
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/otedama/data /opt/otedama/logs

[Install]
WantedBy=multi-user.target
```

### 6. サービスの開始

```bash
# サービスの有効化と開始
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama

# ステータスの確認
sudo systemctl status otedama
```

## Dockerデプロイメント

### 1. イメージのビルド

```bash
# 本番ビルド
docker build -t otedama:latest -f Dockerfile.production .

# マルチステージビルドで小さいイメージ
docker build --target production -t otedama:latest .
```

### 2. Docker Composeセットアップ

`docker-compose.production.yml`を作成：

```yaml
version: '3.8'

services:
  otedama:
    image: otedama:latest
    container_name: otedama-pool
    restart: always
    ports:
      - "3333:3333"
      - "8080:8080"
    environment:
      NODE_ENV: production
      DB_HOST: postgres
      REDIS_HOST: redis
    volumes:
      - ./config:/app/config
      - otedama-data:/app/data
      - otedama-logs:/app/logs
    depends_on:
      - postgres
      - redis
    networks:
      - otedama-net
    deploy:
      resources:
        limits:
          cpus: '8'
          memory: 16G
        reservations:
          cpus: '4'
          memory: 8G

  postgres:
    image: postgres:14-alpine
    container_name: otedama-db
    restart: always
    environment:
      POSTGRES_DB: otedama
      POSTGRES_USER: otedama
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - otedama-net

  redis:
    image: redis:7-alpine
    container_name: otedama-cache
    restart: always
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    networks:
      - otedama-net

  nginx:
    image: nginx:alpine
    container_name: otedama-proxy
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - otedama
    networks:
      - otedama-net

volumes:
  otedama-data:
  otedama-logs:
  postgres-data:
  redis-data:

networks:
  otedama-net:
    driver: bridge
```

### 3. Docker Composeで実行

```bash
# .envファイルの作成
cat > .env << EOF
DB_PASSWORD=secure_password
REDIS_PASSWORD=secure_password
EOF

# サービスの開始
docker-compose -f docker-compose.production.yml up -d

# ログの表示
docker-compose -f docker-compose.production.yml logs -f

# ワーカーのスケーリング
docker-compose -f docker-compose.production.yml up -d --scale otedama=3
```

## Kubernetesデプロイメント

### 1. ネームスペースの作成

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: otedama
```

### 2. ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otedama-config
  namespace: otedama
data:
  otedama.config.js: |
    module.exports = {
      env: 'production',
      // ... 設定
    };
```

### 3. Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otedama-pool
  namespace: otedama
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otedama
  template:
    metadata:
      labels:
        app: otedama
    spec:
      containers:
      - name: otedama
        image: otedama:latest
        ports:
        - containerPort: 3333
          name: stratum
        - containerPort: 8080
          name: api
        resources:
          requests:
            memory: "8Gi"
            cpu: "4"
          limits:
            memory: "16Gi"
            cpu: "8"
        volumeMounts:
        - name: config
          mountPath: /app/config
        - name: data
          mountPath: /app/data
        env:
        - name: NODE_ENV
          value: "production"
        - name: DB_HOST
          value: "postgres-service"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: otedama-config
      - name: data
        persistentVolumeClaim:
          claimName: otedama-data-pvc
```

### 4. Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otedama-service
  namespace: otedama
spec:
  selector:
    app: otedama
  ports:
  - name: stratum
    port: 3333
    targetPort: 3333
    protocol: TCP
  - name: api
    port: 8080
    targetPort: 8080
    protocol: TCP
  type: LoadBalancer
```

### 5. Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otedama-hpa
  namespace: otedama
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otedama-pool
  minReplicas: 3
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### 6. Kubernetesへのデプロイ

```bash
# 設定の適用
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml

# デプロイメントの確認
kubectl get all -n otedama

# ログの表示
kubectl logs -f deployment/otedama-pool -n otedama
```

## 高可用性セットアップ

### 1. マルチリージョンアーキテクチャ

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   リージョンUS   │     │  リージョンEU   │     │ リージョンAsia  │
│                 │     │                 │     │                 │
│ ┌─────────────┐ │     │ ┌─────────────┐ │     │ ┌─────────────┐ │
│ │ ロード      │ │     │ │ ロード      │ │     │ │ ロード      │ │
│ │ バランサー  │ │     │ │ バランサー  │ │     │ │ バランサー  │ │
│ └──────┬──────┘ │     │ └──────┬──────┘ │     │ └──────┬──────┘ │
│        │        │     │        │        │     │        │        │
│ ┌──────┴──────┐ │     │ ┌──────┴──────┐ │     │ ┌──────┴──────┐ │
│ │  Otedama    │ │     │ │  Otedama    │ │     │ │  Otedama    │ │
│ │  クラスター  │ │◄────┼─┤  クラスター  │ │◄────┼─┤  クラスター  │ │
│ └─────────────┘ │     │ └─────────────┘ │     │ └─────────────┘ │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                        グローバルデータベース
```

### 2. ロードバランサー設定（HAProxy）

```
global
    maxconn 100000
    log /dev/log local0
    stats socket /var/run/haproxy.sock mode 660
    tune.ssl.default-dh-param 2048

defaults
    mode tcp
    timeout connect 5s
    timeout client 30s
    timeout server 30s
    option tcplog

frontend mining_frontend
    bind *:3333
    default_backend mining_backend

backend mining_backend
    balance leastconn
    option tcp-check
    
    server pool1 10.0.1.10:3333 check weight 100
    server pool2 10.0.1.11:3333 check weight 100
    server pool3 10.0.1.12:3333 check weight 100
    
    # バックアップサーバー
    server backup1 10.0.2.10:3333 backup
    server backup2 10.0.2.11:3333 backup
```

### 3. データベースレプリケーション

```bash
# プライマリデータベースのセットアップ
sudo -u postgres psql -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'repl_password';"

# プライマリの設定
echo "wal_level = replica
max_wal_senders = 3
wal_keep_segments = 64" | sudo tee -a /etc/postgresql/14/main/postgresql.conf

# レプリカの設定
pg_basebackup -h primary_host -D /var/lib/postgresql/14/main -U replicator -v -P -W

# レプリカの開始
echo "standby_mode = 'on'
primary_conninfo = 'host=primary_host port=5432 user=replicator'" | sudo tee /var/lib/postgresql/14/main/recovery.conf
```

## 監視セットアップ

### 1. Prometheus設定

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'otedama'
    static_configs:
      - targets: ['localhost:9090']
    metrics_path: '/metrics'
    
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
      
  - job_name: 'postgres'
    static_configs:
      - targets: ['localhost:9187']
```

### 2. Grafanaダッシュボード

`monitoring/grafana-dashboard.json`からOtedamaダッシュボードをインポート：

```bash
# APIインポート
curl -X POST http://admin:admin@localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -d @monitoring/grafana-dashboard.json
```

### 3. アラートルール

```yaml
groups:
  - name: otedama_alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(otedama_errors_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 高いエラー率が検出されました
          
      - alert: LowHashrate
        expr: otedama_pool_hashrate < 1000000000
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: プールのハッシュレートが危機的に低い
```

## セキュリティ強化

### 1. ファイアウォールルール

```bash
# 必要なポートのみ許可
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 3333/tcp
sudo ufw allow 8080/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2. SSL/TLS設定

```nginx
server {
    listen 443 ssl http2;
    server_name pool.example.com;
    
    ssl_certificate /etc/ssl/certs/otedama.crt;
    ssl_certificate_key /etc/ssl/private/otedama.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 3. セキュリティヘッダー

```javascript
// otedama.config.js内
security: {
  headers: {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'"
  }
}
```

## メンテナンス

### 1. バックアップ戦略

```bash
#!/bin/bash
# 日次バックアップスクリプト

BACKUP_DIR="/backup/otedama/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

# データベースバックアップ
pg_dump -U otedama otedama | gzip > $BACKUP_DIR/database.sql.gz

# 設定バックアップ
tar -czf $BACKUP_DIR/config.tar.gz /opt/otedama/config

# データバックアップ
rsync -av /opt/otedama/data/ $BACKUP_DIR/data/

# 古いバックアップのクリーンアップ（30日保持）
find /backup/otedama -type d -mtime +30 -exec rm -rf {} \;
```

### 2. 更新とアップグレード

```bash
# ゼロダウンタイム更新プロセス
# 1. 最新コードの取得
cd /opt/otedama
git pull origin main

# 2. 依存関係のインストール
npm install --production

# 3. マイグレーションの実行
npm run migrate

# 4. サービスのリロード
sudo systemctl reload otedama

# Kubernetesの場合
kubectl set image deployment/otedama-pool otedama=otedama:new-version -n otedama
kubectl rollout status deployment/otedama-pool -n otedama
```

### 3. パフォーマンスチューニング

```bash
# システム最適化
echo "net.core.somaxconn = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 1024 65535
fs.file-max = 1000000" | sudo tee -a /etc/sysctl.conf

sudo sysctl -p

# データベース最適化
sudo -u postgres psql otedama -c "VACUUM ANALYZE;"
sudo -u postgres psql otedama -c "REINDEX DATABASE otedama;"
```

## トラブルシューティング

### よくある問題

**接続拒否：**
```bash
# サービスステータスの確認
sudo systemctl status otedama
# ポートの確認
sudo netstat -tlnp | grep 3333
```

**高メモリ使用：**
```bash
# メモリの確認
free -h
# Node.jsメモリの調整
export NODE_OPTIONS="--max-old-space-size=4096"
```

**データベース接続エラー：**
```bash
# PostgreSQLの確認
sudo systemctl status postgresql
# 接続の確認
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"
```

### ヘルスチェック

```bash
# APIヘルス
curl http://localhost:8080/health

# Stratumヘルス
echo '{"id":1,"method":"mining.subscribe","params":[]}' | nc localhost 3333

# フルシステムチェック
npm run health:check
```

## サポート

デプロイメント支援については：
- ドキュメント: `/docs`フォルダを参照
- 問題: GitHub Issuesで報告
- コミュニティ: フォーラムでヘルプを得る