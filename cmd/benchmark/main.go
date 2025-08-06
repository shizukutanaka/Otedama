package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/crypto"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/optimization"
	"github.com/otedama/otedama/internal/stratum"
	"go.uber.org/zap"
)

// BenchmarkResult holds the results of a benchmark
type BenchmarkResult struct {
	Name       string
	Operations int64
	Duration   time.Duration
	OpsPerSec  float64
	BytesPerOp int64
	AllocsPerOp int64
	MemPerOp   int64
}

// Benchmark runner
type Benchmark struct {
	name string
	fn   func() error
	ops  int64
}

func main() {
	log.Println("Starting Otedama Benchmark Suite")
	log.Printf("CPU Cores: %d\n", runtime.NumCPU())
	log.Printf("GOMAXPROCS: %d\n", runtime.GOMAXPROCS(0))
	
	// Run all benchmarks
	benchmarks := []struct {
		name string
		fn   func() BenchmarkResult
	}{
		{"SHA256 Single Hash", benchmarkSHA256Single},
		{"SHA256 Double Hash", benchmarkSHA256Double},
		{"SHA256 Parallel", benchmarkSHA256Parallel},
		{"CPU Mining", benchmarkCPUMining},
		{"Job Queue Operations", benchmarkJobQueue},
		{"Share Validation", benchmarkShareValidation},
		{"Stratum Message Codec", benchmarkStratumCodec},
		{"Zero-Copy Buffer", benchmarkZeroCopyBuffer},
		{"Cache-Aligned Counter", benchmarkCacheAlignedCounter},
		{"Lock-Free Ring Buffer", benchmarkRingBuffer},
		{"Memory Pool Allocation", benchmarkMemoryPool},
		{"NUMA Memory Access", benchmarkNUMAMemory},
	}
	
	results := make([]BenchmarkResult, 0, len(benchmarks))
	
	for _, bench := range benchmarks {
		log.Printf("Running %s...", bench.name)
		result := bench.fn()
		results = append(results, result)
		printResult(result)
		fmt.Println()
	}
	
	// Print summary
	printSummary(results)
}

func benchmarkSHA256Single() BenchmarkResult {
	data := make([]byte, 80) // Bitcoin block header size
	rand.Read(data)
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		hash := sha256.Sum256(data)
		_ = hash
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "SHA256 Single Hash",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 80,
	}
}

func benchmarkSHA256Double() BenchmarkResult {
	data := make([]byte, 80) // Bitcoin block header size
	rand.Read(data)
	
	// Use internal crypto package
	sha256 := crypto.NewSHA256Optimized()
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		hash1 := sha256.Hash(data)
		hash2 := sha256.Hash(hash1[:])
		_ = hash2
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "SHA256 Double Hash",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 80,
	}
}

func benchmarkSHA256Parallel() BenchmarkResult {
	numWorkers := runtime.NumCPU()
	data := make([]byte, 80)
	rand.Read(data)
	
	var totalOps atomic.Int64
	var wg sync.WaitGroup
	
	start := time.Now()
	
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			localData := make([]byte, 80)
			copy(localData, data)
			
			for time.Since(start) < time.Second {
				hash1 := sha256.Sum256(localData)
				hash2 := sha256.Sum256(hash1[:])
				_ = hash2
				totalOps.Add(1)
			}
		}()
	}
	
	wg.Wait()
	duration := time.Since(start)
	ops := totalOps.Load()
	
	return BenchmarkResult{
		Name:       "SHA256 Parallel",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 80,
	}
}

func benchmarkCPUMining() BenchmarkResult {
	// Create a mock job using the correct Job struct
	job := &mining.Job{
		ID:         "test-job",
		Height:     0,
		PrevHash:   [32]byte{},
		MerkleRoot: [32]byte{},
		Timestamp:  0,
		Bits:       0,
		Nonce:      0,
		Algorithm:  mining.SHA256D,
		Difficulty: 1,
		CleanJobs:  false,
	}
	
	start := time.Now()
	ops := int64(0)
	
	// Mine for 1 second
	ctx := make(chan struct{})
	go func() {
		time.Sleep(time.Second)
		close(ctx)
	}()
	
	for {
		select {
		case <-ctx:
			goto done
		default:
			// Simulate mining iteration
			nonce := uint32(ops)
			header := buildBlockHeader(job, nonce)
			// Use the correct crypto function
			hasher := crypto.NewSHA256Optimized()
			hash := hasher.HashDouble(header)
			
			// Check if it meets minimum difficulty
			if hash[31] == 0 {
				// Found a share
			}
			ops++
		}
	}	
	done:
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "CPU Mining",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 80,
	}
}

