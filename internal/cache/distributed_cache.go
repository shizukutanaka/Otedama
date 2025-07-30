package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DistributedCache implements a distributed caching layer
// Following Robert C. Martin's principle: "Depend on abstractions, not concretions"
type DistributedCache struct {
	logger *zap.Logger
	config *CacheConfig
	
	// Cache backends
	redisCluster    *RedisCluster
	localCache      *LocalCache
	
	// Consistent hashing
	consistentHash  *ConsistentHash
	
	// Cache invalidation
	invalidator     *CacheInvalidator
	
	// Performance tracking
	stats           *CacheStatistics
	
	// Write-through/Write-back
	writeStrategy   WriteStrategy
	writeQueue      *WriteQueue
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// CacheConfig contains cache configuration
type CacheConfig struct {
	// Redis configuration
	RedisAddresses      []string
	RedisPassword       string
	RedisDB             int
	RedisMaxRetries     int
	RedisPoolSize       int
	
	// Local cache settings
	LocalCacheSize      int
	LocalCacheTTL       time.Duration
	
	// Cache behavior
	DefaultTTL          time.Duration
	MaxKeySize          int
	MaxValueSize        int
	CompressionEnabled  bool
	CompressionThreshold int
	
	// Write strategy
	WriteStrategy       string // "write-through", "write-back", "write-around"
	WriteBatchSize      int
	WriteFlushInterval  time.Duration
	
	// Invalidation
	InvalidationMode    string // "lazy", "active", "hybrid"
	ConsistencyLevel    string // "eventual", "strong"
	
	// Sharding
	ShardCount          int
	ReplicationFactor   int
}

// WriteStrategy defines cache write behavior
type WriteStrategy interface {
	Write(key string, value []byte, ttl time.Duration) error
	Flush() error
}

// CacheStatistics tracks cache performance
type CacheStatistics struct {
	Hits            atomic.Uint64
	Misses          atomic.Uint64
	Sets            atomic.Uint64
	Deletes         atomic.Uint64
	Evictions       atomic.Uint64
	LocalHits       atomic.Uint64
	RemoteHits      atomic.Uint64
	AvgGetLatency   atomic.Uint64 // Nanoseconds
	AvgSetLatency   atomic.Uint64
	BytesStored     atomic.Uint64
	BytesRetrieved  atomic.Uint64
}

// NewDistributedCache creates a new distributed cache
func NewDistributedCache(logger *zap.Logger, config *CacheConfig) (*DistributedCache, error) {
	if config == nil {
		config = DefaultCacheConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	dc := &DistributedCache{
		logger:         logger,
		config:         config,
		localCache:     NewLocalCache(config.LocalCacheSize, config.LocalCacheTTL),
		consistentHash: NewConsistentHash(config.ShardCount, config.ReplicationFactor),
		invalidator:    NewCacheInvalidator(logger),
		stats:          &CacheStatistics{},
		writeQueue:     NewWriteQueue(config.WriteBatchSize),
		ctx:            ctx,
		cancel:         cancel,
	}
	
	// Initialize Redis cluster
	var err error
	dc.redisCluster, err = NewRedisCluster(logger, config)
	if err != nil {
		return nil, fmt.Errorf("failed to create Redis cluster: %w", err)
	}
	
	// Initialize write strategy
	switch config.WriteStrategy {
	case "write-through":
		dc.writeStrategy = NewWriteThroughStrategy(dc)
	case "write-back":
		dc.writeStrategy = NewWriteBackStrategy(dc)
	default:
		dc.writeStrategy = NewWriteAroundStrategy(dc)
	}
	
	// Add Redis nodes to consistent hash
	for _, addr := range config.RedisAddresses {
		dc.consistentHash.AddNode(addr)
	}
	
	return dc, nil
}

// Start starts the distributed cache
func (dc *DistributedCache) Start() error {
	dc.logger.Info("Starting distributed cache",
		zap.Int("redis_nodes", len(dc.config.RedisAddresses)),
		zap.String("write_strategy", dc.config.WriteStrategy),
		zap.String("consistency_level", dc.config.ConsistencyLevel),
	)
	
	// Start Redis cluster
	if err := dc.redisCluster.Start(); err != nil {
		return fmt.Errorf("failed to start Redis cluster: %w", err)
	}
	
	// Start background workers
	dc.wg.Add(1)
	go dc.writeFlushLoop()
	
	dc.wg.Add(1)
	go dc.statsLoop()
	
	if dc.config.InvalidationMode == "active" {
		dc.wg.Add(1)
		go dc.invalidationLoop()
	}
	
	return nil
}

// Stop stops the distributed cache
func (dc *DistributedCache) Stop() error {
	dc.logger.Info("Stopping distributed cache")
	
	// Flush pending writes
	if err := dc.writeStrategy.Flush(); err != nil {
		dc.logger.Error("Failed to flush writes", zap.Error(err))
	}
	
	dc.cancel()
	dc.wg.Wait()
	
	// Stop Redis cluster
	return dc.redisCluster.Stop()
}

// Get retrieves a value from cache
func (dc *DistributedCache) Get(ctx context.Context, key string) ([]byte, error) {
	start := time.Now()
	defer dc.recordGetLatency(start)
	
	// Check local cache first
	if value, found := dc.localCache.Get(key); found {
		dc.stats.LocalHits.Add(1)
		dc.stats.Hits.Add(1)
		dc.stats.BytesRetrieved.Add(uint64(len(value)))
		return value, nil
	}
	
	// Get from Redis
	node := dc.consistentHash.GetNode(key)
	value, err := dc.redisCluster.Get(ctx, node, key)
	if err != nil {
		dc.stats.Misses.Add(1)
		return nil, err
	}
	
	if value == nil {
		dc.stats.Misses.Add(1)
		return nil, fmt.Errorf("key not found")
	}
	
	// Update local cache
	dc.localCache.Set(key, value, dc.config.LocalCacheTTL)
	
	dc.stats.RemoteHits.Add(1)
	dc.stats.Hits.Add(1)
	dc.stats.BytesRetrieved.Add(uint64(len(value)))
	
	return value, nil
}

// Set stores a value in cache
func (dc *DistributedCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	start := time.Now()
	defer dc.recordSetLatency(start)
	
	// Validate size limits
	if len(key) > dc.config.MaxKeySize {
		return fmt.Errorf("key size exceeds limit")
	}
	if len(value) > dc.config.MaxValueSize {
		return fmt.Errorf("value size exceeds limit")
	}
	
	// Compress if needed
	if dc.config.CompressionEnabled && len(value) > dc.config.CompressionThreshold {
		compressed, err := compress(value)
		if err == nil && len(compressed) < len(value) {
			value = compressed
		}
	}
	
	// Use configured TTL if not specified
	if ttl == 0 {
		ttl = dc.config.DefaultTTL
	}
	
	// Write through strategy
	err := dc.writeStrategy.Write(key, value, ttl)
	if err != nil {
		return err
	}
	
	dc.stats.Sets.Add(1)
	dc.stats.BytesStored.Add(uint64(len(value)))
	
	return nil
}

// Delete removes a key from cache
func (dc *DistributedCache) Delete(ctx context.Context, key string) error {
	// Delete from local cache
	dc.localCache.Delete(key)
	
	// Delete from Redis (all replicas)
	nodes := dc.consistentHash.GetNodes(key, dc.config.ReplicationFactor)
	var lastErr error
	
	for _, node := range nodes {
		if err := dc.redisCluster.Delete(ctx, node, key); err != nil {
			lastErr = err
		}
	}
	
	dc.stats.Deletes.Add(1)
	
	// Broadcast invalidation
	if dc.config.ConsistencyLevel == "strong" {
		dc.invalidator.Broadcast(key)
	}
	
	return lastErr
}

// GetMulti retrieves multiple values
func (dc *DistributedCache) GetMulti(ctx context.Context, keys []string) (map[string][]byte, error) {
	results := make(map[string][]byte)
	missing := make([]string, 0)
	
	// Check local cache
	for _, key := range keys {
		if value, found := dc.localCache.Get(key); found {
			results[key] = value
			dc.stats.LocalHits.Add(1)
		} else {
			missing = append(missing, key)
		}
	}
	
	if len(missing) == 0 {
		return results, nil
	}
	
	// Group keys by node
	nodeKeys := make(map[string][]string)
	for _, key := range missing {
		node := dc.consistentHash.GetNode(key)
		nodeKeys[node] = append(nodeKeys[node], key)
	}
	
	// Parallel fetch from nodes
	var mu sync.Mutex
	var wg sync.WaitGroup
	
	for node, nodeKeyList := range nodeKeys {
		wg.Add(1)
		go func(n string, keys []string) {
			defer wg.Done()
			
			values, err := dc.redisCluster.GetMulti(ctx, n, keys)
			if err != nil {
				return
			}
			
			mu.Lock()
			for k, v := range values {
				results[k] = v
				// Update local cache
				dc.localCache.Set(k, v, dc.config.LocalCacheTTL)
				dc.stats.RemoteHits.Add(1)
			}
			mu.Unlock()
		}(node, nodeKeyList)
	}
	
	wg.Wait()
	
	return results, nil
}

// SetMulti stores multiple values
func (dc *DistributedCache) SetMulti(ctx context.Context, items map[string][]byte, ttl time.Duration) error {
	// Group by node
	nodeItems := make(map[string]map[string][]byte)
	
	for key, value := range items {
		node := dc.consistentHash.GetNode(key)
		if nodeItems[node] == nil {
			nodeItems[node] = make(map[string][]byte)
		}
		nodeItems[node][key] = value
	}
	
	// Parallel set
	var wg sync.WaitGroup
	var lastErr error
	var errMu sync.Mutex
	
	for node, nodeItemMap := range nodeItems {
		wg.Add(1)
		go func(n string, items map[string][]byte) {
			defer wg.Done()
			
			if err := dc.redisCluster.SetMulti(ctx, n, items, ttl); err != nil {
				errMu.Lock()
				lastErr = err
				errMu.Unlock()
			}
		}(node, nodeItemMap)
	}
	
	wg.Wait()
	
	dc.stats.Sets.Add(uint64(len(items)))
	
	return lastErr
}

// GetStats returns cache statistics
func (dc *DistributedCache) GetStats() CacheStats {
	totalRequests := dc.stats.Hits.Load() + dc.stats.Misses.Load()
	hitRate := float64(0)
	if totalRequests > 0 {
		hitRate = float64(dc.stats.Hits.Load()) / float64(totalRequests)
	}
	
	return CacheStats{
		Hits:           dc.stats.Hits.Load(),
		Misses:         dc.stats.Misses.Load(),
		HitRate:        hitRate,
		Sets:           dc.stats.Sets.Load(),
		Deletes:        dc.stats.Deletes.Load(),
		Evictions:      dc.stats.Evictions.Load(),
		LocalHits:      dc.stats.LocalHits.Load(),
		RemoteHits:     dc.stats.RemoteHits.Load(),
		AvgGetLatency:  time.Duration(dc.stats.AvgGetLatency.Load()),
		AvgSetLatency:  time.Duration(dc.stats.AvgSetLatency.Load()),
		BytesStored:    dc.stats.BytesStored.Load(),
		BytesRetrieved: dc.stats.BytesRetrieved.Load(),
	}
}

// Private methods

func (dc *DistributedCache) writeFlushLoop() {
	defer dc.wg.Done()
	
	ticker := time.NewTicker(dc.config.WriteFlushInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if err := dc.writeStrategy.Flush(); err != nil {
				dc.logger.Error("Write flush failed", zap.Error(err))
			}
			
		case <-dc.ctx.Done():
			return
		}
	}
}

func (dc *DistributedCache) statsLoop() {
	defer dc.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			stats := dc.GetStats()
			dc.logger.Info("Cache statistics",
				zap.Uint64("hits", stats.Hits),
				zap.Uint64("misses", stats.Misses),
				zap.Float64("hit_rate", stats.HitRate),
				zap.Duration("avg_get_latency", stats.AvgGetLatency),
				zap.Duration("avg_set_latency", stats.AvgSetLatency),
			)
			
		case <-dc.ctx.Done():
			return
		}
	}
}

