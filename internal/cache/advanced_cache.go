package cache

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/allegro/bigcache/v3"
	"go.uber.org/zap"
)

// AdvancedCache provides high-performance caching with multiple strategies
type AdvancedCache struct {
	logger *zap.Logger
	
	// Multiple cache layers
	l1Cache    *L1Cache      // In-memory fast cache
	l2Cache    *L2Cache      // Larger capacity cache
	bloomCache *BloomCache   // Probabilistic cache
	
	// Statistics
	stats      *CacheStats
	
	// Configuration
	config     Config
}

// Config defines cache configuration
type Config struct {
	// L1 Cache settings
	L1Size          int           `yaml:"l1_size"`
	L1TTL           time.Duration `yaml:"l1_ttl"`
	
	// L2 Cache settings
	L2Size          int           `yaml:"l2_size"`
	L2TTL           time.Duration `yaml:"l2_ttl"`
	L2Shards        int           `yaml:"l2_shards"`
	
	// Bloom filter settings
	BloomSize       uint          `yaml:"bloom_size"`
	BloomHashFuncs  uint          `yaml:"bloom_hash_funcs"`
	
	// Performance settings
	MaxConcurrency  int           `yaml:"max_concurrency"`
	CleanupInterval time.Duration `yaml:"cleanup_interval"`
	
	// Features
	EnableCompression bool        `yaml:"enable_compression"`
	EnableEncryption  bool        `yaml:"enable_encryption"`
	EnableMetrics     bool        `yaml:"enable_metrics"`
}

// CacheStats tracks cache performance
type CacheStats struct {
	Hits         atomic.Uint64
	Misses       atomic.Uint64
	Sets         atomic.Uint64
	Deletes      atomic.Uint64
	Evictions    atomic.Uint64
	L1Hits       atomic.Uint64
	L2Hits       atomic.Uint64
	BloomHits    atomic.Uint64
	BytesWritten atomic.Uint64
	BytesRead    atomic.Uint64
}

// L1Cache is a fast in-memory cache
type L1Cache struct {
	data     map[string]*CacheEntry
	mu       sync.RWMutex
	maxSize  int
	ttl      time.Duration
}

// L2Cache is a larger capacity cache using BigCache
type L2Cache struct {
	cache    *bigcache.BigCache
	config   bigcache.Config
}

// BloomCache uses bloom filters for quick existence checks
type BloomCache struct {
	filters  []*BloomFilter
	current  atomic.Uint32
	size     uint
	hashFunc uint
	mu       sync.RWMutex
}

// CacheEntry represents a cached item
type CacheEntry struct {
	Key        string
	Value      []byte
	Timestamp  time.Time
	Expiry     time.Time
	AccessCount atomic.Uint64
	Size       int
	Compressed bool
	Encrypted  bool
}

// NewAdvancedCache creates a new advanced cache system
func NewAdvancedCache(logger *zap.Logger, config Config) (*AdvancedCache, error) {
	// Set defaults
	if config.L1Size == 0 {
		config.L1Size = 10000
	}
	if config.L1TTL == 0 {
		config.L1TTL = 5 * time.Minute
	}
	if config.L2Size == 0 {
		config.L2Size = 100 * 1024 * 1024 // 100MB
	}
	if config.L2TTL == 0 {
		config.L2TTL = 30 * time.Minute
	}
	if config.L2Shards == 0 {
		config.L2Shards = 256
	}
	if config.BloomSize == 0 {
		config.BloomSize = 1000000
	}
	if config.BloomHashFuncs == 0 {
		config.BloomHashFuncs = 7
	}
	if config.CleanupInterval == 0 {
		config.CleanupInterval = 5 * time.Minute
	}
	
	// Create L1 cache
	l1Cache := &L1Cache{
		data:    make(map[string]*CacheEntry),
		maxSize: config.L1Size,
		ttl:     config.L1TTL,
	}
	
	// Create L2 cache
	l2Config := bigcache.Config{
		Shards:             config.L2Shards,
		LifeWindow:         config.L2TTL,
		CleanWindow:        config.CleanupInterval,
		MaxEntriesInWindow: 1000 * 10 * 60,
		MaxEntrySize:       500,
		Verbose:            false,
		HardMaxCacheSize:   config.L2Size / 1024 / 1024, // Convert to MB
		OnRemove:           nil,
		OnRemoveWithReason: nil,
	}
	
	l2BigCache, err := bigcache.NewBigCache(l2Config)
	if err != nil {
		return nil, fmt.Errorf("failed to create L2 cache: %w", err)
	}
	
	l2Cache := &L2Cache{
		cache:  l2BigCache,
		config: l2Config,
	}
	
	// Create bloom cache
	bloomCache := &BloomCache{
		filters:  make([]*BloomFilter, 2), // Double buffering
		size:     config.BloomSize,
		hashFunc: config.BloomHashFuncs,
	}
	bloomCache.filters[0] = NewBloomFilter(config.BloomSize, config.BloomHashFuncs)
	bloomCache.filters[1] = NewBloomFilter(config.BloomSize, config.BloomHashFuncs)
	
	cache := &AdvancedCache{
		logger:     logger,
		l1Cache:    l1Cache,
		l2Cache:    l2Cache,
		bloomCache: bloomCache,
		stats:      &CacheStats{},
		config:     config,
	}
	
	// Start cleanup routine
	go cache.cleanupRoutine(context.Background())
	
	logger.Info("Advanced cache initialized",
		zap.Int("l1_size", config.L1Size),
		zap.Int("l2_size_mb", config.L2Size/1024/1024),
		zap.Uint("bloom_size", config.BloomSize),
	)
	
	return cache, nil
}

