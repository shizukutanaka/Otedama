# Otedama Mining Pool API Documentation

## Overview

The Otedama Mining Pool provides a RESTful API and WebSocket interface for monitoring and managing mining operations. All API endpoints return JSON responses.

## Base URL

```
http://localhost:8080/api
```

## Authentication

Public endpoints do not require authentication. Admin endpoints require a JWT token or API key.

### Getting an Auth Token

```bash
POST /api/admin/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "your_password"
}
```

Response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "username": "admin",
  "permissions": ["full_access"],
  "expiresIn": "24h"
}
```

Use the token in subsequent requests:
```
Authorization: Bearer <token>
```

## Public Endpoints

### Pool Statistics

Get overall pool statistics.

```
GET /api/stats
```

Response:
```json
{
  "poolName": "Otedama Pool",
  "isRunning": true,
  "algorithm": "sha256",
  "paymentScheme": "PPLNS",
  "poolFee": 0.01,
  "connectedMiners": 1234,
  "totalHashrate": 123456789000000,
  "totalShares": 9876543,
  "totalBlocks": 42,
  "validShareRate": 99.5,
  "uptime": 3600000
}
```

### Miner Statistics

Get list of active miners.

```
GET /api/miners?limit=10&offset=0&sortBy=hashrate&order=desc
```

Response:
```json
{
  "total": 1234,
  "miners": [
    {
      "id": "miner_123",
      "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      "hashrate": 95000000000000,
      "validShares": 12345,
      "invalidShares": 10,
      "efficiency": 99.92,
      "lastSeen": 1640995200000,
      "online": true,
      "workers": [
        {
          "name": "worker1",
          "hashrate": 50000000000000,
          "difficulty": 65536
        }
      ]
    }
  ],
  "limit": 10,
  "offset": 0
}
```

### Individual Miner

Get statistics for a specific miner.

```
GET /api/miner/:address
```

Response:
```json
{
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "hashrate": 95000000000000,
  "hashrate24h": 94500000000000,
  "validShares": 12345,
  "invalidShares": 10,
  "pendingBalance": 0.00123456,
  "paidBalance": 1.23456789,
  "workers": 2,
  "joinedAt": 1640908800000,
  "lastPayment": 1640995200000
}
```

### Recent Blocks

Get recently found blocks.

```
GET /api/blocks/recent?limit=10
```

Response:
```json
[
  {
    "height": 714829,
    "hash": "00000000000000000007d0e3c2f8a5b9c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
    "reward": 6.25,
    "timestamp": 1640995200000,
    "confirmations": 6,
    "minerId": "miner_123",
    "minerAddress": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
  }
]
```

### Payment History

Get recent payments.

```
GET /api/payments?limit=20&offset=0
```

Response:
```json
{
  "total": 150,
  "payments": [
    {
      "id": "payment_789",
      "txid": "a1b2c3d4e5f6...",
      "amount": 0.01234567,
      "fee": 0.00001234,
      "minerAddress": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      "timestamp": 1640995200000,
      "confirmations": 6,
      "status": "confirmed"
    }
  ]
}
```

### Network Statistics

Get blockchain network statistics.

```
GET /api/network
```

Response:
```json
{
  "difficulty": 24272331996979.97,
  "networkHashrate": 175234567890000000000,
  "blockHeight": 714829,
  "blockReward": 6.25,
  "lastBlockTime": 1640995200000,
  "averageBlockTime": 600
}
```

### Health Check

Check pool health status.

```
GET /api/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600000,
  "components": {
    "stratum": "healthy",
    "database": "healthy",
    "payments": "healthy",
    "p2p": "healthy"
  },
  "version": "1.0.0"
}
```

## Admin Endpoints

All admin endpoints require authentication.

### Pool Configuration

Get current pool configuration.

```
GET /api/admin/config
Authorization: Bearer <token>
```

Update pool configuration.

```
PUT /api/admin/config
Authorization: Bearer <token>
Content-Type: application/json

