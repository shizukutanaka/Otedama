# Otedama 設定ガイド

## 設定方法

Otedamaは以下の優先順位で設定を読み込みます：
1. コマンドライン引数
2. 環境変数
3. 設定ファイル（config/*.json）
4. デフォルト値

## コマンドライン設定

### 基本オプション

```bash
# スタンドアロンモード（推奨）
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS

# 個別モード
node index.js --mode pool   # プールのみ
node index.js --mode miner  # マイナーのみ
node index.js --mode both   # 両方
```

### ネットワーク設定

```bash
node index.js --mode standalone \
  --stratum-port 3333 \      # Stratumサーバーポート
  --api-port 8080 \          # REST APIポート
  --p2p-port 6633 \          # P2Pネットワークポート
  --web-port 3000            # Web UIポート
```

### ブロックチェーン接続

```bash
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --blockchain-url http://localhost:8332 \
  --blockchain-user bitcoinrpc \
  --blockchain-pass yourpassword \
  --blockchain-poll 5000     # ポーリング間隔（ミリ秒）
```

### プール設定

```bash
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --fee 0.01 \               # プール手数料（1%）
  --min-payout 0.001 \       # 最小支払額
  --payout-interval 3600000 \# 支払間隔（1時間）
  --reward-scheme PPLNS      # 報酬方式: PPLNS, PPS, PROP
```

### P2P設定

```bash
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --max-peers 50 \           # 最大ピア数
  --discovery-interval 30000 \# 探索間隔（30秒）
  --share-chain-length 24    # シェアチェーン長（時間）
```

### パフォーマンス設定

```bash
node index.js --mode standalone \
  --coinbase-address YOUR_WALLET_ADDRESS \
  --workers 8 \              # ワーカースレッド数
  --cache-size 512 \         # キャッシュサイズ（MB）
  --fast-validation \        # 高速検証モード
  --db-path ./data           # データベースパス
```

## 環境変数設定

### 基本設定

```bash
# アプリケーション
export NODE_ENV=production
export LOG_LEVEL=info      # debug, info, warn, error

# ネットワーク
export STRATUM_PORT=3333
export API_PORT=8080
export P2P_PORT=6633
export WEB_PORT=3000

# ブロックチェーン
export BLOCKCHAIN_URL=http://localhost:8332
export BLOCKCHAIN_USER=bitcoinrpc
export BLOCKCHAIN_PASS=yourpassword
export COINBASE_ADDRESS=YOUR_WALLET_ADDRESS

# プール
export POOL_FEE=0.01
export MIN_PAYOUT=0.001
export PAYOUT_INTERVAL=3600000
```

### セキュリティ設定

```bash
# JWT認証
export JWT_SECRET=your_64_character_random_string_here
export JWT_EXPIRES_IN=3600        # 1時間
export JWT_REFRESH_EXPIRES_IN=604800  # 7日

# API認証
export API_AUTH_ENABLED=true
export API_SECRET=your_api_secret_here

# DDoS保護
export RATE_LIMIT_WINDOW=60000    # 1分
export RATE_LIMIT_MAX=100         # 最大リクエスト数

# 暗号化
export ENCRYPTION_KEY=your_32_character_key_here
```

### 詳細設定

```bash
# 難易度調整
export DIFF_INITIAL=16
export DIFF_MINIMUM=1
export DIFF_MAXIMUM=4294967296
export DIFF_RETARGET_TIME=60      # 秒

# ワーカー設定
export MAX_WORKERS_PER_IP=10
export WORKER_TIMEOUT=300000      # 5分

# シェア設定
export SHARE_WINDOW=3600          # 1時間
export SHARE_VALIDATION_STRICT=true
```

## 設定ファイル

### デフォルト設定（config/default.json）

```json
{
  "pool": {
    "name": "Otedama Mining Pool",
    "port": 3333,
    "difficulty": {
      "initial": 16,
      "minimum": 1,
      "maximum": 4294967296,
      "retargetTime": 60
    },
    "fee": 0.01,
    "payouts": {
      "enabled": true,
      "interval": 3600000,
      "minimum": 0.001
    },
    "rewards": {
      "scheme": "PPLNS",
      "window": 24
    }
  },
  "p2p": {
    "enabled": true,
    "port": 6633,
    "maxPeers": 50,
    "discovery": {
      "enabled": true,
      "interval": 30000,
      "multicast": "239.255.255.250"
    }
  },
  "api": {
    "enabled": true,
    "port": 8080,
    "auth": {
      "enabled": false,
      "type": "jwt"
    },
    "rateLimit": {
      "enabled": true,
      "window": 60000,
      "max": 100
    }
  },
  "stratum": {
    "vardiff": {
      "enabled": true,
      "minDiff": 1,
      "maxDiff": 4294967296,
      "targetTime": 15,
      "retargetTime": 60,
      "variancePercent": 30
    },
    "banning": {
      "enabled": true,
      "checkThreshold": 100,
      "invalidPercent": 50,
      "time": 600000
    }
  },
  "logging": {
    "level": "info",
    "files": {
      "enabled": true,
      "path": "./logs",
      "maxSize": "100m",
      "maxFiles": 10
    }
  },
  "database": {
    "type": "sqlite",
    "path": "./data/otedama.db",
    "options": {
      "wal": true,
      "cache": 10000
    }
  },
  "monitoring": {
    "enabled": true,
    "statsInterval": 60000,
    "retentionDays": 30
  }
}
```

### 本番環境設定（config/production.json）

```json
{
  "pool": {
    "name": "Otedama Production Pool"
  },
  "logging": {
    "level": "warn"
  },
  "api": {
    "auth": {
      "enabled": true
    }
  },
  "monitoring": {
    "statsInterval": 300000,
    "retentionDays": 90
  }
}
```

### 開発環境設定（config/development.json）

```json
{
  "pool": {
    "name": "Otedama Dev Pool"
  },
  "logging": {
    "level": "debug"
  },
  "api": {
    "auth": {
      "enabled": false
    }
  }
}
```

## エンタープライズ設定

### クラスタリング

```bash
# クラスタリング有効化
node index.js --mode standalone \
  --enterprise \
  --cluster-workers 16 \     # ワーカープロセス数
  --cluster-mode auto        # auto, manual
```

### 高可用性（HA）

```bash
# HA構成
node index.js --mode standalone \
  --enterprise \
  --ha-enabled \
  --ha-nodes node1:5556,node2:5556,node3:5556 \
  --ha-role auto            # auto, master, slave
```

### データベースシャーディング

```bash
# シャーディング有効化
node index.js --mode standalone \
  --enterprise \
  --shard-enabled \
  --shard-count 32 \
  --shard-replicas 2
```

### 監視とアラート

```bash
# Prometheus互換メトリクス
node index.js --mode standalone \
  --metrics-enabled \
  --metrics-port 9090 \
  --metrics-path /metrics
```

## アルゴリズム別設定

### SHA256（Bitcoin）

```json
{
  "algorithms": {
    "sha256": {
      "enabled": true,
      "ports": {
        "stratum": 3333,
        "getwork": 8332
      },
      "difficulty": {
        "initial": 16,
        "minimum": 1
      }
    }
  }
}
```

### Ethash（Ethereum Classic）

```json
{
  "algorithms": {
    "ethash": {
      "enabled": true,
      "ports": {
        "stratum": 3334
      },
      "difficulty": {
        "initial": 4000000000,
        "minimum": 1000000
      }
    }
  }
}
```

### RandomX（Monero）

```json
{
  "algorithms": {
    "randomx": {
      "enabled": true,
      "ports": {
        "stratum": 3335
      },
      "difficulty": {
        "initial": 30000,
        "minimum": 1000
      }
    }
  }
}
```

## トラブルシューティング

### 設定の確認

```bash
# 現在の設定を表示
node index.js --show-config

# 設定の検証
node index.js --validate-config
```

### 環境変数の優先順位

```bash
# コマンドライン > 環境変数 > 設定ファイル
POOL_FEE=0.02 node index.js --fee 0.015
# 結果: fee = 0.015（コマンドラインが優先）
```

### 設定のリロード

一部の設定は実行中に変更可能：

```bash
# API経由で設定変更（要認証）
curl -X PUT http://localhost:8080/api/config \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pool": {"fee": 0.015}}'
```

## ベストプラクティス

1. **セキュリティ**
   - 本番環境では必ずJWT_SECRETを変更
   - API認証を有効化
   - DDoS保護を適切に設定

2. **パフォーマンス**
   - ワーカー数はCPUコア数に合わせる
   - キャッシュサイズは利用可能メモリに応じて調整
   - データベースWALモードを有効化

3. **信頼性**
   - 定期的なバックアップを設定
   - ログローテーションを有効化
   - 監視とアラートを設定

4. **スケーラビリティ**
   - 大規模運用時はエンタープライズ機能を活用
   - データベースシャーディングを検討
   - クラスタリングで負荷分散