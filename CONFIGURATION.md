# Otedama Beta - 設定ガイド

## 環境変数設定

### 基本設定

```env
# アプリケーション設定
NODE_ENV=production
APP_NAME=Otedama
APP_PORT=8080
APP_HOST=0.0.0.0

# ログレベル
LOG_LEVEL=info  # debug, info, warn, error
LOG_FORMAT=json # json, pretty
```

### データベース設定

```env
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=otedama_production
DB_USER=otedama
DB_PASSWORD=your_secure_password
DB_SSL=true
DB_POOL_MIN=10
DB_POOL_MAX=100

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_DB=0
REDIS_CLUSTER=false
```

### セキュリティ設定

```env
# JWT設定
JWT_SECRET=your_64_character_random_string_here
JWT_EXPIRES_IN=24h
JWT_REFRESH_EXPIRES_IN=7d

# 暗号化
ENCRYPTION_KEY=your_32_character_key_here
ENCRYPTION_ALGORITHM=aes-256-gcm

# セッション
SESSION_SECRET=your_session_secret_here
SESSION_TIMEOUT=3600000

# CORS設定
CORS_ORIGIN=https://app.otedama.io,https://admin.otedama.io
CORS_CREDENTIALS=true
```

### マイニングプール設定

```env
# プール設定
POOL_NAME=Otedama Mining Pool
POOL_FEE=0.01
POOL_ADDRESS=your_btc_address_here
PAYOUT_THRESHOLD=0.001
PAYOUT_INTERVAL=3600000

# Stratum設定
STRATUM_PORT=3333
STRATUM_DIFF_MIN=1
STRATUM_DIFF_MAX=65536
STRATUM_VARDIFF=true

# アルゴリズム設定
ENABLED_ALGORITHMS=sha256,ethash,kawpow,randomx,scrypt
DEFAULT_ALGORITHM=sha256
```

### DEX設定

```env
# 取引エンジン設定
DEX_ENGINE_MODE=high_performance
DEX_MAX_ORDERS_PER_USER=1000
DEX_ORDER_BOOK_DEPTH=100
DEX_MIN_ORDER_SIZE=0.00001

# 手数料設定
MAKER_FEE=0.001
TAKER_FEE=0.002
WITHDRAWAL_FEE=0.0005

# MEV保護
MEV_PROTECTION=true
MEV_DELAY_MS=1000
```

### DeFi設定

```env
# AMM設定
AMM_SWAP_FEE=0.003
AMM_PROTOCOL_FEE=0.0005
AMM_SLIPPAGE_TOLERANCE=0.01

# 流動性プール
LP_MIN_LIQUIDITY=0.001
LP_LOCK_PERIOD=86400

# フラッシュローン
FLASH_LOAN_ENABLED=true
FLASH_LOAN_FEE=0.0009
FLASH_LOAN_MAX_AMOUNT=1000000
```

### パフォーマンス設定

```env
# ワーカー設定
WORKER_THREADS=16
WORKER_POOL_SIZE=32
MAX_CONNECTIONS=100000

# キャッシュ設定
CACHE_TTL=300
CACHE_MAX_SIZE=1000000
CACHE_STRATEGY=lru

# バッチ処理
BATCH_SIZE=1000
BATCH_INTERVAL=100
SHARE_PROCESS_BATCH=5000

# メモリ設定
NODE_OPTIONS=--max-old-space-size=8192
UV_THREADPOOL_SIZE=128
```

### 監視とアラート設定

```env
# Prometheus
PROMETHEUS_ENABLED=true
PROMETHEUS_PORT=9090
PROMETHEUS_PATH=/metrics

# アラート設定
ALERT_WEBHOOK=https://your-webhook-url
ALERT_EMAIL=alerts@otedama.io
ALERT_THRESHOLD_CPU=80
ALERT_THRESHOLD_MEMORY=90
ALERT_THRESHOLD_DISK=85

# ヘルスチェック
HEALTH_CHECK_INTERVAL=30000
HEALTH_CHECK_TIMEOUT=5000
```

### 外部サービス設定

