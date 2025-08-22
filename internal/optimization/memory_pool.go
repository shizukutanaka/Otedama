package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

// MemoryPool provides zero-allocation memory management
type MemoryPool struct {
	pools    []*sync.Pool
	sizes    []int
	stats    *PoolStats
	maxSize  int
	useHugePages bool
}

// PoolStats tracks memory pool statistics
type PoolStats struct {
	Allocations   uint64
	Deallocations uint64
	Reuses        uint64
	TotalBytes    uint64
	ActiveBytes   uint64
}

// Buffer represents a pooled buffer
type Buffer struct {
	data     []byte
	pool     *sync.Pool
	refCount int32
}

// NewMemoryPool creates an optimized memory pool
func NewMemoryPool(useHugePages bool) *MemoryPool {
	// Common buffer sizes for mining operations
	sizes := []int{
		32,     // Hashes
		64,     // Extended hashes
		80,     // Block headers
		256,    // Small messages
		512,    // Medium messages
		1024,   // Network packets
		4096,   // Page size
		8192,   // Large buffers
		16384,  // Extra large
		32768,  // Jumbo
		65536,  // Max single allocation
		131072, // Huge pages
		262144, // Large huge pages
	}

	mp := &MemoryPool{
		pools:        make([]*sync.Pool, len(sizes)),
		sizes:        sizes,
		stats:        &PoolStats{},
		maxSize:      sizes[len(sizes)-1],
		useHugePages: useHugePages,
	}

	// Initialize pools with size-specific allocators
	for i, size := range sizes {
		size := size // Capture for closure
		mp.pools[i] = &sync.Pool{
			New: func() interface{} {
				atomic.AddUint64(&mp.stats.Allocations, 1)
				atomic.AddUint64(&mp.stats.TotalBytes, uint64(size))
				
				// Allocate aligned memory for better CPU cache performance
				if mp.useHugePages && size >= 2097152 {
					return mp.allocateHugePage(size)
				}
				return mp.allocateAligned(size)
			},
		}
	}

	// Configure runtime for better memory performance
	runtime.GOMAXPROCS(runtime.NumCPU())
	runtime.GC() // Force initial GC to clean up

	return mp
}

// Get retrieves a buffer of at least the specified size
func (mp *MemoryPool) Get(size int) *Buffer {
	if size <= 0 {
		return &Buffer{data: []byte{}}
	}

	if size > mp.maxSize {
		// Allocate directly for very large sizes
		atomic.AddUint64(&mp.stats.Allocations, 1)
		atomic.AddUint64(&mp.stats.TotalBytes, uint64(size))
		return &Buffer{
			data: make([]byte, size),
			pool: nil,
		}
	}

	// Find the appropriate pool
	poolIndex := mp.findPoolIndex(size)
	pool := mp.pools[poolIndex]
	
	// Get buffer from pool
	buf := pool.Get().([]byte)
	atomic.AddUint64(&mp.stats.Reuses, 1)
	atomic.AddUint64(&mp.stats.ActiveBytes, uint64(len(buf)))

	return &Buffer{
		data:     buf[:size],
		pool:     pool,
		refCount: 1,
	}
}

// Put returns a buffer to the pool
func (mp *MemoryPool) Put(buf *Buffer) {
	if buf == nil || buf.pool == nil {
		return
	}

	// Decrement reference count
	if atomic.AddInt32(&buf.refCount, -1) > 0 {
		return // Still referenced
	}

	atomic.AddUint64(&mp.stats.Deallocations, 1)
	atomic.AddUint64(&mp.stats.ActiveBytes, ^uint64(len(buf.data)-1))

	// Zero sensitive data before returning to pool
	mp.zeroMemory(buf.data)

	// Reset slice to full capacity
	buf.data = buf.data[:cap(buf.data)]
	buf.pool.Put(buf.data)
}

// GetAligned gets an aligned buffer for SIMD operations
func (mp *MemoryPool) GetAligned(size int, alignment int) *Buffer {
	// Ensure alignment is power of 2
	if alignment&(alignment-1) != 0 {
		alignment = 64 // Default to cache line size
	}

	// Allocate extra space for alignment
	buf := mp.Get(size + alignment)
	
	// Align the buffer
	ptr := uintptr(unsafe.Pointer(&buf.data[0]))
	offset := int((alignment - ptr%uintptr(alignment)) % uintptr(alignment))
	
	buf.data = buf.data[offset : offset+size]
	return buf
}

// findPoolIndex finds the appropriate pool for a given size
func (mp *MemoryPool) findPoolIndex(size int) int {
	// Binary search for efficiency
	left, right := 0, len(mp.sizes)-1
	
	for left < right {
		mid := (left + right) / 2
		if mp.sizes[mid] < size {
			left = mid + 1
		} else {
			right = mid
		}
	}
	
	return left
}

// allocateAligned allocates aligned memory
func (mp *MemoryPool) allocateAligned(size int) []byte {
	// Allocate with 64-byte alignment (cache line size)
	alignment := 64
	buf := make([]byte, size+alignment)
	
	ptr := uintptr(unsafe.Pointer(&buf[0]))
	offset := int((alignment - ptr%uintptr(alignment)) % uintptr(alignment))
	
	return buf[offset : offset+size]
}

