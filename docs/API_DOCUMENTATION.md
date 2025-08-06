# Otedama Enterprise P2P Mining Pool - API Documentation

**Version**: 2.1.5  
**API Version**: v1  
**Last Updated**: 2025-08-06  

## Overview

The Otedama API provides comprehensive RESTful endpoints for P2P mining pool management, real-time statistics, enterprise monitoring, and mining operations. All API responses are in JSON format with comprehensive error handling and rate limiting.

## Base URL

Production Environment:
```
https://your-pool.com/api/v1
```

Development Environment:
```
http://localhost:8080/api/v1
```

## Authentication

The API supports multiple authentication methods for different security levels:

### API Key Authentication (Recommended)
```
Authorization: Bearer YOUR_API_KEY
```

### JWT Token Authentication
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Basic Authentication (Development Only)
```
Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=
```

### Request API Key
```bash
curl -X POST /auth/api-key \
  -H "Content-Type: application/json" \
  -d '{"username": "your_username", "password": "your_password"}'
```

Response:
```json
{
  "success": true,
  "data": {
    "api_key": "otedama_live_sk_...",
    "expires_at": "2025-01-15T12:00:00Z",
    "permissions": ["read", "write", "admin"]
  }
}
```

## Common Response Format

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2024-01-15T12:00:00Z",
    "version": "1.0"
  }
}
```

### Error Response
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": { ... }
  }
}
```

## Endpoints

### Pool Information

#### Get Pool Stats
```
GET /stats
```

Response:
```json
{
  "success": true,
  "data": {
    "hashrate": 1250000000000,
    "miners": 1523,
    "workers": 4821,
    "blocks_found": 142,
    "last_block": {
      "height": 850123,
      "hash": "0000000000000000000123...",
      "found_at": "2024-01-15T11:45:00Z",
      "reward": 6.25
    },
    "currencies": ["BTC", "ETH", "LTC", "XMR", "RVN"],
    "algorithms": ["SHA256d", "Ethash", "Scrypt", "RandomX", "KawPow"],
    "federation": {
      "peers": 15,
      "shared_hashrate": 450000000000,
      "reputation": 0.95
    },
    "hardware_stats": {
      "cpu_miners": 823,
      "gpu_miners": 634,
      "asic_miners": 66
    }
  }
}
```

#### Get Supported Algorithms
```
GET /algorithms
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "name": "SHA256d",
      "currencies": ["BTC", "BCH"],
      "ports": [3333],
      "difficulty": 65536,
      "hashrate": 850000000000,
      "hardware_types": ["CPU", "GPU", "ASIC"],
      "stratum_version": "v1/v2"
    },
    {
      "name": "Ethash",
      "currencies": ["ETH", "ETC"],
      "ports": [3334],
      "difficulty": 4096,
      "hashrate": 400000000000,
      "hardware_types": ["GPU"],
      "stratum_version": "v1"
    },
    {
      "name": "RandomX",
      "currencies": ["XMR"],
      "ports": [3335],
      "difficulty": 256,
      "hashrate": 125000000,
      "hardware_types": ["CPU"],
      "stratum_version": "v1"
    },
    {
      "name": "KawPow",
      "currencies": ["RVN"],
      "ports": [3336],
      "difficulty": 1024,
      "hashrate": 85000000000,
      "hardware_types": ["GPU"],
      "stratum_version": "v1"
    },
    {
      "name": "Scrypt",
      "currencies": ["LTC", "DOGE"],
      "ports": [3337],
      "difficulty": 16384,
      "hashrate": 250000000000,
      "hardware_types": ["CPU", "GPU", "ASIC"],
      "stratum_version": "v1"
    }
  ]
}
```

### Miner Operations

#### Get Miner Stats
```
GET /miners/{address}
```

Parameters:
- `address`: Wallet address

Response:
```json
{
  "success": true,
  "data": {
    "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "hashrate": 125000000,
    "hashrate_24h": 123500000,
    "workers": 3,
    "shares": {
      "accepted": 15234,
      "rejected": 42,
      "stale": 18
    },
    "balance": 0.00125634,
    "paid": 1.25634521,
    "last_share": "2024-01-15T12:00:00Z"
  }
}
```

