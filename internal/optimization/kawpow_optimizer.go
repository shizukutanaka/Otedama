package optimization

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// KawPowOptimizer optimizes KawPow mining for Ravencoin
type KawPowOptimizer struct {
	logger *zap.Logger
}

// NewKawPowOptimizer creates a new KawPow optimizer
func NewKawPowOptimizer(logger *zap.Logger) *KawPowOptimizer {
	return &KawPowOptimizer{
		logger: logger,
	}
}

// Name returns the optimizer name
func (o *KawPowOptimizer) Name() string {
	return "KawPow"
}

// Optimize performs optimization for KawPow mining
func (o *KawPowOptimizer) Optimize(ctx context.Context, hardware *HardwareProfile) (*OptimizationResult, error) {
	o.logger.Debug("Optimizing KawPow for hardware",
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
func (o *KawPowOptimizer) Benchmark(ctx context.Context, hardware *HardwareProfile, params OptimizationParams) (*BenchmarkResult, error) {
	switch hardware.Type {
	case "GPU":
		return o.benchmarkGPU(ctx, hardware, params)
	default:
		return nil, ErrHardwareNotSupported
	}
}

// GetDefaultParams returns default parameters for hardware
func (o *KawPowOptimizer) GetDefaultParams(hardware *HardwareProfile) OptimizationParams {
	params := OptimizationParams{
		CustomParams: make(map[string]interface{}),
	}
	
	// KawPow is GPU-only algorithm
	if hardware.Type == "GPU" {
		params.Threads = 1
		params.WorkSize = 256
		params.Intensity = 0 // Auto
		params.GridSize = hardware.ComputeUnits * 256
		params.BlockSize = 256
		
		// KawPow specific settings
		params.CustomParams["dag_build_mode"] = 0 // 0=parallel, 1=sequential
		params.CustomParams["keep_gpu_busy"] = true
		
		if hardware.Manufacturer == "NVIDIA" {
			params.CustomParams["cuda_streams"] = 2
		} else if hardware.Manufacturer == "AMD" {
			params.CustomParams["workgroup_size"] = 256
		}
	}
	
	return params
}

// benchmarkGPU simulates GPU KawPow benchmark
func (o *KawPowOptimizer) benchmarkGPU(ctx context.Context, hardware *HardwareProfile, params OptimizationParams) (*BenchmarkResult, error) {
	baseHashrate := 0.0
	basePower := 0.0
	
	// KawPow is similar to Ethash but with ProgPoW modifications
	switch hardware.Manufacturer {
	case "NVIDIA":
		switch hardware.Model {
		case "RTX 3090":
			baseHashrate = 58 * 1e6 // 58 MH/s
			basePower = 285
		case "RTX 3080":
			baseHashrate = 47 * 1e6 // 47 MH/s
			basePower = 220
		case "RTX 3070":
			baseHashrate = 30 * 1e6 // 30 MH/s
			basePower = 120
		case "RTX 3060 Ti":
			baseHashrate = 29 * 1e6 // 29 MH/s
			basePower = 120
		case "RTX 2080 Ti":
			baseHashrate = 40 * 1e6 // 40 MH/s
			basePower = 250
		case "GTX 1080 Ti":
			baseHashrate = 24 * 1e6 // 24 MH/s
			basePower = 200
		default:
			// Estimate based on compute units and memory
			baseHashrate = float64(hardware.ComputeUnits) * 10000 // 10 KH/s per CU
			basePower = 150
		}
		
		// Apply CUDA optimizations
		if streams, ok := params.CustomParams["cuda_streams"].(int); ok && streams > 1 {
			baseHashrate *= 1.05 // 5% boost with multiple streams
		}
		
	case "AMD":
		switch hardware.Model {
		case "RX 6900 XT":
			baseHashrate = 32 * 1e6 // 32 MH/s
			basePower = 180
		case "RX 6800 XT":
			baseHashrate = 31 * 1e6 // 31 MH/s
			basePower = 170
		case "RX 6800":
			baseHashrate = 30 * 1e6 // 30 MH/s
			basePower = 160
		case "RX 5700 XT":
			baseHashrate = 26 * 1e6 // 26 MH/s
			basePower = 140
		case "RX 5700":
			baseHashrate = 25 * 1e6 // 25 MH/s
			basePower = 130
		case "RX 580":
			baseHashrate = 13 * 1e6 // 13 MH/s
			basePower = 150
		default:
			baseHashrate = float64(hardware.ComputeUnits) * 8000
			basePower = 150
		}
		
		// AMD generally performs worse on KawPow vs NVIDIA
		baseHashrate *= 0.9
	}
	
	// DAG size check (similar to Ethash)
	dagSize := int64(3 * 1024 * 1024 * 1024) // ~3GB
	if hardware.MemorySize < dagSize {
		return nil, errors.New("insufficient GPU memory for KawPow DAG")
	}
	
	// Apply DAG build mode optimization
	if mode, ok := params.CustomParams["dag_build_mode"].(int); ok && mode == 0 {
		// Parallel DAG building is faster
		baseHashrate *= 1.02
	}
	
	// Simulate benchmark
	duration := 90 * time.Second
	shares := int(duration.Seconds() * baseHashrate / 2.5e9) // Network difficulty
	
	return &BenchmarkResult{
		Duration:      duration,
		Hashrate:      baseHashrate,
		SharesFound:   shares,
		InvalidShares: int(float64(shares) * 0.008), // 0.8% invalid
		PowerAverage:  basePower,
		TempAverage:   70.0,
		Stable:        true,
		Error:         nil,
	}, nil
}