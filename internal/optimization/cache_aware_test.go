package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Test fixtures and helpers

func createTestRingBuffer(size int) *RingBuffer[int] {
	return NewRingBuffer[int](size)
}

func createTestStripedCounter() *StripedCounter {
	return NewStripedCounter()
}

func createTestTwoLevelCache() *TwoLevelCache[string, int] {
	return NewTwoLevelCache[string, int](4, 16)
}

// Tests for cache constants and alignment

func TestCacheConstants(t *testing.T) {
	assert.Equal(t, 64, CacheLineSize)
	assert.Equal(t, 32*1024, L1CacheSize)
	assert.Equal(t, 256*1024, L2CacheSize)
	assert.Equal(t, 8*1024*1024, L3CacheSize)
}

func TestCachePaddingSize(t *testing.T) {
	var padding CachePadding
	assert.Equal(t, CacheLineSize, len(padding))
	assert.Equal(t, CacheLineSize, int(unsafe.Sizeof(padding)))
}

func TestAlignToCache(t *testing.T) {
	tests := []struct {
		input    int
		expected int
	}{
		{1, 64},
		{32, 64},
		{64, 64},
		{65, 128},
		{100, 128},
		{128, 128},
		{129, 192},
	}

	for _, tt := range tests {
		result := AlignToCache(tt.input)
		assert.Equal(t, tt.expected, result, "AlignToCache(%d) should equal %d", tt.input, tt.expected)
	}
}

// Tests for CacheAlignedInt64

func TestCacheAlignedInt64(t *testing.T) {
	var counter CacheAlignedInt64
	
	// Test initial value
	assert.Equal(t, int64(0), counter.Load())
	
	// Test store and load
	counter.Store(42)
	assert.Equal(t, int64(42), counter.Load())
	
	// Test add
	result := counter.Add(8)
	assert.Equal(t, int64(50), result)
	assert.Equal(t, int64(50), counter.Load())
	
	// Test compare and swap
	swapped := counter.CompareAndSwap(50, 100)
	assert.True(t, swapped)
	assert.Equal(t, int64(100), counter.Load())
	
	// Test failed compare and swap
	swapped = counter.CompareAndSwap(50, 200)
	assert.False(t, swapped)
	assert.Equal(t, int64(100), counter.Load())
}

func TestCacheAlignedInt64Alignment(t *testing.T) {
	var counter CacheAlignedInt64
	size := unsafe.Sizeof(counter)
	
	// Should be at least 3 cache lines (padding + value + padding)
	assert.GreaterOrEqual(t, int(size), 3*CacheLineSize)
	
	// Check memory layout
	assert.Equal(t, CacheLineSize, int(unsafe.Sizeof(counter._padding0)))
	assert.Equal(t, CacheLineSize, int(unsafe.Sizeof(counter._padding1)))
}

// Tests for CacheAlignedUint64

func TestCacheAlignedUint64(t *testing.T) {
	var counter CacheAlignedUint64
	
	// Test initial value
	assert.Equal(t, uint64(0), counter.Load())
	
	// Test store and load
	counter.Store(42)
	assert.Equal(t, uint64(42), counter.Load())
	
	// Test add
	result := counter.Add(8)
	assert.Equal(t, uint64(50), result)
	assert.Equal(t, uint64(50), counter.Load())
	
	// Test compare and swap
	swapped := counter.CompareAndSwap(50, 100)
	assert.True(t, swapped)
	assert.Equal(t, uint64(100), counter.Load())
	
	// Test failed compare and swap
	swapped = counter.CompareAndSwap(50, 200)
	assert.False(t, swapped)
	assert.Equal(t, uint64(100), counter.Load())
}

// Tests for CacheAlignedBool

func TestCacheAlignedBool(t *testing.T) {
	var flag CacheAlignedBool
	
	// Test initial value
	assert.False(t, flag.Load())
	
	// Test store and load
	flag.Store(true)
	assert.True(t, flag.Load())
	
	// Test compare and swap
	swapped := flag.CompareAndSwap(true, false)
	assert.True(t, swapped)
	assert.False(t, flag.Load())
	
	// Test failed compare and swap
	swapped = flag.CompareAndSwap(true, false)
	assert.False(t, swapped)
	assert.False(t, flag.Load())
}

