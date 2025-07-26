# Otedama API Documentation

Complete API reference for the Otedama High-Performance P2P Mining Pool.

## Table of Contents

- [Authentication](#authentication)
- [Mining Pool API](#mining-pool-api)
- [Statistics API](#statistics-api)
- [Monitoring API](#monitoring-api)
- [Administration API](#administration-api)
- [WebSocket API](#websocket-api)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Examples](#examples)

## Base URL

```
http://localhost:8081/api/v1
```

## Authentication

Otedama uses Zero-Knowledge Proof (ZKP) authentication for privacy-preserving access control.

### Generate ZKP Token

```http
POST /auth/zkp/generate
Content-Type: application/json

{
  "minerAddress": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "attributes": {
    "age": 25,
    "balance": 1000,
    "reputation": 95
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "zkp_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
    "proof": {
      "ageProof": "0x1a2b3c...",
      "balanceProof": "0x4d5e6f...",
      "reputationProof": "0x7g8h9i..."
    },
    "expiresAt": "2024-01-15T10:30:00Z"
  }
}
```

### Verify ZKP Token

```http
POST /auth/zkp/verify
Content-Type: application/json
Authorization: Bearer zkp_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...

{
  "token": "zkp_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "proof": {
    "ageProof": "0x1a2b3c...",
    "balanceProof": "0x4d5e6f...",
    "reputationProof": "0x7g8h9i..."
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "attributes": {
      "ageVerified": true,
      "balanceVerified": true,
      "reputationVerified": true
    },
    "sessionId": "sess_1234567890abcdef"
  }
}
```

## Mining Pool API

### Get Pool Information

```http
GET /pool/info
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Otedama Mining Pool",
    "algorithm": "sha256",
    "coin": "BTC",
    "fee": 0.01,
    "minPayout": 0.001,
    "blockHeight": 820156,
    "difficulty": 73197634206448.1,
    "networkHashrate": "550.5 EH/s",
    "poolHashrate": "125.3 TH/s",
    "activeMiners": 1247,
    "blocksFound": 42,
    "lastBlockTime": "2024-01-14T15:45:32Z",
    "endpoints": {
      "stratum": "stratum+tcp://localhost:3333",
      "api": "http://localhost:8081/v1",
      "websocket": "ws://localhost:8082/v1"
    }
  }
}
```

### Submit Share

```http
POST /pool/submit
Content-Type: application/json
Authorization: Bearer zkp_token

{
  "minerId": "miner_abc123",
  "jobId": "job_5f4e3d2c1b0a9988",
  "nonce": 2048576543,
  "result": "0000000000000000000123456789abcdef0000000000000000000000000000",
  "algorithm": "sha256"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "accepted": true,
    "shareId": "share_1705234567890",
    "difficulty": 1024,
    "target": "00000000ffff0000000000000000000000000000000000000000000000000000",
    "blockFound": false,
    "reward": 0.00001234,
    "timestamp": "2024-01-14T15:45:33Z"
  }
}
```

### Get Mining Job

```http
GET /pool/job
Authorization: Bearer zkp_token
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "job_5f4e3d2c1b0a9988",
    "prevHash": "0000000000000000000456789abcdef1234567890000000000000000000000",
    "coinbase1": "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
    "coinbase2": "ffffffff0100f2052a01000000434104",
    "merkleRoot": "7b2266696c6573223a5b5d2c22696e636c75646573223a5b5d7d0a",
    "blockVersion": 536870912,
    "nBits": "17038a6e",
    "nTime": 1705234567,
    "cleanJobs": true,
    "target": "00000000ffff0000000000000000000000000000000000000000000000000000",
    "difficulty": 1024,
    "algorithm": "sha256"
  }
}
```

### Register Miner

```http
POST /pool/miners/register
Content-Type: application/json
Authorization: Bearer zkp_token

{
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "workerName": "main-rig",
  "userAgent": "CGMiner/4.12.0",
  "hardware": {
    "type": "ASIC",
    "model": "Antminer S19 Pro",
    "hashrate": "110 TH/s"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "minerId": "miner_abc123def456",
    "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "workerName": "main-rig",
    "difficulty": 1024,
    "registeredAt": "2024-01-14T15:45:34Z",
    "sessionTimeout": 3600
  }
}
```

## Statistics API

### Pool Statistics

```http
GET /stats/pool
```

**Response:**
```json
{
  "success": true,
  "data": {
    "hashrate": {
      "current": "125.3 TH/s",
      "1hour": "123.7 TH/s",
      "24hour": "119.8 TH/s",
      "7days": "121.2 TH/s"
    },
    "miners": {
      "active": 1247,
      "total": 2156,
      "online": 1189
    },
    "shares": {
      "valid": 15234567,
      "invalid": 12345,
      "efficiency": 99.91
    },
    "blocks": {
      "found": 42,
      "pending": 1,
      "confirmed": 41,
      "orphaned": 0
    },
    "earnings": {
      "total": "12.5678 BTC",
      "pending": "0.0234 BTC",
      "paid": "12.5444 BTC"
    },
    "network": {
      "difficulty": 73197634206448.1,
      "blockHeight": 820156,
      "blockTime": 600,
      "hashrate": "550.5 EH/s"
    }
  }
}
```

### Miner Statistics

```http
GET /stats/miner/{address}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "workers": [
      {
        "name": "main-rig",
        "hashrate": {
          "current": "110 TH/s",
          "1hour": "108.5 TH/s",
          "24hour": "109.2 TH/s"
        },
        "shares": {
          "valid": 12345,
          "invalid": 23,
          "efficiency": 99.81
        },
        "lastSeen": "2024-01-14T15:45:35Z",
        "status": "online"
      }
    ],
    "earnings": {
      "unpaid": "0.00123456 BTC",
      "paid": "0.98765432 BTC",
      "total": "0.98888888 BTC"
    },
    "payments": [
      {
        "amount": "0.001 BTC",
        "txid": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
        "timestamp": "2024-01-13T10:30:00Z",
        "status": "confirmed"
      }
    ],
    "performance": {
      "avgHashrate": "109.5 TH/s",
      "efficiency": 99.78,
      "uptime": 98.5,
      "ranking": 15
    }
  }
}
```

### Historical Data

```http
GET /stats/hashrate?duration=3600&interval=60
```

**Parameters:**
- `duration`: Time period in seconds (default: 3600)
- `interval`: Data point interval in seconds (default: 60)

**Response:**
```json
{
  "success": true,
  "data": {
    "duration": 3600,
    "interval": 60,
    "points": [
      {
        "timestamp": "2024-01-14T14:45:00Z",
        "poolHashrate": "123.5 TH/s",
        "networkHashrate": "549.2 EH/s",
        "difficulty": 73197634206448.1,
        "activeMiners": 1243
      },
      {
        "timestamp": "2024-01-14T14:46:00Z",
        "poolHashrate": "124.1 TH/s",
        "networkHashrate": "550.1 EH/s",
        "difficulty": 73197634206448.1,
        "activeMiners": 1245
      }
    ]
  }
}
```

## Monitoring API

### System Health

```http
GET /monitor/health
Authorization: Bearer admin_token
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "HEALTHY",
    "uptime": 86400,
    "version": "1.1.0",
    "timestamp": "2024-01-14T15:45:36Z",
    "components": {
      "database": {
        "status": "OK",
        "latency": 2.3,
        "connections": 15
      },
      "stratum": {
        "status": "OK",
        "connections": 1247,
        "bandwidth": "125 MB/s"
      },
      "monitoring": {
        "status": "OK",
        "alerts": 0,
        "metrics": 15234
      },
      "security": {
        "status": "OK",
        "threats": 0,
        "zkpSessions": 1189
      }
    },
    "resources": {
      "cpu": {
        "usage": 45.2,
        "cores": 16,
        "load": [1.2, 1.4, 1.1]
      },
      "memory": {
        "used": "8.5 GB",
        "total": "32 GB",
        "usage": 26.5
      },
      "disk": {
        "used": "125 GB",
        "total": "1 TB",
        "usage": 12.5
      }
    }
  }
}
```

### Performance Metrics

```http
GET /monitor/metrics
Authorization: Bearer admin_token
```

**Response:**
```json
{
  "success": true,
  "data": {
    "performance": {
      "shareValidation": {
        "avg": 1.2,
        "p95": 2.8,
        "p99": 5.1,
        "throughput": 1250
      },
      "hashCalculation": {
        "avg": 0.8,
        "p95": 1.5,
        "p99": 2.3,
        "throughput": 2500
      },
      "networkIO": {
        "bytesIn": "250 MB/s",
        "bytesOut": "125 MB/s",
        "connections": 1247,
        "latency": 15.2
      }
    },
    "objectPools": {
      "shares": {
        "hitRate": 98.5,
        "size": 5000,
        "utilization": 75.2
      },
      "blocks": {
        "hitRate": 95.8,
        "size": 100,
        "utilization": 23.1
      }
    },
    "cache": {
      "hitRate": 92.3,
      "size": "512 MB",
      "evictions": 1234
    }
  }
}
```

### Alerts

```http
GET /monitor/alerts
Authorization: Bearer admin_token
```

**Response:**
```json
{
  "success": true,
  "data": {
    "active": [
      {
        "id": "alert_1234567890",
        "severity": "WARNING",
        "title": "High CPU Usage",
        "description": "CPU usage above 80% for 5 minutes",
        "timestamp": "2024-01-14T15:40:00Z",
        "acknowledged": false,
        "escalated": false
      }
    ],
    "recent": [
      {
        "id": "alert_0987654321",
        "severity": "INFO",
        "title": "New Block Found",
        "description": "Block #820156 found by miner_xyz789",
        "timestamp": "2024-01-14T15:35:12Z",
        "resolved": true
      }
    ]
  }
}
```

## Administration API

### Node Management

```http
GET /admin/nodes
Authorization: Bearer admin_token
```

**Response:**
```json
{
  "success": true,
  "data": {
    "nodes": [
      {
        "id": "us-east-node-01",
        "region": "us-east",
        "status": "healthy",
        "connections": 412,
        "hashrate": "42.1 TH/s",
        "load": 0.65,
        "uptime": 172800,
        "endpoints": {
          "stratum": "stratum+tcp://us-east-01.pool.example.com:3333",
          "api": "http://us-east-01.pool.example.com:8081/v1"
        }
      }
    ],
    "summary": {
      "total": 12,
      "healthy": 11,
      "warning": 1,
      "critical": 0
    }
  }
}
```

### Configuration

```http
GET /admin/config
Authorization: Bearer admin_token
```

**Response:**
```json
{
  "success": true,
  "data": {
    "pool": {
      "name": "Otedama Mining Pool",
      "algorithm": "sha256",
      "fee": 0.01,
      "minPayout": 0.001,
      "payoutInterval": 86400
    },
    "security": {
      "zkpEnabled": true,
      "rateLimitEnabled": true,
      "ddosProtection": true,
      "maxConnections": 10000
    },
    "performance": {
      "workerThreads": 16,
      "shareBufferSize": 10000,
      "objectPooling": true,
      "compressionEnabled": true
    }
  }
}
```

### Update Configuration

```http
PUT /admin/config
Content-Type: application/json
Authorization: Bearer admin_token

{
  "pool": {
    "fee": 0.015,
    "minPayout": 0.0005
  },
  "performance": {
    "workerThreads": 20,
    "shareBufferSize": 15000
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "updated": [
      "pool.fee",
      "pool.minPayout",
      "performance.workerThreads",
      "performance.shareBufferSize"
    ],
    "timestamp": "2024-01-14T15:45:37Z"
  }
}
```

## WebSocket API

Connect to real-time updates via WebSocket:

```
wss://ws.otedama.com/v1
```

### Authentication

```json
{
  "type": "auth",
  "token": "zkp_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9..."
}
```

### Subscribe to Updates

```json
{
  "type": "subscribe",
  "channels": ["hashrate", "blocks", "alerts"]
}
```

### Real-time Messages

**Hashrate Update:**
```json
{
  "type": "hashrate",
  "data": {
    "poolHashrate": "125.8 TH/s",
    "networkHashrate": "551.2 EH/s",
    "timestamp": "2024-01-14T15:45:38Z"
  }
}
```

**Block Found:**
```json
{
  "type": "block",
  "data": {
    "height": 820157,
    "hash": "00000000000000000001a2b3c4d5e6f7890abcdef1234567890abcdef123456",
    "reward": 6.25,
    "finder": "miner_xyz789",
    "timestamp": "2024-01-14T15:45:39Z"
  }
}
```

**Alert:**
```json
{
  "type": "alert",
  "data": {
    "id": "alert_2345678901",
    "severity": "HIGH",
    "title": "Share Rate Drop",
    "description": "Share submission rate dropped by 20%",
    "timestamp": "2024-01-14T15:45:40Z"
  }
}
```

## Error Handling

All API responses follow this format:

**Success Response:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_SHARE",
    "message": "Share validation failed",
    "details": {
      "reason": "Hash does not meet target difficulty",
      "expected": "0000ffff...",
      "received": "0001abcd..."
    },
    "timestamp": "2024-01-14T15:45:41Z"
  }
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| `INVALID_TOKEN` | Authentication token is invalid or expired |
| `INSUFFICIENT_PRIVILEGES` | User lacks required permissions |
| `INVALID_SHARE` | Submitted share is invalid |
| `MINER_NOT_FOUND` | Miner not registered |
| `RATE_LIMITED` | Request rate limit exceeded |
| `POOL_FULL` | Pool has reached maximum capacity |
| `MAINTENANCE_MODE` | Pool is under maintenance |
| `INVALID_ALGORITHM` | Unsupported mining algorithm |
| `NETWORK_ERROR` | Network connectivity issue |
| `INTERNAL_ERROR` | Internal server error |

## Rate Limiting

API endpoints are rate limited to ensure fair usage:

| Endpoint Category | Rate Limit |
|-------------------|------------|
| Authentication | 10 requests/minute |
| Pool Operations | 100 requests/minute |
| Statistics | 60 requests/minute |
| Monitoring | 30 requests/minute |
| Administration | 20 requests/minute |

Rate limit headers are included in responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 85
X-RateLimit-Reset: 1705234890
```

## Examples

### Complete Mining Session

```bash
# 1. Generate ZKP token
curl -X POST http://localhost:8081/api/v1/auth/zkp/generate \
  -H "Content-Type: application/json" \
  -d '{
    "minerAddress": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "attributes": {"age": 25, "balance": 1000, "reputation": 95}
  }'

# 2. Register miner
curl -X POST http://localhost:8081/api/v1/pool/miners/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer zkp_token_here" \
  -d '{
    "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "workerName": "main-rig",
    "userAgent": "CGMiner/4.12.0"
  }'

# 3. Get mining job
curl -X GET http://localhost:8081/api/v1/pool/job \
  -H "Authorization: Bearer zkp_token_here"

# 4. Submit share
curl -X POST http://localhost:8081/api/v1/pool/submit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer zkp_token_here" \
  -d '{
    "minerId": "miner_abc123",
    "jobId": "job_5f4e3d2c1b0a9988",
    "nonce": 2048576543,
    "result": "0000000000000000000123456789abcdef0000000000000000000000000000"
  }'

# 5. Check statistics
curl -X GET http://localhost:8081/api/v1/stats/miner/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
```

### WebSocket Connection (JavaScript)

```javascript
const ws = new WebSocket('wss://ws.otedama.com/v1');

ws.onopen = () => {
  // Authenticate
  ws.send(JSON.stringify({
    type: 'auth',
    token: 'zkp_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...'
  }));
  
  // Subscribe to updates
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['hashrate', 'blocks', 'alerts']
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  switch (message.type) {
    case 'hashrate':
      console.log('Pool hashrate:', message.data.poolHashrate);
      break;
    case 'block':
      console.log('New block found:', message.data.height);
      break;
    case 'alert':
      console.log('Alert:', message.data.title);
      break;
  }
};
```

### Python Client Example

```python
import requests
import json

class OtedamaClient:
    def __init__(self, base_url="http://localhost:8081/api/v1"):
        self.base_url = base_url
        self.token = None
    
    def authenticate(self, miner_address, attributes):
        response = requests.post(f"{self.base_url}/auth/zkp/generate", json={
            "minerAddress": miner_address,
            "attributes": attributes
        })
        
        if response.json()["success"]:
            self.token = response.json()["data"]["token"]
            return True
        return False
    
    def get_pool_info(self):
        response = requests.get(f"{self.base_url}/pool/info")
        return response.json()
    
    def get_miner_stats(self, address):
        headers = {"Authorization": f"Bearer {self.token}"}
        response = requests.get(f"{self.base_url}/stats/miner/{address}", headers=headers)
        return response.json()
    
    def submit_share(self, miner_id, job_id, nonce, result):
        headers = {"Authorization": f"Bearer {self.token}"}
        data = {
            "minerId": miner_id,
            "jobId": job_id,
            "nonce": nonce,
            "result": result
        }
        response = requests.post(f"{self.base_url}/pool/submit", json=data, headers=headers)
        return response.json()

# Usage
client = OtedamaClient()
client.authenticate("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", {
    "age": 25,
    "balance": 1000,
    "reputation": 95
})

pool_info = client.get_pool_info()
print(f"Pool hashrate: {pool_info['data']['poolHashrate']}")
```

## SDK Downloads

Official SDKs are available for popular programming languages:

- **JavaScript/Node.js**: `npm install otedama-api-client`
- **Python**: `pip install otedama-client`
- **Go**: `go get github.com/shizukutanaka/otedama-go-client`
- **Rust**: `cargo add otedama-client`
- **Java**: Available on Maven Central

## Support

- **Documentation**: See this API document
- **GitHub Issues**: https://github.com/shizukutanaka/Otedama/issues

---

*This documentation covers Otedama API v1. For the latest updates, visit our [GitHub repository](https://github.com/shizukutanaka/Otedama).*