#### Get Miner Workers
```
GET /miners/{address}/workers
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "name": "worker1",
      "hashrate": 45000000,
      "shares_accepted": 5123,
      "shares_rejected": 15,
      "last_share": "2024-01-15T11:59:45Z",
      "status": "active"
    },
    {
      "name": "worker2",
      "hashrate": 40000000,
      "shares_accepted": 4821,
      "shares_rejected": 12,
      "last_share": "2024-01-15T11:59:30Z",
      "status": "active"
    }
  ]
}
```

#### Get Miner Payments
```
GET /miners/{address}/payments
```

Parameters:
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 50, max: 100)

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "pay_123456",
      "amount": 0.1,
      "tx_hash": "abc123...",
      "timestamp": "2024-01-14T10:00:00Z",
      "status": "confirmed"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 125,
    "total_pages": 3
  }
}
```

### Worker Management

#### Register Worker
```
POST /workers
```

Request:
```json
{
  "name": "my_worker",
  "hardware_type": "GPU",
  "algorithm": "Ethash",
  "currency": "ETH"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "worker_123456",
    "name": "my_worker",
    "token": "secret_token_here",
    "stratum_url": "stratum+tcp://pool.example.com:3334"
  }
}
```

#### Update Worker
```
PUT /workers/{id}
```

Request:
```json
{
  "name": "new_worker_name",
  "config": {
    "intensity": 20,
    "threads": 4
  }
}
```

#### Delete Worker
```
DELETE /workers/{id}
```

#### Execute Worker Command
```
POST /workers/{id}/commands
```

Request:
```json
{
  "command": "restart",
  "parameters": {}
}
```

### Block Information

#### Get Recent Blocks
```
GET /blocks
```

Parameters:
- `currency`: Filter by currency (optional)
- `limit`: Number of blocks (default: 50)

Response:
```json
{
  "success": true,
  "data": [
    {
      "height": 850123,
      "hash": "0000000000000000000123...",
      "currency": "BTC",
      "reward": 6.25,
      "found_by": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      "found_at": "2024-01-15T11:45:00Z",
      "confirmations": 6,
      "status": "confirmed"
    }
  ]
}
```

### Enterprise Monitoring

#### Get System Metrics
```
GET /monitoring/metrics
```

Response:
```json
{
  "success": true,
  "data": {
    "system": {
      "cpu_usage": 45.2,
      "memory_usage": 62.1,
      "disk_usage": 38.5,
      "network_io": {
        "in": 125.6,
        "out": 89.3
      }
    },
    "mining": {
      "total_hashrate": 1250000000000,
      "active_workers": 4821,
      "shares_per_second": 156.8,
      "rejection_rate": 0.02
    },
    "stratum": {
      "connections": 4821,
      "jobs_sent": 45623,
      "shares_received": 156789
    },
    "p2p": {
      "peers_connected": 15,
      "federation_health": "healthy",
      "sync_status": "synchronized"
    }
  }
}
```

#### Get Hardware Statistics
```
GET /monitoring/hardware
```

Response:
```json
{
  "success": true,
  "data": {
    "cpu_miners": {
      "count": 823,
      "total_hashrate": 125000000,
      "avg_temperature": 65.2,
      "power_consumption": 1250
    },
    "gpu_miners": {
      "count": 634,
      "total_hashrate": 950000000000,
      "avg_temperature": 72.5,
      "power_consumption": 95000
    },
    "asic_miners": {
      "count": 66,
      "total_hashrate": 175000000000,
      "avg_temperature": 85.1,
      "power_consumption": 125000
    }
  }
}
```

### Real-time Data (WebSocket)

#### Connect to WebSocket
```
wss://your-pool.com/api/ws
```

#### Authentication for WebSocket
```json
{
  "type": "auth",
  "token": "YOUR_API_KEY"
}
```

#### Subscribe to Updates
```json
{
  "type": "subscribe",
  "channels": ["stats", "blocks", "miner:YOUR_ADDRESS", "hardware", "federation"]
}
```

#### Real-time Messages

**Stats Update:**
```json
{
  "type": "stats",
  "data": {
    "hashrate": 1250000000000,
    "miners": 1523,
    "difficulty": 65536
  }
}
```

**New Block:**
```json
{
  "type": "block",
  "data": {
    "height": 850124,
    "hash": "0000000000000000000456...",
    "reward": 6.25,
    "currency": "BTC"
  }
}
```

**Miner Update:**
```json
{
  "type": "miner",
  "data": {
    "hashrate": 125000000,
    "balance": 0.00125634,
    "shares_accepted": 15235
  }
}
```

### Mobile API

#### Push Notification Registration
```
POST /mobile/register
```

Request:
```json
{
  "device_token": "firebase_token_here",
  "platform": "ios",
  "miner_address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
}
```

#### Update Notification Preferences
```
PUT /mobile/notifications
```

Request:
```json
{
  "worker_offline": true,
  "payment_sent": true,
  "block_found": false,
  "hashrate_drop": true,
  "threshold_percentage": 20
}
```

### Federation API

#### Get Federation Status
```
GET /federation/status
```

Response:
```json
{
  "success": true,
  "data": {
    "node_id": "node_abc123",
    "peers": 15,
    "reputation": 0.95,
    "shared_hashrate": 450000000000,
    "settlements": {
      "pending": 3,
      "completed": 142
    }
  }
}
```

#### List Federation Peers
```
GET /federation/peers
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "peer_123",
      "name": "Partner Pool 1",
      "hashrate": 150000000000,
      "reputation": 0.98,
      "location": "US-East",
      "latency": 15
    }
  ]
}
```

### Administrative API

#### Get System Health
```
GET /admin/health
```

Response:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "components": {
      "database": "healthy",
      "stratum": "healthy",
      "payment_processor": "healthy",
      "federation": "degraded"
    },
    "metrics": {
      "cpu_usage": 45.2,
      "memory_usage": 62.1,
      "disk_usage": 38.5,
      "network_in": 125.6,
      "network_out": 89.3
    }
  }
}
```