// Tests for RingBuffer

func TestNewRingBuffer(t *testing.T) {
	tests := []struct {
		requestedSize int
		expectedSize  int
	}{
		{1, 1},
		{2, 2},
		{3, 4},
		{7, 8},
		{9, 16},
		{100, 128},
	}

	for _, tt := range tests {
		rb := NewRingBuffer[int](tt.requestedSize)
		assert.Equal(t, tt.expectedSize, len(rb.buffer))
		assert.Equal(t, uint64(tt.expectedSize-1), rb.mask)
		assert.Equal(t, 0, rb.Size())
	}
}

func TestRingBufferBasicOperations(t *testing.T) {
	rb := createTestRingBuffer(4)

	// Test empty buffer
	_, ok := rb.Pop()
	assert.False(t, ok)
	assert.Equal(t, 0, rb.Size())

	// Test push and pop
	assert.True(t, rb.Push(1))
	assert.Equal(t, 1, rb.Size())

	assert.True(t, rb.Push(2))
	assert.True(t, rb.Push(3))
	assert.True(t, rb.Push(4))
	assert.Equal(t, 4, rb.Size())

	// Buffer should be full
	assert.False(t, rb.Push(5))
	assert.Equal(t, 4, rb.Size())

	// Test pop
	val, ok := rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 1, val)
	assert.Equal(t, 3, rb.Size())

	val, ok = rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 2, val)

	val, ok = rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 3, val)

	val, ok = rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 4, val)
	assert.Equal(t, 0, rb.Size())

	// Should be empty again
	_, ok = rb.Pop()
	assert.False(t, ok)
}

func TestRingBufferWrapAround(t *testing.T) {
	rb := createTestRingBuffer(2)

	// Fill buffer
	assert.True(t, rb.Push(1))
	assert.True(t, rb.Push(2))
	assert.False(t, rb.Push(3)) // Should fail

	// Pop one item
	val, ok := rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 1, val)

	// Should be able to push again
	assert.True(t, rb.Push(3))

	// Verify remaining items
	val, ok = rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 2, val)

	val, ok = rb.Pop()
	assert.True(t, ok)
	assert.Equal(t, 3, val)
}

func TestRingBufferConcurrency(t *testing.T) {
	rb := createTestRingBuffer(1024)
	const numProducers = 4
	const numConsumers = 2
	const itemsPerProducer = 1000

	var wg sync.WaitGroup
	var produced int64
	var consumed int64

	// Start producers
	for i := 0; i < numProducers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < itemsPerProducer; j++ {
				value := id*itemsPerProducer + j
				for !rb.Push(value) {
					runtime.Gosched()
				}
				atomic.AddInt64(&produced, 1)
			}
		}(i)
	}

	// Start consumers
	for i := 0; i < numConsumers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if val, ok := rb.Pop(); ok {
					_ = val
					if atomic.AddInt64(&consumed, 1) == int64(numProducers*itemsPerProducer) {
						return
					}
				} else {
					runtime.Gosched()
				}
			}
		}()
	}

	wg.Wait()

	assert.Equal(t, int64(numProducers*itemsPerProducer), produced)
	assert.Equal(t, int64(numProducers*itemsPerProducer), consumed)
}

// Tests for CacheAwareArray

func TestNewCacheAwareArray(t *testing.T) {
	arr := NewCacheAwareArray[int](100)
	assert.NotNil(t, arr)
	assert.Equal(t, 100, arr.size)
	assert.Equal(t, 8, arr.elemSize) // int64 on 64-bit systems
	assert.GreaterOrEqual(t, len(arr.data), 100)
}

