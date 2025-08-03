package memory

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ObjectPool provides efficient object reuse to reduce GC pressure
type ObjectPool struct {
	pool      *sync.Pool
	allocated atomic.Int64
	reused    atomic.Int64
	stats     PoolStats
	mu        sync.RWMutex
}

// PoolStats tracks pool performance metrics
type PoolStats struct {
	TotalAllocated   int64
	TotalReused      int64
	CurrentActive    int64
	PeakActive       int64
	AllocationRate   float64
	ReuseRate        float64
	LastUpdate       time.Time
	AverageObjectAge time.Duration
}

// PooledObject interface for poolable objects
type PooledObject interface {
	Reset()
	IsValid() bool
}

// BufferPool manages byte buffers
type BufferPool struct {
	pools map[int]*ObjectPool
	mu    sync.RWMutex
}

// Buffer represents a pooled byte buffer
type Buffer struct {
	data      []byte
	capacity  int
	pool      *BufferPool
	inUse     bool
	allocated time.Time
}

// NewObjectPool creates a new object pool
func NewObjectPool(factory func() interface{}) *ObjectPool {
	return &ObjectPool{
		pool: &sync.Pool{
			New: factory,
		},
		stats: PoolStats{
			LastUpdate: time.Now(),
		},
	}
}

// Get retrieves an object from the pool
func (op *ObjectPool) Get() interface{} {
	obj := op.pool.Get()
	
	if obj != nil {
		op.reused.Add(1)
		op.stats.TotalReused++
	} else {
		op.allocated.Add(1)
		op.stats.TotalAllocated++
	}
	
	op.updateStats()
	return obj
}

// Put returns an object to the pool
func (op *ObjectPool) Put(obj interface{}) {
	if pooled, ok := obj.(PooledObject); ok {
		if !pooled.IsValid() {
			return // Don't pool invalid objects
		}
		pooled.Reset()
	}
	
	op.pool.Put(obj)
	op.updateStats()
}

// GetStats returns current pool statistics
func (op *ObjectPool) GetStats() PoolStats {
	op.mu.RLock()
	defer op.mu.RUnlock()
	return op.stats
}

func (op *ObjectPool) updateStats() {
	op.mu.Lock()
	defer op.mu.Unlock()
	
	now := time.Now()
	elapsed := now.Sub(op.stats.LastUpdate).Seconds()
	
	if elapsed > 0 {
		allocated := op.allocated.Load()
		reused := op.reused.Load()
		
		op.stats.AllocationRate = float64(allocated-op.stats.TotalAllocated) / elapsed
		op.stats.ReuseRate = float64(reused-op.stats.TotalReused) / elapsed
		
		op.stats.TotalAllocated = allocated
		op.stats.TotalReused = reused
		op.stats.LastUpdate = now
		
		// Update current active
		op.stats.CurrentActive = allocated - reused
		if op.stats.CurrentActive > op.stats.PeakActive {
			op.stats.PeakActive = op.stats.CurrentActive
		}
	}
}

// NewBufferPool creates a new buffer pool
func NewBufferPool() *BufferPool {
	return &BufferPool{
		pools: make(map[int]*ObjectPool),
	}
}

// Get retrieves a buffer of specified size
func (bp *BufferPool) Get(size int) *Buffer {
	// Round up to nearest power of 2
	poolSize := 1
	for poolSize < size {
		poolSize <<= 1
	}
	
	bp.mu.RLock()
	pool, exists := bp.pools[poolSize]
	bp.mu.RUnlock()
	
	if !exists {
		bp.mu.Lock()
		pool = NewObjectPool(func() interface{} {
			return &Buffer{
				data:     make([]byte, poolSize),
				capacity: poolSize,
				pool:     bp,
			}
		})
		bp.pools[poolSize] = pool
		bp.mu.Unlock()
	}
	
	buffer := pool.Get().(*Buffer)
	buffer.data = buffer.data[:size]
	buffer.inUse = true
	buffer.allocated = time.Now()
	
	return buffer
}

// Put returns a buffer to the pool
func (bp *BufferPool) Put(buffer *Buffer) {
	if !buffer.inUse {
		return
	}
	
	buffer.inUse = false
	
	// Find the appropriate pool
	poolSize := 1
	for poolSize < buffer.capacity {
		poolSize <<= 1
	}
	
	bp.mu.RLock()
	pool, exists := bp.pools[poolSize]
	bp.mu.RUnlock()
	
	if exists {
		pool.Put(buffer)
	}
}

