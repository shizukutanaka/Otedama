package optimization

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// RandomXOptimizer optimizes RandomX mining for Monero
type RandomXOptimizer struct {
	logger *zap.Logger
}

// NewRandomXOptimizer creates a new RandomX optimizer
func NewRandomXOptimizer(logger *zap.Logger) *RandomXOptimizer {
	return &RandomXOptimizer{
		logger: logger,
	}
}

// Name returns the optimizer name
func (o *RandomXOptimizer) Name() string {
	return "RandomX"
}

// Optimize performs optimization for RandomX mining
func (o *RandomXOptimizer) Optimize(ctx context.Context, hardware *HardwareProfile) (*OptimizationResult, error) {
	o.logger.Debug("Optimizing RandomX for hardware",
		zap.String("hardware", hardware.Model),
		zap.String("type", hardware.Type),
	)
	
	params := o.GetDefaultParams(hardware)
	result, err := o.Benchmark(ctx, hardware, params)
	if err != nil {
		return nil, err
	}
	
	return &OptimizationResult{
		Algorithm:   o.Name(),
		Hardware:    hardware.Model,
		Params:      params,
		Hashrate:    result.Hashrate,
		PowerUsage:  result.PowerAverage,
		Efficiency:  result.Hashrate / result.PowerAverage,
		Temperature: result.TempAverage,
		Improvement: 0,
		Stable:      result.Stable,
		AppliedAt:   time.Now(),
	}, nil
}

// Benchmark runs a benchmark with given parameters
func (o *RandomXOptimizer) Benchmark(ctx context.Context, hardware *HardwareProfile, params OptimizationParams) (*BenchmarkResult, error) {
	switch hardware.Type {
	case "CPU":
		return o.benchmarkCPU(ctx, hardware, params)
	case "GPU":
		return o.benchmarkGPU(ctx, hardware, params)
	default:
		return nil, ErrHardwareNotSupported
	}
}

// GetDefaultParams returns default parameters for hardware
func (o *RandomXOptimizer) GetDefaultParams(hardware *HardwareProfile) OptimizationParams {
	params := OptimizationParams{
		CustomParams: make(map[string]interface{}),
	}
	
	switch hardware.Type {
	case "CPU":
		// RandomX is optimized for CPUs
		params.Threads = hardware.ComputeUnits
		params.WorkSize = 2 // MB per thread
		params.Intensity = 1
		params.CacheSize = 2048 // 2GB dataset
		
		// CPU specific optimizations
		params.CustomParams["huge_pages"] = true
		params.CustomParams["numa"] = true
		params.CustomParams["affinity"] = "auto"
		params.CustomParams["priority"] = 5
		
		// Algorithm modes
		params.CustomParams["mode"] = "fast" // fast mode with full memory
		params.CustomParams["jit"] = true    // JIT compilation
		params.CustomParams["secure_jit"] = false
		params.CustomParams["threads_mode"] = "auto" // auto, half, full
		
	case "GPU":
		// GPU mining RandomX is inefficient but possible
		params.Threads = hardware.ComputeUnits / 32 // Less threads for GPU
		params.WorkSize = 8
		params.Intensity = 512
		params.GridSize = hardware.ComputeUnits * 8
		params.BlockSize = 8
		params.CustomParams["mode"] = "light" // Light mode for GPU
	}
	
	return params
}

