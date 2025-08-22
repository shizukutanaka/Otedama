// Package optimization provides performance optimization for Otedama
// Memory pools, connection pools, and resource management
package optimization

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Config holds optimization configuration
type Config struct {
	MaxConnections    int
	MinConnections    int
	ConnectionTimeout time.Duration
	IdleTimeout       time.Duration
	MemoryPoolSize    int
	BufferSize        int
	MaxWorkers        int
	MinWorkers        int
	QueueSize         int
	CacheSize         int
	CacheTTL          time.Duration
}

// PoolManager manages resource pools
type PoolManager struct {
	logger *zap.Logger
	config *Config
	
	// Connection pool
	connPool *ConnectionPool
	
	// Memory pool
	memPool *MemoryPool
	
	// Worker pool
	workerPool *WorkerPool
	
	// Cache
	cache *Cache
	
	// Statistics
	allocations atomic.Uint64
	frees       atomic.Uint64
	hits        atomic.Uint64
	misses      atomic.Uint64
}

// ConnectionPool manages reusable connections
type ConnectionPool struct {
	pool      chan interface{}
	factory   func() (interface{}, error)
	maxSize   int
	minSize   int
	timeout   time.Duration
	idleTime  time.Duration
	mu        sync.Mutex
	created   int
	borrowed  int
}

// MemoryPool manages reusable memory buffers
type MemoryPool struct {
	pool       *sync.Pool
	bufferSize int
	allocated  atomic.Uint64
	freed      atomic.Uint64
}

// WorkerPool manages worker goroutines
type WorkerPool struct {
	workers   chan chan Job
	jobQueue  chan Job
	maxWorkers int
	minWorkers int
	wg        sync.WaitGroup
	stop      chan struct{}
	logger    *zap.Logger
}

// Job represents a work item
type Job interface {
	Execute() error
}

// Cache provides an LRU cache
type Cache struct {
	items    map[string]*CacheItem
	order    []*CacheItem
	maxSize  int
	ttl      time.Duration
	mu       sync.RWMutex
	hits     atomic.Uint64
	misses   atomic.Uint64
}

// CacheItem represents a cached item
type CacheItem struct {
	key       string
	value     interface{}
	timestamp time.Time
	prev      *CacheItem
	next      *CacheItem
}

// NewPoolManager creates a new pool manager
func NewPoolManager(logger *zap.Logger, cfg *Config) *PoolManager {
	pm := &PoolManager{
		logger: logger,
		config: cfg,
	}
	
	// Initialize connection pool
	pm.connPool = &ConnectionPool{
		pool:     make(chan interface{}, cfg.MaxConnections),
		maxSize:  cfg.MaxConnections,
		minSize:  cfg.MinConnections,
		timeout:  cfg.ConnectionTimeout,
		idleTime: cfg.IdleTimeout,
	}
	
	// Initialize memory pool
	pm.memPool = &MemoryPool{
		bufferSize: cfg.BufferSize,
		pool: &sync.Pool{
			New: func() interface{} {
				pm.allocations.Add(1)
				return make([]byte, cfg.BufferSize)
			},
		},
	}
	
	// Initialize worker pool
	pm.workerPool = NewWorkerPool(logger, cfg.MaxWorkers, cfg.MinWorkers, cfg.QueueSize)
	
	// Initialize cache
	pm.cache = NewCache(cfg.CacheSize, cfg.CacheTTL)
	
	logger.Info("Pool manager initialized",
		zap.Int("max_connections", cfg.MaxConnections),
		zap.Int("max_workers", cfg.MaxWorkers),
		zap.Int("cache_size", cfg.CacheSize))
	
	return pm
}

// GetBuffer gets a buffer from the memory pool
func (pm *PoolManager) GetBuffer() []byte {
	return pm.memPool.Get()
}

// PutBuffer returns a buffer to the memory pool
func (pm *PoolManager) PutBuffer(buf []byte) {
	pm.memPool.Put(buf)
}

// Submit submits a job to the worker pool
func (pm *PoolManager) Submit(job Job) error {
	return pm.workerPool.Submit(job)
}

// Get retrieves an item from cache
func (pm *PoolManager) Get(key string) (interface{}, bool) {
	return pm.cache.Get(key)
}

// Set stores an item in cache
func (pm *PoolManager) Set(key string, value interface{}) {
	pm.cache.Set(key, value)
}

// GetStatistics returns pool statistics
func (pm *PoolManager) GetStatistics() map[string]interface{} {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	return map[string]interface{}{
		"allocations":    pm.allocations.Load(),
		"frees":         pm.frees.Load(),
		"cache_hits":    pm.cache.hits.Load(),
		"cache_misses":  pm.cache.misses.Load(),
		"memory_alloc":  m.Alloc,
		"memory_total":  m.TotalAlloc,
		"goroutines":    runtime.NumGoroutine(),
		"gc_runs":       m.NumGC,
	}
}

// Get gets a buffer from the memory pool
func (mp *MemoryPool) Get() []byte {
	buf := mp.pool.Get().([]byte)
	// Clear buffer before returning
	for i := range buf {
		buf[i] = 0
	}
	return buf
}

