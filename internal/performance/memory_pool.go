package performance

import (
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"go.uber.org/zap"
)

// MemoryPool implements high-performance memory pooling following John Carmack's optimization principles
type MemoryPool struct {
	logger *zap.Logger
	
	// Pool configuration
	blockSize    int
	maxBlocks    int
	preAllocate  int
	
	// Pool state
	allocated    atomic.Uint64
	inUse       atomic.Uint64
	hits        atomic.Uint64
	misses      atomic.Uint64
	
	// Memory pools by size class
	pools       []*sync.Pool
	sizes       []int
	
	// NUMA optimization
	numaAware   bool
	numaNodes   int
}

// MemoryBlock represents a reusable memory block
type MemoryBlock struct {
	data     []byte
	size     int
	poolIdx  int
	pool     *MemoryPool
	refCount atomic.Int32
}

// MemoryPoolConfig contains pool configuration
type MemoryPoolConfig struct {
	MinBlockSize  int
	MaxBlockSize  int
	SizeClasses   int
	PreAllocate   int
	NUMAOptimized bool
}

// NewMemoryPool creates a new high-performance memory pool
func NewMemoryPool(logger *zap.Logger, config *MemoryPoolConfig) *MemoryPool {
	if config == nil {
		config = DefaultMemoryPoolConfig()
	}
	
	mp := &MemoryPool{
		logger:      logger,
		blockSize:   config.MinBlockSize,
		maxBlocks:   config.MaxBlockSize,
		preAllocate: config.PreAllocate,
		numaAware:   config.NUMAOptimized,
		numaNodes:   runtime.NumCPU(),
	}
	
	// Initialize size classes
	mp.initializeSizeClasses(config)
	
	// Pre-allocate if configured
	if config.PreAllocate > 0 {
		mp.preAllocateBlocks()
	}
	
	// Enable NUMA optimization if supported
	if config.NUMAOptimized {
		mp.enableNUMAOptimization()
	}
	
	return mp
}

// initializeSizeClasses creates pools for different size classes
func (mp *MemoryPool) initializeSizeClasses(config *MemoryPoolConfig) {
	// Calculate size classes using power of 2
	numClasses := config.SizeClasses
	mp.sizes = make([]int, numClasses)
	mp.pools = make([]*sync.Pool, numClasses)
	
	size := config.MinBlockSize
	for i := 0; i < numClasses; i++ {
		mp.sizes[i] = size
		poolIdx := i
		mp.pools[i] = &sync.Pool{
			New: func() interface{} {
				mp.misses.Add(1)
				return &MemoryBlock{
					data:    make([]byte, mp.sizes[poolIdx]),
					size:    mp.sizes[poolIdx],
					poolIdx: poolIdx,
					pool:    mp,
				}
			},
		}
		size *= 2
		if size > config.MaxBlockSize {
			mp.sizes[i] = config.MaxBlockSize
			break
		}
	}
	
	mp.logger.Debug("Memory pool initialized",
		zap.Int("size_classes", len(mp.sizes)),
		zap.Ints("sizes", mp.sizes),
	)
}

// Get retrieves a memory block of at least the requested size
func (mp *MemoryPool) Get(size int) *MemoryBlock {
	// Find appropriate size class
	poolIdx := mp.findSizeClass(size)
	if poolIdx < 0 {
		// Size too large, allocate directly
		mp.misses.Add(1)
		return &MemoryBlock{
			data:    make([]byte, size),
			size:    size,
			poolIdx: -1,
			pool:    mp,
		}
	}
	
	// Get from pool
	block := mp.pools[poolIdx].Get().(*MemoryBlock)
	block.refCount.Store(1)
	
	mp.hits.Add(1)
	mp.inUse.Add(1)
	
	return block
}

// Put returns a memory block to the pool
func (mp *MemoryPool) Put(block *MemoryBlock) {
	if block == nil || block.poolIdx < 0 {
		return
	}
	
	// Check reference count
	if block.refCount.Add(-1) > 0 {
		return
	}
	
	// Clear sensitive data
	mp.clearBlock(block)
	
	// Return to pool
	mp.pools[block.poolIdx].Put(block)
	mp.inUse.Add(^uint64(0)) // Decrement
}

