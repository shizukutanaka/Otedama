# Otedama API Documentation

## Overview

Otedama provides comprehensive REST and WebSocket APIs for pool management, mining operations, and monitoring. All APIs support JSON format and include authentication for sensitive operations.

## Base URLs

- REST API: `http://localhost:8080/api`
- WebSocket: `ws://localhost:8081`
- Stratum: `stratum+tcp://localhost:3333`
- Stratum V2: `stratum2+tcp://localhost:3336`

## Authentication

### API Key Authentication

Include your API key in the request header:

```
X-API-Key: your-api-key-here
```

### JWT Authentication

For user-specific operations:

```
Authorization: Bearer your-jwt-token-here
```

## REST API Endpoints

### Pool Information

#### GET /api/stats
Get current pool statistics.

**Response:**
```json
{
  "poolName": "Otedama Pool",
  "hashrate": 1234567890,
  "miners": 1523,
  "workers": 3045,
  "blocksFound": 142,
  "totalPaid": 523.45678901,
  "fee": 0.01,
  "paymentScheme": "PPLNS",
  "algorithms": ["sha256", "scrypt", "ethash"],
  "uptime": 8640000
}
```

#### GET /api/pool/info
Get detailed pool information.

**Response:**
```json
{
  "version": "1.0.8",
  "network": {
    "p2pPeers": 45,
    "stratumConnections": 1523,
    "bandwidth": {
      "in": "125.4 MB/s",
      "out": "89.2 MB/s"
    }
  },
  "performance": {
    "sharesPerSecond": 10234,
    "latency": {
      "p50": 0.8,
      "p95": 1.2,
      "p99": 2.1
    }
  }
}
```

### Miner Operations

#### GET /api/miner/:address
Get miner statistics and information.

**Parameters:**
- `address` - Miner wallet address

**Response:**
```json
{
  "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  "hashrate": 1234567,
  "workers": 3,
  "shares": {
    "accepted": 15234,
    "rejected": 23,
    "stale": 5
  },
  "balance": 0.12345678,
  "paid": 5.67890123,
  "lastShare": "2024-01-20T15:30:00Z"
}
```

#### GET /api/miner/:address/workers
Get all workers for a miner.

**Response:**
```json
{
  "workers": [
    {
      "name": "rig1",
      "hashrate": 456789,
      "shares": {
        "accepted": 5234,
        "rejected": 8
      },
      "lastShare": "2024-01-20T15:28:00Z",
      "difficulty": 65536
    }
  ]
}
```

#### GET /api/miner/:address/payments
Get payment history.

**Query Parameters:**
- `limit` - Number of records (default: 100)
- `offset` - Pagination offset (default: 0)

**Response:**
```json
{
  "payments": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "amount": 0.12345678,
      "txid": "0x123...",
      "timestamp": "2024-01-20T12:00:00Z",
      "confirmations": 6
    }
  ],
  "total": 142,
  "hasMore": true
}
```

### Mining Operations

#### POST /api/share/submit
Submit a share (usually handled by Stratum).

**Request:**
```json
{
  "jobId": "abc123",
  "nonce": "0x12345678",
  "hash": "0x000000000019d6689c085ae165831e93...",
  "worker": "rig1",
  "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
}
```

**Response:**
```json
{
  "accepted": true,
  "difficulty": 65536,
  "reward": 0.00001234
}
```

### Administrative Operations

#### POST /api/admin/pool/fee
Update pool fee (requires admin authentication).

**Request:**
```json
{
  "fee": 0.015
}
```

#### POST /api/admin/payout/trigger
Manually trigger payouts.

**Request:**
```json
{
  "minAmount": 0.01,
  "addresses": [] // Optional: specific addresses
}
```

#### GET /api/admin/monitoring
Get detailed monitoring data.

**Response:**
```json
{
  "system": {
    "cpu": 45.2,
    "memory": {
      "used": 8192,
      "total": 16384
    },
    "disk": {
      "used": 102400,
      "total": 512000
    }
  },
  "network": {
    "connections": 1523,
    "bandwidth": {
      "in": 125.4,
      "out": 89.2
    }
  },
  "security": {
    "blockedIPs": 23,
    "rateLimited": 145,
    "threats": 5
  }
}
```

