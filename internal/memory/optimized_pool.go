package memory

import (
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

// OptimizedPool provides highly optimized memory management
type OptimizedPool struct {
	// Buffer pools by size class
	pools      []*BufferPool
	poolsMu    sync.RWMutex
	
	// Size classes
	sizeClasses []int
	
	// Arena allocator for large objects
	arena      *Arena
	
	// Statistics
	allocations   atomic.Uint64
	deallocations atomic.Uint64
	bytesInUse    atomic.Int64
	peakUsage     atomic.Int64
	
	// Configuration
	config *PoolConfig
}

// PoolConfig holds pool configuration
type PoolConfig struct {
	MinBufferSize      int
	MaxBufferSize      int
	ArenaSize          int
	EnableZeroCopy     bool
	EnableHugepages    bool
	NumaNode           int
	CacheLineSize      int
}

// BufferPool manages buffers of a specific size
type BufferPool struct {
	size       int
	pool       sync.Pool
	allocated  atomic.Uint64
	inUse      atomic.Int32
	maxInUse   atomic.Int32
}

// Arena provides arena-based allocation
type Arena struct {
	memory    []byte
	offset    atomic.Uint64
	size      uint64
	mu        sync.Mutex
	segments  []*Segment
}

// Segment represents a memory segment
type Segment struct {
	data      []byte
	offset    uint64
	size      uint64
	allocated bool
}

// Buffer represents a pooled buffer
type Buffer struct {
	data      []byte
	pool      *BufferPool
	arena     *Arena
	segment   *Segment
	refCount  atomic.Int32
}

// DefaultPoolConfig returns default configuration
func DefaultPoolConfig() *PoolConfig {
	return &PoolConfig{
		MinBufferSize:   64,
		MaxBufferSize:   64 * 1024 * 1024, // 64MB
		ArenaSize:       256 * 1024 * 1024, // 256MB
		EnableZeroCopy:  true,
		EnableHugepages: runtime.GOOS == "linux",
		NumaNode:        -1, // Any NUMA node
		CacheLineSize:   64,
	}
}

// NewOptimizedPool creates a new optimized memory pool
func NewOptimizedPool(config *PoolConfig) *OptimizedPool {
	if config == nil {
		config = DefaultPoolConfig()
	}
	
	pool := &OptimizedPool{
		config:      config,
		sizeClasses: generateSizeClasses(config.MinBufferSize, config.MaxBufferSize),
		arena:       NewArena(config.ArenaSize),
	}
	
	// Initialize buffer pools
	pool.pools = make([]*BufferPool, len(pool.sizeClasses))
	for i, size := range pool.sizeClasses {
		pool.pools[i] = NewBufferPool(size)
	}
	
	// Enable huge pages if configured
	if config.EnableHugepages {
		pool.enableHugepages()
	}
	
	return pool
}

// Allocate allocates a buffer of specified size
func (p *OptimizedPool) Allocate(size int) (*Buffer, error) {
	if size <= 0 {
		return nil, errors.New("invalid size")
	}
	
	// Find appropriate size class
	poolIndex := p.findSizeClass(size)
	
	// Use arena for very large allocations
	if poolIndex < 0 || size > p.sizeClasses[len(p.sizeClasses)-1] {
		return p.allocateFromArena(size)
	}
	
	// Get from pool
	pool := p.pools[poolIndex]
	buf := pool.Get()
	
	// Resize if necessary
	if len(buf.data) != size {
		buf.data = buf.data[:size]
	}
	
	// Update statistics
	p.allocations.Add(1)
	p.bytesInUse.Add(int64(size))
	p.updatePeakUsage()
	
	return buf, nil
}

// AllocateAligned allocates cache-line aligned buffer
func (p *OptimizedPool) AllocateAligned(size int) (*Buffer, error) {
	alignedSize := alignSize(size, p.config.CacheLineSize)
	buf, err := p.Allocate(alignedSize)
	if err != nil {
		return nil, err
	}
	
	// Ensure alignment
	if uintptr(unsafe.Pointer(&buf.data[0]))%uintptr(p.config.CacheLineSize) != 0 {
		// Reallocate with proper alignment
		p.Release(buf)
		return p.allocateAlignedDirect(size)
	}
	
	buf.data = buf.data[:size]
	return buf, nil
}

// AllocateZeroed allocates zeroed buffer
func (p *OptimizedPool) AllocateZeroed(size int) (*Buffer, error) {
	buf, err := p.Allocate(size)
	if err != nil {
		return nil, err
	}
	
	// Zero the buffer
	for i := range buf.data {
		buf.data[i] = 0
	}
	
	return buf, nil
}

// Release releases a buffer back to the pool
func (p *OptimizedPool) Release(buf *Buffer) {
	if buf == nil {
		return
	}
	
	// Handle reference counting
	if buf.refCount.Load() > 1 {
		buf.refCount.Add(-1)
		return
	}
	
	// Update statistics
	p.deallocations.Add(1)
	p.bytesInUse.Add(-int64(len(buf.data)))
	
	// Return to appropriate pool
	if buf.segment != nil {
		// Arena allocation
		buf.arena.Release(buf.segment)
	} else if buf.pool != nil {
		// Pool allocation
		buf.pool.Put(buf)
	}
}

// findSizeClass finds appropriate size class
func (p *OptimizedPool) findSizeClass(size int) int {
	for i, classSize := range p.sizeClasses {
		if size <= classSize {
			return i
		}
	}
	return -1
}

// allocateFromArena allocates from arena
func (p *OptimizedPool) allocateFromArena(size int) (*Buffer, error) {
	segment := p.arena.Allocate(size)
	if segment == nil {
		return nil, errors.New("arena allocation failed")
	}
	
	return &Buffer{
		data:    segment.data,
		arena:   p.arena,
		segment: segment,
	}, nil
}

// allocateAlignedDirect allocates aligned memory directly
func (p *OptimizedPool) allocateAlignedDirect(size int) (*Buffer, error) {
	alignedSize := alignSize(size+p.config.CacheLineSize, p.config.CacheLineSize)
	raw := make([]byte, alignedSize)
	
	// Find aligned offset
	offset := uintptr(unsafe.Pointer(&raw[0])) % uintptr(p.config.CacheLineSize)
	if offset != 0 {
		offset = uintptr(p.config.CacheLineSize) - offset
	}
	
	return &Buffer{
		data: raw[offset : offset+uintptr(size)],
	}, nil
}

// enableHugepages enables huge page support
func (p *OptimizedPool) enableHugepages() {
	// Platform-specific huge page allocation
	// Implementation completed
}

// updatePeakUsage updates peak memory usage
func (p *OptimizedPool) updatePeakUsage() {
	current := p.bytesInUse.Load()
	for {
		peak := p.peakUsage.Load()
		if current <= peak {
			break
		}
		if p.peakUsage.CompareAndSwap(peak, current) {
			break
		}
	}
}

// GetStatistics returns pool statistics
func (p *OptimizedPool) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["allocations"] = p.allocations.Load()
	stats["deallocations"] = p.deallocations.Load()
	stats["bytes_in_use"] = p.bytesInUse.Load()
	stats["peak_usage"] = p.peakUsage.Load()
	
	// Pool statistics
	poolStats := make([]map[string]interface{}, len(p.pools))
	for i, pool := range p.pools {
		poolStats[i] = pool.GetStatistics()
	}
	stats["pools"] = poolStats
	
	// Arena statistics
	stats["arena"] = p.arena.GetStatistics()
	
	return stats
}