// Get retrieves a value from cache
func (c *AdvancedCache) Get(key string) ([]byte, bool) {
	// Check bloom filter first
	if !c.bloomCache.MightContain(key) {
		c.stats.Misses.Add(1)
		return nil, false
	}
	c.stats.BloomHits.Add(1)
	
	// Check L1 cache
	if value, found := c.l1Cache.Get(key); found {
		c.stats.Hits.Add(1)
		c.stats.L1Hits.Add(1)
		c.stats.BytesRead.Add(uint64(len(value)))
		return value, true
	}
	
	// Check L2 cache
	if value, found := c.l2Cache.Get(key); found {
		c.stats.Hits.Add(1)
		c.stats.L2Hits.Add(1)
		c.stats.BytesRead.Add(uint64(len(value)))
		
		// Promote to L1
		c.l1Cache.Set(key, value, c.config.L1TTL)
		
		return value, true
	}
	
	c.stats.Misses.Add(1)
	return nil, false
}

// Set stores a value in cache
func (c *AdvancedCache) Set(key string, value []byte) error {
	return c.SetWithTTL(key, value, 0)
}

// SetWithTTL stores a value with specific TTL
func (c *AdvancedCache) SetWithTTL(key string, value []byte, ttl time.Duration) error {
	c.stats.Sets.Add(1)
	c.stats.BytesWritten.Add(uint64(len(value)))
	
	// Add to bloom filter
	c.bloomCache.Add(key)
	
	// Process value (compress/encrypt if enabled)
	processedValue := value
	compressed := false
	encrypted := false
	
	if c.config.EnableCompression && len(value) > 1024 {
		compressedValue := compress(value)
		if len(compressedValue) < len(value) {
			processedValue = compressedValue
			compressed = true
		}
	}
	
	if c.config.EnableEncryption {
		encryptedValue, err := encrypt(processedValue)
		if err == nil {
			processedValue = encryptedValue
			encrypted = true
		}
	}
	
	// Determine which cache to use based on size
	if len(processedValue) <= 1024 && c.l1Cache.Size() < c.config.L1Size {
		// Small items go to L1
		c.l1Cache.SetWithMetadata(key, processedValue, ttl, compressed, encrypted)
	} else {
		// Larger items go to L2
		if err := c.l2Cache.Set(key, processedValue); err != nil {
			return fmt.Errorf("failed to set in L2 cache: %w", err)
		}
	}
	
	return nil
}

// Delete removes a value from cache
func (c *AdvancedCache) Delete(key string) error {
	c.stats.Deletes.Add(1)
	
	// Remove from all layers
	c.l1Cache.Delete(key)
	c.l2Cache.Delete(key)
	// Note: Can't remove from bloom filter
	
	return nil
}

// Clear removes all entries from cache
func (c *AdvancedCache) Clear() error {
	c.l1Cache.Clear()
	c.l2Cache.Clear()
	c.bloomCache.Clear()
	
	// Reset stats
	c.stats = &CacheStats{}
	
	return nil
}

// GetStats returns cache statistics
func (c *AdvancedCache) GetStats() map[string]interface{} {
	hitRate := float64(0)
	total := c.stats.Hits.Load() + c.stats.Misses.Load()
	if total > 0 {
		hitRate = float64(c.stats.Hits.Load()) / float64(total) * 100
	}
	
	return map[string]interface{}{
		"hits":           c.stats.Hits.Load(),
		"misses":         c.stats.Misses.Load(),
		"hit_rate":       hitRate,
		"sets":           c.stats.Sets.Load(),
		"deletes":        c.stats.Deletes.Load(),
		"evictions":      c.stats.Evictions.Load(),
		"l1_hits":        c.stats.L1Hits.Load(),
		"l2_hits":        c.stats.L2Hits.Load(),
		"bloom_hits":     c.stats.BloomHits.Load(),
		"bytes_written":  c.stats.BytesWritten.Load(),
		"bytes_read":     c.stats.BytesRead.Load(),
		"l1_size":        c.l1Cache.Size(),
		"l2_size":        c.l2Cache.Size(),
	}
}

