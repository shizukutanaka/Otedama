# Otedama Mining Pool - API Documentation

## Overview

The Otedama Mining Pool provides a comprehensive REST API for monitoring pool statistics, managing miners, and accessing performance metrics.

**Base URL**: `http://localhost:4444/api/v1`  
**Content-Type**: `application/json`  
**Authentication**: API Key (for administrative endpoints)

## Authentication

Some endpoints require API key authentication. Include the API key in the request header:

```http
Authorization: Bearer YOUR_API_KEY
```

Generate an API key:
```bash
npm run generate-api-key
```

## Endpoints

### Pool Statistics

#### GET /stats
Get general pool statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "hashrate": {
      "total": 1234567890,
      "unit": "H/s",
      "formatted": "1.23 GH/s"
    },
    "miners": {
      "active": 150,
      "total": 200
    },
    "blocks": {
      "found": 25,
      "pending": 2,
      "confirmed": 23
    },
    "shares": {
      "valid": 1000000,
      "invalid": 5000,
      "stale": 2000
    },
    "network": {
      "difficulty": 25000000000,
      "height": 750000,
      "blockTime": 600
    },
    "pool": {
      "fee": 1.0,
      "minPayout": 0.01,
      "algorithm": "sha256",
      "version": "1.0.0"
    },
    "timestamp": 1640995200000
  }
}
```

#### GET /stats/detailed
Get detailed pool statistics with historical data.

**Query Parameters:**
- `period` (optional): Time period for historical data (`1h`, `24h`, `7d`, `30d`)
- `algorithm` (optional): Filter by algorithm

**Response:**
```json
{
  "success": true,
  "data": {
    "current": {
      "hashrate": 1234567890,
      "miners": 150,
      "blocks": 25
    },
    "historical": {
      "hashrate": [
        {"timestamp": 1640991600000, "value": 1200000000},
        {"timestamp": 1640995200000, "value": 1234567890}
      ],
      "miners": [
        {"timestamp": 1640991600000, "value": 145},
        {"timestamp": 1640995200000, "value": 150}
      ]
    },
    "algorithms": {
      "sha256": {
        "hashrate": 1000000000,
        "miners": 120,
        "shares": 850000
      },
      "scrypt": {
        "hashrate": 234567890,
        "miners": 30,
        "shares": 150000
      }
    }
  }
}
```

### Mining Operations

#### GET /miners
Get list of active miners.

**Query Parameters:**
- `limit` (optional): Number of results (default: 50, max: 1000)
- `offset` (optional): Pagination offset (default: 0)
- `sort` (optional): Sort by `hashrate`, `shares`, `connected` (default: hashrate)
- `algorithm` (optional): Filter by algorithm

**Response:**
```json
{
  "success": true,
  "data": {
    "miners": [
      {
        "id": "miner_001",
        "wallet": "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        "worker": "worker1",
        "ip": "192.168.1.100",
        "hashrate": 50000000,
        "shares": {
          "valid": 1000,
          "invalid": 5,
          "stale": 2
        },
        "difficulty": 65536,
        "connected": 1640991600000,
        "lastActivity": 1640995200000,
        "algorithm": "sha256",
        "software": "cgminer/4.11.1"
      }
    ],
    "pagination": {
      "total": 150,
      "limit": 50,
      "offset": 0,
      "hasMore": true
    }
  }
}
```

#### GET /miners/{minerId}
Get detailed information about a specific miner.

**Response:**
```json
{
  "success": true,
  "data": {
    "miner": {
      "id": "miner_001",
      "wallet": "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
      "worker": "worker1",
      "ip": "192.168.1.100",
      "hashrate": {
        "current": 50000000,
        "average1h": 48000000,
        "average24h": 45000000
      },
      "shares": {
        "valid": 1000,
        "invalid": 5,
        "stale": 2,
        "validRate": 99.3
      },
      "difficulty": {
        "current": 65536,
        "minimum": 1024,
        "maximum": 1000000
      },
      "connection": {
        "connected": 1640991600000,
        "lastActivity": 1640995200000,
        "uptime": 3600000
      },
      "earnings": {
        "pending": 0.005,
        "paid": 0.025,
        "total": 0.030
      },
      "hardware": {
        "algorithm": "sha256",
        "software": "cgminer/4.11.1",
        "platform": "GPU"
      }
    },
    "performance": {
      "efficiency": 95.5,
      "stability": 98.2,
      "score": 96.8
    }
  }
}
```

### Blocks

#### GET /blocks
Get list of found blocks.

**Query Parameters:**
- `limit` (optional): Number of results (default: 20, max: 100)
- `offset` (optional): Pagination offset
- `status` (optional): Filter by status (`pending`, `confirmed`, `orphaned`)

**Response:**
```json
{
  "success": true,
  "data": {
    "blocks": [
      {
        "id": "block_001",
        "height": 750000,
        "hash": "00000000000000000007878ec04bb2b2e12317804810f4c26033585b3f81750e",
        "difficulty": 25000000000,
        "timestamp": 1640995200000,
        "confirmations": 120,
        "status": "confirmed",
        "reward": 6.25,
        "fees": 0.1,
        "size": 1048576,
        "transactions": 2500,
        "finder": {
          "wallet": "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
          "worker": "worker1"
        },
        "effort": 85.5
      }
    ],
    "summary": {
      "last24h": 3,
      "last7d": 20,
      "last30d": 85,
      "averageEffort": 95.2
    }
  }
}
```

### Payments

#### GET /payments
Get payment history.

**Query Parameters:**
- `wallet` (optional): Filter by wallet address
- `limit` (optional): Number of results (default: 50)
- `offset` (optional): Pagination offset

**Response:**
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "payment_001",
        "wallet": "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        "amount": 0.025,
        "fee": 0.0001,
        "txid": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
        "confirmations": 6,
        "timestamp": 1640991600000,
        "status": "confirmed"
      }
    ],
    "summary": {
      "totalPaid": 1.25,
      "pendingPayments": 0.05,
      "nextPayout": 1640998800000
    }
  }
}
```

