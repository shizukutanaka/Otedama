# Otedama Mining Pool API Reference

## Overview

The Otedama Mining Pool provides a comprehensive REST API for pool operations, miner management, and administrative tasks. All API endpoints support JSON request/response formats.

## Base URL

```
http://localhost:8080/api/v1
```

## Authentication

### API Key Authentication

Include your API key in the request headers:

```http
X-API-Key: your_api_key_here
```

### Zero-Knowledge Proof Authentication

For privacy-focused authentication:

```http
X-ZKP-Proof: base64_encoded_proof
X-ZKP-Challenge: challenge_id
```

## Core Endpoints

### Pool Status

#### Get Pool Statistics

```http
GET /api/v1/pool/stats
```

**Response:**
```json
{
  "hashrate": 850000000000000,
  "miners": 15234,
  "workers": 45782,
  "blocks": {
    "pending": 3,
    "confirmed": 1247,
    "orphaned": 12
  },
  "pool_fee": 0.01,
  "solo_fee": 0.005,
  "payout_threshold": 0.001,
  "current_difficulty": 35252315417033.47,
  "network_hashrate": 450000000000000000000
}
```

#### Get Current Block

```http
GET /api/v1/pool/current-block
```

**Response:**
```json
{
  "height": 815234,
  "hash": "00000000000000000003c5a2e...",
  "previous_hash": "00000000000000000002b3a1d...",
  "timestamp": 1702314567,
  "difficulty": 35252315417033.47,
  "shares_submitted": 125634,
  "mining_mode": "pool"
}
```

### Miner Management

#### Register Miner

```http
POST /api/v1/miner/register
```

**Request:**
```json
{
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "email": "miner@example.com",
  "zkp_enabled": true
}
```

**Response:**
```json
{
  "miner_id": "miner_abc123",
  "api_key": "sk_live_abcdef123456",
  "stratum_url": "stratum+tcp://pool.otedama.com:3333",
  "zkp_challenge": "challenge_xyz789"
}
```

#### Get Miner Statistics

```http
GET /api/v1/miner/{miner_id}/stats
```

**Response:**
```json
{
  "miner_id": "miner_abc123",
  "hashrate": {
    "current": 125000000000,
    "average_1h": 123500000000,
    "average_24h": 124000000000
  },
  "shares": {
    "accepted": 98234,
    "rejected": 145,
    "stale": 89
  },
  "earnings": {
    "unpaid": 0.00456789,
    "paid_total": 1.23456789,
    "last_payment": "2024-01-15T10:30:00Z"
  },
  "workers": 12,
  "mining_mode": "hybrid",
  "solo_allocation": 0.3
}
```

#### Update Payout Preferences

```http
PUT /api/v1/miner/{miner_id}/payout-preferences
```

**Request:**
```json
{
  "currency": "BTC",
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "min_payout": 0.001,
  "auto_convert": true,
  "allow_batching": true,
  "custom_addresses": {
    "ETH": "0x742d35Cc6634C0532925a3b844Bc9e7595f6E123",
    "LTC": "LZe3w5qPbJ8KeUYVjsJ4mK9HvSzQJwDdQq"
  }
}
```

### Solo Mining

#### Enable Solo Mining

```http
POST /api/v1/miner/{miner_id}/solo/enable
```

**Request:**
```json
{
  "allocation_percentage": 50,
  "difficulty_adjustment": "auto",
  "payout_address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
}
```

#### Get Solo Mining Stats

```http
GET /api/v1/miner/{miner_id}/solo/stats
```

**Response:**
```json
{
  "solo_hashrate": 62500000000,
  "blocks_found": 2,
  "last_block": {
    "height": 814523,
    "reward": 6.32456789,
    "timestamp": "2024-01-10T15:23:45Z"
  },
  "estimated_time_to_block": 2592000,
  "luck": {
    "current": 156.7,
    "average_30d": 98.3
  }
}
```

### Currency Conversion

#### Get Conversion Rates

```http
GET /api/v1/conversion/rates
```

**Query Parameters:**
- `from`: Source currency (e.g., ETH)
- `to`: Target currency (e.g., BTC)
- `amount`: Amount to convert

**Response:**
```json
{
  "rates": [
    {
      "service": "btcpay_lightning",
      "rate": 0.0654,
      "fee": 0,
      "effective_rate": 0.0654,
      "estimated_amount": 0.0654,
      "instant": true,
      "no_kyc": true
    },
    {
      "service": "simpleswap",
      "rate": 0.0652,
      "fee": 0,
      "spread": 0.005,
      "effective_rate": 0.0649,
      "instant": true,
      "no_kyc": true
    }
  ],
  "best_rate": {
    "service": "btcpay_lightning",
    "rate": 0.0654,
    "savings_vs_exchange": "2.3%"
  }
}
```

#### Request Conversion

```http
POST /api/v1/conversion/convert
```

**Request:**
```json
{
  "from_coin": "ETH",
  "to_coin": "BTC",
  "amount": 0.5,
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "allow_batching": true,
  "preferred_service": "simpleswap"
}
```

**Response (Immediate):**
```json
{
  "conversion_id": "conv_xyz123",
  "status": "completed",
  "transaction_id": "0x1234567890abcdef",
  "from_amount": 0.5,
  "to_amount": 0.03265,
  "fee": 0.001,
  "service_used": "simpleswap"
}
```

**Response (Batched):**
```json
{
  "conversion_id": "batch_abc456",
  "status": "queued",
  "estimated_processing_time": "2024-01-15T12:00:00Z",
  "batch_progress": "87%",
  "queue_position": 3
}
```