#### Trigger Backup
```
POST /admin/backup
```

Request:
```json
{
  "type": "full",
  "destination": "s3",
  "encrypt": true
}
```

#### Update Configuration
```
PUT /admin/config
```

Request:
```json
{
  "section": "mining",
  "settings": {
    "minimum_payout": 0.001,
    "pool_fee": 1.0
  }
}
```

### Mining Optimization API

#### Start Optimization
```
POST /optimization/start
```

Request:
```json
{
  "hardware_type": "GPU",
  "algorithm": "Ethash",
  "optimization_level": "aggressive",
  "safety_mode": true
}
```

Response:
```json
{
  "success": true,
  "data": {
    "optimization_id": "opt_123456",
    "status": "running",
    "estimated_duration": 300
  }
}
```

#### Get Optimization Status
```
GET /optimization/{id}/status
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "opt_123456",
    "status": "completed",
    "progress": 100,
    "results": {
      "hashrate_improvement": 12.5,
      "power_efficiency_gain": 8.3,
      "memory_optimization": "applied",
      "thermal_optimization": "applied"
    }
  }
}
```

### Security API

#### Get Security Audit
```
GET /security/audit
```

Response:
```json
{
  "success": true,
  "data": {
    "last_audit": "2024-01-15T10:00:00Z",
    "security_level": "high",
    "threats_detected": 0,
    "ddos_protection": "active",
    "rate_limiting": "enforced",
    "ssl_certificate": "valid",
    "firewall_status": "active"
  }
}
```

#### Get Threat Intelligence
```
GET /security/threats
```

Response:
```json
{
  "success": true,
  "data": {
    "active_threats": 0,
    "blocked_ips": ["192.168.1.100", "10.0.0.50"],
    "suspicious_activity": {
      "failed_authentications": 3,
      "rate_limit_violations": 12,
      "malformed_requests": 1
    }
  }
}
```

## Rate Limiting

API requests are rate limited to prevent abuse:

- **Anonymous**: 100 requests per minute
- **Authenticated**: 1000 requests per minute  
- **Premium**: 5000 requests per minute
- **Enterprise**: 10000 requests per minute
- **WebSocket**: 100 messages per minute

Rate limit headers:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 998
X-RateLimit-Reset: 1705320000
X-RateLimit-Tier: authenticated
```

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_REQUEST` | Request format is invalid |
| `UNAUTHORIZED` | Authentication required |
| `FORBIDDEN` | Access denied |
| `NOT_FOUND` | Resource not found |
| `RATE_LIMITED` | Too many requests |
| `INTERNAL_ERROR` | Server error |
| `MAINTENANCE` | API under maintenance |