```env
# 価格フィード
PRICE_FEED_PROVIDER=coingecko
PRICE_FEED_API_KEY=your_api_key
PRICE_FEED_UPDATE_INTERVAL=60000

# ブロックチェーンRPC
ETH_RPC_URL=https://mainnet.infura.io/v3/your_key
BTC_RPC_URL=http://localhost:8332
BTC_RPC_USER=bitcoin
BTC_RPC_PASS=your_password

# SMTP設定（メール通知用）
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=notifications@otedama.io
SMTP_PASS=your_password
SMTP_FROM=Otedama <no-reply@otedama.io>
```

### 高可用性設定

```env
# クラスタリング
CLUSTER_ENABLED=true
CLUSTER_WORKERS=auto
CLUSTER_RESTART_DELAY=3000

# レプリケーション
DB_REPLICA_HOST=replica.db.otedama.io
REDIS_SENTINEL=true
REDIS_SENTINELS=sentinel1:26379,sentinel2:26379

# フェイルオーバー
FAILOVER_ENABLED=true
FAILOVER_TIMEOUT=30000
FAILOVER_RETRY=3
```

## 設定ファイル

### config/production.json

```json
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0",
    "compression": true,
    "trustProxy": true
  },
  "security": {
    "helmet": {
      "contentSecurityPolicy": {
        "directives": {
          "defaultSrc": ["'self'"],
          "scriptSrc": ["'self'", "'unsafe-inline'"],
          "styleSrc": ["'self'", "'unsafe-inline'"],
          "imgSrc": ["'self'", "data:", "https:"],
          "connectSrc": ["'self'", "wss:", "https:"]
        }
      }
    },
    "rateLimit": {
      "windowMs": 60000,
      "max": 1000,
      "skipSuccessfulRequests": false
    }
  },
  "features": {
    "mining": true,
    "dex": true,
    "defi": true,
    "analytics": true,
    "ml": true
  }
}
```

### config/algorithms.json

```json
{
  "sha256": {
    "enabled": true,
    "ports": [3333],
    "difficulty": {
      "min": 1,
      "max": 4294967296,
      "default": 16384
    }
  },
  "ethash": {
    "enabled": true,
    "ports": [3334],
    "difficulty": {
      "min": 1000000,
      "max": 10000000000,
      "default": 4000000000
    },
    "dagDir": "/var/lib/otedama/dags"
  },
  "kawpow": {
    "enabled": true,
    "ports": [3335],
    "difficulty": {
      "min": 0.001,
      "max": 1000,
      "default": 1
    }
  }
}
```

## 起動スクリプト

### scripts/start-production.sh

```bash
#!/bin/bash

# 環境変数の読み込み
source .env.production

# ヘルスチェック
check_dependencies() {
  echo "Checking dependencies..."
  
  # PostgreSQL
  pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER
  if [ $? -ne 0 ]; then
    echo "PostgreSQL is not ready"
    exit 1
  fi
  
  # Redis
  redis-cli -h $REDIS_HOST -p $REDIS_PORT ping
  if [ $? -ne 0 ]; then
    echo "Redis is not ready"
    exit 1
  fi
  
  echo "All dependencies are ready"
}

# マイグレーション実行
run_migrations() {
  echo "Running database migrations..."
  npm run migrate:production
}

# アプリケーション起動
start_app() {
  echo "Starting Otedama..."
  
  # プロセスマネージャーで起動
  if command -v pm2 &> /dev/null; then
    pm2 start ecosystem.config.js --env production
  else
    NODE_ENV=production node index.js
  fi
}

# メイン処理
main() {
  check_dependencies
  run_migrations
  start_app
}

main
```

### PM2設定 (ecosystem.config.js)

```javascript
module.exports = {
  apps: [{
    name: 'otedama',
    script: './index.js',
    instances: 'max',
    exec_mode: 'cluster',
    env_production: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    max_memory_restart: '8G',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
```

## トラブルシューティング

### 設定の検証

```bash
# 設定ファイルの検証
node scripts/validate-config.js

# 環境変数の確認
node scripts/check-env.js
```

### よくある設定ミス

1. **JWT_SECRETが短すぎる**
   - 最低64文字のランダム文字列を使用

2. **データベース接続エラー**
   - ファイアウォール設定を確認
   - SSL設定を確認

3. **メモリ不足**
   - NODE_OPTIONSで最大メモリを増やす
   - ワーカー数を調整

4. **ポート競合**
   - 使用ポートが空いているか確認
   - netstatで確認: `netstat -tlnp`