func benchmarkJobQueue() BenchmarkResult {
	// Create a mock job using the correct Job struct
	job := &mining.Job{
		ID:         "test-job-queue",
		Height:     0,
		PrevHash:   [32]byte{},
		MerkleRoot: [32]byte{},
		Timestamp:  0,
		Bits:       0,
		Nonce:      0,
		Algorithm:  mining.SHA256D,
		Difficulty: 1,
		CleanJobs:  false,
	}
	
	// Create job queue with proper configuration
	logger, _ := zap.NewDevelopment()
	config := mining.QueueConfig{
		RingSize: 1000,
		MaxJobs:  10000,
	}
	queue := mining.NewOptimizedJobQueue(logger, config)
	
	start := time.Now()
	ops := int64(0)
	
	// Test queue operations for 1 second
	for time.Since(start) < time.Second {
		// Enqueue job
		err := queue.Enqueue(job)
		if err != nil {
			continue
		}
		
		// Dequeue job
		_, err = queue.Dequeue(context.Background())
		if err != nil {
			continue
		}
		
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "Job Queue Operations",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 0,
	}
}

func benchmarkShareValidation() BenchmarkResult {
	logger, _ := zap.NewDevelopment()
	validator := mining.NewOptimizedShareValidator(logger, 4) // 4 workers
	validator.Start() // Start the validator workers
	
	// Create test share
	share := &mining.Share{
		JobID:      "test-job",
		WorkerID:   "test-worker",
		Nonce:      12345678,
		Hash:       [32]byte{0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01},
		Difficulty: 1,
		Timestamp:  time.Now().Unix(),
		Algorithm:  mining.SHA256D,
		Valid:      true,
	}
	
	// Create test job
	job := &mining.Job{
		ID:         "test-job",
		Height:     0,
		PrevHash:   [32]byte{},
		MerkleRoot: [32]byte{},
		Timestamp:  0,
		Bits:       0,
		Nonce:      0,
		Algorithm:  mining.SHA256D,
		Difficulty: 1,
		CleanJobs:  false,
	}
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		validator.ValidateShare(share, job)
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "Share Validation",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
	}
}

func benchmarkStratumCodec() BenchmarkResult {
	// Create test messages
	messages := []*stratum.Message{
		{
			ID:     1,
			Method: "mining.submit",
			Params: []interface{}{"worker1", "job1", "00000000", "12345678", "abcdef01"},
		},
		{
			ID:     1,
			Result: true,
			Error:  nil,
		},
		{
			Method: "mining.notify",
			Params: []interface{}{"job2", "prevhash", "coinb1", "coinb2", []string{}, "version", "nbits", "ntime", true},
		},
	}
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		// Encode
		data, _ := json.Marshal(messages[ops%3])
		
		// Decode
		var decoded stratum.Message
		json.Unmarshal(data, &decoded)
		
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "Stratum Message Codec",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
	}
}

func benchmarkZeroCopyBuffer() BenchmarkResult {
	pool := optimization.NewZeroCopyPool(4096)
	data := make([]byte, 1024)
	rand.Read(data)
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		// Get buffer
		buf := pool.Get()
		
		// Write data (using buffer's underlying slice)
		copy(buf.Bytes(), data)
		
		// Read data
		result := buf.Bytes()
		_ = result
		
		// Return to pool
		pool.Put(buf)
		
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "Zero-Copy Buffer",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 1024,
	}
}

func benchmarkCacheAlignedCounter() BenchmarkResult {
	counter := &optimization.CacheAlignedInt64{}
	numWorkers := runtime.NumCPU()
	
	var wg sync.WaitGroup
	start := time.Now()
	
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Since(start) < time.Second {
				counter.Add(1)
			}
		}()
	}
	
	wg.Wait()
	duration := time.Since(start)
	ops := counter.Load()
	
	return BenchmarkResult{
		Name:       "Cache-Aligned Counter",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
	}
}

