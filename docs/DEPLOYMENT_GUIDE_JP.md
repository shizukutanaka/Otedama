# Otedama エンタープライズP2Pマイニングプール - プロダクション展開ガイド

**バージョン**: 2.1.5  
**最終更新日**: 2025-08-06  

## 前提条件

- Go 1.21以上
- PostgreSQL 14以上  
- Redis 7.0以上（キャッシュとセッション管理用）
- Docker 24.0+ と Docker Compose v2（コンテナ展開用）
- Kubernetes 1.28+（エンタープライズ展開用）
- HTTPS/TLS用SSL証明書
- ハードウェアセキュリティモジュール（HSM）サポート（オプション、エンタープライズセキュリティ用）

## システム要件

### 最小要件（開発環境）
- CPU: 4コア（3.0GHz+）
- RAM: 16GB DDR4
- ストレージ: 200GB NVMe SSD
- ネットワーク: 1Gbps（低遅延）

### プロダクション要件
- CPU: 16+コア（3.2GHz+、Intel Xeon または AMD EPYC）
- RAM: 64GB+ DDR4 ECC
- ストレージ: 1TB+ NVMe SSD RAID 1
- ネットワーク: 10Gbps（冗長化対応）
- GPU: オプション RTX 4090 または AMD RX 7900 XTX（最適化テスト用）

### エンタープライズ/国家レベル要件  
- CPU: 複数ノードで32+コア
- RAM: ノードあたり128GB+
- ストレージ: 5TB+ 分散ストレージ（Ceph/GlusterFS）
- ネットワーク: 25+ Gbps（DDoS保護付き）
- ロードバランサー: ハードウェアロードバランサー（F5、Citrix）
- 高可用性: マルチリージョン展開

## インストール手順

### 1. 環境準備
```bash
# otedamaユーザーとディレクトリの作成
sudo useradd -r -s /bin/false otedama
sudo mkdir -p /opt/otedama/{bin,config,data,logs}
sudo chown -R otedama:otedama /opt/otedama

# インストールディレクトリに移動
cd /opt/otedama
```

### 2. ソースからビルド
```bash
# 最適化されたプロダクションバイナリのビルド
make build-production

# または手動で最適化ビルド
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build \
  -ldflags="-s -w -X main.version=$(cat VERSION)" \
  -tags="production" \
  -o bin/otedama cmd/otedama/main.go

# バイナリの検証
./bin/otedama version
```

### 3. 依存関係のインストール
```bash
# Goモジュールのダウンロード
go mod download
go mod verify

# プロダクション用追加ツールのインストール
go install github.com/golang-migrate/migrate/v4/cmd/migrate@latest
go install github.com/air-verse/air@latest  # 開発用ホットリロード
```

### 4. データベースセットアップ

エンタープライズ機能付きPostgreSQLデータベースの作成:
```sql
-- データベースとユーザーの作成
CREATE DATABASE otedama WITH 
  ENCODING 'UTF8'
  LC_COLLATE 'ja_JP.UTF-8'
  LC_CTYPE 'ja_JP.UTF-8';

CREATE USER otedama_user WITH 
  ENCRYPTED PASSWORD 'your_secure_password'
  CREATEDB CREATEROLE;

GRANT ALL PRIVILEGES ON DATABASE otedama TO otedama_user;

-- 必要な拡張機能の有効化
\c otedama;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
```

データベースマイグレーションの実行:
```bash
# データベースURLの設定
export DATABASE_URL="postgresql://otedama_user:your_secure_password@localhost:5432/otedama?sslmode=require"

# マイグレーション実行
./bin/otedama migrate up

# マイグレーション状態の確認
./bin/otedama migrate status
```

### 5. 設定

プロダクション設定テンプレートのコピー:
```bash
cp config.yaml config/production.yaml
```

