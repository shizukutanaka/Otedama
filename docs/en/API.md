# Otedama API Documentation

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Base URL](#base-url)
4. [Common Response Format](#common-response-format)
5. [Endpoints](#endpoints)
   - [Mining Operations](#mining-operations)
   - [Pool Statistics](#pool-statistics)
   - [Miner Management](#miner-management)
   - [Payment Operations](#payment-operations)
   - [System Information](#system-information)

## Overview

The Otedama API provides programmatic access to mining pool operations, statistics, and management features. All API responses are in JSON format and support both REST and WebSocket connections.

## Authentication

Otedama uses Zero-Knowledge Proof (ZKP) authentication for privacy-preserving access control.

### ZKP Authentication Flow

```http
POST /api/v1/auth/zkp/challenge
```

Request body:
```json
{
  "minerId": "your_miner_id"
}
```

Response:
```json
{
  "challenge": "random_challenge_string",
  "timestamp": 1234567890
}
```

### Submit Proof

```http
POST /api/v1/auth/zkp/verify
```

Request body:
```json
{
  "minerId": "your_miner_id",
  "proof": "zkp_proof_data",
  "challenge": "random_challenge_string"
}
```

Response:
```json
{
  "token": "jwt_access_token",
  "expiresIn": 3600
}
```

## Base URL

```
http://localhost:8080/api/v1
```

For production deployments, replace `localhost:8080` with your server address.

## Common Response Format

All API responses follow this format:

```json
{
  "success": true,
  "data": {},
  "timestamp": 1234567890
}
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  },
  "timestamp": 1234567890
}
```

## Endpoints

### Mining Operations

#### Submit Share

```http
POST /api/v1/mining/share
```

Submit a mining share for validation.

Request:
```json
{
  "minerId": "miner_123",
  "jobId": "job_456",
  "nonce": "0x12345678",
  "hash": "0xabcdef...",
  "difficulty": 1000000
}
```

Response:
```json
{
  "success": true,
  "data": {
    "accepted": true,
    "difficulty": 1000000,
    "reward": 0.00001234
  }
}
```

#### Get Mining Job

```http
GET /api/v1/mining/job/:minerId
```

Get current mining job for a specific miner.

Response:
```json
{
  "success": true,
  "data": {
    "jobId": "job_789",
    "prevHash": "0x123...",
    "coinbase": "0x456...",
    "merkleRoot": "0x789...",
    "difficulty": 1000000,
    "algorithm": "sha256"
  }
}
```

### Pool Statistics

#### Get Pool Overview

```http
GET /api/v1/pool/stats
```

Get overall pool statistics.

Response:
```json
{
  "success": true,
  "data": {
    "hashrate": 1234567890000,
    "miners": 1234,
    "blocksFound": 567,
    "luck": 98.5,
    "networkDifficulty": 23456789012345,
    "poolDifficulty": 1000000
  }
}
```

#### Get Mining History

```http
GET /api/v1/pool/blocks?limit=10&offset=0
```

Get recently found blocks.

Response:
```json
{
  "success": true,
  "data": {
    "blocks": [
      {
        "height": 123456,
        "hash": "0x123...",
        "reward": 6.25,
        "foundBy": "miner_123",
        "timestamp": 1234567890
      }
    ],
    "total": 567
  }
}
```

### Miner Management

#### Get Miner Stats

```http
GET /api/v1/miner/:minerId/stats
```

Get statistics for a specific miner.

Response:
```json
{
  "success": true,
  "data": {
    "minerId": "miner_123",
    "hashrate": 1234567890,
    "shares": {
      "accepted": 1000,
      "rejected": 10,
      "stale": 5
    },
    "uptime": 86400,
    "lastSeen": 1234567890,
    "earnings": {
      "total": 0.12345678,
      "pending": 0.00123456,
      "paid": 0.12222222
    }
  }
}
```

#### Update Miner Settings

```http
PUT /api/v1/miner/:minerId/settings
```

Update miner configuration.

Request:
```json
{
  "difficulty": 1000000,
  "payoutAddress": "bc1q...",
  "minPayout": 0.001
}
```

### Payment Operations

#### Get Payment History

```http
GET /api/v1/payments/:minerId?limit=10
```

Get payment history for a miner.

Response:
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "txid": "0x123...",
        "amount": 0.01234567,
        "timestamp": 1234567890,
        "status": "confirmed"
      }
    ]
  }
}
```

#### Request Payout

```http
POST /api/v1/payments/payout
```

Request manual payout (if balance meets minimum).

Request:
```json
{
  "minerId": "miner_123",
  "amount": 0.01,
  "address": "bc1q..."
}
```

### System Information

#### Health Check

```http
GET /api/v1/health
```

Check API health status.

Response:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "1.1.8",
    "uptime": 86400
  }
}
```

## WebSocket API

For real-time updates, connect to:

```
ws://localhost:8080/ws
```

### Subscribe to Updates

```json
{
  "type": "subscribe",
  "channels": ["stats", "blocks", "miner:miner_123"]
}
```

### Real-time Events

Pool statistics update:
```json
{
  "type": "stats",
  "data": {
    "hashrate": 1234567890000,
    "miners": 1234
  }
}
```

New block found:
```json
{
  "type": "block",
  "data": {
    "height": 123456,
    "reward": 6.25,
    "foundBy": "miner_123"
  }
}
```

## Rate Limiting

API requests are rate-limited to:
- 100 requests per minute for authenticated users
- 20 requests per minute for unauthenticated users

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

## Error Codes

| Code | Description |
|------|-------------|
| `AUTH_REQUIRED` | Authentication required |
| `INVALID_PROOF` | Invalid ZKP proof |
| `RATE_LIMITED` | Rate limit exceeded |
| `INVALID_SHARE` | Share validation failed |
| `INSUFFICIENT_BALANCE` | Balance too low for payout |
| `MINER_NOT_FOUND` | Miner ID not found |
| `INTERNAL_ERROR` | Server error |

## SDK Examples

### Node.js

```javascript
const OtedamaAPI = require('otedama-sdk');

const client = new OtedamaAPI({
  baseUrl: 'http://localhost:8080',
  minerId: 'miner_123'
});

// Authenticate
await client.authenticate();

// Get stats
const stats = await client.getMinerStats();
console.log('Hashrate:', stats.hashrate);
```

### Python

```python
from otedama_sdk import OtedamaClient

client = OtedamaClient(
    base_url='http://localhost:8080',
    miner_id='miner_123'
)

# Authenticate
client.authenticate()

# Submit share
result = client.submit_share(
    job_id='job_456',
    nonce='0x12345678',
    hash='0xabcdef...'
)
```

## Support

For API support, please:
- Check the documentation at `/docs`
- Submit issues via GitHub Issues
- Join our community forums