{
  "poolFee": 0.01,
  "minimumPayment": 0.001,
  "paymentInterval": 3600000
}
```

### Miner Management

Ban a miner.

```
POST /api/admin/miners/:id/ban
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "Suspicious activity",
  "duration": 86400000
}
```

Unban a miner.

```
POST /api/admin/miners/:id/unban
Authorization: Bearer <token>
```

### Payment Management

Process pending payments.

```
POST /api/admin/payments/process
Authorization: Bearer <token>
```

Get pending payments.

```
GET /api/admin/payments/pending
Authorization: Bearer <token>
```

### System Control

Restart pool.

```
POST /api/admin/system/restart
Authorization: Bearer <token>
```

Enable/disable maintenance mode.

```
POST /api/admin/system/maintenance
Authorization: Bearer <token>
Content-Type: application/json

{
  "enabled": true,
  "message": "Scheduled maintenance"
}
```

## WebSocket API

Connect to real-time updates via WebSocket.

```
ws://localhost:8081/ws
```

### Subscription

After connecting, subscribe to channels:

```json
{
  "type": "subscribe",
  "channels": ["all"]
}
```

Available channels:
- `all` - All updates
- `pool` - Pool statistics
- `miners` - Miner updates
- `blocks` - New blocks
- `payments` - Payment updates

### Message Types

#### Pool Statistics Update
```json
{
  "type": "pool_stats",
  "data": {
    "hashrate": 123456789000000,
    "miners": 1234,
    "efficiency": 99.5,
    "blocksFound": 42
  }
}
```

#### Miner Update
```json
{
  "type": "miner_update",
  "data": {
    "minerId": "miner_123",
    "stats": {
      "hashrate": 95000000000000,
      "shares": 12345,
      "online": true
    }
  }
}
```

#### Block Found
```json
{
  "type": "block_found",
  "data": {
    "height": 714829,
    "hash": "00000000000000000007d0e3...",
    "reward": 6.25,
    "minerId": "miner_123"
  }
}
```

#### Payment Sent
```json
{
  "type": "payment_sent",
  "data": {
    "amount": 0.01234567,
    "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "txid": "a1b2c3d4e5f6..."
  }
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid miner address",
    "details": {}
  }
}
```

Common error codes:
- `INVALID_REQUEST` - Bad request parameters
- `UNAUTHORIZED` - Missing or invalid authentication
- `FORBIDDEN` - Insufficient permissions
- `NOT_FOUND` - Resource not found
- `RATE_LIMITED` - Too many requests
- `INTERNAL_ERROR` - Server error

## Rate Limiting

API requests are rate limited:
- Public endpoints: 100 requests per minute
- Authenticated endpoints: 1000 requests per minute
- WebSocket connections: 10 per IP address

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1640995200
```

## Examples

### cURL Examples

Get pool stats:
```bash
curl http://localhost:8080/api/stats
```

Get miner info:
```bash
curl http://localhost:8080/api/miner/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
```

Login as admin:
```bash
curl -X POST http://localhost:8080/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password"}'
```

### JavaScript Example

```javascript
// Fetch pool statistics
async function getPoolStats() {
  const response = await fetch('http://localhost:8080/api/stats');
  const stats = await response.json();
  console.log('Pool hashrate:', stats.totalHashrate);
}

// WebSocket connection
const ws = new WebSocket('ws://localhost:8081/ws');

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['all']
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Update:', message);
});
```

### Python Example

```python
import requests
import websocket
import json

# Get pool stats
response = requests.get('http://localhost:8080/api/stats')
stats = response.json()
print(f"Pool hashrate: {stats['totalHashrate']}")

# WebSocket connection
def on_message(ws, message):
    data = json.loads(message)
    print(f"Update: {data}")

ws = websocket.WebSocketApp("ws://localhost:8081/ws",
                          on_message=on_message)
ws.run_forever()
```

## SDK Libraries

Community-maintained SDKs:
- JavaScript/TypeScript: `npm install otedama-client`
- Python: `pip install otedama-py`
- Go: `go get github.com/otedama/otedama-go`

---

For more information, visit the [Otedama GitHub repository](https://github.com/otedama/otedama).