`config/production.yaml`をエンタープライズ設定で編集:
```yaml
# アプリケーション設定
app:
  name: "Otedama"
  mode: "production"
  version: "2.1.5"
  log_level: "info"

# サーバー設定
server:
  host: "0.0.0.0"
  port: 8080
  read_timeout: 30s
  write_timeout: 30s
  idle_timeout: 120s
  max_header_bytes: 1048576

# マイニング設定
mining:
  algorithm: "sha256d"
  enable_cpu: true
  enable_gpu: true
  enable_asic: true
  
  cpu:
    threads: 0  # 自動検出
    priority: "normal"
    huge_pages: true
    numa_aware: true
  
  gpu:
    devices: []  # 全デバイス自動検出
    intensity: 20
    temperature_limit: 85
    memory_optimization: true
  
  asic:
    devices: []  # 自動発見
    poll_interval: 5s
    firmware_optimization: true

# プール設定
pool:
  enable: true
  address: "0.0.0.0:3333"
  max_connections: 50000
  fee_percentage: 1.0
  minimum_payout: 0.001
  rewards:
    system: "PPLNS"
    window: 2h
    difficulty_adjustment: "auto"

# Stratum設定
stratum:
  enable: true
  address: "0.0.0.0:3333"
  max_workers: 50000
  job_timeout: 30s
  share_difficulty: 1
  var_diff: true
  protocols:
    v1: true
    v2: true

# API設定
api:
  enable: true
  address: "0.0.0.0:8080"
  cors_origins: ["*"]
  auth:
    enabled: true
    token_expiry: 24h
    rate_limiting: true
  
# データベース設定  
database:
  host: "localhost"
  port: 5432
  name: "otedama"
  user: "otedama_user"
  password: "your_secure_password"
  ssl_mode: "require"
  max_connections: 200
  max_idle_connections: 50
  connection_max_lifetime: 1h

# Redis設定
redis:
  host: "localhost"
  port: 6379
  password: ""
  db: 0
  pool_size: 100

# セキュリティ設定
security:
  enable_tls: true
  cert_file: "/etc/ssl/certs/otedama.crt"
  key_file: "/etc/ssl/private/otedama.key"
  
  ddos_protection:
    enabled: true
    rate_limit: 1000
    burst_limit: 2000
    ban_duration: 3600s
    
  firewall:
    enabled: true
    whitelist: []
    blacklist: []
    
  audit:
    enabled: true
    log_file: "/opt/otedama/logs/audit.log"

# P2Pフェデレーション設定
federation:
  enabled: true
  node_id: "otedama-node-prod-001"
  listen_port: 4444
  bootstrap_peers:
    - "peer1.example.com:4444"
    - "peer2.example.com:4444"
  max_peers: 50
  reputation_threshold: 0.8

# 監視設定
monitoring:
  metrics:
    enabled: true
    address: "0.0.0.0:9090"
    path: "/metrics"
  
  health:
    enabled: true
    address: "0.0.0.0:8081"
    path: "/health"
  
  logging:
    level: "info"
    format: "json"
    file: "/opt/otedama/logs/otedama.log"
    max_size: 100
    max_backups: 10
    max_age: 30

# ハードウェア最適化
optimization:
  enable_memory_timing: true
  memory_timing_level: 3
  enable_power_opt: true
  power_limit: 85
  enable_thermal_opt: true
  target_temp: 75
  enable_stratum_v2: true
  auto_optimize: true
  optimization_interval: 3600
  safety_mode: true
```

### 6. 設定テスト
```bash
# 設定の検証
./bin/otedama config validate --config config/production.yaml

# データベース接続テスト
./bin/otedama config test-db --config config/production.yaml

# システムチェック実行
./bin/otedama system check
```

### 7. アプリケーション開始
```bash
# 特定の設定で開始
./bin/otedama serve --config config/production.yaml

# または環境変数を使用
export OTEDAMA_CONFIG=/opt/otedama/config/production.yaml
./bin/otedama serve
```

## Dockerプロダクション展開

### 1. プロダクションDockerイメージのビルド
```bash
# 最適化されたプロダクションイメージのビルド
docker build -f Dockerfile.production -t otedama:production .

# 特定バージョンタグでビルド
docker build -f Dockerfile.production -t otedama:v2.1.5 .

# ARM64/AMD64のマルチアーチビルド
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.production -t otedama:v2.1.5 .
```

