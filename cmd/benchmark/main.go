package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/shizukutanaka/Otedama/internal/benchmark"
	"github.com/shizukutanaka/Otedama/internal/profiling"
	"go.uber.org/zap"
)

func main() {
	var (
		runBenchmarks = flag.Bool("benchmark", true, "Run performance benchmarks")
		enableProfile = flag.Bool("profile", false, "Enable profiling during benchmarks")
		profileAddr   = flag.String("profile-addr", "localhost:6060", "pprof server address")
		outputFile    = flag.String("output", "benchmark-report.txt", "Output file for benchmark report")
		timeout       = flag.Duration("timeout", 5*time.Minute, "Benchmark timeout")
	)
	
	flag.Parse()
	
	// Initialize logger
	logger, err := zap.NewProduction()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync()
	
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	
	// Start profiler if enabled
	var profiler *profiling.Profiler
	if *enableProfile {
		profConfig := profiling.Config{
			Enabled:      true,
			PProfAddr:    *profileAddr,
			ProfileDir:   "./benchmark-profiles",
			CPUProfile:   true,
			MemProfile:   true,
			TraceProfile: true,
		}
		
		profiler = profiling.NewProfiler(logger, profConfig)
		if err := profiler.Start(ctx); err != nil {
			logger.Error("Failed to start profiler", zap.Error(err))
		} else {
			defer profiler.Stop()
			logger.Info("Profiler started", zap.String("pprof_addr", *profileAddr))
		}
	}
	
	// Run benchmarks
	if *runBenchmarks {
		logger.Info("Starting Otedama performance benchmarks")
		
		benchmarker := benchmark.NewBenchmarker(logger)
		
		start := time.Now()
		if err := benchmarker.RunAllBenchmarks(ctx); err != nil {
			logger.Error("Benchmark failed", zap.Error(err))
			os.Exit(1)
		}
		duration := time.Since(start)
		
		logger.Info("Benchmarks completed", 
			zap.Duration("total_duration", duration),
			zap.String("output_file", *outputFile),
		)
		
		// Generate report
		report := benchmarker.GenerateReport()
		
		// Print to console
		fmt.Println(report)
		
		// Save to file
		if err := os.WriteFile(*outputFile, []byte(report), 0644); err != nil {
			logger.Error("Failed to write report", zap.Error(err))
		}
		
		// Print summary
		results := benchmarker.GetResults()
		fmt.Println("\n=== Summary ===")
		fmt.Printf("Total benchmarks: %d\n", len(results))
		
		// Mining performance
		if result, exists := results["mining_sha256d"]; exists {
			fmt.Printf("SHA256d hashrate: %.2f MH/s\n", result.Metrics["hashrate_mhs"])
		}
		
		// ZKP performance  
		if result, exists := results["zkp_gen_groth16"]; exists {
			fmt.Printf("Groth16 proof generation: %.2f proofs/sec\n", result.OpsPerSecond)
		}
		
		if result, exists := results["zkp_verify_groth16"]; exists {
			fmt.Printf("Groth16 proof verification: %.2f verifications/sec\n", result.OpsPerSecond)
		}
		
		// Memory performance
		if result, exists := results["memory_allocation"]; exists {
			fmt.Printf("Memory allocation: %.0f ops/sec\n", result.OpsPerSecond)
		}
		
		// Network performance
		if result, exists := results["network_serialization"]; exists {
			fmt.Printf("Message serialization: %.0f msgs/sec\n", result.OpsPerSecond)
			if throughput, ok := result.Metrics["throughput_mbps"].(float64); ok {
				fmt.Printf("Network throughput: %.2f Mbps\n", throughput)
			}
		}
	}
	
	// Print profiling info if enabled
	if profiler != nil {
		stats := profiler.GetProfileStats()
		fmt.Println("\n=== Profiling Stats ===")
		if mem, ok := stats["memory"].(map[string]interface{}); ok {
			fmt.Printf("Memory allocated: %v MB\n", mem["alloc_mb"])
			fmt.Printf("Total allocated: %v MB\n", mem["total_alloc_mb"])
			fmt.Printf("GC runs: %v\n", mem["num_gc"])
		}
		if runtime, ok := stats["runtime"].(map[string]interface{}); ok {
			fmt.Printf("Goroutines: %v\n", runtime["goroutines"])
		}
		fmt.Printf("\nProfiles saved to: ./benchmark-profiles/\n")
		fmt.Printf("View pprof UI at: http://%s/debug/pprof/\n", *profileAddr)
	}
}