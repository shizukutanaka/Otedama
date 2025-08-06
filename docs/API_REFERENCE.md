# Otedama API Reference

Version: 2.1.5  
Base URL: `http://localhost:8080/api`  
Protocol: REST (JSON) and WebSocket  

## Authentication

All API endpoints require authentication using Bearer tokens or API keys.

### Bearer Token Authentication

```http
Authorization: Bearer <token>
```

### API Key Authentication

```http
X-API-Key: <api-key>
```

## REST API Endpoints

### Mining Operations

#### Get Mining Status
Returns current mining status and statistics.

```http
GET /api/v1/mining/status
```

Response:
```json
{
  "status": "mining",
  "algorithm": "sha256d",
  "uptime": 3600,
  "workers": {
    "total": 4,
    "active": 4,
    "cpu": 2,
    "gpu": 1,
    "asic": 1
  },
  "hashrate": {
    "total": 150000000000,
    "cpu": 10000000,
    "gpu": 50000000000,
    "asic": 100000000000
  },
  "shares": {
    "submitted": 1523,
    "accepted": 1520,
    "rejected": 3,
    "stale": 0
  },
  "pool": {
    "connected": true,
    "url": "stratum+tcp://pool.example.com:3333",
    "user": "wallet.worker",
    "difficulty": 65536
  }
}
```

#### Start Mining
Starts mining with specified configuration.

```http
POST /api/v1/mining/start
Content-Type: application/json

{
  "algorithm": "sha256d",
  "pool": {
    "url": "stratum+tcp://pool.example.com:3333",
    "user": "wallet.worker",
    "password": "x"
  },
  "hardware": {
    "cpu": {
      "enabled": true,
      "threads": 4
    },
    "gpu": {
      "enabled": true,
      "devices": [0, 1]
    },
    "asic": {
      "enabled": true,
      "devices": ["auto"]
    }
  }
}
```

Response:
```json
{
  "success": true,
  "message": "Mining started successfully",
  "job_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Stop Mining
Stops all mining operations.

```http
POST /api/v1/mining/stop
```

Response:
```json
{
  "success": true,
  "message": "Mining stopped",
  "statistics": {
    "runtime": 3600,
    "total_shares": 1523,
    "accepted_shares": 1520,
    "total_hashrate": 150000000000
  }
}
```

#### Switch Algorithm
Switches to a different mining algorithm.

```http
POST /api/v1/mining/algorithm
Content-Type: application/json

{
  "algorithm": "ethash",
  "restart": true
}
```

### Worker Management

#### List Workers
Returns list of all workers.

```http
GET /api/v1/workers
```

Query Parameters:
- `status` - Filter by status (active, inactive, all)
- `type` - Filter by type (cpu, gpu, asic)
- `limit` - Maximum number of results (default: 100)
- `offset` - Pagination offset (default: 0)

Response:
```json
{
  "workers": [
    {
      "id": "cpu-0",
      "type": "cpu",
      "status": "active",
      "hashrate": 5000000,
      "temperature": 65.5,
      "shares": {
        "accepted": 380,
        "rejected": 1
      },
      "uptime": 3600
    },
    {
      "id": "gpu-0",
      "type": "gpu",
      "model": "NVIDIA RTX 3080",
      "status": "active",
      "hashrate": 50000000000,
      "temperature": 72.0,
      "power": 220,
      "memory": 10240,
      "shares": {
        "accepted": 760,
        "rejected": 2
      },
      "uptime": 3600
    }
  ],
  "total": 4,
  "page": {
    "limit": 100,
    "offset": 0
  }
}
```

#### Get Worker Details
Returns detailed information about a specific worker.

```http
GET /api/v1/workers/{worker_id}
```

#### Update Worker Settings
Updates worker configuration.

```http
PUT /api/v1/workers/{worker_id}
Content-Type: application/json

{
  "enabled": true,
  "intensity": 20,
  "temperature_limit": 85
}
```

### Pool Operations

#### Get Pool Status
Returns current pool connection status.

```http
GET /api/v1/pool/status
```

Response:
```json
{
  "connected": true,
  "pools": [
    {
      "url": "stratum+tcp://pool.example.com:3333",
      "status": "connected",
      "priority": 1,
      "accepted": 1520,
      "rejected": 3,
      "difficulty": 65536,
      "latency": 45
    }
  ],
  "current_pool": 0,
  "failover_count": 0
}
```

#### Add Pool
Adds a new mining pool.

```http
POST /api/v1/pool/add
Content-Type: application/json

