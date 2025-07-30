# Otedama API ドキュメント

## 概要

Otedama APIは、P2Pマイニングプールシステムと対話するためのRESTfulエンドポイントとWebSocket接続を提供します。すべてのAPIレスポンスは一貫したJSON形式に従います。

## ベースURL

```
http://localhost:8080/api/v1
```

## 認証

### ゼロ知識証明認証

従来のAPIキーの代わりに、Otedamaは認証にゼロ知識証明を使用します：

```bash
# 年齢証明を生成
curl -X POST http://localhost:8080/api/v1/auth/zkp/age \
  -H "Content-Type: application/json" \
  -d '{
    "birth_year": 1990,
    "current_year": 2025
  }'

# レスポンス
{
  "success": true,
  "data": {
    "proof": "0x1234...abcd",
    "public_inputs": ["18+"],
    "expires_at": "2025-07-31T00:00:00Z"
  }
}
```

## レスポンス形式

すべてのAPIレスポンスは以下の構造に従います：

```json
{
  "success": true,
  "data": {},
  "error": null,
  "time": "2025-07-30T12:00:00Z"
}
```

## エンドポイント

### システムステータス

#### GET /api/v1/status
現在のシステムステータスを取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "version": "2.0.0",
    "uptime": 3600,
    "mode": "pool",
    "network": "mainnet"
  }
}
```

#### GET /api/v1/health
詳細なヘルスチェック情報を取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "healthy": true,
    "checks": {
      "system": {
        "healthy": true,
        "status": "healthy",
        "metrics": {
          "cpu_percent": 45.2,
          "memory_percent": 62.1,
          "goroutines": 150
        }
      },
      "network": {
        "healthy": true,
        "status": "healthy",
        "metrics": {
          "latency_ms": 25
        }
      },
      "mining": {
        "healthy": true,
        "status": "healthy"
      }
    }
  }
}
```

#### GET /api/v1/stats
包括的なシステム統計を取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "mining": {
      "algorithm": "sha256d",
      "hashrate": 125000000000,
      "shares_submitted": 1024,
      "shares_accepted": 1020,
      "blocks_found": 2
    },
    "p2p": {
      "peers": 45,
      "total_hashrate": 5250000000000,
      "active_miners": 128
    },
    "performance": {
      "cpu_usage": 65.5,
      "memory_mb": 2048,
      "disk_io_mbps": 125.3
    }
  }
}
```

### マイニング操作

#### GET /api/v1/mining/stats
現在のマイニング統計を取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "hash_rate": 125000000000,
    "valid_shares": 1020,
    "difficulty": 4398046511104,
    "algorithm": "sha256d",
    "threads": 16,
    "running": true,
    "temperature": 72,
    "power_watts": 180
  }
}
```

#### POST /api/v1/mining/start
マイニング操作を開始します。

**リクエスト:**
```json
{
  "algorithm": "sha256d",
  "threads": 0,
  "intensity": 100
}
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "message": "マイニングが開始されました",
    "job_id": "job_123456"
  }
}
```

#### POST /api/v1/mining/stop
マイニング操作を停止します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "message": "マイニングが停止されました",
    "final_stats": {
      "total_hashes": 125000000000,
      "runtime_seconds": 3600
    }
  }
}
```

### P2Pプール操作

#### GET /api/v1/pool/stats
プール統計を取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "peer_count": 45,
    "total_shares": 102400,
    "blocks_found": 12,
    "total_hashrate": 5250000000000,
    "share_difficulty": 1000.0,
    "fee_percentage": 1.0,
    "payout_threshold": 0.01
  }
}
```

#### GET /api/v1/pool/peers
接続されているピアを取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": [
    {
      "peer_id": "peer_abc123",
      "address": "192.168.1.100:30303",
      "hashrate": 95000000000,
      "shares": 256,
      "connected_since": "2025-07-30T10:00:00Z",
      "zkp_verified": true
    }
  ]
}
```

#### GET /api/v1/pool/shares
最近のシェアを取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": [
    {
      "share_id": "share_789",
      "miner": "miner_xyz",
      "difficulty": 1024,
      "hash": "0x00000000...",
      "timestamp": "2025-07-30T12:00:00Z",
      "valid": true
    }
  ]
}
```

