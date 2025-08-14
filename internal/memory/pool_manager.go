package memory

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// safeSubUint64 atomically subtracts delta from u without underflow.
// If delta > current value, it sets the value to 0.
func safeSubUint64(u *atomic.Uint64, delta uint64) {
	for {
		old := u.Load()
		if delta >= old {
			// Avoid underflow: clamp to zero
			if old == 0 {
				return
			}
			if u.CompareAndSwap(old, 0) {
				return
			}
			continue
		}
		if u.CompareAndSwap(old, old-delta) {
			return
		}
	}
}

// PoolManager provides centralized memory pool management for zero-allocation operations.
// Follows John Carmack's principle of minimizing allocations in hot paths.
type PoolManager struct {
	// Buffer pools of different sizes
	pools map[int]*BufferPool
	mu    sync.RWMutex
	
	// Statistics
	stats struct {
		allocations   atomic.Uint64
		deallocations atomic.Uint64
		inUse         atomic.Uint64
		totalSize     atomic.Uint64
		hitRate       atomic.Uint64
		missRate      atomic.Uint64
	}
	
	// Configuration
	maxPoolSize      int
	gcInterval       time.Duration
	preAllocateSizes []int
	
	// Cleanup
	stopGC chan struct{}
}

// BufferPool manages buffers of a specific size
type BufferPool struct {
	size     int
	pool     *sync.Pool
	inUse    atomic.Int32
	maxItems int
	
	// Statistics
	gets     atomic.Uint64
	puts     atomic.Uint64
	news     atomic.Uint64
}

// Buffer represents a reusable byte buffer
type Buffer struct {
	Data     []byte
	Size     int
	pool     *BufferPool
	refCount atomic.Int32
}

// Common buffer sizes for mining operations
var (
	BufferSize32     = 32
	BufferSize64     = 64
	BufferSize128    = 128
	BufferSize256    = 256
	BufferSize512    = 512
	BufferSize1K     = 1024
	BufferSize4K     = 4 * 1024
	BufferSize16K    = 16 * 1024
	BufferSize64K    = 64 * 1024
	BufferSize256K   = 256 * 1024
	BufferSize1M     = 1024 * 1024
	BufferSize4M     = 4 * 1024 * 1024
	BufferSize16M    = 16 * 1024 * 1024
)

// Global pool manager instance
var globalPoolManager *PoolManager
var once sync.Once

// GetGlobalPoolManager returns the global pool manager instance
func GetGlobalPoolManager() *PoolManager {
	once.Do(func() {
		globalPoolManager = NewPoolManager()
		globalPoolManager.Start()
	})
	return globalPoolManager
}

// NewPoolManager creates a new pool manager
func NewPoolManager() *PoolManager {
	pm := &PoolManager{
		pools:       make(map[int]*BufferPool),
		maxPoolSize: 1000,
		gcInterval:  30 * time.Second,
		preAllocateSizes: []int{
			BufferSize32,
			BufferSize64,
			BufferSize128,
			BufferSize256,
			BufferSize512,
			BufferSize1K,
			BufferSize4K,
			BufferSize16K,
			BufferSize64K,
			BufferSize256K,
			BufferSize1M,
		},
		stopGC: make(chan struct{}),
	}
	
	// Pre-create pools for common sizes
	for _, size := range pm.preAllocateSizes {
		pm.getOrCreatePool(size)
	}
	
	return pm
}

// Start starts the pool manager's background tasks
func (pm *PoolManager) Start() {
	go pm.gcLoop()
}

// Stop stops the pool manager
func (pm *PoolManager) Stop() {
	close(pm.stopGC)
}

// Get retrieves a buffer of at least the specified size
func (pm *PoolManager) Get(size int) *Buffer {
	// Round up to nearest power of 2 for better pool utilization
	poolSize := roundUpPowerOf2(size)
	
	// Get or create pool for this size
	pool := pm.getOrCreatePool(poolSize)
	
	// Get buffer from pool
	buf := pool.get()
	
	// Update statistics
	pm.stats.allocations.Add(1)
	pm.stats.inUse.Add(1)
	pm.stats.totalSize.Add(uint64(poolSize))
	
	return buf
}

// Put returns a buffer to the pool
func (pm *PoolManager) Put(buf *Buffer) {
	if buf == nil || buf.pool == nil {
		return
	}
	
	// Check reference count
	if buf.refCount.Add(-1) > 0 {
		return // Still in use
	}
	
	// Return to pool
	buf.pool.put(buf)
	
	// Update statistics
	pm.stats.deallocations.Add(1)
	safeSubUint64(&pm.stats.inUse, 1)
	safeSubUint64(&pm.stats.totalSize, uint64(buf.Size))
}