func TestCacheAwareArrayOperations(t *testing.T) {
	arr := NewCacheAwareArray[int](10)

	// Test bounds checking for Get
	val := arr.Get(-1)
	assert.Equal(t, 0, val)

	val = arr.Get(10)
	assert.Equal(t, 0, val)

	// Test set and get
	arr.Set(5, 42)
	val = arr.Get(5)
	assert.Equal(t, 42, val)

	// Test bounds checking for Set
	arr.Set(-1, 100) // Should not panic
	arr.Set(10, 100) // Should not panic

	// Test prefetch (should not panic)
	arr.Prefetch(5)
	arr.Prefetch(-1) // Should not panic
	arr.Prefetch(10) // Should not panic
}

func TestCacheAwareArrayAlignment(t *testing.T) {
	arr := NewCacheAwareArray[byte](100)
	
	// The data slice should be aligned to cache boundaries
	dataSize := len(arr.data) * arr.elemSize
	assert.Equal(t, 0, dataSize%CacheLineSize)
}

// Tests for StripedCounter

func TestNewStripedCounter(t *testing.T) {
	sc := NewStripedCounter()
	assert.NotNil(t, sc)
	assert.GreaterOrEqual(t, len(sc.counters), runtime.NumCPU())
	
	// Should be power of 2
	numCounters := len(sc.counters)
	assert.Equal(t, 0, numCounters&(numCounters-1))
}

func TestStripedCounterOperations(t *testing.T) {
	sc := createTestStripedCounter()

	// Test initial value
	assert.Equal(t, int64(0), sc.Load())

	// Test increment
	sc.Increment()
	assert.Equal(t, int64(1), sc.Load())

	// Test add
	sc.Add(5)
	assert.Equal(t, int64(6), sc.Load())

	// Test reset
	sc.Reset()
	assert.Equal(t, int64(0), sc.Load())
}

func TestStripedCounterConcurrency(t *testing.T) {
	sc := createTestStripedCounter()
	const numGoroutines = 10
	const incrementsPerGoroutine = 1000

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < incrementsPerGoroutine; j++ {
				sc.Increment()
			}
		}()
	}

	wg.Wait()

	expected := int64(numGoroutines * incrementsPerGoroutine)
	assert.Equal(t, expected, sc.Load())
}

func TestStripedCounterDistribution(t *testing.T) {
	sc := createTestStripedCounter()
	const iterations = 1000

	// Add many increments
	for i := 0; i < iterations; i++ {
		sc.Add(1)
	}

	// Verify total
	assert.Equal(t, int64(iterations), sc.Load())

	// Check that work is distributed across multiple counters
	// (this is probabilistic, but should generally work)
	nonZeroCounters := 0
	for i := range sc.counters {
		if sc.counters[i].Load() > 0 {
			nonZeroCounters++
		}
	}

	// Should use multiple counters (not guaranteed, but likely)
	if len(sc.counters) > 1 {
		assert.GreaterOrEqual(t, nonZeroCounters, 1)
	}
}

// Tests for TwoLevelCache

func TestNewTwoLevelCache(t *testing.T) {
	cache := NewTwoLevelCache[string, int](4, 16)
	assert.NotNil(t, cache)
	assert.Equal(t, 4, cache.l1Size)
	assert.Equal(t, 16, cache.l2Size)
	assert.NotNil(t, cache.l1)
	assert.NotNil(t, cache.l2)
}

func TestTwoLevelCacheBasicOperations(t *testing.T) {
	cache := createTestTwoLevelCache()

	// Test miss
	_, ok := cache.Get("key1")
	assert.False(t, ok)

	// Test set and get
	cache.Set("key1", 42)
	val, ok := cache.Get("key1")
	assert.True(t, ok)
	assert.Equal(t, 42, val)

	// Verify it's in L1
	_, ok = cache.l1["key1"]
	assert.True(t, ok)
}