func (dc *DistributedCache) invalidationLoop() {
	defer dc.wg.Done()
	
	for {
		select {
		case key := <-dc.invalidator.invalidationChan:
			dc.localCache.Delete(key)
			
		case <-dc.ctx.Done():
			return
		}
	}
}

func (dc *DistributedCache) recordGetLatency(start time.Time) {
	latency := uint64(time.Since(start).Nanoseconds())
	
	// Update average (simplified moving average)
	current := dc.stats.AvgGetLatency.Load()
	if current == 0 {
		dc.stats.AvgGetLatency.Store(latency)
	} else {
		newAvg := (current*9 + latency) / 10
		dc.stats.AvgGetLatency.Store(newAvg)
	}
}

func (dc *DistributedCache) recordSetLatency(start time.Time) {
	latency := uint64(time.Since(start).Nanoseconds())
	
	current := dc.stats.AvgSetLatency.Load()
	if current == 0 {
		dc.stats.AvgSetLatency.Store(latency)
	} else {
		newAvg := (current*9 + latency) / 10
		dc.stats.AvgSetLatency.Store(newAvg)
	}
}

// Helper components

// RedisCluster manages Redis connections
type RedisCluster struct {
	logger     *zap.Logger
	config     *CacheConfig
	connections map[string]*RedisConnection
	mu         sync.RWMutex
}

