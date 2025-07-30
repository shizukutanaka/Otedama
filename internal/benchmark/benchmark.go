package benchmark

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/mining/algorithms"
	"github.com/shizukutanaka/Otedama/internal/zkp"
	"go.uber.org/zap"
)

// Benchmarker runs performance benchmarks for various components
type Benchmarker struct {
	logger       *zap.Logger
	results      map[string]*BenchmarkResult
	mu           sync.RWMutex
}

// BenchmarkResult stores benchmark results
type BenchmarkResult struct {
	Name         string
	Category     string
	Operations   int64
	Duration     time.Duration
	OpsPerSecond float64
	AllocBytes   uint64
	AllocObjects uint64
	CPUUsage     float64
	MemoryUsage  float64
	Metrics      map[string]interface{}
	Timestamp    time.Time
}

// NewBenchmarker creates a new benchmarker
func NewBenchmarker(logger *zap.Logger) *Benchmarker {
	return &Benchmarker{
		logger:  logger,
		results: make(map[string]*BenchmarkResult),
	}
}

// RunAllBenchmarks runs all available benchmarks
func (b *Benchmarker) RunAllBenchmarks(ctx context.Context) error {
	b.logger.Info("Starting comprehensive benchmarks")
	
	// Mining benchmarks
	if err := b.RunMiningBenchmarks(ctx); err != nil {
		b.logger.Error("Mining benchmarks failed", zap.Error(err))
	}
	
	// ZKP benchmarks
	if err := b.RunZKPBenchmarks(ctx); err != nil {
		b.logger.Error("ZKP benchmarks failed", zap.Error(err))
	}
	
	// Memory benchmarks
	if err := b.RunMemoryBenchmarks(ctx); err != nil {
		b.logger.Error("Memory benchmarks failed", zap.Error(err))
	}
	
	// Network benchmarks
	if err := b.RunNetworkBenchmarks(ctx); err != nil {
		b.logger.Error("Network benchmarks failed", zap.Error(err))
	}
	
	b.logger.Info("Benchmarks completed", zap.Int("total_results", len(b.results)))
	
	return nil
}

// RunMiningBenchmarks benchmarks mining algorithms
func (b *Benchmarker) RunMiningBenchmarks(ctx context.Context) error {
	b.logger.Info("Running mining benchmarks")
	
	// Test data
	testBlock := []byte("00000000000000000000000000000000000000000000000000000000000000000000000000000000")
	
	algorithms := []string{"sha256d", "ethash", "kawpow", "randomx", "scrypt"}
	
	for _, algo := range algorithms {
		result := b.benchmarkMiningAlgorithm(ctx, algo, testBlock)
		b.storeResult(result)
		
		b.logger.Info("Mining benchmark completed",
			zap.String("algorithm", algo),
			zap.Float64("hashrate_mhs", result.OpsPerSecond/1000000),
		)
	}
	
	return nil
}

// benchmarkMiningAlgorithm benchmarks a specific mining algorithm
func (b *Benchmarker) benchmarkMiningAlgorithm(ctx context.Context, algorithm string, data []byte) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      fmt.Sprintf("mining_%s", algorithm),
		Category:  "mining",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	// Get initial memory stats
	var memStatsBefore runtime.MemStats
	runtime.ReadMemStats(&memStatsBefore)
	
	// Run benchmark
	start := time.Now()
	operations := int64(0)
	
	// Create algorithm instance
	var hasher algorithms.Algorithm
	switch algorithm {
	case "sha256d":
		hasher = algorithms.NewSHA256d()
	case "ethash":
		hasher = algorithms.NewEthash()
	case "kawpow":
		hasher = algorithms.NewKawPow()
	case "randomx":
		hasher = algorithms.NewRandomX()
	case "scrypt":
		hasher = algorithms.NewScrypt()
	default:
		hasher = algorithms.NewSHA256d()
	}
	
	// Benchmark for 5 seconds or until context is done
	deadline := start.Add(5 * time.Second)
	nonce := uint64(0)
	
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			break
		default:
			// Compute hash
			_, _ = hasher.ComputeHash(data, nonce)
			nonce++
			operations++
			
			// Check every 1000 operations
			if operations%1000 == 0 && time.Now().After(deadline) {
				break
			}
		}
	}
	
	duration := time.Since(start)
	
	// Get final memory stats
	var memStatsAfter runtime.MemStats
	runtime.ReadMemStats(&memStatsAfter)
	
	// Calculate results
	result.Operations = operations
	result.Duration = duration
	result.OpsPerSecond = float64(operations) / duration.Seconds()
	result.AllocBytes = memStatsAfter.TotalAlloc - memStatsBefore.TotalAlloc
	result.AllocObjects = memStatsAfter.Mallocs - memStatsBefore.Mallocs
	
	// Algorithm-specific metrics
	result.Metrics["algorithm"] = algorithm
	result.Metrics["hashrate_mhs"] = result.OpsPerSecond / 1000000
	result.Metrics["watts_per_mhs"] = 50.0 // Placeholder
	result.Metrics["efficiency"] = result.OpsPerSecond / float64(result.AllocBytes)
	
	return result
}