// GetMulti retrieves multiple buffers at once
func (pm *PoolManager) GetMulti(size, count int) []*Buffer {
	buffers := make([]*Buffer, count)
	for i := 0; i < count; i++ {
		buffers[i] = pm.Get(size)
	}
	return buffers
}

// PutMulti returns multiple buffers to the pool
func (pm *PoolManager) PutMulti(buffers []*Buffer) {
	for _, buf := range buffers {
		pm.Put(buf)
	}
}

// getOrCreatePool gets or creates a pool for the specified size
func (pm *PoolManager) getOrCreatePool(size int) *BufferPool {
	// Fast path: check if pool exists
	pm.mu.RLock()
	pool, exists := pm.pools[size]
	pm.mu.RUnlock()
	
	if exists {
		pm.stats.hitRate.Add(1)
		return pool
	}
	
	// Slow path: create new pool
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	// Double-check after acquiring write lock
	if pool, exists := pm.pools[size]; exists {
		pm.stats.hitRate.Add(1)
		return pool
	}
	
	pm.stats.missRate.Add(1)
	
	// Create new pool
	pool = &BufferPool{
		size:     size,
		maxItems: pm.maxPoolSize,
	}
	
	pool.pool = &sync.Pool{
		New: func() interface{} {
			pool.news.Add(1)
			return &Buffer{
				Data: make([]byte, size),
				Size: size,
				pool: pool,
			}
		},
	}
	
	pm.pools[size] = pool
	return pool
}

// gcLoop runs periodic garbage collection on pools
func (pm *PoolManager) gcLoop() {
	ticker := time.NewTicker(pm.gcInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-pm.stopGC:
			return
		case <-ticker.C:
			pm.gc()
		}
	}
}

// gc performs garbage collection on pools
func (pm *PoolManager) gc() {
	pm.mu.RLock()
	pools := make([]*BufferPool, 0, len(pm.pools))
	for _, pool := range pm.pools {
		pools = append(pools, pool)
	}
	pm.mu.RUnlock()
	
	// Force GC to release unused buffers
	runtime.GC()
	
	// Clean up pools with no active buffers
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	for size, pool := range pm.pools {
		if pool.inUse.Load() == 0 && pool.gets.Load() == pool.puts.Load() {
			// Pool is not in use, consider removing it
			if _, isPreAllocated := contains(pm.preAllocateSizes, size); !isPreAllocated {
				delete(pm.pools, size)
			}
		}
	}
}

// GetStats returns pool manager statistics
func (pm *PoolManager) GetStats() map[string]interface{} {
	pm.mu.RLock()
	poolCount := len(pm.pools)
	poolStats := make(map[int]map[string]uint64)
	for size, pool := range pm.pools {
		poolStats[size] = map[string]uint64{
			"gets":   pool.gets.Load(),
			"puts":   pool.puts.Load(),
			"news":   pool.news.Load(),
			"in_use": uint64(pool.inUse.Load()),
		}
	}
	pm.mu.RUnlock()
	
	return map[string]interface{}{
		"allocations":    pm.stats.allocations.Load(),
		"deallocations":  pm.stats.deallocations.Load(),
		"in_use":         pm.stats.inUse.Load(),
		"total_size":     pm.stats.totalSize.Load(),
		"hit_rate":       pm.stats.hitRate.Load(),
		"miss_rate":      pm.stats.missRate.Load(),
		"pool_count":     poolCount,
		"pools":          poolStats,
	}
}

// BufferPool methods

// get retrieves a buffer from the pool
func (bp *BufferPool) get() *Buffer {
	bp.gets.Add(1)
	bp.inUse.Add(1)
	
	buf := bp.pool.Get().(*Buffer)
	buf.refCount.Store(1)
	
	// Clear buffer for security
	clear(buf.Data)
	
	return buf
}

// put returns a buffer to the pool
func (bp *BufferPool) put(buf *Buffer) {
	bp.puts.Add(1)
	bp.inUse.Add(-1)
	
	// Clear sensitive data
	clear(buf.Data)
	
	// Return to pool if not at capacity
	if bp.inUse.Load() < int32(bp.maxItems) {
		bp.pool.Put(buf)
	}
}

// Buffer methods

// AddRef increments the reference count
func (b *Buffer) AddRef() {
	b.refCount.Add(1)
}

// Release decrements the reference count and returns to pool if zero
func (b *Buffer) Release() {
	if b.pool != nil {
		GetGlobalPoolManager().Put(b)
	}
}

// Resize resizes the buffer if needed
func (b *Buffer) Resize(newSize int) {
	if newSize > len(b.Data) {
		// Need a larger buffer
		newData := make([]byte, newSize)
		copy(newData, b.Data)
		b.Data = newData
		b.Size = newSize
	}
}

// Clone creates a copy of the buffer
func (b *Buffer) Clone() *Buffer {
	newBuf := GetGlobalPoolManager().Get(b.Size)
	copy(newBuf.Data, b.Data)
	return newBuf
}