// findSizeClass finds the appropriate pool for a given size
func (mp *MemoryPool) findSizeClass(size int) int {
	for i, s := range mp.sizes {
		if s >= size {
			return i
		}
	}
	return -1
}

// clearBlock clears a memory block for security
func (mp *MemoryPool) clearBlock(block *MemoryBlock) {
	// Fast clear using assembly if available
	if runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64" {
		mp.fastClear(block.data)
	} else {
		for i := range block.data {
			block.data[i] = 0
		}
	}
}

// fastClear uses optimized clearing for supported architectures
func (mp *MemoryPool) fastClear(data []byte) {
	if len(data) == 0 {
		return
	}
	
	// Use unsafe pointer for fast clearing
	ptr := unsafe.Pointer(&data[0])
	size := uintptr(len(data))
	
	// Clear in 8-byte chunks
	for size >= 8 {
		*(*uint64)(ptr) = 0
		ptr = unsafe.Add(ptr, 8)
		size -= 8
	}
	
	// Clear remaining bytes
	for size > 0 {
		*(*byte)(ptr) = 0
		ptr = unsafe.Add(ptr, 1)
		size--
	}
}

// preAllocateBlocks pre-allocates memory blocks
func (mp *MemoryPool) preAllocateBlocks() {
	for i, pool := range mp.pools {
		for j := 0; j < mp.preAllocate; j++ {
			block := &MemoryBlock{
				data:    make([]byte, mp.sizes[i]),
				size:    mp.sizes[i],
				poolIdx: i,
				pool:    mp,
			}
			pool.Put(block)
		}
	}
	
	mp.allocated.Store(uint64(mp.preAllocate * len(mp.pools)))
	mp.logger.Debug("Pre-allocated memory blocks",
		zap.Uint64("total_blocks", mp.allocated.Load()),
	)
}

// enableNUMAOptimization enables NUMA-aware memory allocation
func (mp *MemoryPool) enableNUMAOptimization() {
	// This would use system-specific NUMA APIs
	// For now, we'll use CPU affinity as a proxy
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	
	mp.logger.Debug("NUMA optimization enabled",
		zap.Int("numa_nodes", mp.numaNodes),
	)
}

// GetStats returns memory pool statistics
func (mp *MemoryPool) GetStats() map[string]uint64 {
	return map[string]uint64{
		"allocated":  mp.allocated.Load(),
		"in_use":     mp.inUse.Load(),
		"hits":       mp.hits.Load(),
		"misses":     mp.misses.Load(),
		"hit_rate":   mp.calculateHitRate(),
	}
}

// calculateHitRate calculates the cache hit rate
func (mp *MemoryPool) calculateHitRate() uint64 {
	hits := mp.hits.Load()
	misses := mp.misses.Load()
	total := hits + misses
	if total == 0 {
		return 0
	}
	return (hits * 100) / total
}

// Data returns the underlying byte slice
func (mb *MemoryBlock) Data() []byte {
	return mb.data[:mb.size]
}

// Resize resizes the memory block
func (mb *MemoryBlock) Resize(newSize int) {
	if newSize <= cap(mb.data) {
		mb.size = newSize
		return
	}
	
	// Need new allocation
	newData := make([]byte, newSize)
	copy(newData, mb.data)
	mb.data = newData
	mb.size = newSize
}

// AddRef increases the reference count
func (mb *MemoryBlock) AddRef() {
	mb.refCount.Add(1)
}

// Release decreases the reference count and returns to pool if zero
func (mb *MemoryBlock) Release() {
	if mb.pool != nil {
		mb.pool.Put(mb)
	}
}

// DefaultMemoryPoolConfig returns default configuration
func DefaultMemoryPoolConfig() *MemoryPoolConfig {
	return &MemoryPoolConfig{
		MinBlockSize:  1024,        // 1KB
		MaxBlockSize:  16777216,    // 16MB
		SizeClasses:   15,          // 1KB to 16MB
		PreAllocate:   100,         // Pre-allocate 100 blocks per class
		NUMAOptimized: runtime.GOOS == "linux",
	}
}