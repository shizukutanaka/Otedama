package optimization

import (
	"runtime"
	"sync/atomic"
	"unsafe"
)

const (
	// CacheLineSize is the typical cache line size for modern CPUs
	CacheLineSize = 64
	
	// L1CacheSize typical L1 data cache size
	L1CacheSize = 32 * 1024 // 32KB
	
	// L2CacheSize typical L2 cache size per core
	L2CacheSize = 256 * 1024 // 256KB
	
	// L3CacheSize typical L3 cache size (shared)
	L3CacheSize = 8 * 1024 * 1024 // 8MB
)

// CachePadding provides cache line padding to avoid false sharing
type CachePadding [CacheLineSize]byte

// CacheAlignedInt64 is a cache-aligned atomic int64
type CacheAlignedInt64 struct {
	_padding0 CachePadding
	value     atomic.Int64
	_padding1 CachePadding
}

func (c *CacheAlignedInt64) Load() int64 {
	return c.value.Load()
}

func (c *CacheAlignedInt64) Store(val int64) {
	c.value.Store(val)
}

func (c *CacheAlignedInt64) Add(delta int64) int64 {
	return c.value.Add(delta)
}

func (c *CacheAlignedInt64) CompareAndSwap(old, new int64) bool {
	return c.value.CompareAndSwap(old, new)
}

// CacheAlignedUint64 is a cache-aligned atomic uint64
type CacheAlignedUint64 struct {
	_padding0 CachePadding
	value     atomic.Uint64
	_padding1 CachePadding
}

func (c *CacheAlignedUint64) Load() uint64 {
	return c.value.Load()
}

func (c *CacheAlignedUint64) Store(val uint64) {
	c.value.Store(val)
}

func (c *CacheAlignedUint64) Add(delta uint64) uint64 {
	return c.value.Add(delta)
}

func (c *CacheAlignedUint64) CompareAndSwap(old, new uint64) bool {
	return c.value.CompareAndSwap(old, new)
}

// CacheAlignedBool is a cache-aligned atomic bool
type CacheAlignedBool struct {
	_padding0 CachePadding
	value     atomic.Bool
	_padding1 CachePadding
}

func (c *CacheAlignedBool) Load() bool {
	return c.value.Load()
}

func (c *CacheAlignedBool) Store(val bool) {
	c.value.Store(val)
}

func (c *CacheAlignedBool) CompareAndSwap(old, new bool) bool {
	return c.value.CompareAndSwap(old, new)
}

// RingBuffer is a cache-aware lock-free ring buffer
type RingBuffer[T any] struct {
	buffer    []T
	mask      uint64
	_padding0 CachePadding
	head      atomic.Uint64
	_padding1 CachePadding
	tail      atomic.Uint64
	_padding2 CachePadding
}

// NewRingBuffer creates a new ring buffer with power-of-2 size
func NewRingBuffer[T any](size int) *RingBuffer[T] {
	// Ensure size is power of 2
	actualSize := 1
	for actualSize < size {
		actualSize <<= 1
	}
	
	return &RingBuffer[T]{
		buffer: make([]T, actualSize),
		mask:   uint64(actualSize - 1),
	}
}

// Push adds an item to the ring buffer
func (rb *RingBuffer[T]) Push(item T) bool {
	head := rb.head.Load()
	tail := rb.tail.Load()
	
	// Check if full
	if head-tail >= uint64(len(rb.buffer)) {
		return false
	}
	
	// Try to claim slot
	if !rb.head.CompareAndSwap(head, head+1) {
		return false
	}
	
	// Write item
	rb.buffer[head&rb.mask] = item
	
	return true
}

// Pop removes an item from the ring buffer
func (rb *RingBuffer[T]) Pop() (T, bool) {
	var zero T
	
	for {
		tail := rb.tail.Load()
		head := rb.head.Load()
		
		// Check if empty
		if tail >= head {
			return zero, false
		}
		
		// Read item
		item := rb.buffer[tail&rb.mask]
		
		// Try to update tail
		if rb.tail.CompareAndSwap(tail, tail+1) {
			return item, true
		}
		
		// Retry on contention
		runtime.Gosched()
	}
}

// Size returns the current number of items
func (rb *RingBuffer[T]) Size() int {
	head := rb.head.Load()
	tail := rb.tail.Load()
	return int(head - tail)
}

// CacheAwareArray is an array optimized for cache access patterns
type CacheAwareArray[T any] struct {
	data     []T
	size     int
	elemSize int
}

// NewCacheAwareArray creates a cache-optimized array
func NewCacheAwareArray[T any](size int) *CacheAwareArray[T] {
	var sample T
	elemSize := int(unsafe.Sizeof(sample))
	
	// Align to cache line boundaries
	alignedSize := ((size*elemSize + CacheLineSize - 1) / CacheLineSize) * CacheLineSize
	numElems := alignedSize / elemSize
	
	return &CacheAwareArray[T]{
		data:     make([]T, numElems),
		size:     size,
		elemSize: elemSize,
	}
}