// allocateHugePage allocates memory using huge pages (Linux)
func (mp *MemoryPool) allocateHugePage(size int) []byte {
	// This would use mmap with MAP_HUGETLB flag on Linux
	// For now, fall back to regular allocation
	return make([]byte, size)
}

// zeroMemory securely zeros memory
func (mp *MemoryPool) zeroMemory(b []byte) {
	for i := range b {
		b[i] = 0
	}
	// Prevent compiler optimization
	runtime.KeepAlive(b)
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
	return cap(b.data)
}

// Resize resizes the buffer
func (b *Buffer) Resize(newSize int) {
	if newSize <= cap(b.data) {
		b.data = b.data[:newSize]
	}
}

// AddRef increments the reference count
func (b *Buffer) AddRef() {
	atomic.AddInt32(&b.refCount, 1)
}

// Stats returns pool statistics
func (mp *MemoryPool) Stats() PoolStats {
	return PoolStats{
		Allocations:   atomic.LoadUint64(&mp.stats.Allocations),
		Deallocations: atomic.LoadUint64(&mp.stats.Deallocations),
		Reuses:        atomic.LoadUint64(&mp.stats.Reuses),
		TotalBytes:    atomic.LoadUint64(&mp.stats.TotalBytes),
		ActiveBytes:   atomic.LoadUint64(&mp.stats.ActiveBytes),
	}
}

// Clear releases all pooled buffers
func (mp *MemoryPool) Clear() {
	for _, pool := range mp.pools {
		// Force garbage collection of pooled items
		for {
			if pool.Get() == nil {
				break
			}
		}
	}
	runtime.GC()
}

// RingBuffer provides a lock-free ring buffer for high-performance scenarios
type RingBuffer struct {
	buffer   []byte
	size     uint64
	mask     uint64
	writePos uint64
	readPos  uint64
	_        [56]byte // Cache line padding
}

// NewRingBuffer creates a new ring buffer
func NewRingBuffer(size int) *RingBuffer {
	// Ensure size is power of 2
	size = nextPowerOf2(size)
	
	return &RingBuffer{
		buffer: make([]byte, size),
		size:   uint64(size),
		mask:   uint64(size - 1),
	}
}

// Write writes data to the ring buffer
func (rb *RingBuffer) Write(data []byte) (int, error) {
	n := len(data)
	if n == 0 {
		return 0, nil
	}

	writePos := atomic.LoadUint64(&rb.writePos)
	readPos := atomic.LoadUint64(&rb.readPos)
	
	available := rb.size - (writePos - readPos)
	if uint64(n) > available {
		n = int(available)
	}

	for i := 0; i < n; i++ {
		rb.buffer[(writePos+uint64(i))&rb.mask] = data[i]
	}

	atomic.AddUint64(&rb.writePos, uint64(n))
	return n, nil
}

// Read reads data from the ring buffer
func (rb *RingBuffer) Read(data []byte) (int, error) {
	n := len(data)
	if n == 0 {
		return 0, nil
	}

	writePos := atomic.LoadUint64(&rb.writePos)
	readPos := atomic.LoadUint64(&rb.readPos)
	
	available := writePos - readPos
	if available == 0 {
		return 0, nil
	}

	if uint64(n) > available {
		n = int(available)
	}

	for i := 0; i < n; i++ {
		data[i] = rb.buffer[(readPos+uint64(i))&rb.mask]
	}

	atomic.AddUint64(&rb.readPos, uint64(n))
	return n, nil
}

// Available returns the number of bytes available to read
func (rb *RingBuffer) Available() int {
	writePos := atomic.LoadUint64(&rb.writePos)
	readPos := atomic.LoadUint64(&rb.readPos)
	return int(writePos - readPos)
}

// Free returns the number of free bytes
func (rb *RingBuffer) Free() int {
	writePos := atomic.LoadUint64(&rb.writePos)
	readPos := atomic.LoadUint64(&rb.readPos)
	return int(rb.size - (writePos - readPos))
}

// Reset resets the ring buffer
func (rb *RingBuffer) Reset() {
	atomic.StoreUint64(&rb.writePos, 0)
	atomic.StoreUint64(&rb.readPos, 0)
}

// Helper functions

func nextPowerOf2(n int) int {
	n--
	n |= n >> 1
	n |= n >> 2
	n |= n >> 4
	n |= n >> 8
	n |= n >> 16
	n |= n >> 32
	n++
	return n
}

// ObjectPool provides a type-safe object pool
type ObjectPool[T any] struct {
	pool *sync.Pool
	new  func() T
	reset func(*T)
}

// NewObjectPool creates a new typed object pool
func NewObjectPool[T any](new func() T, reset func(*T)) *ObjectPool[T] {
	return &ObjectPool[T]{
		pool: &sync.Pool{
			New: func() interface{} {
				return new()
			},
		},
		new:   new,
		reset: reset,
	}
}

// Get retrieves an object from the pool
func (op *ObjectPool[T]) Get() T {
	return op.pool.Get().(T)
}

// Put returns an object to the pool
func (op *ObjectPool[T]) Put(obj T) {
	if op.reset != nil {
		op.reset(&obj)
	}
	op.pool.Put(obj)
}