### ゼロ知識証明操作

#### POST /api/v1/zkp/generate
ゼロ知識証明を生成します。

**リクエスト:**
```json
{
  "proof_type": "hashpower",
  "data": {
    "hashrate": 125000000000,
    "duration": 3600
  }
}
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "proof": "0xabcd...1234",
    "protocol": "groth16",
    "public_inputs": ["125GH/s+"],
    "expires_at": "2025-07-31T00:00:00Z"
  }
}
```

#### POST /api/v1/zkp/verify
ゼロ知識証明を検証します。

**リクエスト:**
```json
{
  "proof": "0xabcd...1234",
  "public_inputs": ["125GH/s+"],
  "protocol": "groth16"
}
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "verified_at": "2025-07-30T12:00:00Z"
  }
}
```

### パフォーマンスとモニタリング

#### GET /api/v1/performance/benchmark
ベンチマーク結果を取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "mining_sha256d": {
      "hashrate_mhs": 125.5,
      "efficiency": 0.85
    },
    "zkp_groth16": {
      "generation_ops_sec": 100,
      "verification_ops_sec": 1000
    },
    "memory": {
      "allocation_ops_sec": 1000000,
      "bandwidth_gbps": 25.6
    }
  }
}
```

#### GET /api/v1/recovery/status
自動回復ステータスを取得します。

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "recovery_enabled": true,
    "max_retries": 3,
    "retry_interval": "30s",
    "recent_recoveries": [
      {
        "component": "mining",
        "strategy": "restart_mining",
        "success": true,
        "timestamp": "2025-07-30T11:30:00Z"
      }
    ]
  }
}
```

## WebSocket API

### 接続

WebSocketエンドポイントに接続：
```
ws://localhost:8080/api/v1/ws
```

### メッセージ形式

すべてのWebSocketメッセージはJSONを使用：

```json
{
  "type": "subscribe",
  "channel": "mining_stats"
}
```

### チャンネル

#### mining_stats
リアルタイムマイニング統計の更新。

**メッセージ:**
```json
{
  "type": "mining_stats",
  "data": {
    "hashrate": 125000000000,
    "shares": 1024,
    "temperature": 72,
    "timestamp": "2025-07-30T12:00:00Z"
  }
}
```

#### pool_updates
プールステータスの更新。

**メッセージ:**
```json
{
  "type": "pool_update",
  "data": {
    "event": "new_block",
    "block_height": 850000,
    "finder": "miner_abc",
    "reward": 6.25
  }
}
```

#### share_notifications
シェア送信通知。

**メッセージ:**
```json
{
  "type": "share",
  "data": {
    "miner": "miner_xyz",
    "difficulty": 1024,
    "valid": true,
    "timestamp": "2025-07-30T12:00:00Z"
  }
}
```

## エラーコード

| コード | 説明 |
|-------|------|
| 400 | Bad Request - 無効なパラメータ |
| 401 | Unauthorized - ZKP検証失敗 |
| 404 | Not Found - リソースが見つかりません |
| 429 | Too Many Requests - レート制限超過 |
| 500 | Internal Server Error - 内部サーバーエラー |
| 503 | Service Unavailable - システム異常 |

## レート制限

- デフォルト: IPあたり1分間に100リクエスト
- WebSocket: 接続あたり1分間に1000メッセージ
- バースト: 200リクエスト

## SDKと例

### Goクライアント

```go
import "github.com/shizukutanaka/Otedama/sdk/go"

client := otedama.NewClient("http://localhost:8080")
stats, err := client.GetMiningStats()
```

### Pythonクライアント

```python
from otedama import OtedamaClient

client = OtedamaClient("http://localhost:8080")
stats = client.get_mining_stats()
```

### JavaScript/Node.js

```javascript
const { OtedamaClient } = require('otedama-sdk');

const client = new OtedamaClient('http://localhost:8080');
const stats = await client.getMiningStats();
```

## Postmanコレクション

API テスト用のPostmanコレクションをダウンロード：
[Otedama APIコレクション](https://github.com/shizukutanaka/Otedama/blob/master/docs/otedama-api.postman_collection.json)

## サポート

APIサポートと質問：
- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- ドキュメント: https://github.com/shizukutanaka/Otedama/wiki