package testing

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/optimization"
	"github.com/stretchr/testify/require"
)

// PerformanceTestSuite provides performance testing utilities
type PerformanceTestSuite struct {
	TestSuite
	
	// Performance metrics
	metrics *PerformanceMetrics
	
	// Profiling
	cpuProfile  string
	memProfile  string
	traceFile   string
}

// PerformanceMetrics tracks performance metrics
type PerformanceMetrics struct {
	mu sync.Mutex
	
	// Timing
	Operations      int64
	TotalDuration   time.Duration
	MinLatency      time.Duration
	MaxLatency      time.Duration
	AvgLatency      time.Duration
	
	// Throughput
	OpsPerSecond    float64
	BytesProcessed  int64
	
	// Resources
	MemoryUsed      uint64
	GoroutinesUsed  int
	CPUPercent      float64
	
	// Errors
	ErrorCount      int64
}

// TestHashingPerformance tests hashing algorithm performance
func (pts *PerformanceTestSuite) TestHashingPerformance() {
	algorithms := []string{"sha256", "scrypt", "ethash", "randomx"}
	
	for _, algo := range algorithms {
		pts.Run(algo, func() {
			pts.benchmarkHashAlgorithm(algo)
		})
	}
	
	// Compare results
	pts.compareAlgorithmPerformance()
}

// benchmarkHashAlgorithm benchmarks a specific algorithm
func (pts *PerformanceTestSuite) benchmarkHashAlgorithm(algo string) {
	// Setup
	hasher := mining.NewHasher(algo)
	data := make([]byte, 80) // Standard block header size
	
	// Warmup
	for i := 0; i < 1000; i++ {
		hasher.Hash(data)
	}
	
	// Reset metrics
	pts.metrics = &PerformanceMetrics{
		MinLatency: time.Hour, // Set to high value initially
	}
	
	// Benchmark
	numOperations := 100000
	start := time.Now()
	
	for i := 0; i < numOperations; i++ {
		opStart := time.Now()
		
		_, err := hasher.Hash(data)
		require.NoError(pts.T(), err)
		
		latency := time.Since(opStart)
		pts.updateMetrics(latency, len(data))
	}
	
	duration := time.Since(start)
	
	// Calculate final metrics
	pts.metrics.Operations = int64(numOperations)
	pts.metrics.TotalDuration = duration
	pts.metrics.OpsPerSecond = float64(numOperations) / duration.Seconds()
	pts.metrics.AvgLatency = duration / time.Duration(numOperations)
	
	// Log results
	pts.logPerformanceResults(algo)
}

// TestMiningEngineScalability tests mining engine scalability
func (pts *PerformanceTestSuite) TestMiningEngineScalability() {
	threadCounts := []int{1, 2, 4, 8, 16, 32}
	results := make(map[int]*PerformanceMetrics)
	
	for _, threads := range threadCounts {
		pts.Run(fmt.Sprintf("%d_threads", threads), func() {
			metrics := pts.benchmarkMiningEngine(threads)
			results[threads] = metrics
		})
	}
	
	// Analyze scalability
	pts.analyzeScalability(results)
}

// benchmarkMiningEngine benchmarks mining engine with given thread count
func (pts *PerformanceTestSuite) benchmarkMiningEngine(threads int) *PerformanceMetrics {
	// Setup
	config := pts.Framework.Config.Mining
	config.Threads = threads
	
	engine := mining.NewEngine(pts.Framework.Logger, config)
	ctx := context.Background()
	
	err := engine.Start(ctx)
	require.NoError(pts.T(), err)
	defer engine.Stop(ctx)
	
	// Reset metrics
	metrics := &PerformanceMetrics{
		MinLatency: time.Hour,
	}
	
	// Run for fixed duration
	duration := 30 * time.Second
	done := make(chan struct{})
	
	go func() {
		time.Sleep(duration)
		close(done)
	}()
	
	// Submit work continuously
	var wg sync.WaitGroup
	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			pts.submitWorkContinuously(engine, workerID, done, metrics)
		}(i)
	}
	
	wg.Wait()
	
	// Get final metrics
	metrics.OpsPerSecond = float64(metrics.Operations) / duration.Seconds()
	
	return metrics
}

