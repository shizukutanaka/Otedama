package commands

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"github.com/shizukutanaka/Otedama/internal/memory"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/network"
	"github.com/spf13/cobra"
	"go.uber.org/zap"
)

var benchmarkCmd = &cobra.Command{
	Use:   "benchmark",
	Short: "Run performance benchmarks",
	Long:  "Run comprehensive performance benchmarks for mining, networking, and memory subsystems",
	RunE:  runBenchmark,
}

var (
	benchDuration   time.Duration
	benchType       string
	benchWorkers    int
	benchIterations int
)

func init() {
	benchmarkCmd.Flags().DurationVar(&benchDuration, "duration", 30*time.Second, "Benchmark duration")
	benchmarkCmd.Flags().StringVar(&benchType, "type", "all", "Benchmark type: all, mining, network, memory, validation")
	benchmarkCmd.Flags().IntVar(&benchWorkers, "workers", runtime.NumCPU(), "Number of concurrent workers")
	benchmarkCmd.Flags().IntVar(&benchIterations, "iterations", 1000000, "Number of iterations for quick benchmarks")
}

func runBenchmark(cmd *cobra.Command, args []string) error {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	fmt.Println("Starting Otedama Performance Benchmark")
	fmt.Printf("Type: %s, Duration: %s, Workers: %d\n\n", benchType, benchDuration, benchWorkers)

	ctx, cancel := context.WithTimeout(context.Background(), benchDuration*2)
	defer cancel()

	switch benchType {
	case "all":
		runAllBenchmarks(ctx, logger)
	case "mining":
		runMiningBenchmark(ctx, logger)
	case "network":
		runNetworkBenchmark(ctx, logger)
	case "memory":
		runMemoryBenchmark(ctx, logger)
	case "validation":
		runValidationBenchmark(ctx, logger)
	default:
		return fmt.Errorf("unknown benchmark type: %s", benchType)
	}

	return nil
}

func runAllBenchmarks(ctx context.Context, logger *zap.Logger) {
	benchmarks := []struct {
		name string
		fn   func(context.Context, *zap.Logger)
	}{
		{"Memory Management", runMemoryBenchmark},
		{"Share Validation", runValidationBenchmark},
		{"Mining Engine", runMiningBenchmark},
		{"Network Latency", runNetworkBenchmark},
	}

	for _, bench := range benchmarks {
		fmt.Printf("\n=== %s Benchmark ===\n", bench.name)
		bench.fn(ctx, logger)
	}
}

func runMemoryBenchmark(ctx context.Context, logger *zap.Logger) {
	fmt.Println("Testing optimized memory manager...")

	// Initialize unified memory manager and get global instance
	memory.Initialize(memory.DefaultMemoryConfig())
	manager := memory.Global()
	defer manager.Shutdown()

	// Test allocation performance
	sizes := []int{16, 64, 256, 1024, 4096, 16384}
	
	for _, size := range sizes {
		start := time.Now()
		allocations := 0

		deadline := time.Now().Add(benchDuration)
		for time.Now().Before(deadline) {
			buf := manager.Allocate(size)
			manager.Free(buf)
			allocations++
		}

		elapsed := time.Since(start)
		opsPerSec := float64(allocations) / elapsed.Seconds()

		fmt.Printf("Size %d bytes: %.2f million ops/sec\n", size, opsPerSec/1e6)
	}

	// Print memory stats (map[string]interface{})
	stats := manager.GetStats()
	fmt.Printf("\nMemory Statistics:\n")
	fmt.Printf("  Total Allocations: %v\n", stats["allocations"]) 
	fmt.Printf("  Total Deallocations: %v\n", stats["deallocations"]) 
	if peak, ok := stats["peak_usage"].(int64); ok {
		fmt.Printf("  Peak Usage: %.2f MB\n", float64(peak)/1024/1024)
	} else {
		fmt.Printf("  Peak Usage: %v bytes\n", stats["peak_usage"]) 
	}
}