// Get retrieves an element
func (ca *CacheAwareArray[T]) Get(index int) T {
	if index < 0 || index >= ca.size {
		var zero T
		return zero
	}
	return ca.data[index]
}

// Set stores an element
func (ca *CacheAwareArray[T]) Set(index int, value T) {
	if index >= 0 && index < ca.size {
		ca.data[index] = value
	}
}

// Prefetch hints the CPU to load data into cache
func (ca *CacheAwareArray[T]) Prefetch(index int) {
	if index >= 0 && index < ca.size {
		// This is a hint to the compiler/CPU
		_ = ca.data[index]
	}
}

// StripedCounter is a cache-aware counter that reduces contention
type StripedCounter struct {
	counters []CacheAlignedInt64
	mask     uint64
}

// NewStripedCounter creates a striped counter
func NewStripedCounter() *StripedCounter {
	numCPU := runtime.NumCPU()
	// Round up to power of 2
	size := 1
	for size < numCPU {
		size <<= 1
	}
	
	return &StripedCounter{
		counters: make([]CacheAlignedInt64, size),
		mask:     uint64(size - 1),
	}
}

// Increment adds to the counter
func (sc *StripedCounter) Increment() {
	// Hash current goroutine to a stripe
	id := getGoroutineID() & sc.mask
	sc.counters[id].Add(1)
}

// Add adds a value to the counter
func (sc *StripedCounter) Add(delta int64) {
	id := getGoroutineID() & sc.mask
	sc.counters[id].Add(delta)
}

// Load returns the total count
func (sc *StripedCounter) Load() int64 {
	var sum int64
	for i := range sc.counters {
		sum += sc.counters[i].Load()
	}
	return sum
}

// Reset clears the counter
func (sc *StripedCounter) Reset() {
	for i := range sc.counters {
		sc.counters[i].Store(0)
	}
}

// TwoLevelCache implements a two-level cache with L1 (fast) and L2 (larger)
type TwoLevelCache[K comparable, V any] struct {
	l1       map[K]V
	l1Size   int
	l2       map[K]V
	l2Size   int
	hits     CacheAlignedUint64
	misses   CacheAlignedUint64
}

// NewTwoLevelCache creates a two-level cache
func NewTwoLevelCache[K comparable, V any](l1Size, l2Size int) *TwoLevelCache[K, V] {
	return &TwoLevelCache[K, V]{
		l1:     make(map[K]V, l1Size),
		l1Size: l1Size,
		l2:     make(map[K]V, l2Size),
		l2Size: l2Size,
	}
}

// Get retrieves a value from cache
func (c *TwoLevelCache[K, V]) Get(key K) (V, bool) {
	// Check L1
	if val, ok := c.l1[key]; ok {
		c.hits.Add(1)
		return val, true
	}
	
	// Check L2
	if val, ok := c.l2[key]; ok {
		c.hits.Add(1)
		// Promote to L1
		c.promoteTo L1(key, val)
		return val, true
	}
	
	c.misses.Add(1)
	var zero V
	return zero, false
}

// Set stores a value in cache
func (c *TwoLevelCache[K, V]) Set(key K, value V) {
	// Add to L1
	if len(c.l1) >= c.l1Size {
		// Evict from L1 to L2
		for k, v := range c.l1 {
			c.l2[k] = v
			delete(c.l1, k)
			break
		}
	}
	
	c.l1[key] = value
	
	// Check L2 size
	if len(c.l2) >= c.l2Size {
		// Evict from L2
		for k := range c.l2 {
			delete(c.l2, k)
			break
		}
	}
}

func (c *TwoLevelCache[K, V]) promoteTo L1(key K, value V) {
	delete(c.l2, key)
	c.Set(key, value)
}

// Stats returns cache statistics
func (c *TwoLevelCache[K, V]) Stats() (hits, misses uint64, hitRate float64) {
	hits = c.hits.Load()
	misses = c.misses.Load()
	total := hits + misses
	if total > 0 {
		hitRate = float64(hits) / float64(total)
	}
	return
}

// Helper function to get goroutine ID (for striping)
func getGoroutineID() uint64 {
	var buf [8]byte
	runtime.Stack(buf[:], false)
	var id uint64
	for i := 0; i < 8; i++ {
		id = id<<8 | uint64(buf[i])
	}
	return id
}

// AlignToCache aligns a size to cache line boundaries
func AlignToCache(size int) int {
	return ((size + CacheLineSize - 1) / CacheLineSize) * CacheLineSize
}

// IsCacheAligned checks if a pointer is cache-aligned
func IsCacheAligned(ptr unsafe.Pointer) bool {
	return uintptr(ptr)%CacheLineSize == 0
}

// PrefetchForRead hints the CPU to load data for reading
func PrefetchForRead(addr unsafe.Pointer) {
	// This is a compiler hint
	_ = *(*byte)(addr)
}

// PrefetchForWrite hints the CPU to load data for writing
func PrefetchForWrite(addr unsafe.Pointer) {
	// This is a compiler hint
	*(*byte)(addr) = *(*byte)(addr)
}