// benchmarkCPU simulates CPU RandomX benchmark
func (o *RandomXOptimizer) benchmarkCPU(ctx context.Context, hardware *HardwareProfile, params OptimizationParams) (*BenchmarkResult, error) {
	baseHashrate := 0.0
	basePower := 0.0
	
	// RandomX favors CPUs with large L3 cache
	// Estimate based on CPU model and cache size
	switch hardware.Manufacturer {
	case "AMD":
		if hardware.Model == "Ryzen 9 5950X" {
			baseHashrate = 16000 // 16 KH/s
			basePower = 140
		} else if hardware.Model == "Ryzen 9 3950X" {
			baseHashrate = 15000 // 15 KH/s
			basePower = 135
		} else if hardware.Model == "Ryzen 7 5800X" {
			baseHashrate = 9000 // 9 KH/s
			basePower = 95
		} else if hardware.Model == "EPYC 7742" {
			baseHashrate = 44000 // 44 KH/s
			basePower = 280
		} else {
			// Estimate based on cores and cache
			coresWithCache := float64(hardware.ComputeUnits)
			if hardware.MemorySize > 32*1024*1024 { // >32MB L3
				coresWithCache *= 1.5
			}
			baseHashrate = coresWithCache * 500 // 500 H/s per effective core
			basePower = float64(hardware.ComputeUnits) * 10
		}
		
	case "Intel":
		if hardware.Model == "Core i9-10900K" {
			baseHashrate = 7000 // 7 KH/s
			basePower = 125
		} else if hardware.Model == "Xeon Gold 6258R" {
			baseHashrate = 25000 // 25 KH/s
			basePower = 205
		} else {
			// Intel generally performs worse on RandomX
			baseHashrate = float64(hardware.ComputeUnits) * 300
			basePower = float64(hardware.ComputeUnits) * 12
		}
		
	default:
		baseHashrate = float64(hardware.ComputeUnits) * 400
		basePower = float64(hardware.ComputeUnits) * 10
	}
	
	// Apply optimizations
	if hugepages, ok := params.CustomParams["huge_pages"].(bool); ok && hugepages {
		baseHashrate *= 1.15 // 15% boost with huge pages
	}
	
	if jit, ok := params.CustomParams["jit"].(bool); ok && jit {
		baseHashrate *= 1.30 // 30% boost with JIT
		basePower *= 1.05    // Slight power increase
	}
	
	// Thread scaling
	threadScale := float64(params.Threads) / float64(hardware.ComputeUnits)
	if threadScale > 1.0 {
		threadScale = 1.0
	}
	baseHashrate *= threadScale
	basePower *= threadScale
	
	// Simulate benchmark
	duration := 120 * time.Second
	shares := int(duration.Seconds() * baseHashrate / 120000) // Pool difficulty
	
	return &BenchmarkResult{
		Duration:      duration,
		Hashrate:      baseHashrate,
		SharesFound:   shares,
		InvalidShares: 0,
		PowerAverage:  basePower,
		TempAverage:   65.0,
		Stable:        true,
		Error:         nil,
	}, nil
}

// benchmarkGPU simulates GPU RandomX benchmark (inefficient)
func (o *RandomXOptimizer) benchmarkGPU(ctx context.Context, hardware *HardwareProfile, params OptimizationParams) (*BenchmarkResult, error) {
	// GPUs are very inefficient for RandomX
	baseHashrate := 0.0
	basePower := 0.0
	
	switch hardware.Manufacturer {
	case "NVIDIA":
		// NVIDIA GPUs perform poorly on RandomX
		baseHashrate = float64(hardware.ComputeUnits) * 2 // 2 H/s per CU
		basePower = 200
		
	case "AMD":
		// AMD GPUs perform slightly better but still poor
		baseHashrate = float64(hardware.ComputeUnits) * 3 // 3 H/s per CU
		basePower = 180
	}
	
	// Light mode is faster but less secure
	if mode, ok := params.CustomParams["mode"].(string); ok && mode == "light" {
		baseHashrate *= 2.0 // Double hashrate in light mode
	}
	
	duration := 120 * time.Second
	shares := int(duration.Seconds() * baseHashrate / 120000)
	
	return &BenchmarkResult{
		Duration:      duration,
		Hashrate:      baseHashrate,
		SharesFound:   shares,
		InvalidShares: int(float64(shares) * 0.02), // 2% invalid on GPU
		PowerAverage:  basePower,
		TempAverage:   70.0,
		Stable:        false, // GPUs are not stable for RandomX
		Error:         nil,
	}, nil
}