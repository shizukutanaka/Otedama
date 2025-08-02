package performance

import (
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestMemoryPool_Creation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024 * 1024, // 1MB
		SizeClasses:   8,
		MaxBlocksPerSize: 100,
		EnableNUMA:    false,
		GCInterval:    0, // Disable GC for testing
	}

	pool := NewMemoryPool(logger, config)
	assert.NotNil(t, pool)

	// Verify size classes
	assert.Equal(t, 8, len(pool.pools))
}

func TestMemoryPool_GetPut(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024,
		SizeClasses:   4,
		MaxBlocksPerSize: 10,
	}

	pool := NewMemoryPool(logger, config)

	// Test getting and putting blocks
	tests := []struct {
		name string
		size int
	}{
		{"Small block", 32},
		{"Exact min size", 64},
		{"Medium block", 256},
		{"Large block", 512},
		{"Max size", 1024},
		{"Over max size", 2048},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Get block
			block := pool.Get(tt.size)
			require.NotNil(t, block)
			assert.GreaterOrEqual(t, len(block.data), tt.size)
			assert.Equal(t, int64(1), block.refCount.Load())

			// Use block
			for i := 0; i < tt.size && i < len(block.data); i++ {
				block.data[i] = byte(i % 256)
			}

			// Put block back
			pool.Put(block)

			// For pooled sizes, refcount should be 0
			if tt.size <= 1024 {
				assert.Equal(t, int64(0), block.refCount.Load())
			}
		})
	}
}

func TestMemoryPool_RefCounting(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024,
		SizeClasses:   4,
		MaxBlocksPerSize: 10,
	}

	pool := NewMemoryPool(logger, config)

	// Get a block
	block := pool.Get(128)
	require.NotNil(t, block)
	assert.Equal(t, int64(1), block.refCount.Load())

	// Add references
	block.AddRef()
	assert.Equal(t, int64(2), block.refCount.Load())

	block.AddRef()
	assert.Equal(t, int64(3), block.refCount.Load())

	// Release references
	block.Release()
	assert.Equal(t, int64(2), block.refCount.Load())

	block.Release()
	assert.Equal(t, int64(1), block.refCount.Load())

	// Final release should return to pool
	block.Release()
	assert.Equal(t, int64(0), block.refCount.Load())
}

func TestMemoryPool_ConcurrentAccess(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024,
		SizeClasses:   4,
		MaxBlocksPerSize: 100,
	}

	pool := NewMemoryPool(logger, config)

	// Run concurrent get/put operations
	var wg sync.WaitGroup
	numGoroutines := 10
	opsPerGoroutine := 1000

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()

			for j := 0; j < opsPerGoroutine; j++ {
				size := 64 + (j % 8) * 64
				block := pool.Get(size)
				
				// Simulate some work
				for k := 0; k < size && k < len(block.data); k++ {
					block.data[k] = byte((id + j + k) % 256)
				}

				// Sometimes add extra references
				if j % 3 == 0 {
					block.AddRef()
					block.Release()
				}

				pool.Put(block)
			}
		}(i)
	}

	wg.Wait()

	// Verify stats
	stats := pool.GetStats()
	assert.Greater(t, stats.Hits, uint64(0))
	assert.Equal(t, uint64(0), stats.InUse) // All blocks should be returned
}

func TestMemoryPool_SizeClasses(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024,
		SizeClasses:   4,
		MaxBlocksPerSize: 10,
	}

	pool := NewMemoryPool(logger, config)

	// Verify size classes are correctly calculated
	expectedSizes := []int{64, 128, 256, 512}
	
	for i, expected := range expectedSizes {
		actual := pool.sizeClasses[i]
		assert.Equal(t, expected, actual)
	}

	// Test size class selection
	tests := []struct {
		requestSize int
		expectClass int
	}{
		{32, 0},    // -> 64
		{64, 0},    // -> 64
		{65, 1},    // -> 128
		{128, 1},   // -> 128
		{129, 2},   // -> 256
		{256, 2},   // -> 256
		{257, 3},   // -> 512
		{512, 3},   // -> 512
		{513, -1},  // -> too large, direct alloc
		{1024, -1}, // -> too large, direct alloc
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("size_%d", tt.requestSize), func(t *testing.T) {
			classIdx := pool.findSizeClass(tt.requestSize)
			assert.Equal(t, tt.expectClass, classIdx)
		})
	}
}