## SDK Examples

### JavaScript/Node.js
```javascript
const { OtedamaAPI } = require('@otedama/api-client');

const client = new OtedamaAPI({
  apiKey: 'otedama_live_sk_...',
  baseURL: 'https://your-pool.com/api/v1',
  environment: 'production'
});

// Get pool statistics
const poolStats = await client.getStats();
console.log(`Pool hashrate: ${poolStats.hashrate} H/s`);
console.log(`Active miners: ${poolStats.miners}`);

// Get miner information
const minerStats = await client.getMinerStats('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
console.log(`Miner hashrate: ${minerStats.hashrate} H/s`);
console.log(`Balance: ${minerStats.balance} BTC`);

// Subscribe to real-time updates via WebSocket
const wsClient = client.createWebSocketClient();
wsClient.on('connect', () => {
  wsClient.subscribe(['stats', 'blocks', 'hardware']);
});

wsClient.on('stats', (data) => {
  console.log('Pool stats update:', data);
});

wsClient.on('block', (data) => {
  console.log('New block found:', data);
});

// Start hardware optimization
const optimization = await client.startOptimization({
  hardware_type: 'GPU',
  algorithm: 'Ethash',
  optimization_level: 'balanced',
  safety_mode: true
});
console.log(`Optimization started: ${optimization.optimization_id}`);
```

### Python
```python
import asyncio
from otedama_client import OtedamaClient, OtedamaWebSocket

# Initialize client
client = OtedamaClient(
    api_key='otedama_live_sk_...',
    base_url='https://your-pool.com/api/v1',
    environment='production'
)

async def main():
    # Get pool information
    pool_stats = await client.get_stats()
    print(f"Pool hashrate: {pool_stats['hashrate']:,} H/s")
    print(f"Total miners: {pool_stats['miners']:,}")
    
    # Monitor specific miner
    miner_address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
    miner_stats = await client.get_miner(miner_address)
    print(f"Miner balance: {miner_stats['balance']} BTC")
    
    # Get hardware statistics
    hardware_stats = await client.get_hardware_stats()
    print(f"GPU miners: {hardware_stats['gpu_miners']['count']}")
    print(f"ASIC miners: {hardware_stats['asic_miners']['count']}")
    
    # WebSocket monitoring
    ws = OtedamaWebSocket(client)
    
    @ws.on('stats')
    async def on_stats_update(data):
        print(f"Hashrate update: {data['hashrate']:,} H/s")
    
    @ws.on('hardware')
    async def on_hardware_update(data):
        print(f"Hardware update: {data}")
    
    await ws.connect()
    await ws.subscribe(['stats', 'hardware', 'federation'])
    
    # Keep running
    await asyncio.sleep(3600)

# Run the client
asyncio.run(main())
```

### Go
```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"
    
    "github.com/otedama/otedama-go-client"
)

func main() {
    // Initialize client
    client := otedama.NewClient(&otedama.Config{
        APIKey:      "otedama_live_sk_...",
        BaseURL:     "https://your-pool.com/api/v1",
        Environment: "production",
        Timeout:     30 * time.Second,
    })
    
    ctx := context.Background()
    
    // Get pool statistics
    stats, err := client.GetStats(ctx)
    if err != nil {
        log.Fatal("Failed to get stats:", err)
    }
    
    fmt.Printf("Pool hashrate: %d H/s\n", stats.Hashrate)
    fmt.Printf("Active miners: %d\n", stats.Miners)
    fmt.Printf("Federation peers: %d\n", stats.Federation.Peers)
    
    // Get supported algorithms
    algorithms, err := client.GetAlgorithms(ctx)
    if err != nil {
        log.Fatal("Failed to get algorithms:", err)
    }
    
    for _, algo := range algorithms {
        fmt.Printf("Algorithm: %s, Hashrate: %d H/s\n", 
            algo.Name, algo.Hashrate)
    }
    
    // Monitor miner
    minerAddr := "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
    miner, err := client.GetMiner(ctx, minerAddr)
    if err != nil {
        log.Fatal("Failed to get miner:", err)
    }
    
    fmt.Printf("Miner %s: %d H/s, Balance: %.8f BTC\n", 
        minerAddr, miner.Hashrate, miner.Balance)
    
    // Start hardware optimization
    optimization, err := client.StartOptimization(ctx, &otedama.OptimizationRequest{
        HardwareType:      "GPU",
        Algorithm:         "Ethash",
        OptimizationLevel: "balanced",
        SafetyMode:        true,
    })
    if err != nil {
        log.Fatal("Failed to start optimization:", err)
    }
    
    fmt.Printf("Optimization started: %s\n", optimization.ID)
    
    // WebSocket client for real-time updates
    wsClient := client.NewWebSocketClient()
    
    wsClient.OnConnect(func() {
        log.Println("WebSocket connected")
        wsClient.Subscribe([]string{"stats", "hardware", "federation"})
    })
    
    wsClient.OnStats(func(data *otedama.StatsUpdate) {
        fmt.Printf("Stats update: %d H/s\n", data.Hashrate)
    })
    
    wsClient.OnHardware(func(data *otedama.HardwareUpdate) {
        fmt.Printf("Hardware update: GPU miners: %d\n", 
            data.GPUMiners.Count)
    })
    
    // Connect and listen
    if err := wsClient.Connect(ctx); err != nil {
        log.Fatal("WebSocket connection failed:", err)
    }
    
    // Keep alive
    select {}
}
```

