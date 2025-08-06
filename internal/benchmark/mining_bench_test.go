package benchmark

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/crypto"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/memory"
	"go.uber.org/zap/zaptest"
)

// BenchmarkSHA256 benchmarks SHA256 hashing performance
func BenchmarkSHA256(b *testing.B) {
	data := make([]byte, 80) // Bitcoin block header size
	for i := range data {
		data[i] = byte(i)
	}

	b.Run("Standard", func(b *testing.B) {
		b.SetBytes(80)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = crypto.SHA256(data)
		}
	})

	b.Run("Optimized", func(b *testing.B) {
		hasher := crypto.NewSHA256Optimized()
		b.SetBytes(80)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = hasher.Hash(data)
		}
	})

	b.Run("DoubleSHA256", func(b *testing.B) {
		hasher := crypto.NewSHA256Optimized()
		b.SetBytes(80)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = hasher.HashDouble(data)
		}
	})
}

// BenchmarkBatchHashing benchmarks parallel hash processing
func BenchmarkBatchHashing(b *testing.B) {
	sizes := []int{10, 100, 1000}
	
	for _, size := range sizes {
		b.Run("BatchSize="+string(rune(size)), func(b *testing.B) {
			// Prepare batch
			inputs := make([][]byte, size)
			for i := range inputs {
				inputs[i] = make([]byte, 80)
			}
			
			hasher := crypto.NewSHA256Optimized()
			b.SetBytes(int64(size * 80))
			b.ResetTimer()
			
			for i := 0; i < b.N; i++ {
				_ = hasher.BatchHash(inputs)
			}
		})
	}
}

// BenchmarkMiningEngine benchmarks the mining engine
func BenchmarkMiningEngine(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	configs := []struct {
		name    string
		threads int
	}{
		{"SingleThread", 1},
		{"QuadThread", 4},
		{"AllCores", runtime.NumCPU()},
	}
	
	for _, cfg := range configs {
		b.Run(cfg.name, func(b *testing.B) {
			engine, err := mining.NewUnifiedEngine(logger, &mining.Config{
				CPUThreads:   cfg.threads,
				Algorithm:    "sha256d",
				MaxMemoryMB:  1024,
				JobQueueSize: 100,
			})
			if err != nil {
				b.Fatal(err)
			}
			
			engine.Start()
			defer engine.Stop()
			
			job := &mining.Job{
				ID:         "bench-job",
				Height:     1000,
				Difficulty: 1,
			}
			
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				share := &mining.Share{
					JobID:    job.ID,
					WorkerID: "bench",
					Nonce:    uint64(i),
				}
				_ = engine.SubmitShare(share)
			}
		})
	}
}

// BenchmarkHardwareAcceleratedMining benchmarks hardware-accelerated mining
func BenchmarkHardwareAcceleratedMining(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	workers := []int{1, 2, 4, 8}
	
	for _, w := range workers {
		b.Run("Workers="+string(rune(w)), func(b *testing.B) {
			miner := mining.NewHardwareAcceleratedMiner(logger, w)
			
			job := &mining.Job{
				ID:         "bench-job",
				Height:     1000,
				Difficulty: 1000000, // High difficulty to prevent finding shares
			}
			
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_, _ = miner.Mine(ctx, job)
			}
			
			hashRate := miner.GetHashRate()
			b.ReportMetric(hashRate, "hashes/op")
		})
	}
}

// BenchmarkMemoryPool benchmarks memory pool performance
func BenchmarkMemoryPool(b *testing.B) {
	pool := memory.NewOptimizedMemoryPool()
	
	sizes := []int{64, 256, 1024, 4096}
	
	for _, size := range sizes {
		b.Run("Size="+string(rune(size)), func(b *testing.B) {
			b.SetBytes(int64(size))
			b.ResetTimer()
			
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					buf := pool.Get(size)
					pool.Put(buf)
				}
			})
		})
	}
}

// BenchmarkMiningMemory benchmarks mining-specific memory operations
func BenchmarkMiningMemory(b *testing.B) {
	mem := mining.NewOptimizedMiningMemory()
	
	b.Run("ShareAllocation", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				share := mem.GetShare()
				mem.PutShare(share)
			}
		})
	})
	
	b.Run("JobAllocation", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				job := mem.GetJob()
				mem.PutJob(job)
			}
		})
	})
	
	b.Run("HashBuffer", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				buf := mem.GetHashBuffer(80)
				mem.PutHashBuffer(buf)
			}
		})
	})
}