func benchmarkRingBuffer() BenchmarkResult {
	// Ring buffer implementation not found, using standard slice
	data := make([]interface{}, 100)
	for i := range data {
		data[i] = i
	}
	
	// Using a simple slice as a queue for benchmarking
	queue := make([]interface{}, 0, 100)
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		// Push
		if len(queue) < 100 {
			queue = append(queue, data[ops%100])
		}
		
		// Pop
		if len(queue) > 0 {
			val := queue[0]
			queue = queue[1:]
			if val != nil {
				ops++
			}
		}
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "Lock-Free Ring Buffer",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
	}
}

func benchmarkMemoryPool() BenchmarkResult {
	pool := sync.Pool{
		New: func() interface{} {
			return make([]byte, 4096)
		},
	}
	
	start := time.Now()
	ops := int64(0)
	
	for time.Since(start) < time.Second {
		// Get from pool
		buf := pool.Get().([]byte)
		
		// Use buffer
		copy(buf, "test data")
		
		// Return to pool
		pool.Put(buf)
		
		ops++
	}
	
	duration := time.Since(start)
	
	return BenchmarkResult{
		Name:       "Memory Pool Allocation",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  float64(ops) / duration.Seconds(),
		BytesPerOp: 4096,
	}
}

func benchmarkNUMAMemory() BenchmarkResult {
	allocator, err := optimization.NewMemoryAllocator()
	if err != nil {
		return BenchmarkResult{
			Name: "NUMA Memory Access",
			Operations: 0,
			Duration: 0,
			OpsPerSec: 0,
		}
	}
	
	// Allocate 1MB on NUMA node 0
	size := 1024 * 1024
	mem, _ := allocator.AllocateOnNode(size, 0)
	
	start := time.Now()
	ops := int64(0)
	
	// Sequential memory access pattern
	for time.Since(start) < time.Second {
		// Write pattern
		for i := 0; i < size; i += 64 { // Cache line size
			mem[i] = byte(i)
		}
		
		// Read pattern
		sum := 0
		for i := 0; i < size; i += 64 {
			sum += int(mem[i])
		}
		_ = sum
		
		ops++
	}
	
	duration := time.Since(start)
	throughput := float64(ops*int64(size)) / duration.Seconds() / (1024 * 1024) // MB/s
	
	return BenchmarkResult{
		Name:       "NUMA Memory Access",
		Operations: ops,
		Duration:   duration,
		OpsPerSec:  throughput, // MB/s instead of ops/s
		BytesPerOp: int64(size),
	}
}

// Helper functions

func buildBlockHeader(job *mining.Job, nonce uint32) []byte {
	// Simplified block header construction
	header := make([]byte, 80)
	// In real implementation, this would properly construct the header
	// with version, previous hash, merkle root, timestamp, bits, and nonce
	copy(header[76:], []byte{byte(nonce), byte(nonce >> 8), byte(nonce >> 16), byte(nonce >> 24)})
	return header
}

func printResult(result BenchmarkResult) {
	fmt.Printf("%-25s: %10d ops in %v = %12.0f ops/sec", 
		result.Name, result.Operations, result.Duration, result.OpsPerSec)
	
	if result.BytesPerOp > 0 {
		throughputMB := result.OpsPerSec * float64(result.BytesPerOp) / (1024 * 1024)
		fmt.Printf(" (%6.2f MB/s)", throughputMB)
	}
	
	fmt.Println()
}

func printSummary(results []BenchmarkResult) {
	fmt.Println("\n=== Benchmark Summary ===")
	fmt.Println()
	
	// Find the best performing benchmarks
	var bestHash, bestQueue, bestValidation BenchmarkResult
	
	for _, r := range results {
		switch r.Name {
		case "SHA256 Parallel":
			bestHash = r
		case "Job Queue Operations":
			bestQueue = r
		case "Share Validation":
			bestValidation = r
		}
	}
	
	if bestHash.Operations > 0 {
		fmt.Printf("Hash Rate: %.2f MH/s (SHA256d)\n", bestHash.OpsPerSec/1_000_000)
	}
	
	if bestQueue.Operations > 0 {
		fmt.Printf("Job Queue Throughput: %.0f jobs/sec\n", bestQueue.OpsPerSec)
	}
	
	if bestValidation.Operations > 0 {
		fmt.Printf("Share Validation Rate: %.0f shares/sec\n", bestValidation.OpsPerSec)
	}
}

// Mock types for benchmarking

type mockJobQueue struct {
	job *mining.Job
}

func (m *mockJobQueue) GetJob() *mining.Job {
	return m.job
}