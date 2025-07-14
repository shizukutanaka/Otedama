# Otedama API Reference

Comprehensive API documentation for Otedama.

## Base URL

```
http://localhost:8080/api
```

## Authentication

All API requests require authentication using an API key in the header:

```bash
curl -H "X-API-Key: YOUR_API_KEY" http://localhost:8080/api/stats
```

## Endpoints Overview

### Core Endpoints
- [GET /api/](#get-api) - API information
- [GET /api/health](#get-apihealth) - Health check
- [GET /api/stats](#get-apistats) - System statistics

### Mining Endpoints
- [GET /api/mining](#get-apimining) - Mining statistics
- [POST /api/mining/start](#post-apiminingstart) - Start mining
- [POST /api/mining/stop](#post-apiminingstop) - Stop mining
- [GET /api/gpu](#get-apigpu) - GPU statistics

### Pool Endpoints
- [GET /api/pool](#get-apipool) - Pool statistics
- [GET /api/pool/miners](#get-apipoolminers) - Connected miners
- [GET /api/pool/blocks](#get-apipoolblocks) - Found blocks

### DEX Endpoints
- [GET /api/dex](#get-apidex) - DEX statistics
- [GET /api/dex/enhanced](#get-apidexenhanced) - Enhanced DEX stats
- [GET /api/pools](#get-apipools) - Liquidity pools
- [POST /api/swap](#post-apiswap) - Execute swap
- [POST /api/dex/stake](#post-apidexstake) - Stake liquidity

### Blockchain Endpoints
- [GET /api/blockchain](#get-apiblockchain) - Blockchain status
- [GET /api/payments](#get-apipayments) - Payment statistics

### Security Endpoints
- [GET /api/security](#get-apisecurity) - Security statistics

### Admin Endpoints
- [GET /api/performance](#get-apiperformance) - Performance metrics
- [GET /api/backups](#get-apibackups) - Backup history
- [POST /api/backups/trigger](#post-apibackupstrigger) - Trigger backup

---

## Endpoint Details

### GET /api/

Get API information and available endpoints.

**Response:**
```json
{
  "version": "2.3.0",
  "name": "Otedama Ultimate+",
  "endpoints": [
    "/api/",
    "/api/health",
    "/api/stats",
    "..."
  ]
}
```

### GET /api/health

Health check endpoint for monitoring.

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600000,
  "timestamp": "2025-07-12T10:00:00.000Z"
}
```

### GET /api/stats

Get comprehensive system statistics.

**Response:**
```json
{
  "running": true,
  "uptime": 3600000,
  "enhanced": true,
  "config": {
    "currency": "RVN",
    "algorithm": "kawpow",
    "enhanced": true,
    "p2p": true,
    "mining": true,
    "api": true,
    "blockchain": true,
    "payment": true
  },
  "stats": {
    "peers": 15,
    "miners": 50,
    "poolHashrate": 1250000000,
    "miningHashrate": 25000000
  },
  "hardware": {
    "cpu": {
      "model": "Intel Core i9-10900K",
      "cores": 10,
      "threads": 20
    },
    "gpus": 2,
    "asics": 0
  }
}
```

### GET /api/mining

Get mining engine statistics.

**Response:**
```json
{
  "enabled": true,
  "algorithm": "kawpow",
  "currency": "RVN",
  "threads": 8,
  "hashrate": 25000000,
  "totalHashes": 1500000000,
  "sharesFound": 42,
  "uptime": 3600000,
  "efficiency": 11.67,
  "hardware": {
    "cpu": {
      "enabled": true,
      "threads": 8
    },
    "gpu": {
      "enabled": true,
      "devices": [0, 1]
    }
  }
}
```

### POST /api/mining/start

Start the mining engine.

**Request Body:**
```json
{
  "threads": 8,
  "algorithm": "kawpow",
  "intensity": 90
}
```

**Response:**
```json
{
  "success": true,
  "message": "Mining started"
}
```

### POST /api/mining/stop

Stop the mining engine.

**Response:**
```json
{
  "success": true,
  "message": "Mining stopped"
}
```

### GET /api/gpu

Get GPU mining statistics.

**Response:**
```json
{
  "devices": [
    {
      "id": 0,
      "name": "NVIDIA GeForce RTX 3080",
      "vendor": "NVIDIA",
      "memory": 10240,
      "temperature": 65,
      "utilization": 95,
      "powerDraw": 220,
      "hashrate": 45000000
    },
    {
      "id": 1,
      "name": "NVIDIA GeForce RTX 3070",
      "vendor": "NVIDIA",
      "memory": 8192,
      "temperature": 62,
      "utilization": 94,
      "powerDraw": 180,
      "hashrate": 30000000
    }
  ],
  "totalHashrate": 75000000,
  "totalPower": 400,
  "avgTemperature": 63.5,
  "errors": 0
}
```

### GET /api/pool

Get mining pool statistics.

**Response:**
```json
{
  "hashrate": 1250000000,
  "miners": 50,
  "difficulty": 1000000,
  "blockHeight": 850000,
  "blocksFound": 12,
  "totalShares": 125000,
  "validShares": 124500,
  "invalidShares": 500,
  "effort": 98.5,
  "lastBlockFound": "2025-07-12T09:45:00.000Z"
}
```

### GET /api/dex

Get DEX statistics.

**Response:**
```json
{
  "pools": 5,
  "totalValueLocked": "250000000000000000000",
  "volume24h": "50000000000000000000",
  "fees24h": "150000000000000000",
  "transactions24h": 1250
}
```

### GET /api/dex/enhanced

Get enhanced DEX statistics.

**Response:**
```json
{
  "pools": 5,
  "totalValueLocked": "250000000000000000000",
  "miningPools": 3,
  "totalStaked": "100000000000000000000",
  "openOrders": 25,
  "orderBookVolume": "75000000000000000000",
  "activeProposals": 2,
  "flashLoanFee": 0.09
}
```

### POST /api/swap

Execute a token swap.

**Request Body:**
```json
{
  "poolId": "RVN-OTE",
  "tokenIn": "RVN",
  "tokenOut": "OTE",
  "amountIn": "1000000000",
  "minAmountOut": "900000000000000000",
  "recipient": "0x123..."
}
```

**Response:**
```json
{
  "success": true,
  "amountOut": "950000000000000000",
  "price": "0.00105263",
  "priceImpact": 0.5,
  "fee": "3000000"
}
```

### POST /api/dex/stake

Stake liquidity tokens for rewards.

**Request Body:**
```json
{
  "user": "0x123...",
  "poolId": "RVN-OTE",
  "amount": "1000000000000000000"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully staked 1.0 LP tokens"
}
```

### POST /api/dex/governance/propose

Create a governance proposal.

**Request Body:**
```json
{
  "proposer": "0x123...",
  "title": "Reduce pool fees to 0.25%",
  "description": "This proposal aims to reduce trading fees...",
  "actions": [
    {
      "target": "feeManager",
      "method": "setFee",
      "params": [25]
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "proposalId": "proposal_1720778400000"
}
```

### GET /api/blockchain

Get blockchain connection status.

**Response:**
```json
{
  "RVN": {
    "connected": true,
    "config": {
      "host": "localhost",
      "port": 8766,
      "ssl": false
    }
  },
  "BTC": {
    "connected": false,
    "config": {
      "host": "localhost",
      "port": 8332,
      "ssl": false
    }
  }
}
```

### GET /api/payments

Get payment statistics.

**Response:**
```json
{
  "RVN": {
    "totalPaid": "500000.50",
    "totalPayments": 125,
    "pendingBalance": "12500.25",
    "eligibleMiners": 45,
    "lastPayment": "2025-07-12T08:00:00.000Z",
    "nextPayment": "2025-07-12T09:00:00.000Z"
  }
}
```

### GET /api/security

Get security statistics and recent events.

**Response:**
```json
{
  "stats": {
    "users": 10,
    "activeSessions": 25,
    "rateLimits": 5,
    "bannedIPs": 2,
    "activeConnections": 150,
    "suspiciousIPs": 3,
    "config": {
      "authEnabled": true,
      "ddosProtectionEnabled": true,
      "intrusionDetectionEnabled": true,
      "encryptionEnabled": true,
      "twoFactorEnabled": true,
      "honeypotEnabled": true
    }
  },
  "recentEvents": [
    {
      "type": "rate_limit",
      "ip": "192.168.1.100",
      "timestamp": 1720778400000,
      "details": {
        "requests": 105,
        "limit": 100
      },
      "severity": "medium"
    }
  ]
}
```

### GET /api/performance

Get performance metrics.

**Query Parameters:**
- `duration` (optional): Time duration in milliseconds

**Response:**
```json
{
  "current": {
    "cpu": 45.2,
    "memory": {
      "heapUsed": 125829120,
      "heapTotal": 209715200,
      "external": 2097152,
      "rss": 251658240
    },
    "eventLoop": {
      "latency": 2.5,
      "idle": 85
    }
  },
  "aggregated": {
    "avgCpu": 42.8,
    "maxCpu": 78.5,
    "avgMemory": 120,
    "maxMemory": 180
  },
  "report": {
    "summary": "System performing well",
    "warnings": [],
    "recommendations": []
  }
}
```

### GET /api/backups

Get backup history.

**Response:**
```json
{
  "history": [
    {
      "id": "backup_2025-07-12T08-00-00-000Z_a1b2c3d4",
      "timestamp": 1720771200000,
      "type": "incremental",
      "size": 5242880,
      "compressedSize": 1048576,
      "files": 125,
      "checksum": "sha256:abcdef...",
      "duration": 5000,
      "status": "completed"
    }
  ],
  "lastBackup": {
    "id": "backup_2025-07-12T08-00-00-000Z_a1b2c3d4",
    "timestamp": 1720771200000
  }
}
```

### POST /api/backups/trigger

Trigger a manual backup.

**Request Body:**
```json
{
  "type": "full"
}
```

**Response:**
```json
{
  "success": true,
  "backup": {
    "id": "backup_2025-07-12T10-00-00-000Z_e5f6g7h8",
    "timestamp": 1720778400000,
    "type": "full",
    "status": "completed"
  }
}
```

## 🔄 WebSocket API

Connect to WebSocket for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  // Subscribe to channels
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['stats', 'mining', 'blocks']
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received:', message);
});
```

### Available Channels

- `stats` - System statistics updates
- `mining` - Mining statistics
- `shares` - Share submissions
- `blocks` - New blocks found
- `pool` - Pool statistics
- `dex` - DEX events
- `security` - Security alerts
- `performance` - Performance metrics

### Message Format

```json
{
  "channel": "stats",
  "type": "update",
  "data": {
    "hashrate": 1250000000,
    "miners": 50
  },
  "timestamp": "2025-07-12T10:00:00.000Z"
}
```

## 🔐 Error Responses

All errors follow this format:

```json
{
  "error": true,
  "message": "Error description",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Common Error Codes

- `AUTH_REQUIRED` - Authentication required
- `INVALID_API_KEY` - Invalid API key
- `RATE_LIMITED` - Rate limit exceeded
- `INVALID_PARAMS` - Invalid parameters
- `RESOURCE_NOT_FOUND` - Resource not found
- `INTERNAL_ERROR` - Internal server error

## 📝 Rate Limiting

Default rate limits:
- 100 requests per minute per IP
- 1000 requests per hour per API key

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1720778460
```

## 🔧 SDK Examples

### JavaScript/TypeScript

```typescript
class OtedamaClient {
  constructor(private apiKey: string, private baseUrl: string) {}

  async getStats() {
    const response = await fetch(`${this.baseUrl}/api/stats`, {
      headers: {
        'X-API-Key': this.apiKey
      }
    });
    return response.json();
  }

  async startMining(config: MiningConfig) {
    const response = await fetch(`${this.baseUrl}/api/mining/start`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });
    return response.json();
  }
}
```

### Python

```python
import requests

class OtedamaClient:
    def __init__(self, api_key, base_url='http://localhost:8080'):
        self.api_key = api_key
        self.base_url = base_url
        self.headers = {'X-API-Key': api_key}
    
    def get_stats(self):
        response = requests.get(f'{self.base_url}/api/stats', headers=self.headers)
        return response.json()
    
    def start_mining(self, config):
        response = requests.post(
            f'{self.base_url}/api/mining/start',
            headers=self.headers,
            json=config
        )
        return response.json()
```

### cURL

```bash
# Get stats
curl -H "X-API-Key: YOUR_API_KEY" http://localhost:8080/api/stats

# Start mining
curl -X POST \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"threads": 8}' \
  http://localhost:8080/api/mining/start
```

---

**📚 For more information, visit the [Otedama Wiki](https://github.com/yourusername/otedama/wiki)**