### Rust
```rust
use otedama_client::{OtedamaClient, Config, OptimizationRequest};
use tokio;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize client
    let client = OtedamaClient::new(Config {
        api_key: "otedama_live_sk_...".to_string(),
        base_url: "https://your-pool.com/api/v1".to_string(),
        environment: "production".to_string(),
        timeout: std::time::Duration::from_secs(30),
    });
    
    // Get pool stats
    let stats = client.get_stats().await?;
    println!("Pool hashrate: {} H/s", stats.hashrate);
    println!("Active miners: {}", stats.miners);
    
    // Get miner information
    let miner_addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    let miner = client.get_miner(miner_addr).await?;
    println!("Miner hashrate: {} H/s", miner.hashrate);
    println!("Balance: {} BTC", miner.balance);
    
    // Start optimization
    let optimization_req = OptimizationRequest {
        hardware_type: "GPU".to_string(),
        algorithm: "Ethash".to_string(),
        optimization_level: "balanced".to_string(),
        safety_mode: true,
    };
    
    let optimization = client.start_optimization(optimization_req).await?;
    println!("Optimization started: {}", optimization.id);
    
    // WebSocket monitoring
    let mut ws_client = client.create_websocket_client().await?;
    
    ws_client.subscribe(vec!["stats", "hardware", "federation"]).await?;
    
    while let Some(message) = ws_client.next().await {
        match message {
            OtedamaMessage::Stats(data) => {
                println!("Stats update: {} H/s", data.hashrate);
            }
            OtedamaMessage::Hardware(data) => {
                println!("Hardware update: {} GPU miners", data.gpu_miners.count);
            }
            OtedamaMessage::Federation(data) => {
                println!("Federation update: {} peers", data.peers);
            }
            _ => {}
        }
    }
    
    Ok(())
}
```

## Changelog

### v2.1.5 (2025-08-05)
- Comprehensive multilingual support (30 languages)
- Complete internationalization infrastructure
- Documentation updates across all languages

### v2.1.4 (2025-08-20)
- Added enterprise monitoring endpoints
- Enhanced hardware optimization API
- Improved security audit features
- Multi-language SDK support (JavaScript, Python, Go, Rust)
- Advanced federation management
- Real-time threat intelligence
- Zero-copy optimization features
- NUMA-aware memory management
- Comprehensive rate limiting

### v2.1.3 (2025-08-15)
- P2P federation protocol implementation
- Enterprise security enhancements
- Multi-algorithm support (SHA256d, Ethash, RandomX, KawPow, Scrypt)
- Hardware-specific optimization
- Advanced WebSocket features

### v2.1.0 (2025-08-01)
- Major API redesign for enterprise use
- Multi-hardware support (CPU/GPU/ASIC)
- Enhanced monitoring and analytics
- Production-ready deployment features

### v1.0 (2024-01-15)
- Initial API release
- RESTful endpoints
- WebSocket support
- Mobile API
- Federation endpoints

---

**Documentation Version**: v2.1.5  
**Last Updated**: 2025-01-15  
**API Stability**: Production Ready