// Put returns a buffer to the memory pool
func (mp *MemoryPool) Put(buf []byte) {
	if len(buf) != mp.bufferSize {
		// Wrong size, don't return to pool
		return
	}
	mp.freed.Add(1)
	mp.pool.Put(buf)
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(logger *zap.Logger, maxWorkers, minWorkers, queueSize int) *WorkerPool {
	wp := &WorkerPool{
		workers:    make(chan chan Job, maxWorkers),
		jobQueue:   make(chan Job, queueSize),
		maxWorkers: maxWorkers,
		minWorkers: minWorkers,
		stop:       make(chan struct{}),
		logger:     logger,
	}
	
	// Start minimum number of workers
	for i := 0; i < minWorkers; i++ {
		worker := NewWorker(wp.workers, wp.stop, logger)
		worker.Start()
	}
	
	// Start dispatcher
	go wp.dispatch()
	
	return wp
}

// Submit submits a job to the worker pool
func (wp *WorkerPool) Submit(job Job) error {
	select {
	case wp.jobQueue <- job:
		return nil
	default:
		return errors.New("job queue full")
	}
}

// dispatch dispatches jobs to workers
func (wp *WorkerPool) dispatch() {
	for {
		select {
		case job := <-wp.jobQueue:
			// Get available worker
			worker := <-wp.workers
			// Dispatch job
			worker <- job
		case <-wp.stop:
			return
		}
	}
}

// Stop stops the worker pool
func (wp *WorkerPool) Stop() {
	close(wp.stop)
	wp.wg.Wait()
}

// Worker represents a worker goroutine
type Worker struct {
	workerPool chan chan Job
	jobChannel chan Job
	stop       chan struct{}
	logger     *zap.Logger
}

// NewWorker creates a new worker
func NewWorker(workerPool chan chan Job, stop chan struct{}, logger *zap.Logger) *Worker {
	return &Worker{
		workerPool: workerPool,
		jobChannel: make(chan Job),
		stop:       stop,
		logger:     logger,
	}
}

// Start starts the worker
func (w *Worker) Start() {
	go func() {
		for {
			// Register as available
			w.workerPool <- w.jobChannel
			
			select {
			case job := <-w.jobChannel:
				// Execute job
				if err := job.Execute(); err != nil {
					w.logger.Error("Job execution failed", zap.Error(err))
				}
			case <-w.stop:
				return
			}
		}
	}()
}

// NewCache creates a new cache
func NewCache(maxSize int, ttl time.Duration) *Cache {
	c := &Cache{
		items:   make(map[string]*CacheItem),
		order:   make([]*CacheItem, 0, maxSize),
		maxSize: maxSize,
		ttl:     ttl,
	}
	
	// Start cleanup routine
	go c.cleanup()
	
	return c
}

// Get retrieves an item from cache
func (c *Cache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	item, ok := c.items[key]
	c.mu.RUnlock()
	
	if !ok {
		c.misses.Add(1)
		return nil, false
	}
	
	// Check if expired
	if c.ttl > 0 && time.Since(item.timestamp) > c.ttl {
		c.mu.Lock()
		c.remove(item)
		c.mu.Unlock()
		c.misses.Add(1)
		return nil, false
	}
	
	// Move to front (most recently used)
	c.mu.Lock()
	c.moveToFront(item)
	c.mu.Unlock()
	
	c.hits.Add(1)
	return item.value, true
}

// Set stores an item in cache
func (c *Cache) Set(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	// Check if already exists
	if item, ok := c.items[key]; ok {
		item.value = value
		item.timestamp = time.Now()
		c.moveToFront(item)
		return
	}
	
	// Create new item
	item := &CacheItem{
		key:       key,
		value:     value,
		timestamp: time.Now(),
	}
	
	// Add to cache
	c.items[key] = item
	c.order = append([]*CacheItem{item}, c.order...)
	
	// Update links
	if len(c.order) > 1 {
		item.next = c.order[1]
		c.order[1].prev = item
	}
	
	// Evict if necessary
	if len(c.order) > c.maxSize {
		last := c.order[len(c.order)-1]
		c.remove(last)
	}
}

// remove removes an item from cache
func (c *Cache) remove(item *CacheItem) {
	delete(c.items, item.key)
	
	// Remove from order
	for i, it := range c.order {
		if it == item {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	
	// Update links
	if item.prev != nil {
		item.prev.next = item.next
	}
	if item.next != nil {
		item.next.prev = item.prev
	}
}

// moveToFront moves an item to the front of the order
func (c *Cache) moveToFront(item *CacheItem) {
	// Already at front
	if c.order[0] == item {
		return
	}
	
	// Remove from current position
	for i, it := range c.order {
		if it == item {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
	
	// Add to front
	c.order = append([]*CacheItem{item}, c.order...)
	
	// Update links
	item.prev = nil
	if len(c.order) > 1 {
		item.next = c.order[1]
		c.order[1].prev = item
	} else {
		item.next = nil
	}
}

// cleanup periodically removes expired items
func (c *Cache) cleanup() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for key, item := range c.items {
			if c.ttl > 0 && now.Sub(item.timestamp) > c.ttl {
				delete(c.items, key)
			}
		}
		c.mu.Unlock()
	}
}

// SimpleJob represents a simple job implementation
type SimpleJob struct {
	fn func() error
}

// NewSimpleJob creates a new simple job
func NewSimpleJob(fn func() error) *SimpleJob {
	return &SimpleJob{fn: fn}
}

// Execute executes the job
func (j *SimpleJob) Execute() error {
	return j.fn()
}

// Optimize performs runtime optimization
func Optimize() {
	// Set GOGC to reduce GC frequency
	runtime.SetGCPercent(50)
	
	// Run GC to clean up
	runtime.GC()
	
	// Return unused memory to OS
	runtime.FreeOSMemory()
}

// SetMaxProcs sets GOMAXPROCS for optimal performance
func SetMaxProcs() {
	numCPU := runtime.NumCPU()
	runtime.GOMAXPROCS(numCPU)
}

// GetMemoryStats returns current memory statistics
func GetMemoryStats() map[string]uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	return map[string]uint64{
		"alloc":       m.Alloc,
		"total_alloc": m.TotalAlloc,
		"sys":         m.Sys,
		"num_gc":      uint64(m.NumGC),
		"goroutines":  uint64(runtime.NumGoroutine()),
	}
}