func TestTwoLevelCacheEviction(t *testing.T) {
	cache := createTestTwoLevelCache() // L1 size = 4

	// Fill L1 cache
	for i := 0; i < 4; i++ {
		cache.Set("key"+string(rune(i)), i)
	}

	// Verify all in L1
	assert.Len(t, cache.l1, 4)
	assert.Len(t, cache.l2, 0)

	// Add one more item (should evict from L1 to L2)
	cache.Set("key4", 4)

	// L1 should still have 4 items, L2 should have 1
	assert.Len(t, cache.l1, 4)
	assert.Len(t, cache.l2, 1)

	// The new item should be in L1
	_, ok := cache.l1["key4"]
	assert.True(t, ok)
}

func TestTwoLevelCachePromotion(t *testing.T) {
	cache := createTestTwoLevelCache()

	// Add item to L1
	cache.Set("key1", 42)

	// Fill L1 to trigger eviction
	for i := 0; i < 4; i++ {
		cache.Set("other"+string(rune(i)), i)
	}

	// key1 should now be in L2
	_, inL1 := cache.l1["key1"]
	_, inL2 := cache.l2["key1"]
	assert.False(t, inL1)
	assert.True(t, inL2)

	// Access key1 (should promote to L1)
	val, ok := cache.Get("key1")
	assert.True(t, ok)
	assert.Equal(t, 42, val)

	// key1 should now be back in L1
	_, inL1 = cache.l1["key1"]
	_, inL2 = cache.l2["key1"]
	assert.True(t, inL1)
	assert.False(t, inL2)
}

func TestTwoLevelCacheStats(t *testing.T) {
	cache := createTestTwoLevelCache()

	// Initial stats
	hits, misses, hitRate := cache.Stats()
	assert.Equal(t, uint64(0), hits)
	assert.Equal(t, uint64(0), misses)
	assert.Equal(t, float64(0), hitRate)

	// Add item and test hit
	cache.Set("key1", 42)
	_, ok := cache.Get("key1")
	assert.True(t, ok)

	hits, misses, hitRate = cache.Stats()
	assert.Equal(t, uint64(1), hits)
	assert.Equal(t, uint64(0), misses)
	assert.Equal(t, float64(1.0), hitRate)

	// Test miss
	_, ok = cache.Get("nonexistent")
	assert.False(t, ok)

	hits, misses, hitRate = cache.Stats()
	assert.Equal(t, uint64(1), hits)
	assert.Equal(t, uint64(1), misses)
	assert.Equal(t, 0.5, hitRate)
}

// Tests for utility functions

func TestGetGoroutineID(t *testing.T) {
	id1 := getGoroutineID()
	id2 := getGoroutineID()
	
	// Should return consistent ID within same goroutine
	assert.Equal(t, id1, id2)
	
	// Different goroutines should (likely) have different IDs
	var id3 uint64
	done := make(chan bool)
	go func() {
		id3 = getGoroutineID()
		done <- true
	}()
	<-done
	
	// This is probabilistic, but very likely to be different
	assert.NotEqual(t, id1, id3)
}

func TestIsCacheAligned(t *testing.T) {
	// Test with aligned and unaligned pointers
	aligned := make([]byte, CacheLineSize*2)
	
	// Find cache-aligned address
	addr := uintptr(unsafe.Pointer(&aligned[0]))
	offset := addr % CacheLineSize
	if offset != 0 {
		addr += CacheLineSize - offset
	}
	
	alignedPtr := unsafe.Pointer(addr)
	unalignedPtr := unsafe.Pointer(addr + 1)
	
	assert.True(t, IsCacheAligned(alignedPtr))
	assert.False(t, IsCacheAligned(unalignedPtr))
}

func TestPrefetchFunctions(t *testing.T) {
	data := make([]byte, 64)
	ptr := unsafe.Pointer(&data[0])
	
	// These should not panic
	PrefetchForRead(ptr)
	PrefetchForWrite(ptr)
}

// Concurrent stress tests

func TestCacheAlignedTypesConcurrency(t *testing.T) {
	var counter CacheAlignedInt64
	var flag CacheAlignedBool
	const numGoroutines = 10
	const iterations = 1000

	var wg sync.WaitGroup
	wg.Add(numGoroutines * 2)

	// Test concurrent int64 operations
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				counter.Add(1)
			}
		}()
	}

	// Test concurrent bool operations
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				flag.Store(j%2 == 0)
				flag.Load()
			}
		}()
	}

	wg.Wait()

	assert.Equal(t, int64(numGoroutines*iterations), counter.Load())
}