// GetStats returns statistics for all buffer pools
func (bp *BufferPool) GetStats() map[int]PoolStats {
	bp.mu.RLock()
	defer bp.mu.RUnlock()
	
	stats := make(map[int]PoolStats)
	for size, pool := range bp.pools {
		stats[size] = pool.GetStats()
	}
	return stats
}

// Buffer methods

// Bytes returns the buffer data
func (b *Buffer) Bytes() []byte {
	return b.data
}

// Len returns the buffer length
func (b *Buffer) Len() int {
	return len(b.data)
}

// Cap returns the buffer capacity
func (b *Buffer) Cap() int {
	return b.capacity
}

// Reset implements PooledObject
func (b *Buffer) Reset() {
	// Clear sensitive data
	for i := range b.data {
		b.data[i] = 0
	}
	b.data = b.data[:0]
}

// IsValid implements PooledObject
func (b *Buffer) IsValid() bool {
	return b.capacity > 0 && b.data != nil
}

// Release returns the buffer to the pool
func (b *Buffer) Release() {
	if b.pool != nil {
		b.pool.Put(b)
	}
}

// SharePool manages Share objects
type SharePool struct {
	pool *ObjectPool
}

// NewSharePool creates a new share pool
func NewSharePool() *SharePool {
	return &SharePool{
		pool: NewObjectPool(func() interface{} {
			return &PooledShare{}
		}),
	}
}

// Get retrieves a share from the pool
func (sp *SharePool) Get() *PooledShare {
	return sp.pool.Get().(*PooledShare)
}

// Put returns a share to the pool
func (sp *SharePool) Put(share *PooledShare) {
	sp.pool.Put(share)
}

// GetStats returns pool statistics
func (sp *SharePool) GetStats() PoolStats {
	return sp.pool.GetStats()
}

// PooledShare is a poolable Share object
type PooledShare struct {
	ID          string
	JobID       string
	Nonce       uint64
	Hash        string
	Difficulty  float64
	Timestamp   time.Time
	IsBlock     bool
	Miner       string
	Height      uint64
	PrevHash    string
	BlockReward float64
}

// Reset implements PooledObject
func (ps *PooledShare) Reset() {
	ps.ID = ""
	ps.JobID = ""
	ps.Nonce = 0
	ps.Hash = ""
	ps.Difficulty = 0
	ps.Timestamp = time.Time{}
	ps.IsBlock = false
	ps.Miner = ""
	ps.Height = 0
	ps.PrevHash = ""
	ps.BlockReward = 0
}

// IsValid implements PooledObject
func (ps *PooledShare) IsValid() bool {
	return true
}

// MemoryManager provides centralized memory management
type MemoryManager struct {
	bufferPool     *BufferPool
	sharePool      *SharePool
	objectPools    map[string]*ObjectPool
	memStats       runtime.MemStats
	lastGC         time.Time
	gcInterval     time.Duration
	maxMemoryUsage uint64
	mu             sync.RWMutex
}

// NewMemoryManager creates a new memory manager
func NewMemoryManager(maxMemoryMB int) *MemoryManager {
	mm := &MemoryManager{
		bufferPool:     NewBufferPool(),
		sharePool:      NewSharePool(),
		objectPools:    make(map[string]*ObjectPool),
		gcInterval:     30 * time.Second,
		maxMemoryUsage: uint64(maxMemoryMB) * 1024 * 1024,
		lastGC:         time.Now(),
	}
	
	// Start memory monitor
	go mm.monitor()
	
	return mm
}

// GetBuffer retrieves a buffer from the pool
func (mm *MemoryManager) GetBuffer(size int) *Buffer {
	return mm.bufferPool.Get(size)
}

// GetShare retrieves a share from the pool
func (mm *MemoryManager) GetShare() *PooledShare {
	return mm.sharePool.Get()
}

// RegisterPool registers a custom object pool
func (mm *MemoryManager) RegisterPool(name string, factory func() interface{}) {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	
	mm.objectPools[name] = NewObjectPool(factory)
}

// Get retrieves an object from a named pool
func (mm *MemoryManager) Get(poolName string) (interface{}, error) {
	mm.mu.RLock()
	pool, exists := mm.objectPools[poolName]
	mm.mu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("pool %s not found", poolName)
	}
	
	return pool.Get(), nil
}

