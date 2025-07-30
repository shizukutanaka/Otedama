# Otedama API Documentation

## Overview

The Otedama API provides RESTful endpoints and WebSocket connections for interacting with the P2P mining pool system. All API responses follow a consistent JSON format.

## Base URL

```
http://localhost:8080/api/v1
```

## Authentication

### Zero-Knowledge Proof Authentication

Instead of traditional API keys, Otedama uses Zero-Knowledge Proofs for authentication:

```bash
# Generate age proof
curl -X POST http://localhost:8080/api/v1/auth/zkp/age \
  -H "Content-Type: application/json" \
  -d '{
    "birth_year": 1990,
    "current_year": 2025
  }'

# Response
{
  "success": true,
  "data": {
    "proof": "0x1234...abcd",
    "public_inputs": ["18+"],
    "expires_at": "2025-07-31T00:00:00Z"
  }
}
```

## Response Format

All API responses follow this structure:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "time": "2025-07-30T12:00:00Z"
}
```

## Endpoints

### System Status

#### GET /api/v1/status
Get current system status.

**Response:**
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
Get detailed health check information.

**Response:**
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
Get comprehensive system statistics.

**Response:**
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

### Mining Operations

#### GET /api/v1/mining/stats
Get current mining statistics.

**Response:**
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
Start mining operations.

**Request:**
```json
{
  "algorithm": "sha256d",
  "threads": 0,
  "intensity": 100
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Mining started",
    "job_id": "job_123456"
  }
}
```

#### POST /api/v1/mining/stop
Stop mining operations.

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Mining stopped",
    "final_stats": {
      "total_hashes": 125000000000,
      "runtime_seconds": 3600
    }
  }
}
```

### P2P Pool Operations

#### GET /api/v1/pool/stats
Get pool statistics.

**Response:**
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
Get connected peers.

**Response:**
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
Get recent shares.

**Response:**
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

### Zero-Knowledge Proof Operations

#### POST /api/v1/zkp/generate
Generate a zero-knowledge proof.

**Request:**
```json
{
  "proof_type": "hashpower",
  "data": {
    "hashrate": 125000000000,
    "duration": 3600
  }
}
```

**Response:**
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
Verify a zero-knowledge proof.

**Request:**
```json
{
  "proof": "0xabcd...1234",
  "public_inputs": ["125GH/s+"],
  "protocol": "groth16"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "verified_at": "2025-07-30T12:00:00Z"
  }
}
```

### Performance and Monitoring

#### GET /api/v1/performance/benchmark
Get benchmark results.

**Response:**
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
Get auto-recovery status.

**Response:**
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

### Connection

Connect to WebSocket endpoint:
```
ws://localhost:8080/api/v1/ws
```

### Message Format

All WebSocket messages use JSON:

```json
{
  "type": "subscribe",
  "channel": "mining_stats"
}
```

### Channels

#### mining_stats
Real-time mining statistics updates.

**Message:**
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
Pool status updates.

**Message:**
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
Share submission notifications.

**Message:**
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

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - ZKP verification failed |
| 404 | Not Found - Resource not found |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 503 | Service Unavailable - System unhealthy |

## Rate Limiting

- Default: 100 requests per minute per IP
- WebSocket: 1000 messages per minute per connection
- Burst: 200 requests

## SDKs and Examples

### Go Client

```go
import "github.com/shizukutanaka/Otedama/sdk/go"

client := otedama.NewClient("http://localhost:8080")
stats, err := client.GetMiningStats()
```

### Python Client

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

## Postman Collection

Download the Postman collection for easy API testing:
[Otedama API Collection](https://github.com/shizukutanaka/Otedama/blob/master/docs/otedama-api.postman_collection.json)

## Support

For API support and questions:
- GitHub Issues: https://github.com/shizukutanaka/Otedama/issues
- Documentation: https://github.com/shizukutanaka/Otedama/wiki