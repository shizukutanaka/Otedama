# Otedama API リファレンス

## 概要

Otedama Mining PoolはRESTful APIを提供し、プール統計、マイナー管理、パフォーマンス監視が可能です。

**ベースURL**: `http://localhost:8080/api`  
**Content-Type**: `application/json`  
**認証**: JWT（管理機能）、APIキー（読み取り専用）

## 認証

### JWT認証（管理機能）

#### ログイン

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "password"
}
```

**レスポンス:**
```json
{
  "success": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 3600
}
```

#### トークンリフレッシュ

```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### 認証ヘッダー

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 2要素認証（2FA）

#### 2FA有効化

```http
POST /api/auth/2fa/enable
Authorization: Bearer YOUR_TOKEN
```

**レスポンス:**
```json
{
  "success": true,
  "secret": "JBSWY3DPEHPK3PXP",
  "qrCode": "data:image/png;base64,..."
}
```

#### 2FA検証

```http
POST /api/auth/2fa/verify
Content-Type: application/json
Authorization: Bearer YOUR_TOKEN

{
  "token": "123456"
}
```

## プール統計API

### 全体統計

```http
GET /api/stats
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "mode": "pool",
    "hashrate": {
      "total": 1234567890,
      "unit": "H/s",
      "formatted": "1.23 GH/s"
    },
    "miners": {
      "active": 15,
      "total": 20
    },
    "blocks": {
      "found": 3,
      "pending": 1,
      "confirmed": 2
    },
    "shares": {
      "valid": 98765,
      "invalid": 123,
      "validPercent": 99.88
    },
    "network": {
      "difficulty": 25000000000,
      "height": 750000
    },
    "peers": 5,
    "uptime": 86400
  }
}
```

### 履歴統計

```http
GET /api/stats/history?period=24h
```