func TestMemoryPool_PoolLimits(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  256,
		SizeClasses:   2,
		MaxBlocksPerSize: 5, // Small limit for testing
	}

	pool := NewMemoryPool(logger, config)

	// Get more blocks than the pool limit
	blocks := make([]*MemoryBlock, 10)
	for i := 0; i < 10; i++ {
		blocks[i] = pool.Get(64)
		require.NotNil(t, blocks[i])
	}

	// Put all blocks back
	for _, block := range blocks {
		pool.Put(block)
	}

	// Pool should only keep MaxBlocksPerSize
	// This is internal behavior, we can verify indirectly through stats
	stats := pool.GetStats()
	assert.Equal(t, uint64(0), stats.InUse)
}

func TestMemoryPool_ZeroCopy(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024,
		SizeClasses:   4,
		MaxBlocksPerSize: 10,
	}

	pool := NewMemoryPool(logger, config)

	// Get a block
	block1 := pool.Get(256)
	require.NotNil(t, block1)

	// Fill with pattern
	pattern := byte(0xAB)
	for i := range block1.data {
		block1.data[i] = pattern
	}

	// Create zero-copy slice
	slice := block1.Slice(10, 20)
	assert.Equal(t, 10, len(slice))

	// Verify it's the same memory
	for i := range slice {
		assert.Equal(t, pattern, slice[i])
	}

	// Modify through slice
	slice[0] = 0xFF
	assert.Equal(t, byte(0xFF), block1.data[10])

	pool.Put(block1)
}

func TestMemoryPool_GarbageCollection(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  256,
		SizeClasses:   2,
		MaxBlocksPerSize: 10,
		GCInterval:    100, // 100ms for testing
	}

	pool := NewMemoryPool(logger, config)

	// Start pool (enables GC)
	pool.Start()
	defer pool.Stop()

	// Allocate and return many blocks
	for i := 0; i < 20; i++ {
		block := pool.Get(64)
		pool.Put(block)
	}

	// Wait for GC to run
	runtime.GC()
	time.Sleep(200 * time.Millisecond)

	// Stats should show cleanup happened
	stats := pool.GetStats()
	assert.Equal(t, uint64(0), stats.InUse)
}

func TestMemoryPool_NUMA(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	// Skip on non-Linux or if NUMA not available
	if runtime.GOOS != "linux" {
		t.Skip("NUMA test only runs on Linux")
	}

	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  1024,
		SizeClasses:   4,
		MaxBlocksPerSize: 10,
		EnableNUMA:    true,
	}

	pool := NewMemoryPool(logger, config)

	// Get blocks with NUMA hint
	block := pool.GetNUMA(256, 0)
	assert.NotNil(t, block)

	// We can't easily verify NUMA allocation worked,
	// but at least ensure it doesn't crash
	pool.Put(block)
}

// Benchmark tests

func BenchmarkMemoryPool_Get(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  4096,
		SizeClasses:   8,
		MaxBlocksPerSize: 1000,
	}

	pool := NewMemoryPool(logger, config)

	sizes := []int{64, 128, 256, 512, 1024, 2048}

	for _, size := range sizes {
		b.Run(fmt.Sprintf("size_%d", size), func(b *testing.B) {
			b.ResetTimer()
			
			for i := 0; i < b.N; i++ {
				block := pool.Get(size)
				pool.Put(block)
			}
		})
	}
}

func BenchmarkMemoryPool_GetPutConcurrent(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  4096,
		SizeClasses:   8,
		MaxBlocksPerSize: 1000,
	}

	pool := NewMemoryPool(logger, config)

	b.RunParallel(func(pb *testing.PB) {
		size := 256
		for pb.Next() {
			block := pool.Get(size)
			// Simulate some work
			for i := 0; i < size && i < len(block.data); i++ {
				block.data[i] = byte(i)
			}
			pool.Put(block)
		}
	})
}

func BenchmarkMemoryPool_VsDirectAlloc(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	config := &MemoryPoolConfig{
		MinBlockSize:  64,
		MaxBlockSize:  4096,
		SizeClasses:   8,
		MaxBlocksPerSize: 1000,
	}

	pool := NewMemoryPool(logger, config)
	size := 1024

	b.Run("MemoryPool", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			block := pool.Get(size)
			pool.Put(block)
		}
	})

	b.Run("DirectAlloc", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			buf := make([]byte, size)
			_ = buf
		}
	})
}