// submitWorkContinuously submits work until done signal
func (pts *PerformanceTestSuite) submitWorkContinuously(
	engine *mining.Engine,
	workerID int,
	done <-chan struct{},
	metrics *PerformanceMetrics,
) {
	for {
		select {
		case <-done:
			return
		default:
			start := time.Now()
			
			share := &mining.Share{
				WorkerID:   fmt.Sprintf("worker_%d", workerID),
				JobID:      "test_job",
				Nonce:      uint64(time.Now().UnixNano()),
				Difficulty: 1000000,
				Timestamp:  time.Now(),
			}
			
			err := engine.SubmitShare(share)
			if err != nil {
				metrics.mu.Lock()
				metrics.ErrorCount++
				metrics.mu.Unlock()
				continue
			}
			
			latency := time.Since(start)
			pts.updateMetrics(latency, 0)
		}
	}
}

// TestMemoryOptimization tests memory optimization techniques
func (pts *PerformanceTestSuite) TestMemoryOptimization() {
	// Test different pool sizes
	poolSizes := []int{100, 1000, 10000}
	
	for _, size := range poolSizes {
		pts.Run(fmt.Sprintf("pool_size_%d", size), func() {
			pts.benchmarkMemoryPool(size)
		})
	}
}

// benchmarkMemoryPool benchmarks memory pool performance
func (pts *PerformanceTestSuite) benchmarkMemoryPool(poolSize int) {
	// Create optimized pool
	pool := optimization.NewMemoryPool(poolSize, 1024) // 1KB buffers
	
	// Reset metrics
	pts.metrics = &PerformanceMetrics{
		MinLatency: time.Hour,
	}
	
	// Measure initial memory
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	initialMem := m.Alloc
	
	// Benchmark allocation/deallocation
	numOperations := 100000
	start := time.Now()
	
	for i := 0; i < numOperations; i++ {
		opStart := time.Now()
		
		// Get buffer
		buf := pool.Get()
		
		// Use buffer
		copy(buf, []byte("test data"))
		
		// Return buffer
		pool.Put(buf)
		
		latency := time.Since(opStart)
		pts.updateMetrics(latency, len(buf))
	}
	
	duration := time.Since(start)
	
	// Measure final memory
	runtime.ReadMemStats(&m)
	pts.metrics.MemoryUsed = m.Alloc - initialMem
	pts.metrics.Operations = int64(numOperations)
	pts.metrics.TotalDuration = duration
	pts.metrics.OpsPerSecond = float64(numOperations) / duration.Seconds()
	
	pts.logPerformanceResults(fmt.Sprintf("memory_pool_%d", poolSize))
}

// TestNetworkThroughput tests network throughput
func (pts *PerformanceTestSuite) TestNetworkThroughput() {
	// Start test server
	server, err := pts.Framework.StartTestServer()
	require.NoError(pts.T(), err)
	
	// Test different message sizes
	messageSizes := []int{1024, 10240, 102400, 1048576} // 1KB, 10KB, 100KB, 1MB
	
	for _, size := range messageSizes {
		pts.Run(fmt.Sprintf("message_size_%d", size), func() {
			pts.benchmarkNetworkThroughput(server, size)
		})
	}
}

// benchmarkNetworkThroughput benchmarks network throughput
func (pts *PerformanceTestSuite) benchmarkNetworkThroughput(server *TestServer, messageSize int) {
	// Create test data
	data := make([]byte, messageSize)
	for i := range data {
		data[i] = byte(i % 256)
	}
	
	// Reset metrics
	pts.metrics = &PerformanceMetrics{
		MinLatency: time.Hour,
	}
	
	// Run benchmark
	numMessages := 1000
	start := time.Now()
	
	var wg sync.WaitGroup
	concurrency := 10
	
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			
			for j := 0; j < numMessages/concurrency; j++ {
				opStart := time.Now()
				
				// Send message
				err := server.SendMessage(data)
				if err != nil {
					pts.metrics.mu.Lock()
					pts.metrics.ErrorCount++
					pts.metrics.mu.Unlock()
					continue
				}
				
				latency := time.Since(opStart)
				pts.updateMetrics(latency, len(data))
			}
		}()
	}
	
	wg.Wait()
	duration := time.Since(start)
	
	// Calculate throughput
	totalBytes := int64(numMessages * messageSize)
	pts.metrics.BytesProcessed = totalBytes
	pts.metrics.OpsPerSecond = float64(totalBytes) / duration.Seconds() / 1024 / 1024 // MB/s
	
	pts.logPerformanceResults(fmt.Sprintf("network_%dKB", messageSize/1024))
}

