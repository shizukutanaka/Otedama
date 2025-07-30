package optimization

import (
	"context"
	"fmt"
	"runtime"
	"runtime/pprof"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// BenchmarkRunner provides comprehensive performance benchmarking
// Following John Carmack's principle: "Measure everything that matters"
type BenchmarkRunner struct {
	logger *zap.Logger
	
	// Benchmark results storage
	results     map[string]*BenchmarkResult
	resultsMu   sync.RWMutex
	
	// Configuration
	iterations  int
	warmupRuns  int
	concurrent  int
	
	// CPU profiling
	cpuProfile  *pprof.Profile
	
	// Memory tracking
	memBaseline runtime.MemStats
}

// BenchmarkResult stores benchmark metrics
type BenchmarkResult struct {
	Name            string
	Operations      uint64
	Duration        time.Duration
	OpsPerSecond    float64
	AvgLatency      time.Duration
	P50Latency      time.Duration
	P95Latency      time.Duration
	P99Latency      time.Duration
	MemoryUsed      uint64
	AllocsPerOp     uint64
	CPUUsagePercent float64
	
	// Mining specific
	HashRate        float64
	SharesPerSecond float64
	
	// Network specific
	BytesPerSecond  uint64
	MessagesPerSec  uint64
	
	// Raw data for analysis
	latencies []time.Duration
}

// BenchmarkFunc is a function to benchmark
type BenchmarkFunc func(ctx context.Context) error

// NewBenchmarkRunner creates a new benchmark runner
func NewBenchmarkRunner(logger *zap.Logger) *BenchmarkRunner {
	return &BenchmarkRunner{
		logger:      logger,
		results:     make(map[string]*BenchmarkResult),
		iterations:  10000,
		warmupRuns:  100,
		concurrent:  runtime.NumCPU(),
	}
}

// RunBenchmark executes a benchmark with comprehensive metrics
func (br *BenchmarkRunner) RunBenchmark(name string, fn BenchmarkFunc) (*BenchmarkResult, error) {
	br.logger.Info("Starting benchmark", 
		zap.String("name", name),
		zap.Int("iterations", br.iterations),
		zap.Int("concurrent", br.concurrent),
	)
	
	// Warmup phase
	br.warmup(fn)
	
	// Get baseline memory stats
	runtime.GC()
	runtime.ReadMemStats(&br.memBaseline)
	
	// Create result
	result := &BenchmarkResult{
		Name:      name,
		latencies: make([]time.Duration, 0, br.iterations),
	}
	
	// Run benchmark
	start := time.Now()
	var wg sync.WaitGroup
	var ops atomic.Uint64
	var totalLatency atomic.Int64
	
	// Use channel to coordinate workers
	work := make(chan int, br.iterations)
	for i := 0; i < br.iterations; i++ {
		work <- i
	}
	close(work)
	
	// Start workers
	for i := 0; i < br.concurrent; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			
			for range work {
				opStart := time.Now()
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				
				err := fn(ctx)
				cancel()
				
				if err == nil {
					latency := time.Since(opStart)
					ops.Add(1)
					totalLatency.Add(int64(latency))
					
					// Store latency for percentile calculation
					br.resultsMu.Lock()
					result.latencies = append(result.latencies, latency)
					br.resultsMu.Unlock()
				}
			}
		}()
	}
	
	wg.Wait()
	duration := time.Since(start)
	
	// Calculate results
	result.Operations = ops.Load()
	result.Duration = duration
	result.OpsPerSecond = float64(result.Operations) / duration.Seconds()
	
	if result.Operations > 0 {
		result.AvgLatency = time.Duration(totalLatency.Load() / int64(result.Operations))
		br.calculatePercentiles(result)
	}
	
	// Memory stats
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	result.MemoryUsed = memStats.Alloc - br.memBaseline.Alloc
	if result.Operations > 0 {
		result.AllocsPerOp = (memStats.Mallocs - br.memBaseline.Mallocs) / result.Operations
	}
	
	// Store result
	br.resultsMu.Lock()
	br.results[name] = result
	br.resultsMu.Unlock()
	
	br.logger.Info("Benchmark completed",
		zap.String("name", name),
		zap.Uint64("operations", result.Operations),
		zap.Duration("duration", result.Duration),
		zap.Float64("ops_per_sec", result.OpsPerSecond),
		zap.Duration("avg_latency", result.AvgLatency),
		zap.Uint64("memory_used", result.MemoryUsed),
	)
	
	return result, nil
}

// RunMiningBenchmark runs mining-specific benchmarks
func (br *BenchmarkRunner) RunMiningBenchmark(name string, hashFn func() (uint64, error)) (*BenchmarkResult, error) {
	var hashes atomic.Uint64
	
	fn := func(ctx context.Context) error {
		h, err := hashFn()
		if err == nil {
			hashes.Add(h)
		}
		return err
	}
	
	result, err := br.RunBenchmark(name, fn)
	if err != nil {
		return nil, err
	}
	
	// Calculate hash rate
	totalHashes := hashes.Load()
	result.HashRate = float64(totalHashes) / result.Duration.Seconds()
	
	br.logger.Info("Mining benchmark result",
		zap.String("name", name),
		zap.Float64("hash_rate", result.HashRate),
		zap.String("hash_rate_formatted", formatHashRate(result.HashRate)),
	)
	
	return result, nil
}