### Bulk Operations

#### Get Bulk Conversion Status

```http
GET /api/v1/bulk/status
```

**Response:**
```json
{
  "active_batches": {
    "ETH:BTC": {
      "conversions": 12,
      "total_amount": 1.45,
      "progress": "145%",
      "oldest_waiting": 1823000,
      "estimated_processing": "2024-01-15T11:30:00Z"
    },
    "LTC:BTC": {
      "conversions": 5,
      "total_amount": 0.8,
      "progress": "80%",
      "oldest_waiting": 543000
    }
  },
  "statistics": {
    "total_batches": 234,
    "total_conversions": 1567,
    "average_batch_size": 6.7,
    "total_saved": 0.234,
    "average_savings": "1.85%"
  }
}
```

### Administrative Endpoints

#### Service Management Dashboard

```http
GET /api/v1/admin/services/dashboard
Authorization: X-Admin-Key: admin_key_here
```

**Response:**
```json
{
  "overview": {
    "total_services": 5,
    "healthy_services": 4,
    "degraded_services": 1,
    "failed_services": 0
  },
  "current_rates": {
    "ETH:BTC": {
      "btcpay_lightning": 0.0654,
      "simpleswap": 0.0652,
      "changenow": 0.0651
    }
  },
  "performance": {
    "total_conversions": 15234,
    "total_volume": 125.67,
    "fees_saved": 2.34
  }
}
```

#### Enable/Disable Service

```http
POST /api/v1/admin/services/{service_id}/enable
POST /api/v1/admin/services/{service_id}/disable
```

#### Test Service

```http
POST /api/v1/admin/services/{service_id}/test
```

**Request:**
```json
{
  "from_coin": "ETH",
  "to_coin": "BTC",
  "amount": 1
}
```

### Health & Monitoring

#### Health Check

```http
GET /api/v1/health
```

**Response:**
```json
{
  "status": "healthy",
  "version": "1.1.3",
  "uptime": 8640000,
  "components": {
    "stratum": "healthy",
    "api": "healthy",
    "database": "healthy",
    "redis": "healthy",
    "external_services": "degraded"
  }
}
```

#### Metrics (Prometheus Format)

```http
GET /api/v1/metrics
```

**Response:**
```
# HELP otedama_pool_hashrate Current pool hashrate
# TYPE otedama_pool_hashrate gauge
otedama_pool_hashrate 850000000000000

# HELP otedama_active_miners Number of active miners
# TYPE otedama_active_miners gauge
otedama_active_miners 15234

# HELP otedama_shares_total Total shares processed
# TYPE otedama_shares_total counter
otedama_shares_total{status="accepted"} 9823456
otedama_shares_total{status="rejected"} 14567
otedama_shares_total{status="stale"} 8901
```

## WebSocket API

### Real-time Updates

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

ws.on('message', (data) => {
  const update = JSON.parse(data);
  console.log(update);
});

// Subscribe to miner updates
ws.send(JSON.stringify({
  "action": "subscribe",
  "channel": "miner",
  "miner_id": "miner_abc123"
}));
```

**Update Types:**
```json
{
  "type": "hashrate_update",
  "miner_id": "miner_abc123",
  "hashrate": 125000000000,
  "timestamp": 1702314567
}

{
  "type": "share_accepted",
  "miner_id": "miner_abc123",
  "worker_id": "worker_01",
  "difficulty": 65536,
  "timestamp": 1702314567
}

{
  "type": "block_found",
  "height": 815234,
  "finder": "miner_abc123",
  "reward": 6.32456789,
  "mode": "solo"
}
```

## Error Responses

All error responses follow this format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid payout address format",
    "details": {
      "field": "address",
      "provided": "invalid_address"
    }
  },
  "request_id": "req_xyz123",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `INVALID_REQUEST` | 400 | Request validation failed |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |
| `SERVICE_UNAVAILABLE` | 503 | Service temporarily unavailable |

## Rate Limits

| Endpoint Type | Limit | Window |
|--------------|-------|--------|
| Public | 100 requests | 1 minute |
| Authenticated | 1000 requests | 1 minute |
| Admin | 100 requests | 1 minute |
| WebSocket | 10 messages | 1 second |

## SDK Examples

### Node.js

```javascript
const OtedamaClient = require('@otedama/node-sdk');

const client = new OtedamaClient({
  apiKey: 'your_api_key',
  baseUrl: 'https://pool.otedama.com'
});

// Get miner stats
const stats = await client.miners.getStats('miner_abc123');

// Request conversion
const conversion = await client.conversions.convert({
  fromCoin: 'ETH',
  toCoin: 'BTC',
  amount: 0.5,
  address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
});
```

### Python

```python
from otedama import OtedamaClient

client = OtedamaClient(
    api_key='your_api_key',
    base_url='https://pool.otedama.com'
)

# Get pool stats
stats = client.pool.get_stats()

# Enable solo mining
client.miners.enable_solo(
    miner_id='miner_abc123',
    allocation=50
)
```

### cURL

```bash
# Get miner statistics
curl -H "X-API-Key: your_api_key" \
  https://pool.otedama.com/api/v1/miner/miner_abc123/stats

# Update payout preferences  
curl -X PUT \
  -H "X-API-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"currency": "BTC", "auto_convert": true}' \
  https://pool.otedama.com/api/v1/miner/miner_abc123/payout-preferences
```