// Cleanup routine
func (c *AdvancedCache) cleanupRoutine(ctx context.Context) {
	ticker := time.NewTicker(c.config.CleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.cleanup()
		}
	}
}

func (c *AdvancedCache) cleanup() {
	// Clean L1 cache
	evicted := c.l1Cache.Cleanup()
	c.stats.Evictions.Add(uint64(evicted))
	
	// Rotate bloom filters periodically
	c.bloomCache.Rotate()
	
	// Log stats if metrics enabled
	if c.config.EnableMetrics {
		stats := c.GetStats()
		c.logger.Debug("Cache statistics",
			zap.Any("stats", stats),
		)
	}
}

// L1Cache implementation

func (l *L1Cache) Get(key string) ([]byte, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	
	entry, exists := l.data[key]
	if !exists {
		return nil, false
	}
	
	// Check expiry
	if time.Now().After(entry.Expiry) {
		return nil, false
	}
	
	entry.AccessCount.Add(1)
	return entry.Value, true
}

func (l *L1Cache) Set(key string, value []byte, ttl time.Duration) {
	l.SetWithMetadata(key, value, ttl, false, false)
}

func (l *L1Cache) SetWithMetadata(key string, value []byte, ttl time.Duration, compressed, encrypted bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	
	if ttl == 0 {
		ttl = l.ttl
	}
	
	entry := &CacheEntry{
		Key:        key,
		Value:      value,
		Timestamp:  time.Now(),
		Expiry:     time.Now().Add(ttl),
		Size:       len(value),
		Compressed: compressed,
		Encrypted:  encrypted,
	}
	
	l.data[key] = entry
	
	// Simple eviction if over capacity
	if len(l.data) > l.maxSize {
		l.evictOldest()
	}
}

func (l *L1Cache) Delete(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.data, key)
}

func (l *L1Cache) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.data = make(map[string]*CacheEntry)
}

func (l *L1Cache) Size() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.data)
}

func (l *L1Cache) Cleanup() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	
	now := time.Now()
	evicted := 0
	
	for key, entry := range l.data {
		if now.After(entry.Expiry) {
			delete(l.data, key)
			evicted++
		}
	}
	
	return evicted
}

func (l *L1Cache) evictOldest() {
	var oldestKey string
	var oldestTime time.Time
	
	for key, entry := range l.data {
		if oldestKey == "" || entry.Timestamp.Before(oldestTime) {
			oldestKey = key
			oldestTime = entry.Timestamp
		}
	}
	
	if oldestKey != "" {
		delete(l.data, oldestKey)
	}
}

// L2Cache implementation

func (l *L2Cache) Get(key string) ([]byte, bool) {
	value, err := l.cache.Get(key)
	if err != nil {
		return nil, false
	}
	return value, true
}

func (l *L2Cache) Set(key string, value []byte) error {
	return l.cache.Set(key, value)
}

func (l *L2Cache) Delete(key string) {
	_ = l.cache.Delete(key)
}

func (l *L2Cache) Clear() {
	_ = l.cache.Reset()
}

func (l *L2Cache) Size() int {
	stats := l.cache.Stats()
	return int(stats.Hits + stats.Misses)
}

// BloomCache implementation

func (b *BloomCache) MightContain(key string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	current := b.current.Load()
	return b.filters[current].MightContain(key)
}

func (b *BloomCache) Add(key string) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	current := b.current.Load()
	b.filters[current].Add(key)
}

func (b *BloomCache) Rotate() {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	// Switch to other buffer
	current := b.current.Load()
	next := (current + 1) % 2
	
	// Clear the next buffer
	b.filters[next] = NewBloomFilter(b.size, b.hashFunc)
	
	// Atomic switch
	b.current.Store(next)
}

func (b *BloomCache) Clear() {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	b.filters[0] = NewBloomFilter(b.size, b.hashFunc)
	b.filters[1] = NewBloomFilter(b.size, b.hashFunc)
	b.current.Store(0)
}

// Helper functions

func compress(data []byte) []byte {
	// Implement compression (e.g., using snappy or zstd)
	return data
}

func encrypt(data []byte) ([]byte, error) {
	// Implement encryption (e.g., using AES)
	return data, nil
}