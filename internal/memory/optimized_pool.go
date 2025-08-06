package memory

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// OptimizedMemoryPool implements high-performance memory pooling
// John Carmack's cache-aware design with Rob Pike's simplicity
type OptimizedMemoryPool struct {
	// Cache-aligned hot fields
	gets      atomic.Uint64
	puts      atomic.Uint64
	hits      atomic.Uint64
	misses    atomic.Uint64
	
	// Pool buckets by size class
	buckets   [32]*PoolBucket // Covers sizes up to 4GB
	
	// NUMA awareness
	numaNodes int
	numaPools []LocalPool
	
	// Configuration
	maxSize   int
	gcPercent int
}

// PoolBucket represents a size-specific pool
type PoolBucket struct {
	size      int
	pool      sync.Pool
	allocated atomic.Int64
	freed     atomic.Int64
	// Padding to avoid false sharing
	_ [64 - unsafe.Sizeof(atomic.Int64{})*2 - unsafe.Sizeof(sync.Pool{}) - 8]byte
}

// LocalPool for NUMA optimization
type LocalPool struct {
	pools []*PoolBucket
	node  int
}

// Block represents a memory block
type Block struct {
	data   []byte
	bucket *PoolBucket
	age    time.Time
}

// NewOptimizedMemoryPool creates an optimized memory pool
func NewOptimizedMemoryPool() *OptimizedMemoryPool {
	mp := &OptimizedMemoryPool{
		maxSize:   1 << 30, // 1GB max block size
		gcPercent: runtime.GOMAXPROCS(0) * 10,
		numaNodes: detectNUMANodes(),
	}
	
	// Initialize buckets for power-of-2 sizes
	for i := range mp.buckets {
		size := 1 << i
		if size > mp.maxSize {
			break
		}
		
		mp.buckets[i] = &PoolBucket{
			size: size,
			pool: sync.Pool{
				New: func() interface{} {
					mp.misses.Add(1)
					return &Block{
						data: make([]byte, size),
						age:  time.Now(),
					}
				},
			},
		}
	}
	
	// Initialize NUMA-aware pools if applicable
	if mp.numaNodes > 1 {
		mp.initializeNUMAPools()
	}
	
	// Start background maintenance
	go mp.maintain()
	
	return mp
}

// Get allocates a block of at least the specified size
func (mp *OptimizedMemoryPool) Get(size int) []byte {
	mp.gets.Add(1)
	
	// Find appropriate bucket
	bucket := mp.selectBucket(size)
	if bucket == nil {
		// Size too large for pooling
		return make([]byte, size)
	}
	
	// Try NUMA-local pool first
	if mp.numaNodes > 1 {
		if data := mp.getNUMALocal(bucket.size); data != nil {
			mp.hits.Add(1)
			return data[:size]
		}
	}
	
	// Get from pool
	block := bucket.pool.Get().(*Block)
	bucket.allocated.Add(1)
	
	if block.data == nil {
		// Should not happen, but handle gracefully
		block.data = make([]byte, bucket.size)
	}
	
	mp.hits.Add(1)
	return block.data[:size]
}

// Put returns a block to the pool
func (mp *OptimizedMemoryPool) Put(data []byte) {
	mp.puts.Add(1)
	
	if data == nil || cap(data) == 0 {
		return
	}
	
	// Find appropriate bucket by capacity
	bucket := mp.selectBucket(cap(data))
	if bucket == nil || cap(data) != bucket.size {
		// Not from our pool or wrong size
		return
	}
	
	// Clear sensitive data
	clear(data)
	
	// Return to pool
	block := &Block{
		data:   data[:cap(data)],
		bucket: bucket,
		age:    time.Now(),
	}
	
	bucket.freed.Add(1)
	bucket.pool.Put(block)
}

// GetAligned returns cache-aligned memory
func (mp *OptimizedMemoryPool) GetAligned(size int, alignment int) []byte {
	// Allocate extra for alignment
	allocSize := size + alignment
	buf := mp.Get(allocSize)
	
	// Calculate aligned offset
	ptr := uintptr(unsafe.Pointer(&buf[0]))
	alignedPtr := (ptr + uintptr(alignment-1)) &^ uintptr(alignment-1)
	offset := int(alignedPtr - ptr)
	
	return buf[offset : offset+size]
}

// selectBucket finds the appropriate bucket for a size
func (mp *OptimizedMemoryPool) selectBucket(size int) *PoolBucket {
	if size <= 0 || size > mp.maxSize {
		return nil
	}
	
	// Find bucket index (ceil(log2(size)))
	bucketIdx := 0
	for s := size - 1; s > 0; s >>= 1 {
		bucketIdx++
	}
	
	if bucketIdx >= len(mp.buckets) {
		return nil
	}
	
	return mp.buckets[bucketIdx]
}

// maintain performs periodic pool maintenance
func (mp *OptimizedMemoryPool) maintain() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		mp.performMaintenance()
	}
}