// Zero-copy operations

// ZeroCopySlice creates a slice without allocation
func ZeroCopySlice(data []byte, start, end int) []byte {
	if start < 0 || end > len(data) || start > end {
		return nil
	}
	
	// Use unsafe to create slice without allocation
	return (*[1 << 30]byte)(unsafe.Pointer(&data[start]))[:end-start:end-start]
}

// ZeroCopyString converts bytes to string without allocation
func ZeroCopyString(b []byte) string {
	return *(*string)(unsafe.Pointer(&b))
}

// ZeroCopyBytes converts string to bytes without allocation
func ZeroCopyBytes(s string) []byte {
	return *(*[]byte)(unsafe.Pointer(&s))
}

// Specialized pools for mining

// SharePool manages Share objects
type SharePool struct {
	pool *sync.Pool
}

// NewSharePool creates a new share pool
func NewSharePool() *SharePool {
	return &SharePool{
		pool: &sync.Pool{
			New: func() interface{} {
				return &Share{}
			},
		},
	}
}

// Get retrieves a share from the pool
func (sp *SharePool) Get() *Share {
	return sp.pool.Get().(*Share)
}

// Put returns a share to the pool
func (sp *SharePool) Put(share *Share) {
	// Clear share data
	*share = Share{}
	sp.pool.Put(share)
}

// Share represents a mining share (placeholder)
type Share struct {
	JobID    [32]byte
	Nonce    uint64
	Hash     []byte
	Target   []byte
	MinerID  string
}

// JobPool manages Job objects
type JobPool struct {
	pool *sync.Pool
}

// NewJobPool creates a new job pool
func NewJobPool() *JobPool {
	return &JobPool{
		pool: &sync.Pool{
			New: func() interface{} {
				return &Job{
					Header: make([]byte, 80),
					Target: make([]byte, 32),
				}
			},
		},
	}
}

// Get retrieves a job from the pool
func (jp *JobPool) Get() *Job {
	return jp.pool.Get().(*Job)
}

// Put returns a job to the pool
func (jp *JobPool) Put(job *Job) {
	// Clear job data
	clear(job.Header)
	clear(job.Target)
	job.JobID = ""
	job.Height = 0
	job.Difficulty = 0
	jp.pool.Put(job)
}

// Job represents a mining job (placeholder)
type Job struct {
	JobID      string
	Header     []byte
	Target     []byte
	Height     uint64
	Difficulty float64
}

// Helper functions

// roundUpPowerOf2 rounds up to the nearest power of 2
func roundUpPowerOf2(n int) int {
	if n <= 0 {
		return 1
	}
	
	// Check if already power of 2
	if n&(n-1) == 0 {
		return n
	}
	
	// Round up
	power := 1
	for power < n {
		power <<= 1
	}
	
	return power
}

// contains checks if a slice contains a value
func contains(slice []int, value int) (int, bool) {
	for i, v := range slice {
		if v == value {
			return i, true
		}
	}
	return -1, false
}


// RingBuffer provides a lock-free ring buffer for high-performance scenarios
type RingBuffer struct {
	buffer   []unsafe.Pointer
	capacity uint64
	mask     uint64
	head     atomic.Uint64
	tail     atomic.Uint64
}

// NewRingBuffer creates a new ring buffer
func NewRingBuffer(capacity int) *RingBuffer {
	// Round up to power of 2
	cap := uint64(roundUpPowerOf2(capacity))
	
	return &RingBuffer{
		buffer:   make([]unsafe.Pointer, cap),
		capacity: cap,
		mask:     cap - 1,
	}
}

// Put adds an item to the ring buffer
func (rb *RingBuffer) Put(item unsafe.Pointer) bool {
	head := rb.head.Load()
	tail := rb.tail.Load()
	
	// Check if full
	if head-tail >= rb.capacity {
		return false
	}
	
	// Add item
	rb.buffer[head&rb.mask] = item
	rb.head.Add(1)
	
	return true
}

// Get retrieves an item from the ring buffer
func (rb *RingBuffer) Get() unsafe.Pointer {
	tail := rb.tail.Load()
	head := rb.head.Load()
	
	// Check if empty
	if tail >= head {
		return nil
	}
	
	// Get item
	item := rb.buffer[tail&rb.mask]
	rb.tail.Add(1)
	
	return item
}

// Size returns the current size of the ring buffer
func (rb *RingBuffer) Size() int {
	return int(rb.head.Load() - rb.tail.Load())
}

// IsEmpty checks if the ring buffer is empty
func (rb *RingBuffer) IsEmpty() bool {
	return rb.head.Load() == rb.tail.Load()
}

// IsFull checks if the ring buffer is full
func (rb *RingBuffer) IsFull() bool {
	return rb.head.Load()-rb.tail.Load() >= rb.capacity
}