{
  "url": "stratum+tcp://backup.pool.com:3333",
  "user": "wallet.worker",
  "password": "x",
  "priority": 2
}
```

#### Remove Pool
Removes a mining pool.

```http
DELETE /api/v1/pool/{pool_id}
```

### Statistics

#### Get Detailed Statistics
Returns comprehensive mining statistics.

```http
GET /api/v1/stats
```

Query Parameters:
- `period` - Time period (1h, 24h, 7d, 30d)
- `interval` - Data point interval (1m, 5m, 1h)

Response:
```json
{
  "period": "24h",
  "hashrate": {
    "current": 150000000000,
    "average": 145000000000,
    "peak": 160000000000,
    "history": [
      {
        "timestamp": 1234567890,
        "value": 150000000000
      }
    ]
  },
  "shares": {
    "submitted": 36576,
    "accepted": 36500,
    "rejected": 72,
    "stale": 4,
    "efficiency": 99.79
  },
  "earnings": {
    "total": 0.00123456,
    "currency": "BTC",
    "rate": 0.00005144
  },
  "power": {
    "consumption": 1850,
    "efficiency": 81081081,
    "cost": 4.44
  }
}
```

#### Get Performance Metrics
Returns real-time performance metrics.

```http
GET /api/v1/metrics
```

Response (Prometheus format):
```
# HELP otedama_hashrate_total Total hashrate in hashes per second
# TYPE otedama_hashrate_total gauge
otedama_hashrate_total{algorithm="sha256d"} 150000000000

# HELP otedama_shares_total Total shares by status
# TYPE otedama_shares_total counter
otedama_shares_total{status="accepted"} 36500
otedama_shares_total{status="rejected"} 72
otedama_shares_total{status="stale"} 4

# HELP otedama_worker_temperature Worker temperature in celsius
# TYPE otedama_worker_temperature gauge
otedama_worker_temperature{worker="gpu-0"} 72.0
```

### Configuration

#### Get Configuration
Returns current configuration.

```http
GET /api/v1/config
```

#### Update Configuration
Updates configuration settings.

```http
PUT /api/v1/config
Content-Type: application/json

{
  "mining": {
    "algorithm": "sha256d",
    "intensity": 20
  },
  "api": {
    "rate_limit": 100
  }
}
```

### System

#### Health Check
Returns service health status.

```http
GET /api/v1/health
```

Response:
```json
{
  "status": "healthy",
  "components": {
    "mining_engine": "healthy",
    "stratum_client": "healthy",
    "api_server": "healthy",
    "database": "healthy"
  },
  "uptime": 86400,
  "version": "2.1.5"
}
```

#### Get System Information
Returns system information.

```http
GET /api/v1/system
```

Response:
```json
{
  "version": "2.1.5",
  "build": {
    "commit": "abc123",
    "date": "2025-01-06T00:00:00Z",
    "go_version": "1.21.0"
  },
  "system": {
    "os": "linux",
    "arch": "amd64",
    "cpu_count": 16,
    "memory_total": 32768,
    "memory_used": 8192
  },
  "features": {
    "cpu_mining": true,
    "gpu_mining": true,
    "asic_mining": true,
    "stratum_v2": true,
    "api_v1": true,
    "websocket": true
  }
}
```

## WebSocket API

### Connection

Connect to WebSocket endpoint:
```
ws://localhost:8080/api/v1/ws
```

### Authentication

Send authentication message after connection:
```json
{
  "type": "auth",
  "token": "your-bearer-token"
}
```

### Subscription

Subscribe to real-time updates:
```json
{
  "type": "subscribe",
  "channels": ["hashrate", "shares", "workers", "pool"]
}
```

### Message Types

#### Hashrate Update
```json
{
  "type": "hashrate",
  "data": {
    "total": 150000000000,
    "cpu": 10000000,
    "gpu": 50000000000,
    "asic": 100000000000,
    "timestamp": 1234567890
  }
}
```

#### Share Update
```json
{
  "type": "share",
  "data": {
    "worker_id": "gpu-0",
    "status": "accepted",
    "difficulty": 65536,
    "timestamp": 1234567890
  }
}
```

#### Worker Update
```json
{
  "type": "worker",
  "data": {
    "id": "gpu-0",
    "status": "active",
    "hashrate": 50000000000,
    "temperature": 72.0,
    "timestamp": 1234567890
  }
}
```

#### Pool Update
```json
{
  "type": "pool",
  "data": {
    "connected": true,
    "difficulty": 65536,
    "job": {
      "id": "abc123",
      "height": 700000
    },
    "timestamp": 1234567890
  }
}
```

### Commands

#### Start Mining via WebSocket
```json
{
  "type": "command",
  "action": "start_mining",
  "params": {
    "algorithm": "sha256d"
  }
}
```

#### Stop Mining via WebSocket
```json
{
  "type": "command",
  "action": "stop_mining"
}
```

## Error Responses

All error responses follow a consistent format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid algorithm specified",
    "details": {
      "field": "algorithm",
      "value": "invalid_algo",
      "allowed": ["sha256d", "ethash", "randomx", "scrypt", "kawpow"]
    }
  }
}
```