## WebSocket API

### Connection

```javascript
const ws = new WebSocket('ws://localhost:8081');

ws.on('open', () => {
  // Authenticate
  ws.send(JSON.stringify({
    type: 'auth',
    apiKey: 'your-api-key'
  }));
});
```

### Subscriptions

#### Subscribe to Pool Stats
```json
{
  "type": "subscribe",
  "channel": "pool_stats"
}
```

**Updates:**
```json
{
  "type": "pool_stats",
  "data": {
    "hashrate": 1234567890,
    "miners": 1523,
    "difficulty": 123456789
  }
}
```

#### Subscribe to Miner Updates
```json
{
  "type": "subscribe",
  "channel": "miner",
  "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
}
```

**Updates:**
```json
{
  "type": "miner_update",
  "data": {
    "hashrate": 1234567,
    "shares": {
      "accepted": 15235,
      "rejected": 23
    },
    "balance": 0.12345679
  }
}
```

#### Subscribe to Blocks
```json
{
  "type": "subscribe",
  "channel": "blocks"
}
```

**Updates:**
```json
{
  "type": "new_block",
  "data": {
    "height": 815234,
    "hash": "0x000000000019d6689c085ae165831e93...",
    "reward": 6.25,
    "finder": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "timestamp": "2024-01-20T15:30:00Z"
  }
}
```

## Stratum Protocol

### Stratum V1

Standard JSON-RPC 2.0 over TCP.

#### Mining.Subscribe
```json
{
  "id": 1,
  "method": "mining.subscribe",
  "params": ["OtedamaMiner/1.0"]
}
```

#### Mining.Authorize
```json
{
  "id": 2,
  "method": "mining.authorize",
  "params": ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.worker1", "password"]
}
```

#### Mining.Submit
```json
{
  "id": 3,
  "method": "mining.submit",
  "params": ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.worker1", "job123", "00000000", "65432100", "12345678"]
}
```

### Stratum V2

Binary protocol with improved efficiency.

```
Message Format:
[Message Type: 1 byte][Flags: 1 byte][Length: 2 bytes][Payload: variable]

Message Types:
0x01 - Setup Connection
0x02 - Setup Success
0x03 - Setup Error
0x10 - New Mining Job
0x11 - Submit Share
0x12 - Share Accepted
0x13 - Share Rejected
```

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource not found |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Pool maintenance |

## Rate Limiting

- Default: 1000 requests per minute per IP
- Authenticated: 5000 requests per minute
- WebSocket: 100 messages per second

## Webhooks

Configure webhooks for real-time notifications:

```json
POST /api/admin/webhooks
{
  "url": "https://your-server.com/webhook",
  "events": ["block_found", "large_payment", "worker_offline"],
  "secret": "your-webhook-secret"
}
```

## SDK Examples

### JavaScript/Node.js

```javascript
import { OtedamaClient } from 'otedama-sdk';

const client = new OtedamaClient({
  apiKey: 'your-api-key',
  baseUrl: 'http://localhost:8080'
});

// Get pool stats
const stats = await client.getPoolStats();

// Monitor miner
client.on('miner:update', (data) => {
  console.log('Miner update:', data);
});
```

### Python

```python
from otedama import OtedamaClient

client = OtedamaClient(
    api_key='your-api-key',
    base_url='http://localhost:8080'
)

# Get miner info
miner = client.get_miner('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')

# Subscribe to updates
@client.on('pool_stats')
def on_stats(data):
    print(f"Pool hashrate: {data['hashrate']}")
```

## Best Practices

1. **Authentication**: Always use HTTPS in production
2. **Rate Limiting**: Implement exponential backoff
3. **Error Handling**: Check response status codes
4. **WebSocket**: Implement reconnection logic
5. **Monitoring**: Subscribe only to needed channels

## API Versioning

The API uses semantic versioning. Version is included in response headers:

```
X-API-Version: 1.0.8
```

Deprecated endpoints include a deprecation notice:

```
X-API-Deprecated: true
X-API-Deprecation-Date: 2024-12-31
```