// BenchmarkJobQueue benchmarks job queue operations
func BenchmarkJobQueue(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	queue := mining.NewOptimizedJobQueue(logger, mining.QueueConfig{
		RingSize: 4096,
		MaxJobs:  10000,
	})
	defer queue.Close()
	
	// Pre-fill with jobs
	for i := 0; i < 1000; i++ {
		job := &mining.Job{
			ID:     string(rune(i)),
			Height: uint64(i),
		}
		queue.Enqueue(job)
	}
	
	b.Run("Enqueue", func(b *testing.B) {
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			i := 0
			for pb.Next() {
				job := &mining.Job{
					ID:     string(rune(i)),
					Height: uint64(i),
				}
				_ = queue.Enqueue(job)
				i++
			}
		})
	})
	
	b.Run("Dequeue", func(b *testing.B) {
		ctx := context.Background()
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				_, _ = queue.Dequeue(ctx)
			}
		})
	})
	
	b.Run("EnqueueDequeue", func(b *testing.B) {
		ctx := context.Background()
		b.ResetTimer()
		b.RunParallel(func(pb *testing.PB) {
			i := 0
			for pb.Next() {
				if i%2 == 0 {
					job := &mining.Job{
						ID:     string(rune(i)),
						Height: uint64(i),
					}
					_ = queue.Enqueue(job)
				} else {
					_, _ = queue.Dequeue(ctx)
				}
				i++
			}
		})
	})
}

// BenchmarkDifficultyAdjustment benchmarks difficulty adjustment algorithms
func BenchmarkDifficultyAdjustment(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	algorithms := []mining.AdjustmentAlgorithm{
		mining.AlgorithmSimple,
		mining.AlgorithmEMA,
		mining.AlgorithmPID,
		mining.AlgorithmKalman,
		mining.AlgorithmRegression,
	}
	
	for _, algo := range algorithms {
		b.Run(string(algo), func(b *testing.B) {
			adjuster := mining.NewDifficultyAdjuster(logger, mining.DifficultyConfig{
				Algorithm:       algo,
				TargetTime:      10 * time.Second,
				StartDifficulty: 1000,
				BufferSize:      100,
			})
			
			// Pre-fill with share times
			now := time.Now()
			for i := 0; i < 100; i++ {
				adjuster.RecordShare(now.Add(time.Duration(i) * 10 * time.Second))
			}
			
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = adjuster.AdjustDifficulty()
			}
		})
	}
}

// BenchmarkSIMDOperations benchmarks SIMD-specific operations
func BenchmarkSIMDOperations(b *testing.B) {
	hasher := crypto.NewSIMDHasher("sha256d")
	
	batchSizes := []int{4, 8, 16, 32}
	
	for _, size := range batchSizes {
		b.Run("Batch="+string(rune(size)), func(b *testing.B) {
			inputs := make([][]byte, size)
			for i := range inputs {
				inputs[i] = make([]byte, 80)
			}
			
			b.SetBytes(int64(size * 80))
			b.ResetTimer()
			
			for i := 0; i < b.N; i++ {
				_ = hasher.HashParallel(inputs)
			}
		})
	}
}

// BenchmarkConcurrentMining simulates real-world concurrent mining
func BenchmarkConcurrentMining(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	engine, _ := mining.NewUnifiedEngine(logger, &mining.Config{
		CPUThreads:   runtime.NumCPU(),
		Algorithm:    "sha256d",
		MaxMemoryMB:  2048,
		JobQueueSize: 1000,
	})
	
	engine.Start()
	defer engine.Stop()
	
	// Simulate multiple workers
	workers := runtime.NumCPU()
	
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		workerID := string(rune(runtime.NumGoroutine() % workers))
		i := 0
		
		for pb.Next() {
			share := &mining.Share{
				JobID:    "bench-job",
				WorkerID: workerID,
				Nonce:    uint64(i),
			}
			_ = engine.SubmitShare(share)
			i++
		}
	})
	
	stats := engine.GetStats()
	b.ReportMetric(float64(stats.SharesSubmitted)/b.Elapsed().Seconds(), "shares/sec")
}

// BenchmarkEndToEndMining benchmarks complete mining pipeline
func BenchmarkEndToEndMining(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	// Create components
	mem := mining.NewOptimizedMiningMemory()
	queue := mining.NewOptimizedJobQueue(logger, mining.QueueConfig{
		RingSize: 4096,
		MaxJobs:  10000,
	})
	engine, _ := mining.NewUnifiedEngine(logger, &mining.Config{
		CPUThreads:   runtime.NumCPU(),
		Algorithm:    "sha256d",
		MaxMemoryMB:  2048,
		JobQueueSize: 1000,
	})
	
	engine.Start()
	defer engine.Stop()
	defer queue.Close()
	
	// Create job producer
	go func() {
		for i := 0; ; i++ {
			job := mem.GetJob()
			job.ID = string(rune(i))
			job.Height = uint64(i)
			
			if err := queue.Enqueue(job); err != nil {
				mem.PutJob(job)
			}
			
			time.Sleep(100 * time.Millisecond)
		}
	}()
	
	// Create job consumer and miner
	ctx := context.Background()
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Get job from queue
		job, err := queue.Dequeue(ctx)
		if err != nil {
			continue
		}
		
		// Mine
		share := mem.GetShare()
		share.JobID = job.ID
		share.WorkerID = "bench"
		share.Nonce = uint64(i)
		
		// Submit
		_ = engine.SubmitShare(share)
		
		// Return to pool
		mem.PutShare(share)
		mem.PutJob(job)
	}
}