### Error Codes

- `UNAUTHORIZED` - Invalid or missing authentication
- `FORBIDDEN` - Insufficient permissions
- `INVALID_REQUEST` - Request validation failed
- `NOT_FOUND` - Resource not found
- `CONFLICT` - Resource conflict
- `RATE_LIMITED` - Rate limit exceeded
- `INTERNAL_ERROR` - Internal server error
- `SERVICE_UNAVAILABLE` - Service temporarily unavailable

## Rate Limiting

API requests are rate limited based on authentication type:

- **Authenticated users**: 1000 requests per minute
- **API key**: Configurable per key
- **Unauthenticated**: 100 requests per minute

Rate limit headers:
```http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1234567890
```

## Pagination

List endpoints support pagination:

```http
GET /api/v1/workers?limit=50&offset=100
```

Response includes pagination metadata:
```json
{
  "data": [...],
  "pagination": {
    "total": 250,
    "limit": 50,
    "offset": 100,
    "has_more": true
  }
}
```

## Filtering and Sorting

Most list endpoints support filtering and sorting:

```http
GET /api/v1/workers?status=active&type=gpu&sort=hashrate:desc
```

## Webhook Support

Configure webhooks for event notifications:

```http
POST /api/v1/webhooks
Content-Type: application/json

{
  "url": "https://your-server.com/webhook",
  "events": ["share.accepted", "worker.offline", "pool.disconnected"],
  "secret": "your-webhook-secret"
}
```

## SDK Examples

### JavaScript/Node.js
```javascript
const OtedamaClient = require('otedama-client');

const client = new OtedamaClient({
  baseUrl: 'http://localhost:8080/api',
  apiKey: 'your-api-key'
});

// Get mining status
const status = await client.mining.getStatus();

// Start mining
await client.mining.start({
  algorithm: 'sha256d',
  pool: {
    url: 'stratum+tcp://pool.example.com:3333',
    user: 'wallet.worker'
  }
});

// Subscribe to real-time updates
client.ws.on('hashrate', (data) => {
  console.log('Hashrate:', data.total);
});
```

### Python
```python
from otedama import OtedamaClient

client = OtedamaClient(
    base_url='http://localhost:8080/api',
    api_key='your-api-key'
)

# Get mining status
status = client.mining.get_status()

# Start mining
client.mining.start(
    algorithm='sha256d',
    pool={
        'url': 'stratum+tcp://pool.example.com:3333',
        'user': 'wallet.worker'
    }
)

# Subscribe to real-time updates
@client.ws.on('hashrate')
def on_hashrate(data):
    print(f"Hashrate: {data['total']}")
```

### Go
```go
import "github.com/otedama/otedama-go"

client := otedama.NewClient(otedama.Config{
    BaseURL: "http://localhost:8080/api",
    APIKey:  "your-api-key",
})

// Get mining status
status, err := client.Mining.GetStatus()

// Start mining
err := client.Mining.Start(otedama.MiningConfig{
    Algorithm: "sha256d",
    Pool: otedama.PoolConfig{
        URL:  "stratum+tcp://pool.example.com:3333",
        User: "wallet.worker",
    },
})

// Subscribe to real-time updates
client.WS.OnHashrate(func(data otedama.HashrateData) {
    log.Printf("Hashrate: %d", data.Total)
})
```