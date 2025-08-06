# Performance Tuning Guide

Comprehensive guide for optimizing Otedama performance across different deployment scales.

## Table of Contents

- [Performance Overview](#performance-overview)
- [Benchmarking](#benchmarking)
- [System Optimization](#system-optimization)
- [Database Tuning](#database-tuning)
- [Network Optimization](#network-optimization)
- [Mining Engine Optimization](#mining-engine-optimization)
- [Caching Strategies](#caching-strategies)
- [Horizontal Scaling](#horizontal-scaling)
- [Monitoring Performance](#monitoring-performance)
- [Troubleshooting](#troubleshooting)

## Performance Overview

Otedama is designed for high-performance mining operations:

- **Target**: 1M+ concurrent workers
- **Latency**: <10ms share submission
- **Throughput**: 100K+ shares/second
- **Efficiency**: 99.9%+ uptime

## Benchmarking

### Running Benchmarks

```bash
# Full benchmark suite
make benchmark

# Specific benchmarks
go test -bench=BenchmarkShareValidation -benchmem -benchtime=10s ./internal/mining
go test -bench=BenchmarkStratumServer -benchmem -cpu=1,2,4,8 ./internal/stratum

# Profile generation
go test -cpuprofile=cpu.prof -memprofile=mem.prof -bench=. ./...
```

### Benchmark Results

```
BenchmarkShareValidation-8         1000000      1053 ns/op       256 B/op       4 allocs/op
BenchmarkHashCalculation-8          500000      2847 ns/op       512 B/op       8 allocs/op
BenchmarkDatabaseInsert-8            20000     65438 ns/op      2048 B/op      32 allocs/op
BenchmarkRedisCache-8               100000     10234 ns/op       128 B/op       2 allocs/op
BenchmarkStratumDecode-8           2000000       743 ns/op        64 B/op       1 allocs/op
```

### Load Testing

```bash
# Install vegeta
go install github.com/tsenart/vegeta@latest

# HTTP API load test
echo "GET http://localhost:8080/api/v1/stats" | vegeta attack -rate=1000 -duration=30s | vegeta report

# Stratum load test
./scripts/stratum-load-test.sh --workers 10000 --duration 300 --pool localhost:3333
```

## System Optimization

### CPU Optimization

#### CPU Affinity

```bash
# Set CPU affinity for Otedama process
taskset -c 0-7 otedama start

# Or in systemd service
[Service]
CPUAffinity=0-7
```

#### NUMA Optimization

```bash
# Check NUMA topology
numactl --hardware

# Run with NUMA binding
numactl --cpunodebind=0 --membind=0 otedama start
```

### Memory Optimization

#### Huge Pages

```bash
# Enable transparent huge pages
echo always > /sys/kernel/mm/transparent_hugepage/enabled

# Configure huge pages
echo 1024 > /proc/sys/vm/nr_hugepages

# In config
GODEBUG=madvdontneed=1 otedama start
```

#### Memory Limits

```yaml
# config.yaml
performance:
  memory:
    heapSize: 8192  # MB
    stackSize: 10   # MB
    gcPercent: 100  # GOGC setting
```

### Kernel Tuning

```bash
# /etc/sysctl.conf

# Network performance
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_congestion_control = bbr

# File descriptors
fs.file-max = 2097152
fs.nr_open = 2097152

# Virtual memory
vm.swappiness = 10
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5

# Apply settings
sysctl -p
```

## Database Tuning

### PostgreSQL Optimization

```sql
-- postgresql.conf

-- Memory
shared_buffers = 8GB              -- 25% of RAM
effective_cache_size = 24GB       -- 75% of RAM
work_mem = 64MB
maintenance_work_mem = 2GB

-- Checkpoint
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_buffers = 16MB
min_wal_size = 2GB
max_wal_size = 8GB

-- Connections
max_connections = 1000
max_prepared_transactions = 200

-- Query optimization
random_page_cost = 1.1            -- For SSD
effective_io_concurrency = 200    -- For SSD
default_statistics_target = 1000

-- Parallel queries
max_worker_processes = 8
max_parallel_workers_per_gather = 4
max_parallel_workers = 8

-- Autovacuum
autovacuum_max_workers = 4
autovacuum_naptime = 30s
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02
```

### Index Optimization

```sql
-- Critical indexes for performance
CREATE INDEX CONCURRENTLY idx_shares_created_at ON shares(created_at DESC);
CREATE INDEX CONCURRENTLY idx_shares_worker_id ON shares(worker_id, created_at DESC);
CREATE INDEX CONCURRENTLY idx_shares_valid ON shares(is_valid) WHERE is_valid = true;
CREATE INDEX CONCURRENTLY idx_blocks_found_at ON blocks(found_at DESC);
CREATE INDEX CONCURRENTLY idx_payouts_status ON payouts(status) WHERE status = 'pending';

-- Partial indexes for common queries
CREATE INDEX CONCURRENTLY idx_recent_shares ON shares(created_at) 
  WHERE created_at > NOW() - INTERVAL '24 hours';

-- Composite indexes
CREATE INDEX CONCURRENTLY idx_worker_stats ON shares(worker_id, is_valid, created_at);

-- BRIN indexes for time-series data
CREATE INDEX idx_shares_created_at_brin ON shares USING BRIN(created_at);
```

### Query Optimization

```sql
-- Use prepared statements
PREPARE get_worker_stats AS
SELECT 
  worker_id,
  COUNT(*) FILTER (WHERE is_valid) as valid_shares,
  COUNT(*) FILTER (WHERE NOT is_valid) as invalid_shares,
  AVG(difficulty) as avg_difficulty
FROM shares
WHERE worker_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY worker_id;

-- Materialized views for expensive aggregations
CREATE MATERIALIZED VIEW hourly_stats AS
SELECT 
  date_trunc('hour', created_at) as hour,
  COUNT(*) as total_shares,
  COUNT(DISTINCT worker_id) as unique_workers,
  SUM(difficulty) as total_difficulty
FROM shares
GROUP BY 1;

CREATE INDEX ON hourly_stats(hour DESC);

-- Refresh periodically
CREATE OR REPLACE FUNCTION refresh_hourly_stats()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY hourly_stats;
END;
$$ LANGUAGE plpgsql;
```

## Network Optimization

### TCP Tuning

```go
// Custom TCP settings
func optimizeTCPConnection(conn *net.TCPConn) error {
    // Enable TCP keepalive
    if err := conn.SetKeepAlive(true); err != nil {
        return err
    }
    
    // Set keepalive period
    if err := conn.SetKeepAlivePeriod(30 * time.Second); err != nil {
        return err
    }
    
    // Disable Nagle's algorithm for lower latency
    if err := conn.SetNoDelay(true); err != nil {
        return err
    }
    
    // Set buffer sizes
    if err := conn.SetReadBuffer(1024 * 1024); err != nil {
        return err
    }
    if err := conn.SetWriteBuffer(1024 * 1024); err != nil {
        return err
    }
    
    return nil
}
```

### Connection Pooling

```yaml
# config.yaml
network:
  stratum:
    maxConnections: 100000
    connectionTimeout: 30s
    readTimeout: 60s
    writeTimeout: 60s
    
  pool:
    initialSize: 100
    maxSize: 1000
    maxIdleTime: 300s
    connectionRetries: 3
```

### Load Balancing

```nginx
# nginx.conf for load balancing
upstream otedama_stratum {
    least_conn;
    server stratum1.example.com:3333 max_conns=10000;
    server stratum2.example.com:3333 max_conns=10000;
    server stratum3.example.com:3333 max_conns=10000;
    
    keepalive 1000;
    keepalive_timeout 65s;
}

server {
    listen 3333;
    
    proxy_pass otedama_stratum;
    proxy_protocol on;
    proxy_connect_timeout 10s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}
```

## Mining Engine Optimization

### Algorithm-Specific Optimizations

```go
// SHA256 optimization with SIMD
func sha256Optimized(data []byte) [32]byte {
    if cpu.X86.HasAVX2 {
        return sha256AVX2(data)
    } else if cpu.X86.HasSSE4 {
        return sha256SSE4(data)
    }
    return sha256.Sum256(data)
}

// Memory pool for reduced allocations
var sharePool = sync.Pool{
    New: func() interface{} {
        return &Share{
            Data: make([]byte, 0, 1024),
        }
    },
}

func getShare() *Share {
    return sharePool.Get().(*Share)
}

func putShare(s *Share) {
    s.Reset()
    sharePool.Put(s)
}
```

### Batch Processing

```go
// Batch share validation
func (e *Engine) ValidateSharesBatch(shares []*Share) []bool {
    results := make([]bool, len(shares))
    
    // Process in parallel
    workers := runtime.NumCPU()
    batchSize := len(shares) / workers
    
    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        start := i * batchSize
        end := start + batchSize
        if i == workers-1 {
            end = len(shares)
        }
        
        wg.Add(1)
        go func(start, end int) {
            defer wg.Done()
            for j := start; j < end; j++ {
                results[j] = e.validateShare(shares[j])
            }
        }(start, end)
    }
    
    wg.Wait()
    return results
}
```

## Caching Strategies

### Multi-Level Caching

```yaml
caching:
  # L1: In-memory cache
  memory:
    enabled: true
    size: 1024  # MB
    ttl: 300    # seconds
    
  # L2: Redis cache  
  redis:
    enabled: true
    maxConnections: 100
    keyPrefix: "otedama:"
    
  # L3: CDN for static assets
  cdn:
    enabled: true
    provider: "cloudflare"
    ttl: 86400
```

### Cache Implementation

```go
// Efficient cache with sharding
type ShardedCache struct {
    shards []*CacheShard
    hash   func(string) uint32
}

type CacheShard struct {
    mu    sync.RWMutex
    items map[string]*CacheItem
}

func NewShardedCache(shards int) *ShardedCache {
    c := &ShardedCache{
        shards: make([]*CacheShard, shards),
        hash:   fnv32a,
    }
    
    for i := range c.shards {
        c.shards[i] = &CacheShard{
            items: make(map[string]*CacheItem),
        }
    }
    
    return c
}

func (c *ShardedCache) Get(key string) (interface{}, bool) {
    shard := c.getShard(key)
    shard.mu.RLock()
    defer shard.mu.RUnlock()
    
    item, ok := shard.items[key]
    if !ok || item.Expired() {
        return nil, false
    }
    
    return item.Value, true
}
```

## Horizontal Scaling

### Microservices Architecture

```yaml
# docker-compose.yml for microservices
version: '3.8'

services:
  api-gateway:
    image: otedama/api-gateway
    deploy:
      replicas: 3
    ports:
      - "8080:8080"
      
  stratum-server:
    image: otedama/stratum
    deploy:
      replicas: 5
    ports:
      - "3333:3333"
      
  share-validator:
    image: otedama/validator
    deploy:
      replicas: 10
      
  payout-processor:
    image: otedama/payout
    deploy:
      replicas: 2
      
  stats-aggregator:
    image: otedama/stats
    deploy:
      replicas: 3
```

### Service Mesh Configuration

```yaml
# Istio service mesh for advanced load balancing
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: otedama-stratum
spec:
  hosts:
  - stratum.otedama.local
  http:
  - match:
    - headers:
        worker-class:
          exact: high-performance
    route:
    - destination:
        host: stratum-premium
        port:
          number: 3333
      weight: 100
  - route:
    - destination:
        host: stratum-standard
        port:
          number: 3333
      weight: 80
    - destination:
        host: stratum-overflow
        port:
          number: 3333
      weight: 20
```

## Monitoring Performance

### Key Metrics

```yaml
performance_metrics:
  # Latency metrics
  - metric: share_submission_latency
    target: < 10ms
    percentile: p99
    
  # Throughput metrics
  - metric: shares_per_second
    target: > 100000
    
  # Resource utilization
  - metric: cpu_usage
    target: < 80%
    
  - metric: memory_usage
    target: < 85%
    
  # Database performance
  - metric: query_latency
    target: < 50ms
    percentile: p95
```

### Performance Dashboard

```json
{
  "dashboard": {
    "title": "Otedama Performance",
    "panels": [
      {
        "title": "Share Processing Rate",
        "query": "rate(otedama_shares_processed_total[5m])"
      },
      {
        "title": "Latency Distribution",
        "query": "histogram_quantile(0.99, otedama_request_duration_seconds_bucket)"
      },
      {
        "title": "Connection Pool Usage",
        "query": "otedama_connection_pool_active / otedama_connection_pool_size"
      }
    ]
  }
}
```

## Troubleshooting

### Performance Issues Checklist

1. **High CPU Usage**
   - Check for hot loops
   - Profile CPU usage
   - Verify algorithm efficiency
   - Check for lock contention

2. **High Memory Usage**
   - Look for memory leaks
   - Check cache sizes
   - Verify garbage collection
   - Review allocation patterns

3. **Slow Database Queries**
   - Check query execution plans
   - Verify index usage
   - Look for lock waits
   - Check connection pool

4. **Network Latency**
   - Verify network path
   - Check packet loss
   - Review TCP settings
   - Test bandwidth

### Profiling Tools

```bash
# CPU profiling
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30

# Memory profiling
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/heap

# Trace analysis
wget http://localhost:6060/debug/pprof/trace?seconds=5
go tool trace trace

# Flame graphs
go-torch -u http://localhost:6060/debug/pprof/profile
```

## Best Practices

1. **Measure First**: Always benchmark before optimizing
2. **Profile Regularly**: Set up continuous profiling
3. **Cache Wisely**: Not everything benefits from caching
4. **Batch Operations**: Reduce overhead with batching
5. **Async Processing**: Use goroutines effectively
6. **Connection Pooling**: Reuse connections
7. **Index Properly**: Database indexes are crucial
8. **Monitor Continuously**: Set up alerts for degradation
9. **Load Test**: Test beyond expected capacity
10. **Document Changes**: Keep optimization history