// RunNetworkBenchmark runs network-specific benchmarks
func (br *BenchmarkRunner) RunNetworkBenchmark(name string, netFn func() (bytes uint64, messages uint64, err error)) (*BenchmarkResult, error) {
	var totalBytes atomic.Uint64
	var totalMessages atomic.Uint64
	
	fn := func(ctx context.Context) error {
		bytes, messages, err := netFn()
		if err == nil {
			totalBytes.Add(bytes)
			totalMessages.Add(messages)
		}
		return err
	}
	
	result, err := br.RunBenchmark(name, fn)
	if err != nil {
		return nil, err
	}
	
	// Calculate network metrics
	result.BytesPerSecond = uint64(float64(totalBytes.Load()) / result.Duration.Seconds())
	result.MessagesPerSec = uint64(float64(totalMessages.Load()) / result.Duration.Seconds())
	
	br.logger.Info("Network benchmark result",
		zap.String("name", name),
		zap.Uint64("bytes_per_sec", result.BytesPerSecond),
		zap.Uint64("messages_per_sec", result.MessagesPerSec),
	)
	
	return result, nil
}

// CompareResults compares two benchmark results
func (br *BenchmarkRunner) CompareResults(name1, name2 string) (*Comparison, error) {
	br.resultsMu.RLock()
	result1, ok1 := br.results[name1]
	result2, ok2 := br.results[name2]
	br.resultsMu.RUnlock()
	
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("results not found")
	}
	
	comp := &Comparison{
		Name1: name1,
		Name2: name2,
		
		SpeedupFactor:     result1.OpsPerSecond / result2.OpsPerSecond,
		LatencyReduction:  float64(result2.AvgLatency-result1.AvgLatency) / float64(result2.AvgLatency) * 100,
		MemoryReduction:   float64(int64(result2.MemoryUsed)-int64(result1.MemoryUsed)) / float64(result2.MemoryUsed) * 100,
		
		Result1: result1,
		Result2: result2,
	}
	
	return comp, nil
}

// GetReport generates a benchmark report
func (br *BenchmarkRunner) GetReport() *Report {
	br.resultsMu.RLock()
	defer br.resultsMu.RUnlock()
	
	report := &Report{
		Timestamp: time.Now(),
		Results:   make([]*BenchmarkResult, 0, len(br.results)),
	}
	
	for _, result := range br.results {
		report.Results = append(report.Results, result)
	}
	
	return report
}

// Private methods

func (br *BenchmarkRunner) warmup(fn BenchmarkFunc) {
	ctx := context.Background()
	for i := 0; i < br.warmupRuns; i++ {
		fn(ctx)
	}
	
	// Let CPU cool down
	time.Sleep(100 * time.Millisecond)
}

func (br *BenchmarkRunner) calculatePercentiles(result *BenchmarkResult) {
	if len(result.latencies) == 0 {
		return
	}
	
	// Sort latencies (simple bubble sort for now - can optimize later)
	latencies := make([]time.Duration, len(result.latencies))
	copy(latencies, result.latencies)
	
	for i := 0; i < len(latencies)-1; i++ {
		for j := 0; j < len(latencies)-i-1; j++ {
			if latencies[j] > latencies[j+1] {
				latencies[j], latencies[j+1] = latencies[j+1], latencies[j]
			}
		}
	}
	
	// Calculate percentiles
	p50Idx := len(latencies) * 50 / 100
	p95Idx := len(latencies) * 95 / 100
	p99Idx := len(latencies) * 99 / 100
	
	if p50Idx < len(latencies) {
		result.P50Latency = latencies[p50Idx]
	}
	if p95Idx < len(latencies) {
		result.P95Latency = latencies[p95Idx]
	}
	if p99Idx < len(latencies) {
		result.P99Latency = latencies[p99Idx]
	}
}

// Comparison stores benchmark comparison results
type Comparison struct {
	Name1 string
	Name2 string
	
	SpeedupFactor    float64 // >1 means Name1 is faster
	LatencyReduction float64 // Percentage reduction
	MemoryReduction  float64 // Percentage reduction
	
	Result1 *BenchmarkResult
	Result2 *BenchmarkResult
}

// Report contains all benchmark results
type Report struct {
	Timestamp time.Time
	Results   []*BenchmarkResult
}

// Utility functions

func formatHashRate(hashRate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s"}
	unitIdx := 0
	
	for hashRate >= 1000 && unitIdx < len(units)-1 {
		hashRate /= 1000
		unitIdx++
	}
	
	return fmt.Sprintf("%.2f %s", hashRate, units[unitIdx])
}

// OptimizationSuggestions analyzes results and provides suggestions
func (br *BenchmarkRunner) OptimizationSuggestions(result *BenchmarkResult) []string {
	suggestions := []string{}
	
	// Memory optimization suggestions
	if result.AllocsPerOp > 100 {
		suggestions = append(suggestions, "High allocation rate detected. Consider object pooling.")
	}
	
	if result.MemoryUsed > 100*1024*1024 { // 100MB
		suggestions = append(suggestions, "High memory usage. Review data structures and consider streaming.")
	}
	
	// Latency optimization suggestions
	if result.P99Latency > 10*result.P50Latency {
		suggestions = append(suggestions, "High latency variance. Check for blocking operations.")
	}
	
	if result.AvgLatency > 100*time.Millisecond {
		suggestions = append(suggestions, "High average latency. Consider async processing or caching.")
	}
	
	// Throughput suggestions
	if result.OpsPerSecond < 1000 {
		suggestions = append(suggestions, "Low throughput. Profile CPU usage and check for bottlenecks.")
	}
	
	return suggestions
}