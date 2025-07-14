# Otedama Architecture Guide

## Overview

Otedama is an ultra-optimized P2P mining pool and DEX platform implemented in a single file architecture. This document describes the system architecture, optimization techniques, and implementation details.

## Architecture

### Single File Design

The entire system is contained in `index.js` (~1000 lines), following these design principles:

- **John Carmack**: Direct implementation, minimal abstractions, performance-first
- **Robert C. Martin**: Clean separation of concerns within a single file
- **Rob Pike**: Simple and obvious solutions

### Core Components

```
index.js
├── ConfigManager      - Configuration management with validation
├── Logger            - Lightweight logging with file persistence
├── OtedamaDB         - SQLite database with prepared statements
├── P2PNetwork        - WebSocket-based P2P networking
├── MiningEngine      - Multi-threaded mining with worker threads
├── StratumServer     - Stratum v1 protocol implementation
├── DEX               - Automated Market Maker with x*y=k
├── APIServer         - HTTP + WebSocket API server
└── Otedama           - Main application orchestrator
```

## Optimizations

### Memory Optimization

1. **Buffer Reuse**: Pre-allocated buffer pools for mining operations
2. **Prepared Statements**: Database queries are pre-compiled
3. **Minimal Dependencies**: Only `ws` and `better-sqlite3`
4. **Garbage Collection**: Strategic GC hints at appropriate times

### Performance Optimization

1. **Worker Threads**: CPU-intensive mining in separate threads
2. **Event-Driven**: Non-blocking I/O throughout
3. **Binary Operations**: Direct buffer manipulation for hashing
4. **Batch Processing**: Database operations in transactions

### Network Optimization

1. **Connection Pooling**: Reuse WebSocket connections
2. **Message Batching**: Combine multiple updates
3. **Binary Protocol**: Efficient data serialization

## Mining Implementation

### Supported Algorithms

- **SHA256**: Bitcoin-compatible
- **KawPow**: Ravencoin-compatible
- **RandomX**: Monero-compatible (simplified)
- **Ethash**: Ethereum Classic-compatible
- **Scrypt**: Litecoin/Dogecoin-compatible

### Thread Management

```javascript
// Optimal thread calculation
const threads = config.threads || Math.max(1, os.cpus().length - 1);

// Worker creation with resource limits
new Worker(code, {
  eval: true,
  workerData: { job, threadId, totalThreads },
  resourceLimits: {
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 32
  }
});
```

## DEX Implementation

### AMM Formula

The DEX uses the constant product formula: `x * y = k`

```javascript
// Swap calculation
const amountInWithFee = amountIn * (10000 - fee);
const numerator = amountInWithFee * reserveOut;
const denominator = reserveIn * 10000 + amountInWithFee;
const amountOut = numerator / denominator;
```

### Liquidity Management

- Initial liquidity: `sqrt(amount0 * amount1)`
- Subsequent liquidity: Proportional to existing reserves
- Fee distribution: Automatically added to reserves

## API Design

### RESTful Endpoints

- `GET /` - Dashboard UI
- `GET /api/stats` - Pool statistics
- `GET /api/info` - System information
- `GET /health` - Health check

### WebSocket Events

- `subscribe` - Subscribe to real-time updates
- `stats` - Pool statistics updates
- `shares` - New share notifications
- `trades` - DEX trade events

## Database Schema

```sql
-- Mining shares
CREATE TABLE shares (
  id INTEGER PRIMARY KEY,
  worker_id TEXT NOT NULL,
  difficulty REAL NOT NULL,
  valid INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);

-- DEX trades
CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  pair TEXT NOT NULL,
  amount_in REAL NOT NULL,
  amount_out REAL NOT NULL,
  timestamp INTEGER NOT NULL
);
```

## Performance Metrics

### Target Performance

- Memory Usage: < 40MB
- Startup Time: < 2 seconds
- API Response: < 50ms
- Hashrate: Hardware-dependent
- Database Ops: > 10,000/sec

### Benchmarking

Run performance tests:

```bash
node scripts/performance-test.js
```

## Security Considerations

1. **Input Validation**: All external inputs are validated
2. **Rate Limiting**: Connection and request limits
3. **Error Isolation**: Errors don't crash the system
4. **Resource Limits**: Worker threads have memory limits

## Deployment

### Production Configuration

```json
{
  "pool": {
    "name": "Production Pool",
    "fee": 1.0
  },
  "mining": {
    "enabled": true,
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "YOUR_WALLET",
    "threads": 0
  },
  "network": {
    "p2pPort": 8333,
    "stratumPort": 3333,
    "apiPort": 8080,
    "maxPeers": 50
  }
}
```

### System Requirements

- Node.js 18+
- 1GB RAM minimum
- 2+ CPU cores recommended
- SSD storage for database

## Monitoring

### Built-in Metrics

- Hashrate monitoring
- Share statistics
- Network peer count
- Memory usage tracking
- Error logging

### External Monitoring

The system exposes metrics via:
- JSON API endpoints
- WebSocket real-time updates
- Log files in `logs/` directory

## Future Optimizations

1. **SIMD Instructions**: Utilize CPU vector extensions
2. **GPU Mining**: CUDA/OpenCL support
3. **Memory Mapping**: Direct memory-mapped database
4. **Zero-Copy**: Eliminate buffer copies
5. **JIT Compilation**: Dynamic code optimization

## Conclusion

Otedama achieves exceptional performance through careful optimization at every layer while maintaining code clarity and reliability. The single-file architecture ensures easy deployment and maintenance without sacrificing functionality.