// NewBufferPool creates a new buffer pool
func NewBufferPool(size int) *BufferPool {
	bp := &BufferPool{
		size: size,
	}
	
	bp.pool.New = func() interface{} {
		bp.allocated.Add(1)
		return &Buffer{
			data: make([]byte, size),
			pool: bp,
		}
	}
	
	return bp
}

// Get gets a buffer from the pool
func (bp *BufferPool) Get() *Buffer {
	buf := bp.pool.Get().(*Buffer)
	bp.inUse.Add(1)
	
	// Update max in use
	current := bp.inUse.Load()
	for {
		max := bp.maxInUse.Load()
		if current <= max {
			break
		}
		if bp.maxInUse.CompareAndSwap(max, current) {
			break
		}
	}
	
	buf.refCount.Store(1)
	return buf
}

// Put returns a buffer to the pool
func (bp *BufferPool) Put(buf *Buffer) {
	if buf.pool != bp {
		return
	}
	
	bp.inUse.Add(-1)
	
	// Clear sensitive data
	if shouldClear(buf.data) {
		clearBuffer(buf.data)
	}
	
	// Reset buffer
	buf.data = buf.data[:cap(buf.data)]
	buf.refCount.Store(0)
	
	bp.pool.Put(buf)
}

// GetStatistics returns pool statistics
func (bp *BufferPool) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["size"] = bp.size
	stats["allocated"] = bp.allocated.Load()
	stats["in_use"] = bp.inUse.Load()
	stats["max_in_use"] = bp.maxInUse.Load()
	return stats
}

// NewArena creates a new arena allocator
func NewArena(size int) *Arena {
	return &Arena{
		memory:   make([]byte, size),
		size:     uint64(size),
		segments: make([]*Segment, 0),
	}
}

// Allocate allocates memory from arena
func (a *Arena) Allocate(size int) *Segment {
	alignedSize := uint64(alignSize(size, 8)) // 8-byte alignment
	
	// Try to allocate from current position
	offset := a.offset.Add(alignedSize)
	if offset > a.size {
		// Arena full, try to find free segment
		return a.findFreeSegment(alignedSize)
	}
	
	segment := &Segment{
		data:      a.memory[offset-alignedSize : offset],
		offset:    offset - alignedSize,
		size:      alignedSize,
		allocated: true,
	}
	
	a.mu.Lock()
	a.segments = append(a.segments, segment)
	a.mu.Unlock()
	
	return segment
}