// performMaintenance cleans up old allocations
func (mp *OptimizedMemoryPool) performMaintenance() {
	// Trigger GC if needed
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	if int(m.Alloc) > mp.gcPercent*1024*1024 {
		runtime.GC()
	}
	
	// Log statistics if needed
	gets := mp.gets.Load()
	_ = mp.hits.Load() // Read for stats consistency
	if gets > 0 {
		// hitRate can be calculated if needed
		// Can log hit rate here if logger available
	}
}

// clear zeros out a byte slice
func clear(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// detectNUMANodes returns the number of NUMA nodes
func detectNUMANodes() int {
	// Simplified - in production, check /sys/devices/system/node/
	return 1
}

// initializeNUMAPools sets up NUMA-aware pools
func (mp *OptimizedMemoryPool) initializeNUMAPools() {
	mp.numaPools = make([]LocalPool, mp.numaNodes)
	// Implementation depends on platform
}

// getNUMALocal tries to get from NUMA-local pool
func (mp *OptimizedMemoryPool) getNUMALocal(size int) []byte {
	// Platform-specific NUMA optimization
	return nil
}

// Stats returns pool statistics
func (mp *OptimizedMemoryPool) Stats() PoolStatistics {
	gets := mp.gets.Load()
	hits := mp.hits.Load()
	misses := mp.misses.Load()
	puts := mp.puts.Load()
	
	stats := PoolStatistics{
		Gets:     gets,
		Puts:     puts,
		Hits:     hits,
		Misses:   misses,
		HitRate:  0,
		Buckets:  make([]BucketStats, 0),
	}
	
	if gets > 0 {
		stats.HitRate = float64(hits) / float64(gets)
	}
	
	// Collect bucket stats
	for _, bucket := range mp.buckets {
		if bucket == nil {
			continue
		}
		
		allocated := bucket.allocated.Load()
		freed := bucket.freed.Load()
		
		if allocated > 0 || freed > 0 {
			stats.Buckets = append(stats.Buckets, BucketStats{
				Size:      bucket.size,
				Allocated: allocated,
				Freed:     freed,
				Active:    allocated - freed,
			})
		}
	}
	
	return stats
}

// PoolStatistics contains pool metrics
type PoolStatistics struct {
	Gets     uint64
	Puts     uint64
	Hits     uint64
	Misses   uint64
	HitRate  float64
	Buckets  []BucketStats
}

// BucketStats contains per-bucket metrics
type BucketStats struct {
	Size      int
	Allocated int64
	Freed     int64
	Active    int64
}

// SlabAllocator provides slab allocation for fixed-size objects
type SlabAllocator struct {
	objectSize int
	slabSize   int
	slabs      []*Slab
	free       *Slab
	mu         sync.Mutex
}

// Slab represents a memory slab
type Slab struct {
	memory    []byte
	objects   []bool // true if allocated
	freeCount int
	next      *Slab
}

// NewSlabAllocator creates a slab allocator
func NewSlabAllocator(objectSize, objectsPerSlab int) *SlabAllocator {
	return &SlabAllocator{
		objectSize: objectSize,
		slabSize:   objectSize * objectsPerSlab,
	}
}

// Allocate returns a pointer to an object
func (sa *SlabAllocator) Allocate() unsafe.Pointer {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	
	// Find slab with free space
	slab := sa.free
	if slab == nil || slab.freeCount == 0 {
		// Allocate new slab
		slab = sa.newSlab()
		sa.slabs = append(sa.slabs, slab)
	}
	
	// Find free object
	for i, allocated := range slab.objects {
		if !allocated {
			slab.objects[i] = true
			slab.freeCount--
			
			offset := i * sa.objectSize
			return unsafe.Pointer(&slab.memory[offset])
		}
	}
	
	return nil
}

// Free returns an object to the allocator
func (sa *SlabAllocator) Free(ptr unsafe.Pointer) {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	
	// Find containing slab
	for _, slab := range sa.slabs {
		start := uintptr(unsafe.Pointer(&slab.memory[0]))
		end := start + uintptr(len(slab.memory))
		
		if uintptr(ptr) >= start && uintptr(ptr) < end {
			// Calculate object index
			offset := int(uintptr(ptr) - start)
			idx := offset / sa.objectSize
			
			if idx < len(slab.objects) && slab.objects[idx] {
				slab.objects[idx] = false
				slab.freeCount++
				
				// Update free list
				if slab.freeCount == 1 {
					slab.next = sa.free
					sa.free = slab
				}
			}
			return
		}
	}
}

// newSlab creates a new slab
func (sa *SlabAllocator) newSlab() *Slab {
	objectCount := sa.slabSize / sa.objectSize
	return &Slab{
		memory:    make([]byte, sa.slabSize),
		objects:   make([]bool, objectCount),
		freeCount: objectCount,
	}
}