// Put returns an object to a named pool
func (mm *MemoryManager) Put(poolName string, obj interface{}) error {
	mm.mu.RLock()
	pool, exists := mm.objectPools[poolName]
	mm.mu.RUnlock()
	
	if !exists {
		return fmt.Errorf("pool %s not found", poolName)
	}
	
	pool.Put(obj)
	return nil
}

// GetStats returns memory statistics
func (mm *MemoryManager) GetStats() map[string]interface{} {
	runtime.ReadMemStats(&mm.memStats)
	
	stats := map[string]interface{}{
		"memory_alloc":      mm.memStats.Alloc,
		"memory_total":      mm.memStats.TotalAlloc,
		"memory_sys":        mm.memStats.Sys,
		"gc_count":          mm.memStats.NumGC,
		"goroutines":        runtime.NumGoroutine(),
		"buffer_pool_stats": mm.bufferPool.GetStats(),
		"share_pool_stats":  mm.sharePool.GetStats(),
	}
	
	// Add custom pool stats
	mm.mu.RLock()
	customStats := make(map[string]PoolStats)
	for name, pool := range mm.objectPools {
		customStats[name] = pool.GetStats()
	}
	mm.mu.RUnlock()
	
	stats["custom_pools"] = customStats
	
	return stats
}

// ForceGC forces garbage collection if needed
func (mm *MemoryManager) ForceGC() {
	runtime.ReadMemStats(&mm.memStats)
	
	// Check if we should run GC
	if mm.memStats.Alloc > mm.maxMemoryUsage ||
		time.Since(mm.lastGC) > mm.gcInterval {
		
		runtime.GC()
		mm.lastGC = time.Now()
	}
}

func (mm *MemoryManager) monitor() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		mm.ForceGC()
		
		// Log memory stats if usage is high
		runtime.ReadMemStats(&mm.memStats)
		if mm.memStats.Alloc > mm.maxMemoryUsage*8/10 { // 80% threshold
			fmt.Printf("High memory usage: %d MB / %d MB\n",
				mm.memStats.Alloc/1024/1024,
				mm.maxMemoryUsage/1024/1024)
		}
	}
}

// Global memory manager instance
var globalMemoryManager *MemoryManager
var initOnce sync.Once

// InitGlobalMemoryManager initializes the global memory manager
func InitGlobalMemoryManager(maxMemoryMB int) {
	initOnce.Do(func() {
		globalMemoryManager = NewMemoryManager(maxMemoryMB)
	})
}

// GetGlobalMemoryManager returns the global memory manager
func GetGlobalMemoryManager() *MemoryManager {
	if globalMemoryManager == nil {
		InitGlobalMemoryManager(1024) // Default 1GB
	}
	return globalMemoryManager
}

// Convenience functions

// GetBuffer gets a buffer from the global pool
func GetBuffer(size int) *Buffer {
	return GetGlobalMemoryManager().GetBuffer(size)
}

// GetShare gets a share from the global pool
func GetShare() *PooledShare {
	return GetGlobalMemoryManager().GetShare()
}

// RingBuffer provides a circular buffer implementation
type RingBuffer struct {
	data     []byte
	size     int
	head     int
	tail     int
	count    int
	mu       sync.Mutex
}

// NewRingBuffer creates a new ring buffer
func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		data: make([]byte, size),
		size: size,
	}
}

// Write writes data to the ring buffer
func (rb *RingBuffer) Write(data []byte) (int, error) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	
	if len(data) > rb.size-rb.count {
		return 0, fmt.Errorf("buffer full")
	}
	
	written := 0
	for _, b := range data {
		rb.data[rb.tail] = b
		rb.tail = (rb.tail + 1) % rb.size
		rb.count++
		written++
	}
	
	return written, nil
}

// Read reads data from the ring buffer
func (rb *RingBuffer) Read(p []byte) (int, error) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	
	if rb.count == 0 {
		return 0, fmt.Errorf("buffer empty")
	}
	
	read := 0
	for i := 0; i < len(p) && rb.count > 0; i++ {
		p[i] = rb.data[rb.head]
		rb.head = (rb.head + 1) % rb.size
		rb.count--
		read++
	}
	
	return read, nil
}

// Available returns the number of bytes available to read
func (rb *RingBuffer) Available() int {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.count
}

// Free returns the free space in the buffer
func (rb *RingBuffer) Free() int {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	return rb.size - rb.count
}

// Reset clears the ring buffer
func (rb *RingBuffer) Reset() {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.head = 0
	rb.tail = 0
	rb.count = 0
}
