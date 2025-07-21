# Otedama Beta - API リファレンス

## 認証

すべてのAPIエンドポイントはJWT認証が必要です。

### ログイン

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

レスポンス:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user123",
    "email": "user@example.com",
    "role": "user"
  }
}
```

### 認証ヘッダー

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

## マイニングAPI

### ワーカー一覧

```http
GET /api/mining/workers
```

レスポンス:
```json
{
  "workers": [
    {
      "id": "worker1",
      "name": "GPU-RIG-01",
      "algorithm": "kawpow",
      "hashrate": 125000000,
      "status": "online",
      "lastSeen": "2025-01-21T10:30:00Z"
    }
  ]
}
```

### 統計情報

```http
GET /api/mining/stats
```

レスポンス:
```json
{
  "totalHashrate": 5250000000,
  "activeWorkers": 42,
  "totalShares": 1234567,
  "blocksFound": 3,
  "earnings24h": 0.0125
}
```

### シェア送信

```http
POST /api/mining/submit
Content-Type: application/json

{
  "workerId": "worker1",
  "jobId": "job123",
  "nonce": "0x12345678",
  "hash": "0xabcdef..."
}
```

## DEX API

### 注文板

```http
GET /api/dex/orderbook/:symbol
```

パラメータ:
- `symbol`: 取引ペア (例: BTC-USDT)
- `depth`: 表示深度 (デフォルト: 20)

レスポンス:
```json
{
  "symbol": "BTC/USDT",
  "bids": [
    {"price": 45000, "quantity": 0.5, "total": 22500},
    {"price": 44999, "quantity": 1.2, "total": 53998.8}
  ],
  "asks": [
    {"price": 45001, "quantity": 0.3, "total": 13500.3},
    {"price": 45002, "quantity": 0.8, "total": 36001.6}
  ],
  "timestamp": 1705834200000
}
```

### 注文発注

```http
POST /api/dex/order
Content-Type: application/json

{
  "symbol": "BTC/USDT",
  "side": "buy",
  "type": "limit",
  "price": 45000,
  "quantity": 0.1
}
```

レスポンス:
```json
{
  "orderId": "ord_123456",
  "status": "open",
  "filledQuantity": 0,
  "remainingQuantity": 0.1,
  "averagePrice": 0,
  "createdAt": "2025-01-21T10:30:00Z"
}
```

### 注文キャンセル

```http
DELETE /api/dex/order/:orderId
```

### 取引履歴

```http
GET /api/dex/trades
```

パラメータ:
- `symbol`: 取引ペア (オプション)
- `limit`: 取得件数 (デフォルト: 100)
- `startTime`: 開始時刻 (Unix timestamp)
- `endTime`: 終了時刻 (Unix timestamp)

## DeFi API

### 流動性プール

```http
GET /api/defi/pools
```

レスポンス:
```json
{
  "pools": [
    {
      "id": "pool_btc_usdt",
      "token0": "BTC",
      "token1": "USDT",
      "reserve0": 100.5,
      "reserve1": 4525000,
      "totalSupply": 1000,
      "apr": 12.5
    }
  ]
}
```

### 流動性追加

```http
POST /api/defi/add-liquidity
Content-Type: application/json

{
  "poolId": "pool_btc_usdt",
  "amount0": 0.1,
  "amount1": 4500,
  "slippage": 0.01
}
```

### スワップ実行

```http
POST /api/defi/swap
Content-Type: application/json

{
  "tokenIn": "BTC",
  "tokenOut": "USDT",
  "amountIn": 0.1,
  "slippage": 0.005,
  "recipient": "0x1234..."
}
```

## WebSocket API

### 接続

```javascript
const ws = new WebSocket('wss://api.otedama.io/ws');

ws.on('open', () => {
  // 認証
  ws.send(JSON.stringify({
    type: 'auth',
    token: 'your-jwt-token'
  }));
});
```

### チャンネル購読

```javascript
// 注文板の購読
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'orderbook',
  symbol: 'BTC/USDT'
}));

// 取引の購読
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'trades',
  symbol: 'BTC/USDT'
}));
```

### データ受信

```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  
  switch(msg.channel) {
    case 'orderbook':
      console.log('Orderbook update:', msg.data);
      break;
    case 'trades':
      console.log('New trade:', msg.data);
      break;
  }
});
```

## レート制限

| エンドポイント | 制限 | ウィンドウ |
|--------------|------|----------|
| 認証 | 5回 | 15分 |
| 取引 | 100回 | 1分 |
| 読取り | 1000回 | 1分 |
| WebSocket | 100メッセージ | 1分 |

## エラーレスポンス

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance for this operation",
    "details": {
      "required": 100,
      "available": 50
    }
  }
}
```

### エラーコード

| コード | 説明 |
|-------|------|
| `UNAUTHORIZED` | 認証エラー |
| `FORBIDDEN` | アクセス権限なし |
| `NOT_FOUND` | リソースが見つからない |
| `VALIDATION_ERROR` | 入力検証エラー |
| `INSUFFICIENT_BALANCE` | 残高不足 |
| `ORDER_NOT_FOUND` | 注文が見つからない |
| `RATE_LIMIT_EXCEEDED` | レート制限超過 |
| `INTERNAL_ERROR` | サーバーエラー |

## SDKサンプル

### JavaScript/TypeScript

```typescript
import { OtedamaClient } from '@otedama/sdk';

const client = new OtedamaClient({
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
  baseUrl: 'https://api.otedama.io'
});

// 注文発注
const order = await client.dex.placeOrder({
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'limit',
  price: 45000,
  quantity: 0.1
});
```

### Python

```python
from otedama import Client

client = Client(
    api_key='your-api-key',
    api_secret='your-api-secret'
)

# マイニング統計取得
stats = client.mining.get_stats()
print(f"Total hashrate: {stats['totalHashrate']}")
```