func NewRedisCluster(logger *zap.Logger, config *CacheConfig) (*RedisCluster, error) {
	rc := &RedisCluster{
		logger:      logger,
		config:      config,
		connections: make(map[string]*RedisConnection),
	}
	
	// Create connections
	for _, addr := range config.RedisAddresses {
		conn := &RedisConnection{
			address: addr,
			// In real implementation, would create actual Redis connection
		}
		rc.connections[addr] = conn
	}
	
	return rc, nil
}

func (rc *RedisCluster) Start() error {
	// Initialize connections
	return nil
}

func (rc *RedisCluster) Stop() error {
	// Close connections
	return nil
}

func (rc *RedisCluster) Get(ctx context.Context, node, key string) ([]byte, error) {
	// Simplified implementation
	return nil, nil
}

func (rc *RedisCluster) Set(ctx context.Context, node, key string, value []byte, ttl time.Duration) error {
	return nil
}

func (rc *RedisCluster) Delete(ctx context.Context, node, key string) error {
	return nil
}

func (rc *RedisCluster) GetMulti(ctx context.Context, node string, keys []string) (map[string][]byte, error) {
	return nil, nil
}

func (rc *RedisCluster) SetMulti(ctx context.Context, node string, items map[string][]byte, ttl time.Duration) error {
	return nil
}

