# Otedama Light - Architecture Overview

## Design Philosophy

Otedama Light follows three key design principles:

1. **John Carmack**: Performance-first, measure before optimizing
2. **Robert C. Martin**: Clean architecture where it adds value
3. **Rob Pike**: Simplicity and clarity above all

## System Architecture

```
┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │
│     Miners      │────▶│  Stratum Server │
│                 │     │   (Port 3333)   │
└─────────────────┘     └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │                 │
                        │  Share Channel  │
                        │   (Buffered)    │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │                 │
                        │   Mining Core   │◀──────┐
                        │                 │       │
                        └────────┬────────┘       │
                                 │                │
                                 ▼                │
                        ┌─────────────────┐       │
                        │                 │       │
                        │  Share Validator│───────┘
                        │                 │
                        └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌─────────────────┐      ┌─────────────────┐
           │                 │      │                 │
           │  Block Submit   │      │  Share Storage  │
           │  (Blockchain)   │      │   (File/Redis)  │
           └─────────────────┘      └─────────────────┘
```

## Core Components

### 1. Network Layer (`/src/network/`)

#### Stratum Server
- Handles miner connections via TCP
- Implements minimal Stratum v1 protocol
- Direct socket handling, no framework overhead
- Message parsing with simple JSON

#### Channels
- Go-inspired channel implementation
- Buffered async communication
- Prevents blocking between components
- Type-safe message passing

### 2. Core Processing (`/src/core/`)

#### Mining Pool Core
- Main event loop
- Direct share processing
- No complex state machines
- Pre-allocated object pools

#### Share Validator
- Direct hash validation
- Optimized difficulty checking
- Batch processing support
- No cryptographic library overhead

#### Blockchain Client
- Direct JSON-RPC calls
- Minimal abstraction over Bitcoin RPC
- Connection pooling (future)

### 3. Domain Models (`/src/domain/`)

#### Share
- Minimal data structure
- Object pooling support
- Direct serialization

#### Miner
- Simple miner tracking
- In-memory statistics
- Automatic cleanup

### 4. Storage Layer (`/src/storage/`)

#### Simple Storage
- File-based for simplicity
- Batch writes for performance
- Async flushing
- Easy migration to Redis

#### Memory Cache
- Hot data in memory
- Fixed-size buffers
- LRU eviction (future)

### 5. API Layer (`/src/api/`)

#### HTTP API
- Native Node.js HTTP server
- No framework dependencies
- JSON responses
- Simple routing

#### Dashboard
- Single-page static HTML
- Vanilla JavaScript
- Auto-refreshing stats
- No build process

## Data Flow

1. **Share Submission**
   ```
   Miner → Stratum → Channel → Validator → Storage
                                    ↓
                              Block Submit
   ```

2. **Payout Calculation**
   ```
   Storage → PPLNS Calculator → Payout Queue → Blockchain
   ```

3. **API Requests**
   ```
   Client → HTTP API → Storage/Cache → JSON Response
   ```

## Performance Characteristics

### Throughput
- Target: 10,000+ shares/second
- Channel buffer: 10,000 shares
- Batch processing: 100-1000 shares

### Latency
- Share validation: < 0.1ms
- Share response: < 10ms
- API response: < 50ms

### Memory Usage
- Base: ~100MB
- Per miner: ~1KB
- Share buffer: ~100MB (1M shares)
- Total target: < 2GB

### Concurrency Model
- Single process (no clustering yet)
- Event-driven I/O
- Channel-based coordination
- No shared mutable state

## Scalability Paths

### Horizontal Scaling
1. Multiple Stratum servers
2. Shared Redis backend
3. Load balancer (HAProxy/Nginx)

### Vertical Scaling
1. Increase channel buffers
2. Tune batch sizes
3. Enable Node.js cluster mode

### Storage Scaling
1. Migrate to Redis
2. Time-series database for stats
3. S3 for long-term archives

## Monitoring Points

### Application Metrics
- Shares per second
- Active connections
- Validation errors
- Block submissions

### System Metrics
- CPU usage
- Memory usage
- Network I/O
- Disk I/O

### Business Metrics
- Miner count
- Pool hashrate
- Blocks found
- Payout queue

## Security Considerations

### Network Security
- Input validation on all data
- Rate limiting per connection
- DDoS protection (external)

### Data Security
- No sensitive data in logs
- Secure RPC credentials
- File permissions on storage

### Operational Security
- Health check endpoints
- Graceful shutdown
- Automatic recovery

## Future Enhancements

### Near-term
- [ ] Redis storage backend
- [ ] WebSocket support
- [ ] Stratum v2 protocol
- [ ] Prometheus metrics

### Long-term
- [ ] Multi-coin support
- [ ] Smart payout routing
- [ ] Decentralized coordination
- [ ] Hardware wallet integration

## Code Organization

```
src/
├── core/          # Performance-critical code
├── domain/        # Business entities
├── network/       # Network protocols
├── storage/       # Data persistence
├── api/           # External interfaces
├── payout/        # Payout calculations
├── test/          # Test suites
└── benchmark/     # Performance tests
```

## Development Workflow

1. **Feature Development**
   - Write tests first
   - Implement simply
   - Measure performance
   - Optimize if needed

2. **Code Review Focus**
   - Simplicity
   - Performance impact
   - Test coverage
   - Documentation

3. **Deployment**
   - Build TypeScript
   - Run tests
   - Deploy container
   - Monitor metrics

## Conclusion

Otedama Light demonstrates that a mining pool can be both simple and performant. By following the principles of our three masters, we've created a system that is:

- Easy to understand
- Fast to execute
- Simple to maintain
- Ready to scale

The architecture favors directness over abstraction, measurement over assumption, and clarity over cleverness.