#### GET /payments/{wallet}
Get payment history for a specific wallet.

**Response:**
```json
{
  "success": true,
  "data": {
    "wallet": "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    "balance": {
      "confirmed": 0.025,
      "pending": 0.005,
      "threshold": 0.01
    },
    "payments": [
      {
        "id": "payment_001",
        "amount": 0.025,
        "fee": 0.0001,
        "txid": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
        "timestamp": 1640991600000,
        "status": "confirmed"
      }
    ],
    "statistics": {
      "totalEarned": 0.5,
      "totalPaid": 0.45,
      "averageDaily": 0.015
    }
  }
}
```

### System Monitoring

#### GET /system/status
Get system status and health metrics.

**Authentication**: Required

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "uptime": 86400000,
    "version": "1.0.0",
    "system": {
      "cpu": {
        "usage": 45.2,
        "cores": 8,
        "load": [1.2, 1.5, 1.8]
      },
      "memory": {
        "total": 32000000000,
        "used": 16000000000,
        "free": 16000000000,
        "usage": 50.0
      },
      "disk": {
        "total": 500000000000,
        "used": 200000000000,
        "free": 300000000000,
        "usage": 40.0
      }
    },
    "application": {
      "connections": {
        "active": 150,
        "total": 200,
        "rejected": 5
      },
      "performance": {
        "requestsPerSecond": 500,
        "avgResponseTime": 15,
        "errorRate": 0.01
      }
    },
    "database": {
      "status": "connected",
      "connections": 10,
      "queryTime": 5.2
    },
    "network": {
      "bytesReceived": 1000000000,
      "bytesTransmitted": 500000000,
      "packetsDropped": 0
    }
  }
}
```

#### GET /system/performance
Get detailed performance metrics.

**Authentication**: Required

**Response:**
```json
{
  "success": true,
  "data": {
    "mining": {
      "hashrate": {
        "total": 1234567890,
        "perAlgorithm": {
          "sha256": 1000000000,
          "scrypt": 234567890
        }
      },
      "efficiency": 95.5,
      "uptime": 99.9
    },
    "stratum": {
      "connectionsPerSecond": 50,
      "sharesPerSecond": 1000,
      "latency": {
        "average": 15,
        "p95": 25,
        "p99": 45
      }
    },
    "security": {
      "blockedIPs": 15,
      "suspiciousActivity": 5,
      "ddosAttempts": 2
    },
    "alerts": {
      "active": 1,
      "last24h": 5,
      "resolved": 4
    }
  }
}
```

### Configuration

#### GET /config
Get current pool configuration.

**Authentication**: Required

**Response:**
```json
{
  "success": true,
  "data": {
    "pool": {
      "name": "Otedama Mining Pool",
      "fee": 1.0,
      "minimumPayout": 0.01,
      "payoutInterval": 3600,
      "algorithms": ["sha256", "scrypt", "ethash"]
    },
    "network": {
      "maxConnections": 10000,
      "connectionTimeout": 30000,
      "ports": {
        "stratum": 3333,
        "api": 4444
      }
    },
    "security": {
      "rateLimiting": true,
      "ddosProtection": true,
      "encryption": true
    }
  }
}
```

#### PUT /config
Update pool configuration.

**Authentication**: Required

**Request Body:**
```json
{
  "pool": {
    "fee": 1.5,
    "minimumPayout": 0.005
  },
  "security": {
    "rateLimiting": true
  }
}
```

### WebSocket API

Connect to real-time updates via WebSocket:

**URL**: `ws://localhost:4444/ws`