// TestCPUOptimization tests CPU optimization features
func (pts *PerformanceTestSuite) TestCPUOptimization() {
	// Test with different optimization levels
	optimizations := []string{"none", "sse4", "avx2", "avx512"}
	
	for _, opt := range optimizations {
		if !optimization.IsSupported(opt) {
			pts.T().Skipf("Optimization %s not supported", opt)
			continue
		}
		
		pts.Run(opt, func() {
			pts.benchmarkCPUOptimization(opt)
		})
	}
}

// Helper methods

// updateMetrics updates performance metrics
func (pts *PerformanceTestSuite) updateMetrics(latency time.Duration, bytes int) {
	pts.metrics.mu.Lock()
	defer pts.metrics.mu.Unlock()
	
	pts.metrics.Operations++
	pts.metrics.BytesProcessed += int64(bytes)
	
	if latency < pts.metrics.MinLatency {
		pts.metrics.MinLatency = latency
	}
	if latency > pts.metrics.MaxLatency {
		pts.metrics.MaxLatency = latency
	}
}

// logPerformanceResults logs performance test results
func (pts *PerformanceTestSuite) logPerformanceResults(testName string) {
	pts.T().Logf("\n=== Performance Results: %s ===", testName)
	pts.T().Logf("Operations: %d", pts.metrics.Operations)
	pts.T().Logf("Total Duration: %v", pts.metrics.TotalDuration)
	pts.T().Logf("Ops/Second: %.2f", pts.metrics.OpsPerSecond)
	pts.T().Logf("Avg Latency: %v", pts.metrics.AvgLatency)
	pts.T().Logf("Min Latency: %v", pts.metrics.MinLatency)
	pts.T().Logf("Max Latency: %v", pts.metrics.MaxLatency)
	
	if pts.metrics.BytesProcessed > 0 {
		throughputMB := float64(pts.metrics.BytesProcessed) / 1024 / 1024
		pts.T().Logf("Bytes Processed: %d (%.2f MB)", pts.metrics.BytesProcessed, throughputMB)
	}
	
	if pts.metrics.MemoryUsed > 0 {
		memoryMB := float64(pts.metrics.MemoryUsed) / 1024 / 1024
		pts.T().Logf("Memory Used: %d bytes (%.2f MB)", pts.metrics.MemoryUsed, memoryMB)
	}
	
	if pts.metrics.ErrorCount > 0 {
		pts.T().Logf("Errors: %d", pts.metrics.ErrorCount)
	}
}

// compareAlgorithmPerformance compares algorithm performance
func (pts *PerformanceTestSuite) compareAlgorithmPerformance() {
	pts.T().Log("\n=== Algorithm Performance Comparison ===")
	// Implementation would compare stored results
}

// analyzeScalability analyzes scalability results
func (pts *PerformanceTestSuite) analyzeScalability(results map[int]*PerformanceMetrics) {
	pts.T().Log("\n=== Scalability Analysis ===")
	
	baseline := results[1].OpsPerSecond
	
	for threads, metrics := range results {
		speedup := metrics.OpsPerSecond / baseline
		efficiency := speedup / float64(threads) * 100
		
		pts.T().Logf("Threads: %d, Speedup: %.2fx, Efficiency: %.1f%%",
			threads, speedup, efficiency)
	}
}

// benchmarkCPUOptimization benchmarks CPU optimization
func (pts *PerformanceTestSuite) benchmarkCPUOptimization(optimization string) {
	// Implementation would benchmark specific CPU optimizations
	pts.logPerformanceResults(fmt.Sprintf("cpu_opt_%s", optimization))
}