// RedisConnection represents a Redis connection
type RedisConnection struct {
	address string
	// Would contain actual Redis client
}

// LocalCache implements a local LRU cache
type LocalCache struct {
	capacity int
	ttl      time.Duration
	items    map[string]*CacheItem
	mu       sync.RWMutex
}

type CacheItem struct {
	Value     []byte
	ExpiresAt time.Time
}

func NewLocalCache(capacity int, ttl time.Duration) *LocalCache {
	return &LocalCache{
		capacity: capacity,
		ttl:      ttl,
		items:    make(map[string]*CacheItem),
	}
}

func (lc *LocalCache) Get(key string) ([]byte, bool) {
	lc.mu.RLock()
	defer lc.mu.RUnlock()
	
	item, exists := lc.items[key]
	if !exists {
		return nil, false
	}
	
	if time.Now().After(item.ExpiresAt) {
		return nil, false
	}
	
	return item.Value, true
}

func (lc *LocalCache) Set(key string, value []byte, ttl time.Duration) {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	
	lc.items[key] = &CacheItem{
		Value:     value,
		ExpiresAt: time.Now().Add(ttl),
	}
	
	// Simple eviction if over capacity
	if len(lc.items) > lc.capacity {
		// Remove first item (not true LRU)
		for k := range lc.items {
			delete(lc.items, k)
			break
		}
	}
}

func (lc *LocalCache) Delete(key string) {
	lc.mu.Lock()
	delete(lc.items, key)
	lc.mu.Unlock()
}

// ConsistentHash implements consistent hashing
type ConsistentHash struct {
	nodes    []string
	replicas int
	mu       sync.RWMutex
}

func NewConsistentHash(shards, replicas int) *ConsistentHash {
	return &ConsistentHash{
		nodes:    make([]string, 0),
		replicas: replicas,
	}
}

func (ch *ConsistentHash) AddNode(node string) {
	ch.mu.Lock()
	ch.nodes = append(ch.nodes, node)
	ch.mu.Unlock()
}

func (ch *ConsistentHash) GetNode(key string) string {
	ch.mu.RLock()
	defer ch.mu.RUnlock()
	
	if len(ch.nodes) == 0 {
		return ""
	}
	
	// Simple hash distribution
	hash := hashString(key)
	index := hash % uint32(len(ch.nodes))
	return ch.nodes[index]
}

func (ch *ConsistentHash) GetNodes(key string, count int) []string {
	ch.mu.RLock()
	defer ch.mu.RUnlock()
	
	if len(ch.nodes) == 0 {
		return nil
	}
	
	// Return multiple nodes for replication
	nodes := make([]string, 0, count)
	hash := hashString(key)
	
	for i := 0; i < count && i < len(ch.nodes); i++ {
		index := (hash + uint32(i)) % uint32(len(ch.nodes))
		nodes = append(nodes, ch.nodes[index])
	}
	
	return nodes
}

// CacheInvalidator handles cache invalidation
type CacheInvalidator struct {
	logger           *zap.Logger
	invalidationChan chan string
}

func NewCacheInvalidator(logger *zap.Logger) *CacheInvalidator {
	return &CacheInvalidator{
		logger:           logger,
		invalidationChan: make(chan string, 1000),
	}
}