// RunZKPBenchmarks benchmarks zero-knowledge proof operations
func (b *Benchmarker) RunZKPBenchmarks(ctx context.Context) error {
	b.logger.Info("Running ZKP benchmarks")
	
	// Test ZKP proof generation and verification
	protocols := []zkp.ProofProtocol{
		zkp.ProtocolGroth16,
		zkp.ProtocolPLONK,
		zkp.ProtocolSTARK,
		zkp.ProtocolBulletproofs,
	}
	
	for _, protocol := range protocols {
		// Benchmark proof generation
		genResult := b.benchmarkZKPGeneration(ctx, protocol)
		b.storeResult(genResult)
		
		// Benchmark proof verification
		verResult := b.benchmarkZKPVerification(ctx, protocol)
		b.storeResult(verResult)
		
		b.logger.Info("ZKP benchmark completed",
			zap.String("protocol", string(protocol)),
			zap.Float64("gen_ops_per_sec", genResult.OpsPerSecond),
			zap.Float64("ver_ops_per_sec", verResult.OpsPerSecond),
		)
	}
	
	return nil
}

// benchmarkZKPGeneration benchmarks ZKP proof generation
func (b *Benchmarker) benchmarkZKPGeneration(ctx context.Context, protocol zkp.ProofProtocol) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      fmt.Sprintf("zkp_gen_%s", protocol),
		Category:  "zkp",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	// Simplified benchmark - in production would use actual ZKP operations
	start := time.Now()
	operations := int64(0)
	deadline := start.Add(2 * time.Second)
	
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			break
		default:
			// Simulate proof generation
			time.Sleep(10 * time.Millisecond) // Placeholder
			operations++
		}
	}
	
	duration := time.Since(start)
	
	result.Operations = operations
	result.Duration = duration
	result.OpsPerSecond = float64(operations) / duration.Seconds()
	result.Metrics["protocol"] = string(protocol)
	result.Metrics["avg_proof_size_bytes"] = getProofSize(protocol)
	result.Metrics["avg_generation_time_ms"] = duration.Milliseconds() / operations
	
	return result
}

// benchmarkZKPVerification benchmarks ZKP proof verification
func (b *Benchmarker) benchmarkZKPVerification(ctx context.Context, protocol zkp.ProofProtocol) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      fmt.Sprintf("zkp_verify_%s", protocol),
		Category:  "zkp",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	// Simplified benchmark
	start := time.Now()
	operations := int64(0)
	deadline := start.Add(2 * time.Second)
	
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			break
		default:
			// Simulate proof verification
			time.Sleep(1 * time.Millisecond) // Placeholder
			operations++
		}
	}
	
	duration := time.Since(start)
	
	result.Operations = operations
	result.Duration = duration
	result.OpsPerSecond = float64(operations) / duration.Seconds()
	result.Metrics["protocol"] = string(protocol)
	result.Metrics["avg_verification_time_ms"] = duration.Milliseconds() / operations
	
	return result
}

// RunMemoryBenchmarks benchmarks memory operations
func (b *Benchmarker) RunMemoryBenchmarks(ctx context.Context) error {
	b.logger.Info("Running memory benchmarks")
	
	// Benchmark memory allocation
	allocResult := b.benchmarkMemoryAllocation(ctx)
	b.storeResult(allocResult)
	
	// Benchmark memory pool
	poolResult := b.benchmarkMemoryPool(ctx)
	b.storeResult(poolResult)
	
	return nil
}

// benchmarkMemoryAllocation benchmarks memory allocation performance
func (b *Benchmarker) benchmarkMemoryAllocation(ctx context.Context) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      "memory_allocation",
		Category:  "memory",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	sizes := []int{1024, 4096, 16384, 65536} // 1KB, 4KB, 16KB, 64KB
	totalOps := int64(0)
	
	start := time.Now()
	
	for _, size := range sizes {
		ops := int64(0)
		allocStart := time.Now()
		
		for i := 0; i < 10000; i++ {
			select {
			case <-ctx.Done():
				break
			default:
				// Allocate and use memory
				buf := make([]byte, size)
				buf[0] = 1 // Touch memory
				ops++
			}
		}
		
		allocDuration := time.Since(allocStart)
		result.Metrics[fmt.Sprintf("alloc_%d_ops_per_sec", size)] = float64(ops) / allocDuration.Seconds()
		totalOps += ops
	}
	
	duration := time.Since(start)
	
	result.Operations = totalOps
	result.Duration = duration
	result.OpsPerSecond = float64(totalOps) / duration.Seconds()
	
	return result
}

// benchmarkMemoryPool benchmarks memory pool performance
func (b *Benchmarker) benchmarkMemoryPool(ctx context.Context) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      "memory_pool",
		Category:  "memory",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	// Create a simple memory pool
	pool := sync.Pool{
		New: func() interface{} {
			return make([]byte, 4096)
		},
	}
	
	start := time.Now()
	operations := int64(0)
	deadline := start.Add(2 * time.Second)
	
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			break
		default:
			// Get from pool
			buf := pool.Get().([]byte)
			
			// Use buffer
			buf[0] = 1
			
			// Return to pool
			pool.Put(buf)
			
			operations++
		}
	}
	
	duration := time.Since(start)
	
	result.Operations = operations
	result.Duration = duration
	result.OpsPerSecond = float64(operations) / duration.Seconds()
	result.Metrics["pool_efficiency"] = result.OpsPerSecond / 1000 // Normalized
	
	return result
}