#### Subscribe to Events

```javascript
const ws = new WebSocket('ws://localhost:4444/ws');

ws.onopen = function() {
  // Subscribe to specific events
  ws.send(JSON.stringify({
    action: 'subscribe',
    events: ['hashrate', 'blocks', 'miners']
  }));
};

ws.onmessage = function(event) {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

#### Available Events

- `hashrate`: Real-time hashrate updates
- `blocks`: New block notifications
- `miners`: Miner connection/disconnection events
- `shares`: Share submission events
- `payments`: Payment notifications
- `alerts`: System alerts

#### Event Data Format

```json
{
  "event": "hashrate",
  "timestamp": 1640995200000,
  "data": {
    "total": 1234567890,
    "change": 5.2,
    "trend": "up"
  }
}
```

## Error Handling

### Error Response Format

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PARAMETERS",
    "message": "The provided parameters are invalid",
    "details": {
      "field": "limit",
      "reason": "Must be between 1 and 1000"
    }
  },
  "timestamp": 1640995200000
}
```

### Error Codes

- `INVALID_PARAMETERS`: Invalid request parameters
- `UNAUTHORIZED`: Authentication required or failed
- `NOT_FOUND`: Requested resource not found
- `RATE_LIMITED`: Too many requests
- `SERVER_ERROR`: Internal server error
- `SERVICE_UNAVAILABLE`: Service temporarily unavailable

### HTTP Status Codes

- `200`: Success
- `400`: Bad Request
- `401`: Unauthorized
- `404`: Not Found
- `429`: Too Many Requests
- `500`: Internal Server Error
- `503`: Service Unavailable

## Rate Limiting

API endpoints are rate limited to prevent abuse:

- **General endpoints**: 100 requests/minute
- **Statistics endpoints**: 60 requests/minute
- **Administrative endpoints**: 30 requests/minute

Rate limit headers are included in responses:
- `X-RateLimit-Limit`: Request limit
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Reset timestamp

## SDKs and Libraries

### JavaScript/Node.js
```bash
npm install otedama-mining-api
```

```javascript
const OtedamaAPI = require('otedama-mining-api');

const api = new OtedamaAPI({
  baseURL: 'http://localhost:4444/api/v1',
  apiKey: 'your-api-key'
});

// Get pool statistics
const stats = await api.getStats();
console.log(stats);

// Get miner information
const miners = await api.getMiners({ limit: 10 });
console.log(miners);
```

### Python
```bash
pip install otedama-mining-api
```

```python
from otedama_api import OtedamaAPI

api = OtedamaAPI(
    base_url='http://localhost:4444/api/v1',
    api_key='your-api-key'
)

# Get pool statistics
stats = api.get_stats()
print(stats)

# Get miner information
miners = api.get_miners(limit=10)
print(miners)
```

## Examples

### Monitor Pool Performance
```bash
#!/bin/bash

# Get pool statistics every 30 seconds
while true; do
  curl -s "http://localhost:4444/api/v1/stats" | jq '.data.hashrate.formatted'
  sleep 30
done
```

### Alert on Low Hashrate
```javascript
const axios = require('axios');

setInterval(async () => {
  try {
    const response = await axios.get('http://localhost:4444/api/v1/stats');
    const hashrate = response.data.data.hashrate.total;
    
    if (hashrate < 1000000000) { // Less than 1 GH/s
      console.log(`ALERT: Low hashrate detected: ${hashrate}`);
      // Send notification
    }
  } catch (error) {
    console.error('Error fetching stats:', error.message);
  }
}, 60000); // Check every minute
```

### Export Mining Data
```python
import csv
import requests

# Fetch miner data
response = requests.get('http://localhost:4444/api/v1/miners?limit=1000')
miners = response.json()['data']['miners']

# Export to CSV
with open('miners.csv', 'w', newline='') as csvfile:
    fieldnames = ['id', 'wallet', 'hashrate', 'shares_valid', 'connected']
    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
    
    writer.writeheader()
    for miner in miners:
        writer.writerow({
            'id': miner['id'],
            'wallet': miner['wallet'],
            'hashrate': miner['hashrate'],
            'shares_valid': miner['shares']['valid'],
            'connected': miner['connected']
        })
```