**パラメータ:**
- `period`: 期間（1h, 6h, 24h, 7d, 30d）

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "timestamps": [1234567890, 1234567900, ...],
    "hashrate": [1234567890, 1234567900, ...],
    "miners": [15, 16, 14, ...],
    "shares": [100, 120, 95, ...]
  }
}
```

## マイナーAPI

### マイナー一覧

```http
GET /api/miners
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "miners": [
      {
        "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "workers": ["rig1", "rig2"],
        "hashrate": 500000000,
        "shares": {
          "valid": 1234,
          "invalid": 12
        },
        "lastShare": "2025-01-22T10:30:00Z",
        "balance": 0.00123456,
        "paid": 0.1
      }
    ],
    "total": 15
  }
}
```

### 個別マイナー情報

```http
GET /api/miner/:address
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "workers": {
      "rig1": {
        "hashrate": 250000000,
        "shares": {
          "valid": 600,
          "invalid": 5
        },
        "lastShare": "2025-01-22T10:29:00Z",
        "difficulty": 65536
      },
      "rig2": {
        "hashrate": 250000000,
        "shares": {
          "valid": 634,
          "invalid": 7
        },
        "lastShare": "2025-01-22T10:30:00Z",
        "difficulty": 65536
      }
    },
    "totalHashrate": 500000000,
    "balance": 0.00123456,
    "paid": 0.1,
    "payments": [
      {
        "amount": 0.01,
        "txid": "abc123...",
        "timestamp": "2025-01-21T00:00:00Z"
      }
    ]
  }
}
```

### マイナー設定更新（要認証）

```http
PUT /api/miner/:address/settings
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "minPayout": 0.005,
  "email": "miner@example.com",
  "notifications": true
}
```

## ブロックAPI

### 発見ブロック一覧

```http
GET /api/blocks?limit=50&offset=0
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "blocks": [
      {
        "height": 750001,
        "hash": "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054",
        "reward": 6.25,
        "finder": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "timestamp": "2025-01-22T09:00:00Z",
        "status": "confirmed",
        "confirmations": 6
      }
    ],
    "total": 25,
    "pending": 1,
    "confirmed": 24
  }
}
```

## シェアAPI

### 最新シェア

```http
GET /api/shares?limit=100
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "shares": [
      {
        "id": "share_123",
        "miner": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "worker": "rig1",
        "difficulty": 65536,
        "timestamp": "2025-01-22T10:30:00Z",
        "valid": true
      }
    ],
    "total": 98765
  }
}
```

### シェアチェーン情報

```http
GET /api/shares/chain
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "height": 24,
    "hash": "abc123...",
    "shares": 98765,
    "lastUpdate": "2025-01-22T10:30:00Z"
  }
}
```

## P2P ネットワークAPI

### ピア一覧

```http
GET /api/peers
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "peers": [
      {
        "id": "peer_1",
        "address": "192.168.1.100:6633",
        "version": "1.0.0",
        "hashrate": 987654321,
        "miners": 8,
        "latency": 12,
        "connected": "2025-01-22T08:00:00Z"
      }
    ],
    "total": 5
  }
}
```

### ピア統計

```http
GET /api/peers/stats
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "totalPeers": 5,
    "totalHashrate": 5432109876,
    "totalMiners": 45,
    "averageLatency": 15
  }
}
```

## 支払いAPI

### 支払い履歴

```http
GET /api/payments?limit=50&offset=0
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "payment_123",
        "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "amount": 0.01,
        "txid": "abc123...",
        "status": "confirmed",
        "timestamp": "2025-01-21T00:00:00Z"
      }
    ],
    "total": 150
  }
}
```

### 保留中の支払い

```http
GET /api/payments/pending
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "pending": [
      {
        "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "balance": 0.00456789,
        "minPayout": 0.001,
        "estimatedPayout": "2025-01-22T12:00:00Z"
      }
    ],
    "totalPending": 0.123456
  }
}
```

## 設定API（要認証）

### プール設定取得

```http
GET /api/config
Authorization: Bearer YOUR_TOKEN
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "pool": {
      "fee": 0.01,
      "minPayout": 0.001,
      "payoutInterval": 3600000
    },
    "stratum": {
      "port": 3333,
      "difficulty": {
        "initial": 16,
        "minimum": 1,
        "maximum": 4294967296
      }
    },
    "p2p": {
      "port": 6633,
      "maxPeers": 50
    }
  }
}
```

### プール設定更新

```http
PUT /api/config
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "pool": {
    "fee": 0.015,
    "minPayout": 0.005
  }
}
```

## 監視API

### ヘルスチェック

```http
GET /api/health
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 86400,
    "version": "1.0.0",
    "services": {
      "stratum": "running",
      "p2p": "running",
      "blockchain": "connected",
      "database": "healthy"
    }
  }
}
```

### パフォーマンスメトリクス

```http
GET /api/monitoring/metrics
```

**レスポンス:**
```json
{
  "success": true,
  "data": {
    "cpu": {
      "usage": 45.2,
      "cores": 8
    },
    "memory": {
      "used": 2147483648,
      "total": 8589934592,
      "percentage": 25
    },
    "network": {
      "in": 1234567890,
      "out": 987654321
    },
    "connections": {
      "stratum": 15,
      "p2p": 5,
      "api": 3
    }
  }
}
```

## エラーレスポンス

すべてのエラーは以下の形式で返されます：

```json
{
  "success": false,
  "error": {
    "code": "INVALID_ADDRESS",
    "message": "Invalid wallet address format",
    "details": {
      "field": "address",
      "value": "invalid"
    }
  }
}
```

### エラーコード

- `UNAUTHORIZED`: 認証が必要
- `FORBIDDEN`: アクセス権限なし
- `NOT_FOUND`: リソースが見つからない
- `INVALID_REQUEST`: リクエストが無効
- `RATE_LIMITED`: レート制限超過
- `INTERNAL_ERROR`: サーバーエラー

## レート制限

- 認証なし: 100リクエスト/分
- 認証あり: 1000リクエスト/分
- 管理者: 無制限

レート制限情報はレスポンスヘッダーに含まれます：

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

## WebSocket API

リアルタイム更新用のWebSocketエンドポイント：

### 接続

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

// 認証
ws.send(JSON.stringify({
  type: 'auth',
  token: 'YOUR_API_KEY'
}));

// イベント購読
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['stats', 'blocks', 'shares']
}));
```

### イベント

```javascript
// 統計更新
{
  "type": "stats",
  "data": {
    "hashrate": 1234567890,
    "miners": 15
  }
}

// 新規ブロック
{
  "type": "block",
  "data": {
    "height": 750001,
    "reward": 6.25
  }
}

// シェア送信
{
  "type": "share",
  "data": {
    "miner": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "valid": true
  }
}
```

## SDKとサンプルコード

### Node.js

```javascript
const OtedamaAPI = require('otedama-api');

const api = new OtedamaAPI({
  baseURL: 'http://localhost:8080/api',
  apiKey: 'YOUR_API_KEY'
});

// 統計取得
const stats = await api.getStats();
console.log(`Total hashrate: ${stats.hashrate.formatted}`);

// マイナー情報
const miner = await api.getMiner('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
console.log(`Balance: ${miner.balance}`);
```

### Python

```python
import requests

class OtedamaAPI:
    def __init__(self, base_url='http://localhost:8080/api', api_key=None):
        self.base_url = base_url
        self.headers = {'Authorization': f'Bearer {api_key}'} if api_key else {}
    
    def get_stats(self):
        response = requests.get(f'{self.base_url}/stats', headers=self.headers)
        return response.json()

# 使用例
api = OtedamaAPI(api_key='YOUR_API_KEY')
stats = api.get_stats()
print(f"Active miners: {stats['data']['miners']['active']}")
```

### cURL

```bash
# 統計取得
curl http://localhost:8080/api/stats

# 認証付きリクエスト
curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://localhost:8080/api/config

# マイナー設定更新
curl -X PUT \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"minPayout": 0.005}' \
     http://localhost:8080/api/miner/YOUR_ADDRESS/settings
```