// RunNetworkBenchmarks benchmarks network operations
func (b *Benchmarker) RunNetworkBenchmarks(ctx context.Context) error {
	b.logger.Info("Running network benchmarks")
	
	// Benchmark serialization
	serResult := b.benchmarkSerialization(ctx)
	b.storeResult(serResult)
	
	// Benchmark message processing
	msgResult := b.benchmarkMessageProcessing(ctx)
	b.storeResult(msgResult)
	
	return nil
}

// benchmarkSerialization benchmarks message serialization
func (b *Benchmarker) benchmarkSerialization(ctx context.Context) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      "network_serialization",
		Category:  "network",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	// Test message
	testMsg := map[string]interface{}{
		"type":      "share",
		"miner":     "test_miner",
		"nonce":     uint64(12345),
		"hash":      "0000000000000000000000000000000000000000000000000000000000000000",
		"timestamp": time.Now().Unix(),
	}
	
	start := time.Now()
	operations := int64(0)
	deadline := start.Add(2 * time.Second)
	
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			break
		default:
			// Serialize
			data, _ := json.Marshal(testMsg)
			
			// Deserialize
			var msg map[string]interface{}
			json.Unmarshal(data, &msg)
			
			operations++
		}
	}
	
	duration := time.Since(start)
	
	result.Operations = operations
	result.Duration = duration
	result.OpsPerSecond = float64(operations) / duration.Seconds()
	result.Metrics["avg_message_size_bytes"] = 150 // Approximate
	result.Metrics["throughput_mbps"] = (result.OpsPerSecond * 150 * 8) / 1000000
	
	return result
}

// benchmarkMessageProcessing benchmarks message processing
func (b *Benchmarker) benchmarkMessageProcessing(ctx context.Context) *BenchmarkResult {
	result := &BenchmarkResult{
		Name:      "network_message_processing",
		Category:  "network",
		Timestamp: time.Now(),
		Metrics:   make(map[string]interface{}),
	}
	
	// Simulate message queue processing
	msgQueue := make(chan interface{}, 1000)
	
	// Fill queue
	for i := 0; i < 1000; i++ {
		msgQueue <- i
	}
	
	start := time.Now()
	operations := int64(0)
	deadline := start.Add(2 * time.Second)
	
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			break
		case <-msgQueue:
			// Process message
			operations++
			
			// Refill if empty
			if len(msgQueue) == 0 {
				for i := 0; i < 100; i++ {
					msgQueue <- i
				}
			}
		default:
			// Queue empty
			break
		}
	}
	
	duration := time.Since(start)
	
	result.Operations = operations
	result.Duration = duration
	result.OpsPerSecond = float64(operations) / duration.Seconds()
	result.Metrics["queue_throughput"] = result.OpsPerSecond
	result.Metrics["avg_latency_us"] = duration.Microseconds() / operations
	
	return result
}

// storeResult stores a benchmark result
func (b *Benchmarker) storeResult(result *BenchmarkResult) {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	b.results[result.Name] = result
}

// GetResults returns all benchmark results
func (b *Benchmarker) GetResults() map[string]*BenchmarkResult {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	results := make(map[string]*BenchmarkResult)
	for k, v := range b.results {
		results[k] = v
	}
	
	return results
}

// GenerateReport generates a benchmark report
func (b *Benchmarker) GenerateReport() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	report := "=== Otedama Performance Benchmark Report ===\n\n"
	
	// Group by category
	categories := make(map[string][]*BenchmarkResult)
	for _, result := range b.results {
		categories[result.Category] = append(categories[result.Category], result)
	}
	
	// Generate report for each category
	for category, results := range categories {
		report += fmt.Sprintf("## %s Benchmarks\n\n", category)
		
		for _, result := range results {
			report += fmt.Sprintf("### %s\n", result.Name)
			report += fmt.Sprintf("- Operations: %d\n", result.Operations)
			report += fmt.Sprintf("- Duration: %v\n", result.Duration)
			report += fmt.Sprintf("- Ops/Second: %.2f\n", result.OpsPerSecond)
			
			if result.AllocBytes > 0 {
				report += fmt.Sprintf("- Memory Allocated: %d bytes\n", result.AllocBytes)
			}
			
			// Add metrics
			for key, value := range result.Metrics {
				report += fmt.Sprintf("- %s: %v\n", key, value)
			}
			
			report += "\n"
		}
	}
	
	return report
}

// Helper functions

func getProofSize(protocol zkp.ProofProtocol) int {
	switch protocol {
	case zkp.ProtocolGroth16:
		return 200
	case zkp.ProtocolPLONK:
		return 400
	case zkp.ProtocolSTARK:
		return 45 * 1024
	case zkp.ProtocolBulletproofs:
		return 1500
	default:
		return 1000
	}
}