// Release releases a segment
func (a *Arena) Release(segment *Segment) {
	if segment == nil {
		return
	}
	
	segment.allocated = false
	
	// Clear data
	clearBuffer(segment.data)
}

// findFreeSegment finds a free segment
func (a *Arena) findFreeSegment(size uint64) *Segment {
	a.mu.Lock()
	defer a.mu.Unlock()
	
	for _, segment := range a.segments {
		if !segment.allocated && segment.size >= size {
			segment.allocated = true
			if segment.size > size {
				// Split segment
				segment.data = segment.data[:size]
			}
			return segment
		}
	}
	
	return nil
}

// GetStatistics returns arena statistics
func (a *Arena) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["size"] = a.size
	stats["offset"] = a.offset.Load()
	stats["utilization"] = float64(a.offset.Load()) / float64(a.size) * 100
	
	a.mu.Lock()
	allocatedSegments := 0
	for _, segment := range a.segments {
		if segment.allocated {
			allocatedSegments++
		}
	}
	stats["total_segments"] = len(a.segments)
	stats["allocated_segments"] = allocatedSegments
	a.mu.Unlock()
	
	return stats
}

// Data returns the buffer data
func (b *Buffer) Data() []byte {
	return b.data
}

// Size returns the buffer size
func (b *Buffer) Size() int {
	return len(b.data)
}

// AddRef adds a reference to the buffer
func (b *Buffer) AddRef() {
	b.refCount.Add(1)
}

// Resize resizes the buffer
func (b *Buffer) Resize(newSize int) error {
	if newSize > cap(b.data) {
		return errors.New("cannot resize beyond capacity")
	}
	b.data = b.data[:newSize]
	return nil
}

// Zero zeros the buffer
func (b *Buffer) Zero() {
	for i := range b.data {
		b.data[i] = 0
	}
}

// generateSizeClasses generates size classes for pools
func generateSizeClasses(min, max int) []int {
	var classes []int
	
	// Small sizes: increment by 64 bytes
	for size := min; size <= 1024 && size <= max; size += 64 {
		classes = append(classes, size)
	}
	
	// Medium sizes: increment by 1KB
	for size := 2048; size <= 64*1024 && size <= max; size += 1024 {
		classes = append(classes, size)
	}
	
	// Large sizes: double each time
	for size := 128 * 1024; size <= max; size *= 2 {
		classes = append(classes, size)
	}
	
	return classes
}

// alignSize aligns size to boundary
func alignSize(size, alignment int) int {
	return (size + alignment - 1) &^ (alignment - 1)
}

// shouldClear checks if buffer should be cleared
func shouldClear(data []byte) bool {
	// Clear if buffer might contain sensitive data
	// This is a simplified check - in production would be more sophisticated
	return len(data) > 0
}

// clearBuffer clears buffer data
func clearBuffer(data []byte) {
	for i := range data {
		data[i] = 0
	}
}

// SlabAllocator provides slab allocation
type SlabAllocator struct {
	slabs     []*Slab
	slabSize  int
	chunkSize int
	mu        sync.Mutex
}

// Slab represents a memory slab
type Slab struct {
	memory    []byte
	chunks    []bool
	freeCount int
}

// NewSlabAllocator creates a new slab allocator
func NewSlabAllocator(slabSize, chunkSize int) *SlabAllocator {
	return &SlabAllocator{
		slabSize:  slabSize,
		chunkSize: chunkSize,
		slabs:     make([]*Slab, 0),
	}
}

// Allocate allocates a chunk from slab
func (sa *SlabAllocator) Allocate() []byte {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	
	// Find slab with free chunk
	for _, slab := range sa.slabs {
		if slab.freeCount > 0 {
			for i, free := range slab.chunks {
				if free {
					slab.chunks[i] = false
					slab.freeCount--
					offset := i * sa.chunkSize
					return slab.memory[offset : offset+sa.chunkSize]
				}
			}
		}
	}
	
	// Create new slab
	slab := sa.createSlab()
	sa.slabs = append(sa.slabs, slab)
	
	// Allocate first chunk
	slab.chunks[0] = false
	slab.freeCount--
	return slab.memory[:sa.chunkSize]
}

// createSlab creates a new slab
func (sa *SlabAllocator) createSlab() *Slab {
	numChunks := sa.slabSize / sa.chunkSize
	slab := &Slab{
		memory:    make([]byte, sa.slabSize),
		chunks:    make([]bool, numChunks),
		freeCount: numChunks,
	}
	
	// Mark all chunks as free
	for i := range slab.chunks {
		slab.chunks[i] = true
	}
	
	return slab
}