func (ci *CacheInvalidator) Broadcast(key string) {
	select {
	case ci.invalidationChan <- key:
	default:
		ci.logger.Warn("Invalidation channel full")
	}
}

// WriteQueue manages write batching
type WriteQueue struct {
	items    []WriteItem
	capacity int
	mu       sync.Mutex
}

type WriteItem struct {
	Key   string
	Value []byte
	TTL   time.Duration
}

func NewWriteQueue(capacity int) *WriteQueue {
	return &WriteQueue{
		items:    make([]WriteItem, 0, capacity),
		capacity: capacity,
	}
}

// Write strategies

type WriteThroughStrategy struct {
	cache *DistributedCache
}

func NewWriteThroughStrategy(cache *DistributedCache) *WriteThroughStrategy {
	return &WriteThroughStrategy{cache: cache}
}

func (wts *WriteThroughStrategy) Write(key string, value []byte, ttl time.Duration) error {
	// Write to cache and backend simultaneously
	node := wts.cache.consistentHash.GetNode(key)
	return wts.cache.redisCluster.Set(context.Background(), node, key, value, ttl)
}

func (wts *WriteThroughStrategy) Flush() error {
	return nil
}

type WriteBackStrategy struct {
	cache *DistributedCache
}

func NewWriteBackStrategy(cache *DistributedCache) *WriteBackStrategy {
	return &WriteBackStrategy{cache: cache}
}

func (wbs *WriteBackStrategy) Write(key string, value []byte, ttl time.Duration) error {
	// Add to write queue
	wbs.cache.writeQueue.mu.Lock()
	wbs.cache.writeQueue.items = append(wbs.cache.writeQueue.items, WriteItem{
		Key:   key,
		Value: value,
		TTL:   ttl,
	})
	wbs.cache.writeQueue.mu.Unlock()
	return nil
}

func (wbs *WriteBackStrategy) Flush() error {
	// Flush write queue
	wbs.cache.writeQueue.mu.Lock()
	items := wbs.cache.writeQueue.items
	wbs.cache.writeQueue.items = make([]WriteItem, 0, wbs.cache.writeQueue.capacity)
	wbs.cache.writeQueue.mu.Unlock()
	
	// Write items
	for _, item := range items {
		node := wbs.cache.consistentHash.GetNode(item.Key)
		wbs.cache.redisCluster.Set(context.Background(), node, item.Key, item.Value, item.TTL)
	}
	
	return nil
}

type WriteAroundStrategy struct {
	cache *DistributedCache
}

func NewWriteAroundStrategy(cache *DistributedCache) *WriteAroundStrategy {
	return &WriteAroundStrategy{cache: cache}
}

func (was *WriteAroundStrategy) Write(key string, value []byte, ttl time.Duration) error {
	// Write only to backend, invalidate cache
	was.cache.localCache.Delete(key)
	node := was.cache.consistentHash.GetNode(key)
	return was.cache.redisCluster.Set(context.Background(), node, key, value, ttl)
}

func (was *WriteAroundStrategy) Flush() error {
	return nil
}

// Helper functions

func hashString(s string) uint32 {
	var hash uint32 = 5381
	for i := 0; i < len(s); i++ {
		hash = ((hash << 5) + hash) + uint32(s[i])
	}
	return hash
}

func compress(data []byte) ([]byte, error) {
	// Simplified - would use actual compression
	return data, nil
}

// Helper structures

type CacheStats struct {
	Hits           uint64
	Misses         uint64
	HitRate        float64
	Sets           uint64
	Deletes        uint64
	Evictions      uint64
	LocalHits      uint64
	RemoteHits     uint64
	AvgGetLatency  time.Duration
	AvgSetLatency  time.Duration
	BytesStored    uint64
	BytesRetrieved uint64
}

// DefaultCacheConfig returns default cache configuration
func DefaultCacheConfig() *CacheConfig {
	return &CacheConfig{
		RedisAddresses:       []string{"localhost:6379"},
		RedisDB:              0,
		RedisMaxRetries:      3,
		RedisPoolSize:        10,
		LocalCacheSize:       10000,
		LocalCacheTTL:        1 * time.Minute,
		DefaultTTL:           5 * time.Minute,
		MaxKeySize:           1024,
		MaxValueSize:         1024 * 1024, // 1MB
		CompressionEnabled:   true,
		CompressionThreshold: 1024, // 1KB
		WriteStrategy:        "write-through",
		WriteBatchSize:       100,
		WriteFlushInterval:   5 * time.Second,
		InvalidationMode:     "lazy",
		ConsistencyLevel:     "eventual",
		ShardCount:           16,
		ReplicationFactor:    2,
	}
}