### 2. プロダクションDocker Compose
```yaml
version: '3.8'

services:
  otedama:
    image: otedama:production
    container_name: otedama-pool
    restart: unless-stopped
    ports:
      - "3333:3333"   # SHA256d Stratum
      - "3334:3334"   # Ethash Stratum  
      - "3335:3335"   # RandomX Stratum
      - "3336:3336"   # KawPow Stratum
      - "3337:3337"   # Scrypt Stratum
      - "8080:8080"   # API/WebSocket
      - "4444:4444"   # P2Pフェデレーション
      - "9090:9090"   # メトリクス
      - "8081:8081"   # ヘルスチェック
    environment:
      - OTEDAMA_MODE=production
      - DATABASE_URL=postgresql://otedama_user:${DB_PASSWORD}@db:5432/otedama?sslmode=require
      - REDIS_URL=redis://redis:6379/0
      - LOG_LEVEL=info
    volumes:
      - ./config/production.yaml:/app/config/config.yaml:ro
      - ./data:/app/data
      - ./logs:/app/logs
      - /etc/ssl/certs:/etc/ssl/certs:ro
      - /etc/ssl/private:/etc/ssl/private:ro
    depends_on:
      - db
      - redis
    networks:
      - otedama-network
    healthcheck:
      test: ["CMD", "/app/otedama", "health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    deploy:
      resources:
        limits:
          cpus: '16'
          memory: 32G
        reservations:
          cpus: '8'
          memory: 16G

  db:
    image: postgres:15-alpine
    container_name: otedama-db
    restart: unless-stopped
    environment:
      - POSTGRES_DB=otedama
      - POSTGRES_USER=otedama_user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_INITDB_ARGS=--encoding=UTF-8 --lc-collate=ja_JP.UTF-8 --lc-ctype=ja_JP.UTF-8
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks:
      - otedama-network

  redis:
    image: redis:7-alpine
    container_name: otedama-redis
    restart: unless-stopped
    command: >
      redis-server
      --maxmemory 1gb
      --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    networks:
      - otedama-network

  prometheus:
    image: prom/prometheus:latest
    container_name: otedama-prometheus
    restart: unless-stopped
    ports:
      - "9091:9090"
    volumes:
      - ./config/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    networks:
      - otedama-network

  grafana:
    image: grafana/grafana:latest
    container_name: otedama-grafana
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana_data:/var/lib/grafana
    networks:
      - otedama-network

volumes:
  postgres_data:
  redis_data:
  prometheus_data:
  grafana_data:

networks:
  otedama-network:
    driver: bridge
```

## Kubernetesエンタープライズ展開

### 1. Kubernetesクラスターの準備
```bash
# 名前空間の作成
kubectl create namespace otedama-production

# ネットワークポリシーの適用
kubectl apply -f k8s/network-policies.yaml

# シークレットの作成
kubectl create secret generic otedama-secrets \
  --from-literal=db-password=your_secure_password \
  --from-literal=api-key=your_api_key \
  --namespace=otedama-production
```

### 2. インフラストラクチャの展開
```bash
# 永続化付きPostgreSQLの展開
kubectl apply -f k8s/postgres-statefulset.yaml

# Redisクラスターの展開
kubectl apply -f k8s/redis-cluster.yaml

# 監視スタックの展開
kubectl apply -f k8s/monitoring/
```

### 3. Otedamaの展開
```bash
# 完全スタックの展開
kubectl apply -f k8s/

# ロールアウトの待機
kubectl rollout status deployment/otedama-deployment -n otedama-production

# ポッド状態の確認
kubectl get pods -n otedama-production
```

## プロダクション展開（ベアメタル）

### 1. システム最適化

`/etc/sysctl.conf`に追加:
```bash
# 高性能マイニング用ネットワーク最適化
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 8192 131072 268435456
net.ipv4.tcp_wmem = 8192 131072 268435456
net.core.netdev_max_backlog = 30000
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_max_syn_backlog = 30000
net.core.somaxconn = 32768

# ファイルディスクリプタとプロセス制限
fs.file-max = 2097152
fs.nr_open = 2097152
kernel.pid_max = 2097152

# マイニングワークロード用メモリ管理
vm.swappiness = 1
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5

# CPUマイニング最適化用ヒュージページ
vm.nr_hugepages = 128
kernel.shmmax = 68719476736
kernel.shmall = 4294967296
```

変更の適用と制限設定:
```bash
# sysctl変更の適用
sysctl -p

# ulimitsの設定
echo "otedama soft nofile 1048576" >> /etc/security/limits.conf
echo "otedama hard nofile 1048576" >> /etc/security/limits.conf
echo "otedama soft nproc 1048576" >> /etc/security/limits.conf
echo "otedama hard nproc 1048576" >> /etc/security/limits.conf

# ヒュージページの有効化
echo 'echo never > /sys/kernel/mm/transparent_hugepage/enabled' >> /etc/rc.local
echo 'echo never > /sys/kernel/mm/transparent_hugepage/defrag' >> /etc/rc.local
```

### 2. Systemdサービス