func runValidationBenchmark(ctx context.Context, logger *zap.Logger) {
	fmt.Println("Testing share validation performance...")

	validator := mining.NewOptimizedShareValidator(logger, benchWorkers)
	validator.Start()

	// Create test job (use correct fields and types)
	var prev [32]byte
	var root [32]byte
	job := &mining.Job{
		ID:         "test-job",
		Algorithm:  mining.SHA256D,
		Difficulty: 1,
		PrevHash:   prev,
		MerkleRoot: root,
		Bits:       0x1d00ffff,
		Timestamp:  uint32(time.Now().Unix()),
	}

	// Benchmark validation
	start := time.Now()
	validations := 0
	valid := 0

	deadline := time.Now().Add(benchDuration)
	for time.Now().Before(deadline) {
		share := &mining.Share{
			JobID:     job.ID,
			Nonce:     uint64(validations),
			Timestamp: time.Now().Unix(),
		}

		result, _ := validator.ValidateShare(share, job)
		if result.Valid {
			valid++
		}
		validations++
	}

	elapsed := time.Since(start)
	validationsPerSec := float64(validations) / elapsed.Seconds()

	fmt.Printf("Validations: %.2f million/sec\n", validationsPerSec/1e6)
	fmt.Printf("Valid shares: %d (%.2f%%)\n", valid, float64(valid)/float64(validations)*100)

	// Print validator stats
	stats := validator.GetStats()
	fmt.Printf("\nValidator Statistics:\n")
	fmt.Printf("  Cache Hit Rate: %.2f%%\n", stats.CacheHitRate*100)
	fmt.Printf("  Average Time: %.2f µs\n", stats.AvgTimeMs*1000)
	fmt.Printf("  Peak Time: %.2f µs\n", stats.PeakTimeMs*1000)
}

func runMiningBenchmark(ctx context.Context, logger *zap.Logger) {
	fmt.Println("Testing mining engine performance...")

	config := &mining.Config{
		Algorithm:  "sha256d",
		CPUThreads: benchWorkers,
	}

	engine, err := mining.NewEngine(logger, config)
	if err != nil {
		fmt.Printf("Failed to create engine: %v\n", err)
		return
	}

	engine.Start()
	defer engine.Stop()

	// Let it run for benchmark duration
	time.Sleep(benchDuration)

	stats := engine.GetStats()
	fmt.Printf("Hash Rate: %.2f MH/s\n", float64(stats.TotalHashRate)/1e6)
	fmt.Printf("Shares Submitted: %d\n", stats.SharesSubmitted)
	fmt.Printf("Shares Accepted: %d\n", stats.SharesAccepted)
}

func runNetworkBenchmark(ctx context.Context, logger *zap.Logger) {
	fmt.Println("Testing network optimization...")

	config := network.OptimizerConfig{
		EnableCompression: true,
		CompressionLevel:  3,
		EnableBatching:    true,
		BatchSize:         4096,
		BatchTimeout:      10 * time.Millisecond,
		EnableTCPTuning:   true,
		EnableQuickAck:    true,
		EnableNoDelay:     true,
	}

	optimizer, err := network.NewLatencyOptimizer(logger, config)
	if err != nil {
		fmt.Printf("Failed to create optimizer: %v\n", err)
		return
	}

	// Test compression
	testData := make([]byte, 1024)
	for i := range testData {
		testData[i] = byte(i % 256)
	}

	compressionOps := 0
	compressionStart := time.Now()

	for i := 0; i < benchIterations; i++ {
		compressed, _ := optimizer.CompressMessage(testData)
		optimizer.DecompressMessage(compressed)
		compressionOps++
	}

	compressionElapsed := time.Since(compressionStart)
	compressionOpsPerSec := float64(compressionOps) / compressionElapsed.Seconds()

	fmt.Printf("Compression: %.2f million ops/sec\n", compressionOpsPerSec/1e6)

	// Test batching
	batchOps := 0
	batchStart := time.Now()
	smallMsg := make([]byte, 64)

	for i := 0; i < benchIterations; i++ {
		optimizer.BatchMessage(smallMsg)
		batchOps++
	}

	batchElapsed := time.Since(batchStart)
	batchOpsPerSec := float64(batchOps) / batchElapsed.Seconds()

	fmt.Printf("Batching: %.2f million msgs/sec\n", batchOpsPerSec/1e6)

	// Print optimization stats
	stats := optimizer.GetOptimizationStats()
	fmt.Printf("\nOptimization Statistics:\n")
	fmt.Printf("  Compression Ratio: %.2f\n", stats.CompressionRatio)
	fmt.Printf("  Messages Batched: %d\n", stats.MessagesBatched)
}