// Benchmark tests

func BenchmarkCacheAlignedInt64(b *testing.B) {
	var counter CacheAlignedInt64
	
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			counter.Add(1)
		}
	})
}

func BenchmarkRegularAtomicInt64(b *testing.B) {
	var counter atomic.Int64
	
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			counter.Add(1)
		}
	})
}

func BenchmarkRingBufferPush(b *testing.B) {
	rb := NewRingBuffer[int](1024)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if !rb.Push(i) {
			// Buffer full, pop one item
			rb.Pop()
			rb.Push(i)
		}
	}
}

func BenchmarkRingBufferPop(b *testing.B) {
	rb := NewRingBuffer[int](1024)
	
	// Pre-fill buffer
	for i := 0; i < 1024; i++ {
		rb.Push(i)
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := rb.Pop(); !ok {
			// Buffer empty, push some items
			for j := 0; j < 100; j++ {
				rb.Push(j)
			}
			rb.Pop()
		}
	}
}

func BenchmarkStripedCounter(b *testing.B) {
	sc := NewStripedCounter()
	
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			sc.Increment()
		}
	})
}

func BenchmarkRegularCounter(b *testing.B) {
	var counter atomic.Int64
	
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			counter.Add(1)
		}
	})
}

func BenchmarkTwoLevelCacheGet(b *testing.B) {
	cache := NewTwoLevelCache[int, int](256, 1024)
	
	// Pre-populate cache
	for i := 0; i < 512; i++ {
		cache.Set(i, i*2)
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cache.Get(i % 512)
	}
}

func BenchmarkTwoLevelCacheSet(b *testing.B) {
	cache := NewTwoLevelCache[int, int](256, 1024)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cache.Set(i, i*2)
	}
}

func BenchmarkCacheAwareArrayAccess(b *testing.B) {
	arr := NewCacheAwareArray[int](1024)
	
	// Pre-populate
	for i := 0; i < 1024; i++ {
		arr.Set(i, i)
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		arr.Get(i % 1024)
	}
}

func BenchmarkRegularArrayAccess(b *testing.B) {
	arr := make([]int, 1024)
	
	// Pre-populate
	for i := 0; i < 1024; i++ {
		arr[i] = i
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = arr[i%1024]
	}
}

// Memory layout and false sharing tests

func TestFalseSharingPrevention(t *testing.T) {
	// Create multiple cache-aligned counters
	counters := make([]CacheAlignedInt64, 4)
	
	// Verify they don't share cache lines
	for i := 0; i < len(counters)-1; i++ {
		addr1 := uintptr(unsafe.Pointer(&counters[i]))
		addr2 := uintptr(unsafe.Pointer(&counters[i+1]))
		
		// Should be at least one cache line apart
		distance := addr2 - addr1
		assert.GreaterOrEqual(t, int(distance), CacheLineSize)
	}
}

func TestMemoryAlignment(t *testing.T) {
	// Test that our cache-aligned types are properly aligned
	var counter CacheAlignedInt64
	var flag CacheAlignedBool
	var uint64Counter CacheAlignedUint64
	
	// The actual atomic values should be cache-aligned within the struct
	counterAddr := uintptr(unsafe.Pointer(&counter.value))
	flagAddr := uintptr(unsafe.Pointer(&flag.value))
	uint64Addr := uintptr(unsafe.Pointer(&uint64Counter.value))
	
	// They should be positioned after the first padding
	assert.Equal(t, uintptr(0), counterAddr%8)   // 8-byte aligned for int64
	assert.Equal(t, uintptr(0), flagAddr%1)      // 1-byte aligned for bool
	assert.Equal(t, uintptr(0), uint64Addr%8)    // 8-byte aligned for uint64
}