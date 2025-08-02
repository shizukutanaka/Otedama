package load

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// TestConcurrentMining tests mining with multiple concurrent workers
func TestConcurrentMining(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping load test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	workers := 100
	duration := 10 * time.Second
	
	config := &mining.Config{
		CPUThreads: 4,
		Algorithm:  mining.AlgorithmSHA256,
		TestMode:   true,
	}
	
	engine, err := mining.NewEngine(logger, config)
	require.NoError(t, err)
	
	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()
	
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	
	var wg sync.WaitGroup
	shareCount := make([]uint64, workers)
	
	// Simulate multiple workers
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					share := &mining.Share{
						JobID:      "test-job",
						WorkerID:   workerID,
						Nonce:      uint64(time.Now().UnixNano()),
						Difficulty: 1.0,
					}
					
					if err := engine.SubmitShare(share); err == nil {
						shareCount[workerID]++
					}
				}
			}
		}(i)
	}
	
	wg.Wait()
	
	// Verify results
	totalShares := uint64(0)
	for _, count := range shareCount {
		totalShares += count
	}
	
	assert.Greater(t, totalShares, uint64(workers*50)) // At least 50 shares per worker
	
	stats := engine.GetStats()
	assert.Greater(t, stats.TotalHashRate, uint64(0))
}

// TestMemoryLeaks tests for memory leaks under sustained load
func TestMemoryLeaks(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping memory leak test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	
	config := &mining.Config{
		CPUThreads: 2,
		Algorithm:  mining.AlgorithmSHA256,
		TestMode:   true,
	}
	
	engine, err := mining.NewEngine(logger, config)
	require.NoError(t, err)
	
	// Get initial memory usage
	var m1, m2 runtime.MemStats
	runtime.ReadMemStats(&m1)
	
	err = engine.Start()
	require.NoError(t, err)
	
	// Run for extended period
	time.Sleep(30 * time.Second)
	
	engine.Stop()
	
	// Force GC and check memory
	runtime.GC()
	runtime.ReadMemStats(&m2)
	
	// Memory should not grow excessively
	memGrowth := m2.Alloc - m1.Alloc
	assert.Less(t, memGrowth, uint64(100*1024*1024)) // Less than 100MB growth
}

// BenchmarkShareSubmission benchmarks share submission performance
func BenchmarkShareSubmission(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	config := &mining.Config{
		CPUThreads: 1,
		Algorithm:  mining.AlgorithmSHA256,
		TestMode:   true,
	}
	
	engine, err := mining.NewEngine(logger, config)
	require.NoError(b, err)
	
	err = engine.Start()
	require.NoError(b, err)
	defer engine.Stop()
	
	share := &mining.Share{
		JobID:      "bench-job",
		Nonce:      12345,
		Difficulty: 1.0,
	}
	
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		share.Nonce = uint64(i)
		engine.SubmitShare(share)
	}
}