`/etc/systemd/system/otedama.service`の作成:
```ini
[Unit]
Description=Otedama エンタープライズP2Pマイニングプール
Documentation=https://docs.otedama.io
After=network-online.target postgresql.service redis.service
Wants=network-online.target
Requires=postgresql.service redis.service

[Service]
Type=notify
User=otedama
Group=otedama
WorkingDirectory=/opt/otedama
Environment=OTEDAMA_CONFIG=/opt/otedama/config/production.yaml
Environment=GOMAXPROCS=16
ExecStartPre=/opt/otedama/bin/otedama config validate
ExecStart=/opt/otedama/bin/otedama serve
ExecReload=/bin/kill -HUP $MAINPID
KillMode=mixed
KillSignal=SIGTERM
TimeoutStartSec=300
TimeoutStopSec=120
Restart=always
RestartSec=10

# セキュリティ設定
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/otedama/data /opt/otedama/logs

# リソース制限
LimitNOFILE=2097152
LimitNPROC=2097152
LimitCORE=0

# パフォーマンス設定
Nice=-10
IOSchedulingClass=1
IOSchedulingPriority=4

[Install]
WantedBy=multi-user.target
```

サービスの有効化と開始:
```bash
# メインサービス
sudo systemctl daemon-reload
sudo systemctl enable otedama
sudo systemctl start otedama

# 状態の確認
sudo systemctl status otedama
```

## エンタープライズサポート・監視

### ヘルスチェック
```bash
# システムヘルスチェック
curl -f http://localhost:8081/health || exit 1

# API可用性チェック
curl -f http://localhost:8080/api/status || exit 1

# データベース接続チェック
./bin/otedama config test-db

# マイニングエンジン状態
./bin/otedama mining status

# P2Pフェデレーションヘルス
./bin/otedama federation status
```

### パフォーマンス監視
```bash
# リアルタイムメトリクスの確認
curl http://localhost:9090/metrics | grep otedama

# リソース使用量の監視
htop -p $(pgrep otedama)

# マイニング統計の確認
./bin/otedama stats --format json

# ネットワーク接続の監視
ss -tuln | grep :3333
```

### ログ分析
```bash
# リアルタイムログ
journalctl -u otedama -f

# エラー分析
grep ERROR /opt/otedama/logs/otedama.log | tail -100

# パフォーマンス分析
grep "optimization" /opt/otedama/logs/otedama.log

# セキュリティイベント
grep "security" /opt/otedama/logs/audit.log
```

## プロダクション展開チェックリスト

### 展開前
- [ ] ハードウェア要件の確認
- [ ] システム最適化の適用
- [ ] 適切なインデックス付きデータベースセットアップ完了
- [ ] SSL証明書のインストールと検証
- [ ] セキュリティ強化の実装
- [ ] バックアップ戦略の設定とテスト
- [ ] 監視とアラートのセットアップ
- [ ] ロードバランサーの設定（該当する場合）
- [ ] ファイアウォールルールの実装
- [ ] パフォーマンスベンチマークの実行

### 展開後
- [ ] ヘルスチェックの合格
- [ ] 全マイニングアルゴリズムの機能確認
- [ ] P2Pフェデレーションの同期
- [ ] APIエンドポイントの正常応答
- [ ] WebSocket接続の動作確認
- [ ] メトリクス収集の運用開始
- [ ] ログローテーションの設定
- [ ] バックアップ自動化のテスト
- [ ] セキュリティ監査の完了
- [ ] パフォーマンス最適化の検証

### メンテナンススケジュール
- **日次**: ヘルスチェック、ログレビュー、バックアップ検証
- **週次**: パフォーマンス分析、セキュリティスキャン、データベースメンテナンス
- **月次**: セキュリティ監査、依存関係更新、容量プランニング
- **四半期**: 災害復旧テスト、設定レビュー

## サポート・ドキュメント

### 技術サポート
- **ドキュメント**: `/opt/otedama/docs/`ディレクトリを確認
- **設定**: `./bin/otedama config validate`で検証
- **APIリファレンス**: 実行時に`/api/docs`にアクセス

### トラブルシューティングリソース
```bash
# システムレポートの生成
./bin/otedama system report > system-report.txt

# 設定のエクスポート（サニタイズ済み）
./bin/otedama config export --sanitize > config-export.yaml

# デバッグバンドルの作成
./bin/otedama debug bundle --output debug-bundle.tar.gz
```

### パフォーマンス最適化
- **CPUマイニング**: ヒュージページ、NUMA対応の有効化
- **GPUマイニング**: メモリタイミング最適化、熱管理
- **ASICマイニング**: ファームウェア最適化、電力効率チューニング
- **ネットワーク**: TCP BBR、コネクションプーリング、ロードバランシング
- **データベース**: コネクションプーリング、クエリ最適化、インデックス
- **フェデレーション**: ピア選択、レピュテーション管理

---

**展開ガイドバージョン**: v2.1.5  
**最終更新**: 2025-01-15  
**対象環境**: プロダクションエンタープライズ